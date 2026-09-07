/** Canonical, versioned data contracts shared by the built-in Gateway runtime. */
import { Type, type Static } from "typebox";

/** Version written by every Gateway-owned durable record. */
export const GATEWAY_STATE_VERSION = 1 as const;
/** Protocol and durable state currently intentionally share one version. */
export const GATEWAY_PROTOCOL_VERSION = GATEWAY_STATE_VERSION;
export const GATEWAY_VERSION = GATEWAY_STATE_VERSION;
export const GATEWAY_RESULT_TYPE = "gateway-result" as const;

/** Identifiers are deliberately conservative: they are safe in logs and paths. */
export const GATEWAY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const GATEWAY_OWNER_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/;
export const GATEWAY_WORKSPACE_ID_PATTERN = /^[a-f0-9]{64}$/;
export const GATEWAY_COMMAND_IDENTITY_PATTERN = /^.{1,1024}$/s;

/**
 * Hard upper bounds. Configuration may choose a smaller value, never a larger
 * one. Keeping these in one contract prevents the HTTP, stdio and SSH hosts
 * from acquiring subtly different safety limits.
 */
export const GATEWAY_HARD_LIMITS = {
  maxRequestBytes: 4 * 1024 * 1024,
  maxOutputBytes: 4 * 1024 * 1024,
  maxConcurrentRequests: 64,
  maxConcurrentJobs: 32,
  maxConcurrentTasks: 32,
  maxJobs: 256,
  maxTasks: 256,
  maxCommandBytes: 256 * 1024,
  maxFileReadBytes: 16 * 1024 * 1024,
  maxFileWriteBytes: 16 * 1024 * 1024,
  maxPatchFiles: 128,
  maxExecTimeoutMs: 10 * 60 * 1000,
  maxLeaseTtlMs: 7 * 24 * 60 * 60 * 1000,
  maxWorkspaceCount: 256,
  maxBoardTasks: 4096,
  maxBoardOperations: 16384,
  maxBoardEvents: 32768,
} as const;

/** Safe defaults used when an existing ~/.mcpx/config.yaml omits a section. */
export const GATEWAY_COLLABORATION_LIMITS = {
  maxSessions: 256,
  maxMembersPerSession: 1024,
  maxTodosPerSession: 4096,
  maxOperationsPerSession: 8192,
  maxEventsPerSession: 16384,
} as const;

export const GATEWAY_DEFAULT_LIMITS = {
  maxRequestBytes: 1024 * 1024,
  maxOutputBytes: 1024 * 1024,
  maxConcurrentRequests: 16,
  maxConcurrentJobs: 8,
  maxConcurrentTasks: 8,
  maxJobs: 64,
  maxTasks: 64,
  maxCommandBytes: 64 * 1024,
  maxFileReadBytes: 1024 * 1024,
  maxFileWriteBytes: 1024 * 1024,
  maxPatchFiles: 20,
  maxExecTimeoutMs: 5 * 60 * 1000,
  maxLeaseTtlMs: 24 * 60 * 60 * 1000,
  maxWorkspaceCount: 64,
  maxBoardTasks: 1024,
  maxBoardOperations: 4096,
  maxBoardEvents: 8192,
} as const;

/** Public order is part of the protocol. The original eight names remain unchanged. */
export const GATEWAY_TOOL_NAMES = ["workspace", "board", "host", "exec", "job", "file", "teammate", "session", "todo", "monitor"] as const;
/** The pre-Board catalog remains readable at migration boundaries. */
export const GATEWAY_LEGACY_TOOL_NAMES = ["host", "exec", "job", "file", "teammate", "session", "todo", "monitor"] as const;
export type GatewayToolName = typeof GATEWAY_TOOL_NAMES[number];
/** Compatibility alias: every v1 tool kind is also its public tool name. */
export const GATEWAY_TOOL_KINDS = GATEWAY_TOOL_NAMES;
export type GatewayToolKind = GatewayToolName;
export const GATEWAY_TOOL_EXECUTION_MODES = ["sync", "async"] as const;
export type GatewayToolExecutionMode = typeof GATEWAY_TOOL_EXECUTION_MODES[number];

export const GATEWAY_TOOL_ANNOTATIONS_SCHEMA = Type.Object({
  readOnlyHint: Type.Optional(Type.Boolean()),
  destructiveHint: Type.Optional(Type.Boolean()),
  idempotentHint: Type.Optional(Type.Boolean()),
  openWorldHint: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type GatewayToolAnnotations = Static<typeof GATEWAY_TOOL_ANNOTATIONS_SCHEMA>;

export const GATEWAY_TOOL_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION),
  name: Type.String({ minLength: 1, maxLength: 128, pattern: GATEWAY_ID_PATTERN.source }),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  description: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
  inputSchema: Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.Unknown()),
  outputSchema: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.Unknown())),
  annotations: Type.Optional(GATEWAY_TOOL_ANNOTATIONS_SCHEMA),
  kind: Type.Optional(Type.Unsafe<GatewayToolKind>({ type: "string", enum: [...GATEWAY_TOOL_KINDS] })),
  executionMode: Type.Optional(Type.Unsafe<GatewayToolExecutionMode>({ type: "string", enum: [...GATEWAY_TOOL_EXECUTION_MODES] })),
  mutating: Type.Optional(Type.Boolean()),
  readonly: Type.Optional(Type.Boolean()),
  capability: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: GATEWAY_ID_PATTERN.source })),
  requiredCapabilities: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32, uniqueItems: true })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: GATEWAY_HARD_LIMITS.maxExecTimeoutMs })),
}, { additionalProperties: false });
export type GatewayTool = Static<typeof GATEWAY_TOOL_SCHEMA>;

