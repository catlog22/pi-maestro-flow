/**
 * Teammate Extension Entry Point
 *
 * Tools: teammate (dispatch), teammate-send (RPC message injection), teammate-list (status), teammate-wait
 * TUI: Alt+R composer panel, widget above editor, Alt+B foreground→background detach
 * Mode: RPC subprocess — stdin open for steer/follow_up/abort
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type LeaseToken } from "../runs/session-handoff.ts";
import type { RunTeammateParams, RunTeammateOptions, RpcMessageMode } from "../runs/execution.ts";
import type { TeammateState, AgentProgressSnapshot, ChildAgentCallSnapshot, ActiveAgent, SettledAgentRecord } from "../shared/types.ts";
import { type AgentSummary } from "../agents/agents.ts";
import { type TeammateModelCapability } from "../models/model-catalog.ts";
export declare const TEAMMATE_PROMPT_SNIPPET = "Dispatch bounded work to discovered teammate roles for parallel, sequential, or specialist execution.";
export declare const TEAMMATE_PROMPT_GUIDELINES: string[];
export type TeammateRuntimeOptions = Pick<RunTeammateOptions, "spawnChildProcess" | "resultReadyGraceMs" | "foregroundMaxRunMs"> & {
    /** @internal Observes the real runtime callbacks for public-path lifecycle tests. */
    onRunOptionsCreated?: (options: RunTeammateOptions) => void;
};
export declare function buildTeammateToolDescription(cwd: string): string;
export declare const AGENT_BUFFER_LIMITS: Readonly<{
    inboxItems: 64;
    sleepingInboxItems: 5;
    inboxBytes: number;
    logLines: 200;
    sleepingLogLines: 100;
    logLineBytes: number;
    logBytes: number;
    lastResultBytes: number;
}>;
export declare const TEAMMATE_STALL_TIMEOUT_MS = 30000;
/**
 * Stall ceiling for queued work. A `pending` graph task is waiting on a
 * dependency or a concurrency slot, which is expected — it just must not wait
 * without any ceiling at all.
 */
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
export declare function retainBoundedAgentHistory(agent: ActiveAgent, sleeping?: boolean): void;
export interface ProgressFlushGate {
    mark(terminal?: boolean): void;
    flush(): void;
    dispose(): void;
}
export declare function createProgressFlushGate(onFlush: () => void, intervalMs?: number): ProgressFlushGate;
export declare function flushProgressBatch<T>(pending: Map<number, T>, latest: T | undefined, apply: (value: T) => void, publish: (latestValue: T) => void): void;
export declare function runWithProgressFlushCleanup<T>(run: () => Promise<T>, gate: ProgressFlushGate | undefined): Promise<T>;
interface AgentWidgetTheme {
    fg(name: string, text: string): string;
    bold(text: string): string;
}
export declare function switchConversationSession(ctx: Pick<ExtensionCommandContext, "switchSession">, sessionFile: string, onSwitched: () => Promise<void> | void): Promise<void>;
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
    recentTools: Array<{
        name: string;
        status: string;
    }>;
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
export declare function buildAgentSelectorRows(agents: ActiveAgent[]): AgentSelectorRow[];
export declare function renderAgentSelectorPanel(rows: AgentSelectorRow[], cursor: number, query: string, width: number): string[];
export declare function renderAgentStatusWidget(agents: ActiveAgent[], width: number, theme: AgentWidgetTheme): string[];
export declare function handleChildLifecycleEvent(state: TeammateState, event: Record<string, unknown>): void;
export declare function restoreMainOwnershipIfHandbackPending(agent: ActiveAgent): LeaseToken | undefined;
export interface PendingChildProxyRequest {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    abortHandler?: () => void;
}
export type ChildProxyPendingRequests = Map<string, PendingChildProxyRequest>;
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
export default function registerTeammateExtension(pi: ExtensionAPI, runtimeOptions?: TeammateRuntimeOptions): void;
type AgentListView = "active" | "named" | "all";
type ListedAgentStatus = ActiveAgent["status"] | AgentProgressSnapshot["status"];
interface ListedAgent {
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
}
export declare function buildRoleList(cwd: string): {
    entries: AgentSummary[];
    text: string;
};
export declare function correlationIdPrefix(correlationId: string, correlationIds: Iterable<string>, minimumLength?: number): string;
export declare function buildAgentList(state: TeammateState, view: AgentListView): {
    entries: ListedAgent[];
    text: string;
};
type WatchTarget = {
    kind: "agent";
    agent: ActiveAgent;
} | {
    kind: "graph-task";
    agent: ActiveAgent;
    progress: AgentProgressSnapshot;
};
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
export declare function waitForTeammate(state: TeammateState, params: {
    name?: string;
    timeoutMs?: number;
    waitMs?: number;
}, signal?: AbortSignal): Promise<TeammateWaitResult>;
export declare function notifyBackgroundFailure(pi: ExtensionAPI, id: string, agent: string, correlationId: string, error: unknown): void;
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
export declare function reclaimResultReadyAgents(state: TeammateState, now?: number): string[];
export declare function enforceWakeableAgentBudget(state: TeammateState, now?: number): string[];
export declare function nextWakeableAgentExpiryDelay(state: TeammateState, now?: number): number | undefined;
export declare function hasTeammateWidgetWork(state: TeammateState, now?: number): boolean;
export declare function settleAgent(state: TeammateState, correlationId: string, exitCode: number, lastResult?: string, wakeable?: boolean): void;
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
/**
 * Binds a display name to an agent, surfacing the collision when one occurs.
 *
 * Names are last-wins by design, but the displacement used to be silent: the
 * previous holder stayed alive and reachable only through its `name#id-prefix`
 * form, while `teammate-wait @name` and `teammate-send @name` quietly retargeted
 * to the newcomer. Both logs now say so, so a misrouted message is traceable.
 */
