import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  addBinding,
  createEngineState,
  type EngineAgentInfo,
  type MonitorBinding,
} from "../src/extension/monitor.ts";
import { MonitorLeaseAdapter, type MonitorLeaseCapture } from "../src/extension/monitor-lease.ts";
import { MonitorRuntime } from "../src/extension/monitor-runtime.ts";
import {
  MonitorSessionEvaluator,
  createMonitorEvaluationRequest,
  validateMonitorEvaluationResponse,
  type MonitorEvaluationRequest,
  type MonitorSessionHost,
  type MonitorSessionInvocation,
} from "../src/extension/monitor-session.ts";
import {
  SessionHostRegistry,
  createWorkspacePeerV1TransportAdapter,
  projectSessionEndpoints,
  type SessionEndpoint,
  type SessionMessageRequest,
  type SessionMessageResult,
} from "../src/sessions/session-core.ts";
import type { WorkspacePeerIdentity } from "../src/extension/workspace-peers.ts";

const WORKSPACE_ID = "a".repeat(64);
const LOCAL_OWNER = "b".repeat(32);
const LOCAL_NONCE = "c".repeat(32);
const REMOTE_OWNER = "d".repeat(32);
const REMOTE_NONCE = "e".repeat(32);
const KEY = `owner:${REMOTE_OWNER}`;

function identity(): WorkspacePeerIdentity {
  return {
    version: 1,
    normalizedCwd: "d:/workspace",
    workspaceId: WORKSPACE_ID,
    ownerId: LOCAL_OWNER,
    ownerNonce: LOCAL_NONCE,
    paths: {
      rootDir: "runtime",
      ownersDir: "runtime/owners",
      commandsDir: "runtime/commands",
      responsesDir: "runtime/responses",
    },
  };
}

function remoteEndpoint(ownerNonce = REMOTE_NONCE): SessionEndpoint {
  return projectSessionEndpoints([{
    workspaceId: WORKSPACE_ID,
    ownerId: REMOTE_OWNER,
    ownerNonce,
    scope: "workspace-peer",
    status: "running",
    sessionName: "remote-window",
    agents: [],
  }])[0]!;
}

function agentInfo(): EngineAgentInfo {
  return {
    correlationId: KEY,
    name: "remote-window",
    status: "running",
    idleSeconds: 1,
    outputTail: ["working"],
    objective: "finish the task",
    hasPendingInteractions: false,
    kind: "window",
  };
}

class FakeLeases extends MonitorLeaseAdapter {
  valid = true;
  verifyCount = 0;

  constructor(readonly ownerIdentity: WorkspacePeerIdentity) {
    super({ getIdentity: () => ownerIdentity });
  }

  capture(endpoint: SessionEndpoint): MonitorLeaseCapture {
    const capture: MonitorLeaseCapture = {
      key: KEY,
      ownerId: endpoint.ownerId,
      ownerNonce: endpoint.ownerNonce,
      monitorOwnerId: this.ownerIdentity.ownerId,
      monitorOwnerNonce: this.ownerIdentity.ownerNonce,
      identity: this.ownerIdentity,
    };
    this.captures.set(KEY, capture);
    return capture;
  }

  override async verify(capture: MonitorLeaseCapture): Promise<boolean> {
    this.verifyCount++;
    return this.valid && this.isCurrent(capture);
  }
}

