import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bindWorkspaceCompletionHandle,
  WORKSPACE_MAIN_SESSION_MARKER,
} from "pi-maestro-teammate/v1/workspace-completion";
import {
  createWorkspacePeerV1TransportAdapter,
  projectSessionEndpoints,
  SessionHostRegistry,
  type SessionEndpoint,
  type SessionMessageRequest,
} from "pi-maestro-teammate/v1/sessions";
import { flowScheduleDispatchMessageId } from "../src/flow-schedule/protocol.ts";
import { createWorkerFlowScheduleTool } from "../src/flow-schedule/tool.ts";
import { FlowScheduleRuntime } from "../src/flow-schedule/runtime.ts";
import { FlowScheduleStore } from "../src/flow-schedule/store.ts";
import { FLOW_SCHEDULE_RESULT_TYPE, type ExactWindowIdentity } from "../src/flow-schedule/types.ts";

const COORDINATOR_OWNER = "1".repeat(32);
const COORDINATOR_NONCE = "2".repeat(32);
const WORKER_OWNER = "a".repeat(32);
const WORKER_NONCE = "b".repeat(32);
const WORKSPACE_ID = "f".repeat(64);
const GENERIC_MESSAGE_ID = "9".repeat(32);
const DISPATCH_A = "123e4567-e89b-42d3-a456-426614174000";
const DISPATCH_B = "223e4567-e89b-42d3-a456-426614174000";
const TARGET = `owner:${WORKER_OWNER}`;

interface RegistryPair {
  coordinator: SessionHostRegistry;
  worker: SessionHostRegistry;
  workerIdentity: ExactWindowIdentity;
}

function owner(input: {
  ownerId: string;
  ownerNonce: string;
  scope: "local" | "workspace-peer";
  sessionId: string;
  status?: "running" | "completed";
  extraCapabilities?: Array<"flow-schedule-todo-binding">;
}) {
  return {
    workspaceId: WORKSPACE_ID,
    ownerId: input.ownerId,
    ownerNonce: input.ownerNonce,
    scope: input.scope,
    status: input.status ?? "running" as const,
    sessionId: input.sessionId,
    agents: [],
    ...(input.extraCapabilities ? { extraCapabilities: input.extraCapabilities } : {}),
  };
}

