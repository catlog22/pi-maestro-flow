/**
 * Teammate monitor — independent session supervision primitives.
 *
 * The user-facing Monitor is a user-entered/exited mode, like Plan, whose active
 * state is carried by an independent wakeable session. This module keeps
 * the pure target/supervision algorithms and ledger-compatible binding state;
 * the host extension no longer starts a MonitorEngine timer for /monitor.
 *
 * Pure algorithms with no dependency on extension/index.ts. The tool
 * registration in index.ts injects the observation and intervention callbacks.
 */
import { DeliveryGate } from "../supervision/delivery.ts";
import type { MonitorLedgerRecord } from "./monitor-ledger.ts";
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
export declare function appendMonitorModeContext(systemPrompt: string): string;
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
export type MonitorSupervisionMode = "auto" | "custom";
export interface PendingIntervention {
    traceId: string;
    at: number;
    reason: InterventionRecord["reason"];
    mode: "steer" | "follow_up";
    message: string;
}
/** One LLM drift-analysis verdict in the per-binding history. */
export interface AnalysisVerdictRecord {
    at: number;
    verdict: "on-track" | "drift";
}
/** Resolution of a previously sent intervention (closed loop). */
export type InterventionOutcome = "recovered" | "failed" | "repeated" | "escalated" | "abandoned";
/** A single intervention action taken by the engine. */
export interface InterventionRecord {
    timestamp: number;
    /** Why the intervention was triggered. */
    reason: "stalled" | "failed" | "interaction-needed" | "drift" | "custom";
    /** The corrective message sent to the agent. */
    message: string;
    mode: "steer" | "follow_up";
    traceId?: string;
    outcome?: InterventionOutcome;
    effectiveMode?: "steer" | "follow_up";
    deliveryStage?: "queued" | "injected";
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
    /** Per-binding intervention delivery gate (cooldown + dedup + window limit). */
    deliveryGate: DeliveryGate;
    /** Intervention awaiting outcome resolution on later ticks. */
    pendingIntervention?: PendingIntervention;
    /** Last recorded analysis verdict (ledger emits on flip only). */
    lastRecordedVerdict?: "on-track" | "drift";
    /** Bounded per-binding analysis history (drift signal input). */
    analysisHistory: AnalysisVerdictRecord[];
    /** Decay-weighted drift score derived from analysisHistory. */
    driftScore: number;
    /** Whether the drift score crossed the elevated threshold. */
    elevated: boolean;
    /** Consecutive unresolved repeats — persists across intervention cycles. */
    interventionStreak: number;
    /** Last escalation timestamp (bounds escalation frequency). */
    lastEscalatedAt: number;
    /** Whether this binding was restored from the ledger (auto-resume). */
    resumed?: boolean;
    /** Optional goal-board link (pi-peer `.pi/peer-goals.json` interop). */
    goalId?: string;
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
    /** Context pressure percentage of the monitored session (0-100). */
    contextPressure?: number;
    /** "agent" for sub-agents, "window" for peer windows. */
    kind?: "agent" | "window";
}
export interface InterventionDeliveryAck {
    delivered: boolean;
    requestedMode?: "steer" | "follow_up";
    effectiveMode?: "steer" | "follow_up";
    deliveryStage?: "queued" | "injected";
    deferred?: boolean;
}
/** Callbacks injected from index.ts for engine operations. */
export interface EngineCallbacks {
    /** Get current info for a monitored agent. Returns undefined if gone. */
    getAgentInfo: (correlationId: string) => EngineAgentInfo | undefined;
    /** Send an intervention message to an agent. */
    sendIntervention: (correlationId: string, message: string, mode: "steer" | "follow_up", traceId?: string) => boolean | InterventionDeliveryAck | Promise<boolean | InterventionDeliveryAck>;
    /** Exact lifecycle fence supplied by a host-owned deterministic runtime. */
    isCurrent?: (correlationId: string, binding: MonitorBinding) => boolean;
    /** Defer a missing-target removal to a quiescence-owning controller. */
    onBindingMissing?: (correlationId: string, binding: MonitorBinding) => void;
    /** Update the status bar text. */
    onStatusUpdate: (statusText: string | undefined) => void;
    /** Notify the main session (e.g., interaction needed). `target` is the binding key. */
    notifyMain: (message: string, target?: string) => void;
    /** LLM analysis (Phase C). Returns undefined if not available or failed. */
    analyze?: (binding: MonitorBinding, info: EngineAgentInfo) => Promise<AnalysisResult | undefined>;
    /** Durable ledger append (best-effort; engine never blocks on it). */
    recordLedger?: (record: MonitorLedgerRecord) => void | Promise<void>;
    /** Post a blocking objection to the goal board (best-effort). */
    postGoalObjection?: (goalId: string, summary: string, peerId: string) => void | Promise<void>;
}
/** Result from LLM drift analysis. */
export interface AnalysisResult {
    status: "on-track" | "drift";
    reason?: string;
    action?: "none" | "send";
    message?: string;
}
/**
 * JSON schema for structured LLM analysis output — shared with the
 * supervision evaluator (structured first, text fallback via
 * parseAnalysisResult).
 */
