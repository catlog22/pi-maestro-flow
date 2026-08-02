import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { createMailboxPaths, ensureMailboxDirectories } from "../src/extension/mailbox/file-store.ts";
import { QuotaAdmission } from "../src/extension/mailbox/gc.ts";
import { MailboxConsumer } from "../src/extension/mailbox/consumer.ts";
import { MailboxService } from "../src/extension/mailbox/service.ts";
import { type MailboxAuthority, MailboxRouter } from "../src/extension/mailbox/router.ts";
import {
  type MailboxEnvelope,
  type MailboxPaths,
  MAILBOX_SCHEMA_VERSION,
  TTL_NORMAL_MS,
} from "../src/extension/mailbox/types.ts";

const temporaryDirectories: string[] = [];
let baseDir: string;
let nowMs: number;

const WS_A = "a".repeat(64);
const WS_B = "b".repeat(64);

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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "mailbox-ws-"));
  temporaryDirectories.push(baseDir);
  nowMs = 1_700_000_000_000;
});

// ===========================================================================
// Workspace isolation: directory separation
// ===========================================================================

test("workspaces get separate directory trees", async () => {
  const svcA = new MailboxService({
    rootDir: join(baseDir, "root"), authority: permissiveAuthority(),
    recipientCorrelationId: "*", workspaceId: WS_A, teamId: "t", ownerId: "oA",
    onDispatch: async () => {}, now: () => nowMs,
  });
  const svcB = new MailboxService({
    rootDir: join(baseDir, "root"), authority: permissiveAuthority(),
    recipientCorrelationId: "*", workspaceId: WS_B, teamId: "t", ownerId: "oB",
    onDispatch: async () => {}, now: () => nowMs,
  });

  // Same rootDir, different workspaceId → different paths
  assert.notEqual(svcA.paths.rootDir, svcB.paths.rootDir);
  assert.ok(svcA.paths.rootDir.endsWith(WS_A), "svcA paths end with workspace A");
  assert.ok(svcB.paths.rootDir.endsWith(WS_B), "svcB paths end with workspace B");
  assert.ok(svcA.paths.rootDir.includes(join("workspaces", WS_A)), "nested under workspaces/");

  await svcA.stop();
  await svcB.stop();
});

test("enqueue in workspace A does not create files in workspace B tree", async () => {
  const svcA = new MailboxService({
    rootDir: join(baseDir, "root"), authority: permissiveAuthority(),
    recipientCorrelationId: "*", workspaceId: WS_A, teamId: "t", ownerId: "oA",
    onDispatch: async () => {}, now: () => nowMs,
  });
  await ensureMailboxDirectories(svcA.paths);
  const svcB = new MailboxService({
    rootDir: join(baseDir, "root"), authority: permissiveAuthority(),
    recipientCorrelationId: "*", workspaceId: WS_B, teamId: "t", ownerId: "oB",
    onDispatch: async () => {}, now: () => nowMs,
  });
  await ensureMailboxDirectories(svcB.paths);

  const result = await svcA.enqueue({
    senderId: "s", recipientId: "r", recipientCorrelationId: "corr-1",
    kind: "follow_up", mode: "follow_up", payload: "for A",
  });
  assert.ok(result.ok);

  // Workspace B's ready directory has nothing
  const bReady = await svcB.store.listMessages("ready");
  assert.deepEqual(bReady, [], "workspace B must not see workspace A's message");
  // Workspace A has the message
  const aReady = await svcA.store.listMessages("ready");
  assert.equal(aReady.length, 1);

  await svcA.stop();
  await svcB.stop();
});

// ===========================================================================
// Consumer isolation: a consumer for workspace A never dispatches B's messages
// ===========================================================================

test("consumer workspace filter: B's message is invisible to A's consumer", async () => {
  const paths = createMailboxPaths(join(baseDir, "root", "workspaces", WS_A));
  await ensureMailboxDirectories(paths);
  const { MailboxFileStore } = await import("../src/extension/mailbox/file-store.ts");
  const store = new MailboxFileStore({ paths, now: () => nowMs });
  const quota = new QuotaAdmission({ store });
  const router = new MailboxRouter({ store, authority: permissiveAuthority(), quota, workspaceId: WS_A, now: () => nowMs });

  // Manually place a message for workspace B into A's ready dir (simulating cross-tree leak)
  const leaked = makeEnvelope("00000000-0000-4000-8000-0000000000aa", { workspaceId: WS_B });
  await store.writeStaging(leaked);
  await store.promoteToReady(leaked.messageId);

  const dispatched: string[] = [];
  const consumer = new MailboxConsumer({
    store, router, recipientCorrelationId: "*", workspaceId: WS_A, pollMs: 10, now: () => nowMs,
    onDispatch: async (e) => { dispatched.push(e.messageId); },
  });
  consumer.start();
  await new Promise((r) => setTimeout(r, 120));
  await consumer.stop();

  assert.equal(dispatched.length, 0, "consumer for A must not dispatch B's message");
});

// ===========================================================================
// Router isolation: cross-workspace enqueue rejected
// ===========================================================================

