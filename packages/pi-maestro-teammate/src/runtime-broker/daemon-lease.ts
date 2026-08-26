import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  RUNTIME_BROKER_DAEMON_LOCK_FILE,
  RUNTIME_BROKER_PRIVATE_FILE_MODE,
  ensurePrivateRuntimeBrokerDirectory,
} from "./private-state.ts";

const MAX_LOCK_BYTES = 4096;
const MAX_TOKEN_BYTES = 256;
const MAX_ACQUIRE_ATTEMPTS = 6;
const INCOMPLETE_LOCK_STALE_MS = 1_000;
const INCOMPLETE_LOCK_RETRY_MS = 25;

interface DaemonLockRecord {
  version: 1;
  pid: number;
  token: string;
  startedAt: number;
}

interface DaemonLockSnapshot {
  record: DaemonLockRecord;
  dev: number;
  ino: number;
}

interface IncompleteLockSnapshot {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  content: string;
}

type DaemonLockInspection =
  | { kind: "complete"; snapshot: DaemonLockSnapshot }
  | { kind: "incomplete"; snapshot: IncompleteLockSnapshot };

export interface RuntimeBrokerDaemonLease {
  readonly lockPath: string;
  readonly pid: number;
  readonly token: string;
  release(): void;
}

export interface RuntimeBrokerDaemonLeaseOptions {
  pid?: number;
  now?: () => number;
  token?: () => string;
  processExists?: (pid: number) => boolean;
}

