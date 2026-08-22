/**
 * Version 1 cross-extension event contract.
 *
 * The teammate extension broadcasts lifecycle, registry, and window-thread
 * updates on the shared `pi.events` bus. Consumers should import event names
 * and payload types from this leaf module instead of the extension entry point.
 */
import type { AgentActivity, AgentProgressSnapshot, AgentRunOutcome, AgentStatus, StructuredResult, TeammateResultPublishedEvent } from "../../shared/types.ts";
import type { SessionHostSnapshot, WindowThreadSnapshot } from "../../sessions/session-core.ts";
export type { StructuredResult, TeammateExecutionProvenance, TeammateResultPublishedEvent, } from "../../shared/types.ts";
export { TEAMMATE_COMPLETE_EVENT, TEAMMATE_MESSAGE_EVENT, TEAMMATE_OPEN_AGENT_EVENT, TEAMMATE_RESULT_PUBLISHED_EVENT, TEAMMATE_STARTED_EVENT, TEAMMATE_VIEWING_EVENT, } from "../../shared/types.ts";
export { SESSION_HOST_REGISTRY_EVENT, WINDOW_THREAD_EVENT, } from "../../sessions/session-core.ts";
/** Flow diagnostics query for current session/Monitor availability authority. */
export declare const TEAMMATE_MODEL_SESSION_QUERY_EVENT = "teammate:model-session-query";
/** Teammate response carrying only session topology gates, never route config. */
export declare const TEAMMATE_MODEL_SESSION_EVENT = "teammate:model-session";
export declare const TEAMMATE_MODEL_SESSION_PROTOCOL_VERSION: 1;
export interface TeammateModelSessionQueryEventV1 {
    version: typeof TEAMMATE_MODEL_SESSION_PROTOCOL_VERSION;
    requestId: string;
}
export interface TeammateModelSessionEventV1 extends TeammateModelSessionQueryEventV1 {
    isChild: boolean;
    hasCurrentRootMonitorAuthority: boolean;
}
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
    /**
     * Full lifecycle status (F-003: restored to the original `AgentStatus`
     * union so consumers checking `"completed"` / `"failed"` / `"terminated"`
     * continue to work).
     */
    status: AgentStatus;
    /**
     * Two-state activity projection (`"running"` | `"sleeping"`). Additive
     * field for new consumers; absent when the emitter predates this field.
     */
    activity?: AgentActivity;
    phase?: string;
    lastOutcome?: AgentRunOutcome;
    /** Tool-call id; present only when the run was started by a root `teammate` call. */
    id?: string;
    /**
     * Optional Todo task id(s) bound to this agent at dispatch (`tasks[].todo`),
     * priority order. The host re-assigns each task's assignee to this agent on
     * start and activates the first runnable one. `todo` (single) is kept for
     * backward compatibility as the first binding.
     */
    todos?: string[];
    /** First Todo binding; kept for backward compatibility with single-binding consumers. */
    todo?: string;
}
/**
 * `teammate:complete` — one agent reached a terminal state.
 *
 * `exitCode !== 0` means non-success. Consumers must check `cancelled` before
 * classifying it as failure; cancellation is a distinct outcome.
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
    /**
     * Compact settled results for `agent://` persistence. Present when the
     * completed run produced structured output or a final assistant text.
     */
    structuredResults?: StructuredResult[];
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
    mode: "prompt" | "steer" | "follow_up" | "abort";
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
    /** Epoch milliseconds of the last agent activity; emitted alongside the interaction. */
    lastActivityAt?: number;
}
/**
 * `teammate:message` — discriminate with the `isSend` / `isInteraction` flags:
 * a payload with neither flag is the progress variant.
 */
export type TeammateMessageEvent = TeammateProgressMessageEvent | TeammateSendMessageEvent | TeammateInteractionMessageEvent;
/** Viewing-mode state change, broadcast so cockpit can highlight the viewed agent. */
export interface TeammateViewingEvent {
    correlationId: string;
    agent: string;
    name?: string;
    status: string;
    action: "enter" | "switch" | "exit";
}
/** Cockpit → teammate: open (or jump to) an agent's viewing view. */
export interface TeammateOpenAgentEvent {
    correlationId: string;
}
/** Event name -> payload, for typing a subscription helper. */
export interface TeammateEventMap {
    "teammate:started": TeammateStartedEvent;
    "teammate:message": TeammateMessageEvent;
    "teammate:result-published": TeammateResultPublishedEvent;
    "teammate:complete": TeammateCompleteEvent;
    "teammate:viewing": TeammateViewingEvent;
    "teammate:open-agent": TeammateOpenAgentEvent;
    "teammate:sessions": SessionHostSnapshot;
    "teammate:window-thread": WindowThreadSnapshot;
    "teammate:model-session-query": TeammateModelSessionQueryEventV1;
    "teammate:model-session": TeammateModelSessionEventV1;
}
