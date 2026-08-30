import {
  constants as fsConstants,
  lstatSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  computeCompletionDeliveryId,
  type CompletionDispatchSeed,
  type CompletionIntent,
  type CompletionTarget,
} from "../public/v1/completion-durability.ts";
import {
  COMPLETION_OUTBOX_APPLIED_TTL_MS,
  COMPLETION_OUTBOX_CLAIM_MS,
  COMPLETION_OUTBOX_LIVE_TTL_MS,
  COMPLETION_OUTBOX_MAX_ATTEMPTS,
  COMPLETION_OUTBOX_MAX_ERROR_BYTES,
  COMPLETION_OUTBOX_MAX_LIVE_BYTES,
  COMPLETION_OUTBOX_MAX_LIVE_RECORDS,
  COMPLETION_OUTBOX_MAX_RECORD_BYTES,
  COMPLETION_OUTBOX_MAX_RESOURCES,
  COMPLETION_OUTBOX_MAX_SUMMARY_BYTES,
  COMPLETION_OUTBOX_RESERVATION_TERMINAL_TTL_MS,
  COMPLETION_OUTBOX_SCHEMA_VERSION,
  COMPLETION_OUTBOX_TERMINAL_TTL_MS,
  type CompletionOutboxGcResult,
  type CompletionOutboxRecord,
  type CompletionOutboxState,
  type CompletionOutboxTryGcResult,
  type CompletionOutboxUsage,
  type CompletionReservationRecord,
  retryDelayForAttempt,
} from "./types.ts";
import { logDiagnosticWarn } from "../shared/diagnostic-log.ts";

const STATE_DIRS: readonly CompletionOutboxState[] = ["wal", "pending", "queued", "applied", "dead", "expired"];
const LIVE_STATES = new Set<CompletionOutboxState>(["wal", "pending", "queued"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HASH_ID = /^[a-f0-9]{64}$/;
const LOCK_STALE_MS = 2 * 60_000;
// A crash at lock:after-create leaves a zero-byte inode with no PID/token to
// probe. Only that exact setup shape is reclaimed on the short setup deadline;
// an invalid non-empty record may be a concurrent fixed-width lease rewrite.
const LOCK_SETUP_STALE_MS = 1_000;
const WORKSPACE_LOCK_RECORD_BYTES = 4096;
const LOCK_HEARTBEAT_MS = 10_000;
// Raised from 15s to 45s: a full workspace GC scans every session × state dir
// under the lock, which can hold the workspace lock long enough on slow disks
// (Windows + antivirus) to starve concurrent writers past 15s. The lock is still
// released after the critical section and stale locks are reclaimed after
// LOCK_STALE_MS, so a longer wait only widens the transient-contention window
// without risking a stuck holder. See #withWorkspaceLock.
const LOCK_WAIT_MS = 45_000;
const LOCK_RETRY_MS = 25;
const RENAME_MAX_RETRIES = 5;
// Throttle the *implicit* GC run inside reserve() so a high write rate does not
// repeatedly take the workspace lock for a full scan on every reservation. A
// reserve() capacity check only needs recently-accurate usage; an explicit
// store.gc() call always runs a full GC regardless of this interval.
const RESERVE_GC_MIN_INTERVAL_MS = 30_000;
// Cross-process GC marker: tryGc() writes this after a sweep so concurrent Pi
// processes sharing the same outbox directory can skip a redundant sweep within
// the gap. A process-local throttle (like #lastReconcileGcAt) is invisible to
// other processes; this marker is the cross-process equivalent. Short on purpose
// so a crashed GC still lets the next process re-sweep soon.
const TRY_GC_MARKER_MIN_INTERVAL_MS = 30_000;
const GC_MARKER_NAME = ".gc-marker";
const GC_INDEX_DIR = ".gc-index";
const GC_INDEX_STATE_NAME = "state.json";
const GC_INDEX_LATEST_DIR = "latest";
const GC_INDEX_SEGMENT_SIZE = 128;
const GC_SCAN_MAX_ENTRIES = 4_096;
const GC_LOCK_BUDGET_MS = 500;
const REPLACE_ERRORS = new Set(["EPERM", "EACCES", "EEXIST"]);
const ORDERED_REPLACEMENT_PATTERN = /^(.+)\.replace-(\d{20})-([A-Za-z0-9-]+)\.(new|committed|bak)$/;
const LEGACY_REPLACEMENT_PATTERN = /^(.+)\.replace-([A-Za-z0-9-]+)\.(new|committed|bak)$/;
const REPLACEMENT_TRANSACTION = /^\d{20}-[A-Za-z0-9-]{1,128}$/;
const WORKSPACE_GENERATION = /^\d{20}$/;
const FENCED_JSON_OVERHEAD_BYTES = 1024;
const ACTIVE_WORKSPACE_LOCK_TOKENS = new Set<string>();

interface WorkspaceLockMutation {
  version: 1;
  path: string;
  transaction: string;
}

interface WorkspaceLockRecord {
  version?: 2;
  ownerId: string;
  token: string;
  pid: number;
  heartbeatAt: number;
  generation?: string;
  mutation?: WorkspaceLockMutation;
}

interface WorkspaceLockLease {
  path: string;
  token: string;
  generation: string;
  assertOwned(): Promise<void>;
  assertOwnedSync(): void;
  beginMutation(path: string, transaction: string): Promise<void>;
  finishMutation(transaction: string): Promise<void>;
}

async function overwriteWorkspaceLockRecord(handle: FileHandle, record: WorkspaceLockRecord): Promise<void> {
  const encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (encoded.byteLength > WORKSPACE_LOCK_RECORD_BYTES) {
    throw new Error("Completion outbox lock record exceeds its fixed-width slot.");
  }
  const payload = Buffer.alloc(WORKSPACE_LOCK_RECORD_BYTES, 0x20);
  encoded.copy(payload);
  let offset = 0;
  while (offset < payload.byteLength) {
    const { bytesWritten } = await handle.write(payload, offset, payload.byteLength - offset, offset);
    if (bytesWritten <= 0) throw new Error("Completion outbox lock record write made no progress.");
    offset += bytesWritten;
  }
}

interface GcIndexEntry {
  path: string;
  kind: "record" | "reservation";
}

interface GcIndexLatest extends GcIndexEntry {
  version: 1;
  sequence: number;
}

interface GcIndexState {
  version: 1;
  head: number;
  tail: number;
  sweepEnd?: number;
}

interface GcIndexSegment {
  version: 1;
  base: number;
  entries: Array<GcIndexEntry | null>;
}

interface ReplacementName {
  name: string;
  canonical: string;
  transaction: string;
  generation?: string;
  kind: "new" | "committed" | "bak";
}

interface FencedJsonEnvelope {
  $completionOutbox: {
    version: 2;
    generation: string;
    transaction: string;
  };
  value: unknown;
}

interface WorkspaceGenerationSlot {
  version: 1;
  generation: bigint;
  token: string;
}

interface StoreOptions {
  rootDir?: string;
  now?: () => number;
  ownerId?: string;
  maxLiveRecords?: number;
  maxLiveBytes?: number;
}

export interface CompletionOutboxCleanupOptions {
  apply?: boolean;
  maxEntries?: number;
}

export interface CompletionOutboxCleanupResult {
  apply: boolean;
  busy: boolean;
  scannedEntries: number;
  scannedFiles: number;
  replacementFiles: number;
  preservedFiles: number;
  candidateFiles: number;
  candidateBytes: number;
  removedFiles: number;
  removedBytes: number;
  candidateSample: string[];
}

interface CleanupDirectoryIdentity {
  path: string;
  dev: number | bigint;
  ino: number | bigint;
}

interface ReplacementCleanupCandidate {
  path: string;
  relativePath: string;
  dir: string;
  name: string;
  transaction: string;
  ancestors: CleanupDirectoryIdentity[];
  dev: number | bigint;
  ino: number | bigint;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

const DEFAULT_CLEANUP_MAX_ENTRIES = 100_000;
const CLEANUP_SAMPLE_SIZE = 20;

function fileCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function parseWorkspaceLockRecord(raw: string): WorkspaceLockRecord | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceLockRecord>;
    const validLegacy = parsed.version === undefined
      && parsed.generation === undefined && parsed.mutation === undefined;
    const validMutation = parsed.mutation === undefined || Boolean(
      parsed.mutation.version === 1
      && boundedString(parsed.mutation.path, 4096)
      && REPLACEMENT_TRANSACTION.test(parsed.mutation.transaction),
    );
    const validV2 = parsed.version === 2 && typeof parsed.generation === "string"
      && WORKSPACE_GENERATION.test(parsed.generation) && validMutation;
    if ((validLegacy || validV2)
      && boundedString(parsed.ownerId, 512)
      && boundedString(parsed.token, 128)
      && Number.isSafeInteger(parsed.pid) && parsed.pid! > 0
      && Number.isSafeInteger(parsed.heartbeatAt) && parsed.heartbeatAt! >= 0) {
      return parsed as WorkspaceLockRecord;
    }
  } catch {
    // Invalid or partially written records are contention, never authority.
  }
  return undefined;
}

function persistenceBoundary(scope: "outbox" | "lock", boundary: string): void {
  const expected = `${scope}:${boundary}`;
  if (process.env.PI_TEST_COMPLETION_FAIL_AT !== expected) return;
  delete process.env.PI_TEST_COMPLETION_FAIL_AT;
  if (process.env.PI_TEST_COMPLETION_CRASH === "1") process.exit(86);
  throw Object.assign(new Error(`Injected completion persistence failure at ${expected}`), { code: "EIO" });
}

function hashPath(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validTarget(target: unknown): target is CompletionTarget {
  if (!target || typeof target !== "object") return false;
  const value = target as Partial<CompletionTarget>;
  return boundedString(value.workspaceId, 128)
    && boundedString(value.sessionId, 256)
    && (value.correlationId === undefined || boundedString(value.correlationId, 128));
}

function targetEquals(left: CompletionTarget, right: CompletionTarget): boolean {
  return left.workspaceId === right.workspaceId
    && left.sessionId === right.sessionId
    && left.correlationId === right.correlationId;
}

function recordSemantic(record: Omit<CompletionOutboxRecord, "contentRevision">): unknown {
  // Stable delivery-content revision used by model-consumption receipts. Mutable
  // delivery state is intentionally excluded: pending -> queued must not make
  // the envelope's receipt token stale before message_end can acknowledge it.
  return {
    version: record.version,
    deliveryId: record.deliveryId,
    dispatchId: record.dispatchId,
    reservationId: record.reservationId,
    kind: record.kind,
    target: record.target,
    replyTarget: record.replyTarget,
    summary: record.summary,
    resources: record.resources,
    outcome: record.outcome,
    createdAt: record.createdAt,
    intentRevision: record.intentRevision,
  };
}

export function computeCompletionContentRevision(
  record: Omit<CompletionOutboxRecord, "contentRevision">,
): string {
  return createHash("sha256").update(JSON.stringify(recordSemantic(record)), "utf8").digest("hex");
}

/** Crash remnants can leave one deliveryId in several state dirs; prefer the
 * newest record, and on equal timestamps the most advanced lifecycle state,
 * so a stale pending copy never overrides an accepted queued/applied one. */
function completionRecordPrecedes(candidate: CompletionOutboxRecord, incumbent: CompletionOutboxRecord): boolean {
  if (candidate.updatedAt !== incumbent.updatedAt) return candidate.updatedAt > incumbent.updatedAt;
  const candidateState = STATE_DIRS.indexOf(candidate.state);
  const incumbentState = STATE_DIRS.indexOf(incumbent.state);
  if (candidateState !== incumbentState) return candidateState > incumbentState;
  return false;
}

function validRecord(value: unknown): value is CompletionOutboxRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CompletionOutboxRecord>;
  if (record.version !== COMPLETION_OUTBOX_SCHEMA_VERSION
    || typeof record.deliveryId !== "string" || !HASH_ID.test(record.deliveryId)
    || typeof record.dispatchId !== "string" || !SAFE_ID.test(record.dispatchId)
    || typeof record.reservationId !== "string" || !SAFE_ID.test(record.reservationId)
    || !["single", "graph", "additional", "failure"].includes(String(record.kind))
    || !validTarget(record.target)
    || (record.replyTarget !== "main" && record.replyTarget !== "caller")
    || typeof record.summary !== "string" || Buffer.byteLength(record.summary, "utf8") > COMPLETION_OUTBOX_MAX_SUMMARY_BYTES
    || !Array.isArray(record.resources) || record.resources.length > COMPLETION_OUTBOX_MAX_RESOURCES
    || !["completed", "failed", "terminated"].includes(String(record.outcome))
    || !STATE_DIRS.includes(record.state as CompletionOutboxState)
    || !Number.isSafeInteger(record.attempts) || record.attempts! < 0 || record.attempts! > COMPLETION_OUTBOX_MAX_ATTEMPTS
    || !Number.isSafeInteger(record.nextAttemptAt) || record.nextAttemptAt! < 0
    || !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.updatedAt)
    || !Number.isSafeInteger(record.expiresAt) || record.updatedAt! < record.createdAt! || record.expiresAt! < record.createdAt!
    || (record.lastError !== undefined && (typeof record.lastError !== "string" || Buffer.byteLength(record.lastError, "utf8") > COMPLETION_OUTBOX_MAX_ERROR_BYTES))
    || (record.intentRevision !== undefined && (typeof record.intentRevision !== "string" || !HASH_ID.test(record.intentRevision)))
    || typeof record.contentRevision !== "string" || !HASH_ID.test(record.contentRevision)) return false;
  for (const resource of record.resources) {
    if (!resource || typeof resource !== "object"
      || !boundedString(resource.correlationId, 128)
      || !boundedString(resource.publicationId, 128)
      || resource.uri !== `agent://${resource.publicationId}`
      // Legacy v1 records written before originCwd existed must stay readable;
      // new writes always carry it.
      || (resource.originCwd !== undefined && !boundedString(resource.originCwd, 4096))
      || typeof resource.summary !== "string"
      || Buffer.byteLength(resource.summary, "utf8") > COMPLETION_OUTBOX_MAX_SUMMARY_BYTES) return false;
  }
  const { contentRevision: _contentRevision, ...withoutRevision } = record as CompletionOutboxRecord;
  return computeCompletionContentRevision(withoutRevision) === record.contentRevision;
}

