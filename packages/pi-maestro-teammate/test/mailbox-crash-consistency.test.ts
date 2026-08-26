import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { MailboxConsumer } from "../src/extension/mailbox/consumer.ts";
import {
  computeEnvelopeHash,
  createMailboxPaths,
  ensureMailboxDirectories,
  MailboxFileStore,
  type MailboxPersistenceBoundary,
} from "../src/extension/mailbox/file-store.ts";
import { MailboxGC, QuotaAdmission } from "../src/extension/mailbox/gc.ts";
import { type MailboxAuthority, MailboxRouter } from "../src/extension/mailbox/router.ts";
import { MailboxService } from "../src/extension/mailbox/service.ts";
import {
  MAILBOX_SCHEMA_VERSION,
  type MailboxEnvelope,
  type MailboxOwnerFence,
  TTL_NORMAL_MS,
} from "../src/extension/mailbox/types.ts";

const temporaryDirectories: string[] = [];
const workspaceId = "a".repeat(64);
let now = 1_700_000_000_000;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function envelope(messageId: string, overrides: Partial<MailboxEnvelope> = {}): MailboxEnvelope {
  const body: Omit<MailboxEnvelope, "hash"> = {
    messageId,
    schemaVersion: MAILBOX_SCHEMA_VERSION,
    workspaceId,
    teamId: "team-root",
    senderId: "caller",
    recipientId: "worker",
    recipientCorrelationId: "worker-correlation",
    kind: "follow_up",
    mode: "follow_up",
    priority: "normal",
    senderSeq: 1,
    createdAt: now,
    expiresAt: now + TTL_NORMAL_MS,
    ttlMs: TTL_NORMAL_MS,
    sessionGeneration: 7,
    leaseEpoch: 1,
    leaseNonce: "lease-nonce",
    payload: "durable payload",
    ...overrides,
  };
  return { ...body, hash: computeEnvelopeHash(body) };
}

function authority(): MailboxAuthority {
  return {
    canRoute: () => ({ allowed: true }),
    currentGeneration: () => 7,
    currentLeaseEpoch: () => 1,
    currentLeaseNonce: () => "lease-nonce",
    isFenced: () => false,
    isStaleUnauthorized: () => false,
    managesRecipient: () => true,
  };
}

async function fixture(prefix: string) {
  const base = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(base);
  const paths = createMailboxPaths(join(base, "mailbox"));
  await ensureMailboxDirectories(paths);
  return { base, paths };
}

const transitionCrashWindows: MailboxPersistenceBoundary[] = [
  "replacement-prepared",
  "replacement-published",
  "replacement-finished",
  "transition-prepared",
  "transition-metadata",
  "transition-renamed",
  "transition-directories-synced",
  "transition-source-cleaned",
  "transition-finished",
];

for (const boundary of transitionCrashWindows) {
  test(`transition recovery keeps exactly one envelope after ${boundary}`, async () => {
    const { paths } = await fixture("mailbox-transition-crash-");
    const message = envelope("00000000-0000-4000-8000-000000000101");
    const initial = new MailboxFileStore({ paths, now: () => now });
    await initial.writeStaging(message);
    await initial.promoteToReady(message.messageId);

    let injected = false;
    const crashing = new MailboxFileStore({
      paths,
      now: () => now,
      onPersistenceBoundary(candidate) {
        if (!injected && candidate === boundary) {
          injected = true;
          throw new Error(`simulated crash at ${boundary}`);
        }
      },
    });
    const claim = {
      messageId: message.messageId,
      claimerNonce: "crashed-owner",
      claimedAt: now,
      leaseExpiresAt: now + 30_000,
      lastHeartbeatAt: now,
    };
    await assert.rejects(crashing.claim(message.messageId, claim), /simulated crash/);
    assert.equal(injected, true);

    const fresh = new MailboxFileStore({ paths, now: () => now });
    await fresh.recover();
    const locations = await Promise.all([
      fresh.readEnvelope("ready", message.messageId),
      fresh.readEnvelope("claimed", message.messageId),
    ]);
    assert.equal(locations.filter(Boolean).length, 1, "recovery must retain exactly one live envelope");
    const recovered = locations.find(Boolean);
    assert.equal(recovered?.hash, message.hash);
  });
}

