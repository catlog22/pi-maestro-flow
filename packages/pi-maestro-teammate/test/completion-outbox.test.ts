import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  computeCompletionDeliveryId,
  type CompletionDispatchSeed,
  type CompletionIntent,
  type CompletionTarget,
} from "../src/public/v1/completion-durability.ts";
import { CompletionOutboxFileStore } from "../src/completion-outbox/file-store.ts";
import { CompletionDeliveryCoordinator } from "../src/completion-outbox/coordinator.ts";
import {
  COMPLETION_OUTBOX_CLAIM_MS,
  COMPLETION_OUTBOX_LIVE_TTL_MS,
} from "../src/completion-outbox/types.ts";

const target: CompletionTarget = { workspaceId: "workspace-a", sessionId: "session-a" };

async function findStateDir(root: string, state: string): Promise<string> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === state) return join(entry.parentPath, entry.name);
  }
  throw new Error(`state dir ${state} not found under ${root}`);
}

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

test("completion delivery envelopes carry authoritative result provenance", async () => {
  await withStore(async (store) => {
    const dispatch = seed("provenance");
    await store.reserve(dispatch);
    const record = await store.importIntent(intent(dispatch));
    const coordinator = new CompletionDeliveryCoordinator({ store, enabled: () => false });
    try {
      const envelope = coordinator.deliveryEnvelope(record, true);
      assert.deepEqual(envelope.details.provenance, {
        version: 1,
        messageId: dispatch.dispatchId,
        source: "completion-outbox",
        messageKind: "result",
        deliveryMode: "notify",
        confidence: "verified",
        sender: { kind: "system", ownerId: target.sessionId, label: "completion-outbox" },
      });
    } finally {
      coordinator.dispose();
    }
  });
});

test("reservation and intent import are durable and idempotent", async () => {
  await withStore(async (store) => {
    const dispatch = seed("one");
    await store.reserve(dispatch, 4_096);
    const published = intent(dispatch);
    const pending = await store.importIntent(published);
    assert.equal(pending.state, "pending");
    assert.equal(pending.deliveryId, published.deliveryId);
    assert.equal(pending.intentRevision, published.contentRevision);
    assert.equal((await store.importIntent(published)).deliveryId, published.deliveryId);
    assert.equal((await store.listForTarget(target)).length, 1);
    assert.equal((await store.listForTarget({ workspaceId: target.workspaceId, sessionId: "other" })).length, 0);
    const usage = await store.usage(target.workspaceId);
    assert.equal(usage.liveRecords, 1);
    assert.equal(usage.reservations, 0);
    assert.ok(usage.liveBytes > 0);
  });
});

test("two real fresh-process outbox writer failures recover the latest generation and later success cleans remnants", async () => {
  await withStore(async (store, _advance, root) => {
    const dispatch = seed("replacement-backup");
    await store.reserve(dispatch);
    const pending = await store.importIntent(intent(dispatch));
    const pendingDir = await findStateDir(root, "pending");
    const moduleUrl = pathToFileURL(resolve("src/completion-outbox/file-store.ts")).href;
    const runInterruptedWriter = (ownerId: string, now: number, operation: string) => spawnSync(
      process.execPath,
      ["--experimental-transform-types", "--input-type=module", "-e", [
        `const { CompletionOutboxFileStore } = await import(${JSON.stringify(moduleUrl)});`,
        `const store = new CompletionOutboxFileStore({ rootDir: ${JSON.stringify(root)}, ownerId: ${JSON.stringify(ownerId)}, now: () => ${now} });`,
        "try {",
        `  ${operation}`,
        "  process.exitCode = 2;",
        "} catch (error) {",
        "  if (!String(error).includes('Injected completion persistence failure')) { console.error(error); process.exitCode = 3; }",
        "  else process.exitCode = 86;",
        "}",
      ].join("\n")],
      {
        cwd: process.cwd(),
        env: { ...process.env, PI_TEST_COMPLETION_FAIL_AT: "outbox:after-new-to-canonical" },
        encoding: "utf8",
      },
    );

    const first = runInterruptedWriter(
      "generation-one",
      1_100,
      `await store.acquireClaim(${JSON.stringify(target)}, ${JSON.stringify(pending.deliveryId)});`,
    );
    assert.equal(first.status, 86, first.stderr);
    const second = runInterruptedWriter(
      "generation-two",
      1_200,
      `await store.returnToPending(${JSON.stringify(target)}, ${JSON.stringify(pending.deliveryId)}, "generation-two");`,
    );
    assert.equal(second.status, 86, second.stderr);

    const interruptedRemnants = (await readdir(pendingDir)).filter((name) =>
      name.startsWith(`${pending.deliveryId}.json.replace-`)
      && (name.endsWith(".new") || name.endsWith(".bak")));
    assert.ok(interruptedRemnants.length >= 2, "both real interrupted generations left recoverable remnants");

    const recovered = await new CompletionOutboxFileStore({ rootDir: root, ownerId: "reader", now: () => 1_250 })
      .listForTarget(target);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.deliveryId, pending.deliveryId);
    assert.equal(recovered[0]?.lastError, "generation-two", "the second real writer generation wins");
    assert.equal(recovered[0]?.claimOwnerId, undefined);

    const successScript = [
      `const { CompletionOutboxFileStore } = await import(${JSON.stringify(moduleUrl)});`,
      `const store = new CompletionOutboxFileStore({ rootDir: ${JSON.stringify(root)}, ownerId: "success-owner", now: () => 1300 });`,
      `const record = await store.acquireClaim(${JSON.stringify(target)}, ${JSON.stringify(pending.deliveryId)});`,
      "if (record?.claimOwnerId !== 'success-owner') process.exitCode = 4;",
    ].join("\n");
    const succeeded = spawnSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", successScript], {
      cwd: process.cwd(),
      env: { ...process.env },
      encoding: "utf8",
    });
    assert.equal(succeeded.status, 0, succeeded.stderr);
    assert.deepEqual(
      (await readdir(pendingDir)).filter((name) => name.startsWith(`${pending.deliveryId}.json.replace-`)
        && (name.endsWith(".new") || name.endsWith(".bak"))),
      [],
      "a later successful public mutation removes all older replacement remnants",
    );
  });
});

