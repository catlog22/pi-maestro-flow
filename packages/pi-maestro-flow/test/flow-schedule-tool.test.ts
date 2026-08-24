import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
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
  flowScheduleResultMessageId,
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
const DISPATCH_ID = "123e4567-e89b-42d3-a456-426614174000";
const TARGET = `owner:${PEER_OWNER}`;

function endpoints() {
  return projectSessionEndpoints([
    {
      workspaceId: "workspace",
      ownerId: LOCAL_OWNER,
      ownerNonce: "2".repeat(32),
      scope: "local" as const,
      status: "running" as const,
      sessionId: "local-session",
      agents: [],
    },
    {
      workspaceId: "workspace",
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
  return new SessionHostRegistry({
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
    assert.match(text, /Binding: state=completed gate=require-completed\+conflict-check todoId=todo-verify todoStatus=completed/);
    assert.match(text, /Result: outcome=completed todoOutcome=todo-verify\/completed/);
    assert.equal(status.details?.dispatch?.completion?.result?.todoOutcome?.todoId, "todo-verify");
    assert.match(tool.promptGuidelines?.join("\n") ?? "", /flow-schedule-todo-binding capability/);
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
    messageId: DISPATCH_ID,
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
  assert.match(tool.promptGuidelines?.join("\n") ?? "", /exact todoId and todoStatus in report\.todoOutcome/);
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
  assert.equal(published?.selector, peer.id);
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

test("Flow extension wires the managed and Monitor-aware registration once", async () => {
  const source = await readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  assert.match(source, /registerFlowSchedule\(pi, \{\s*managedWorker: isManagedWorkerWindow\(\),\s*monitor: isMonitorSession\(\),\s*\}\)/);
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
    monitor: false,
    getRegistry: () => undefined,
  });
  try {
    assert.equal(api.tools.some((tool) => tool.name === "flow-schedule"), false);
    assert.deepEqual(api.active(), []);

    exposure.enter();
    assert.equal(api.tools.filter((tool) => tool.name === "flow-schedule").length, 1);
    assert.equal(api.active().includes("flow-schedule"), true);

    exposure.exit();
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

test("registration exposes Monitor control, managed report-only, and no ordinary root surface", async () => {
  const workerApi = fakePi();
  const workerRegistration = registerFlowSchedule(workerApi.pi, {
    managedWorker: true,
    monitor: true,
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
    monitor: false,
    getRegistry: () => undefined,
  });
  assert.equal(ordinaryRegistration.managedWorker, false);
  assert.equal(ordinaryRegistration.monitor, false);
  assert.deepEqual(ordinaryApi.tools, []);
  assert.equal(ordinaryApi.handlers.size, 0);
  ordinaryRegistration.dispose();

  const root = await mkdtemp(join(tmpdir(), "flow-schedule-register-"));
  const coordinatorApi = fakePi();
  const coordinatorRegistration = registerFlowSchedule(coordinatorApi.pi, {
    managedWorker: false,
    monitor: true,
    getRegistry: () => undefined,
    createStore: (cwd) => new FlowScheduleStore(cwd, { getProcessIdentity: () => `test:${process.pid}` }),
  });
  try {
    assert.equal(coordinatorRegistration.managedWorker, false);
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
