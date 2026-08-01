/**
 * Core types for the teammate tool.
 */
export interface Usage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number;
    turns: number;
}
export interface SingleResult {
    agent: string;
    /** Optional dispatch name shown in compact completion rows. */
    name?: string;
    task: string;
    exitCode: number;
    messages: Array<{
        role: string;
        content: string;
    }>;
    usage: Usage;
    model: string;
    correlationId: string;
    durationMs: number;
    /** Number of child tool completions observed before this result settled. */
    toolCount?: number;
    /** Whether the child process remains available for teammate-send after this turn. */
    wakeable?: boolean;
    /**
     * The final assistant result is available, but the child has not yet emitted
     * its authoritative lifecycle confirmation (`agent_end`, close, or error).
     */
    lifecyclePending?: boolean;
    /** Canonical lifecycle outcome; cancellation must not be inferred from exitCode. */
    terminalStatus?: AgentTerminalStatus;
    structuredOutput?: unknown;
    attemptedModels?: string[];
}
export type AgentProgressStatus = "pending" | "running" | "retrying" | "completed" | "failed" | "terminated";
export interface AgentProgress {
    agent: string;
    name?: string;
    correlationId?: string;
    taskIndex?: number;
    dependencies?: number[];
    status: AgentProgressStatus;
    recentTools: Array<{
        name: string;
        status: string;
    }>;
    toolCount: number;
    tokens: number;
    inputTokens?: number;
    outputTokens?: number;
    /** Provider prompt-cache reads accumulated by the child, mirrored from Usage. */
    cacheReadTokens?: number;
    /** Provider prompt-cache writes accumulated by the child, mirrored from Usage. */
    cacheWriteTokens?: number;
    durationMs: number;
    lastActivityAt: number;
    startedAt: number;
    /** Pi emitted a final no-tool assistant turn; agent_end has not necessarily arrived yet. */
    resultReadyAt?: number;
    lastMessage?: string;
    requestedModel?: string;
    resolvedModel?: string;
    attemptedModels?: string[];
}
export interface AgentProgressSnapshot {
    agent: string;
    name?: string;
    correlationId: string;
    taskIndex: number;
    dependencies: number[];
    status: AgentProgressStatus;
    startedAt?: string;
    completedAt?: string;
    recentTools?: Array<{
        name: string;
        status: string;
    }>;
    toolCount?: number;
    tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    durationMs?: number;
    lastActivityAt?: number;
    /** Pi emitted a final no-tool assistant turn; agent_end has not necessarily arrived yet. */
    resultReadyAt?: number;
    lastMessage?: string;
    error?: string;
    requestedModel?: string;
    resolvedModel?: string;
    attemptedModels?: string[];
}
export interface ChildAgentCallSnapshot {
    agent: string;
    name?: string;
    correlationId: string;
    parentCorrelationId?: string;
    parentName?: string;
    status: "running" | "retrying" | "completed" | "failed" | "terminated";
    startedAt?: number;
    durationMs?: number;
    lastActivityAt?: number;
    /** Pi emitted a final no-tool assistant turn; agent_end has not necessarily arrived yet. */
    resultReadyAt?: number;
    recentTools?: Array<{
        name: string;
        status: string;
    }>;
    lastMessage?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}
