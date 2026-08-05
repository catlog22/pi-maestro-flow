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

test("a prompt embedded inside outputSchema is diagnosed as mislocated, not just missing", () => {
  // Regression: the task text was generated into outputSchema.prompt, leaving
  // the task without its required prompt. The diagnostic must name the real
  // location instead of the generic "requires a non-empty prompt".
  const result = normalizeTeammateParams({
    tasks: [{
      name: "contract-auditor",
      outputSchema: { type: "object", properties: {}, prompt: "PURPOSE: audit" },
    }],
  } as never);
  assert.match(result.error ?? "", /has no "prompt"/);
  assert.match(result.error ?? "", /inside "outputSchema"/);
  assert.doesNotMatch(result.error ?? "", /requires a non-empty "prompt"/);
});

test("outputSchema keeps working when a prompt-like key is a legit schema fragment and task-level prompt exists", () => {
  const result = normalizeTeammateParams({
    tasks: [{
      prompt: "audit",
      outputSchema: { type: "object", properties: { prompt: { type: "string" } } },
    }],
  });
  assert.equal(result.error, undefined);
  assert.equal(result.tasks[0].prompt, "audit");
  assert.deepEqual(result.tasks[0].outputSchema, {
    type: "object",
    properties: { prompt: { type: "string" } },
  });
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

test("per-task description is carried and per-task background warns instead of erroring", () => {
  const result = normalizeTeammateParams({
    tasks: [
      { prompt: "one", description: "scan auth paths" },
      { name: "review", prompt: "two", background: true },
    ],
  });
  assert.equal(result.error, undefined);
  assert.equal(result.tasks[0].description, "scan auth paths");
  assert.equal(result.tasks[1].description, undefined);
  assert.match(
    result.warnings.join("\n"),
    /\[1\] "review" "background" is a dispatch-level setting/,
  );
  // Dispatch-level background still works untouched.
  const topLevel = normalizeTeammateParams({
    background: false,
    tasks: [{ prompt: "one" }],
  });
  assert.equal(topLevel.error, undefined);
  assert.equal(topLevel.warnings.length, 0);
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

test("dependsOn self-reference is rejected for a single task", () => {
  const result = normalizeTeammateParams({
    tasks: [{ name: "self-ref", prompt: "Say hello", dependsOn: ["self-ref"] }],
  });
  assert.match(result.error ?? "", /dependsOn references itself/);
});

test("dependsOn self-reference is rejected in a multi-task graph", () => {
  const result = normalizeTeammateParams({
    tasks: [
      { name: "a", prompt: "do A" },
      { name: "b", prompt: "do B", dependsOn: ["b"] },
    ],
  });
  assert.match(result.error ?? "", /dependsOn references itself/);
});

test("implicit prompt self-reference {ownName} is rejected", () => {
  const result = normalizeTeammateParams({
    tasks: [{ name: "build", prompt: "Run {build} and check output" }],
  });
  assert.match(result.error ?? "", /prompt references its own task name/);
});

test("referencing other tasks by name is not flagged as self-reference", () => {
  const result = normalizeTeammateParams({
    tasks: [
      { name: "scan", prompt: "list endpoints" },
      { name: "report", prompt: "summarize {scan} output", dependsOn: ["scan"] },
    ],
  });
  assert.equal(result.error, undefined);
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

test("per-task maxNestingDepth overrides the top-level default and omission inherits it", () => {
  const result = normalizeTeammateParams({
    tasks: [
      { prompt: "deep", maxNestingDepth: 0 },
      { prompt: "plain" },
    ],
    maxNestingDepth: 1,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.tasks[0].maxNestingDepth, 0, "task value wins over the top-level default");
  assert.equal(result.tasks[1].maxNestingDepth, 1, "omission inherits the top-level default");

  const allOmitted = normalizeTeammateParams({ tasks: [{ prompt: "inspect" }] });
  assert.equal(
    allOmitted.tasks[0].maxNestingDepth,
    undefined,
    "both omitted stays undefined (the ceiling applies at dispatch time)",
  );
});

test("per-task maxNestingDepth validates the same 0..ceiling range", () => {
  for (const value of [0, 1, 2]) {
    const result = normalizeTeammateParams({ tasks: [{ prompt: "inspect", maxNestingDepth: value }] });
    assert.equal(result.error, undefined, `per-task maxNestingDepth ${value} must be accepted`);
  }

  for (const value of [-1, 3, 1.5]) {
    const result = normalizeTeammateParams({ tasks: [{ prompt: "inspect", maxNestingDepth: value }] });
    assert.match(result.error ?? "", /tasks\[0\] maxNestingDepth must be an integer between 0 and 2/);
  }

  const named = normalizeTeammateParams({ tasks: [{ name: "deep", prompt: "inspect", maxNestingDepth: 3 }] });
  assert.match(named.error ?? "", /tasks\[0\] "deep" maxNestingDepth/);
});
