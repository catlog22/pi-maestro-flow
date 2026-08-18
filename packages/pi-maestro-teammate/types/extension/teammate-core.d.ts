/**
 * Teammate Extension Entry Point
 *
 * Tools: teammate (dispatch), teammate-send (RPC message injection), teammate-list (status), observe
 * TUI: Alt+R mode-aware session list, widget above editor, Alt+B foreground→background detach
 * Mode: RPC subprocess — stdin open for steer/follow_up/abort
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { WorkspaceSessionScan } from "../transcript/session-transcript.ts";
import type { RecentToolInfo } from "../shared/types.ts";
import { type WorkspaceBackgroundJobSnapshot, type WorkspaceOwnerState } from "./workspace-peers.ts";
import { type LeaseToken } from "../runs/session-handoff.ts";
import type { RunTeammateOptions, RpcMessageMode, NormalizedTask } from "../runs/execution.ts";
import type { TeammateState, AgentProgress, AgentProgressSnapshot, AgentRunPhase, ActiveAgent, AgentStatus, AgentTerminalStatus, SingleResult, StructuredResult } from "../shared/types.ts";
import { TEAMMATE_STALL_TIMEOUT_MS } from "../shared/limits.ts";
export { TEAMMATE_STALL_TIMEOUT_MS };
export declare const TEAMMATE_PROMPT_SNIPPET = "Dispatch bounded work to discovered teammate roles for parallel, sequential, or specialist execution.";
export declare const TEAMMATE_PROMPT_GUIDELINES: string[];
export declare function terminalStatusForResult(result: SingleResult, callbackStatus?: AgentTerminalStatus): AgentTerminalStatus;
export declare function resultIsError(result: SingleResult): boolean;
export declare function aggregateTerminalStatus(results: readonly SingleResult[]): AgentTerminalStatus;
/**
 * Aggregates per-task lifecycle statuses recorded at terminal time. Graph
 * publications now carry publish-time results (the release boundary), so
 * container settlement and completion events derive their truth here instead
 * of from the publication.
 */
export declare function aggregateTerminalStatuses(statuses: Iterable<AgentTerminalStatus | undefined>): AgentTerminalStatus;
/**
 * Hard ceiling for the no-reference fallback (persistence unavailable: capture
 * extension absent, store at capacity, or I/O failure). Deliberately generous —
 * the fallback exists so results are never lost behind a dead agent:// link —
 * but without it a single teammate answer can dump hundreds of K chars into
 * the parent context, where nothing can prune it (the result carries no
 * replayable URI). ~8K tokens keeps even the degraded path bounded.
 */
export declare const UNPERSISTED_RESULT_INLINE_CAP_CHARS = 32000;
export declare function displayMessageForResult(result: SingleResult): string;
export declare function summarizeGraphResults(results: readonly SingleResult[], tasks: readonly NormalizedTask[]): string;
export declare function aggregateGraphStructuredOutput(results: readonly SingleResult[], tasks: readonly NormalizedTask[]): Record<string, unknown> | undefined;
/**
 * Final assistant answer of a settled result: the last non-empty assistant
 * message, or the last non-empty message of any role (e.g. a failure
 * diagnostic) when no assistant text survived. Empty only when the transcript
 * is empty.
 */
export declare function finalResultText(result: SingleResult): string | undefined;
/**
 * Compact projection of settled results for completion events. Each entry
 * carries either the schema-valid `structuredOutput` or, when the task had no
 * outputSchema, the final assistant text as `output`. Undefined when no result
 * produced either, so emitters can spread it conditionally and keep the event
 * payload minimal.
 */
