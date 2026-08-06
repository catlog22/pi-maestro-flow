import assert from "node:assert/strict";
import test from "node:test";
import { Check, Value } from "typebox/value";
import {
  TeammateParams,
  TeammateSendParams,
} from "../src/extension/schemas.ts";
import { MAX_DEFAULT_DEPTH } from "../src/runs/execution-infra.ts";
import { findStructuredOutputSchemaHazard } from "../src/runs/execution-infra.ts";

// ---------------------------------------------------------------------------
// maxNestingDepth bounds (P1/B1): schema rejects out-of-range values at the
// parameter layer instead of failing only at normalize/runtime.
// ---------------------------------------------------------------------------

test("schema bounds maxNestingDepth to 0..MAX_DEFAULT_DEPTH at top level and per task", () => {
  for (const value of [0, 1, MAX_DEFAULT_DEPTH]) {
    assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work" }], maxNestingDepth: value }), true);
    assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work", maxNestingDepth: value }] }), true);
  }
  for (const value of [-1, MAX_DEFAULT_DEPTH + 1, 99]) {
    assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work" }], maxNestingDepth: value }), false);
    assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work", maxNestingDepth: value }] }), false);
  }
});

test("schema maxNestingDepth maximum stays in sync with MAX_DEFAULT_DEPTH", () => {
  // TOptional<TInteger> hides the bounds at the type level; read them from the
  // runtime schema where TypeBox keeps the merged integer keywords.
  const readBounds = (node: unknown): { minimum?: number; maximum?: number } =>
    node as { minimum?: number; maximum?: number };
  const top = readBounds(TeammateParams.properties.maxNestingDepth);
  const task = readBounds(TeammateParams.properties.tasks.items.properties.maxNestingDepth);
  assert.equal(top.maximum, MAX_DEFAULT_DEPTH);
  assert.equal(task.maximum, MAX_DEFAULT_DEPTH);
  assert.equal(top.minimum, 0);
  assert.equal(task.minimum, 0);
});

test("schema accepts an optional per-task todo binding and rejects non-string values", () => {
  assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work", todo: "#12" }] }), true);
  assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work", todo: "7" }] }), true);
  assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work" }] }), true);
  assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work", todo: "" }] }), false);
  assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work", todo: 12 }] }), false);
});

// ---------------------------------------------------------------------------
// teammate-send message contract (P1/B4): message required unless mode is
// explicitly "abort"; a missing mode defaults to follow_up and still demands
// a message.
// ---------------------------------------------------------------------------

test("teammate-send requires message for steer/follow_up and default mode", () => {
  assert.equal(Check(TeammateSendParams, { to: "a", mode: "steer", message: "hi" }), true);
  assert.equal(Check(TeammateSendParams, { to: "a", mode: "steer" }), false);
  assert.equal(Check(TeammateSendParams, { to: "a", message: "hi" }), true);
  assert.equal(Check(TeammateSendParams, { to: "a" }), false);
});

test("teammate-send allows omitting message only for explicit abort", () => {
  assert.equal(Check(TeammateSendParams, { to: "a", mode: "abort" }), true);
  assert.equal(Check(TeammateSendParams, { to: "a", mode: "abort", message: "bye" }), true);
  assert.equal(Check(TeammateSendParams, { to: "a", mode: "unknown" }), false);
});

// ---------------------------------------------------------------------------
// outputSchema upfront consistency checks (P1/B3): keyword typos and
// unsatisfiable required/properties combinations fail at dispatch instead of
// silently validating weaker (or never) in the child.
// ---------------------------------------------------------------------------

const validStrictSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    items: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  },
  required: ["summary", "items"],
};

test("findStructuredOutputSchemaHazard accepts valid strict schemas", () => {
  assert.equal(findStructuredOutputSchemaHazard(validStrictSchema), undefined);
});

