import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  RuntimeActorHost,
  createRuntimeActorHost,
  type RuntimeActorBrokerClient,
  type RuntimeActorHostClient,
  type RuntimeActorLease,
  type RuntimeActorRegistration,
  type RuntimeV2JournalAppender,
} from "../src/runtime-broker/actor-host.ts";
import {
  RuntimeBrokerError,
  type ActorLease,
  type JsonValue,
  type RuntimeBrokerCommitRequest,
} from "../src/runtime-broker/contracts.ts";
import type { RuntimeEventDraftV2, RuntimeEventV2 } from "../src/runtime-v2/contracts.ts";
import {
  RuntimeV2JournalCorruptionError,
  RuntimeV2ShadowJournal,
} from "../src/runtime-v2/journal.ts";
import { WindowSupervisorRuntimeActor } from "../src/extension/runtime-actor-host.ts";
import { AgentRunRuntimeActor } from "../src/runs/runtime-actor.ts";
import { runSingleTeammate } from "../src/runs/execution.ts";
import type { AgentProgress, SingleResult } from "../src/shared/types.ts";

function registration(generation = 1): RuntimeActorRegistration {
  return {
    leaseActorId: "actor-lease",
    holderId: `holder-${generation}`,
    streamId: `stream-${generation}`,
    actor: {
      version: 2,
      revision: 1,
      workspaceId: "workspace-a",
      actorKind: "teammate",
      actorId: "run-a",
      generation,
    },
    ttlMs: 1_000,
    heartbeatMs: 100,
  };
}

function event(input: RuntimeActorRegistration, kind: "result.published" = "result.published"): RuntimeEventDraftV2 {
  return {
    version: 2,
    revision: 1,
    streamId: input.streamId,
    actor: input.actor,
    occurredAt: 10,
    kind,
    publicationId: "publication-a",
    hasStructuredOutput: false,
  };
}

test("off actor host is a no-op and creates no state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-actor-off-"));
  const stateDirectory = path.join(root, "must-not-exist");
  try {
    const host = createRuntimeActorHost({ mode: "off", cwd: root, stateDirectory });
    assert.equal(await host.acquire(registration()), undefined);
    await host.stop();
    assert.equal(fs.existsSync(stateDirectory), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("file actor host heartbeats, releases, and fences stale generations", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-actor-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const streams = new Map<string, RuntimeEventV2[]>();
  const journal: RuntimeV2JournalAppender = {
    append(draft) {
      const existing = streams.get(draft.streamId) ?? [];
      const persisted = { ...draft, sequence: existing.length + 1 } as RuntimeEventV2;
      existing.push(persisted);
      streams.set(draft.streamId, existing);
      return persisted;
    },
    read(streamId) {
      const events = streams.get(streamId) ?? [];
      return {
        metadata: {
          version: 2,
          revision: 1,
          streamId,
          eventCount: events.length,
          lastSequence: events.length,
          eventsBytes: 0,
          updatedAt: 0,
        },
        events,
      };
    },
  };
  const host = createRuntimeActorHost({ mode: "file", stateDirectory: root, fileJournalFactory: () => journal });
  const competingHost = createRuntimeActorHost({ mode: "file", stateDirectory: root, fileJournalFactory: () => journal });
  const firstRegistration = registration(1);
  const first = await host.acquire(firstRegistration);
  assert.ok(first);
  assert.equal(await competingHost.acquire(firstRegistration), undefined);
  await first.heartbeat();
  assert.equal((await first.append([event(firstRegistration) as RuntimeEventDraftV2]))[0]?.sequence, 1);
  await first.release();
  await assert.rejects(first.append([event(firstRegistration)]), (error) =>
    error instanceof RuntimeBrokerError && error.code === "stale_lease");

  const nextRegistration = registration(2);
  const next = await competingHost.acquire(nextRegistration);
  assert.ok(next);
  assert.equal(next.credential.epoch, 2);
  await next.append([event(nextRegistration)]);
  assert.deepEqual(streams.get("stream-1")?.map((item) => item.sequence), [1]);
  assert.deepEqual(streams.get("stream-2")?.map((item) => item.sequence), [1]);
  await host.stop();
  await competingHost.stop();
  assert.equal(next.active, false);
});

test("file actor host persists one stream authority across distinct lease actor IDs", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-actor-stream-authority-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const firstInput = {
    ...registration(),
    leaseActorId: "actor-lease-a",
    holderId: "holder-a",
    streamId: "shared-stream",
  };
  const secondInput = {
    ...firstInput,
    leaseActorId: "actor-lease-b",
    holderId: "holder-b",
  };
  const firstHost = createRuntimeActorHost({ mode: "file", stateDirectory: root });
  const secondHost = createRuntimeActorHost({ mode: "file", stateDirectory: root });
  const first = await firstHost.acquire(firstInput);
  assert.ok(first);
  assert.equal(first.credential.epoch, 1);
  assert.equal(await secondHost.acquire(secondInput), undefined, "a distinct actor ID cannot split stream authority");
  const firstEvent = (await first.append([event(firstInput)]))[0];
  assert.equal(firstEvent?.sequence, 1);
  assert.equal(firstEvent?.producerEpoch, 1);
  await first.release();

  const second = await secondHost.acquire(secondInput);
  assert.ok(second);
  assert.equal(second.credential.epoch, 2, "stream takeover continues the persisted stream epoch lineage");
  assert.equal(second.revision, 1);
  const secondEvent = (await second.append([event(secondInput)]))[0];
  assert.equal(secondEvent?.sequence, 2);
  assert.equal(secondEvent?.producerEpoch, 2);
  await Promise.all([firstHost.stop(), secondHost.stop()]);
});

