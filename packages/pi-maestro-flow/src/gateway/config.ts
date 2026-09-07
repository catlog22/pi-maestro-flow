/** ~/.mcpx/config.yaml compatibility reader and canonical Gateway config. */
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  GATEWAY_DEFAULT_LIMITS,
  GATEWAY_HARD_LIMITS,
  GATEWAY_STATE_VERSION,
} from "./contracts.ts";
import {
  gatewayConfigPath,
  readGatewayFile,
  utf8Bytes,
  writeGatewayFileAtomic,
} from "./state-paths.ts";

export type GatewayAuthMode = "open" | "bearer" | "oauth" | "dual";
export type GatewayCommandPolicy = "allow" | "confirm" | "deny";
export type GatewayLogLevel = "silent" | "error" | "warn" | "info" | "debug";

export interface GatewayServerConfig {
  host: string;
  port: number;
  disableLocalhostProtection: boolean;
  trustProxyHeaders: boolean;
  allowedOrigins: string[];
}
export interface GatewayOAuthConfig {
  password?: string;
  serverUrl?: string;
  tokenTtlMs: number;
}
export interface GatewayAuthConfig {
  mode: GatewayAuthMode;
  token?: string;
  oauth?: GatewayOAuthConfig;
  /** Legacy open-HTTP mutation bridge. Omitted preserves v1 behavior with a runtime warning. */
  allowOpenMutations?: boolean;
}
export interface GatewayCommandSecurityConfig {
  default: GatewayCommandPolicy;
  allow: string[];
  confirm: string[];
  deny: string[];
  autoAllowReadonly: boolean | null;
}
export interface GatewayFileSecurityConfig {
  maxReadBytes: number;
  maxPatchFiles: number;
  allow: string[];
  confirm: string[];
  deny: string[];
}
export interface GatewayTrustedFullAccessConfig {
  enabled: boolean;
  workspaceRoots: string[];
}
export interface GatewaySecurityConfig {
  commands: GatewayCommandSecurityConfig;
  files: GatewayFileSecurityConfig;
  trustedFullAccess: GatewayTrustedFullAccessConfig;
}
export interface GatewayWorkspaceConfig {
  path: string;
  id?: string;
  mode?: "lease" | "permanent";
  ttlMs?: number;
  generation?: number;
}
export interface GatewayTlsConfig {
  enabled: boolean;
  certFile?: string;
  keyFile?: string;
}
export interface GatewayTransportConfig {
  stdio: { enabled: boolean };
  http: { enabled: boolean; host: string; port: number; path: string; tls: GatewayTlsConfig };
  ssh: { enabled: boolean };
}
export interface GatewayLimitsConfig {
  maxRequestBytes: number;
  maxOutputBytes: number;
  maxConcurrentRequests: number;
  maxConcurrentJobs: number;
  maxConcurrentTasks: number;
  maxJobs: number;
  maxTasks: number;
  maxCommandBytes: number;
  maxFileReadBytes: number;
  maxFileWriteBytes: number;
  maxPatchFiles: number;
  maxExecTimeoutMs: number;
  maxLeaseTtlMs: number;
  maxWorkspaceCount: number;
  /** Board-only limits are optional in the structural type so legacy policy projections remain source-compatible. */
  maxBoardTasks?: number;
  maxBoardOperations?: number;
  maxBoardEvents?: number;
}
export interface GatewayLoggingConfig {
  level: GatewayLogLevel;
  file?: string;
  auditFile?: string;
}
export interface GatewayStateConfig {
  rootDir?: string;
  ownerPath?: string;
  workspaceRegistryPath?: string;
  sessionsRoot?: string;
  boardRoot?: string;
  pairingPath?: string;
  serviceManifestPath?: string;
}
export interface GatewayRetentionConfig {
  jobsMs: number;
  tasksMs: number;
  resultsMs: number;
  workspacesMs: number;
  boardTasksMs: number;
  boardOperationsMs: number;
  boardEventsMs: number;
}

export interface GatewayConfig {
  version: typeof GATEWAY_STATE_VERSION;
  server: GatewayServerConfig;
  auth: GatewayAuthConfig;
  security: GatewaySecurityConfig;
  workspaces: GatewayWorkspaceConfig[];
  transport: GatewayTransportConfig;
  limits: GatewayLimitsConfig;
  logging: GatewayLoggingConfig;
  state: GatewayStateConfig;
  retention: GatewayRetentionConfig;
}

export type GatewayConfigPatch = {
  [K in keyof GatewayConfig]?: GatewayConfig[K] | null;
} & Record<string, unknown>;

export interface GatewayConfigDocument {
  config: GatewayConfig;
  /** Top-level sections not owned by the Gateway (discovery, terminal, etc.). */
  unknownSections: Record<string, unknown>;
  /** Original text, retained so unknown sections/comments survive a write. */
  raw: string;
  path?: string;
}

export class GatewayConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayConfigValidationError";
  }
}

const KNOWN_SECTIONS = new Set(["version", "server", "auth", "security", "workspaces", "transport", "limits", "logging", "state", "retention"]);
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

