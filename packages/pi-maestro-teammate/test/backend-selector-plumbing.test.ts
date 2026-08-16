import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { normalizeTeammateParams, singleRunParamsOf } from "../src/runs/execution-infra.ts";

/**
 * The task-level backend selector, from the request down to the run spec.
 *
 * The selector is only meaningful if the projection from a normalized task to
 * `RunSingleTeammateParams` carries it. That projection used to be written out
 * four times across two extension modules, and a copy that forgot a field did
 * not fail — it silently ran the default backend, which is the one failure mode
 * a routing decision must not have. Dropping the selector on the
 * nested-dispatch path happened once; dropping `todos` on all four happened
 * next. The projection now has one home, so these cases pin that home down and
 * assert no module has grown a second one.
 */

/** Every extension module that dispatches a single teammate. */
const DISPATCHERS: readonly { module: string; label: string }[] = [
  { module: "../src/extension/index.ts", label: "root dispatch and restart" },
  { module: "../src/extension/teammate-proxy.ts", label: "nested dispatch and restart" },
];

test("the shared projection is the only builder, and it carries every task field", () => {
  const task = {
    agent: "prober",
    prompt: "do the thing",
    taskType: "coding" as const,
    name: "one",
    backend: "dsh",
    context: "fork" as const,
    model: "m",
    fallbackModels: ["n"],
    thinking: "high" as const,
    cwd: "/tmp",
    outputSchema: { type: "object" },
    timeoutMs: 5,
    todos: ["t1"],
  };
  const params = singleRunParamsOf(task, { task: task.prompt, reply_to: "main" });
  // Every field a request can declare on a task, checked as a set rather than
  // one assertion each: a field added to NormalizedTask and forgotten here is
  // the defect this file exists for.
  assert.deepEqual(params, {
    agent: "prober",
    task: "do the thing",
    taskType: "coding",
    name: "one",
    backend: "dsh",
    reply_to: "main",
    context: "fork",
    model: "m",
    fallbackModels: ["n"],
    thinking: "high",
    cwd: "/tmp",
    outputSchema: { type: "object" },
    todos: ["t1"],
  });
  // A restart replays a different prompt under a fixed context and adds the
  // task's own timeout; nothing else about the task changes.
  assert.deepEqual(
    singleRunParamsOf(task, { task: "woke up", context: "fresh", timeoutMs: task.timeoutMs }),
    { ...params, task: "woke up", context: "fresh", timeoutMs: 5, reply_to: undefined },
  );

  for (const { module, label } of DISPATCHERS) {
    const source = fs.readFileSync(new URL(module, import.meta.url), "utf-8");
    // `taskType` was the anchor of the old inline builders: only an object
    // destined for `runSingleTeammate` reads it off a task. A match here means
    // a second projection has grown back, and the next field will be dropped
    // from it rather than from the one under test above.
    const inline = source.match(/taskType: (?:singleTask|task)\.taskType,/g) ?? [];
    assert.deepEqual(
      inline,
      [],
      `${label} (${module}) builds run params inline again instead of through singleRunParamsOf`,
    );
    assert.match(
      source,
      /singleRunParamsOf\(/,
      `${label} (${module}) no longer dispatches through the shared projection`,
    );
  }
});

test("graph dispatch projects the selector into the run spec", () => {
  const source = fs.readFileSync(new URL("../src/runs/execution.ts", import.meta.url), "utf-8");
  assert.match(source, /params\.backend === undefined \? \{\} : \{ backend: params\.backend \}/);
  assert.match(source, /backend: task\.backend,/);
});

test("normalization carries a task-level backend, and a top-level one as its default", () => {
  const normalized = normalizeTeammateParams({
    backend: "fleet-default",
    tasks: [
      { prompt: "a", name: "explicit", backend: "dsh" },
      { prompt: "b", name: "inherits" },
    ],
  });
  assert.equal(normalized.error, undefined);
  assert.equal(normalized.tasks[0]?.backend, "dsh");
  assert.equal(normalized.tasks[1]?.backend, "fleet-default");
});

test("a task naming no backend anywhere leaves the registry default in force", () => {
  const normalized = normalizeTeammateParams({ tasks: [{ prompt: "a" }] });
  assert.equal(normalized.tasks[0]?.backend, undefined);
});

test("the selector is absent from the model-facing schema", async () => {
  // Which backends exist is per-workspace registration; a static schema cannot
  // enumerate them, so a model setting this field would be guessing at names it
  // has never been shown. Deployment-authored specs set it instead.
  const schemas = fs.readFileSync(new URL("../src/extension/schemas.ts", import.meta.url), "utf-8");
  assert.doesNotMatch(schemas, /\bbackend:\s*Type\./);
});
