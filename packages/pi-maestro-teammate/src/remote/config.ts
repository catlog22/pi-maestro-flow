import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { IMMUTABLE_ENV_NAMES } from "./child-security.ts";
import {
  REMOTE_CONFIG_VERSION,
  REMOTE_WINDOW_BRIDGE_PLUGIN_ID,
  type RemoteAcpFileSystemPolicy,
  type RemoteAcpPolicy,
  type RemoteAcpTerminalCommand,
  type RemoteAcpTerminalPolicy,
  type RemoteHostEntry,
  type RemoteTargetConfig,
  type RemoteWorkspaceConfig,
  type ResolvedRemoteTarget,
  type ResolvedRemoteWorkspace,
} from "./types.ts";

const CONFIG_FILE = "teammate-remotes.json";
const MAX_CONFIG_BYTES = 1024 * 1024;
const LOCK_WAIT_MS = 15_000;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 30_000;
const properLockfile = createRequire(import.meta.url)("proper-lockfile") as {
  lockSync(filePath: string, options: {
    realpath: boolean;
    stale: number;
    update: number;
  }): () => void;
};
const MAX_COMMAND_ARGS = 64;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_ACP_FILE_BYTES = 1024 * 1024;
const MAX_ACP_TERMINAL_TIMEOUT_MS = 5 * 60 * 1000;
const HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const WORKSPACE_REF_PATTERN = TARGET_ID_PATTERN;
const HOST_KEY_PATTERN = /^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/;
const MAX_WINDOW_PROTOCOL_VERSION = 65_535;

export interface GlobalRemoteConfigStore {
  version: typeof REMOTE_CONFIG_VERSION;
  hosts: Record<string, RemoteHostEntry>;
  targets: Record<string, RemoteTargetConfig>;
  workspaces: Record<string, RemoteWorkspaceConfig>;
}

export interface ProjectRemoteConfigStore {
  version: typeof REMOTE_CONFIG_VERSION;
  /** Project values override globals; null explicitly hides a global entry. */
  hosts: Record<string, RemoteHostEntry | null>;
  /** Project values override globals; null explicitly hides a global entry. */
  targets: Record<string, RemoteTargetConfig | null>;
  /** Project values override globals; null explicitly hides a global entry. */
  workspaces: Record<string, RemoteWorkspaceConfig | null>;
}

export interface RemoteConfig {
  version: typeof REMOTE_CONFIG_VERSION;
  hosts: Record<string, RemoteHostEntry>;
  targets: Record<string, RemoteTargetConfig>;
  workspaces: Record<string, RemoteWorkspaceConfig>;
}

export interface RemoteConfigState {
  global: GlobalRemoteConfigStore;
  project: ProjectRemoteConfigStore;
  config: RemoteConfig;
}

export interface RemoteConfigStorePair {
  global: GlobalRemoteConfigStore;
  project: ProjectRemoteConfigStore;
}

interface RemoteConfigTransaction {
  version: 1;
  mode: "forward" | "rollback";
  projectFilePath: string;
  globalBefore: GlobalRemoteConfigStore;
  globalAfter: GlobalRemoteConfigStore;
  projectBefore: ProjectRemoteConfigStore;
  projectAfter: ProjectRemoteConfigStore;
}

export function getGlobalRemoteConfigPath(): string {
  return path.join(os.homedir(), ".pi", "agent", CONFIG_FILE);
}

export function getProjectRemoteConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", CONFIG_FILE);
}

function emptyGlobalStore(): GlobalRemoteConfigStore {
  return { version: REMOTE_CONFIG_VERSION, hosts: {}, targets: {}, workspaces: {} };
}

function emptyProjectStore(): ProjectRemoteConfigStore {
  return { version: REMOTE_CONFIG_VERSION, hosts: {}, targets: {}, workspaces: {} };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) throw new Error(`Unknown ${label} field: ${unknown}`);
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

export function validateHostId(id: string): void {
  if (!HOST_ID_PATTERN.test(id)) throw new Error(`Invalid remote host id: ${id}`);
}

export function validateTargetId(id: string): void {
  if (id.length > 128 || !TARGET_ID_PATTERN.test(id)) throw new Error(`Invalid remote target id: ${id}`);
}

export function validateWorkspaceRef(workspaceRef: string): void {
  if (workspaceRef.length > 128 || !WORKSPACE_REF_PATTERN.test(workspaceRef)) {
    throw new Error(`Invalid remote workspace ref: ${workspaceRef}`);
  }
}

