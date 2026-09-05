/** Strict read-boundary validation for the canonical Gateway contracts. */
import { Value } from "typebox/value";
import {
  GATEWAY_CAPABILITIES_SCHEMA,
  GATEWAY_ERROR_SCHEMA,
  GATEWAY_HARD_LIMITS,
  GATEWAY_JOB_SCHEMA,
  GATEWAY_OWNER_RECORD_SCHEMA,
  GATEWAY_PRINCIPAL_SCHEMA,
  GATEWAY_RESULT_SCHEMA,
  GATEWAY_STATE_VERSION,
  GATEWAY_TASK_SCHEMA,
  GATEWAY_TOOL_SCHEMA,
  GATEWAY_WORKSPACE_REGISTRY_SCHEMA,
  GATEWAY_WORKSPACE_SCHEMA,
  type GatewayCapabilities,
  type GatewayError,
  type GatewayJob,
  type GatewayOwnerRecord,
  type GatewayPrincipal,
  type GatewayResult,
  type GatewayTask,
  type GatewayTool,
  type GatewayWorkspace,
  type GatewayWorkspaceRegistry,
} from "./contracts.ts";
import { utf8Bytes } from "./state-paths.ts";
import {
  parseCollaborativeSession,
  parseCollaborativeSessionState,
  parseGatewayTodoTask,
  parseSessionEvent,
  parseSessionMember,
  parseSessionOperation,
  type CollaborativeSessionStateV1,
  type CollaborativeSessionV1,
  type GatewayTodoTaskV1,
  type SessionEventV1,
  type SessionMemberV1,
  type SessionOperationV1,
} from "./session-contracts.ts";

export interface GatewayValidationIssue {
  path: string;
  message: string;
}

export class GatewayValidationError extends Error {
  readonly issues: readonly GatewayValidationIssue[];

  constructor(message: string, issues: readonly GatewayValidationIssue[] = []) {
    super(message);
    this.name = "GatewayValidationError";
    this.issues = issues;
  }
}

function issuesFor(schema: unknown, value: unknown): GatewayValidationIssue[] {
  try {
    return [...Value.Errors(schema as never, value)].map((error) => ({
      path: (error as { path?: string }).path || "$",
      message: error.message,
    }));
  } catch {
    return [{ path: "$", message: "value does not match the Gateway schema" }];
  }
}

export function validateGatewayValue<T>(schema: unknown, value: unknown, label: string): T {
  const issues = issuesFor(schema, value);
  if (issues.length > 0) {
    const detail = issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new GatewayValidationError(`Invalid ${label}: ${detail}`, issues);
  }
  return value as T;
}

export function checkGatewayValue(schema: unknown, value: unknown): boolean {
  try { return Value.Check(schema as never, value); } catch { return false; }
}

function requireCanonicalVersion(value: Record<string, unknown>, label: string): void {
  if (value.version !== GATEWAY_STATE_VERSION) {
    throw new GatewayValidationError(`Invalid ${label}: unsupported version ${String(value.version)}`);
  }
}

function assertUtf8Field(value: unknown, field: string, maxBytes: number, label: string): void {
  if (typeof value === "string" && utf8Bytes(value) > maxBytes) {
    throw new GatewayValidationError(`Invalid ${label}: ${field} exceeds ${maxBytes} UTF-8 bytes`);
  }
}

export function parseGatewayTool(value: unknown): GatewayTool {
  const parsed = validateGatewayValue<GatewayTool>(GATEWAY_TOOL_SCHEMA, value, "Gateway tool");
  requireCanonicalVersion(parsed as unknown as Record<string, unknown>, "Gateway tool");
  assertUtf8Field(parsed.name, "name", 128, "Gateway tool");
  assertUtf8Field(parsed.description, "description", 16 * 1024, "Gateway tool");
  if (parsed.mutating === true && parsed.readonly === true) {
    throw new GatewayValidationError("Invalid Gateway tool: mutating and readonly cannot both be true");
  }
  return parsed;
}

export function parseGatewayPrincipal(value: unknown): GatewayPrincipal {
  const parsed = validateGatewayValue<GatewayPrincipal>(GATEWAY_PRINCIPAL_SCHEMA, value, "Gateway principal");
  requireCanonicalVersion(parsed as unknown as Record<string, unknown>, "Gateway principal");
  if (parsed.workspaceId === undefined && parsed.workspacePath !== undefined) {
    // A path-only principal is valid at the wire boundary; policy canonicalizes it.
    assertUtf8Field(parsed.workspacePath, "workspacePath", 4096, "Gateway principal");
  }
  return parsed;
}