test("file actor acquisition fails closed repeatedly after authoritative journal corruption", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-actor-corrupt-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = registration();
  const journalRoot = path.join(root, "actor-journal");
  const journal = new RuntimeV2ShadowJournal(journalRoot);
  journal.append(event(input));
  const streamDirectory = path.join(journalRoot, "streams", fs.readdirSync(path.join(journalRoot, "streams"))[0]!);
  fs.writeFileSync(path.join(streamDirectory, "events.jsonl"), "{malformed}\n", "utf8");
  const host = createRuntimeActorHost({ mode: "file", stateDirectory: root });
  await assert.rejects(host.acquire(input), (error) => error instanceof RuntimeV2JournalCorruptionError);
  await assert.rejects(host.acquire(input), (error) => error instanceof RuntimeV2JournalCorruptionError);
  const leases = fs.readdirSync(path.join(journalRoot, "leases")).filter((name) => name.endsWith(".json"));
  assert.deepEqual(leases, [], "failed replay cannot publish or heartbeat a hidden revision-zero lease");
  await host.stop();
});

test("sqlite actor host drains an admitted commit before closing and rejects new work", async () => {
  let resolveCommit!: (value: {
    messageId: string;
    streamId: string;
    previousRevision: number;
    revision: number;
    eventIds: string[];
    outboxIds: string[];
    appliedAt: number;
    recovered: boolean;
  }) => void;
  let committed: RuntimeBrokerCommitRequest | undefined;
  const lease: ActorLease = {
    actorId: "actor-lease",
    streamId: "stream-1",
    holderId: "holder-1",
    epoch: 1,
    nonce: "nonce-1",
    acquiredAt: 1,
    heartbeatAt: 1,
    expiresAt: 1_000,
  };
  const client: RuntimeActorBrokerClient = {
    acquireLease: async () => lease,
    heartbeatLease: async () => lease,
    commit: async (request) => {
      committed = request;
      return new Promise((resolve) => { resolveCommit = resolve; });
    },
    releaseLease: async () => {},
    getStreamRevision: async () => 0,
    readEvents: async () => [],
    close: async () => {},
  };
  const host = createRuntimeActorHost({ mode: "sqlite", sqliteClientFactory: async () => client });
  const input = registration();
  const actor = await host.acquire(input);
  assert.ok(actor);
  const pending = actor.append([event(input)]);
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = host.stop();
  resolveCommit({
    messageId: committed!.messageId,
    streamId: committed!.streamId,
    previousRevision: 0,
    revision: 1,
    eventIds: committed!.events.map((entry) => entry.eventId),
    outboxIds: [],
    appliedAt: 10,
    recovered: false,
  });
  const persisted = await pending;
  assert.equal(persisted[0]?.sequence, 1, "an admitted durable commit returns its exact result during close");
  await assert.rejects(actor.append([event(input)]), (error) =>
    error instanceof RuntimeBrokerError && error.code === "stale_lease");
  await stopping;
  assert.equal(actor.revision, 1);
  assert.equal(actor.active, false);
});

class FakeActorHost implements RuntimeActorHostClient {
  readonly mode = "file" as const;
  readonly registrations: RuntimeActorRegistration[] = [];
  readonly batches: RuntimeEventDraftV2[][] = [];
  readonly trace: string[] = [];
  released = 0;
  failAcquire = false;
  unavailable = false;
  failAppend = false;

  async acquire(input: RuntimeActorRegistration): Promise<RuntimeActorLease | undefined> {
    if (this.failAcquire) throw new Error("broker unavailable");
    if (this.unavailable) return undefined;
    this.registrations.push(input);
    const host = this;
    let active = true;
    return {
      mode: "file",
      registration: input,
      credential: { epoch: this.registrations.length, nonce: `nonce-${this.registrations.length}` },
      get revision() { return host.batches.reduce((total, batch) => total + batch.length, 0); },
      get active() { return active; },
      heartbeat: async () => {},
      replay: async () => [],
      append: async (events) => {
        if (!active) throw new RuntimeBrokerError("stale_lease", "stale");
        host.trace.push(`persist:${events.map((event) => event.kind).join(",")}`);
        if (host.failAppend) throw new RuntimeBrokerError("stale_lease", "authority denied");
        host.batches.push([...events]);
        return events.map((draft, index) => ({
          ...draft,
          producerEpoch: host.registrations.length,
          sequence: index + 1,
        })) as RuntimeEventV2[];
      },
      release: async () => { if (active) { active = false; host.released += 1; } },
    };
  }