const DEFAULT_SERVER: GatewayServerConfig = {
  host: "127.0.0.1",
  port: 9090,
  disableLocalhostProtection: false,
  trustProxyHeaders: false,
  allowedOrigins: [],
};
const DEFAULT_AUTH: GatewayAuthConfig = { mode: "open" };
const DEFAULT_SECURITY: GatewaySecurityConfig = {
  commands: { default: "allow", allow: [], confirm: [], deny: [], autoAllowReadonly: null },
  files: { maxReadBytes: GATEWAY_DEFAULT_LIMITS.maxFileReadBytes, maxPatchFiles: GATEWAY_DEFAULT_LIMITS.maxPatchFiles, allow: [], confirm: [], deny: [] },
  trustedFullAccess: { enabled: false, workspaceRoots: [] },
};
const DEFAULT_TRANSPORT: GatewayTransportConfig = {
  stdio: { enabled: true },
  http: { enabled: true, host: "127.0.0.1", port: 9090, path: "/mcp", tls: { enabled: false } },
  ssh: { enabled: true },
};
const DEFAULT_RETENTION: GatewayRetentionConfig = {
  jobsMs: 7 * 24 * 60 * 60 * 1000,
  tasksMs: 30 * 24 * 60 * 60 * 1000,
  resultsMs: 30 * 24 * 60 * 60 * 1000,
  workspacesMs: 24 * 60 * 60 * 1000,
  boardTasksMs: 90 * 24 * 60 * 60 * 1000,
  boardOperationsMs: 30 * 24 * 60 * 60 * 1000,
  boardEventsMs: 30 * 24 * 60 * 60 * 1000,
};

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new GatewayConfigValidationError(`${path} must be a mapping`);
  return value as Record<string, unknown>;
}
function optionalObject(value: unknown, path: string): Record<string, unknown> {
  return value === undefined || value === null ? {} : object(value, path);
}
function knownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) throw new GatewayConfigValidationError(`${path}.${key} is not a recognized field`);
}
function stringValue(value: unknown, path: string, max = 4096): string {
  if (typeof value !== "string" || value.trim() === "") throw new GatewayConfigValidationError(`${path} must be a non-empty string`);
  if (utf8Bytes(value) > max) throw new GatewayConfigValidationError(`${path} exceeds ${max} UTF-8 bytes`);
  return value;
}
function optionalString(value: unknown, path: string, max = 4096): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return stringValue(value, path, max);
}
function bool(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new GatewayConfigValidationError(`${path} must be a boolean`);
  return value;
}
function integer(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER, fallback?: number): number {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new GatewayConfigValidationError(`${path} is required`);
  }
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new GatewayConfigValidationError(`${path} must be an integer in [${min}, ${max}]`);
  return value as number;
}
function stringList(value: unknown, path: string, maxItems = 256): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new GatewayConfigValidationError(`${path} must be a list of at most ${maxItems} strings`);
  return value.map((item, index) => stringValue(item, `${path}[${index}]`, 4096));
}
function pick<T>(record: Record<string, unknown>, camel: string, snake: string): unknown {
  return record[camel] ?? record[snake];
}
function boundedLimit(value: unknown, path: string, fallback: number, hard: number): number {
  const result = integer(value, path, 1, hard, fallback);
  return result;
}

export function defaultGatewayConfig(): GatewayConfig {
  return structuredClone({
    version: GATEWAY_STATE_VERSION,
    server: DEFAULT_SERVER,
    auth: DEFAULT_AUTH,
    security: DEFAULT_SECURITY,
    workspaces: [],
    transport: DEFAULT_TRANSPORT,
    limits: GATEWAY_DEFAULT_LIMITS,
    logging: { level: "info" as const },
    state: {},
    retention: DEFAULT_RETENTION,
  });
}

