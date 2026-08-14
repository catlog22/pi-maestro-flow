import { z } from "zod";

export type RunResponseSchemaVersion = "run-response/1.0" | "run-response/1.1" | "run-response/1.2";
export type RunResponseExitCode = 0 | 1 | 2 | 3;
export type RunReplayStatus = "applied" | "replayed";

export type RunOperationV10 =
  | "create"
  | "next"
  | "complete"
  | "brief"
  | "recall"
  | "resolve"
  | "resume"
  | "fork"
  | "import"
  | "check"
  | "decide"
  | "seal-session"
  | "chain-insert"
  | "chain-replace"
  | "chain-skip"
  | "meta-update"
  | "accept-reuse"
  | "plan-publish";

export type RunOperationV11 =
  | RunOperationV10
  | "capabilities"
  | "session-create"
  | "session-archive"
  | "session-unarchive"
  | "execution-start"
  | "execution-attach"
  | "execution-status"
  | "execution-pause"
  | "execution-resolve"
  | "execution-resume"
  | "execution-seal"
  | "execution-handoff-prepare"
  | "execution-handoff-accept"
  | "execution-handoff-cancel"
  | "execution-lease-status"
  | "execution-lease-heartbeat"
  | "execution-lease-release"
  | "execution-lease-recover";

export type RunOperationV12 =
  | RunOperationV10
  | "capabilities"
  | "session-open"
  | "session-migrate"
  | "session-complete"
  | "session-archive"
  | "session-status"
  | "session-resume-view"
  | "session-chain-insert"
  | "session-chain-skip"
  | "session-chain-replace"
  | "session-chain-audit"
  | "run-cancel"
  | "run-seal"
  | "run-transition"
  | "run-decide"
  | "execution-start"
  | "execution-attach"
  | "execution-status"
  | "execution-pause"
  | "execution-resolve"
  | "execution-resume"
  | "execution-seal"
  | "execution-handoff-prepare"
  | "execution-handoff-accept"
  | "execution-handoff-cancel"
  | "execution-lease-status"
  | "execution-lease-heartbeat"
  | "execution-lease-release"
  | "execution-lease-recover"
  | "execution-operation-claim"
  | "execution-operation-heartbeat"
  | "execution-operation-release"
  | "execution-operation-status"
  | "participant-register"
  | "participant-status"
  | "participant-unregister"
  | "artifact-inspect"
  | "artifact-republish";

export interface RunResponseNextAction {
  suggest_only: true;
  command: string | null;
  reason: string;
}

export interface RunResponseReplay {
  status: RunReplayStatus;
  transition_id: string;
}

export interface RunResponseLocatorV10 {
  session_id: string | null;
  run_id: string | null;
}

export interface RunResponseLocatorV11 {
  session_id: string | null;
  execution_id: string | null;
  generation: number | null;
  run_id: string | null;
}

export interface RunResponseFenceV11 {
  session_identity_revision: number | null;
  session_activity_revision: number | null;
  execution_revision: number | null;
  lease_epoch: number | null;
}

export interface RunResponseWarningV11 {
  code: string;
  message: string;
  replacement_command: string | null;
}

export interface RunResponseErrorV10 {
  code: RunResponseErrorCodeV10;
  message: string;
  details: Record<string, unknown>;
}

export interface RunResponseErrorV11 {
  code: RunResponseErrorCodeV11;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
  recovery_command: string | null;
}

export type RunResponseRevisionTargetV12 =
  | "session-identity"
  | "orchestration"
  | "run"
  | "artifact"
  | "evidence";

export interface RunResponseLocatorV12 {
  session_id: string | null;
  run_id: string | null;
}

export interface RunResponseRevisionV12 {
  target_type: RunResponseRevisionTargetV12;
  target_id: string;
  revision: number;
}

export interface RunResponseErrorV12 {
  code: RunResponseErrorCodeV12;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
  target_type: RunResponseRevisionTargetV12 | null;
  target_id: string | null;
  expected_revision: number | null;
  current_revision: number | null;
  changed_by: string | null;
  next_actions: string[];
}

export interface RunResponseV10 {
  schema_version: "run-response/1.0";
  operation: RunOperationV10;
  ok: boolean;
  exit_code: RunResponseExitCode;
  request_id: string | null;
  locator: RunResponseLocatorV10 | null;
  result: unknown;
  next: RunResponseNextAction | null;
  continuation: Record<string, unknown> | null;
  replay: RunResponseReplay | null;
  error: RunResponseErrorV10 | null;
}