function incomingFrom(
  registry: SessionHostRegistry,
  sender: SessionEndpoint,
  destination: SessionEndpoint,
  request: SessionMessageRequest,
): void {
  registry.thread.record({
    messageId: request.messageId!,
    workspaceId: destination.workspaceId,
    peerOwnerId: sender.ownerId,
    peerOwnerNonce: sender.ownerNonce,
    direction: "incoming",
    source: request.source ?? "system",
    ...(request.messageKind === undefined ? {} : { messageKind: request.messageKind }),
    ...(request.provenance === undefined ? {} : { provenance: request.provenance }),
    ...(request.traceId === undefined ? {} : { traceId: request.traceId }),
    ...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
    ...(request.targetCorrelationId === undefined ? {} : { targetCorrelationId: request.targetCorrelationId }),
    ...(request.terminalResultRequested === undefined ? {} : { terminalResultRequested: request.terminalResultRequested }),
    targetSessionId: destination.sessionId,
    mode: "follow_up",
    body: request.message,
    status: "injected",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

function outgoingTo(
  registry: SessionHostRegistry,
  destination: SessionEndpoint,
  request: SessionMessageRequest,
): void {
  registry.thread.record({
    messageId: request.messageId!,
    workspaceId: destination.workspaceId,
    peerOwnerId: destination.ownerId,
    peerOwnerNonce: destination.ownerNonce,
    direction: "outgoing",
    source: request.source ?? "system",
    ...(request.messageKind === undefined ? {} : { messageKind: request.messageKind }),
    ...(request.provenance === undefined ? {} : { provenance: request.provenance }),
    ...(request.traceId === undefined ? {} : { traceId: request.traceId }),
    ...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
    ...(request.targetCorrelationId === undefined ? {} : { targetCorrelationId: request.targetCorrelationId }),
    ...(request.terminalResultRequested === undefined ? {} : { terminalResultRequested: request.terminalResultRequested }),
    mode: "follow_up",
    body: request.message,
    status: "injected",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

function registryPair(todoBinding = false, includeCompletionRequest = true): RegistryPair {
  const bindingCapabilities = todoBinding
    ? ["flow-schedule-todo-binding" as const]
    : undefined;
  const coordinatorEndpoints = projectSessionEndpoints([
    owner({ ownerId: COORDINATOR_OWNER, ownerNonce: COORDINATOR_NONCE, scope: "local", sessionId: "coordinator-session" }),
    owner({
      ownerId: WORKER_OWNER,
      ownerNonce: WORKER_NONCE,
      scope: "workspace-peer",
      sessionId: "worker-session",
      extraCapabilities: bindingCapabilities,
    }),
  ]);
  const workerEndpoints = projectSessionEndpoints([
    owner({
      ownerId: WORKER_OWNER,
      ownerNonce: WORKER_NONCE,
      scope: "local",
      sessionId: "worker-session",
      extraCapabilities: bindingCapabilities,
    }),
    owner({ ownerId: COORDINATOR_OWNER, ownerNonce: COORDINATOR_NONCE, scope: "workspace-peer", sessionId: "coordinator-session" }),
  ]);
  let coordinator!: SessionHostRegistry;
  let worker!: SessionHostRegistry;
  coordinator = new SessionHostRegistry({
    surface: "unified",
    endpoints: coordinatorEndpoints,
    adapters: [createWorkspacePeerV1TransportAdapter(async (destination, request) => {
      const sender = coordinatorEndpoints.find((endpoint) => endpoint.scope === "local")!;
      const workerLocal = workerEndpoints.find((endpoint) => endpoint.scope === "local")!;
      outgoingTo(coordinator, destination, request);
      incomingFrom(worker, sender, workerLocal, request);
      return {
        delivered: true,
        endpointId: destination.id,
        transport: destination.transport,
        receipt: { publicationStage: "accepted", deliveryStage: "injected", messageId: request.messageId },
      };
    })],
  });
  worker = new SessionHostRegistry({
    surface: "unified",
    endpoints: workerEndpoints,
    adapters: [createWorkspacePeerV1TransportAdapter(async (destination, request) => {
      const sender = workerEndpoints.find((endpoint) => endpoint.scope === "local")!;
      const coordinatorLocal = coordinatorEndpoints.find((endpoint) => endpoint.scope === "local")!;
      outgoingTo(worker, destination, request);
      incomingFrom(coordinator, sender, coordinatorLocal, request);
      return {
        delivered: true,
        endpointId: destination.id,
        transport: destination.transport,
        receipt: { publicationStage: "accepted", deliveryStage: "injected", messageId: request.messageId },
      };
    })],
  });
  const coordinatorLocal = coordinatorEndpoints.find((endpoint) => endpoint.scope === "local")!;
  const workerLocal = workerEndpoints.find((endpoint) => endpoint.scope === "local")!;
  if (includeCompletionRequest) {
    const genericRequest: SessionMessageRequest = {
      messageId: GENERIC_MESSAGE_ID,
      message: "Managed objective",
      mode: "follow_up",
      source: "monitor",
      messageKind: "request",
      provenance: {
        version: 1,
        messageId: GENERIC_MESSAGE_ID,
        source: "monitor",
        messageKind: "request",
        deliveryMode: "follow_up",
        confidence: "verified",
        sender: { kind: "system", ownerId: COORDINATOR_OWNER, label: "monitor" },
      },
      traceId: GENERIC_MESSAGE_ID,
      replyTo: `owner:${COORDINATOR_OWNER}`,
      targetCorrelationId: WORKSPACE_MAIN_SESSION_MARKER,
      terminalResultRequested: true,
    };
    outgoingTo(coordinator, workerLocal, genericRequest);
    coordinator.thread.record({
      ...coordinator.thread.get(GENERIC_MESSAGE_ID, "outgoing")!,
      targetSessionId: coordinatorLocal.sessionId,
    });
    incomingFrom(worker, coordinatorLocal, workerLocal, {
      ...genericRequest,
      replyTo: `owner:${COORDINATOR_OWNER}`,
    });
  }
  const workerEndpoint = coordinator.resolve(TARGET, { includeSettled: true, localFirst: false }).endpoint!;
  return {
    coordinator,
    worker,
    workerIdentity: {
      workspaceId: workerEndpoint.workspaceId,
      endpointId: workerEndpoint.id,
      ownerId: workerEndpoint.ownerId,
      ownerNonce: workerEndpoint.ownerNonce,
      sessionId: workerEndpoint.sessionId,
    },
  };
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
      summary: "worker running",
      updatedAt: Date.now(),
      capabilities: { inspect: true, wait: true, message: true },
    }],
    durationMs: 0,
  });
}

async function createActiveStore(root: string, todoBinding = false): Promise<FlowScheduleStore> {
  const store = new FlowScheduleStore(join(root, "workspace"), { getProcessIdentity: () => `test:${process.pid}` });
  await store.createSchedule({
    scheduleId: "release",
    target: TARGET,
    steps: [{
      stepId: "verify",
      prompt: "Run verification",
      ...(todoBinding
        ? { todoBinding: { label: "Verify release", requireCompleted: true, conflictCheck: true } }
        : {}),
    }],
  });
  await store.updateSchedule("release", (schedule) => ({ ...schedule, state: "active" }));
  return store;
}

function claimIntentInChild(projectRoot: string, identity: ExactWindowIdentity): Promise<void> {
  const storeUrl = new URL("../src/flow-schedule/store.ts", import.meta.url).href;
  const script = [
    "const [storeUrl, projectRoot, identityJson, correlationJson] = process.argv.slice(1);",
    "const { FlowScheduleStore } = await import(storeUrl);",
    "const store = new FlowScheduleStore(projectRoot, { getProcessIdentity: () => `child:${process.pid}` });",
    `await store.createDispatchIntent({ dispatchId: ${JSON.stringify(DISPATCH_A)}, scheduleId: 'release', stepId: 'verify', targetIdentity: JSON.parse(identityJson), completionCorrelation: JSON.parse(correlationJson) });`,
  ].join("\n");
  const child = spawn(process.execPath, [
    "--experimental-transform-types",
    "--no-warnings",
    "--input-type=module",
    "-e",
    script,
    storeUrl,
    projectRoot,
    JSON.stringify(identity),
    JSON.stringify(bindWorkspaceCompletionHandle(GENERIC_MESSAGE_ID, {
      workspaceId: identity.workspaceId,
      ownerId: COORDINATOR_OWNER,
      ownerNonce: COORDINATOR_NONCE,
    })),
  ], { stdio: ["ignore", "ignore", "pipe"] });
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`intent child exited ${String(code)}: ${stderr}`)));
  });
}

