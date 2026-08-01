/**
 * Teammate Extension Entry Point
 *
 * Tools: teammate (dispatch), teammate-send (RPC message injection), teammate-list (status), observe
 * TUI: Alt+R composer panel, widget above editor, Alt+B foreground→background detach
 * Mode: RPC subprocess — stdin open for steer/follow_up/abort
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunTeammateOptions } from "../runs/execution.ts";
import type { TeammateState, AgentProgressSnapshot, ActiveAgent, AgentTerminalStatus, SettledAgentRecord } from "../shared/types.ts";
import { type AgentSummary } from "../agents/agents.ts";
export type AgentListView = "active" | "named" | "all";
export type TeammateListView = AgentListView | "roles";
export type ListedAgentStatus = ActiveAgent["status"] | AgentProgressSnapshot["status"];
export interface ListedAgent {
    agent: string;
    name?: string;
    correlationId: string;
    parentCorrelationId?: string;
    startedAt: string;
    durationMs: number;
    idleMs: number;
    inboxSize: number;
    hasStdin: boolean;
    spawnedBy?: string;
    depth: number;
    treePrefix: string;
    status: ListedAgentStatus;
    taskIndex?: number;
    dependencies?: number[];
    toolCount?: number;
    tokens?: number;
    /** Set once a consumable result exists but the process has not settled. */
    resultReadyAt?: number;
    /** Relayed permission/question requests this agent is blocked on. */
    pendingInteractions?: number;
    requestedModel?: string;
    resolvedModel?: string;
    attemptedModels?: string[];
}
export declare function buildRoleList(cwd: string): {
    entries: AgentSummary[];
    text: string;
};
export declare function progressDurationMs(progress: AgentProgressSnapshot, parent: ActiveAgent): number;
export declare function correlationIdPrefix(correlationId: string, correlationIds: Iterable<string>, minimumLength?: number): string;
export declare function buildAgentList(state: TeammateState, view: AgentListView): {
    entries: ListedAgent[];
    text: string;
};
export type WatchTarget = {
    kind: "agent";
    agent: ActiveAgent;
} | {
    kind: "graph-task";
    agent: ActiveAgent;
    progress: AgentProgressSnapshot;
};
export interface AgentTargetSelector {
    value: string;
    decorated?: {
        name: string;
        idPrefix: string;
    };
}
export declare function parseAgentTargetSelector(target: string): AgentTargetSelector;
export declare function resolveWatchTarget(state: TeammateState, target: string): {
    match?: WatchTarget;
    error?: string;
    available: string[];
};
export declare function buildWatchOutput(target: WatchTarget, lineCount: number): string[];
export type TeammateWaitStatus = "completed" | "failed" | "terminated" | "result-ready" | "stalled" | "timeout" | "not-found" | "delayed" | "aborted";
export interface TeammateWaitResult {
    status: TeammateWaitStatus;
    output: string[];
}
export interface PendingTeammateWaiter {
    resolve: (result: TeammateWaitResult) => void;
    timer?: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    abortHandler?: () => void;
}
export declare const teammateWaiters: WeakMap<TeammateState, Map<string, Set<PendingTeammateWaiter>>>;
export declare function waitOutput(status: TeammateWaitStatus, target?: string): string[];
export declare function clearWaiter(waiters: Set<PendingTeammateWaiter>, waiter: PendingTeammateWaiter): void;
export declare function settleTeammateWaiters(state: TeammateState, correlationId: string, status: Extract<TeammateWaitStatus, "completed" | "failed" | "terminated" | "result-ready">): void;
/**
 * Marks a target's `result-ready` as delivered and reports whether this call
 * was the one that delivered it. `result-ready` is an edge, not a level: the
 * result becomes consumable once, and the agent then keeps running until its
 * lifecycle confirms. Reporting it on every subsequent wait meant a caller
 * that waited again — to observe the real terminal state — got `result-ready`
 * back immediately, forever, and could never reach `completed`.
 */