  async stop(): Promise<void> {}
}

test("sqlite actor reconnects and replays a lost acquire with the exact stable requestId", async () => {
  const lease: ActorLease = {
    actorId: "actor-lease",
    streamId: "stream-1",
    holderId: "holder-1",
    epoch: 4,
    nonce: "nonce-4",
    acquiredAt: 1,
    heartbeatAt: 1,
    expiresAt: 10_000,
  };
  const acquireCalls: Array<{ params: unknown; requestId?: string }> = [];
  let firstClosed = 0;
  const firstClient: RuntimeActorBrokerClient = {
    acquireLease: async (params, requestId) => {
      acquireCalls.push({ params, requestId });
      throw Object.assign(new Error("acquire response was lost"), { code: "ECONNRESET" });
    },
    heartbeatLease: async () => { throw new Error("not used"); },
    commit: async () => { throw new Error("not used"); },
    releaseLease: async () => {},
    getStreamRevision: async () => 0,
    readEvents: async () => [],
    close: async () => { firstClosed += 1; },
  };
  const secondClient: RuntimeActorBrokerClient = {
    acquireLease: async (params, requestId) => {
      acquireCalls.push({ params, requestId });
      return lease;
    },
    heartbeatLease: async () => lease,
    commit: async () => { throw new Error("not used"); },
    releaseLease: async () => {},
    getStreamRevision: async () => 0,
    readEvents: async () => [],
    close: async () => {},
  };
  const clients = [firstClient, secondClient];
  let connections = 0;
  const host = createRuntimeActorHost({
    mode: "sqlite",
    sqliteClientFactory: async () => clients[connections++]!,
  });
  const actor = await host.acquire(registration());
  assert.ok(actor);
  assert.equal(connections, 2);
  assert.equal(firstClosed, 1);
  assert.deepEqual(acquireCalls[1]?.params, acquireCalls[0]?.params);
  assert.equal(typeof acquireCalls[0]?.requestId, "string");
  assert.equal(acquireCalls[1]?.requestId, acquireCalls[0]?.requestId);
  await host.stop();
});

test("actor host stop waits for an in-flight acquisition and releases its lease", async () => {
  const lease: ActorLease = {
    actorId: "actor-lease",
    streamId: "stream-1",
    holderId: "holder-1",
    epoch: 1,
    nonce: "nonce-1",
    acquiredAt: 1,
    heartbeatAt: 1,
    expiresAt: 10_000,
  };
  let resolveAcquire!: () => void;
  const acquireGate = new Promise<void>((resolve) => { resolveAcquire = resolve; });
  let releases = 0;
  let closed = false;
  const client: RuntimeActorBrokerClient = {
    acquireLease: async () => { await acquireGate; return lease; },
    heartbeatLease: async () => lease,
    getStreamRevision: async () => 0,
    readEvents: async () => [],
    commit: async () => { throw new Error("not used"); },
    releaseLease: async () => {
      assert.equal(closed, false, "lease cleanup precedes driver shutdown");
      releases += 1;
    },
    close: async () => { closed = true; },
  };
  const host = createRuntimeActorHost({ mode: "sqlite", sqliteClientFactory: async () => client });
  const acquiring = host.acquire(registration());
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = host.stop();
  resolveAcquire();
  await assert.rejects(acquiring, /stopped during lease acquisition/);
  await stopping;
  assert.equal(releases, 1);
  assert.equal(closed, true);
});

