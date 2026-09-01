/**
 * Core teammate execution engine.
 *
 * Spawns a pi subprocess for agent execution, parses JSON lines from
 * stdout, tracks usage and progress, handles abort signals, and returns
 * a SingleResult.
 *
 * Supports single, parallel (tasks[]), and chain (chain[]) execution modes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import { type AgentConfig } from "../agents/agents.ts";
import type { SingleResult, Usage, AgentProgress, AgentTerminalStatus, AgentTurnEvent, AgentTurnTriggerContextV1, MessageProvenanceV1 } from "../shared/types.ts";
import type { RuntimeActorHostClient } from "../runtime-broker/actor-host.ts";
import { type LeaseToken } from "./session-handoff.ts";
import { type ResolvedModelRegistrationRouting, type TeammateTaskType } from "../models/model-routing.ts";
import type { DispatchAuthorityProjection } from "../models/model-registry.ts";
import type { ModelHealthCoordinator } from "../models/model-circuit-breaker.ts";
import type { BackendRegistry, ResolvedBackend } from "pi-maestro-backend-core/v1/registry";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import { type ModelCircuitBreaker } from "../models/model-circuit-breaker.ts";
import { type TeammateThinkingInput, type TeammateThinkingLevel } from "../shared/thinking.ts";
import { type ModelHealthFailureScopeClassifier } from "./retry.ts";
export interface TeammateTaskSpec {
    prompt: string;
    /** Short human-readable purpose; display label when the task has no name. */
    description?: string;
    agent?: string;
    taskType?: TeammateTaskType;
    name?: string;
    /**
     * Registered backend serving this task; the registry's default when absent.
     *
     * Deliberately absent from the model-facing tool schema. Which backends exist
     * is per-workspace registration, and a static schema cannot enumerate them,
     * so a model setting this field would be guessing at names it has never been
     * shown. Deployment-authored task specs — expert-mode rules and programmatic
     * callers — know the registration document and may set it.
     */
    backend?: string;
    dependsOn?: string[];
    context?: "fresh" | "fork";
    model?: string;
    fallbackModels?: string[];
    thinking?: TeammateThinkingInput;
    cwd?: string;
    outputSchema?: Record<string, unknown>;
    timeoutMs?: number;
    /**
     * Nesting budget override for the agent spawned by this task; overrides the
     * top-level maxNestingDepth. Omit to inherit the top-level value, which
     * itself defaults to the global ceiling (MAX_DEFAULT_DEPTH).
     */
    maxNestingDepth?: number;
    /**
     * Not supported per task — background is dispatch-level. Accepted by the
     * schema for compatibility; normalizeTeammateParams emits a warning and
     * ignores the value.
     */
    background?: boolean;
    /**
     * Optional Todo task id(s) bound to this agent, in priority order (first =
     * highest). On start the host re-assigns each task's assignee to the agent,
     * auto-activates the first runnable one, and injects the ordered list as a
     * managed fragment. `"12"`, `"#12"`, or an ordered array like
     * `["#1", "#2"]` are accepted.
     */
    todo?: string | string[];
    /**
     * Lazy background references appended to the task prompt without expansion
     * (`agent://<id>`, `file:<path>`, or literal text). The child decides whether
     * to load each one; see runs/briefing.ts.
     */
    briefing?: string[];
}
export type TeammateMode = "default" | "expert";
export interface RunTeammateParams {
    tasks: TeammateTaskSpec[];
    /**
     * Dispatch strategy. Expert mode turns one objective into a workflow Leader
     * that may build and run a nested teammate DAG.
     */
    mode?: TeammateMode;
    agent?: string;
    taskType?: TeammateTaskType;
    /** Default registered backend for tasks that name none; see TeammateTaskSpec.backend. */
    backend?: string;
    reply_to?: "caller" | "main";
    background?: boolean;
    context?: "fresh" | "fork";
    model?: string;
    fallbackModels?: string[];
    thinking?: TeammateThinkingInput;
    cwd?: string;
    timeoutMs?: number;
    outputSchema?: Record<string, unknown>;
    concurrency?: number;
    /**
     * Dedicated foreground detach window for parallel/DAG dispatches. This does
     * not cancel queued or running tasks; it only bounds how long the caller
     * stays attached before background completion delivery takes over.
     */
    concurrencyWaitMs?: number;
    maxAgents?: number;
    /**
     * How many levels of nested teammate dispatch the agents spawned by this
     * call may perform below themselves. 0 forbids nested calls entirely;
     * defaults to the global ceiling (MAX_DEFAULT_DEPTH).
     */
    maxNestingDepth?: number;
    /**
     * Overrides the child Pi subprocess steer-queue drain mode for this
     * dispatch. "all" co-injects all queued steers in one assistant turn;
     * "one-at-a-time" consumes one steer per turn. Omit to inherit the child's
     * Pi settings (default "one-at-a-time").
     */
    steeringMode?: "all" | "one-at-a-time";
}
/** Parameters for the internal single-agent execution primitive. */
export interface RunSingleTeammateParams {
    agent: string;
    task?: string;
    taskType?: TeammateTaskType;
    name?: string;
    /** Registered backend serving this task; the registry's default when absent. */
    backend?: string;
    reply_to?: "caller" | "main";
    protocol_version?: number;
    background?: boolean;
    context?: "fresh" | "fork";
    model?: string;
    fallbackModels?: string[];
    thinking?: TeammateThinkingInput;
    cwd?: string;
    timeoutMs?: number;
    outputSchema?: Record<string, unknown>;
    /** Todo task ids bound to this agent; injected into the child system prompt. */
    todos?: string[];
    /** Lazy background references appended to the task prompt (see runs/briefing.ts). */
    briefing?: string[];
}
export interface ModelRegistryDispatchContext {
    readonly authority: DispatchAuthorityProjection;
    readonly registry: BackendRegistry;
    /** Projection-pinned target maps backed by the process-wide breaker stores. */
    readonly modelHealthCoordinator: ModelHealthCoordinator;
    readonly plansByCorrelationId: ReadonlyMap<string, ResolvedModelRegistrationRouting>;
    readonly resolutionsByCorrelationId: ReadonlyMap<string, ReadonlyMap<string, ResolvedBackend>>;
}
export interface RunTeammateOptions {
    baseCwd: string;
    /**
     * Registry resolving each task's backend.
     *
     * Omitted keeps the legacy path: the orchestrator calls the Pi attempt
     * directly. Supplying one routes every task through the backend contract,
     * which is what the `backend-registry` execution mode does — including Pi,
     * which registers under its ordinary name. Both paths settle into the same
     * outcome, so nothing downstream branches on which ran.
     */
    backendRegistry?: BackendRegistry;
    /** Captured model-registry dispatch authority; omitted outside model-registry mode. */
    modelRegistryAuthority?: DispatchAuthorityProjection;
    /** Scoped model/deployment health authority used only in model-registry mode. */
    modelHealthCoordinator?: ModelHealthCoordinator;
    /** Optional structured backend-aware failure attribution for scoped health. */
    modelHealthFailureScopeClassifier?: ModelHealthFailureScopeClassifier;
    /**
     * Rechecks the exact root Monitor authority generation captured for this
     * dispatch. Remote model registrations are denied when this is absent or
     * returns false.
     */
    authorizeRemoteModelDispatch?: () => boolean;
    /** @internal Pinned graph/single preflight shared across candidate attempts. */
    modelRegistryDispatch?: ModelRegistryDispatchContext;
    /**
     * The host's remote Monitor wiring.
     *
     * Omitted by a dispatch that owns no Monitor term, which makes a remote
     * registration fail to load and the dispatch refuse the task by name rather
     * than run it on this machine.
     */
    remoteManagerOf?: () => import("pi-maestro-backends/remote").RemoteWorkerManagerLike;
    modelCapabilities?: readonly TeammateModelCapability[];
    modelCircuitBreaker?: ModelCircuitBreaker;
    /**
     * When false, the model-candidate sweep switches candidates without any
     * inter-attempt backoff. Defaults to true: transient network/provider
     * failures wait a bounded exponential delay before the next candidate,
     * while quota/auth/permanent failures switch immediately.
     */
    enableRetryBackoff?: boolean;
    /**
     * Main-session model id (e.g. `provider/model`) to inherit when a dispatch
     * sets no explicit task- or top-level model. Configured task-type mappings
     * still win; this is the default fallback below them.
     */
    inheritModel?: string;
    correlationId?: string;
    taskCorrelationIds?: string[];
    /** Task-local cancellation signals for graph members; `signal` remains graph-wide. */
    taskSignals?: AbortSignal[];
    /**
     * Nesting depth of the dispatch being run. Callers that own the agent tree
     * (the teammate extension) always pass this; direct callers may omit it and
     * fall back to the process environment.
     */
    depth?: number;
    /**
     * Absolute maximum depth the agents spawned by this dispatch may dispatch
     * at (their children's record-depth ceiling). Computed by the caller from
     * maxNestingDepth and the parent agent's own budget; carried into the child
     * process via PI_TEAMMATE_MAX_DISPATCH_DEPTH.
     */
    maxDispatchDepth?: number;
    signal?: AbortSignal;
    /** Optional shared Runtime Broker actor host; omitted creates a run-scoped host from PI_RUNTIME_BROKER. */
    runtimeActorHost?: RuntimeActorHostClient;
    onProgress?: (data: AgentProgress) => void;
    onRetry?: (retry: {
        correlationId: string;
        attempt: number;
        maxRetries: number;
        delayMs: number;
        nextRetryAt: number;
        error: string;
    }) => void;
    onChildRequest?: (event: Record<string, unknown>, reply: (msg: unknown) => void) => void;
    onChildEvent?: (event: Record<string, unknown>) => void;
    parentSessionFile?: string;
    /** Explicit private session directory for independent long-lived children. */
    sessionDir?: string;
    /** Additional child-only environment values (never applied to the host). */
    childEnvironment?: Record<string, string | undefined>;
    /** Attribution for the original task prompt; malformed input is downgraded to strict unknown. */
    initialMessageProvenance?: MessageProvenanceV1;
    /** Per-task attribution for graph runs; takes precedence over the shared initial value. */
    initialMessageProvenanceOf?: (correlationId: string) => MessageProvenanceV1 | undefined;
    /** Stable logical identity reused by every physical model candidate in this run. */
    initialTurnContext?: AgentTurnTriggerContextV1;
    /** Low-level loop offset owned by this physical model-candidate process. */
    turnLoopSeqOffset?: number;
    /** Whether this attempt owns publication of the initial trigger-enqueued edge. */
    emitInitialTurnTrigger?: boolean;
    /** Transport-sidecar sink for canonical logical-turn lifecycle events. */
    recordTurnEvent?: (event: AgentTurnEvent) => void;
    initialLeaseToken?: LeaseToken | ((correlationId: string) => LeaseToken | undefined);
    onChildSpawned?: (stdin: import("node:stream").Writable, sendControl: (message: Record<string, unknown>) => boolean, sessionDir?: string, correlationId?: string, 
    /** Runtime generation of the spawning run, mirroring onChildClosed. */
    generation?: number) => void;
    /** Existing persisted Pi session to load for a cold logical-agent restart. */
    resumeSessionFile?: string;
    /**
     * Initial prompt issued to a resumed child instead of the original task
     * text. The task prompt already lives inside the loaded session history, so
     * re-sending it would make the model re-read (and possibly re-execute) the
     * original request; a resume prompt directs the model to continue from the
     * recorded state instead.
     */
    resumePrompt?: string;
    /**
     * In-process model failover: called when the child settles a turn with a
     * retryable provider error while its runtime is still alive. Return the
     * next model id (`provider/model`) to hot-swap via the child's `set_model`
     * RPC and continue the same session, or `undefined` to settle the failure.
     * `setModel` is the physical switch used by the pi subprocess; this is the
     * teammate-side decision hook that drives it.
     *
     * `previousModel` is the model the child is currently running under after
     * an earlier in-process switch (undefined on the first failure). A hook
     * that accepts it should settle that model's trial outcome (it just failed
     * again); the default teammate hook does this and never re-selects a model
     * already tried in this run.
     */
    onModelFailover?: (error: string, previousModel?: string) => string | undefined | Promise<string | undefined>;
    /** Runtime generation used to fence callbacks from a replaced child process. */
    runtimeGeneration?: number;
    onChildClosed?: (correlationId: string, generation: number | undefined, details: {
        code: number | null;
        signal: NodeJS.Signals | null;
        settled: boolean;
    }) => void;
    /**
     * Runs once when the final consumable result is published, before the caller
     * or a DAG dependent can observe it. Observer failures are non-fatal.
     */
    onResultPublished?: (result: SingleResult, originCwd: string) => void | Promise<void>;
    onTurnComplete?: (result: SingleResult, terminalStatus?: AgentTerminalStatus) => void;
    /** Physical child-process reclamation, independent of logical turn settlement. */
    onReclamationOutcome?: (correlationId: string, outcome: ChildReclamationOutcome) => void;
    /** @internal Test seam for child lifecycle regression coverage. */
    spawnChildProcess?: typeof crossSpawn;
    /** @internal Test seam for retry scheduling. */
    waitForRetry?: (delayMs: number, signal?: AbortSignal) => Promise<boolean>;
    /** @internal Test seam for the first child activity deadline. */
    firstActivityTimeoutMs?: number;
    /** @internal Test seam for the result-ready grace period. */
    resultReadyGraceMs?: number;
    /** @internal Test seam for child output-limit compaction/continuation recovery. */
    outputLimitRecoveryTimeoutMs?: number;
    /** @internal Test seam for the corrective structured-output continuation deadline. */
    structuredOutputRecoveryTimeoutMs?: number;
    /** @internal Test seam for the in-flight tool heartbeat interval. */
    toolExecutionHeartbeatMs?: number;
    /** @internal Test seam for the interrupting-steer acknowledgement deadline. */
    interruptingSteerTimeoutMs?: number;
    /** @internal Test seam for model selection, set_model and resume acknowledgement deadlines. */
    modelSwitchAckTimeoutMs?: number;
    /**
     * Pi subprocess steer-queue drain mode. "all" injects every queued steer
     * message in a single assistant turn (co-injection); "one-at-a-time" (the
     * Pi default, left implicit) consumes one steer per turn. Only "all" is
     * sent to the child via `set_steering_mode`; omitting this field keeps the
     * child's inherited Pi settings.
     */
    steeringMode?: "all" | "one-at-a-time";
    /** @internal Foreground wait window before the extension detaches a still-running task. */
    foregroundMaxRunMs?: number;
}
export interface NormalizedTask {
    agent: string;
    prompt: string;
    /** Short human-readable purpose; display label when the task has no name. */
    description?: string;
    taskType?: TeammateTaskType;
    name?: string;
    /** Registered backend serving this task; the registry's default when absent. */
    backend?: string;
    dependsOn?: string[];
    context?: "fresh" | "fork";
    model?: string;
    fallbackModels?: string[];
    thinking?: TeammateThinkingLevel;
    cwd?: string;
    outputSchema?: Record<string, unknown>;
    timeoutMs?: number;
    /** Effective nesting budget: task value ?? top-level value (undefined = ceiling). */
    maxNestingDepth?: number;
    /** Optional Todo task ids bound to this agent (see TeammateTaskSpec.todo). */
    todos?: string[];
    /** Lazy background references (see TeammateTaskSpec.briefing). */
    briefing?: string[];
}
/**
 * Project one normalized task into the params `runSingleTeammate` takes.
 *
 * The single home for that projection. Four call sites across the two extension
 * modules built this object inline — root dispatch, nested dispatch, and their
 * two cold-restart paths — and a field left out of one of them does not fail:
 * the run simply proceeds without it. `todos` reached only the graph builder
 * for exactly that reason, so `spec.todos` was undefined on every single
 * dispatch, and both the capability gate and the dsh bridge assertion that key
 * off it could never fire. One builder is what gives that projection an owner.
 *
 * The prompt is an argument rather than `source.prompt` because a cold restart
 * replays the message that woke the agent, not the prompt it was dispatched
 * with; `context` and `timeoutMs` are arguments for the same reason.
 *
 * @param source - the normalized task carrying what the request declared.
 * @param overrides - what the call site owns: the prompt text, the reply
 *   target, and, on a restart, the fixed context and the task's timeout.
 * @returns the params object for one `runSingleTeammate` call.
 */