function normalizeHost(value: unknown, id: string): RemoteHostEntry {
  if (!plainObject(value)) throw new Error(`Invalid remote host: ${id}`);
  if (Object.hasOwn(value, "sshHostRef")) {
    assertKnownKeys(value, ["sshHostRef"], `remote host ${id}`);
    const sshHostRef = boundedString(value.sshHostRef, `remote SSH host reference: ${id}`, 64);
    if (!HOST_ID_PATTERN.test(sshHostRef)) throw new Error(`Invalid remote SSH host reference: ${id}`);
    return { sshHostRef };
  }
  assertKnownKeys(value, ["host", "user", "port", "hostKeySha256", "identityFile"], `remote host ${id}`);
  const host = boundedString(value.host, `remote host address: ${id}`, 253);
  const user = boundedString(value.user, `remote host user: ${id}`, 128);
  if (/\s/.test(host) || /\s/.test(user)) throw new Error(`Invalid remote host address or user: ${id}`);
  if (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65_535) {
    throw new Error(`Invalid remote host port: ${id}`);
  }
  const hostKeySha256 = boundedString(value.hostKeySha256, `remote host key: ${id}`, 256);
  if (!HOST_KEY_PATTERN.test(hostKeySha256)) throw new Error(`Invalid remote host key fingerprint: ${id}`);
  const identityFile = value.identityFile === undefined
    ? undefined
    : boundedString(value.identityFile, `remote identity file: ${id}`, 4096);
  return { host, user, port: value.port, hostKeySha256, ...(identityFile ? { identityFile } : {}) };
}

function optionalBoundedInteger(value: unknown, label: string, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Invalid ${label}`);
  return value;
}

function normalizeAcpFs(value: unknown, id: string): RemoteAcpFileSystemPolicy {
  if (!plainObject(value)) throw new Error(`Invalid remote ACP filesystem policy: ${id}`);
  assertKnownKeys(value, ["read", "write", "maxReadBytes", "maxWriteBytes"], `remote ACP filesystem policy ${id}`);
  const read = optionalBoolean(value.read, `remote ACP filesystem read policy: ${id}`);
  const write = optionalBoolean(value.write, `remote ACP filesystem write policy: ${id}`);
  return {
    ...(read === undefined ? {} : { read }),
    ...(write === undefined ? {} : { write }),
    ...(value.maxReadBytes === undefined ? {} : {
      maxReadBytes: optionalBoundedInteger(value.maxReadBytes, `remote ACP maxReadBytes: ${id}`, MAX_ACP_FILE_BYTES),
    }),
    ...(value.maxWriteBytes === undefined ? {} : {
      maxWriteBytes: optionalBoundedInteger(value.maxWriteBytes, `remote ACP maxWriteBytes: ${id}`, MAX_ACP_FILE_BYTES),
    }),
  };
}

function normalizeUniqueStrings(
  value: unknown,
  label: string,
  maximum: number,
  pattern?: RegExp,
  minimum = 1,
): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`Invalid ${label}`);
  const result: string[] = [];
  for (const entry of value) {
    const normalized = boundedString(entry, label, 4096);
    if (pattern && !pattern.test(normalized)) throw new Error(`Invalid ${label}`);
    if (result.includes(normalized)) throw new Error(`Duplicate ${label}: ${normalized}`);
    result.push(normalized);
  }
  return result;
}

const CODE_EVAL_EXECUTABLES = new Set(["node", "nodejs", "deno", "bun", "python", "python3", "python2", "perl", "ruby", "php", "sh", "bash", "zsh", "dash", "fish"]);
const CODE_EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c", "--command", "--exec", "-pe", "-i"]);
const GIT_EXECUTION_SUBCOMMANDS = new Set(["alias", "config", "filter-branch", "submodule", "archive", "upload-pack", "receive-pack", "clone", "fetch", "pull"]);
const SAFE_GIT_SUBCOMMANDS = new Set(["status", "rev-parse", "ls-files"]);
const GIT_EXECUTION_FLAGS = new Set(["-c", "--config-env", "--exec-path", "--git-dir", "--work-tree"]);
const PATH_LIKE_VARS = new Set(["PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "PYTHONPATH", "NODE_PATH", "PERL5LIB"]);
const UNSAFE_EXEC_CHARS = /[\u0000-\u001f\u007f";`]/;

function assertCanonicalExecutable(executable: string, id: string): void {
  if (!path.posix.isAbsolute(executable)
    || path.posix.normalize(executable) !== executable
    || executable === "/"
    || UNSAFE_EXEC_CHARS.test(executable)) {
    throw new Error(`Invalid canonical ACP terminal executable: ${id}`);
  }
}

function normalizeTerminalArgs(value: unknown, id: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_COMMAND_ARGS) {
    throw new Error(`Invalid remote ACP terminal argv: ${id}`);
  }
  const args = value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length > 8192 || /[\u0000-\u001f\u007f]/.test(entry)) {
      throw new Error(`Invalid remote ACP terminal argv[${index}]: ${id}`);
    }
    return entry;
  });
  if (Buffer.byteLength(JSON.stringify(args), "utf8") > MAX_COMMAND_BYTES) {
    throw new Error(`Remote ACP terminal argv is too large: ${id}`);
  }
  return args;
}

