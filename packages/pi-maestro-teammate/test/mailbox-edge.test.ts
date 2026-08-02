import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import {
  MailboxFileStore,
  createMailboxPaths,
  ensureMailboxDirectories,
} from "../src/extension/mailbox/file-store.ts";
import { QuotaAdmission } from "../src/extension/mailbox/gc.ts";
import {
  type MailboxConsumerOptions,
  MailboxConsumer,
  selectNext,
} from "../src/extension/mailbox/consumer.ts";
import { type MailboxAuthority, MailboxRouter } from "../src/extension/mailbox/router.ts";
import {
  type MailboxEnvelope,
  type MailboxPaths,
  CLAIM_STALE_MS,
  MAILBOX_SCHEMA_VERSION,
  MAX_PAYLOAD_BYTES,
  QUOTA_CRITICAL_RESERVE,
  QUOTA_HARD_TOTAL,
  QUOTA_NORMAL_MAX,
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
  return {
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
    hash: "dummy-hash",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "mailbox-edge-"));
  temporaryDirectories.push(base);
  paths = createMailboxPaths(join(base, "mailbox"));
  await ensureMailboxDirectories(paths);
  nowMs = 1_700_000_000_000;
  store = new MailboxFileStore({ paths, now: () => nowMs });
  quota = new QuotaAdmission({ store, hardTotal: QUOTA_HARD_TOTAL, normalMax: QUOTA_NORMAL_MAX });
  router = new MailboxRouter({ store, authority: permissiveAuthority(), quota, now: () => nowMs });
});

// ===========================================================================
// Edge 1: Concurrent claim race — two consumers, one winner per message
// ===========================================================================

