/**
 * Version 1 cross-extension event contract.
 *
 * The teammate extension broadcasts three events on the shared `pi.events` bus.
 * They are the only supported integration point for out-of-process observers
 * (`pi-cockpit`, `pi-maestro-flow`'s GUI bridge) that must not import the
 * extension entry point — this module is a leaf: it re-exports the event-name
 * constants and declares the payload shapes, and pulls in nothing but the
 * dependency-free `shared/types.ts`.
 *
 * Consumers previously hard-coded `"teammate:started"` / `"teammate:message"` /
 * `"teammate:complete"` with a line-number comment pointing at the emitter.
 * Import from here instead; the strings are the same values the emitter uses.
 *
 * Emitters (pi-maestro-teammate/src/extension/index.ts):
 *   - `emitTeammateStarted` -> {@link TeammateStartedEvent}
 *   - `emitComplete`        -> {@link TeammateCompleteEvent}
 *   - `publishProgress`, the `teammate-send` tool, the attach overlay, and
 *     `handleChildInteractionRequest` -> {@link TeammateMessageEvent}
 */

import type {
  AgentProgressSnapshot,
  AgentStatus,
} from "../../shared/types.ts";

export {
  TEAMMATE_COMPLETE_EVENT,
  TEAMMATE_MESSAGE_EVENT,
  TEAMMATE_STARTED_EVENT,
} from "../../shared/types.ts";

/** Tool identity of one child tool call, as reported inside a progress payload. */
export interface TeammateEventTool {
  name: string;
  status: string;
}

/**
 * `teammate:started` — one agent process entered the roster.
 *
 * Re-emitted for the same `correlationId` when a run is restored or retried, so
 * receivers must treat it as an upsert rather than an insert.
 */
export interface TeammateStartedEvent {
  correlationId: string;
  /** Role name, or `graph(<n>)` for a DAG run. */
  agent: string;
  name?: string;
  /** `correlationId` of the dispatching agent; absent for a root dispatch. */
  spawnedBy?: string;
  /** Epoch milliseconds. */
  startedAt: number;
  /** Epoch milliseconds of the latest observed activity. */
  lastActivityAt?: number;
  status: AgentStatus;
  /** Tool-call id; present only when the run was started by a root `teammate` call. */
  id?: string;
}

/**
 * `teammate:complete` — one agent reached a terminal state.
 *
 * `exitCode !== 0` means failure; the failure reason is not carried here and
 * must be read from the last `teammate:message` tail.
 */
export interface TeammateCompleteEvent {
  /** Tool-call id when a root tool call owns the dispatch; absent for nested IPC. */
  id?: string;
  agent: string;
  correlationId: string;
  exitCode: number;
  durationMs: number;
  /** True when the agent entered sleeping (wakeable) state instead of being removed. */
  wakeable?: boolean;
  /** True when cancellation, rather than success/failure, ended the lifecycle. */
  cancelled?: boolean;
}

/**
 * `teammate:message` progress variant — a child reported tool/token activity.
 * `progress` carries the full snapshot of every task in the run, so a receiver
 * can rebuild an entire graph view from a single event.
 */
export interface TeammateProgressMessageEvent extends Omit<AgentProgressSnapshot, "correlationId"> {
  /** `correlationId` of the run that owns the graph. */
  correlationId: string;
  /** `correlationId` of the individual task the delta belongs to. */
  taskCorrelationId: string;
  /** Full authoritative snapshot for the run, including all graph tasks. */
  progress: AgentProgressSnapshot[];
  isSend?: undefined;
  isInteraction?: undefined;
}

/**
 * `teammate:message` send variant — the parent pushed a message into a child.
 * Carries no progress data; receivers that only track agent state can skip it.
 */
export interface TeammateSendMessageEvent {
  correlationId: string;
  from: "caller";
  /** Target selector exactly as the caller typed it, not a resolved id. */
  to: string;
  mode: "steer" | "follow_up" | "abort";
  message: string;
  /** Epoch milliseconds of the send operation. */
  lastActivityAt?: number;
  isSend: true;
  isInteraction?: undefined;
}

/**
 * `teammate:message` interaction variant — a relayed permission/question was
 * resolved. Unlike the other two variants `correlationId` may be `undefined`:
 * an interaction can arrive before its agent is correlated.
 */
export interface TeammateInteractionMessageEvent {
  correlationId: string | undefined;
  /** Display label, falling back to a correlation-id prefix or `"teammate"`. */
  agent: string;
  interaction: "permission" | "question";
  requestId: string;
  /** `allow_once` / `deny` / `cancel` / ... ; `unknown` because the UI layer owns the vocabulary. */
  action: unknown;
  isInteraction: true;
  isSend?: undefined;
}

/**
 * `teammate:message` — discriminate with the `isSend` / `isInteraction` flags:
 * a payload with neither flag is the progress variant.
 */
export type TeammateMessageEvent =
  | TeammateProgressMessageEvent
  | TeammateSendMessageEvent
  | TeammateInteractionMessageEvent;

/** Event name -> payload, for typing a subscription helper. */
export interface TeammateEventMap {
  "teammate:started": TeammateStartedEvent;
  "teammate:message": TeammateMessageEvent;
  "teammate:complete": TeammateCompleteEvent;
}
