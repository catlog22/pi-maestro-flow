/**
 * The Pi subprocess attempt: everything needed to run one teammate turn in a
 * child Pi runtime, from spawn through settlement and child-process reclamation.
 *
 * Split out of `execution.ts` so orchestration and backend implementation stop
 * sharing a file. `execution.ts` keeps the model-candidate sweep, circuit
 * breaker, replay fence, and completion publication — decisions about *which*
 * model runs. This module owns what one specific runtime does with an
 * already-chosen model.
 *
 * The recovery WeakMaps are written here and read only by this package's Pi
 * backend adapter, which turns them into the contract's `AttemptOutcome`. They
 * are deliberately absent from the package's public surface: outside this pair
 * of modules, recovery facts travel as a value on the outcome rather than as a
 * side channel a caller can forget to consult.
 */

import {

  spawn,
  type ChildProcess,
} from "node:child_process";
import { logDiagnosticError, logDiagnosticWarn } from "../shared/diagnostic-log.ts";
import {
  randomUUID,
} from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  Writable,
} from "node:stream";
import {
  StringDecoder,
} from "node:string_decoder";
import crossSpawn from "cross-spawn";
import {
  type AgentConfig,
} from "../agents/agents.ts";
import {
  type ReplyTarget,
} from "../shared/routing.ts";
import {
  previewToolCallArgs,
} from "./shared/tool-preview.ts";
import type {
  SingleResult,
  AgentTerminalStatus,
  AgentTurnEvent,
  AgentTurnMessageMetadataV1,
  AgentTurnTriggerContextV1,
  MessageProvenanceV1,
} from "../shared/types.ts";
import {
  AGENT_TURN_VERSION,
  normalizeMessageProvenanceV1,
  unknownMessageProvenanceV1,
} from "../shared/types.ts";
import {
  wrapLeasedMessage,
  type LeaseToken,
} from "./session-handoff.ts";
import { isFallbackProviderError } from "./retry.ts";
import {
  EXECUTION_BUFFER_LIMITS,
  FIRST_ACTIVITY_TIMEOUT_MS,
  MODEL_FALLBACK_RESUME_PROMPT,
  OUTPUT_LIMIT_RECOVERY_TIMEOUT_MS,
  resultReadyGraceMsFor,
  STRUCTURED_OUTPUT_RECOVERY_PROMPT,
  STRUCTURED_OUTPUT_RECOVERY_TIMEOUT_MS,
  STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS,
  addUsageSnapshot,
  appendBoundedTranscriptMessage,
  appendDistinctAssistantMessage,
  appendUtf8Tail,
  bindChildTerminationSignal,
  buildPiArgs,
  cleanupFile,
  correlationSessionDirectoryName,
  createChildTerminationController,
  createProgress,
  createUtf8LineDecoder,
  describeStructuredOutputValidationFailure,
  describeStructuredOutputValueValidationFailure,
  emptyUsage,
  ensurePrivateDirectory,
  extractPiEventError,
  extractStructuredOutputCandidate,
  extractTextContent,
  getPiSpawnCommand,
  getTeammateDepth,
  getTeammateSessionRoot,
  isPiResultReadyTurn,
  readRegularTextFile,
  releasePublishedTurnHistory,
  resetUsage,
  setUsageSnapshot,
  truncateUtf8Tail,
  writeSchemaFile,
  writeSystemPromptFile,
} from "./execution-infra.ts";
import type {
  JsonLineEvent,
  RunSingleTeammateParams,
  RunTeammateOptions,
  StructuredOutputCandidate,
} from "./execution-infra.ts";

// Failed candidate processes must be physically reclaimed before a fallback
// reuses their correlation identity for a replacement child.
export const attemptReclamations = new WeakMap<SingleResult, Promise<unknown>>();

export type AttemptSettlementCapability = "agent_settled" | "legacy" | "unknown";

interface AttemptRecoveryFacts {
  settlementCapability: AttemptSettlementCapability;
  completedToolCount: number;
  inFlightToolCount: number;
  /** A non-zero close before any child event, stderr, or possible side effect. */
  preActivityInfrastructureExit: boolean;
  /** IPC or non-protocol output that may represent untracked external work. */
  externalReplayRisk: boolean;
  /** Non-JSON stdout was attributed as assistant content (protocol violation). Optional: not all settlement paths populate it. */
  stdoutProtocolViolation?: boolean; }

export const attemptRecoveryFacts = new WeakMap<SingleResult, AttemptRecoveryFacts>();
const INTERRUPTING_STEER_TIMEOUT_MS = 10_000;

/**
 * Deadline for Pi to acknowledge an in-process model switch (`set_model`).
 * Independent of the steer timeout: a slow provider handshake on a cold
 * account can legitimately exceed a steer's interactive budget, while a
 * stalled switch must still settle the turn instead of hanging.
 */
const MODEL_SWITCH_ACK_TIMEOUT_MS = 15_000;



/** AC5: session directory + fork context resolved once per attempt. */
interface AttemptSessionContext {
  /** Private per-correlation session directory, when the parent exposes one. */
  sessionDir?: string;
  /** Existing child session loaded after a cold runtime restart. */
  resumeSessionFile?: string;
  /** Parent session file the child forks from. */
  forkSessionFile?: string;
  /** Transcript note emitted when an explicit fork could not be honoured. */
  forkWarning?: string;
}

function resolveAttemptSessionContext(
  params: RunSingleTeammateParams,
  agentConfig: AgentConfig,
  correlationId: string,
  options: RunTeammateOptions,
): AttemptSessionContext {
  const effectiveContext = params.context ?? agentConfig.defaultContext;
  const parentSession = options.parentSessionFile ?? process.env.PI_TEAMMATE_PARENT_SESSION ?? null;
  const hasParentSession = Boolean(parentSession) && fs.existsSync(parentSession as string);
  const context: AttemptSessionContext = {};
  if (options.resumeSessionFile && fs.existsSync(options.resumeSessionFile)) {
    context.resumeSessionFile = options.resumeSessionFile;
    context.sessionDir = path.dirname(options.resumeSessionFile);
  }
  if (!context.sessionDir && options.sessionDir) {
    ensurePrivateDirectory(options.sessionDir);
    context.sessionDir = path.resolve(options.sessionDir);
  }
  if (hasParentSession && !context.sessionDir) {
    const sessionRoot = getTeammateSessionRoot(parentSession as string);
    if (sessionRoot) {
      context.sessionDir = path.join(sessionRoot, correlationSessionDirectoryName(correlationId));
      ensurePrivateDirectory(context.sessionDir);
    }
  }
  if (effectiveContext === "fork" && !context.resumeSessionFile) {
    if (hasParentSession) {
      context.forkSessionFile = parentSession as string;
    } else if (params.context === "fork") {
      context.forkWarning = "Fork requested but parent session file not available. Starting with fresh context.";
    }
  }
  return context;
}

/**
 * Every value a running attempt mutates after setup. Collecting them here keeps
 * the settlement invariants readable as one state machine instead of a dozen
 * independent closure flags, and lets the per-event handlers below be named,
 * self-contained functions.
 */
interface AttemptState {
  // --- Turn-scoped: cleared by completeTurn() once a result is published. ---
  lastContent: string;
  streamingText: string;
  stderrBuffer: string;
  pendingStructuredOutput?: StructuredOutputCandidate;
  capturedStructuredOutput: unknown;
  structuredOutputValidationFailure?: string;
  /** Set when the child's structured_output tool execution itself failed. */
  structuredOutputAttemptFailed: boolean;
  reportedRuntimeErrors: Set<string>;
  runtimeFailure?: string;
  /**
   * progress.toolCount stays cumulative for the lifetime of a wakeable agent so
   * it reads on the same scale as the cumulative token counters. This per-turn
   * count only feeds diagnostics.
   */
  turnToolCount: number;
  /**
   * Re-opened at every turn boundary, set by completeTurn(). Guards against a
   * second settlement for the same turn.
   */
  turnLifecycleSettled: boolean;
  /** Last assistant stop reason observed for this turn. */
  lastAssistantStopReason?: string;
  /** A length-truncated turn is waiting for child-local compaction and continuation. */
  outputLimitRecoveryPending: boolean;
  /** A Flow synthetic compaction interruption must continue before this turn can settle. */
  compactionRecovery?: {
    recoveryId: string;
    generation: number;
    phase: "pending" | "continuation" | "completed";
  };

  // --- Attempt-scoped: survive turns for the lifetime of a wakeable child. ---
  resolvedModel: string;
  /**
   * Result usage remains turn-scoped, while status usage stays cumulative for
   * the lifetime of a wakeable agent.
   */
  completedInputTokens: number;
  completedOutputTokens: number;
  completedCacheReadTokens: number;
  completedCacheWriteTokens: number;
  /** One-way latches; never reset. */
  receivedFirstActivity: boolean;
  /** True only for a silent non-zero close before any child event or possible effect. */
  preActivityInfrastructureExit: boolean;
  /** IPC or non-protocol output makes cross-process replay unsafe. */
  externalReplayRisk: boolean;
  /** Non-JSON stdout was attributed as assistant content (protocol violation). */
  stdoutProtocolViolation: boolean;
  initialResultPublished: boolean;
  /** Recovery evidence used to fence any fresh-process model fallback. */
  settlementCapability: AttemptSettlementCapability;
  completedToolCount: number;
  inFlightToolCount: number;
  /** Absorbing state: once terminal, queued child lines must not reopen a turn. */
  terminal: boolean;
  /** In-process model switch transaction, when one is awaiting Pi's ack. */
  modelSwitch?: {
    requestId: string;
    targetModel: string;
    /** False until Pi confirms the `set_model` command. */
    acknowledged: boolean;
  };
  /**
   * Model currently active after an in-process switch (undefined until the
   * first switch is acknowledged). Passed back to `onModelFailover` so the
   * decision hook can settle the previous trial and avoid re-selecting it.
   */
  switchedModel?: string;
  /**
   * Request id of the resume prompt issued after a successful in-process
   * model switch. A rejected response for this id must settle the turn (the
   * child is alive but refuses to continue, so no other settlement path
   * exists).
   */
  modelSwitchResumeRequestId?: string;
}

/**
 * While a tool is in flight (e.g. a long bash script), the pi child emits no
 * further events until the tool completes. Without a heartbeat the parent's
 * 30s stall clock (`TEAMMATE_STALL_TIMEOUT_MS`) would mark a busy agent as
 * stalled. This interval refreshes progress activity until the tool ends; it
 * stays well under the stall threshold so dropped ticks cannot false-flag.
 */
export const TOOL_EXECUTION_HEARTBEAT_MS = 10_000;

/**
 * The lifecycle deadlines an attempt can arm. Every settlement path clears
 * both; cleared handles are deliberately left in place so
 * `armResultReadyGrace` still recognises a grace window that was already used.
 */
interface AttemptTimers {
  firstActivity?: ReturnType<typeof setTimeout>;
  resultReadyGrace?: ReturnType<typeof setTimeout>;
  outputLimitRecovery?: ReturnType<typeof setTimeout>;
  compactionRecovery?: ReturnType<typeof setTimeout>;
  interruptingSteer?: ReturnType<typeof setTimeout>;
  structuredOutputRecovery?: ReturnType<typeof setTimeout>;
  toolHeartbeat?: ReturnType<typeof setInterval>;
  modelSwitch?: ReturnType<typeof setTimeout>;
}

interface PendingInterrupt {
  abortRequestId: string;
  promptRequestId: string;
  message: string;
  token?: LeaseToken;
  provenance?: MessageProvenanceV1;
  phase: "aborting" | "prompting";
  /** Set when the interrupted turn settles; a later turn_start means the steer missed its window. */
  turnSettledDuringAbort?: boolean;
}

interface PendingModelInput {
  /** Exact leased string written on the Pi transport. */
  transportMessage: string;
  /** Exact user text after the child input hook validates and unwraps the lease. */
  acceptedMessage: string;
  context: AgentTurnTriggerContextV1;
  loopSeq: number;
  eventsEmitted: boolean;
  initial: boolean;
  committed: boolean;
  lastMessage?: AgentTurnMessageMetadataV1;
}

/**
 * Cache tier for agent subprocesses.
 *
 * Agents stay on the short tier (5m on Anthropic, implicit 30m on OpenAI) even
 * when the main process runs with PI_CACHE_RETENTION=long, so a long-lived main
 * session does not leak its expensive 1h/24h cache tier into short-lived agents.
 * PI_TEAMMATE_CACHE_RETENTION overrides the pin (valid values: short | long | none).
 */
export function resolveAgentCacheRetention(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_TEAMMATE_CACHE_RETENTION;
  return override === "long" || override === "none" || override === "short" ? override : "short";
}

