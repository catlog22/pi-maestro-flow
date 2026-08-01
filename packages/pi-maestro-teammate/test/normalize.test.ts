import assert from "node:assert/strict";
import test from "node:test";
import {
  collectUnknownRefs,
  inferGraphMode,
  normalizeTeammateParams,
  taskDependencyNames,
  validateTaskReferences,
  type NormalizedTask,
  type RunTeammateParams,
} from "../src/runs/execution.ts";

test("missing and empty tasks arrays are rejected before dispatch", () => {
  assert.match(normalizeTeammateParams({} as never).error ?? "", /non-empty "tasks"/);
  assert.match(normalizeTeammateParams({ tasks: [] }).error ?? "", /non-empty "tasks"/);
});

test("a task requires non-empty prompt text", () => {
  const missing = normalizeTeammateParams({ tasks: [{ agent: "explorer" }] } as never);
  assert.match(missing.error ?? "", /requires a non-empty "prompt"/);

  const blank = normalizeTeammateParams({ tasks: [{ prompt: "   " }] });
  assert.match(blank.error ?? "", /requires a non-empty "prompt"/);
});

test("one public task normalizes for the internal single-task primitive", () => {
  const result = normalizeTeammateParams({ tasks: [{ agent: "general", prompt: "Inspect auth" }] });
  assert.equal(result.error, undefined);
  assert.equal(result.isMultiTask, false);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].prompt, "Inspect auth");
});

test("top-level defaults apply to tasks and per-task overrides win", () => {
  const result = normalizeTeammateParams({
    agent: "general",
    taskType: "analysis",
    model: "prov/default-model",
    thinking: "low",
    cwd: "D:/base",
    context: "fork",
    timeoutMs: 5000,
    outputSchema: { type: "object" },
    tasks: [
      { prompt: "one" },
      { agent: "reviewer", prompt: "two", model: "prov/override", thinking: "high", context: "fresh", cwd: "D:/other" },
    ],
  });
  assert.equal(result.error, undefined);
  const [first, second] = result.tasks;
  assert.equal(first.agent, "general");
  assert.equal(first.taskType, "analysis");
  assert.equal(first.model, "prov/default-model");
  assert.equal(first.thinking, "low");
  assert.equal(first.context, "fork");
  assert.equal(first.cwd, "D:/base");
  assert.equal(first.timeoutMs, 5000);
  assert.deepEqual(first.outputSchema, { type: "object" });
  assert.equal(second.agent, "reviewer");
  assert.equal(second.model, "prov/override");
  assert.equal(second.thinking, "high");
  assert.equal(second.context, "fresh");
  assert.equal(second.cwd, "D:/other");
});

test("prompt text is always literal and template-like text is not loaded", () => {
  const result = normalizeTeammateParams({ tasks: [{ prompt: "template:analysis" }] });
  assert.equal(result.error, undefined);
  assert.equal(result.tasks[0].prompt, "template:analysis");
});

test("agent defaults to general when neither task nor top level specifies one", () => {
  const result = normalizeTeammateParams({ tasks: [{ prompt: "work" }] });
  assert.equal(result.error, undefined);
  assert.equal(result.tasks[0].agent, "general");
});

test("misspelled {name} reference close to a task name is rejected", () => {
  const result = normalizeTeammateParams({
    tasks: [
      { agent: "a", name: "scan_api", prompt: "list endpoints" },
      { agent: "b", prompt: "review {scan-appi} output" },
    ],
  });
  assert.match(result.error ?? "", /misspelled reference to task "scan_api"/);
});

test("unrelated {literal} braces produce a warning but do not block dispatch", () => {
  const result = normalizeTeammateParams({
    tasks: [
      { agent: "a", name: "scan", prompt: "list endpoints" },
      { agent: "b", prompt: "use {scan} and replace {placeholder} in templates" },
    ],
  });
  assert.equal(result.error, undefined);
  assert.ok(result.warnings.some((warning) => warning.includes("{placeholder}")));
});

test("reference analysis is skipped when no task has a name", () => {
  const result = normalizeTeammateParams({
    tasks: [
      { agent: "a", prompt: "replace {id} in files" },
      { agent: "b", prompt: "replace {slug} in files" },
    ],
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.warnings, []);
});

test("dependsOn with an unknown task name is rejected", () => {
  const result = normalizeTeammateParams({
    tasks: [
      { agent: "a", name: "scan", prompt: "list" },
      { agent: "b", prompt: "summarize", dependsOn: ["missing"] },
    ],
  });
  assert.match(result.error ?? "", /dependsOn references unknown task name "missing"/);
});

test("collectUnknownRefs separates known and unknown references", () => {
  const names = new Set(["scan", "review"]);
  assert.deepEqual(collectUnknownRefs("use {scan} then {reviw} and {other}", names), ["reviw", "other"]);
  assert.deepEqual(collectUnknownRefs(undefined, names), []);
});

test("validateTaskReferences distinguishes misspellings from literals", () => {
  const tasks: NormalizedTask[] = [
    { agent: "a", name: "scan", prompt: "list" },
    { agent: "b", prompt: "check {scen} and {totally_unrelated}" },
  ];
  const { errors, warnings } = validateTaskReferences(tasks);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"\{scen\}" looks like a misspelled reference/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"\{totally_unrelated\}".*literal text/);
});

test("taskDependencyNames merges prompt references and explicit dependsOn", () => {
  const names = new Set(["scan", "lint", "build"]);
  const deps = taskDependencyNames(
    { prompt: "review {scan} output", dependsOn: ["lint", "scan"] },
    names,
  );
  assert.deepEqual(deps.sort(), ["lint", "scan"]);
});

test("inferGraphMode sees dependsOn-only graphs as dependent", () => {
  const tasks: NormalizedTask[] = [
    { agent: "a", name: "scan", prompt: "list endpoints" },
    { agent: "b", name: "report", prompt: "write summary", dependsOn: ["scan"] },
  ];
  assert.equal(inferGraphMode(tasks), "chain");
});

test("background defaults to false and preserves explicit values", () => {
  const omitted: RunTeammateParams = { tasks: [{ prompt: "inspect" }] };
  assert.equal(normalizeTeammateParams(omitted).error, undefined);
  assert.equal(omitted.background, false);

  const enabled: RunTeammateParams = { tasks: [{ prompt: "inspect" }], background: true };
  normalizeTeammateParams(enabled);
  assert.equal(enabled.background, true);

  const disabled: RunTeammateParams = { tasks: [{ prompt: "inspect" }], background: false };
  normalizeTeammateParams(disabled);
  assert.equal(disabled.background, false);
});

test("maxNestingDepth accepts the full 0..ceiling range and rejects the rest", () => {
  for (const value of [0, 1, 2]) {
    const result = normalizeTeammateParams({ tasks: [{ prompt: "inspect" }], maxNestingDepth: value });
    assert.equal(result.error, undefined, `maxNestingDepth ${value} must be accepted`);
  }

  for (const value of [-1, 3, 1.5]) {
    const result = normalizeTeammateParams({ tasks: [{ prompt: "inspect" }], maxNestingDepth: value });
    assert.match(result.error ?? "", /maxNestingDepth must be an integer between 0 and 2/);
  }

  // Omitted keeps the default: no error and no mutation.
  const omitted: RunTeammateParams = { tasks: [{ prompt: "inspect" }] };
  assert.equal(normalizeTeammateParams(omitted).error, undefined);
  assert.equal(omitted.maxNestingDepth, undefined);
});
