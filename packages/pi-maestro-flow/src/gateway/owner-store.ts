/** Gateway process ownership and stale detection for native durable state. */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  GATEWAY_DURABLE_RECORD_VERSION,
  type GatewayOwnerRecord,
} from "./contracts.ts";
import { parseGatewayOwnerRecord } from "./validation.ts";
import {
  gatewayOwnerPath,
  readGatewayJson,
  writeGatewayJsonAtomic,
} from "./state-paths.ts";

const MAX_OWNER_BYTES = 64 * 1024;
const properLockfile = createRequire(import.meta.url)("proper-lockfile") as {
  lock(filePath: string, options: {
    realpath: boolean;
    stale: number;
    update: number;
    retries: { retries: number; factor: number; minTimeout: number; maxTimeout: number; randomize: boolean };
  }): Promise<() => Promise<void>>;
};

export class GatewayOwnerStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayOwnerStoreError";
  }
}
export class GatewayOwnerActiveError extends GatewayOwnerStoreError {
  constructor(readonly owner: GatewayOwnerRecord) {
    super(`Gateway is already owned by pid ${owner.pid}`);
    this.name = "GatewayOwnerActiveError";
  }
}
export class GatewayOwnerConflictError extends GatewayOwnerStoreError {
  constructor(message = "Gateway owner token is stale") {
    super(message);
    this.name = "GatewayOwnerConflictError";
  }
}
export class GatewayOwnerIdentityMismatchError extends GatewayOwnerStoreError {
  constructor(message = "Gateway process identity does not match the expected command identity") {
    super(message);
    this.name = "GatewayOwnerIdentityMismatchError";
  }
}

export interface GatewayOwnerStoreOptions {
  path?: string;
  ownerPath?: string;
  now?: () => number;
  pid?: number;
  commandIdentity?: string;
  isProcessAlive?: (pid: number) => boolean;
  getProcessIdentity?: (pid: number) => string | null | Promise<string | null>;
}