export declare function singleRunParamsOf(source: NormalizedTask, overrides: {
    task: string;
    reply_to?: "caller" | "main";
    context?: "fresh" | "fork";
    timeoutMs?: number;
}): RunSingleTeammateParams;
export interface JsonLineEvent {
    type: string;
    content?: string;
    usage?: Partial<Usage>;
    model?: string;
    error?: string;
    name?: string;
    [key: string]: unknown;
}
export declare const STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS: {
    readonly agentEnd: "The teammate completed without calling structured_output with a schema-valid value.";
    readonly close: "The teammate exited without schema-valid structured_output.";
    readonly resultReadyGrace: "The teammate published a result but did not settle with schema-valid structured_output in time.";
};
export declare const STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTIC_SET: Set<string>;
/**
 * Child-facing corrective continuation issued once when a wakeable child ends
 * its run without schema-valid structured_output. Instructs a single bounded
 * resubmission and explicitly forbids repeating any other work.
 */
export declare const STRUCTURED_OUTPUT_RECOVERY_PROMPT: string;
export declare function isStructuredOutputSettlementDiagnostic(content: string): boolean;
/**
 * Initial prompt for a resume-based model fallback (cold restart with a
 * session checkpoint, or an in-process `set_model` switch). The original task
 * text already lives inside the loaded session history, so this directive
 * replaces it: the new model continues from the recorded state instead of
 * re-reading (and possibly re-executing) the original request.
 */