test("replacement backup crash recovers stale destination metadata and the sole envelope", async () => {
  const { paths } = await fixture("mailbox-replacement-backup-");
  const message = envelope("00000000-0000-4000-8000-000000000107");
  const initial = new MailboxFileStore({ paths, now: () => now });
  await initial.writeStaging(message);
  await initial.promoteToReady(message.messageId);
  // Simulate the legacy ready→claimed crash window: the envelope moved but its
  // old ready metadata remained and no claimed metadata was created.
  await rename(
    join(paths.readyDir, `${message.messageId}.json`),
    join(paths.claimedDir, `${message.messageId}.json`),
  );
  const crashing = new MailboxFileStore({
    paths,
    now: () => now,
    onPersistenceBoundary(boundary) {
      if (boundary === "replacement-backup") throw new Error("crash after metadata backup");
    },
  });
  await assert.rejects(
    crashing.requeue(message.messageId, "claimed", { allowTakeover: true }),
    /crash after metadata backup/,
  );
  const fresh = new MailboxFileStore({ paths, now: () => now });
  await fresh.recover();
  assert.equal((await fresh.readEnvelope("ready", message.messageId))?.hash, message.hash);
  assert.equal(await fresh.readEnvelope("claimed", message.messageId), undefined);
});

test("dedup prepare survives a crash and fresh-store recovery publishes the recorded envelope", async () => {
  const { paths } = await fixture("mailbox-dedup-crash-");
  const message = envelope("00000000-0000-4000-8000-000000000102", { requestId: "request-102" });
  const requestHash = createHash("sha256").update("request-102").digest("hex");
  const crashing = new MailboxFileStore({
    paths,
    now: () => now,
    onPersistenceBoundary(boundary) {
      if (boundary === "dedup-prepared") throw new Error("crash after dedup prepare");
    },
  });
  await assert.rejects(
    crashing.prepareEnqueue("request-102", requestHash, message),
    /crash after dedup prepare/,
  );

  const fresh = new MailboxFileStore({ paths, now: () => now });
  await fresh.recover();
  assert.equal((await fresh.readEnvelope("ready", message.messageId))?.hash, message.hash);
  const duplicate = await fresh.prepareEnqueue("request-102", requestHash, message);
  assert.deepEqual(duplicate, { status: "duplicate", messageId: message.messageId });
});

