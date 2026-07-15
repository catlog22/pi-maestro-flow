import assert from "node:assert/strict";
import test from "node:test";
import {
  collectUnknownRefs,
  inferGraphMode,
  normalizeTeammateParams,
  taskDependencyNames,
  validateTaskReferences,
  type NormalizedTask,
} from "../src/runs/execution.ts";

// ---------------------------------------------------------------------------
// normalizeTeammateParams — mode selection and fail-fast validation
// ---------------------------------------------------------------------------

test("empty params are rejected before dispatch", () => {
  const result = normalizeTeammateParams({} as never);
  assert.ok(result.error);
  assert.match(result.error!, /Requires "agent"/);
});

test("single mode without task or prompt is rejected as an empty task", () => {
  const result = normalizeTeammateParams({ agent: "delegate" });
  assert.ok(result.error);
  assert.match(result.error!, /task" or "prompt/);
});

test("single mode with a prompt template but no task is accepted", () => {
  const result = normalizeTeammateParams({ agent: "delegate", prompt: "analysis" });
  assert.equal(result.error, undefined);
  assert.equal(result.isMultiTask, false);
  assert.equal(result.tasks, null);
});

test("single mode promptArgs without prompt produces a warning", () => {
  const result = normalizeTeammateParams({
    agent: "delegate",
    task: "inspect",
    promptArgs: ["@src"],
  });
  assert.equal(result.error, undefined);
  assert.ok(result.warnings.some((w) => w.includes("promptArgs")));
});

test("multi-task tasks without task or prompt are rejected as empty tasks", () => {
  const result = normalizeTeammateParams({
    tasks: [{ agent: "explorer", name: "scan" }],
  } as never);
  assert.ok(result.error);
  assert.match(result.error!, /tasks\[0\] "scan" requires/);
});

// ---------------------------------------------------------------------------
// Top-level defaults sink into tasks; per-task values win
// ---------------------------------------------------------------------------

test("top-level defaults apply to tasks and per-task overrides win", () => {
  const result = normalizeTeammateParams({
    model: "prov/default-model",
    thinking: "low",
    cwd: "D:/base",
    context: "fork",
    timeoutMs: 5000,
    tasks: [
      { agent: "a", task: "one" },
      { agent: "b", task: "two", model: "prov/override", context: "fresh", cwd: "D:/other" },
    ],
  } as never);
  assert.equal(result.error, undefined);
  const [first, second] = result.tasks!;
  assert.equal(first.model, "prov/default-model");
  assert.equal(first.context, "fork");
  assert.equal(first.cwd, "D:/base");
  assert.equal(first.timeoutMs, 5000);
  assert.equal(second.model, "prov/override");
  assert.equal(second.context, "fresh");
  assert.equal(second.cwd, "D:/other");
});

test("top-level agent and task are flagged as ignored in multi-task mode", () => {
  const result = normalizeTeammateParams({
    agent: "delegate",
    task: "ignored",
    tasks: [{ agent: "a", task: "one" }],
  } as never);
  assert.equal(result.error, undefined);
  assert.ok(result.warnings.some((w) => w.includes("ignored in multi-task mode")));
});

// ---------------------------------------------------------------------------
// chain deprecation — tasks take precedence
// ---------------------------------------------------------------------------

test("tasks take precedence over deprecated chain and a warning is emitted", () => {
  const result = normalizeTeammateParams({
    tasks: [{ agent: "a", task: "from tasks" }],
    chain: [{ agent: "b", task: "from chain" }],
  } as never);
  assert.equal(result.error, undefined);
  assert.equal(result.tasks!.length, 1);
  assert.equal(result.tasks![0].task, "from tasks");
  assert.ok(result.warnings.some((w) => w.includes('"chain" is deprecated')));
});

test("chain alone still works with deprecation warning and top-level defaults", () => {
  const result = normalizeTeammateParams({
    task: "start here",
    model: "prov/m",
    chain: [{ agent: "a" }, { agent: "b" }],
  } as never);
  assert.equal(result.error, undefined);
  assert.equal(result.tasks!.length, 2);
  assert.equal(result.tasks![0].task, "start here");
  assert.match(result.tasks![1].task, /\{_step0\}/);
  assert.equal(result.tasks![0].model, "prov/m");
  assert.ok(result.warnings.some((w) => w.includes('"chain" is deprecated')));
});

