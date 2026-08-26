import { type AcquireLeaseRequest, type ActorLease, type HeartbeatLeaseRequest, type JsonValue, type ReleaseLeaseRequest, type RuntimeBrokerCommitRequest, type RuntimeBrokerCommitResult, type RuntimeBrokerListStreamsRequest, type RuntimeBrokerMethod, type RuntimeBrokerReadModelSourceState, type RuntimeBrokerStreamAuthorization, type StoredRuntimeBrokerCursorEvent, type StoredRuntimeBrokerEvent } from "./contracts.ts";
export interface RuntimeBrokerClientOptions {
    stateDirectory?: string;
    endpoint?: string;
    timeoutMs?: number;
    maxLineBytes?: number;
    maxPendingRequests?: number;
}
export declare class RuntimeBrokerClient {
    #private;
    readonly endpoint: string;
    private constructor();
    static connect(options?: RuntimeBrokerClientOptions): Promise<RuntimeBrokerClient>;
    static connectOrStart(options?: RuntimeBrokerClientOptions): Promise<RuntimeBrokerClient>;
    request<TResult = JsonValue>(method: RuntimeBrokerMethod, params: JsonValue, requestId?: string): Promise<TResult>;
    acquireLease(params: AcquireLeaseRequest, requestId?: string): Promise<ActorLease>;
    heartbeatLease(params: HeartbeatLeaseRequest, requestId?: string): Promise<ActorLease>;
    commit(params: RuntimeBrokerCommitRequest, requestId?: string): Promise<RuntimeBrokerCommitResult>;
    releaseLease(params: ReleaseLeaseRequest, requestId?: string): Promise<void>;
    getStreamRevision(streamId: string, requestId?: string): Promise<number>;
    readEvents(streamId: string, afterRevision?: number, requestId?: string): Promise<StoredRuntimeBrokerEvent[]>;
    readEvents(streamId: string, afterRevision: number, authorization: RuntimeBrokerStreamAuthorization, requestId?: string): Promise<StoredRuntimeBrokerEvent[]>;
    listStreams(params: RuntimeBrokerListStreamsRequest, requestId?: string): Promise<string[]>;
    readRuntimeReadModelEvents(workspaceId: string, afterCursor?: number, limit?: number, requestId?: string): Promise<StoredRuntimeBrokerCursorEvent[]>;
    readRuntimeReadModelSources(workspaceId: string, afterStreamId?: string, limit?: number, requestId?: string): Promise<RuntimeBrokerReadModelSourceState[]>;
    close(): Promise<void>;
}
