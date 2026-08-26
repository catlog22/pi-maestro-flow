import assert from "node:assert/strict";
import test from "node:test";
import { bindWorkspaceCompletionHandle } from "pi-maestro-teammate/v1/workspace-completion";
import { Value } from "typebox/value";
import {
  ExactWindowIdentitySchema,
  FlowScheduleActionSchema,
  FlowScheduleDispatchEnvelopeSchema,
  FlowScheduleRecordSchema,
  FlowScheduleResultSchema,
  FlowScheduleTodoBindingSpecSchema,
  FlowScheduleTodoOutcomeSchema,
  FlowScheduleValidationError,
  normalizeFlowSchedule,
  parseFlowScheduleAction,
  parseFlowScheduleCompletionRecord,
  parseFlowScheduleDispatchEnvelope,
  parseFlowScheduleRecord,
  parseFlowScheduleResult,
} from "../src/flow-schedule/schemas.ts";
import {
  createFlowScheduleDispatchEnvelope,
  createFlowScheduleResult,
  decodeFlowScheduleDispatch,
  decodeFlowScheduleResult,
  encodeFlowScheduleDispatch,
  encodeFlowScheduleResult,
} from "../src/flow-schedule/protocol.ts";
import {
  FLOW_SCHEDULE_LIMITS,
  FLOW_SCHEDULE_RESULT_TYPE,
  FLOW_SCHEDULE_VERSION,
} from "../src/flow-schedule/types.ts";

const DISPATCH_ID = "123e4567-e89b-42d3-a456-426614174000";
const OWNER_ID = "a".repeat(32);
const OWNER_SELECTOR = `owner:${OWNER_ID}`;
const REPLACEMENT_SELECTOR = `owner:${"b".repeat(32)}`;
const COMPLETION_CORRELATION = bindWorkspaceCompletionHandle("9".repeat(32), {
  workspaceId: "f".repeat(64),
  ownerId: "1".repeat(32),
  ownerNonce: "2".repeat(32),
});

function steps(count: number): Array<{ stepId: string; prompt: string }> {
  return Array.from({ length: count }, (_, index) => ({ stepId: `step-${index}`, prompt: `Run step ${index}` }));
}

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: FLOW_SCHEDULE_VERSION,
    type: FLOW_SCHEDULE_RESULT_TYPE,
    scheduleId: "release",
    stepId: "verify",
    dispatchId: DISPATCH_ID,
    outcome: "completed",
    summary: "Verification passed",
    resources: [],
    ...overrides,
  };
}

test("flow-schedule actions are strict discriminated branches", () => {
  const valid = [
    { action: "create", scheduleId: "release", target: OWNER_SELECTOR, steps: steps(1) },
    { action: "start", scheduleId: "release" },
    { action: "list" },
    { action: "status", scheduleId: "release" },
    { action: "append", scheduleId: "release", afterStepId: "step-0", steps: [{ stepId: "fix", prompt: "Fix" }] },
    { action: "pause", scheduleId: "release" },
    { action: "resume", scheduleId: "release", target: REPLACEMENT_SELECTOR },
    { action: "retry", scheduleId: "release", stepId: "step-0", reason: "Target was replaced" },
    { action: "cancel", scheduleId: "release", reason: "No longer needed" },
    { action: "report", dispatchId: DISPATCH_ID, outcome: "completed", summary: "Done", resources: ["agent://publication"] },
    { action: "report", dispatchId: DISPATCH_ID, outcome: "completed", summary: "Done", todoOutcome: { todoId: "t1", todoStatus: "completed" } },
  ];
  for (const action of valid) assert.deepEqual(parseFlowScheduleAction(action), action);

  for (const invalid of [
    { action: "list", scheduleId: "not-applicable" },
    { action: "start", scheduleId: "release", target: "owner:x" },
    { action: "append", scheduleId: "release", afterStepId: "step-0", steps: steps(1), afterCursor: 0 },
    { action: "create", scheduleId: "release", target: OWNER_SELECTOR, steps: steps(1), cursor: 0 },
    { action: "report", dispatchId: DISPATCH_ID, outcome: "completed", summary: "Done", replyTo: "owner:other" },
    { action: "unknown" },
  ]) {
    assert.throws(() => parseFlowScheduleAction(invalid), FlowScheduleValidationError);
  }
});

