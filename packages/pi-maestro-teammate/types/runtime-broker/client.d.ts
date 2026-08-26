import { type AcquireLeaseRequest, type ActorLease, type CompareAndSwapLeaseRequest, type HeartbeatLeaseRequest, type JsonValue, type ReleaseLeaseRequest, type RuntimeBrokerCommitRequest, type RuntimeBrokerCommitResult, type RuntimeBrokerListStreamsRequest, type RuntimeBrokerMethod, type RuntimeBrokerProbeResult, type RuntimeBrokerReadModelSourceState, type RuntimeBrokerStreamAuthorization, type StoredRuntimeBrokerCursorEvent, type StoredRuntimeBrokerEvent, type TakeoverLeaseRequest } from "./contracts.ts";
export interface RuntimeBrokerClientOptions {
    stateDirectory?: string;
    endpoint?: string;
    timeoutMs?: number;
    maxLineBytes?: number;
    maxPendingRequests?: number;
    /** Override used by embedders and failure-injection tests; defaults to process.execPath. */
    daemonExecutable?: string;
    /** Override used by embedders and failure-injection tests; defaults to the packaged broker bin. */
    daemonBinPath?: string;
}
export declare function isRuntimeBrokerTransportError(error: unknown): boolean;
export declare class RuntimeBrokerClient {
    #private;
    readonly endpoint: string;
    get readiness(): RuntimeBrokerProbeResult;
    private constructor();
    static connect(options?: RuntimeBrokerClientOptions): Promise<RuntimeBrokerClient>;
    static connectOrStart(options?: RuntimeBrokerClientOptions): Promise<RuntimeBrokerClient>;
    request<TResult = JsonValue>(method: RuntimeBrokerMethod, params: JsonValue, requestId?: string): Promise<TResult>;
    acquireLease(params: AcquireLeaseRequest, requestId?: string): Promise<ActorLease>;
    heartbeatLease(params: HeartbeatLeaseRequest, requestId?: string): Promise<ActorLease>;
    compareAndSwapLease(params: CompareAndSwapLeaseRequest, requestId?: string): Promise<ActorLease>;
    takeoverLease(params: TakeoverLeaseRequest, requestId?: string): Promise<ActorLease>;
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
export declare function probeRuntimeBrokerAuthority(options: {
    stateDirectory?: string;
    endpoint?: string;
    timeoutMs?: number;
    daemonToken?: string;
    generation?: string;
}): Promise<RuntimeBrokerProbeResult>;
