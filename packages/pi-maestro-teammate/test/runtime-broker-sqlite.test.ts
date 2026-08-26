import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  RuntimeBrokerError,
  assertJsonValue,
  type RuntimeBrokerCommitRequest,
} from "../src/runtime-broker/contracts.ts";
import {
  RuntimeBrokerSqliteStore,
  type RuntimeBrokerSqliteStoreOptions,
} from "../src/runtime-broker/sqlite-store.ts";
import {
  RUNTIME_READ_MODEL_FRAME_EVENT,
  rebuildRuntimeReadModelFromBrokerFramesV2,
  type RuntimeReadModelSourceFrameV2,
} from "../src/runtime-v2/read-model.ts";

function withDatabase(
  run: (store: RuntimeBrokerSqliteStore, path: string) => void,
  options: RuntimeBrokerSqliteStoreOptions = {},
): void {
  const directory = mkdtempSync(join(tmpdir(), "runtime-broker-sqlite-"));
  const path = join(directory, "broker.sqlite");
  const store = new RuntimeBrokerSqliteStore(path, options);
  try {
    run(store, path);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function hasCode(code: RuntimeBrokerError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof RuntimeBrokerError && error.code === code;
}

function expectSchemaRejected(
  setup: (database: DatabaseSync) => void,
  pattern: RegExp,
): void {
  const directory = mkdtempSync(join(tmpdir(), "runtime-broker-invalid-schema-"));
  const path = join(directory, "broker.sqlite");
  const database = new DatabaseSync(path);
  try {
    setup(database);
  } finally {
    database.close();
  }
  try {
    assert.throws(() => new RuntimeBrokerSqliteStore(path), pattern);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function createMetadata(database: DatabaseSync, value: string, userVersion: number): void {
  database.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
  database.prepare("INSERT INTO metadata (key, value) VALUES ('schema_version', ?)").run(value);
  database.exec(`PRAGMA user_version = ${userVersion}`);
}

function downgradeSchemaV3ToV2(database: DatabaseSync): void {
  database.exec(`
    DROP TRIGGER streams_workspace_immutable;
    DROP INDEX streams_workspace_stream_idx;
    DROP INDEX actor_leases_stream_id_uq;
    DROP INDEX mutation_receipts_created_idx;
    DROP TABLE mutation_receipts;
    ALTER TABLE streams DROP COLUMN workspace_id;
    UPDATE metadata SET value = '2' WHERE key = 'schema_version';
    PRAGMA user_version = 2;
  `);
}

function runtimePayload(streamId: string, workspaceId: string, sequence: number, eventId: string) {
  return {
    version: 2,
    revision: 1,
    streamId,
    actor: { version: 2, revision: 1, workspaceId, actorKind: "schedule", actorId: streamId, generation: 1 },
    sequence,
    producerEpoch: 1,
    occurredAt: sequence,
    kind: "domain.event",
    eventType: "schedule.created",
    eventId,
    payload: {},
  } as const;
}

function requestFor(lease: { epoch: number; nonce: string }): RuntimeBrokerCommitRequest {
  return {
    messageId: "message-1",
    actorId: "actor-1",
    lease,
    streamId: "stream-1",
    expectedRevision: 0,
    committedAt: 999_999,
    events: [{
      eventId: "event-1",
      eventType: "run.started",
      payload: { runId: "run-1" },
      correlationId: "correlation-1",
    }],
    outbox: [{
      outboxId: "outbox-1",
      eventId: "event-1",
      destination: "actor-2",
      payload: { action: "observe" },
    }],
    projections: [{
      projectionId: "run-1",
      value: { lifecycle: "running" },
    }],
    inboxResult: { accepted: true },
  };
}

test("SQLite store enables WAL and explicitly migrates an empty database to schema v3", () => {
  withDatabase((store, path) => {
    assert.equal(store.journalMode.toLowerCase(), "wal");
    assert.deepEqual(store.tableNames(), [
      "actor_leases",
      "events",
      "inbox",
      "metadata",
      "mutation_receipts",
      "outbox",
      "projections",
      "streams",
    ]);
    const inspection = new DatabaseSync(path);
    try {
      assert.equal(inspection.prepare("PRAGMA user_version").get()!.user_version, 3);
      assert.equal(
        inspection.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()!.value,
        "3",
      );
      assert.deepEqual(
        inspection.prepare("PRAGMA index_info(streams_workspace_stream_idx)").all().map((row) => row.name),
        ["workspace_id", "stream_id"],
      );
    } finally {
      inspection.close();
    }
  });
});

test("SQLite store rejects the actual non-WAL journal mode", () => {
  assert.throws(
    () => new RuntimeBrokerSqliteStore(":memory:"),
    /requires WAL journal mode; received memory/,
  );
});

test("SQLite store rejects malformed, inconsistent, newer, and structurally incompatible schemas", () => {
  for (const value of ["invalid", "-1", "1.5", "01"]) {
    expectSchemaRejected(
      (database) => createMetadata(database, value, 0),
      /metadata\.schema_version must be a canonical non-negative integer/,
    );
  }
  expectSchemaRejected(
    (database) => createMetadata(database, "1", 0),
    /does not match user_version/,
  );
  expectSchemaRejected(
    (database) => createMetadata(database, "4", 4),
    /version 4 is newer than supported 3/,
  );
  expectSchemaRejected((database) => {
    createMetadata(database, "1", 1);
    database.exec("CREATE TABLE actor_leases (actor_id TEXT PRIMARY KEY) STRICT");
  }, /table actor_leases has incompatible columns/);
});

test("stream listing is workspace-scoped, prefix-bounded, keyset-paged, and ownership is immutable", () => {
  withDatabase((store, path) => {
    const append = (streamId: string, workspaceId: string, suffix: string) => {
      const lease = store.acquireLease({ actorId: streamId, streamId, holderId: "holder", ttlMs: 1_000 });
      store.commit({
        messageId: `message-${suffix}`,
        actorId: streamId,
        lease,
        streamId,
        expectedRevision: 0,
        events: [{
          eventId: `event-${suffix}`,
          eventType: "domain.event",
          payload: {
            version: 2,
            revision: 1,
            streamId,
            actor: { version: 2, revision: 1, workspaceId, actorKind: "schedule", actorId: streamId, generation: 1 },
            sequence: 1,
            producerEpoch: 1,
            occurredAt: 1,
            kind: "domain.event",
            eventType: "schedule.created",
            eventId: `flow-${suffix}`,
            payload: {},
          },
        }],
      });
    };
    append("flow-schedule/schedule/a", "workspace-a", "a");
    append("flow-schedule/schedule/b", "workspace-a", "b");
    append("flow-schedule/schedule/c", "workspace-b", "c");
    append("flow-schedule/dispatch/d", "workspace-a", "d");

    const first = store.listStreams({ workspaceId: "workspace-a", prefix: "flow-schedule/schedule/", limit: 1 });
    assert.deepEqual(first, ["flow-schedule/schedule/a"]);
    assert.deepEqual(store.listStreams({
      workspaceId: "workspace-a",
      prefix: "flow-schedule/schedule/",
      afterStreamId: first[0],
      limit: 1,
    }), ["flow-schedule/schedule/b"]);
    assert.deepEqual(store.listStreams({ workspaceId: "workspace-b", prefix: "flow-schedule/schedule/", limit: 10 }), [
      "flow-schedule/schedule/c",
    ]);
    const inspection = new DatabaseSync(path);
    try {
      assert.throws(
        () => inspection.prepare("UPDATE streams SET workspace_id = 'workspace-b' WHERE stream_id = 'flow-schedule/schedule/a'").run(),
        /workspace ownership is immutable/,
      );
    } finally {
      inspection.close();
    }
  });
});

test("SQLite stream owner ignores mailbox events and rejects mixed Runtime workspaces", () => {
  withDatabase((store) => {
    const streamId = "flow-schedule/schedule/shared";
    const lease = store.acquireLease({ actorId: streamId, streamId, holderId: "holder", ttlMs: 1_000 });
    store.commit({
      messageId: "mailbox-message",
      actorId: streamId,
      lease,
      streamId,
      expectedRevision: 0,
      events: [{
        eventId: "mailbox-event",
        eventType: "mailbox.applied",
        payload: { kind: "mailbox.applied", mailboxId: "mailbox-a" },
      }],
    });
    assert.deepEqual(store.listStreams({ workspaceId: "workspace-a", prefix: "flow-schedule/schedule/", limit: 10 }), []);

    const runtimePayload = (workspaceId: string, sequence: number) => ({
      version: 2,
      revision: 1,
      streamId,
      actor: { version: 2, revision: 1, workspaceId, actorKind: "schedule", actorId: streamId, generation: 1 },
      sequence,
      producerEpoch: 1,
      occurredAt: sequence,
      kind: "domain.event",
      eventType: "schedule.created",
      eventId: `flow-${sequence}`,
      payload: {},
    }) as const;
    store.commit({
      messageId: "runtime-message-a",
      actorId: streamId,
      lease,
      streamId,
      expectedRevision: 1,
      events: [{ eventId: "runtime-event-a", eventType: "domain.event", payload: runtimePayload("workspace-a", 2) }],
    });
    assert.deepEqual(store.listStreams({ workspaceId: "workspace-a", prefix: "flow-schedule/schedule/", limit: 10 }), [streamId]);

    assert.throws(() => store.commit({
      messageId: "runtime-message-wrong-stream",
      actorId: streamId,
      lease,
      streamId,
      expectedRevision: 2,
      events: [{
        eventId: "runtime-event-wrong-stream",
        eventType: "domain.event",
        payload: { ...runtimePayload("workspace-a", 99), streamId: "flow-schedule/schedule/other" },
      }],
    }), hasCode("invalid_request"));

    assert.throws(() => store.commit({
      messageId: "runtime-message-b",
      actorId: streamId,
      lease,
      streamId,
      expectedRevision: 2,
      events: [{ eventId: "runtime-event-b", eventType: "domain.event", payload: runtimePayload("workspace-b", 3) }],
    }), hasCode("invalid_request"));
    assert.equal(store.readEvents(streamId).length, 2);
    assert.deepEqual(store.listStreams({ workspaceId: "workspace-b", prefix: "flow-schedule/schedule/", limit: 10 }), []);
  });
});

test("commit atomically applies event, outbox, projection, stream, and inbox using broker time", () => {
  let now = 10;
  withDatabase((store, path) => {
    const lease = store.acquireLease({ actorId: "actor-1", streamId: "stream-1", holderId: "broker-1", ttlMs: 1_000, now: 8_000 });
    assert.equal(lease.acquiredAt, 10);
    now = 20;
    const result = store.commit(requestFor(lease));

    assert.deepEqual(result, {
      messageId: "message-1",
      streamId: "stream-1",
      previousRevision: 0,
      revision: 1,
      eventIds: ["event-1"],
      eventCursors: [1],
      outboxIds: ["outbox-1"],
      appliedAt: 20,
      recovered: false,
      reply: { accepted: true },
    });
    assert.equal(store.getStreamRevision("stream-1"), 1);
    assert.deepEqual(store.readEvents("stream-1"), [{
      eventId: "event-1",
      messageId: "message-1",
      streamId: "stream-1",
      revision: 1,
      eventType: "run.started",
      payload: { runId: "run-1" },
      producerEpoch: 1,
      occurredAt: 20,
      correlationId: "correlation-1",
    }]);
    assert.deepEqual(store.readProjection("run-1"), {
      streamId: "stream-1",
      revision: 1,
      value: { lifecycle: "running" },
      updatedAt: 20,
    });
    assert.deepEqual(store.listPendingOutbox(10, 20), [{
      outboxId: "outbox-1",
      messageId: "message-1",
      eventId: "event-1",
      destination: "actor-2",
      payload: { action: "observe" },
      createdAt: 20,
      availableAt: 20,
      attempts: 0,
    }]);
    const inspection = new DatabaseSync(path, { readOnly: true });
    try {
      const inbox = inspection.prepare(
        "SELECT applied_revision, applied_at FROM inbox WHERE message_id = ?",
      ).get("message-1") as { applied_revision: number; applied_at: number };
      const event = inspection.prepare(
        "SELECT revision, producer_epoch FROM events WHERE event_id = ?",
      ).get("event-1") as { revision: number; producer_epoch: number };
      assert.equal(inbox.applied_revision, 1);
      assert.equal(inbox.applied_at, 20);
      assert.equal(event.revision, 1);
      assert.equal(event.producer_epoch, 1);
    } finally {
      inspection.close();
    }
  }, { now: () => now });
});

test("schema v1 migrates transactionally to v3 without losing durable broker state", () => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-broker-migrate-v1-"));
  const path = join(directory, "broker.sqlite");
  let store = new RuntimeBrokerSqliteStore(path, { now: () => 10 });
  try {
    const lease = store.acquireLease({
      actorId: "actor-1",
      streamId: "stream-1",
      holderId: "broker-1",
      ttlMs: 1_000,
    });
    store.commit(requestFor(lease));
    store.close();

    const v1 = new DatabaseSync(path);
    try {
      downgradeSchemaV3ToV2(v1);
      v1.exec(`
        ALTER TABLE actor_leases RENAME TO actor_leases_v2;
        CREATE TABLE actor_leases (
          actor_id TEXT PRIMARY KEY,
          holder_id TEXT NOT NULL,
          epoch INTEGER NOT NULL CHECK (epoch > 0),
          nonce TEXT NOT NULL,
          acquired_at INTEGER NOT NULL,
          heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        ) STRICT;
        INSERT INTO actor_leases
          SELECT actor_id, holder_id, epoch, nonce, acquired_at, heartbeat_at, expires_at
          FROM actor_leases_v2;
        DROP TABLE actor_leases_v2;
        UPDATE metadata SET value = '1' WHERE key = 'schema_version';
        PRAGMA user_version = 1;
      `);
    } finally {
      v1.close();
    }

    store = new RuntimeBrokerSqliteStore(path, { now: () => 20 });
    assert.equal(store.getLease("actor-1"), undefined);
    const replacement = store.acquireLease({
      actorId: "actor-1",
      holderId: "broker-2",
      ttlMs: 1_000,
    });
    assert.equal(replacement.epoch, lease.epoch + 1);
    assert.equal(store.getStreamRevision("stream-1"), 1);
    assert.equal(store.readEvents("stream-1").length, 1);
    assert.equal(store.listPendingOutbox(10, 20).length, 1);
    assert.deepEqual(store.readProjection("run-1")?.value, { lifecycle: "running" });
    const inspection = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM inbox").get()!.count, 1);
      assert.equal(inspection.prepare("PRAGMA user_version").get()!.user_version, 3);
      assert.equal(
        inspection.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()!.value,
        "3",
      );
    } finally {
      inspection.close();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v2 migration invalidates every duplicate stream lease and backfills indexed workspace ownership", () => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-broker-migrate-v2-"));
  const path = join(directory, "broker.sqlite");
  let store = new RuntimeBrokerSqliteStore(path, { now: () => 10 });
  try {
    const streamId = "flow-schedule/schedule/shared";
    const lease = store.acquireLease({ actorId: "actor-a", streamId, holderId: "holder-a", ttlMs: 1_000 });
    store.commit({
      messageId: "message-a",
      actorId: "actor-a",
      lease,
      streamId,
      expectedRevision: 0,
      events: [{ eventId: "event-a", eventType: "domain.event", payload: runtimePayload(streamId, "workspace-a", 1, "domain-a") }],
    });
    store.close();

    const v2 = new DatabaseSync(path);
    try {
      downgradeSchemaV3ToV2(v2);
      v2.prepare(`
        INSERT INTO actor_leases
          (actor_id, stream_id, holder_id, epoch, nonce, acquired_at, heartbeat_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("actor-b", streamId, "holder-b", 7, "nonce-b", 10, 10, 1_010);
    } finally {
      v2.close();
    }

    store = new RuntimeBrokerSqliteStore(path, { now: () => 20 });
    assert.equal(store.getLease("actor-a"), undefined);
    assert.equal(store.getLease("actor-b"), undefined);
    assert.throws(
      () => store.heartbeatLease({ actorId: "actor-a", lease, ttlMs: 100 }),
      hasCode("stale_lease"),
    );
    assert.throws(
      () => store.heartbeatLease({ actorId: "actor-b", lease: { epoch: 7, nonce: "nonce-b" }, ttlMs: 100 }),
      hasCode("stale_lease"),
    );
    assert.deepEqual(store.listStreams({
      workspaceId: "workspace-a",
      prefix: "flow-schedule/schedule/",
      limit: 10,
    }), [streamId]);
    const replacement = store.acquireLease({ actorId: "actor-c", streamId, holderId: "holder-c", ttlMs: 100 });
    assert.equal(replacement.actorId, "actor-c");
    assert.equal(replacement.epoch, 8);
    const inspection = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM actor_leases WHERE stream_id = ?").get(streamId)!.count, 1);
      assert.equal(inspection.prepare("SELECT workspace_id FROM streams WHERE stream_id = ?").get(streamId)!.workspace_id, "workspace-a");
    } finally {
      inspection.close();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v2 ownership conflicts abort and roll back the entire v3 migration", () => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-broker-migrate-conflict-"));
  const path = join(directory, "broker.sqlite");
  const streamId = "flow-schedule/schedule/conflict";
  const store = new RuntimeBrokerSqliteStore(path, { now: () => 10 });
  try {
    const lease = store.acquireLease({ actorId: "actor", streamId, holderId: "holder", ttlMs: 1_000 });
    store.commit({
      messageId: "message-a",
      actorId: "actor",
      lease,
      streamId,
      expectedRevision: 0,
      events: [{ eventId: "event-a", eventType: "domain.event", payload: runtimePayload(streamId, "workspace-a", 1, "domain-a") }],
    });
    store.commit({
      messageId: "message-b",
      actorId: "actor",
      lease,
      streamId,
      expectedRevision: 1,
      events: [{ eventId: "event-b", eventType: "mailbox.applied", payload: { kind: "mailbox.applied" } }],
    });
  } finally {
    store.close();
  }
  const v2 = new DatabaseSync(path);
  try {
    downgradeSchemaV3ToV2(v2);
    v2.prepare("UPDATE events SET event_type = 'domain.event', payload_json = ? WHERE event_id = 'event-b'")
      .run(JSON.stringify(runtimePayload(streamId, "workspace-b", 2, "domain-b")));
  } finally {
    v2.close();
  }

  try {
    assert.throws(
      () => new RuntimeBrokerSqliteStore(path, { now: () => 20 }),
      /conflicting workspace ownership/,
    );
    const inspection = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(inspection.prepare("PRAGMA user_version").get()!.user_version, 2);
      assert.equal(
        inspection.prepare("PRAGMA table_info(streams)").all().some((row) => row.name === "workspace_id"),
        false,
      );
      assert.equal(inspection.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'mutation_receipts'").get(), undefined);
    } finally {
      inspection.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lease stream binding fences commits and authorized replay", () => {
  withDatabase((store) => {
    const lease = store.acquireLease({
      actorId: "actor-1",
      streamId: "stream-1",
      holderId: "broker-1",
      ttlMs: 1_000,
    });
    assert.throws(
      () => store.commit({ ...requestFor(lease), streamId: "stream-2" }),
      hasCode("stale_lease"),
    );
    store.commit(requestFor(lease));
    assert.throws(
      () => store.readAuthorizedEvents("stream-2", 0, { actorId: "actor-1", lease }),
      hasCode("stale_lease"),
    );
    assert.equal(
      store.readAuthorizedEvents("stream-1", 0, { actorId: "actor-1", lease }).length,
      1,
    );
  }, { now: () => 10 });
});

test("projection ownership is fenced to its original stream", () => {
  withDatabase((store) => {
    const firstLease = store.acquireLease({ actorId: "actor-a", streamId: "stream-a", holderId: "holder-a", ttlMs: 1_000 });
    const secondLease = store.acquireLease({ actorId: "actor-b", streamId: "stream-b", holderId: "holder-b", ttlMs: 1_000 });
    store.commit({
      messageId: "message-a",
      actorId: "actor-a",
      lease: firstLease,
      streamId: "stream-a",
      expectedRevision: 0,
      events: [{ eventId: "event-a", eventType: "state.changed", payload: {} }],
      projections: [{ projectionId: "shared-projection", value: { owner: "a" } }],
    });
    assert.throws(() => store.commit({
      messageId: "message-b",
      actorId: "actor-b",
      lease: secondLease,
      streamId: "stream-b",
      expectedRevision: 0,
      events: [{ eventId: "event-b", eventType: "state.changed", payload: {} }],
      projections: [{ projectionId: "shared-projection", value: { owner: "b" } }],
    }), hasCode("idempotency_conflict"));
    assert.deepEqual(store.readProjection("shared-projection"), {
      streamId: "stream-a",
      revision: 1,
      value: { owner: "a" },
      updatedAt: 10,
    });
    assert.equal(store.getStreamRevision("stream-b"), 0);
    assert.deepEqual(store.readEvents("stream-b"), []);
  }, { now: () => 10 });
});

test("expired lease owners cannot backdate committedAt to authorize a commit", () => {
  let now = 10;
  withDatabase((store) => {
    const lease = store.acquireLease({ actorId: "actor-1", streamId: "stream-1", holderId: "broker-1", ttlMs: 100, now: 50_000 });
    now = 20;
    const wrongRevision = { ...requestFor(lease), expectedRevision: 4 };
    assert.throws(() => store.commit(wrongRevision), hasCode("revision_conflict"));
    assert.equal(store.getStreamRevision("stream-1"), 0);
    assert.deepEqual(store.readEvents("stream-1"), []);
    assert.deepEqual(store.listPendingOutbox(10, 20), []);
    assert.equal(store.readProjection("run-1"), undefined);

    now = 111;
    const backdated = { ...requestFor(lease), committedAt: 20 };
    assert.throws(() => store.commit(backdated), hasCode("stale_lease"));
    assert.equal(store.getStreamRevision("stream-1"), 0);
    assert.deepEqual(store.readEvents("stream-1"), []);
  }, { now: () => now });
});

test("commit-before-reply is recovered by messageId after restart and lease change", () => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-broker-restart-"));
  const path = join(directory, "broker.sqlite");
  let now = 10;
  let first = new RuntimeBrokerSqliteStore(path, { now: () => now });
  try {
    const lease = first.acquireLease({ actorId: "actor-1", streamId: "stream-1", holderId: "broker-1", ttlMs: 100, now: 50_000 });
    const request = requestFor(lease);
    now = 20;
    const committed = first.commit(request);
    assert.equal(committed.recovered, false);
    first.close();

    now = 5_000;
    const restarted = new RuntimeBrokerSqliteStore(path, { now: () => now });
    first = restarted;
    const nextLease = restarted.acquireLease({
      actorId: "actor-1",
      streamId: "stream-1",
      holderId: "broker-2",
      ttlMs: 100,
      now: 5_000,
    });
    const recovered = restarted.commit(request);
    assert.deepEqual(recovered, { ...committed, recovered: true });
    assert.deepEqual(
      restarted.commit({ ...request, lease: nextLease, committedAt: 5_000 }),
      { ...committed, recovered: true },
    );
    assert.equal(nextLease.epoch, lease.epoch + 1);
    assert.equal(restarted.getStreamRevision("stream-1"), 1);
    assert.equal(restarted.readEvents("stream-1").length, 1);
  } finally {
    first.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("read-model journal query returns workspace-filtered global monotonic cursors", () => {
  let now = 10;
  withDatabase((store, path) => {
    const leaseA = store.acquireLease({ actorId: "window-a", holderId: "broker-a", ttlMs: 1_000 });
    const leaseB = store.acquireLease({ actorId: "window-b", holderId: "broker-b", ttlMs: 1_000 });
    const readEvent = (workspaceId: string, streamId: string, sequence: number, eventId: string) => ({
      version: 2,
      revision: 1,
      streamId,
      sequence,
      actor: { version: 2, revision: 1, workspaceId, actorKind: "root", actorId: streamId, generation: 1 },
      occurredAt: now,
      kind: "domain.event",
      eventType: "teammate.runtime-read-model.frame.v2",
      eventId,
      payload: {
        version: 2,
        revision: 1,
        kind: "agent-runs-source-frame",
        source: { streamId, revision: sequence, generation: 1 },
        batchId: `${streamId}:${sequence}`,
        batchIndex: 0,
        batchCount: 1,
        reset: sequence === 1,
        changes: [],
      },
    });
    const first = readEvent("workspace-a", "window-a", 1, "read-a-1");
    store.commit({
      messageId: "read-message-a",
      actorId: "window-a",
      lease: leaseA,
      streamId: "window-a",
      expectedRevision: 0,
      events: [{ eventId: first.eventId, eventType: first.kind, payload: first }],
    });
    now += 1;
    const foreign = readEvent("workspace-b", "window-b", 1, "read-b-1");
    store.commit({
      messageId: "read-message-b",
      actorId: "window-b",
      lease: leaseB,
      streamId: "window-b",
      expectedRevision: 0,
      events: [{ eventId: foreign.eventId, eventType: foreign.kind, payload: foreign }],
    });

    now += 1;
    const second = readEvent("workspace-a", "window-a", 2, "read-a-2");
    store.commit({
      messageId: "read-message-a-2",
      actorId: "window-a",
      lease: leaseA,
      streamId: "window-a",
      expectedRevision: 1,
      events: [{ eventId: second.eventId, eventType: second.kind, payload: second }],
    });

    const workspaceA = store.readRuntimeReadModelEvents("workspace-a");
    assert.deepEqual(workspaceA.map((event) => event.cursor), [1, 3]);
    assert.deepEqual(store.readRuntimeReadModelEvents("workspace-a", 0, 1).map((event) => event.cursor), [1]);
    assert.deepEqual(store.readRuntimeReadModelEvents("workspace-a", 1, 1).map((event) => event.cursor), [3]);
    assert.deepEqual(store.readRuntimeReadModelEvents("workspace-a", 3), []);
    assert.equal(store.readRuntimeReadModelEvents("workspace-b")[0]?.cursor, 2);
    assert.deepEqual(store.readRuntimeReadModelSources("workspace-a"), [{
      streamId: "window-a",
      generation: leaseA.epoch,
      active: true,
    }]);

    const inspection = new DatabaseSync(path);
    try {
      inspection.prepare("UPDATE events SET payload_json = ? WHERE event_id = ?")
        .run(JSON.stringify({ ...first, actor: { ...first.actor, workspaceId: "workspace-b" } }), first.eventId);
    } finally {
      inspection.close();
    }
    assert.deepEqual(store.readRuntimeReadModelEvents("workspace-b").map((event) => event.cursor), [2]);
    assert.deepEqual(store.readRuntimeReadModelEvents("workspace-a").map((event) => event.cursor), [3]);

    now = 2_000;
    assert.equal(store.readRuntimeReadModelSources("workspace-a")[0]?.active, false);
  }, { now: () => now });
});

test("messageId and eventId idempotency keys cannot be reused with different content", () => {
  let now = 10;
  withDatabase((store) => {
    const lease = store.acquireLease({ actorId: "actor-1", streamId: "stream-1", holderId: "broker-1", ttlMs: 1_000, now: 99_999 });
    const request = requestFor(lease);
    now = 20;
    store.commit(request);

    assert.throws(
      () => store.commit({ ...request, events: [{ ...request.events[0]!, payload: { runId: "different" } }] }),
      hasCode("idempotency_conflict"),
    );
    assert.throws(
      () => store.commit({
        ...request,
        messageId: "message-2",
        expectedRevision: 1,
        outbox: [],
        projections: [],
      }),
      hasCode("idempotency_conflict"),
    );
    assert.equal(store.getStreamRevision("stream-1"), 1);
  }, { now: () => now });
});

test("shortened capacity burst sustains 16 windows and 128 observable runs with projection rebuild", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-broker-capacity-"));
  const databasePath = join(directory, "broker.sqlite");
  const workspaceId = "c".repeat(64);
  const windowCount = 16;
  const runCount = 128;
  let store: RuntimeBrokerSqliteStore | undefined = new RuntimeBrokerSqliteStore(databasePath);
  try {
    const leases = Array.from({ length: windowCount }, (_, index) => store!.acquireLease({
      actorId: `window-${index}`,
      streamId: `runtime-read-model:${workspaceId}:window-${index}`,
      holderId: `host-${index}`,
      ttlMs: 60_000,
    }));
    const revisions = Array<number>(windowCount).fill(0);
    const commitLatencies: number[] = [];
    const burstStartedAt = performance.now();

    for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
      const windowIndex = runIndex % windowCount;
      const streamId = `runtime-read-model:${workspaceId}:window-${windowIndex}`;
      const sourceRevision = revisions[windowIndex]! + 1;
      const frame: RuntimeReadModelSourceFrameV2 = {
        version: 2,
        revision: 1,
        kind: "agent-runs-source-frame",
        source: { streamId, revision: sourceRevision, generation: leases[windowIndex]!.epoch },
        batchId: `window-${windowIndex}-run-${runIndex}`,
        batchIndex: 0,
        batchCount: 1,
        reset: sourceRevision === 1,
        changes: [{
          kind: "upsert",
          entity: {
            correlationId: `run-${runIndex}`,
            generation: 1,
            agent: "general",
            status: "running",
            startedAt: runIndex,
            lastActivityAt: runIndex,
          },
        }],
      };
      const runtimeEvent = {
        version: 2,
        revision: 1,
        streamId,
        sequence: sourceRevision,
        actor: {
          version: 2,
          revision: 1,
          workspaceId,
          actorKind: "root",
          actorId: `window-${windowIndex}`,
          generation: leases[windowIndex]!.epoch,
        },
        occurredAt: runIndex,
        kind: "domain.event",
        eventType: RUNTIME_READ_MODEL_FRAME_EVENT,
        eventId: `runtime-event-${runIndex}`,
        payload: frame,
      };
      const commitStartedAt = performance.now();
      assertJsonValue(runtimeEvent, "runtimeEvent");
      store.commit({
        messageId: `message-${runIndex}`,
        actorId: `window-${windowIndex}`,
        lease: leases[windowIndex]!,
        streamId,
        expectedRevision: revisions[windowIndex]!,
        events: [{
          eventId: runtimeEvent.eventId,
          eventType: "domain.event",
          payload: runtimeEvent,
        }],
        projections: [{ projectionId: `run-${runIndex}`, value: { status: "running" } }],
        inboxResult: { accepted: true },
      });
      commitLatencies.push(performance.now() - commitStartedAt);
      revisions[windowIndex] = sourceRevision;
    }

    const burstMs = performance.now() - burstStartedAt;
    const eventsPerSecond = runCount * 1_000 / burstMs;
    const sortedLatencies = [...commitLatencies].sort((left, right) => left - right);
    const p95Ms = sortedLatencies[Math.ceil(sortedLatencies.length * 0.95) - 1]!;
    const beforeEvents = store.readRuntimeReadModelEvents(workspaceId, 0, 512);
    assert.equal(beforeEvents.length, runCount);
    const beforeSnapshot = rebuildRuntimeReadModelFromBrokerFramesV2(
      workspaceId,
      beforeEvents.map((event) => ({
        cursor: event.cursor,
        frame: (event.payload as unknown as { payload: RuntimeReadModelSourceFrameV2 }).payload,
      })),
    ).projection.snapshot();
    assert.equal(beforeSnapshot.agents.length, runCount);
    assert.ok(store.readProjection("run-0"));

    store.close();
    store = undefined;
    const inspection = new DatabaseSync(databasePath);
    try {
      assert.equal(Number(inspection.prepare("DELETE FROM projections").run().changes), runCount);
    } finally {
      inspection.close();
    }

    const restartStartedAt = performance.now();
    store = new RuntimeBrokerSqliteStore(databasePath);
    const restartMs = performance.now() - restartStartedAt;
    const afterEvents = store.readRuntimeReadModelEvents(workspaceId, 0, 512);
    const afterSnapshot = rebuildRuntimeReadModelFromBrokerFramesV2(
      workspaceId,
      afterEvents.map((event) => ({
        cursor: event.cursor,
        frame: (event.payload as unknown as { payload: RuntimeReadModelSourceFrameV2 }).payload,
      })),
    ).projection.snapshot();
    assert.deepEqual(afterSnapshot, beforeSnapshot);
    assert.equal(afterSnapshot.cursor, beforeSnapshot.cursor);
    assert.equal(store.readProjection("run-0"), undefined);
    assert.ok(eventsPerSecond >= 100, `shortened 128-event burst achieved only ${eventsPerSecond.toFixed(1)} events/s`);
    assert.ok(p95Ms < 100, `command commit p95 was ${p95Ms.toFixed(3)}ms`);
    assert.ok(restartMs < 5_000, `broker restart took ${restartMs.toFixed(3)}ms`);
    t.diagnostic(
      `shortened stress: ${runCount} events across ${windowCount} windows in ${burstMs.toFixed(1)}ms; `
      + `${eventsPerSecond.toFixed(1)} events/s; commit p95 ${p95Ms.toFixed(3)}ms; restart ${restartMs.toFixed(3)}ms`,
    );
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
