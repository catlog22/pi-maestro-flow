/**
 * Canonical agent status presentation.
 *
 * `AgentStatus` is the single canonical status vocabulary; every narrower
 * status union in the codebase is a subset of it. Rendering surfaces must not
 * re-derive icons, wording or colors from `status === "..."` chains — they look
 * the state up in `STATUS_PRESENTATION` and derive transient display states
 * (`result-ready`, `stalled`) through `effectiveDisplayStatus`.
 */
import type { ActiveAgent, AgentActivity, AgentStatus } from "./types.ts";
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
/**
 * Normalize `(status, resultReadyAt, lastActivityAt)` into the state the user
 * should see. A running agent that already produced its final assistant turn is
 * `result-ready`; one that has been silent past the stall threshold is
 * `stalled`. Every other status displays as itself.
 */
export declare function effectiveDisplayStatus(status: AgentStatus, resultReadyAt: number | undefined, lastActivityAt: number | undefined, nowSnapshot?: number): DisplayStatus;
export declare function projectAgentActivity(agent: Pick<ActiveAgent, "status" | "restart" | "sessionFile">): AgentActivity;
/** Whole seconds since the last reported activity; 0 when never reported. */
export declare function idleSeconds(lastActivityAt: number | undefined, nowSnapshot?: number): number;