test("actor host drains blocked listStreams across stop without reconnecting after close begins", async () => {
  let releaseList!: () => void;
  const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
  let connections = 0;
  let closes = 0;
  const firstClient: RuntimeActorBrokerClient = {
    acquireLease: async () => { throw new Error("not used"); },
    heartbeatLease: async () => { throw new Error("not used"); },
    commit: async () => { throw new Error("not used"); },
    releaseLease: async () => { throw new Error("not used"); },
    getStreamRevision: async () => { throw new Error("not used"); },
    readEvents: async () => { throw new Error("not used"); },
    listStreams: async () => {
      await listGate;
      throw Object.assign(new Error("list transport was interrupted"), { code: "ECONNRESET" });
    },
    close: async () => { closes += 1; },
  };
  const reconnectClient: RuntimeActorBrokerClient = {
    ...firstClient,
    listStreams: async () => ["must-not-reconnect"],
  };
  const clients = [firstClient, reconnectClient];
  const host = createRuntimeActorHost({
    mode: "sqlite",
    sqliteClientFactory: async () => {
      const client = clients[connections];
      connections += 1;
      if (!client) throw new Error("unexpected Runtime actor reconnect");
      return client;
    },
  });
  const listing = host.listStreams!({ workspaceId: "workspace-a", prefix: "stream-", limit: 10 });
  await new Promise((resolve) => setImmediate(resolve));
  let stopSettled = false;
  const stopping = host.stop().then(() => { stopSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopSettled, false, "stop must wait for the admitted stream listing");
  assert.equal(closes, 0, "the admitted listing keeps its existing client until it settles");
  releaseList();
  await assert.rejects(listing, /list transport was interrupted/);
  await stopping;
  assert.equal(connections, 1, "closing forbids transport retry from opening a replacement client");
  assert.equal(closes, 1);
  await assert.rejects(
    host.listStreams!({ workspaceId: "workspace-a", prefix: "stream-", limit: 10 }),
    /host is stopped/,
  );
  assert.equal(connections, 1);
});

test("actor host stop discards a late blocked reconnect without issuing a post-close request", async () => {
  let resolveReconnect!: (client: RuntimeActorBrokerClient) => void;
  const reconnectGate = new Promise<RuntimeActorBrokerClient>((resolve) => { resolveReconnect = resolve; });
  let markReconnectStarted!: () => void;
  const reconnectStarted = new Promise<void>((resolve) => { markReconnectStarted = resolve; });
  let resolveLateClose!: () => void;
  const lateCloseGate = new Promise<void>((resolve) => { resolveLateClose = resolve; });
  let markLateCloseStarted!: () => void;
  const lateCloseStarted = new Promise<void>((resolve) => { markLateCloseStarted = resolve; });
  let connections = 0;
  let liveSockets = 1;
  let firstCloses = 0;
  let lateCloses = 0;
  let lateRequests = 0;
  const firstClient: RuntimeActorBrokerClient = {
    acquireLease: async () => { throw new Error("not used"); },
    heartbeatLease: async () => { throw new Error("not used"); },
    commit: async () => { throw new Error("not used"); },
    releaseLease: async () => { throw new Error("not used"); },
    getStreamRevision: async () => { throw new Error("not used"); },
    readEvents: async () => { throw new Error("not used"); },
    listStreams: async () => {
      throw Object.assign(new Error("list response was lost"), { code: "ECONNRESET" });
    },
    close: async () => {
      firstCloses += 1;
      liveSockets -= 1;
    },
  };
  const lateClient: RuntimeActorBrokerClient = {
    acquireLease: async () => { throw new Error("not used"); },
    heartbeatLease: async () => { throw new Error("not used"); },
    commit: async () => { throw new Error("not used"); },
    releaseLease: async () => { throw new Error("not used"); },
    getStreamRevision: async () => { throw new Error("not used"); },
    readEvents: async () => { throw new Error("not used"); },
    listStreams: async () => {
      lateRequests += 1;
      return ["must-not-run-after-close"];
    },
    close: async () => {
      lateCloses += 1;
      markLateCloseStarted();
      await lateCloseGate;
      liveSockets -= 1;
    },
  };
  const host = createRuntimeActorHost({
    mode: "sqlite",
    sqliteClientFactory: async () => {
      connections += 1;
      if (connections === 1) return firstClient;
      if (connections === 2) {
        markReconnectStarted();
        return reconnectGate;
      }
      throw new Error("unexpected Runtime actor reconnect");
    },
  });

  const listing = host.listStreams!({ workspaceId: "workspace-a", prefix: "stream-", limit: 10 });
  await reconnectStarted;
  assert.equal(firstCloses, 1);
  assert.equal(liveSockets, 0);

  let stopSettled = false;
  const stopping = host.stop().then(() => { stopSettled = true; });
  liveSockets += 1;
  resolveReconnect(lateClient);
  await lateCloseStarted;
  assert.equal(lateRequests, 0, "a reconnect resolved after close must not receive the retry");
  assert.equal(stopSettled, false, "stop must await late-client socket cleanup");
  assert.equal(liveSockets, 1);

  resolveLateClose();
  await assert.rejects(listing, /list response was lost/);
  await stopping;
  assert.equal(connections, 2);
  assert.equal(firstCloses, 1);
  assert.equal(lateCloses, 1);
  assert.equal(liveSockets, 0, "stop returns only after every connected socket is closed");
});

test("sqlite actor recovers a lost commit response with the exact message, event, and request IDs", async () => {
  const lease: ActorLease = {
    actorId: "actor-lease",
    streamId: "stream-1",
    holderId: "holder-1",
    epoch: 3,
    nonce: "nonce-3",
    acquiredAt: 1,
    heartbeatAt: 1,
    expiresAt: 10_000,
  };
  const calls: Array<{ request: RuntimeBrokerCommitRequest; requestId?: string }> = [];
  let firstClosed = 0;
  const receipt = (request: RuntimeBrokerCommitRequest, recovered: boolean) => ({
    messageId: request.messageId,
    streamId: request.streamId,
    previousRevision: request.expectedRevision,
    revision: request.expectedRevision + request.events.length,
    eventIds: request.events.map((entry) => entry.eventId),
    outboxIds: [],
    appliedAt: 10,
    recovered,
  });
  const firstClient: RuntimeActorBrokerClient = {
    acquireLease: async () => lease,
    heartbeatLease: async () => lease,
    getStreamRevision: async () => 0,
    readEvents: async () => [],
    commit: async (request, requestId) => {
      calls.push({ request, requestId });
      throw Object.assign(new Error("commit response was lost"), { code: "ECONNRESET" });
    },
    releaseLease: async () => {},
    close: async () => { firstClosed += 1; },
  };
  const secondClient: RuntimeActorBrokerClient = {
    acquireLease: async () => { throw new Error("not used"); },
    heartbeatLease: async () => lease,
    getStreamRevision: async () => 0,
    readEvents: async () => [],
    commit: async (request, requestId) => {
      calls.push({ request, requestId });
      return receipt(request, true);
    },
    releaseLease: async () => {},
    close: async () => {},
  };
  const clients = [firstClient, secondClient];
  let connections = 0;
  const host = createRuntimeActorHost({
    mode: "sqlite",
    sqliteClientFactory: async () => clients[connections++]!,
  });
  const input = registration();
  const actor = await host.acquire(input);
  assert.ok(actor);
  const persisted = await actor.append([event(input)]);
  assert.equal(persisted[0]?.sequence, 1);
  assert.equal(actor.revision, 1);
  assert.equal(firstClosed, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]?.request, calls[0]?.request);
  assert.equal(calls[1]?.request.messageId, calls[0]?.request.messageId);
  assert.deepEqual(calls[1]?.request.events.map((entry) => entry.eventId), calls[0]?.request.events.map((entry) => entry.eventId));
  assert.equal(calls[1]?.requestId, calls[0]?.requestId);
  await host.stop();
});

