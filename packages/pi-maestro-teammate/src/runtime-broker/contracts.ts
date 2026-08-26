export const RUNTIME_BROKER_PROTOCOL = "pi.runtime-broker" as const;
export const RUNTIME_BROKER_PROTOCOL_VERSION = 1 as const;
export const RUNTIME_BROKER_SCHEMA_VERSION = 3 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface LeaseCredential {
  epoch: number;
  nonce: string;
}

export interface ActorLease extends LeaseCredential {
  actorId: string;
  streamId: string;
  holderId: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

export interface AcquireLeaseRequest {
  actorId: string;
  /** Authorized stream. Omitted legacy requests bind the lease to actorId. */
  streamId?: string;
  holderId: string;
  ttlMs: number;
  /** Compatibility-only client timestamp; the broker never uses it for lease authorization. */
  now?: number;
}

export interface HeartbeatLeaseRequest {
  actorId: string;
  lease: LeaseCredential;
  ttlMs: number;
  /** Compatibility-only client timestamp; the broker never uses it for lease authorization. */
  now?: number;
}

export interface CompareAndSwapLeaseRequest {
  actorId: string;
  lease: LeaseCredential;
  nextHolderId: string;
  ttlMs: number;
  /** Compatibility-only client timestamp; the broker never uses it for lease authorization. */
  now?: number;
}

export interface TakeoverLeaseRequest extends AcquireLeaseRequest {}

export interface ReleaseLeaseRequest {
  actorId: string;
  lease: LeaseCredential;
  /** Compatibility-only client timestamp; the broker never uses it for lease authorization. */
  now?: number;
}

export interface RuntimeBrokerEventInput {
  eventId: string;
  eventType: string;
  payload: JsonValue;
  occurredAt?: number;
  correlationId?: string;
  causationId?: string;
  traceId?: string;
}

export interface RuntimeBrokerOutboxInput {
  outboxId: string;
  destination: string;
  payload: JsonValue;
  eventId?: string;
  availableAt?: number;
}

export interface RuntimeBrokerProjectionInput {
  projectionId: string;
  value: JsonValue;
}

export interface RuntimeBrokerCommitRequest {
  messageId: string;
  actorId: string;
  lease: LeaseCredential;
  streamId: string;
  expectedRevision: number;
  events: RuntimeBrokerEventInput[];
  outbox?: RuntimeBrokerOutboxInput[];
  projections?: RuntimeBrokerProjectionInput[];
  inboxResult?: JsonValue;
  /** Compatibility-only client timestamp; appliedAt and lease authorization use broker time. */
  committedAt?: number;
}

export interface RuntimeBrokerCommitResult {
  messageId: string;
  streamId: string;
  previousRevision: number;
  revision: number;
  eventIds: string[];
  /** SQLite journal row cursors assigned atomically with the committed events. */
  eventCursors?: number[];
  outboxIds: string[];
  appliedAt: number;
  recovered: boolean;
  reply?: JsonValue;
}

export interface RuntimeBrokerStreamAuthorization {
  actorId: string;
  lease: LeaseCredential;
}

export interface RuntimeBrokerListStreamsRequest {
  workspaceId: string;
  prefix: string;
  afterStreamId?: string;
  limit: number;
}

export interface RuntimeBrokerReadEventsPageRequest extends RuntimeBrokerStreamAuthorization {
  streamId: string;
  afterRevision: number;
  /** Stable upper bound returned by the first page, preserving a finite replay snapshot. */
  throughRevision?: number;
  limit: number;
}

export interface RuntimeBrokerReadEventsPage {
  events: StoredRuntimeBrokerEvent[];
  nextRevision: number;
  throughRevision: number;
  done: boolean;
}

export interface RuntimeBrokerProbeRequest {
  challenge: string;
}

export interface RuntimeBrokerProbeResult {
  protocol: typeof RUNTIME_BROKER_PROTOCOL;
  version: typeof RUNTIME_BROKER_PROTOCOL_VERSION;
  schemaVersion: typeof RUNTIME_BROKER_SCHEMA_VERSION;
  workspaceId: string;
  daemonToken: string;
  generation: string;
  readiness: "ready";
  challenge: string;
}

export interface StoredRuntimeBrokerEvent {
  eventId: string;
  messageId: string;
  streamId: string;
  revision: number;
  eventType: string;
  payload: JsonValue;
  producerEpoch: number;
  occurredAt: number;
  correlationId?: string;
  causationId?: string;
  traceId?: string;
}

export interface StoredRuntimeBrokerCursorEvent extends StoredRuntimeBrokerEvent {
  /** Monotonic journal cursor across every stream in this broker database. */
  cursor: number;
}

export interface RuntimeBrokerReadModelSourceState {
  streamId: string;
  generation: number;
  active: boolean;
}

export interface StoredRuntimeBrokerOutboxMessage {
  outboxId: string;
  messageId: string;
  eventId?: string;
  destination: string;
  payload: JsonValue;
  createdAt: number;
  availableAt: number;
  deliveredAt?: number;
  attempts: number;
}

export type RuntimeBrokerMethod =
  | "broker.probe"
  | "commit"
  | "lease.acquire"
  | "lease.heartbeat"
  | "lease.compare-and-swap"
  | "lease.takeover"
  | "lease.release"
  | "stream.revision"
  | "stream.events"
  | "stream.events.page"
  | "stream.list"
  | "read-model.events"
  | "read-model.sources";

export interface RuntimeBrokerRequestEnvelope<TParams = JsonValue> {
  protocol: typeof RUNTIME_BROKER_PROTOCOL;
  version: typeof RUNTIME_BROKER_PROTOCOL_VERSION;
  requestId: string;
  method: RuntimeBrokerMethod;
  params: TParams;
}

export interface RuntimeBrokerSuccessEnvelope<TResult = JsonValue> {
  protocol: typeof RUNTIME_BROKER_PROTOCOL;
  version: typeof RUNTIME_BROKER_PROTOCOL_VERSION;
  requestId: string;
  ok: true;
  result: TResult;
}

export interface RuntimeBrokerFailureEnvelope {
  protocol: typeof RUNTIME_BROKER_PROTOCOL;
  version: typeof RUNTIME_BROKER_PROTOCOL_VERSION;
  requestId: string;
  ok: false;
  error: RuntimeBrokerErrorBody;
}

export type RuntimeBrokerErrorCode =
  | "idempotency_conflict"
  | "invalid_request"
  | "lease_unavailable"
  | "revision_conflict"
  | "stale_lease";

export interface RuntimeBrokerErrorBody {
  code: RuntimeBrokerErrorCode;
  message: string;
  details?: { [key: string]: JsonValue };
}

export class RuntimeBrokerError extends Error {
  readonly code: RuntimeBrokerErrorCode;
  readonly details?: { [key: string]: JsonValue };