export declare function toStructuredResults(results: readonly SingleResult[], originCwd: string): StructuredResult[] | undefined;
/** Publish one consumable result and await durable work claimed by listeners. */
export declare function emitTeammateResultPublished(pi: ExtensionAPI, result: SingleResult, originCwd: string): Promise<void>;
/** Replace the retained turn value; undefined intentionally clears stale data. */
export declare function setAgentStructuredOutput(agent: ActiveAgent, output: unknown): void;
export type TeammateRuntimeOptions = Pick<RunTeammateOptions, "spawnChildProcess" | "resultReadyGraceMs" | "foregroundMaxRunMs"> & {
    /** @internal Observes the real runtime callbacks for public-path lifecycle tests. */
    onRunOptionsCreated?: (options: RunTeammateOptions) => void;
};
export declare function buildTeammateToolDescription(cwd: string, options?: {
    nested?: boolean;
}): string;
export declare const LOCAL_TEAMMATE_LIST_DESCRIPTION = "List roles or teammate agents owned by this Pi process. view defaults to \"active\".\n\n- \"active\": live local agents except completed entries\n- \"named\": addressable local agents\n- \"all\": all tracked local agents\n- \"roles\": builtin, project, and user-defined role definitions";
export declare const LOCAL_TEAMMATE_LIST_SNIPPET = "List local teammate roles or agent status.";
export declare const LOCAL_TEAMMATE_LIST_GUIDELINES: string[];
export declare const TEAMMATE_SEND_DESCRIPTION = "Send a typed message to a running or sleeping teammate agent, addressed by name, @name, displayed name#id-prefix, correlation ID (or prefix), or a cross-session target such as owner:<ownerId> or owner:<ownerId>:<correlationId>. Cross-session targets do not require Monitor mode to send: discovering windows through teammate-list view=windows does, and an incoming workspace message carries its sender address, which is a valid reply target.\n\nModes: \"steer\" | \"follow_up\" (default) | \"abort\" \u2014 per-mode semantics and the message requirement are in the mode and message parameter descriptions. Cross-session targets support only \"steer\" and \"follow_up\".\n\nCross-session kinds: \"coordination\" (default, execution constraints only), \"request\" (a peer request without human authorization), \"status\" (informational and always queued), or \"supervision\" (safety/lifecycle constraints). The kind does not alter local-agent direct-message behavior. A queued or accepted cross-session receipt confirms enqueueing only, not that the target model consumed the message; do not resend it without new evidence.";
export declare const TEAMMATE_SEND_SNIPPET = "Send a typed coordination, request, status, or supervision message to a teammate target.";
export declare const TEAMMATE_SEND_GUIDELINES: string[];
export declare const TEAMMATE_LIST_DESCRIPTION = "List available roles, teammate agents, cross-session windows, or persisted window messages. view defaults to \"active\". Sending is reserved for new information, corrections, explicit response requests, safety/lifecycle constraints, or termination; routine acknowledgements/status pings and resends of queued messages are prohibited.\n\n- \"active\": live agents except completed entries\n- \"named\": addressable agents\n- \"all\": all tracked live entries\n- \"roles\": builtin, project, and user-defined role definitions\n- \"windows\": available peer Pi windows and their addressable targets\n- \"inbox\": persisted cross-window messages from current and reclaimed sessions; supports session, peer, direction, status, and limit filters. Queued or accepted entries confirm persistence/enqueueing, not target-model consumption";
export declare const TEAMMATE_LIST_SNIPPET = "List teammate roles, agent status, cross-session windows, or persisted window messages.";
export declare const TEAMMATE_LIST_GUIDELINES: string[];
export declare const TEAMMATE_WATCH_DESCRIPTION = "Perform a one-shot inspection of a running or sleeping teammate agent's recent output, tool activity, inbox messages, and last result \u2014 including the structured_output value for schema tasks. This returns one snapshot, unlike observe action=\"watch\" which polls until its timeoutMs; it is not a completion-wait tool.";
export declare const TEAMMATE_WATCH_SNIPPET = "Inspect a specific teammate agent's recent activity and output.";
export declare const TEAMMATE_WATCH_GUIDELINES: string[];
export declare const TEAMMATE_WAIT_DESCRIPTION = "Wait once for a teammate result by name, or provide waitMs for a fixed delay. Named waits default to a bounded 600000 ms (10 minutes) timeout and settle on result-ready (not terminal lifecycle); they are the single-target convenience form of observe action=\"wait\" \u2014 use observe with until=\"completed\" to wait for full termination. Agent waits replace repeated teammate-watch calls.";
export declare const TEAMMATE_WAIT_SNIPPET = "Wait once for a teammate result or for a bounded delay.";
export declare const TEAMMATE_WAIT_GUIDELINES: string[];
export declare const LOCAL_OBSERVE_DESCRIPTION = "Observe local teammate and background Bash targets through one status/wait/watch interface.\n\n- \"status\": one-shot snapshot of every target\n- \"wait\": block on an all/any/count barrier with one request-level timeout\n- \"watch\": poll targets until a bounded timeout and return status transitions\n- view=\"turns\" with status lists local teammate session turns\n\nTargets use { kind, id }, where the supported local kinds are \"teammate\" and \"bash_bg\". Use detail=full only when recent output or a settled result is required.";
export declare const LOCAL_OBSERVE_SNIPPET = "Observe, wait for, or watch local teammate and background Bash targets.";
export declare const LOCAL_OBSERVE_GUIDELINES: string[];
export declare const OBSERVE_DESCRIPTION = "Observe mixed teammate and background Bash targets through one status/wait/watch interface.\n\n- \"status\": one-shot snapshot of every target\n- \"wait\": block on an all/any/count barrier with one request-level timeout; set until=\"completed\" to block until agents fully terminate instead of first result\n- \"watch\": poll every target until the bounded timeoutMs you provide, returning the full status-transition timeline (richer than status, no barrier required); omitted timeoutMs defaults to 600000 (10 minutes)\n- view=\"turns\" (status only): list the target's session turn history instead of the live snapshot; add turn=<n> to expand one 1-based turn into its messages, tool calls, and results\n\nTargets use { kind, id }, where kind is currently \"teammate\" or \"bash_bg\". Use detail=full (or tail) to include a settled teammate's captured result \u2014 including the structured_output value for schema tasks. kind=\"workspace\" accepts owner:<ownerId> or a window name and returns the peer snapshot (view=\"turns\" lists its agent runs, snapshot-limited because peers do not publish full transcripts). Persisted cross-window message bodies are not published by peers; read them with teammate-list view=\"inbox\". Legacy teammate observation tools remain available internally but are hidden from the default LLM tool catalog.";
export declare const OBSERVE_SNIPPET = "Observe, wait for, or watch mixed teammate and background Bash targets; view='turns' lists session turn history.";
export declare const OBSERVE_GUIDELINES: string[];
export declare const TEAMMATE_MONITOR_DESCRIPTION = "Observe multiple teammate targets or block on a multi-agent barrier. Monitor mode is user-controlled via /monitor; this tool only queries and waits.\n\n- \"status\": one-shot compact snapshot of targets \u2014 non-blocking\n- \"wait\": block until the barrier condition (all/any/count targets reach a result; result-ready, not terminal)\n\nOutput is compact by default (one line per target). Set verbose=true for expanded output.\n\nteammate-only: targets are plain agent-name strings (not observe's { kind, id } objects). This tool has no watch action, until threshold, or detail parameter; use observe for mixed bash_bg targets, transition watching, or until=\"completed\" waits.";
export declare const TEAMMATE_MONITOR_SNIPPET = "Query monitor snapshot or block on a multi-agent barrier.";
export declare const TEAMMATE_MONITOR_GUIDELINES: string[];
export declare function exposeLegacyObservationTools(): boolean;
export declare const TEAMMATE_DEPTH_START_MARKER = "<teammate_nesting_context>";
export declare const TEAMMATE_DEPTH_END_MARKER = "</teammate_nesting_context>";
export declare function appendTeammateDepthContext(systemPrompt: string, depth: number, maxDispatchDepth?: number): string;
export declare function backgroundWaitGuidance(correlationId: string): string;
/**
 * Appended to foreground detach acknowledgements so the Alt+B shortcut stays
 * discoverable across the root single, root graph, and nested foreground paths.
 */
