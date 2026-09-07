/** Local authenticated lifecycle and state client used by the `/mcpx` compatibility UI. */
import { randomUUID } from "node:crypto";
import { spawnSync, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import crossSpawn from "cross-spawn";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayOwnerRecord, GatewayWorkspace } from "./contracts.ts";
import { loadGatewayConfig, type GatewayConfig } from "./config.ts";
import { requestGatewayIpcControl } from "./ipc.ts";
import { GatewayOwnerStore } from "./owner-store.ts";
import { canonicalizeWorkspacePath, gatewayConfigPath, gatewayOwnerPath, gatewayTasksRoot, gatewayWorkspaceRegistryPath } from "./state-paths.ts";
import { TaskJournal, type GatewayTaskJournalRecord } from "./task-journal.ts";
import { WorkspaceRegistry, type WorkspaceUnregisterOptions } from "./workspace-registry.ts";

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const STATUS_TIMEOUT_MS = 1_000;
const POLL_MS = 100;

export interface GatewayBinaryInfo {
  path: string;
  version: string;
  source: "override" | "legacy-alias" | "package" | "path";
  command?: string;
  argsPrefix?: string[];
}

export interface GatewayControlStatus {
  online: boolean;
  owner?: GatewayOwnerRecord;
  host?: unknown;
  error?: string;
}

export interface GatewaySpawnedProcess {
  readonly exitCode: number | null;
  once?(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
  kill(): boolean;
}

export type GatewayProcessSpawner = (path: string, args: string[], options: SpawnOptions) => GatewaySpawnedProcess;

export interface GatewayControlClientOptions {
  cwd?: string;
  configPath?: string;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  binary?: GatewayBinaryInfo;
  processIdentity?: (pid: number) => string | undefined | Promise<string | undefined>;
  spawnProcess?: GatewayProcessSpawner;
}

let binaryCache: GatewayBinaryInfo | null | undefined;

function verifyGatewayBinary(
  path: string,
  source: GatewayBinaryInfo["source"],
  command = path,
  argsPrefix: string[] = [],
): GatewayBinaryInfo | undefined {
  const result = crossSpawn.sync(command, [...argsPrefix, "version", "--json"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) return undefined;
  try {
    const value = JSON.parse(String(result.stdout || "")) as { name?: unknown; version?: unknown; protocolVersion?: unknown };
    if (value.name !== "pi-maestro-gateway" || typeof value.version !== "string" || value.protocolVersion !== 1) return undefined;
    return {
      path,
      version: value.version,
      source,
      ...(command === path ? {} : { command }),
      ...(argsPrefix.length === 0 ? {} : { argsPrefix }),
    };
  } catch {
    return undefined;
  }
}

function packagedGatewayBinary(): GatewayBinaryInfo | undefined {
  const path = fileURLToPath(new URL("../../bin/pi-maestro-gateway.mjs", import.meta.url));
  if (!existsSync(path)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { name?: unknown; version?: unknown };
    if (manifest.name !== "pi-maestro-flow" || typeof manifest.version !== "string") return undefined;
    return { path, version: manifest.version, source: "package", command: process.execPath, argsPrefix: [path] };
  } catch {
    return undefined;
  }
}

function executableOnPath(): string | undefined {
  const probe = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["pi-maestro-gateway"], {
    encoding: "utf8",
    timeout: 10_000,
    shell: false,
    windowsHide: true,
  });
  if (probe.status !== 0 || probe.error) return undefined;
  return String(probe.stdout || "").split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
}

/** Resolve only binaries that self-identify as the packaged Gateway. */
export function locateGatewayBinary(): GatewayBinaryInfo | undefined {
  if (binaryCache !== undefined) return binaryCache ?? undefined;
  const official = process.env.PI_MAESTRO_GATEWAY_BIN?.trim();
  if (official) {
    binaryCache = verifyGatewayBinary(official, "override") ?? null;
    return binaryCache ?? undefined;
  }
  const packaged = packagedGatewayBinary();
  if (packaged) {
    binaryCache = packaged;
    return binaryCache;
  }
  const legacy = process.env.MCPX_BIN?.trim();
  if (legacy) {
    binaryCache = verifyGatewayBinary(legacy, "legacy-alias") ?? null;
    return binaryCache ?? undefined;
  }
  const discovered = executableOnPath();
  binaryCache = discovered ? verifyGatewayBinary(discovered, "path") ?? null : null;
  return binaryCache ?? undefined;
}

export function resetGatewayBinaryCache(): void {
  binaryCache = undefined;
}

async function waitUntil(predicate: (remainingMs: number) => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    if (await predicate(remainingMs)) return true;
    const delayMs = Math.min(POLL_MS, deadline - Date.now());
    if (delayMs <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function defaultProcessIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform !== "win32") {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ").trim() || undefined;
    } catch {
      return undefined;
    }
  }
  const script = `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"; if ($p) { [Console]::Out.Write($p.CommandLine) }`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 5_000,
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) return undefined;
  return String(result.stdout || "").trim() || undefined;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export interface GatewayProcessTreeOps {
  platform?: NodeJS.Platform;
  signal?: (pid: number, signal: NodeJS.Signals | 0) => void;
  alive?: (pid: number) => boolean;
}