test("flow-schedule normalization rejects duplicate steps before producing a record", () => {
  assert.throws(
    () => normalizeFlowSchedule({
      scheduleId: "release",
      target: OWNER_SELECTOR,
      steps: [
        { stepId: "verify", prompt: "First" },
        { stepId: "verify", prompt: "Second" },
      ],
    }, 1),
    /duplicate stepId/,
  );

  const normalized = normalizeFlowSchedule({
    scheduleId: "release",
    target: OWNER_SELECTOR,
    steps: [{ stepId: "verify", prompt: "Line one\r\nLine two" }],
  }, 100);
  assert.equal(normalized.steps.verify.prompt, "Line one\nLine two");
  assert.deepEqual(normalized.stepIds, ["verify"]);
  assert.equal(normalized.state, "draft");
  assert.equal(normalized.steps.verify.state, "pending");
});

test("flow-schedule validates every stated input limit, including UTF-8 bytes", () => {
  assert.equal(parseFlowScheduleAction({
    action: "create",
    scheduleId: "limit",
    target: OWNER_SELECTOR,
    steps: steps(FLOW_SCHEDULE_LIMITS.maxStepsPerSchedule),
  }).action, "create");
  assert.throws(() => parseFlowScheduleAction({
    action: "create",
    scheduleId: "limit",
    target: OWNER_SELECTOR,
    steps: steps(FLOW_SCHEDULE_LIMITS.maxStepsPerSchedule + 1),
  }), FlowScheduleValidationError);

  assert.equal(parseFlowScheduleAction({
    action: "create",
    scheduleId: "bytes",
    target: OWNER_SELECTOR,
    steps: [{ stepId: "max", prompt: "x".repeat(FLOW_SCHEDULE_LIMITS.maxPromptBytes) }],
  }).action, "create");
  assert.throws(() => parseFlowScheduleAction({
    action: "create",
    scheduleId: "bytes",
    target: OWNER_SELECTOR,
    steps: [{ stepId: "too-large", prompt: "x".repeat(FLOW_SCHEDULE_LIMITS.maxPromptBytes + 1) }],
  }), FlowScheduleValidationError);
  assert.throws(() => parseFlowScheduleAction({
    action: "create",
    scheduleId: "unicode",
    target: OWNER_SELECTOR,
    steps: [{ stepId: "too-many-bytes", prompt: "é".repeat(Math.floor(FLOW_SCHEDULE_LIMITS.maxPromptBytes / 2) + 1) }],
  }), /byte limit/);

  assert.equal(parseFlowScheduleAction({
    action: "report",
    dispatchId: DISPATCH_ID,
    outcome: "completed",
    summary: "x".repeat(FLOW_SCHEDULE_LIMITS.maxSummaryBytes),
    resources: Array.from({ length: FLOW_SCHEDULE_LIMITS.maxResources }, (_, index) => `agent://p-${index}`),
  }).action, "report");
  assert.throws(() => parseFlowScheduleAction({
    action: "report",
    dispatchId: DISPATCH_ID,
    outcome: "completed",
    summary: "x".repeat(FLOW_SCHEDULE_LIMITS.maxSummaryBytes + 1),
  }), FlowScheduleValidationError);
  assert.throws(() => parseFlowScheduleAction({
    action: "report",
    dispatchId: DISPATCH_ID,
    outcome: "completed",
    summary: "Done",
    resources: Array.from({ length: FLOW_SCHEDULE_LIMITS.maxResources + 1 }, (_, index) => `agent://p-${index}`),
  }), FlowScheduleValidationError);
});

test("dispatch and result protocol envelopes are exact and versioned", () => {
  const envelope = {
    version: FLOW_SCHEDULE_VERSION,
    type: "flow-schedule-dispatch",
    scheduleId: "release",
    stepId: "verify",
    dispatchId: DISPATCH_ID,
    instruction: "Run verification",
    report: { tool: "flow-schedule", action: "report" },
  };
  assert.deepEqual(parseFlowScheduleDispatchEnvelope(envelope), envelope);
  assert.deepEqual(parseFlowScheduleResult(result()), result());

  assert.throws(() => parseFlowScheduleDispatchEnvelope({ ...envelope, version: 2 }), FlowScheduleValidationError);
  assert.throws(() => parseFlowScheduleDispatchEnvelope({ ...envelope, dispatchId: "not-a-uuid" }), FlowScheduleValidationError);
  assert.throws(() => parseFlowScheduleDispatchEnvelope({ ...envelope, messageId: DISPATCH_ID }), FlowScheduleValidationError);
  assert.throws(() => parseFlowScheduleResult(result({ extra: true })), FlowScheduleValidationError);
  assert.throws(() => parseFlowScheduleResult(result({ outcome: "ambiguous" })), FlowScheduleValidationError);
});

