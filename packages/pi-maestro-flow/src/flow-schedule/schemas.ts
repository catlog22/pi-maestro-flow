import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { validateWorkspaceCompletionCorrelation } from "pi-maestro-teammate/v1/workspace-completion";
import {
  FLOW_SCHEDULE_BINDING_STATES,
  FLOW_SCHEDULE_COMPLETION_STATES,
  FLOW_SCHEDULE_DISPATCH_ID_PATTERN,
  FLOW_SCHEDULE_DISPATCH_STATES,
  FLOW_SCHEDULE_DISPATCH_TYPE,
  FLOW_SCHEDULE_ID_PATTERN,
  FLOW_SCHEDULE_LIMITS,
  FLOW_SCHEDULE_RESULT_OUTCOMES,
  FLOW_SCHEDULE_RESULT_TYPE,
  FLOW_SCHEDULE_STATES,
  FLOW_SCHEDULE_STEP_STATES,
  FLOW_SCHEDULE_STORE_TYPE,
  FLOW_SCHEDULE_TARGET_PATTERN,
  FLOW_SCHEDULE_VERSION,
  type ExactWindowIdentity,
  type FlowScheduleAcceptedRecord,
  type FlowScheduleAction,
  type FlowScheduleCompletionRecord,
  type FlowScheduleCreateInput,
  type FlowScheduleCreateStepInput,
  type FlowScheduleDispatch,
  type FlowScheduleDispatchEnvelope,
  type FlowScheduleLockOwner,
  type FlowScheduleOwnerMarker,
  type FlowSchedulePublishedRecord,
  type FlowScheduleRecord,
  type FlowScheduleResult,
  type FlowScheduleTodoBinding,
  type FlowScheduleTodoBindingSpec,
  type FlowScheduleTodoOutcome,
  type FlowScheduleTodoStatus,
} from "./types.ts";

const strict = { additionalProperties: false } as const;
const timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const boundedText = (maximum: number) => Type.String({ minLength: 1, maxLength: maximum });
const id = Type.String({ pattern: FLOW_SCHEDULE_ID_PATTERN.source, maxLength: 64 });
const dispatchId = Type.String({ pattern: FLOW_SCHEDULE_DISPATCH_ID_PATTERN.source, maxLength: 36 });
const targetSelector = Type.String({ pattern: FLOW_SCHEDULE_TARGET_PATTERN.source, maxLength: 38 });
const reason = boundedText(FLOW_SCHEDULE_LIMITS.maxSummaryBytes);
const prompt = boundedText(FLOW_SCHEDULE_LIMITS.maxPromptBytes);
const summary = boundedText(FLOW_SCHEDULE_LIMITS.maxSummaryBytes);
const resource = boundedText(FLOW_SCHEDULE_LIMITS.maxResourceBytes);
const nonEmptyIdentity = boundedText(256);
const ownerIdentity = Type.String({ pattern: "^[a-f0-9]{32}$", minLength: 32, maxLength: 32 });
const completionPublicationId = Type.String({ pattern: "^[a-f0-9]{64}$", minLength: 64, maxLength: 64 });
const completionResource = Type.Unsafe<`agent://${string}`>({
  type: "string",
  pattern: "^agent://[a-f0-9]{64}$",
  minLength: 72,
  maxLength: 72,
});

export const WorkspaceCompletionCorrelationSchema = Type.Object({
  messageId: ownerIdentity,
  requestMessageId: ownerIdentity,
  correlationId: ownerIdentity,
  dispatchId: ownerIdentity,
  deliveryGroupId: ownerIdentity,
  reservationId: completionPublicationId,
  publicationId: completionPublicationId,
  resource: completionResource,
  owner: Type.Object({
    workspaceId: Type.String({ pattern: "^[a-f0-9]{64}$", minLength: 64, maxLength: 64 }),
    ownerId: ownerIdentity,
    ownerNonce: ownerIdentity,
  }, strict),
}, strict);

function stringEnum<const T extends readonly string[]>(values: T) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values] });
}

export const FlowScheduleIdSchema = id;
export const FlowScheduleDispatchIdSchema = dispatchId;
export const FlowScheduleTargetSelectorSchema = targetSelector;

