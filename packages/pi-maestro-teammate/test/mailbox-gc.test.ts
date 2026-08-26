import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import {
  activateMailboxOwner,
  deactivateMailboxOwner,
  MailboxFileStore,
  computeEnvelopeHash,
  createMailboxPaths,
  ensureMailboxDirectories,
} from "../src/extension/mailbox/file-store.ts";
import { MailboxGC, QuotaAdmission } from "../src/extension/mailbox/gc.ts";
import {
  type MailboxClaim,
  type MailboxEnvelope,
  type MailboxOwnerFence,
  type MailboxPaths,
  type MailboxState,
  MAILBOX_SCHEMA_VERSION,
  QUOTA_HARD_TOTAL,
  QUOTA_NORMAL_MAX,
  TTL_DEAD_MS,
  TTL_NORMAL_MS,
  TTL_RECEIPT_MS,
  TTL_STAGING_MS,
} from "../src/extension/mailbox/types.ts";

const temporaryDirectories: string[] = [];
let nowMs: number;
let paths: MailboxPaths;
let store: MailboxFileStore;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "mailbox-gc-"));
  temporaryDirectories.push(base);
  paths = createMailboxPaths(join(base, "mailbox"));
  await ensureMailboxDirectories(paths);
  nowMs = 1_700_000_000_000;
  store = new MailboxFileStore({ paths, now: () => nowMs });
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

function messageId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function makeEnvelope(
  index: number,
  overrides: Partial<MailboxEnvelope> = {},
): MailboxEnvelope {
  const envelope: Omit<MailboxEnvelope, "hash"> = {
    messageId: messageId(index),
    schemaVersion: MAILBOX_SCHEMA_VERSION,
    workspaceId: "a".repeat(64),
    teamId: "team-root",
    senderId: "b".repeat(32),
    recipientId: "c".repeat(32),
    recipientCorrelationId: "corr-001",
    kind: "follow_up",
    mode: "follow_up",
    priority: "normal",
    senderSeq: index,
    createdAt: nowMs,
    expiresAt: nowMs + TTL_NORMAL_MS,
    ttlMs: TTL_NORMAL_MS,
    sessionGeneration: 1,
    leaseEpoch: 1,
    leaseNonce: "nonce-abc",
    payload: "payload",
    ...overrides,
  };
  const { hash: _hash, ...withoutHash } = envelope as MailboxEnvelope;
  return {
    ...withoutHash,
    hash: computeEnvelopeHash(withoutHash),
  } as MailboxEnvelope;
}

function makeClaim(id: string): MailboxClaim {
  return {
    messageId: id,
    claimerNonce: "claimer-nonce",
    claimedAt: nowMs,
    leaseExpiresAt: nowMs + 30_000,
    lastHeartbeatAt: nowMs,
  };
}

async function putInState(
  state: Exclude<MailboxState, "staging" | "rejected">,
  envelope: MailboxEnvelope,
): Promise<void> {
  const id = envelope.messageId;
  await store.writeStaging(envelope);
  await store.promoteToReady(id);
  if (state === "ready") return;
  if (state === "expired") {
    await store.expire(id);
    return;
  }
  if (state === "dead") {
    await store.dead(id, "ready", "test dead letter");
    return;
  }

  const claim = makeClaim(id);
  await store.claim(id, claim);
  if (state === "claimed") return;
  await store.accept(id, claim);
  if (state === "accepted") return;
  await store.apply(id);
}

function stateDirectory(state: "ready" | "claimed" | "accepted"): string {
  switch (state) {
    case "ready": return paths.readyDir;
    case "claimed": return paths.claimedDir;
    case "accepted": return paths.acceptedDir;
  }
}

async function writeEnvelopeDirect(
  state: "ready" | "claimed" | "accepted",
  envelope: MailboxEnvelope,
): Promise<void> {
  await writeFile(
    join(stateDirectory(state), `${envelope.messageId}.json`),
    `${JSON.stringify(envelope)}\n`,
  );
}

test("collectEligible reports stale staging and retained terminal messages", async () => {
  await putInState("applied", makeEnvelope(3));
  await putInState("expired", makeEnvelope(4));
  await putInState("dead", makeEnvelope(5));
  nowMs += TTL_DEAD_MS + 1;

  await store.writeStaging(makeEnvelope(1, {
    createdAt: nowMs - TTL_STAGING_MS - 1,
  }));
  await store.writeStaging(makeEnvelope(2, {
    createdAt: nowMs - TTL_STAGING_MS,
  }));

  const candidates = await new MailboxGC({ store, now: () => nowMs })
    .collectEligible();

  assert.deepEqual(
    candidates.map(({ state, messageId: id }) => [state, id]),
    [
      ["staging", messageId(1)],
      ["applied", messageId(3)],
      ["expired", messageId(4)],
      ["dead", messageId(5)],
    ],
  );
});