export function runtimeBrokerProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireRuntimeBrokerDaemonLease(
  stateDirectory: string,
  options: RuntimeBrokerDaemonLeaseOptions = {},
): RuntimeBrokerDaemonLease {
  ensurePrivateRuntimeBrokerDirectory(stateDirectory);
  const lockPath = path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE);
  const pid = options.pid ?? process.pid;
  const token = (options.token ?? randomUUID)();
  const now = options.now ?? Date.now;
  const startedAt = now();
  const processExists = options.processExists ?? runtimeBrokerProcessExists;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Runtime broker daemon PID must be a positive integer");
  if (!isDaemonToken(token)) throw new Error("Runtime broker daemon token must be a bounded non-empty string");
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
    throw new Error("Runtime broker daemon start time must be a non-negative safe integer");
  }

  const record: DaemonLockRecord = { version: 1, pid, token, startedAt };
  const candidatePath = `${lockPath}.candidate-${pid}-${randomUUID()}`;
  const candidate = writeLockCandidate(candidatePath, record);
  let published = false;
  try {
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS && !published; attempt += 1) {
      try {
        fs.linkSync(candidatePath, lockPath);
        const current = fs.lstatSync(lockPath);
        if (!current.isFile() || current.isSymbolicLink()
          || current.dev !== candidate.dev || current.ino !== candidate.ino) {
          throw new Error("Runtime broker daemon lock changed while publishing");
        }
        published = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let inspection: DaemonLockInspection;
        try {
          inspection = inspectLock(lockPath);
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw readError;
        }
        if (inspection.kind === "complete") {
          if (processExists(inspection.snapshot.record.pid)) {
            throw new Error("Runtime broker daemon is already running");
          }
          removeStaleLock(lockPath, inspection.snapshot);
          continue;
        }
        if (recoverIncompleteLock(lockPath, inspection.snapshot, now())) continue;
        sleepSync(INCOMPLETE_LOCK_RETRY_MS);
      }
    }
    if (!published) throw new Error("Runtime broker daemon lock is contended or being initialized");
  } finally {
    quarantineAndRemove(candidatePath, candidate.dev, candidate.ino, "daemon lock candidate");
  }

  let released = false;
  return {
    lockPath,
    pid,
    token,
    release() {
      if (released) return;
      released = true;
      try {
        const current = readLockSnapshot(lockPath);
        if (current.record.token === token && current.record.pid === pid) {
          quarantineAndRemove(lockPath, current.dev, current.ino, "daemon lock");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

function writeLockCandidate(candidatePath: string, record: DaemonLockRecord): DaemonLockSnapshot {
  const descriptor = fs.openSync(candidatePath, "wx", RUNTIME_BROKER_PRIVATE_FILE_MODE);
  let identity: fs.Stats | undefined;
  let writeError: unknown;
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    if (process.platform !== "win32") fs.fchmodSync(descriptor, RUNTIME_BROKER_PRIVATE_FILE_MODE);
    fs.fsyncSync(descriptor);
    identity = fs.fstatSync(descriptor);
  } catch (error) {
    writeError = error;
  } finally {
    fs.closeSync(descriptor);
  }
  if (!identity) {
    try {
      fs.rmSync(candidatePath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT" && writeError === undefined) throw cleanupError;
    }
    throw writeError;
  }
  return { record, dev: identity.dev, ino: identity.ino };
}

function readLockSnapshot(lockPath: string): DaemonLockSnapshot {
  const inspection = inspectLock(lockPath);
  if (inspection.kind !== "complete") throw new Error("Invalid runtime broker daemon lock");
  return inspection.snapshot;
}

function inspectLock(lockPath: string): DaemonLockInspection {
  const before = fs.lstatSync(lockPath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_LOCK_BYTES) {
    throw new Error("Invalid runtime broker daemon lock");
  }
  const descriptor = fs.openSync(lockPath, "r");
  let opened: fs.Stats;
  let content: string;
  try {
    opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_LOCK_BYTES) {
      throw new Error("Runtime broker daemon lock changed while opening");
    }
    content = fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
  const after = fs.lstatSync(lockPath);
  if (!after.isFile() || after.isSymbolicLink()
    || opened.dev !== after.dev || opened.ino !== after.ino
    || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) {
    throw new Error("Runtime broker daemon lock changed while reading");
  }
  if (content.length === 0 || !content.endsWith("\n")) {
    return {
      kind: "incomplete",
      snapshot: {
        dev: after.dev,
        ino: after.ino,
        size: after.size,
        mtimeMs: after.mtimeMs,
        ctimeMs: after.ctimeMs,
        content,
      },
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("Invalid runtime broker daemon lock");
  }
  if (!isLockRecord(value)) throw new Error("Invalid runtime broker daemon lock");
  return { kind: "complete", snapshot: { record: value, dev: after.dev, ino: after.ino } };
}

function isLockRecord(value: unknown): value is DaemonLockRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length === 4
    && keys[0] === "pid"
    && keys[1] === "startedAt"
    && keys[2] === "token"
    && keys[3] === "version"
    && record.version === 1
    && typeof record.pid === "number"
    && Number.isSafeInteger(record.pid)
    && record.pid > 0
    && isDaemonToken(record.token)
    && typeof record.startedAt === "number"
    && Number.isSafeInteger(record.startedAt)
    && record.startedAt >= 0;
}

function isDaemonToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_TOKEN_BYTES
    && !value.includes("\0");
}

function removeStaleLock(lockPath: string, expected: DaemonLockSnapshot): void {
  const current = readLockSnapshot(lockPath);
  if (current.dev !== expected.dev || current.ino !== expected.ino
    || current.record.pid !== expected.record.pid
    || current.record.token !== expected.record.token
    || current.record.startedAt !== expected.record.startedAt) {
    throw new Error("Runtime broker daemon lock changed during stale recovery");
  }
  quarantineAndRemove(lockPath, current.dev, current.ino, "stale daemon lock");
}

function recoverIncompleteLock(lockPath: string, expected: IncompleteLockSnapshot, observedAt: number): boolean {
  const lastChange = Math.max(expected.mtimeMs, expected.ctimeMs);
  if (!Number.isFinite(observedAt) || observedAt - lastChange < INCOMPLETE_LOCK_STALE_MS) return false;
  sleepSync(INCOMPLETE_LOCK_RETRY_MS);
  let current: DaemonLockInspection;
  try {
    current = inspectLock(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  if (current.kind === "complete") return false;
  if (!sameIncompleteLock(current.snapshot, expected)) return false;
  quarantineAndRemove(lockPath, current.snapshot.dev, current.snapshot.ino, "incomplete daemon lock");
  return true;
}

function sameIncompleteLock(left: IncompleteLockSnapshot, right: IncompleteLockSnapshot): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.content === right.content;
}

function quarantineAndRemove(targetPath: string, expectedDev: number, expectedIno: number, label: string): void {
  const quarantinePath = `${targetPath}.quarantine-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(targetPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const moved = fs.lstatSync(quarantinePath);
  if (!moved.isFile() || moved.isSymbolicLink() || moved.dev !== expectedDev || moved.ino !== expectedIno) {
    try {
      fs.linkSync(quarantinePath, targetPath);
      fs.rmSync(quarantinePath);
    } catch {
      // Preserve the unexpected inode in quarantine rather than deleting it.
    }
    throw new Error(`Runtime broker ${label} changed before quarantine`);
  }
  fs.rmSync(quarantinePath);
}

function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}
