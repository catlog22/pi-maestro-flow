import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Readable } from "node:stream";
import { acquirePrivateStateLock, type PrivateStateFs, type ProcessIdentity, type ProcessLiveness } from "./private-state-transaction.ts";
import {
  PI_CONFIG_CATEGORIES,
  PI_CONFIG_SYNC_MAX_CATEGORY_BYTES,
  PI_CONFIG_SYNC_MAX_TOTAL_BYTES,
  PiConfigTransactionError,
  type PiConfigCategory,
  type PiConfigCleanupState,
  type PiConfigSyncResult,
} from "../ssh-manager/pi-config-sync.ts";
import { validatePiConfigShape } from "../ssh-manager/pi-config-sync.ts";

const JOURNAL_NAME = ".pi-config-sync-journal.json";
const LOCK_NAME = ".pi-config-sync.lock";
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_STALE_MS = 10_000;
const DEFAULT_HEARTBEAT_MS = 1_000;

export interface WindowsAclRequest { readonly executable: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv; }
export type WindowsAclRunner = (request: WindowsAclRequest) => Promise<void>;
export interface WindowsDurabilityRequest { readonly executable: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv; }
export type WindowsDurabilityRunner = (request: WindowsDurabilityRequest) => Promise<void>;

export interface PiConfigApplyOptions {
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  enforcePrivate?: (path: string, kind: "directory" | "file") => Promise<void>;
  windowsAclRunner?: WindowsAclRunner;
  windowsDurabilityRunner?: WindowsDurabilityRunner;
  beforePublish?: (category: PiConfigCategory) => Promise<void>;
  fault?: (point: string, category?: PiConfigCategory) => Promise<void>;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  pid?: number;
  processIdentity?: ProcessIdentity;
  processLiveness?: ProcessLiveness;
  lockFs?: Partial<PrivateStateFs>;
  link?: typeof link;
  rename?: typeof rename;
  remove?: typeof rm;
}

interface JournalTarget {
  category: PiConfigCategory;
  target: string;
  next: string;
  before: string | null;
  beforeDigest: string | null;
  afterDigest: string;
  bytes: number;
  sourceDigest: string;
}
/** Version 2 is an immutable, metadata-only intent. Version 1 is accepted only for legacy recovery. */
interface Journal { version: 2; transactionId: string; targets: JournalTarget[]; }
interface LegacyJournal { version: 1; transactionId: string; phase: "preparing" | "applying" | "committed"; targets: JournalTarget[]; }
interface Prepared { journal: Journal; afterBytes: Map<PiConfigCategory, Buffer>; beforeBytes: Map<PiConfigCategory, Buffer>; }
interface LockHandle { assertOwned(): Promise<void>; release(): Promise<boolean>; }
interface Durability { syncFile(path: string): Promise<void>; syncDirectory(path: string): Promise<void>; }
type RecoveryDisposition = "rolled-back" | "committed" | "recovery-required";

export async function applyPiConfigStream(input: Readable, options: PiConfigApplyOptions = {}): Promise<PiConfigSyncResult> {
  const payload = await readBounded(input, PI_CONFIG_SYNC_MAX_TOTAL_BYTES + 16 * 1024);
  try { return await applyPiConfigPayload(payload, options); }
  finally { payload.fill(0); }
}

