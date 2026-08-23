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
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { Check, Errors } from "typebox/value";
import crossSpawn from "cross-spawn";
import { listAgentSummaries, resolveAgent, type AgentConfig } from "../agents/agents.ts";
import { resolveReplyTo, type ReplyTarget } from "../shared/routing.ts";
import type {
  SingleResult,
  Usage,
  AgentProgress,
  AgentTerminalStatus,
} from "../shared/types.ts";
import { wrapLeasedMessage, type LeaseToken } from "./session-handoff.ts";
import {
  applyModelRouting,
  type ResolvedModelRegistrationRouting,
  type TeammateTaskType,
} from "../models/model-routing.ts";
import type { DispatchAuthorityProjection } from "../models/model-registry.ts";
import type { ModelHealthCoordinator } from "../models/model-circuit-breaker.ts";
import type {
  BackendRegistry,
  ResolvedBackend,
} from "pi-maestro-backend-core/v1/registry";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import {
  sharedModelCircuitBreaker,
  type ModelCircuitBreaker,
} from "../models/model-circuit-breaker.ts";
import { getTeammateChildExtensions } from "./child-extensions.ts";
import {
  parseTeammateThinkingLevel,
  type TeammateThinkingInput,
  type TeammateThinkingLevel,
} from "../shared/thinking.ts";
import {
  isFallbackProviderError,
  type ModelHealthFailureScopeClassifier,
} from "./retry.ts";

// ---------------------------------------------------------------------------
// Public param / option interfaces
// ---------------------------------------------------------------------------

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
  initialLeaseToken?: LeaseToken | ((correlationId: string) => LeaseToken | undefined);
  onChildSpawned?: (
    stdin: import("node:stream").Writable,
    sendControl: (message: Record<string, unknown>) => boolean,
    sessionDir?: string,
    correlationId?: string,
    /** Runtime generation of the spawning run, mirroring onChildClosed. */
    generation?: number,
  ) => void;
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
  onModelFailover?: (
    error: string,
    previousModel?: string,
  ) => string | undefined | Promise<string | undefined>;
  /** Runtime generation used to fence callbacks from a replaced child process. */
  runtimeGeneration?: number;
  onChildClosed?: (
    correlationId: string,
    generation: number | undefined,
    details: { code: number | null; signal: NodeJS.Signals | null; settled: boolean },
  ) => void;
  /**
   * Runs once when the final consumable result is published, before the caller
   * or a DAG dependent can observe it. Observer failures are non-fatal.
   */
  onResultPublished?: (result: SingleResult, originCwd: string) => void | Promise<void>;
  onTurnComplete?: (result: SingleResult, terminalStatus?: AgentTerminalStatus) => void;
  /** Physical child-process reclamation, independent of logical turn settlement. */
  onReclamationOutcome?: (
    correlationId: string,
    outcome: ChildReclamationOutcome,
  ) => void;
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
  /** @internal Foreground wait window before the extension detaches a still-running task. */
  foregroundMaxRunMs?: number;
}

