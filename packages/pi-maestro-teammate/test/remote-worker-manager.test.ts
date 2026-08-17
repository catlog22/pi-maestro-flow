import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteConnection, RemoteConnectionFactory } from "../src/remote/driver.ts";
import {
  REMOTE_JSONRPC_VERSION,
  type RemoteInitializeParams,
  type RemoteInitializeResult,
  type RemoteProtocolNotification,
  type RemoteRequestMethod,
  type RemoteRequestParamsByMethod,
  type RemoteResultByMethod,
  type RemoteRunAttachParams,
  type RemoteRunAttachResult,
  type RemoteRunCancelParams,
  type RemoteRunCancelResult,
  type RemoteRunInputParams,
  type RemoteRunInputResult,
  type RemoteRunListResult,
  type RemoteRunStartParams,
  type RemoteRunStartResult,
} from "../src/remote/protocol.ts";
import {
  RemoteOwnershipError,
  RemoteWorkerManager,
  RemoteWorkerQuotaError,
} from "../src/remote/worker-manager.ts";
import {
  REMOTE_CONFIG_VERSION,
  REMOTE_PROTOCOL_VERSION,
  type RemoteDriverEvent,
  type RemoteRunCapture,
  type RemoteRunEvent,
  type RemoteRunSnapshot,
  type RemoteStatus,
  type RemoteWorkerIdentity,
  type ResolvedRemoteTarget,
} from "../src/remote/types.ts";
import type { RemoteConfig } from "../src/remote/config.ts";
import { createRemoteBackend } from "pi-maestro-backends/remote";
import {
  createRemoteManagerPort,
  type RemoteManagerPortBinding,
} from "../src/backends/remote-workers.ts";

const HOST_KEY = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function config(): RemoteConfig {
  return {
    version: REMOTE_CONFIG_VERSION,
    hosts: {
      "linux-a": {
        host: "linux-a.example",
        user: "dev",
        port: 22,
        hostKeySha256: HOST_KEY,
      },
    },
    targets: {
      "linux-a/pi": {
        host: "linux-a",
        cwd: "/srv/project",
        driver: "pi-rpc",
        command: ["pi", "--mode", "rpc"],
      },
    },
  };
}

class NotificationQueue implements AsyncIterable<RemoteProtocolNotification> {
  readonly items: RemoteProtocolNotification[] = [];
  readonly waiters: Array<{
    resolve: (result: IteratorResult<RemoteProtocolNotification>) => void;
    reject: (error: Error) => void;
  }> = [];
  ended = false;
  error?: Error;

  push(notification: RemoteProtocolNotification): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: notification, done: false });
    else this.items.push(notification);
  }

  end(error?: Error): void {
    this.ended = true;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<RemoteProtocolNotification> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.ended) return this.error
          ? Promise.reject(this.error)
          : Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}

class FakeConnection implements RemoteConnection {
  status: RemoteStatus = "connecting";
  identity?: RemoteWorkerIdentity;
  readonly queue = new NotificationQueue();
  readonly initializeCalls: RemoteInitializeParams[] = [];
  readonly starts: RemoteRunStartParams[] = [];
  readonly attaches: RemoteRunAttachParams[] = [];
  readonly inputs: RemoteRunInputParams[] = [];
  readonly cancels: RemoteRunCancelParams[] = [];
  readonly lists: Array<{ commandId: string; monitorOwnerNonce: string }> = [];
  hello: RemoteInitializeResult;
  listResult: RemoteRunListResult = { runs: [] };
  nextStart?: RemoteRunStartResult;
  onInitialize?: (params: RemoteInitializeParams) => Promise<void> | void;
  onStart?: (params: RemoteRunStartParams) => Promise<void> | void;
  onAttach?: (params: RemoteRunAttachParams) => Promise<void> | void;
  onList?: () => Promise<void> | void;
  closed = false;

  constructor(identity: RemoteWorkerIdentity = { workerId: "worker-a", instanceNonce: "instance-a" }, concurrency = 2) {
    this.hello = {
      ...identity,
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      concurrency,
      activeRuns: 0,
      status: "ready",
    };
  }