export const ExactWindowIdentitySchema = Type.Object({
  workspaceId: nonEmptyIdentity,
  endpointId: nonEmptyIdentity,
  ownerId: ownerIdentity,
  ownerNonce: ownerIdentity,
  sessionId: Type.Optional(nonEmptyIdentity),
}, strict);

export const FlowScheduleTodoBindingSpecSchema = Type.Object({
  label: Type.Optional(boundedText(256)),
  requireCompleted: Type.Optional(Type.Boolean()),
  conflictCheck: Type.Optional(Type.Boolean()),
}, strict);

export const FlowScheduleTodoOutcomeSchema = Type.Object({
  todoId: id,
  todoStatus: stringEnum(["pending", "in_progress", "completed", "blocked", "failed"] as const),
}, strict);

export const FlowScheduleCreateStepInputSchema = Type.Object({
  stepId: id,
  prompt,
  todoBinding: Type.Optional(FlowScheduleTodoBindingSpecSchema),
}, strict);

const createSteps = Type.Array(FlowScheduleCreateStepInputSchema, {
  minItems: 1,
  maxItems: FLOW_SCHEDULE_LIMITS.maxStepsPerSchedule,
});

export const FlowScheduleCreateActionSchema = Type.Object({
  action: Type.Literal("create"),
  scheduleId: id,
  target: targetSelector,
  steps: createSteps,
}, strict);

export const FlowScheduleStartActionSchema = Type.Object({
  action: Type.Literal("start"),
  scheduleId: id,
}, strict);

export const FlowScheduleListActionSchema = Type.Object({
  action: Type.Literal("list"),
}, strict);

export const FlowScheduleStatusActionSchema = Type.Object({
  action: Type.Literal("status"),
  scheduleId: id,
}, strict);

export const FlowScheduleAppendActionSchema = Type.Object({
  action: Type.Literal("append"),
  scheduleId: id,
  afterStepId: id,
  steps: createSteps,
}, strict);

export const FlowSchedulePauseActionSchema = Type.Object({
  action: Type.Literal("pause"),
  scheduleId: id,
}, strict);

export const FlowScheduleResumeActionSchema = Type.Object({
  action: Type.Literal("resume"),
  scheduleId: id,
  target: Type.Optional(targetSelector),
}, strict);

export const FlowScheduleRetryActionSchema = Type.Object({
  action: Type.Literal("retry"),
  scheduleId: id,
  stepId: id,
  reason,
}, strict);

export const FlowScheduleCancelActionSchema = Type.Object({
  action: Type.Literal("cancel"),
  scheduleId: id,
  reason,
}, strict);

export const FlowScheduleReportActionSchema = Type.Object({
  action: Type.Literal("report"),
  dispatchId,
  outcome: stringEnum(FLOW_SCHEDULE_RESULT_OUTCOMES),
  summary,
  resources: Type.Optional(Type.Array(resource, { maxItems: FLOW_SCHEDULE_LIMITS.maxResources })),
  todoOutcome: Type.Optional(FlowScheduleTodoOutcomeSchema),
}, strict);

export const FlowScheduleActionSchema = Type.Union([
  FlowScheduleCreateActionSchema,
  FlowScheduleStartActionSchema,
  FlowScheduleListActionSchema,
  FlowScheduleStatusActionSchema,
  FlowScheduleAppendActionSchema,
  FlowSchedulePauseActionSchema,
  FlowScheduleResumeActionSchema,
  FlowScheduleRetryActionSchema,
  FlowScheduleCancelActionSchema,
  FlowScheduleReportActionSchema,
]);

export const FlowScheduleResultSchema = Type.Object({
  version: Type.Literal(FLOW_SCHEDULE_VERSION),
  type: Type.Literal(FLOW_SCHEDULE_RESULT_TYPE),
  scheduleId: id,
  stepId: id,
  dispatchId,
  outcome: stringEnum(FLOW_SCHEDULE_RESULT_OUTCOMES),
  summary,
  resources: Type.Array(resource, { maxItems: FLOW_SCHEDULE_LIMITS.maxResources + 1 }),
  completionCorrelation: Type.Optional(WorkspaceCompletionCorrelationSchema),
  todoOutcome: Type.Optional(FlowScheduleTodoOutcomeSchema),
}, strict);