// ---------------------------------------------------------------------------
// Normalized task specification (unified across single/parallel/chain/graph)
// ---------------------------------------------------------------------------

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
export function singleRunParamsOf(
  source: NormalizedTask,
  overrides: {
    task: string;
    reply_to?: "caller" | "main";
    context?: "fresh" | "fork";
    timeoutMs?: number;
  },
): RunSingleTeammateParams {
  return {
    agent: source.agent,
    task: overrides.task,
    taskType: source.taskType,
    name: source.name,
    backend: source.backend,
    reply_to: overrides.reply_to,
    context: overrides.context ?? source.context,
    model: source.model,
    fallbackModels: source.fallbackModels,
    thinking: source.thinking,
    cwd: source.cwd,
    outputSchema: source.outputSchema,
    // Copied rather than aliased: the roster record keeps its own array of the
    // same ids, and a run must not be able to reorder what the roster shows.
    ...(source.todos === undefined ? {} : { todos: [...source.todos] }),
    ...(source.briefing === undefined ? {} : { briefing: [...source.briefing] }),
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
  };
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface JsonLineEvent {
  type: string;
  content?: string;
  usage?: Partial<Usage>;
  model?: string;
  error?: string;
  name?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export const STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS = {
  agentEnd: "The teammate completed without calling structured_output with a schema-valid value.",
  close: "The teammate exited without schema-valid structured_output.",
  resultReadyGrace: "The teammate published a result but did not settle with schema-valid structured_output in time.",
} as const;

export const STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTIC_SET = new Set<string>(
  Object.values(STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS),
);

/**
 * Child-facing corrective continuation issued once when a wakeable child ends
 * its run without schema-valid structured_output. Instructs a single bounded
 * resubmission and explicitly forbids repeating any other work.
 */
export const STRUCTURED_OUTPUT_RECOVERY_PROMPT =
  "You ended your run without submitting the required structured_output tool call. "
  + "Call the structured_output tool now with a single argument: the schema-valid JSON value of your final answer. "
  + "Plain-text JSON is never accepted. Do not repeat any other work.";

export function isStructuredOutputSettlementDiagnostic(content: string): boolean {
  return STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTIC_SET.has(content);
}

/**
 * Initial prompt for a resume-based model fallback (cold restart with a
 * session checkpoint, or an in-process `set_model` switch). The original task
 * text already lives inside the loaded session history, so this directive
 * replaces it: the new model continues from the recorded state instead of
 * re-reading (and possibly re-executing) the original request.
 */
export const MODEL_FALLBACK_RESUME_PROMPT =
  "The previous model attempt failed with a transient provider error. "
  + "The session history above records the work completed so far. "
  + "Continue from that recorded state and finish the original task. "
  + "Do not repeat tool calls whose results are already in the history.";

/**
 * Correlation ids are protocol identities, not filesystem-safe names.
 * Keep the original id for IPC while deriving a deterministic portable
 * component for --session-dir (notably ':' is invalid on Windows).
 */
export function correlationSessionDirectoryName(correlationId: string): string {
  const raw = correlationId.trim() || "teammate";
  let safe = raw
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/[. ]+$/g, "")
    .replace(/-+/g, "-");
  if (!safe || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe || "teammate"}`;
  const changed = safe !== raw || safe.length > 96;
  if (!changed) return safe;
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `${safe.slice(0, 87).replace(/[. ]+$/g, "")}-${hash}`;
}

export function extractTextContent(event: JsonLineEvent): string | undefined {
  if (typeof event.content === "string") return event.content;
  // AgentMessage format: { message: { content: [{type:"text", text:"..."}] } }
  const msg = event.message as Record<string, unknown> | undefined;
  if (msg?.content) {
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      return (msg.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n") || undefined;
    }
  }
  return undefined;
}

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
export function isPiResultReadyTurn(
  event: Record<string, unknown>,
  context?: ResultReadyTurnContext,
): boolean {
  if (event.type !== "turn_end") return false;
  const message = event.message as Record<string, unknown> | undefined;
  if (message?.role !== "assistant" || message.stopReason !== "stop") return false;
  if (typeof message.errorMessage === "string" && message.errorMessage.trim()) return false;
  if (!Array.isArray(message.content) || !Array.isArray(event.toolResults) || event.toolResults.length !== 0) {
    return false;
  }
  if (message.content.some((item) => (
    item !== null
    && typeof item === "object"
    && (item as Record<string, unknown>).type === "toolCall"
  ))) {
    return false;
  }
  // C1 guard: a text-only turn while tools are still in flight is interim
  // narration, not a final answer. Suppress result-ready so the agent can
  // continue its turn and converge naturally on agent_settled.
  if (context && context.inFlightToolCount && context.inFlightToolCount > 0) {
    return false;
  }
  return true;
}

export interface StructuredOutputCandidate {
  value: unknown;
  toolCallId?: string;
}

export function extractStructuredOutputCandidate(
  event: Record<string, unknown>,
  schema: Record<string, unknown>,
): StructuredOutputCandidate | undefined {
  const message = event.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if ((block.name ?? block.toolName) !== "structured_output") continue;
    const raw = block.arguments ?? block.input;
    let value = raw;
    if (typeof raw === "string") {
      try { value = JSON.parse(raw); } catch { return undefined; }
    }
    if (!validateStructuredOutputValue(value, schema)) return undefined;
    const toolCallId = typeof block.toolCallId === "string"
      ? block.toolCallId
      : typeof block.id === "string"
        ? block.id
        : undefined;
    return { value, ...(toolCallId ? { toolCallId } : {}) };
  }
  return undefined;
}

/**
 * Extracts a schema-valid structured_output payload from a Pi assistant event.
 * Execution code treats this as pending until the tool execution succeeds.
 */
export function extractValidatedStructuredOutput(
  event: Record<string, unknown>,
  schema: Record<string, unknown>,
): unknown | undefined {
  return extractStructuredOutputCandidate(event, schema)?.value;
}

export function describeStructuredOutputValueValidationFailure(
  value: unknown,
  schema: Record<string, unknown>,
): string | undefined {
  try {
    if (Check(schema, value)) return undefined;
    const issue = [...Errors(schema, value)][0] as {
      instancePath?: string;
      schemaPath?: string;
      message?: string;
    } | undefined;
    if (issue) {
      const instancePath = issue.instancePath || "/";
      const schemaPath = issue.schemaPath ? `, schema=${issue.schemaPath}` : "";
      return `structured_output validation failed at ${instancePath}${schemaPath}: ${issue.message ?? "value does not match the schema"}.`;
    }
  } catch (error) {
    return `structured_output validation failed: schema validation could not run (${error instanceof Error ? error.message : String(error)}).`;
  }
  return "structured_output validation failed: value does not match the supplied schema.";
}

export function describeStructuredOutputValidationFailure(
  event: Record<string, unknown>,
  schema: Record<string, unknown>,
): string | undefined {
  const message = event.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if ((block.name ?? block.toolName) !== "structured_output") continue;
    const raw = block.arguments ?? block.input;
    let value = raw;
    if (typeof raw === "string") {
      try {
        value = JSON.parse(raw);
      } catch (error) {
        return `structured_output validation failed: arguments are not valid JSON (${error instanceof Error ? error.message : String(error)}).`;
      }
    }
    return describeStructuredOutputValueValidationFailure(value, schema);
  }
  return undefined;
}

export function extractPiEventError(event: Record<string, unknown>): string | undefined {
  const message = event.message as Record<string, unknown> | undefined;
  const candidates = [
    message?.errorMessage,
    message?.error,
    event.errorMessage,
    event.error,
  ];
  return candidates.find((candidate): candidate is string => (
    typeof candidate === "string" && candidate.trim().length > 0
  ))?.trim();
}

export function validateStructuredOutputValue(
  value: unknown,
  schema: Record<string, unknown>,
): boolean {
  return describeStructuredOutputValueValidationFailure(value, schema) === undefined;
}

export interface Utf8LineDecoder {
  write(chunk: Buffer): string[];
  end(): string[];
}

export const EXECUTION_BUFFER_LIMITS = Object.freeze({
  lineBytes: 256 * 1024,
  streamBytes: 256 * 1024,
  stderrBytes: 64 * 1024,
  toolItems: 10,
  toolNameBytes: 1024,
  transcriptMessages: 128,
  transcriptMessageBytes: 64 * 1024,
  transcriptBytes: 1024 * 1024,
});

export function truncateUtf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  // Streaming appenders call this once per token, so the common "still well
  // under the cap" case must not re-encode the whole accumulated string.
  // A UTF-16 code unit never expands past 3 UTF-8 bytes (a surrogate pair is
  // 2 units -> 4 bytes), so this bound is safe and O(1).
  if (value.length * 3 <= maxBytes) return value;
  // Still cheaper than Buffer.from: measures without allocating a copy.
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return value;
  let start = encoded.length - maxBytes;
  while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString("utf8");
}

export function appendUtf8Tail(current: string, addition: string, maxBytes: number): string {
  return truncateUtf8Tail(current + addition, maxBytes);
}

export type TranscriptEntry = { role: string; content: string };

// Byte accounting is memoized per entry and per transcript so appending a tool
// result does not rescan up to 1MB of retained history on every call. Both maps
// are keyed by object identity, so nothing leaks into the returned messages.
export const transcriptEntryBytes = new WeakMap<TranscriptEntry, number>();
export const transcriptTotals = new WeakMap<object, { length: number; bytes: number }>();

export function entryBytes(entry: TranscriptEntry): number {
  let bytes = transcriptEntryBytes.get(entry);
  if (bytes === undefined) {
    bytes = Buffer.byteLength(entry.content, "utf8");
    transcriptEntryBytes.set(entry, bytes);
  }
  return bytes;
}

export function transcriptTotalBytes(messages: TranscriptEntry[]): number {
  const cached = transcriptTotals.get(messages);
  // A stale length means the array was reset or mutated elsewhere; recompute
  // from the memoized per-entry sizes rather than trusting the running total.
  if (cached && cached.length === messages.length) return cached.bytes;
  let bytes = 0;
  for (const entry of messages) bytes += entryBytes(entry);
  return bytes;
}

export function appendBoundedTranscriptMessage(
  messages: Array<{ role: string; content: string }>,
  message: { role: string; content: string },
): void {
  const entry: TranscriptEntry = {
    ...message,
    content: truncateUtf8Tail(message.content, EXECUTION_BUFFER_LIMITS.transcriptMessageBytes),
  };
  let totalBytes = transcriptTotalBytes(messages) + entryBytes(entry);
  messages.push(entry);
  while (
    messages.length > EXECUTION_BUFFER_LIMITS.transcriptMessages
    || totalBytes > EXECUTION_BUFFER_LIMITS.transcriptBytes
  ) {
    const removed = messages.shift();
    if (!removed) break;
    totalBytes -= entryBytes(removed);
  }
  transcriptTotals.set(messages, { length: messages.length, bytes: totalBytes });
}

export function createUtf8LineDecoder(
  maxBufferedBytes = EXECUTION_BUFFER_LIMITS.lineBytes,
): Utf8LineDecoder {
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  return {
    write(chunk: Buffer): string[] {
      buffered = appendUtf8Tail(buffered, decoder.write(chunk), maxBufferedBytes);
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      return lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
    },
    end(): string[] {
      buffered += decoder.end();
      const tail = buffered;
      buffered = "";
      return tail ? [tail.endsWith("\r") ? tail.slice(0, -1) : tail] : [];
    },
  };
}

export function appendDistinctAssistantMessage(
  messages: Array<{ role: string; content: string }>,
  content: string,
): boolean {
  const previous = messages[messages.length - 1];
  if (previous?.role === "assistant" && previous.content === content) return false;
  appendBoundedTranscriptMessage(messages, { role: "assistant", content });
  return true;
}

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    turns: 0,
  };
}

export function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function setUsageSnapshot(total: Usage, partial: Record<string, unknown>): void {
  total.inputTokens = usageNumber(partial.inputTokens ?? partial.input);
  total.outputTokens = usageNumber(partial.outputTokens ?? partial.output);
  total.cacheReadTokens = usageNumber(partial.cacheReadTokens ?? partial.cacheRead);
  total.cacheWriteTokens = usageNumber(partial.cacheWriteTokens ?? partial.cacheWrite);
  const cost = partial.cost;
  total.cost = usageNumber(
    typeof cost === "object" && cost !== null
      ? (cost as Record<string, unknown>).total
      : cost,
  );
}

export function addUsageSnapshot(total: Usage, partial: Record<string, unknown>): void {
  const snapshot = emptyUsage();
  setUsageSnapshot(snapshot, partial);
  total.inputTokens += snapshot.inputTokens;
  total.outputTokens += snapshot.outputTokens;
  total.cacheReadTokens += snapshot.cacheReadTokens;
  total.cacheWriteTokens += snapshot.cacheWriteTokens;
  total.cost += snapshot.cost;
}

export function resetUsage(usage: Usage): void {
  Object.assign(usage, emptyUsage());
}

export function releasePublishedTurnHistory(
  messages: Array<{ role: string; content: string }>,
  progress: AgentProgress,
  usage: Usage,
): void {
  messages.length = 0;
  progress.recentTools = [];
  resetUsage(usage);
}

// ---------------------------------------------------------------------------
// Variable reference resolution
// ---------------------------------------------------------------------------

export const VAR_PATTERN_SOURCE = "\\{([a-zA-Z_][a-zA-Z0-9_-]*)((?:\\.[a-zA-Z_][a-zA-Z0-9_-]*|\\[\\d+\\])*)\\}";

export interface TaskOutput {
  text: string;
  structured?: unknown;
}

export function extractDependencies(
  template: string | undefined,
  taskNames: Set<string>,
): string[] {
  if (!template) return [];
  const deps: string[] = [];
  const pattern = new RegExp(VAR_PATTERN_SOURCE, "g");
  let m;
  while ((m = pattern.exec(template)) !== null) {
    const name = m[1];
    if (taskNames.has(name) && !deps.includes(name)) {
      deps.push(name);
    }
  }
  return deps;
}

/**
 * Collect `{name}` references in a template that do NOT match any task name.
 * These are passed through as literal text at resolution time — surfacing
 * them lets callers distinguish intentional literals from misspelled refs.
 */
export function collectUnknownRefs(
  template: string | undefined,
  taskNames: Set<string>,
): string[] {
  if (!template) return [];
  const unknown: string[] = [];
  const pattern = new RegExp(VAR_PATTERN_SOURCE, "g");
  let m;
  while ((m = pattern.exec(template)) !== null) {
    const name = m[1];
    if (!taskNames.has(name) && !unknown.includes(name)) {
      unknown.push(name);
    }
  }
  return unknown;
}

export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: number[] = new Array(cols).fill(0).map((_, j) => j);
  for (let i = 1; i < rows; i++) {
    let prevDiag = dist[0];
    dist[0] = i;
    for (let j = 1; j < cols; j++) {
      const tmp = dist[j];
      dist[j] = Math.min(
        dist[j] + 1,
        dist[j - 1] + 1,
        prevDiag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prevDiag = tmp;
    }
  }
  return dist[cols - 1];
}

/**
 * Union of a task's implicit `{name}` references and explicit dependsOn names.
 * Single source of truth for graph edges — used by inferGraphMode, runGraph,
 * and progress snapshots so all three agree on the dependency set.
 */
export function taskDependencyNames(
  task: Pick<NormalizedTask, "prompt" | "dependsOn">,
  taskNames: Set<string>,
): string[] {
  const deps = extractDependencies(task.prompt, taskNames);
  for (const name of task.dependsOn ?? []) {
    if (taskNames.has(name) && !deps.includes(name)) deps.push(name);
  }
  return deps;
}

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
export function validateTaskReferences(
  tasks: NormalizedTask[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const taskNames = new Set(tasks.filter((t) => t.name).map((t) => t.name!));

  tasks.forEach((t, i) => {
    const label = t.name ? `tasks[${i}] "${t.name}"` : `tasks[${i}]`;
    for (const name of t.dependsOn ?? []) {
      if (t.name && name === t.name) {
        errors.push(`${label}: dependsOn references itself — a task cannot depend on itself`);
      } else if (!taskNames.has(name)) {
        errors.push(`${label}: dependsOn references unknown task name "${name}"`);
      }
    }
    if (taskNames.size === 0) return;
    // Implicit self-reference: {ownName} in the prompt creates a self-loop
    // that runGraph's hasCycle would reject for multi-task dispatches, but
    // single-task dispatch bypasses runGraph entirely — catch it here.
    if (t.name && extractDependencies(t.prompt, taskNames).includes(t.name)) {
      errors.push(
        `${label}: prompt references its own task name "{${t.name}}" — a task cannot depend on itself`,
      );
    }
    for (const name of collectUnknownRefs(t.prompt, taskNames)) {
      const threshold = name.length <= 3 ? 1 : 2;
      const close = [...taskNames].find(
        (candidate) => candidate !== t.name && editDistance(name, candidate) <= threshold,
      );
      if (close) {
        errors.push(
          `${label}: "{${name}}" looks like a misspelled reference to task "${close}" — fix the reference or rename the task`,
        );
      } else {
        warnings.push(
          `${label}: "{${name}}" does not match any task name and will be passed through as literal text`,
        );
      }
    }
  });

  return { errors, warnings };
}

export function resolvePath(obj: unknown, pathStr: string): unknown {
  const parts = pathStr.split(/\.|\[|\]/).filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function resolveVariables(
  template: string,
  outputs: Map<string, TaskOutput>,
  taskNames: Set<string>,
): string {
  return template.replace(
    new RegExp(VAR_PATTERN_SOURCE, "g"),
    (match, name: string, pathSuffix: string) => {
      if (!taskNames.has(name)) return match;
      const output = outputs.get(name);
      if (!output) {
        throw new Error(
          `Task "${name}" completed without publishing a consumable output`,
        );
      }

      if (!pathSuffix) {
        if (output.structured !== undefined) {
          return typeof output.structured === "string"
            ? output.structured
            : JSON.stringify(output.structured);
        }
        return output.text;
      }

      if (output.structured === undefined) {
        throw new Error(
          `Task "${name}" has no structured output for field access "${pathSuffix}"`,
        );
      }
      const value = resolvePath(output.structured, pathSuffix.slice(1));
      if (value === undefined) {
        throw new Error(
          `Field "${pathSuffix}" not found in task "${name}" structured output`,
        );
      }
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  );
}

// ---------------------------------------------------------------------------
// Dependency graph utilities
// ---------------------------------------------------------------------------

export function hasCycle(adjList: number[][]): boolean {
  const n = adjList.length;
  const state = new Array<number>(n).fill(0);

  function dfs(node: number): boolean {
    if (state[node] === 1) return true;
    if (state[node] === 2) return false;
    state[node] = 1;
    for (const dep of adjList[node]) {
      if (dfs(dep)) return true;
    }
    state[node] = 2;
    return false;
  }

  for (let i = 0; i < n; i++) {
    if (dfs(i)) return true;
  }
  return false;
}

export function inferGraphMode(
  tasks: NormalizedTask[],
): "parallel" | "chain" | "graph" {
  const taskNames = new Set(tasks.filter((t) => t.name).map((t) => t.name!));
  if (taskNames.size === 0) return "parallel";

  let hasDeps = false;
  let allLinear = true;

  for (let i = 0; i < tasks.length; i++) {
    const deps = taskDependencyNames(tasks[i], taskNames);
    if (deps.length > 0) hasDeps = true;
    if (deps.length > 1) allLinear = false;
    if (deps.length === 1 && i > 0 && deps[0] !== tasks[i - 1].name) {
      allLinear = false;
    }
  }

  if (!hasDeps) return "parallel";
  if (allLinear) return "chain";
  return "graph";
}

// ---------------------------------------------------------------------------
// Unified param normalization (shared by tool execute and child proxy paths)

/**
 * Normalize a `todo` binding (single id or ordered array) into a de-duplicated
 * ordered id list. The array order is the priority order (first = highest).
 */
export function normalizeTodoBindings(todo: string | string[] | undefined): string[] | undefined {
  if (todo === undefined) return undefined;
  const ids = Array.isArray(todo) ? todo : [todo];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids) {
    const id = String(raw).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result.length > 0 ? result : undefined;
}

/** Dedupe and trim briefing entries; empty results collapse to undefined. */
export function normalizeBriefingEntries(briefing: string[] | undefined): string[] | undefined {
  if (briefing === undefined) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of briefing) {
    const entry = String(raw).trim();
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result.length > 0 ? result : undefined;
}

// ---------------------------------------------------------------------------

/** Public task prompt budget, measured after UTF-8 encoding. */
export const MAX_TASK_PROMPT_BYTES = 1024 * 1024;

// Allow ordinary multiline text (tab, LF, CR); reject terminal/control input.
const DISALLOWED_TASK_PROMPT_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/** Return an actionable boundary error for a task prompt, if any. */
export function taskPromptBoundaryError(prompt: unknown): string | undefined {
  if (typeof prompt !== "string") return "requires a string prompt";
  if (prompt.trim().length === 0) return "requires non-empty text";
  const control = prompt.match(DISALLOWED_TASK_PROMPT_CONTROL)?.[0];
  if (control !== undefined) {
    const codePoint = control.codePointAt(0) ?? 0;
    return `contains unsupported control character U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > MAX_TASK_PROMPT_BYTES) {
    return `is ${bytes} UTF-8 bytes; maximum is ${MAX_TASK_PROMPT_BYTES}`;
  }
  return undefined;
}

