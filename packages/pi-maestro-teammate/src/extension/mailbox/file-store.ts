/**
 * Atomic file-store for the durable mailbox state machine.
 * Every transition is an immutable file write + atomic rename + parent fsync.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type MailboxClaim,
  type MailboxEnvelope,
  type MailboxPaths,
  type MailboxState,
  type MailboxStateRecord,
  MAX_ENVELOPE_BYTES,
  MAX_PAYLOAD_BYTES,
  MESSAGE_ID_PATTERN,
  stateDirKey,
} from "./types.ts";

// The seen-marker payload is `{"key":<dedupKey>,"seenAt":<ms>}\n`, capped at
// MAX_SEEN_MARK_BYTES by both the write (writeJsonAtomic / tryMarkSeen) and the
// read (listSeen) paths. The dedup key is caller-supplied (requestId or
// correlationId) and never length-validated at the enqueue boundary, so cap it
// here — otherwise a large key overflows the write cap (markSeen throws) or, in
// tryMarkSeen, writes a marker listSeen then cannot read back (it silently
// skips it, defeating dedup). seenPath() already hashes the key, so this is a
// pure byte-safety bound, not a path-safety bound.
const MAX_SEEN_MARK_BYTES = 512;
const MAX_DEDUP_KEY_BYTES = 256;

// --- Path Construction ---

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
  };
}

export async function ensureMailboxDirectories(paths: MailboxPaths): Promise<void> {
  const dirs = [
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
  ];
  for (const dir of dirs) {
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

function seenPath(paths: MailboxPaths, key: string): string {
  // Hash the key so arbitrary request/correlation ids can never escape the
  // seen directory (a key containing separators must not become a path).
  const digest = createHash("sha256").update(key, "utf8").digest("hex");
  return join(paths.seenDir, `${digest}.seen`);
}

/** Build the seen-marker JSON object, bounding the caller-supplied dedup key
 *  so the serialized payload always fits MAX_SEEN_MARK_BYTES (the read cap in
 *  listSeen). A 13-digit ms + frame is ~34 bytes, leaving ~478 for the key; 256
 *  keeps a wide margin and matches the order of magnitude of other id caps. */
function buildSeenMark(key: string, seenAt: number): { key: string; seenAt: number } {
  const boundedKey = Buffer.byteLength(key, "utf8") > MAX_DEDUP_KEY_BYTES
    ? Buffer.from(key, "utf8").subarray(0, MAX_DEDUP_KEY_BYTES).toString("utf8")
    : key;
  return { key: boundedKey, seenAt };
}

// --- Fsync Helpers ---