export async function applyPiConfigPayload(payload: Buffer, options: PiConfigApplyOptions = {}): Promise<PiConfigSyncResult> {
  const home = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  const enforce = options.enforcePrivate ?? ((path, kind) => enforcePrivate(path, kind, platform, options.windowsAclRunner));
  const directory = join(home, ".pi", "agent");
  const entries = decodePayload(payload);
  const durability = createDurability(platform, options.windowsDurabilityRunner);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await enforce(directory, "directory");
  const lock = await acquirePrivateStateLock({
    directory, name: LOCK_NAME, platform: process.platform, enforcePrivate: enforce, durability,
    timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    staleMs: options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS,
    heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    now: options.now, delay: options.delay, pid: options.pid,
    processIdentity: options.processIdentity, processLiveness: options.processLiveness,
    fs: options.lockFs, fault: options.fault ? (point) => options.fault!(point) : undefined,
  });
  let prepared: Prepared | undefined;
  let journalPublished = false;
  let lockReleased = false;
  const releaseLock = async (): Promise<boolean> => {
    if (lockReleased) return true;
    lockReleased = true;
    return lock.release();
  };
  try {
    await recoverExisting(directory, enforce, durability, lock, options);
    prepared = await prepare(entries, directory);
    // The metadata-only intent is immutable and durable before any secret artifact is created.
    await writeJournal(directory, prepared.journal, enforce, durability);
    journalPublished = true;
    await options.fault?.("journal:preparing");
    for (const target of prepared.journal.targets) {
      await writeArtifact(directory, target.next, prepared.afterBytes.get(target.category)!, enforce, durability);
      await options.fault?.("artifact:next", target.category);
    }
    await writePhaseMarker(directory, prepared.journal, "applying", enforce, durability);
    await options.fault?.("journal:applying");
    for (const target of prepared.journal.targets) {
      await options.beforePublish?.(target.category);
      await lock.assertOwned();
      await publishNoReplace(directory, target, durability, options);
    }
    await writePhaseMarker(directory, prepared.journal, "committed", enforce, durability);
    await options.fault?.("journal:committed");
    const receipts = prepared.journal.targets.map((target) => ({ category: target.category, bytes: target.bytes, digest: target.sourceDigest, backup: target.before !== null }));
    const cleanup = await cleanupTransaction(directory, prepared.journal, durability, lock, options.fault, options);
    const released = await releaseLock();
    return { ok: true, receipts, ...(cleanup === "pending" || !released ? { status: "committed-cleanup-pending" as const } : {}) };
  } catch (error) {
    if (!journalPublished || !prepared) {
      const released = await releaseLock();
      throw error instanceof PiConfigTransactionError && released ? error : new PiConfigTransactionError("rejected", released ? "complete" : "pending");
    }
    const outcome = await recoverJournal(directory, durability, lock, options.fault, options).catch(() => ({ disposition: "recovery-required" as const, cleanup: "pending" as const }));
    const released = await releaseLock();
    if (outcome.disposition === "committed") {
      const receipts = prepared.journal.targets.map((target) => ({ category: target.category, bytes: target.bytes, digest: target.sourceDigest, backup: target.before !== null }));
      return { ok: true, receipts, ...(outcome.cleanup === "pending" || !released ? { status: "committed-cleanup-pending" as const } : {}) };
    }
    throw new PiConfigTransactionError(released ? outcome.disposition : "recovery-required", released ? outcome.cleanup : "pending");
  } finally {
    if (prepared) {
      for (const bytes of prepared.afterBytes.values()) bytes.fill(0);
      for (const bytes of prepared.beforeBytes.values()) bytes.fill(0);
    }
    if (!lockReleased) await releaseLock();
  }
}

export function serializePiConfigApplyError(error: unknown): string {
  const transaction = error instanceof PiConfigTransactionError ? error : new PiConfigTransactionError("rejected");
  return JSON.stringify({ version: 1, ok: false, error: { code: "PI_CONFIG_APPLY_FAILED", disposition: transaction.disposition, cleanup: transaction.cleanup } });
}

