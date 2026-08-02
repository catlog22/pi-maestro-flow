/**
 * Teammate monitor — persistent observation and supervision.
 *
 * Design principles:
 *   - Monitor is a MODE (like Plan): enter/exit lifecycle, persistent state,
 *     status-bar integration, compact output by default.
 *   - Token efficiency: default output is one compact line per target.
 *     Verbose output is opt-in.
 *
 * Pure algorithms with no dependency on extension/index.ts. The tool
 * registration in index.ts injects the watch/wait callbacks.
 */
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
export type MonitorSupervisionMode = "auto" | "custom";
/** A single intervention action taken by the engine. */
export interface InterventionRecord {
    timestamp: number;
    /** Why the intervention was triggered. */
    reason: "stalled" | "failed" | "interaction-needed" | "drift" | "custom";
    /** The corrective message sent to the agent. */
    message: string;
    mode: "steer" | "follow_up";
}
/** Binding between a monitor and a single session (1:1). */
export interface MonitorBinding {
    /** The monitored agent's correlationId. */
    correlationId: string;
    /** Display name for the session. */
    displayName: string;
    mode: MonitorSupervisionMode;
    customPrompt?: string;
    startedAt: number;
    lastCheckAt: number;
    lastInterventionAt: number;
    interventions: InterventionRecord[];
    /** Whether the latest analysis detected drift. */
    driftDetected: boolean;
    /** Last notified reason for dedup (avoid spamming main session). */
    lastNotifiedReason?: string;
}
/** Agent info snapshot provided by the host (index.ts) to the engine. */
export interface EngineAgentInfo {
    correlationId: string;
    name: string;
    status: string;
    idleSeconds: number;
    /** Recent output log lines (tail). */
    outputTail: string[];
    /** The original task prompt (from inbox[0] if available). */
    objective: string;
    /** Whether the agent has pending interactions (waiting on user). */
    hasPendingInteractions: boolean;
    /** "agent" for sub-agents, "window" for peer windows. */
    kind?: "agent" | "window";
}
/** Callbacks injected from index.ts for engine operations. */
export interface EngineCallbacks {
    /** Get current info for a monitored agent. Returns undefined if gone. */
    getAgentInfo: (correlationId: string) => EngineAgentInfo | undefined;
    /** Send an intervention message to an agent. */
    sendIntervention: (correlationId: string, message: string, mode: "steer" | "follow_up") => boolean | Promise<boolean>;
    /** Update the status bar text. */
    onStatusUpdate: (statusText: string | undefined) => void;
    /** Notify the main session (e.g., interaction needed). */
    notifyMain: (message: string) => void;
    /** LLM analysis (Phase C). Returns undefined if not available or failed. */
    analyze?: (binding: MonitorBinding, info: EngineAgentInfo) => Promise<AnalysisResult | undefined>;
}
/** Result from LLM drift analysis. */
export interface AnalysisResult {
    status: "on-track" | "drift";
    reason?: string;
    action?: "none" | "send";
    message?: string;
}
/** Minimum seconds between interventions on the same session. */
export declare const INTERVENTION_COOLDOWN_MS = 60000;
/** Engine tick interval. */
export declare const ENGINE_TICK_MS = 15000;
/** Idle threshold for stalled detection. */
export declare const ENGINE_STALL_IDLE_SECONDS = 60;
/** Max output lines to feed to analysis. */
export declare const ENGINE_ANALYSIS_TAIL_LINES = 20;
/** Max interventions recorded per binding. */
export declare const ENGINE_MAX_INTERVENTION_LOG = 20;
export interface MonitorEngineState {
    running: boolean;
    /** Guards against overlapping ticks. */
    ticking: boolean;
    bindings: Map<string, MonitorBinding>;
    timer?: ReturnType<typeof setInterval>;
    startedAt: number;
    callbacks?: EngineCallbacks;
    /** Aborts in-flight analysis on stop. */
    abortController?: AbortController;
}
export declare function createEngineState(): MonitorEngineState;
export declare function addBinding(engine: MonitorEngineState, correlationId: string, displayName: string, mode: MonitorSupervisionMode, customPrompt?: string): {
    ok: boolean;
    error?: string;
};
export declare function removeBinding(engine: MonitorEngineState, correlationId: string): boolean;
export declare function clearBindings(engine: MonitorEngineState): void;
export interface HeuristicResult {
    needsIntervention: boolean;
    reason?: InterventionRecord["reason"];
    message?: string;
    notifyOnly?: boolean;
}
export declare function heuristicCheck(info: EngineAgentInfo): HeuristicResult;
export declare function canIntervene(binding: MonitorBinding, now: number): boolean;
export declare function recordIntervention(binding: MonitorBinding, reason: InterventionRecord["reason"], message: string, mode: "steer" | "follow_up"): void;
/**
 * One engine tick: check all bindings, run heuristics, optionally run LLM
 * analysis, and intervene if needed.
 *
 * Returns the number of interventions taken.
 */
export declare function engineTick(engine: MonitorEngineState): Promise<number>;
export declare function startEngine(engine: MonitorEngineState, callbacks: EngineCallbacks): void;
export declare function stopEngine(engine: MonitorEngineState): void;
export declare function formatEngineStatusBar(engine: MonitorEngineState): string;
export declare function buildAutoAnalysisPrompt(objective: string, outputTail: string[]): string;
export declare function buildCustomAnalysisPrompt(customPrompt: string, objective: string, outputTail: string[]): string;
export declare function parseAnalysisResult(raw: string): AnalysisResult | undefined;
