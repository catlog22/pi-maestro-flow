/**
 * Teammate Extension Entry Point
 *
 * Tools: teammate (dispatch), teammate-send (RPC message injection), teammate-list (status), observe
 * TUI: Alt+R mode-aware session list, widget above editor, Alt+B foreground→background detach
 * Mode: RPC subprocess — stdin open for steer/follow_up/abort
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Check } from "typebox/value";
import { isGuiTeammateToolAllowed, registerGuiTool, unregisterGuiTool } from "../shared/gui-registry.ts";
import { aggregateAgentRunPhase } from "../shared/agent-status.ts";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { TeammateParams, TeammateSendParams, TeammateListParams, TeammateWatchParams, TeammateWaitParams, TeammateMonitorParams, ObserveParams } from "./schemas.ts";
import {
  formatObserveResult,
  observeTargets,
  registerObservationProvider,
  type ObserveParams as UnifiedObserveParams,
  type ObserveResult,
  type ObservationProvider,
  type ObservationSnapshot,
  type ObservationWaitStatus,
} from "../public/v1/observation.ts";
import {
  formatCompact,
  formatVerbose,
  formatHeader,
  formatBarrierCompact,
  validateMonitorParams,
  MONITOR_STATUS_KEY,
  MONITOR_DEFAULT_TIMEOUT_MS,
  MONITOR_DEFAULT_LINES,
  createEngineState,
  startEngine,
  stopEngine,
  addBinding,
  removeBinding,
  clearBindings,
  formatEngineStatusBar,
  buildAutoAnalysisPrompt,
  buildCustomAnalysisPrompt,
  parseAnalysisResult,
  ENGINE_TICK_MS,
  type MonitorTargetSnapshot,
  type MonitorParams,
  type MonitorEngineState,
  type MonitorSupervisionMode,
  type EngineAgentInfo,
  type AnalysisResult,
} from "./monitor.ts";
import {
  createWorkspacePeerCommandConsumer,
  createWorkspacePeerRuntime,
  discoverWorkspacePeers,
  resolveWorkspaceTarget,
  sendWorkspacePeerCommand,
  type WorkspaceAgentSnapshot,
  type WorkspaceOwnerSnapshot,
  type WorkspaceOwnerState,
  type WorkspacePeerCommandConsumer,
  type WorkspacePeerPublisher,
  type WorkspacePeerWindowListing,
  type WorkspaceResolvedTarget,
  type WorkspaceSettledSnapshot,
} from "./workspace-peers.ts";
import {
  runSingleTeammate,
  runGraph,
  normalizeTeammateParams,
  inferGraphMode,
  taskDependencyNames,
  sendRpcMessage,
  truncateUtf8Tail,
  checkDepthGuard,
  dispatchAllowed,
  agentDispatchBudget,
  nestedChildMaxDispatchDepth,
  getTeammateDepth,
  MAX_DEFAULT_DEPTH,
  resolveMaxActiveAgents,
  isStructuredOutputSettlementDiagnostic,
} from "../runs/execution.ts";
import {
  confirmChildReloaded,
  confirmParked,
  canChildWrite,
  buildFenceRecoveryMessages,
  cancelPark,
  createChildLease,
  fenceLease,
  leaseToken,
  handoffBarrierReached,
  isSessionPathContained,
  leaseSelection,
  requestHandback,
  requestPark,
  recoverChild,
  restoreMainOwnership,
  sameLeaseSelection,
  sameLeaseToken,
  transitionLeaseIfCurrent,
  transferToMain,
  unwrapLeasedMessage,
  type LeaseSelection,
  type LeaseToken,
} from "../runs/session-handoff.ts";
import type {
  RunTeammateParams,
  RunTeammateOptions,
  RpcMessageMode,
  NormalizedTask,
} from "../runs/execution.ts";
import {
  auxToolCallFallback,
  auxToolResultFallback,
  renderQuietTeammateAux,
  renderTeammateCall,
  renderTeammateListCall,
  renderTeammateListResult,
  renderTeammateResult,
} from "../tui/render.ts";
import { AttachOverlay } from "../tui/attach-overlay.ts";
import {
  BracketedPasteDecoder,
  removeLastGrapheme,
  sanitizeSingleLineInput,
  type DecodedInputToken,
} from "../tui/input-text.ts";
import { showModelMappingOverlay } from "../tui/model-mapping-overlay.ts";
import { showMonitorOverlay, type MonitorSessionRow } from "../tui/monitor-overlay.ts";
import type {
  Details,
  TeammateState,
  AgentProgress,
  AgentProgressSnapshot,
  ChildAgentCallSnapshot,
  ActiveAgent,
  AgentStatus,
  AgentTerminalStatus,
  MessageEnvelope,
  SettledAgentRecord,
  SingleResult,
  StructuredResult,
  TeammateInteractionRecord,
} from "../shared/types.ts";

type TeammateToolResult<T> = AgentToolResult<T> & { isError?: boolean };

function isTeammateToolResult(value: unknown): value is TeammateToolResult<unknown> {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.content)
    && Object.prototype.hasOwnProperty.call(record, "details")
    && (record.isError === undefined || typeof record.isError === "boolean");
}
import {
  TEAMMATE_COMPLETE_EVENT,
  TEAMMATE_STARTED_EVENT,
  TEAMMATE_MESSAGE_EVENT,
} from "../shared/types.ts";
import {
  appendAgentCatalog,
  discoverAgents,
  formatAgentCatalog,
  invalidateAgentCatalogCache,
  listAgentSummaries,
  type AgentSummary,
} from "../agents/agents.ts";
import {
  appendModelCatalog,
  createModelCatalogSnapshot,
  type ModelCatalogSnapshot,
  type TeammateModelCapability,
} from "../models/model-catalog.ts";
import {
  applyModelRouting,
  formatModelRoutingConfig,
  parseTeammateTaskType,
  type TeammateTaskType,
} from "../models/model-routing.ts";
import type { TeammateThinkingInput } from "../shared/thinking.ts";
import {
  getTeammateChildToolBroker,
  getTeammatePermissionBroker,
  registerTeammateChildProxyCaller,
} from "../runs/child-extensions.ts";
import { setQuietMode } from "../quiet-state.ts";

import {
  AGENT_BUFFER_LIMITS,
  AGENT_WIDGET_IDLE_HIDE_MS,
  LIVE_AGENT_STATUSES,
  TEAMMATE_INTERACTION_QUEUE_LIMIT,
  TEAMMATE_INTERACTION_TIMEOUT_MS,
  TEAMMATE_PENDING_STALL_TIMEOUT_MS,
  TEAMMATE_STALL_TIMEOUT_MS,
  TEAMMATE_WAIT_DEFAULT_TIMEOUT_MS,
  TEAMMATE_WAIT_POLL_FLOOR_MS,
  WAKEABLE_AGENT_BUDGET,
  aggregateGraphStructuredOutput,
  appendAgentProgressLine,
  backgroundWaitGuidance,
  FOREGROUND_DETACH_HINT,
  registerForegroundDetach,
  canProxySendTo,
  checkActiveAgentBudget,
  createForegroundDeadline,
  createProgressFlushGate,
  displayMessageForResult,
  terminalStatusForResult,
  resultIsError,
  aggregateTerminalStatus,
  aggregateTerminalStatuses,
  emitTeammateStarted,
  foregroundWaitWindowMs,
  formatRetryDelay,
  handleChildLifecycleEvent,
  resolveProxyParentCorrelationId,
  summarizeGraphResults,
  toStructuredResults,
  emitTeammateResultPublished,
  setAgentStructuredOutput,
  trimAgentBuffers,
  wakeSleepingAgent,
} from "./index.ts";
import type { TeammateRuntimeOptions } from "./index.ts";

// Cross-imports from teammate-helpers.ts (settlement, wait, list/watch)
import {
  settleTeammateWaiters, waitForTeammate, waitOutput, statusForWatchTarget,
  settleAgent, settleGraphContainerAgent, settleGraphTaskAgent, settleAgentLifecycle,
  recordSettledAgent, findSettledAgent, retireAgent,
  killAgent, killAgentTree, releaseAgentMemory, sweepFailedAgents,
  terminateNestedDispatchesOwnedBy, enforceWakeableAgentBudget,
  reclaimResultReadyAgents, nextWakeableAgentExpiryDelay,
  terminateAndRemoveWakeableCohort, wakeableAgentCohorts,
  applyAgentRetryState, applyAgentResultReadyState, clearAgentResultReadyState,
  markSettledResultInspectable, recordChildReclamationOutcome, hasTeammateWidgetWork,
  emitComplete, safeSendMessage, notifyBackgroundFailure, replyProxyFailure,
  bindAgentName, removeAgentFromRegistry, resolveAgentCorrelationId,
  agentActiveMs, ts, buildAgentList, buildRoleList,
  handleChildInteractionRequest, handleChildRpcUiRequest,
  claimResultReadyNotice, watchTargetStalledAt,
} from "./teammate-helpers.ts";
import type {
  RelayedQuestion, RelayedQuestionOption, TeammateInteractionQueue,
  TeammateListView, TeammateWaitStatus, TeammateWaitResult,
  WatchTarget, AgentTargetSelector, ListedAgent,
  PendingTeammateWaiter, WakeableAgentCohort,
} from "./teammate-helpers.ts";


/**
 * Builds the serial queue that relays child permission/question requests to the
 * human. Serialization is deliberate — `ctx.ui.select` owns the terminal, so two
 * concurrent prompts would fight over it — but every entry is bounded and
 * cancellable, because the failure it guards against is a nested one: a parent
 * agent waits on a child, that child waits on a prompt, and that prompt waits
 * behind an unattended prompt belonging to an unrelated agent. Answering on the
 * child's behalf after a timeout keeps that chain from becoming permanent.
 */