function validReservation(value: unknown): value is CompletionReservationRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CompletionReservationRecord>;
  return record.version === COMPLETION_OUTBOX_SCHEMA_VERSION
    && typeof record.reservationId === "string" && SAFE_ID.test(record.reservationId)
    && typeof record.dispatchId === "string" && SAFE_ID.test(record.dispatchId)
    && validTarget(record.target)
    && Number.isSafeInteger(record.reservedBytes) && record.reservedBytes! > 0 && record.reservedBytes! <= COMPLETION_OUTBOX_MAX_RECORD_BYTES
    && ["reserved", "consumed", "released"].includes(String(record.state))
    && Number.isSafeInteger(record.createdAt) && Number.isSafeInteger(record.updatedAt)
    && Number.isSafeInteger(record.expiresAt) && record.updatedAt! >= record.createdAt!;
}

async function ensureRealDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Completion outbox directory must be a real directory: ${path}`);
}

async function fsyncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!new Set(["EPERM", "EINVAL", "ENOSYS", "EBADF"]).has(fileCode(error) ?? "")) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = fileCode(error);
      if (REPLACE_ERRORS.has(code ?? "") && attempt < RENAME_MAX_RETRIES) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

function parseReplacementName(name: string): ReplacementName | undefined {
  const ordered = ORDERED_REPLACEMENT_PATTERN.exec(name);
  if (ordered?.[1] && ordered[2] && ordered[3] && ordered[4]) {
    return {
      name,
      canonical: ordered[1],
      transaction: `${ordered[2]}-${ordered[3]}`,
      generation: ordered[2],
      kind: ordered[4] as "new" | "committed" | "bak",
    };
  }
  const legacy = LEGACY_REPLACEMENT_PATTERN.exec(name);
  if (!legacy?.[1] || !legacy[2] || !legacy[3]) return undefined;
  return {
    name,
    canonical: legacy[1],
    transaction: legacy[2],
    kind: legacy[3] as "new" | "committed" | "bak",
  };
}

function canonicalJsonNames(names: readonly string[]): string[] {
  const found = new Set<string>();
  for (const name of names) {
    if (name.endsWith(".json")) found.add(name);
    else {
      const replacement = parseReplacementName(name);
      if (replacement) found.add(replacement.canonical);
    }
  }
  return [...found].sort();
}

function workspaceGenerationSlot(workspaceDir: string, slot: "a" | "b"): string {
  return join(workspaceDir, `.store-generation-${slot}`);
}

async function readWorkspaceGenerationSlot(
  workspaceDir: string,
  slot: "a" | "b",
): Promise<WorkspaceGenerationSlot | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      workspaceGenerationSlot(workspaceDir, slot),
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const info = await handle.stat();
    if (!info.isFile() || info.size > 256) return undefined;
    const parsed = JSON.parse(await handle.readFile("utf8")) as {
      version?: unknown;
      generation?: unknown;
      token?: unknown;
    };
    if (parsed.version !== 1 || typeof parsed.generation !== "string"
      || !WORKSPACE_GENERATION.test(parsed.generation)
      || typeof parsed.token !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(parsed.token)) return undefined;
    return { version: 1, generation: BigInt(parsed.generation), token: parsed.token };
  } catch (error) {
    if (fileCode(error) === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function nextWorkspaceGeneration(workspaceDir: string, token: string): Promise<string> {
  const [a, b] = await Promise.all([
    readWorkspaceGenerationSlot(workspaceDir, "a"),
    readWorkspaceGenerationSlot(workspaceDir, "b"),
  ]);
  const latest = a === undefined ? b : b === undefined ? a
    : a.generation >= b.generation ? a : b;
  const generationValue = (latest?.generation ?? 0n) + 1n;
  if (generationValue > 99_999_999_999_999_999_999n) {
    throw new Error(`Completion workspace generation exhausted: ${workspaceDir}.`);
  }
  const generation = generationValue.toString().padStart(20, "0");
  const slot: "a" | "b" = a === undefined || a.generation <= (b?.generation ?? -1n) ? "a" : "b";
  const slotPath = workspaceGenerationSlot(workspaceDir, slot);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      slotPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    if (!(await handle.stat()).isFile()) throw new Error(`Workspace generation marker must be a regular file: ${slotPath}`);
    await handle.writeFile(`${JSON.stringify({ version: 1, generation, token })}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await fsyncDirectory(workspaceDir);
  return generation;
}

function resolveLockMutationPath(
  workspaceDir: string,
  mutation: WorkspaceLockMutation,
): string | undefined {
  const path = resolve(workspaceDir, mutation.path);
  const contained = relative(workspaceDir, path);
  if (!contained || contained.startsWith("..") || resolve(path) !== path) return undefined;
  return path;
}

function mutationRevocationPath(path: string, transaction: string): string {
  return `${path}.replace-revoked-${transaction}`;
}