/** Environment handed to the pi child: identity, depth diagnostics and file seams. */
function buildChildSpawnEnv(
  correlationId: string,
  replyTo: ReplyTarget,
  options: RunTeammateOptions,
  schemaFile: string | undefined,
  outputFile: string | undefined,
  forkSessionFile: string | undefined,
): Record<string, string | undefined> {
  const spawnEnv: Record<string, string | undefined> = {
    ...process.env,
    PI_TEAMMATE_CHILD: "1",
    // Diagnostic only. The child never spawns grandchildren itself — it
    // proxies nested dispatches back to this process — so the guard reads
    // RunTeammateOptions.depth rather than this variable.
    PI_TEAMMATE_DEPTH: String((options.depth ?? getTeammateDepth()) + 1),
    PI_TEAMMATE_CORRELATION_ID: correlationId,
    PI_TEAMMATE_REPLY_TO: replyTo,
    // Cache-tier pin (see resolveAgentCacheRetention): the child inherits the
    // parent env via the spread above, so an explicit short-tier override keeps
    // agents from inheriting the main process's long retention.
    PI_CACHE_RETENTION: resolveAgentCacheRetention(process.env),
    ...options.childEnvironment,
    PI_TEAMMATE_CONTEXT_MODE: forkSessionFile ? "fork" : undefined,
  };
  if (options.maxDispatchDepth !== undefined) {
    spawnEnv.PI_TEAMMATE_MAX_DISPATCH_DEPTH = String(options.maxDispatchDepth);
  }
  if (outputFile) {
    spawnEnv.PI_TEAMMATE_STRUCTURED_OUTPUT_PATH = outputFile;
    spawnEnv.PI_TEAMMATE_STRUCTURED_SCHEMA_PATH = schemaFile;
  }
  if (options.parentSessionFile) {
    spawnEnv.PI_TEAMMATE_PARENT_SESSION = options.parentSessionFile;
  }
  return spawnEnv;
}

/** Child IPC events that only publish identity or in-process recovery state. */
function isReplayNeutralChildIpcMessage(message: Record<string, unknown>): boolean {
  return message.type === "teammate_session_ready"
    || message.type === "teammate_compaction_state";
}

interface ChildCompactionStateEvent {
  type: "teammate_compaction_state";
  recoveryId: string;
  generation: number;
  phase: "pending" | "continuation" | "completed" | "failed";
  reason?: string;
}

function childCompactionStateEvent(message: Record<string, unknown>): ChildCompactionStateEvent | undefined {
  if (message.type !== "teammate_compaction_state"
    || typeof message.recoveryId !== "string"
    || !Number.isSafeInteger(message.generation)
    || (message.phase !== "pending"
      && message.phase !== "continuation"
      && message.phase !== "completed"
      && message.phase !== "failed")) return undefined;
  return {
    type: "teammate_compaction_state",
    recoveryId: message.recoveryId,
    generation: message.generation as number,
    phase: message.phase,
    ...(typeof message.reason === "string" ? { reason: message.reason } : {}),
  };
}

/** Proxy requests and lifecycle events raised by extensions inside the child. */
function bindChildIpcRelay(
  child: ChildProcess,
  correlationId: string,
  options: RunTeammateOptions,
  onActivity?: (message: Record<string, unknown>) => void,
): void {
  child.on("message", (msg: unknown) => {
    // PERFSEC-001: process.send(null) or malformed envelopes must not crash
    // the parent — an unguarded property access in an EventEmitter callback is
    // an uncaught exception.
    if (msg === null || msg === undefined || typeof msg !== "object") return;
    // GEN-001: After teardown aborts the signal, a dying child's in-flight
    // IPC messages must not re-enter the parent and spawn new nested agents.
    if (options.signal?.aborted) return;
    const m = msg as Record<string, unknown>;
    onActivity?.(m);
    dispatchChildIpcMessage(
      m,
      options.onChildRequest
        ? (request, reply) => options.onChildRequest?.({
            ...request,
            // The parent process owns this identity; never trust a child-supplied actor id.
            correlationId,
          }, reply)
        : undefined,
      options.onChildEvent
        ? (event) => options.onChildEvent?.({
            ...event,
            // Lifecycle ownership is assigned by the spawning parent.
            correlationId,
          })
        : undefined,
      (reply) => {
        if (!sendChildIpcMessage(child, reply as Record<string, unknown>)) {
          throw new Error("Child IPC channel rejected the reply envelope.");
        }
      },
    );
  });
}