export declare function claimResultReadyNotice(state: TeammateState | undefined, correlationId: string): boolean;
export declare function watchTargetStalledAt(target: WatchTarget, state?: TeammateState): number;
export declare function statusForWatchTarget(target: WatchTarget, now?: number, state?: TeammateState): Extract<TeammateWaitStatus, "completed" | "failed" | "terminated" | "result-ready" | "stalled"> | undefined;
export declare function waitDelayForWatchTarget(target: WatchTarget, timeoutAt: number | undefined, state?: TeammateState): number;
export declare function waitForTeammate(state: TeammateState, params: {
    name?: string;
    timeoutMs?: number;
    waitMs?: number;
}, signal?: AbortSignal): Promise<TeammateWaitResult>;
export declare function emitComplete(pi: ExtensionAPI, id: string | undefined, agent: string, correlationId: string, exitCode: number, durationMs: number, wakeable?: boolean, cancelled?: boolean): void;
/**
 * Deferred background and IPC callbacks routinely outlive session replacement:
 * after ctx.newSession()/fork()/switchSession()/reload() the host invalidates
 * the captured ExtensionAPI and every action method throws synchronously via
 * assertActive. The notification target no longer exists, and agent state has
 * already settled via settleAgent/killAgent plus eventBus emit (which is not
 * guarded), so drop the send instead of letting the throw escape into an
 * unhandled rejection that kills the pi process.
 *
 * Returns whether the message was actually delivered. Callers that rely on
 * the notification as the only result channel (detached/background runs)
 * should treat `false` as "settled state remains inspectable but the model
 * was not turned": the result stays reachable through observe / the
 * settled record, it just does not arrive as a new turn.
 */
export declare function safeSendMessage(pi: ExtensionAPI, message: Parameters<ExtensionAPI["sendMessage"]>[0], options?: Parameters<ExtensionAPI["sendMessage"]>[1]): boolean;
export declare function notifyBackgroundFailure(pi: ExtensionAPI, id: string, agent: string, correlationId: string, error: unknown, state?: TeammateState): void;
/**
 * When a deferred completion notification cannot reach the model (stale
 * extension ctx after session switch/reload), the result must stay findable
 * instead of vanishing with the same silence that reads as a hang. The agent
 * record — sleeping for success, a two-minute failed tombstone otherwise —
 * keeps its lastResult; this marker tells observe readers that the
 * missing turn is a dropped notification, not a missing result.
 */
export declare function markSettledResultInspectable(state: TeammateState, correlationId: string): void;
export declare function retireAgent(state: TeammateState, correlationId: string, lastResult?: string): void;
export declare function applyAgentRetryState(state: TeammateState, retry: {
    correlationId: string;
    attempt: number;
    maxRetries: number;
    delayMs: number;
    nextRetryAt: number;
    error: string;
}): void;
/**
 * A strict Pi `turn_end` can make the assistant answer consumable before the
 * authoritative `agent_end` lifecycle line arrives. Keep the run active, but
 * release event-driven waiters with that distinction made explicit.
 */
export declare function applyAgentResultReadyState(state: TeammateState, resultReady: {
    correlationId: string;
    resultReadyAt: number;
}): void;
export declare function clearAgentResultReadyState(state: TeammateState, correlationId: string): void;
export interface WakeableAgentCohort {
    controller: AbortController;
    agents: ActiveAgent[];
    named: boolean;
    lastActivityAt: number;
}
export declare function wakeableAgentCohorts(state: TeammateState): WakeableAgentCohort[];
export declare function terminateAndRemoveWakeableCohort(state: TeammateState, cohort: WakeableAgentCohort): string[];
/**
 * Parent-side backstop for an agent that published a consumable result and
 * never confirmed its lifecycle. The child arms its own deadline, so this only
 * catches a process that can no longer speak at all — a wedged pipe, a SIGKILL.
 * Deliberately well above the child's own grace so the child normally wins.
 */
export declare const RESULT_READY_RECLAIM_MS: number;
/**
 * Retires agents stuck in `running` with a published result. Such an agent is
 * neither live nor settled: it never reaches a `sleeping` cohort, so the
 * wakeable budget cannot evict it, and it holds an active-agent slot forever.
 */