export interface NormalizeTeammateResult {
  tasks: NormalizedTask[];
  isMultiTask: boolean;
  warnings: string[];
  error?: string;
}

export const EXPERT_MODE_LEADER_AGENT = "workflow";
export const EXPERT_MODE_LEADER_TASK_TYPE: TeammateTaskType = "planning";
export const EXPERT_MODE_LEADER_NAME = "expert-leader";
export const EXPERT_MODE_PROMPT_START = "<expert-leader-contract>";
export const EXPERT_MODE_PROMPT_END = "</expert-leader-contract>";
const EXPERT_MODE_PREPARED = Symbol("pi-maestro-teammate.expert-mode-prepared");
const EXPERT_MODE_OVERRIDE_ERROR = Symbol("pi-maestro-teammate.expert-mode-override-error");
type ExpertPreparedParams = RunTeammateParams & {
  [EXPERT_MODE_PREPARED]?: true;
  [EXPERT_MODE_OVERRIDE_ERROR]?: string;
};

export function buildExpertLeaderPrompt(objective: string): string {
  return `${EXPERT_MODE_PROMPT_START}
You are the Expert Leader. Own decomposition, delegation, evidence review, and synthesis; do not perform substantive investigation or implementation yourself.

Objective:
${objective}

Execution contract:
1. Build the smallest useful DAG. Dispatch only roles required by the objective; put independent work in one call and encode ordering with dependsOn. Use named-output interpolation only when downstream work consumes that output.
2. Use exact agent roles from the available catalog and always set taskType. Do not set model fields; model routing owns provider selection. Never use mode=expert for child dispatches.
3. Leaf agents must use maxNestingDepth: 0. Assign implementation to general-executor when available (fallback: general); keep exploration, analysis, review, and testing read-only unless their assignment explicitly owns writes.
4. Give each overlapping file set exactly one writer. Run independent writers only on disjoint files, and pass concrete scope, acceptance criteria, and focused verification to every implementation task.
5. Prefer foreground dispatch for every result needed by synthesis. Use background only for independent work that does not affect the current result. If a background result must be consumed, call observe exactly once with a bounded wait; never poll observe, teammate-list, or teammate-send for completion.
6. Treat result publication as the dependency release boundary. Do not wait for agent_end after a consumable result is available. When a child returns an agent:// publication reference, read it with resource before synthesis. Do not synthesize while required tasks are unresolved.
7. Require the smallest behavior-relevant verification from each child and reuse valid evidence. Do not schedule broad suites, duplicate review waves, or rerun passing checks without a material invalidator.
8. On child failure, classify it and perform at most one bounded retry or reroute. Never hide, silently skip, or endlessly retry a failed lane.
9. If the objective is Goal-gated, do not claim Goal completion from child self-reports. Return focused workspace evidence and blockers to the root so the canonical Goal verifier can decide fail-closed.
10. Before answering, reconcile child outputs against the objective, resolve contradictions with evidence, and report remaining uncertainty. Return one concise synthesis with outcome, evidence, changed files when any, verification, and blockers.
${EXPERT_MODE_PROMPT_END}`;
}

function expertModeOverrideError(params: RunTeammateParams): string | undefined {
  if (params.mode !== "expert" || !Array.isArray(params.tasks)) return undefined;
  const conflicts: string[] = [];
  if (params.agent !== undefined && params.agent !== EXPERT_MODE_LEADER_AGENT) {
    conflicts.push(`top-level agent must be \"${EXPERT_MODE_LEADER_AGENT}\"`);
  }
  if (params.taskType !== undefined && params.taskType !== EXPERT_MODE_LEADER_TASK_TYPE) {
    conflicts.push(`top-level taskType must be \"${EXPERT_MODE_LEADER_TASK_TYPE}\"`);
  }
  if (params.maxNestingDepth !== undefined && params.maxNestingDepth !== 1) {
    conflicts.push("top-level maxNestingDepth must be 1");
  }
  for (const [index, task] of params.tasks.entries()) {
    if (task.agent !== undefined && task.agent !== EXPERT_MODE_LEADER_AGENT) {
      conflicts.push(`tasks[${index}].agent must be \"${EXPERT_MODE_LEADER_AGENT}\"`);
    }
    if (task.taskType !== undefined && task.taskType !== EXPERT_MODE_LEADER_TASK_TYPE) {
      conflicts.push(`tasks[${index}].taskType must be \"${EXPERT_MODE_LEADER_TASK_TYPE}\"`);
    }
    if (task.maxNestingDepth !== undefined && task.maxNestingDepth !== 1) {
      conflicts.push(`tasks[${index}].maxNestingDepth must be 1`);
    }
  }
  return conflicts.length > 0
    ? `Expert mode owns Leader routing; ${conflicts.join("; ")}. Remove conflicting overrides.`
    : undefined;
}

/**
 * Expand the lightweight expert strategy before model routing. The workflow
 * agent is the Leader; its existing teammate access and nesting budget provide
 * the expert DAG without a second execution engine or persistent mode state.
 */
