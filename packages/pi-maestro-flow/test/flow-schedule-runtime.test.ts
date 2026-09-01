import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeActorHost } from "pi-maestro-teammate/v2/runtime-broker";
import {
  bindWorkspaceCompletionHandle,
  createWorkspaceWindowTerminalResult,
  encodeWorkspaceWindowTerminalResult,
  WORKSPACE_MAIN_SESSION_MARKER,
  workspaceWindowTerminalResultMessageId,
} from "pi-maestro-teammate/v1/workspace-completion";
import {
  createWorkspacePeerV1TransportAdapter,
  projectSessionEndpoints,
  SessionHostRegistry,
  type SessionEndpoint,
  type SessionMessageRequest,
  type SessionMessageResult,
  type WindowThreadEntry,
} from "pi-maestro-teammate/v1/sessions";
import {
  createFlowScheduleDispatchEnvelope,
  createFlowScheduleResult,
  decodeFlowScheduleDispatch,
  encodeFlowScheduleDispatch,
  encodeFlowScheduleResult,
  flowScheduleDispatchMessageId,
  flowScheduleReportReminderMessageId,
  flowScheduleResultMessageId,
  flowScheduleResultTransportMessageId,
} from "../src/flow-schedule/protocol.ts";
import {
  FlowScheduleBrokerRuntime,
} from "../src/flow-schedule/broker-runtime.ts";
import {
  FlowScheduleRuntime,
  FLOW_SCHEDULE_REPORT_CAPABILITY,
  FLOW_SCHEDULE_TODO_BINDING_CAPABILITY,
  FLOW_SCHEDULE_TODO_MUTATION_CAPABILITY,
  FLOW_SCHEDULE_TODO_PROJECTION_CAPABILITY,
  publishFlowScheduleReport,
  type FlowScheduleRuntimeEvent,
  type FlowScheduleRuntimeStore,
} from "../src/flow-schedule/runtime.ts";
import { FlowScheduleStore } from "../src/flow-schedule/store.ts";
import type {
  ExactWindowIdentity,
  FlowScheduleRecord,
  FlowScheduleTodoBindingSpec,
} from "../src/flow-schedule/types.ts";

const LOCAL_OWNER = "1".repeat(32);
const PEER_OWNER = "a".repeat(32);
const PEER_NONCE = "b".repeat(32);
const WORKSPACE_ID = "f".repeat(64);
const GENERIC_MESSAGE_ID = "9".repeat(32);
const REPLACEMENT_NONCE = "c".repeat(32);
const DISPATCH_A = "123e4567-e89b-42d3-a456-426614174000";
const DISPATCH_B = "223e4567-e89b-42d3-a456-426614174000";
const TARGET = `owner:${PEER_OWNER}`;

function endpointOwners(peerNonce = PEER_NONCE, todoBinding = false) {
  return [
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
      ownerNonce: peerNonce,
      scope: "workspace-peer" as const,
      status: "running" as const,
      sessionId: peerNonce === PEER_NONCE ? "peer-session" : "replacement-session",
      ...(todoBinding ? { extraCapabilities: [FLOW_SCHEDULE_TODO_BINDING_CAPABILITY] } : {}),
      agents: [],
    },
  ];
}

function liveObservation() {
  return Promise.resolve({
    action: "status" as const,
    reason: "snapshot" as const,
    observations: [{
      target: { kind: "workspace", id: TARGET },
      found: true,
      nativeStatus: "running",
      phase: "active" as const,
      summary: "running",
      updatedAt: 1,
      capabilities: { inspect: true, wait: true, message: true },
    }],
    durationMs: 0,
  });
}

function recordOutgoing(
  registry: SessionHostRegistry,
  endpoint: SessionEndpoint,
  request: SessionMessageRequest,
  status: "queued" | "injected" | "accepted" | "rejected" | "timeout",
): WindowThreadEntry {
  return registry.thread.record({
    messageId: request.messageId!,
    workspaceId: endpoint.workspaceId,
    peerOwnerId: endpoint.ownerId,
    peerOwnerNonce: endpoint.ownerNonce,
    direction: "outgoing",
    source: request.source ?? "system",
    ...(request.messageKind === undefined ? {} : { messageKind: request.messageKind }),
    ...(request.traceId === undefined ? {} : { traceId: request.traceId }),
    ...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
    mode: "follow_up",
    body: request.message,
    status,
    createdAt: 10,
    updatedAt: 10,
  });
}

function registryWithDelivery(
  deliver: (registry: SessionHostRegistry, endpoint: SessionEndpoint, request: SessionMessageRequest) => Promise<SessionMessageResult>,
  todoBinding = false,
  includeCompletionCorrelation = true,
): SessionHostRegistry {
  let registry!: SessionHostRegistry;
  registry = new SessionHostRegistry({
    surface: "unified",
    endpoints: projectSessionEndpoints(endpointOwners(PEER_NONCE, todoBinding)),
    adapters: [createWorkspacePeerV1TransportAdapter((endpoint, request) => deliver(registry, endpoint, request))],
  });
  const peer = registry.resolve(TARGET, { includeSettled: true, localFirst: false }).endpoint!;
  if (includeCompletionCorrelation) for (const direction of ["outgoing", "incoming"] as const) {
    const outgoing = direction === "outgoing";
    registry.thread.record({
      messageId: GENERIC_MESSAGE_ID,
      workspaceId: peer.workspaceId,
      peerOwnerId: peer.ownerId,
      peerOwnerNonce: peer.ownerNonce,
      direction,
      source: "monitor",
      messageKind: "request",
      ...(outgoing ? {
        provenance: {
          version: 1,
          messageId: GENERIC_MESSAGE_ID,
          source: "monitor",
          messageKind: "request",
          deliveryMode: "follow_up",
          confidence: "verified",
          sender: { kind: "system", ownerId: LOCAL_OWNER, label: "monitor" },
        },
      } : {}),
      traceId: GENERIC_MESSAGE_ID,
      replyTo: outgoing ? `owner:${LOCAL_OWNER}` : TARGET,
      targetSessionId: "local-session",
      targetCorrelationId: WORKSPACE_MAIN_SESSION_MARKER,
      terminalResultRequested: true,
      mode: "follow_up",
      body: "Managed objective",
      status: "injected",
      createdAt: 1,
      updatedAt: 1,
    });
  }
  return registry;
}

async function storeHarness(todoBinding?: FlowScheduleTodoBindingSpec) {
  const root = await mkdtemp(join(tmpdir(), "flow-schedule-runtime-"));
  let now = 100;
  const store = new FlowScheduleStore(join(root, "workspace"), {
    now: () => now++,
    getProcessIdentity: () => `test:${process.pid}`,
  });
  await store.createSchedule({
    scheduleId: "release",
    target: TARGET,
    steps: [{ stepId: "verify", prompt: "Run verification", ...(todoBinding ? { todoBinding } : {}) }],
  });
  await store.updateSchedule("release", (schedule) => ({ ...schedule, state: "active" }));
  return { root, store, now: () => now++ };
}

function tracedStore(store: FlowScheduleStore, events: string[]): FlowScheduleRuntimeStore {
  return {
    readSchedule: (id) => store.readSchedule(id),
    listSchedules: () => store.listSchedules(),
    updateSchedule: (id, update) => store.updateSchedule(id, update),
    prepareRetry: (scheduleId, stepId, reason) => store.prepareRetry(scheduleId, stepId, reason),
    createDispatchIntent: async (input, authorize) => {
      events.push("intent");
      return store.createDispatchIntent(input, authorize);
    },
    readDispatch: (id) => store.readDispatch(id),
    recordPublished: (record) => store.recordPublished(record),
    recordAccepted: (record) => store.recordAccepted(record),
    recordCompletion: (record) => store.recordCompletion(record),
    recordBinding: (record) => store.recordBinding(record),
  };
}

function fileBroker(projectRoot: string, stateDirectory: string, now: () => number): FlowScheduleBrokerRuntime {
  return new FlowScheduleBrokerRuntime({
    projectRoot,
    mode: 1,
    actorHost: createRuntimeActorHost({ mode: "file", stateDirectory }),
    now,
  });
}

function faultingStore(
  store: FlowScheduleStore,
  method: "createDispatchIntent" | "recordPublished" | "recordAccepted" | "recordCompletion" | "prepareRetry" | "updateSchedule",
): FlowScheduleRuntimeStore {
  return new Proxy(store, {
    get(target, property) {
      if (property !== method) {
        const value = target[property as keyof FlowScheduleStore];
        return typeof value === "function" ? value.bind(target) : value;
      }
      if (method === "createDispatchIntent") return async () => { throw new Error("crash after admission actor commit"); };
      if (method === "recordPublished") return async () => { throw new Error("crash after published actor commit"); };
      if (method === "recordAccepted") return async () => { throw new Error("crash after accepted actor commit"); };
      if (method === "recordCompletion") return async () => { throw new Error("crash after completion actor commit"); };
      if (method === "prepareRetry") {
        return async (
          scheduleId: string,
          stepId: string,
          reason: string,
          beforePersist?: Parameters<FlowScheduleStore["prepareRetry"]>[3],
        ) => target.prepareRetry(scheduleId, stepId, reason, async (projection) => {
          await beforePersist?.(projection);
          throw new Error("crash after retry actor commit");
        });
      }
      return async (
        scheduleId: string,
        update: Parameters<FlowScheduleStore["updateSchedule"]>[1],
        beforePersist?: Parameters<FlowScheduleStore["updateSchedule"]>[2],
      ) => target.updateSchedule(scheduleId, update, async (projection) => {
        await beforePersist?.(projection);
        throw new Error("crash after cancel actor commit");
      });
    },
  }) as unknown as FlowScheduleRuntimeStore;
}