test("run removes stale staging and only applied receipts older than 24h", async () => {
  await putInState("applied", makeEnvelope(12));

  nowMs += TTL_RECEIPT_MS + 1;
  await store.writeStaging(makeEnvelope(10, {
    createdAt: nowMs - TTL_STAGING_MS - 1,
  }));
  await store.writeStaging(makeEnvelope(11, {
    createdAt: nowMs - TTL_STAGING_MS,
  }));
  await putInState("applied", makeEnvelope(13));

  const result = await new MailboxGC({ store, now: () => nowMs }).run();

  assert.deepEqual(result, { removed: 2, errors: [] });
  assert.equal(await store.readEnvelope("staging", messageId(10)), undefined);
  assert.ok(await store.readEnvelope("staging", messageId(11)));
  assert.equal(await store.readEnvelope("applied", messageId(12)), undefined);
  assert.ok(await store.readEnvelope("applied", messageId(13)));
});

test("in-flight GC commit is fenced when ownership reverses before the store mutation", async () => {
  await putInState("applied", makeEnvelope(14));
  nowMs += TTL_RECEIPT_MS + 1;
  const former: MailboxOwnerFence = {
    ownerId: "host-a",
    ownerNonce: "generation-a",
    sessionGeneration: 1,
    ownerPid: process.pid,
  };
  const replacement: MailboxOwnerFence = {
    ownerId: "host-b",
    ownerNonce: "generation-b",
    sessionGeneration: 2,
    ownerPid: process.pid,
  };
  let current = former;
  let entered!: () => void;
  let release!: () => void;
  const commitEntered = new Promise<void>((resolve) => { entered = resolve; });
  const commitRelease = new Promise<void>((resolve) => { release = resolve; });
  activateMailboxOwner(former);
  try {
    const formerSweep = new MailboxGC({
      store,
      now: () => nowMs,
      canMutate: () => true,
      mutationAuthority: {
        owner: former,
        isCurrent: async () => {
          entered();
          await commitRelease;
          return current === former;
        },
      },
    }).run();
    await commitEntered;
    deactivateMailboxOwner(former);
    activateMailboxOwner(replacement);
    current = replacement;
    release();

    assert.deepEqual(await formerSweep, { removed: 0, errors: [] });
    assert.ok(await store.readEnvelope("applied", messageId(14)), "former owner cannot delete after takeover");

    const replacementSweep = await new MailboxGC({
      store,
      now: () => nowMs,
      canMutate: () => true,
      mutationAuthority: {
        owner: replacement,
        isCurrent: () => current === replacement,
      },
    }).run();
    assert.equal(replacementSweep.removed, 1);
    assert.equal(await store.readEnvelope("applied", messageId(14)), undefined);
  } finally {
    release?.();
    deactivateMailboxOwner(former);
    deactivateMailboxOwner(replacement);
  }
});

test("run retains expired and dead messages for seven days", async () => {
  await putInState("expired", makeEnvelope(20));
  await putInState("dead", makeEnvelope(21));

  nowMs += TTL_DEAD_MS;
  let result = await new MailboxGC({ store, now: () => nowMs }).run();
  assert.deepEqual(result, { removed: 0, errors: [] });
  assert.ok(await store.readEnvelope("expired", messageId(20)));
  assert.ok(await store.readEnvelope("dead", messageId(21)));

  nowMs += 1;
  result = await new MailboxGC({ store, now: () => nowMs }).run();
  assert.deepEqual(result, { removed: 2, errors: [] });
  assert.equal(await store.readEnvelope("expired", messageId(20)), undefined);
  assert.equal(await store.readEnvelope("dead", messageId(21)), undefined);
});

test("run expires overdue ready messages without evicting inflight messages", async () => {
  const overdue = { expiresAt: nowMs - 1 };
  await putInState("ready", makeEnvelope(30, overdue));
  await putInState("claimed", makeEnvelope(31, overdue));
  await putInState("accepted", makeEnvelope(32, overdue));

  const result = await new MailboxGC({ store, now: () => nowMs }).run();

  assert.deepEqual(result, { removed: 0, errors: [] });
  assert.equal(await store.readEnvelope("ready", messageId(30)), undefined);
  assert.ok(await store.readEnvelope("expired", messageId(30)));
  assert.ok(await store.readEnvelope("claimed", messageId(31)));
  assert.ok(await store.readEnvelope("accepted", messageId(32)));
});