function assertSafeTerminalProfile(profile: RemoteAcpTerminalCommand, id: string): void {
  const base = path.posix.basename(profile.executable).toLowerCase();
  const first = profile.args[0] ?? "";
  if (CODE_EVAL_EXECUTABLES.has(base)
    && (CODE_EVAL_FLAGS.has(first) || first.startsWith("--eval") || first.startsWith("--print"))) {
    throw new Error(`Remote ACP terminal profile permits code evaluation: ${id}`);
  }
  if (base === "git") {
    const subcommand = profile.args[0] ?? "";
    if (!SAFE_GIT_SUBCOMMANDS.has(subcommand)
      || GIT_EXECUTION_FLAGS.has(subcommand)
      || profile.args.some((argument) => argument.startsWith("-c") || argument.startsWith("--config-env"))
      || GIT_EXECUTION_SUBCOMMANDS.has(subcommand)) {
      throw new Error(`Remote ACP terminal profile permits git alias/config execution: ${id}`);
    }
  }
}

function normalizeAcpTerminalCommand(value: unknown, id: string): RemoteAcpTerminalCommand {
  if (!plainObject(value)) throw new Error(`Invalid remote ACP terminal command profile: ${id}`);
  assertKnownKeys(value, ["executable", "args", "environment"], `remote ACP terminal command profile ${id}`);
  const executable = boundedString(value.executable, `remote ACP terminal executable: ${id}`, 4096);
  assertCanonicalExecutable(executable, id);
  const args = normalizeTerminalArgs(value.args, id);
  const environment = normalizeUniqueStrings(
    value.environment,
    `remote ACP terminal environment: ${id}`,
    MAX_COMMAND_ARGS,
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    0,
  );
  for (const name of environment) {
    if (PATH_LIKE_VARS.has(name.toUpperCase())) {
      throw new Error(`Remote ACP terminal environment cannot set ${name}: ${id}`);
    }
  }
  const profile = { executable, args, environment };
  assertSafeTerminalProfile(profile, id);
  return profile;
}

function normalizeAcpTerminal(value: unknown, id: string): RemoteAcpTerminalPolicy {
  if (!plainObject(value)) throw new Error(`Invalid remote ACP terminal policy: ${id}`);
  assertKnownKeys(value, ["commands", "maxOutputBytes", "timeoutMs", "maxProcesses"], `remote ACP terminal policy ${id}`);
  if (!Array.isArray(value.commands) || value.commands.length < 1 || value.commands.length > MAX_COMMAND_ARGS) {
    throw new Error(`Invalid remote ACP terminal commands: ${id}`);
  }
  const commands = value.commands.map((command) => normalizeAcpTerminalCommand(command, id));
  const keys = commands.map((command) => JSON.stringify(command));
  if (new Set(keys).size !== keys.length) throw new Error(`Duplicate remote ACP terminal command profile: ${id}`);
  return {
    commands,
    ...(value.maxOutputBytes === undefined ? {} : {
      maxOutputBytes: optionalBoundedInteger(value.maxOutputBytes, `remote ACP maxOutputBytes: ${id}`, MAX_ACP_FILE_BYTES),
    }),
    ...(value.timeoutMs === undefined ? {} : {
      timeoutMs: optionalBoundedInteger(value.timeoutMs, `remote ACP timeoutMs: ${id}`, MAX_ACP_TERMINAL_TIMEOUT_MS),
    }),
    ...(value.maxProcesses === undefined ? {} : {
      maxProcesses: optionalBoundedInteger(value.maxProcesses, `remote ACP maxProcesses: ${id}`, 16),
    }),
  };
}

function normalizePermissionMode(value: unknown, id: string): "deny" | "allow-once" | undefined {
  if (value === undefined) return undefined;
  if (value === "deny") return "deny";
  if (value === "allow-once") return "allow-once";
  throw new Error(`Invalid remote ACP permission policy: ${id}`);
}

function normalizeAcpPolicy(value: unknown, id: string): RemoteAcpPolicy {
  if (!plainObject(value)) throw new Error(`Invalid remote ACP policy: ${id}`);
  assertKnownKeys(value, ["permissionMode", "permissionTools", "fs", "terminal"], `remote ACP policy ${id}`);
  const permissionMode = normalizePermissionMode(value.permissionMode, id);
  const permissionTools = value.permissionTools === undefined
    ? undefined
    : normalizeUniqueStrings(value.permissionTools, `remote ACP permissionTools: ${id}`, MAX_COMMAND_ARGS);
  if (permissionTools && permissionMode !== "allow-once") {
    throw new Error(`Remote ACP permissionTools require allow-once permission mode: ${id}`);
  }
  return {
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(permissionTools ? { permissionTools } : {}),
    ...(value.fs === undefined ? {} : { fs: normalizeAcpFs(value.fs, id) }),
    ...(value.terminal === undefined ? {} : { terminal: normalizeAcpTerminal(value.terminal, id) }),
  };
}

