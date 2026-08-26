import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanDecomposeContract } from "../src/tools/plan-decompose.ts";

test("plan-decompose injects an approved-Plan decomposition prompt for the main flow", () => {
  const input = {
    planHandoffKey: "approved-handoff-key",
    approvedPlanPath: "/plans/approvals/approved.md",
    approvedChecksum: "abc123",
  };
  const before = structuredClone(input);
  const contract = buildPlanDecomposeContract(input);

  assert.deepEqual(input, before, "the pure builder must not mutate its input");
  assert.match(contract, /converts it into the execution plan/);
  assert.match(contract, /do not delegate the decomposition step to a planner, decomposer, teammate/);
  assert.match(contract, /\/plans\/approvals\/approved\.md/);
  assert.match(contract, /abc123/);
  assert.match(contract, /approved-handoff-key/);
  assert.match(contract, /this batch IS the execution plan and the authoritative persisted record/);
  assert.match(contract, /Save location: the Todo batch itself/);
  assert.match(contract, /Naming: each task's `subject` is an outcome title/);
  assert.match(contract, /DAG decomposition/);
  assert.match(contract, /Each task maps to one independent, agent-ready work unit with its own boundary and done-when condition/);
  assert.match(contract, /executing agent's independent work document/);
  assert.match(contract, /blockedBy contains only zero-based indexes of earlier tasks/);
  assert.match(contract, /call todo create exactly once/);
  assert.match(contract, /has not created files, Todos, messages, or agents/);
});

test("plan-decompose contract requires complete approved identity", () => {
  assert.throws(() => buildPlanDecomposeContract({
    planHandoffKey: "approved-handoff-key",
    approvedPlanPath: "",
    approvedChecksum: "abc123",
  }), /approvedPlanPath must not be blank/);
});
