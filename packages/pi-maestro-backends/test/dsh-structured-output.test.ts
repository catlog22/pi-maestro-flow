import assert from "node:assert/strict";
import test from "node:test";
import type { BackendRunOptions } from "pi-maestro-backend-core/v1/backend";
import { createDshBackend } from "pi-maestro-backends/dsh";
import {
  extractJsonValue,
  resolveStructuredOutput,
} from "pi-maestro-backends/dsh/structured-output";

/**
 * Structured output, emulated on a runtime with no schema parameter.
 *
 * The host interpolates `structuredOutput` into a downstream task's prompt and
 * validates nothing itself, so a value that reaches it unvalidated becomes
 * another agent's instructions. These pin both halves: what counts as a value,
 * and what happens when the run cannot produce one.
 */

const SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string" }, score: { type: "number" } },
  required: ["verdict", "score"],
} as Record<string, unknown>;

const CONFIG = { command: "dsh-jsonrpc-agent", cordisConfig: "/etc/dsh/cordis.yml" };

function options(): BackendRunOptions {
  return { correlationId: "c-1", baseCwd: "/work", host: {}, config: CONFIG };
}

const SPEC = { agent: "general", task: "judge it", outputSchema: SCHEMA };

/** A driver returning a scripted final message per turn. */
function scripted(responses: readonly string[]) {
  const prompts: string[] = [];
  let turn = 0;
  return {
    prompts,
    driver: {
      async run(input: string) {
        prompts.push(input);
        return {
          sessionId: "s",
          finalResponse: responses[Math.min(turn++, responses.length - 1)] ?? "",
          events: [{ type: "turn/end" }],
        };
      },
      async close() {},
    },
  };
}

test("a bare JSON value is accepted", () => {
  const outcome = resolveStructuredOutput('{"verdict":"ok","score":1}', SCHEMA);
  assert.equal(outcome.status, "valid");
  assert.deepEqual((outcome as { value: unknown }).value, { verdict: "ok", score: 1 });
});

test("a value wrapped in prose or a fence is still found", () => {
  // Models routinely add both; refusing them would fail runs whose answer was
  // correct.
  assert.deepEqual(extractJsonValue('Here you go:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonValue('Result: {"a":1} — done'), { a: 1 });
  assert.deepEqual(extractJsonValue("[1,2]"), [1, 2]);
});

test("a final message with no JSON is reported, not guessed at", () => {
  const outcome = resolveStructuredOutput("I could not determine a verdict.", SCHEMA);
  assert.equal(outcome.status, "invalid");
  assert.match((outcome as { failure: string }).failure, /contained no JSON value/);
});

test("a JSON value that misses the schema names where", () => {
  const outcome = resolveStructuredOutput('{"verdict":"ok"}', SCHEMA);
  assert.equal(outcome.status, "invalid");
  assert.match((outcome as { failure: string }).failure, /does not match the schema/);
});

test("a schema the validator does not recognise accepts the value, as it does for Pi", () => {
  // The validator reports no failure for an unrecognised schema rather than
  // throwing. Tightening that here would make the same task pass on the Pi
  // backend and fail on this one, which is a worse answer than matching.
  assert.equal(resolveStructuredOutput('{"a":1}', { type: "not-a-type" }).status, "valid");
  assert.equal(resolveStructuredOutput('{"a":1}', {}).status, "valid");
});

test("the schema is appended to the prompt so the model is told what to return", async () => {
  const script = scripted(['{"verdict":"ok","score":1}']);
  const backend = createDshBackend(async () => script.driver);
  await (await backend.start(SPEC, options())).outcome;
  assert.match(script.prompts[0]!, /judge it/);
  assert.match(script.prompts[0]!, /must be exactly one JSON value/);
  assert.match(script.prompts[0]!, /"required":\["verdict","score"\]/);
});

test("a valid value settles the run and is carried on the result", async () => {
  const script = scripted(['{"verdict":"ship","score":0.9}']);
  const backend = createDshBackend(async () => script.driver);
  const outcome = await (await backend.start(SPEC, options())).outcome;
  assert.equal(outcome.result.terminalStatus, "completed");
  assert.deepEqual(outcome.result.structuredOutput, { verdict: "ship", score: 0.9 });
});

test("a first miss gets one recovery turn quoting what was wrong", async () => {
  const script = scripted(["no idea", '{"verdict":"ship","score":0.5}']);
  const backend = createDshBackend(async () => script.driver);
  const outcome = await (await backend.start(SPEC, options())).outcome;
  assert.equal(script.prompts.length, 2);
  assert.match(script.prompts[1]!, /did not satisfy the required JSON Schema/);
  assert.equal(outcome.result.terminalStatus, "completed");
  assert.deepEqual(outcome.result.structuredOutput, { verdict: "ship", score: 0.5 });
});

test("a second miss fails the task instead of settling with nothing to interpolate", async () => {
  const script = scripted(["still no", "nope"]);
  const backend = createDshBackend(async () => script.driver);
  const outcome = await (await backend.start(SPEC, options())).outcome;
  // A downstream sibling reading {name.field} would otherwise read undefined
  // from a run the transcript called successful.
  assert.equal(outcome.result.terminalStatus, "failed");
  assert.equal(outcome.result.exitCode, 1);
  assert.equal(outcome.result.structuredOutput, undefined);
  assert.match(outcome.result.warnings?.[0] ?? "", /structured output was requested but/);
});

test("recovery is bounded at one turn", async () => {
  const script = scripted(["no", "no", "no"]);
  const backend = createDshBackend(async () => script.driver);
  await (await backend.start(SPEC, options())).outcome;
  // Looping would spend turns on a model that cannot satisfy the schema.
  assert.equal(script.prompts.length, 2);
});

test("a task with no schema is untouched by any of this", async () => {
  const script = scripted(["plain answer"]);
  const backend = createDshBackend(async () => script.driver);
  const outcome = await (await backend.start({ agent: "general", task: "hi" }, options())).outcome;
  assert.equal(script.prompts[0], "hi");
  assert.equal(outcome.result.terminalStatus, "completed");
  assert.equal(outcome.result.structuredOutput, undefined);
});
