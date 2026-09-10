/** Explicit, offline-only migration from the former ~/.mcpx Gateway root. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { GATEWAY_CONFIG_VERSION, GATEWAY_DURABLE_RECORD_VERSION, GATEWAY_HARD_LIMITS } from "./contracts.ts";
import { normalizeGatewayConfig, type GatewayConfig, type GatewayWorkspaceConfig } from "./config.ts";
import {
  GATEWAY_LEGACY_MIGRATION_VERSION,
  GatewayLegacyMigrationError,
  type GatewayLegacyArtifactReport,
  type GatewayLegacyMigrationReport,
  type GatewayLegacyMigrationStatus,
} from "./migration-contracts.ts";
import { acquirePrivateStateLock, defaultProcessLiveness, type PrivateStateDurability, type ProcessIdentity, type ProcessLiveness } from "./private-state-transaction.ts";
import { enforceGatewayResidentPrivatePath, gatewayResidentDurability, GatewayResidentService } from "./resident-service.ts";
import { gatewayNativeRoot, workspaceIdForPath } from "./state-paths.ts";

const LEGACY_DIRECTORY = ".mcpx";
const LEGACY_STATE = join("gateway", "v1");
const LOCK_NAME = ".legacy-migration.lock";
const TRANSACTION_NAME = ".legacy-migration-transaction.json";
const RECEIPT_NAME = "legacy-migration.json";
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_TASK_FILES = 1024;
const MAX_TASK_BYTES = 16 * 1024 * 1024;
const TARGETS = new Map([
  ["config", "config.yaml"],
  ["workspaces", join("v1", "workspaces.json")],
  ["pairings", join("v1", "pairings.json")],
  ["tasks-snapshot", join("v1", "legacy-tasks-snapshot.json")],
] as const);

type ArtifactKind = "config" | "workspaces" | "pairings" | "tasks-snapshot";
interface CapturedSource { logical: string; path: string; digest: string; maximumBytes: number; }
interface PreparedArtifact { kind: ArtifactKind; targetRelative: string; bytes: Buffer; digest: string; records?: number; sourceDigest?: string; disposition: "migrate" | "snapshot-only"; }
interface PreparedPlan { sourceDigest: string; artifacts: PreparedArtifact[]; report: GatewayLegacyArtifactReport[]; sources: CapturedSource[]; capturedAt: number; }
interface TransactionArtifact { kind: ArtifactKind; target: string; staging: string; digest: string; bytes: number; records?: number; sourceDigest?: string; disposition: "migrate" | "snapshot-only"; }
interface TransactionMarker { version: 1; transactionId: string; sourceDigest: string; capturedAt: number; artifacts: TransactionArtifact[]; report: GatewayLegacyArtifactReport[]; }

export interface GatewayLegacyMigrationOptions {
  homeDirectory?: string;
  legacyRoot?: string;
  nativeRoot?: string;
  now?: () => number;
  processLiveness?: ProcessLiveness;
  processIdentity?: ProcessIdentity;
  enforcePrivate?: (path: string, kind: "directory" | "file") => Promise<void>;
  durability?: PrivateStateDurability;
  residentProbe?: (manifestPath: string, ownerPath: string) => Promise<void>;
  fault?: (point: string) => Promise<void>;
}

export async function migrateLegacyGateway(mode: "dry-run" | "apply", options: GatewayLegacyMigrationOptions = {}): Promise<GatewayLegacyMigrationReport> {
  const home = options.homeDirectory ?? homedir();
  const legacyRoot = resolve(options.legacyRoot ?? join(home, LEGACY_DIRECTORY));
  const nativeRoot = resolve(options.nativeRoot ?? gatewayNativeRoot(home));
  if (legacyRoot === nativeRoot || isWithin(legacyRoot, nativeRoot) || isWithin(nativeRoot, legacyRoot)) {
    throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_UNSAFE_SOURCE", "Legacy and native Gateway roots must be disjoint");
  }
  const capturedAt = options.now?.() ?? Date.now();
  const context = { legacyRoot, nativeRoot, capturedAt, liveness: options.processLiveness ?? defaultProcessLiveness, residentProbe: options.residentProbe };
  if (mode === "dry-run") {
    const plan = await preparePlan(context);
    try { return reportFor(plan, "dry-run", "ready"); }
    finally { disposePlan(plan); }
  }

  const enforce = options.enforcePrivate ?? enforceGatewayResidentPrivatePath;
  const durability = options.durability ?? gatewayResidentDurability();
  await ensurePrivateDirectory(nativeRoot, enforce);
  const lock = await acquirePrivateStateLock({ directory: nativeRoot, name: LOCK_NAME, enforcePrivate: enforce, durability, processIdentity: options.processIdentity, processLiveness: options.processLiveness });
  try {
    const recovered = await readTransaction(nativeRoot);
    if (recovered) return await recoverTransaction(recovered, context, enforce, durability, lock, options);

    const plan = await preparePlan(context);
    try {
      const prior = await readReceipt(nativeRoot);
      if (prior) {
        if (prior.sourceDigest !== plan.sourceDigest) throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_COLLISION", "Native migration receipt belongs to different legacy source content");
        return reportFor(plan, "apply", "already-applied", "unchanged");
      }
      await assertTargetsAbsent(nativeRoot, plan.artifacts);
      const marker = await stagePlan(nativeRoot, plan, enforce, durability);
      await options.fault?.("after-marker");
      const confirmed = await preparePlan(context);
      try {
        if (confirmed.sourceDigest !== plan.sourceDigest) throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_SOURCE_DRIFT", "Legacy Gateway source changed after staging");
      } finally { disposePlan(confirmed); }
      await options.fault?.("before-publish");
      await publishTransaction(nativeRoot, marker, enforce, durability, lock, options);
      return reportFor(plan, "apply", "applied", "published");
    } finally { disposePlan(plan); }
  } finally {
    if (!(await lock.release())) throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_RECOVERY_REQUIRED", "Legacy migration lock release could not be verified");
  }
}

function reportFor(plan: PreparedPlan, mode: "dry-run" | "apply", status: GatewayLegacyMigrationStatus, published?: "published" | "unchanged"): GatewayLegacyMigrationReport {
  return {
    version: GATEWAY_LEGACY_MIGRATION_VERSION,
    mode,
    status,
    sourceDigest: plan.sourceDigest,
    artifacts: plan.report.map((entry) => entry.disposition === "migrate" || entry.disposition === "snapshot-only"
      ? { ...entry, ...(published ? { disposition: published } : {}) }
      : { ...entry }),
    warnings: ["Legacy files were not modified or deleted.", "Legacy owner, PID, resident-service ownership, and tunnel authority were not imported."],
  };
}

async function preparePlan(context: { legacyRoot: string; nativeRoot: string; capturedAt: number; liveness: ProcessLiveness; residentProbe?: GatewayLegacyMigrationOptions["residentProbe"] }): Promise<PreparedPlan> {
  await assertRootSafeIfPresent(context.legacyRoot);
  await assertOffline(context);
  const artifacts: PreparedArtifact[] = [];
  const report: GatewayLegacyArtifactReport[] = [];
  const sources: CapturedSource[] = [];

  try {
  const config = await captureOptional(context.legacyRoot, "config.yaml", MAX_CONFIG_BYTES, sources);
  let permanentFromConfig: GatewayWorkspaceConfig[] = [];
  if (config) {
    try {
      const transformed = transformConfig(config.bytes);
      permanentFromConfig = transformed.config.workspaces.filter((entry) => entry.mode === "permanent");
      artifacts.push(artifact("config", Buffer.from(stringifyYaml(transformed.config, { lineWidth: 0 }), "utf8"), config.digest, undefined, "migrate"));
      report.push(reportEntry(artifacts.at(-1)!));
    } finally { config.bytes.fill(0); }
  } else report.push({ kind: "config", disposition: "not-present" });

  const workspaceSource = await captureOptional(context.legacyRoot, join(LEGACY_STATE, "workspaces.json"), MAX_STATE_BYTES, sources);
  if (workspaceSource || permanentFromConfig.length > 0) {
    try {
      const workspaces = transformWorkspaces(workspaceSource?.bytes, permanentFromConfig, context.capturedAt);
      const bytes = jsonBytes({ version: GATEWAY_DURABLE_RECORD_VERSION, workspaces });
      artifacts.push(artifact("workspaces", bytes, workspaceSource?.digest, workspaces.length, "migrate"));
      report.push(reportEntry(artifacts.at(-1)!));
    } finally { workspaceSource?.bytes.fill(0); }
  } else report.push({ kind: "workspaces", disposition: "not-present" });

  const pairingSource = await captureOptional(context.legacyRoot, join(LEGACY_STATE, "pairings.json"), MAX_STATE_BYTES, sources);
  if (pairingSource) {
    try {
      const pairings = transformPairings(pairingSource.bytes);
      artifacts.push(artifact("pairings", jsonBytes({ version: GATEWAY_DURABLE_RECORD_VERSION, pairings }), pairingSource.digest, pairings.length, "migrate"));
      report.push(reportEntry(artifacts.at(-1)!));
    } finally { pairingSource.bytes.fill(0); }
  } else report.push({ kind: "pairings", disposition: "not-present" });

  const taskSnapshot = await snapshotTasks(context.legacyRoot, sources, context.capturedAt);
  if (taskSnapshot) {
    artifacts.push(artifact("tasks-snapshot", jsonBytes(taskSnapshot.value), taskSnapshot.sourceDigest, taskSnapshot.records, "snapshot-only"));
    report.push(reportEntry(artifacts.at(-1)!));
  } else report.push({ kind: "tasks-snapshot", disposition: "not-present" });

  report.push({ kind: "owner", disposition: "excluded", reason: "live ownership is never migrated" });
  report.push({ kind: "resident-service", disposition: "excluded", reason: "installation ownership is never migrated" });
  report.push({ kind: "tunnel", disposition: "excluded", reason: "tunnel authority is never migrated" });
  const sourceDigest = aggregateDigest(sources.map((source) => [source.logical, source.digest]));
  return { sourceDigest, artifacts, report, sources, capturedAt: context.capturedAt };
  } catch (error) {
    for (const artifact of artifacts) artifact.bytes.fill(0);
    throw error;
  }
}

function transformConfig(bytes: Buffer): { config: GatewayConfig } {
  let value: unknown;
  try { value = parseYaml(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_UNSAFE_SOURCE", "Legacy Gateway config is invalid YAML or UTF-8"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_UNSAFE_SOURCE", "Legacy Gateway config must be a mapping");
  const raw = structuredClone(value) as Record<string, unknown>;
  if (raw.version !== undefined && raw.version !== 1) throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_UNKNOWN_VERSION", "Legacy Gateway config version is not supported");
  raw.version = GATEWAY_CONFIG_VERSION;
  raw.state = {};
  const auth = raw.auth;
  if (auth && typeof auth === "object" && !Array.isArray(auth)) {
    const next = auth as Record<string, unknown>;
    delete next.oauth_server_url;
    if (next.oauth && typeof next.oauth === "object" && !Array.isArray(next.oauth)) {
      delete (next.oauth as Record<string, unknown>).server_url;
      delete (next.oauth as Record<string, unknown>).serverUrl;
    }
  }
  let config: GatewayConfig;
  try { config = normalizeGatewayConfig(raw); }
  catch (error) { throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_UNSAFE_SOURCE", error instanceof Error ? error.message : "Legacy Gateway config is invalid"); }
  config.state = {};
  config.workspaces = config.workspaces.filter((entry) => entry.mode === "permanent").map((entry) => ({ path: entry.path, ...(entry.id ? { id: entry.id } : {}), mode: "permanent" as const, ...(entry.generation ? { generation: entry.generation } : {}) }));
  if (config.auth.oauth) delete config.auth.oauth.serverUrl;
  return { config };
}

function transformPairings(bytes: Buffer): Array<Record<string, unknown>> {
  const value = parseJson(bytes, "pairing store") as { version?: unknown; pairings?: unknown };
  if (value.version !== 1) throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_UNKNOWN_VERSION", "Legacy pairing store version is not supported");
  if (!Array.isArray(value.pairings) || value.pairings.length > 256) throw unsafe("Legacy pairing store is invalid");
  return value.pairings.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw unsafe("Legacy pairing record is invalid");
    const entry = item as Record<string, unknown>;
    if (entry.version !== 1 || typeof entry.id !== "string" || entry.id.length > 128 || typeof entry.tokenHash !== "string" || !/^[a-f0-9]{64}$/u.test(entry.tokenHash)
      || !nonNegativeInteger(entry.createdAt) || !nonNegativeInteger(entry.expiresAt) || entry.expiresAt < entry.createdAt
      || (entry.label !== undefined && (typeof entry.label !== "string" || Buffer.byteLength(entry.label, "utf8") > 256))) throw unsafe("Legacy pairing record is invalid");
    return { version: 1, id: entry.id, tokenHash: entry.tokenHash, createdAt: entry.createdAt, expiresAt: entry.expiresAt, ...(entry.label === undefined ? {} : { label: entry.label }) };
  });
}

function transformWorkspaces(bytes: Buffer | undefined, configEntries: GatewayWorkspaceConfig[], now: number): Array<Record<string, unknown>> {
  const rawEntries: unknown[] = configEntries.map((entry) => ({ path: entry.path, id: entry.id, generation: entry.generation, mode: "permanent" }));
  if (bytes) {
    const value = parseJson(bytes, "workspace registry") as { version?: unknown; workspaces?: unknown };
    if (value.version !== 1) throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_UNKNOWN_VERSION", "Legacy workspace registry version is not supported");
    if (!Array.isArray(value.workspaces) || value.workspaces.length > GATEWAY_HARD_LIMITS.maxWorkspaceCount) throw unsafe("Legacy workspace registry is invalid");
    // The durable registry has stronger timestamps/generation evidence than config.
    rawEntries.push(...value.workspaces);
  }
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of rawEntries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw unsafe("Legacy workspace record is invalid");
    const entry = item as Record<string, unknown>;
    const path = typeof entry.path === "string" ? entry.path : typeof entry.workspacePath === "string" ? entry.workspacePath : typeof entry.canonicalPath === "string" ? entry.canonicalPath : undefined;
    if (!path || !isAbsolute(path)) throw unsafe("Legacy workspace path must be absolute");
    const permanent = entry.mode === "permanent" || entry.permanent === true || entry.expiresAt === null;
    const expiresAt = nonNegativeInteger(entry.expiresAt) ? entry.expiresAt as number : undefined;
    if (!permanent && expiresAt === undefined) continue; // A TTL without an original deadline is never renewed.
    const canonicalPath = resolve(path);
    const id = workspaceIdForPath(canonicalPath);
    const registeredAt = nonNegativeInteger(entry.registeredAt) ? entry.registeredAt as number : now;
    const updatedAt = nonNegativeInteger(entry.updatedAt) ? entry.updatedAt as number : registeredAt;
    const generation = Number.isSafeInteger(entry.generation) && (entry.generation as number) > 0 ? entry.generation as number : 1;
    const record = { version: 1, id, path: canonicalPath, canonicalPath, mode: permanent ? "permanent" : "lease", generation, registeredAt, updatedAt, ...(permanent ? {} : { expiresAt }) };
    const current = byId.get(id);
    if (!current || record.mode === "permanent") byId.set(id, record);
  }
  if (byId.size > GATEWAY_HARD_LIMITS.maxWorkspaceCount) throw unsafe("Migrated workspace count exceeds the Gateway hard limit");
  return [...byId.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

async function assertOffline(context: { legacyRoot: string; nativeRoot: string; liveness: ProcessLiveness; residentProbe?: GatewayLegacyMigrationOptions["residentProbe"] }): Promise<void> {
  const pidEvidence = [
    [context.legacyRoot, "mcpx-server.pid"], [context.legacyRoot, "gateway.pid"], [context.legacyRoot, "cloudflared.pid"],
  ] as const;
  for (const [root, relativePath] of pidEvidence) {
    const captured: CapturedSource[] = [];
    const value = await captureOptional(root, relativePath, 1024, captured);
    if (!value) continue;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(value.bytes).trim();
      if (!/^\d{1,10}$/u.test(text)) throw unsafe("Legacy process evidence is invalid");
      await assertPidStopped(Number(text), context.liveness);
    } finally { value.bytes.fill(0); }
  }
  for (const [root, relativePath] of [[context.legacyRoot, join(LEGACY_STATE, "owner.json")], [context.legacyRoot, "gateway-owner.json"], [context.nativeRoot, join("v1", "owner.json")]] as const) {
    const captured: CapturedSource[] = [];
    const value = await captureOptional(root, relativePath, 128 * 1024, captured);
    if (!value) continue;
    try {
      const owner = parseJson(value.bytes, "owner record") as { version?: unknown; pid?: unknown };
      if (owner.version !== 1) throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_UNKNOWN_VERSION", "Gateway owner record version is not supported");
      if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) < 1) throw unsafe("Gateway owner process evidence is invalid");
      await assertPidStopped(owner.pid as number, context.liveness);
    } finally { value.bytes.fill(0); }
  }
  const probe = context.residentProbe ?? (async (manifestPath: string, ownerPath: string) => {
    await new GatewayResidentService({ manifestPath, ownerPath }).assertStoppedForMigration();
  });
  for (const [root, state] of [[context.legacyRoot, LEGACY_STATE], [context.nativeRoot, "v1"]] as const) {
    const manifestPath = join(root, state, "service.json");
    if (await pathExistsRegularUnder(root, manifestPath)) await probe(manifestPath, join(root, state, "owner.json"));
  }
}

async function assertPidStopped(pid: number, liveness: ProcessLiveness): Promise<void> {
  const live = await liveness(pid);
  if (live === true) throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_LIVE_PROCESS", "Legacy/native Gateway or tunnel process is still running");
  if (live !== false) throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_LIVE_PROCESS", "Legacy/native process liveness could not be verified");
}

async function snapshotTasks(legacyRoot: string, sources: CapturedSource[], capturedAt: number): Promise<{ value: unknown; sourceDigest: string; records: number } | undefined> {
  const root = join(legacyRoot, "tasks");
  let rootInfo: Awaited<ReturnType<typeof lstat>>;
  try { rootInfo = await lstat(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw unsafe("Legacy task tree could not be inspected"); }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw unsafe("Legacy task tree is not a safe directory");
  const entries: Array<{ digest: string; bytes: number }> = [];
  let total = 0;
  let count = 0;
  async function boundedWalk(directory: string, depth: number): Promise<void> {
    if (depth > 8) throw unsafe("Legacy task tree exceeds the depth limit");
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw unsafe("Legacy task tree contains a symlink or reparse point");
      if (info.isDirectory()) { await boundedWalk(path, depth + 1); continue; }
      if (!info.isFile()) throw unsafe("Legacy task tree contains an unsupported entry");
      count += 1; total += info.size;
      if (count > MAX_TASK_FILES || total > MAX_TASK_BYTES) throw unsafe("Legacy task tree exceeds migration bounds");
      const bytes = await readStableRegular(path, Math.min(MAX_TASK_BYTES, info.size + 1));
      try { const digest = sha256(bytes); entries.push({ digest, bytes: bytes.length }); sources.push({ logical: `task:${sha256(relative(root, path))}`, path, digest, maximumBytes: Math.min(MAX_TASK_BYTES, info.size + 1) }); }
      finally { bytes.fill(0); }
    }
  }
  await boundedWalk(root, 0);
  entries.sort((left, right) => left.digest.localeCompare(right.digest) || left.bytes - right.bytes);
  const sourceDigest = aggregateDigest(entries.map((entry, index) => [`${index}:${entry.bytes}`, entry.digest]));
  return { value: { version: 1, capturedAt, sourceDigest, recordCount: entries.length, totalBytes: total }, sourceDigest, records: entries.length };
}

async function stagePlan(nativeRoot: string, plan: PreparedPlan, enforce: (path: string, kind: "directory" | "file") => Promise<void>, durability: PrivateStateDurability): Promise<TransactionMarker> {
  const transactionId = randomUUID();
  const stagingRelative = `.legacy-migration-${transactionId}.staging`;
  const stagingRoot = join(nativeRoot, stagingRelative);
  await ensurePrivateDirectory(stagingRoot, enforce);
  const artifacts: TransactionArtifact[] = [];
  let markerWritten = false;
  try {
    for (const prepared of plan.artifacts) {
      const staging = join(stagingRelative, `${prepared.kind}.next`);
      await writeExclusive(join(nativeRoot, staging), prepared.bytes, enforce, durability);
      artifacts.push({ kind: prepared.kind, target: prepared.targetRelative, staging, digest: prepared.digest, bytes: prepared.bytes.length, ...(prepared.records === undefined ? {} : { records: prepared.records }), ...(prepared.sourceDigest ? { sourceDigest: prepared.sourceDigest } : {}), disposition: prepared.disposition });
    }
    const marker: TransactionMarker = { version: 1, transactionId, sourceDigest: plan.sourceDigest, capturedAt: plan.capturedAt, artifacts, report: plan.report };
    const markerBytes = jsonBytes(marker);
    try { await writeExclusive(join(nativeRoot, TRANSACTION_NAME), markerBytes, enforce, durability); }
    finally { markerBytes.fill(0); }
    markerWritten = true;
    await durability.syncDirectory(nativeRoot);
    return marker;
  } finally {
    if (!markerWritten) await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function publishTransaction(nativeRoot: string, marker: TransactionMarker, enforce: (path: string, kind: "directory" | "file") => Promise<void>, durability: PrivateStateDurability, lock: { assertOwned(): Promise<void> }, options: GatewayLegacyMigrationOptions): Promise<void> {
  for (const artifact of marker.artifacts) {
    await lock.assertOwned();
    const target = safeNativePath(nativeRoot, artifact.target);
    const staging = safeNativePath(nativeRoot, artifact.staging);
    await ensurePrivateDirectory(dirname(target), enforce);
    const state = await digestState(target, artifact.digest);
    if (state === "foreign") throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_COLLISION", `Native ${artifact.kind} target already contains unrelated data`);
    if (state === "absent") {
      if (await digestState(staging, artifact.digest) !== "matching") throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_RECOVERY_REQUIRED", "Migration staging artifact is missing or changed");
      try { await link(staging, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await digestState(target, artifact.digest) !== "matching") throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_COLLISION", `Native ${artifact.kind} publication collided`);
      }
      await durability.syncFile(target); await durability.syncDirectory(dirname(target));
    }
    await options.fault?.(`after-publish:${artifact.kind}`);
  }
  const report: GatewayLegacyMigrationReport = { version: 1, mode: "apply", status: "applied", sourceDigest: marker.sourceDigest, artifacts: marker.report.map((entry) => entry.disposition === "migrate" || entry.disposition === "snapshot-only" ? { ...entry, disposition: "published" } : entry), warnings: ["Legacy files were not modified or deleted.", "Legacy owner, PID, resident-service ownership, and tunnel authority were not imported."] };
  const receiptStaging = safeNativePath(nativeRoot, join(`.legacy-migration-${marker.transactionId}.staging`, "receipt.next"));
  const receiptBytes = jsonBytes(report);
  const receiptDigest = sha256(receiptBytes);
  try { if (await digestState(receiptStaging, receiptDigest) === "absent") await writeExclusive(receiptStaging, receiptBytes, enforce, durability); }
  finally { receiptBytes.fill(0); }
  const receipt = join(nativeRoot, RECEIPT_NAME);
  const receiptState = await digestState(receipt, receiptDigest);
  if (receiptState === "foreign") throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_COLLISION", "Native migration receipt publication collided");
  if (receiptState === "absent") {
    try { await link(receiptStaging, receipt); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await digestState(receipt, receiptDigest) !== "matching") throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_COLLISION", "Native migration receipt publication collided"); }
    await durability.syncFile(receipt); await durability.syncDirectory(nativeRoot);
  }
  await options.fault?.("after-receipt");
  await rm(join(nativeRoot, `.legacy-migration-${marker.transactionId}.staging`), { recursive: true, force: true });
  await rm(join(nativeRoot, TRANSACTION_NAME), { force: true });
  await durability.syncDirectory(nativeRoot);
}

async function recoverTransaction(marker: TransactionMarker, context: { legacyRoot: string; nativeRoot: string; capturedAt: number; liveness: ProcessLiveness; residentProbe?: GatewayLegacyMigrationOptions["residentProbe"] }, enforce: (path: string, kind: "directory" | "file") => Promise<void>, durability: PrivateStateDurability, lock: { assertOwned(): Promise<void> }, options: GatewayLegacyMigrationOptions): Promise<GatewayLegacyMigrationReport> {
  validateTransaction(marker);
  const plan = await preparePlan({ ...context, capturedAt: marker.capturedAt });
  try {
    if (plan.sourceDigest !== marker.sourceDigest) throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_SOURCE_DRIFT", "Legacy Gateway source changed while a migration transaction was pending");
    for (const artifact of marker.artifacts) {
      const prepared = plan.artifacts.find((entry) => entry.kind === artifact.kind);
      if (!prepared || prepared.digest !== artifact.digest || prepared.targetRelative !== artifact.target) throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_RECOVERY_REQUIRED", "Migration transaction no longer matches its staged transformation");
    }
    await publishTransaction(context.nativeRoot, marker, enforce, durability, lock, options);
    return reportFor(plan, "apply", "recovered", "published");
  } finally { disposePlan(plan); }
}

async function readTransaction(nativeRoot: string): Promise<TransactionMarker | undefined> {
  const bytes = await readOptionalRegular(join(nativeRoot, TRANSACTION_NAME), 256 * 1024);
  if (!bytes) return undefined;
  try { const marker = parseJson(bytes, "migration transaction") as TransactionMarker; validateTransaction(marker); return marker; }
  finally { bytes.fill(0); }
}

function validateTransaction(marker: TransactionMarker): void {
  if (!marker || marker.version !== 1 || typeof marker.transactionId !== "string" || !/^[0-9a-f-]{36}$/u.test(marker.transactionId) || !digest(marker.sourceDigest) || !nonNegativeInteger(marker.capturedAt) || !Array.isArray(marker.artifacts) || marker.artifacts.length > TARGETS.size || !Array.isArray(marker.report)) throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_RECOVERY_REQUIRED", "Migration transaction marker is invalid");
  const kinds = new Set<string>();
  for (const artifact of marker.artifacts) {
    const target = TARGETS.get(artifact.kind);
    if (!target || kinds.has(artifact.kind) || artifact.target !== target || artifact.staging !== join(`.legacy-migration-${marker.transactionId}.staging`, `${artifact.kind}.next`) || !digest(artifact.digest) || !nonNegativeInteger(artifact.bytes)) throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_RECOVERY_REQUIRED", "Migration transaction marker is invalid");
    kinds.add(artifact.kind);
  }
}

async function readReceipt(nativeRoot: string): Promise<GatewayLegacyMigrationReport | undefined> {
  const bytes = await readOptionalRegular(join(nativeRoot, RECEIPT_NAME), 256 * 1024);
  if (!bytes) return undefined;
  try {
    const receipt = parseJson(bytes, "migration receipt") as GatewayLegacyMigrationReport;
    if (receipt.version !== 1 || receipt.mode !== "apply" || receipt.status !== "applied" || !digest(receipt.sourceDigest) || !Array.isArray(receipt.artifacts) || !Array.isArray(receipt.warnings)) throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_COLLISION", "Native migration receipt is invalid");
    return receipt;
  } finally { bytes.fill(0); }
}

async function assertTargetsAbsent(nativeRoot: string, artifacts: PreparedArtifact[]): Promise<void> {
  for (const artifact of artifacts) {
    const target = safeNativePath(nativeRoot, artifact.targetRelative);
    const parent = dirname(target);
    if (await pathExists(parent)) { const info = await lstat(parent); if (!info.isDirectory() || info.isSymbolicLink()) throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_COLLISION", "Native migration target parent is unsafe"); }
    if (await pathExists(target)) throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_COLLISION", `Native ${artifact.kind} target already exists`);
  }
}

function artifact(kind: ArtifactKind, bytes: Buffer, sourceDigest: string | undefined, records: number | undefined, disposition: "migrate" | "snapshot-only"): PreparedArtifact {
  return { kind, targetRelative: TARGETS.get(kind)!, bytes, digest: sha256(bytes), ...(records === undefined ? {} : { records }), ...(sourceDigest ? { sourceDigest } : {}), disposition };
}
function reportEntry(value: PreparedArtifact): GatewayLegacyArtifactReport { return { kind: value.kind, disposition: value.disposition, ...(value.records === undefined ? {} : { records: value.records }), ...(value.sourceDigest ? { sourceDigest: value.sourceDigest } : {}), targetDigest: value.digest }; }
function disposePlan(plan: PreparedPlan): void { for (const artifact of plan.artifacts) artifact.bytes.fill(0); }
function jsonBytes(value: unknown): Buffer { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function sha256(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function aggregateDigest(entries: Array<[string, string]>): string { return sha256(entries.sort(([a], [b]) => a.localeCompare(b)).map(([name, hash]) => `${name}\0${hash}\n`).join("")); }
function nonNegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function unsafe(message: string): GatewayLegacyMigrationError { return new GatewayLegacyMigrationError("LEGACY_MIGRATION_UNSAFE_SOURCE", message); }
function parseJson(bytes: Buffer, label: string): unknown { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw unsafe(`Legacy ${label} is invalid JSON or UTF-8`); } }
function isWithin(root: string, candidate: string): boolean { const value = relative(root, candidate); return value === "" || value !== ".." && !value.startsWith(`..${sep}`); }
function safeNativePath(root: string, child: string): string { const target = resolve(root, child); if (!isWithin(root, target)) throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_RECOVERY_REQUIRED", "Migration path escapes the native Gateway root"); return target; }

async function captureOptional(root: string, relativePath: string, maximumBytes: number, sources: CapturedSource[]): Promise<{ bytes: Buffer; digest: string } | undefined> {
  const path = resolve(root, relativePath);
  if (!isWithin(root, path)) throw unsafe("Legacy source path escapes its root");
  await assertSafeAncestors(root, dirname(path));
  let bytes: Buffer;
  try { bytes = await readStableRegular(path, maximumBytes); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; if (error instanceof GatewayLegacyMigrationError) throw error; throw unsafe("Legacy source could not be read safely"); }
  const hash = sha256(bytes);
  sources.push({ logical: relativePath.replace(/\\/gu, "/"), path, digest: hash, maximumBytes });
  return { bytes, digest: hash };
}

async function readStableRegular(path: string, maximumBytes: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) throw unsafe("Legacy source is not a bounded regular file");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const heldBefore = await handle.stat();
    if (!heldBefore.isFile() || heldBefore.size > maximumBytes || heldBefore.dev !== before.dev || heldBefore.ino !== before.ino) throw unsafe("Legacy source identity changed while opening");
    const bytes = await handle.readFile();
    const heldAfter = await handle.stat();
    const after = await lstat(path);
    if (bytes.length > maximumBytes || after.isSymbolicLink() || !after.isFile() || heldAfter.size !== bytes.length || heldAfter.dev !== after.dev || heldAfter.ino !== after.ino || heldAfter.mtimeMs !== heldBefore.mtimeMs) { bytes.fill(0); throw unsafe("Legacy source changed while reading"); }
    return bytes;
  } finally { await handle.close(); }
}
async function readOptionalRegular(path: string, maximumBytes: number): Promise<Buffer | undefined> { try { return await readStableRegular(path, maximumBytes); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
async function pathExists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
async function pathExistsRegularUnder(root: string, path: string): Promise<boolean> { await assertSafeAncestors(root, dirname(path)); try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw unsafe("Resident service evidence is unsafe"); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
async function assertSafeAncestors(root: string, candidate: string): Promise<void> {
  if (!isWithin(root, candidate)) throw unsafe("Legacy source path escapes its root");
  let current = root;
  try { const rootInfo = await lstat(current); if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw unsafe("Legacy Gateway root is unsafe"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const rel = relative(root, candidate);
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    try { const info = await lstat(current); if (!info.isDirectory() || info.isSymbolicLink()) throw unsafe("Legacy source ancestor is a symlink, reparse point, or non-directory"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
}
async function assertRootSafeIfPresent(root: string): Promise<void> { try { const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) throw unsafe("Legacy Gateway root is a symlink, reparse point, or non-directory"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
async function ensurePrivateDirectory(path: string, enforce: (path: string, kind: "directory" | "file") => Promise<void>): Promise<void> { await mkdir(path, { recursive: true, mode: 0o700 }); const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new GatewayLegacyMigrationError("LEGACY_MIGRATION_UNSAFE_SOURCE", "Native Gateway staging path is unsafe"); await enforce(path, "directory"); }
async function writeExclusive(path: string, bytes: Buffer, enforce: (path: string, kind: "directory" | "file") => Promise<void>, durability: PrivateStateDurability): Promise<void> { await writeSimpleExclusive(path, bytes, durability); await enforce(path, "file"); }
async function writeSimpleExclusive(path: string, bytes: Buffer, durability: PrivateStateDurability): Promise<void> { const handle = await open(path, "wx", 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } await chmod(path, 0o600).catch(() => undefined); await durability.syncDirectory(dirname(path)); }
async function digestState(path: string, expected: string): Promise<"absent" | "matching" | "foreign"> { let bytes: Buffer | undefined; try { bytes = await readStableRegular(path, MAX_TASK_BYTES + MAX_CONFIG_BYTES); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"; return "foreign"; } try { return sha256(bytes) === expected ? "matching" : "foreign"; } finally { bytes.fill(0); } }