export function parseGatewayCapabilities(value: unknown): GatewayCapabilities {
  const parsed = validateGatewayValue<GatewayCapabilities>(GATEWAY_CAPABILITIES_SCHEMA, value, "Gateway capabilities");
  requireCanonicalVersion(parsed as unknown as Record<string, unknown>, "Gateway capabilities");
  return parsed;
}

export function parseGatewayJob(value: unknown): GatewayJob {
  const parsed = validateGatewayValue<GatewayJob>(GATEWAY_JOB_SCHEMA, value, "Gateway job");
  requireCanonicalVersion(parsed as unknown as Record<string, unknown>, "Gateway job");
  assertUtf8Field(parsed.command, "command", GATEWAY_HARD_LIMITS.maxCommandBytes, "Gateway job");
  assertUtf8Field(parsed.stdout, "stdout", GATEWAY_HARD_LIMITS.maxOutputBytes, "Gateway job");
  assertUtf8Field(parsed.stderr, "stderr", GATEWAY_HARD_LIMITS.maxOutputBytes, "Gateway job");
  if (parsed.finishedAt !== undefined && parsed.startedAt !== undefined
    && parsed.finishedAt !== null && parsed.startedAt !== null && parsed.finishedAt < parsed.startedAt) {
    throw new GatewayValidationError("Invalid Gateway job: finishedAt precedes startedAt");
  }
  return parsed;
}

export function parseGatewayTask(value: unknown): GatewayTask {
  const parsed = validateGatewayValue<GatewayTask>(GATEWAY_TASK_SCHEMA, value, "Gateway task");
  requireCanonicalVersion(parsed as unknown as Record<string, unknown>, "Gateway task");
  assertUtf8Field(parsed.objective, "objective", 64 * 1024, "Gateway task");
  return parsed;
}

export function parseGatewayWorkspace(value: unknown): GatewayWorkspace {
  const parsed = validateGatewayValue<GatewayWorkspace>(GATEWAY_WORKSPACE_SCHEMA, value, "Gateway workspace");
  requireCanonicalVersion(parsed as unknown as Record<string, unknown>, "Gateway workspace");
  if (parsed.mode === "lease" && parsed.expiresAt === undefined) {
    throw new GatewayValidationError("Invalid Gateway workspace: lease registrations require expiresAt");
  }
  return parsed;
}

export function parseGatewayWorkspaceRegistry(value: unknown): GatewayWorkspaceRegistry {
  const parsed = validateGatewayValue<GatewayWorkspaceRegistry>(GATEWAY_WORKSPACE_REGISTRY_SCHEMA, value, "Gateway workspace registry");
  requireCanonicalVersion(parsed as unknown as Record<string, unknown>, "Gateway workspace registry");
  const seen = new Set<string>();
  for (const workspace of parsed.workspaces) {
    const normalized = parseGatewayWorkspace(workspace);
    const id = normalized.id;
    if (seen.has(id)) throw new GatewayValidationError(`Invalid Gateway workspace registry: duplicate workspace ${id}`);
    seen.add(id);
  }
  return parsed;
}

export function parseGatewayOwnerRecord(value: unknown): GatewayOwnerRecord {
  const parsed = validateGatewayValue<GatewayOwnerRecord>(GATEWAY_OWNER_RECORD_SCHEMA, value, "Gateway owner record");
  requireCanonicalVersion(parsed as unknown as Record<string, unknown>, "Gateway owner record");
  if (parsed.port === undefined && parsed.socket === undefined) {
    throw new GatewayValidationError("Invalid Gateway owner record: port or socket is required");
  }
  if (parsed.port !== undefined && parsed.socket !== undefined) {
    throw new GatewayValidationError("Invalid Gateway owner record: port and socket are mutually exclusive");
  }
  return parsed;
}

export function parseGatewayError(value: unknown): GatewayError {
  return validateGatewayValue<GatewayError>(GATEWAY_ERROR_SCHEMA, value, "Gateway error");
}