function normalizeTarget(value: unknown, id: string): RemoteTargetConfig {
  if (!plainObject(value)) throw new Error(`Invalid remote target: ${id}`);
  assertKnownKeys(value, ["host", "cwd", "driver", "command", "env", "acp"], `remote target ${id}`);
  const host = boundedString(value.host, `remote target host: ${id}`, 64);
  validateHostId(host);
  const cwd = boundedString(value.cwd, `remote target cwd: ${id}`, 4096);
  if (!path.posix.isAbsolute(cwd)) throw new Error(`Remote target cwd must be absolute: ${id}`);
  if (value.driver !== "pi-rpc" && value.driver !== "acp") throw new Error(`Invalid remote target driver: ${id}`);
  if (!Array.isArray(value.command) || value.command.length < 1 || value.command.length > MAX_COMMAND_ARGS) {
    throw new Error(`Invalid remote target command argv: ${id}`);
  }
  const command = value.command.map((entry, index) => {
    if (typeof entry !== "string" || !entry || entry.length > 8192 || entry.includes("\0")) {
      throw new Error(`Invalid remote target command argv[${index}]: ${id}`);
    }
    return entry;
  });
  if (Buffer.byteLength(JSON.stringify(command), "utf8") > MAX_COMMAND_BYTES) {
    throw new Error(`Remote target command argv is too large: ${id}`);
  }
  if (value.acp !== undefined && value.driver !== "acp") throw new Error(`Remote ACP policy requires the ACP driver: ${id}`);
  const env = normalizeTargetEnv(value.env, id);
  return {
    host,
    cwd,
    driver: value.driver,
    command: command as [string, ...string[]],
    ...(env.length === 0 ? {} : { env }),
    ...(value.acp === undefined ? {} : { acp: normalizeAcpPolicy(value.acp, id) }),
  };
}

function normalizeWorkspace(value: unknown, workspaceRef: string): RemoteWorkspaceConfig {
  if (!plainObject(value)) throw new Error(`Invalid remote workspace: ${workspaceRef}`);
  assertKnownKeys(
    value,
    ["host", "cwd", "requiredPlugin", "minimumWindowProtocol"],
    `remote workspace ${workspaceRef}`,
  );
  const host = boundedString(value.host, `remote workspace host: ${workspaceRef}`, 64);
  validateHostId(host);
  const cwd = boundedString(value.cwd, `remote workspace cwd: ${workspaceRef}`, 4096);
  if (!path.posix.isAbsolute(cwd) || path.posix.normalize(cwd) !== cwd) {
    throw new Error(`Remote workspace cwd must be a canonical absolute POSIX path: ${workspaceRef}`);
  }
  if (value.requiredPlugin !== REMOTE_WINDOW_BRIDGE_PLUGIN_ID) {
    throw new Error(`Remote workspace requires an unsupported plugin: ${workspaceRef}`);
  }
  if (typeof value.minimumWindowProtocol !== "number"
    || !Number.isInteger(value.minimumWindowProtocol)
    || value.minimumWindowProtocol < 1
    || value.minimumWindowProtocol > MAX_WINDOW_PROTOCOL_VERSION) {
    throw new Error(`Invalid remote workspace minimumWindowProtocol: ${workspaceRef}`);
  }
  return {
    host,
    cwd,
    requiredPlugin: REMOTE_WINDOW_BRIDGE_PLUGIN_ID,
    minimumWindowProtocol: value.minimumWindowProtocol,
  };
}

const TARGET_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeTargetEnv(value: unknown, id: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_COMMAND_ARGS) {
    throw new Error(`Invalid remote target environment: ${id}`);
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !TARGET_ENV_NAME.test(entry)) {
      throw new Error(`Invalid remote target environment variable: ${id}`);
    }
    if (IMMUTABLE_ENV_NAMES.has(entry.toUpperCase())) {
      throw new Error(`Remote target environment cannot set launch policy variable ${entry}: ${id}`);
    }
    if (result.includes(entry)) throw new Error(`Duplicate remote target environment variable ${entry}: ${id}`);
    result.push(entry);
  }
  return result;
}

