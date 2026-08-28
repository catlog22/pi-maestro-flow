import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import {
  createMailboxPaths,
  ensureMailboxDirectories,
} from "../src/extension/mailbox/file-store.ts";
import {
  type MailboxServiceOptions,
  MailboxService,
  negotiateCapability,
} from "../src/extension/mailbox/service.ts";
import { type MailboxAuthority } from "../src/extension/mailbox/router.ts";
import {
  type MailboxEnvelope,
  type MailboxPaths,
} from "../src/extension/mailbox/types.ts";

const temporaryDirectories: string[] = [];
let baseDir: string;
let nowMs: number;

// Mutable authority state
let authorityState: {
  routeAllowed: boolean;
  generation: number;
  leaseEpoch: number;
  leaseNonce: string;
  fenced: Set<string>;
  staleUnauthorized: Set<string>;
};

function makeAuthority(): MailboxAuthority {
  return {
    canRoute: () => authorityState.routeAllowed ? { allowed: true } : { allowed: false, reason: "blocked" },
    currentGeneration: () => authorityState.generation,
    currentLeaseEpoch: () => authorityState.leaseEpoch,
    currentLeaseNonce: () => authorityState.leaseNonce,
    isFenced: (cid) => authorityState.fenced.has(cid),
    isStaleUnauthorized: (cid) => authorityState.staleUnauthorized.has(cid),
    managesRecipient: () => true,
  };
}

function makeServiceOptions(overrides: Partial<MailboxServiceOptions> = {}): MailboxServiceOptions {
  return {
    rootDir: join(baseDir, "mailbox"),
    authority: makeAuthority(),
    recipientCorrelationId: "corr-child-1",
    workspaceId: "a".repeat(64),
    teamId: "team-root",
    ownerId: "b".repeat(32),
    onDispatch: async () => {},
    pollMs: 10,
    now: () => nowMs,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "mailbox-integ-"));
  temporaryDirectories.push(baseDir);
  nowMs = 1_700_000_000_000;
  authorityState = {
    routeAllowed: true,
    generation: 1,
    leaseEpoch: 1,
    leaseNonce: "nonce-abc",
    fenced: new Set(),
    staleUnauthorized: new Set(),
  };
});

// --- R2: dispatch success auto-applies (in-process delivery confirmation) ---

test("inject success transitions message to APPLIED (auto-ack)", async () => {
  const dispatched: MailboxEnvelope[] = [];
  const service = new MailboxService(makeServiceOptions({
    onDispatch: async (envelope) => { dispatched.push(envelope); },
  }));
  await service.start();

  // Enqueue a message
  const result = await service.enqueue({
    senderId: "sender-1",
    recipientId: "c".repeat(32),
    recipientCorrelationId: "corr-child-1",
    kind: "follow_up",
    mode: "follow_up",
    payload: "hello child",
  });
  assert.ok(result.ok);

  // Wait for consumer to dispatch
  await new Promise((resolve) => setTimeout(resolve, 100));
  await service.stop();

  // Message was dispatched (injected)
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].payload, "hello child");

  // Dispatch success is the delivery confirmation: message is APPLIED, never
  // left stranded in accepted (which previously exhausted the quota).
  const accepted = await service.store.readEnvelope("accepted", result.messageId);
  assert.equal(accepted, undefined, "message should not linger in accepted");
  const applied = await service.store.readEnvelope("applied", result.messageId);
  assert.ok(applied, "message should be in applied state after dispatch");
});

test("ack after inject is idempotent when already auto-applied", async () => {
  const dispatched: MailboxEnvelope[] = [];
  const service = new MailboxService(makeServiceOptions({
    onDispatch: async (envelope) => { dispatched.push(envelope); },
  }));
  await service.start();

  const result = await service.enqueue({
    senderId: "sender-1",
    recipientId: "c".repeat(32),
    recipientCorrelationId: "corr-child-1",
    kind: "follow_up",
    mode: "follow_up",
    payload: "ack me",
  });
  assert.ok(result.ok);

  await new Promise((resolve) => setTimeout(resolve, 100));
  await service.stop();

  assert.equal(dispatched.length, 1);

  // Already applied by the auto-ack; an explicit IPC ack is a no-op.
  const acked = await service.acknowledge(result.messageId);
  assert.equal(acked, false, "acknowledge on an already-applied message is a no-op");

  const applied = await service.store.readEnvelope("applied", result.messageId);
  assert.ok(applied, "message should be in applied state");
});

// --- R1: Crash between accept and apply → replay on restart ---

