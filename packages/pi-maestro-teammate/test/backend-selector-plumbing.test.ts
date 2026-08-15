import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { normalizeTeammateParams } from "../src/runs/execution-infra.ts";

/**
 * The task-level backend selector, from the request down to the run spec.
 *
 * The selector is only meaningful if every builder that turns a task into
 * `RunSingleTeammateParams` carries it. There are four, in three modules, and a
 * builder that forgets it does not fail — it silently runs the default backend,
 * which is the one failure mode a routing decision must not have. Dropping it
 * on the nested-dispatch path is exactly what happened once already.
 */

/** Every module that builds params handed to `runSingleTeammate`. */
const BUILDERS: readonly { module: string; label: string }[] = [
  { module: "../src/extension/index.ts", label: "root dispatch and restart" },
  { module: "../src/extension/teammate-proxy.ts", label: "nested dispatch and restart" },
];

test("every task-to-params builder carries the backend selector", () => {
  for (const { module, label } of BUILDERS) {
    const source = fs.readFileSync(new URL(module, import.meta.url), "utf-8");
    // `taskType` is the anchor: only objects destined for `runSingleTeammate`
    // read it off a task. Anchoring on `name` instead also matches the active
    // agent registry record, which is not a params object.
    const builders = source.match(/taskType: (?:singleTask|task)\.taskType,/g) ?? [];
    const selectors = source.match(/backend: (?:singleTask|task)\.backend,/g) ?? [];
    assert.ok(builders.length > 0, `${label} (${module}) builds no params — has the anchor moved?`);
    assert.equal(
      selectors.length,
      builders.length,
      `${label} (${module}) builds ${builders.length} param objects from a task `
      + `but forwards the backend selector in ${selectors.length} of them`,
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