export async function runSingleAttempt(
  params: RunSingleTeammateParams,
  agentConfig: AgentConfig,
  cwd: string,
  correlationId: string,
  replyTo: ReplyTarget,
  startTime: number,
  modelOverride: string | undefined,
  options: RunTeammateOptions,
): Promise<SingleResult> {
  const effectiveContext = params.context ?? agentConfig.defaultContext;
  const wakeable = effectiveContext !== "fork";
  const systemPromptFile = writeSystemPromptFile(agentConfig, correlationId, params.outputSchema, params.todos);
  const { sessionDir, resumeSessionFile, forkSessionFile, forkWarning } =
    resolveAttemptSessionContext(params, agentConfig, correlationId, options);

  // AC6: Structured output
  const { schemaFile, outputFile } = params.outputSchema
    ? writeSchemaFile(params.outputSchema, correlationId)
    : { schemaFile: undefined, outputFile: undefined };

  const piArgs = buildPiArgs(
    agentConfig,
    params,
    systemPromptFile,
    modelOverride,
    sessionDir,
    forkSessionFile,
    schemaFile,
    options.modelCapabilities,
    resumeSessionFile,
  );

  const usage = emptyUsage();
  const pendingMessageUsage = emptyUsage();
  const messages: Array<{ role: string; content: string }> = [];
  if (forkWarning) {
    appendBoundedTranscriptMessage(messages, { role: "system", content: forkWarning });
  }
  const state: AttemptState = {
    lastContent: "",
    streamingText: "",
    stderrBuffer: "",
    pendingStructuredOutput: undefined,
    capturedStructuredOutput: undefined,
    structuredOutputValidationFailure: undefined,
    reportedRuntimeErrors: new Set(),
    runtimeFailure: undefined,
    turnToolCount: 0,
    turnLifecycleSettled: false,
    lastAssistantStopReason: undefined,
    outputLimitRecoveryPending: false,
    compactionRecovery: undefined,
    structuredOutputAttemptFailed: false,
    resolvedModel: modelOverride ?? params.model ?? agentConfig.model ?? "unknown",
    completedInputTokens: 0,
    completedOutputTokens: 0,
    completedCacheReadTokens: 0,
    completedCacheWriteTokens: 0,
    receivedFirstActivity: false,
    preActivityInfrastructureExit: false,
    externalReplayRisk: false,
    stdoutProtocolViolation: false,
    initialResultPublished: false,
    settlementCapability: "unknown",
    completedToolCount: 0,
    inFlightToolCount: 0,
    terminal: false,
  };

  // AC8: Rich progress tracking
  const progress = createProgress(params.agent, startTime);
  progress.requestedModel = modelOverride ?? params.model ?? agentConfig.model;

  const initialTurnContext: AgentTurnTriggerContextV1 = options.initialTurnContext ?? {
    version: AGENT_TURN_VERSION,
    turnId: randomUUID(),
    correlationId,
    runtimeGeneration: options.runtimeGeneration ?? 0,
    promptSeq: 1,
    trigger: normalizeMessageProvenanceV1(options.initialMessageProvenance),
  };
  const turnLoopSeqOffset = Number.isSafeInteger(options.turnLoopSeqOffset)
    ? Math.max(0, options.turnLoopSeqOffset ?? 0)
    : 0;
  const pendingModelInputs: PendingModelInput[] = [];
  let currentModelInput: PendingModelInput | undefined;
  let initialModelInputRegistered = false;
  let nextExternalPromptSeq = initialTurnContext.promptSeq + 1;
  let lastTurnEventTimestamp = 0;
  let lastProgressFingerprint: string | undefined;

  const turnEventTimestamp = (): number => {
    lastTurnEventTimestamp = Math.max(Date.now(), lastTurnEventTimestamp + 1);
    return lastTurnEventTimestamp;
  };

  const recordCanonicalTurnEvent = (event: AgentTurnEvent): void => {
    if (event.type === "progress") {
      const fingerprint = JSON.stringify([
        event.turnId,
        event.correlationId,
        event.runtimeGeneration,
        event.promptSeq,
        event.loopSeq,
        event.phase ?? null,
        event.toolActivity ?? null,
        event.lastMessage ?? null,
      ]);
      if (fingerprint === lastProgressFingerprint) return;
      lastProgressFingerprint = fingerprint;
    }
    try {
      options.recordTurnEvent?.(event);
    } catch {
      // Observational sidecar failures cannot change transport or settlement.
    }
  };

  const turnEventBase = (input: PendingModelInput, timestamp: number) => ({
    ...input.context,
    loopSeq: input.loopSeq,
    timestamp,
  });

  const enqueueTransportInput = (
    transportMessage: string,
    acceptedMessage: string,
    mode: "prompt" | "steer" | "follow_up",
    provenance?: MessageProvenanceV1,
  ): TransportSidecarLease => {
    const initial = !initialModelInputRegistered;
    initialModelInputRegistered = true;
    const context = initial
      ? initialTurnContext
      : {
          version: AGENT_TURN_VERSION,
          turnId: randomUUID(),
          correlationId: initialTurnContext.correlationId,
          runtimeGeneration: initialTurnContext.runtimeGeneration,
          promptSeq: nextExternalPromptSeq++,
          trigger: normalizeMessageProvenanceV1(provenance, {
            deliveryMode: mode,
            messageKind: "message",
          }),
        };
    const pending: PendingModelInput = {
      transportMessage,
      acceptedMessage,
      context,
      loopSeq: initial ? turnLoopSeqOffset : 0,
      eventsEmitted: false,
      initial,
      committed: false,
    };
    pendingModelInputs.push(pending);
    return {
      commit(): void {
        if (pending.committed) return;
        pending.committed = true;
        if (!pending.initial || options.emitInitialTurnTrigger !== false) {
          const timestamp = turnEventTimestamp();
          recordCanonicalTurnEvent({
            ...turnEventBase(pending, timestamp),
            type: "trigger-enqueued",
          });
        }
      },
      cancel(): void {
        const index = pendingModelInputs.indexOf(pending);
        if (index >= 0) pendingModelInputs.splice(index, 1);
      },
    };
  };

  const hostOnProgress = options.onProgress;
  const reportProgress = (): void => {
    hostOnProgress?.(progress);
    const input = currentModelInput;
    if (!input) return;
    const timestamp = turnEventTimestamp();
    recordCanonicalTurnEvent({
      ...turnEventBase(input, timestamp),
      type: "progress",
      ...(progress.phase === undefined ? {} : { phase: progress.phase }),
      toolActivity: state.inFlightToolCount > 0 ? "active" : "idle",
      ...(input.lastMessage === undefined ? {} : { lastMessage: input.lastMessage }),
    });
  };
  options = { ...options, onProgress: reportProgress };

  const recordTerminalTurnEvent = (
    status: AgentTerminalStatus,
    message?: string,
  ): void => {
    const input = currentModelInput;
    if (!input) return;
    const timestamp = turnEventTimestamp();
    const base = turnEventBase(input, timestamp);
    if (status === "completed") {
      recordCanonicalTurnEvent({
        ...base,
        type: "turn-settled",
        outcome: "completed",
        ...(input.lastMessage === undefined ? {} : { lastMessage: input.lastMessage }),
      });
    } else if (status === "terminated") {
      recordCanonicalTurnEvent({
        ...base,
        type: "terminated",
        outcome: "terminated",
        reason: message?.trim() || "Teammate turn terminated.",
        ...(input.lastMessage === undefined ? {} : { lastMessage: input.lastMessage }),
      });
    } else {
      recordCanonicalTurnEvent({
        ...base,
        type: "failed",
        outcome: "failed",
        error: message?.trim() || "Teammate turn failed.",
        ...(input.lastMessage === undefined ? {} : { lastMessage: input.lastMessage }),
      });
    }
  };

  const recordAttemptRecovery = (result: SingleResult): SingleResult => {
    attemptRecoveryFacts.set(result, {
      settlementCapability: state.settlementCapability,
      completedToolCount: state.completedToolCount,
      inFlightToolCount: state.inFlightToolCount,
      preActivityInfrastructureExit: state.preActivityInfrastructureExit,
      externalReplayRisk: state.externalReplayRisk,
    });
    return result;
  };

  const updateProgressUsage = (): void => {
    const inputTokens = state.completedInputTokens + usage.inputTokens + pendingMessageUsage.inputTokens;
    const outputTokens = state.completedOutputTokens + usage.outputTokens + pendingMessageUsage.outputTokens;
    const cacheReadTokens = state.completedCacheReadTokens + usage.cacheReadTokens + pendingMessageUsage.cacheReadTokens;
    const cacheWriteTokens = state.completedCacheWriteTokens + usage.cacheWriteTokens + pendingMessageUsage.cacheWriteTokens;
    progress.inputTokens = Math.max(progress.inputTokens ?? 0, inputTokens);
    progress.outputTokens = Math.max(progress.outputTokens ?? 0, outputTokens);
    progress.cacheReadTokens = Math.max(progress.cacheReadTokens ?? 0, cacheReadTokens);
    progress.cacheWriteTokens = Math.max(progress.cacheWriteTokens ?? 0, cacheWriteTokens);
    progress.tokens = progress.inputTokens + progress.outputTokens;
  };

  return new Promise<SingleResult>((resolve) => {
    let child: ChildProcess;
    let releaseRetryPersistenceGuard = () => {};
    let pendingInterrupt: PendingInterrupt | undefined;
    /**
     * True when a settlement boundary (agent_settled, legacy agent_end) was
     * swallowed while the interrupt transaction owned settlement. A degraded
     * steer must converge the turn the swallowed boundary would have, or the
     * turn strands with no deadline armed.
     */
    let steerSettlementSwallowed = false;
    let compactionSettlementSwallowed = false;
    let latestCompactionGeneration = -1;
    const closedCompactionRecoveries = new Set<string>();
    const compactionRecoveryKey = (recovery: { recoveryId: string; generation: number }): string =>
      `${recovery.generation}:${recovery.recoveryId}`;
    const closeActiveCompactionRecovery = (): void => {
      if (state.compactionRecovery) {
        closedCompactionRecoveries.add(compactionRecoveryKey(state.compactionRecovery));
      }
    };
    const interruptingSteerTimeoutMs = options.interruptingSteerTimeoutMs ?? INTERRUPTING_STEER_TIMEOUT_MS;

    const spawnEnv = buildChildSpawnEnv(
      correlationId,
      replyTo,
      options,
      schemaFile,
      outputFile,
      forkSessionFile,
    );

    let useIpc = false;
    try {
      const spawnSpec = getPiSpawnCommand(piArgs);
      useIpc = !spawnSpec.shell;
      const spawnOpts: Parameters<typeof crossSpawn>[2] = {
        cwd,
        stdio: useIpc ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
        env: spawnEnv,
        shell: spawnSpec.shell,
        windowsHide: true,
      };
      child = (options.spawnChildProcess ?? crossSpawn)(spawnSpec.command, spawnSpec.args, spawnOpts);
    } catch (error) {
      cleanupFile(systemPromptFile);
      if (schemaFile) cleanupFile(schemaFile);
      if (outputFile) cleanupFile(outputFile);

      const result: SingleResult = {
        agent: params.agent,
        name: params.name,
        task: params.task ?? "",
        exitCode: 1,
        messages: [{
          role: "system",
          content:
            `Failed to spawn pi subprocess (agent=${params.agent}, model=${state.resolvedModel || "unknown"}, `
            + `correlationId=${correlationId}, phase=spawn): ${error instanceof Error ? error.message : String(error)}`,
        }],
        usage: emptyUsage(),
        model: state.resolvedModel,
        correlationId,
        durationMs: Date.now() - startTime,
      };
      recordAttemptRecovery(result);
      state.initialResultPublished = true;
      state.turnLifecycleSettled = true;
      resolve(result);
      try {
        options.onTurnComplete?.(result);
      } catch {
        // Completion observers cannot prevent a terminal spawn failure from settling.
      }
      return;
    }

    if (child.stdin) {
      guardChildStdin(child.stdin);
      transportSidecars.set(child.stdin, { enqueue: enqueueTransportInput });
    }

    // Pi core keeps its in-process provider retry enabled. It handles
    // transient network/provider errors without restarting the child, so
    // tool calls already executed are never repeated. Teammate owns model
    // fallback across candidates at the process level.

    // RPC mode: stdin stays open for bidirectional messaging.
    // Configure the Pi steer-queue drain mode before the first prompt so queued
    // steers are co-injected per the dispatch's steeringMode. "all" drains the
    // whole steerQueue into one assistant turn; "one-at-a-time" (Pi default) is
    // left implicit. The response carries an id that no pending transaction
    // matches, so onResponse ignores it.
    if (child.stdin && options.steeringMode === "all") {
      writeChildStdinLine(child.stdin, JSON.stringify({
        id: `teammate-steering-mode-${randomUUID()}`,
        type: "set_steering_mode",
        mode: "all",
      }));
    }
    // Send initial prompt via RPC command. A resumed child already carries the
    // original task inside its loaded session history, so the initial prompt
    // becomes the resume directive instead of a re-send of the task text.
    if (child.stdin && params.task) {
      const initialLeaseToken = typeof options.initialLeaseToken === "function"
        ? options.initialLeaseToken(correlationId)
        : options.initialLeaseToken;
      sendRpcMessage(
        child.stdin,
        options.resumePrompt ?? params.task,
        "prompt",
        initialLeaseToken,
      );
    }

    // Identity publication is observational only. Request/control envelopes
    // and unknown lifecycle events remain replay-risking until explicitly
    // proven side-effect free.
    if (useIpc) {
      bindChildIpcRelay(child, correlationId, options, (message) => {
        state.receivedFirstActivity = true;
        const compactionEvent = childCompactionStateEvent(message);
        if (compactionEvent) {
          handleChildCompactionState(compactionEvent);
          return;
        }
        if (!isReplayNeutralChildIpcMessage(message)) state.externalReplayRisk = true;
      });
    }

    // Report initial progress
    options.onProgress?.(progress);

    const termination = createChildTerminationController(child);
    void termination.outcome.then((outcome) => {
      options.onReclamationOutcome?.(correlationId, outcome);
    });

    // Handle abort signal
    const unbindTerminationSignal = bindChildTerminationSignal(termination, options.signal);

    // Timeout handling
    const timers: AttemptTimers = {};
    // Cleared handles are deliberately left assigned: armResultReadyGrace()
    // treats a non-empty handle as "this window was already used".
    const clearAllTimers = (): void => {
      if (timers.firstActivity) clearTimeout(timers.firstActivity);
      if (timers.resultReadyGrace) clearTimeout(timers.resultReadyGrace);
      if (timers.outputLimitRecovery) clearTimeout(timers.outputLimitRecovery);
      if (timers.compactionRecovery) clearTimeout(timers.compactionRecovery);
      if (timers.interruptingSteer) clearTimeout(timers.interruptingSteer);
      if (timers.structuredOutputRecovery) clearTimeout(timers.structuredOutputRecovery);
      if (timers.modelSwitch) clearTimeout(timers.modelSwitch);
      if (timers.toolHeartbeat) clearInterval(timers.toolHeartbeat);
    };

    /**
     * Start or stop the in-flight tool heartbeat. A long-running tool call
     * (bash script, observe wait, …) emits no further child events until it
     * completes; the heartbeat republishes progress so the parent's stall
     * clock keeps seeing activity. Idempotent — call after every tool
     * start/completion event and on any boundary that ends tool execution.
     */
    const syncToolHeartbeat = (): void => {
      const inFlight = !state.terminal && !state.turnLifecycleSettled && state.inFlightToolCount > 0;
      if (inFlight) {
        if (!timers.toolHeartbeat) {
          timers.toolHeartbeat = setInterval(() => {
            if (state.terminal || state.turnLifecycleSettled || state.inFlightToolCount === 0) {
              syncToolHeartbeat();
              return;
            }
            progress.lastActivityAt = Date.now();
            options.onProgress?.(progress);
          }, options.toolExecutionHeartbeatMs ?? TOOL_EXECUTION_HEARTBEAT_MS);
          timers.toolHeartbeat.unref?.();
        }
        return;
      }
      if (timers.toolHeartbeat) {
        clearInterval(timers.toolHeartbeat);
        timers.toolHeartbeat = undefined;
      }
    };
    timers.firstActivity = setTimeout(() => {
      if (state.initialResultPublished || state.receivedFirstActivity) return;
      const message =
        `Timed out waiting for the first child agent event `
        + `(agent=${params.agent}, model=${state.resolvedModel || "unknown"}, correlationId=${correlationId}, `
        + `phase=first-activity); the child process started but did not report model activity.`;
      state.lastContent = message;
      state.runtimeFailure = message;
      appendBoundedTranscriptMessage(messages, { role: "system", content: message });
      progress.status = "failed";
      progress.durationMs = Date.now() - startTime;
      progress.lastMessage = message;
      options.onProgress?.(progress);
      termination.terminate();
    }, options.firstActivityTimeoutMs ?? FIRST_ACTIVITY_TIMEOUT_MS);

    // Parse JSON lines from stdout
    const stdoutLines = createUtf8LineDecoder();
    const processStdoutLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) {
        state.receivedFirstActivity = true;
        state.externalReplayRisk = true;
        if (timers.firstActivity) clearTimeout(timers.firstActivity);
        return;
      }
      try {
        const event = JSON.parse(trimmed) as JsonLineEvent;
        processEvent(event);
      } catch {
        state.receivedFirstActivity = true;
        state.externalReplayRisk = true;
        state.stdoutProtocolViolation = true;
        if (timers.firstActivity) clearTimeout(timers.firstActivity);
        state.lastContent = appendUtf8Tail(
          state.lastContent,
          trimmed + "\n",
          EXECUTION_BUFFER_LIMITS.streamBytes,
        );
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      pokeLifecycleDeadline();
      for (const line of stdoutLines.write(chunk)) processStdoutLine(line);
    });

    const clearInterrupt = (): PendingInterrupt | undefined => {
      const pending = pendingInterrupt;
      pendingInterrupt = undefined;
      if (timers.interruptingSteer) {
        clearTimeout(timers.interruptingSteer);
        timers.interruptingSteer = undefined;
      }
      return pending;
    };

    const markSteerTurnSettledDuringAbort = (): void => {
      if (pendingInterrupt?.phase === "aborting") {
        pendingInterrupt.turnSettledDuringAbort = true;
      }
    };

    /**
     * Settle the steer transaction as a task failure. Reserved for outcomes
     * where the turn was already interrupted (acknowledged abort) or the
     * child is gone, so the original work cannot continue either way.
     */
    const failInterruptingSteer = (reason: string): void => {
      if (!pendingInterruptingSteer || state.terminal || state.turnLifecycleSettled) return;
      clearInterruptingSteer();
      const diagnostic =
        `Failed to interrupt and steer teammate (agent=${params.agent}, correlationId=${correlationId}): ${reason}`;
      state.runtimeFailure = diagnostic;
      appendBoundedTranscriptMessage(messages, { role: "system", content: diagnostic });
      completeTurn(readStructuredOutput(true), true, 1);
    };

    /**
     * A control-plane failure must not masquerade as a task failure. When the
     * abort was never acknowledged (timeout) or Pi rejected it, the running
     * turn is untouched: killing the child and settling exitCode=1 turned one
     * undelivered interruption into a failed task and — through graph
     * dependencies — into a cascading failure of every downstream dependent.
     * Requeue the correction as a non-interrupting follow_up, surface the
     * control error in the transcript and progress, and let the task run on.
     */
    const degradeInterruptingSteerToFollowUp = (reason: string): void => {
      if (!pendingInterruptingSteer || state.terminal || state.turnLifecycleSettled) return;
      const pending = clearInterruptingSteer();
      if (!pending) return;
      const diagnostic =
        `Steer degraded to follow_up (agent=${params.agent}, correlationId=${correlationId}): ${reason}. `
        + "The turn was not interrupted; the correction message was queued and the task continues.";
      appendBoundedTranscriptMessage(messages, { role: "system", content: diagnostic });
      progress.lastMessage = diagnostic;
      options.onProgress?.(progress);
      const leasedMessage = wrapLeasedMessage(pending.message, pending.token);
      if (!child.stdin || !writeTransportModelInput(
        child.stdin,
        { type: "follow_up", message: leasedMessage },
        leasedMessage,
        pending.message,
        "follow_up",
        pending.provenance,
      )) {
        const undelivered =
          `Steer follow_up could not be delivered (agent=${params.agent}, correlationId=${correlationId}): `
          + "the correction message was dropped; the task continues.";
        appendBoundedTranscriptMessage(messages, { role: "system", content: undelivered });
        progress.lastMessage = undelivered;
        options.onProgress?.(progress);
      }
      // A settlement boundary swallowed while the interrupt owned settlement
      // would strand the turn now that the pending state is gone; converge it
      // the way the swallowed boundary would have.
      if (steerSettlementSwallowed) settleAgentSession();
    };

    const armInterruptingSteerTimeout = (): void => {
      if (timers.interruptingSteer) clearTimeout(timers.interruptingSteer);
      if (!pendingInterruptingSteer) {
        timers.interruptingSteer = undefined;
        return;
      }
      timers.interruptingSteer = setTimeout(() => {
        const phase = pendingInterruptingSteer?.phase;
        if (phase === "prompting") {
          failInterruptingSteer(
            `Pi did not start the correction prompt within ${interruptingSteerTimeoutMs}ms`,
          );
        } else {
          degradeInterruptingSteerToFollowUp(
            `Pi did not acknowledge the turn abort within ${interruptingSteerTimeoutMs}ms`,
          );
        }
      }, interruptingSteerTimeoutMs);
      timers.interruptingSteer.unref?.();
    };

    const requestInterruptingSteer = (
      message: string,
      token?: LeaseToken,
      provenance?: MessageProvenanceV1,
    ): boolean => {
      if (!child.stdin || pendingInterruptingSteer || state.modelSwitch || state.terminal || state.turnLifecycleSettled) return false;
      const nonce = randomUUID();
      steerSettlementSwallowed = false;
      pendingInterruptingSteer = {
        abortRequestId: `teammate-steer-abort-${nonce}`,
        promptRequestId: `teammate-steer-prompt-${nonce}`,
        message,
        token,
        provenance,
        phase: "aborting",
      };
      const sent = writeChildStdinLine(child.stdin, JSON.stringify({
        id: pendingInterruptingSteer.abortRequestId,
        type: "abort",
      }));
      if (!sent) {
        pendingInterruptingSteer = undefined;
        return false;
      }
      progress.phase = "continuing";
      progress.resultReadyAt = undefined;
      options.onProgress?.(progress);
      armInterruptingSteerTimeout();
      return true;
    };

    if (child.stdin) {
      interruptingSteerHandlers.set(child.stdin, requestInterruptingSteer);
      options.onChildSpawned?.(child.stdin, (message) => {
        return sendChildIpcMessage(child, message);
      }, sessionDir, correlationId, options.runtimeGeneration);
    }

    function readStructuredOutput(cleanup: boolean): unknown | undefined {
      let structuredOutput: unknown;
      if (outputFile) {
        try {
          const serialized = readRegularTextFile(outputFile);
          if (serialized.trim().length > 0) {
            try {
              const candidate = JSON.parse(serialized);
              const validationFailure = params.outputSchema
                ? describeStructuredOutputValueValidationFailure(candidate, params.outputSchema)
                : undefined;
              if (validationFailure) {
                state.structuredOutputValidationFailure = validationFailure;
              } else {
                structuredOutput = candidate;
              }
            } catch (error) {
              state.structuredOutputValidationFailure =
                `structured_output validation failed: output file is not valid JSON (${error instanceof Error ? error.message : String(error)}).`;
            }
          }
        } catch {
          // The structured_output tool has not persisted a result yet.
        }
        if (cleanup) cleanupFile(outputFile);
      }
      return structuredOutput ?? state.capturedStructuredOutput;
    }

    function completeTurn(
      structuredOutput: unknown,
      terminateChild: boolean,
      exitCode = 0,
      terminalStatus: AgentTerminalStatus = exitCode === 0 ? "completed" : "failed",
    ): void {
      if (state.terminal || state.turnLifecycleSettled) return;
      releaseRetryPersistenceGuard();
      state.turnLifecycleSettled = true;
      progress.status = terminalStatus;
      progress.phase = undefined;
      progress.resultReadyAt = params.outputSchema && exitCode === 0 ? Date.now() : undefined;
      progress.durationMs = Date.now() - startTime;
      if (messages.length === 0 && state.lastContent) {
        appendBoundedTranscriptMessage(messages, { role: "assistant", content: state.lastContent });
      }
      options.onProgress?.(progress);
      clearAllTimers();
      cleanupFile(systemPromptFile);
      if (schemaFile) cleanupFile(schemaFile);
      if (outputFile) cleanupFile(outputFile);

      const turnResult: SingleResult = {
        agent: params.agent,
        name: params.name,
        task: params.task ?? "",
        exitCode,
        messages: [...messages],
        usage: { ...usage },
        model: state.resolvedModel,
        correlationId,
        durationMs: Date.now() - startTime,
        toolCount: progress.toolCount,
        wakeable: !terminateChild,
        structuredOutput,
        attemptedModels: undefined,
        terminalStatus,
      };
      recordAttemptRecovery(turnResult);
      if (terminateChild) attemptReclamations.set(turnResult, termination.outcome);
      recordTerminalTurnEvent(
        terminalStatus,
        state.runtimeFailure ?? turnResult.messages.at(-1)?.content,
      );
      if (!state.initialResultPublished) {
        state.initialResultPublished = true;
        resolve(turnResult);
      }
      try {
        options.onTurnComplete?.(turnResult, terminalStatus);
      } catch {
        // Completion observers must not strand a child after the result has
        // already been published to the caller.
      } finally {
        state.completedInputTokens = Math.max(state.completedInputTokens, progress.inputTokens ?? 0);
        state.completedOutputTokens = Math.max(state.completedOutputTokens, progress.outputTokens ?? 0);
        state.completedCacheReadTokens = Math.max(state.completedCacheReadTokens, progress.cacheReadTokens ?? 0);
        state.completedCacheWriteTokens = Math.max(state.completedCacheWriteTokens, progress.cacheWriteTokens ?? 0);
        releasePublishedTurnHistory(messages, progress, usage);
        state.lastContent = "";
        state.streamingText = "";
        state.stderrBuffer = "";
        state.pendingStructuredOutput = undefined;
        state.capturedStructuredOutput = undefined;
        state.structuredOutputValidationFailure = undefined;
        state.structuredOutputAttemptFailed = false;
        state.reportedRuntimeErrors.clear();
        state.runtimeFailure = undefined;
        state.lastAssistantStopReason = undefined;
        state.outputLimitRecoveryPending = false;
        closeActiveCompactionRecovery();
        state.compactionRecovery = undefined;
        compactionSettlementSwallowed = false;
        resetUsage(pendingMessageUsage);
        if (terminateChild) {
          state.terminal = true;
          termination.terminate();
        }
      }
    }

    function publishResultReady(): void {
      if (state.initialResultPublished) return;
      if (messages.length === 0 && state.lastContent) {
        appendBoundedTranscriptMessage(messages, { role: "assistant", content: state.lastContent });
      }
      clearAllTimers();
      progress.phase = "result-ready";
      if (currentModelInput?.lastMessage) {
        const timestamp = turnEventTimestamp();
        recordCanonicalTurnEvent({
          ...turnEventBase(currentModelInput, timestamp),
          type: "result-ready",
          lastMessage: currentModelInput.lastMessage,
        });
      }
      state.initialResultPublished = true;
      const result = recordAttemptRecovery({
        agent: params.agent,
        name: params.name,
        task: params.task ?? "",
        exitCode: 0,
        messages: [...messages],
        usage: { ...usage },
        model: state.resolvedModel,
        correlationId,
        durationMs: Date.now() - startTime,
        toolCount: progress.toolCount,
        wakeable,
        lifecyclePending: true,
      });
      resolve(result);
    }

    /**
     * A published result never confirms its own lifecycle. Without this
     * deadline, a child that goes silent after its final tool-free turn keeps
     * the agent `running` forever: publishResultReady() has already cleared the
     * absolute run ceiling, and no later event can settle the turn.
     *
     * Publication semantics stay untouched — the result was already handed to
     * the caller; this only bounds how long we wait for agent_settled/close.
     *
     * LC-001: The deadline is activity-aware — stdout/stderr activity resets
     * the window so a child in a legitimate continuation (retry, compaction,
     * streaming) is not killed while still producing output.
     */
    let lifecycleDeadlineActive = false;
    const lifecycleDeadlineMs = (): number =>
      resultReadyGraceMsFor(state.completedToolCount, options.resultReadyGraceMs);
    const lifecycleDeadlineCallback = (): void => {
      timers.resultReadyGrace = undefined;
      lifecycleDeadlineActive = false;
      if (state.terminal || state.turnLifecycleSettled || pendingInterruptingSteer) return;
      appendBoundedTranscriptMessage(messages, {
        role: "system",
        content:
          `Teammate published a result but never confirmed its lifecycle within ${lifecycleDeadlineMs()}ms `
          + `(agent=${params.agent}, correlationId=${correlationId}, expected=agent_settled, `
          + `tools=${progress.toolCount}, turnTools=${state.turnToolCount}, `
          + `inFlightTools=${state.inFlightToolCount}, completedTools=${state.completedToolCount}, `
          + `lastStopReason=${state.lastAssistantStopReason ?? "unknown"}); the child process was terminated.`,
      });
      completeTurn(readStructuredOutput(true), true, 0, "terminated");
    };
    function armLifecycleConfirmationDeadline(): void {
      if (state.terminal || state.turnLifecycleSettled || pendingInterruptingSteer || timers.resultReadyGrace) return;
      lifecycleDeadlineActive = true;
      timers.resultReadyGrace = setTimeout(lifecycleDeadlineCallback, lifecycleDeadlineMs());
      timers.resultReadyGrace.unref?.();
    }
    /** Reset the lifecycle deadline window on observed child activity. */
    function pokeLifecycleDeadline(): void {
      if (!lifecycleDeadlineActive || state.terminal || state.turnLifecycleSettled || pendingInterruptingSteer) return;
      if (timers.resultReadyGrace) clearTimeout(timers.resultReadyGrace);
      timers.resultReadyGrace = setTimeout(lifecycleDeadlineCallback, lifecycleDeadlineMs());
      timers.resultReadyGrace.unref?.();
    }

    function armResultReadyGrace(): void {
      if (pendingInterruptingSteer || timers.resultReadyGrace) return;
      timers.resultReadyGrace = setTimeout(() => {
        timers.resultReadyGrace = undefined;
        if (state.terminal || state.turnLifecycleSettled || pendingInterruptingSteer) return;
        // The result is already consumable; settle with whatever structured
        // output was captured instead of blocking on a missing agent_settled/close.
        const structuredOutput = readStructuredOutput(true);
        if (structuredOutput === undefined) {
          // A corrective continuation is already in flight; the resumed turn
          // has not produced a value yet, so keep waiting for its settlement.
          if (structuredOutputRecoveryActive) return;
          if (startStructuredOutputRecovery()) return;
          appendStructuredOutputFailure();
          appendBoundedTranscriptMessage(messages, {
            role: "system",
            content: STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS.resultReadyGrace,
          });
        }
        completeTurn(structuredOutput, true, structuredOutput === undefined ? 1 : 0);
      }, lifecycleDeadlineMs());
      timers.resultReadyGrace.unref?.();
    }

    function armCompactionRecoveryDeadline(): void {
      if (state.terminal || state.turnLifecycleSettled || timers.compactionRecovery || !state.compactionRecovery) return;
      const deadlineMs = options.outputLimitRecoveryTimeoutMs ?? OUTPUT_LIMIT_RECOVERY_TIMEOUT_MS;
      timers.compactionRecovery = setTimeout(() => {
        timers.compactionRecovery = undefined;
        const recovery = state.compactionRecovery;
        if (!recovery || state.terminal || state.turnLifecycleSettled) return;
        closedCompactionRecoveries.add(compactionRecoveryKey(recovery));
        state.compactionRecovery = undefined;
        compactionSettlementSwallowed = false;
        const diagnostic =
          `Teammate compaction recovery did not continue within ${deadlineMs}ms `
          + `(agent=${params.agent}, correlationId=${correlationId}, recoveryId=${recovery.recoveryId}, phase=${recovery.phase}); `
          + "the stalled recovery was aborted.";
        state.runtimeFailure = diagnostic;
        appendBoundedTranscriptMessage(messages, { role: "system", content: diagnostic });
        completeTurn(readStructuredOutput(true), true, 1);
      }, deadlineMs);
    }

    function handleChildCompactionState(event: ChildCompactionStateEvent): void {
      if (state.terminal || state.turnLifecycleSettled) return;
      if (event.generation < latestCompactionGeneration) return;
      if (event.generation > latestCompactionGeneration) {
        latestCompactionGeneration = event.generation;
        closedCompactionRecoveries.clear();
        if (state.compactionRecovery) {
          state.compactionRecovery = undefined;
          compactionSettlementSwallowed = false;
          if (timers.compactionRecovery) {
            clearTimeout(timers.compactionRecovery);
            timers.compactionRecovery = undefined;
          }
        }
      }

      const eventKey = compactionRecoveryKey(event);
      if (closedCompactionRecoveries.has(eventKey)) return;
      const active = state.compactionRecovery;
      if (active) {
        if (active.generation !== event.generation || active.recoveryId !== event.recoveryId) return;
        const phaseRank = { pending: 0, completed: 1, continuation: 2 } as const;
        if (event.phase !== "failed" && phaseRank[event.phase] < phaseRank[active.phase]) return;
      }
      if (event.phase === "failed") {
        closedCompactionRecoveries.add(eventKey);
        state.compactionRecovery = undefined;
        if (timers.compactionRecovery) {
          clearTimeout(timers.compactionRecovery);
          timers.compactionRecovery = undefined;
        }
        const diagnostic =
          `Teammate compaction recovery failed (agent=${params.agent}, correlationId=${correlationId}, `
          + `recoveryId=${event.recoveryId}): ${event.reason ?? "unknown recovery failure"}`;
        state.runtimeFailure = diagnostic;
        appendBoundedTranscriptMessage(messages, { role: "system", content: diagnostic });
        progress.lastMessage = diagnostic;
        progress.status = "failed";
        progress.phase = "settling";
        options.onProgress?.(progress);
        compactionSettlementSwallowed = false;
        completeTurn(readStructuredOutput(true), true, 1);
        return;
      }
      state.compactionRecovery = {
        recoveryId: event.recoveryId,
        generation: event.generation,
        phase: event.phase,
      };
      progress.status = "running";
      progress.phase = event.phase === "pending" ? "compacting" : "continuing";
      progress.resultReadyAt = undefined;
      options.onProgress?.(progress);
      armCompactionRecoveryDeadline();
    }

    function armOutputLimitRecoveryDeadline(): void {
      if (state.terminal || state.turnLifecycleSettled || pendingInterruptingSteer || timers.outputLimitRecovery) return;
      const deadlineMs = options.outputLimitRecoveryTimeoutMs ?? OUTPUT_LIMIT_RECOVERY_TIMEOUT_MS;
      timers.outputLimitRecovery = setTimeout(() => {
        timers.outputLimitRecovery = undefined;
        if (
          state.terminal
          || state.turnLifecycleSettled
          || pendingInterruptingSteer
          || !state.outputLimitRecoveryPending
        ) return;
        state.outputLimitRecoveryPending = false;
        appendBoundedTranscriptMessage(messages, {
          role: "system",
          content:
            `Teammate output-limit recovery did not continue within ${deadlineMs}ms `
            + `(agent=${params.agent}, correlationId=${correlationId}); the partial response was not accepted as success.`,
        });
        completeTurn(readStructuredOutput(true), true, 1);
      }, deadlineMs);
    }

    /**
     * Bounded corrective continuation for a wakeable child that ended its run
     * without schema-valid structured_output. The child process is still alive
     * at agent_end/agent_settled, so resume it with one RPC prompt and wait for
     * a fresh turn that must submit the value through the structured_output
     * tool. This continues the same process — never a fresh replay — so the
     * side-effect replay fence does not apply. Provider/runtime failures and
     * non-wakeable (fork) children keep the existing immediate-failure
     * settlement. At most one continuation per run; the recovery timer bounds
     * a child that never responds.
     */
    let structuredOutputRecoveryActive = false;
    let structuredOutputRecoveryRequestId: string | undefined;

    function startStructuredOutputRecovery(): boolean {
      if (
        !params.outputSchema
        || !wakeable
        || state.terminal
        || state.turnLifecycleSettled
        || pendingInterruptingSteer
        || structuredOutputRecoveryActive
        || state.runtimeFailure
        // An invalid submission already failed the documented reject-and-correct
        // contract inside the turn; report it instead of prompting a resubmission.
        || state.structuredOutputValidationFailure !== undefined
        // A structured_output tool execution that failed is likewise a rejected
        // attempt the child chose not to correct; never retry it blindly.
        || state.structuredOutputAttemptFailed
        || !child.stdin
      ) return false;
      const nonce = randomUUID();
      structuredOutputRecoveryActive = true;
      structuredOutputRecoveryRequestId = `teammate-structured-output-recovery-${nonce}`;
      const deadlineMs = options.structuredOutputRecoveryTimeoutMs ?? STRUCTURED_OUTPUT_RECOVERY_TIMEOUT_MS;
      const diagnostic =
        `Teammate completed without schema-valid structured_output; issued a bounded corrective prompt `
        + `(agent=${params.agent}, correlationId=${correlationId}, timeoutMs=${deadlineMs}).`;
      appendBoundedTranscriptMessage(messages, { role: "system", content: diagnostic });
      progress.lastMessage = diagnostic;
      progress.status = "running";
      progress.phase = "continuing";
      progress.resultReadyAt = undefined;
      options.onProgress?.(progress);
      timers.structuredOutputRecovery = setTimeout(() => {
        timers.structuredOutputRecovery = undefined;
        if (!structuredOutputRecoveryActive || state.terminal || state.turnLifecycleSettled) return;
        structuredOutputRecoveryActive = false;
        structuredOutputRecoveryRequestId = undefined;
        appendStructuredOutputFailure();
        appendBoundedTranscriptMessage(messages, {
          role: "system",
          content:
            "The teammate did not submit schema-valid structured_output after the corrective prompt.",
        });
        completeTurn(readStructuredOutput(true), true, 1);
      }, deadlineMs);
      // Settlement-critical deadline: like outputLimitRecovery, it must keep
      // the event loop alive even when no child handle remains (fake-child
      // tests, detached streams).
      const sent = writeChildStdinLine(child.stdin, JSON.stringify({
        id: structuredOutputRecoveryRequestId,
        type: "prompt",
        message: STRUCTURED_OUTPUT_RECOVERY_PROMPT,
      }));
      if (!sent) {
        structuredOutputRecoveryActive = false;
        structuredOutputRecoveryRequestId = undefined;
        if (timers.structuredOutputRecovery) clearTimeout(timers.structuredOutputRecovery);
        timers.structuredOutputRecovery = undefined;
        return false;
      }
      return true;
    }

    /** Settle the corrective continuation as a failure when Pi rejects the prompt. */
    function failStructuredOutputRecovery(): void {
      if (!structuredOutputRecoveryActive || state.terminal || state.turnLifecycleSettled) return;
      structuredOutputRecoveryActive = false;
      structuredOutputRecoveryRequestId = undefined;
      if (timers.structuredOutputRecovery) clearTimeout(timers.structuredOutputRecovery);
      timers.structuredOutputRecovery = undefined;
      appendStructuredOutputFailure();
      appendBoundedTranscriptMessage(messages, {
        role: "system",
        content: STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS.agentEnd,
      });
      completeTurn(readStructuredOutput(true), true, 1);
    }

    function appendStructuredOutputFailure(): void {
      if (!state.structuredOutputValidationFailure) return;
      if (!messages.some((message) => message.content === state.structuredOutputValidationFailure)) {
        appendBoundedTranscriptMessage(messages, {
          role: "system",
          content: state.structuredOutputValidationFailure,
        });
      }
    }

    function recordRuntimeEventError(event: JsonLineEvent, phase: string): void {
      const error = extractPiEventError(event);
      if (!error) return;
      if (pendingInterruptingSteer && /\babort(?:ed)?\b/i.test(error)) return;
      // A recurring runtime error that survived a turn boundary (runtimeFailure
      // was cleared by onTurnBoundary but the error text persists in
      // reportedRuntimeErrors across the settled turn) must re-set the failure —
      // otherwise the turn settles as a false success. completeTurn clears the
      // dedup set on settlement, so a surviving entry means the boundary was
      // crossed without a settlement that consumed the prior failure.
      if (state.reportedRuntimeErrors.has(error) && state.runtimeFailure === undefined) {
        const model = typeof (event.message as Record<string, unknown> | undefined)?.model === "string"
          ? (event.message as Record<string, unknown>).model as string
          : typeof event.model === "string"
            ? event.model
            : state.resolvedModel;
        const recurring =
          `Teammate runtime error (phase=${phase}, agent=${params.agent}, model=${model || "unknown"}, `
          + `correlationId=${correlationId}): ${error} [recurred across turn boundary]`;
        appendBoundedTranscriptMessage(messages, { role: "system", content: recurring });
        state.runtimeFailure = recurring;
        progress.lastMessage = recurring;
        options.onProgress?.(progress);
        return;
      }
      if (state.reportedRuntimeErrors.has(error)) return;
      state.reportedRuntimeErrors.add(error);
      const message = event.message as Record<string, unknown> | undefined;
      const model = typeof message?.model === "string"
        ? message.model
        : typeof event.model === "string"
          ? event.model
          : state.resolvedModel;
      const diagnostic =
        `Teammate runtime error (phase=${phase}, agent=${params.agent}, model=${model || "unknown"}, `
        + `correlationId=${correlationId}): ${error}`;
      appendBoundedTranscriptMessage(messages, { role: "system", content: diagnostic });
      state.runtimeFailure = diagnostic;
      progress.lastMessage = diagnostic;
      options.onProgress?.(progress);
    }

    // --- Per-event handlers -------------------------------------------------
    // Each handler owns exactly one event family and only mutates `state`,
    // `progress`, `messages` and `usage`. processEvent() below routes to them
    // through EVENT_HANDLERS after applying the shared pre-dispatch bookkeeping.

    /** A new agent loop starts: the previous turn's settlement no longer applies. */
    function onTurnBoundary(event: JsonLineEvent): void {
      if (pendingInterruptingSteer?.phase === "aborting" && pendingInterruptingSteer.turnSettledDuringAbort) {
        degradeInterruptingSteerToFollowUp("turn advanced before abort was acknowledged");
      }
      if (pendingInterruptingSteer?.phase === "prompting") {
        pendingInterruptingSteer = undefined;
        if (timers.interruptingSteer) {
          clearTimeout(timers.interruptingSteer);
          timers.interruptingSteer = undefined;
        }
      }
      if (state.outputLimitRecoveryPending) {
        state.outputLimitRecoveryPending = false;
        if (timers.outputLimitRecovery) {
          clearTimeout(timers.outputLimitRecovery);
          timers.outputLimitRecovery = undefined;
        }
      }
      if (state.compactionRecovery) {
        closeActiveCompactionRecovery();
        state.compactionRecovery = undefined;
        compactionSettlementSwallowed = false;
        if (timers.compactionRecovery) {
          clearTimeout(timers.compactionRecovery);
          timers.compactionRecovery = undefined;
        }
      }
      if (timers.resultReadyGrace) {
        clearTimeout(timers.resultReadyGrace);
        timers.resultReadyGrace = undefined;
      }
      if (timers.outputLimitRecovery) {
        clearTimeout(timers.outputLimitRecovery);
        timers.outputLimitRecovery = undefined;
      }
      state.turnLifecycleSettled = false;
      // The new turn acknowledges the resume prompt after a model switch;
      // a stale id must not match a later response.
      state.modelSwitchResumeRequestId = undefined;
      state.lastAssistantStopReason = undefined;
      state.runtimeFailure = undefined;
      progress.status = "running";
      progress.phase = "prompting";
      progress.resultReadyAt = undefined;
      progress.recentTools = [];
      state.turnToolCount = 0;
      // A new turn means the previous turn's tools all completed; drop any
      // stale counter so the in-flight heartbeat cannot leak across turns.
      state.inFlightToolCount = 0;
      state.pendingStructuredOutput = undefined;
      state.capturedStructuredOutput = undefined;
      state.structuredOutputValidationFailure = undefined;
      state.structuredOutputAttemptFailed = false;
      if (event.type === "agent_start" && currentModelInput?.eventsEmitted) {
        currentModelInput.loopSeq += 1;
        currentModelInput.eventsEmitted = false;
      }
      if ((event.type === "agent_start" || event.type === "turn_start")
        && currentModelInput
        && !currentModelInput.eventsEmitted) {
        const timestamp = turnEventTimestamp();
        recordCanonicalTurnEvent({
          ...turnEventBase(currentModelInput, timestamp),
          type: "turn-started",
          phase: "prompting",
        });
        currentModelInput.eventsEmitted = true;
      }
      options.onProgress?.(progress);
    }

    /** Relay a child extension's UI request, or decline it when nobody listens. */
    function onExtensionUiRequest(event: JsonLineEvent): void {
      const request = {
        ...event,
        type: "teammate_rpc_ui_request",
        correlationId,
      };
      const respond = (response: unknown) => {
        if (!child.stdin) return;
        writeChildStdinLine(child.stdin, JSON.stringify(response));
      };
      if (options.onChildRequest) options.onChildRequest(request, respond);
      else if (typeof event.id === "string") {
        respond({ type: "extension_ui_response", id: event.id, cancelled: true });
      }
    }

    function recordResolvedModel(event: JsonLineEvent, msg: Record<string, unknown> | undefined): void {
      const modelId = typeof msg?.model === "string" ? msg.model : event.model;
      const provider = typeof msg?.provider === "string" ? msg.provider : event.provider;
      const capabilities = options.modelCapabilities ?? [];
      let reference = modelId;
      if (typeof modelId === "string" && typeof provider === "string") {
        const qualified = `${provider}/${modelId}`;
        reference = capabilities.some((candidate) => candidate.id === qualified)
          || !capabilities.some((candidate) => candidate.id === modelId)
          ? qualified
          : modelId;
      }
      // Runtime events usually report a bare model id without a provider. Upgrade
      // it to the canonical provider/model id when exactly one capability matches,
      // so status comparisons are not fooled by id formatting. Ambiguous or
      // unknown ids are left untouched (this never throws).
      if (typeof reference === "string" && !reference.includes("/")) {
        const matches = capabilities
          .map((candidate) => candidate.id)
          .filter((candidate) => candidate.endsWith(`/${reference}`));
        if (matches.length === 1) reference = matches[0];
      }
      if (!reference) return;
      state.resolvedModel = reference;
      progress.resolvedModel = reference;
    }

    function onMessageEnd(event: JsonLineEvent): void {
      const msg = event.message as Record<string, unknown> | undefined;
      if (msg?.role !== "user") {
        onAssistantMessage(event);
        return;
      }
      const text = extractTextContent(event);
      const pendingIndex = text === undefined
        ? -1
        : pendingModelInputs.findIndex((input) =>
            input.committed && input.acceptedMessage === text
          );
      if (pendingIndex >= 0) {
        const input = pendingModelInputs.splice(pendingIndex, 1)[0]!;
        currentModelInput = input;
        const timestamp = turnEventTimestamp();
        input.lastMessage = {
          role: "user",
          timestamp,
          provenance: input.context.trigger,
        };
        if (!input.initial || options.emitInitialTurnTrigger !== false) {
          recordCanonicalTurnEvent({
            ...turnEventBase(input, timestamp),
            type: "trigger-accepted",
          });
        }
        recordCanonicalTurnEvent({
          ...turnEventBase(input, timestamp),
          type: "turn-started",
          phase: "prompting",
        });
        input.eventsEmitted = true;
        options.onProgress?.(progress);
        return;
      }

      // Pi-created inputs continue the accepted logical turn without acquiring
      // sender identity. They can advance only its low-level loop sequence.
      if (currentModelInput) {
        currentModelInput.loopSeq += 1;
        currentModelInput.eventsEmitted = false;
      } else {
        for (const pending of pendingModelInputs) pending.loopSeq += 1;
      }
    }

    /** A completed assistant message: transcript, usage and resolved model. */
    function onAssistantMessage(event: JsonLineEvent): void {
      const msg = event.message as Record<string, unknown> | undefined;
      if (event.type === "message_end" && msg?.role !== "assistant") return;
      if (currentModelInput) {
        const timestamp = turnEventTimestamp();
        currentModelInput.lastMessage = {
          role: "assistant",
          timestamp,
          provenance: unknownMessageProvenanceV1({ messageKind: "message" }),
        };
      }
      const text = extractTextContent(event) || state.streamingText || undefined;
      if (text) {
        state.lastContent = text;
        state.streamingText = "";
        appendDistinctAssistantMessage(messages, text);
        progress.lastMessage = text;
      }
      const messageUsage = (msg?.usage as Record<string, unknown> | undefined)
        ?? (event.usage as Record<string, unknown> | undefined);
      if (messageUsage) {
        addUsageSnapshot(usage, messageUsage);
        resetUsage(pendingMessageUsage);
        usage.turns += 1;
        updateProgressUsage();
      }
      recordResolvedModel(event, msg);
      recordRuntimeEventError(event, event.type);
      options.onProgress?.(progress);
    }

    /** Streaming deltas and in-flight usage snapshots. */
    function onMessageUpdate(event: JsonLineEvent): void {
      const ame = event.assistantMessageEvent as Record<string, unknown> | undefined;
      const deltaType = ame?.type as string | undefined;
      let progressChanged = false;

      if (deltaType === "text_delta") {
        const delta = ame?.delta as string | undefined;
        if (delta) {
          state.streamingText = appendUtf8Tail(
            state.streamingText,
            delta,
            EXECUTION_BUFFER_LIMITS.streamBytes,
          );
          progress.lastMessage = state.streamingText;
          progressChanged = true;
        }
      } else if (deltaType === "text_start") {
        state.streamingText = "";
      }
      // Ignore thinking_delta, thinking_start, etc.

      // Pi 0.84 dropped the cumulative `message` (and `assistantMessageEvent.partial`)
      // fields from JSON/RPC message_update events — only assistantMessageEvent
      // deltas remain. Reading `event.message.usage` is kept defensively for 0.83
      // hosts (it is undefined on 0.84); in-flight usage on 0.84 arrives via the
      // dedicated `usage` event (onUsageSnapshot) and settles at `message_end`
      // (onAssistantMessage), so usage totals are unaffected.
      const msg = event.message as Record<string, unknown> | undefined;
      const msgUsage = msg?.usage as Record<string, unknown> | undefined;
      if (msgUsage) {
        setUsageSnapshot(pendingMessageUsage, msgUsage);
        updateProgressUsage();
        progressChanged = true;
      }
      if (progressChanged) options.onProgress?.(progress);
    }

    function onToolStart(event: JsonLineEvent): void {
      const toolName = truncateUtf8Tail(
        (event.toolName as string) ?? (event.name as string) ?? "unknown",
        EXECUTION_BUFFER_LIMITS.toolNameBytes,
      );
      const argsPreview = previewToolCallArgs(event.args, toolName);
      progress.recentTools.push(argsPreview === undefined
        ? { name: toolName, status: "running" }
        : { name: toolName, status: "running", argsPreview });
      state.inFlightToolCount += 1;
      progress.phase = "tool-execution";
      if (progress.recentTools.length > EXECUTION_BUFFER_LIMITS.toolItems) {
        progress.recentTools.splice(
          0,
          progress.recentTools.length - EXECUTION_BUFFER_LIMITS.toolItems,
        );
      }
      options.onProgress?.(progress);
      syncToolHeartbeat();
    }

    /**
     * A finished tool call. A successful `structured_output` call is itself a
     * terminal result — settle the turn without waiting for agent_end.
     */
    function onToolCompleted(event: JsonLineEvent): void {
      if (event.content) {
        appendBoundedTranscriptMessage(messages, { role: "tool", content: event.content });
      }
      progress.toolCount += 1;
      state.turnToolCount += 1;
      state.completedToolCount += 1;
      state.inFlightToolCount = Math.max(0, state.inFlightToolCount - 1);
      if (state.inFlightToolCount === 0 && progress.phase === "tool-execution") {
        // The next silent interval belongs to model continuation, not to the
        // completed tool. This selects the model-phase stall window while the
        // child waits for its next provider event.
        progress.phase = "continuing";
      }
      const lastTool = progress.recentTools[progress.recentTools.length - 1];
      if (lastTool && lastTool.status === "running") {
        lastTool.status = "completed";
      }
      syncToolHeartbeat();
      if (pendingInterruptingSteer) {
        state.pendingStructuredOutput = undefined;
        progress.phase = "continuing";
        progress.resultReadyAt = undefined;
        options.onProgress?.(progress);
        return;
      }
      options.onProgress?.(progress);
      const completedTool = (event.toolName as string | undefined)
        ?? (event.name as string | undefined)
        ?? lastTool?.name;
      if (
        event.type === "tool_execution_end"
        && completedTool === "structured_output"
      ) {
        const pending = state.pendingStructuredOutput;
        const completedToolCallId = typeof event.toolCallId === "string"
          ? event.toolCallId
          : typeof event.id === "string"
            ? event.id
            : undefined;
        const idsMatch = !pending?.toolCallId
          || !completedToolCallId
          || pending.toolCallId === completedToolCallId;
        if (event.isError !== true && pending && idsMatch) {
          state.capturedStructuredOutput = pending.value;
        } else if (event.isError === true && idsMatch) {
          state.pendingStructuredOutput = undefined;
          state.structuredOutputAttemptFailed = true;
        }
        const structuredOutput = readStructuredOutput(false);
        if (event.isError !== true && structuredOutput !== undefined) {
          completeTurn(structuredOutput, true);
        }
      }
    }

    function onUsageSnapshot(event: JsonLineEvent): void {
      if (event.usage) {
        setUsageSnapshot(pendingMessageUsage, event.usage as Record<string, unknown>);
        updateProgressUsage();
        options.onProgress?.(progress);
      }
    }

    /**
     * A result-ready turn publishes a consumable result but never settles the
     * lifecycle here: the child is neither killed nor parked. Only agent_end,
     * close, error or the armed deadline may converge the lifecycle.
     */
    function onTurnEnd(event: JsonLineEvent): void {
      if (pendingInterruptingSteer) {
        progress.phase = "continuing";
        progress.resultReadyAt = undefined;
        options.onProgress?.(progress);
        return;
      }
      const msg = event.message as Record<string, unknown> | undefined;
      if (msg?.role === "assistant") {
        if (typeof msg.stopReason === "string") state.lastAssistantStopReason = msg.stopReason;
        const text = extractTextContent({ type: "turn_end", message: msg });
        if (text && appendDistinctAssistantMessage(messages, text)) {
          state.lastContent = text;
          progress.lastMessage = text;
        }
      }
      recordResolvedModel(event, msg);
      recordRuntimeEventError(event, "turn_end");
      if (currentModelInput) {
        if (!currentModelInput.lastMessage || currentModelInput.lastMessage.role !== "assistant") {
          const timestamp = turnEventTimestamp();
          currentModelInput.lastMessage = {
            role: "assistant",
            timestamp,
            provenance: unknownMessageProvenanceV1({ messageKind: "message" }),
          };
        }
        const timestamp = turnEventTimestamp();
        recordCanonicalTurnEvent({
          ...turnEventBase(currentModelInput, timestamp),
          type: "turn-ended",
          lastMessage: currentModelInput.lastMessage,
        });
      }
      if (isPiResultReadyTurn(event, {
        inFlightToolCount: state.inFlightToolCount,
        completedToolCount: state.completedToolCount,
      })) {
        options.onProgress?.(progress);
        if (!params.outputSchema) {
          progress.resultReadyAt = Date.now();
          options.onProgress?.(progress);
          publishResultReady();
          // Symmetric with the schema lane: the result is consumable, but
          // the lifecycle still needs a bounded confirmation window.
          armLifecycleConfirmationDeadline();
        } else {
          // Text alone is not consumable for schema runs. Keep resultReadyAt
          // hidden until structured_output is captured and bound recovery with
          // the same completed-tool-aware lifecycle grace as the text lane.
          progress.resultReadyAt = undefined;
          armResultReadyGrace();
        }
      }
    }

    /**
     * Start an in-process model switch transaction. Asks the decision hook for
     * the next model, then sends the child's `set_model` RPC command and waits
     * for Pi's acknowledgement. On success the model is swapped in place and
     * the same session continues; the ack response also carries the switch
     * outcome so a rejected command settles the original failure.
     */
    function startModelSwitch(failure: string, previousModel?: string): void {
      const stdin = child.stdin;
      void Promise.resolve(options.onModelFailover!(failure, previousModel)).then((targetModel) => {
        if (targetModel === undefined || state.terminal || state.turnLifecycleSettled) {
          settleAsFailed();
          return;
        }
        const slash = targetModel.indexOf("/");
        if (slash <= 0) {
          appendBoundedTranscriptMessage(messages, {
            role: "system",
            content:
              `Model failover hook returned an invalid model id "${targetModel}"; `
              + "settling the original failure instead of hot-swapping.",
          });
          settleAsFailed();
          return;
        }
        const requestId = `teammate-model-switch-${randomUUID()}`;
        state.modelSwitch = { requestId, targetModel, acknowledged: false };
        progress.phase = "continuing";
        progress.lastMessage = `Model failover: switching ${state.resolvedModel} -> ${targetModel}`;
        options.onProgress?.(progress);
        const sent = stdin !== null
          && writeChildStdinLine(stdin, JSON.stringify({
            id: requestId,
            type: "set_model",
            provider: targetModel.slice(0, slash),
            modelId: targetModel.slice(slash + 1),
          }));
        if (!sent) {
          state.modelSwitch = undefined;
          settleAsFailed();
          return;
        }
        timers.modelSwitch = setTimeout(() => {
          timers.modelSwitch = undefined;
          const pending = state.modelSwitch;
          if (!pending || pending.requestId !== requestId || state.terminal) return;
          state.modelSwitch = undefined;
          appendBoundedTranscriptMessage(messages, {
            role: "system",
            content:
              `Pi did not acknowledge the in-process model switch to ${targetModel} `
              + "within the failover deadline; settling the original failure.",
          });
          settleAsFailed();
        }, MODEL_SWITCH_ACK_TIMEOUT_MS);
        timers.modelSwitch.unref?.();
      }).catch((error) => {
        // The decision hook rejected or threw: settle the original failure
        // instead of leaving the turn stranded with no settlement path.
        if (state.terminal || state.turnLifecycleSettled) return;
        appendBoundedTranscriptMessage(messages, {
          role: "system",
          content:
            `Model failover hook failed: ${error instanceof Error ? error.message : String(error)}; `
            + "settling the original failure.",
        });
        settleAsFailed();
      });
    }

    /** Settle the turn as a failure after an aborted or rejected model switch. */
    function settleAsFailed(): void {
      if (state.turnLifecycleSettled || state.terminal) return;
      // A switch that never reached its ack (rejected set_model, timeout,
      // dead stdin) never ran under the target model. Tell the host so it can
      // release the trial acquisition instead of charging a phantom failure.
      const pendingSwitch = state.modelSwitch;
      if (pendingSwitch !== undefined && !pendingSwitch.acknowledged) {
        state.modelSwitch = undefined;
        options.onChildEvent?.({
          type: "teammate_model_switch_abandoned",
          correlationId,
          model: pendingSwitch.targetModel,
        });
      }
      const structuredOutput = readStructuredOutput(true);
      completeTurn(structuredOutput, true, 1);
    }

    /** Finalize the current run after Pi confirms no retry, compaction, or queued continuation remains. */
    function settleAgentSession(): void {
      if (state.compactionRecovery) {
        compactionSettlementSwallowed = true;
        progress.status = "running";
        progress.phase = state.compactionRecovery.phase === "pending" ? "compacting" : "continuing";
        progress.resultReadyAt = undefined;
        options.onProgress?.(progress);
        armCompactionRecoveryDeadline();
        return;
      }
      const structuredOutput = readStructuredOutput(false);
      if (params.outputSchema && structuredOutput === undefined) {
        // A corrective continuation is already in flight; wait for the resumed
        // turn instead of settling the run while it is still pending.
        if (structuredOutputRecoveryActive) return;
        if (startStructuredOutputRecovery()) return;
        appendStructuredOutputFailure();
        appendBoundedTranscriptMessage(messages, {
          role: "system",
          content: STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS.agentEnd,
        });
        completeTurn(undefined, true, 1);
        return;
      }
      const exitCode = state.runtimeFailure ? 1 : 0;
      // In-process model failover: when the turn failed with a retryable
      // provider error, the child runtime is still alive (wakeable), and a
      // model-switch decision is available, hot-swap the model over the live
      // RPC channel instead of settling the failure. The same session
      // continues under the new model, so completed tools are never replayed.
      if (
        exitCode !== 0
        && wakeable
        && state.runtimeFailure !== undefined
        && !state.terminal
        && !state.modelSwitch
        && !pendingInterruptingSteer
        && child.stdin !== null
        && child.stdin.writable
        && options.onModelFailover !== undefined
        && isFallbackProviderError(state.runtimeFailure)
      ) {
        void startModelSwitch(state.runtimeFailure, state.switchedModel);
        return;
      }
      completeTurn(structuredOutput, !wakeable || exitCode !== 0, exitCode);
      // Process stays alive. Idle agents must be resumed with an RPC prompt;
      // steer/follow_up only queue while an agent loop is already running.
    }

    /**
     * `agent_end` closes one low-level loop. AgentSession may still retry,
     * compact, or drain a queued continuation, so current RPC streams settle
     * only on `agent_settled`. Streams without `willRetry` are legacy Pi
     * versions and retain the former agent_end settlement behavior.
     */
    function onAgentEnd(event: JsonLineEvent): void {
      recordRuntimeEventError(event, "agent_end");
      if (pendingInterruptingSteer) {
        // Legacy streams without willRetry settle here; remember the boundary
        // so a degraded steer can converge the turn it would have settled.
        if (typeof event.willRetry !== "boolean") steerSettlementSwallowed = true;
        progress.status = "running";
        progress.phase = "continuing";
        progress.resultReadyAt = undefined;
        options.onProgress?.(progress);
        return;
      }
      const eventMessages = Array.isArray(event.messages) ? event.messages : [];
      let stopReason = state.lastAssistantStopReason;
      for (let index = eventMessages.length - 1; index >= 0; index -= 1) {
        const message = eventMessages[index];
        if (!message || typeof message !== "object" || (message as Record<string, unknown>).role !== "assistant") continue;
        const candidate = (message as Record<string, unknown>).stopReason;
        if (typeof candidate === "string") stopReason = candidate;
        break;
      }
      state.lastAssistantStopReason = stopReason;
      if (currentModelInput) {
        const timestamp = turnEventTimestamp();
        recordCanonicalTurnEvent({
          ...turnEventBase(currentModelInput, timestamp),
          type: "agent-ended",
          ...(currentModelInput.lastMessage === undefined ? {} : { lastMessage: currentModelInput.lastMessage }),
        });
      }
      if (stopReason === "length") {
        state.outputLimitRecoveryPending = true;
        progress.status = "running";
        progress.phase = "continuing";
        progress.resultReadyAt = undefined;
        options.onProgress?.(progress);
        armOutputLimitRecoveryDeadline();
        return;
      }
      progress.phase = "settling";
      options.onProgress?.(progress);
      if (typeof event.willRetry !== "boolean") {
        state.settlementCapability = "legacy";
        settleAgentSession();
      }
    }

    /** Pi's authoritative AgentSession idle boundary. */
    function onAgentSettled(): void {
      state.settlementCapability = "agent_settled";
      if (pendingInterruptingSteer) {
        markSteerTurnSettledDuringAbort();
        steerSettlementSwallowed = true;
        progress.status = "running";
        progress.phase = "continuing";
        progress.resultReadyAt = undefined;
        options.onProgress?.(progress);
        return;
      }
      if (state.outputLimitRecoveryPending) {
        state.outputLimitRecoveryPending = false;
        appendBoundedTranscriptMessage(messages, {
          role: "system",
          content:
            `Teammate output-limit recovery settled without a continuation `
            + `(agent=${params.agent}, correlationId=${correlationId}); the partial response was not accepted as success.`,
        });
        state.runtimeFailure = "output-limit recovery settled without continuation";
        completeTurn(readStructuredOutput(true), true, 1);
        return;
      }
      settleAgentSession();
    }

    function onAutoRetryStart(event: JsonLineEvent): void {
      progress.status = "retrying";
      progress.phase = "retrying";
      const attempt = typeof event.attempt === "number" ? event.attempt : undefined;
      const maxAttempts = typeof event.maxAttempts === "number" ? event.maxAttempts : undefined;
      const errorMessage = typeof event.errorMessage === "string" ? event.errorMessage : undefined;
      progress.lastMessage = [
        attempt === undefined ? "Pi is retrying the provider request" : `Pi retry ${attempt}${maxAttempts ? `/${maxAttempts}` : ""}`,
        errorMessage,
      ].filter(Boolean).join(": ");
      options.onProgress?.(progress);
    }

    function onAutoRetryEnd(event: JsonLineEvent): void {
      progress.status = "running";
      progress.phase = event.success === true ? "continuing" : "settling";
      options.onProgress?.(progress);
    }

    function onCompactionStart(): void {
      progress.status = "running";
      progress.phase = "compacting";
      options.onProgress?.(progress);
    }

    function onCompactionEnd(event: JsonLineEvent): void {
      progress.status = "running";
      progress.phase = event.willRetry === true ? "continuing" : "settling";
      options.onProgress?.(progress);
    }

    function onErrorEvent(event: JsonLineEvent): void {
      recordRuntimeEventError(event, "error");
    }

    function onResponse(event: JsonLineEvent): void {
      if (structuredOutputRecoveryActive && typeof event.id === "string" && event.id === structuredOutputRecoveryRequestId) {
        if (event.success !== true) failStructuredOutputRecovery();
        return;
      }
      const modelSwitch = state.modelSwitch;
      if (modelSwitch && typeof event.id === "string" && event.id === modelSwitch.requestId) {
        if (timers.modelSwitch) {
          clearTimeout(timers.modelSwitch);
          timers.modelSwitch = undefined;
        }
        if (event.success !== true || event.command !== "set_model") {
          state.modelSwitch = undefined;
          appendBoundedTranscriptMessage(messages, {
            role: "system",
            content:
              `Pi rejected the in-process model switch to ${modelSwitch.targetModel}; `
              + "settling the original failure.",
          });
          settleAsFailed();
          return;
        }
        // Model swapped in place. Resume the same session: send the resume
        // directive over the live channel so Pi starts a fresh turn under the
        // new model, then re-arm settlement for that turn.
        modelSwitch.acknowledged = true;
        state.modelSwitch = undefined;
        state.switchedModel = modelSwitch.targetModel;
        state.resolvedModel = modelSwitch.targetModel;
        progress.requestedModel = modelSwitch.targetModel;
        state.turnLifecycleSettled = false;
        state.runtimeFailure = undefined;
        // The deduplication set is turn-scoped in normal flow (cleared by
        // completeTurn's finally) but this failover path never calls
        // completeTurn before resuming. Without clearing it here, the new
        // model reporting the same provider error text (a fleet-wide outage
        // is the common case) would be deduplicated away and the turn would
        // settle as a false success.
        state.reportedRuntimeErrors.clear();
        state.lastAssistantStopReason = undefined;
        state.lastContent = "";
        state.streamingText = "";
        state.outputLimitRecoveryPending = false;
        state.structuredOutputAttemptFailed = false;
        progress.status = "running";
        progress.phase = "continuing";
        progress.resultReadyAt = undefined;
        progress.lastMessage = `Model failover: switched to ${modelSwitch.targetModel}`;
        options.onProgress?.(progress);
        const prompt = options.resumePrompt ?? MODEL_FALLBACK_RESUME_PROMPT;
        const resumeRequestId = `teammate-model-switch-resume-${randomUUID()}`;
        state.modelSwitchResumeRequestId = resumeRequestId;
        const sent = child.stdin !== null && child.stdin.writable
          && writeChildStdinLine(child.stdin, JSON.stringify({
            id: resumeRequestId,
            type: "prompt",
            message: wrapLeasedMessage(prompt, typeof options.initialLeaseToken === "function"
              ? options.initialLeaseToken(correlationId)
              : options.initialLeaseToken),
          }));
        if (!sent) {
          settleAsFailed();
        }
        return;
      }
      // The resume prompt after a successful in-process switch was rejected:
      // the child is alive but refuses the continuation, and no other
      // settlement path exists (modelSwitch was cleared, no steer pending).
      // Settle the turn as a failure instead of stranding it.
      if (
        state.modelSwitchResumeRequestId !== undefined
        && typeof event.id === "string"
        && event.id === state.modelSwitchResumeRequestId
        && event.success !== true
      ) {
        state.modelSwitchResumeRequestId = undefined;
        appendBoundedTranscriptMessage(messages, {
          role: "system",
          content:
            "Pi rejected the resume prompt after the in-process model switch; "
            + "settling the failed turn.",
        });
        settleAsFailed();
        return;
      }
      const pending = pendingInterruptingSteer;
      if (!pending || typeof event.id !== "string") return;
      if (pending.phase === "aborting" && event.id === pending.abortRequestId) {
        if (event.success !== true || event.command !== "abort") {
          // A rejected abort leaves the turn intact; never fail the task for
          // an interruption Pi declined to perform.
          degradeInterruptingSteerToFollowUp("Pi rejected the turn abort command");
          return;
        }
        pending.phase = "prompting";
        armInterruptingSteerTimeout();
        const leasedMessage = wrapLeasedMessage(pending.message, pending.token);
        if (!child.stdin || !writeTransportModelInput(
          child.stdin,
          {
            id: pending.promptRequestId,
            type: "prompt",
            message: leasedMessage,
          },
          leasedMessage,
          pending.message,
          "steer",
          pending.provenance,
        )) {
          failInterruptingSteer("the correction prompt could not be written");
        }
        return;
      }
      if (pending.phase === "prompting" && event.id === pending.promptRequestId && event.success !== true) {
        failInterruptingSteer("Pi rejected the correction prompt");
      }
    }

    /**
     * Event type -> handler. Unlisted types are intentionally inert; keeping the
     * mapping as data makes the full set of recognised events readable at once.
     *
     * A Map, not an object literal: `event.type` is child-supplied, and a plain
     * object would resolve `"toString"` or `"__proto__"` through the prototype
     * chain instead of staying inert.
     */
    const eventHandlers = new Map<string, (event: JsonLineEvent) => void>([
      ["agent_start", onTurnBoundary],
      ["turn_start", onTurnBoundary],
      ["extension_ui_request", onExtensionUiRequest],
      ["message_end", onMessageEnd],
      ["assistant", onAssistantMessage],
      ["message_update", onMessageUpdate],
      ["response", onResponse],
      ["auto_retry_start", onAutoRetryStart],
      ["auto_retry_end", onAutoRetryEnd],
      ["compaction_start", onCompactionStart],
      ["compaction_end", onCompactionEnd],
      ["tool_execution_start", onToolStart],
      ["tool_execution_end", onToolCompleted],
      ["tool_result_end", onToolCompleted],
      ["tool_result", onToolCompleted],
      ["usage", onUsageSnapshot],
      ["turn_end", onTurnEnd],
      ["agent_end", onAgentEnd],
      ["agent_settled", onAgentSettled],
      ["error", onErrorEvent],
    ]);

    function processEvent(event: JsonLineEvent): void {
      if (!state.receivedFirstActivity) {
        state.receivedFirstActivity = true;
        if (timers.firstActivity) clearTimeout(timers.firstActivity);
      }
      // completeTurn() is the authoritative settlement boundary. A child may
      // already have queued tool_result, turn_start, or agent_end lines when
      // termination begins; treating the terminal state as absorbing prevents
      // those buffered lines from reawakening the published agent loop.
      if (state.terminal) return;
      if (state.capturedStructuredOutput === undefined && params.outputSchema) {
        const candidate = extractStructuredOutputCandidate(event, params.outputSchema);
        if (candidate) state.pendingStructuredOutput = candidate;
        state.structuredOutputValidationFailure = describeStructuredOutputValidationFailure(event, params.outputSchema)
          ?? state.structuredOutputValidationFailure;
      }
      // AC8: Update lastActivityAt on every event
      progress.lastActivityAt = Date.now();
      progress.durationMs = Date.now() - startTime;

      eventHandlers.get(event.type)?.(event);
    }

    const stderrDecoder = new StringDecoder("utf8");
    child.stderr?.on("data", (chunk: Buffer) => {
      pokeLifecycleDeadline();
      if (chunk.length > 0) state.externalReplayRisk = true;
      state.stderrBuffer = appendUtf8Tail(
        state.stderrBuffer,
        stderrDecoder.write(chunk),
        EXECUTION_BUFFER_LIMITS.stderrBytes,
      );
    });

    const notifyChildClosed = (code: number | null, signal: NodeJS.Signals | null): void => {
      options.onChildClosed?.(correlationId, options.runtimeGeneration, {
        code,
        signal,
        settled: state.turnLifecycleSettled,
      });
    };

    child.on("close", (code, signal) => {
      releaseRetryPersistenceGuard();
      if (child.stdin) {
        transportSidecars.delete(child.stdin);
        interruptingSteerHandlers.delete(child.stdin);
      }
      clearAllTimers();
      termination.cleanup();
      unbindTerminationSignal();

      cleanupFile(systemPromptFile);

      for (const line of stdoutLines.end()) processStdoutLine(line);
      state.stderrBuffer = appendUtf8Tail(
        state.stderrBuffer,
        stderrDecoder.end(),
        EXECUTION_BUFFER_LIMITS.stderrBytes,
      );

      // A lifecycle event may have been present in the final decoded stdout
      // chunk, or terminal structured output may have initiated this close.
      if (state.turnLifecycleSettled) {
        notifyChildClosed(code, signal);
        return;
      }

      if (pendingInterruptingSteer) {
        const phase = pendingInterruptingSteer.phase;
        pendingInterruptingSteer = undefined;
        const diagnostic =
          `Failed to interrupt and steer teammate (agent=${params.agent}, correlationId=${correlationId}): `
          + (phase === "prompting"
            ? "the child exited before the correction prompt started"
            : "the child exited before acknowledging the turn abort");
        state.runtimeFailure = diagnostic;
        appendBoundedTranscriptMessage(messages, { role: "system", content: diagnostic });
      }

      // A length-truncated turn is waiting for child-local continuation; if
      // the child exits instead, the partial response must not settle as
      // success. This also covers a child that closes before the recovery
      // deadline could fire — close already cleared that timer above.
      if (state.outputLimitRecoveryPending) {
        state.outputLimitRecoveryPending = false;
        appendBoundedTranscriptMessage(messages, {
          role: "system",
          content:
            `Teammate child exited before output-limit recovery could continue `
            + `(agent=${params.agent}, correlationId=${correlationId}); the partial response was not accepted as success.`,
        });
        state.runtimeFailure = "output-limit recovery interrupted by child exit";
      }

      const stderrTail = state.stderrBuffer.trim();
      state.preActivityInfrastructureExit = code !== null
        && code !== 0
        && signal === null
        && !state.receivedFirstActivity
        && !state.runtimeFailure
        && stderrTail.length === 0
        && state.lastContent.trim().length === 0;
      const finalContent = state.lastContent.trim();
      if (finalContent && !messages.some((message) => message.content === finalContent)) {
        appendDistinctAssistantMessage(messages, finalContent);
      }
      let stderrAlreadyReported = false;
      if (messages.length === 0) {
        const content = state.lastContent.trim() || stderrTail || "(no output)";
        stderrAlreadyReported = stderrTail.length > 0 && content === stderrTail;
        appendBoundedTranscriptMessage(messages, { role: "assistant", content });
      }

      // An abnormal exit used to be a bare number: stderr was dropped whenever
      // the child had produced any assistant text, and the signal was ignored.
      if ((code ?? 1) !== 0) {
        const detail = stderrAlreadyReported ? "" : stderrTail;
        appendBoundedTranscriptMessage(messages, {
          role: "system",
          content:
            `Teammate child process exited abnormally (agent=${params.agent}, `
            + `correlationId=${correlationId}, exit=${code ?? "null"}, signal=${signal ?? "none"}, `
            + `elapsed=${Date.now() - startTime}ms, tools=${progress.toolCount}).`
            + (detail ? `\nstderr tail:\n${truncateUtf8Tail(detail, EXECUTION_BUFFER_LIMITS.stderrBytes)}` : ""),
        });
      }

      const status = code === 0 && !state.runtimeFailure ? "completed" : "failed";
      progress.status = status;
      progress.durationMs = Date.now() - startTime;
      const lastMsg = messages[messages.length - 1]?.content;
      if (lastMsg) progress.lastMessage = lastMsg;
      options.onProgress?.(progress);

      // AC6: Read structured output if available
      const structuredOutput = readStructuredOutput(true);
      if (schemaFile) cleanupFile(schemaFile);

      if (state.compactionRecovery && !state.runtimeFailure) {
        const recovery = state.compactionRecovery;
        const diagnostic =
          `Teammate runtime closed before compaction recovery continued `
          + `(agent=${params.agent}, correlationId=${correlationId}, recoveryId=${recovery.recoveryId}, phase=${recovery.phase}).`;
        state.runtimeFailure = diagnostic;
        appendBoundedTranscriptMessage(messages, { role: "system", content: diagnostic });
      }
      const processExitCode = state.runtimeFailure ? 1 : code ?? 1;
      // Non-JSON stdout attributed as assistant content is a protocol violation;
      // a child that emits it must not settle as a clean success (exitCode 0)
      // even if it exits 0 with no runtimeFailure. Otherwise malformed output is
      // attributed as the valid answer (DEF-002 false-success). The violation
      // flag is the authoritative signal — by this point the malformed text has
      // already been appended to messages as assistant content, so checking
      // messages.length would miss the case.
      const protocolViolationExit = state.stdoutProtocolViolation
        && state.runtimeFailure === undefined
        ? 1
        : 0;
      const exitCode = (processExitCode === 0 && params.outputSchema && structuredOutput === undefined)
        || protocolViolationExit === 1
        ? 1
        : processExitCode;
      if (exitCode !== 0 && params.outputSchema && structuredOutput === undefined) {
        appendStructuredOutputFailure();
        appendBoundedTranscriptMessage(messages, {
          role: "system",
          content: STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS.close,
        });
      }

      if (state.initialResultPublished) {
        completeTurn(structuredOutput, true, exitCode);
        notifyChildClosed(code, signal);
        return;
      }

      if (!state.initialResultPublished) {
        const result: SingleResult = {
          agent: params.agent,
          name: params.name,
          task: params.task ?? "",
          exitCode,
          messages,
          usage,
          model: state.resolvedModel,
          correlationId,
          durationMs: Date.now() - startTime,
          toolCount: progress.toolCount,
          wakeable: false,
          structuredOutput,
        };
        recordAttemptRecovery(result);
        state.initialResultPublished = true;
        state.turnLifecycleSettled = true;
        state.terminal = true;
        recordTerminalTurnEvent(
          exitCode === 0 ? "completed" : "failed",
          result.messages.at(-1)?.content,
        );
        resolve(result);
        try {
          options.onTurnComplete?.(result);
        } catch {
          // Completion observers cannot prevent process-close settlement.
        }
      }
      notifyChildClosed(code, signal);
    });

    child.on("error", (error) => {
      releaseRetryPersistenceGuard();
      if (child.stdin) {
        transportSidecars.delete(child.stdin);
        interruptingSteerHandlers.delete(child.stdin);
      }
      clearAllTimers();
      unbindTerminationSignal();

      cleanupFile(systemPromptFile);
      if (schemaFile) cleanupFile(schemaFile);
      if (outputFile) cleanupFile(outputFile);

      progress.status = "failed";
      progress.durationMs = Date.now() - startTime;
      options.onProgress?.(progress);

      const processError =
        `Teammate child process error (agent=${params.agent}, model=${state.resolvedModel || "unknown"}, `
        + `correlationId=${correlationId}, phase=child-error): ${error.message}`;
      if (state.initialResultPublished) {
        appendBoundedTranscriptMessage(messages, {
          role: "system",
          content: processError,
        });
        completeTurn(undefined, true, 1);
        return;
      }

      if (!state.initialResultPublished) {
        const result: SingleResult = {
          agent: params.agent,
          name: params.name,
          task: params.task ?? "",
          exitCode: 1,
          messages: [{
            role: "system",
            content: processError,
          }],
          usage: emptyUsage(),
          model: state.resolvedModel,
          correlationId,
          durationMs: Date.now() - startTime,
          toolCount: progress.toolCount,
          wakeable: false,
        };
        recordAttemptRecovery(result);
        state.initialResultPublished = true;
        state.turnLifecycleSettled = true;
        state.terminal = true;
        recordTerminalTurnEvent("failed", processError);
        resolve(result);
        try {
          options.onTurnComplete?.(result);
        } catch {
          // Completion observers cannot prevent child-error settlement.
        } finally {
          // A logical child-process error is not proof that the OS process has
          // exited. Retain reclamation ownership through the termination
          // controller and publish its bounded outcome separately.
          termination.terminate();
        }
      }
    });
  });
}

