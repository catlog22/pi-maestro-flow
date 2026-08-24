import type { AnalysisResult, MonitorSupervisionMode } from "./monitor.ts";
export { MONITOR_SESSION_ENV_VAR } from "../runs/child-extensions.ts";
export declare const MONITOR_SESSION_NAME = "monitor-session";
export declare const MONITOR_SESSION_RELATIVE_DIR = ".pi/monitor-sessions";
export interface MonitorEvaluationTarget {
    key: string;
    endpointId: string;
    ownerId: string;
    ownerNonce: string;
    displayName: string;
    mode: MonitorSupervisionMode;
    customPrompt?: string;
    goalId?: string;
    goalContext?: string;
    trend?: string;
    status: string;
    idleSeconds: number;
    objective: string;
    outputTail: readonly string[];
    hasPendingInteractions: boolean;
    contextPressure?: number;
    activeBackgroundJobs?: readonly string[];
}
export interface MonitorEvaluationRequest {
    requestId: string;
    capturedAt: number;
    targets: readonly MonitorEvaluationTarget[];
}
export interface MonitorEvaluationVerdict extends AnalysisResult {
    target: string;
}
export interface MonitorEvaluationResponse {
    requestId: string;
    results: readonly MonitorEvaluationVerdict[];
}
export declare const MONITOR_EVALUATION_SCHEMA: Record<string, unknown>;
export declare function createMonitorEvaluationRequest(targets: readonly MonitorEvaluationTarget[], capturedAt?: number): MonitorEvaluationRequest;
export declare function buildMonitorEvaluationPrompt(request: MonitorEvaluationRequest): string;
export declare function validateMonitorEvaluationResponse(value: unknown, request: MonitorEvaluationRequest): {
    ok: true;
    response: MonitorEvaluationResponse;
    analyses: ReadonlyMap<string, AnalysisResult>;
} | {
    ok: false;
    reason: string;
};
export interface MonitorSessionInvocation {
    requestId: string;
    correlationId: string;
    promptSequence: number;
    /** Exact host-owned session object used to reject replacement sessions. */
    sessionIdentity: object;
}
export interface MonitorSessionTurnResult extends MonitorSessionInvocation {
    structuredOutput?: unknown;
    text?: string;
}
export interface MonitorSessionHost {
    invoke(request: MonitorEvaluationRequest, prompt: string, outputSchema: Record<string, unknown>, signal: AbortSignal): Promise<MonitorSessionInvocation>;
    waitForResult(invocation: MonitorSessionInvocation, signal: AbortSignal, isCurrent: () => boolean): Promise<MonitorSessionTurnResult>;
    /** Release an invocation when the caller's generation expires before result wait. */
    cancel?(invocation: MonitorSessionInvocation, reason: Error): void;
    stop(signal: AbortSignal): Promise<void>;
}
export type MonitorSessionEvaluation = {
    status: "ok";
    analyses: ReadonlyMap<string, AnalysisResult>;
    response: MonitorEvaluationResponse;
} | {
    status: "stale";
    reason: string;
} | {
    status: "invalid";
    reason: string;
};
/** Serializes all turns through one persistent, wakeable evaluator session. */
export declare class MonitorSessionEvaluator {
    #private;
    readonly host: MonitorSessionHost;
    constructor(host: MonitorSessionHost);
    evaluate(request: MonitorEvaluationRequest, signal: AbortSignal, isCurrent: () => boolean): Promise<MonitorSessionEvaluation>;
    quiesce(): Promise<void>;
}
