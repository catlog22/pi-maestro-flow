import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  WORKSPACE_MAIN_SESSION_MARKER,
  workspaceWindowCompletionHandle,
} from "pi-maestro-teammate/v1/workspace-completion";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Check } from "typebox/value";
import { Type } from "typebox";
import {
  createWorkspacePeerV1TransportAdapter,
  projectSessionEndpoints,
  SessionHostRegistry,
  type SessionMessageRequest,
} from "pi-maestro-teammate/v1/sessions";
import {
  MONITOR_TOOL_EXPOSURE_EVENT,
} from "pi-maestro-teammate/v1/events";
import {
  getWorkspaceProjectionProvider,
} from "pi-maestro-teammate/v1/workspace-projections";
import { MonitorToolExposureController } from "../../pi-maestro-teammate/src/extension/monitor-tool-exposure.ts";
import {
  createFlowScheduleDispatchEnvelope,
  encodeFlowScheduleDispatch,
  flowScheduleDispatchMessageId,
  flowScheduleResultMessageId,
  flowScheduleResultTransportMessageId,
} from "../src/flow-schedule/protocol.ts";
import { registerFlowSchedule } from "../src/flow-schedule/register.ts";
import { FlowScheduleRuntime } from "../src/flow-schedule/runtime.ts";
import { FlowScheduleStore } from "../src/flow-schedule/store.ts";
import {
  createCoordinatorFlowScheduleTool,
  createWorkerFlowScheduleTool,
  FlowScheduleCoordinatorParams,
} from "../src/flow-schedule/tool.ts";

const LOCAL_OWNER = "1".repeat(32);
const PEER_OWNER = "a".repeat(32);
const PEER_NONCE = "b".repeat(32);
const WORKSPACE_ID = "f".repeat(64);
const GENERIC_MESSAGE_ID = "9".repeat(32);
const DISPATCH_ID = "123e4567-e89b-42d3-a456-426614174000";
const TARGET = `owner:${PEER_OWNER}`;

function endpoints() {
  return projectSessionEndpoints([
    {
      workspaceId: WORKSPACE_ID,
      ownerId: LOCAL_OWNER,
      ownerNonce: "2".repeat(32),
      scope: "local" as const,
      status: "running" as const,
      sessionId: "local-session",
      agents: [],
    },
    {
      workspaceId: WORKSPACE_ID,
      ownerId: PEER_OWNER,
      ownerNonce: PEER_NONCE,
      scope: "workspace-peer" as const,
      status: "running" as const,
      sessionId: "peer-session",
      agents: [],
    },
  ]);
}

function registryWithCapture(capture: (request: SessionMessageRequest) => void): SessionHostRegistry {
  const registry = new SessionHostRegistry({
    surface: "unified",
    endpoints: endpoints(),
    adapters: [createWorkspacePeerV1TransportAdapter(async (endpoint, request) => {
      capture(request);
      return {
        delivered: true,
        endpointId: endpoint.id,
        transport: endpoint.transport,
        receipt: { publicationStage: "accepted", deliveryStage: "queued", messageId: request.messageId },
      };
    })],
  });
  const peer = registry.resolve(TARGET, { includeSettled: true, localFirst: false }).endpoint!;
  registry.thread.record({
    messageId: GENERIC_MESSAGE_ID,
    workspaceId: peer.workspaceId,
    peerOwnerId: peer.ownerId,
    peerOwnerNonce: peer.ownerNonce,
    direction: "incoming",
    source: "monitor",
    messageKind: "request",
    traceId: GENERIC_MESSAGE_ID,
    replyTo: TARGET,
    targetSessionId: "local-session",
    targetCorrelationId: WORKSPACE_MAIN_SESSION_MARKER,
    terminalResultRequested: true,
    mode: "follow_up",
    body: "Managed objective",
    status: "injected",
    createdAt: 1,
    updatedAt: 1,
  });
  return registry;
}

async function controllerHarness() {
  const root = await mkdtemp(join(tmpdir(), "flow-schedule-tool-"));
  const cwd = join(root, "workspace");
  const store = new FlowScheduleStore(cwd, { getProcessIdentity: () => `test:${process.pid}` });
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => undefined,
    observe: async () => ({ action: "status", reason: "snapshot", observations: [], durationMs: 0 }),
  });
  return { root, cwd, store, runtime };
}

const context = (cwd: string): ExtensionContext => ({ cwd } as ExtensionContext);

const renderTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function rendered(component: { render(width: number): string[] } | undefined, width = 160): string[] {
  assert.ok(component, "renderer must return a TUI component");
  return component.render(width);
}

test("flow-schedule renderers stream step relationships and preserve status without color", () => {
  const tool = createCoordinatorFlowScheduleTool({
    resolve: () => { throw new Error("not used"); },
    getRegistry: () => undefined,
  });
  const args = {
    action: "create",
    scheduleId: "release",
    target: TARGET,
    steps: [
      { stepId: "prepare", prompt: "Prepare" },
      { stepId: "verify", prompt: "Verify" },
    ],
  };
  const renderCall = tool.renderCall as NonNullable<typeof tool.renderCall>;
  const call = renderCall(args, renderTheme as never, { args, isPartial: true } as never);
  assert.deepEqual(rendered(call), ["  … flow-schedule create release prepare -> verify"]);
  const expandedCall = renderCall(args, renderTheme as never, { args, isPartial: true, expanded: true } as never);
  assert.deepEqual(rendered(expandedCall), [
    "  … flow-schedule create release",
    `  target: ${TARGET}`,
    "  prepare",
    "      Prepare",
    "  -> verify",
    "      Verify",
  ]);
  assert.ok(rendered(call, 32).every((line) => visibleWidth(line) <= 32), "streaming call is width bounded");

  const schedule = {
    version: 1 as const,
    scheduleId: "release",
    targetSelector: TARGET,
    state: "active" as const,
    stepIds: ["prepare", "verify"],
    steps: {
      prepare: { stepId: "prepare", prompt: "Prepare", state: "completed" as const, attempts: [] },
      verify: { stepId: "verify", prompt: "Verify", state: "awaiting-result" as const, attempts: [DISPATCH_ID], currentDispatchId: DISPATCH_ID },
    },
    activeStepId: "verify",
    createdAt: 1,
    updatedAt: 2,
  };
  const result = {
    content: [{ type: "text" as const, text: "Started release." }],
    details: { schedules: [schedule] },
  };
  const renderResult = tool.renderResult as NonNullable<typeof tool.renderResult>;
  const compact = rendered(renderResult(result, { expanded: false, isPartial: false } as never, renderTheme as never, { args, isPartial: false } as never));
  assert.match(compact[0] ?? "", /release active 1\/2 · \[done\] prepare -> \[run\] verify/);

  const expanded = rendered(renderResult(result, { expanded: true, isPartial: false } as never, renderTheme as never, { args, isPartial: false } as never));
  assert.ok(expanded.some((line) => line.includes("  [done] prepare")));
  assert.ok(expanded.some((line) => line.includes("      Prepare")));
  assert.ok(expanded.some((line) => line.includes("  -> [run] verify")));
  assert.ok(expanded.some((line) => line.includes("      Verify")));
  assert.ok(expanded.every((line) => line.length <= 160));
});

test("worker flow-schedule report renderer exposes outcome and dispatch", () => {
  const tool = createWorkerFlowScheduleTool();
  const args = { action: "report", dispatchId: DISPATCH_ID, outcome: "completed", summary: "Done" };
  const renderCall = tool.renderCall as NonNullable<typeof tool.renderCall>;
  const call = rendered(renderCall(args, renderTheme as never, { args, isPartial: true } as never));
  assert.deepEqual(call, ["  … flow-schedule report completed 123e4567"]);
});

test("coordinator tool schema is object-root and rejects action-inapplicable fields", () => {
  assert.equal(Check(FlowScheduleCoordinatorParams, { action: "list" }), true);
  assert.equal(Check(FlowScheduleCoordinatorParams, { action: "create", scheduleId: "release", target: TARGET, steps: [{ stepId: "verify", prompt: "Verify" }] }), true);
  assert.equal(Check(FlowScheduleCoordinatorParams, { action: "report", dispatchId: DISPATCH_ID, outcome: "completed", summary: "Done" }), false);
  assert.equal(Check(FlowScheduleCoordinatorParams, { action: "start", scheduleId: "release", target: TARGET }), false);
  assert.equal(Check(FlowScheduleCoordinatorParams, { action: "list", scheduleId: "release" }), false);
});