export const GATEWAY_PRINCIPAL_TRANSPORTS = ["stdio", "http"] as const;
export type GatewayPrincipalTransport = typeof GATEWAY_PRINCIPAL_TRANSPORTS[number];

export const GATEWAY_PRINCIPAL_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION),
  id: Type.String({ minLength: 1, maxLength: 256 }),
  transport: Type.Unsafe<GatewayPrincipalTransport>({ type: "string", enum: [...GATEWAY_PRINCIPAL_TRANSPORTS] }),
  scopes: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64, uniqueItems: true }),
  workspaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  workspacePath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  authenticated: Type.Optional(Type.Boolean()),
  source: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
}, { additionalProperties: false });
export type GatewayPrincipal = Static<typeof GATEWAY_PRINCIPAL_SCHEMA>;
export const GATEWAY_CAPABILITIES_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION),
  tools: Type.Array(Type.String({ minLength: 1, maxLength: 128, pattern: GATEWAY_ID_PATTERN.source }), { maxItems: 256, uniqueItems: true }),
  features: Type.Array(Type.String({ minLength: 1, maxLength: 128, pattern: GATEWAY_ID_PATTERN.source }), { maxItems: 256, uniqueItems: true }),
}, { additionalProperties: false });
export type GatewayCapabilities = Static<typeof GATEWAY_CAPABILITIES_SCHEMA>;

export const GATEWAY_JOB_STATES = ["queued", "running", "completed", "failed", "cancelled", "lost"] as const;
export type GatewayJobState = typeof GATEWAY_JOB_STATES[number];
export const GATEWAY_TASK_STATES = ["queued", "running", "completed", "failed", "cancelled", "lost"] as const;
export type GatewayTaskState = typeof GATEWAY_TASK_STATES[number];

const timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullableTimestamp = Type.Union([timestamp, Type.Null()]);
const nullableString = Type.Union([Type.String({ minLength: 1, maxLength: 64 * 1024 }), Type.Null()]);
const stateString = (values: readonly string[]) => Type.Unsafe<string>({ type: "string", enum: [...values] });

export const GATEWAY_JOB_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION),
  id: Type.String({ minLength: 1, maxLength: 128, pattern: GATEWAY_ID_PATTERN.source }),
  status: stateString(GATEWAY_JOB_STATES),
  command: Type.String({ minLength: 1, maxLength: GATEWAY_HARD_LIMITS.maxCommandBytes }),
  cwd: Type.String({ minLength: 1, maxLength: 4096 }),
  principalId: Type.String({ minLength: 1, maxLength: 256 }),
  createdAt: timestamp,
  updatedAt: timestamp,
  startedAt: Type.Optional(nullableTimestamp),
  finishedAt: Type.Optional(nullableTimestamp),
  exitCode: Type.Optional(Type.Union([Type.Integer({ minimum: -255, maximum: 255 }), Type.Null()])),
  signal: Type.Optional(nullableString),
  stdout: Type.Optional(Type.String({ maxLength: GATEWAY_HARD_LIMITS.maxOutputBytes })),
  stderr: Type.Optional(Type.String({ maxLength: GATEWAY_HARD_LIMITS.maxOutputBytes })),
  error: Type.Optional(Type.String({ minLength: 1, maxLength: 16 * 1024 })),
  ownerToken: Type.Optional(Type.String({ minLength: 16, maxLength: 256, pattern: GATEWAY_OWNER_TOKEN_PATTERN.source })),
}, { additionalProperties: false });
export type GatewayJob = Static<typeof GATEWAY_JOB_SCHEMA>;

export const GATEWAY_TASK_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION),
  id: Type.String({ minLength: 1, maxLength: 128, pattern: GATEWAY_ID_PATTERN.source }),
  status: stateString(GATEWAY_TASK_STATES),
  objective: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
  cwd: Type.String({ minLength: 1, maxLength: 4096 }),
  createdAt: timestamp,
  updatedAt: timestamp,
  startedAt: Type.Optional(nullableTimestamp),
  finishedAt: Type.Optional(nullableTimestamp),
  result: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.String({ minLength: 1, maxLength: 16 * 1024 })),
  ownerToken: Type.Optional(Type.String({ minLength: 16, maxLength: 256, pattern: GATEWAY_OWNER_TOKEN_PATTERN.source })),
  principalId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
}, { additionalProperties: false });
export type GatewayTask = Static<typeof GATEWAY_TASK_SCHEMA>;