function migrateLegacyAcpPolicy(value: unknown, id: string): unknown {
  if (!plainObject(value)) throw new Error(`Invalid legacy remote ACP policy: ${id}`);
  assertKnownKeys(value, ["permissionMode", "permissionTools", "fs", "terminal"], `legacy remote ACP policy ${id}`);
  if (value.terminal === undefined) return { ...value };
  if (!plainObject(value.terminal)) throw new Error(`Invalid legacy remote ACP terminal policy: ${id}`);
  assertKnownKeys(
    value.terminal,
    ["commands", "environment", "permissionTools", "maxOutputBytes", "timeoutMs", "maxProcesses"],
    `legacy remote ACP terminal policy ${id}`,
  );
  const executables = normalizeUniqueStrings(value.terminal.commands, `legacy remote ACP terminal commands: ${id}`, MAX_COMMAND_ARGS);
  const environment = value.terminal.environment === undefined
    ? []
    : normalizeUniqueStrings(
      value.terminal.environment,
      `legacy remote ACP terminal environment: ${id}`,
      MAX_COMMAND_ARGS,
      /^[A-Za-z_][A-Za-z0-9_]*$/,
      0,
    );
  const policyTools = value.permissionTools === undefined
    ? []
    : normalizeUniqueStrings(value.permissionTools, `legacy remote ACP permissionTools: ${id}`, MAX_COMMAND_ARGS);
  const terminalTools = value.terminal.permissionTools === undefined
    ? []
    : normalizeUniqueStrings(value.terminal.permissionTools, `legacy remote ACP terminal permissionTools: ${id}`, MAX_COMMAND_ARGS);
  const permissionTools = [...new Set([...policyTools, ...terminalTools])];
  return {
    ...(value.permissionMode === undefined ? {} : { permissionMode: value.permissionMode }),
    ...(permissionTools.length === 0 ? {} : { permissionTools }),
    ...(value.fs === undefined ? {} : { fs: value.fs }),
    terminal: {
      commands: executables.map((executable) => ({ executable, args: [], environment })),
      ...(value.terminal.maxOutputBytes === undefined ? {} : { maxOutputBytes: value.terminal.maxOutputBytes }),
      ...(value.terminal.timeoutMs === undefined ? {} : { timeoutMs: value.terminal.timeoutMs }),
      ...(value.terminal.maxProcesses === undefined ? {} : { maxProcesses: value.terminal.maxProcesses }),
    },
  };
}

function migrateStore(value: unknown, label: "global" | "project"): unknown {
  if (!plainObject(value)) throw new Error(`Invalid ${label} teammate remote config`);
  if (value.version === REMOTE_CONFIG_VERSION) return value;
  if (value.version === 3) {
    assertKnownKeys(value, ["version", "hosts", "targets", "workspaces"], `version 3 ${label} teammate remote config`);
    if (!plainObject(value.hosts) || !plainObject(value.targets) || !plainObject(value.workspaces)) {
      throw new Error(`Invalid version 3 ${label} teammate remote config`);
    }
    return { ...value, version: REMOTE_CONFIG_VERSION };
  }
  if (value.version === 2) {
    assertKnownKeys(value, ["version", "hosts", "targets"], `version 2 ${label} teammate remote config`);
    if (!plainObject(value.hosts) || !plainObject(value.targets)) {
      throw new Error(`Invalid version 2 ${label} teammate remote config`);
    }
    return {
      version: REMOTE_CONFIG_VERSION,
      hosts: value.hosts,
      targets: value.targets,
      workspaces: {},
    };
  }
  if (value.version !== 1) {
    throw new Error(`Unsupported ${label === "project" ? "project " : ""}teammate remote config version: ${String(value.version)}`);
  }
  assertKnownKeys(value, ["version", "hosts", "targets"], `legacy ${label} teammate remote config`);
  if (!plainObject(value.hosts) || !plainObject(value.targets)) {
    throw new Error(`Invalid legacy ${label} teammate remote config`);
  }
  const targets: Record<string, unknown> = {};
  for (const [id, target] of Object.entries(value.targets)) {
    if (label === "project" && target === null) {
      targets[id] = null;
      continue;
    }
    if (!plainObject(target)) throw new Error(`Invalid legacy remote target: ${id}`);
    assertKnownKeys(target, ["host", "cwd", "driver", "command", "acp"], `legacy remote target ${id}`);
    targets[id] = {
      ...target,
      ...(target.acp === undefined ? {} : { acp: migrateLegacyAcpPolicy(target.acp, id) }),
    };
  }
  return {
    version: REMOTE_CONFIG_VERSION,
    hosts: value.hosts,
    targets,
    workspaces: {},
  };
}

function normalizeGlobalStore(value: unknown): GlobalRemoteConfigStore {
  if (value === undefined) return emptyGlobalStore();
  const migrated = migrateStore(value, "global");
  if (!plainObject(migrated)) throw new Error("Invalid global teammate remote config");
  if (migrated.version !== REMOTE_CONFIG_VERSION) {
    throw new Error(`Unsupported teammate remote config version: ${String(migrated.version)}`);
  }
  assertKnownKeys(migrated, ["version", "hosts", "targets", "workspaces"], "global teammate remote config");
  if (!plainObject(migrated.hosts) || !plainObject(migrated.targets) || !plainObject(migrated.workspaces)) {
    throw new Error("Invalid global teammate remote config");
  }
  const hosts: Record<string, RemoteHostEntry> = {};
  const targets: Record<string, RemoteTargetConfig> = {};
  const workspaces: Record<string, RemoteWorkspaceConfig> = {};
  for (const [id, host] of Object.entries(migrated.hosts)) {
    validateHostId(id);
    hosts[id] = normalizeHost(host, id);
  }
  for (const [id, target] of Object.entries(migrated.targets)) {
    validateTargetId(id);
    targets[id] = normalizeTarget(target, id);
  }
  for (const [workspaceRef, workspace] of Object.entries(migrated.workspaces)) {
    validateWorkspaceRef(workspaceRef);
    workspaces[workspaceRef] = normalizeWorkspace(workspace, workspaceRef);
  }
  return { version: REMOTE_CONFIG_VERSION, hosts, targets, workspaces };
}