export function prepareTeammateMode(params: RunTeammateParams): RunTeammateParams {
  const prepared = params as ExpertPreparedParams;
  if (params.mode !== "expert" || !Array.isArray(params.tasks) || prepared[EXPERT_MODE_PREPARED]) {
    return params;
  }
  const overrideError = expertModeOverrideError(params);
  if (overrideError) {
    return { ...params, [EXPERT_MODE_OVERRIDE_ERROR]: overrideError } as ExpertPreparedParams;
  }
  return {
    ...params,
    [EXPERT_MODE_PREPARED]: true,
    maxNestingDepth: 1,
    tasks: params.tasks.map((task) => ({
      ...task,
      prompt: buildExpertLeaderPrompt(task.prompt),
      name: task.name ?? EXPERT_MODE_LEADER_NAME,
      description: task.description ?? "Expert Leader",
      agent: EXPERT_MODE_LEADER_AGENT,
      taskType: EXPERT_MODE_LEADER_TASK_TYPE,
      maxNestingDepth: 1,
    })),
  } as ExpertPreparedParams;
}

/** Normalize the tasks-only public contract into executable graph tasks. */
export function normalizeTeammateParams(
  params: RunTeammateParams,
): NormalizeTeammateResult {
  const warnings: string[] = [];
  const prepared = params as ExpertPreparedParams;
  const expertOverrideError = prepared[EXPERT_MODE_OVERRIDE_ERROR] ?? expertModeOverrideError(params);
  if (expertOverrideError) {
    return { tasks: [], isMultiTask: false, warnings, error: expertOverrideError };
  }
  params = prepareTeammateMode(params);
  params.background = params.background === true;

  if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
    return {
      tasks: [],
      isMultiTask: false,
      warnings,
      error: 'Requires a non-empty "tasks" array.',
    };
  }

  if (params.mode === "expert" && params.tasks.length !== 1) {
    return {
      tasks: [],
      isMultiTask: false,
      warnings,
      error: 'Expert mode requires exactly one objective task for the workflow Leader.',
    };
  }

  if (
    params.concurrencyWaitMs !== undefined
    && (!Number.isInteger(params.concurrencyWaitMs) || params.concurrencyWaitMs < 1)
  ) {
    return {
      tasks: [],
      isMultiTask: false,
      warnings,
      error: `concurrencyWaitMs must be a positive integer (got ${params.concurrencyWaitMs}).`,
    };
  }

  if (
    params.maxNestingDepth !== undefined
    && (!Number.isInteger(params.maxNestingDepth)
      || params.maxNestingDepth < 0
      || params.maxNestingDepth > MAX_DEFAULT_DEPTH)
  ) {
    return {
      tasks: [],
      isMultiTask: false,
      warnings,
      error: `maxNestingDepth must be an integer between 0 and ${MAX_DEFAULT_DEPTH} `
        + `(got ${params.maxNestingDepth}); 0 forbids nested teammate calls.`,
    };
  }

  for (const [index, task] of params.tasks.entries()) {
    if (params.mode === "expert" && (task.maxNestingDepth ?? params.maxNestingDepth ?? 0) < 1) {
      return {
        tasks: [],
        isMultiTask: false,
        warnings,
        error: "Expert mode requires maxNestingDepth >= 1 so the workflow Leader can dispatch experts.",
      };
    }
    if (task.background !== undefined) {
      warnings.push(
        `tasks[${index}]${task.name ? ` "${task.name}"` : ""} "background" is a dispatch-level setting; per-task background is not supported and is ignored. Pass background at the top level instead.`,
      );
    }
    if (
      task.maxNestingDepth !== undefined
      && (!Number.isInteger(task.maxNestingDepth)
        || task.maxNestingDepth < 0
        || task.maxNestingDepth > MAX_DEFAULT_DEPTH)
    ) {
      return {
        tasks: [],
        isMultiTask: false,
        warnings,
        error: `tasks[${index}]${task.name ? ` "${task.name}"` : ""} maxNestingDepth must be an integer between 0 and ${MAX_DEFAULT_DEPTH} `
          + `(got ${task.maxNestingDepth}); 0 forbids nested teammate calls.`,
      };
    }
  }

  const normalized: NormalizedTask[] = params.tasks.map((task) => ({
    agent: task.agent ?? params.agent ?? "general",
    prompt: task.prompt,
    description: task.description,
    taskType: task.taskType ?? params.taskType,
    name: task.name,
    backend: task.backend ?? params.backend,
    dependsOn: task.dependsOn,
    context: task.context ?? params.context,
    model: task.model ?? params.model,
    fallbackModels: task.fallbackModels ?? params.fallbackModels,
    thinking: parseTeammateThinkingLevel(task.thinking ?? params.thinking),
    cwd: task.cwd ?? params.cwd,
    outputSchema: task.outputSchema ?? params.outputSchema,
    timeoutMs: task.timeoutMs ?? params.timeoutMs,
    maxNestingDepth: task.maxNestingDepth ?? params.maxNestingDepth,
    todos: normalizeTodoBindings(task.todo),
    briefing: normalizeBriefingEntries(task.briefing),
  }));
  const isMultiTask = normalized.length > 1;

  for (const [index, task] of normalized.entries()) {
    const hasNoPrompt = typeof task.prompt !== "string" || task.prompt.trim().length === 0;
    const strayPrompt =
      task.outputSchema !== undefined
      && typeof task.outputSchema === "object"
      && task.outputSchema !== null
      && typeof task.outputSchema.prompt === "string";
    if (hasNoPrompt && strayPrompt) {
      return {
        tasks: normalized,
        isMultiTask,
        warnings,
        error: `tasks[${index}]${task.name ? ` "${task.name}"` : ""} has no "prompt" — the prompt text was placed inside "outputSchema". Move "prompt" to the task level (a sibling of outputSchema); outputSchema holds only the JSON Schema.`,
      };
    }
    if (hasNoPrompt) {
      return {
        tasks: normalized,
        isMultiTask,
        warnings,
        error: `tasks[${index}]${task.name ? ` "${task.name}"` : ""} requires a non-empty "prompt".`,
      };
    }
    const promptBoundaryError = taskPromptBoundaryError(task.prompt);
    if (promptBoundaryError) {
      return {
        tasks: normalized,
        isMultiTask,
        warnings,
        error: `tasks[${index}]${task.name ? ` "${task.name}"` : ""} prompt ${promptBoundaryError}.`,
      };
    }
    if (strayPrompt) {
      // Task-level prompt already exists: the stray string is not a JSON Schema
      // keyword and would otherwise leak into the child's schema file. Salvage
      // it instead of rejecting — the dispatch intent is unambiguous.
      const cleaned = { ...task.outputSchema! };
      delete cleaned.prompt;
      normalized[index] = { ...task, outputSchema: cleaned };
      warnings.push(
        `tasks[${index}]${task.name ? ` "${task.name}"` : ""}: removed a task-text "prompt" key from "outputSchema" (not a JSON Schema keyword). Keep the task text at the task-level "prompt".`,
      );
    }

    const outputSchema = normalized[index].outputSchema;
    if (outputSchema) {
      const schemaHazard = findStructuredOutputSchemaHazard(outputSchema);
      if (schemaHazard) {
        return {
          tasks: normalized,
          isMultiTask,
          warnings,
          error: `tasks[${index}]${task.name ? ` "${task.name}"` : ""} has an invalid outputSchema: ${schemaHazard}`,
        };
      }
    }
  }

  const maxAgents = resolveMaxAgents(params.maxAgents);
  if (normalized.length > maxAgents) {
    return {
      tasks: normalized,
      isMultiTask,
      warnings,
      error: `Too many tasks: ${normalized.length} exceeds the maximum of ${maxAgents}. Split into smaller batches or raise the limit via maxAgents / PI_TEAMMATE_MAX_AGENTS.`,
    };
  }

  const refCheck = validateTaskReferences(normalized);
  warnings.push(...refCheck.warnings);
  if (refCheck.errors.length > 0) {
    return {
      tasks: normalized,
      isMultiTask,
      warnings,
      error: refCheck.errors.join("\n"),
    };
  }

  return { tasks: normalized, isMultiTask, warnings };
}

// ---------------------------------------------------------------------------
// AC3: Windows-safe pi binary resolution
// ---------------------------------------------------------------------------

export let resolvedPiEntryPoint: string | null | undefined;

export function resolvePiEntryPoint(): string | null {
  if (resolvedPiEntryPoint !== undefined) return resolvedPiEntryPoint;

  // Try current process argv (if pi is the host)
  const argv1 = process.argv[1];
  if (argv1 && (argv1.endsWith(".mjs") || argv1.endsWith(".js"))) {
    resolvedPiEntryPoint = argv1;
    return resolvedPiEntryPoint;
  }

  if (process.platform === "win32") {
    // Parse pi.cmd to find the real .js entry point
    const npmDir = process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm")
      : null;
    if (npmDir) {
      const cmdFile = path.join(npmDir, "pi.cmd");
      try {
        const content = fs.readFileSync(cmdFile, "utf-8");
        // pi.cmd contains: "%_prog%" "%dp0%\node_modules\...\cli.js" %*
        const match = content.match(/"?%dp0%\\([^"*%\r\n]+\.(?:js|mjs))"?/);
        if (match) {
          const entryPoint = path.join(npmDir, match[1]);
          if (fs.existsSync(entryPoint)) {
            resolvedPiEntryPoint = entryPoint;
            return resolvedPiEntryPoint;
          }
        }
      } catch { /* fallback */ }
    }
  }

  resolvedPiEntryPoint = null;
  return null;
}

export interface PiSpawnCommandOptions {
  envBinary?: string | null;
  entryPoint?: string | null;
  platform?: NodeJS.Platform;
}

export function getPiSpawnCommand(
  args: string[],
  options: PiSpawnCommandOptions = {},
): { command: string; args: string[]; shell: false } {
  const envBinary = options.envBinary === undefined
    ? process.env.PI_TEAMMATE_PI_BINARY
    : options.envBinary;
  if (envBinary) {
    return { command: envBinary, args, shell: false };
  }

  const entryPoint = options.entryPoint === undefined
    ? resolvePiEntryPoint()
    : options.entryPoint;
  if (entryPoint) {
    return { command: process.execPath, args: [entryPoint, ...args], shell: false };
  }

  // cross-spawn resolves Windows .cmd shims without opting into shell mode
  // and escapes each argv item before invoking cmd.exe internally.
  void options.platform;
  return { command: "pi", args, shell: false };
}

