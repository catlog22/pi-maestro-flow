import { type AcquireLeaseRequest, type ActorLease, type CompareAndSwapLeaseRequest, type HeartbeatLeaseRequest, type JsonValue, type LeaseCredential, type ReleaseLeaseRequest, type RuntimeBrokerCommitRequest, type RuntimeBrokerCommitResult, type RuntimeBrokerListStreamsRequest, type RuntimeBrokerReadEventsPage, type RuntimeBrokerReadEventsPageRequest, type RuntimeBrokerReadModelSourceState, type StoredRuntimeBrokerCursorEvent, type StoredRuntimeBrokerEvent, type StoredRuntimeBrokerOutboxMessage, type TakeoverLeaseRequest } from "./contracts.ts";
export declare const RUNTIME_STREAM_EVENTS_PAGE_MAX_BYTES: number;
export declare const RUNTIME_STREAM_EVENTS_PAGE_MAX_ROWS = 128;
export interface RuntimeBrokerSqliteStoreOptions {
    busyTimeoutMs?: number;
    now?: () => number;
    monotonicNow?: () => number;
    nonce?: () => string;
    receiptCapacity?: number;
}
/** Own this store in the broker sidecar; host windows communicate with it over IPC. */
export declare class RuntimeBrokerSqliteStore {
    #private;
    readonly path: string;
    readonly journalMode: string;
    constructor(path: string, options?: RuntimeBrokerSqliteStoreOptions);
    close(): void;
    commit(request: RuntimeBrokerCommitRequest): RuntimeBrokerCommitResult;
    acquireLease(request: AcquireLeaseRequest, requestId?: string): ActorLease;
    heartbeatLease(request: HeartbeatLeaseRequest, requestId?: string): ActorLease;
    compareAndSwapLease(request: CompareAndSwapLeaseRequest, requestId?: string): ActorLease;
    takeoverLease(request: TakeoverLeaseRequest, requestId?: string): ActorLease;
    releaseLease(request: ReleaseLeaseRequest, requestId?: string): void;
    getLease(actorId: string): ActorLease | undefined;
    getStreamRevision(streamId: string): number;
    readEvents(streamId: string, afterRevision?: number): StoredRuntimeBrokerEvent[];
    readAuthorizedEvents(streamId: string, afterRevision: number, authorization: {
        actorId: string;
        lease: LeaseCredential;
    }): StoredRuntimeBrokerEvent[];
    readAuthorizedEventsPage(request: RuntimeBrokerReadEventsPageRequest, maxBytes?: number): RuntimeBrokerReadEventsPage;
    listStreams(request: RuntimeBrokerListStreamsRequest): string[];
    readRuntimeReadModelEvents(workspaceId: string, afterCursor?: number, limit?: number): StoredRuntimeBrokerCursorEvent[];
    readRuntimeReadModelSources(workspaceId: string, afterStreamId?: string, limit?: number): RuntimeBrokerReadModelSourceState[];
    readProjection(projectionId: string): {
        streamId: string;
        revision: number;
        value: JsonValue;
        updatedAt: number;
    } | undefined;
    listPendingOutbox(limit?: number, now?: number): StoredRuntimeBrokerOutboxMessage[];
    markOutboxDelivered(outboxId: string, deliveredAt?: number): boolean;
    tableNames(): string[];
}