export const FlowScheduleDispatchEnvelopeSchema = Type.Object({
  version: Type.Literal(FLOW_SCHEDULE_VERSION),
  type: Type.Literal(FLOW_SCHEDULE_DISPATCH_TYPE),
  scheduleId: id,
  stepId: id,
  dispatchId,
  instruction: prompt,
  report: Type.Object({
    tool: Type.Literal("flow-schedule"),
    action: Type.Literal("report"),
  }, strict),
  todoBinding: Type.Optional(FlowScheduleTodoBindingSpecSchema),
}, strict);

export const FlowScheduleStepSchema = Type.Object({
  stepId: id,
  prompt,
  state: stringEnum(FLOW_SCHEDULE_STEP_STATES),
  attempts: Type.Array(dispatchId, { maxItems: FLOW_SCHEDULE_LIMITS.maxAttemptsPerStep }),
  currentDispatchId: Type.Optional(dispatchId),
  result: Type.Optional(FlowScheduleResultSchema),
  todoBinding: Type.Optional(FlowScheduleTodoBindingSpecSchema),
}, strict);

export const FlowScheduleRecordSchema = Type.Object({
  version: Type.Literal(FLOW_SCHEDULE_VERSION),
 scheduleId: id,
  targetSelector,
  targetIdentity: Type.Optional(ExactWindowIdentitySchema),
  state: stringEnum(FLOW_SCHEDULE_STATES),
  stepIds: Type.Array(id, { minItems: 1, maxItems: FLOW_SCHEDULE_LIMITS.maxStepsPerSchedule }),
  steps: Type.Record(id, FlowScheduleStepSchema),
  activeStepId: Type.Optional(id),
  reason: Type.Optional(reason),
  lastAdmitReason: Type.Optional(reason),
  lastAdmitAt: Type.Optional(timestamp),
  admitAttempts: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  createdAt: timestamp,
  updatedAt: timestamp,
}, strict);

export const FlowScheduleDispatchSchema = Type.Object({
  version: Type.Literal(FLOW_SCHEDULE_VERSION),
  dispatchId,
  scheduleId: id,
  stepId: id,
  targetIdentity: ExactWindowIdentitySchema,
  completionCorrelation: Type.Optional(WorkspaceCompletionCorrelationSchema),
  state: stringEnum(FLOW_SCHEDULE_DISPATCH_STATES),
  createdAt: timestamp,
  publishedAt: Type.Optional(timestamp),
  acceptedAt: Type.Optional(timestamp),
  settledAt: Type.Optional(timestamp),
}, strict);

export const FlowScheduleOwnerMarkerSchema = Type.Object({
  version: Type.Literal(FLOW_SCHEDULE_VERSION),
  type: Type.Literal(FLOW_SCHEDULE_STORE_TYPE),
  storeId: dispatchId,
  projectRoot: boundedText(4096),
  storageRoot: boundedText(4096),
  createdAt: timestamp,
}, strict);

export const FlowScheduleLockOwnerSchema = Type.Object({
  version: Type.Literal(FLOW_SCHEDULE_VERSION),
  type: Type.Literal("flow-schedule-lock"),
  token: dispatchId,
  pid: Type.Integer({ minimum: 0, maximum: 0x7fffffff }),
  processIdentity: Type.Optional(boundedText(1024)),
  createdAt: timestamp,
  heartbeatAt: timestamp,
}, strict);

export const FlowSchedulePublishedRecordSchema = Type.Object({
  version: Type.Literal(FLOW_SCHEDULE_VERSION),
  type: Type.Literal("flow-schedule-published"),
  dispatchId,
  scheduleId: id,
  stepId: id,
  messageId: Type.Union([dispatchId, ownerIdentity]),
  traceId: dispatchId,
  publishedAt: timestamp,
}, strict);

export const FlowScheduleAcceptedRecordSchema = Type.Object({
  version: Type.Literal(FLOW_SCHEDULE_VERSION),
  type: Type.Literal("flow-schedule-accepted"),
  dispatchId,
  scheduleId: id,
  stepId: id,
  messageId: Type.Union([dispatchId, ownerIdentity]),
  acceptedAt: timestamp,
  deliveryState: stringEnum(["accepted", "injected", "replayed"] as const),
}, strict);