export interface InteractiveTerminalLaunchOptions {
  platform?: NodeJS.Platform;
  terminalCommand?: string;
  title?: string;
}

export interface InteractiveTerminalLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
}

function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quoteAppleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Build a shell-free terminal launcher where the platform supports argv forwarding. */
export function getInteractiveTerminalLaunchSpec(
  piCommand: { command: string; args: readonly string[] },
  cwd: string,
  options: InteractiveTerminalLaunchOptions = {},
): InteractiveTerminalLaunchSpec {
  const platform = options.platform ?? process.platform;
  const title = options.title ?? "Pi worker";

  if (platform === "win32") {
    return {
      command: options.terminalCommand ?? "wt.exe",
      args: [
        "--window",
        "new",
        "new-tab",
        "--title",
        title,
        "--startingDirectory",
        cwd,
        piCommand.command,
        ...piCommand.args,
      ],
      cwd,
    };
  }

  if (platform === "darwin") {
    const shellCommand = `cd ${quotePosixShellArg(cwd)} && exec ${[
      piCommand.command,
      ...piCommand.args,
    ].map(quotePosixShellArg).join(" ")}`;
    return {
      command: options.terminalCommand ?? "/usr/bin/osascript",
      args: [
        "-e",
        `tell application "Terminal" to activate`,
        "-e",
        `tell application "Terminal" to do script ${quoteAppleScriptString(shellCommand)}`,
      ],
      cwd,
    };
  }

  return {
    command: options.terminalCommand ?? process.env.PI_TEAMMATE_TERMINAL ?? "x-terminal-emulator",
    args: ["-e", piCommand.command, ...piCommand.args],
    cwd,
  };
}

export interface ProcessTreeByPidOptions {
  platform?: NodeJS.Platform;
  spawnProcess?: typeof crossSpawn;
  killProcess?: typeof process.kill;
  isProcessAlive?: (pid: number) => boolean;
  graceMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Terminate an explicitly owned process tree; callers must revalidate PID ownership first. */
export async function terminateProcessTreeByPid(
  pid: number,
  options: ProcessTreeByPidOptions = {},
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid owned process pid: ${pid}`);
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const spawnProcess = options.spawnProcess ?? crossSpawn;
    await new Promise<void>((resolve, reject) => {
      const killer = spawnProcess(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore", shell: false },
      );
      killer.once("error", reject);
      killer.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`taskkill exited with code ${code ?? "unknown"}`));
      });
    });
    return;
  }

  const killProcess = options.killProcess ?? process.kill;
  const isAlive = options.isProcessAlive ?? processIsAlive;
  const graceMs = options.graceMs ?? 2_000;
  const pollMs = options.pollMs ?? 50;
  const sleepFor = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let signalTarget: "group" | "pid" | undefined;
  const signalTree = (signal: NodeJS.Signals): void => {
    if (signalTarget === "group") {
      try {
        killProcess(-pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      return;
    }
    if (signalTarget === "pid") {
      try {
        killProcess(pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      return;
    }
    try {
      killProcess(-pid, signal);
      signalTarget = "group";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") throw error;
      try {
        killProcess(pid, signal);
        signalTarget = "pid";
      } catch (directError) {
        if ((directError as NodeJS.ErrnoException).code !== "ESRCH") throw directError;
      }
    }
  };
  const waitForExit = async (): Promise<boolean> => {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return true;
      await sleepFor(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
    return !isAlive(pid);
  };

  signalTree("SIGTERM");
  if (await waitForExit()) return;
  signalTree("SIGKILL");
  if (await waitForExit()) return;
  throw new Error(`Owned process tree ${pid} did not exit after SIGKILL.`);
}

// ---------------------------------------------------------------------------
// AC4: Nesting depth guard
// ---------------------------------------------------------------------------

/** Maximum number of teammate-agent levels below the main agent. */
export const MAX_DEFAULT_DEPTH = 2;

export const DEFAULT_MAX_AGENTS = 15;

/**
 * Ceiling on concurrently live agents across the whole dispatch tree. The
 * per-call `maxAgents` limit only bounds a single dispatch, so without this a
 * depth-2 tree of 15-task graphs could reach 15^2 child processes.
 */
export const DEFAULT_MAX_ACTIVE_AGENTS = 32;

export function resolveMaxAgents(explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit)) return Math.max(1, Math.floor(explicit));
  const env = parseInt(process.env.PI_TEAMMATE_MAX_AGENTS ?? "", 10);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_MAX_AGENTS;
}

export function resolveMaxActiveAgents(): number {
  const env = parseInt(process.env.PI_TEAMMATE_MAX_ACTIVE_AGENTS ?? "", 10);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_MAX_ACTIVE_AGENTS;
}

/**
 * Fallback depth for dispatches that do not carry an explicit one — i.e. direct
 * `runTeammate` callers outside the extension (delegate/explore/moa). Nested
 * teammate calls never reach this: their child process only proxies the request
 * back to the root process, so the root's own environment would always read 0.
 * Those paths pass `RunTeammateOptions.depth` instead.
 */
export function getTeammateDepth(): number {
  const parsed = parseInt(process.env.PI_TEAMMATE_DEPTH ?? "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Child-scoped nesting budget (absolute max dispatch depth). Only meaningful
 * inside a spawned child process; callers MUST gate the read on `isChild`.
 */
export function getTeammateMaxDispatchDepth(): number {
  const parsed = parseInt(process.env.PI_TEAMMATE_MAX_DISPATCH_DEPTH ?? "", 10);
  return Number.isFinite(parsed) ? parsed : MAX_DEFAULT_DEPTH - 1;
}

export function checkDepthGuard(depth: number): { allowed: boolean; current: number; max: number } {
  return { allowed: depth < MAX_DEFAULT_DEPTH, current: depth, max: MAX_DEFAULT_DEPTH };
}

/**
 * Absolute max dispatch depth for agents spawned by a root (depth-0) dispatch.
 * `maxNestingDepth: 0` forbids nested calls entirely; the global ceiling caps
 * any larger value, so under the current MAX only 0 vs 1+ are distinguishable.
 */
export function rootChildMaxDispatchDepth(maxNestingDepth?: number): number {
  return Math.max(0, Math.min(MAX_DEFAULT_DEPTH - 1, maxNestingDepth ?? MAX_DEFAULT_DEPTH));
}

/**
 * Absolute max dispatch depth for agents spawned by a proxied dispatch from a
 * parent with `parentBudget`, at `childDepth`. The parent's budget is the hard
 * cap; the call's own `maxNestingDepth` may only tighten it further.
 */
export function nestedChildMaxDispatchDepth(
  parentBudget: number,
  childDepth: number,
  maxNestingDepth?: number,
): number {
  const own = childDepth + (maxNestingDepth ?? MAX_DEFAULT_DEPTH);
  return Math.max(0, Math.min(MAX_DEFAULT_DEPTH - 1, parentBudget - 1, own));
}

/** Whether a dispatch creating agents at `dispatchDepth` is allowed under `parentBudget`. */
export function dispatchAllowed(parentBudget: number, dispatchDepth: number): boolean {
  return dispatchDepth <= Math.min(MAX_DEFAULT_DEPTH - 1, parentBudget);
}

/** Budget of an agent record that predates per-dispatch budgets: global ceiling. */
export function agentDispatchBudget(agent: { maxDispatchDepth?: number }): number {
  return agent.maxDispatchDepth ?? MAX_DEFAULT_DEPTH - 1;
}

// ---------------------------------------------------------------------------
// AC5: Session directory management
// ---------------------------------------------------------------------------

export function getTeammateSessionRoot(parentSessionFile: string | null): string | undefined {
  if (!parentSessionFile) return undefined;
  const baseName = path.basename(parentSessionFile, ".jsonl");
  const sessionsDir = path.dirname(parentSessionFile);
  return path.join(sessionsDir, baseName);
}

// ---------------------------------------------------------------------------
// AC7: Model fallback chain
// ---------------------------------------------------------------------------

export function buildModelCandidates(primary?: string, fallbacks?: string[]): string[] {
  return [...new Set([primary, ...(fallbacks ?? [])].filter((model): model is string => Boolean(model)))];
}

export function isFallbackModelError(messages: Array<{ role: string; content: string }>): boolean {
  return messages.some((message) =>
    message.role === "system" && isFallbackProviderError(message.content)
  );
}

export function resultFailureMessage(messages: Array<{ role: string; content: string }>): string {
  const newestSystemFirst = messages.filter((message) => message.role === "system").reverse();
  return newestSystemFirst.find((message) => isFallbackProviderError(message.content))?.content
    ?? newestSystemFirst[0]?.content
    ?? messages.at(-1)?.content
    ?? "Unknown teammate failure";
}

export function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => finish(false);
    const finish = (ready: boolean) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(ready);
    };
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish(true), delayMs);
  });
}

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

export const retryPersistenceGuards = new Map<string, RetryPersistenceGuard>();

/**
 * Pi's RPC set_auto_retry command persists to settings.json even though the
 * child only needs a session-local override. Restore the original value after
 * every concurrently starting child has acknowledged that command.
 */
export function acquireRetryPersistenceGuard(settingsPath: string): () => void {
  const existing = retryPersistenceGuards.get(settingsPath);
  if (!existing) {
    const snapshot = readRetrySettingSnapshot(settingsPath);
    if (snapshot?.hadEnabled && snapshot.enabled === false) return () => {};
  }
  if (existing?.restoreTimer) {
    clearTimeout(existing.restoreTimer);
    existing.restoreTimer = undefined;
  }
  const guard = existing ?? {
    depth: 0,
    snapshot: readRetrySettingSnapshot(settingsPath),
  };
  guard.depth += 1;
  retryPersistenceGuards.set(settingsPath, guard);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    guard.depth -= 1;
    if (guard.depth > 0) return;
    guard.restoreTimer = setTimeout(() => {
      guard.restoreTimer = undefined;
      if (guard.depth > 0) return;
      retryPersistenceGuards.delete(settingsPath);
      if (guard.snapshot) restoreRetrySettingSnapshot(settingsPath, guard.snapshot);
    }, 250);
  };
}

export function readRetrySettingSnapshot(settingsPath: string): RetrySettingSnapshot | undefined {
  try {
    const root = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown;
    if (!root || typeof root !== "object" || Array.isArray(root)) return undefined;
    const retry = (root as Record<string, unknown>).retry;
    const hadRetry = Boolean(retry && typeof retry === "object" && !Array.isArray(retry));
    const record = hadRetry ? retry as Record<string, unknown> : undefined;
    return {
      hadRetry,
      hadEnabled: typeof record?.enabled === "boolean",
      ...(typeof record?.enabled === "boolean" ? { enabled: record.enabled } : {}),
    };
  } catch {
    return undefined;
  }
}

export function restoreRetrySettingSnapshot(settingsPath: string, snapshot: RetrySettingSnapshot): void {
  try {
    const root = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    if (!root || typeof root !== "object" || Array.isArray(root)) return;
    const retry = root.retry && typeof root.retry === "object" && !Array.isArray(root.retry)
      ? { ...root.retry as Record<string, unknown> }
      : {};
    const currentHadEnabled = typeof retry.enabled === "boolean";
    if (
      currentHadEnabled === snapshot.hadEnabled
      && (!snapshot.hadEnabled || retry.enabled === snapshot.enabled)
    ) return;
    if (snapshot.hadEnabled) retry.enabled = snapshot.enabled;
    else delete retry.enabled;
    if (!snapshot.hadRetry && Object.keys(retry).length === 0) delete root.retry;
    else root.retry = retry;
    const temporary = `${settingsPath}.${process.pid}.${randomUUID()}.retry.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(root, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, settingsPath);
  } catch {
    // Best effort: a failed restore must not hide the child result.
  }
}

