import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  isRuntimeBrokerTransportError,
  probeRuntimeBrokerAuthority,
} from "./client.ts";
import {
  RUNTIME_BROKER_DAEMON_LOCK_FILE,
  RUNTIME_BROKER_PRIVATE_FILE_MODE,
  ensurePrivateRuntimeBrokerDirectory,
} from "./private-state.ts";

const MAX_LOCK_BYTES = 4096;
const MAX_IDENTITY_BYTES = 256;
const MAX_ACQUIRE_ATTEMPTS = 6;
const INCOMPLETE_LOCK_STALE_MS = 1_000;
const INCOMPLETE_LOCK_RETRY_MS = 25;
export const RUNTIME_BROKER_DAEMON_STARTUP_GRACE_MS = 1_000;

interface DaemonLockRecordV1 {
  version: 1;
  pid: number;
  token: string;
  startedAt: number;
}

interface DaemonLockRecordV2 {
  version: 2;
  pid: number;
  token: string;
  generation: string;
  startedAt: number;
}

type DaemonLockRecord = DaemonLockRecordV1 | DaemonLockRecordV2;

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

interface DaemonLeaseReleaseCleanup {
  path: string;
  dev: number;
  ino: number;
}

type DaemonLockInspection =
  | { kind: "complete"; snapshot: DaemonLockSnapshot }
  | { kind: "incomplete"; snapshot: IncompleteLockSnapshot };

export interface RuntimeBrokerDaemonIdentity {
  readonly pid: number;
  readonly token: string;
  readonly generation: string;
  readonly startedAt: number;
}

export interface RuntimeBrokerDaemonLease extends RuntimeBrokerDaemonIdentity {
  readonly lockPath: string;
  assertOwned(): void;
  release(): void;
}

export interface RuntimeBrokerDaemonLeaseOptions {
  pid?: number;
  now?: () => number;
  token?: () => string;
  generation?: () => string;
  processExists?: (pid: number) => boolean;
  proveAuthority?: (identity: RuntimeBrokerDaemonIdentity) => boolean | Promise<boolean>;
  startupGraceMs?: number;
}

export function runtimeBrokerProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function acquireRuntimeBrokerDaemonLease(
  stateDirectory: string,
  options: RuntimeBrokerDaemonLeaseOptions = {},
): Promise<RuntimeBrokerDaemonLease> {
  ensurePrivateRuntimeBrokerDirectory(stateDirectory);
  const lockPath = path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE);
  const pid = options.pid ?? process.pid;
  const token = (options.token ?? randomUUID)();
  const generation = (options.generation ?? randomUUID)();
  const now = options.now ?? Date.now;
  const startedAt = now();
  const processExists = options.processExists ?? runtimeBrokerProcessExists;
  const proveAuthority = options.proveAuthority ?? ((identity) => defaultProveAuthority(stateDirectory, identity));
  const startupGraceMs = options.startupGraceMs ?? RUNTIME_BROKER_DAEMON_STARTUP_GRACE_MS;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Runtime broker daemon PID must be a positive integer");
  if (!isDaemonIdentityPart(token)) throw new Error("Runtime broker daemon token must be a bounded non-empty string");
  if (!isDaemonIdentityPart(generation)) throw new Error("Runtime broker daemon generation must be a bounded non-empty string");
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
    throw new Error("Runtime broker daemon start time must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(startupGraceMs) || startupGraceMs < 0) {
    throw new Error("Runtime broker daemon startup grace must be a non-negative safe integer");
  }

  const record: DaemonLockRecordV2 = { version: 2, pid, token, generation, startedAt };
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
          const existing = lockIdentity(inspection.snapshot.record);
          const observedAt = now();
          if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
            throw new Error("Runtime broker daemon observation time must be a non-negative safe integer");
          }
          const age = observedAt - existing.startedAt;
          const pidIsLive = processExists(existing.pid);
          if (pidIsLive && age >= 0 && age < startupGraceMs) {
            throw new Error("Runtime broker daemon is already starting");
          }
          const authorityProven = await proveAuthority(existing);
          if (authorityProven) throw new Error("Runtime broker daemon is already running");
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

  const identity = { pid, token, generation, startedAt };
  let released = false;
  let pendingCleanup: DaemonLeaseReleaseCleanup | undefined;
  return {
    lockPath,
    ...identity,
    assertOwned() {
      const current = readLockSnapshot(lockPath);
      if (!isOwnedLock(current.record, identity)) {
        throw new Error("Runtime broker daemon lease authority was lost");
      }
    },
    release() {
      if (released) return;
      if (pendingCleanup) {
        finishDaemonLeaseReleaseCleanup(pendingCleanup);
        pendingCleanup = undefined;
        released = true;
        return;
      }

      let current: DaemonLockSnapshot;
      try {
        current = readLockSnapshot(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          released = true;
          return;
        }
        throw error;
      }
      if (!isOwnedLock(current.record, identity)) {
        released = true;
        return;
      }

      const cleanup: DaemonLeaseReleaseCleanup = {
        path: `${lockPath}.quarantine-${process.pid}-${randomUUID()}`,
        dev: current.dev,
        ino: current.ino,
      };
      try {
        fs.renameSync(lockPath, cleanup.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          released = true;
          return;
        }
        throw error;
      }
      pendingCleanup = cleanup;
      finishDaemonLeaseReleaseCleanup(cleanup);
      pendingCleanup = undefined;
      released = true;
    },
  };
}