test("a fresh OS process recovers a durable dedup prepare without caller replay", async () => {
  const { paths } = await fixture("mailbox-fresh-process-");
  const message = envelope("00000000-0000-4000-8000-000000000105", { requestId: "fresh-process-request" });
  const requestHash = createHash("sha256").update("fresh-process-request").digest("hex");
  const crashing = new MailboxFileStore({
    paths,
    now: () => now,
    onPersistenceBoundary(boundary) {
      if (boundary === "dedup-prepared") throw new Error("parent process stopped after prepare");
    },
  });
  await assert.rejects(
    crashing.prepareEnqueue("fresh-process-request", requestHash, message),
    /parent process stopped/,
  );

  const script = `
    const { createMailboxPaths, MailboxFileStore } = await import('./src/extension/mailbox/file-store.ts');
    const store = new MailboxFileStore({ paths: createMailboxPaths(${JSON.stringify(paths.rootDir)}) });
    await store.recover();
  `;
  const child = spawn(process.execPath, [
    "--experimental-transform-types",
    "--import", "./test/setup.ts",
    "--input-type=module",
    "--eval", script,
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  assert.equal(exitCode, 0, stderr);
  assert.equal((await new MailboxFileStore({ paths }).readEnvelope("ready", message.messageId))?.hash, message.hash);
});

test("recordless claimed envelope is treated as an incomplete transition and recovered", async () => {
  const { paths } = await fixture("mailbox-recordless-claimed-");
  const store = new MailboxFileStore({ paths, now: () => now });
  const message = envelope("00000000-0000-4000-8000-000000000106");
  await store.writeStaging(message);
  await store.promoteToReady(message.messageId);
  await rename(
    join(paths.readyDir, `${message.messageId}.json`),
    join(paths.claimedDir, `${message.messageId}.json`),
  );
  const router = new MailboxRouter({ store, authority: authority(), quota: new QuotaAdmission({ store }), now: () => now });
  const consumer = new MailboxConsumer({
    store,
    router,
    recipientCorrelationId: "worker-correlation",
    workspaceId,
    now: () => now,
    onDispatch: async () => {},
  });
  assert.deepEqual(await consumer.reclaimStaleClaims(), [message.messageId]);
  assert.equal((await store.readEnvelope("ready", message.messageId))?.hash, message.hash);
  assert.equal(await store.readEnvelope("claimed", message.messageId), undefined);
  await consumer.stop();
});

test("published dedup transaction never resurrects a terminal envelope removed by GC", async () => {
  const { paths } = await fixture("mailbox-dedup-terminal-");
  const store = new MailboxFileStore({ paths, now: () => now });
  const message = envelope("00000000-0000-4000-8000-000000000108", { requestId: "terminal-request" });
  const requestHash = createHash("sha256").update("terminal-request").digest("hex");
  assert.equal((await store.prepareEnqueue("terminal-request", requestHash, message)).status, "prepared");
  const claim = {
    messageId: message.messageId,
    claimerNonce: "legacy-terminal-owner",
    claimedAt: now,
    leaseExpiresAt: now + 30_000,
    lastHeartbeatAt: now,
  };
  assert.equal(await store.claim(message.messageId, claim), true);
  assert.equal(await store.accept(message.messageId, claim), true);
  assert.equal(await store.apply(message.messageId), true);
  await store.remove("applied", message.messageId);

  const retry = envelope("00000000-0000-4000-8000-000000000109", { requestId: "terminal-request" });
  assert.equal((await store.prepareEnqueue("terminal-request", requestHash, retry)).status, "duplicate");
  assert.equal(await store.readEnvelope("ready", message.messageId), undefined);
  assert.equal(await store.readEnvelope("ready", retry.messageId), undefined);
});

test("orphan legacy seen marker is reconciled by removal so a retry is not lost", async () => {
  const { paths } = await fixture("mailbox-legacy-seen-");
  const store = new MailboxFileStore({ paths, now: () => now });
  await store.markSeen("orphan-request");
  assert.equal(await store.isSeen("orphan-request"), true);
  await new MailboxFileStore({ paths, now: () => now }).recover();
  assert.equal(await store.isSeen("orphan-request"), false);
});

test("concurrent equal request prepares yield one ready envelope and one duplicate", async () => {
  const { paths } = await fixture("mailbox-dedup-concurrent-");
  const store = new MailboxFileStore({ paths, now: () => now });
  const router = new MailboxRouter({ store, authority: authority(), quota: new QuotaAdmission({ store }), now: () => now });
  const request = {
    workspaceId,
    teamId: "team-root",
    senderId: "caller",
    recipientId: "worker",
    recipientCorrelationId: "worker-correlation",
    kind: "follow_up" as const,
    mode: "follow_up" as const,
    payload: "same logical request",
    requestId: "concurrent-request",
  };
  const results = await Promise.all([router.enqueue(request), router.enqueue(request)]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.code === "duplicate").length, 1);
  assert.equal((await store.listMessages("ready")).length, 1);
});

test("messageId collision with a different immutable envelope hash fails closed", async () => {
  const { paths } = await fixture("mailbox-id-collision-");
  const store = new MailboxFileStore({ paths, now: () => now });
  const first = envelope("00000000-0000-4000-8000-000000000103");
  const collision = envelope(first.messageId, { payload: "different payload" });
  await store.writeStaging(first);
  await assert.rejects(store.writeStaging(collision), /messageId collision/);
  assert.equal((await store.readEnvelope("staging", first.messageId))?.hash, first.hash);
});

test("GC is owner-fenced and caps each sweep", async () => {
  const { paths } = await fixture("mailbox-gc-fence-");
  let clock = now;
  const store = new MailboxFileStore({ paths, now: () => clock });
  for (let index = 0; index < 5; index += 1) {
    const message = envelope(`00000000-0000-4000-8000-0000000002${String(index).padStart(2, "0")}`);
    await store.writeStaging(message);
    await store.promoteToReady(message.messageId);
    const claim = {
      messageId: message.messageId,
      claimerNonce: `gc-${index}`,
      claimedAt: clock,
      leaseExpiresAt: clock + 30_000,
      lastHeartbeatAt: clock,
    };
    await store.claim(message.messageId, claim);
    await store.accept(message.messageId, claim);
    await store.apply(message.messageId);
  }
  clock += 24 * 60 * 60_000 + 1;
  let authority = false;
  const gc = new MailboxGC({ store, now: () => clock, canMutate: () => authority, maxSweep: 2 });
  assert.deepEqual(await gc.run(), { removed: 0, errors: [] });
  assert.equal((await store.listMessages("applied")).length, 5);
  authority = true;
  assert.equal((await gc.run()).removed, 2);
  assert.equal((await store.listMessages("applied")).length, 3);
});

test("a live ACCEPTED owner cannot be reclaimed and its old token cannot ack after takeover", async () => {
  const { paths } = await fixture("mailbox-owner-takeover-");
  const store = new MailboxFileStore({ paths, now: () => now });
  const router = new MailboxRouter({ store, authority: authority(), quota: new QuotaAdmission({ store }), now: () => now });
  const message = envelope("00000000-0000-4000-8000-000000000104", { mode: "notify" });
  await store.writeStaging(message);
  await store.promoteToReady(message.messageId);

  const first = new MailboxConsumer({
    store,
    router,
    ownerId: "host-a",
    consumerNonce: "owner-a",
    sessionGeneration: 7,
    recipientCorrelationId: "worker-correlation",
    workspaceId,
    pollMs: 5,
    now: () => now,
    onDispatch: async () => "deferred",
  });
  const second = new MailboxConsumer({
    store,
    router,
    ownerId: "host-b",
    consumerNonce: "owner-b",
    sessionGeneration: 7,
    recipientCorrelationId: "worker-correlation",
    workspaceId,
    pollMs: 5,
    now: () => now,
    onDispatch: async () => "deferred",
  });
  first.start();
  await waitFor(async () => !!await store.readEnvelope("accepted", message.messageId));
  assert.equal(await second.replayAcceptedToReady(), 0, "second live consumer cannot steal first owner's ACCEPTED state");
  const formerFence: MailboxOwnerFence = first.ownerFence;
  await first.stop();

  assert.equal(await second.replayAcceptedToReady(), 1);
  second.start();
  await waitFor(async () => {
    const record = await store.readStateRecord("accepted", message.messageId);
    return record?.claim?.ownerNonce === "owner-b";
  });
  assert.equal(await store.apply(message.messageId, formerFence), false, "former owner token is fenced after takeover");
  assert.equal(await second.acknowledge(message.messageId), true);
  await second.stop();
  assert.ok(await store.readEnvelope("applied", message.messageId));
});

test("shutdown drains active child adoption before returning", async () => {
  const { base } = await fixture("mailbox-dispatch-drain-");
  let entered!: () => void;
  let release!: () => void;
  const dispatchEntered = new Promise<void>((resolve) => { entered = resolve; });
  const dispatchRelease = new Promise<void>((resolve) => { release = resolve; });
  const service = new MailboxService({
    rootDir: join(base, "root"),
    authority: authority(),
    recipientCorrelationId: "worker-correlation",
    workspaceId,
    teamId: "team-root",
    ownerId: "drain-owner",
    pollMs: 5,
    now: () => now,
    onDispatch: async () => {
      entered();
      await dispatchRelease;
    },
  });
  await service.start();
  const result = await service.enqueue({
    senderId: "caller",
    recipientId: "worker",
    recipientCorrelationId: "worker-correlation",
    kind: "follow_up",
    mode: "follow_up",
    payload: "drain dispatch",
  });
  assert.ok(result.ok);
  await dispatchEntered;
  let stopped = false;
  const stopping = service.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.ok(await service.store.readEnvelope("applied", result.messageId));
});

test("shutdown drains every admitted in-flight GC sweep before owner teardown", async () => {
  const { base } = await fixture("mailbox-gc-drain-");
  const service = new MailboxService({
    rootDir: join(base, "root"),
    authority: authority(),
    recipientCorrelationId: "worker-correlation",
    workspaceId,
    teamId: "team-root",
    ownerId: "gc-drain-owner",
    pollMs: 5,
    now: () => now,
    onDispatch: async () => {},
  });
  await service.start();
  let entered!: () => void;
  let release!: () => void;
  const gcEntered = new Promise<void>((resolve) => { entered = resolve; });
  const gcRelease = new Promise<void>((resolve) => { release = resolve; });
  service.gc.run = async () => {
    entered();
    await gcRelease;
    return { removed: 0, errors: [] };
  };
  const sweep = service.runGC();
  await gcEntered;
  let stopped = false;
  const stopping = service.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(stopped, false);
  release();
  assert.deepEqual(await sweep, { removed: 0, errors: [] });
  await stopping;
});

test("shutdown drains and retries acknowledgement before owner authority closes", async () => {
  const { base } = await fixture("mailbox-ack-drain-");
  let commitAttempts = 0;
  let entered!: () => void;
  let release!: () => void;
  const commitEntered = new Promise<void>((resolve) => { entered = resolve; });
  const commitRelease = new Promise<void>((resolve) => { release = resolve; });
  const service = new MailboxService({
    rootDir: join(base, "root"),
    authority: authority(),
    recipientCorrelationId: "worker-correlation",
    workspaceId,
    teamId: "team-root",
    ownerId: "ack-owner",
    pollMs: 5,
    now: () => now,
    commitApplied: async () => {
      commitAttempts += 1;
      if (commitAttempts === 1) throw new Error("transient commit failure");
      entered();
      await commitRelease;
    },
    onDispatch: async () => "deferred",
  });
  await service.start();
  const result = await service.enqueue({
    senderId: "caller",
    recipientId: "worker",
    recipientCorrelationId: "worker-correlation",
    kind: "control",
    mode: "notify",
    payload: "deferred context",
  });
  assert.ok(result.ok);
  await waitFor(async () => !!await service.store.readEnvelope("accepted", result.messageId));
  const acknowledging = service.acknowledge(result.messageId);
  await commitEntered;
  let stopped = false;
  const stopping = service.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(stopped, false);
  release();
  assert.equal(await acknowledging, true);
  await stopping;
  assert.equal(commitAttempts, 2);
  assert.ok(await service.store.readEnvelope("applied", result.messageId));
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not reached before timeout");
}