export function normalizeGatewayConfig(value: unknown): GatewayConfig {
  const root = object(value ?? {}, "config");
  if (root.version !== undefined && root.version !== GATEWAY_STATE_VERSION) throw new GatewayConfigValidationError(`config.version must be ${GATEWAY_STATE_VERSION}`);

  const serverRaw = optionalObject(root.server, "server");
  knownKeys(serverRaw, ["host", "port", "disable_localhost_protection", "trust_proxy_headers", "allowed_origins", "disableLocalhostProtection", "trustProxyHeaders", "allowedOrigins"], "server");
  const server: GatewayServerConfig = {
    host: serverRaw.host === undefined ? DEFAULT_SERVER.host : stringValue(serverRaw.host, "server.host", 255),
    port: integer(serverRaw.port, "server.port", 1, 65535, DEFAULT_SERVER.port),
    disableLocalhostProtection: bool(pick(serverRaw, "disableLocalhostProtection", "disable_localhost_protection"), "server.disableLocalhostProtection", DEFAULT_SERVER.disableLocalhostProtection),
    trustProxyHeaders: bool(pick(serverRaw, "trustProxyHeaders", "trust_proxy_headers"), "server.trustProxyHeaders", DEFAULT_SERVER.trustProxyHeaders),
    allowedOrigins: stringList(pick(serverRaw, "allowedOrigins", "allowed_origins"), "server.allowedOrigins", 64),
  };

  const authRaw = optionalObject(root.auth, "auth");
  knownKeys(authRaw, [
    "mode", "token", "oauth", "allowOpenMutations", "allow_open_mutations",
    "oauth_password", "oauth_server_url", "oauth_token_ttl", "oauth_token_ttl_ms",
    "oauth_token_secret", "oauth_client_id", "oauth_client_secret", "oauth_redirect_uris",
  ], "auth");
  const authMode = authRaw.mode === undefined ? DEFAULT_AUTH.mode : authRaw.mode;
  if (authMode !== "open" && authMode !== "bearer" && authMode !== "oauth" && authMode !== "dual") throw new GatewayConfigValidationError("auth.mode must be open, bearer, oauth, or dual");
  const token = optionalString(authRaw.token, "auth.token", 4096);
  const hasFlatOauth = Object.keys(authRaw).some((key) => key.startsWith("oauth_"));
  const oauthRaw = authRaw.oauth === undefined
    ? (hasFlatOauth ? {
      password: authRaw.oauth_password,
      server_url: authRaw.oauth_server_url,
      token_ttl: authRaw.oauth_token_ttl,
      token_ttl_ms: authRaw.oauth_token_ttl_ms,
      token_secret: authRaw.oauth_token_secret,
      client_id: authRaw.oauth_client_id,
      client_secret: authRaw.oauth_client_secret,
      redirect_uris: authRaw.oauth_redirect_uris,
    } : undefined)
    : optionalObject(authRaw.oauth, "auth.oauth");
  let oauth: GatewayOAuthConfig | undefined;
  if (oauthRaw) {
    knownKeys(oauthRaw, [
      "password", "server_url", "serverUrl", "token_ttl", "tokenTtlMs", "token_ttl_ms",
      "token_secret", "client_id", "client_secret", "redirect_uris",
    ], "auth.oauth");
    const ttlSeconds = oauthRaw.token_ttl;
    const tokenTtlMs = oauthRaw.tokenTtlMs ?? oauthRaw.token_ttl_ms ?? (ttlSeconds === undefined ? 24 * 60 * 60 * 1000 : integer(ttlSeconds, "auth.oauth.token_ttl", 1, 30 * 24 * 60 * 60) * 1000);
    oauth = {
      password: optionalString(oauthRaw.password, "auth.oauth.password", 4096),
      serverUrl: optionalString(oauthRaw.serverUrl ?? oauthRaw.server_url, "auth.oauth.serverUrl", 4096),
      tokenTtlMs: integer(tokenTtlMs, "auth.oauth.tokenTtlMs", 1, 30 * 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000),
    };
  }
  if ((authMode === "bearer" || authMode === "dual") && !token) throw new GatewayConfigValidationError(`auth.token is required when auth.mode=${authMode}`);
  if ((authMode === "oauth" || authMode === "dual") && !oauth) throw new GatewayConfigValidationError(`auth.oauth is required when auth.mode=${authMode}`);
  const allowOpenMutationsRaw = authRaw.allowOpenMutations ?? authRaw.allow_open_mutations;
  if (allowOpenMutationsRaw !== undefined && typeof allowOpenMutationsRaw !== "boolean") throw new GatewayConfigValidationError("auth.allowOpenMutations must be boolean");
  const auth: GatewayAuthConfig = {
    mode: authMode,
    ...(token === undefined ? {} : { token }),
    ...(oauth === undefined ? {} : { oauth }),
    ...(allowOpenMutationsRaw === undefined ? {} : { allowOpenMutations: allowOpenMutationsRaw }),
  };

  const securityRaw = optionalObject(root.security, "security");
  knownKeys(securityRaw, ["commands", "files", "trustedFullAccess", "trusted_full_access"], "security");
  const commandsRaw = optionalObject(securityRaw.commands, "security.commands");
  knownKeys(commandsRaw, ["default", "allow", "confirm", "deny", "auto_allow_readonly", "autoAllowReadonly"], "security.commands");
  const commandDefault = commandsRaw.default === undefined ? DEFAULT_SECURITY.commands.default : commandsRaw.default;
  if (commandDefault !== "allow" && commandDefault !== "confirm" && commandDefault !== "deny") throw new GatewayConfigValidationError("security.commands.default must be allow, confirm, or deny");
  const autoReadonlyRaw = pick(commandsRaw, "autoAllowReadonly", "auto_allow_readonly");
  if (autoReadonlyRaw !== undefined && autoReadonlyRaw !== null && typeof autoReadonlyRaw !== "boolean") throw new GatewayConfigValidationError("security.commands.autoAllowReadonly must be boolean or null");
  const commands: GatewayCommandSecurityConfig = {
    default: commandDefault,
    allow: stringList(commandsRaw.allow, "security.commands.allow"),
    confirm: stringList(commandsRaw.confirm, "security.commands.confirm"),
    deny: stringList(commandsRaw.deny, "security.commands.deny"),
    autoAllowReadonly: autoReadonlyRaw === undefined ? DEFAULT_SECURITY.commands.autoAllowReadonly : autoReadonlyRaw as boolean | null,
  };
  const filesRaw = optionalObject(securityRaw.files, "security.files");
  knownKeys(filesRaw, ["max_read_bytes", "maxReadBytes", "max_patch_files", "maxPatchFiles", "max_patch_lines", "allow", "confirm", "deny"], "security.files");
  const files: GatewayFileSecurityConfig = {
    maxReadBytes: boundedLimit(pick(filesRaw, "maxReadBytes", "max_read_bytes"), "security.files.maxReadBytes", DEFAULT_SECURITY.files.maxReadBytes, GATEWAY_HARD_LIMITS.maxFileReadBytes),
    maxPatchFiles: boundedLimit(pick(filesRaw, "maxPatchFiles", "max_patch_files"), "security.files.maxPatchFiles", DEFAULT_SECURITY.files.maxPatchFiles, GATEWAY_HARD_LIMITS.maxPatchFiles),
    allow: stringList(filesRaw.allow, "security.files.allow"),
    confirm: stringList(filesRaw.confirm, "security.files.confirm"),
    deny: stringList(filesRaw.deny, "security.files.deny"),
  };
  const trustedRaw = optionalObject(securityRaw.trustedFullAccess ?? securityRaw.trusted_full_access, "security.trustedFullAccess");
  knownKeys(trustedRaw, ["enabled", "workspaceRoots", "workspace_roots"], "security.trustedFullAccess");
  const trustedFullAccess: GatewayTrustedFullAccessConfig = {
    enabled: bool(trustedRaw.enabled, "security.trustedFullAccess.enabled", false),
    workspaceRoots: stringList(trustedRaw.workspaceRoots ?? trustedRaw.workspace_roots, "security.trustedFullAccess.workspaceRoots", 64),
  };
  if (trustedFullAccess.enabled && authMode === "open") throw new GatewayConfigValidationError("security.trustedFullAccess requires authenticated HTTP (auth.mode cannot be open)");

  const workspacesRaw = root.workspaces;
  if (workspacesRaw !== undefined && !Array.isArray(workspacesRaw) && (typeof workspacesRaw !== "object" || workspacesRaw === null)) throw new GatewayConfigValidationError("workspaces must be a list or mapping");
  const workspaceEntries: unknown[] = Array.isArray(workspacesRaw)
    ? workspacesRaw
    : workspacesRaw && typeof workspacesRaw === "object"
      ? Object.entries(workspacesRaw as Record<string, unknown>).map(([path, entry]) => entry && typeof entry === "object" && !Array.isArray(entry) ? { ...(entry as Record<string, unknown>), path: (entry as Record<string, unknown>).path ?? path } : { path, ttl: entry })
      : [];
  const workspaces: GatewayWorkspaceConfig[] = workspaceEntries.map((entry, index) => {
    const item = object(entry, `workspaces[${index}]`);
    knownKeys(item, ["path", "workspacePath", "canonicalPath", "name", "id", "workspaceId", "mode", "permanent", "ttl", "ttl_ms", "ttlMs", "ttl_seconds", "ttlSeconds", "expires_at", "expiresAt", "owner_token", "ownerToken", "generation"], `workspaces[${index}]`);
    const path = stringValue(item.path ?? item.workspacePath ?? item.canonicalPath, `workspaces[${index}].path`, 4096);
    const directTtl = item.ttlMs ?? item.ttl_ms;
    const secondsTtl = item.ttlSeconds ?? item.ttl_seconds ?? item.ttl;
    const legacyExpiry = item.expiresAt ?? item.expires_at;
    const modeRaw = item.mode ?? (item.permanent === true || item.ttl === null || (directTtl === undefined && secondsTtl === undefined && legacyExpiry === undefined) ? "permanent" : "lease");
    if (modeRaw !== "lease" && modeRaw !== "permanent") throw new GatewayConfigValidationError(`workspaces[${index}].mode must be lease or permanent`);
    const mode = modeRaw as "lease" | "permanent";
    let ttlMs = directTtl !== undefined && directTtl !== null
      ? integer(directTtl, `workspaces[${index}].ttlMs`, 1, GATEWAY_HARD_LIMITS.maxLeaseTtlMs)
      : secondsTtl === undefined || secondsTtl === null
        ? undefined
        : integer(secondsTtl, `workspaces[${index}].ttl`, 1, GATEWAY_HARD_LIMITS.maxLeaseTtlMs / 1000) * 1000;
    if (ttlMs === undefined && legacyExpiry !== undefined && legacyExpiry !== null) {
      const expiresAt = typeof legacyExpiry === "number" ? legacyExpiry : Date.parse(String(legacyExpiry));
      if (!Number.isFinite(expiresAt)) throw new GatewayConfigValidationError(`workspaces[${index}].expiresAt must be an ISO timestamp or epoch milliseconds`);
      ttlMs = Math.min(GATEWAY_HARD_LIMITS.maxLeaseTtlMs, Math.max(1, Math.floor(expiresAt - Date.now())));
    }
    return {
      path,
      ...(item.id === undefined && item.workspaceId === undefined ? {} : { id: stringValue(item.id ?? item.workspaceId, `workspaces[${index}].id`, 256) }),
      mode,
      ...(ttlMs === undefined || mode === "permanent" ? {} : { ttlMs: Math.min(ttlMs, GATEWAY_HARD_LIMITS.maxLeaseTtlMs) }),
      ...(item.generation === undefined ? {} : { generation: integer(item.generation, `workspaces[${index}].generation`, 1) }),
    };
  });

  const transportRaw = optionalObject(root.transport, "transport");
  knownKeys(transportRaw, ["stdio", "http", "ssh", "session_idle_ttl"], "transport");
  const stdioRaw = optionalObject(transportRaw.stdio, "transport.stdio");
  knownKeys(stdioRaw, ["enabled"], "transport.stdio");
  const httpRaw = optionalObject(transportRaw.http, "transport.http");
  knownKeys(httpRaw, ["enabled", "host", "port", "path", "tls"], "transport.http");
  const tlsRaw = optionalObject(httpRaw.tls, "transport.http.tls");
  knownKeys(tlsRaw, ["enabled", "certFile", "cert_file", "keyFile", "key_file"], "transport.http.tls");
  const tlsEnabled = bool(tlsRaw.enabled, "transport.http.tls.enabled", false);
  const tls = {
    enabled: tlsEnabled,
    ...(optionalString(tlsRaw.certFile ?? tlsRaw.cert_file, "transport.http.tls.certFile", 4096) ? { certFile: optionalString(tlsRaw.certFile ?? tlsRaw.cert_file, "transport.http.tls.certFile", 4096) } : {}),
    ...(optionalString(tlsRaw.keyFile ?? tlsRaw.key_file, "transport.http.tls.keyFile", 4096) ? { keyFile: optionalString(tlsRaw.keyFile ?? tlsRaw.key_file, "transport.http.tls.keyFile", 4096) } : {}),
  };
  if (tlsEnabled && (!tls.certFile || !tls.keyFile)) throw new GatewayConfigValidationError("transport.http.tls requires certFile and keyFile when enabled");
  const sshRaw = optionalObject(transportRaw.ssh, "transport.ssh");
  knownKeys(sshRaw, ["enabled"], "transport.ssh");
  const transport: GatewayTransportConfig = {
    stdio: { enabled: bool(stdioRaw.enabled, "transport.stdio.enabled", DEFAULT_TRANSPORT.stdio.enabled) },
    http: {
      enabled: bool(httpRaw.enabled, "transport.http.enabled", DEFAULT_TRANSPORT.http.enabled),
      host: httpRaw.host === undefined ? server.host : stringValue(httpRaw.host, "transport.http.host", 255),
      port: integer(httpRaw.port, "transport.http.port", 1, 65535, server.port),
      path: httpRaw.path === undefined ? DEFAULT_TRANSPORT.http.path : stringValue(httpRaw.path, "transport.http.path", 1024),
      tls,
    },
    ssh: { enabled: bool(sshRaw.enabled, "transport.ssh.enabled", DEFAULT_TRANSPORT.ssh.enabled) },
  };

  const limitsRaw = optionalObject(root.limits, "limits");
  knownKeys(limitsRaw, [
    ...Object.keys(GATEWAY_DEFAULT_LIMITS).flatMap((key) => [key, key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)]),
    "max_result_bytes",
  ], "limits");
  const limits: GatewayLimitsConfig = {
    maxRequestBytes: boundedLimit(pick(limitsRaw, "maxRequestBytes", "max_request_bytes"), "limits.maxRequestBytes", GATEWAY_DEFAULT_LIMITS.maxRequestBytes, GATEWAY_HARD_LIMITS.maxRequestBytes),
    maxOutputBytes: boundedLimit(limitsRaw.maxOutputBytes ?? limitsRaw.max_output_bytes ?? limitsRaw.max_result_bytes, "limits.maxOutputBytes", GATEWAY_DEFAULT_LIMITS.maxOutputBytes, GATEWAY_HARD_LIMITS.maxOutputBytes),
    maxConcurrentRequests: boundedLimit(pick(limitsRaw, "maxConcurrentRequests", "max_concurrent_requests"), "limits.maxConcurrentRequests", GATEWAY_DEFAULT_LIMITS.maxConcurrentRequests, GATEWAY_HARD_LIMITS.maxConcurrentRequests),
    maxConcurrentJobs: boundedLimit(pick(limitsRaw, "maxConcurrentJobs", "max_concurrent_jobs"), "limits.maxConcurrentJobs", GATEWAY_DEFAULT_LIMITS.maxConcurrentJobs, GATEWAY_HARD_LIMITS.maxConcurrentJobs),
    maxConcurrentTasks: boundedLimit(pick(limitsRaw, "maxConcurrentTasks", "max_concurrent_tasks"), "limits.maxConcurrentTasks", GATEWAY_DEFAULT_LIMITS.maxConcurrentTasks, GATEWAY_HARD_LIMITS.maxConcurrentTasks),
    maxJobs: boundedLimit(pick(limitsRaw, "maxJobs", "max_jobs"), "limits.maxJobs", GATEWAY_DEFAULT_LIMITS.maxJobs, GATEWAY_HARD_LIMITS.maxJobs),
    maxTasks: boundedLimit(pick(limitsRaw, "maxTasks", "max_tasks"), "limits.maxTasks", GATEWAY_DEFAULT_LIMITS.maxTasks, GATEWAY_HARD_LIMITS.maxTasks),
    maxCommandBytes: boundedLimit(pick(limitsRaw, "maxCommandBytes", "max_command_bytes"), "limits.maxCommandBytes", GATEWAY_DEFAULT_LIMITS.maxCommandBytes, GATEWAY_HARD_LIMITS.maxCommandBytes),
    maxFileReadBytes: boundedLimit(pick(limitsRaw, "maxFileReadBytes", "max_file_read_bytes"), "limits.maxFileReadBytes", GATEWAY_DEFAULT_LIMITS.maxFileReadBytes, GATEWAY_HARD_LIMITS.maxFileReadBytes),
    maxFileWriteBytes: boundedLimit(pick(limitsRaw, "maxFileWriteBytes", "max_file_write_bytes"), "limits.maxFileWriteBytes", GATEWAY_DEFAULT_LIMITS.maxFileWriteBytes, GATEWAY_HARD_LIMITS.maxFileWriteBytes),
    maxPatchFiles: boundedLimit(pick(limitsRaw, "maxPatchFiles", "max_patch_files"), "limits.maxPatchFiles", GATEWAY_DEFAULT_LIMITS.maxPatchFiles, GATEWAY_HARD_LIMITS.maxPatchFiles),
    maxExecTimeoutMs: boundedLimit(pick(limitsRaw, "maxExecTimeoutMs", "max_exec_timeout_ms"), "limits.maxExecTimeoutMs", GATEWAY_DEFAULT_LIMITS.maxExecTimeoutMs, GATEWAY_HARD_LIMITS.maxExecTimeoutMs),
    maxLeaseTtlMs: boundedLimit(pick(limitsRaw, "maxLeaseTtlMs", "max_lease_ttl_ms"), "limits.maxLeaseTtlMs", GATEWAY_DEFAULT_LIMITS.maxLeaseTtlMs, GATEWAY_HARD_LIMITS.maxLeaseTtlMs),
    maxWorkspaceCount: boundedLimit(pick(limitsRaw, "maxWorkspaceCount", "max_workspace_count"), "limits.maxWorkspaceCount", GATEWAY_DEFAULT_LIMITS.maxWorkspaceCount, GATEWAY_HARD_LIMITS.maxWorkspaceCount),
    maxBoardTasks: boundedLimit(pick(limitsRaw, "maxBoardTasks", "max_board_tasks"), "limits.maxBoardTasks", GATEWAY_DEFAULT_LIMITS.maxBoardTasks, GATEWAY_HARD_LIMITS.maxBoardTasks),
    maxBoardOperations: boundedLimit(pick(limitsRaw, "maxBoardOperations", "max_board_operations"), "limits.maxBoardOperations", GATEWAY_DEFAULT_LIMITS.maxBoardOperations, GATEWAY_HARD_LIMITS.maxBoardOperations),
    maxBoardEvents: boundedLimit(pick(limitsRaw, "maxBoardEvents", "max_board_events"), "limits.maxBoardEvents", GATEWAY_DEFAULT_LIMITS.maxBoardEvents, GATEWAY_HARD_LIMITS.maxBoardEvents),
  };

  const loggingRaw = optionalObject(root.logging, "logging");
  knownKeys(loggingRaw, ["level", "file", "audit_file", "auditFile", "enabled", "dir"], "logging");
  const level = loggingRaw.level === undefined ? "info" : loggingRaw.level;
  if (level !== "silent" && level !== "error" && level !== "warn" && level !== "info" && level !== "debug") throw new GatewayConfigValidationError("logging.level is invalid");
  const logging: GatewayLoggingConfig = {
    level,
    ...(optionalString(loggingRaw.file, "logging.file", 4096) === undefined ? {} : { file: optionalString(loggingRaw.file, "logging.file", 4096) }),
    ...(optionalString(loggingRaw.auditFile ?? loggingRaw.audit_file, "logging.auditFile", 4096) === undefined ? {} : { auditFile: optionalString(loggingRaw.auditFile ?? loggingRaw.audit_file, "logging.auditFile", 4096) }),
  };
  const stateRaw = optionalObject(root.state, "state");
  knownKeys(stateRaw, ["rootDir", "root_dir", "ownerPath", "owner_path", "workspaceRegistryPath", "workspace_registry_path", "sessionsRoot", "sessions_root", "boardRoot", "board_root", "pairingPath", "pairing_path", "serviceManifestPath", "service_manifest_path", "retention"], "state");
  const state: GatewayStateConfig = {
    ...(optionalString(stateRaw.rootDir ?? stateRaw.root_dir, "state.rootDir", 4096) === undefined ? {} : { rootDir: optionalString(stateRaw.rootDir ?? stateRaw.root_dir, "state.rootDir", 4096) }),
    ...(optionalString(stateRaw.ownerPath ?? stateRaw.owner_path, "state.ownerPath", 4096) === undefined ? {} : { ownerPath: optionalString(stateRaw.ownerPath ?? stateRaw.owner_path, "state.ownerPath", 4096) }),
    ...(optionalString(stateRaw.workspaceRegistryPath ?? stateRaw.workspace_registry_path, "state.workspaceRegistryPath", 4096) === undefined ? {} : { workspaceRegistryPath: optionalString(stateRaw.workspaceRegistryPath ?? stateRaw.workspace_registry_path, "state.workspaceRegistryPath", 4096) }),
    ...(optionalString(stateRaw.sessionsRoot ?? stateRaw.sessions_root, "state.sessionsRoot", 4096) === undefined ? {} : { sessionsRoot: optionalString(stateRaw.sessionsRoot ?? stateRaw.sessions_root, "state.sessionsRoot", 4096) }),
    ...(optionalString(stateRaw.boardRoot ?? stateRaw.board_root, "state.boardRoot", 4096) === undefined ? {} : { boardRoot: optionalString(stateRaw.boardRoot ?? stateRaw.board_root, "state.boardRoot", 4096) }),
    ...(optionalString(stateRaw.pairingPath ?? stateRaw.pairing_path, "state.pairingPath", 4096) === undefined ? {} : { pairingPath: optionalString(stateRaw.pairingPath ?? stateRaw.pairing_path, "state.pairingPath", 4096) }),
    ...(optionalString(stateRaw.serviceManifestPath ?? stateRaw.service_manifest_path, "state.serviceManifestPath", 4096) === undefined ? {} : { serviceManifestPath: optionalString(stateRaw.serviceManifestPath ?? stateRaw.service_manifest_path, "state.serviceManifestPath", 4096) }),
  };
  const retentionRaw = optionalObject(root.retention, "retention");
  knownKeys(retentionRaw, ["jobsMs", "jobs_ms", "jobs", "tasksMs", "tasks_ms", "tasks", "resultsMs", "results_ms", "results", "workspacesMs", "workspaces_ms", "workspaces", "boardTasksMs", "board_tasks_ms", "board_tasks", "boardOperationsMs", "board_operations_ms", "board_operations", "boardEventsMs", "board_events_ms", "board_events"], "retention");
  const retention: GatewayRetentionConfig = {
    jobsMs: boundedLimit(retentionRaw.jobsMs ?? retentionRaw.jobs_ms ?? retentionRaw.jobs, "retention.jobsMs", DEFAULT_RETENTION.jobsMs, 365 * 24 * 60 * 60 * 1000),
    tasksMs: boundedLimit(retentionRaw.tasksMs ?? retentionRaw.tasks_ms ?? retentionRaw.tasks, "retention.tasksMs", DEFAULT_RETENTION.tasksMs, 365 * 24 * 60 * 60 * 1000),
    resultsMs: boundedLimit(retentionRaw.resultsMs ?? retentionRaw.results_ms ?? retentionRaw.results, "retention.resultsMs", DEFAULT_RETENTION.resultsMs, 365 * 24 * 60 * 60 * 1000),
    workspacesMs: boundedLimit(retentionRaw.workspacesMs ?? retentionRaw.workspaces_ms ?? retentionRaw.workspaces, "retention.workspacesMs", DEFAULT_RETENTION.workspacesMs, 365 * 24 * 60 * 60 * 1000),
    boardTasksMs: boundedLimit(retentionRaw.boardTasksMs ?? retentionRaw.board_tasks_ms ?? retentionRaw.board_tasks, "retention.boardTasksMs", DEFAULT_RETENTION.boardTasksMs, 365 * 24 * 60 * 60 * 1000),
    boardOperationsMs: boundedLimit(retentionRaw.boardOperationsMs ?? retentionRaw.board_operations_ms ?? retentionRaw.board_operations, "retention.boardOperationsMs", DEFAULT_RETENTION.boardOperationsMs, 365 * 24 * 60 * 60 * 1000),
    boardEventsMs: boundedLimit(retentionRaw.boardEventsMs ?? retentionRaw.board_events_ms ?? retentionRaw.board_events, "retention.boardEventsMs", DEFAULT_RETENTION.boardEventsMs, 365 * 24 * 60 * 60 * 1000),
  };
  return {
    version: GATEWAY_STATE_VERSION,
    server,
    auth,
    security: { commands, files, trustedFullAccess },
    workspaces,
    transport,
    limits,
    logging,
    state,
    retention,
  };
}

