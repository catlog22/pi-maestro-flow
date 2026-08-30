/**
 * Teammate monitor — root-mode supervision primitives.
 *
 * Pure context, snapshot, state, barrier, and validation helpers with no
 * dependency on extension/index.ts.
 */
import type { MonitorWindowAttentionV1, MonitorWindowCardV1, MonitorWindowIdentityV1, MonitorWindowStateV1 } from "../public/v1/monitor-window-state.ts";
/** LLM-callable actions (enter/exit are user-only via /monitor command). */
export type MonitorAction = "status" | "wait";
export type MonitorWaitMode = "all" | "any" | "count";
/** A single target's observed state — compact by design. */
export interface MonitorTargetSnapshot {
    name: string;
    found: boolean;
    error?: string;
    /** Agent status: pending/running/retrying/sleeping/completed/failed */
    agentStatus?: string;
    /** Wait-level status when settled (completed/failed/stalled/result-ready) */
    waitStatus?: string;
    idleSeconds?: number;
    /** One-line summary (last meaningful output line, truncated) */
    summary: string;
    /** Full watch output lines — only populated when verbose is requested */
    detail?: string[];
}
export interface MonitorParams {
    action: MonitorAction;
    targets: string[];
    waitMode?: MonitorWaitMode;
    waitCount?: number;
    timeoutMs?: number;
    lines?: number;
    verbose?: boolean;
}
export declare const MONITOR_STATUS_KEY = "teammate-monitor";
export declare const MONITOR_DEFAULT_TIMEOUT_MS: number;
export declare const MONITOR_DEFAULT_LINES = 3;
export declare const MONITOR_MAX_TARGETS = 15;
/** Status-bar refresh interval while monitor mode is active. */
export declare const MONITOR_STATUS_REFRESH_MS = 5000;
export declare const MONITOR_MODE_CONTEXT_START = "<monitor_mode>";
export declare const MONITOR_MODE_CONTEXT_END = "</monitor_mode>";
export declare function stripMonitorModeContext(systemPrompt: string): string;
export declare function appendMonitorModeContext(systemPrompt: string): string;
export declare function applyMonitorModeContext(systemPrompt: string, active: boolean): string;
/** Extract active prompt loops from the Flow loop service's event snapshot. */
export declare function activePromptLoopIdsFromPayload(payload: unknown): string[] | undefined;
export declare function statusIcon(status?: string): string;
/** One-line-per-target compact format. Default for all output. */
export declare function formatCompact(targets: MonitorTargetSnapshot[]): string[];
/** Verbose format: compact line + indented detail. Opt-in only. */
export declare function formatVerbose(targets: MonitorTargetSnapshot[]): string[];
/** Header line: counts only, no per-target detail. */
export declare function formatHeader(targets: MonitorTargetSnapshot[]): string;
/** Status bar value: ultra-compact, e.g. "MON 2/3 · 45s" */
export declare function formatStatusBar(targets: MonitorTargetSnapshot[], startedAt: number): string;
export type TargetResolver = (name: string, lines: number) => MonitorTargetSnapshot;
export declare function takeSnapshot(resolve: TargetResolver, targets: string[], lines: number): MonitorTargetSnapshot[];
export interface MonitorModeState {
    active: boolean;
    targets: string[];
    startedAt: number;
    verbose: boolean;
    timer?: ReturnType<typeof setInterval>;
    lastSnapshot: MonitorTargetSnapshot[];
}
export declare function createMonitorModeState(): MonitorModeState;
/**
 * Start the monitor mode background refresh.
 * Calls `onRefresh` every MONITOR_STATUS_REFRESH_MS with the latest snapshot.
 * The timer is unref'd so it never prevents process exit.
 */
export declare function startMonitorMode(modeState: MonitorModeState, targets: string[], verbose: boolean, capture: () => MonitorTargetSnapshot[], onRefresh: (snapshot: MonitorTargetSnapshot[]) => void): void;
export declare function stopMonitorMode(modeState: MonitorModeState): void;
export interface BarrierEntry {
    name: string;
    promise: Promise<{
        status: string;
        output: string[];
    }>;
}
export interface BarrierSettled {
    name: string;
    status: string;
    output: string[];
}
/**
 * Waits for multiple targets according to the barrier mode.
 * Remaining waits are aborted via the provided AbortController once the
 * condition is met.
 */
