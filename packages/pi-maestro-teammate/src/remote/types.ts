/** Canonical public data model for the Maestro Remote Worker Protocol. */

export const REMOTE_PROTOCOL_VERSION = "remote/2" as const;
export const REMOTE_CONFIG_VERSION = 4 as const;
export const REMOTE_WINDOW_BRIDGE_PLUGIN_ID = "pi-maestro-teammate" as const;

export type RemoteProtocolVersion = typeof REMOTE_PROTOCOL_VERSION;
export type RemoteConfigVersion = typeof REMOTE_CONFIG_VERSION;

export const REMOTE_STATUSES = [
  "connecting",
  "ready",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "disconnected",
  "lost",
] as const;

export type RemoteStatus = (typeof REMOTE_STATUSES)[number];
export type RemoteTerminalStatus = Extract<RemoteStatus, "completed" | "failed" | "cancelled" | "lost">;

export function isRemoteStatus(value: unknown): value is RemoteStatus {
  return typeof value === "string" && (REMOTE_STATUSES as readonly string[]).includes(value);
}

export function isRemoteTerminalStatus(status: RemoteStatus): status is RemoteTerminalStatus {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "lost";
}

export type RemoteDriverId = "pi-rpc" | "acp";
export type RemoteInputMode = "follow_up" | "steer";
export type RemoteCommandArgv = readonly [string, ...string[]];

export interface RemoteHostConfig {
  host: string;
  user: string;
  port: number;
  hostKeySha256: string;
  /** Local identity-file reference. Omit to use ssh-agent authentication. */
  identityFile?: string;
}

/** A host entry resolved at connection time through the process-local `/ssh` provider. */
export interface RemoteHostReferenceConfig {
  sshHostRef: string;
}

/** Backward-compatible inline host configuration or a provider-owned host reference. */
export type RemoteHostEntry = RemoteHostConfig | RemoteHostReferenceConfig;

export function isRemoteHostReferenceConfig(value: RemoteHostEntry): value is RemoteHostReferenceConfig {
  return "sshHostRef" in value;
}

export interface RemoteAcpFileSystemPolicy {
  read?: boolean;
  write?: boolean;
  maxReadBytes?: number;
  maxWriteBytes?: number;
}

/** A terminal command an ACP agent may start, bound to a canonical executable. */
export interface RemoteAcpTerminalCommand {
  /** Canonical absolute path to the executable on the remote bridge host. */
  executable: string;
  /** Exact argv after the executable. Requests must match this list byte-for-byte. */
  args: readonly string[];
  /** Exact environment variable names this profile permits the ACP agent to set. */
  environment: readonly string[];
}

export interface RemoteAcpTerminalPolicy {
  /** Explicit command profiles accepted from ACP terminal/create. */
  commands: readonly RemoteAcpTerminalCommand[];
  maxOutputBytes?: number;
  timeoutMs?: number;
  maxProcesses?: number;
}

export interface RemoteAcpPolicy {
  /** Permission requests are denied unless allow-once is explicitly configured and tool-scoped. */
  permissionMode?: "deny" | "allow-once";
  /** Tool names that may receive allow-once grants; unknown tools default to deny. */
  permissionTools?: readonly string[];
  fs?: RemoteAcpFileSystemPolicy;
  terminal?: RemoteAcpTerminalPolicy;
}

export interface RemoteTargetConfig {
  host: string;
  cwd: string;
  driver: RemoteDriverId;
  /** Trusted argv; never populated from a task or model request. */
  command: RemoteCommandArgv;
  /**
   * Trusted environment-variable names to forward from the daemon process to
   * the spawned CLI (e.g. CODEX_API_KEY). Explicit opt-in only; launch-policy
   * variables (PATH, LD_PRELOAD, …) are always rejected.
   */
  env?: readonly string[];
  /** Default-deny ACP client operations. Valid only for ACP targets. */
  acp?: RemoteAcpPolicy;
}

/** A trusted remote Pi workspace eligible for explicit window discovery. */
export interface RemoteWorkspaceConfig {
  host: string;
  /** Trusted absolute POSIX cwd; remote window requests never supply their own cwd. */
  cwd: string;
  requiredPlugin: typeof REMOTE_WINDOW_BRIDGE_PLUGIN_ID;
  minimumWindowProtocol: number;
}

export interface ResolvedRemoteTarget extends RemoteTargetConfig {
  id: string;
  hostConfig: RemoteHostEntry;
}

export interface ResolvedRemoteWorkspace extends RemoteWorkspaceConfig {
  workspaceRef: string;
  hostConfig: RemoteHostEntry;
}

export interface RemoteWorkerIdentity {
  workerId: string;
  instanceNonce: string;
}

export interface RemoteRunIdentity extends RemoteWorkerIdentity {
  runId: string;
  generation: number;
}

/** Exact ownership fence captured by the local Monitor. */
export interface RemoteRunCapture extends RemoteRunIdentity {
  monitorOwnerNonce: string;
  targetId: string;
}

export interface RemoteRunSnapshot extends RemoteRunIdentity {
  targetId?: string;
  status: RemoteStatus;
  lastSequence: number;
  updatedAt: number;
  nativeStatus?: string;
  degradedReason?: string;
  summary?: string;
}

export interface RemoteUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface RemoteToolEvent {
  toolCallId: string;
  toolName: string;
  phase: "start" | "end";
  isError?: boolean;
  summary?: string;
}

export type RemoteDriverEvent =
  | { type: "text"; text: string }
  | { type: "tool"; tool: RemoteToolEvent }
  | { type: "usage"; usage: RemoteUsage }
  | { type: "native"; name: string; data?: unknown };

export interface RemoteRunStateEvent extends RemoteRunIdentity {
  type: "run/state";
  sequence: number;
  status: RemoteStatus;
  updatedAt: number;
  nativeStatus?: string;
  degradedReason?: string;
  summary?: string;
}

export interface RemoteRunProgressEvent extends RemoteRunIdentity {
  type: "run/event";
  sequence: number;
  event: RemoteDriverEvent;
  updatedAt: number;
}

export interface RemoteRunResultEvent extends RemoteRunIdentity {
  type: "run/result";
  sequence: number;
  status: Extract<RemoteStatus, "completed" | "failed" | "cancelled" | "lost">;
  updatedAt: number;
  result?: string;
  structuredOutput?: unknown;
  error?: string;
  nativeStatus?: string;
  degradedReason?: string;
}

export type RemoteRunEvent = RemoteRunStateEvent | RemoteRunProgressEvent | RemoteRunResultEvent;

export interface RemoteWorkerHeartbeat extends RemoteWorkerIdentity {
  type: "worker/heartbeat";
  status: Extract<RemoteStatus, "ready" | "running" | "waiting" | "disconnected">;
  activeRuns: number;
  concurrency: number;
  timestamp: number;
}
