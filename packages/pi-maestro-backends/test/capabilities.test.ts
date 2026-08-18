import assert from "node:assert/strict";
import test from "node:test";
import type { BackendCapabilities } from "pi-maestro-backend-core/v1/backend";
import {
  adjudicateTask,
  requiredCapabilities,
  validateBackendCapabilities,
  type AdjudicatedTask,
} from "pi-maestro-backends";

const PI: BackendCapabilities = {
  outputSchema: "native",
  forkContext: "native",
  modelSelection: "native",
  thinkingLevel: "native",
  todoBinding: "native",
  toolFilter: "native",
  steer: "native",
  followUp: "native",
  abort: "native",
};

const DSH: BackendCapabilities = {
  outputSchema: "emulated",
  forkContext: "unsupported",
  modelSelection: "native",
  thinkingLevel: "unsupported",
  todoBinding: "emulated",
  toolFilter: "unsupported",
  steer: "emulated",
  followUp: "native",
  abort: "emulated",
};

function task(spec: AdjudicatedTask["spec"], rest: Omit<AdjudicatedTask, "spec"> = {}): AdjudicatedTask {
  return { spec, ...rest };
}

const BARE = { agent: "general", task: "do the thing" };

test("a task requires only what it asked for", () => {
  assert.deepEqual(requiredCapabilities(task(BARE)), []);
});

test("every orchestrator-visible request maps to one capability", () => {
  const required = requiredCapabilities(task(
    { ...BARE, outputSchema: {}, context: "fork", model: "m", thinking: "high", todos: ["t1"] },
  ));
  // `toolFilter`, `steer`, and `followUp` are absent by construction: no spec
  // field asks for a tool filter, and whether a task will be steered is not
  // knowable until the model sends the message.
  assert.deepEqual(required, [
    "outputSchema",
    "forkContext",
    "modelSelection",
    "thinkingLevel",
    "todoBinding",
  ]);
});

test("a control mode is not adjudicated up front, so an addressable task is not rejected", () => {
  // DSH steers only by emulation and cannot filter tools; neither shows up as a
  // requirement, because requiring them would reject a task over a message that
  // may never be sent.
  const verdict = adjudicateTask(task(BARE), 0, "dsh", DSH);
  assert.deepEqual(verdict.unsupported, []);
  assert.deepEqual(verdict.emulated, []);
});

test("an empty todo list is not a todo binding request", () => {
  assert.deepEqual(requiredCapabilities(task({ ...BARE, todos: [] })), []);
});

test("a fully native backend produces no errors and no warnings", () => {
  const result = validateBackendCapabilities(
    [task({ ...BARE, outputSchema: {}, context: "fork" })],
    () => ({ name: "pi-subprocess", capabilities: PI }),
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test("unsupported rejects the graph and the message names task, capability, and backend", () => {
  const result = validateBackendCapabilities(
    [task({ ...BARE, thinking: "high" }, { name: "analyse" })],
    () => ({ name: "dsh", capabilities: DSH }),
  );
  assert.equal(result.errors.length, 1);
  assert.equal(
    result.errors[0],
    'task #1 ("analyse") requires "thinkingLevel", which backend "dsh" does not support',
  );
});

test("fork degrades with a warning instead of rejecting the graph", () => {
  const result = validateBackendCapabilities(
    [task({ ...BARE, context: "fork" })],
    () => ({ name: "dsh", capabilities: DSH }),
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /requested "forkContext"/);
  assert.match(result.warnings[0]!, /transcript records the degradation/);
  assert.deepEqual(result.verdicts[0]?.degraded, ["forkContext"]);
});

test("emulated capabilities warn and are recorded, never silent", () => {
  const result = validateBackendCapabilities(
    [task({ ...BARE, outputSchema: {}, todos: ["t1"] })],
    () => ({ name: "dsh", capabilities: DSH }),
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.verdicts[0]?.emulated, ["outputSchema", "todoBinding"]);
  assert.equal(result.warnings.length, 2);
});

test("each task is adjudicated against its own backend", () => {
  const result = validateBackendCapabilities(
    [
      task({ ...BARE, thinking: "high" }, { name: "on-pi" }),
      task({ ...BARE, thinking: "high" }, { name: "on-dsh" }),
    ],
    (_t, index) => index === 0
      ? { name: "pi-subprocess", capabilities: PI }
      : { name: "dsh", capabilities: DSH },
  );
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /task #2 \("on-dsh"\)/);
});

test("an unnamed task is still identified by position", () => {
  const result = validateBackendCapabilities(
    [task(BARE), task({ ...BARE, toolFilter: undefined, thinking: "low" })],
    () => ({ name: "dsh", capabilities: DSH }),
  );
  assert.match(result.errors[0]!, /^task #2 requires "thinkingLevel"/);
});