export declare const MODEL_FALLBACK_RESUME_PROMPT: string;
/**
 * Correlation ids are protocol identities, not filesystem-safe names.
 * Keep the original id for IPC while deriving a deterministic portable
 * component for --session-dir (notably ':' is invalid on Windows).
 */
export declare function correlationSessionDirectoryName(correlationId: string): string;
export declare function extractTextContent(event: JsonLineEvent): string | undefined;
/**
 * Optional context for distinguishing a final assistant turn from an interim
 * text-only turn emitted while tool calls are still in flight. Without this,
 * an LLM that narrates progress mid-task ("starting the read-only scan...") can
 * trip result-ready and publish a consumable result before its tool work is
 * done, leaving the lifecycle waiting for an `agent_settled` that never comes.
 */
export interface ResultReadyTurnContext {
    /** Tools that have started but not yet produced a result (in-flight). */
    inFlightToolCount?: number;
    /** Tools that have completed in this run so far. */
    completedToolCount?: number;
}
/**
 * Pi's `agent_end` remains the authoritative terminal event. This stricter
 * `turn_end` shape means the model has supplied a usable final answer while
 * the child may still be waiting to publish its lifecycle confirmation.
 *
 * When `context` is supplied, a text-only turn is treated as interim (not
 * result-ready) if tools are still in flight: the narration likely precedes
 * the tool results rather than being the final answer. Without `context` the
 * original strict shape check is preserved (backward compatible).
 */