export declare function barrierWait(entries: BarrierEntry[], mode: MonitorWaitMode, count: number, abortController: AbortController): Promise<{
    settled: BarrierSettled[];
    exitReason: string;
}>;
/** Compact barrier result — one line per target. */
export declare function formatBarrierCompact(settled: BarrierSettled[], exitReason: string, durationMs: number): string[];
export declare function validateMonitorParams(params: MonitorParams): string | undefined;
/** The new `monitor` tool is deliberately narrower than the provider-level `observe` tool. */
export type MonitorQueryAction = "list" | "get" | "wait";
export type MonitorQueryDetail = "summary" | "full";
export type MonitorQueryUntil = "change" | "attention" | "settled";
export interface MonitorQueryParams {
    action: MonitorQueryAction;
    target?: string;
    detail?: MonitorQueryDetail;
    cursor?: string;
    until?: MonitorQueryUntil;
    timeoutMs?: number;
}
/** Root Pi session plus one admitted Monitor generation. */
export interface MonitorQueryAuthorityFence {
    rootGeneration: number;
    sessionId: string;
    workspaceId: string;
    sourceId: string;
    monitorGeneration: number;
}
export interface MonitorQueryTimelineEntry {
    at?: number;
    label: string;
    detail?: string;
}
export interface MonitorQueryTimelineGroup {
    group: string;
    entries: readonly MonitorQueryTimelineEntry[];
}
/** Exact address and optional bounded timeline for one card in a captured state. */
export interface MonitorQueryTargetSnapshot {
    target: string;
    aliases?: readonly string[];
    identity: MonitorWindowIdentityV1;
    timeline?: readonly MonitorQueryTimelineGroup[];
}
export interface MonitorQuerySnapshot {
    state: MonitorWindowStateV1;
    targets: readonly MonitorQueryTargetSnapshot[];
}
export interface MonitorQueryDependencies {
    captureAuthority(): MonitorQueryAuthorityFence | undefined;
    isAuthorityCurrent(capture: MonitorQueryAuthorityFence): boolean;
    /**
     * Refresh providers, capture exact endpoints/owners, await facets, then
     * revalidate those exact captures before returning.
     */
    read(capture: MonitorQueryAuthorityFence, signal: AbortSignal): Promise<MonitorQuerySnapshot>;
    /** A wake hint only. The adapter always performs a fresh, fenced read afterward. */
    waitForWake?(capture: MonitorQueryAuthorityFence, timeoutMs: number, signal: AbortSignal): Promise<void>;
}
export type MonitorQueryStatus = "ok" | "not-found" | "timeout" | "aborted" | "stale";
export interface MonitorQueryWindow {
    /** Exact address retained from the first fenced snapshot. */
    target: string;
    /** Window-scoped semantic cursor; changes in other windows do not advance it. */
    cursor: string;
    window: MonitorWindowCardV1;
    /** Present only for detail=full and therefore only for get/wait. */
    timeline?: readonly MonitorQueryTimelineGroup[];
}
export interface MonitorQueryResult {
    version: 1;
    action: MonitorQueryAction;
    status: MonitorQueryStatus;
    observedAt: number;
    stateRevision?: string;
    cursor?: string;
    windows: readonly MonitorQueryWindow[];
    attention: readonly MonitorWindowAttentionV1[];
    reason?: string;
}
export declare const MONITOR_QUERY_DEFAULT_TIMEOUT_MS: number;
export declare const MONITOR_QUERY_POLL_MS = 250;
/**
 * Execute one window-domain Monitor query.
 *
 * Authority is checked before and after every await. Wait captures one exact
 * owner identity from its start snapshot and never silently follows a selector
 * to a replacement owner.
 */
export declare function runMonitorQuery(params: MonitorQueryParams, dependencies: MonitorQueryDependencies, signal: AbortSignal): Promise<MonitorQueryResult>;
/** Compact model-facing rendering; list never includes per-window timeline content. */
export declare function formatMonitorQueryResult(result: MonitorQueryResult): string[];
