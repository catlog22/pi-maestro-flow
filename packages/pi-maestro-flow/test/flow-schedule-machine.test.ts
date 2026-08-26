import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelFlowSchedule,
  failFlowSchedule,
  pauseFlowSchedule,
  resumeFlowSchedule,
  selectNextFlowScheduleStep,
  startFlowSchedule,
} from "../src/flow-schedule/machine.ts";
import {
  createFlowScheduleDispatchEnvelope,
  createFlowScheduleResult,
  decodeFlowScheduleDispatch,
  decodeFlowScheduleResult,
  encodeFlowScheduleDispatch,
  encodeFlowScheduleResult,
  flowScheduleDispatchMessageId,
  flowScheduleResultMessageId,
  flowScheduleResultTransportMessageId,
} from "../src/flow-schedule/protocol.ts";
import { FlowScheduleValidationError, normalizeFlowSchedule, parseFlowScheduleRecord } from "../src/flow-schedule/schemas.ts";

const OWNER_A = `owner:${"a".repeat(32)}`;
const OWNER_B = `owner:${"b".repeat(32)}`;
const DISPATCH_ID = "123e4567-e89b-42d3-a456-426614174000";

function draft() {
  return normalizeFlowSchedule({
    scheduleId: "release",
    target: OWNER_A,
    steps: [
      { stepId: "build", prompt: "Build" },
      { stepId: "verify", prompt: "Verify" },
    ],
  }, 1);
}

test("machine start, pause, resume, cancel, and next-step selection are pure proposals", () => {
  const initial = draft();
  const active = startFlowSchedule(initial);
  assert.equal(initial.state, "draft");
  assert.equal(active.state, "active");
  assert.equal(selectNextFlowScheduleStep(active), "build");

  const paused = pauseFlowSchedule(active);
  assert.equal(paused.state, "paused");
  assert.equal(selectNextFlowScheduleStep(paused), undefined);
  assert.equal(resumeFlowSchedule(paused).state, "active");

  const cancelled = cancelFlowSchedule(active, "No longer needed");
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.reason, "No longer needed");
  assert.deepEqual(cancelled.stepIds.map((id) => cancelled.steps[id].state), ["cancelled", "cancelled"]);
  assert.equal(active.steps.build.state, "pending");
});

test("fail transitions an active schedule with no active dispatch to failed", () => {
  const active = startFlowSchedule(draft());
  const failed = failFlowSchedule(active, "target not reachable");
  assert.equal(failed.state, "failed");
  assert.equal(failed.reason, "target not reachable");
  assert.throws(() => failFlowSchedule(failed, "x"), /cannot fail/);
  const paused = pauseFlowSchedule(active);
  assert.throws(() => failFlowSchedule(paused, "x"), /cannot fail/);
  const draftSchedule = draft();
  assert.throws(() => failFlowSchedule(draftSchedule, "x"), /cannot fail/);
  const activeDispatch = parseFlowScheduleRecord({
    ...active,
    activeStepId: "build",
    steps: { ...active.steps, build: { ...active.steps.build, state: "dispatching", attempts: [DISPATCH_ID], currentDispatchId: DISPATCH_ID } },
  });
  assert.throws(() => failFlowSchedule(activeDispatch, "x"), /no active dispatch/);
});

test("retarget requires a paused schedule with no active attempt", () => {
  const paused = pauseFlowSchedule(startFlowSchedule(draft()));
  const retargeted = resumeFlowSchedule({
    ...paused,
    targetIdentity: {
      workspaceId: "workspace",
      endpointId: "endpoint",
      ownerId: "a".repeat(32),
      ownerNonce: "c".repeat(32),
    },
  }, OWNER_B);
  assert.equal(retargeted.targetSelector, OWNER_B);
  assert.equal(retargeted.targetIdentity, undefined);

  const activeAttempt = parseFlowScheduleRecord({
    ...paused,
    activeStepId: "build",
    steps: {
      ...paused.steps,
      build: {
        ...paused.steps.build,
        state: "dispatching",
        attempts: [DISPATCH_ID],
        currentDispatchId: DISPATCH_ID,
      },
    },
  });
  assert.throws(() => resumeFlowSchedule(activeAttempt, OWNER_B), /retarget requires no active dispatch/);
});

test("protocol JSON and deterministic result IDs are exact and versioned", () => {
  const envelope = createFlowScheduleDispatchEnvelope({
    scheduleId: "release",
    stepId: "verify",
    dispatchId: DISPATCH_ID,
    instruction: "Verify",
  });
  assert.deepEqual(decodeFlowScheduleDispatch(encodeFlowScheduleDispatch(envelope)), envelope);
  assert.throws(
    () => decodeFlowScheduleDispatch(`${encodeFlowScheduleDispatch(envelope)} trailing`),
    FlowScheduleValidationError,
  );
  assert.throws(
    () => decodeFlowScheduleDispatch(JSON.stringify({ ...envelope, extra: true })),
    FlowScheduleValidationError,
  );

  const result = createFlowScheduleResult({
    scheduleId: "release",
    stepId: "verify",
    dispatchId: DISPATCH_ID,
    outcome: "completed",
    summary: "Done",
  });
  assert.deepEqual(decodeFlowScheduleResult(encodeFlowScheduleResult(result)), result);
  assert.equal(flowScheduleDispatchMessageId(DISPATCH_ID), "123e4567e89b42d3a456426614174000");
  assert.match(flowScheduleResultTransportMessageId(DISPATCH_ID), /^[a-f0-9]{32}$/);
  assert.notEqual(flowScheduleResultTransportMessageId(DISPATCH_ID), flowScheduleDispatchMessageId(DISPATCH_ID));
  assert.equal(flowScheduleResultMessageId(DISPATCH_ID), flowScheduleResultMessageId(DISPATCH_ID));
  assert.notEqual(flowScheduleResultMessageId(DISPATCH_ID), flowScheduleResultMessageId("223e4567-e89b-42d3-a456-426614174000"));
  assert.throws(() => flowScheduleResultMessageId("not-a-dispatch"), FlowScheduleValidationError);
  assert.throws(() => flowScheduleDispatchMessageId("not-a-dispatch"), FlowScheduleValidationError);
  assert.throws(() => flowScheduleResultTransportMessageId("not-a-dispatch"), FlowScheduleValidationError);
});

test("next-step selection never skips a failed or ambiguous sequential step", () => {
  const active = startFlowSchedule(draft());
  const failed = parseFlowScheduleRecord({
    ...active,
    steps: {
      ...active.steps,
      build: {
        ...active.steps.build,
        state: "failed",
        attempts: [DISPATCH_ID],
        result: {
          version: 1,
          type: "flow-schedule-result",
          scheduleId: "release",
          stepId: "build",
          dispatchId: DISPATCH_ID,
          outcome: "failed",
          summary: "Failed",
          resources: [],
        },
      },
    },
  });
  assert.equal(selectNextFlowScheduleStep(failed), undefined);
});
