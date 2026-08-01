/**
 * Teammate Extension Entry Point
 *
 * Tools: teammate (dispatch), teammate-send (RPC message injection), teammate-list (status), observe
 * TUI: Alt+R composer panel, widget above editor, Alt+B foreground→background detach
 * Mode: RPC subprocess — stdin open for steer/follow_up/abort
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type WorkspaceOwnerState } from "./workspace-peers.ts";
import { type LeaseToken } from "../runs/session-handoff.ts";
import type { RunTeammateOptions, RpcMessageMode, NormalizedTask } from "../runs/execution.ts";
import type { TeammateState, AgentProgress, AgentProgressSnapshot, ActiveAgent, AgentStatus, AgentTerminalStatus, SingleResult } from "../shared/types.ts";
export declare const TEAMMATE_PROMPT_SNIPPET = "Dispatch bounded work to discovered teammate roles for parallel, sequential, or specialist execution.";
export declare const TEAMMATE_PROMPT_GUIDELINES: string[];
export declare function terminalStatusForResult(result: SingleResult, callbackStatus?: AgentTerminalStatus): AgentTerminalStatus;
export declare function resultIsError(result: SingleResult): boolean;
export declare function aggregateTerminalStatus(results: readonly SingleResult[]): AgentTerminalStatus;
export declare function displayMessageForResult(result: SingleResult): string;
export declare function summarizeGraphResults(results: readonly SingleResult[], tasks: readonly NormalizedTask[]): string;
export declare function aggregateGraphStructuredOutput(results: readonly SingleResult[], tasks: readonly NormalizedTask[]): Record<string, unknown> | undefined;
export type TeammateRuntimeOptions = Pick<RunTeammateOptions, "spawnChildProcess" | "resultReadyGraceMs" | "foregroundMaxRunMs"> & {
    /** @internal Observes the real runtime callbacks for public-path lifecycle tests. */
    onRunOptionsCreated?: (options: RunTeammateOptions) => void;
};
export declare function buildTeammateToolDescription(cwd: string): string;
export declare const TEAMMATE_SEND_DESCRIPTION = "Send a message to a running or sleeping teammate agent, addressed by name, @name, displayed name#id-prefix, correlation ID, or unique ID prefix.\n\nModes (default: follow_up):\n  - \"steer\" \u2014 interrupt the current turn and inject immediately\n  - \"follow_up\" \u2014 queue after the current turn completes\n  - \"abort\" \u2014 terminate the agent (message optional)";
export declare const TEAMMATE_SEND_SNIPPET = "Steer, follow up with, or abort a named running teammate agent.";
export declare const TEAMMATE_SEND_GUIDELINES: string[];
export declare const TEAMMATE_LIST_DESCRIPTION = "List available roles or teammate agents. view defaults to \"active\".\n\n- \"active\": live agents except completed entries\n- \"named\": addressable named agents\n- \"all\": all tracked live entries\n- \"roles\": builtin, project, and user-defined role definitions";
export declare const TEAMMATE_LIST_SNIPPET = "List available teammate roles or inspect active and named agent status.";
export declare const TEAMMATE_LIST_GUIDELINES: string[];
export declare const TEAMMATE_WATCH_DESCRIPTION = "Perform a one-shot inspection of a running or sleeping teammate agent's recent output, tool activity, inbox messages, and last result. This is not a completion-wait tool.";
export declare const TEAMMATE_WATCH_SNIPPET = "Inspect a specific teammate agent's recent activity and output.";
export declare const TEAMMATE_WATCH_GUIDELINES: string[];
export declare const TEAMMATE_WAIT_DESCRIPTION = "Wait once for a teammate result or lifecycle settlement by name, or provide waitMs for a fixed delay. Named waits default to a bounded 10-minute timeout. Agent waits are event-driven and replace repeated teammate-watch calls.";
export declare const TEAMMATE_WAIT_SNIPPET = "Wait once for a teammate result or for a bounded delay.";
export declare const TEAMMATE_WAIT_GUIDELINES: string[];
export declare const OBSERVE_DESCRIPTION = "Observe mixed teammate and background Bash targets through one status/wait interface.\n\n- \"status\": one-shot snapshot of every target\n- \"wait\": block on an all/any/count barrier with one request-level timeout\n\nTargets use { kind, id }, where kind is currently \"teammate\" or \"bash_bg\". Legacy teammate observation tools remain available internally but are hidden from the default LLM tool catalog.";
export declare const OBSERVE_SNIPPET = "Observe or wait for mixed teammate and background Bash targets.";
export declare const OBSERVE_GUIDELINES: string[];
export declare const TEAMMATE_MONITOR_DESCRIPTION = "Observe multiple teammate targets or block on a multi-agent barrier. Persistent supervision is entered/exited separately via /monitor.\n\n- \"status\": one-shot compact snapshot of targets \u2014 non-blocking\n- \"wait\": block until barrier condition (all/any/count targets settle)\n\nOutput is compact by default (one line per target). Use verbose for detail.";
export declare const TEAMMATE_MONITOR_SNIPPET = "Query monitor snapshot or block on a multi-agent barrier.";
export declare const TEAMMATE_MONITOR_GUIDELINES: string[];
export declare function exposeLegacyObservationTools(): boolean;
export declare const TEAMMATE_DEPTH_START_MARKER = "<teammate_nesting_context>";
export declare const TEAMMATE_DEPTH_END_MARKER = "</teammate_nesting_context>";
export declare function appendTeammateDepthContext(systemPrompt: string, depth: number, maxDispatchDepth?: number): string;
export declare function backgroundWaitGuidance(correlationId: string): string;
export declare function foregroundWaitWindowMs(tasks: ReadonlyArray<{
    timeoutMs?: number;
}>, fallbackMs?: number): number;
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
export declare const COCKPIT_UI_OWNERSHIP_EVENT = "cockpit:ui-ownership";
/**
 * Appends one marker-prefixed activity line to an agent's log. Shared so the
 * single-task and graph proxy paths record the same shape; the single-task path
 * previously recorded nothing, leaving `teammate-watch` on a nested agent with
 * only "Waiting for model capacity or first activity…".
 */
export declare function appendAgentProgressLine(agent: ActiveAgent, data: AgentProgress, correlationId: string): void;
export declare function buildWorkspaceOwnerState(state: TeammateState, sessionName?: string): WorkspaceOwnerState;
/** Agents that still hold (or are about to hold) a child process. */
export declare const LIVE_AGENT_STATUSES: ReadonlySet<AgentStatus>;
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
/** Reactivate a wakeable child and republish it to lifecycle-only consumers. */
export declare function wakeSleepingAgent(pi: ExtensionAPI, agent: ActiveAgent, now?: number): boolean;
export declare function buildAgentSelectorRows(agents: ActiveAgent[]): AgentSelectorRow[];
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