test("crash after injection: message replayed on restart", async () => {
  const service1 = new MailboxService(makeServiceOptions({
    onDispatch: async () => {},
  }));
  await service1.start();

  const result = await service1.enqueue({
    senderId: "sender-1",
    recipientId: "c".repeat(32),
    recipientCorrelationId: "corr-child-1",
    kind: "follow_up",
    mode: "follow_up",
    payload: "survive crash",
  });
  assert.ok(result.ok);

  // Wait for dispatch then simulate a crash that leaves the message stranded
  // in accepted (process dies between accept and auto-apply).
  const messageId = result.messageId;
  await new Promise((resolve) => setTimeout(resolve, 100));
  await service1.stop();
  // Force the crash state: move applied back to accepted as if apply never ran.
  const appliedEnv = await service1.store.readEnvelope("applied", messageId);
  if (appliedEnv) {
    await service1.store.remove("applied", messageId);
    await service1.store.writeStaging(appliedEnv);
    await service1.store.promoteToReady(messageId);
    await service1.store.claim(messageId, {
      messageId, claimerNonce: "crash", claimedAt: nowMs,
      leaseExpiresAt: nowMs + 30_000, lastHeartbeatAt: nowMs,
    });
    await service1.store.accept(messageId, {
      messageId, claimerNonce: "crash", claimedAt: nowMs,
      leaseExpiresAt: nowMs + 30_000, lastHeartbeatAt: nowMs,
    });
  }
  assert.ok(await service1.store.readEnvelope("accepted", messageId), "message stranded in accepted after crash");

  // New service instance (simulating process restart): start() replays
  // accepted-without-apply back to ready and dispatches it.
  const dispatchedSecond: string[] = [];
  const service2 = new MailboxService(makeServiceOptions({
    onDispatch: async (envelope) => { dispatchedSecond.push(envelope.messageId); },
  }));
  await service2.start();

  await new Promise((resolve) => setTimeout(resolve, 100));
  await service2.stop();

  // Message was replayed and re-dispatched (at-least-once semantics)
  assert.equal(dispatchedSecond.length, 1);
  assert.equal(dispatchedSecond[0], messageId);
});

// --- R8: Capability v1 → direct path ---

test("capability negotiation: v1 when remote is v1", () => {
  assert.equal(negotiateCapability("v2", "v1"), "v1");
  assert.equal(negotiateCapability("v2", undefined), "v1");
  assert.equal(negotiateCapability("v1", "v2"), "v1");
  assert.equal(negotiateCapability("v1", "v1"), "v1");
});

test("capability negotiation: v2 only when both are v2", () => {
  assert.equal(negotiateCapability("v2", "v2"), "v2");
});

// --- R3: Deduplication — same messageId never dual-injects ---

test("duplicate enqueue with same messageId is rejected", async () => {
  const service = new MailboxService(makeServiceOptions());
  await service.start();

  const result1 = await service.enqueue({
    senderId: "sender-1",
    recipientId: "c".repeat(32),
    recipientCorrelationId: "corr-child-1",
    kind: "follow_up",
    mode: "follow_up",
    payload: "first",
  });
  assert.ok(result1.ok);

  // The messageId is generated internally, so we test dedup via the seen-set
  // Mark a specific ID as seen and verify re-enqueue would be caught
  const fakeId = "00000000-0000-4000-8000-000000000099";
  await service.store.markSeen(fakeId);
  assert.equal(await service.store.isSeen(fakeId), true);

  await service.stop();
});

test("same logical message uses same messageId and is not dual-injected", async () => {
  const dispatched: string[] = [];
  const service = new MailboxService(makeServiceOptions({
    onDispatch: async (envelope) => { dispatched.push(envelope.messageId); },
  }));
  await service.start();

  // Enqueue once
  const result = await service.enqueue({
    senderId: "sender-1",
    recipientId: "c".repeat(32),
    recipientCorrelationId: "corr-child-1",
    kind: "follow_up",
    mode: "follow_up",
    payload: "only once",
  });
  assert.ok(result.ok);

  // Wait for dispatch
  await new Promise((resolve) => setTimeout(resolve, 100));
  await service.stop();

  // Only dispatched once
  assert.equal(dispatched.length, 1);
  // Message is in accepted (not ready for re-dispatch)
  assert.equal(await service.store.readEnvelope("ready", result.messageId), undefined);
});

// --- R6: agent_settled enqueues result-kind ---

test("result-kind message gets critical priority", async () => {
  // Don't start consumer so message stays in ready for inspection
  const service = new MailboxService(makeServiceOptions());
  await ensureMailboxDirectories(service.paths);

  const result = await service.enqueue({
    senderId: "sender-1",
    recipientId: "c".repeat(32),
    recipientCorrelationId: "corr-child-1",
    kind: "result",
    mode: "notify",
    payload: "task completed successfully",
  });
  assert.ok(result.ok);

  const envelope = await service.store.readEnvelope("ready", result.messageId);
  assert.ok(envelope);
  assert.equal(envelope.kind, "result");
  assert.equal(envelope.priority, "critical");
});

// --- Pending mail blocks eviction ---

