import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import {
  createWorkspacePeerV1TransportAdapter,
  projectSessionEndpoints,
  SessionHostRegistry,
  type SessionMessageRequest,
} from "pi-maestro-teammate/v1/sessions";
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
} {
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const pi = {
    registerTool(tool: ToolDefinition) { tools.push(tool); },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
  } as unknown as ExtensionAPI;
  return { pi, tools, handlers };
}

test("Flow extension wires the managed-aware registration once on the root surface", async () => {
  const source = await readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  assert.match(source, /registerFlowSchedule\(pi, \{ managedWorker: isManagedWorkerWindow\(\) \}\)/);
  assert.equal(source.match(/registerFlowSchedule\(pi,/g)?.length, 1);
});

test("registration selects coordinator versus managed report-only surface and disposes session runtime", async () => {
  const workerApi = fakePi();
  const workerRegistration = registerFlowSchedule(workerApi.pi, { managedWorker: true, getRegistry: () => undefined });
  assert.equal(workerRegistration.managedWorker, true);
  assert.equal(workerApi.tools.length, 1);
  assert.equal(Check(workerApi.tools[0]!.parameters, { action: "create", scheduleId: "x" }), false);
  workerRegistration.dispose();

  const root = await mkdtemp(join(tmpdir(), "flow-schedule-register-"));
  const coordinatorApi = fakePi();
  const coordinatorRegistration = registerFlowSchedule(coordinatorApi.pi, {
    managedWorker: false,
    getRegistry: () => undefined,
    createStore: (cwd) => new FlowScheduleStore(cwd, { getProcessIdentity: () => `test:${process.pid}` }),
  });
  try {
    assert.equal(coordinatorRegistration.managedWorker, false);
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