export type RunResponseDispositionV11 =
  | "success"
  | "domain_error"
  | "control_flow"
  | "usage_error";

export interface RunResponseV11 {
  schema_version: "run-response/1.1";
  operation: RunOperationV11;
  ok: boolean;
  exit_code: RunResponseExitCode;
  disposition: RunResponseDispositionV11;
  request_id: string | null;
  locator: RunResponseLocatorV11 | null;
  fence: RunResponseFenceV11 | null;
  result: unknown;
  next: RunResponseNextAction | null;
  continuation: Record<string, unknown> | null;
  replay: RunResponseReplay | null;
  warnings: RunResponseWarningV11[];
  error: RunResponseErrorV11 | null;
}

export interface RunResponseV12 {
  schema_version: "run-response/1.2";
  operation: RunOperationV12;
  ok: boolean;
  exit_code: RunResponseExitCode;
  disposition: RunResponseDispositionV11;
  request_id: string | null;
  locator: RunResponseLocatorV12 | null;
  revision: RunResponseRevisionV12 | null;
  result: unknown;
  replay: RunResponseReplay | null;
  warnings: RunResponseWarningV11[];
  error: RunResponseErrorV12 | null;
}

/** Private because it may transiently contain result.lease_claim. */
export type PrivateRunResponseEnvelope = RunResponseV10 | RunResponseV11 | RunResponseV12;

/** Safe projection type for logging, status, Cockpit, and transcript paths. */
export type PublicRunResponseEnvelope = PrivateRunResponseEnvelope;

export interface RunLeaseClaim extends Record<string, unknown> {
  lease_id: string;
}

export type RunResponseErrorCodeV10 =
  | "COMMANDER_USAGE"
  | "SESSION_NOT_FOUND"
  | "SESSION_AMBIGUOUS"
  | "SESSION_NOT_RUNNING"
  | "RESUME_REQUIRED"
  | "LEASE_CONFLICT"
  | "RUNNING_STEP"
  | "DECISION_REQUIRED"
  | "CHAIN_COMPLETE"
  | "PICK_NOT_FOUND"
  | "PICK_NOT_PENDING"
  | "PICK_DECISION_NODE"
  | "COMMAND_CONTENT_MISSING"
  | "ARGUMENT_REQUIRED"
  | "RUN_NOT_FOUND"
  | "RUN_GATES_BLOCKING"
  | "RUN_IMMUTABLE"
  | "INVALID_VERDICT"
  | "PLATFORM_INVALID"
  | "PLATFORM_CONFLICT"
  | "CONTRACT_DRIFT"
  | "CHAIN_PROPOSAL_INVALID"
  | "REQUEST_CONFLICT"
  | "REPLAY_STATE_DIVERGED"
  | "TOKEN_INVALID"
  | "TOKEN_EXPIRED"
  | "TOKEN_REPLAYED"
  | "TOKEN_RESERVED"
  | "FENCE_CONFLICT"
  | "RESERVATION_INVALID"
  | "INVALID_TRANSITION_RECEIPT"
  | "SESSION_SEAL_BLOCKED"
  | "INVALID_ARGUMENT"
  | "INTERNAL_ERROR";

export type RunResponseErrorCodeV11 =
  | RunResponseErrorCodeV10
  | "SESSION_ARCHIVED"
  | "SESSION_ARCHIVE_BLOCKED"
  | "EXECUTION_NOT_FOUND"
  | "EXECUTION_ALREADY_ACTIVE"
  | "EXECUTION_PAUSED"
  | "EXECUTION_PAUSE_BLOCKED"
  | "EXECUTION_SEAL_BLOCKED"
  | "EXECUTION_SEALED"
  | "EXECUTION_REVISION_CONFLICT"
  | "LEASE_BUSY"
  | "LEASE_FENCE_CONFLICT"
  | "LEASE_HANDOFF_IN_PROGRESS"
  | "LEASE_HANDOFF_TOKEN_INVALID"
  | "LEASE_STALE_RECOVERY_REQUIRED"
  | "LEASE_RELEASE_BLOCKED"
  | "CAPABILITY_REQUIRED";

