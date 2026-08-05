import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import {
  MailboxFileStore,
  computeEnvelopeHash,
  createMailboxPaths,
  ensureMailboxDirectories,
} from "../src/extension/mailbox/file-store.ts";
import { QuotaAdmission } from "../src/extension/mailbox/gc.ts";
import {
  type MailboxConsumerOptions,
  MailboxConsumer,
  isHighPriority,
  selectNext,
} from "../src/extension/mailbox/consumer.ts";
import { type MailboxAuthority, MailboxRouter } from "../src/extension/mailbox/router.ts";
import {
  type MailboxEnvelope,
  type MailboxPaths,
  CLAIM_STALE_MS,
  MAILBOX_SCHEMA_VERSION,
  TTL_NORMAL_MS,
} from "../src/extension/mailbox/types.ts";

const temporaryDirectories: string[] = [];
let paths: MailboxPaths;
let store: MailboxFileStore;
let quota: QuotaAdmission;
let router: MailboxRouter;
let nowMs: number;

function permissiveAuthority(): MailboxAuthority {
  return {
    canRoute: () => ({ allowed: true }),
    currentGeneration: () => 1,
    currentLeaseEpoch: () => 1,
    currentLeaseNonce: () => "nonce-abc",
    isFenced: () => false,
    isStaleUnauthorized: () => false,
  };
}

function makeEnvelope(id: string, overrides: Partial<MailboxEnvelope> = {}): MailboxEnvelope {
  const base: Omit<MailboxEnvelope, "hash"> = {
    messageId: id,
    schemaVersion: MAILBOX_SCHEMA_VERSION,
    workspaceId: "a".repeat(64),
    teamId: "team-root",
    senderId: "b".repeat(32),
    recipientId: "c".repeat(32),
    recipientCorrelationId: "corr-001",
    kind: "follow_up",
    mode: "follow_up",
    priority: "normal",
    senderSeq: 1,
    createdAt: nowMs,
    expiresAt: nowMs + TTL_NORMAL_MS,
    ttlMs: TTL_NORMAL_MS,
    sessionGeneration: 1,
    leaseEpoch: 1,
    leaseNonce: "nonce-abc",
    payload: "test",
    ...overrides,
  };
  return { ...base, hash: computeEnvelopeHash(base) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "mailbox-consumer-"));
  temporaryDirectories.push(base);
  paths = createMailboxPaths(join(base, "mailbox"));
  await ensureMailboxDirectories(paths);
  nowMs = 1_700_000_000_000;
  store = new MailboxFileStore({ paths, now: () => nowMs });
  quota = new QuotaAdmission({ store });
  router = new MailboxRouter({ store, authority: permissiveAuthority(), quota, now: () => nowMs });
});

// --- selectNext unit tests ---

test("selectNext picks critical over high over normal", () => {
  const critical = makeEnvelope("00000000-0000-4000-8000-000000000001", { priority: "critical", senderSeq: 3 });
  const high = makeEnvelope("00000000-0000-4000-8000-000000000002", { priority: "high", senderSeq: 1 });
  const normal = makeEnvelope("00000000-0000-4000-8000-000000000003", { priority: "normal", senderSeq: 2 });

  const selected = selectNext([normal, high, critical], 0);
  assert.equal(selected?.messageId, critical.messageId);
});

test("selectNext picks high over normal when no critical", () => {
  const high = makeEnvelope("00000000-0000-4000-8000-000000000002", { priority: "high", senderSeq: 1 });
  const normal = makeEnvelope("00000000-0000-4000-8000-000000000003", { priority: "normal", senderSeq: 2 });

  const selected = selectNext([normal, high], 0);
  assert.equal(selected?.messageId, high.messageId);
});

test("selectNext enforces FIFO within same priority lane", () => {
  const first = makeEnvelope("00000000-0000-4000-8000-000000000001", { priority: "normal", senderSeq: 1 });
  const second = makeEnvelope("00000000-0000-4000-8000-000000000002", { priority: "normal", senderSeq: 2 });
  const third = makeEnvelope("00000000-0000-4000-8000-000000000003", { priority: "normal", senderSeq: 3 });

  const selected = selectNext([third, first, second], 0);
  assert.equal(selected?.messageId, first.messageId);
});