export declare const FOREGROUND_DETACH_HINT = "Alt+B detaches a foreground call to background.";
export declare function setPersistentUi(ui: ExtensionUIContext | undefined, resetOwners?: boolean): void;
/** Registers one foreground owner; unregister is idempotent on every race path. */
export declare function registerForegroundDetach(detach: () => void, ui?: ExtensionUIContext): () => void;
export declare function foregroundWaitWindowMs(tasks: ReadonlyArray<{
    timeoutMs?: number;
}>, fallbackMs?: number): number;
/**
 * Multi-task dispatches may keep a dedicated foreground window independent of
 * task defaults. The window is a detach boundary only: graph dependency and
 * concurrency queues continue running after it expires.
 */
export declare function concurrencyWaitWindowMs(tasks: ReadonlyArray<{
    timeoutMs?: number;
}>, concurrencyWaitMs?: number, fallbackMs?: number): number;
export declare function createForegroundDeadline(timeoutMs: number): {
    promise: Promise<"timeout">;
    dispose(): void;
};
export declare const AGENT_BUFFER_LIMITS: Readonly<{
    inboxItems: 64;
    sleepingInboxItems: 5;
    inboxBytes: number;
    logLines: 200;
    sleepingLogLines: 100;
    logLineBytes: number;
    logBytes: number;
    lastResultBytes: number;
    /** PERFSEC-004: Cap per-interaction payload retention (16 concurrent × 256KB = 4MB max). */
    interactionPayloadBytes: number;
}>;
/**
 * Idle confirmation window for caller-facing notifications during phases that
 * have a 30s canonical deadline. Expected-silence phases keep their longer
 * five-minute deadline and are never shortened by this override.
 */
