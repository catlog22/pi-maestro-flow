/**
 * Canonical agent status presentation.
 *
 * `AgentStatus` is the single canonical status vocabulary; every narrower
 * status union in the codebase is a subset of it. Rendering surfaces must not
 * re-derive icons, wording or colors from `status === "..."` chains — they look
 * the state up in `STATUS_PRESENTATION` and derive transient display states
 * (`result-ready`, `stalled`) through `effectiveDisplayStatus`.
 */

import {
  TEAMMATE_EXPECTED_SILENCE_TIMEOUT_MS,
  TEAMMATE_STALL_TIMEOUT_MS,
} from "./limits.ts";
import {
  unknownMessageProvenanceV1,
  type ActiveAgent,
  type AgentActivity,
  type AgentHealthState,
  type AgentRunOutcome,
  type AgentRunPhase,
  type AgentRuntimeDiagnosisV1,
  type AgentRuntimeProjection,
  type AgentStatus,
  type AgentToolActivityState,
  type AgentTurnSnapshot,
} from "./types.ts";

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

const EXPECTED_SILENCE_PHASES: ReadonlySet<AgentRunPhase> = new Set<AgentRunPhase>([
  "starting",
  "restoring",
  "prompting",
  "compacting",
  "continuing",
  "settling",
]);

const QUEUE_WAIT_PHASES: ReadonlySet<AgentRunPhase> = new Set<AgentRunPhase>([
  "waiting-dependency",
  "waiting-capacity",
]);

/**
 * A child-reported in-flight tool is the agent's own liveness report: the
 * child keeps this phase only while `inFlightToolCount > 0` and republishes
 * it with every heartbeat. The 10s heartbeat merely refreshes `lastActivityAt`
 * as a secondary signal, so a busy child loop (heavy tool I/O) that drops
 * ticks must not turn a genuinely busy agent into a false stall. The tool's
 * lifecycle events (tool end / agent_end / close) and the wait timeout remain
 * the backstops for a tool that never completes.
 */
const TOOL_EXECUTION_PHASES: ReadonlySet<AgentRunPhase> = new Set<AgentRunPhase>([
  "tool-execution",
]);

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

export function classifyAgentToolActivity(
  inFlightToolCount?: number,
  phase?: AgentRunPhase | string,
): AgentToolActivityState {
  if (typeof inFlightToolCount === "number") return inFlightToolCount > 0 ? "active" : "idle";
  if (phase === "tool-execution") return "active";
  return phase === undefined ? "unknown" : "idle";
}

export function classifyAgentHealth(
  input: AgentRuntimeProjectionInput,
  nowSnapshot = Date.now(),
  defaultIdleCeilingMs = TEAMMATE_STALL_TIMEOUT_MS,
): AgentHealthState {
  if (input.status === "completed" || input.status === "failed" || input.status === "terminated" || input.status === "sleeping") return "healthy";
  if (input.status !== "running" && input.status !== "pending" && input.status !== "retrying") return "unknown";
  if (input.resultReadyAt !== undefined || input.turn?.resultReadyAt !== undefined
    || (input.pendingInteractions ?? 0) > 0
    || input.phase === "waiting-dependency" || input.phase === "waiting-capacity") return "healthy";
  if (isAgentStalled(input, nowSnapshot, defaultIdleCeilingMs)) return "stalled";
  if (input.delayedThresholdMs !== undefined && input.lastActivityAt !== undefined
    && nowSnapshot - input.lastActivityAt >= input.delayedThresholdMs) return "delayed";
  return "healthy";
}

export function projectAgentRuntime(
  input: AgentRuntimeProjectionInput,
  nowSnapshot = Date.now(),
  defaultIdleCeilingMs = TEAMMATE_STALL_TIMEOUT_MS,
): AgentRuntimeProjection {
  return {
    lifecycle: input.status as AgentStatus,
    health: classifyAgentHealth(input, nowSnapshot, defaultIdleCeilingMs),
    ...(input.phase === undefined ? {} : { phase: input.phase as AgentRunPhase }),
    activity: input.status === "pending" || input.status === "running" || input.status === "retrying" ? "running" : "sleeping",
    toolActivity: classifyAgentToolActivity(input.inFlightToolCount, input.phase),
    resultReady: input.resultReadyAt !== undefined || input.turn?.resultReadyAt !== undefined,
  };
}

export interface AgentRuntimeDiagnosisInput extends AgentRuntimeProjectionInput {
  previousOutcome?: AgentRunOutcome;
  fallbackEligible?: boolean;
}

export function diagnoseAgentRuntime(
  input: AgentRuntimeDiagnosisInput,
  nowSnapshot = Date.now(),
  defaultIdleCeilingMs = TEAMMATE_STALL_TIMEOUT_MS,
): AgentRuntimeDiagnosisV1 {
  const runtime = projectAgentRuntime(input, nowSnapshot, defaultIdleCeilingMs);
  let reasonCode: AgentRuntimeDiagnosisV1["reasonCode"];
  if (runtime.activity === "sleeping") reasonCode = "terminal";
  else if (runtime.resultReady) reasonCode = "result-ready";
  else if ((input.pendingInteractions ?? 0) > 0) reasonCode = "pending-interaction";
  else if (runtime.phase === "waiting-dependency") reasonCode = "waiting-dependency";
  else if (runtime.phase === "waiting-capacity") reasonCode = "waiting-capacity";
  else if (runtime.health === "stalled" && runtime.phase === "settling") reasonCode = "awaiting-agent-settled";
  else if (runtime.health === "stalled") reasonCode = "inactive-timeout";
  else if (runtime.toolActivity === "active") reasonCode = "tool-active";
  else if (runtime.lifecycle === "retrying" || runtime.phase === "retrying") reasonCode = "retrying";
  else if (runtime.phase === "compacting") reasonCode = "compacting";
  else if (runtime.phase === "restoring") reasonCode = "restoring";
  else if (runtime.phase === "prompting") reasonCode = "prompting";
  else if (runtime.phase === "continuing") reasonCode = "continuing";
  else if (runtime.health === "delayed") reasonCode = "expected-silence";
  else if (runtime.health === "unknown" && input.turn === undefined) reasonCode = "legacy-unknown";
  else reasonCode = "active";
  return {
    version: 1,
    ...runtime,
    reasonCode,
    trigger: input.turn?.trigger ?? unknownMessageProvenanceV1(),
    ...(input.turn?.lastMessage ? { lastMessage: input.turn.lastMessage } : {}),
    ...(input.previousOutcome ? { previousOutcome: { ...input.previousOutcome } } : {}),
    fallbackDisposition: runtime.phase === "settling"
      ? "ineligible"
      : input.fallbackEligible === true ? "eligible"
        : input.fallbackEligible === false ? "ineligible" : "unknown",
  };
}

