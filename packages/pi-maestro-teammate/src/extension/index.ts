/**
 * Teammate Extension Entry Point
 *
 * Tools: teammate (dispatch), teammate-send (RPC message injection), teammate-list (status), observe
 * TUI: Alt+R mode-aware session list, widget above editor, Alt+B foreground→background detach
 * Mode: RPC subprocess — stdin open for steer/follow_up/abort
 */

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Check } from "typebox/value";
import { isGuiTeammateToolAllowed, registerGuiTool, unregisterGuiTool } from "../shared/gui-registry.ts";
import { Text, truncateToWidth, visibleWidth, matchesKey, isKeyRelease, isKeyRepeat } from "@earendil-works/pi-tui";
import { loadTranscript, scanWorkspaceSessionDirs, groupTranscriptTurns, type WorkspaceSessionScan } from "../transcript/session-transcript.ts";
import type { TranscriptRow } from "../shared/transcript.ts";
import { TeammateParams, TeammateSendParams, TeammateListParams, TeammateWatchParams, TeammateWaitParams, TeammateMonitorParams, ObserveParams, WorkspaceWindowParams } from "./schemas.ts";
import {
  formatObserveResult,
  observeTargets,
  registerObservationProvider,
  type ObserveParams as UnifiedObserveParams,
  type ObservationReadOptions,
  type ObserveResult,
  type ObservationProvider,
  type ObservationSnapshot,
  type ObservationTarget,
  type ObservationWaitStatus,
} from "../public/v1/observation.ts";
import {
  activePromptLoopIdsFromPayload,
  appendMonitorModeContext,
  formatCompact,
  formatVerbose,
  formatHeader,
  formatBarrierCompact,
  validateMonitorParams,
  MONITOR_STATUS_KEY,
  MONITOR_DEFAULT_TIMEOUT_MS,
  MONITOR_DEFAULT_LINES,
  createEngineState,
  DEFAULT_MONITOR_CONFIG,
  normalizeMonitorConfig,
  flushPendingMonitorLedger,
  deriveMonitorMetrics,
  formatMonitorMetrics,
  type EngineAgentInfo,
  type MonitorEngineConfig,
  type MonitorTargetSnapshot,
  type MonitorParams,
  type MonitorSupervisionMode,
} from "./monitor.ts";
import { MonitorController, type MonitorControllerBindingRequest } from "./monitor-controller.ts";
import { MonitorLeaseAdapter } from "./monitor-lease.ts";
import {
  MONITOR_SESSION_ENV_VAR,
  MONITOR_SESSION_NAME,
  MONITOR_SESSION_RELATIVE_DIR,
  MonitorSessionEvaluator,
  type MonitorEvaluationRequest,
  type MonitorSessionHost,
  type MonitorSessionInvocation,
  type MonitorSessionTurnResult,
} from "./monitor-session.ts";
import {
  appendMonitorLedgerRecord,
  deriveMonitorLedgerState,
  loadMonitorLedger,
  reconcileMonitorLedger,
  type MonitorLedgerRecord,
  type MonitorLedgerState,
} from "./monitor-ledger.ts";
import {
  appendPeerGoalObjection,
  buildGoalContextBlock,
  loadPeerGoalContext,
} from "./monitor-goals.ts";
import {
  buildDelegatedWorkerBootstrap,
  buildDelegationDelivery,
  buildDelegationPlannerPrompt,
  cancelDelegationDraft,
  createDelegationDraft,
  DELEGATION_TASK_SCHEMA,
  delegationDocumentPath,
  listDelegationRecords,
  loadDelegationRecord,
  parseDelegationCommand,
  parseDelegationTaskDraft,
  readDelegationDocument,
  updateDelegationRecord,
  type DelegationRecord,
  type DelegationSourceContext,
  type DelegationWorkerContext,
} from "./task-delegation.ts";
import {
  DEFAULT_ADVISOR_CONFIG,
  buildAdvisorPrompt,
  createAdvisorState,
  extractAdvisorTranscript,
  normalizeAdvisorConfig,
  parseAdvisorVerdict,
  shouldReview,
  ADVISOR_VERDICT_SCHEMA,
  type AdvisorConfig,
  type AdvisorMessageSlice,
  type AdvisorState,
  type AdvisorVerdict,
} from "./advisor.ts";
import { runSupervisedEvaluation } from "../supervision/evaluator.ts";
import { SUPERVISION_EVENT, createSupervisionEvent } from "../supervision/types.ts";
import {
  createWorkspacePeerCommandConsumer,
  createWorkspacePeerRuntime,
  discoverWorkspacePeers,
  enqueueWorkspacePeerCommand,
  formatWorkspaceRemoteRootMessage,
  resolveWorkspaceOwnerByName,
  resolveWorkspaceTarget,
  shouldReplayWorkspaceRootQueue,
  activeWorkspaceBackgroundJobsFromPayload,
  waitForWorkspacePeerCommandResponse,
  workspaceMainSessionDeliveryDecision,
  WORKSPACE_MAIN_SESSION_MARKER,
  type WorkspaceAgentSnapshot,
  type WorkspaceBackgroundJobSnapshot,
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
  prepareTeammateMode,
  normalizeTeammateParams,
  inferGraphMode,
  taskDependencyNames,
  sendRpcMessage,
  truncateUtf8Tail,
  checkDepthGuard,
  getTeammateDepth,
  getTeammateMaxDispatchDepth,
  MAX_DEFAULT_DEPTH,
  resolveMaxActiveAgents,
  rootChildMaxDispatchDepth,
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
import { sharedModelCircuitBreaker } from "../public/v1/retry.ts";
import { normalizePiRetryErrorMessage } from "../runs/retry.ts";
import {
  createChildTerminationController,
  getInteractiveTerminalLaunchSpec,
  getPiSpawnCommand,
  terminateProcessTreeByPid,
  type ChildTerminationController,
} from "../runs/execution-infra.ts";
import { showMonitorOverlay, type MonitorSessionRow } from "../tui/monitor-overlay.ts";
import { showSessionSendOverlay } from "../tui/session-send-overlay.ts";
import {
  SETTINGS_LOCALE_EVENT,
  applySettingsLocaleEvent,
  translateStatusIdentifier,
  tuiT,
} from "../tui/locale.ts";
import { createTeammateSettingsProvider, registerTeammateSettingsProvider } from "../settings/teammate-settings-provider.ts";
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
  appendTaskTypeRoutingContext,
  formatModelRoutingConfig,
  parseTeammateTaskType,
  refreshModelRegistry,
  type TeammateTaskType,
} from "../models/model-routing.ts";
import type { TeammateThinkingInput } from "../shared/thinking.ts";
import {
  getTeammateChildToolBroker,
  getTeammatePermissionBroker,
  registerTeammateChildProxyCaller,
} from "../runs/child-extensions.ts";
import { setQuietMode } from "../quiet-state.ts";
import { aggregateAgentRunPhase } from "../shared/agent-status.ts";
import { formatLocalAgentMessage } from "../shared/routing.ts";
export * from "./teammate-core.ts";
import {
  appendTeammateDepthContext,
  rejectAllChildProxyRequests,
  buildTeammateToolDescription,
  resolveChildProxyRequest,
  createIpcSender,
  createChildProxyRequest,
  CHILD_PROXY_TIMEOUT_MS,
  TEAMMATE_PROMPT_SNIPPET,
  TEAMMATE_PROMPT_GUIDELINES,
  TEAMMATE_SEND_DESCRIPTION,
  TEAMMATE_SEND_SNIPPET,
  TEAMMATE_SEND_GUIDELINES,
  TEAMMATE_LIST_DESCRIPTION,
  TEAMMATE_LIST_SNIPPET,
  TEAMMATE_LIST_GUIDELINES,
  exposeLegacyObservationTools,
  TEAMMATE_WATCH_DESCRIPTION,
  TEAMMATE_WATCH_SNIPPET,
  TEAMMATE_WATCH_GUIDELINES,
  TEAMMATE_WAIT_DESCRIPTION,
  TEAMMATE_WAIT_SNIPPET,
  TEAMMATE_WAIT_GUIDELINES,
  OBSERVE_DESCRIPTION,
  OBSERVE_SNIPPET,
  OBSERVE_GUIDELINES,
  TEAMMATE_MONITOR_DESCRIPTION,
  TEAMMATE_MONITOR_SNIPPET,
  TEAMMATE_MONITOR_GUIDELINES,
  buildWorkspaceOwnerState,
  wakeSleepingAgent,
  trimAgentBuffers,
  checkActiveAgentBudget,
  emitTeammateStarted,
  displayMessageForResult,
  terminalStatusForResult,
  resultIsError,
  aggregateTerminalStatus,
  aggregateTerminalStatuses,
  handleChildLifecycleEvent,
  AGENT_BUFFER_LIMITS,
  LIVE_AGENT_STATUSES,
  applyTeammateAgentCommand,
  createProgressFlushGate,
  flushProgressBatch,
  runWithProgressFlushCleanup,
  summarizeGraphResults,
  aggregateGraphStructuredOutput,
  toStructuredResults,
  emitTeammateResultPublished,
  setAgentStructuredOutput,
  foregroundWaitWindowMs,
  concurrencyWaitWindowMs,
  createForegroundDeadline,
  backgroundWaitGuidance,
  FOREGROUND_DETACH_HINT,
  setPersistentUi,
  registerForegroundDetach,
  buildAgentSelectorRows,
  renderAgentSelectorPanel,
  switchConversationSession,
  restoreMainOwnershipIfHandbackPending,
  AGENT_WIDGET_IDLE_HIDE_MS,
  renderAgentStatusWidget,
  COCKPIT_UI_OWNERSHIP_EVENT,
} from "./teammate-core.ts";
import {
  COCKPIT_PREEMPT_RESIZE_EVENT,
  COCKPIT_SESSION_LIST_EVENT,
  TEAMMATE_AGENT_COMMAND_EVENT,
} from "../shared/cockpit-events.ts";
import type { TeammateRuntimeOptions, ProgressFlushGate, AgentWidgetTheme, AgentWidgetRow, AgentSelectorRow, PendingChildProxyRequest, ChildProxyPendingRequests, IpcSender } from "./teammate-core.ts";
import { buildHistoryRows, historyRowKey } from "./teammate-core.ts";
import { MailboxHost, mailboxModeFromEnv } from "./mailbox/host.ts";
import { createDirectAgentHostRegistry, createMailboxHostRegistry, MAILBOX_REGISTRY_KEY } from "../public/v1/mailbox.ts";
import {
  SessionHostRegistry,
  WindowThreadStore,
  createLocalAgentMailboxTransportAdapter,
  createLocalRootTransportAdapter,
  createWorkspacePeerV1TransportAdapter,
  getSessionHostRegistry,
  publishSessionHostRegistry,
  sessionRootEndpointId,
  windowThreadReplayReceipt,
  SESSION_HOST_REGISTRY_EVENT,
  WINDOW_THREAD_ENTRY_TYPE,
  WINDOW_THREAD_EVENT,
  sessionSurfaceModeFromEnv,
  type LegacySessionAuthority,
  type SessionEndpoint,
  type SessionMessageRequest,
  type SessionMessageResult,
  type SessionMessageKind,
  type SessionResolution,
  type WindowThreadEntryInput,
  type WindowThreadStatus,
} from "../sessions/session-core.ts";
import {
  formatWorkspaceWindowInbox,
  loadWorkspaceWindowInbox,
  resolveWindowInboxAnchor,
  type WindowInboxQuery,
} from "../sessions/window-inbox.ts";
import { projectTeammateSessionEndpoints } from "./session-endpoints.ts";

/** Shared-process bridge key: the root host publishes the live v1 mailbox registry here. */
export { MAILBOX_REGISTRY_KEY } from "../public/v1/mailbox.ts";