test("runtime startup discovers and materializes a create committed before its v1 file existed", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-schedule-undiscoverable-create-"));
  const projectRoot = join(root, "workspace");
  const stateDirectory = join(root, "broker");
  let clock = 100;
  const now = () => clock++;
  const store = new FlowScheduleStore(projectRoot, { now, getProcessIdentity: () => `test:${process.pid}` });
  const firstBroker = fileBroker(projectRoot, stateDirectory, now);
  const interruptedStore = new Proxy(store, {
    get(target, property) {
      if (property === "createSchedule") {
        return async (input: Parameters<FlowScheduleStore["createSchedule"]>[0], beforePersist?: Parameters<FlowScheduleStore["createSchedule"]>[1]) =>
          target.createSchedule(input, async (projection) => {
            await beforePersist?.(projection);
            throw new Error("crash after schedule actor commit");
          });
      }
      const value = target[property as keyof FlowScheduleStore];
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as FlowScheduleRuntimeStore;
  const first = new FlowScheduleRuntime({ store: interruptedStore, brokerRuntime: firstBroker, now });
  try {
    await assert.rejects(first.createSchedule({
      scheduleId: "journal-only",
      target: TARGET,
      steps: [{ stepId: "verify", prompt: "Verify" }],
    }), /crash after schedule actor commit/);
    assert.equal(await store.readSchedule("journal-only"), undefined);
    await first.shutdown();

    const restarted = new FlowScheduleRuntime({
      store,
      brokerRuntime: fileBroker(projectRoot, stateDirectory, now),
      now,
    });
    try {
      await restarted.start();
      const rebuilt = await store.readSchedule("journal-only");
      assert.equal(rebuilt?.scheduleId, "journal-only");
      assert.equal(rebuilt?.steps.verify.prompt, "Verify");
    } finally {
      await restarted.shutdown();
    }
  } finally {
    await first.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime restart rebuilds deleted schedule and complete dispatch projections from actor journals", async () => {
  const { root, store, now } = await storeHarness({ requireCompleted: true, conflictCheck: true });
  const projectRoot = store.projectRoot;
  const stateDirectory = join(root, "broker");
  const registry = registryWithDelivery(async (host, endpoint, request) => {
    recordOutgoing(host, endpoint, request, "injected");
    return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "injected" } };
  });
  const v2Owners = endpointOwners();
  v2Owners[1]!.extraCapabilities = [
    FLOW_SCHEDULE_TODO_PROJECTION_CAPABILITY,
    FLOW_SCHEDULE_TODO_MUTATION_CAPABILITY,
    FLOW_SCHEDULE_REPORT_CAPABILITY,
  ];
  registry.replaceEndpoints(projectSessionEndpoints(v2Owners));
  const firstBroker = fileBroker(projectRoot, stateDirectory, now);
  const first = new FlowScheduleRuntime({
    store,
    brokerRuntime: firstBroker,
    getRegistry: () => registry,
    observe: liveObservation,
    now,
    createDispatchId: () => DISPATCH_A,
  });
  try {
    await first.start();
    const admitted = (await store.readDispatch(DISPATCH_A))!;
    assert.deepEqual((await firstBroker.actors!.dispatchState(DISPATCH_A)).intent, admitted.intent);
    recordIncomingResult(registry, admitted.intent.targetIdentity, createFlowScheduleResult({
      scheduleId: "release",
      stepId: "verify",
      dispatchId: DISPATCH_A,
      outcome: "completed",
      summary: "Journal rebuild complete",
      todoOutcome: { todoId: "journal-todo", todoStatus: "completed" },
    }));
    await first.reconcileReady();
    assert.equal((await store.readSchedule("release"))?.state, "completed");
    assert.ok((await store.readDispatch(DISPATCH_A))?.accepted);
    assert.ok((await store.readDispatch(DISPATCH_A))?.completion);
    await first.shutdown();

    await rm(join(store.schedulesDir, "release.json"));
    await rm(join(store.dispatchesDir, DISPATCH_A), { recursive: true });
    assert.deepEqual(await store.listSchedules(), []);
    assert.equal(await store.readDispatch(DISPATCH_A), undefined);

    const restarted = new FlowScheduleRuntime({
      store,
      brokerRuntime: fileBroker(projectRoot, stateDirectory, now),
      getRegistry: () => registry,
      observe: liveObservation,
      now,
    });
    try {
      await restarted.start();
      const rebuiltSchedule = await store.readSchedule("release");
      const rebuiltDispatch = await store.readDispatch(DISPATCH_A);
      assert.equal(rebuiltSchedule?.state, "completed");
      assert.equal(rebuiltSchedule?.steps.verify.result?.summary, "Journal rebuild complete");
      assert.equal(rebuiltDispatch?.intent.createdAt, admitted.intent.createdAt);
      assert.equal(rebuiltDispatch?.published?.messageId, flowScheduleDispatchMessageId(DISPATCH_A));
      assert.equal(rebuiltDispatch?.accepted?.deliveryState, "injected");
      assert.equal(rebuiltDispatch?.completion?.result?.summary, "Journal rebuild complete");
      assert.equal(rebuiltDispatch?.binding?.state, "completed");
      assert.equal(rebuiltDispatch?.binding?.todoId, "journal-todo");
    } finally {
      await restarted.shutdown();
    }
  } finally {
    await first.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

function recordIncomingResult(
  registry: SessionHostRegistry,
  identity: ExactWindowIdentity,
  result: ReturnType<typeof createFlowScheduleResult>,
  overrides: Partial<WindowThreadEntry> = {},
  addCompletionCorrelation = true,
): WindowThreadEntry {
  const messageId = flowScheduleResultTransportMessageId(result.dispatchId);
  const correlated = !addCompletionCorrelation || result.completionCorrelation
    ? result
    : createFlowScheduleResult({
        ...result,
        resources: result.resources,
        completionCorrelation: bindWorkspaceCompletionHandle(GENERIC_MESSAGE_ID, {
          workspaceId: identity.workspaceId,
          ownerId: LOCAL_OWNER,
          ownerNonce: "2".repeat(32),
        }),
      });
  return registry.thread.record({
    messageId,
    workspaceId: identity.workspaceId,
    peerOwnerId: identity.ownerId,
    peerOwnerNonce: identity.ownerNonce,
    direction: "incoming",
    source: "system",
    messageKind: "status",
    traceId: result.dispatchId,
    replyTo: `owner:${identity.ownerId}`,
    targetSessionId: "local-session",
    mode: "follow_up",
    body: encodeFlowScheduleResult(correlated),
    status: "injected",
    createdAt: 20,
    updatedAt: 20,
    ...overrides,
  });
}

function recordGenericTerminal(
  registry: SessionHostRegistry,
  identity: ExactWindowIdentity,
  outcome: "failed" | "cancelled" | "no-result",
): WindowThreadEntry {
  const terminal = createWorkspaceWindowTerminalResult({
    requestMessageId: GENERIC_MESSAGE_ID,
    outcome,
    settledAt: 31,
    ...(outcome === "failed" ? { error: "Worker runtime failed" } : {}),
    ...(outcome === "cancelled" ? { error: "Worker was cancelled" } : {}),
  });
  return registry.thread.record({
    messageId: workspaceWindowTerminalResultMessageId(GENERIC_MESSAGE_ID),
    workspaceId: identity.workspaceId,
    peerOwnerId: identity.ownerId,
    peerOwnerNonce: identity.ownerNonce,
    direction: "incoming",
    source: "system",
    messageKind: "status",
    traceId: GENERIC_MESSAGE_ID,
    targetSessionId: "local-session",
    targetCorrelationId: WORKSPACE_MAIN_SESSION_MARKER,
    mode: "follow_up",
    body: encodeWorkspaceWindowTerminalResult(terminal),
    status: "injected",
    createdAt: 30,
    updatedAt: 30,
  });
}

test("runtime recovery closes admission, transport, completion, retry, and cancel actor-to-v1 crash windows", async () => {
  const { root, store, now } = await storeHarness({ requireCompleted: true });
  const projectRoot = store.projectRoot;
  const stateDirectory = join(root, "broker");
  const registry = registryWithDelivery(async (host, endpoint, request) => {
    recordOutgoing(host, endpoint, request, "injected");
    return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "injected" } };
  });
  const v2Owners = endpointOwners();
  v2Owners[1]!.extraCapabilities = [
    FLOW_SCHEDULE_TODO_PROJECTION_CAPABILITY,
    FLOW_SCHEDULE_TODO_MUTATION_CAPABILITY,
    FLOW_SCHEDULE_REPORT_CAPABILITY,
  ];
  registry.replaceEndpoints(projectSessionEndpoints(v2Owners));
  const runtime = (runtimeStore: FlowScheduleRuntimeStore) => new FlowScheduleRuntime({
    store: runtimeStore,
    brokerRuntime: fileBroker(projectRoot, stateDirectory, now),
    getRegistry: () => registry,
    observe: liveObservation,
    now,
    createDispatchId: () => DISPATCH_A,
  });
  let current: FlowScheduleRuntime | undefined;
  try {
    current = runtime(faultingStore(store, "createDispatchIntent"));
    await assert.rejects(current.start(), /crash after admission actor commit/);
    await current.shutdown();
    assert.equal(await store.readDispatch(DISPATCH_A), undefined);

    current = runtime(faultingStore(store, "recordPublished"));
    await assert.rejects(current.start(), /crash after published actor commit/);
    await current.shutdown();
    assert.ok((await store.readDispatch(DISPATCH_A))?.intent);
    assert.equal((await store.readDispatch(DISPATCH_A))?.published, undefined);

    current = runtime(faultingStore(store, "recordAccepted"));
    await assert.rejects(current.start(), /crash after accepted actor commit/);
    await current.shutdown();
    assert.ok((await store.readDispatch(DISPATCH_A))?.published);
    assert.equal((await store.readDispatch(DISPATCH_A))?.accepted, undefined);

    current = runtime(store);
    await current.start();
    const admitted = (await store.readDispatch(DISPATCH_A))!;
    assert.ok(admitted.accepted);
    await current.shutdown();

    recordIncomingResult(registry, admitted.intent.targetIdentity, createFlowScheduleResult({
      scheduleId: "release",
      stepId: "verify",
      dispatchId: DISPATCH_A,
      outcome: "failed",
      summary: "Crash-window failure",
    }));
    current = runtime(faultingStore(store, "recordCompletion"));
    await assert.rejects(current.start(), /crash after completion actor commit/);
    await current.shutdown();
    assert.equal((await store.readDispatch(DISPATCH_A))?.completion, undefined);

    current = runtime(store);
    await current.start();
    assert.equal((await store.readDispatch(DISPATCH_A))?.completion?.state, "failed");
    assert.equal((await store.readSchedule("release"))?.steps.verify.state, "failed");
    await current.pauseSchedule("release");
    await current.shutdown();

    current = runtime(faultingStore(store, "prepareRetry"));
    await current.start();
    await assert.rejects(current.retrySchedule("release", "verify", "Retry after crash"), /crash after retry actor commit/);
    await current.shutdown();
    assert.equal((await store.readSchedule("release"))?.steps.verify.state, "failed");

    current = runtime(store);
    await current.start();
    assert.equal((await store.readSchedule("release"))?.steps.verify.state, "pending");
    assert.equal((await store.readSchedule("release"))?.state, "paused");
    assert.equal((await store.readBinding(DISPATCH_A))?.state, "ambiguous");
    assert.match((await store.readBinding(DISPATCH_A))?.reason ?? "", /Retry requested: Retry after crash/);
    await current.shutdown();

    current = runtime(faultingStore(store, "updateSchedule"));
    await current.start();
    await assert.rejects(current.cancelSchedule("release", "Cancel after crash"), /crash after cancel actor commit/);
    await current.shutdown();
    assert.equal((await store.readSchedule("release"))?.state, "paused");

    current = runtime(store);
    await current.start();
    assert.equal((await store.readSchedule("release"))?.state, "cancelled");
  } finally {
    await current?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("active cancellation survives schedule and retirement commit crashes without redispatch", async () => {
  for (const stage of ["updateSchedule", "recordCompletion"] as const) {
    const { root, store, now } = await storeHarness({ requireCompleted: true });
    const projectRoot = store.projectRoot;
    const stateDirectory = join(root, "broker");
    let sends = 0;
    const registry = registryWithDelivery(async (host, endpoint, request) => {
      sends += 1;
      recordOutgoing(host, endpoint, request, "injected");
      return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "injected" } };
    });
    const v2Owners = endpointOwners();
    v2Owners[1]!.extraCapabilities = [
      FLOW_SCHEDULE_TODO_PROJECTION_CAPABILITY,
      FLOW_SCHEDULE_TODO_MUTATION_CAPABILITY,
      FLOW_SCHEDULE_REPORT_CAPABILITY,
    ];
    registry.replaceEndpoints(projectSessionEndpoints(v2Owners));
    const dispatchIds = [DISPATCH_A, DISPATCH_B];
    let dispatchCount = 0;
    const makeRuntime = (runtimeStore: FlowScheduleRuntimeStore) => new FlowScheduleRuntime({
      store: runtimeStore,
      brokerRuntime: fileBroker(projectRoot, stateDirectory, now),
      getRegistry: () => registry,
      observe: liveObservation,
      now,
      createDispatchId: () => dispatchIds[dispatchCount++]!,
    });
    let current: FlowScheduleRuntime | undefined;
    try {
      current = makeRuntime(store);
      await current.start();
      assert.ok((await store.readDispatch(DISPATCH_A))?.accepted, stage);
      assert.equal(sends, 1, stage);
      await current.shutdown();

      current = makeRuntime(faultingStore(store, stage));
      await current.start();
      await assert.rejects(
        current.cancelSchedule("release", `Stop active work at ${stage}`),
        stage === "updateSchedule" ? /crash after cancel actor commit/ : /crash after completion actor commit/,
      );
      await current.shutdown();

      current = makeRuntime(store);
      await current.start();
      const schedule = await store.readSchedule("release");
      assert.equal(schedule?.state, "cancelled", stage);
      assert.equal(schedule?.activeStepId, undefined, stage);
      assert.equal(schedule?.steps.verify.state, "cancelled", stage);
      assert.equal((await store.readDispatch(DISPATCH_A))?.completion?.state, "retired", stage);
      assert.equal((await store.readBinding(DISPATCH_A))?.state, "ambiguous", stage);
      assert.match((await store.readBinding(DISPATCH_A))?.reason ?? "", /Schedule cancelled: Stop active work/, stage);
      await current.reconcileReady();
      assert.equal(dispatchCount, 1, `${stage}: cancellation must not allocate a replacement dispatch`);
      assert.equal(sends, 1, `${stage}: cancellation must not send replacement work`);
      assert.equal(await store.readDispatch(DISPATCH_B), undefined, stage);
    } finally {
      await current?.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("runtime observes and revalidates exact identity before intent, then persists intent before send", async () => {
  const { root, store, now } = await storeHarness();
  const events: string[] = [];
  const registry = registryWithDelivery(async (host, endpoint, request) => {
    events.push("send");
    assert.equal(request.authorize?.(), true);
    recordOutgoing(host, endpoint, request, "queued");
    return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "queued", messageId: request.messageId } };
  });
  const runtime = new FlowScheduleRuntime({
    store: tracedStore(store, events),
    getRegistry: () => registry,
    observe: async () => { events.push("observe"); return liveObservation(); },
    now,
    createDispatchId: () => DISPATCH_A,
  });
  try {
    await runtime.reconcileReady();
    assert.deepEqual(events.slice(0, 3), ["observe", "intent", "send"]);
    const bundle = await store.readDispatch(DISPATCH_A);
    assert.ok(bundle?.published);
    assert.equal(bundle?.accepted, undefined, "queued receipt is publication, not consumption");

    registry.thread.transition(flowScheduleDispatchMessageId(DISPATCH_A), "outgoing", "injected", 11);
    await runtime.reconcileReady();
    assert.equal((await store.readDispatch(DISPATCH_A))?.accepted?.deliveryState, "injected");
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("paired Monitor authority callbacks publish only current generations with source=monitor", async () => {
  for (const authority of ["current", "stale", "absent"] as const) {
    const { root, store, now } = await storeHarness();
    const sent: SessionMessageRequest[] = [];
    const registry = registryWithDelivery(async (host, endpoint, request) => {
      sent.push(request);
      recordOutgoing(host, endpoint, request, "queued");
      return {
        delivered: true,
        endpointId: endpoint.id,
        receipt: { publicationStage: "accepted", deliveryStage: "queued", messageId: request.messageId },
      };
    });
    const runtime = new FlowScheduleRuntime({
      store,
      getRegistry: () => registry,
      observe: liveObservation,
      now,
      createDispatchId: () => DISPATCH_A,
      captureMonitorAuthority: () => authority === "absent" ? undefined : { generation: 7 },
      isMonitorAuthorityCurrent: (capture) => authority === "current" && capture.generation === 7,
    });
    try {
      await runtime.reconcileReady();
      assert.equal(sent.length, authority === "current" ? 2 : 0, authority);
      if (authority === "current") {
        assert.equal(sent[0]?.source, "monitor");
        assert.equal(sent[0]?.messageId, flowScheduleDispatchMessageId(DISPATCH_A));
        assert.equal(sent[0]?.messageKind, "request");
        assert.equal(sent[1]?.source, "monitor");
        assert.equal(sent[1]?.messageId, flowScheduleReportReminderMessageId(DISPATCH_A));
        assert.equal(sent[1]?.messageKind, "request");
        assert.equal(sent[1]?.mode, "follow_up");
        assert.equal(sent[1]?.traceId, DISPATCH_A);
        assert.match(sent[1]?.message ?? "", /flow-schedule tool with action=report/);
        assert.match(sent[1]?.message ?? "", new RegExp(DISPATCH_A));
        await runtime.reconcileReady();
        assert.equal(sent.length, 2, "accepted follow-up must remain single-flight across reconciliation");
      } else {
        assert.equal((await store.readDispatch(DISPATCH_A))?.published, undefined, authority);
      }
    } finally {
      runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("timed-out report reminder stays single-flight until runtime recovery", async () => {
  const { root, store, now } = await storeHarness();
  const sent: SessionMessageRequest[] = [];
  const reminderId = flowScheduleReportReminderMessageId(DISPATCH_A);
  let rejectRecovery = false;
  const registry = registryWithDelivery(async (host, endpoint, request) => {
    sent.push(request);
    const reminder = request.messageId === reminderId;
    if (reminder && rejectRecovery) {
      return {
        delivered: false,
        endpointId: endpoint.id,
        receipt: { publicationStage: "rejected", messageId: request.messageId },
      };
    }
    recordOutgoing(host, endpoint, request, reminder ? "timeout" : "queued");
    return reminder
      ? {
          delivered: false,
          endpointId: endpoint.id,
          receipt: { publicationStage: "published", messageId: request.messageId },
        }
      : {
          delivered: true,
          endpointId: endpoint.id,
          receipt: { publicationStage: "accepted", deliveryStage: "queued", messageId: request.messageId },
        };
  });
  const runtimeOptions = {
    store,
    getRegistry: () => registry,
    observe: liveObservation,
    now,
    createDispatchId: () => DISPATCH_A,
    captureMonitorAuthority: () => ({ generation: 7 }),
    isMonitorAuthorityCurrent: (capture: { generation: number }) => capture.generation === 7,
  };
  const first = new FlowScheduleRuntime(runtimeOptions);
  try {
    await first.reconcileReady();
    assert.deepEqual(sent.map((request) => request.messageId), [
      flowScheduleDispatchMessageId(DISPATCH_A),
      reminderId,
    ]);
    await first.reconcileReady();
    assert.equal(sent.length, 2, "the same runtime must not accumulate timed-out follow-ups");
    assert.equal((await store.readDispatch(DISPATCH_A))?.completion, undefined, "a reminder is not a business result");
    first.dispose();
    rejectRecovery = true;

    const recovered = new FlowScheduleRuntime(runtimeOptions);
    try {
      await recovered.reconcileReady();
      assert.deepEqual(sent.map((request) => request.messageId), [
        flowScheduleDispatchMessageId(DISPATCH_A),
        reminderId,
        reminderId,
      ], "runtime recovery may redrive the same deterministic reminder identity once");
      await recovered.reconcileReady();
      assert.equal(sent.length, 3, "a rejected recovery receipt must retain the single-flight latch");
    } finally {
      recovered.dispose();
    }
  } finally {
    first.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("publication receipts without an outgoing reminder journal stay single-flight", async () => {
  for (const stage of ["accepted", "rejected"] as const) {
    const { root, store, now } = await storeHarness();
    const sent: SessionMessageRequest[] = [];
    const reminderId = flowScheduleReportReminderMessageId(DISPATCH_A);
    const registry = registryWithDelivery(async (host, endpoint, request) => {
      sent.push(request);
      if (request.messageId === reminderId) {
        return stage === "accepted"
          ? {
              delivered: true,
              endpointId: endpoint.id,
              receipt: {
                publicationStage: "accepted",
                deliveryStage: "queued",
                messageId: request.messageId,
              },
            }
          : {
              delivered: false,
              endpointId: endpoint.id,
              receipt: { publicationStage: "rejected", messageId: request.messageId },
            };
      }
      recordOutgoing(host, endpoint, request, "queued");
      return {
        delivered: true,
        endpointId: endpoint.id,
        receipt: { publicationStage: "accepted", deliveryStage: "queued", messageId: request.messageId },
      };
    });
    const runtime = new FlowScheduleRuntime({
      store,
      getRegistry: () => registry,
      observe: liveObservation,
      now,
      createDispatchId: () => DISPATCH_A,
      captureMonitorAuthority: () => ({ generation: 7 }),
      isMonitorAuthorityCurrent: (capture) => capture.generation === 7,
    });
    try {
      await runtime.reconcileReady();
      await runtime.reconcileReady();
      assert.deepEqual(sent.map((request) => request.messageId), [
        flowScheduleDispatchMessageId(DISPATCH_A),
        reminderId,
      ], `${stage} receipt without a journal must still latch the reminder attempt`);
      assert.equal(registry.thread.get(reminderId, "outgoing"), undefined);
      assert.equal((await store.readDispatch(DISPATCH_A))?.completion, undefined);
    } finally {
      runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("rejected report reminder is terminal without synthesizing or retrying a result", async () => {
  const { root, store, now } = await storeHarness();
  const sent: SessionMessageRequest[] = [];
  const reminderId = flowScheduleReportReminderMessageId(DISPATCH_A);
  const registry = registryWithDelivery(async (host, endpoint, request) => {
    sent.push(request);
    const reminder = request.messageId === reminderId;
    recordOutgoing(host, endpoint, request, reminder ? "rejected" : "queued");
    return reminder
      ? {
          delivered: false,
          endpointId: endpoint.id,
          receipt: { publicationStage: "rejected", messageId: request.messageId },
        }
      : {
          delivered: true,
          endpointId: endpoint.id,
          receipt: { publicationStage: "accepted", deliveryStage: "queued", messageId: request.messageId },
        };
  });
  const runtimeOptions = {
    store,
    getRegistry: () => registry,
    observe: liveObservation,
    now,
    createDispatchId: () => DISPATCH_A,
    captureMonitorAuthority: () => ({ generation: 7 }),
    isMonitorAuthorityCurrent: (capture: { generation: number }) => capture.generation === 7,
  };
  const first = new FlowScheduleRuntime(runtimeOptions);
  try {
    await first.reconcileReady();
    await first.reconcileReady();
    assert.deepEqual(sent.map((request) => request.messageId), [
      flowScheduleDispatchMessageId(DISPATCH_A),
      reminderId,
    ]);
    assert.equal((await store.readDispatch(DISPATCH_A))?.completion, undefined);
    first.dispose();

    const recovered = new FlowScheduleRuntime(runtimeOptions);
    try {
      await recovered.reconcileReady();
      assert.equal(sent.length, 2, "an exact target rejection cannot be repaired by replaying the same reminder ID");
      assert.equal((await store.readDispatch(DISPATCH_A))?.completion, undefined, "rejection is not a business report");
    } finally {
      recovered.dispose();
    }
  } finally {
    first.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Monitor re-entry publishes the same dispatch prepared while authority was absent", async () => {
  const { root, store, now } = await storeHarness();
  const sent: SessionMessageRequest[] = [];
  let monitorGeneration: number | undefined;
  let dispatchAllocations = 0;
  const registry = registryWithDelivery(async (host, endpoint, request) => {
    sent.push(request);
    recordOutgoing(host, endpoint, request, "queued");
    return {
      delivered: true,
      endpointId: endpoint.id,
      receipt: { publicationStage: "accepted", deliveryStage: "queued", messageId: request.messageId },
    };
  });
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => registry,
    observe: liveObservation,
    now,
    createDispatchId: () => {
      dispatchAllocations += 1;
      return DISPATCH_A;
    },
    captureMonitorAuthority: () => monitorGeneration === undefined ? undefined : { generation: monitorGeneration },
    isMonitorAuthorityCurrent: (capture) => capture.generation === monitorGeneration,
  });
  try {
    await runtime.reconcileReady();
    assert.equal(sent.length, 0);
    assert.equal((await store.readDispatch(DISPATCH_A))?.intent.state, "prepared");
    assert.equal((await store.readDispatch(DISPATCH_A))?.published, undefined);

    monitorGeneration = 9;
    await runtime.reconcileReady();
    assert.equal(dispatchAllocations, 1, "re-entry must reuse the durable prepared intent");
    assert.deepEqual(sent.map((request) => request.messageId), [
      flowScheduleDispatchMessageId(DISPATCH_A),
      flowScheduleReportReminderMessageId(DISPATCH_A),
    ]);
    assert.equal(sent[0]?.traceId, DISPATCH_A);
    assert.equal(sent[0]?.source, "monitor");
    assert.equal(sent[1]?.traceId, DISPATCH_A);
    assert.equal(sent[1]?.source, "monitor");
    assert.equal(sent[1]?.mode, "follow_up");
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("accepted result reconciliation proceeds after Monitor authority becomes inactive", async () => {
  const { root, store, now } = await storeHarness();
  let monitorActive = true;
  let monitorGeneration = 3;
  const registry = registryWithDelivery(async (host, endpoint, request) => {
    recordOutgoing(host, endpoint, request, "injected");
    return {
      delivered: true,
      endpointId: endpoint.id,
      receipt: { publicationStage: "accepted", deliveryStage: "injected", messageId: request.messageId },
    };
  });
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => registry,
    observe: liveObservation,
    now,
    createDispatchId: () => DISPATCH_A,
    captureMonitorAuthority: () => monitorActive ? { generation: monitorGeneration } : undefined,
    isMonitorAuthorityCurrent: (capture) => monitorActive && capture.generation === monitorGeneration,
  });
  try {
    await runtime.reconcileReady();
    const bundle = (await store.readDispatch(DISPATCH_A))!;
    assert.ok(bundle.accepted);

    monitorActive = false;
    monitorGeneration += 1;
    recordIncomingResult(registry, bundle.intent.targetIdentity, createFlowScheduleResult({
      scheduleId: "release",
      stepId: "verify",
      dispatchId: DISPATCH_A,
      outcome: "completed",
      summary: "Reconciled after Monitor exit",
    }));
    await runtime.reconcileReady();
    assert.equal((await store.readSchedule("release"))?.state, "completed");
    assert.equal(
      (await store.readSchedule("release"))?.steps.verify.result?.summary,
      "Reconciled after Monitor exit",
    );
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime replays a durable accepted projection after restart without resending", async () => {
  const { root, store, now } = await storeHarness();
  let sends = 0;
  const registry = registryWithDelivery(async (host, endpoint, request) => {
    sends += 1;
    recordOutgoing(host, endpoint, request, "injected");
    return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "injected" } };
  });
  const first = new FlowScheduleRuntime({
    store,
    getRegistry: () => registry,
    observe: liveObservation,
    now,
    createDispatchId: () => DISPATCH_A,
  });
  try {
    await first.reconcileReady();
    assert.equal((await store.readSchedule("release"))?.steps.verify.state, "awaiting-result");
    first.dispose();

    const schedulePath = join(store.schedulesDir, "release.json");
    const interrupted = JSON.parse(await readFile(schedulePath, "utf8")) as FlowScheduleRecord;
    interrupted.steps.verify.state = "dispatching";
    await writeFile(schedulePath, `${JSON.stringify(interrupted, null, 2)}\n`, "utf8");

    const restartedRegistry = registryWithDelivery(async (host, endpoint, request) => {
      sends += 1;
      recordOutgoing(host, endpoint, request, "injected");
      return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "injected" } };
    });
    const restarted = new FlowScheduleRuntime({ store, getRegistry: () => restartedRegistry, observe: liveObservation, now });
    try {
      await restarted.reconcileReady();
      assert.equal((await store.readSchedule("release"))?.steps.verify.state, "awaiting-result");
      assert.equal(sends, 1, "accepted replay must not publish a second transport message");
    } finally {
      restarted.dispose();
    }
  } finally {
    first.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("routable settled workers survive semantic endpoint refresh during admission", async () => {
  const { root, store, now } = await storeHarness();
  const sent: SessionMessageRequest[] = [];
  const registry = registryWithDelivery(async (host, endpoint, request) => {
    sent.push(request);
    recordOutgoing(host, endpoint, request, "queued");
    return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "queued" } };
  });
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => registry,
    observe: async () => {
      const owners = endpointOwners();
      owners[1] = { ...owners[1], contextPressure: 42 };
      registry.replaceEndpoints(projectSessionEndpoints(owners));
      return {
        action: "status",
        reason: "snapshot",
        observations: [{
          target: { kind: "workspace", id: TARGET },
          found: true,
          nativeStatus: "sleeping",
          phase: "settled",
          terminalStatus: "completed",
          summary: "resident and routable",
          updatedAt: 2,
          capabilities: { inspect: true, wait: true, message: true },
        }],
        durationMs: 0,
      };
    },
    now,
    createDispatchId: () => DISPATCH_A,
  });
  try {
    await runtime.reconcileReady();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.messageId, flowScheduleDispatchMessageId(DISPATCH_A));
    assert.equal(sent[0]?.traceId, DISPATCH_A);
    assert.ok((await store.readDispatch(DISPATCH_A))?.published);
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("identity replacement during observe fails the handshake without creating intent", async () => {
  const { root, store, now } = await storeHarness();
  const events: string[] = [];
  const registry = registryWithDelivery(async () => { throw new Error("send must not run"); });
  const runtime = new FlowScheduleRuntime({
    store: tracedStore(store, events),
    getRegistry: () => registry,
    observe: async () => {
      events.push("observe");
      registry.replaceEndpoints(projectSessionEndpoints(endpointOwners(REPLACEMENT_NONCE)));
      return liveObservation();
    },
    now,
    createDispatchId: () => DISPATCH_A,
  });
  try {
    await runtime.reconcileReady();
    assert.deepEqual(events, ["observe"]);
    assert.equal((await store.readSchedule("release"))?.activeStepId, undefined);
    assert.equal(await store.readDispatch(DISPATCH_A), undefined);
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("target replacement while waiting for the store lock fails the authority fence without an intent", async () => {
  const { root, store, now } = await storeHarness();
  const registry = registryWithDelivery(async () => { throw new Error("send must not run"); });
  const base = tracedStore(store, []);
  const fencedStore: FlowScheduleRuntimeStore = {
    ...base,
    createDispatchIntent(input, authorize) {
      registry.replaceEndpoints(projectSessionEndpoints(endpointOwners(REPLACEMENT_NONCE)));
      return store.createDispatchIntent(input, authorize);
    },
  };
  const runtime = new FlowScheduleRuntime({
    store: fencedStore,
    getRegistry: () => registry,
    observe: liveObservation,
    now,
    createDispatchId: () => DISPATCH_A,
  });
  try {
    await assert.rejects(runtime.reconcileReady(), /authority fence is stale/);
    assert.equal((await store.readSchedule("release"))?.activeStepId, undefined);
    assert.equal(await store.readDispatch(DISPATCH_A), undefined);
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("uncertain publication replays only the same dispatch message ID", async () => {
  const { root, store, now } = await storeHarness();
  const sent: string[] = [];
  let calls = 0;
  const registry = registryWithDelivery(async (host, endpoint, request) => {
    sent.push(request.messageId!);
    assert.equal(request.messageId, flowScheduleDispatchMessageId(request.traceId!));
    calls += 1;
    if (calls === 1) {
      recordOutgoing(host, endpoint, request, "timeout");
      throw new Error("uncertain send");
    }
    return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "injected", messageId: request.messageId } };
  });
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => registry,
    observe: liveObservation,
    now,
    createDispatchId: () => DISPATCH_A,
  });
  try {
    await runtime.reconcileReady();
    await runtime.reconcileReady();
    assert.deepEqual(sent, [flowScheduleDispatchMessageId(DISPATCH_A), flowScheduleDispatchMessageId(DISPATCH_A)]);
    assert.ok((await store.readDispatch(DISPATCH_A))?.published);
    assert.ok((await store.readDispatch(DISPATCH_A))?.accepted);
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("only an exact trusted result advances the current dispatch; stale and late results do not", async () => {
  const { root, store, now } = await storeHarness();
  const registry = registryWithDelivery(async (host, endpoint, request) => {
    recordOutgoing(host, endpoint, request, "queued");
    return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "queued" } };
  });
  const runtime = new FlowScheduleRuntime({ store, getRegistry: () => registry, observe: liveObservation, now, createDispatchId: () => DISPATCH_A });
  try {
    await runtime.reconcileReady();
    const intent = (await store.readDispatch(DISPATCH_A))!.intent;
    recordIncomingResult(registry, intent.targetIdentity, createFlowScheduleResult({
      scheduleId: "release",
      stepId: "verify",
      dispatchId: DISPATCH_B,
      outcome: "completed",
      summary: "Stale",
    }));
    await runtime.reconcileReady();
    assert.equal((await store.readSchedule("release"))?.state, "active");

    recordIncomingResult(registry, intent.targetIdentity, createFlowScheduleResult({
      scheduleId: "release",
      stepId: "verify",
      dispatchId: DISPATCH_A,
      outcome: "completed",
      summary: "Done",
    }));
    await runtime.reconcileReady();
    assert.equal((await store.readSchedule("release"))?.state, "completed");

    await runtime.reconcileReady();
    assert.equal((await store.readSchedule("release"))?.steps.verify.result?.summary, "Done");
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy dispatch and result without completion correlation retain the original acceptance path", async () => {
  const { root, store, now } = await storeHarness();
  const registry = registryWithDelivery(async (host, endpoint, request) => {
    recordOutgoing(host, endpoint, request, "queued");
    return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "queued" } };
  });
  const peer = registry.resolve(TARGET, { includeSettled: true, localFirst: false }).endpoint!;
  const intent = (await store.createDispatchIntent({
    dispatchId: DISPATCH_A,
    scheduleId: "release",
    stepId: "verify",
    targetIdentity: {
      workspaceId: peer.workspaceId,
      endpointId: peer.id,
      ownerId: peer.ownerId,
      ownerNonce: peer.ownerNonce,
      ...(peer.sessionId ? { sessionId: peer.sessionId } : {}),
    },
  })).dispatch;
  recordIncomingResult(registry, intent.targetIdentity, createFlowScheduleResult({
    scheduleId: "release",
    stepId: "verify",
    dispatchId: DISPATCH_A,
    outcome: "completed",
    summary: "Legacy result",
  }), {}, false);
  const runtime = new FlowScheduleRuntime({ store, getRegistry: () => registry, observe: liveObservation, now });
  try {
    await runtime.reconcileReady();
    assert.equal((await store.readSchedule("release"))?.state, "completed");
    assert.equal((await store.readDispatch(DISPATCH_A))?.completion?.result?.completionCorrelation, undefined);
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("one-sided, missing, or mismatched completion correlations are rejected fail-closed", async () => {
  const exactCorrelation = bindWorkspaceCompletionHandle(GENERIC_MESSAGE_ID, {
    workspaceId: WORKSPACE_ID,
    ownerId: LOCAL_OWNER,
    ownerNonce: "2".repeat(32),
  });
  const differentCorrelation = bindWorkspaceCompletionHandle("8".repeat(32), {
    workspaceId: WORKSPACE_ID,
    ownerId: LOCAL_OWNER,
    ownerNonce: "2".repeat(32),
  });
  const cases = [
    { label: "new intent with missing result correlation", intent: exactCorrelation, result: undefined },
    { label: "legacy intent with injected result correlation", intent: undefined, result: exactCorrelation },
    { label: "new intent with mismatched result correlation", intent: exactCorrelation, result: differentCorrelation },
  ] as const;

  for (const testCase of cases) {
    const { root, store, now } = await storeHarness();
    const registry = registryWithDelivery(async (host, endpoint, request) => {
      recordOutgoing(host, endpoint, request, "queued");
      return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "queued" } };
    });
    const peer = registry.resolve(TARGET, { includeSettled: true, localFirst: false }).endpoint!;
    const intent = (await store.createDispatchIntent({
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "verify",
      targetIdentity: {
        workspaceId: peer.workspaceId,
        endpointId: peer.id,
        ownerId: peer.ownerId,
        ownerNonce: peer.ownerNonce,
        ...(peer.sessionId ? { sessionId: peer.sessionId } : {}),
      },
      ...(testCase.intent ? { completionCorrelation: testCase.intent } : {}),
    })).dispatch;
    recordIncomingResult(registry, intent.targetIdentity, createFlowScheduleResult({
      scheduleId: "release",
      stepId: "verify",
      dispatchId: DISPATCH_A,
      outcome: "completed",
      summary: testCase.label,
      ...(testCase.result ? { completionCorrelation: testCase.result } : {}),
    }), {}, false);
    const runtime = new FlowScheduleRuntime({ store, getRegistry: () => registry, observe: liveObservation, now });
    try {
      await runtime.reconcileReady();
      assert.equal((await store.readDispatch(DISPATCH_A))?.completion, undefined, testCase.label);
      assert.equal((await store.readSchedule("release"))?.state, "active", testCase.label);
    } finally {
      runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("capability mismatch silently degrades Todo binding to legacy gate-none dispatch", async () => {
  const { root, store, now } = await storeHarness({ requireCompleted: true, conflictCheck: true });
  let dispatchedTodoBinding: unknown;
  let dispatchedInstruction = "";
  const registry = registryWithDelivery(async (host, endpoint, request) => {
    const envelope = decodeFlowScheduleDispatch(request.message);
    dispatchedTodoBinding = envelope.todoBinding;
    dispatchedInstruction = envelope.instruction;
    recordOutgoing(host, endpoint, request, "queued");
    return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "queued" } };
  });
  const runtime = new FlowScheduleRuntime({ store, getRegistry: () => registry, observe: liveObservation, now, createDispatchId: () => DISPATCH_A });
  try {
    await runtime.reconcileReady();
    const bundle = (await store.readDispatch(DISPATCH_A))!;
    assert.equal(dispatchedTodoBinding, undefined);
    assert.doesNotMatch(dispatchedInstruction, /todo binding/i);
    assert.equal(bundle.binding, undefined);

    registry.replaceEndpoints(projectSessionEndpoints(endpointOwners(PEER_NONCE, true)));
    await runtime.reconcileReady();
    assert.equal((await store.readDispatch(DISPATCH_A))?.binding, undefined, "legacy degradation stays frozen after publication");

    recordIncomingResult(registry, bundle.intent.targetIdentity, createFlowScheduleResult({
      scheduleId: "release",
      stepId: "verify",
      dispatchId: DISPATCH_A,
      outcome: "completed",
      summary: "Legacy worker completed",
    }));
    await runtime.reconcileReady();
    assert.equal((await store.readSchedule("release"))?.state, "completed");
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("supported Todo gate records pending before dispatch and completes only with completed evidence", async () => {
  const { root, store, now } = await storeHarness({ requireCompleted: true, conflictCheck: true });
  let dispatchedTodoBinding: unknown;
  const registry = registryWithDelivery(async (host, endpoint, request) => {
    dispatchedTodoBinding = decodeFlowScheduleDispatch(request.message).todoBinding;
    recordOutgoing(host, endpoint, request, "injected");
    return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "injected" } };
  }, true);
  const runtime = new FlowScheduleRuntime({ store, getRegistry: () => registry, observe: liveObservation, now, createDispatchId: () => DISPATCH_A });
  try {
    await runtime.reconcileReady();
    const bundle = (await store.readDispatch(DISPATCH_A))!;
    assert.deepEqual(dispatchedTodoBinding, { requireCompleted: true, conflictCheck: true });
    assert.equal(bundle.binding?.state, "pending");

    recordIncomingResult(registry, bundle.intent.targetIdentity, createFlowScheduleResult({
      scheduleId: "release",
      stepId: "verify",
      dispatchId: DISPATCH_A,
      outcome: "completed",
      summary: "Todo completed",
      todoOutcome: { todoId: "todo-1", todoStatus: "completed" },
    }));
    await runtime.reconcileReady();
    assert.equal((await store.readSchedule("release"))?.state, "completed");
    assert.deepEqual(await store.readBinding(DISPATCH_A), {
      ...bundle.binding,
      todoId: "todo-1",
      todoStatus: "completed",
      state: "completed",
      updatedAt: (await store.readBinding(DISPATCH_A))!.updatedAt,
    });
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed exact result with Todo evidence terminalizes binding failed", async () => {
  const { root, store, now } = await storeHarness({ requireCompleted: true });
  const registry = registryWithDelivery(async (host, endpoint, request) => {
    recordOutgoing(host, endpoint, request, "injected");
    return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "injected" } };
  }, true);
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => registry,
    observe: liveObservation,
    now,
    createDispatchId: () => DISPATCH_A,
  });
  try {
    await runtime.reconcileReady();
    const bundle = (await store.readDispatch(DISPATCH_A))!;
    recordIncomingResult(registry, bundle.intent.targetIdentity, createFlowScheduleResult({
      scheduleId: "release",
      stepId: "verify",
      dispatchId: DISPATCH_A,
      outcome: "failed",
      summary: "Todo execution failed",
      todoOutcome: { todoId: "todo-failed", todoStatus: "failed" },
    }));
    await runtime.reconcileReady();

    assert.equal((await store.readSchedule("release"))?.steps.verify.state, "failed");
    assert.equal((await store.readBinding(DISPATCH_A))?.state, "failed");
    assert.equal((await store.readBinding(DISPATCH_A))?.todoId, "todo-failed");
    assert.equal((await store.readBinding(DISPATCH_A))?.reason, "Todo execution failed");
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("requireCompleted keeps missing or non-completed evidence awaiting until timeout", async () => {
  const cases: Array<{ label: string; todoStatus?: "pending" | "in_progress" | "blocked" }> = [
    { label: "missing" },
    { label: "pending", todoStatus: "pending" },
    { label: "in-progress", todoStatus: "in_progress" },
    { label: "blocked", todoStatus: "blocked" },
  ];
  for (const testCase of cases) {
    const { root, store } = await storeHarness({ requireCompleted: true });
    let clock = 100;
    const registry = registryWithDelivery(async (host, endpoint, request) => {
      recordOutgoing(host, endpoint, request, "injected");
      return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "injected" } };
    }, true);
    const runtime = new FlowScheduleRuntime({
      store,
      getRegistry: () => registry,
      observe: liveObservation,
      now: () => clock,
      todoGateTimeoutMs: 1_000,
      createDispatchId: () => DISPATCH_A,
    });
    try {
      await runtime.reconcileReady();
      const bundle = (await store.readDispatch(DISPATCH_A))!;
      recordIncomingResult(registry, bundle.intent.targetIdentity, createFlowScheduleResult({
        scheduleId: "release",
        stepId: "verify",
        dispatchId: DISPATCH_A,
        outcome: "completed",
        summary: testCase.label,
        ...(testCase.todoStatus ? { todoOutcome: { todoId: `todo-${testCase.label}`, todoStatus: testCase.todoStatus } } : {}),
      }), { createdAt: 100, updatedAt: 100 });

      await runtime.reconcileReady();
      assert.equal((await store.readSchedule("release"))?.steps.verify.state, "awaiting-result", testCase.label);
      assert.equal((await store.readDispatch(DISPATCH_A))?.completion, undefined, testCase.label);

      clock = 1_100;
      await runtime.reconcileReady();
      assert.equal((await store.readSchedule("release"))?.steps.verify.state, "ambiguous", testCase.label);
      assert.equal((await store.readBinding(DISPATCH_A))?.state, "ambiguous", testCase.label);
    } finally {
      runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("conflictCheck rejects explicit non-completed evidence immediately and stale todoId only after timeout", async () => {
  for (const stale of [false, true]) {
    const { root, store } = await storeHarness(stale
      ? { requireCompleted: true, conflictCheck: true }
      : { conflictCheck: true });
    let clock = 100;
    const registry = registryWithDelivery(async (host, endpoint, request) => {
      recordOutgoing(host, endpoint, request, "injected");
      return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "injected" } };
    }, true);
    const runtime = new FlowScheduleRuntime({
      store,
      getRegistry: () => registry,
      observe: liveObservation,
      now: () => clock,
      todoGateTimeoutMs: 1_000,
      createDispatchId: () => DISPATCH_A,
    });
    try {
      await runtime.reconcileReady();
      let bundle = (await store.readDispatch(DISPATCH_A))!;
      if (stale) {
        await store.recordBinding({
          ...bundle.binding!,
          state: "bound",
          todoId: "todo-current",
          todoStatus: "in_progress",
          updatedAt: 101,
        });
        bundle = (await store.readDispatch(DISPATCH_A))!;
      }
      recordIncomingResult(registry, bundle.intent.targetIdentity, createFlowScheduleResult({
        scheduleId: "release",
        stepId: "verify",
        dispatchId: DISPATCH_A,
        outcome: "completed",
        summary: stale ? "Stale Todo" : "Todo still running",
        todoOutcome: stale
          ? { todoId: "todo-stale", todoStatus: "completed" }
          : { todoId: "todo-current", todoStatus: "in_progress" },
      }), { createdAt: 100, updatedAt: 100 });

      await runtime.reconcileReady();
      if (stale) {
        assert.equal((await store.readSchedule("release"))?.steps.verify.state, "awaiting-result");
        clock = 1_100;
        await runtime.reconcileReady();
      }
      assert.equal((await store.readSchedule("release"))?.steps.verify.state, "ambiguous");
      assert.equal((await store.readBinding(DISPATCH_A))?.state, "ambiguous");
      if (stale) assert.equal((await store.readBinding(DISPATCH_A))?.todoId, "todo-current");
    } finally {
      runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("paused schedules admit no new work but reconcile an active attempt result", async () => {
  const first = await storeHarness();
  const idleRegistry = registryWithDelivery(async () => { throw new Error("paused schedule must not send"); });
  const idleRuntime = new FlowScheduleRuntime({
    store: first.store,
    getRegistry: () => idleRegistry,
    observe: liveObservation,
    now: first.now,
    createDispatchId: () => DISPATCH_A,
  });
  try {
    await idleRuntime.pauseSchedule("release");
    await idleRuntime.reconcileReady();
    assert.equal((await first.store.readSchedule("release"))?.activeStepId, undefined);
  } finally {
    idleRuntime.dispose();
    await rm(first.root, { recursive: true, force: true });
  }

  const second = await storeHarness();
  const activeRegistry = registryWithDelivery(async (host, endpoint, request) => {
    recordOutgoing(host, endpoint, request, "queued");
    return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "queued" } };
  });
  const activeRuntime = new FlowScheduleRuntime({
    store: second.store,
    getRegistry: () => activeRegistry,
    observe: liveObservation,
    now: second.now,
    createDispatchId: () => DISPATCH_A,
  });
  try {
    await activeRuntime.reconcileReady();
    await activeRuntime.pauseSchedule("release");
    const intent = (await second.store.readDispatch(DISPATCH_A))!.intent;
    recordIncomingResult(activeRegistry, intent.targetIdentity, createFlowScheduleResult({
      scheduleId: "release",
      stepId: "verify",
      dispatchId: DISPATCH_A,
      outcome: "completed",
      summary: "Completed while paused",
    }));
    await activeRuntime.reconcileReady();
    assert.equal((await second.store.readSchedule("release"))?.state, "completed");
  } finally {
    activeRuntime.dispose();
    await rm(second.root, { recursive: true, force: true });
  }
});

test("cancelling an active attempt retires it and terminalizes its binding without resending", async () => {
  const { root, store, now } = await storeHarness({ requireCompleted: true });
  let sends = 0;
  const registry = registryWithDelivery(async (host, endpoint, request) => {
    sends += 1;
    recordOutgoing(host, endpoint, request, "queued");
    return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "queued" } };
  }, true);
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => registry,
    observe: liveObservation,
    now,
    createDispatchId: () => DISPATCH_A,
  });
  try {
    await runtime.reconcileReady();
    const cancelled = await runtime.cancelSchedule("release", "Operator cancelled");
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.activeStepId, undefined);
    assert.equal((await store.readDispatch(DISPATCH_A))?.completion?.state, "retired");
    assert.equal((await store.readBinding(DISPATCH_A))?.state, "ambiguous");
    assert.match((await store.readBinding(DISPATCH_A))?.reason ?? "", /Schedule cancelled: Operator cancelled/);
    await runtime.reconcileReady();
    assert.equal(sends, 1);
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Todo-bound dispatch with no exact report times out binding and step ambiguous", async () => {
  const { root, store } = await storeHarness({ requireCompleted: true });
  let clock = 100;
  const registry = registryWithDelivery(async (host, endpoint, request) => {
    recordOutgoing(host, endpoint, request, "injected");
    return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "injected" } };
  }, true);
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => registry,
    observe: liveObservation,
    now: () => clock,
    todoGateTimeoutMs: 1_000,
    createDispatchId: () => DISPATCH_A,
  });
  try {
    await runtime.reconcileReady();
    assert.equal((await store.readBinding(DISPATCH_A))?.state, "pending");
    assert.equal((await store.readSchedule("release"))?.steps.verify.state, "awaiting-result");

    clock = 1_100;
    await runtime.reconcileReady();
    assert.equal((await store.readBinding(DISPATCH_A))?.state, "ambiguous");
    assert.equal((await store.readDispatch(DISPATCH_A))?.completion?.state, "ambiguous");
    assert.equal((await store.readSchedule("release"))?.steps.verify.state, "ambiguous");
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("retry terminalizes a failed attempt binding before creating the next dispatch", async () => {
  const { root, store, now } = await storeHarness({ requireCompleted: true });
  const registry = registryWithDelivery(async (host, endpoint, request) => {
    recordOutgoing(host, endpoint, request, "injected");
    return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "injected" } };
  }, true);
  let nextDispatch = 0;
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => registry,
    observe: liveObservation,
    now,
    createDispatchId: () => [DISPATCH_A, DISPATCH_B][nextDispatch++] ?? DISPATCH_B,
  });
  try {
    await runtime.reconcileReady();
    const first = (await store.readDispatch(DISPATCH_A))!;
    recordIncomingResult(registry, first.intent.targetIdentity, createFlowScheduleResult({
      scheduleId: "release",
      stepId: "verify",
      dispatchId: DISPATCH_A,
      outcome: "failed",
      summary: "Worker failed before reporting Todo evidence",
    }));
    await runtime.reconcileReady();
    assert.equal((await store.readSchedule("release"))?.steps.verify.state, "failed");
    assert.equal((await store.readBinding(DISPATCH_A))?.state, "pending");

    const prepared = await runtime.retrySchedule("release", "verify", "Retry partial failure");
    assert.equal(prepared.steps.verify.state, "pending");
    assert.equal((await store.readBinding(DISPATCH_A))?.state, "ambiguous");
    assert.match((await store.readBinding(DISPATCH_A))?.reason ?? "", /Retry requested: Retry partial failure/);
    assert.equal((await store.readDispatch(DISPATCH_B))?.binding?.state, "pending");
    assert.deepEqual((await store.readSchedule("release"))?.steps.verify.attempts, [DISPATCH_A, DISPATCH_B]);
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("target replacement and terminal-without-result settle ambiguous and require explicit retry", async () => {
  for (const terminal of [false, true]) {
    const { root, store, now } = await storeHarness();
    let terminalObservation = false;
    const registry = registryWithDelivery(async (host, endpoint, request) => {
      recordOutgoing(host, endpoint, request, "queued");
      return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "queued" } };
    });
    let nextDispatch = 0;
    const runtime = new FlowScheduleRuntime({
      store,
      getRegistry: () => registry,
      observe: async () => terminalObservation ? {
        action: "status",
        reason: "snapshot",
        observations: [{ target: { kind: "workspace", id: TARGET }, found: true, nativeStatus: "settled", phase: "settled", terminalStatus: "completed", summary: "settled", updatedAt: 2 }],
        durationMs: 0,
      } : liveObservation(),
      now,
      createDispatchId: () => [DISPATCH_A, DISPATCH_B][nextDispatch++] ?? DISPATCH_B,
    });
    try {
      await runtime.reconcileReady();
      if (terminal) terminalObservation = true;
      else registry.replaceEndpoints(projectSessionEndpoints(endpointOwners(REPLACEMENT_NONCE)));
      await runtime.reconcileReady();
      let schedule = (await store.readSchedule("release"))!;
      assert.equal(schedule.steps.verify.state, "ambiguous");
      await runtime.reconcileReady();
      assert.equal((await store.readSchedule("release"))?.steps.verify.attempts.length, 1);

      schedule = await runtime.retrySchedule("release", "verify", "Operator approved retry");
      assert.equal(schedule.steps.verify.state, "pending");
      assert.match(schedule.reason!, /Operator approved/);
    } finally {
      runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("generic failed, cancelled, and no-result lifecycle evidence maps to schedule ambiguous without synthesizing a business report", async () => {
  for (const outcome of ["failed", "cancelled", "no-result"] as const) {
    const { root, store, now } = await storeHarness();
    const registry = registryWithDelivery(async (host, endpoint, request) => {
      recordOutgoing(host, endpoint, request, "injected");
      return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "injected" } };
    });
    const runtime = new FlowScheduleRuntime({
      store,
      getRegistry: () => registry,
      observe: liveObservation,
      now,
      createDispatchId: () => DISPATCH_A,
    });
    try {
      await runtime.reconcileReady();
      const bundle = (await store.readDispatch(DISPATCH_A))!;
      assert.equal(bundle.intent.completionCorrelation?.messageId, GENERIC_MESSAGE_ID);
      recordGenericTerminal(registry, bundle.intent.targetIdentity, outcome);
      await runtime.reconcileReady();
      const completed = (await store.readDispatch(DISPATCH_A))?.completion;
      assert.equal(completed?.state, "ambiguous", outcome);
      assert.match(completed?.reason ?? "", new RegExp(`lifecycle ${outcome}`), outcome);
      assert.match(completed?.reason ?? "", /settledAt=31/, outcome);
      if (outcome === "failed") assert.match(completed?.reason ?? "", /error=Worker runtime failed/, outcome);
      if (outcome === "cancelled") assert.match(completed?.reason ?? "", /error=Worker was cancelled/, outcome);
      assert.equal(completed?.result, undefined, "generic lifecycle is not a Flow business outcome");
    } finally {
      runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("worker report derives its destination from a trusted inbound dispatch and publishes trusted status", async () => {
  let publishedRequest: SessionMessageRequest | undefined;
  const registry = registryWithDelivery(async (_host, endpoint, request) => {
    publishedRequest = request;
    assert.equal(request.authorize?.(), true);
    return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "queued" } };
  });
  const peer = registry.resolve(TARGET, { includeSettled: true, localFirst: false }).endpoint!;
  const envelope = createFlowScheduleDispatchEnvelope({
    scheduleId: "release",
    stepId: "verify",
    dispatchId: DISPATCH_A,
    instruction: "Run verification",
  });
  const inbound = registry.thread.record({
    messageId: flowScheduleDispatchMessageId(DISPATCH_A),
    workspaceId: peer.workspaceId,
    peerOwnerId: peer.ownerId,
    peerOwnerNonce: peer.ownerNonce,
    direction: "incoming",
    source: "system",
    messageKind: "request",
    traceId: DISPATCH_A,
    replyTo: TARGET,
    targetSessionId: "local-session",
    mode: "follow_up",
    body: encodeFlowScheduleDispatch(envelope),
    status: "injected",
    createdAt: 10,
    updatedAt: 10,
  });

  const report = await publishFlowScheduleReport({ registry, inbound, outcome: "completed", summary: "Verified" });
  assert.equal(report.resultMessageId, flowScheduleResultMessageId(DISPATCH_A));
  assert.equal(report.completionCorrelation?.messageId, GENERIC_MESSAGE_ID);
  assert.equal(publishedRequest?.selector, peer.id);
  assert.equal(publishedRequest?.messageId, flowScheduleResultTransportMessageId(DISPATCH_A));
  assert.equal(publishedRequest?.traceId, DISPATCH_A);
  assert.equal(publishedRequest?.messageKind, "status");
  assert.equal(publishedRequest?.trustedStatus, true);
});

test("legacy worker report publishes without a generic completion handle", async () => {
  let publishedRequest: SessionMessageRequest | undefined;
  const registry = registryWithDelivery(async (_host, endpoint, request) => {
    publishedRequest = request;
    return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "queued" } };
  }, false, false);
  const peer = registry.resolve(TARGET, { includeSettled: true, localFirst: false }).endpoint!;
  const inbound = registry.thread.record({
    messageId: flowScheduleDispatchMessageId(DISPATCH_A),
    workspaceId: peer.workspaceId,
    peerOwnerId: peer.ownerId,
    peerOwnerNonce: peer.ownerNonce,
    direction: "incoming",
    source: "system",
    messageKind: "request",
    traceId: DISPATCH_A,
    replyTo: TARGET,
    targetSessionId: "local-session",
    mode: "follow_up",
    body: encodeFlowScheduleDispatch(createFlowScheduleDispatchEnvelope({
      scheduleId: "release",
      stepId: "verify",
      dispatchId: DISPATCH_A,
      instruction: "Run verification",
    })),
    status: "injected",
    createdAt: 10,
    updatedAt: 10,
  });

  const report = await publishFlowScheduleReport({ registry, inbound, outcome: "completed", summary: "Legacy verified" });
  assert.equal(report.completionCorrelation, undefined);
  const publishedResult = JSON.parse(publishedRequest!.message) as { completionCorrelation?: unknown; resources: string[] };
  assert.equal(publishedResult.completionCorrelation, undefined);
  assert.deepEqual(publishedResult.resources, []);
});

test("disposing during observation aborts the runtime before it can claim or send", async () => {
  const { root, store, now } = await storeHarness();
  const registry = registryWithDelivery(async () => { throw new Error("send must not run"); });
  let observedSignal: AbortSignal | undefined;
  let releaseObservation!: (value: Awaited<ReturnType<typeof liveObservation>>) => void;
  let markObserved!: () => void;
  const observed = new Promise<void>((resolve) => { markObserved = resolve; });
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => registry,
    observe: async (_params, signal) => {
      observedSignal = signal;
      markObserved();
      return new Promise((resolve) => { releaseObservation = resolve; });
    },
    now,
    createDispatchId: () => DISPATCH_A,
  });
  try {
    const reconciling = runtime.reconcileReady();
    await observed;
    runtime.dispose();
    releaseObservation(await liveObservation());
    await reconciling;
    assert.equal(observedSignal?.aborted, true);
    assert.equal(await store.readDispatch(DISPATCH_A), undefined);
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime disposal cancels its bounded SchedulerCore interval", async () => {
  const { root, store, now } = await storeHarness();
  const registry = registryWithDelivery(async () => ({ delivered: false }));
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const cleared: unknown[] = [];
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => registry,
    observe: liveObservation,
    now,
    reconcileIntervalMs: 500,
    schedulerOptions: {
      setTimer(callback, delay) {
        const timer = { callback, delay };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer(timer) { cleared.push(timer); },
    },
  });
  try {
    await runtime.start();
    assert.equal(timers.at(-1)?.delay, 500);
    runtime.dispose();
    assert.equal(cleared.length, 1);
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// admitNext deferral: the defect these tests lock down is that a schedule whose
// target worker is unreachable used to spin silently at active 0/N forever
// (no dispatch, no diagnostic, no failure). After the fix, each deferral is
// recorded on the schedule, emitted as an admit-deferred event, shown by
// status, and eventually escalates the schedule to failed.
// ---------------------------------------------------------------------------

function localOnlyRegistry(): SessionHostRegistry {
  return new SessionHostRegistry({
    surface: "unified",
    endpoints: projectSessionEndpoints([{
      workspaceId: WORKSPACE_ID,
      ownerId: LOCAL_OWNER,
      ownerNonce: "2".repeat(32),
      scope: "local" as const,
      status: "running" as const,
      sessionId: "local-session",
      agents: [],
    }]),
    adapters: [createWorkspacePeerV1TransportAdapter(async () => ({
      delivered: true,
      endpointId: "x",
      transport: "workspace-peer-v1",
      receipt: { publicationStage: "accepted", deliveryStage: "injected", messageId: "x" },
    }))],
  });
}

function notFoundObservation() {
  return Promise.resolve({
    action: "status" as const,
    reason: "snapshot" as const,
    observations: [{
      target: { kind: "workspace" as const, id: TARGET },
      found: false,
      nativeStatus: "not-found",
      phase: "unknown" as const,
      summary: "window unavailable",
      updatedAt: 1,
    }],
    durationMs: 0,
  });
}

test("admitNext records lastAdmitReason, emits admit-deferred, and status shows it when the target endpoint is unresolvable", async () => {
  const { root, store, now } = await storeHarness();
  const events: FlowScheduleRuntimeEvent[] = [];
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => localOnlyRegistry(),
    observe: notFoundObservation,
    now,
    createDispatchId: () => DISPATCH_A,
    admitFailureThreshold: 10,
  });
  runtime.subscribe((event) => events.push(event));
  try {
    await runtime.reconcileReady();
    const schedule = await store.readSchedule("release");
    assert.equal(schedule?.state, "active");
    assert.equal(schedule?.admitAttempts, 1);
    assert.ok(schedule?.lastAdmitReason);
    assert.match(schedule!.lastAdmitReason!, /not resolvable/i);
    assert.ok(events.some((event) => event.type === "admit-deferred" && event.scheduleId === "release"));
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("admitNext escalates an active schedule to failed after admitFailureThreshold consecutive deferrals", async () => {
  const { root, store, now } = await storeHarness();
  let observeCount = 0;
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => localOnlyRegistry(),
    observe: async () => { observeCount += 1; return notFoundObservation(); },
    now,
    createDispatchId: () => DISPATCH_A,
    admitFailureThreshold: 3,
  });
  try {
    // Three reconcile cycles each defer once (captureTarget fails before observe, but observe is only reached if capture succeeds).
    await runtime.reconcileReady();
    await runtime.reconcileReady();
    await runtime.reconcileReady();
    const schedule = await store.readSchedule("release");
    assert.equal(schedule?.state, "failed");
    assert.equal(schedule?.admitAttempts, 3);
    assert.match(schedule?.reason ?? "", /not reachable after 3 admission attempts/i);
    assert.equal(observeCount, 0, "captureTarget fails first; observe is never reached when the endpoint is unresolvable");
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("admitNext deferral is recorded when the target is resolvable but observation is not live", async () => {
  const { root, store, now } = await storeHarness();
  // A registry whose peer endpoint IS resolvable (so captureTarget succeeds) but observe reports not-found (window exited).
  const registry = registryWithDelivery(async () => ({
    delivered: true,
    endpointId: "x",
    transport: "workspace-peer-v1",
    receipt: { publicationStage: "accepted", deliveryStage: "injected", messageId: "x" },
  }));
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => registry,
    observe: notFoundObservation,
    now,
    createDispatchId: () => DISPATCH_A,
    admitFailureThreshold: 10,
  });
  try {
    await runtime.reconcileReady();
    const schedule = await store.readSchedule("release");
    assert.equal(schedule?.state, "active");
    assert.equal(schedule?.admitAttempts, 1);
    assert.match(schedule?.lastAdmitReason ?? "", /not live/i);
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("successful dispatch resets the deferral counters so a later stale episode counts from zero", async () => {
  const { root, store, now } = await storeHarness();
  const events: string[] = [];
  // First reconcile: target is unresolvable (no peer endpoint), so it defers.
  // Second reconcile: install a live peer endpoint + live observation so admission succeeds.
  let peerPresent = false;
  const liveRegistry = new SessionHostRegistry({
    surface: "unified",
    endpoints: projectSessionEndpoints(endpointOwners()),
    adapters: [createWorkspacePeerV1TransportAdapter(async (host, endpoint, request) => {
      events.push("send");
      recordOutgoing(host, endpoint, request, "queued");
      return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "queued" } };
    })],
  });
  const observe = async () => peerPresent ? liveObservation() : notFoundObservation();
  const getRegistry = () => peerPresent ? liveRegistry : localOnlyRegistry();
  const runtime = new FlowScheduleRuntime({
    store: tracedStore(store, events),
    getRegistry,
    observe,
    now,
    createDispatchId: () => DISPATCH_A,
    admitFailureThreshold: 10,
  });
  try {
    await runtime.reconcileReady();
    assert.equal((await store.readSchedule("release"))?.admitAttempts, 1);
    peerPresent = true;
    await runtime.reconcileReady();
    const schedule = await store.readSchedule("release");
    assert.equal(schedule?.admitAttempts, 0);
    assert.equal(schedule?.lastAdmitReason, undefined);
    assert.deepEqual(schedule?.steps.verify.attempts, [DISPATCH_A]);
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("admitNext deferral reason diagnoses an unresolved selector with directory contents", async () => {
  const { root, store, now } = await storeHarness();
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => localOnlyRegistry(),
    observe: notFoundObservation,
    now,
    createDispatchId: () => DISPATCH_A,
    admitFailureThreshold: 10,
    refreshRegistryTargets: async () => {},
  });
  try {
    await runtime.reconcileReady();
    const reason = (await store.readSchedule("release"))?.lastAdmitReason ?? "";
    assert.match(reason, /did not resolve \(not_found/);
    assert.match(reason, /1 root endpoint\(s\)/);
    assert.match(reason, /scope=local/);
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("admitNext deferral reason reports session host registry unavailability", async () => {
  const { root, store, now } = await storeHarness();
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => undefined,
    observe: notFoundObservation,
    now,
    createDispatchId: () => DISPATCH_A,
    admitFailureThreshold: 10,
    refreshRegistryTargets: async () => {},
  });
  try {
    await runtime.reconcileReady();
    const reason = (await store.readSchedule("release"))?.lastAdmitReason ?? "";
    assert.match(reason, /session host registry is unavailable/);
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("admission refresh hook recovers a stale endpoint directory before deferring", async () => {
  const { root, store, now } = await storeHarness();
  const events: string[] = [];
  let peerPresent = false;
  let refreshCalls = 0;
  const liveRegistry = new SessionHostRegistry({
    surface: "unified",
    endpoints: projectSessionEndpoints(endpointOwners()),
    adapters: [createWorkspacePeerV1TransportAdapter(async (host, endpoint, request) => {
      events.push("send");
      recordOutgoing(host, endpoint, request, "queued");
      return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "queued" } };
    })],
  });
  const runtime = new FlowScheduleRuntime({
    store: tracedStore(store, events),
    getRegistry: () => peerPresent ? liveRegistry : localOnlyRegistry(),
    observe: async () => peerPresent ? liveObservation() : notFoundObservation(),
    now,
    createDispatchId: () => DISPATCH_A,
    admitFailureThreshold: 10,
    refreshRegistryTargets: async () => { refreshCalls += 1; peerPresent = true; },
  });
  try {
    await runtime.reconcileReady();
    const schedule = await store.readSchedule("release");
    assert.equal(refreshCalls, 1, "the refresh hook is invoked once after the first capture failure");
    assert.deepEqual(schedule?.steps.verify.attempts, [DISPATCH_A], "admission recovered and dispatched without a deferral");
    assert.equal(schedule?.admitAttempts ?? 0, 0);
    assert.ok(events.includes("send"));
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("admitNext deferral is not recorded when there is no pending step to admit (normal idle)", async () => {
  const { root, store, now } = await storeHarness();
  // All steps complete + a result: a terminal schedule is never reconciled for admission, so no deferral is recorded.
  await store.createDispatchIntent({
    dispatchId: DISPATCH_A,
    scheduleId: "release",
    stepId: "verify",
    targetIdentity: {
      workspaceId: WORKSPACE_ID,
      endpointId: "e",
      ownerId: PEER_OWNER,
      ownerNonce: PEER_NONCE,
      sessionId: "peer-session",
    },
  });
  await store.recordCompletion({
    version: 1,
    type: "flow-schedule-completion",
    dispatchId: DISPATCH_A,
    scheduleId: "release",
    stepId: "verify",
    targetIdentity: {
      workspaceId: WORKSPACE_ID,
      endpointId: "e",
      ownerId: PEER_OWNER,
      ownerNonce: PEER_NONCE,
      sessionId: "peer-session",
    },
    state: "completed",
    result: createFlowScheduleResult({
      scheduleId: "release",
      stepId: "verify",
      dispatchId: DISPATCH_A,
      outcome: "completed",
      summary: "done",
      resources: [],
    }),
    completedAt: 50,
  });
  assert.equal((await store.readSchedule("release"))?.state, "completed");
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => localOnlyRegistry(),
    observe: notFoundObservation,
    now,
    createDispatchId: () => DISPATCH_A,
    admitFailureThreshold: 2,
  });
  try {
    await runtime.reconcileReady();
    const schedule = await store.readSchedule("release");
    assert.equal(schedule?.state, "completed");
    assert.equal(schedule?.admitAttempts, undefined, "terminal schedule is not reconciled for admission");
    assert.equal(schedule?.lastAdmitReason, undefined);
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
