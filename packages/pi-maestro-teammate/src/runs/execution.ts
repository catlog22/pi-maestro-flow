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
import {
  discoverAgents,
  formatAgentShadowWarning,
  listAgentSummaries,
  resolveAgent,
  type AgentConfig,
} from "../agents/agents.ts";
import { resolveReplyTo, type ReplyTarget } from "../shared/routing.ts";
import type {
  SingleResult,
  Usage,
  AgentProgress,
  AgentProgressStatus,
  AgentTerminalStatus,
  AgentRunPhase,
  RecentToolInfo,
} from "../shared/types.ts";
import { wrapLeasedMessage, type LeaseToken } from "./session-handoff.ts";
import { applyModelRouting, syncModelCircuitPolicies, type TeammateTaskType } from "../models/model-routing.ts";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import {
  rankModelsByHealth,
  sharedModelCircuitBreaker,
  type AcquiredModelCandidate,
  type ModelCircuitBreaker,
} from "../models/model-circuit-breaker.ts";
import { getTeammateChildExtensions, getTeammateChildToolBroker } from "./child-extensions.ts";
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
import {
  MODEL_FALLBACK_RESUME_PROMPT,
} from "./execution-infra.ts";
import { buildReplayFence } from "./recovery-protocol.ts";
import { cliToolNameFromModel, isCliToolModel } from "../cli-tools/local-acp.ts";

export * from "./execution-infra.ts";
import {
  EXECUTION_BUFFER_LIMITS,
  FIRST_ACTIVITY_TIMEOUT_MS,
  OUTPUT_LIMIT_RECOVERY_TIMEOUT_MS,
  RESULT_READY_GRACE_MS,
  STRUCTURED_OUTPUT_RECOVERY_PROMPT,
  STRUCTURED_OUTPUT_RECOVERY_TIMEOUT_MS,
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
  describeStructuredOutputValueValidationFailure,
  emptyUsage,
  ensurePrivateDirectory,
  extractPiEventError,
  extractStructuredOutputCandidate,
  extractTextContent,
  findStructuredOutputSchemaHazard,
  getTeammateDepth,
  getTeammateSessionRoot,
  hasCycle,
  isPiResultReadyTurn,
  prepareTeammateMode,
  normalizeTeammateParams,
  readRegularTextFile,
  releasePublishedTurnHistory,
  resetUsage,
  remoteLocationRouting,
  resolveContainedCwd,
  resolveModelSpecifier,
  resolveVariables,
  resultFailureMessage,
  setUsageSnapshot,
  taskDependencyNames,
  taskPromptBoundaryError,
  truncateUtf8Tail,
  validateTaskReferences,
  waitForRetryDelay,
  writeSchemaFile,
  writeSystemPromptFile,
} from "./execution-infra.ts";
import type {
  JsonLineEvent,
  NormalizedTask,
  RemoteLocationRouting,
  RunSingleTeammateParams,
  RunTeammateOptions,
  RunTeammateParams,
  StructuredOutputCandidate,
  TaskOutput,
} from "./execution-infra.ts";