test("run records a removal error and continues with other candidates", async () => {
  await store.writeStaging(makeEnvelope(40, {
    createdAt: nowMs - TTL_STAGING_MS - 1,
  }));
  await store.writeStaging(makeEnvelope(41, {
    createdAt: nowMs - TTL_STAGING_MS - 1,
  }));

  const originalRemove = store.remove.bind(store);
  store.remove = async (state, id, mutationAuthority) => {
    if (id === messageId(40)) throw new Error("remove failed");
    return originalRemove(state, id, mutationAuthority);
  };

  const result = await new MailboxGC({ store, now: () => nowMs }).run();

  assert.equal(result.removed, 1);
  assert.deepEqual(result.errors, [
    `staging/${messageId(40)}: remove failed`,
  ]);
  assert.ok(await store.readEnvelope("staging", messageId(40)));
  assert.equal(await store.readEnvelope("staging", messageId(41)), undefined);
});

test("quota reserves the final slots for critical messages", async () => {
  // Use small quota for fast testing: normalMax=4, hardTotal=6
  const normalMax = 4;
  const hardTotal = 6;
  const writes: Promise<void>[] = [];
  for (let index = 1; index <= normalMax; index += 1) {
    const state = index <= 2 ? "ready" : "claimed";
    writes.push(writeEnvelopeDirect(state, makeEnvelope(index)));
  }
  await Promise.all(writes);

  const quota = new QuotaAdmission({ store, hardTotal, normalMax });
  assert.deepEqual(await quota.check("normal"), {
    allowed: false,
    code: "quota_exceeded",
    live: normalMax,
  });
  assert.deepEqual(await quota.check("high"), {
    allowed: false,
    code: "quota_exceeded",
    live: normalMax,
  });
  assert.deepEqual(await quota.check("critical"), {
    allowed: true,
    live: normalMax,
  });

  const criticalWrites: Promise<void>[] = [];
  for (let index = normalMax + 1; index <= hardTotal; index += 1) {
    criticalWrites.push(writeEnvelopeDirect("ready", makeEnvelope(index, {
      kind: "control",
      mode: "notify",
      priority: "critical",
    })));
  }
  await Promise.all(criticalWrites);

  assert.deepEqual(await quota.check("critical"), {
    allowed: false,
    code: "quota_exceeded",
    live: hardTotal,
  });
});

test("quota admits normal messages below the reserve boundary", async () => {
  await writeEnvelopeDirect("ready", makeEnvelope(600));

  assert.deepEqual(await new QuotaAdmission({ store }).check("normal"), {
    allowed: true,
    live: 1,
  });
});

// --- Orphan state record cleanup ---

test("run removes orphaned state records without an envelope", async () => {
  // Write a full envelope into dead, then remove only the envelope to create an orphan record
  const env = makeEnvelope(700);
  await putInState("dead", env);
  await store.remove("dead", env.messageId); // removes envelope + its state.json together
  // Now simulate an interrupted transition: write a state record with no envelope
  const orphanId = messageId(701);
  const orphanRecord = {
    messageId: orphanId,
    state: "dead" as const,
    transitionedAt: nowMs,
    previousState: "ready" as const,
    reason: "orphan",
  };
  await writeFile(join(paths.deadDir, `${orphanId}.state.json`), JSON.stringify(orphanRecord) + "\n");

  const result = await new MailboxGC({ store, now: () => nowMs }).run();
  assert.ok(result.removed >= 1);
  assert.deepEqual(result.errors, []);

  // Orphan state record is gone
  const orphans = await store.listOrphanStateRecords("dead");
  assert.ok(!orphans.includes(orphanId));
});

test("listOrphanStateRecords detects records without envelopes", async () => {
  const env = makeEnvelope(710);
  await putInState("dead", env);

  // No orphans initially
  assert.deepEqual(await store.listOrphanStateRecords("dead"), []);

  // Remove envelope only — but store.remove removes both. Simulate by writing
  // a state record for an ID with no envelope.
  const orphanId = messageId(711);
  const orphanRecord = {
    messageId: orphanId,
    state: "dead" as const,
    transitionedAt: nowMs,
    previousState: "ready" as const,
  };
  await writeFile(join(paths.deadDir, `${orphanId}.state.json`), JSON.stringify(orphanRecord) + "\n");

  const orphans = await store.listOrphanStateRecords("dead");
  assert.ok(orphans.includes(orphanId));
  assert.ok(!orphans.includes(env.messageId));
});

test("orphan state records in live directories are cleaned too", async () => {
  const orphanId = messageId(720);
  const orphanRecord = {
    messageId: orphanId,
    state: "accepted" as const,
    transitionedAt: nowMs,
    previousState: "claimed" as const,
  };
  await writeFile(join(paths.acceptedDir, `${orphanId}.state.json`), JSON.stringify(orphanRecord) + "\n");

  const result = await new MailboxGC({ store, now: () => nowMs }).run();
  assert.ok(result.removed >= 1);
  assert.deepEqual(await store.listOrphanStateRecords("accepted"), []);
});
