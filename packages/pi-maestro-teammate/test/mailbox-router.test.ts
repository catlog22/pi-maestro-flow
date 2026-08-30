import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  type MailboxAuthority,
  type MailboxEnqueueRequest,
  MailboxRouter,
} from "../src/extension/mailbox/router.ts";
import {
  type MailboxPaths,
  QUOTA_NORMAL_MAX,
} from "../src/extension/mailbox/types.ts";

const temporaryDirectories: string[] = [];
let paths: MailboxPaths;
let store: MailboxFileStore;
let quota: QuotaAdmission;
let nowMs: number;

// Mutable authority state for tests
let authorityState: {
  routeAllowed: boolean;
  routeReason?: string;
  generation: number;
  leaseEpoch: number;
  leaseNonce: string;
  fenced: Set<string>;
  staleUnauthorized: Set<string>;
};

function makeAuthority(): MailboxAuthority {
  return {
    canRoute: (_sender, recipientCid, _mode) => {
      if (!authorityState.routeAllowed) return { allowed: false, reason: authorityState.routeReason };
      return { allowed: true };
    },
    currentGeneration: () => authorityState.generation,
    currentLeaseEpoch: () => authorityState.leaseEpoch,
    currentLeaseNonce: () => authorityState.leaseNonce,
    isFenced: (cid) => authorityState.fenced.has(cid),
    isStaleUnauthorized: (cid) => authorityState.staleUnauthorized.has(cid),
    managesRecipient: () => true,
  };
}

function makeRequest(overrides: Partial<MailboxEnqueueRequest> = {}): MailboxEnqueueRequest {
  return {
    workspaceId: "a".repeat(64),
    teamId: "team-root",
    senderId: "b".repeat(32),
    recipientId: "c".repeat(32),
    recipientCorrelationId: "corr-001",
    kind: "follow_up",
    mode: "follow_up",
    payload: "test message",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "mailbox-router-"));
  temporaryDirectories.push(base);
  paths = createMailboxPaths(join(base, "mailbox"));
  await ensureMailboxDirectories(paths);
  nowMs = 1_700_000_000_000;
  store = new MailboxFileStore({ paths, now: () => nowMs });
  quota = new QuotaAdmission({ store });
  authorityState = {
    routeAllowed: true,
    generation: 1,
    leaseEpoch: 1,
    leaseNonce: "nonce-abc",
    fenced: new Set(),
    staleUnauthorized: new Set(),
  };
});

function makeRouter(): MailboxRouter {
  return new MailboxRouter({
    store,
    authority: makeAuthority(),
    quota,
    now: () => nowMs,
  });
}

// --- Successful Enqueue ---

test("valid route succeeds and message reaches ready state", async () => {
  const router = makeRouter();
  const result = await router.enqueue(makeRequest());
  assert.ok(result.ok);
  assert.equal(result.state, "ready");

  const envelope = await store.readEnvelope("ready", result.messageId);
  assert.ok(envelope);
  assert.equal(envelope.payload, "test message");
  assert.equal(envelope.kind, "follow_up");
  assert.deepEqual(envelope.capabilities, ["follow_up"]);
  assert.equal(envelope.priority, "normal");
  assert.equal(envelope.sessionGeneration, 1);
  assert.equal(envelope.leaseEpoch, 1);
  assert.equal(envelope.leaseNonce, "nonce-abc");
});

test("caller messageId and capability decision are frozen before async admission", async () => {
  const router = makeRouter();
  const messageId = "11111111-1111-4111-8111-111111111111";
  const capabilities = ["message", "follow_up"];
  const mutable = makeRequest({ messageId, capabilities });
  const pending = router.enqueue(mutable);

  mutable.messageId = "22222222-2222-4222-8222-222222222222";
  mutable.mode = "abort";
  mutable.payload = "mutated after enqueue";
  mutable.capabilities = ["abort"];
  capabilities.push("abort");

  const result = await pending;
  assert.ok(result.ok);
  assert.equal(result.messageId, messageId);
  const envelope = await store.readEnvelope("ready", messageId);
  assert.ok(envelope);
  assert.equal(envelope.mode, "follow_up");
  assert.equal(envelope.payload, "test message");
  assert.deepEqual(envelope.capabilities, ["message", "follow_up"]);
});

test("lifecycle kind gets critical priority", async () => {
  const router = makeRouter();
  const result = await router.enqueue(makeRequest({ kind: "lifecycle", mode: "notify" }));
  assert.ok(result.ok);
  const envelope = await store.readEnvelope("ready", result.messageId);
  assert.ok(envelope);
  assert.equal(envelope.priority, "critical");
});

test("steer kind gets high priority and short TTL", async () => {
  const router = makeRouter();
  const result = await router.enqueue(makeRequest({ kind: "steer", mode: "steer" }));
  assert.ok(result.ok);
  const envelope = await store.readEnvelope("ready", result.messageId);
  assert.ok(envelope);
  assert.equal(envelope.priority, "high");
  assert.equal(envelope.ttlMs, 10 * 60_000);
});

// --- Route Validation ---

test("invalid route returns route_invalid", async () => {
  authorityState.routeAllowed = false;
  authorityState.routeReason = "different dispatch tree";
  const router = makeRouter();
  const result = await router.enqueue(makeRequest());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "route_invalid");
    assert.ok(result.message.includes("different dispatch tree"));
  }
});

// --- Generation Mismatch ---

test("revalidate detects generation mismatch and returns dead action", async () => {
  const router = makeRouter();
  const result = await router.enqueue(makeRequest());
  assert.ok(result.ok);
  const envelope = await store.readEnvelope("ready", result.messageId);
  assert.ok(envelope);

  // Change generation
  authorityState.generation = 2;
  const validation = await router.revalidateForDispatch(envelope);
  assert.equal(validation.allowed, false);
  assert.equal(validation.action, "dead");
  assert.ok(validation.reason?.includes("generation mismatch"));
});