test("coordinator tool controls schedule state without owning target lifecycle", async () => {
  const harness = await controllerHarness();
  const tool = createCoordinatorFlowScheduleTool({ resolve: () => harness, getRegistry: () => undefined });
  try {
    const created = await tool.execute("create", {
      action: "create",
      scheduleId: "release",
      target: TARGET,
      steps: [{ stepId: "verify", prompt: "Verify" }],
    }, undefined, undefined, context(harness.cwd));
    assert.equal(created.isError, undefined);
    assert.equal(created.details?.schedules[0]?.state, "draft");

    const started = await tool.execute("start", { action: "start", scheduleId: "release" }, undefined, undefined, context(harness.cwd));
    assert.equal(started.details?.schedules[0]?.state, "active");
    assert.equal(started.details?.dispatch, undefined, "no target handshake means no intent");

    await tool.execute("append", {
      action: "append",
      scheduleId: "release",
      afterStepId: "verify",
      steps: [{ stepId: "publish", prompt: "Publish" }],
    }, undefined, undefined, context(harness.cwd));
    const paused = await tool.execute("pause", { action: "pause", scheduleId: "release" }, undefined, undefined, context(harness.cwd));
    assert.equal(paused.details?.schedules[0]?.state, "paused");
    const resumed = await tool.execute("resume", { action: "resume", scheduleId: "release" }, undefined, undefined, context(harness.cwd));
    assert.equal(resumed.details?.schedules[0]?.state, "active");
    const cancelled = await tool.execute("cancel", {
      action: "cancel",
      scheduleId: "release",
      reason: "Operator cancelled",
    }, undefined, undefined, context(harness.cwd));
    assert.equal(cancelled.details?.schedules[0]?.state, "cancelled");
    assert.match((cancelled.content[0] as { text: string }).text, /Target lifecycle was not changed/);

    const status = await tool.execute("status", { action: "status", scheduleId: "release" }, undefined, undefined, context(harness.cwd));
    assert.equal(status.details?.lifecycle?.found, false);
  } finally {
    runtimeDispose(harness.runtime);
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("status shows lastAdmitReason and deferral attempts when a schedule has not dispatched", async () => {
  const harness = await controllerHarness();
  const tool = createCoordinatorFlowScheduleTool({ resolve: () => harness, getRegistry: () => undefined });
  try {
    await harness.store.createSchedule({
      scheduleId: "release",
      target: TARGET,
      steps: [{ stepId: "verify", prompt: "Verify" }],
    });
    await harness.store.updateSchedule("release", (schedule) => ({
      ...schedule, state: "active", admitAttempts: 2, lastAdmitReason: "target endpoint is not resolvable", lastAdmitAt: 1000 }));
    const status = await tool.execute("status", { action: "status", scheduleId: "release" }, undefined, undefined, context(harness.cwd));
    const text = (status.content[0] as { text: string }).text;
    assert.match(text, /Admit: deferred attempts=2 at=1000/);
    assert.match(text, /target endpoint is not resolvable/);
  } finally {
    runtimeDispose(harness.runtime);
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("status shows the latest dispatch binding and exact Todo outcome after completion", async () => {
  const harness = await controllerHarness();
  const tool = createCoordinatorFlowScheduleTool({ resolve: () => harness, getRegistry: () => undefined });
  const targetIdentity = {
    workspaceId: "workspace",
    endpointId: TARGET,
    ownerId: PEER_OWNER,
    ownerNonce: PEER_NONCE,
    sessionId: "peer-session",
  };
  try {
    await harness.store.createSchedule({
      scheduleId: "release",
      target: TARGET,
      steps: [{
        stepId: "verify",
        prompt: "Verify",
        todoBinding: { label: "Verify release", requireCompleted: true, conflictCheck: true },
      }],
    });
    await harness.store.updateSchedule("release", (schedule) => ({ ...schedule, state: "active" }));
    await harness.store.createDispatchIntent({
      dispatchId: DISPATCH_ID,
      scheduleId: "release",
      stepId: "verify",
      targetIdentity,
    });
    const degraded = await tool.execute("status", {
      action: "status",
      scheduleId: "release",
    }, undefined, undefined, context(harness.cwd));
    const degradedText = degraded.content[0] && "text" in degraded.content[0] ? degraded.content[0].text : "";
    assert.match(degradedText, /Binding: none gate=none \(not negotiated\)/);

    await harness.store.recordBinding({
      version: 1,
      type: "flow-schedule-binding",
      dispatchId: DISPATCH_ID,
      scheduleId: "release",
      stepId: "verify",
      state: "pending",
      createdAt: 10,
      updatedAt: 10,
    });
    await harness.store.recordCompletion({
      version: 1,
      type: "flow-schedule-completion",
      dispatchId: DISPATCH_ID,
      scheduleId: "release",
      stepId: "verify",
      targetIdentity,
      state: "completed",
      result: {
        version: 1,
        type: "flow-schedule-result",
        dispatchId: DISPATCH_ID,
        scheduleId: "release",
        stepId: "verify",
        outcome: "completed",
        summary: "Verified",
        resources: [],
        todoOutcome: { todoId: "todo-verify", todoStatus: "completed" },
      },
      completedAt: 20,
    });

    const status = await tool.execute("status", {
      action: "status",
      scheduleId: "release",
    }, undefined, undefined, context(harness.cwd));
    const text = status.content[0] && "text" in status.content[0] ? status.content[0].text : "";
    assert.match(text, new RegExp(`Dispatch: id=${DISPATCH_ID} state=completed`));
    assert.match(text, /Transport: preparedAt=\d+ publishedAt=- acceptedAt=-/);
    assert.match(text, /Binding: state=completed gate=require-completed\+conflict-check todoId=todo-verify todoStatus=completed/);
    assert.match(text, /Result: state=completed at=20 outcome=completed todoOutcome=todo-verify\/completed/);
    assert.equal(status.details?.dispatch?.completion?.result?.todoOutcome?.todoId, "todo-verify");
    assert.match(tool.description ?? "", /Todo evidence is additional only for a negotiated Todo gate/);
    const coordinatorGuidelines = tool.promptGuidelines?.join("\n") ?? "";
    assert.match(coordinatorGuidelines, /flow-schedule-todo-binding capability/);
    assert.match(coordinatorGuidelines, /no Todo instruction or binding is created/);
    assert.match(coordinatorGuidelines, /Todo gate waits up to 30 seconds/);
    assert.match(coordinatorGuidelines, /retry can duplicate work/);
  } finally {
    runtimeDispose(harness.runtime);
    await rm(harness.root, { recursive: true, force: true });
  }
});

function runtimeDispose(runtime: FlowScheduleRuntime): void {
  runtime.dispose();
}

test("managed-worker tool exposes report only and derives transport destination from the inbound dispatch", async () => {
  let published: SessionMessageRequest | undefined;
  const registry = registryWithCapture((request) => { published = request; });
  const peer = registry.resolve(TARGET, { includeSettled: true, localFirst: false }).endpoint!;
  const envelope = createFlowScheduleDispatchEnvelope({
    scheduleId: "release",
    stepId: "verify",
    dispatchId: DISPATCH_ID,
    instruction: "Verify",
  });
  registry.thread.record({
    messageId: flowScheduleDispatchMessageId(DISPATCH_ID),
    workspaceId: peer.workspaceId,
    peerOwnerId: peer.ownerId,
    peerOwnerNonce: peer.ownerNonce,
    direction: "incoming",
    source: "system",
    messageKind: "request",
    traceId: DISPATCH_ID,
    replyTo: TARGET,
    targetSessionId: "local-session",
    mode: "follow_up",
    body: encodeFlowScheduleDispatch(envelope),
    status: "injected",
    createdAt: 10,
    updatedAt: 10,
  });

  const tool = createWorkerFlowScheduleTool({ getRegistry: () => registry });
  const workerGuidelines = tool.promptGuidelines?.join("\n") ?? "";
  assert.match(workerGuidelines, /exact todoId and todoStatus in report\.todoOutcome/);
  assert.match(workerGuidelines, /always call report with outcome=completed or outcome=failed/);
  assert.match(workerGuidelines, /do not omit a failure report/);
  assert.equal(Check(tool.parameters, { action: "report", dispatchId: DISPATCH_ID, outcome: "completed", summary: "Done" }), true);
  assert.equal(Check(tool.parameters, { action: "create", scheduleId: "release" }), false);
  const result = await tool.execute("report", {
    action: "report",
    dispatchId: DISPATCH_ID,
    outcome: "completed",
    summary: "Verified",
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.details?.resultMessageId, flowScheduleResultMessageId(DISPATCH_ID));
  assert.equal(result.details?.completionResource, workspaceWindowCompletionHandle(GENERIC_MESSAGE_ID).resource);
  assert.equal(published?.selector, peer.id);
  assert.equal(published?.messageId, flowScheduleResultTransportMessageId(DISPATCH_ID));
  assert.equal(published?.messageKind, "status");
  assert.equal(published?.trustedStatus, true);
});

function fakePi(): {
  pi: ExtensionAPI;
  tools: ToolDefinition[];
  handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
  active: () => string[];
  emit: (channel: string, data: unknown) => void;
} {
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  let active: string[] = [];
  const emit = (channel: string, data: unknown): void => {
    for (const handler of eventHandlers.get(channel) ?? []) handler(data);
  };
  const pi = {
    registerTool(tool: ToolDefinition) { tools.push(tool); },
    getActiveTools() { return [...active]; },
    setActiveTools(names: string[]) { active = [...names]; },
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        const current = eventHandlers.get(channel) ?? [];
        current.push(handler);
        eventHandlers.set(channel, current);
        return () => {
          const remaining = eventHandlers.get(channel)?.filter((candidate) => candidate !== handler) ?? [];
          eventHandlers.set(channel, remaining);
        };
      },
      emit,
    },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
  } as unknown as ExtensionAPI;
  return { pi, tools, handlers, active: () => [...active], emit };
}

test("Flow extension wires managed-worker registration and defers root authority to Monitor exposure", async () => {
  const source = await readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  assert.match(source, /registerFlowSchedule\(pi, \{\s*managedWorker: isManagedWorkerWindow\(\),\s*todoMutationSupported: isManagedWorkerWindow\(\),\s*\}\)/);
  assert.equal(source.match(/registerFlowSchedule\(pi,/g)?.length, 1);
});

test("root coordinator registration follows Monitor exposure enter and exit", async () => {
  const api = fakePi();
  const exposure = new MonitorToolExposureController(api.pi, {
    local: ["teammate-send", "teammate-list", "observe"].map((name) => ({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
    })),
    monitor: ["teammate-send", "teammate-list", "observe"].map((name) => ({
      name,
      label: name,
      description: `monitor:${name}`,
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
    })),
    exclusiveNames: ["workspace-window", "remote-worker"],
  });
  const registration = registerFlowSchedule(api.pi, {
    managedWorker: false,
    getRegistry: () => undefined,
  });
  try {
    assert.equal(registration.monitor, false);
    assert.equal(api.tools.some((tool) => tool.name === "flow-schedule"), false);
    assert.deepEqual(api.active(), []);

    exposure.enter();
    assert.equal(registration.monitor, true);
    assert.equal(api.tools.filter((tool) => tool.name === "flow-schedule").length, 1);
    assert.equal(api.active().includes("flow-schedule"), true);

    exposure.exit();
    assert.equal(registration.monitor, false);
    assert.equal(api.active().includes("flow-schedule"), false);
    api.emit(MONITOR_TOOL_EXPOSURE_EVENT, { active: true, generation: 1 });
    assert.equal(api.active().includes("flow-schedule"), false, "stale exposure events must not re-enable the coordinator");
    const coordinator = api.tools.find((tool) => tool.name === "flow-schedule");
    assert.ok(coordinator);
    const rejected = await coordinator.execute(
      "list-after-exit",
      { action: "list" },
      undefined,
      undefined,
      context("/tmp"),
    );
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0] && "text" in rejected.content[0] ? rejected.content[0].text : "", /active Monitor mode/);
  } finally {
    registration.dispose();
  }
});

test("coordinator fences Monitor exit during an awaited action", async () => {
  let generation = 1;
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const store = {
    async listSchedules() {
      markEntered();
      await pending;
      return [];
    },
  } as unknown as FlowScheduleStore;
  const runtime = {} as FlowScheduleRuntime;
  const tool = createCoordinatorFlowScheduleTool({
    resolve: () => ({ store, runtime }),
    getRegistry: () => undefined,
    isMonitorActive: () => true,
    captureMonitor: () => ({ generation }),
  });

  const execution = tool.execute("list-during-exit", { action: "list" }, undefined, undefined, context("/tmp"));
  await entered;
  generation = 2;
  release();
  const result = await execution;
  assert.equal(result.isError, true);
  assert.match(result.content[0] && "text" in result.content[0] ? result.content[0].text : "", /Monitor mode changed/);
});

test("inactive Monitor exposure still starts and retains root runtime reconciliation", async () => {
  const api = fakePi();
  let starts = 0;
  let disposals = 0;
  const runtime = {
    async start() { starts += 1; },
    dispose() { disposals += 1; },
  } as unknown as FlowScheduleRuntime;
  const registration = registerFlowSchedule(api.pi, {
    managedWorker: false,
    getRegistry: () => undefined,
    createStore: () => ({} as FlowScheduleStore),
    createRuntime: () => runtime,
  });
  try {
    const start = api.handlers.get("session_start")?.[0];
    assert.ok(start);
    await start({}, context("/tmp/flow-schedule-inactive-runtime"));
    assert.equal(registration.monitor, false);
    assert.equal(registration.current()?.runtime, runtime);
    assert.ok(starts >= 1, "persistent reconcile starts independently of Monitor exposure");
    assert.equal(api.active().includes("flow-schedule"), false);

    api.emit(MONITOR_TOOL_EXPOSURE_EVENT, { active: true, generation: 1 });
    api.emit(MONITOR_TOOL_EXPOSURE_EVENT, { active: false, generation: 2 });
    assert.equal(registration.current()?.runtime, runtime);
    assert.equal(disposals, 0, "leaving Monitor only removes tool exposure");
    assert.equal(api.active().includes("flow-schedule"), false);

    const startsBeforeReentry = starts;
    api.emit(MONITOR_TOOL_EXPOSURE_EVENT, { active: true, generation: 3 });
    assert.equal(registration.current()?.runtime, runtime, "Monitor re-entry must not replace the schedule owner runtime");
    assert.equal(starts, startsBeforeReentry, "Monitor re-entry must not restart reconciliation");
    assert.equal(disposals, 0);
    assert.equal(api.active().includes("flow-schedule"), true);
    api.emit(MONITOR_TOOL_EXPOSURE_EVENT, { active: false, generation: 4 });
    assert.equal(registration.current()?.runtime, runtime);
    assert.equal(api.active().includes("flow-schedule"), false);
  } finally {
    registration.dispose();
  }
  assert.equal(disposals, 1);
});

test("registration exposes Monitor control, managed report-only, and no ordinary root surface", async () => {
  const workerApi = fakePi();
  const workerRegistration = registerFlowSchedule(workerApi.pi, {
    managedWorker: true,
    getRegistry: () => undefined,
  });
  assert.equal(workerRegistration.managedWorker, true);
  assert.equal(workerRegistration.monitor, false);
  assert.equal(workerApi.tools.length, 1);
  assert.equal(Check(workerApi.tools[0]!.parameters, { action: "create", scheduleId: "x" }), false);
  const workerRoot = await mkdtemp(join(tmpdir(), "flow-schedule-worker-register-"));
  try {
    const workerStart = workerApi.handlers.get("session_start")?.[0];
    const workerShutdown = workerApi.handlers.get("session_shutdown")?.[0];
    assert.ok(workerStart && workerShutdown);
    await workerStart({}, context(workerRoot));
    assert.ok(getWorkspaceProjectionProvider("todo"));
    await workerShutdown({}, context(workerRoot));
    assert.equal(getWorkspaceProjectionProvider("todo"), undefined);
  } finally {
    workerRegistration.dispose();
    await rm(workerRoot, { recursive: true, force: true });
  }

  const ordinaryApi = fakePi();
  const ordinaryRegistration = registerFlowSchedule(ordinaryApi.pi, {
    managedWorker: false,
    getRegistry: () => undefined,
  });
  assert.equal(ordinaryRegistration.managedWorker, false);
  assert.equal(ordinaryRegistration.monitor, false);
  assert.deepEqual(ordinaryApi.tools, []);
  assert.equal(ordinaryApi.handlers.get("session_start")?.length, 1);
  assert.equal(ordinaryApi.handlers.get("session_shutdown")?.length, 1);
  ordinaryRegistration.dispose();

  const root = await mkdtemp(join(tmpdir(), "flow-schedule-register-"));
  const coordinatorApi = fakePi();
  const coordinatorRegistration = registerFlowSchedule(coordinatorApi.pi, {
    managedWorker: false,
    getRegistry: () => undefined,
    createStore: (cwd) => new FlowScheduleStore(cwd, { getProcessIdentity: () => `test:${process.pid}` }),
  });
  try {
    assert.equal(coordinatorRegistration.managedWorker, false);
    assert.equal(coordinatorRegistration.monitor, false);
    assert.deepEqual(coordinatorApi.tools, []);
    coordinatorApi.emit(MONITOR_TOOL_EXPOSURE_EVENT, { active: true, generation: 1 });
    assert.equal(coordinatorRegistration.monitor, true);
    assert.equal(Check(coordinatorApi.tools[0]!.parameters, { action: "list" }), true);
    const start = coordinatorApi.handlers.get("session_start")?.[0];
    const shutdown = coordinatorApi.handlers.get("session_shutdown")?.[0];
    assert.ok(start && shutdown);
    await start({}, context(root));
    assert.ok(coordinatorRegistration.current());
    await shutdown({}, context(root));
    assert.equal(coordinatorRegistration.current(), undefined);
  } finally {
    coordinatorRegistration.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