function timerHarness() {
  const callbacks: Array<{ callback: () => void; cancelled: boolean }> = [];
  return {
    options: {
      now: () => 1_000,
      setTimer(callback: () => void): ReturnType<typeof setTimeout> {
        const scheduled = { callback, cancelled: false };
        callbacks.push(scheduled);
        return scheduled as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer(timer: ReturnType<typeof setTimeout>) {
        (timer as unknown as { cancelled: boolean }).cancelled = true;
      },
    },
    async runNext(runtime: MonitorRuntime): Promise<void> {
      let scheduled = callbacks.shift();
      while (scheduled?.cancelled) scheduled = callbacks.shift();
      assert.ok(scheduled, "expected a scheduled monitor tick");
      scheduled.callback();
      await Promise.resolve();
      const inFlight = runtime.inFlight;
      assert.ok(inFlight, "scheduled tick must become in-flight");
      await inFlight;
    },
  };
}

function evaluatorHost(
  onWait: (request: MonitorEvaluationRequest, invocation: MonitorSessionInvocation) => Promise<unknown>,
): MonitorSessionHost {
  const sessionIdentity = {};
  const requests = new Map<string, MonitorEvaluationRequest>();
  return {
    async invoke(request) {
      requests.set(request.requestId, request);
      return {
        requestId: request.requestId,
        correlationId: "monitor-correlation",
        promptSequence: 1,
        sessionIdentity,
      };
    },
    async waitForResult(invocation) {
      const request = requests.get(invocation.requestId)!;
      return {
        ...invocation,
        structuredOutput: await onWait(request, invocation),
      };
    },
    async stop() {},
  };
}

function runtimeHarness(options: {
  waitForEvaluation: (request: MonitorEvaluationRequest, invocation: MonitorSessionInvocation) => Promise<unknown>;
  deliver?: (endpoint: SessionEndpoint, request: SessionMessageRequest) => Promise<SessionMessageResult>;
}) {
  const endpoint = remoteEndpoint();
  let deliveries = 0;
  const registry = new SessionHostRegistry({
    surface: "unified",
    endpoints: [endpoint],
    adapters: [createWorkspacePeerV1TransportAdapter(async (target, request) => {
      deliveries++;
      return options.deliver?.(target, request) ?? {
        delivered: true,
        endpointId: target.id,
        transport: "workspace-peer-v1",
      };
    })],
  });
  const engine = createEngineState();
  const added = addBinding(engine, KEY, "remote-window", "auto");
  assert.equal(added.ok, true);
  const binding = engine.bindings.get(KEY)!;
  const leases = new FakeLeases(identity());
  leases.capture(endpoint);
  const timers = timerHarness();
  const evaluator = new MonitorSessionEvaluator(evaluatorHost(options.waitForEvaluation));
  let controllerGeneration = 1;
  const runtime = new MonitorRuntime({
    engine,
    config: () => ({
      ...engine.config,
      tickMs: 10,
      maxRetries: 0,
      retryBackoffMs: 0,
      interventionCooldownMs: 0,
    }),
    registry,
    leases,
    evaluator,
    getControllerGeneration: () => controllerGeneration,
    captureTarget: () => ({ endpoint, info: agentInfo() }),
    onStatusUpdate() {},
    notifyMain() {},
    schedulerOptions: timers.options,
  });
  return {
    endpoint,
    registry,
    engine,
    binding,
    leases,
    runtime,
    timers,
    deliveries: () => deliveries,
    changeControllerGeneration: () => { controllerGeneration++; },
  };
}

function verdict(request: MonitorEvaluationRequest, action: "none" | "send" = "none") {
  return {
    requestId: request.requestId,
    results: request.targets.map((target) => ({
      target: target.key,
      status: action === "send" ? "drift" : "on-track",
      action,
      ...(action === "send" ? { message: "Refocus on the objective." } : {}),
    })),
  };
}

test("monitor evaluation validates request and target identity", () => {
  const request = createMonitorEvaluationRequest([{
    key: KEY,
    endpointId: remoteEndpoint().id,
    ownerId: REMOTE_OWNER,
    ownerNonce: REMOTE_NONCE,
    displayName: "remote-window",
    mode: "auto",
    status: "running",
    idleSeconds: 1,
    objective: "task",
    outputTail: [],
    hasPendingInteractions: false,
  }], 1_000);
  assert.equal(validateMonitorEvaluationResponse(verdict(request), request).ok, true);
  assert.equal(validateMonitorEvaluationResponse({ ...verdict(request), requestId: "wrong" }, request).ok, false);
  assert.equal(validateMonitorEvaluationResponse({ requestId: request.requestId, results: [] }, request).ok, false);
});

test("MonitorSessionEvaluator rejects a replaced session identity", async () => {
  const request = createMonitorEvaluationRequest([], 1_000);
  const firstIdentity = {};
  const evaluator = new MonitorSessionEvaluator({
    async invoke() {
      return { requestId: request.requestId, correlationId: "monitor", promptSequence: 1, sessionIdentity: firstIdentity };
    },
    async waitForResult(invocation) {
      return { ...invocation, sessionIdentity: {}, structuredOutput: verdict(request) };
    },
    async stop() {},
  });
  const result = await evaluator.evaluate(request, new AbortController().signal, () => true);
  assert.equal(result.status, "stale");
});

test("MonitorRuntime discards analysis after the binding object is replaced", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const harness = runtimeHarness({
    async waitForEvaluation(request) {
      await gate;
      return verdict(request, "send");
    },
  });
  harness.runtime.start();
  const tick = harness.timers.runNext(harness.runtime);
  await Promise.resolve();
  harness.engine.bindings.delete(KEY);
  const replacement = addBinding(harness.engine, KEY, "replacement", "auto");
  assert.equal(replacement.ok, true);
  release();
  await tick;
  assert.equal(harness.deliveries(), 0);
  assert.equal(harness.binding.interventions.length, 0);
  await harness.runtime.stop({ stopSession: false });
});