async function writeMutationRevocation(
  path: string,
  generation: string,
  transaction: string,
): Promise<boolean> {
  const revocation = mutationRevocationPath(path, transaction);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      revocation,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    if (!(await handle.stat()).isFile()) throw new Error(`Completion mutation fence must be a regular file: ${revocation}`);
    await handle.writeFile(`${JSON.stringify({ version: 1, generation, transaction })}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (fileCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await fsyncDirectory(dirname(path));
  return true;
}

async function rollbackMutationRevocation(path: string, transaction: string, created: boolean): Promise<void> {
  if (!created) return;
  await rm(mutationRevocationPath(path, transaction), { force: true });
  await fsyncDirectory(dirname(path));
}

async function mutationIsRevoked(path: string, transaction: string): Promise<boolean> {
  try {
    await lstat(mutationRevocationPath(path, transaction));
    // Fail closed for an exact, durable transaction fence, even if a crash left
    // its small payload incomplete. The unguessable transaction name is itself
    // the authority; the payload is diagnostic/versioning metadata.
    return true;
  } catch (error) {
    if (fileCode(error) === "ENOENT") return false;
    throw error;
  }
}

function fencedJsonEnvelope(value: unknown, lease: WorkspaceLockLease, transaction: string): FencedJsonEnvelope {
  return {
    $completionOutbox: {
      version: 2,
      generation: lease.generation,
      transaction,
    },
    value,
  };
}

async function unwrapFencedJson(value: unknown, path: string): Promise<unknown | undefined> {
  if (!value || typeof value !== "object" || !("$completionOutbox" in value)) return value;
  const envelope = value as Partial<FencedJsonEnvelope>;
  const fence = envelope.$completionOutbox;
  if (!fence || fence.version !== 2 || !WORKSPACE_GENERATION.test(fence.generation)
    || !REPLACEMENT_TRANSACTION.test(fence.transaction) || !("value" in envelope)) return undefined;
  if (await mutationIsRevoked(path, fence.transaction)) return undefined;
  return envelope.value;
}

function replacementGenerationSlot(path: string, slot: "a" | "b"): string {
  return `${path}.replace-generation-${slot}`;
}

interface ReplacementGenerationSlot {
  generation: bigint;
  clean: boolean;
  /** Exact replacement transaction for bounded recovery without readdir. */
  transaction?: string;
}

async function readReplacementGenerationSlot(path: string, slot: "a" | "b"): Promise<ReplacementGenerationSlot | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      replacementGenerationSlot(path, slot),
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const info = await handle.stat();
    if (!info.isFile() || info.size > 256) return undefined;
    const parsed = JSON.parse(await handle.readFile("utf8")) as {
      generation?: unknown;
      clean?: unknown;
      transaction?: unknown;
    };
    if (typeof parsed.generation !== "string" || !WORKSPACE_GENERATION.test(parsed.generation)
      || typeof parsed.clean !== "boolean"
      || parsed.transaction !== undefined && (typeof parsed.transaction !== "string"
        || !REPLACEMENT_TRANSACTION.test(parsed.transaction))) return undefined;
    return {
      generation: BigInt(parsed.generation),
      clean: parsed.clean,
      ...(typeof parsed.transaction === "string" ? { transaction: parsed.transaction } : {}),
    };
  } catch (error) {
    if (fileCode(error) === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function latestReplacementGeneration(
  a: ReplacementGenerationSlot | undefined,
  b: ReplacementGenerationSlot | undefined,
): ReplacementGenerationSlot | undefined {
  return a === undefined ? b : b === undefined ? a
    : a.generation > b.generation ? a
      : b.generation > a.generation ? b
        : a.clean ? a : b;
}

async function writeReplacementGenerationSlot(
  path: string,
  slot: "a" | "b",
  generation: string,
  clean: boolean,
  transaction?: string,
): Promise<void> {
  const slotPath = replacementGenerationSlot(path, slot);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      slotPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    if (!(await handle.stat()).isFile()) throw new Error(`Replacement generation marker must be a regular file: ${slotPath}`);
    await handle.writeFile(`${JSON.stringify({ generation, clean, ...(transaction ? { transaction } : {}) })}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await fsyncDirectory(dirname(path));
}

async function nextReplacementGeneration(path: string): Promise<{
  generation: string;
  transaction: string;
  cleanSlot: "a" | "b";
}> {
  const [a, b] = await Promise.all([
    readReplacementGenerationSlot(path, "a"),
    readReplacementGenerationSlot(path, "b"),
  ]);
  const latest = latestReplacementGeneration(a, b);
  const nextValue = (latest?.generation ?? 0n) + 1n;
  if (nextValue > 99_999_999_999_999_999_999n) {
    throw new Error(`Completion replacement generation exhausted: ${path}.`);
  }
  const next = nextValue.toString().padStart(20, "0");
  const transaction = `${next}-${randomUUID()}`;
  const slot: "a" | "b" = a === undefined || a.generation <= (b?.generation ?? -1n) ? "a" : "b";
  await writeReplacementGenerationSlot(path, slot, next, false, transaction);
  return { generation: next, transaction, cleanSlot: slot === "a" ? "b" : "a" };
}

async function replacementRemnantsForCleanup(
  path: string,
  preserveTransaction: string,
): Promise<string[]> {
  const dir = dirname(path);
  const canonical = basename(path);
  const names = await readdir(dir).catch((error) => {
    if (fileCode(error) === "ENOENT") return [] as string[];
    throw error;
  });
  return names.flatMap((name) => {
    const replacement = parseReplacementName(name);
    if (replacement?.canonical !== canonical
      || replacement.transaction === preserveTransaction && replacement.kind === "committed") return [];
    return [join(dir, name)];
  });
}

async function cleanupReplacementRemnants(paths: readonly string[], dir: string): Promise<void> {
  // Paths are captured while the mutation still owns the lock. Once its active
  // transaction is durably cleared, deleting only this immutable snapshot is
  // safe even if takeover happens: a successor's newer names cannot be swept.
  for (const path of paths) await rm(path, { force: true });
  await fsyncDirectory(dir);
}

async function latestReplacementNames(
  dir: string,
  canonical: string,
  names: readonly string[],
): Promise<string[]> {
  const replacements = names
    .map(parseReplacementName)
    .filter((entry): entry is ReplacementName => entry?.canonical === canonical);
  if (replacements.length === 0) return [];
  const ordered = replacements.filter((entry) => entry.generation !== undefined);
  if (ordered.length > 0) {
    const latestGeneration = ordered.map((entry) => entry.generation!).sort().at(-1)!;
    return ordered
      .filter((entry) => entry.generation === latestGeneration)
      .sort((left, right) => {
        const order = { new: 0, committed: 1, bak: 2 } as const;
        return order[left.kind] - order[right.kind] || left.name.localeCompare(right.name);
      })
      .map((entry) => entry.name);
  }
  const transactions = new Map<string, { names: ReplacementName[]; newest: number }>();
  for (const entry of replacements) {
    const mtimeMs = (await lstat(join(dir, entry.name)).catch(() => undefined))?.mtimeMs ?? 0;
    const transaction = transactions.get(entry.transaction) ?? { names: [], newest: 0 };
    transaction.names.push(entry);
    transaction.newest = Math.max(transaction.newest, mtimeMs);
    transactions.set(entry.transaction, transaction);
  }
  const latest = [...transactions.values()].sort((left, right) => right.newest - left.newest)[0];
  return (latest?.names ?? [])
    .sort((left, right) => {
      const order = { new: 0, committed: 1, bak: 2 } as const;
      return order[left.kind] - order[right.kind] || left.name.localeCompare(right.name);
    })
    .map((entry) => entry.name);
}

function emptyCleanupResult(apply: boolean, busy = false): CompletionOutboxCleanupResult {
  return {
    apply,
    busy,
    scannedEntries: 0,
    scannedFiles: 0,
    replacementFiles: 0,
    preservedFiles: 0,
    candidateFiles: 0,
    candidateBytes: 0,
    removedFiles: 0,
    removedBytes: 0,
    candidateSample: [],
  };
}

async function readWorkspaceGenerationFence(workspaceDir: string): Promise<string> {
  const snapshots = await Promise.all((["a", "b"] as const).map(async (slot) => {
    const path = workspaceGenerationSlot(workspaceDir, slot);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1_024) {
        return `${slot}:invalid:${String(info.dev)}:${String(info.ino)}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      }
      const raw = await readFile(path, "utf8");
      return `${slot}:file:${String(info.dev)}:${String(info.ino)}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${raw}`;
    } catch (error) {
      if (fileCode(error) === "ENOENT") return `${slot}:missing`;
      throw error;
    }
  }));
  return snapshots.join("\0");
}

async function validateCleanupDirectories(
  identities: readonly CleanupDirectoryIdentity[],
  relativePath: string,
): Promise<void> {
  for (const identity of identities) {
    const current = await lstat(identity.path).catch((error) => {
      if (fileCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (!current || !current.isDirectory() || current.isSymbolicLink()
      || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error(`Completion outbox cleanup directory changed during scan: ${relativePath}.`);
    }
  }
}

async function validateCleanupCandidate(candidate: ReplacementCleanupCandidate): Promise<void> {
  await validateCleanupDirectories(candidate.ancestors, candidate.relativePath);
  const current = await lstat(candidate.path).catch((error) => {
    if (fileCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (!current || !current.isFile() || current.isSymbolicLink()
    || current.dev !== candidate.dev || current.ino !== candidate.ino
    || current.size !== candidate.size || current.mtimeMs !== candidate.mtimeMs
    || current.ctimeMs !== candidate.ctimeMs) {
    throw new Error(`Completion outbox cleanup candidate changed during scan: ${candidate.relativePath}.`);
  }
  await validateCleanupDirectories(candidate.ancestors, candidate.relativePath);
}

function validateCleanupCandidateSync(candidate: ReplacementCleanupCandidate): void {
  for (const identity of candidate.ancestors) {
    let current: ReturnType<typeof lstatSync> | undefined;
    try {
      current = lstatSync(identity.path);
    } catch (error) {
      if (fileCode(error) !== "ENOENT") throw error;
    }
    if (!current || !current.isDirectory() || current.isSymbolicLink()
      || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error(`Completion outbox cleanup directory changed during scan: ${candidate.relativePath}.`);
    }
  }
  let current: ReturnType<typeof lstatSync> | undefined;
  try {
    current = lstatSync(candidate.path);
  } catch (error) {
    if (fileCode(error) !== "ENOENT") throw error;
  }
  if (!current || !current.isFile() || current.isSymbolicLink()
    || current.dev !== candidate.dev || current.ino !== candidate.ino
    || current.size !== candidate.size || current.mtimeMs !== candidate.mtimeMs
    || current.ctimeMs !== candidate.ctimeMs) {
    throw new Error(`Completion outbox cleanup candidate changed during scan: ${candidate.relativePath}.`);
  }
}

async function scanReplacementRemnants(
  workspaceDir: string,
  maxEntries: number,
): Promise<{ result: CompletionOutboxCleanupResult; candidates: ReplacementCleanupCandidate[] }> {
  const groups = new Map<string, {
    dir: string;
    canonical: string;
    entries: ReplacementCleanupCandidate[];
  }>();
  const result = emptyCleanupResult(false);
  const pendingDirs: Array<{ path: string; ancestors: CleanupDirectoryIdentity[] }> = [{
    path: workspaceDir,
    ancestors: [],
  }];

  while (pendingDirs.length > 0) {
    const pending = pendingDirs.pop()!;
    await validateCleanupDirectories(pending.ancestors, relative(workspaceDir, pending.path) || ".");
    const dirInfo = await lstat(pending.path).catch((error) => {
      if (fileCode(error) === "ENOENT" && pending.path === workspaceDir) return undefined;
      throw error;
    });
    if (!dirInfo) break;
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
      throw new Error(`Completion outbox cleanup directory must be real: ${pending.path}.`);
    }
    const dirIdentity: CleanupDirectoryIdentity = {
      path: pending.path,
      dev: dirInfo.dev,
      ino: dirInfo.ino,
    };
    const ancestors = [...pending.ancestors, dirIdentity];
    const entries = await readdir(pending.path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      result.scannedEntries += 1;
      if (result.scannedEntries > maxEntries) {
        throw new Error(`Completion outbox cleanup scan exceeded ${maxEntries} entries.`);
      }
      const path = join(pending.path, entry.name);
      if (entry.isDirectory()) {
        pendingDirs.push({ path, ancestors });
        continue;
      }
      if (!entry.isFile()) continue;
      result.scannedFiles += 1;
      const replacement = parseReplacementName(entry.name);
      if (!replacement) continue;
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      result.replacementFiles += 1;
      const candidate: ReplacementCleanupCandidate = {
        path,
        relativePath: relative(workspaceDir, path),
        dir: pending.path,
        name: entry.name,
        transaction: replacement.transaction,
        ancestors,
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
      };
      const key = `${pending.path}\0${replacement.canonical}`;
      const group = groups.get(key) ?? { dir: pending.path, canonical: replacement.canonical, entries: [] };
      group.entries.push(candidate);
      groups.set(key, group);
    }
  }

  const candidates: ReplacementCleanupCandidate[] = [];
  for (const group of groups.values()) {
    const canonicalPath = join(group.dir, group.canonical);
    const [a, b] = await Promise.all([
      readReplacementGenerationSlot(canonicalPath, "a"),
      readReplacementGenerationSlot(canonicalPath, "b"),
    ]);
    const latest = latestReplacementGeneration(a, b);
    const preservedTransactions = new Set<string>();
    if (latest?.transaction && group.entries.some((entry) => entry.transaction === latest.transaction)) {
      preservedTransactions.add(latest.transaction);
    }
    const latestNames = await latestReplacementNames(
      group.dir,
      group.canonical,
      group.entries.map((entry) => entry.name),
    );
    for (const name of latestNames) {
      const replacement = parseReplacementName(name);
      if (replacement) preservedTransactions.add(replacement.transaction);
    }
    for (const entry of group.entries) {
      if (preservedTransactions.has(entry.transaction)) result.preservedFiles += 1;
      else candidates.push(entry);
    }
  }

  candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  result.candidateFiles = candidates.length;
  result.candidateBytes = candidates.reduce((total, entry) => total + entry.size, 0);
  result.candidateSample = candidates.slice(0, CLEANUP_SAMPLE_SIZE).map((entry) => entry.relativePath);
  return { result, candidates };
}

async function removeReplacementCandidates(
  candidates: readonly ReplacementCleanupCandidate[],
  lease: WorkspaceLockLease,
): Promise<{ removedFiles: number; removedBytes: number }> {
  await lease.assertOwned();
  for (const candidate of candidates) await validateCleanupCandidate(candidate);

  const syncedDirs = new Set<string>();
  let removedFiles = 0;
  let removedBytes = 0;
  for (const candidate of candidates) {
    await validateCleanupCandidate(candidate);
    await lease.assertOwned();
    // No event-loop yield is permitted between this final authority/path fence
    // and unlink: otherwise a nested directory can be swapped for a junction
    // while the asynchronous lock read is in flight.
    lease.assertOwnedSync();
    validateCleanupCandidateSync(candidate);
    rmSync(candidate.path);
    syncedDirs.add(candidate.dir);
    removedFiles += 1;
    removedBytes += candidate.size;
  }
  for (const dir of [...syncedDirs].sort()) await fsyncDirectory(dir);
  return { removedFiles, removedBytes };
}

function removalTombstonePath(path: string): string {
  return `${path}.removed`;
}

async function clearRemovalTombstone(path: string): Promise<void> {
  await rm(removalTombstonePath(path), { force: true });
  await fsyncDirectory(dirname(path));
}

async function writeRemovalTombstone(path: string): Promise<void> {
  const tombstone = removalTombstonePath(path);
  await ensureRealDirectory(dirname(path));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      tombstone,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    if (!(await handle.stat()).isFile()) throw new Error(`Completion removal tombstone must be a regular file: ${tombstone}`);
    await handle.writeFile("removed\n", "utf8");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await fsyncDirectory(dirname(path));
}

async function removeDurableBounded(path: string, lease?: WorkspaceLockLease): Promise<void> {
  await lease?.assertOwned();
  await writeRemovalTombstone(path);
  await rm(path, { force: true });
  await fsyncDirectory(dirname(path));
}

async function writeJsonAtomic(
  path: string,
  value: unknown,
  maxBytes = COMPLETION_OUTBOX_MAX_RECORD_BYTES,
  lease?: WorkspaceLockLease,
  injectBoundaries = false,
): Promise<void> {
  const semanticPayload = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (semanticPayload.byteLength > maxBytes) {
    throw new Error(`Completion outbox record exceeds ${maxBytes} bytes (${semanticPayload.byteLength}).`);
  }
  await lease?.assertOwned();
  const dir = dirname(path);
  await ensureRealDirectory(dir);
  const transaction = await nextReplacementGeneration(path);
  const { generation, transaction: token } = transaction;
  await lease?.beginMutation(path, token);
  const payload = lease
    ? Buffer.from(`${JSON.stringify(fencedJsonEnvelope(value, lease, token))}\n`, "utf8")
    : semanticPayload;
  if (payload.byteLength > maxBytes + FENCED_JSON_OVERHEAD_BYTES) {
    throw new Error(`Completion outbox fenced record exceeds ${maxBytes + FENCED_JSON_OVERHEAD_BYTES} bytes (${payload.byteLength}).`);
  }
  const replacement = `${path}.replace-${token}.new`;
  const committed = `${path}.replace-${token}.committed`;
  const backup = `${path}.replace-${token}.bak`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(replacement, "wx", 0o600);
    await handle.writeFile(payload);
    if (injectBoundaries) persistenceBoundary("outbox", "after-write");
    await handle.sync();
    if (injectBoundaries) persistenceBoundary("outbox", "after-file-sync");
    await handle.close();
    handle = undefined;
    if (injectBoundaries) persistenceBoundary("outbox", "after-close");
    // Retain one immutable authoritative snapshot. If a revoked former owner
    // later clobbers the compatibility canonical name, readers recover this
    // higher-generation snapshot and reject the revoked payload.
    await copyFile(replacement, committed, fsConstants.COPYFILE_EXCL);
    const committedHandle = await open(committed, "r+");
    try { await committedHandle.sync(); } finally { await committedHandle.close(); }
    await fsyncDirectory(dir);
    await lease?.assertOwned();
    // A prior bounded deletion may have left crash remnants hidden by a
    // tombstone. Once the new generation is file-synced it is safe to reveal:
    // recovery will select either the old canonical or this latest .new.
    await clearRemovalTombstone(path);
    const current = await lstat(path).catch((error) => {
      if (fileCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (!current) {
      await lease?.assertOwned();
      await renameWithRetry(replacement, path);
      if (injectBoundaries) persistenceBoundary("outbox", "after-new-to-canonical");
      await fsyncDirectory(dir);
      if (injectBoundaries) persistenceBoundary("outbox", "after-directory-sync");
      const cleanupPaths = await replacementRemnantsForCleanup(path, token);
      await writeReplacementGenerationSlot(path, transaction.cleanSlot, generation, true, token);
      await lease?.finishMutation(token);
      await cleanupReplacementRemnants(cleanupPaths, dir);
      return;
    }
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new Error(`Completion outbox path must be a regular file: ${path}`);
    }
    await lease?.assertOwned();
    await renameWithRetry(path, backup);
    if (injectBoundaries) persistenceBoundary("outbox", "after-canonical-to-backup");
    await fsyncDirectory(dir);
    await lease?.assertOwned();
    await renameWithRetry(replacement, path);
    if (injectBoundaries) persistenceBoundary("outbox", "after-new-to-canonical");
    await fsyncDirectory(dir);
    if (injectBoundaries) persistenceBoundary("outbox", "after-directory-sync");
    const cleanupPaths = await replacementRemnantsForCleanup(path, token);
    await writeReplacementGenerationSlot(path, transaction.cleanSlot, generation, true, token);
    await lease?.finishMutation(token);
    await cleanupReplacementRemnants(cleanupPaths, dir);
    if (injectBoundaries) persistenceBoundary("outbox", "after-backup-cleanup");
  } catch (error) {
    await handle?.close().catch(() => undefined);
    // Preserve .new/.committed/.bak remnants. Fenced recovery rejects any
    // transaction durably superseded by takeover while retaining older data.
    throw error;
  }
}

async function removeDurable(path: string, lease?: WorkspaceLockLease): Promise<void> {
  await lease?.assertOwned();
  const dir = dirname(path);
  const canonical = path.slice(dir.length + 1);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (fileCode(error) === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    const replacement = parseReplacementName(name);
    if (name === canonical || replacement?.canonical === canonical
      || name === `${canonical}.replace-generation-a` || name === `${canonical}.replace-generation-b`) {
      await lease?.assertOwned();
      await rm(join(dir, name), { force: true });
    }
  }
  await fsyncDirectory(dir);
}

async function parseSafeJsonCandidate(
  candidate: string,
  maxBytes: number,
  canonicalPath: string,
): Promise<unknown | undefined> {
  try {
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes + FENCED_JSON_OVERHEAD_BYTES) return undefined;
    return unwrapFencedJson(JSON.parse(await readFile(candidate, "utf8")), canonicalPath);
  } catch (error) {
    if (fileCode(error) === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function readSafeJson(path: string, maxBytes = COMPLETION_OUTBOX_MAX_RECORD_BYTES): Promise<unknown | undefined> {
  if (await lstat(removalTombstonePath(path)).then(() => true, (error) => {
    if (fileCode(error) === "ENOENT") return false;
    throw error;
  })) return undefined;
  // The overwhelmingly common path reads the exact canonical file directly.
  // Directory enumeration is reserved for an actually missing, invalid, or
  // durably fenced canonical that needs general replacement recovery.
  const canonicalValue = await parseSafeJsonCandidate(path, maxBytes, path);
  if (canonicalValue !== undefined) return canonicalValue;
  const dir = dirname(path);
  const canonical = basename(path);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (fileCode(error) === "ENOENT") return undefined;
    throw error;
  }
  const replacements = await latestReplacementNames(dir, canonical, names);
  for (const name of replacements) {
    const value = await parseSafeJsonCandidate(join(dir, name), maxBytes, path);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * GC must remain bounded even when an index path is stale. Consult only the
 * exact canonical plus the latest transaction recorded in the two fixed
 * generation slots; never enumerate the record/reservation directory.
 */
async function readSafeJsonExactRecovery(
  path: string,
  maxBytes = COMPLETION_OUTBOX_MAX_RECORD_BYTES,
): Promise<unknown | undefined> {
  if (await lstat(removalTombstonePath(path)).then(() => true, (error) => {
    if (fileCode(error) === "ENOENT") return false;
    throw error;
  })) return undefined;
  const canonicalValue = await parseSafeJsonCandidate(path, maxBytes, path);
  if (canonicalValue !== undefined) return canonicalValue;
  const [a, b] = await Promise.all([
    readReplacementGenerationSlot(path, "a"),
    readReplacementGenerationSlot(path, "b"),
  ]);
  const latest = latestReplacementGeneration(a, b);
  if (!latest?.transaction) return undefined;
  for (const suffix of ["new", "committed", "bak"] as const) {
    const value = await parseSafeJsonCandidate(`${path}.replace-${latest.transaction}.${suffix}`, maxBytes, path);
    if (value !== undefined) return value;
  }
  return undefined;
}

export class CompletionOutboxFileStore {
  readonly rootDir: string;
  readonly ownerId: string;
  readonly #now: () => number;
  readonly #maxLiveRecords: number;
  readonly #maxLiveBytes: number;
  #lastReserveGcAt: Map<string, number> = new Map();

  constructor(options: StoreOptions = {}) {
    this.rootDir = resolve(options.rootDir ?? process.env.PI_TEAMMATE_COMPLETION_OUTBOX_ROOT ?? join(homedir(), ".pi", "teammate", "completion-outbox", "v1"));
    this.ownerId = options.ownerId ?? `${process.pid}:${randomUUID()}`;
    this.#now = options.now ?? Date.now;
    this.#maxLiveRecords = options.maxLiveRecords ?? COMPLETION_OUTBOX_MAX_LIVE_RECORDS;
    this.#maxLiveBytes = options.maxLiveBytes ?? COMPLETION_OUTBOX_MAX_LIVE_BYTES;
    if (!Number.isSafeInteger(this.#maxLiveRecords) || this.#maxLiveRecords < 1 || this.#maxLiveRecords > COMPLETION_OUTBOX_MAX_LIVE_RECORDS) {
      throw new Error(`maxLiveRecords must be between 1 and ${COMPLETION_OUTBOX_MAX_LIVE_RECORDS}.`);
    }
    if (!Number.isSafeInteger(this.#maxLiveBytes) || this.#maxLiveBytes < 1 || this.#maxLiveBytes > COMPLETION_OUTBOX_MAX_LIVE_BYTES) {
      throw new Error(`maxLiveBytes must be between 1 and ${COMPLETION_OUTBOX_MAX_LIVE_BYTES}.`);
    }
  }

  async reserve(seed: CompletionDispatchSeed, reservedBytes = COMPLETION_OUTBOX_MAX_RECORD_BYTES): Promise<CompletionReservationRecord> {
    this.#assertSeed(seed);
    if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 1 || reservedBytes > COMPLETION_OUTBOX_MAX_RECORD_BYTES) {
      throw new Error(`Invalid completion reservation size: ${reservedBytes}.`);
    }
    return this.#withWorkspaceLock(seed.target.workspaceId, async (lease) => {
      await this.#maybeReserveGc(seed.target.workspaceId, lease);
      const usage = await this.#usageLocked(seed.target.workspaceId);
      if (usage.liveRecords + 1 > this.#maxLiveRecords
        || usage.liveBytes + reservedBytes > this.#maxLiveBytes) {
        throw new Error(
          `Completion durability capacity exhausted for workspace ${seed.target.workspaceId}: `
          + `${usage.liveRecords}/${this.#maxLiveRecords} live records, `
          + `${usage.liveBytes}/${this.#maxLiveBytes} bytes. `
          + "No teammate child was started; resume/consume pending completions or disable PI_TEAMMATE_COMPLETION_REDELIVERY.",
        );
      }
      const existing = await this.#readReservation(seed.target.workspaceId, seed.reservationId);
      if (existing) {
        if (existing.dispatchId !== seed.dispatchId || !targetEquals(existing.target, seed.target)) {
          throw new Error(`Completion reservation ${seed.reservationId} already belongs to another dispatch.`);
        }
        return existing;
      }
      const now = this.#now();
      const record: CompletionReservationRecord = {
        version: COMPLETION_OUTBOX_SCHEMA_VERSION,
        reservationId: seed.reservationId,
        dispatchId: seed.dispatchId,
        target: seed.target,
        reservedBytes,
        state: "reserved",
        createdAt: now,
        updatedAt: now,
        expiresAt: now + COMPLETION_OUTBOX_LIVE_TTL_MS,
      };
      await this.#writeTrackedJson(
        seed.target.workspaceId,
        this.#reservationPath(seed.target.workspaceId, seed.reservationId),
        record,
        "reservation",
        lease,
      );
      return record;
    });
  }

  async releaseReservation(target: CompletionTarget, reservationId: string): Promise<boolean> {
    return this.#withWorkspaceLock(target.workspaceId, async (lease) => {
      const current = await this.#readReservation(target.workspaceId, reservationId);
      if (!current || !targetEquals(current.target, target)) return false;
      if (current.state === "released") return true;
      const now = this.#now();
      await this.#writeTrackedJson(
        target.workspaceId,
        this.#reservationPath(target.workspaceId, reservationId),
        {
          ...current,
          state: "released",
          updatedAt: now,
          expiresAt: now + COMPLETION_OUTBOX_RESERVATION_TERMINAL_TTL_MS,
        } satisfies CompletionReservationRecord,
        "reservation",
        lease,
      );
      return true;
    });
  }

  async importIntent(intent: CompletionIntent): Promise<CompletionOutboxRecord> {
    return this.#importIntent(intent, false);
  }

  /**
   * Import an already-finalized provider intent after its original capacity
   * reservation was lost or expired. Finalization is irreversible: recreate
   * only the same dispatch/target fence and never abandon committed intent.
   */
  async recoverFinalizedIntent(intent: CompletionIntent): Promise<CompletionOutboxRecord> {
    return this.#importIntent(intent, true);
  }

  async #importIntent(intent: CompletionIntent, recoverReservation: boolean): Promise<CompletionOutboxRecord> {
    this.#assertIntent(intent);
    const deliveryId = computeCompletionDeliveryId(intent);
    if (deliveryId !== intent.deliveryId) throw new Error(`Completion intent deliveryId mismatch for ${intent.dispatchId}.`);
    return this.#withWorkspaceLock(intent.target.workspaceId, async (lease) => {
      const existing = await this.#findRecord(intent.target, deliveryId);
      let reservation = await this.#readReservation(intent.target.workspaceId, intent.reservationId);
      if (existing) {
        let recovered = existing.state === "wal"
          ? await this.#replaceRecord(existing, { state: "pending", updatedAt: this.#now(), nextAttemptAt: this.#now() }, lease)
          : existing;
        if (recovered.intentRevision === undefined) {
          recovered = await this.#replaceRecord(recovered, { intentRevision: intent.contentRevision }, lease);
        } else if (recovered.intentRevision !== intent.contentRevision) {
          throw new Error(`Completion intent revision mismatch for ${intent.dispatchId}.`);
        }
        if (reservation?.state === "reserved" && targetEquals(reservation.target, intent.target)) {
          await this.#consumeReservation(reservation, this.#now(), lease);
        }
        return recovered;
      }
      if (!reservation || reservation.state !== "reserved" || !targetEquals(reservation.target, intent.target)) {
        if (!recoverReservation) {
          throw new Error(`No live completion reservation ${intent.reservationId} for ${deliveryId}.`);
        }
        if (reservation && (reservation.dispatchId !== intent.dispatchId || !targetEquals(reservation.target, intent.target))) {
          throw new Error(`Completion reservation ${intent.reservationId} belongs to another finalized dispatch.`);
        }
        const recoveredAt = this.#now();
        reservation = {
          version: COMPLETION_OUTBOX_SCHEMA_VERSION,
          reservationId: intent.reservationId,
          dispatchId: intent.dispatchId,
          target: intent.target,
          reservedBytes: reservation?.reservedBytes ?? COMPLETION_OUTBOX_MAX_RECORD_BYTES,
          state: "reserved",
          createdAt: reservation?.createdAt ?? intent.createdAt,
          updatedAt: recoveredAt,
          expiresAt: recoveredAt + COMPLETION_OUTBOX_LIVE_TTL_MS,
        };
        await this.#writeTrackedJson(
          intent.target.workspaceId,
          this.#reservationPath(intent.target.workspaceId, intent.reservationId),
          reservation,
          "reservation",
          lease,
        );
      }
      const now = this.#now();
      const base: Omit<CompletionOutboxRecord, "contentRevision"> = {
        version: COMPLETION_OUTBOX_SCHEMA_VERSION,
        deliveryId,
        dispatchId: intent.dispatchId,
        reservationId: intent.reservationId,
        kind: intent.kind,
        target: intent.target,
        replyTarget: intent.replyTarget,
        summary: intent.summary,
        resources: intent.resources,
        outcome: intent.outcome,
        state: "wal",
        attempts: 0,
        nextAttemptAt: now,
        createdAt: intent.createdAt,
        updatedAt: now,
        expiresAt: now + COMPLETION_OUTBOX_LIVE_TTL_MS,
        intentRevision: intent.contentRevision,
      };
      const wal = { ...base, contentRevision: computeCompletionContentRevision(base) };
      await this.#writeTrackedJson(
        intent.target.workspaceId,
        this.#recordPath(intent.target, "wal", deliveryId),
        wal,
        "record",
        lease,
      );
      const pendingBase = { ...base, state: "pending" as const };
      const pending = { ...pendingBase, contentRevision: computeCompletionContentRevision(pendingBase) };
      await this.#writeTrackedJson(
        intent.target.workspaceId,
        this.#recordPath(intent.target, "pending", deliveryId),
        pending,
        "record",
        lease,
      );
      await removeDurable(this.#recordPath(intent.target, "wal", deliveryId), lease);
      await this.#consumeReservation(reservation, now, lease);
      return pending;
    });
  }

  async listForTarget(target: CompletionTarget): Promise<CompletionOutboxRecord[]> {
    const byDelivery = new Map<string, CompletionOutboxRecord>();
    for (const state of STATE_DIRS) {
      for (const record of await this.#listState(target, state)) {
        const current = byDelivery.get(record.deliveryId);
        if (!current || completionRecordPrecedes(record, current)) byDelivery.set(record.deliveryId, record);
      }
    }
    return [...byDelivery.values()]
      .sort((left, right) => left.createdAt - right.createdAt || left.deliveryId.localeCompare(right.deliveryId));
  }

  async acquireClaim(target: CompletionTarget, deliveryId: string): Promise<CompletionOutboxRecord | undefined> {
    return this.#withWorkspaceLock(target.workspaceId, async (lease) => {
      const current = await this.#findRecord(target, deliveryId);
      if (!current || (current.state !== "pending" && current.state !== "queued")) return undefined;
      const now = this.#now();
      // Expired records must never be delivered even before GC reaches them.
      if (current.expiresAt <= now) {
        await this.#replaceRecord(current, { state: "expired", updatedAt: now }, lease);
        return undefined;
      }
      if (current.claimOwnerId && (current.claimExpiresAt ?? 0) > now) return undefined;
      return this.#replaceRecord(current, {
        claimOwnerId: this.ownerId,
        claimExpiresAt: now + COMPLETION_OUTBOX_CLAIM_MS,
        updatedAt: now,
      }, lease);
    });
  }

  async markQueued(target: CompletionTarget, deliveryId: string, receiptDeadlineAt: number): Promise<CompletionOutboxRecord | undefined> {
    return this.#transition(target, deliveryId, ["pending", "queued"], "queued", (current, now) => ({
      attempts: Math.min(COMPLETION_OUTBOX_MAX_ATTEMPTS, current.attempts + 1),
      nextAttemptAt: now + retryDelayForAttempt(current.attempts + 1),
      receiptDeadlineAt,
      claimOwnerId: undefined,
      claimExpiresAt: undefined,
    }));
  }

  async returnToPending(target: CompletionTarget, deliveryId: string, error?: string): Promise<CompletionOutboxRecord | undefined> {
    return this.#transition(target, deliveryId, ["pending", "queued"], "pending", (_current, now) => ({
      nextAttemptAt: now,
      receiptDeadlineAt: undefined,
      claimOwnerId: undefined,
      claimExpiresAt: undefined,
      ...(error ? { lastError: Buffer.from(error, "utf8").subarray(0, COMPLETION_OUTBOX_MAX_ERROR_BYTES).toString("utf8") } : {}),
    }));
  }

  async markApplied(target: CompletionTarget, deliveryId: string): Promise<CompletionOutboxRecord | undefined> {
    return this.#transition(target, deliveryId, ["pending", "queued", "applied"], "applied", (_current, now) => ({
      expiresAt: now + COMPLETION_OUTBOX_APPLIED_TTL_MS,
      receiptDeadlineAt: undefined,
      claimOwnerId: undefined,
      claimExpiresAt: undefined,
    }));
  }

  async markProviderAcknowledged(target: CompletionTarget, deliveryId: string): Promise<CompletionOutboxRecord | undefined> {
    return this.#transition(target, deliveryId, ["applied"], "applied", (_current, now) => ({ providerAcknowledgedAt: now }));
  }

  async markDead(target: CompletionTarget, deliveryId: string, error: string): Promise<CompletionOutboxRecord | undefined> {
    return this.#transition(target, deliveryId, ["wal", "pending", "queued", "dead"], "dead", (_current, now) => ({
      expiresAt: now + COMPLETION_OUTBOX_TERMINAL_TTL_MS,
      lastError: Buffer.from(error, "utf8").subarray(0, COMPLETION_OUTBOX_MAX_ERROR_BYTES).toString("utf8"),
      claimOwnerId: undefined,
      claimExpiresAt: undefined,
    }));
  }

  async usage(workspaceId: string): Promise<CompletionOutboxUsage> {
    return this.#withWorkspaceLock(workspaceId, () => this.#usageLocked(workspaceId));
  }

  async gc(workspaceId: string): Promise<CompletionOutboxGcResult> {
    return this.#withWorkspaceLock(workspaceId, (lease) => this.#gcLocked(workspaceId, lease));
  }

  async cleanupRemnants(
    workspaceId: string,
    options: CompletionOutboxCleanupOptions = {},
  ): Promise<CompletionOutboxCleanupResult> {
    if (!boundedString(workspaceId, 128)) throw new Error("Invalid completion workspaceId.");
    const apply = options.apply ?? false;
    const maxEntries = options.maxEntries ?? DEFAULT_CLEANUP_MAX_ENTRIES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_000_000) {
      throw new Error("Completion outbox cleanup maxEntries must be between 1 and 1000000.");
    }
    const workspaceDir = this.#workspaceDir(workspaceId);
    if (!apply) {
      const lockPath = join(workspaceDir, ".store.lock");
      const generationBefore = await readWorkspaceGenerationFence(workspaceDir);
      const lockedBefore = await lstat(lockPath).then(() => true, (error) => {
        if (fileCode(error) === "ENOENT") return false;
        throw error;
      });
      if (lockedBefore) return emptyCleanupResult(false, true);
      const scanned = await scanReplacementRemnants(workspaceDir, maxEntries);
      const generationAfter = await readWorkspaceGenerationFence(workspaceDir);
      const lockedAfter = await lstat(lockPath).then(() => true, (error) => {
        if (fileCode(error) === "ENOENT") return false;
        throw error;
      });
      return lockedAfter || generationAfter !== generationBefore
        ? emptyCleanupResult(false, true)
        : scanned.result;
    }

    const cleaned = await this.#withWorkspaceLock<CompletionOutboxCleanupResult | undefined>(
      workspaceId,
      async (lease) => {
        const scanned = await scanReplacementRemnants(workspaceDir, maxEntries);
        const removed = await removeReplacementCandidates(scanned.candidates, lease);
        return { ...scanned.result, apply: true, ...removed };
      },
      0,
    );
    return cleaned ?? emptyCleanupResult(true, true);
  }

  /**
   * Non-blocking GC for the periodic reconcile path. If the workspace lock is
   * already held by a concurrent writer, returns `{ busy: true }` instead of
   * waiting or throwing — a maintenance sweep must never crash or warn on
   * transient contention. Also honors a cross-process `.gc-marker` so that
   * when multiple Pi processes share the outbox only one sweeps within
   * TRY_GC_MARKER_MIN_INTERVAL_MS; the others return `{ skipped: true }`.
   * Expired records are inert (acquireClaim/deliverDue reject them), so
   * skipping a sweep is safe; the next reconcile reclaims them.
   */
  async tryGc(workspaceId: string): Promise<CompletionOutboxTryGcResult> {
    const empty: CompletionOutboxTryGcResult = { expired: 0, removed: 0, releasedReservations: 0 };
    if (!boundedString(workspaceId, 128)) return { ...empty, busy: true };
    const workspaceDir = this.#workspaceDir(workspaceId);
    const markerPath = join(workspaceDir, GC_MARKER_NAME);
    const now = this.#now();
    const marker = await readSafeJson(markerPath, 64);
    if (marker && typeof marker === "object" && "at" in marker && typeof (marker as { at: unknown }).at === "number"
      && now - (marker as { at: number }).at < TRY_GC_MARKER_MIN_INTERVAL_MS) {
      return { ...empty, skipped: true };
    }
    const result = await this.#withWorkspaceLock<CompletionOutboxTryGcResult | undefined>(
      workspaceId,
      async (lease) => {
        // Re-check the marker inside the lock to close the TOCTOU window between
        // the lock-free read above and acquisition: another process may have just
        // finished a sweep and written the marker while we waited.
        const fresh = await readSafeJson(markerPath, 64);
        const freshAt = fresh && typeof fresh === "object" && "at" in fresh && typeof (fresh as { at: unknown }).at === "number"
          ? (fresh as { at: number }).at : 0;
        if (freshAt > 0 && now - freshAt < TRY_GC_MARKER_MIN_INTERVAL_MS) {
          return { ...empty, skipped: true };
        }
        const swept = await this.#gcLocked(workspaceId, lease);
        // A page with remaining work deliberately leaves the marker stale so a
        // later reconcile can continue the bounded cursor instead of waiting.
        if (!swept.hasMore) await writeJsonAtomic(markerPath, { at: this.#now() }, 64, lease);
        return swept;
      },
      0,
    );
    return result ?? { ...empty, busy: true };
  }

  #gcIndexStatePath(workspaceId: string): string {
    return join(this.#workspaceDir(workspaceId), GC_INDEX_DIR, GC_INDEX_STATE_NAME);
  }

  #gcIndexSegmentPath(workspaceId: string, segment: number): string {
    return join(
      this.#workspaceDir(workspaceId),
      GC_INDEX_DIR,
      "segments",
      `${String(segment).padStart(20, "0")}.json`,
    );
  }

  #gcIndexLatestPath(workspaceId: string, entry: GcIndexEntry): string {
    return join(
      this.#workspaceDir(workspaceId),
      GC_INDEX_DIR,
      GC_INDEX_LATEST_DIR,
      `${hashPath(`${entry.kind}\0${entry.path}`)}.json`,
    );
  }

  async #readGcIndexLatest(workspaceId: string, entry: GcIndexEntry): Promise<GcIndexLatest | undefined> {
    const raw = await readSafeJson(this.#gcIndexLatestPath(workspaceId, entry), 1_024);
    if (!raw || typeof raw !== "object") return undefined;
    const latest = raw as Partial<GcIndexLatest>;
    if (latest.version !== 1 || latest.path !== entry.path || latest.kind !== entry.kind
      || !Number.isSafeInteger(latest.sequence) || latest.sequence! < 0) return undefined;
    return latest as GcIndexLatest;
  }

  async #readGcIndexState(workspaceId: string): Promise<GcIndexState> {
    const raw = await readSafeJson(this.#gcIndexStatePath(workspaceId), 512);
    if (!raw || typeof raw !== "object") return { version: 1, head: 0, tail: 0 };
    const state = raw as Partial<GcIndexState>;
    if (state.version !== 1 || !Number.isSafeInteger(state.head) || state.head! < 0
      || !Number.isSafeInteger(state.tail) || state.tail! < state.head!
      || state.sweepEnd !== undefined && (!Number.isSafeInteger(state.sweepEnd)
        || state.sweepEnd! < state.head! || state.sweepEnd! > state.tail!)) {
      // The GC index is an optimization over the authoritative record/reservation
      // files: expired records are inert (acquireClaim/deliverDue reject them),
      // so dropping a corrupt index only defers a maintenance sweep. A corrupt
      // state.json would otherwise throw on every reconcile and spam forever.
      // Self-heal by removing the whole index dir so the next append rebuilds it.
      await this.#resetGcIndex(workspaceId, "state");
      return { version: 1, head: 0, tail: 0 };
    }
    return state as GcIndexState;
  }

  async #readGcIndexSegment(workspaceId: string, segmentNumber: number): Promise<GcIndexSegment> {
    const base = segmentNumber * GC_INDEX_SEGMENT_SIZE;
    const raw = await readSafeJson(
      this.#gcIndexSegmentPath(workspaceId, segmentNumber),
      COMPLETION_OUTBOX_MAX_RECORD_BYTES,
    );
    if (!raw || typeof raw !== "object") return { version: 1, base, entries: [] };
    const segment = raw as Partial<GcIndexSegment>;
    if (segment.version !== 1 || segment.base !== base || !Array.isArray(segment.entries)
      || segment.entries.length > GC_INDEX_SEGMENT_SIZE) {
      // A single corrupt segment poisons the sweep cursor. Drop just that file
      // (entries there are stale at worst) and let the empty slot be skipped.
      await this.#resetGcIndexSegment(workspaceId, segmentNumber, "segment");
      return { version: 1, base, entries: [] };
    }
    return { version: 1, base, entries: [...segment.entries] as Array<GcIndexEntry | null> };
  }

  // Remove the entire GC index directory (state.json + all segments) and fsync
  // the workspace dir so the reset is durable. Callers already hold the workspace
  // lock; the index holds no authoritative data, only stale GC entries.
  async #resetGcIndex(workspaceId: string, reason: "state"): Promise<void> {
    const workspaceDir = this.#workspaceDir(workspaceId);
    const indexDir = join(workspaceDir, GC_INDEX_DIR);
    await rm(indexDir, { recursive: true, force: true });
    await fsyncDirectory(workspaceDir);
    logDiagnosticWarn(`[pi-maestro-teammate] corrupt completion GC index ${reason} reset for workspace ${workspaceId}; GC will rebuild it on next append.`);
  }

  // Remove a single corrupt segment file and fsync its dir. The state.json cursor
  // still references the sequence; the now-missing entry is treated as a stale slot.
  async #resetGcIndexSegment(workspaceId: string, segmentNumber: number, reason: "segment"): Promise<void> {
    await rm(this.#gcIndexSegmentPath(workspaceId, segmentNumber), { force: true });
    await fsyncDirectory(dirname(join(this.#workspaceDir(workspaceId), GC_INDEX_DIR, "segments")));
    logDiagnosticWarn(`[pi-maestro-teammate] corrupt completion GC index ${reason} ${segmentNumber} dropped for workspace ${workspaceId}; slot treated as stale.`);
  }

  async #appendGcIndex(
    workspaceId: string,
    entry: GcIndexEntry,
    lease: WorkspaceLockLease,
    replaceSequence?: number,
  ): Promise<number> {
    const workspaceDir = this.#workspaceDir(workspaceId);
    const entryPath = resolve(workspaceDir, entry.path);
    const contained = relative(workspaceDir, entryPath);
    if (!contained || contained.startsWith("..") || resolve(entryPath) !== entryPath) {
      throw new Error(`Completion GC index path escapes workspace ${workspaceId}.`);
    }
    const canonicalEntry = { path: contained, kind: entry.kind } satisfies GcIndexEntry;
    const state = await this.#readGcIndexState(workspaceId);
    const latest = await this.#readGcIndexLatest(workspaceId, canonicalEntry);
    const latestActive = Boolean(latest && latest.sequence >= state.head && latest.sequence < state.tail);
    if (latestActive && (replaceSequence === undefined || latest!.sequence !== replaceSequence)) {
      return latest!.sequence;
    }
    if (state.tail >= Number.MAX_SAFE_INTEGER - 1) {
      throw new Error(`Completion GC index exhausted for workspace ${workspaceId}.`);
    }
    const sequence = state.tail;
    const segmentNumber = Math.floor(sequence / GC_INDEX_SEGMENT_SIZE);
    const slot = sequence % GC_INDEX_SEGMENT_SIZE;
    const segment = await this.#readGcIndexSegment(workspaceId, segmentNumber);
    while (segment.entries.length <= slot) segment.entries.push(null);
    segment.entries[slot] = canonicalEntry;
    await writeJsonAtomic(
      this.#gcIndexSegmentPath(workspaceId, segmentNumber),
      segment,
      COMPLETION_OUTBOX_MAX_RECORD_BYTES,
      lease,
    );
    await writeJsonAtomic(
      this.#gcIndexStatePath(workspaceId),
      { ...state, tail: sequence + 1 } satisfies GcIndexState,
      512,
      lease,
    );
    // The marker is committed after the segment and tail. A crash before this
    // write leaves a legacy entry that the next sweep can adopt; it never makes
    // a canonical record unreachable from GC.
    await writeJsonAtomic(
      this.#gcIndexLatestPath(workspaceId, canonicalEntry),
      { version: 1, sequence, ...canonicalEntry } satisfies GcIndexLatest,
      1_024,
      lease,
    );
    return sequence;
  }

  async #writeTrackedJson(
    workspaceId: string,
    path: string,
    value: unknown,
    kind: GcIndexEntry["kind"],
    lease: WorkspaceLockLease,
  ): Promise<void> {
    // Index first: an interrupted append creates only a harmless stale entry;
    // the reverse order could leave a durable canonical record invisible to GC.
    await this.#appendGcIndex(workspaceId, {
      path: relative(this.#workspaceDir(workspaceId), path),
      kind,
    }, lease);
    await writeJsonAtomic(path, value, COMPLETION_OUTBOX_MAX_RECORD_BYTES, lease, true);
  }

  async #transition(
    target: CompletionTarget,
    deliveryId: string,
    allowed: readonly CompletionOutboxState[],
    nextState: CompletionOutboxState,
    patch: (current: CompletionOutboxRecord, now: number) => Partial<CompletionOutboxRecord>,
  ): Promise<CompletionOutboxRecord | undefined> {
    return this.#withWorkspaceLock(target.workspaceId, async (lease) => {
      const current = await this.#findRecord(target, deliveryId);
      if (!current || !allowed.includes(current.state)) return undefined;
      return this.#replaceRecord(current, { ...patch(current, this.#now()), state: nextState, updatedAt: this.#now() }, lease);
    });
  }

  async #replaceRecord(
    current: CompletionOutboxRecord,
    patch: Partial<CompletionOutboxRecord>,
    lease: WorkspaceLockLease,
  ): Promise<CompletionOutboxRecord> {
    const monotonicPatch = {
      ...patch,
      updatedAt: Math.max(patch.updatedAt ?? current.updatedAt + 1, current.updatedAt + 1),
    };
    const { contentRevision: _revision, ...base } = { ...current, ...monotonicPatch };
    const next = { ...base, contentRevision: computeCompletionContentRevision(base) };
    if (!validRecord(next)) throw new Error(`Invalid completion outbox transition for ${current.deliveryId}.`);
    await this.#writeTrackedJson(
      current.target.workspaceId,
      this.#recordPath(current.target, next.state, next.deliveryId),
      next,
      "record",
      lease,
    );
    if (current.state !== next.state) {
      await removeDurable(this.#recordPath(current.target, current.state, current.deliveryId), lease);
    }
    return next;
  }

  async #findRecord(target: CompletionTarget, deliveryId: string): Promise<CompletionOutboxRecord | undefined> {
    if (!HASH_ID.test(deliveryId)) return undefined;
    let newest: CompletionOutboxRecord | undefined;
    for (const state of STATE_DIRS) {
      const raw = await readSafeJson(this.#recordPath(target, state, deliveryId));
      if (!validRecord(raw) || !targetEquals(raw.target, target)) continue;
      if (!newest || completionRecordPrecedes(raw, newest)) newest = raw;
    }
    return newest;
  }

  async #listState(target: CompletionTarget, state: CompletionOutboxState): Promise<CompletionOutboxRecord[]> {
    const dir = this.#stateDir(target, state);
    let names: string[];
    try { names = await readdir(dir); } catch (error) {
      if (fileCode(error) === "ENOENT") return [];
      throw error;
    }
    const records: CompletionOutboxRecord[] = [];
    for (const name of canonicalJsonNames(names)) {
      const raw = await readSafeJson(join(dir, name));
      if (validRecord(raw) && targetEquals(raw.target, target) && raw.state === state) records.push(raw);
    }
    return records;
  }

  async #usageLocked(workspaceId: string): Promise<CompletionOutboxUsage> {
    const workspaceDir = this.#workspaceDir(workspaceId);
    let sessionNames: string[] = [];
    try {
      sessionNames = (await readdir(workspaceDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name !== "reservations")
        .map((entry) => entry.name);
    } catch (error) {
      if (fileCode(error) !== "ENOENT") throw error;
    }
    let liveRecords = 0;
    let liveBytes = 0;
    for (const sessionName of sessionNames) {
      for (const state of LIVE_STATES) {
        const dir = join(workspaceDir, sessionName, state);
        let names: string[] = [];
        try { names = await readdir(dir); } catch (error) { if (fileCode(error) !== "ENOENT") throw error; }
        for (const name of canonicalJsonNames(names)) {
          const raw = await readSafeJson(join(dir, name));
          if (!validRecord(raw) || raw.state !== state) continue;
          liveRecords += 1;
          liveBytes += Buffer.byteLength(JSON.stringify(raw), "utf8");
        }
      }
    }
    let reservations = 0;
    const reservationsDir = join(workspaceDir, "reservations");
    try {
      const names = canonicalJsonNames(await readdir(reservationsDir));
      for (const name of names) {
        const raw = await readSafeJson(join(reservationsDir, name));
        if (!validReservation(raw) || raw.state !== "reserved") continue;
        reservations += 1;
        liveRecords += 1;
        liveBytes += raw.reservedBytes;
      }
    } catch (error) { if (fileCode(error) !== "ENOENT") throw error; }
    return { liveRecords, liveBytes, reservations };
  }

  async #gcLocked(workspaceId: string, lease: WorkspaceLockLease): Promise<CompletionOutboxGcResult> {
    const startedAt = Date.now();
    const now = this.#now();
    const result: CompletionOutboxGcResult = { expired: 0, removed: 0, releasedReservations: 0 };
    let state = await this.#readGcIndexState(workspaceId);
    if (state.head >= state.tail) return result;

    // Freeze the current tail as this sweep's boundary. Survivors are appended
    // behind it, so a sweep visits every indexed record exactly once without
    // enumerating or sorting any unbounded state/session directory.
    const sweepEnd = state.sweepEnd ?? state.tail;
    if (state.sweepEnd === undefined) {
      state = { ...state, sweepEnd };
      await writeJsonAtomic(this.#gcIndexStatePath(workspaceId), state, 512, lease);
    }
    const scanEnd = Math.min(state.head + GC_SCAN_MAX_ENTRIES, sweepEnd);
    const segments = new Map<number, GcIndexSegment>();
    const latestByEntry = new Map<string, GcIndexLatest | undefined>();
    let knownTail = state.tail;
    let pageEnd = state.head;
    for (let sequence = state.head; sequence < scanEnd; sequence += 1) {
      if (sequence > state.head && Date.now() - startedAt >= GC_LOCK_BUDGET_MS) break;
      await lease.assertOwned();
      pageEnd = sequence + 1;
      const segmentNumber = Math.floor(sequence / GC_INDEX_SEGMENT_SIZE);
      let segment = segments.get(segmentNumber);
      if (!segment) {
        segment = await this.#readGcIndexSegment(workspaceId, segmentNumber);
        segments.set(segmentNumber, segment);
      }
      const entry = segment.entries[sequence - segment.base];
      if (!entry || typeof entry.path !== "string"
        || (entry.kind !== "record" && entry.kind !== "reservation")) continue;
      const candidatePath = resolve(this.#workspaceDir(workspaceId), entry.path);
      const contained = relative(this.#workspaceDir(workspaceId), candidatePath);
      if (!contained || contained.startsWith("..")) continue;
      const canonicalEntry = { path: contained, kind: entry.kind } satisfies GcIndexEntry;
      const entryKey = `${entry.kind}\0${contained}`;
      let latest = latestByEntry.get(entryKey);
      if (!latestByEntry.has(entryKey)) {
        latest = await this.#readGcIndexLatest(workspaceId, canonicalEntry);
        latestByEntry.set(entryKey, latest);
      }
      const latestActive = Boolean(latest && latest.sequence >= state.head && latest.sequence < knownTail);
      // Once one legacy duplicate is adopted, every other historical entry for
      // the same canonical path is stale and can be consumed without re-appending.
      if (latestActive && latest!.sequence !== sequence) continue;

      const raw = await readSafeJsonExactRecovery(candidatePath);
      let retain = false;
      if (entry.kind === "record") {
        if (!validRecord(raw)) continue;
        if (LIVE_STATES.has(raw.state) && raw.expiresAt <= now) {
          const base = {
            ...raw,
            state: "expired" as const,
            updatedAt: now,
            expiresAt: now + COMPLETION_OUTBOX_TERMINAL_TTL_MS,
          };
          const { contentRevision: _revision, ...semantic } = base;
          const expired = { ...semantic, contentRevision: computeCompletionContentRevision(semantic) };
          await this.#writeTrackedJson(
            workspaceId,
            this.#recordPath(raw.target, "expired", raw.deliveryId),
            expired,
            "record",
            lease,
          );
          await removeDurableBounded(candidatePath, lease);
          result.expired += 1;
        } else if (!LIVE_STATES.has(raw.state) && raw.expiresAt <= now) {
          await removeDurableBounded(candidatePath, lease);
          result.removed += 1;
        } else {
          retain = true;
        }
      } else if (validReservation(raw)) {
        if (raw.expiresAt <= now) {
          await removeDurableBounded(candidatePath, lease);
          result.releasedReservations += 1;
        } else {
          retain = true;
        }
      }
      if (retain) {
        const nextSequence = await this.#appendGcIndex(workspaceId, canonicalEntry, lease, sequence);
        knownTail = Math.max(knownTail, nextSequence + 1);
        latestByEntry.set(entryKey, { version: 1, sequence: nextSequence, ...canonicalEntry });
      }
    }

    // Preserve appends performed while processing this page, then advance the
    // durable head. Fully consumed index segments are removed after the state
    // update; replay after a crash is idempotent and may only add stale entries.
    const latest = await this.#readGcIndexState(workspaceId);
    const completedSweep = pageEnd >= sweepEnd;
    let next: GcIndexState = {
      ...latest,
      head: pageEnd,
      ...(completedSweep ? { sweepEnd: undefined } : { sweepEnd }),
    };
    if (next.head >= next.tail) next = { version: 1, head: 0, tail: 0 };
    await writeJsonAtomic(this.#gcIndexStatePath(workspaceId), next, 512, lease);
    const firstRetainedSegment = next.head === 0
      ? Math.ceil(pageEnd / GC_INDEX_SEGMENT_SIZE)
      : Math.floor(next.head / GC_INDEX_SEGMENT_SIZE);
    for (let segment = Math.floor(state.head / GC_INDEX_SEGMENT_SIZE); segment < firstRetainedSegment; segment += 1) {
      await removeDurable(this.#gcIndexSegmentPath(workspaceId, segment), lease);
    }
    if (!completedSweep) result.hasMore = true;
    return result;
  }

  // reserve() only needs usage that is recent enough for a capacity check; running a
  // full workspace GC on every reservation takes the lock for too long under load.
  // Throttle the implicit GC to once per RESERVE_GC_MIN_INTERVAL_MS per workspace.
  //
  // NOTE: #usageLocked() counts files in live state dirs without reading expiresAt,
  // so skipping a sweep means expired-but-not-yet-swept records still count against
  // the quota until the next explicit store.gc() (reconcile) reclaims them. This
  // is intentionally conservative: it can only false-reject (never over-admit),
  // and the next reconcile past RECONCILE_GC_MIN_INTERVAL_MS reclaims the slack.
  async #maybeReserveGc(workspaceId: string, lease: WorkspaceLockLease): Promise<void> {
    const now = this.#now();
    const last = this.#lastReserveGcAt.get(workspaceId) ?? 0;
    if (now - last < RESERVE_GC_MIN_INTERVAL_MS) return;
    await this.#gcLocked(workspaceId, lease);
    this.#lastReserveGcAt.set(workspaceId, now);
  }

  async #consumeReservation(
    reservation: CompletionReservationRecord,
    now: number,
    lease: WorkspaceLockLease,
  ): Promise<void> {
    await this.#writeTrackedJson(
      reservation.target.workspaceId,
      this.#reservationPath(reservation.target.workspaceId, reservation.reservationId),
      {
        ...reservation,
        state: "consumed",
        updatedAt: now,
        expiresAt: now + COMPLETION_OUTBOX_RESERVATION_TERMINAL_TTL_MS,
      } satisfies CompletionReservationRecord,
      "reservation",
      lease,
    );
  }

  async #readReservation(workspaceId: string, reservationId: string): Promise<CompletionReservationRecord | undefined> {
    if (!SAFE_ID.test(reservationId)) return undefined;
    const raw = await readSafeJson(this.#reservationPath(workspaceId, reservationId));
    return validReservation(raw) ? raw : undefined;
  }

  async #withWorkspaceLock<T>(
    workspaceId: string,
    action: (lease: WorkspaceLockLease) => Promise<T>,
    waitMs: number = LOCK_WAIT_MS,
  ): Promise<T> {
    if (!boundedString(workspaceId, 128)) throw new Error("Invalid completion workspaceId.");
    const workspaceDir = this.#workspaceDir(workspaceId);
    await ensureRealDirectory(this.rootDir);
    await ensureRealDirectory(workspaceDir);
    const lockPath = join(workspaceDir, ".store.lock");
    const deadline = Date.now() + waitMs;
    const token = randomUUID();
    let generation: string | undefined;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    while (!handle) {
      let createdIdentity: { dev: number | bigint; ino: number | bigint } | undefined;
      try {
        handle = await open(lockPath, "wx", 0o600);
        const created = await handle.stat();
        createdIdentity = { dev: created.dev, ino: created.ino };
        ACTIVE_WORKSPACE_LOCK_TOKENS.add(token);
        persistenceBoundary("lock", "after-create");
        generation = await nextWorkspaceGeneration(workspaceDir, token);
        const initial: WorkspaceLockRecord = {
          version: 2,
          ownerId: this.ownerId,
          token,
          pid: process.pid,
          heartbeatAt: Date.now(),
          generation,
        };
        await overwriteWorkspaceLockRecord(handle, initial);
        persistenceBoundary("lock", "after-write");
        await handle.sync();
        persistenceBoundary("lock", "after-file-sync");
        await fsyncDirectory(workspaceDir);
        persistenceBoundary("lock", "after-directory-sync");
      } catch (error) {
        const createdByThisAttempt = Boolean(handle);
        if (createdByThisAttempt) ACTIVE_WORKSPACE_LOCK_TOKENS.delete(token);
        await handle?.close().catch(() => undefined);
        handle = undefined;
        if (createdByThisAttempt) {
          // Setup failed after wx created the canonical entry. Remove only the
          // inode/token created by this attempt before propagating the error.
          const snapshot = await this.#readLockSnapshot(lockPath).catch(() => undefined);
          const info = await lstat(lockPath).catch(() => undefined);
          const ownsEntry = snapshot?.record?.token === token && snapshot.record.ownerId === this.ownerId
            || Boolean(info && createdIdentity && info.dev === createdIdentity.dev && info.ino === createdIdentity.ino);
          if (ownsEntry) {
            const failedPath = `${lockPath}.setup-failed-${token}`;
            await rename(lockPath, failedPath).catch(async (cleanupError) => {
              if (fileCode(cleanupError) !== "ENOENT") throw cleanupError;
            });
            await fsyncDirectory(workspaceDir);
            await rm(failedPath, { force: true });
            await fsyncDirectory(workspaceDir);
          }
        }
        const code = fileCode(error);
        if (!REPLACE_ERRORS.has(code ?? "")) throw error;
        const snapshot = await this.#readLockSnapshot(lockPath);
        const now = Date.now();
        const heartbeatAt = snapshot?.record?.heartbeatAt ?? snapshot?.mtimeMs ?? now;
        const stale = now - heartbeatAt > LOCK_STALE_MS;
        const holderState = snapshot?.record ? this.#processState(snapshot.record.pid) : "unknown";
        const definitivelyDead = holderState === "dead";
        const endedSameProcess = Boolean(snapshot?.record
          && snapshot.record.pid === process.pid
          && !ACTIVE_WORKSPACE_LOCK_TOKENS.has(snapshot.record.token));
        const abandonedSetup = Boolean(snapshot && !snapshot.record && snapshot.size === 0
          && now - Math.max(snapshot.mtimeMs, snapshot.ctimeMs) >= LOCK_SETUP_STALE_MS);
        if (snapshot && (definitivelyDead || endedSameProcess || stale && holderState !== "alive" || abandonedSetup)) {
          const mutation = snapshot.record?.mutation;
          const mutationPath = mutation ? resolveLockMutationPath(workspaceDir, mutation) : undefined;
          const revocationCreated = mutation && mutationPath && snapshot.record?.generation
            ? await writeMutationRevocation(mutationPath, snapshot.record.generation, mutation.transaction)
            : false;
          const fresh = await this.#readLockSnapshot(lockPath);
          const unchanged = Boolean(fresh
            && fresh.raw === snapshot.raw
            && fresh.dev === snapshot.dev
            && fresh.ino === snapshot.ino
            && fresh.size === snapshot.size
            && fresh.mtimeMs === snapshot.mtimeMs
            && fresh.ctimeMs === snapshot.ctimeMs
            && fresh.record?.token === snapshot.record?.token);
          if (unchanged) {
            const stalePath = `${lockPath}.stale-${snapshot.record?.token ?? `setup-${randomUUID()}`}`;
            try {
              // The exact active transaction is durably revoked before the
              // canonical lock entry changes. A delayed former owner may still
              // rename bytes, but fenced readers will reject that generation.
              await rename(lockPath, stalePath);
              await fsyncDirectory(workspaceDir);
              await rm(stalePath, { force: true });
              await fsyncDirectory(workspaceDir);
              continue;
            } catch (takeoverError) {
              await rollbackMutationRevocation(mutationPath ?? "", mutation?.transaction ?? "", Boolean(revocationCreated));
              if (!REPLACE_ERRORS.has(fileCode(takeoverError) ?? "") && fileCode(takeoverError) !== "ENOENT") throw takeoverError;
            }
          } else {
            await rollbackMutationRevocation(mutationPath ?? "", mutation?.transaction ?? "", Boolean(revocationCreated));
          }
        }
        if (waitMs <= 0 || Date.now() >= deadline) {
          if (waitMs <= 0) return undefined as T;
          throw new Error(`Timed out acquiring completion outbox lock for ${workspaceId}.`);
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
      }
    }
    ACTIVE_WORKSPACE_LOCK_TOKENS.add(token);
    if (!generation || !WORKSPACE_GENERATION.test(generation)) {
      throw new Error(`Completion outbox lock generation was not initialized for ${workspaceId}.`);
    }

    let heartbeat: Promise<void> | undefined;
    let heartbeatError: unknown;
    const assertOwned = async (): Promise<void> => {
      await heartbeat?.catch(() => undefined);
      if (heartbeatError) throw new Error(`Completion outbox lock ownership lost for ${workspaceId}.`, { cause: heartbeatError });
      const snapshot = await this.#readLockSnapshot(lockPath);
      if (!snapshot?.record || snapshot.record.token !== token || snapshot.record.ownerId !== this.ownerId
        || snapshot.record.generation !== generation) {
        throw new Error(`Completion outbox lock ownership lost for ${workspaceId}.`);
      }
    };
    const assertOwnedSync = (): void => {
      if (heartbeatError) throw new Error(`Completion outbox lock ownership lost for ${workspaceId}.`, { cause: heartbeatError });
      let record: WorkspaceLockRecord | undefined;
      try {
        const info = lstatSync(lockPath);
        if (info.isFile() && !info.isSymbolicLink() && info.size <= WORKSPACE_LOCK_RECORD_BYTES) {
          record = parseWorkspaceLockRecord(readFileSync(lockPath, "utf8"));
        }
      } catch (error) {
        if (fileCode(error) !== "ENOENT") throw error;
      }
      if (!record || record.token !== token || record.ownerId !== this.ownerId
        || record.generation !== generation) {
        throw new Error(`Completion outbox lock ownership lost for ${workspaceId}.`);
      }
    };
    const writeLeaseRecord = async (mutation: WorkspaceLockMutation | undefined): Promise<void> => {
      const snapshot = await this.#readLockSnapshot(lockPath);
      if (!snapshot?.record || snapshot.record.token !== token || snapshot.record.ownerId !== this.ownerId
        || snapshot.record.generation !== generation) {
        throw new Error(`Completion outbox lock ownership lost for ${workspaceId}.`);
      }
      const next: WorkspaceLockRecord = { ...snapshot.record, heartbeatAt: Date.now(), mutation };
      await overwriteWorkspaceLockRecord(handle!, next);
      await handle!.sync();
      const confirmed = await this.#readLockSnapshot(lockPath);
      const confirmedMutation = confirmed?.record?.mutation;
      if (confirmed?.record?.token !== token || confirmed.record.generation !== generation
        || confirmedMutation?.transaction !== mutation?.transaction
        || confirmedMutation?.path !== mutation?.path) {
        throw new Error(`Completion outbox lock ownership lost for ${workspaceId}.`);
      }
    };
    const runLeaseUpdate = async (operation: () => Promise<void>): Promise<void> => {
      await heartbeat?.catch(() => undefined);
      if (heartbeatError) throw new Error(`Completion outbox lock ownership lost for ${workspaceId}.`, { cause: heartbeatError });
      let current!: Promise<void>;
      current = operation()
        .catch((error) => { heartbeatError = error; throw error; })
        .finally(() => { if (heartbeat === current) heartbeat = undefined; });
      heartbeat = current;
      await current;
    };
    const beginMutation = async (path: string, transaction: string): Promise<void> => {
      if (!REPLACEMENT_TRANSACTION.test(transaction)) throw new Error("Invalid completion mutation transaction.");
      const contained = relative(workspaceDir, resolve(path));
      if (!contained || contained.startsWith("..") || resolve(workspaceDir, contained) !== resolve(path)) {
        throw new Error(`Completion mutation path escapes workspace ${workspaceId}.`);
      }
      await runLeaseUpdate(async () => {
        const snapshot = await this.#readLockSnapshot(lockPath);
        if (snapshot?.record?.mutation) {
          throw new Error(`Completion outbox lock already has an active mutation for ${workspaceId}.`);
        }
        await writeLeaseRecord({ version: 1, path: contained, transaction });
      });
    };
    const finishMutation = async (transaction: string): Promise<void> => {
      await runLeaseUpdate(async () => {
        const snapshot = await this.#readLockSnapshot(lockPath);
        if (snapshot?.record?.mutation?.transaction !== transaction) {
          throw new Error(`Completion outbox lock ownership lost for ${workspaceId}.`);
        }
        await writeLeaseRecord(undefined);
      });
    };
    const timer = setInterval(() => {
      if (heartbeat) return;
      void runLeaseUpdate(async () => {
        const snapshot = await this.#readLockSnapshot(lockPath);
        await writeLeaseRecord(snapshot?.record?.mutation);
      }).catch(() => undefined);
    }, LOCK_HEARTBEAT_MS);
    timer.unref?.();
    const lease: WorkspaceLockLease = {
      path: lockPath,
      token,
      generation,
      assertOwned,
      assertOwnedSync,
      beginMutation,
      finishMutation,
    };
    try {
      await assertOwned();
      return await action(lease);
    } finally {
      clearInterval(timer);
      await heartbeat?.catch(() => undefined);
      // The lease has ended before release I/O begins. A canonical lock left by
      // a failed release is therefore reclaimable even though its pid is this
      // still-running process; active tokens from other in-process stores remain
      // fenced by the shared set.
      ACTIVE_WORKSPACE_LOCK_TOKENS.delete(token);
      await handle.close().catch(() => undefined);
      const current = await this.#readLockSnapshot(lockPath).catch(() => undefined);
      if (current?.record?.token === token && current.record.ownerId === this.ownerId) {
        const releasePath = `${lockPath}.release-${token}`;
        try {
          await renameWithRetry(lockPath, releasePath);
          persistenceBoundary("lock", "after-release-rename");
          await fsyncDirectory(workspaceDir);
          await rm(releasePath, { force: true });
          persistenceBoundary("lock", "after-release-remove");
          await fsyncDirectory(workspaceDir);
        } catch (error) {
          const remaining = await this.#readLockSnapshot(lockPath).catch(() => undefined);
          if (remaining?.record?.token === token && remaining.record.ownerId === this.ownerId) {
            try {
              await rm(lockPath, { force: true });
              await fsyncDirectory(workspaceDir);
            } catch (cleanupError) {
              throw new Error(`Completion outbox lock release failed for ${workspaceId}; ended token remains reclaimable.`, {
                cause: cleanupError,
              });
            }
            const afterCleanup = await this.#readLockSnapshot(lockPath).catch(() => undefined);
            if (afterCleanup?.record?.token === token) {
              throw new Error(`Completion outbox lock release failed for ${workspaceId}; ended token remains reclaimable.`, {
                cause: error,
              });
            }
          } else if (!REPLACE_ERRORS.has(fileCode(error) ?? "") && fileCode(error) !== "ENOENT") {
            throw error;
          }
        }
      }
    }
  }

  async #readLockSnapshot(path: string): Promise<{
    raw: string;
    record?: WorkspaceLockRecord;
    dev: number | bigint;
    ino: number | bigint;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
  } | undefined> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > WORKSPACE_LOCK_RECORD_BYTES) return undefined;
      const raw = await readFile(path, "utf8");
      const record = parseWorkspaceLockRecord(raw);
      return {
        raw,
        ...(record ? { record } : {}),
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
      };
    } catch (error) {
      if (fileCode(error) === "ENOENT") return undefined;
      throw error;
    }
  }

  #processState(pid: number): "alive" | "dead" | "unknown" {
    if (pid === process.pid) return "alive";
    try {
      process.kill(pid, 0);
      return "alive";
    } catch (error) {
      const code = fileCode(error);
      if (code === "ESRCH") return "dead";
      if (code === "EPERM") return "alive";
      return "unknown";
    }
  }

  #workspaceDir(workspaceId: string): string { return join(this.rootDir, hashPath(workspaceId)); }
  #sessionDir(target: CompletionTarget): string { return join(this.#workspaceDir(target.workspaceId), hashPath(target.sessionId)); }
  #stateDir(target: CompletionTarget, state: CompletionOutboxState): string { return join(this.#sessionDir(target), state); }
  #recordPath(target: CompletionTarget, state: CompletionOutboxState, deliveryId: string): string { return join(this.#stateDir(target, state), `${deliveryId}.json`); }
  #reservationPath(workspaceId: string, reservationId: string): string { return join(this.#workspaceDir(workspaceId), "reservations", `${hashPath(reservationId)}.json`); }

  #assertSeed(seed: CompletionDispatchSeed): void {
    if (!SAFE_ID.test(seed.dispatchId) || !SAFE_ID.test(seed.reservationId) || !boundedString(seed.deliveryGroupId, 128)
      || !boundedString(seed.originCwd, 4096)
      || !validTarget(seed.target) || !Array.isArray(seed.expectedTasks) || seed.expectedTasks.length > COMPLETION_OUTBOX_MAX_RESOURCES) {
      throw new Error("Invalid completion dispatch seed.");
    }
  }

  #assertIntent(intent: CompletionIntent): void {
    if (intent.version !== COMPLETION_OUTBOX_SCHEMA_VERSION || !SAFE_ID.test(intent.dispatchId)
      || !SAFE_ID.test(intent.reservationId) || !validTarget(intent.target)
      || Buffer.byteLength(intent.summary, "utf8") > COMPLETION_OUTBOX_MAX_SUMMARY_BYTES
      || intent.resources.length > COMPLETION_OUTBOX_MAX_RESOURCES
      || !HASH_ID.test(intent.contentRevision)) throw new Error("Invalid completion intent.");
  }
}