export function createTeammateInteractionQueue(
  pi: ExtensionAPI,
  state: TeammateState,
  timeoutMs: number = TEAMMATE_INTERACTION_TIMEOUT_MS,
): TeammateInteractionQueue {
  interface Waiter {
    correlationId?: string;
    settle: (reason: string) => void;
  }
  let tail: Promise<void> = Promise.resolve();
  const waiting = new Map<string, Waiter>();

  const keyFor = (event: Record<string, unknown>): string => {
    if (typeof event.requestId === "string") return event.requestId;
    if (typeof event.id === "string") return event.id;
    return randomUUID();
  };

  const correlationFor = (
    event: Record<string, unknown>,
    fallbackCorrelationId?: string,
  ): string | undefined => (
    typeof event.correlationId === "string" ? event.correlationId : fallbackCorrelationId
  );

  const enqueue: TeammateInteractionQueue["enqueue"] = (
    event,
    reply,
    ctx,
    fallbackCorrelationId,
  ) => {
    const key = keyFor(event);
    if (waiting.size >= TEAMMATE_INTERACTION_QUEUE_LIMIT) {
      replyChildRequestFailure(
        event,
        reply,
        new Error(
          `Too many teammate interactions are already waiting for an answer (${waiting.size}). ` +
          `Answer the pending prompts, then retry.`,
        ),
      );
      return;
    }

    let settled = false;
    const interactionAbort = new AbortController();
    let releaseHandler!: () => void;
    const handlerCancelled = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const finishSettlement = (): void => {
      settled = true;
      waiting.delete(key);
      interactionAbort.abort();
      releaseHandler();
      const correlationId = correlationFor(event, fallbackCorrelationId);
      state.activeRuns.get(correlationId ?? "")?.pendingInteractions?.delete(key);
    };
    const failDelivery = (error: unknown): void => {
      const correlationId = correlationFor(event, fallbackCorrelationId);
      finishSettlement();
      if (!correlationId || !state.activeRuns.has(correlationId)) return;
      const message = `Teammate interaction reply delivery failed: ${error instanceof Error ? error.message : String(error)}`;
      settleAgent(state, correlationId, 1, message, false);
    };
    const guardedReply = (msg: unknown): void => {
      if (settled) return;
      try {
        reply(msg);
      } catch (error) {
        failDelivery(error);
        return;
      }
      finishSettlement();
    };
    const settle = (reason: string): void => {
      if (settled) return;
      try {
        replyChildRequestFailure(event, reply, new Error(reason));
      } catch (error) {
        failDelivery(error);
        return;
      }
      finishSettlement();
    };
    // PERFSEC-003: A duplicate requestId must not silently overwrite the
    // existing waiter — that orphans the old timer/promise and lets the old
    // timer's finishSettlement delete the *new* entry via the shared key.
    // Settle the previous waiter first so its resources are cleaned up.
    waiting.get(key)?.settle(
      "Superseded by a duplicate interaction request with the same requestId.",
    );
    waiting.set(key, { correlationId: correlationFor(event, fallbackCorrelationId), settle });

    // RPC UI requests (select/confirm/input/editor) wait on a human answer just
    // like relayed permission prompts. Recording them on the owning agent's
    // pending set makes statusForWatchTarget treat the wait as "awaiting
    // response" instead of reporting the agent as stalled after 30s idle — an
    // editor left open was previously both unstallable (no abort contract) and
    // invisible to the stall exemption, so teammate-wait misreported it as
    // stalled minutes before the 5-minute interaction timeout.
    if (event.type === "teammate_rpc_ui_request") {
      const rpcCorrelationId = correlationFor(event, fallbackCorrelationId);
      const rpcAgent = rpcCorrelationId ? state.activeRuns.get(rpcCorrelationId) : undefined;
      if (rpcAgent) {
        rpcAgent.pendingInteractions ??= new Map();
        rpcAgent.pendingInteractions.set(key, {
          requestId: key,
          interaction: `rpc:${typeof event.method === "string" ? event.method : "ui"}`,
          createdAt: Date.now(),
          payload: event,
        });
        rpcAgent.lastActivityAt = Date.now();
      }
    }

    // Armed on arrival, not on reaching the front of the queue: a request stuck
    // behind an unanswered prompt is exactly the case that must stay bounded,
    // and a timer that only starts at the front would never fire for it.
    const timer = setTimeout(
      () => settle(
        `No answer within ${Math.round(timeoutMs / 1000)}s; the teammate was told to cancel. ` +
        `The prompt may still be open if you want to answer it.`,
      ),
      timeoutMs,
    );
    timer.unref?.();

    tail = tail.then(async () => {
      // Settled while queued — cancelled or timed out, so do not seize the
      // terminal on its behalf.
      if (settled) return;
      try {
        const handler = event.type === "teammate_rpc_ui_request"
          ? handleChildRpcUiRequest(event, guardedReply, ctx, interactionAbort.signal)
          : handleChildInteractionRequest(
              pi,
              state,
              event,
              guardedReply,
              ctx,
              fallbackCorrelationId,
              interactionAbort.signal,
            );
        // editor() has no abortable dialog contract, but the serial queue must
        // not stay captured by a dialog that never closes: race the handler so
        // cancellation/timeout releases the tail and later interactions can
        // open even while this editor stays up. A late editor close resolves
        // the handler, whose guardedReply is then absorbed by the settled guard.
        await Promise.race([handler, handlerCancelled]);
      } catch (error) {
        if (!settled) replyChildRequestFailure(event, guardedReply, error);
      } finally {
        clearTimeout(timer);
        // A handler that returned without replying would otherwise leave the
        // child waiting forever on a request nothing will ever answer.
        settle("The interaction handler returned without an answer.");
      }
    });
  };

  return {
    enqueue,
    cancelForAgent(correlationId, reason) {
      let cancelled = 0;
      for (const waiter of [...waiting.values()]) {
        if (waiter.correlationId !== correlationId) continue;
        waiter.settle(reason);
        cancelled += 1;
      }
      return cancelled;
    },
    pendingCount: () => waiting.size,
  };
}

export function replyChildRequestFailure(
  event: Record<string, unknown>,
  reply: (msg: unknown) => void,
  error: unknown,
): void {
  if (event.type === "teammate_rpc_ui_request") {
    reply({
      type: "extension_ui_response",
      id: typeof event.id === "string" ? event.id : randomUUID(),
      cancelled: true,
    });
    return;
  }
  reply({
    type: "teammate_interaction_response",
    requestId: typeof event.requestId === "string" ? event.requestId : randomUUID(),
    result: {
      action: "cancel",
      error: error instanceof Error ? error.message : String(error),
    },
  });
}

export async function showRelayedPermission(
  ctx: ExtensionContext,
  agentLabel: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const toolName = typeof payload.toolName === "string" ? payload.toolName : "unknown tool";
  const reason = typeof payload.reason === "string" ? payload.reason : "User approval required.";
  const detail = interactionDetail(payload.input);
  const choice = await ctx.ui.select(
    `@${agentLabel} requests ${toolName}\n\n${detail}\n\n${reason}`,
    ["Allow once", "Always allow", "Deny"],
    { signal },
  );
  if (choice === "Allow once") return { action: "allow_once" };
  if (choice === "Always allow") return { action: "always_allow" };
  return { action: "deny" };
}

export async function showRelayedQuestions(
  ctx: ExtensionContext,
  agentLabel: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const questions = Array.isArray(payload.questions)
    ? payload.questions.filter(isRecord).map(normalizeRelayedQuestion).filter((q): q is RelayedQuestion => Boolean(q))
    : [];
  if (questions.length === 0) return { action: "cancel", error: "No valid questions" };

  const answers: Array<{
    question: string;
    header?: string;
    selected: string[];
    text?: string;
  }> = [];
  for (let index = 0; index < questions.length; index++) {
    const question = questions[index];
    const title = `@${agentLabel} · ${question.header ?? `Question ${index + 1}`}\n${question.question}`;
    const options = question.options ?? [];
    if (options.length === 0) {
      const text = await ctx.ui.input(title, "Enter response", { signal });
      if (text === undefined) return { action: "cancel" };
      answers.push({
        question: question.question,
        ...(question.header ? { header: question.header } : {}),
        selected: [],
        ...(text.trim() ? { text: text.trim() } : {}),
      });
      continue;
    }

    const normalizedOptions = options.some((option) => option.label === "None of the above")
      ? options
      : [...options, { label: "None of the above" }];
    const selected = question.multiSelect
      ? await selectMultiple(ctx, title, normalizedOptions, signal)
      : await selectOne(ctx, title, normalizedOptions, signal);
    if (!selected) return { action: "cancel" };
    let text: string | undefined;
    if (selected.includes("None of the above")) {
      const custom = await ctx.ui.input(
        title,
        "What would you like instead? (optional)",
        { signal },
      );
      if (custom === undefined) return { action: "cancel" };
      text = custom.trim() || undefined;
    }
    answers.push({
      question: question.question,
      ...(question.header ? { header: question.header } : {}),
      selected,
      ...(text ? { text } : {}),
    });
  }
  return { action: "answer", answers };
}

