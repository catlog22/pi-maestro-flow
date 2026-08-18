import { type RemoteConfig } from "./config.ts";
import type { RemoteConnectionFactory } from "./driver.ts";
import { type RemoteRunInputResult, type RemoteRunCancelResult } from "./protocol.ts";
import { type RemoteInputMode, type RemoteRunCapture, type RemoteRunEvent, type RemoteRunSnapshot, type RemoteStatus, type ResolvedRemoteTarget } from "./types.ts";
export declare const REMOTE_MANAGER_MAX_OWNED_RUNS = 512;
export declare const REMOTE_MANAGER_MAX_START_COMMANDS = 4096;
export declare const REMOTE_MANAGER_MAX_ORPHAN_EVENTS = 1024;
export declare class RemoteOwnershipError extends Error {
    constructor(message?: string);
}
export declare class RemoteWorkerQuotaError extends Error {
    constructor(message: string);
}
export declare class RemoteWorkerDisconnectedError extends Error {
    constructor(message: string);
}
export interface RemoteWorkerManagerOptions {
    config: RemoteConfig;
    connectionFactory: RemoteConnectionFactory;
    monitorOwnerNonce?: string;
    maxRunsPerHost?: number;
    maxOwnedRuns?: number;
    maxStartCommands?: number;
    maxOrphanEvents?: number;
    commandIdFactory?: () => string;
    now?: () => number;
    onEvent?: (capture: RemoteRunCapture, event: RemoteRunEvent) => void;
    onSnapshot?: (capture: RemoteRunCapture, snapshot: RemoteRunSnapshot) => void;
}
export interface RemoteWorkerStartRequest {
    targetId: string;
    name: string;
    objective: string;
    commandId?: string;
    outputSchema?: unknown;
    signal?: AbortSignal;
}
export interface RemoteWorkerAttachRequest {
    capture: RemoteRunCapture;
    snapshot?: RemoteRunSnapshot;
    commandId?: string;
    signal?: AbortSignal;
}
export interface RemoteWorkerWaitOptions {
    statuses?: readonly RemoteStatus[];
    timeoutMs?: number;
    signal?: AbortSignal;
}
export interface RemoteWorkerView {
    targetHostId: string;
    workerId: string;
    instanceNonce: string;
    concurrency: number;
    activeRuns: number;
    status: RemoteStatus;
}
/** Owns configured remote workers and exact owner-fenced run captures. */
export declare class RemoteWorkerManager {
    #private;
    readonly monitorOwnerNonce: string;
    constructor(options: RemoteWorkerManagerOptions);
    resolveTarget(targetId: string): ResolvedRemoteTarget;
    connect(targetId: string, signal?: AbortSignal): Promise<RemoteWorkerView>;
    workers(): RemoteWorkerView[];
    start(request: RemoteWorkerStartRequest): Promise<RemoteRunCapture>;
    attach(request: RemoteWorkerAttachRequest): Promise<RemoteRunCapture>;
    replay(capture: RemoteRunCapture, commandId?: string, signal?: AbortSignal): Promise<RemoteRunSnapshot>;
    send(capture: RemoteRunCapture, mode: RemoteInputMode, message: string, commandId?: string): Promise<RemoteRunInputResult>;
    followUp(capture: RemoteRunCapture, message: string, commandId?: string): Promise<RemoteRunInputResult>;
    steer(capture: RemoteRunCapture, message: string, commandId?: string): Promise<RemoteRunInputResult>;
    cancel(capture: RemoteRunCapture, reason?: string, commandId?: string): Promise<RemoteRunCancelResult>;
    snapshot(capture: RemoteRunCapture): RemoteRunSnapshot;
    snapshots(): RemoteRunSnapshot[];
    wait(capture: RemoteRunCapture, options?: RemoteWorkerWaitOptions): Promise<RemoteRunSnapshot>;
    disconnect(targetId: string): Promise<void>;
    reconnect(targetId: string, signal?: AbortSignal): Promise<RemoteWorkerView>;
    close(): Promise<void>;
}