export declare const TEAMMATE_STALL_NOTIFY_IDLE_MS = 60000;
/**
 * Minimum spacing between caller-facing stall notifications for the same
 * agent. Without it, an agent that alternates activity and silence re-arms
 * the one-shot marker on every resume and notifies on every silent spell.
 */
export declare const TEAMMATE_STALL_NOTIFY_COOLDOWN_MS: number;
/** Expected queue/model silence uses the shared five-minute ceiling. */
export declare const TEAMMATE_PENDING_STALL_TIMEOUT_MS: number;
/** Lower bound on teammate-wait re-poll spacing. */
export declare const TEAMMATE_WAIT_POLL_FLOOR_MS = 250;
/**
 * Backstop for `teammate-wait` calls that omit `timeoutMs`. The tool's own
 * description tells callers to pass a bounded timeout, but an unbounded wait
 * must still terminate on its own.
 */
export declare const TEAMMATE_WAIT_DEFAULT_TIMEOUT_MS: number;
/**
 * Foreground wait window when neither the task nor runtime options provide a
 * timeout. Previously `undefined` here reached `createForegroundDeadline` as
 * a never-resolving promise, so a foreground call whose child stayed alive
 * without emitting a terminal event (or whose run promise never settled) hung
 * the tool call indefinitely instead of detaching to background. The window is
 * a detach bound, not a kill bound: on expiry the extension moves the run to
 * background and returns the standard acknowledgement + guidance.
 */
export declare const TEAMMATE_FOREGROUND_DEFAULT_TIMEOUT_MS: number;
/**
 * Ceiling on how long one relayed permission/question may hold a child agent
 * before it is answered on the child's behalf. The terminal is a single shared
 * resource, so these requests are answered one at a time; without a ceiling one
 * unattended prompt stalls every other agent queued behind it, and any parent
 * waiting on those agents stalls with them.
 */
export declare const TEAMMATE_INTERACTION_TIMEOUT_MS: number;
/**
 * Ceiling on queued relayed interactions. Past this the queue is answering
 * slower than agents are asking, so newcomers are declined immediately rather
 * than joining a line they would time out in anyway.
 */
export declare const TEAMMATE_INTERACTION_QUEUE_LIMIT = 16;
export declare const WAKEABLE_AGENT_BUDGET: Readonly<{
    maxSleepingAgents: 12;
    anonymousTtlMs: number;
    namedTtlMs: number;
}>;
export declare const AGENT_WIDGET_IDLE_HIDE_MS = 60000;
export { COCKPIT_UI_OWNERSHIP_EVENT } from "../shared/cockpit-events.ts";
/**
 * Appends one marker-prefixed activity line to an agent's log. Shared so the
 * single-task and graph proxy paths record the same shape; the single-task path
 * previously recorded nothing, leaving `teammate-watch` on a nested agent with
 * only "Waiting for model capacity or first activity…".
 */
export declare function appendAgentProgressLine(agent: ActiveAgent, data: AgentProgress, correlationId: string): void;
export declare function buildWorkspaceOwnerState(state: TeammateState, sessionName?: string, contextPressure?: number, backgroundJobs?: readonly WorkspaceBackgroundJobSnapshot[], mainActivityAt?: number): WorkspaceOwnerState;
/** Compatibility vocabulary for legacy internal status checks. */
export declare const LIVE_AGENT_STATUSES: ReadonlySet<AgentStatus>;
/** Resource admission is independent of the externally projected activity. */
export declare function agentHoldsRuntimeSlot(agent: ActiveAgent): boolean;
/**
 * Bounds the whole dispatch tree, not a single call. `maxAgents` caps one
 * dispatch's task count, so nesting multiplies rather than adds: without this
 * gate a depth-3 tree of 15-task graphs reaches 15^3 child processes.
 */
export declare function checkActiveAgentBudget(state: TeammateState, additional?: number): {
    allowed: boolean;
    active: number;
    max: number;
};
/**
 * Whether a log is provably within every limit, using a byte upper bound rather
 * than encoding. False means "trim to be sure", never "definitely over".
 */