// ---------------------------------------------------------------------------
// Reference validation — misspellings rejected, literals warned
// ---------------------------------------------------------------------------

test("misspelled {name} reference close to a task name is rejected", () => {
  const result = normalizeTeammateParams({
    tasks: [
      { agent: "a", name: "scan_api", task: "list endpoints" },
      { agent: "b", task: "review {scan-appi} output" },
    ],
  } as never);
  assert.ok(result.error);
  assert.match(result.error!, /misspelled reference to task "scan_api"/);
});

test("unrelated {literal} braces produce a warning but do not block dispatch", () => {
  const result = normalizeTeammateParams({
    tasks: [
      { agent: "a", name: "scan", task: "list endpoints" },
      { agent: "b", task: "use {scan} and replace {placeholder} in templates" },
    ],
  } as never);
  assert.equal(result.error, undefined);
  assert.ok(result.warnings.some((w) => w.includes("{placeholder}")));
});

test("reference analysis is skipped when no task has a name", () => {
  const result = normalizeTeammateParams({
    tasks: [
      { agent: "a", task: "replace {id} in files" },
      { agent: "b", task: "replace {slug} in files" },
    ],
  } as never);
  assert.equal(result.error, undefined);
  assert.equal(result.warnings.length, 0);
});

test("dependsOn with an unknown task name is rejected", () => {
  const result = normalizeTeammateParams({
    tasks: [
      { agent: "a", name: "scan", task: "list" },
      { agent: "b", task: "summarize", dependsOn: ["missing"] },
    ],
  } as never);
  assert.ok(result.error);
  assert.match(result.error!, /dependsOn references unknown task name "missing"/);
});

// ---------------------------------------------------------------------------
// collectUnknownRefs / validateTaskReferences primitives
// ---------------------------------------------------------------------------

test("collectUnknownRefs separates known and unknown references", () => {
  const names = new Set(["scan", "review"]);
  assert.deepEqual(collectUnknownRefs("use {scan} then {reviw} and {other}", names), ["reviw", "other"]);
  assert.deepEqual(collectUnknownRefs(undefined, names), []);
});

test("validateTaskReferences distinguishes misspellings from literals", () => {
  const tasks: NormalizedTask[] = [
    { agent: "a", name: "scan", task: "list" },
    { agent: "b", task: "check {scen} and {totally_unrelated}" },
  ];
  const { errors, warnings } = validateTaskReferences(tasks);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"\{scen\}" looks like a misspelled reference/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"\{totally_unrelated\}".*literal text/);
});

// ---------------------------------------------------------------------------
// dependsOn participates in graph edges alongside {name} references
// ---------------------------------------------------------------------------

test("taskDependencyNames merges implicit references and explicit dependsOn", () => {
  const names = new Set(["scan", "lint", "build"]);
  const deps = taskDependencyNames(
    { task: "review {scan} output", dependsOn: ["lint", "scan"] },
    names,
  );
  assert.deepEqual(deps.sort(), ["lint", "scan"]);
});

test("inferGraphMode sees dependsOn-only graphs as dependent, not parallel", () => {
  const tasks: NormalizedTask[] = [
    { agent: "a", name: "scan", task: "list endpoints" },
    { agent: "b", name: "report", task: "write summary", dependsOn: ["scan"] },
  ];
  assert.equal(inferGraphMode(tasks), "chain");
});

// ---------------------------------------------------------------------------
// context passthrough (multi-task fork)
// ---------------------------------------------------------------------------

test("context flows through normalization for every task", () => {
  const result = normalizeTeammateParams({
    context: "fork",
    tasks: [
      { agent: "a", task: "one" },
      { agent: "b", task: "two" },
    ],
  } as never);
  assert.equal(result.error, undefined);
  assert.ok(result.tasks!.every((t) => t.context === "fork"));
});