export function childSettingsPath(env: NodeJS.ProcessEnv): string {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "settings.json");
}

// ---------------------------------------------------------------------------
// Build pi CLI arguments
// ---------------------------------------------------------------------------

export const MODEL_SPECIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)*$/;
export const MAX_MODEL_SPECIFIER_BYTES = 256;

export function validateModelSpecifier(model: string): string {
  if (
    Buffer.byteLength(model, "utf8") > MAX_MODEL_SPECIFIER_BYTES
    || !MODEL_SPECIFIER_PATTERN.test(model)
  ) {
    throw new TypeError(`Invalid teammate model specifier: ${JSON.stringify(model)}`);
  }
  return model;
}

/** Control and formatting characters no specifier may carry, in any namespace. */
const MODEL_SPECIFIER_CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

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
export function validateBackendModelSpecifier(model: string): string {
  if (model.trim().length === 0) {
    throw new TypeError("Teammate model specifier for a backend dispatch must not be empty");
  }
  if (Buffer.byteLength(model, "utf8") > MAX_MODEL_SPECIFIER_BYTES) {
    throw new TypeError(
      `Teammate model specifier exceeds ${MAX_MODEL_SPECIFIER_BYTES} bytes: ${JSON.stringify(model.slice(0, 64))}…`,
    );
  }
  if (MODEL_SPECIFIER_CONTROL_CHARACTERS.test(model)) {
    throw new TypeError(
      `Teammate model specifier must not carry control characters: ${JSON.stringify(model)}`,
    );
  }
  return model;
}

export function resolveModelSpecifier(
  model: string,
  modelCapabilities: readonly TeammateModelCapability[] = [],
): string {
  validateModelSpecifier(model);
  if (modelCapabilities.length === 0) return model;
  if (model.includes("/")) {
    if (modelCapabilities.some((candidate) => candidate.id === model)) return model;
    throw new TypeError(`Unknown teammate model specifier ${JSON.stringify(model)}. Use an available provider/model identifier.`);
  }

  const matches = modelCapabilities
    .map((candidate) => candidate.id)
    .filter((candidate) => candidate.startsWith(`${model}/`) || candidate.endsWith(`/${model}`));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new TypeError(`Ambiguous teammate model specifier ${JSON.stringify(model)}. Matches: ${matches.join(", ")}`);
  }
  throw new TypeError(`Unknown teammate model specifier ${JSON.stringify(model)}. Use an exact provider/model identifier.`);
}

export function buildPiArgs(
  agentConfig: AgentConfig,
  params: RunSingleTeammateParams,
  systemPromptFile: string,
  modelOverride?: string,
  sessionDir?: string,
  forkSessionFile?: string,
  schemaFile?: string,
  modelCapabilities: readonly TeammateModelCapability[] = [],
  resumeSessionFile?: string,
): string[] {
  // RPC mode: stdin stays open for bidirectional messaging (steer/follow_up/abort).
  // Child extensions are passed explicitly below; disable settings discovery so an
  // older duplicate package registration cannot load the same tools a second time.
  const args: string[] = ["--mode", "rpc", "--no-extensions"];

  // Child mode owns session identity publication, lease fencing, and proxy tools.
  // Load it explicitly because the child cwd may not discover this package.
  const teammateExtension = fileURLToPath(
    new URL("../extension/index.ts", import.meta.url),
  );
  args.push("--extension", teammateExtension);

  const inheritedExtensions = getTeammateChildExtensions();
  const loadedExtensionPaths = new Set([
    process.platform === "win32" ? teammateExtension.toLowerCase() : teammateExtension,
  ]);
  for (const registration of inheritedExtensions) {
    const key = process.platform === "win32"
      ? registration.path.toLowerCase()
      : registration.path;
    if (loadedExtensionPaths.has(key)) continue;
    loadedExtensionPaths.add(key);
    args.push("--extension", registration.path);
  }

  if (resumeSessionFile) {
    args.push("--session", resumeSessionFile);
  } else if (forkSessionFile) {
    args.push("--fork", forkSessionFile);
  }

  const model = modelOverride ?? params.model ?? agentConfig.model;
  if (model) {
    args.push("--model", resolveModelSpecifier(model, modelCapabilities));
  }

  const requestedThinking = parseTeammateThinkingLevel(params.thinking) ?? agentConfig.thinking;
  if (requestedThinking) {
    // Thinking depth passes through unchanged: the teammate layer never
    // restricts levels; the child Pi host clamps to its own capability
    // boundary when a provider cannot honor the requested level.
    args.push("--thinking", requestedThinking);
  }

  if (agentConfig.tools && agentConfig.tools.length > 0) {
    const hiddenLegacyObservationTools = ["teammate-watch", "teammate-wait", "teammate-monitor"];
    const exposeLegacyObservationTools = process.env.PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS === "1";
    const configuredTools = exposeLegacyObservationTools
      ? agentConfig.tools
      : agentConfig.tools.filter((tool) => !hiddenLegacyObservationTools.includes(tool));
    const legacyObservationTools = exposeLegacyObservationTools ? hiddenLegacyObservationTools : [];
    const proxyTools = ["teammate", "teammate-send", "teammate-list", "observe", ...legacyObservationTools];
    const inheritedTools = inheritedExtensions.flatMap((registration) => registration.tools);
    const toolSet = new Set([...configuredTools, ...proxyTools, ...inheritedTools]);
    if (schemaFile) toolSet.add("structured_output");
    args.push("--tools", [...toolSet].join(","));
  }

  if (schemaFile) {
    const structuredOutputExtension = fileURLToPath(
      new URL("../extension/structured-output.ts", import.meta.url),
    );
    args.push("--extension", structuredOutputExtension);
  }

  args.push(
    agentConfig.systemPromptMode === "replace"
      ? "--system-prompt"
      : "--append-system-prompt",
    systemPromptFile,
  );

  if (!agentConfig.inheritProjectContext) {
    args.push("--no-context-files");
  }

  if (!agentConfig.inheritSkills) {
    args.push("--no-skills");
  }

  if (sessionDir) {
    args.push("--session-dir", sessionDir);
  }

  return args;
}

// ---------------------------------------------------------------------------
// Write temporary files
// ---------------------------------------------------------------------------

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export function shouldEnforcePosixMode(): boolean {
  return process.platform !== "win32";
}

/**
 * Root for prompt/schema/result scratch files, whose contents include the full
 * agent system prompt.
 *
 * POSIX gets its privacy from chmod(0o700). Windows ignores mkdir modes and has
 * no fchmod, so the only lever left is location: %LOCALAPPDATA% is already a
 * per-user tree, unlike the shared %TEMP% fallback.
 */
export function teammateTempRoot(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) return path.join(localAppData, "pi-teammate", "tmp");
  }
  return path.join(os.tmpdir(), "pi-teammate");
}

export function ensurePrivateDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory()) {
    throw new Error(`Private teammate path is not a directory: ${directoryPath}`);
  }
  // mkdir mode is creation-only. Tighten an existing directory explicitly.
  if (shouldEnforcePosixMode()) fs.chmodSync(directoryPath, PRIVATE_DIRECTORY_MODE);
}

export function writePrivateTextFile(filePath: string, content: string): void {
  const fd = openPrivateRegularFile(filePath);
  try {
    // Secure the opened inode before truncating or writing sensitive content.
    // Windows relies on its ACL semantics.
    if (shouldEnforcePosixMode()) fs.fchmodSync(fd, PRIVATE_FILE_MODE);
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content, { encoding: "utf8" });
  } finally {
    fs.closeSync(fd);
  }
}

