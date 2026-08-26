import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RuntimeBrokerClient } from "../src/runtime-broker/client.ts";
import type {
  AcquireLeaseRequest,
  ActorLease,
  ReleaseLeaseRequest,
  RuntimeBrokerCommitRequest,
  RuntimeBrokerCommitResult,
} from "../src/runtime-broker/contracts.ts";
import { RuntimeBrokerServer } from "../src/runtime-broker/server.ts";
import { RuntimeBrokerSqliteStore } from "../src/runtime-broker/sqlite-store.ts";
import {
  RuntimeBrokerMailboxCommitter,
  runtimeBrokerMailboxStreamId,
} from "../src/runtime-broker/mailbox-commit.ts";
import { computeEnvelopeHash } from "../src/extension/mailbox/file-store.ts";
import type { MailboxAuthority } from "../src/extension/mailbox/router.ts";
import { MailboxService } from "../src/extension/mailbox/service.ts";
import {
  MAILBOX_SCHEMA_VERSION,
  type MailboxEnvelope,
} from "../src/extension/mailbox/types.ts";

const TEST_WORKSPACE_ID = "a".repeat(64);

function envelope(messageId: string = randomUUID()): MailboxEnvelope {
  return {
    messageId,
    schemaVersion: MAILBOX_SCHEMA_VERSION,
    workspaceId: TEST_WORKSPACE_ID,
    teamId: "team-root",
    senderId: "caller",
    recipientId: "worker",
    recipientCorrelationId: "worker-correlation",
    kind: "follow_up",
    mode: "follow_up",
    priority: "normal",
    senderSeq: 1,
    createdAt: 10,
    expiresAt: 10_000,
    ttlMs: 9_990,
    sessionGeneration: 1,
    leaseEpoch: 1,
    leaseNonce: "lease-nonce",
    payload: "do work",
    hash: "compatibility-file-hash",
    correlationId: "correlation-a",
  };
}

function durableEnvelope(messageId: string): MailboxEnvelope {
  const message = envelope(messageId);
  const { hash: _hash, ...body } = message;
  return { ...body, hash: computeEnvelopeHash(body) };
}

function permissiveMailboxAuthority(): MailboxAuthority {
  return {
    canRoute: () => ({ allowed: true }),
    currentGeneration: () => 1,
    currentLeaseEpoch: () => 1,
    currentLeaseNonce: () => "lease-nonce",
    isFenced: () => false,
    isStaleUnauthorized: () => false,
    managesRecipient: () => true,
  };
}

function createRestartMailboxService(options: {
  rootDir: string;
  now: () => number;
  commitApplied: (envelope: MailboxEnvelope) => Promise<void>;
  onDispatch: (envelope: MailboxEnvelope) => Promise<void>;
}): MailboxService {
  return new MailboxService({
    rootDir: options.rootDir,
    authority: permissiveMailboxAuthority(),
    recipientCorrelationId: "worker-correlation",
    workspaceId: TEST_WORKSPACE_ID,
    teamId: "team-root",
    ownerId: "restart-owner",
    commitApplied: options.commitApplied,
    onDispatch: options.onDispatch,
    pollMs: 5,
    now: options.now,
  });
}

async function strandAcceptedEnvelope(
  service: MailboxService,
  message: MailboxEnvelope,
  now: number,
): Promise<void> {
  await service.start(false);
  await service.store.writeStaging(message);
  assert.equal(await service.store.promoteToReady(message.messageId), true);
  const claim = {
    messageId: message.messageId,
    claimerNonce: "consumer-before-crash",
    claimedAt: now,
    leaseExpiresAt: now + 30_000,
    lastHeartbeatAt: now,
  };
  assert.equal(await service.store.claim(message.messageId, claim), true);
  assert.equal(await service.store.accept(message.messageId, claim), true);
}

