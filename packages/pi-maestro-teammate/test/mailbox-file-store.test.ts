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
  verifyEnvelopeHash,
} from "../src/extension/mailbox/file-store.ts";
import {
  type MailboxClaim,
  type MailboxEnvelope,
  type MailboxPaths,
  MAILBOX_SCHEMA_VERSION,
  MAX_ENVELOPE_BYTES,
  MAX_PAYLOAD_BYTES,
  TTL_NORMAL_MS,
} from "../src/extension/mailbox/types.ts";

const temporaryDirectories: string[] = [];
let paths: MailboxPaths;
let store: MailboxFileStore;
let nowMs: number;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "mailbox-fs-"));
  temporaryDirectories.push(base);
  paths = createMailboxPaths(join(base, "mailbox"));
  await ensureMailboxDirectories(paths);
  nowMs = 1_700_000_000_000;
  store = new MailboxFileStore({ paths, now: () => nowMs });
});

function makeEnvelope(overrides: Partial<MailboxEnvelope> = {}): MailboxEnvelope {
  const base: Omit<MailboxEnvelope, "hash"> = {
    messageId: "00000000-0000-4000-8000-000000000001",
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
    payload: "hello world",
    ...overrides,
  };
  // Remove hash from overrides if present to recompute
  const { hash: _hash, ...rest } = base as MailboxEnvelope;
  const hash = computeEnvelopeHash(rest as Omit<MailboxEnvelope, "hash">);
  return { ...rest, hash } as MailboxEnvelope;
}

function makeClaim(messageId: string): MailboxClaim {
  return {
    messageId,
    claimerNonce: "claimer-nonce-1",
    claimedAt: nowMs,
    leaseExpiresAt: nowMs + 30_000,
    lastHeartbeatAt: nowMs,
  };
}

// --- Full Lifecycle ---

test("full lifecycle: staging → ready → claimed → accepted → applied", async () => {
  const envelope = makeEnvelope();
  const id = envelope.messageId;

  await store.writeStaging(envelope);
  const staging = await store.readEnvelope("staging", id);
  assert.ok(staging);
  assert.equal(staging.messageId, id);
  assert.equal(staging.payload, "hello world");

  assert.equal(await store.promoteToReady(id), true);
  assert.equal(await store.readEnvelope("staging", id), undefined);
  const ready = await store.readEnvelope("ready", id);
  assert.ok(ready);

  const claim = makeClaim(id);
  assert.equal(await store.claim(id, claim), true);
  assert.equal(await store.readEnvelope("ready", id), undefined);
  const claimed = await store.readEnvelope("claimed", id);
  assert.ok(claimed);

  assert.equal(await store.accept(id, claim), true);
  assert.equal(await store.readEnvelope("claimed", id), undefined);
  const accepted = await store.readEnvelope("accepted", id);
  assert.ok(accepted);

  assert.equal(await store.apply(id), true);
  assert.equal(await store.readEnvelope("accepted", id), undefined);
  const applied = await store.readEnvelope("applied", id);
  assert.ok(applied);
  assert.equal(applied.messageId, id);
});

// --- Terminal Transitions ---

test("reject from ready state", async () => {
  const envelope = makeEnvelope();
  const id = envelope.messageId;
  await store.writeStaging(envelope);
  await store.promoteToReady(id);

  assert.equal(await store.reject(id, "ready", "generation mismatch"), true);
  assert.equal(await store.readEnvelope("ready", id), undefined);
  const rejected = await store.readEnvelope("rejected", id);
  assert.ok(rejected);

  const record = await store.readStateRecord("rejected", id);
  assert.ok(record);
  assert.equal(record.state, "rejected");
  assert.equal(record.reason, "generation mismatch");
  assert.equal(record.previousState, "ready");
});

test("reject from claimed state", async () => {
  const envelope = makeEnvelope();
  const id = envelope.messageId;
  await store.writeStaging(envelope);
  await store.promoteToReady(id);
  await store.claim(id, makeClaim(id));

  assert.equal(await store.reject(id, "claimed", "lease invalid"), true);
  assert.equal(await store.readEnvelope("claimed", id), undefined);
  const rejected = await store.readEnvelope("rejected", id);
  assert.ok(rejected);
});

test("expire from ready state", async () => {
  const envelope = makeEnvelope();
  const id = envelope.messageId;
  await store.writeStaging(envelope);
  await store.promoteToReady(id);

  assert.equal(await store.expire(id), true);
  assert.equal(await store.readEnvelope("ready", id), undefined);
  const expired = await store.readEnvelope("expired", id);
  assert.ok(expired);
});