function normalizeProjectStore(value: unknown): ProjectRemoteConfigStore {
  if (value === undefined) return emptyProjectStore();
  const migrated = migrateStore(value, "project");
  if (!plainObject(migrated)) throw new Error("Invalid project teammate remote config");
  if (migrated.version !== REMOTE_CONFIG_VERSION) {
    throw new Error(`Unsupported project teammate remote config version: ${String(migrated.version)}`);
  }
  assertKnownKeys(migrated, ["version", "hosts", "targets", "workspaces"], "project teammate remote config");
  if (!plainObject(migrated.hosts) || !plainObject(migrated.targets) || !plainObject(migrated.workspaces)) {
    throw new Error("Invalid project teammate remote config");
  }
  const hosts: Record<string, RemoteHostEntry | null> = {};
  const targets: Record<string, RemoteTargetConfig | null> = {};
  const workspaces: Record<string, RemoteWorkspaceConfig | null> = {};
  for (const [id, host] of Object.entries(migrated.hosts)) {
    validateHostId(id);
    hosts[id] = host === null ? null : normalizeHost(host, id);
  }
  for (const [id, target] of Object.entries(migrated.targets)) {
    validateTargetId(id);
    targets[id] = target === null ? null : normalizeTarget(target, id);
  }
  for (const [workspaceRef, workspace] of Object.entries(migrated.workspaces)) {
    validateWorkspaceRef(workspaceRef);
    workspaces[workspaceRef] = workspace === null ? null : normalizeWorkspace(workspace, workspaceRef);
  }
  return { version: REMOTE_CONFIG_VERSION, hosts, targets, workspaces };
}

function applyOverrides<T>(global: Record<string, T>, project: Record<string, T | null>): Record<string, T> {
  const effective = { ...global };
  for (const [id, value] of Object.entries(project)) {
    if (value === null) delete effective[id];
    else effective[id] = value;
  }
  return effective;
}

function resolveConfig(global: GlobalRemoteConfigStore, project: ProjectRemoteConfigStore): RemoteConfig {
  const hosts = applyOverrides(global.hosts, project.hosts);
  const targets = applyOverrides(global.targets, project.targets);
  const workspaces = applyOverrides(global.workspaces, project.workspaces);
  for (const [targetId, target] of Object.entries(targets)) {
    if (!Object.hasOwn(hosts, target.host)) {
      throw new Error(`Remote target ${targetId} references unknown host ${target.host}`);
    }
  }
  for (const [workspaceRef, workspace] of Object.entries(workspaces)) {
    if (!Object.hasOwn(hosts, workspace.host)) {
      throw new Error(`Remote workspace ${workspaceRef} references unknown host ${workspace.host}`);
    }
  }
  return { version: REMOTE_CONFIG_VERSION, hosts, targets, workspaces };
}

