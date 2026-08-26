import type { AgentProgressSnapshot, AgentRunOutcome, AgentRuntimeProjection, AgentStatus, AgentTurnSnapshot, SessionProjectionIdentity } from "../shared/types.ts";
export declare const RUNTIME_READ_MODEL_VERSION: 2;
export declare const RUNTIME_READ_MODEL_REVISION: 1;
/** Broker domain event carrying a discardable per-window read-model frame. */
export declare const RUNTIME_READ_MODEL_FRAME_EVENT = "teammate.runtime-read-model.frame.v2";
export declare const RUNTIME_READ_MODEL_QUERY_EVENT = "teammate:runtime-read-model-query-v2";
export declare const RUNTIME_READ_MODEL_SNAPSHOT_EVENT = "teammate:runtime-read-model-snapshot-v2";
export declare const RUNTIME_READ_MODEL_DELTA_EVENT = "teammate:runtime-read-model-delta-v2";
export declare const RUNTIME_READ_MODEL_UNAVAILABLE_EVENT = "teammate:runtime-read-model-unavailable-v2";
export interface RuntimeReadModelOwnershipV2 extends SessionProjectionIdentity {
}
export interface RuntimeReadModelSourceV2 {
    streamId: string;
    revision: number;
    generation: number;
    /** Exact producer owner. Absent only on pre-isolation V2 records. */
    projection?: RuntimeReadModelOwnershipV2;
}
export interface RuntimeAgentReadEntityV2 {
    correlationId: string;
    /** Exact producer owner. The broker bridge installs this on every new row. */
    projection?: RuntimeReadModelOwnershipV2;
    generation: number;
    agent: string;
    name?: string;
    task?: string;
    /** Spawn attribution and visible hierarchy are intentionally independent. */
    spawnedBy?: string;
    parentCorrelationId?: string;
    status: AgentStatus;
    phase?: string;
    startedAt: number;
    lastActivityAt: number;
    resultReadyAt?: number;
    runtime?: AgentRuntimeProjection;
    turn?: AgentTurnSnapshot;
    lastOutcome?: AgentRunOutcome;
    taskIndex?: number;
    /** Graph ordering only. Never interpreted as a parent relationship. */
    dependencies?: number[];
    recentTools?: AgentProgressSnapshot["recentTools"];
    toolCount?: number;
    tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    requestedModel?: string;
    resolvedModel?: string;
    attemptedModels?: string[];
    lastMessage?: string;
    error?: string;
}
export type RuntimeReadModelChangeV2 = {
    kind: "upsert";
    entity: RuntimeAgentReadEntityV2;
} | {
    kind: "tombstone";
    correlationId: string;
    generation: number;
};
export interface RuntimeReadModelDeltaV2 {
    version: typeof RUNTIME_READ_MODEL_VERSION;
    revision: typeof RUNTIME_READ_MODEL_REVISION;
    kind: "agent-runs-delta";
    baseCursor: number;
    nextCursor: number;
    source: RuntimeReadModelSourceV2;
    changes: RuntimeReadModelChangeV2[];
}
export interface RuntimeReadModelSnapshotV2 {
    version: typeof RUNTIME_READ_MODEL_VERSION;
    revision: typeof RUNTIME_READ_MODEL_REVISION;
    kind: "agent-runs-snapshot";
    cursor: number;
    source: RuntimeReadModelSourceV2;
    agents: RuntimeAgentReadEntityV2[];
}
export interface RuntimeReadModelSourceFrameV2 {
    version: typeof RUNTIME_READ_MODEL_VERSION;
    revision: typeof RUNTIME_READ_MODEL_REVISION;
    kind: "agent-runs-source-frame";
    source: RuntimeReadModelSourceV2;
    batchId: string;
    batchIndex: number;
    batchCount: number;
    reset: boolean;
    changes: RuntimeReadModelChangeV2[];
}
export interface RuntimeReadModelBrokerFrameV2 {
    cursor: number;
    frame: RuntimeReadModelSourceFrameV2;
}
export interface RuntimeReadModelFoldResultV2 {
    projection: RuntimeReadModelProjectionV2;
    accepted: number;
    discarded: number;
}
export declare function parseRuntimeReadModelOwnershipV2(value: unknown): RuntimeReadModelOwnershipV2 | undefined;
export declare function parseRuntimeReadModelDeltaV2(value: unknown): RuntimeReadModelDeltaV2 | undefined;
export declare function parseRuntimeReadModelSourceFrameV2(value: unknown): RuntimeReadModelSourceFrameV2 | undefined;
export declare function parseRuntimeReadModelSnapshotV2(value: unknown): RuntimeReadModelSnapshotV2 | undefined;
/**
 * Discardable canonical projection. Live anomalies return false without
 * mutation so callers can reload a full journal-derived snapshot.
 */
export declare class RuntimeReadModelProjectionV2 {
    #private;
    get cursor(): number;
    get source(): RuntimeReadModelSourceV2;
    applySnapshot(input: unknown): boolean;
    applyDelta(input: unknown): boolean;
    agent(correlationId: string): RuntimeAgentReadEntityV2 | undefined;
    snapshot(): RuntimeReadModelSnapshotV2;
}
export declare class RuntimeReadModelBrokerAccumulatorV2 {
    #private;
    get cursor(): number;
    get accepted(): number;
    apply(record: RuntimeReadModelBrokerFrameV2): boolean;
    snapshot(workspaceId: string, activeSources?: ReadonlyMap<string, number>, projectionSource?: RuntimeReadModelSourceV2): RuntimeReadModelSnapshotV2;
}
export declare function rebuildRuntimeReadModelFromBrokerFramesV2(workspaceId: string, records: readonly RuntimeReadModelBrokerFrameV2[], activeSources?: ReadonlyMap<string, number>): RuntimeReadModelFoldResultV2;
export declare function createRuntimeReadModelDeltaV2(input: {
    previous: RuntimeReadModelSnapshotV2;
    agents: readonly RuntimeAgentReadEntityV2[];
    source: RuntimeReadModelSourceV2;
    nextCursor?: number;
}): RuntimeReadModelDeltaV2;
/** Canonical reads default on with SQLite authority; explicit or invalid overrides fall back to v1. */
export declare function runtimeV2ReadEnabled(env?: NodeJS.ProcessEnv): boolean;