export function parseGatewayResult<T = unknown>(value: unknown): GatewayResult<T> {
  const parsed = validateGatewayValue<GatewayResult<T>>(GATEWAY_RESULT_SCHEMA, value, "Gateway result");
  if (parsed.ok && parsed.error !== undefined) {
    throw new GatewayValidationError("Invalid Gateway result: successful result cannot contain error");
  }
  if (!parsed.ok && parsed.error === undefined) {
    throw new GatewayValidationError("Invalid Gateway result: failed result must contain error");
  }
  if (parsed.ok && ["failed", "cancelled", "lost"].includes(parsed.status)) {
    throw new GatewayValidationError("Invalid Gateway result: successful result cannot use a failure status");
  }
  if (!parsed.ok && !["failed", "cancelled", "lost"].includes(parsed.status)) {
    throw new GatewayValidationError("Invalid Gateway result: failed result must use a failure status");
  }
  return parsed;
}

/* Short aliases make the read-boundary API convenient without weakening it. */
/** Read-boundary migrations for records written before the v1 marker. */
export function normalizeGatewayTool(value: unknown): GatewayTool {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return parseGatewayTool(value);
  const source = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {
    version: GATEWAY_STATE_VERSION,
    name: source.name ?? source.id,
    description: source.description ?? String(source.title ?? source.name ?? "Gateway tool"),
    inputSchema: source.inputSchema ?? source.input_schema ?? { type: "object" },
  };
  for (const key of ["outputSchema", "kind", "executionMode", "mutating", "readonly", "capability", "requiredCapabilities", "timeoutMs"]) {
    if (source[key] !== undefined) normalized[key] = source[key];
  }
  return parseGatewayTool(normalized);
}

export function normalizeGatewayCapabilities(value: unknown): GatewayCapabilities {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return parseGatewayCapabilities(value);
  const source = value as Record<string, unknown>;
  const tools = Array.isArray(source.tools)
    ? source.tools
    : Array.isArray(source.toolNames)
      ? source.toolNames
      : Array.isArray(source.capabilities) ? source.capabilities : [];
  const features = Array.isArray(source.features) ? source.features : [];
  return parseGatewayCapabilities({ version: GATEWAY_STATE_VERSION, tools, features });
}

export function normalizeGatewayJob(value: unknown): GatewayJob {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return parseGatewayJob(value);
  const source = value as Record<string, unknown>;
  const now = Date.now();
  const normalized = { ...source };
  delete normalized.jobId;
  delete normalized.cmd;
  return parseGatewayJob({
    ...normalized,
    version: GATEWAY_STATE_VERSION,
    id: source.id ?? source.jobId,
    status: source.status ?? "queued",
    command: source.command ?? source.cmd,
    cwd: source.cwd ?? process.cwd(),
    principalId: source.principalId ?? "legacy",
    createdAt: source.createdAt ?? now,
    updatedAt: source.updatedAt ?? source.createdAt ?? now,
  });
}

export function normalizeGatewayTask(value: unknown): GatewayTask {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return parseGatewayTask(value);
  const source = value as Record<string, unknown>;
  const now = Date.now();
  const normalized = { ...source };
  delete normalized.taskId;
  delete normalized.prompt;
  return parseGatewayTask({
    ...normalized,
    version: GATEWAY_STATE_VERSION,
    id: source.id ?? source.taskId,
    status: source.status ?? "queued",
    objective: source.objective ?? source.prompt,
    cwd: source.cwd ?? process.cwd(),
    createdAt: source.createdAt ?? now,
    updatedAt: source.updatedAt ?? source.createdAt ?? now,
  });
}

