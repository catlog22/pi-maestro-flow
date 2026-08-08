import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { ensureMailboxDirectories } from "../src/extension/mailbox/file-store.ts";
import { type MailboxRolloutOptions, MailboxRollout } from "../src/extension/mailbox/rollout.ts";
import { MailboxService } from "../src/extension/mailbox/service.ts";
import type { MailboxAuthority } from "../src/extension/mailbox/router.ts";
import type { MailboxEnvelope } from "../src/extension/mailbox/types.ts";

const temporaryDirectories: string[] = [];
let baseDir: string;
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

function makeService(onDispatch: (e: MailboxEnvelope) => Promise<void> = async () => {}): MailboxService {
  return new MailboxService({
    rootDir: join(baseDir, "mailbox"),
    authority: permissiveAuthority(),
    recipientCorrelationId: "corr-child-1",
    workspaceId: "a".repeat(64),
    teamId: "team-root",
    ownerId: "b".repeat(32),
    onDispatch,
    pollMs: 10,
    now: () => nowMs,
  });
}

const DELIVERED_V1: string[] = [];

function makeRollout(service: MailboxService, config?: Partial<{ mode: "disabled" | "shadow" | "authoritative"; advertiseV2: boolean }>): MailboxRollout {
  return new MailboxRollout({
    service,
    config,
    directDeliver: async (req) => { DELIVERED_V1.push(req.payload); },
    now: () => nowMs,
  });
}

const BASE_REQUEST = {
  senderId: "sender-1",
  recipientId: "c".repeat(32),
  recipientCorrelationId: "corr-child-1",
  kind: "follow_up" as const,
  mode: "follow_up" as const,
  payload: "test message",
};

afterEach(async () => {
  DELIVERED_V1.length = 0;
  await Promise.all(temporaryDirectories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "mailbox-rollout-"));
  temporaryDirectories.push(baseDir);
  nowMs = 1_700_000_000_000;
});

// --- Shadow Mode ---

test("shadow mode: v2 files written, message also delivered via direct path", async () => {
  const service = makeService();
  // Don't start consumer in shadow mode — shadow only writes, doesn't consume
  await ensureMailboxDirectories(service.paths);
  const rollout = makeRollout(service, { mode: "shadow", advertiseV2: true });

  const { path, result } = await rollout.deliver(BASE_REQUEST);
  assert.equal(path, "shadow");
  assert.ok(result.ok);

  // v2 file exists in ready (not consumed)
  if (result.ok && result.messageId) {
    const envelope = await service.store.readEnvelope("ready", result.messageId);
    assert.ok(envelope, "v2 envelope should exist in ready");
  }

  // Direct path also delivered
  assert.equal(DELIVERED_V1.length, 1);
  assert.equal(DELIVERED_V1[0], "test message");
});

test("shadow mode: consumer does NOT inject from v2", async () => {
  const dispatched: string[] = [];
  const service = makeService(async (e) => { dispatched.push(e.messageId); });
  await service.start();
  const rollout = makeRollout(service, { mode: "shadow", advertiseV2: true });

  // Stop the consumer so shadow mode doesn't consume
  await service.consumer.stop();

  await rollout.deliver(BASE_REQUEST);
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Consumer did not dispatch (shadow doesn't consume)
  assert.equal(dispatched.length, 0);
  // But direct path delivered
  assert.equal(DELIVERED_V1.length, 1);

  await service.stop();
});

// --- Authoritative Mode ---

test("authoritative mode: messages delivered via v2 consumer, not direct", async () => {
  const dispatched: string[] = [];
  const service = makeService(async (e) => { dispatched.push(e.payload); });
  await service.start();
  const rollout = makeRollout(service, { mode: "authoritative", advertiseV2: true });

  const { path, result } = await rollout.deliver(BASE_REQUEST);
  assert.equal(path, "v2");
  assert.ok(result.ok);

  // Wait for consumer to dispatch
  await new Promise((resolve) => setTimeout(resolve, 100));
  await service.stop();

  // Delivered via v2
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0], "test message");
  // NOT via direct path
  assert.equal(DELIVERED_V1.length, 0);
});

// --- Disabled Mode ---

test("disabled mode: uses v1 direct path only, no v2 files", async () => {
  const service = makeService();
  await ensureMailboxDirectories(service.paths);
  const rollout = makeRollout(service, { mode: "disabled", advertiseV2: false });

  const { path } = await rollout.deliver(BASE_REQUEST);
  assert.equal(path, "v1");

  // Direct path delivered
  assert.equal(DELIVERED_V1.length, 1);

  // No v2 files
  assert.equal(await service.store.countLive(), 0);
});

// --- Rollback ---