export declare function isPiResultReadyTurn(event: Record<string, unknown>, context?: ResultReadyTurnContext): boolean;
export interface StructuredOutputCandidate {
    value: unknown;
    toolCallId?: string;
}
export declare function extractStructuredOutputCandidate(event: Record<string, unknown>, schema: Record<string, unknown>): StructuredOutputCandidate | undefined;
/**
 * Extracts a schema-valid structured_output payload from a Pi assistant event.
 * Execution code treats this as pending until the tool execution succeeds.
 */
export declare function extractValidatedStructuredOutput(event: Record<string, unknown>, schema: Record<string, unknown>): unknown | undefined;
export declare function describeStructuredOutputValueValidationFailure(value: unknown, schema: Record<string, unknown>): string | undefined;
export declare function describeStructuredOutputValidationFailure(event: Record<string, unknown>, schema: Record<string, unknown>): string | undefined;
export declare function extractPiEventError(event: Record<string, unknown>): string | undefined;
export declare function validateStructuredOutputValue(value: unknown, schema: Record<string, unknown>): boolean;
export interface Utf8LineDecoder {
    write(chunk: Buffer): string[];
    end(): string[];
}
export declare const EXECUTION_BUFFER_LIMITS: Readonly<{
    lineBytes: number;
    streamBytes: number;
    stderrBytes: number;
    toolItems: 10;
    toolNameBytes: 1024;
    transcriptMessages: 128;
    transcriptMessageBytes: number;
    transcriptBytes: number;
}>;
export declare function truncateUtf8Tail(value: string, maxBytes: number): string;
export declare function truncateUtf8Head(value: string, maxBytes: number): string;
export declare function appendUtf8Tail(current: string, addition: string, maxBytes: number): string;
export type TranscriptEntry = {
    role: string;
    content: string;
};
export declare const transcriptEntryBytes: WeakMap<TranscriptEntry, number>;
export declare const transcriptTotals: WeakMap<object, {
    length: number;
    bytes: number;
}>;
export declare function entryBytes(entry: TranscriptEntry): number;
export declare function transcriptTotalBytes(messages: TranscriptEntry[]): number;
export declare function appendBoundedTranscriptMessage(messages: Array<{
    role: string;
    content: string;
}>, message: {
    role: string;
    content: string;
}): void;
export declare function createUtf8LineDecoder(maxBufferedBytes?: number): Utf8LineDecoder;
export declare function appendDistinctAssistantMessage(messages: Array<{
    role: string;
    content: string;
}>, content: string): boolean;
export declare function emptyUsage(): Usage;
export declare function usageNumber(value: unknown): number;
export declare function setUsageSnapshot(total: Usage, partial: Record<string, unknown>): void;
export declare function addUsageSnapshot(total: Usage, partial: Record<string, unknown>): void;
export declare function resetUsage(usage: Usage): void;
export declare function releasePublishedTurnHistory(messages: Array<{
    role: string;
    content: string;
}>, progress: AgentProgress, usage: Usage): void;
export declare const VAR_PATTERN_SOURCE = "\\{([a-zA-Z_][a-zA-Z0-9_-]*)((?:\\.[a-zA-Z_][a-zA-Z0-9_-]*|\\[\\d+\\])*)\\}";
export interface TaskOutput {
    text: string;
    structured?: unknown;
}
export declare function extractDependencies(template: string | undefined, taskNames: Set<string>): string[];
/**
 * Collect `{name}` references in a template that do NOT match any task name.
 * These are passed through as literal text at resolution time — surfacing
 * them lets callers distinguish intentional literals from misspelled refs.
 */