async function prepare(entries: ReturnType<typeof decodePayload>, directory: string): Promise<Prepared> {
  const transactionId = randomUUID();
  const afterBytes = new Map<PiConfigCategory, Buffer>();
  const beforeBytes = new Map<PiConfigCategory, Buffer>();
  const targets: JournalTarget[] = [];
  try {
    for (const entry of entries) {
      const target = fileName(entry.category);
      const remote = await readExisting(join(directory, target), entry.category);
      try {
        const merged = mergeCategory(entry.category, entry.value, remote?.value);
        validatePiConfigShape(entry.category, merged);
        const bytes = Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, "utf8");
        if (bytes.length > PI_CONFIG_SYNC_MAX_CATEGORY_BYTES) { bytes.fill(0); throw new Error("merged configuration exceeds size limit"); }
        afterBytes.set(entry.category, bytes);
        if (remote) beforeBytes.set(entry.category, remote.bytes);
        const safeCategory = entry.category;
        targets.push({
          category: entry.category,
          target,
          next: `.pi-config-sync-${transactionId}-${safeCategory}.next`,
          before: remote ? `.pi-config-sync-${transactionId}-${safeCategory}.displaced` : null,
          beforeDigest: remote ? sha256(remote.bytes) : null,
          afterDigest: sha256(bytes),
          bytes: entry.bytes,
          sourceDigest: entry.digest,
        });
      } catch (error) {
        remote?.bytes.fill(0);
        throw error;
      }
    }
    return { journal: { version: 2, transactionId, targets }, afterBytes, beforeBytes };
  } catch (error) {
    for (const bytes of afterBytes.values()) bytes.fill(0);
    for (const bytes of beforeBytes.values()) bytes.fill(0);
    throw error;
  }
}

async function recoverExisting(directory: string, enforce: PiConfigApplyOptions["enforcePrivate"], durability: Durability, lock: LockHandle, options: PiConfigApplyOptions): Promise<void> {
  let raw: Buffer;
  try { raw = await readRegular(join(directory, JOURNAL_NAME), 64 * 1024); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { await cleanupOrphanMarkers(directory, durability, options); return; }
    throw new PiConfigTransactionError("recovery-required", "pending");
  }
  let journal: Journal | LegacyJournal;
  try { journal = validateJournal(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw))); }
  catch { throw new PiConfigTransactionError("recovery-required", "pending"); }
  finally { raw.fill(0); }
  await enforce?.(join(directory, JOURNAL_NAME), "file");
  await options.fault?.("recovery:start");
  const outcome = await recoverJournal(directory, durability, lock, options.fault, options);
  if (outcome.disposition === "recovery-required" || outcome.cleanup === "pending") throw new PiConfigTransactionError("recovery-required", "pending");
}

async function cleanupOrphanMarkers(directory: string, durability: Durability, options: PiConfigApplyOptions): Promise<void> {
  const candidates = (await readdir(directory)).filter((name) => /^\.pi-config-sync-[0-9a-f-]{36}\.(?:applying|committed)$/u.test(name));
  if (candidates.length > 32) throw new PiConfigTransactionError("recovery-required", "pending");
  for (const name of candidates) {
    const match = /^\.pi-config-sync-([0-9a-f-]{36})\.(applying|committed)$/u.exec(name);
    if (!match || match[2] !== "committed") throw new PiConfigTransactionError("recovery-required", "pending");
    const bytes = markerBytes(match[1]!, "committed");
    try { await captureDeleteExact(directory, name, sha256(bytes), durability, options.fault, options); }
    finally { bytes.fill(0); }
  }
}