// --- Lease Mismatch ---

test("revalidate detects lease epoch mismatch", async () => {
  const router = makeRouter();
  const result = await router.enqueue(makeRequest());
  assert.ok(result.ok);
  const envelope = await store.readEnvelope("ready", result.messageId);
  assert.ok(envelope);

  authorityState.leaseEpoch = 99;
  const validation = await router.revalidateForDispatch(envelope);
  assert.equal(validation.allowed, false);
  assert.equal(validation.action, "dead");
  assert.ok(validation.reason?.includes("lease"));
});

test("revalidate detects lease nonce mismatch", async () => {
  const router = makeRouter();
  const result = await router.enqueue(makeRequest());
  assert.ok(result.ok);
  const envelope = await store.readEnvelope("ready", result.messageId);
  assert.ok(envelope);

  authorityState.leaseNonce = "different-nonce";
  const validation = await router.revalidateForDispatch(envelope);
  assert.equal(validation.allowed, false);
  assert.equal(validation.action, "dead");
});

// --- Fenced Agent ---

test("fenced agent: enqueue succeeds but dispatch is blocked with hold", async () => {
  const router = makeRouter();
  const result = await router.enqueue(makeRequest());
  assert.ok(result.ok);
  const envelope = await store.readEnvelope("ready", result.messageId);
  assert.ok(envelope);

  // Fence the recipient
  authorityState.fenced.add("corr-001");
  const validation = await router.revalidateForDispatch(envelope);
  assert.equal(validation.allowed, false);
  assert.equal(validation.action, "hold");
  assert.ok(validation.reason?.includes("fenced"));
});

// --- Stale Unauthorized ---

test("stale unauthorized recipient returns dead action", async () => {
  const router = makeRouter();
  const result = await router.enqueue(makeRequest());
  assert.ok(result.ok);
  const envelope = await store.readEnvelope("ready", result.messageId);
  assert.ok(envelope);

  authorityState.staleUnauthorized.add("corr-001");
  const validation = await router.revalidateForDispatch(envelope);
  assert.equal(validation.allowed, false);
  assert.equal(validation.action, "dead");
  assert.ok(validation.reason?.includes("stale"));
});

// --- Quota ---

test("fill normal quota then next normal is rejected", async () => {
  // Use small quota for fast testing
  const smallQuota = new QuotaAdmission({ store, hardTotal: 8, normalMax: 4 });
  const router = new MailboxRouter({
    store,
    authority: makeAuthority(),
    quota: smallQuota,
    now: () => nowMs,
  });

  // Enqueue normalMax messages
  for (let i = 0; i < 4; i++) {
    const result = await router.enqueue(makeRequest({ kind: "follow_up" }));
    assert.ok(result.ok, `enqueue ${i} failed: ${!result.ok ? result.message : ""}`);
  }

  // Next normal should fail
  const overflow = await router.enqueue(makeRequest({ kind: "follow_up" }));
  assert.equal(overflow.ok, false);
  if (!overflow.ok) {
    assert.equal(overflow.code, "quota_exceeded");
  }
});

test("critical messages still admitted after normal quota is full", async () => {
  const smallQuota = new QuotaAdmission({ store, hardTotal: 8, normalMax: 4 });
  const router = new MailboxRouter({
    store,
    authority: makeAuthority(),
    quota: smallQuota,
    now: () => nowMs,
  });

  // Fill normal quota
  for (let i = 0; i < 4; i++) {
    const result = await router.enqueue(makeRequest({ kind: "follow_up" }));
    assert.ok(result.ok);
  }

  // Critical should still work (within hardTotal)
  const critical = await router.enqueue(makeRequest({ kind: "lifecycle", mode: "notify" }));
  assert.ok(critical.ok);
});

// --- Payload Size ---

test("oversized payload returns payload_too_large", async () => {
  const router = makeRouter();
  const result = await router.enqueue(makeRequest({ payload: "x".repeat(65 * 1024) }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "payload_too_large");
  }
});

// --- Dispatch Validation Success ---

test("revalidate passes for valid envelope with matching authority", async () => {
  const router = makeRouter();
  const result = await router.enqueue(makeRequest());
  assert.ok(result.ok);
  const envelope = await store.readEnvelope("ready", result.messageId);
  assert.ok(envelope);

  const validation = await router.revalidateForDispatch(envelope);
  assert.equal(validation.allowed, true);
  assert.equal(validation.action, "dispatch");
});

// --- Sender Sequence ---

test("senderSeq increments monotonically", async () => {
  const router = makeRouter();
  const r1 = await router.enqueue(makeRequest());
  const r2 = await router.enqueue(makeRequest());
  assert.ok(r1.ok);
  assert.ok(r2.ok);

  const e1 = await store.readEnvelope("ready", r1.messageId);
  const e2 = await store.readEnvelope("ready", r2.messageId);
  assert.ok(e1);
  assert.ok(e2);
  assert.ok(e2.senderSeq > e1.senderSeq);
});

test("duplicate requestId is rejected before a second ready entry is written", async () => {
  const router = makeRouter();
  const messageId = "33333333-3333-4333-8333-333333333333";
  const first = await router.enqueue(makeRequest({ messageId, requestId: "task-dedup-1" }));
  assert.ok(first.ok);
  assert.equal(first.messageId, messageId);
  const second = await router.enqueue(makeRequest({ messageId, requestId: "task-dedup-1", payload: "retry" }));
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.code, "duplicate");
    assert.equal(second.messageId, messageId);
  }
  assert.equal((await store.listMessages("ready")).length, 1);
});
