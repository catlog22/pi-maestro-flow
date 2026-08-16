import type { RemoteConfig } from "../remote/config.ts";
import type { RemoteRunCancelResult, RemoteRunInputResult } from "../remote/protocol.ts";
import type { RemoteRunCapture, RemoteRunEvent, RemoteRunSnapshot } from "../remote/types.ts";
import type { RemoteWorkerStartRequest, RemoteWorkerWaitOptions } from "../remote/worker-manager.ts";
import type { ObservationReadOptions, ObservationSnapshot, ObservationWaitOptions } from "../public/v1/observation.ts";
import { type RemoteHistoryEntry, type RemoteHistoryMode } from "../sessions/remote-history.ts";
import type { SessionMessageKind } from "../sessions/session-core.ts";
/** Raw remote error messages may contain stderr, argv, hosts, paths, or credentials. */
export declare function sanitizeRemoteMonitorError(error: unknown, operation?: string): string;
export interface RemoteWorkerManagerLike {
    readonly monitorOwnerNonce: string;
    start(request: RemoteWorkerStartRequest): Promise<RemoteRunCapture>;
    snapshot(capture: RemoteRunCapture): RemoteRunSnapshot;
    snapshots(): RemoteRunSnapshot[];
    wait(capture: RemoteRunCapture, options?: RemoteWorkerWaitOptions): Promise<RemoteRunSnapshot>;
    followUp(capture: RemoteRunCapture, message: string, commandId?: string): Promise<RemoteRunInputResult>;
    steer(capture: RemoteRunCapture, message: string, commandId?: string): Promise<RemoteRunInputResult>;
    cancel(capture: RemoteRunCapture, reason?: string, commandId?: string): Promise<RemoteRunCancelResult>;
    close(): Promise<void>;
}
export interface RemoteMonitorTargetListing {
    id: string;
    hostId: string;
    driver: "pi-rpc" | "acp";
    cwd: string;
}
export interface RemoteMonitorRunListing extends RemoteRunSnapshot {
    target: string;
    targetId: string;
    name?: string;
    objective?: string;
    createdAt: number;
}
export interface RemoteMonitorSessionOptions {
    config: RemoteConfig;
    manager: RemoteWorkerManagerLike;
    isCurrent: () => boolean;
    persist?: (entry: RemoteHistoryEntry) => void;
    now?: () => number;
    commandIdFactory?: () => string;
}
export declare class RemoteMonitorSession {
    #private;
    constructor(options: RemoteMonitorSessionOptions);
    get monitorOwnerNonce(): string;
    targets(): RemoteMonitorTargetListing[];
    create(request: RemoteWorkerStartRequest): Promise<RemoteMonitorRunListing>;
    list(): RemoteMonitorRunListing[];
    capture(target: string): RemoteRunCapture | undefined;
    send(target: string, mode: RemoteHistoryMode, message: string, messageKind: SessionMessageKind, commandId?: string, requestedMode?: RemoteHistoryMode): Promise<RemoteRunInputResult>;
    closeRun(target: string, reason?: string): Promise<RemoteRunCancelResult>;
    recordSnapshot(capture: RemoteRunCapture, snapshot: RemoteRunSnapshot): void;
    recordEvent(capture: RemoteRunCapture, event: RemoteRunEvent): void;
    observation(target: string, options: ObservationReadOptions): ObservationSnapshot;
    waitObservation(target: string, options: ObservationWaitOptions): Promise<ObservationSnapshot>;
    shutdown(reason?: string): Promise<void>;
}
