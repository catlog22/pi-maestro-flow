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
import { applyModelRouting, type TeammateTaskType } from "../models/model-routing.ts";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import {
  rankModelsByHealth,
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
  classifyRetryError,
  extractRetryAfterMs,
  isFallbackProviderError,
  retryDelayMs,
} from "./retry.ts";
import { buildReplayFence } from "./recovery-protocol.ts";

export * from "./execution-infra.ts";
import {
  EXECUTION_BUFFER_LIMITS,
  FIRST_ACTIVITY_TIMEOUT_MS,
  OUTPUT_LIMIT_RECOVERY_TIMEOUT_MS,
  RESULT_READY_GRACE_MS,
  STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS,
  addUsageSnapshot,
  appendBoundedTranscriptMessage,
  appendDistinctAssistantMessage,
  appendUtf8Tail,
  bindChildTerminationSignal,
  buildModelCandidates,
  buildPiArgs,
  checkDepthGuard,
  cleanupFile,
  correlationSessionDirectoryName,
  createChildTerminationController,
  createProgress,
  createUtf8LineDecoder,
  describeStructuredOutputValidationFailure,
  emptyUsage,
  ensurePrivateDirectory,
  extractPiEventError,
  extractStructuredOutputCandidate,
  extractTextContent,
  findStructuredOutputSchemaHazard,
  getPiSpawnCommand,
  getTeammateDepth,
  getTeammateSessionRoot,
  hasCycle,
  isPiResultReadyTurn,
  normalizeTeammateParams,
  readRegularTextFile,
  releasePublishedTurnHistory,
  resetUsage,
  resolveContainedCwd,
  resolveModelSpecifier,
  resolveVariables,
  resultFailureMessage,
  setUsageSnapshot,
  taskDependencyNames,
  truncateUtf8Tail,
  validateStructuredOutputValue,
  validateTaskReferences,
  waitForRetryDelay,
  writeSchemaFile,
  writeSystemPromptFile,
} from "./execution-infra.ts";
import type {
  JsonLineEvent,
  NormalizedTask,
  RunSingleTeammateParams,
  RunTeammateOptions,
  RunTeammateParams,
  StructuredOutputCandidate,
  TaskOutput,
} from "./execution-infra.ts";

// Failed candidate processes must be physically reclaimed before a fallback
// reuses their correlation identity for a replacement child.
const attemptReclamations = new WeakMap<SingleResult, Promise<unknown>>();

type AttemptSettlementCapability = "agent_settled" | "legacy" | "unknown";

interface AttemptRecoveryFacts {
  settlementCapability: AttemptSettlementCapability;
  completedToolCount: number;
  inFlightToolCount: number;
  /** A non-zero close before any child event, stderr, or possible side effect. */
  preActivityInfrastructureExit: boolean;
  /** IPC or non-protocol output that may represent untracked external work. */
  externalReplayRisk: boolean;
}

const attemptRecoveryFacts = new WeakMap<SingleResult, AttemptRecoveryFacts>();
const INTERRUPTING_STEER_TIMEOUT_MS = 10_000;

/** Provider identity of a `provider/model` selector, or undefined when unparsable. */
function providerOf(model: string): string | undefined {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : undefined;
}

// ---------------------------------------------------------------------------
// Core: run a single teammate agent
// ---------------------------------------------------------------------------

