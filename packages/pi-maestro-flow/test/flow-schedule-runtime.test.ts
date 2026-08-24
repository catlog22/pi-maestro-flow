import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
  encodeFlowScheduleDispatch,
  encodeFlowScheduleResult,
  flowScheduleResultMessageId,
} from "../src/flow-schedule/protocol.ts";
import {
  FlowScheduleRuntime,
  publishFlowScheduleReport,
  type FlowScheduleRuntimeStore,
} from "../src/flow-schedule/runtime.ts";
import { FlowScheduleStore } from "../src/flow-schedule/store.ts";
import type { ExactWindowIdentity, FlowScheduleRecord } from "../src/flow-schedule/types.ts";

const LOCAL_OWNER = "1".repeat(32);
const PEER_OWNER = "a".repeat(32);
const PEER_NONCE = "b".repeat(32);
const REPLACEMENT_NONCE = "c".repeat(32);
const DISPATCH_A = "123e4567-e89b-42d3-a456-426614174000";
const DISPATCH_B = "223e4567-e89b-42d3-a456-426614174000";
const TARGET = `owner:${PEER_OWNER}`;

function endpointOwners(peerNonce = PEER_NONCE) {
  return [
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
      ownerNonce: peerNonce,
      scope: "workspace-peer" as const,
      status: "running" as const,
      sessionId: peerNonce === PEER_NONCE ? "peer-session" : "replacement-session",
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
): SessionHostRegistry {
  let registry!: SessionHostRegistry;
  registry = new SessionHostRegistry({
    surface: "unified",
    endpoints: projectSessionEndpoints(endpointOwners()),
    adapters: [createWorkspacePeerV1TransportAdapter((endpoint, request) => deliver(registry, endpoint, request))],
  });
  return registry;
}

async function storeHarness() {
  const root = await mkdtemp(join(tmpdir(), "flow-schedule-runtime-"));
  let now = 100;
  const store = new FlowScheduleStore(join(root, "workspace"), {
    now: () => now++,
    getProcessIdentity: () => `test:${process.pid}`,
  });
  await store.createSchedule({
    scheduleId: "release",
    target: TARGET,
    steps: [{ stepId: "verify", prompt: "Run verification" }],
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
  };
}

function recordIncomingResult(
  registry: SessionHostRegistry,
  identity: ExactWindowIdentity,
  result: ReturnType<typeof createFlowScheduleResult>,
  overrides: Partial<WindowThreadEntry> = {},
): WindowThreadEntry {
  const messageId = flowScheduleResultMessageId(result.dispatchId);
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
    body: encodeFlowScheduleResult(result),
    status: "injected",
    createdAt: 20,
    updatedAt: 20,
    ...overrides,
  });
}

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

    registry.thread.transition(DISPATCH_A, "outgoing", "injected", 11);
    await runtime.reconcileReady();
    assert.equal((await store.readDispatch(DISPATCH_A))?.accepted?.deliveryState, "injected");
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
    assert.equal(request.messageId, request.traceId);
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
    assert.deepEqual(sent, [DISPATCH_A, DISPATCH_A]);
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

test("cancelling an active attempt retires it without resending or reclaiming the window", async () => {
  const { root, store, now } = await storeHarness();
  let sends = 0;
  const registry = registryWithDelivery(async (host, endpoint, request) => {
    sends += 1;
    recordOutgoing(host, endpoint, request, "queued");
    return { delivered: true, endpointId: endpoint.id, receipt: { publicationStage: "accepted", deliveryStage: "queued" } };
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
    const cancelled = await runtime.cancelSchedule("release", "Operator cancelled");
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.activeStepId, undefined);
    assert.equal((await store.readDispatch(DISPATCH_A))?.completion?.state, "retired");
    await runtime.reconcileReady();
    assert.equal(sends, 1);
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
    messageId: DISPATCH_A,
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
  assert.equal(publishedRequest?.selector, peer.id);
  assert.equal(publishedRequest?.traceId, DISPATCH_A);
  assert.equal(publishedRequest?.messageKind, "status");
  assert.equal(publishedRequest?.trustedStatus, true);
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
