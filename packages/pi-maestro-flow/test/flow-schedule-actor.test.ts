import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  RuntimeBrokerClient,
  type RuntimeActorHostClient,
  type RuntimeActorLease,
  type RuntimeActorRegistration,
} from "pi-maestro-teammate/v2/runtime-broker";
import type { RuntimeEventDraftV2, RuntimeEventV2 } from "pi-maestro-teammate/v2/runtime";
import { createRuntimeActorHost } from "../../pi-maestro-teammate/src/runtime-broker/actor-host.ts";
import { RuntimeBrokerServer } from "../../pi-maestro-teammate/src/runtime-broker/server.ts";
import { FlowScheduleActorRuntime } from "../src/flow-schedule/actor.ts";
import { FlowScheduleRuntime } from "../src/flow-schedule/runtime.ts";
import {
  FlowScheduleBrokerRuntime,
  FlowScheduleReportOutbox,
  flowScheduleV2FromEnv,
  parseFlowScheduleV2,
} from "../src/flow-schedule/broker-runtime.ts";
import {
  FLOW_SCHEDULE_ACTOR_VERSION,
  dispatchStreamId,
  initialDispatchActorState,
  reduceDispatch,
  replayDispatch,
  todoCapabilitiesNegotiated,
  type FlowScheduleActorEvent,
} from "../src/flow-schedule/reducer.ts";
import { FlowScheduleStore } from "../src/flow-schedule/store.ts";
import type { ExactWindowIdentity } from "../src/flow-schedule/types.ts";

const DISPATCH_A = "123e4567-e89b-42d3-a456-426614174000";
const DISPATCH_B = "223e4567-e89b-42d3-a456-426614174000";
const execFileAsync = promisify(execFile);
const identity: ExactWindowIdentity = {
  workspaceId: "f".repeat(64),
  endpointId: "owner:peer",
  ownerId: "a".repeat(32),
  ownerNonce: "b".repeat(32),
  sessionId: "peer-session",
};

function dispatchEvent(
  dispatchId: string,
  revision: number,
  eventType: FlowScheduleActorEvent["eventType"],
  payload: unknown,
  producerEpoch = 1,
): FlowScheduleActorEvent {
  return {
    version: FLOW_SCHEDULE_ACTOR_VERSION,
    eventId: `${dispatchId}:${revision}`,
    streamId: dispatchStreamId(dispatchId),
    revision,
    brokerRevision: revision,
    producerEpoch,
    eventType,
    occurredAt: revision * 10,
    payload,
  };
}

function prepared(dispatchId: string, revision = 1): FlowScheduleActorEvent {
  return dispatchEvent(dispatchId, revision, "dispatch.prepared", {
    scheduleId: "release",
    stepId: "verify",
    targetIdentity: identity,
    completionCorrelationKey: "agent://completion",
  });
}

function exact(dispatchId: string, revision: number, outcome: "completed" | "failed" = "completed"): FlowScheduleActorEvent {
  return dispatchEvent(dispatchId, revision, `work.reported.${outcome}`, {
    exact: true,
    dispatchId,
    identityMatches: true,
    completionCorrelationMatches: true,
    reportedAt: revision * 10,
  });
}

test("dispatch reducer replays orthogonal transport/business state and fences revision/epoch", () => {
  const state = replayDispatch(DISPATCH_A, [
    prepared(DISPATCH_A),
    dispatchEvent(DISPATCH_A, 2, "dispatch.published", {}),
    dispatchEvent(DISPATCH_A, 3, "dispatch.accepted", {}),
    exact(DISPATCH_A, 4),
  ]);
  assert.equal(state.transport, "accepted");
  assert.equal(state.business, "completed");
  assert.equal(state.revision, 4);
  assert.equal(state.brokerRevision, 4);

  assert.throws(() => reduceDispatch(state, dispatchEvent(DISPATCH_A, 6, "dispatch.accepted", {})), /revision conflict/);
  assert.throws(() => reduceDispatch(state, dispatchEvent(DISPATCH_A, 5, "dispatch.accepted", {}, 0)), /producer epoch is stale/);
  const epochTwo = reduceDispatch(initialDispatchActorState(DISPATCH_A), dispatchEvent(DISPATCH_A, 1, "dispatch.prepared", {
    scheduleId: "release", stepId: "verify", targetIdentity: identity,
  }, 2));
  assert.throws(() => reduceDispatch(epochTwo, dispatchEvent(DISPATCH_A, 2, "dispatch.published", {}, 1)), /producer epoch is stale/);
});