  async initialize(params: RemoteInitializeParams): Promise<RemoteInitializeResult> {
    this.initializeCalls.push(params);
    await this.onInitialize?.(params);
    this.identity = { workerId: this.hello.workerId, instanceNonce: this.hello.instanceNonce };
    this.status = this.hello.status;
    return this.hello;
  }

  async request<Method extends RemoteRequestMethod>(
    method: Method,
    params: RemoteRequestParamsByMethod[Method],
  ): Promise<RemoteResultByMethod[Method]> {
    switch (method) {
      case "remote/initialize": return await this.initialize(params as RemoteInitializeParams) as RemoteResultByMethod[Method];
      case "run/start": return await this.start(params as RemoteRunStartParams) as RemoteResultByMethod[Method];
      case "run/attach": return await this.attach(params as RemoteRunAttachParams) as RemoteResultByMethod[Method];
      case "run/input": return await this.input(params as RemoteRunInputParams) as RemoteResultByMethod[Method];
      case "run/cancel": return await this.cancel(params as RemoteRunCancelParams) as RemoteResultByMethod[Method];
      case "run/list": {
        const list = params as RemoteRequestParamsByMethod["run/list"];
        return await this.list(list.commandId, list.monitorOwnerNonce) as RemoteResultByMethod[Method];
      }
    }
    throw new Error(`Unsupported fake remote method: ${String(method)}`);
  }

  async start(params: RemoteRunStartParams): Promise<RemoteRunStartResult> {
    this.starts.push(params);
    await this.onStart?.(params);
    return this.nextStart ?? {
      workerId: this.hello.workerId,
      instanceNonce: this.hello.instanceNonce,
      runId: `run-${this.starts.length}`,
      generation: 1,
      status: "running",
      firstSequence: 1,
    };
  }

  async attach(params: RemoteRunAttachParams): Promise<RemoteRunAttachResult> {
    this.attaches.push(params);
    await this.onAttach?.(params);
    const snapshot = this.listResult.runs.find((run) => run.runId === params.runId);
    return {
      workerId: snapshot?.workerId ?? this.hello.workerId,
      instanceNonce: snapshot?.instanceNonce ?? this.hello.instanceNonce,
      runId: params.runId,
      generation: params.generation,
      status: snapshot?.status ?? "running",
      replayFromSequence: params.lastSequence + 1,
      lastSequence: snapshot?.lastSequence ?? params.lastSequence,
    };
  }

  async input(params: RemoteRunInputParams): Promise<RemoteRunInputResult> {
    this.inputs.push(params);
    return { accepted: true, effectiveMode: params.mode, receipt: params.mode === "steer" ? "injected" : "queued" };
  }

  async cancel(params: RemoteRunCancelParams): Promise<RemoteRunCancelResult> {
    this.cancels.push(params);
    return { accepted: true, status: "cancelled" };
  }

  async list(commandId: string, monitorOwnerNonce: string): Promise<RemoteRunListResult> {
    this.lists.push({ commandId, monitorOwnerNonce });
    await this.onList?.();
    return this.listResult;
  }

  notifications(): AsyncIterable<RemoteProtocolNotification> { return this.queue; }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.status = "disconnected";
    this.queue.end();
  }

  emit(event: RemoteRunEvent): void {
    this.queue.push({ jsonrpc: REMOTE_JSONRPC_VERSION, method: event.type, params: event } as RemoteProtocolNotification);
  }

  disconnect(error?: Error): void {
    this.status = "disconnected";
    this.queue.end(error);
  }
}

class FakeConnectionFactory implements RemoteConnectionFactory {
  readonly targets: ResolvedRemoteTarget[] = [];
  readonly connections: FakeConnection[];

  constructor(...connections: FakeConnection[]) {
    this.connections = connections;
  }

  async connect(target: ResolvedRemoteTarget): Promise<RemoteConnection> {
    this.targets.push(target);
    const connection = this.connections.shift();
    if (!connection) throw new Error("No fake remote connection available");
    return connection;
  }
}

function managerFor(factory: FakeConnectionFactory, overrides: Partial<ConstructorParameters<typeof RemoteWorkerManager>[0]> = {}) {
  let command = 0;
  return new RemoteWorkerManager({
    config: config(),
    connectionFactory: factory,
    monitorOwnerNonce: "monitor-owner",
    commandIdFactory: () => `command-${++command}`,
    ...overrides,
  });
}

