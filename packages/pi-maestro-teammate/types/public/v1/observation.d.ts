export type ObservationAction = "status" | "wait" | "watch";
export type ObservationDetail = "summary" | "tail" | "full";
export type ObservationWaitMode = "all" | "any" | "count";
export type ObservationPhase = "pending" | "active" | "settled" | "unknown";
export type ObservationOutcome = "success" | "failure" | "stalled" | "aborted";
export type ObservationWaitStatus = "completed" | "failed" | "terminated" | "result-ready" | "stalled" | "timeout" | "aborted" | "not-found";
export interface ObservationTarget {
    kind: string;
    id: string;
}
export interface ObservationCapabilities {
    inspect: boolean;
    wait: boolean;
    cancel?: boolean;
    message?: boolean;
    supervise?: boolean;
}
export interface ObservationSnapshot {
    target: ObservationTarget;
    found: boolean;
    nativeStatus: string;
    phase: ObservationPhase;
    outcome?: ObservationOutcome;
    waitStatus?: ObservationWaitStatus;
    summary: string;
    detail?: string[];
    updatedAt: number;
    capabilities?: ObservationCapabilities;
    error?: string;
}
export interface ObservationReadOptions {
    detail: ObservationDetail;
    lines: number;
}
export interface ObservationWaitOptions extends ObservationReadOptions {
    deadline: number;
    signal: AbortSignal;
    /** When the wait settles: "result-ready" (default) or "completed" (terminal lifecycle). */
    until?: "result-ready" | "completed";
}
export interface ObservationProvider {
    kind: string;
    capabilities: ObservationCapabilities;
    snapshot(id: string, options: ObservationReadOptions): ObservationSnapshot | Promise<ObservationSnapshot>;
    wait(id: string, options: ObservationWaitOptions): Promise<ObservationSnapshot>;
}
export interface ObserveParams {
    action: ObservationAction;
    targets: ObservationTarget[];
    detail?: ObservationDetail;
    lines?: number;
    waitMode?: ObservationWaitMode;
    waitCount?: number;
    timeoutMs?: number;
    /** Block until "result-ready" (default) or "completed" (terminal lifecycle). */
    until?: "result-ready" | "completed";
}
export interface ObserveResult {
    action: ObservationAction;
    reason: "snapshot" | "all" | "any" | "count" | "timeout" | "aborted" | "watch";
    observations: ObservationSnapshot[];
    durationMs: number;
}
export declare function registerObservationProvider(provider: ObservationProvider): () => void;
export declare function getObservationProvider(kind: string): ObservationProvider | undefined;
export declare function listObservationProviders(): ObservationProvider[];
export declare function observeTargets(params: ObserveParams, signal?: AbortSignal): Promise<ObserveResult>;
export declare function formatObserveResult(result: ObserveResult, verbose?: boolean): string[];