test("router rejects enqueue from another workspace", async () => {
  const svcA = new MailboxService({
    rootDir: join(baseDir, "root"), authority: permissiveAuthority(),
    recipientCorrelationId: "*", workspaceId: WS_A, teamId: "t", ownerId: "oA",
    onDispatch: async () => {}, now: () => nowMs,
  });
  await ensureMailboxDirectories(svcA.paths);

  // Attempt to enqueue with wrong workspaceId directly via router
  const cross = await svcA.router.enqueue({
    workspaceId: WS_B,
    teamId: "t",
    senderId: "s", recipientId: "r", recipientCorrelationId: "corr-x",
    kind: "follow_up", mode: "follow_up", payload: "cross",
  });
  assert.equal(cross.ok, false);
  if (!cross.ok) assert.equal(cross.code, "route_invalid");

  await svcA.stop();
});

// ===========================================================================
// End-to-end: two workspaces operate independently
// ===========================================================================

test("two workspaces deliver messages independently", async () => {
  const deliveredA: string[] = [];
  const deliveredB: string[] = [];
  const svcA = new MailboxService({
    rootDir: join(baseDir, "root"), authority: permissiveAuthority(),
    recipientCorrelationId: "*", workspaceId: WS_A, teamId: "t", ownerId: "oA",
    onDispatch: async (e) => { deliveredA.push(e.payload); }, pollMs: 10, now: () => nowMs,
  });
  const svcB = new MailboxService({
    rootDir: join(baseDir, "root"), authority: permissiveAuthority(),
    recipientCorrelationId: "*", workspaceId: WS_B, teamId: "t", ownerId: "oB",
    onDispatch: async (e) => { deliveredB.push(e.payload); }, pollMs: 10, now: () => nowMs,
  });
  await svcA.start();
  await svcB.start();

  await svcA.enqueue({ senderId: "s", recipientId: "r", recipientCorrelationId: "c1", kind: "follow_up", mode: "follow_up", payload: "A-msg-1" });
  await svcB.enqueue({ senderId: "s", recipientId: "r", recipientCorrelationId: "c2", kind: "follow_up", mode: "follow_up", payload: "B-msg-1" });
  await svcA.enqueue({ senderId: "s", recipientId: "r", recipientCorrelationId: "c3", kind: "follow_up", mode: "follow_up", payload: "A-msg-2" });

  await new Promise((r) => setTimeout(r, 300));
  await svcA.stop();
  await svcB.stop();

  assert.deepEqual(deliveredA.sort(), ["A-msg-1", "A-msg-2"], "workspace A delivered its own messages");
  assert.deepEqual(deliveredB.sort(), ["B-msg-1"], "workspace B delivered its own messages only");
});

// ===========================================================================
// Claim locks are per-workspace
// ===========================================================================

test("claim locks live inside the workspace tree", async () => {
  const svcA = new MailboxService({
    rootDir: join(baseDir, "root"), authority: permissiveAuthority(),
    recipientCorrelationId: "*", workspaceId: WS_A, teamId: "t", ownerId: "oA",
    onDispatch: async () => {}, now: () => nowMs,
  });
  await ensureMailboxDirectories(svcA.paths);
  const quota = new QuotaAdmission({ store: svcA.store });
  const router = new MailboxRouter({ store: svcA.store, authority: permissiveAuthority(), quota, workspaceId: WS_A, now: () => nowMs });

  const env = makeEnvelope("00000000-0000-4000-8000-0000000000bb", { workspaceId: WS_A });
  await svcA.store.writeStaging(env);
  await svcA.store.promoteToReady(env.messageId);
  const claim = { messageId: env.messageId, claimerNonce: "n1", claimedAt: nowMs, leaseExpiresAt: nowMs + 30000, lastHeartbeatAt: nowMs };
  assert.equal(await svcA.store.claim(env.messageId, claim), true);

  // Lock exists in A's tree
  assert.equal(await svcA.store.hasClaimLock(env.messageId), true);
  // B's tree has no such lock (paths are separate)
  const svcB = new MailboxService({
    rootDir: join(baseDir, "root"), authority: permissiveAuthority(),
    recipientCorrelationId: "*", workspaceId: WS_B, teamId: "t", ownerId: "oB",
    onDispatch: async () => {}, now: () => nowMs,
  });
  await ensureMailboxDirectories(svcB.paths);
  assert.equal(await svcB.store.hasClaimLock(env.messageId), false, "workspace B must not see A's lock");

  await svcA.stop();
  await svcB.stop();
});

// --- helpers ---

function makeEnvelope(id: string, overrides: Partial<MailboxEnvelope> = {}): MailboxEnvelope {
  return {
    messageId: id,
    schemaVersion: MAILBOX_SCHEMA_VERSION,
    workspaceId: WS_A,
    teamId: "team-root",
    senderId: "b".repeat(32),
    recipientId: "c".repeat(32),
    recipientCorrelationId: "corr-1",
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
    hash: "dummy",
    ...overrides,
  };
}
