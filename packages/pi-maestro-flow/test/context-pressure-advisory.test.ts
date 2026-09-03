import assert from "node:assert/strict";
import test from "node:test";
import {
  appendTodoContextPressureAdvisory,
  appendTodoContextTransitionFailure,
  buildContextPressureAdvisory,
  CONTEXT_PRESSURE_ADVISORY_MARKER,
  CONTEXT_TRANSITION_FAILURE_MARKER,
} from "../src/compaction/context-pressure-advisory.ts";
import type { ContextPressureSnapshot } from "../src/compaction/auto-compaction.ts";
import type { FlowToolResult } from "../src/tools/tool-result.ts";

const baseSnapshot: ContextPressureSnapshot = {
  generation: 4,
  band: "nudge",
  estimatedTokens: 280_000,
  contextWindow: 400_000,
  hardThresholdTokens: 360_000,
  remainingToHard: 80_000,
  nudgeTokens: 280_000,
  pruneTokens: 320_000,
};

const lateAutoPruneSnapshot: ContextPressureSnapshot = {
  ...baseSnapshot,
  band: "auto-prune",
  estimatedTokens: 345_000,
  remainingToHard: 15_000,
};

function result(text = "Completed #1: phase"): FlowToolResult {
  return {
    content: [{ type: "text", text }],
    details: { action: "advance", tasks: [] },
  };
}

function completionInput(transition?: string) {
  return {
    action: "advance",
    id: "1",
    summary: "phase complete",
    ...(transition === undefined ? {} : { transition }),
  };
}

test("pressure advisory is pure and includes bounded post-advance decision facts", () => {
  const advisory = buildContextPressureAdvisory(lateAutoPruneSnapshot, true);
  assert.ok(advisory);
  assert.ok(advisory.includes(CONTEXT_PRESSURE_ADVISORY_MARKER));
  assert.match(advisory, /345,000\/400,000 tokens/);
  assert.match(advisory, /hard threshold 360,000/);
  assert.match(advisory, /15,000 remaining/);
  assert.match(advisory, /late auto-prune reminder window/);
  assert.match(advisory, /340,000–360,000 tokens/);
  assert.match(advisory, /This reminder is emitted only after a completion-form Todo advance/);
  assert.match(advisory, /active Todo work and non-Todo activity are not interrupted or reminded/);
  assert.match(advisory, /standalone new_context tool/);
  assert.match(advisory, /a next phase exists/);
  assert.match(advisory, /no messages are pending/);
  assert.match(advisory, /Do not carry this advisory forward to an unrelated Todo/);
});

test("advisory waits for late auto-prune and makes critical a high-priority checkpoint", () => {
  assert.equal(buildContextPressureAdvisory(baseSnapshot, true), undefined);
  assert.equal(buildContextPressureAdvisory({ ...baseSnapshot, band: "auto-prune" }, true), undefined);

  const autoPrune = buildContextPressureAdvisory(lateAutoPruneSnapshot, true);
  assert.ok(autoPrune);
  assert.match(autoPrune, /late auto-prune reminder window/);
  assert.match(autoPrune, /automatic pruning/);
  assert.match(autoPrune, /standalone new_context tool/);

  const critical = buildContextPressureAdvisory({
    ...baseSnapshot,
    band: "critical",
    estimatedTokens: 365_000,
    remainingToHard: 0,
  }, true);
  assert.ok(critical);
  assert.match(critical, /Context pressure is critical/);
  assert.match(critical, /This Todo completion is the safe checkpoint/);
  assert.match(critical, /prioritize new_context before beginning the next Todo/);
  assert.match(critical, /capacity-safety fallback during active work/);
  assert.doesNotMatch(critical, /Do not call new_context/);
});

test("normal, disabled, unknown, and requested new_context paths stay unchanged", () => {
  assert.equal(buildContextPressureAdvisory({ ...baseSnapshot, band: "normal" }, true), undefined);
  assert.equal(buildContextPressureAdvisory(baseSnapshot, true), undefined);
  assert.equal(buildContextPressureAdvisory(baseSnapshot, false), undefined);
  assert.equal(buildContextPressureAdvisory(undefined, true), undefined);

  const normal = appendTodoContextPressureAdvisory(
    result(),
    completionInput(),
    { ...baseSnapshot, band: "normal" },
    true,
  );
  assert.deepEqual(normal, result());

  const transition = result();
  transition.details = { action: "advance", tasks: [], transition: "new_context" };
  const unchanged = appendTodoContextPressureAdvisory(
    transition,
    completionInput("new_context"),
    { ...baseSnapshot, band: "critical" },
    true,
  );
  assert.equal(unchanged, transition);
});

test("only successful completion-form advances receive Agent-visible content", () => {
  const completion = appendTodoContextPressureAdvisory(
    result(),
    completionInput(),
    lateAutoPruneSnapshot,
    true,
  );
  const text = completion.content.find((item) => item.type === "text");
  assert.ok(text && "text" in text);
  assert.ok(text.text.includes(CONTEXT_PRESSURE_ADVISORY_MARKER));
  assert.match(text.text, /late auto-prune reminder window/);
  assert.equal((completion.details as { transition?: unknown }).transition, undefined);

  const listResult: FlowToolResult = {
    content: [{ type: "text", text: "listed" }],
    details: { action: "list", tasks: [] },
  };
  assert.equal(
    appendTodoContextPressureAdvisory(listResult, { action: "list" }, baseSnapshot, true),
    listResult,
  );

  const failed: FlowToolResult = { ...result(), isError: true };
  assert.equal(appendTodoContextPressureAdvisory(failed, completionInput(), baseSnapshot, true), failed);

  const activationResult = result("Activated #1");
  const activationOnly = appendTodoContextPressureAdvisory(
    activationResult,
    { action: "advance" },
    { ...baseSnapshot, band: "critical", estimatedTokens: 365_000, remainingToHard: 0 },
    true,
  );
  assert.equal(activationOnly, activationResult);

  const second = appendTodoContextPressureAdvisory(completion, completionInput(), baseSnapshot, true);
  assert.deepEqual(second, completion, "the stable marker prevents duplicate advisories");
});

test("post-commit transition failure is Agent-visible and idempotent", () => {
  const base: FlowToolResult = {
    content: [{ type: "text", text: "Completed #1" }, { type: "text", text: "Next task activated" }],
    details: { action: "advance", tasks: [], transition: "new_context", contextTransition: "failed" },
  };
  const visible = appendTodoContextTransitionFailure(base, "another actor owns the pending request");
  const joined = visible.content
    .filter((item): item is Extract<(typeof visible.content)[number], { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  assert.ok(joined.includes(CONTEXT_TRANSITION_FAILURE_MARKER));
  assert.match(joined, /Todo committed/);
  assert.match(joined, /Continue in the current context/);
  assert.equal(joined.match(/\[new-context-transition-failed\]/g)?.length, 1);
  assert.deepEqual(
    appendTodoContextTransitionFailure(visible, "duplicate"),
    visible,
    "the failure marker prevents duplicate Agent messages",
  );
});
