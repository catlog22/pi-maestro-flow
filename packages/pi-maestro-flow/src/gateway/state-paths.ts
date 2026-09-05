/** Paths, canonicalisation and atomic persistence primitives for Gateway state. */
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const GATEWAY_CONFIG_DIRECTORY = ".mcpx" as const;
export const GATEWAY_CONFIG_FILE = "config.yaml" as const;
export const GATEWAY_STATE_DIRECTORY = "gateway" as const;
export const GATEWAY_STATE_VERSION_DIRECTORY = "v1" as const;
export const GATEWAY_WORKSPACE_REGISTRY_FILE = "workspaces.json" as const;
export const GATEWAY_OWNER_FILE = "owner.json" as const;
export const GATEWAY_SESSIONS_DIRECTORY = "sessions" as const;
export const GATEWAY_LEGACY_OWNER_FILES = ["mcpx-server.pid", "gateway.pid"] as const;

/** Return UTF-8 byte length, used for every wire/durable bound. */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** The config path remains ~/.mcpx/config.yaml for compatibility. */
export function gatewayConfigPath(homeDir = homedir()): string {
  return join(homeDir, GATEWAY_CONFIG_DIRECTORY, GATEWAY_CONFIG_FILE);
}
export const getGatewayConfigPath = gatewayConfigPath;
export const mcpxConfigPath = gatewayConfigPath;

/** Global state is shared by local Gateway hosts (owner + workspace registry). */
export function gatewayGlobalStateRoot(homeDir = homedir()): string {
  return join(homeDir, GATEWAY_CONFIG_DIRECTORY, GATEWAY_STATE_DIRECTORY, GATEWAY_STATE_VERSION_DIRECTORY);
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
export function gatewayLegacyOwnerPath(homeDir = homedir()): string {
  return join(homeDir, GATEWAY_CONFIG_DIRECTORY, "gateway-owner.json");
}
/** Legacy raw PID files are evidence only until exact process identity is verified. */
export function gatewayLegacyPidPaths(homeDir = homedir()): string[] {
  return GATEWAY_LEGACY_OWNER_FILES.map((name) => join(homeDir, GATEWAY_CONFIG_DIRECTORY, name));
}
export const getGatewayLegacyOwnerPath = gatewayLegacyOwnerPath;
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
  workspaceRoot: string;
  jobsRoot: string;
  tasksRoot: string;
  sessionsRoot: string;
}

export function createGatewayStatePaths(cwd = process.cwd(), homeDir = homedir()): GatewayStatePaths {
  const workspaceRoot = gatewayStateRoot(cwd);
  const globalRoot = gatewayGlobalStateRoot(homeDir);
  return {
    configPath: gatewayConfigPath(homeDir),
    globalRoot,
    ownerPath: join(globalRoot, GATEWAY_OWNER_FILE),
    workspaceRegistryPath: join(globalRoot, GATEWAY_WORKSPACE_REGISTRY_FILE),
    workspaceRoot,
    jobsRoot: join(workspaceRoot, "jobs"),
    tasksRoot: join(workspaceRoot, "tasks"),
    sessionsRoot: join(workspaceRoot, GATEWAY_SESSIONS_DIRECTORY),
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