async function defaultProveAuthority(
  stateDirectory: string,
  identity: RuntimeBrokerDaemonIdentity,
): Promise<boolean> {
  try {
    await probeRuntimeBrokerAuthority({
      stateDirectory,
      timeoutMs: 500,
      daemonToken: identity.token,
      generation: identity.generation,
    });
    return true;
  } catch (error) {
    if (isRuntimeBrokerTransportError(error)) return false;
    throw error;
  }
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
  const common = typeof record.pid === "number"
    && Number.isSafeInteger(record.pid)
    && record.pid > 0
    && isDaemonIdentityPart(record.token)
    && typeof record.startedAt === "number"
    && Number.isSafeInteger(record.startedAt)
    && record.startedAt >= 0;
  if (!common) return false;
  if (record.version === 1) {
    return keys.length === 4
      && keys[0] === "pid"
      && keys[1] === "startedAt"
      && keys[2] === "token"
      && keys[3] === "version";
  }
  return record.version === 2
    && keys.length === 5
    && keys[0] === "generation"
    && keys[1] === "pid"
    && keys[2] === "startedAt"
    && keys[3] === "token"
    && keys[4] === "version"
    && isDaemonIdentityPart(record.generation);
}

function lockIdentity(record: DaemonLockRecord): RuntimeBrokerDaemonIdentity {
  return {
    pid: record.pid,
    token: record.token,
    generation: record.version === 2 ? record.generation : record.token,
    startedAt: record.startedAt,
  };
}

function isOwnedLock(record: DaemonLockRecord, identity: RuntimeBrokerDaemonIdentity): boolean {
  return record.version === 2
    && record.pid === identity.pid
    && record.token === identity.token
    && record.generation === identity.generation;
}

function finishDaemonLeaseReleaseCleanup(cleanup: DaemonLeaseReleaseCleanup): void {
  let moved: fs.Stats;
  try {
    moved = fs.lstatSync(cleanup.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!moved.isFile() || moved.isSymbolicLink()
    || moved.dev !== cleanup.dev || moved.ino !== cleanup.ino) {
    // The canonical lock is already gone and this is no longer our inode.
    // Preserve the unexpected quarantine entry and treat ownership as lost.
    return;
  }
  fs.rmSync(cleanup.path);
}

function isDaemonIdentityPart(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_IDENTITY_BYTES
    && !value.includes("\0");
}

function removeStaleLock(lockPath: string, expected: DaemonLockSnapshot): void {
  const current = readLockSnapshot(lockPath);
  if (current.dev !== expected.dev || current.ino !== expected.ino
    || JSON.stringify(current.record) !== JSON.stringify(expected.record)) {
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
