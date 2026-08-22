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
/** Closed, descriptive transport metadata safe to expose on settled results. */
export type TeammateExecutionTransport = {
    kind: "local-process";
    protocol: "pi-rpc" | "json-rpc-stdio" | "acp";
} | {
    kind: "acp-direct-ssh";
    protocol: "acp";
} | {
    kind: "dsh-direct-ssh";
    protocol: "json-rpc-stdio";
} | {
    kind: "remote-worker";
    gateway: "ssh";
    protocol: "remote/2";
    driver: "pi-rpc" | "acp";
} | {
    kind: "adapter-owned";
};
/** Secret-free identity of the pinned model-registry route that settled a run. */
export interface TeammateExecutionProvenance {
    registryVersion: number;
    registryRevision: number;
    registryHash: string;
    modelRegistrationId: string;
    modelId: string;
    deploymentId: string;
    harness: "pi" | "dsh" | "acp" | "adapter-owned";
    transport: TeammateExecutionTransport;
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
    /**
     * The model the executing runtime actually ran, in that runtime's own naming.
     *
     * `model` names what the host dispatched: for a backend whose model namespace
     * is its own, that is the route (`cli/<tool>`), which identifies the process
     * and not what ran inside it. Without this member two runs on different
     * models are indistinguishable in the settled result.
     *
     * Absent carries no claim either way: a backend sharing the host's model
     * namespace never sets it because `model` already answers, and one that owns
     * its namespace leaves it unset when it selected nothing. Kept in step with
     * the same member on `pi-maestro-backend-core/v1/spec`.
     */
    executorModel?: string;
    correlationId: string;
    /** Unique identity of one published turn; stable across its compatibility projections. */
    publicationId?: string;
    /** Durable completion dispatch linkage; populated by the root dispatcher. */
    completionDispatchId?: string;
    completionReservationId?: string;
    completionOutcome?: "completed" | "failed" | "terminated";
    /** Resolved task cwd used for durable result projection. */
    originCwd?: string;
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
    /** Advisory dispatch diagnostics that do not change the terminal outcome. */
    warnings?: string[];
    /**
     * Which backend served this run, and every capability it satisfied by
     * emulation or withheld under a host fence rather than natively.
     *
     * Written by the backend dispatch. Absent on the legacy path, which names no
     * backend because none served the run. Kept in step with the same members on
     * `pi-maestro-backend-core/v1/spec`: the dispatch writes through that type, so
     * a member missing here is populated at run time and invisible to every typed
     * consumer of this one.
     */
    backend?: string;
    capabilityDeliveries?: CapabilityDelivery[];
    /** Pinned model-registry route identity; absent in legacy/backend-registry mode. */
    provenance?: TeammateExecutionProvenance;
}
/**
 * How a backend delivered a capability it was asked for.
 *
 * Mirrors the member of the same name on the backend contract; see that
 * declaration for what each support value means.
 */