export default function registerTeammateExtension(
  pi: ExtensionAPI,
  runtimeOptions: TeammateRuntimeOptions = {},
): void {
  pi.registerMessageRenderer(
    "teammate-started",
    (message, _options, theme) => {
      const content = typeof message.content === "string"
        ? message.content.replace(/^●\s*/, "")
        : "agent spawned";
      return renderQuietTeammateAux("teammate-started", content, "success", theme as ExtensionContext["ui"]["theme"]);
    },
  );

  pi.registerMessageRenderer<Details | { result?: SingleResult }>(
    "teammate-complete",
    (message, options, theme) => {
      const rawDetails = message.details;
      let details: Details | undefined;
      if (rawDetails && "results" in rawDetails && Array.isArray(rawDetails.results)) {
        details = rawDetails as Details;
      } else if (rawDetails && "result" in rawDetails && rawDetails.result) {
        details = { mode: "single", results: [rawDetails.result] };
      }
      if (!details) return undefined;

      const content = typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
      return renderTeammateResult({
        content,
        details,
      }, options, theme as ExtensionContext["ui"]["theme"]);
    },
  );

  const isChild = process.env.PI_TEAMMATE_CHILD === "1";
  const currentDepth = isChild ? getTeammateDepth() : 0;
  // Child env depth is record depth + 1; the child may dispatch iff its record
  // depth stays under its budget, i.e. envDepth <= maxDispatchDepth. A budget
  // of 0 (maxNestingDepth: 0 dispatch) hides the proxy tool entirely.
  const currentMaxDispatchDepth = isChild ? getTeammateMaxDispatchDepth() : undefined;
  const canDispatchNestedTeammate = !isChild
    || currentDepth <= (currentMaxDispatchDepth ?? MAX_DEFAULT_DEPTH - 1);

  // A re-registered extension instance starts from a cold role catalog, so
  // reload semantics stay identical to a fresh process. Session cwd switches
  // and role additions/edits invalidate themselves via the cache key and the
  // directory manifest signature.
  invalidateAgentCatalogCache();

  // UCL: expose teammate tools to the GUI sidecar via the shared cross-extension
  // registry (globalThis symbol). Each extension owns a distinct registerTool, so
  // this capture is independent of pi-maestro-flow's. Root mode only.
  if (!isChild) {
    for (const legacy of ["teammate-watch", "teammate-wait", "teammate-monitor"]) {
      unregisterGuiTool(legacy, "pi-maestro-teammate");
    }
    const originalRegisterTool = pi.registerTool.bind(pi);
    (pi as unknown as { registerTool: (tool: unknown) => unknown }).registerTool = (tool: unknown) => {
      const candidate = tool as { name?: unknown; execute?: unknown };
      if (candidate && typeof candidate.name === "string" && typeof candidate.execute === "function" && isGuiTeammateToolAllowed(candidate.name, "pi-maestro-teammate")) {
        try {
          registerGuiTool(tool as ToolDefinition, "pi-maestro-teammate");
        } catch {
          // GUI capture must never break tool registration.
        }
      }
      return originalRegisterTool(tool as ToolDefinition);
    };
  }
  let modelCatalog: ModelCatalogSnapshot = createModelCatalogSnapshot([]);
  let monitorInteractionModeActive = false;

  const refreshModelCatalog = (ctx: ExtensionContext): ModelCatalogSnapshot => {
    const next = createModelCatalogSnapshot(ctx.modelRegistry?.getAvailable?.() ?? []);
    if (next.signature !== modelCatalog.signature) modelCatalog = next;
    return modelCatalog;
  };

  /** Catalog id of the main session's current model, when one is active. */
  const sessionModelId = (ctx: ExtensionContext): string | undefined => {
    const model = ctx.model;
    if (!model) return undefined;
    const id = `${model.provider}/${model.id}`;
    return id.trim() ? id : undefined;
  };

  const injectTeammateContext = (
    event: { systemPrompt: string },
    ctx: ExtensionContext,
  ): { systemPrompt: string } => {
    const withModels = appendModelCatalog(event.systemPrompt, refreshModelCatalog(ctx));
    const withAgents = appendAgentCatalog(withModels, ctx.cwd);
    const withTaskType = canDispatchNestedTeammate
      ? appendTaskTypeRoutingContext(withAgents, ctx.cwd, discoverAgents(ctx.cwd))
      : withAgents;
    const withDepth = appendTeammateDepthContext(withTaskType, currentDepth, currentMaxDispatchDepth);
    return { systemPrompt: monitorInteractionModeActive ? appendMonitorModeContext(withDepth) : withDepth };
  };

  // =========================================================================
  // Child mode: register proxy tools that forward to root via stdout/IPC
  // =========================================================================

  if (isChild) {
    const bridgeKey = Symbol.for("pi-maestro-teammate.child-handoff");
    interface ChildHandoffBridge {
      ctx?: ExtensionContext;
      parked: boolean;
      parking: boolean;
      nonce?: string;
      listenerInstalled: boolean;
      lifecycleListenersInstalled: boolean;
      pollTimer?: ReturnType<typeof setInterval>;
      pendingRequests: ChildProxyPendingRequests;
      expectedLease?: LeaseToken;
      acceptedPromptSeq: number;
      requiredPromptSeq: number;
      completedPromptSeq: number;
      idleStableTicks: number;
    }
    const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
    const bridge: ChildHandoffBridge = (globals[bridgeKey] as ChildHandoffBridge | undefined) ?? {
      parked: false,
      parking: false,
      listenerInstalled: false,
      lifecycleListenersInstalled: false,
      pendingRequests: new Map(),
      acceptedPromptSeq: 0,
      requiredPromptSeq: 0,
      completedPromptSeq: 0,
      idleStableTicks: 0,
    };
    globals[bridgeKey] = bridge;
    const pendingRequests = bridge.pendingRequests;
    let unregisterChildProxyCaller: (() => void) | undefined;

    const sendChildEvent = (message: Record<string, unknown>): void => {
      if (typeof process.send !== "function" || process.connected === false) return;
      try {
        process.send(message, () => {});
      } catch {
        // Parent IPC closed between the connected check and send.
      }
    };

    const publishSessionIdentity = (ctx: ExtensionContext): void => {
      bridge.ctx = ctx;
      sendChildEvent({
        type: "teammate_session_ready",
        correlationId: process.env.PI_TEAMMATE_CORRELATION_ID,
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
      });
    };

    pi.on("session_start", (_event, ctx) => {
      installChildProxyCaller();
      if (bridge.ctx) {
        rejectAllChildProxyRequests(
          pendingRequests,
          new Error("Teammate child session restarted before the proxy request completed."),
        );
      }
      publishSessionIdentity(ctx);
      refreshModelCatalog(ctx);
      // Nested-context (proxy) tool: trimmed variant without the per-cwd routing
      // table; execution is proxied to the parent root process.
      proxyTeammateTool.description = buildTeammateToolDescription(ctx.cwd, { nested: true });
      if (canDispatchNestedTeammate) pi.registerTool(proxyTeammateTool);
    });
  pi.on("before_agent_start", injectTeammateContext);
    pi.on("session_compact", (_event, ctx) => publishSessionIdentity(ctx));
    pi.on("message_end", (event, ctx) => {
      publishSessionIdentity(ctx);
      if (event.message.role !== "assistant" || event.message.stopReason !== "error") return;
      const errorMessage = normalizePiRetryErrorMessage(event.message.errorMessage);
      if (!errorMessage || errorMessage === event.message.errorMessage) return;
      return { message: { ...event.message, errorMessage } };
    });
    pi.on("agent_end", (_event, ctx) => {
      publishSessionIdentity(ctx);
      bridge.completedPromptSeq = bridge.acceptedPromptSeq;
      bridge.idleStableTicks = 0;
    });
    pi.on("session_shutdown", () => {
      disposeChildProxyCaller();
      if (bridge.pollTimer) clearInterval(bridge.pollTimer);
      bridge.pollTimer = undefined;
      bridge.ctx = undefined;
      rejectAllChildProxyRequests(
        pendingRequests,
        new Error("Teammate child session shut down before the proxy request completed."),
      );
    });
    pi.on("input", (event) => {
      if (event.text.startsWith("/teammate-handoff-reload ")) {
        return bridge.expectedLease?.owner === "none" ? { action: "continue" } : { action: "handled" };
      }
      if (bridge.parked) return { action: "handled" };
      const unwrapped = unwrapLeasedMessage(event.text);
      if (unwrapped.malformed) return { action: "handled" };
      if (bridge.expectedLease && !sameLeaseToken(bridge.expectedLease, unwrapped.token)) {
        return { action: "handled" };
      }
      bridge.acceptedPromptSeq++;
      bridge.idleStableTicks = 0;
      if (unwrapped.token) return { action: "transform", text: unwrapped.message };
      return { action: "continue" };
    });

    pi.registerCommand("teammate-handoff-reload", {
      description: "Internal: reload a parked teammate session before ownership return",
      async handler(args, ctx) {
        const sessionFile = decodeURIComponent(args.trim());
        if (!sessionFile) return;
        await ctx.switchSession(sessionFile, {
          withSession: async (nextCtx) => {
            bridge.ctx = nextCtx;
            bridge.parked = false;
            bridge.parking = false;
            sendChildEvent({
              type: "teammate_handoff_returned",
              correlationId: process.env.PI_TEAMMATE_CORRELATION_ID,
              nonce: bridge.nonce,
              sessionId: nextCtx.sessionManager.getSessionId(),
              sessionFile: nextCtx.sessionManager.getSessionFile(),
            });
          },
        });
      },
    });

    // IPC listener: receive results from root
    if (typeof process.send === "function" && !bridge.listenerInstalled) {
      bridge.listenerInstalled = true;
      process.on("message", (msg: unknown) => {
        const m = msg as Record<string, unknown>;
        if (m?.type === "teammate_proxy_result") {
          resolveChildProxyRequest(pendingRequests, m.requestId as string, m.result);
        } else if (m?.type === "teammate_complete_delivery") {
          // Passive completion delivery from the root: a background nested
          // dispatch ran in the root process and finished. Inject the same
          // teammate-complete envelope into this child's own session so the
          // agent wakes for a new turn with the result — send stays explicit
          // (teammate-send), complete is delivered automatically on completion.
          // CorrelationId scoping keeps the delivery with the child process it
          // belongs to; a missing bridge.ctx (session inactive) drops it.
          if (!bridge.ctx) return;
          if (m.correlationId !== process.env.PI_TEAMMATE_CORRELATION_ID) return;
          const deliverySessionId = typeof m.sessionId === "string" ? m.sessionId : undefined;
          if (!deliverySessionId || deliverySessionId !== bridge.ctx.sessionManager.getSessionId()) return;
          const envelope = m.envelope as Record<string, unknown> | undefined;
          if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
            || typeof envelope.customType !== "string") return;
          safeSendMessage(pi, envelope as never, { triggerTurn: true });
        } else if (m?.type === "teammate_handoff_request") {
          bridge.parking = true;
          bridge.nonce = m.nonce as string;
          bridge.requiredPromptSeq = Number(m.requiredPromptSeq ?? bridge.acceptedPromptSeq);
          bridge.idleStableTicks = 0;
          if (bridge.pollTimer) clearInterval(bridge.pollTimer);
          bridge.pollTimer = setInterval(() => {
            if (!bridge.parking || bridge.completedPromptSeq < bridge.requiredPromptSeq) return;
            bridge.idleStableTicks = bridge.ctx?.isIdle() ? bridge.idleStableTicks + 1 : 0;
            if (!handoffBarrierReached(bridge.requiredPromptSeq, bridge.completedPromptSeq, bridge.idleStableTicks)) return;
            const ctx = bridge.ctx;
            if (!ctx) return;
            if (bridge.pollTimer) clearInterval(bridge.pollTimer);
            bridge.pollTimer = undefined;
            bridge.parking = false;
            bridge.parked = true;
            sendChildEvent({
              type: "teammate_handoff_ready",
              correlationId: process.env.PI_TEAMMATE_CORRELATION_ID,
              nonce: bridge.nonce,
              sessionId: ctx.sessionManager.getSessionId(),
              sessionFile: ctx.sessionManager.getSessionFile(),
            });
          }, 50);
        } else if (m?.type === "teammate_lease_update") {
          bridge.expectedLease = m.token as LeaseToken | undefined;
          if (bridge.expectedLease?.owner === "none") bridge.nonce = bridge.expectedLease.nonce;
        } else if (m?.type === "teammate_handoff_cancel" && m.nonce === bridge.nonce) {
          bridge.parking = false;
          bridge.parked = false;
          if (bridge.pollTimer) clearInterval(bridge.pollTimer);
          bridge.pollTimer = undefined;
          sendChildEvent({
            type: "teammate_handoff_cancelled",
            correlationId: process.env.PI_TEAMMATE_CORRELATION_ID,
            nonce: bridge.nonce,
          });
        }
      });
    }
    if (!bridge.lifecycleListenersInstalled) {
      bridge.lifecycleListenersInstalled = true;
      process.once("disconnect", () => {
        rejectAllChildProxyRequests(
          pendingRequests,
          new Error("Teammate parent IPC disconnected before the proxy request completed."),
        );
      });
      process.once("exit", () => {
        rejectAllChildProxyRequests(
          pendingRequests,
          new Error("Teammate child exited before the proxy request completed."),
        );
      });
    }

    async function proxyCall<T>(
      tool: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<TeammateToolResult<T>> {
      const send = createIpcSender();
      if (!send) {
        throw new Error("IPC not available. Teammate proxy requires IPC channel.");
      }
      const requestId = randomUUID();
      const result = await createChildProxyRequest(
        pendingRequests,
        requestId,
        {
          type: "teammate_proxy_request",
          tool,
          requestId,
          params,
          correlationId: process.env.PI_TEAMMATE_CORRELATION_ID,
        },
        send,
        CHILD_PROXY_TIMEOUT_MS,
        signal,
      );
      if (!isTeammateToolResult(result)) {
        throw new Error(`Teammate proxy "${tool}" returned an invalid result envelope.`);
      }
      return result as TeammateToolResult<T>;
    }

    function installChildProxyCaller(): void {
      unregisterChildProxyCaller ??= registerTeammateChildProxyCaller((toolName, input, signal) =>
        proxyCall(toolName, input, signal)
      );
    }

    function disposeChildProxyCaller(): void {
      const unregister = unregisterChildProxyCaller;
      unregisterChildProxyCaller = undefined;
      unregister?.();
    }

    installChildProxyCaller();

    const proxyTeammateObservation = async (
      action: "status" | "wait",
      id: string,
      options: ObservationReadOptions & { deadline?: number },
      signal?: AbortSignal,
    ): Promise<ObservationSnapshot> => {
      const response = await proxyCall<{ output: string[]; result: ObserveResult }>("observe", {
        action,
        targets: [{ kind: "teammate", id }],
        detail: options.detail,
        lines: options.lines,
        ...(options.view ? { view: options.view } : {}),
        ...(options.turn !== undefined ? { turn: options.turn } : {}),
        ...(action === "wait" ? {
          waitMode: "all",
          timeoutMs: Math.max(1, (options.deadline ?? Date.now() + MONITOR_DEFAULT_TIMEOUT_MS) - Date.now()),
        } : {}),
      }, signal);
      const observation = response.details?.result.observations[0];
      if (!observation) throw new Error(`Parent observe returned no teammate observation for "${id}".`);
      return observation;
    };
    registerObservationProvider({
      kind: "teammate",
      capabilities: { inspect: true, wait: true, cancel: true, message: true, supervise: true },
      snapshot: (id, options) => proxyTeammateObservation("status", id, options),
      wait: (id, options) => proxyTeammateObservation("wait", id, options, options.signal),
    });

    if (process.env.PI_TEAMMATE_MONITOR === "1") {
      const proxyWorkspaceObservation = async (
        action: "status" | "wait",
        id: string,
        options: ObservationReadOptions & { deadline?: number },
        signal?: AbortSignal,
      ): Promise<ObservationSnapshot> => {
        const response = await proxyCall<{ output: string[]; result: ObserveResult }>("observe", {
          action,
          targets: [{ kind: "workspace", id }],
          detail: options.detail,
          lines: options.lines,
          ...(options.view ? { view: options.view } : {}),
          ...(options.turn !== undefined ? { turn: options.turn } : {}),
          ...(action === "wait" ? {
            waitMode: "all",
            timeoutMs: Math.max(1, (options.deadline ?? Date.now() + MONITOR_DEFAULT_TIMEOUT_MS) - Date.now()),
          } : {}),
        }, signal);
        const observation = response.details?.result.observations[0];
        if (!observation) throw new Error(`Parent observe returned no workspace observation for "${id}".`);
        return observation;
      };
      registerObservationProvider({
        kind: "workspace",
        capabilities: { inspect: true, wait: true, cancel: true, message: true, supervise: true },
        snapshot: (id, options) => proxyWorkspaceObservation("status", id, options),
        wait: (id, options) => proxyWorkspaceObservation("wait", id, options, options.signal),
      });
    }

    const proxyTeammateTool: ToolDefinition<typeof TeammateParams, Details> = {
      name: "teammate",
      label: "Teammate",
      renderShell: "self",
      // Initial placeholder (module-load cwd); refreshed with the session cwd at
      // session_start below. Nested variant omits the per-cwd routing table.
      description: buildTeammateToolDescription(process.cwd(), { nested: true }),
      promptSnippet: TEAMMATE_PROMPT_SNIPPET,
      promptGuidelines: TEAMMATE_PROMPT_GUIDELINES,
      parameters: TeammateParams,
      async execute(_id: string, params: RunTeammateParams, signal: AbortSignal) {
        return proxyCall<Details>("teammate", params, signal);
      },
      renderCall(args, theme, context) {
        return renderTeammateCall(args, theme, context);
      },
      renderResult(result, options, theme, context) {
        return renderTeammateResult(result, options, theme, context?.args);
      },
    };
    if (canDispatchNestedTeammate) pi.registerTool(proxyTeammateTool);

    pi.registerTool({
      name: "teammate-send",
      label: "Teammate Send",
      renderShell: "self",
      description: TEAMMATE_SEND_DESCRIPTION,
      promptSnippet: TEAMMATE_SEND_SNIPPET,
      promptGuidelines: TEAMMATE_SEND_GUIDELINES,
      parameters: TeammateSendParams,
      async execute(_id: string, params: { to: string; message?: string; mode?: RpcMessageMode; kind?: SessionMessageKind }, signal: AbortSignal) {
        return proxyCall<{ delivered: boolean }>("teammate-send", params, signal);
      },
    });

    pi.registerTool({
      name: "teammate-list",
      label: "Teammate List",
      renderShell: "self",
      description: TEAMMATE_LIST_DESCRIPTION,
      promptSnippet: TEAMMATE_LIST_SNIPPET,
      promptGuidelines: TEAMMATE_LIST_GUIDELINES,
      parameters: TeammateListParams,
      async execute(_id: string, params: WindowInboxQuery & { view?: TeammateListView }, signal: AbortSignal) {
        return proxyCall<{ agents: unknown[] }>("teammate-list", params, signal);
      },
      renderCall(args, theme, context) {
        return renderTeammateListCall(args, theme, context);
      },
      renderResult(result, options, theme) {
        return renderTeammateListResult(result, options, theme);
      },
    });

    if (exposeLegacyObservationTools()) {
      pi.registerTool({
        name: "teammate-watch",
        label: "Teammate Watch",
        renderShell: "self",
        description: TEAMMATE_WATCH_DESCRIPTION,
        promptSnippet: TEAMMATE_WATCH_SNIPPET,
        promptGuidelines: TEAMMATE_WATCH_GUIDELINES,
        parameters: TeammateWatchParams,
        async execute(_id: string, params: { name: string; lines?: number }, signal: AbortSignal) {
          return proxyCall<{ output: string[] }>("teammate-watch", params, signal);
        },
      });

      pi.registerTool({
        name: "teammate-wait",
        label: "Teammate Wait",
        renderShell: "self",
        description: TEAMMATE_WAIT_DESCRIPTION,
        promptSnippet: TEAMMATE_WAIT_SNIPPET,
        promptGuidelines: TEAMMATE_WAIT_GUIDELINES,
        parameters: TeammateWaitParams,
        async execute(_id: string, params: { name?: string; timeoutMs?: number; waitMs?: number }, signal: AbortSignal) {
          return proxyCall<{ status: TeammateWaitStatus; output: string[] }>("teammate-wait", params, signal);
        },
      });
    }

    pi.registerTool({
      name: "observe",
      label: "Observe",
      renderShell: "self",
      description: OBSERVE_DESCRIPTION,
      promptSnippet: OBSERVE_SNIPPET,
      promptGuidelines: OBSERVE_GUIDELINES,
      parameters: ObserveParams,
      async execute(_id: string, params: UnifiedObserveParams, signal: AbortSignal) {
        const result = await observeTargets(params, signal);
        const output = formatObserveResult(result, params.detail !== "summary" || params.view === "turns");
        const failed = result.reason === "timeout"
          || result.reason === "aborted"
          || result.observations.some((item) => !item.found || item.outcome === "failure" || item.outcome === "stalled");
        return {
          content: [{ type: "text", text: output.join("\n") }],
          isError: failed,
          details: { output, result },
        };
      },
    });

    if (exposeLegacyObservationTools()) {
      pi.registerTool({
        name: "teammate-monitor",
        label: "Teammate Monitor",
        renderShell: "self",
        description: TEAMMATE_MONITOR_DESCRIPTION,
        promptSnippet: TEAMMATE_MONITOR_SNIPPET,
        promptGuidelines: TEAMMATE_MONITOR_GUIDELINES,
        parameters: TeammateMonitorParams,
        async execute(_id: string, params: MonitorParams, signal: AbortSignal) {
          return proxyCall<{ output: string[] }>("teammate-monitor", params, signal);
        },
      });
    }

    return; // Child mode done — skip root-mode registration
  }

  // =========================================================================
  // ROOT MODE — full tool implementations below
  // =========================================================================

  const registryKey = Symbol.for("pi-maestro-teammate.root-registry");
  const rootGlobals = globalThis as typeof globalThis & Record<symbol, unknown>;
  const state: TeammateState = (rootGlobals[registryKey] as TeammateState | undefined) ?? {
    baseCwd: "",
    currentSessionId: null,
    sessionGeneration: 0,
    activeRuns: new Map(),
    namedAgents: new Map(),
  };
  rootGlobals[registryKey] = state;
  const interactionQueue = createTeammateInteractionQueue(pi, state);
  const foregroundToolRuns = new Set<string>();
  state.cancelInteractions = (correlationId, reason) =>
    void interactionQueue.cancelForAgent(correlationId, reason);

  /** Completed teammate sessions recovered from disk (post-restart history). */
  let historyScans: WorkspaceSessionScan[] = [];
  const historyByKey = new Map<string, WorkspaceSessionScan>();

  function rebuildHistory(ctx: ExtensionContext): void {
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    historyByKey.clear();
    historyScans = sessionFile ? scanWorkspaceSessionDirs(sessionFile) : [];
    historyScans.forEach((scan) =>
      historyByKey.set(historyRowKey(scan), scan),
    );
  }

  /** Read-only view target for a completed session recovered from disk. */
  function historyVirtualAgent(
    scan: WorkspaceSessionScan,
  ): ActiveAgent {
    return {
      agent: "teammate",
      correlationId: historyRowKey(scan),
      startedAt: scan.startedAt ?? Date.now(),
      abortController: new AbortController(),
      inbox: [],
      outputLog: [],
      lastActivityAt: scan.startedAt ?? Date.now(),
      status: "completed",
      depth: 0,
      sleepMs: 0,
      sessionFile: scan.sessionFile,
    };
  }

  let workspacePeerPublisher: WorkspacePeerPublisher | undefined;
  let workspacePeerConsumer: WorkspacePeerCommandConsumer | undefined;
  let workspacePeerSessionName: string | undefined;
  let workspacePeerOwners: WorkspaceOwnerSnapshot[] = [];
  let workspaceBackgroundJobs: WorkspaceBackgroundJobSnapshot[] = [];
  let activePromptLoopIds: string[] = [];
  let workspacePeerRefresh: Promise<WorkspaceOwnerSnapshot[]> | undefined;
  let workspacePeerLifecycle = Promise.resolve();
  let sessionHostRegistry: SessionHostRegistry | undefined;

  const replayQueuedIncomingRootMessages = (ctx: ExtensionContext): void => {
    const registry = sessionHostRegistry;
    if (!registry) return;
    const workspaceId = workspaceIdForCwd(ctx.cwd);
    for (const entry of registry.thread.list()) {
      if (entry.direction !== "incoming"
        || (entry.status !== "pending" && entry.status !== "queued")
        || entry.workspaceId !== workspaceId
        || entry.targetCorrelationId !== WORKSPACE_MAIN_SESSION_MARKER) continue;
      const effectiveAction = entry.effectiveMode ?? "follow_up";
      const delivered = safeSendMessage(pi, {
        customType: "teammate-message",
        content: formatWorkspaceRemoteRootMessage({
          messageId: entry.messageId,
          fromOwnerId: entry.peerOwnerId,
          message: entry.body,
          effectiveAction,
          source: entry.source,
          messageKind: entry.messageKind,
          traceId: entry.traceId,
          replyTo: entry.replyTo,
          fromSessionName: entry.fromSessionName,
        }),
        display: true,
        details: {
          source: "workspace-peer",
          messageId: entry.messageId,
          fromOwnerId: entry.peerOwnerId,
          requestedMode: entry.mode,
          mode: effectiveAction,
          ...(entry.messageKind === undefined ? {} : { messageKind: entry.messageKind }),
          replayed: true,
        },
      }, {
        triggerTurn: true,
        deliverAs: "followUp",
      });
      if (!delivered) registry.thread.transition(entry.messageId, "incoming", "rejected", Date.now(), effectiveAction);
    }
  };

  const refreshSessionEndpointDirectory = (includeUnboundLocal = false): void => {
    const registry = sessionHostRegistry;
    const publisher = workspacePeerPublisher;
    if (!registry) return;
    if (!publisher && !includeUnboundLocal) {
      registry.replaceEndpoints([]);
      return;
    }
    const localIdentity = publisher?.identity ?? {
      workspaceId: workspaceIdForCwd(state.baseCwd),
      ownerId: "0".repeat(32),
      ownerNonce: "0".repeat(32),
    };
    registry.replaceEndpoints(projectTeammateSessionEndpoints(
      state,
      localIdentity,
      publisher ? workspacePeerOwners : [],
      workspacePeerSessionName,
    ));
  };

  const markWorkspacePeerDirty = (): void => {
    workspacePeerPublisher?.markDirty();
    refreshSessionEndpointDirectory();
  };

  const applyBashBgSnapshot = (payload: unknown): void => {
    const next = activeWorkspaceBackgroundJobsFromPayload(payload);
    if (!next) return;
    workspaceBackgroundJobs = next;
    markWorkspacePeerDirty();
  };

  const applyLoopSnapshot = (payload: unknown): void => {
    const next = activePromptLoopIdsFromPayload(payload);
    if (!next) return;
    activePromptLoopIds = next;
  };

  /** Context pressure % of this session (published to peer windows). */
  const currentContextPressure = (): number | undefined => {
    const usage = widgetCtx?.getContextUsage?.();
    return usage && usage.percent !== null && Number.isFinite(usage.percent) ? usage.percent : undefined;
  };

  const refreshWorkspacePeerOwners = async (): Promise<WorkspaceOwnerSnapshot[]> => {
    if (workspacePeerRefresh) return workspacePeerRefresh;
    const publisher = workspacePeerPublisher;
    if (!publisher) return [];
    workspacePeerRefresh = discoverWorkspacePeers(publisher.identity, { cleanupStale: true })
      .then((result) => {
        workspacePeerOwners = result.peers;
        refreshSessionEndpointDirectory();
        return workspacePeerOwners;
      })
      .catch((error) => {
        console.error("[pi-maestro-teammate] workspace peer discovery failed:", error);
        return workspacePeerOwners;
      })
      .finally(() => {
        workspacePeerRefresh = undefined;
      });
    return workspacePeerRefresh;
  };

  /** Destructive operations require a fresh discovery result, never the stale fallback cache. */
  const refreshWorkspacePeerOwnersStrict = async (): Promise<WorkspaceOwnerSnapshot[]> => {
    if (workspacePeerRefresh) await workspacePeerRefresh;
    const publisher = workspacePeerPublisher;
    if (!publisher) throw new Error("Workspace peer discovery is unavailable.");
    const result = await discoverWorkspacePeers(publisher.identity, { cleanupStale: true });
    workspacePeerOwners = result.peers;
    refreshSessionEndpointDirectory();
    return workspacePeerOwners;
  };

  const targetForWorkspaceBinding = (bindingKey: string): WorkspaceResolvedTarget | undefined => {
    const publisher = workspacePeerPublisher;
    if (!publisher) return undefined;
    const separator = bindingKey.indexOf(":");
    if (separator === 32) {
      const ownerId = bindingKey.slice(0, separator);
      const correlationId = bindingKey.slice(separator + 1);
      const owner = workspacePeerOwners.find((candidate) => candidate.ownerId === ownerId);
      const agent = owner?.agents.find((candidate) => candidate.correlationId === correlationId)
        ?? owner?.settled.find((candidate) => candidate.correlationId === correlationId);
      if (!owner || !agent) return undefined;
      return {
        scope: "remote",
        ownerId,
        ownerNonce: owner.ownerNonce,
        state: owner.agents.includes(agent as WorkspaceAgentSnapshot) ? "active" : "settled",
        agent,
      };
    }
    const localState = buildWorkspaceOwnerState(state, workspacePeerSessionName, currentContextPressure());
    const agent = localState.agents.find((candidate) => candidate.correlationId === bindingKey)
      ?? localState.settled?.find((candidate) => candidate.correlationId === bindingKey);
    if (!agent) return undefined;
    return {
      scope: "local",
      ownerId: publisher.identity.ownerId,
      ownerNonce: publisher.identity.ownerNonce,
      state: localState.agents.includes(agent as WorkspaceAgentSnapshot) ? "active" : "settled",
      agent,
    };
  };

  /** Resolve a monitor target to a peer window (owner), not a sub-agent. */
  const resolveWorkspaceMonitorTarget = (query: string): WorkspaceOwnerSnapshot | undefined => {
    const requested = query.startsWith("@") ? query.slice(1) : query;
    if (!requested) return undefined;
    const owners = workspacePeerOwners;
    if (requested.startsWith("owner:")) {
      const ownerId = requested.slice("owner:".length);
      return owners.find((candidate) => candidate.ownerId === ownerId);
    }
    const byName = owners.filter((candidate) => candidate.sessionName === requested);
    if (byName.length === 1) return byName[0]!;
    if (requested.startsWith("window:")) {
      const prefix = requested.slice("window:".length);
      const matches = owners.filter((candidate) => candidate.ownerId.startsWith(prefix));
      return matches.length === 1 ? matches[0] : undefined;
    }
    const byPrefix = owners.filter((candidate) => candidate.ownerId.startsWith(requested));
    return byPrefix.length === 1 ? byPrefix[0] : undefined;
  };

  const workspacePeerWindowListings = (): WorkspacePeerWindowListing[] => workspacePeerOwners.map((owner) => ({
    target: `owner:${owner.ownerId}`,
    ownerId: owner.ownerId,
    ...(owner.sessionId ? { sessionId: owner.sessionId } : {}),
    ...(owner.sessionName ? { sessionName: owner.sessionName } : {}),
    status: owner.agents.some((agent) => agent.status === "running") || (owner.backgroundJobs?.length ?? 0) > 0
      ? "running"
      : "sleeping",
    agentCount: owner.agents.length,
    publishedAt: owner.publishedAt,
    ...(owner.contextPressure === undefined ? {} : { contextPressure: owner.contextPressure }),
  }));

  const workspaceMainTarget = (owner: WorkspaceOwnerSnapshot): WorkspaceResolvedTarget => ({
    scope: "remote",
    ownerId: owner.ownerId,
    ownerNonce: owner.ownerNonce,
    state: "active",
    agent: {
      correlationId: WORKSPACE_MAIN_SESSION_MARKER,
      agent: "window",
      status: "running",
      startedAt: owner.publishedAt,
      lastActivityAt: owner.publishedAt,
    },
  });

  const resolveWorkspacePeerSendTarget = (query: string): WorkspaceResolvedTarget | undefined => {
    const publisher = workspacePeerPublisher;
    if (!publisher) return undefined;
    const requested = query.startsWith("@") ? query.slice(1) : query;
    const owner = resolveWorkspaceMonitorTarget(requested);
    if (owner) return workspaceMainTarget(owner);

    const agentSelector = /^owner:([a-f0-9]{32}):([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(requested);
    if (agentSelector) {
      const remoteOwner = workspacePeerOwners.find((candidate) => candidate.ownerId === agentSelector[1]);
      const agent = remoteOwner?.agents.find((candidate) => candidate.correlationId === agentSelector[2])
        ?? remoteOwner?.settled.find((candidate) => candidate.correlationId === agentSelector[2]);
      if (!remoteOwner || !agent) return undefined;
      return {
        scope: "remote",
        ownerId: remoteOwner.ownerId,
        ownerNonce: remoteOwner.ownerNonce,
        state: remoteOwner.agents.some((candidate) => candidate.correlationId === agent.correlationId) ? "active" : "settled",
        agent,
      };
    }

    try {
      const resolved = resolveWorkspaceTarget(
        requested,
        publisher.identity,
        buildWorkspaceOwnerState(state, workspacePeerSessionName, currentContextPressure()),
        workspacePeerOwners,
        { includeSettled: true },
      );
      return resolved.scope === "remote" ? resolved : undefined;
    } catch {
      return undefined;
    }
  };

  const sendWorkspacePeerMessage = async (
    query: string,
    request: SessionMessageRequest,
    expectedEndpoint?: SessionEndpoint,
  ): Promise<SessionMessageResult> => {
    const { message, mode, signal } = request;
    const source = request.source ?? "system";
    if (mode === "abort") return { delivered: false, error: "Cross-session abort is not supported." };
    await workspacePeerLifecycle;
    await refreshWorkspacePeerOwners();
    const publisher = workspacePeerPublisher;
    if (!publisher) return { delivered: false, error: "Cross-session messaging is unavailable in this session." };
    let target: WorkspaceResolvedTarget | undefined;
    if (expectedEndpoint) {
      const owner = workspacePeerOwners.find((candidate) =>
        candidate.ownerId === expectedEndpoint.ownerId && candidate.ownerNonce === expectedEndpoint.ownerNonce
      );
      if (!owner) {
        return { delivered: false, error: `Workspace endpoint ${expectedEndpoint.id} changed incarnation before delivery.` };
      }
      if (expectedEndpoint.kind === "root") {
        target = workspaceMainTarget(owner);
      } else {
        const agent = owner.agents.find((candidate) => candidate.correlationId === expectedEndpoint.correlationId)
          ?? owner.settled.find((candidate) => candidate.correlationId === expectedEndpoint.correlationId);
        if (agent) {
          target = {
            scope: "remote",
            ownerId: owner.ownerId,
            ownerNonce: owner.ownerNonce,
            state: owner.agents.some((candidate) => candidate.correlationId === agent.correlationId) ? "active" : "settled",
            agent,
          };
        }
      }
    } else {
      target = resolveWorkspacePeerSendTarget(query);
    }
    if (!target) {
      return { delivered: false, error: `Workspace target "${query}" was not found. Use teammate-list with view=windows.` };
    }
    if (target.state !== "active") {
      return { delivered: false, error: `Workspace target "${query}" is settled and cannot receive commands.` };
    }
    const registry = sessionHostRegistry;
    if (!registry) return { delivered: false, error: "Session delivery journal is unavailable." };
    let outgoing: WindowThreadEntryInput | undefined;
    let publicationStage: "published" | "accepted" | "rejected" | undefined;
    try {
      const command = await enqueueWorkspacePeerCommand(publisher.identity, target, mode, message, {
        commandId: request.messageId,
        source,
        messageKind: request.messageKind,
        traceId: request.traceId,
        replyTo: request.replyTo ?? `owner:${publisher.identity.ownerId}`,
        fromSessionName: request.fromSessionName ?? workspacePeerSessionName,
        beforePublish(prepared) {
          outgoing = {
            messageId: prepared.commandId,
            workspaceId: prepared.workspaceId,
            peerOwnerId: prepared.toOwnerId,
            peerOwnerNonce: prepared.toOwnerNonce,
            direction: "outgoing",
            source,
            ...(prepared.messageKind === undefined ? {} : { messageKind: prepared.messageKind }),
            ...(prepared.traceId === undefined ? {} : { traceId: prepared.traceId }),
            ...(prepared.replyTo === undefined ? {} : { replyTo: prepared.replyTo }),
            ...(prepared.fromSessionName === undefined ? {} : { fromSessionName: prepared.fromSessionName }),
            targetCorrelationId: prepared.targetCorrelationId,
            mode,
            body: message,
            status: "pending",
            createdAt: prepared.createdAt,
            updatedAt: prepared.createdAt,
          };
          registry.thread.record(outgoing);
        },
      });
      publicationStage = "published";
      const publishedOutgoing = outgoing;
      if (!publishedOutgoing) throw new Error("Workspace command was published without a durable outgoing journal entry.");
      let response: Awaited<ReturnType<typeof waitForWorkspacePeerCommandResponse>>;
      try {
        response = await waitForWorkspacePeerCommandResponse(publisher.identity, command, { signal });
      } catch (error) {
        registry.thread.record({
          ...publishedOutgoing,
          status: "timeout",
          updatedAt: Math.max(command.createdAt, Date.now()),
        });
        return {
          delivered: false,
          error: error instanceof Error ? error.message : String(error),
          receipt: { publicationStage, messageId: command.commandId },
        };
      }
      const effectiveMode = response?.effectiveAction ?? mode;
      const deliveryStage = target.agent.correlationId === WORKSPACE_MAIN_SESSION_MARKER
        ? "queued"
        : response?.deliveryStage ?? "queued";
      const status: WindowThreadStatus = !response || response.status === "expired"
        ? "timeout"
        : response.status === "accepted" ? deliveryStage : "rejected";
      if (response?.status === "accepted") publicationStage = "accepted";
      else if (response && response.status !== "expired") publicationStage = "rejected";
      registry.thread.record({
        ...publishedOutgoing,
        effectiveMode,
        status,
        updatedAt: Math.max(command.createdAt, response?.respondedAt ?? Date.now()),
      });
      if (!response || response.status === "expired") {
        return {
          delivered: false,
          error: `Timed out sending to workspace target "${query}".`,
          receipt: { publicationStage, messageId: command.commandId },
        };
      }
      if (response.status !== "accepted") {
        return {
          delivered: false,
          error: response.message ?? `Workspace target "${query}" rejected the message.`,
          receipt: { publicationStage, messageId: command.commandId },
        };
      }
      return {
        delivered: true,
        receipt: {
          requestedMode: mode,
          effectiveMode,
          deliveryStage,
          publicationStage,
          messageId: command.commandId,
          ...(command.traceId === undefined ? {} : { traceId: command.traceId }),
        },
      };
    } catch (error) {
      if (outgoing && publicationStage === undefined) {
        try {
          registry.thread.record({
            ...outgoing,
            status: "rejected",
            updatedAt: Math.max(outgoing.createdAt, Date.now()),
          });
        } catch {
          // Preserve the original journal/publication failure.
        }
      }
      return {
        delivered: false,
        error: error instanceof Error ? error.message : String(error),
        ...(publicationStage ? {
          receipt: { publicationStage, ...(outgoing ? { messageId: outgoing.messageId } : {}) },
        } : {}),
      };
    }
  };

  const prepareLocalAgentDelivery = (
    rawMessage: string,
    options?: { senderCorrelationId?: string; messageKind?: SessionMessageKind },
  ): { body: string; from: string } => {
    const sender = resolveLocalAgentSenderContext(state, options?.senderCorrelationId);
    return {
      body: formatLocalAgentMessage({
        message: rawMessage,
        messageKind: options?.messageKind,
        senderLabel: sender.label,
        replyToSelector: sender.replyTo,
      }),
      from: sender.from,
    };
  };

  const injectLocalAgentMessage = (
    correlationId: string,
    targetLabel: string,
    delivery: { body: string; from: string },
    requestedMode: "steer" | "follow_up",
  ): { delivered: boolean; error?: string; mode?: RpcMessageMode; wasSleeping?: boolean } => {
    const message = delivery.body;
    const messageFrom = delivery.from;
    const agent = state.activeRuns.get(correlationId);
    if (!agent) return { delivered: false, error: `Agent "${targetLabel}" is no longer available.` };
    if (!agent.stdin?.writable) {
      const restarted = agent.status === "sleeping" && agent.restart?.(message) === true;
      if (!restarted) {
        return { delivered: false, error: `Agent "${targetLabel}" has no restorable runtime.` };
      }
      const now = Date.now();
      agent.promptSeq = (agent.promptSeq ?? 0) + 1;
      agent.inbox.push({
        id: randomUUID(),
        from: messageFrom,
        to: targetLabel,
        kind: "task",
        payload: message,
        timestamp: now,
      });
      agent.outputLog.push(`[${new Date(now).toISOString().slice(11, 19)}] ◀ cold-resume prompt: ${message.slice(0, 100)}`);
      trimAgentBuffers(agent);
      emitTeammateStarted(pi, agent);
      pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
        correlationId,
        from: messageFrom,
        to: targetLabel,
        mode: "prompt",
        message,
        lastActivityAt: now,
        isSend: true,
      });
      markWorkspacePeerDirty();
      return { delivered: true, mode: "prompt", wasSleeping: true };
    }
    if (!agent.lease || !canChildWrite(agent.lease)) {
      const ownership = agent.lease ? `${agent.lease.owner} (${agent.lease.state})` : "an unavailable lease";
      return { delivered: false, error: `Agent "${targetLabel}" is currently owned by ${ownership}.` };
    }
    const mode: RpcMessageMode = agent.status === "sleeping"
      ? "prompt"
      : requestedMode === "follow_up" && agent.resultReadyAt !== undefined
        ? "prompt"
        : requestedMode;
    const sent = sendRpcMessage(agent.stdin, message, mode, leaseToken(agent.lease));
    if (!sent) return { delivered: false, error: `Failed to send message to "${targetLabel}".` };

    const now = Date.now();
    if (mode === "prompt") agent.promptSeq = (agent.promptSeq ?? 0) + 1;
    const wasSleeping = wakeSleepingAgent(pi, agent, now);
    agent.inbox.push({
      id: randomUUID(),
      from: messageFrom,
      to: targetLabel,
      kind: "task",
      payload: message,
      timestamp: now,
    });
    agent.outputLog.push(`[${new Date(now).toISOString().slice(11, 19)}] ◀ ${mode}: ${message.slice(0, 100)}`);
    trimAgentBuffers(agent);
    agent.lastActivityAt = now;
    pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
      correlationId,
      from: messageFrom,
      to: targetLabel,
      mode,
      message,
      lastActivityAt: now,
      isSend: true,
    });
    markWorkspacePeerDirty();
    return { delivered: true, mode, wasSleeping };
  };

  // Durable mailbox host — bound per session so the workspace id derives from
  // the real session cwd (baseCwd is empty until session_start). Root host only;
  // child processes keep the legacy stdin path.
  const mailboxMode = mailboxModeFromEnv();
  let mailboxHost: MailboxHost | undefined;
  let mailboxWorkspaceId: string | undefined;

  const workspaceIdForCwd = (cwd: string | undefined): string =>
    cwd ? createHash("sha256").update(cwd, "utf8").digest("hex") : "0".repeat(64);

  const createMailboxHost = (): MailboxHost => {
    const rootCorrelationId = state.activeRuns.values().next().value?.correlationId;
    const workspaceId = workspaceIdForCwd(state.baseCwd);
    mailboxWorkspaceId = workspaceId;
    const host = new MailboxHost({
      rootDir: join(homedir(), ".pi", "teammate", "mailbox"),
      state,
      rootCorrelationId,
      ownerId: `host-${process.pid}`,
      workspaceId,
      teamId: rootCorrelationId ?? "team-root",
      inject: async (envelope) => {
        // Re-route the enqueued envelope back into the actual child stdin.
        const target = state.activeRuns.get(envelope.recipientCorrelationId);
        if (!target) throw new Error(`Agent "${envelope.recipientCorrelationId}" is no longer available.`);
        const mode: "steer" | "follow_up" = envelope.mode === "steer" ? "steer" : "follow_up";
        const sender = resolveLocalAgentSenderContext(
          state,
          envelope.senderId === "caller" ? undefined : envelope.senderId,
        );
        const delivery = injectLocalAgentMessage(
          envelope.recipientCorrelationId,
          target.name ?? target.correlationId,
          { body: envelope.payload, from: sender.from },
          mode,
        );
        if (!delivery.delivered) throw new Error(delivery.error ?? `Failed to inject message into "${target.name ?? target.correlationId}".`);
      },
      mode: mailboxMode,
    });
    // Publish the v1 registry so external consumers (the Flow host) can enqueue
    // durable task notifications through the same mailbox the extension uses.
    rootGlobals[MAILBOX_REGISTRY_KEY] = createMailboxHostRegistry(
      host.service,
      "v2",
      async (request) => {
        const prepared = prepareLocalAgentDelivery(request.message, {
          senderCorrelationId: request.senderId === "caller" ? undefined : request.senderId,
        });
        const delivery = injectLocalAgentMessage(
          request.recipientCorrelationId,
          request.recipientLabel ?? request.recipientCorrelationId,
          prepared,
          request.mode === "steer" ? "steer" : "follow_up",
        );
        const mode = delivery.mode === "steer" || delivery.mode === "follow_up" || delivery.mode === "prompt"
          ? delivery.mode
          : undefined;
        return { ...delivery, mode };
      },
    );
    return host;
  };

  /** Rebind the mailbox host when the workspace (derived from cwd) changes. */
  const rebindMailboxHostForSession = (): void => {
    if (isChild) return;
    if (mailboxMode === "disabled") {
      rootGlobals[MAILBOX_REGISTRY_KEY] = createDirectAgentHostRegistry(async (request) => {
        const prepared = prepareLocalAgentDelivery(request.message, {
          senderCorrelationId: request.senderId === "caller" ? undefined : request.senderId,
        });
        const delivery = injectLocalAgentMessage(
          request.recipientCorrelationId,
          request.recipientLabel ?? request.recipientCorrelationId,
          prepared,
          request.mode === "steer" ? "steer" : "follow_up",
        );
        const mode = delivery.mode === "steer" || delivery.mode === "follow_up" || delivery.mode === "prompt"
          ? delivery.mode
          : undefined;
        return { ...delivery, mode };
      });
      return;
    }
    const workspaceId = workspaceIdForCwd(state.baseCwd);
    if (mailboxHost && workspaceId === mailboxWorkspaceId) return;
    const previous = mailboxHost;
    mailboxHost = createMailboxHost();
    mailboxWorkspaceId = workspaceId;
    void previous?.stop().catch((error) => {
      console.error(`[pi-maestro-teammate] mailbox host stop failed:`, error);
    });
  };

  const deliverLocalAgentMessage = async (
    correlationId: string,
    targetLabel: string,
    message: string,
    requestedMode: "steer" | "follow_up",
    options?: { senderCorrelationId?: string; messageKind?: SessionMessageKind },
  ): Promise<{ delivered: boolean; error?: string; mode?: RpcMessageMode; wasSleeping?: boolean }> => {
    const prepared = prepareLocalAgentDelivery(message, options);
    const senderId = options?.senderCorrelationId ?? "caller";
    // Durable mailbox authoritative path: enqueue and let the consumer inject.
    // Only for live agents with a writable stdin; sleeping agents needing
    // cold-resume (restart) keep the synchronous direct path so restart fires
    // before teammate-send returns (lifecycle contract).
    const host = mailboxHost;
    const agent = state.activeRuns.get(correlationId);
    if (host && host.mode === "authoritative" && requestedMode !== "steer" && agent?.stdin?.writable) {
      try {
        const enqueued = await host.rollout.deliver({
          senderId,
          recipientId: agent?.name ?? targetLabel,
          recipientCorrelationId: correlationId,
          kind: "follow_up",
          mode: "follow_up",
          payload: prepared.body,
        });
        if (enqueued.result && !enqueued.result.ok) {
          // Surface the failure — never silently fall back to direct stdin.
          const reason = "message" in enqueued.result ? (enqueued.result as { message?: string }).message : "unknown error";
          console.error(`[pi-maestro-teammate] mailbox delivery failed for ${targetLabel}: ${reason}`);
          // Send-shaped failure: isSend must be true so progress consumers (e.g.
          // Cockpit's agent store) treat it as a send variant and ignore it
          // instead of mis-rendering it as agent progress (CS-1).
          pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
            correlationId,
            from: prepared.from,
            to: targetLabel,
            mode: "follow_up",
            message: prepared.body,
            lastActivityAt: Date.now(),
            isSend: true,
          });
          return { delivered: false, error: reason, mode: "follow_up" };
        }
        // Success accounting (inbox/outputLog/event) happens exactly once, in
        // injectLocalAgentMessage when the consumer actually injects.
        return { delivered: true, mode: "follow_up" };
      } catch (error) {
        console.error(`[pi-maestro-teammate] mailbox delivery failed for ${targetLabel}:`, error);
        return { delivered: false, error: error instanceof Error ? error.message : String(error), mode: "follow_up" };
      }
    }
    return injectLocalAgentMessage(correlationId, targetLabel, prepared, requestedMode);
  };

  const deliverLocalRootEndpoint = async (
    endpoint: SessionEndpoint,
    request: SessionMessageRequest,
  ): Promise<SessionMessageResult> => {
    const delivered = safeSendMessage(pi, {
      customType: "teammate-message",
      content: request.message,
      display: true,
      details: { source: "session-router", endpointId: endpoint.id, mode: request.mode },
    }, {
      triggerTurn: true,
      deliverAs: request.mode === "steer" ? "steer" : "followUp",
    });
    return {
      delivered,
      endpointId: endpoint.id,
      transport: "local-root",
      ...(delivered ? {
        receipt: {
          requestedMode: request.mode,
          effectiveMode: request.mode,
          deliveryStage: request.mode === "steer" ? "injected" : "queued",
          ...(request.traceId === undefined ? {} : { traceId: request.traceId }),
        },
      } : { error: "The local root session rejected the message." }),
    };
  };

  const deliverLocalAgentEndpoint = async (
    endpoint: SessionEndpoint,
    request: SessionMessageRequest,
  ): Promise<SessionMessageResult> => {
    const correlationId = endpoint.correlationId;
    if (!correlationId) return { delivered: false, endpointId: endpoint.id, transport: "local-agent-mailbox", error: "The local agent endpoint has no correlation id." };
    if (request.mode === "abort") {
      const agent = state.activeRuns.get(correlationId);
      if (!agent) return { delivered: false, endpointId: endpoint.id, transport: "local-agent-mailbox", error: "The local agent is no longer available." };
      if (agent.stdin?.writable && canChildWrite(agent.lease)) {
        sendRpcMessage(agent.stdin, request.message, "abort", agent.lease ? leaseToken(agent.lease) : undefined);
      }
      const now = Date.now();
      const targetLabel = request.selector;
      agent.outputLog.push(`[${new Date(now).toISOString().slice(11, 19)}] ◀ abort: ${request.message.slice(0, 100)}`);
      agent.lastActivityAt = now;
      pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
        correlationId,
        from: "caller",
        to: targetLabel,
        mode: "abort",
        message: request.message,
        lastActivityAt: now,
        isSend: true,
      });
      const terminated = killAgentTree(state, correlationId);
      markWorkspacePeerDirty();
      return {
        delivered: true,
        endpointId: endpoint.id,
        transport: "local-agent-mailbox",
        receipt: { mode: "abort", terminatedCount: terminated.length },
      };
    }
    const result = await deliverLocalAgentMessage(
      correlationId,
      endpoint.name ?? correlationId,
      request.message,
      request.mode,
      {
        senderCorrelationId: request.senderCorrelationId,
        messageKind: request.messageKind,
      },
    );
    const effectiveMode = result.mode === "steer" ? "steer" : "follow_up";
    return {
      delivered: result.delivered,
      endpointId: endpoint.id,
      transport: "local-agent-mailbox",
      ...(result.error ? { error: result.error } : {}),
      receipt: {
        ...(result.mode ? { mode: result.mode } : {}),
        requestedMode: request.mode,
        effectiveMode,
        deliveryStage: effectiveMode === "steer" ? "injected" : "queued",
        ...(request.traceId === undefined ? {} : { traceId: request.traceId }),
        ...(result.wasSleeping ? { wasSleeping: true } : {}),
      },
    };
  };

  const deliverWorkspacePeerEndpoint = async (
    endpoint: SessionEndpoint,
    request: SessionMessageRequest,
  ): Promise<SessionMessageResult> => {
    if (request.mode === "abort") {
      return { delivered: false, endpointId: endpoint.id, transport: "workspace-peer-v1", error: "Cross-session abort is not supported." };
    }
    const target = endpoint.kind === "root"
      ? `owner:${endpoint.ownerId}`
      : `owner:${endpoint.ownerId}:${endpoint.correlationId}`;
    const result = await sendWorkspacePeerMessage(target, request, endpoint);
    return {
      delivered: result.delivered,
      endpointId: endpoint.id,
      transport: "workspace-peer-v1",
      ...(result.error ? { error: result.error } : {}),
      ...(result.receipt ? { receipt: result.receipt } : {}),
    };
  };

  const legacyResolution = (request: SessionMessageRequest): SessionResolution => {
    const selector = request.selector;
    if (request.targetCorrelationId) {
      const pinned = sessionHostRegistry?.listEndpoints().find((candidate) =>
        candidate.correlationId === request.targetCorrelationId
      );
      if (pinned) return { code: "resolved", selector, endpoint: pinned, candidates: [pinned] };
    }
    const correlationId = resolveAgentCorrelationId(state, selector);
    if (correlationId) {
      const endpoint = sessionHostRegistry?.listEndpoints().find((candidate) =>
        candidate.scope === "local" && candidate.kind === "agent" && candidate.correlationId === correlationId
      );
      if (endpoint) return { code: "resolved", selector, endpoint, candidates: [endpoint] };
    }
    const canonicalEndpoint = sessionHostRegistry?.directory.get(selector);
    if (canonicalEndpoint) {
      return { code: "resolved", selector, endpoint: canonicalEndpoint, candidates: [canonicalEndpoint] };
    }
    const target = resolveWorkspacePeerSendTarget(selector);
    if (target) {
      const endpoint = sessionHostRegistry?.listEndpoints().find((candidate) =>
        candidate.ownerId === target.ownerId
        && (target.agent.correlationId === WORKSPACE_MAIN_SESSION_MARKER
          ? candidate.kind === "root"
          : candidate.kind === "agent" && candidate.correlationId === target.agent.correlationId)
      );
      if (endpoint) return { code: "resolved", selector, endpoint, candidates: [endpoint] };
    }
    return { code: "not_found", selector, candidates: [], message: `Session selector ${JSON.stringify(selector)} was not found.` };
  };

  const legacySessionAuthority: LegacySessionAuthority = {
    resolve: legacyResolution,
    classify(request, resolution) {
      const endpoint = resolution.endpoint;
      if (resolution.code !== "resolved" || !endpoint) {
        return { transport: "local-agent-mailbox", routable: false, reason: resolution.message ?? resolution.code };
      }
      if (endpoint.status === "settled") return { transport: endpoint.transport, routable: false, reason: "The session endpoint is settled." };
      if (request.mode === "abort" && endpoint.scope !== "local") {
        return { transport: endpoint.transport, routable: false, reason: "Cross-session abort is not supported." };
      }
      return { transport: endpoint.transport, routable: endpoint.capabilities.includes(request.mode) };
    },
    async deliver(request, resolution) {
      const endpoint = resolution.endpoint;
      if (resolution.code !== "resolved" || !endpoint) return { delivered: false, error: resolution.message ?? resolution.code };
      if (endpoint.transport === "local-root") return deliverLocalRootEndpoint(endpoint, request);
      if (endpoint.transport === "local-agent-mailbox") return deliverLocalAgentEndpoint(endpoint, request);
      if (endpoint.transport === "workspace-peer-v1") return deliverWorkspacePeerEndpoint(endpoint, request);
      return { delivered: false, endpointId: endpoint.id, transport: endpoint.transport, error: "Child IPC is unavailable in the root host." };
    },
  };

  const windowThreadStore = new WindowThreadStore({
    persist(entry) {
      pi.appendEntry(WINDOW_THREAD_ENTRY_TYPE, entry);
    },
  });
  sessionHostRegistry = new SessionHostRegistry({
    surface: sessionSurfaceModeFromEnv(),
    thread: windowThreadStore,
    legacy: legacySessionAuthority,
    adapters: [
      createLocalRootTransportAdapter(deliverLocalRootEndpoint),
      createLocalAgentMailboxTransportAdapter(deliverLocalAgentEndpoint),
      createWorkspacePeerV1TransportAdapter(deliverWorkspacePeerEndpoint),
    ],
    onShadowComparison(comparison) {
      if (!comparison.matches) {
        console.warn("[pi-maestro-teammate] session route shadow mismatch:", JSON.stringify(comparison));
      }
    },
  });
  publishSessionHostRegistry(sessionHostRegistry, rootGlobals);
  sessionHostRegistry.subscribe(
    (snapshot) => pi.events.emit(SESSION_HOST_REGISTRY_EVENT, snapshot),
    { emitCurrent: false },
  );
  sessionHostRegistry.thread.subscribe(
    (snapshot) => pi.events.emit(WINDOW_THREAD_EVENT, snapshot),
    { emitCurrent: false },
  );
  refreshSessionEndpointDirectory();

  const routeSessionMessage = async (request: SessionMessageRequest): Promise<SessionMessageResult> => {
    await workspacePeerLifecycle;
    await refreshWorkspacePeerOwners();
    refreshSessionEndpointDirectory(true);
    return sessionHostRegistry?.send(request)
      ?? { delivered: false, error: "Session delivery authority is unavailable." };
  };

  const stopWorkspacePeers = async (): Promise<void> => {
    const consumer = workspacePeerConsumer;
    const publisher = workspacePeerPublisher;
    workspacePeerConsumer = undefined;
    workspacePeerPublisher = undefined;
    workspacePeerOwners = [];
    refreshSessionEndpointDirectory();
    await consumer?.stop().catch(() => undefined);
    await publisher?.stop().catch(() => undefined);
  };

  const startWorkspacePeers = (ctx: ExtensionContext): void => {
    const cwd = ctx.cwd;
    workspacePeerSessionName = ctx.sessionManager?.getSessionName?.() ?? undefined;
    workspacePeerLifecycle = workspacePeerLifecycle
      .then(async () => {
        await stopWorkspacePeers();
        const publisher = createWorkspacePeerRuntime({
          cwd,
          getState: () => buildWorkspaceOwnerState(
            state,
            workspacePeerSessionName,
            currentContextPressure(),
            workspaceBackgroundJobs,
          ),
        });
        await publisher.start();
        workspacePeerPublisher = publisher;
        const consumer = createWorkspacePeerCommandConsumer(publisher.identity, async (command) => {
          const existing = sessionHostRegistry?.thread.get(command.commandId, "incoming");
          const replayReceipt = windowThreadReplayReceipt(existing);
          if (replayReceipt) return replayReceipt;
          const incoming = {
            messageId: command.commandId,
            workspaceId: command.workspaceId,
            peerOwnerId: command.fromOwnerId,
            peerOwnerNonce: command.fromOwnerNonce,
            direction: "incoming" as const,
            source: command.source ?? "system",
            messageKind: command.messageKind ?? "message",
            traceId: command.traceId ?? command.commandId,
            replyTo: `owner:${command.fromOwnerId}`,
            ...(command.fromSessionName === undefined ? {} : { fromSessionName: command.fromSessionName }),
            targetCorrelationId: command.targetCorrelationId,
            mode: command.action,
            body: command.message,
            createdAt: command.createdAt,
          };
          sessionHostRegistry?.thread.record({
            ...incoming,
            status: "pending",
            updatedAt: command.createdAt,
          });

          let result: {
            status: "accepted" | "rejected";
            message: string;
            effectiveAction?: "steer" | "follow_up";
            deliveryStage?: "queued" | "injected";
          };
          if (command.targetCorrelationId === WORKSPACE_MAIN_SESSION_MARKER) {
            const delivery = workspaceMainSessionDeliveryDecision(
              command.action,
              workspaceBackgroundJobs,
              command.messageKind,
            );
            const effectiveAction = delivery.action;
            const deferredFor = delivery.deferred
              ? command.messageKind === "status" ? "status-policy" : "foreground-bash-bg"
              : undefined;
            const delivered = safeSendMessage(pi, {
              customType: "teammate-message",
              content: formatWorkspaceRemoteRootMessage({
                messageId: command.commandId,
                fromOwnerId: command.fromOwnerId,
                message: command.message,
                effectiveAction,
                source: command.source,
                messageKind: command.messageKind,
                traceId: command.traceId,
                replyTo: command.replyTo,
                fromSessionName: command.fromSessionName,
              }),
              display: true,
              details: {
                source: "workspace-peer",
                messageId: command.commandId,
                fromOwnerId: command.fromOwnerId,
                requestedMode: command.action,
                mode: effectiveAction,
                ...(command.messageKind === undefined ? {} : { messageKind: command.messageKind }),
                ...(deferredFor ? { deferredFor } : {}),
              },
            }, {
              triggerTurn: true,
              deliverAs: delivery.deliverAs,
            });
            result = delivered
              ? {
                  status: "accepted",
                  message: effectiveAction === command.action
                    ? `${effectiveAction} accepted by main session`
                    : command.messageKind === "status"
                      ? "status queued as follow_up by message policy"
                      : "steer deferred as follow_up while foreground bash_bg is active",
                  effectiveAction,
                  deliveryStage: "queued",
                }
              : { status: "rejected", message: "main session rejected the message" };
            if (delivered && effectiveAction !== "steer" && foregroundToolRuns.size > 0) {
              const senderLabel = command.fromSessionName
                ? JSON.stringify(command.fromSessionName)
                : `owner ${command.fromOwnerId.slice(0, 8)}`;
              ctx.ui.notify(
                `[workspace] Message from ${senderLabel} queued while a tool was running; it will be injected after the current turn ends.`,
                "info",
              );
            }
          } else {
            const target = state.activeRuns.get(command.targetCorrelationId);
            if (!target) {
              result = { status: "rejected", message: "target agent is not owned by this session" };
            } else {
              const workspaceMessage = formatWorkspaceRemoteRootMessage({
                messageId: command.commandId,
                fromOwnerId: command.fromOwnerId,
                message: command.message,
                effectiveAction: command.action,
                source: command.source,
                messageKind: command.messageKind,
                traceId: command.traceId,
                replyTo: command.replyTo,
                fromSessionName: command.fromSessionName,
              });
              const delivered = await deliverLocalAgentMessage(
                command.targetCorrelationId,
                target.name ?? command.targetCorrelationId.slice(0, 8),
                workspaceMessage,
                command.action,
              );
              const effectiveAction = delivered.mode === "steer" ? "steer" : "follow_up";
              result = delivered.delivered
                ? {
                    status: "accepted",
                    message: effectiveAction,
                    effectiveAction,
                    deliveryStage: effectiveAction === "steer" ? "injected" : "queued",
                  }
                : { status: "rejected", message: delivered.error ?? "message was not delivered" };
            }
          }
          sessionHostRegistry?.thread.record({
            ...incoming,
            ...(result.effectiveAction === undefined ? {} : { effectiveMode: result.effectiveAction }),
            status: result.status === "accepted" ? result.deliveryStage ?? "queued" : "rejected",
            updatedAt: Math.max(command.createdAt, Date.now()),
          });
          return result;
        });
        consumer.start();
        workspacePeerConsumer = consumer;
        await refreshWorkspacePeerOwners();
      })
      .catch((error) => console.error("[pi-maestro-teammate] workspace peer runtime failed:", error));
  };

  const enqueueChildInteraction = (
    event: Record<string, unknown>,
    reply: (msg: unknown) => void,
    ctx: ExtensionContext | null | undefined,
    fallbackCorrelationId?: string,
  ): void => {
    interactionQueue.enqueue(event, reply, ctx, fallbackCorrelationId);
  };

  let bindMonitorSessionDispatch: ((toolCallId: string, agent: ActiveAgent) => void) | undefined;
  let publishMonitorSessionTurn: ((agent: ActiveAgent, result: SingleResult) => void) | undefined;

  // =========================================================================
  // Tool 1: teammate — dispatch
  // =========================================================================

  const tool: ToolDefinition<typeof TeammateParams, Details> = {
    name: "teammate",
    label: "Teammate",
    renderShell: "self",
    description: buildTeammateToolDescription(process.cwd()),
    promptSnippet: TEAMMATE_PROMPT_SNIPPET,
    promptGuidelines: TEAMMATE_PROMPT_GUIDELINES,

    parameters: TeammateParams,

    async execute(
      id: string,
      params: RunTeammateParams,
      signal: AbortSignal,
      onUpdate:
        | ((result: TeammateToolResult<Details>) => void)
        | undefined,
      ctx: ExtensionContext,
    ): Promise<TeammateToolResult<Details>> {
      const cancelledBeforeStart = (): TeammateToolResult<Details> => ({
        content: [{ type: "text", text: "Teammate dispatch cancelled before start." }],
        isError: true,
        details: { mode: "single", results: [] },
      });
      if (signal.aborted) return cancelledBeforeStart();
      const dispatchGeneration = state.sessionGeneration ?? 0;
      const ownsDispatchGeneration = (): boolean =>
        (state.sessionGeneration ?? 0) === dispatchGeneration;

      const baseCwd = (params.cwd ?? state.baseCwd) || ctx.cwd;
      await refreshModelRegistry(ctx);
      params = prepareTeammateMode(params);
      params = applyModelRouting(
        params,
        baseCwd,
        refreshModelCatalog(ctx).modelIds,
        undefined,
        sessionModelId(ctx),
      );

      // --- Normalize to task list (shared with the child proxy path) ---
      const normalization = normalizeTeammateParams(params);
      if (normalization.error) {
        return {
          content: [{ type: "text", text: normalization.error }],
          isError: true,
          details: { mode: "single", results: [] },
        };
      }
      const { isMultiTask } = normalization;
      const normalizedTasks = normalization.tasks;
      const budget = checkActiveAgentBudget(state, normalizedTasks.length);
      if (!budget.allowed) {
        return {
          content: [{
            type: "text",
            text: `Teammate agent budget exhausted: ${budget.active} agents are already live; `
              + `${normalizedTasks.length} more requested (max ${budget.max}). `
              + "Wait for running agents to settle, or raise PI_TEAMMATE_MAX_ACTIVE_AGENTS.",
          }],
          isError: true,
          details: { mode: isMultiTask ? inferGraphMode(normalizedTasks) : "single", results: [] },
        };
      }
      const singleTask = normalizedTasks[0];
      // Agents spawned by this root dispatch may dispatch at most
      // maxNestingDepth levels below themselves (0 forbids nested calls).
      // Per-task values override the top-level default; the graph option uses
      // the tightest budget so spawned-child diagnostics stay conservative.
      const childMaxDispatchDepth = isMultiTask
        ? Math.min(...normalizedTasks.map((task) => rootChildMaxDispatchDepth(task.maxNestingDepth)))
        : rootChildMaxDispatchDepth(singleTask.maxNestingDepth);
      const singleRunParams = {
        agent: singleTask.agent,
        task: singleTask.prompt,
        taskType: singleTask.taskType,
        name: singleTask.name,
        reply_to: params.reply_to,
        context: singleTask.context,
        model: singleTask.model,
        fallbackModels: singleTask.fallbackModels,
        thinking: singleTask.thinking,
        cwd: singleTask.cwd,
        outputSchema: singleTask.outputSchema,
      };
      let foregroundUpdateOpen = params.background === false;
      const warningPrefix = normalization.warnings.length
        ? normalization.warnings.map((w) => `[warn] ${w}`).join("\n") + "\n\n"
        : "";

      const isSingle = !isMultiTask;
      const graphMode = isMultiTask ? inferGraphMode(normalizedTasks) : null;

      const taskNames = new Set(normalizedTasks.filter((task) => task.name).map((task) => task.name!));
      const taskIndexByName = new Map<string, number>();
      normalizedTasks.forEach((task, index) => {
        if (task.name) taskIndexByName.set(task.name, index);
      });
      const taskCorrelationIds = isMultiTask
        ? normalizedTasks.map(() => randomUUID())
        : [];
      const progressState = new Map<number, AgentProgressSnapshot>();
      if (isMultiTask) {
        normalizedTasks.forEach((task, index) => {
          const dependencies = taskDependencyNames(task, taskNames)
            .map((name) => taskIndexByName.get(name))
            .filter((dependency): dependency is number => dependency !== undefined);
          progressState.set(index, {
            agent: task.agent,
            ...(task.name ? { name: task.name } : {}),
            correlationId: taskCorrelationIds[index],
            taskIndex: index,
            dependencies,
            status: "pending",
            phase: dependencies.length > 0 ? "waiting-dependency" : "waiting-capacity",
            requestedModel: task.model,
          });
        });
      }

      const progressSnapshot = (): AgentProgressSnapshot[] =>
        [...progressState.values()].sort((a, b) => a.taskIndex - b.taskIndex);

      const correlationId = randomUUID();

      const abortController = new AbortController();
      const taskAbortControllers = isMultiTask
        ? normalizedTasks.map(() => new AbortController())
        : [];
      for (const taskController of taskAbortControllers) {
        abortController.signal.addEventListener(
          "abort",
          () => taskController.abort(abortController.signal.reason),
          { once: true },
        );
      }
      const abortForward = () => abortController.abort(signal.reason);
      signal.addEventListener("abort", abortForward, { once: true });
      if (signal.aborted) {
        signal.removeEventListener("abort", abortForward);
        return cancelledBeforeStart();
      }

      let detached = false;
      if (params.background === false) {
        foregroundToolRuns.add(correlationId);
        updateAgentWidget();
      }

      const agentLabel = isMultiTask ? `graph(${normalizedTasks.length})` : singleTask.agent;

      const activeAgent: ActiveAgent = {
        agent: agentLabel,
        name: isMultiTask ? undefined : singleTask.name,
        correlationId,
        startedAt: Date.now(),
        abortController,
        ...(isMultiTask ? { graphAbortController: abortController } : {}),
        ownsChildProcess: !isMultiTask,
        inbox: [],
        outputLog: [],
        lastActivityAt: Date.now(),
        requestedModel: isMultiTask ? undefined : singleTask.model,
        ...(isMultiTask ? {} : singleTask.todos ? { todos: [...singleTask.todos] } : {}),
        replyTo: params.reply_to,
        // Root-tool dispatches start the tree.
        depth: 0,
        maxDispatchDepth: childMaxDispatchDepth,
        status: "running",
        phase: isMultiTask
          ? aggregateAgentRunPhase(progressSnapshot()) ?? "waiting-capacity"
          : "starting",
        runtimeGeneration: 1,
        sleepMs: 0,
        lease: createChildLease(),
        promptSeq: 1,
        expectsStructuredOutput: isMultiTask
          ? params.outputSchema !== undefined
          : singleTask.outputSchema !== undefined,
        ...(isMultiTask ? { progress: progressSnapshot() } : {}),
      };
      state.activeRuns.set(correlationId, activeAgent);

      // Background/detached dispatches promise a teammate-complete notification
      // on settle; mark them so a stall (which is not a terminal state and
      // never fires that notification) wakes the caller instead. Foreground
      // in-window dispatches stay unmarked: the caller is blocked in the tool
      // call and gets the stall verdict from the wait path.
      const markStallNotification = (): void => {
        activeAgent.notifyOnStall = true;
        for (const childId of taskCorrelationIds) {
          const child = state.activeRuns.get(childId);
          if (child) child.notifyOnStall = true;
        }
      };

      const childCalls = new Map<string, ChildAgentCallSnapshot>();
      const publishChildCallStatus = (child: ChildAgentCallSnapshot): void => {
        childCalls.set(child.correlationId, {
          ...childCalls.get(child.correlationId),
          ...child,
        });
        const currentProgress = progressSnapshot();
        if (isMultiTask) activeAgent.progress = currentProgress;
        const childLabel = child.name ?? child.agent;
        if (foregroundUpdateOpen) {
          onUpdate?.({
            content: [{
              type: "text",
              text: `[${childLabel}] child agent ${child.status}`,
            }],
            details: {
              mode: (graphMode ?? "single") as Details["mode"],
              results: [],
              ...(isMultiTask ? { progress: currentProgress } : {}),
              childCalls: [...childCalls.values()],
            },
          });
        }
      };

      if (isMultiTask) {
        normalizedTasks.forEach((task, index) => {
          const childId = taskCorrelationIds[index];
          const childAgent: ActiveAgent = {
            agent: task.agent,
            name: task.name,
            correlationId: childId,
            startedAt: Date.now(),
            abortController: taskAbortControllers[index],
            graphAbortController: abortController,
            ownsChildProcess: true,
            inbox: [],
            outputLog: [],
            lastActivityAt: Date.now(),
            requestedModel: task.model,
            spawnedBy: correlationId,
            // Graph tasks belong to their dispatch, so they share its depth;
            // a teammate call made *by* one of them is what advances it.
            // Each task's own maxNestingDepth sets its agent's nesting budget.
            depth: activeAgent.depth,
            maxDispatchDepth: rootChildMaxDispatchDepth(task.maxNestingDepth),
            status: "pending",
            phase: (progressState.get(index)?.dependencies.length ?? 0) > 0
              ? "waiting-dependency"
              : "waiting-capacity",
            runtimeGeneration: 1,
            sleepMs: 0,
            lease: createChildLease(),
            promptSeq: 1,
            expectsStructuredOutput: (task.outputSchema ?? params.outputSchema) !== undefined,
            ...(task.todos ? { todos: [...task.todos] } : {}),
          };
          state.activeRuns.set(childId, childAgent);
          if (task.name) bindAgentName(state, task.name, childId);
        });
        // Register the whole graph before emitting any started event: a
        // synchronous TEAMMATE_STARTED_EVENT listener re-entering admission
        // would otherwise see only part of the graph counted and could pass
        // the active-agent budget against a partial tally (P4).
        normalizedTasks.forEach((task, index) => {
          const childAgent = state.activeRuns.get(taskCorrelationIds[index]);
          if (childAgent) emitTeammateStarted(pi, childAgent);
        });
      }

      if (!isMultiTask && singleTask.name) {
        bindAgentName(state, singleTask.name, correlationId);
      }
      if (!isMultiTask && singleTask.name === MONITOR_SESSION_NAME) {
        bindMonitorSessionDispatch?.(id, activeAgent);
      }

      emitTeammateStarted(pi, activeAgent, { id });

      let dispatchLifecyclePending = false;
      let singlePublishedResult: SingleResult | undefined;
      let singleTerminalResult: SingleResult | undefined;
      let singleTerminalStatus: AgentTerminalStatus | undefined;
      let singleCompletionNotificationRequested = false;
      let singleCompletionDelivered = false;
      const coldRestarting = new Set<string>();
      const isLogicallyWakeable = (result: SingleResult): boolean => {
        const target = state.activeRuns.get(result.correlationId);
        return result.wakeable !== false || Boolean(target?.restart && target.sessionFile);
      };
      const deliverSingleCompletion = (): void => {
        if (!ownsDispatchGeneration()) {
          singleCompletionDelivered = true;
          return;
        }
        if (singleCompletionDelivered) return;
        if (activeAgent.name === MONITOR_SESSION_NAME) {
          if (!singlePublishedResult && !singleTerminalResult) return;
          singleCompletionDelivered = true;
          return;
        }
        // DEL-001: For background/detached tasks (notification requested), the
        // published result is the consumable boundary — deliver immediately
        // instead of gating on lifecycle settlement (agent_settled / close /
        // 60s deadline). For foreground tasks the tool call already returned
        // the result; wait for the terminal result so emitComplete carries
        // final lifecycle metadata.
        if (singleCompletionNotificationRequested) {
          const deliveryResult = singlePublishedResult ?? singleTerminalResult;
          if (!deliveryResult) return;
          singleCompletionDelivered = true;
          const terminal = singleTerminalResult ?? deliveryResult;
          const status = singleTerminalStatus
            ?? (terminal.exitCode === 0 ? "completed" as const : "failed" as const);
          emitComplete(
            pi,
            id,
            agentLabel,
            correlationId,
            terminal.exitCode,
            terminal.durationMs,
            isLogicallyWakeable(terminal),
            status === "terminated",
            toStructuredResults([terminal], baseCwd),
          );
          // DEL-002: Use the published result for the notification content.
          // The terminal result may carry lifecycle diagnostics (e.g. "never
          // confirmed its lifecycle") that would overwrite the assistant's
          // actual answer.
          const lastMessage = displayMessageForResult(singlePublishedResult ?? terminal);
          const delivered = safeSendMessage(
            pi,
            {
              customType: "teammate-complete",
              content: lastMessage,
              display: true,
              details: {
                mode: "single",
                results: [terminal],
                ...(childCalls.size > 0 ? { childCalls: [...childCalls.values()] } : {}),
              },
            },
            { triggerTurn: true },
          );
          if (!delivered) {
            markSettledResultInspectable(state, correlationId);
          }
        } else {
          // Foreground: wait for both published and terminal results.
          if (!singlePublishedResult || !singleTerminalResult) return;
          singleCompletionDelivered = true;
          emitComplete(
            pi,
            id,
            agentLabel,
            correlationId,
            singleTerminalResult.exitCode,
            singleTerminalResult.durationMs,
            isLogicallyWakeable(singleTerminalResult),
            singleTerminalStatus === "terminated",
            toStructuredResults([singleTerminalResult], baseCwd),
          );
        }
      };
      const publishSingleResult = (result: SingleResult, notify: boolean): void => {
        singlePublishedResult ??= result;
        dispatchLifecyclePending ||= result.lifecyclePending === true;
        singleCompletionNotificationRequested ||= notify;
        deliverSingleCompletion();
      };

      interface GraphCompletionPublication {
        results: SingleResult[];
        summaries: string;
        progress: AgentProgressSnapshot[];
        totalDur: number;
        exitCode: number;
        mode: "parallel" | "chain" | "graph";
        wakeable: boolean;
      }
      const graphTerminalIds = new Set<string>();
      const graphTerminalStatuses = new Map<string, AgentTerminalStatus | undefined>();
      let graphPublication: GraphCompletionPublication | undefined;
      let graphCompletionNotificationRequested = false;
      let graphCompletionDelivered = false;
      const deliverGraphCompletion = (): void => {
        if (!ownsDispatchGeneration()) {
          graphCompletionDelivered = true;
          return;
        }
        if (graphCompletionDelivered || !graphPublication) return;
        if (!taskCorrelationIds.every((taskId) => graphTerminalIds.has(taskId))) return;
        graphCompletionDelivered = true;
        // The publication carries publish-time results (the graph's release
        // boundary); container settlement reflects the per-task lifecycle
        // statuses recorded at terminal time.
        const terminalStatus = aggregateTerminalStatuses(graphTerminalStatuses.values());
        const exitCode = terminalStatus === "completed" ? 0 : 1;
        settleGraphContainerAgent(
          state,
          correlationId,
          exitCode,
          graphPublication.summaries,
          graphPublication.wakeable,
          terminalStatus,
        );
        emitComplete(
          pi,
          id,
          graphPublication.mode,
          correlationId,
          exitCode,
          graphPublication.totalDur,
          graphPublication.wakeable,
          terminalStatus === "terminated",
          toStructuredResults(graphPublication.results, baseCwd),
        );
        if (graphCompletionNotificationRequested) {
          const delivered = safeSendMessage(
            pi,
            {
              customType: "teammate-complete",
              content: graphPublication.summaries,
              display: true,
              details: {
                mode: graphPublication.mode,
                results: graphPublication.results,
                progress: graphPublication.progress,
                ...(childCalls.size > 0 ? { childCalls: [...childCalls.values()] } : {}),
              },
            },
            { triggerTurn: true },
          );
          if (!delivered) {
            markSettledResultInspectable(state, correlationId);
          }
        }
      };
      const publishGraphResult = (
        publication: GraphCompletionPublication,
        notify: boolean,
      ): void => {
        graphPublication ??= publication;
        dispatchLifecyclePending ||= publication.results.some((result) => result.lifecyclePending === true);
        graphCompletionNotificationRequested ||= notify;
        deliverGraphCompletion();
      };
      const publishAdditionalTurnCompletion = (
        result: SingleResult,
        terminalStatus: AgentTerminalStatus,
      ): void => {
        if (!ownsDispatchGeneration() || coldRestarting.has(result.correlationId)) return;
        const target = state.activeRuns.get(result.correlationId);
        if (target?.name === MONITOR_SESSION_NAME
          || (result.correlationId === activeAgent.correlationId && activeAgent.name === MONITOR_SESSION_NAME)) return;
        const wakeable = isLogicallyWakeable(result);
        emitComplete(
          pi,
          undefined,
          target?.agent ?? result.agent,
          result.correlationId,
          result.exitCode,
          result.durationMs,
          wakeable,
          terminalStatus === "terminated",
          toStructuredResults([result], baseCwd),
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

      const parentSessionFile = ctx.sessionManager?.getSessionFile?.() ?? undefined;
      let progressFlushGate: ProgressFlushGate | undefined;

      const makeOptions = (): RunTeammateOptions => {
        const options: RunTeammateOptions = {
          baseCwd: state.baseCwd || ctx.cwd,
          modelCapabilities: refreshModelCatalog(ctx).models,
          ...(isSingle ? { correlationId } : {}),
          ...(isMultiTask ? { taskCorrelationIds } : {}),
          depth: activeAgent.depth,
          maxDispatchDepth: childMaxDispatchDepth,
          signal: abortController.signal,
          runtimeGeneration: activeAgent.runtimeGeneration,
          ...(isMultiTask ? { taskSignals: taskAbortControllers.map((controller) => controller.signal) } : {}),
          parentSessionFile,
          ...(singleTask.name === MONITOR_SESSION_NAME ? {
            sessionDir: join(state.baseCwd || ctx.cwd, MONITOR_SESSION_RELATIVE_DIR, correlationId),
            childEnvironment: { [MONITOR_SESSION_ENV_VAR]: "1" },
          } : {}),
          initialLeaseToken: (childId: string) => {
          const target = state.activeRuns.get(childId) ?? activeAgent;
          return target.lease ? leaseToken(target.lease) : undefined;
          },
          onChildSpawned: (
            stdin: import("node:stream").Writable,
            sendControl: (message: Record<string, unknown>) => boolean,
            sessionDir?: string,
            childId?: string,
            generation?: number,
          ) => {
          const target = childId ? state.activeRuns.get(childId) ?? activeAgent : activeAgent;
          // Generation fence, mirroring onChildClosed: a child spawned by a
          // superseded run (e.g. a model-fallback candidate racing a cold
          // restart) must not capture the agent's stdin/sendControl.
          if ((target.runtimeGeneration ?? 0) !== (generation ?? 0)) return;
          const startedAt = Date.now();
          target.stdin = stdin;
          target.sendControl = sendControl;
          target.sessionDir = sessionDir;
          target.startedAt = startedAt;
          target.lastActivityAt = startedAt;
          target.status = "running";
          target.phase = "prompting";
          target.retry = undefined;
          target.resultReadyAt = undefined;
          if (target.lease) sendControl({ type: "teammate_lease_update", token: leaseToken(target.lease) });
          },
          onChildEvent: (event: Record<string, unknown>) => handleChildLifecycleEvent(state, event),
          onChildClosed: (childId, generation, details) => {
            const target = state.activeRuns.get(childId);
            if (!target || (target.runtimeGeneration ?? 0) !== (generation ?? 0)) return;
            target.stdin = undefined;
            target.sendControl = undefined;
            const checkpoint = target.sessionFile;
            const restorable = Boolean(
              target.restart
              && checkpoint
              && existsSync(checkpoint)
              && isSessionPathContained(target.sessionDir, checkpoint),
            );
            if (restorable) {
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
          onRetry: (retry) => applyAgentRetryState(state, retry),
          onReclamationOutcome: (childId, outcome) => {
            recordChildReclamationOutcome(state, childId, outcome);
          },
          onResultPublished: activeAgent.name === MONITOR_SESSION_NAME
            ? undefined
            : (result, originCwd) => emitTeammateResultPublished(pi, result, originCwd),
          onTurnComplete: (result: SingleResult, terminalStatus?: AgentTerminalStatus) => {
            const canonicalStatus = terminalStatusForResult(result, terminalStatus);
            result.terminalStatus = canonicalStatus;
            const target = state.activeRuns.get(result.correlationId) ?? activeAgent;
            target.resolvedModel = target.resolvedModel ?? result.model;
            if (result.attemptedModels) target.attemptedModels = [...result.attemptedModels];
            setAgentStructuredOutput(target, result.structuredOutput);
            if (!isMultiTask && target.name === MONITOR_SESSION_NAME) {
              publishMonitorSessionTurn?.(target, result);
            }
            const lastMessage = displayMessageForResult(result);
            const settle = isMultiTask ? settleGraphTaskAgent : settleAgent;
            settle(
              state,
              result.correlationId,
              result.exitCode,
              lastMessage,
              result.wakeable !== false,
              canonicalStatus,
            );
            const repeatedTurn = isMultiTask
              ? graphTerminalIds.has(result.correlationId)
              : singleTerminalResult !== undefined;
            if (isMultiTask) {
              graphTerminalIds.add(result.correlationId);
              graphTerminalStatuses.set(result.correlationId, canonicalStatus);
              deliverGraphCompletion();
            } else if (!singleTerminalResult) {
              singleTerminalResult = result;
              singleTerminalStatus = canonicalStatus;
              deliverSingleCompletion();
            }
            if (repeatedTurn) publishAdditionalTurnCompletion(result, canonicalStatus);
          },
          onProgress: (() => {
          const UPDATE_INTERVAL = 300; // ms — throttle TUI updates
          // Two cursors per task: one into the parent's aggregate log, one into
          // the task's own. The task used to receive a copy of the whole
          // aggregate instead, so `teammate-watch` on one task showed every
          // sibling's output as if it were that task's own.
          const logStates = new Map<string, {
            loggedToolCount: number;
            streamingLineIdx: number;
            streamingLineText: string | undefined;
            loggedToolLines: Map<number, number>;
            childStreamingLineIdx: number;
            childToolLines: Map<number, number>;
          }>();
          const pendingByTask = new Map<number, AgentProgress>();
          let latestPendingProgress: AgentProgress | undefined;

          const processProgress = (data: AgentProgress) => {
            activeAgent.lastActivityAt = Date.now();
            const progressKey = data.taskIndex ?? 0;
            const existing = progressState.get(progressKey);
            const progressName = data.name ?? existing?.name;
            const entry: AgentProgressSnapshot = {
              agent: data.agent,
              ...(progressName ? { name: progressName } : {}),
              correlationId: data.correlationId ?? existing?.correlationId ?? taskCorrelationIds[progressKey] ?? correlationId,
              taskIndex: progressKey,
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
            progressState.set(progressKey, entry);
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
            const childAgent = state.activeRuns.get(entry.correlationId);
            if (childAgent) {
              childAgent.phase = entry.phase;
              childAgent.requestedModel = entry.requestedModel ?? childAgent.requestedModel;
              childAgent.resolvedModel = entry.resolvedModel ?? childAgent.resolvedModel;
              childAgent.attemptedModels = entry.attemptedModels ?? childAgent.attemptedModels;
            }
            if (childAgent && childAgent !== activeAgent) {
              childAgent.lastActivityAt = Date.now();
              const nextStatus = entry.status === "completed" ? "sleeping" : entry.status;
              // Snapshots are applied through a throttled queue, so they can
              // arrive after the agent settled or went to sleep. A stale
              // snapshot must not resurrect a terminal agent, nor flip a
              // sleeping agent back to a live run state — the wake/restart
              // paths own those transitions and messages routed on a wrongly
              // "running" status get silently dropped by the child.
              const resurrectsSettled = !LIVE_AGENT_STATUSES.has(childAgent.status)
                && nextStatus !== childAgent.status;
              const wakesSleeping = childAgent.status === "sleeping"
                && (nextStatus === "pending" || nextStatus === "running" || nextStatus === "retrying");
              if (!resurrectsSettled && !wakesSleeping) {
                childAgent.status = nextStatus;
                if (entry.status === "running") childAgent.retry = undefined;
              }
            }

            const shortId = entry.correlationId.slice(0, 8);
            const logKey = entry.correlationId;
            const logState = logStates.get(logKey) ?? {
              loggedToolCount: 0,
              streamingLineIdx: -1,
              streamingLineText: undefined,
              loggedToolLines: new Map<number, number>(),
              childStreamingLineIdx: -1,
              childToolLines: new Map<number, number>(),
            };
            logStates.set(logKey, logState);
            const logLabel = data.name
              ? `@${data.name}#${shortId}`
              : `${data.agent}#${shortId}`;

            // Record a bounded aggregate history while keeping per-agent cursors
            // independent. Each line is written twice: labelled into the
            // parent's aggregate, and unlabelled into the task's own log (where
            // the label would only repeat what the reader already selected).
            const ownLog = childAgent && childAgent !== activeAgent ? childAgent : undefined;
            const appendBoth = (parentLine: string, ownLine: string): { parent: number; own: number } => {
              const parent = activeAgent.outputLog.length;
              activeAgent.outputLog.push(parentLine);
              let own = -1;
              if (ownLog) {
                own = ownLog.outputLog.length;
                ownLog.outputLog.push(ownLine);
              }
              return { parent, own };
            };
            const markToolDone = (lines: string[], index: number | undefined): void => {
              if (index === undefined || index < 0) return;
              if (lines[index]?.includes("~ ")) lines[index] = lines[index].replace("~ ", "✓ ");
            };

            if (data.recentTools?.length) {
              for (let ti = logState.loggedToolCount; ti < data.recentTools.length; ti++) {
                const tool = data.recentTools[ti];
                const stamp = new Date().toISOString().slice(11, 19);
                const at = appendBoth(`[${stamp}] ${logLabel} ~ ${tool.name}`, `[${stamp}] ~ ${tool.name}`);
                logState.loggedToolLines.set(ti, at.parent);
                logState.childToolLines.set(ti, at.own);
                logState.streamingLineIdx = -1;
                logState.streamingLineText = undefined;
                logState.childStreamingLineIdx = -1;
              }
              for (let ti = 0; ti < data.recentTools.length; ti++) {
                if (data.recentTools[ti].status === "running") continue;
                markToolDone(activeAgent.outputLog, logState.loggedToolLines.get(ti));
                if (ownLog) markToolDone(ownLog.outputLog, logState.childToolLines.get(ti));
              }
              logState.loggedToolCount = data.recentTools.length;
            }
            if (data.lastMessage) {
              const lastLine = data.lastMessage.split("\n").pop()?.trim();
              if (lastLine) {
                const parentStreamingLineExists = logState.streamingLineText !== undefined
                  && activeAgent.outputLog[logState.streamingLineIdx] === `${logLabel} │ ${logState.streamingLineText}`;
                const childStreamingLineExists = !ownLog
                  || (logState.streamingLineText !== undefined
                    && ownLog.outputLog[logState.childStreamingLineIdx] === `│ ${logState.streamingLineText}`);
                if (parentStreamingLineExists && childStreamingLineExists) {
                  activeAgent.outputLog[logState.streamingLineIdx] = `${logLabel} │ ${lastLine}`;
                  if (ownLog) {
                    ownLog.outputLog[logState.childStreamingLineIdx] = `│ ${lastLine}`;
                  }
                } else {
                  const at = appendBoth(`${logLabel} │ ${lastLine}`, `│ ${lastLine}`);
                  logState.streamingLineIdx = at.parent;
                  logState.childStreamingLineIdx = at.own;
                }
                logState.streamingLineText = lastLine;
              }
            }
            const logLengthBeforeTrim = activeAgent.outputLog.length;
            const ownLengthBeforeTrim = ownLog?.outputLog.length;
            trimAgentBuffers(activeAgent);
            if (ownLog) trimAgentBuffers(ownLog, ownLog.status === "sleeping");
            // Trimming shifts every recorded index, in either log.
            if (activeAgent.outputLog.length !== logLengthBeforeTrim
              || (ownLog && ownLog.outputLog.length !== ownLengthBeforeTrim)) {
              logStates.clear();
            }
          };

          const publishProgress = (data: AgentProgress) => {
            const progressKey = data.taskIndex ?? 0;
            const entry = progressState.get(progressKey);
            if (!entry) return;
            const currentProgress = progressSnapshot();
            activeAgent.progress = currentProgress;
            activeAgent.phase = aggregateAgentRunPhase(currentProgress) ?? activeAgent.phase;

            // Broadcast the complete graph snapshot so overlays can switch views reliably.
            pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
              correlationId,
              agent: data.agent,
              name: data.name,
              taskCorrelationId: entry.correlationId,
              taskIndex: progressKey,
              dependencies: entry.dependencies,
              status: data.status,
              toolCount: data.toolCount,
              tokens: data.tokens,
              recentTools: data.recentTools,
              lastMessage: data.lastMessage,
              lastActivityAt: data.lastActivityAt,
              progress: currentProgress,
            });

            if (foregroundUpdateOpen) {
              onUpdate?.({
                content: [{
                  type: "text",
                  text: `[${data.name ?? data.agent}] ${data.status} · tools ${data.toolCount} · tokens ${data.tokens}`,
                }],
                details: {
                  mode: (graphMode ?? "single") as Details["mode"],
                  results: [],
                  progress: currentProgress,
                  ...(childCalls.size > 0 ? { childCalls: [...childCalls.values()] } : {}),
                },
              });
            }
          };

          const flushGate = createProgressFlushGate(() => {
            const latest = latestPendingProgress;
            latestPendingProgress = undefined;
            flushProgressBatch(pendingByTask, latest, processProgress, publishProgress);
          }, UPDATE_INTERVAL);
          progressFlushGate = flushGate;

          return (data: AgentProgress) => {
            activeAgent.lastActivityAt = Date.now();
            const targetId = data.correlationId ?? taskCorrelationIds[data.taskIndex ?? 0] ?? correlationId;
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
            pendingByTask.set(data.taskIndex ?? 0, data);
            latestPendingProgress = data;
            flushGate.mark(data.status === "completed" || data.status === "failed");
          };
          })(),
          onChildRequest: (event: Record<string, unknown>, reply: (msg: unknown) => void) => {
          if (!ownsDispatchGeneration()) {
            reply({
              type: "teammate_proxy_result",
              requestId: event.requestId,
              result: {
                content: [{ type: "text", text: "Parent session generation changed; stale child request rejected." }],
                isError: true,
                details: { mode: "single", results: [] },
              },
            });
            return;
          }
          if (event.type === "teammate_interaction_request" || event.type === "teammate_rpc_ui_request") {
            enqueueChildInteraction(event, reply, ctx, correlationId);
            return;
          }
          if (event.type === "teammate_proxy_cancel" && typeof event.requestId === "string") {
            cancelProxyDispatch(state, event.requestId);
            return;
          }
          void handleProxyRequest(
            pi,
            state,
            event,
            reply,
            correlationId,
            refreshModelCatalog(ctx).models,
            (request, respond, childId) => enqueueChildInteraction(request, respond, ctx, childId),
            publishChildCallStatus,
            runtimeOptions,
            (() => {
              const activeMailboxHost = mailboxHost && mailboxHost.mode === "authoritative" ? mailboxHost : undefined;
              return activeMailboxHost
                ? (request) => activeMailboxHost.rollout.deliver(request).then((r) => ({ path: r.path, result: r.result }))
                : undefined;
            })(),
            async (target, message, mode) => (await routeSessionMessage({
              selector: target,
              message,
              mode,
              source: activeAgent.name === "monitor-session" ? "monitor" : "system",
              signal: activeAgent.abortController.signal,
            })).delivered,
            async () => {
              await workspacePeerLifecycle;
              await refreshWorkspacePeerOwners();
              return workspacePeerWindowListings();
            },
            (request) => routeSessionMessage({
              ...request,
              source: activeAgent.name === "monitor-session" ? "monitor" : "system",
              signal: activeAgent.abortController.signal,
            }),
            async () => {
              await refreshModelRegistry(ctx);
              return refreshModelCatalog(ctx).models;
            },
          );
          },
        };
        if (runtimeOptions.spawnChildProcess) options.spawnChildProcess = runtimeOptions.spawnChildProcess;
        if (runtimeOptions.resultReadyGraceMs !== undefined) {
          options.resultReadyGraceMs = runtimeOptions.resultReadyGraceMs;
        }
        runtimeOptions.onRunOptionsCreated?.(options);
        return options;
      };

      const installColdRestart = (
        target: ActiveAgent,
        task: NormalizedTask,
        taskIndex?: number,
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
          target.lease = createChildLease();
          target.status = "running";
          target.phase = "restoring";
          target.retry = undefined;
          target.failedAt = undefined;
          target.resultReadyAt = undefined;
          target.lastActivityAt = Date.now();
          coldRestarting.add(target.correlationId);

          const ownsRuntime = (): boolean =>
            state.activeRuns.get(target.correlationId) === target
            && target.runtimeGeneration === generation;
          const options = makeOptions();
          options.correlationId = target.correlationId;
          options.taskCorrelationIds = undefined;
          options.taskSignals = undefined;
          options.signal = controller.signal;
          options.resumeSessionFile = checkpoint;
          options.runtimeGeneration = generation;

          const onChildSpawned = options.onChildSpawned;
          options.onChildSpawned = (stdin, sendControl, sessionDir, childId, callbackGeneration) => {
            if (!ownsRuntime()) return;
            onChildSpawned?.(stdin, sendControl, sessionDir, childId ?? target.correlationId, callbackGeneration);
          };
          const onChildEvent = options.onChildEvent;
          options.onChildEvent = (event) => {
            if (ownsRuntime()) onChildEvent?.(event);
          };
          const onChildClosed = options.onChildClosed;
          options.onChildClosed = (childId, callbackGeneration, details) => {
            if (ownsRuntime()) onChildClosed?.(childId, callbackGeneration, details);
          };
          const onRetry = options.onRetry;
          options.onRetry = (retry) => {
            if (ownsRuntime()) onRetry?.(retry);
          };
          const onProgress = options.onProgress;
          options.onProgress = (progress) => {
            if (!ownsRuntime()) return;
            onProgress?.({
              ...progress,
              correlationId: target.correlationId,
              ...(taskIndex === undefined ? {} : { taskIndex }),
            });
          };
          const onReclamationOutcome = options.onReclamationOutcome;
          options.onReclamationOutcome = (childId, outcome) => {
            if (ownsRuntime()) onReclamationOutcome?.(childId, outcome);
          };

          let publishedResult: SingleResult | undefined;
          let terminalResult: SingleResult | undefined;
          let terminalStatus: AgentTerminalStatus | undefined;
          let delivered = false;
          const deliverRestartCompletion = (): void => {
            if (delivered || !ownsRuntime() || !publishedResult || !terminalResult) return;
            if (target.name === MONITOR_SESSION_NAME) {
              delivered = true;
              return;
            }
            delivered = true;
            const status = terminalStatusForResult(terminalResult, terminalStatus);
            emitComplete(
              pi,
              undefined,
              target.agent,
              target.correlationId,
              terminalResult.exitCode,
              terminalResult.durationMs,
              true,
              status === "terminated",
              toStructuredResults([terminalResult], baseCwd),
            );
            const content = displayMessageForResult(terminalResult);
            if (!safeSendMessage(
              pi,
              {
                customType: "teammate-complete",
                content,
                display: true,
                details: { mode: "single", results: [terminalResult] },
              },
              { triggerTurn: true },
            )) markSettledResultInspectable(state, target.correlationId);
          };
          const onTurnComplete = options.onTurnComplete;
          options.onTurnComplete = (result, status) => {
            if (!ownsRuntime()) return;
            onTurnComplete?.(result, status);
            terminalResult = result;
            terminalStatus = status;
            deliverRestartCompletion();
          };

          const restartParams = {
            agent: task.agent,
            name: task.name,
            task: message,
            taskType: task.taskType,
            context: "fresh" as const,
            model: task.model,
            fallbackModels: task.fallbackModels,
            thinking: task.thinking,
            cwd: task.cwd,
            outputSchema: task.outputSchema,
            timeoutMs: task.timeoutMs,
            reply_to: params.reply_to,
          };
          target.restartPending = runWithProgressFlushCleanup(
            () => runSingleTeammate(restartParams, options),
            progressFlushGate,
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
            coldRestarting.delete(target.correlationId);
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

      if (isSingle) installColdRestart(activeAgent, singleTask);
      else normalizedTasks.forEach((task, index) => {
        const target = state.activeRuns.get(taskCorrelationIds[index]);
        if (target) installColdRestart(target, task, index);
      });

      try {
        // --- MULTI-TASK MODE (parallel / chain / graph) ---
        if (isMultiTask) {
          const activeGraphMode = inferGraphMode(normalizedTasks);
          const executeGraph = async () => {
            const options = makeOptions();
            const results = await runWithProgressFlushCleanup(
              () => runGraph(normalizedTasks, params.concurrency ?? 4, options),
              progressFlushGate,
            );

            const hasError = results.some(resultIsError);
            const totalDur = activeGraphMode === "chain"
              ? results.reduce((s, r) => s + r.durationMs, 0)
              : Math.max(...results.map((r) => r.durationMs), 0);

            const summaries = summarizeGraphResults(results, normalizedTasks);

            const structuredOutput = aggregateGraphStructuredOutput(results, normalizedTasks);

            results.forEach((result, index) => {
              const current = progressState.get(index);
              const lifecyclePending = result.lifecyclePending === true;
              progressState.set(index, {
                agent: result.agent,
                ...(normalizedTasks[index]?.name ? { name: normalizedTasks[index].name } : {}),
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

            return { results, hasError, totalDur, summaries, structuredOutput, progress };
          };

          const failGraphDispatch = (error: unknown): void => {
            if (!ownsDispatchGeneration()) return;
            const message = error instanceof Error ? error.message : String(error);
            abortController.abort(error);
            taskCorrelationIds.forEach((taskId) => {
              if (graphTerminalIds.has(taskId)) return;
              graphTerminalIds.add(taskId);
              graphTerminalStatuses.set(taskId, "terminated");
              settleGraphTaskAgent(state, taskId, 1, message, false, "terminated");
            });
            settleGraphContainerAgent(state, correlationId, 1, message, false);
            notifyBackgroundFailure(pi, id, activeGraphMode, correlationId, error, state);
          };

          const completeGraphInBackground = (
            bgPromise: ReturnType<typeof executeGraph>,
          ): void => {
            void bgPromise.then(({ results, summaries, progress, totalDur }) => {
              const exitCode = aggregateTerminalStatus(results) === "completed" ? 0 : 1;
              publishGraphResult({
                results,
                summaries,
                progress,
                totalDur,
                exitCode,
                mode: activeGraphMode,
                // The aggregate owns no child process; only physical task rows are wakeable.
                wakeable: false,
              }, true);
            }).catch((error) => {
              failGraphDispatch(error);
            });
          };

          if (params.background === false) {
            const waitMs = concurrencyWaitWindowMs(
              normalizedTasks,
              params.concurrencyWaitMs,
              runtimeOptions.foregroundMaxRunMs,
            );
            let detachResolve: ((reason: "manual") => void) | null = null;
            const detachPromise = new Promise<"manual">((resolve) => { detachResolve = resolve; });
            let removeListener: (() => void) | null = null;
            let deadline: ReturnType<typeof createForegroundDeadline> | undefined;
            let graphPromise!: ReturnType<typeof executeGraph>;
            let race:
              | { done: true; result: Awaited<typeof graphPromise>; reason: undefined }
              | { done: false; result: null; reason: "manual" | "timeout" };
            try {
              removeListener = ctx.hasUI
                ? registerForegroundDetach(() => detachResolve?.("manual"), ctx.ui)
                : null;
              deadline = createForegroundDeadline(waitMs);
              graphPromise = executeGraph();
              race = await Promise.race([
                graphPromise.then((result) => ({ done: true as const, result, reason: undefined })),
                detachPromise.then((reason) => ({ done: false as const, result: null, reason })),
                deadline.promise.then((reason) => ({ done: false as const, result: null, reason })),
              ]);
            } finally {
              removeListener?.();
              deadline?.dispose();
            }

            if (race.done) {
              const { results, hasError, totalDur, summaries, structuredOutput, progress } = race.result;
              publishGraphResult({
                results,
                summaries,
                progress,
                totalDur,
                exitCode: hasError ? 1 : 0,
                mode: activeGraphMode,
                // The aggregate owns no child process; only physical task rows are wakeable.
                wakeable: false,
              }, false);

              return {
                content: [{ type: "text", text: warningPrefix + summaries }],
                isError: hasError,
                details: {
                  mode: activeGraphMode,
                  results,
                  progress,
                  ...(structuredOutput !== undefined ? { structuredOutput } : {}),
                  ...(childCalls.size > 0 ? { childCalls: [...childCalls.values()] } : {}),
                },
              };
            }

            // Manual and timed detach share the same background completion path.
            detached = true;
            completeGraphInBackground(graphPromise);
            const detachText = race.reason === "timeout"
              ? `${normalizedTasks.length} tasks (${activeGraphMode}) moved to background after ${waitMs}ms.`
              : `${normalizedTasks.length} tasks (${activeGraphMode}) detached.`;
            return {
              content: [{
                type: "text",
                text: `${warningPrefix}${detachText} ${FOREGROUND_DETACH_HINT} ${backgroundWaitGuidance(correlationId)}`,
              }],
              isError: false,
              details: { mode: activeGraphMode, results: [], progress: progressSnapshot() },
            };
          }

          const bgPromise = executeGraph();
          completeGraphInBackground(bgPromise);

          return {
            content: [{
              type: "text",
              text: `${warningPrefix}${normalizedTasks.length} tasks (${activeGraphMode}) running in background. ${backgroundWaitGuidance(correlationId)}`,
            }],
            isError: false,
            details: { mode: activeGraphMode, results: [], progress: progressSnapshot() },
          };
        }

        if (params.background === false) {
          // --- FOREGROUND: block until completion, Alt+B or deadline to detach ---
          let detachResolve: ((reason: "manual") => void) | null = null;
          const detachPromise = new Promise<"manual">((resolve) => { detachResolve = resolve; });
          const waitMs = foregroundWaitWindowMs(normalizedTasks, runtimeOptions.foregroundMaxRunMs);
          let removeListener: (() => void) | null = null;
          let deadline: ReturnType<typeof createForegroundDeadline> | undefined;
          let runPromise!: Promise<SingleResult>;
          let race:
            | { done: true; result: SingleResult; reason: undefined }
            | { done: false; result: null; reason: "manual" | "timeout" };
          try {
            removeListener = ctx.hasUI
              ? registerForegroundDetach(() => detachResolve?.("manual"), ctx.ui)
              : null;
            deadline = createForegroundDeadline(waitMs);
            const options = makeOptions();
            runPromise = runWithProgressFlushCleanup(
              () => runSingleTeammate(singleRunParams, options),
              progressFlushGate,
            );
            race = await Promise.race([
              runPromise.then((result) => ({ done: true as const, result, reason: undefined })),
              detachPromise.then((reason) => ({ done: false as const, result: null, reason })),
              deadline.promise.then((reason) => ({ done: false as const, result: null, reason })),
            ]);
          } finally {
            removeListener?.();
            deadline?.dispose();
          }

          if (race.done) {
            const result = race.result;
            if (!result) throw new Error("Foreground teammate finished without a result.");
            const lastMessage = displayMessageForResult(result);
            publishSingleResult(result, false);
            const details: Details = {
              mode: "single",
              results: [result],
              ...(childCalls.size > 0 ? { childCalls: [...childCalls.values()] } : {}),
            };
            if (result.structuredOutput !== undefined) {
              details.structuredOutput = result.structuredOutput;
            }
            return {
              content: [{ type: "text", text: warningPrefix + lastMessage }],
              isError: resultIsError(result),
              details,
            };
          }

          // Manual and timed detach share the same background completion path.
          markStallNotification();
          detached = true;
          runPromise.then((result) => {
            if (!ownsDispatchGeneration()) return;
            publishSingleResult(result, true);
          }).catch((error) => {
            if (!ownsDispatchGeneration()) return;
            settleAgent(
              state,
              correlationId,
              1,
              error instanceof Error ? error.message : String(error),
              false,
            );
            notifyBackgroundFailure(pi, id, agentLabel, correlationId, error, state);
          });
          const detachText = race.reason === "timeout"
            ? `■ @${singleTask.name ?? singleTask.agent} moved to background after ${waitMs}ms.`
            : `■ @${singleTask.name ?? singleTask.agent} detached.`;
          return {
            content: [{
              type: "text",
              text: `${detachText} ${FOREGROUND_DETACH_HINT} ${backgroundWaitGuidance(correlationId)}`,
            }],
            isError: false,
            details: { mode: "single", results: [] },
          };
        }

        // --- BACKGROUND (default) ---
        markStallNotification();
        const options = makeOptions();
        const bgPromise = runWithProgressFlushCleanup(
          () => runSingleTeammate(singleRunParams, options),
          progressFlushGate,
        );

        bgPromise.then((result) => {
          if (!ownsDispatchGeneration()) return;
          publishSingleResult(result, true);
        }).catch((error) => {
          if (!ownsDispatchGeneration()) return;
          settleAgent(
            state,
            correlationId,
            1,
            error instanceof Error ? error.message : String(error),
            false,
          );
          notifyBackgroundFailure(pi, id, agentLabel, correlationId, error, state);
        });

        return {
          content: [{
            type: "text",
            text: `${warningPrefix}■ @${singleTask.name ?? singleTask.agent} running in background. ${backgroundWaitGuidance(correlationId)}`,
          }],
          isError: false,
          details: { mode: "single", results: [] },
        };
      } finally {
        foregroundUpdateOpen = false;
        if (params.background === false && !detached) {
          const agent = state.activeRuns.get(correlationId);
          if (agent?.status === "running" && !dispatchLifecyclePending) {
            killAgent(state, correlationId, undefined, "failed");
          }
        }
        if (foregroundToolRuns.delete(correlationId)) updateAgentWidget();
        signal.removeEventListener("abort", abortForward);
      }
    },

    renderCall(args, theme, context) {
      return renderTeammateCall(args, theme, context);
    },

    renderResult(result, options, theme, context) {
      return renderTeammateResult(result, options, theme, context?.args);
    },
  };

  // =========================================================================
  // Tool 2: teammate-send — send message to named agent
  // =========================================================================

  const sendTool: ToolDefinition<typeof TeammateSendParams, { delivered: boolean }> = {
    name: "teammate-send",
    label: "Teammate Send",
    renderShell: "self",
    description: TEAMMATE_SEND_DESCRIPTION,
    promptSnippet: TEAMMATE_SEND_SNIPPET,
    promptGuidelines: TEAMMATE_SEND_GUIDELINES,

    parameters: TeammateSendParams,

    async execute(
      id: string,
      params: { to: string; message?: string; mode?: RpcMessageMode; kind?: SessionMessageKind },
      signal: AbortSignal,
    ): Promise<TeammateToolResult<{ delivered: boolean }>> {
      const requestedMode = params.mode ?? "follow_up";
      const messageKind = params.kind ?? "coordination";
      const message = params.message ?? "";
      if (!message && requestedMode !== "abort") {
        return {
          content: [{ type: "text", text: `"message" is required for mode "${requestedMode}".` }],
          isError: true,
          details: { delivered: false },
        };
      }

      const cid = resolveAgentCorrelationId(state, params.to);
      if (!cid && requestedMode === "abort") {
        return {
          content: [{ type: "text", text: "Cross-session targets support only steer and follow_up; abort is local-only." }],
          isError: true,
          details: { delivered: false },
        };
      }

      const agent = cid ? state.activeRuns.get(cid) : undefined;
      if (agent && !LIVE_AGENT_STATUSES.has(agent.status)) {
        return {
          content: [{ type: "text", text: `Agent "${params.to}" is already ${agent.status} and cannot receive commands.` }],
          isError: true,
          details: { delivered: false },
        };
      }

      const mode = requestedMode === "steer" || requestedMode === "abort" ? requestedMode : "follow_up";
      const routedMode = !cid && messageKind === "status" ? "follow_up" : mode;
      const delivery = await routeSessionMessage({
        selector: params.to,
        targetCorrelationId: cid,
        message,
        mode: routedMode,
        source: id.startsWith("monitor-") ? "monitor" : "system",
        messageKind,
        signal,
      });
      if (!delivery.delivered) {
        // Unbind names only for agents that are genuinely gone. A transient
        // delivery failure to a sleeping (cold-restartable) agent must keep its
        // name bound, and the cleanup must match by value: `params.to` may be
        // decorated ("@name", "name#prefix") and the name may have been taken
        // over by a different agent since resolution.
        const failedAgent = cid ? state.activeRuns.get(cid) : undefined;
        if (cid && (!failedAgent || !LIVE_AGENT_STATUSES.has(failedAgent.status))) {
          for (const [agentName, boundId] of state.namedAgents) {
            if (boundId === cid) state.namedAgents.delete(agentName);
          }
        }
        const error = !cid && delivery.error?.startsWith("Session selector ")
          ? `Workspace target "${params.to}" was not found. Use teammate-list with view=windows.`
          : delivery.error;
        return {
          content: [{ type: "text", text: error ?? `Failed to send message to "${params.to}".` }],
          isError: true,
          details: { delivered: false },
        };
      }

      if (!cid) {
        const deliveryStage = delivery.receipt?.deliveryStage ?? "queued";
        const effectiveMode = delivery.receipt?.effectiveMode ?? mode;
        const queuedHint = deliveryStage === "queued"
          ? " The peer's reply will be injected after this turn ends; end the turn to receive it."
          : "";
        return {
          content: [{
            type: "text",
            text: `Message ${deliveryStage} for workspace target "${params.to}" (kind ${messageKind}, requested ${mode}, effective ${effectiveMode}).${queuedHint}`,
          }],
          isError: false,
          details: { delivered: true },
        };
      }
      if (mode === "abort") {
        const terminatedCount = delivery.receipt?.terminatedCount ?? 1;
        return {
          content: [{
            type: "text",
            text: `Agent "${params.to}" aborted; terminated ${terminatedCount} agent${terminatedCount === 1 ? "" : "s"} in its subtree.`,
          }],
          isError: false,
          details: { delivered: true },
        };
      }

      const modeLabel = delivery.receipt?.wasSleeping
        ? "woken up + prompt"
        : delivery.receipt?.mode === "steer" ? "interrupted + injected" : "queued after current turn";
      return {
        content: [{ type: "text", text: `Message ${modeLabel} for "${params.to}".${delivery.receipt?.wasSleeping ? " Agent woken up." : ""}` }],
        isError: false,
        details: { delivered: true },
      };
    },

    renderCall(args, theme, context) {
      if (context.isPartial === false) return new Text("", 0, 0);
      const mode = typeof args.mode === "string" ? args.mode : "follow_up";
      return renderQuietTeammateAux("teammate-send", `@${String(args.to ?? "?")} · ${mode}`, "running", theme)
        ?? auxToolCallFallback("teammate-send", theme);
    },

    renderResult(result, options, theme) {
      if (options.isPartial) return new Text("", 0, 0);
      const failed = (result as { isError?: boolean }).isError === true || result.details?.delivered !== true;
      return renderQuietTeammateAux("teammate-send", failed ? "delivery failed" : "delivered", failed ? "failure" : "success", theme)
        ?? auxToolResultFallback(result, theme);
    },
  };

  // =========================================================================
  // Tool 3: teammate-list — list active agents
  // =========================================================================

  const listTool: ToolDefinition<typeof TeammateListParams, { agents: unknown[] }> = {
    name: "teammate-list",
    label: "Teammate List",
    renderShell: "self",
    description: TEAMMATE_LIST_DESCRIPTION,
    promptSnippet: TEAMMATE_LIST_SNIPPET,
    promptGuidelines: TEAMMATE_LIST_GUIDELINES,

    parameters: TeammateListParams,

    async execute(
      _id: string,
      params: WindowInboxQuery & { view?: TeammateListView },
      _signal: AbortSignal,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<TeammateToolResult<{ agents: unknown[] }>> {
      const view = params.view ?? "active";
      if (view === "roles") {
        const { entries, text } = buildRoleList(ctx.cwd);
        return {
          content: [{ type: "text", text }],
          isError: false,
          details: { agents: entries },
        };
      }
      if (view === "inbox") {
        try {
          const inbox = await loadWorkspaceWindowInbox(
            resolveWindowInboxAnchor(
              state.mainSessionFile,
              ctx.sessionManager?.getSessionFile?.(),
            ),
            params,
          );
          const entries = inbox.entries.map((entry) => ({ kind: "window-message" as const, ...entry }));
          return {
            content: [{ type: "text", text: formatWorkspaceWindowInbox(inbox) }],
            isError: false,
            details: { agents: entries },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: message }],
            isError: true,
            details: { agents: [] },
          };
        }
      }
      if (view === "windows") {
        await workspacePeerLifecycle;
        await refreshWorkspacePeerOwners();
        const entries = workspacePeerWindowListings().map((window) => ({
          kind: "window" as const,
          ...window,
        }));
        const text = entries.length === 0
          ? "No available peer sessions."
          : entries.map((window) => {
            const label = window.sessionName ?? `window:${window.ownerId.slice(0, 8)}`;
            return `● [window] ${label} · ${window.status} · agents=${window.agentCount} · target=${window.target}`;
          }).join("\n");
        return {
          content: [{ type: "text", text }],
          isError: false,
          details: { agents: entries },
        };
      }
      await workspacePeerLifecycle;
      await refreshWorkspacePeerOwners();
      const local = buildAgentList(state, view as "active" | "named" | "all");
      const remoteEntries = workspacePeerOwners.flatMap((owner) => {
        const active = owner.agents
          .filter((agent) => view !== "named" || Boolean(agent.name))
          .map((agent) => ({
            agent: agent.agent,
            name: agent.name,
            correlationId: agent.correlationId,
            status: agent.status,
            startedAt: new Date(agent.startedAt).toISOString(),
            durationMs: Math.max(0, Date.now() - agent.startedAt),
            idleMs: Math.max(0, Date.now() - agent.lastActivityAt),
            depth: agent.depth ?? 0,
            parentCorrelationId: agent.parentCorrelationId,
            ownerId: owner.ownerId,
            target: `owner:${owner.ownerId}:${agent.correlationId}`,
            sessionId: owner.sessionId,
            sessionName: owner.sessionName,
            source: "workspace-peer",
          }));
        if (view !== "all") return active;
        return [...active, ...owner.settled.map((agent) => ({
          agent: agent.agent,
          name: agent.name,
          correlationId: agent.correlationId,
          status: agent.status,
          startedAt: new Date(agent.settledAt).toISOString(),
          durationMs: 0,
          idleMs: Math.max(0, Date.now() - agent.settledAt),
          depth: 0,
          ownerId: owner.ownerId,
          target: `owner:${owner.ownerId}:${agent.correlationId}`,
          sessionId: owner.sessionId,
          sessionName: owner.sessionName,
          source: "workspace-peer",
        }))];
      });
      const remoteText = remoteEntries.map((entry) => {
        const icon = entry.status === "failed" ? "✗" : entry.status === "completed" ? "✓" : "●";
        const identity = entry.name ? `[${entry.agent}] name="${entry.name}"` : `[${entry.agent}]`;
        const source = entry.sessionName ?? `owner ${entry.ownerId.slice(0, 8)}`;
        return `${icon} ${identity} · id=${entry.correlationId.slice(0, 8)} · ${entry.status} · workspace peer ${source} · target=${entry.target}`;
      }).join("\n");
      const text = remoteEntries.length === 0
        ? local.text
        : local.entries.length === 0 ? remoteText : `${local.text}\n${remoteText}`;
      const entries = [...local.entries, ...remoteEntries];

      return {
        content: [{ type: "text", text }],
        isError: false,
        details: { agents: entries },
      };
    },

    renderCall(args, theme, context) {
      return renderTeammateListCall(args, theme, context);
    },

    renderResult(result, options, theme) {
      return renderTeammateListResult(result, options, theme);
    },
  };

  // =========================================================================
  // Tool 4: teammate-watch — view agent output and activity
  // =========================================================================

  const watchTool: ToolDefinition<typeof TeammateWatchParams, { output: string[] }> = {
    name: "teammate-watch",
    label: "Teammate Watch",
    renderShell: "self",
    description: TEAMMATE_WATCH_DESCRIPTION,
    promptSnippet: TEAMMATE_WATCH_SNIPPET,
    promptGuidelines: TEAMMATE_WATCH_GUIDELINES,

    parameters: TeammateWatchParams,

    async execute(
      _id: string,
      params: { name: string; lines?: number },
    ): Promise<TeammateToolResult<{ output: string[] }>> {
      const observed = await observeTargets({
        action: "status",
        targets: [{ kind: "teammate", id: params.name }],
        detail: "full",
        lines: params.lines ?? 20,
      });
      const observation = observed.observations[0]!;
      const output = observation.found ? (observation.detail ?? [observation.summary]) : [];
      return {
        content: [{ type: "text", text: observation.found ? output.join("\n") : observation.summary }],
        isError: !observation.found,
        details: { output },
      };
    },

    renderCall(args, theme, context) {
      if (context.isPartial === false) return new Text("", 0, 0);
      const lines = typeof args.lines === "number" ? ` · ${args.lines} lines` : "";
      return renderQuietTeammateAux("teammate-watch", `@${String(args.name ?? "?")}${lines}`, "running", theme)
        ?? auxToolCallFallback("teammate-watch", theme);
    },

    renderResult(result, options, theme) {
      if (options.isPartial) return new Text("", 0, 0);
      const failed = (result as { isError?: boolean }).isError === true;
      return renderQuietTeammateAux("teammate-watch", failed ? "inspection failed" : "inspected", failed ? "failure" : "success", theme)
        ?? auxToolResultFallback(result, theme);
    },
  };

  const waitTool: ToolDefinition<typeof TeammateWaitParams, { status: TeammateWaitStatus; output: string[] }> = {
    name: "teammate-wait",
    label: "Teammate Wait",
    renderShell: "self",
    description: TEAMMATE_WAIT_DESCRIPTION,
    promptSnippet: TEAMMATE_WAIT_SNIPPET,
    promptGuidelines: TEAMMATE_WAIT_GUIDELINES,
    parameters: TeammateWaitParams,

    async execute(
      _id: string,
      params: { name?: string; timeoutMs?: number; waitMs?: number },
      signal: AbortSignal,
    ): Promise<TeammateToolResult<{ status: TeammateWaitStatus; output: string[] }>> {
      if (!params.name) {
        const result = await waitForTeammate(state, params, signal);
        return {
          content: [{ type: "text", text: result.output.join("\n") }],
          isError: result.status === "not-found" || result.status === "stalled" || result.status === "timeout" || result.status === "aborted",
          details: { status: result.status, output: result.output },
        };
      }
      const observed = await observeTargets({
        action: "wait",
        targets: [{ kind: "teammate", id: params.name }],
        timeoutMs: params.timeoutMs,
        detail: "full",
        lines: 20,
      }, signal);
      const observation = observed.observations[0]!;
      const status = observation.waitStatus as TeammateWaitStatus;
      const output = observation.detail
        ?? (status === "timeout" || status === "aborted" ? waitOutput(status, params.name) : [observation.summary]);
      return {
        content: [{ type: "text", text: output.join("\n") }],
        isError: status === "not-found" || status === "stalled" || status === "timeout" || status === "aborted",
        details: { status, output },
      };
    },

    renderCall(args, theme, context) {
      if (context.isPartial === false) return new Text("", 0, 0);
      const target = args.name ? `@${String(args.name)}` : `${String(args.waitMs ?? 0)}ms`;
      return renderQuietTeammateAux("teammate-wait", target, "running", theme)
        ?? auxToolCallFallback("teammate-wait", theme);
    },

    renderResult(result, options, theme) {
      if (options.isPartial) return new Text("", 0, 0);
      const status = result.details?.status ?? "timeout";
      const failed = (result as { isError?: boolean }).isError === true;
      return renderQuietTeammateAux("teammate-wait", status, failed ? "failure" : "success", theme)
        ?? auxToolResultFallback(result, theme);
    },
  };

  // ---------------------------------------------------------------------------
  // Monitor — persistent observation mode (user-entered) + LLM query tools
  // ---------------------------------------------------------------------------

  const monitorEngine = createEngineState();
  let monitorController: MonitorController | undefined;
  /** Effective monitor configuration (`.pi/settings.json` `monitor` + env). */
  let monitorConfig: MonitorEngineConfig = { ...DEFAULT_MONITOR_CONFIG };
  /** Ledger root — the real session cwd once known. */
  let monitorLedgerRoot: string | undefined;
  /** In-memory ledger read-model cache for status/doctor output. */
  let monitorLedgerState: MonitorLedgerState | undefined;
  let monitorLedgerWarnings: string[] = [];
  /** In-flight ledger appends (flushed before binding exits release leases). */
  const monitorLedgerWrites: Promise<unknown>[] = [];

  const monitorSessionAgent = (): ActiveAgent | undefined => {
    const correlationId = state.namedAgents.get(MONITOR_SESSION_NAME);
    return correlationId ? state.activeRuns.get(correlationId) : undefined;
  };

  function monitorSessionStatus(): string {
    const agent = monitorSessionAgent();
    if (!agent) return monitorController?.running ? "starting" : "stopped";
    return agent.status;
  }

  function recordMonitorLedger(record: MonitorLedgerRecord): void {
    const root = monitorLedgerRoot ?? state.baseCwd;
    if (!root || !monitorConfig.ledgerEnabled) return;
    const write = appendMonitorLedgerRecord(root, record)
      .then(() => { void refreshMonitorLedgerState(); })
      .catch((error) => {
        console.error("[pi-maestro-teammate] monitor ledger append failed:", error);
      })
      .finally(() => {
        const index = monitorLedgerWrites.indexOf(write);
        if (index >= 0) monitorLedgerWrites.splice(index, 1);
      });
    monitorLedgerWrites.push(write);
  }

  interface PendingMonitorTurn {
    requestId: string;
    invocation?: MonitorSessionInvocation;
    invocationPromise: Promise<MonitorSessionInvocation>;
    resolveInvocation: (invocation: MonitorSessionInvocation) => void;
    rejectInvocation: (error: Error) => void;
    resultPromise: Promise<MonitorSessionTurnResult>;
    resolveResult: (result: MonitorSessionTurnResult) => void;
    rejectResult: (error: Error) => void;
  }

  const pendingMonitorTurns = new Map<string, PendingMonitorTurn>();

  const createPendingMonitorTurn = (requestId: string): PendingMonitorTurn => {
    let resolveInvocation!: (invocation: MonitorSessionInvocation) => void;
    let rejectInvocation!: (error: Error) => void;
    let resolveResult!: (result: MonitorSessionTurnResult) => void;
    let rejectResult!: (error: Error) => void;
    const pending: PendingMonitorTurn = {
      requestId,
      invocationPromise: new Promise((resolve, reject) => {
        resolveInvocation = resolve;
        rejectInvocation = reject;
      }),
      resolveInvocation: (invocation) => resolveInvocation(invocation),
      rejectInvocation: (error) => rejectInvocation(error),
      resultPromise: new Promise((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      }),
      resolveResult: (result) => resolveResult(result),
      rejectResult: (error) => rejectResult(error),
    };
    void pending.invocationPromise.catch(() => undefined);
    void pending.resultPromise.catch(() => undefined);
    pendingMonitorTurns.set(requestId, pending);
    return pending;
  };

  const rejectPendingMonitorTurn = (pending: PendingMonitorTurn, error: Error): void => {
    pending.rejectInvocation(error);
    pending.rejectResult(error);
    if (pendingMonitorTurns.get(pending.requestId) === pending) pendingMonitorTurns.delete(pending.requestId);
  };

  bindMonitorSessionDispatch = (toolCallId, agent) => {
    const pending = pendingMonitorTurns.get(toolCallId);
    if (!pending || pending.invocation) return;
    const invocation: MonitorSessionInvocation = {
      requestId: toolCallId,
      correlationId: agent.correlationId,
      promptSequence: agent.promptSeq ?? 1,
      sessionIdentity: agent,
    };
    pending.invocation = invocation;
    pending.resolveInvocation(invocation);
  };

  publishMonitorSessionTurn = (agent, result) => {
    for (const pending of pendingMonitorTurns.values()) {
      const invocation = pending.invocation;
      if (!invocation
        || invocation.sessionIdentity !== agent
        || invocation.correlationId !== result.correlationId
        || invocation.promptSequence !== (agent.promptSeq ?? invocation.promptSequence)) continue;
      pending.resolveResult({
        ...invocation,
        structuredOutput: result.structuredOutput,
        text: displayMessageForResult(result),
      });
      return;
    }
  };

  const monitorSessionHost: MonitorSessionHost = {
    async invoke(request, prompt, outputSchema, signal) {
      if (pendingMonitorTurns.has(request.requestId)) {
        throw new Error(`Monitor evaluation ${request.requestId} is already pending.`);
      }
      const pending = createPendingMonitorTurn(request.requestId);
      const existing = monitorSessionAgent();
      if (existing) {
        if (existing.status !== "sleeping" && !existing.restart) {
          rejectPendingMonitorTurn(pending, new Error("Monitor evaluator session is not wakeable."));
          return pending.invocationPromise;
        }
        const delivery = await routeSessionMessage({
          selector: existing.correlationId,
          message: prompt,
          mode: "follow_up",
          source: "monitor",
          signal,
        });
        if (!delivery.delivered) {
          rejectPendingMonitorTurn(pending, new Error(delivery.error ?? "Monitor evaluator could not be resumed."));
          return pending.invocationPromise;
        }
        const invocation: MonitorSessionInvocation = {
          requestId: request.requestId,
          correlationId: existing.correlationId,
          promptSequence: existing.promptSeq ?? 1,
          sessionIdentity: existing,
        };
        pending.invocation = invocation;
        pending.resolveInvocation(invocation);
        return invocation;
      }

      const ctx = widgetCtx;
      if (!ctx) {
        rejectPendingMonitorTurn(pending, new Error("Monitor evaluator requires an active extension session."));
        return pending.invocationPromise;
      }
      void tool.execute(
        request.requestId,
        {
          tasks: [{
            agent: "general",
            name: MONITOR_SESSION_NAME,
            prompt,
            context: "fresh",
            outputSchema,
          }],
          background: true,
          cwd: ctx.cwd,
          maxNestingDepth: 0,
        },
        signal,
        undefined,
        ctx,
      ).then(() => {
        if (!pending.invocation && pendingMonitorTurns.get(request.requestId) === pending) {
          rejectPendingMonitorTurn(pending, new Error("Monitor evaluator did not publish a session identity."));
        }
      }).catch((error) => {
        rejectPendingMonitorTurn(pending, error instanceof Error ? error : new Error(String(error)));
      });
      return pending.invocationPromise;
    },

    async waitForResult(invocation, signal, isCurrent) {
      const pending = pendingMonitorTurns.get(invocation.requestId);
      if (!pending || pending.invocation !== invocation) throw new Error("Monitor evaluation invocation is no longer current.");
      if (signal.aborted || !isCurrent()) throw new Error("Monitor evaluation was cancelled before result wait.");
      let removeAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Monitor evaluation was cancelled."));
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => signal.removeEventListener("abort", onAbort);
      });
      try {
        return await Promise.race([pending.resultPromise, aborted]);
      } finally {
        removeAbort?.();
        if (pendingMonitorTurns.get(invocation.requestId) === pending) pendingMonitorTurns.delete(invocation.requestId);
      }
    },

    async stop(signal) {
      const agent = monitorSessionAgent();
      if (agent && !signal.aborted) {
        await routeSessionMessage({
          selector: agent.correlationId,
          message: "",
          mode: "abort",
          source: "monitor",
          signal,
        });
      }
      const error = new Error("Monitor evaluator stopped.");
      for (const pending of [...pendingMonitorTurns.values()]) rejectPendingMonitorTurn(pending, error);
    },
  };

  const monitorLeases = new MonitorLeaseAdapter({
    getIdentity: () => workspacePeerPublisher?.identity,
    getSessionName: () => workspacePeerSessionName,
  });
  const monitorEvaluator = new MonitorSessionEvaluator(monitorSessionHost);
  const monitorRegistry = sessionHostRegistry;
  if (!monitorRegistry) throw new Error("Session host registry must exist before Monitor initialization.");

  const syncMonitorInteractionStatus = (runtimeStatus?: string): void => {
    if (!widgetCtx?.ui || typeof widgetCtx.ui.setStatus !== "function") return;
    widgetCtx.ui.setStatus(
      MONITOR_STATUS_KEY,
      monitorInteractionModeActive
        ? runtimeStatus ?? `MONITOR · ${monitorEngine.bindings.size} window${monitorEngine.bindings.size === 1 ? "" : "s"}`
        : undefined,
    );
  };

  const enterMonitorInteractionMode = (): void => {
    monitorInteractionModeActive = true;
    syncMonitorInteractionStatus();
  };

  const exitMonitorInteractionMode = (): void => {
    monitorInteractionModeActive = false;
    monitorRegistry.setViewMode("agents");
    syncMonitorInteractionStatus();
  };

  const notifyMonitorModeClosed = (
    ui: ExtensionContext["ui"] | undefined,
    message: string,
  ): void => {
    if (!ui) return;
    if (activePromptLoopIds.length === 0) {
      ui.notify(message, "info");
      return;
    }
    ui.notify(
      `${message}\n${tuiT("extension.monitorLoopsContinue", {
        count: activePromptLoopIds.length,
        ids: activePromptLoopIds.join(", "),
      })}`,
      "warning",
    );
  };

  // Double bare-Esc exits Monitor mode. The first Esc is always passed through
  // untouched (native cancel/clear semantics stay intact); only a second Esc
  // inside the window is consumed. This intentionally takes precedence over
  // Cockpit's double-Esc clear-input gate while Monitor mode is active — the
  // mode owns its exit gesture — and is fully inert outside it. Key repeat
  // and release events are filtered so holding Esc cannot fake a double tap.
  const MONITOR_ESCAPE_TAP_WINDOW_MS = 500;
  let monitorEscapeTapAt = 0;
  let monitorEscapeTapDisposer: (() => void) | undefined;
  const installMonitorEscapeTap = (ui: ExtensionContext["ui"]): void => {
    uninstallMonitorEscapeTap();
    if (!ui || typeof ui.onTerminalInput !== "function") return;
    monitorEscapeTapDisposer = ui.onTerminalInput((data: string) => {
      if (!monitorInteractionModeActive || !matchesKey(data, "escape") || isKeyRelease(data) || isKeyRepeat(data)) {
        return undefined;
      }
      const now = Date.now();
      if (now - monitorEscapeTapAt <= MONITOR_ESCAPE_TAP_WINDOW_MS) {
        monitorEscapeTapAt = 0;
        void monitorRegistry.requestWindowMode("exit").then(() => {
          notifyMonitorModeClosed(widgetCtx?.ui, tuiT("extension.monitorClosed"));
        });
        return { consume: true };
      }
      monitorEscapeTapAt = now;
      return undefined;
    });
  };
  const uninstallMonitorEscapeTap = (): void => {
    const disposer = monitorEscapeTapDisposer;
    monitorEscapeTapDisposer = undefined;
    disposer?.();
  };

  const currentMonitorEndpoint = (endpoint: SessionEndpoint): boolean => {
    const current = monitorRegistry.directory.get(endpoint.id);
    return current?.kind === "root"
      && current.scope === "workspace-peer"
      && current.ownerId === endpoint.ownerId
      && current.ownerNonce === endpoint.ownerNonce;
  };

  const syncMonitorRegistryBindings = (): void => {
    const endpointIds = [...monitorEngine.bindings.keys()].flatMap((key) => {
      const resolution = monitorRegistry.resolve(key);
      return resolution.code === "resolved" && resolution.endpoint?.kind === "root"
        ? [resolution.endpoint.id]
        : [];
    });
    monitorRegistry.setMonitoredEndpointIds(endpointIds);
    if (endpointIds.length > 0) monitorInteractionModeActive = true;
    syncMonitorInteractionStatus();
  };

  const monitorControllerInstance = new MonitorController({
    engine: monitorEngine,
    leases: monitorLeases,
    endpointIsCurrent: currentMonitorEndpoint,
    flushLedger: (emit) => flushPendingMonitorLedger(monitorEngine, emit),
    awaitLedger: async () => {
      await Promise.allSettled([...monitorLedgerWrites]);
      monitorLedgerWrites.splice(0, monitorLedgerWrites.length);
    },
    onBindingsChanged: syncMonitorRegistryBindings,
    runtime: {
      config: () => monitorConfig,
      registry: monitorRegistry,
      evaluator: monitorEvaluator,
      captureTarget(key, binding) {
        const resolution = monitorRegistry.resolve(key);
        const endpoint = resolution.endpoint;
        if (resolution.code !== "resolved" || !endpoint || !currentMonitorEndpoint(endpoint)) return undefined;
        const owner = workspacePeerOwners.find((candidate) =>
          candidate.ownerId === endpoint.ownerId && candidate.ownerNonce === endpoint.ownerNonce
        );
        if (!owner) return undefined;
        const latestActivityAt = owner.agents.reduce(
          (latest, agent) => Math.max(latest, agent.lastActivityAt),
          owner.publishedAt,
        );
        const outputTail = owner.agents.flatMap((agent) =>
          agent.outputTail?.length ? agent.outputTail : agent.summary ? [agent.summary] : []
        ).slice(-20);
        const objective = owner.agents.map((agent) => agent.objective).find((value): value is string => Boolean(value))
          ?? owner.sessionName
          ?? binding.displayName;
        const activeBackgroundJobs = (owner.backgroundJobs ?? [])
          .filter((job) => job.status === "running" || job.status === "stopping")
          .map((job) => `${job.id}: ${job.command}`);
        return {
          endpoint,
          info: {
            correlationId: key,
            name: binding.displayName,
            status: owner.agents.some((agent) => agent.status === "running")
              ? "running"
              : "sleeping",
            idleSeconds: Math.max(0, Math.round((Date.now() - latestActivityAt) / 1000)),
            outputTail,
            objective,
            hasPendingInteractions: owner.agents.some((agent) => (agent.pendingInteractions ?? 0) > 0),
            ...(owner.contextPressure === undefined ? {} : { contextPressure: owner.contextPressure }),
            kind: "window",
          },
          ...(activeBackgroundJobs.length ? { activeBackgroundJobs } : {}),
        };
      },
      async loadGoalContext(binding) {
        if (!binding.goalId) return "";
        const root = monitorLedgerRoot ?? state.baseCwd;
        if (!root) return "";
        const context = await loadPeerGoalContext(root, binding.goalId);
        return context ? buildGoalContextBlock(context) : "";
      },
      onStatusUpdate(status) {
        syncMonitorInteractionStatus(status);
      },
      notifyMain(message, target) {
        safeSendMessage(pi, {
          customType: "teammate-message",
          content: message,
          display: true,
          details: { source: "monitor", ...(target ? { target } : {}) },
        }, { triggerTurn: false });
      },
      recordLedger: recordMonitorLedger,
      async postGoalObjection(goalId, summary, peerId) {
        const root = monitorLedgerRoot ?? state.baseCwd;
        if (root) await appendPeerGoalObjection(root, goalId, { peerId, summary });
      },
      onEvaluationError(reason) {
        console.error(`[pi-maestro-teammate] monitor evaluation rejected: ${reason}`);
      },
    },
  });
  monitorController = monitorControllerInstance;

  // ---------------------------------------------------------------------------
  // Turn-level advisor (quality review of THIS session on agent_end)
  // ---------------------------------------------------------------------------

  let advisorConfig: AdvisorConfig = { ...DEFAULT_ADVISOR_CONFIG };
  const advisorState: AdvisorState = createAdvisorState(advisorConfig);

  /** Load `.pi/settings.json` → `monitor.advisor` (or top-level `advisor`). */
  function loadAdvisorConfigForRoot(root: string): AdvisorConfig {
    let section: unknown;
    try {
      const settingsPath = join(root, ".pi", "settings.json");
      if (existsSync(settingsPath)) {
        const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { monitor?: { advisor?: unknown }; advisor?: unknown };
        section = parsed?.monitor?.advisor ?? parsed?.advisor;
      }
    } catch (error) {
      console.error("[pi-maestro-teammate] failed to read advisor settings:", error);
    }
    return normalizeAdvisorConfig(section);
  }

  /** Low-frequency turn review on agent_end (best-effort, never blocks). */
  async function runAdvisorReview(event: { messages?: unknown[] }, ctx: ExtensionContext): Promise<void> {
    const root = monitorLedgerRoot ?? state.baseCwd ?? ctx.cwd;
    advisorConfig = loadAdvisorConfigForRoot(root);
    if (!shouldReview(advisorState, advisorConfig, Date.now())) return;
    const messages = Array.isArray(event.messages) ? event.messages as AdvisorMessageSlice[] : [];
    if (messages.length === 0) return;
    const { objective, transcript } = extractAdvisorTranscript(messages, {
      tailMessages: advisorConfig.tailMessages,
      maxMessageChars: advisorConfig.maxMessageChars,
    });
    if (transcript.length === 0) return;

    const evaluation = await runSupervisedEvaluation<AdvisorVerdict>(
      ({ task, signal, timeoutMs, outputSchema }) =>
        runSingleTeammate(
          { agent: "analyst", task, thinking: "low", timeoutMs, outputSchema },
          { baseCwd: root, depth: 0, signal },
        ),
      {
        task: buildAdvisorPrompt(objective, transcript),
        timeoutMs: 30_000,
        outputSchema: ADVISOR_VERDICT_SCHEMA,
        fallbackTextParser: parseAdvisorVerdict,
        signal: undefined,
      },
    );

    advisorState.lastReviewAt = Date.now();
    advisorState.reviews += 1;
    const verdict = evaluation.ok && evaluation.verdict ? evaluation.verdict : undefined;
    advisorState.lastVerdict = verdict;
    if (!verdict || verdict.status === "on-track") return;

    // DeliveryGate: cooldown + dedup — the same frequency-control strategy
    // as the fleet Monitor.
    const guidance = verdict.guidance ?? verdict.reason ?? "review the last turn";
    if (advisorState.gate.gate("advisor", guidance, "notify") === undefined) return;
    safeSendMessage(pi, {
      customType: "teammate-message",
      content: `[advisor] ${verdict.status === "blocker" ? "⚠ " : ""}${guidance}`,
      display: true,
      details: { source: "advisor", severity: verdict.status },
    }, { triggerTurn: false });
    if (monitorConfig.ledgerEnabled) {
      void appendMonitorLedgerRecord(root, {
        kind: "review",
        action: "verdict",
        status: verdict.status,
        reason: verdict.reason,
        message: guidance,
        metadata: { source: "advisor" },
      }).then(() => { void refreshMonitorLedgerState(); }).catch((error) => {
        console.error("[pi-maestro-teammate] advisor ledger append failed:", error);
      });
    }
  }

  const monitorBindingRequest = (
    owner: WorkspaceOwnerSnapshot,
    mode: MonitorSupervisionMode,
    customPrompt?: string,
    options: { goalId?: string; resumed?: boolean } = {},
  ): MonitorControllerBindingRequest | undefined => {
    const resolution = monitorRegistry.resolve(`owner:${owner.ownerId}`);
    const endpoint = resolution.endpoint;
    if (resolution.code !== "resolved" || !endpoint || !currentMonitorEndpoint(endpoint)) return undefined;
    return {
      key: `owner:${owner.ownerId}`,
      endpoint,
      displayName: owner.sessionName ?? `window:${owner.ownerId.slice(0, 6)}`,
      mode,
      ...(customPrompt ? { customPrompt } : {}),
      ...(options.goalId ? { goalId: options.goalId } : {}),
      ...(options.resumed ? { resumed: true } : {}),
    };
  };

  /** Release every supervision lease held by this session. */
  async function releaseAllMonitorLeases(): Promise<void> {
    await monitorControllerInstance.leases.releaseAll();
  }

  monitorRegistry.setControls({
    async requestWindowMode(action) {
      if (action === "enter") {
        await refreshWorkspacePeerOwners();
        refreshSessionEndpointDirectory(true);
        enterMonitorInteractionMode();
        monitorRegistry.setViewMode("windows");
        return;
      }
      await monitorControllerInstance.exit("user-exit");
      syncMonitorRegistryBindings();
      exitMonitorInteractionMode();
    },
    async setMonitored(endpointId, enabled, options = {}) {
      await refreshWorkspacePeerOwners();
      refreshSessionEndpointDirectory(true);
      const endpoint = monitorRegistry.directory.get(endpointId);
      if (!endpoint || !currentMonitorEndpoint(endpoint)) throw new Error("Window endpoint is no longer current.");
      const key = `owner:${endpoint.ownerId}`;
      if (!enabled) {
        await monitorControllerInstance.remove(key, "user-removed");
        syncMonitorRegistryBindings();
        return;
      }
      const owner = workspacePeerOwners.find((candidate) =>
        candidate.ownerId === endpoint.ownerId && candidate.ownerNonce === endpoint.ownerNonce
      );
      if (!owner) throw new Error("Window endpoint is no longer discoverable.");
      const request = monitorBindingRequest(
        owner,
        options.mode === "custom" ? "custom" : "auto",
        options.customPrompt,
        { ...(options.goalId ? { goalId: options.goalId } : {}) },
      );
      if (!request) throw new Error("Window endpoint changed before monitor binding.");
      const result = await monitorControllerInstance.bind([request]);
      if (result.bound.length === 0) throw new Error(result.errors[0]?.error ?? "Monitor binding failed.");
      syncMonitorRegistryBindings();
      monitorRegistry.setViewMode("windows");
    },
  });

  // ---------------------------------------------------------------------------
  // Managed windows — /monitor spawn launches headless pi sessions as
  // supervised work windows (pi-peer process-spawn pattern). Headless
  // compatibility windows keep a direct child handle; interactive windows are
  // owned through the exact workspace owner identity published after launch.
  // ---------------------------------------------------------------------------

  type ManagedWindowPresentation = "interactive" | "headless";

  interface WorkspaceWindowToolParams {
    action: "create" | "list" | "close";
    name?: string;
    objective?: string;
    presentation?: ManagedWindowPresentation;
  }

  interface ManagedWindow {
    name: string;
    sessionName: string;
    child: ChildProcess;
    termination?: ChildTerminationController;
    startedAt: number;
    cwd: string;
    objective: string;
    presentation: ManagedWindowPresentation;
    management: "monitor" | "delegation";
    ownerId?: string;
    ownerNonce?: string;
    pid?: number;
    launchError?: string;
  }

  const MAX_MANAGED_WINDOWS = 8;
  const MANAGED_WINDOW_HANDSHAKE_TIMEOUT_MS = 15_000;
  const MANAGED_WINDOW_HANDSHAKE_POLL_MS = 250;
  const managedWindows = new Map<string, ManagedWindow>();

  function managedWindowSessionName(name: string): string {
    const token = randomUUID().replace(/-/g, "");
    return `mw-${token}-${name.slice(0, 27)}`;
  }

  function managedWindowDelay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error("Managed window operation aborted."));
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new Error("Managed window operation aborted."));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function spawnManagedWindow(
    name: string,
    objective: string,
    cwdFallback: string,
    presentation: ManagedWindowPresentation = "headless",
    sessionName = name,
    forkSessionFile?: string,
    management: "monitor" | "delegation" = "monitor",
  ): Promise<{ ok: boolean; window?: ManagedWindow; error?: string }> {
    if (managedWindows.has(name)) return { ok: false, error: `window "${name}" is already spawned` };
    if (managedWindows.size >= MAX_MANAGED_WINDOWS) {
      return { ok: false, error: `managed window limit reached (${MAX_MANAGED_WINDOWS})` };
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
      return { ok: false, error: "window name must start alphanumeric and use [A-Za-z0-9._-]" };
    }
    if (!objective.trim()) return { ok: false, error: "window objective is required" };

    const cwd = monitorLedgerRoot ?? state.baseCwd ?? cwdFallback;
    const forkArgs = forkSessionFile ? ["--fork", forkSessionFile] : [];
    const piArgs = presentation === "interactive"
      ? [...forkArgs, "--name", sessionName, objective]
      : [...forkArgs, "-p", objective, "--name", sessionName];
    const piCommand = getPiSpawnCommand(piArgs);
    const launch = presentation === "interactive"
      ? getInteractiveTerminalLaunchSpec(piCommand, cwd, { title: `Pi worker · ${name}` })
      : { command: piCommand.command, args: piCommand.args, cwd };
    const child = crossSpawn(launch.command, launch.args, {
      cwd: launch.cwd,
      stdio: "ignore",
      shell: false,
      windowsHide: presentation === "interactive",
    });
    const window: ManagedWindow = {
      name,
      sessionName,
      child,
      ...(presentation === "headless" ? { termination: createChildTerminationController(child) } : {}),
      startedAt: Date.now(),
      cwd,
      objective,
      presentation,
      management,
    };
    managedWindows.set(name, window);

    const setup = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.once("exit", (code, signal) => {
      if (presentation === "headless") {
        window.termination?.cleanup();
        if (managedWindows.get(name) === window) managedWindows.delete(name);
      } else if (code !== 0 && managedWindows.get(name) === window && !window.ownerId) {
        window.launchError = `terminal launcher exited (code ${code ?? "?"}, signal ${signal ?? "none"})`;
      }
      console.error(`[pi-maestro-teammate] managed window ${name} launcher exited (code ${code ?? "?"}, signal ${signal ?? "none"})`);
    });

    try {
      await setup;
      return { ok: true, window };
    } catch (error) {
      window.termination?.cleanup();
      if (managedWindows.get(name) === window) managedWindows.delete(name);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  function captureManagedWindowOwner(
    window: ManagedWindow,
    owners: readonly WorkspaceOwnerSnapshot[],
  ): WorkspaceOwnerSnapshot | undefined {
    const candidates = owners.filter((owner) =>
      owner.pid !== process.pid && owner.sessionName === window.sessionName
    );
    if (candidates.length > 1) throw new Error(`multiple workspace windows registered as "${window.sessionName}"`);
    const owner = candidates[0];
    if (!owner) return undefined;
    if (window.ownerId && (
      window.ownerId !== owner.ownerId
      || window.ownerNonce !== owner.ownerNonce
      || window.pid !== owner.pid
    )) {
      throw new Error(`managed window "${window.name}" changed its authenticated owner identity`);
    }
    window.ownerId = owner.ownerId;
    window.ownerNonce = owner.ownerNonce;
    window.pid = owner.pid;
    return owner;
  }

  async function waitForManagedWindowOwner(
    window: ManagedWindow,
    signal: AbortSignal,
  ): Promise<WorkspaceOwnerSnapshot> {
    const deadline = Date.now() + MANAGED_WINDOW_HANDSHAKE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error("Managed window creation aborted while waiting for workspace registration.");
      const owners = await refreshWorkspacePeerOwnersStrict();
      if (managedWindows.get(window.name) !== window) throw new Error(`managed window "${window.name}" was replaced`);
      const owner = captureManagedWindowOwner(window, owners);
      if (owner) return owner;
      if (window.launchError) throw new Error(window.launchError);
      await managedWindowDelay(MANAGED_WINDOW_HANDSHAKE_POLL_MS, signal);
    }
    throw new Error(`window "${window.name}" did not register within ${MANAGED_WINDOW_HANDSHAKE_TIMEOUT_MS}ms`);
  }

  function exactManagedWindowOwner(window: ManagedWindow): WorkspaceOwnerSnapshot | undefined {
    if (!window.ownerId || !window.ownerNonce || !window.pid) return undefined;
    return workspacePeerOwners.find((owner) =>
      owner.ownerId === window.ownerId
      && owner.ownerNonce === window.ownerNonce
      && owner.pid === window.pid
      && owner.sessionName === window.sessionName
    );
  }

  async function terminateManagedWindowProcess(window: ManagedWindow): Promise<"stopped" | "already-exited"> {
    if (window.presentation === "headless") {
      const termination = window.termination;
      if (!termination) throw new Error(`Headless window "${window.name}" has no termination controller.`);
      termination.terminate();
      const outcome = await termination.outcome;
      termination.cleanup();
      if (outcome.status !== "reclaimed") {
        throw new Error(`Headless window "${window.name}" was not reclaimed (${outcome.reason}).`);
      }
      return outcome.forced ? "stopped" : "already-exited";
    }

    const owner = exactManagedWindowOwner(window);
    if (!owner) throw new Error(`Interactive window "${window.name}" has no fresh authenticated owner; ownership record retained.`);
    await terminateProcessTreeByPid(owner.pid);
    return "stopped";
  }

  function managedWindowPidIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  async function stopManagedWindow(name: string): Promise<{ ok: boolean; status?: string; error?: string }> {
    const window = managedWindows.get(name);
    if (!window) return { ok: false, error: `No managed window "${name}".` };

    try {
      if (window.presentation === "interactive") {
        const owners = await refreshWorkspacePeerOwnersStrict();
        if (managedWindows.get(name) !== window) throw new Error(`managed window "${name}" was replaced`);
        const owner = captureManagedWindowOwner(window, owners);
        if (!owner) {
          const exited = window.pid !== undefined && !managedWindowPidIsAlive(window.pid);
          if (window.launchError || exited) {
            if (window.ownerId) {
              await monitorControllerInstance.remove(`owner:${window.ownerId}`, "managed-window-gone");
              syncMonitorRegistryBindings();
            }
            if (managedWindows.get(name) === window) managedWindows.delete(name);
            return { ok: true, status: "already-exited" };
          }
          throw new Error(`Interactive window "${name}" has no fresh authenticated owner; ownership record retained for reconciliation.`);
        }
      }

      // Reclamation happens while the binding is still active. This avoids a
      // retained-but-unsupervised record if the exact-owner kill fails.
      const status = await terminateManagedWindowProcess(window);
      if (window.ownerId) {
        await monitorControllerInstance.remove(`owner:${window.ownerId}`, "managed-window-close");
        syncMonitorRegistryBindings();
      }
      if (managedWindows.get(name) === window) managedWindows.delete(name);
      return { ok: true, status };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function stopAllManagedWindows(): Promise<void> {
    const snapshot = [...managedWindows.values()];
    const hasInteractiveWindows = snapshot.some((window) => window.presentation === "interactive");
    let strictDiscoveryReady = !hasInteractiveWindows;
    if (hasInteractiveWindows) {
      try {
        await refreshWorkspacePeerOwnersStrict();
        strictDiscoveryReady = true;
      } catch (error) {
        console.error("[pi-maestro-teammate] managed-window shutdown discovery failed; interactive windows will not be killed from stale PID data:", error);
      }
    }

    await Promise.allSettled(snapshot.map(async (window) => {
      if (window.presentation === "interactive" && !strictDiscoveryReady) return;
      try {
        if (window.presentation === "interactive") {
          if (window.management === "delegation") {
            try {
              const record = await loadDelegationRecord(state.baseCwd || window.cwd, window.name);
              const owner = delegationOwnerCandidate(record, workspacePeerOwners);
              if (!owner) return;
              window.ownerId = owner.ownerId;
              window.ownerNonce = owner.ownerNonce;
              window.pid = owner.pid;
            } catch (error) {
              console.error(`[pi-maestro-teammate] failed to reconcile delegation ${window.name} before shutdown:`, error);
              if (!exactManagedWindowOwner(window)) return;
            }
          } else if (!exactManagedWindowOwner(window)) {
            return;
          }
        }
        await terminateManagedWindowProcess(window);
        await closeDelegationRecordAfterTermination(window);
        if (managedWindows.get(window.name) === window) managedWindows.delete(window.name);
      } catch (error) {
        console.error(`[pi-maestro-teammate] managed window ${window.name} was not reclaimed during shutdown:`, error);
      }
    }));
  }

  function delegationWorkspaceRoot(ctx: ExtensionCommandContext): string {
    return state.baseCwd || ctx.cwd;
  }

  function canonicalDelegationForkSource(
    source: DelegationSourceContext,
    ctx: ExtensionCommandContext,
    expectedGeneration = state.sessionGeneration,
  ): string {
    if (state.sessionGeneration !== expectedGeneration
      || state.currentSessionId !== ctx.sessionManager.getSessionId()) {
      throw new Error("Current Pi session changed during delegation setup.");
    }
    if (source.workspaceId !== workspaceIdForCwd(ctx.cwd)) {
      throw new Error("Delegation source belongs to a different workspace.");
    }
    const currentSessionFile = ctx.sessionManager.getSessionFile();
    if (!currentSessionFile) throw new Error("Current Pi session file is unavailable.");
    try {
      if (!lstatSync(source.sessionFile).isFile() || lstatSync(source.sessionFile).isSymbolicLink()) {
        throw new Error("Delegation source must be a regular non-symlink session file.");
      }
      const currentCanonical = realpathSync(currentSessionFile);
      const sourceCanonical = realpathSync(source.sessionFile);
      if (!isSessionPathContained(dirname(currentCanonical), sourceCanonical)) {
        throw new Error("Delegation fork source is not contained in the current workspace session directory.");
      }
      return sourceCanonical;
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  function delegationSourceContext(ctx: ExtensionCommandContext): DelegationSourceContext {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile || !existsSync(sessionFile)) {
      throw new Error("Current Pi session file is unavailable; delegation cannot fork this state.");
    }
    const source: DelegationSourceContext = {
      cwd: delegationWorkspaceRoot(ctx),
      workspaceId: workspaceIdForCwd(ctx.cwd),
      sessionId: ctx.sessionManager.getSessionId(),
      sessionName: ctx.sessionManager.getSessionName?.() ?? undefined,
      sessionFile,
    };
    return { ...source, sessionFile: canonicalDelegationForkSource(source, ctx) };
  }

  function delegationPlannerFailure(result: SingleResult): string {
    const finalMessage = result.messages.at(-1)?.content?.trim();
    return finalMessage || `planner exited with code ${result.exitCode}`;
  }

  function delegationProgressTokens(tokens: number): string {
    return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}k tok` : `${tokens} tok`;
  }

  function delegationPlannerProgressText(
    progress: AgentProgress,
    workerContext: DelegationWorkerContext,
  ): string {
    const phase = progress.phase ?? progress.status;
    const elapsed = `${Math.max(0, Math.floor(progress.durationMs / 1_000))}s`;
    const recentTool = progress.recentTools.at(-1);
    return [
      "delegate planner",
      `target:${workerContext}`,
      phase,
      elapsed,
      `${progress.toolCount} tool${progress.toolCount === 1 ? "" : "s"}`,
      delegationProgressTokens(progress.tokens),
      ...(recentTool ? [`${recentTool.name}:${recentTool.status}`] : []),
    ].join(" | ");
  }

  async function selectDelegationWorkerContext(
    ctx: ExtensionCommandContext,
  ): Promise<DelegationWorkerContext | undefined> {
    const freshOption = "New session (fresh) - task document supplies context";
    const forkOption = "Fork current session - worker inherits the source conversation";
    preemptCockpitResize();
    const selected = await ctx.ui.select(
      "Delegation worker context",
      [freshOption, forkOption],
    );
    if (selected === freshOption) return "fresh";
    if (selected === forkOption) return "fork";
    return undefined;
  }

  async function draftDelegation(
    request: string,
    workerContext: DelegationWorkerContext,
    ctx: ExtensionCommandContext,
  ): Promise<DelegationRecord> {
    const root = delegationWorkspaceRoot(ctx);
    const generation = state.sessionGeneration;
    const source = delegationSourceContext(ctx);
    const progressKey = "teammate-delegate-planner";
    const startedAt = Date.now();
    let lastProgressAt = 0;
    ctx.ui.setStatus(progressKey, `delegate planner | target:${workerContext} | preparing fork | 0s`);
    try {
      const forkSessionFile = canonicalDelegationForkSource(source, ctx, generation);
      ctx.ui.setStatus(progressKey, `delegate planner | target:${workerContext} | starting | 0s`);
      const result = await runSingleTeammate(
        {
          agent: "planner",
          taskType: "planning",
          task: buildDelegationPlannerPrompt(request, source, workerContext),
          context: "fork",
          thinking: "high",
          timeoutMs: 120_000,
          outputSchema: DELEGATION_TASK_SCHEMA,
        },
        {
          baseCwd: root,
          depth: 0,
          parentSessionFile: forkSessionFile,
          onProgress(progress) {
            const now = Date.now();
            if (now - lastProgressAt < 250 && progress.status === "running") return;
            lastProgressAt = now;
            ctx.ui.setStatus(progressKey, delegationPlannerProgressText(progress, workerContext));
          },
        },
      );
      if (result.exitCode !== 0 || result.structuredOutput === undefined) {
        throw new Error(`Delegation planner failed: ${delegationPlannerFailure(result)}`);
      }
      ctx.ui.setStatus(
        progressKey,
        `delegate planner | target:${workerContext} | validating output | ${Math.max(0, Math.floor((Date.now() - startedAt) / 1_000))}s`,
      );
      const task = parseDelegationTaskDraft(result.structuredOutput);
      ctx.ui.setStatus(
        progressKey,
        `delegate planner | target:${workerContext} | saving draft | ${Math.max(0, Math.floor((Date.now() - startedAt) / 1_000))}s`,
      );
      return await createDelegationDraft(root, {
        request,
        workerContext,
        source: { ...source, sessionFile: forkSessionFile },
        task,
        planner: {
          agent: "planner",
          correlationId: result.correlationId,
          model: result.model,
          durationMs: result.durationMs,
        },
      });
    } finally {
      ctx.ui.setStatus(progressKey, undefined);
    }
  }

  async function confirmDelegationSend(record: DelegationRecord, ctx: ExtensionCommandContext): Promise<string | undefined> {
    const root = delegationWorkspaceRoot(ctx);
    const document = await readDelegationDocument(root, record.id);
    const preview = document.length > 3_200
      ? `${document.slice(0, 3_200)}\n\n[Preview truncated; full document: ${delegationDocumentPath(root, record.id)}]`
      : document;
    preemptCockpitResize();
    const targetDescription = record.workerContext === "fork"
      ? `fork source session ${record.source.sessionName ?? record.source.sessionId}`
      : "start a fresh session";
    const confirmed = await ctx.ui.confirm(
      `Send delegation ${record.id}?`,
      `${preview}\nThe interactive worker will ${targetDescription} and receive this document.`,
    );
    return confirmed ? document : undefined;
  }

  async function rollbackDelegationWindow(
    record: DelegationRecord,
    root: string,
    failure: string,
  ): Promise<string> {
    const cleanup = await stopManagedWindow(record.id);
    const cleanupText = cleanup.ok
      ? `setup rolled back (${cleanup.status ?? "stopped"})`
      : `window ownership retained: ${cleanup.error ?? "reclamation not proven"}`;
    await updateDelegationRecord(root, record.id, (current) => cleanup.ok ? {
      ...current,
      status: "confirmed",
      launch: undefined,
      window: undefined,
      dispatchMessageId: undefined,
      updatedAt: Date.now(),
      lastError: failure,
    } : {
      ...current,
      updatedAt: Date.now(),
      lastError: `${failure}; ${cleanupText}`,
    }, {
      expectedRevision: record.revision,
      expectedStatuses: [record.status],
    }).catch((recordError) => {
      console.error("[pi-maestro-teammate] failed to persist delegation rollback:", recordError);
    });
    return cleanupText;
  }

  async function reconcileDelegationDelivery(record: DelegationRecord, root: string): Promise<DelegationRecord> {
    if ((record.status !== "dispatching" && record.status !== "delivery_unknown")
      || !record.dispatchMessageId || !record.window) return record;
    const outgoing = sessionHostRegistry?.thread.get(record.dispatchMessageId, "outgoing");
    if (!outgoing) return record;
    if (["queued", "injected", "accepted"].includes(outgoing.status)) {
      const sentAt = Math.max(outgoing.updatedAt, Date.now());
      return updateDelegationRecord(root, record.id, (current) => ({
        ...current,
        status: "sent",
        updatedAt: sentAt,
        lastError: undefined,
        window: { ...current.window!, sentAt },
      }), {
        expectedRevision: record.revision,
        expectedStatuses: [record.status],
      });
    }
    if (record.status === "dispatching" && outgoing.status === "timeout") {
      return updateDelegationRecord(root, record.id, (current) => ({
        ...current,
        status: "delivery_unknown",
        updatedAt: Math.max(current.updatedAt, outgoing.updatedAt),
        lastError: "Delegation delivery timed out after publication; do not resend until manually reconciled.",
      }), {
        expectedRevision: record.revision,
        expectedStatuses: ["dispatching"],
      });
    }
    return record;
  }

  async function dispatchDelegation(
    initialRecord: DelegationRecord,
    confirmedDocument: string,
    ctx: ExtensionCommandContext,
  ): Promise<{ record: DelegationRecord; owner: WorkspaceOwnerSnapshot; deliveryStage?: string }> {
    const root = delegationWorkspaceRoot(ctx);
    if (initialRecord.status !== "draft" && initialRecord.status !== "confirmed") {
      throw new Error(`Delegation ${initialRecord.id} is ${initialRecord.status} and cannot be sent.`);
    }
    const generation = state.sessionGeneration;
    if (initialRecord.source.workspaceId !== workspaceIdForCwd(ctx.cwd)) {
      throw new Error("Delegation source belongs to a different workspace.");
    }
    if (initialRecord.workerContext === "fork") {
      canonicalDelegationForkSource(initialRecord.source, ctx, generation);
    }
    await workspacePeerLifecycle;
    const publisher = workspacePeerPublisher;
    if (!publisher) throw new Error("Workspace peer delivery is unavailable.");
    const replyTo = `owner:${publisher.identity.ownerId}`;
    const confirmedAt = initialRecord.confirmedAt ?? Date.now();
    const confirmed = await updateDelegationRecord(root, initialRecord.id, (record) => ({
      ...record,
      status: "confirmed",
      confirmedAt,
      updatedAt: Date.now(),
      lastError: undefined,
    }), {
      expectedRevision: initialRecord.revision,
      expectedStatuses: [initialRecord.status],
    });
    const sessionName = managedWindowSessionName(confirmed.id);
    const startedAt = Date.now();
    const spawning = await updateDelegationRecord(root, confirmed.id, (record) => ({
      ...record,
      status: "spawning",
      updatedAt: startedAt,
      launch: {
        name: confirmed.id,
        sessionName,
        presentation: "interactive",
        startedAt,
      },
    }), {
      expectedRevision: confirmed.revision,
      expectedStatuses: ["confirmed"],
    });

    let workerForkSessionFile: string | undefined;
    if (spawning.workerContext === "fork") {
      try {
        workerForkSessionFile = canonicalDelegationForkSource(spawning.source, ctx, generation);
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        await updateDelegationRecord(root, spawning.id, (record) => ({
          ...record,
          status: "confirmed",
          launch: undefined,
          updatedAt: Date.now(),
          lastError: failure,
        }), { expectedRevision: spawning.revision, expectedStatuses: ["spawning"] });
        throw error;
      }
    }

    const spawned = await spawnManagedWindow(
      spawning.id,
      buildDelegatedWorkerBootstrap(spawning, replyTo),
      root,
      "interactive",
      sessionName,
      workerForkSessionFile,
      "delegation",
    );
    if (!spawned.ok || !spawned.window) {
      const message = spawned.error ?? `Failed to create delegation window ${spawning.id}.`;
      await updateDelegationRecord(root, spawning.id, (record) => ({
        ...record,
        status: "confirmed",
        launch: undefined,
        updatedAt: Date.now(),
        lastError: message,
      }), { expectedRevision: spawning.revision, expectedStatuses: ["spawning"] });
      throw new Error(message);
    }

    let owner: WorkspaceOwnerSnapshot;
    try {
      owner = await waitForManagedWindowOwner(spawned.window, new AbortController().signal);
      if (managedWindows.get(spawning.id) !== spawned.window || !exactManagedWindowOwner(spawned.window)) {
        throw new Error(`Delegation window ${spawning.id} changed owner before task delivery.`);
      }
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      const cleanupText = await rollbackDelegationWindow(spawning, root, failure);
      throw new Error(`${failure}; ${cleanupText}.`);
    }

    const registeredAt = Date.now();
    const dispatchMessageId = randomUUID().replace(/-/g, "");
    let dispatching: DelegationRecord;
    try {
      dispatching = await updateDelegationRecord(root, spawning.id, (record) => ({
        ...record,
        status: "dispatching",
        updatedAt: registeredAt,
        dispatchMessageId,
        window: {
          name: spawning.id,
          sessionName,
          ownerId: owner.ownerId,
          ownerNonce: owner.ownerNonce,
          pid: owner.pid,
          presentation: "interactive",
          registeredAt,
        },
      }), {
        expectedRevision: spawning.revision,
        expectedStatuses: ["spawning"],
      });
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      const cleanupText = await rollbackDelegationWindow(spawning, root, failure);
      throw new Error(`${failure}; ${cleanupText}.`);
    }

    const delivery = await routeSessionMessage({
      selector: `owner:${owner.ownerId}`,
      message: buildDelegationDelivery(dispatching, confirmedDocument, replyTo),
      mode: "follow_up",
      messageId: dispatchMessageId,
      source: "user",
      messageKind: "request",
      traceId: dispatching.id,
      replyTo,
      fromSessionName: workspacePeerSessionName,
    });
    const accepted = delivery.delivered || delivery.receipt?.publicationStage === "accepted";
    if (!accepted) {
      const outgoing = sessionHostRegistry?.thread.get(dispatchMessageId, "outgoing");
      const failure = delivery.error ?? "Delegation document was not delivered.";
      const publishedWithoutRejection = delivery.receipt?.publicationStage === "published"
        || (outgoing !== undefined && outgoing.status !== "rejected");
      if (publishedWithoutRejection) {
        await updateDelegationRecord(root, dispatching.id, (record) => ({
          ...record,
          status: "delivery_unknown",
          updatedAt: Math.max(record.updatedAt, outgoing?.updatedAt ?? Date.now()),
          lastError: `${failure} The command was published; do not resend it.`,
        }), {
          expectedRevision: dispatching.revision,
          expectedStatuses: ["dispatching"],
        });
        throw new Error(`${failure} Delivery is unknown; the task is not resendable. Use /delegate list or /delegate stop ${dispatching.id}.`);
      }
      const cleanupText = await rollbackDelegationWindow(dispatching, root, failure);
      throw new Error(`${failure}; ${cleanupText}.`);
    }

    const sentAt = Date.now();
    try {
      const record = await updateDelegationRecord(root, dispatching.id, (current) => ({
        ...current,
        status: "sent",
        updatedAt: sentAt,
        lastError: undefined,
        window: { ...current.window!, sentAt },
      }), {
        expectedRevision: dispatching.revision,
        expectedStatuses: ["dispatching"],
      });
      return { record, owner, deliveryStage: delivery.receipt?.deliveryStage };
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      throw new Error(`${failure} The task was delivered to owner:${owner.ownerId} with message ${dispatchMessageId}; do not resend it.`);
    }
  }

  function delegationOwnerCandidate(
    record: DelegationRecord,
    owners: readonly WorkspaceOwnerSnapshot[],
  ): WorkspaceOwnerSnapshot | undefined {
    const launch = record.launch;
    if (!launch) return undefined;
    const exact = record.window && owners.find((owner) =>
      owner.ownerId === record.window!.ownerId
      && owner.ownerNonce === record.window!.ownerNonce
      && owner.pid === record.window!.pid
      && owner.sessionName === launch.sessionName
    );
    if (exact) return exact;
    const candidates = owners.filter((owner) =>
      owner.sessionName === launch.sessionName
      && (!record.window || owner.pid === record.window.pid)
    );
    if (candidates.length > 1) throw new Error(`Multiple owners match delegation window ${record.id}.`);
    return candidates[0];
  }

  async function stopDelegationWindow(
    initialRecord: DelegationRecord,
    root: string,
  ): Promise<{ status: string; record: DelegationRecord }> {
    let record = initialRecord;
    if (!["spawning", "dispatching", "delivery_unknown", "sent"].includes(record.status)) {
      throw new Error(`Delegation ${record.id} is ${record.status} and has no active managed window.`);
    }
    const owners = await refreshWorkspacePeerOwnersStrict();
    const owner = delegationOwnerCandidate(record, owners);
    if (owner && (!record.window
      || record.window.ownerId !== owner.ownerId
      || record.window.ownerNonce !== owner.ownerNonce)) {
      const reboundAt = Date.now();
      record = await updateDelegationRecord(root, record.id, (current) => ({
        ...current,
        updatedAt: reboundAt,
        window: {
          name: current.launch!.name,
          sessionName: current.launch!.sessionName,
          ownerId: owner.ownerId,
          ownerNonce: owner.ownerNonce,
          pid: owner.pid,
          presentation: "interactive",
          registeredAt: current.window?.registeredAt ?? reboundAt,
          ...(current.window?.sentAt === undefined ? {} : { sentAt: current.window.sentAt }),
        },
      }), {
        expectedRevision: record.revision,
        expectedStatuses: [record.status],
      });
      const tracked = managedWindows.get(record.id);
      if (tracked && tracked.sessionName === owner.sessionName && tracked.pid === owner.pid) {
        tracked.ownerId = owner.ownerId;
        tracked.ownerNonce = owner.ownerNonce;
      }
    }

    let status: string;
    if (managedWindows.has(record.id)) {
      const stopped = await stopManagedWindow(record.id);
      if (!stopped.ok) throw new Error(stopped.error ?? `Failed to stop ${record.id}.`);
      status = stopped.status ?? "stopped";
    } else if (owner) {
      await terminateProcessTreeByPid(owner.pid);
      try {
        await monitorControllerInstance.remove(`owner:${owner.ownerId}`, "delegation-window-close");
        syncMonitorRegistryBindings();
      } catch (error) {
        console.error("[pi-maestro-teammate] delegated window monitor cleanup failed:", error);
      }
      status = "stopped";
    } else if (record.window && !managedWindowPidIsAlive(record.window.pid)) {
      status = "already-exited";
    } else {
      throw new Error(`Delegation window ${record.id} has no fresh authenticated owner; refusing stale process termination.`);
    }

    const closedAt = Date.now();
    const closed = await updateDelegationRecord(root, record.id, (current) => ({
      ...current,
      status: "closed",
      closedAt,
      updatedAt: closedAt,
      lastError: undefined,
    }), {
      expectedRevision: record.revision,
      expectedStatuses: [record.status],
    });
    return { status, record: closed };
  }

  async function closeDelegationRecordAfterTermination(window: ManagedWindow): Promise<void> {
    if (window.management !== "delegation") return;
    const root = state.baseCwd || window.cwd;
    try {
      await updateDelegationRecord(root, window.name, (record) => {
        if (!["spawning", "dispatching", "delivery_unknown", "sent"].includes(record.status)) return record;
        const closedAt = Date.now();
        return {
          ...record,
          status: "closed",
          closedAt,
          updatedAt: closedAt,
          lastError: undefined,
        };
      });
    } catch (error) {
      console.error(`[pi-maestro-teammate] failed to close delegation record ${window.name}:`, error);
    }
  }

  /** Load `.pi/settings.json` → `monitor` section, merged with env. */
  function loadMonitorConfigForRoot(root: string): MonitorEngineConfig {
    let section: unknown;
    try {
      const settingsPath = join(root, ".pi", "settings.json");
      if (existsSync(settingsPath)) {
        const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { monitor?: unknown };
        section = parsed?.monitor;
      }
    } catch (error) {
      console.error("[pi-maestro-teammate] failed to read monitor settings:", error);
    }
    return normalizeMonitorConfig(section);
  }

  /** Refresh the in-memory ledger read-model (best-effort). */
  async function refreshMonitorLedgerState(): Promise<void> {
    const root = monitorLedgerRoot;
    if (!root || !monitorConfig.ledgerEnabled) {
      monitorLedgerState = undefined;
      return;
    }
    try {
      const loaded = await loadMonitorLedger(root);
      monitorLedgerWarnings = loaded.warnings;
      monitorLedgerState = deriveMonitorLedgerState(loaded.records);
    } catch (error) {
      console.error("[pi-maestro-teammate] monitor ledger load failed:", error);
    }
  }

  /**
   * Session-start reconciliation: restore active ledger bindings when
   * autoResume is enabled, then mark ledger-active bindings without a live
   * in-process owner as disconnected (pi-peer reconcile semantics).
   */
  async function reconcileMonitorLedgerAtStart(ctx: ExtensionContext): Promise<void> {
    const root = monitorLedgerRoot;
    if (!root) return;
    try {
      const loaded = await loadMonitorLedger(root);
      const state = deriveMonitorLedgerState(loaded.records);
      if (state.activeBindings.length === 0) {
        monitorLedgerWarnings = loaded.warnings;
        return;
      }
      if (monitorConfig.autoResume) {
        const restored = await resumeMonitorBindings(ctx);
        if (restored > 0) monitorRegistry.setViewMode("windows");
      }
      const live = new Set([...monitorEngine.bindings.keys()]);
      const reconciled = await reconcileMonitorLedger(root, { liveTargets: [...live], nowMs: Date.now() });
      if (reconciled.records.length > 0 || reconciled.warnings.length > 0) {
        monitorLedgerWarnings = reconciled.warnings;
        await refreshMonitorLedgerState();
      }
    } catch (error) {
      console.error("[pi-maestro-teammate] monitor ledger reconcile failed:", error);
    }
  }

  /**
   * Restore active bindings from the durable ledger (auto-resume / /monitor
   * resume). Returns the number of restored bindings.
   */
  async function resumeMonitorBindings(_ctx: ExtensionContext): Promise<number> {
    const root = monitorLedgerRoot;
    if (!root || !monitorConfig.ledgerEnabled) return 0;
    let loaded;
    try {
      loaded = await loadMonitorLedger(root);
    } catch (error) {
      console.error("[pi-maestro-teammate] monitor ledger load failed:", error);
      return 0;
    }
    await refreshWorkspacePeerOwners();
    refreshSessionEndpointDirectory(true);
    const ledgerState = deriveMonitorLedgerState(loaded.records);
    const requests: MonitorControllerBindingRequest[] = [];
    for (const binding of ledgerState.activeBindings) {
      if (!binding.target.startsWith("owner:") || monitorEngine.bindings.has(binding.target)) continue;
      const ownerId = binding.target.slice("owner:".length);
      const owner = workspacePeerOwners.find((candidate) => candidate.ownerId === ownerId);
      if (!owner) {
        console.error(`[pi-maestro-teammate] monitor resume skipped ${binding.target}: window not found`);
        continue;
      }
      const request = monitorBindingRequest(
        owner,
        binding.mode === "custom" ? "custom" : "auto",
        binding.customPrompt,
        { ...(binding.goalId ? { goalId: binding.goalId } : {}), resumed: true },
      );
      if (request) requests.push(request);
    }
    const result = await monitorControllerInstance.bind(requests);
    syncMonitorRegistryBindings();
    for (const failure of result.errors) {
      console.error(`[pi-maestro-teammate] monitor resume skipped ${failure.key}: ${failure.error}`);
    }
    return result.bound.length;
  }

  /** Resolve a single target name into a compact MonitorTargetSnapshot. */
  function resolveMonitorTarget(name: string, lines: number, verbose?: boolean): MonitorTargetSnapshot {
    const resolved = resolveWatchTarget(state, name);
    if (!resolved.match) {
      const settledRecord = findSettledAgent(state, name);
      if (settledRecord) {
        const agoSeconds = Math.round((Date.now() - settledRecord.settledAt) / 1000);
        const firstLine = settledRecord.lastResult ? settledRecord.lastResult.split("\n")[0] : "";
        return {
          name: settledRecord.name ?? name,
          found: true,
          agentStatus: settledRecord.status,
          waitStatus: settledRecord.status,
          idleSeconds: agoSeconds,
          summary: firstLine.slice(0, 80),
        };
      }
      return {
        name,
        found: false,
        error: resolved.error ?? `not found.${resolved.available.length ? ` Available: ${resolved.available.join(", ")}` : ""}`,
        summary: "",
      };
    }
    const target = resolved.match;
    const agent = target.agent;
    const label = target.kind === "agent"
      ? (agent.name ?? agent.correlationId.slice(0, 8))
      : (target.progress.name ?? target.progress.correlationId.slice(0, 8));
    const agentStatus = target.kind === "agent" ? agent.status : target.progress.status;
    const lastActivityAt = target.kind === "agent" ? agent.lastActivityAt : (target.progress.lastActivityAt ?? agent.lastActivityAt);
    const idleSeconds = Math.round((Date.now() - lastActivityAt) / 1000);
    const watchOutput = buildWatchOutput(target, lines);
    const waitStatus = statusForWatchTarget(target, Date.now(), state);
    // Compact summary: last meaningful output line
    const logLines = watchOutput.slice(2);
    const summary = logLines.length > 0 ? logLines[logLines.length - 1].slice(0, 80) : "";
    return {
      name: label,
      found: true,
      agentStatus,
      waitStatus,
      idleSeconds,
      summary,
      detail: verbose ? logLines : undefined,
    };
  }

  const teammateObservationCapabilities = {
    inspect: true,
    wait: true,
    cancel: true,
    message: true,
    supervise: true,
  } as const;

  async function teammateSnapshot(id: string, options: ObservationReadOptions): Promise<ObservationSnapshot> {
    if (options.view === "turns") return teammateTurnsSnapshot(id, options);
    const detail = options.detail;
    const lines = options.lines;
    const monitored = resolveMonitorTarget(id, lines, detail !== "summary");
    if (!monitored.found) {
      return {
        target: { kind: "teammate", id },
        found: false,
        nativeStatus: "not-found",
        phase: "unknown",
        outcome: "failure",
        waitStatus: "not-found",
        summary: monitored.error ?? `Agent "${id}" not found.`,
        updatedAt: Date.now(),
        capabilities: teammateObservationCapabilities,
        error: monitored.error,
      };
    }
    const resolved = resolveWatchTarget(state, id);
    const output = resolved.match
      ? buildWatchOutput(resolved.match, lines)
      : monitored.summary ? [monitored.summary] : [];
    const nativeStatus = monitored.agentStatus ?? monitored.waitStatus ?? "unknown";
    const settled = nativeStatus === "completed"
      || nativeStatus === "failed"
      || nativeStatus === "terminated"
      || nativeStatus === "sleeping";
    // Runtime activity (nativeStatus) and terminal outcome are separate
    // dimensions: a wakeable agent sleeps after a *failed* run too. Prefer the
    // retained terminal outcome for outcome/terminalStatus so a failed run is
    // never masked as success by its sleeping activity state.
    const liveAgent = resolved.match?.kind === "agent" ? resolved.match.agent : undefined;
    const settledRecord = resolved.match ? undefined : findSettledAgent(state, id);
    const terminal = monitored.waitStatus
      ?? liveAgent?.lastOutcome?.status
      ?? settledRecord?.status;
    const outcome = terminal === "failed"
      ? "failure" as const
      : terminal === "terminated" ? "aborted" as const
        : terminal === "completed" || terminal === "result-ready" ? "success" as const
          : settled ? "success" as const
            : undefined;
    const includeResult = detail !== "summary";
    const structuredOutput = liveAgent?.structuredOutput !== undefined
      ? liveAgent.structuredOutput
      : settledRecord?.structuredOutput;
    const lastResult = liveAgent?.lastResult ?? settledRecord?.lastResult;
    return {
      target: { kind: "teammate", id },
      found: true,
      nativeStatus,
      phase: settled ? "settled" : nativeStatus === "pending" ? "pending" : "active",
      ...(outcome ? { outcome } : {}),
      ...(monitored.waitStatus ? { waitStatus: monitored.waitStatus as ObservationWaitStatus } : {}),
      ...(terminal ? { terminalStatus: terminal as string } : {}),
      ...(includeResult && lastResult ? { lastResult } : {}),
      ...(includeResult && structuredOutput !== undefined
        ? { structuredOutput: structuredClone(structuredOutput) }
        : {}),
      summary: monitored.summary || output.at(-1) || nativeStatus,
      ...(includeResult ? { detail: output } : {}),
      updatedAt: Date.now(),
      capabilities: teammateObservationCapabilities,
    };
  }

  /** One transcript row → one flat text line for observe view="turns". */
  function formatTurnRow(row: TranscriptRow): string {
    const text = row.text.replace(/\r?\n/g, " ");
    switch (row.kind) {
      case "user": return `[user] ${text}`;
      case "assistant": return `[assistant] ${text}`;
      case "thinking": return `[thinking] ${text}`;
      case "tool": return `[tool] ${row.toolName ?? "?"} ${text.slice(0, 200)}`;
      case "tool_result": return `[result]${row.isError ? " !" : ""} ${row.toolName ?? ""} ${text.slice(0, 300)}`;
      case "meta": return `[meta] ${text}`;
      default: return `[${row.role}] ${text}`;
    }
  }

  async function teammateTurnsSnapshot(
    id: string,
    options: ObservationReadOptions,
  ): Promise<ObservationSnapshot> {
    const monitored = resolveMonitorTarget(id, options.lines, options.detail !== "summary");
    const resolved = resolveWatchTarget(state, id);
    const liveAgent = resolved.match?.kind === "agent" ? resolved.match.agent : undefined;
    const settledRecord = resolved.match ? undefined : findSettledAgent(state, id);
    const agent = liveAgent ?? settledRecord;
    if (!agent && !monitored.found) {
      return {
        target: { kind: "teammate", id },
        found: false,
        nativeStatus: "not-found",
        phase: "unknown",
        outcome: "failure",
        waitStatus: "not-found",
        summary: monitored.error ?? `Agent "${id}" not found.`,
        updatedAt: Date.now(),
        capabilities: teammateObservationCapabilities,
        error: monitored.error,
      };
    }
    const load = await loadTranscript({
      correlationId: agent?.correlationId ?? id,
      sessionFile: liveAgent?.sessionFile,
      parentSessionFile: state.mainSessionFile ?? undefined,
      lastResult: agent?.lastResult,
      outputLog: liveAgent?.outputLog,
    });
    const turns = groupTranscriptTurns(load.rows);
    const nativeStatus = monitored.agentStatus ?? monitored.waitStatus ?? agent?.status ?? "unknown";
    const settled = nativeStatus === "completed"
      || nativeStatus === "failed"
      || nativeStatus === "terminated"
      || nativeStatus === "sleeping";
    if (options.turn !== undefined) {
      const turn = turns.find((candidate) => candidate.index === options.turn);
      if (!turn) {
        return {
          target: { kind: "teammate", id },
          found: true,
          nativeStatus,
          phase: settled ? "settled" : "active",
          summary: `Turn ${options.turn} not found (${turns.length} turn${turns.length === 1 ? "" : "s"}).`,
          detail: turns.map((candidate) =>
            `Turn ${candidate.index} · ${candidate.userText.slice(0, 60)} · ${candidate.rowCount} rows`
          ),
          updatedAt: Date.now(),
          capabilities: teammateObservationCapabilities,
        };
      }
      return {
        target: { kind: "teammate", id },
        found: true,
        nativeStatus,
        phase: settled ? "settled" : "active",
        summary: `Turn ${turn.index} · ${turn.userText.slice(0, 60)} · ${turn.rowCount} rows · ${turn.toolCallCount} tools`,
        detail: turn.rows.map(formatTurnRow),
        updatedAt: Date.now(),
        capabilities: teammateObservationCapabilities,
      };
    }
    const listLines = turns.length === 0
      ? ["No session turns recorded."]
      : turns.map((turn) => {
          const tools = turn.toolCallCount > 0 ? ` · ${turn.toolCallCount} tools` : "";
          const chars = turn.textLength > 0 ? ` · ${turn.textLength} chars` : "";
          return `Turn ${turn.index} · ${turn.userText.slice(0, 60)} · ${turn.rowCount} rows${tools}${chars}`;
        });
    return {
      target: { kind: "teammate", id },
      found: true,
      nativeStatus,
      phase: settled ? "settled" : "active",
      summary: `${turns.length} turn${turns.length === 1 ? "" : "s"}${load.source === "memory" ? " · memory fallback" : ""}`,
      detail: listLines,
      updatedAt: Date.now(),
      capabilities: teammateObservationCapabilities,
    };
  }

  function teammateWaitObservation(
    id: string,
    result: TeammateWaitResult,
    detail: "summary" | "tail" | "full",
  ): ObservationSnapshot {
    const waitStatus: ObservationWaitStatus = result.status === "delayed"
      ? "completed"
      : result.status;
    const phase = waitStatus === "completed"
      || waitStatus === "failed"
      || waitStatus === "terminated"
      || waitStatus === "result-ready"
      ? "settled"
      : waitStatus === "not-found" ? "unknown" : "active";
    const outcome = waitStatus === "completed" || waitStatus === "result-ready"
      ? "success"
      : waitStatus === "stalled" ? "stalled"
        : waitStatus === "aborted" || waitStatus === "terminated" ? "aborted"
          : "failure";
    const resolved = resolveWatchTarget(state, id);
    const liveAgent = resolved.match?.kind === "agent" ? resolved.match.agent : undefined;
    const settledRecord = resolved.match ? undefined : findSettledAgent(state, id);
    const includeResult = detail !== "summary";
    const structuredOutput = liveAgent?.structuredOutput !== undefined
      ? liveAgent.structuredOutput
      : settledRecord?.structuredOutput;
    const lastResult = liveAgent?.lastResult ?? settledRecord?.lastResult;
    return {
      target: { kind: "teammate", id },
      found: waitStatus !== "not-found",
      nativeStatus: result.status,
      phase,
      outcome,
      waitStatus,
      ...(waitStatus !== "not-found" ? { terminalStatus: waitStatus as string } : {}),
      ...(includeResult && lastResult ? { lastResult } : {}),
      ...(includeResult && structuredOutput !== undefined
        ? { structuredOutput: structuredClone(structuredOutput) }
        : {}),
      summary: result.output[0] ?? result.status,
      ...(includeResult ? { detail: result.output } : {}),
      updatedAt: Date.now(),
      capabilities: teammateObservationCapabilities,
      ...(waitStatus === "not-found" ? { error: result.output[0] } : {}),
    };
  }

  const teammateObservationProvider: ObservationProvider = {
    kind: "teammate",
    capabilities: teammateObservationCapabilities,
    snapshot: (id, options) => teammateSnapshot(id, options),
    wait: async (id, options) => teammateWaitObservation(id, await waitForTeammate(state, {
      name: id,
      timeoutMs: Math.max(1, options.deadline - Date.now()),
      until: options.until,
    }, options.signal), options.detail),
  };
  registerObservationProvider(teammateObservationProvider);

  const workspaceObservationSnapshot = async (
    id: string,
    detail: "summary" | "tail" | "full",
    lines: number,
    options: ObservationReadOptions = { detail, lines },
  ): Promise<ObservationSnapshot> => {
    await refreshWorkspacePeerOwners();
    const ownerId = id.startsWith("owner:") ? id.slice("owner:".length) : id;
    let owner = workspacePeerOwners.find((candidate) => candidate.ownerId === ownerId);
    if (!owner) owner = resolveWorkspaceOwnerByName(workspacePeerOwners, id);
    const target = { kind: "workspace", id };
    if (!owner) {
      return {
        target,
        found: false,
        nativeStatus: "not-found",
        phase: "unknown",
        outcome: "failure",
        summary: `Workspace window ${id} is unavailable.`,
        updatedAt: Date.now(),
        error: "owner-unavailable",
      };
    }
    if (options.view === "turns") return workspaceTurnsSnapshot(owner, target, detail, lines, options);
    const backgroundJobs = owner.backgroundJobs ?? [];
    const foregroundJobs = backgroundJobs.filter((job) => !job.background);
    const activeStatus = windowRowStatus([
      ...owner.agents.map((agent) => agent.status),
      ...backgroundJobs.map(() => "running"),
    ]);
    const output = [
      `${owner.sessionName ?? `window:${owner.ownerId.slice(0, 8)}`} · ${activeStatus} · ${owner.agents.length} agents`
        + ` · ${backgroundJobs.length} bash_bg${foregroundJobs.length ? ` (${foregroundJobs.length} foreground)` : ""}`,
      ...owner.agents.map((agent) => {
        const idle = Math.max(0, Math.round((Date.now() - agent.lastActivityAt) / 1000));
        return `@${agent.name ?? agent.correlationId.slice(0, 8)} ${agent.status} · idle ${idle}s${agent.summary ? ` · ${agent.summary}` : ""}`;
      }),
      ...backgroundJobs.map((job) =>
        `[bash_bg/${job.id}] ${job.status} · ${job.background ? "background" : "foreground"} · ${job.command}`
      ),
    ];
    if (detail !== "summary") {
      for (const agent of owner.agents) {
        if (agent.outputTail?.length) output.push(`-- @${agent.name ?? agent.correlationId.slice(0, 8)} --`, ...agent.outputTail.slice(-lines));
      }
    }
    return {
      target,
      found: true,
      nativeStatus: activeStatus,
      phase: "active",
      summary: output[0] ?? activeStatus,
      ...(detail === "summary" ? {} : { detail: output.slice(-Math.max(lines, 1) * 4) }),
      updatedAt: Date.now(),
      capabilities: { inspect: true, wait: true, cancel: false, message: true, supervise: true },
    };
  };

  const workspaceTurnsSnapshot = (
    owner: WorkspaceOwnerSnapshot,
    target: ObservationTarget,
    detail: "summary" | "tail" | "full",
    lines: number,
    options: ObservationReadOptions,
  ): ObservationSnapshot => {
    const runs: Array<{
      index: number;
      name: string;
      status: string;
      summary: string;
      outputTail: readonly string[];
      startedAt: number;
    }> = [
      ...owner.agents.map((agent, index) => ({
        index: index + 1,
        name: agent.name ?? agent.correlationId.slice(0, 8),
        status: agent.status,
        summary: agent.summary ?? "",
        outputTail: agent.outputTail ?? [],
        startedAt: agent.startedAt,
      })),
      ...owner.settled.map((record, index) => ({
        index: owner.agents.length + index + 1,
        name: record.name ?? record.correlationId.slice(0, 8),
        status: record.status,
        summary: record.summary ?? record.status,
        outputTail: [],
        startedAt: record.settledAt,
      })),
    ];
    const windowName = owner.sessionName ?? `window:${owner.ownerId.slice(0, 8)}`;
    if (options.turn !== undefined) {
      const run = runs.find((candidate) => candidate.index === options.turn);
      if (!run) {
        return {
          target,
          found: true,
          nativeStatus: "unknown",
          phase: "unknown",
          summary: `Run ${options.turn} not found (${runs.length} run${runs.length === 1 ? "" : "s"}).`,
          detail: runs.map((candidate) =>
            `Run ${candidate.index} · @${candidate.name} ${candidate.status}${candidate.summary ? ` · ${candidate.summary.slice(0, 60)}` : ""}`
          ),
          updatedAt: Date.now(),
          capabilities: { inspect: true, wait: true, cancel: false, message: true, supervise: true },
        };
      }
      const detailLines = [
        `@${run.name} ${run.status} · started ${new Date(run.startedAt).toISOString()}`,
        ...(run.summary ? [run.summary] : []),
        ...(detail !== "summary" ? run.outputTail.slice(-lines) : []),
      ];
      return {
        target,
        found: true,
        nativeStatus: run.status,
        phase: run.status === "completed" || run.status === "failed" ? "settled" : "active",
        summary: `Run ${run.index} · @${run.name} ${run.status}`,
        ...(detail !== "summary" && detailLines.length > 1 ? { detail: detailLines } : {}),
        updatedAt: Date.now(),
        capabilities: { inspect: true, wait: true, cancel: false, message: true, supervise: true },
      };
    }
    const listLines = runs.length === 0
      ? ["No window activity recorded in the peer snapshot."]
      : runs.map((run) =>
        `Run ${run.index} · @${run.name} ${run.status}${run.summary ? ` · ${run.summary.slice(0, 80)}` : ""}`
      );
    return {
      target,
      found: true,
      nativeStatus: "unknown",
      phase: "unknown",
      summary: `${windowName} · ${runs.length} run${runs.length === 1 ? "" : "s"} · snapshot-limited (workspace peers do not publish full turns)`,
      detail: listLines,
      updatedAt: Date.now(),
      capabilities: { inspect: true, wait: true, cancel: false, message: true, supervise: true },
    };
  };

  registerObservationProvider({
    kind: "workspace",
    capabilities: { inspect: true, wait: true, cancel: false, message: true, supervise: true },
    snapshot: (id, options) => workspaceObservationSnapshot(id, options.detail, options.lines, options),
    wait: async (id, options) => {
      const snapshot = await workspaceObservationSnapshot(id, options.detail, options.lines);
      return {
        ...snapshot,
        waitStatus: snapshot.found ? "completed" : "not-found",
        ...(snapshot.found ? { outcome: "success" as const } : {}),
      };
    },
  });

  // --- LLM tool: observe (mixed provider status + wait) ---

  const observeTool: ToolDefinition<typeof ObserveParams, { output: string[]; result: ObserveResult }> = {
    name: "observe",
    label: "Observe",
    renderShell: "self",
    description: OBSERVE_DESCRIPTION,
    promptSnippet: OBSERVE_SNIPPET,
    promptGuidelines: OBSERVE_GUIDELINES,
    parameters: ObserveParams,
    async execute(
      _id: string,
      params: UnifiedObserveParams,
      signal: AbortSignal,
    ): Promise<TeammateToolResult<{ output: string[]; result: ObserveResult }>> {
      const result = await observeTargets(params, signal);
      const output = formatObserveResult(result, params.detail !== "summary" || params.view === "turns");
      if (params.action === "watch" || params.action === "wait") {
        const since = Date.now() - result.durationMs;
        const queuedDuring = (sessionHostRegistry?.thread.list() ?? [])
          .filter((entry) =>
            entry.direction === "incoming"
            && (entry.status === "pending" || entry.status === "queued")
            && entry.updatedAt >= since
          ).length;
        if (queuedDuring > 0) {
          output.push(`[inbox] ${queuedDuring} message(s) arrived during this ${params.action} and are queued; they will be injected after this turn ends (teammate-list view=inbox).`);
        }
      }
      const failed = result.reason === "timeout"
        || result.reason === "aborted"
        || result.observations.some((item) => !item.found || item.outcome === "failure" || item.outcome === "stalled");
      return {
        content: [{ type: "text", text: output.join("\n") }],
        isError: failed,
        details: { output, result },
      };
    },
    renderCall(args, theme, context) {
      if (context.isPartial === false) return new Text("", 0, 0);
      const action = String(args.action ?? "status");
      const count = Array.isArray(args.targets) ? args.targets.length : 0;
      const targetLabel = `${count} target${count === 1 ? "" : "s"}`;
      return renderQuietTeammateAux("observe", `${action} · ${targetLabel}`, "running", theme)
        ?? auxToolCallFallback("observe", theme);
    },
    renderResult(result, options, theme) {
      if (options.isPartial) return new Text("", 0, 0);
      const observed = result.details?.result;
      const failed = (result as { isError?: boolean }).isError === true;
      const rest = observed
        ? observed.action === "status"
          ? `${observed.observations.length} target${observed.observations.length === 1 ? "" : "s"}`
          : `${observed.reason} · ${observed.observations.filter((item) => item.waitStatus !== undefined).length}/${observed.observations.length} settled`
        : failed ? "failed" : "completed";
      return renderQuietTeammateAux("observe", rest, failed ? "failure" : "success", theme)
        ?? auxToolResultFallback(result, theme);
    },
  };

  // --- LLM tool: teammate-monitor (status + wait only) ---

  const monitorTool: ToolDefinition<typeof TeammateMonitorParams, { output: string[] }> = {
    name: "teammate-monitor",
    label: "Teammate Monitor",
    renderShell: "self",
    description: TEAMMATE_MONITOR_DESCRIPTION,
    promptSnippet: TEAMMATE_MONITOR_SNIPPET,
    promptGuidelines: TEAMMATE_MONITOR_GUIDELINES,
    parameters: TeammateMonitorParams,

    async execute(
      _id: string,
      params: MonitorParams,
      signal: AbortSignal,
    ): Promise<TeammateToolResult<{ output: string[] }>> {
      const validationError = validateMonitorParams(params);
      if (validationError) {
        return {
          content: [{ type: "text", text: validationError }],
          isError: true,
          details: { output: [validationError] },
        };
      }

      const verbose = params.verbose ?? false;
      const observed = await observeTargets({
        action: params.action,
        targets: params.targets.map((id) => ({ kind: "teammate", id })),
        detail: verbose ? "full" : "summary",
        lines: params.lines ?? MONITOR_DEFAULT_LINES,
        waitMode: params.waitMode,
        waitCount: params.waitCount,
        timeoutMs: params.timeoutMs ?? MONITOR_DEFAULT_TIMEOUT_MS,
      }, signal);

      if (params.action === "status") {
        const snapshots: MonitorTargetSnapshot[] = observed.observations.map((item) => ({
          name: item.target.id,
          found: item.found,
          agentStatus: item.nativeStatus,
          waitStatus: item.waitStatus,
          summary: item.summary,
          detail: item.detail,
          error: item.error,
        }));
        const output = [
          formatHeader(snapshots),
          ...(verbose ? formatVerbose(snapshots) : formatCompact(snapshots)),
        ];
        return { content: [{ type: "text", text: output.join("\n") }], details: { output } };
      }

      const settled = observed.observations
        .filter((item) => item.waitStatus !== undefined)
        .map((item) => ({
          name: item.target.id,
          status: item.waitStatus!,
          output: item.detail ?? [item.summary],
        }));
      const output = formatBarrierCompact(settled, observed.reason, observed.durationMs);
      const errorStatuses = new Set(["failed", "error", "timeout", "aborted", "not-found", "stalled"]);
      const hasFailure = settled.some((item) => errorStatuses.has(item.status));
      return {
        content: [{ type: "text", text: output.join("\n") }],
        isError: hasFailure,
        details: { output },
      };
    },

    renderCall(args, theme, context) {
      if (context.isPartial === false) return new Text("", 0, 0);
      const action = String(args.action ?? "status");
      const targets = Array.isArray(args.targets) ? (args.targets as string[]).join(", ") : "";
      return renderQuietTeammateAux("teammate-monitor", `${action} ${targets}`, "running", theme)
        ?? auxToolCallFallback("teammate-monitor", theme);
    },

    renderResult(result, options, theme) {
      if (options.isPartial) return new Text("", 0, 0);
      const failed = (result as { isError?: boolean }).isError === true;
      return renderQuietTeammateAux("teammate-monitor", failed ? "failed" : "ok", failed ? "failure" : "success", theme)
        ?? auxToolResultFallback(result, theme);
    },
  };

  interface WorkspaceWindowToolWindow {
    name: string;
    presentation: ManagedWindowPresentation;
    status: "launching" | "running" | "disconnected" | "failed";
    objective: string;
    owner?: string;
    pid?: number;
  }

  interface WorkspaceWindowToolDetails {
    action: WorkspaceWindowToolParams["action"];
    windows: WorkspaceWindowToolWindow[];
  }

  function workspaceWindowSnapshots(): WorkspaceWindowToolWindow[] {
    return [...managedWindows.values()].map((window) => {
      const owner = exactManagedWindowOwner(window);
      const status: WorkspaceWindowToolWindow["status"] = window.launchError
        ? "failed"
        : owner || (window.presentation === "headless" && window.child.exitCode === null)
          ? "running"
          : window.ownerId
            ? "disconnected"
            : "launching";
      return {
        name: window.name,
        presentation: window.presentation,
        status,
        objective: window.objective,
        ...(owner ? { owner: `owner:${owner.ownerId}`, pid: owner.pid } : {}),
      };
    });
  }

  const workspaceWindowTool: ToolDefinition<typeof WorkspaceWindowParams, WorkspaceWindowToolDetails> = {
    name: "workspace-window",
    label: "Workspace Window",
    renderShell: "self",
    description: `Create, list, or close Pi worker windows owned by the active Monitor coordinator.

This lifecycle tool is available only after the user enters Monitor mode with /monitor. Create opens an interactive terminal by default, waits for exact workspace-peer registration, and automatically binds the new window for supervision. Close is restricted to windows created by this Monitor session; discovered external peer windows can be messaged or observed but cannot be closed. Closed windows keep their persisted messages readable through teammate-list view=inbox.`,
    promptSnippet: "Create, list, or close Monitor-owned Pi worker windows.",
    promptGuidelines: [
      "Use create only when the user's monitoring or coordination request requires a new worker window; do not create speculative workers.",
      "After create, coordinate the returned owner target with observe and teammate-send.",
      "Before close, collect needed results and close only Monitor-owned windows that no longer need to run.",
      'After close, use teammate-list with view="inbox" to read the window\'s persisted messages if they are needed.',
    ],
    parameters: WorkspaceWindowParams,
    async execute(
      _id: string,
      params: WorkspaceWindowToolParams,
      signal: AbortSignal,
    ): Promise<TeammateToolResult<WorkspaceWindowToolDetails>> {
      const result = (
        text: string,
        isError = false,
      ): TeammateToolResult<WorkspaceWindowToolDetails> => ({
        content: [{ type: "text", text }],
        ...(isError ? { isError: true } : {}),
        details: { action: params.action, windows: workspaceWindowSnapshots() },
      });

      if (!monitorInteractionModeActive) {
        return result("workspace-window is available only after the user enters Monitor mode with /monitor.", true);
      }

      if (params.action === "list") {
        await refreshWorkspacePeerOwners();
        for (const window of managedWindows.values()) {
          if (window.sessionName === window.name || window.ownerId) continue;
          try {
            captureManagedWindowOwner(window, workspacePeerOwners);
          } catch (error) {
            window.launchError = error instanceof Error ? error.message : String(error);
          }
        }
        const windows = workspaceWindowSnapshots();
        if (windows.length === 0) return result("No Monitor-owned worker windows.");
        return result(windows.map((window) =>
          `${window.status === "running" ? "■" : window.status === "launching" ? "□" : "✗"} ${window.name} · ${window.presentation} · ${window.status}${window.owner ? ` · ${window.owner}` : ""}`
        ).join("\n"));
      }

      const name = params.name?.trim();
      if (!name) return result(`name is required for workspace-window ${params.action}.`, true);

      if (params.action === "close") {
        const stopped = await stopManagedWindow(name);
        if (!stopped.ok) return result(stopped.error ?? `Failed to close ${name}.`, true);
        return result(`Closed Monitor-owned window ${name} (${stopped.status ?? "stopped"}).`);
      }

      const objective = params.objective?.trim();
      if (!objective) return result("objective is required for workspace-window create.", true);

      const presentation = params.presentation ?? "interactive";
      const sessionName = managedWindowSessionName(name);
      const spawned = await spawnManagedWindow(
        name,
        objective,
        state.baseCwd || process.cwd(),
        presentation,
        sessionName,
      );
      if (!spawned.ok || !spawned.window) return result(spawned.error ?? `Failed to create ${name}.`, true);

      try {
        const owner = await waitForManagedWindowOwner(spawned.window, signal);
        if (managedWindows.get(name) !== spawned.window || !exactManagedWindowOwner(spawned.window)) {
          throw new Error(`window "${name}" changed owner before Monitor binding.`);
        }

        const request = monitorBindingRequest(owner, "auto");
        if (!request) throw new Error(`window "${name}" changed endpoint before Monitor binding.`);
        const bound = await monitorControllerInstance.bind([request]);
        syncMonitorRegistryBindings();
        if (bound.bound.length === 0) {
          throw new Error(bound.errors[0]?.error ?? `Failed to bind managed window "${name}".`);
        }

        await refreshWorkspacePeerOwnersStrict();
        if (managedWindows.get(name) !== spawned.window || !exactManagedWindowOwner(spawned.window)) {
          throw new Error(`window "${name}" changed owner after Monitor binding.`);
        }
        return result(`Created and bound ${presentation} worker window ${name} as owner:${owner.ownerId}.`);
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        const cleanup = await stopManagedWindow(name);
        const cleanupText = cleanup.ok
          ? `setup was rolled back (${cleanup.status ?? "stopped"})`
          : `ownership record retained: ${cleanup.error ?? "reclamation not proven"}`;
        return result(`${failure}; ${cleanupText}.`, true);
      }
    },
    renderCall(_args, theme, context) {
      if (context.isPartial === false) return new Text("", 0, 0);
      return auxToolCallFallback("workspace-window", theme);
    },
    renderResult(result, options, theme) {
      if (options.isPartial) return new Text("", 0, 0);
      return auxToolResultFallback(result, theme);
    },
  };

  // =========================================================================
  // Register tools (LLM-callable)
  // =========================================================================

  pi.registerTool(tool);
  pi.registerTool(sendTool);
  pi.registerTool(listTool);
  pi.registerTool(observeTool);
  pi.registerTool(workspaceWindowTool);
  if (exposeLegacyObservationTools()) {
    pi.registerTool(watchTool);
    pi.registerTool(waitTool);
    pi.registerTool(monitorTool);
  }

  // =========================================================================
  // Alt+R shortcut — attach overlay (user-facing TUI)
  // =========================================================================

  function agentLabel(a: ActiveAgent): string {
    return a.name ?? a.correlationId.slice(0, 8);
  }

  interface ComposerPanel {
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate(): void;
    dispose?(): void;
  }

  let interactivePanelActive = false;

  async function showComposerPanel<T>(
    ctx: ExtensionContext,
    create: (requestRender: () => void, done: (value: T) => void) => ComposerPanel,
    cancelValue: T,
  ): Promise<T> {
    interactivePanelActive = true;
    updateAgentWidget();

    // Rendered as a modal overlay (like the ask wizard) so the cockpit's
    // empty-composer ←/→ agent cycling and other ambient input hooks yield to
    // it: an interactive setWidget panel cannot win against listeners that
    // registered at session_start, before this tool-time subscription.
    try {
      return await ctx.ui.custom<T>(
        (tui, theme, _keybindings, done) => {
          let panel: ComposerPanel | undefined;
          let panelDisposed = false;

          const disposePanel = (): void => {
            if (panelDisposed) return;
            panelDisposed = true;
            panel?.dispose?.();
          };

          const finish = (value: T): void => {
            disposePanel();
            interactivePanelActive = false;
            updateAgentWidget();
            done(value);
          };

          panel = create(() => tui.requestRender(), finish);
          return {
            render: (width: number) => {
              const lines = panel?.render(width) ?? [];
              const inner = Math.max(1, Math.min(width, 60) - 2);
              const edge = "─".repeat(inner);
              const border = (glyph: string) => theme.bg("customMessageBg", theme.fg("borderMuted", glyph));
              const fill = (line: string): string => {
                const fitted = truncateToWidth(line, inner, "…");
                return theme.bg("customMessageBg", " " + fitted + " ".repeat(Math.max(0, inner - visibleWidth(fitted))) + " ");
              };
              return [border(`╭${edge}╮`), ...lines.map(fill), border(`╰${edge}╯`)];
            },
            handleInput: (data: string) => {
              panel?.handleInput(data === "\x03" ? "\x1b" : data);
            },
            invalidate: () => panel?.invalidate(),
            dispose: () => {
              disposePanel();
              finish(cancelValue);
            },
          };
        },
        { overlay: true, overlayOptions: { anchor: "center", width: "94%", maxHeight: "90%" } },
      );
    } catch (error) {
      interactivePanelActive = false;
      updateAgentWidget();
      throw error;
    }
  }

  async function showAttachOverlay(
    target: ActiveAgent | string,
    ctx: ExtensionContext,
    initialTranscript = false,
    opts: { readOnly?: boolean } = {},
  ): Promise<void> {
    // A capturing overlay must preempt any active Cockpit split-pane resize:
    // the resize listener is a global terminal-input hook that would otherwise
    // swallow this overlay's first arrow/Enter/Esc.
    preemptCockpitResize();
    const agent = typeof target === "string" ? state.activeRuns.get(target) : target;
    if (!agent) {
      ctx.ui.notify(tuiT("extension.agentInactive"), "error");
      return;
    }

    interactivePanelActive = true;
    updateAgentWidget();
    try {
      await ctx.ui.custom<void>(
        (tui, _theme, _keybindings, done) => {
        const overlay = new AttachOverlay(
          agent,
          () => done(undefined),
          opts.readOnly ? () => new Map<string, ActiveAgent>() : () => state.activeRuns,
          opts.readOnly ? undefined : async (cid, message) => {
            const target = state.activeRuns.get(cid);
            if (!target) {
              return { ok: false, message: tuiT("extension.agentInactiveShort") };
            }
            const delivery = await routeSessionMessage({
              selector: cid,
              message,
              mode: "follow_up",
              source: "user",
            });
            return delivery.delivered
              ? { ok: true, message: tuiT("extension.queued", { target: target.name ?? cid.slice(0, 8) }) }
              : { ok: false, message: delivery.error ?? tuiT("extension.sendFailed") };
          },
          (targetAgent) =>
            loadTranscript({
              correlationId: targetAgent.correlationId,
              sessionFile: targetAgent.sessionFile,
              parentSessionFile: ctx.sessionManager?.getSessionFile?.(),
              lastResult: targetAgent.lastResult,
              outputLog: targetAgent.outputLog,
            }),
          initialTranscript,
        );
        overlay.setRequestRender(() => tui.requestRender());

        // Load existing output log history
        for (const line of agent.outputLog) {
          const kind = line.includes("◀ ") ? "system" as const
            : line.match(/\[\d{2}:\d{2}:\d{2}\]/) ? "tool" as const
            : "output" as const;
          overlay.appendLog(agent.correlationId, line, kind);
        }
        if (agent.outputLog.length === 0) {
          overlay.appendLog(agent.correlationId, `Agent: ${agent.agent} | ${agentLabel(agent)}`, "info");
          overlay.appendLog(agent.correlationId, `Started: ${new Date(agent.startedAt).toISOString()}`, "info");
        }

        const completedToolLog = new Set<string>();

        const msgHandler = (data: unknown) => {
          const evt = data as Record<string, unknown>;
          const cid = evt.correlationId as string;
          if (!cid) return;

          if (evt.isSend) {
            const mode = evt.mode as string;
            const msg = (evt.message as string)?.slice(0, 60) ?? "";
            overlay.appendLog(cid, `[${ts()}] ◀ ${mode}: ${msg}`, "system");
            return;
          }

          const progress = evt.progress as AgentProgressSnapshot[] | undefined;
          const tools = evt.recentTools as Array<{ name: string; status: string }> | undefined;
          const lines: Array<{ text: string; kind: "tool" }> = [];
          let toolEntries: Array<{
            name: string;
            status: "running" | "completed" | "failed";
            startedAt: number;
          }> | undefined;
          if (tools && tools.length > 0) {
            toolEntries = tools.map((t) => ({
              name: t.name,
              status: t.status as "running" | "completed" | "failed",
              startedAt: Date.now(),
            }));

            for (const t of tools) {
              const key = `${evt.taskIndex ?? "single"}:${t.name}:${t.status}`;
              if (t.status !== "running" && !completedToolLog.has(key)) {
                completedToolLog.add(key);
                lines.push({ text: `[${ts()}] ✓ ${t.name}`, kind: "tool" });
              }
            }
          }

          const lastMsg = evt.lastMessage as string | undefined;
          overlay.applyProgressEvent(cid, {
            ...(progress ? { progress } : {}),
            ...(toolEntries ? { activeTools: toolEntries } : {}),
            ...(lastMsg ? { streamingText: lastMsg } : {}),
            ...(lines.length ? { lines } : {}),
          });
          overlay.noteLiveEvent(cid);
        };
        const completeHandler = (data: unknown) => {
          const evt = data as Record<string, unknown>;
          const cid = evt.correlationId as string;
          if (!cid) return;
          overlay.appendLog(cid, `COMPLETED exitCode=${evt.exitCode} ${evt.durationMs}ms`, "system");
          overlay.noteLiveEvent(cid);
        };
        const unsubscribeMessage = pi.events.on(TEAMMATE_MESSAGE_EVENT, msgHandler);
        const unsubscribeComplete = pi.events.on(TEAMMATE_COMPLETE_EVENT, completeHandler);

        const origDispose = overlay.dispose.bind(overlay);
        overlay.dispose = () => {
          unsubscribeMessage();
          unsubscribeComplete();
          origDispose();
        };

        return {
          get focused() { return overlay.focused; },
          set focused(value: boolean) { overlay.focused = value; },
          render: (width: number) => overlay.render(width),
          handleInput: (data: string) => overlay.handleInput(data),
          invalidate: () => overlay.invalidate(),
          dispose: () => overlay.dispose(),
        };
        },
        {
          overlay: true,
          overlayOptions: {
            width: "96%",
            maxHeight: "100%",
            anchor: "center",
          },
        },
      );
    } finally {
      interactivePanelActive = false;
      updateAgentWidget();
    }
  }

  /**
   * Route a selector selection: history rows open a read-only transcript;
   * everything else attaches to a live/sleeping agent.
   */
  async function openSelectedAgent(
    selection: string | null,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (!selection) return;
    const scan = historyByKey.get(selection);
    if (scan) {
      await showAttachOverlay(historyVirtualAgent(scan), ctx, true, { readOnly: true });
      return;
    }
    await showAttachOverlay(selection, ctx);
  }

  async function showAgentSelector(ctx: ExtensionContext): Promise<void> {
    const activeRows = buildAgentSelectorRows(Array.from(state.activeRuns.values()));
    const allRows = [...activeRows, ...buildHistoryRows(historyScans)];
    if (allRows.length === 0) {
      ctx.ui.notify(tuiT("extension.noActiveTeammates"), "warning");
      return;
    }
    if (allRows.length === 1) {
      await openSelectedAgent(allRows[0]?.correlationId ?? null, ctx);
      return;
    }

    // Fuzzy search panel above the editor for agent selection.
    function matchScore(row: AgentSelectorRow, rawQuery: string): number | undefined {
      const text = `${row.agent} ${row.name ?? ""} ${row.label} ${row.correlationId}`.toLowerCase();
      const query = rawQuery.trim().toLowerCase();
      if (!query) return 0;
      const direct = text.indexOf(query);
      if (direct >= 0) return 1000 - direct;

      let position = -1;
      let score = 0;
      for (const char of query) {
        const next = text.indexOf(char, position + 1);
        if (next < 0) return undefined;
        score += next === position + 1 ? 10 : 1;
        position = next;
      }
      return score;
    }

    const selected = await showComposerPanel<string | null>(
      ctx,
      (requestRender, done) => {
        let query = "";
        let cursor = 0;
        let lastWidth = 80;
        const pasteDecoder = new BracketedPasteDecoder();
        let pasteFlushTimer: ReturnType<typeof setTimeout> | undefined;

        function filtered(): AgentSelectorRow[] {
          const activeRows = buildAgentSelectorRows(Array.from(state.activeRuns.values()));
          const historyRows = buildHistoryRows(historyScans);
          // Without a query, only live/sleeping agents are arrow-navigable —
          // history rows would otherwise capture ↑/↓ navigation. History is
          // reachable by typing (labels carry the session id) and is the
          // fallback list when no agents exist.
          const rows = query.trim()
            ? [...activeRows, ...historyRows]
            : activeRows.length > 0
              ? activeRows
              : historyRows;
          const matches = !query ? rows : rows
            .map((row, index) => ({ row, index, score: matchScore(row, query) }))
            .filter((item): item is { row: AgentSelectorRow; index: number; score: number } => item.score !== undefined)
            .sort((a, b) => b.score - a.score || a.index - b.index)
            .map((item) => item.row);
          cursor = Math.max(0, Math.min(cursor, Math.max(0, matches.length - 1)));
          return matches;
        }

        function handleDecodedInput(data: string): void {
          const matches = filtered();
          if (data === "\r" || data === "\n") {
            done(matches[cursor]?.correlationId ?? null);
          } else if (data === "\x1b") {
            done(null);
          } else if (data === "\x1b[A" || (data === "k" && !query)) {
            cursor = Math.max(0, cursor - 1);
            requestRender();
          } else if (data === "\x1b[B" || (data === "j" && !query)) {
            cursor = Math.min(Math.max(0, matches.length - 1), cursor + 1);
            requestRender();
          } else if (data === "\x1b[5~" || data === "\x1b[5;5~") {
            // PageUp — jump up a page of the selection list.
            cursor = Math.max(0, cursor - 8);
            requestRender();
          } else if (data === "\x1b[6~" || data === "\x1b[6;5~") {
            // PageDown.
            cursor = Math.min(Math.max(0, matches.length - 1), cursor + 8);
            requestRender();
          } else if (data === "\x1b[H") {
            cursor = 0;
            requestRender();
          } else if (data === "\x1b[F") {
            cursor = Math.max(0, matches.length - 1);
            requestRender();
          } else if (data === "\x7f" || data === "\b") {
            if (query.length > 0) { query = removeLastGrapheme(query); cursor = 0; requestRender(); }
          } else if (!data.startsWith("\x1b")) {
            // 忽略导航/功能键转义序列，避免残渣混入搜索文本。
            const input = sanitizeSingleLineInput(data);
            if (input) {
              query += input;
              cursor = 0;
              requestRender();
            }
          }
        }

        function dispatchDecodedToken(token: DecodedInputToken): void {
          if (token.kind === "paste") {
            query += token.text;
            cursor = 0;
          } else {
            handleDecodedInput(token.text);
          }
        }

        return {
          render(width: number) {
            const w = Math.max(1, Math.min(width, 60));
            lastWidth = w;
            return renderAgentSelectorPanel(filtered(), cursor, query, w);
          },

          handleInput(data: string) {
            if (lastWidth < 20) {
              if (data === "\x1b") done(null);
              return;
            }
            if (pasteFlushTimer) clearTimeout(pasteFlushTimer);
            for (const token of pasteDecoder.feed(data)) dispatchDecodedToken(token);
            if (pasteDecoder.hasPending()) {
              pasteFlushTimer = setTimeout(() => {
                pasteFlushTimer = undefined;
                for (const token of pasteDecoder.flushPending()) dispatchDecodedToken(token);
                requestRender();
              }, 16);
            }
            requestRender();
          },

          invalidate() {},
          dispose() {
            if (pasteFlushTimer) clearTimeout(pasteFlushTimer);
          },
        };
      },
      null,
    );

    if (selected) {
      await openSelectedAgent(selected, ctx);
    }
  }

  function teardownRootSession(): void {
    // Fence every continuation admitted by the outgoing session before any
    // visible registry or process cleanup. Late promises may release their own
    // request records, but cannot publish events or turns into the next session.
    state.sessionGeneration = (state.sessionGeneration ?? 0) + 1;
    for (const controller of state.proxyObservationControllers?.values() ?? []) {
      controller.abort("teammate session ended");
    }
    state.proxyObservationControllers?.clear();
    state.pendingProxyDispatchRequests?.clear();
    state.pendingProxyDispatchParents?.clear();
    state.proxyDispatchByRequest?.clear();
    state.cancelledProxyDispatches?.clear();
    stopWidgetTimer();
    stopWakeableEvictionTimer();
    for (const [cid, run] of [...state.activeRuns]) {
      killAgent(state, cid, run.name);
    }
    state.namedAgents.clear();
    state.currentSessionId = null;
    widgetCtx?.ui.setWidget("teammate-agents", undefined);
    widgetCtx = null;
    setPersistentUi(undefined);
  }


  async function showTeammateControlCenter(ctx: ExtensionContext): Promise<void> {
    const activeAgents = Array.from(state.activeRuns.values())
      .filter((agent) => agent.status !== "completed")
      .map((agent) => ({
        correlationId: agent.correlationId,
        agent: agent.agent,
        name: agent.name,
        status: agent.status,
        startedAt: agent.startedAt,
        inboxCount: agent.inbox.length,
        taskCount: agent.progress?.length ?? 0,
      }));
    await showModelMappingOverlay(ctx, refreshModelCatalog(ctx).models, {
      agents: discoverAgents(ctx.cwd),
      activeAgents,
      modelHealth: sharedModelCircuitBreaker.snapshot(),
      onOpenAgent: async (correlationId) => showAttachOverlay(correlationId, ctx),
    });
  }

  let widgetCtx: ExtensionContext | null = null;
  const teammateSettingsProvider = createTeammateSettingsProvider({
    openLegacySettings: async () => {
      if (!widgetCtx) return;
      await showTeammateControlCenter(widgetCtx);
      tool.description = buildTeammateToolDescription(widgetCtx.cwd);
      pi.registerTool(tool);
    },
  });
  // Cockpit split-pane resize runs as a global terminal-input hook; a capturing
  // overlay opened here must preempt it so the overlay's own keys win focus.
  const preemptCockpitResize = (): void => {
    try {
      pi.events.emit(COCKPIT_PREEMPT_RESIZE_EVENT, undefined);
    } catch {
      // Best effort: emitting must never block opening the overlay.
    }
  };

  // Settings providers re-register at each session boundary so a host reload
  // cannot accumulate stale shared-bus listeners from previous instances
  // (see issue ISS-20260803-005; cockpit follows the same pattern).
  let teammateSettingsDisposer: (() => void) | undefined;
  const registerTeammateSettings = (): void => {
    if (teammateSettingsDisposer) return;
    teammateSettingsDisposer = registerTeammateSettingsProvider({
      on: (event, handler) => pi.events.on(event, handler),
      emit: (event, payload) => pi.events.emit(event, payload),
    }, teammateSettingsProvider);
  };
  const disposeTeammateSettings = (): void => {
    teammateSettingsDisposer?.();
    teammateSettingsDisposer = undefined;
  };

  pi.registerCommand("teammate-models", {
    description: "Open teammate roles, collaboration status, and model routing",
    async handler(_args, ctx) {
      preemptCockpitResize();
      await showTeammateControlCenter(ctx);
      tool.description = buildTeammateToolDescription(ctx.cwd);
      pi.registerTool(tool);
    },
  });

  // ---------------------------------------------------------------------------
  // /monitor — user-only monitor mode lifecycle
  // ---------------------------------------------------------------------------

  function windowRowStatus(statuses: readonly string[]): string {
    if (statuses.length === 0) return "idle";
    if (statuses.some((status) => status === "running" || status === "retrying")) return "running";
    return "sleeping";
  }

  function monitorSessionRows(): MonitorSessionRow[] {
    const localAgents: MonitorSessionRow[] = [...state.activeRuns.values()].map((agent) => ({
      correlationId: agent.correlationId,
      displayName: agent.name ?? agent.correlationId.slice(0, 8),
      agentRole: agent.agent,
      status: agent.status,
      idleSeconds: Math.round((Date.now() - agent.lastActivityAt) / 1000),
      bound: monitorEngine.bindings.has(agent.correlationId),
      source: "local",
      kind: "agent",
      ownerId: "local",
      bindable: false,
      depth: agent.depth,
      ...(agent.spawnedBy ? { parentCorrelationId: agent.spawnedBy } : {}),
    }));
    const remoteRows = workspacePeerOwners.flatMap((owner): MonitorSessionRow[] => {
      const windowRow: MonitorSessionRow = {
        correlationId: `owner:${owner.ownerId}`,
        displayName: owner.sessionName ?? `window:${owner.ownerId.slice(0, 6)}`,
        agentRole: tuiT("extension.windowSummaryJobs", {
          agents: owner.agents.length,
          jobs: owner.backgroundJobs?.length ?? 0,
        }),
        status: windowRowStatus([
          ...owner.agents.map((agent) => agent.status),
          ...(owner.backgroundJobs ?? []).map(() => "running"),
        ]),
        idleSeconds: 0,
        bound: false,
        source: owner.sessionName ?? `remote:${owner.ownerId.slice(0, 6)}`,
        kind: "window",
        ownerId: owner.ownerId,
        bindable: true,
      };
      const agentRows: MonitorSessionRow[] = owner.agents.map((agent) => {
        const key = `${owner.ownerId}:${agent.correlationId}`;
        return {
          correlationId: key,
          displayName: agent.name ?? agent.correlationId.slice(0, 8),
          agentRole: agent.agent,
          status: agent.status,
          idleSeconds: Math.round((Date.now() - agent.lastActivityAt) / 1000),
          bound: monitorEngine.bindings.has(key),
          source: owner.sessionName ?? `remote:${owner.ownerId.slice(0, 6)}`,
          kind: "agent",
          ownerId: owner.ownerId,
          bindable: false,
          ...(agent.depth === undefined ? {} : { depth: agent.depth }),
          ...(agent.parentCorrelationId ? { parentCorrelationId: agent.parentCorrelationId } : {}),
        } satisfies MonitorSessionRow;
      });
      return [windowRow, ...agentRows];
    });
    const localWindowRow: MonitorSessionRow = {
      correlationId: "local",
      displayName: workspacePeerSessionName ?? tuiT("extension.currentWindow"),
      agentRole: tuiT("extension.windowSummary", { agents: localAgents.length }),
      status: windowRowStatus(localAgents.map((agent) => agent.status)),
      idleSeconds: 0,
      bound: false,
      source: "local",
      kind: "window",
      ownerId: "local",
      bindable: false,
    };
    return [localWindowRow, ...localAgents, ...remoteRows];
  }

  // ---------------------------------------------------------------------------
  // /teammate-send — send a prompt to another live Pi session
  // ---------------------------------------------------------------------------

  pi.registerCommand("teammate-send", {
    description: "Send a message to another Pi session; without arguments, choose a session and enter the message.",
    getArgumentCompletions(prefix: string) {
      void refreshWorkspacePeerOwners();
      const matches = monitorSessionRows()
        .filter((row) => row.kind === "window" && row.bindable === true)
        .map((row) => ({
          value: row.correlationId,
          label: row.displayName,
          description: `${row.agentRole} · ${row.source ?? "workspace peer"}`,
        }))
        .filter((entry) => entry.value.startsWith(prefix.trimStart()));
      return matches.length > 0 ? matches : null;
    },
    async handler(args: string, ctx) {
      await workspacePeerLifecycle;
      await refreshWorkspacePeerOwners();

      const trimmed = args.trim();
      let target: string | undefined;
      let message: string | undefined;
      if (trimmed) {
        const separator = trimmed.search(/\s/);
        if (separator < 0) {
          ctx.ui.notify("Usage: /teammate-send <owner:ownerId> <message>", "warning");
          return;
        }
        target = trimmed.slice(0, separator);
        message = trimmed.slice(separator).trim();
        if (!message) {
          ctx.ui.notify(tuiT("extension.messageRequired"), "warning");
          return;
        }
      } else {
        preemptCockpitResize();
        const result = await showSessionSendOverlay(ctx, {
          getSessions: () => monitorSessionRows().filter((row) => row.kind === "window" && row.bindable === true),
        });
        if (!result) return;
        target = result.target;
        message = result.message;
      }

      const delivery = await routeSessionMessage({
        selector: target,
        message,
        mode: "follow_up",
        source: "user",
      });
      ctx.ui.notify(
        delivery.delivered
          ? tuiT("extension.messageDelivered", { target })
          : delivery.error ?? tuiT("extension.messageUndelivered", { target }),
        delivery.delivered ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("delegate", {
    description: "Delegate an additive task to a fresh or forked independent window after reviewing a planner-produced document.",
    getArgumentCompletions(prefix: string) {
      const commands = [
        { value: "--new ", label: "--new <instruction>", description: "Draft for a fresh worker session (default)" },
        { value: "--fork ", label: "--fork <instruction>", description: "Draft for a worker forked from the source session" },
        { value: "create --new ", label: "create --new <instruction>", description: "Explicit fresh-session delegation" },
        { value: "create --fork ", label: "create --fork <instruction>", description: "Explicit forked-session delegation" },
        { value: "list", label: "list", description: "List delegation drafts and windows" },
        { value: "show ", label: "show <id>", description: "Show a saved task document" },
        { value: "send ", label: "send <id>", description: "Confirm and send a saved draft" },
        { value: "stop ", label: "stop <id>", description: "Stop an independently managed delegation window" },
        { value: "cancel ", label: "cancel <id>", description: "Cancel an unsent delegation draft" },
      ];
      const matches = commands.filter((command) => command.value.startsWith(prefix.trimStart()));
      return matches.length > 0 ? matches : null;
    },
    async handler(args: string, ctx) {
      const command = parseDelegationCommand(args);
      const root = delegationWorkspaceRoot(ctx);
      const usage = "Usage: /delegate [--new|--fork] <instruction> | /delegate create [--new|--fork] <instruction> | /delegate list | /delegate show|send|stop|cancel <id>";
      try {
        if (command.action === "help") {
          ctx.ui.notify(usage, "info");
          return;
        }
        if (command.action === "invalid") {
          ctx.ui.notify(command.error, "warning");
          return;
        }
        if (command.action === "list") {
          await refreshWorkspacePeerOwners();
          const loaded = await listDelegationRecords(root);
          const records = await Promise.all(loaded.map((record) =>
            reconcileDelegationDelivery(record, root).catch(() => record)
          ));
          if (records.length === 0) {
            ctx.ui.notify("No delegation drafts or windows.", "info");
            return;
          }
          const lines = records.map((record) => {
            const liveOwner = delegationOwnerCandidate(record, workspacePeerOwners);
            const status = record.status === "sent"
              ? (liveOwner ? "running" : "sent/offline")
              : record.status;
            return `${record.id} | r${record.revision} | ${record.workerContext} | ${status} | ${record.task.title}${record.window ? ` | owner:${record.window.ownerId}` : ""}`;
          });
          ctx.ui.notify(`DELEGATIONS ${records.length}\n${lines.join("\n")}`, "info");
          return;
        }
        if (command.action === "show") {
          const loaded = await loadDelegationRecord(root, command.id);
          const record = await reconcileDelegationDelivery(loaded, root).catch(() => loaded);
          const document = await readDelegationDocument(root, command.id);
          ctx.ui.notify(`${document}\nStatus: ${record.status}\nWorker context: ${record.workerContext}\nPath: ${delegationDocumentPath(root, record.id)}`, "info");
          return;
        }
        if (command.action === "cancel") {
          if (managedWindows.has(command.id)) {
            ctx.ui.notify(`Delegation ${command.id} still owns a window; stop it before cancelling.`, "warning");
            return;
          }
          const record = await cancelDelegationDraft(root, command.id);
          ctx.ui.notify(`Cancelled delegation ${record.id}; its task document remains at ${delegationDocumentPath(root, record.id)}.`, "info");
          return;
        }
        if (command.action === "stop") {
          const loaded = await loadDelegationRecord(root, command.id);
          const record = await reconcileDelegationDelivery(loaded, root).catch(() => loaded);
          if (record.status === "closed") {
            ctx.ui.notify(`Delegation ${record.id} is already closed.`, "info");
            return;
          }
          const stopped = await stopDelegationWindow(record, root);
          ctx.ui.notify(`Stopped delegation window ${record.id} (${stopped.status}).`, "info");
          return;
        }

        let record: DelegationRecord;
        if (command.action === "create") {
          const workerContext = command.workerContext ?? await selectDelegationWorkerContext(ctx);
          if (!workerContext) {
            ctx.ui.notify("Delegation cancelled before drafting.", "info");
            return;
          }
          record = await draftDelegation(command.request, workerContext, ctx);
          ctx.ui.notify(`Delegation draft ${record.id} (${record.workerContext}) saved to ${delegationDocumentPath(root, record.id)}.`, "info");
        } else {
          const loaded = await loadDelegationRecord(root, command.id);
          record = await reconcileDelegationDelivery(loaded, root).catch(() => loaded);
          if (record.status !== "draft" && record.status !== "confirmed") {
            ctx.ui.notify(`Delegation ${record.id} is ${record.status} and cannot be sent.`, "warning");
            return;
          }
        }

        const confirmedDocument = await confirmDelegationSend(record, ctx);
        if (confirmedDocument === undefined) {
          ctx.ui.notify(`Delegation ${record.id} remains ${record.status}. Review ${delegationDocumentPath(root, record.id)}, then run /delegate send ${record.id}.`, "info");
          return;
        }
        const dispatched = await dispatchDelegation(record, confirmedDocument, ctx);
        ctx.ui.notify(
          `Delegation ${record.id} (${record.workerContext}) sent to owner:${dispatched.owner.ownerId}${dispatched.deliveryStage ? ` (${dispatched.deliveryStage})` : ""}. Manage it with /delegate list or /delegate stop ${record.id}.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });

  pi.registerCommand("monitor", {
    description: "Monitor: /monitor <targets...> [auto|custom:<prompt>] | /monitor exit | /monitor [status]",
    getArgumentCompletions(prefix: string) {
      void refreshWorkspacePeerOwners();
      const agents = monitorSessionRows()
        .filter((row) => row.bindable === true)
        .map((agent) => ({
          value: agent.displayName,
          label: agent.displayName,
          description: `${agent.agentRole} · ${translateStatusIdentifier(agent.status)}${agent.source === "local" ? "" : ` · ${agent.source}`}`,
        }));
      const commands = [
        { value: "exit", label: "exit", description: "Stop monitoring and clear bindings" },
        { value: "status", label: "status", description: "Show bindings and snapshot" },
        { value: "auto", label: "auto", description: "Auto supervision mode" },
        { value: "custom:", label: "custom:<prompt>", description: "Custom prompt supervision" },
      ];
      const all = [...commands, ...agents];
      const matches = all.filter((c) => c.value.startsWith(prefix.trimStart()));
      return matches.length > 0 ? matches : null;
    },
    async handler(args: string, ctx) {
      const trimmed = args.trim();
      await workspacePeerLifecycle;

      // /monitor (no args) — enter the Monitor control window without binding every peer.
      if (trimmed === "") {
        await monitorRegistry.requestWindowMode("enter");
        ctx.ui.notify("Monitor mode opened. Use #control for supervision instructions or select a peer window to message it.", "info");
        return;
      }

      // /monitor ui — legacy binding overlay retained for compatibility.
      if (trimmed === "ui") {
        preemptCockpitResize();
        await refreshWorkspacePeerOwners();
        const sessions = monitorSessionRows();

        const result = await showMonitorOverlay(ctx, {
          getSessions: () => sessions,
        });

        if (!result) return; // cancelled

        const requests: MonitorControllerBindingRequest[] = [];
        for (const bindingKey of result.selected) {
          const ownerId = bindingKey.startsWith("owner:") ? bindingKey.slice("owner:".length) : undefined;
          const owner = ownerId ? workspacePeerOwners.find((candidate) => candidate.ownerId === ownerId) : undefined;
          if (!owner) continue;
          const request = monitorBindingRequest(owner, result.mode, result.customPrompt);
          if (request) requests.push(request);
        }
        const bound = await monitorControllerInstance.bind(requests);
        syncMonitorRegistryBindings();
        if (bound.bound.length > 0) {
          await monitorRegistry.requestWindowMode("enter");
          ctx.ui.notify(
            `Monitor session started for ${bound.bound.length} window${bound.bound.length === 1 ? "" : "s"} (${result.mode})${bound.errors.length ? ` · ${bound.errors.length} errors` : ""}`,
            "info",
          );
        } else {
          ctx.ui.notify(bound.errors.map((entry) => entry.error).join("; ") || "No new bindings created.", "warning");
        }
        return;
      }

      // /monitor exit — stop the independent monitor session and clear bindings
      if (trimmed === "exit" || trimmed === "stop") {
        if (!monitorInteractionModeActive && !monitorSessionAgent() && monitorEngine.bindings.size === 0) {
          ctx.ui.notify("Monitor session is not active.", "warning");
          return;
        }
        await monitorRegistry.requestWindowMode("exit");
        notifyMonitorModeClosed(ctx.ui, "Monitor session stopped.");
        return;
      }

      // /monitor spawn <name> <objective...> — launch a managed headless work window
      if (trimmed === "spawn" || trimmed.startsWith("spawn ")) {
        const rest = trimmed.slice("spawn".length).trim();
        if (rest === "status") {
          if (managedWindows.size === 0) {
            ctx.ui.notify("No managed windows spawned.", "info");
            return;
          }
          await refreshWorkspacePeerOwners();
          const snapshots = workspaceWindowSnapshots();
          const lines = snapshots.map((window) =>
            `  ${window.status === "running" ? "■" : window.status === "launching" ? "□" : "✗"} ${window.name} · ${window.presentation} · ${window.status} · ${window.objective.slice(0, 60)}`
          );
          ctx.ui.notify(`MANAGED WINDOWS ${managedWindows.size}\n${lines.join("\n")}`, "info");
          return;
        }
        if (rest === "stop" || rest.startsWith("stop ")) {
          const name = rest.slice("stop".length).trim();
          const stopped = name ? await stopManagedWindow(name) : { ok: false, error: "window name is required" };
          if (!stopped.ok) {
            ctx.ui.notify(`${stopped.error ?? `No managed window "${name}".`} Use /monitor spawn status to list.`, "warning");
            return;
          }
          ctx.ui.notify(`Stopped managed window ${name} (${stopped.status ?? "stopped"}).`, "info");
          return;
        }
        const space = rest.indexOf(" ");
        const name = space < 0 ? rest : rest.slice(0, space);
        const objective = space < 0 ? "" : rest.slice(space + 1).trim();
        if (!name || !objective) {
          ctx.ui.notify("Usage: /monitor spawn <name> <objective> | /monitor spawn status | /monitor spawn stop <name>", "warning");
          return;
        }
        const result = await spawnManagedWindow(name, objective, ctx.cwd);
        if (!result.ok) {
          ctx.ui.notify(`Spawn failed: ${result.error}`, "warning");
          return;
        }
        ctx.ui.notify(
          `Spawned managed window ${name}. Wait for it to appear in /monitor status, then bind with /monitor ${name} [--goal <id>].`,
          "info",
        );
        return;
      }

      // /monitor resume — restore active bindings from the durable ledger
      if (trimmed === "resume") {
        monitorConfig = loadMonitorConfigForRoot(monitorLedgerRoot ?? state.baseCwd ?? ctx.cwd);
        if (monitorEngine.bindings.size > 0 && await monitorControllerInstance.resume()) {
          await monitorRegistry.requestWindowMode("enter");
          ctx.ui.notify("Resumed the independent Monitor session.", "info");
          return;
        }
        const restored = await resumeMonitorBindings(ctx);
        if (restored > 0) await monitorRegistry.requestWindowMode("enter");
        ctx.ui.notify(
          restored > 0 ? `Resumed the independent Monitor session with ${restored} binding${restored === 1 ? "" : "s"}.` : "No active Monitor session or bindings in the monitor ledger to resume.",
          restored > 0 ? "info" : "warning",
        );
        return;
      }

      // /monitor metrics — derived supervision metrics from the ledger
      if (trimmed === "metrics") {
        await refreshMonitorLedgerState();
        if (!monitorLedgerState) {
          ctx.ui.notify("Monitor ledger is not loaded. Start the monitor first.", "warning");
          return;
        }
        const lines = formatMonitorMetrics(deriveMonitorMetrics(monitorLedgerState));
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // /monitor doctor — read-only health check
      if (trimmed === "doctor") {
        monitorConfig = loadMonitorConfigForRoot(monitorLedgerRoot ?? state.baseCwd ?? ctx.cwd);
        await refreshMonitorLedgerState();
        const root = monitorLedgerRoot ?? state.baseCwd ?? ctx.cwd;
        const ledgerLines = monitorLedgerState
          ? [
              `  ledger: ${monitorLedgerState.records} records · ${monitorLedgerState.activeBindings.length} active · ${monitorLedgerState.disconnectedBindings.length} disconnected`,
              `  interventions: ${monitorLedgerState.interventions.length} · outcomes: ${monitorLedgerState.outcomes.length} · dead-letter: ${monitorLedgerState.deadLetters.length}`,
            ]
          : [`  ledger: not loaded${monitorConfig.ledgerEnabled ? "" : " (disabled)"}`];
        const lines = [
          `MONITOR doctor · session ${monitorSessionStatus()} · ${monitorEngine.bindings.size} bindings`,
          `  config: tick ${monitorConfig.tickMs}ms · stall ${monitorConfig.stallIdleSeconds}s · cooldown ${monitorConfig.interventionCooldownMs}ms · retries ${monitorConfig.maxRetries} · escalate ×${monitorConfig.escalationThreshold} · autoResume ${monitorConfig.autoResume ? "on" : "off"}`,
          `  ledger: ${monitorConfig.ledgerEnabled ? "enabled" : "disabled"} @ ${join(root, ".pi", "monitor-ledger.jsonl")}`,
          ...ledgerLines,
          ...(monitorLedgerWarnings.length ? [`  warnings: ${monitorLedgerWarnings.join("; ")}`] : []),
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // /monitor status — show the independent monitor session and its bindings
      if (trimmed === "status") {
        const agent = monitorSessionAgent();
        if (!monitorInteractionModeActive && !agent && monitorEngine.bindings.size === 0) {
          ctx.ui.notify("Monitor session is not active. Use /monitor <targets...> to start.", "warning");
          return;
        }
        const targetLines = [...monitorEngine.bindings.values()].map((binding) =>
          `  ✓ ${binding.displayName} ${binding.mode}${binding.resumed ? " · resumed" : ""}`,
        );
        const outputTail = agent?.outputLog.slice(-3) ?? [];
        const ledgerLine = monitorLedgerState
          ? `ledger: ${monitorLedgerState.activeBindings.length} active · ${monitorLedgerState.disconnectedBindings.length} disconnected · ${monitorLedgerState.deadLetters.length} dead-letter`
          : "ledger: not loaded";
        const lines = [
          `MONITOR SESSION ${monitorSessionStatus()} · ${monitorEngine.bindings.size} targets · ${ledgerLine}`,
          ...targetLines,
          ...(outputTail.length ? ["  recent:", ...outputTail.map((line) => `    ${line}`)] : []),
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // /monitor <targets...> [auto|custom:<prompt>] — create bindings and start a monitor session
      // Split at custom: boundary to support multi-word prompts
      let mode: MonitorSupervisionMode = "auto";
      let customPrompt: string | undefined;
      let targetPart = trimmed;
      let goalId: string | undefined;

      const customIdx = trimmed.indexOf("custom:");
      if (customIdx >= 0) {
        mode = "custom";
        customPrompt = trimmed.slice(customIdx + 7).trim();
        targetPart = trimmed.slice(0, customIdx).trim();
      } else if (trimmed.endsWith(" auto") || trimmed === "auto") {
        targetPart = trimmed.replace(/\s*auto$/, "").trim();
      }

      // Optional --goal <id> links the binding to a pi-peer goal board.
      const goalMatch = /--goal\s+(\S+)/.exec(targetPart);
      if (goalMatch) {
        goalId = goalMatch[1];
        targetPart = targetPart.replace(/--goal\s+\S+/, "").trim();
      }

      const targets = targetPart.split(/\s+/).filter((t) => t && t !== "auto");

      if (targets.length === 0) {
        ctx.ui.notify("Usage: /monitor <target1> [target2 ...] [auto|custom:<prompt>] [--goal <goalId>]", "warning");
        return;
      }

      await refreshWorkspacePeerOwners();
      refreshSessionEndpointDirectory(true);
      const requests: MonitorControllerBindingRequest[] = [];
      const errors: string[] = [];
      for (const name of targets) {
        const owner = resolveWorkspaceMonitorTarget(name);
        if (!owner) {
          errors.push(`${name}: window not found`);
          continue;
        }
        const request = monitorBindingRequest(owner, mode, customPrompt, { ...(goalId ? { goalId } : {}) });
        if (request) requests.push(request);
        else errors.push(`${name}: endpoint changed before binding`);
      }

      const result = await monitorControllerInstance.bind(requests);
      syncMonitorRegistryBindings();
      errors.push(...result.errors.map((entry) => `${entry.key}: ${entry.error}`));
      if (result.bound.length === 0) {
        ctx.ui.notify(`No bindings created. ${errors.join("; ")}`, "warning");
        return;
      }

      const modeLabel = mode === "custom" ? `custom: ${customPrompt?.slice(0, 40)}` : "auto";
      await monitorRegistry.requestWindowMode("enter");
      ctx.ui.notify(`Monitor session started for ${result.bound.length} window${result.bound.length === 1 ? "" : "s"} (${modeLabel})${errors.length ? ` · ${errors.length} errors` : ""}`, "info");
    },
  });

  pi.registerCommand("advisor", {
    description: "Turn-level advisor: /advisor on|off|status",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const trimmed = args.trim().toLowerCase();
      advisorConfig = loadAdvisorConfigForRoot(monitorLedgerRoot ?? state.baseCwd ?? ctx.cwd);
      if (trimmed === "on") {
        advisorConfig.enabled = true;
        advisorState.enabled = true;
        ctx.ui.notify("Advisor enabled — turn-level quality reviews on agent_end (cooldown-gated).", "info");
        return;
      }
      if (trimmed === "off") {
        advisorConfig.enabled = false;
        advisorState.enabled = false;
        ctx.ui.notify("Advisor disabled.", "info");
        return;
      }
      // status (default)
      const lines = [
        `ADVISOR ${advisorState.enabled ? "enabled" : "disabled"} · ${advisorState.reviews}/${advisorConfig.maxReviewsPerSession} reviews · cooldown ${Math.round(advisorConfig.cooldownMs / 1000)}s`,
        ...(advisorState.lastVerdict
          ? [`  last: ${advisorState.lastVerdict.status}${advisorState.lastVerdict.reason ? ` — ${advisorState.lastVerdict.reason.slice(0, 80)}` : ""}`]
          : ["  last: no review yet"]),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // =========================================================================
  // TUI — only in parent mode (child processes have no terminal)
  // =========================================================================

  let cockpitOwnsAgents = false;
  let cockpitOwnsSessionList = false;

  pi.registerShortcut("alt+r", {
    description: "Open the teammate session list",
    async handler(ctx) {
      preemptCockpitResize();
      if (cockpitOwnsSessionList) {
        pi.events.emit(COCKPIT_SESSION_LIST_EVENT, { version: 1 });
        return;
      }
      await showAgentSelector(ctx);
    },
  });

  pi.registerShortcut("alt+m", {
    description: "Open the teammate control center",
    async handler(ctx) {
      preemptCockpitResize();
      await showTeammateControlCenter(ctx);
      tool.description = buildTeammateToolDescription(ctx.cwd);
      pi.registerTool(tool);
    },
  });

  function updateAgentWidget(): void {
    if (!widgetCtx) return;
    if (cockpitOwnsAgents || interactivePanelActive || foregroundToolRuns.size > 0) {
      widgetCtx.ui.setWidget("teammate-agents", undefined);
      return;
    }
    const now = Date.now();
    const visible = Array.from(state.activeRuns.entries()).filter(([, a]) => {
      if (a.status === "completed") return false;
      if (a.status === "sleeping" && a.sleptAt && now - a.sleptAt > AGENT_WIDGET_IDLE_HIDE_MS) return false;
      // Pending hides after the grace period measured from the last real work,
      // not from when the agent entered pending.
      if (a.status === "pending" && now - a.lastActivityAt > AGENT_WIDGET_IDLE_HIDE_MS) return false;
      return true;
    });
    if (visible.length === 0) {
      widgetCtx.ui.setWidget("teammate-agents", undefined);
      return;
    }

    const agents = visible.map(([, agent]) => agent);

    widgetCtx.ui.setWidget("teammate-agents", (_tui, theme) => ({
      render(width: number): string[] {
        return renderAgentStatusWidget(agents, width, theme);
      },
      invalidate() {},
    }), { placement: "belowEditor" });
  }

  let widgetTimer: ReturnType<typeof setInterval> | null = null;
  let wakeableEvictionTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Wakes the caller when a background/detached agent goes silent past the
   * stall confirmation window. One-shot per episode (edge-triggered in
   * sweepStalledAgents); on delivery failure the marker stays set so the
   * notification is not retried on every tick — the agent remains inspectable
   * via observe/teammate-watch and safeSendMessage already logged the drop.
   */
  const notifyStalled = (message: string, agent: ActiveAgent): void => {
    safeSendMessage(pi, {
      customType: "teammate-stalled",
      content: message,
      display: true,
      details: {
        mode: agent.spawnedBy ? "nested" : "single",
        correlationId: agent.correlationId,
        name: agent.name,
        agent: agent.agent,
      },
    }, { triggerTurn: true });
  };

  function startWidgetTimer(): void {
    if (widgetTimer) return;
    stopWakeableEvictionTimer();
    widgetTimer = setInterval(() => {
      // A result-ready zombie keeps hasTeammateWidgetWork true, so this tick is
      // exactly where it stays reachable until reclaimed. Publishing the
      // retirement keeps delta-only consumers (cockpit roster) in sync.
      reclaimResultReadyAgents(state, pi);
      sweepFailedAgents(state);
      // Before the wakeable budget can retire a silent agent, surface the stall
      // to the caller that is waiting on a notification that will never fire.
      sweepStalledAgents(state, notifyStalled);
      enforceWakeableAgentBudget(state);
      if (!hasTeammateWidgetWork(state)) {
        stopWidgetTimer();
        updateAgentWidget();
        scheduleWakeableEvictionTimer();
        return;
      }
      updateAgentWidget();
    }, 1000);
  }

  function stopWidgetTimer(): void {
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = null;
    }
  }

  function stopWakeableEvictionTimer(): void {
    if (!wakeableEvictionTimer) return;
    clearTimeout(wakeableEvictionTimer);
    wakeableEvictionTimer = null;
  }

  function scheduleWakeableEvictionTimer(): void {
    stopWakeableEvictionTimer();
    const delay = nextWakeableAgentExpiryDelay(state);
    if (delay === undefined) return;
    wakeableEvictionTimer = setTimeout(() => {
      wakeableEvictionTimer = null;
      // Also swept here: once the widget timer stops, this is the only tick
      // left, and a tombstone that outlives its window would otherwise sit in
      // activeRuns forever — blocking its whole cohort from ever retiring.
      sweepFailedAgents(state);
      enforceWakeableAgentBudget(state);
      updateAgentWidget();
      scheduleWakeableEvictionTimer();
    }, delay);
    wakeableEvictionTimer.unref?.();
  }

  if (!isChild) {
  const disposeTuiLocaleEvents = pi.events.on(SETTINGS_LOCALE_EVENT, (payload) => {
    if (!applySettingsLocaleEvent(payload)) return;
    updateAgentWidget();
    syncMonitorInteractionStatus();
  });

  pi.events.on("bash-bg:update", applyBashBgSnapshot);
  pi.events.on("loop:update", applyLoopSnapshot);

  pi.events.on(COCKPIT_UI_OWNERSHIP_EVENT, (payload) => {
    if (!payload || typeof payload !== "object") return;
    const ownership = payload as {
      agents?: unknown;
      sessionList?: unknown;
      quiet?: unknown;
      quietSymbols?: unknown;
    };
    cockpitOwnsAgents = ownership.agents === true;
    cockpitOwnsSessionList = ownership.sessionList === true;
    setQuietMode(ownership.quiet === true, ownership.quietSymbols);
    updateAgentWidget();
  });

  // Cockpit agent list commands: interrupt (打断) aborts the current turn with
  // a canned continue notice; steer (引导) interrupts and injects the user's
  // message. Both reuse the steer RPC (Pi abort → prompt), so a stalled agent
  // stuck in a tool is woken instead of left showing a hung tool forever.
  pi.events.on(TEAMMATE_AGENT_COMMAND_EVENT, (payload) => {
    void applyTeammateAgentCommand(
      state,
      pi,
      (correlationId, label, message) =>
        deliverLocalAgentMessage(correlationId, label, message, "steer"),
      payload,
    );
  });
  pi.events.on(TEAMMATE_STARTED_EVENT, () => {
    markWorkspacePeerDirty();
    updateAgentWidget();
    startWidgetTimer();
  });
  pi.events.on(TEAMMATE_COMPLETE_EVENT, () => {
    markWorkspacePeerDirty();
    setTimeout(() => {
      enforceWakeableAgentBudget(state);
      updateAgentWidget();
      if (!hasTeammateWidgetWork(state)) {
        stopWidgetTimer();
        scheduleWakeableEvictionTimer();
      }
    }, 100);
  });
  pi.events.on(TEAMMATE_MESSAGE_EVENT, markWorkspacePeerDirty);

  // =========================================================================
  // Session lifecycle — agents live until session ends
  // =========================================================================

  pi.on("session_start", (event, ctx) => {
    registerTeammateSettings();
    state.sessionGeneration = (state.sessionGeneration ?? 0) + 1;
    widgetCtx = ctx;
    exitMonitorInteractionMode();
    installMonitorEscapeTap(ctx.ui);
    setPersistentUi(ctx.ui, true);
    state.baseCwd = ctx.cwd;
    // Monitor ledger + config bind to the real session cwd.
    monitorLedgerRoot = ctx.cwd;
    monitorConfig = loadMonitorConfigForRoot(ctx.cwd);
    // Mailbox is bound to the real session cwd (workspace isolation).
    rebindMailboxHostForSession();
    refreshModelCatalog(ctx);
    void refreshModelRegistry(ctx);
    tool.description = buildTeammateToolDescription(ctx.cwd);
    pi.registerTool(tool);
    state.currentSessionId = ctx.sessionManager?.getSessionId() ?? null;
    sessionHostRegistry?.thread.rebuild(ctx.sessionManager?.getEntries?.() ?? []);
    if (shouldReplayWorkspaceRootQueue(event.reason)) replayQueuedIncomingRootMessages(ctx);
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    const isAgentSession = Array.from(state.activeRuns.values()).some((agent) => agent.sessionFile === sessionFile);
    if (sessionFile && !isAgentSession) state.mainSessionFile = sessionFile;
    startWorkspacePeers(ctx);
    void workspacePeerLifecycle.then(() => reconcileMonitorLedgerAtStart(ctx));
    // Query after all extensions have registered their event listeners. The
    // update is cached even if the async workspace publisher is still starting.
    pi.events.emit("bash-bg:query", undefined);
    pi.events.emit("loop:query", undefined);
    rebuildHistory(ctx);
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "custom" || event.message.customType !== "teammate-message") return;
    const details = event.message.details as Record<string, unknown> | undefined;
    if (details?.source !== "workspace-peer" || typeof details.messageId !== "string") return;
    const entry = sessionHostRegistry?.thread.get(details.messageId, "incoming");
    if (!entry
      || details.fromOwnerId !== entry.peerOwnerId
      || (entry.status !== "pending" && entry.status !== "queued")) return;
    const effectiveMode = details.mode === "steer" || details.mode === "follow_up"
      ? details.mode
      : entry.effectiveMode;
    sessionHostRegistry?.thread.reconcileInjected(
      entry.messageId,
      Math.max(entry.createdAt, Date.now()),
      effectiveMode,
    );
  });

  pi.on("input", async (event) => {
    if (event.source !== "interactive" || (event.images?.length ?? 0) > 0 || event.text.trim() !== "monitor") return;
    await monitorRegistry.requestWindowMode("enter");
    return { action: "handled" as const };
  });

  pi.on("before_agent_start", injectTeammateContext);

  // Turn-level advisor: low-frequency quality review of this session's turns.
  pi.on("agent_end", (event, ctx) => {
    void runAdvisorReview(event, ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    widgetCtx = ctx;
    installMonitorEscapeTap(ctx.ui);
    setPersistentUi(ctx.ui);
    state.baseCwd = ctx.cwd;
    // Rebind if compaction moved to a different workspace.
    rebindMailboxHostForSession();
    state.currentSessionId = ctx.sessionManager?.getSessionId() ?? null;
    workspacePeerSessionName = ctx.sessionManager?.getSessionName?.() ?? undefined;
    markWorkspacePeerDirty();
    syncMonitorInteractionStatus();
    updateAgentWidget();
  });

  pi.on("session_shutdown", async (event) => {
    const shutdownReason = event?.reason ?? "quit";
    if (shutdownReason === "quit" || shutdownReason === "reload") disposeTuiLocaleEvents();
    uninstallMonitorEscapeTap();
    disposeTeammateSettings();
    stopWidgetTimer();
    stopWakeableEvictionTimer();
    await monitorControllerInstance.shutdown();
    workspaceBackgroundJobs = [];
    activePromptLoopIds = [];
    workspacePeerLifecycle = workspacePeerLifecycle.then(async () => {
      await stopAllManagedWindows();
      await stopWorkspacePeers();
    });
    await workspacePeerLifecycle;
    // Stop the mailbox consumer BEFORE killing agents so no in-flight poll can
    // inject into a dying session (previously never stopped at all).
    const stoppedMailbox = mailboxHost;
    mailboxHost = undefined;
    mailboxWorkspaceId = undefined;
    rootGlobals[MAILBOX_REGISTRY_KEY] = undefined;
    monitorRegistry.replaceEndpoints([]);
    monitorRegistry.thread.rebuild([]);
    monitorRegistry.setMonitoredEndpointIds([]);
    exitMonitorInteractionMode();
    if (shutdownReason === "quit" || shutdownReason === "reload") {
      if (getSessionHostRegistry(rootGlobals) === sessionHostRegistry) {
        publishSessionHostRegistry(undefined, rootGlobals);
      }
      sessionHostRegistry = undefined;
    }
    void stoppedMailbox?.stop().catch((error) => {
      console.error(`[pi-maestro-teammate] mailbox host stop failed:`, error);
    });
    teardownRootSession();
  });
} // end if (!isChild)
} // end registerTeammateExtension
export * from "./teammate-helpers.ts";
import {
  agentActiveMs,
  applyAgentResultReadyState,
  applyAgentRetryState,
  bindAgentName,
  buildAgentList,
  buildRoleList,
  buildWatchOutput,
  cancelProxyDispatch,
  clearAgentResultReadyState,
  createTeammateInteractionQueue,
  emitComplete,
  enforceWakeableAgentBudget,
  findSettledAgent,
  handleProxyRequest,
  hasTeammateWidgetWork,
  killAgent,
  killAgentTree,
  markSettledResultInspectable,
  recordChildReclamationOutcome,
  nextWakeableAgentExpiryDelay,
  notifyBackgroundFailure,
  progressDurationMs,
  reclaimResultReadyAgents,
  resolveAgentCorrelationId,
  resolveLocalAgentSenderContext,
  resolveWatchTarget,
  safeSendMessage,
  settleAgent,
  settleGraphContainerAgent,
  settleGraphTaskAgent,
  statusForWatchTarget,
  sweepFailedAgents,
  sweepStalledAgents,
  ts,
  waitForTeammate,
  waitOutput,
} from "./teammate-helpers.ts";
import type { TeammateListView, TeammateWaitResult, TeammateWaitStatus } from "./teammate-helpers.ts";