test("fresh-process outbox recovery is table-driven across every replacement boundary", async () => {
  for (const boundary of [
    "after-write",
    "after-file-sync",
    "after-close",
    "after-canonical-to-backup",
    "after-new-to-canonical",
    "after-directory-sync",
    "after-backup-cleanup",
  ] as const) {
    await withStore(async (store, _advance, root) => {
      const dispatch = seed(`boundary-${boundary}`);
      await store.reserve(dispatch);
      const pending = await store.importIntent(intent(dispatch));
      const moduleUrl = pathToFileURL(resolve("src/completion-outbox/file-store.ts")).href;
      const crashScript = [
        `const { CompletionOutboxFileStore } = await import(${JSON.stringify(moduleUrl)});`,
        `const store = new CompletionOutboxFileStore({ rootDir: ${JSON.stringify(root)}, ownerId: "crash-owner", now: () => 1000 });`,
        `await store.acquireClaim(${JSON.stringify(target)}, ${JSON.stringify(pending.deliveryId)});`,
      ].join("\n");
      const crashed = spawnSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", crashScript], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PI_TEST_COMPLETION_FAIL_AT: `outbox:${boundary}`,
          PI_TEST_COMPLETION_CRASH: "1",
        },
        encoding: "utf8",
      });
      assert.equal(crashed.status, 86, `${boundary}: ${crashed.stderr}`);

      const readScript = [
        `const { CompletionOutboxFileStore } = await import(${JSON.stringify(moduleUrl)});`,
        `const store = new CompletionOutboxFileStore({ rootDir: ${JSON.stringify(root)}, ownerId: "reader" });`,
        `const records = await store.listForTarget(${JSON.stringify(target)});`,
        `if (records.length !== 1 || records[0].deliveryId !== ${JSON.stringify(pending.deliveryId)}) process.exit(2);`,
      ].join("\n");
      const reader = spawnSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", readScript], {
        cwd: process.cwd(),
        env: { ...process.env },
        encoding: "utf8",
      });
      assert.equal(reader.status, 0, `${boundary}: ${reader.stderr}`);
    });
  }
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

test("legacy records without resource originCwd remain valid and listable", async () => {
  await withStore(async (store) => {
    const dispatch = seed("legacy");
    await store.reserve(dispatch, 4_096);
    const legacy = intent(dispatch);
    delete (legacy.resources[0] as { originCwd?: string }).originCwd;
    const pending = await store.importIntent(legacy);
    assert.equal(pending.state, "pending");
    const records = await store.listForTarget(target);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.deliveryId, pending.deliveryId);
  });
});

test("equal-timestamp crash remnants resolve to the most advanced state", async () => {
  await withStore(async (store, _advance, root) => {
    const dispatch = seed("remnant");
    await store.reserve(dispatch, 4_096);
    const pending = await store.importIntent(intent(dispatch));
    // Simulate a crash between writing queued and removing pending: both state
    // dirs hold the same deliveryId with identical updatedAt.
    const pendingDir = await findStateDir(root, "pending");
    const fileName = `${pending.deliveryId}.json`;
    const queuedDir = join(dirname(pendingDir), "queued");
    await mkdir(queuedDir, { recursive: true });
    await writeFile(
      join(queuedDir, fileName),
      JSON.stringify({ ...pending, state: "queued" }),
    );
    const records = await store.listForTarget(target);
    assert.equal(records.length, 1, "duplicate state files must collapse to one delivery");
    assert.equal(records[0]?.state, "queued", "the accepted queued copy must win over stale pending");
    const claimed = await store.acquireClaim(target, pending.deliveryId);
    assert.equal(claimed?.state, "queued");
  });
});

test("an expired pending record is never claimed for delivery", async () => {
  await withStore(async (store, advance) => {
    const dispatch = seed("expired-claim");
    await store.reserve(dispatch, 4_096);
    const pending = await store.importIntent(intent(dispatch));
    advance(COMPLETION_OUTBOX_LIVE_TTL_MS + 1);
    const claimed = await store.acquireClaim(target, pending.deliveryId);
    assert.equal(claimed, undefined, "expired records must not be delivered");
    const records = await store.listForTarget(target);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.state, "expired");
  });
});

test("transient EPERM on the store lock is retried, not crashed", async () => {
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalOpen = fsp.open;
  let epermHits = 0;
  let allowThrough = false;
  const replacementOpen: typeof originalOpen = ((...args: Parameters<typeof originalOpen>) => {
    const pathish = String(args[0] ?? "");
    if (!allowThrough && pathish.endsWith(".store.lock") && epermHits < 2) {
      epermHits += 1;
      throw Object.assign(new Error("injected transient lock denial"), { code: "EPERM" });
    }
    return originalOpen(...args);
  }) as typeof originalOpen;
  await withStore(async (store) => {
    Reflect.set(fsp, "open", replacementOpen);
    syncBuiltinESMExports();
    try {
      // This would previously throw EPERM straight out of #withWorkspaceLock and
      // crash the pi process; it must now retry past the transient denials.
      const dispatch = seed("eperm-retry");
      const reservation = await store.reserve(dispatch, 4_096);
      assert.equal(reservation.state, "reserved");
      assert.ok(epermHits >= 2, "both injected EPERM denials were observed");
      // Subsequent operations under the same lock must still succeed once the
      // transient condition clears.
      allowThrough = true;
      const pending = await store.importIntent(intent(dispatch));
      assert.equal(pending.state, "pending");
    } finally {
      Reflect.set(fsp, "open", originalOpen);
      syncBuiltinESMExports();
    }
  });
});