export interface AgentPhaseProjection {
  status: string;
  phase?: AgentRunPhase | string;
  lastActivityAt?: number;
  recentTools?: readonly { status: string }[];
}

/**
 * Projects a graph container from its live task phases. A running tool wins
 * (the container then inherits the never-stalled tool-execution phase);
 * otherwise the most recently active task supplies the expected-silence phase.
 */
export function aggregateAgentRunPhase(
  entries: readonly AgentPhaseProjection[],
): AgentRunPhase | undefined {
  const active = entries.filter((entry) =>
    entry.status === "running" || entry.status === "pending" || entry.status === "retrying"
  );
  if (active.length === 0 && entries.length > 0) return "settling";
  if (active.some((entry) => entry.recentTools?.some((tool) => tool.status === "running"))) {
    return "tool-execution";
  }
  const latest = active.reduce<AgentPhaseProjection | undefined>(
    (selected, entry) => selected === undefined
      || (entry.lastActivityAt ?? 0) > (selected.lastActivityAt ?? 0)
      ? entry
      : selected,
    undefined,
  );
  if (latest?.phase !== undefined) return latest.phase as AgentRunPhase;
  if (latest?.status === "pending") return "starting";
  if (latest?.status === "retrying") return "retrying";
  return undefined;
}

/** Canonical idle ceiling shared by wait, notifications and every renderer. */
export function agentStallIdleCeilingMs(
  status: AgentStatus | string,
  phase?: AgentRunPhase | string,
  defaultIdleCeilingMs = TEAMMATE_STALL_TIMEOUT_MS,
): number {
  if (phase !== undefined && TOOL_EXECUTION_PHASES.has(phase as AgentRunPhase)) {
    // An in-flight tool is liveness itself, not silence: never age it into a
    // stall, no matter how long the tool runs or how many heartbeat ticks a
    // busy child loop drops.
    return Number.POSITIVE_INFINITY;
  }
  if (status === "running" && phase === "retrying") return TEAMMATE_EXPECTED_SILENCE_TIMEOUT_MS;
  return status === "pending" || (phase !== undefined && EXPECTED_SILENCE_PHASES.has(phase as AgentRunPhase))
    ? TEAMMATE_EXPECTED_SILENCE_TIMEOUT_MS
    : defaultIdleCeilingMs;
}

/** Pure stalled projection; callers may provide one shared frame clock. */
export function isAgentStalled(
  projection: AgentStallProjection,
  nowSnapshot = Date.now(),
  defaultIdleCeilingMs = TEAMMATE_STALL_TIMEOUT_MS,
): boolean {
  if ((projection.status !== "running" && projection.status !== "pending")
    || projection.resultReadyAt !== undefined) return false;
  if (projection.phase !== undefined && (QUEUE_WAIT_PHASES.has(projection.phase as AgentRunPhase)
    || TOOL_EXECUTION_PHASES.has(projection.phase as AgentRunPhase))) {
    return false;
  }
  if ((projection.pendingInteractions ?? 0) > 0 || projection.lastActivityAt === undefined) return false;
  return nowSnapshot - projection.lastActivityAt >= agentStallIdleCeilingMs(
    projection.status,
    projection.phase,
    defaultIdleCeilingMs,
  );
}

/**
 * Normalize `(status, resultReadyAt, lastActivityAt, phase)` into the state the
 * user should see. Expected-silence phases use a bounded five-minute window;
 * tool execution never projects as stalled because the in-flight tool is the
 * child's own liveness report (the heartbeat only refreshes the clock as a
 * secondary signal).
 */
export function effectiveDisplayStatus(
  status: AgentStatus,
  resultReadyAt: number | undefined,
  lastActivityAt: number | undefined,
  nowSnapshot: number = Date.now(),
  phase?: AgentRunPhase | string,
  pendingInteractions = 0,
): DisplayStatus {
  switch (status) {
    case "running":
      if (resultReadyAt !== undefined) return "result-ready";
      return isAgentStalled({
        status,
        phase,
        lastActivityAt,
        pendingInteractions,
      }, nowSnapshot)
        ? "stalled"
        : "running";
    case "pending":
      return isAgentStalled({
        status,
        phase,
        lastActivityAt,
        pendingInteractions,
      }, nowSnapshot)
        ? "stalled"
        : "pending";
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
export function idleSeconds(
  lastActivityAt: number | undefined,
  nowSnapshot: number = Date.now(),
): number {
  if (lastActivityAt === undefined) return 0;
  return Math.max(0, Math.floor((nowSnapshot - lastActivityAt) / 1000));
}