test("rollback: switching from authoritative to disabled preserves v2 files", async () => {
  const dispatched: string[] = [];
  // Slow poll keeps the enqueued message LIVE in ready at rollback time, which
  // is the drain scenario hasV2Files() reports on (applied/dead are receipts).
  const service = new MailboxService({
    rootDir: join(baseDir, "mailbox"),
    authority: permissiveAuthority(),
    recipientCorrelationId: "corr-child-1",
    workspaceId: "a".repeat(64),
    teamId: "team-root",
    ownerId: "b".repeat(32),
    onDispatch: async (e) => { dispatched.push(e.messageId); },
    pollMs: 500,
    now: () => nowMs,
  });
  await service.start();
  const rollout = makeRollout(service, { mode: "authoritative", advertiseV2: true });

  // Enqueue via v2 — stays in ready (consumer has not polled yet)
  const { result } = await rollout.deliver(BASE_REQUEST);
  assert.ok(result.ok);
  const messageId = result.ok && result.messageId ? result.messageId : "";

  // Rollback to disabled BEFORE the consumer dispatches.
  await rollout.setMode("disabled");
  assert.equal(rollout.mode, "disabled");
  assert.equal(rollout.advertisedCapability(), "v1");

  // v2 files preserved (message still live in ready for drain)
  const hasFiles = await rollout.hasV2Files();
  assert.equal(hasFiles, true);
  assert.ok(await service.store.readEnvelope("ready", messageId));
  assert.equal(dispatched.length, 0, "downgrade must stop the consumer before it dispatches");

  // New messages go via v1
  DELIVERED_V1.length = 0;
  const { path } = await rollout.deliver({ ...BASE_REQUEST, payload: "after rollback" });
  assert.equal(path, "v1");
  assert.equal(DELIVERED_V1.length, 1);
  assert.equal(DELIVERED_V1[0], "after rollback");

  await service.stop();
});

test("rollback: switching from shadow to disabled stops v2 admission", async () => {
  const service = makeService();
  await service.start();
  const rollout = makeRollout(service, { mode: "shadow", advertiseV2: true });

  await rollout.deliver(BASE_REQUEST);
  const liveBefore = await service.store.countLive();
  assert.ok(liveBefore > 0);

  // Rollback
  await rollout.setMode("disabled");

  // New message goes v1 only
  DELIVERED_V1.length = 0;
  const { path } = await rollout.deliver({ ...BASE_REQUEST, payload: "post-rollback" });
  assert.equal(path, "v1");
  assert.equal(DELIVERED_V1.length, 1);

  // Old v2 files still exist (preserved for drain)
  const liveAfter = await service.store.countLive();
  assert.ok(liveAfter > 0);

  await service.stop();
});

// --- Disk Error ---

test("disk error in authoritative mode is surfaced, not silently falling back", async () => {
  const service = makeService();
  await service.start();
  const rollout = makeRollout(service, { mode: "authoritative", advertiseV2: true });

  // Simulate disk error by making the root directory a file (blocks mkdir)
  await rm(service.paths.rootDir, { recursive: true, force: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(service.paths.rootDir, "block");

  // Deliver should throw (disk error), not silently fall back
  await assert.rejects(
    () => rollout.deliver(BASE_REQUEST),
    (error: Error) => {
      assert.ok(error.message.length > 0);
      return true;
    },
  );

  // Direct path was NOT used
  assert.equal(DELIVERED_V1.length, 0);

  await service.stop();
});

// --- Capability Advertisement ---

test("advertisedCapability reflects mode", async () => {
  const service = makeService();
  const rollout = makeRollout(service, { mode: "disabled" });
  assert.deepEqual(rollout.config, { mode: "disabled", advertiseV2: false });
  assert.equal(rollout.advertisedCapability(), "v1");

  await rollout.setMode("shadow");
  assert.deepEqual(rollout.config, { mode: "shadow", advertiseV2: true });
  assert.equal(rollout.advertisedCapability(), "v2");

  await rollout.setMode("authoritative");
  assert.deepEqual(rollout.config, { mode: "authoritative", advertiseV2: true });
  assert.equal(rollout.advertisedCapability(), "v2");

  await rollout.setMode("disabled");
  assert.deepEqual(rollout.config, { mode: "disabled", advertiseV2: false });
  assert.equal(rollout.advertisedCapability(), "v1");
});

// --- Mixed v1/v2 Coexistence ---

test("mixed v1/v2: disabled peer uses v1, v2 peer uses mailbox", async () => {
  const dispatched: string[] = [];
  const service = makeService(async (e) => { dispatched.push(e.payload); });
  await service.start();
  const rollout = makeRollout(service, { mode: "authoritative", advertiseV2: true });

  // v2 delivery
  await rollout.deliver(BASE_REQUEST);
  await new Promise((resolve) => setTimeout(resolve, 100));

  // v1 delivery (simulating a v1 peer interaction)
  DELIVERED_V1.length = 0;
  await rollout.setMode("disabled");
  await rollout.deliver({ ...BASE_REQUEST, payload: "v1 message" });
  assert.equal(DELIVERED_V1[0], "v1 message");

  // Switch back to authoritative and deliver
  await rollout.setMode("authoritative");
  await rollout.deliver({ ...BASE_REQUEST, payload: "v2 message" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await service.stop();

  // v2 messages delivered via consumer
  assert.ok(dispatched.includes("test message"), "first v2 message should be dispatched");
  assert.ok(dispatched.includes("v2 message"), "second v2 message should be dispatched");
  // v1 message was NOT in v2
  assert.ok(!dispatched.includes("v1 message"), "v1 message should not be in v2 dispatches");
});