export type RunResponseErrorCodeV12 =
  | RunResponseErrorCodeV10
  | "SESSION_SCHEMA_UNSUPPORTED"
  | "SESSION_ARCHIVED"
  | "SESSION_ARCHIVE_BLOCKED"
  | "RUN_REVISION_CONFLICT"
  | "ORCHESTRATION_REVISION_CONFLICT"
  | "STORE_BUSY"
  | "PARTICIPANT_REQUIRED"
  | "INVALID_STATE_TRANSITION";

export class RunResponseParseError extends Error {
  constructor(message: string, readonly schemaVersion?: string) {
    super(message);
    this.name = "RunResponseParseError";
  }
}

export class UnsupportedRunResponseVersionError extends RunResponseParseError {
  constructor(schemaVersion: string) {
    super(`Unsupported Maestro run response schema_version: ${schemaVersion}`, schemaVersion);
    this.name = "UnsupportedRunResponseVersionError";
  }
}

const nonEmptyString = z.string().min(1);
const nullableString = z.string().nullable();
const nullableRevision = z.number().int().nonnegative().nullable();
const detailsSchema = z.record(z.string(), z.unknown());
const nextActionSchema = z.object({
  suggest_only: z.literal(true),
  command: nullableString,
  reason: nonEmptyString,
}).strict();
const replaySchema = z.object({
  status: z.enum(["applied", "replayed"]),
  transition_id: nonEmptyString,
}).strict();
const continuationSchema = z.record(z.string(), z.unknown()).nullable();

const operationV10Schema = z.enum([
  "create", "next", "complete", "brief", "recall", "resolve", "resume", "fork", "import",
  "check", "decide", "seal-session", "chain-insert", "chain-replace", "chain-skip", "meta-update",
  "accept-reuse", "plan-publish",
]);
const operationV11Schema = z.enum([
  ...operationV10Schema.options,
  "capabilities", "session-create", "session-archive", "session-unarchive", "execution-start",
  "execution-attach", "execution-status", "execution-pause", "execution-resolve", "execution-resume",
  "execution-seal", "execution-handoff-prepare", "execution-handoff-accept", "execution-handoff-cancel",
  "execution-lease-status", "execution-lease-heartbeat", "execution-lease-release", "execution-lease-recover",
]);
const operationV12Schema = z.enum([
  ...operationV10Schema.options,
  "capabilities", "session-open", "session-migrate",
  "session-complete", "session-archive", "session-status", "session-resume-view",
  "session-chain-insert", "session-chain-skip", "session-chain-replace", "session-chain-audit",
  "run-cancel", "run-seal", "run-transition", "run-decide", "execution-start", "execution-attach",
  "execution-status", "execution-pause", "execution-resolve", "execution-resume", "execution-seal",
  "execution-handoff-prepare", "execution-handoff-accept", "execution-handoff-cancel",
  "execution-lease-status", "execution-lease-heartbeat", "execution-lease-release", "execution-lease-recover",
  "execution-operation-claim", "execution-operation-heartbeat", "execution-operation-release",
  "execution-operation-status", "participant-register", "participant-status", "participant-unregister",
  "artifact-inspect", "artifact-republish",
]);
const errorCodeV10Schema = z.enum([
  "COMMANDER_USAGE", "SESSION_NOT_FOUND", "SESSION_AMBIGUOUS", "SESSION_NOT_RUNNING", "RESUME_REQUIRED",
  "LEASE_CONFLICT", "RUNNING_STEP", "DECISION_REQUIRED", "CHAIN_COMPLETE", "PICK_NOT_FOUND",
  "PICK_NOT_PENDING", "PICK_DECISION_NODE", "COMMAND_CONTENT_MISSING", "ARGUMENT_REQUIRED", "RUN_NOT_FOUND",
  "RUN_GATES_BLOCKING", "RUN_IMMUTABLE", "INVALID_VERDICT", "PLATFORM_INVALID", "PLATFORM_CONFLICT",
  "CONTRACT_DRIFT", "CHAIN_PROPOSAL_INVALID", "REQUEST_CONFLICT", "REPLAY_STATE_DIVERGED", "TOKEN_INVALID",
  "TOKEN_EXPIRED", "TOKEN_REPLAYED", "TOKEN_RESERVED", "FENCE_CONFLICT", "RESERVATION_INVALID",
  "INVALID_TRANSITION_RECEIPT", "SESSION_SEAL_BLOCKED", "INVALID_ARGUMENT", "INTERNAL_ERROR",
]);
const errorCodeV11Schema = z.enum([
  ...errorCodeV10Schema.options,
  "SESSION_ARCHIVED", "SESSION_ARCHIVE_BLOCKED", "EXECUTION_NOT_FOUND", "EXECUTION_ALREADY_ACTIVE",
  "EXECUTION_PAUSED", "EXECUTION_PAUSE_BLOCKED", "EXECUTION_SEAL_BLOCKED", "EXECUTION_SEALED",
  "EXECUTION_REVISION_CONFLICT", "LEASE_BUSY", "LEASE_FENCE_CONFLICT", "LEASE_HANDOFF_IN_PROGRESS",
  "LEASE_HANDOFF_TOKEN_INVALID", "LEASE_STALE_RECOVERY_REQUIRED", "LEASE_RELEASE_BLOCKED",
  "CAPABILITY_REQUIRED",
]);
const errorCodeV12Schema = z.enum([
  ...errorCodeV10Schema.options,
  "SESSION_SCHEMA_UNSUPPORTED", "SESSION_ARCHIVED", "SESSION_ARCHIVE_BLOCKED",
  "RUN_REVISION_CONFLICT", "ORCHESTRATION_REVISION_CONFLICT", "STORE_BUSY", "PARTICIPANT_REQUIRED",
  "INVALID_STATE_TRANSITION",
]);