test("concurrent claims: two consumers never both claim the same message", async () => {
  const envelope = makeEnvelope("00000000-0000-4000-8000-000000000001");
  await store.writeStaging(envelope);
  await store.promoteToReady(envelope.messageId);

  const dispatched: string[] = [];
  const consumerA = new MailboxConsumer({
    store, router, recipientCorrelationId: "corr-001", pollMs: 5, now: () => nowMs,
    workspaceId: "a".repeat(64),
    onDispatch: async (e) => { dispatched.push(`A:${e.messageId}`); },
  });
  const consumerB = new MailboxConsumer({
    store, router, recipientCorrelationId: "corr-001", pollMs: 5, now: () => nowMs,
    workspaceId: "a".repeat(64),
    onDispatch: async (e) => { dispatched.push(`B:${e.messageId}`); },
  });

  consumerA.start();
  consumerB.start();
  const deadline = Date.now() + 3000;
  while ((await store.listMessages("ready")).length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await consumerA.stop();
  await consumerB.stop();

  // Exactly one dispatch, no duplicates
  assert.equal(dispatched.length, 1);
  // Message should be in accepted (claimed + dispatched once)
  assert.ok(await store.readEnvelope("accepted", envelope.messageId));
});

test("concurrent claims over N messages: each claimed exactly once", async () => {
  const N = 12;
  for (let i = 0; i < N; i++) {
    const env = makeEnvelope(`00000000-0000-4000-8000-00000000${String(i + 1).padStart(4, "0")}`);
    await store.writeStaging(env);
    await store.promoteToReady(env.messageId);
  }

  const dispatched = new Set<string>();
  const makeConsumer = (nonce: string) => new MailboxConsumer({
    store, router, recipientCorrelationId: "corr-001", pollMs: 5,
    workspaceId: "a".repeat(64),
    consumerNonce: nonce, now: () => nowMs,
    onDispatch: async (e) => { dispatched.add(e.messageId); },
  });
  const consumers = [makeConsumer("a"), makeConsumer("b"), makeConsumer("c")];
  consumers.forEach((c) => c.start());
  // Wait until all messages leave ready (dispatched) or timeout.
  const deadline = Date.now() + 5000;
  while ((await store.listMessages("ready")).length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await Promise.all(consumers.map((c) => c.stop()));
  // Allow trailing async file operations to settle before assertions/cleanup.
  await new Promise((r) => setTimeout(r, 100));

  // All messages dispatched exactly once (no duplicates in the set)
  assert.equal(dispatched.size, N);
  // All left ready
  assert.equal((await store.listMessages("ready")).length, 0);
});

// ===========================================================================
// Edge 2: Crash injection — claim stranded in claimed, stale reclaim recovers
// ===========================================================================

test("crash injection: stranded claimed message is reclaimed and re-dispatched", async () => {
  const envelope = makeEnvelope("00000000-0000-4000-8000-000000000020");
  await store.writeStaging(envelope);
  await store.promoteToReady(envelope.messageId);

  // Simulate consumer crash: claim but never heartbeat (like process killed mid-claim)
  const staleClaim = {
    messageId: envelope.messageId,
    claimerNonce: "crashed-consumer",
    claimedAt: nowMs,
    leaseExpiresAt: nowMs + 30_000,
    lastHeartbeatAt: nowMs - CLAIM_STALE_MS - 1000, // heartbeat is ancient
  };
  await store.claim(envelope.messageId, staleClaim);

  // New consumer arrives and reclaims the stale claim
  const dispatched: string[] = [];
  const newConsumer = new MailboxConsumer({
    store, router, recipientCorrelationId: "corr-001", pollMs: 10, now: () => nowMs,
    workspaceId: "a".repeat(64),
    onDispatch: async (e) => { dispatched.push(e.messageId); },
  });
  newConsumer.start();
  await new Promise((r) => setTimeout(r, 150));
  await newConsumer.stop();

  assert.equal(dispatched.length, 1, "stranded message must be reclaimed and dispatched");
  assert.equal(dispatched[0], envelope.messageId);
});

test("crash injection: accepted message without ack is replayed after restart", async () => {
  const envelope = makeEnvelope("00000000-0000-4000-8000-000000000021");
  await store.writeStaging(envelope);
  await store.promoteToReady(envelope.messageId);
  const claim = {
    messageId: envelope.messageId,
    claimerNonce: "crash-2",
    claimedAt: nowMs,
    leaseExpiresAt: nowMs + 30_000,
    lastHeartbeatAt: nowMs,
  };
  await store.claim(envelope.messageId, claim);
  await store.accept(envelope.messageId, claim);

  // Simulate restart: move accepted back to ready manually (execution layer does this)
  const acceptedEnv = await store.readEnvelope("accepted", envelope.messageId);
  assert.ok(acceptedEnv);
  await store.remove("accepted", envelope.messageId);
  await store.writeStaging(acceptedEnv);
  await store.promoteToReady(envelope.messageId);

  const dispatched: string[] = [];
  const restarted = new MailboxConsumer({
    store, router, recipientCorrelationId: "corr-001", pollMs: 10, now: () => nowMs,
    workspaceId: "a".repeat(64),
    onDispatch: async (e) => { dispatched.push(e.messageId); },
  });
  restarted.start();
  await new Promise((r) => setTimeout(r, 150));
  await restarted.stop();

  assert.equal(dispatched.length, 1, "accepted-without-ack must replay after restart");
});

// ===========================================================================
// Edge 3: Priority scheduler under load — starvation bound and lane order
// ===========================================================================

test("priority scheduler: 10 critical + 10 high + 10 normal — starvation bound forces normal", () => {
  const critical = Array.from({ length: 10 }, (_, i) =>
    makeEnvelope(`00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, { priority: "critical", senderSeq: i, kind: "lifecycle" }));
  const high = Array.from({ length: 10 }, (_, i) =>
    makeEnvelope(`00000000-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`, { priority: "high", senderSeq: 100 + i, kind: "steer" }));
  const normal = Array.from({ length: 10 }, (_, i) =>
    makeEnvelope(`00000000-0000-4000-8000-0000000003${String(i).padStart(2, "0")}`, { priority: "normal", senderSeq: 200 + i, kind: "follow_up" }));

  // Simulate dispatch sequence: select → count high → repeat
  const candidates = [...critical, ...high, ...normal];
  let consecutiveHigh = 0;
  const order: string[] = [];
  const remaining = [...candidates];

  // After 8 consecutive high/critical, the 9th pick must be normal if available
  const ninthPick = selectNext(remaining, 8);
  assert.equal(ninthPick?.priority, "normal", "9th slot must be normal (starvation bound)");

  // FIFO within lane
  const laneNormal = [normal[0], normal[1], normal[2]];
  const first = selectNext(laneNormal, 0);
  assert.equal(first?.messageId, normal[0].messageId, "FIFO within lane");
});

test("priority scheduler: empty and single-priority cases", () => {
  assert.equal(selectNext([], 0), undefined);
  const single = makeEnvelope("00000000-0000-4000-8000-000000000040", { priority: "normal" });
  assert.equal(selectNext([single], 5)?.messageId, single.messageId);
});

// ===========================================================================
// Edge 4: Quota boundaries — exactly at limits
// ===========================================================================

test("quota: exactly QUOTA_NORMAL_MAX normal messages pass, next fails", async () => {
  const small = new QuotaAdmission({ store, hardTotal: 20, normalMax: 10 });
  const smallRouter = new MailboxRouter({ store, authority: permissiveAuthority(), quota: small, now: () => nowMs });

  for (let i = 0; i < 10; i++) {
    const r = await smallRouter.enqueue({
      workspaceId: "a".repeat(64), teamId: "t", senderId: "s", recipientId: "r",
      recipientCorrelationId: `corr-${i}`, kind: "follow_up", mode: "follow_up", payload: `m${i}`,
    });
    assert.ok(r.ok, `enqueue ${i} should pass`);
  }
  const overflow = await smallRouter.enqueue({
    workspaceId: "a".repeat(64), teamId: "t", senderId: "s", recipientId: "r",
    recipientCorrelationId: "corr-x", kind: "follow_up", mode: "follow_up", payload: "over",
  });
  assert.equal(overflow.ok, false);
  if (!overflow.ok) assert.equal(overflow.code, "quota_exceeded");
});

test("quota: critical still admitted when normal is full but under hard total", async () => {
  const small = new QuotaAdmission({ store, hardTotal: 12, normalMax: 8 });
  const smallRouter = new MailboxRouter({ store, authority: permissiveAuthority(), quota: small, now: () => nowMs });

  for (let i = 0; i < 8; i++) {
    const r = await smallRouter.enqueue({
      workspaceId: "a".repeat(64), teamId: "t", senderId: "s", recipientId: "r",
      recipientCorrelationId: `corr-${i}`, kind: "follow_up", mode: "follow_up", payload: `m${i}`,
    });
    assert.ok(r.ok);
  }
  // Critical passes (8 < 12 hard total)
  const critical = await smallRouter.enqueue({
    workspaceId: "a".repeat(64), teamId: "t", senderId: "s", recipientId: "r",
    recipientCorrelationId: "corr-c", kind: "lifecycle", mode: "notify", payload: "life",
  });
  assert.ok(critical.ok);
});

test("quota: hard total blocks everything including critical", async () => {
  const small = new QuotaAdmission({ store, hardTotal: 5, normalMax: 3 });
  const smallRouter = new MailboxRouter({ store, authority: permissiveAuthority(), quota: small, now: () => nowMs });

  for (let i = 0; i < 5; i++) {
    const kind = i < 3 ? "follow_up" : "lifecycle";
    const r = await smallRouter.enqueue({
      workspaceId: "a".repeat(64), teamId: "t", senderId: "s", recipientId: "r",
      recipientCorrelationId: `corr-${i}`, kind, mode: "notify", payload: `m${i}`,
    });
    assert.ok(r.ok, `enqueue ${i} should pass (${kind})`);
  }
  // 6th blocked even for critical
  const sixth = await smallRouter.enqueue({
    workspaceId: "a".repeat(64), teamId: "t", senderId: "s", recipientId: "r",
    recipientCorrelationId: "corr-x", kind: "lifecycle", mode: "notify", payload: "last",
  });
  assert.equal(sixth.ok, false);
  if (!sixth.ok) assert.equal(sixth.code, "quota_exceeded");
});

// ===========================================================================
// Edge 5: Payload size boundaries
// ===========================================================================

test("payload: exactly 64KiB passes, 64KiB+1 rejected", async () => {
  const envelope = makeEnvelope("00000000-0000-4000-8000-000000000049", {
    payload: "x".repeat(MAX_PAYLOAD_BYTES),
  });
  await store.writeStaging(envelope); // exactly at limit → passes

  const tooBig = makeEnvelope("00000000-0000-4000-8000-000000000050", {
    payload: "y".repeat(MAX_PAYLOAD_BYTES + 1),
  });
  await assert.rejects(
    () => store.writeStaging(tooBig),
    (e: Error) => e.message.includes("payload exceeds"),
  );
});

// ===========================================================================
// Edge 6: Deduplication — replay of same messageId
// ===========================================================================

test("dedup: messageId marked seen cannot be re-enqueued", async () => {
  const envelope = makeEnvelope("00000000-0000-4000-8000-000000000060");
  await store.writeStaging(envelope);
  await store.promoteToReady(envelope.messageId);

  // Mark seen as if already processed
  await store.markSeen(envelope.messageId);
  assert.equal(await store.isSeen(envelope.messageId), true);

  // Router would reject a re-enqueue with the same id (route-level check is in router)
  // Here we verify store-level dedup marker persists across "restart"
  const freshStore = new MailboxFileStore({ paths, now: () => nowMs });
  assert.equal(await freshStore.isSeen(envelope.messageId), true, "seen marker survives store recreation");
});

// ===========================================================================
// Edge 7: TTL expiry — expired message in ready is expired by consumer
// ===========================================================================

test("ttl: expired ready message transitions to expired, never dispatched", async () => {
  const envelope = makeEnvelope("00000000-0000-4000-8000-000000000070", {
    expiresAt: nowMs - 1000, // already expired
  });
  await store.writeStaging(envelope);
  await store.promoteToReady(envelope.messageId);

  const dispatched: string[] = [];
  const consumer = new MailboxConsumer({
    store, router, recipientCorrelationId: "corr-001", pollMs: 10, now: () => nowMs,
    workspaceId: "a".repeat(64),
    onDispatch: async (e) => { dispatched.push(e.messageId); },
  });
  consumer.start();
  await new Promise((r) => setTimeout(r, 120));
  await consumer.stop();

  assert.equal(dispatched.length, 0, "expired message must not dispatch");
  assert.ok(await store.readEnvelope("expired", envelope.messageId), "must transition to expired");
});

// ===========================================================================
// Edge 8: Stale unauthorized — dispatch blocked, message dead-lettered
// ===========================================================================

test("stale unauthorized recipient: message dead-lettered, not dispatched", async () => {
  const envelope = makeEnvelope("00000000-0000-4000-8000-000000000080");
  await store.writeStaging(envelope);
  await store.promoteToReady(envelope.messageId);

  // Authority says recipient is stale
  const staleAuthority: MailboxAuthority = {
    ...permissiveAuthority(),
    isStaleUnauthorized: (cid) => cid === "corr-001",
  };
  const staleRouter = new MailboxRouter({ store, authority: staleAuthority, quota, now: () => nowMs });

  const dispatched: string[] = [];
  const consumer = new MailboxConsumer({
    store, router: staleRouter, recipientCorrelationId: "corr-001", pollMs: 10, now: () => nowMs,
    workspaceId: "a".repeat(64),
    onDispatch: async (e) => { dispatched.push(e.messageId); },
  });
  consumer.start();
  await new Promise((r) => setTimeout(r, 120));
  await consumer.stop();

  assert.equal(dispatched.length, 0);
  assert.ok(await store.readEnvelope("dead", envelope.messageId), "must dead-letter");
});

// ===========================================================================
// Edge 9: Generation change mid-flight — stale dispatch rejected
// ===========================================================================

test("generation bump: messages enqueued under old generation are dead-lettered", async () => {
  const envelope = makeEnvelope("00000000-0000-4000-8000-000000000090");
  await store.writeStaging(envelope);
  await store.promoteToReady(envelope.messageId);

  // Generation changed after enqueue
  const bumped = new MailboxRouter({
    store,
    authority: { ...permissiveAuthority(), currentGeneration: () => 99 },
    quota, now: () => nowMs,
  });

  const dispatched: string[] = [];
  const consumer = new MailboxConsumer({
    store, router: bumped, recipientCorrelationId: "corr-001", pollMs: 10, now: () => nowMs,
    workspaceId: "a".repeat(64),
    onDispatch: async (e) => { dispatched.push(e.messageId); },
  });
  consumer.start();
  await new Promise((r) => setTimeout(r, 120));
  await consumer.stop();

  assert.equal(dispatched.length, 0);
  assert.ok(await store.readEnvelope("dead", envelope.messageId), "old-generation message must dead-letter");
});

// ===========================================================================
// Edge 10: Rollout shadow vs authoritative boundary
// ===========================================================================

test("rollout: authoritative delivers via consumer, shadow writes but direct-delivers", async () => {
  const { MailboxService } = await import("../src/extension/mailbox/service.ts");
  const { MailboxRollout } = await import("../src/extension/mailbox/rollout.ts");

  // Authoritative
  const svcA = new MailboxService({
    rootDir: join(baseDirFor(), "auth"), authority: permissiveAuthority(),
    recipientCorrelationId: "*", workspaceId: "a".repeat(64), teamId: "t", ownerId: "o1",
    onDispatch: async () => {}, pollMs: 10, now: () => nowMs,
  });
  await ensureMailboxDirectories(svcA.paths);
  const rollA = new MailboxRollout({
    service: svcA, config: { mode: "authoritative", advertiseV2: true },
    directDeliver: async () => { throw new Error("should not be called"); },
    now: () => nowMs,
  });
  const resA = await rollA.deliver({
    senderId: "s", recipientId: "r", recipientCorrelationId: "corr-a",
    kind: "follow_up", mode: "follow_up", payload: "auth msg",
  });
  assert.equal(resA.path, "v2");
  assert.ok(resA.result.ok);
  await svcA.stop();

  // Shadow
  const svcS = new MailboxService({
    rootDir: join(baseDirFor(), "shadow"), authority: permissiveAuthority(),
    recipientCorrelationId: "*", workspaceId: "a".repeat(64), teamId: "t", ownerId: "o2",
    onDispatch: async () => { throw new Error("shadow must not consume"); }, pollMs: 10, now: () => nowMs,
  });
  await ensureMailboxDirectories(svcS.paths);
  let directCalls = 0;
  const rollS = new MailboxRollout({
    service: svcS, config: { mode: "shadow", advertiseV2: true },
    directDeliver: async () => { directCalls++; },
    now: () => nowMs,
  });
  const resS = await rollS.deliver({
    senderId: "s", recipientId: "r", recipientCorrelationId: "corr-s",
    kind: "follow_up", mode: "follow_up", payload: "shadow msg",
  });
  assert.equal(resS.path, "shadow");
  assert.ok(resS.result.ok);
  assert.equal(directCalls, 1, "shadow must also direct-deliver");
  await svcS.stop();
});

function baseDirFor(): string {
  return temporaryDirectories[temporaryDirectories.length - 1];
}