export interface Details {
    mode: "single" | "parallel" | "chain" | "graph";
    results: SingleResult[];
    structuredOutput?: unknown;
    progress?: AgentProgressSnapshot[];
    childCalls?: ChildAgentCallSnapshot[];
}
export type MessageKind = "task" | "notification" | "result";
export interface MessageEnvelope {
    id: string;
    from: string;
    to: string;
    kind: MessageKind;
    correlation_id?: string;
    payload: string;
    timestamp: number;
}
export type AgentStatus = "pending" | "running" | "retrying" | "sleeping" | "completed" | "failed" | "terminated";
export interface AgentRetryState {
    attempt: number;
    maxRetries: number;
    nextRetryAt: number;
    lastError: string;
}
export interface TeammateInteractionRecord {
    requestId: string;
    interaction: "permission" | "question" | `rpc:${string}`;
    createdAt: number;
    payload: Record<string, unknown>;
}
export interface ActiveAgent {
    agent: string;
    name?: string;
    correlationId: string;
    startedAt: number;
    abortController: AbortController;
    /** Shared graph cancellation scope; `abortController` remains task/process-local. */
    graphAbortController?: AbortController;
    /** Explicit process ownership; graph containers are registry-only. */
    ownsChildProcess?: boolean;
    stdin?: import("node:stream").Writable;
    sendControl?: (message: Record<string, unknown>) => boolean;
    sessionId?: string;
    sessionFile?: string;
    sessionDir?: string;
    promptSeq?: number;
    lastParkNonce?: string;
    lease?: import("../runs/session-handoff.ts").SessionLease;
    pendingHandoff?: {
        nonce: string;
        resolve: (ready: boolean) => void;
        timer: ReturnType<typeof setTimeout>;
    };
    pendingHandback?: {
        nonce: string;
        epoch: number;
        sessionId?: string;
        sessionFile?: string;
    };
    pendingCancel?: {
        nonce: string;
        fencedEpoch: number;
    };
    pendingInteractions?: Map<string, TeammateInteractionRecord>;
    inbox: MessageEnvelope[];
    outputLog: string[];
    pendingResolve?: (result: SingleResult) => void;
    lastActivityAt: number;
    requestedModel?: string;
    resolvedModel?: string;
    attemptedModels?: string[];
    /**
     * When this agent failed. Set alongside `status: "failed"`, mirroring
     * `sleptAt` for retired agents, and read by the retention sweep that
     * eventually removes the tombstone.
     */
    failedAt?: number;
    /**
     * Whether this dispatch carried an `outputSchema`. `structured_output` is
     * auto-approved because a headless child has no UI to approve it with, and
     * the permission request names its own tool — so without this the
     * auto-approval was reachable by any child that claimed the name. Only an
     * agent the parent actually granted a schema can use it.
     */
    expectsStructuredOutput?: boolean;
    replyTo?: string;
    spawnedBy?: string;
    /**
     * Nesting depth of this agent within the dispatch tree. Root-tool dispatches
     * are 0; every proxied dispatch is its spawner's depth plus one. This is the
     * authoritative depth: nested dispatches execute inside the root process, so
     * a process-scoped environment variable cannot carry it.
     */
    depth: number;
    /**
     * Absolute max record-depth this agent may dispatch at (its children's
     * ceiling). Root dispatches set it from maxNestingDepth; proxied dispatches
     * subtract one from the parent's budget. Agents with budget 0 cannot call
     * the teammate tool at all. Absent on legacy records: global ceiling.
     */
    maxDispatchDepth?: number;
    status: AgentStatus;
    retry?: AgentRetryState;
    /** Pi emitted a final no-tool assistant turn; agent_end has not necessarily arrived yet. */
    resultReadyAt?: number;
    lastResult?: string;
    sleptAt?: number;
    sleepMs: number;
    progress?: AgentProgressSnapshot[];
}
export interface TeammateState {
    baseCwd: string;
    currentSessionId: string | null;
    mainSessionFile?: string;
    handoffSwitching?: boolean;
    activeRuns: Map<string, ActiveAgent>;
    namedAgents: Map<string, string>;
    /**
     * Settles relayed permission/question requests belonging to an agent that is
     * going away, so a killed agent's queued prompt never keeps the shared
     * interaction queue — and every agent behind it — waiting. Installed by the
     * root extension; absent in states that never relay interactions.
     */
    cancelInteractions?: (correlationId: string, reason: string) => void;
    /**
     * Bounded, insertion-ordered record of agents that have left `activeRuns`.
     * A settled agent is removed outright, so without this a lookup afterwards
     * cannot tell "this agent failed" from "there is no such agent" — and the
     * caller retries a name that will never come back. Oldest entries are
     * dropped once the cap is reached.
     */
    recentlySettled?: Map<string, SettledAgentRecord>;
    /**
     * Agents whose `result-ready` edge has already been reported to a waiter.
     * The flag itself stays set until the lifecycle settles, so without this a
     * caller waiting again for the true terminal state would be handed
     * `result-ready` back immediately, every time.
     */
    resultReadyNotified?: Set<string>;
    /**
     * Teammate proxy requests reserved before the handler's first asynchronous
     * boundary. Cancellation removes the reservation so the resumed request
     * cannot register or spawn an agent after its caller has stopped waiting.
     */
    pendingProxyDispatchRequests?: Set<string>;
    /** Parent identity for reservations that have not registered an agent yet. */
    pendingProxyDispatchParents?: Map<string, string>;
    /**
     * Maps a child's proxy requestId to the agent this process created for it, so
     * that a child which stops waiting can have that agent torn down instead of
     * leaving it running with no consumer.
     */
    proxyDispatchByRequest?: Map<string, string>;
    /** Cancellation fences retained until the matching nested promise settles. */
    cancelledProxyDispatches?: Map<string, string>;
    /** Request-scoped cancellation for proxied observe/monitor/wait calls. */
    proxyObservationControllers?: Map<string, AbortController>;
}
export type AgentTerminalStatus = "completed" | "failed" | "terminated";
export interface SettledAgentRecord {
    correlationId: string;
    agent: string;
    name?: string;
    status: AgentTerminalStatus;
    settledAt: number;
    lastResult?: string;
    requestedModel?: string;
    resolvedModel?: string;
    attemptedModels?: string[];
}
export declare const TEAMMATE_COMPLETE_EVENT = "teammate:complete";
export declare const TEAMMATE_STARTED_EVENT = "teammate:started";
export declare const TEAMMATE_MESSAGE_EVENT = "teammate:message";
