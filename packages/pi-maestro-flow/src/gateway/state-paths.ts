/** Paths, canonicalisation and atomic persistence primitives for Gateway state. */
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const GATEWAY_CONFIG_DIRECTORY = "gateway" as const;
export const GATEWAY_CONFIG_FILE = "config.yaml" as const;
export const GATEWAY_STATE_DIRECTORY = "gateway" as const;
export const GATEWAY_STATE_VERSION_DIRECTORY = "v1" as const;
export const GATEWAY_WORKSPACE_REGISTRY_FILE = "workspaces.json" as const;
export const GATEWAY_OWNER_FILE = "owner.json" as const;
export const GATEWAY_PAIRINGS_FILE = "pairings.json" as const;
export const GATEWAY_SERVICE_MANIFEST_FILE = "service.json" as const;
export const GATEWAY_SESSIONS_DIRECTORY = "sessions" as const;
export const GATEWAY_BOARD_DIRECTORY = "board" as const;
export const GATEWAY_BOARD_FILE = "board.json" as const;
export const GATEWAY_HANDOFF_DIRECTORY = "handoffs" as const;
export const GATEWAY_OPERATION_RECEIPT_DIRECTORY = "operation-receipts" as const;
export const GATEWAY_MAESTRO_RECEIPT_DIRECTORY = "maestro-receipts" as const;
export const GATEWAY_TUNNELS_DIRECTORY = "tunnels" as const;

/** Return UTF-8 byte length, used for every wire/durable bound. */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Resolve the Pi agent directory without consulting any legacy Gateway root. */
export function gatewayAgentDirectory(homeDir = homedir()): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homeDir, ".pi", "agent");
  if (configured === "~") return homeDir;
  if (configured.startsWith("~/") || configured.startsWith("~\\")) return resolve(homeDir, configured.slice(2));
  return resolve(configured);
}

/** Native root for all user-global Gateway configuration and durable state. */
export function gatewayNativeRoot(homeDir = homedir()): string {
  return join(gatewayAgentDirectory(homeDir), GATEWAY_STATE_DIRECTORY);
}
export const getGatewayNativeRoot = gatewayNativeRoot;

export function gatewayConfigPath(homeDir = homedir()): string {
  return join(gatewayNativeRoot(homeDir), GATEWAY_CONFIG_FILE);
}
export const getGatewayConfigPath = gatewayConfigPath;

/** Global state is shared by local Gateway hosts (owner + workspace registry). */
export function gatewayGlobalStateRoot(homeDir = homedir()): string {
  return join(gatewayNativeRoot(homeDir), GATEWAY_STATE_VERSION_DIRECTORY);
}
export const getGatewayGlobalStateRoot = gatewayGlobalStateRoot;
/** Compatibility alias for callers that refer to the global versioned state path. */
export const gatewayStatePath = gatewayGlobalStateRoot;
export const getGatewayStatePath = gatewayGlobalStateRoot;

/** Workspace-local state is kept out of generic ~/.pi state and is versioned. */
export function gatewayStateRoot(cwd = process.cwd()): string {
  return join(canonicalizeWorkspacePath(cwd), ".pi", GATEWAY_STATE_DIRECTORY, GATEWAY_STATE_VERSION_DIRECTORY);
}
export const getGatewayStateRoot = gatewayStateRoot;

export function gatewayWorkspaceStateRoot(cwd = process.cwd()): string {
  return gatewayStateRoot(cwd);
}

export function gatewayWorkspaceRegistryPath(homeDir = homedir()): string {
  return join(gatewayGlobalStateRoot(homeDir), GATEWAY_WORKSPACE_REGISTRY_FILE);
}
export const getGatewayWorkspaceRegistryPath = gatewayWorkspaceRegistryPath;
export const workspaceRegistryPath = gatewayWorkspaceRegistryPath;

export function gatewayOwnerPath(homeDir = homedir()): string {
  return join(gatewayGlobalStateRoot(homeDir), GATEWAY_OWNER_FILE);
}
export function gatewayPairingPath(homeDir = homedir()): string {
  return join(gatewayGlobalStateRoot(homeDir), GATEWAY_PAIRINGS_FILE);
}
export function gatewayServiceManifestPath(homeDir = homedir()): string {
  return join(gatewayGlobalStateRoot(homeDir), GATEWAY_SERVICE_MANIFEST_FILE);
}
export function gatewayTunnelsRoot(homeDir = homedir()): string {
  return join(gatewayGlobalStateRoot(homeDir), GATEWAY_TUNNELS_DIRECTORY);
}
export const getGatewayOwnerPath = gatewayOwnerPath;
export const gatewayOwnerRecordPath = gatewayOwnerPath;