test("dead from ready state", async () => {
  const envelope = makeEnvelope();
  const id = envelope.messageId;
  await store.writeStaging(envelope);
  await store.promoteToReady(id);

  assert.equal(await store.dead(id, "ready", "unauthorized stale"), true);
  assert.equal(await store.readEnvelope("ready", id), undefined);
  const dead = await store.readEnvelope("dead", id);
  assert.ok(dead);

  const record = await store.readStateRecord("dead", id);
  assert.ok(record);
  assert.equal(record.reason, "unauthorized stale");
});

test("dead from claimed state", async () => {
  const envelope = makeEnvelope();
  const id = envelope.messageId;
  await store.writeStaging(envelope);
  await store.promoteToReady(id);
  await store.claim(id, makeClaim(id));

  assert.equal(await store.dead(id, "claimed", "fenced"), true);
  assert.equal(await store.readEnvelope("claimed", id), undefined);
  assert.ok(await store.readEnvelope("dead", id));
});

// --- Failed Transitions ---

test("transition returns false when source does not exist", async () => {
  const id = "00000000-0000-4000-8000-000000000099";
  assert.equal(await store.promoteToReady(id), false);
  assert.equal(await store.claim(id, makeClaim(id)), false);
  assert.equal(await store.accept(id, makeClaim(id)), false);
  assert.equal(await store.apply(id), false);
  assert.equal(await store.reject(id, "ready", "nope"), false);
  assert.equal(await store.expire(id), false);
  assert.equal(await store.dead(id, "ready", "nope"), false);
});

test("claim is atomic — second claim fails", async () => {
  const envelope = makeEnvelope();
  const id = envelope.messageId;
  await store.writeStaging(envelope);
  await store.promoteToReady(id);

  assert.equal(await store.claim(id, makeClaim(id)), true);
  // Second claim from ready fails because file already moved to claimed.
  assert.equal(await store.claim(id, makeClaim(id)), false);
});

// --- Size Limits ---

test("payload exceeding 64KiB is rejected", async () => {
  const envelope = makeEnvelope({ payload: "x".repeat(MAX_PAYLOAD_BYTES + 1) });
  await assert.rejects(
    () => store.writeStaging(envelope),
    (error: Error) => error.message.includes("payload exceeds"),
  );
});

test("envelope exceeding 96KiB is rejected", async () => {
  // Create a payload that keeps payload under 64KiB but total envelope over 96KiB
  const largePayload = "y".repeat(MAX_PAYLOAD_BYTES - 100);
  const envelope = makeEnvelope({
    payload: largePayload,
    correlationId: "z".repeat(MAX_ENVELOPE_BYTES), // push total over limit
  });
  await assert.rejects(
    () => store.writeStaging(envelope),
    (error: Error) => error.message.includes("exceeds"),
  );
});

test("invalid messageId format is rejected", async () => {
  const envelope = makeEnvelope({ messageId: "not-a-uuid" });
  await assert.rejects(
    () => store.writeStaging(envelope),
    (error: Error) => error.message.includes("invalid messageId"),
  );
});

// --- Hash Verification ---

test("computeEnvelopeHash is deterministic", () => {
  const envelope = makeEnvelope();
  const { hash, ...rest } = envelope;
  assert.equal(computeEnvelopeHash(rest), hash);
  assert.equal(computeEnvelopeHash(rest), computeEnvelopeHash(rest));
});

test("verifyEnvelopeHash detects tampering", () => {
  const envelope = makeEnvelope();
  assert.equal(verifyEnvelopeHash(envelope), true);
  const tampered = { ...envelope, payload: "tampered" };
  assert.equal(verifyEnvelopeHash(tampered), false);
});

// --- Deduplication ---

test("isSeen returns false for unknown, true after markSeen", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  assert.equal(await store.isSeen(id), false);
  await store.markSeen(id);
  assert.equal(await store.isSeen(id), true);
});

test("markSeen is idempotent", async () => {
  const id = "00000000-0000-4000-8000-000000000002";
  await store.markSeen(id);
  await store.markSeen(id);
  assert.equal(await store.isSeen(id), true);
});

test("tryMarkSeen claims exclusively and rejects a concurrent claim", async () => {
  const key = "dedup-task-001";
  assert.equal(await store.tryMarkSeen(key), true);
  assert.equal(await store.isSeen(key), true);
  assert.equal(await store.tryMarkSeen(key), false, "second claim must lose");
  await store.unmarkSeen(key);
  assert.equal(await store.isSeen(key), false);
  assert.equal(await store.tryMarkSeen(key), true, "released key can be claimed again");
});

