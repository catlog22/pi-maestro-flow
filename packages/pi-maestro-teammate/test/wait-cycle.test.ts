import assert from "node:assert/strict";
import test from "node:test";
import {
  validateWaitCycle,
  type WaitCycleAction,
  type WaitCycleValidationInput,
} from "../src/extension/wait-cycle.ts";

const callerCorrelationId = "caller";
const callerDependentIds = new Set(["ancestor", "container"]);

function validate(
  input: Partial<WaitCycleValidationInput> & Pick<WaitCycleValidationInput, "action" | "resolvedTargetIds">,
) {
  return validateWaitCycle({
    callerCorrelationId,
    callerDependentIds,
    ...input,
  });
}

test("nonblocking actions allow cyclic targets", () => {
  for (const action of ["status", "diagnose", "watch"] satisfies WaitCycleAction[]) {
    assert.equal(validate({ action, resolvedTargetIds: [callerCorrelationId, "ancestor"] }), undefined);
  }
});

test("direct self wait is rejected", () => {
  assert.deepEqual(validate({ action: "wait", resolvedTargetIds: [callerCorrelationId] }), {
    code: "self-wait-deadlock",
    cyclicIds: [callerCorrelationId],
  });
});

test("all rejects when any target is cyclic", () => {
  assert.deepEqual(validate({
    action: "wait",
    waitMode: "all",
    resolvedTargetIds: ["sibling", "container", callerCorrelationId, "container"],
  }), {
    code: "self-wait-deadlock",
    cyclicIds: ["container", callerCorrelationId],
  });
});

test("any allows a barrier with a noncyclic target", () => {
  assert.equal(validate({
    action: "wait",
    waitMode: "any",
    resolvedTargetIds: [callerCorrelationId, "sibling"],
  }), undefined);
});

test("any rejects when every target is cyclic", () => {
  assert.deepEqual(validate({
    action: "wait",
    waitMode: "any",
    resolvedTargetIds: ["ancestor", "container"],
  }), {
    code: "self-wait-deadlock",
    cyclicIds: ["ancestor", "container"],
  });
});

test("count allows satisfaction from noncyclic targets", () => {
  assert.equal(validate({
    action: "wait",
    waitMode: "count",
    waitCount: 2,
    resolvedTargetIds: ["sibling-a", "ancestor", "sibling-b"],
  }), undefined);
});

test("count rejects when satisfying the barrier requires a cyclic target", () => {
  assert.deepEqual(validate({
    action: "wait",
    waitMode: "count",
    waitCount: 2,
    resolvedTargetIds: ["sibling", "ancestor", "container"],
  }), {
    code: "self-wait-deadlock",
    cyclicIds: ["ancestor", "container"],
  });
});

test("sibling-only waits are allowed for every barrier mode", () => {
  const resolvedTargetIds = ["sibling-a", "sibling-b"];
  assert.equal(validate({ action: "wait", waitMode: "all", resolvedTargetIds }), undefined);
  assert.equal(validate({ action: "wait", waitMode: "any", resolvedTargetIds }), undefined);
  assert.equal(validate({ action: "wait", waitMode: "count", waitCount: 2, resolvedTargetIds }), undefined);
});