test("sqlite actor renew failure closes authority, rejects work, and attempts lease cleanup", async () => {
  const lease: ActorLease = {
    actorId: "actor-lease",
    streamId: "stream-1",
    holderId: "holder-1",
    epoch: 1,
    nonce: "nonce-1",
    acquiredAt: 1,
    heartbeatAt: 1,
    expiresAt: 10_000,
  };
  let heartbeats = 0;
  let releases = 0;
  let commits = 0;
  const client: RuntimeActorBrokerClient = {
    acquireLease: async () => lease,
    heartbeatLease: async () => {
      heartbeats += 1;
      if (heartbeats > 1) throw new RuntimeBrokerError("stale_lease", "renew denied");
      return lease;
    },
    getStreamRevision: async () => 0,
    readEvents: async () => [],
    commit: async () => { commits += 1; throw new Error("must not commit after renew failure"); },
    releaseLease: async () => { releases += 1; },
    close: async () => {},
  };
  const host = createRuntimeActorHost({ mode: "sqlite", sqliteClientFactory: async () => client });
  const input = { ...registration(), ttlMs: 80, heartbeatMs: 5 };
  const actor = await host.acquire(input);
  assert.ok(actor);
  for (let attempt = 0; attempt < 50 && actor.active; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(actor.active, false);
  await assert.rejects(actor.append([event(input)]), (error) =>
    error instanceof RuntimeBrokerError && error.code === "stale_lease");
  for (let attempt = 0; attempt < 50 && releases === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(commits, 0);
  assert.equal(releases, 1);
  await host.stop();
});

test("sqlite actor resumes from the broker stream revision", async () => {
  const lease: ActorLease = {
    actorId: "actor-lease",
    streamId: "stream-1",
    holderId: "holder-1",
    epoch: 2,
    nonce: "nonce-2",
    acquiredAt: 1,
    heartbeatAt: 1,
    expiresAt: 10_000,
  };
  let expectedRevision: number | undefined;
  const client: RuntimeActorBrokerClient = {
    acquireLease: async () => lease,
    heartbeatLease: async () => lease,
    getStreamRevision: async () => 4,
    readEvents: async () => [],
    commit: async (request) => {
      expectedRevision = request.expectedRevision;
      return {
        messageId: request.messageId,
        streamId: request.streamId,
        previousRevision: 4,
        revision: 5,
        eventIds: request.events.map((item) => item.eventId),
        outboxIds: [],
        appliedAt: 10,
        recovered: false,
      };
    },
    releaseLease: async () => {},
    close: async () => {},
  };
  const host = createRuntimeActorHost({ mode: "sqlite", sqliteClientFactory: async () => client });
  const input = registration();
  const actor = await host.acquire(input);
  assert.ok(actor);
  const [persisted] = await actor.append([event(input)]);
  assert.equal(expectedRevision, 4);
  assert.equal(persisted?.sequence, 5);
  assert.equal(persisted?.producerEpoch, 2);
  await host.stop();
});

test("sqlite actor replay restores the broker producer epoch on legacy payloads", async () => {
  const input = registration(7);
  const lease: ActorLease = {
    actorId: input.leaseActorId,
    streamId: input.streamId,
    holderId: input.holderId,
    epoch: 7,
    nonce: "nonce-7",
    acquiredAt: 1,
    heartbeatAt: 1,
    expiresAt: 10_000,
  };
  const legacyPayload: JsonValue = {
    version: 2,
    revision: 1,
    streamId: input.streamId,
    sequence: 1,
    actor: {
      version: 2,
      revision: 1,
      workspaceId: input.actor.workspaceId,
      actorKind: input.actor.actorKind,
      actorId: input.actor.actorId,
      generation: input.actor.generation,
    },
    occurredAt: 10,
    kind: "result.published",
    publicationId: "publication-a",
    hasStructuredOutput: false,
  };
  const client: RuntimeActorBrokerClient = {
    acquireLease: async () => lease,
    heartbeatLease: async () => lease,
    getStreamRevision: async () => 1,
    readEvents: async () => [{
      eventId: "event-1",
      messageId: "message-1",
      streamId: input.streamId,
      revision: 1,
      eventType: "result.published",
      payload: legacyPayload,
      producerEpoch: 7,
      occurredAt: 10,
    }],
    commit: async () => { throw new Error("not used"); },
    releaseLease: async () => {},
    close: async () => {},
  };
  const host = createRuntimeActorHost({ mode: "sqlite", sqliteClientFactory: async () => client });
  const actor = await host.acquire(input);
  assert.ok(actor);
  const replayed = await actor.replay();
  assert.equal(replayed[0]?.producerEpoch, 7);
  await host.stop();
});

test("sqlite actor replay rejects an event from another workspace", async () => {
  const input = registration();
  const lease: ActorLease = {
    actorId: input.leaseActorId,
    streamId: input.streamId,
    holderId: input.holderId,
    epoch: 1,
    nonce: "nonce-1",
    acquiredAt: 1,
    heartbeatAt: 1,
    expiresAt: 10_000,
  };
  const foreign = {
    ...event(input),
    actor: { ...input.actor, workspaceId: "workspace-b" },
    producerEpoch: 1,
    sequence: 1,
  } as RuntimeEventV2;
  const client: RuntimeActorBrokerClient = {
    acquireLease: async () => lease,
    heartbeatLease: async () => lease,
    getStreamRevision: async () => 1,
    readEvents: async () => [{
      eventId: "event-1",
      messageId: "message-1",
      streamId: input.streamId,
      revision: 1,
      eventType: foreign.kind,
      payload: JSON.parse(JSON.stringify(foreign)) as JsonValue,
      producerEpoch: 1,
      occurredAt: foreign.occurredAt,
    }],
    commit: async () => { throw new Error("not used"); },
    releaseLease: async () => {},
    close: async () => {},
  };
  const host = createRuntimeActorHost({ mode: "sqlite", sqliteClientFactory: async () => client });
  const actor = await host.acquire(input);
  assert.ok(actor);
  await assert.rejects(actor.replay(), (error) =>
    error instanceof RuntimeBrokerError && error.code === "invalid_request");
  await host.stop();
});

test("file actor replay rejects an event from another workspace", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-actor-owner-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = registration();
  const journal = new RuntimeV2ShadowJournal(path.join(root, "actor-journal"));
  journal.append({ ...event(input), actor: { ...input.actor, workspaceId: "workspace-b" } });
  const host = createRuntimeActorHost({
    mode: "file",
    stateDirectory: root,
    fileJournalFactory: () => journal,
  });
  const actor = await host.acquire(input);
  assert.ok(actor);
  await assert.rejects(actor.replay(), (error) =>
    error instanceof RuntimeBrokerError && error.code === "invalid_request");
  await host.stop();
});

test("WindowSupervisor binds canonical identity and releases after v1 stop", async () => {
  const host = new FakeActorHost();
  const actor = new WindowSupervisorRuntimeActor({
    cwd: process.cwd(),
    workspaceId: "workspace-a",
    ownerId: "owner-a",
    ownerNonce: "nonce-a",
    generation: 7,
    host,
  });
  assert.equal(await actor.start(), true);
  assert.deepEqual(host.registrations[0], {
    leaseActorId: "window-supervisor:workspace-a:owner-a",
    holderId: "owner-a:nonce-a",
    streamId: "window-supervisor:workspace-a:owner-a:7",
    actor: {
      version: 2,
      revision: 1,
      workspaceId: "workspace-a",
      actorKind: "root",
      actorId: "owner-a",
      generation: 7,
    },
  });
  await actor.stop();
  assert.equal(host.released, 1);
  assert.equal(actor.active, false);
});

test("WindowSupervisor rotates canonical owner identity and generation", async () => {
  const host = new FakeActorHost();
  const first = new WindowSupervisorRuntimeActor({
    cwd: process.cwd(),
    workspaceId: "workspace-a",
    ownerId: "owner-a",
    ownerNonce: "nonce-a",
    generation: 1,
    host,
  });
  await first.start();
  await first.stop();
  const second = new WindowSupervisorRuntimeActor({
    cwd: process.cwd(),
    workspaceId: "workspace-a",
    ownerId: "owner-a",
    ownerNonce: "nonce-b",
    generation: 2,
    host,
  });
  await second.start();
  assert.deepEqual(host.registrations.map((item) => ({
    holderId: item.holderId,
    streamId: item.streamId,
    generation: item.actor.generation,
  })), [
    { holderId: "owner-a:nonce-a", streamId: "window-supervisor:workspace-a:owner-a:1", generation: 1 },
    { holderId: "owner-a:nonce-b", streamId: "window-supervisor:workspace-a:owner-a:2", generation: 2 },
  ]);
  await second.stop();
});

test("distinct windows in one workspace hold independent leases", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-window-owners-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = createRuntimeActorHost({ mode: "file", stateDirectory: root });
  const first = new WindowSupervisorRuntimeActor({
    cwd: process.cwd(),
    workspaceId: "workspace-a",
    ownerId: "owner-a",
    ownerNonce: "nonce-a",
    generation: 1,
    host,
  });
  const second = new WindowSupervisorRuntimeActor({
    cwd: process.cwd(),
    workspaceId: "workspace-a",
    ownerId: "owner-b",
    ownerNonce: "nonce-b",
    generation: 1,
    host,
  });
  assert.deepEqual(await Promise.all([first.start(), second.start()]), [true, true]);
  assert.equal(first.active, true);
  assert.equal(second.active, true);
  await Promise.all([first.stop(), second.stop()]);
  await host.stop();
});