export async function selectOne(
  ctx: ExtensionContext,
  title: string,
  options: RelayedQuestionOption[],
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  const labels = options.map((option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`);
  const choice = await ctx.ui.select(title, labels, { signal });
  const index = choice ? labels.indexOf(choice) : -1;
  return index >= 0 ? [options[index].label] : undefined;
}

export async function selectMultiple(
  ctx: ExtensionContext,
  title: string,
  options: RelayedQuestionOption[],
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  const selected = new Set<number>();
  while (true) {
    const labels = options.map((option, index) =>
      `${selected.has(index) ? "[x]" : "[ ]"} ${index + 1}. ${option.label}`
    );
    const done = `Done (${selected.size})`;
    const choice = await ctx.ui.select(title, [...labels, done], { signal });
    if (choice === undefined) return undefined;
    if (choice === done) {
      return [...selected].sort((a, b) => a - b).map((index) => options[index].label);
    }
    const index = labels.indexOf(choice);
    if (index < 0) continue;
    if (options[index].label === "None of the above") {
      selected.clear();
      selected.add(index);
    } else {
      const noneIndex = options.findIndex((option) => option.label === "None of the above");
      if (noneIndex >= 0) selected.delete(noneIndex);
      if (selected.has(index)) selected.delete(index);
      else selected.add(index);
    }
  }
}

export function normalizeRelayedQuestion(value: Record<string, unknown>): RelayedQuestion | undefined {
  if (typeof value.question !== "string" || !value.question.trim()) return undefined;
  const options = Array.isArray(value.options)
    ? value.options.filter(isRecord).flatMap((option) =>
      typeof option.label === "string"
        ? [{
            label: option.label,
            ...(typeof option.description === "string" ? { description: option.description } : {}),
          }]
        : []
    )
    : undefined;
  return {
    question: value.question,
    ...(typeof value.header === "string" ? { header: value.header } : {}),
    ...(options ? { options } : {}),
    ...(value.multiSelect === true ? { multiSelect: true } : {}),
  };
}

export function replyInteraction(
  reply: (msg: unknown) => void,
  requestId: string,
  result: Record<string, unknown>,
): void {
  reply({ type: "teammate_interaction_response", requestId, result });
}

export function interactionDetail(value: unknown): string {
  if (!isRecord(value)) return "{}";
  const raw = typeof value.command === "string"
    ? value.command
    : typeof value.path === "string"
      ? value.path
      : typeof value.file_path === "string"
        ? value.file_path
        : JSON.stringify(value);
  return raw.length > 500 ? `${raw.slice(0, 497)}...` : raw;
}

export function questionSummary(value: unknown): string {
  if (!Array.isArray(value)) return "No questions";
  return value.filter(isRecord).map((question, index) =>
    `${index + 1}. ${typeof question.question === "string" ? question.question : "Invalid question"}`
  ).join("\n");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ===========================================================================
// Flat model: handle proxy requests from child processes
// ===========================================================================

export async function dispatchRegisteredChildTool(
  event: Record<string, unknown>,
  reply: (message: unknown) => void,
  state?: TeammateState,
  verifiedCorrelationId?: string,
): Promise<boolean> {
  const toolName = typeof event.tool === "string" ? event.tool : "";
  const broker = getTeammateChildToolBroker(toolName);
  if (!broker) return false;
  // Brokers act on `actor`, so it must be the identity this process verified,
  // not the one the child asked to be seen as.
  const correlationId = verifiedCorrelationId
    ?? resolveProxyParentCorrelationId(event, undefined, state)
    ?? "unknown";
  const active = state?.activeRuns.get(correlationId);
  const input = isRecord(event.params) ? event.params : {};
  const result = await broker({
    toolName,
    input,
    actor: {
      correlationId,
      ...(active?.name ? { name: active.name } : {}),
      ...(active?.agent ? { agent: active.agent } : {}),
    },
  });
  reply({
    type: "teammate_proxy_result",
    requestId: typeof event.requestId === "string" ? event.requestId : randomUUID(),
    result,
  });
  return true;
}

/**
 * Cancels the agent a proxy request created, once its requester gave up.
 *
 * The nested dispatch runs in this process while the child that asked for it
 * waits over IPC. If that wait ends first — its 30-minute ceiling, or the child
 * itself being aborted — nothing used to tell this side, and the agent kept
 * running with no consumer and nobody left to settle it. Returns the ids of the
 * agents torn down.
 */
export function cancelProxyDispatch(
  state: TeammateState,
  requestId: string,
  reason = "the requesting teammate gave up waiting",
): string[] {
  const observation = state.proxyObservationControllers?.get(requestId);
  if (observation) {
    state.proxyObservationControllers?.delete(requestId);
    observation.abort(reason);
    return [];
  }
  if (state.pendingProxyDispatchRequests?.delete(requestId)) {
    state.pendingProxyDispatchParents?.delete(requestId);
    return [];
  }
  state.pendingProxyDispatchParents?.delete(requestId);
  const cid = state.proxyDispatchByRequest?.get(requestId);
  if (!cid) return [];
  if (state.proxyDispatchByRequest?.get(requestId) === cid) {
    state.proxyDispatchByRequest.delete(requestId);
  }
  (state.cancelledProxyDispatches ??= new Map()).set(requestId, cid);
  const agent = state.activeRuns.get(cid);
  if (!agent) return [];
  agent.outputLog.push(
    `[${new Date().toISOString().slice(11, 19)}] ✗ cancelled: ${reason}.`,
  );
  return killAgentTree(state, cid);
}

export function beginProxyObservation(
  state: TeammateState,
  requestId: string,
  parentSignal?: AbortSignal,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const previous = state.proxyObservationControllers?.get(requestId);
  previous?.abort("proxy request replaced");
  (state.proxyObservationControllers ??= new Map()).set(requestId, controller);
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) controller.abort(parentSignal.reason);
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      parentSignal?.removeEventListener("abort", onParentAbort);
      if (state.proxyObservationControllers?.get(requestId) === controller) {
        state.proxyObservationControllers.delete(requestId);
      }
    },
  };
}

export async function withProxyObservation<T>(
  state: TeammateState,
  requestId: string,
  parentSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const pending = beginProxyObservation(state, requestId, parentSignal);
  try {
    return await run(pending.signal);
  } finally {
    pending.dispose();
  }
}

/** Records which agent a proxy request created, so a later give-up can find it. */
export function trackProxyDispatch(state: TeammateState, requestId: string, correlationId: string): void {
  (state.proxyDispatchByRequest ??= new Map()).set(requestId, correlationId);
}

/** Parse untrusted child IPC parameters before they enter shared normalization. */
export function parseProxyTeammateParams(
  params: Record<string, unknown>,
): RunTeammateParams | undefined {
  if (!Check(TeammateParams, params)) return undefined;
  // TypeBox admission requires each task-level prompt and validates the common
  // outputSchema root shape. Shared normalization remains the compatibility
  // and semantic-validation gate before any child is spawned.
  const tasks = params.tasks;
  return {
    ...params,
    taskType: parseTeammateTaskType(params.taskType),
    thinking: parseThinkingInput(params.thinking),
    outputSchema: parseOutputSchema(params.outputSchema),
    tasks: tasks.map((task) => ({
      ...task,
      prompt: task.prompt as string,
      taskType: parseTeammateTaskType(task.taskType),
      thinking: parseThinkingInput(task.thinking),
      outputSchema: parseOutputSchema(task.outputSchema),
    })),
  };
}

export function parseThinkingInput(value: unknown): TeammateThinkingInput | undefined {
  if (
    value === "off"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max"
  ) {
    return value;
  }
  return undefined;
}

export function parseOutputSchema(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export async function handleProxyRequest(
  pi: ExtensionAPI,
  state: TeammateState,
  event: Record<string, unknown>,
  rawReply: (msg: unknown) => void,
  spawnedBy?: string,
  modelCapabilities: readonly TeammateModelCapability[] = [],
  onInteraction?: (
    event: Record<string, unknown>,
    reply: (message: unknown) => void,
    correlationId: string,
  ) => void,
  onChildStatus?: (child: ChildAgentCallSnapshot) => void,
  runtimeOptions: TeammateRuntimeOptions = {},
  mailboxDeliver?: (request: {
    senderId: string;
    recipientId: string;
    recipientCorrelationId: string;
    kind: "lifecycle" | "result" | "steer" | "follow_up" | "task" | "control";
    mode: "steer" | "follow_up" | "abort" | "notify";
    payload: string;
  }) => Promise<{ path: string; result: { ok: boolean } }>,
  workspacePeerSend?: (target: string, message: string, mode: "steer" | "follow_up") => Promise<boolean>,
  workspacePeerList?: () => Promise<readonly WorkspacePeerWindowListing[]>,
  sessionSend?: (request: {
    selector: string;
    message: string;
    mode: "steer" | "follow_up" | "abort";
  }) => Promise<{
    delivered: boolean;
    error?: string;
    receipt?: { mode?: string; wasSleeping?: boolean; terminatedCount?: number };
  }>,
): Promise<void> {
  let replied = false;
  const reply = (message: unknown): void => {
    if (replied) return;
    rawReply(message);
    replied = true;
  };
  const tool = event.tool as string;
  const requestId = event.requestId as string;
  const params = event.params as Record<string, unknown>;
  const dispatchGeneration = state.sessionGeneration ?? 0;
  const ownsDispatchGeneration = (): boolean =>
    (state.sessionGeneration ?? 0) === dispatchGeneration;
  const parentCid = resolveProxyParentCorrelationId(event, spawnedBy, state);
  const parentSessionId = parentCid ? state.activeRuns.get(parentCid)?.sessionId : undefined;
  const reservesProxyDispatch = tool === "teammate" && typeof requestId === "string";
  if (reservesProxyDispatch) {
    const duplicate = state.pendingProxyDispatchRequests?.has(requestId)
      || state.proxyDispatchByRequest?.has(requestId)
      || state.cancelledProxyDispatches?.has(requestId);
    if (duplicate) {
      reply({
        type: "teammate_proxy_result",
        requestId,
        result: {
          content: [{ type: "text", text: `Duplicate in-flight teammate proxy requestId: ${requestId}` }],
          isError: true,
          details: { mode: "single", results: [] },
        },
      });
      return;
    }
    (state.pendingProxyDispatchRequests ??= new Set()).add(requestId);
    if (parentCid) (state.pendingProxyDispatchParents ??= new Map()).set(requestId, parentCid);
  }
  const abandonPendingProxyDispatch = (): void => {
    if (!reservesProxyDispatch) return;
    state.pendingProxyDispatchRequests?.delete(requestId);
    state.pendingProxyDispatchParents?.delete(requestId);
  };

  try {
    if (await dispatchRegisteredChildTool(event, reply, state, parentCid)) {
      abandonPendingProxyDispatch();
      return;
    }

    switch (tool) {
    case "teammate": {
      const p = parseProxyTeammateParams(params);
      if (!p) {
        abandonPendingProxyDispatch();
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: "Invalid teammate parameters received from child IPC." }],
          isError: true,
          details: { mode: "single", results: [] },
        }});
        return;
      }
      const cid = randomUUID();

      // Nested dispatches execute inside this process, so PI_TEAMMATE_DEPTH
      // would always read 0 here. The spawner's recorded depth is the only
      // authority for how deep the tree already is.
      const dispatchDepth = (parentCid ? state.activeRuns.get(parentCid)?.depth ?? 0 : 0) + 1;
      const budgetParent = parentCid ? state.activeRuns.get(parentCid) : undefined;
      const parentBudget = budgetParent ? agentDispatchBudget(budgetParent) : MAX_DEFAULT_DEPTH - 1;
      const depthCheck = checkDepthGuard(dispatchDepth);
      const budgetCheck = dispatchAllowed(parentBudget, dispatchDepth);
      if (!depthCheck.allowed || !budgetCheck) {
        abandonPendingProxyDispatch();
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: parentBudget === 0
            ? "Teammate nesting is disabled for this agent: the parent dispatch set maxNestingDepth: 0. Complete the assigned work directly and do not attempt further delegation."
            : `Teammate nesting depth exceeded: current=${depthCheck.current}, max=${depthCheck.max}. Prevent recursive fork-bomb.` }],
          isError: true, details: { mode: "single", results: [] },
        }});
        return;
      }
      const parentModel = (() => {
        const parent = parentCid ? state.activeRuns.get(parentCid) : undefined;
        return parent?.resolvedModel ?? parent?.requestedModel;
      })();
      const dispatchOriginCwd = state.baseCwd || process.cwd();
      const routedParams = applyModelRouting(
        p,
        dispatchOriginCwd,
        modelCapabilities.map((model) => model.id),
        undefined,
        parentModel,
      );

      // Normalize (shared with the root tool execute path). The root process is
      // the routing authority because the child catalog can be stale or scoped.
      const normalization = normalizeTeammateParams(routedParams);
      if (normalization.error) {
        abandonPendingProxyDispatch();
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: normalization.error }],
          isError: true, details: { mode: "single", results: [] },
        }});
        return;
      }
      const allTasks = normalization.tasks;
      const budget = checkActiveAgentBudget(state, allTasks.length);
      if (!budget.allowed) {
        abandonPendingProxyDispatch();
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{
            type: "text",
            text: `Teammate agent budget exhausted: ${budget.active} agents are already live; `
              + `${allTasks.length} more requested (max ${budget.max}). `
              + "Wait for running agents to settle, or raise PI_TEAMMATE_MAX_ACTIVE_AGENTS.",
          }],
          isError: true,
          details: {
            mode: normalization.isMultiTask ? inferGraphMode(allTasks) : "single",
            results: [],
          },
        }});
        return;
      }
      const singleTask = allTasks[0];
      const normalizedTasks = normalization.isMultiTask ? allTasks : null;
      // The parent's budget is the hard cap; the call's own maxNestingDepth
      // (per-task wins, else the top-level value) can only tighten it. Each
      // normalized task already carries its effective value (task ?? top-level).
      const childMaxDispatchDepth = normalizedTasks
        ? Math.min(...allTasks.map((task) => nestedChildMaxDispatchDepth(parentBudget, dispatchDepth, task.maxNestingDepth)))
        : nestedChildMaxDispatchDepth(parentBudget, dispatchDepth, singleTask.maxNestingDepth);
      const singleRunParams = {
        agent: singleTask.agent,
        task: singleTask.prompt,
        taskType: singleTask.taskType,
        name: singleTask.name,
        reply_to: routedParams.reply_to,
        context: singleTask.context,
        model: singleTask.model,
        fallbackModels: singleTask.fallbackModels,
        thinking: singleTask.thinking,
        cwd: singleTask.cwd,
        outputSchema: singleTask.outputSchema,
      };
      const warningPrefix = normalization.warnings.length
        ? normalization.warnings.map((w) => `[warn] ${w}`).join("\n") + "\n\n"
        : "";

      if (!state.pendingProxyDispatchRequests?.delete(requestId)) {
        state.pendingProxyDispatchParents?.delete(requestId);
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: "Nested teammate dispatch cancelled before launch." }],
          isError: true,
          details: {
            mode: normalization.isMultiTask ? inferGraphMode(allTasks) : "single",
            results: [],
          },
        }});
        return;
      }
      state.pendingProxyDispatchParents?.delete(requestId);

      const taskNames = new Set(normalizedTasks?.filter((task) => task.name).map((task) => task.name!) ?? []);
      const taskIndexByName = new Map<string, number>();
      normalizedTasks?.forEach((task, index) => {
        if (task.name) taskIndexByName.set(task.name, index);
      });
      const taskCorrelationIds: string[] = normalizedTasks?.map(() => randomUUID()) ?? [];
      const progressState = new Map<number, AgentProgressSnapshot>();
      normalizedTasks?.forEach((task, index) => {
        progressState.set(index, {
          agent: task.agent,
          ...(task.name ? { name: task.name } : {}),
          correlationId: taskCorrelationIds[index],
          taskIndex: index,
          dependencies: taskDependencyNames(task, taskNames)
            .map((name) => taskIndexByName.get(name))
            .filter((dependency): dependency is number => dependency !== undefined),
          status: "pending",
          requestedModel: task.model,
        });
      });
      const progressSnapshot = (): AgentProgressSnapshot[] =>
        [...progressState.values()].sort((left, right) => left.taskIndex - right.taskIndex);
      const pendingProgressByTask = new Map<number, AgentProgress>();

      const abortCtrl = new AbortController();
      const taskAbortControllers = normalizedTasks?.map(() => new AbortController()) ?? [];
      for (const taskController of taskAbortControllers) {
        abortCtrl.signal.addEventListener(
          "abort",
          () => taskController.abort(abortCtrl.signal.reason),
          { once: true },
        );
      }
      const activeAgent: ActiveAgent = {
        agent: normalizedTasks ? `graph(${normalizedTasks.length})` : singleTask.agent,
        name: normalizedTasks ? undefined : singleTask.name,
        correlationId: cid,
        startedAt: Date.now(),
        abortController: abortCtrl,
        ...(normalizedTasks ? { graphAbortController: abortCtrl } : {}),
        ownsChildProcess: !normalizedTasks,
        inbox: [],
        outputLog: [],
        lastActivityAt: Date.now(),
        requestedModel: normalizedTasks ? undefined : singleTask.model,
        spawnedBy: parentCid,
        depth: dispatchDepth,
        maxDispatchDepth: childMaxDispatchDepth,
        status: "running",
        phase: "starting",
        runtimeGeneration: 1,
        sleepMs: 0,
        lease: createChildLease(),
        promptSeq: 1,
        expectsStructuredOutput: normalizedTasks
          ? p.outputSchema !== undefined
          : singleTask.outputSchema !== undefined,
        ...(normalizedTasks ? { progress: progressSnapshot() } : {}),
      };
      state.activeRuns.set(cid, activeAgent);
      trackProxyDispatch(state, requestId, cid);
      if (!normalizedTasks && singleTask.name) bindAgentName(state, singleTask.name, cid);

      const parentAgent = parentCid ? state.activeRuns.get(parentCid) : undefined;
      const nestedChildCalls = new Map<string, ChildAgentCallSnapshot>();
      const publishNestedChildStatus = (child: ChildAgentCallSnapshot): void => {
        nestedChildCalls.set(child.correlationId, {
          ...nestedChildCalls.get(child.correlationId),
          ...child,
        });
        onChildStatus?.(child);
      };
      const reportChildStatus = (
        status: ChildAgentCallSnapshot["status"],
        progress?: AgentProgress,
        retryMessage?: string,
      ): void => {
        publishNestedChildStatus({
          agent: activeAgent.agent,
          ...(!normalizedTasks && singleTask.name ? { name: singleTask.name } : {}),
          correlationId: cid,
          ...(parentCid ? { parentCorrelationId: parentCid } : {}),
          ...(parentAgent ? { parentName: parentAgent.name ?? parentAgent.agent } : {}),
          startedAt: activeAgent.startedAt,
          status,
          phase: progress?.phase ?? activeAgent.phase,
          ...(progress ? {
            durationMs: progress.durationMs,
            lastActivityAt: progress.lastActivityAt,
            resultReadyAt: progress.resultReadyAt,
            recentTools: progress.recentTools,
            inputTokens: progress.inputTokens,
            outputTokens: progress.outputTokens,
            cacheReadTokens: progress.cacheReadTokens,
            cacheWriteTokens: progress.cacheWriteTokens,
            ...(progress.lastMessage ? { lastMessage: truncateUtf8Tail(progress.lastMessage, AGENT_BUFFER_LIMITS.lastResultBytes) } : {}),
          } : {}),
          ...(!progress?.lastMessage && retryMessage
            ? { lastMessage: truncateUtf8Tail(retryMessage, AGENT_BUFFER_LIMITS.lastResultBytes) }
            : {}),
        });
      };

      /**
       * Publishes the same lifecycle event a root dispatch publishes. Nested
       * dispatches never did, so the widget timer, the wakeable budget and the
       * cockpit row all kept treating them as live for the rest of the session.
       */
      const emitNestedComplete = (
        exitCode: number,
        wakeable?: boolean,
        terminalStatus?: AgentTerminalStatus,
        structuredResults?: StructuredResult[],
      ): void => {
        emitComplete(
          pi,
          undefined,
          activeAgent.agent,
          cid,
          exitCode,
          Date.now() - activeAgent.startedAt,
          wakeable,
          terminalStatus === "terminated",
          structuredResults,
        );
      };

      interface NestedCompletion {
        resultPayload: unknown;
        summary: string;
        exitCode: number;
        mode: "single" | "parallel" | "chain" | "graph";
        results: SingleResult[];
        progress: AgentProgressSnapshot[] | undefined;
        lifecyclePending: boolean;
      }
      const nestedGraphTerminalIds = new Set<string>();
      const nestedGraphTerminalStatuses = new Map<string, AgentTerminalStatus | undefined>();
      let nestedSingleTerminal = false;
      let nestedSingleTerminalStatus: AgentTerminalStatus | undefined;
      let nestedPublication: NestedCompletion | undefined;
      let nestedCompletionNotificationRequested = false;
      let nestedCompletionDelivered = false;
      const nestedColdRestarting = new Set<string>();
      const finishProxyDispatchTracking = (): boolean => {
        const cancelled = state.cancelledProxyDispatches?.get(requestId) === cid;
        if (state.proxyDispatchByRequest?.get(requestId) === cid) {
          state.proxyDispatchByRequest.delete(requestId);
        }
        if (cancelled) {
          state.cancelledProxyDispatches?.delete(requestId);
          if (state.cancelledProxyDispatches?.size === 0) state.cancelledProxyDispatches = undefined;
        }
        return cancelled;
      };
      const deliverNestedCompletion = (): void => {
        const lifecycleTerminal = normalizedTasks
          ? taskCorrelationIds.every((taskId) => nestedGraphTerminalIds.has(taskId))
          : nestedSingleTerminal;
        if (!ownsDispatchGeneration()) {
          if (lifecycleTerminal) finishProxyDispatchTracking();
          return;
        }
        if (state.cancelledProxyDispatches?.get(requestId) === cid) {
          if (lifecycleTerminal) finishProxyDispatchTracking();
          return;
        }
        if (nestedCompletionDelivered || !nestedPublication || !lifecycleTerminal) return;
        nestedCompletionDelivered = true;
        const wakeable = normalizedTasks ? false : p.context !== "fork";
        // Publications carry publish-time results (the release boundary);
        // container settlement reflects lifecycle statuses recorded at
        // terminal time.
        const terminalStatus = normalizedTasks
          ? aggregateTerminalStatuses(nestedGraphTerminalStatuses.values())
          : nestedSingleTerminalStatus ?? aggregateTerminalStatus(nestedPublication.results);
        const exitCode = terminalStatus === "completed" ? 0 : 1;
        const settleContainer = normalizedTasks ? settleGraphContainerAgent : settleAgent;
        settleContainer(
          state,
          cid,
          exitCode,
          nestedPublication.summary,
          wakeable,
          terminalStatus,
        );
        reportChildStatus(terminalStatus === "terminated"
          ? "terminated"
          : terminalStatus === "failed" ? "failed" : "completed");
        emitNestedComplete(exitCode, wakeable, terminalStatus, toStructuredResults(
          nestedPublication.results,
          dispatchOriginCwd,
        ));
        if (nestedCompletionNotificationRequested) {
          const envelope = {
            customType: "teammate-complete",
            content: nestedPublication.summary,
            display: true,
            details: {
              mode: nestedPublication.mode,
              results: nestedPublication.results,
              ...(nestedPublication.progress ? { progress: nestedPublication.progress } : {}),
              ...(nestedChildCalls.size > 0 ? { childCalls: [...nestedChildCalls.values()] } : {}),
            },
          };
          const delivered = safeSendMessage(
            pi,
            envelope,
            { triggerTurn: true },
          );
          if (!delivered) {
            markSettledResultInspectable(state, cid);
          }
          // Passive completion delivery to the dispatching child agent. Nested
          // dispatches execute in the root process, so the child that issued
          // this background dispatch only ever saw the immediate ack. Forward
          // the same teammate-complete envelope over the root->child IPC
          // channel (agent.sendControl) and let the child inject it into its
          // own session, where it wakes the agent for a new turn. Root-owned
          // dispatches have no parentCid and are covered by the root delivery
          // above. Fenced: the parent must still be live (non-terminal) and
          // own an open child channel.
          if (parentCid) {
            const parentAgent = state.activeRuns.get(parentCid);
            if (parentSessionId
              && parentAgent?.sessionId === parentSessionId
              && parentAgent.sendControl
              && parentAgent.status !== "completed"
              && parentAgent.status !== "failed"
              && parentAgent.status !== "terminated") {
              parentAgent.sendControl({
                type: "teammate_complete_delivery",
                correlationId: parentCid,
                generation: state.sessionGeneration ?? 0,
                sessionId: parentSessionId,
                envelope,
              });
            }
          }
        }
        finishProxyDispatchTracking();
      };
      const publishNestedCompletion = (
        publication: NestedCompletion,
        notify: boolean,
      ): void => {
        nestedPublication ??= publication;
        nestedCompletionNotificationRequested ||= notify;
        deliverNestedCompletion();
      };
      const publishAdditionalNestedTurn = (
        result: SingleResult,
        terminalStatus: AgentTerminalStatus,
      ): void => {
        if (!ownsDispatchGeneration() || nestedColdRestarting.has(result.correlationId)) return;
        const target = state.activeRuns.get(result.correlationId);
        const wakeable = result.wakeable !== false || Boolean(target?.restart && target.sessionFile);
        emitComplete(
          pi,
          undefined,
          target?.agent ?? result.agent,
          result.correlationId,
          result.exitCode,
          result.durationMs,
          wakeable,
          terminalStatus === "terminated",
          toStructuredResults([result], dispatchOriginCwd),
        );
        if (!safeSendMessage(
          pi,
          {
            customType: "teammate-complete",
            content: displayMessageForResult(result),
            display: true,
            details: { mode: "single", results: [result] },
          },
          { triggerTurn: true },
        )) markSettledResultInspectable(state, result.correlationId);
      };

      normalizedTasks?.forEach((task, index) => {
        const childId = taskCorrelationIds[index];
        const childAgent: ActiveAgent = {
          agent: task.agent,
          name: task.name,
          correlationId: childId,
          startedAt: Date.now(),
          abortController: taskAbortControllers[index],
          graphAbortController: abortCtrl,
          ownsChildProcess: true,
          inbox: [],
          outputLog: [],
          lastActivityAt: Date.now(),
          requestedModel: task.model,
          spawnedBy: cid,
          depth: dispatchDepth,
          // Each task's own maxNestingDepth sets its agent's nesting budget.
          maxDispatchDepth: nestedChildMaxDispatchDepth(parentBudget, dispatchDepth, task.maxNestingDepth),
          status: "pending",
          phase: "starting",
          runtimeGeneration: 1,
          sleepMs: 0,
          lease: createChildLease(),
          promptSeq: 1,
          expectsStructuredOutput: (task.outputSchema ?? p.outputSchema) !== undefined,
          ...(task.todos ? { todos: [...task.todos] } : {}),
        };
        state.activeRuns.set(childId, childAgent);
        if (task.name) bindAgentName(state, task.name, childId);
      });
      // Same P4 ordering as the root path: the full graph is registered before
      // any started event can re-enter admission synchronously.
      normalizedTasks?.forEach((task, index) => {
        const childAgent = state.activeRuns.get(taskCorrelationIds[index]);
        if (childAgent) emitTeammateStarted(pi, childAgent);
      });
      // After the whole graph is registered: an onChildStatus callback can
      // synchronously trigger further dispatches, which must see the complete
      // live tally rather than an empty registry (P4).
      reportChildStatus("running");

      const spawnerAgent = parentCid ? state.activeRuns.get(parentCid) : undefined;
      const spawnerLabel = spawnerAgent?.name ?? spawnerAgent?.agent ?? "proxy";
      safeSendMessage(
        pi,
        {
          customType: "teammate-started",
          content: `● @${spawnerLabel} spawned @${singleTask.name ?? activeAgent.agent}`,
          display: true,
        },
        { triggerTurn: true },
      );
      emitTeammateStarted(pi, activeAgent);

      const processProxyProgress = (data: AgentProgress) => {
        const taskIndex = data.taskIndex ?? taskCorrelationIds.indexOf(data.correlationId ?? "");
        if (taskIndex < 0) return;
        const existing = progressState.get(taskIndex);
        const correlationId = data.correlationId ?? existing?.correlationId ?? taskCorrelationIds[taskIndex];
        const progressName = data.name ?? existing?.name;
        const entry: AgentProgressSnapshot = {
          agent: data.agent,
          ...(progressName ? { name: progressName } : {}),
          correlationId,
          taskIndex,
          dependencies: data.dependencies ?? existing?.dependencies ?? [],
          status: data.status,
          phase: data.phase,
          startedAt: new Date(data.startedAt).toISOString(),
          recentTools: data.recentTools,
          toolCount: data.toolCount,
          tokens: data.tokens,
          inputTokens: data.inputTokens,
          outputTokens: data.outputTokens,
          cacheReadTokens: data.cacheReadTokens,
          cacheWriteTokens: data.cacheWriteTokens,
          durationMs: data.durationMs,
          lastActivityAt: data.lastActivityAt,
          resultReadyAt: data.resultReadyAt,
          requestedModel: data.requestedModel ?? existing?.requestedModel,
          resolvedModel: data.resolvedModel ?? existing?.resolvedModel,
          attemptedModels: data.attemptedModels ?? existing?.attemptedModels,
          ...(data.lastMessage
            ? { lastMessage: truncateUtf8Tail(data.lastMessage, AGENT_BUFFER_LIMITS.lastResultBytes) }
            : {}),
          ...((data.status === "failed" || data.status === "retrying") && data.lastMessage
            ? { error: truncateUtf8Tail(data.lastMessage, AGENT_BUFFER_LIMITS.lastResultBytes) }
            : {}),
          ...(data.status === "completed" || data.status === "failed" || data.status === "terminated"
            ? { completedAt: new Date().toISOString() }
            : {}),
        };
        progressState.set(taskIndex, entry);
        if (data.resultReadyAt !== undefined) {
          applyAgentResultReadyState(state, {
            correlationId: entry.correlationId,
            resultReadyAt: data.resultReadyAt,
          });
        } else if (
          data.phase === "prompting"
          || data.status === "completed"
          || data.status === "failed"
          || data.status === "terminated"
        ) {
          clearAgentResultReadyState(state, entry.correlationId);
        }
        activeAgent.lastActivityAt = Date.now();

        const childAgent = state.activeRuns.get(correlationId);
        if (childAgent) {
          childAgent.phase = entry.phase;
          childAgent.requestedModel = entry.requestedModel ?? childAgent.requestedModel;
          childAgent.resolvedModel = entry.resolvedModel ?? childAgent.resolvedModel;
          childAgent.attemptedModels = entry.attemptedModels ?? childAgent.attemptedModels;
        }
        if (childAgent && childAgent !== activeAgent) {
          childAgent.lastActivityAt = Date.now();
          childAgent.status = data.status === "completed" ? "sleeping" : data.status;
          if (data.status === "running") childAgent.retry = undefined;
          if (data.lastMessage) {
            const lastLine = data.lastMessage.split("\n").pop()?.trim();
            if (lastLine) {
              const shortId = correlationId.slice(0, 8);
              const marker = data.name ? `@${data.name}#${shortId}` : `${data.agent}#${shortId}`;
              const line = truncateUtf8Tail(
                `${marker} │ ${lastLine}`,
                AGENT_BUFFER_LIMITS.logLineBytes,
              );
              childAgent.outputLog = [line];
              activeAgent.outputLog.push(line);
              trimAgentBuffers(childAgent, childAgent.status === "sleeping");
              trimAgentBuffers(activeAgent);
            }
          }
        }
      };

      const publishProxyProgress = (data: AgentProgress): void => {
        const taskIndex = data.taskIndex ?? taskCorrelationIds.indexOf(data.correlationId ?? "");
        const existing = taskIndex >= 0 ? progressState.get(taskIndex) : undefined;
        const taskCorrelationId = data.correlationId ?? existing?.correlationId ?? cid;
        const task: AgentProgressSnapshot = existing ?? {
          agent: data.agent,
          ...(data.name ? { name: data.name } : {}),
          correlationId: taskCorrelationId,
          taskIndex: taskIndex >= 0 ? taskIndex : 0,
          dependencies: data.dependencies ?? [],
          status: data.status,
          phase: data.phase,
          startedAt: new Date(data.startedAt).toISOString(),
          recentTools: data.recentTools,
          toolCount: data.toolCount,
          tokens: data.tokens,
          inputTokens: data.inputTokens,
          outputTokens: data.outputTokens,
          cacheReadTokens: data.cacheReadTokens,
          cacheWriteTokens: data.cacheWriteTokens,
          durationMs: data.durationMs,
          lastActivityAt: data.lastActivityAt,
          resultReadyAt: data.resultReadyAt,
          requestedModel: data.requestedModel,
          resolvedModel: data.resolvedModel,
          attemptedModels: data.attemptedModels,
          ...(data.lastMessage
            ? { lastMessage: truncateUtf8Tail(data.lastMessage, AGENT_BUFFER_LIMITS.lastResultBytes) }
            : {}),
          ...((data.status === "failed" || data.status === "retrying") && data.lastMessage
            ? { error: truncateUtf8Tail(data.lastMessage, AGENT_BUFFER_LIMITS.lastResultBytes) }
            : {}),
          ...(data.status === "completed" || data.status === "failed" || data.status === "terminated"
            ? { completedAt: new Date().toISOString() }
            : {}),
        };
        const currentProgress = normalizedTasks ? progressSnapshot() : [task];
        pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
          ...task,
          correlationId: cid,
          taskCorrelationId,
          progress: currentProgress,
        });
      };

      const childCallStatusForProgress = (status: AgentProgress["status"]): ChildAgentCallSnapshot["status"] => {
        if (status === "completed" || status === "failed" || status === "terminated" || status === "retrying") {
          return status;
        }
        return "running";
      };
      // Aggregate the graph's task progress into one childCall snapshot so the
      // parent sees advancing activity. Without this the parent's record stayed
      // frozen at its initial "running" and every nested graph rendered as
      // stalled 30s after launch.
      const aggregateTaskProgress = (): AgentProgress | undefined => {
        const entries = [...progressState.values()];
        if (entries.length === 0) return undefined;
        const runningTool = entries.find((entry) =>
          entry.status === "running" && entry.recentTools?.some((tool) => tool.status === "running")
        );
        const running = runningTool ?? entries.find((entry) => entry.status === "running");
        const phase = aggregateAgentRunPhase(entries);
        activeAgent.phase = phase ?? activeAgent.phase;
        return {
          agent: activeAgent.agent,
          ...(!normalizedTasks && singleTask.name ? { name: singleTask.name } : {}),
          correlationId: cid,
          status: "running",
          phase,
          recentTools: running?.recentTools ?? [],
          toolCount: entries.reduce((total, entry) => total + (entry.toolCount ?? 0), 0),
          tokens: entries.reduce((total, entry) => total + (entry.tokens ?? 0), 0),
          inputTokens: entries.reduce((total, entry) => total + (entry.inputTokens ?? 0), 0),
          outputTokens: entries.reduce((total, entry) => total + (entry.outputTokens ?? 0), 0),
          cacheReadTokens: entries.reduce((total, entry) => total + (entry.cacheReadTokens ?? 0), 0),
          cacheWriteTokens: entries.reduce((total, entry) => total + (entry.cacheWriteTokens ?? 0), 0),
          durationMs: Date.now() - activeAgent.startedAt,
          lastActivityAt: entries.reduce(
            (latest, entry) => Math.max(latest, entry.lastActivityAt ?? 0),
            activeAgent.startedAt,
          ),
          startedAt: activeAgent.startedAt,
          ...(running?.lastMessage ? { lastMessage: running.lastMessage } : {}),
        };
      };

      // Created unconditionally. The single-task branch used to bypass the gate
      // and publish on every streaming token, which drove a full parent-side
      // re-render per delta — the dominant cost of nested dispatches.
      const proxyProgressFlushGate = createProgressFlushGate(() => {
        const pending = [...pendingProgressByTask.values()];
        pendingProgressByTask.clear();
        const latest = pending[pending.length - 1];
        if (!latest) return;
        if (normalizedTasks) {
          for (const data of pending) processProxyProgress(data);
          activeAgent.progress = progressSnapshot();
          publishProxyProgress(latest);
          reportChildStatus("running", aggregateTaskProgress());
          return;
        }
        publishProxyProgress(latest);
        reportChildStatus(childCallStatusForProgress(latest.status), latest);
      });

      const runOpts: RunTeammateOptions = {
        ...runtimeOptions,
        baseCwd: state.baseCwd,
        modelCapabilities,
        ...(normalizedTasks ? { taskCorrelationIds } : { correlationId: cid }),
        depth: dispatchDepth,
        maxDispatchDepth: childMaxDispatchDepth,
        signal: abortCtrl.signal,
        runtimeGeneration: activeAgent.runtimeGeneration,
        ...(normalizedTasks ? { taskSignals: taskAbortControllers.map((controller) => controller.signal) } : {}),
        parentSessionFile: spawnerAgent?.sessionFile ?? state.mainSessionFile,
        initialLeaseToken: (childId: string) => {
          const target = state.activeRuns.get(childId) ?? activeAgent;
          return target.lease ? leaseToken(target.lease) : undefined;
        },
        onChildSpawned: (stdin, sendControl, sessionDir, childId) => {
          const target = childId ? state.activeRuns.get(childId) ?? activeAgent : activeAgent;
          target.stdin = stdin;
          target.sendControl = sendControl;
          target.sessionDir = sessionDir;
          target.status = "running";
          target.phase = "prompting";
          target.retry = undefined;
          target.resultReadyAt = undefined;
          if (target.lease) sendControl({ type: "teammate_lease_update", token: leaseToken(target.lease) });
        },
        onChildEvent: (childEvent) => handleChildLifecycleEvent(state, childEvent),
        onChildClosed: (childId, generation, details) => {
          const target = state.activeRuns.get(childId);
          if (!target || (target.runtimeGeneration ?? 0) !== (generation ?? 0)) return;
          target.stdin = undefined;
          target.sendControl = undefined;
          const checkpoint = target.sessionFile;
          if (
            target.restart
            && checkpoint
            && existsSync(checkpoint)
            && isSessionPathContained(target.sessionDir, checkpoint)
          ) {
            target.status = "sleeping";
            target.phase = undefined;
            target.retry = undefined;
            target.failedAt = undefined;
            target.sleptAt = Date.now();
            target.lastActivityAt = Date.now();
            target.outputLog.push(
              `[${new Date().toISOString().slice(11, 19)}] ◉ runtime closed; session checkpoint retained for cold resume.`,
            );
            trimAgentBuffers(target, true);
            return;
          }
          if (target.status === "sleeping" || target.status === "running" || target.status === "retrying") {
            killAgent(state, childId, target.name, details.code === 0 ? "completed" : "failed", false);
          }
        },
        onRetry: (retry) => {
          applyAgentRetryState(state, retry);
          reportChildStatus(
            "retrying",
            undefined,
            `retry ${retry.attempt}/${retry.maxRetries} in ${formatRetryDelay(retry.delayMs)}: ${retry.error}`,
          );
        },
        onReclamationOutcome: (childId, outcome) => {
          recordChildReclamationOutcome(state, childId, outcome);
        },
        onResultPublished: (result, originCwd) => emitTeammateResultPublished(pi, result, originCwd),
        onTurnComplete: (result, terminalStatus) => {
          const canonicalStatus = terminalStatusForResult(result, terminalStatus);
          result.terminalStatus = canonicalStatus;
          const target = state.activeRuns.get(result.correlationId) ?? activeAgent;
          target.resolvedModel = target.resolvedModel ?? result.model;
          if (result.attemptedModels) target.attemptedModels = [...result.attemptedModels];
          setAgentStructuredOutput(target, result.structuredOutput);
          const lastMessage = displayMessageForResult(result);
          const settle = normalizedTasks ? settleGraphTaskAgent : settleAgent;
          settle(
            state,
            result.correlationId,
            result.exitCode,
            lastMessage,
            result.wakeable !== false,
            canonicalStatus,
          );
          const repeatedTurn = normalizedTasks
            ? nestedGraphTerminalIds.has(result.correlationId)
            : nestedSingleTerminal;
          if (normalizedTasks) {
            nestedGraphTerminalIds.add(result.correlationId);
            nestedGraphTerminalStatuses.set(result.correlationId, canonicalStatus);
          } else {
            nestedSingleTerminal = true;
            nestedSingleTerminalStatus = canonicalStatus;
          }
          if (result.correlationId === cid) {
            reportChildStatus(canonicalStatus === "terminated"
              ? "terminated"
              : canonicalStatus === "failed" ? "failed" : "completed");
          }
          deliverNestedCompletion();
          if (repeatedTurn) publishAdditionalNestedTurn(result, canonicalStatus);
        },
        onProgress: (data) => {
          // Refreshed on every branch. This is the only input to every stall
          // verdict (the status widget, teammate-wait, teammate-list), and the
          // single-task path never wrote it — so the most common nested shape
          // reported itself stalled after 30s of healthy work.
          activeAgent.lastActivityAt = Date.now();
          const targetId = data.correlationId ?? taskCorrelationIds[data.taskIndex ?? 0] ?? cid;
          if (data.resultReadyAt !== undefined) {
            applyAgentResultReadyState(state, { correlationId: targetId, resultReadyAt: data.resultReadyAt });
          } else if (
            data.phase === "prompting"
            || data.status === "completed"
            || data.status === "failed"
            || data.status === "terminated"
          ) {
            clearAgentResultReadyState(state, targetId);
          }

          if (!normalizedTasks) {
            if (data.lastMessage) appendAgentProgressLine(activeAgent, data, cid);
            pendingProgressByTask.set(0, data);
            proxyProgressFlushGate.mark(data.status === "completed" || data.status === "failed");
            return;
          }
          const taskIndex = data.taskIndex ?? taskCorrelationIds.indexOf(data.correlationId ?? "");
          if (taskIndex < 0) return;
          pendingProgressByTask.set(taskIndex, data);
          proxyProgressFlushGate.mark(data.status === "completed" || data.status === "failed");
        },
        onChildRequest: (evt, rep) => {
          if (!ownsDispatchGeneration()) {
            rep({
              type: "teammate_proxy_result",
              requestId: evt.requestId,
              result: {
                content: [{ type: "text", text: "Parent session generation changed; stale child request rejected." }],
                isError: true,
                details: { mode: "single", results: [] },
              },
            });
            return;
          }
          if (evt.type === "teammate_interaction_request" || evt.type === "teammate_rpc_ui_request") {
            onInteraction?.(evt, rep, cid);
            return;
          }
          if (evt.type === "teammate_proxy_cancel" && typeof evt.requestId === "string") {
            cancelProxyDispatch(state, evt.requestId);
            return;
          }
          handleProxyRequest(
            pi, state, evt, rep, cid, modelCapabilities, onInteraction, publishNestedChildStatus, runtimeOptions,
            undefined,
            workspacePeerSend,
            workspacePeerList,
          );
        },
      };

      const installNestedColdRestart = (
        target: ActiveAgent,
        task: NormalizedTask,
      ): void => {
        target.restart = (message: string): boolean => {
          const checkpoint = target.sessionFile;
          if (
            target.restartPending
            || !checkpoint
            || !existsSync(checkpoint)
            || !isSessionPathContained(target.sessionDir, checkpoint)
          ) return false;

          const generation = (target.runtimeGeneration ?? 0) + 1;
          const controller = new AbortController();
          target.runtimeGeneration = generation;
          target.abortController = controller;
          target.graphAbortController = controller;
          target.lease = createChildLease();
          target.status = "running";
          target.phase = "restoring";
          target.retry = undefined;
          target.failedAt = undefined;
          target.resultReadyAt = undefined;
          target.lastActivityAt = Date.now();
          nestedColdRestarting.add(target.correlationId);
          const ownsRuntime = (): boolean =>
            state.activeRuns.get(target.correlationId) === target
            && target.runtimeGeneration === generation;

          const restartOptions: RunTeammateOptions = {
            ...runOpts,
            correlationId: target.correlationId,
            taskCorrelationIds: undefined,
            taskSignals: undefined,
            signal: controller.signal,
            resumeSessionFile: checkpoint,
            runtimeGeneration: generation,
          };
          const onChildSpawned = runOpts.onChildSpawned;
          restartOptions.onChildSpawned = (stdin, sendControl, sessionDir, childId) => {
            if (ownsRuntime()) onChildSpawned?.(stdin, sendControl, sessionDir, childId ?? target.correlationId);
          };
          const onChildEvent = runOpts.onChildEvent;
          restartOptions.onChildEvent = (event) => {
            if (ownsRuntime()) onChildEvent?.(event);
          };
          const onChildClosed = runOpts.onChildClosed;
          restartOptions.onChildClosed = (childId, callbackGeneration, details) => {
            if (ownsRuntime()) onChildClosed?.(childId, callbackGeneration, details);
          };
          const onChildRequest = runOpts.onChildRequest;
          restartOptions.onChildRequest = (event, respond) => {
            if (ownsRuntime()) onChildRequest?.(event, respond);
          };
          restartOptions.onRetry = (retry) => {
            if (ownsRuntime()) applyAgentRetryState(state, retry);
          };
          restartOptions.onProgress = (progress) => {
            if (!ownsRuntime()) return;
            target.phase = progress.phase;
            target.lastActivityAt = progress.lastActivityAt;
            target.resultReadyAt = progress.resultReadyAt;
            if (progress.lastMessage) target.lastResult = progress.lastMessage;
          };
          const onReclamationOutcome = runOpts.onReclamationOutcome;
          restartOptions.onReclamationOutcome = (childId, outcome) => {
            if (ownsRuntime()) onReclamationOutcome?.(childId, outcome);
          };

          let publishedResult: SingleResult | undefined;
          let terminalResult: SingleResult | undefined;
          let completionDelivered = false;
          const deliverRestartCompletion = (): void => {
            if (completionDelivered || !ownsRuntime() || !publishedResult || !terminalResult) return;
            completionDelivered = true;
            const status = terminalStatusForResult(terminalResult);
            emitComplete(
              pi,
              undefined,
              target.agent,
              target.correlationId,
              terminalResult.exitCode,
              terminalResult.durationMs,
              true,
              status === "terminated",
              toStructuredResults([terminalResult], dispatchOriginCwd),
            );
            safeSendMessage(
              pi,
              {
                customType: "teammate-complete",
                content: displayMessageForResult(terminalResult),
                display: true,
                details: { mode: "single", results: [terminalResult] },
              },
              { triggerTurn: true },
            );
          };
          const onTurnComplete = runOpts.onTurnComplete;
          restartOptions.onTurnComplete = (result, status) => {
            if (!ownsRuntime()) return;
            onTurnComplete?.(result, status);
            terminalResult = result;
            deliverRestartCompletion();
          };

          target.restartPending = runSingleTeammate(
            {
              agent: task.agent,
              name: task.name,
              task: message,
              taskType: task.taskType,
              context: "fresh",
              model: task.model,
              fallbackModels: task.fallbackModels,
              thinking: task.thinking,
              cwd: task.cwd,
              outputSchema: task.outputSchema,
              timeoutMs: task.timeoutMs,
              reply_to: p.reply_to,
            },
            restartOptions,
          ).then((result) => {
            if (!ownsRuntime()) return;
            publishedResult = result;
            deliverRestartCompletion();
          }).catch((error) => {
            if (!ownsRuntime()) return;
            const text = error instanceof Error ? error.message : String(error);
            target.lastResult = text;
            target.status = "sleeping";
            target.phase = undefined;
            target.sleptAt = Date.now();
            target.outputLog.push(`[${new Date().toISOString().slice(11, 19)}] ! cold resume failed: ${text}`);
            trimAgentBuffers(target, true);
          }).finally(() => {
            nestedColdRestarting.delete(target.correlationId);
            if (!ownsRuntime()) return;
            if (target.status === "failed" && existsSync(checkpoint)) {
              target.status = "sleeping";
              target.phase = undefined;
              target.failedAt = undefined;
              target.sleptAt = Date.now();
            }
            target.restartPending = undefined;
          });
          return true;
        };
      };

      if (normalizedTasks) normalizedTasks.forEach((task, index) => {
        const target = state.activeRuns.get(taskCorrelationIds[index]);
        if (target) installNestedColdRestart(target, task);
      });
      else installNestedColdRestart(activeAgent, singleTask);

      const executeNested = async () => {
        if (normalizedTasks) {
          const mode = inferGraphMode(normalizedTasks);
          let results: SingleResult[];
          try {
            results = await runGraph(normalizedTasks, p.concurrency ?? 4, runOpts);
          } finally {
            proxyProgressFlushGate?.flush();
            proxyProgressFlushGate?.dispose();
          }
          const hasError = results.some(resultIsError);
          const summaries = summarizeGraphResults(results, normalizedTasks);
          const structuredOutput = aggregateGraphStructuredOutput(results, normalizedTasks);
          results.forEach((result, index) => {
            const current = progressState.get(index);
            const lifecyclePending = result.lifecyclePending === true;
            progressState.set(index, {
              agent: result.agent,
              ...(normalizedTasks![index]?.name ? { name: normalizedTasks![index].name } : {}),
              correlationId: result.correlationId,
              taskIndex: index,
              dependencies: current?.dependencies ?? [],
              status: lifecyclePending ? "running" : terminalStatusForResult(result),
              ...(current?.startedAt ? { startedAt: current.startedAt } : {}),
              ...(!lifecyclePending ? { completedAt: new Date().toISOString() } : {}),
              recentTools: current?.recentTools ?? [],
              toolCount: current?.toolCount ?? 0,
              tokens: result.usage.inputTokens + result.usage.outputTokens,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              cacheReadTokens: result.usage.cacheReadTokens,
              cacheWriteTokens: result.usage.cacheWriteTokens,
              durationMs: result.durationMs,
              requestedModel: current?.requestedModel,
              resolvedModel: result.model,
              attemptedModels: result.attemptedModels ?? current?.attemptedModels,
              ...(resultIsError(result) ? { error: displayMessageForResult(result) } : {}),
              ...(lifecyclePending && current?.resultReadyAt
                ? { resultReadyAt: current.resultReadyAt }
                : {}),
              lastMessage: displayMessageForResult(result),
            });
          });
          const progress = progressSnapshot();
          activeAgent.progress = progress;
          return {
            resultPayload: {
              content: [{ type: "text", text: warningPrefix + summaries }],
              isError: hasError,
              details: {
                mode,
                results,
                progress,
                ...(structuredOutput !== undefined ? { structuredOutput } : {}),
                ...(nestedChildCalls.size > 0 ? { childCalls: [...nestedChildCalls.values()] } : {}),
              },
            },
            summary: summaries,
            exitCode: hasError ? 1 : 0,
            mode,
            results,
            progress,
            lifecyclePending: results.some((result) => result.lifecyclePending === true),
          };
        }

        const result = await runSingleTeammate(singleRunParams, runOpts);
        const lastMsg = displayMessageForResult(result);
        return {
          resultPayload: {
            content: [{ type: "text", text: warningPrefix + lastMsg }],
            isError: resultIsError(result),
            details: {
              mode: "single",
              results: [result],
              ...(result.structuredOutput !== undefined ? { structuredOutput: result.structuredOutput } : {}),
              ...(nestedChildCalls.size > 0 ? { childCalls: [...nestedChildCalls.values()] } : {}),
            },
          },
          summary: lastMsg,
          exitCode: result.exitCode,
          mode: "single" as const,
          results: [result],
          progress: undefined,
          lifecyclePending: result.lifecyclePending === true,
        };
      };

      const settleNestedExecutionFailure = (error: unknown): string => {
        const message = error instanceof Error ? error.message : String(error);
        if (normalizedTasks) {
          abortCtrl.abort(error);
          taskCorrelationIds.forEach((taskId) => {
            if (nestedGraphTerminalIds.has(taskId)) return;
            nestedGraphTerminalIds.add(taskId);
            nestedGraphTerminalStatuses.set(taskId, "terminated");
            settleGraphTaskAgent(state, taskId, 1, message, false, "terminated");
          });
          settleGraphContainerAgent(state, cid, 1, message, false);
        } else {
          settleAgent(state, cid, 1, message, false);
        }
        reportChildStatus("failed");
        return message;
      };

      const mode = normalizedTasks ? inferGraphMode(normalizedTasks) : "single";
      const runningLabel = singleTask.name ?? activeAgent.agent;

      const completeNestedInBackground = (
        nestedPromise: ReturnType<typeof executeNested>,
      ): void => {
        // Background/detached nested dispatches promise a teammate-complete
        // notification on settle; a stall (never terminal) would otherwise
        // strand the parent — and the main caller of the top-level dispatch —
        // without any notification. Mark container and children so the stall
        // sweep can wake the caller.
        activeAgent.notifyOnStall = true;
        for (const childId of taskCorrelationIds ?? []) {
          const child = state.activeRuns.get(childId);
          if (child) child.notifyOnStall = true;
        }
        void nestedPromise.then((completed) => {
          if (!ownsDispatchGeneration()) {
            finishProxyDispatchTracking();
            return;
          }
          if (state.cancelledProxyDispatches?.get(requestId) === cid) {
            finishProxyDispatchTracking();
            return;
          }
          publishNestedCompletion(completed, true);
        }).catch((error) => {
          const cancelled = finishProxyDispatchTracking();
          if (cancelled || !ownsDispatchGeneration()) return;
          settleNestedExecutionFailure(error);
          notifyBackgroundFailure(pi, requestId, activeAgent.agent, cid, error, state);
        });
      };

      if (routedParams.background === false) {
        const waitMs = foregroundWaitWindowMs(allTasks, runtimeOptions.foregroundMaxRunMs);
        // Alt+B manual detach, mirroring the root single/graph foreground paths.
        let detachResolve: (() => void) | null = null;
        const detachPromise = new Promise<"manual">((resolve) => { detachResolve = () => resolve("manual"); });
        let removeListener: (() => void) | undefined;
        let deadline: ReturnType<typeof createForegroundDeadline> | undefined;
        let nestedPromise!: ReturnType<typeof executeNested>;
        let race:
          | { status: "completed"; completed: Awaited<ReturnType<typeof executeNested>> }
          | { status: "failed"; error: unknown }
          | { status: "manual" }
          | { status: "timeout" };
        try {
          removeListener = registerForegroundDetach(() => detachResolve?.());
          deadline = createForegroundDeadline(waitMs);
          nestedPromise = executeNested();
          race = await Promise.race([
            nestedPromise.then(
              (completed) => ({ status: "completed" as const, completed }),
              (error: unknown) => ({ status: "failed" as const, error }),
            ),
            detachPromise.then(() => ({ status: "manual" as const })),
            deadline.promise.then(() => ({ status: "timeout" as const })),
          ]);
        } catch (error) {
          cancelProxyDispatch(state, requestId, "nested foreground setup failed");
          if (state.cancelledProxyDispatches?.get(requestId) === cid) {
            state.cancelledProxyDispatches.delete(requestId);
            if (state.cancelledProxyDispatches.size === 0) state.cancelledProxyDispatches = undefined;
          }
          throw error;
        } finally {
          removeListener?.();
          deadline?.dispose();
        }

        if (race.status === "failed") {
          const cancelled = finishProxyDispatchTracking();
          if (cancelled || !ownsDispatchGeneration()) return;
          const failureMessage = settleNestedExecutionFailure(race.error);
          emitNestedComplete(1);
          reply({ type: "teammate_proxy_result", requestId, result: {
            content: [{
              type: "text",
              text: `Nested teammate failed: ${failureMessage}`,
            }],
            isError: true,
            details: { mode, results: [] },
          }});
          return;
        }

        if (race.status === "completed") {
          const completed = race.completed;
          if (!ownsDispatchGeneration()) {
            finishProxyDispatchTracking();
            return;
          }
          if (state.cancelledProxyDispatches?.get(requestId) === cid) {
            finishProxyDispatchTracking();
            return;
          }
          publishNestedCompletion(completed, false);
          reply({ type: "teammate_proxy_result", requestId, result: completed.resultPayload });
          return;
        }

        if (!ownsDispatchGeneration()) {
          finishProxyDispatchTracking();
          return;
        }
        completeNestedInBackground(nestedPromise);
        const detachText = race.status === "timeout"
          ? `@${runningLabel} moved to background after ${waitMs}ms.`
          : `@${runningLabel} detached.`;
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{
            type: "text",
            text: `${warningPrefix}${detachText} ${FOREGROUND_DETACH_HINT} ${backgroundWaitGuidance(cid)}`,
          }],
          isError: false,
          details: {
            mode,
            results: [],
            ...(normalizedTasks ? { progress: progressSnapshot() } : {}),
          },
        }});
        return;
      }

      const nestedPromise = executeNested();
      completeNestedInBackground(nestedPromise);
      reply({ type: "teammate_proxy_result", requestId, result: {
        content: [{
          type: "text",
          text: `${warningPrefix}@${runningLabel} running in background. ${backgroundWaitGuidance(cid)}`,
        }],
        isError: false,
        details: {
          mode,
          results: [],
          ...(normalizedTasks ? { progress: progressSnapshot() } : {}),
        },
      }});
      return;
    }

    case "teammate-wait": {
      const parentSignal = parentCid ? state.activeRuns.get(parentCid)?.abortController.signal : undefined;
      const name = typeof params.name === "string" ? params.name : undefined;
      const result = await withProxyObservation(state, requestId, parentSignal, async (proxySignal) => name
        ? observeTargets({
            action: "wait",
            targets: [{ kind: "teammate", id: name }],
            timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
            detail: "full",
            lines: 20,
          }, proxySignal).then((observed) => {
            const observation = observed.observations[0]!;
            return {
              status: observation.waitStatus as TeammateWaitStatus,
              output: observation.detail
                ?? (observation.waitStatus === "timeout" || observation.waitStatus === "aborted"
                  ? waitOutput(observation.waitStatus, name)
                  : [observation.summary]),
            };
          })
        : waitForTeammate(
            state,
            {
              timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
              waitMs: typeof params.waitMs === "number" ? params.waitMs : undefined,
            },
            proxySignal,
          ));
      reply({ type: "teammate_proxy_result", requestId, result: {
        content: [{ type: "text", text: result.output.join("\n") }],
        isError: result.status === "not-found"
          || result.status === "timeout"
          || result.status === "aborted"
          || result.status === "stalled",
        details: { status: result.status, output: result.output },
      }});
      return;
    }

    case "observe": {
      if (!Check(ObserveParams, params)) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: "Invalid observe parameters received from child IPC." }],
          isError: true,
          details: { output: [] },
        }});
        return;
      }
      const result = await withProxyObservation(
        state,
        requestId,
        parentCid ? state.activeRuns.get(parentCid)?.abortController.signal : undefined,
        (proxySignal) => observeTargets(params as UnifiedObserveParams, proxySignal),
      );
      const output = formatObserveResult(result, params.detail !== "summary");
      const failed = result.reason === "timeout"
        || result.reason === "aborted"
        || result.observations.some((item) => !item.found || item.outcome === "failure" || item.outcome === "stalled");
      reply({ type: "teammate_proxy_result", requestId, result: {
        content: [{ type: "text", text: output.join("\n") }],
        isError: failed,
        details: { output, result },
      }});
      return;
    }

    case "teammate-monitor": {
      if (!Check(TeammateMonitorParams, params)) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: "Invalid teammate-monitor parameters received from child IPC." }],
          isError: true,
          details: { output: [] },
        }});
        return;
      }
      const monitorParams = params as unknown as MonitorParams;
      const validationError = validateMonitorParams(monitorParams);
      if (validationError) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: validationError }],
          isError: true,
          details: { output: [validationError] },
        }});
        return;
      }
      const observed = await withProxyObservation(
        state,
        requestId,
        parentCid ? state.activeRuns.get(parentCid)?.abortController.signal : undefined,
        (proxySignal) => observeTargets({
          action: monitorParams.action,
          targets: monitorParams.targets.map((id) => ({ kind: "teammate", id })),
          detail: monitorParams.verbose ? "full" : "summary",
          lines: monitorParams.lines ?? MONITOR_DEFAULT_LINES,
          waitMode: monitorParams.waitMode,
          waitCount: monitorParams.waitCount,
          timeoutMs: monitorParams.timeoutMs ?? MONITOR_DEFAULT_TIMEOUT_MS,
        }, proxySignal),
      );
      const output = formatObserveResult(observed, monitorParams.verbose === true);
      const failed = observed.reason === "timeout"
        || observed.reason === "aborted"
        || observed.observations.some((item) => !item.found || item.outcome === "failure" || item.outcome === "stalled");
      reply({ type: "teammate_proxy_result", requestId, result: {
        content: [{ type: "text", text: output.join("\n") }],
        isError: failed,
        details: { output },
      }});
      return;
    }

    case "teammate-send": {
      const to = params.to as string;
      const message = (params.message as string | undefined) ?? "";
      const requestedMode = (params.mode as RpcMessageMode) ?? "follow_up";
      const localCid = resolveAgentCorrelationId(state, to);

      if (to.startsWith("owner:") && (sessionSend || workspacePeerSend) && !localCid) {
        if (!message && requestedMode !== "abort") {
          reply({ type: "teammate_proxy_result", requestId, result: {
            content: [{ type: "text", text: `"message" is required for mode "${requestedMode}".` }],
            isError: true, details: { delivered: false },
          }});
          return;
        }
        if (requestedMode === "abort") {
          reply({ type: "teammate_proxy_result", requestId, result: {
            content: [{ type: "text", text: "Cross-session targets support only steer and follow_up; abort is local-only." }],
            isError: true, details: { delivered: false },
          }});
          return;
        }
        if (requestedMode !== "steer" && requestedMode !== "follow_up") {
          reply({ type: "teammate_proxy_result", requestId, result: {
            content: [{ type: "text", text: `Unsupported workspace intervention mode: ${requestedMode}.` }],
            isError: true, details: { delivered: false },
          }});
          return;
        }
        const delivered = sessionSend
          ? (await sessionSend({ selector: to, message, mode: requestedMode })).delivered
          : await workspacePeerSend!(to, message, requestedMode);
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: delivered ? `Message delivered to workspace target ${to}.` : `Message rejected for workspace target ${to}.` }],
          isError: !delivered,
          details: { delivered },
        }});
        return;
      }

      if (!message && requestedMode !== "abort") {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: `"message" is required for mode "${requestedMode}".` }],
          isError: true, details: { delivered: false },
        }});
        return;
      }

      const cid = localCid ?? resolveAgentCorrelationId(state, to);
      if (!cid) {
        const available = Array.from(state.namedAgents.keys());
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: `Agent "${to}" not found. ${available.length > 0 ? `Available: ${available.join(", ")}` : "No named agents."}` }],
          isError: true, details: { delivered: false },
        }});
        return;
      }

      const authority = canProxySendTo(state, parentCid, cid, requestedMode);
      if (!authority.allowed) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{
            type: "text",
            text: `Cannot ${requestedMode === "abort" ? "abort" : "message"} "${to}": ${authority.reason}.`,
          }],
          isError: true, details: { delivered: false },
        }});
        return;
      }

      const agent = state.activeRuns.get(cid);
      if (agent && !LIVE_AGENT_STATUSES.has(agent.status)) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: `Agent "${to}" is already ${agent.status} and cannot receive commands.` }],
          isError: true, details: { delivered: false },
        }});
        return;
      }
      if (sessionSend) {
        const mode = requestedMode === "steer" || requestedMode === "abort" ? requestedMode : "follow_up";
        const delivery = await sessionSend({ selector: to, message, mode });
        if (!delivery.delivered) {
          reply({ type: "teammate_proxy_result", requestId, result: {
            content: [{ type: "text", text: delivery.error ?? `Failed to send message to "${to}".` }],
            isError: true, details: { delivered: false },
          }});
          return;
        }
        if (mode === "abort") {
          const terminatedCount = delivery.receipt?.terminatedCount ?? 1;
          reply({ type: "teammate_proxy_result", requestId, result: {
            content: [{
              type: "text",
              text: `Agent "${to}" aborted; terminated ${terminatedCount} agent${terminatedCount === 1 ? "" : "s"} in its subtree.`,
            }],
            isError: false, details: { delivered: true },
          }});
          return;
        }
        const modeLabel = delivery.receipt?.wasSleeping
          ? "woken up + prompt"
          : delivery.receipt?.mode === "steer" ? "interrupted + injected" : "queued after current turn";
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: `Message ${modeLabel} for "${to}".${delivery.receipt?.wasSleeping ? " Agent woken up." : ""}` }],
          isError: false, details: { delivered: true },
        }});
        return;
      }
      if (agent && requestedMode === "abort") {
        if (agent.stdin?.writable && canChildWrite(agent.lease)) {
          sendRpcMessage(agent.stdin, message, "abort", agent.lease ? leaseToken(agent.lease) : undefined);
        }
        const terminated = killAgentTree(state, cid);
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{
            type: "text",
            text: `Agent "${to}" aborted; terminated ${terminated.length} agent${terminated.length === 1 ? "" : "s"} in its subtree.`,
          }],
          isError: false,
          details: { delivered: true },
        }});
        return;
      }
      // Durable mailbox authoritative path: enqueue and let the consumer inject.
      // Only for live agents with a writable stdin; sleeping agents needing
      // cold-resume keep the synchronous direct path (lifecycle contract).
      if (mailboxDeliver && requestedMode !== "abort" && requestedMode !== "steer" && agent?.stdin?.writable) {
        void mailboxDeliver({
          senderId: parentCid ?? "caller",
          recipientId: to,
          recipientCorrelationId: cid,
          kind: "follow_up",
          mode: "follow_up",
          payload: message,
        }).then((result) => {
          if (result.result.ok) {
            const now = Date.now();
            agent?.inbox.push({
              id: randomUUID(),
              from: spawnedBy ?? "proxy",
              to,
              kind: "task",
              payload: message,
              timestamp: now,
            });
            if (agent) {
              agent.outputLog.push(`[${new Date(now).toISOString().slice(11, 19)}] ◀ mailbox-follow-up: ${message.slice(0, 100)}`);
              trimAgentBuffers(agent);
              agent.lastActivityAt = now;
            }
            pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
              correlationId: cid,
              from: "caller",
              to,
              mode: "follow_up",
              message,
              lastActivityAt: now,
              isSend: true,
            });
            reply({ type: "teammate_proxy_result", requestId, result: {
              content: [{ type: "text", text: `Message queued after current turn for "${to}".` }],
              isError: false, details: { delivered: true },
            }});
          } else {
            // Surface the failure — never silently fall back to direct stdin.
            const reason = "message" in result.result ? (result.result as { message?: string }).message : "unknown error";
            console.error(`[pi-maestro-teammate] mailbox delivery failed for ${to}: ${reason}`);
            reply({ type: "teammate_proxy_result", requestId, result: {
              content: [{ type: "text", text: `Mailbox delivery failed for "${to}": ${reason}` }],
              isError: true, details: { delivered: false },
            }});
          }
        }).catch((error) => {
          console.error(`[pi-maestro-teammate] mailbox delivery failed for ${to}:`, error);
          reply({ type: "teammate_proxy_result", requestId, result: {
            content: [{ type: "text", text: `Mailbox delivery failed for "${to}".` }],
            isError: true, details: { delivered: false },
          }});
        });
        return;
      }
      if (!agent?.stdin?.writable) {
        const restarted = agent?.status === "sleeping" && agent.restart?.(message) === true;
        if (!restarted || !agent) {
          reply({ type: "teammate_proxy_result", requestId, result: {
            content: [{ type: "text", text: `Agent "${to}" has no restorable runtime.` }],
            isError: true, details: { delivered: false },
          }});
          return;
        }
        const now = Date.now();
        agent.promptSeq = (agent.promptSeq ?? 0) + 1;
        agent.inbox.push({
          id: randomUUID(),
          from: spawnedBy ?? "proxy",
          to,
          kind: "task",
          payload: message,
          timestamp: now,
        });
        agent.outputLog.push(`[${new Date(now).toISOString().slice(11, 19)}] ◀ cold-resume prompt: ${message.slice(0, 100)}`);
        trimAgentBuffers(agent);
        emitTeammateStarted(pi, agent);
        pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
          correlationId: cid,
          from: "caller",
          to,
          mode: "prompt",
          message,
          lastActivityAt: now,
          isSend: true,
        });
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: `Message woken up + prompt for "${to}". Agent restored from session.` }],
          isError: false, details: { delivered: true },
        }});
        return;
      }
      const writableLease = agent.lease;
      if (!writableLease || !canChildWrite(writableLease)) {
        const ownership = writableLease
          ? `${writableLease.owner} (${writableLease.state})`
          : "an unavailable lease";
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: `Agent "${to}" is currently owned by ${ownership}.` }],
          isError: true, details: { delivered: false },
        }});
        return;
      }
      const mode: RpcMessageMode = agent.status === "sleeping" && requestedMode !== "abort"
        ? "prompt"
        : requestedMode;
      const sent = sendRpcMessage(agent.stdin, message, mode, agent.lease ? leaseToken(agent.lease) : undefined);
      if (!sent) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: `Failed to send message to "${to}".` }],
          isError: true, details: { delivered: false },
        }});
        return;
      }
      const now = Date.now();
      if (mode === "prompt") agent.promptSeq = (agent.promptSeq ?? 0) + 1;
      wakeSleepingAgent(pi, agent, now);
      agent.inbox.push({ id: randomUUID(), from: spawnedBy ?? "proxy", to, kind: mode === "abort" ? "notification" : "task", payload: message, timestamp: now });
      agent.outputLog.push(`[${new Date(now).toISOString().slice(11, 19)}] ◀ ${mode}: ${message.slice(0, 100)}`);
      trimAgentBuffers(agent);
      agent.lastActivityAt = now;

      pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
        correlationId: cid,
        from: "caller",
        to,
        mode,
        message,
        lastActivityAt: now,
        isSend: true,
      });

      // Notify main session TUI
      const senderAgent = spawnedBy ? state.activeRuns.get(spawnedBy) : undefined;
      const senderLabel = senderAgent?.name ?? senderAgent?.agent ?? "agent";
      safeSendMessage(
        pi,
        {
          customType: "teammate-message",
          content: `● @${senderLabel} → @${to} (${mode}): ${message.slice(0, 120)}`,
          display: true,
        },
        { triggerTurn: true },
      );

      const modeLabel = mode === "steer" ? "interrupted + injected" : mode === "abort" ? "aborted" : "queued after current turn";
      reply({ type: "teammate_proxy_result", requestId, result: {
        content: [{ type: "text", text: `Message ${modeLabel} for "${to}".` }],
        isError: false, details: { delivered: true },
      }});
      return;
    }

    case "teammate-list": {
      const view = ((params.view as TeammateListView | undefined) ?? "active");
      if (view === "roles") {
        const { entries, text } = buildRoleList(state.baseCwd || process.cwd());
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text }], isError: false, details: { agents: entries },
        }});
        return;
      }
      if (view === "windows") {
        const windows = workspacePeerList ? await workspacePeerList() : [];
        const entries = windows.map((window) => ({ kind: "window" as const, ...window }));
        const text = entries.length === 0
          ? "No available peer sessions."
          : entries.map((window) => {
            const label = window.sessionName ?? `window:${window.ownerId.slice(0, 8)}`;
            return `● [window] ${label} · ${window.status} · agents=${window.agentCount} · target=${window.target}`;
          }).join("\n");
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text }], isError: false, details: { agents: entries },
        }});
        return;
      }
      const { entries, text } = buildAgentList(state, view as "active" | "named" | "all");
      reply({ type: "teammate_proxy_result", requestId, result: {
        content: [{ type: "text", text }], isError: false, details: { agents: entries },
      }});
      return;
    }

    case "teammate-watch": {
      const name = params.name as string;
      const observed = await observeTargets({
        action: "status",
        targets: [{ kind: "teammate", id: name }],
        detail: "full",
        lines: (params.lines as number) ?? 20,
      });
      const observation = observed.observations[0]!;
      const output = observation.found ? (observation.detail ?? [observation.summary]) : [];
      reply({ type: "teammate_proxy_result", requestId, result: {
        content: [{ type: "text", text: observation.found ? output.join("\n") : observation.summary }],
        isError: !observation.found,
        details: { output },
      }});
      return;
    }
  }

    reply({
      type: "teammate_proxy_result",
      requestId,
      result: {
        content: [{ type: "text", text: `Unsupported teammate child proxy tool: ${tool}` }],
        isError: true,
      },
    });
  } catch (error) {
    abandonPendingProxyDispatch();
    if (replied) return;
    try {
      replyProxyFailure(event, reply, error);
    } catch (deliveryError) {
      console.error("[pi-maestro-teammate] failed to deliver proxy error envelope", deliveryError);
    }
  }
}


