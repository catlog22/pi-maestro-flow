/**
 * Crash-consistent file store for the durable mailbox state machine.
 *
 * Envelopes are immutable. State changes use a durable transition journal,
 * destination metadata, a cross-directory rename, file/directory fsync, and
 * only then cleanup. Mutable metadata replacement retains recoverable .new and
 * .bak candidates and never unlinks the sole committed value.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  link,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  CLAIM_STALE_MS,
  MAILBOX_DEDUP_RECORD_VERSION,
  MAILBOX_SCHEMA_VERSION,
  MAILBOX_STATE_RECORD_VERSION,
  MAILBOX_TRANSITION_RECORD_VERSION,
  type MailboxClaim,
  type MailboxDedupRecord,
  type MailboxEnvelope,
  type MailboxOwnerFence,
  type MailboxPaths,
  type MailboxState,
  type MailboxStateRecord,
  type MailboxTransitionRecord,
  MAX_ENVELOPE_BYTES,
  MAX_PAYLOAD_BYTES,
  MESSAGE_ID_PATTERN,
  stateDirKey,
} from "./types.ts";

const MAX_STATE_RECORD_BYTES = 8 * 1024;
const MAX_TRANSITION_RECORD_BYTES = 16 * 1024;
const MAX_DEDUP_RECORD_BYTES = MAX_ENVELOPE_BYTES + 8 * 1024;
const MAX_LEGACY_SEEN_BYTES = 512;
const MAX_DEDUP_KEY_BYTES = 256;
const MAX_LOCK_BYTES = 4 * 1024;
const LOCK_WAIT_MS = 10;
const LOCK_MAX_ATTEMPTS = 500;
const LOCK_LEASE_MS = 60_000;
const RENAME_RETRY_MS = 25;
const RENAME_MAX_RETRIES = 5;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const STATE_VALUES: ReadonlySet<string> = new Set([
  "staging", "ready", "claimed", "accepted", "applied", "rejected", "expired", "dead",
]);
const activeOwnerFences = new Set<string>();

export type MailboxPersistenceBoundary =
  | "dedup-prepared"
  | "envelope-prepared"
  | "envelope-published"
  | "transition-prepared"
  | "transition-metadata"
  | "transition-renamed"
  | "transition-directories-synced"
  | "transition-source-cleaned"
  | "transition-finished"
  | "replacement-prepared"
  | "replacement-backup"
  | "replacement-published"
  | "replacement-finished";

// --- Path construction ---

export function createMailboxPaths(rootDir: string): MailboxPaths {
  return {
    rootDir,
    stagingDir: join(rootDir, "staging"),
    readyDir: join(rootDir, "ready"),
    claimedDir: join(rootDir, "claimed"),
    acceptedDir: join(rootDir, "accepted"),
    appliedDir: join(rootDir, "applied"),
    rejectedDir: join(rootDir, "rejected"),
    expiredDir: join(rootDir, "expired"),
    deadDir: join(rootDir, "dead"),
    seenDir: join(rootDir, "seen"),
    transitionDir: join(rootDir, "transitions"),
  };
}

export async function ensureMailboxDirectories(paths: MailboxPaths): Promise<void> {
  for (const dir of [
    paths.rootDir,
    paths.stagingDir,
    paths.readyDir,
    paths.claimedDir,
    paths.acceptedDir,
    paths.appliedDir,
    paths.rejectedDir,
    paths.expiredDir,
    paths.deadDir,
    paths.seenDir,
    paths.transitionDir,
  ]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
}

function envelopePath(paths: MailboxPaths, state: MailboxState, messageId: string): string {
  return join(paths[stateDirKey(state)], `${messageId}.json`);
}

function stateRecordPath(paths: MailboxPaths, state: MailboxState, messageId: string): string {
  return join(paths[stateDirKey(state)], `${messageId}.state.json`);
}

function claimLockPath(paths: MailboxPaths, messageId: string): string {
  return join(paths.claimedDir, `${messageId}.claim.lock`);
}

function transitionPath(paths: MailboxPaths, messageId: string): string {
  return join(paths.transitionDir, `${messageId}.transition.json`);
}

function mutationLockPath(paths: MailboxPaths, messageId: string): string {
  return join(paths.transitionDir, `${messageId}.mutation.lock`);
}

function seenPath(paths: MailboxPaths, key: string): string {
  return join(paths.seenDir, `${requestKeyHash(key)}.seen`);
}

function requestKeyHash(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function boundedLegacySeenKey(key: string): string {
  return Buffer.byteLength(key, "utf8") > MAX_DEDUP_KEY_BYTES
    ? Buffer.from(key, "utf8").subarray(0, MAX_DEDUP_KEY_BYTES).toString("utf8")
    : key;
}

// --- fsync / private writes ---

async function fsyncDirectory(dirPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dirPath, "r");
    await handle.sync();
  } catch (error) {
    const code = fileCode(error);
    if (code !== "EPERM" && code !== "EINVAL" && code !== "ENOSYS" && code !== "EBADF") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function fileCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if ((fileCode(error) === "EPERM" || fileCode(error) === "EACCES" || fileCode(error) === "EEXIST")
        && attempt < RENAME_MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then((entry) => entry.isFile() && !entry.isSymbolicLink(), (error) => {
    if (fileCode(error) === "ENOENT") return false;
    throw error;
  });
}

async function directoryEntryExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error) => {
    if (fileCode(error) === "ENOENT") return false;
    throw error;
  });
}

async function readSafeJson(path: string, maxBytes: number): Promise<unknown | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) return undefined;
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (fileCode(error) === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function writeExclusiveJson(path: string, value: unknown, maxBytes: number): Promise<void> {
  const payload = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (payload.byteLength > maxBytes) throw new Error(`record exceeds ${maxBytes} byte limit (${payload.byteLength} bytes)`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsyncDirectory(dirname(path));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

/** Publish immutable data from a same-directory 0600 wx temporary without overwriting. */
async function writeImmutableJson(path: string, value: unknown, maxBytes: number): Promise<void> {
  const payload = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (payload.byteLength > maxBytes) throw new Error(`envelope exceeds ${maxBytes} byte limit (${payload.byteLength} bytes)`);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, path);
    } catch (error) {
      if (fileCode(error) !== "EPERM" && fileCode(error) !== "ENOSYS" && fileCode(error) !== "EACCES") throw error;
      await copyFile(temporary, path, fsConstants.COPYFILE_EXCL);
      const published = await open(path, "r+");
      try { await published.sync(); } finally { await published.close(); }
    }
    await fsyncDirectory(dir);
    await rm(temporary, { force: true });
    await fsyncDirectory(dir);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function replacementPrefix(path: string): string {
  return `${basename(path)}.replace-`;
}