test("starvation bound: after 8 consecutive high, slot 9 is normal", () => {
  const highMessages = Array.from({ length: 10 }, (_, i) =>
    makeEnvelope(`00000000-0000-4000-8000-0000000000${String(i + 1).padStart(2, "0")}`, {
      priority: "high" as const,
      senderSeq: i + 1,
    }),
  );
  const normal = makeEnvelope("00000000-0000-4000-8000-000000000099", { priority: "normal", senderSeq: 100 });

  // With consecutiveHigh = 8, should pick normal
  const selected = selectNext([...highMessages, normal], 8);
  assert.equal(selected?.messageId, normal.messageId);
  assert.equal(selected?.priority, "normal");
});

test("starvation bound: below 8 consecutive high, still picks high", () => {
  const high = makeEnvelope("00000000-0000-4000-8000-000000000001", { priority: "high", senderSeq: 1 });
  const normal = makeEnvelope("00000000-0000-4000-8000-000000000002", { priority: "normal", senderSeq: 2 });

  const selected = selectNext([high, normal], 7);
  assert.equal(selected?.messageId, high.messageId);
});

test("starvation bound: no normal available, continues with high", () => {
  const high = makeEnvelope("00000000-0000-4000-8000-000000000001", { priority: "high", senderSeq: 1 });

  const selected = selectNext([high], 10);
  assert.equal(selected?.messageId, high.messageId);
});

test("selectNext returns undefined for empty candidates", () => {
  assert.equal(selectNext([], 0), undefined);
});

// --- isHighPriority ---

test("isHighPriority classifies correctly", () => {
  assert.equal(isHighPriority("critical"), true);
  assert.equal(isHighPriority("high"), true);
  assert.equal(isHighPriority("normal"), false);
});

// --- Consumer integration ---

test("consumer dispatches a ready message and transitions to applied", async () => {
  const dispatched: string[] = [];
  const consumer = new MailboxConsumer({
    store,
    router,
    recipientCorrelationId: "corr-001",
      workspaceId: "a".repeat(64),
    onDispatch: async (envelope) => { dispatched.push(envelope.messageId); },
    pollMs: 10,
    now: () => nowMs,
  });

  // Write a message to ready
  const envelope = makeEnvelope("00000000-0000-4000-8000-000000000010");
  await store.writeStaging(envelope);
  await store.promoteToReady(envelope.messageId);

  consumer.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await consumer.stop();

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0], envelope.messageId);

  // In-process dispatch success is the delivery confirmation: message is APPLIED.
  const applied = await store.readEnvelope("applied", envelope.messageId);
  assert.ok(applied);
  assert.equal(await store.readEnvelope("accepted", envelope.messageId), undefined);
});

test("consumer acknowledge transitions accepted to applied (IPC-ack path)", async () => {
  const consumer = new MailboxConsumer({
    store,
    router,
    recipientCorrelationId: "corr-001",
      workspaceId: "a".repeat(64),
    onDispatch: async () => {},
    pollMs: 10,
    now: () => nowMs,
  });

  // Place a message in accepted directly (simulating a claim+accept without a
  // completed in-process dispatch, e.g. an external IPC-ack flow).
  const envelope = makeEnvelope("00000000-0000-4000-8000-000000000011");
  await store.writeStaging(envelope);
  await store.promoteToReady(envelope.messageId);
  const claim = {
    messageId: envelope.messageId,
    claimerNonce: "external-ipc",
    claimedAt: nowMs,
    leaseExpiresAt: nowMs + 30_000,
    lastHeartbeatAt: nowMs,
  };
  assert.equal(await store.claim(envelope.messageId, claim), true);
  assert.equal(await store.accept(envelope.messageId, claim), true);

  // Acknowledge via IPC
  const acked = await consumer.acknowledge(envelope.messageId);
  assert.equal(acked, true);

  const applied = await store.readEnvelope("applied", envelope.messageId);
  assert.ok(applied);

  // Idempotent: acknowledging an already-applied message is a no-op.
  assert.equal(await consumer.acknowledge(envelope.messageId), false);
  assert.equal(await consumer.acknowledge("not-a-valid-message-id"), false);
});

test("consumer skips messages for other recipients", async () => {
  const dispatched: string[] = [];
  const consumer = new MailboxConsumer({
    store,
    router,
    recipientCorrelationId: "corr-001",
      workspaceId: "a".repeat(64),
    onDispatch: async (envelope) => { dispatched.push(envelope.messageId); },
    pollMs: 10,
    now: () => nowMs,
  });

  const other = makeEnvelope("00000000-0000-4000-8000-000000000012", { recipientCorrelationId: "corr-other" });
  await store.writeStaging(other);
  await store.promoteToReady(other.messageId);

  consumer.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await consumer.stop();

  assert.equal(dispatched.length, 0);
  // Message still in ready
  assert.ok(await store.readEnvelope("ready", other.messageId));
});