export type RpcMessageMode = "prompt" | "steer" | "follow_up" | "abort";

type InterruptingSteerHandler = (
  message: string,
  token?: LeaseToken,
  provenance?: MessageProvenanceV1,
) => boolean;

interface TransportSidecarLease {
  commit(): void;
  cancel(): void;
}

interface TransportSidecar {
  enqueue(
    transportMessage: string,
    acceptedMessage: string,
    mode: "prompt" | "steer" | "follow_up",
    provenance?: MessageProvenanceV1,
  ): TransportSidecarLease;
}

const guardedChildStdinStreams = new WeakSet<Writable>();
const interruptingSteerHandlers = new WeakMap<Writable, InterruptingSteerHandler>();
const transportSidecars = new WeakMap<Writable, TransportSidecar>();

function guardChildStdin(stdin: Writable): void {
  if (guardedChildStdinStreams.has(stdin)) return;
  guardedChildStdinStreams.add(stdin);
  // Child termination is reported by the process lifecycle. Stdin delivery is
  // best-effort, so a concurrent pipe close must not crash the parent process.
  stdin.on("error", () => {});
}

function writeChildStdinLine(stdin: Writable, line: string): boolean {
  guardChildStdin(stdin);
  if (!stdin.writable || stdin.writableEnded || stdin.destroyed) return false;
  try {
    stdin.write(`${line}\n`);
    return true;
  } catch {
    return false;
  }
}