async function recoverJournal(directory: string, durability: Durability, lock: LockHandle, fault?: PiConfigApplyOptions["fault"], options: PiConfigApplyOptions = {}): Promise<{ disposition: RecoveryDisposition; cleanup: PiConfigCleanupState }> {
  let journal: Journal | LegacyJournal;
  try {
    const raw = await readRegular(join(directory, JOURNAL_NAME), 64 * 1024);
    try { journal = validateJournal(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw))); }
    finally { raw.fill(0); }
  } catch { return { disposition: "recovery-required", cleanup: "pending" }; }
  try {
    await lock.assertOwned();
    const committed = journal.version === 1 ? journal.phase === "committed" : await hasPhaseMarker(directory, journal, "committed");
    if (committed) {
      for (const target of journal.targets) {
        if (await classifyTarget(directory, target) !== "after") return { disposition: "recovery-required", cleanup: "pending" };
        await durability.syncFile(join(directory, target.target));
      }
      await durability.syncDirectory(directory);
      const cleanup = await cleanupTransaction(directory, journal, durability, lock, fault, options);
      return { disposition: "committed", cleanup };
    }
    for (let index = journal.targets.length - 1; index >= 0; index--) {
      const target = journal.targets[index]!;
      const state = await classifyTarget(directory, target);
      if (state === "foreign") return { disposition: "recovery-required", cleanup: "pending" };
      if (target.beforeDigest === null) {
        if (state === "after") await captureDeleteExact(directory, target.target, target.afterDigest, durability, fault, options, target.category);
        else if (state !== "before") return { disposition: "recovery-required", cleanup: "pending" };
        continue;
      }
      if (state === "after") await captureDeleteExact(directory, target.target, target.afterDigest, durability, fault, options, target.category);
      else if (state !== "absent" && state !== "before") return { disposition: "recovery-required", cleanup: "pending" };
      if (state !== "before") {
        if (!target.before || await artifactDigest(directory, target.before) !== target.beforeDigest) return { disposition: "recovery-required", cleanup: "pending" };
        await restoreNoReplace(directory, target, durability, options);
      }
    }
    const cleanup = await cleanupTransaction(directory, journal, durability, lock, fault, options);
    return { disposition: "rolled-back", cleanup };
  } catch { return { disposition: "recovery-required", cleanup: "pending" }; }
}

async function publishNoReplace(directory: string, target: JournalTarget, durability: Durability, options: PiConfigApplyOptions): Promise<void> {
  const renameOp = options.rename ?? rename;
  const linkOp = options.link ?? link;
  if (target.beforeDigest !== null) {
    if (!target.before) throw new Error("invalid displacement");
    await renameOp(join(directory, target.target), join(directory, target.before));
    await durability.syncDirectory(directory);
    await options.fault?.("publish:displaced", target.category);
    if (await artifactDigest(directory, target.before) !== target.beforeDigest) {
      await restoreNoReplace(directory, target, durability, options);
      throw new Error("target changed");
    }
  }
  await options.fault?.("publish:before-link", target.category);
  // Hard-link creation is the publication point: it never replaces an existing name.
  await linkOp(join(directory, target.next), join(directory, target.target));
  await durability.syncFile(join(directory, target.target));
  await durability.syncDirectory(directory);
  await options.fault?.("publish:durable", target.category);
}

async function restoreNoReplace(directory: string, target: JournalTarget, durability: Durability, options: PiConfigApplyOptions): Promise<void> {
  if (!target.before || !target.beforeDigest || await artifactDigest(directory, target.before) !== target.beforeDigest) throw new Error("invalid displaced target");
  try { await (options.link ?? link)(join(directory, target.before), join(directory, target.target)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await classifyTarget(directory, target) !== "before") throw error;
  }
  await durability.syncFile(join(directory, target.target));
  await durability.syncDirectory(directory);
}

async function cleanupTransaction(directory: string, journal: Journal | LegacyJournal, durability: Durability, lock: LockHandle, fault?: PiConfigApplyOptions["fault"], options: PiConfigApplyOptions = {}): Promise<PiConfigCleanupState> {
  try {
    await lock.assertOwned();
    await fault?.("cleanup:artifacts");
    for (const target of journal.targets) {
      await captureDeleteExact(directory, target.next, target.afterDigest, durability, fault, options, target.category, true);
      if (target.before) await captureDeleteExact(directory, target.before, target.beforeDigest!, durability, fault, options, target.category, true);
    }
    if (journal.version === 2) await removePhaseMarker(directory, journal, "applying", durability, fault, options, true);
    await fault?.("cleanup:journal");
    await captureDeleteExact(directory, JOURNAL_NAME, sha256(journalBytes(journal)), durability, fault, options);
    // A visible committed marker is always removed last.
    if (journal.version === 2) await removePhaseMarker(directory, journal, "committed", durability, fault, options, true);
    return "complete";
  } catch { return "pending"; }
}