test("consumer expires messages past their TTL", async () => {
  const consumer = new MailboxConsumer({
    store,
    router,
    recipientCorrelationId: "corr-001",
      workspaceId: "a".repeat(64),
    onDispatch: async () => {},
    pollMs: 10,
    now: () => nowMs,
  });

  const expired = makeEnvelope("00000000-0000-4000-8000-000000000013", {
    expiresAt: nowMs - 1000, // already expired
  });
  await store.writeStaging(expired);
  await store.promoteToReady(expired.messageId);

  consumer.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await consumer.stop();

  assert.equal(await store.readEnvelope("ready", expired.messageId), undefined);
  assert.ok(await store.readEnvelope("expired", expired.messageId));
});

// --- Stale Claim Reclaim ---

test("stale claim is reclaimed after CLAIM_STALE_MS", async () => {
  const envelope = makeEnvelope("00000000-0000-4000-8000-000000000020");
  await store.writeStaging(envelope);
  await store.promoteToReady(envelope.messageId);

  // Simulate a stale claim
  const staleClaim = {
    messageId: envelope.messageId,
    claimerNonce: "dead-consumer",
    claimedAt: nowMs - CLAIM_STALE_MS - 5000,
    leaseExpiresAt: nowMs - 5000,
    lastHeartbeatAt: nowMs - CLAIM_STALE_MS - 1000, // heartbeat older than stale threshold
  };
  await store.claim(envelope.messageId, staleClaim);

  // Verify it's claimed
  assert.ok(await store.readEnvelope("claimed", envelope.messageId));

  // Create consumer and reclaim
  const consumer = new MailboxConsumer({
    store,
    router,
    recipientCorrelationId: "corr-001",
      workspaceId: "a".repeat(64),
    onDispatch: async () => {},
    now: () => nowMs,
  });

  const reclaimed = await consumer.reclaimStaleClaims();
  assert.deepEqual(reclaimed, [envelope.messageId]);

  // Message should be back in ready
  assert.ok(await store.readEnvelope("ready", envelope.messageId));
  assert.equal(await store.readEnvelope("claimed", envelope.messageId), undefined);
});

test("fresh claim is not reclaimed", async () => {
  const envelope = makeEnvelope("00000000-0000-4000-8000-000000000021");
  await store.writeStaging(envelope);
  await store.promoteToReady(envelope.messageId);

  const freshClaim = {
    messageId: envelope.messageId,
    claimerNonce: "active-consumer",
    claimedAt: nowMs,
    leaseExpiresAt: nowMs + 30_000,
    lastHeartbeatAt: nowMs, // fresh heartbeat
  };
  await store.claim(envelope.messageId, freshClaim);

  const consumer = new MailboxConsumer({
    store,
    router,
    recipientCorrelationId: "corr-001",
      workspaceId: "a".repeat(64),
    onDispatch: async () => {},
    now: () => nowMs,
  });

  const reclaimed = await consumer.reclaimStaleClaims();
  assert.deepEqual(reclaimed, []);
  assert.ok(await store.readEnvelope("claimed", envelope.messageId));
});

// --- Priority dispatch ordering ---

test("consumer dispatches critical before normal", async () => {
  const dispatched: string[] = [];
  const consumer = new MailboxConsumer({
    store,
    router,
    recipientCorrelationId: "corr-001",
      workspaceId: "a".repeat(64),
    onDispatch: async (envelope) => { dispatched.push(envelope.messageId); },
    pollMs: 10,
    now: () => nowMs,
  });

  const normal = makeEnvelope("00000000-0000-4000-8000-000000000030", { priority: "normal", senderSeq: 1 });
  const critical = makeEnvelope("00000000-0000-4000-8000-000000000031", { priority: "critical", senderSeq: 2, kind: "lifecycle" });

  await store.writeStaging(normal);
  await store.promoteToReady(normal.messageId);
  await store.writeStaging(critical);
  await store.promoteToReady(critical.messageId);

  consumer.start();
  // Wait for first dispatch
  await new Promise((resolve) => setTimeout(resolve, 100));
  await consumer.stop();

  // Critical should be dispatched first
  assert.ok(dispatched.length >= 1);
  assert.equal(dispatched[0], critical.messageId);
});