test("MonitorRuntime discards analysis after the owner nonce changes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const harness = runtimeHarness({
    async waitForEvaluation(request) {
      await gate;
      return verdict(request, "send");
    },
  });
  harness.runtime.start();
  const tick = harness.timers.runNext(harness.runtime);
  await Promise.resolve();
  harness.registry.replaceEndpoints([remoteEndpoint("f".repeat(32))]);
  release();
  await tick;
  assert.equal(harness.deliveries(), 0);
  assert.equal(harness.binding.interventions.length, 0);
  await harness.runtime.stop({ stopSession: false });
});

test("MonitorRuntime does not record an intervention when the lease is lost after delivery", async () => {
  let harness!: ReturnType<typeof runtimeHarness>;
  harness = runtimeHarness({
    async waitForEvaluation(request) {
      return verdict(request, "send");
    },
    async deliver(endpoint) {
      harness.leases.valid = false;
      return { delivered: true, endpointId: endpoint.id, transport: "workspace-peer-v1" };
    },
  });
  harness.runtime.start();
  await harness.timers.runNext(harness.runtime);
  assert.equal(harness.deliveries(), 1);
  assert.equal(harness.binding.interventions.length, 0);
  assert.ok(harness.leases.verifyCount >= 2);
  await harness.runtime.stop({ stopSession: false });
});

test("MonitorRuntime revokes automatic publication authority before a delayed commit", async () => {
  let releasePublish!: () => void;
  let publishEntered!: () => void;
  const publishGate = new Promise<void>((resolve) => { releasePublish = resolve; });
  const entered = new Promise<void>((resolve) => { publishEntered = resolve; });
  let committed = 0;
  const harness = runtimeHarness({
    async waitForEvaluation(request) {
      return verdict(request, "send");
    },
    async deliver(endpoint, request) {
      publishEntered();
      await publishGate;
      if (request.authorize?.() !== true) {
        return { delivered: false, endpointId: endpoint.id, transport: "workspace-peer-v1", error: "authority revoked" };
      }
      committed++;
      return { delivered: true, endpointId: endpoint.id, transport: "workspace-peer-v1" };
    },
  });
  harness.runtime.start();
  const tick = harness.timers.runNext(harness.runtime);
  await entered;

  const stopping = harness.runtime.stop({ stopSession: false });
  assert.equal(harness.runtime.running, false);
  releasePublish();
  await Promise.all([tick, stopping]);

  assert.equal(committed, 0);
  assert.equal(harness.binding.interventions.length, 0);
});

