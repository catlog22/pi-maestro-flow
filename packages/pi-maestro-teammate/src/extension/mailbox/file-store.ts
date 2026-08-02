/**
 * Atomic file-store for the durable mailbox state machine.
 * Every transition is an immutable file write + atomic rename + parent fsync.
 */

import { createHash, randomUUID } from "node:crypto";
import {
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

function seenPath(paths: MailboxPaths, messageId: string): string {
  return join(paths.seenDir, `${messageId}.seen`);
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
    throw new Error(`payload exceeds ${maxBytes} byte limit (${payload.byteLength} bytes)`);
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

export function computeEnvelopeHash(envelope: Omit<MailboxEnvelope, "hash">): string {
  const canonical = JSON.stringify(envelope, Object.keys(envelope).sort());
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function verifyEnvelopeHash(envelope: MailboxEnvelope): boolean {
  const { hash, ...rest } = envelope;
  return computeEnvelopeHash(rest) === hash;
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
    return atomicTransition(this.paths, messageId, "ready", "claimed", {
      messageId,
      state: "claimed",
      transitionedAt: now,
      previousState: "ready",
      claim,
    });
  }

  /** Accept a claimed envelope (injection dispatched, awaiting IPC ack). */
  async accept(messageId: string, claim: MailboxClaim): Promise<boolean> {
    const now = this.#now();
    return atomicTransition(this.paths, messageId, "claimed", "accepted", {
      messageId,
      state: "accepted",
      transitionedAt: now,
      previousState: "claimed",
      claim,
    });
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
    return atomicTransition(this.paths, messageId, fromState, "rejected", {
      messageId,
      state: "rejected",
      transitionedAt: now,
      previousState: fromState,
      reason,
    });
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
    try {
      const bytes = await readFile(envelopePath(this.paths, state, messageId));
      if (bytes.byteLength > MAX_ENVELOPE_BYTES) return undefined;
      return JSON.parse(bytes.toString("utf8")) as MailboxEnvelope;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  /** Read the state record for a message in a specific state directory. */
  async readStateRecord(state: MailboxState, messageId: string): Promise<MailboxStateRecord | undefined> {
    try {
      const bytes = await readFile(stateRecordPath(this.paths, state, messageId));
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

  /** Check if a messageId has been seen (deduplication). */
  async isSeen(messageId: string): Promise<boolean> {
    try {
      await readFile(seenPath(this.paths, messageId));
      return true;
    } catch {
      return false;
    }
  }

  /** Mark a messageId as seen for durable deduplication. */
  async markSeen(messageId: string): Promise<void> {
    const path = seenPath(this.paths, messageId);
    await writeJsonAtomic(path, { messageId, seenAt: this.#now() }, 512);
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