export function gatewayJobsRoot(cwd = process.cwd()): string {
  return join(gatewayStateRoot(cwd), "jobs");
}
export function gatewayTasksRoot(cwd = process.cwd()): string {
  return join(gatewayStateRoot(cwd), "tasks");
}
/** Independent collaboration state; deliberately separate from Pi todo-state and task journals. */
export function gatewaySessionsRoot(cwd = process.cwd()): string {
  return join(gatewayStateRoot(cwd), GATEWAY_SESSIONS_DIRECTORY);
}
/** Workspace-level authoritative Board state, separate from Session/Todo projections. */
export function gatewayBoardRoot(cwd = process.cwd()): string {
  return join(gatewayStateRoot(cwd), GATEWAY_BOARD_DIRECTORY);
}
export const getGatewayBoardRoot = gatewayBoardRoot;
export function gatewayBoardPath(cwd = process.cwd(), boardRoot?: string): string {
  const root = boardRoot ?? gatewayBoardRoot(cwd);
  return boardRoot
    ? containedPath(root, workspaceIdForPath(cwd), GATEWAY_BOARD_FILE)
    : containedPath(root, GATEWAY_BOARD_FILE);
}
export const getGatewayBoardPath = gatewayBoardPath;
export function gatewayHandoffRoot(cwd = process.cwd()): string {
  return join(gatewayStateRoot(cwd), GATEWAY_HANDOFF_DIRECTORY);
}
export function gatewayOperationReceiptRoot(cwd = process.cwd()): string {
  return join(gatewayStateRoot(cwd), GATEWAY_OPERATION_RECEIPT_DIRECTORY);
}
export function gatewayMaestroReceiptRoot(cwd = process.cwd()): string {
  return join(gatewayStateRoot(cwd), GATEWAY_MAESTRO_RECEIPT_DIRECTORY);
}
export function gatewaySessionPath(id: string, cwd = process.cwd(), sessionsRoot?: string): string {
  return containedPath(sessionsRoot ?? gatewaySessionsRoot(cwd), `${safePathToken(id)}.json`);
}
export function gatewayJobPath(id: string, cwd = process.cwd()): string {
  return containedPath(gatewayJobsRoot(cwd), `${safePathToken(id)}.json`);
}
export function gatewayTaskPath(id: string, cwd = process.cwd()): string {
  return containedPath(gatewayTasksRoot(cwd), `${safePathToken(id)}.json`);
}

export interface GatewayStatePaths {
  configPath: string;
  globalRoot: string;
  ownerPath: string;
  workspaceRegistryPath: string;
  pairingPath: string;
  serviceManifestPath: string;
  tunnelsRoot: string;
  workspaceRoot: string;
  jobsRoot: string;
  tasksRoot: string;
  sessionsRoot: string;
  boardRoot: string;
  boardPath: string;
  handoffRoot: string;
  operationReceiptRoot: string;
  maestroReceiptRoot: string;
}

export function createGatewayStatePaths(cwd = process.cwd(), homeDir = homedir()): GatewayStatePaths {
  const workspaceRoot = gatewayStateRoot(cwd);
  const globalRoot = gatewayGlobalStateRoot(homeDir);
  return {
    configPath: gatewayConfigPath(homeDir),
    globalRoot,
    ownerPath: join(globalRoot, GATEWAY_OWNER_FILE),
    workspaceRegistryPath: join(globalRoot, GATEWAY_WORKSPACE_REGISTRY_FILE),
    pairingPath: join(globalRoot, GATEWAY_PAIRINGS_FILE),
    serviceManifestPath: join(globalRoot, GATEWAY_SERVICE_MANIFEST_FILE),
    tunnelsRoot: join(globalRoot, GATEWAY_TUNNELS_DIRECTORY),
    workspaceRoot,
    jobsRoot: join(workspaceRoot, "jobs"),
    tasksRoot: join(workspaceRoot, "tasks"),
    sessionsRoot: join(workspaceRoot, GATEWAY_SESSIONS_DIRECTORY),
    boardRoot: join(workspaceRoot, GATEWAY_BOARD_DIRECTORY),
    boardPath: join(workspaceRoot, GATEWAY_BOARD_DIRECTORY, GATEWAY_BOARD_FILE),
    handoffRoot: join(workspaceRoot, GATEWAY_HANDOFF_DIRECTORY),
    operationReceiptRoot: join(workspaceRoot, GATEWAY_OPERATION_RECEIPT_DIRECTORY),
    maestroReceiptRoot: join(workspaceRoot, GATEWAY_MAESTRO_RECEIPT_DIRECTORY),
  };
}