export declare function collectUnknownRefs(template: string | undefined, taskNames: Set<string>): string[];
export declare function editDistance(a: string, b: string): number;
/**
 * Union of a task's implicit `{name}` references and explicit dependsOn names.
 * Single source of truth for graph edges — used by inferGraphMode, runGraph,
 * and progress snapshots so all three agree on the dependency set.
 */
export declare function taskDependencyNames(task: Pick<NormalizedTask, "prompt" | "dependsOn">, taskNames: Set<string>): string[];
/**
 * Validate task references before dispatch.
 *
 * - dependsOn entries must match an existing task name — strict error
 *   (no literal-text ambiguity exists for an explicit dependency list).
 * - Unknown `{name}` refs close to an existing task name (edit distance)
 *   are treated as misspellings — error, because silently running the task
 *   without the intended dependency is worse than rejecting.
 * - Other unknown `{name}` refs are legitimate literals — warning only.
 *   Skipped entirely when no task has a name (reference intent impossible).
 */
export declare function validateTaskReferences(tasks: NormalizedTask[]): {
    errors: string[];
    warnings: string[];
};
export declare function resolvePath(obj: unknown, pathStr: string): unknown;
export declare function resolveVariables(template: string, outputs: Map<string, TaskOutput>, taskNames: Set<string>): string;
export declare function hasCycle(adjList: number[][]): boolean;
export declare function inferGraphMode(tasks: NormalizedTask[]): "parallel" | "chain" | "graph";
/**
 * Normalize a `todo` binding (single id or ordered array) into a de-duplicated
 * ordered id list. The array order is the priority order (first = highest).
 */