test("tryGc sweeps when idle, skips via marker, and returns busy when contended", async () => {
  await withStore(async (store, advance) => {
    const imported = seed("trygc");
    await store.reserve(imported);
    await store.importIntent(intent(imported));
    advance(COMPLETION_OUTBOX_LIVE_TTL_MS + 1);

    // First call: lock is free, marker is stale → real sweep runs.
    const first = await store.tryGc(target.workspaceId);
    assert.equal(first.busy, undefined);
    assert.equal(first.skipped, undefined);
    assert.equal(first.expired, 1);
    assert.ok(first.releasedReservations >= 1);

    // Second call immediately after: cross-process marker is fresh → skipped.
    const second = await store.tryGc(target.workspaceId);
    assert.equal(second.skipped, true);
    assert.equal(second.busy, undefined);
    assert.equal(second.expired, 0);

    // After the marker interval elapses, another real sweep runs (and finds
    // nothing left to expire, but completes without busy/skipped).
    advance(31_000);
    const third = await store.tryGc(target.workspaceId);
    assert.equal(third.busy, undefined);
    assert.equal(third.skipped, undefined);
    assert.equal(third.expired, 0);
  });
});

test("gc consumes bounded stale duplicate index pages without enumerating the large data directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-gc-pages-"));
  let now = 1;
  try {
    const store = new CompletionOutboxFileStore({ rootDir: root, now: () => now, ownerId: "gc-pages" });
    for (let index = 0; index < 140; index += 1) {
      const dispatch = seed(`paged-${String(index).padStart(3, "0")}`);
      await store.reserve(dispatch, 1);
      await store.releaseReservation(dispatch.target, dispatch.reservationId);
    }
    now = COMPLETION_OUTBOX_LIVE_TTL_MS + 10;
    const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
    const originalReaddir = fsp.readdir;
    let reservationEnumerations = 0;
    const boundedReaddir: typeof originalReaddir = (async (...args: Parameters<typeof originalReaddir>) => {
      if (String(args[0] ?? "").endsWith("reservations")) reservationEnumerations += 1;
      return originalReaddir(...args as Parameters<typeof originalReaddir>);
    }) as typeof originalReaddir;
    Reflect.set(fsp, "readdir", boundedReaddir);
    syncBuiltinESMExports();
    try {
      let released = 0;
      let pages = 0;
      let hasMore = true;
      while (hasMore) {
        const page = await store.gc(target.workspaceId);
        released += page.releasedReservations;
        pages += 1;
        hasMore = page.hasMore === true;
      }
      assert.ok(pages >= 3, "the 280-entry stale/duplicate index is consumed only in bounded pages");
      assert.equal(released, 140);
      assert.equal(reservationEnumerations, 0, "stale exact lookups never enumerate the arbitrarily large reservation directory");
    } finally {
      Reflect.set(fsp, "readdir", originalReaddir);
      syncBuiltinESMExports();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt GC index state self-heals instead of throwing on every reconcile", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-gc-corrupt-"));
  try {
    let now = 1_000;
    const store = new CompletionOutboxFileStore({ rootDir: root, now: () => now, ownerId: "corrupt-gc" });
    // Populate the GC index with one real expired reservation so a sweep exists.
    const dispatch = seed("corrupt-state");
    await store.reserve(dispatch, 1);
    await store.releaseReservation(dispatch.target, dispatch.reservationId);
    now = COMPLETION_OUTBOX_LIVE_TTL_MS + 10;
    const result = await store.gc(target.workspaceId);
    assert.ok(result.releasedReservations >= 1, "baseline sweep populates the GC index");

    // Corrupt state.json so the validation must reject it.
    const workspaceHash = (await import("node:crypto")).createHash("sha256").update(target.workspaceId).digest("hex");
    const indexPath = join(root, workspaceHash, ".gc-index", "state.json");
    await writeFile(indexPath, JSON.stringify({ version: 2, head: 5, tail: 1 }));

    // Before: this threw "Invalid completion GC index" on every reconcile.
    // After self-heal: the sweep returns normally and the index dir is gone.
    const healed = await store.gc(target.workspaceId);
    assert.equal(healed.expired, 0);
    assert.equal(healed.releasedReservations, 0);
    await assert.rejects(() => readdir(join(root, workspaceHash, ".gc-index")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

    // A fresh append rebuilds the index from scratch.
    const next = seed("rebuild");
    await store.reserve(next, 1);
    const rebuilt = await readdir(join(root, (await import("node:crypto")).createHash("sha256").update(target.workspaceId).digest("hex"), ".gc-index"));
    assert.ok(rebuilt.includes("state.json"), "GC index is rebuilt by the next append");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt GC index segment self-heals instead of poisoning the sweep", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-gc-seg-"));
  try {
    let now = 1_000;
    const store = new CompletionOutboxFileStore({ rootDir: root, now: () => now, ownerId: "corrupt-seg" });
    const workspaceHash = (await import("node:crypto")).createHash("sha256").update(target.workspaceId).digest("hex");
    // Hand-write a state pointing at segment 0 and corrupt that segment file.
    await mkdir(join(root, workspaceHash, ".gc-index", "segments"), { recursive: true });
    await writeFile(join(root, workspaceHash, ".gc-index", "state.json"), JSON.stringify({ version: 1, head: 0, tail: 1 }));
    await writeFile(join(root, workspaceHash, ".gc-index", "segments", "00000000000000000000.json"), "not-json");
    now = COMPLETION_OUTBOX_LIVE_TTL_MS + 10;
    // Previously this threw "Invalid completion GC index segment 0". Now the
    // corrupt segment is dropped and the empty slot is skipped, not fatal.
    const healed = await store.gc(target.workspaceId);
    assert.equal(healed.expired, 0);
    assert.equal(healed.releasedReservations, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh definitively dead-owner lock is taken over immediately through a token fence", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-stale-lock-"));
  const { createHash } = await import("node:crypto");
  const workspaceDir = join(root, createHash("sha256").update(target.workspaceId, "utf8").digest("hex"));
  await mkdir(workspaceDir, { recursive: true });
  const lockPath = join(workspaceDir, ".store.lock");
  await writeFile(lockPath, JSON.stringify({
    ownerId: "dead",
    token: "dead-token",
    pid: 2_147_483_647,
    heartbeatAt: Date.now(),
  }));
  try {
    const startedAt = Date.now();
    const store = new CompletionOutboxFileStore({ rootDir: root, ownerId: "takeover" });
    assert.equal((await store.reserve(seed("stale-takeover"), 4_096)).state, "reserved");
    assert.ok(Date.now() - startedAt < 5_000, "dead PID takeover does not wait for heartbeat staleness or the 45s timeout");
    await assert.rejects(() => readFile(lockPath, "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh processes recover every lock setup/release crash boundary, including pre-record setup", async () => {
  for (const boundary of [
    "after-create",
    "after-write",
    "after-file-sync",
    "after-directory-sync",
    "after-release-rename",
    "after-release-remove",
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), `completion-lock-crash-${boundary}-`));
    const moduleUrl = pathToFileURL(resolve("src/completion-outbox/file-store.ts")).href;
    try {
      const crashScript = [
        `const { CompletionOutboxFileStore } = await import(${JSON.stringify(moduleUrl)});`,
        `const store = new CompletionOutboxFileStore({ rootDir: ${JSON.stringify(root)}, ownerId: "crash-owner" });`,
        `await store.reserve(${JSON.stringify(seed(`lock-crash-${boundary}`))}, 4096);`,
      ].join("\n");
      const crashed = spawnSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", crashScript], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PI_TEST_COMPLETION_FAIL_AT: `lock:${boundary}`,
          PI_TEST_COMPLETION_CRASH: "1",
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(crashed.status, 86, `${boundary}: ${crashed.stderr}`);

      const recoveryScript = [
        `const { CompletionOutboxFileStore } = await import(${JSON.stringify(moduleUrl)});`,
        `const store = new CompletionOutboxFileStore({ rootDir: ${JSON.stringify(root)}, ownerId: "recovery-owner" });`,
        `const reservation = await store.reserve(${JSON.stringify(seed(`lock-recovery-${boundary}`))}, 4096);`,
        "if (reservation.state !== 'reserved') process.exitCode = 2;",
      ].join("\n");
      const startedAt = Date.now();
      const recovered = spawnSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", recoveryScript], {
        cwd: process.cwd(),
        env: { ...process.env },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(recovered.status, 0, `${boundary}: ${recovered.stderr}`);
      assert.ok(Date.now() - startedAt < 5_000, `${boundary}: recovery must finish well before the 45s acquisition timeout`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("failed lock setup removes its partial token before the next acquisition", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-lock-setup-failure-"));
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalOpen = fsp.open;
  let injected = false;
  const replacementOpen: typeof originalOpen = (async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (!injected && String(args[0] ?? "").endsWith(".store.lock")) {
      injected = true;
      Reflect.set(handle, "sync", async () => {
        throw Object.assign(new Error("injected lock setup sync failure"), { code: "EIO" });
      });
    }
    return handle;
  }) as typeof originalOpen;
  try {
    const store = new CompletionOutboxFileStore({ rootDir: root, ownerId: "setup-failure" });
    Reflect.set(fsp, "open", replacementOpen);
    syncBuiltinESMExports();
    await assert.rejects(() => store.reserve(seed("setup-failure"), 4_096), /injected lock setup sync failure/);
    Reflect.set(fsp, "open", originalOpen);
    syncBuiltinESMExports();
    assert.equal((await store.reserve(seed("setup-retry"), 4_096)).state, "reserved");
  } finally {
    Reflect.set(fsp, "open", originalOpen);
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("lease rewrites keep a fixed-width parseable lock record without truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-lock-fixed-width-"));
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalOpen = fsp.open;
  let lockSyncs = 0;
  const replacementOpen: typeof originalOpen = (async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    const path = String(args[0] ?? "");
    if (!path.endsWith(".store.lock")) return handle;
    const originalSync = handle.sync.bind(handle);
    Reflect.set(handle, "truncate", async () => {
      throw new Error("active lock records must never be truncated");
    });
    Reflect.set(handle, "sync", async () => {
      await originalSync();
      const raw = await readFile(path, "utf8");
      assert.equal(Buffer.byteLength(raw, "utf8"), 4096);
      assert.doesNotThrow(() => JSON.parse(raw));
      lockSyncs += 1;
    });
    return handle;
  }) as typeof originalOpen;
  try {
    Reflect.set(fsp, "open", replacementOpen);
    syncBuiltinESMExports();
    const store = new CompletionOutboxFileStore({ rootDir: root, ownerId: "fixed-width" });
    assert.equal((await store.reserve(seed("fixed-width"), 4_096)).state, "reserved");
    assert.ok(lockSyncs >= 3, "setup, mutation begin, and mutation finish persisted valid lock slots");
  } finally {
    Reflect.set(fsp, "open", originalOpen);
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("non-empty invalid lock snapshots are contention, not abandoned setup", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-lock-invalid-rewrite-"));
  const { createHash } = await import("node:crypto");
  const workspaceDir = join(root, createHash("sha256").update(target.workspaceId, "utf8").digest("hex"));
  const lockPath = join(workspaceDir, ".store.lock");
  try {
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(lockPath, "partial fixed-width lease rewrite");
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);
    const store = new CompletionOutboxFileStore({ rootDir: root, ownerId: "contender" });
    const result = await store.tryGc(target.workspaceId);
    assert.equal(result.busy, true);
    assert.equal(await readFile(lockPath, "utf8"), "partial fixed-width lease rewrite");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed lock release leaves an ended same-pid token that the next operation reclaims", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-lock-release-failure-"));
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalRename = fsp.rename;
  const originalRm = fsp.rm;
  let inject = true;
  const replacementRename: typeof originalRename = (async (...args: Parameters<typeof originalRename>) => {
    if (inject && String(args[0] ?? "").endsWith(".store.lock")) {
      throw Object.assign(new Error("injected lock release rename failure"), { code: "EPERM" });
    }
    return originalRename(...args);
  }) as typeof originalRename;
  const replacementRm: typeof originalRm = (async (...args: Parameters<typeof originalRm>) => {
    if (inject && String(args[0] ?? "").endsWith(".store.lock")) {
      throw Object.assign(new Error("injected lock release remove failure"), { code: "EPERM" });
    }
    return originalRm(...args);
  }) as typeof originalRm;
  try {
    const store = new CompletionOutboxFileStore({ rootDir: root, ownerId: "release-failure" });
    Reflect.set(fsp, "rename", replacementRename);
    Reflect.set(fsp, "rm", replacementRm);
    syncBuiltinESMExports();
    await assert.rejects(() => store.reserve(seed("release-failure"), 4_096), /ended token remains reclaimable/);
    inject = false;
    Reflect.set(fsp, "rename", originalRename);
    Reflect.set(fsp, "rm", originalRm);
    syncBuiltinESMExports();
    assert.equal((await store.reserve(seed("release-retry"), 4_096)).state, "reserved");
  } finally {
    Reflect.set(fsp, "rename", originalRename);
    Reflect.set(fsp, "rm", originalRm);
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("former lock owner cannot mutate or release a replacement owner token", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-lock-fence-"));
  const store = new CompletionOutboxFileStore({ rootDir: root, ownerId: "former-owner" });
  const dispatch = seed("lock-fence");
  await store.reserve(dispatch, 4_096);
  const { createHash } = await import("node:crypto");
  const workspaceDir = join(root, createHash("sha256").update(target.workspaceId, "utf8").digest("hex"));
  const lockPath = join(workspaceDir, ".store.lock");
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalOpen = fsp.open;
  let replaced = false;
  const replacementOpen: typeof originalOpen = (async (...args: Parameters<typeof originalOpen>) => {
    const pathish = String(args[0] ?? "");
    if (!replaced && pathish.includes("reservations") && pathish.endsWith(".new")) {
      replaced = true;
      await writeFile(lockPath, JSON.stringify({
        ownerId: "replacement-owner",
        token: "replacement-token",
        pid: process.pid,
        heartbeatAt: Date.now(),
      }));
    }
    return originalOpen(...args);
  }) as typeof originalOpen;
  try {
    Reflect.set(fsp, "open", replacementOpen);
    syncBuiltinESMExports();
    await assert.rejects(
      () => store.releaseReservation(target, dispatch.reservationId),
      /lock ownership lost/,
    );
    assert.equal(replaced, true);
    const replacement = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(replacement.token, "replacement-token", "former owner must not remove the new lock");
    Reflect.set(fsp, "open", originalOpen);
    syncBuiltinESMExports();
    await rm(lockPath, { force: true });
    const reservations = await new CompletionOutboxFileStore({ rootDir: root, ownerId: "reader" }).usage(target.workspaceId);
    assert.equal(reservations.reservations, 1, "former owner did not mutate the reservation");
  } finally {
    Reflect.set(fsp, "open", originalOpen);
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("takeover after the final ownership check fences a former canonical rename", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-generation-fence-"));
  const former = new CompletionOutboxFileStore({ rootDir: root, ownerId: "former-owner", now: () => 1_100 });
  const dispatch = seed("post-precheck-takeover");
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalRename = fsp.rename;
  const originalRm = fsp.rm;
  let formerReplacementPath: string | undefined;
  let hookTriggered = false;
  try {
    await former.reserve(dispatch, 4_096);
    const pending = await former.importIntent(intent(dispatch));
    const pendingDir = await findStateDir(root, "pending");
    const canonicalPath = join(pendingDir, `${pending.deliveryId}.json`);
    const { createHash } = await import("node:crypto");
    const workspaceDir = join(root, createHash("sha256").update(target.workspaceId, "utf8").digest("hex"));
    const lockPath = join(workspaceDir, ".store.lock");

    const replacementRm: typeof originalRm = (async (...args: Parameters<typeof originalRm>) => {
      if (formerReplacementPath && String(args[0] ?? "") === formerReplacementPath) return;
      return originalRm(...args);
    }) as typeof originalRm;
    const replacementRename: typeof originalRename = (async (...args: Parameters<typeof originalRename>) => {
      const source = String(args[0] ?? "");
      const destination = String(args[1] ?? "");
      if (!hookTriggered && destination === canonicalPath
        && source.startsWith(`${canonicalPath}.replace-`) && source.endsWith(".new")) {
        hookTriggered = true;
        formerReplacementPath = source;
        const active = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
        assert.equal(typeof active.generation, "string");
        assert.equal(typeof (active.mutation as { transaction?: unknown } | undefined)?.transaction, "string");
        // Make the holder definitively dead to drive the real takeover path at
        // the exact reverse hook: after assertOwned(), before canonical rename.
        await writeFile(lockPath, `${JSON.stringify({
          ...active,
          pid: 2_147_483_647,
          heartbeatAt: Date.now(),
        })}\n`);
        const replacement = new CompletionOutboxFileStore({
          rootDir: root,
          ownerId: "replacement-owner",
          now: () => 1_200,
        });
        const authoritative = await replacement.returnToPending(
          target,
          pending.deliveryId,
          "replacement-authoritative",
        );
        assert.equal(authoritative?.lastError, "replacement-authoritative");
        // Preserve the delayed former .new just long enough to prove that its
        // actual canonical rename can happen after takeover. The replacement's
        // committed snapshot must remain authoritative even after these bytes
        // clobber the compatibility canonical name.
        await originalRm(canonicalPath, { force: true });
      }
      return originalRename(...args);
    }) as typeof originalRename;

    Reflect.set(fsp, "rm", replacementRm);
    Reflect.set(fsp, "rename", replacementRename);
    syncBuiltinESMExports();
    await assert.rejects(
      () => former.acquireClaim(target, pending.deliveryId),
      /lock ownership lost/,
    );
    assert.equal(hookTriggered, true, "takeover hook ran immediately before the former canonical rename");

    Reflect.set(fsp, "rename", originalRename);
    Reflect.set(fsp, "rm", originalRm);
    syncBuiltinESMExports();
    const canonicalEnvelope = JSON.parse(await readFile(canonicalPath, "utf8")) as {
      value?: { claimOwnerId?: string; lastError?: string };
    };
    assert.equal(canonicalEnvelope.value?.claimOwnerId, "former-owner", "former bytes reached the canonical filename");
    const reader = new CompletionOutboxFileStore({ rootDir: root, ownerId: "reader", now: () => 1_300 });
    const visible = await reader.listForTarget(target);
    assert.equal(visible.length, 1);
    assert.equal(visible[0]?.lastError, "replacement-authoritative");
    assert.equal(visible[0]?.claimOwnerId, undefined, "readers reject the superseded former generation");
  } finally {
    Reflect.set(fsp, "rename", originalRename);
    Reflect.set(fsp, "rm", originalRm);
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("tryGc returns busy instead of throwing when the workspace lock is held", async () => {
  // Hold the workspace lock by creating the .store.lock file exclusively before
  // calling tryGc, simulating a concurrent writer. tryGc must return { busy } and
  // must NOT throw — this is the core guarantee that stops the "periodic
  // completion reconciliation failed" warning under contention.
  const root = await mkdtemp(join(tmpdir(), "completion-trygc-busy-"));
  try {
    const store = new CompletionOutboxFileStore({ rootDir: root, now: () => 1_000, ownerId: "owner-a" });
    // Prime the workspace directory so tryGc does not need to create it.
    await store.reserve(seed("prime"), 4_096);
    const { createHash } = await import("node:crypto");
    const { open: openLock, rm: rmLock } = await import("node:fs/promises");
    const workspaceDir = join(root, createHash("sha256").update(target.workspaceId, "utf8").digest("hex"));
    const lockPath = join(workspaceDir, ".store.lock");
    const holder = await openLock(lockPath, "wx", 0o600);
    try {
      const result = await store.tryGc(target.workspaceId);
      assert.equal(result.busy, true);
      assert.equal(result.skipped, undefined);
      assert.equal(result.expired, 0);
    } finally {
      await holder.close();
      await rmLock(lockPath, { force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup preserves the latest recoverable marker transaction and removes only older remnants", async () => {
  await withStore(async (store, _advance, root) => {
    await store.reserve(seed("cleanup-prime"), 4_096);
    const { createHash } = await import("node:crypto");
    const workspaceDir = join(root, createHash("sha256").update(target.workspaceId, "utf8").digest("hex"));
    const markerPath = join(workspaceDir, ".gc-marker");
    const oldTransaction = "00000000000000000001-old";
    const currentTransaction = "00000000000000000002-current";
    const oldPaths = [
      `${markerPath}.replace-${oldTransaction}.new`,
      `${markerPath}.replace-${oldTransaction}.committed`,
      `${markerPath}.replace-${oldTransaction}.bak`,
      `${markerPath}.replace-legacy-old.bak`,
    ];
    const currentCommitted = `${markerPath}.replace-${currentTransaction}.committed`;
    const revocationFence = `${markerPath}.replace-revoked-${oldTransaction}`;
    await writeFile(markerPath, JSON.stringify({ at: 1_000 }));
    await writeFile(currentCommitted, JSON.stringify({ current: true }));
    await writeFile(`${markerPath}.replace-generation-a`, JSON.stringify({
      generation: "00000000000000000002",
      clean: true,
      transaction: currentTransaction,
    }));
    await Promise.all(oldPaths.map((path) => writeFile(path, JSON.stringify({ old: true }))));
    await writeFile(revocationFence, "revoked\n");

    const rootNamesBefore = await readdir(workspaceDir);
    const workspaceGeneration = rootNamesBefore.find((name) => name.startsWith(".store-generation-"))!;
    const workspaceGenerationBefore = await readFile(join(workspaceDir, workspaceGeneration), "utf8");
    const dryRun = await store.cleanupRemnants(target.workspaceId);
    assert.equal(dryRun.apply, false);
    assert.equal(dryRun.busy, false);
    assert.equal(dryRun.candidateFiles, oldPaths.length);
    assert.equal(dryRun.removedFiles, 0);
    assert.ok(dryRun.preservedFiles >= 1);
    assert.deepEqual(await readdir(workspaceDir), rootNamesBefore);
    assert.equal(await readFile(join(workspaceDir, workspaceGeneration), "utf8"), workspaceGenerationBefore);
    await Promise.all(oldPaths.map((path) => readFile(path)));

    const applied = await store.cleanupRemnants(target.workspaceId, { apply: true });
    assert.equal(applied.busy, false);
    assert.equal(applied.candidateFiles, oldPaths.length);
    assert.equal(applied.removedFiles, oldPaths.length);
    for (const path of oldPaths) {
      await assert.rejects(readFile(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    }
    assert.deepEqual(JSON.parse(await readFile(currentCommitted, "utf8")), { current: true });
    assert.equal(await readFile(revocationFence, "utf8"), "revoked\n");
    assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), { at: 1_000 });

    const repeated = await store.cleanupRemnants(target.workspaceId, { apply: true });
    assert.equal(repeated.busy, false);
    assert.equal(repeated.candidateFiles, 0);
    assert.equal(repeated.removedFiles, 0);
    assert.deepEqual(JSON.parse(await readFile(currentCommitted, "utf8")), { current: true });
  });
});

test("cleanup returns busy without scanning or deleting while the workspace lock is held", async () => {
  await withStore(async (store, _advance, root) => {
    await store.reserve(seed("cleanup-busy"), 4_096);
    const { createHash } = await import("node:crypto");
    const { open: openLock, rm: rmLock } = await import("node:fs/promises");
    const workspaceDir = join(root, createHash("sha256").update(target.workspaceId, "utf8").digest("hex"));
    const lockPath = join(workspaceDir, ".store.lock");
    const staleRemnant = join(workspaceDir, ".gc-marker.replace-00000000000000000001-stale.bak");
    await writeFile(staleRemnant, "stale\n");
    const holder = await openLock(lockPath, "wx", 0o600);
    try {
      const dryRun = await store.cleanupRemnants(target.workspaceId);
      assert.equal(dryRun.busy, true);
      assert.equal(dryRun.scannedEntries, 0);
      const applied = await store.cleanupRemnants(target.workspaceId, { apply: true });
      assert.equal(applied.busy, true);
      assert.equal(applied.removedFiles, 0);
      assert.equal(await readFile(staleRemnant, "utf8"), "stale\n");
    } finally {
      await holder.close();
      await rmLock(lockPath, { force: true });
    }
  });
});

test("pi-teammate-outbox cleanup is dry-run by default and applies only with --apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-cleanup-cli-root-"));
  const workspace = await mkdtemp(join(tmpdir(), "completion-cleanup-cli-workspace-"));
  try {
    const { createHash } = await import("node:crypto");
    const { getRuntimeWorkspaceIdentity } = await import("../src/runtime-broker/private-state.ts");
    const identity = getRuntimeWorkspaceIdentity(workspace);
    const workspaceDir = join(root, createHash("sha256").update(identity.workspaceId, "utf8").digest("hex"));
    await mkdir(workspaceDir, { recursive: true });
    const markerPath = join(workspaceDir, ".gc-marker");
    const current = `${markerPath}.replace-00000000000000000002-current.committed`;
    const obsolete = `${markerPath}.replace-00000000000000000001-obsolete.bak`;
    await writeFile(current, "{}\n");
    await writeFile(obsolete, "{}\n");
    const cli = resolve("bin/pi-teammate-outbox.mjs");
    const run = (...extra: string[]) => spawnSync(process.execPath, [cli, "cleanup", "--workspace", workspace, "--root", root, "--json", ...extra], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    const dryRun = run();
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.equal((JSON.parse(dryRun.stdout) as { candidateFiles: number }).candidateFiles, 1);
    assert.equal(await readFile(obsolete, "utf8"), "{}\n");

    const applied = run("--apply");
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal((JSON.parse(applied.stdout) as { removedFiles: number }).removedFiles, 1);
    await assert.rejects(readFile(obsolete), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    assert.equal(await readFile(current, "utf8"), "{}\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("cleanup preserves a readable replacement when the newest generation slot dangles", async () => {
  await withStore(async (store, _advance, root) => {
    const dispatch = seed("cleanup-dangling-slot");
    const reservation = await store.reserve(dispatch, 4_096);
    const reservationsDir = await findStateDir(root, "reservations");
    const { createHash } = await import("node:crypto");
    const reservationFile = `${createHash("sha256").update(reservation.reservationId, "utf8").digest("hex")}.json`;
    const canonicalPath = join(reservationsDir, reservationFile);
    const committed = (await readdir(reservationsDir)).find((name) =>
      name.startsWith(`${reservationFile}.replace-`) && name.endsWith(".committed"));
    assert.ok(committed);
    await rm(canonicalPath);
    await writeFile(`${canonicalPath}.replace-generation-a`, JSON.stringify({
      generation: "00000000000000000099",
      clean: false,
      transaction: "00000000000000000099-absent",
    }));
    assert.equal((await store.reserve(dispatch, 4_096)).reservationId, reservation.reservationId);

    const result = await store.cleanupRemnants(target.workspaceId, { apply: true });
    assert.equal(result.busy, false);
    assert.equal(result.candidateFiles, 0);
    assert.equal(await readFile(join(reservationsDir, committed), "utf8").then((raw) => raw.length > 0), true);
    assert.equal((await store.reserve(dispatch, 4_096)).reservationId, reservation.reservationId);
  });
});

test("cleanup aborts when a scanned directory is replaced during the final lease check", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-cleanup-dir-swap-"));
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalLstat = fsp.lstat;
  const originalReadFile = fsp.readFile;
  let armed = false;
  let swapped = false;
  try {
    const store = new CompletionOutboxFileStore({ rootDir: root, ownerId: "cleanup-dir-swap" });
    await store.reserve(seed("cleanup-dir-swap"), 4_096);
    const { createHash } = await import("node:crypto");
    const workspaceDir = join(root, createHash("sha256").update(target.workspaceId, "utf8").digest("hex"));
    const lockPath = join(workspaceDir, ".store.lock");
    const nested = join(workspaceDir, "nested");
    const outside = join(root, "outside-workspace");
    await mkdir(nested);
    const markerPath = join(nested, ".gc-marker");
    const current = `${markerPath}.replace-00000000000000000002-current.committed`;
    const obsolete = `${markerPath}.replace-00000000000000000001-obsolete.bak`;
    await writeFile(current, "{}\n");
    await writeFile(obsolete, "do-not-delete\n");
    let obsoleteStats = 0;
    const replacementLstat: typeof originalLstat = (async (...args: Parameters<typeof originalLstat>) => {
      const info = await originalLstat(...args);
      if (String(args[0]) === obsolete && ++obsoleteStats === 3) armed = true;
      return info;
    }) as typeof originalLstat;
    const replacementReadFile: typeof originalReadFile = (async (...args: Parameters<typeof originalReadFile>) => {
      if (armed && !swapped && String(args[0]) === lockPath) {
        await fsp.rename(nested, outside);
        await symlink(outside, nested, process.platform === "win32" ? "junction" : "dir");
        swapped = true;
      }
      return originalReadFile(...args);
    }) as typeof originalReadFile;
    Reflect.set(fsp, "lstat", replacementLstat);
    Reflect.set(fsp, "readFile", replacementReadFile);
    syncBuiltinESMExports();

    await assert.rejects(
      store.cleanupRemnants(target.workspaceId, { apply: true }),
      /cleanup directory changed during scan/,
    );
    assert.equal(swapped, true);
    assert.equal(await readFile(join(outside, ".gc-marker.replace-00000000000000000001-obsolete.bak"), "utf8"), "do-not-delete\n");
  } finally {
    Reflect.set(fsp, "lstat", originalLstat);
    Reflect.set(fsp, "readFile", originalReadFile);
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup revalidates lease ownership immediately before each deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-cleanup-lease-fence-"));
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalLstat = fsp.lstat;
  let replaced = false;
  let lockPath = "";
  try {
    const store = new CompletionOutboxFileStore({ rootDir: root, ownerId: "cleanup-former" });
    await store.reserve(seed("cleanup-lease-fence"), 4_096);
    const { createHash } = await import("node:crypto");
    const workspaceDir = join(root, createHash("sha256").update(target.workspaceId, "utf8").digest("hex"));
    lockPath = join(workspaceDir, ".store.lock");
    const markerPath = join(workspaceDir, ".gc-marker");
    const current = `${markerPath}.replace-00000000000000000002-current.committed`;
    const obsolete = `${markerPath}.replace-00000000000000000001-obsolete.bak`;
    await writeFile(current, "{}\n");
    await writeFile(obsolete, "do-not-delete\n");
    let obsoleteStats = 0;
    const replacementLstat: typeof originalLstat = (async (...args: Parameters<typeof originalLstat>) => {
      const info = await originalLstat(...args);
      if (String(args[0]) === obsolete && ++obsoleteStats === 3) {
        await writeFile(lockPath, JSON.stringify({
          version: 2,
          ownerId: "cleanup-successor",
          token: "successor-token",
          pid: process.pid,
          heartbeatAt: Date.now(),
          generation: "00000000000000000099",
        }));
        replaced = true;
      }
      return info;
    }) as typeof originalLstat;
    Reflect.set(fsp, "lstat", replacementLstat);
    syncBuiltinESMExports();

    await assert.rejects(
      store.cleanupRemnants(target.workspaceId, { apply: true }),
      /lock ownership lost/,
    );
    assert.equal(replaced, true);
    assert.equal(await readFile(obsolete, "utf8"), "do-not-delete\n");
  } finally {
    Reflect.set(fsp, "lstat", originalLstat);
    syncBuiltinESMExports();
    if (lockPath) await rm(lockPath, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup dry-run reports busy when a writer generation overlaps the scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-cleanup-generation-fence-"));
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalReaddir = fsp.readdir;
  let overlapped = false;
  try {
    const store = new CompletionOutboxFileStore({ rootDir: root, ownerId: "cleanup-generation-fence" });
    await store.reserve(seed("cleanup-generation-fence"), 4_096);
    const { createHash } = await import("node:crypto");
    const workspaceDir = join(root, createHash("sha256").update(target.workspaceId, "utf8").digest("hex"));
    const lockPath = join(workspaceDir, ".store.lock");
    const markerPath = join(workspaceDir, ".gc-marker");
    const obsolete = `${markerPath}.replace-00000000000000000001-obsolete.bak`;
    await writeFile(`${markerPath}.replace-00000000000000000002-current.committed`, "{}\n");
    await writeFile(obsolete, "do-not-delete\n");
    const replacementReaddir: typeof originalReaddir = (async (...args: Parameters<typeof originalReaddir>) => {
      if (!overlapped && String(args[0]) === workspaceDir) {
        overlapped = true;
        await writeFile(lockPath, "writer-active\n");
        const entries = await originalReaddir(...args);
        await writeFile(join(workspaceDir, ".store-generation-a"), JSON.stringify({
          version: 1,
          generation: "00000000000000000099",
          token: "overlapping-writer",
        }));
        await rm(lockPath, { force: true });
        return entries;
      }
      return originalReaddir(...args);
    }) as typeof originalReaddir;
    Reflect.set(fsp, "readdir", replacementReaddir);
    syncBuiltinESMExports();

    const result = await store.cleanupRemnants(target.workspaceId);
    assert.equal(overlapped, true);
    assert.equal(result.busy, true);
    assert.equal(result.scannedEntries, 0);
    assert.equal(await readFile(obsolete, "utf8"), "do-not-delete\n");
  } finally {
    Reflect.set(fsp, "readdir", originalReaddir);
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup dry-run catches a writer that starts after its generation snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-cleanup-lock-order-"));
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalLstat = fsp.lstat;
  let started = false;
  let lockPath = "";
  try {
    const store = new CompletionOutboxFileStore({ rootDir: root, ownerId: "cleanup-lock-order" });
    await store.reserve(seed("cleanup-lock-order"), 4_096);
    const { createHash } = await import("node:crypto");
    const workspaceDir = join(root, createHash("sha256").update(target.workspaceId, "utf8").digest("hex"));
    lockPath = join(workspaceDir, ".store.lock");
    const replacementLstat: typeof originalLstat = (async (...args: Parameters<typeof originalLstat>) => {
      if (!started && String(args[0]) === lockPath) {
        started = true;
        await writeFile(lockPath, "writer-active\n");
      }
      return originalLstat(...args);
    }) as typeof originalLstat;
    Reflect.set(fsp, "lstat", replacementLstat);
    syncBuiltinESMExports();

    const result = await store.cleanupRemnants(target.workspaceId);
    assert.equal(started, true);
    assert.equal(result.busy, true);
    assert.equal(result.scannedEntries, 0);
  } finally {
    Reflect.set(fsp, "lstat", originalLstat);
    syncBuiltinESMExports();
    if (lockPath) await rm(lockPath, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