async function replacementCandidates(path: string): Promise<string[]> {
  const dir = dirname(path);
  const prefix = replacementPrefix(path);
  const names = await readdir(dir).catch((error) => {
    if (fileCode(error) === "ENOENT") return [] as string[];
    throw error;
  });
  return names
    .filter((name) => name.startsWith(prefix) && (name.endsWith(".new") || name.endsWith(".bak")))
    .sort((left, right) => {
      const leftNew = left.endsWith(".new") ? 0 : 1;
      const rightNew = right.endsWith(".new") ? 0 : 1;
      return leftNew - rightNew || right.localeCompare(left);
    })
    .map((name) => join(dir, name));
}

async function readRecoverableJson(path: string, maxBytes: number): Promise<unknown | undefined> {
  const canonical = await readSafeJson(path, maxBytes);
  if (canonical !== undefined) return canonical;
  for (const candidate of await replacementCandidates(path)) {
    const value = await readSafeJson(candidate, maxBytes);
    if (value !== undefined) return value;
  }
  return undefined;
}

async function prepareRecoverablePath(path: string, maxBytes: number): Promise<void> {
  if (await pathExists(path)) return;
  for (const candidate of await replacementCandidates(path)) {
    if (await readSafeJson(candidate, maxBytes) === undefined) continue;
    await renameWithRetry(candidate, path);
    await fsyncDirectory(dirname(path));
    return;
  }
}

/** Recoverable old-or-new replacement; never delete-then-recreate canonical. */
async function writeRecoverableJson(
  path: string,
  value: unknown,
  maxBytes: number,
  boundary?: (boundary: MailboxPersistenceBoundary) => void,
): Promise<void> {
  const payload = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (payload.byteLength > maxBytes) throw new Error(`record exceeds ${maxBytes} byte limit (${payload.byteLength} bytes)`);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await prepareRecoverablePath(path, maxBytes);
  const token = randomUUID();
  const replacement = `${path}.replace-${token}.new`;
  const backup = `${path}.replace-${token}.bak`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(replacement, "wx", 0o600);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    boundary?.("replacement-prepared");
    const current = await lstat(path).catch((error) => {
      if (fileCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (!current) {
      await renameWithRetry(replacement, path);
      await fsyncDirectory(dir);
      boundary?.("replacement-published");
      boundary?.("replacement-finished");
      return;
    }
    if (!current.isFile() || current.isSymbolicLink()) throw new Error(`record path must be a regular file: ${path}`);
    await renameWithRetry(path, backup);
    await fsyncDirectory(dir);
    boundary?.("replacement-backup");
    await renameWithRetry(replacement, path);
    await fsyncDirectory(dir);
    boundary?.("replacement-published");
    await rm(backup, { force: true });
    await fsyncDirectory(dir);
    boundary?.("replacement-finished");
  } catch (error) {
    await handle?.close().catch(() => undefined);
    // Preserve .new/.bak: read/prepare recovery chooses a complete old or new value.
    throw error;
  }
}

async function removeRecoverableFamily(path: string): Promise<void> {
  const family = [path, ...await replacementCandidates(path)];
  for (const candidate of family) await rm(candidate, { force: true });
  await fsyncDirectory(dirname(path));
}

// --- canonical hashing / validation ---

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, canonicalValue(entry)]));
}

export function computeEnvelopeHash(envelope: Omit<MailboxEnvelope, "hash">): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(envelope)), "utf8").digest("hex");
}

export function verifyEnvelopeHash(envelope: MailboxEnvelope): boolean {
  if (!envelope || typeof envelope !== "object" || !HASH_PATTERN.test(envelope.hash)) return false;
  const { hash, ...rest } = envelope;
  return computeEnvelopeHash(rest) === hash;
}

function validEnvelope(envelope: unknown, expectedMessageId?: string): envelope is MailboxEnvelope {
  if (!envelope || typeof envelope !== "object") return false;
  const value = envelope as Partial<MailboxEnvelope>;
  return value.schemaVersion === MAILBOX_SCHEMA_VERSION
    && typeof value.messageId === "string"
    && MESSAGE_ID_PATTERN.test(value.messageId)
    && (expectedMessageId === undefined || value.messageId === expectedMessageId)
    && typeof value.payload === "string"
    && typeof value.workspaceId === "string"
    && typeof value.recipientCorrelationId === "string"
    && verifyEnvelopeHash(value as MailboxEnvelope);
}

function validInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validClaim(value: unknown, messageId: string): value is MailboxClaim {
  if (!value || typeof value !== "object") return false;
  const claim = value as Partial<MailboxClaim>;
  if (claim.messageId !== messageId || typeof claim.claimerNonce !== "string" || !claim.claimerNonce
    || !validInteger(claim.claimedAt) || !validInteger(claim.leaseExpiresAt) || !validInteger(claim.lastHeartbeatAt)) return false;
  const modern = claim.ownerId !== undefined || claim.ownerNonce !== undefined
    || claim.sessionGeneration !== undefined || claim.ownerPid !== undefined;
  return !modern || (typeof claim.ownerId === "string" && !!claim.ownerId
    && typeof claim.ownerNonce === "string" && !!claim.ownerNonce
    && validInteger(claim.sessionGeneration) && validInteger(claim.ownerPid));
}

function parseStateRecord(value: unknown, state: MailboxState, messageId: string): MailboxStateRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<MailboxStateRecord>;
  const legacy = record.recordVersion === undefined;
  if ((!legacy && record.recordVersion !== MAILBOX_STATE_RECORD_VERSION)
    || record.messageId !== messageId || record.state !== state
    || !validInteger(record.transitionedAt)
    || !(record.previousState === null || STATE_VALUES.has(String(record.previousState)))
    || (!legacy && (typeof record.envelopeHash !== "string" || !HASH_PATTERN.test(record.envelopeHash)))) return undefined;
  if (record.claim !== undefined && !validClaim(record.claim, messageId)) return undefined;
  if ((state === "claimed" || state === "accepted") && !record.claim) return undefined;
  if (record.reason !== undefined && typeof record.reason !== "string") return undefined;
  return record as MailboxStateRecord;
}