export const FlowScheduleCompletionRecordSchema = Type.Object({
  version: Type.Literal(FLOW_SCHEDULE_VERSION),
  type: Type.Literal("flow-schedule-completion"),
  dispatchId,
  scheduleId: id,
  stepId: id,
  targetIdentity: ExactWindowIdentitySchema,
  state: stringEnum(FLOW_SCHEDULE_COMPLETION_STATES),
  result: Type.Optional(FlowScheduleResultSchema),
  reason: Type.Optional(reason),
  completedAt: timestamp,
}, strict);

export const FlowScheduleTodoBindingSchema = Type.Object({
  version: Type.Literal(FLOW_SCHEDULE_VERSION),
  type: Type.Literal("flow-schedule-binding"),
  dispatchId,
  scheduleId: id,
  stepId: id,
  todoId: Type.Optional(id),
  state: stringEnum(FLOW_SCHEDULE_BINDING_STATES),
  todoStatus: Type.Optional(stringEnum(["pending", "in_progress", "completed", "blocked", "failed"] as const)),
  reason: Type.Optional(reason),
  createdAt: timestamp,
  updatedAt: timestamp,
}, strict);

export type FlowScheduleActionValue = Static<typeof FlowScheduleActionSchema>;

export class FlowScheduleValidationError extends Error {
  constructor(readonly context: string, readonly path: string, detail: string) {
    super(`${context} is invalid at ${path || "/"}: ${detail}`);
    this.name = "FlowScheduleValidationError";
  }
}

function assertSchema<T extends TSchema>(schema: T, value: unknown, context: string): asserts value is Static<T> {
  if (Value.Check(schema, value)) return;
  const first = [...Value.Errors(schema, value)][0];
  const extra = first?.params && Array.isArray((first.params as { additionalProperties?: unknown }).additionalProperties)
    ? (first.params as { additionalProperties: unknown[] }).additionalProperties.map((name) => JSON.stringify(String(name))).join(", ")
    : undefined;
  // Naming the unexpected keys turns version-skew (a file written by a newer
  // build read by a stale long-running window) into an immediately obvious
  // diagnosis instead of an opaque strict-schema failure.
  throw new FlowScheduleValidationError(context, first?.instancePath ?? "", `${first?.message ?? "schema mismatch"}${extra ? ` (${extra})` : ""}`);
}

