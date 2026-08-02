/**
 * Canonical agent status presentation.
 *
 * `AgentStatus` is the single canonical status vocabulary; every narrower
 * status union in the codebase is a subset of it. Rendering surfaces must not
 * re-derive icons, wording or colors from `status === "..."` chains — they look
 * the state up in `STATUS_PRESENTATION` and derive transient display states
 * (`result-ready`, `stalled`) through `effectiveDisplayStatus`.
 */

import { TEAMMATE_STALL_TIMEOUT_MS } from "./limits.ts";
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
export const STATUS_PRESENTATION: Readonly<Record<AgentStatus, StatusPresentation>> = Object.freeze({
  pending: { icon: "■", text: "running · starting", tone: "dim" },
  running: { icon: "■", text: "running", tone: "warning" },
  retrying: { icon: "■", text: "running · retrying", tone: "warning" },
  sleeping: { icon: "◉", text: "sleeping", tone: "warning" },
  completed: { icon: "◉", text: "sleeping · completed", tone: "success" },
  failed: { icon: "◉", text: "sleeping · failed", tone: "error" },
  terminated: { icon: "◉", text: "sleeping · terminated", tone: "warning" },
});

export const DERIVED_STATUS_PRESENTATION: Readonly<Record<DerivedDisplayStatus, StatusPresentation>> = Object.freeze({
  "result-ready": { icon: "◆", text: "result ready", tone: "success" },
  stalled: { icon: "▲", text: "stalled", tone: "error" },
});

export function displayStatusPresentation(status: DisplayStatus): StatusPresentation {
  return status === "result-ready" || status === "stalled"
    ? DERIVED_STATUS_PRESENTATION[status]
    : STATUS_PRESENTATION[status];
}

function unhandledStatus(status: never): never {
  throw new Error(`unhandled agent status: ${String(status)}`);
}

/**
 * Normalize `(status, resultReadyAt, lastActivityAt)` into the state the user
 * should see. A running agent that already produced its final assistant turn is
 * `result-ready`; one that has been silent past the stall threshold is
 * `stalled`. Every other status displays as itself.
 */
export function effectiveDisplayStatus(
  status: AgentStatus,
  resultReadyAt: number | undefined,
  lastActivityAt: number | undefined,
  now: number = Date.now(),
): DisplayStatus {
  switch (status) {
    case "running":
      if (resultReadyAt !== undefined) return "result-ready";
      return lastActivityAt !== undefined && now - lastActivityAt >= TEAMMATE_STALL_TIMEOUT_MS
        ? "stalled"
        : "running";
    case "pending":
    case "retrying":
    case "sleeping":
    case "completed":
    case "failed":
    case "terminated":
      return status;
    default:
      return unhandledStatus(status);
  }
}

export function projectAgentActivity(agent: Pick<ActiveAgent, "status" | "restart" | "sessionFile">): AgentActivity {
  // F-004: Terminal states are not "running". All settled statuses project
  // as sleeping; only active lifecycle states (pending/running/retrying)
  // project as running.
  switch (agent.status) {
    case "pending":
    case "running":
    case "retrying":
      return "running";
    case "sleeping":
    case "completed":
    case "failed":
    case "terminated":
      return "sleeping";
    default:
      return "running";
  }
}

/** Whole seconds since the last reported activity; 0 when never reported. */
export function idleSeconds(lastActivityAt: number | undefined, now: number = Date.now()): number {
  if (lastActivityAt === undefined) return 0;
  return Math.max(0, Math.floor((now - lastActivityAt) / 1000));
}
