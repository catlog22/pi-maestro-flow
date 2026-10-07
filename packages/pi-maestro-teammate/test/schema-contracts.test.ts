import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import type { TSchema } from "typebox";
import {
  LocalObserveParams,
  LocalTeammateListParams,
  MonitorQueryParams,
  ObserveParams,
  projectConditionalTeammateTool,
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

test("parallel completion schema distinguishes per-task and aggregate delivery", () => {
  const background = TeammateParams.properties.background as { description?: string };
  assert.match(background.description ?? "", /Foreground calls return one aggregate tool result/);
  assert.match(background.description ?? "", /Independent parallel tasks .* once per task/);
  assert.match(background.description ?? "", /chain and DAG graph calls send one aggregate completion/);
  assert.match(background.description ?? "", /caller AgentSession consumes them only when it would otherwise stop/);
});

// ---------------------------------------------------------------------------
// Gemini-compatible advertised contracts must not change runtime validation.
// The registered execute wrapper guards before any tool implementation runs.
// ---------------------------------------------------------------------------

test("conditional tools advertise no if/then/allOf but retain field constraints", () => {
  for (const [name, schema] of Object.entries({
    "teammate-send": TeammateSendParams,
    "teammate-list": TeammateListParams,
    "observe": ObserveParams,
    "local-observe": LocalObserveParams,
    "monitor": MonitorQueryParams,
    "workspace-window": WorkspaceWindowParams,
    "remote-worker": RemoteWorkerParams,
  })) {
    const projected = projectConditionalTeammateTool({
      name, label: name, description: name, parameters: schema,
      async execute() { return { content: [{ type: "text" as const, text: "executed" }], details: {} }; },
    });
    const advertised = JSON.stringify(projected.parameters);
    assert.doesNotMatch(advertised, /"(?:if|then|allOf)"\s*:/, name);
    assert.notEqual(projected.parameters, schema, name);
    const originalShape = schema as TSchema & { properties?: unknown; required?: unknown; additionalProperties?: unknown };
    const advertisedShape = projected.parameters as typeof originalShape;
    assert.deepEqual(advertisedShape.properties, originalShape.properties, name);
    assert.deepEqual(advertisedShape.required, originalShape.required, name);
    assert.equal(advertisedShape.additionalProperties, false, name);
  }
  const projected = projectConditionalTeammateTool({
    name: "teammate-send", label: "send", description: "send", parameters: TeammateSendParams,
    async execute() { return { content: [{ type: "text" as const, text: "executed" }], details: {} }; },
  });
  assert.equal(Check(projected.parameters, { to: "agent" }), true, "advertised contract is intentionally permissive only for cross-field conditions");
  assert.equal(Check(projected.parameters, { to: 3, mode: "steer" }), false);
  assert.equal(Check(projected.parameters, { to: "agent", mode: "invalid" }), false);
  const advertisedObserve = projectConditionalTeammateTool({
    name: "observe", label: "observe", description: "observe", parameters: LocalObserveParams,
    async execute() { return { content: [], details: {} }; },
  }).parameters;
  assert.equal(Check(advertisedObserve, { action: "status", targets: [] }), false, "minItems stays enforced");
  assert.equal(Check(advertisedObserve, { action: "status", targets: [{ kind: "remote", id: "r" }] }), false, "local target enum stays enforced");
  const advertisedMonitor = projectConditionalTeammateTool({
    name: "monitor", label: "monitor", description: "monitor", parameters: MonitorQueryParams,
    async execute() { return { content: [], details: {} }; },
  }).parameters;
  assert.equal(Check(advertisedMonitor, { action: "wait", timeoutMs: 0 }), false, "numeric bounds stay enforced");
});

test("registered tool guard rejects original conditional violations before side effects", async () => {
  const targets = [{ kind: "teammate", id: "worker" }];
  const cases: Array<{ schema: TSchema; params: unknown }> = [
    { schema: TeammateSendParams, params: { to: "agent" } },
    { schema: TeammateListParams, params: { view: "active", scope: "remote" } },
    { schema: ObserveParams, params: { action: "wait", targets, waitMode: "count" } },
    { schema: LocalObserveParams, params: { action: "status", targets, timeoutMs: 10 } },
    { schema: MonitorQueryParams, params: { action: "wait", timeoutMs: 10 } },
    { schema: WorkspaceWindowParams, params: { action: "create", objective: "work" } },
    { schema: RemoteWorkerParams, params: { action: "create", targetId: "host" } },
  ];
  for (const { schema, params } of cases) {
    let executed = 0;
    const tool = projectConditionalTeammateTool({
      name: "guarded", label: "guarded", description: "guarded", parameters: schema,
      async execute() { executed++; return { content: [{ type: "text" as const, text: "executed" }], details: {} }; },
    });
    const invalid = await tool.execute("call", params as never, undefined, undefined, {} as never);
    assert.equal((invalid as typeof invalid & { isError?: boolean }).isError, true);
    assert.match(invalid.content[0]?.type === "text" ? invalid.content[0].text : "", /Invalid guarded arguments at \/.*:/);
    assert.equal(executed, 0);
  }
  let executed = 0;
  const tool = projectConditionalTeammateTool({
    name: "workspace-window", label: "window", description: "window", parameters: WorkspaceWindowParams,
    async execute() { executed++; return { content: [{ type: "text" as const, text: "executed" }], details: {} }; },
  });
  const valid = await tool.execute("call", { action: "create", name: "worker", objective: "work" }, undefined, undefined, {} as never);
  assert.equal((valid as typeof valid & { isError?: boolean }).isError, undefined);
  assert.equal(executed, 1);
});

test("observe conditional errors explain conflicting fields before side effects", async () => {
  const targets = [{ kind: "teammate", id: "worker" }];
  const workspace = [{ kind: "workspace", id: "owner:worker" }];
  const cases: Array<{ params: Record<string, unknown>; reason: RegExp; monitorOnly?: boolean }> = [];
  for (const action of ["status", "diagnose"]) {
    for (const [field, value] of Object.entries({ timeoutMs: 600000, waitMode: "all", waitCount: 1, until: "completed" })) {
      cases.push({ params: { action, targets, [field]: value }, reason: /omit waitMode, waitCount, until, and timeoutMs/ });
    }
  }
  for (const [field, value] of Object.entries({ waitMode: "all", waitCount: 1, until: "completed" })) {
    cases.push({ params: { action: "watch", targets, [field]: value }, reason: /omit waitMode, waitCount, and until/ });
  }
  cases.push(
    { params: { action: "wait", targets, waitMode: "count" }, reason: /provide waitCount/ },
    { params: { action: "wait", targets, waitCount: 1 }, reason: /waitCount requires action="wait" and waitMode="count"/ },
    { params: { action: "wait", targets, waitMode: "all", waitCount: 1 }, reason: /waitCount requires action="wait" and waitMode="count"/ },
    { params: { action: "status", targets, turn: 1 }, reason: /turn requires view="turns" and action="status"/ },
    { params: { action: "status", targets, view: "live", turn: 1 }, reason: /turn requires view="turns"/ },
  );
  for (const action of ["wait", "watch", "diagnose"]) {
    cases.push({ params: { action, targets, view: "turns" }, reason: /view="turns" requires action="status"/ });
  }
  for (const action of ["wait", "diagnose"]) {
    cases.push(
      { params: { action, targets: workspace, view: "session" }, reason: /view="session" requires action="status" or "watch"/, monitorOnly: true },
      { params: { action, targets: workspace, view: "todos" }, reason: /view="todos" requires action="status" or "watch"/, monitorOnly: true },
    );
  }
  cases.push(
    { params: { action: "status", targets, view: "todos" }, reason: /every target must have kind="workspace"/, monitorOnly: true },
    { params: { action: "status", targets: [...workspace, ...targets], view: "todos" }, reason: /every target must have kind="workspace"/, monitorOnly: true },
    { params: { action: "status", targets: [{ ...workspace[0], cursor: "cursor-1" }] }, reason: /target.cursor requires view="session"/, monitorOnly: true },
  );
  for (const schema of [ObserveParams, LocalObserveParams]) {
    let executed = 0;
    const tool = projectConditionalTeammateTool({
      name: "observe", label: "observe", description: "observe", parameters: schema,
      async execute() { executed++; return { content: [], details: {} }; },
    });
    for (const { params, reason, monitorOnly } of cases) {
      if (monitorOnly && schema === LocalObserveParams) continue;
      assert.equal(Check(tool.parameters, params), true, "flattened schema accepts the field shapes");
      const result = await tool.execute("call", params as never, undefined, undefined, {} as never);
      assert.equal((result as typeof result & { isError?: boolean }).isError, true);
      const message = result.content[0]?.type === "text" ? result.content[0].text : "";
      assert.match(message, reason, JSON.stringify(params));
      assert.doesNotMatch(message, /must match "then" schema/);
      assert.equal(executed, 0);
    }
    const invalidField = await tool.execute("call", { action: "status", targets: [] } as never, undefined, undefined, {} as never);
    assert.match(invalidField.content[0]?.type === "text" ? invalidField.content[0].text : "", /at \/targets: must not have fewer than 1 items/);
  }
});

test("observe guard forwards valid arguments unchanged", async () => {
  const targets = [{ kind: "teammate", id: "worker" }];
  const workspace = [{ kind: "workspace", id: "owner:worker" }];
  const local = [
    { action: "status", targets },
    { action: "diagnose", targets },
    { action: "watch", targets, timeoutMs: 100 },
    { action: "wait", targets, until: "completed", timeoutMs: 100 },
    { action: "wait", targets, waitMode: "count", waitCount: 1 },
    { action: "status", targets, view: "turns", turn: 1 },
  ];
  const monitor = [
    { action: "status", targets: workspace, view: "session" },
    { action: "watch", targets: [{ ...workspace[0], cursor: "cursor-1" }], view: "session", timeoutMs: 100 },
    { action: "status", targets: workspace, view: "todos" },
    { action: "watch", targets: workspace, view: "todos", timeoutMs: 100 },
  ];
  for (const schema of [ObserveParams, LocalObserveParams]) {
    let received: unknown;
    const tool = projectConditionalTeammateTool({
      name: "observe", label: "observe", description: "observe", parameters: schema,
      async execute(_id, params) { received = params; return { content: [], details: {} }; },
    });
    for (const params of [...local, ...(schema === ObserveParams ? monitor : [])]) {
      const result = await tool.execute("call", params as never, undefined, undefined, {} as never);
      assert.equal((result as typeof result & { isError?: boolean }).isError, undefined);
      assert.equal(received, params);
    }
  }
});

test("observe advertised fields preserve conditional usage guidance", () => {
  for (const schema of [ObserveParams, LocalObserveParams]) {
    const advertised = projectConditionalTeammateTool({
      name: "observe", label: "observe", description: "observe", parameters: schema,
      async execute() { return { content: [], details: {} }; },
    }).parameters;
    const fields = (advertised as TSchema & { properties: Record<string, { description?: string }> }).properties;
    assert.match(fields.action.description ?? "", /neither accepts timeoutMs, waitMode, waitCount, or until/);
    assert.match(fields.timeoutMs.description ?? "", /Omit for status and diagnose/);
    assert.match(fields.waitMode.description ?? "", /"count" requires waitCount/);
    assert.match(fields.waitCount.description ?? "", /action="wait" and waitMode="count"/);
    assert.match(fields.until.description ?? "", /Omit for status, diagnose, and watch/);
    assert.match(fields.view.description ?? "", /(?:action="status" only|requires action="status")/);
    assert.match(fields.turn.description ?? "", /requires view="turns" and action="status"/);
  }
});

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
// explicitly "abort"; a missing mode defaults to steer and still demands
// a message.
// ---------------------------------------------------------------------------

test("teammate-send requires message for steer/follow_up and defaults to steer", () => {
  assert.match(JSON.stringify(TeammateSendParams.properties.mode), /"default":"steer"/);
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
  // "status" is a trusted host channel, not model-selectable, so it is not in the kind enum.
  for (const kind of ["coordination", "request", "supervision"] as const) {
    assert.equal(Check(TeammateSendParams, { to: "owner:abc", message: "hi", kind }), true);
  }
  for (const kind of ["status", "instruction"] as const) {
    assert.equal(Check(TeammateSendParams, { to: "owner:abc", message: "hi", kind }), false);
  }
});

test("local teammate list schema excludes cross-window views", () => {
  for (const view of ["active", "named", "all", "roles"] as const) {
    assert.equal(Check(LocalTeammateListParams, { view }), true);
  }
  assert.equal(Check(LocalTeammateListParams, { view: "windows" }), false);
  assert.equal(Check(LocalTeammateListParams, { view: "inbox" }), false);
  assert.equal(Check(LocalTeammateListParams, { view: "active", peer: "owner:abc" }), false);

  assert.equal(Check(TeammateListParams, { view: "windows" }), true);
  for (const scope of ["local", "remote", "all"] as const) {
    assert.equal(Check(TeammateListParams, { view: "windows", scope }), true);
  }
  assert.equal(Check(TeammateListParams, { view: "active", scope: "remote" }), false);
  assert.equal(Check(TeammateListParams, { view: "windows", scope: "other" }), false);
  assert.equal(Check(LocalTeammateListParams, { view: "active", scope: "local" }), false);
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

test("observe schema accepts turns plus workspace session and todos views with scoped cursors", () => {
  const target = [{ kind: "teammate", id: "worker" }];
  const workspace = [{ kind: "workspace", id: "owner:abc" }];
  const cursorTarget = [{ kind: "workspace", id: "owner:abc", cursor: "cursor-1" }];
  assert.equal(Check(ObserveParams, { action: "status", targets: target, view: "turns" }), true);
  assert.equal(Check(ObserveParams, { action: "status", targets: target, view: "turns", turn: 2 }), true);
  assert.equal(Check(ObserveParams, { action: "status", targets: target, view: "live" }), true);
  assert.equal(Check(ObserveParams, { action: "status", targets: workspace, view: "session" }), true);
  assert.equal(Check(ObserveParams, { action: "watch", targets: cursorTarget, view: "session", timeoutMs: 100 }), true);
  assert.equal(Check(ObserveParams, { action: "status", targets: cursorTarget, view: "session" }), true);
  assert.equal(Check(ObserveParams, { action: "status", targets: workspace, view: "todos" }), true);
  assert.equal(Check(ObserveParams, { action: "watch", targets: workspace, view: "todos", timeoutMs: 100 }), true);
  assert.equal(Check(ObserveParams, { action: "wait", targets: workspace, view: "todos" }), false);
  assert.equal(Check(ObserveParams, { action: "diagnose", targets: workspace, view: "todos" }), false);
  assert.equal(Check(ObserveParams, { action: "status", targets: target, view: "todos" }), false);
  assert.equal(Check(ObserveParams, { action: "status", targets: cursorTarget }), false);
  assert.equal(Check(ObserveParams, { action: "wait", targets: workspace, view: "session" }), false);
  assert.equal(Check(ObserveParams, { action: "diagnose", targets: workspace, view: "session" }), false);
  assert.equal(Check(LocalObserveParams, { action: "status", targets: target, view: "session" }), false);
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
  assert.equal(Check(WorkspaceWindowParams, { action: "list", provider: "native" }), false);
  assert.equal(Check(WorkspaceWindowParams, { action: "close", name: "backend", provider: "herdr" }), false);
  assert.equal(Check(WorkspaceWindowParams, { action: "create", name: "bad name", objective: "Build API" }), false);
  assert.equal(Check(WorkspaceWindowParams, { action: "create", name: "backend", objective: "Build API", presentation: "other" }), false);
  assert.equal(Check(WorkspaceWindowParams, {
    action: "create",
    name: "backend",
    objective: "Build API",
    handle: { correlationId: "not-an-input" },
  }), false);
  assert.match((WorkspaceWindowParams.properties.action as { description?: string }).description ?? "", /agent:\/\/ resource/);
});

test("workspace-window schema preserves native defaults and fences Herdr session options", () => {
  const create = { action: "create", name: "backend", objective: "Build API" } as const;
  const provider = WorkspaceWindowParams.properties.provider as unknown as { default?: string };
  const herdrSession = WorkspaceWindowParams.properties.herdrSession as unknown as {
    default?: string;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  };

  assert.equal(provider.default, "native");
  assert.equal(herdrSession.default, "default");
  assert.equal(herdrSession.minLength, 1);
  assert.equal(herdrSession.maxLength, 64);
  assert.equal(Check(WorkspaceWindowParams, create), true, "legacy create shape remains native-compatible");
  assert.equal(Check(WorkspaceWindowParams, { ...create, provider: "native", presentation: "headless" }), true);
  assert.equal(Check(WorkspaceWindowParams, { ...create, provider: "herdr" }), true);
  assert.equal(Check(WorkspaceWindowParams, { ...create, provider: "herdr", presentation: "interactive" }), true);
  assert.equal(Check(WorkspaceWindowParams, { ...create, provider: "herdr", herdrSession: "default-1.alpha" }), true);

  assert.equal(Check(WorkspaceWindowParams, { ...create, provider: "other" }), false);
  assert.equal(Check(WorkspaceWindowParams, { ...create, provider: "herdr", presentation: "headless" }), false);
  assert.equal(Check(WorkspaceWindowParams, { ...create, herdrSession: "default" }), false);
  assert.equal(Check(WorkspaceWindowParams, { ...create, provider: "native", herdrSession: "default" }), false);
  assert.equal(Check(WorkspaceWindowParams, { ...create, provider: "herdr", herdrSession: "" }), false);
  assert.equal(Check(WorkspaceWindowParams, { ...create, provider: "herdr", herdrSession: "unsafe session" }), false);
  assert.equal(Check(WorkspaceWindowParams, { ...create, provider: "herdr", herdrSession: `a${"b".repeat(64)}` }), false);
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