export declare function logNeedsNoTrim(lines: readonly string[], lineLimit: number): boolean;
export declare function trimAgentBuffers(agent: ActiveAgent, sleeping?: boolean): void;
export declare function retainBoundedAgentHistory(agent: ActiveAgent, sleeping?: boolean): void;
export interface ProgressFlushGate {
    mark(terminal?: boolean): void;
    flush(): void;
    dispose(): void;
}
export declare function createProgressFlushGate(onFlush: () => void, intervalMs?: number): ProgressFlushGate;
export declare function flushProgressBatch<T>(pending: Map<number, T>, latest: T | undefined, apply: (value: T) => void, publish: (latestValue: T) => void): void;
export declare function runWithProgressFlushCleanup<T>(run: () => Promise<T>, gate: ProgressFlushGate | undefined): Promise<T>;
export interface AgentWidgetTheme {
    fg(name: string, text: string): string;
    bold(text: string): string;
}
export declare function switchConversationSession(ctx: Pick<ExtensionCommandContext, "switchSession">, sessionFile: string, onSwitched: (ctx: ExtensionCommandContext) => Promise<void> | void): Promise<void>;
export interface AgentWidgetRow {
    correlationId: string;
    parentCorrelationId?: string;
    label: string;
    agent: string;
    status: AgentProgressSnapshot["status"] | "sleeping";
    phase?: AgentRunPhase;
    action: string;
    direction: "↑" | "↓";
    toolCount: number;
    tokens: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    startedAt: number;
    durationMs: number;
    lastActivityAt: number;
    resultReadyAt?: number;
    pendingInteractions: number;
    parentLabel?: string;
    resultLabels?: string[];
}
export interface AgentSelectorRow {
    correlationId: string;
    agent: string;
    name?: string;
    label: string;
    parentLabel?: string;
    status: ActiveAgent["status"];
    startedAt: number;
    depth: number;
    treePrefix: string;
    recentTools: RecentToolInfo[];
    lastMessage?: string;
}
/** Walks `spawnedBy` to the top of an agent's dispatch tree. */
export declare function rootDispatchAncestor(state: TeammateState, correlationId: string): string;
/**
 * Decides whether a proxied `teammate-send` may act on `targetCid`.
 *
 * A nested agent could name any agent in the process and act on it — including
 * `abort`, which terminates the target's whole subtree. Nothing checked that
 * the two were related, so a depth-2 worker could tear down an unrelated
 * dispatch tree it had no business knowing about.
 *
 * The split is by blast radius. Messaging stays open within the requester's own
 * dispatch tree, because peer coordination between siblings is the normal
 * pattern. Terminating is limited to the requester's own descendants: an agent
 * may dismantle what it built, not what built it or what runs beside it.
 */
export declare function canProxySendTo(state: TeammateState, requesterCid: string | undefined, targetCid: string, mode: RpcMessageMode): {
    allowed: boolean;
    reason?: string;
};
/** Walks `spawnedBy` links up from `descendant`, looking for `ancestor`. */
export declare function isAgentDescendantOf(state: TeammateState, descendant: string, ancestor: string): boolean;
/**
 * Resolves which agent a proxied request belongs to.
 *
 * A child may legitimately name an id other than the one this process bound to
 * its transport: a graph runs several task children behind a single request
 * handler, so `event.correlationId` is how they tell each other apart. But the
 * id arrives over the wire from the child, and taking it on faith let a child
 * re-parent itself onto any agent it could name — including a shallower one,
 * which resets the depth its own dispatches are measured against and reopens
 * unbounded nesting. So a claim is honoured only when it resolves to an agent
 * inside the spawner's own subtree; otherwise the request is attributed to the
 * spawner this process actually launched.
 */
export declare function resolveProxyParentCorrelationId(event: Record<string, unknown>, spawnedBy?: string, state?: TeammateState): string | undefined;
export declare function selectorAgentLabel(agent: ActiveAgent): string;
export declare function emitTeammateStarted(pi: ExtensionAPI, agent: ActiveAgent, extra?: Record<string, unknown>): void;
/**
 * Canned notice injected when the user interrupts an agent from the cockpit
 * agent list: the current turn/tool is aborted and the agent is told to report
 * and continue, keeping the agent alive (unlike teammate-send's abort mode,
 * which terminates the whole tree).
 */