const commonV10Shape = {
  schema_version: z.literal("run-response/1.0"),
  operation: operationV10Schema,
  request_id: nonEmptyString.nullable(),
  locator: z.object({ session_id: nullableString, run_id: nullableString }).strict().nullable(),
  next: nextActionSchema.nullable(),
  continuation: continuationSchema,
  replay: replaySchema.nullable(),
};
const successV10Schema = z.object({
  ...commonV10Shape,
  ok: z.literal(true),
  exit_code: z.literal(0),
  result: z.unknown(),
  error: z.null(),
}).strict();
const errorV10Schema = z.object({
  ...commonV10Shape,
  ok: z.literal(false),
  exit_code: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  result: z.null(),
  error: z.object({
    code: errorCodeV10Schema,
    message: nonEmptyString,
    details: detailsSchema,
  }).strict(),
}).strict();
const responseV10Schema = z.union([successV10Schema, errorV10Schema]);

const commonV11Shape = {
  schema_version: z.literal("run-response/1.1"),
  operation: operationV11Schema,
  request_id: nonEmptyString.nullable(),
  locator: z.object({
    session_id: nullableString,
    execution_id: nullableString,
    generation: nullableRevision,
    run_id: nullableString,
  }).strict().nullable(),
  fence: z.object({
    session_identity_revision: nullableRevision,
    session_activity_revision: nullableRevision,
    execution_revision: nullableRevision,
    lease_epoch: nullableRevision,
  }).strict().nullable(),
  next: nextActionSchema.nullable(),
  continuation: continuationSchema,
  replay: replaySchema.nullable(),
  warnings: z.array(z.object({
    code: nonEmptyString,
    message: nonEmptyString,
    replacement_command: nullableString,
  }).strict()),
};
const successV11Schema = z.object({
  ...commonV11Shape,
  ok: z.literal(true),
  exit_code: z.literal(0),
  disposition: z.literal("success"),
  result: z.unknown(),
  error: z.null(),
}).strict();
const errorV11Schema = z.object({
  ...commonV11Shape,
  ok: z.literal(false),
  exit_code: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  disposition: z.enum(["domain_error", "control_flow", "usage_error"]),
  result: z.null(),
  error: z.object({
    code: errorCodeV11Schema,
    message: nonEmptyString,
    retryable: z.boolean(),
    details: detailsSchema,
    recovery_command: nullableString,
  }).strict(),
}).strict();
const responseV11Schema = z.union([successV11Schema, errorV11Schema]);