function event(capture: RemoteRunCapture, sequence: number, status: "running" | "waiting" | "completed"): RemoteRunEvent {
  if (status === "completed") {
    return {
      type: "run/result",
      workerId: capture.workerId,
      instanceNonce: capture.instanceNonce,
      runId: capture.runId,
      generation: capture.generation,
      sequence,
      status,
      updatedAt: sequence * 10,
      result: "done",
    };
  }
  return {
    type: "run/state",
    workerId: capture.workerId,
    instanceNonce: capture.instanceNonce,
    runId: capture.runId,
    generation: capture.generation,
    sequence,
    status,
    updatedAt: sequence * 10,
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for fake remote state");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("manager initializes before admission and drives start, snapshots, events, and waits", async () => {
  const connection = new FakeConnection();
  const seen: RemoteRunEvent[] = [];
  const manager = managerFor(new FakeConnectionFactory(connection), { onEvent: (_capture, value) => seen.push(value) });
  const worker = await manager.connect("linux-a/pi");
  assert.equal(worker.workerId, "worker-a");
  assert.equal(connection.initializeCalls[0].monitorOwnerNonce, "monitor-owner");

  const capture = await manager.start({ targetId: "linux-a/pi", name: "remote", objective: "perform task" });
  assert.deepEqual(connection.starts[0].command, ["pi", "--mode", "rpc"]);
  assert.equal(connection.starts[0].cwd, "/srv/project");
  assert.equal(connection.starts[0].monitorOwnerNonce, "monitor-owner");
  const waiting = manager.wait(capture);
  connection.emit(event(capture, 1, "running"));
  connection.emit(event(capture, 2, "completed"));
  assert.equal((await waiting).status, "completed");
  assert.equal(manager.snapshot(capture).lastSequence, 2);
  assert.deepEqual(seen.map((value) => value.sequence), [1, 2]);
  await manager.close();
});

test("manager sends, cancels, and rejects every stale ownership capture", async () => {
  const connection = new FakeConnection();
  const manager = managerFor(new FakeConnectionFactory(connection));
  const capture = await manager.start({ targetId: "linux-a/pi", name: "remote", objective: "perform task" });
  assert.equal((await manager.followUp(capture, "continue")).receipt, "queued");
  assert.equal((await manager.steer(capture, "change course")).receipt, "injected");
  assert.equal((await manager.cancel(capture, "stop")).accepted, true);
  assert.deepEqual(connection.inputs.map((input) => input.mode), ["follow_up", "steer"]);
  assert.equal(connection.cancels[0].monitorOwnerNonce, "monitor-owner");

  const stale = { ...capture, generation: capture.generation + 1 };
  await assert.rejects(manager.followUp(stale, "must fail"), RemoteOwnershipError);
  await assert.rejects(manager.cancel({ ...capture, monitorOwnerNonce: "replacement-owner" }), RemoteOwnershipError);
  assert.equal(connection.inputs.length, 2);
  assert.equal(connection.cancels.length, 1);
  await manager.close();
});

test("attach buffers replay before admission and publishes only the exact capture", async () => {
  const connection = new FakeConnection();
  const manager = managerFor(new FakeConnectionFactory(connection));
  const capture: RemoteRunCapture = {
    workerId: "worker-a",
    instanceNonce: "instance-a",
    runId: "existing-run",
    generation: 3,
    monitorOwnerNonce: "monitor-owner",
    targetId: "linux-a/pi",
  };
  connection.onAttach = () => connection.emit(event(capture, 1, "waiting"));
  await manager.attach({ capture });
  await eventually(() => manager.snapshot(capture).lastSequence === 1);
  assert.equal(manager.snapshot(capture).status, "waiting");
  assert.equal(connection.attaches[0].lastSequence, 0);
  await manager.close();
});