test("exact report wins during generic grace; timeout is ambiguous and a late report cannot revive it", () => {
  const exactWins = replayDispatch(DISPATCH_A, [
    prepared(DISPATCH_A),
    dispatchEvent(DISPATCH_A, 2, "work.generic_terminal_observed", { terminalAt: 20, graceDeadline: 50 }),
    exact(DISPATCH_A, 3),
    dispatchEvent(DISPATCH_A, 4, "work.unreported_terminal", { expiredAt: 60 }),
  ]);
  assert.equal(exactWins.business, "completed");
  assert.equal(exactWins.genericTerminalAt, 20);
  assert.equal(exactWins.exactReportedAt, 30);

  const timedOut = replayDispatch(DISPATCH_B, [
    prepared(DISPATCH_B),
    dispatchEvent(DISPATCH_B, 2, "work.generic_terminal_observed", { terminalAt: 20, graceDeadline: 50 }),
    dispatchEvent(DISPATCH_B, 3, "work.unreported_terminal", { expiredAt: 50 }),
    exact(DISPATCH_B, 4),
  ]);
  assert.equal(timedOut.business, "ambiguous");
  assert.equal(timedOut.exactReportedAt, undefined);
  assert.throws(() => replayDispatch(DISPATCH_A, [
    prepared(DISPATCH_A),
    dispatchEvent(DISPATCH_A, 2, "work.unreported_terminal", { expiredAt: 20 }),
  ]), /grace expires/);
});

test("only exact identity/correlation-bound reports advance and retry uses an independent stream", () => {
  assert.throws(() => replayDispatch(DISPATCH_A, [
    prepared(DISPATCH_A),
    dispatchEvent(DISPATCH_A, 2, "work.reported.completed", {
      exact: true,
      dispatchId: DISPATCH_A,
      identityMatches: false,
      completionCorrelationMatches: true,
      reportedAt: 20,
    }),
  ]), /not exact and dispatch-bound/);

  const retired = replayDispatch(DISPATCH_A, [
    prepared(DISPATCH_A),
    dispatchEvent(DISPATCH_A, 2, "dispatch.retired", {}),
    exact(DISPATCH_A, 3),
  ]);
  const retry = replayDispatch(DISPATCH_B, [prepared(DISPATCH_B), exact(DISPATCH_B, 2)]);
  assert.equal(retired.business, "retired");
  assert.equal(retry.business, "completed");
  assert.notEqual(retired.streamId, retry.streamId);
});

test("Todo capability negotiation distinguishes projection, backend mutation, and report", () => {
  assert.equal(todoCapabilitiesNegotiated({ rootProjection: true, backendMutation: true, report: true }), true);
  assert.equal(todoCapabilitiesNegotiated({ rootProjection: true, backendMutation: false, report: true }), false, "ACP todo unsupported must fail closed");
  assert.equal(todoCapabilitiesNegotiated({ rootProjection: true, backendMutation: true, report: false }), false);
});

class FakeActorHost implements RuntimeActorHostClient {
  readonly mode = "file" as const;
  readonly registrations: RuntimeActorRegistration[] = [];
  revision = 0;
  epoch = 1;
  active = true;
  events: RuntimeEventV2[] = [];

  async acquire(registration: RuntimeActorRegistration): Promise<RuntimeActorLease> {
    this.registrations.push(registration);
    const host = this;
    return {
      mode: "file",
      registration,
      get credential() { return { epoch: host.epoch, nonce: `nonce-${host.epoch}` }; },
      get revision() { return host.revision; },
      get active() { return host.active; },
      async heartbeat() {},
      async replay(afterSequence = 0) { return host.events.filter((event) => event.sequence > afterSequence); },
      async append(events: readonly RuntimeEventDraftV2[]) {
        if (!host.active) throw new Error("stale lease");
        const appended = events.map((event) => ({
          ...event,
          sequence: ++host.revision,
          producerEpoch: host.epoch,
        })) as RuntimeEventV2[];
        host.events.push(...appended);
        return appended;
      },
      async release() { host.active = false; },
    };
  }

  async stop() { this.active = false; }
}