async function captureDeleteExact(directory: string, name: string, digest: string, durability: Durability, fault?: PiConfigApplyOptions["fault"], options: PiConfigApplyOptions = {}, category?: PiConfigCategory, allowAbsent = false): Promise<void> {
  if (basename(name) !== name || !isSafeTransactionName(name)) throw new Error("unsafe transaction metadata");
  const quarantine = `.pi-config-sync-capture-${randomUUID()}`;
  const renameOp = options.rename ?? rename;
  const removeOp = options.remove ?? rm;
  try { await renameOp(join(directory, name), join(directory, quarantine)); }
  catch (error) { if (allowAbsent && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  await durability.syncDirectory(directory);
  await fault?.("capture:renamed", category);
  if (await artifactDigest(directory, quarantine) !== digest) {
    try { await (options.link ?? link)(join(directory, quarantine), join(directory, name)); await durability.syncDirectory(directory); }
    catch { /* Exact capture remains quarantined for manual recovery. */ }
    throw new Error("captured object changed");
  }
  await removeOp(join(directory, quarantine), { force: false });
  await durability.syncDirectory(directory);
}

async function hasPhaseMarker(directory: string, journal: Journal, phase: "applying" | "committed"): Promise<boolean> {
  try {
    const raw = await readRegular(join(directory, phaseName(journal.transactionId, phase)), 1024);
    try { return raw.equals(markerBytes(journal.transactionId, phase)); } finally { raw.fill(0); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function removePhaseMarker(directory: string, journal: Journal, phase: "applying" | "committed", durability: Durability, fault: PiConfigApplyOptions["fault"] | undefined, options: PiConfigApplyOptions, allowAbsent: boolean): Promise<void> {
  const bytes = markerBytes(journal.transactionId, phase);
  try { await captureDeleteExact(directory, phaseName(journal.transactionId, phase), sha256(bytes), durability, fault, options, undefined, allowAbsent); }
  finally { bytes.fill(0); }
}

async function classifyTarget(directory: string, target: JournalTarget): Promise<"before" | "after" | "absent" | "foreign"> {
  let digest: string;
  try { digest = await artifactDigest(directory, target.target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return target.beforeDigest === null ? "before" : "absent";
    return "foreign";
  }
  if (digest === target.afterDigest) return "after";
  if (target.beforeDigest !== null && digest === target.beforeDigest) return "before";
  return "foreign";
}

async function artifactDigest(directory: string, name: string): Promise<string> {
  if (basename(name) !== name || !isSafeTransactionName(name)) throw new Error("unsafe transaction metadata");
  const bytes = await readRegular(join(directory, name), PI_CONFIG_SYNC_MAX_CATEGORY_BYTES + 16 * 1024);
  try { return sha256(bytes); } finally { bytes.fill(0); }
}

async function writeArtifact(directory: string, name: string, bytes: Buffer, enforce: NonNullable<PiConfigApplyOptions["enforcePrivate"]>, durability: Durability): Promise<void> {
  if (!isSafeTransactionName(name)) throw new Error("unsafe transaction metadata");
  const path = join(directory, name);
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await enforce(path, "file"); await handle.sync(); }
  finally { await handle.close(); }
  await durability.syncDirectory(directory);
}

async function writeJournal(directory: string, journal: Journal, enforce: NonNullable<PiConfigApplyOptions["enforcePrivate"]>, durability: Durability): Promise<void> {
  const bytes = journalBytes(journal);
  try {
    const path = join(directory, JOURNAL_NAME);
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(bytes); await enforce(path, "file"); await handle.sync(); }
    finally { await handle.close(); }
    await durability.syncDirectory(directory);
  } finally { bytes.fill(0); }
}

async function writePhaseMarker(directory: string, journal: Journal, phase: "applying" | "committed", enforce: NonNullable<PiConfigApplyOptions["enforcePrivate"]>, durability: Durability): Promise<void> {
  const bytes = markerBytes(journal.transactionId, phase);
  try {
    const path = join(directory, phaseName(journal.transactionId, phase));
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(bytes); await enforce(path, "file"); await handle.sync(); }
    finally { await handle.close(); }
    await durability.syncDirectory(directory);
  } finally { bytes.fill(0); }
}

function journalBytes(journal: Journal | LegacyJournal): Buffer { return Buffer.from(`${JSON.stringify(journal)}\n`, "utf8"); }
function phaseName(id: string, phase: "applying" | "committed"): string { return `.pi-config-sync-${id}.${phase}`; }
function markerBytes(id: string, phase: "applying" | "committed"): Buffer { return Buffer.from(`${JSON.stringify({ version: 2, transactionId: id, phase })}\n`, "utf8"); }

function validateJournal(value: unknown): Journal | LegacyJournal {
  if (!isRecord(value) || value.version !== 1 && value.version !== 2 || typeof value.transactionId !== "string" || !/^[0-9a-f-]{36}$/u.test(value.transactionId)
    || value.version === 1 && !["preparing", "applying", "committed"].includes(value.phase as string)
    || value.version === 2 && Object.prototype.hasOwnProperty.call(value, "phase")
    || !Array.isArray(value.targets) || value.targets.length < 1 || value.targets.length > 3) throw new Error("invalid journal");
  const seen = new Set<string>();
  const targets = value.targets.map((raw): JournalTarget => {
    const expectedBefore = value.version === 1 ? `.pi-config-sync-${value.transactionId}-${isRecord(raw) ? raw.category : ""}.before` : `.pi-config-sync-${value.transactionId}-${isRecord(raw) ? raw.category : ""}.displaced`;
    if (!isRecord(raw) || !PI_CONFIG_CATEGORIES.includes(raw.category as PiConfigCategory) || typeof raw.target !== "string" || raw.target !== fileName(raw.category as PiConfigCategory)
      || typeof raw.next !== "string" || raw.next !== `.pi-config-sync-${value.transactionId}-${raw.category}.next`
      || raw.before !== null && (typeof raw.before !== "string" || raw.before !== expectedBefore)
      || raw.beforeDigest !== null && (typeof raw.beforeDigest !== "string" || !isDigest(raw.beforeDigest))
      || (raw.before === null) !== (raw.beforeDigest === null) || typeof raw.afterDigest !== "string" || !isDigest(raw.afterDigest)
      || !Number.isSafeInteger(raw.bytes) || (raw.bytes as number) < 1 || (raw.bytes as number) > PI_CONFIG_SYNC_MAX_CATEGORY_BYTES
      || typeof raw.sourceDigest !== "string" || !isDigest(raw.sourceDigest) || seen.has(raw.category as string)) throw new Error("invalid journal");
    seen.add(raw.category as string);
    return raw as unknown as JournalTarget;
  });
  return value.version === 1
    ? { version: 1, transactionId: value.transactionId, phase: value.phase as LegacyJournal["phase"], targets }
    : { version: 2, transactionId: value.transactionId, targets };
}

function decodePayload(payload: Buffer): Array<{ category: PiConfigCategory; bytes: number; digest: string; value: Record<string, unknown> }> {
  const newline = payload.indexOf(0x0a);
  if (newline <= 0 || newline > 16 * 1024) throw new Error("Invalid Pi configuration transfer header");
  let header: unknown;
  try { header = JSON.parse(payload.subarray(0, newline).toString("utf8")); } catch { throw new Error("Invalid Pi configuration transfer header"); }
  if (!isRecord(header) || header.version !== 1 || !Array.isArray(header.entries) || header.entries.length < 1 || header.entries.length > 3) throw new Error("Invalid Pi configuration transfer header");
  const seen = new Set<PiConfigCategory>();
  let offset = newline + 1;
  return header.entries.map((raw) => {
    if (!isRecord(raw) || !PI_CONFIG_CATEGORIES.includes(raw.category as PiConfigCategory) || !Number.isSafeInteger(raw.bytes) || (raw.bytes as number) < 1 || (raw.bytes as number) > PI_CONFIG_SYNC_MAX_CATEGORY_BYTES || typeof raw.digest !== "string" || !isDigest(raw.digest)) throw new Error("Invalid Pi configuration transfer header");
    const category = raw.category as PiConfigCategory;
    if (seen.has(category)) throw new Error("Duplicate Pi configuration category");
    seen.add(category);
    const size = raw.bytes as number;
    const bytes = payload.subarray(offset, offset + size);
    offset += size;
    if (bytes.length !== size || sha256(bytes) !== raw.digest) throw new Error("Pi configuration transfer integrity check failed");
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error(`${category} configuration is invalid`); }
    validatePiConfigShape(category, value);
    return { category, bytes: size, digest: raw.digest as string, value };
  }).map((entry, index, all) => { if (index === all.length - 1 && offset !== payload.length) throw new Error("Pi configuration transfer contains trailing data"); return entry; });
}

function mergeCategory(category: PiConfigCategory, local: Record<string, unknown>, remote?: Record<string, unknown>): Record<string, unknown> {
  if (!remote) return local;
  validatePiConfigShape(category, remote);
  if (category === "models") return { ...remote, ...local, providers: { ...(remote.providers as Record<string, unknown>), ...(local.providers as Record<string, unknown>) } };
  if (category === "auth") return { ...remote, ...local };
  return { ...remote, ...local, profiles: { ...(remote.profiles as Record<string, unknown>), ...(local.profiles as Record<string, unknown>) } };
}

async function readExisting(path: string, category: PiConfigCategory): Promise<{ bytes: Buffer; value: Record<string, unknown> } | undefined> {
  let bytes: Buffer;
  try { bytes = await readRegular(path, PI_CONFIG_SYNC_MAX_CATEGORY_BYTES); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    validatePiConfigShape(category, value);
    return { bytes, value };
  } catch { bytes.fill(0); throw new Error("Existing Pi configuration is invalid"); }
}

async function readRegular(path: string, limit: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error("unsafe file");
  const handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.size !== info.size) throw new Error("changed file");
    const bytes = Buffer.alloc(Number(after.size));
    let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (bytesRead === 0) { bytes.fill(0); throw new Error("changed file"); } offset += bytesRead; }
    return bytes;
  } finally { await handle.close(); }
}