test("disconnect and reconnect attach from the last sequence without starting twice", async () => {
  const first = new FakeConnection();
  const second = new FakeConnection();
  const factory = new FakeConnectionFactory(first, second);
  const manager = managerFor(factory);
  const capture = await manager.start({
    targetId: "linux-a/pi",
    name: "remote",
    objective: "perform task",
    commandId: "stable-start",
  });
  first.emit(event(capture, 1, "running"));
  await eventually(() => manager.snapshot(capture).lastSequence === 1);
  first.disconnect();
  await eventually(() => manager.snapshot(capture).status === "disconnected");

  const remoteSnapshot: RemoteRunSnapshot = { ...manager.snapshot(capture), status: "running" };
  second.listResult = { runs: [remoteSnapshot] };
  second.onAttach = () => {
    second.emit({
      type: "run/event",
      workerId: capture.workerId,
      instanceNonce: capture.instanceNonce,
      runId: capture.runId,
      generation: capture.generation,
      sequence: 2,
      updatedAt: 20,
      event: { type: "text", text: "replayed" },
    });
    second.emit(event(capture, 3, "completed"));
  };
  await manager.reconnect("linux-a/pi");
  await eventually(() => manager.snapshot(capture).status === "completed");
  assert.equal(second.attaches[0].lastSequence, 1);
  assert.equal(second.starts.length, 0);
  assert.equal(first.starts.length, 1);
  assert.equal(manager.snapshot(capture).lastSequence, 3);
  await manager.close();
});

test("reconnect marks a missing exact run capture lost", async () => {
  const first = new FakeConnection();
  const second = new FakeConnection();
  const manager = managerFor(new FakeConnectionFactory(first, second));
  const capture = await manager.start({ targetId: "linux-a/pi", name: "remote", objective: "perform task" });
  first.disconnect();
  await eventually(() => manager.snapshot(capture).status === "disconnected");
  second.listResult = { runs: [] };
  await manager.reconnect("linux-a/pi");
  assert.equal(manager.snapshot(capture).status, "lost");
  assert.equal(manager.snapshot(capture).degradedReason, "reconnect-ownership-lost");
  await manager.close();
});

test("reconnect marks an identity-mismatched run capture lost", async () => {
  const first = new FakeConnection();
  const second = new FakeConnection();
  const manager = managerFor(new FakeConnectionFactory(first, second));
  const capture = await manager.start({ targetId: "linux-a/pi", name: "remote", objective: "perform task" });
  first.disconnect();
  await eventually(() => manager.snapshot(capture).status === "disconnected");
  second.listResult = {
    runs: [{ ...manager.snapshot(capture), status: "running", instanceNonce: "replacement-instance" }],
  };

  await manager.reconnect("linux-a/pi");

  assert.equal(manager.snapshot(capture).status, "lost");
  assert.equal(manager.snapshot(capture).degradedReason, "reconnect-ownership-lost");
  assert.equal(second.attaches.length, 0);
  await manager.close();
});

test("transient replay timeout remains disconnected and a later reconnect recovers", async () => {
  const first = new FakeConnection();
  const timedOut = new FakeConnection();
  const recovered = new FakeConnection();
  const manager = managerFor(new FakeConnectionFactory(first, timedOut, recovered));
  const capture = await manager.start({ targetId: "linux-a/pi", name: "remote", objective: "perform task" });
  first.disconnect();
  await eventually(() => manager.snapshot(capture).status === "disconnected");
  const remoteSnapshot: RemoteRunSnapshot = { ...manager.snapshot(capture), status: "running" };
  timedOut.listResult = { runs: [remoteSnapshot] };
  timedOut.onAttach = () => { throw new Error("Remote request timed out"); };

  await assert.rejects(manager.reconnect("linux-a/pi"), /Remote request timed out/);
  assert.equal(manager.snapshot(capture).status, "disconnected");
  assert.notEqual(manager.snapshot(capture).degradedReason, "reconnect-ownership-lost");

  recovered.listResult = { runs: [remoteSnapshot] };
  await manager.reconnect("linux-a/pi");
  assert.equal(manager.snapshot(capture).status, "running");
  assert.equal(timedOut.attaches.length, 1);
  assert.equal(recovered.attaches.length, 1);
  await manager.close();
});

