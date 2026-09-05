import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FileHandle } from "node:fs/promises";

export interface PrivateStateDurability {
  syncFile(path: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
}

export interface PrivateStateFs {
  mkdir: typeof mkdir;
  open: typeof open;
  readFile: typeof readFile;
  readdir: typeof readdir;
  rename: typeof rename;
  rm: typeof rm;
  stat: typeof stat;
}

export type ProcessIdentity = (pid: number, platform: NodeJS.Platform) => Promise<string | null>;
export type ProcessLiveness = (pid: number) => Promise<boolean | null>;

export interface PrivateStateLockOptions {
  directory: string;
  name: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  staleMs?: number;
  heartbeatMs?: number;
  pid?: number;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  processIdentity?: ProcessIdentity;
  processLiveness?: ProcessLiveness;
  enforcePrivate(path: string, kind: "directory" | "file"): Promise<void>;
  durability: PrivateStateDurability;
  fs?: Partial<PrivateStateFs>;
  fault?: (point: string) => Promise<void>;
}

export interface PrivateStateLock {
  readonly instance: string;
  readonly token: string;
  assertOwned(): Promise<void>;
  release(): Promise<boolean>;
}

interface OwnerRecord {
  version: 1;
  instance: string;
  token: string;
  pid: number;
  processIdentity: string;
  createdAt: number;
}

const OWNER = "owner.json";
const HEARTBEAT = "heartbeat";
const DEFAULT_FS: PrivateStateFs = { mkdir, open, readFile, readdir, rename, rm, stat };

/**
 * A cooperative, crash-reclaimable lock whose identity never changes in place.
 * The owner record is immutable and heartbeat writes retain the originally opened
 * file handle, so a quarantined predecessor cannot write into a successor lock.
 */
export async function acquirePrivateStateLock(options: PrivateStateLockOptions): Promise<PrivateStateLock> {
  if (basename(options.name) !== options.name || !/^[a-z0-9._-]+$/iu.test(options.name)) throw new Error("invalid private-state lock name");
  const fs = { ...DEFAULT_FS, ...options.fs };
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const wait = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const identity = options.processIdentity ?? defaultProcessIdentity;
  const liveness = options.processLiveness ?? defaultProcessLiveness;
  const pid = options.pid ?? process.pid;
  const processIdentity = await identity(pid, platform);
  if (!processIdentity) throw new Error("process identity unavailable");
  const owner: OwnerRecord = { version: 1, instance: randomUUID(), token: randomUUID(), pid, processIdentity, createdAt: now() };
  const lockPath = join(options.directory, options.name);
  const deadline = now() + (options.timeoutMs ?? 30_000);
  let heartbeatHandle: FileHandle | undefined;

  while (!heartbeatHandle) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      await options.enforcePrivate(lockPath, "directory");
      heartbeatHandle = await createOwner(lockPath, owner, options, fs, now());
      await options.durability.syncDirectory(options.directory);
    } catch (error) {
      await heartbeatHandle?.close().catch(() => undefined);
      heartbeatHandle = undefined;
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await removeIncompleteOwnedLock(lockPath, owner, fs).catch(() => undefined);
        throw error;
      }
      if (await staleByAge(lockPath, options.staleMs ?? 10_000, fs, now)) {
        await reclaim(lockPath, owner.token, options, fs, identity, liveness).catch(() => false);
      }
      if (now() >= deadline) throw new Error("private-state lock timeout");
      await wait(Math.min(50, Math.max(1, deadline - now())));
    }
  }

  let lost = false;
  let heartbeatRunning = false;
  const retained = heartbeatHandle;
  const interval = setInterval(() => {
    if (lost || heartbeatRunning) return;
    heartbeatRunning = true;
    void writeHeartbeat(retained, now()).then(() => options.fault?.("lock:heartbeat")).catch(() => { lost = true; }).finally(() => { heartbeatRunning = false; });
  }, options.heartbeatMs ?? 1_000);
  interval.unref?.();

  const assertOwned = async (): Promise<void> => {
    if (lost || !(await exactOwner(lockPath, owner, fs))) { lost = true; throw new Error("private-state lock ownership lost"); }
    const canonical = await fs.stat(join(lockPath, HEARTBEAT));
    const held = await retained.stat();
    if (canonical.dev !== held.dev || canonical.ino !== held.ino) { lost = true; throw new Error("private-state lock ownership lost"); }
  };

  return {
    instance: owner.instance,
    token: owner.token,
    assertOwned,
    async release(): Promise<boolean> {
      clearInterval(interval);
      while (heartbeatRunning) await wait(1);
      const quarantine = join(options.directory, `.${options.name}.${owner.instance}.release-${randomUUID()}`);
      let releaseMarker: FileHandle | undefined;
      try {
        await assertOwned();
        releaseMarker = await fs.open(join(lockPath, `.release-${owner.token}`), "wx", 0o600);
        await releaseMarker.sync(); await releaseMarker.close(); releaseMarker = undefined;
        const entries = await fs.readdir(lockPath);
        if (entries.some((name) => name.startsWith(".reclaim-"))) { await retained.close(); return false; }
        // Windows does not allow the directory rename while this handle is open.
        // The immutable release marker fences reclaim before the retained handle closes.
        await retained.close();
        if (!(await exactOwner(lockPath, owner, fs))) return false;
        await options.fault?.("lock:release-before-quarantine");
        await fs.rename(lockPath, quarantine);
        await options.durability.syncDirectory(options.directory);
        if (!(await exactOwner(quarantine, owner, fs))) return false;
        await fs.rm(quarantine, { recursive: true, force: false });
        await options.durability.syncDirectory(options.directory);
        return true;
      } catch {
        await retained.close().catch(() => undefined);
        return false;
      } finally { await releaseMarker?.close().catch(() => undefined); }
    },
  };
}

