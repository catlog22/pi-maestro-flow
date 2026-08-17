import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
  LocalObserveParams,
  LocalTeammateListParams,
  ObserveParams,
  RemoteWorkerParams,
  TeammateListParams,
  TeammateMonitorParams,
  TeammateParams,
  TeammateSendParams,
  TeammateWatchParams,
  WorkspaceWindowParams,
} from "../src/extension/schemas.ts";
import { TEAMMATE_MONITOR_DESCRIPTION } from "../src/extension/teammate-core.ts";
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

test("schema accepts a dedicated positive concurrency wait window", () => {
  assert.equal(Check(TeammateParams, {
    tasks: [{ prompt: "one" }, { prompt: "two" }],
    concurrencyWaitMs: 1,
  }), true);
  assert.equal(Check(TeammateParams, {
    tasks: [{ prompt: "one" }, { prompt: "two" }],
    concurrencyWaitMs: 30_000,
  }), true);
  assert.equal(Check(TeammateParams, {
    tasks: [{ prompt: "one" }, { prompt: "two" }],
    concurrencyWaitMs: 0,
  }), false);
  assert.equal(Check(TeammateParams, {
    tasks: [{ prompt: "one" }, { prompt: "two" }],
    concurrencyWaitMs: 1.5,
  }), false);
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

test("teammate-send accepts typed cross-session message kinds", () => {
  for (const kind of ["coordination", "request", "status", "supervision"] as const) {
    assert.equal(Check(TeammateSendParams, { to: "owner:abc", message: "hi", kind }), true);
  }
  assert.equal(Check(TeammateSendParams, { to: "owner:abc", message: "hi", kind: "instruction" }), false);
});

test("local teammate list schema excludes cross-window views", () => {
  for (const view of ["active", "named", "all", "roles"] as const) {
    assert.equal(Check(LocalTeammateListParams, { view }), true);
  }
  assert.equal(Check(LocalTeammateListParams, { view: "windows" }), false);
  assert.equal(Check(LocalTeammateListParams, { view: "inbox" }), false);
  assert.equal(Check(LocalTeammateListParams, { view: "active", peer: "owner:abc" }), false);

  assert.equal(Check(TeammateListParams, { view: "windows" }), true);
  assert.equal(Check(TeammateListParams, { view: "inbox", limit: 10 }), true);
});

test("local observe schema accepts only local provider kinds", () => {
  for (const kind of ["teammate", "bash_bg"] as const) {
    assert.equal(Check(LocalObserveParams, {
      action: "status",
      targets: [{ kind, id: "worker" }],
    }), true);
  }
  for (const kind of ["workspace", "remote", "workspace-alias", "custom-provider"] as const) {
    assert.equal(Check(LocalObserveParams, {
      action: "status",
      targets: [{ kind, id: "worker" }],
    }), false);
  }
});

test("observe schema scopes wait parameters to wait and requires count thresholds", () => {
  const target = [{ kind: "teammate", id: "worker" }];
  assert.equal(Check(ObserveParams, { action: "status", targets: target }), true);
  assert.equal(Check(ObserveParams, { action: "status", targets: target, timeoutMs: 100 }), false);
  assert.equal(Check(ObserveParams, { action: "watch", targets: target, timeoutMs: 100 }), true);
  assert.equal(Check(ObserveParams, { action: "watch", targets: target, until: "completed" }), false);
  assert.equal(Check(ObserveParams, { action: "wait", targets: target, until: "completed" }), true);
  assert.equal(Check(ObserveParams, { action: "wait", waitMode: "count", targets: target }), false);
  assert.equal(Check(ObserveParams, { action: "wait", waitMode: "count", waitCount: 1, targets: target }), true);
  assert.equal(Check(ObserveParams, { action: "wait", waitCount: 1, targets: target }), false);
});

test("observe schema accepts view=turns with turn and rejects misuse", () => {
  const target = [{ kind: "teammate", id: "worker" }];
  assert.equal(Check(ObserveParams, { action: "status", targets: target, view: "turns" }), true);
  assert.equal(Check(ObserveParams, { action: "status", targets: target, view: "turns", turn: 2 }), true);
  assert.equal(Check(ObserveParams, { action: "status", targets: target, view: "live" }), true);
  assert.equal(Check(ObserveParams, { action: "wait", targets: target, view: "turns" }), false);
  assert.equal(Check(ObserveParams, { action: "watch", targets: target, view: "turns" }), false);
  assert.equal(Check(ObserveParams, { action: "status", targets: target, turn: 1 }), false);
  assert.equal(Check(ObserveParams, { action: "status", targets: target, view: "live", turn: 1 }), false);
  assert.equal(Check(ObserveParams, { action: "status", targets: target, view: "other" }), false);
  assert.equal(Check(ObserveParams, { action: "status", targets: target, turn: 0 }), false);
});

test("legacy observation descriptions use consistent expanded-output terminology", () => {
  const watchLines = TeammateWatchParams.properties.lines as unknown as { default?: number };
  const detail = ObserveParams.properties.detail as unknown as { description?: string };
  const verbose = TeammateMonitorParams.properties.verbose as unknown as { description?: string };
  assert.equal(watchLines.default, 20);
  assert.match(detail.description ?? "", /compatibility alias/);
  assert.match(verbose.description ?? "", /expanded output/);
  assert.doesNotMatch(verbose.description ?? "", /watch output/);
  assert.match(TEAMMATE_MONITOR_DESCRIPTION, /verbose=true for expanded output/);
  assert.match(TEAMMATE_MONITOR_DESCRIPTION, /no watch action, until threshold, or detail parameter/);
});

test("workspace-window schema scopes lifecycle fields to their actions", () => {
  assert.equal(Check(WorkspaceWindowParams, { action: "list" }), true);
  assert.equal(Check(WorkspaceWindowParams, { action: "create", name: "backend", objective: "Build API" }), true);
  assert.equal(Check(WorkspaceWindowParams, { action: "create", name: "backend", objective: "Build API", presentation: "headless" }), true);
  assert.equal(Check(WorkspaceWindowParams, { action: "close", name: "backend" }), true);

  assert.equal(Check(WorkspaceWindowParams, { action: "create", name: "backend" }), false);
  assert.equal(Check(WorkspaceWindowParams, { action: "close" }), false);
  assert.equal(Check(WorkspaceWindowParams, { action: "list", objective: "unexpected" }), false);
  assert.equal(Check(WorkspaceWindowParams, { action: "close", presentation: "interactive", name: "backend" }), false);
  assert.equal(Check(WorkspaceWindowParams, { action: "create", name: "bad name", objective: "Build API" }), false);
  assert.equal(Check(WorkspaceWindowParams, { action: "create", name: "backend", objective: "Build API", presentation: "other" }), false);
});

test("remote-worker schema scopes configured targets, creation, and owner-fenced close", () => {
  assert.equal("target" in RemoteWorkerParams.properties, false);
  assert.equal(Check(RemoteWorkerParams, { action: "targets" }), true);
  assert.equal(Check(RemoteWorkerParams, { action: "list" }), true);
  assert.equal(Check(RemoteWorkerParams, {
    action: "create",
    targetId: "linux/pi",
    name: "review",
    objective: "Review API",
  }), true);
  assert.equal(Check(RemoteWorkerParams, { action: "close", runId: "remote:run-1234" }), true);

  assert.equal(Check(RemoteWorkerParams, { action: "create", name: "review", objective: "Review API" }), false);
  assert.equal(Check(RemoteWorkerParams, { action: "close", runId: "run-1234" }), false);
  assert.equal(Check(RemoteWorkerParams, { action: "list", targetId: "linux/pi" }), false);
  assert.equal(Check(RemoteWorkerParams, { action: "targets", runId: "remote:run-1234" }), false);
  assert.equal(Check(RemoteWorkerParams, { action: "create", targetId: "bad target", name: "review", objective: "Review API" }), false);
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
  assert.match(findStructuredOutputSchemaHazard({ type: "string" }) ?? "", /root must be a single type:"object" schema/);
  assert.match(findStructuredOutputSchemaHazard({ anyOf: [{ type: "object" }] }) ?? "", /root must not use "anyOf"/);
  assert.match(findStructuredOutputSchemaHazard({ oneOf: [{ type: "object" }] }) ?? "", /root must not use "anyOf"/);
  assert.equal(findStructuredOutputSchemaHazard({ type: "object", properties: {} }), undefined);
});

test("findStructuredOutputSchemaHazard accepts type+enum on nested properties", () => {
  // The common analyst-style schema: a typed enum inside properties must pass
  // preflight — the runtime validator (TypeBox Compile/Check) accepts it.
  assert.equal(
    findStructuredOutputSchemaHazard({
      type: "object",
      properties: { status: { type: "string", enum: ["ok", "fail"] } },
      required: ["status"],
    }),
    undefined,
  );
  assert.equal(
    findStructuredOutputSchemaHazard({
      type: "object",
      properties: { status: { type: ["string", "null"], enum: ["ok", null] } },
      required: ["status"],
    }),
    undefined,
  );
});

test("findStructuredOutputSchemaHazard rejects a root type+enum with actionable guidance", () => {
  const message = findStructuredOutputSchemaHazard({ type: "string", enum: ["a", "b"] }) ?? "";
  assert.match(message, /root must be a single type:"object" schema \(got "string" with "enum"\)/);
  assert.match(message, /"properties": \{ "value"/);
  assert.match(message, /"required": \["value"\]/);
  assert.match(
    findStructuredOutputSchemaHazard({ type: ["string", "null"], enum: ["a", null] }) ?? "",
    /root must be a single type:"object" schema/,
  );
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
// The public parameter schema keeps the dominant call shape small: tasks and
// each task's prompt are required, while outputSchema is an optional opaque
// object. Detailed JSON Schema checks remain in dispatch normalization, which
// can return field-specific diagnostics.
// ---------------------------------------------------------------------------

test("parameter schema keeps outputSchema optional for ordinary tasks", () => {
  assert.deepEqual(TeammateParams.required, ["tasks"]);
  assert.deepEqual(TeammateParams.properties.tasks.items.required, ["prompt"]);
  assert.equal(Check(TeammateParams, {
    tasks: [{ prompt: "work" }],
  }), true);
  assert.equal(Check(TeammateParams, {
    tasks: [{ prompt: "work", outputSchema: { type: "object" } }],
  }), true);
  assert.equal(Check(TeammateParams, {
    outputSchema: { type: "object" },
    tasks: [{ prompt: "work" }],
  }), true);
});

test("parameter schema keeps outputSchema compact and object-valued", () => {
  const taskOutputSchema = TeammateParams.properties.tasks.items.properties.outputSchema as unknown as Record<string, unknown>;
  const topOutputSchema = TeammateParams.properties.outputSchema as unknown as Record<string, unknown>;
  assert.equal(taskOutputSchema.type, "object");
  assert.equal(topOutputSchema.type, "object");
  assert.equal("properties" in taskOutputSchema, false);
  assert.equal("properties" in topOutputSchema, false);
  assert.equal(Check(TeammateParams, {
    tasks: [{ prompt: "work", outputSchema: "not-an-object" }],
  }), false);
  assert.equal(Check(TeammateParams, {
    outputSchema: "not-an-object",
    tasks: [{ prompt: "work" }],
  }), false);
});

test("parameter admission defers detailed outputSchema checks to runtime preflight", () => {
  assert.equal(Check(TeammateParams, {
    tasks: [{ prompt: "work", outputSchema: { properties: { result: { type: "string" } } } }],
  }), true);
  assert.equal(Check(TeammateParams, {
    tasks: [{ prompt: "work", outputSchema: { type: "object", properties: "nope" } }],
  }), true);
  assert.equal(Check(TeammateParams, {
    tasks: [{ prompt: "work", outputSchema: { type: "object", required: "result" } }],
  }), true);
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
