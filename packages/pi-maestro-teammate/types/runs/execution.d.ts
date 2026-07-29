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
import type { Writable } from "node:stream";
import crossSpawn from "cross-spawn";
import { type AgentConfig } from "../agents/agents.ts";
import type { SingleResult, Usage, AgentProgress } from "../shared/types.ts";
import { type LeaseToken } from "./session-handoff.ts";
import { type TeammateTaskType } from "../models/model-routing.ts";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import { type ModelCircuitBreaker } from "../models/model-circuit-breaker.ts";
import { type TeammateThinkingInput, type TeammateThinkingLevel } from "../shared/thinking.ts";
export interface TeammateTaskSpec {
    prompt: string;
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
    correlationId?: string;
    taskCorrelationIds?: string[];
    /**
     * Nesting depth of the dispatch being run. Callers that own the agent tree
     * (the teammate extension) always pass this; direct callers may omit it and
     * fall back to the process environment.
     */
    depth?: number;
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
    onTurnComplete?: (result: SingleResult) => void;
    /** @internal Test seam for child lifecycle regression coverage. */
    spawnChildProcess?: typeof crossSpawn;
    /** @internal Test seam for retry scheduling. */
    waitForRetry?: (delayMs: number, signal?: AbortSignal) => Promise<boolean>;
    /** @internal Test seam for the result-ready grace period. */
    resultReadyGraceMs?: number;
    /** @internal Test seam for the foreground absolute run ceiling. */
    foregroundMaxRunMs?: number;
}
export interface NormalizedTask {
    agent: string;
    prompt: string;
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
}
export declare const STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS: {
    readonly agentEnd: "The teammate completed without calling structured_output with a schema-valid value.";
    readonly close: "The teammate exited without schema-valid structured_output.";
    readonly resultReadyGrace: "The teammate published a result but did not settle with schema-valid structured_output in time.";
};
export declare function isStructuredOutputSettlementDiagnostic(content: string): boolean;
/**
 * Correlation ids are protocol identities, not filesystem-safe names.
 * Keep the original id for IPC while deriving a deterministic portable
 * component for --session-dir (notably ':' is invalid on Windows).
 */
export declare function correlationSessionDirectoryName(correlationId: string): string;
/**
 * Pi's `agent_end` remains the authoritative terminal event. This stricter
 * `turn_end` shape means the model has supplied a usable final answer while
 * the child may still be waiting to publish its lifecycle confirmation.
 */
export declare function isPiResultReadyTurn(event: Record<string, unknown>): boolean;
/**
 * Captures a schema-valid structured_output call from Pi's assistant event.
 * This is a fallback for the small window before the child output file becomes
 * observable to the parent runner.
 */
export declare function extractValidatedStructuredOutput(event: Record<string, unknown>, schema: Record<string, unknown>): unknown | undefined;
export declare function describeStructuredOutputValidationFailure(event: Record<string, unknown>, schema: Record<string, unknown>): string | undefined;
export declare function extractPiEventError(event: Record<string, unknown>): string | undefined;
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
export declare function releasePublishedTurnHistory(messages: Array<{
    role: string;
    content: string;
}>, progress: AgentProgress, usage: Usage): void;
interface TaskOutput {
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
export declare function resolveVariables(template: string, outputs: Map<string, TaskOutput>, taskNames: Set<string>): string;
export declare function inferGraphMode(tasks: NormalizedTask[]): "parallel" | "chain" | "graph";
export interface NormalizeTeammateResult {
    tasks: NormalizedTask[];
    isMultiTask: boolean;
    warnings: string[];
    error?: string;
}
/** Normalize the tasks-only public contract into executable graph tasks. */
export declare function normalizeTeammateParams(params: RunTeammateParams): NormalizeTeammateResult;
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
export declare function checkDepthGuard(depth: number): {
    allowed: boolean;
    current: number;
    max: number;
};
export declare function clampThinkingForModel(thinking: TeammateThinkingLevel, model: string | undefined, modelCapabilities?: readonly TeammateModelCapability[]): TeammateThinkingLevel;
export declare function validateModelSpecifier(model: string): string;
export declare function resolveModelSpecifier(model: string, modelCapabilities?: readonly TeammateModelCapability[]): string;
export declare function buildPiArgs(agentConfig: AgentConfig, params: RunSingleTeammateParams, systemPromptFile: string, modelOverride?: string, sessionDir?: string, forkSessionFile?: string, schemaFile?: string, modelCapabilities?: readonly TeammateModelCapability[]): string[];
export declare const PRIVATE_DIRECTORY_MODE = 448;
export declare const PRIVATE_FILE_MODE = 384;
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
export declare function writeSystemPromptFile(agentConfig: AgentConfig, correlationId: string, outputSchema?: Record<string, unknown>): string;
export declare function writeSchemaFile(schema: Record<string, unknown>, correlationId: string): {
    schemaFile: string;
    outputFile: string;
};
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
/**
 * The model may submit any JSON Schema, and TypeBox compiles its `pattern`
 * keywords into RegExp objects that then run on this process's main thread on
 * every assistant event. Reject the hazardous shapes up front instead of
 * silently dropping keywords, so a valid schema still validates exactly as before.
 */
export declare function findStructuredOutputSchemaHazard(schema: Record<string, unknown>): string | undefined;
export interface ChildTerminationController {
    terminate(): void;
    cleanup(): void;
}
export interface ChildTerminationOptions {
    graceMs?: number;
    platform?: NodeJS.Platform;
    spawnProcess?: typeof spawn;
}
/** @internal Exported for lifecycle regression tests. */
export declare function createChildTerminationController(child: ChildProcess, options?: ChildTerminationOptions): ChildTerminationController;
/** @internal Exported for lifecycle regression tests. */
export declare function bindChildTerminationSignal(termination: ChildTerminationController, signal?: AbortSignal): () => void;
export declare function runSingleTeammate(params: RunSingleTeammateParams, options: RunTeammateOptions): Promise<SingleResult>;
export declare function normalizeGraphConcurrency(concurrency: number, taskCount: number): number;
export declare function runGraph(tasks: NormalizedTask[], concurrency: number, options: RunTeammateOptions): Promise<SingleResult[]>;
/** Programmatic tasks-only entry point matching the public teammate schema. */
export declare function runTeammate(params: RunTeammateParams, options: RunTeammateOptions): Promise<SingleResult[]>;
export type RpcMessageMode = "prompt" | "steer" | "follow_up" | "abort";
export declare function sendRpcMessage(stdin: Writable, message: string, mode?: RpcMessageMode, token?: LeaseToken): boolean;
export declare function sendChildIpcMessage(child: ChildProcess, message: Record<string, unknown>): boolean;
export declare function dispatchChildIpcMessage(message: Record<string, unknown>, onRequest: RunTeammateOptions["onChildRequest"], onEvent: RunTeammateOptions["onChildEvent"], reply: (message: unknown) => void): "request" | "event";
export {};
