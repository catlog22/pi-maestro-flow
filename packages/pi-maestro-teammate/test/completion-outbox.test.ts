import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  computeCompletionDeliveryId,
  type CompletionDispatchSeed,
  type CompletionIntent,
  type CompletionTarget,
} from "../src/public/v1/completion-durability.ts";
import { CompletionOutboxFileStore } from "../src/completion-outbox/file-store.ts";
import {
  COMPLETION_OUTBOX_CLAIM_MS,
  COMPLETION_OUTBOX_LIVE_TTL_MS,
} from "../src/completion-outbox/types.ts";

const target: CompletionTarget = { workspaceId: "workspace-a", sessionId: "session-a" };

function seed(id: string, owner: CompletionTarget = target): CompletionDispatchSeed {
  return {
    dispatchId: `dispatch-${id}`,
    deliveryGroupId: `group-${id}`,
    reservationId: `reservation-${id}`,
    mode: "single",
    target: owner,
    replyTarget: "main",
    originCwd: "D:/workspace-a",
    expectedTasks: [`task-${id}`],
    createdAt: 1_000,
  };
}

function intent(input: CompletionDispatchSeed): CompletionIntent {
  const base: CompletionIntent = {
    version: 1,
    deliveryId: "0".repeat(64),
    dispatchId: input.dispatchId,
    reservationId: input.reservationId,
    mode: input.mode,
    kind: "single",
    target: input.target,
    replyTarget: input.replyTarget,
    outcome: "completed",
    summary: `completed ${input.dispatchId}`,
    resources: [{
      correlationId: input.expectedTasks[0]!,
      publicationId: `publication-${input.dispatchId}`,
      uri: `agent://publication-${input.dispatchId}`,
      originCwd: input.originCwd,
      summary: "done",
      outcome: "completed",
    }],
    createdAt: input.createdAt,
    finalizedAt: input.createdAt + 10,
    contentRevision: "a".repeat(64),
  };
  return { ...base, deliveryId: computeCompletionDeliveryId(base) };
}

async function withStore(
  run: (store: CompletionOutboxFileStore, advance: (ms: number) => void, root: string) => Promise<void>,
  limits: { maxLiveRecords?: number; maxLiveBytes?: number } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "completion-outbox-"));
  let now = 1_000;
  try {
    const store = new CompletionOutboxFileStore({ rootDir: root, now: () => now, ownerId: "owner-a", ...limits });
    await run(store, (ms) => { now += ms; }, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("reservation and intent import are durable and idempotent", async () => {
  await withStore(async (store) => {
    const dispatch = seed("one");
    await store.reserve(dispatch, 4_096);
    const published = intent(dispatch);
    const pending = await store.importIntent(published);
    assert.equal(pending.state, "pending");
    assert.equal(pending.deliveryId, published.deliveryId);
    assert.equal((await store.importIntent(published)).deliveryId, published.deliveryId);
    assert.equal((await store.listForTarget(target)).length, 1);
    assert.equal((await store.listForTarget({ workspaceId: target.workspaceId, sessionId: "other" })).length, 0);
    const usage = await store.usage(target.workspaceId);
    assert.equal(usage.liveRecords, 1);
    assert.equal(usage.reservations, 0);
    assert.ok(usage.liveBytes > 0);
  });
});

test("claim, queue, receipt and provider acknowledgement follow explicit states", async () => {
  await withStore(async (store) => {
    const dispatch = seed("states");
    await store.reserve(dispatch);
    const pending = await store.importIntent(intent(dispatch));
    const claimed = await store.acquireClaim(target, pending.deliveryId);
    assert.equal(claimed?.claimOwnerId, "owner-a");
    const queued = await store.markQueued(target, pending.deliveryId, 10_000);
    assert.equal(queued?.state, "queued");
    assert.equal(queued?.attempts, 1);
    const applied = await store.markApplied(target, pending.deliveryId);
    assert.equal(applied?.state, "applied");
    assert.equal(applied?.providerAcknowledgedAt, undefined);
    const acknowledged = await store.markProviderAcknowledged(target, pending.deliveryId);
    assert.equal(acknowledged?.providerAcknowledgedAt, 1_000);
    assert.equal((await store.importIntent(intent(dispatch))).state, "applied");
  });
});

test("claim lease excludes another process until expiry", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-claim-"));
  let now = 1_000;
  try {
    const first = new CompletionOutboxFileStore({ rootDir: root, now: () => now, ownerId: "owner-a" });
    const second = new CompletionOutboxFileStore({ rootDir: root, now: () => now, ownerId: "owner-b" });
    const dispatch = seed("claim");
    await first.reserve(dispatch);
    const pending = await first.importIntent(intent(dispatch));
    assert.equal((await first.acquireClaim(target, pending.deliveryId))?.claimOwnerId, "owner-a");
    assert.equal(await second.acquireClaim(target, pending.deliveryId), undefined);
    now += COMPLETION_OUTBOX_CLAIM_MS + 1;
    assert.equal((await second.acquireClaim(target, pending.deliveryId))?.claimOwnerId, "owner-b");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capacity exhaustion fails before a second reservation", async () => {
  await withStore(async (store) => {
    await store.reserve(seed("capacity-a"), 2_048);
    await assert.rejects(() => store.reserve(seed("capacity-b"), 2_048), /capacity exhausted.*No teammate child was started/s);
  }, { maxLiveRecords: 1, maxLiveBytes: 4_096 });
});

test("gc expires live records and removes expired reservations", async () => {
  await withStore(async (store, advance) => {
    const imported = seed("expired");
    await store.reserve(imported);
    await store.importIntent(intent(imported));
    await store.reserve(seed("unused"));
    advance(COMPLETION_OUTBOX_LIVE_TTL_MS + 1);
    const result = await store.gc(target.workspaceId);
    assert.equal(result.expired, 1);
    assert.ok(result.releasedReservations >= 1);
    const records = await store.listForTarget(target);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.state, "expired");
  });
});

test("linked output root is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-link-"));
  const real = join(root, "real");
  const linked = join(root, "linked");
  try {
    await mkdir(real);
    await symlink(real, linked, process.platform === "win32" ? "junction" : "dir");
    const store = new CompletionOutboxFileStore({ rootDir: linked });
    await assert.rejects(() => store.reserve(seed("linked")), /must be a real directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