export declare const ANALYSIS_RESULT_SCHEMA: Record<string, unknown>;
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
/** Minimum interval between escalations of the same binding. */
export declare const ESCALATION_COOLDOWN_MS: number;
/** Max analysis verdicts kept per binding. */
export declare const ANALYSIS_HISTORY_MAX = 20;
/** Decay time constant for the drift score (ms). */
export declare const DRIFT_SCORE_HALF_LIFE_MS: number;
/** Weight of a drift verdict. */
export declare const DRIFT_SCORE_DRIFT_WEIGHT = 1;
/** Weight of an on-track verdict. */
export declare const DRIFT_SCORE_ON_TRACK_WEIGHT = -0.5;
/** Score at/above which a binding becomes elevated. */
export declare const DRIFT_SCORE_ELEVATED_THRESHOLD = 2;
/** Score at/below which an elevated binding clears (hysteresis). */
export declare const DRIFT_SCORE_CLEAR_THRESHOLD = 0.5;
/** Number of recent verdicts injected into analysis prompts. */
export declare const ANALYSIS_TREND_INJECTION = 5;
/**
 * Decay-weighted drift score (pi-peer signal-field pattern): each verdict
 * contributes +1 (drift) or −0.5 (on-track), weighted by exp(−age/τ) so old
 * incidents fade and a recovered agent's score returns toward zero.
 */
export declare function computeDriftScore(history: readonly AnalysisVerdictRecord[], now: number, options?: {
    halfLifeMs?: number;
}): number;
/**
 * Recent-verdict trend block injected into analysis prompts so the analyst
 * sees the trajectory, not just the latest tick (stateful analysis).
 */
export declare function buildAnalysisTrendBlock(history: readonly AnalysisVerdictRecord[], score: number, options?: {
    now?: number;
    inject?: number;
}): string;
export interface MonitorEngineConfig {
    /** Engine tick interval. */
    tickMs: number;
    /** Idle threshold for stalled detection (seconds). */
    stallIdleSeconds: number;
    /** Minimum interval between interventions on the same binding. */
    interventionCooldownMs: number;
    /** Delivery retries before dead-letter (0 = single attempt). */
    maxRetries: number;
    /** Linear backoff base between retries. */
    retryBackoffMs: number;
    /** Max interventions recorded per binding. */
    maxInterventionLog: number;
    /** Max output lines fed to drift analysis. */
    analysisTailLines: number;
    /** Repeated unresolved interventions before escalation to the user. */
    escalationThreshold: number;
    /** Minimum elapsed time before a pending intervention is evaluated. */
    pendingOutcomeEvalMs: number;
    /** Whether ledger records are appended (best-effort). */
    ledgerEnabled: boolean;
    /** Whether active ledger bindings are restored on session start. */
    autoResume: boolean;
    /** Context pressure % at which stalled interventions downgrade to compact requests. */
    contextCompactThresholdPercent: number;
}
export declare const DEFAULT_MONITOR_CONFIG: MonitorEngineConfig;
/**
 * Merge `.pi/settings.json` `monitor` section + env overrides onto defaults.
 * Mirrors pi-peer's normalizePeerIdleWatcherConfig(source, { env }).
 */