export declare function reclaimResultReadyAgents(state: TeammateState, pi?: ExtensionAPI, now?: number): string[];
export declare function enforceWakeableAgentBudget(state: TeammateState, now?: number): string[];
export declare function nextWakeableAgentExpiryDelay(state: TeammateState, now?: number): number | undefined;
export declare function hasTeammateWidgetWork(state: TeammateState, now?: number): boolean;
export declare function fenceProxyDispatchesForAgents(state: TeammateState, selected: ReadonlySet<string>): void;
export declare function terminateNestedDispatchesOwnedBy(state: TeammateState, parentCorrelationId: string): string[];
export declare function settleAgent(state: TeammateState, correlationId: string, exitCode: number, lastResult?: string, wakeable?: boolean, terminalStatus?: AgentTerminalStatus): void;
export declare function settleGraphTaskAgent(state: TeammateState, correlationId: string, exitCode: number, lastResult?: string, wakeable?: boolean, terminalStatus?: AgentTerminalStatus): void;
export declare function settleGraphContainerAgent(state: TeammateState, correlationId: string, exitCode: number, lastResult?: string, wakeable?: boolean, terminalStatus?: AgentTerminalStatus): void;
export declare function settleAgentLifecycle(state: TeammateState, correlationId: string, exitCode: number, lastResult: string | undefined, wakeable: boolean, abortProcess: boolean, terminalStatus?: AgentTerminalStatus): void;
export declare function resolveAgentCorrelationId(state: TeammateState, target: string): string | undefined;
/** How many settled agents stay recallable after leaving `activeRuns`. */
export declare const SETTLED_AGENT_MEMO_LIMIT = 32;
export declare function recordSettledAgent(state: TeammateState, agent: ActiveAgent, status: SettledAgentRecord["status"]): void;
/** Finds a settled agent by correlationId, name, or correlationId prefix. */
export declare function findSettledAgent(state: TeammateState, target: string): SettledAgentRecord | undefined;
/**
 * How long a failed agent stays visible before it is swept.
 *
 * Success is visible and failure was not: `retireAgent` leaves a successful
 * agent in `activeRuns` as `sleeping`, but failure was written straight to
 * `completed` and deleted in the same frame — the one status the widget filter
 * discards. Every failure affordance downstream (the red ✗, the anchor that
 * pins a failed row past `maxVisible`, the `N failed` summary) was therefore
 * unreachable, and the run that needed attention was the one that vanished.
 *
 * A failed agent holds no child process, and `LIVE_AGENT_STATUSES` excludes
 * `failed`, so a tombstone costs no concurrency or nesting budget.
 */
export declare const FAILED_AGENT_RETENTION_MS: number;
export declare function killAgent(state: TeammateState, correlationId: string, name?: string, waitStatus?: Extract<TeammateWaitStatus, "completed" | "failed" | "terminated">, abortProcess?: boolean): void;
/**
 * Binds a display name to an agent, surfacing the collision when one occurs.
 *
 * Names are last-wins by design, but the displacement used to be silent: the
 * previous holder stayed alive and reachable only through its `name#id-prefix`
 * form, while `teammate-wait @name` and `teammate-send @name` quietly retargeted
 * to the newcomer. Both logs now say so, so a misrouted message is traceable.
 */
export declare function bindAgentName(state: TeammateState, name: string, correlationId: string): void;
export declare function removeAgentFromRegistry(state: TeammateState, correlationId: string, name?: string): void;
/** Drops failed tombstones past their retention window. */
export declare function sweepFailedAgents(state: TeammateState, now?: number): string[];
export declare function killAgentTree(state: TeammateState, correlationId: string): string[];
export declare function agentActiveMs(a: ActiveAgent): number;
export declare function ts(): string;
export declare function releaseAgentMemory(agent: ActiveAgent): void;
export interface RelayedQuestionOption {
    label: string;
    description?: string;
}
export interface RelayedQuestion {
    question: string;
    header?: string;
    options?: RelayedQuestionOption[];
    multiSelect?: boolean;
}
export declare function handleChildInteractionRequest(pi: ExtensionAPI, state: TeammateState, event: Record<string, unknown>, reply: (msg: unknown) => void, ctx: ExtensionContext | null | undefined, fallbackCorrelationId?: string, signal?: AbortSignal): Promise<void>;
export declare function handleChildRpcUiRequest(event: Record<string, unknown>, reply: (msg: unknown) => void, ctx: ExtensionContext | null | undefined, signal?: AbortSignal): Promise<void>;
export interface TeammateDirectChildRequestHandlerOptions {
    state?: TeammateState;
    fallbackCorrelationId?: string;
}
/**
 * Build the child-request bridge required by direct runSingleTeammate/runGraph users.
 *
 * The root teammate tool installs the same interaction routing internally, but
 * native orchestrators such as Swarm call the public execution API directly.
 * Without this bridge a child permission request is delivered over IPC and
 * then waits until its timeout because no parent handler replies.
 */
export declare function createTeammateDirectChildRequestHandler(pi: ExtensionAPI, ctx: ExtensionContext, options?: TeammateDirectChildRequestHandlerOptions): NonNullable<RunTeammateOptions["onChildRequest"]>;
export declare function replyUnavailableDirectProxy(event: Record<string, unknown>, reply: (message: unknown) => void): void;
export declare function replyProxyFailure(event: Record<string, unknown>, reply: (message: unknown) => void, error: unknown): void;
export interface TeammateInteractionQueue {
    /** Serializes one relayed child request behind any already in flight. */
    enqueue(event: Record<string, unknown>, reply: (msg: unknown) => void, ctx: ExtensionContext | null | undefined, fallbackCorrelationId?: string): void;
    /** Settles every request belonging to a gone agent. Returns how many. */
    cancelForAgent(correlationId: string, reason: string): number;
    /** Requests still waiting for an answer, in flight or queued. */
    pendingCount(): number;
}
export * from "./teammate-proxy.ts";