function parseTransitionRecord(value: unknown, messageId: string): MailboxTransitionRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<MailboxTransitionRecord>;
  if (record.recordVersion !== MAILBOX_TRANSITION_RECORD_VERSION || record.messageId !== messageId
    || typeof record.transitionId !== "string" || !record.transitionId
    || typeof record.envelopeHash !== "string" || !HASH_PATTERN.test(record.envelopeHash)
    || !STATE_VALUES.has(String(record.fromState)) || !STATE_VALUES.has(String(record.toState))
    || record.fromState === record.toState || !validInteger(record.preparedAt)
    || (record.unreadable !== undefined && record.unreadable !== true)) return undefined;
  if (!parseStateRecord(record.destinationRecord, record.toState as MailboxState, messageId)
    || record.destinationRecord?.envelopeHash !== record.envelopeHash) return undefined;
  return record as MailboxTransitionRecord;
}

function parseDedupRecord(value: unknown): MailboxDedupRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<MailboxDedupRecord>;
  if (record.recordVersion !== MAILBOX_DEDUP_RECORD_VERSION
    || typeof record.requestKeyHash !== "string" || !HASH_PATTERN.test(record.requestKeyHash)
    || typeof record.requestHash !== "string" || !HASH_PATTERN.test(record.requestHash)
    || typeof record.messageId !== "string" || !MESSAGE_ID_PATTERN.test(record.messageId)
    || typeof record.envelopeHash !== "string" || !HASH_PATTERN.test(record.envelopeHash)
    || (record.phase !== "prepared" && record.phase !== "published")
    || !validInteger(record.preparedAt) || !validEnvelope(record.envelope, record.messageId)
    || record.envelope.hash !== record.envelopeHash) return undefined;
  return record as MailboxDedupRecord;
}

function ownerFenceKey(fence: MailboxOwnerFence): string {
  return `${fence.ownerId}\0${fence.ownerNonce}\0${fence.sessionGeneration}\0${fence.ownerPid}`;
}

function claimFence(claim: MailboxClaim): MailboxOwnerFence | undefined {
  if (claim.ownerId === undefined || claim.ownerNonce === undefined
    || claim.sessionGeneration === undefined || claim.ownerPid === undefined) return undefined;
  return {
    ownerId: claim.ownerId,
    ownerNonce: claim.ownerNonce,
    sessionGeneration: claim.sessionGeneration,
    ownerPid: claim.ownerPid,
  };
}

function fenceMatchesClaim(fence: MailboxOwnerFence, claim: MailboxClaim): boolean {
  const modern = claimFence(claim);
  return modern !== undefined
    ? ownerFenceKey(modern) === ownerFenceKey(fence)
    : true; // legacy accepted records predate a comparable owner fence.
}

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return fileCode(error) === "EPERM";
  }
}

export function activateMailboxOwner(fence: MailboxOwnerFence): void {
  activeOwnerFences.add(ownerFenceKey(fence));
}

export function deactivateMailboxOwner(fence: MailboxOwnerFence): void {
  activeOwnerFences.delete(ownerFenceKey(fence));
}

export function isMailboxClaimOwnerLive(claim: MailboxClaim, now = Date.now()): boolean {
  if (now >= claim.leaseExpiresAt || now >= claim.lastHeartbeatAt + CLAIM_STALE_MS) return false;
  const fence = claimFence(claim);
  if (!fence) return true; // recognized legacy claim: expiry is its only safe fence.
  if (fence.ownerPid === process.pid) return activeOwnerFences.has(ownerFenceKey(fence));
  return pidAlive(fence.ownerPid);
}

async function mutationAuthorityAllows(authority: MailboxMutationAuthority | undefined): Promise<boolean> {
  if (!authority) return true;
  // ownerFenceKey binds the stable owner id, per-incarnation nonce, captured
  // session generation, and pid. The dynamic hook revalidates the host's live
  // generation again from inside the store commit.
  return activeOwnerFences.has(ownerFenceKey(authority.owner)) && await authority.isCurrent();
}

// --- store ---

export interface FileStoreOptions {
  paths: MailboxPaths;
  now?: () => number;
  /** Test-only crash-window observer. Throwing preserves durable remnants. */
  onPersistenceBoundary?: (boundary: MailboxPersistenceBoundary) => void;
}

/** Exact owner incarnation plus a live generation/token revalidation hook. */
export interface MailboxMutationAuthority {
  owner: MailboxOwnerFence;
  isCurrent: () => boolean | Promise<boolean>;
}

interface MutationLockRecord {
  version: 1;
  token: string;
  pid: number;
  acquiredAt: number;
  expiresAt: number;
}

export type PrepareEnqueueResult =
  | { status: "prepared"; messageId: string }
  | { status: "duplicate"; messageId: string }
  | { status: "conflict"; messageId: string };

export class MailboxFileStore {
  readonly paths: MailboxPaths;
  readonly #now: () => number;
  readonly #boundary: ((boundary: MailboxPersistenceBoundary) => void) | undefined;

  constructor(options: FileStoreOptions) {
    this.paths = options.paths;
    this.#now = options.now ?? Date.now;
    this.#boundary = options.onPersistenceBoundary;
  }

  /** Recover interrupted transitions, request prepares, replacements, and legacy seen markers. */
  async recover(): Promise<void> {
    await ensureMailboxDirectories(this.paths);
    const transitionNames = await readdir(this.paths.transitionDir);
    for (const name of transitionNames.filter((entry) => entry.endsWith(".transition.json")).sort()) {
      const messageId = name.slice(0, -".transition.json".length);
      if (!MESSAGE_ID_PATTERN.test(messageId)) throw new Error(`invalid mailbox transition journal name: ${name}`);
      await this.#withMessageLock(messageId, async () => { await this.#recoverTransitionLocked(messageId); });
    }
    await this.#recoverClaimLocks();
    await this.#recoverDedupTransactions();
    await this.#cleanupDeadTemporaryFiles(128);
  }