export declare function normalizeMonitorConfig(input?: unknown, options?: {
    env?: NodeJS.ProcessEnv;
}): MonitorEngineConfig;
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
    /** Effective engine configuration. */
    config: MonitorEngineConfig;
    /** Ledger records emitted before callbacks were wired (flushed on start/tick). */
    pendingLedgerRecords: MonitorLedgerRecord[];
}
export declare function createEngineState(): MonitorEngineState;
export interface AddBindingOptions {
    /** Restored from the durable ledger (auto-resume); not a fresh enter. */
    resumed?: boolean;
    /** Optional goal-board link: closure standards feed drift analysis. */
    goalId?: string;
}
export declare function addBinding(engine: MonitorEngineState, correlationId: string, displayName: string, mode: MonitorSupervisionMode, customPrompt?: string, options?: AddBindingOptions): {
    ok: boolean;
    error?: string;
};
export declare function removeBinding(engine: MonitorEngineState, correlationId: string, status?: string, reason?: string): boolean;
export declare function clearBindings(engine: MonitorEngineState): void;
/**
 * Record binding exits before the engine stops (user-exit / shutdown).
 * Must be called while callbacks are still wired.
 */
export declare function recordBindingExits(engine: MonitorEngineState, status: string, reason?: string): void;
/** Flush binding records without starting the host-owned monitor engine. */
export declare function flushPendingMonitorLedger(engine: MonitorEngineState, emit: (record: MonitorLedgerRecord) => void | Promise<void>): void;
export interface HeuristicResult {
    needsIntervention: boolean;
    reason?: InterventionRecord["reason"];
    message?: string;
    notifyOnly?: boolean;
}
export declare function heuristicCheck(info: EngineAgentInfo, contextCompactThresholdPercent?: number, stallIdleSeconds?: number): HeuristicResult;
export declare function canIntervene(binding: MonitorBinding, now: number, cooldownMs?: number): boolean;
export declare function recordIntervention(binding: MonitorBinding, reason: InterventionRecord["reason"], message: string, mode: "steer" | "follow_up", traceId?: string, delivery?: InterventionDeliveryAck): void;
export declare function createTraceId(): string;
/**
 * Send an intervention with bounded retry. Each attempt calls `send`;
 * `maxRetries` failures after the first attempt produce a dead-letter.
 * Backoff is linear (`backoffMs * attempt`), abortable via `signal`.
 */
export declare function sendInterventionWithRetry(send: (message: string, mode: "steer" | "follow_up") => boolean | InterventionDeliveryAck | Promise<boolean | InterventionDeliveryAck>, message: string, mode: "steer" | "follow_up", maxRetries: number, backoffMs: number, options?: {
    signal?: AbortSignal;
    sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
    isCurrent?: () => boolean;
}): Promise<{
    delivered: boolean;
    attempts: number;
    stale?: boolean;
} & Partial<InterventionDeliveryAck>>;
/**
 * One engine tick: check all bindings, run heuristics, optionally run LLM
 * analysis, and intervene if needed.
 *
 * Returns the number of interventions taken.
 */
export declare function engineTick(engine: MonitorEngineState): Promise<number>;
export declare function startEngine(engine: MonitorEngineState, callbacks: EngineCallbacks, config?: Partial<MonitorEngineConfig>): void;
export declare function stopEngine(engine: MonitorEngineState): void;
export interface MonitorMetrics {
    records: number;
    bindings: number;
    interventions: number;
    outcomes: number;
    recovered: number;
    repeated: number;
    escalated: number;
    failed: number;
    deadLetters: number;
    analysisVerdicts: number;
    driftVerdicts: number;
    /** interventions with a terminal outcome / total interventions */
    resolutionRate: number;
    /** recovered / terminal outcomes */
    recoveryRate: number;
    /** escalated outcomes / interventions */
    escalationRate: number;
    /** drift verdicts / all verdicts */
    driftRate: number;
}
/**
 * Metrics derived from the monitor ledger read-model (pi-peer metrics.mjs
 * pattern: derive, never record). Pure — unit-testable.
 */
export declare function deriveMonitorMetrics(state: {
    records: number;
    bindings: unknown[];
    interventions: MonitorLedgerRecord[];
    outcomes: MonitorLedgerRecord[];
    deadLetters: MonitorLedgerRecord[];
    analyses: MonitorLedgerRecord[];
}): MonitorMetrics;
export declare function formatMonitorMetrics(metrics: MonitorMetrics): string[];
export declare function formatEngineStatusBar(engine: MonitorEngineState): string;
export declare function buildAutoAnalysisPrompt(objective: string, outputTail: string[], tailLines?: number, trendBlock?: string, goalBlock?: string): string;
export declare function buildCustomAnalysisPrompt(customPrompt: string, objective: string, outputTail: string[], tailLines?: number, trendBlock?: string, goalBlock?: string): string;
export declare function parseAnalysisResult(raw: string): AnalysisResult | undefined;