export async function runSingleTeammate(
  params: RunSingleTeammateParams,
  options: RunTeammateOptions,
): Promise<SingleResult> {
  const startTime = Date.now();
  const correlationId = options.correlationId ?? randomUUID();

  const rejectWith = (content: string): SingleResult => ({
    agent: params.agent,
    name: params.name,
    task: params.task ?? "",
    exitCode: 1,
    messages: [{ role: "system", content }],
    usage: emptyUsage(),
    model: params.model ?? "unknown",
    correlationId,
    durationMs: Date.now() - startTime,
  });

  const publishTurnComplete = (
    result: SingleResult,
    terminalStatus?: AgentTerminalStatus,
  ): void => {
    const canonicalStatus = terminalStatus
      ?? result.terminalStatus
      ?? (result.exitCode === 0 ? "completed" : "failed");
    result.terminalStatus = canonicalStatus;
    try {
      options.onTurnComplete?.(result, canonicalStatus);
    } catch {
      // Completion observers must not change the model fallback outcome.
    }
  };

  const rejectAndPublish = (
    content: string,
    terminalStatus?: AgentTerminalStatus,
  ): SingleResult => {
    const result = rejectWith(content);
    publishTurnComplete(result, terminalStatus);
    return result;
  };

  if (options.signal?.aborted) {
    return rejectAndPublish("Teammate run aborted before launch.", "terminated");
  }

  const containedCwd = resolveContainedCwd(params.cwd, options.baseCwd);
  if ("error" in containedCwd) return rejectAndPublish(containedCwd.error);
  const cwd = containedCwd.cwd;

  if (params.outputSchema) {
    const schemaHazard = findStructuredOutputSchemaHazard(params.outputSchema);
    if (schemaHazard) return rejectAndPublish(schemaHazard);
  }

  // AC4: Depth guard
  const depthCheck = checkDepthGuard(options.depth ?? getTeammateDepth());
  if (!depthCheck.allowed) {
    return rejectAndPublish(
      `Teammate nesting depth exceeded: current=${depthCheck.current}, max=${depthCheck.max}. Prevent recursive fork-bomb.`,
    );
  }

  // Resolve an exact discovered role. Silent generic fallback made misspelled
  // or out-of-project role names look successful while ignoring their prompt.
  const agentConfig: AgentConfig | undefined = resolveAgent(cwd, params.agent);
  if (!agentConfig) {
    const available = listAgentSummaries(cwd).map((agent) => agent.name).join(", ");
    return rejectAndPublish(
      `Unknown teammate agent "${params.agent}". Available agents: ${available || "(none)"}.`,
    );
  }

  // Resolve routing
  const replyTo: ReplyTarget = resolveReplyTo({
    reply_to: params.reply_to,
    protocol_version: params.protocol_version,
    name: params.name,
  });

  // AC7: Model fallback — skip open circuits and try each healthy candidate.
  const candidates = buildModelCandidates(
    params.model ?? agentConfig.model,
    params.fallbackModels ?? agentConfig.fallbackModels,
  );
  try {
    for (let index = 0; index < candidates.length; index += 1) {
      candidates[index] = resolveModelSpecifier(candidates[index], options.modelCapabilities);
    }
    candidates.splice(0, candidates.length, ...new Set(candidates));
  } catch (error) {
    return rejectAndPublish(error instanceof Error ? error.message : String(error));
  }

  const breaker = options.modelCircuitBreaker ?? sharedModelCircuitBreaker;
  // When no explicit model or fallbacks are configured, try the pi default
  // first (undefined), then each authenticated model as an implicit fallback.
  // This prevents a terminal failure when the default provider has no quota.
  const implicitFallbacks = candidates.length === 0
    ? (options.modelCapabilities ?? []).map((capability) => capability.id)
    : [];
  const baseCandidates: Array<string | undefined> = candidates.length > 0
    ? candidates
    : [undefined, ...implicitFallbacks];
  // ④ Health-order the fallback tail (the primary stays first — it is the
  // user's explicit choice). Healthy/never-tried fallbacks float up, while
  // recovering (HALF_OPEN) trials and OPEN candidates sink.
  const modelCandidates: Array<string | undefined> = baseCandidates.length > 1
    ? [
        baseCandidates[0],
        ...rankModelsByHealth(
          baseCandidates.slice(1).filter((model): model is string => model !== undefined),
          breaker,
        ),
      ]
    : baseCandidates;
  const attemptedModels: string[] = [];
  const attemptedModelSet = new Set<string>();
  const recordAttemptedModel = (model: string): void => {
    if (attemptedModelSet.has(model)) return;
    attemptedModelSet.add(model);
    attemptedModels.push(model);
  };
  let resolvedDefaultModel: string | undefined;
  let lastResult: SingleResult | undefined;

  const cancelAtBoundary = (phase: string): SingleResult => {
    const previousMessages = lastResult?.messages ?? [];
    const result: SingleResult = {
      ...(lastResult ?? rejectWith(`Teammate run cancelled ${phase}.`)),
      exitCode: 1,
      messages: [
        { role: "system", content: `Teammate run cancelled ${phase}.` },
        ...previousMessages,
      ],
      attemptedModels: attemptedModels.length > 1 ? attemptedModels : undefined,
      terminalStatus: "terminated",
    };
    publishTurnComplete(result, "terminated");
    return result;
  };

  const waitForRetry = options.waitForRetry ?? waitForRetryDelay;
  let candidateIndex = 0;
  let failedCandidateCount = 0;
  // Providers whose credential just failed auth: their remaining candidates
  // are doomed launches and are skipped (D1-A).
  const authSkippedProviders = new Set<string>();

  for (const modelToUse of modelCandidates) {
    if (options.signal?.aborted) return cancelAtBoundary("before model candidate launch");
    if (modelToUse && modelToUse === resolvedDefaultModel) continue;
    const candidateProvider = modelToUse ? providerOf(modelToUse) : undefined;
    if (candidateProvider !== undefined && authSkippedProviders.has(candidateProvider)) continue;
    candidateIndex += 1;
    const acquisition = modelToUse ? breaker.acquireCandidate(modelToUse) : undefined;
    if (acquisition && !acquisition.allowed) continue;
    if (modelToUse) recordAttemptedModel(modelToUse);

    let settled = false;
    let completionState: "buffering" | "forwarding" | "discarded" = "buffering";
    const pendingCompletions: Array<{
      result: SingleResult;
      terminalStatus?: AgentTerminalStatus;
    }> = [];
    const attemptOptions: RunTeammateOptions = options.onTurnComplete
      ? {
          ...options,
          onTurnComplete(result, terminalStatus) {
            const effectiveStatus = terminalStatus
              ?? (options.signal?.aborted ? "terminated" : undefined);
            if (completionState === "forwarding") publishTurnComplete(result, effectiveStatus);
            else if (completionState === "buffering") {
              pendingCompletions.push({ result, terminalStatus: effectiveStatus });
            }
          },
        }
      : options;
    const commitCompletion = (): void => {
      completionState = "forwarding";
      for (const completion of pendingCompletions.splice(0)) {
        publishTurnComplete(completion.result, completion.terminalStatus);
      }
    };
    const discardCompletion = (): void => {
      completionState = "discarded";
      pendingCompletions.length = 0;
    };

    try {
      let candidateResult: SingleResult;
      try {
        candidateResult = await runSingleAttempt(
          params, agentConfig, cwd, correlationId, replyTo, startTime, modelToUse, attemptOptions,
        );
      } catch (error) {
        discardCompletion();
        throw error;
      }
      lastResult = candidateResult;
      if (modelToUse === undefined) {
        try {
          resolvedDefaultModel = resolveModelSpecifier(candidateResult.model, options.modelCapabilities);
          recordAttemptedModel(resolvedDefaultModel);
        } catch {
          // Runtime-reported models outside the authenticated catalog cannot match an implicit candidate.
        }
      }
      if (candidateResult.lifecyclePending !== true) {
        candidateResult.terminalStatus ??= candidateResult.exitCode === 0 ? "completed" : "failed";
      }

      if (candidateResult.exitCode === 0) {
        if (acquisition?.allowed) {
          breaker.recordSuccess(acquisition);
          settled = true;
        }
        candidateResult.attemptedModels = attemptedModels.length > 1 ? attemptedModels : undefined;
        commitCompletion();
        return candidateResult;
      }

      if (options.signal?.aborted) {
        if (acquisition?.allowed) {
          breaker.releaseCandidate(acquisition);
          settled = true;
        }
        discardCompletion();
        return cancelAtBoundary("during model fallback handoff");
      }

      const error = resultFailureMessage(candidateResult.messages);
      const fallbackFailure = isFallbackProviderError(error);
      const recoveryFacts = attemptRecoveryFacts.get(candidateResult);
      const authoritativeFailure = recoveryFacts?.settlementCapability === "agent_settled";
      const preActivityInfrastructureExit = recoveryFacts?.preActivityInfrastructureExit === true;
      // ⑤ Shared replay-fence semantics: blocked when any tool completed or
      // its effect is unknown. The executor tracks counts (not names), so the
      // reason string carries the counts explicitly.
      const replayFenceClear = recoveryFacts !== undefined
        && !buildReplayFence({
          completedToolCount: recoveryFacts.completedToolCount,
          unknownEffect: recoveryFacts.inFlightToolCount > 0 || recoveryFacts.externalReplayRisk,
          blockedReason:
            `Fresh replay blocked after completedTools=${recoveryFacts.completedToolCount}, `
            + `inFlightTools=${recoveryFacts.inFlightToolCount}, externalReplayRisk=${recoveryFacts.externalReplayRisk}.`,
        }).blocked;
      let fallbackEligible = replayFenceClear
        && ((fallbackFailure && authoritativeFailure) || preActivityInfrastructureExit);

      if (fallbackFailure && !authoritativeFailure && !preActivityInfrastructureExit) {
        candidateResult.messages.push({
          role: "system",
          content:
            `Model fallback blocked because the child did not provide an authoritative agent_settled failure `
            + `(capability=${recoveryFacts?.settlementCapability ?? "unknown"}). `
            + `Legacy or interrupted child streams have degraded recovery capability and cannot be fresh-replayed safely.`,
        });
      } else if ((fallbackFailure || preActivityInfrastructureExit) && !replayFenceClear) {
        const completedTools = recoveryFacts?.completedToolCount ?? 0;
        const inFlightTools = recoveryFacts?.inFlightToolCount ?? 0;
        const externalReplayRisk = recoveryFacts?.externalReplayRisk ?? false;
        candidateResult.messages.push({
          role: "system",
          content:
            `Model fallback blocked by the side-effect replay fence `
            + `(completedTools=${completedTools}, inFlightTools=${inFlightTools}, `
            + `externalReplayRisk=${externalReplayRisk}). `
            + `A fresh model process could repeat a completed tool, a tool whose effect is unknown, `
            + `or external work observed through child IPC/runtime diagnostics.`,
        });
      }

      if (fallbackEligible) {
        const reclamation = await attemptReclamations.get(candidateResult);
        if (
          reclamation
          && typeof reclamation === "object"
          && (reclamation as { status?: string }).status === "unreaped"
        ) {
          candidateResult.messages.push({
            role: "system",
            content:
              `Teammate did not confirm reclamation of the failed child; `
              + `model fallback was stopped to fence stale callbacks for correlationId=${correlationId}.`,
          });
          fallbackEligible = false;
        }
      }

      if (fallbackEligible) {
        if (acquisition?.allowed) {
          if (preActivityInfrastructureExit) breaker.releaseCandidate(acquisition);
          else breaker.recordRetryableFailure(acquisition);
          settled = true;
        }
        discardCompletion();
        const kind = preActivityInfrastructureExit ? "non-retryable" : classifyRetryError(error);
        // D1-A: an auth failure marks this provider's credential as bad —
        // remaining same-provider candidates will fail identically, so skip
        // them instead of launching doomed subprocesses.
        if (kind === "auth" && modelToUse !== undefined) {
          const failedProvider = providerOf(modelToUse);
          if (failedProvider !== undefined) authSkippedProviders.add(failedProvider);
        }
        // D2: bounded kind-aware backoff before the next candidate. Only
        // transient network/provider failures wait (a degraded provider gets
        // a beat instead of consecutive hammering); quota, auth, and
        // permanent failures switch immediately. The final candidate never
        // sleeps — the loop exits to the terminal failure path.
        failedCandidateCount += 1;
        const delayMs = retryDelayMs(failedCandidateCount, kind, extractRetryAfterMs(error));
        if (delayMs > 0 && options.enableRetryBackoff !== false && candidateIndex < modelCandidates.length) {
          await waitForRetry(delayMs, options.signal);
        }
        continue;
      }

      if (acquisition?.allowed) {
        breaker.releaseCandidate(acquisition);
        settled = true;
      }
      candidateResult.attemptedModels = attemptedModels.length > 1 ? attemptedModels : undefined;
      commitCompletion();
      return candidateResult;
    } finally {
      // A HALF_OPEN acquisition must always be settled exactly once.
      if (!settled && acquisition?.allowed && acquisition.state === "HALF_OPEN") {
        breaker.releaseCandidate(acquisition);
      }
    }
  }

  if (options.signal?.aborted) return cancelAtBoundary("during model fallback handoff");
  if (lastResult) {
    lastResult.attemptedModels = attemptedModels.length > 1 ? attemptedModels : undefined;
    publishTurnComplete(lastResult);
    return lastResult;
  }
  return rejectAndPublish(
    `Teammate skipped every model candidate because their circuit breakers are open (agent=${params.agent}).`,
  );
}

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
  initialResultPublished: boolean;
  /** Recovery evidence used to fence any fresh-process model fallback. */
  settlementCapability: AttemptSettlementCapability;
  completedToolCount: number;
  inFlightToolCount: number;
  /** Absorbing state: once terminal, queued child lines must not reopen a turn. */
  terminal: boolean;
}

