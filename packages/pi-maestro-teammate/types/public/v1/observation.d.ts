import type { AgentRuntimeDiagnosisV1, MessageProvenanceV1 } from "../../shared/types.ts";
export type ObservationAction = "status" | "diagnose" | "wait" | "watch";
export type ObservationDetail = "summary" | "tail" | "full";
export type ObservationView = "live" | "turns" | "session";
export type ObservationWaitMode = "all" | "any" | "count";
export type ObservationPhase = "pending" | "active" | "settled" | "unknown";
export type ObservationOutcome = "success" | "failure" | "stalled" | "aborted";
export type ObservationWaitStatus = "completed" | "failed" | "terminated" | "result-ready" | "stalled" | "timeout" | "aborted" | "not-found";
export interface ObservationTarget {
    kind: string;
    id: string;
    /** Opaque provider cursor for incremental views such as workspace session activity. */
    cursor?: string;
}
export interface ObservationCapabilities {
    inspect: boolean;
    wait: boolean;
    cancel?: boolean;
    message?: boolean;
    supervise?: boolean;
}
export interface ObservationPage {
    /** Provider-specific page kind. */
    kind: string;
    /** Cursor to continue after this page. */
    nextCursor?: string;
    /** True when events before this page were evicted from a bounded source. */
    gap?: boolean;
    /** Provider-specific structured items; text rendering remains in detail. */
    items: unknown[];
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
    /** Provider content revision used by watch to detect changes without a status transition. */
    revision?: string;
    /** Optional structured page for cursor-based observation views. */
    page?: ObservationPage;
    /** Canonical orthogonal teammate diagnosis; present for supported diagnose snapshots. */
    diagnosis?: AgentRuntimeDiagnosisV1;
}
export interface ObservationReadOptions {
    detail: ObservationDetail;
    lines: number;
    /** Request a canonical runtime diagnosis in addition to the ordinary snapshot. */
    diagnose?: boolean;
    /** "turns" lists target history; "session" shows sanitized workspace root-session activity. */
    view?: ObservationView;
    /** Opaque provider cursor copied from the selected target. */
    cursor?: string;
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
    /** "turns" lists history; "session" shows sanitized root-session activity for workspace targets. */
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
export declare function diagnosisProvenanceLine(label: "trigger" | "last-message", provenance: MessageProvenanceV1): string;
export declare function diagnosisDetail(diagnosis: AgentRuntimeDiagnosisV1): string[];
export declare function formatObserveResult(result: ObserveResult, verbose?: boolean): string[];