export function openPrivateRegularFile(filePath: string): number {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const existingFlags = fs.constants.O_WRONLY | noFollow;
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = fs.openSync(filePath, existingFlags, PRIVATE_FILE_MODE);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ELOOP" || code === "EISDIR") {
        throw new Error(`Private teammate path is not a regular file: ${filePath}`);
      }
      if (code !== "ENOENT") throw error;
      try {
        fd = fs.openSync(
          filePath,
          existingFlags | fs.constants.O_CREAT | fs.constants.O_EXCL,
          PRIVATE_FILE_MODE,
        );
      } catch (createError) {
        if (errorCode(createError) === "EEXIST" && attempt === 0) continue;
        throw createError;
      }
    }
    const stat = fs.fstatSync(fd);
    if (stat.isFile()) return fd;
    fs.closeSync(fd);
    throw new Error(`Private teammate path is not a regular file: ${filePath}`);
  }
  throw new Error(`Private teammate path changed while opening: ${filePath}`);
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

export function readRegularTextFile(filePath: string): string {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ELOOP" || code === "EISDIR") {
      throw new Error(`Private teammate path is not a regular file: ${filePath}`);
    }
    throw error;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error(`Private teammate path is not a regular file: ${filePath}`);
    }
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function writeSystemPromptFile(
  agentConfig: AgentConfig,
  correlationId: string,
  outputSchema?: Record<string, unknown>,
  todos?: string[],
): string {
  const tmpDir = teammateTempRoot();
  ensurePrivateDirectory(tmpDir);
  const promptFile = path.join(tmpDir, `prompt-${correlationSessionDirectoryName(correlationId)}.md`);
  const structuredOutputInstruction = outputSchema
    ? "\n\n## Required structured output\nYou must finish by calling the structured_output tool exactly once with a value that satisfies its JSON Schema. A prose-only final answer is invalid. Do not emit any answer after that tool call."
    : "";
  const todoInstruction = todos && todos.length > 0
    ? `\n\n## Assigned Todo tasks\nYour assigned Todo tasks, in priority order (you manage them yourself): ${todos.map((id) => `#${id.replace(/^#/, "")}`).join(", ")}.\nCheck \`todo list\` for their current states: the first runnable task (pending, not blocked, and no other active task for you) is already active (status=in_progress); if it is not active yet, activate it with \`todo update <id> status=in_progress\`.\nFinish each task with \`todo update <id> status=completed summary=<one-line result>\`, then activate the next one with \`todo update <id> status=in_progress\` and continue in order. Drive your queue with \`todo update\` only — \`todo next\` is root's self-drive channel.\nIf a task is blocked by a dependency or you cannot complete it, leave it pending and explain why in your final answer.`
    : "";
  // B1: result publication discipline. A text-only turn emitted while tool
  // calls are still in flight can be misread as the final answer and publish
  // a consumable result before the work is done. Keep narration inside the
  // active turn; emit the final text answer only after tool work is complete.
  const resultPublicationDiscipline =
    "\n\n## Result publication discipline\n" +
    "Do not emit a stop-terminated text-only turn while tool calls are still in flight. " +
    "If you need to narrate progress mid-task, continue the turn (do not stop) or use a tool call. " +
    "Emit your final text answer only after all tool calls have completed.";
  writePrivateTextFile(promptFile, `${agentConfig.systemPrompt}${structuredOutputInstruction}${todoInstruction}${resultPublicationDiscipline}`);
  return promptFile;
}

export function writeSchemaFile(schema: Record<string, unknown>, correlationId: string): { schemaFile: string; outputFile: string } {
  const tmpDir = teammateTempRoot();
  ensurePrivateDirectory(tmpDir);
  const fileId = correlationSessionDirectoryName(correlationId);
  const schemaFile = path.join(tmpDir, `schema-${fileId}.json`);
  const outputFile = path.join(tmpDir, `output-${fileId}.json`);
  writePrivateTextFile(schemaFile, JSON.stringify(schema));
  // Reserve the result path with private permissions before the child starts,
  // closing the predictable-name creation race in the shared temp directory.
  writePrivateTextFile(outputFile, "");
  return { schemaFile, outputFile };
}

export function cleanupFile(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// AC8: Progress helper
// ---------------------------------------------------------------------------

export function createProgress(agent: string, startTime: number): AgentProgress {
  return {
    agent,
    status: "running",
    phase: "starting",
    recentTools: [],
    toolCount: 0,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 0,
    lastActivityAt: startTime,
    startedAt: startTime,
  };
}

export const CHILD_TERMINATION_GRACE_MS = 5_000;

// A result-ready lane settles with its published result if the authoritative
// lifecycle confirmation (agent_settled/close) is this late, so aggregation never
// blocks indefinitely on a missing terminal event.
export const RESULT_READY_GRACE_MS = 60_000;

// C2: when an agent performed tool work before publishing its result-ready turn,
// the agent_settled confirmation may trail behind the last tool result by more
// than the default grace (tool I/O latency, retry, compaction). Give those runs
// a wider window so legitimate post-tool convergence is not misterminated.
// Pure Q&A runs (no tool work) keep the default 60s.
export const RESULT_READY_GRACE_EXTENDED_MS = 120_000;

// A corrective structured-output continuation is one model round-trip, but
// still bounded so a child that never responds settles as a failure instead of
// holding the run open indefinitely.
export const STRUCTURED_OUTPUT_RECOVERY_TIMEOUT_MS = 60_000;

// Output-limit recovery includes a summary provider round-trip and may outlive
// the short result-publication grace window. It is still bounded so a child
// that cannot compact reports the partial result as a failure instead of hanging.
export const OUTPUT_LIMIT_RECOVERY_TIMEOUT_MS = 5 * 60_000;

// Child startup is an infrastructure boundary, independent of the caller's
// foreground wait window. A process that never emits any event is not useful
// background work and must still settle as failed.
export const FIRST_ACTIVITY_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Working-directory resolution
// ---------------------------------------------------------------------------

/**
 * Resolve `params.cwd` relative to the session directory while permitting an
 * explicit path outside the current project. Existing paths are canonicalized;
 * non-existent paths keep their lexical form so spawn reports the normal error.
 */
export function canonicalDirectoryPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function resolveContainedCwd(
  requested: string | undefined,
  baseCwd: string,
): { cwd: string } | { error: string } {
  if (requested === undefined) return { cwd: baseCwd };
  return { cwd: canonicalDirectoryPath(path.resolve(baseCwd, requested)) };
}

/** Prefix marking a working location as a configured remote target. */
export const REMOTE_LOCATION_PREFIX = "remote:";

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
export function remoteLocationRouting(cwd: string | undefined): RemoteLocationRouting | undefined {
  if (cwd === undefined || !cwd.startsWith(REMOTE_LOCATION_PREFIX)) return undefined;
  return { backend: cwd, targetId: cwd.slice(REMOTE_LOCATION_PREFIX.length) };
}

// ---------------------------------------------------------------------------
// Structured-output schema safety
// ---------------------------------------------------------------------------

export const STRUCTURED_OUTPUT_SCHEMA_LIMITS = Object.freeze({
  maxBytes: 64 * 1024,
  maxDepth: 20,
  maxPatternLength: 200,
});

// A quantifier applied to a group that already contains one — the classic
// catastrophic-backtracking shape, e.g. /^(a+)+$/ or /(\w*\s?)*$/.
export const NESTED_QUANTIFIER = /\([^()]*[*+}][^()]*\)\s*[*+{]/;

export function isRiskyRegexSource(source: string): boolean {
  return source.length > STRUCTURED_OUTPUT_SCHEMA_LIMITS.maxPatternLength
    || NESTED_QUANTIFIER.test(source);
}

// Common misspellings of JSON-Schema keywords that TypeBox would silently
// ignore, producing schemas that validate less strictly than the caller
// believes (or, with additionalProperties:false, can never validate at all).
const REQUIRED_TYPO_KEYS = ["require", "requried"] as const;
const PROPERTIES_TYPO_KEYS = ["propterties", "additionalproperty"] as const;

const SCHEMA_KEYWORD_KEYS = new Set([
  "type", "properties", "required", "items", "enum", "const", "allOf",
  "anyOf", "oneOf", "not", "patternProperties", "additionalProperties",
  "additionalItems", "if", "then", "else", "format", "pattern",
  "minLength", "maxLength", "minimum", "maximum", "uniqueItems",
  "description", "title", "$ref", "$schema",
]);

const VALID_SCHEMA_TYPES = new Set([
  "object", "array", "string", "number", "integer", "boolean", "null",
]);

/**
 * Nodes that carry any recognized schema keyword are treated as schema
 * objects; keyword-typo detection is skipped for plain data nodes (e.g. a
 * "default" value) so legitimate values never false-positive.
 */
function isSchemaShapedNode(node: Record<string, unknown>): boolean {
  return Object.keys(node).some((key) => SCHEMA_KEYWORD_KEYS.has(key));
}

/**
 * The model may submit any JSON Schema, and TypeBox compiles its `pattern`
 * keywords into RegExp objects that then run on this process's main thread on
 * every assistant event. Reject the hazardous shapes up front instead of
 * silently dropping keywords, so a valid schema still validates exactly as before.
 */
export function findStructuredOutputSchemaHazard(
  schema: Record<string, unknown>,
): string | undefined {
  let serialized: string;
  try {
    serialized = JSON.stringify(schema) ?? "";
  } catch {
    return "outputSchema is not serializable JSON.";
  }
  if (Buffer.byteLength(serialized, "utf8") > STRUCTURED_OUTPUT_SCHEMA_LIMITS.maxBytes) {
    return `outputSchema exceeds ${STRUCTURED_OUTPUT_SCHEMA_LIMITS.maxBytes} bytes.`;
  }

  const visit = (node: unknown, depth: number, path: string): string | undefined => {
    if (depth > STRUCTURED_OUTPUT_SCHEMA_LIMITS.maxDepth) {
      return `outputSchema nests deeper than ${STRUCTURED_OUTPUT_SCHEMA_LIMITS.maxDepth} levels.`;
    }
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        const hazard = visit(node[index], depth + 1, `${path}/${index}`);
        if (hazard) return hazard;
      }
      return undefined;
    }
    if (!node || typeof node !== "object") return undefined;
    const record = node as Record<string, unknown>;
    if (isSchemaShapedNode(record)) {
      for (const typo of REQUIRED_TYPO_KEYS) {
        if (typo in record) {
          return `outputSchema at ${path} contains misspelled keyword "${typo}" (did you mean "required"?).`;
        }
      }
      for (const typo of PROPERTIES_TYPO_KEYS) {
        if (typo in record) {
          return `outputSchema at ${path} contains misspelled keyword "${typo}" (did you mean "properties"?).`;
        }
      }
      if (
        record.properties !== undefined
        && (
          !record.properties
          || typeof record.properties !== "object"
          || Array.isArray(record.properties)
        )
      ) {
        return `outputSchema at ${path} has a "properties" value that is not an object.`;
      }
      if (record.required !== undefined) {
        if (!Array.isArray(record.required) || record.required.some((item) => typeof item !== "string")) {
          return `outputSchema at ${path} has a "required" value that is not an array of strings.`;
        }
        if (record.additionalProperties === false) {
          const props = record.properties as Record<string, unknown> | undefined;
          for (const item of record.required) {
            if (!props || !(item in props)) {
              return `outputSchema at ${path}: required property ${JSON.stringify(item)} is not declared in "properties" while "additionalProperties" is false — the value can never validate.`;
            }
          }
        }
      }
      if (record.type !== undefined) {
        const types = Array.isArray(record.type) ? record.type : [record.type];
        if (
          types.length === 0
          || types.some((t) => typeof t !== "string" || !VALID_SCHEMA_TYPES.has(t))
        ) {
          return `outputSchema at ${path} has an invalid "type" (${JSON.stringify(record.type)}) — expected one of object|array|string|number|integer|boolean|null.`;
        }
      }
      if (record.items !== undefined) {
        const validItems = typeof record.items === "boolean"
          || (typeof record.items === "object" && record.items !== null);
        if (!validItems) {
          return `outputSchema at ${path} has an "items" value that is not a schema, boolean schema, or tuple schema array.`;
        }
      }
      if (record.enum !== undefined) {
        if (!Array.isArray(record.enum) || record.enum.length === 0) {
          return `outputSchema at ${path} has an "enum" value that is not a non-empty array.`;
        }
      }
      if (path === "/" && typeof record.prompt === "string") {
        return `outputSchema at ${path} has a task-text "prompt" key, which is not a JSON Schema keyword — move it to the task level (tasks[].prompt).`;
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === "pattern" && typeof value === "string" && isRiskyRegexSource(value)) {
        return `outputSchema contains a pattern that risks catastrophic backtracking: ${value}`;
      }
      if (key === "patternProperties" && value && typeof value === "object") {
        for (const source of Object.keys(value as Record<string, unknown>)) {
          if (isRiskyRegexSource(source)) {
            return `outputSchema contains a patternProperties key that risks catastrophic backtracking: ${source}`;
          }
        }
      }
      const hazard = visit(value, depth + 1, `${path}/${key}`);
      if (hazard) return hazard;
    }
    return undefined;
  };

  const nested = visit(schema, 0, "/");
  if (nested) return nested;

  // Root contract (docs/tool-schema-reference): structured output must be a
  // single type:"object" schema; a root-level anyOf/oneOf is rejected by
  // providers when the child registers the structured_output tool.
  if (schema.anyOf !== undefined || schema.oneOf !== undefined) {
    return `outputSchema root must not use "anyOf"/"oneOf" — use a single type:"object" schema.`;
  }
  if (schema.type === undefined) {
    return `outputSchema root must declare type "object".`;
  }
  const rootTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (rootTypes.length !== 1 || rootTypes[0] !== "object") {
    const typeLabel = JSON.stringify(schema.type);
    if (schema.enum !== undefined) {
      // type+enum at the root is the common analyst-style mistake: a
      // fixed-value answer written as a bare primitive. Structured output is
      // contractually an object, so point at the wrapping shape instead of a
      // bare "must be object" rejection.
      return `outputSchema root must be a single type:"object" schema (got ${typeLabel} with "enum") — structured output must be an object; move the value choice into a property, e.g. { "type": "object", "properties": { "value": { "type": ${typeLabel}, "enum": [...] } }, "required": ["value"] }.`;
    }
    return `outputSchema root must be a single type:"object" schema (got ${typeLabel}).`;
  }
  return undefined;
}

