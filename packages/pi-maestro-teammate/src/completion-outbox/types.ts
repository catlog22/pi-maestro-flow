import type {
  CompletionIntent,
  CompletionOutcome,
  CompletionResource,
  CompletionTarget,
} from "../public/v1/completion-durability.ts";

export const COMPLETION_OUTBOX_SCHEMA_VERSION = 1 as const;
export const COMPLETION_OUTBOX_MAX_RECORD_BYTES = 64 * 1024;
export const COMPLETION_OUTBOX_MAX_SUMMARY_BYTES = 4 * 1024;
export const COMPLETION_OUTBOX_MAX_ERROR_BYTES = 1024;
export const COMPLETION_OUTBOX_MAX_RESOURCES = 64;
export const COMPLETION_OUTBOX_MAX_LIVE_RECORDS = 512;
export const COMPLETION_OUTBOX_MAX_LIVE_BYTES = 16 * 1024 * 1024;
export const COMPLETION_OUTBOX_LIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const COMPLETION_OUTBOX_APPLIED_TTL_MS = 8 * 24 * 60 * 60 * 1000;
export const COMPLETION_OUTBOX_TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const COMPLETION_OUTBOX_RESERVATION_TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;
export const COMPLETION_OUTBOX_CLAIM_MS = 2 * 60 * 1000;
export const COMPLETION_OUTBOX_MAX_ATTEMPTS = 8;
export const COMPLETION_OUTBOX_RETRY_DELAYS_MS = Object.freeze([
  0,
  5_000,
  15_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
] as const);

export type CompletionOutboxState = "wal" | "pending" | "queued" | "applied" | "dead" | "expired";
export type CompletionReservationState = "reserved" | "consumed" | "released";

export interface CompletionOutboxRecord {
  version: typeof COMPLETION_OUTBOX_SCHEMA_VERSION;
  deliveryId: string;
  dispatchId: string;
  reservationId: string;
  kind: CompletionIntent["kind"];
  target: CompletionTarget;
  replyTarget: CompletionIntent["replyTarget"];
  summary: string;
  resources: readonly CompletionResource[];
  outcome: CompletionOutcome;
  state: CompletionOutboxState;
  attempts: number;
  nextAttemptAt: number;
  receiptDeadlineAt?: number;
  claimOwnerId?: string;
  claimExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  lastError?: string;
  /** Immutable provider intent revision echoed by model-consumption receipts. */
  intentRevision?: string;
  contentRevision: string;
  providerAcknowledgedAt?: number;
}

export interface CompletionReservationRecord {
  version: typeof COMPLETION_OUTBOX_SCHEMA_VERSION;
  reservationId: string;
  dispatchId: string;
  target: CompletionTarget;
  reservedBytes: number;
  state: CompletionReservationState;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface CompletionOutboxUsage {
  liveRecords: number;
  liveBytes: number;
  reservations: number;
}

export interface CompletionOutboxGcResult {
  expired: number;
  removed: number;
  releasedReservations: number;
  /** More bounded GC pages remain for this workspace. */
  hasMore?: boolean;
}

/** Result of a non-blocking {@link CompletionOutboxFileStore.tryGc} sweep. */
export interface CompletionOutboxTryGcResult extends CompletionOutboxGcResult {
  /** true if the workspace lock was held by another process and the sweep was skipped. */
  busy?: boolean;
  /** true if a cross-process GC marker indicated a recent sweep and this call skipped. */
  skipped?: boolean;
}

export function retryDelayForAttempt(attempt: number): number {
  const index = Math.max(0, Math.min(COMPLETION_OUTBOX_RETRY_DELAYS_MS.length - 1, attempt));
  return COMPLETION_OUTBOX_RETRY_DELAYS_MS[index]!;
}