export declare function normalizeTodoBindings(todo: string | string[] | undefined): string[] | undefined;
/** Dedupe and trim briefing entries; empty results collapse to undefined. */
export declare function normalizeBriefingEntries(briefing: string[] | undefined): string[] | undefined;
/** Public task prompt budget, measured after UTF-8 encoding. */
export declare const MAX_TASK_PROMPT_BYTES: number;
/** Return an actionable boundary error for a task prompt, if any. */
export declare function taskPromptBoundaryError(prompt: unknown): string | undefined;
export interface NormalizeTeammateResult {
    tasks: NormalizedTask[];
    isMultiTask: boolean;
    warnings: string[];
    error?: string;
}
export declare const EXPERT_MODE_LEADER_AGENT = "workflow";
export declare const EXPERT_MODE_LEADER_TASK_TYPE: TeammateTaskType;
export declare const EXPERT_MODE_LEADER_NAME = "expert-leader";
export declare const EXPERT_MODE_PROMPT_START = "<expert-leader-contract>";
export declare const EXPERT_MODE_PROMPT_END = "</expert-leader-contract>";
export declare function buildExpertLeaderPrompt(objective: string): string;
/**
 * Expand the lightweight expert strategy before model routing. The workflow
 * agent is the Leader; its existing teammate access and nesting budget provide
 * the expert DAG without a second execution engine or persistent mode state.
 */
export declare function prepareTeammateMode(params: RunTeammateParams): RunTeammateParams;
/** Normalize the tasks-only public contract into executable graph tasks. */
export declare function normalizeTeammateParams(params: RunTeammateParams): NormalizeTeammateResult;
export declare let resolvedPiEntryPoint: string | null | undefined;
export declare function resolvePiEntryPoint(): string | null;
export interface PiSpawnCommandOptions {
    envBinary?: string | null;
    entryPoint?: string | null;
    platform?: NodeJS.Platform;
}
export declare function getPiSpawnCommand(args: string[], options?: PiSpawnCommandOptions): {
    command: string;
    args: string[];
    shell: false;
};
export interface InteractiveTerminalLaunchOptions {
    platform?: NodeJS.Platform;
    terminalCommand?: string;
    title?: string;
    env?: NodeJS.ProcessEnv;
}
export interface InteractiveTerminalLaunchSpec {
    command: string;
    args: string[];
    cwd: string;
}
/** Build a shell-free terminal launcher where the platform supports argv forwarding. */
export declare function getInteractiveTerminalLaunchSpec(piCommand: {
    command: string;
    args: readonly string[];
}, cwd: string, options?: InteractiveTerminalLaunchOptions): InteractiveTerminalLaunchSpec;
export interface ProcessTreeByPidOptions {
    platform?: NodeJS.Platform;
    spawnProcess?: typeof crossSpawn;
    killProcess?: typeof process.kill;
    isProcessAlive?: (pid: number) => boolean;
    graceMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
}
/** Terminate an explicitly owned process tree; callers must revalidate PID ownership first. */
export declare function terminateProcessTreeByPid(pid: number, options?: ProcessTreeByPidOptions): Promise<"stopped" | "already-exited">;
/** Maximum number of teammate-agent levels below the main agent. */
export declare const MAX_DEFAULT_DEPTH = 2;
export declare const DEFAULT_MAX_AGENTS = 15;
/**
 * Ceiling on concurrently live agents across the whole dispatch tree. The
 * per-call `maxAgents` limit only bounds a single dispatch, so without this a
 * depth-2 tree of 15-task graphs could reach 15^2 child processes.
 */
export declare const DEFAULT_MAX_ACTIVE_AGENTS = 32;
export declare function resolveMaxAgents(explicit?: number): number;
export declare function resolveMaxActiveAgents(): number;
/**
 * Fallback depth for dispatches that do not carry an explicit one — i.e. direct
 * `runTeammate` callers outside the extension (delegate/explore/moa). Nested
 * teammate calls never reach this: their child process only proxies the request
 * back to the root process, so the root's own environment would always read 0.
 * Those paths pass `RunTeammateOptions.depth` instead.
 */
export declare function getTeammateDepth(): number;
/**
 * Child-scoped nesting budget (absolute max dispatch depth). Only meaningful
 * inside a spawned child process; callers MUST gate the read on `isChild`.
 */