function sqliteBrokerClient(
  store: RuntimeBrokerSqliteStore,
  options: { onAcquire?: () => void; orphanRelease?: boolean } = {},
): RuntimeBrokerClient {
  return {
    acquireLease: async (request: AcquireLeaseRequest, requestId?: string) => {
      options.onAcquire?.();
      return store.acquireLease(request, requestId);
    },
    commit: async (request: RuntimeBrokerCommitRequest) => store.commit(request),
    releaseLease: async (request: ReleaseLeaseRequest, requestId?: string) => {
      if (!options.orphanRelease) store.releaseLease(request, requestId);
    },
    close: async () => {},
  } as unknown as RuntimeBrokerClient;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function settlePrewarm(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("mailbox applied receipt and domain event commit atomically before duplicate delivery", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "runtime-broker-mailbox-"));
  const server = new RuntimeBrokerServer({ stateDirectory });
  const committer = new RuntimeBrokerMailboxCommitter({
    stateDirectory,
    holderId: "window-a",
    // This test owns an in-process server rather than the canonical daemon
    // lease, so connect directly to that server after listen().
    clientFactory: () => RuntimeBrokerClient.connect({ stateDirectory }),
  });
  try {
    await server.listen();
    const message = envelope();
    const first = await committer.commit(message);
    const duplicate = await committer.commit(message);
    assert.equal(first.recovered, false);
    assert.equal(duplicate.recovered, true);
    assert.equal(duplicate.revision, first.revision);
    assert.deepEqual(duplicate.eventIds, first.eventIds);

    const database = new DatabaseSync(server.databasePath, { readOnly: true });
    try {
      const inbox = database.prepare(
        "SELECT stream_id, applied_revision, result_json FROM inbox WHERE message_id = ?",
      ).get(message.messageId) as { stream_id: string; applied_revision: number; result_json: string };
      const events = database.prepare(
        "SELECT stream_id, revision, event_type FROM events WHERE message_id = ?",
      ).all(message.messageId) as Array<{ stream_id: string; revision: number; event_type: string }>;
      assert.equal(inbox.stream_id, runtimeBrokerMailboxStreamId(message.messageId));
      assert.equal(inbox.applied_revision, 1);
      const storedResult = JSON.parse(inbox.result_json) as { reply?: unknown };
      assert.deepEqual(storedResult.reply, {
        state: "applied",
        recipientCorrelationId: message.recipientCorrelationId,
      });
      assert.deepEqual(events.map((event) => ({ ...event })), [{
        stream_id: runtimeBrokerMailboxStreamId(message.messageId),
        revision: 1,
        event_type: "mailbox.applied",
      }]);
    } finally {
      database.close();
    }
  } finally {
    await committer.close();
    await server.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("mailbox strict commit reconnects and replays lost acquire with its stable requestId", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "runtime-broker-mailbox-retry-"));
  const message = envelope("mailbox-lost-acquire");
  const streamId = runtimeBrokerMailboxStreamId(message.messageId);
  const lease: ActorLease = {
    actorId: streamId,
    streamId,
    holderId: "window-a",
    epoch: 3,
    nonce: "nonce-3",
    acquiredAt: 1,
    heartbeatAt: 1,
    expiresAt: 10_000,
  };
  const acquireCalls: Array<{ params: unknown; requestId?: string }> = [];
  let firstClosed = 0;
  const firstClient = {
    acquireLease: async (params: unknown, requestId?: string) => {
      acquireCalls.push({ params, requestId });
      throw Object.assign(new Error("acquire response was lost"), { code: "ECONNRESET" });
    },
    close: async () => { firstClosed += 1; },
  } as unknown as RuntimeBrokerClient;
  const secondClient = {
    acquireLease: async (params: unknown, requestId?: string) => {
      acquireCalls.push({ params, requestId });
      return lease;
    },
    commit: async (request: RuntimeBrokerCommitRequest) => ({
      messageId: request.messageId,
      streamId: request.streamId,
      previousRevision: 0,
      revision: 1,
      eventIds: request.events.map((event) => event.eventId),
      outboxIds: [],
      appliedAt: 10,
      recovered: true,
    }),
    releaseLease: async () => {},
    close: async () => {},
  } as unknown as RuntimeBrokerClient;
  const clients = [firstClient, secondClient];
  let connections = 0;
  const committer = new RuntimeBrokerMailboxCommitter({
    stateDirectory,
    holderId: "window-a",
    clientFactory: async () => clients[connections++]!,
  });
  try {
    const result = await committer.commit(message);
    const laterInvocation = await committer.commit(message);
    assert.equal(result.recovered, true);
    assert.equal(laterInvocation.recovered, true);
    assert.equal(connections, 2);
    assert.equal(firstClosed, 1);
    assert.deepEqual(acquireCalls[1]?.params, acquireCalls[0]?.params);
    assert.equal(typeof acquireCalls[0]?.requestId, "string");
    assert.equal(acquireCalls[1]?.requestId, acquireCalls[0]?.requestId);
    assert.notEqual(acquireCalls[2]?.requestId, acquireCalls[0]?.requestId);
  } finally {
    await committer.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("immediate fresh consumer defers crash-after-acquire until the orphan lease expires", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "runtime-broker-mailbox-crash-acquire-"));
  const databasePath = join(stateDirectory, "broker.sqlite");
  const mailboxRoot = join(stateDirectory, "file-mailbox");
  let now = 100;
  const store = new RuntimeBrokerSqliteStore(databasePath, {
    now: () => now,
    nonce: () => `nonce-${now}`,
  });
  const message = durableEnvelope("00000000-0000-4000-8000-000000000017");
  const streamId = runtimeBrokerMailboxStreamId(message.messageId);
  const orphanLease = store.acquireLease({
    actorId: streamId,
    streamId,
    holderId: "holder-before-crash",
    ttlMs: 5_000,
  }, "crash-before-commit:lease.acquire");
  const stranded = createRestartMailboxService({
    rootDir: mailboxRoot,
    now: () => now,
    commitApplied: async () => {},
    onDispatch: async () => {},
  });
  let acquireAttempts = 0;
  const replayResults: RuntimeBrokerCommitResult[] = [];
  const dispatched: string[] = [];
  const replayCommitter = new RuntimeBrokerMailboxCommitter({
    stateDirectory,
    holderId: "holder-after-crash",
    clientFactory: async () => sqliteBrokerClient(store, {
      onAcquire: () => { acquireAttempts += 1; },
    }),
  });
  let restarted: MailboxService | undefined;
  try {
    await strandAcceptedEnvelope(stranded, message, now);
    replayCommitter.prewarm();
    await settlePrewarm();
    restarted = createRestartMailboxService({
      rootDir: mailboxRoot,
      now: () => now,
      commitApplied: async (candidate) => {
        const result = await replayCommitter.commitIfReady(candidate);
        if (result) replayResults.push(result);
      },
      onDispatch: async (candidate) => { dispatched.push(candidate.messageId); },
    });

    // Start at the same broker time as the crash. More than five poll periods
    // elapse below, so the old behavior would exhaust MAX_DISPATCH_RETRIES.
    await restarted.start();
    await waitFor(
      async () => acquireAttempts === 1 && !!(await restarted!.store.readEnvelope("ready", message.messageId)),
      "fresh consumer did not requeue the lease-contended envelope",
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(now, 100);
    assert.equal(acquireAttempts, 1, "consumer must wait for broker expiresAt instead of hot-looping");
    assert.deepEqual(dispatched, []);
    assert.equal((await restarted.store.listMessages("dead")).includes(message.messageId), false);

    now = orphanLease.expiresAt - 1;
    restarted.consumer.notify();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(acquireAttempts, 1, "consumer must remain deferred before expiresAt");

    now = orphanLease.expiresAt;
    restarted.consumer.notify();
    await waitFor(
      async () => !!(await restarted!.store.readEnvelope("applied", message.messageId)),
      "fresh consumer did not recover at broker lease expiry",
    );

    assert.equal(acquireAttempts, 2);
    assert.deepEqual(dispatched, [message.messageId]);
    assert.equal(replayResults.length, 1);
    assert.equal(replayResults[0]?.recovered, false);
    assert.equal(store.getStreamRevision(streamId), 1);
    assert.equal(store.readEvents(streamId).length, 1);
    assert.equal((await restarted.store.listMessages("dead")).includes(message.messageId), false);
  } finally {
    await restarted?.stop();
    await stranded.stop();
    await replayCommitter.close();
    store.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("immediate fresh consumer recovers post-commit after orphan lease expiry without duplicate", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "runtime-broker-mailbox-post-commit-"));
  const databasePath = join(stateDirectory, "broker.sqlite");
  const mailboxRoot = join(stateDirectory, "file-mailbox");
  let now = 100;
  const store = new RuntimeBrokerSqliteStore(databasePath, {
    now: () => now,
    nonce: () => `nonce-${now}`,
  });
  const message = durableEnvelope("00000000-0000-4000-8000-000000000018");
  const streamId = runtimeBrokerMailboxStreamId(message.messageId);
  const firstCommitter = new RuntimeBrokerMailboxCommitter({
    stateDirectory,
    holderId: "holder-before-restart",
    clientFactory: async () => sqliteBrokerClient(store, { orphanRelease: true }),
  });
  const stranded = createRestartMailboxService({
    rootDir: mailboxRoot,
    now: () => now,
    commitApplied: async () => {},
    onDispatch: async () => {},
  });
  let acquireAttempts = 0;
  const replayResults: RuntimeBrokerCommitResult[] = [];
  const dispatched: string[] = [];
  const replayCommitter = new RuntimeBrokerMailboxCommitter({
    stateDirectory,
    holderId: "holder-after-restart",
    clientFactory: async () => sqliteBrokerClient(store, {
      onAcquire: () => { acquireAttempts += 1; },
    }),
  });
  let restarted: MailboxService | undefined;
  try {
    const committed = await firstCommitter.commit(message);
    await firstCommitter.close();
    const orphanLease = store.getLease(streamId);
    assert.ok(orphanLease, "post-commit crash fixture must retain the acquired lease");
    assert.equal(committed.recovered, false);
    assert.equal(store.readEvents(streamId).length, 1);
    await strandAcceptedEnvelope(stranded, message, now);

    replayCommitter.prewarm();
    await settlePrewarm();
    restarted = createRestartMailboxService({
      rootDir: mailboxRoot,
      now: () => now,
      commitApplied: async (candidate) => {
        const result = await replayCommitter.commitIfReady(candidate);
        if (result) replayResults.push(result);
      },
      onDispatch: async (candidate) => { dispatched.push(candidate.messageId); },
    });
    await restarted.start();
    await waitFor(
      async () => acquireAttempts === 1 && !!(await restarted!.store.readEnvelope("ready", message.messageId)),
      "post-commit restart did not defer the orphaned lease",
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(acquireAttempts, 1);
    assert.deepEqual(dispatched, []);
    assert.equal((await restarted.store.listMessages("dead")).includes(message.messageId), false);

    now = orphanLease.expiresAt;
    restarted.consumer.notify();
    await waitFor(
      async () => !!(await restarted!.store.readEnvelope("applied", message.messageId)),
      "post-commit envelope did not recover at lease expiry",
    );

    assert.equal(acquireAttempts, 2);
    assert.deepEqual(dispatched, [message.messageId]);
    assert.equal(replayResults.length, 1);
    assert.equal(replayResults[0]?.recovered, true);
    assert.equal(replayResults[0]?.revision, committed.revision);
    assert.deepEqual(replayResults[0]?.eventIds, committed.eventIds);
    assert.equal(store.getStreamRevision(streamId), 1);
    assert.equal(store.readEvents(streamId).length, 1);
    assert.equal((await restarted.store.listMessages("dead")).includes(message.messageId), false);

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const eventCount = database.prepare("SELECT COUNT(*) AS count FROM events WHERE message_id = ?")
        .get(message.messageId) as { count: number };
      const inboxCount = database.prepare("SELECT COUNT(*) AS count FROM inbox WHERE message_id = ?")
        .get(message.messageId) as { count: number };
      assert.equal(eventCount.count, 1);
      assert.equal(inboxCount.count, 1);
    } finally {
      database.close();
    }
  } finally {
    await restarted?.stop();
    await stranded.stop();
    await replayCommitter.close();
    await firstCommitter.close();
    store.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("mailbox broker commit fails closed while the sidecar is unavailable", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "runtime-broker-mailbox-down-"));
  const committer = new RuntimeBrokerMailboxCommitter({
    stateDirectory,
    holderId: "window-a",
    clientFactory: () => RuntimeBrokerClient.connect({ stateDirectory, timeoutMs: 100 }),
  });
  try {
    await assert.rejects(committer.commit(envelope()));
  } finally {
    await committer.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("mailbox compatibility commit does not await broker prewarm", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "runtime-broker-mailbox-prewarm-"));
  const server = new RuntimeBrokerServer({ stateDirectory });
  let client: RuntimeBrokerClient | undefined;
  let releaseClient!: (value: RuntimeBrokerClient) => void;
  const clientReady = new Promise<RuntimeBrokerClient>((resolve) => { releaseClient = resolve; });
  const committer = new RuntimeBrokerMailboxCommitter({
    stateDirectory,
    holderId: "window-a",
    clientFactory: () => clientReady,
  });
  try {
    await server.listen();
    client = await RuntimeBrokerClient.connect({ stateDirectory });
    committer.prewarm();
    assert.equal(await committer.commitIfReady(envelope("compatibility-first")), undefined);

    releaseClient(client);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const committed = await committer.commitIfReady(envelope("broker-ready"));
    assert.equal(committed?.recovered, false);
    client = undefined;
  } finally {
    await committer.close();
    await client?.close();
    await server.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("initial malformed broker handshake latches repeated calls until a validated replacement connects", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "runtime-broker-mailbox-bootstrap-fault-"));
  const databasePath = join(stateDirectory, "broker.sqlite");
  const store = new RuntimeBrokerSqliteStore(databasePath);
  const handshakeFault = new Error("Runtime broker readiness handshake mismatch");
  const replacementClient = sqliteBrokerClient(store);
  let releaseReplacement!: (client: RuntimeBrokerClient) => void;
  const replacementReady = new Promise<RuntimeBrokerClient>((resolve) => { releaseReplacement = resolve; });
  let connections = 0;
  const committer = new RuntimeBrokerMailboxCommitter({
    stateDirectory,
    holderId: "window-a",
    clientFactory: () => {
      connections += 1;
      return connections === 1 ? Promise.reject(handshakeFault) : replacementReady;
    },
  });
  try {
    committer.prewarm();
    await waitFor(() => connections === 2, "bootstrap fault did not start one replacement acquisition");

    for (const messageId of ["bootstrap-fault-first", "bootstrap-fault-repeat"]) {
      await assert.rejects(
        committer.commitIfReady(envelope(messageId)),
        (error) => error === handshakeFault,
      );
    }
    assert.equal(connections, 2, "repeated calls must join the replacement single-flight");

    releaseReplacement(replacementClient);
    await settlePrewarm();
    const recovered = await committer.commitIfReady(envelope("bootstrap-fault-recovered"));
    assert.equal(recovered?.recovered, false);
    assert.equal(connections, 2);
  } finally {
    releaseReplacement(replacementClient);
    await committer.close();
    store.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("initial broker transport rejection remains compatibility fail-open", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "runtime-broker-mailbox-bootstrap-transport-"));
  const transportFault = Object.assign(new Error("broker endpoint is not listening"), {
    code: "ECONNREFUSED",
  });
  const unresolvedReplacement = new Promise<RuntimeBrokerClient>(() => undefined);
  let connections = 0;
  const committer = new RuntimeBrokerMailboxCommitter({
    stateDirectory,
    holderId: "window-a",
    clientFactory: () => {
      connections += 1;
      return connections === 1 ? Promise.reject(transportFault) : unresolvedReplacement;
    },
  });
  try {
    assert.equal(await committer.commitIfReady(envelope("bootstrap-transport-first")), undefined);
    await settlePrewarm();
    assert.equal(connections, 1, "transport bootstrap rejection must not hot-loop");

    assert.equal(await committer.commitIfReady(envelope("bootstrap-transport-repeat")), undefined);
    assert.equal(connections, 2, "a later call may start a clean replacement prewarm");
  } finally {
    await committer.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("mailbox compatibility commit fails open after a cached broker connection dies", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "runtime-broker-mailbox-restart-"));
  const server = new RuntimeBrokerServer({ stateDirectory });
  const replacement = new Promise<RuntimeBrokerClient>(() => undefined);
  let client: RuntimeBrokerClient | undefined;
  let attempts = 0;
  const committer = new RuntimeBrokerMailboxCommitter({
    stateDirectory,
    holderId: "window-a",
    clientFactory: () => ++attempts === 1 ? Promise.resolve(client!) : replacement,
  });
  try {
    await server.listen();
    client = await RuntimeBrokerClient.connect({ stateDirectory });
    await committer.commit(envelope("broker-prime"));
    await server.close();

    assert.equal(await committer.commitIfReady(envelope("compatibility-after-exit")), undefined);
    assert.equal(attempts, 2, "transport failure starts a replacement prewarm");
    await committer.close();
  } finally {
    await committer.close();
    await client?.close();
    await server.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("mailbox compatibility commit does not fail open on broker protocol errors", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "runtime-broker-mailbox-protocol-"));
  const server = new RuntimeBrokerServer({ stateDirectory });
  let client: RuntimeBrokerClient | undefined;
  const committer = new RuntimeBrokerMailboxCommitter({
    stateDirectory,
    holderId: "window-a",
    clientFactory: async () => client!,
  });
  try {
    await server.listen();
    client = await RuntimeBrokerClient.connect({ stateDirectory });
    await committer.commit(envelope("broker-protocol-prime"));
    client.acquireLease = async () => { throw new Error("malformed broker response"); };
    await assert.rejects(
      committer.commitIfReady(envelope("broker-protocol-invalid")),
      /malformed broker response/,
    );
  } finally {
    await committer.close();
    await client?.close();
    await server.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("same envelope stays fail-closed after protocol then cached-socket transport failure", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "runtime-broker-mailbox-protocol-latch-"));
  const message = envelope("broker-protocol-then-transport");
  const streamId = runtimeBrokerMailboxStreamId(message.messageId);
  const lease: ActorLease = {
    actorId: streamId,
    streamId,
    holderId: "window-a",
    epoch: 1,
    nonce: "replacement-nonce",
    acquiredAt: 1,
    heartbeatAt: 1,
    expiresAt: 10_000,
  };
  let staleAcquireCalls = 0;
  const staleClient = {
    acquireLease: async () => {
      staleAcquireCalls += 1;
      if (staleAcquireCalls === 1) throw new Error("malformed broker response");
      throw Object.assign(new Error("destroyed cached socket"), { code: "ERR_STREAM_DESTROYED" });
    },
    close: async () => {},
  } as unknown as RuntimeBrokerClient;
  const replacementClient = {
    acquireLease: async () => lease,
    commit: async (request: RuntimeBrokerCommitRequest) => ({
      messageId: request.messageId,
      streamId: request.streamId,
      previousRevision: 0,
      revision: 1,
      eventIds: request.events.map((event) => event.eventId),
      outboxIds: [],
      appliedAt: 10,
      recovered: false,
    }),
    releaseLease: async () => {},
    close: async () => {},
  } as unknown as RuntimeBrokerClient;
  let releaseReplacement!: (client: RuntimeBrokerClient) => void;
  const replacementReady = new Promise<RuntimeBrokerClient>((resolve) => { releaseReplacement = resolve; });
  let connections = 0;
  const committer = new RuntimeBrokerMailboxCommitter({
    stateDirectory,
    holderId: "window-a",
    clientFactory: () => ++connections === 1 ? Promise.resolve(staleClient) : replacementReady,
  });
  try {
    committer.prewarm();
    await settlePrewarm();
    // Both calls capture the same cached client before the serialized first
    // operation discovers that its response is invalid.
    const protocolAttempt = committer.commitIfReady(message);
    const transportAttempt = committer.commitIfReady(message);
    await assert.rejects(protocolAttempt, /malformed broker response/);
    await assert.rejects(transportAttempt, /malformed broker response/);
    assert.equal(staleAcquireCalls, 2);
    assert.equal(connections, 2, "protocol failure starts a separately validated replacement prewarm");

    // The immutable latch also rejects calls made while replacement readiness
    // is unresolved instead of degrading to compatibility fail-open.
    await assert.rejects(committer.commitIfReady(message), /malformed broker response/);
    releaseReplacement(replacementClient);
    await settlePrewarm();
    assert.equal((await committer.commitIfReady(message))?.recovered, false);
  } finally {
    releaseReplacement(replacementClient);
    await committer.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("concurrent client waiters share one generation across protocol retirement and replacement", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "runtime-broker-mailbox-client-singleflight-"));
  const protocolFault = new Error("malformed response from shared cached client");
  let rejectProtocol!: (reason?: unknown) => void;
  const pendingProtocolResponse = new Promise<ActorLease>((_resolve, reject) => {
    rejectProtocol = reject;
  });
  let signalAcquireStarted!: () => void;
  const acquireStarted = new Promise<void>((resolve) => { signalAcquireStarted = resolve; });
  let staleAcquireCalls = 0;
  let staleCloseCalls = 0;
  const staleClient = {
    acquireLease: async () => {
      staleAcquireCalls += 1;
      if (staleAcquireCalls === 1) {
        signalAcquireStarted();
        return pendingProtocolResponse;
      }
      throw Object.assign(new Error("shared cached socket is stale"), { code: "ERR_STREAM_DESTROYED" });
    },
    close: async () => { staleCloseCalls += 1; },
  } as unknown as RuntimeBrokerClient;

  let replacementAcquireCalls = 0;
  let replacementCloseCalls = 0;
  const replacementClient = {
    acquireLease: async (request: AcquireLeaseRequest) => {
      replacementAcquireCalls += 1;
      if (replacementAcquireCalls > 1) {
        throw Object.assign(new Error("clean replacement transport exit"), { code: "ECONNRESET" });
      }
      return {
        actorId: request.actorId,
        streamId: request.streamId ?? request.actorId,
        holderId: request.holderId ?? "window-a",
        epoch: 2,
        nonce: "replacement-generation-nonce",
        acquiredAt: 1,
        heartbeatAt: 1,
        expiresAt: 10_000,
      } satisfies ActorLease;
    },
    commit: async (request: RuntimeBrokerCommitRequest) => ({
      messageId: request.messageId,
      streamId: request.streamId,
      previousRevision: 0,
      revision: 1,
      eventIds: request.events.map((event) => event.eventId),
      outboxIds: [],
      appliedAt: 10,
      recovered: false,
    }),
    releaseLease: async () => {},
    close: async () => { replacementCloseCalls += 1; },
  } as unknown as RuntimeBrokerClient;

  let releaseFirstClient!: (client: RuntimeBrokerClient) => void;
  const firstClientReady = new Promise<RuntimeBrokerClient>((resolve) => { releaseFirstClient = resolve; });
  const unresolvedThirdClient = new Promise<RuntimeBrokerClient>(() => undefined);
  let connections = 0;
  const committer = new RuntimeBrokerMailboxCommitter({
    stateDirectory,
    holderId: "window-a",
    clientFactory: () => {
      connections += 1;
      if (connections === 1) return firstClientReady;
      if (connections === 2) return Promise.resolve(replacementClient);
      return unresolvedThirdClient;
    },
  });
  try {
    // The strict call starts the first #getClient waiter. Prewarm then becomes a
    // concurrent waiter for the same unresolved physical client acquisition.
    const protocolAttempt = committer.commit(envelope("broker-concurrent-waiter-protocol"));
    await waitFor(() => connections === 1, "strict commit did not start client acquisition");
    committer.prewarm();
    releaseFirstClient(staleClient);
    await acquireStarted;

    // This compatibility call captures the cached generation while the first
    // operation still awaits its protocol response.
    const staleTransportAttempt = committer.commitIfReady(
      envelope("broker-concurrent-waiter-stale-transport"),
    );
    rejectProtocol(protocolFault);
    const staleGenerationResults = await Promise.allSettled([
      protocolAttempt,
      staleTransportAttempt,
    ]);
    assert.equal(staleGenerationResults[0]?.status, "rejected");
    assert.equal(staleGenerationResults[1]?.status, "rejected");
    if (staleGenerationResults[0]?.status === "rejected") {
      assert.equal(staleGenerationResults[0].reason, protocolFault);
    }
    if (staleGenerationResults[1]?.status === "rejected") {
      assert.equal(staleGenerationResults[1].reason, protocolFault);
    }
    assert.equal(staleAcquireCalls, 2);
    assert.equal(staleCloseCalls, 1, "one physical cached client must be retired exactly once");
    assert.equal(connections, 2, "protocol retirement starts exactly one replacement acquisition");

    await settlePrewarm();
    const replacementResult = await committer.commitIfReady(
      envelope("broker-concurrent-waiter-replacement"),
    );
    assert.equal(replacementResult?.recovered, false);

    // The validated replacement is a clean generation, so its independent
    // transport failure retains compatibility fail-open behavior.
    assert.equal(
      await committer.commitIfReady(envelope("broker-clean-replacement-transport-exit")),
      undefined,
    );
    assert.equal(replacementCloseCalls, 1);
    assert.equal(connections, 3);
  } finally {
    releaseFirstClient(staleClient);
    rejectProtocol(protocolFault);
    await committer.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("queued stale generation stays fail-closed when replacement is ready immediately", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "runtime-broker-mailbox-generation-latch-"));
  const message = envelope("broker-fast-replacement-race");
  const protocolFault = new Error("malformed broker response from stale generation");
  let staleAcquireCalls = 0;
  const staleClient = {
    acquireLease: async () => {
      staleAcquireCalls += 1;
      if (staleAcquireCalls === 1) throw protocolFault;
      throw Object.assign(new Error("stale generation socket closed"), { code: "ERR_STREAM_DESTROYED" });
    },
    close: async () => {},
  } as unknown as RuntimeBrokerClient;

  let replacementAcquireCalls = 0;
  const replacementClient = {
    acquireLease: async (request: AcquireLeaseRequest) => {
      replacementAcquireCalls += 1;
      if (replacementAcquireCalls > 1) {
        throw Object.assign(new Error("clean generation transport exit"), { code: "ECONNRESET" });
      }
      return {
        actorId: request.actorId,
        streamId: request.streamId ?? request.actorId,
        holderId: request.holderId ?? "window-a",
        epoch: 2,
        nonce: "clean-generation-nonce",
        acquiredAt: 1,
        heartbeatAt: 1,
        expiresAt: 10_000,
      } satisfies ActorLease;
    },
    commit: async (request: RuntimeBrokerCommitRequest) => ({
      messageId: request.messageId,
      streamId: request.streamId,
      previousRevision: 0,
      revision: 1,
      eventIds: request.events.map((event) => event.eventId),
      outboxIds: [],
      appliedAt: 10,
      recovered: false,
    }),
    releaseLease: async () => {},
    close: async () => {},
  } as unknown as RuntimeBrokerClient;
  const unresolvedReplacement = new Promise<RuntimeBrokerClient>(() => undefined);
  let connections = 0;
  const committer = new RuntimeBrokerMailboxCommitter({
    stateDirectory,
    holderId: "window-a",
    clientFactory: () => {
      connections += 1;
      if (connections === 1) return Promise.resolve(staleClient);
      if (connections === 2) return Promise.resolve(replacementClient);
      return unresolvedReplacement;
    },
  });
  try {
    committer.prewarm();
    await settlePrewarm();

    // Both calls capture generation 1 before its first queued operation exposes
    // the validation fault. Generation 2 becomes ready without any delay.
    const firstOldGenerationCall = committer.commitIfReady(message);
    const secondOldGenerationCall = committer.commitIfReady(message);
    const oldGenerationResults = await Promise.allSettled([
      firstOldGenerationCall,
      secondOldGenerationCall,
    ]);
    assert.equal(oldGenerationResults[0]?.status, "rejected");
    assert.equal(oldGenerationResults[1]?.status, "rejected");
    if (oldGenerationResults[0]?.status === "rejected") {
      assert.equal(oldGenerationResults[0].reason, protocolFault);
    }
    if (oldGenerationResults[1]?.status === "rejected") {
      assert.equal(oldGenerationResults[1].reason, protocolFault);
    }
    assert.equal(staleAcquireCalls, 2);
    assert.equal(connections, 2, "validation fault immediately prewarms a clean generation");

    await settlePrewarm();
    const newGenerationResult = await committer.commitIfReady(envelope("broker-clean-generation"));
    assert.equal(newGenerationResult?.recovered, false);

    // The old generation fault must not leak into a clean generation that only
    // experiences a transport exit; compatibility mode remains fail-open.
    assert.equal(
      await committer.commitIfReady(envelope("broker-clean-generation-transport-exit")),
      undefined,
    );
    assert.equal(connections, 3);
  } finally {
    await committer.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("mailbox close does not wait for an unresolved prewarm", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "runtime-broker-mailbox-close-"));
  const committer = new RuntimeBrokerMailboxCommitter({
    stateDirectory,
    holderId: "window-a",
    clientFactory: () => new Promise<RuntimeBrokerClient>(() => undefined),
  });
  try {
    committer.prewarm();
    let closed = false;
    const closing = committer.close().then(() => { closed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, true);
    await closing;
  } finally {
    await committer.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});