// The Pi subprocess backend implementation. Orchestration here decides *which*
// model runs; the module below decides how a Pi child runs it. Its previously
// public surface is re-exported unchanged so no consumer import path moves.
import { adjudicateTask, validateBackendCapabilities } from "pi-maestro-backends";
import { outcomeOf } from "../backends/pi-subprocess.ts";
import { closeBackendControlStdin, createBackendControlStdin } from "../backends/control-shim.ts";
import { backendRegistryConfigSync, dispatchRegistrySync } from "../backends/registry-host.ts";
import { runSingleAttempt } from "./pi-subprocess-attempt.ts";
import type {
  AttemptOutcome,
  BackendCapabilities,
  BackendRunOptions,
  ConfigValue,
} from "pi-maestro-backend-core/v1/backend";
import type { TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";

export {
  TOOL_EXECUTION_HEARTBEAT_MS,
  resolveAgentCacheRetention,
  sendRpcMessage,
  sendChildIpcMessage,
  dispatchChildIpcMessage,
} from "./pi-subprocess-attempt.ts";
export type { RpcMessageMode } from "./pi-subprocess-attempt.ts";

/** Provider identity of a `provider/model` selector, or undefined when unparsable. */
function providerOf(model: string): string | undefined {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : undefined;
}

// ---------------------------------------------------------------------------
// Core: run a single teammate agent
// ---------------------------------------------------------------------------

/**
 * Decide which registration serves this attempt.
 *
 * A remote location already selected its backend and a task that named one
 * meant it, so the model-derived mapping is the last word rather than the first.
 *
 * @param params - the teammate request.
 * @param model - the single model this attempt runs.
 * @param remote - the remote target this task was located at, when it named one.
 * @returns the registered backend name, or undefined to take the registry default.
 */
function backendNameOf(
  params: RunSingleTeammateParams,
  model: string | undefined,
  remote?: RemoteLocationRouting,
): string | undefined {
  if (remote !== undefined) return remote.backend;
  if (params.backend !== undefined) return params.backend;
  // A `cli/<tool>` model names its own registration: the tool is the registered
  // backend, so a deployment adds a CLI by registering one and changes no host
  // source. An unregistered tool is refused by name by the registry, which is
  // the same outcome the inline dispatch produced for an unconfigured tool.
  if (model !== undefined && isCliToolModel(model)) return cliToolNameFromModel(model);
  return undefined;
}

/**
 * Project the orchestrator request into the backend contract.
 *
 * Host-resolved fields stay behind: `taskType` has already become a model,
 * `fallbackModels` is sequenced across attempts by the sweep below, and
 * `background` is host scheduling.
 *
 * @param params - the teammate request.
 * @param cwd - resolved task cwd.
 * @param model - the single model this attempt runs.
 * @param remote - the remote target this task was located at, when it named one.
 * @returns the contract-shaped run spec.
 */
function backendSpecOf(
  params: RunSingleTeammateParams,
  cwd: string,
  model: string | undefined,
  remote?: RemoteLocationRouting,
): TeammateRunSpec {
  const backend = backendNameOf(params, model, remote);
  return {
    agent: params.agent,
    task: params.task ?? "",
    ...(params.name === undefined ? {} : { name: params.name }),
    ...(backend === undefined ? {} : { backend }),
    ...(params.context === undefined ? {} : { context: params.context }),
    ...(model === undefined ? {} : { model }),
    ...(params.thinking === undefined ? {} : { thinking: params.thinking as TeammateRunSpec["thinking"] }),
    ...(params.outputSchema === undefined ? {} : { outputSchema: params.outputSchema }),
    ...(params.todos === undefined ? {} : { todos: params.todos }),
    // A remote location is a target, not a directory: the working directory a
    // remote run uses comes from that target's own configuration, and passing
    // the literal `remote:beta` down as a path is what made the old bypass
    // resolve it against the local base.
    ...(remote === undefined ? { cwd } : {}),
  };
}

/**
 * Build the run options a backend receives.
 *
 * @param correlationId - identity of this attempt.
 * @param baseCwd - the host's base cwd; the task's own cwd travels on the spec.
 * @param options - host run options supplying the observer callbacks.
 * @param agent - the agent this attempt runs, for progress projection.
 * @param startedAt - attempt start, for progress projection.
 * @returns the contract-shaped run options.
 */
const PROGRESS_STATUSES: readonly AgentProgressStatus[] = [
  "pending", "running", "retrying", "completed", "failed", "terminated",
];

/**
 * Read one number out of an untyped backend payload.
 *
 * @param value - the raw field.
 * @param fallback - used when the backend reported nothing usable.
 * @returns a finite non-negative number.
 */
function progressNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Read the recent-tool list out of an untyped backend payload.
 *
 * @param value - the raw field.
 * @returns the entries that carry both a name and a status.
 */
function progressTools(value: unknown): RecentToolInfo[] {
  if (!Array.isArray(value)) return [];
  const tools: RecentToolInfo[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, status, argsPreview } = entry as Record<string, unknown>;
    if (typeof name !== "string" || typeof status !== "string") continue;
    tools.push({ name, status, ...(typeof argsPreview === "string" ? { argsPreview } : {}) });
  }
  return tools;
}

/**
 * Convert a backend's progress payload into the host's progress record.
 *
 * A backend reports whatever its runtime knows, so this is a real conversion
 * rather than a cast: the host supplies the identity and timing it owns, the
 * payload supplies what the runtime observed, and anything the backend cannot
 * report falls back to a value that reads as "not observed" instead of as a
 * measurement. Validation belongs here because the payload crosses a module
 * boundary untyped.
 *
 * @param data - the backend's payload.
 * @param agent - the agent this attempt runs, known to the host.
 * @param startedAt - attempt start, known to the host.
 * @returns the host-shaped progress record.
 *
 * @internal Exported for backend-seam regression tests.
 */
export function projectBackendProgress(
  data: Record<string, unknown>,
  agent: string,
  startedAt: number,
): AgentProgress {
  const now = Date.now();
  const status = PROGRESS_STATUSES.find((candidate) => candidate === data.status) ?? "running";
  return {
    agent,
    status,
    recentTools: progressTools(data.recentTools),
    toolCount: progressNumber(data.toolCount, 0),
    tokens: progressNumber(data.tokens, 0),
    startedAt: progressNumber(data.startedAt, startedAt),
    durationMs: progressNumber(data.durationMs, now - startedAt),
    lastActivityAt: progressNumber(data.lastActivityAt, now),
    ...(typeof data.name === "string" ? { name: data.name } : {}),
    ...(typeof data.correlationId === "string" ? { correlationId: data.correlationId } : {}),
    ...(typeof data.lastMessage === "string" ? { lastMessage: data.lastMessage } : {}),
    ...(typeof data.resolvedModel === "string" ? { resolvedModel: data.resolvedModel } : {}),
    ...(typeof data.requestedModel === "string" ? { requestedModel: data.requestedModel } : {}),
  };
}