  constructor(code: RuntimeBrokerErrorCode, message: string, details?: { [key: string]: JsonValue }) {
    super(message);
    this.name = "RuntimeBrokerError";
    this.code = code;
    this.details = details;
  }

  toJSON(): RuntimeBrokerErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeBrokerError("invalid_request", `${field} must be a non-empty string`, { field });
  }
}

export function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeBrokerError("invalid_request", `${field} must be a non-negative safe integer`, { field });
  }
}

export function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeBrokerError("invalid_request", `${field} must be a positive safe integer`, { field });
  }
}

export function assertJsonValue(value: unknown, field: string): asserts value is JsonValue {
  const active = new Set<object>();
  const visit = (candidate: unknown): boolean => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return true;
    if (typeof candidate === "number") return Number.isFinite(candidate);
    if (typeof candidate !== "object" || active.has(candidate)) return false;
    active.add(candidate);
    const valid = Array.isArray(candidate)
      ? Object.keys(candidate).length === candidate.length && candidate.every(visit)
      : (Object.getPrototypeOf(candidate) === Object.prototype || Object.getPrototypeOf(candidate) === null)
        && Object.values(candidate).every(visit);
    active.delete(candidate);
    return valid;
  };
  if (!visit(value)) {
    throw new RuntimeBrokerError("invalid_request", `${field} must be finite, acyclic JSON`, { field });
  }
}

export function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new RuntimeBrokerError("invalid_request", `${field} must be an object`, { field });
  }
}