async function fsyncDirectory(dirPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dirPath, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows does not support fsync on directories; tolerate EPERM/EINVAL/ENOSYS/EBADF.
    if (code !== "EPERM" && code !== "EINVAL" && code !== "ENOSYS" && code !== "EBADF") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// --- Atomic Write ---

const RENAME_RETRY_MS = 25;
const RENAME_MAX_RETRIES = 5;

async function renameWithRetry(temporary: string, path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows may transiently lock the destination (antivirus scan, concurrent
      // GC removal). Retry briefly before giving up — never silently corrupt.
      if ((code === "EPERM" || code === "EACCES" || code === "EEXIST")
        && attempt < RENAME_MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

async function writeJsonAtomic(path: string, value: unknown, maxBytes: number): Promise<void> {
  const payload = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (payload.byteLength > maxBytes) {
    throw new Error(`envelope exceeds ${maxBytes} byte limit (${payload.byteLength} bytes)`);
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(temporary, path);
    await fsyncDirectory(dirname(path));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

// --- Atomic Rename Transition ---

async function atomicTransition(
  paths: MailboxPaths,
  messageId: string,
  fromState: MailboxState,
  toState: MailboxState,
  record: MailboxStateRecord,
): Promise<boolean> {
  const source = envelopePath(paths, fromState, messageId);
  const target = envelopePath(paths, toState, messageId);
  try {
    await rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await fsyncDirectory(paths[stateDirKey(toState)]);
  // Write state record alongside the envelope in the target directory.
  await writeJsonAtomic(stateRecordPath(paths, toState, messageId), record, 4096);
  // Clean up old state record if it exists.
  await rm(stateRecordPath(paths, fromState, messageId), { force: true }).catch(() => undefined);
  return true;
}

// --- Envelope Hashing ---

function canonicalEnvelopeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalEnvelopeValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, canonicalEnvelopeValue(entry)]));
}

export function computeEnvelopeHash(envelope: Omit<MailboxEnvelope, "hash">): string {
  const canonical = JSON.stringify(canonicalEnvelopeValue(envelope));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function verifyEnvelopeHash(envelope: MailboxEnvelope): boolean {
  const { hash, ...rest } = envelope;
  return computeEnvelopeHash(rest) === hash;
}

/**
 * Reject symlinks, non-regular files, and oversized files before reading.
 * Guards against a same-user process planting a symlink to a device file
 * (readFile hang/OOM) or to arbitrary JSON that would otherwise be parsed as
 * an envelope. Matches the lstat pre-check pattern used by workspace-peers.
 */
async function isSafeRegularFile(path: string, maxBytes: number): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    if (stat.size > maxBytes) return false;
    return true;
  } catch {
    return false;
  }
}

// --- Public API ---

export interface FileStoreOptions {
  paths: MailboxPaths;
  now?: () => number;
}

export class MailboxFileStore {
  readonly paths: MailboxPaths;
  readonly #now: () => number;

  constructor(options: FileStoreOptions) {
    this.paths = options.paths;
    this.#now = options.now ?? Date.now;
  }

  /** Write an envelope to staging. Returns false if payload/envelope too large. */
  async writeStaging(envelope: MailboxEnvelope): Promise<void> {
    if (!MESSAGE_ID_PATTERN.test(envelope.messageId)) {
      throw new Error(`invalid messageId format: ${envelope.messageId}`);
    }
    const payloadBytes = Buffer.byteLength(envelope.payload, "utf8");
    if (payloadBytes > MAX_PAYLOAD_BYTES) {
      throw new Error(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes (${payloadBytes})`);
    }
    const path = envelopePath(this.paths, "staging", envelope.messageId);
    await writeJsonAtomic(path, envelope, MAX_ENVELOPE_BYTES);
  }

  /** Promote a staging envelope to ready. Atomic rename. */
  async promoteToReady(messageId: string): Promise<boolean> {
    const now = this.#now();
    return atomicTransition(this.paths, messageId, "staging", "ready", {
      messageId,
      state: "ready",
      transitionedAt: now,
      previousState: "staging",
    });
  }

  /** Claim a ready envelope. The claimerNonce provides ownership. */
  async claim(messageId: string, claim: MailboxClaim): Promise<boolean> {
    const now = this.#now();
    // Exclusive-create lock: on Windows, concurrent renames of the same source
    // can both report success, so claims are gated by an atomic "wx" lock file.
    // Only the consumer that creates the lock may claim; EEXIST losers return
    // false immediately without any file churn.
    const lockPath = claimLockPath(this.paths, messageId);
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ claimerNonce: claim.claimerNonce, claimedAt: claim.claimedAt }));
      await handle.sync();
      await handle.close();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false; // another consumer holds the lock
      throw error;
    }

    try {
      const transitioned = await atomicTransition(this.paths, messageId, "ready", "claimed", {
        messageId,
        state: "claimed",
        transitionedAt: now,
        previousState: "ready",
        claim,
      });
      if (!transitioned) {
        await rm(lockPath, { force: true }).catch(() => undefined);
        return false;
      }
      return true;
    } catch (error) {
      // Roll back the lock on any transition failure.
      await rm(lockPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Accept a claimed envelope (injection dispatched, awaiting IPC ack). */
  async accept(messageId: string, claim: MailboxClaim): Promise<boolean> {
    const now = this.#now();
    const transitioned = await atomicTransition(this.paths, messageId, "claimed", "accepted", {
      messageId,
      state: "accepted",
      transitionedAt: now,
      previousState: "claimed",
      claim,
    });
    if (transitioned) {
      // Release the claim lock — the message is now owned by the accepted state.
      await rm(claimLockPath(this.paths, messageId), { force: true }).catch(() => undefined);
    }
    return transitioned;
  }

  /** Apply an accepted envelope (IPC ack received). */
  async apply(messageId: string): Promise<boolean> {
    const now = this.#now();
    return atomicTransition(this.paths, messageId, "accepted", "applied", {
      messageId,
      state: "applied",
      transitionedAt: now,
      previousState: "accepted",
    });
  }

  /** Reject an envelope from ready or claimed state. */
  async reject(messageId: string, fromState: "ready" | "claimed", reason: string): Promise<boolean> {
    const now = this.#now();
    const transitioned = await atomicTransition(this.paths, messageId, fromState, "rejected", {
      messageId,
      state: "rejected",
      transitionedAt: now,
      previousState: fromState,
      reason,
    });
    if (transitioned && fromState === "claimed") {
      await rm(claimLockPath(this.paths, messageId), { force: true }).catch(() => undefined);
    }
    return transitioned;
  }

  /** Expire an envelope from ready state. */
  async expire(messageId: string): Promise<boolean> {
    const now = this.#now();
    return atomicTransition(this.paths, messageId, "ready", "expired", {
      messageId,
      state: "expired",
      transitionedAt: now,
      previousState: "ready",
    });
  }

  /** Move an envelope to dead-letter from any non-terminal state. */
  async dead(messageId: string, fromState: MailboxState, reason: string): Promise<boolean> {
    const now = this.#now();
    return atomicTransition(this.paths, messageId, fromState, "dead", {
      messageId,
      state: "dead",
      transitionedAt: now,
      previousState: fromState,
      reason,
    });
  }

  /** Renew a claim's lease and heartbeat. Rewrites the state record in-place. */
  async renewClaim(messageId: string, claim: MailboxClaim): Promise<void> {
    const path = stateRecordPath(this.paths, "claimed", messageId);
    const record: MailboxStateRecord = {
      messageId,
      state: "claimed",
      transitionedAt: this.#now(),
      previousState: "ready",
      claim,
    };
    await writeJsonAtomic(path, record, 4096);
  }

  /** Read an envelope from a specific state directory. */
  async readEnvelope(state: MailboxState, messageId: string): Promise<MailboxEnvelope | undefined> {
    const path = envelopePath(this.paths, state, messageId);
    if (!(await isSafeRegularFile(path, MAX_ENVELOPE_BYTES))) return undefined;
    try {
      const bytes = await readFile(path);
      if (bytes.byteLength > MAX_ENVELOPE_BYTES) return undefined;
      const envelope = JSON.parse(bytes.toString("utf8")) as MailboxEnvelope;
      // Envelopes are untrusted until their integrity hash checks out.
      if (typeof envelope !== "object" || envelope === null || !verifyEnvelopeHash(envelope)) return undefined;
      return envelope;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  /** Read the state record for a message in a specific state directory. */
  async readStateRecord(state: MailboxState, messageId: string): Promise<MailboxStateRecord | undefined> {
    const path = stateRecordPath(this.paths, state, messageId);
    if (!(await isSafeRegularFile(path, 4096))) return undefined;
    try {
      const bytes = await readFile(path);
      return JSON.parse(bytes.toString("utf8")) as MailboxStateRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  /** List message IDs in a specific state directory. */
  async listMessages(state: MailboxState): Promise<string[]> {
    try {
      const files = await readdir(this.paths[stateDirKey(state)]);
      return files
        .filter((f) => f.endsWith(".json") && !f.endsWith(".state.json") && !f.endsWith(".tmp"))
        .map((f) => f.slice(0, -5))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /**
   * List message IDs that have a state record but no envelope in the same
   * directory. These are orphaned by interrupted transitions or manual removal
   * and should be garbage collected.
   */
  async listOrphanStateRecords(state: MailboxState): Promise<string[]> {
    try {
      const files = await readdir(this.paths[stateDirKey(state)]);
      const envelopes = new Set(
        files
          .filter((f) => f.endsWith(".json") && !f.endsWith(".state.json") && !f.endsWith(".tmp"))
          .map((f) => f.slice(0, -5)),
      );
      return files
        .filter((f) => f.endsWith(".state.json"))
        .map((f) => f.slice(0, -".state.json".length))
        .filter((messageId) => !envelopes.has(messageId))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /** Remove an orphaned state record without touching any envelope. */
  async removeStateRecordOnly(state: MailboxState, messageId: string): Promise<void> {
    await rm(stateRecordPath(this.paths, state, messageId), { force: true }).catch(() => undefined);
  }

  /** Release a claim lock (no-op if absent). */
  async removeClaimLock(messageId: string): Promise<void> {
    await rm(claimLockPath(this.paths, messageId), { force: true }).catch(() => undefined);
  }

  /** True if a claim lock is currently held for the message. */
  async hasClaimLock(messageId: string): Promise<boolean> {
    try {
      await readFile(claimLockPath(this.paths, messageId));
      return true;
    } catch {
      return false;
    }
  }

  /** Check if a dedup key has been seen (durable deduplication). */
  async isSeen(key: string): Promise<boolean> {
    try {
      await readFile(seenPath(this.paths, key));
      return true;
    } catch {
      return false;
    }
  }

  /** Mark a dedup key as seen for durable deduplication. */
  async markSeen(key: string): Promise<void> {
    const path = seenPath(this.paths, key);
    await writeJsonAtomic(path, buildSeenMark(key, this.#now()), MAX_SEEN_MARK_BYTES);
  }

  /**
   * Atomically claim a dedup key via exclusive create ("wx"). Returns false
   * when the key was already seen. Unlike isSeen+markSeen this is race-free
   * across concurrent enqueues (same process or another process sharing the
   * mailbox directory).
   */
  async tryMarkSeen(key: string): Promise<boolean> {
    const path = seenPath(this.paths, key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const payload = Buffer.from(`${JSON.stringify(buildSeenMark(key, this.#now()))}\n`, "utf8");
    if (payload.byteLength > MAX_SEEN_MARK_BYTES) {
      throw new Error(`dedup marker exceeds ${MAX_SEEN_MARK_BYTES} byte limit (${payload.byteLength} bytes)`);
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(payload);
      await handle.sync();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /** Release a dedup key claimed by tryMarkSeen (enqueue failed after claim). */
  async unmarkSeen(key: string): Promise<void> {
    await rm(seenPath(this.paths, key), { force: true }).catch(() => undefined);
  }

  /** List all seen markers (filename + seenAt) for GC retention sweeping. */
  async listSeen(): Promise<Array<{ file: string; seenAt: number }>> {
    try {
      const files = await readdir(this.paths.seenDir);
      const records: Array<{ file: string; seenAt: number }> = [];
      for (const file of files) {
        if (!file.endsWith(".seen")) continue;
        const path = join(this.paths.seenDir, file);
        if (!(await isSafeRegularFile(path, MAX_SEEN_MARK_BYTES))) continue;
        try {
          const parsed = JSON.parse((await readFile(path)).toString("utf8")) as { seenAt?: unknown };
          if (parsed && typeof parsed.seenAt === "number") {
            records.push({ file, seenAt: parsed.seenAt });
          }
        } catch {
          // Unreadable marker: leave it; it is bounded in size and swept by TTL below.
        }
      }
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /** Remove a seen marker file by its listed name (GC). */
  async removeSeen(file: string): Promise<void> {
    await rm(join(this.paths.seenDir, file), { force: true }).catch(() => undefined);
  }

  /** Remove a message envelope and its state record from a state directory. */
  async remove(state: MailboxState, messageId: string): Promise<void> {
    await rm(envelopePath(this.paths, state, messageId), { force: true }).catch(() => undefined);
    await rm(stateRecordPath(this.paths, state, messageId), { force: true }).catch(() => undefined);
  }

  /** Count messages in a specific state. */
  async count(state: MailboxState): Promise<number> {
    return (await this.listMessages(state)).length;
  }

  /** Count total live messages (staging + ready + claimed + accepted). */
  async countLive(): Promise<number> {
    const [staging, ready, claimed, accepted] = await Promise.all([
      this.count("staging"),
      this.count("ready"),
      this.count("claimed"),
      this.count("accepted"),
    ]);
    return staging + ready + claimed + accepted;
  }
}
