import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

const STATE_DIRS: readonly CompletionOutboxState[] = ["wal", "pending", "queued", "applied", "dead", "expired"];
const LIVE_STATES = new Set<CompletionOutboxState>(["wal", "pending", "queued"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HASH_ID = /^[a-f0-9]{64}$/;
const LOCK_STALE_MS = 2 * 60_000;
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

interface StoreOptions {
  rootDir?: string;
  now?: () => number;
  ownerId?: string;
  maxLiveRecords?: number;
  maxLiveBytes?: number;
}

function fileCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
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
      if ((code === "EPERM" || code === "EACCES" || code === "EEXIST") && attempt < RENAME_MAX_RETRIES) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

async function writeJsonAtomic(path: string, value: unknown, maxBytes = COMPLETION_OUTBOX_MAX_RECORD_BYTES): Promise<void> {
  const payload = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (payload.byteLength > maxBytes) throw new Error(`Completion outbox record exceeds ${maxBytes} bytes (${payload.byteLength}).`);
  await ensureRealDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await renameWithRetry(temporary, path);
    } catch (error) {
      if (fileCode(error) !== "EEXIST" && fileCode(error) !== "EPERM") throw error;
      await rm(path, { force: true });
      await renameWithRetry(temporary, path);
    }
    await fsyncDirectory(dirname(path));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readSafeJson(path: string, maxBytes = COMPLETION_OUTBOX_MAX_RECORD_BYTES): Promise<unknown | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) return undefined;
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (fileCode(error) === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
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
    return this.#withWorkspaceLock(seed.target.workspaceId, async () => {
      await this.#maybeReserveGc(seed.target.workspaceId);
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
      await writeJsonAtomic(this.#reservationPath(seed.target.workspaceId, seed.reservationId), record);
      return record;
    });
  }

  async releaseReservation(target: CompletionTarget, reservationId: string): Promise<boolean> {
    return this.#withWorkspaceLock(target.workspaceId, async () => {
      const current = await this.#readReservation(target.workspaceId, reservationId);
      if (!current || !targetEquals(current.target, target)) return false;
      if (current.state === "released") return true;
      const now = this.#now();
      await writeJsonAtomic(this.#reservationPath(target.workspaceId, reservationId), {
        ...current,
        state: "released",
        updatedAt: now,
        expiresAt: now + COMPLETION_OUTBOX_RESERVATION_TERMINAL_TTL_MS,
      } satisfies CompletionReservationRecord);
      return true;
    });
  }

  async importIntent(intent: CompletionIntent): Promise<CompletionOutboxRecord> {
    this.#assertIntent(intent);
    const deliveryId = computeCompletionDeliveryId(intent);
    if (deliveryId !== intent.deliveryId) throw new Error(`Completion intent deliveryId mismatch for ${intent.dispatchId}.`);
    return this.#withWorkspaceLock(intent.target.workspaceId, async () => {
      const existing = await this.#findRecord(intent.target, deliveryId);
      const reservation = await this.#readReservation(intent.target.workspaceId, intent.reservationId);
      if (existing) {
        let recovered = existing.state === "wal"
          ? await this.#replaceRecord(existing, { state: "pending", updatedAt: this.#now(), nextAttemptAt: this.#now() })
          : existing;
        if (recovered.intentRevision === undefined) {
          recovered = await this.#replaceRecord(recovered, { intentRevision: intent.contentRevision });
        } else if (recovered.intentRevision !== intent.contentRevision) {
          throw new Error(`Completion intent revision mismatch for ${intent.dispatchId}.`);
        }
        if (reservation?.state === "reserved" && targetEquals(reservation.target, intent.target)) {
          await this.#consumeReservation(reservation, this.#now());
        }
        return recovered;
      }
      if (!reservation || reservation.state !== "reserved" || !targetEquals(reservation.target, intent.target)) {
        throw new Error(`No live completion reservation ${intent.reservationId} for ${deliveryId}.`);
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
      await writeJsonAtomic(this.#recordPath(intent.target, "wal", deliveryId), wal);
      const pendingBase = { ...base, state: "pending" as const };
      const pending = { ...pendingBase, contentRevision: computeCompletionContentRevision(pendingBase) };
      await writeJsonAtomic(this.#recordPath(intent.target, "pending", deliveryId), pending);
      await rm(this.#recordPath(intent.target, "wal", deliveryId), { force: true });
      await this.#consumeReservation(reservation, now);
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
    return this.#withWorkspaceLock(target.workspaceId, async () => {
      const current = await this.#findRecord(target, deliveryId);
      if (!current || (current.state !== "pending" && current.state !== "queued")) return undefined;
      const now = this.#now();
      // Expired records must never be delivered even before GC reaches them.
      if (current.expiresAt <= now) {
        await this.#replaceRecord(current, { state: "expired", updatedAt: now });
        return undefined;
      }
      if (current.claimOwnerId && current.claimOwnerId !== this.ownerId && (current.claimExpiresAt ?? 0) > now) return undefined;
      return this.#replaceRecord(current, {
        claimOwnerId: this.ownerId,
        claimExpiresAt: now + COMPLETION_OUTBOX_CLAIM_MS,
        updatedAt: now,
      });
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
    return this.#withWorkspaceLock(workspaceId, () => this.#gcLocked(workspaceId));
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
      async () => {
        // Re-check the marker inside the lock to close the TOCTOU window between
        // the lock-free read above and acquisition: another process may have just
        // finished a sweep and written the marker while we waited.
        const fresh = await readSafeJson(markerPath, 64);
        const freshAt = fresh && typeof fresh === "object" && "at" in fresh && typeof (fresh as { at: unknown }).at === "number"
          ? (fresh as { at: number }).at : 0;
        if (freshAt > 0 && now - freshAt < TRY_GC_MARKER_MIN_INTERVAL_MS) {
          return { ...empty, skipped: true };
        }
        const swept = await this.#gcLocked(workspaceId);
        await writeJsonAtomic(markerPath, { at: this.#now(), owner: this.ownerId }, 64);
        return swept;
      },
      0,
    );
    return result ?? { ...empty, busy: true };
  }

  async #transition(
    target: CompletionTarget,
    deliveryId: string,
    allowed: readonly CompletionOutboxState[],
    nextState: CompletionOutboxState,
    patch: (current: CompletionOutboxRecord, now: number) => Partial<CompletionOutboxRecord>,
  ): Promise<CompletionOutboxRecord | undefined> {
    return this.#withWorkspaceLock(target.workspaceId, async () => {
      const current = await this.#findRecord(target, deliveryId);
      if (!current || !allowed.includes(current.state)) return undefined;
      return this.#replaceRecord(current, { ...patch(current, this.#now()), state: nextState, updatedAt: this.#now() });
    });
  }

  async #replaceRecord(current: CompletionOutboxRecord, patch: Partial<CompletionOutboxRecord>): Promise<CompletionOutboxRecord> {
    const monotonicPatch = {
      ...patch,
      updatedAt: Math.max(patch.updatedAt ?? current.updatedAt + 1, current.updatedAt + 1),
    };
    const { contentRevision: _revision, ...base } = { ...current, ...monotonicPatch };
    const next = { ...base, contentRevision: computeCompletionContentRevision(base) };
    if (!validRecord(next)) throw new Error(`Invalid completion outbox transition for ${current.deliveryId}.`);
    await writeJsonAtomic(this.#recordPath(current.target, next.state, next.deliveryId), next);
    if (current.state !== next.state) await rm(this.#recordPath(current.target, current.state, current.deliveryId), { force: true });
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
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const raw = await readSafeJson(join(dir, name));
      if (validRecord(raw) && targetEquals(raw.target, target) && raw.state === state) records.push(raw);
    }
    return records;
  }

  async #usageLocked(workspaceId: string): Promise<CompletionOutboxUsage> {
    const workspaceDir = this.#workspaceDir(workspaceId);
    let sessionNames: string[] = [];
    try { sessionNames = (await readdir(workspaceDir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name !== "reservations").map((entry) => entry.name); } catch (error) {
      if (fileCode(error) !== "ENOENT") throw error;
    }
    let liveRecords = 0;
    let liveBytes = 0;
    for (const sessionName of sessionNames) {
      for (const state of LIVE_STATES) {
        const dir = join(workspaceDir, sessionName, state);
        try {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
            liveRecords += 1;
            liveBytes += (await stat(join(dir, entry.name))).size;
          }
        } catch (error) { if (fileCode(error) !== "ENOENT") throw error; }
      }
    }
    let reservations = 0;
    try {
      for (const entry of await readdir(join(workspaceDir, "reservations"), { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const raw = await readSafeJson(join(workspaceDir, "reservations", entry.name));
        if (!validReservation(raw) || raw.state !== "reserved") continue;
        reservations += 1;
        liveRecords += 1;
        liveBytes += raw.reservedBytes;
      }
    } catch (error) { if (fileCode(error) !== "ENOENT") throw error; }
    return { liveRecords, liveBytes, reservations };
  }

  async #gcLocked(workspaceId: string): Promise<CompletionOutboxGcResult> {
    const now = this.#now();
    const result: CompletionOutboxGcResult = { expired: 0, removed: 0, releasedReservations: 0 };
    const workspaceDir = this.#workspaceDir(workspaceId);
    let sessionNames: string[] = [];
    try { sessionNames = (await readdir(workspaceDir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name !== "reservations").map((entry) => entry.name); } catch (error) {
      if (fileCode(error) === "ENOENT") return result;
      throw error;
    }
    for (const sessionName of sessionNames) {
      for (const state of STATE_DIRS) {
        const dir = join(workspaceDir, sessionName, state);
        let names: string[] = [];
        try { names = await readdir(dir); } catch (error) { if (fileCode(error) !== "ENOENT") throw error; }
        for (const name of names) {
          if (!name.endsWith(".json")) continue;
          const path = join(dir, name);
          const raw = await readSafeJson(path);
          if (!validRecord(raw)) continue;
          if (LIVE_STATES.has(raw.state) && raw.expiresAt <= now) {
            const base = { ...raw, state: "expired" as const, updatedAt: now, expiresAt: now + COMPLETION_OUTBOX_TERMINAL_TTL_MS };
            const { contentRevision: _revision, ...semantic } = base;
            const expired = { ...semantic, contentRevision: computeCompletionContentRevision(semantic) };
            await writeJsonAtomic(join(workspaceDir, sessionName, "expired", `${raw.deliveryId}.json`), expired);
            await rm(path, { force: true });
            result.expired += 1;
          } else if (!LIVE_STATES.has(raw.state) && raw.expiresAt <= now) {
            await rm(path, { force: true });
            result.removed += 1;
          }
        }
      }
    }
    const reservationsDir = join(workspaceDir, "reservations");
    let reservationNames: string[] = [];
    try { reservationNames = await readdir(reservationsDir); } catch (error) { if (fileCode(error) !== "ENOENT") throw error; }
    for (const name of reservationNames) {
      if (!name.endsWith(".json")) continue;
      const path = join(reservationsDir, name);
      const raw = await readSafeJson(path);
      if (!validReservation(raw) || raw.expiresAt > now) continue;
      await rm(path, { force: true });
      result.releasedReservations += 1;
    }
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
  async #maybeReserveGc(workspaceId: string): Promise<void> {
    const now = this.#now();
    const last = this.#lastReserveGcAt.get(workspaceId) ?? 0;
    if (now - last < RESERVE_GC_MIN_INTERVAL_MS) return;
    await this.#gcLocked(workspaceId);
    this.#lastReserveGcAt.set(workspaceId, now);
  }

  async #consumeReservation(reservation: CompletionReservationRecord, now: number): Promise<void> {
    await writeJsonAtomic(this.#reservationPath(reservation.target.workspaceId, reservation.reservationId), {
      ...reservation,
      state: "consumed",
      updatedAt: now,
      expiresAt: now + COMPLETION_OUTBOX_RESERVATION_TERMINAL_TTL_MS,
    } satisfies CompletionReservationRecord);
  }

  async #readReservation(workspaceId: string, reservationId: string): Promise<CompletionReservationRecord | undefined> {
    if (!SAFE_ID.test(reservationId)) return undefined;
    const raw = await readSafeJson(this.#reservationPath(workspaceId, reservationId));
    return validReservation(raw) ? raw : undefined;
  }

  async #withWorkspaceLock<T>(workspaceId: string, action: () => Promise<T>, waitMs: number = LOCK_WAIT_MS): Promise<T> {
    if (!boundedString(workspaceId, 128)) throw new Error("Invalid completion workspaceId.");
    const workspaceDir = this.#workspaceDir(workspaceId);
    await ensureRealDirectory(this.rootDir);
    await ensureRealDirectory(workspaceDir);
    const lockPath = join(workspaceDir, ".store.lock");
    const deadline = Date.now() + waitMs;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    while (!handle) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(`${this.ownerId}\n`);
      } catch (error) {
        const code = fileCode(error);
        // Windows may transiently deny exclusive-create with EPERM/EACCES —
        // antivirus scan, a concurrent holder still releasing the lock, or a
        // racing rm that has not flushed yet. Treat it the same as EEXIST and
        // retry within the wait window; never crash the process on a transient
        // lock contention. Mirrors renameWithRetry's EPERM/EACCES/EEXIST set.
        if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw error;
        const info = await stat(lockPath).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
        if (waitMs <= 0 || Date.now() >= deadline) {
          // Non-blocking callers (tryGc) treat a contended lock as "busy" rather
          // than throwing — a maintenance sweep must never crash or warn on
          // transient contention with concurrent writers.
          if (waitMs <= 0) return undefined as T;
          throw new Error(`Timed out acquiring completion outbox lock for ${workspaceId}.`);
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
      }
    }
    try {
      return await action();
    } finally {
      await handle.close().catch(() => undefined);
      await rm(lockPath, { force: true }).catch(() => undefined);
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
