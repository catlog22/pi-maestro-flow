import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  RUNTIME_BROKER_SCHEMA_VERSION,
  RuntimeBrokerError,
  assertJsonValue,
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertPositiveInteger,
  assertRecord,
  type AcquireLeaseRequest,
  type ActorLease,
  type CompareAndSwapLeaseRequest,
  type HeartbeatLeaseRequest,
  type JsonValue,
  type LeaseCredential,
  type ReleaseLeaseRequest,
  type RuntimeBrokerCommitRequest,
  type RuntimeBrokerCommitResult,
  type RuntimeBrokerListStreamsRequest,
  type RuntimeBrokerReadModelSourceState,
  type StoredRuntimeBrokerCursorEvent,
  type StoredRuntimeBrokerEvent,
  type StoredRuntimeBrokerOutboxMessage,
  type TakeoverLeaseRequest,
} from "./contracts.ts";
import { normalizePersistedRuntimeEventV2 } from "../runtime-v2/validation.ts";

type SqliteRow = Record<string, unknown>;

const RUNTIME_READ_MODEL_PAGE_MAX_BYTES = 512 * 1024;
const RUNTIME_STREAM_DISCOVERY_SCAN_MAX = 50_000;

interface SchemaColumn {
  name: string;
  type: "INTEGER" | "TEXT";
  notNull: boolean;
  primaryKey: boolean;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS actor_leases (
    actor_id TEXT PRIMARY KEY,
    stream_id TEXT NOT NULL,
    holder_id TEXT NOT NULL,
    epoch INTEGER NOT NULL CHECK (epoch > 0),
    nonce TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS streams (
    stream_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS inbox (
    message_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    applied_revision INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    producer_epoch INTEGER NOT NULL CHECK (producer_epoch > 0),
    occurred_at INTEGER NOT NULL,
    correlation_id TEXT,
    causation_id TEXT,
    trace_id TEXT,
    FOREIGN KEY (message_id) REFERENCES inbox(message_id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (stream_id) REFERENCES streams(stream_id),
    UNIQUE (stream_id, revision)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS outbox (
    outbox_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    event_id TEXT,
    destination TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    available_at INTEGER NOT NULL,
    delivered_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    FOREIGN KEY (message_id) REFERENCES inbox(message_id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (event_id) REFERENCES events(event_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS outbox_pending_idx
    ON outbox(delivered_at, available_at, created_at);

  CREATE TABLE IF NOT EXISTS projections (
    projection_id TEXT PRIMARY KEY,
    stream_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (stream_id) REFERENCES streams(stream_id)
  ) STRICT;
`;

const SCHEMA_V1_COLUMNS: Record<string, readonly SchemaColumn[]> = {
  metadata: [
    { name: "key", type: "TEXT", notNull: true, primaryKey: true },
    { name: "value", type: "TEXT", notNull: true, primaryKey: false },
  ],
  actor_leases: [
    { name: "actor_id", type: "TEXT", notNull: true, primaryKey: true },
    { name: "holder_id", type: "TEXT", notNull: true, primaryKey: false },
    { name: "epoch", type: "INTEGER", notNull: true, primaryKey: false },
    { name: "nonce", type: "TEXT", notNull: true, primaryKey: false },
    { name: "acquired_at", type: "INTEGER", notNull: true, primaryKey: false },
    { name: "heartbeat_at", type: "INTEGER", notNull: true, primaryKey: false },
    { name: "expires_at", type: "INTEGER", notNull: true, primaryKey: false },
  ],
  streams: [
    { name: "stream_id", type: "TEXT", notNull: true, primaryKey: true },
    { name: "revision", type: "INTEGER", notNull: true, primaryKey: false },
    { name: "created_at", type: "INTEGER", notNull: true, primaryKey: false },
    { name: "updated_at", type: "INTEGER", notNull: true, primaryKey: false },
  ],
  inbox: [
    { name: "message_id", type: "TEXT", notNull: true, primaryKey: true },
    { name: "request_hash", type: "TEXT", notNull: true, primaryKey: false },
    { name: "stream_id", type: "TEXT", notNull: true, primaryKey: false },
    { name: "applied_revision", type: "INTEGER", notNull: true, primaryKey: false },
    { name: "result_json", type: "TEXT", notNull: true, primaryKey: false },
    { name: "applied_at", type: "INTEGER", notNull: true, primaryKey: false },
  ],
  events: [
    { name: "event_id", type: "TEXT", notNull: true, primaryKey: true },
    { name: "message_id", type: "TEXT", notNull: true, primaryKey: false },
    { name: "stream_id", type: "TEXT", notNull: true, primaryKey: false },
    { name: "revision", type: "INTEGER", notNull: true, primaryKey: false },
    { name: "event_type", type: "TEXT", notNull: true, primaryKey: false },
    { name: "payload_json", type: "TEXT", notNull: true, primaryKey: false },
    { name: "producer_epoch", type: "INTEGER", notNull: true, primaryKey: false },
    { name: "occurred_at", type: "INTEGER", notNull: true, primaryKey: false },
    { name: "correlation_id", type: "TEXT", notNull: false, primaryKey: false },
    { name: "causation_id", type: "TEXT", notNull: false, primaryKey: false },
    { name: "trace_id", type: "TEXT", notNull: false, primaryKey: false },
  ],
  outbox: [
    { name: "outbox_id", type: "TEXT", notNull: true, primaryKey: true },
    { name: "message_id", type: "TEXT", notNull: true, primaryKey: false },
    { name: "event_id", type: "TEXT", notNull: false, primaryKey: false },
    { name: "destination", type: "TEXT", notNull: true, primaryKey: false },
    { name: "payload_json", type: "TEXT", notNull: true, primaryKey: false },
    { name: "created_at", type: "INTEGER", notNull: true, primaryKey: false },
    { name: "available_at", type: "INTEGER", notNull: true, primaryKey: false },
    { name: "delivered_at", type: "INTEGER", notNull: false, primaryKey: false },
    { name: "attempts", type: "INTEGER", notNull: true, primaryKey: false },
  ],
  projections: [
    { name: "projection_id", type: "TEXT", notNull: true, primaryKey: true },
    { name: "stream_id", type: "TEXT", notNull: true, primaryKey: false },
    { name: "revision", type: "INTEGER", notNull: true, primaryKey: false },
    { name: "value_json", type: "TEXT", notNull: true, primaryKey: false },
    { name: "updated_at", type: "INTEGER", notNull: true, primaryKey: false },
  ],
};

const SCHEMA_V2_COLUMNS: Record<string, readonly SchemaColumn[]> = {
  ...SCHEMA_V1_COLUMNS,
  actor_leases: [
    { name: "actor_id", type: "TEXT", notNull: true, primaryKey: true },
    { name: "stream_id", type: "TEXT", notNull: true, primaryKey: false },
    { name: "holder_id", type: "TEXT", notNull: true, primaryKey: false },
    { name: "epoch", type: "INTEGER", notNull: true, primaryKey: false },
    { name: "nonce", type: "TEXT", notNull: true, primaryKey: false },
    { name: "acquired_at", type: "INTEGER", notNull: true, primaryKey: false },
    { name: "heartbeat_at", type: "INTEGER", notNull: true, primaryKey: false },
    { name: "expires_at", type: "INTEGER", notNull: true, primaryKey: false },
  ],
};

export interface RuntimeBrokerSqliteStoreOptions {
  busyTimeoutMs?: number;
  now?: () => number;
  nonce?: () => string;
}

/** Own this store in the broker sidecar; host windows communicate with it over IPC. */
export class RuntimeBrokerSqliteStore {
  readonly path: string;
  readonly journalMode: string;
  #db: DatabaseSync;
  #closed = false;
  #now: () => number;
  #nonce: () => string;

  constructor(path: string, options: RuntimeBrokerSqliteStoreOptions = {}) {
    assertNonEmptyString(path, "path");
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    assertNonNegativeInteger(busyTimeoutMs, "busyTimeoutMs");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.#now = options.now ?? Date.now;
    this.#nonce = options.nonce ?? randomUUID;
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      this.#db.exec("PRAGMA foreign_keys = ON");
      this.journalMode = assertRuntimeBrokerWalMode(
        (this.#db.prepare("PRAGMA journal_mode = WAL").get() as SqliteRow | undefined)?.journal_mode,
      );
      this.#db.exec("PRAGMA synchronous = FULL");
      this.#migrate();
    } catch (error) {
      this.#closed = true;
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  commit(request: RuntimeBrokerCommitRequest): RuntimeBrokerCommitResult {
    this.#assertOpen();
    validateCommitRequest(request);
    const requestHash = hashCommitRequest(request);
    const appliedAt = this.#readNow();

    return this.#transaction(() => {
      const currentLease = this.#requireCurrentLease(request.actorId, request.lease, appliedAt);
      this.#requireAuthorizedStream(currentLease, request.streamId);
      const recovered = this.#recoverCommit(request.messageId, requestHash);
      if (recovered) return recovered;

      const currentRevision = this.getStreamRevision(request.streamId);
      if (currentRevision !== request.expectedRevision) {
        throw new RuntimeBrokerError("revision_conflict", "stream revision did not match expectedRevision", {
          streamId: request.streamId,
          expectedRevision: request.expectedRevision,
          actualRevision: currentRevision,
        });
      }

      this.#assertRuntimeWorkspaceOwnership(request);
      this.#assertUnusedIds(request);
      const revision = currentRevision + request.events.length;
      this.#upsertStream(request.streamId, currentRevision, revision, appliedAt);

      const insertEvent = this.#db.prepare(`
        INSERT INTO events (
          event_id, message_id, stream_id, revision, event_type, payload_json,
          producer_epoch, occurred_at, correlation_id, causation_id, trace_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const eventCursors: number[] = [];
      request.events.forEach((event, index) => {
        const inserted = insertEvent.run(
          event.eventId,
          request.messageId,
          request.streamId,
          currentRevision + index + 1,
          event.eventType,
          JSON.stringify(event.payload),
          request.lease.epoch,
          event.occurredAt ?? appliedAt,
          event.correlationId ?? null,
          event.causationId ?? null,
          event.traceId ?? null,
        );
        eventCursors.push(Number(inserted.lastInsertRowid));
      });

      const insertOutbox = this.#db.prepare(`
        INSERT INTO outbox (
          outbox_id, message_id, event_id, destination, payload_json,
          created_at, available_at, delivered_at, attempts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)
      `);
      for (const message of request.outbox ?? []) {
        insertOutbox.run(
          message.outboxId,
          request.messageId,
          message.eventId ?? null,
          message.destination,
          JSON.stringify(message.payload),
          appliedAt,
          message.availableAt ?? appliedAt,
        );
      }

      const upsertProjection = this.#db.prepare(`
        INSERT INTO projections (projection_id, stream_id, revision, value_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(projection_id) DO UPDATE SET
          stream_id = excluded.stream_id,
          revision = excluded.revision,
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `);
      for (const projection of request.projections ?? []) {
        upsertProjection.run(
          projection.projectionId,
          request.streamId,
          revision,
          JSON.stringify(projection.value),
          appliedAt,
        );
      }

      const result: RuntimeBrokerCommitResult = {
        messageId: request.messageId,
        streamId: request.streamId,
        previousRevision: currentRevision,
        revision,
        eventIds: request.events.map((event) => event.eventId),
        eventCursors,
        outboxIds: (request.outbox ?? []).map((message) => message.outboxId),
        appliedAt,
        recovered: false,
        ...(request.inboxResult === undefined ? {} : { reply: request.inboxResult }),
      };
      this.#db.prepare(`
        INSERT INTO inbox (message_id, request_hash, stream_id, applied_revision, result_json, applied_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(request.messageId, requestHash, request.streamId, revision, JSON.stringify(result), appliedAt);
      return result;
    });
  }

  acquireLease(request: AcquireLeaseRequest): ActorLease {
    this.#assertOpen();
    validateLeaseRequest(request);
    const now = this.#readNow();
    validateLeaseDeadline(now, request.ttlMs);
    return this.#transaction(() => {
      const streamId = request.streamId ?? request.actorId;
      const current = this.getLease(request.actorId);
      if (current && current.expiresAt > now) {
        throw leaseUnavailable(request.actorId, current.expiresAt);
      }
      return this.#writeLease(request.actorId, streamId, request.holderId, (current?.epoch ?? 0) + 1, now, request.ttlMs, current);
    });
  }

  heartbeatLease(request: HeartbeatLeaseRequest): ActorLease {
    this.#assertOpen();
    assertRecord(request, "request");
    validateCredentialRequest(request.actorId, request.lease, request.ttlMs, request.now);
    const now = this.#readNow();
    validateLeaseDeadline(now, request.ttlMs);
    return this.#transaction(() => {
      const current = this.#requireCurrentLease(request.actorId, request.lease, now);
      const expiresAt = now + request.ttlMs;
      const result = this.#db.prepare(`
        UPDATE actor_leases SET heartbeat_at = ?, expires_at = ?
        WHERE actor_id = ? AND epoch = ? AND nonce = ? AND expires_at > ?
      `).run(now, expiresAt, request.actorId, request.lease.epoch, request.lease.nonce, now);
      if (Number(result.changes) !== 1) throw staleLease(request.actorId);
      return { ...current, heartbeatAt: now, expiresAt };
    });
  }

  compareAndSwapLease(request: CompareAndSwapLeaseRequest): ActorLease {
    this.#assertOpen();
    assertRecord(request, "request");
    validateCredentialRequest(request.actorId, request.lease, request.ttlMs, request.now);
    assertNonEmptyString(request.nextHolderId, "nextHolderId");
    const now = this.#readNow();
    validateLeaseDeadline(now, request.ttlMs);
    return this.#transaction(() => {
      const current = this.#requireCurrentLease(request.actorId, request.lease, now);
      const next = makeLease(
        request.actorId,
        current.streamId,
        request.nextHolderId,
        current.epoch + 1,
        this.#nonce(),
        now,
        request.ttlMs,
      );
      const result = this.#db.prepare(`
        UPDATE actor_leases
        SET holder_id = ?, epoch = ?, nonce = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ?
        WHERE actor_id = ? AND epoch = ? AND nonce = ? AND expires_at > ?
      `).run(
        next.holderId,
        next.epoch,
        next.nonce,
        next.acquiredAt,
        next.heartbeatAt,
        next.expiresAt,
        request.actorId,
        request.lease.epoch,
        request.lease.nonce,
        now,
      );
      if (Number(result.changes) !== 1) throw staleLease(request.actorId);
      return next;
    });
  }

  takeoverLease(request: TakeoverLeaseRequest): ActorLease {
    this.#assertOpen();
    validateLeaseRequest(request);
    const now = this.#readNow();
    validateLeaseDeadline(now, request.ttlMs);
    return this.#transaction(() => {
      const current = this.getLease(request.actorId);
      if (!current || current.expiresAt > now) {
        throw leaseUnavailable(request.actorId, current?.expiresAt);
      }
      return this.#writeLease(
        request.actorId,
        request.streamId ?? request.actorId,
        request.holderId,
        current.epoch + 1,
        now,
        request.ttlMs,
        current,
      );
    });
  }

  releaseLease(request: ReleaseLeaseRequest): void {
    this.#assertOpen();
    assertRecord(request, "request");
    validateCredential(request.actorId, request.lease);
    if (request.now !== undefined) assertNonNegativeInteger(request.now, "now");
    const now = this.#readNow();
    this.#transaction(() => {
      this.#requireCurrentLease(request.actorId, request.lease, now);
      const result = this.#db.prepare(`
        UPDATE actor_leases SET heartbeat_at = ?, expires_at = ?
        WHERE actor_id = ? AND epoch = ? AND nonce = ? AND expires_at > ?
      `).run(now, now, request.actorId, request.lease.epoch, request.lease.nonce, now);
      if (Number(result.changes) !== 1) throw staleLease(request.actorId);
    });
  }

  getLease(actorId: string): ActorLease | undefined {
    this.#assertOpen();
    assertNonEmptyString(actorId, "actorId");
    const row = this.#db.prepare("SELECT * FROM actor_leases WHERE actor_id = ?").get(actorId) as SqliteRow | undefined;
    return row ? leaseFromRow(row) : undefined;
  }

  getStreamRevision(streamId: string): number {
    this.#assertOpen();
    assertNonEmptyString(streamId, "streamId");
    const row = this.#db.prepare("SELECT revision FROM streams WHERE stream_id = ?").get(streamId) as SqliteRow | undefined;
    return row ? Number(row.revision) : 0;
  }

  readEvents(streamId: string, afterRevision = 0): StoredRuntimeBrokerEvent[] {
    this.#assertOpen();
    assertNonEmptyString(streamId, "streamId");
    assertNonNegativeInteger(afterRevision, "afterRevision");
    const rows = this.#db.prepare(`
      SELECT * FROM events WHERE stream_id = ? AND revision > ? ORDER BY revision ASC
    `).all(streamId, afterRevision) as SqliteRow[];
    return rows.map(eventFromRow);
  }

  readAuthorizedEvents(
    streamId: string,
    afterRevision: number,
    authorization: { actorId: string; lease: LeaseCredential },
  ): StoredRuntimeBrokerEvent[] {
    this.#assertOpen();
    assertRecord(authorization, "authorization");
    validateCredential(authorization.actorId, authorization.lease);
    const current = this.#requireCurrentLease(authorization.actorId, authorization.lease, this.#readNow());
    this.#requireAuthorizedStream(current, streamId);
    return this.readEvents(streamId, afterRevision);
  }

  listStreams(request: RuntimeBrokerListStreamsRequest): string[] {
    this.#assertOpen();
    assertRecord(request, "request");
    assertNonEmptyString(request.workspaceId, "workspaceId");
    assertNonEmptyString(request.prefix, "prefix");
    const afterStreamId = request.afterStreamId ?? "";
    if (typeof afterStreamId !== "string" || afterStreamId.includes("\0")) {
      throw new RuntimeBrokerError("invalid_request", "afterStreamId must be a bounded string");
    }
    assertPositiveInteger(request.limit, "limit");
    if (request.limit > 512) {
      throw new RuntimeBrokerError("invalid_request", "limit must not exceed 512", { limit: request.limit });
    }
    const streamIds: string[] = [];
    let cursor = afterStreamId;
    let scanned = 0;
    const page = this.#db.prepare(`
      SELECT s.stream_id FROM streams s
      WHERE s.stream_id > ?
        AND substr(s.stream_id, 1, length(?)) = ?
      ORDER BY s.stream_id ASC LIMIT ?
    `);
    while (streamIds.length < request.limit && scanned < RUNTIME_STREAM_DISCOVERY_SCAN_MAX) {
      const batchSize = Math.min(512, RUNTIME_STREAM_DISCOVERY_SCAN_MAX - scanned);
      const rows = page.all(cursor, request.prefix, request.prefix, batchSize) as SqliteRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        const streamId = String(row.stream_id);
        cursor = streamId;
        scanned += 1;
        if (this.#runtimeWorkspaceOwner(streamId) === request.workspaceId) streamIds.push(streamId);
        if (streamIds.length === request.limit) break;
      }
      if (rows.length < batchSize) break;
    }
    if (scanned === RUNTIME_STREAM_DISCOVERY_SCAN_MAX && streamIds.length < request.limit) {
      const overflow = page.all(cursor, request.prefix, request.prefix, 1) as SqliteRow[];
      if (overflow.length > 0) {
        throw new RuntimeBrokerError("invalid_request", "Runtime stream discovery scan limit exceeded");
      }
    }
    return streamIds;
  }

  readRuntimeReadModelEvents(
    workspaceId: string,
    afterCursor = 0,
    limit = 128,
  ): StoredRuntimeBrokerCursorEvent[] {
    this.#assertOpen();
    assertNonEmptyString(workspaceId, "workspaceId");
    assertNonNegativeInteger(afterCursor, "afterCursor");
    assertPositiveInteger(limit, "limit");
    if (limit > 512) throw new RuntimeBrokerError("invalid_request", "limit must not exceed 512", { limit });
    const rows = this.#db.prepare(`
      SELECT rowid AS global_cursor, * FROM events
      WHERE rowid > ?
        AND event_type = 'domain.event'
        AND json_extract(payload_json, '$.actor.workspaceId') = ?
        AND json_extract(payload_json, '$.kind') = 'domain.event'
        AND json_extract(payload_json, '$.eventType') = 'teammate.runtime-read-model.frame.v2'
      ORDER BY rowid ASC LIMIT ?
    `).all(afterCursor, workspaceId, limit) as SqliteRow[];
    const page: StoredRuntimeBrokerCursorEvent[] = [];
    let bytes = 2;
    for (const row of rows) {
      const event = eventFromRow(row);
      const cursor = Number(row.global_cursor);
      if (!Number.isSafeInteger(cursor) || cursor < 1) throw new Error("Runtime broker journal cursor is invalid");
      const candidate = { ...event, cursor };
      const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8") + (page.length === 0 ? 0 : 1);
      if (bytes + candidateBytes > RUNTIME_READ_MODEL_PAGE_MAX_BYTES) {
        if (page.length === 0) {
          throw new RuntimeBrokerError("invalid_request", "Runtime read-model event exceeds the page byte budget");
        }
        break;
      }
      page.push(candidate);
      bytes += candidateBytes;
    }
    return page;
  }

  readRuntimeReadModelSources(
    workspaceId: string,
    afterStreamId = "",
    limit = 128,
  ): RuntimeBrokerReadModelSourceState[] {
    this.#assertOpen();
    assertNonEmptyString(workspaceId, "workspaceId");
    if (typeof afterStreamId !== "string" || afterStreamId.includes("\0")) {
      throw new RuntimeBrokerError("invalid_request", "afterStreamId must be a bounded string");
    }
    assertPositiveInteger(limit, "limit");
    if (limit > 512) throw new RuntimeBrokerError("invalid_request", "limit must not exceed 512", { limit });
    const now = this.#readNow();
    const rows = this.#db.prepare(`
      SELECT DISTINCT e.stream_id, l.epoch, l.expires_at
      FROM events e
      JOIN actor_leases l ON l.actor_id = e.stream_id
      WHERE e.stream_id > ?
        AND e.event_type = 'domain.event'
        AND json_extract(e.payload_json, '$.actor.workspaceId') = ?
        AND json_extract(e.payload_json, '$.kind') = 'domain.event'
        AND json_extract(e.payload_json, '$.eventType') = 'teammate.runtime-read-model.frame.v2'
      ORDER BY e.stream_id ASC LIMIT ?
    `).all(afterStreamId, workspaceId, limit) as SqliteRow[];
    return rows.map((row) => ({
      streamId: String(row.stream_id),
      generation: Number(row.epoch),
      active: Number(row.expires_at) > now,
    }));
  }

  readProjection(projectionId: string): { streamId: string; revision: number; value: JsonValue; updatedAt: number } | undefined {
    this.#assertOpen();
    assertNonEmptyString(projectionId, "projectionId");
    const row = this.#db.prepare("SELECT * FROM projections WHERE projection_id = ?").get(projectionId) as SqliteRow | undefined;
    if (!row) return undefined;
    return {
      streamId: String(row.stream_id),
      revision: Number(row.revision),
      value: parseJson(row.value_json),
      updatedAt: Number(row.updated_at),
    };
  }

  listPendingOutbox(limit = 100, now = this.#now()): StoredRuntimeBrokerOutboxMessage[] {
    this.#assertOpen();
    assertPositiveInteger(limit, "limit");
    assertNonNegativeInteger(now, "now");
    const rows = this.#db.prepare(`
      SELECT * FROM outbox
      WHERE delivered_at IS NULL AND available_at <= ?
      ORDER BY created_at ASC, outbox_id ASC LIMIT ?
    `).all(now, limit) as SqliteRow[];
    return rows.map(outboxFromRow);
  }

  markOutboxDelivered(outboxId: string, deliveredAt = this.#now()): boolean {
    this.#assertOpen();
    assertNonEmptyString(outboxId, "outboxId");
    assertNonNegativeInteger(deliveredAt, "deliveredAt");
    const result = this.#db.prepare(`
      UPDATE outbox SET delivered_at = ?, attempts = attempts + 1
      WHERE outbox_id = ? AND delivered_at IS NULL
    `).run(deliveredAt, outboxId);
    return Number(result.changes) === 1;
  }

  tableNames(): string[] {
    this.#assertOpen();
    return (this.#db.prepare(`
      SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
    `).all() as SqliteRow[]).map((row) => String(row.name));
  }

  #migrate(): void {
    this.#transaction(() => {
      let version = this.#readSchemaVersion();
      if (version > RUNTIME_BROKER_SCHEMA_VERSION) {
        throw schemaError(`version ${version} is newer than supported ${RUNTIME_BROKER_SCHEMA_VERSION}`);
      }
      while (version < RUNTIME_BROKER_SCHEMA_VERSION) {
        switch (version) {
          case 0:
            this.#migrateSchema0To2();
            version = 2;
            break;
          case 1:
            this.#migrateSchema1To2();
            version = 2;
            break;
          default:
            throw schemaError(`no migration path from version ${version}`);
        }
      }
      this.#validateSchemaV2();
    });
  }

  #readSchemaVersion(): number {
    const userVersionRow = this.#db.prepare("PRAGMA user_version").get() as SqliteRow | undefined;
    const userVersion = Number(userVersionRow?.user_version);
    if (!Number.isSafeInteger(userVersion) || userVersion < 0) {
      throw schemaError("PRAGMA user_version must be a non-negative safe integer");
    }

    const metadataExists = Boolean(this.#db.prepare(`
      SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'metadata'
    `).get());
    if (!metadataExists) {
      if (userVersion !== 0 || this.tableNames().length !== 0) {
        throw schemaError("metadata is missing from a non-empty or versioned database");
      }
      return 0;
    }

    this.#validateTable("metadata", SCHEMA_V1_COLUMNS.metadata!);
    const rows = this.#db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").all() as SqliteRow[];
    if (rows.length !== 1) throw schemaError("metadata.schema_version must exist exactly once");
    const metadataVersion = parseSchemaVersion(rows[0]!.value);
    if (metadataVersion !== userVersion) {
      throw schemaError(`metadata.schema_version ${metadataVersion} does not match user_version ${userVersion}`);
    }
    return metadataVersion;
  }

  #migrateSchema0To2(): void {
    this.#db.exec(SCHEMA_SQL);
    this.#writeSchemaVersion(2);
  }

  #migrateSchema1To2(): void {
    this.#validateSchemaV1();
    this.#db.exec(`
      ALTER TABLE actor_leases RENAME TO actor_leases_v1;
      CREATE TABLE actor_leases (
        actor_id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        holder_id TEXT NOT NULL,
        epoch INTEGER NOT NULL CHECK (epoch > 0),
        nonce TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      DROP TABLE actor_leases_v1;
    `);
    this.#writeSchemaVersion(2);
  }

  #writeSchemaVersion(version: number): void {
    this.#db.prepare(`
      INSERT INTO metadata (key, value) VALUES ('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(version));
    this.#db.exec(`PRAGMA user_version = ${version}`);
  }

  #validateSchemaV1(): void {
    for (const [table, columns] of Object.entries(SCHEMA_V1_COLUMNS)) {
      this.#validateTable(table, columns);
    }
  }

  #validateSchemaV2(): void {
    for (const [table, columns] of Object.entries(SCHEMA_V2_COLUMNS)) {
      this.#validateTable(table, columns);
    }
  }

  #validateTable(table: string, expected: readonly SchemaColumn[]): void {
    const tableRow = this.#db.prepare(`
      SELECT strict FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name = ?
    `).get(table) as SqliteRow | undefined;
    if (!tableRow || Number(tableRow.strict) !== 1) {
      throw schemaError(`table ${table} is missing or is not STRICT`);
    }
    const actual = this.#db.prepare(`PRAGMA table_info(${table})`).all() as SqliteRow[];
    if (actual.length !== expected.length) throw schemaError(`table ${table} has incompatible columns`);
    for (let index = 0; index < expected.length; index += 1) {
      const column = actual[index]!;
      const wanted = expected[index]!;
      if (
        column.name !== wanted.name
        || String(column.type).toUpperCase() !== wanted.type
        || Boolean(column.notnull) !== wanted.notNull
        || Boolean(column.pk) !== wanted.primaryKey
      ) {
        throw schemaError(`table ${table} has an incompatible ${wanted.name} column`);
      }
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure; a rollback can fail after SQLite aborts a transaction itself.
      }
      throw error;
    }
  }

  #recoverCommit(messageId: string, requestHash: string): RuntimeBrokerCommitResult | undefined {
    const row = this.#db.prepare("SELECT request_hash, result_json FROM inbox WHERE message_id = ?").get(messageId) as SqliteRow | undefined;
    if (!row) return undefined;
    if (row.request_hash !== requestHash) {
      throw new RuntimeBrokerError("idempotency_conflict", "messageId was already applied with different content", { messageId });
    }
    const result = JSON.parse(String(row.result_json)) as RuntimeBrokerCommitResult;
    return { ...result, recovered: true };
  }

  #requireCurrentLease(actorId: string, lease: LeaseCredential, now: number): ActorLease {
    const current = this.getLease(actorId);
    if (!current || current.epoch !== lease.epoch || current.nonce !== lease.nonce || current.expiresAt <= now) {
      throw staleLease(actorId);
    }
    return current;
  }

  #requireAuthorizedStream(lease: ActorLease, streamId: string): void {
    assertNonEmptyString(streamId, "streamId");
    if (lease.streamId !== streamId) {
      throw new RuntimeBrokerError("stale_lease", "lease is not authorized for the requested stream", {
        actorId: lease.actorId,
        authorizedStreamId: lease.streamId,
        streamId,
      });
    }
  }

  #assertRuntimeWorkspaceOwnership(request: RuntimeBrokerCommitRequest): void {
    let owner = this.#runtimeWorkspaceOwner(request.streamId);
    for (const event of request.events) {
      const workspaceId = runtimeEventWorkspaceId(event.payload, request.streamId);
      if (workspaceId === undefined) continue;
      owner ??= workspaceId;
      if (workspaceId !== owner) {
        throw new RuntimeBrokerError("invalid_request", "Runtime event workspace does not match the stream owner", {
          streamId: request.streamId,
          workspaceId,
          ownerWorkspaceId: owner,
        });
      }
    }
  }

  #runtimeWorkspaceOwner(streamId: string): string | undefined {
    const rows = this.#db.prepare(`
      SELECT payload_json FROM events WHERE stream_id = ? ORDER BY revision ASC
    `).all(streamId) as SqliteRow[];
    for (const row of rows) {
      const workspaceId = runtimeEventWorkspaceId(parseJson(row.payload_json), streamId);
      if (workspaceId !== undefined) return workspaceId;
    }
    return undefined;
  }

  #assertUnusedIds(request: RuntimeBrokerCommitRequest): void {
    assertUnique(request.events.map((event) => event.eventId), "eventId");
    assertUnique((request.outbox ?? []).map((message) => message.outboxId), "outboxId");
    assertUnique((request.projections ?? []).map((projection) => projection.projectionId), "projectionId");

    const eventExists = this.#db.prepare("SELECT message_id FROM events WHERE event_id = ?");
    for (const event of request.events) this.#assertIdUnused(eventExists, event.eventId, "eventId");
    const outboxExists = this.#db.prepare("SELECT message_id FROM outbox WHERE outbox_id = ?");
    for (const message of request.outbox ?? []) this.#assertIdUnused(outboxExists, message.outboxId, "outboxId");
  }

  #assertIdUnused(statement: StatementSync, id: string, field: string): void {
    if (statement.get(id)) {
      throw new RuntimeBrokerError("idempotency_conflict", `${field} was already used by another message`, { field, id });
    }
  }

  #upsertStream(streamId: string, currentRevision: number, revision: number, now: number): void {
    if (currentRevision === 0) {
      const existing = this.#db.prepare("SELECT 1 AS present FROM streams WHERE stream_id = ?").get(streamId);
      if (!existing) {
        this.#db.prepare(`
          INSERT INTO streams (stream_id, revision, created_at, updated_at) VALUES (?, ?, ?, ?)
        `).run(streamId, revision, now, now);
        return;
      }
    }
    const result = this.#db.prepare(`
      UPDATE streams SET revision = ?, updated_at = ? WHERE stream_id = ? AND revision = ?
    `).run(revision, now, streamId, currentRevision);
    if (Number(result.changes) !== 1) {
      throw new RuntimeBrokerError("revision_conflict", "stream changed during commit", { streamId });
    }
  }

  #writeLease(
    actorId: string,
    streamId: string,
    holderId: string,
    epoch: number,
    now: number,
    ttlMs: number,
    expected?: ActorLease,
  ): ActorLease {
    const lease = makeLease(actorId, streamId, holderId, epoch, this.#nonce(), now, ttlMs);
    if (!expected) {
      this.#db.prepare(`
        INSERT INTO actor_leases (actor_id, stream_id, holder_id, epoch, nonce, acquired_at, heartbeat_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(actorId, streamId, holderId, epoch, lease.nonce, now, now, lease.expiresAt);
      return lease;
    }
    const result = this.#db.prepare(`
      UPDATE actor_leases
      SET stream_id = ?, holder_id = ?, epoch = ?, nonce = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ?
      WHERE actor_id = ? AND epoch = ? AND nonce = ? AND expires_at <= ?
    `).run(streamId, holderId, epoch, lease.nonce, now, now, lease.expiresAt, actorId, expected.epoch, expected.nonce, now);
    if (Number(result.changes) !== 1) throw leaseUnavailable(actorId, expected.expiresAt);
    return lease;
  }

  #readNow(): number {
    const now = this.#now();
    assertNonNegativeInteger(now, "brokerNow");
    return now;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("runtime broker SQLite store is closed");
  }
}

function assertRuntimeBrokerWalMode(value: unknown): string {
  const journalMode = typeof value === "string" ? value : "";
  if (journalMode.toLowerCase() !== "wal") {
    throw new Error(`runtime broker SQLite requires WAL journal mode; received ${journalMode || "unknown"}`);
  }
  return journalMode;
}

function parseSchemaVersion(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw schemaError("metadata.schema_version must be a canonical non-negative integer");
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version)) {
    throw schemaError("metadata.schema_version must be a non-negative safe integer");
  }
  return version;
}

function schemaError(message: string): Error {
  return new Error(`invalid runtime broker SQLite schema: ${message}`);
}

function validateCommitRequest(request: RuntimeBrokerCommitRequest): void {
  assertRecord(request, "request");
  assertNonEmptyString(request.messageId, "messageId");
  assertNonEmptyString(request.actorId, "actorId");
  validateCredential(request.actorId, request.lease);
  assertNonEmptyString(request.streamId, "streamId");
  assertNonNegativeInteger(request.expectedRevision, "expectedRevision");
  assertDenseArray(request.events, "events");
  request.events.forEach((event, index) => {
    assertRecord(event, `events[${index}]`);
    assertNonEmptyString(event.eventId, `events[${index}].eventId`);
    assertNonEmptyString(event.eventType, `events[${index}].eventType`);
    assertJsonValue(event.payload, `events[${index}].payload`);
    if (event.occurredAt !== undefined) assertNonNegativeInteger(event.occurredAt, `events[${index}].occurredAt`);
    assertOptionalNonEmptyString(event.correlationId, `events[${index}].correlationId`);
    assertOptionalNonEmptyString(event.causationId, `events[${index}].causationId`);
    assertOptionalNonEmptyString(event.traceId, `events[${index}].traceId`);
  });
  assertOptionalDenseArray(request.outbox, "outbox");
  for (const [index, message] of (request.outbox ?? []).entries()) {
    assertRecord(message, `outbox[${index}]`);
    assertNonEmptyString(message.outboxId, `outbox[${index}].outboxId`);
    assertNonEmptyString(message.destination, `outbox[${index}].destination`);
    assertJsonValue(message.payload, `outbox[${index}].payload`);
    assertOptionalNonEmptyString(message.eventId, `outbox[${index}].eventId`);
    if (message.availableAt !== undefined) assertNonNegativeInteger(message.availableAt, `outbox[${index}].availableAt`);
  }
  assertOptionalDenseArray(request.projections, "projections");
  for (const [index, projection] of (request.projections ?? []).entries()) {
    assertRecord(projection, `projections[${index}]`);
    assertNonEmptyString(projection.projectionId, `projections[${index}].projectionId`);
    assertJsonValue(projection.value, `projections[${index}].value`);
  }
  if (request.inboxResult !== undefined) assertJsonValue(request.inboxResult, "inboxResult");
  if (request.committedAt !== undefined) assertNonNegativeInteger(request.committedAt, "committedAt");
}

function validateLeaseRequest(request: AcquireLeaseRequest): void {
  assertRecord(request, "request");
  assertNonEmptyString(request.actorId, "actorId");
  if (request.streamId !== undefined) assertNonEmptyString(request.streamId, "streamId");
  assertNonEmptyString(request.holderId, "holderId");
  assertPositiveInteger(request.ttlMs, "ttlMs");
  if (request.now !== undefined) assertNonNegativeInteger(request.now, "now");
}

function validateCredentialRequest(actorId: string, lease: LeaseCredential, ttlMs: number, now?: number): void {
  validateCredential(actorId, lease);
  assertPositiveInteger(ttlMs, "ttlMs");
  if (now !== undefined) assertNonNegativeInteger(now, "now");
}

function validateCredential(actorId: string, lease: LeaseCredential): void {
  assertNonEmptyString(actorId, "actorId");
  assertRecord(lease, "lease");
  assertPositiveInteger(lease.epoch, "lease.epoch");
  assertNonEmptyString(lease.nonce, "lease.nonce");
}

function hashCommitRequest(request: RuntimeBrokerCommitRequest): string {
  const { committedAt: _committedAt, lease: _lease, ...semanticRequest } = request;
  return createHash("sha256").update(canonicalJson(semanticRequest)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

function assertUnique(values: string[], field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new RuntimeBrokerError("idempotency_conflict", `${field} is duplicated in the request`, { field, id: value });
    seen.add(value);
  }
}

function makeLease(
  actorId: string,
  streamId: string,
  holderId: string,
  epoch: number,
  nonce: string,
  now: number,
  ttlMs: number,
): ActorLease {
  assertNonEmptyString(streamId, "streamId");
  assertPositiveInteger(epoch, "lease.epoch");
  assertNonEmptyString(nonce, "lease.nonce");
  validateLeaseDeadline(now, ttlMs);
  return { actorId, streamId, holderId, epoch, nonce, acquiredAt: now, heartbeatAt: now, expiresAt: now + ttlMs };
}

function validateLeaseDeadline(now: number, ttlMs: number): void {
  assertNonNegativeInteger(now, "now");
  assertPositiveInteger(ttlMs, "ttlMs");
  if (!Number.isSafeInteger(now + ttlMs)) {
    throw invalid("now + ttlMs must be a safe integer", "ttlMs");
  }
}

function assertOptionalNonEmptyString(value: unknown, field: string): void {
  if (value !== undefined) assertNonEmptyString(value, field);
}

function assertDenseArray(value: unknown, field: string): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) {
    throw invalid(`${field} must be a dense array`, field);
  }
}

function assertOptionalDenseArray(value: unknown, field: string): void {
  if (value !== undefined) assertDenseArray(value, field);
}

function leaseFromRow(row: SqliteRow): ActorLease {
  return {
    actorId: String(row.actor_id),
    streamId: String(row.stream_id),
    holderId: String(row.holder_id),
    epoch: Number(row.epoch),
    nonce: String(row.nonce),
    acquiredAt: Number(row.acquired_at),
    heartbeatAt: Number(row.heartbeat_at),
    expiresAt: Number(row.expires_at),
  };
}

function eventFromRow(row: SqliteRow): StoredRuntimeBrokerEvent {
  return {
    eventId: String(row.event_id),
    messageId: String(row.message_id),
    streamId: String(row.stream_id),
    revision: Number(row.revision),
    eventType: String(row.event_type),
    payload: parseJson(row.payload_json),
    producerEpoch: Number(row.producer_epoch),
    occurredAt: Number(row.occurred_at),
    ...(row.correlation_id === null ? {} : { correlationId: String(row.correlation_id) }),
    ...(row.causation_id === null ? {} : { causationId: String(row.causation_id) }),
    ...(row.trace_id === null ? {} : { traceId: String(row.trace_id) }),
  };
}

function outboxFromRow(row: SqliteRow): StoredRuntimeBrokerOutboxMessage {
  return {
    outboxId: String(row.outbox_id),
    messageId: String(row.message_id),
    ...(row.event_id === null ? {} : { eventId: String(row.event_id) }),
    destination: String(row.destination),
    payload: parseJson(row.payload_json),
    createdAt: Number(row.created_at),
    availableAt: Number(row.available_at),
    ...(row.delivered_at === null ? {} : { deliveredAt: Number(row.delivered_at) }),
    attempts: Number(row.attempts),
  };
}

function parseJson(value: unknown): JsonValue {
  return JSON.parse(String(value)) as JsonValue;
}

function runtimeEventWorkspaceId(payload: JsonValue, streamId: string): string | undefined {
  try {
    const event = normalizePersistedRuntimeEventV2(payload);
    return event.streamId === streamId ? event.actor.workspaceId : undefined;
  } catch {
    return undefined;
  }
}

function staleLease(actorId: string): RuntimeBrokerError {
  return new RuntimeBrokerError("stale_lease", "lease epoch, nonce, or expiry is not current", { actorId });
}

function leaseUnavailable(actorId: string, expiresAt?: number): RuntimeBrokerError {
  return new RuntimeBrokerError("lease_unavailable", "actor lease cannot be acquired", {
    actorId,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}

function invalid(message: string, field: string): RuntimeBrokerError {
  return new RuntimeBrokerError("invalid_request", message, { field });
}