function writeTransportModelInput(
  stdin: Writable,
  envelope: Record<string, unknown>,
  transportMessage: string,
  acceptedMessage: string,
  mode: "prompt" | "steer" | "follow_up",
  provenance?: MessageProvenanceV1,
): boolean {
  const lease = transportSidecars.get(stdin)?.enqueue(
    transportMessage,
    acceptedMessage,
    mode,
    provenance,
  );
  const sent = writeChildStdinLine(stdin, JSON.stringify(envelope));
  if (sent) lease?.commit();
  else lease?.cancel();
  return sent;
}

export function hasRpcTurnSidecar(stdin: Writable): boolean {
  return transportSidecars.has(stdin);
}

export function sendRpcMessage(
  stdin: Writable,
  message: string,
  mode: RpcMessageMode = "follow_up",
  token?: LeaseToken,
  provenance?: MessageProvenanceV1,
): boolean {
  if (mode === "abort") {
    return writeChildStdinLine(stdin, JSON.stringify({ type: "abort" }));
  }
  const leasedMessage = wrapLeasedMessage(message, token);
  if (mode === "prompt") {
    return writeTransportModelInput(
      stdin,
      { type: "prompt", message: leasedMessage },
      leasedMessage,
      message,
      "prompt",
      provenance,
    );
  }
  if (mode === "steer") {
    const interrupt = interruptingSteerHandlers.get(stdin);
    if (interrupt) return interrupt(message, token, provenance);
  }
  return writeTransportModelInput(
    stdin,
    { type: mode, message: leasedMessage },
    leasedMessage,
    message,
    mode,
    provenance,
  );
}