function readJson(filePath: string): unknown {
  let stat: fs.Stats;
  let handle: number | undefined;
  try {
    const lexicalStat = fs.lstatSync(filePath);
    if (lexicalStat.isSymbolicLink()) throw new Error(`Teammate remote config file must not be a symlink: ${filePath}`);
    const flags = fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW);
    handle = fs.openSync(filePath, flags);
    stat = fs.fstatSync(handle);
  } catch (error) {
    if (handle !== undefined) fs.closeSync(handle);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error(`Invalid teammate remote config file: ${filePath}`);
    const raw = fs.readFileSync(handle, "utf8");
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid JSON in teammate remote config: ${filePath}`, { cause: error });
    }
  } finally {
    fs.closeSync(handle);
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withFileLock<T>(filePath: string, action: () => T): T {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  let release: (() => void) | undefined;
  while (!release) {
    try {
      release = properLockfile.lockSync(path.resolve(filePath), {
        realpath: false,
        stale: LOCK_STALE_MS,
        update: LOCK_STALE_MS / 3,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      if (Date.now() - startedAt >= LOCK_WAIT_MS) {
        throw new Error(`Timed out waiting for remote config lock: ${filePath}`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    return action();
  } finally {
    release();
  }
}

function fsyncDirectory(directoryPath: string): void {
  if (process.platform === "win32") return;
  const handle = fs.openSync(directoryPath, "r");
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EACCES" || code === "EEXIST") && attempt < 5) {
        sleepSync(20 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: number | undefined;
  try {
    handle = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    renameWithRetry(temporary, filePath);
    const publishedHandle = fs.openSync(filePath, "r+");
    try { fs.fsyncSync(publishedHandle); } finally { fs.closeSync(publishedHandle); }
    fsyncDirectory(directory);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    try {
      fs.rmSync(temporary, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function transactionPath(globalFilePath: string): string {
  return `${globalFilePath}.transaction.json`;
}

function assertStoredProjectConfigPathSafe(projectFilePath: string): void {
  const projectDirectory = path.dirname(projectFilePath);
  if (path.basename(projectFilePath) !== CONFIG_FILE || path.basename(projectDirectory) !== ".pi") {
    throw new Error("Unsafe project path in teammate remote config transaction");
  }
  const directoryStat = fs.lstatSync(projectDirectory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("Remote project config directory must be a real directory");
  }
  try {
    const fileStat = fs.lstatSync(projectFilePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error("Remote project config file must be a regular file, not a symlink");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function readTransaction(globalFilePath: string): RemoteConfigTransaction | undefined {
  const raw = readJson(transactionPath(globalFilePath));
  if (raw === undefined) return undefined;
  if (!plainObject(raw)
    || raw.version !== 1
    || (raw.mode !== "forward" && raw.mode !== "rollback")
    || typeof raw.projectFilePath !== "string") {
    throw new Error("Invalid teammate remote config transaction journal");
  }
  const projectFilePath = path.resolve(raw.projectFilePath);
  assertStoredProjectConfigPathSafe(projectFilePath);
  return {
    version: 1,
    mode: raw.mode,
    projectFilePath,
    globalBefore: normalizeGlobalStore(raw.globalBefore),
    globalAfter: normalizeGlobalStore(raw.globalAfter),
    projectBefore: normalizeProjectStore(raw.projectBefore),
    projectAfter: normalizeProjectStore(raw.projectAfter),
  };
}

function removeTransaction(globalFilePath: string): void {
  try {
    fs.rmSync(transactionPath(globalFilePath));
    fsyncDirectory(path.dirname(globalFilePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function recoverTransactionLocked(globalFilePath: string): void {
  const transaction = readTransaction(globalFilePath);
  if (!transaction) return;
  withFileLock(transaction.projectFilePath, () => {
    assertStoredProjectConfigPathSafe(transaction.projectFilePath);
    if (transaction.mode === "forward") {
      writeJsonAtomic(globalFilePath, transaction.globalAfter);
      writeJsonAtomic(transaction.projectFilePath, transaction.projectAfter);
    } else {
      writeJsonAtomic(globalFilePath, transaction.globalBefore);
      writeJsonAtomic(transaction.projectFilePath, transaction.projectBefore);
    }
    removeTransaction(globalFilePath);
  });
}

function withGlobalLock<T>(globalFilePath: string, action: () => T): T {
  return withFileLock(globalFilePath, () => {
    recoverTransactionLocked(globalFilePath);
    return action();
  });
}

function prepareProjectConfigPath(cwd: string): string {
  const root = path.resolve(cwd);
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || fs.realpathSync(root) !== root) {
    throw new Error("Remote project cwd must be a canonical real directory");
  }
  const projectDirectory = path.join(root, ".pi");
  try {
    fs.mkdirSync(projectDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const projectFilePath = path.join(projectDirectory, CONFIG_FILE);
  assertStoredProjectConfigPathSafe(projectFilePath);
  if (fs.realpathSync(projectDirectory) !== projectDirectory) {
    throw new Error("Remote project config directory must remain contained in the project cwd");
  }
  return projectFilePath;
}

function withStoreLocks<T>(cwd: string, globalFilePath: string, action: (projectFilePath: string) => T): T {
  const projectFilePath = prepareProjectConfigPath(cwd);
  return withGlobalLock(globalFilePath, () => {
    const verifiedPath = prepareProjectConfigPath(cwd);
    if (verifiedPath !== projectFilePath) throw new Error("Remote project config path changed while locking");
    return withFileLock(projectFilePath, () => {
      assertStoredProjectConfigPathSafe(projectFilePath);
      return action(projectFilePath);
    });
  });
}

function readGlobalStore(filePath: string): GlobalRemoteConfigStore {
  return normalizeGlobalStore(readJson(filePath));
}

function readProjectStore(filePath: string): ProjectRemoteConfigStore {
  return normalizeProjectStore(readJson(filePath));
}

export function loadGlobalRemoteConfig(globalFilePath = getGlobalRemoteConfigPath()): GlobalRemoteConfigStore {
  return withGlobalLock(globalFilePath, () => readGlobalStore(globalFilePath));
}

export function loadProjectRemoteConfig(
  cwd: string,
  globalFilePath = getGlobalRemoteConfigPath(),
): ProjectRemoteConfigStore {
  return withStoreLocks(cwd, globalFilePath, (projectFilePath) => readProjectStore(projectFilePath));
}

export function loadRemoteConfigState(
  cwd: string,
  globalFilePath = getGlobalRemoteConfigPath(),
): RemoteConfigState {
  return withStoreLocks(cwd, globalFilePath, (projectFilePath) => {
    const global = readGlobalStore(globalFilePath);
    const project = readProjectStore(projectFilePath);
    return { global, project, config: resolveConfig(global, project) };
  });
}

export function loadRemoteConfig(cwd: string, globalFilePath = getGlobalRemoteConfigPath()): RemoteConfig {
  return loadRemoteConfigState(cwd, globalFilePath).config;
}

export function resolveRemoteTarget(config: RemoteConfig, targetId: string): ResolvedRemoteTarget {
  const target = config.targets[targetId];
  if (!target) throw new Error(`Unknown remote target: ${targetId}`);
  const hostConfig = config.hosts[target.host];
  if (!hostConfig) throw new Error(`Remote target ${targetId} references unknown host ${target.host}`);
  return { id: targetId, ...target, hostConfig };
}

export function resolveRemoteWorkspace(config: RemoteConfig, workspaceRef: string): ResolvedRemoteWorkspace {
  const workspace = config.workspaces[workspaceRef];
  if (!workspace) throw new Error(`Unknown remote workspace: ${workspaceRef}`);
  const hostConfig = config.hosts[workspace.host];
  if (!hostConfig) throw new Error(`Remote workspace ${workspaceRef} references unknown host ${workspace.host}`);
  return { workspaceRef, ...workspace, hostConfig };
}

export function saveGlobalRemoteConfig(
  store: GlobalRemoteConfigStore,
  globalFilePath = getGlobalRemoteConfigPath(),
): GlobalRemoteConfigStore {
  const normalized = normalizeGlobalStore(store);
  resolveConfig(normalized, emptyProjectStore());
  return withGlobalLock(globalFilePath, () => {
    writeJsonAtomic(globalFilePath, normalized);
    return normalized;
  });
}

export function saveProjectRemoteConfig(
  cwd: string,
  store: ProjectRemoteConfigStore,
  globalFilePath = getGlobalRemoteConfigPath(),
): ProjectRemoteConfigStore {
  const normalized = normalizeProjectStore(store);
  return withStoreLocks(cwd, globalFilePath, (projectFilePath) => {
    resolveConfig(readGlobalStore(globalFilePath), normalized);
    writeJsonAtomic(projectFilePath, normalized);
    return normalized;
  });
}

export function replaceRemoteConfigStores(
  cwd: string,
  expected: RemoteConfigStorePair,
  next: RemoteConfigStorePair,
  globalFilePath = getGlobalRemoteConfigPath(),
): RemoteConfigStorePair {
  const expectedNormalized = {
    global: normalizeGlobalStore(expected.global),
    project: normalizeProjectStore(expected.project),
  };
  const nextNormalized = {
    global: normalizeGlobalStore(next.global),
    project: normalizeProjectStore(next.project),
  };
  resolveConfig(nextNormalized.global, nextNormalized.project);
  return withStoreLocks(cwd, globalFilePath, (projectFilePath) => {
    const current = {
      global: readGlobalStore(globalFilePath),
      project: readProjectStore(projectFilePath),
    };
    if (JSON.stringify(current) !== JSON.stringify(expectedNormalized)) {
      throw new Error("Teammate remote config changed after collection");
    }
    const transaction: RemoteConfigTransaction = {
      version: 1,
      mode: "forward",
      projectFilePath,
      globalBefore: current.global,
      globalAfter: nextNormalized.global,
      projectBefore: current.project,
      projectAfter: nextNormalized.project,
    };
    writeJsonAtomic(transactionPath(globalFilePath), transaction);
    try {
      writeJsonAtomic(globalFilePath, nextNormalized.global);
      writeJsonAtomic(projectFilePath, nextNormalized.project);
    } catch (commitError) {
      try {
        writeJsonAtomic(transactionPath(globalFilePath), { ...transaction, mode: "rollback" });
        writeJsonAtomic(globalFilePath, current.global);
        writeJsonAtomic(projectFilePath, current.project);
        removeTransaction(globalFilePath);
      } catch (rollbackError) {
        throw new AggregateError([commitError, rollbackError], "Teammate remote config commit and rollback both failed");
      }
      throw commitError;
    }
    try { removeTransaction(globalFilePath); } catch {
      // The forward journal is idempotent and will be cleared on the next locked operation.
    }
    return nextNormalized;
  });
}

// ---------------------------------------------------------------------------
// Draft validation helpers for the configuration TUI (field-level errors)
// ---------------------------------------------------------------------------

export type RemoteDraftValidation = { ok: true } | { ok: false; error: string };

/** Validate a host draft (id + config) with the same rules as stored config. */
export function validateRemoteHostDraft(id: string, value: unknown): RemoteDraftValidation {
  try {
    validateHostId(id);
    normalizeHost(value, id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Validate a target draft (id + config) with the same rules as stored config. */
export function validateRemoteTargetDraft(id: string, value: unknown): RemoteDraftValidation {
  try {
    validateTargetId(id);
    normalizeTarget(value, id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Validate a workspace draft with the same trusted-cwd rules as stored config. */
export function validateRemoteWorkspaceDraft(workspaceRef: string, value: unknown): RemoteDraftValidation {
  try {
    validateWorkspaceRef(workspaceRef);
    normalizeWorkspace(value, workspaceRef);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