interface ChildTodoReport {
  request: SessionMessageRequest;
  todo: { id: string; status: string };
}

async function reportCompletedTodoInChild(
  root: string,
  inbound: ReturnType<SessionHostRegistry["thread"]["get"]>,
): Promise<ChildTodoReport> {
  assert.ok(inbound);
  const inputPath = join(root, "worker-input.json");
  const outputPath = join(root, "worker-report.json");
  await writeFile(inputPath, `${JSON.stringify({
    cwd: join(root, "workspace"),
    owners: [
      owner({
        ownerId: WORKER_OWNER,
        ownerNonce: WORKER_NONCE,
        scope: "local",
        sessionId: "worker-session",
        extraCapabilities: ["flow-schedule-todo-binding"],
      }),
      owner({
        ownerId: COORDINATOR_OWNER,
        ownerNonce: COORDINATOR_NONCE,
        scope: "workspace-peer",
        sessionId: "coordinator-session",
      }),
    ],
    completionInbound: {
      messageId: GENERIC_MESSAGE_ID,
      workspaceId: inbound.workspaceId,
      peerOwnerId: COORDINATOR_OWNER,
      peerOwnerNonce: COORDINATOR_NONCE,
      direction: "incoming",
      source: "monitor",
      messageKind: "request",
      traceId: GENERIC_MESSAGE_ID,
      replyTo: `owner:${COORDINATOR_OWNER}`,
      targetSessionId: "worker-session",
      targetCorrelationId: WORKSPACE_MAIN_SESSION_MARKER,
      terminalResultRequested: true,
      mode: "follow_up",
      body: "Managed objective",
      status: "injected",
      createdAt: 1,
      updatedAt: 1,
    },
    inbound,
  })}\n`, "utf8");
  const toolUrl = new URL("../src/flow-schedule/tool.ts", import.meta.url).href;
  const todoUrl = new URL("../src/tools/todo.ts", import.meta.url).href;
  const script = [
    "const [toolUrl, todoUrl, inputPath, outputPath] = process.argv.slice(1);",
    "const { readFile, writeFile } = await import('node:fs/promises');",
    "const { createWorkerFlowScheduleTool } = await import(toolUrl);",
    "const { executeTodo, getVisibleTasks } = await import(todoUrl);",
    "const { createWorkspacePeerV1TransportAdapter, projectSessionEndpoints, SessionHostRegistry } = await import('pi-maestro-teammate/v1/sessions');",
    "const input = JSON.parse(await readFile(inputPath, 'utf8'));",
    "const endpoints = projectSessionEndpoints(input.owners);",
    "let registry;",
    "registry = new SessionHostRegistry({ surface: 'unified', endpoints, adapters: [createWorkspacePeerV1TransportAdapter(async (destination, request) => { await writeFile(outputPath, JSON.stringify({ request, todo: getVisibleTasks().find((task) => task.id === todoId) })); return { delivered: true, endpointId: destination.id, transport: destination.transport, receipt: { publicationStage: 'accepted', deliveryStage: 'injected', messageId: request.messageId } }; })] });",
    "registry.thread.record(input.completionInbound);",
    "registry.thread.record(input.inbound);",
    "const ctx = { cwd: input.cwd, ui: { setStatus() {} } };",
    "const created = await executeTodo({ action: 'create', subject: 'Verify release in child worker' }, ctx);",
    "if (created.isError) throw new Error('Todo create failed');",
    "const todoId = created.details?.tasks[0]?.id;",
    "if (!todoId) throw new Error('Todo id missing');",
    "const completed = await executeTodo({ action: 'update', id: todoId, status: 'completed', summary: 'Verified', updateFields: ['status', 'summary'] }, ctx);",
    "if (completed.isError || getVisibleTasks().find((task) => task.id === todoId)?.status !== 'completed') throw new Error('Todo completion failed');",
    "const tool = createWorkerFlowScheduleTool({ getRegistry: () => registry });",
    `const report = await tool.execute('report', { action: 'report', dispatchId: ${JSON.stringify(DISPATCH_A)}, outcome: 'completed', summary: 'Child worker verified and exited', todoOutcome: { todoId, todoStatus: 'completed' } });`,
    "if (report.isError) throw new Error('Flow report failed');",
  ].join("\n");
  const child = spawn(process.execPath, [
    "--experimental-transform-types",
    "--no-warnings",
    "--input-type=module",
    "-e",
    script,
    toolUrl,
    todoUrl,
    inputPath,
    outputPath,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`worker child exited ${String(code)}: ${stderr}`)));
  });
  return JSON.parse(await readFile(outputPath, "utf8")) as ChildTodoReport;
}