function backendOptionsOf(
  correlationId: string,
  baseCwd: string,
  options: RunTeammateOptions,
  agent: string,
  startedAt: number,
  config: Record<string, ConfigValue>,
): BackendRunOptions {
  return {
    correlationId,
    baseCwd,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onProgress === undefined ? {} : {
      onProgress: (data: Record<string, unknown>): void => {
        options.onProgress?.(projectBackendProgress(data, agent, startedAt));
      },
    }),
    ...(options.onChildEvent === undefined ? {} : { onChildEvent: options.onChildEvent }),
    ...(options.onTurnComplete === undefined ? {} : { onTurnComplete: options.onTurnComplete }),
    // The broker registry is in-process and Promise-shaped: it lives on a
    // globalThis symbol the child cannot see, and a backend is only ever
    // dispatched from the root session, so this closure resolves against the
    // same registry `dispatchRegisteredChildTool` already awaits directly. The
    // callback-shaped relay this used to warn about is
    // `onChildRequest(event, reply)`, a different mechanism that no backend
    // reaches. An absent broker is a configuration failure, not a hang, so it
    // is reported by name rather than waited on.
    host: {
      async proxyToolCall(request: {
        toolName: string;
        args: unknown;
        correlationId: string;
      }): Promise<unknown> {
        const broker = getTeammateChildToolBroker(request.toolName);
        if (broker === undefined) {
          throw new Error(
            `no host tool broker is registered for "${request.toolName}"; the backend `
            + "declares a host-tool binding this root session cannot serve",
          );
        }
        return broker({
          toolName: request.toolName,
          input: request.args as Record<string, unknown>,
          // This attempt's own identity, taken from the parameters rather than
          // from anything the call carried: together with the endpoint's
          // per-run token binding, it is what makes a backend unable to act as
          // a teammate other than itself.
          actor: { correlationId, agent },
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      },
    },
    config,
  };
}

export async function runSingleTeammate(
  params: RunSingleTeammateParams,
  options: RunTeammateOptions,
): Promise<SingleResult> {
  const startTime = Date.now();
  const correlationId = options.correlationId ?? randomUUID();
  let resolvedRunCwd: string | undefined;
  let publicationAwaitingCompletion: { publicationId: string; originCwd: string } | undefined;
  let agentDiscoveryWarning: string | undefined;

  const attachDiscoveryWarning = (result: SingleResult): SingleResult => {
    if (agentDiscoveryWarning && !result.warnings?.includes(agentDiscoveryWarning)) {
      result.warnings = [...(result.warnings ?? []), agentDiscoveryWarning];
    }
    return result;
  };

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
    attachDiscoveryWarning(result);
    if (resolvedRunCwd) result.originCwd ??= resolvedRunCwd;
    if (publicationAwaitingCompletion) {
      result.publicationId ??= publicationAwaitingCompletion.publicationId;
      result.originCwd ??= publicationAwaitingCompletion.originCwd;
      publicationAwaitingCompletion = undefined;
    }
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

  const publishResult = async (result: SingleResult, originCwd: string): Promise<void> => {
    attachDiscoveryWarning(result);
    result.publicationId ??= randomUUID();
    result.originCwd ??= originCwd;
    publicationAwaitingCompletion = {
      publicationId: result.publicationId,
      originCwd: result.originCwd,
    };
    try {
      await options.onResultPublished?.(result, originCwd);
    } catch (error) {
      console.warn(
        `[pi-maestro-teammate] result publication observer failed for ${result.correlationId}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      // Publication observers are advisory; the in-memory result remains authoritative.
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

  const remoteRouting = remoteLocationRouting(params.cwd);
  if (remoteRouting !== undefined) {
    if (params.backend !== undefined && params.backend !== remoteRouting.backend) {
      return rejectAndPublish(
        `Teammate task names backend "${params.backend}" and remote location "${params.cwd}"; `
        + "a remote location already selects its backend, so these two cannot both be set",
      );
    }
    // Legacy mode resolves no registry at all, so there is no registration to
    // route this to. Falling through would run on this machine a task that
    // named another one, so it is refused by name instead. `rejectAndPublish`
    // rather than a throw: the dispatch below has no catch, and the caller must
    // receive a settled result rather than an exception.
    if (options.backendRegistry === undefined
      && (backendRegistryConfigSync(options.baseCwd).mode ?? "legacy") === "legacy") {
      return rejectAndPublish(
        `Teammate task requests remote location "${params.cwd}", but .pi/teammate-backends.json is in `
        + `legacy execution mode; set mode "backend-registry" and register "${remoteRouting.backend}" — `
        + "refusing to run a remote task on this machine",
      );
    }
  }

  // A remote task still needs a real local directory: agent discovery and
  // result publication both read one. The remote location itself is a target
  // name, so it never reaches the path resolver.
  const containedCwd = resolveContainedCwd(
    remoteRouting === undefined ? params.cwd : undefined,
    options.baseCwd,
  );
  if ("error" in containedCwd) return rejectAndPublish(containedCwd.error);
  const cwd = containedCwd.cwd;
  resolvedRunCwd = cwd;

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
  const discovery = discoverAgents(cwd, { includeDiagnostics: true });
  const agentConfig: AgentConfig | undefined = resolveAgent(discovery, params.agent);
  if (!agentConfig) {
    const available = listAgentSummaries(discovery).map((agent) => agent.name).join(", ");
    return rejectAndPublish(
      `Unknown teammate agent "${params.agent}". Available agents: ${available || "(none)"}.`,
    );
  }
  agentDiscoveryWarning = formatAgentShadowWarning(discovery, params.agent);

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

  const formatCancellationReason = (): string => {
    try {
      const rawReason = options.signal?.reason;
      const text = rawReason instanceof Error
        ? `${rawReason.name}: ${rawReason.message}`
        : typeof rawReason === "string"
          ? rawReason
          : rawReason === undefined
            ? "unspecified"
            : String(rawReason);
      return text.replace(/\s+/g, " ").trim().slice(0, 500) || "unspecified";
    } catch {
      return "unprintable cancellation reason";
    }
  };

  const cancelAtBoundary = (phase: string): SingleResult => {
    const cancellationMessage = `Teammate run cancelled by its caller ${phase} (reason: ${formatCancellationReason()}).`;
    const previousMessages = lastResult?.messages ?? [];
    const result: SingleResult = {
      ...(lastResult ?? rejectWith(cancellationMessage)),
      exitCode: 1,
      messages: [
        { role: "system", content: cancellationMessage },
        ...previousMessages,
      ],
      attemptedModels: attemptedModels.length > 1 ? attemptedModels : undefined,
      terminalStatus: "terminated",
    };
    if (resolvedRunCwd) result.originCwd ??= resolvedRunCwd;
    publishTurnComplete(result, "terminated");
    return result;
  };

  const waitForRetry = options.waitForRetry ?? waitForRetryDelay;
  let candidateIndex = 0;
  let failedCandidateCount = 0;
  // Providers whose credential just failed auth: their remaining candidates
  // are doomed launches and are skipped (D1-A).
  const authSkippedProviders = new Set<string>();
  // Acquisitions taken by in-process model switches (A path). Settled when the
  // run that owns them settles: success records success, failure records a
  // retryable failure. Keyed by model id.
  const pendingModelAcquisitions = new Map<string, AcquiredModelCandidate>();
  // True once an in-process switch moved away from the loop's original model.
  // The original model's own trial then failed (that is why the switch
  // happened) and must be charged accordingly at the terminal settlement,
  // mirroring the B path's recordRetryableFailure for the failed candidate.
  let switchedAwayFromOriginal = false;
  // Every model switched to within this run. A failed switch settles its
  // acquisition immediately but stays in this set, so the chain can never
  // re-select a model that already ran and failed (bounded failover).
  const switchedModels = new Set<string>();
  const settlePendingModelAcquisitions = (success: boolean): void => {
    for (const [model, acquisition] of pendingModelAcquisitions) {
      if (success) breaker.recordSuccess(acquisition);
      else breaker.recordRetryableFailure(acquisition);
    }
    pendingModelAcquisitions.clear();
  };
  // Session checkpoint of the most recent candidate that published one
  // (via the child's `teammate_session_ready` IPC). A later candidate that
  // fails mid-run can resume this checkpoint under a new model instead of
  // replaying the whole task (cold restart + model override).
  let lastSessionFile: string | undefined;
  // Checkpoint handed to the next candidate after a resume-based failover;
  // consumed when the next attemptOptions is built, then cleared.
  let resumeHandoff: string | undefined;

  for (const modelToUse of modelCandidates) {
    if (options.signal?.aborted) return cancelAtBoundary("before a model candidate launched");
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
    // Capture the child's published session file so a mid-run failure under
    // this candidate can resume that checkpoint under the next model.
    const hostOnChildEvent = options.onChildEvent;
    // A resume handoff from a failed predecessor loads that recorded session
    // under this candidate's model (`--session <checkpoint> --model <model>`)   
    // and replaces the original task text with a resume directive. Spread
    // unconditionally so the handoff and the session-file capture never
    // mutate the caller's own options object.
    const handoff = resumeHandoff;
    resumeHandoff = undefined;
    // In-process model failover: when the child settles a retryable provider
    // failure while still alive, pick the next healthy candidate from the
    // remaining chain and hand it to the child's `set_model` RPC. The same
    // session continues in place, so nothing is replayed. Models already
    // switched to within this run are excluded, and a model that actually ran
    // (acknowledged switch) but failed again is settled immediately instead
    // of waiting for the run's terminal result.
    const nextCandidateModel = (previousModel?: string): string | undefined => {
      // A previous switch that ran and failed again is settled now: it has
      // its own failure signal and must not wait for the run's terminal
      // outcome (which would credit it with success if a later candidate
      // recovers, or double-charge it if the run fails overall).
      if (previousModel !== undefined) {
        const previousAcquisition = pendingModelAcquisitions.get(previousModel);
        if (previousAcquisition !== undefined) {
          breaker.recordRetryableFailure(previousAcquisition);
          pendingModelAcquisitions.delete(previousModel);
        }
      }
      const tail = modelCandidates.slice(candidateIndex).filter((candidate) => (
        candidate !== undefined
        && candidate !== modelToUse
        && candidate !== resolvedDefaultModel
        && !switchedModels.has(candidate)
      ));
      const ranked = rankModelsByHealth(tail as string[], breaker);
      for (const candidate of ranked) {
        const candidateProvider = providerOf(candidate);
        if (candidateProvider !== undefined && authSkippedProviders.has(candidateProvider)) continue;
        const acquisition = breaker.acquireCandidate(candidate);
        if (!acquisition.allowed) continue;
        // The switch itself is the trial; keep the acquisition owned by the
        // in-process run so a later terminal result settles it. The model is
        // remembered for the whole run so a failed switch cannot re-select
        // it.
        pendingModelAcquisitions.set(candidate, acquisition);
        switchedModels.add(candidate);
        recordAttemptedModel(candidate);
        if (previousModel === undefined) switchedAwayFromOriginal = true;
        return candidate;
      }
      return undefined;
    };
    const baseAttemptOptions: RunTeammateOptions = {
      ...options,
      ...(handoff === undefined ? {} : {
        resumeSessionFile: handoff,
        resumePrompt: MODEL_FALLBACK_RESUME_PROMPT,
      }),
      // Only arm the in-process switch when the candidate chain actually has
      // a successor; with nothing left the failure settles through the
      // standard path without an extra async hop. `candidateIndex` already
      // counts this candidate, so the slice starts after it.
      ...(modelCandidates.slice(candidateIndex).some((candidate) => candidate !== undefined)
        ? { onModelFailover: (error, previousModel) => nextCandidateModel(previousModel) }
        : {}),
      onChildEvent: (event) => {
        if (event.type === "teammate_session_ready" && typeof event.sessionFile === "string") {
          lastSessionFile = event.sessionFile;
        } else if (event.type === "teammate_model_switch_abandoned" && typeof event.model === "string") {
          // The switch never reached Pi's ack, so the target model never ran.
          // Release its trial acquisition instead of charging a phantom
          // failure at the terminal settlement.
          const abandoned = pendingModelAcquisitions.get(event.model);
          if (abandoned !== undefined) {
            breaker.releaseCandidate(abandoned);
            pendingModelAcquisitions.delete(event.model);
          }
        }
        hostOnChildEvent?.(event);
      },
    };
    const attemptOptions: RunTeammateOptions = options.onTurnComplete || options.onResultPublished
      ? {
          ...baseAttemptOptions,
          onTurnComplete(result, terminalStatus) {
            const effectiveStatus = terminalStatus
              ?? (options.signal?.aborted ? "terminated" : undefined);
            if (completionState === "forwarding") {
              if (publicationAwaitingCompletion) {
                // The first forwarded completion confirms the already-published initial turn.
                publishTurnComplete(result, effectiveStatus);
              } else {
                // Warm follow-up turns establish the same durable boundary before completion delivery.
                void publishResult(result, cwd).then(() => {
                  publishTurnComplete(result, effectiveStatus);
                });
              }
            } else if (completionState === "buffering") {
              pendingCompletions.push({ result, terminalStatus: effectiveStatus });
            }
          },
        }
      : baseAttemptOptions;
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
      let attempt: AttemptOutcome;
      // Hoisted out of the registry branch below because the failover decision
      // at the end of this iteration reads it, and the branch's own binding
      // dies with the `try` that resolves it. Left `undefined` by the legacy
      // path and by a resolution that throws before reaching the assignment,
      // which is what keeps both of those decisions exactly as they were.
      let resolvedCapabilities: BackendCapabilities | undefined;
      try {
        // An injected registry wins (tests and embedders supply one); otherwise
        // the workspace document decides, which is what makes `mode:
        // "backend-registry"` in `.pi/teammate-backends.json` actually switch
        // the dispatch path rather than only describe an intent.
        const registry = options.backendRegistry
          ?? dispatchRegistrySync(
            options.baseCwd,
            () => ({ hostOptions: attemptOptions, cwd, replyTo }),
            options.remoteManagerOf,
          );
        if (registry === undefined) {
          // A `cli/<tool>` model is served by a registered backend and by
          // nothing else. Legacy mode resolves no registry, so falling through
          // would hand the model id to a pi subprocess, which would ask a
          // provider for a model literally named `cli/<tool>` and fail with a
          // message about an unknown model rather than about the mode.
          if (modelToUse !== undefined && isCliToolModel(modelToUse)) {
            return rejectAndPublish(
              `Teammate task requests model "${modelToUse}", but .pi/teammate-backends.json is in legacy `
              + `execution mode; set mode "backend-registry" and register "${cliToolNameFromModel(modelToUse)}" `
              + "— refusing to run a CLI tool model on the pi subprocess path",
            );
          }
          attempt = outcomeOf(await runSingleAttempt(
            params, agentConfig, cwd, correlationId, replyTo, startTime, modelToUse, attemptOptions,
          ));
        } else {
          const spec = backendSpecOf(params, cwd, modelToUse, remoteRouting);
          const { backend, config, capabilities } = await registry.resolve(spec, spec.backend);
          resolvedCapabilities = capabilities;
          // Adjudicate here too, not only in `runGraph`. Five production call
          // sites dispatch a single teammate directly, and a task whose backend
          // cannot serve a required capability was reaching the model anyway:
          // the field was dropped in silence, so the transcript looked like a
          // successful run that simply never used the queue. Rejecting before
          // `backend.start` keeps the promise adjudication makes — the missing
          // capability surfaces without burning a model turn.
          const capabilityErrors = validateBackendCapabilities(
            [{ spec, ...(spec.name === undefined ? {} : { name: spec.name }) }],
            () => ({ name: backend.name, capabilities }),
          ).errors;
          if (capabilityErrors.length > 0) {
            // The resolved backend does not vary with the model candidate, so
            // no later candidate can serve this task either. Settling the trial
            // permit is left to the `finally` below, which is reached with
            // `settled` still false and releases a HALF_OPEN acquisition
            // exactly once. Releasing here as well called `releaseCandidate`
            // twice, and that method re-opens the circuit rather than handing
            // an unspent permit back — a backend whose capabilities do not
            // match the task was charging a model's health for it.
            return rejectAndPublish(capabilityErrors.join("\n"));
          }
          // Whether the backend published a channel of its own. Tracked rather
          // than decided by backend name: a backend that spawns a child hands
          // the host a real pipe carrying lease control and a session dir, and
          // replacing that with a translation would lose both.
          let publishedOwnChannel = false;
          const hostOnChildSpawned = attemptOptions.onChildSpawned;
          const backendOptions = backendOptionsOf(
            correlationId,
            // The host base, not `cwd`: the resolved task directory is on the
            // spec, and sending it twice leaves a backend unable to tell which
            // channel a task-level cwd actually arrived on.
            options.baseCwd,
            {
              ...attemptOptions,
              onChildSpawned: (stdin, sendControl, sessionDir, childId, generation) => {
                publishedOwnChannel = true;
                hostOnChildSpawned?.(stdin, sendControl, sessionDir, childId, generation);
              },
            },
            params.agent,
            startTime,
            config,
          );
          const run = await backend.start(spec, backendOptions);
          // Cancellation reaches the seam only through the control channel; a
          // host that merely stops awaiting leaves the runtime alive.
          const abortRun = (): void => { run.abort(); };
          options.signal?.addEventListener("abort", abortRun, { once: true });
          // Give the host a pipe it can address when the backend has none, so
          // teammate-send reaches a live runtime instead of reporting that it
          // cannot be restored. A backend that publishes its own later simply
          // replaces this one.
          const shim = publishedOwnChannel ? undefined : createBackendControlStdin(run);
          if (shim !== undefined) {
            hostOnChildSpawned?.(
              shim,
              // No IPC control channel exists for a backend addressed this way;
              // reporting that honestly beats accepting a lease update nothing
              // will ever deliver.
              () => false,
              undefined,
              correlationId,
              attemptOptions.runtimeGeneration,
            );
          }
          try {
            attempt = await run.outcome;
          } finally {
            options.signal?.removeEventListener("abort", abortRun);
            // A settled run can no longer deliver, and the host checks
            // `writable` before writing.
            if (shim !== undefined) closeBackendControlStdin(shim);
          }
          // Recorded by the dispatch rather than by the backend: a backend that
          // forgot to name itself would otherwise be indistinguishable from the
          // legacy path, which names nothing because no backend served it.
          attempt.result.backend = backend.name;
          // Emulation is recorded per run, so a consumer reading a structured
          // value can tell whether it came from a native contract or from
          // host-side extraction. Derived from the same adjudication the graph
          // ran, against the backend that actually served this attempt.
          const emulated = adjudicateTask(
            { spec, ...(spec.name === undefined ? {} : { name: spec.name }) },
            0,
            backend.name,
            capabilities,
          ).emulated;
          if (emulated.length > 0) {
            // Appended, not assigned: a backend records its own emulations on
            // the result it returns, and overwriting the list here would erase
            // them without a trace. The withheld branch below already appends.
            attempt.result.capabilityDeliveries = [
              ...(attempt.result.capabilityDeliveries ?? []),
              ...emulated.map((capability) => ({
                capability,
                support: "emulated" as const,
                note: `served by host-side compensation in backend "${backend.name}"`,
              })),
            ];
          }
        }
      } catch (error) {
        discardCompletion();
        throw error;
      }
      const candidateResult = attempt.result;
      attachDiscoveryWarning(candidateResult);
      lastResult = candidateResult;
      candidateResult.originCwd ??= cwd;
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
          // The original model failed (that is why a switch happened); only
          // the in-process successor models succeeded. Charge the original
          // like the B path would, so the breaker learns which model fails.
          if (switchedAwayFromOriginal) breaker.recordRetryableFailure(acquisition);
          else breaker.recordSuccess(acquisition);
          settled = true;
        }
        settlePendingModelAcquisitions(true);
        candidateResult.attemptedModels = attemptedModels.length > 1 ? attemptedModels : undefined;
        await publishResult(candidateResult, cwd);
        commitCompletion();
        return candidateResult;
      }

      if (options.signal?.aborted) {
        if (acquisition?.allowed) {
          breaker.releaseCandidate(acquisition);
          settled = true;
        }
        // A caller cancellation is not a model failure: release every
        // in-process switch trial instead of charging the models.
        for (const [, pendingAcquisition] of pendingModelAcquisitions) {
          breaker.releaseCandidate(pendingAcquisition);
        }
        pendingModelAcquisitions.clear();
        discardCompletion();
        return cancelAtBoundary("while a model candidate was running");
      }

      const error = resultFailureMessage(candidateResult.messages);
      const fallbackFailure = isFallbackProviderError(error);
      const recoveryFacts = attempt.recovery;
      const authoritativeFailure = recoveryFacts.settlementAuthority === "authoritative";
      const preActivityInfrastructureExit = recoveryFacts.preActivityInfrastructureExit;
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
      // Failover here would cost the run its diagnosis and buy nothing. Every
      // candidate after the first carries an explicit model, so the capability
      // gate above refuses the task before any of them starts — no remote
      // process and no tokens are saved, because none would have been spent.
      // What is saved is the diagnosis: without this, a capability refusal
      // about a candidate that never ran replaces the failure this run actually
      // observed.
      //
      // Only reachable when the caller named no model. A caller-named model
      // puts `spec.model` on the first candidate, so the gate refuses the whole
      // task outright and this path is never entered — which leaves exactly the
      // runs that produced a real provider diagnosis worth keeping.
      const modelSelectionUnsupported = resolvedCapabilities?.modelSelection === "unsupported";
      // A checkpoint published by this attempt (or a predecessor) enables the
      // resume path: the next candidate loads the recorded session under its
      // own model (`--session <checkpoint> --model <candidate>`), so tools
      // already executed stay in history instead of being replayed. The
      // side-effect fence therefore does not apply to resume-based failover —
      // the failed run's own session is preserved, not re-run from scratch.
      // The unknown-effect arm of the fence still applies: a tool that was
      // in flight when the run died may have produced external side effects
      // that are not yet recorded in the session, and a resumed model cannot
      // be trusted to skip them (the resume prompt only forbids repeating
      // calls whose results are already in history).
      const resumableCheckpoint = lastSessionFile !== undefined && fs.existsSync(lastSessionFile);
      const resumeUnknownEffect = recoveryFacts !== undefined
        && (recoveryFacts.inFlightToolCount > 0 || recoveryFacts.externalReplayRisk);
      const failoverConditionsMet = resumableCheckpoint && !resumeUnknownEffect
        ? fallbackFailure
        : replayFenceClear
          && ((fallbackFailure && authoritativeFailure) || preActivityInfrastructureExit);
      let fallbackEligible = failoverConditionsMet && !modelSelectionUnsupported;

      // Resume-based failover publishes the checkpoint handoff itself and is
      // not a blocked decision; only the fresh-replay paths below append
      // diagnostics.
      if (!resumableCheckpoint && fallbackFailure && !authoritativeFailure && !preActivityInfrastructureExit) {
        candidateResult.messages.push({
          role: "system",
          content:
            `Model fallback blocked because the child did not provide an authoritative settlement `
            + `(settlementAuthority=${recoveryFacts.settlementAuthority}). `
            + `Legacy or interrupted child streams have degraded recovery capability and cannot be fresh-replayed safely.`,
        });
      } else if (resumableCheckpoint && resumeUnknownEffect && fallbackFailure) {
        // A checkpoint exists but the failed run left a tool in flight or
        // external replay risk: resuming the session could repeat side
        // effects the history does not record. Block the resume path and
        // say why, so the run is not indistinguishable from a no-candidate
        // failure.
        candidateResult.messages.push({
          role: "system",
          content:
            `Model fallback blocked by the side-effect replay fence `
            + `(checkpoint present but inFlightTools=${recoveryFacts.inFlightToolCount}, `
            + `externalReplayRisk=${recoveryFacts.externalReplayRisk}). `
            + `A resumed model could repeat a tool whose effect is unknown; `
            + `the run settles as failed instead.`,
        });
      } else if (!resumableCheckpoint && (fallbackFailure || preActivityInfrastructureExit) && !replayFenceClear) {
        const completedTools = recoveryFacts.completedToolCount;
        const inFlightTools = recoveryFacts.inFlightToolCount;
        const externalReplayRisk = recoveryFacts.externalReplayRisk;
        // The remaining candidates were never tried, and not because no backend
        // could serve them. Without this a fenced run is indistinguishable from
        // one that simply had nothing left to fall back to.
        candidateResult.capabilityDeliveries = [
          ...(candidateResult.capabilityDeliveries ?? []),
          {
            capability: "modelSelection",
            support: "withheld",
            note:
              `the side-effect replay fence stopped failover after completedTools=${completedTools}, `
              + `inFlightTools=${inFlightTools}, externalReplayRisk=${externalReplayRisk}`,
          },
        ];
        candidateResult.messages.push({
          role: "system",
          content:
            `Model fallback blocked by the side-effect replay fence `
            + `(completedTools=${completedTools}, inFlightTools=${inFlightTools}, `
            + `externalReplayRisk=${externalReplayRisk}). `
            + `A fresh model process could repeat a completed tool, a tool whose effect is unknown, `
            + `or external work observed through child IPC/runtime diagnostics.`,
        });
      } else if (modelSelectionUnsupported && failoverConditionsMet) {
        // Every other condition for failover held, so without this record the
        // result is indistinguishable from one that had no candidate left.
        candidateResult.capabilityDeliveries = [
          ...(candidateResult.capabilityDeliveries ?? []),
          {
            capability: "modelSelection",
            support: "withheld",
            note:
              `backend "${candidateResult.backend}" declares modelSelection is unsupported, `
              + `so capability adjudication would refuse every remaining model candidate before it started `
              + `and that refusal would replace this run's own failure`,
          },
        ];
        candidateResult.messages.push({
          role: "system",
          content:
            `Model fallback blocked because backend "${candidateResult.backend}" declares `
            + `modelSelection is unsupported. Each remaining candidate names a model this backend `
            + `cannot select, so capability adjudication would refuse it before it started and you `
            + `would be shown that refusal instead of the failure reported above.`,
        });
      }

      if (fallbackEligible) {
        // Awaiting here serialises attempts: the replacement must not start
        // while the failed runtime may still deliver callbacks.
        const reclamation = await attempt.reclamation;
        if (reclamation.status === "unreaped") {
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
        settlePendingModelAcquisitions(false);
        discardCompletion();
        const kind = preActivityInfrastructureExit ? "non-retryable" : classifyRetryError(error);
        // D1-A: an auth failure marks this provider's credential as bad —
        // remaining same-provider candidates will fail identically, so skip
        // them instead of launching doomed subprocesses.
        if (kind === "auth" && modelToUse !== undefined) {
          const failedProvider = providerOf(modelToUse);
          if (failedProvider !== undefined) authSkippedProviders.add(failedProvider);
        }
        // Resume handoff: the next candidate loads this attempt's recorded
        // session under its own model instead of replaying the task from the
        // start. `resumePrompt` replaces the original task text as the initial
        // prompt (the task already lives inside the loaded session history),
        // directing the model to continue from the recorded state.
        if (resumableCheckpoint) {
          resumeHandoff = lastSessionFile;
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
      settlePendingModelAcquisitions(false);
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

  if (options.signal?.aborted) return cancelAtBoundary("after model candidate processing");
  if (lastResult) {
    lastResult.attemptedModels = attemptedModels.length > 1 ? attemptedModels : undefined;
    await publishResult(lastResult, cwd);
    publishTurnComplete(lastResult);
    return lastResult;
  }
  return rejectAndPublish(
    `Teammate skipped every model candidate because their circuit breakers are open (agent=${params.agent}).`,
  );
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

  // Capability adjudication sits beside the structural checks, not at dispatch.
  // A task whose backend cannot produce structured output would otherwise burn
  // a full model turn before its downstream sibling's {name.field} read failed.
  let graphRegistry;
  try {
    graphRegistry = options.backendRegistry
      ?? dispatchRegistrySync(
        options.baseCwd,
        () => {
          throw new Error("capability adjudication never starts a run");
        },
        options.remoteManagerOf,
      );
  } catch (cause) {
    // A malformed or unloadable registration is a graph-level rejection, not a
    // throw out of runGraph: every other validation failure settles each task
    // so the caller and the UI see a result rather than a pending row.
    return publishGraphRejection(
      `Teammate backend registry could not be loaded: ${String(cause)}`,
      deps,
    );
  }
  if (graphRegistry !== undefined) {
    const registry = graphRegistry;
    const adjudicated = tasks.map((task) => ({
      // NormalizedTask holds the prompt in `prompt`; without this the
      // adjudicated spec would carry an empty task while dispatch sends the
      // real one, and any routing rule reading it would disagree with dispatch.
      spec: backendSpecOf(
        { ...task, task: task.prompt },
        task.cwd ?? options.baseCwd,
        task.model,
        remoteLocationRouting(task.cwd),
      ),
      ...(task.name === undefined ? {} : { name: task.name }),
    }));
    let backends;
    try {
      backends = await Promise.all(adjudicated.map(async ({ spec }) => {
        // Same selector dispatch will use; adjudicating the default while
        // dispatch runs a task-named backend would check the wrong table.
        const { backend, capabilities } = await registry.resolve(spec, spec.backend);
        return { name: backend.name, capabilities };
      }));
    } catch (cause) {
      return publishGraphRejection(
        `Teammate backend could not be resolved for this graph: ${String(cause)}`,
        deps,
      );
    }
    const verdict = validateBackendCapabilities(adjudicated, (_task, index) => backends[index]!);
    if (verdict.errors.length > 0) {
      return publishGraphRejection(verdict.errors.join("\n"), deps);
    }
    for (const warning of verdict.warnings) {
      options.onProgress?.({
        agent: "teammate",
        status: "running",
        recentTools: [],
        toolCount: 0,
        tokens: 0,
        durationMs: 0,
        lastActivityAt: Date.now(),
        startedAt: Date.now(),
        lastMessage: warning,
      });
    }
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

  function reportTaskQueue(
    task: NormalizedTask,
    taskIndex: number,
    phase: Extract<AgentRunPhase, "waiting-dependency" | "waiting-capacity">,
    queuedAt: number,
  ): void {
    const now = Date.now();
    try {
      options.onProgress?.({
        agent: task.agent,
        name: task.name,
        correlationId: taskCorrelationIds[taskIndex],
        taskIndex,
        dependencies: deps[taskIndex],
        status: "pending",
        phase,
        recentTools: [],
        toolCount: 0,
        tokens: 0,
        durationMs: Math.max(0, now - queuedAt),
        lastActivityAt: now,
        startedAt: queuedAt,
      });
    } catch {
      // Queue progress is advisory and cannot interrupt graph scheduling.
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
    const queuedAt = Date.now();
    reportTaskQueue(
      task,
      idx,
      deps[idx].length > 0 ? "waiting-dependency" : "waiting-capacity",
      queuedAt,
    );
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

    const resolvedTaskBoundaryError = taskPromptBoundaryError(resolvedTask);
    if (resolvedTaskBoundaryError) {
      publishSyntheticFailure(task, idx, `Resolved task prompt ${resolvedTaskBoundaryError}.`);
      notifyComplete(idx);
      return;
    }

    if (deps[idx].length > 0) {
      reportTaskQueue(task, idx, "waiting-capacity", queuedAt);
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
          name: task.name,
          backend: task.backend,
          task: resolvedTask,
          context: task.context,
          model: task.model,
          fallbackModels: task.fallbackModels,
          thinking: task.thinking,
          cwd: task.cwd,
          outputSchema: task.outputSchema,
          todos: task.todos,
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
  const prepared = prepareTeammateMode(params);
  const routed = applyModelRouting(
    prepared,
    options.baseCwd,
    options.modelCapabilities?.map((capability) => capability.id) ?? [],
    undefined,
    options.inheritModel,
  );
  // Per-role circuit policies take effect at dispatch time: the breaker used
  // by the candidate sweep adopts the configured threshold/cooldown for each
  // role's mapped model before any acquisition happens.
  syncModelCircuitPolicies(options.modelCircuitBreaker ?? sharedModelCircuitBreaker, options.baseCwd);
  const normalized = normalizeTeammateParams(routed);
  if (normalized.error) throw new Error(normalized.error);
  return runGraph(normalized.tasks, prepared.concurrency ?? 4, options);
}

// ---------------------------------------------------------------------------
// RPC: Send message to running agent via stdin
// ---------------------------------------------------------------------------