function normalizedText(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertTextBytes(value: string, maximum: number, context: string): void {
  if (!value.trim()) throw new FlowScheduleValidationError(context, "", "must contain non-whitespace text");
  const bytes = byteLength(value);
  if (bytes > maximum) {
    throw new FlowScheduleValidationError(context, "", `exceeds the ${maximum} byte limit (${bytes} bytes)`);
  }
}

function normalizeStepInputs(steps: readonly FlowScheduleCreateStepInput[], context: string): FlowScheduleCreateStepInput[] {
  const normalized = steps.map((step) => ({
    stepId: step.stepId,
    prompt: normalizedText(step.prompt),
    ...(step.todoBinding ? { todoBinding: step.todoBinding } : {}),
  }));
  const seen = new Set<string>();
  for (const [index, step] of normalized.entries()) {
    if (seen.has(step.stepId)) {
      throw new FlowScheduleValidationError(context, `/steps/${index}/stepId`, `duplicate stepId ${JSON.stringify(step.stepId)}`);
    }
    seen.add(step.stepId);
    assertTextBytes(step.prompt, FLOW_SCHEDULE_LIMITS.maxPromptBytes, `${context} step ${step.stepId}`);
  }
  return normalized;
}

export function parseFlowScheduleAction(value: unknown): FlowScheduleAction {
  assertSchema(FlowScheduleActionSchema, value, "Flow schedule action");
  let normalized: FlowScheduleAction;
  switch (value.action) {
    case "create":
      normalized = {
        action: "create",
        scheduleId: value.scheduleId,
        target: value.target.trim(),
        steps: normalizeStepInputs(value.steps, "Flow schedule create action"),
      };
      break;
    case "append":
      normalized = {
        action: "append",
        scheduleId: value.scheduleId,
        afterStepId: value.afterStepId,
        steps: normalizeStepInputs(value.steps, "Flow schedule append action"),
      };
      break;
    case "resume":
      normalized = {
        action: "resume",
        scheduleId: value.scheduleId,
        ...(value.target === undefined ? {} : { target: value.target.trim() }),
      };
      break;
    case "retry":
    case "cancel":
      normalized = { ...value, reason: normalizedText(value.reason).trim() };
      assertTextBytes(normalized.reason, FLOW_SCHEDULE_LIMITS.maxSummaryBytes, `Flow schedule ${value.action} reason`);
      break;
    case "report": {
      const normalizedSummary = normalizedText(value.summary).trim();
      const resources = value.resources?.map((entry) => entry.trim());
      assertTextBytes(normalizedSummary, FLOW_SCHEDULE_LIMITS.maxSummaryBytes, "Flow schedule report summary");
      for (const entry of resources ?? []) {
        assertTextBytes(entry, FLOW_SCHEDULE_LIMITS.maxResourceBytes, "Flow schedule report resource");
      }
      normalized = { ...value, summary: normalizedSummary, ...(resources === undefined ? {} : { resources }) };
      break;
    }
    default:
      normalized = { ...value };
  }
  assertSchema(FlowScheduleActionSchema, normalized, "Normalized Flow schedule action");
  return normalized;
}

export function normalizeFlowSchedule(input: FlowScheduleCreateInput, now: number): FlowScheduleRecord {
  const action = parseFlowScheduleAction({ action: "create", ...input });
  if (action.action !== "create") throw new Error("Flow schedule create normalization failed");
  const steps: FlowScheduleRecord["steps"] = {};
  for (const step of action.steps) {
    steps[step.stepId] = {
      stepId: step.stepId,
      prompt: step.prompt,
      state: "pending",
      attempts: [],
      ...(step.todoBinding ? { todoBinding: step.todoBinding } : {}),
    };
  }
  return parseFlowScheduleRecord({
    version: FLOW_SCHEDULE_VERSION,
    scheduleId: action.scheduleId,
    targetSelector: action.target,
    state: "draft",
    stepIds: action.steps.map((step) => step.stepId),
    steps,
    createdAt: now,
    updatedAt: now,
  });
}

export function parseExactWindowIdentity(value: unknown): ExactWindowIdentity {
  assertSchema(ExactWindowIdentitySchema, value, "Exact window identity");
  return value;
}

export function parseFlowScheduleRecord(value: unknown): FlowScheduleRecord {
  assertSchema(FlowScheduleRecordSchema, value, "Flow schedule record");
  const ids = value.stepIds;
  if (new Set(ids).size !== ids.length) {
    throw new FlowScheduleValidationError("Flow schedule record", "/stepIds", "step IDs must be unique");
  }
  const keys = Object.keys(value.steps);
  if (keys.length !== ids.length || keys.some((key) => !ids.includes(key))) {
    throw new FlowScheduleValidationError("Flow schedule record", "/steps", "stepIds and step keys must match exactly");
  }
  let activeCount = 0;
  for (const stepId of ids) {
    const step = value.steps[stepId];
    if (step.stepId !== stepId) {
      throw new FlowScheduleValidationError("Flow schedule record", `/steps/${stepId}/stepId`, "must match its record key");
    }
    assertTextBytes(step.prompt, FLOW_SCHEDULE_LIMITS.maxPromptBytes, `Persisted Flow schedule step ${stepId}`);
    if (new Set(step.attempts).size !== step.attempts.length) {
      throw new FlowScheduleValidationError("Flow schedule record", `/steps/${stepId}/attempts`, "dispatch IDs must be unique");
    }
    if (step.currentDispatchId !== undefined && !step.attempts.includes(step.currentDispatchId)) {
      throw new FlowScheduleValidationError("Flow schedule record", `/steps/${stepId}/currentDispatchId`, "must name one of the step attempts");
    }
    if (step.result !== undefined) {
      assertResultSemantics(step.result);
      if (step.result.scheduleId !== value.scheduleId || step.result.stepId !== stepId || !step.attempts.includes(step.result.dispatchId)) {
        throw new FlowScheduleValidationError("Flow schedule record", `/steps/${stepId}/result`, "result identity must belong to this schedule step");
      }
      if (step.state === "completed" && step.result.outcome !== "completed") {
        throw new FlowScheduleValidationError("Flow schedule record", `/steps/${stepId}/result/outcome`, "completed step requires a completed result");
      }
      if (step.state === "failed" && step.result.outcome !== "failed") {
        throw new FlowScheduleValidationError("Flow schedule record", `/steps/${stepId}/result/outcome`, "failed step requires a failed result");
      }
    } else if (step.state === "completed" || step.state === "failed") {
      throw new FlowScheduleValidationError("Flow schedule record", `/steps/${stepId}/result`, "completed and failed steps require a result");
    }
    if (step.state === "dispatching" || step.state === "awaiting-result") {
      activeCount += 1;
      if (step.currentDispatchId === undefined || value.activeStepId !== stepId) {
        throw new FlowScheduleValidationError("Flow schedule record", `/steps/${stepId}`, "active step identity is inconsistent");
      }
    }
  }
  if (activeCount > 1) {
    throw new FlowScheduleValidationError("Flow schedule record", "/steps", "at most one step may have an active dispatch");
  }
  if (value.activeStepId !== undefined && (value.steps[value.activeStepId] === undefined || activeCount !== 1)) {
    throw new FlowScheduleValidationError("Flow schedule record", "/activeStepId", "must name the only active step");
  }
  if (activeCount > 0 && value.state !== "active" && value.state !== "paused" && value.state !== "cancelled") {
    throw new FlowScheduleValidationError("Flow schedule record", "/state", "schedule state cannot contain an active dispatch");
  }
  if (value.state === "draft") {
    if (value.targetIdentity !== undefined || ids.some((stepId) => value.steps[stepId].state !== "pending" || value.steps[stepId].attempts.length > 0)) {
      throw new FlowScheduleValidationError("Flow schedule record", "/state", "draft schedules cannot contain admitted work");
    }
  }
  if (value.state === "completed" && ids.some((stepId) => value.steps[stepId].state !== "completed")) {
    throw new FlowScheduleValidationError("Flow schedule record", "/state", "completed schedules require every step to be completed");
  }
  return value;
}

function assertDispatchSemantics(value: FlowScheduleDispatch): void {
  if (value.completionCorrelation !== undefined
    && !validateWorkspaceCompletionCorrelation(value.completionCorrelation)) {
    throw new FlowScheduleValidationError("Flow schedule dispatch", "/completionCorrelation", "must be an exact canonical workspace completion correlation");
  }
  if (value.state === "prepared" && (value.publishedAt !== undefined || value.acceptedAt !== undefined || value.settledAt !== undefined)) {
    throw new FlowScheduleValidationError("Flow schedule dispatch", "/state", "prepared dispatch cannot contain later stage timestamps");
  }
  if (value.state === "published" && (value.publishedAt === undefined || value.acceptedAt !== undefined || value.settledAt !== undefined)) {
    throw new FlowScheduleValidationError("Flow schedule dispatch", "/state", "published dispatch timestamps are inconsistent");
  }
  if (value.state === "accepted" && (value.publishedAt === undefined || value.acceptedAt === undefined || value.settledAt !== undefined)) {
    throw new FlowScheduleValidationError("Flow schedule dispatch", "/state", "accepted dispatch timestamps are inconsistent");
  }
  if (["completed", "failed", "ambiguous", "retired"].includes(value.state) && value.settledAt === undefined) {
    throw new FlowScheduleValidationError("Flow schedule dispatch", "/settledAt", "terminal dispatch requires settledAt");
  }
}

export function parseFlowScheduleDispatch(value: unknown): FlowScheduleDispatch {
  assertSchema(FlowScheduleDispatchSchema, value, "Flow schedule dispatch");
  assertDispatchSemantics(value);
  return value;
}

function assertResultSemantics(value: FlowScheduleResult): void {
  assertTextBytes(value.summary, FLOW_SCHEDULE_LIMITS.maxSummaryBytes, "Flow schedule result summary");
  const correlation = value.completionCorrelation === undefined
    ? undefined
    : validateWorkspaceCompletionCorrelation(value.completionCorrelation);
  if (value.completionCorrelation !== undefined && !correlation) {
    throw new FlowScheduleValidationError("Flow schedule result", "/completionCorrelation", "must be an exact canonical workspace completion correlation");
  }
  if (correlation && !value.resources.includes(correlation.resource)) {
    throw new FlowScheduleValidationError("Flow schedule result", "/resources", "must include the canonical workspace terminal resource");
  }
  const maximumResources = FLOW_SCHEDULE_LIMITS.maxResources + (correlation ? 1 : 0);
  if (value.resources.length > maximumResources) {
    throw new FlowScheduleValidationError(
      "Flow schedule result",
      "/resources",
      `must contain at most ${maximumResources} resources`,
    );
  }
  for (const entry of value.resources) {
    assertTextBytes(entry, FLOW_SCHEDULE_LIMITS.maxResourceBytes, "Flow schedule result resource");
  }
}

export function parseFlowScheduleResult(value: unknown): FlowScheduleResult {
  assertSchema(FlowScheduleResultSchema, value, "Flow schedule result");
  assertResultSemantics(value);
  return value;
}

export function parseFlowScheduleDispatchEnvelope(value: unknown): FlowScheduleDispatchEnvelope {
  assertSchema(FlowScheduleDispatchEnvelopeSchema, value, "Flow schedule dispatch envelope");
  assertTextBytes(value.instruction, FLOW_SCHEDULE_LIMITS.maxPromptBytes, "Flow schedule dispatch instruction");
  return value;
}

export function parseFlowScheduleOwnerMarker(value: unknown): FlowScheduleOwnerMarker {
  assertSchema(FlowScheduleOwnerMarkerSchema, value, "Flow schedule owner marker");
  return value;
}

export function parseFlowScheduleLockOwner(value: unknown): FlowScheduleLockOwner {
  assertSchema(FlowScheduleLockOwnerSchema, value, "Flow schedule lock owner");
  return value;
}

export function parseFlowSchedulePublishedRecord(value: unknown): FlowSchedulePublishedRecord {
  assertSchema(FlowSchedulePublishedRecordSchema, value, "Flow schedule published record");
  const transportMessageId = value.dispatchId.replaceAll("-", "");
  if ((value.messageId !== value.dispatchId && value.messageId !== transportMessageId) || value.traceId !== value.dispatchId) {
    throw new FlowScheduleValidationError("Flow schedule published record", "/messageId", "messageId must be the legacy dispatchId or its workspace transport ID, and traceId must equal dispatchId");
  }
  return value;
}

export function parseFlowScheduleAcceptedRecord(value: unknown): FlowScheduleAcceptedRecord {
  assertSchema(FlowScheduleAcceptedRecordSchema, value, "Flow schedule accepted record");
  const transportMessageId = value.dispatchId.replaceAll("-", "");
  if (value.messageId !== value.dispatchId && value.messageId !== transportMessageId) {
    throw new FlowScheduleValidationError("Flow schedule accepted record", "/messageId", "messageId must be the legacy dispatchId or its workspace transport ID");
  }
  return value;
}

export function parseFlowScheduleCompletionRecord(value: unknown): FlowScheduleCompletionRecord {
  assertSchema(FlowScheduleCompletionRecordSchema, value, "Flow schedule completion record");
  if (value.result !== undefined) {
    assertResultSemantics(value.result);
    if (value.result.scheduleId !== value.scheduleId || value.result.stepId !== value.stepId || value.result.dispatchId !== value.dispatchId) {
      throw new FlowScheduleValidationError("Flow schedule completion record", "/result", "result identity must match the completion record");
    }
  }
  if ((value.state === "completed" || value.state === "failed") && value.result === undefined) {
    throw new FlowScheduleValidationError("Flow schedule completion record", "/result", "published result is required for completed or failed state");
  }
  if (value.state === "completed" && value.result?.outcome !== "completed") {
    throw new FlowScheduleValidationError("Flow schedule completion record", "/result/outcome", "must be completed");
  }
  if (value.state === "failed" && value.result?.outcome !== "failed") {
    throw new FlowScheduleValidationError("Flow schedule completion record", "/result/outcome", "must be failed");
  }
  if ((value.state === "ambiguous" || value.state === "retired") && value.reason === undefined) {
    throw new FlowScheduleValidationError("Flow schedule completion record", "/reason", "is required for ambiguous or retired state");
  }
  return value;
}

export function parseFlowScheduleTodoBinding(value: unknown): FlowScheduleTodoBinding {
  assertSchema(FlowScheduleTodoBindingSchema, value, "Flow schedule todo binding");
  if (value.state === "ambiguous" && value.reason === undefined) {
    throw new FlowScheduleValidationError("Flow schedule todo binding", "/reason", "is required for ambiguous state");
  }
  if (value.todoId === undefined && value.state !== "pending" && value.state !== "ambiguous") {
    throw new FlowScheduleValidationError("Flow schedule todo binding", "/todoId", "is required for bound, completed, or failed states");
  }
  return value;
}