test("findStructuredOutputSchemaHazard rejects unsatisfiable required under additionalProperties:false", () => {
  const hazard = findStructuredOutputSchemaHazard({
    type: "object",
    additionalProperties: false,
    properties: { summary: { type: "string" } },
    required: ["summary", "missing"],
  });
  assert.match(hazard ?? "", /required property "missing".*can never validate/);
  // Without additionalProperties:false a required key may still be present —
  // the schema is loose but not unsatisfiable.
  assert.equal(findStructuredOutputSchemaHazard({
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["missing"],
  }), undefined);
});

test("findStructuredOutputSchemaHazard rejects misspelled keywords", () => {
  assert.match(findStructuredOutputSchemaHazard({ type: "object", require: ["summary"] }) ?? "", /misspelled keyword "require"/);
  assert.match(findStructuredOutputSchemaHazard({ type: "object", requried: ["summary"] }) ?? "", /misspelled keyword "requried"/);
  assert.match(findStructuredOutputSchemaHazard({ type: "object", propterties: { summary: { type: "string" } } }) ?? "", /misspelled keyword "propterties"/);
  assert.match(findStructuredOutputSchemaHazard({ type: "object", additionalproperty: false }) ?? "", /misspelled keyword "additionalproperty"/);
});

test("findStructuredOutputSchemaHazard rejects malformed properties and required values", () => {
  assert.match(findStructuredOutputSchemaHazard({ type: "object", properties: "nope" }) ?? "", /"properties" value that is not an object/);
  assert.match(findStructuredOutputSchemaHazard({ type: "object", required: "summary" }) ?? "", /"required" value that is not an array/);
  assert.match(findStructuredOutputSchemaHazard({ type: "object", required: [42] }) ?? "", /"required" value that is not an array/);
});

test("findStructuredOutputSchemaHazard does not flag keyword-looking keys inside data nodes", () => {
  // A property literally named "require" and a default payload are data, not
  // schema keywords — no false positive.
  const schema = {
    type: "object",
    properties: {
      require: { type: "string" },
      meta: { type: "object", default: { require: true, requried: false } },
    },
  };
  assert.equal(findStructuredOutputSchemaHazard(schema), undefined);
});

test("findStructuredOutputSchemaHazard still rejects catastrophic pattern shapes", () => {
  assert.match(
    findStructuredOutputSchemaHazard({ type: "string", pattern: "^(a+)+$" }) ?? "",
    /catastrophic backtracking/,
  );
});

// ---------------------------------------------------------------------------
// Misplaced prompt guard: a task text embedded inside outputSchema is rejected
// at the parameter layer with a precise path (tasks.N.outputSchema.prompt)
// instead of the misleading "tasks.N.prompt missing".
// ---------------------------------------------------------------------------

test("schema rejects a string prompt embedded inside task outputSchema", () => {
  const task = {
    prompt: "work",
    outputSchema: {
      type: "object",
      properties: { summary: { type: "string" } },
      prompt: "PURPOSE: the real task text was mislocated here",
    },
  };
  assert.equal(Check(TeammateParams, { tasks: [task] }), false);
  const errors = [...Value.Errors(TeammateParams, { tasks: [task] })].map(
    (e: { instancePath?: string; message: string }) => `${e.instancePath ?? ""} ${e.message}`,
  );
  // The host formatter (pi-ai formatValidationPath) renders instancePath
  // "/tasks/0/outputSchema/prompt" as "tasks.0.outputSchema.prompt".
  assert.ok(errors.some((m) => /outputSchema\/prompt.*must be object/.test(m)), `expected an outputSchema.prompt error, got: ${errors.join(" | ")}`);
});

test("schema rejects a string prompt embedded inside top-level outputSchema", () => {
  assert.equal(Check(TeammateParams, {
    tasks: [{ prompt: "work" }],
    outputSchema: { type: "object", prompt: "PURPOSE: mislocated" },
  }), false);
});

test("schema accepts prompt as an object-valued JSON Schema key in outputSchema", () => {
  // A schema fragment under "prompt" (object) is legitimate; only a bare
  // task-text string is the mislocation we guard against.
  assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work", outputSchema: { prompt: { type: "string" } } }] }), true);
  assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work", outputSchema: { properties: { prompt: { type: "string" } } } }] }), true);
});