function createDurability(platform: NodeJS.Platform, windowsRunner: WindowsDurabilityRunner = runWindowsDurability): Durability {
  if (platform === "win32") return {
    syncFile: (path) => windowsRunner(windowsDurabilityRequest(path, "file")),
    syncDirectory: (path) => windowsRunner(windowsDurabilityRequest(path, "directory")),
  };
  const syncFile = async (path: string): Promise<void> => { const handle = await open(path, constants.O_RDWR); try { await handle.sync(); } finally { await handle.close(); } };
  const syncDirectory = async (path: string): Promise<void> => {
    if (process.platform === "win32") return;
    const handle = await open(path, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); }
  };
  return { syncFile, syncDirectory };
}

const WINDOWS_DURABILITY_SCRIPT = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\nusing System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles; public static class PiSync { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern SafeFileHandle CreateFile(string n,uint a,uint s,IntPtr x,uint c,uint f,IntPtr t); [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FlushFileBuffers(SafeFileHandle h); }\n'@\n$p=$env:PI_MAESTRO_SYNC_PATH; $k=$env:PI_MAESTRO_SYNC_KIND; if([string]::IsNullOrWhiteSpace($p)){throw 'invalid'}; $flags=if($k -eq 'directory'){0x02000000}else{0}; $h=[PiSync]::CreateFile($p,0x40000000,7,[IntPtr]::Zero,3,$flags,[IntPtr]::Zero); if($h.IsInvalid){throw 'open'}; try { if(-not [PiSync]::FlushFileBuffers($h)){throw 'flush'} } finally {$h.Dispose()}`;
const WINDOWS_DURABILITY_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(WINDOWS_DURABILITY_SCRIPT, "utf16le").toString("base64")] as const;
function windowsDurabilityRequest(path: string, kind: "file" | "directory"): WindowsDurabilityRequest { return { executable: "powershell.exe", args: WINDOWS_DURABILITY_ARGS, env: { ...process.env, PI_MAESTRO_SYNC_PATH: path, PI_MAESTRO_SYNC_KIND: kind } }; }
async function runWindowsDurability(request: WindowsDurabilityRequest): Promise<void> { await runBoundedPowerShell(request.executable, request.args, request.env, "Pi configuration durability synchronization failed"); }