const revisionTargetV12Schema = z.enum([
  "session-identity", "orchestration", "run", "artifact", "evidence",
]);
const commonV12Shape = {
  schema_version: z.literal("run-response/1.2"),
  operation: operationV12Schema,
  request_id: nonEmptyString.nullable(),
  locator: z.object({
    session_id: nonEmptyString.nullable(),
    run_id: nonEmptyString.nullable(),
  }).strict().nullable(),
  revision: z.object({
    target_type: revisionTargetV12Schema,
    target_id: nonEmptyString,
    revision: z.number().int().nonnegative(),
  }).strict().nullable(),
  replay: replaySchema.nullable(),
  warnings: z.array(z.object({
    code: nonEmptyString,
    message: nonEmptyString,
    replacement_command: nullableString,
  }).strict()),
};
const successV12Schema = z.object({
  ...commonV12Shape,
  ok: z.literal(true),
  exit_code: z.literal(0),
  disposition: z.literal("success"),
  result: z.unknown(),
  error: z.null(),
}).strict();
const errorDetailV12Schema = z.object({
  code: errorCodeV12Schema,
  message: nonEmptyString,
  retryable: z.boolean(),
  details: detailsSchema,
  target_type: revisionTargetV12Schema.nullable(),
  target_id: nonEmptyString.nullable(),
  expected_revision: nullableRevision,
  current_revision: nullableRevision,
  changed_by: nonEmptyString.nullable(),
  next_actions: z.array(nonEmptyString),
}).strict().superRefine((error, ctx) => {
  if (error.code !== "RUN_REVISION_CONFLICT" && error.code !== "ORCHESTRATION_REVISION_CONFLICT") return;
  for (const field of [
    "target_type", "target_id", "expected_revision", "current_revision", "changed_by",
  ] as const) {
    if (error[field] === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required for revision conflicts` });
    }
  }
  if (error.next_actions.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["next_actions"],
      message: "next_actions is required for revision conflicts",
    });
  }
});
const errorV12Schema = z.union([
  z.object({
    ...commonV12Shape,
    ok: z.literal(false),
    exit_code: z.literal(1),
    disposition: z.literal("domain_error"),
    result: z.null(),
    error: errorDetailV12Schema,
  }).strict(),
  z.object({
    ...commonV12Shape,
    ok: z.literal(false),
    exit_code: z.union([z.literal(2), z.literal(3)]),
    disposition: z.literal("control_flow"),
    result: z.null(),
    error: errorDetailV12Schema,
  }).strict(),
  z.object({
    ...commonV12Shape,
    ok: z.literal(false),
    exit_code: z.literal(2),
    disposition: z.literal("usage_error"),
    result: z.null(),
    error: errorDetailV12Schema,
  }).strict(),
]);
const responseV12Schema = z.union([successV12Schema, errorV12Schema]);
const LEASE_CLAIM_OPERATIONS: ReadonlySet<RunOperationV11> = new Set([
  "execution-start",
  "execution-attach",
  "execution-resume",
  "execution-handoff-accept",
  "execution-lease-recover",
]);

export function parseRunResponse(input: string | unknown): PrivateRunResponseEnvelope {
  const value = parseInput(input);
  if (!isRecord(value)) throw new RunResponseParseError("Maestro run response must be a JSON object");
  const version = value.schema_version;
  if (typeof version !== "string") {
    throw new RunResponseParseError("Maestro run response must include a string schema_version");
  }
  if (version !== "run-response/1.0" && version !== "run-response/1.1" && version !== "run-response/1.2") {
    throw new UnsupportedRunResponseVersionError(version);
  }
  requireEnvelopeKeys(value, version);
  const parsed = version === "run-response/1.0"
    ? responseV10Schema.safeParse(value)
    : version === "run-response/1.1"
      ? responseV11Schema.safeParse(value)
      : responseV12Schema.safeParse(value);
  if (!parsed.success) {
    throw new RunResponseParseError(
      `Malformed Maestro ${version} envelope: ${parsed.error.issues.map(issueText).join("; ")}`,
      version,
    );
  }
  validateLeaseClaim(parsed.data, version);
  rejectOperationClaim(parsed.data, version);
  return parsed.data as PrivateRunResponseEnvelope;
}

/** Returns the private acquisition claim only to an explicitly authorized caller. */
export function extractRunResponseLeaseClaim(
  envelope: PrivateRunResponseEnvelope,
): RunLeaseClaim | null {
  if (!mayContainLeaseClaim(envelope)) return null;
  if (!isRecord(envelope.result) || !("lease_claim" in envelope.result)) return null;
  const claim = envelope.result.lease_claim;
  return isRunLeaseClaim(claim) ? claim : null;
}

/** Deep-clones an envelope while removing claims and raw lease IDs at every depth. */
export function projectPublicRunResponse(
  envelope: PrivateRunResponseEnvelope,
): PublicRunResponseEnvelope {
  return redactLeaseSecrets(envelope) as PublicRunResponseEnvelope;
}

function parseInput(input: string | unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RunResponseParseError(`Invalid Maestro run response JSON: ${message}`);
  }
}

function requireEnvelopeKeys(value: Record<string, unknown>, version: RunResponseSchemaVersion): void {
  const required = version === "run-response/1.0"
    ? [
        "schema_version", "operation", "ok", "exit_code", "request_id", "locator", "result", "next",
        "continuation", "replay", "error",
      ]
    : version === "run-response/1.1" ? [
        "schema_version", "operation", "ok", "exit_code", "disposition", "request_id", "locator", "fence",
        "result", "next", "continuation", "replay", "warnings", "error",
      ] : [
        "schema_version", "operation", "ok", "exit_code", "disposition", "request_id", "locator", "revision",
        "result", "replay", "warnings", "error",
      ];
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length > 0) {
    throw new RunResponseParseError(
      `Malformed Maestro ${version} envelope: missing ${missing.join(", ")}`,
      version,
    );
  }
}

function validateLeaseClaim(envelope: Record<string, unknown>, version: RunResponseSchemaVersion): void {
  const result = envelope.result;
  if (!isRecord(result) || !("lease_claim" in result)) return;
  if (
    version !== "run-response/1.1"
    || envelope.ok !== true
    || envelope.disposition !== "success"
    || typeof envelope.operation !== "string"
    || !LEASE_CLAIM_OPERATIONS.has(envelope.operation as RunOperationV11)
  ) {
    throw new RunResponseParseError(
      `Malformed Maestro ${version} envelope: result.lease_claim is not permitted for this response`,
      version,
    );
  }
  if (!isRunLeaseClaim(result.lease_claim)) {
    throw new RunResponseParseError(
      `Malformed Maestro ${version} envelope: result.lease_claim must contain a non-empty lease_id`,
      version,
    );
  }
}

function mayContainLeaseClaim(envelope: PrivateRunResponseEnvelope): envelope is RunResponseV11 {
  return envelope.schema_version === "run-response/1.1"
    && envelope.ok
    && envelope.disposition === "success"
    && LEASE_CLAIM_OPERATIONS.has(envelope.operation);
}

function isRunLeaseClaim(value: unknown): value is RunLeaseClaim {
  return isRecord(value) && typeof value.lease_id === "string" && value.lease_id.length > 0;
}

/**
 * Fail-closed guard: the distributed operation claim experiment was removed,
 * so no response may carry a result.operation_claim credential anymore.
 */
function rejectOperationClaim(envelope: Record<string, unknown>, version: RunResponseSchemaVersion): void {
  const result = envelope.result;
  if (!isRecord(result) || !("operation_claim" in result)) return;
  throw new RunResponseParseError(
    `Malformed Maestro ${version} envelope: result.operation_claim is not permitted`,
    version,
  );
}

function redactLeaseSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLeaseSecrets);
  if (typeof value === "string") return redactSensitiveText(value);
  if (!isRecord(value)) return value;
  const projected: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "lease_claim" || key === "operation_claim" || key === "lease_id" || /token|handoff[_-]?key/i.test(key)) continue;
    projected[key] = redactLeaseSecrets(nested);
  }
  return projected;
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/\b(?:lease_claim|operation_claim)\s*[:=]\s*\{[^\r\n}]*\}/gi, (match) => `${match.split(/\s*[:=]/, 1)[0]}=<redacted>`)
    .replace(/("(?:lease_id|[^"\\]*(?:token|handoff[_-]?key)[^"\\]*)"\s*:\s*)("(?:\\.|[^"\\])*"|[^,\s}\]]+)/gi, "$1\"<redacted>\"")
    .replace(/\b(lease_id|[a-z0-9_-]*(?:token|handoff[_-]?key)[a-z0-9_-]*)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "$1=<redacted>")
    .replace(/(--(?:lease-id|handoff-key|[a-z0-9-]*token[a-z0-9-]*)(?:=|\s+))\S+/gi, "$1<redacted>");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issueText(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "envelope";
  return `${path}: ${issue.message}`;
}
