/**
 * Regression tests for mailbox lifecycle fencing (ISS-20260803-003) and the
 * P0/P1 hardening: start/stop interleavings, auto-apply on dispatch, accepted
 * replay, bounded retries, read-side integrity (hash + symlink), identifier
 * validation, shadow no-consumer semantics, and host-scheduled GC.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { MailboxConsumer } from "../src/extension/mailbox/consumer.ts";
import {
  computeEnvelopeHash,
  MailboxFileStore,
  createMailboxPaths,
  ensureMailboxDirectories,
} from "../src/extension/mailbox/file-store.ts";
import { MailboxGC, QuotaAdmission } from "../src/extension/mailbox/gc.ts";
import { MailboxHost } from "../src/extension/mailbox/host.ts";
import { MailboxRollout } from "../src/extension/mailbox/rollout.ts";
import { type MailboxAuthority, MailboxRouter } from "../src/extension/mailbox/router.ts";
import { MailboxService } from "../src/extension/mailbox/service.ts";
import {
  type MailboxEnvelope,
  type MailboxPaths,
  MAILBOX_SCHEMA_VERSION,
  MAX_DISPATCH_RETRIES,
  TTL_NORMAL_MS,
  TTL_RECEIPT_MS,
} from "../src/extension/mailbox/types.ts";
import type { TeammateState } from "../src/shared/types.ts";

const temporaryDirectories: string[] = [];
let baseDir: string;
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
    managesRecipient: () => true,
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

function makeState(): TeammateState {
  return {
    baseCwd: "D:/test/project",
    currentSessionId: null,
    sessionGeneration: 1,
    activeRuns: new Map(),
    namedAgents: new Map(),
  };
}

interface ServiceOptions {
  onDispatch?: (envelope: MailboxEnvelope) => Promise<void>;
  pollMs?: number;
}

function makeServiceOptions(options: ServiceOptions = {}) {
  return {
    rootDir: join(baseDir, "root"),
    authority: permissiveAuthority(),
    recipientCorrelationId: "*",
    workspaceId: "a".repeat(64),
    teamId: "t",
    ownerId: "o",
    onDispatch: options.onDispatch ?? (async () => {}),
    pollMs: options.pollMs ?? 10,
    now: () => nowMs,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "mailbox-fence-"));
  temporaryDirectories.push(baseDir);
  paths = createMailboxPaths(join(baseDir, "mailbox"));
  await ensureMailboxDirectories(paths);
  nowMs = 1_700_000_000_000;
  store = new MailboxFileStore({ paths, now: () => nowMs });
  quota = new QuotaAdmission({ store });
  router = new MailboxRouter({ store, authority: permissiveAuthority(), quota, now: () => nowMs });
});

// ===========================================================================
// ISS-20260803-003: startup must not outlive stop; stop is a clean barrier
// ===========================================================================

test("host.stop() immediately after construction never starts a consuming poll", async () => {
  const state = makeState();
  const injected: string[] = [];
  const host = new MailboxHost({
    rootDir: join(baseDir, "mb"),
    state,
    ownerId: "owner-1",
    workspaceId: "a".repeat(64),
    teamId: "team-root",
    inject: async (e) => { injected.push(e.payload); },
    mode: "authoritative",
    pollMs: 5,
  });
  // Stop before the fire-and-forget service.start() has settled.
  await host.stop();

  // Deliver after stop: enqueued but never consumed (files preserved for drain).
  const result = await host.rollout.deliver({
    senderId: "caller",
    recipientId: "target",
    recipientCorrelationId: "corr-1",
    kind: "follow_up",
    mode: "follow_up",
    payload: "after stop",
  });
  assert.ok(result.result.ok);
  const messageId = (result.result as { messageId: string }).messageId;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(injected.length, 0, "no dispatch may happen after stop returned");
  assert.ok(await host.service.store.readEnvelope("ready", messageId), "message stays ready for drain");
});

test("service.stop() during in-flight start leaves no running consumer", async () => {
  const dispatched: string[] = [];
  const service = new MailboxService(makeServiceOptions({
    onDispatch: async (e) => { dispatched.push(e.messageId); },
  }));
  const startPromise = service.start();
  // Stop while start() is still initializing (TOCTOU window).
  const stopPromise = service.stop();
  await Promise.all([startPromise.catch(() => undefined), stopPromise]);

  const result = await service.enqueue({
    senderId: "sender-1",
    recipientId: "c".repeat(32),
    recipientCorrelationId: "corr-child-1",
    kind: "follow_up",
    mode: "follow_up",
    payload: "fenced",
  });
  assert.ok(result.ok);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(dispatched.length, 0, "consumer must never have started");
  assert.ok(await service.store.readEnvelope("ready", result.messageId));
  await service.stop();
});

test("service can restart after stop (stop-then-start)", async () => {
  const dispatched: string[] = [];
  const service = new MailboxService(makeServiceOptions({
    onDispatch: async (e) => { dispatched.push(e.messageId); },
  }));
  await service.start();
  await service.stop();
  await service.start();

  const result = await service.enqueue({
    senderId: "sender-1",
    recipientId: "c".repeat(32),
    recipientCorrelationId: "corr-child-1",
    kind: "follow_up",
    mode: "follow_up",
    payload: "restarted",
  });
  assert.ok(result.ok);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(dispatched.length, 1);
  await service.stop();
});

test("messages enqueued after consumer.stop() are never claimed or dispatched", async () => {
  const dispatched: string[] = [];
  const service = new MailboxService(makeServiceOptions({
    onDispatch: async (e) => { dispatched.push(e.messageId); },
  }));
  await service.start();
  await service.stop();

  const result = await service.enqueue({
    senderId: "sender-1",
    recipientId: "c".repeat(32),
    recipientCorrelationId: "corr-child-1",
    kind: "follow_up",
    mode: "follow_up",
    payload: "post-stop",
  });
  assert.ok(result.ok);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(dispatched.length, 0, "in-flight poll must not claim after stop");
  assert.ok(await service.store.readEnvelope("ready", result.messageId));
});

test("rollout downgrade to disabled stops the consumer before republishing the mode", async () => {
  const dispatched: string[] = [];
  const service = new MailboxService(makeServiceOptions({
    onDispatch: async (e) => { dispatched.push(e.payload); },
    pollMs: 500, // slow poll: the downgrade must stop the consumer, not race it
  }));
  const rollout = new MailboxRollout({
    service,
    config: { mode: "authoritative", advertiseV2: true },
    directDeliver: async () => {},
    now: () => nowMs,
  });
  await service.start();

  await rollout.deliver({
    senderId: "caller", recipientId: "r", recipientCorrelationId: "corr-1",
    kind: "follow_up", mode: "follow_up", payload: "one",
  });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(dispatched, ["one"]);

  // Second message lands in ready; downgrade must stop the consumer so the
  // still-ready message is preserved for drain and never dispatched after the flip.
  const second = await rollout.deliver({
    senderId: "caller", recipientId: "r", recipientCorrelationId: "corr-1",
    kind: "follow_up", mode: "follow_up", payload: "two",
  });
  assert.ok(second.result.ok);
  await rollout.setMode("disabled");
  assert.equal(rollout.mode, "disabled");
  assert.equal(rollout.advertisedCapability(), "v1");

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(dispatched, ["one"], "downgrade must not dispatch in-flight ready messages");
  assert.ok(await service.store.readEnvelope("ready", (second.result as { messageId: string }).messageId));
  await service.stop();
});

// ===========================================================================
// Auto-apply + bounded retries
// ===========================================================================

test("persistently failing dispatch dead-letters after MAX_DISPATCH_RETRIES", async () => {
  let attempts = 0;
  const consumer = new MailboxConsumer({
    store, router, recipientCorrelationId: "corr-001",
    workspaceId: "a".repeat(64), pollMs: 5, now: () => nowMs,
    onDispatch: async () => { attempts += 1; throw new Error("inject failed"); },
  });
  // Direct consumers must observe the "error" event (Node EventEmitter
  // semantics); the service layer forwards it as "dispatch-error".
  consumer.on("error", () => {});
  const envelope = makeEnvelope("00000000-0000-4000-8000-000000000040");
  await store.writeStaging(envelope);
  await store.promoteToReady(envelope.messageId);

  consumer.start();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await store.listMessages("dead")).includes(envelope.messageId)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await consumer.stop();

  // Bounded: exactly MAX_DISPATCH_RETRIES attempts, then dead-lettered.
  assert.equal(attempts, MAX_DISPATCH_RETRIES);
  // The dead file still carries the failing-envelope content, so use the raw
  // directory listing (readEnvelope would reject it only if tampered).
  assert.ok((await store.listMessages("dead")).includes(envelope.messageId));
  assert.equal(await store.readEnvelope("ready", envelope.messageId), undefined);
});

// ===========================================================================
// Read-side integrity (P1): tampered envelopes and symlinks are rejected
// ===========================================================================

test("tampered envelope payload is dead-lettered, never dispatched", async () => {
  const dispatched: string[] = [];
  const consumer = new MailboxConsumer({
    store, router, recipientCorrelationId: "corr-001",
    workspaceId: "a".repeat(64), pollMs: 10, now: () => nowMs,
    onDispatch: async (e) => { dispatched.push(e.messageId); },
  });
  const envelope = makeEnvelope("00000000-0000-4000-8000-000000000030");
  await store.writeStaging(envelope);
  await store.promoteToReady(envelope.messageId);

  // Tamper with the payload on disk (bypasses the store API).
  const envelopePath = join(store.paths.readyDir, `${envelope.messageId}.json`);
  const raw = JSON.parse(await readFile(envelopePath, "utf8"));
  raw.payload = "evil";
  await writeFile(envelopePath, JSON.stringify(raw));

  consumer.start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await consumer.stop();

  assert.equal(dispatched.length, 0, "tampered message must never dispatch");
  // Dead-lettered on disk; readEnvelope rejects the tampered content itself.
  assert.ok((await store.listMessages("dead")).includes(envelope.messageId), "tampered message is dead-lettered");
});

test("symlinked envelope in ready is rejected and dead-lettered", async (t) => {
  const dispatched: string[] = [];
  const consumer = new MailboxConsumer({
    store, router, recipientCorrelationId: "corr-001",
    workspaceId: "a".repeat(64), pollMs: 10, now: () => nowMs,
    onDispatch: async (e) => { dispatched.push(e.messageId); },
  });
  const envelope = makeEnvelope("00000000-0000-4000-8000-000000000031");
  await store.writeStaging(envelope);
  await store.promoteToReady(envelope.messageId);

  // Replace the envelope file with a symlink to an external payload.
  const envelopePath = join(store.paths.readyDir, `${envelope.messageId}.json`);
  const outside = join(baseDir, "outside.json");
  await writeFile(outside, JSON.stringify({ ...envelope, payload: "symlinked" }));
  await rm(envelopePath, { force: true });
  try {
    await symlink(outside, envelopePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") {
      t.skip("symlink creation not permitted on this platform");
      return;
    }
    throw error;
  }

  // The lstat guard rejects the symlink outright.
  assert.equal(await store.readEnvelope("ready", envelope.messageId), undefined);

  consumer.start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await consumer.stop();
  assert.equal(dispatched.length, 0);
  assert.ok((await store.listMessages("dead")).includes(envelope.messageId));
});

// ===========================================================================
// Identifier validation (P1)
// ===========================================================================

test("MailboxService rejects path-unsafe workspaceId at construction", () => {
  const options = makeServiceOptions();
  assert.throws(
    () => new MailboxService({ ...options, workspaceId: "../escape" }),
    /invalid workspaceId/,
  );
  assert.throws(
    () => new MailboxService({ ...options, workspaceId: "a/b" }),
    /invalid workspaceId/,
  );
});

test("router.enqueue rejects malformed senderId / recipientCorrelationId / workspaceId", async () => {
  const bad = (overrides: Partial<Parameters<MailboxRouter["enqueue"]>[0]>) =>
    router.enqueue({
      workspaceId: "a".repeat(64),
      teamId: "t",
      senderId: "sender-1",
      recipientId: "c".repeat(32),
      recipientCorrelationId: "corr-001",
      kind: "follow_up",
      mode: "follow_up",
      payload: "x",
      ...overrides,
    });

  assert.equal((await bad({ senderId: "../evil" })).ok, false);
  assert.equal((await bad({ senderId: "" })).ok, false);
  assert.equal((await bad({ recipientCorrelationId: "../evil" })).ok, false);
  assert.equal((await bad({ recipientCorrelationId: "" })).ok, false);
  assert.equal((await bad({ workspaceId: "a/../b" })).ok, false);
  // Valid values still pass.
  assert.equal((await bad({})).ok, true);
  assert.equal((await bad({ senderId: "caller" })).ok, true);
});

// ===========================================================================
// Shadow mode never consumes (P1)
// ===========================================================================

test("service.start(false) initializes directories but never consumes", async () => {
  const dispatched: string[] = [];
  const service = new MailboxService(makeServiceOptions({
    onDispatch: async (e) => { dispatched.push(e.messageId); },
  }));
  await service.start(false); // shadow-style init: dirs only

  const result = await service.enqueue({
    senderId: "sender-1",
    recipientId: "c".repeat(32),
    recipientCorrelationId: "corr-child-1",
    kind: "follow_up",
    mode: "follow_up",
    payload: "shadow",
  });
  assert.ok(result.ok);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(dispatched.length, 0, "shadow must never consume");
  assert.ok(await service.store.readEnvelope("ready", result.messageId));
  await service.stop();
});

test("rollout upgrade shadow → authoritative starts the consumer", async () => {
  const dispatched: string[] = [];
  const service = new MailboxService(makeServiceOptions({
    onDispatch: async (e) => { dispatched.push(e.payload); },
  }));
  const rollout = new MailboxRollout({
    service,
    config: { mode: "shadow", advertiseV2: true },
    directDeliver: async () => {},
    now: () => nowMs,
  });
  await service.start(false);
  await rollout.setMode("authoritative");
  assert.equal(rollout.mode, "authoritative");

  const result = await rollout.deliver({
    senderId: "caller", recipientId: "r", recipientCorrelationId: "corr-1",
    kind: "follow_up", mode: "follow_up", payload: "upgraded",
  });
  assert.equal(result.path, "v2");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(dispatched, ["upgraded"]);
  await service.stop();
});

// ===========================================================================
// M-level: lease binding, mode single-source, dedup, seen GC
// ===========================================================================

test("lease handoff invalidates in-flight envelopes (epoch/nonce bound to recipient)", async () => {
  const lease = { epoch: 1, nonce: "nonce-a" };
  const authority: MailboxAuthority = {
    canRoute: () => ({ allowed: true }),
    currentGeneration: () => 1,
    currentLeaseEpoch: () => lease.epoch,
    currentLeaseNonce: () => lease.nonce,
    isFenced: () => false,
    isStaleUnauthorized: () => false,
    managesRecipient: () => true,
  };
  const localStore = new MailboxFileStore({ paths, now: () => nowMs });
  const localRouter = new MailboxRouter({ store: localStore, authority, quota: new QuotaAdmission({ store: localStore }), now: () => nowMs });

  const request = {
    workspaceId: "a".repeat(64), teamId: "t", senderId: "sender-1", recipientId: "c".repeat(32),
    recipientCorrelationId: "corr-001", kind: "follow_up" as const, mode: "follow_up" as const, payload: "lease-bound",
  };
  const result = await localRouter.enqueue(request);
  assert.ok(result.ok);
  const envelope = await localStore.readEnvelope("ready", result.messageId);
  assert.equal(envelope?.leaseEpoch, 1, "envelope stamps the recipient lease at enqueue");
  assert.equal(envelope?.leaseNonce, "nonce-a", "envelope stamps the recipient nonce at enqueue");

  // Handoff advances the recipient lease (epoch + nonce rotate).
  lease.epoch = 2;
  lease.nonce = "nonce-b";
  const validation = await localRouter.revalidateForDispatch(envelope!);
  assert.equal(validation.allowed, false, "old-lease envelope must not dispatch");
  assert.equal(validation.action, "dead");
  assert.match(validation.reason ?? "", /lease/);

  // A fresh enqueue under the new lease passes revalidation.
  const result2 = await localRouter.enqueue({ ...request, payload: "after handoff" });
  assert.ok(result2.ok);
  const env2 = await localStore.readEnvelope("ready", result2.messageId);
  assert.equal(env2?.leaseEpoch, 2);
  assert.equal(env2?.leaseNonce, "nonce-b");
  const validation2 = await localRouter.revalidateForDispatch(env2!);
  assert.equal(validation2.allowed, true);
});

test("host.mode proxies the rollout controller (single mode source)", async () => {
  const state = makeState();
  const host = new MailboxHost({
    rootDir: join(baseDir, "mb"),
    state,
    ownerId: "owner-1",
    workspaceId: "a".repeat(64),
    teamId: "team-root",
    inject: async () => {},
    mode: "authoritative",
    pollMs: 500,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(host.mode, "authoritative");
  await host.rollout.setMode("disabled");
  assert.equal(host.mode, "disabled", "runtime mode change must be visible through host.mode");
  await host.stop();
});

test("dedup keys on requestId: same request id is rejected on re-enqueue", async () => {
  const service = new MailboxService(makeServiceOptions());
  await service.start();
  const request = {
    senderId: "sender-1", recipientId: "c".repeat(32), recipientCorrelationId: "corr-child-1",
    kind: "follow_up" as const, mode: "follow_up" as const, payload: "x", requestId: "task-123",
  };
  const r1 = await service.enqueue(request);
  assert.ok(r1.ok);
  const r2 = await service.enqueue({ ...request, payload: "retry" });
  assert.equal(r2.ok, false);
  assert.equal((r2 as { code?: string }).code, "duplicate");
  // Different request ids both pass.
  const r3 = await service.enqueue({ ...request, requestId: "task-456" });
  assert.ok(r3.ok);
  await service.stop();
});

test("GC sweeps stale seen markers after receipt retention", async () => {
  let clock = nowMs;
  const gcStore = new MailboxFileStore({ paths, now: () => clock });
  await gcStore.markSeen("task-old");
  clock += 1000;
  await gcStore.markSeen("task-new");
  const gc = new MailboxGC({ store: gcStore, now: () => clock });
  clock += TTL_RECEIPT_MS;
  const result = await gc.run();
  assert.equal(await gcStore.isSeen("task-old"), false, "stale marker swept");
  assert.equal(await gcStore.isSeen("task-new"), true, "fresh marker retained");
  assert.ok(result.removed >= 1);
});

// ===========================================================================
// Host-scheduled GC (P0)
// ===========================================================================

test("MailboxHost schedules periodic GC that sweeps applied receipts", async () => {
  let clock = nowMs;
  const state = makeState();
  // The "*" host consumer only dispatches to recipients it owns (activeRuns).
  state.activeRuns.set("corr-1", {
    agent: "worker",
    correlationId: "corr-1",
    startedAt: Date.now(),
    abortController: new AbortController(),
    ownsChildProcess: true,
    inbox: [],
    outputLog: [],
    lastActivityAt: Date.now(),
    depth: 0,
    status: "running",
    runtimeGeneration: 1,
    sleepMs: 0,
    stdin: { writable: true },
    lease: { owner: "child", state: "active", epoch: 1, nonce: "owner-1" },
  } as never);
  const host = new MailboxHost({
    rootDir: join(baseDir, "mb"),
    state,
    ownerId: "owner-1",
    workspaceId: "a".repeat(64),
    teamId: "team-root",
    inject: async () => {},
    mode: "authoritative",
    pollMs: 10,
    gcIntervalMs: 30,
    now: () => clock,
  });
  await new Promise((resolve) => setTimeout(resolve, 60));

  const result = await host.rollout.deliver({
    senderId: "caller",
    recipientId: "target",
    recipientCorrelationId: "corr-1",
    kind: "follow_up",
    mode: "follow_up",
    payload: "gc me",
  });
  assert.ok(result.result.ok);
  const messageId = (result.result as { messageId: string }).messageId;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(await host.service.store.readEnvelope("applied", messageId), "dispatched message is applied");

  // Advance the injected clock past the receipt retention; the next GC tick
  // must sweep the applied receipt.
  clock += TTL_RECEIPT_MS + 1000;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await host.service.store.readEnvelope("applied", messageId), undefined, "GC sweeps applied receipts");

  await host.stop();
});
