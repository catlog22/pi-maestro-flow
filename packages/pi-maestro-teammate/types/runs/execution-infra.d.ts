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
import type { SingleResult, Usage, AgentProgress, AgentTerminalStatus } from "../shared/types.ts";
import { type LeaseToken } from "./session-handoff.ts";
import { type TeammateTaskType } from "../models/model-routing.ts";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import { type ModelCircuitBreaker } from "../models/model-circuit-breaker.ts";
import { type TeammateThinkingInput, type TeammateThinkingLevel } from "../shared/thinking.ts";
export interface TeammateTaskSpec {
    prompt: string;
    /** Short human-readable purpose; display label when the task has no name. */
    description?: string;
    agent?: string;
    taskType?: TeammateTaskType;
    name?: string;
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
}
export interface RunTeammateParams {
    tasks: TeammateTaskSpec[];
    agent?: string;
    taskType?: TeammateTaskType;
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
    maxAgents?: number;
    /**
     * How many levels of nested teammate dispatch the agents spawned by this
     * call may perform below themselves. 0 forbids nested calls entirely;
     * defaults to the global ceiling (MAX_DEFAULT_DEPTH).
     */
    maxNestingDepth?: number;
}
/** Parameters for the internal single-agent execution primitive. */
export interface RunSingleTeammateParams {
    agent: string;
    task?: string;
    taskType?: TeammateTaskType;
    name?: string;
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
}
export interface RunTeammateOptions {
    baseCwd: string;
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
    initialLeaseToken?: LeaseToken | ((correlationId: string) => LeaseToken | undefined);
    onChildSpawned?: (stdin: import("node:stream").Writable, sendControl: (message: Record<string, unknown>) => boolean, sessionDir?: string, correlationId?: string) => void;
    /** Existing persisted Pi session to load for a cold logical-agent restart. */
    resumeSessionFile?: string;
    /** Runtime generation used to fence callbacks from a replaced child process. */
    runtimeGeneration?: number;
    onChildClosed?: (correlationId: string, generation: number | undefined, details: {
        code: number | null;
        signal: NodeJS.Signals | null;
        settled: boolean;
    }) => void;
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
    /** @internal Test seam for the in-flight tool heartbeat interval. */
    toolExecutionHeartbeatMs?: number;
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
}
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
export declare function isStructuredOutputSettlementDiagnostic(content: string): boolean;
/**
 * Correlation ids are protocol identities, not filesystem-safe names.
 * Keep the original id for IPC while deriving a deterministic portable
 * component for --session-dir (notably ':' is invalid on Windows).
 */
export declare function correlationSessionDirectoryName(correlationId: string): string;
export declare function extractTextContent(event: JsonLineEvent): string | undefined;
/**
 * Pi's `agent_end` remains the authoritative terminal event. This stricter
 * `turn_end` shape means the model has supplied a usable final answer while
 * the child may still be waiting to publish its lifecycle confirmation.
 */
export declare function isPiResultReadyTurn(event: Record<string, unknown>): boolean;
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
export interface NormalizeTeammateResult {
    tasks: NormalizedTask[];
    isMultiTask: boolean;
    warnings: string[];
    error?: string;
}
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
export declare const ORDERED_THINKING_LEVELS: readonly TeammateThinkingLevel[];
export declare function clampThinkingForModel(thinking: TeammateThinkingLevel, model: string | undefined, modelCapabilities?: readonly TeammateModelCapability[]): TeammateThinkingLevel;
export declare const MODEL_SPECIFIER_PATTERN: RegExp;
export declare const MAX_MODEL_SPECIFIER_BYTES = 256;
export declare function validateModelSpecifier(model: string): string;
export declare function resolveModelSpecifier(model: string, modelCapabilities?: readonly TeammateModelCapability[]): string;
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
export declare function writeSystemPromptFile(agentConfig: AgentConfig, correlationId: string, outputSchema?: Record<string, unknown>): string;
export declare function writeSchemaFile(schema: Record<string, unknown>, correlationId: string): {
    schemaFile: string;
    outputFile: string;
};
export declare function cleanupFile(filePath: string): void;
export declare function createProgress(agent: string, startTime: number): AgentProgress;
export declare const CHILD_TERMINATION_GRACE_MS = 5000;
export declare const RESULT_READY_GRACE_MS = 60000;
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