export interface GatewayClaimOptions {
  pid?: number;
  ownerToken?: string;
  port?: number;
  socket?: string;
  commandIdentity?: string;
  startedAt?: number;
  expectedOwnerToken?: string;
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function defaultProcessIdentity(pid: number): string | null {
  if (pid === process.pid) return process.argv.join(" ");
  if (process.platform === "win32") {
    const script = `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"; if ($p) { [Console]::Out.Write($p.CommandLine) }`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 5_000, shell: false, windowsHide: true });
    return result.status === 0 && !result.error ? String(result.stdout || "").trim() || null : null;
  }
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`);
    return raw.toString("utf8").split("\0").filter(Boolean).join(" ") || null;
  } catch { return null; }
}

function positiveTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new GatewayOwnerStoreError(`${label} must be a non-negative safe integer`);
  return value;
}

function normalizeIdentity(value: string | undefined): string {
  const identity = value?.trim();
  if (!identity) throw new GatewayOwnerStoreError("commandIdentity must be non-empty");
  if (identity.length > 1024) throw new GatewayOwnerStoreError("commandIdentity is too long");
  return identity;
}

export class GatewayOwnerStore {
  readonly ownerPath: string;
  private readonly now: () => number;
  private readonly defaultPid: number;
  private readonly defaultCommandIdentity: string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly getProcessIdentity: (pid: number) => string | null | Promise<string | null>;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: GatewayOwnerStoreOptions = {}) {
    this.ownerPath = options.path ?? options.ownerPath ?? gatewayOwnerPath();
    this.now = options.now ?? (() => Date.now());
    this.defaultPid = options.pid ?? process.pid;
    this.defaultCommandIdentity = normalizeIdentity(options.commandIdentity ?? (process.argv.join(" ") || process.execPath));
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.getProcessIdentity = options.getProcessIdentity ?? defaultProcessIdentity;
  }

  async read(): Promise<GatewayOwnerRecord | undefined> {
    const raw = await readGatewayJson<unknown>(this.ownerPath, MAX_OWNER_BYTES);
    if (raw === undefined) return undefined;
    try { return parseGatewayOwnerRecord(raw); }
    catch (error) { throw new GatewayOwnerStoreError(`Invalid Gateway owner record: ${error instanceof Error ? error.message : String(error)}`); }
  }
  async load(): Promise<GatewayOwnerRecord | undefined> { return this.read(); }

  async claim(options: GatewayClaimOptions = {}): Promise<GatewayOwnerRecord> {
    return this.mutate(async () => {
      const current = await this.read();
      if (current) {
        if (options.expectedOwnerToken !== undefined && current.ownerToken !== options.expectedOwnerToken) {
          throw new GatewayOwnerConflictError();
        }
        const active = await this.isCurrentOwnerActive(current);
        if (active) throw new GatewayOwnerActiveError(current);
      } else if (options.expectedOwnerToken !== undefined) {
        throw new GatewayOwnerConflictError("Expected Gateway owner does not exist");
      }
      const record = this.buildRecord(options);
      await writeGatewayJsonAtomic(this.ownerPath, record, { mode: 0o600, maximumBytes: MAX_OWNER_BYTES });
      return record;
    });
  }

  /** Alias used by host startup code. */
  async acquire(options: GatewayClaimOptions = {}): Promise<GatewayOwnerRecord> { return this.claim(options); }

  async assertOwned(ownerToken: string): Promise<GatewayOwnerRecord> {
    const current = await this.read();
    if (!current || current.ownerToken !== ownerToken) throw new GatewayOwnerConflictError();
    if (!(await this.isCurrentOwnerActive(current))) throw new GatewayOwnerConflictError("Gateway owner process is stale");
    return current;
  }

  async isOwned(ownerToken: string): Promise<boolean> {
    try { await this.assertOwned(ownerToken); return true; } catch { return false; }
  }

  async assertExactOwned(ownerToken: string, expectedIdentity: string, expectedSocket?: string): Promise<GatewayOwnerRecord> {
    const current = await this.read();
    if (!current || current.ownerToken !== ownerToken) throw new GatewayOwnerConflictError();
    if (expectedSocket !== undefined && current.socket !== expectedSocket) throw new GatewayOwnerIdentityMismatchError("Gateway owner IPC address does not match the installed service");
    if (!this.isProcessAlive(current.pid)) throw new GatewayOwnerConflictError("Gateway owner process is stale");
    const observed = await this.getProcessIdentity(current.pid);
    if (current.commandIdentity !== expectedIdentity || observed === null || observed !== expectedIdentity) throw new GatewayOwnerIdentityMismatchError();
    return current;
  }

  async release(ownerToken: string): Promise<boolean> {
    return this.mutate(async () => {
      const current = await this.read();
      if (!current || current.ownerToken !== ownerToken) return false;
      // Re-read immediately before unlinking; release is owner-token fenced and
      // never removes a replacement owner installed by another generation.
      const latest = await this.read();
      if (!latest || latest.ownerToken !== ownerToken) return false;
      const { rm } = await import("node:fs/promises");
      await rm(this.ownerPath, { force: true });
      return true;
    });
  }
  async remove(ownerToken: string): Promise<boolean> { return this.release(ownerToken); }

  private buildRecord(options: GatewayClaimOptions): GatewayOwnerRecord {
    const pid = options.pid ?? this.defaultPid;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new GatewayOwnerStoreError("pid must be a positive safe integer");
    const ownerToken = options.ownerToken ?? `owner-${randomBytes(32).toString("base64url")}`;
    const commandIdentity = normalizeIdentity(options.commandIdentity ?? this.defaultCommandIdentity);
    const startedAt = positiveTimestamp(options.startedAt ?? this.now(), "startedAt");
    if (options.port !== undefined && options.socket !== undefined) throw new GatewayOwnerStoreError("port and socket are mutually exclusive");
    const endpoint = options.port === undefined && options.socket === undefined
      ? { socket: `${this.ownerPath}.sock` }
      : options.port === undefined ? { socket: options.socket! } : { port: options.port };
    return parseGatewayOwnerRecord({
      version: GATEWAY_DURABLE_RECORD_VERSION,
      pid,
      ownerToken,
      ...endpoint,
      commandIdentity,
      startedAt,
    });
  }

  private async isCurrentOwnerActive(owner: GatewayOwnerRecord): Promise<boolean> {
    if (!this.isProcessAlive(owner.pid)) return false;
    const observed = await this.getProcessIdentity(owner.pid);
    // If the platform cannot expose identity, fail closed: a live PID remains
    // occupied rather than being silently stolen. An explicit mismatch is stale.
    return observed === null || observed === owner.commandIdentity;
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    let releaseLocal!: () => void;
    const previous = this.mutationTail;
    this.mutationTail = new Promise<void>((resolve) => { releaseLocal = resolve; });
    await previous;
    await mkdir(dirname(this.ownerPath), { recursive: true, mode: 0o700 });
    let releaseFile: (() => Promise<void>) | undefined;
    try {
      releaseFile = await properLockfile.lock(this.ownerPath, {
        realpath: false,
        stale: 10_000,
        update: 2_000,
        retries: { retries: 50, factor: 1.2, minTimeout: 10, maxTimeout: 100, randomize: true },
      });
      return await operation();
    } finally {
      try {
        if (releaseFile) await releaseFile();
      } finally {
        releaseLocal();
      }
    }
  }
}

let defaultOwnerStore: GatewayOwnerStore | undefined;
export function getGatewayOwnerStore(options?: GatewayOwnerStoreOptions): GatewayOwnerStore {
  return options ? new GatewayOwnerStore(options) : (defaultOwnerStore ?? (defaultOwnerStore = new GatewayOwnerStore()));
}
export const createGatewayOwnerStore = (options?: GatewayOwnerStoreOptions): GatewayOwnerStore => new GatewayOwnerStore(options);

export async function readGatewayOwner(options?: GatewayOwnerStoreOptions): Promise<GatewayOwnerRecord | undefined> {
  return getGatewayOwnerStore(options).read();
}
export async function claimGatewayOwner(options: GatewayClaimOptions = {}, store?: GatewayOwnerStore): Promise<GatewayOwnerRecord> {
  return (store ?? getGatewayOwnerStore()).claim(options);
}
export async function releaseGatewayOwner(ownerToken: string, store?: GatewayOwnerStore): Promise<boolean> {
  return (store ?? getGatewayOwnerStore()).release(ownerToken);
}