test("WindowSupervisor actor setup failure stays advisory", async () => {
  const host = new FakeActorHost();
  host.failAcquire = true;
  const actor = new WindowSupervisorRuntimeActor({
    cwd: process.cwd(),
    workspaceId: "workspace-a",
    ownerId: "owner-a",
    ownerNonce: "nonce-a",
    generation: 1,
    host,
    onError: () => {},
  });
  assert.equal(await actor.start(), false);
  await actor.stop();
});

test("actor heartbeat stops after release", async () => {
  let heartbeatCount = 0;
  const lease: ActorLease = {
    actorId: "actor-lease",
    streamId: "stream-1",
    holderId: "holder-1",
    epoch: 1,
    nonce: "nonce-1",
    acquiredAt: 1,
    heartbeatAt: 1,
    expiresAt: 10_000,
  };
  const client: RuntimeActorBrokerClient = {
    acquireLease: async () => lease,
    heartbeatLease: async () => {
      heartbeatCount += 1;
      return { ...lease, heartbeatAt: heartbeatCount + 1, expiresAt: 10_000 + heartbeatCount };
    },
    commit: async () => { throw new Error("not used"); },
    releaseLease: async () => {},
    getStreamRevision: async () => 0,
    readEvents: async () => [],
    close: async () => {},
  };
  const host = createRuntimeActorHost({ mode: "sqlite", sqliteClientFactory: async () => client });
  const actor = await host.acquire({ ...registration(), ttlMs: 50, heartbeatMs: 5 });
  assert.ok(actor);
  await new Promise((resolve) => setTimeout(resolve, 24));
  assert.ok(heartbeatCount >= 2);
  await actor.release();
  const stoppedAt = heartbeatCount;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(heartbeatCount, stoppedAt);
  await host.stop();
});