export declare function getTeammateMaxDispatchDepth(): number;
export declare function checkDepthGuard(depth: number): {
    allowed: boolean;
    current: number;
    max: number;
};
/**
 * Absolute max dispatch depth for agents spawned by a root (depth-0) dispatch.
 * `maxNestingDepth: 0` forbids nested calls entirely; the global ceiling caps
 * any larger value, so under the current MAX only 0 vs 1+ are distinguishable.
 */
export declare function rootChildMaxDispatchDepth(maxNestingDepth?: number): number;
/**
 * Absolute max dispatch depth for agents spawned by a proxied dispatch from a
 * parent with `parentBudget`, at `childDepth`. The parent's budget is the hard
 * cap; the call's own `maxNestingDepth` may only tighten it further.
 */
export declare function nestedChildMaxDispatchDepth(parentBudget: number, childDepth: number, maxNestingDepth?: number): number;
/** Whether a dispatch creating agents at `dispatchDepth` is allowed under `parentBudget`. */
export declare function dispatchAllowed(parentBudget: number, dispatchDepth: number): boolean;
/** Budget of an agent record that predates per-dispatch budgets: global ceiling. */
export declare function agentDispatchBudget(agent: {
    maxDispatchDepth?: number;
}): number;
export declare function getTeammateSessionRoot(parentSessionFile: string | null): string | undefined;
export declare function buildModelCandidates(primary?: string, fallbacks?: string[]): string[];
export declare function isFallbackModelError(messages: Array<{
    role: string;
    content: string;
}>): boolean;
export declare function resultFailureMessage(messages: Array<{
    role: string;
    content: string;
}>): string;
export declare function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<boolean>;
export interface RetrySettingSnapshot {
    hadRetry: boolean;
    hadEnabled: boolean;
    enabled?: boolean;
}
export interface RetryPersistenceGuard {
    depth: number;
    snapshot?: RetrySettingSnapshot;
    restoreTimer?: ReturnType<typeof setTimeout>;
}
export declare const retryPersistenceGuards: Map<string, RetryPersistenceGuard>;
/**
 * Pi's RPC set_auto_retry command persists to settings.json even though the
 * child only needs a session-local override. Restore the original value after
 * every concurrently starting child has acknowledged that command.
 */
export declare function acquireRetryPersistenceGuard(settingsPath: string): () => void;
export declare function readRetrySettingSnapshot(settingsPath: string): RetrySettingSnapshot | undefined;
export declare function restoreRetrySettingSnapshot(settingsPath: string, snapshot: RetrySettingSnapshot): void;
export declare function childSettingsPath(env: NodeJS.ProcessEnv): string;
export declare const MODEL_SPECIFIER_PATTERN: RegExp;
export declare const MAX_MODEL_SPECIFIER_BYTES = 256;
export declare function validateModelSpecifier(model: string): string;
/**
 * Check a specifier the host does not own the format of.
 *
 * A dispatch bound for a registered backend names a model in that backend's
 * catalogue — an ACP agent's bracketed variant, a dsh route, a remote target's
 * own identifier. The host neither defines those namespaces nor can resolve
 * them, so `MODEL_SPECIFIER_PATTERN`, which encodes the host's own
 * `provider/model` convention, is the wrong authority.
 *
 * What survives is not a format claim but protection for the host's own
 * machinery: these strings become circuit-breaker keys, log lines, and, for
 * some backends, process arguments. A bound and a control-character refusal
 * keep those safe without deciding what a foreign namespace may look like.
 *
 * @param model - the specifier a backend will resolve for itself.
 * @returns the specifier unchanged.
 * @throws when it is empty, oversized, or carries control characters.
 */
