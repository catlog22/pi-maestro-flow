import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
  TeammateParams,
  TeammateSendParams,
} from "../src/extension/schemas.ts";
import {
  MAX_DEFAULT_DEPTH,
  describeStructuredOutputValidationFailure,
  describeStructuredOutputValueValidationFailure,
  findStructuredOutputSchemaHazard,
  validateStructuredOutputValue,
} from "../src/runs/execution-infra.ts";

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
  assert.match(findStructuredOutputSchemaHazard({ type: "object", properties: [] }) ?? "", /"properties" value that is not an object/);
  assert.match(
    findStructuredOutputSchemaHazard({
      type: "object",
      properties: { nested: { type: "object", properties: [] } },
    }) ?? "",
    /\/properties\/nested.*"properties" value that is not an object/,
  );
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

test("findStructuredOutputSchemaHazard rejects invalid type values", () => {
  assert.match(findStructuredOutputSchemaHazard({ type: "objct", properties: {} }) ?? "", /invalid "type"/);
  assert.match(findStructuredOutputSchemaHazard({ type: ["object", "arrayy"] }) ?? "", /invalid "type"/);
});

test("findStructuredOutputSchemaHazard accepts supported items forms", () => {
  assert.equal(
    findStructuredOutputSchemaHazard({ type: "object", properties: { xs: { type: "array" } } }),
    undefined,
  );
  assert.equal(
    findStructuredOutputSchemaHazard({ type: "object", properties: { xs: { type: "array", items: { type: "string" } } } }),
    undefined,
  );
  assert.equal(
    findStructuredOutputSchemaHazard({ type: "object", properties: { xs: { type: "array", items: false } } }),
    undefined,
  );
  assert.equal(
    findStructuredOutputSchemaHazard({ type: "object", properties: { xs: { type: "array", items: [{ type: "string" }, { type: "number" }] } } }),
    undefined,
  );
  // JSON Schema ignores an inapplicable keyword; preflight must not reject a
  // schema shape that the runtime validator accepts.
  assert.equal(
    findStructuredOutputSchemaHazard({ type: "object", properties: { xs: { type: "object", items: { type: "string" } } } }),
    undefined,
  );
  assert.match(
    findStructuredOutputSchemaHazard({ type: "object", properties: { xs: { type: "array", items: "invalid" } } }) ?? "",
    /"items" value that is not a schema/,
  );
});

test("findStructuredOutputSchemaHazard rejects malformed enum values", () => {
  assert.match(
    findStructuredOutputSchemaHazard({ type: "object", properties: { status: { type: "string", enum: "x" } } }) ?? "",
    /"enum".*not a non-empty array/,
  );
  assert.match(
    findStructuredOutputSchemaHazard({ type: "object", properties: { status: { type: "string", enum: [] } } }) ?? "",
    /"enum".*not a non-empty array/,
  );
  assert.equal(
    findStructuredOutputSchemaHazard({ type: "object", properties: { status: { type: "string", enum: ["a", "b"] } } }),
    undefined,
  );
});

test("findStructuredOutputSchemaHazard enforces the object-root contract", () => {
  assert.match(findStructuredOutputSchemaHazard({}) ?? "", /must declare type "object"/);
  assert.match(findStructuredOutputSchemaHazard({ type: "string" }) ?? "", /root must be type "object"/);
  assert.match(findStructuredOutputSchemaHazard({ anyOf: [{ type: "object" }] }) ?? "", /root must not use "anyOf"/);
  assert.match(findStructuredOutputSchemaHazard({ oneOf: [{ type: "object" }] }) ?? "", /root must not use "anyOf"/);
  assert.equal(findStructuredOutputSchemaHazard({ type: "object", properties: {} }), undefined);
});