test("AgentRun persists result, settlement, and reclaim before v1 projections for ACP", async () => {
  const host = new FakeActorHost();
  const v1: string[] = [];
  const actor = await AgentRunRuntimeActor.start("run-acp", {}, {
    baseCwd: process.cwd(),
    runtimeActorHost: host,
    runtimeGeneration: 3,
  });
  const wrapped = actor.wrap({
    baseCwd: process.cwd(),
    runtimeActorHost: host,
    onResultPublished: async () => { v1.push("v1-result"); host.trace.push("v1:result"); },
    onTurnComplete: () => { v1.push("v1-settled"); host.trace.push("v1:settled"); },
    onReclamationOutcome: () => { v1.push("v1-reclaimed"); host.trace.push("v1:reclaimed"); },
  });
  wrapped.onChildSpawned?.({} as never, () => false, undefined, "run-acp", 3);
  const result: SingleResult = {
    agent: "general",
    task: "task",
    exitCode: 0,
    messages: [{ role: "assistant", content: "done" }],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
    model: "cli/agy",
    backend: "acp-cli",
    correlationId: "run-acp",
    durationMs: 10,
    publicationId: "publication-acp",
    terminalStatus: "completed",
    wakeable: false,
  };
  await wrapped.onResultPublished?.(result, process.cwd());
  wrapped.onTurnComplete?.(result, "completed");
  wrapped.onChildClosed?.("run-acp", 3, { code: 0, signal: null, settled: true });
  wrapped.onReclamationOutcome?.("run-acp", { status: "reclaimed", forced: false });
  await actor.finish();

  assert.deepEqual(v1, ["v1-result", "v1-settled", "v1-reclaimed"]);
  assert.deepEqual(host.trace, [
    "persist:result.published",
    "v1:result",
    "persist:run.settled",
    "v1:settled",
    "persist:process.reclaimed",
    "v1:reclaimed",
  ]);
  assert.deepEqual(host.batches.flat().map((item) => item.kind), [
    "result.published",
    "run.settled",
    "process.reclaimed",
  ]);
  assert.equal(host.released, 1);
});