test("typed results carry and validate the owner-bound canonical terminal resource", () => {
  const correlated = createFlowScheduleResult({
    scheduleId: "release",
    stepId: "verify",
    dispatchId: DISPATCH_ID,
    outcome: "completed",
    summary: "Done",
    completionCorrelation: COMPLETION_CORRELATION,
  });
  assert.deepEqual(correlated.completionCorrelation, COMPLETION_CORRELATION);
  assert.deepEqual(correlated.resources, [COMPLETION_CORRELATION.resource]);
  assert.deepEqual(decodeFlowScheduleResult(encodeFlowScheduleResult(correlated)), correlated);

  const legacyResources = Array.from(
    { length: FLOW_SCHEDULE_LIMITS.maxResources },
    (_, index) => `agent://legacy-${index}`,
  );
  const outputSafe = createFlowScheduleResult({
    scheduleId: "release",
    stepId: "verify",
    dispatchId: DISPATCH_ID,
    outcome: "completed",
    summary: "Done",
    resources: legacyResources,
    completionCorrelation: COMPLETION_CORRELATION,
  });
  assert.equal(outputSafe.resources.length, FLOW_SCHEDULE_LIMITS.maxResources + 1);
  assert.deepEqual(outputSafe.resources.slice(0, -1), legacyResources);
  assert.equal(outputSafe.resources.at(-1), COMPLETION_CORRELATION.resource);
  assert.throws(() => parseFlowScheduleResult(result({
    resources: [...legacyResources, "agent://legacy-overflow"],
  })), /at most/);

  assert.throws(() => parseFlowScheduleResult({
    ...correlated,
    resources: [],
  }), /canonical workspace terminal resource/);
  assert.throws(() => parseFlowScheduleResult({
    ...correlated,
    completionCorrelation: { ...COMPLETION_CORRELATION, dispatchId: "8".repeat(32) },
  }), /canonical workspace completion correlation/);
});