/**
 * The lifecycle deadlines an attempt can arm. Every settlement path clears
 * both; cleared handles are deliberately left in place so
 * `armResultReadyGrace` still recognises a grace window that was already used.
 */
interface AttemptTimers {
  firstActivity?: ReturnType<typeof setTimeout>;
  resultReadyGrace?: ReturnType<typeof setTimeout>;
  outputLimitRecovery?: ReturnType<typeof setTimeout>;
  interruptingSteer?: ReturnType<typeof setTimeout>;
}

interface PendingInterruptingSteer {
  abortRequestId: string;
  promptRequestId: string;
  message: string;
  token?: LeaseToken;
  phase: "aborting" | "prompting";
}

/** Environment handed to the pi child: identity, depth diagnostics and file seams. */
function buildChildSpawnEnv(
  correlationId: string,
  replyTo: ReplyTarget,
  options: RunTeammateOptions,
  schemaFile: string | undefined,
  outputFile: string | undefined,
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

/** Proxy requests and lifecycle events raised by extensions inside the child. */
function bindChildIpcRelay(
  child: ChildProcess,
  correlationId: string,
  options: RunTeammateOptions,
  onActivity?: () => void,
): void {
  child.on("message", (msg: unknown) => {
    // PERFSEC-001: process.send(null) or malformed envelopes must not crash
    // the parent — an unguarded property access in an EventEmitter callback is
    // an uncaught exception.
    if (msg === null || msg === undefined || typeof msg !== "object") return;
    // GEN-001: After teardown aborts the signal, a dying child's in-flight
    // IPC messages must not re-enter the parent and spawn new nested agents.
    if (options.signal?.aborted) return;
    onActivity?.();
    const m = msg as Record<string, unknown>;
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

async function runSingleAttempt(
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
  const systemPromptFile = writeSystemPromptFile(agentConfig, correlationId, params.outputSchema);
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
    resolvedModel: modelOverride ?? params.model ?? agentConfig.model ?? "unknown",
    completedInputTokens: 0,
    completedOutputTokens: 0,
    completedCacheReadTokens: 0,
    completedCacheWriteTokens: 0,
    receivedFirstActivity: false,
    preActivityInfrastructureExit: false,
    externalReplayRisk: false,
    initialResultPublished: false,
    settlementCapability: "unknown",
    completedToolCount: 0,
    inFlightToolCount: 0,
    terminal: false,
  };

  // AC8: Rich progress tracking
  const progress = createProgress(params.agent, startTime);
  progress.requestedModel = modelOverride ?? params.model ?? agentConfig.model;

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
    let pendingInterruptingSteer: PendingInterruptingSteer | undefined;

    const spawnEnv = buildChildSpawnEnv(correlationId, replyTo, options, schemaFile, outputFile);

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

    if (child.stdin) guardChildStdin(child.stdin);

    // Pi core keeps its in-process provider retry enabled. It handles
    // transient network/provider errors without restarting the child, so
    // tool calls already executed are never repeated. Teammate owns model
    // fallback across candidates at the process level.

    // RPC mode: stdin stays open for bidirectional messaging.
    // Send initial prompt via RPC command.
    if (child.stdin && params.task) {
      const initialLeaseToken = typeof options.initialLeaseToken === "function"
        ? options.initialLeaseToken(correlationId)
        : options.initialLeaseToken;
      sendRpcMessage(child.stdin, params.task, "prompt", initialLeaseToken);
    }

    // IPC message listener — proxy requests from child extensions. Any valid
    // child envelope disqualifies a fresh-process replay because it may have
    // already caused work in the parent process.
    if (useIpc) {
      bindChildIpcRelay(child, correlationId, options, () => {
        state.receivedFirstActivity = true;
        state.externalReplayRisk = true;
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
      if (timers.interruptingSteer) clearTimeout(timers.interruptingSteer);
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

    const failInterruptingSteer = (reason: string): void => {
      if (!pendingInterruptingSteer || state.terminal || state.turnLifecycleSettled) return;
      pendingInterruptingSteer = undefined;
      if (timers.interruptingSteer) {
        clearTimeout(timers.interruptingSteer);
        timers.interruptingSteer = undefined;
      }
      const diagnostic =
        `Failed to interrupt and steer teammate (agent=${params.agent}, correlationId=${correlationId}): ${reason}`;
      state.runtimeFailure = diagnostic;
      appendBoundedTranscriptMessage(messages, { role: "system", content: diagnostic });
      completeTurn(readStructuredOutput(true), true, 1);
    };

    const armInterruptingSteerTimeout = (): void => {
      if (timers.interruptingSteer) clearTimeout(timers.interruptingSteer);
      if (!pendingInterruptingSteer) {
        timers.interruptingSteer = undefined;
        return;
      }
      timers.interruptingSteer = setTimeout(() => {
        const phase = pendingInterruptingSteer?.phase;
        failInterruptingSteer(
          phase === "prompting"
            ? `Pi did not start the correction prompt within ${INTERRUPTING_STEER_TIMEOUT_MS}ms`
            : `Pi did not acknowledge the turn abort within ${INTERRUPTING_STEER_TIMEOUT_MS}ms`,
        );
      }, INTERRUPTING_STEER_TIMEOUT_MS);
      timers.interruptingSteer.unref?.();
    };

    const requestInterruptingSteer = (message: string, token?: LeaseToken): boolean => {
      if (!child.stdin || pendingInterruptingSteer || state.terminal || state.turnLifecycleSettled) return false;
      const nonce = randomUUID();
      pendingInterruptingSteer = {
        abortRequestId: `teammate-steer-abort-${nonce}`,
        promptRequestId: `teammate-steer-prompt-${nonce}`,
        message,
        token,
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
      }, sessionDir, correlationId);
    }

    function readStructuredOutput(cleanup: boolean): unknown | undefined {
      let structuredOutput: unknown;
      if (outputFile) {
        try {
          const candidate = JSON.parse(readRegularTextFile(outputFile));
          if (!params.outputSchema || validateStructuredOutputValue(candidate, params.outputSchema)) {
            structuredOutput = candidate;
          }
        } catch { /* output is absent or not complete */ }
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
      progress.resultReadyAt = undefined;
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
        state.reportedRuntimeErrors.clear();
        state.runtimeFailure = undefined;
        state.lastAssistantStopReason = undefined;
        state.outputLimitRecoveryPending = false;
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
    const lifecycleDeadlineMs = (): number => options.resultReadyGraceMs ?? RESULT_READY_GRACE_MS;
    const lifecycleDeadlineCallback = (): void => {
      timers.resultReadyGrace = undefined;
      lifecycleDeadlineActive = false;
      if (state.terminal || state.turnLifecycleSettled || pendingInterruptingSteer) return;
      appendBoundedTranscriptMessage(messages, {
        role: "system",
        content:
          `Teammate published a result but never confirmed its lifecycle within ${lifecycleDeadlineMs()}ms `
          + `(agent=${params.agent}, correlationId=${correlationId}, expected=agent_settled, `
          + `tools=${progress.toolCount}, turnTools=${state.turnToolCount}); the child process was terminated.`,
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
          appendStructuredOutputFailure();
          appendBoundedTranscriptMessage(messages, {
            role: "system",
            content: STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS.resultReadyGrace,
          });
        }
        completeTurn(structuredOutput, true, structuredOutput === undefined ? 1 : 0);
      }, options.resultReadyGraceMs ?? RESULT_READY_GRACE_MS);
      timers.resultReadyGrace.unref?.();
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
      if (!error || state.reportedRuntimeErrors.has(error)) return;
      if (pendingInterruptingSteer && /\babort(?:ed)?\b/i.test(error)) return;
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
    function onTurnBoundary(): void {
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
      if (timers.resultReadyGrace) {
        clearTimeout(timers.resultReadyGrace);
        timers.resultReadyGrace = undefined;
      }
      if (timers.outputLimitRecovery) {
        clearTimeout(timers.outputLimitRecovery);
        timers.outputLimitRecovery = undefined;
      }
      state.turnLifecycleSettled = false;
      state.lastAssistantStopReason = undefined;
      state.runtimeFailure = undefined;
      progress.status = "running";
      progress.phase = "prompting";
      progress.resultReadyAt = undefined;
      progress.recentTools = [];
      state.turnToolCount = 0;
      state.pendingStructuredOutput = undefined;
      state.capturedStructuredOutput = undefined;
      state.structuredOutputValidationFailure = undefined;
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

    /** A completed assistant message: transcript, usage and resolved model. */
    function onAssistantMessage(event: JsonLineEvent): void {
      const msg = event.message as Record<string, unknown> | undefined;
      if (event.type === "message_end" && msg?.role !== "assistant") return;
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

      // Extract usage from message snapshot
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
      progress.recentTools.push({ name: toolName, status: "running" });
      state.inFlightToolCount += 1;
      progress.phase = "tool-execution";
      if (progress.recentTools.length > EXECUTION_BUFFER_LIMITS.toolItems) {
        progress.recentTools.splice(
          0,
          progress.recentTools.length - EXECUTION_BUFFER_LIMITS.toolItems,
        );
      }
      options.onProgress?.(progress);
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
      const lastTool = progress.recentTools[progress.recentTools.length - 1];
      if (lastTool && lastTool.status === "running") {
        lastTool.status = "completed";
      }
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
      if (isPiResultReadyTurn(event)) {
        progress.resultReadyAt = Date.now();
        options.onProgress?.(progress);
        if (!params.outputSchema) {
          publishResultReady();
          // Symmetric with the schema lane: the result is consumable, but
          // the lifecycle still needs a bounded confirmation window.
          armLifecycleConfirmationDeadline();
        } else armResultReadyGrace();
      }
    }

    /** Finalize the current run after Pi confirms no retry, compaction, or queued continuation remains. */
    function settleAgentSession(): void {
      const structuredOutput = readStructuredOutput(false);
      if (params.outputSchema && structuredOutput === undefined) {
        appendStructuredOutputFailure();
        appendBoundedTranscriptMessage(messages, {
          role: "system",
          content: STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS.agentEnd,
        });
        completeTurn(undefined, true, 1);
        return;
      }
      const exitCode = state.runtimeFailure ? 1 : 0;
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
      const pending = pendingInterruptingSteer;
      if (!pending || typeof event.id !== "string") return;
      if (pending.phase === "aborting" && event.id === pending.abortRequestId) {
        if (event.success !== true || event.command !== "abort") {
          failInterruptingSteer("Pi rejected the turn abort command");
          return;
        }
        pending.phase = "prompting";
        armInterruptingSteerTimeout();
        if (!child.stdin || !writeChildStdinLine(child.stdin, JSON.stringify({
          id: pending.promptRequestId,
          type: "prompt",
          message: wrapLeasedMessage(pending.message, pending.token),
        }))) {
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
      ["message_end", onAssistantMessage],
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

      const processExitCode = state.runtimeFailure ? 1 : code ?? 1;
      const exitCode = processExitCode === 0 && params.outputSchema && structuredOutput === undefined
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

// ---------------------------------------------------------------------------
// Graph execution (unified: parallel, chain, and DAG)
// ---------------------------------------------------------------------------

export function normalizeGraphConcurrency(concurrency: number, taskCount: number): number {
  return Math.max(
    1,
    Math.min(taskCount || 1, Number.isFinite(concurrency) ? Math.floor(concurrency) : 1),
  );
}

export async function runGraph(
  tasks: NormalizedTask[],
  concurrency: number,
  options: RunTeammateOptions,
): Promise<SingleResult[]> {
  const maxConcurrency = normalizeGraphConcurrency(concurrency, tasks.length);
  const taskCorrelationIds = tasks.map(
    (_, index) => options.taskCorrelationIds?.[index] ?? randomUUID(),
  );
  const taskNames = new Set(tasks.filter((t) => t.name).map((t) => t.name!));
  const indexByName = new Map<string, number>();
  for (let i = 0; i < tasks.length; i++) {
    if (tasks[i].name) indexByName.set(tasks[i].name!, i);
  }

  const publishGraphRejection = (
    message: string,
    dependencies: number[][] = tasks.map(() => []),
  ): SingleResult[] => tasks.map((task, index) => {
    const result: SingleResult = {
      agent: task.agent,
      name: task.name,
      task: task.prompt,
      exitCode: 1,
      messages: [{ role: "system", content: message }],
      usage: emptyUsage(),
      model: task.model ?? "unknown",
      correlationId: taskCorrelationIds[index],
      durationMs: 0,
      terminalStatus: "failed",
    };
    const now = Date.now();
    try {
      options.onProgress?.({
        agent: task.agent,
        name: task.name,
        correlationId: taskCorrelationIds[index],
        taskIndex: index,
        dependencies: dependencies[index] ?? [],
        status: "failed",
        recentTools: [],
        toolCount: 0,
        tokens: 0,
        durationMs: 0,
        lastActivityAt: now,
        startedAt: now,
        lastMessage: message,
      });
    } catch {
      // Progress observers are advisory and cannot interrupt graph settlement.
    }
    try {
      options.onTurnComplete?.(result);
    } catch {
      // Validation observers cannot prevent the remaining graph tasks from settling.
    }
    return result;
  });

  // Defensive validation for direct runGraph callers — the teammate tool
  // path already rejects these in normalizeTeammateParams.
  const refCheck = validateTaskReferences(tasks);
  if (refCheck.errors.length > 0) {
    return publishGraphRejection(refCheck.errors.join("\n"));
  }

  // Build dependency adjacency list — implicit {name} refs ∪ explicit dependsOn.
  // Names are pre-filtered against taskNames, so lookups cannot miss.
  const deps: number[][] = tasks.map((t) =>
    taskDependencyNames(t, taskNames).map((name) => indexByName.get(name)!),
  );

  if (hasCycle(deps)) {
    return publishGraphRejection("Circular dependency detected in task graph", deps);
  }

  // Validate unique names
  const nameCount = new Map<string, number>();
  for (const t of tasks) {
    if (t.name) nameCount.set(t.name, (nameCount.get(t.name) ?? 0) + 1);
  }
  for (const [name, count] of nameCount) {
    if (count > 1) {
      return publishGraphRejection(`Duplicate task name "${name}"`, deps);
    }
  }

  const results: SingleResult[] = new Array(tasks.length);
  const outputs = new Map<string, TaskOutput>();
  const completed = new Set<number>();
  const failed = new Set<number>();

  // Concurrency semaphore
  let running = 0;
  const waiters: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (running < maxConcurrency) {
      running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waiters.push(() => {
        running++;
        resolve();
      });
    });
  }

  function release(): void {
    running--;
    const next = waiters.shift();
    if (next) next();
  }

  // Dependency completion tracking
  const completionListeners = new Map<number, Array<() => void>>();

  function waitForDeps(taskIdx: number): Promise<boolean> {
    const taskDeps = deps[taskIdx];
    if (taskDeps.length === 0) return Promise.resolve(true);

    if (taskDeps.every((d) => completed.has(d) || failed.has(d))) {
      return Promise.resolve(!taskDeps.some((d) => failed.has(d)));
    }

    return new Promise((resolve) => {
      let remaining = taskDeps.filter(
        (d) => !completed.has(d) && !failed.has(d),
      ).length;
      if (remaining === 0) {
        resolve(!taskDeps.some((d) => failed.has(d)));
        return;
      }

      for (const dep of taskDeps) {
        if (completed.has(dep) || failed.has(dep)) continue;
        const cbs = completionListeners.get(dep) ?? [];
        cbs.push(() => {
          remaining--;
          if (remaining === 0) {
            resolve(!taskDeps.some((d) => failed.has(d)));
          }
        });
        completionListeners.set(dep, cbs);
      }
    });
  }

  function notifyComplete(taskIdx: number): void {
    const cbs = completionListeners.get(taskIdx);
    if (cbs) {
      for (const cb of cbs) cb();
      completionListeners.delete(taskIdx);
    }
  }

  function reportTaskFailure(
    task: NormalizedTask,
    taskIndex: number,
    message: string,
    terminalStatus?: AgentTerminalStatus,
  ): void {
    const now = Date.now();
    try {
      options.onProgress?.({
        agent: task.agent,
        name: task.name,
        correlationId: taskCorrelationIds[taskIndex],
        taskIndex,
        dependencies: deps[taskIndex],
        status: terminalStatus === "terminated" ? "terminated" : "failed",
        recentTools: [],
        toolCount: 0,
        tokens: 0,
        durationMs: 0,
        lastActivityAt: now,
        startedAt: now,
        lastMessage: message,
      });
    } catch {
      // Progress observers are advisory and cannot interrupt graph settlement.
    }
  }

  function publishSyntheticFailure(
    task: NormalizedTask,
    taskIndex: number,
    message: string,
    terminalStatus?: AgentTerminalStatus,
  ): void {
    failed.add(taskIndex);
    const result: SingleResult = {
      agent: task.agent,
      name: task.name,
      task: task.prompt,
      exitCode: 1,
      messages: [{ role: "system", content: message }],
      usage: emptyUsage(),
      model: task.model ?? "unknown",
      correlationId: taskCorrelationIds[taskIndex],
      durationMs: 0,
      terminalStatus: terminalStatus ?? "failed",
    };
    results[taskIndex] = result;
    reportTaskFailure(task, taskIndex, message, terminalStatus);
    try {
      options.onTurnComplete?.(result, result.terminalStatus);
    } catch {
      // Synthetic lifecycle observers cannot block dependency propagation.
    }
  }

  const promises = tasks.map(async (task, idx) => {
    const depsOk = await waitForDeps(idx);

    if (!depsOk) {
      publishSyntheticFailure(task, idx, "Skipped: upstream dependency failed");
      notifyComplete(idx);
      return;
    }

    let resolvedTask = task.prompt;
    try {
      resolvedTask = resolveVariables(task.prompt, outputs, taskNames);
    } catch (err) {
      publishSyntheticFailure(
        task,
        idx,
        `Variable resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      notifyComplete(idx);
      return;
    }

    await acquire();

    try {
      if (options.signal?.aborted) {
        publishSyntheticFailure(task, idx, "Cancelled before child process launch.", "terminated");
        return;
      }

      // options.onTurnComplete flows through the spread unchanged: lifecycle
      // confirmation still settles the agent record after publication, but it
      // must not block this slot.
      const result = await runSingleTeammate(
        {
          agent: task.agent,
          task: resolvedTask,
          context: task.context,
          model: task.model,
          fallbackModels: task.fallbackModels,
          thinking: task.thinking,
          cwd: task.cwd,
          outputSchema: task.outputSchema,
        },
        {
          ...options,
          correlationId: taskCorrelationIds[idx],
          signal: options.taskSignals?.[idx] ?? options.signal,
          onProgress: options.onProgress
            ? (data) => {
                try {
                  options.onProgress?.({
                    ...data,
                    name: task.name,
                    correlationId: taskCorrelationIds[idx],
                    taskIndex: idx,
                    dependencies: deps[idx],
                  });
                } catch {
                  // Progress observers are advisory and cannot interrupt graph settlement.
                }
              }
            : undefined,
        },
      );
      // Result publication — not lifecycle confirmation — is the release
      // boundary for parallel slots and DAG dependents (debug-notes-002).
      // A lifecyclePending result is consumable; agent_settled/close/grace keeps
      // converging the child via options.onTurnComplete after this returns.
      results[idx] = result;

      if (result.exitCode === 0) {
        completed.add(idx);
        if (task.name) {
          const lastMsg =
            result.messages[result.messages.length - 1]?.content ?? "";
          outputs.set(task.name, {
            text: lastMsg,
            structured: result.structuredOutput,
          });
        }
      } else {
        failed.add(idx);
      }
    } catch (err) {
      publishSyntheticFailure(
        task,
        idx,
        `Execution error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      release();
      notifyComplete(idx);
    }
  });

  await Promise.all(promises);
  return results;
}

/** Programmatic tasks-only entry point matching the public teammate schema. */
export async function runTeammate(
  params: RunTeammateParams,
  options: RunTeammateOptions,
): Promise<SingleResult[]> {
  const routed = applyModelRouting(
    params,
    options.baseCwd,
    options.modelCapabilities?.map((capability) => capability.id) ?? [],
    undefined,
    options.inheritModel,
  );
  const normalized = normalizeTeammateParams(routed);
  if (normalized.error) throw new Error(normalized.error);
  return runGraph(normalized.tasks, params.concurrency ?? 4, options);
}

// ---------------------------------------------------------------------------
// RPC: Send message to running agent via stdin
// ---------------------------------------------------------------------------

export type RpcMessageMode = "prompt" | "steer" | "follow_up" | "abort";

type InterruptingSteerHandler = (message: string, token?: LeaseToken) => boolean;

const guardedChildStdinStreams = new WeakSet<Writable>();
const interruptingSteerHandlers = new WeakMap<Writable, InterruptingSteerHandler>();

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

export function sendRpcMessage(
  stdin: Writable,
  message: string,
  mode: RpcMessageMode = "follow_up",
  token?: LeaseToken,
): boolean {
  if (mode === "abort") {
    return writeChildStdinLine(stdin, JSON.stringify({ type: "abort" }));
  }
  const leasedMessage = wrapLeasedMessage(message, token);
  if (mode === "prompt") {
    return writeChildStdinLine(stdin, JSON.stringify({ type: "prompt", message: leasedMessage }));
  }
  if (mode === "steer") {
    const interrupt = interruptingSteerHandlers.get(stdin);
    if (interrupt) return interrupt(message, token);
  }
  return writeChildStdinLine(stdin, JSON.stringify({ type: mode, message: leasedMessage }));
}

export function sendChildIpcMessage(
  child: ChildProcess,
  message: Record<string, unknown>,
): boolean {
  if (!child.connected) return false;
  try {
    child.send(message as never, (error) => {
      if (!error) return;
      console.error(
        "[pi-maestro-teammate] child IPC send failed asynchronously",
        error,
        "type", (message as { type?: string }).type,
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