export function normalizeGatewayWorkspace(value: unknown): GatewayWorkspace {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return parseGatewayWorkspace(value);
  const source = value as Record<string, unknown>;
  const now = Date.now();
  const normalized = { ...source };
  for (const key of ["workspacePath", "cwd", "workspaceId", "ttlMs", "ttl_ms", "ttlSeconds", "ttl_seconds", "ttl", "permanent"]) delete normalized[key];
  const path = source.path ?? source.workspacePath ?? source.cwd;
  const permanent = source.permanent === true || source.expiresAt === null;
  const ttl = source.ttlMs ?? source.ttl_ms ?? source.ttlSeconds ?? source.ttl_seconds ?? source.ttl;
  const expiresAt = permanent ? undefined : source.expiresAt ?? (typeof ttl === "number" ? now + ttl * (source.ttlMs !== undefined || source.ttl_ms !== undefined ? 1 : 1000) : now);
  return parseGatewayWorkspace({
    ...normalized,
    version: GATEWAY_STATE_VERSION,
    id: source.id ?? source.workspaceId,
    path,
    canonicalPath: source.canonicalPath ?? path,
    mode: source.mode ?? (permanent ? "permanent" : "lease"),
    generation: source.generation ?? 1,
    registeredAt: source.registeredAt ?? now,
    updatedAt: source.updatedAt ?? source.registeredAt ?? now,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}

export function normalizeGatewayOwnerRecord(value: unknown): GatewayOwnerRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return parseGatewayOwnerRecord(value);
  const source = value as Record<string, unknown>;
  const normalized = { ...source };
  delete normalized.token;
  delete normalized.command;
  delete normalized.processIdentity;
  delete normalized.createdAt;
  return parseGatewayOwnerRecord({
    ...normalized,
    version: GATEWAY_STATE_VERSION,
    ownerToken: source.ownerToken ?? source.token,
    commandIdentity: source.commandIdentity ?? source.command ?? source.processIdentity,
    startedAt: source.startedAt ?? source.createdAt ?? Date.now(),
  });
}

export const validateGatewayTool = parseGatewayTool;
export const validateGatewayPrincipal = parseGatewayPrincipal;
export const validateGatewayCapabilities = parseGatewayCapabilities;
export const validateGatewayJob = parseGatewayJob;
export const validateGatewayTask = parseGatewayTask;
export const validateGatewayWorkspace = parseGatewayWorkspace;
export const validateGatewayOwnerRecord = parseGatewayOwnerRecord;
export const validateGatewayResult = parseGatewayResult;
export const assertGatewayTool = parseGatewayTool;
export const assertGatewayPrincipal = parseGatewayPrincipal;
export const assertGatewayCapabilities = parseGatewayCapabilities;
export const assertGatewayJob = parseGatewayJob;
export const assertGatewayTask = parseGatewayTask;
export const assertGatewayWorkspace = parseGatewayWorkspace;
export const assertGatewayOwnerRecord = parseGatewayOwnerRecord;
export const assertGatewayResult = parseGatewayResult;
export const validateCollaborativeSession = parseCollaborativeSession;
export const validateCollaborativeSessionState = parseCollaborativeSessionState;
export const validateSessionMember = parseSessionMember;
export const validateGatewayTodoTask = parseGatewayTodoTask;
export const validateSessionOperation = parseSessionOperation;
export const validateSessionEvent = parseSessionEvent;
export const assertCollaborativeSession = parseCollaborativeSession;
export const assertSessionMember = parseSessionMember;
export const assertGatewayTodoTask = parseGatewayTodoTask;

export function isCollaborativeSession(value: unknown): value is CollaborativeSessionV1 { try { parseCollaborativeSession(value); return true; } catch { return false; } }
export function isCollaborativeSessionState(value: unknown): value is CollaborativeSessionStateV1 { try { parseCollaborativeSessionState(value); return true; } catch { return false; } }
export function isSessionMember(value: unknown): value is SessionMemberV1 { try { parseSessionMember(value); return true; } catch { return false; } }
export function isGatewayTodoTask(value: unknown): value is GatewayTodoTaskV1 { try { parseGatewayTodoTask(value); return true; } catch { return false; } }
export function isSessionOperation(value: unknown): value is SessionOperationV1 { try { parseSessionOperation(value); return true; } catch { return false; } }
export function isSessionEvent(value: unknown): value is SessionEventV1 { try { parseSessionEvent(value); return true; } catch { return false; } }

export function isGatewayTool(value: unknown): value is GatewayTool { return checkGatewayValue(GATEWAY_TOOL_SCHEMA, value); }
export function isGatewayPrincipal(value: unknown): value is GatewayPrincipal { return checkGatewayValue(GATEWAY_PRINCIPAL_SCHEMA, value); }
export function isGatewayCapabilities(value: unknown): value is GatewayCapabilities { return checkGatewayValue(GATEWAY_CAPABILITIES_SCHEMA, value); }
export function isGatewayJob(value: unknown): value is GatewayJob { return checkGatewayValue(GATEWAY_JOB_SCHEMA, value); }
export function isGatewayTask(value: unknown): value is GatewayTask { return checkGatewayValue(GATEWAY_TASK_SCHEMA, value); }
export function isGatewayWorkspace(value: unknown): value is GatewayWorkspace { return checkGatewayValue(GATEWAY_WORKSPACE_SCHEMA, value); }
export function isGatewayOwnerRecord(value: unknown): value is GatewayOwnerRecord { return checkGatewayValue(GATEWAY_OWNER_RECORD_SCHEMA, value); }
export function isGatewayResult(value: unknown): value is GatewayResult {
  try { parseGatewayResult(value); return true; } catch { return false; }
}