export const GATEWAY_WORKSPACE_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION),
  id: Type.String({ minLength: 1, maxLength: 256, pattern: GATEWAY_ID_PATTERN.source }),
  path: Type.String({ minLength: 1, maxLength: 4096 }),
  canonicalPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  mode: Type.Unsafe<"lease" | "permanent">({ type: "string", enum: ["lease", "permanent"] }),
  generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  registeredAt: timestamp,
  updatedAt: timestamp,
  expiresAt: Type.Optional(timestamp),
  ownerToken: Type.Optional(Type.String({ minLength: 16, maxLength: 256, pattern: GATEWAY_OWNER_TOKEN_PATTERN.source })),
}, { additionalProperties: false });
export type GatewayWorkspace = Static<typeof GATEWAY_WORKSPACE_SCHEMA>;

export const GATEWAY_OWNER_RECORD_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION),
  pid: Type.Integer({ minimum: 1, maximum: 0x7fffffff }),
  ownerToken: Type.String({ minLength: 16, maxLength: 256, pattern: GATEWAY_OWNER_TOKEN_PATTERN.source }),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  socket: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  commandIdentity: Type.String({ minLength: 1, maxLength: 1024 }),
  startedAt: timestamp,
}, { additionalProperties: false });
export type GatewayOwnerRecord = Static<typeof GATEWAY_OWNER_RECORD_SCHEMA>;

export const GATEWAY_RESULT_STATUSES = ["accepted", "running", "succeeded", "failed", "cancelled", "lost"] as const;
export type GatewayResultStatus = typeof GATEWAY_RESULT_STATUSES[number];

export const GATEWAY_ERROR_SCHEMA = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 128, pattern: GATEWAY_ID_PATTERN.source }),
  message: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
  retryable: Type.Boolean(),
}, { additionalProperties: false });
export type GatewayError = Static<typeof GATEWAY_ERROR_SCHEMA>;

export const GATEWAY_RESULT_META_SCHEMA = Type.Object({
  requestId: Type.String({ minLength: 1, maxLength: 256 }),
  principalId: Type.String({ minLength: 1, maxLength: 256 }),
  startedAt: Type.String({ format: "date-time" }),
  durationMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
}, { additionalProperties: false });
export type GatewayResultMeta = Static<typeof GATEWAY_RESULT_META_SCHEMA>;

export const GATEWAY_RESULT_SCHEMA = Type.Object({
  ok: Type.Boolean(),
  status: Type.Unsafe<GatewayResultStatus>({ type: "string", enum: [...GATEWAY_RESULT_STATUSES] }),
  data: Type.Optional(Type.Unknown()),
  error: Type.Optional(GATEWAY_ERROR_SCHEMA),
  meta: GATEWAY_RESULT_META_SCHEMA,
}, { additionalProperties: false });
export type GatewayResult<T = unknown> = Omit<Static<typeof GATEWAY_RESULT_SCHEMA>, "data"> & { data?: T };

/** Canonical durable registry envelope. */
export const GATEWAY_WORKSPACE_REGISTRY_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION),
  workspaces: Type.Array(GATEWAY_WORKSPACE_SCHEMA, { maxItems: GATEWAY_HARD_LIMITS.maxWorkspaceCount }),
}, { additionalProperties: false });
export type GatewayWorkspaceRegistry = Static<typeof GATEWAY_WORKSPACE_REGISTRY_SCHEMA>;

/** Convenience aliases retained for callers that use shorter schema names. */
export const GatewayToolSchema = GATEWAY_TOOL_SCHEMA;
export const GatewayPrincipalSchema = GATEWAY_PRINCIPAL_SCHEMA;
export const GatewayCapabilitiesSchema = GATEWAY_CAPABILITIES_SCHEMA;
export const GatewayJobSchema = GATEWAY_JOB_SCHEMA;
export const GatewayTaskSchema = GATEWAY_TASK_SCHEMA;
export const GatewayWorkspaceSchema = GATEWAY_WORKSPACE_SCHEMA;
export const GatewayOwnerRecordSchema = GATEWAY_OWNER_RECORD_SCHEMA;
export const GatewayResultSchema = GATEWAY_RESULT_SCHEMA;
export const ToolSchema = GATEWAY_TOOL_SCHEMA;
export const PrincipalSchema = GATEWAY_PRINCIPAL_SCHEMA;
export const CapabilitiesSchema = GATEWAY_CAPABILITIES_SCHEMA;
export const JobSchema = GATEWAY_JOB_SCHEMA;
export const TaskSchema = GATEWAY_TASK_SCHEMA;
export const WorkspaceSchema = GATEWAY_WORKSPACE_SCHEMA;
export const OwnerRecordSchema = GATEWAY_OWNER_RECORD_SCHEMA;