test("Todo-bound child worker completes Todo, reports, exits, and Monitor accepts the last-step result", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-schedule-todo-child-e2e-"));
  const pair = registryPair(true);
  const store = await createActiveStore(root, true);
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => pair.coordinator,
    observe: liveObservation,
    createDispatchId: () => DISPATCH_A,
  });
  try {
    await runtime.reconcileReady();
    await runtime.reconcileReady();
    assert.deepEqual((await store.readSchedule("release"))?.steps.verify.attempts, [DISPATCH_A]);
    assert.equal((await store.listBindings()).length, 1);
    assert.equal((await store.readBinding(DISPATCH_A))?.state, "pending");

    const childReport = await reportCompletedTodoInChild(
      root,
      pair.worker.thread.get(flowScheduleDispatchMessageId(DISPATCH_A), "incoming"),
    );
    assert.equal(childReport.todo.status, "completed");
    const workerPeer = pair.coordinator.resolve(TARGET, { includeSettled: true, localFirst: false }).endpoint!;
    const coordinatorLocal = pair.coordinator.snapshot().endpoints.find((endpoint) => endpoint.scope === "local")!;
    incomingFrom(pair.coordinator, workerPeer, coordinatorLocal, childReport.request);
    pair.coordinator.replaceEndpoints(projectSessionEndpoints([
      owner({ ownerId: COORDINATOR_OWNER, ownerNonce: COORDINATOR_NONCE, scope: "local", sessionId: "coordinator-session" }),
      owner({
        ownerId: WORKER_OWNER,
        ownerNonce: WORKER_NONCE,
        scope: "workspace-peer",
        sessionId: "worker-session",
        status: "completed",
        extraCapabilities: ["flow-schedule-todo-binding"],
      }),
    ]));

    await runtime.reconcileReady();
    const schedule = await store.readSchedule("release");
    const binding = await store.readBinding(DISPATCH_A);
    assert.equal(schedule?.state, "completed");
    assert.equal(schedule?.steps.verify.result?.todoOutcome?.todoId, childReport.todo.id);
    assert.equal(binding?.state, "completed");
    assert.equal(binding?.todoId, childReport.todo.id);
    assert.equal((await store.listBindings()).length, 1);
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("existing managed worker without a completion handle receives a dispatch and advances from an exact report", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-schedule-unbound-worker-e2e-"));
  const pair = registryPair(false, false);
  const store = await createActiveStore(root);
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => pair.coordinator,
    observe: liveObservation,
    createDispatchId: () => DISPATCH_A,
  });
  try {
    await runtime.reconcileReady();
    assert.ok(pair.worker.thread.get(flowScheduleDispatchMessageId(DISPATCH_A), "incoming"));
    assert.equal((await store.readDispatch(DISPATCH_A))?.intent.completionCorrelation, undefined);

    const workerTool = createWorkerFlowScheduleTool({ getRegistry: () => pair.worker });
    const report = await workerTool.execute("report", {
      action: "report",
      dispatchId: DISPATCH_A,
      outcome: "completed",
      summary: "Existing worker verified",
    });
    assert.equal(report.isError, undefined);
    assert.equal(report.details?.completionResource, undefined);

    await runtime.reconcileReady();
    const schedule = await store.readSchedule("release");
    assert.equal(schedule?.state, "completed");
    assert.equal(schedule?.steps.verify.result?.summary, "Existing worker verified");
    assert.deepEqual(schedule?.steps.verify.attempts, [DISPATCH_A]);
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("child intent crash resumes the same dispatch and worker report completes after coordinator restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-schedule-e2e-"));
  const pair = registryPair();
  const store = await createActiveStore(root);
  await claimIntentInChild(join(root, "workspace"), pair.workerIdentity);
  assert.equal((await store.readDispatch(DISPATCH_A))?.published, undefined);

  const first = new FlowScheduleRuntime({
    store,
    getRegistry: () => pair.coordinator,
    observe: liveObservation,
    createDispatchId: () => DISPATCH_B,
  });
  try {
    await first.reconcileReady();
    assert.ok(pair.worker.thread.get(flowScheduleDispatchMessageId(DISPATCH_A), "incoming"));
    assert.equal((await store.readSchedule("release"))?.steps.verify.attempts.length, 1);
    assert.ok((await store.readDispatch(DISPATCH_A))?.accepted);
    first.dispose();

    const workerTool = createWorkerFlowScheduleTool({ getRegistry: () => pair.worker });
    const report = await workerTool.execute("report", {
      action: "report",
      dispatchId: DISPATCH_A,
      outcome: "completed",
      summary: "Verification passed",
    });
    assert.equal(report.isError, undefined);

    const resumed = new FlowScheduleRuntime({
      store,
      getRegistry: () => pair.coordinator,
      observe: liveObservation,
      createDispatchId: () => DISPATCH_B,
    });
    try {
      await resumed.reconcileReady();
      const schedule = await store.readSchedule("release");
      assert.equal(schedule?.state, "completed");
      assert.deepEqual(schedule?.steps.verify.attempts, [DISPATCH_A]);
      assert.equal(pair.coordinator.resolve(TARGET, { includeSettled: true, localFirst: false }).endpoint?.status, "running");
    } finally {
      resumed.dispose();
    }
  } finally {
    first.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("restart projects a durable completion file written before the schedule snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-schedule-completion-recovery-"));
  const pair = registryPair();
  const store = await createActiveStore(root);
  await store.createDispatchIntent({
    dispatchId: DISPATCH_A,
    scheduleId: "release",
    stepId: "verify",
    targetIdentity: pair.workerIdentity,
  });
  const completion = {
    version: 1,
    type: "flow-schedule-completion",
    dispatchId: DISPATCH_A,
    scheduleId: "release",
    stepId: "verify",
    targetIdentity: pair.workerIdentity,
    state: "completed",
    result: {
      version: 1,
      type: FLOW_SCHEDULE_RESULT_TYPE,
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "verify",
      outcome: "completed",
      summary: "Recovered completion",
      resources: [],
    },
    completedAt: 100,
  };
  await writeFile(join(store.dispatchesDir, DISPATCH_A, "completion.json"), `${JSON.stringify(completion, null, 2)}\n`, "utf8");
  const runtime = new FlowScheduleRuntime({ store, getRegistry: () => undefined, observe: liveObservation });
  try {
    assert.equal((await store.readSchedule("release"))?.state, "active");
    await runtime.reconcileReady();
    assert.equal((await store.readSchedule("release"))?.state, "completed");
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit retry creates one new dispatch and late old report cannot advance it", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-schedule-retry-e2e-"));
  const pair = registryPair();
  const store = await createActiveStore(root);
  let terminal = false;
  let dispatchIndex = 0;
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => pair.coordinator,
    observe: async () => terminal ? {
      action: "status",
      reason: "snapshot",
      observations: [{
        target: { kind: "workspace", id: TARGET },
        found: true,
        nativeStatus: "completed",
        phase: "settled",
        terminalStatus: "completed",
        summary: "worker settled",
        updatedAt: Date.now(),
      }],
      durationMs: 0,
    } : liveObservation(),
    createDispatchId: () => [DISPATCH_A, DISPATCH_B][dispatchIndex++]!,
  });
  const workerTool = createWorkerFlowScheduleTool({ getRegistry: () => pair.worker });
  try {
    await runtime.reconcileReady();
    terminal = true;
    await runtime.reconcileReady();
    assert.equal((await store.readDispatch(DISPATCH_A))?.completion?.state, "ambiguous");

    terminal = false;
    await runtime.retrySchedule("release", "verify", "Operator approved retry");
    assert.deepEqual((await store.readSchedule("release"))?.steps.verify.attempts, [DISPATCH_A, DISPATCH_B]);

    await workerTool.execute("late", {
      action: "report",
      dispatchId: DISPATCH_A,
      outcome: "completed",
      summary: "Late old result",
    });
    await runtime.reconcileReady();
    assert.equal((await store.readSchedule("release"))?.activeStepId, "verify");
    assert.equal((await store.readSchedule("release"))?.steps.verify.currentDispatchId, DISPATCH_B);

    await workerTool.execute("current", {
      action: "report",
      dispatchId: DISPATCH_B,
      outcome: "completed",
      summary: "Current result",
    });
    await runtime.reconcileReady();
    assert.equal((await store.readSchedule("release"))?.state, "completed");
    assert.equal((await store.readSchedule("release"))?.steps.verify.result?.dispatchId, DISPATCH_B);
    assert.equal((await store.readDispatch(DISPATCH_A))?.completion?.state, "ambiguous");
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