function splitTopLevelSections(text: string): Array<{ key: string; raw: string }> {
  const lines = text.split(/(?<=\n)/);
  const sections: Array<{ key: string; raw: string }> = [];
  let current: { key: string; raw: string } | undefined;
  for (const line of lines) {
    const match = /^(?<key>[A-Za-z_][A-Za-z0-9_-]*):(?:\s|$)/.exec(line);
    if (match?.groups?.key) {
      if (current) sections.push(current);
      current = { key: match.groups.key, raw: line };
    } else if (current) current.raw += line;
    else if (line.trim() !== "") sections.push({ key: "__preamble__", raw: line });
  }
  if (current) sections.push(current);
  return sections;
}

function parseRawDocument(text: string): Record<string, unknown> {
  try {
    const parsed = parseYaml(text);
    return object(parsed ?? {}, "config");
  } catch (error) {
    throw new GatewayConfigValidationError(`Invalid config YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseGatewayConfigDocument(text: string, path?: string): GatewayConfigDocument {
  if (utf8Bytes(text) > MAX_CONFIG_BYTES) throw new GatewayConfigValidationError(`config exceeds ${MAX_CONFIG_BYTES} bytes`);
  const raw = parseRawDocument(text);
  const unknownSections: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) if (!KNOWN_SECTIONS.has(key)) unknownSections[key] = value;
  return { config: normalizeGatewayConfig(raw), unknownSections, raw: text, ...(path === undefined ? {} : { path }) };
}
export const parseGatewayYaml = parseGatewayConfigDocument;

export function parseGatewayConfig(value: unknown): GatewayConfig {
  return normalizeGatewayConfig(value);
}

export async function readGatewayConfigDocument(path = gatewayConfigPath()): Promise<GatewayConfigDocument> {
  const raw = await readGatewayFile(path, MAX_CONFIG_BYTES);
  return parseGatewayConfigDocument(raw ?? "", path);
}
export async function loadGatewayConfig(path = gatewayConfigPath()): Promise<GatewayConfig> {
  return (await readGatewayConfigDocument(path)).config;
}
export function loadGatewayConfigSync(path = gatewayConfigPath()): GatewayConfig {
  try { return parseGatewayConfigDocument(readFileSync(path, "utf8"), path).config; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultGatewayConfig();
    throw error;
  }
}
export const readGatewayConfig = loadGatewayConfig;

function toYamlSection(key: string, value: unknown): string {
  return stringifyYaml({ [key]: value }, { lineWidth: 0 }).trimEnd() + "\n";
}

function topLevelRawKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function canonicalYamlSection(key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (key === "server") {
    const v = value as Record<string, unknown>;
    const { disableLocalhostProtection, disable_localhost_protection, trustProxyHeaders, trust_proxy_headers, allowedOrigins, allowed_origins, ...rest } = v;
    return {
      ...rest,
      ...(disableLocalhostProtection === undefined ? (disable_localhost_protection === undefined ? {} : { disable_localhost_protection }) : { disable_localhost_protection: disableLocalhostProtection }),
      ...(trustProxyHeaders === undefined ? (trust_proxy_headers === undefined ? {} : { trust_proxy_headers }) : { trust_proxy_headers: trustProxyHeaders }),
      ...(allowedOrigins === undefined ? (allowed_origins === undefined ? {} : { allowed_origins }) : { allowed_origins: allowedOrigins }),
    };
  }
  if (key === "auth") {
    const v = value as Record<string, unknown>;
    const { oauth: rawOauth, allowOpenMutations, allow_open_mutations, ...rest } = v;
    let oauth: unknown = rawOauth;
    if (rawOauth && typeof rawOauth === "object" && !Array.isArray(rawOauth)) {
      const o = rawOauth as Record<string, unknown>;
      const { serverUrl, server_url, tokenTtlMs, token_ttl, token_ttl_ms, ...oauthRest } = o;
      oauth = {
        ...oauthRest,
        ...(serverUrl === undefined ? (server_url === undefined ? {} : { server_url }) : { server_url: serverUrl }),
        ...(tokenTtlMs === undefined
          ? (token_ttl === undefined ? (token_ttl_ms === undefined ? {} : { token_ttl: Math.floor((token_ttl_ms as number) / 1000) }) : { token_ttl })
          : { token_ttl: Math.floor((tokenTtlMs as number) / 1000) }),
      };
    }
    return {
      ...rest,
      ...(allowOpenMutations === undefined ? (allow_open_mutations === undefined ? {} : { allow_open_mutations }) : { allow_open_mutations: allowOpenMutations }),
      ...(oauth === undefined ? {} : { oauth }),
    };
  }
  if (key === "security") {
    const v = value as Record<string, unknown>;
    const { commands: rawCommands, files: rawFiles, ...rest } = v;
    const normalizeCommands = rawCommands && typeof rawCommands === "object" && !Array.isArray(rawCommands)
      ? (() => {
        const c = rawCommands as Record<string, unknown>;
        const { autoAllowReadonly, auto_allow_readonly, ...commandsRest } = c;
        return { ...commandsRest, ...(autoAllowReadonly === undefined ? (auto_allow_readonly === undefined ? {} : { auto_allow_readonly }) : { auto_allow_readonly: autoAllowReadonly }) };
      })() : rawCommands;
    const normalizeFiles = rawFiles && typeof rawFiles === "object" && !Array.isArray(rawFiles)
      ? (() => {
        const f = rawFiles as Record<string, unknown>;
        const { maxReadBytes, max_read_bytes, maxPatchFiles, max_patch_files, ...filesRest } = f;
        return {
          ...filesRest,
          ...(maxReadBytes === undefined ? (max_read_bytes === undefined ? {} : { max_read_bytes }) : { max_read_bytes: maxReadBytes }),
          ...(maxPatchFiles === undefined ? (max_patch_files === undefined ? {} : { max_patch_files }) : { max_patch_files: maxPatchFiles }),
        };
      })() : rawFiles;
    return { ...rest, ...(normalizeCommands === undefined ? {} : { commands: normalizeCommands }), ...(normalizeFiles === undefined ? {} : { files: normalizeFiles }) };
  }
  return value;
}

/** Apply a patch while distinguishing omitted (preserve), object replacement, and null (clear). */
export function applyGatewayConfigPatch(base: GatewayConfig, patch: GatewayConfigPatch): GatewayConfig {
  const raw = structuredClone(base) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (key === "version" || value === undefined) continue;
    const next = mergeRawValue(raw[key], value);
    if (next === undefined) delete raw[key]; else raw[key] = next;
  }
  return normalizeGatewayConfig(raw);
}

function mergeRawValue(base: unknown, patch: unknown): unknown {
  if (patch === null) return undefined;
  if (Array.isArray(patch) || patch === undefined || typeof patch !== "object" || patch === null) return structuredClone(patch);
  const result: Record<string, unknown> = base && typeof base === "object" && !Array.isArray(base)
    ? structuredClone(base as Record<string, unknown>)
    : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    const next = mergeRawValue(result[key], value);
    if (next === undefined) delete result[key]; else result[key] = next;
  }
  return result;
}

function replaceSections(text: string, changed: Record<string, unknown>): string {
  const sections = splitTopLevelSections(text);
  const touched = new Set(Object.keys(changed).map(topLevelRawKey));
  let output = "";
  const emitted = new Set<string>();
  for (const section of sections) {
    if (section.key === "__preamble__") { output += section.raw; continue; }
    if (touched.has(section.key)) {
      if (changed[section.key] !== undefined) output += toYamlSection(section.key, canonicalYamlSection(section.key, changed[section.key]));
      emitted.add(section.key);
    } else output += section.raw;
  }
  for (const [inputKey, value] of Object.entries(changed)) {
    const key = topLevelRawKey(inputKey);
    if (!emitted.has(key) && !sections.some((section) => section.key === key)) {
      if (output && !output.endsWith("\n")) output += "\n";
      output += toYamlSection(key, canonicalYamlSection(inputKey, value));
    }
  }
  return output.endsWith("\n") ? output : `${output}\n`;
}

/**
 * Replace only supplied top-level sections. Unowned sections and comments are
 * copied verbatim from the existing file; omitted fields remain untouched.
 */
export async function writeGatewayConfigPatch(
  path: string,
  patch: GatewayConfigPatch,
  cwd = process.cwd(),
): Promise<GatewayConfigDocument> {
  const existing = await readGatewayFile(path, MAX_CONFIG_BYTES) ?? "";
  // Validate the effective result before committing, so malformed known fields
  // never reach ~/.mcpx/config.yaml.
  const current = parseRawDocument(existing);
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const yamlKey = topLevelRawKey(key);
    const next = mergeRawValue(current[yamlKey], value);
    if (next === undefined) {
      delete current[yamlKey];
      changed[yamlKey] = undefined;
    } else {
      current[yamlKey] = next;
      changed[yamlKey] = next;
    }
  }
  normalizeGatewayConfig(current);
  const nextText = Object.keys(changed).length === 0 ? existing : replaceSections(existing, changed);
  await writeGatewayFileAtomic(path, nextText, { mode: 0o600, maximumBytes: MAX_CONFIG_BYTES });
  return parseGatewayConfigDocument(nextText, path);
}

export async function writeGatewayConfig(path: string, config: GatewayConfig | GatewayConfigPatch): Promise<GatewayConfigDocument> {
  const patch = (config as GatewayConfig).version === GATEWAY_STATE_VERSION
    ? config as unknown as GatewayConfigPatch
    : config as GatewayConfigPatch;
  return writeGatewayConfigPatch(path, patch);
}

export async function updateGatewayConfig(patch: GatewayConfigPatch, path = gatewayConfigPath()): Promise<GatewayConfigDocument> {
  return writeGatewayConfigPatch(path, patch);
}
export const saveGatewayConfig = writeGatewayConfig;