// --- Listing and Counting ---

test("listMessages returns sorted IDs excluding state records and tmp files", async () => {
  const e1 = makeEnvelope({ messageId: "00000000-0000-4000-8000-000000000003" });
  const e2 = makeEnvelope({ messageId: "00000000-0000-4000-8000-000000000001" });
  await store.writeStaging(e1);
  await store.writeStaging(e2);

  const ids = await store.listMessages("staging");
  assert.deepEqual(ids, [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000003",
  ]);
});

test("countLive sums staging + ready + claimed + accepted", async () => {
  const e1 = makeEnvelope({ messageId: "00000000-0000-4000-8000-000000000010" });
  const e2 = makeEnvelope({ messageId: "00000000-0000-4000-8000-000000000011" });
  const e3 = makeEnvelope({ messageId: "00000000-0000-4000-8000-000000000012" });

  await store.writeStaging(e1); // staging
  await store.writeStaging(e2);
  await store.promoteToReady(e2.messageId); // ready
  await store.writeStaging(e3);
  await store.promoteToReady(e3.messageId);
  await store.claim(e3.messageId, makeClaim(e3.messageId)); // claimed

  assert.equal(await store.countLive(), 3);
});

// --- State Records ---

test("state record tracks transition history", async () => {
  const envelope = makeEnvelope();
  const id = envelope.messageId;
  await store.writeStaging(envelope);
  await store.promoteToReady(id);

  const record = await store.readStateRecord("ready", id);
  assert.ok(record);
  assert.equal(record.messageId, id);
  assert.equal(record.state, "ready");
  assert.equal(record.previousState, "staging");
  assert.equal(record.transitionedAt, nowMs);
});

test("claim state record includes claim metadata", async () => {
  const envelope = makeEnvelope();
  const id = envelope.messageId;
  const claim = makeClaim(id);
  await store.writeStaging(envelope);
  await store.promoteToReady(id);
  await store.claim(id, claim);

  const record = await store.readStateRecord("claimed", id);
  assert.ok(record);
  assert.ok(record.claim);
  assert.equal(record.claim.claimerNonce, "claimer-nonce-1");
  assert.equal(record.claim.leaseExpiresAt, nowMs + 30_000);
});

// --- Renew Claim ---

test("renewClaim updates heartbeat and lease", async () => {
  const envelope = makeEnvelope();
  const id = envelope.messageId;
  const claim = makeClaim(id);
  await store.writeStaging(envelope);
  await store.promoteToReady(id);
  await store.claim(id, claim);

  nowMs += 5_000;
  const renewed: MailboxClaim = {
    ...claim,
    lastHeartbeatAt: nowMs,
    leaseExpiresAt: nowMs + 30_000,
  };
  await store.renewClaim(id, renewed);

  const record = await store.readStateRecord("claimed", id);
  assert.ok(record);
  assert.ok(record.claim);
  assert.equal(record.claim.lastHeartbeatAt, nowMs);
  assert.equal(record.claim.leaseExpiresAt, nowMs + 30_000);
});

// --- Remove ---

test("remove deletes envelope and state record", async () => {
  const envelope = makeEnvelope();
  const id = envelope.messageId;
  await store.writeStaging(envelope);
  await store.promoteToReady(id);

  await store.remove("ready", id);
  assert.equal(await store.readEnvelope("ready", id), undefined);
  assert.equal(await store.readStateRecord("ready", id), undefined);
});

// --- Overwrite resilience ---

test("writeJsonAtomic overwrites an existing state record (rename over existing)", async () => {
  const envelope = makeEnvelope({ messageId: "00000000-0000-4000-8000-000000000030" });
  await store.writeStaging(envelope);
  await store.promoteToReady(envelope.messageId);

  // Simulate a duplicate claim record write to the same path (overwrite)
  const claim1 = makeClaim(envelope.messageId);
  await store.claim(envelope.messageId, claim1);
  const claim2 = { ...claim1, lastHeartbeatAt: nowMs + 5_000 };
  await store.renewClaim(envelope.messageId, claim2);

  // Renew writes the same claimed state record path; both writes must succeed
  const record = await store.readStateRecord("claimed", envelope.messageId);
  assert.ok(record);
  assert.ok(record.claim);
  assert.equal(record.claim.lastHeartbeatAt, nowMs + 5_000);
});