export function sendChildIpcMessage(
  child: ChildProcess,
  message: Record<string, unknown>,
): boolean {
  if (!child.connected) return false;
  try {
    child.send(message as never, (error) => {
      if (!error) return;
      logDiagnosticError(
        `[pi-maestro-teammate] child IPC send failed asynchronously (type=${(message as { type?: string }).type ?? "unknown"})`,
        error,
      );
      try {
        if (child.connected) child.disconnect();
      } catch {
        // Process lifecycle remains the final settlement signal.
      }
    });
    // false means backpressure, not rejection; callback confirms delivery.
    return true;
  } catch {
    try {
      if (child.connected) child.disconnect();
    } catch {
      // Best effort.
    }
    return false;
  }
}

export function dispatchChildIpcMessage(
  message: Record<string, unknown>,
  onRequest: RunTeammateOptions["onChildRequest"],
  onEvent: RunTeammateOptions["onChildEvent"],
  reply: (message: unknown) => void,
): "request" | "event" {
  const requestType = message.type === "teammate_proxy_request"
    || message.type === "teammate_interaction_request"
    || message.type === "teammate_rpc_ui_request";
  if (requestType || message.type === "teammate_proxy_cancel") {
    if (onRequest) {
      try {
        onRequest(message, reply);
      } catch (error) {
        try {
          onEvent?.({
            type: "teammate_reply_delivery_failed",
            requestId: message.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // Child input cannot escape the parent event loop.
        }
      }
    } else {
      onEvent?.(message);
      if (message.type !== "teammate_proxy_cancel") {
        try {
          replyUnhandledChildRequest(message, reply);
        } catch (error) {
          try {
            onEvent?.({
              type: "teammate_reply_delivery_failed",
              requestId: message.requestId,
              error: error instanceof Error ? error.message : String(error),
            });
          } catch {
            // Failed reply remains contained in the child IPC callback.
          }
        }
      }
    }
    return "request";
  }
  onEvent?.(message);
  return "event";
}

function replyUnhandledChildRequest(
  message: Record<string, unknown>,
  reply: (message: unknown) => void,
): void {
  const requestId = typeof message.requestId === "string" ? message.requestId : randomUUID();
  if (message.type === "teammate_interaction_request") {
    const permission = message.interaction === "permission";
    reply({
      type: "teammate_interaction_response",
      requestId,
      result: permission
        ? { action: "deny", reason: "No parent child-request handler is available." }
        : { action: "cancel", reason: "No parent child-request handler is available." },
    });
    return;
  }
  reply({
    type: "teammate_proxy_result",
    requestId,
    result: {
      content: [{ type: "text", text: "No parent child-request handler is available." }],
      isError: true,
    },
  });
}
