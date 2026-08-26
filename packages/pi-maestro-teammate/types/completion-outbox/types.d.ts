import type { CompletionIntent, CompletionOutcome, CompletionResource, CompletionTarget } from "../public/v1/completion-durability.ts";
export declare const COMPLETION_OUTBOX_SCHEMA_VERSION: 1;
export declare const COMPLETION_OUTBOX_MAX_RECORD_BYTES: number;
export declare const COMPLETION_OUTBOX_MAX_SUMMARY_BYTES: number;
export declare const COMPLETION_OUTBOX_MAX_ERROR_BYTES = 1024;
export declare const COMPLETION_OUTBOX_MAX_RESOURCES = 64;
export declare const COMPLETION_OUTBOX_MAX_LIVE_RECORDS = 512;
export declare const COMPLETION_OUTBOX_MAX_LIVE_BYTES: number;
export declare const COMPLETION_OUTBOX_LIVE_TTL_MS: number;
export declare const COMPLETION_OUTBOX_APPLIED_TTL_MS: number;
export declare const COMPLETION_OUTBOX_TERMINAL_TTL_MS: number;
export declare const COMPLETION_OUTBOX_RESERVATION_TERMINAL_TTL_MS: number;
export declare const COMPLETION_OUTBOX_CLAIM_MS: number;
export declare const COMPLETION_OUTBOX_MAX_ATTEMPTS = 8;
export declare const COMPLETION_OUTBOX_RETRY_DELAYS_MS: readonly [0, 5000, 15000, 60000, number, number, number, number];
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
export declare function retryDelayForAttempt(attempt: number): number;