export async function killGatewayProcessTree(pid: number, ops: GatewayProcessTreeOps = {}): Promise<void> {
  const platform = ops.platform ?? process.platform;
  const signal = ops.signal ?? ((target, value) => process.kill(target, value));
  const alive = ops.alive ?? processAlive;
  if (platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    if (result.status !== 0 && alive(pid)) throw new Error(`Failed to stop Gateway pid ${pid}`);
    return;
  }
  // Gateway is spawned detached, making its PID the process-group ID. Signal
  // the exact group so descendants cannot survive as untracked orphans.
  const groupAlive = (): boolean => {
    try { signal(-pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  };
  try { signal(-pid, "SIGTERM"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH" && !alive(pid)) return;
    throw new Error(`Failed to signal Gateway process group ${pid}`, { cause: error });
  }
  if (await waitUntil(() => !groupAlive(), 2_000)) return;
  try { signal(-pid, "SIGKILL"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export class GatewayControlClient {
  readonly cwd: string;
  readonly configPath: string;
  readonly workspaceOwnerToken = randomUUID();
  private readonly startupTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly binary?: GatewayBinaryInfo;
  private readonly processIdentity: NonNullable<GatewayControlClientOptions["processIdentity"]>;
  private readonly spawnProcess: GatewayProcessSpawner;
  private startPromise?: Promise<GatewayControlStatus>;
  private registryPromise?: Promise<WorkspaceRegistry>;

  constructor(options: GatewayControlClientOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.configPath = options.configPath ?? gatewayConfigPath();
    this.startupTimeoutMs = options.startupTimeoutMs ?? START_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    this.binary = options.binary;
    this.processIdentity = options.processIdentity ?? defaultProcessIdentity;
    this.spawnProcess = options.spawnProcess ?? crossSpawn;
  }

  async status(): Promise<GatewayControlStatus> {
    return this.probeStatus(STATUS_TIMEOUT_MS);
  }

  async start(): Promise<GatewayControlStatus> {
    if (this.startPromise) return this.startPromise;
    const operation = this.startOnce();
    this.startPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.startPromise === operation) this.startPromise = undefined;
    }
  }

  private async startOnce(): Promise<GatewayControlStatus> {
    let status = await this.status();
    if (status.online) return status;
    const binary = this.binary ?? locateGatewayBinary();
    if (!binary) {
      throw new Error("Built-in Gateway binary not found or did not self-identify; set PI_MAESTRO_GATEWAY_BIN. Unknown MCPX_BIN binaries are refused.");
    }
    const child = this.spawnProcess(binary.command ?? binary.path, [...(binary.argsPrefix ?? []), "serve", "--json", "--config", this.configPath], {
      cwd: this.cwd,
      env: process.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    let spawnError: Error | undefined;
    child.once?.("error", (error) => { spawnError = error; });
    child.unref();
    const ready = await waitUntil(async (remainingMs) => {
      if (spawnError) return true;
      status = await this.probeStatus(Math.min(STATUS_TIMEOUT_MS, remainingMs));
      return status.online || child.exitCode !== null || spawnError !== undefined;
    }, this.startupTimeoutMs);
    if (!ready || !status.online) {
      try { child.kill(); } catch { /* already exited */ }
      const reason = child.exitCode !== null
        ? `Built-in Gateway exited before becoming ready (exit ${child.exitCode})`
        : `Built-in Gateway did not become ready within ${this.startupTimeoutMs}ms`;
      throw new Error(spawnError?.message ?? status.error ?? reason);
    }
    return status;
  }

  private async probeStatus(timeoutMs: number): Promise<GatewayControlStatus> {
    const { ownerStore } = await this.state();
    let owner: GatewayOwnerRecord | undefined;
    try { owner = await ownerStore.read(); }
    catch (error) { return { online: false, error: error instanceof Error ? error.message : String(error) }; }
    if (!owner?.socket) return { online: false, ...(owner ? { owner } : {}) };
    try {
      const host = await requestGatewayIpcControl({
        address: owner.socket,
        ownerToken: owner.ownerToken,
        action: "status",
        timeoutMs: Math.max(1, timeoutMs),
      });
      return { online: true, owner, host };
    } catch (error) {
      return { online: false, owner, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async stop(): Promise<boolean> {
    const { ownerStore } = await this.state();
    const owner = await ownerStore.read();
    if (!owner) return false;
    if (owner.socket) {
      try {
        await requestGatewayIpcControl({
          address: owner.socket,
          ownerToken: owner.ownerToken,
          action: "stop",
          timeoutMs: 1_000,
        });
        if (await waitUntil(async () => (await ownerStore.read()) === undefined, this.stopTimeoutMs)) return true;
      } catch {
        // Fall through to the exact-identity process fallback.
      }
    }
    const observed = await this.processIdentity(owner.pid);
    if (observed !== owner.commandIdentity) {
      if (!processAlive(owner.pid)) {
        await ownerStore.release(owner.ownerToken);
        return true;
      }
      throw new Error("Refused to stop Gateway fallback process because its exact command identity could not be verified");
    }
    await killGatewayProcessTree(owner.pid);
    await ownerStore.release(owner.ownerToken);
    return true;
  }

  async restart(): Promise<GatewayControlStatus> {
    await this.stop().catch((error) => {
      if (error instanceof Error && /exact command identity/u.test(error.message)) throw error;
    });
    return this.start();
  }

  async listWorkspaces(): Promise<GatewayWorkspace[]> {
    return (await this.registry()).list().then((workspaces) => workspaces.map(({ ownerToken: _ownerToken, ...workspace }) => workspace));
  }

  async registerWorkspace(path: string, ttlSeconds: number, expectedGeneration?: number): Promise<GatewayWorkspace> {
    const current = await this.registeredWorkspace(path);
    return this.workspaceControl("workspace-register", {
      path,
      ttlSeconds,
      ...((expectedGeneration ?? current?.generation) === undefined ? {} : { expectedGeneration: expectedGeneration ?? current?.generation }),
    }) as Promise<GatewayWorkspace>;
  }

  async renewWorkspace(pathOrId: string, ttlSeconds: number, expectedGeneration: number): Promise<GatewayWorkspace> {
    return this.workspaceControl("workspace-renew", {
      workspaceId: pathOrId,
      ttlSeconds,
      expectedGeneration,
    }) as Promise<GatewayWorkspace>;
  }

  async unregisterWorkspace(pathOrId: string, options?: WorkspaceUnregisterOptions): Promise<boolean> {
    const current = await this.registeredWorkspace(pathOrId);
    if (!current) return false;
    const value = await this.workspaceControl("workspace-remove", {
      workspaceId: pathOrId,
      expectedGeneration: options?.expectedGeneration ?? options?.generation ?? current.generation,
    }) as { removed?: unknown };
    return value.removed === true;
  }

  async listTasks(): Promise<GatewayTaskJournalRecord[]> {
    const config = await this.config();
    const journalPath = config.state.rootDir
      ? join(config.state.rootDir, "tasks", "journal.json")
      : join(gatewayTasksRoot(this.cwd), "journal.json");
    return new TaskJournal({ path: journalPath, maxTasks: config.limits.maxTasks }).list();
  }

  private async registeredWorkspace(pathOrId: string): Promise<GatewayWorkspace | undefined> {
    const workspaces = await (await this.registry()).list({ includeExpired: true });
    const byId = workspaces.find((workspace) => workspace.id === pathOrId);
    if (byId) return byId;
    let path: string;
    try { path = canonicalizeWorkspacePath(pathOrId); } catch { return undefined; }
    return workspaces.find((workspace) => (workspace.canonicalPath ?? workspace.path) === path);
  }

  private async workspaceControl(action: "workspace-register" | "workspace-renew" | "workspace-remove", data: Record<string, unknown>): Promise<unknown> {
    const status = await this.start();
    if (!status.owner?.socket) throw new Error("Gateway owner control socket is unavailable");
    return requestGatewayIpcControl({
      address: status.owner.socket,
      ownerToken: status.owner.ownerToken,
      action,
      data,
    });
  }

  private async config(): Promise<GatewayConfig> {
    return loadGatewayConfig(this.configPath);
  }

  private async state(): Promise<{ config: GatewayConfig; ownerStore: GatewayOwnerStore }> {
    const config = await this.config();
    return {
      config,
      ownerStore: new GatewayOwnerStore({ ownerPath: config.state.ownerPath ?? gatewayOwnerPath() }),
    };
  }

  private registry(): Promise<WorkspaceRegistry> {
    this.registryPromise ??= this.createRegistry();
    return this.registryPromise;
  }

  private async createRegistry(): Promise<WorkspaceRegistry> {
    const config = await this.config();
    const registryPath = config.state.workspaceRegistryPath ?? gatewayWorkspaceRegistryPath();
    const registry = new WorkspaceRegistry({
      path: registryPath,
      maxEntries: config.limits.maxWorkspaceCount,
      maxTtlMs: config.limits.maxLeaseTtlMs,
    });
    if (!existsSync(registryPath)) {
      await registry.seedIfMissing(config.workspaces.map((workspace) => ({
        path: isAbsolute(workspace.path) ? workspace.path : resolve(this.cwd, workspace.path),
        options: workspace.mode === "permanent"
          ? { mode: "permanent" as const }
          : { mode: "lease" as const, ttlMs: workspace.ttlMs ?? 5 * 60 * 1000 },
      })));
    }
    return registry;
  }
}

export function createGatewayControlClient(options?: GatewayControlClientOptions): GatewayControlClient {
  return new GatewayControlClient(options);
}
