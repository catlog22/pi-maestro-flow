import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const RUNTIME_BROKER_PRIVATE_DIRECTORY_MODE = 0o700;
export const RUNTIME_BROKER_PRIVATE_FILE_MODE = 0o600;
export const RUNTIME_BROKER_SOCKET_FILE = "broker.sock";
export const RUNTIME_BROKER_DATABASE_FILE = "broker.sqlite";
export const RUNTIME_BROKER_DAEMON_LOCK_FILE = "daemon.lock";

export function canonicalizeRuntimeBrokerWorkspace(
  workspaceDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (typeof workspaceDirectory !== "string" || workspaceDirectory.length === 0 || workspaceDirectory.includes("\0")) {
    throw new Error("Runtime broker workspace must be a non-empty path");
  }
  const resolved = path.resolve(workspaceDirectory);
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    canonical = path.normalize(resolved);
  }
  return platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function getRuntimeBrokerStateDirectory(
  workspaceDirectory = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = process.env.PI_TEAMMATE_BROKER_STATE_DIR;
  if (configured) return path.resolve(configured);
  const workspaceKey = createHash("sha256")
    .update(canonicalizeRuntimeBrokerWorkspace(workspaceDirectory, platform), "utf8")
    .digest("hex")
    .slice(0, 24);
  return path.join(os.homedir(), ".pi", "agent", "runtime-broker", workspaceKey);
}

export function getRuntimeBrokerEndpoint(
  stateDirectory = getRuntimeBrokerStateDirectory(),
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = path.resolve(stateDirectory);
  if (platform === "win32") {
    const key = createHash("sha256").update(resolved.toLowerCase()).digest("hex").slice(0, 24);
    return `\\\\.\\pipe\\pi-teammate-broker-${key}`;
  }
  const endpoint = path.join(resolved, RUNTIME_BROKER_SOCKET_FILE);
  if (Buffer.byteLength(endpoint, "utf8") > 100) {
    throw new Error("Runtime broker state directory is too long for a Unix-domain socket");
  }
  return endpoint;
}

export function getRuntimeBrokerDatabasePath(stateDirectory = getRuntimeBrokerStateDirectory()): string {
  return path.join(path.resolve(stateDirectory), RUNTIME_BROKER_DATABASE_FILE);
}

export function ensurePrivateRuntimeBrokerDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true, mode: RUNTIME_BROKER_PRIVATE_DIRECTORY_MODE });
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Runtime broker state path is not a private directory: ${directoryPath}`);
  }
  if (process.platform !== "win32") fs.chmodSync(directoryPath, RUNTIME_BROKER_PRIVATE_DIRECTORY_MODE);
}

export function assertSecureRuntimeBrokerFile(filePath: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Runtime broker ${label} path is not a regular file: ${filePath}`);
  }
  if (process.platform !== "win32") fs.chmodSync(filePath, RUNTIME_BROKER_PRIVATE_FILE_MODE);
}

export function secureRuntimeBrokerFile(filePath: string): void {
  assertSecureRuntimeBrokerFile(filePath, "state file");
  if (process.platform !== "win32") fs.chmodSync(filePath, RUNTIME_BROKER_PRIVATE_FILE_MODE);
}