export declare function validateBackendModelSpecifier(model: string): string;
export declare function resolveModelSpecifier(model: string, modelCapabilities?: readonly TeammateModelCapability[]): string;
export declare function buildInheritedExtensionArgs(primaryExtensionPath: string): string[];
export declare function managedWindowSpawnEnv(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export interface ManagedWindowArgsOptions {
    sessionName: string;
    presentation: "headless" | "interactive";
    forkSessionFile?: string;
}
export declare function buildManagedWindowPiArgs(options: ManagedWindowArgsOptions): string[];
export declare function buildPiArgs(agentConfig: AgentConfig, params: RunSingleTeammateParams, systemPromptFile: string, modelOverride?: string, sessionDir?: string, forkSessionFile?: string, schemaFile?: string, modelCapabilities?: readonly TeammateModelCapability[], resumeSessionFile?: string): string[];
export declare const PRIVATE_DIRECTORY_MODE = 448;
export declare const PRIVATE_FILE_MODE = 384;
export declare function shouldEnforcePosixMode(): boolean;
/**
 * Root for prompt/schema/result scratch files, whose contents include the full
 * agent system prompt.
 *
 * POSIX gets its privacy from chmod(0o700). Windows ignores mkdir modes and has
 * no fchmod, so the only lever left is location: %LOCALAPPDATA% is already a
 * per-user tree, unlike the shared %TEMP% fallback.
 */
export declare function teammateTempRoot(): string;
export declare function ensurePrivateDirectory(directoryPath: string): void;
export declare function writePrivateTextFile(filePath: string, content: string): void;
export declare function openPrivateRegularFile(filePath: string): number;
export declare function errorCode(error: unknown): string | undefined;
export declare function readRegularTextFile(filePath: string): string;
export declare function writeSystemPromptFile(agentConfig: AgentConfig, correlationId: string, outputSchema?: Record<string, unknown>, todos?: string[]): string;
export declare function writeSchemaFile(schema: Record<string, unknown>, correlationId: string): {
    schemaFile: string;
    outputFile: string;
};
export declare function cleanupFile(filePath: string): void;
export declare function createProgress(agent: string, startTime: number): AgentProgress;
export declare const CHILD_TERMINATION_GRACE_MS = 5000;
export declare const RESULT_READY_GRACE_MS = 60000;
export declare const RESULT_READY_GRACE_EXTENDED_MS = 120000;
/** Select one consistent lifecycle grace for text and structured-output lanes. */
export declare function resultReadyGraceMsFor(completedToolCount: number, overrideMs?: number): number;
export declare const STRUCTURED_OUTPUT_RECOVERY_TIMEOUT_MS = 60000;
export declare const OUTPUT_LIMIT_RECOVERY_TIMEOUT_MS: number;
export declare const FIRST_ACTIVITY_TIMEOUT_MS = 120000;
/**
 * Resolve `params.cwd` relative to the session directory while permitting an
 * explicit path outside the current project. Existing paths are canonicalized;
 * non-existent paths keep their lexical form so spawn reports the normal error.
 */
export declare function canonicalDirectoryPath(candidate: string): string;
export declare function resolveContainedCwd(requested: string | undefined, baseCwd: string): {
    cwd: string;
} | {
    error: string;
};
/** Prefix marking a working location as a configured remote target. */
export declare const REMOTE_LOCATION_PREFIX = "remote:";
/** A remote working location, read as a backend selection. */
export interface RemoteLocationRouting {
    readonly backend: string;
    readonly targetId: string;
}
/**
 * Read a working location as a backend selector.
 *
 * The whole string, prefix included, is the registration name, so a bare
 * `remote:` with no target still names one — and the registry rejects it as
 * unregistered, which is the failure this should have.
 *
 * This is the single projection point for the rule. Every dispatch path resolves
 * its location through it, so a nested or proxied dispatch is routed by the same
 * rule rather than falling through to `resolveContainedCwd`, which would read
 * `remote:beta` as a directory named `remote:beta` under the base.
 *
 * @param cwd - the task's requested working location.
 * @returns the routing, or undefined when the location is an ordinary directory.
 */
export declare function remoteLocationRouting(cwd: string | undefined): RemoteLocationRouting | undefined;
export declare const STRUCTURED_OUTPUT_SCHEMA_LIMITS: Readonly<{
    maxBytes: number;
    maxDepth: 20;
    maxPatternLength: 200;
}>;
export declare const NESTED_QUANTIFIER: RegExp;
export declare function isRiskyRegexSource(source: string): boolean;
/**
 * The model may submit any JSON Schema, and TypeBox compiles its `pattern`
 * keywords into RegExp objects that then run on this process's main thread on
 * every assistant event. Reject the hazardous shapes up front instead of
 * silently dropping keywords, so a valid schema still validates exactly as before.
 */
export declare function findStructuredOutputSchemaHazard(schema: Record<string, unknown>): string | undefined;
export type ChildReclamationOutcome = {
    status: "reclaimed";
    forced: boolean;
    /** False when the direct child exited but Windows taskkill never confirmed its tree sweep. */
    treeCleanupConfirmed?: false;
} | {
    status: "unreaped";
    forced: boolean;
    reason: "delivery-failed" | "exit-unconfirmed" | "cleanup-before-exit";
};
export interface ChildTerminationController {
    /** Bounded physical-process outcome, separate from logical turn settlement. */
    readonly outcome: Promise<ChildReclamationOutcome>;
    terminate(): void;
    cleanup(): void;
}
export interface ChildTerminationOptions {
    graceMs?: number;
    /** Bound after the forced attempt for exit/tree-cleanup acknowledgement. */
    reclamationTimeoutMs?: number;
    platform?: NodeJS.Platform;
    spawnProcess?: typeof spawn;
}
/** @internal Exported for lifecycle regression tests. */
export declare function createChildTerminationController(child: ChildProcess, options?: ChildTerminationOptions): ChildTerminationController;
/** @internal Exported for lifecycle regression tests. */
export declare function bindChildTerminationSignal(termination: ChildTerminationController, signal?: AbortSignal): () => void;
