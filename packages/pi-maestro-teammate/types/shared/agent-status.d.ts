/**
 * Canonical agent status presentation.
 *
 * `AgentStatus` is the single canonical status vocabulary; every narrower
 * status union in the codebase is a subset of it. Rendering surfaces must not
 * re-derive icons, wording or colors from `status === "..."` chains — they look
 * the state up in `STATUS_PRESENTATION` and derive transient display states
 * (`result-ready`, `stalled`) through `effectiveDisplayStatus`.
 */
import { type ActiveAgent, type AgentActivity, type AgentHealthState, type AgentRunOutcome, type AgentRunPhase, type AgentRuntimeDiagnosisV1, type AgentRuntimeProjection, type AgentStatus, type AgentToolActivityState, type AgentTurnSnapshot } from "./types.ts";
/**
 * Semantic color slot. The names match both the Pi theme foreground slots
 * (`theme.fg(tone, text)`) and the `ProgressPalette` tone mapping used by the
 * ANSI-only overlay, so a tone can be resolved on either surface.
 */
export type StatusTone = "dim" | "accent" | "warning" | "success" | "error";
export interface StatusPresentation {
    icon: string;
    text: string;
    tone: StatusTone;
}
/** States that are never stored on an agent; they exist only for display. */
export type DerivedDisplayStatus = "result-ready" | "stalled";
export type DisplayStatus = AgentStatus | DerivedDisplayStatus;
/**
 * The one table every status renderer reads. Keyed by the canonical status, so
 * adding a state to `AgentStatus` fails compilation here first.
 */
export declare const STATUS_PRESENTATION: Readonly<Record<AgentStatus, StatusPresentation>>;
export declare const DERIVED_STATUS_PRESENTATION: Readonly<Record<DerivedDisplayStatus, StatusPresentation>>;
export declare function displayStatusPresentation(status: DisplayStatus): StatusPresentation;
export interface AgentStallProjection {
    status: AgentStatus | string;
    phase?: AgentRunPhase | string;
    resultReadyAt?: number;
    lastActivityAt?: number;
    pendingInteractions?: number;
}
export interface AgentRuntimeProjectionInput extends AgentStallProjection {
    inFlightToolCount?: number;
    turn?: AgentTurnSnapshot;
    /** Opt-in warning threshold below the canonical stall ceiling. */
    delayedThresholdMs?: number;
}
export declare function classifyAgentToolActivity(inFlightToolCount?: number, phase?: AgentRunPhase | string): AgentToolActivityState;
export declare function classifyAgentHealth(input: AgentRuntimeProjectionInput, nowSnapshot?: number, defaultIdleCeilingMs?: number): AgentHealthState;
export declare function projectAgentRuntime(input: AgentRuntimeProjectionInput, nowSnapshot?: number, defaultIdleCeilingMs?: number): AgentRuntimeProjection;
export interface AgentRuntimeDiagnosisInput extends AgentRuntimeProjectionInput {
    previousOutcome?: AgentRunOutcome;
    fallbackEligible?: boolean;
}
export declare function diagnoseAgentRuntime(input: AgentRuntimeDiagnosisInput, nowSnapshot?: number, defaultIdleCeilingMs?: number): AgentRuntimeDiagnosisV1;
export interface AgentPhaseProjection {
    status: string;
    phase?: AgentRunPhase | string;
    lastActivityAt?: number;
    recentTools?: readonly {
        status: string;
    }[];
}
/**
 * Projects a graph container from its live task phases. A running tool wins
 * (the container then inherits the never-stalled tool-execution phase);
 * otherwise the most recently active task supplies the expected-silence phase.
 */
export declare function aggregateAgentRunPhase(entries: readonly AgentPhaseProjection[]): AgentRunPhase | undefined;
/** Canonical idle ceiling shared by wait, notifications and every renderer. */
export declare function agentStallIdleCeilingMs(status: AgentStatus | string, phase?: AgentRunPhase | string, defaultIdleCeilingMs?: number): number;
/** Pure stalled projection; callers may provide one shared frame clock. */
export declare function isAgentStalled(projection: AgentStallProjection, nowSnapshot?: number, defaultIdleCeilingMs?: number): boolean;
/**
 * Normalize `(status, resultReadyAt, lastActivityAt, phase)` into the state the
 * user should see. Expected-silence phases use a bounded five-minute window;
 * tool execution never projects as stalled because the in-flight tool is the
 * child's own liveness report (the heartbeat only refreshes the clock as a
 * secondary signal).
 */
export declare function effectiveDisplayStatus(status: AgentStatus, resultReadyAt: number | undefined, lastActivityAt: number | undefined, nowSnapshot?: number, phase?: AgentRunPhase | string, pendingInteractions?: number): DisplayStatus;
export declare function projectAgentActivity(agent: Pick<ActiveAgent, "status" | "restart" | "sessionFile">): AgentActivity;
/** Whole seconds since the last reported activity; 0 when never reported. */
export declare function idleSeconds(lastActivityAt: number | undefined, nowSnapshot?: number): number;