/**
 * Canonicalise before comparing or authorising. Existing symlinks are resolved;
 * a missing leaf is normalised through its absolute parent path.
 */
export function canonicalizeWorkspacePath(input: string): string {
  if (typeof input !== "string" || input.trim() === "") throw new Error("workspace path must be a non-empty string");
  const absolute = resolve(input);
  let canonical = absolute;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    // A workspace can be registered before it is created. Resolve the deepest
    // existing parent so `..` and symlink escapes still cannot be hidden.
    const suffix: string[] = [];
    let probe = absolute;
    while (!existsSync(probe)) {
      const parent = resolve(probe, "..");
      if (parent === probe) break;
      suffix.unshift(probe.slice(parent.length + 1));
      probe = parent;
    }
    try { canonical = join(realpathSync.native(probe), ...suffix); } catch { canonical = absolute; }
  }
  canonical = resolve(canonical);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}
export const normalizeWorkspacePath = canonicalizeWorkspacePath;
export const canonicalWorkspacePath = canonicalizeWorkspacePath;

export function workspaceIdForPath(input: string): string {
  return createHash("sha256").update(canonicalizeWorkspacePath(input), "utf8").digest("hex");
}
export const workspaceIdForCwd = workspaceIdForPath;

export function isPathWithin(rootInput: string, candidateInput: string): boolean {
  const root = canonicalizeWorkspacePath(rootInput);
  const candidate = canonicalizeWorkspacePath(candidateInput);
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolve a user-supplied path under a registered workspace, rejecting escapes. */
export function canonicalizeWorkspaceChild(workspaceInput: string, childInput: string): string {
  if (typeof childInput !== "string" || childInput.trim() === "") throw new Error("path must be a non-empty string");
  const workspace = canonicalizeWorkspacePath(workspaceInput);
  const candidate = isAbsolute(childInput) ? resolve(childInput) : resolve(workspace, childInput);
  if (!isPathWithin(workspace, candidate)) throw new Error("path escapes the registered workspace");
  return canonicalizeWorkspacePath(candidate);
}
export const canonicalizePath = canonicalizeWorkspaceChild;

export function containedPath(rootInput: string, ...parts: string[]): string {
  const root = resolve(rootInput);
  const candidate = resolve(root, ...parts);
  const rel = relative(root, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Gateway state path escapes its root directory");
  }
  return candidate;
}

function safePathToken(value: string): string {
  const raw = String(value);
  const readable = raw.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 48);
  return `${readable || "record"}-${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}

export interface AtomicWriteOptions {
  mode?: number;
  maximumBytes?: number;
}

/** Write via a same-directory, fsynced temporary file followed by rename. */
export async function writeGatewayFileAtomic(
  path: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const payload = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  if (options.maximumBytes !== undefined && payload.byteLength > options.maximumBytes) {
    throw new Error(`Gateway state payload exceeds ${options.maximumBytes} bytes`);
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", options.mode ?? 0o600);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    try { await chmod(path, options.mode ?? 0o600); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EPERM" && code !== "EINVAL" && code !== "ENOSYS") throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function writeGatewayJsonAtomic(path: string, value: unknown, options: AtomicWriteOptions = {}): Promise<void> {
  await writeGatewayFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options);
}
export const atomicWriteGatewayJson = writeGatewayJsonAtomic;

export async function readGatewayFile(path: string, maximumBytes = 16 * 1024 * 1024): Promise<string | undefined> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`Gateway state path must not be a symbolic link: ${path}`);
    if (!metadata.isFile() || metadata.size > maximumBytes) return undefined;
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readGatewayJson<T = unknown>(path: string, maximumBytes = 16 * 1024 * 1024): Promise<T | undefined> {
  const raw = await readGatewayFile(path, maximumBytes);
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw) as T; }
  catch (error) { throw new Error(`Invalid Gateway JSON: ${path}`, { cause: error }); }
}
