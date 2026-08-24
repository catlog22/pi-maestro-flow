import type { AgentRuntimeDiagnosisV1 } from "../../shared/types.ts";
export type ObservationAction = "status" | "diagnose" | "wait" | "watch";
export type ObservationDetail = "summary" | "tail" | "full";
export type ObservationView = "live" | "turns";
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
    /** Canonical terminal outcome when the target has settled (completed|failed|terminated). */
    terminalStatus?: string;
    /** Last captured result text of the settled agent. */
    lastResult?: string;
    /** Schema-valid structured output of a settled schema task (detail=full). */
    structuredOutput?: unknown;
    /** Canonical orthogonal teammate diagnosis; present for supported diagnose snapshots. */
    diagnosis?: AgentRuntimeDiagnosisV1;
}
export interface ObservationReadOptions {
    detail: ObservationDetail;
    lines: number;
    /** Request a canonical runtime diagnosis in addition to the ordinary snapshot. */
    diagnose?: boolean;
    /** "turns" lists the target session's turn history instead of the live snapshot (status only). */
    view?: ObservationView;
    /** 1-based turn index to expand when view="turns"; omitted lists all turns. */
    turn?: number;
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
    /** "turns" lists session turn history instead of the live snapshot (status only). */
    view?: ObservationView;
    /** 1-based turn index to expand when view="turns"; omitted lists all turns. */
    turn?: number;
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