test("findStructuredOutputSchemaHazard flags only a root task-text prompt key", () => {
  assert.match(
    findStructuredOutputSchemaHazard({ type: "object", prompt: "PURPOSE: task text" }) ?? "",
    /task-text "prompt" key/,
  );
  assert.equal(
    findStructuredOutputSchemaHazard({
      type: "object",
      properties: { value: { type: "string", prompt: "provider annotation" } },
    }),
    undefined,
  );
});

test("event and persisted-value validation share the same field-level diagnostic", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  };
  const value = { ok: "not-a-boolean" };
  const fromValue = describeStructuredOutputValueValidationFailure(value, schema);
  const fromEvent = describeStructuredOutputValidationFailure({
    message: {
      content: [{ type: "toolCall", name: "structured_output", arguments: value }],
    },
  }, schema);
  assert.equal(fromEvent, fromValue);
  assert.match(fromValue ?? "", /validation failed at \/ok/);
  assert.match(fromValue ?? "", /schema=/);
});

// ---------------------------------------------------------------------------
// The public parameter schema prevents the two recurrent generative mistakes:
// omitting the task-level prompt and supplying a non-object-root output schema.
// Dispatch normalization remains a second line of defense for programmatic and
// compatibility callers that do not enter through TypeBox admission.
// ---------------------------------------------------------------------------

test("parameter schema requires a task-level prompt", () => {
  assert.equal(Check(TeammateParams, {
    tasks: [{ name: "audit", outputSchema: { type: "object", prompt: "PURPOSE: mislocated" } }],
  }), false);
  assert.equal(Check(TeammateParams, {
    tasks: [{ name: "audit", prompt: "work", outputSchema: { type: "object" } }],
  }), true);
});

test("parameter schema requires object-root output schemas at both levels", () => {
  assert.equal(Check(TeammateParams, {
    tasks: [{ prompt: "work", outputSchema: { properties: { result: { type: "string" } } } }],
  }), false);
  assert.equal(Check(TeammateParams, {
    outputSchema: { type: "string" },
    tasks: [{ prompt: "work" }],
  }), false);
  assert.equal(Check(TeammateParams, {
    outputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"] },
    tasks: [{ prompt: "work" }],
  }), true);
});

test("parameter schema validates common root keyword shapes", () => {
  assert.equal(Check(TeammateParams, {
    tasks: [{ prompt: "work", outputSchema: { type: "object", properties: "nope" } }],
  }), false);
  assert.equal(Check(TeammateParams, {
    tasks: [{ prompt: "work", outputSchema: { type: "object", required: "result" } }],
  }), false);
  assert.equal(Check(TeammateParams, {
    tasks: [{ prompt: "work", outputSchema: { type: "object", required: ["result", "result"] } }],
  }), false);
});

test("parameter admission and value validation support boolean and tuple items", () => {
  const booleanItems = {
    type: "object",
    properties: { empty: { type: "array", items: false } },
    required: ["empty"],
  };
  const tupleItems = {
    type: "object",
    properties: { pair: { type: "array", items: [{ type: "string" }, { type: "number" }] } },
    required: ["pair"],
  };
  assert.equal(Check(TeammateParams, {
    tasks: [{ prompt: "work", outputSchema: booleanItems }],
  }), true);
  assert.equal(Check(TeammateParams, {
    tasks: [{ prompt: "work", outputSchema: tupleItems }],
  }), true);
  assert.equal(validateStructuredOutputValue({ empty: [] }, booleanItems), true);
  assert.equal(validateStructuredOutputValue({ empty: ["blocked"] }, booleanItems), false);
  assert.equal(validateStructuredOutputValue({ pair: ["id", 1] }, tupleItems), true);
  assert.equal(validateStructuredOutputValue({ pair: [1, "id"] }, tupleItems), false);
});

test("a result field named prompt remains valid under properties", () => {
  assert.equal(Check(TeammateParams, {
    tasks: [{ prompt: "work", outputSchema: { type: "object", properties: { prompt: { type: "string" } } } }],
  }), true);
});