  /** Durable requestId prepare; an existing record is reconciled before duplicate/conflict returns. */
  async prepareEnqueue(dedupKey: string, requestHash: string, envelope: MailboxEnvelope): Promise<PrepareEnqueueResult> {
    if (!HASH_PATTERN.test(requestHash)) throw new Error("invalid mailbox request hash");
    this.#assertEnvelopeForWrite(envelope);
    const path = seenPath(this.paths, dedupKey);
    const record: MailboxDedupRecord = {
      recordVersion: MAILBOX_DEDUP_RECORD_VERSION,
      requestKeyHash: requestKeyHash(dedupKey),
      requestHash,
      messageId: envelope.messageId,
      envelopeHash: envelope.hash,
      envelope,
      phase: "prepared",
      preparedAt: this.#now(),
    };
    let created = false;
    try {
      await writeExclusiveJson(path, record, MAX_DEDUP_RECORD_BYTES);
      created = true;
      this.#boundary?.("dedup-prepared");
    } catch (error) {
      if (fileCode(error) !== "EEXIST") throw error;
    }
    let existingValue = await readRecoverableJson(path, MAX_DEDUP_RECORD_BYTES);
    let existing = parseDedupRecord(existingValue);
    if (!existing) {
      const legacy = parseLegacySeen(existingValue);
      if (legacy) throw new Error(`legacy mailbox seen marker was not reconciled for ${record.requestKeyHash}`);
      throw new Error(`invalid mailbox dedup transaction: ${basename(path)}`);
    }
    if (existing.requestKeyHash !== record.requestKeyHash) throw new Error("mailbox dedup key hash collision");
    // A concurrent creator normally publishes within a few filesystem turns.
    // Let it finish before taking over recovery so two callers do not replace
    // the same dedup metadata concurrently. If it disappeared, this caller
    // deterministically completes the durable prepare after the bounded wait.
    if (!created && existing.phase === "prepared") {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
        existingValue = await readRecoverableJson(path, MAX_DEDUP_RECORD_BYTES);
        const refreshed = parseDedupRecord(existingValue);
        if (!refreshed) throw new Error(`invalid mailbox dedup transaction: ${basename(path)}`);
        existing = refreshed;
        if (existing.phase === "published") break;
      }
    }
    await this.#reconcileDedupRecord(path, existing);
    if (created) return { status: "prepared", messageId: existing.messageId };
    if (existing.requestHash !== requestHash) return { status: "conflict", messageId: existing.messageId };
    return { status: "duplicate", messageId: existing.messageId };
  }

  /** Write an immutable staging envelope, failing closed on messageId collisions. */
  async writeStaging(envelope: MailboxEnvelope): Promise<void> {
    this.#assertEnvelopeForWrite(envelope);
    const located = await this.#locateEnvelope(envelope.messageId);
    if (located.length > 0) {
      if (located.length === 1 && located[0]!.state === "staging" && located[0]!.envelope.hash === envelope.hash) return;
      throw new Error(`mailbox messageId collision: ${envelope.messageId}`);
    }
    await writeImmutableJson(envelopePath(this.paths, "staging", envelope.messageId), envelope, MAX_ENVELOPE_BYTES);
    this.#boundary?.("envelope-published");
  }

  async promoteToReady(messageId: string): Promise<boolean> {
    return this.#transition(messageId, "staging", "ready");
  }

  async claim(messageId: string, claim: MailboxClaim): Promise<boolean> {
    if (!validClaim(claim, messageId)) throw new Error(`invalid mailbox claim for ${messageId}`);
    const lockPath = claimLockPath(this.paths, messageId);
    try {
      await writeExclusiveJson(lockPath, claim, MAX_LOCK_BYTES);
    } catch (error) {
      if (fileCode(error) === "EEXIST") return false;
      throw error;
    }
    try {
      const transitioned = await this.#transition(messageId, "ready", "claimed", { claim });
      if (!transitioned) await this.#removeClaimLockIfOwned(messageId, claim);
      return transitioned;
    } catch (error) {
      // A journal may already own recovery; the claim lock is not the sole envelope.
      await this.#removeClaimLockIfOwned(messageId, claim).catch(() => undefined);
      throw error;
    }
  }

  async accept(messageId: string, claim: MailboxClaim): Promise<boolean> {
    return this.#transition(messageId, "claimed", "accepted", { claim, expectedClaim: claim });
  }

  async apply(messageId: string, owner?: MailboxOwnerFence): Promise<boolean> {
    return this.#transition(messageId, "accepted", "applied", { expectedOwner: owner });
  }

  async reject(messageId: string, fromState: "ready" | "claimed", reason: string, owner?: MailboxOwnerFence): Promise<boolean> {
    return this.#transition(messageId, fromState, "rejected", { reason, expectedOwner: owner });
  }

  async expire(messageId: string, mutationAuthority?: MailboxMutationAuthority): Promise<boolean> {
    return this.#transition(messageId, "ready", "expired", { mutationAuthority });
  }

  async dead(messageId: string, fromState: MailboxState, reason: string, owner?: MailboxOwnerFence): Promise<boolean> {
    return this.#transition(messageId, fromState, "dead", { reason, expectedOwner: owner });
  }

  /** Non-destructive reverse transition used for retry/takeover. */
  async requeue(messageId: string, fromState: "claimed" | "accepted", options: {
    owner?: MailboxOwnerFence;
    allowTakeover?: boolean;
  } = {}): Promise<boolean> {
    return this.#transition(messageId, fromState, "ready", {
      expectedOwner: options.owner,
      allowTakeover: options.allowTakeover,
    });
  }

  async renewClaim(messageId: string, claim: MailboxClaim): Promise<boolean> {
    return this.#renewOwnedState("claimed", messageId, claim);
  }

  async renewAccepted(messageId: string, claim: MailboxClaim): Promise<boolean> {
    return this.#renewOwnedState("accepted", messageId, claim);
  }

  async #renewOwnedState(state: "claimed" | "accepted", messageId: string, claim: MailboxClaim): Promise<boolean> {
    return this.#withMessageLock(messageId, async () => {
      await this.#recoverTransitionLocked(messageId);
      const current = await this.readStateRecord(state, messageId);
      if (!current?.claim || !sameClaimOwner(current.claim, claim)) return false;
      const envelope = await this.readEnvelope(state, messageId);
      if (!envelope || (current.envelopeHash !== undefined && current.envelopeHash !== envelope.hash)) return false;
      const record = this.#stateRecord(messageId, state, current.previousState, envelope.hash, { claim });
      await writeRecoverableJson(stateRecordPath(this.paths, state, messageId), record, MAX_STATE_RECORD_BYTES, this.#boundary);
      return true;
    });
  }

  async readEnvelope(state: MailboxState, messageId: string): Promise<MailboxEnvelope | undefined> {
    const value = await readSafeJson(envelopePath(this.paths, state, messageId), MAX_ENVELOPE_BYTES);
    return validEnvelope(value, messageId) ? value : undefined;
  }

  async readStateRecord(state: MailboxState, messageId: string): Promise<MailboxStateRecord | undefined> {
    const path = stateRecordPath(this.paths, state, messageId);
    const value = await readRecoverableJson(path, MAX_STATE_RECORD_BYTES);
    if (value === undefined) return undefined;
    const record = parseStateRecord(value, state, messageId);
    if (!record) throw new Error(`invalid mailbox state record: ${state}/${messageId}`);
    const envelope = await this.readEnvelope(state, messageId);
    if (envelope && record.envelopeHash !== undefined && record.envelopeHash !== envelope.hash) {
      throw new Error(`mailbox state/envelope hash conflict: ${state}/${messageId}`);
    }
    return record;
  }

  async listMessages(state: MailboxState, limit?: number): Promise<string[]> {
    const files = await readdir(this.paths[stateDirKey(state)]).catch((error) => {
      if (fileCode(error) === "ENOENT") return [] as string[];
      throw error;
    });
    const values = files
      .filter((file) => file.endsWith(".json") && !file.endsWith(".state.json") && !file.includes(".replace-") && !file.endsWith(".tmp"))
      .map((file) => file.slice(0, -5))
      .filter((messageId) => MESSAGE_ID_PATTERN.test(messageId))
      .sort();
    return limit === undefined ? values : values.slice(0, Math.max(0, limit));
  }

  async listOrphanStateRecords(state: MailboxState, limit?: number): Promise<string[]> {
    const files = await readdir(this.paths[stateDirKey(state)]).catch((error) => {
      if (fileCode(error) === "ENOENT") return [] as string[];
      throw error;
    });
    const envelopes = new Set(files.filter((file) => file.endsWith(".json") && !file.endsWith(".state.json") && !file.includes(".replace-"))
      .map((file) => file.slice(0, -5)));
    const values = files.filter((file) => file.endsWith(".state.json"))
      .map((file) => file.slice(0, -".state.json".length))
      .filter((messageId) => MESSAGE_ID_PATTERN.test(messageId) && !envelopes.has(messageId))
      .sort();
    return limit === undefined ? values : values.slice(0, Math.max(0, limit));
  }

  async removeStateRecordOnly(
    state: MailboxState,
    messageId: string,
    mutationAuthority?: MailboxMutationAuthority,
  ): Promise<boolean> {
    return this.#withMessageLock(messageId, async () => {
      if (!await mutationAuthorityAllows(mutationAuthority)) return false;
      if (await this.hasTransition(messageId)) return false;
      if (!await mutationAuthorityAllows(mutationAuthority)) return false;
      await removeRecoverableFamily(stateRecordPath(this.paths, state, messageId));
      return true;
    });
  }

  async removeClaimLock(messageId: string): Promise<void> {
    const claim = await readSafeJson(claimLockPath(this.paths, messageId), MAX_LOCK_BYTES);
    if (validClaim(claim, messageId) && isMailboxClaimOwnerLive(claim, this.#now())) return;
    await rm(claimLockPath(this.paths, messageId), { force: true });
    await fsyncDirectory(this.paths.claimedDir);
  }

  async hasClaimLock(messageId: string): Promise<boolean> {
    return pathExists(claimLockPath(this.paths, messageId));
  }

  async hasTransition(messageId: string): Promise<boolean> {
    return pathExists(transitionPath(this.paths, messageId));
  }

  async isSeen(key: string): Promise<boolean> {
    return (await readRecoverableJson(seenPath(this.paths, key), MAX_DEDUP_RECORD_BYTES)) !== undefined;
  }

  /** Legacy compatibility helper. Router enqueue uses prepareEnqueue instead. */
  async markSeen(key: string): Promise<void> {
    const path = seenPath(this.paths, key);
    const value = { key: boundedLegacySeenKey(key), seenAt: this.#now() };
    if (await pathExists(path)) return;
    await writeExclusiveJson(path, value, MAX_LEGACY_SEEN_BYTES).catch((error) => {
      if (fileCode(error) !== "EEXIST") throw error;
    });
  }

  /** Legacy compatibility helper. Router enqueue uses prepareEnqueue instead. */
  async tryMarkSeen(key: string): Promise<boolean> {
    const path = seenPath(this.paths, key);
    try {
      await writeExclusiveJson(path, { key: boundedLegacySeenKey(key), seenAt: this.#now() }, MAX_LEGACY_SEEN_BYTES);
      return true;
    } catch (error) {
      if (fileCode(error) === "EEXIST") return false;
      throw error;
    }
  }

  async unmarkSeen(key: string): Promise<void> {
    await removeRecoverableFamily(seenPath(this.paths, key));
  }

  async listSeen(limit?: number): Promise<Array<{ file: string; seenAt: number }>> {
    const files = (await readdir(this.paths.seenDir)).filter((file) => file.endsWith(".seen")).sort();
    const records: Array<{ file: string; seenAt: number }> = [];
    for (const file of files) {
      if (limit !== undefined && records.length >= limit) break;
      const value = await readRecoverableJson(join(this.paths.seenDir, file), MAX_DEDUP_RECORD_BYTES);
      const dedup = parseDedupRecord(value);
      const legacy = parseLegacySeen(value);
      const seenAt = dedup?.preparedAt ?? legacy?.seenAt;
      if (seenAt !== undefined) records.push({ file, seenAt });
    }
    return records;
  }

  async listDedupRecords(limit?: number): Promise<MailboxDedupRecord[]> {
    const files = (await readdir(this.paths.seenDir)).filter((file) => file.endsWith(".seen")).sort();
    const records: MailboxDedupRecord[] = [];
    for (const file of files) {
      if (limit !== undefined && records.length >= limit) break;
      const value = await readRecoverableJson(join(this.paths.seenDir, file), MAX_DEDUP_RECORD_BYTES);
      const record = parseDedupRecord(value);
      if (record) records.push(record);
    }
    return records;
  }

  async removeSeen(file: string, mutationAuthority?: MailboxMutationAuthority): Promise<boolean> {
    if (!/^[a-f0-9]{64}\.seen$/.test(file)) throw new Error(`invalid mailbox seen filename: ${file}`);
    const lockKey = file.slice(0, -".seen".length);
    return this.#withMessageLock(lockKey, async () => {
      if (!await mutationAuthorityAllows(mutationAuthority)) return false;
      await removeRecoverableFamily(join(this.paths.seenDir, file));
      return true;
    });
  }

  async remove(
    state: MailboxState,
    messageId: string,
    mutationAuthority?: MailboxMutationAuthority,
  ): Promise<boolean> {
    return this.#withMessageLock(messageId, async () => {
      if (!await mutationAuthorityAllows(mutationAuthority)) return false;
      if (await this.hasTransition(messageId)) return false;
      if (!await mutationAuthorityAllows(mutationAuthority)) return false;
      await rm(envelopePath(this.paths, state, messageId), { force: true });
      await removeRecoverableFamily(stateRecordPath(this.paths, state, messageId));
      if (state === "claimed") await rm(claimLockPath(this.paths, messageId), { force: true });
      await fsyncDirectory(this.paths[stateDirKey(state)]);
      return true;
    });
  }

  async count(state: MailboxState): Promise<number> {
    return (await this.listMessages(state)).length;
  }

  async countLive(): Promise<number> {
    const counts = await Promise.all(["staging", "ready", "claimed", "accepted"].map((state) => this.count(state as MailboxState)));
    return counts.reduce((sum, count) => sum + count, 0);
  }

  #assertEnvelopeForWrite(envelope: MailboxEnvelope): void {
    const messageId = envelope.messageId;
    if (!MESSAGE_ID_PATTERN.test(messageId)) throw new Error(`invalid messageId format: ${messageId}`);
    if (!validEnvelope(envelope, messageId)) throw new Error(`invalid mailbox envelope: ${messageId}`);
    const payloadBytes = Buffer.byteLength(envelope.payload, "utf8");
    if (payloadBytes > MAX_PAYLOAD_BYTES) throw new Error(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes (${payloadBytes})`);
    const envelopeBytes = Buffer.byteLength(`${JSON.stringify(envelope)}\n`, "utf8");
    if (envelopeBytes > MAX_ENVELOPE_BYTES) throw new Error(`envelope exceeds ${MAX_ENVELOPE_BYTES} byte limit (${envelopeBytes} bytes)`);
  }

  #stateRecord(
    messageId: string,
    state: MailboxState,
    previousState: MailboxState | null,
    envelopeHash: string,
    options: { claim?: MailboxClaim; reason?: string } = {},
  ): MailboxStateRecord {
    return {
      recordVersion: MAILBOX_STATE_RECORD_VERSION,
      messageId,
      state,
      transitionedAt: this.#now(),
      previousState,
      envelopeHash,
      ...(options.claim === undefined ? {} : { claim: options.claim }),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    };
  }

  async #transition(
    messageId: string,
    fromState: MailboxState,
    toState: MailboxState,
    options: {
      claim?: MailboxClaim;
      reason?: string;
      expectedClaim?: MailboxClaim;
      expectedOwner?: MailboxOwnerFence;
      allowTakeover?: boolean;
      mutationAuthority?: MailboxMutationAuthority;
    } = {},
  ): Promise<boolean> {
    if (!MESSAGE_ID_PATTERN.test(messageId)) return false;
    return this.#withMessageLock(messageId, async () => {
      if (options.mutationAuthority && !await mutationAuthorityAllows(options.mutationAuthority)) return false;
      await this.#recoverTransitionLocked(messageId);
      const envelope = await this.readEnvelope(fromState, messageId);
      const sourceRecord = await this.readStateRecord(fromState, messageId);
      const unreadable = !envelope && toState === "dead" && await directoryEntryExists(envelopePath(this.paths, fromState, messageId));
      if (!envelope && !unreadable) return false;
      const envelopeHash = envelope?.hash ?? sourceRecord?.envelopeHash;
      if (!envelopeHash || !HASH_PATTERN.test(envelopeHash)) return false;
      const sourceClaim = sourceRecord?.claim;
      if (options.expectedClaim && (!sourceClaim || !sameClaimOwner(sourceClaim, options.expectedClaim))) return false;
      if (fromState === "claimed" || fromState === "accepted") {
        if (options.expectedOwner) {
          if (!sourceClaim || !fenceMatchesClaim(options.expectedOwner, sourceClaim)) return false;
        } else if (sourceClaim && claimFence(sourceClaim) && !options.allowTakeover && !options.expectedClaim) {
          // Modern owner-bound states never accept an unfenced mutation.
          return false;
        }
        if (options.allowTakeover && sourceClaim
          && (claimFence(sourceClaim) !== undefined || fromState === "claimed")
          && isMailboxClaimOwnerLive(sourceClaim, this.#now())) return false;
      }
      const targetPath = envelopePath(this.paths, toState, messageId);
      if (await pathExists(targetPath)) throw new Error(`mailbox transition destination conflict: ${toState}/${messageId}`);
      const claim = options.claim ?? ((toState === "claimed" || toState === "accepted") ? sourceClaim : undefined);
      const destinationRecord = this.#stateRecord(messageId, toState, fromState, envelopeHash, {
        claim,
        reason: options.reason,
      });
      if ((toState === "claimed" || toState === "accepted") && !destinationRecord.claim) {
        throw new Error(`mailbox ${toState} transition requires owner metadata: ${messageId}`);
      }
      if (options.mutationAuthority && !await mutationAuthorityAllows(options.mutationAuthority)) return false;
      const marker: MailboxTransitionRecord = {
        recordVersion: MAILBOX_TRANSITION_RECORD_VERSION,
        transitionId: randomUUID(),
        messageId,
        envelopeHash,
        fromState,
        toState,
        preparedAt: this.#now(),
        ...(unreadable ? { unreadable: true as const } : {}),
        destinationRecord,
      };
      await writeExclusiveJson(transitionPath(this.paths, messageId), marker, MAX_TRANSITION_RECORD_BYTES);
      this.#boundary?.("transition-prepared");
      await writeRecoverableJson(stateRecordPath(this.paths, toState, messageId), destinationRecord, MAX_STATE_RECORD_BYTES, this.#boundary);
      this.#boundary?.("transition-metadata");
      await renameWithRetry(envelopePath(this.paths, fromState, messageId), targetPath);
      this.#boundary?.("transition-renamed");
      await fsyncDirectory(this.paths[stateDirKey(fromState)]);
      if (this.paths[stateDirKey(fromState)] !== this.paths[stateDirKey(toState)]) {
        await fsyncDirectory(this.paths[stateDirKey(toState)]);
      }
      this.#boundary?.("transition-directories-synced");
      await removeRecoverableFamily(stateRecordPath(this.paths, fromState, messageId));
      if (fromState === "claimed") await this.#removeClaimLockIfOwned(messageId, sourceClaim);
      this.#boundary?.("transition-source-cleaned");
      await rm(transitionPath(this.paths, messageId), { force: true });
      await fsyncDirectory(this.paths.transitionDir);
      this.#boundary?.("transition-finished");
      return true;
    });
  }

  async #recoverTransitionLocked(messageId: string): Promise<void> {
    const markerValue = await readSafeJson(transitionPath(this.paths, messageId), MAX_TRANSITION_RECORD_BYTES);
    if (markerValue === undefined) return;
    const marker = parseTransitionRecord(markerValue, messageId);
    if (!marker) throw new Error(`invalid mailbox transition journal: ${messageId}`);
    const sourcePath = envelopePath(this.paths, marker.fromState, messageId);
    const targetPath = envelopePath(this.paths, marker.toState, messageId);
    const source = await this.readEnvelope(marker.fromState, messageId);
    const target = await this.readEnvelope(marker.toState, messageId);
    const sourceExists = await directoryEntryExists(sourcePath);
    const targetExists = await directoryEntryExists(targetPath);
    if (!sourceExists && !targetExists) throw new Error(`mailbox transition lost both envelopes: ${messageId}`);
    if (!marker.unreadable) {
      if (sourceExists && !source) throw new Error(`mailbox transition source unreadable: ${messageId}`);
      if (targetExists && !target) throw new Error(`mailbox transition destination unreadable: ${messageId}`);
      if (source && source.hash !== marker.envelopeHash) throw new Error(`mailbox transition source hash conflict: ${messageId}`);
      if (target && target.hash !== marker.envelopeHash) throw new Error(`mailbox transition destination hash conflict: ${messageId}`);
    }
    const targetRecordValue = await readRecoverableJson(stateRecordPath(this.paths, marker.toState, messageId), MAX_STATE_RECORD_BYTES);
    const targetRecord = targetRecordValue === undefined
      ? undefined
      : parseStateRecord(targetRecordValue, marker.toState, messageId);
    const targetRecordMatches = targetRecord?.envelopeHash === marker.envelopeHash
      && JSON.stringify(canonicalValue(targetRecord)) === JSON.stringify(canonicalValue(marker.destinationRecord));
    if (!targetRecordMatches) {
      if (targetExists) throw new Error(`mailbox transition metadata conflict: ${messageId}`);
      // A stale destination record is not a live envelope. The durable marker
      // selects the prepared new metadata and recoverably replaces the stale
      // record before the sole source envelope moves.
      await writeRecoverableJson(
        stateRecordPath(this.paths, marker.toState, messageId),
        marker.destinationRecord,
        MAX_STATE_RECORD_BYTES,
        this.#boundary,
      );
    }
    if (sourceExists && !targetExists) {
      await renameWithRetry(sourcePath, targetPath);
      await fsyncDirectory(this.paths[stateDirKey(marker.fromState)]);
      if (this.paths[stateDirKey(marker.fromState)] !== this.paths[stateDirKey(marker.toState)]) {
        await fsyncDirectory(this.paths[stateDirKey(marker.toState)]);
      }
    } else if (sourceExists && targetExists) {
      // A filesystem may expose both names after a crash. Target is fully
      // validated before the redundant source entry is removed.
      await rm(sourcePath, { force: true });
      await fsyncDirectory(this.paths[stateDirKey(marker.fromState)]);
    }
    await removeRecoverableFamily(stateRecordPath(this.paths, marker.fromState, messageId));
    if (marker.fromState === "claimed") await this.#removeClaimLockIfOwned(messageId, undefined);
    await rm(transitionPath(this.paths, messageId), { force: true });
    await fsyncDirectory(this.paths.transitionDir);
  }

  async #reconcileDedupRecord(path: string, record: MailboxDedupRecord): Promise<void> {
    const located = await this.#locateEnvelope(record.messageId);
    if (located.length > 1) throw new Error(`mailbox dedup transaction has multiple live envelopes: ${record.messageId}`);
    if (located.length === 1) {
      if (located[0]!.envelope.hash !== record.envelopeHash) throw new Error(`mailbox dedup envelope hash conflict: ${record.messageId}`);
      if (located[0]!.state === "staging") await this.promoteToReady(record.messageId);
    } else if (record.phase === "prepared") {
      try {
        await this.writeStaging(record.envelope);
      } catch (error) {
        const raced = await this.#locateEnvelope(record.messageId);
        if (raced.length !== 1 || raced[0]!.envelope.hash !== record.envelopeHash) throw error;
      }
      if (!await this.promoteToReady(record.messageId)) {
        const promotedByPeer = await this.#locateEnvelope(record.messageId);
        if (promotedByPeer.length !== 1 || promotedByPeer[0]!.envelope.hash !== record.envelopeHash
          || promotedByPeer[0]!.state === "staging") {
          throw new Error(`mailbox dedup recovery could not publish ${record.messageId}`);
        }
      }
    }
    if (record.phase === "prepared") {
      await writeRecoverableJson(path, { ...record, phase: "published" }, MAX_DEDUP_RECORD_BYTES, this.#boundary);
    }
  }

  async #locateEnvelope(messageId: string): Promise<Array<{ state: MailboxState; envelope: MailboxEnvelope }>> {
    const found: Array<{ state: MailboxState; envelope: MailboxEnvelope }> = [];
    for (const state of ["staging", "ready", "claimed", "accepted", "applied", "rejected", "expired", "dead"] as const) {
      const path = envelopePath(this.paths, state, messageId);
      const exists = await lstat(path).then(() => true, (error) => {
        if (fileCode(error) === "ENOENT") return false;
        throw error;
      });
      if (!exists) continue;
      const envelope = await this.readEnvelope(state, messageId);
      if (!envelope) {
        if (!await directoryEntryExists(path)) continue;
        throw new Error(`mailbox messageId collision with unreadable envelope: ${state}/${messageId}`);
      }
      found.push({ state, envelope });
    }
    return found;
  }

  async #recoverDedupTransactions(): Promise<void> {
    const files = (await readdir(this.paths.seenDir)).filter((file) => file.endsWith(".seen")).sort();
    for (const file of files) {
      const path = join(this.paths.seenDir, file);
      const value = await readRecoverableJson(path, MAX_DEDUP_RECORD_BYTES);
      const record = parseDedupRecord(value);
      if (record) {
        if (file !== `${record.requestKeyHash}.seen`) throw new Error(`mailbox dedup filename/hash conflict: ${file}`);
        await this.#reconcileDedupRecord(path, record);
        continue;
      }
      const legacy = parseLegacySeen(value);
      if (!legacy) throw new Error(`invalid mailbox seen/dedup record: ${file}`);
      const matches = await this.#findLegacySeenMatches(legacy.key);
      if (matches.length > 1) throw new Error(`legacy mailbox seen marker conflicts with multiple envelopes: ${file}`);
      if (matches.length === 0) {
        await removeRecoverableFamily(path); // orphan marker: allow a safe caller retry.
        continue;
      }
      const envelope = matches[0]!;
      const requestHash = createHash("sha256").update(JSON.stringify(canonicalValue({
        workspaceId: envelope.workspaceId,
        teamId: envelope.teamId,
        senderId: envelope.senderId,
        recipientId: envelope.recipientId,
        recipientCorrelationId: envelope.recipientCorrelationId,
        kind: envelope.kind,
        mode: envelope.mode,
        payload: envelope.payload,
        requestId: envelope.requestId,
        correlationId: envelope.correlationId,
      })), "utf8").digest("hex");
      const migrated: MailboxDedupRecord = {
        recordVersion: MAILBOX_DEDUP_RECORD_VERSION,
        requestKeyHash: file.slice(0, -".seen".length),
        requestHash,
        messageId: envelope.messageId,
        envelopeHash: envelope.hash,
        envelope,
        phase: "published",
        preparedAt: legacy.seenAt,
      };
      await writeRecoverableJson(path, migrated, MAX_DEDUP_RECORD_BYTES, this.#boundary);
    }
  }

  async #findLegacySeenMatches(key: string): Promise<MailboxEnvelope[]> {
    const matches: MailboxEnvelope[] = [];
    for (const state of ["staging", "ready", "claimed", "accepted", "applied", "rejected", "expired", "dead"] as const) {
      for (const messageId of await this.listMessages(state)) {
        const envelope = await this.readEnvelope(state, messageId);
        if (envelope && (envelope.requestId === key || envelope.correlationId === key)) matches.push(envelope);
      }
    }
    return matches;
  }

  async #cleanupDeadTemporaryFiles(limit: number): Promise<void> {
    let remaining = limit;
    for (const dir of [
      this.paths.stagingDir,
      this.paths.readyDir,
      this.paths.claimedDir,
      this.paths.acceptedDir,
      this.paths.appliedDir,
      this.paths.rejectedDir,
      this.paths.expiredDir,
      this.paths.deadDir,
      this.paths.seenDir,
      this.paths.transitionDir,
    ]) {
      if (remaining <= 0) break;
      const names = await readdir(dir);
      let removed = false;
      for (const name of names.sort()) {
        if (remaining <= 0) break;
        const match = /\.(\d+)\.[0-9a-f-]+\.tmp$/.exec(name);
        if (!match) continue;
        remaining -= 1;
        const pid = Number(match[1]);
        if (Number.isSafeInteger(pid) && pid > 0 && pidAlive(pid)) continue;
        await rm(join(dir, name), { force: true });
        removed = true;
      }
      if (removed) await fsyncDirectory(dir);
    }
  }

  async #recoverClaimLocks(): Promise<void> {
    const names = await readdir(this.paths.claimedDir);
    for (const name of names.filter((entry) => entry.endsWith(".claim.lock")).sort()) {
      const messageId = name.slice(0, -".claim.lock".length);
      if (!MESSAGE_ID_PATTERN.test(messageId)) continue;
      const claimed = await this.readEnvelope("claimed", messageId);
      const claim = await readSafeJson(claimLockPath(this.paths, messageId), MAX_LOCK_BYTES);
      if (claimed && validClaim(claim, messageId)) continue;
      if (validClaim(claim, messageId) && isMailboxClaimOwnerLive(claim, this.#now())) continue;
      await rm(claimLockPath(this.paths, messageId), { force: true });
      await fsyncDirectory(this.paths.claimedDir);
    }
  }

  async #removeClaimLockIfOwned(messageId: string, expected: MailboxClaim | undefined): Promise<void> {
    const path = claimLockPath(this.paths, messageId);
    const current = await readSafeJson(path, MAX_LOCK_BYTES);
    if (current === undefined) return;
    if (!validClaim(current, messageId)) {
      if (expected) return;
    } else if (expected && !sameClaimOwner(current, expected)) {
      return;
    }
    await rm(path, { force: true });
    await fsyncDirectory(this.paths.claimedDir);
  }

  async #withMessageLock<TResult>(messageId: string, action: () => Promise<TResult>): Promise<TResult> {
    const path = mutationLockPath(this.paths, messageId);
    const record: MutationLockRecord = {
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      acquiredAt: this.#now(),
      expiresAt: this.#now() + LOCK_LEASE_MS,
    };
    for (let attempt = 0; ; attempt += 1) {
      try {
        await writeExclusiveJson(path, record, MAX_LOCK_BYTES);
        break;
      } catch (error) {
        if (fileCode(error) !== "EEXIST") throw error;
        const current = await readSafeJson(path, MAX_LOCK_BYTES) as Partial<MutationLockRecord> | undefined;
        const stale = !current || current.version !== 1 || typeof current.token !== "string"
          || !validInteger(current.pid) || !validInteger(current.expiresAt)
          // Never steal from a live process merely because a slow fsync crossed
          // a wall-clock deadline. A dead pid is the durable takeover fence.
          || !pidAlive(current.pid);
        if (stale) {
          const reread = await readSafeJson(path, MAX_LOCK_BYTES) as Partial<MutationLockRecord> | undefined;
          if (JSON.stringify(reread) === JSON.stringify(current)) {
            await rm(path, { force: true });
            await fsyncDirectory(this.paths.transitionDir);
          }
          continue;
        }
        if (attempt >= LOCK_MAX_ATTEMPTS) throw new Error(`mailbox mutation lock timeout: ${messageId}`);
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
      }
    }
    try {
      return await action();
    } finally {
      const current = await readSafeJson(path, MAX_LOCK_BYTES) as Partial<MutationLockRecord> | undefined;
      if (current?.token === record.token) {
        await rm(path, { force: true }).catch(() => undefined);
        await fsyncDirectory(this.paths.transitionDir).catch(() => undefined);
      }
    }
  }
}

function sameClaimOwner(left: MailboxClaim, right: MailboxClaim): boolean {
  const leftFence = claimFence(left);
  const rightFence = claimFence(right);
  if (leftFence && rightFence) return ownerFenceKey(leftFence) === ownerFenceKey(rightFence);
  return left.claimerNonce === right.claimerNonce;
}

function parseLegacySeen(value: unknown): { key: string; seenAt: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { key?: unknown; seenAt?: unknown };
  return typeof record.key === "string" && validInteger(record.seenAt)
    ? { key: record.key, seenAt: record.seenAt }
    : undefined;
}