test("actor replay consumes broker producerEpoch and falls back to actor generation only for legacy events", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-actor-epoch-"));
  const host = new FakeActorHost();
  host.epoch = 7;
  try {
    const first = new FlowScheduleActorRuntime({ projectRoot: root, actorHost: host });
    const committed = await first.commitDispatch(DISPATCH_A, "dispatch.prepared", {
      scheduleId: "release",
      stepId: "verify",
      targetIdentity: identity,
    });
    assert.equal(committed.producerEpoch, 7);
    await first.stop();

    host.active = true;
    const restarted = new FlowScheduleActorRuntime({ projectRoot: root, actorHost: host });
    assert.equal((await restarted.dispatchState(DISPATCH_A)).producerEpoch, 7);
    await restarted.stop();

    const legacy = { ...host.events[0]! };
    delete legacy.producerEpoch;
    host.events = [legacy];
    host.active = true;
    const legacyRestart = new FlowScheduleActorRuntime({ projectRoot: root, actorHost: host });
    assert.equal((await legacyRestart.dispatchState(DISPATCH_A)).producerEpoch, 1);
    await legacyRestart.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

interface SharedLeaseState {
  owners: Map<string, string>;
  events: Map<string, RuntimeEventV2[]>;
  epochs: Map<string, number>;
}

function sharedActorHost(state: SharedLeaseState): RuntimeActorHostClient {
  return {
    mode: "file",
    async acquire(registration) {
      const owner = state.owners.get(registration.leaseActorId);
      if (owner && owner !== registration.holderId) return undefined;
      const streamEvents = state.events.get(registration.streamId) ?? [];
      state.events.set(registration.streamId, streamEvents);
      const epoch = owner
        ? state.epochs.get(registration.leaseActorId) ?? 1
        : (state.epochs.get(registration.leaseActorId) ?? 0) + 1;
      state.owners.set(registration.leaseActorId, registration.holderId);
      state.epochs.set(registration.leaseActorId, epoch);
      return {
        mode: "file",
        registration,
        credential: { epoch, nonce: `${registration.holderId}:${epoch}` },
        get revision() { return streamEvents.length; },
        get active() { return state.owners.get(registration.leaseActorId) === registration.holderId; },
        async heartbeat() {},
        async replay(afterSequence = 0) {
          return streamEvents.filter((event) => event.sequence > afterSequence);
        },
        async append(events) {
          if (state.owners.get(registration.leaseActorId) !== registration.holderId) throw new Error("stale lease");
          const appended = events.map((event) => ({
            ...event,
            sequence: streamEvents.length + 1,
            producerEpoch: epoch,
          })) as RuntimeEventV2[];
          streamEvents.push(...appended);
          return appended;
        },
        async release() {
          if (state.owners.get(registration.leaseActorId) === registration.holderId) {
            state.owners.delete(registration.leaseActorId);
          }
        },
      };
    },
    async stop() {},
  };
}

function crashableSqliteHost(stateDirectory: string): {
  host: RuntimeActorHostClient;
  crash(): Promise<void>;
} {
  let client: RuntimeBrokerClient | undefined;
  const internal = createRuntimeActorHost({
    mode: "sqlite",
    stateDirectory,
    sqliteClientFactory: async () => {
      client ??= await RuntimeBrokerClient.connect({ stateDirectory });
      return client;
    },
  });
  return {
    host: {
      mode: "sqlite",
      acquire: (registration) => internal.acquire({
        ...registration,
        ttlMs: 120,
        heartbeatMs: 20,
      }),
      stop: () => internal.stop(),
    },
    async crash() {
      if (!client) throw new Error("Runtime actor host did not connect before the crash fixture");
      await client.close();
    },
  };
}

test("actor runtime lazily migrates v1 without rewriting it and exposes lease/revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-actor-migration-"));
  const store = new FlowScheduleStore(root, { now: () => 100 });
  const host = new FakeActorHost();
  try {
    const schedule = await store.createSchedule({
      scheduleId: "release",
      target: `owner:${"a".repeat(32)}`,
      steps: [{ stepId: "verify", prompt: "Verify" }],
    });
    const v1Path = join(store.schedulesDir, "release.json");
    const before = await readFile(v1Path);
    const actors = new FlowScheduleActorRuntime({ projectRoot: root, actorHost: host, now: () => 200 });
    const migrated = await actors.ensureSchedule(schedule);
    const status = await actors.status("schedule", "release");
    assert.equal(migrated.migration, "v1-lazy");
    assert.equal(status?.revision, 1);
    assert.equal(status?.brokerRevision, 1);
    assert.equal(status?.leaseEpoch, 1);
    assert.deepEqual(await readFile(v1Path), before, "lazy migration must not destructively rewrite v1");
    const changed = await store.updateSchedule("release", (current) => ({ ...current, reason: "stale v1 change" }));
    const authoritative = await actors.ensureSchedule(changed);
    assert.equal(authoritative.revision, migrated.revision, "existing actor authority must not import a divergent v1 projection");
    assert.equal(authoritative.projection?.reason, undefined);
    await store.repairScheduleProjection(authoritative.projection!);

    const journalProjection = { ...authoritative.projection!, reason: "journal committed", updatedAt: 250 };
    const pending = await actors.commitSchedule("release", "schedule.paused", journalProjection);
    assert.equal(pending.projectionState, "pending");
    assert.equal((await store.readSchedule("release"))?.reason, undefined, "failure injection leaves v1 behind the committed journal");
    assert.equal(host.registrations[0]?.actor.actorKind, "schedule");
    await actors.stop();

    host.active = true;
    host.epoch = 2;
    const restarted = new FlowScheduleActorRuntime({ projectRoot: root, actorHost: host, now: () => 300 });
    const replayed = await restarted.ensureSchedule((await store.readSchedule("release"))!);
    assert.equal(replayed.revision, pending.revision, "broker stream is the replay authority after restart");
    assert.equal(replayed.projection?.reason, "journal committed");
    await store.repairScheduleProjection(replayed.projection!);
    const applied = await restarted.commitSchedule("release", "schedule.projection_applied", replayed.projection!);
    assert.equal(applied.projectionState, "applied");
    assert.equal((await store.readSchedule("release"))?.reason, "journal committed", "restart repairs journal to v1");
    await restarted.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconciliation bounds and rotates schedule lease acquisition across contending windows", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-actor-fairness-"));
  const projectRoot = join(root, "workspace");
  const store = new FlowScheduleStore(projectRoot, { now: () => 100 });
  const shared: SharedLeaseState = { owners: new Map(), events: new Map(), epochs: new Map() };
  const brokers = ["window-a", "window-b"].map((holderId) => new FlowScheduleBrokerRuntime({
    projectRoot,
    mode: 1,
    actorHost: sharedActorHost(shared),
    holderId,
  }));
  const runtimes = brokers.map((brokerRuntime) => new FlowScheduleRuntime({
    store,
    brokerRuntime,
    getRegistry: () => undefined,
  }));
  try {
    for (let index = 0; index < 4; index += 1) {
      await store.createSchedule({
        scheduleId: `fair-${index}`,
        target: `owner:${(index + 1).toString(16).padStart(32, "0")}`,
        steps: [{ stepId: "verify", prompt: "Verify" }],
      });
    }

    await Promise.all(runtimes.map((runtime) => runtime.reconcileReady()));
    const firstPassOwners = [0, 1].map((scheduleIndex) =>
      brokers.findIndex((broker) => broker.actors!.hasScheduleLease(`fair-${scheduleIndex}`)));
    assert.deepEqual(new Set(firstPassOwners).size, 2, "contending windows must continue past a lease held elsewhere");
    assert.ok(firstPassOwners.every((owner) => owner >= 0));

    await Promise.all(runtimes.map((runtime) => runtime.reconcileReady()));
    const finalOwnership = brokers.map((broker) =>
      [0, 1, 2, 3].filter((scheduleIndex) => broker.actors!.hasScheduleLease(`fair-${scheduleIndex}`)));
    assert.deepEqual(finalOwnership.map((owned) => owned.length), [2, 2]);
    assert.deepEqual(new Set(finalOwnership.flat()).size, 4);
  } finally {
    await Promise.all(runtimes.map((runtime) => runtime.shutdown()));
    await rm(root, { recursive: true, force: true });
  }
});