export declare const TEAMMATE_INTERRUPT_NOTICE = "[user interrupt] Stop the current operation immediately, briefly report what you were doing, and continue your task.";
export interface TeammateAgentCommandPayload {
    correlationId: string;
    action: "interrupt" | "steer";
    message?: string;
}
/** The only bus surface this function consumes — a test harness needs no full EventBus. */
export interface AgentCommandEventSink {
    events: {
        emit: (channel: string, data: unknown) => void;
    };
}
/**
 * Handle a cockpit agent-list command (TEAMMATE_AGENT_COMMAND_EVENT). Both
 * actions route through the steer RPC (Pi abort → prompt): `interrupt` injects
 * the canned notice, `steer` injects the user's message. A stalled agent stuck
 * in a tool is woken by the abort; sleeping agents are woken by the delivery.
 * Failures surface as an isSend message event so consumers never mistake the
 * send for agent progress.
 */
export declare function applyTeammateAgentCommand(state: TeammateState, pi: AgentCommandEventSink, deliver: (correlationId: string, label: string, message: string) => Promise<{
    delivered: boolean;
    error?: string;
}> | {
    delivered: boolean;
    error?: string;
}, payload: unknown): Promise<void>;
/** Reactivate a wakeable child and republish it to lifecycle-only consumers. */
export declare function wakeSleepingAgent(pi: ExtensionAPI, agent: ActiveAgent, now?: number): boolean;
export declare function buildAgentSelectorRows(agents: ActiveAgent[]): AgentSelectorRow[];
/**
 * Rows for completed teammate sessions recovered from disk after a restart.
 * The selector merges these below the live-agent rows; selecting one opens the
 * attach overlay in transcript mode (read-only).
 */
export declare function buildHistoryRows(scans: WorkspaceSessionScan[]): AgentSelectorRow[];
/**
 * Stable selector key for a history row, derived from the session file path —
 * position-based keys would drift when the scan order changes across rebuilds.
 */
export declare function historyRowKey(scan: WorkspaceSessionScan): string;
export declare function historyLabel(scan: WorkspaceSessionScan): string;
export declare function renderAgentSelectorPanel(rows: AgentSelectorRow[], cursor: number, query: string, width: number): string[];
export declare function compactMetric(value: number): string;
export declare function toolAction(name: string): string;
export declare function formatRetryDelay(delayMs: number): string;
export declare function agentWidgetRows(agents: ActiveAgent[]): AgentWidgetRow[];
export declare function renderAgentStatusWidget(agents: ActiveAgent[], width: number, theme: AgentWidgetTheme): string[];
export declare function handleChildLifecycleEvent(state: TeammateState, event: Record<string, unknown>): void;
export declare function restoreMainOwnershipIfHandbackPending(agent: ActiveAgent): LeaseToken | undefined;
export declare const CHILD_PROXY_TIMEOUT_MS: number;
export interface PendingChildProxyRequest {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    abortHandler?: () => void;
    cancelRoot?: (reason: "timeout" | "aborted") => void;
}
export type ChildProxyPendingRequests = Map<string, PendingChildProxyRequest>;
export declare function takeChildProxyRequest(pendingRequests: ChildProxyPendingRequests, requestId: string): PendingChildProxyRequest | undefined;
export declare function childProxyAbortError(): Error;
/** @internal Exported for lifecycle regression tests. */
export declare function resolveChildProxyRequest(pendingRequests: ChildProxyPendingRequests, requestId: string, result: unknown): boolean;
/** @internal Exported for lifecycle regression tests. */
export declare function rejectChildProxyRequest(pendingRequests: ChildProxyPendingRequests, requestId: string, error: Error): boolean;
/** @internal Exported for lifecycle regression tests. */
export declare function rejectAllChildProxyRequests(pendingRequests: ChildProxyPendingRequests, error: Error): void;
/** @internal Exported for lifecycle regression tests. */
export type IpcSender = (message: Record<string, unknown>, callback: (error: Error | null) => void) => boolean;
/**
 * Builds the IPC sender the teammate proxy uses to talk to its parent.
 *
 * Node's IPC `send` reads `this.connected` internally, so detaching it from its
 * owner (`const send = proc.send`) leaves `this` undefined in module scope and
 * throws "Cannot read properties of undefined (reading 'connected')" on the
 * first call — which broke every proxied teammate tool in a nested child.
 * Binding the owner keeps the proxied call working. Returns undefined when no
 * live IPC channel exists.
 */
export declare function createIpcSender(proc?: {
    connected?: boolean;
    send?: (...args: any[]) => boolean;
}): IpcSender | undefined;
export declare function createChildProxyRequest(pendingRequests: ChildProxyPendingRequests, requestId: string, message: Record<string, unknown>, send: (message: Record<string, unknown>, callback: (error: Error | null) => void) => boolean, timeoutMs?: number, signal?: AbortSignal): Promise<unknown>;