async function createOwner(lockPath: string, owner: OwnerRecord, options: PrivateStateLockOptions, fs: PrivateStateFs, at: number): Promise<FileHandle> {
  const bytes = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
  let ownerHandle: FileHandle | undefined;
  let heartbeat: FileHandle | undefined;
  try {
    ownerHandle = await fs.open(join(lockPath, OWNER), "wx", 0o600);
    await ownerHandle.writeFile(bytes);
    await options.enforcePrivate(join(lockPath, OWNER), "file");
    await ownerHandle.sync();
    await ownerHandle.close(); ownerHandle = undefined;
    heartbeat = await fs.open(join(lockPath, HEARTBEAT), "wx+", 0o600);
    await options.enforcePrivate(join(lockPath, HEARTBEAT), "file");
    await writeHeartbeat(heartbeat, at);
    await options.durability.syncDirectory(lockPath);
    return heartbeat;
  } finally {
    bytes.fill(0);
    await ownerHandle?.close().catch(() => undefined);
    if (!heartbeat) await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeHeartbeat(handle: FileHandle, at: number): Promise<void> {
  const bytes = Buffer.from(`${String(Math.max(0, Math.trunc(at))).padStart(16, "0")}\n`, "ascii");
  try { await handle.truncate(0); await handle.write(bytes, 0, bytes.length, 0); await handle.sync(); }
  finally { bytes.fill(0); }
}

async function staleByAge(lockPath: string, staleMs: number, fs: PrivateStateFs, now: () => number): Promise<boolean> {
  try {
    const raw = await fs.readFile(join(lockPath, HEARTBEAT));
    try {
      const text = raw.toString("ascii");
      if (!/^\d{16}\n$/u.test(text)) return false;
      return now() - Number(text.trim()) > staleMs;
    } finally { raw.fill(0); }
  } catch { return false; }
}

async function reclaim(lockPath: string, contenderToken: string, options: PrivateStateLockOptions, fs: PrivateStateFs, identity: ProcessIdentity, liveness: ProcessLiveness): Promise<boolean> {
  const captured = await readOwner(lockPath, fs);
  if (!captured) return false;
  if (!(await deathOrReuseProven(captured, options.platform ?? process.platform, identity, liveness))) return false;
  const marker = join(lockPath, `.reclaim-${captured.token}`);
  let markerHandle: FileHandle | undefined;
  try {
    markerHandle = await fs.open(marker, "wx", 0o600);
    await markerHandle.writeFile(`${contenderToken}\n`);
    await markerHandle.sync();
    await markerHandle.close(); markerHandle = undefined;
    if (!(await exactOwner(lockPath, captured, fs))) return false;
    if (!(await deathOrReuseProven(captured, options.platform ?? process.platform, identity, liveness))) return false;
    await options.fault?.("lock:reclaim-before-quarantine");
    const quarantine = join(options.directory, `.${options.name}.${captured.instance}.stale-${randomUUID()}`);
    await fs.rename(lockPath, quarantine);
    await options.durability.syncDirectory(options.directory);
    if (!(await exactOwner(quarantine, captured, fs))) return false;
    await fs.rm(quarantine, { recursive: true, force: false });
    await options.durability.syncDirectory(options.directory);
    return true;
  } catch { return false; }
  finally { await markerHandle?.close().catch(() => undefined); }
}

async function deathOrReuseProven(owner: OwnerRecord, platform: NodeJS.Platform, identity: ProcessIdentity, liveness: ProcessLiveness): Promise<boolean> {
  const live = await liveness(owner.pid);
  if (live === false) return true;
  if (live !== true) return false;
  const actual = await identity(owner.pid, platform);
  return actual !== null && actual !== owner.processIdentity;
}

async function readOwner(lockPath: string, fs: PrivateStateFs): Promise<OwnerRecord | null> {
  let raw: Buffer;
  try { raw = await fs.readFile(join(lockPath, OWNER)); } catch { return null; }
  try {
    if (raw.length > 2048) return null;
    const value = JSON.parse(raw.toString("utf8")) as Partial<OwnerRecord>;
    if (value.version !== 1 || typeof value.instance !== "string" || !/^[0-9a-f-]{36}$/u.test(value.instance)
      || typeof value.token !== "string" || !/^[0-9a-f-]{36}$/u.test(value.token) || !Number.isSafeInteger(value.pid) || (value.pid ?? 0) < 1
      || typeof value.processIdentity !== "string" || value.processIdentity.length < 1 || value.processIdentity.length > 512
      || !Number.isSafeInteger(value.createdAt)) return null;
    return value as OwnerRecord;
  } catch { return null; }
  finally { raw.fill(0); }
}

async function exactOwner(lockPath: string, expected: OwnerRecord, fs: PrivateStateFs): Promise<boolean> {
  const actual = await readOwner(lockPath, fs);
  return actual !== null && actual.version === expected.version && actual.instance === expected.instance && actual.token === expected.token
    && actual.pid === expected.pid && actual.processIdentity === expected.processIdentity && actual.createdAt === expected.createdAt;
}

async function removeIncompleteOwnedLock(lockPath: string, expected: OwnerRecord, fs: PrivateStateFs): Promise<void> {
  if (await exactOwner(lockPath, expected, fs)) await fs.rm(lockPath, { recursive: true, force: true });
}

export async function defaultProcessLiveness(pid: number): Promise<boolean | null> {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null; }
}

export async function defaultProcessIdentity(pid: number, platform: NodeJS.Platform): Promise<string | null> {
  try {
    if (platform === "linux") {
      const [bootRaw, statRaw] = await Promise.all([readFile("/proc/sys/kernel/random/boot_id", "utf8"), readFile(`/proc/${pid}/stat`, "utf8")]);
      const close = statRaw.lastIndexOf(")");
      const fields = statRaw.slice(close + 2).trim().split(/\s+/u);
      const startTicks = fields[19];
      return close > 0 && startTicks && /^\d+$/u.test(startTicks) ? `linux:${bootRaw.trim()}:${startTicks}` : null;
    }
    if (platform === "win32") {
      const script = "$ErrorActionPreference='Stop';$p=[Diagnostics.Process]::GetProcessById([int]$env:PI_MAESTRO_PID);[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)";
      const result = await execFileText("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { ...process.env, PI_MAESTRO_PID: String(pid) });
      return /^\d+$/u.test(result) ? `win32:${result}` : null;
    }
    if (platform === "darwin" || platform === "freebsd" || platform === "openbsd" || platform === "netbsd") {
      const result = await execFileText("ps", ["-o", "lstart=", "-p", String(pid)], process.env);
      return result ? `${platform}:${result.replace(/\s+/gu, " ")}` : null;
    }
    return null;
  } catch { return null; }
}

function execFileText(executable: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => execFile(executable, [...args], { env, windowsHide: true, timeout: 5_000, maxBuffer: 4096 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
}