export type ChildReclamationOutcome =
  | { status: "reclaimed"; forced: boolean }
  | {
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
export function createChildTerminationController(
  child: ChildProcess,
  options: ChildTerminationOptions = {},
): ChildTerminationController {
  const graceMs = options.graceMs ?? CHILD_TERMINATION_GRACE_MS;
  const reclamationTimeoutMs = options.reclamationTimeoutMs ?? graceMs;
  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawnProcess ?? spawn;
  let exitObserved = child.exitCode !== null || child.signalCode !== null;
  let terminationStarted = false;
  let forced = false;
  let windowsTreeCleanupConfirmed = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let confirmationTimer: ReturnType<typeof setTimeout> | undefined;
  let outcomeSettled = false;
  let resolveOutcome!: (outcome: ChildReclamationOutcome) => void;
  const outcome = new Promise<ChildReclamationOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  const settleOutcome = (value: ChildReclamationOutcome): void => {
    if (outcomeSettled) return;
    outcomeSettled = true;
    resolveOutcome(value);
  };
  const clearForceTimer = (): void => {
    if (!forceTimer) return;
    clearTimeout(forceTimer);
    forceTimer = undefined;
  };
  const clearConfirmationTimer = (): void => {
    if (!confirmationTimer) return;
    clearTimeout(confirmationTimer);
    confirmationTimer = undefined;
  };
  const isAlive = (): boolean =>
    !exitObserved && child.exitCode === null && child.signalCode === null;
  const markReclaimed = (): void => {
    clearForceTimer();
    clearConfirmationTimer();
    settleOutcome({ status: "reclaimed", forced });
  };
  const onExit = (): void => {
    exitObserved = true;
    if (platform !== "win32" || !terminationStarted || windowsTreeCleanupConfirmed) {
      markReclaimed();
    }
  };
  const armExitConfirmation = (): void => {
    clearConfirmationTimer();
    confirmationTimer = setTimeout(() => {
      confirmationTimer = undefined;
      if (platform === "win32" && terminationStarted && !windowsTreeCleanupConfirmed) {
        settleOutcome({ status: "unreaped", forced: true, reason: "exit-unconfirmed" });
      } else if (!isAlive()) markReclaimed();
      else settleOutcome({ status: "unreaped", forced: true, reason: "exit-unconfirmed" });
    }, reclamationTimeoutMs);
    confirmationTimer.unref?.();
  };
  const killDirect = (signal: NodeJS.Signals): boolean => {
    if (!isAlive()) {
      markReclaimed();
      return true;
    }
    try {
      const delivered = child.kill(signal);
      if (!isAlive()) markReclaimed();
      else if (!delivered && signal === "SIGKILL") {
        settleOutcome({ status: "unreaped", forced: true, reason: "delivery-failed" });
      }
      return delivered;
    } catch {
      if (!isAlive()) {
        markReclaimed();
        return true;
      }
      if (signal === "SIGKILL") {
        settleOutcome({ status: "unreaped", forced: true, reason: "delivery-failed" });
      }
      return false;
    }
  };
  const killWindowsTree = (force: boolean): void => {
    if (windowsTreeCleanupConfirmed) return;
    forced ||= force;
    const fallbackDirect = (): void => {
      const delivered = killDirect(force ? "SIGKILL" : "SIGTERM");
      if (force && delivered && isAlive()) armExitConfirmation();
    };
    if (!child.pid) {
      fallbackDirect();
      return;
    }
    try {
      const killer = spawnProcess(
        "taskkill",
        ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])],
        { windowsHide: true, stdio: "ignore", shell: false },
      );
      let fallbackStarted = false;
      const fallbackOnce = (): void => {
        if (fallbackStarted) return;
        fallbackStarted = true;
        fallbackDirect();
      };
      killer.once("error", fallbackOnce);
      killer.once("close", (code) => {
        if (code !== 0) {
          fallbackOnce();
          return;
        }
        windowsTreeCleanupConfirmed = true;
        markReclaimed();
      });
      if (force) armExitConfirmation();
    } catch {
      fallbackDirect();
    }
  };

  child.once("exit", onExit);
  if (exitObserved) markReclaimed();
  return {
    outcome,
    terminate(): void {
      if (terminationStarted) return;
      if (!isAlive()) {
        markReclaimed();
        return;
      }
      terminationStarted = true;
      if (platform === "win32") killWindowsTree(false);
      else killDirect("SIGTERM");
      if (platform !== "win32" && !isAlive()) return;
      forceTimer = setTimeout(() => {
        forceTimer = undefined;
        forced = true;
        if (platform === "win32") {
          if (!windowsTreeCleanupConfirmed) killWindowsTree(true);
          return;
        }
        if (!isAlive()) {
          markReclaimed();
          return;
        }
        const delivered = killDirect("SIGKILL");
        if (delivered && isAlive()) armExitConfirmation();
      }, graceMs);
      forceTimer.unref?.();
    },
    cleanup(): void {
      child.removeListener("exit", onExit);
      if (!isAlive() && (platform !== "win32" || !terminationStarted || windowsTreeCleanupConfirmed)) {
        markReclaimed();
      }
      if (platform !== "win32" || !terminationStarted || windowsTreeCleanupConfirmed) {
        clearForceTimer();
      }
      if (terminationStarted && isAlive() && !forceTimer && !confirmationTimer) {
        settleOutcome({ status: "unreaped", forced, reason: "cleanup-before-exit" });
      }
    },
  };
}

/** @internal Exported for lifecycle regression tests. */
export function bindChildTerminationSignal(
  termination: ChildTerminationController,
  signal?: AbortSignal,
): () => void {
  if (!signal) return () => undefined;
  const abortHandler = () => termination.terminate();
  signal.addEventListener("abort", abortHandler, { once: true });
  if (signal.aborted) abortHandler();
  return () => signal.removeEventListener("abort", abortHandler);
}