test("aborted replay remains disconnected and a later reconnect recovers", async () => {
  const first = new FakeConnection();
  const aborted = new FakeConnection();
  const recovered = new FakeConnection();
  const manager = managerFor(new FakeConnectionFactory(first, aborted, recovered));
  const capture = await manager.start({ targetId: "linux-a/pi", name: "remote", objective: "perform task" });
  first.disconnect();
  await eventually(() => manager.snapshot(capture).status === "disconnected");
  const remoteSnapshot: RemoteRunSnapshot = { ...manager.snapshot(capture), status: "running" };
  const controller = new AbortController();
  aborted.listResult = { runs: [remoteSnapshot] };
  aborted.onList = () => controller.abort();

  await assert.rejects(
    manager.reconnect("linux-a/pi", controller.signal),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(manager.snapshot(capture).status, "disconnected");
  assert.notEqual(manager.snapshot(capture).degradedReason, "reconnect-ownership-lost");
  assert.equal(aborted.attaches.length, 0);

  recovered.listResult = { runs: [remoteSnapshot] };
  await manager.reconnect("linux-a/pi");
  assert.equal(manager.snapshot(capture).status, "running");
  assert.equal(recovered.attaches.length, 1);
  await manager.close();
});

test("start command idempotency and host quotas prevent duplicate remote starts", async () => {
  const connection = new FakeConnection(undefined, 1);
  let releaseStart!: () => void;
  const barrier = new Promise<void>((resolve) => { releaseStart = resolve; });
  connection.onStart = () => barrier;
  const manager = managerFor(new FakeConnectionFactory(connection), { maxRunsPerHost: 1 });
  const request = {
    targetId: "linux-a/pi",
    name: "remote",
    objective: "perform task",
    commandId: "same-start",
  } as const;
  const first = manager.start(request);
  const duplicate = manager.start(request);
  await eventually(() => connection.starts.length === 1);
  releaseStart();
  assert.deepEqual(await duplicate, await first);
  assert.equal(connection.starts.length, 1);
  await assert.rejects(
    manager.start({ ...request, commandId: "second-start" }),
    RemoteWorkerQuotaError,
  );
  assert.equal(connection.starts.length, 1);
  await manager.close();
});

test("close joins an in-flight start and rolls back its late remote run before transport shutdown", async () => {
  const connection = new FakeConnection();
  let releaseStart!: () => void;
  const barrier = new Promise<void>((resolve) => { releaseStart = resolve; });
  connection.onStart = () => barrier;
  connection.nextStart = {
    workerId: "worker-a",
    instanceNonce: "instance-a",
    runId: "late-run",
    generation: 7,
    status: "running",
    firstSequence: 1,
  };
  const manager = managerFor(new FakeConnectionFactory(connection));
  const starting = manager.start({ targetId: "linux-a/pi", name: "late", objective: "must roll back" });
  await eventually(() => connection.starts.length === 1);

  const closing = manager.close();
  assert.equal(connection.closed, false);
  releaseStart();

  await assert.rejects(starting, /Remote worker manager is closed/);
  await closing;
  assert.equal(connection.cancels.length, 1);
  assert.equal(connection.cancels[0]?.runId, "late-run");
  assert.equal(connection.cancels[0]?.generation, 7);
  assert.equal(manager.snapshots().length, 0);
  assert.equal(connection.closed, true);
});

test("failed local admission rolls back the exact remote run once", async () => {
  const connection = new FakeConnection();
  connection.nextStart = {
    workerId: "worker-a",
    instanceNonce: "stale-instance",
    runId: "rollback-run",
    generation: 4,
    status: "running",
    firstSequence: 1,
  };
  const manager = managerFor(new FakeConnectionFactory(connection));
  await assert.rejects(
    manager.start({ targetId: "linux-a/pi", name: "remote", objective: "perform task" }),
    RemoteOwnershipError,
  );
  assert.equal(connection.cancels.length, 1);
  assert.equal(connection.cancels[0].runId, "rollback-run");
  assert.equal(connection.cancels[0].generation, 4);
  assert.equal(manager.snapshots().length, 0);
  await manager.close();
});

test("a run whose events shared a chunk with the start reply still folds into the backend outcome", async () => {
  const connection = new FakeConnection();
  const capture: RemoteRunCapture = {
    workerId: "worker-a",
    instanceNonce: "instance-a",
    runId: "run-1",
    generation: 1,
    monitorOwnerNonce: "monitor-owner",
    targetId: "linux-a/pi",
  };
  const driverEvent = (sequence: number, event: RemoteDriverEvent): RemoteRunEvent => ({
    type: "run/event",
    workerId: capture.workerId,
    instanceNonce: capture.instanceNonce,
    runId: capture.runId,
    generation: capture.generation,
    sequence,
    event,
    updatedAt: sequence * 10,
  });
  // The whole run arrives before its own start reply does. A gateway writes the
  // reply and the notifications that follow it into the same SSH chunk, and the
  // line decoder dispatches every record in that chunk synchronously, so the
  // pump has already buffered these as orphans by the time `run/start` settles
  // — and the manager replays them while admitting the run, inside `start`.
  connection.onStart = async () => {
    connection.emit(driverEvent(1, { type: "tool", tool: { toolCallId: "a", toolName: "read", phase: "start" } }));
    connection.emit(driverEvent(2, { type: "tool", tool: { toolCallId: "a", toolName: "read", phase: "end" } }));
    connection.emit({
      type: "run/result",
      workerId: capture.workerId,
      instanceNonce: capture.instanceNonce,
      runId: capture.runId,
      generation: capture.generation,
      sequence: 3,
      status: "completed",
      updatedAt: 30,
      result: "the deploy is clean",
    });
    await eventually(() => connection.queue.items.length === 0);
  };

  let binding: RemoteManagerPortBinding;
  const manager = managerFor(new FakeConnectionFactory(connection), {
    onEvent: (published, event) => binding.publish(published, event),
  });
  binding = createRemoteManagerPort(manager);
  const backend = createRemoteBackend(() => binding.port);
  const seen: Record<string, unknown>[] = [];

  const run = await backend.start(
    { agent: "prober", task: "audit the deploy" },
    {
      correlationId: "corr-1",
      baseCwd: process.cwd(),
      host: {},
      config: { targetId: "linux-a/pi", driver: "pi-rpc" },
      onChildEvent: (event) => seen.push(event),
    },
  );
  const outcome = await run.outcome;

  assert.equal(outcome.result.messages[0]?.content, "the deploy is clean");
  assert.equal(outcome.result.toolCount, 1);
  assert.equal(outcome.recovery.completedToolCount, 1);
  assert.equal(outcome.recovery.settlementAuthority, "authoritative");
  assert.equal(outcome.result.terminalStatus, "completed");
  assert.equal(outcome.result.exitCode, 0);
  assert.deepEqual(await outcome.reclamation, { status: "reclaimed" });
  assert.equal(seen.length, 3, "the host never saw the events replayed during admission");
  await manager.close();
});

test("a v1 daemon handshake failure names both protocol versions and the target host", async () => {
  const connection = new FakeConnection();
  // Exactly what a remote/1 daemon answers a remote/2 host: its parameter
  // validation rejects the absent `capabilities` array before the version check
  // that would have named remote/1 ever runs, so -32602 is all the operator gets.
  connection.onInitialize = () => {
    const refusal: Error & { code?: number } = new Error("Invalid capabilities");
    refusal.name = "RemoteRpcResponseError";
    refusal.code = -32602;
    throw refusal;
  };
  const manager = managerFor(new FakeConnectionFactory(connection));

  await assert.rejects(manager.connect("linux-a/pi"), (error: unknown) => {
    assert.ok(error instanceof Error);
    const { message } = error;
    assert.ok(message.includes("linux-a"), `the target host is missing from: ${message}`);
    assert.ok(message.includes("remote/2"), `the local monitor's version is missing from: ${message}`);
    assert.ok(message.includes("remote/1"), `the daemon's suspected version is missing from: ${message}`);
    assert.ok(
      message.includes("Upgrade pi-teammate-remote on linux-a and restart serve"),
      `the remediation is missing from: ${message}`,
    );
    assert.equal((error.cause as Error | undefined)?.message, "Invalid capabilities");
    return true;
  });
  assert.equal(connection.closed, true, "the refused connection is still closed");
  await manager.close();
});

test("a hello whose protocol version differs is refused by validateHello", async () => {
  const connection = new FakeConnection();
  // Every other field stays valid, so the version disjunct is the only thing in
  // validateHello that can refuse this hello.
  connection.hello = {
    ...connection.hello,
    protocolVersion: "remote/1" as unknown as typeof REMOTE_PROTOCOL_VERSION,
  };
  const manager = managerFor(new FakeConnectionFactory(connection));

  await assert.rejects(manager.connect("linux-a/pi"), /Invalid remote worker hello/);
  assert.equal(connection.closed, true, "the refused connection is still closed");
  await manager.close();
});