export interface CapabilityDelivery {
    capability: string;
    support: "native" | "emulated" | "withheld";
    /** Why the emulated or withheld path was taken. */
    note?: string;
}
export type AgentProgressStatus = "pending" | "running" | "retrying" | "completed" | "failed" | "terminated";
export type AgentActivity = "running" | "sleeping";
export type AgentRunPhase = "waiting-dependency" | "waiting-capacity" | "starting" | "restoring" | "prompting" | "tool-execution" | "result-ready" | "retrying" | "compacting" | "continuing" | "settling";
/** One recent tool call entry in progress telemetry; `argsPreview` is optional. */
export interface RecentToolInfo {
    name: string;
    status: string;
    /** Redacted one-line argument summary emitted by the child; absent when nothing informative survived. */
    argsPreview?: string;
}
export interface AgentProgress {
    agent: string;
    name?: string;
    correlationId?: string;
    taskIndex?: number;
    dependencies?: number[];
    status: AgentProgressStatus;
    phase?: AgentRunPhase;
    recentTools: RecentToolInfo[];
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
    phase?: AgentRunPhase;
    startedAt?: string;
    completedAt?: string;
    recentTools?: RecentToolInfo[];
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
    phase?: AgentRunPhase;
    startedAt?: number;
    durationMs?: number;
    lastActivityAt?: number;
    /** Pi emitted a final no-tool assistant turn; agent_end has not necessarily arrived yet. */
    resultReadyAt?: number;
    recentTools?: RecentToolInfo[];
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
    /** Monotonic child-process owner; stale callbacks cannot mutate a replacement runtime. */
    runtimeGeneration?: number;
    /** Starts a cold runtime from the last persisted session and delivers one prompt. */
    restart?: (message: string) => boolean;
    restartPending?: Promise<void>;
    sessionId?: string;
    sessionFile?: string;
    sessionDir?: string;
    /** Resolved working directory of the run (local path or remote:<targetId>). */
    cwd?: string;
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
     * Optional Todo task ids bound to this agent at dispatch time (priority
     * order); emitted with `teammate:started` so the host can auto-delegate the
     * tasks' assignee and activate the first runnable one.
     */
    todos?: string[];
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
    phase?: AgentRunPhase;
    lastOutcome?: AgentRunOutcome;
    retry?: AgentRetryState;
    /** Pi emitted a final no-tool assistant turn; agent_end has not necessarily arrived yet. */
    resultReadyAt?: number;
    lastResult?: string;
    /** Schema-valid structured output of the settled run, kept for observe inspection. */
    structuredOutput?: unknown;
    /**
     * This dispatch runs in background/detached mode and will send a
     * `teammate-complete` notification on terminal settle. If it goes silent
     * past the stall confirmation window instead, the caller must be woken with
     * a `teammate-stalled` message — otherwise a stalled agent leaves the caller
     * waiting forever for a notification that never fires. Set when the dispatch
     * becomes background/detached; foreground in-window dispatches never set it.
     */
    notifyOnStall?: boolean;
    sleptAt?: number;
    sleepMs: number;
    progress?: AgentProgressSnapshot[];
}
export interface TeammateState {
    baseCwd: string;
    currentSessionId: string | null;
    /** Monotonic owner token for async work admitted by the current session. */
    sessionGeneration?: number;
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
     * Correlation id → timestamp of the last caller-facing stall notification
     * (throttle marker). A repeat notification is suppressed until the cooldown
     * elapses, so an agent that alternates activity and silence nudges the
     * caller at most once per cooldown window instead of on every silent spell.
     * Entries are removed when the agent settles terminally.
     */
    stallNotified?: Map<string, number>;
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
export interface AgentRunOutcome {
    status: AgentTerminalStatus;
    message?: string;
    settledAt: number;
}
export interface SettledAgentRecord {
    correlationId: string;
    agent: string;
    name?: string;
    status: AgentTerminalStatus;
    settledAt: number;
    lastResult?: string;
    /** Schema-valid structured output retained for observe full-detail reads after eviction. */
    structuredOutput?: unknown;
    requestedModel?: string;
    resolvedModel?: string;
    attemptedModels?: string[];
}
/**
 * Compact result projection carried on completion events so
 * background/detached results can be persisted to `agent://` without parsing
 * rendered messages. Deliberately smaller than `SingleResult`.
 *
 * A task carries `structuredOutput` when it completed with an `outputSchema`;
 * otherwise it carries `output` — the final assistant message text — so
 * `agent://` records exist for plain tasks too.
 */
export interface StructuredResult {
    correlationId: string;
    /** Unique identity of one published turn. */
    publicationId?: string;
    /** Durable completion dispatch linkage; absent for legacy publications. */
    completionDispatchId?: string;
    completionReservationId?: string;
    completionOutcome?: "completed" | "failed" | "terminated";
    /** Workspace cwd captured from the resolved task execution. */
    originCwd: string;
    /** Task name; absent when the dispatch had none. */
    name?: string;
    agent: string;
    /** Schema-valid structured output captured for this task. */
    structuredOutput?: unknown;
    /** Final assistant message text; present when the task had no outputSchema. */
    output?: string;
    /** Pinned model-registry route identity; absent in legacy/backend-registry mode. */
    provenance?: TeammateExecutionProvenance;
}
/**
 * Per-result publication boundary. Consumers register durable work synchronously
 * with `waitUntil`; DAG dependents are released after those promises settle.
 * Persistence consumers acknowledge the canonical resource only after the
 * result is durably readable.
 */
export interface TeammateResultPublishedEvent {
    result: StructuredResult;
    waitUntil(promise: Promise<unknown>): void;
    acknowledgeResource?(uri: string): void;
}
export declare const TEAMMATE_RESULT_PUBLISHED_EVENT = "teammate:result-published";
export declare const TEAMMATE_COMPLETE_EVENT = "teammate:complete";
export declare const TEAMMATE_STARTED_EVENT = "teammate:started";
export declare const TEAMMATE_MESSAGE_EVENT = "teammate:message";
export declare const TEAMMATE_VIEWING_EVENT = "teammate:viewing";
export declare const TEAMMATE_OPEN_AGENT_EVENT = "teammate:open-agent";