test("single-window reconciliation can host multiple schedules over bounded passes", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-actor-single-window-"));
  const projectRoot = join(root, "workspace");
  const store = new FlowScheduleStore(projectRoot, { now: () => 100 });
  const shared: SharedLeaseState = { owners: new Map(), events: new Map(), epochs: new Map() };
  const broker = new FlowScheduleBrokerRuntime({
    projectRoot,
    mode: 1,
    actorHost: sharedActorHost(shared),
    holderId: "only-window",
  });
  const runtime = new FlowScheduleRuntime({ store, brokerRuntime: broker, getRegistry: () => undefined });
  try {
    for (let index = 0; index < 3; index += 1) {
      await store.createSchedule({
        scheduleId: `single-${index}`,
        target: `owner:${(index + 1).toString(16).padStart(32, "0")}`,
        steps: [{ stepId: "verify", prompt: "Verify" }],
      });
    }
    await runtime.reconcileReady();
    await runtime.reconcileReady();
    await runtime.reconcileReady();
    assert.deepEqual(
      [0, 1, 2].map((index) => broker.actors!.hasScheduleLease(`single-${index}`)),
      [true, true, true],
    );
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("four windows run independent schedules and recover accepted work through fenced takeover", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-actor-phase6-"));
  const projectRoot = join(root, "workspace");
  const stateDirectory = join(root, "broker");
  const store = new FlowScheduleStore(projectRoot, { now: () => 100 });
  const server = new RuntimeBrokerServer({ stateDirectory });
  const harnesses: ReturnType<typeof crashableSqliteHost>[] = [];
  const runtimes: FlowScheduleActorRuntime[] = [];
  let takeoverRuntime: FlowScheduleActorRuntime | undefined;
  try {
    const schedules = [];
    for (let index = 0; index < 4; index += 1) {
      schedules.push(await store.createSchedule({
        scheduleId: `parallel-${index}`,
        target: `owner:${(index + 1).toString(16).padStart(32, "0")}`,
        steps: [{ stepId: "verify", prompt: `Verify window ${index}` }],
      }));
    }
    await server.listen();
    for (let index = 0; index < schedules.length; index += 1) {
      const harness = crashableSqliteHost(stateDirectory);
      harnesses.push(harness);
      runtimes.push(new FlowScheduleActorRuntime({
        projectRoot,
        actorHost: harness.host,
        holderId: `window-${index}`,
        now: () => 200 + index,
      }));
    }

    const migrated = await Promise.all(runtimes.map((runtime, index) => runtime.ensureSchedule(schedules[index]!)));
    assert.deepEqual(migrated.map((state) => state.revision), [1, 1, 1, 1]);
    const statuses = await Promise.all(
      runtimes.map((runtime, index) => runtime.status("schedule", `parallel-${index}`)),
    );
    assert.equal(new Set(statuses.map((status) => status?.streamId)).size, 4);
    assert.deepEqual(statuses.map((status) => status?.revision), [1, 1, 1, 1]);
    assert.deepEqual(statuses.map((status) => status?.leaseEpoch), [1, 1, 1, 1]);

    const original = runtimes[0]!;
    await original.commitDispatch(DISPATCH_A, "dispatch.prepared", {
      scheduleId: schedules[0]!.scheduleId,
      stepId: "verify",
      targetIdentity: identity,
      completionCorrelationKey: "agent://phase6-acceptance",
    });
    await original.commitDispatch(DISPATCH_A, "dispatch.published", {});
    const accepted = await original.commitDispatch(DISPATCH_A, "dispatch.accepted", {});
    assert.equal(accepted.transport, "accepted");
    const oldStatus = await original.status("dispatch", DISPATCH_A);
    assert.equal(oldStatus?.leaseEpoch, 1);

    await harnesses[0]!.crash();
    await delay(180);
    const takeoverHarness = crashableSqliteHost(stateDirectory);
    harnesses.push(takeoverHarness);
    takeoverRuntime = new FlowScheduleActorRuntime({
      projectRoot,
      actorHost: takeoverHarness.host,
      holderId: "window-takeover",
      now: () => 500,
    });
    const recovered = await takeoverRuntime.dispatchState(DISPATCH_A);
    const takeoverStatus = await takeoverRuntime.status("dispatch", DISPATCH_A);
    assert.equal(recovered.transport, "accepted");
    assert.ok((takeoverStatus?.leaseEpoch ?? 0) > (oldStatus?.leaseEpoch ?? 0));
    await assert.rejects(
      original.commitDispatch(DISPATCH_A, "work.reported.completed", {
        exact: true,
        dispatchId: DISPATCH_A,
        identityMatches: true,
        completionCorrelationMatches: true,
        reportedAt: 500,
      }),
      /lease is stale|stale lease/i,
    );
    const completed = await takeoverRuntime.commitDispatch(DISPATCH_A, "work.reported.completed", {
      exact: true,
      dispatchId: DISPATCH_A,
      identityMatches: true,
      completionCorrelationMatches: true,
      reportedAt: 500,
    });
    assert.equal(completed.business, "completed");
  } finally {
    await takeoverRuntime?.stop();
    for (const runtime of runtimes) await runtime.stop();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("durable report outbox survives restart, reuses deterministic identity, and never regresses", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-report-outbox-"));
  const input = {
    messageId: "flow-result:dispatch-a",
    resultMessageId: "result-a",
    dispatchId: DISPATCH_A,
    scheduleId: "release",
    stepId: "verify",
    selector: identity.endpointId,
    targetIdentity: identity,
    body: "{\"outcome\":\"completed\"}",
  };
  try {
    const first = new FlowScheduleReportOutbox(root, () => 10);
    assert.equal((await first.prepare(input)).state, "prepared");
    const files = await readdir(first.rootDir);
    const durable = join(first.rootDir, files.find((name) => name.endsWith(".json"))!);
    await rename(durable, `${durable}.previous`);
    const recovered = new FlowScheduleReportOutbox(root, () => 15);
    assert.equal((await recovered.listPending())[0]?.state, "prepared", "interrupted Windows replacement is recovered before enumeration");
    await first.recordAttempt(input.messageId);
    await first.markPublished(input.messageId);

    const restarted = new FlowScheduleReportOutbox(root, () => 20);
    assert.equal((await restarted.listPending())[0]?.state, "published");
    assert.equal((await restarted.prepare(input)).attempts, 1, "duplicate report is idempotent");
    await Promise.all([
      restarted.markAccepted(input.messageId),
      first.recordAttempt(input.messageId),
    ]);
    assert.equal((await restarted.read(input.messageId))?.state, "accepted", "foreground and pump updates share a monotonic queue");
    assert.deepEqual(await restarted.listPending(), []);
    assert.equal((await restarted.markPublished(input.messageId)).state, "accepted");
    await assert.rejects(restarted.prepare({ ...input, body: "different" }), /different content/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("report outbox mutations are monotonic across fresh processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-report-outbox-process-race-"));
  const messageId = "flow-result:process-race";
  const input = {
    messageId,
    resultMessageId: "result-process-race",
    dispatchId: DISPATCH_A,
    scheduleId: "release",
    stepId: "verify",
    selector: identity.endpointId,
    targetIdentity: identity,
    body: "{\"outcome\":\"completed\"}",
  };
  const moduleUrl = new URL("../src/flow-schedule/broker-runtime.ts", import.meta.url).href;
  const childScript = [
    "const [moduleUrl, root, messageId, operation] = process.argv.slice(1);",
    "const { FlowScheduleReportOutbox } = await import(moduleUrl);",
    "const outbox = new FlowScheduleReportOutbox(root);",
    "if (operation === 'accept') await outbox.markAccepted(messageId);",
    "else await outbox.recordAttempt(messageId);",
  ].join("\n");
  try {
    const outbox = new FlowScheduleReportOutbox(root);
    await outbox.prepare(input);
    const operations = ["attempt", "attempt", "attempt", "attempt", "accept"];
    await Promise.all(operations.map((operation) => execFileAsync(process.execPath, [
      "--experimental-transform-types",
      "--input-type=module",
      "--eval",
      childScript,
      moduleUrl,
      root,
      messageId,
      operation,
    ])));
    const final = await outbox.read(messageId);
    assert.equal(final?.state, "accepted");
    assert.equal(final?.attempts, 4, "cross-process attempts must not be lost to stale read/replace races");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Flow V2 defaults on with broker authority and preserves explicit v1 rollback", () => {
  assert.equal(parseFlowScheduleV2(undefined), 1);
  assert.equal(parseFlowScheduleV2("0"), 0);
  assert.equal(parseFlowScheduleV2("invalid"), 0);
  assert.equal(flowScheduleV2FromEnv({}), 1);
  assert.equal(flowScheduleV2FromEnv({ PI_RUNTIME_BROKER: "off" }), 0);
  assert.equal(flowScheduleV2FromEnv({ PI_RUNTIME_BROKER: "invalid" }), 0);
  assert.equal(flowScheduleV2FromEnv({ PI_FLOW_SCHEDULE_V2: "0" }), 0);
  assert.equal(flowScheduleV2FromEnv({ PI_FLOW_SCHEDULE_V2: "1" }), 1);
  const runtime = new FlowScheduleBrokerRuntime({ projectRoot: process.cwd(), env: { PI_FLOW_SCHEDULE_V2: "1", PI_RUNTIME_BROKER: "off" } });
  assert.throws(() => runtime.assertAvailable(), /requires PI_RUNTIME_BROKER/);
});
