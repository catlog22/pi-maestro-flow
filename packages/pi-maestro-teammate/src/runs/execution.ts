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
import { logDiagnosticError, logDiagnosticWarn } from "../shared/diagnostic-log.ts";

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
  TeammateExecutionProvenance,
  AgentTurnEvent,
  AgentTurnTriggerContextV1,
} from "../shared/types.ts";
import {
  AGENT_TURN_VERSION,
  normalizeMessageProvenanceV1,
} from "../shared/types.ts";
import { wrapLeasedMessage, type LeaseToken } from "./session-handoff.ts";
import {
  applyModelRouting,
  canHotSwitchModelRegistration,
  resolveModelRegistrationRouting,
  syncModelCircuitPolicies,
  type ResolvedModelRegistrationCandidate,
  type ResolvedModelRegistrationRouting,
  type TeammateTaskType,
} from "../models/model-routing.ts";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import {
  rankModelsByHealth,
  sharedModelCircuitBreaker,
  sharedModelHealthCoordinator,
  type AcquiredModelCandidate,
  type AcquiredModelHealthCandidate,
  type ModelCircuitBreaker,
  type ModelHealthCoordinator,
} from "../models/model-circuit-breaker.ts";
import { getTeammateChildExtensions, getTeammateChildToolBroker } from "./child-extensions.ts";
import {
  parseTeammateThinkingLevel,
  type TeammateThinkingInput,
  type TeammateThinkingLevel,
} from "../shared/thinking.ts";
import {
  classifyModelHealthFailure,
  classifyRetryError,
  extractRetryAfterMs,
  isFallbackProviderError,
  ModelHealthAttemptState,
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
  validateBackendModelSpecifier,
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
import { assembleTaskPrompt } from "./briefing.ts";
import type {
  JsonLineEvent,
  ModelRegistryDispatchContext,
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
import {
  backendRegistryConfigSync,
  dispatchRegistryForProjectionSync,
  dispatchRegistrySync,
  modelRegistryPairSync,
  PI_SUBPROCESS,
} from "../backends/registry-host.ts";
import { runSingleAttempt } from "./pi-subprocess-attempt.ts";
import type {
  AttemptOutcome,
  BackendCapabilities,
  BackendRunOptions,
  ConfigValue,
} from "pi-maestro-backend-core/v1/backend";
import type {
  BackendRegistry,
  ResolvedBackend,
} from "pi-maestro-backend-core/v1/registry";
import type { TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";

export {
  TOOL_EXECUTION_HEARTBEAT_MS,
  resolveAgentCacheRetention,
  hasRpcTurnSidecar,
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

interface ModelRegistryRunBinding {
  hostOptions: RunTeammateOptions;
  cwd: string;
  replyTo: ReplyTarget;
}

interface MutableModelRegistryDispatchContext extends ModelRegistryDispatchContext {
  readonly plansByCorrelationId: Map<string, ResolvedModelRegistrationRouting>;
  readonly resolutionsByCorrelationId: Map<string, Map<string, ResolvedBackend>>;
}

const modelRegistryRunBindings = new WeakMap<
  ModelRegistryDispatchContext,
  Map<string, ModelRegistryRunBinding>
>();
const hostRegistryProvenanceResults = new WeakMap<SingleResult, TeammateExecutionProvenance>();

export function hostRegistryResultProvenance(
  result: SingleResult,
): TeammateExecutionProvenance | undefined {
  const provenance = hostRegistryProvenanceResults.get(result);
  return provenance === undefined ? undefined : structuredClone(provenance);
}

function captureModelRegistryAuthority(
  options: RunTeammateOptions,
): ModelRegistryDispatchContext["authority"] | undefined {
  const captured = options.modelRegistryDispatch?.authority ?? options.modelRegistryAuthority;
  if (captured !== undefined) return captured;
  // Preserve the frozen 2.0 document/cache path exactly. The revision-aware
  // reader is consulted only after that path has already opted into
  // model-registry mode.
  if ((backendRegistryConfigSync(options.baseCwd).mode ?? "legacy") !== "model-registry") {
    return undefined;
  }
  return modelRegistryPairSync(options.baseCwd)?.dispatch;
}

function createModelRegistryDispatchContext(
  authority: ModelRegistryDispatchContext["authority"],
  options: RunTeammateOptions,
): MutableModelRegistryDispatchContext {
  const bindings = new Map<string, ModelRegistryRunBinding>();
  const registry = options.backendRegistry ?? dispatchRegistryForProjectionSync(
    authority,
    (_spec, backendOptions) => {
      const binding = bindings.get(backendOptions.correlationId);
      if (binding === undefined) {
        throw new Error(
          `Model-registry backend started without an admitted run binding for correlationId=${backendOptions.correlationId}.`,
        );
      }
      return binding;
    },
    options.remoteManagerOf,
  );
  const context: MutableModelRegistryDispatchContext = {
    authority,
    registry,
    modelHealthCoordinator: (
      options.modelHealthCoordinator ?? sharedModelHealthCoordinator
    ).createProjectionView(authority),
    plansByCorrelationId: new Map(),
    resolutionsByCorrelationId: new Map(),
  };
  modelRegistryRunBindings.set(context, bindings);
  return context;
}

function modelRegistrationPlan(
  authority: ModelRegistryDispatchContext["authority"],
  params: Pick<RunSingleTeammateParams, "model" | "fallbackModels" | "backend" | "cwd">,
  agentConfig?: AgentConfig,
): ResolvedModelRegistrationRouting {
  return resolveModelRegistrationRouting(authority, {
    model: params.model ?? agentConfig?.model,
    fallbackModels: params.fallbackModels ?? agentConfig?.fallbackModels,
    backend: params.backend,
    cwd: params.cwd,
  });
}

function isRemoteModelRegistration(candidate: ResolvedModelRegistrationCandidate): boolean {
  return candidate.deployment.runtime.transport.kind === "remote-worker";
}

function ownsResumablePiCheckpoint(candidate: ResolvedModelRegistrationCandidate): boolean {
  const transport = candidate.deployment.runtime.transport;
  return candidate.deployment.registration.module === PI_SUBPROCESS
    && candidate.deployment.runtime.harness === "pi"
    && transport.kind === "local-process"
    && transport.protocol === "pi-rpc";
}

function canResumePiCheckpoint(
  from: ResolvedModelRegistrationCandidate,
  to: ResolvedModelRegistrationCandidate,
): boolean {
  return from.route.deploymentId === to.route.deploymentId
    && ownsResumablePiCheckpoint(from)
    && ownsResumablePiCheckpoint(to);
}

function hasRemoteModelDispatchAuthority(options: RunTeammateOptions): boolean {
  try {
    return options.authorizeRemoteModelDispatch?.() === true;
  } catch {
    return false;
  }
}

function modelRegistrationBackendSpecOf(
  params: RunSingleTeammateParams,
  cwd: string,
  candidate: ResolvedModelRegistrationCandidate,
): TeammateRunSpec {
  const selector = candidate.route.selector;
  return {
    agent: params.agent,
    task: params.task ?? "",
    ...(params.name === undefined ? {} : { name: params.name }),
    // TeammateBackend v1 has no deployment field. The selected canonical
    // deployment travels through its existing registration selector.
    backend: candidate.route.deploymentId,
    ...(params.context === undefined ? {} : { context: params.context }),
    // Fixed and deployment-default routes are selected by registration alone.
    // Only adapter-model owns a backend model selector value.
    ...(selector.kind === "adapter-model" ? { model: selector.value } : {}),
    ...(params.thinking === undefined ? {} : { thinking: params.thinking as TeammateRunSpec["thinking"] }),
    ...(params.outputSchema === undefined ? {} : { outputSchema: params.outputSchema }),
    ...(params.todos === undefined ? {} : { todos: params.todos }),
    ...(isRemoteModelRegistration(candidate) ? {} : { cwd }),
  };
}

async function preflightModelRegistrationPlan(
  context: MutableModelRegistryDispatchContext,
  correlationId: string,
  params: RunSingleTeammateParams,
  cwd: string,
  plan: ResolvedModelRegistrationRouting,
  options: RunTeammateOptions,
  graphTaskCount = 1,
): Promise<string[]> {
  const resolutions = new Map<string, ResolvedBackend>();
  const warnings = (await Promise.all(plan.candidates.map(async (candidate) => {
    if (isRemoteModelRegistration(candidate)) {
      if (graphTaskCount > 1) {
        throw new Error(
          `Remote model registration ${JSON.stringify(candidate.modelRegistrationId)} supports only single-task dispatches; graph remote execution is not enabled.`,
        );
      }
      if (!hasRemoteModelDispatchAuthority(options)) {
        throw new Error(
          `Remote model registration ${JSON.stringify(candidate.modelRegistrationId)} requires current root Monitor authority.`,
        );
      }
    }
    const spec = modelRegistrationBackendSpecOf(params, cwd, candidate);
    const resolved = await context.registry.resolve(spec, candidate.route.deploymentId);
    const verdict = validateBackendCapabilities(
      [{ spec, ...(spec.name === undefined ? {} : { name: spec.name }) }],
      () => ({ name: resolved.backend.name, capabilities: resolved.capabilities }),
    );
    if (verdict.errors.length > 0) throw new Error(verdict.errors.join("\n"));
    resolutions.set(candidate.modelRegistrationId, resolved);
    return verdict.warnings;
  }))).flat();
  context.plansByCorrelationId.set(correlationId, plan);
  context.resolutionsByCorrelationId.set(correlationId, resolutions);
  return warnings;
}

function candidateForRuntimeModel(
  plan: ResolvedModelRegistrationRouting,
  deploymentId: string,
  runtimeModel: string | undefined,
): ResolvedModelRegistrationCandidate | undefined {
  if (runtimeModel === undefined) return undefined;
  return plan.candidates.find((candidate) =>
    candidate.route.deploymentId === deploymentId
    && (candidate.modelRegistrationId === runtimeModel
      || (candidate.route.selector.kind === "adapter-model"
        && candidate.route.selector.value === runtimeModel)));
}

function registryResultCandidate(
  result: SingleResult,
  plan: ResolvedModelRegistrationRouting,
  initialCandidate: ResolvedModelRegistrationCandidate,
): ResolvedModelRegistrationCandidate {
  const candidate = candidateForRuntimeModel(
    plan,
    initialCandidate.route.deploymentId,
    result.model,
  ) ?? initialCandidate;
  result.model = candidate.modelRegistrationId;
  return candidate;
}

function executionTransportProvenance(
  candidate: ResolvedModelRegistrationCandidate,
): TeammateExecutionProvenance["transport"] {
  const transport = candidate.deployment.runtime.transport;
  switch (transport.kind) {
    case "local-process":
      return { kind: transport.kind, protocol: transport.protocol };
    case "acp-direct-ssh":
      return { kind: transport.kind, protocol: transport.protocol };
    case "dsh-direct-ssh":
      return { kind: transport.kind, protocol: transport.protocol };
    case "remote-worker":
      return {
        kind: transport.kind,
        gateway: transport.gateway,
        protocol: transport.protocol,
        driver: transport.driver,
      };
    case "adapter-owned":
      return { kind: transport.kind };
  }
}

function attachRegistryResultProvenance(
  result: SingleResult,
  context: ModelRegistryDispatchContext,
  plan: ResolvedModelRegistrationRouting,
  initialCandidate: ResolvedModelRegistrationCandidate,
): void {
  const candidate = registryResultCandidate(result, plan, initialCandidate);
  const provenance: TeammateExecutionProvenance = {
    registryVersion: context.authority.registryVersion,
    registryRevision: context.authority.revision,
    registryHash: context.authority.hash,
    modelRegistrationId: candidate.modelRegistrationId,
    modelId: candidate.route.modelId,
    deploymentId: candidate.route.deploymentId,
    harness: candidate.deployment.runtime.harness,
    transport: executionTransportProvenance(candidate),
  };
  result.provenance = provenance;
  hostRegistryProvenanceResults.set(result, structuredClone(provenance));
}

function removeUntrustedResultProvenance(result: SingleResult): void {
  delete result.provenance;
  hostRegistryProvenanceResults.delete(result);
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

const PROGRESS_PHASES: readonly AgentRunPhase[] = [
  "waiting-dependency", "waiting-capacity", "starting", "restoring", "prompting",
  "tool-execution", "result-ready", "retrying", "compacting", "continuing", "settling",
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
  const phase = PROGRESS_PHASES.find((candidate) => candidate === data.phase);
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
    ...(phase === undefined ? {} : { phase }),
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
  // Briefing assembly before any use of params.task so every downstream path
  // (spawn stdin, resume prompt, rejection echo) sees the same final text.
  if (params.briefing && params.briefing.length > 0) {
    params = { ...params, task: assembleTaskPrompt(params.task ?? "", params.briefing) };
  }
  const startTime = Date.now();
  const correlationId = options.correlationId ?? randomUUID();
  const initialTurnContext: AgentTurnTriggerContextV1 = options.initialTurnContext ?? {
    version: AGENT_TURN_VERSION,
    turnId: randomUUID(),
    correlationId,
    runtimeGeneration: options.runtimeGeneration ?? 0,
    promptSeq: 1,
    trigger: normalizeMessageProvenanceV1(
      options.initialMessageProvenanceOf?.(correlationId) ?? options.initialMessageProvenance,
    ),
  };
  let latestTurnEvent: AgentTurnEvent | undefined;
  let cancellationTurnRecorded = false;
  let rejectionModel = params.model;
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
    model: rejectionModel ?? "unknown",
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
    } else {
      // Pre-launch rejections (rejectAndPublish) and caller cancellations
      // (cancelAtBoundary) never reach publishResult, so the result has no
      // publicationId. Durable completion delivery requires one for every
      // result; mint a fresh id here rather than letting durableResources
      // throw "has no immutable publicationId".
      result.publicationId ??= randomUUID();
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
      logDiagnosticWarn(
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

  let modelRegistryContext = options.modelRegistryDispatch as MutableModelRegistryDispatchContext | undefined;
  try {
    const authority = captureModelRegistryAuthority(options);
    if (authority !== undefined && modelRegistryContext === undefined) {
      modelRegistryContext = createModelRegistryDispatchContext(authority, options);
    }
  } catch (error) {
    return rejectAndPublish(
      `Teammate model registry could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const remoteRouting = remoteLocationRouting(params.cwd);
  if (remoteRouting !== undefined && modelRegistryContext === undefined) {
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

  const legacyPiResumeDeploymentKey = (model: string | undefined): string | undefined => {
    if (modelRegistryContext !== undefined || options.backendRegistry !== undefined) return undefined;
    const config = backendRegistryConfigSync(options.baseCwd);
    const requestedBackend = backendNameOf(params, model, remoteRouting);
    if ((config.mode ?? "legacy") === "legacy") {
      return requestedBackend === undefined ? `legacy:${PI_SUBPROCESS}` : undefined;
    }
    const deploymentId = requestedBackend ?? config.default;
    return config.backends[deploymentId]?.module === PI_SUBPROCESS
      ? `backend-registry:${deploymentId}`
      : undefined;
  };

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

  // AC7: Model fallback. Registry mode resolves canonical registrations from
  // one authority projection and preflights the complete explicit chain before
  // any backend starts. Legacy/backend-registry retain their existing model
  // namespace and implicit fallback heuristics below.
  let registrationPlan: ResolvedModelRegistrationRouting | undefined;
  const breaker = options.modelCircuitBreaker ?? sharedModelCircuitBreaker;
  const modelHealth: ModelHealthCoordinator | undefined = modelRegistryContext?.modelHealthCoordinator;
  const modelHealthAttempt = modelRegistryContext === undefined
    ? undefined
    : new ModelHealthAttemptState(modelRegistryContext.authority.hash);
  let candidates: string[];

  if (modelRegistryContext !== undefined) {
    try {
      registrationPlan = modelRegistryContext.plansByCorrelationId.get(correlationId)
        ?? modelRegistrationPlan(modelRegistryContext.authority, params, agentConfig);
      rejectionModel = registrationPlan.candidates[0]?.modelRegistrationId ?? rejectionModel;
      if (!modelRegistryContext.resolutionsByCorrelationId.has(correlationId)) {
        await preflightModelRegistrationPlan(
          modelRegistryContext,
          correlationId,
          params,
          cwd,
          registrationPlan,
          options,
        );
      }
      candidates = registrationPlan.candidates.map((candidate) => candidate.modelRegistrationId);
    } catch (error) {
      return rejectAndPublish(
        `Teammate model registration preflight failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    candidates = buildModelCandidates(
      params.model ?? agentConfig.model,
      params.fallbackModels ?? agentConfig.fallbackModels,
    );
    try {
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index]!;
        // Whoever executes the task owns the model namespace. A candidate routed
        // to a registered backend names a model in that backend's catalogue, so
        // the host neither validates its format nor resolves its bare names.
        if (backendNameOf(params, candidate, remoteRouting) !== undefined) {
          validateBackendModelSpecifier(candidate);
          continue;
        }
        candidates[index] = resolveModelSpecifier(candidate, options.modelCapabilities);
      }
      candidates.splice(0, candidates.length, ...new Set(candidates));
    } catch (error) {
      return rejectAndPublish(error instanceof Error ? error.message : String(error));
    }
  }

  // When no explicit model or fallbacks are configured, only the legacy path
  // tries the Pi default followed by every authenticated model. Model-registry
  // mode has an explicit defaultModel registration and never consults this
  // heuristic.
  const implicitFallbacks = modelRegistryContext === undefined && candidates.length === 0
    ? (options.modelCapabilities ?? []).map((capability) => capability.id)
    : [];
  const baseCandidates: Array<string | undefined> = candidates.length > 0
    ? candidates
    : [undefined, ...implicitFallbacks];
  // Health-order only the fallback tail; the configured primary stays first.
  const modelCandidates: Array<string | undefined> = baseCandidates.length > 1
    ? [
        baseCandidates[0],
        ...(modelRegistryContext === undefined
          ? rankModelsByHealth(
              baseCandidates.slice(1).filter((model): model is string => model !== undefined),
              breaker,
            )
          : modelHealth!.rankCandidates(
              baseCandidates.slice(1).filter((model): model is string => model !== undefined),
            )),
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
    const trustedProvenance = lastResult === undefined
      ? undefined
      : hostRegistryResultProvenance(lastResult);
    if (trustedProvenance !== undefined) {
      result.provenance = trustedProvenance;
      hostRegistryProvenanceResults.set(result, structuredClone(trustedProvenance));
    }
    if (resolvedRunCwd) result.originCwd ??= resolvedRunCwd;
    if (!cancellationTurnRecorded && latestTurnEvent && options.recordTurnEvent) {
      cancellationTurnRecorded = true;
      const timestamp = Math.max(Date.now(), latestTurnEvent.timestamp + 1);
      options.recordTurnEvent({
        version: latestTurnEvent.version,
        turnId: latestTurnEvent.turnId,
        correlationId: latestTurnEvent.correlationId,
        runtimeGeneration: latestTurnEvent.runtimeGeneration,
        promptSeq: latestTurnEvent.promptSeq,
        loopSeq: latestTurnEvent.loopSeq,
        trigger: latestTurnEvent.trigger,
        timestamp,
        type: "terminated",
        outcome: "terminated",
        reason: cancellationMessage,
        ...("lastMessage" in latestTurnEvent && latestTurnEvent.lastMessage
          ? { lastMessage: latestTurnEvent.lastMessage }
          : {}),
      });
    }
    publishTurnComplete(result, "terminated");
    return result;
  };

  const waitForRetry = options.waitForRetry ?? waitForRetryDelay;
  let candidateIndex = 0;
  let processCandidateCount = 0;
  let nextCandidateLoopSeqOffset = 0;
  let failedCandidateCount = 0;
  // The provider heuristic remains legacy-only. Registry mode suppresses auth
  // by canonical deployment/route scope through ModelHealthAttemptState.
  const authSkippedProviders = new Set<string>();
  type CandidatePermit =
    | { kind: "legacy"; acquisition: AcquiredModelCandidate }
    | { kind: "registry"; acquisition: AcquiredModelHealthCandidate };

  const acquireCandidatePermit = (model: string | undefined): CandidatePermit | null | undefined => {
    if (model === undefined) return undefined;
    if (modelRegistryContext === undefined) {
      const acquisition = breaker.acquireCandidate(model);
      return acquisition.allowed ? { kind: "legacy", acquisition } : null;
    }
    const target = modelHealth!.resolveTarget(model);
    if (target === undefined) throw new TypeError(`Unknown canonical model health target ${JSON.stringify(model)}.`);
    if (modelHealthAttempt!.shouldSkip(target)) return null;
    const acquisition = modelHealth!.acquireCandidate(model);
    return acquisition.allowed ? { kind: "registry", acquisition } : null;
  };
  const recordPermitSuccess = (permit: CandidatePermit): void => {
    if (permit.kind === "legacy") breaker.recordSuccess(permit.acquisition);
    else modelHealth!.recordSuccess(permit.acquisition);
  };
  const recordPermitFailure = (permit: CandidatePermit, error: string): ReturnType<typeof classifyModelHealthFailure> | undefined => {
    if (permit.kind === "legacy") {
      breaker.recordRetryableFailure(permit.acquisition);
      return undefined;
    }
    const classification = classifyModelHealthFailure(
      { message: error },
      options.modelHealthFailureScopeClassifier,
    );
    if (classification.affectsCircuit && classification.scope !== "none") {
      modelHealth!.recordFailure(permit.acquisition, classification.scope);
      modelHealthAttempt!.noteFailure(permit.acquisition.target, classification);
    } else {
      modelHealth!.cancelCandidate(permit.acquisition);
    }
    return classification;
  };
  const releasePermit = (permit: CandidatePermit): void => {
    if (permit.kind === "legacy") breaker.releaseCandidate(permit.acquisition);
    else modelHealth!.releaseCandidate(permit.acquisition);
  };
  const cancelPermit = (permit: CandidatePermit): void => {
    if (permit.kind === "legacy") breaker.cancelCandidate(permit.acquisition);
    else modelHealth!.cancelCandidate(permit.acquisition);
  };

  // Acquisitions taken by in-process model switches. Registry keys are always
  // canonical registration ids even though Pi receives adapter selector values.
  const pendingModelAcquisitions = new Map<string, CandidatePermit>();
  let switchedAwayFromOriginal = false;
  const switchedModels = new Set<string>();
  const settlePendingModelAcquisitions = (success: boolean, error?: string): void => {
    for (const [, permit] of pendingModelAcquisitions) {
      if (success) recordPermitSuccess(permit);
      else if (permit.kind === "legacy") breaker.recordRetryableFailure(permit.acquisition);
      else recordPermitFailure(permit, error ?? "provider failure");
    }
    pendingModelAcquisitions.clear();
  };
  // Session checkpoint of the most recent Pi candidate that published one.
  // Registry mode also pins the deployment that owns it: only another route on
  // that exact local Pi deployment can consume the session safely.
  let lastSessionFile: string | undefined;
  let lastSessionCandidate: ResolvedModelRegistrationCandidate | undefined;
  let lastSessionDeploymentKey: string | undefined;
  interface ReplayFenceTotals {
    completedToolCount: number;
    inFlightToolCount: number;
    externalReplayRisk: boolean;
  }
  interface PendingResumeHandoff extends ReplayFenceTotals {
    sessionFile: string;
    sourceCandidate?: ResolvedModelRegistrationCandidate;
    sourceDeploymentKey?: string;
    freshReplayClear: boolean;
  }
  const replayTotals: ReplayFenceTotals = {
    completedToolCount: 0,
    inFlightToolCount: 0,
    externalReplayRisk: false,
  };
  let resumeHandoff: PendingResumeHandoff | undefined;
  const appendReplayFenceDiagnostic = (
    result: SingleResult,
    facts: ReplayFenceTotals,
    checkpointReason?: string,
  ): void => {
    result.capabilityDeliveries = [
      ...(result.capabilityDeliveries ?? []),
      {
        capability: "modelSelection",
        support: "withheld",
        note:
          `the side-effect replay fence stopped failover after completedTools=${facts.completedToolCount}, `
          + `inFlightTools=${facts.inFlightToolCount}, externalReplayRisk=${facts.externalReplayRisk}`,
      },
    ];
    result.messages.push({
      role: "system",
      content:
        `Model fallback blocked by the side-effect replay fence `
        + `(completedTools=${facts.completedToolCount}, inFlightTools=${facts.inFlightToolCount}, `
        + `externalReplayRisk=${facts.externalReplayRisk}). `
        + (checkpointReason === undefined ? "" : `${checkpointReason} `)
        + `A fresh model process could repeat a completed tool, a tool whose effect is unknown, `
        + `or external work observed through child IPC/runtime diagnostics.`,
    });
  };

  for (const modelToUse of modelCandidates) {
    if (options.signal?.aborted) return cancelAtBoundary("before a model candidate launched");
    if (modelToUse && modelToUse === resolvedDefaultModel) continue;
    const candidateProvider = modelRegistryContext === undefined && modelToUse
      ? providerOf(modelToUse)
      : undefined;
    if (candidateProvider !== undefined && authSkippedProviders.has(candidateProvider)) continue;
    candidateIndex += 1;
    const permit = acquireCandidatePermit(modelToUse);
    if (permit === null) continue;
    const registrationCandidate = modelToUse === undefined
      ? undefined
      : registrationPlan?.candidates.find((candidate) => candidate.modelRegistrationId === modelToUse);
    if (modelRegistryContext !== undefined && registrationCandidate === undefined) {
      return rejectAndPublish(`Unknown canonical model registration ${JSON.stringify(modelToUse)} in pinned dispatch plan.`);
    }

    const pendingHandoff = resumeHandoff;
    let handoff: string | undefined;
    if (pendingHandoff !== undefined) {
      const canResume = fs.existsSync(pendingHandoff.sessionFile)
        && (modelRegistryContext === undefined
          ? pendingHandoff.sourceDeploymentKey !== undefined
            && pendingHandoff.sourceDeploymentKey === legacyPiResumeDeploymentKey(modelToUse)
          : pendingHandoff.sourceCandidate !== undefined
            && registrationCandidate !== undefined
            && canResumePiCheckpoint(pendingHandoff.sourceCandidate, registrationCandidate));
      resumeHandoff = undefined;
      if (canResume) {
        handoff = pendingHandoff.sessionFile;
      } else {
        // This candidate starts from spec.task. The old Pi checkpoint no longer
        // represents its history and must not leak into a later fallback.
        lastSessionFile = undefined;
        lastSessionCandidate = undefined;
        lastSessionDeploymentKey = undefined;
        if (!pendingHandoff.freshReplayClear) {
          const sourceDeployment = pendingHandoff.sourceCandidate?.route.deploymentId
            ?? pendingHandoff.sourceDeploymentKey;
          const targetDeployment = registrationCandidate?.route.deploymentId;
          if (lastResult !== undefined) {
            appendReplayFenceDiagnostic(
              lastResult,
              pendingHandoff,
              `The Pi checkpoint from deployment ${JSON.stringify(sourceDeployment ?? "legacy-pi")} `
              + `cannot resume candidate ${JSON.stringify(modelToUse ?? "default")} on deployment `
              + `${JSON.stringify(targetDeployment ?? "non-pi")}; that candidate would replay the original task.`,
            );
          }
          if (permit !== undefined) cancelPermit(permit);
          break;
        }
      }
    }
    if (modelToUse) recordAttemptedModel(modelToUse);
    processCandidateCount += 1;
    const candidateLoopSeqOffset = nextCandidateLoopSeqOffset;
    let candidateMaxLoopSeq = candidateLoopSeqOffset;

    let settled = false;
    let completionState: "buffering" | "forwarding" | "discarded" = "buffering";
    const pendingCompletions: Array<{
      result: SingleResult;
      terminalStatus?: AgentTerminalStatus;
    }> = [];
    const pendingTerminalTurnEvents: AgentTurnEvent[] = [];
    // Capture the child's published session file so a mid-run failure under
    // this candidate can resume that checkpoint only on a compatible Pi route.
    const hostOnChildEvent = options.onChildEvent;
    // In-process model failover: when the child settles a retryable provider
    // failure while still alive, pick the next healthy candidate from the
    // remaining chain and hand it to the child's `set_model` RPC. The same
    // session continues in place, so nothing is replayed. Models already
    // switched to within this run are excluded, and a model that actually ran
    // (acknowledged switch) but failed again is settled immediately instead
    // of waiting for the run's terminal result.
    const nextCandidateModel = (error: string, previousModel?: string): string | undefined => {
      const previousCandidateId = modelRegistryContext !== undefined
        && registrationCandidate !== undefined
        && registrationPlan !== undefined
        ? candidateForRuntimeModel(
            registrationPlan,
            registrationCandidate.route.deploymentId,
            previousModel,
          )?.modelRegistrationId
        : previousModel;
      if (previousCandidateId !== undefined) {
        const previousPermit = pendingModelAcquisitions.get(previousCandidateId);
        if (previousPermit !== undefined) {
          recordPermitFailure(previousPermit, error);
          pendingModelAcquisitions.delete(previousCandidateId);
        }
      } else if (modelRegistryContext !== undefined && permit !== undefined && !settled) {
        // Settle the failed original route before acquiring another route on
        // the same deployment. This releases the paired deployment permit and
        // lets a route-scoped Pi failure hot-switch without violating the
        // single half-open deployment trial invariant.
        recordPermitFailure(permit, error);
        settled = true;
      }

      const tail = modelCandidates.slice(candidateIndex).filter((candidate) => (
        candidate !== undefined
        && candidate !== modelToUse
        && candidate !== resolvedDefaultModel
        && !switchedModels.has(candidate)
      )) as string[];
      const ranked = modelRegistryContext === undefined
        ? rankModelsByHealth(tail, breaker)
        : modelHealth!.rankCandidates(tail);
      for (const candidate of ranked) {
        const hotCandidate = registrationPlan?.candidates.find((entry) => entry.modelRegistrationId === candidate);
        if (modelRegistryContext !== undefined) {
          if (
            registrationCandidate === undefined
            || hotCandidate === undefined
            || !canHotSwitchModelRegistration(registrationCandidate, hotCandidate)
          ) continue;
        } else {
          const candidateProvider = providerOf(candidate);
          if (candidateProvider !== undefined && authSkippedProviders.has(candidateProvider)) continue;
        }
        const nextPermit = acquireCandidatePermit(candidate);
        if (nextPermit === null || nextPermit === undefined) continue;
        pendingModelAcquisitions.set(candidate, nextPermit);
        switchedModels.add(candidate);
        recordAttemptedModel(candidate);
        if (previousModel === undefined) switchedAwayFromOriginal = true;
        return hotCandidate?.route.selector.kind === "adapter-model"
          ? hotCandidate.route.selector.value
          : candidate;
      }
      return undefined;
    };
    const hasHotSwitchCandidate = modelCandidates.slice(candidateIndex).some((candidate) => {
      if (candidate === undefined) return false;
      if (modelRegistryContext === undefined) return true;
      const target = registrationPlan?.candidates.find((entry) => entry.modelRegistrationId === candidate);
      return registrationCandidate !== undefined
        && target !== undefined
        && canHotSwitchModelRegistration(registrationCandidate, target);
    });
    const baseAttemptOptions: RunTeammateOptions = {
      ...options,
      initialTurnContext,
      turnLoopSeqOffset: candidateLoopSeqOffset,
      emitInitialTurnTrigger: processCandidateCount === 1,
      ...(handoff === undefined ? {} : {
        resumeSessionFile: handoff,
        resumePrompt: MODEL_FALLBACK_RESUME_PROMPT,
      }),
      ...(registrationCandidate !== undefined && options.onProgress !== undefined ? {
        onProgress: (data: AgentProgress): void => {
          const requested = candidateForRuntimeModel(
            registrationPlan!,
            registrationCandidate.route.deploymentId,
            data.requestedModel,
          )?.modelRegistrationId ?? registrationCandidate.modelRegistrationId;
          const resolved = candidateForRuntimeModel(
            registrationPlan!,
            registrationCandidate.route.deploymentId,
            data.resolvedModel,
          )?.modelRegistrationId ?? requested;
          options.onProgress?.({
            ...data,
            requestedModel: requested,
            resolvedModel: resolved,
            attemptedModels: [...attemptedModels],
          });
        },
      } : {}),
      ...(options.onResultPublished !== undefined ? {
        onResultPublished: async (result: SingleResult, originCwd: string): Promise<void> => {
          if (registrationCandidate === undefined) {
            removeUntrustedResultProvenance(result);
          } else {
            attachRegistryResultProvenance(
              result,
              modelRegistryContext!,
              registrationPlan!,
              registrationCandidate,
            );
            result.attemptedModels = attemptedModels.length > 1 ? [...attemptedModels] : undefined;
          }
          await options.onResultPublished?.(result, originCwd);
        },
      } : {}),
      // Only arm an in-process switch when Pi can select the successor through
      // another adapter-model registration on this exact deployment.
      ...(hasHotSwitchCandidate
        ? { onModelFailover: (error: string, previousModel?: string) => nextCandidateModel(error, previousModel) }
        : {}),
      onChildEvent: (event) => {
        if (event.type === "teammate_session_ready" && typeof event.sessionFile === "string") {
          lastSessionFile = event.sessionFile;
          lastSessionCandidate = registrationCandidate;
          lastSessionDeploymentKey = registrationCandidate === undefined
            ? legacyPiResumeDeploymentKey(modelToUse)
            : undefined;
        } else if (event.type === "teammate_model_switch_abandoned" && typeof event.model === "string") {
          // The switch never reached Pi's ack, so the target model never ran.
          // Release its trial acquisition instead of charging a phantom
          // failure at the terminal settlement.
          const abandonedId = registrationCandidate !== undefined
            ? candidateForRuntimeModel(
                registrationPlan!,
                registrationCandidate.route.deploymentId,
                event.model,
              )?.modelRegistrationId
            : event.model;
          const abandoned = abandonedId === undefined
            ? undefined
            : pendingModelAcquisitions.get(abandonedId);
          if (abandoned !== undefined) {
            releasePermit(abandoned);
            pendingModelAcquisitions.delete(abandonedId!);
          }
        }
        hostOnChildEvent?.(event);
      },
      ...(options.recordTurnEvent === undefined ? {} : {
        recordTurnEvent: (event: AgentTurnEvent): void => {
          latestTurnEvent = event;
          candidateMaxLoopSeq = Math.max(candidateMaxLoopSeq, event.loopSeq);
          const terminal = event.type === "turn-settled"
            || event.type === "failed"
            || event.type === "terminated";
          if (!terminal) {
            if (completionState !== "discarded") options.recordTurnEvent?.(event);
            return;
          }
          if (completionState === "forwarding") options.recordTurnEvent?.(event);
          else if (completionState === "buffering") pendingTerminalTurnEvents.push(event);
        },
      }),
    };
    const attemptOptions: RunTeammateOptions = options.onTurnComplete || options.onResultPublished
      ? {
          ...baseAttemptOptions,
          onTurnComplete(result, terminalStatus) {
            if (registrationCandidate === undefined) {
              removeUntrustedResultProvenance(result);
            } else {
              attachRegistryResultProvenance(
                result,
                modelRegistryContext!,
                registrationPlan!,
                registrationCandidate,
              );
              result.attemptedModels = attemptedModels.length > 1 ? [...attemptedModels] : undefined;
            }
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
      for (const event of pendingTerminalTurnEvents.splice(0)) {
        options.recordTurnEvent?.(event);
      }
      for (const completion of pendingCompletions.splice(0)) {
        publishTurnComplete(completion.result, completion.terminalStatus);
      }
    };
    const discardCompletion = (): void => {
      completionState = "discarded";
      pendingCompletions.length = 0;
      pendingTerminalTurnEvents.length = 0;
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
        const registry = modelRegistryContext?.registry
          ?? options.backendRegistry
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
          // An explicit backend selector is the same kind of routing decision,
          // and legacy mode can serve neither. Falling through would run the pi
          // subprocess under a name the task did not ask for, which is the one
          // outcome a routing decision must not have; it would also hand pi a
          // model specifier written in the named backend's namespace, since the
          // host stopped validating those the moment a backend claimed them.
          if (params.backend !== undefined) {
            return rejectAndPublish(
              `Teammate task selects backend "${params.backend}", but .pi/teammate-backends.json is in `
              + `legacy execution mode; set mode "backend-registry" and register "${params.backend}" `
              + "— refusing to run a backend-selected task on the pi subprocess path",
            );
          }
          attempt = outcomeOf(await runSingleAttempt(
            params, agentConfig, cwd, correlationId, replyTo, startTime, modelToUse, attemptOptions,
          ));
        } else {
          const spec = registrationCandidate === undefined
            ? backendSpecOf(params, cwd, modelToUse, remoteRouting)
            : modelRegistrationBackendSpecOf(params, cwd, registrationCandidate);
          if (registrationCandidate !== undefined
            && isRemoteModelRegistration(registrationCandidate)
            && !hasRemoteModelDispatchAuthority(options)) {
            return rejectAndPublish(
              `Remote model registration ${JSON.stringify(registrationCandidate.modelRegistrationId)} lost root Monitor authority before launch.`,
            );
          }
          const preflightResolution = registrationCandidate === undefined
            ? undefined
            : modelRegistryContext?.resolutionsByCorrelationId
              .get(correlationId)
              ?.get(registrationCandidate.modelRegistrationId);
          const { backend, config, capabilities } = preflightResolution
            ?? await registry.resolve(spec, spec.backend);
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
          const bindings = modelRegistryContext === undefined
            ? undefined
            : modelRegistryRunBindings.get(modelRegistryContext);
          if (bindings !== undefined) {
            bindings.set(correlationId, { hostOptions: attemptOptions, cwd, replyTo });
          }
          let run: import("pi-maestro-backend-core/v1/backend").BackendRun;
          try {
            run = await backend.start(spec, backendOptions);
          } catch (error) {
            bindings?.delete(correlationId);
            throw error;
          }
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
            bindings?.delete(correlationId);
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
      nextCandidateLoopSeqOffset = Math.max(
        nextCandidateLoopSeqOffset + 1,
        candidateMaxLoopSeq + 1,
      );
      if (registrationCandidate === undefined) {
        removeUntrustedResultProvenance(candidateResult);
      } else {
        attachRegistryResultProvenance(
          candidateResult,
          modelRegistryContext!,
          registrationPlan!,
          registrationCandidate,
        );
      }
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
        if (permit !== undefined && !settled) {
          // Preserve the legacy hot-switch charge while registry mode settles
          // the original failure inside the switch hook before acquiring the
          // successor's scoped permit.
          if (permit.kind === "legacy" && switchedAwayFromOriginal) {
            breaker.recordRetryableFailure(permit.acquisition);
          } else {
            recordPermitSuccess(permit);
          }
          settled = true;
        }
        settlePendingModelAcquisitions(true);
        candidateResult.attemptedModels = attemptedModels.length > 1 ? attemptedModels : undefined;
        await publishResult(candidateResult, cwd);
        commitCompletion();
        return candidateResult;
      }

      if (options.signal?.aborted) {
        if (permit !== undefined && !settled) {
          releasePermit(permit);
          settled = true;
        }
        // A caller cancellation is not a model failure: release every
        // in-process switch trial instead of charging the models.
        for (const [, pendingPermit] of pendingModelAcquisitions) {
          releasePermit(pendingPermit);
        }
        pendingModelAcquisitions.clear();
        discardCompletion();
        return cancelAtBoundary("while a model candidate was running");
      }

      const error = resultFailureMessage(candidateResult.messages);
      let registryFailureClassification: ReturnType<typeof classifyModelHealthFailure> | undefined;
      if (modelRegistryContext !== undefined) {
        if (permit !== undefined && !settled) {
          registryFailureClassification = recordPermitFailure(permit, error);
          settled = true;
        }
        settlePendingModelAcquisitions(false, error);
      }
      const fallbackFailure = isFallbackProviderError(error);
      const recoveryFacts = attempt.recovery;
      const authoritativeFailure = recoveryFacts.settlementAuthority === "authoritative";
      const preActivityInfrastructureExit = recoveryFacts.preActivityInfrastructureExit;
      // Fresh replay must account for every effect in a same-session fallback
      // chain, not only the final Pi process that happened to fail.
      replayTotals.completedToolCount += recoveryFacts.completedToolCount;
      replayTotals.inFlightToolCount += recoveryFacts.inFlightToolCount;
      replayTotals.externalReplayRisk ||= recoveryFacts.externalReplayRisk;
      const replayFenceClear = !buildReplayFence({
        completedToolCount: replayTotals.completedToolCount,
        unknownEffect: replayTotals.inFlightToolCount > 0 || replayTotals.externalReplayRisk,
        blockedReason:
          `Fresh replay blocked after completedTools=${replayTotals.completedToolCount}, `
          + `inFlightTools=${replayTotals.inFlightToolCount}, externalReplayRisk=${replayTotals.externalReplayRisk}.`,
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
      const modelSelectionUnsupported = modelRegistryContext === undefined
        && resolvedCapabilities?.modelSelection === "unsupported";
      // A checkpoint bypasses the fresh-replay fence only provisionally. The
      // next actually admitted candidate must still prove that it is another
      // route on the exact local Pi deployment that owns this session.
      const checkpointOwnedByPi = modelRegistryContext === undefined
        ? lastSessionDeploymentKey !== undefined
        : lastSessionCandidate !== undefined && ownsResumablePiCheckpoint(lastSessionCandidate);
      const resumableCheckpoint = checkpointOwnedByPi
        && lastSessionFile !== undefined
        && fs.existsSync(lastSessionFile);
      const resumeUnknownEffect = replayTotals.inFlightToolCount > 0
        || replayTotals.externalReplayRisk;
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
            + `(checkpoint present but inFlightTools=${replayTotals.inFlightToolCount}, `
            + `externalReplayRisk=${replayTotals.externalReplayRisk}). `
            + `A resumed model could repeat a tool whose effect is unknown; `
            + `the run settles as failed instead.`,
        });
      } else if (!resumableCheckpoint && (fallbackFailure || preActivityInfrastructureExit) && !replayFenceClear) {
        appendReplayFenceDiagnostic(candidateResult, replayTotals);
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
        if (permit?.kind === "legacy" && !settled) {
          if (preActivityInfrastructureExit) breaker.releaseCandidate(permit.acquisition);
          else breaker.recordRetryableFailure(permit.acquisition);
          settled = true;
        }
        if (modelRegistryContext === undefined) settlePendingModelAcquisitions(false);
        discardCompletion();
        const kind = registryFailureClassification?.retryKind
          ?? (preActivityInfrastructureExit ? "non-retryable" : classifyRetryError(error));
        // Legacy credentials are provider-scoped. Registry mode already applied
        // canonical route/deployment auth suppression above.
        if (modelRegistryContext === undefined && kind === "auth" && modelToUse !== undefined) {
          const failedProvider = providerOf(modelToUse);
          if (failedProvider !== undefined) authSkippedProviders.add(failedProvider);
        }
        // Carry the checkpoint to the next admitted candidate. Compatibility is
        // checked there, after health/auth skips, before the candidate is
        // counted as attempted or allowed to start.
        if (resumableCheckpoint && lastSessionFile !== undefined) {
          resumeHandoff = {
            sessionFile: lastSessionFile,
            ...(lastSessionCandidate === undefined ? {} : { sourceCandidate: lastSessionCandidate }),
            ...(lastSessionDeploymentKey === undefined ? {} : { sourceDeploymentKey: lastSessionDeploymentKey }),
            freshReplayClear: replayFenceClear,
            completedToolCount: replayTotals.completedToolCount,
            inFlightToolCount: replayTotals.inFlightToolCount,
            externalReplayRisk: replayTotals.externalReplayRisk,
          };
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

      if (permit !== undefined && !settled) {
        releasePermit(permit);
        settled = true;
      }
      if (modelRegistryContext === undefined) settlePendingModelAcquisitions(false);
      candidateResult.attemptedModels = attemptedModels.length > 1 ? attemptedModels : undefined;
      commitCompletion();
      // The final failed candidate may bypass publishResult when no completion
      // observer armed the attempt options. Durable completion delivery
      // requires a publicationId on every result, so mint one here if the
      // attempt path never assigned one.
      candidateResult.publicationId ??= randomUUID();
      return candidateResult;
    } finally {
      // Every half-open permit must settle exactly once. releasePermit is a
      // no-op for ordinary CLOSED acquisitions.
      if (!settled && permit !== undefined) releasePermit(permit);
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
      // Graph-level rejections bypass runSingleTeammate's publishResult, so
      // durable completion delivery would otherwise throw on the missing
      // publicationId.
      publicationId: randomUUID(),
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

  let graphModelRegistryContext = options.modelRegistryDispatch as MutableModelRegistryDispatchContext | undefined;
  try {
    const authority = captureModelRegistryAuthority(options);
    if (authority !== undefined && graphModelRegistryContext === undefined) {
      graphModelRegistryContext = createModelRegistryDispatchContext(authority, options);
    }
    if (graphModelRegistryContext !== undefined) {
      const warningGroups = await Promise.all(tasks.map(async (task, index) => {
        const remote = remoteLocationRouting(task.cwd);
        const contained = resolveContainedCwd(
          remote === undefined ? task.cwd : undefined,
          options.baseCwd,
        );
        if ("error" in contained) throw new Error(contained.error);
        const discovery = discoverAgents(contained.cwd, { includeDiagnostics: true });
        const agentConfig = resolveAgent(discovery, task.agent);
        if (agentConfig === undefined) {
          const available = listAgentSummaries(discovery).map((agent) => agent.name).join(", ");
          throw new Error(`Unknown teammate agent "${task.agent}". Available agents: ${available || "(none)"}.`);
        }
        const params: RunSingleTeammateParams = {
          agent: task.agent,
          task: task.prompt,
          name: task.name,
          backend: task.backend,
          context: task.context,
          model: task.model,
          fallbackModels: task.fallbackModels,
          thinking: task.thinking,
          cwd: task.cwd,
          outputSchema: task.outputSchema,
          todos: task.todos,
          briefing: task.briefing,
        };
        const taskCorrelationId = taskCorrelationIds[index]!;
        const plan = graphModelRegistryContext!.plansByCorrelationId.get(taskCorrelationId)
          ?? modelRegistrationPlan(graphModelRegistryContext!.authority, params, agentConfig);
        if (graphModelRegistryContext!.resolutionsByCorrelationId.has(taskCorrelationId)) return [];
        return preflightModelRegistrationPlan(
          graphModelRegistryContext!,
          taskCorrelationId,
          params,
          contained.cwd,
          plan,
          options,
          tasks.length,
        );
      }));
      for (const warning of warningGroups.flat()) {
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
  } catch (cause) {
    return publishGraphRejection(
      `Teammate model registration preflight failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      deps,
    );
  }
  const graphRunOptions: RunTeammateOptions = graphModelRegistryContext === undefined
    ? options
    : { ...options, modelRegistryDispatch: graphModelRegistryContext };

  // Capability adjudication sits beside the structural checks, not at dispatch.
  // Registry-mode candidates were all adjudicated above; the frozen
  // legacy/backend-registry path keeps its existing primary-only check.
  let graphRegistry: BackendRegistry | undefined;
  try {
    graphRegistry = graphModelRegistryContext === undefined
      ? options.backendRegistry
        ?? dispatchRegistrySync(
          options.baseCwd,
          () => {
            throw new Error("capability adjudication never starts a run");
          },
          options.remoteManagerOf,
        )
      : undefined;
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
      // Synthetic failures bypass runSingleTeammate's publishResult, so durable
      // completion delivery would otherwise throw on the missing publicationId.
      publicationId: randomUUID(),
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
      if (graphRunOptions.signal?.aborted) {
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
          briefing: task.briefing,
        },
        {
          ...graphRunOptions,
          correlationId: taskCorrelationIds[idx],
          signal: graphRunOptions.taskSignals?.[idx] ?? graphRunOptions.signal,
          onProgress: graphRunOptions.onProgress
            ? (data) => {
                try {
                  graphRunOptions.onProgress?.({
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