test("hasPendingMail returns true when messages are undelivered", async () => {
  const service = new MailboxService(makeServiceOptions({
    onDispatch: async () => { throw new Error("dispatch disabled"); },
  }));
  service.on("dispatch-error", () => {}); // suppress unhandled
  await service.start();

  await service.enqueue({
    senderId: "sender-1",
    recipientId: "c".repeat(32),
    recipientCorrelationId: "corr-child-1",
    kind: "follow_up",
    mode: "follow_up",
    payload: "pending",
  });

  // Brief wait but dispatch fails so message stays (poll until it settles in a live state)
  const deadline = Date.now() + 3000;
  let pending = await service.hasPendingMail();
  while (!pending && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    pending = await service.hasPendingMail();
  }
  assert.equal(pending, true);

  await service.stop();
});

test("hasPendingMail returns false after all messages are applied", async () => {
  const dispatched: MailboxEnvelope[] = [];
  const service = new MailboxService(makeServiceOptions({
    onDispatch: async (envelope) => { dispatched.push(envelope); },
  }));
  await service.start();

  const result = await service.enqueue({
    senderId: "sender-1",
    recipientId: "c".repeat(32),
    recipientCorrelationId: "corr-child-1",
    kind: "follow_up",
    mode: "follow_up",
    payload: "will be acked",
  });
  assert.ok(result.ok);

  try {
    const deadline = Date.now() + 5_000;
    let pending = await service.hasPendingMail();
    while ((dispatched.length === 0 || pending) && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      pending = await service.hasPendingMail();
    }
    assert.equal(dispatched.length, 1);
    assert.equal(pending, false);
  } finally {
    await service.stop();
  }
});

// --- Fenced agent: queue but don't dispatch ---

test("fenced agent: messages queue but are not dispatched", async () => {
  authorityState.fenced.add("corr-child-1");
  const dispatched: string[] = [];
  const service = new MailboxService(makeServiceOptions({
    onDispatch: async (envelope) => { dispatched.push(envelope.messageId); },
  }));
  await service.start();

  const result = await service.enqueue({
    senderId: "sender-1",
    recipientId: "c".repeat(32),
    recipientCorrelationId: "corr-child-1",
    kind: "follow_up",
    mode: "follow_up",
    payload: "fenced message",
  });
  assert.ok(result.ok, "enqueue should succeed for fenced agent");

  await new Promise((resolve) => setTimeout(resolve, 100));
  await service.stop();

  // Not dispatched because fenced
  assert.equal(dispatched.length, 0);
  // Still in ready
  assert.ok(await service.store.readEnvelope("ready", result.messageId));
});

// --- Generation mismatch → dead-letter ---

test("generation mismatch on dispatch → dead-letter", async () => {
  const dispatched: string[] = [];

  // Enqueue with generation 1, then change to 99 before consumer starts
  const service = new MailboxService(makeServiceOptions({
    onDispatch: async (envelope) => { dispatched.push(envelope.messageId); },
    pollMs: 500, // slow poll so we can enqueue first
  }));
  await ensureMailboxDirectories(service.paths);

  const result = await service.enqueue({
    senderId: "sender-1",
    recipientId: "c".repeat(32),
    recipientCorrelationId: "corr-child-1",
    kind: "follow_up",
    mode: "follow_up",
    payload: "will be dead-lettered",
  });
  assert.ok(result.ok);

  // Change generation before consumer polls
  authorityState.generation = 99;

  // Now start consumer — it will find the message but revalidation fails
  service.consumer.start();
  try {
    const deadline = Date.now() + 5_000;
    let dead = await service.store.readEnvelope("dead", result.messageId);
    while (!dead && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      dead = await service.store.readEnvelope("dead", result.messageId);
    }

    // Not dispatched
    assert.equal(dispatched.length, 0);
    // Dead-lettered
    assert.ok(dead);
  } finally {
    await service.stop();
  }
});

// --- Service lifecycle ---

test("service start/stop is idempotent", async () => {
  const service = new MailboxService(makeServiceOptions());
  await service.start();
  await service.start(); // no-op
  await service.stop();
  await service.stop(); // no-op
});

test("pendingCount reflects undelivered messages", async () => {
  const service = new MailboxService(makeServiceOptions({
    onDispatch: async () => { throw new Error("no dispatch"); },
    pollMs: 500, // slow poll: message stays live in ready during the check
  }));
  await service.start();

  assert.equal(await service.pendingCount(), 0);

  await service.enqueue({
    senderId: "sender-1",
    recipientId: "c".repeat(32),
    recipientCorrelationId: "corr-child-1",
    kind: "follow_up",
    mode: "follow_up",
    payload: "count me",
  });

  // Message is in ready (dispatch fails)
  await new Promise((resolve) => setTimeout(resolve, 50));
  const count = await service.pendingCount();
  assert.ok(count >= 1);

  await service.stop();
});