test("MonitorRuntime records deferred follow_up delivery without starting outcome evaluation", async () => {
  let capturedRequest: SessionMessageRequest | undefined;
  let authorizedDuringDelivery = false;
  const harness = runtimeHarness({
    async waitForEvaluation(request) {
      return verdict(request, "send");
    },
    async deliver(endpoint, request) {
      capturedRequest = request;
      authorizedDuringDelivery = request.authorize?.() === true;
      return {
        delivered: true,
        endpointId: endpoint.id,
        transport: "workspace-peer-v1",
        receipt: {
          requestedMode: "steer",
          effectiveMode: "follow_up",
          deliveryStage: "queued",
          traceId: request.traceId,
        },
      };
    },
  });
  harness.runtime.start();
  await harness.timers.runNext(harness.runtime);
  assert.equal(typeof capturedRequest?.authorize, "function");
  assert.equal(authorizedDuringDelivery, true);
  assert.equal(capturedRequest?.source, "monitor");
  assert.equal(capturedRequest?.messageKind, "supervision");
  assert.match(capturedRequest?.traceId ?? "", /^mon_/);
  assert.equal(harness.binding.interventions.length, 1);
  assert.equal(harness.binding.interventions[0]?.deliveryStage, "queued");
  assert.equal(harness.binding.interventions[0]?.effectiveMode, "follow_up");
  assert.equal(harness.binding.pendingIntervention, undefined);
  await harness.runtime.stop({ stopSession: false });
});

test("MonitorRuntime treats an accepted remote root steer as queued until target-side injection", async () => {
  const harness = runtimeHarness({
    async waitForEvaluation(request) {
      return verdict(request, "send");
    },
    async deliver(endpoint) {
      return {
        delivered: true,
        endpointId: endpoint.id,
        transport: "workspace-peer-v1",
        receipt: {
          requestedMode: "steer",
          effectiveMode: "steer",
          deliveryStage: "injected",
        },
      };
    },
  });
  harness.runtime.start();
  await harness.timers.runNext(harness.runtime);
  assert.equal(harness.binding.interventions.length, 1);
  assert.equal(harness.binding.interventions[0]?.deliveryStage, "queued");
  assert.equal(harness.binding.interventions[0]?.effectiveMode, "steer");
  assert.equal(harness.binding.pendingIntervention, undefined);
  await harness.runtime.stop({ stopSession: false });
});

test("MonitorRuntime can start again after exit shutdown", async () => {
  let evaluations = 0;
  const harness = runtimeHarness({
    async waitForEvaluation(request) {
      evaluations++;
      return verdict(request);
    },
  });
  harness.runtime.start();
  await harness.timers.runNext(harness.runtime);
  await harness.runtime.stop({ stopSession: false });
  harness.runtime.start();
  await harness.timers.runNext(harness.runtime);
  assert.equal(evaluations, 2);
  await harness.runtime.stop({ stopSession: false });
});

test("production extension instantiates the controller and routes evaluator turns", async () => {
  const source = await readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  assert.match(source, /new MonitorController\(/);
  assert.match(source, /new MonitorSessionEvaluator\(monitorSessionHost\)/);
  assert.match(source, /bindMonitorSessionDispatch =/);
  assert.match(source, /publishMonitorSessionTurn =/);
  assert.match(source, /monitorControllerInstance\.bind\(/);
  assert.match(source, /await monitorControllerInstance\.exit\("user-exit"\)/);
  assert.match(source, /Promise\.allSettled\(\[[\s\S]*?monitorControllerInstance\.shutdown\(\)[\s\S]*?shutdownRemoteMonitorBinding\(\)/);
  assert.match(source, /const canonicalEndpoint = sessionHostRegistry\?\.directory\.get\(selector\)/);
  assert.match(source, /candidate\.ownerId === expectedEndpoint\.ownerId && candidate\.ownerNonce === expectedEndpoint\.ownerNonce/);
  assert.match(source, /sendWorkspacePeerMessage\(target, request, endpoint\)/);
  assert.match(source, /messageKind: request\.messageKind/);
  assert.match(source, /traceId: request\.traceId/);
  assert.doesNotMatch(source, /You own supervision decisions; the parent session only created/);
});