test("persistence schemas reject extra fields and inconsistent schedule projections", () => {
  const schedule = normalizeFlowSchedule({
    scheduleId: "release",
    target: OWNER_SELECTOR,
    steps: [{ stepId: "verify", prompt: "Run verification" }],
  }, 1);
  assert.deepEqual(parseFlowScheduleRecord(schedule), schedule);
  assert.equal(Value.Check(FlowScheduleRecordSchema, { ...schedule, position: 1 }), false);
  assert.equal(Value.Check(FlowScheduleActionSchema, { action: "list", extra: true }), false);
  assert.equal(Value.Check(ExactWindowIdentitySchema, {
    workspaceId: "workspace",
    endpointId: "endpoint",
    ownerId: OWNER_ID,
    ownerNonce: "b".repeat(32),
  }), true);
  assert.equal(Value.Check(FlowScheduleDispatchEnvelopeSchema, {
    version: 1,
    type: "flow-schedule-dispatch",
  }), false);
  assert.equal(Value.Check(FlowScheduleResultSchema, result()), true);

  assert.throws(() => parseFlowScheduleRecord({ ...schedule, stepIds: ["verify", "verify"] }), /unique/);
  assert.throws(
    () => parseFlowScheduleRecord({ ...schedule, futureField: 1 }),
    /must not have additional properties \("futureField"\)/,
  );
  assert.throws(() => parseFlowScheduleRecord({ ...schedule, steps: { other: schedule.steps.verify } }), /match exactly/);
  assert.throws(() => parseFlowScheduleRecord({
    ...schedule,
    activeStepId: "verify",
  }), /only active step/);
  assert.throws(() => parseFlowScheduleRecord({
    ...schedule,
    state: "completed",
    steps: { verify: { ...schedule.steps.verify, state: "completed" } },
  }), /require a result/);

  const attemptIds = Array.from({ length: FLOW_SCHEDULE_LIMITS.maxAttemptsPerStep + 1 }, (_, index) =>
    `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  assert.throws(() => parseFlowScheduleRecord({
    ...schedule,
    steps: {
      verify: { ...schedule.steps.verify, attempts: attemptIds },
    },
  }), FlowScheduleValidationError);
});

test("completion persistence requires exact result identity and state", () => {
  const identity = {
    workspaceId: "workspace",
    endpointId: "endpoint",
    ownerId: OWNER_ID,
    ownerNonce: "b".repeat(32),
  };
  const completion = {
    version: 1,
    type: "flow-schedule-completion",
    dispatchId: DISPATCH_ID,
    scheduleId: "release",
    stepId: "verify",
    targetIdentity: identity,
    state: "completed",
    result: result(),
    completedAt: 10,
  };
  assert.deepEqual(parseFlowScheduleCompletionRecord(completion), completion);
  assert.throws(() => parseFlowScheduleCompletionRecord({ ...completion, state: "ambiguous", result: undefined }), /reason/);
  assert.throws(() => parseFlowScheduleCompletionRecord({ ...completion, state: "failed" }), /must be failed/);
  assert.throws(() => parseFlowScheduleCompletionRecord({
    ...completion,
    result: result({ stepId: "other" }),
  }), /identity/);
});

test("FlowScheduleTodoBindingSpec schema accepts optional label and two independent gate flags", () => {
  assert.ok(Value.Check(FlowScheduleTodoBindingSpecSchema, {}));
  assert.ok(Value.Check(FlowScheduleTodoBindingSpecSchema, { label: "build" }));
  assert.ok(Value.Check(FlowScheduleTodoBindingSpecSchema, { requireCompleted: true }));
  assert.ok(Value.Check(FlowScheduleTodoBindingSpecSchema, { conflictCheck: true }));
  assert.ok(Value.Check(FlowScheduleTodoBindingSpecSchema, { requireCompleted: true, conflictCheck: true }));
});

test("FlowScheduleTodoOutcome schema requires todoId and todoStatus", () => {
  assert.ok(Value.Check(FlowScheduleTodoOutcomeSchema, { todoId: "t1", todoStatus: "completed" }));
  assert.ok(!Value.Check(FlowScheduleTodoOutcomeSchema, { todoStatus: "completed" }));
  assert.ok(!Value.Check(FlowScheduleTodoOutcomeSchema, { todoId: "t1", todoStatus: "unknown" }));
});

test("dispatch envelope round-trips an optional todoBinding through encode/decode", () => {
  const envelope = createFlowScheduleDispatchEnvelope({
    scheduleId: "release",
    stepId: "build",
    dispatchId: DISPATCH_ID,
    instruction: "Build it",
  });
  assert.equal(envelope.todoBinding, undefined);
  const withBinding = {
    ...envelope,
    todoBinding: { label: "build", requireCompleted: true, conflictCheck: true },
  };
  const encoded = encodeFlowScheduleDispatch(withBinding);
  const decoded = decodeFlowScheduleDispatch(encoded);
  assert.deepEqual(decoded, withBinding);
  assert.equal(decoded.todoBinding?.requireCompleted, true);
  assert.equal(decoded.todoBinding?.conflictCheck, true);
  // Old-style envelope without todoBinding still decodes (backward compatible).
  const legacy = JSON.stringify({ ...envelope });
  assert.deepEqual(decodeFlowScheduleDispatch(legacy), envelope);
});

test("result round-trips an optional todoOutcome through encode/decode", () => {
  const result = createFlowScheduleResult({
    scheduleId: "release",
    stepId: "build",
    dispatchId: DISPATCH_ID,
    outcome: "completed",
    summary: "Done",
  });
  assert.equal(result.todoOutcome, undefined);
  const withOutcome = {
    ...result,
    todoOutcome: { todoId: "t1", todoStatus: "completed" },
  };
  const encoded = encodeFlowScheduleResult(withOutcome);
  const decoded = decodeFlowScheduleResult(encoded);
  assert.deepEqual(decoded, withOutcome);
  assert.equal(decoded.todoOutcome?.todoId, "t1");
  // Old-style result without todoOutcome still decodes (backward compatible).
  const legacy = JSON.stringify({ ...result });
  assert.deepEqual(decodeFlowScheduleResult(legacy), result);
});

test("create/append persist step.todoBinding into the FlowScheduleStep record", () => {
  const create = normalizeFlowSchedule({
    scheduleId: "release",
    target: OWNER_SELECTOR,
    steps: [{ stepId: "build", prompt: "Build", todoBinding: { label: "build", requireCompleted: true, conflictCheck: true } }],
  }, 100);
  assert.deepEqual(create.steps["build"].todoBinding, { label: "build", requireCompleted: true, conflictCheck: true });
  // Step without todoBinding stays unset.
  const bare = normalizeFlowSchedule({
    scheduleId: "bare",
    target: OWNER_SELECTOR,
    steps: [{ stepId: "build", prompt: "Build" }],
  }, 100);
  assert.equal(bare.steps["build"].todoBinding, undefined);
});