export declare function bindAgentName(state: TeammateState, name: string, correlationId: string): void;
/** Drops failed tombstones past their retention window. */
export declare function sweepFailedAgents(state: TeammateState, now?: number): string[];
export declare function killAgentTree(state: TeammateState, correlationId: string): string[];
export declare function handleChildInteractionRequest(pi: ExtensionAPI, state: TeammateState, event: Record<string, unknown>, reply: (msg: unknown) => void, ctx: ExtensionContext | null | undefined, fallbackCorrelationId?: string): Promise<void>;
export declare function handleChildRpcUiRequest(event: Record<string, unknown>, reply: (msg: unknown) => void, ctx: ExtensionContext | null | undefined): Promise<void>;
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
export interface TeammateInteractionQueue {
    /** Serializes one relayed child request behind any already in flight. */
    enqueue(event: Record<string, unknown>, reply: (msg: unknown) => void, ctx: ExtensionContext | null | undefined, fallbackCorrelationId?: string): void;
    /** Settles every request belonging to a gone agent. Returns how many. */
    cancelForAgent(correlationId: string, reason: string): number;
    /** Requests still waiting for an answer, in flight or queued. */
    pendingCount(): number;
}
/**
 * Builds the serial queue that relays child permission/question requests to the
 * human. Serialization is deliberate — `ctx.ui.select` owns the terminal, so two
 * concurrent prompts would fight over it — but every entry is bounded and
 * cancellable, because the failure it guards against is a nested one: a parent
 * agent waits on a child, that child waits on a prompt, and that prompt waits
 * behind an unattended prompt belonging to an unrelated agent. Answering on the
 * child's behalf after a timeout keeps that chain from becoming permanent.
 */
export declare function createTeammateInteractionQueue(pi: ExtensionAPI, state: TeammateState, timeoutMs?: number): TeammateInteractionQueue;
/**
 * Cancels the agent a proxy request created, once its requester gave up.
 *
 * The nested dispatch runs in this process while the child that asked for it
 * waits over IPC. If that wait ends first — its 30-minute ceiling, or the child
 * itself being aborted — nothing used to tell this side, and the agent kept
 * running with no consumer and nobody left to settle it. Returns the ids of the
 * agents torn down.
 */
export declare function cancelProxyDispatch(state: TeammateState, requestId: string, reason?: string): string[];
/** Parse untrusted child IPC parameters before they enter shared normalization. */
export declare function parseProxyTeammateParams(params: Record<string, unknown>): RunTeammateParams | undefined;
export declare function handleProxyRequest(pi: ExtensionAPI, state: TeammateState, event: Record<string, unknown>, reply: (msg: unknown) => void, spawnedBy?: string, modelCapabilities?: readonly TeammateModelCapability[], onInteraction?: (event: Record<string, unknown>, reply: (message: unknown) => void, correlationId: string) => void, onChildStatus?: (child: ChildAgentCallSnapshot) => void, runtimeOptions?: TeammateRuntimeOptions): Promise<void>;
export {};