const WINDOWS_PRIVATE_ACL_SCRIPT = `$ErrorActionPreference='Stop'\n$path=$env:PI_MAESTRO_ACL_PATH; $kind=$env:PI_MAESTRO_ACL_KIND; if([string]::IsNullOrWhiteSpace($path)){throw 'invalid'}\n$item=Get-Item -LiteralPath $path -Force; if(($kind -eq 'directory') -ne [bool]$item.PSIsContainer){throw 'kind'}\n$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=if($kind -eq 'directory'){New-Object System.Security.AccessControl.DirectorySecurity}else{New-Object System.Security.AccessControl.FileSecurity}; $acl.SetAccessRuleProtection($true,$false); $inheritance=if($kind -eq 'directory'){[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit}else{[System.Security.AccessControl.InheritanceFlags]::None}; $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow); $acl.SetOwner($sid); $acl.SetAccessRule($rule); if($kind -eq 'directory'){[System.IO.Directory]::SetAccessControl($path,$acl)}else{[System.IO.File]::SetAccessControl($path,$acl)}`;
const WINDOWS_PRIVATE_ACL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(WINDOWS_PRIVATE_ACL_SCRIPT, "utf16le").toString("base64")] as const;
async function enforcePrivate(path: string, kind: "directory" | "file", platform: NodeJS.Platform, runner: WindowsAclRunner = runWindowsAcl): Promise<void> {
  if (platform === "win32") { await runner({ executable: "powershell.exe", args: WINDOWS_PRIVATE_ACL_ARGS, env: { ...process.env, PI_MAESTRO_ACL_PATH: path, PI_MAESTRO_ACL_KIND: kind } }); return; }
  await chmod(path, kind === "directory" ? 0o700 : 0o600);
  const info = await lstat(path);
  if (info.isSymbolicLink() || (info.mode & 0o777) !== (kind === "directory" ? 0o700 : 0o600)) throw new Error("Private Pi configuration permissions could not be verified");
}
async function runWindowsAcl(request: WindowsAclRequest): Promise<void> { await runBoundedPowerShell(request.executable, request.args, request.env, "Private Pi configuration permissions could not be verified"); }
async function runBoundedPowerShell(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, message: string): Promise<void> {
  await new Promise<void>((resolve, reject) => execFile(executable, [...args], { env, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 }, (error) => error ? reject(new Error(message)) : resolve()));
}

async function readBounded(input: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array); size += bytes.length;
    if (size > limit) { bytes.fill(0); for (const item of chunks) item.fill(0); throw new Error("Pi configuration transfer exceeds size limit"); }
    chunks.push(bytes);
  }
  const result = Buffer.concat(chunks); for (const chunk of chunks) chunk.fill(0); return result;
}
function isSafeTransactionName(name: string): boolean { return basename(name) === name && (name === JOURNAL_NAME || /^(?:models|auth|teammate-models)\.json$/u.test(name) || /^\.pi-config-sync-[0-9a-f-]{36}-(?:models|auth|teammate)\.(?:next|before|displaced)$/u.test(name) || /^\.pi-config-sync-[0-9a-f-]{36}\.(?:applying|committed)$/u.test(name) || /^\.pi-config-sync-capture-[0-9a-f-]{36}$/u.test(name)); }
function isDigest(value: string): boolean { return /^[a-f0-9]{64}$/u.test(value); }
function fileName(category: PiConfigCategory): string { return category === "models" ? "models.json" : category === "auth" ? "auth.json" : "teammate-models.json"; }
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