test("enabled AgentRun authority failure rejects runSingleTeammate before v1 completion projection", async () => {
  const host = new FakeActorHost();
  host.failAppend = true;
  const controller = new AbortController();
  controller.abort();
  let projected = false;
  await assert.rejects(
    runSingleTeammate(
      { agent: "general", task: "cancel before launch" },
      {
        baseCwd: process.cwd(),
        runtimeActorHost: host,
        signal: controller.signal,
        onTurnComplete: () => { projected = true; },
      },
    ),
    /authority denied/,
  );
  assert.equal(projected, false);
  assert.equal(host.released, 1);
});

test("prelaunch settlement publishes result first even when the v1 observer throws", async () => {
  const host = new FakeActorHost();
  const actor = await AgentRunRuntimeActor.start("run-prelaunch", {}, {
    baseCwd: process.cwd(),
    runtimeActorHost: host,
  });
  const result: SingleResult = {
    agent: "general",
    task: "task",
    exitCode: 1,
    messages: [{ role: "system", content: "rejected" }],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 0 },
    model: "unknown",
    correlationId: "run-prelaunch",
    durationMs: 1,
    publicationId: "publication-prelaunch",
    terminalStatus: "failed",
  };
  const wrapped = actor.wrap({
    baseCwd: process.cwd(),
    runtimeActorHost: host,
    onTurnComplete: () => { throw new Error("v1 observer failed"); },
  });
  wrapped.onTurnComplete?.(result, "failed");
  await actor.finish();
  assert.deepEqual(host.batches.flat().map((item) => item.kind), ["result.published", "run.settled"]);
  assert.equal(host.released, 1);
});

test("unreaped process retains its actor lease and emits no reclaimed event", async () => {
  const host = new FakeActorHost();
  const actor = await AgentRunRuntimeActor.start("run-unreaped", {}, {
    baseCwd: process.cwd(),
    runtimeActorHost: host,
  });
  const wrapped = actor.wrap({ baseCwd: process.cwd(), runtimeActorHost: host });
  wrapped.onChildSpawned?.({} as never, () => false, undefined, "run-unreaped", 1);
  const result: SingleResult = {
    agent: "general",
    task: "task",
    exitCode: 1,
    messages: [{ role: "system", content: "failed" }],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
    model: "unknown",
    correlationId: "run-unreaped",
    durationMs: 2,
    publicationId: "publication-unreaped",
    terminalStatus: "failed",
  };
  await wrapped.onResultPublished?.(result, process.cwd());
  wrapped.onTurnComplete?.(result, "failed");
  wrapped.onReclamationOutcome?.("run-unreaped", {
    status: "unreaped",
    forced: true,
    reason: "exit-unconfirmed",
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(host.released, 0);
  assert.equal(host.batches.flat().some((item) => item.kind === "process.reclaimed"), false);
  await actor.abort();
  assert.equal(host.released, 1);
});

test("AgentRun setup failures surface when broker authority is enabled", async () => {
  await assert.rejects(
    AgentRunRuntimeActor.start("run-setup-failure", {}, {
      baseCwd: "\0invalid",
      runtimeActorHost: new FakeActorHost(),
    }),
    /workspace must be a non-empty path/,
  );
});

test("AgentRun maps Pi progress without inferring settlement and broker acquisition failures surface", async () => {
  const host = new FakeActorHost();
  const actor = await AgentRunRuntimeActor.start("run-pi", {}, {
    baseCwd: process.cwd(),
    runtimeActorHost: host,
  });
  const progress: AgentProgress = {
    agent: "general",
    status: "running",
    recentTools: [{ name: "read", status: "completed" }],
    toolCount: 1,
    tokens: 0,
    startedAt: 1,
    durationMs: 1,
    lastActivityAt: 2,
  };
  actor.progressAfterV1(progress);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(host.batches.flat().map((item) => item.kind), ["tool.started", "tool.finished"]);
  assert.equal(host.batches.flat().some((item) => item.kind === "run.settled"), false);
  await actor.abort();

  const unavailable = new FakeActorHost();
  unavailable.failAcquire = true;
  await assert.rejects(
    AgentRunRuntimeActor.start("run-unavailable", {}, {
      baseCwd: process.cwd(),
      runtimeActorHost: unavailable,
    }),
    /broker unavailable/,
  );
  assert.equal(unavailable.batches.length, 0);

  const contended = new FakeActorHost();
  contended.unavailable = true;
  await assert.rejects(
    AgentRunRuntimeActor.start("run-contended", {}, {
      baseCwd: process.cwd(),
      runtimeActorHost: contended,
    }),
    (error) => error instanceof RuntimeBrokerError && error.code === "lease_unavailable",
  );
  assert.equal(contended.batches.length, 0, "enabled contention must never execute through unwrapped V1 callbacks");
});
