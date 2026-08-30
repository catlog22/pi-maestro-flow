/**
 * Teammate Extension Entry Point
 *
 * Tools: teammate (dispatch), teammate-send (RPC message injection), teammate-list (status), observe
 * TUI: Alt+R mode-aware session list, widget above editor, Alt+B foreground→background detach
 * Mode: RPC subprocess — stdin open for steer/follow_up/abort
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Check } from "typebox/value";
import { isGuiTeammateToolAllowed, registerGuiTool, unregisterGuiTool } from "../shared/gui-registry.ts";
import { Key, Text, decodeKittyPrintable, isKeyRelease, isKeyRepeat, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { loadTranscript, scanWorkspaceSessionDirs, groupTranscriptTurns, type WorkspaceSessionScan } from "../transcript/session-transcript.ts";
import type { TranscriptRow } from "../shared/transcript.ts";
import {
  LocalObserveParams,
  LocalTeammateListParams,
  MonitorQueryParams,
  ObserveParams,
  RemoteWorkerParams,
  TeammateListParams,
  TeammateMonitorParams,
  TeammateParams,
  TeammateSendParams,
  TeammateWaitParams,
  TeammateWatchParams,
  WorkspaceWindowParams,
} from "./schemas.ts";
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
  applyMonitorModeContext,
  formatMonitorQueryResult,
  runMonitorQuery,
  formatCompact,
  formatVerbose,
  formatHeader,
  formatBarrierCompact,
  validateMonitorParams,
  MONITOR_STATUS_KEY,
  MONITOR_DEFAULT_TIMEOUT_MS,
  MONITOR_DEFAULT_LINES,
  type MonitorTargetSnapshot,
  type MonitorParams,
  type MonitorQueryAuthorityFence,
  type MonitorQuerySnapshot,
  type MonitorQueryTimelineGroup,
} from "./monitor.ts";
import {
  MonitorToolExposureController,
  type MonitorCommunicationCapture,
} from "./monitor-tool-exposure.ts";
import {
  MonitorWindowLifecycleService,
  type MonitorWindowCreateRequest,
} from "./monitor-window-lifecycle.ts";
import {
  reduceMonitorWindowStateV1,
  type MonitorManagedWindowEvidenceV1,
  type MonitorWindowReductionItemV1,
  type MonitorWindowThreadEvidenceV1,
} from "./monitor-window-state.ts";
import {
  MONITOR_WINDOW_STATE_VERSION,
  readMonitorWindowFacets,
  type MonitorWindowCompletionEvidenceV1,
  type MonitorWindowFacetTargetV1,
  type MonitorWindowIdentityV1,
} from "../public/v1/monitor-window-state.ts";
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
  type DelegationTaskDraft,
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
  claimWorkspaceOwnerIdentity,
  createWorkspacePeerCommandConsumer,
  createWorkspacePeerRuntime,
  createWorkspaceWindowTerminalResult,
  decodeWorkspaceWindowTerminalResult,
  deriveWorkspaceWindowTerminalResult,
  discoverWorkspacePeers,
  encodeWorkspaceWindowTerminalResult,
  enqueueWorkspacePeerCommand,
  finalizeWorkspacePeerResponse,
  formatWorkspacePeerWindowListings,
  formatWorkspaceRemoteRootMessage,
  projectWorkspacePeerWindow,
  readWorkspacePeerResponse,
  resolveWorkspaceOwnerByName,
  resolveWorkspaceTarget,
  shouldReplayWorkspaceRootQueue,
  activeWorkspaceBackgroundJobsFromPayload,
  waitForWorkspacePeerCommandResponse,
  workspaceMainSessionDeliveryDecision,
  workspaceProtocolCommandId,
  workspaceWindowCompletionHandle,
  workspaceWindowLifecycle,
  workspaceWindowTerminalPublicationId,
  workspaceWindowTerminalReservationId,
  workspaceWindowTerminalResultMessageId,
  WORKSPACE_MAIN_SESSION_MARKER,
  MAIN_SESSION_PROGRESS_TEXT_BYTES,
  MAX_MAIN_SESSION_PROGRESS_EVENTS,
  type WorkspaceAgentSnapshot,
  type WorkspaceBackgroundJobSnapshot,
  type WorkspaceMainSessionProgress,
  type WorkspaceMainSessionProgressEvent,
  type WorkspaceMainSettle,
  type WorkspaceOwnerSnapshot,
  type WorkspaceOwnerState,
  type WorkspacePeerCommand,
  type WorkspacePeerCommandAction,
  type WorkspacePeerCommandConsumer,
  type WorkspacePeerPublisher,
  type WorkspacePeerWindowListing,
  type WorkspaceResolvedTarget,
  type WorkspaceSettledSnapshot,
  type WorkspaceWindowCompletionHandle,
  type WorkspaceWindowTerminalResult,
  type WorkspaceWindowTerminalResultDraft,
} from "./workspace-peers.ts";
import {
  createWindowSupervisorRuntimeActor,
  type WindowSupervisorRuntimeActor,
} from "./runtime-actor-host.ts";
import {
  registerWorkspaceProjectionDirtyListener,
} from "../public/v1/workspace-projections.ts";
import {
  workspaceSessionObservationSnapshot,
  workspaceTodosObservationSnapshot,
} from "./workspace-session-observation.ts";
import { workspaceTurnsSnapshot as workspaceTurnsSnapshotFn } from "./workspace-turns-observation.ts";
import {
  runSingleTeammate,
  runGraph,
  prepareTeammateMode,
  normalizeTeammateParams,
  inferGraphMode,
  taskDependencyNames,
  hasRpcTurnSidecar,
  sendRpcMessage,
  truncateUtf8Tail,
  truncateUtf8Head,
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
import { createForkSnapshot } from "../runs/fork-snapshot.ts";
import {
  auxToolCallFallback,
  auxToolResultFallback,
  renderCompletionOutboxMessage,
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
import { showModelAskOverlay } from "../tui/model-ask-overlay.ts";
import { sharedModelCircuitBreaker } from "../public/v1/retry.ts";
import { normalizePiRetryErrorMessage } from "../runs/retry.ts";
import {
  buildManagedWindowPiArgs,
  createChildTerminationController,
  getInteractiveTerminalLaunchSpec,
  getPiSpawnCommand,
  managedWindowSpawnEnv,
  singleRunParamsOf,
  terminateProcessTreeByPid,
  type ChildTerminationController,
} from "../runs/execution-infra.ts";
import { isManagedWorkerWindow } from "../runs/child-extensions.ts";
import type { SessionSelectionRow } from "../tui/session-send-overlay.ts";
import { loadRemoteConfig, loadRemoteConfigState } from "../remote/config.ts";
import { SshRemoteConnectionFactory } from "../remote/ssh.ts";
import { RemoteWorkerManager } from "../remote/worker-manager.ts";
import {
  createRemoteManagerPort,
  remoteMonitorEventSink,
  type RemoteManagerPortBinding,
} from "../backends/remote-workers.ts";
import {
  RemoteMonitorSession,
  sanitizeRemoteMonitorError,
  type RemoteMonitorRunListing,
  type RemoteMonitorTargetListing,
} from "./remote-monitor.ts";
import {
  RemoteWindowMonitor,
  type RemoteWindowMonitorListing,
} from "./remote-window-monitor.ts";
import {
  remoteWindowIncomingThreadEntry,
  remoteWindowReceiptThreadStatus,
} from "./remote-window-session.ts";
import type { RemoteWindowNotification } from "../remote/protocol.ts";
import { REMOTE_HISTORY_ENTRY_TYPE, type RemoteHistoryMode } from "../sessions/remote-history.ts";
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
  DeferredContextMessage,
  TeammateState,
  AgentProgress,
  AgentProgressSnapshot,
  ChildAgentCallSnapshot,
  ActiveAgent,
  AgentStatus,
  AgentTerminalStatus,
  AgentTurnEvent,
  AgentTurnTriggerContextV1,
  MessageEnvelope,
  MessageProvenanceV1,
  MessageSenderIdentityV1,
  SessionProjectionIdentity,
  SettledAgentRecord,
  SingleResult,
  TeammateInteractionRecord,
  VerifiedMessageProvenanceV1,
} from "../shared/types.ts";

type TeammateToolResult<T> = AgentToolResult<T> & { isError?: boolean };

function isTeammateToolResult(value: unknown): value is TeammateToolResult<unknown> {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.content)
    && Object.prototype.hasOwnProperty.call(record, "details")
    && (record.isError === undefined || typeof record.isError === "boolean");
}

type VerifiedProvenanceInput = Omit<
  VerifiedMessageProvenanceV1,
  "version" | "confidence" | "messageId"
> & { messageId?: string };

function createVerifiedProvenance(input: VerifiedProvenanceInput): VerifiedMessageProvenanceV1 {
  return {
    version: MESSAGE_PROVENANCE_VERSION,
    messageId: input.messageId ?? randomUUID(),
    source: input.source,
    messageKind: input.messageKind,
    deliveryMode: input.deliveryMode,
    confidence: "verified",
    sender: input.sender,
  };
}

function provenanceWithDeliveryMode(
  provenance: MessageProvenanceV1,
  deliveryMode: VerifiedMessageProvenanceV1["deliveryMode"],
): MessageProvenanceV1 {
  return provenance.confidence === "verified"
    ? { ...provenance, deliveryMode }
    : unknownMessageProvenanceV1({
        from: provenance.legacyLabel,
        messageId: provenance.messageId,
        messageKind: provenance.messageKind,
        deliveryMode,
      });
}

function sameMessageSender(left: MessageSenderIdentityV1, right: MessageSenderIdentityV1): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "unknown" || right.kind === "unknown") return left.kind === right.kind;
  return ("ownerId" in left ? left.ownerId : undefined) === ("ownerId" in right ? right.ownerId : undefined)
    && ("correlationId" in left ? left.correlationId : undefined) === ("correlationId" in right ? right.correlationId : undefined)
    && left.label === right.label;
}

import {
  TEAMMATE_COMPLETE_EVENT,
  TEAMMATE_STARTED_EVENT,
  TEAMMATE_MESSAGE_EVENT,
  AGENT_TURN_VERSION,
  MESSAGE_PROVENANCE_VERSION,
  normalizeMessageProvenanceV1,
  unknownMessageProvenanceV1,
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
import { projectSessionModelCatalog } from "../models/model-session-availability.ts";
import { sharedModelHealthCoordinator } from "../models/model-circuit-breaker.ts";
import {
  TEAMMATE_MODEL_SESSION_EVENT,
  TEAMMATE_MODEL_SESSION_PROTOCOL_VERSION,
  TEAMMATE_MODEL_SESSION_QUERY_EVENT,
  type TeammateModelSessionEventV1,
  type TeammateModelSessionQueryEventV1,
  type TeammateProgressMessageEvent,
} from "../public/v1/events.ts";
import {
  modelRegistryPairSync,
  publishedModelRegistryPairSync,
} from "../backends/registry-host.ts";
import {
  loadCliToolsConfig,
  toCliToolModelEntries,
} from "../cli-tools/cli-tools-config.ts";
import {
  applyModelRouting,
  appendTaskTypeRoutingContext,
  formatModelRoutingConfig,
  loadModelRoutingState,
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
import {
  aggregateAgentRunPhase,
  diagnoseAgentRuntime,
  projectAgentRuntime,
} from "../shared/agent-status.ts";
import {
  AGENT_TURN_EVENT_CUSTOM_TYPE,
  agentTurnLedgerAgent,
  applyAgentTurnEvent,
  createAgentTurnLedger,
  rebuildAgentTurnLedger,
  type AgentTurnLedger,
} from "../shared/turn-ledger.ts";
import {
  RUNTIME_READ_MODEL_DELTA_EVENT,
  RUNTIME_READ_MODEL_QUERY_EVENT,
  RUNTIME_READ_MODEL_SNAPSHOT_EVENT,
  RUNTIME_READ_MODEL_UNAVAILABLE_EVENT,
  RuntimeReadModelProjectionV2,
  createRuntimeReadModelDeltaV2,
  runtimeV2ReadEnabled,
  type RuntimeAgentReadEntityV2,
  type RuntimeReadModelSnapshotV2,
} from "../runtime-v2/read-model.ts";
import { RuntimeReadModelBrokerBridge } from "../runtime-v2/broker-read-model.ts";
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
  LOCAL_TEAMMATE_LIST_DESCRIPTION,
  LOCAL_TEAMMATE_LIST_SNIPPET,
  LOCAL_TEAMMATE_LIST_GUIDELINES,
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
  LOCAL_OBSERVE_DESCRIPTION,
  LOCAL_OBSERVE_SNIPPET,
  LOCAL_OBSERVE_GUIDELINES,
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
  displayResolvedModel,
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
  deferAgentContextMessage,
  takeDeferredAgentContext,
  restoreDeferredAgentContext,
  messageWithDeferredAgentContext,
  shouldPublishAdditionalTurn,
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
import { logDiagnosticError, logDiagnosticWarn } from "../shared/diagnostic-log.ts";
import { bindDiagnosticUi, registerDiagnosticCommand } from "./diagnostic-status.ts";
import type { TeammateRuntimeOptions, ProgressFlushGate, AgentWidgetTheme, AgentWidgetRow, AgentSelectorRow, PendingChildProxyRequest, ChildProxyPendingRequests, IpcSender } from "./teammate-core.ts";
import { buildHistoryRows, historyRowKey } from "./teammate-core.ts";
import { MailboxHost, mailboxModeFromEnv } from "./mailbox/host.ts";
import { RuntimeBrokerMailboxCommitter } from "../runtime-broker/mailbox-commit.ts";
import {
  getRuntimeBrokerStateDirectory,
  getRuntimeWorkspaceIdentity,
  type RuntimeWorkspaceIdentity,
} from "../runtime-broker/private-state.ts";
import { runtimeBrokerModeFromEnv } from "../runtime-broker/rollout.ts";
import { createDirectAgentHostRegistry, createMailboxHostRegistry, MAILBOX_REGISTRY_KEY } from "../public/v1/mailbox.ts";
import {
  SessionHostRegistry,
  WindowThreadStore,
  createLocalAgentMailboxTransportAdapter,
  createLocalRootTransportAdapter,
  createWorkspacePeerV1TransportAdapter,
  createRemoteWorkspaceRpcV1TransportAdapter,
  getSessionHostRegistry,
  publishSessionHostDirectoryRefresh,
  publishSessionHostRegistry,
  sessionRootEndpointId,
  normalizeSessionMessageKind,
  sessionMessageTriggersTurn,
  windowThreadReplayReceipt,
  SESSION_ENDPOINT_VERSION,
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
  type WindowThreadEntry,
  type WindowThreadEntryInput,
  type WindowThreadStatus,
} from "../sessions/session-core.ts";
import {
  formatWorkspaceWindowInbox,
  loadWorkspaceWindowInbox,
  resolveWindowInboxAnchor,
  type WindowInboxQuery,
} from "../sessions/window-inbox.ts";
import {
  localRootSessionCapabilities,
  projectTeammateSessionEndpoints,
} from "./session-endpoints.ts";
import {
  CompletionDeliveryCoordinator,
  type CompletionDeliveryEnvelope,
} from "../completion-outbox/coordinator.ts";
import type {
  CompletionDispatchSeed,
  CompletionResource,
} from "../public/v1/completion-durability.ts";

/** Shared-process bridge key: the root host publishes the live v1 mailbox registry here. */
export { MAILBOX_REGISTRY_KEY } from "../public/v1/mailbox.ts";


function completionWorkspaceIdentity(cwd: string): RuntimeWorkspaceIdentity {
  return cwd
    ? getRuntimeWorkspaceIdentity(cwd)
    : { canonicalPath: "", workspaceId: "0".repeat(64), legacyWorkspaceIds: [] };
}

function completionWorkspaceId(cwd: string): string {
  return completionWorkspaceIdentity(cwd).workspaceId;
}

function workspaceIdentityMatchesCwd(workspaceId: string, cwd: string): boolean {
  const identity = completionWorkspaceIdentity(cwd);
  return workspaceId === identity.workspaceId || identity.legacyWorkspaceIds.includes(workspaceId);
}

function resolvedRunLocation(requested: string | undefined, base: string): string {
  if (!requested) return base;
  if (requested.startsWith("remote:")) return requested;
  return isAbsolute(requested) ? normalize(requested) : resolve(base, requested);
}

function graphRunLocations(tasks: readonly { cwd?: string }[], base: string): string {
  const locations = [...new Set(tasks.map((task) => resolvedRunLocation(task.cwd, base)))];
  return locations.length === 1 ? locations[0]! : `graph · ${locations.length} locations`;
}

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

  pi.registerMessageRenderer<Details | { result?: SingleResult } | CompletionDeliveryEnvelope["details"]>(
    "teammate-complete",
    (message, options, theme) => {
      const rawDetails = message.details;
      const contentText = typeof message.content === "string"
        ? message.content
        : message.content.map((entry) => entry.type === "text" ? entry.text : "").filter(Boolean).join("\n");
      if (rawDetails && "source" in rawDetails && rawDetails.source === "completion-outbox") {
        return renderCompletionOutboxMessage(
          contentText,
          rawDetails,
          options.expanded,
          theme as ExtensionContext["ui"]["theme"],
        );
      }
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
  let monitorToolExposure: MonitorToolExposureController | undefined;

  const captureMonitorCommunication = (): MonitorCommunicationCapture | undefined =>
    monitorInteractionModeActive ? monitorToolExposure?.capture() : undefined;

  const ownsMonitorCommunication = (capture: MonitorCommunicationCapture | undefined): boolean =>
    monitorInteractionModeActive && monitorToolExposure?.isCurrent(capture) === true;

  pi.events.on(TEAMMATE_MODEL_SESSION_QUERY_EVENT, (payload) => {
    if (!payload || typeof payload !== "object") return;
    const query = payload as Partial<TeammateModelSessionQueryEventV1>;
    if (query.version !== TEAMMATE_MODEL_SESSION_PROTOCOL_VERSION
      || typeof query.requestId !== "string" || query.requestId.length === 0) return;
    const response: TeammateModelSessionEventV1 = {
      version: TEAMMATE_MODEL_SESSION_PROTOCOL_VERSION,
      requestId: query.requestId,
      isChild,
      hasCurrentRootMonitorAuthority: !isChild
        && ownsMonitorCommunication(captureMonitorCommunication()),
    };
    pi.events.emit(TEAMMATE_MODEL_SESSION_EVENT, response);
  });

  const refreshModelCatalog = (ctx: ExtensionContext): ModelCatalogSnapshot => {
    const hostEntries = ctx.modelRegistry?.getAvailable?.() ?? [];
    const pair = modelRegistryPairSync(ctx.cwd, { hostModels: hostEntries });
    if (pair !== undefined) sharedModelHealthCoordinator.reconcileProjection(pair.dispatch);
    const entries = pair === undefined
      ? (() => {
        const cliConfig = loadCliToolsConfig(ctx.cwd);
        const cliEntries = cliConfig ? toCliToolModelEntries(cliConfig) : [];
        return [...hostEntries, ...cliEntries];
      })()
      : projectSessionModelCatalog(pair.discovery, {
        isChild,
        hasCurrentRootMonitorAuthority: !isChild
          && ownsMonitorCommunication(captureMonitorCommunication()),
        health: (route) => ({
          healthy: sharedModelHealthCoordinator.isHealthy(route.modelRegistrationId),
        }),
      }).entries;
    const next = createModelCatalogSnapshot(entries);
    if (next.signature !== modelCatalog.signature) modelCatalog = next;
    return modelCatalog;
  };

  const refreshModelCatalogSources = async (ctx: ExtensionContext): Promise<ModelCatalogSnapshot> => {
    await refreshModelRegistry(ctx);
    return refreshModelCatalog(ctx);
  };

  /** Catalog id of the main session's current model, when one is active. */
  const sessionModelId = (ctx: ExtensionContext): string | undefined => {
    const model = ctx.model;
    if (!model) return undefined;
    const id = `${model.provider}/${model.id}`;
    return id.trim() ? id : undefined;
  };

  const injectTeammateContext = async (
    event: { systemPrompt: string },
    ctx: ExtensionContext,
  ): Promise<{ systemPrompt: string }> => {
    const withModels = appendModelCatalog(event.systemPrompt, await refreshModelCatalogSources(ctx));
    const withAgents = appendAgentCatalog(withModels, ctx.cwd);
    const withTaskType = canDispatchNestedTeammate
      ? appendTaskTypeRoutingContext(withAgents, ctx.cwd, discoverAgents(ctx.cwd), undefined, refreshModelCatalog(ctx).modelIds)
      : withAgents;
    const withDepth = appendTeammateDepthContext(withTaskType, currentDepth, currentMaxDispatchDepth);
    if (!monitorInteractionModeActive) monitorToolExposure?.syncInactive();
    return { systemPrompt: applyMonitorModeContext(withDepth, monitorInteractionModeActive) };
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
    const childCompletionCoordinator = new CompletionDeliveryCoordinator();

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
      const childSessionId = ctx.sessionManager.getSessionId();
      // Fence deliveries to the exact workspace + session identity captured at
      // bind time; compaction may keep the session id while changing cwd.
      const childWorkspaceIdentity = completionWorkspaceIdentity(ctx.cwd);
      const childWorkspaceId = childWorkspaceIdentity.workspaceId;
      const childSessionFile = ctx.sessionManager.getSessionFile?.();
      void childCompletionCoordinator.bindSession({
        target: {
          workspaceId: childWorkspaceId,
          sessionId: childSessionId,
          ...(process.env.PI_TEAMMATE_CORRELATION_ID
            ? { correlationId: process.env.PI_TEAMMATE_CORRELATION_ID }
            : {}),
        },
        legacyWorkspaceIds: childWorkspaceIdentity.legacyWorkspaceIds,
        entries: ctx.sessionManager.getEntries?.() ?? [],
        send(envelope: CompletionDeliveryEnvelope) {
          return bridge.ctx?.sessionManager.getSessionId() === childSessionId
            && bridge.ctx?.sessionManager.getSessionFile?.() === childSessionFile
            && completionWorkspaceId(bridge.ctx?.cwd ?? "") === childWorkspaceId
            // deliverAs: "steer" (not "followUp") so a replayed teammate-complete
            // is drained at the next turn boundary (right after the current tool
            // call finishes) instead of waiting for the agent to fully stop.
            // pi-core drains the steer queue every turn_end (agent-loop.js),
            // whereas followUp only drains when the agent would otherwise stop.
            && safeSendMessage(pi, envelope, { triggerTurn: true, deliverAs: "steer" });
        },
      }).catch((error) => {
        logDiagnosticWarn("[pi-maestro-teammate] child completion replay bind failed:", error);
      });
      void refreshModelCatalogSources(ctx);
      // Nested-context (proxy) tool: trimmed variant without the per-cwd routing
      // table; execution is proxied to the parent root process.
      proxyTeammateTool.description = buildTeammateToolDescription(ctx.cwd, { nested: true });
      if (canDispatchNestedTeammate) pi.registerTool(proxyTeammateTool);
    });
  pi.on("before_agent_start", injectTeammateContext);
    pi.on("session_compact", (_event, ctx) => publishSessionIdentity(ctx));
    pi.on("message_end", (event, ctx) => {
      publishSessionIdentity(ctx);
      void childCompletionCoordinator.receiveMessageEnd(event.message, {
        workspaceId: completionWorkspaceId(ctx.cwd),
        sessionId: ctx.sessionManager.getSessionId(),
        ...(process.env.PI_TEAMMATE_CORRELATION_ID
          ? { correlationId: process.env.PI_TEAMMATE_CORRELATION_ID }
          : {}),
      }).catch((error) => {
        logDiagnosticWarn("[pi-maestro-teammate] child completion message_end reconciliation failed:", error);
      });
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
    pi.on("session_shutdown", async () => {
      childCompletionCoordinator.unbindSession();
      try {
        await childCompletionCoordinator.drain();
      } finally {
        childCompletionCoordinator.dispose();
      }
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
      spawningToolCallId?: string,
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
          ...(spawningToolCallId ? { spawningToolCallId } : {}),
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
      action: "status" | "diagnose" | "wait",
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
      snapshot: (id, options) => proxyTeammateObservation(options.diagnose ? "diagnose" : "status", id, options),
      wait: (id, options) => proxyTeammateObservation("wait", id, options, options.signal),
    });

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
      async execute(id: string, params: RunTeammateParams, signal: AbortSignal) {
        return proxyCall<Details>("teammate", params, signal, id);
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
      // Cross-window sending is not Monitor-gated: window targets are only
      // discoverable through teammate-list (Monitor mode) or the sender
      // address carried by an incoming workspace message, so the send tool
      // always exposes the full cross-session contract.
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
      description: LOCAL_TEAMMATE_LIST_DESCRIPTION,
      promptSnippet: LOCAL_TEAMMATE_LIST_SNIPPET,
      promptGuidelines: LOCAL_TEAMMATE_LIST_GUIDELINES,
      parameters: LocalTeammateListParams,
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
      description: LOCAL_OBSERVE_DESCRIPTION,
      promptSnippet: LOCAL_OBSERVE_SNIPPET,
      promptGuidelines: LOCAL_OBSERVE_GUIDELINES,
      parameters: LocalObserveParams,
      async execute(_id: string, params: UnifiedObserveParams, signal: AbortSignal) {
        if (params.targets.some((target) => target.kind !== "teammate" && target.kind !== "bash_bg")) {
          const message = "Non-Monitor observe accepts only local teammate and bash_bg targets.";
          const denied: ObserveResult = {
            action: params.action,
            reason: params.action === "status" ? "snapshot" : "aborted",
            observations: [],
            durationMs: 0,
          };
          return {
            content: [{ type: "text", text: message }],
            isError: true,
            details: { output: [message], result: denied },
          };
        }
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
  const completionCoordinator = new CompletionDeliveryCoordinator();

  type RootSessionFence = Readonly<{
    generation: number;
    sessionId: string | null;
    workspaceId: string | undefined;
    sourceId: string | undefined;
  }>;
  const captureRootSessionFence = (): RootSessionFence => Object.freeze({
    generation: state.sessionGeneration ?? 0,
    sessionId: state.currentSessionId,
    workspaceId: state.currentWorkspaceId,
    sourceId: state.currentSourceId,
  });
  const ownsRootSessionFence = (fence: RootSessionFence): boolean =>
    (state.sessionGeneration ?? 0) === fence.generation
    && state.currentSessionId === fence.sessionId
    && state.currentWorkspaceId === fence.workspaceId
    && state.currentSourceId === fence.sourceId;
  const projectionForRootFence = (fence: RootSessionFence): SessionProjectionIdentity | undefined =>
    fence.sessionId && fence.workspaceId && fence.sourceId && fence.generation > 0
      ? {
        workspaceId: fence.workspaceId,
        sessionId: fence.sessionId,
        sourceId: fence.sourceId,
        generation: fence.generation,
      }
      : undefined;
  const staleRootSessionResult = (): SessionMessageResult => ({
    delivered: false,
    error: "The originating Pi session changed before delivery completed.",
  });
  const emitCurrentTeammateStarted = (
    agent: ActiveAgent,
    extra: Record<string, unknown> = {},
  ): void => {
    const projection = projectionForRootFence(captureRootSessionFence());
    emitTeammateStarted(pi, agent, {
      ...extra,
      ...(projection ? { projection } : {}),
    });
  };

  let agentTurnLedger: AgentTurnLedger = createAgentTurnLedger();

  const refreshAgentRuntimeProjection = (agent: ActiveAgent, now = Date.now()): void => {
    const folded = agentTurnLedgerAgent(agentTurnLedger, agent.correlationId);
    if (folded) {
      agent.turn = folded.current;
      agent.promptSeq = folded.current.promptSeq;
      agent.loopSeq = folded.current.loopSeq;
      agent.phase = folded.current.phase ?? agent.phase;
    }
    agent.runtime = projectAgentRuntime({
      status: agent.status,
      phase: agent.phase,
      resultReadyAt: agent.resultReadyAt,
      lastActivityAt: agent.lastActivityAt,
      pendingInteractions: agent.pendingInteractions?.size,
      turn: agent.turn,
    }, now);
  };

  let runtimeReadProjection = new RuntimeReadModelProjectionV2();
  let runtimeReadReady = false;
  let runtimeReadToken = 0;
  interface RuntimeReadHandle {
    readonly token: number;
    readonly fence: RootSessionFence;
    readonly cwd: string;
    readonly projection: SessionProjectionIdentity;
    bridge?: RuntimeReadModelBrokerBridge;
    refreshTimer?: ReturnType<typeof setInterval>;
    cancelled: boolean;
  }
  let runtimeReadHandle: RuntimeReadHandle | undefined;
  const ownsRuntimeReadHandle = (handle: RuntimeReadHandle): boolean =>
    runtimeReadHandle === handle
    && runtimeReadToken === handle.token
    && !handle.cancelled
    && ownsRootSessionFence(handle.fence)
    && completionWorkspaceId(handle.cwd) === handle.projection.workspaceId;
  const cancelRuntimeReadHandle = (handle: RuntimeReadHandle | undefined): void => {
    if (!handle || handle.cancelled) return;
    handle.cancelled = true;
    if (handle.refreshTimer) clearInterval(handle.refreshTimer);
    handle.refreshTimer = undefined;
  };

  const progressForRuntimeReadAgent = (agent: ActiveAgent): AgentProgressSnapshot | undefined => {
    const direct = agent.progress?.find((entry) => entry.correlationId === agent.correlationId);
    if (direct) return direct;
    for (const owner of state.activeRuns.values()) {
      const projected = owner.progress?.find((entry) => entry.correlationId === agent.correlationId);
      if (projected) return projected;
    }
    return undefined;
  };

  const runtimeReadEntity = (agent: ActiveAgent): RuntimeAgentReadEntityV2 => {
    refreshAgentRuntimeProjection(agent);
    const progress = progressForRuntimeReadAgent(agent);
    const generation = Math.max(1, agent.runtimeGeneration ?? 1);
    const lastMessage = progress?.lastMessage ?? agent.lastResult ?? agent.outputLog.at(-1);
    const projection = projectionForRootFence(captureRootSessionFence());
    return {
      correlationId: agent.correlationId,
      generation,
      ...(projection ? { projection } : {}),
      agent: agent.agent,
      ...(agent.name ? { name: agent.name } : {}),
      ...(agent.task ? { task: agent.task } : {}),
      ...(agent.spawnedBy ? {
        spawnedBy: agent.spawnedBy,
        parentCorrelationId: agent.spawnedBy,
      } : {}),
      status: agent.status,
      ...(agent.phase ? { phase: agent.phase } : {}),
      startedAt: agent.startedAt,
      lastActivityAt: agent.lastActivityAt,
      ...(agent.resultReadyAt === undefined ? {} : { resultReadyAt: agent.resultReadyAt }),
      ...(agent.runtime ? { runtime: structuredClone(agent.runtime) } : {}),
      ...(agent.turn ? { turn: structuredClone(agent.turn) } : {}),
      ...(agent.lastOutcome ? { lastOutcome: structuredClone(agent.lastOutcome) } : {}),
      ...(progress?.taskIndex === undefined ? {} : { taskIndex: progress.taskIndex }),
      ...(progress?.dependencies === undefined ? {} : { dependencies: [...progress.dependencies] }),
      ...(progress?.recentTools === undefined ? {} : { recentTools: structuredClone(progress.recentTools) }),
      ...(progress?.toolCount === undefined ? {} : { toolCount: progress.toolCount }),
      ...(progress?.tokens === undefined ? {} : { tokens: progress.tokens }),
      ...(progress?.inputTokens === undefined ? {} : { inputTokens: progress.inputTokens }),
      ...(progress?.outputTokens === undefined ? {} : { outputTokens: progress.outputTokens }),
      ...(progress?.cacheReadTokens === undefined ? {} : { cacheReadTokens: progress.cacheReadTokens }),
      ...(progress?.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: progress.cacheWriteTokens }),
      ...(agent.requestedModel === undefined ? {} : { requestedModel: agent.requestedModel }),
      ...(agent.resolvedModel === undefined ? {} : { resolvedModel: agent.resolvedModel }),
      ...(agent.attemptedModels === undefined ? {} : { attemptedModels: [...agent.attemptedModels] }),
      ...(lastMessage ? { lastMessage } : {}),
      ...(progress?.error ? { error: progress.error } : {}),
    };
  };

  const currentRuntimeReadAgents = (): RuntimeAgentReadEntityV2[] =>
    [...state.activeRuns.values()].map(runtimeReadEntity);

  const applyRuntimeReadSnapshot = (handle: RuntimeReadHandle, snapshot: RuntimeReadModelSnapshotV2): void => {
    if (!ownsRuntimeReadHandle(handle)) return;
    const previous = runtimeReadProjection.snapshot();
    if (!runtimeReadReady) {
      if (!runtimeReadProjection.applySnapshot(snapshot) || !ownsRuntimeReadHandle(handle)) return;
      runtimeReadReady = true;
      pi.events.emit(RUNTIME_READ_MODEL_SNAPSHOT_EVENT, runtimeReadProjection.snapshot());
      return;
    }
    if (snapshot.cursor === previous.cursor) {
      if (JSON.stringify(snapshot.agents) === JSON.stringify(previous.agents)) return;
      if (runtimeReadProjection.applySnapshot(snapshot) && ownsRuntimeReadHandle(handle)) {
        pi.events.emit(RUNTIME_READ_MODEL_SNAPSHOT_EVENT, runtimeReadProjection.snapshot());
      }
      return;
    }
    const delta = createRuntimeReadModelDeltaV2({
      previous,
      agents: snapshot.agents,
      source: snapshot.source,
      nextCursor: snapshot.cursor,
    });
    if (runtimeReadProjection.applyDelta(delta)) {
      if (ownsRuntimeReadHandle(handle)) pi.events.emit(RUNTIME_READ_MODEL_DELTA_EVENT, delta);
      return;
    }
    if (runtimeReadProjection.applySnapshot(snapshot) && ownsRuntimeReadHandle(handle)) {
      pi.events.emit(RUNTIME_READ_MODEL_SNAPSHOT_EVENT, runtimeReadProjection.snapshot());
    }
  };

  const failRuntimeReadModel = (handle: RuntimeReadHandle, error: unknown): void => {
    if (!ownsRuntimeReadHandle(handle)) return;
    runtimeReadReady = false;
    runtimeReadProjection = new RuntimeReadModelProjectionV2();
    pi.events.emit(RUNTIME_READ_MODEL_UNAVAILABLE_EVENT, {
      version: 2,
      projection: { ...handle.projection },
    });
    logDiagnosticWarn("[pi-maestro-teammate] Runtime V2 canonical read failed; v1 bridge remains active:", error);
  };

  const refreshRuntimeReadModel = async (handle = runtimeReadHandle): Promise<void> => {
    const bridge = handle?.bridge;
    if (!handle || !bridge || !ownsRuntimeReadHandle(handle)) return;
    try {
      const snapshot = await bridge.snapshot();
      if (ownsRuntimeReadHandle(handle) && handle.bridge === bridge) applyRuntimeReadSnapshot(handle, snapshot);
    } catch (error) {
      if (ownsRuntimeReadHandle(handle) && handle.bridge === bridge) failRuntimeReadModel(handle, error);
    }
  };

  const publishRuntimeReadSnapshot = (): void => {
    const handle = runtimeReadHandle;
    if (handle && ownsRuntimeReadHandle(handle) && runtimeReadReady) {
      pi.events.emit(RUNTIME_READ_MODEL_SNAPSHOT_EVENT, runtimeReadProjection.snapshot());
    }
    void refreshRuntimeReadModel(handle);
  };

  const publishRuntimeReadDelta = (): void => {
    const handle = runtimeReadHandle;
    const bridge = handle?.bridge;
    if (!handle || !bridge || !ownsRuntimeReadHandle(handle)) return;
    void bridge.publish(currentRuntimeReadAgents()).then((snapshot) => {
      if (ownsRuntimeReadHandle(handle) && handle.bridge === bridge) applyRuntimeReadSnapshot(handle, snapshot);
    }).catch((error) => {
      if (ownsRuntimeReadHandle(handle) && handle.bridge === bridge) failRuntimeReadModel(handle, error);
    });
  };

  const initializeRuntimeReadModel = async (cwd: string, sourceId: string): Promise<void> => {
    const fence = captureRootSessionFence();
    const projection = projectionForRootFence(fence);
    const token = ++runtimeReadToken;
    const previous = runtimeReadHandle;
    cancelRuntimeReadHandle(previous);
    runtimeReadReady = false;
    runtimeReadProjection = new RuntimeReadModelProjectionV2();
    if (!projection || projection.sourceId !== sourceId || completionWorkspaceId(cwd) !== projection.workspaceId) {
      runtimeReadHandle = undefined;
      await previous?.bridge?.close().catch(() => undefined);
      return;
    }
    const handle: RuntimeReadHandle = {
      token,
      fence,
      cwd,
      projection,
      cancelled: false,
    };
    runtimeReadHandle = handle;
    await previous?.bridge?.close().catch(() => undefined);
    if (!ownsRuntimeReadHandle(handle) || !runtimeV2ReadEnabled()) return;
    let bridge: RuntimeReadModelBrokerBridge | undefined;
    try {
      bridge = await RuntimeReadModelBrokerBridge.connect({
        cwd,
        sourceId,
        sessionId: projection.sessionId,
        sessionGeneration: projection.generation,
        readScope: "source",
      });
      if (!ownsRuntimeReadHandle(handle)) {
        await bridge.close();
        return;
      }
      handle.bridge = bridge;
      const snapshot = await bridge.publish(currentRuntimeReadAgents(), { reset: true });
      if (!ownsRuntimeReadHandle(handle) || handle.bridge !== bridge) {
        await bridge.close();
        return;
      }
      applyRuntimeReadSnapshot(handle, snapshot);
      if (!ownsRuntimeReadHandle(handle)) return;
      handle.refreshTimer = setInterval(() => void refreshRuntimeReadModel(handle), 500);
      handle.refreshTimer.unref?.();
    } catch (error) {
      if (!ownsRuntimeReadHandle(handle)) {
        await bridge?.close().catch(() => undefined);
        return;
      }
      failRuntimeReadModel(handle, error);
    }
  };

  const resolveRuntimeReadAgent = (selector: string): RuntimeAgentReadEntityV2 | undefined => {
    if (!runtimeReadReady || !runtimeV2ReadEnabled()) return undefined;
    const snapshot = runtimeReadProjection.snapshot();
    const exact = snapshot.agents.find((agent) => agent.correlationId === selector);
    if (exact) return exact;
    const normalized = selector.replace(/^@/, "").split("#", 1)[0];
    const named = snapshot.agents.filter((agent) => agent.name === normalized);
    return named.length === 1 ? named[0] : undefined;
  };

  const recordAgentTurnEvent = (event: AgentTurnEvent, fence?: RootSessionFence): void => {
    if (fence && !ownsRootSessionFence(fence)) return;
    const agent = state.activeRuns.get(event.correlationId);
    if (!agent || (agent.runtimeGeneration ?? 0) !== event.runtimeGeneration) return;
    const applied = applyAgentTurnEvent(agentTurnLedger, event);
    if (applied.status !== "applied") return;
    try {
      pi.appendEntry(AGENT_TURN_EVENT_CUSTOM_TYPE, event);
    } catch (error) {
      logDiagnosticError("[pi-maestro-teammate] failed to persist turn event:", error);
      return;
    }
    agentTurnLedger = applied.ledger;
    agent.turn = applied.agent.current;
    agent.promptSeq = applied.agent.current.promptSeq;
    agent.loopSeq = applied.agent.current.loopSeq;
    agent.phase = applied.agent.current.phase ?? agent.phase;
    agent.lastActivityAt = Math.max(agent.lastActivityAt, applied.agent.current.lastActivityAt);
    refreshAgentRuntimeProjection(agent, event.timestamp);
  };

  const bindStateTurnRecorder = (): void => {
    const fence = captureRootSessionFence();
    state.recordTurnEvent = (event) => recordAgentTurnEvent(event, fence);
  };
  bindStateTurnRecorder();

  const rebuildTurnLedger = (entries: readonly unknown[]): void => {
    const rebuilt = rebuildAgentTurnLedger(entries);
    agentTurnLedger = rebuilt.ledger;
    for (const agent of state.activeRuns.values()) refreshAgentRuntimeProjection(agent);
    if (rebuilt.rejected > 0) {
      logDiagnosticWarn(`[pi-maestro-teammate] ignored ${rebuilt.rejected} malformed persisted turn event(s).`);
    }
  };

  interface RootRemoteMonitorBinding {
    fence: RootSessionFence;
    monitorCapture: MonitorCommunicationCapture;
    session: RemoteMonitorSession;
    windows: RemoteWindowMonitor;
    /** Feeds the same event stream to the remote backend's subscribers. */
    port: RemoteManagerPortBinding;
  }

  let remoteMonitorBinding: RootRemoteMonitorBinding | undefined;
  let remoteWindowNotificationHandler: ((target: string, notification: RemoteWindowNotification) => void) | undefined;
  const remoteMonitorShutdowns = new Set<Promise<void>>();

  const currentRemoteMonitorBinding = (
    binding: RootRemoteMonitorBinding | undefined = remoteMonitorBinding,
  ): binding is RootRemoteMonitorBinding => Boolean(
    binding
    && remoteMonitorBinding === binding
    && ownsRootSessionFence(binding.fence)
    && ownsMonitorCommunication(binding.monitorCapture),
  );

  const ensureRemoteMonitorBinding = (): RootRemoteMonitorBinding => {
    const existing = remoteMonitorBinding;
    if (currentRemoteMonitorBinding(existing)) return existing;
    if (existing) throw new Error("The previous remote Monitor owner has not finished shutting down.");
    const fence = captureRootSessionFence();
    const monitorCapture = captureMonitorCommunication();
    if (!fence.sessionId) throw new Error("Remote workers require an active root Pi session.");
    if (!monitorCapture || !ownsMonitorCommunication(monitorCapture)) {
      throw new Error("Remote workers require active Monitor communication authority.");
    }
    const config = loadRemoteConfig(state.baseCwd || process.cwd());
    let session: RemoteMonitorSession | undefined;
    let binding: RootRemoteMonitorBinding | undefined;
    // Assigned on the statement after the manager is constructed, so it holds a
    // value long before any run starts. The optional chaining below exists for
    // the temporal dead zone the constructor argument sits in, not because the
    // port may legitimately be absent.
    let port: RemoteManagerPortBinding | undefined;
    const manager = new RemoteWorkerManager({
      config,
      connectionFactory: new SshRemoteConnectionFactory(),
      // Both consumers, one stream: the Monitor session records what
      // `observe kind=remote` and `teammate-list view=remote` show, and the
      // backend's subscribers are what a dispatched run folds into its outcome.
      // They share one connection and one ownership nonce because they read the
      // same runs.
      onEvent: remoteMonitorEventSink(
        (capture, event) => port?.publish(capture, event),
        (capture, event) => session?.recordEvent(capture, event),
      ),
      onSnapshot: (capture, snapshot) => session?.recordSnapshot(capture, snapshot),
    });
    port = createRemoteManagerPort(manager);
    session = new RemoteMonitorSession({
      config,
      manager,
      isCurrent: () => currentRemoteMonitorBinding(binding),
      persist: (entry) => {
        if (!currentRemoteMonitorBinding(binding)) return;
        try {
          pi.appendEntry(REMOTE_HISTORY_ENTRY_TYPE, entry);
        } catch (error) {
          logDiagnosticError("[pi-maestro-teammate] failed to persist bounded remote Monitor history:", error);
        }
      },
    });
    const windows = new RemoteWindowMonitor({
      config,
      connectionFactory: new SshRemoteConnectionFactory(),
      monitorOwnerNonce: manager.monitorOwnerNonce,
      isCurrent: () => currentRemoteMonitorBinding(binding),
      onNotification: (target, notification) => remoteWindowNotificationHandler?.(target, notification),
    });
    const createdBinding: RootRemoteMonitorBinding = { fence, monitorCapture, session, windows, port };
    binding = createdBinding;
    remoteMonitorBinding = createdBinding;
    return createdBinding;
  };

  const shutdownRemoteMonitorBinding = async (): Promise<void> => {
    const binding = remoteMonitorBinding;
    remoteMonitorBinding = undefined;
    if (binding) {
      const shutdown = Promise.allSettled([
        binding.session.shutdown(),
        binding.windows.close(),
      ]).then(() => undefined).finally(() => remoteMonitorShutdowns.delete(shutdown));
      remoteMonitorShutdowns.add(shutdown);
      await shutdown;
      return;
    }
    if (remoteMonitorShutdowns.size > 0) await Promise.allSettled([...remoteMonitorShutdowns]);
  };

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
  let workspaceWindowRuntimeActor: WindowSupervisorRuntimeActor | undefined;
  let workspacePeerGeneration = 0;
  let workspacePeerSessionName: string | undefined;
  let workspacePeerOwners: WorkspaceOwnerSnapshot[] = [];
  let workspaceBackgroundJobs: WorkspaceBackgroundJobSnapshot[] = [];
  let activePromptLoopIds: string[] = [];
  let workspaceMainSessionActivityAt: number | undefined;
  let workspaceMainSessionProgress: WorkspaceMainSessionProgress | undefined;
  let workspaceMainSessionProgressSequence = 0;
  let workspaceMainSessionProgressRevision = 0;
  let workspaceMainAssistantText = "";
  let workspaceMainAssistantEventOpen = false;
  // Newest assistant text this window has published, held until a settle takes
  // it. Distinct from `workspaceMainAssistantText`, which is the streaming
  // accumulator and is reset at every turn boundary.
  let workspaceMainSettledResult: string | undefined;
  let workspaceMainLastSettle: WorkspaceMainSettle | undefined;
  let workspaceCurrentTurnAssistantMessage: unknown;
  let workspaceTerminalResultDraft: WorkspaceWindowTerminalResultDraft | undefined;
  let workspaceTerminalResultState = { settled: false, terminalPublished: false };
  const workspaceTerminalResultPublications = new Map<string, Promise<boolean>>();
  const workspaceTerminalCompletionPublications = new Map<string, Promise<boolean>>();
  let workspaceReceiptReconcileTimer: ReturnType<typeof setInterval> | undefined;
  let periodicCompletionReconcile: Promise<void> | undefined;
  let workspacePeerRefresh: {
    publisher: WorkspacePeerPublisher;
    fence: RootSessionFence;
    promise: Promise<WorkspaceOwnerSnapshot[]>;
  } | undefined;
  let workspacePeerLifecycle = Promise.resolve();
  let sessionHostRegistry: SessionHostRegistry | undefined;

  const currentRootOwnerId = (): string =>
    workspacePeerPublisher?.identity.ownerId
      ?? state.currentSessionId
      ?? `process-${process.pid}`;

  const workspaceTerminalCompletionSeed = (
    request: Pick<WindowThreadEntry, "messageId" | "workspaceId" | "createdAt" | "targetSessionId">,
  ): CompletionDispatchSeed | undefined => {
    const sessionId = request.targetSessionId ?? state.currentSessionId;
    if (!sessionId || (state.currentSessionId !== null && state.currentSessionId !== sessionId)) return undefined;
    return {
      dispatchId: request.messageId,
      deliveryGroupId: request.messageId,
      reservationId: workspaceWindowTerminalReservationId(request.messageId),
      mode: "single",
      target: { workspaceId: request.workspaceId, sessionId },
      replyTarget: "main",
      originCwd: state.baseCwd,
      expectedTasks: [request.messageId],
      createdAt: request.createdAt,
    };
  };

  /**
   * Thrown when no completion durability provider is registered in this
   * process. Callers must degrade to passive delivery (journal + mailbox +
   * deadline sweep), never fail the user operation — same convention as
   * teammate-proxy's "durable failed; using passive delivery" path.
   */
  class WorkspaceTerminalDurabilityUnavailableError extends Error {}

  const reserveWorkspaceTerminalCompletion = async (
    request: Pick<WindowThreadEntry, "messageId" | "workspaceId" | "createdAt" | "targetSessionId">,
  ): Promise<CompletionDispatchSeed> => {
    const seed = workspaceTerminalCompletionSeed(request);
    if (!seed) throw new Error("The parent session has no stable identity for terminal completion delivery.");
    const reservation = await completionCoordinator.beginDispatch(seed);
    if (!reservation.durable) {
      throw new WorkspaceTerminalDurabilityUnavailableError("Canonical completion durability is unavailable for this workspace request.");
    }
    await completionCoordinator.requireNotification({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      kind: "single",
      requiredAt: Date.now(),
    });
    return seed;
  };

  const senderIdentityForSessionMessage = (
    senderCorrelationId: string | undefined,
    source: SessionMessageRequest["source"],
  ): Exclude<MessageSenderIdentityV1, { kind: "unknown" }> => {
    if (senderCorrelationId && senderCorrelationId !== "caller") {
      const sender = state.activeRuns.get(senderCorrelationId);
      return {
        kind: "teammate-agent",
        ownerId: currentRootOwnerId(),
        correlationId: senderCorrelationId,
        label: sender?.name ?? sender?.agent ?? senderCorrelationId.slice(0, 8),
      };
    }
    if (source === "monitor") return { kind: "system", ownerId: currentRootOwnerId(), label: "monitor" };
    if (source === "user") return { kind: "human", ownerId: currentRootOwnerId(), label: "user" };
    return { kind: "root-agent", ownerId: currentRootOwnerId(), label: "main" };
  };

  /**
   * Canonical envelope for re-injecting a persisted incoming root message
   * (session-start replay and stale-queued re-drive). `details.mode` must
   * survive so message_end can finalize the thread entry and sender receipt.
   */
  const workspaceRootMessageEnvelope = (
    entry: WindowThreadEntry,
    options: { replayed?: boolean; redriven?: boolean } = {},
  ) => {
    // Window-thread entries only ever record cross-window steer/follow_up;
    // interrupt is local-only and never persisted here, but the union widened
    // with SessionMessageMode, so narrow defensively.
    const effectiveAction: "steer" | "follow_up" = entry.effectiveMode === "steer" ? "steer" : "follow_up";
    return {
      envelope: {
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
          provenance: normalizeMessageProvenanceV1(entry.provenance, {
            from: entry.fromSessionName ?? `owner-${entry.peerOwnerId.slice(0, 8)}`,
            messageId: entry.messageId,
            messageKind: entry.messageKind ?? "message",
            deliveryMode: effectiveAction,
          }),
          ...(options.replayed ? { replayed: true } : {}),
          ...(options.redriven ? { redriven: true } : {}),
        },
      },
      effectiveAction,
    };
  };

  const replayQueuedIncomingRootMessages = (
    ctx: ExtensionContext,
    reason: "startup" | "reload" | "new" | "resume" | "fork",
  ): void => {
    const registry = sessionHostRegistry;
    if (!registry) return;
    const workspaceId = workspaceIdForCwd(ctx.cwd);
    const currentSessionId = ctx.sessionManager?.getSessionId?.();
    for (const entry of registry.thread.list()) {
      if (entry.direction !== "incoming"
        || (entry.status !== "pending" && entry.status !== "queued")
        || entry.workspaceId !== workspaceId
        || entry.targetCorrelationId !== WORKSPACE_MAIN_SESSION_MARKER
        || !shouldReplayWorkspaceRootQueue(reason, entry.targetSessionId, currentSessionId)) continue;
      // Replay now matches redrive's per-message cap (QUEUED_ROOT_REDRIVE_MAX)
      // to prevent unbounded replay on repeated restart.
      const replayCount = replayedIncoming.get(entry.messageId) ?? 0;
      if (replayCount >= QUEUED_ROOT_REDRIVE_MAX) continue;
      replayedIncoming.set(entry.messageId, replayCount + 1);
      const { envelope, effectiveAction } = workspaceRootMessageEnvelope(entry, { replayed: true });
      const replayTriggerTurn = sessionMessageTriggersTurn(entry.messageKind);
      const delivered = safeSendMessage(pi, envelope, {
        triggerTurn: replayTriggerTurn,
        deliverAs: "followUp",
      });
      if (!delivered) registry.thread.transition(entry.messageId, "incoming", "rejected", Date.now(), effectiveAction);
      else if (!replayTriggerTurn) registry.thread.transition(entry.messageId, "incoming", "injected", Date.now(), effectiveAction);
    }
  };

  const QUEUED_ROOT_REDRIVE_DELAY_MS = 60_000;
  const QUEUED_ROOT_REDRIVE_COOLDOWN_MS = 60_000;
  const QUEUED_ROOT_REDRIVE_MAX = 2;
  const redrivenIncoming = new Map<string, { count: number; at: number }>();
  const replayedIncoming = new Map<string, number>();

  /**
   * Delivery recovery for accepted-but-never-injected root messages. The pi
   * host can drop a followUp/triggerTurn send (aborted turns, cleared follow-up
   * queues, run-state races), leaving the thread entry and the sender receipt
   * at "queued" forever. Re-drive stale entries with a bounded per-message
   * budget; message_end finalizes the entry and receipt once the message
   * actually lands.
   */
  const redriveStaleIncomingRootMessages = (): void => {
    const registry = sessionHostRegistry;
    if (!registry) return;
    const fence = captureRootSessionFence();
    if (!ownsRootSessionFence(fence)) return;
    const workspaceId = workspaceIdForCwd(state.baseCwd);
    const now = Date.now();
    for (const entry of registry.thread.list()) {
      if (entry.direction !== "incoming"
        || entry.status !== "queued"
        || entry.targetCorrelationId !== WORKSPACE_MAIN_SESSION_MARKER
        || entry.workspaceId !== workspaceId
        || entry.updatedAt > now - QUEUED_ROOT_REDRIVE_DELAY_MS) continue;
      const previous = redrivenIncoming.get(entry.messageId);
      if (previous
        && (previous.count >= QUEUED_ROOT_REDRIVE_MAX
          || now - previous.at < QUEUED_ROOT_REDRIVE_COOLDOWN_MS)) continue;
      const { envelope, effectiveAction } = workspaceRootMessageEnvelope(entry, { redriven: true });
      const redriveTriggerTurn = sessionMessageTriggersTurn(entry.messageKind);
      const delivered = safeSendMessage(pi, envelope, {
        triggerTurn: redriveTriggerTurn,
        deliverAs: effectiveAction === "steer" ? "steer" : "followUp",
      });
      if (!delivered) continue;
      redrivenIncoming.set(entry.messageId, { count: (previous?.count ?? 0) + 1, at: now });
      registry.thread.transition(
        entry.messageId,
        "incoming",
        redriveTriggerTurn ? "queued" : "injected",
        now,
        effectiveAction,
      );
    }
  };

  const refreshSessionEndpointDirectory = (includeUnboundLocal = false): void => {
    const registry = sessionHostRegistry;
    const publisher = workspacePeerPublisher;
    const sshWindows = currentRemoteMonitorBinding(remoteMonitorBinding)
      ? remoteMonitorBinding.windows.listings()
      : [];
    if (!registry) return;
    if (!publisher && !includeUnboundLocal && sshWindows.length === 0) {
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
      monitorInteractionModeActive,
      sshWindows,
    ));
  };

  const markWorkspacePeerDirty = (): void => {
    workspacePeerPublisher?.markDirty();
    refreshSessionEndpointDirectory();
  };

  const appendWorkspaceMainProgressEvent = (event: WorkspaceMainSessionProgressEvent): void => {
    workspaceMainSessionProgressSequence += 1;
    workspaceMainSessionProgressRevision += 1;
    const events = [...(workspaceMainSessionProgress?.events ?? []), event]
      .slice(-MAX_MAIN_SESSION_PROGRESS_EVENTS);
    workspaceMainSessionProgress = {
      updatedAt: event.at,
      revision: workspaceMainSessionProgressRevision,
      sequence: workspaceMainSessionProgressSequence,
      baseCursor: workspaceMainSessionProgressSequence - events.length,
      events,
    };
    workspaceMainAssistantEventOpen = false;
    workspaceMainSessionActivityAt = event.at;
    markWorkspacePeerDirty();
  };

  const updateWorkspaceMainAssistantText = (text: string, at = Date.now()): void => {
    const bounded = truncateUtf8Tail(text, MAIN_SESSION_PROGRESS_TEXT_BYTES);
    if (!bounded) return;
    workspaceMainSessionProgressRevision += 1;
    const events = [...(workspaceMainSessionProgress?.events ?? [])];
    const event: WorkspaceMainSessionProgressEvent = { kind: "assistant", at, text: bounded };
    if (workspaceMainAssistantEventOpen && events.at(-1)?.kind === "assistant") {
      events[events.length - 1] = event;
    } else {
      events.push(event);
      workspaceMainSessionProgressSequence += 1;
    }
    const retainedEvents = events.slice(-MAX_MAIN_SESSION_PROGRESS_EVENTS);
    workspaceMainSessionProgress = {
      updatedAt: at,
      revision: workspaceMainSessionProgressRevision,
      sequence: workspaceMainSessionProgressSequence,
      baseCursor: workspaceMainSessionProgressSequence - retainedEvents.length,
      events: retainedEvents,
    };
    workspaceMainAssistantEventOpen = true;
    workspaceMainSessionActivityAt = at;
    workspaceMainSettledResult = bounded;
    markWorkspacePeerDirty();
  };

  /**
   * Record the settle an observer will read, and clear the text it consumed.
   *
   * Clearing is what stops one run's result from being reported as the next
   * run's: a turn that produces no assistant text settles with no result at
   * all, which is the honest answer, rather than inheriting the previous one.
   */
  const recordWorkspaceMainSettle = (at: number): void => {
    const lastResult = workspaceMainSettledResult;
    workspaceMainSettledResult = undefined;
    workspaceMainLastSettle = { at, ...(lastResult === undefined ? {} : { lastResult }) };
  };

  const workspaceAssistantMessageText = (message: unknown): string | undefined => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") return undefined;
    if (typeof record.content === "string") return record.content;
    if (!Array.isArray(record.content)) return undefined;
    const text = record.content
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string)
      .join("\n");
    return text || undefined;
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
    const publisher = workspacePeerPublisher;
    if (!publisher) return [];
    const fence = captureRootSessionFence();
    const existing = workspacePeerRefresh;
    if (existing
      && existing.publisher === publisher
      && existing.fence.generation === fence.generation
      && existing.fence.sessionId === fence.sessionId
      && existing.fence.workspaceId === fence.workspaceId
      && existing.fence.sourceId === fence.sourceId) return existing.promise;

    let reservation!: NonNullable<typeof workspacePeerRefresh>;
    const promise = discoverWorkspacePeers(publisher.identity, { cleanupStale: true })
      .then((result) => {
        if (workspacePeerPublisher !== publisher || !ownsRootSessionFence(fence)) return workspacePeerOwners;
        workspacePeerOwners = result.peers;
        reconcileManagedWindowOwners();
        refreshSessionEndpointDirectory();
        return workspacePeerOwners;
      })
      .catch((error) => {
        if (workspacePeerPublisher === publisher && ownsRootSessionFence(fence)) {
          logDiagnosticError("[pi-maestro-teammate] workspace peer discovery failed:", error);
        }
        return workspacePeerOwners;
      })
      .finally(() => {
        if (workspacePeerRefresh === reservation) workspacePeerRefresh = undefined;
      });
    reservation = { publisher, fence, promise };
    workspacePeerRefresh = reservation;
    return promise;
  };

  /** Destructive operations require a fresh discovery result, never the stale fallback cache. */
  const refreshWorkspacePeerOwnersStrict = async (): Promise<WorkspaceOwnerSnapshot[]> => {
    const publisher = workspacePeerPublisher;
    if (!publisher) throw new Error("Workspace peer discovery is unavailable.");
    const fence = captureRootSessionFence();
    const pending = workspacePeerRefresh;
    if (pending?.publisher === publisher
      && pending.fence.generation === fence.generation
      && pending.fence.sessionId === fence.sessionId
      && pending.fence.workspaceId === fence.workspaceId
      && pending.fence.sourceId === fence.sourceId) await pending.promise;
    if (workspacePeerPublisher !== publisher || !ownsRootSessionFence(fence)) {
      throw new Error("Workspace peer discovery session changed before refresh.");
    }
    const result = await discoverWorkspacePeers(publisher.identity, { cleanupStale: true });
    if (workspacePeerPublisher !== publisher || !ownsRootSessionFence(fence)) {
      throw new Error("Workspace peer discovery session changed during refresh.");
    }
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
    const localState = buildWorkspaceOwnerState(state, workspacePeerSessionName, currentContextPressure(), undefined, workspaceMainSessionActivityAt);
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

  const workspacePeerWindowListings = (): WorkspacePeerWindowListing[] =>
    workspacePeerOwners.map(projectWorkspacePeerWindow);

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
    const relay = /^relay:([a-f0-9]{32})$/.exec(requested);
    if (relay) {
      const entry = [...(sessionHostRegistry?.thread.list() ?? [])].reverse().find((candidate) =>
        candidate.direction === "incoming"
        && candidate.replyTo === requested
        && candidate.peerOwnerId === relay[1]
        && candidate.workspaceId === publisher.identity.workspaceId
      );
      if (!entry) return undefined;
      return {
        scope: "remote",
        ownerId: entry.peerOwnerId,
        ownerNonce: entry.peerOwnerNonce,
        state: "active",
        agent: {
          correlationId: WORKSPACE_MAIN_SESSION_MARKER,
          agent: "relay",
          status: "running",
          startedAt: entry.createdAt,
          lastActivityAt: entry.updatedAt,
        },
      };
    }
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
        buildWorkspaceOwnerState(state, workspacePeerSessionName, currentContextPressure(), undefined, workspaceMainSessionActivityAt),
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
    const fence = captureRootSessionFence();
    const { message, mode, signal } = request;
    const source = request.source ?? "system";
    const authorized = (): boolean => request.source === "monitor"
      ? request.authorize?.() === true
      : request.authorize?.() !== false;
    const authorityRevoked = (): SessionMessageResult => ({
      delivered: false,
      error: source === "monitor"
        ? "Monitor communication authority was revoked before workspace publication."
        : "Session delivery authority was revoked before workspace publication.",
    });
    if (!authorized()) return authorityRevoked();
    if (mode === "abort") return { delivered: false, error: "Cross-session abort is not supported." };
    await workspacePeerLifecycle;
    if (!ownsRootSessionFence(fence)) return staleRootSessionResult();
    if (!authorized()) return authorityRevoked();
    await refreshWorkspacePeerOwners();
    if (!ownsRootSessionFence(fence)) return staleRootSessionResult();
    if (!authorized()) return authorityRevoked();
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
      return { delivered: false, error: `Workspace target "${query}" was not found. Use teammate-list with view=windows in Monitor mode, or the sender address from a received workspace message.` };
    }
    if (target.state !== "active") {
      return { delivered: false, error: `Workspace target "${query}" is settled and cannot receive commands.` };
    }
    const registry = sessionHostRegistry;
    if (!registry) return { delivered: false, error: "Session delivery journal is unavailable." };
    const commandCreatedAt = Date.now();
    let terminalCompletionSeed: CompletionDispatchSeed | undefined;
    if (request.terminalResultRequested === true) {
      if (!request.messageId) {
        return { delivered: false, error: "Terminal result requests require a stable message identity." };
      }
      if (target.agent.correlationId !== WORKSPACE_MAIN_SESSION_MARKER
        || request.messageKind !== "request") {
        return { delivered: false, error: "Terminal results can only be requested from a workspace root using message kind request." };
      }
      try {
        terminalCompletionSeed = await reserveWorkspaceTerminalCompletion({
          messageId: request.messageId,
          workspaceId: publisher.identity.workspaceId,
          createdAt: commandCreatedAt,
          ...(fence.sessionId === null ? {} : { targetSessionId: fence.sessionId }),
        });
      } catch (error) {
        if (!(error instanceof WorkspaceTerminalDurabilityUnavailableError)) {
          return {
            delivered: false,
            error: `Terminal completion reservation failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        // No durability provider in this process (e.g. Flow extension not
        // loaded): deliver anyway. The worker still publishes its terminal
        // envelope to the mailbox and the deadline/pid sweep finalizes
        // best-effort; only canonical outbox notification is lost.
        logDiagnosticWarn(`[pi-maestro-teammate] ${error.message} Delivering ${request.messageId} without canonical completion tracking.`);
      }
    }
    const abandonTerminalCompletion = async (reason: string): Promise<void> => {
      if (!terminalCompletionSeed) return;
      await completionCoordinator.abandon(terminalCompletionSeed, reason).catch((error) => {
        logDiagnosticWarn("[pi-maestro-teammate] terminal completion reservation cleanup failed:", error);
      });
      terminalCompletionSeed = undefined;
    };
    let outgoing: WindowThreadEntryInput | undefined;
    let publicationStage: "published" | "accepted" | "rejected" | undefined;
    try {
      // Workspace peers only carry steer/follow_up; interrupt is a local
      // soft-interrupt that must not cross a window boundary.
      const peerAction: WorkspacePeerCommandAction = mode === "steer" ? "steer" : "follow_up";
      const command = await enqueueWorkspacePeerCommand(publisher.identity, target, peerAction, message, {
        now: commandCreatedAt,
        commandId: workspaceProtocolCommandId(request.messageId),
        source,
        messageKind: request.messageKind,
        provenance: request.provenance,
        traceId: request.traceId,
        replyTo: request.replyTo ?? `owner:${publisher.identity.ownerId}`,
        terminalResultRequested: request.terminalResultRequested,
        fromSessionName: request.fromSessionName ?? workspacePeerSessionName,
        beforePublish(prepared) {
          if (!authorized()) {
            throw new Error(source === "monitor"
              ? "Monitor communication authority was revoked before command publication."
              : "Session delivery authority was revoked before command publication.");
          }
          if (!ownsRootSessionFence(fence)) {
            throw new Error("The originating Pi session changed before command publication.");
          }
          outgoing = {
            messageId: prepared.commandId,
            workspaceId: prepared.workspaceId,
            peerOwnerId: prepared.toOwnerId,
            peerOwnerNonce: prepared.toOwnerNonce,
            direction: "outgoing",
            source,
            ...(prepared.messageKind === undefined ? {} : { messageKind: prepared.messageKind }),
            ...(prepared.provenance === undefined ? {} : { provenance: prepared.provenance }),
            ...(prepared.traceId === undefined ? {} : { traceId: prepared.traceId }),
            ...(prepared.replyTo === undefined ? {} : { replyTo: prepared.replyTo }),
            ...(prepared.terminalResultRequested === undefined ? {} : { terminalResultRequested: prepared.terminalResultRequested }),
            ...(prepared.fromSessionName === undefined ? {} : { fromSessionName: prepared.fromSessionName }),
            ...(fence.sessionId === null ? {} : { targetSessionId: fence.sessionId }),
            targetCorrelationId: prepared.targetCorrelationId,
            mode,
            body: message,
            status: "pending",
            createdAt: prepared.createdAt,
            updatedAt: prepared.createdAt,
          };
          registry.thread.record(outgoing);
        },
        beforeCommit() {
          if (!authorized()) {
            throw new Error(source === "monitor"
              ? "Monitor communication authority was revoked before command commit."
              : "Session delivery authority was revoked before command commit.");
          }
          if (!ownsRootSessionFence(fence)) {
            throw new Error("The originating Pi session changed before command commit.");
          }
        },
      });
      if (!ownsRootSessionFence(fence)) return staleRootSessionResult();
      publicationStage = "published";
      const publishedOutgoing = outgoing;
      if (!publishedOutgoing) throw new Error("Workspace command was published without a durable outgoing journal entry.");
      let response: Awaited<ReturnType<typeof waitForWorkspacePeerCommandResponse>>;
      try {
        response = await waitForWorkspacePeerCommandResponse(publisher.identity, command, { signal });
      } catch (error) {
        if (!ownsRootSessionFence(fence)) return staleRootSessionResult();
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
      if (!ownsRootSessionFence(fence)) return staleRootSessionResult();
      const effectiveMode = response?.effectiveAction ?? mode;
      const deliveryStage = response?.deliveryStage ?? "queued";
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
      if (response?.status === "accepted"
        && (effectiveMode === "steer" || effectiveMode === "follow_up")
        && workspaceWindowRuntimeActor) {
        const runtimeActor = workspaceWindowRuntimeActor;
        void (async () => {
          await runtimeActor.publishMessage("accepted", command.commandId, "outgoing", effectiveMode);
          if (deliveryStage === "injected" || deliveryStage === "replied") {
            await runtimeActor.publishMessage(deliveryStage, command.commandId, "outgoing", effectiveMode);
          }
        })().catch((error) => {
          logDiagnosticError("[pi-maestro-teammate] Runtime V2 workspace message shadow append failed:", error);
        });
      }
      if (!response || response.status === "expired") {
        return {
          delivered: false,
          error: `Timed out sending to workspace target "${query}". The message may still have been delivered; inspect teammate-list with view=inbox before retrying.`,
          receipt: { publicationStage, messageId: command.commandId },
        };
      }
      if (response.status !== "accepted") {
        await abandonTerminalCompletion("workspace target rejected the terminal result request");
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
          ...(request.messageKind === "status" ? { contextDeferred: true } : {}),
        },
      };
    } catch (error) {
      if (publicationStage === undefined) {
        await abandonTerminalCompletion("workspace terminal result request was not published");
      }
      if (outgoing && publicationStage === undefined && ownsRootSessionFence(fence)) {
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
    options?: {
      senderCorrelationId?: string;
      messageKind?: SessionMessageKind;
      provenance?: MessageProvenanceV1;
      source?: "session-router" | "mailbox" | "monitor";
      deliveryMode?: VerifiedMessageProvenanceV1["deliveryMode"];
    },
  ): { body: string; from: string; provenance: MessageProvenanceV1 } => {
    const sender = resolveLocalAgentSenderContext(state, options?.senderCorrelationId);
    const provenance = options?.provenance === undefined
      ? createVerifiedProvenance({
          source: options?.source ?? "session-router",
          messageKind: options?.messageKind ?? "coordination",
          deliveryMode: options?.deliveryMode ?? "follow_up",
          sender: senderIdentityForSessionMessage(options?.senderCorrelationId, "system"),
        })
      : normalizeMessageProvenanceV1(options.provenance, { from: sender.label });
    return {
      body: formatLocalAgentMessage({
        message: rawMessage,
        messageKind: options?.messageKind,
        senderLabel: sender.label,
        replyToSelector: sender.replyTo,
      }),
      from: sender.from,
      provenance,
    };
  };

  const deferPreparedAgentContext = (
    correlationId: string,
    targetLabel: string,
    prepared: { body: string; from: string; provenance: MessageProvenanceV1 },
    messageId?: string,
  ): void => {
    const agent = state.activeRuns.get(correlationId);
    if (!agent) throw new Error(`Agent "${targetLabel}" is no longer available.`);
    const provenance = provenanceWithDeliveryMode(prepared.provenance, "notify");
    const durableMessageId = provenance.messageId ?? messageId;
    deferAgentContextMessage(agent, prepared.body, durableMessageId);
    const deferred = agent.deferredContextMessages?.at(-1);
    if (deferred && deferred.messageId === durableMessageId) deferred.provenance = provenance;
    const now = Date.now();
    agent.inbox.push({
      id: durableMessageId ?? randomUUID(),
      from: prepared.from,
      to: targetLabel,
      kind: "notification",
      payload: prepared.body,
      timestamp: now,
      provenance,
    });
    agent.outputLog.push(`[${new Date(now).toISOString().slice(11, 19)}] ◀ status context deferred: ${prepared.body.slice(0, 100)}`);
    trimAgentBuffers(agent);
    agent.lastActivityAt = now;
    pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
      correlationId,
      from: prepared.from,
      to: targetLabel,
      mode: "follow_up",
      message: prepared.body,
      lastActivityAt: now,
      provenance,
      isSend: true,
    });
    markWorkspacePeerDirty();
  };

  function acknowledgeDeferredAgentContext(context: readonly DeferredContextMessage[]): void {
    const host = mailboxHost;
    if (!host) return;
    for (const entry of context) {
      const messageIds = [
        ...(entry.messageId === undefined ? [] : [entry.messageId]),
        ...(entry.messageIds ?? []),
      ];
      for (const messageId of new Set(messageIds)) {
        void host.service.acknowledge(messageId).then((acknowledged) => {
          if (!acknowledged) {
            logDiagnosticWarn(`[pi-maestro-teammate] deferred context acknowledgement was not applied: ${messageId}`);
          }
        }).catch((error) => {
          logDiagnosticWarn(`[pi-maestro-teammate] deferred context acknowledgement failed: ${messageId}`, error);
        });
      }
    }
  }

  const injectLocalAgentMessage = (
    correlationId: string,
    targetLabel: string,
    delivery: { body: string; from: string; provenance: MessageProvenanceV1 },
    requestedMode: "steer" | "follow_up" | "interrupt",
  ): { delivered: boolean; error?: string; mode?: RpcMessageMode; wasSleeping?: boolean } => {
    const messageFrom = delivery.from;
    const agent = state.activeRuns.get(correlationId);
    if (!agent) return { delivered: false, error: `Agent "${targetLabel}" is no longer available.` };
    if (!agent.stdin?.writable) {
      const deferredContext = takeDeferredAgentContext(agent);
      const message = messageWithDeferredAgentContext(deferredContext, delivery.body);
      const provenance = provenanceWithDeliveryMode(delivery.provenance, "prompt");
      const restarted = agent.status === "sleeping" && agent.restart?.(message, provenance) === true;
      if (!restarted) {
        restoreDeferredAgentContext(agent, deferredContext);
        return { delivered: false, error: `Agent "${targetLabel}" has no restorable runtime.` };
      }
      const restartDelivery = agent.restartDelivery;
      if (restartDelivery) {
        void restartDelivery.then((accepted) => {
          if (accepted) acknowledgeDeferredAgentContext(deferredContext);
          else restoreDeferredAgentContext(agent, deferredContext);
        }).catch(() => restoreDeferredAgentContext(agent, deferredContext));
      } else {
        // Custom synchronous restart implementations return true only after
        // accepting the prompt; the built-in asynchronous path always exposes
        // restartDelivery above.
        acknowledgeDeferredAgentContext(deferredContext);
      }
      const now = Date.now();
      if (!restartDelivery) agent.promptSeq = (agent.promptSeq ?? 0) + 1;
      agent.inbox.push({
        id: provenance.messageId ?? randomUUID(),
        from: messageFrom,
        to: targetLabel,
        kind: "task",
        payload: message,
        timestamp: now,
        provenance,
      });
      agent.outputLog.push(`[${new Date(now).toISOString().slice(11, 19)}] ◀ cold-resume prompt: ${message.slice(0, 100)}`);
      trimAgentBuffers(agent);
      emitCurrentTeammateStarted(agent);
      pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
        correlationId,
        from: messageFrom,
        to: targetLabel,
        mode: "prompt",
        message,
        lastActivityAt: now,
        provenance,
        isSend: true,
      });
      markWorkspacePeerDirty();
      return { delivered: true, mode: "prompt", wasSleeping: true };
    }
    if (!agent.lease || !canChildWrite(agent.lease)) {
      const ownership = agent.lease ? `${agent.lease.owner} (${agent.lease.state})` : "an unavailable lease";
      return { delivered: false, error: `Agent "${targetLabel}" is currently owned by ${ownership}.` };
    }
    const deferredContext = takeDeferredAgentContext(agent);
    const message = messageWithDeferredAgentContext(deferredContext, delivery.body);
    const mode: RpcMessageMode = agent.status === "sleeping"
      ? "prompt"
      : requestedMode === "follow_up" && agent.resultReadyAt !== undefined
        ? "prompt"
        : requestedMode;
    const provenance = provenanceWithDeliveryMode(delivery.provenance, mode);
    const turnTracked = hasRpcTurnSidecar(agent.stdin);
    const sent = sendRpcMessage(
      agent.stdin,
      message,
      mode,
      leaseToken(agent.lease),
      provenance,
    );
    if (!sent) {
      restoreDeferredAgentContext(agent, deferredContext);
      return { delivered: false, error: `Failed to send message to "${targetLabel}".` };
    }
    acknowledgeDeferredAgentContext(deferredContext);

    const now = Date.now();
    if (mode === "prompt" && !turnTracked) agent.promptSeq = (agent.promptSeq ?? 0) + 1;
    const wasSleeping = wakeSleepingAgent(
      pi,
      agent,
      now,
      projectionForRootFence(captureRootSessionFence()),
    );
    agent.inbox.push({
      id: provenance.messageId ?? randomUUID(),
      from: messageFrom,
      to: targetLabel,
      kind: "task",
      payload: message,
      timestamp: now,
      provenance,
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
      provenance,
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

  const workspaceIdForCwd = (cwd: string | undefined): string => completionWorkspaceId(cwd ?? "");

  const createMailboxHost = (): MailboxHost => {
    const rootCorrelationId = state.activeRuns.values().next().value?.correlationId;
    const workspaceId = workspaceIdForCwd(state.baseCwd);
    const ownerId = `host-${process.pid}`;
    const brokerCommitter = runtimeBrokerModeFromEnv() === "sqlite"
      ? new RuntimeBrokerMailboxCommitter({
          stateDirectory: getRuntimeBrokerStateDirectory(state.baseCwd),
          holderId: ownerId,
        })
      : undefined;
    brokerCommitter?.prewarm();
    mailboxWorkspaceId = workspaceId;
    const host = new MailboxHost({
      rootDir: join(homedir(), ".pi", "teammate", "mailbox"),
      state,
      rootCorrelationId,
      ownerId,
      workspaceId,
      legacyWorkspaceIds: completionWorkspaceIdentity(state.baseCwd).legacyWorkspaceIds,
      teamId: rootCorrelationId ?? "team-root",
      commitApplied: brokerCommitter === undefined
        ? undefined
        : async (envelope) => { await brokerCommitter.commitIfReady(envelope); },
      closeDispatchAuthority: brokerCommitter === undefined
        ? undefined
        : () => brokerCommitter.close(),
      inject: async (envelope) => {
        // Re-route the enqueued envelope back into the actual child stdin.
        const target = state.activeRuns.get(envelope.recipientCorrelationId);
        if (!target) throw new Error(`Agent "${envelope.recipientCorrelationId}" is no longer available.`);
        const sender = resolveLocalAgentSenderContext(
          state,
          envelope.senderId === "caller" ? undefined : envelope.senderId,
        );
        const prepared = {
          body: envelope.payload,
          from: sender.from,
          provenance: normalizeMessageProvenanceV1(envelope.provenance, {
            from: sender.label,
            messageId: envelope.messageId,
            messageKind: envelope.kind === "follow_up" || envelope.kind === "steer" ? "message" : envelope.kind,
            deliveryMode: envelope.mode,
          }),
        };
        if (envelope.mode === "notify" && envelope.kind === "follow_up") {
          deferPreparedAgentContext(
            envelope.recipientCorrelationId,
            target.name ?? target.correlationId,
            prepared,
            envelope.messageId,
          );
          return "deferred";
        }
        const mode: "steer" | "follow_up" = envelope.mode === "steer" ? "steer" : "follow_up";
        const delivery = injectLocalAgentMessage(
          envelope.recipientCorrelationId,
          target.name ?? target.correlationId,
          prepared,
          mode,
        );
        if (!delivery.delivered) throw new Error(delivery.error ?? `Failed to inject message into "${target.name ?? target.correlationId}".`);
        return "applied";
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
          provenance: request.provenance,
          source: "mailbox",
          deliveryMode: request.mode ?? "follow_up",
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
          provenance: request.provenance,
          source: "mailbox",
          deliveryMode: request.mode ?? "follow_up",
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
      logDiagnosticError(`[pi-maestro-teammate] mailbox host stop failed:`, error);
    });
  };

  const deliverLocalAgentMessage = async (
    correlationId: string,
    targetLabel: string,
    message: string,
    requestedMode: "steer" | "follow_up" | "interrupt",
    options?: {
      senderCorrelationId?: string;
      messageKind?: SessionMessageKind;
      provenance?: MessageProvenanceV1;
      preparedDelivery?: { body: string; from: string; provenance: MessageProvenanceV1 };
    },
  ): Promise<{ delivered: boolean; error?: string; mode?: RpcMessageMode; wasSleeping?: boolean; contextDeferred?: boolean }> => {
    const fence = captureRootSessionFence();
    const prepared = options?.preparedDelivery ?? prepareLocalAgentDelivery(message, {
      ...options,
      deliveryMode: requestedMode,
    });
    const senderId = options?.senderCorrelationId ?? "caller";
    // Trusted host status is context-only and remains ACCEPTED in the durable
    // mailbox until a substantive delivery consumes and acknowledges it.
    const agent = state.activeRuns.get(correlationId);
    if (options?.messageKind === "status" && agent) {
      const host = mailboxHost;
      if (!host) {
        deferPreparedAgentContext(correlationId, targetLabel, prepared);
        return { delivered: true, mode: "follow_up", contextDeferred: true };
      }
      try {
        const mailboxRequest = {
          senderId,
          recipientId: agent.name ?? targetLabel,
          recipientCorrelationId: correlationId,
          kind: "follow_up" as const,
          mode: "notify" as const,
          payload: prepared.body,
          provenance: provenanceWithDeliveryMode(prepared.provenance, "notify"),
        };
        const enqueued = await host.rollout.deliver(mailboxRequest);
        if (!enqueued.result.ok) {
          const reason = "message" in enqueued.result ? enqueued.result.message : "unknown error";
          return { delivered: false, error: reason, mode: "follow_up" };
        }
        return { delivered: true, mode: "follow_up", contextDeferred: true };
      } catch (error) {
        return {
          delivered: false,
          error: error instanceof Error ? error.message : String(error),
          mode: "follow_up",
        };
      }
    }
    // Durable mailbox authoritative path: enqueue and let the consumer inject.
    // Only for live agents with a writable stdin; sleeping agents needing
    // cold-resume (restart) keep the synchronous direct path so restart fires
    // before teammate-send returns (lifecycle contract).
    // `interrupt` must bypass the mailbox and hit stdin directly: it owns the
    // abort+prompt transaction that only a live stdin can serve. `steer` and
    // `follow_up` are queueable and may round-trip through the mailbox.
    const host = mailboxHost;
    if (host && host.mode === "authoritative" && requestedMode !== "interrupt" && agent?.stdin?.writable) {
      try {
        const mailboxRequest = {
          senderId,
          recipientId: agent?.name ?? targetLabel,
          recipientCorrelationId: correlationId,
          kind: "follow_up" as const,
          mode: "follow_up" as const,
          payload: prepared.body,
          provenance: prepared.provenance,
        };
        const enqueued = await host.rollout.deliver(mailboxRequest);
        if (!ownsRootSessionFence(fence)) {
          return { delivered: false, error: "The originating Pi session changed during local agent delivery.", mode: "follow_up" };
        }
        if (enqueued.result && !enqueued.result.ok) {
          // Surface the failure — never silently fall back to direct stdin.
          const reason = "message" in enqueued.result ? (enqueued.result as { message?: string }).message : "unknown error";
          logDiagnosticError(`[pi-maestro-teammate] mailbox delivery failed for ${targetLabel}: ${reason}`);
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
            provenance: prepared.provenance,
            isSend: true,
          });
          return { delivered: false, error: reason, mode: "follow_up" };
        }
        // Success accounting (inbox/outputLog/event) happens exactly once, in
        // injectLocalAgentMessage when the consumer actually injects.
        return { delivered: true, mode: "follow_up" };
      } catch (error) {
        if (!ownsRootSessionFence(fence)) {
          return { delivered: false, error: "The originating Pi session changed during local agent delivery.", mode: "follow_up" };
        }
        logDiagnosticError(`[pi-maestro-teammate] mailbox delivery failed for ${targetLabel}:`, error);
        return { delivered: false, error: error instanceof Error ? error.message : String(error), mode: "follow_up" };
      }
    }
    return injectLocalAgentMessage(correlationId, targetLabel, prepared, requestedMode);
  };

  const deliverLocalRootEndpoint = async (
    endpoint: SessionEndpoint,
    request: SessionMessageRequest,
  ): Promise<SessionMessageResult> => {
    if (!state.currentSessionId || endpoint.sessionId !== state.currentSessionId) {
      return { delivered: false, endpointId: endpoint.id, transport: "local-root", error: "The local root session endpoint is stale." };
    }
    const prepared = prepareLocalAgentDelivery(request.message, {
      senderCorrelationId: request.senderCorrelationId,
      messageKind: request.messageKind,
      provenance: request.provenance,
      deliveryMode: request.mode,
    });
    const contextDeferred = !sessionMessageTriggersTurn(request.messageKind);
    const delivered = safeSendMessage(pi, {
      customType: "teammate-message",
      content: prepared.body,
      display: true,
      details: {
        source: "session-router",
        endpointId: endpoint.id,
        mode: request.mode,
        provenance: prepared.provenance,
      },
    }, {
      triggerTurn: !contextDeferred,
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
          ...(contextDeferred ? { contextDeferred: true } : {}),
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
        ...(request.provenance === undefined ? {} : { provenance: request.provenance }),
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
        provenance: request.provenance,
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
        ...(result.contextDeferred ? { contextDeferred: true } : {}),
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

  const deliverRemoteWindowEndpoint = async (
    endpoint: SessionEndpoint,
    request: SessionMessageRequest,
  ): Promise<SessionMessageResult> => {
    if (request.mode !== "steer" && request.mode !== "follow_up") {
      return {
        delivered: false,
        endpointId: endpoint.id,
        transport: "remote-workspace-rpc-v1",
        error: "Remote Pi windows support only steer and follow_up.",
      };
    }
    const monitorCapture = captureMonitorCommunication();
    const binding = remoteMonitorBinding;
    const target = endpoint.target;
    if (!target || !currentRemoteMonitorBinding(binding) || !ownsMonitorCommunication(monitorCapture)) {
      return {
        delivered: false,
        endpointId: endpoint.id,
        transport: "remote-workspace-rpc-v1",
        error: "Remote window delivery requires the current root Monitor binding.",
      };
    }
    const listing = binding.windows.listing(target);
    if (!listing
      || listing.capture.ownerId !== endpoint.ownerId
      || listing.capture.ownerNonce !== endpoint.ownerNonce
      || listing.capture.generation !== endpoint.generation
      || listing.capture.gatewayWorkerId !== endpoint.sourceId
      || listing.capture.gatewayInstanceNonce !== endpoint.routeAuthority?.instanceNonce) {
      return {
        delivered: false,
        endpointId: endpoint.id,
        transport: "remote-workspace-rpc-v1",
        error: "Remote window capture changed before delivery.",
      };
    }
    const registry = sessionHostRegistry;
    const messageId = request.messageId ?? randomUUID();
    const createdAt = Date.now();
    const base = {
      messageId,
      workspaceId: endpoint.workspaceId,
      peerOwnerId: endpoint.ownerId,
      peerOwnerNonce: endpoint.ownerNonce,
      direction: "outgoing" as const,
      source: request.source ?? "system",
      ...(request.messageKind === undefined ? {} : { messageKind: request.messageKind }),
      ...(request.provenance === undefined ? {} : { provenance: request.provenance }),
      ...(request.traceId === undefined ? {} : { traceId: request.traceId }),
      replyTo: target,
      mode: request.mode,
      body: request.message,
      createdAt,
    };
    registry?.thread.record({ ...base, status: "pending", updatedAt: createdAt });
    try {
      const receipt = await binding.windows.send(target, request.mode, request.message, {
        messageId,
        source: request.source ?? "system",
        messageKind: request.messageKind ?? "message",
      });
      if (!currentRemoteMonitorBinding(binding) || !ownsMonitorCommunication(monitorCapture)) {
        return {
          delivered: false,
          endpointId: endpoint.id,
          transport: "remote-workspace-rpc-v1",
          error: "Monitor authority changed during remote window delivery.",
        };
      }
      const status = remoteWindowReceiptThreadStatus(receipt.status);
      registry?.thread.record({
        ...base,
        ...(receipt.effectiveMode === undefined ? {} : { effectiveMode: receipt.effectiveMode }),
        status,
        updatedAt: Math.max(createdAt, receipt.updatedAt),
      });
      return {
        delivered: receipt.status !== "rejected" && receipt.status !== "expired",
        endpointId: endpoint.id,
        transport: "remote-workspace-rpc-v1",
        ...(receipt.status === "rejected" || receipt.status === "expired" ? { error: receipt.detail ?? `Remote window message ${receipt.status}.` } : {}),
        receipt: {
          requestedMode: request.mode,
          effectiveMode: receipt.effectiveMode ?? request.mode,
          deliveryStage: receipt.status === "replied" ? "replied" : receipt.status === "injected" ? "injected" : "queued",
          publicationStage: receipt.status === "rejected" || receipt.status === "expired" ? "rejected" : receipt.status === "queued" ? "published" : "accepted",
          messageId,
          ...(request.traceId === undefined ? {} : { traceId: request.traceId }),
        },
      };
    } catch (error) {
      if (currentRemoteMonitorBinding(binding) && ownsMonitorCommunication(monitorCapture)) {
        registry?.thread.record({ ...base, status: "timeout", updatedAt: Date.now() });
      }
      return {
        delivered: false,
        endpointId: endpoint.id,
        transport: "remote-workspace-rpc-v1",
        error: sanitizeRemoteMonitorError(error, "window delivery"),
      };
    }
  };

  const legacyResolution = (request: SessionMessageRequest): SessionResolution => {
    const selector = request.selector;
    if (request.targetCorrelationId) {
      const pinned = sessionHostRegistry?.listEndpoints().find((candidate) =>
        candidate.correlationId === request.targetCorrelationId
      );
      if (pinned) return { code: "resolved", selector, endpoint: pinned, candidates: [pinned] };
    }
    const normalizedSelector = selector.startsWith("@") ? selector.slice(1) : selector;
    if (normalizedSelector === "root") {
      const endpoint = sessionHostRegistry?.listEndpoints().find((candidate) =>
        candidate.scope === "local" && candidate.kind === "root"
      );
      if (endpoint) return { code: "resolved", selector, selectorKind: "local-root", endpoint, candidates: [endpoint] };
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
    const exactRemoteWindow = sessionHostRegistry?.listEndpoints().find((candidate) => candidate.target === selector);
    if (exactRemoteWindow) {
      return { code: "resolved", selector, selectorKind: "remote-window", endpoint: exactRemoteWindow, candidates: [exactRemoteWindow] };
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
      if (endpoint.transport === "remote-workspace-rpc-v1") return deliverRemoteWindowEndpoint(endpoint, request);
      return { delivered: false, endpointId: endpoint.id, transport: endpoint.transport, error: "Child IPC is unavailable in the root host." };
    },
  };

  const prepareSessionMessage = (request: SessionMessageRequest): SessionMessageRequest => {
    const messageKind = normalizeSessionMessageKind(request.messageKind, request.trustedStatus);
    const supplied = request.provenance === undefined
      ? undefined
      : normalizeMessageProvenanceV1(request.provenance);
    const messageId = request.messageId ?? supplied?.messageId ?? randomUUID();
    const expectedKind = messageKind ?? "message";
    const expectedSource = request.source === "monitor" ? "monitor" : "session-router";
    const expectedSender = senderIdentityForSessionMessage(request.senderCorrelationId, request.source);
    const bound = supplied?.confidence === "verified"
      && supplied.messageId === messageId
      && supplied.source === expectedSource
      && supplied.messageKind === expectedKind
      && supplied.deliveryMode === request.mode
      && sameMessageSender(supplied.sender, expectedSender);
    const provenance = supplied === undefined
      ? createVerifiedProvenance({
          messageId,
          source: expectedSource,
          messageKind: expectedKind,
          deliveryMode: request.mode,
          sender: expectedSender,
        })
      : bound
        ? supplied
        : unknownMessageProvenanceV1({
            from: supplied.confidence === "unknown" ? supplied.legacyLabel : undefined,
            messageId,
            messageKind: expectedKind,
            deliveryMode: request.mode,
          });
    return {
      ...request,
      messageId,
      messageKind,
      provenance,
    };
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
    prepareMessage: prepareSessionMessage,
    adapters: [
      createLocalRootTransportAdapter(deliverLocalRootEndpoint),
      createLocalAgentMailboxTransportAdapter(deliverLocalAgentEndpoint),
      createWorkspacePeerV1TransportAdapter(deliverWorkspacePeerEndpoint),
      createRemoteWorkspaceRpcV1TransportAdapter(deliverRemoteWindowEndpoint),
    ],
    onShadowComparison(comparison) {
      if (!comparison.matches) {
        logDiagnosticWarn("[pi-maestro-teammate] session route shadow mismatch:", JSON.stringify(comparison));
      }
    },
  });
  publishSessionHostRegistry(sessionHostRegistry, rootGlobals);
  publishSessionHostDirectoryRefresh(async () => {
    const fence = captureRootSessionFence();
    await workspacePeerLifecycle;
    if (!ownsRootSessionFence(fence)) return;
    await refreshWorkspacePeerOwners();
    if (!ownsRootSessionFence(fence)) return;
    refreshSessionEndpointDirectory(true);
  }, rootGlobals);
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
    const fence = captureRootSessionFence();
    await workspacePeerLifecycle;
    if (!ownsRootSessionFence(fence)) return staleRootSessionResult();
    await refreshWorkspacePeerOwners();
    if (!ownsRootSessionFence(fence)) return staleRootSessionResult();
    refreshSessionEndpointDirectory(true);
    const registry = sessionHostRegistry;
    if (!registry) return { delivered: false, error: "Session delivery authority is unavailable." };
    if (/^relay:[a-f0-9]{32}$/.test(request.selector)) {
      return sendWorkspacePeerMessage(request.selector, request);
    }
    const result = await registry.send(request);
    if (!ownsRootSessionFence(fence)) return staleRootSessionResult();
    return result;
  };

  remoteWindowNotificationHandler = (target, notification) => {
    void (async (): Promise<void> => {
      const binding = remoteMonitorBinding;
      const monitorCapture = captureMonitorCommunication();
      const fence = captureRootSessionFence();
      if (!currentRemoteMonitorBinding(binding) || !ownsMonitorCommunication(monitorCapture)) return;
      const listing = binding.windows.listing(target);
      if (!listing
        || listing.capture.ownerId !== notification.capture.ownerId
        || listing.capture.ownerNonce !== notification.capture.ownerNonce
        || listing.capture.gatewayInstanceNonce !== notification.capture.gatewayInstanceNonce) return;
      const registry = sessionHostRegistry;
      if (!registry) return;
      if (notification.type === "window/state") {
        const receipt = notification.receipt;
        if (receipt) {
          const status = remoteWindowReceiptThreadStatus(receipt.status);
          registry.thread.transition(
            receipt.messageId,
            "outgoing",
            status,
            receipt.updatedAt,
            receipt.effectiveMode,
          );
        }
        refreshSessionEndpointDirectory(true);
        return;
      }
      const effectiveMessageKind = normalizeSessionMessageKind(
        notification.messageKind,
        notification.source === "monitor",
      ) ?? "message";
      const delivery = workspaceMainSessionDeliveryDecision(
        notification.mode,
        workspaceBackgroundJobs,
        effectiveMessageKind,
      );
      const provenance = createVerifiedProvenance({
        messageId: notification.messageId,
        source: "session-router",
        messageKind: effectiveMessageKind,
        deliveryMode: delivery.action,
        sender: {
          kind: "root-agent",
          ownerId: notification.capture.ownerId,
          label: listing.sessionName ?? target,
        },
      });
      const base = remoteWindowIncomingThreadEntry(notification, target, {
        messageKind: effectiveMessageKind,
        provenance,
        status: "pending",
        updatedAt: notification.receivedAt,
        ...(fence.sessionId === null ? {} : { targetSessionId: fence.sessionId }),
      });
      registry.thread.record({ ...base, status: "pending", updatedAt: notification.receivedAt });
      const delivered = safeSendMessage(pi, {
        customType: "teammate-message",
        content: formatWorkspaceRemoteRootMessage({
          messageId: notification.messageId,
          fromOwnerId: notification.capture.ownerId,
          message: notification.message,
          effectiveAction: delivery.action,
          source: notification.source,
          messageKind: effectiveMessageKind,
          traceId: notification.inReplyTo,
          replyTo: target,
          fromSessionName: listing.sessionName,
        }),
        display: true,
        details: {
          source: "remote-window",
          messageId: notification.messageId,
          fromOwnerId: notification.capture.ownerId,
          requestedMode: notification.mode,
          mode: delivery.action,
          messageKind: effectiveMessageKind,
          provenance,
        },
      }, {
        triggerTurn: sessionMessageTriggersTurn(effectiveMessageKind),
        deliverAs: delivery.deliverAs,
      });
      registry.thread.record({
        ...base,
        effectiveMode: delivery.action,
        status: delivered ? (effectiveMessageKind === "status" ? "injected" : "queued") : "rejected",
        updatedAt: Math.max(notification.receivedAt, Date.now()),
      });
      if (workspaceWindowRuntimeActor) {
        const runtimeActor = workspaceWindowRuntimeActor;
        void (async () => {
          await runtimeActor.publishMessage("accepted", notification.messageId, "incoming", delivery.action, notification.inReplyTo);
          if (delivered) await runtimeActor.publishMessage("injected", notification.messageId, "incoming", delivery.action, notification.inReplyTo);
        })().catch((error) => {
          logDiagnosticError("[pi-maestro-teammate] Runtime V2 remote reply shadow append failed:", error);
        });
      }
      if (!delivered
        || !ownsRootSessionFence(fence)
        || !currentRemoteMonitorBinding(binding)
        || !ownsMonitorCommunication(monitorCapture)) return;
      const current = binding.windows.listing(target);
      if (!current
        || current.capture.ownerNonce !== notification.capture.ownerNonce
        || current.capture.gatewayInstanceNonce !== notification.capture.gatewayInstanceNonce) return;
      await binding.windows.acknowledge(target, notification);
    })().catch((error) => {
      logDiagnosticError("[pi-maestro-teammate] remote window notification failed:", error);
    });
  };

  const publishWorkspaceWindowTerminalResult = (
    request: WindowThreadEntry,
    draft: WorkspaceWindowTerminalResultDraft,
  ): Promise<boolean> => {
    const resultMessageId = workspaceWindowTerminalResultMessageId(request.messageId);
    const existing = workspaceTerminalResultPublications.get(resultMessageId);
    if (existing) return existing;
    const registry = sessionHostRegistry;
    const publisher = workspacePeerPublisher;
    if (!registry || !publisher || registry.thread.get(resultMessageId, "outgoing")) return Promise.resolve(false);
    const resolution = request.replyTo ? registry.resolve(request.replyTo) : undefined;
    const endpoint = resolution?.code === "resolved" ? resolution.endpoint : undefined;
    if (!endpoint
      || endpoint.kind !== "root"
      || endpoint.scope !== "workspace-peer"
      || endpoint.workspaceId !== request.workspaceId
      || endpoint.ownerId !== request.peerOwnerId
      || endpoint.ownerNonce !== request.peerOwnerNonce) return Promise.resolve(false);
    const fence = captureRootSessionFence();
    const result = createWorkspaceWindowTerminalResult({
      requestMessageId: request.messageId,
      ...draft,
    });
    const publication = registry.send({
      selector: endpoint.id,
      message: encodeWorkspaceWindowTerminalResult(result),
      mode: "follow_up",
      messageId: resultMessageId,
      traceId: request.messageId,
      source: "system",
      messageKind: "status",
      trustedStatus: true,
      authorize: () => {
        const current = sessionHostRegistry?.directory.get(endpoint.id);
        return workspacePeerPublisher === publisher
          && ownsRootSessionFence(fence)
          && current?.kind === "root"
          && current.scope === "workspace-peer"
          && current.workspaceId === endpoint.workspaceId
          && current.ownerId === endpoint.ownerId
          && current.ownerNonce === endpoint.ownerNonce;
      },
    }).then((delivery) => {
      const published = delivery.delivered || delivery.receipt?.publicationStage === "published";
      if (!published) {
        logDiagnosticError(
          `[pi-maestro-teammate] workspace terminal result publication failed for ${request.messageId}: ${delivery.error ?? "unknown error"}`,
        );
      }
      return published;
    }).catch((error) => {
      logDiagnosticError(
        `[pi-maestro-teammate] workspace terminal result publication failed for ${request.messageId}:`,
        error,
      );
      return false;
    });
    workspaceTerminalResultPublications.set(resultMessageId, publication);
    void publication.then((published) => {
      if (!published && workspaceTerminalResultPublications.get(resultMessageId) === publication) {
        workspaceTerminalResultPublications.delete(resultMessageId);
      }
    });
    return publication;
  };

  const publishWorkspaceWindowTerminalResults = async (
    draft: WorkspaceWindowTerminalResultDraft,
  ): Promise<boolean> => {
    const requests = sessionHostRegistry?.thread.list().filter((entry) =>
      entry.direction === "incoming"
      && entry.terminalResultRequested === true
      && entry.targetCorrelationId === WORKSPACE_MAIN_SESSION_MARKER
      && (entry.status === "injected" || entry.status === "accepted")
      && entry.replyTo === `owner:${entry.peerOwnerId}`
    ) ?? [];
    const publications: boolean[] = [];
    for (const request of requests) {
      publications.push(await publishWorkspaceWindowTerminalResult(request, draft));
    }
    return publications.every(Boolean);
  };

  const flushWorkspaceTerminalResultPublications = async (): Promise<boolean> => {
    const publications = [...workspaceTerminalResultPublications.values()];
    if (publications.length === 0) return true;
    return (await Promise.all(publications)).every(Boolean);
  };

  const publishWorkspaceTerminalCompletion = (
    request: WindowThreadEntry,
    terminal: WorkspaceWindowTerminalResult,
  ): Promise<boolean> => {
    const publicationId = workspaceWindowTerminalPublicationId(request.messageId);
    const existing = workspaceTerminalCompletionPublications.get(publicationId);
    if (existing) return existing;
    const publication = (async (): Promise<boolean> => {
      try {
        const seed = await reserveWorkspaceTerminalCompletion(request);
        const terminalStatus: AgentTerminalStatus = terminal.outcome === "completed"
          ? "completed"
          : terminal.outcome === "cancelled" ? "terminated" : "failed";
        const completionOutcome = terminalStatus === "completed"
          ? "completed" as const
          : terminalStatus === "terminated" ? "terminated" as const : "failed" as const;
        const content = terminal.outcome === "completed"
          ? terminal.finalText!
          : terminal.outcome === "no-result"
            ? "Workspace worker settled without a final result."
            : [terminal.error ?? `Workspace worker ${terminal.outcome}.`, terminal.finalText]
                .filter((part): part is string => Boolean(part))
                .join("\n\n");
        const summary = terminal.outcome === "completed"
          ? "Workspace worker completed."
          : terminal.outcome === "cancelled"
            ? "Workspace worker was cancelled."
            : terminal.outcome === "no-result"
              ? "Workspace worker failed without a final result."
              : `Workspace worker failed${terminal.error ? `: ${terminal.error.replace(/\s+/g, " ").trim().slice(0, 512)}` : "."}`;
        const result: SingleResult = {
          agent: "workspace-window",
          task: request.body,
          exitCode: terminalStatus === "completed" ? 0 : 1,
          messages: [{ role: terminalStatus === "completed" ? "assistant" : "system", content }],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cost: 0,
            turns: 1,
          },
          model: "workspace-peer-v1",
          correlationId: request.messageId,
          publicationId,
          originCwd: seed.originCwd,
          durationMs: Math.max(0, terminal.settledAt - request.createdAt),
          wakeable: false,
          terminalStatus,
          structuredOutput: terminal,
          completionDispatchId: seed.dispatchId,
          completionReservationId: seed.reservationId,
          completionOutcome,
        };
        await emitTeammateResultPublished(pi, result, seed.originCwd);
        const resource: CompletionResource = {
          correlationId: result.correlationId,
          publicationId,
          uri: `agent://${publicationId}`,
          originCwd: seed.originCwd,
          agent: result.agent,
          summary,
          outcome: completionOutcome,
        };
        const publishResult = await completionCoordinator.publishCompletion({
          dispatchId: seed.dispatchId,
          reservationId: seed.reservationId,
          kind: terminalStatus === "completed" ? "single" : "failure",
          outcome: completionOutcome,
          summary,
          resources: [resource],
          finalizedAt: terminal.settledAt,
        });
        // Once finalization commits, a temporary outbox import failure is owned
        // by coordinator reconciliation and must not trigger passive/direct
        // duplicate delivery. A fulfilled pre-finalize miss remains retryable.
        return publishResult.finalized;
      } catch (error) {
        logDiagnosticError(
          `[pi-maestro-teammate] canonical workspace terminal completion failed for ${request.messageId}:`,
          error,
        );
        return false;
      }
    })();
    workspaceTerminalCompletionPublications.set(publicationId, publication);
    void publication.then((published) => {
      if (!published && workspaceTerminalCompletionPublications.get(publicationId) === publication) {
        workspaceTerminalCompletionPublications.delete(publicationId);
      }
    });
    return publication;
  };

  const consumeWorkspaceTerminalCommand = (
    command: WorkspacePeerCommand,
  ): Promise<boolean> | undefined => {
    if (command.targetCorrelationId !== WORKSPACE_MAIN_SESSION_MARKER
      || command.source !== "system"
      || command.messageKind !== "status"
      || !command.traceId) return undefined;
    const request = sessionHostRegistry?.thread.get(command.traceId, "outgoing");
    if (!request
      || request.terminalResultRequested !== true
      || request.messageKind !== "request"
      || request.targetCorrelationId !== WORKSPACE_MAIN_SESSION_MARKER
      || request.workspaceId !== command.workspaceId
      || request.peerOwnerId !== command.fromOwnerId
      || request.peerOwnerNonce !== command.fromOwnerNonce
      || command.commandId !== workspaceWindowTerminalResultMessageId(request.messageId)) return undefined;
    let terminal: WorkspaceWindowTerminalResult;
    try {
      terminal = decodeWorkspaceWindowTerminalResult(command.message);
      if (terminal.requestMessageId !== request.messageId) {
        throw new Error("terminal result request identity does not match its transport trace");
      }
    } catch (error) {
      terminal = createWorkspaceWindowTerminalResult({
        requestMessageId: request.messageId,
        outcome: "failed",
        error: `Workspace terminal result protocol failure: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return completeManagedWindowTerminalCommand(request, terminal);
  };

  const stopWorkspacePeers = async (): Promise<void> => {
    const consumer = workspacePeerConsumer;
    const publisher = workspacePeerPublisher;
    const runtimeActor = workspaceWindowRuntimeActor;
    if (workspacePeerRefresh?.publisher === publisher) workspacePeerRefresh = undefined;
    workspacePeerConsumer = undefined;
    workspacePeerPublisher = undefined;
    workspaceWindowRuntimeActor = undefined;
    workspacePeerOwners = [];
    refreshSessionEndpointDirectory();
    // v1 remains authoritative: stop its consumer/publication before releasing the advisory actor lease.
    await consumer?.stop().catch(() => undefined);
    await publisher?.stop().catch(() => undefined);
    await runtimeActor?.stop().catch(() => undefined);
  };

  const RECONCILE_RECEIPT_INTERVAL_MS = 5_000;
  const RECONCILE_RECEIPT_MAX_AGE_MS = 10 * 60_000;
  const RECONCILE_RECEIPT_SKIP_AFTER_MS = 2_000;

  /**
   * Background receipt reconciliation: keeps polling response files for
   * non-terminal outgoing journal entries so a receipt that finalizes after
   * the synchronous 5s send window (target-side injection) still lands as
   * outgoing/injected (or rejected/timeout) instead of freezing at queued.
   */
  const reconcileWorkspacePeerReceipts = async (): Promise<void> => {
    const publisher = workspacePeerPublisher;
    const registry = sessionHostRegistry;
    if (!publisher || !registry) return;
    const now = Date.now();
    for (const entry of registry.thread.list()) {
      if (entry.direction !== "outgoing"
        || (entry.status !== "pending" && entry.status !== "queued")) continue;
      // Skip entries still inside the synchronous send window.
      if (entry.updatedAt > now - RECONCILE_RECEIPT_SKIP_AFTER_MS) continue;
      if (now - entry.updatedAt > RECONCILE_RECEIPT_MAX_AGE_MS) {
        registry.thread.transition(entry.messageId, "outgoing", "timeout", now);
        continue;
      }
      const response = await readWorkspacePeerResponse(publisher.identity, entry.messageId).catch(() => undefined);
      if (!response) continue;
      if (response.status === "accepted" && response.deliveryStage === "injected") {
        registry.thread.transition(entry.messageId, "outgoing", "injected", response.respondedAt, response.effectiveAction);
      } else if (response.status === "rejected" || response.status === "error") {
        registry.thread.transition(entry.messageId, "outgoing", "rejected", response.respondedAt, response.effectiveAction);
      } else if (response.status === "expired") {
        registry.thread.transition(entry.messageId, "outgoing", "timeout", response.respondedAt);
      }
      // accepted + queued: the target may still finalize; keep waiting.
    }
  };

  const startWorkspacePeers = (ctx: ExtensionContext): void => {
    const cwd = ctx.cwd;
    const fence = captureRootSessionFence();
    const generation = ++workspacePeerGeneration;
    const ownsWorkspacePeerGeneration = (): boolean =>
      workspacePeerGeneration === generation && ownsRootSessionFence(fence);
    const sessionName = ctx.sessionManager?.getSessionName?.() ?? undefined;
    workspacePeerSessionName = sessionName;
    workspacePeerLifecycle = workspacePeerLifecycle
      .then(async () => {
        await stopWorkspacePeers();
        if (!ownsWorkspacePeerGeneration()) return;
        // Stable per-session ownerId across process restarts: response files
        // keep their mailbox key and in-flight receipts stay readable.
        const ownerClaim = await claimWorkspaceOwnerIdentity(cwd, {
          sessionKey: ctx.sessionManager?.getSessionFile?.(),
          generation,
        });
        if (!ownsWorkspacePeerGeneration()) {
          await ownerClaim.release().catch(() => undefined);
          return;
        }
        const publisher = createWorkspacePeerRuntime({
          cwd,
          ownerClaim,
          getState: () => ({
            ...buildWorkspaceOwnerState(
              state,
              sessionName,
              currentContextPressure(),
              workspaceBackgroundJobs,
              workspaceMainSessionActivityAt,
            ),
            ...(workspaceMainSessionProgress === undefined ? {} : { mainProgress: workspaceMainSessionProgress }),
            ...(workspaceMainLastSettle === undefined ? {} : { mainLastSettle: workspaceMainLastSettle }),
          }),
        });
        await publisher.start();
        if (!ownsWorkspacePeerGeneration()) {
          await publisher.stop().catch(() => undefined);
          return;
        }
        const runtimeActor = createWindowSupervisorRuntimeActor({
          cwd,
          workspaceId: publisher.identity.workspaceId,
          ownerId: publisher.identity.ownerId,
          ownerNonce: publisher.identity.ownerNonce,
          generation,
          capabilities: localRootSessionCapabilities(monitorInteractionModeActive),
        });
        try {
          await runtimeActor.start();
        } catch (error) {
          await publisher.stop().catch(() => undefined);
          await runtimeActor.stop().catch(() => undefined);
          throw error;
        }
        if (!ownsWorkspacePeerGeneration()) {
          await publisher.stop().catch(() => undefined);
          await runtimeActor.stop().catch(() => undefined);
          return;
        }
        workspacePeerPublisher = publisher;
        workspaceWindowRuntimeActor = runtimeActor;
        // Events can arrive while the initial owner snapshot is being written.
        // Publish the latest in-memory progress once the publisher is bound.
        publisher.markDirty();
        const registry = sessionHostRegistry;
        if (!registry) {
          await publisher.stop().catch(() => undefined);
          await runtimeActor.stop().catch(() => undefined);
          workspacePeerPublisher = undefined;
          workspaceWindowRuntimeActor = undefined;
          return;
        }
        const consumer = createWorkspacePeerCommandConsumer(publisher.identity, async (command) => {
          if (!ownsRootSessionFence(fence)) {
            return { status: "rejected", message: "destination session changed before command delivery" };
          }
          if (!ownsWorkspacePeerGeneration()) {
            return { status: "rejected", message: "destination session changed before command delivery" };
          }
          const existing = registry.thread.get(command.commandId, "incoming");
          const replayReceipt = windowThreadReplayReceipt(existing);
          if (replayReceipt) return replayReceipt;
          const effectiveMessageKind = normalizeSessionMessageKind(
            command.messageKind,
            command.source === "monitor",
          ) ?? "message";
          const commandProvenance = normalizeMessageProvenanceV1(command.provenance, {
            from: command.fromSessionName ?? `owner-${command.fromOwnerId.slice(0, 8)}`,
            messageId: command.commandId,
            messageKind: effectiveMessageKind,
            deliveryMode: command.action,
          });
          const incoming = {
            messageId: command.commandId,
            workspaceId: command.workspaceId,
            peerOwnerId: command.fromOwnerId,
            peerOwnerNonce: command.fromOwnerNonce,
            direction: "incoming" as const,
            source: command.source ?? "system",
            messageKind: effectiveMessageKind,
            provenance: commandProvenance,
            traceId: command.traceId ?? command.commandId,
            replyTo: command.replyTo ?? `owner:${command.fromOwnerId}`,
            ...(command.terminalResultRequested === undefined ? {} : { terminalResultRequested: command.terminalResultRequested }),
            ...(command.fromSessionName === undefined ? {} : { fromSessionName: command.fromSessionName }),
            ...(fence.sessionId === null ? {} : { targetSessionId: fence.sessionId }),
            targetCorrelationId: command.targetCorrelationId,
            mode: command.action,
            body: command.message,
            createdAt: command.createdAt,
          };
          registry.thread.record({
            ...incoming,
            status: "pending",
            updatedAt: command.createdAt,
          });

          const terminalPublication = consumeWorkspaceTerminalCommand(command);
          if (terminalPublication) {
            const published = await terminalPublication;
            registry.thread.record({
              ...incoming,
              status: published ? "injected" : "rejected",
              updatedAt: Math.max(command.createdAt, Date.now()),
            });
            return published
              ? {
                  status: "accepted",
                  message: "terminal result committed to canonical completion",
                  effectiveAction: command.action,
                  deliveryStage: "injected",
                }
              : {
                  status: "rejected",
                  message: "terminal result could not be committed to canonical completion",
                };
          }

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
              effectiveMessageKind,
            );
            const effectiveAction = delivery.action;
            const effectiveProvenance = provenanceWithDeliveryMode(commandProvenance, effectiveAction);
            const deferredFor = delivery.deferred
              ? effectiveMessageKind === "status" ? "status-policy" : "foreground-bash-bg"
              : undefined;
            const delivered = safeSendMessage(pi, {
              customType: "teammate-message",
              content: formatWorkspaceRemoteRootMessage({
                messageId: command.commandId,
                fromOwnerId: command.fromOwnerId,
                message: command.message,
                effectiveAction,
                source: command.source,
                messageKind: effectiveMessageKind,
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
                ...(command.messageKind === undefined ? {} : { messageKind: effectiveMessageKind }),
                provenance: effectiveProvenance,
                ...(deferredFor ? { deferredFor } : {}),
              },
            }, {
              triggerTurn: sessionMessageTriggersTurn(effectiveMessageKind),
              deliverAs: delivery.deliverAs,
            });
            result = delivered
              ? {
                  status: "accepted",
                  message: effectiveAction === command.action
                    ? `${effectiveAction} accepted by main session`
                    : effectiveMessageKind === "status"
                      ? "status stored as context by message policy"
                      : "steer deferred as follow_up while foreground bash_bg is active",
                  effectiveAction,
                  deliveryStage: effectiveMessageKind === "status" ? "injected" : "queued",
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
                messageKind: effectiveMessageKind,
                traceId: command.traceId,
                replyTo: command.replyTo,
                fromSessionName: command.fromSessionName,
              });
              const delivered = await deliverLocalAgentMessage(
                command.targetCorrelationId,
                target.name ?? command.targetCorrelationId.slice(0, 8),
                workspaceMessage,
                command.action,
                {
                  messageKind: effectiveMessageKind,
                  preparedDelivery: {
                    body: workspaceMessage,
                    from: command.fromSessionName ?? `owner-${command.fromOwnerId.slice(0, 8)}`,
                    provenance: commandProvenance,
                  },
                },
              );
              if (!ownsRootSessionFence(fence)) {
                return { status: "rejected", message: "destination session changed during command delivery" };
              }
              if (!ownsWorkspacePeerGeneration()) {
                return { status: "rejected", message: "destination session changed during command delivery" };
              }
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
          if (!ownsRootSessionFence(fence)) {
            return { status: "rejected", message: "destination session changed before command acknowledgement" };
          }
          if (!ownsWorkspacePeerGeneration()) {
            return { status: "rejected", message: "destination session changed before command acknowledgement" };
          }
          registry.thread.record({
            ...incoming,
            ...(result.effectiveAction === undefined ? {} : { effectiveMode: result.effectiveAction }),
            status: result.status === "accepted" ? result.deliveryStage ?? "queued" : "rejected",
            updatedAt: Math.max(command.createdAt, Date.now()),
          });
          return result;
        });
        consumer.start();
        if (!ownsWorkspacePeerGeneration()) {
          await consumer.stop().catch(() => undefined);
          if (workspacePeerPublisher === publisher) workspacePeerPublisher = undefined;
          if (workspaceWindowRuntimeActor === runtimeActor) workspaceWindowRuntimeActor = undefined;
          await publisher.stop().catch(() => undefined);
          await runtimeActor.stop().catch(() => undefined);
          return;
        }
        workspacePeerConsumer = consumer;
        await refreshWorkspacePeerOwners();
        if (!ownsWorkspacePeerGeneration()) {
          if (workspacePeerConsumer === consumer) workspacePeerConsumer = undefined;
          if (workspacePeerPublisher === publisher) workspacePeerPublisher = undefined;
          if (workspaceWindowRuntimeActor === runtimeActor) workspaceWindowRuntimeActor = undefined;
          await consumer.stop().catch(() => undefined);
          await publisher.stop().catch(() => undefined);
          await runtimeActor.stop().catch(() => undefined);
        }
      })
      .catch((error) => logDiagnosticError("[pi-maestro-teammate] workspace peer runtime failed:", error));
  };

  const enqueueChildInteraction = (
    event: Record<string, unknown>,
    reply: (msg: unknown) => void,
    ctx: ExtensionContext | null | undefined,
    fallbackCorrelationId?: string,
  ): void => {
    interactionQueue.enqueue(event, reply, ctx, fallbackCorrelationId);
  };

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
      const dispatchFence = captureRootSessionFence();
      const ownsDispatchGeneration = (): boolean => ownsRootSessionFence(dispatchFence);
      const dispatchProjection = projectionForRootFence(dispatchFence);

      const baseCwd = (params.cwd ?? state.baseCwd) || ctx.cwd;
      await refreshModelRegistry(ctx);
      params = prepareTeammateMode(params);
      params = applyModelRouting(
        params,
        baseCwd,
        refreshModelCatalog(ctx).modelIds,
        undefined,
        sessionModelId(ctx),
        state.currentSessionId ?? undefined,
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

      // Ask-before-dispatch (configurable in /teammate-models · Ctrl+A): when
      // enabled, the root tool call pauses for the user to confirm or pick the
      // model provider/thinking per task before any agent is spawned. Nested
      // dispatches proxied from child processes never ask — the gate only runs
      // on the root execute path with an interactive UI.
      let askBeforeDispatch = false;
      try {
        askBeforeDispatch = loadModelRoutingState(baseCwd).askBeforeDispatch;
      } catch {
        askBeforeDispatch = false;
      }
      if (askBeforeDispatch && ctx.hasUI && typeof ctx.ui?.custom === "function") {
        const remoteLocations = (() => {
          try {
            const config = loadRemoteConfigState(baseCwd);
            return Object.entries(config.config.targets).map(([id, target]) => ({
              id,
              driver: target.driver,
              host: target.host,
              cwd: target.cwd,
            }));
          } catch {
            return [];
          }
        })();
        const askResult = await showModelAskOverlay(ctx, {
          tasks: normalizedTasks.map((task) => ({
            agent: task.agent,
            ...(task.name ? { name: task.name } : {}),
            ...(task.model ? { model: task.model } : {}),
            ...(task.thinking ? { thinking: task.thinking } : {}),
            ...(task.cwd ? { cwd: task.cwd } : {}),
            prompt: task.prompt,
          })),
          availableModels: refreshModelCatalog(ctx).models,
          sessionModel: sessionModelId(ctx),
          defaultCwd: ctx.cwd,
          remoteLocations,
          monitorActive: ownsMonitorCommunication(captureMonitorCommunication()),
        });
        if (askResult === null || !askResult.confirmed) {
          return {
            content: [{ type: "text", text: "Teammate dispatch cancelled by the user (ask-before-dispatch is enabled; disable it in /teammate-models · Ctrl+A)." }],
            isError: true,
            details: { mode: isMultiTask ? inferGraphMode(normalizedTasks) : "single", results: [] },
          };
        }
        for (const [index, override] of askResult.overrides.entries()) {
          if (!override) continue;
          const task = normalizedTasks[index];
          if (!task) continue;
          if (override.model !== undefined) task.model = override.model ?? undefined;
          if (override.thinking !== undefined) task.thinking = override.thinking ?? undefined;
          if (override.cwd !== undefined) task.cwd = override.cwd ?? undefined;
        }
      }
      const dispatchModelCatalog = refreshModelCatalog(ctx);
      const dispatchModelRegistryAuthority = publishedModelRegistryPairSync(ctx.cwd)?.dispatch;
      const dispatchMonitorCapture = captureMonitorCommunication();
      // A remote working location is a backend selector, not a dispatch of its
      // own: the checks below are the ones that can only be made here, and the
      // task then travels the ordinary path, where the registry resolves
      // `remote:<targetId>` and the backend produces a real settled outcome.
      const remoteLocatedTasks = normalizedTasks.filter((task) =>
        typeof task.cwd === "string" && task.cwd.startsWith("remote:"),
      );
      if (remoteLocatedTasks.length > 0) {
        if (isMultiTask || remoteLocatedTasks.length !== normalizedTasks.length) {
          return {
            content: [{ type: "text", text: "Remote working locations support only single-task dispatches; use a local location for graph tasks." }],
            isError: true,
            details: { mode: isMultiTask ? inferGraphMode(normalizedTasks) : "single", results: [] },
          };
        }
        if (!ownsMonitorCommunication(dispatchMonitorCapture)) {
          return {
            content: [{ type: "text", text: "Remote working locations require active Monitor mode." }],
            isError: true,
            details: { mode: "single", results: [] },
          };
        }
        // Established here rather than at first use so a Monitor term that
        // cannot be taken is reported with its own sanitized message, before the
        // dispatch reaches a registry that would only say the module failed to
        // load.
        try {
          ensureRemoteMonitorBinding();
        } catch (error) {
          return {
            content: [{ type: "text", text: sanitizeRemoteMonitorError(error, "remote binding") }],
            isError: true,
            details: { mode: "single", results: [] },
          };
        }
      }
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
      const singleRunParams = singleRunParamsOf(singleTask, {
        task: singleTask.prompt,
        reply_to: params.reply_to,
      });
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
      const initialTaskProvenanceByCorrelationId = new Map<string, MessageProvenanceV1>();
      for (const childId of isMultiTask ? taskCorrelationIds : [correlationId]) {
        initialTaskProvenanceByCorrelationId.set(childId, createVerifiedProvenance({
          messageId: `${childId}:initial`,
          source: "initial-task",
          messageKind: "task",
          deliveryMode: "prompt",
          sender: { kind: "root-agent", ownerId: currentRootOwnerId(), label: "main" },
        }));
      }

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

      const completionSessionId = ctx.sessionManager?.getSessionId?.();
      const completionSeed: CompletionDispatchSeed | undefined = completionSessionId
        ? {
            dispatchId: correlationId,
            deliveryGroupId: correlationId,
            reservationId: randomUUID(),
            mode: graphMode ?? "single",
            target: {
              workspaceId: workspaceIdForCwd(ctx.cwd),
              sessionId: completionSessionId,
            },
            replyTarget: params.reply_to ?? "caller",
            originCwd: baseCwd,
            expectedTasks: isMultiTask ? taskCorrelationIds : [correlationId],
            createdAt: Date.now(),
          }
        : undefined;
      let completionDurable = false;
      let completionNotificationRequired = false;
      if (completionSeed) {
        try {
          completionDurable = (await completionCoordinator.beginDispatch(completionSeed)).durable;
        } catch (error) {
          signal.removeEventListener("abort", abortForward);
          return {
            content: [{
              type: "text",
              text: `Teammate dispatch rejected before spawn: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
            details: { mode: (graphMode ?? "single") as Details["mode"], results: [] },
          };
        }
      }

      if (signal.aborted || !ownsDispatchGeneration()) {
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
        ...(isMultiTask ? {} : { task: singleTask.prompt }),
        correlationId,
        startedAt: Date.now(),
        abortController,
        ...(isMultiTask ? { graphAbortController: abortController } : {}),
        ownsChildProcess: !isMultiTask,
        ...(isMultiTask ? {} : { initialMessageProvenance: initialTaskProvenanceByCorrelationId.get(correlationId) }),
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
        ...(isMultiTask
          ? { progress: progressSnapshot(), cwd: graphRunLocations(normalizedTasks, state.baseCwd || ctx.cwd) }
          : { cwd: resolvedRunLocation(singleTask.cwd ?? params.cwd, state.baseCwd || ctx.cwd) }),
      };
      state.activeRuns.set(correlationId, activeAgent);
      refreshAgentRuntimeProjection(activeAgent);

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
            task: task.prompt,
            correlationId: childId,
            startedAt: Date.now(),
            abortController: taskAbortControllers[index],
            graphAbortController: abortController,
            ownsChildProcess: true,
            initialMessageProvenance: initialTaskProvenanceByCorrelationId.get(childId),
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
          refreshAgentRuntimeProjection(childAgent);
          if (task.name) bindAgentName(state, task.name, childId);
        });
        // Register the whole graph before emitting any started event: a
        // synchronous TEAMMATE_STARTED_EVENT listener re-entering admission
        // would otherwise see only part of the graph counted and could pass
        // the active-agent budget against a partial tally (P4).
        normalizedTasks.forEach((task, index) => {
          const childAgent = state.activeRuns.get(taskCorrelationIds[index]);
          if (childAgent) emitCurrentTeammateStarted(childAgent);
        });
      }

      if (!isMultiTask && singleTask.name) {
        bindAgentName(state, singleTask.name, correlationId);
      }
      emitCurrentTeammateStarted(activeAgent, { id });

      let dispatchLifecyclePending = false;
      let singlePublishedResult: SingleResult | undefined;
      let singleTerminalResult: SingleResult | undefined;
      let singleTerminalStatus: AgentTerminalStatus | undefined;
      let singleCompletionNotificationRequested = false;
      let singleCompletionDelivered = false;
      const coldRestarting = new Set<string>();
      const publicationCountByCorrelation = new Map<string, number>();
      const knownWarningsByCorrelation = new Map<string, Set<string>>();
      const additionalNotificationByResult = new WeakMap<SingleResult, boolean>();
      const additionalCompletionSeeds = new Map<string, CompletionDispatchSeed>();
      const isLogicallyWakeable = (result: SingleResult): boolean => {
        const target = state.activeRuns.get(result.correlationId);
        return result.wakeable !== false || Boolean(target?.restart && target.sessionFile);
      };
      const durableResources = (results: readonly SingleResult[]): CompletionResource[] =>
        results.map((result) => {
          if (!result.publicationId) {
            throw new Error(`Completion result ${result.correlationId} has no immutable publicationId.`);
          }
          const outcome = result.terminalStatus === "terminated"
            ? "terminated" as const
            : result.exitCode === 0 ? "completed" as const : "failed" as const;
          return {
            correlationId: result.correlationId,
            publicationId: result.publicationId,
            uri: `agent://${result.publicationId}`,
            originCwd: result.originCwd ?? baseCwd,
            ...(result.name ? { name: result.name } : {}),
            agent: result.agent,
            summary: truncateUtf8Head(displayMessageForResult(result).replace(/\s+/g, " ").trim(), 4_096),
            outcome,
          };
        });
      const requireDurableNotification = async (
        kind: "single" | "graph" | "additional" | "failure",
      ): Promise<void> => {
        if (!completionDurable || !completionSeed) return;
        await completionCoordinator.requireNotification({
          dispatchId: completionSeed.dispatchId,
          reservationId: completionSeed.reservationId,
          kind,
          requiredAt: Date.now(),
        });
        completionNotificationRequired = true;
      };
      const publishDurableCompletion = async (
        kind: "single" | "graph" | "additional" | "failure",
        outcome: "completed" | "failed" | "terminated",
        summary: string,
        results: readonly SingleResult[],
      ): Promise<boolean> => {
        if (!completionDurable || !completionSeed) return false;
        const publishResult = await completionCoordinator.publishCompletion({
          dispatchId: completionSeed.dispatchId,
          reservationId: completionSeed.reservationId,
          kind,
          outcome,
          summary: truncateUtf8Head(summary, 4_096),
          resources: durableResources(results),
          finalizedAt: Date.now(),
        });
        return publishResult.finalized;
      };
      const publishDurableFailure = async (
        agent: string,
        error: unknown,
      ): Promise<boolean> => {
        if (!completionDurable || !completionSeed) return false;
        const message = error instanceof Error ? error.message : String(error);
        const result: SingleResult = {
          agent,
          task: singleTask.prompt,
          exitCode: 1,
          messages: [{ role: "assistant", content: message }],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cost: 0,
            turns: 0,
          },
          model: "",
          correlationId,
          publicationId: randomUUID(),
          originCwd: baseCwd,
          durationMs: Date.now() - activeAgent.startedAt,
          wakeable: false,
          terminalStatus: "failed",
          completionDispatchId: completionSeed.dispatchId,
          completionReservationId: completionSeed.reservationId,
          completionOutcome: "failed",
        };
        await emitTeammateResultPublished(pi, result, baseCwd);
        return publishDurableCompletion("failure", "failed", message, [result]);
      };
      const notifyFailureWithFallback = (agent: string, error: unknown): void => {
        void deliverDurableFailureWithFallback({
          publishDurableFailure: () => publishDurableFailure(agent, error),
          ownsDispatchGeneration,
          fallback: () => notifyBackgroundFailure(
            pi,
            id,
            agent,
            correlationId,
            error,
            state,
            dispatchProjection,
          ),
          onDurabilityError: (durabilityError) => {
            logDiagnosticWarn("[pi-maestro-teammate] durable failure publication failed; using direct delivery:", durabilityError);
          },
        }).catch((deliveryError) => {
          logDiagnosticWarn("[pi-maestro-teammate] direct failure delivery failed:", deliveryError);
        });
      };
      const deliverSingleCompletion = (): void => {
        if (!ownsDispatchGeneration()) {
          singleCompletionDelivered = true;
          return;
        }
        if (singleCompletionDelivered) return;
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
            dispatchProjection,
          );
          // DEL-002: Use the published result for the notification content.
          // The terminal result may carry lifecycle diagnostics (e.g. "never
          // confirmed its lifecycle") that would overwrite the assistant's
          // actual answer.
          const lastMessage = displayMessageForResult(singlePublishedResult ?? terminal);
          const fallbackDelivery = (): void => {
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
            if (!delivered) markSettledResultInspectable(state, correlationId);
          };
          void publishDurableCompletion(
            "single",
            status === "terminated" ? "terminated" : terminal.exitCode === 0 ? "completed" : "failed",
            lastMessage,
            [singlePublishedResult ?? terminal],
          ).then((durable) => {
            if (!durable) fallbackDelivery();
          }).catch((error) => {
            logDiagnosticWarn("[pi-maestro-teammate] durable single completion failed; using direct delivery:", error);
            fallbackDelivery();
          });
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
            dispatchProjection,
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
          dispatchProjection,
        );
        if (graphCompletionNotificationRequested) {
          const fallbackDelivery = (): void => {
            const delivered = safeSendMessage(
              pi,
              {
                customType: "teammate-complete",
                content: graphPublication!.summaries,
                display: true,
                details: {
                  mode: graphPublication!.mode,
                  results: graphPublication!.results,
                  progress: graphPublication!.progress,
                  ...(childCalls.size > 0 ? { childCalls: [...childCalls.values()] } : {}),
                },
              },
              { triggerTurn: true },
            );
            if (!delivered) markSettledResultInspectable(state, correlationId);
          };
          void publishDurableCompletion(
            "graph",
            terminalStatus === "terminated" ? "terminated" : exitCode === 0 ? "completed" : "failed",
            graphPublication.summaries,
            graphPublication.results,
          ).then((durable) => {
            if (!durable) fallbackDelivery();
          }).catch((error) => {
            logDiagnosticWarn("[pi-maestro-teammate] durable graph completion failed; using direct delivery:", error);
            fallbackDelivery();
          });
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
        notifyModel: boolean,
      ): void => {
        if (!ownsDispatchGeneration() || coldRestarting.has(result.correlationId)) return;
        const target = state.activeRuns.get(result.correlationId);
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
          dispatchProjection,
        );
        if (!notifyModel) return;
        const lastMessage = displayMessageForResult(result);
        const fallbackDelivery = (): void => {
          if (!safeSendMessage(
            pi,
            {
              customType: "teammate-complete",
              content: lastMessage,
              display: true,
              details: { mode: "single", results: [result] },
            },
            { triggerTurn: true },
          )) markSettledResultInspectable(state, result.correlationId);
        };
        const additionalSeed = result.publicationId
          ? additionalCompletionSeeds.get(result.publicationId)
          : undefined;
        if (!additionalSeed) {
          fallbackDelivery();
          return;
        }
        additionalCompletionSeeds.delete(result.publicationId!);
        void completionCoordinator.publishCompletion({
          dispatchId: additionalSeed.dispatchId,
          reservationId: additionalSeed.reservationId,
          kind: "additional",
          outcome: terminalStatus === "terminated" ? "terminated" : result.exitCode === 0 ? "completed" : "failed",
          summary: truncateUtf8Head(lastMessage, 4_096),
          resources: durableResources([result]),
          finalizedAt: Date.now(),
        }).then((publishResult) => {
          if (!publishResult.finalized) fallbackDelivery();
        }, (error) => {
          logDiagnosticWarn("[pi-maestro-teammate] durable additional completion failed before finalization; using direct delivery:", error);
          fallbackDelivery();
        }).catch((error) => {
          logDiagnosticWarn("[pi-maestro-teammate] post-finalize additional delivery handler failed; durable recovery retained:", error);
        });
      };

      const parentSessionFile = ctx.sessionManager?.getSessionFile?.() ?? undefined;
      const forkRequested = normalizedTasks.some((task) => task.context === "fork");
      let forkSnapshotPath: string | undefined;
      let forkSnapshotDirectory: string | undefined;
      let forkSnapshotCleaned = false;
      const cleanupForkSnapshot = (): void => {
        if (forkSnapshotCleaned) return;
        forkSnapshotCleaned = true;
        if (forkSnapshotDirectory) rmSync(forkSnapshotDirectory, { recursive: true, force: true });
      };
      const dispatchParentSessionFile = (): string | undefined => {
        if (!forkRequested) return parentSessionFile;
        if (forkSnapshotPath) return forkSnapshotPath;
        if (!parentSessionFile) {
          throw new Error("fork-snapshot-invalid (source-read-failed): parent session file is unavailable");
        }
        const snapshot = createForkSnapshot({
          sourcePath: parentSessionFile,
          spawningToolCallId: id,
          destination: { kind: "temp" },
        });
        if (!snapshot.ok) {
          throw new Error(
            `${snapshot.diagnostic.kind} (${snapshot.diagnostic.code}): ${snapshot.diagnostic.message}`,
          );
        }
        forkSnapshotPath = snapshot.snapshotPath;
        forkSnapshotDirectory = snapshot.temporaryDirectory;
        if (snapshot.injectedCompactionBoundary) {
          logDiagnosticWarn(
            "[pi-maestro-teammate] fork context truncated: injected a compaction boundary into the fork snapshot because the parent session history exceeded the fork compaction threshold; the child sees only recent retained context plus a summary instead of the full fork-parent history.",
          );
        }
        return forkSnapshotPath;
      };
      let progressFlushGate: ProgressFlushGate | undefined;

      const makeOptions = (): RunTeammateOptions => {
        const turnFence = captureRootSessionFence();
        const turnTarget = state.activeRuns.get(correlationId) ?? activeAgent;
        const initialTurnContext: AgentTurnTriggerContextV1 | undefined = isSingle
          ? {
              version: AGENT_TURN_VERSION,
              turnId: randomUUID(),
              correlationId: turnTarget.correlationId,
              runtimeGeneration: turnTarget.runtimeGeneration ?? 0,
              promptSeq: turnTarget.promptSeq ?? 1,
              trigger: normalizeMessageProvenanceV1(turnTarget.initialMessageProvenance),
            }
          : undefined;
        const options: RunTeammateOptions = {
          baseCwd: state.baseCwd || ctx.cwd,
          // Dispatch-level steering-queue drain mode override; omitted keeps the
          // child's inherited Pi settings (default one-at-a-time).
          ...(params.steeringMode ? { steeringMode: params.steeringMode } : {}),
          // Lazy: taking the Monitor term throws when there is none, and a
          // purely local dispatch must not pay for that. Only loading a remote
          // registration reaches this.
          remoteManagerOf: () => ensureRemoteMonitorBinding().port.port,
          modelCapabilities: dispatchModelCatalog.models,
          ...(dispatchModelRegistryAuthority === undefined
            ? {}
            : { modelRegistryAuthority: dispatchModelRegistryAuthority }),
          authorizeRemoteModelDispatch: () => ownsMonitorCommunication(dispatchMonitorCapture),
          ...(isSingle ? { correlationId } : {}),
          ...(isMultiTask ? { taskCorrelationIds } : {}),
          depth: activeAgent.depth,
          maxDispatchDepth: childMaxDispatchDepth,
          signal: abortController.signal,
          runtimeGeneration: activeAgent.runtimeGeneration,
          initialMessageProvenance: activeAgent.initialMessageProvenance,
          initialMessageProvenanceOf: (childId) => state.activeRuns.get(childId)?.initialMessageProvenance,
          ...(initialTurnContext ? { initialTurnContext } : {}),
          recordTurnEvent: (event) => recordAgentTurnEvent(event, turnFence),
          ...(isMultiTask ? { taskSignals: taskAbortControllers.map((controller) => controller.signal) } : {}),
          parentSessionFile: dispatchParentSessionFile(),
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
          onResultPublished: async (result, originCwd) => {
                const publicationCount = (publicationCountByCorrelation.get(result.correlationId) ?? 0) + 1;
                publicationCountByCorrelation.set(result.correlationId, publicationCount);
                const knownWarnings = knownWarningsByCorrelation.get(result.correlationId) ?? new Set<string>();
                knownWarningsByCorrelation.set(result.correlationId, knownWarnings);
                const notifyAdditional = publicationCount === 1
                  ? true
                  : shouldPublishAdditionalTurn(result, knownWarnings);
                if (publicationCount === 1) {
                  for (const warning of result.warnings ?? []) {
                    const normalized = warning.trim();
                    if (normalized) knownWarnings.add(normalized);
                  }
                }
                additionalNotificationByResult.set(result, notifyAdditional);
                let resultCompletionSeed = publicationCount === 1 ? completionSeed : undefined;
                let resultCompletionDurable = publicationCount === 1 ? completionDurable : false;
                if (publicationCount > 1 && notifyAdditional && completionSeed && result.publicationId) {
                  const additionalSeed: CompletionDispatchSeed = {
                    ...completionSeed,
                    dispatchId: result.publicationId,
                    deliveryGroupId: result.publicationId,
                    reservationId: randomUUID(),
                    mode: "single",
                    expectedTasks: [result.correlationId],
                    createdAt: Date.now(),
                  };
                  resultCompletionDurable = (await completionCoordinator.beginDispatch(additionalSeed)).durable;
                  if (resultCompletionDurable) {
                    await completionCoordinator.requireNotification({
                      dispatchId: additionalSeed.dispatchId,
                      reservationId: additionalSeed.reservationId,
                      kind: "additional",
                      requiredAt: Date.now(),
                    });
                    additionalCompletionSeeds.set(result.publicationId, additionalSeed);
                    resultCompletionSeed = additionalSeed;
                  }
                }
                if (resultCompletionDurable && resultCompletionSeed) {
                  result.completionDispatchId = resultCompletionSeed.dispatchId;
                  result.completionReservationId = resultCompletionSeed.reservationId;
                  result.completionOutcome = result.terminalStatus === "terminated"
                    ? "terminated"
                    : result.exitCode === 0 ? "completed" : "failed";
                }
                return emitTeammateResultPublished(pi, result, originCwd);
              },
          onTurnComplete: (result: SingleResult, terminalStatus?: AgentTerminalStatus) => {
            const canonicalStatus = terminalStatusForResult(result, terminalStatus);
            result.terminalStatus = canonicalStatus;
            const target = state.activeRuns.get(result.correlationId) ?? activeAgent;
            target.resolvedModel = target.resolvedModel ?? displayResolvedModel(result);
            if (result.attemptedModels) target.attemptedModels = [...result.attemptedModels];
            setAgentStructuredOutput(target, result.structuredOutput);
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
            if (repeatedTurn) publishAdditionalTurnCompletion(
              result,
              canonicalStatus,
              additionalNotificationByResult.get(result)
                ?? shouldPublishAdditionalTurn(
                  result,
                  knownWarningsByCorrelation.get(result.correlationId) ?? new Set<string>(),
                ),
            );
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
            if (!ownsDispatchGeneration()) return;
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
            if (childAgent) {
              refreshAgentRuntimeProjection(childAgent);
              entry.runtime = childAgent.runtime;
              entry.turn = childAgent.turn;
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
            if (!ownsDispatchGeneration()) return;
            const progressKey = data.taskIndex ?? 0;
            const entry = progressState.get(progressKey);
            if (!entry) return;
            const currentProgress = progressSnapshot();
            activeAgent.progress = currentProgress;
            activeAgent.phase = aggregateAgentRunPhase(currentProgress) ?? activeAgent.phase;
            refreshAgentRuntimeProjection(activeAgent);

            // Broadcast the complete graph snapshot so overlays can switch views reliably.
            pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
              correlationId,
              ...(dispatchProjection ? { projection: dispatchProjection } : {}),
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
              runtime: entry.runtime,
              turn: entry.turn,
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
            if (!ownsDispatchGeneration()) {
              pendingByTask.clear();
              latestPendingProgress = undefined;
              return;
            }
            const latest = latestPendingProgress;
            latestPendingProgress = undefined;
            flushProgressBatch(pendingByTask, latest, processProgress, publishProgress);
          }, UPDATE_INTERVAL, ownsDispatchGeneration);
          progressFlushGate = flushGate;

          return (data: AgentProgress) => {
            if (!ownsDispatchGeneration()) return;
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
          const proxyCanCrossSession = (): boolean => false;
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
            async (target, message, mode, provenance) => {
              const monitorAuthority = proxyCanCrossSession();
              const delivered = await routeSessionMessage({
                selector: target,
                message,
                mode,
                source: monitorAuthority ? "monitor" : "system",
                provenance,
                signal: activeAgent.abortController.signal,
              });
              return delivered.delivered && (!monitorAuthority || proxyCanCrossSession());
            },
            async () => {
              if (!proxyCanCrossSession()) return [];
              await workspacePeerLifecycle;
              await refreshWorkspacePeerOwners();
              return proxyCanCrossSession() ? workspacePeerWindowListings() : [];
            },
            (request) => {
              const monitorAuthority = proxyCanCrossSession();
              return routeSessionMessage({
                ...request,
                source: monitorAuthority ? "monitor" : "system",
                ...(monitorAuthority ? { authorize: proxyCanCrossSession } : {}),
                signal: activeAgent.abortController.signal,
              });
            },
            async () => {
              await refreshModelRegistry(ctx);
              return refreshModelCatalog(ctx).models;
            },
            {
              authorizeCrossSession: proxyCanCrossSession,
              completion: {
                coordinator: completionCoordinator,
                workspaceId: workspaceIdForCwd(state.baseCwd),
              },
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
        target.restart = (message: string, provenance?: MessageProvenanceV1): boolean => {
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
          target.promptSeq = (target.promptSeq ?? 0) + 1;
          target.loopSeq = 0;
          target.abortController = controller;
          target.lease = createChildLease();
          target.status = "running";
          target.phase = "restoring";
          target.retry = undefined;
          target.failedAt = undefined;
          target.resultReadyAt = undefined;
          target.lastActivityAt = Date.now();
          target.initialMessageProvenance = normalizeMessageProvenanceV1(provenance, {
            messageId: provenance?.messageId ?? randomUUID(),
            messageKind: "message",
            deliveryMode: "prompt",
          });
          coldRestarting.add(target.correlationId);

          let restartDeliverySettled = false;
          let settleRestartDelivery!: (accepted: boolean) => void;
          const restartDelivery = new Promise<boolean>((resolve) => {
            settleRestartDelivery = (accepted) => {
              if (restartDeliverySettled) return;
              restartDeliverySettled = true;
              resolve(accepted);
            };
          });
          target.restartDelivery = restartDelivery;

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
          options.initialMessageProvenance = target.initialMessageProvenance;
          options.initialTurnContext = {
            version: AGENT_TURN_VERSION,
            turnId: randomUUID(),
            correlationId: target.correlationId,
            runtimeGeneration: generation,
            promptSeq: target.promptSeq ?? 1,
            trigger: normalizeMessageProvenanceV1(target.initialMessageProvenance),
          };

          const onChildSpawned = options.onChildSpawned;
          options.onChildSpawned = (stdin, sendControl, sessionDir, childId, callbackGeneration) => {
            if (!ownsRuntime()) return;
            onChildSpawned?.(stdin, sendControl, sessionDir, childId ?? target.correlationId, callbackGeneration);
            settleRestartDelivery(true);
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
              dispatchProjection,
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

          const restartParams = singleRunParamsOf(task, {
            task: message,
            context: "fresh",
            timeoutMs: task.timeoutMs,
            reply_to: params.reply_to,
          });
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
            settleRestartDelivery(false);
            coldRestarting.delete(target.correlationId);
            if (target.restartDelivery === restartDelivery) target.restartDelivery = undefined;
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
            ).finally(cleanupForkSnapshot);

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
                resolvedModel: displayResolvedModel(result),
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
            notifyFailureWithFallback(activeGraphMode, error);
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
              if (completionDurable && completionSeed) {
                await completionCoordinator.settleForeground(completionSeed);
              }

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
            await requireDurableNotification("graph");
            detached = true;
            // Stop forwarding the caller tool-call signal abort into the graph
            // run so background model candidates survive the tool-call teardown.
            signal.removeEventListener("abort", abortForward);
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

          await requireDurableNotification("graph");
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
            ).finally(cleanupForkSnapshot);
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
            if (completionDurable && completionSeed) {
              await completionCoordinator.settleForeground(completionSeed);
            }
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
          await requireDurableNotification("single");
          markStallNotification();
          detached = true;
          // Detaching hands the run to background. The caller's tool-call signal
          // is about to be torn down when this tool call returns; stop forwarding
          // its abort into the run so a still-in-flight model candidate in the
          // background run is not cancelled (which would settle as `unknown` /
          // externalReplayRisk and freeze the result behind the replay fence).
          signal.removeEventListener("abort", abortForward);
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
            notifyFailureWithFallback(agentLabel, error);
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
        await requireDurableNotification("single");
        markStallNotification();
        const options = makeOptions();
        const bgPromise = runWithProgressFlushCleanup(
          () => runSingleTeammate(singleRunParams, options),
          progressFlushGate,
        ).finally(cleanupForkSnapshot);

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
          notifyFailureWithFallback(agentLabel, error);
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
        if (completionDurable && completionSeed && !completionNotificationRequired) {
          await completionCoordinator.abandon(completionSeed, "dispatch ended without a notification requirement").catch((error) => {
            logDiagnosticWarn("[pi-maestro-teammate] completion dispatch cleanup failed:", error);
          });
        }
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

  const sendTool: ToolDefinition<
    typeof TeammateSendParams,
    { delivered: boolean; provenance?: MessageProvenanceV1 }
  > = {
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
    ): Promise<TeammateToolResult<{ delivered: boolean; provenance?: MessageProvenanceV1 }>> {
      const requestedMode = params.mode ?? "steer";
      const requestedMessageKind = params.kind ?? "coordination";
      const messageKind = normalizeSessionMessageKind(requestedMessageKind) ?? "coordination";
      const message = params.message ?? "";
      if (!message && requestedMode !== "abort") {
        return {
          content: [{ type: "text", text: `"message" is required for mode "${requestedMode}".` }],
          isError: true,
          details: { delivered: false },
        };
      }

      const mode = requestedMode === "steer" || requestedMode === "abort" || requestedMode === "interrupt" ? requestedMode : "follow_up";
      const localRootTarget = params.to === "root" || params.to === "@root";
      const cid = localRootTarget ? undefined : resolveAgentCorrelationId(state, params.to);
      const monitorCapture = cid ? undefined : captureMonitorCommunication();
      if (!cid && params.to.startsWith("remote:")) {
        if (mode === "abort") {
          return {
            content: [{ type: "text", text: "Cross-target teammate-send does not support abort for remote workers; use remote-worker close." }],
            isError: true,
            details: { delivered: false },
          };
        }
        if (mode === "interrupt") {
          return {
            content: [{ type: "text", text: "Cross-target teammate-send does not support interrupt for remote workers; use steer (queued) or remote-worker close." }],
            isError: true,
            details: { delivered: false },
          };
        }
        const binding = currentRemoteMonitorBinding() ? remoteMonitorBinding : undefined;
        if (!binding || !binding.session.capture(params.to)) {
          return {
            content: [{ type: "text", text: `Remote target "${params.to}" is not owned by this Monitor session.` }],
            isError: true,
            details: { delivered: false },
          };
        }
        // Remote workers reached this point only after abort/interrupt were
        // rejected above, so the effective mode is a remote-compatible steer or
        // follow_up. Narrowing here keeps the remote history mode honest.
        const remoteMode: RemoteHistoryMode = mode === "steer" ? "steer" : "follow_up";
        const routedMode = messageKind === "status" ? "follow_up" : remoteMode;
        try {
          const receipt = await binding.session.send(params.to, routedMode, message, messageKind, id, remoteMode);
          if (!ownsMonitorCommunication(monitorCapture)) {
            return {
              content: [{ type: "text", text: "Monitor mode ended during remote message delivery; the stale receipt was not published." }],
              isError: true,
              details: { delivered: false },
            };
          }
          if (!receipt.accepted) {
            return {
              content: [{ type: "text", text: `Remote target "${params.to}" rejected the message.` }],
              isError: true,
              details: { delivered: false },
            };
          }
          const queuedHint = receipt.receipt === "queued" || receipt.receipt === "accepted"
            ? " Receipt confirms enqueueing only, not model consumption; do not resend without new evidence."
            : "";
          return {
            content: [{
              type: "text",
              text: `Message ${receipt.receipt} for remote target "${params.to}" (kind ${messageKind}, requested ${mode}, effective ${receipt.effectiveMode}).${queuedHint}`,
            }],
            isError: false,
            details: { delivered: true },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: sanitizeRemoteMonitorError(error, "message delivery") }],
            isError: true,
            details: { delivered: false },
          };
        }
      }
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

      const routedMode = !cid && messageKind === "status" ? "follow_up" : mode;
      // Cross-window sending is not Monitor-gated: window discovery is
      // restricted to teammate-list, so a reachable target id was either
      // discovered in Monitor mode or carried by an incoming workspace
      // message (the reply path for non-Monitor windows).
      const monitorAuthority = !cid && ownsMonitorCommunication(monitorCapture);
      const provenance = createVerifiedProvenance({
        messageId: id,
        source: monitorAuthority ? "monitor" : "session-router",
        messageKind,
        deliveryMode: routedMode,
        sender: monitorAuthority
          ? { kind: "system", ownerId: currentRootOwnerId(), label: "monitor" }
          : { kind: "root-agent", ownerId: currentRootOwnerId(), label: "main" },
      });
      const delivery = await routeSessionMessage({
        selector: params.to,
        targetCorrelationId: cid,
        message,
        mode: routedMode,
        source: monitorAuthority ? "monitor" : "system",
        messageKind,
        provenance,
        ...(!cid && monitorCapture ? { authorize: () => ownsMonitorCommunication(monitorCapture) } : {}),
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
          ? `Workspace target "${params.to}" was not found. Use teammate-list with view=windows in Monitor mode, or the sender address from the received workspace message.`
          : delivery.error;
        return {
          content: [{ type: "text", text: error ?? `Failed to send message to "${params.to}".` }],
          isError: true,
          details: { delivered: false, provenance },
        };
      }

      if (!cid) {
        const deliveryStage = delivery.receipt?.deliveryStage ?? "queued";
        const effectiveMode = delivery.receipt?.effectiveMode ?? mode;
        if (delivery.transport === "local-root") {
          const disposition = delivery.receipt?.contextDeferred
            ? "stored as context without starting a root turn"
            : deliveryStage;
          return {
            content: [{ type: "text", text: `Message ${disposition} for the root session (kind ${messageKind}, requested ${mode}, effective ${effectiveMode}).` }],
            isError: false,
            details: { delivered: true, provenance },
          };
        }
        const queuedHint = deliveryStage === "queued"
          ? " The message is queued and may not yet be consumed; do not resend it. The peer's reply will be injected after this turn ends; end the turn to receive it."
          : "";
        return {
          content: [{
            type: "text",
            text: `Message ${deliveryStage} for workspace target "${params.to}" (kind ${messageKind}, requested ${mode}, effective ${effectiveMode}).${queuedHint}`,
          }],
          isError: false,
          details: { delivered: true, provenance },
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
          details: { delivered: true, provenance },
        };
      }

      const modeLabel = delivery.receipt?.contextDeferred
        ? "stored as context for the next substantive turn"
        : delivery.receipt?.wasSleeping
          ? "woken up + prompt"
          : delivery.receipt?.mode === "interrupt" ? "active turn cancelled + prompt injected"
          : delivery.receipt?.mode === "steer" ? "queued for turn-boundary injection (does not interrupt tool calls)"
          : "queued until AgentSession would otherwise stop (tool return is not a delivery boundary)";
      return {
        content: [{ type: "text", text: `Message ${modeLabel} for "${params.to}".${delivery.receipt?.wasSleeping ? " Agent woken up." : ""}` }],
        isError: false,
        details: { delivered: true, provenance },
      };
    },

    renderCall(args, theme, context) {
      if (context.isPartial === false) return new Text("", 0, 0);
      const mode = typeof args.mode === "string" ? args.mode : "steer";
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
      params: WindowInboxQuery & { view?: TeammateListView; scope?: "local" | "remote" | "all" },
      signal: AbortSignal,
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
      const monitorCapture = captureMonitorCommunication();
      const monitorOnly = (): TeammateToolResult<{ agents: unknown[] }> => ({
        content: [{ type: "text", text: "Cross-window teammate-list views are available only after the user enters Monitor mode with /monitor." }],
        isError: true,
        details: { agents: [] },
      });
      if (view === "inbox") {
        if (!ownsMonitorCommunication(monitorCapture)) return monitorOnly();
        try {
          const inbox = await loadWorkspaceWindowInbox(
            resolveWindowInboxAnchor(
              state.mainSessionFile,
              ctx.sessionManager?.getSessionFile?.(),
            ),
            params,
          );
          if (!ownsMonitorCommunication(monitorCapture)) return monitorOnly();
          const entries = inbox.entries.map((entry) => ({
            kind: entry.source === "remote" ? "remote-history" as const : "window-message" as const,
            ...entry,
          }));
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
        if (!ownsMonitorCommunication(monitorCapture)) return monitorOnly();
        const scope = params.scope ?? "local";
        const localEntries: Array<{ kind: "window" } & WorkspacePeerWindowListing> = [];
        if (scope !== "remote") {
          await workspacePeerLifecycle;
          await refreshWorkspacePeerOwners();
          if (!ownsMonitorCommunication(monitorCapture)) return monitorOnly();
          localEntries.push(...workspacePeerWindowListings().map((window) => ({
            kind: "window" as const,
            ...window,
          })));
        }
        if (scope === "local") {
          const entries = localEntries;
          const text = formatWorkspacePeerWindowListings(entries);
          return {
            content: [{ type: "text", text }],
            isError: false,
            details: { agents: entries },
          };
        }
        let remoteEntries: Array<{ kind: "ssh-window" } & RemoteWindowMonitorListing> = [];
        let remoteDiagnostics: Array<{ workspaceRef: string; code: string; message: string }> = [];
        try {
          const binding = ensureRemoteMonitorBinding();
          const listed = await binding.windows.list(signal);
          if (!currentRemoteMonitorBinding(binding) || !ownsMonitorCommunication(monitorCapture)) return monitorOnly();
          remoteEntries = listed.windows.map((window) => ({ kind: "ssh-window" as const, ...window }));
          remoteDiagnostics = listed.diagnostics.map((diagnostic) => ({ ...diagnostic }));
          refreshSessionEndpointDirectory(true);
        } catch (error) {
          if (!ownsMonitorCommunication(monitorCapture)) return monitorOnly();
          remoteDiagnostics = [{
            workspaceRef: "configured",
            code: "transport",
            message: sanitizeRemoteMonitorError(error, "window discovery"),
          }];
        }
        const entries = [...localEntries, ...remoteEntries];
        const localText = localEntries.length > 0 ? formatWorkspacePeerWindowListings(localEntries) : "";
        const remoteText = remoteEntries.map((window) =>
          `${window.target} · ${window.status} · ${window.agentCount} agents · workspace ${window.workspaceRef} · cancel=false`
        ).join("\n");
        const diagnosticText = remoteDiagnostics.map((diagnostic) =>
          `[${diagnostic.workspaceRef}] ${diagnostic.code}: ${diagnostic.message}`
        ).join("\n");
        const text = [localText, remoteText, diagnosticText].filter(Boolean).join("\n")
          || "No available compatible remote Pi windows.";
        return {
          content: [{ type: "text", text }],
          ...(scope === "remote" && remoteEntries.length === 0 && remoteDiagnostics.length > 0 ? { isError: true } : { isError: false }),
          details: { agents: entries },
        };
      }
      const local = buildAgentList(state, view as "active" | "named" | "all");
      if (!ownsMonitorCommunication(monitorCapture)) {
        return {
          content: [{ type: "text", text: local.text }],
          isError: false,
          details: { agents: local.entries },
        };
      }
      await workspacePeerLifecycle;
      await refreshWorkspacePeerOwners();
      if (!ownsMonitorCommunication(monitorCapture)) return monitorOnly();
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

  const localListTool: ToolDefinition<typeof LocalTeammateListParams, { agents: unknown[] }> = {
    name: "teammate-list",
    label: "Teammate List",
    renderShell: "self",
    description: LOCAL_TEAMMATE_LIST_DESCRIPTION,
    promptSnippet: LOCAL_TEAMMATE_LIST_SNIPPET,
    promptGuidelines: LOCAL_TEAMMATE_LIST_GUIDELINES,
    parameters: LocalTeammateListParams,
    async execute(id, params, signal, onUpdate, ctx) {
      return listTool.execute(id, params, signal, onUpdate, ctx);
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

  const monitorRegistry = sessionHostRegistry;
  if (!monitorRegistry) throw new Error("Session host registry must exist before Monitor initialization.");

  const currentRemoteMonitorRuns = (): RemoteMonitorRunListing[] => {
    if (!monitorInteractionModeActive || monitorToolExposure?.active !== true) return [];
    const binding = remoteMonitorBinding;
    if (!currentRemoteMonitorBinding(binding)) return [];
    return binding.session.list();
  };

  const syncMonitorInteractionStatus = (): void => {
    if (!widgetCtx?.ui || typeof widgetCtx.ui.setStatus !== "function") return;
    const remoteCount = currentRemoteMonitorRuns().length;
    widgetCtx.ui.setStatus(
      MONITOR_STATUS_KEY,
      monitorInteractionModeActive
        ? `MONITOR · root control · ${remoteCount} remote`
        : undefined,
    );
  };

  const enterMonitorInteractionMode = (): void => {
    const wasActive = monitorInteractionModeActive;
    monitorInteractionModeActive = true;
    try {
      monitorToolExposure?.enter();
    } catch (error) {
      monitorInteractionModeActive = wasActive;
      throw error;
    }
    if (widgetCtx) refreshModelCatalog(widgetCtx);
    syncMonitorInteractionStatus();
  };

  const exitMonitorInteractionMode = (): void => {
    monitorInteractionModeActive = false;
    monitorToolExposure?.exit();
    if (widgetCtx) refreshModelCatalog(widgetCtx);
    void shutdownRemoteMonitorBinding().catch((error) => {
      logDiagnosticError("[pi-maestro-teammate] remote Monitor generation shutdown failed:", sanitizeRemoteMonitorError(error, "shutdown"));
    });
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
      logDiagnosticError("[pi-maestro-teammate] failed to read advisor settings:", error);
    }
    return normalizeAdvisorConfig(section);
  }

  /** Low-frequency turn review on agent_end (best-effort, never blocks). */
  async function runAdvisorReview(event: { messages?: unknown[] }, ctx: ExtensionContext): Promise<void> {
    const fence = captureRootSessionFence();
    const root = state.baseCwd ?? ctx.cwd;
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

    if (!ownsRootSessionFence(fence)) return;
    advisorState.lastReviewAt = Date.now();
    advisorState.reviews += 1;
    const verdict = evaluation.ok && evaluation.verdict ? evaluation.verdict : undefined;
    advisorState.lastVerdict = verdict;
    if (!verdict || verdict.status === "on-track") return;

    // DeliveryGate: cooldown + dedup — the same frequency-control strategy
    // as the fleet Monitor.
    const guidance = verdict.guidance ?? verdict.reason ?? "review the last turn";
    if (advisorState.gate.gate("advisor", guidance, "notify") === undefined) return;
    const provenance = createVerifiedProvenance({
      source: "advisor",
      messageKind: "status",
      deliveryMode: "notify",
      sender: { kind: "system", ownerId: currentRootOwnerId(), label: "advisor" },
    });
    safeSendMessage(pi, {
      customType: "teammate-message",
      content: `[advisor] ${verdict.status === "blocker" ? "⚠ " : ""}${guidance}`,
      display: true,
      details: { source: "advisor", severity: verdict.status, provenance },
    }, { triggerTurn: false });
  }

  monitorRegistry.setControls({
    async requestWindowMode(action) {
      const fence = captureRootSessionFence();
      if (!ownsRootSessionFence(fence)) throw new Error("Monitor session changed before window-mode request.");
      if (action === "enter") {
        await refreshWorkspacePeerOwners();
        if (!ownsRootSessionFence(fence)) throw new Error("Monitor session changed during window discovery.");
        enterMonitorInteractionMode();
        refreshSessionEndpointDirectory(true);
        monitorRegistry.setViewMode("windows");
        return;
      }
      exitMonitorInteractionMode();
      refreshSessionEndpointDirectory(true);
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
    terminationRequested?: boolean;
    completionHandle?: WorkspaceWindowCompletionHandle;
    terminalResult?: WorkspaceWindowTerminalResult;
    settled: boolean;
    terminalPublished: boolean;
    terminalDeadlineAt?: number;
    terminalCloseRequested?: boolean;
    terminalFallbackTimer?: ReturnType<typeof setTimeout>;
    runtimeDeathObservedAt?: number;
  }

  const MAX_MANAGED_WINDOWS = 8;
  /** Terminal requests remain bounded without imposing an ordinary tool-call timeout on worker work. */
  const MANAGED_WINDOW_TERMINAL_DEADLINE_MS = 24 * 60 * 60_000;
  const MANAGED_WINDOW_TERMINAL_ENVELOPE_GRACE_MS = 5_000;
  /** Headless admission window — a cold pi process usually publishes within this. */
  const MANAGED_WINDOW_HANDSHAKE_TIMEOUT_MS = 30_000;
  /** Interactive admission window — terminal launch + cold start regularly exceeds 15s. */
  const MANAGED_WINDOW_HANDSHAKE_TIMEOUT_INTERACTIVE_MS = 60_000;
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

    const cwd = state.baseCwd ?? cwdFallback;
    const piCommand = getPiSpawnCommand(
      buildManagedWindowPiArgs({ sessionName, presentation, forkSessionFile }),
    );
    const env = managedWindowSpawnEnv();
    const launch = presentation === "interactive"
      ? getInteractiveTerminalLaunchSpec(piCommand, cwd, { title: `Pi worker · ${name}`, env })
      : { command: piCommand.command, args: piCommand.args, cwd };
    const child = crossSpawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env,
      stdio: presentation === "headless" ? ["pipe", "ignore", "ignore"] : "ignore",
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
      settled: false,
      terminalPublished: false,
    };
    managedWindows.set(name, window);

    const setup = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => {
        if (presentation === "headless") {
          const stdin = child.stdin;
          if (!stdin || stdin.destroyed || !stdin.writable) {
            reject(new Error(`Headless window "${name}" has no writable RPC input.`));
            return;
          }
          try {
            stdin.write(`${JSON.stringify({
              id: `managed-window-bootstrap-${randomUUID().replace(/-/g, "")}`,
              type: "get_state",
            })}\n`);
          } catch (error) {
            reject(error);
            return;
          }
        }
        resolve();
      });
      child.once("error", reject);
    });
    child.once("exit", (code, signal) => {
      if (presentation === "headless") {
        window.termination?.cleanup();
        if (window.management === "monitor"
          && window.completionHandle
          && window.terminalDeadlineAt !== undefined
          && !window.terminalPublished) {
          armManagedWindowTerminalFallback(window, window.terminalCloseRequested
            ? {
                outcome: "cancelled",
                error: `Workspace window ${name} was closed by its Monitor owner.`,
              }
            : {
                outcome: "failed",
                error: `Workspace worker runtime exited without a canonical terminal envelope (code ${code ?? "?"}, signal ${signal ?? "none"}).`,
              });
        }
        if (managedWindows.get(name) === window) managedWindows.delete(name);
      } else if (code !== 0 && managedWindows.get(name) === window && !window.ownerId) {
        window.launchError = `terminal launcher exited (code ${code ?? "?"}, signal ${signal ?? "none"})`;
      }
      if (!window.terminationRequested && (code !== 0 || signal !== null)) {
        logDiagnosticError(`[pi-maestro-teammate] managed window ${name} launcher exited unexpectedly (code ${code ?? "?"}, signal ${signal ?? "none"})`);
      }
    });

    try {
      await setup;
      return { ok: true, window };
    } catch (error) {
      if (presentation === "headless" && child.exitCode === null && child.signalCode === null) {
        window.terminationRequested = true;
        window.termination?.terminate();
        await window.termination?.outcome;
      }
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

  /**
   * Late-registration recovery: a window admitted after the create handshake
   * timeout still publishes its owner snapshot; capture it into the managed
   * record so the window can be listed, bound, and closed instead of staying
   * orphaned. Mirrors the list tool's owner capture.
   */
  function reconcileManagedWindowOwners(): void {
    for (const window of managedWindows.values()) {
      if (window.ownerId || window.launchError) continue;
      try {
        captureManagedWindowOwner(window, workspacePeerOwners);
      } catch (error) {
        window.launchError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  async function waitForManagedWindowOwner(
    window: ManagedWindow,
    signal: AbortSignal,
  ): Promise<WorkspaceOwnerSnapshot> {
    const timeoutMs = window.presentation === "interactive"
      ? MANAGED_WINDOW_HANDSHAKE_TIMEOUT_INTERACTIVE_MS
      : MANAGED_WINDOW_HANDSHAKE_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error("Managed window creation aborted while waiting for workspace registration.");
      const owners = await refreshWorkspacePeerOwnersStrict();
      if (managedWindows.get(window.name) !== window) throw new Error(`managed window "${window.name}" was replaced`);
      const owner = captureManagedWindowOwner(window, owners);
      if (owner) return owner;
      if (window.launchError) throw new Error(window.launchError);
      await managedWindowDelay(MANAGED_WINDOW_HANDSHAKE_POLL_MS, signal);
    }
    throw new Error(`window "${window.name}" did not register within ${timeoutMs}ms`);
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
      window.terminationRequested = true;
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
    window.terminationRequested = true;
    return terminateProcessTreeByPid(owner.pid);
  }

  function managedWindowPidIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  async function finalizeManagedWindowTerminal(
    window: ManagedWindow,
    draft: WorkspaceWindowTerminalResultDraft,
  ): Promise<boolean> {
    const handle = window.completionHandle;
    if (!handle) return false;
    if (window.terminalPublished) return true;
    const inflight = workspaceTerminalCompletionPublications.get(handle.publicationId);
    if (inflight) return inflight;
    const request = sessionHostRegistry?.thread.get(handle.requestMessageId, "outgoing");
    if (!request || request.terminalResultRequested !== true) {
      logDiagnosticWarn(
        `[pi-maestro-teammate] terminal fallback for ${window.name} has no session-scoped outgoing request ${handle.requestMessageId}.`,
      );
      return false;
    }
    if (window.terminalFallbackTimer) {
      clearTimeout(window.terminalFallbackTimer);
      window.terminalFallbackTimer = undefined;
    }
    const terminalResult = createWorkspaceWindowTerminalResult({
      requestMessageId: handle.requestMessageId,
      ...draft,
    });
    const published = await publishWorkspaceTerminalCompletion(request, terminalResult);
    if (published) {
      window.settled = true;
      window.terminalResult = terminalResult;
      window.terminalPublished = true;
    }
    return published;
  }

  function armManagedWindowTerminalFallback(
    window: ManagedWindow,
    draft: WorkspaceWindowTerminalResultDraft,
  ): void {
    if (window.management !== "monitor"
      || !window.completionHandle
      || window.terminalDeadlineAt === undefined
      || window.terminalPublished
      || window.terminalFallbackTimer) return;
    window.runtimeDeathObservedAt = Date.now();
    window.terminalFallbackTimer = setTimeout(() => {
      void finalizeManagedWindowTerminal(window, draft);
    }, MANAGED_WINDOW_TERMINAL_ENVELOPE_GRACE_MS);
    window.terminalFallbackTimer.unref?.();
  }

  async function reconcileWorkspaceWindowTerminalRequests(): Promise<void> {
    const now = Date.now();
    const requests = sessionHostRegistry?.thread.list().filter((entry) =>
      entry.direction === "outgoing"
      && entry.terminalResultRequested === true
      && entry.messageKind === "request"
      && entry.targetCorrelationId === WORKSPACE_MAIN_SESSION_MARKER
    ) ?? [];
    for (const request of requests) {
      const publicationId = workspaceWindowTerminalPublicationId(request.messageId);
      if (workspaceTerminalCompletionPublications.has(publicationId)) continue;
      const window = [...managedWindows.values()].find((candidate) =>
        candidate.completionHandle?.requestMessageId === request.messageId
      );
      if (now >= request.createdAt + MANAGED_WINDOW_TERMINAL_DEADLINE_MS) {
        await publishWorkspaceTerminalCompletion(request, createWorkspaceWindowTerminalResult({
          requestMessageId: request.messageId,
          outcome: "failed",
          error: `Workspace worker did not publish a canonical terminal envelope within ${MANAGED_WINDOW_TERMINAL_DEADLINE_MS}ms.`,
          settledAt: now,
        }));
        continue;
      }
      if (!window?.pid || managedWindowPidIsAlive(window.pid)) {
        if (window) window.runtimeDeathObservedAt = undefined;
        continue;
      }
      window.runtimeDeathObservedAt ??= now;
      if (now - window.runtimeDeathObservedAt < MANAGED_WINDOW_TERMINAL_ENVELOPE_GRACE_MS) continue;
      await finalizeManagedWindowTerminal(window, {
        outcome: window.terminalCloseRequested ? "cancelled" : "failed",
        error: window.terminalCloseRequested
          ? `Workspace window ${window.name} was closed by its Monitor owner.`
          : `Workspace worker runtime died without publishing a canonical terminal envelope (pid ${window.pid}).`,
      });
    }
  }

  async function stopExactManagedWindow(window: ManagedWindow): Promise<{ ok: boolean; status?: string; error?: string }> {
    const name = window.name;
    try {
      if (managedWindows.get(name) !== window) throw new Error(`managed window "${name}" was replaced`);
      if (window.presentation === "interactive") {
        const owners = await refreshWorkspacePeerOwnersStrict();
        if (managedWindows.get(name) !== window) throw new Error(`managed window "${name}" was replaced`);
        const owner = captureManagedWindowOwner(window, owners);
        if (!owner) {
          const exited = window.pid !== undefined && !managedWindowPidIsAlive(window.pid);
          if (window.launchError || exited) {
            if (managedWindows.get(name) === window) managedWindows.delete(name);
            return { ok: true, status: "already-exited" };
          }
          throw new Error(`Interactive window "${name}" has no fresh authenticated owner; ownership record retained for reconciliation.`);
        }
      }

      const status = await terminateManagedWindowProcess(window);
      if (managedWindows.get(name) === window) managedWindows.delete(name);
      return { ok: true, status };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function stopManagedWindow(name: string): Promise<{ ok: boolean; status?: string; error?: string }> {
    const window = managedWindows.get(name);
    if (!window) return { ok: false, error: `No managed window "${name}".` };
    return stopExactManagedWindow(window);
  }

  async function completeManagedWindowTerminalCommand(
    request: WindowThreadEntry,
    terminal: WorkspaceWindowTerminalResult,
  ): Promise<boolean> {
    const window = [...managedWindows.values()].find((candidate) =>
      candidate.completionHandle?.requestMessageId === request.messageId
    );
    if (window) {
      window.settled = true;
      window.terminalResult = terminal;
    }

    const published = await publishWorkspaceTerminalCompletion(request, terminal);
    if (!published) return false;
    if (!window) return true;

    window.terminalPublished = true;
    window.runtimeDeathObservedAt = undefined;
    if (window.terminalFallbackTimer) {
      clearTimeout(window.terminalFallbackTimer);
      window.terminalFallbackTimer = undefined;
    }
    if (window.presentation === "headless" && managedWindows.get(window.name) === window) {
      const stopped = await stopManagedWindow(window.name);
      if (!stopped.ok) {
        logDiagnosticError(
          `[pi-maestro-teammate] canonical terminal completion published but headless window ${window.name} was not reclaimed: ${stopped.error ?? "unknown error"}`,
        );
      }
    }
    return true;
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
        logDiagnosticError("[pi-maestro-teammate] managed-window shutdown discovery failed; interactive windows will not be killed from stale PID data:", error);
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
              logDiagnosticError(`[pi-maestro-teammate] failed to reconcile delegation ${window.name} before shutdown:`, error);
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
        logDiagnosticError(`[pi-maestro-teammate] managed window ${window.name} was not reclaimed during shutdown:`, error);
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
    if (!workspaceIdentityMatchesCwd(source.workspaceId, ctx.cwd)) {
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
  ): Promise<{ context: DelegationWorkerContext; direct: boolean } | undefined> {
    const freshOption = "New session (fresh) - task document supplies context";
    const forkOption = "Fork current session - worker inherits the source conversation";
    const directOption = "Direct run (fresh, skip planner) - instruction runs as-is";
    preemptCockpitResize();
    const selected = await ctx.ui.select(
      "Delegation worker context",
      [freshOption, forkOption, directOption],
    );
    if (selected === freshOption) return { context: "fresh", direct: false };
    if (selected === forkOption) return { context: "fork", direct: false };
    if (selected === directOption) return { context: "fresh", direct: true };
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

  async function createDirectDelegationDraft(
    request: string,
    workerContext: DelegationWorkerContext,
    ctx: ExtensionCommandContext,
  ): Promise<DelegationRecord> {
    const root = delegationWorkspaceRoot(ctx);
    const source = delegationSourceContext(ctx);
    const task: DelegationTaskDraft = {
      title: request.slice(0, 80) || "Direct delegation",
      objective: request,
      context: "Direct-run delegation: the user instruction is executed as-is without a planner-produced document.",
      deliverables: ["Execute the instruction and report the outcome."],
      acceptanceCriteria: ["The instruction was carried out and the result reported back via teammate-send."],
      constraints: ["Preserve unrelated worktree changes and existing architecture."],
      suggestedFiles: [],
      verification: ["Confirm the instruction's requested behavior and report it."],
    };
    return createDelegationDraft(root, {
      request,
      workerContext,
      source,
      task,
      planner: { agent: "planner", correlationId: "direct" },
      skipDocument: true,
    });
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
      logDiagnosticError("[pi-maestro-teammate] failed to persist delegation rollback:", recordError);
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
    if (!workspaceIdentityMatchesCwd(initialRecord.source.workspaceId, ctx.cwd)) {
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
      status = await terminateProcessTreeByPid(owner.pid);
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
      logDiagnosticError(`[pi-maestro-teammate] failed to close delegation record ${window.name}:`, error);
    }
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
    const canonicalAgent = resolveRuntimeReadAgent(id);
    if (!monitored.found && !canonicalAgent) {
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
    const nativeStatus = canonicalAgent?.status ?? monitored.agentStatus ?? monitored.waitStatus ?? "unknown";
    const settled = nativeStatus === "completed"
      || nativeStatus === "failed"
      || nativeStatus === "terminated"
      || nativeStatus === "sleeping";
    // Runtime activity (nativeStatus) and terminal outcome are separate
    // dimensions: a wakeable agent sleeps after a *failed* run too. Prefer the
    // retained terminal outcome for outcome/terminalStatus so a failed run is
    // never masked as success by its sleeping activity state.
    const liveAgent = resolved.match?.kind === "agent" ? resolved.match.agent : undefined;
    const graphTaskProgress = resolved.match?.kind === "graph-task" ? resolved.match.progress : undefined;
    const settledRecord = resolved.match ? undefined : findSettledAgent(state, id);
    const terminal = canonicalAgent?.lastOutcome?.status
      ?? (canonicalAgent?.status === "failed" || canonicalAgent?.status === "terminated" || canonicalAgent?.status === "completed"
        ? canonicalAgent.status
        : undefined)
      ?? monitored.waitStatus
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
    let detailOutput = settledRecord?.task
      ? ["--- task ---", ...settledRecord.task.split("\n").slice(0, lines), "--- activity ---", ...output]
      : output;
    const transcriptAgent = liveAgent ?? settledRecord;
    if (detail === "full" && transcriptAgent) {
      const load = await loadTranscript({
        correlationId: transcriptAgent.correlationId,
        sessionFile: transcriptAgent.sessionFile,
        parentSessionFile: state.mainSessionFile ?? undefined,
        lastResult: transcriptAgent.lastResult,
        outputLog: transcriptAgent.outputLog,
      });
      const conversation = boundedTranscriptDetail(load.rows, lines, "tail");
      if (conversation.length > 0) {
        detailOutput = [
          ...detailOutput,
          `--- recent conversation${load.source === "memory" ? " (memory fallback)" : ""} ---`,
          ...conversation,
        ];
      }
    }
    const diagnosis = !options.diagnose
      ? undefined
      : canonicalAgent
        ? diagnoseAgentRuntime({
            status: canonicalAgent.status,
            phase: canonicalAgent.phase,
            resultReadyAt: canonicalAgent.resultReadyAt,
            lastActivityAt: canonicalAgent.lastActivityAt,
            turn: canonicalAgent.turn,
            previousOutcome: canonicalAgent.lastOutcome,
          })
        : liveAgent
        ? diagnoseAgentRuntime({
            status: liveAgent.status,
            phase: liveAgent.phase,
            resultReadyAt: liveAgent.resultReadyAt,
            lastActivityAt: liveAgent.lastActivityAt,
            pendingInteractions: liveAgent.pendingInteractions?.size,
            turn: liveAgent.turn,
            previousOutcome: liveAgent.lastOutcome,
          })
        : graphTaskProgress
          ? diagnoseAgentRuntime({
              status: graphTaskProgress.status,
              phase: graphTaskProgress.phase,
              resultReadyAt: graphTaskProgress.resultReadyAt,
              lastActivityAt: graphTaskProgress.lastActivityAt,
              turn: graphTaskProgress.turn,
            })
          : undefined;
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
      ...(diagnosis ? { diagnosis } : {}),
      summary: (canonicalAgent?.lastMessage ?? monitored.summary) || output.at(-1) || nativeStatus,
      ...(includeResult ? { detail: detailOutput } : {}),
      updatedAt: Date.now(),
      capabilities: teammateObservationCapabilities,
    };
  }

  const OBSERVE_TRANSCRIPT_LINE_CHARS = 4_000;

  function transcriptRowLabel(row: TranscriptRow): string {
    switch (row.kind) {
      case "user": return "[user]";
      case "assistant": return "[assistant]";
      case "thinking": return "[thinking]";
      case "tool": return `[tool] ${row.toolName ?? "?"}`;
      case "tool_result": return `[result]${row.isError ? " !" : ""}${row.toolName ? ` ${row.toolName}` : ""}`;
      case "meta": return "[meta]";
      default: return `[${row.role}]`;
    }
  }

  /** Preserve physical conversation lines while bounding any single unbroken line. */
  function formatTurnRow(row: TranscriptRow): string[] {
    const label = transcriptRowLabel(row);
    const physical = row.text.replace(/\r\n/g, "\n").split("\n");
    return (physical.length > 0 ? physical : [""]).map((line, index) => {
      const clipped = line.length > OBSERVE_TRANSCRIPT_LINE_CHARS
        ? `${line.slice(0, OBSERVE_TRANSCRIPT_LINE_CHARS - 1)}…`
        : line;
      return index === 0 ? `${label} ${clipped}`.trimEnd() : `  ${clipped}`;
    });
  }

  function boundedTranscriptDetail(
    rows: readonly TranscriptRow[],
    maxLines: number,
    mode: "head-tail" | "tail" = "head-tail",
  ): string[] {
    const all = rows.flatMap(formatTurnRow);
    const budget = Math.max(1, maxLines);
    if (all.length <= budget) return all;
    if (mode === "tail") {
      if (budget === 1) return [`… ${all.length} conversation line(s); increase lines to inspect`];
      return [`… ${all.length - budget + 1} earlier conversation line(s) omitted`, ...all.slice(-(budget - 1))];
    }
    if (budget === 1) return [`… ${all.length} conversation line(s); increase lines to inspect`];
    const head = Math.max(1, Math.floor((budget - 1) / 2));
    const tail = Math.max(0, budget - head - 1);
    return [
      ...all.slice(0, head),
      `… ${all.length - head - tail} conversation line(s) omitted; increase lines to inspect`,
      ...(tail > 0 ? all.slice(-tail) : []),
    ];
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
      sessionFile: liveAgent?.sessionFile ?? settledRecord?.sessionFile,
      parentSessionFile: state.mainSessionFile ?? undefined,
      lastResult: agent?.lastResult,
      outputLog: liveAgent?.outputLog ?? settledRecord?.outputLog,
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
        summary: `Turn ${turn.index} · ${turn.userText.slice(0, 100)} · ${turn.rowCount} rows · ${turn.toolCallCount} tools`,
        detail: boundedTranscriptDetail(turn.rows, options.lines),
        updatedAt: Date.now(),
        capabilities: teammateObservationCapabilities,
      };
    }
    const listLines = turns.length === 0
      ? (load.source === "memory"
        ? [
          "No persisted session transcript found for this agent (memory fallback).",
          "view=turns reads the agent's on-disk session file; when none is available it",
          "falls back to the bounded in-memory output log, which is empty here.",
          "Use view=live (or detail=full) for the live snapshot with recent output, or",
          "wait for the agent to settle and retry to read its captured result.",
        ]
        : ["No session turns recorded."])
      : turns.map((turn) => {
          const tools = turn.toolCallCount > 0 ? ` · ${turn.toolCallCount} tools` : "";
          const chars = turn.textLength > 0 ? ` · ${turn.textLength} chars` : "";
          return `Turn ${turn.index} · ${turn.userText.slice(0, 100)} · ${turn.rowCount} rows${tools}${chars}`;
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

  const unavailableMonitorObservation = (
    kind: "workspace" | "remote" | "ssh-window",
    id: string,
    message = `${kind === "workspace" ? "Workspace" : kind === "ssh-window" ? "Remote window" : "Remote"} observation requires active Monitor mode.`,
  ): ObservationSnapshot => ({
    target: { kind, id },
    found: false,
    nativeStatus: "monitor-required",
    phase: "unknown",
    outcome: "aborted",
    waitStatus: "aborted",
    summary: message,
    updatedAt: Date.now(),
    error: "monitor-mode-required",
  });

  const workspaceObservationSnapshot = async (
    id: string,
    detail: "summary" | "tail" | "full",
    lines: number,
    options: ObservationReadOptions = { detail, lines },
    fence: RootSessionFence = captureRootSessionFence(),
    monitorCapture: MonitorCommunicationCapture | undefined = captureMonitorCommunication(),
  ): Promise<ObservationSnapshot> => {
    const target: ObservationTarget = {
      kind: "workspace",
      id,
      ...(options.cursor ? { cursor: options.cursor } : {}),
    };
    if (!ownsMonitorCommunication(monitorCapture)) return unavailableMonitorObservation("workspace", id);
    await refreshWorkspacePeerOwners();
    if (!ownsRootSessionFence(fence)) {
      return {
        target,
        found: false,
        nativeStatus: "stale-session",
        phase: "unknown",
        outcome: "aborted",
        waitStatus: "aborted",
        summary: `Workspace observation for ${id} was fenced because the root session changed.`,
        updatedAt: Date.now(),
        error: "stale-root-session",
      };
    }
    if (!ownsMonitorCommunication(monitorCapture)) return unavailableMonitorObservation("workspace", id);
    const ownerId = id.startsWith("owner:") ? id.slice("owner:".length) : id;
    let owner = workspacePeerOwners.find((candidate) => candidate.ownerId === ownerId);
    if (!owner) owner = resolveWorkspaceOwnerByName(workspacePeerOwners, id);
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
    if (options.view === "session") {
      return workspaceSessionObservationSnapshot(owner, target, detail, lines, options.cursor);
    }
    if (options.view === "todos") {
      return workspaceTodosObservationSnapshot(owner, target, detail, lines);
    }
    if (options.view === "turns") return workspaceTurnsSnapshot(owner, target, detail, lines, options);
    const backgroundJobs = owner.backgroundJobs ?? [];
    const foregroundJobs = backgroundJobs.filter((job) => !job.background);
    const lifecycle = workspaceWindowLifecycle(owner);
    const observationStatus = lifecycle.status;
    const output = [
      `${owner.sessionName ?? `window:${owner.ownerId.slice(0, 8)}`} · ${observationStatus} · ${owner.agents.length} agents`
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
      nativeStatus: observationStatus,
      phase: lifecycle.settled ? "settled" : "active",
      ...(lifecycle.settled ? {
        outcome: "success" as const,
        waitStatus: "completed" as const,
        terminalStatus: "completed",
      } : {}),
      // The window's own account of its last finished run. `lifecycle.settled`
      // is inferred from agent counts and idle time, so on its own it cannot
      // distinguish "finished what it was asked" from "has not started yet";
      // this is the run saying so, with what it said.
      ...(owner.mainLastSettle?.lastResult === undefined ? {} : { lastResult: owner.mainLastSettle.lastResult }),
      summary: output[0] ?? observationStatus,
      ...(detail === "summary" ? {} : { detail: output.slice(-Math.max(lines, 1) * 4) }),
      updatedAt: Date.now(),
      capabilities: { inspect: true, wait: true, cancel: false, message: true, supervise: true },
    };
  };
  // Workspace peer view="turns" projection is extracted to a testable module:
  // it groups the peer's bounded mainProgress event ring into turns (assistant
  // text, tool calls, tool results, lifecycle) and supports turn=<n> expansion.
  // Falls back to a run-list view when the peer published no session progress.
  const workspaceTurnsSnapshot = workspaceTurnsSnapshotFn;

  const waitForWorkspaceObservation = async (
    id: string,
    options: Parameters<ObservationProvider["wait"]>[1],
  ): Promise<ObservationSnapshot> => {
    const fence = captureRootSessionFence();
    const monitorCapture = captureMonitorCommunication();
    if (!ownsMonitorCommunication(monitorCapture)) return unavailableMonitorObservation("workspace", id);
    let last = await workspaceObservationSnapshot(id, options.detail, options.lines, options, fence, monitorCapture);
    while (true) {
      if (last.waitStatus === "aborted" || !last.found) return last;
      if (last.phase === "settled") {
        return {
          ...last,
          outcome: "success",
          waitStatus: "completed",
          terminalStatus: last.terminalStatus ?? "completed",
        };
      }
      if (options.until !== "completed" && last.nativeStatus === "result-ready") {
        return { ...last, outcome: "success", waitStatus: "result-ready" };
      }
      if (options.signal.aborted) {
        return { ...last, outcome: "aborted", waitStatus: "aborted", summary: `${last.summary} · observation aborted` };
      }
      const remaining = options.deadline - Date.now();
      if (remaining <= 0) return { ...last, waitStatus: "timeout", summary: `${last.summary} · observation timed out` };
      const pause = Math.min(100, remaining);
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, pause);
        if (options.signal.aborted) finish();
        else options.signal.addEventListener("abort", finish, { once: true });
      });
      if (!ownsRootSessionFence(fence)) {
        return {
          target: { kind: "workspace", id },
          found: false,
          nativeStatus: "stale-session",
          phase: "unknown",
          outcome: "aborted",
          waitStatus: "aborted",
          summary: `Workspace observation for ${id} was fenced because the root session changed.`,
          updatedAt: Date.now(),
          error: "stale-root-session",
        };
      }
      if (!ownsMonitorCommunication(monitorCapture)) return unavailableMonitorObservation("workspace", id);
      last = await workspaceObservationSnapshot(id, options.detail, options.lines, options, fence, monitorCapture);
    }
  };

  registerObservationProvider({
    kind: "workspace",
    capabilities: { inspect: true, wait: true, cancel: false, message: true, supervise: true },
    snapshot: (id, options) => workspaceObservationSnapshot(id, options.detail, options.lines, options),
    wait: waitForWorkspaceObservation,
  });

  const remoteWindowObservationSnapshot = async (
    id: string,
    options: ObservationReadOptions,
    fence: RootSessionFence = captureRootSessionFence(),
    monitorCapture: MonitorCommunicationCapture | undefined = captureMonitorCommunication(),
  ): Promise<ObservationSnapshot> => {
    const target: ObservationTarget = { kind: "ssh-window", id };
    if (!ownsMonitorCommunication(monitorCapture)) return unavailableMonitorObservation("ssh-window", id);
    const binding = remoteMonitorBinding;
    if (!currentRemoteMonitorBinding(binding) || !binding.windows.capture(id)) {
      return {
        target,
        found: false,
        nativeStatus: "not-found",
        phase: "unknown",
        outcome: "failure",
        waitStatus: "not-found",
        summary: `Remote Pi window ${id} is unavailable to the current Monitor session.`,
        updatedAt: Date.now(),
        error: "remote-window-unavailable",
        capabilities: { inspect: true, wait: true, cancel: false, message: true, supervise: true },
      };
    }
    try {
      const observed = await binding.windows.observe(id);
      if (!ownsRootSessionFence(fence) || !currentRemoteMonitorBinding(binding) || !ownsMonitorCommunication(monitorCapture)) {
        return unavailableMonitorObservation("ssh-window", id, "Remote window observation was fenced because Monitor ownership changed.");
      }
      const owner = observed.owner;
      const lifecycle = workspaceWindowLifecycle(owner);
      const lines = [
        `${owner.sessionName ?? id} · ${lifecycle.status} · ${owner.agents.length} agents · cancel=false`,
        ...owner.agents.map((agent) => {
          const idle = Math.max(0, Math.round((Date.now() - agent.lastActivityAt) / 1000));
          return `@${agent.name ?? agent.correlationId.slice(0, 8)} ${agent.status} · idle ${idle}s${agent.summary ? ` · ${agent.summary}` : ""}`;
        }),
      ];
      if (options.detail !== "summary") {
        for (const agent of owner.agents) {
          if (agent.outputTail?.length) lines.push(`-- @${agent.name ?? agent.correlationId.slice(0, 8)} --`, ...agent.outputTail.slice(-options.lines));
        }
      }
      return {
        target,
        found: true,
        nativeStatus: lifecycle.status,
        phase: lifecycle.settled ? "settled" : "active",
        ...(lifecycle.settled ? { outcome: "success" as const, waitStatus: "completed" as const, terminalStatus: "completed" } : {}),
        ...(owner.mainLastSettle?.lastResult === undefined ? {} : { lastResult: owner.mainLastSettle.lastResult }),
        summary: lines[0] ?? id,
        ...(options.detail === "summary" ? {} : { detail: lines }),
        updatedAt: observed.observedAt,
        revision: `${observed.capture.gatewayInstanceNonce}:${owner.ownerNonce}:${owner.publishedAt}`,
        capabilities: { inspect: true, wait: true, cancel: false, message: true, supervise: true },
      };
    } catch (error) {
      if (!ownsRootSessionFence(fence) || !currentRemoteMonitorBinding(binding) || !ownsMonitorCommunication(monitorCapture)) {
        return unavailableMonitorObservation("ssh-window", id, "Remote window observation was fenced because Monitor ownership changed.");
      }
      return {
        target,
        found: false,
        nativeStatus: "failed",
        phase: "unknown",
        outcome: "failure",
        waitStatus: "failed",
        summary: sanitizeRemoteMonitorError(error, "window observation"),
        updatedAt: Date.now(),
        error: "remote-window-observation-failed",
        capabilities: { inspect: true, wait: true, cancel: false, message: true, supervise: true },
      };
    }
  };

  registerObservationProvider({
    kind: "ssh-window",
    capabilities: { inspect: true, wait: true, cancel: false, message: true, supervise: true },
    snapshot: (id, options) => remoteWindowObservationSnapshot(id, options),
    wait: async (id, options) => {
      const fence = captureRootSessionFence();
      const monitorCapture = captureMonitorCommunication();
      let last = await remoteWindowObservationSnapshot(id, options, fence, monitorCapture);
      while (last.found && last.phase !== "settled") {
        if (options.signal.aborted) return { ...last, outcome: "aborted", waitStatus: "aborted" };
        const remaining = options.deadline - Date.now();
        if (remaining <= 0) return { ...last, waitStatus: "timeout" };
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
        last = await remoteWindowObservationSnapshot(id, options, fence, monitorCapture);
      }
      return last;
    },
  });

  const unavailableRemoteObservation = (id: string): ObservationSnapshot => ({
    target: { kind: "remote", id },
    found: false,
    nativeStatus: "not-found",
    phase: "unknown",
    outcome: "failure",
    waitStatus: "not-found",
    summary: `Remote run ${id} is not owned by the current Monitor session.`,
    updatedAt: Date.now(),
    error: "remote-owner-unavailable",
    capabilities: { inspect: true, wait: true, cancel: true, message: true, supervise: true },
  });

  registerObservationProvider({
    kind: "remote",
    capabilities: { inspect: true, wait: true, cancel: true, message: true, supervise: true },
    snapshot: (id, options) => {
      const monitorCapture = captureMonitorCommunication();
      if (!ownsMonitorCommunication(monitorCapture)) return unavailableMonitorObservation("remote", id);
      const binding = remoteMonitorBinding;
      return currentRemoteMonitorBinding(binding)
        ? binding.session.observation(id, options)
        : unavailableRemoteObservation(id);
    },
    wait: async (id, options) => {
      const monitorCapture = captureMonitorCommunication();
      if (!ownsMonitorCommunication(monitorCapture)) return unavailableMonitorObservation("remote", id);
      const binding = remoteMonitorBinding;
      const observation = currentRemoteMonitorBinding(binding)
        ? await binding.session.waitObservation(id, options)
        : unavailableRemoteObservation(id);
      return ownsMonitorCommunication(monitorCapture)
        ? observation
        : unavailableMonitorObservation("remote", id);
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
      const monitorCapture = captureMonitorCommunication();
      const hasCrossWindowTarget = params.targets.some((target) => target.kind === "workspace" || target.kind === "remote");
      const monitorOnly = (): TeammateToolResult<{ output: string[]; result: ObserveResult }> => {
        const message = "Workspace and remote observation targets are available only after the user enters Monitor mode with /monitor.";
        const denied: ObserveResult = {
          action: params.action,
          reason: params.action === "status" ? "snapshot" : "aborted",
          observations: [],
          durationMs: 0,
        };
        return {
          content: [{ type: "text", text: message }],
          isError: true,
          details: { output: [message], result: denied },
        };
      };
      if (hasCrossWindowTarget && !ownsMonitorCommunication(monitorCapture)) return monitorOnly();
      const result = await observeTargets(params, signal);
      if (hasCrossWindowTarget && !ownsMonitorCommunication(monitorCapture)) return monitorOnly();
      const output = formatObserveResult(result, params.detail !== "summary" || params.view === "turns");
      if ((params.action === "watch" || params.action === "wait")
        && ownsMonitorCommunication(monitorCapture)) {
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

  const localObserveTool: ToolDefinition<typeof LocalObserveParams, { output: string[]; result: ObserveResult }> = {
    ...observeTool,
    prepareArguments: undefined,
    description: LOCAL_OBSERVE_DESCRIPTION,
    promptSnippet: LOCAL_OBSERVE_SNIPPET,
    promptGuidelines: LOCAL_OBSERVE_GUIDELINES,
    parameters: LocalObserveParams,
    async execute(id, params, signal, onUpdate, ctx) {
      if (params.targets.some((target) => target.kind !== "teammate" && target.kind !== "bash_bg")) {
        const message = "Non-Monitor observe accepts only local teammate and bash_bg targets.";
        return {
          content: [{ type: "text", text: message }],
          isError: true,
          details: {
            output: [message],
            result: {
              action: params.action,
              reason: params.action === "status" ? "snapshot" : "aborted",
              observations: [],
              durationMs: 0,
            },
          },
        };
      }
      return observeTool.execute(id, params, signal, onUpdate, ctx);
    },
  };

  // --- LLM tool: monitor (normalized window state; Monitor-exclusive) ---

  const captureMonitorQueryAuthority = (): MonitorQueryAuthorityFence | undefined => {
    const root = captureRootSessionFence();
    const monitor = captureMonitorCommunication();
    if (!root.sessionId || !root.workspaceId || !root.sourceId || !monitor
      || !ownsRootSessionFence(root) || !ownsMonitorCommunication(monitor)) return undefined;
    return Object.freeze({
      rootGeneration: root.generation,
      sessionId: root.sessionId,
      workspaceId: root.workspaceId,
      sourceId: root.sourceId,
      monitorGeneration: monitor.generation,
    });
  };

  const ownsMonitorQueryAuthority = (capture: MonitorQueryAuthorityFence): boolean =>
    ownsRootSessionFence({
      generation: capture.rootGeneration,
      sessionId: capture.sessionId,
      workspaceId: capture.workspaceId,
      sourceId: capture.sourceId,
    })
    && ownsMonitorCommunication({ generation: capture.monitorGeneration });

  const monitorIdentityForEndpoint = (endpoint: SessionEndpoint): MonitorWindowIdentityV1 => ({
    workspaceId: endpoint.workspaceId,
    ownerId: endpoint.ownerId,
    ownerNonce: endpoint.ownerNonce,
    endpointId: endpoint.id,
  });

  const sameMonitorWindowIdentity = (
    left: MonitorWindowIdentityV1,
    right: MonitorWindowIdentityV1,
  ): boolean => left.workspaceId === right.workspaceId
    && left.ownerId === right.ownerId
    && left.ownerNonce === right.ownerNonce
    && left.endpointId === right.endpointId;

  const boundedMonitorTimelineText = (value: string, maximum = 512): string => {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > maximum ? `${normalized.slice(0, maximum - 1)}…` : normalized;
  };

  const monitorTimelineForWindow = (
    owner: WorkspaceOwnerSnapshot | undefined,
    thread: readonly WindowThreadEntry[],
  ): MonitorQueryTimelineGroup[] => {
    const groups: MonitorQueryTimelineGroup[] = [];
    if (owner?.mainProgress?.events.length) {
      groups.push({
        group: "root-session",
        entries: owner.mainProgress.events.map((event) => event.kind === "assistant"
          ? { at: event.at, label: "assistant", detail: boundedMonitorTimelineText(event.text) }
          : event.kind === "tool"
            ? { at: event.at, label: `tool ${event.toolName}`, detail: event.status }
            : { at: event.at, label: "lifecycle", detail: event.phase }),
      });
    }
    if (owner?.agents.length) {
      groups.push({
        group: "agents",
        entries: owner.agents.map((agent) => ({
          at: agent.lastActivityAt,
          label: agent.name ?? agent.correlationId,
          detail: boundedMonitorTimelineText([agent.agent, agent.status, agent.summary].filter(Boolean).join(" · ")),
        })),
      });
    }
    if (thread.length) {
      groups.push({
        group: "delivery",
        entries: thread.map((entry) => ({
          at: entry.updatedAt,
          label: `${entry.direction} ${entry.status}`,
          detail: boundedMonitorTimelineText(entry.body),
        })),
      });
    }
    return groups;
  };

  const buildMonitorQuerySnapshot = async (
    authority: MonitorQueryAuthorityFence,
    signal: AbortSignal,
  ): Promise<MonitorQuerySnapshot> => {
    if (!ownsMonitorQueryAuthority(authority)) throw new Error("Monitor query authority is stale before refresh.");
    await workspacePeerLifecycle;
    await refreshWorkspacePeerOwners();
    if (!ownsMonitorQueryAuthority(authority)) throw new Error("Monitor query authority changed during workspace refresh.");

    let remoteBinding = currentRemoteMonitorBinding(remoteMonitorBinding) ? remoteMonitorBinding : undefined;
    try {
      remoteBinding ??= ensureRemoteMonitorBinding();
      await remoteBinding.windows.list(signal);
      if (!currentRemoteMonitorBinding(remoteBinding) || !ownsMonitorQueryAuthority(authority)) {
        throw new Error("Monitor query authority changed during remote window refresh.");
      }
    } catch (error) {
      if (!ownsMonitorQueryAuthority(authority)) throw error;
      logDiagnosticWarn("[pi-maestro-teammate] monitor remote window refresh degraded:", sanitizeRemoteMonitorError(error, "monitor query"));
      remoteBinding = currentRemoteMonitorBinding(remoteBinding) ? remoteBinding : undefined;
    }
    refreshSessionEndpointDirectory(true);

    const endpoints = monitorRegistry.listEndpoints().filter((endpoint) =>
      endpoint.kind === "root" && (endpoint.scope === "workspace-peer" || endpoint.scope === "ssh-window")
    );
    const remoteRunByEndpoint = new Map<string, RemoteMonitorRunListing>();
    for (const [index, run] of currentRemoteMonitorRuns().entries()) {
      const endpointId = `monitor-remote-run/v1/${encodeURIComponent(run.targetId)}/${encodeURIComponent(run.runId)}/${run.generation}`;
      const status: SessionEndpoint["status"] = run.status === "waiting"
        ? "sleeping"
        : run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "lost"
          ? "settled"
          : "running";
      const contentRevision = createHash("sha256").update(JSON.stringify({
        status: run.status,
        sequence: run.lastSequence,
        summary: run.summary,
      }), "utf8").digest("hex");
      const endpoint: SessionEndpoint = {
        version: SESSION_ENDPOINT_VERSION,
        id: endpointId,
        kind: "root",
        scope: "ssh-window",
        transport: "remote-workspace-rpc-v1",
        status,
        capabilities: ["inspect", "message", "steer", "follow_up"],
        ordinal: endpoints.length + index,
        contentRevision,
        workspaceId: authority.workspaceId,
        ownerId: run.workerId,
        ownerNonce: run.instanceNonce,
        sourceId: run.workerId,
        generation: run.generation,
        workspaceRef: run.targetId,
        target: run.target,
        routeAuthority: { kind: "ssh", authorityId: run.targetId, instanceNonce: run.instanceNonce },
        ...(run.name === undefined ? {} : { name: run.name, sessionName: run.name }),
        ...(run.summary === undefined ? {} : { summary: run.summary }),
      };
      endpoints.push(endpoint);
      remoteRunByEndpoint.set(endpointId, run);
    }
    const capturedOwners = new Map<string, WorkspaceOwnerSnapshot>();
    for (const endpoint of endpoints) {
      if (endpoint.scope !== "workspace-peer") continue;
      const owner = workspacePeerOwners.find((candidate) =>
        candidate.workspaceId === endpoint.workspaceId
        && candidate.ownerId === endpoint.ownerId
        && candidate.ownerNonce === endpoint.ownerNonce
      );
      if (owner) capturedOwners.set(endpoint.id, owner);
    }

    if (remoteBinding) {
      await Promise.all(endpoints.filter((endpoint) =>
        endpoint.scope === "ssh-window" && !remoteRunByEndpoint.has(endpoint.id)
      ).map(async (endpoint) => {
        const target = endpoint.target;
        if (!target) return;
        try {
          const observed = await remoteBinding!.windows.observe(target);
          if (!currentRemoteMonitorBinding(remoteBinding) || !ownsMonitorQueryAuthority(authority)) {
            throw new Error("Monitor query authority changed during remote owner read.");
          }
          if (observed.owner.workspaceId === endpoint.workspaceId
            && observed.owner.ownerId === endpoint.ownerId
            && observed.owner.ownerNonce === endpoint.ownerNonce) {
            capturedOwners.set(endpoint.id, observed.owner);
          }
        } catch (error) {
          if (!ownsMonitorQueryAuthority(authority)) throw error;
          logDiagnosticWarn(`[pi-maestro-teammate] monitor owner facet degraded for ${target}:`, sanitizeRemoteMonitorError(error, "owner read"));
        }
      }));
    }
    if (!ownsMonitorQueryAuthority(authority)) throw new Error("Monitor query authority changed during owner reads.");

    const threadSnapshot = [...monitorRegistry.thread.list()];
    const reductionItems: MonitorWindowReductionItemV1[] = [];
    const facetTargets: MonitorWindowFacetTargetV1[] = [];
    const targetMetadata: Array<{
      endpoint: SessionEndpoint;
      identity: MonitorWindowIdentityV1;
      target: string;
      aliases: string[];
      owner?: WorkspaceOwnerSnapshot;
      thread: WindowThreadEntry[];
      workRef?: { kind: string; id: string };
      timeline?: MonitorQueryTimelineGroup[];
    }> = [];

    for (const endpoint of endpoints) {
      const identity = monitorIdentityForEndpoint(endpoint);
      const owner = capturedOwners.get(endpoint.id);
      const remoteRun = remoteRunByEndpoint.get(endpoint.id);
      const exactThread = remoteRun ? [] : threadSnapshot.filter((entry) =>
        entry.workspaceId === identity.workspaceId
        && entry.peerOwnerId === identity.ownerId
        && entry.peerOwnerNonce === identity.ownerNonce
      );
      const managedWindow = remoteRun ? undefined : [...managedWindows.values()].find((candidate) =>
        candidate.ownerId === identity.ownerId && candidate.ownerNonce === identity.ownerNonce
      );
      const latestOutgoing = [...exactThread].reverse().find((entry) => entry.direction === "outgoing");
      const messageId = managedWindow?.completionHandle?.requestMessageId ?? latestOutgoing?.messageId;
      const workRef = remoteRun
        ? { kind: "remote-run", id: remoteRun.runId }
        : messageId ? { kind: "message", id: messageId } : undefined;
      const target = endpoint.scope === "ssh-window" ? (endpoint.target ?? endpoint.id) : `owner:${identity.ownerId}`;
      const aliases = [endpoint.id, identity.ownerId, endpoint.sessionName, managedWindow?.name, remoteRun?.name]
        .filter((value): value is string => Boolean(value) && value !== target);
      const managed: MonitorManagedWindowEvidenceV1 | undefined = remoteRun
        ? {
            target: { identity },
            metadata: {
              name: remoteRun.name ?? remoteRun.target,
              sessionName: remoteRun.name ?? remoteRun.target,
              ...(remoteRun.objective === undefined ? {} : { objective: remoteRun.objective }),
              presentation: "headless",
              management: "monitor",
              startedAt: remoteRun.createdAt,
            },
          }
        : managedWindow
          ? {
              target: { identity },
              metadata: {
                name: managedWindow.name,
                sessionName: managedWindow.sessionName,
                objective: managedWindow.objective,
                presentation: managedWindow.presentation,
                management: managedWindow.management,
                ...(managedWindow.pid === undefined ? {} : { pid: managedWindow.pid }),
                startedAt: managedWindow.startedAt,
                ...(managedWindow.launchError === undefined ? {} : { launchError: managedWindow.launchError }),
              },
            }
          : undefined;
      const delivery: MonitorWindowThreadEvidenceV1[] = workRef && !remoteRun
        ? exactThread.map((entry) => ({ target: { identity, workRef }, entry }))
        : [];
      const completion: MonitorWindowCompletionEvidenceV1[] = remoteRun && workRef
        && (remoteRun.status === "completed" || remoteRun.status === "failed" || remoteRun.status === "cancelled" || remoteRun.status === "lost")
        ? [{
            target: { identity, workRef },
            source: "exact-report",
            outcome: remoteRun.status === "completed" ? "completed" : remoteRun.status === "cancelled" ? "cancelled" : "failed",
            revision: `${remoteRun.generation}:${remoteRun.lastSequence}:${remoteRun.status}`,
            completedAt: remoteRun.updatedAt,
            ...(remoteRun.summary === undefined ? {} : { summary: remoteRun.summary }),
          }]
        : managedWindow?.terminalResult && workRef
          ? [{
              target: { identity, workRef },
              source: "canonical-completion",
              outcome: managedWindow.terminalResult.outcome,
              revision: workspaceWindowTerminalPublicationId(managedWindow.terminalResult.requestMessageId),
              completedAt: managedWindow.terminalResult.settledAt,
              ...((managedWindow.terminalResult.finalText ?? managedWindow.terminalResult.error) === undefined
                ? {}
                : { summary: managedWindow.terminalResult.finalText ?? managedWindow.terminalResult.error }),
            }]
          : [];
      const remoteTimeline: MonitorQueryTimelineGroup[] | undefined = remoteRun && remoteBinding
        ? [{
            group: "remote-run",
            entries: (remoteBinding.session.observation(remoteRun.target, { detail: "full", lines: 200 }).detail ?? [])
              .map((line) => ({ label: boundedMonitorTimelineText(line) })),
          }]
        : undefined;
      reductionItems.push({ endpoint, owner, managed, workRef, delivery, completion });
      facetTargets.push({ identity });
      if (workRef) facetTargets.push({ identity, workRef });
      targetMetadata.push({ endpoint, identity, target, aliases, owner, thread: exactThread, workRef, timeline: remoteTimeline });
    }

    const facets = await readMonitorWindowFacets({
      version: MONITOR_WINDOW_STATE_VERSION,
      targets: facetTargets,
    }, (message) => logDiagnosticWarn(`[pi-maestro-teammate] ${message}`));
    if (!ownsMonitorQueryAuthority(authority)) throw new Error("Monitor query authority changed during facet reads.");

    for (const item of reductionItems) {
      const identity = monitorIdentityForEndpoint(item.endpoint);
      const remoteRun = remoteRunByEndpoint.get(item.endpoint.id);
      if (remoteRun) {
        const binding = remoteBinding;
        const current = binding && currentRemoteMonitorBinding(binding) ? binding.session.capture(remoteRun.target) : undefined;
        if (!current
          || current.workerId !== remoteRun.workerId
          || current.instanceNonce !== remoteRun.instanceNonce
          || current.generation !== remoteRun.generation
          || current.monitorOwnerNonce !== binding?.session.monitorOwnerNonce) {
          throw new Error(`Remote Monitor run ${remoteRun.target} changed owner during snapshot reduction.`);
        }
      } else {
        const current = monitorRegistry.directory.get(item.endpoint.id);
        if (!current || !sameMonitorWindowIdentity(identity, monitorIdentityForEndpoint(current))) {
          throw new Error(`Monitor window ${item.endpoint.id} changed owner during snapshot reduction.`);
        }
      }
      item.facets = facets.filter((facet) => sameMonitorWindowIdentity(facet.target.identity, identity));
    }

    const stateSnapshot = reduceMonitorWindowStateV1({ observedAt: Date.now(), windows: reductionItems });
    return {
      state: stateSnapshot,
      targets: targetMetadata.map((metadata) => ({
        target: metadata.target,
        aliases: metadata.aliases,
        identity: metadata.identity,
        timeline: metadata.timeline ?? monitorTimelineForWindow(metadata.owner, metadata.thread),
      })),
    };
  };

  const monitorQueryDependencies = {
    captureAuthority: captureMonitorQueryAuthority,
    isAuthorityCurrent: ownsMonitorQueryAuthority,
    read: buildMonitorQuerySnapshot,
  };
  const executeMonitorQuery = (params: Parameters<typeof runMonitorQuery>[0], signal: AbortSignal) =>
    runMonitorQuery(params, monitorQueryDependencies, signal);

  const windowMonitorTool: ToolDefinition<typeof MonitorQueryParams, ReturnType<typeof runMonitorQuery> extends Promise<infer Result> ? Result : never> = {
    name: "monitor",
    label: "Monitor Windows",
    renderShell: "self",
    description: `Read normalized window-domain state in the active root Monitor generation.

Use list for an attention-first overview, get for one complete normalized window card, and wait for one window's change, attention, or settled condition. This read-only tool does not expose provider transcripts or multi-target barriers. Use observe when you need raw provider snapshots, turns/todos/diagnose views, or an all/any/count barrier.`,
    promptSnippet: "List, inspect, or wait on normalized Monitor window state.",
    promptGuidelines: [
      "Use monitor for ordinary window status and attention; use observe only for provider-level diagnostics or multi-target barriers.",
      "Retain the exact target and cursor returned by monitor; stale results mean the owner or Monitor generation changed and must be listed again.",
      "Queued or accepted delivery is not model consumption; only injected or replied state proves consumption.",
    ],
    parameters: MonitorQueryParams,
    async execute(_id: string, params, signal: AbortSignal) {
      const query = await executeMonitorQuery(params, signal);
      const output = formatMonitorQueryResult(query);
      return {
        content: [{ type: "text", text: output.join("\n") }],
        isError: query.status !== "ok",
        details: query,
      };
    },
    renderCall(_args, theme, context) {
      if (context.isPartial === false) return new Text("", 0, 0);
      return auxToolCallFallback("monitor", theme);
    },
    renderResult(result, options, theme) {
      if (options.isPartial) return new Text("", 0, 0);
      return auxToolResultFallback(result, theme);
    },
  };

  // --- LLM tool: teammate-monitor (legacy status + wait only) ---

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
    handle?: WorkspaceWindowCompletionHandle;
  }

  interface WorkspaceWindowToolDetails {
    action: WorkspaceWindowToolParams["action"];
    windows: WorkspaceWindowToolWindow[];
    handle?: WorkspaceWindowCompletionHandle;
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
        ...(window.completionHandle ? { handle: window.completionHandle } : {}),
      };
    });
  }

  const monitorWindowLifecycle = new MonitorWindowLifecycleService<
    MonitorQueryAuthorityFence,
    ManagedWindow,
    WorkspaceOwnerSnapshot,
    WorkspaceWindowCompletionHandle,
    SessionMessageResult
  >({
    captureAuthority: captureMonitorQueryAuthority,
    isAuthorityCurrent: ownsMonitorQueryAuthority,
    createHandle: () => workspaceWindowCompletionHandle(randomUUID().replace(/-/g, "")),
    spawn: (request: MonitorWindowCreateRequest) => spawnManagedWindow(
      request.name,
      request.objective,
      request.cwd,
      request.presentation,
      managedWindowSessionName(request.name),
    ),
    isCurrentWindow: (window) => managedWindows.get(window.name) === window,
    waitForOwner: waitForManagedWindowOwner,
    refreshOwners: async () => { await refreshWorkspacePeerOwnersStrict(); },
    exactOwner: exactManagedWindowOwner,
    sameOwner: (left, right) => left.workspaceId === right.workspaceId
      && left.ownerId === right.ownerId
      && left.ownerNonce === right.ownerNonce
      && left.pid === right.pid
      && left.sessionName === right.sessionName,
    bindHandle: (window, handle) => { window.completionHandle = handle; },
    deliverObjective: ({ request, owner, handle, signal, authorize }) => routeSessionMessage({
      selector: `owner:${owner.ownerId}`,
      message: request.objective,
      mode: "follow_up",
      messageId: handle.requestMessageId,
      traceId: handle.correlationId,
      source: "monitor",
      messageKind: "request",
      terminalResultRequested: true,
      targetCorrelationId: WORKSPACE_MAIN_SESSION_MARKER,
      authorize,
      signal,
    }),
    deliveryState: (delivery) => ({
      published: delivery.receipt?.publicationStage === "published"
        || delivery.receipt?.publicationStage === "accepted",
      accepted: delivery.delivered && delivery.receipt?.publicationStage === "accepted",
      ...(delivery.error === undefined ? {} : { error: delivery.error }),
    }),
    commitPublished: (window, handle) => {
      const requestEntry = sessionHostRegistry?.thread.get(handle.requestMessageId, "outgoing");
      if (!requestEntry || requestEntry.terminalResultRequested !== true) {
        throw new Error(`Terminal result request for window "${window.name}" was published without its outgoing journal entry.`);
      }
      window.terminalDeadlineAt = requestEntry.createdAt + MANAGED_WINDOW_TERMINAL_DEADLINE_MS;
      if (window.child.exitCode !== null || window.child.signalCode !== null) {
        armManagedWindowTerminalFallback(window, {
          outcome: "failed",
          error: `Workspace worker runtime exited before terminal setup acknowledgement (code ${window.child.exitCode ?? "?"}, signal ${window.child.signalCode ?? "none"}).`,
        });
      }
    },
    lookup: (name) => managedWindows.get(name),
    handleOf: (window) => window.completionHandle,
    isMonitorManaged: (window) => window.management === "monitor",
    markCloseRequested: (window, requested) => { window.terminalCloseRequested = requested; },
    stopExact: stopExactManagedWindow,
    finalizeCancelled: (window, message) => finalizeManagedWindowTerminal(window, {
      outcome: "cancelled",
      error: message,
    }),
  });

  const workspaceWindowTool: ToolDefinition<typeof WorkspaceWindowParams, WorkspaceWindowToolDetails> = {
    name: "workspace-window",
    label: "Workspace Window",
    renderShell: "self",
    description: `Create, list, or close Pi worker windows owned by the active Monitor coordinator.

This lifecycle tool is available only after the user enters Monitor mode with /monitor. Create opens an interactive terminal by default, waits for exact workspace-peer registration, returns the exact owner target for direct observation and messaging, and provides an optional canonical completion handle. Close is restricted to windows created by this Monitor session; discovered external peer windows can be messaged or observed but cannot be closed. Terminal results remain retrievable after process exit through the handle's immutable agent:// resource; result bodies are not inlined into completion notices.`,
    promptSnippet: "Create, list, or close Monitor-owned Pi worker windows.",
    promptGuidelines: [
      "Use create only when the user's monitoring or coordination request requires a new worker window; do not create speculative workers.",
      "The create call already delivers its objective to the worker. After create, do not resend that objective; use the returned owner target only for later corrections, new constraints, explicit response requests, or safety/lifecycle instructions.",
      "Before close, retain the returned completion handle. Closing pending work forms a canonical cancelled completion at the same immutable agent:// resource.",
      "Read a settled result with the resource tool using the returned agent:// URI; completion notices contain only a status summary and that URI.",
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
        handle?: WorkspaceWindowCompletionHandle,
      ): TeammateToolResult<WorkspaceWindowToolDetails> => ({
        content: [{ type: "text", text }],
        ...(isError ? { isError: true } : {}),
        details: {
          action: params.action,
          windows: workspaceWindowSnapshots(),
          ...(handle ? { handle } : {}),
        },
      });

      const monitorCapture = captureMonitorCommunication();
      if (!ownsMonitorCommunication(monitorCapture)) {
        return result("workspace-window is available only after the user enters Monitor mode with /monitor.", true);
      }

      if (params.action === "list") {
        await refreshWorkspacePeerOwners();
        if (!ownsMonitorCommunication(monitorCapture)) {
          return result("Monitor mode ended during workspace-window list.", true);
        }
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
        const closed = await monitorWindowLifecycle.close(name);
        if (!closed.ok) return result(closed.error ?? `Failed to close ${name}.`, true, closed.handle);
        return result(`Closed Monitor-owned window ${name} (${closed.status ?? "stopped"}).`, false, closed.handle);
      }

      const objective = params.objective?.trim();
      if (!objective) return result("objective is required for workspace-window create.", true);

      const presentation = params.presentation ?? "interactive";
      const created = await monitorWindowLifecycle.create({
        name,
        objective,
        cwd: state.baseCwd || process.cwd(),
        presentation,
      }, signal);
      if (!created.ok || !created.owner || !created.handle) {
        return result(created.error ?? `Failed to create ${name}.`, true, created.handle);
      }
      return result(
        `Created ${presentation} worker window ${name} as owner:${created.owner.ownerId}. Result: ${created.handle.resource}`,
        false,
        created.handle,
      );
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

  interface RemoteWorkerToolParams {
    action: "targets" | "create" | "list" | "close";
    targetId?: string;
    name?: string;
    objective?: string;
    runId?: string;
  }

  interface RemoteWorkerToolDetails {
    action: RemoteWorkerToolParams["action"];
    targets: RemoteMonitorTargetListing[];
    runs: RemoteMonitorRunListing[];
  }

  const remoteWorkerTool: ToolDefinition<typeof RemoteWorkerParams, RemoteWorkerToolDetails> = {
    name: "remote-worker",
    label: "Remote Worker",
    renderShell: "self",
    description: `Create, list, or close SSH-backed remote runs owned by the active root Monitor session.

This Monitor-only lifecycle tool loads configured target ids without exposing SSH credentials or trusted commands. Create returns only after the SSH gateway handshake, capability negotiation, remote start, and local ownership admission succeed. Runs are addressed by stable remote:<runId> targets. Close performs owner-fenced lifecycle cancellation; teammate-send abort remains unavailable for remote targets.`,
    promptSnippet: "List configured remote targets or manage Monitor-owned remote runs.",
    promptGuidelines: [
      "Call targets before create when the configured target id is unknown.",
      "Do not resend the create objective. Use teammate-send only for later corrections, constraints, explicit response requests, or safety instructions.",
      "Observe remote runs with kind=remote and the returned remote:<runId> id.",
      "Collect required results before close; close is restricted to runs admitted under this Monitor owner nonce.",
    ],
    parameters: RemoteWorkerParams,
    async execute(
      _id: string,
      params: RemoteWorkerToolParams,
      signal: AbortSignal,
    ): Promise<TeammateToolResult<RemoteWorkerToolDetails>> {
      const details = (): RemoteWorkerToolDetails => {
        if (!ownsMonitorCommunication(captureMonitorCommunication())) {
          return { action: params.action, targets: [], runs: [] };
        }
        const binding = remoteMonitorBinding;
        if (!currentRemoteMonitorBinding(binding)) return { action: params.action, targets: [], runs: [] };
        return { action: params.action, targets: binding.session.targets(), runs: binding.session.list() };
      };
      const result = (text: string, isError = false): TeammateToolResult<RemoteWorkerToolDetails> => ({
        content: [{ type: "text", text }],
        ...(isError ? { isError: true } : {}),
        details: details(),
      });

      const monitorCapture = captureMonitorCommunication();
      if (!ownsMonitorCommunication(monitorCapture)) {
        return result("remote-worker is available only after the user enters Monitor mode with /monitor.", true);
      }

      try {
        const binding = ensureRemoteMonitorBinding();
        if (params.action === "targets") {
          const targets = binding.session.targets();
          if (targets.length === 0) return result("No configured remote worker targets.");
          return result(targets.map((target) =>
            `${target.id} · host=${target.hostId} · driver=${target.driver} · cwd=${target.cwd}`
          ).join("\n"));
        }
        if (params.action === "list") {
          const runs = binding.session.list();
          if (runs.length === 0) return result("No remote runs owned by this Monitor session.");
          return result(runs.map((run) =>
            `${run.status === "completed" ? "✓" : run.status === "failed" || run.status === "lost" ? "✗" : "■"} ${run.target} · ${run.name ?? "remote"} · ${run.status} · target=${run.targetId}`
          ).join("\n"));
        }
        if (params.action === "close") {
          if (!params.runId) return result("runId is required for remote-worker close.", true);
          const closed = await binding.session.closeRun(params.runId);
          if (!ownsMonitorCommunication(monitorCapture)) {
            return result("Monitor mode ended during remote-worker close.", true);
          }
          syncMonitorInteractionStatus();
          if (!closed.accepted) return result(`Remote worker ${params.runId} rejected lifecycle cancellation.`, true);
          return result(`Closed Monitor-owned remote worker ${params.runId} (${closed.status}).`);
        }
        if (!params.targetId || !params.name || !params.objective) {
          return result("targetId, name, and objective are required for remote-worker create.", true);
        }
        const run = await binding.session.create({
          targetId: params.targetId,
          name: params.name,
          objective: params.objective,
          signal,
        });
        if (!ownsMonitorCommunication(monitorCapture)) {
          return result("Monitor mode ended before the remote worker could be admitted.", true);
        }
        syncMonitorInteractionStatus();
        return result(`Created remote worker ${run.target} on ${run.targetId} after SSH handshake and ownership admission.`);
      } catch (error) {
        return result(sanitizeRemoteMonitorError(error, "worker operation"), true);
      }
    },
    renderCall(_args, theme, context) {
      if (context.isPartial === false) return new Text("", 0, 0);
      return auxToolCallFallback("remote-worker", theme);
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
  monitorToolExposure = new MonitorToolExposureController(pi, {
    local: [sendTool, localListTool, localObserveTool],
    monitor: [sendTool, listTool, observeTool],
    exclusiveNames: ["monitor", "workspace-window", "remote-worker"],
  });
  pi.registerTool(windowMonitorTool);
  pi.registerTool(workspaceWindowTool);
  pi.registerTool(remoteWorkerTool);
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
          const commandInput = decodeKittyPrintable(data) ?? data;
          if (matchesKey(data, Key.enter)) {
            done(matches[cursor]?.correlationId ?? null);
          } else if (matchesKey(data, Key.escape)) {
            done(null);
          } else if (matchesKey(data, Key.up) || (commandInput === "k" && !query)) {
            cursor = Math.max(0, cursor - 1);
            requestRender();
          } else if (matchesKey(data, Key.down) || (commandInput === "j" && !query)) {
            cursor = Math.min(Math.max(0, matches.length - 1), cursor + 1);
            requestRender();
          } else if (matchesKey(data, Key.pageUp)) {
            cursor = Math.max(0, cursor - 8);
            requestRender();
          } else if (matchesKey(data, Key.pageDown)) {
            cursor = Math.min(Math.max(0, matches.length - 1), cursor + 8);
            requestRender();
          } else if (matchesKey(data, Key.home)) {
            cursor = 0;
            requestRender();
          } else if (matchesKey(data, Key.end)) {
            cursor = Math.max(0, matches.length - 1);
            requestRender();
          } else if (matchesKey(data, Key.backspace)) {
            if (query.length > 0) { query = removeLastGrapheme(query); cursor = 0; requestRender(); }
          } else {
            const input = decodeKittyPrintable(data)
              ?? (!data.startsWith("\x1b") ? sanitizeSingleLineInput(data) : "");
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
              if (matchesKey(data, Key.escape)) done(null);
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
    // The shutdown hook has already fenced the outgoing generation. This phase
    // reclaims its requests, processes, and UI state without advancing it twice.
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
    state.currentWorkspaceId = undefined;
    state.currentSourceId = undefined;
    state.settlementOwner = undefined;
    widgetCtx?.ui.setWidget("teammate-agents", undefined);
    agentWidgetInstalled = false;
    widgetCtx = null;
    setPersistentUi(undefined);
  }


  const testRemoteTarget = async (targetId: string, signal: AbortSignal): Promise<string> => {
    let manager: RemoteWorkerManager | undefined;
    try {
      const config = loadRemoteConfig(state.baseCwd || process.cwd());
      manager = new RemoteWorkerManager({ config, connectionFactory: new SshRemoteConnectionFactory() });
      const view = await manager.connect(targetId, signal);
      return `hello ${view.workerId} (${view.status}, ${view.activeRuns}/${view.concurrency} runs)`;
    } catch (error) {
      if (signal.aborted) return "timed out after the configured probe window";
      return sanitizeRemoteMonitorError(error, "connection test");
    } finally {
      if (manager) await manager.close().catch(() => {});
    }
  };

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
        cwd: agent.cwd,
      }));
    await showModelMappingOverlay(ctx, refreshModelCatalog(ctx).models, {
      agents: discoverAgents(ctx.cwd),
      activeAgents,
      modelHealth: sharedModelCircuitBreaker.snapshot(),
      onOpenAgent: async (correlationId) => showAttachOverlay(correlationId, ctx),
      remoteState: (() => {
        try {
          return loadRemoteConfigState(ctx.cwd);
        } catch {
          return undefined;
        }
      })(),
      refreshModelCatalog: () => refreshModelCatalog(ctx).models,
      onTestRemote: testRemoteTarget,
      remoteTestTimeoutMs: 10_000,
    });
  }

  let widgetCtx: ExtensionContext | null = null;
  let agentWidgetInstalled = false;
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

  function sessionSelectionRows(): SessionSelectionRow[] {
    const localAgents: SessionSelectionRow[] = [...state.activeRuns.values()].map((agent) => ({
      correlationId: agent.correlationId,
      displayName: agent.name ?? agent.correlationId.slice(0, 8),
      agentRole: agent.agent,
      status: agent.status,
      idleSeconds: Math.round((Date.now() - agent.lastActivityAt) / 1000),
      source: "local",
      kind: "agent",
      ownerId: "local",
      bindable: false,
      depth: agent.depth,
      ...(agent.spawnedBy ? { parentCorrelationId: agent.spawnedBy } : {}),
    }));
    const remoteRows = workspacePeerOwners.flatMap((owner): SessionSelectionRow[] => {
      const windowRow: SessionSelectionRow = {
        correlationId: `owner:${owner.ownerId}`,
        displayName: owner.sessionName ?? `window:${owner.ownerId.slice(0, 6)}`,
        agentRole: tuiT("extension.windowSummaryJobs", {
          agents: owner.agents.length,
          jobs: owner.backgroundJobs?.length ?? 0,
        }),
        status: workspaceWindowLifecycle(owner).busy ? "running" : "sleeping",
        idleSeconds: 0,
          source: owner.sessionName ?? `remote:${owner.ownerId.slice(0, 6)}`,
        kind: "window",
        ownerId: owner.ownerId,
        bindable: true,
      };
      const agentRows: SessionSelectionRow[] = owner.agents.map((agent) => ({
        correlationId: `owner:${owner.ownerId}:${agent.correlationId}`,
        displayName: agent.name ?? agent.correlationId.slice(0, 8),
        agentRole: agent.agent,
        status: agent.status,
        idleSeconds: Math.round((Date.now() - agent.lastActivityAt) / 1000),
        source: owner.sessionName ?? `remote:${owner.ownerId.slice(0, 6)}`,
        kind: "agent",
        ownerId: owner.ownerId,
        bindable: true,
        ...(agent.depth === undefined ? {} : { depth: agent.depth }),
        ...(agent.parentCorrelationId ? { parentCorrelationId: agent.parentCorrelationId } : {}),
      }));
      return [windowRow, ...agentRows];
    });
    const remoteWorkerRows: SessionSelectionRow[] = currentRemoteMonitorRuns().map((run) => ({
      correlationId: run.target,
      displayName: run.name ?? run.target,
      agentRole: `remote worker · ${run.targetId}`,
      status: run.status,
      idleSeconds: Math.max(0, Math.round((Date.now() - run.updatedAt) / 1000)),
      source: run.target,
      kind: "remote",
      ownerId: run.target,
      bindable: false,
    }));
    const localWindowRow: SessionSelectionRow = {
      correlationId: "local",
      displayName: workspacePeerSessionName ?? tuiT("extension.currentWindow"),
      agentRole: tuiT("extension.windowSummary", { agents: localAgents.length }),
      status: windowRowStatus(localAgents.map((agent) => agent.status)),
      idleSeconds: 0,
      source: "local",
      kind: "window",
      ownerId: "local",
      bindable: false,
    };
    return [localWindowRow, ...localAgents, ...remoteRows, ...remoteWorkerRows];
  }

  // ---------------------------------------------------------------------------
  // /teammate-send — send a prompt to another live Pi session
  // ---------------------------------------------------------------------------

  pi.registerCommand("teammate-send", {
    description: "Send a message to another Pi window or one of its active agents; without arguments, preview and choose a target.",
    async getArgumentCompletions(prefix: string) {
      try {
        await workspacePeerLifecycle;
        await refreshWorkspacePeerOwners();
      } catch {
        return null;
      }
      const matches = sessionSelectionRows()
        .filter((row) => row.bindable === true)
        .map((row) => ({
          value: row.correlationId,
          label: row.displayName,
          description: `${row.agentRole} · ${row.source ?? "workspace peer"} · target=${row.correlationId}`,
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
          ctx.ui.notify("Usage: /teammate-send <target> <message>", "warning");
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
          getSessions: () => sessionSelectionRows().filter((row) => row.bindable === true),
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
          const choice = command.workerContext
            ? { context: command.workerContext, direct: false }
            : await selectDelegationWorkerContext(ctx);
          if (!choice) {
            ctx.ui.notify("Delegation cancelled before drafting.", "info");
            return;
          }
          if (choice.direct) {
            // Direct mode: skip planner, persist a minimal record (no task.md),
            // then dispatch the instruction itself as the worker task.
            record = await createDirectDelegationDraft(command.request, choice.context, ctx);
            const dispatched = await dispatchDelegation(record, command.request, ctx);
            ctx.ui.notify(
              `Delegation ${record.id} (direct) sent to owner:${dispatched.owner.ownerId}${dispatched.deliveryStage ? ` (${dispatched.deliveryStage})` : ""}. Manage it with /delegate list or /delegate stop ${record.id}.`,
              "info",
            );
            return;
          }
          record = await draftDelegation(command.request, choice.context, ctx);
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
    description: "Monitor: /monitor | /monitor status | /monitor doctor | /monitor exit | /monitor spawn ...",
    getArgumentCompletions(prefix: string) {
      const commands = [
        { value: "exit", label: "exit", description: "Exit Monitor mode" },
        { value: "status", label: "status", description: "Show root Monitor state" },
        { value: "doctor", label: "doctor", description: "Show root Monitor health" },
        { value: "spawn", label: "spawn", description: "Manage local worker windows" },
      ];
      const matches = commands.filter((command) => command.value.startsWith(prefix.trimStart()));
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

      // /monitor exit — leave the root Monitor control mode.
      if (trimmed === "exit" || trimmed === "stop") {
        if (!monitorInteractionModeActive) {
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
          const closed = name
            ? await monitorWindowLifecycle.close(name)
            : { ok: false as const, error: "window name is required" };
          if (!closed.ok) {
            ctx.ui.notify(`${closed.error ?? `No managed window "${name}".`} Use /monitor spawn status to list.`, "warning");
            return;
          }
          ctx.ui.notify(`Stopped managed window ${name} (${closed.status ?? "stopped"}).`, "info");
          return;
        }
        const space = rest.indexOf(" ");
        const name = space < 0 ? rest : rest.slice(0, space);
        const objective = space < 0 ? "" : rest.slice(space + 1).trim();
        if (!name || !objective) {
          ctx.ui.notify("Usage: /monitor spawn <name> <objective> | /monitor spawn status | /monitor spawn stop <name>", "warning");
          return;
        }
        const created = await monitorWindowLifecycle.create({
          name,
          objective,
          cwd: state.baseCwd || ctx.cwd,
          presentation: "headless",
        }, new AbortController().signal);
        if (!created.ok || !created.owner) {
          ctx.ui.notify(`Spawn failed: ${created.error ?? `Failed to create ${name}.`}`, "warning");
          return;
        }
        ctx.ui.notify(
          `Spawned managed window ${name} as owner:${created.owner.ownerId}. Observe or message it with owner:${created.owner.ownerId}.${created.handle ? ` Result: ${created.handle.resource}` : ""}`,
          "info",
        );
        return;
      }

      // /monitor doctor — read-only root-mode health check.
      if (trimmed === "doctor") {
        const exposureActive = monitorToolExposure?.active === true;
        const lines = [
          `MONITOR doctor · mode ${monitorInteractionModeActive ? "active" : "inactive"}`,
          `  exposure: ${exposureActive ? "active" : "inactive"}`,
          `  workspace: ${workspacePeerOwners.length} peer window${workspacePeerOwners.length === 1 ? "" : "s"}`,
          `  managed: ${managedWindows.size} window${managedWindows.size === 1 ? "" : "s"}`,
          `  remote: ${currentRemoteMonitorRuns().length} run${currentRemoteMonitorRuns().length === 1 ? "" : "s"}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // /monitor status — render the same normalized projector as monitor list.
      if (trimmed === "status") {
        if (!monitorInteractionModeActive) {
          ctx.ui.notify("Monitor mode is not active. Use /monitor to enter.", "warning");
          return;
        }
        const query = await executeMonitorQuery({ action: "list" }, new AbortController().signal);
        ctx.ui.notify(formatMonitorQueryResult(query).join("\n"), query.status === "ok" ? "info" : "warning");
        return;
      }

      ctx.ui.notify("Usage: /monitor | /monitor status | /monitor doctor | /monitor exit | /monitor spawn ...", "warning");
    },
  });

  pi.registerCommand("advisor", {
    description: "Turn-level advisor: /advisor on|off|status",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const trimmed = args.trim().toLowerCase();
      advisorConfig = loadAdvisorConfigForRoot(state.baseCwd ?? ctx.cwd);
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

  function clearAgentWidget(): void {
    if (!agentWidgetInstalled) return;
    widgetCtx?.ui.setWidget("teammate-agents", undefined);
    agentWidgetInstalled = false;
  }

  function updateAgentWidget(): void {
    if (!widgetCtx) {
      agentWidgetInstalled = false;
      return;
    }
    if (cockpitOwnsAgents || interactivePanelActive || foregroundToolRuns.size > 0) {
      clearAgentWidget();
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
      clearAgentWidget();
      return;
    }

    const agents = visible.map(([, agent]) => agent);

    widgetCtx.ui.setWidget("teammate-agents", (_tui, theme) => ({
      render(width: number): string[] {
        return renderAgentStatusWidget(agents, width, theme);
      },
      invalidate() {},
    }), { placement: "belowEditor" });
    agentWidgetInstalled = true;
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
    const fence = captureRootSessionFence();
    const projection = projectionForRootFence(fence);
    if (!projection || !ownsRootSessionFence(fence)) return;
    refreshAgentRuntimeProjection(agent);
    const diagnosis = diagnoseAgentRuntime({
      status: agent.status,
      phase: agent.phase,
      resultReadyAt: agent.resultReadyAt,
      lastActivityAt: agent.lastActivityAt,
      pendingInteractions: agent.pendingInteractions?.size,
      turn: agent.turn,
      previousOutcome: agent.lastOutcome,
    });
    const stallStatus = agent.status === "sleeping" ? "completed" : agent.status;
    const stallProgress: AgentProgressSnapshot = {
      agent: agent.agent,
      ...(agent.name ? { name: agent.name } : {}),
      correlationId: agent.correlationId,
      taskIndex: 0,
      dependencies: [],
      status: stallStatus,
      phase: agent.phase,
      runtime: diagnosis,
      turn: agent.turn,
      startedAt: new Date(agent.startedAt).toISOString(),
      lastActivityAt: agent.lastActivityAt,
      resultReadyAt: agent.resultReadyAt,
    };
    const stallEvent = {
      ...stallProgress,
      projection,
      correlationId: agent.correlationId,
      taskCorrelationId: agent.correlationId,
      progress: [stallProgress],
    } satisfies TeammateProgressMessageEvent;
    pi.events.emit(TEAMMATE_MESSAGE_EVENT, stallEvent);
    safeSendMessage(pi, {
      customType: "teammate-stalled",
      content: message,
      display: true,
      details: {
        mode: agent.spawnedBy ? "nested" : "single",
        correlationId: agent.correlationId,
        name: agent.name,
        agent: agent.agent,
        diagnosis,
      },
    }, { triggerTurn: true });
  };

  function startWidgetTimer(): void {
    if (widgetTimer) return;
    stopWakeableEvictionTimer();
    widgetTimer = setInterval(() => {
      // A result-ready zombie keeps hasTeammateWidgetWork true, so this tick is
      // exactly where it stays reachable until reclaimed. Publishing the
      // retirement keeps delta-only consumers (cockpit roster) in sync. Capture
      // the projection once so every completion in this sweep carries the exact
      // session/source/generation owned by the tick that admitted reclamation.
      const reclaimFence = captureRootSessionFence();
      const reclaimProjection = projectionForRootFence(reclaimFence);
      const resultReadyRetired = reclaimProjection && ownsRootSessionFence(reclaimFence)
        ? reclaimResultReadyAgents(state, pi, Date.now(), reclaimProjection)
        : [];
      const retired = [
        ...resultReadyRetired,
        ...sweepFailedAgents(state),
      ];
      // Before the wakeable budget can retire a silent agent, surface the stall
      // to the caller that is waiting on a notification that will never fire.
      sweepStalledAgents(state, notifyStalled);
      retired.push(...enforceWakeableAgentBudget(state));
      if (retired.length > 0) publishRuntimeReadDelta();
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
      const retired = [
        ...sweepFailedAgents(state),
        ...enforceWakeableAgentBudget(state),
      ];
      if (retired.length > 0) publishRuntimeReadDelta();
      updateAgentWidget();
      scheduleWakeableEvictionTimer();
    }, delay);
    wakeableEvictionTimer.unref?.();
  }

  if (!isChild) {
  // Dispose EventBus subscriptions on shutdown (defensive; framework may auto-dispose).
  const disposers: Array<() => void> = [];
  disposers.push(registerWorkspaceProjectionDirtyListener(markWorkspacePeerDirty));
  const disposeTuiLocaleEvents = pi.events.on(SETTINGS_LOCALE_EVENT, (payload) => {
    if (!applySettingsLocaleEvent(payload)) return;
    updateAgentWidget();
    syncMonitorInteractionStatus();
  });

  disposers.push(pi.events.on("bash-bg:update", applyBashBgSnapshot));
  disposers.push(pi.events.on("loop:update", applyLoopSnapshot));

  disposers.push(pi.events.on(COCKPIT_UI_OWNERSHIP_EVENT, (payload) => {
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
  }));

  // Cockpit agent list commands: interrupt (打断) aborts the current turn with
  // a canned continue notice; steer (引导) interrupts and injects the user's
  // message. Both reuse the steer RPC (Pi abort → prompt), so a stalled agent
  // stuck in a tool is woken instead of left showing a hung tool forever.
  disposers.push(pi.events.on(TEAMMATE_AGENT_COMMAND_EVENT, (payload) => {
    void applyTeammateAgentCommand(
      state,
      pi,
      (correlationId, label, message) =>
        deliverLocalAgentMessage(correlationId, label, message, "steer"),
      payload,
    );
  }));
  disposers.push(pi.events.on(RUNTIME_READ_MODEL_QUERY_EVENT, publishRuntimeReadSnapshot));
  disposers.push(pi.events.on(TEAMMATE_STARTED_EVENT, () => {
    markWorkspacePeerDirty();
    publishRuntimeReadDelta();
    updateAgentWidget();
    startWidgetTimer();
  }));
  disposers.push(pi.events.on(TEAMMATE_COMPLETE_EVENT, () => {
    const fence = captureRootSessionFence();
    markWorkspacePeerDirty();
    publishRuntimeReadDelta();
    setTimeout(() => {
      if (!ownsRootSessionFence(fence)) return;
      const retired = enforceWakeableAgentBudget(state);
      if (retired.length > 0) publishRuntimeReadDelta();
      updateAgentWidget();
      if (!hasTeammateWidgetWork(state)) {
        stopWidgetTimer();
        scheduleWakeableEvictionTimer();
      }
    }, 100);
  }));
  disposers.push(pi.events.on(TEAMMATE_MESSAGE_EVENT, () => {
    markWorkspacePeerDirty();
    publishRuntimeReadDelta();
  }));

  // =========================================================================
  // Session lifecycle — agents live until session ends
  // =========================================================================

  pi.on("session_start", (event, ctx) => {
    registerTeammateSettings();
    state.settlementOwner = undefined;
    state.sessionGeneration = (state.sessionGeneration ?? 0) + 1;
    state.currentSessionId = ctx.sessionManager?.getSessionId() ?? null;
    state.baseCwd = ctx.cwd;
    state.currentWorkspaceId = completionWorkspaceId(ctx.cwd);
    state.currentSourceId = state.currentSessionId ?? undefined;
    reconcileSettledAgentsForSession(state, {
      preserveExact: event?.reason === "resume" || event?.reason === "reload",
    });
    bindStateTurnRecorder();
    rebuildTurnLedger(ctx.sessionManager?.getEntries?.() ?? []);
    if (state.currentSourceId) void initializeRuntimeReadModel(ctx.cwd, state.currentSourceId);
    const completionSessionId = state.currentSessionId;
    const boundCompletionWorkspace = completionWorkspaceIdentity(ctx.cwd);
    const boundCompletionWorkspaceId = boundCompletionWorkspace.workspaceId;
    const completionGeneration = state.sessionGeneration;
    if (completionSessionId) {
      void completionCoordinator.bindSession({
        target: {
          workspaceId: boundCompletionWorkspaceId,
          sessionId: completionSessionId,
        },
        legacyWorkspaceIds: boundCompletionWorkspace.legacyWorkspaceIds,
        entries: ctx.sessionManager?.getEntries?.() ?? [],
        send(envelope: CompletionDeliveryEnvelope) {
          return state.currentSessionId === completionSessionId
            && state.sessionGeneration === completionGeneration
            && workspaceIdForCwd(state.baseCwd) === boundCompletionWorkspaceId
            // deliverAs: "steer" (not "followUp") so a replayed teammate-complete
            // is drained at the next turn boundary (right after the current tool
            // call finishes) instead of waiting for the agent to fully stop.
            // pi-core drains the steer queue every turn_end (agent-loop.js),
            // whereas followUp only drains when the agent would otherwise stop.
            && safeSendMessage(pi, envelope, { triggerTurn: true, deliverAs: "steer" });
        },
      }).catch((error) => {
        logDiagnosticWarn("[pi-maestro-teammate] completion replay bind failed:", error);
      });
    }
    widgetCtx = ctx;
    exitMonitorInteractionMode();
    installMonitorEscapeTap(ctx.ui);
    setPersistentUi(ctx.ui, true);
    // Mailbox is bound to the real session cwd (workspace isolation).
    rebindMailboxHostForSession();
    void refreshModelCatalogSources(ctx);
    tool.description = buildTeammateToolDescription(ctx.cwd);
    pi.registerTool(tool);
    sessionHostRegistry?.thread.rebuild(ctx.sessionManager?.getEntries?.() ?? []);
    replayQueuedIncomingRootMessages(ctx, event.reason);
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    const isAgentSession = Array.from(state.activeRuns.values()).some((agent) => agent.sessionFile === sessionFile);
    if (sessionFile && !isAgentSession) state.mainSessionFile = sessionFile;
    workspaceMainSessionActivityAt = undefined;
    workspaceMainSessionProgress = undefined;
    workspaceMainAssistantText = "";
    workspaceMainAssistantEventOpen = false;
    // Same reason the progress projection is cleared: a settle belongs to the
    // session that produced it, and carrying one across a switch would report
    // the previous session's result as this one's.
    workspaceMainSettledResult = undefined;
    workspaceMainLastSettle = undefined;
    workspaceCurrentTurnAssistantMessage = undefined;
    workspaceTerminalResultDraft = undefined;
    workspaceTerminalResultState = { settled: false, terminalPublished: false };
    workspaceTerminalResultPublications.clear();
    workspaceTerminalCompletionPublications.clear();
    startWorkspacePeers(ctx);
    if (workspaceReceiptReconcileTimer) clearInterval(workspaceReceiptReconcileTimer);
    workspaceReceiptReconcileTimer = setInterval(() => {
      void reconcileWorkspacePeerReceipts();
      if (workspaceTerminalResultState.settled && !workspaceTerminalResultState.terminalPublished) {
        void publishWorkspaceWindowTerminalResults(
          workspaceTerminalResultDraft ?? { outcome: "no-result" },
        ).then((published) => {
          workspaceTerminalResultState.terminalPublished = published;
        });
      }
      void reconcileWorkspaceWindowTerminalRequests().catch((error) => {
        logDiagnosticWarn("[pi-maestro-teammate] workspace terminal request reconciliation failed:", error);
      });
      if (!periodicCompletionReconcile) {
        const reconcile = completionCoordinator.reconcile().catch((error) => {
          logDiagnosticWarn("[pi-maestro-teammate] periodic completion reconciliation failed:", error);
        }).finally(() => {
          if (periodicCompletionReconcile === reconcile) periodicCompletionReconcile = undefined;
        });
        periodicCompletionReconcile = reconcile;
      }
      try {
        redriveStaleIncomingRootMessages();
      } catch (error) {
        // A sweep failure must not crash the window via uncaughtException.
        logDiagnosticError("[pi-maestro-teammate] workspace message re-drive failed:", error);
      }
    }, RECONCILE_RECEIPT_INTERVAL_MS);
    workspaceReceiptReconcileTimer.unref?.();
    // Query after all extensions have registered their event listeners. The
    // update is cached even if the async workspace publisher is still starting.
    pi.events.emit("bash-bg:query", undefined);
    pi.events.emit("loop:query", undefined);
    rebuildHistory(ctx);
  });

  pi.on("message_end", (event) => {
    workspaceMainSessionActivityAt = Date.now();
    if (state.currentSessionId) {
      void completionCoordinator.receiveMessageEnd(event.message, {
        workspaceId: workspaceIdForCwd(state.baseCwd),
        sessionId: state.currentSessionId,
      }).catch((error) => {
        logDiagnosticWarn("[pi-maestro-teammate] completion message_end reconciliation failed:", error);
      });
    }
    const assistantText = workspaceAssistantMessageText(event.message);
    if (assistantText !== undefined) {
      workspaceMainAssistantText = truncateUtf8Tail(assistantText, MAIN_SESSION_PROGRESS_TEXT_BYTES);
      updateWorkspaceMainAssistantText(workspaceMainAssistantText);
      workspaceMainAssistantEventOpen = false;
    }
    if (event.message.role === "assistant") workspaceCurrentTurnAssistantMessage = event.message;
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
    // Finalize the claim-time receipt so the sender's ledger can reach
    // outgoing/injected instead of staying queued forever.
    if (typeof details.fromOwnerId === "string") {
      const publisher = workspacePeerPublisher;
      if (publisher) {
        void finalizeWorkspacePeerResponse(
          publisher.identity,
          details.fromOwnerId,
          entry.messageId,
          "injected",
        ).catch(() => undefined);
      }
    }
  });

  pi.on("input", async (event) => {
    if (event.source !== "interactive" || (event.images?.length ?? 0) > 0 || event.text.trim() !== "monitor") return;
    await monitorRegistry.requestWindowMode("enter");
    return { action: "handled" as const };
  });

  pi.on("before_agent_start", injectTeammateContext);

  pi.on("agent_start", () => {
    if (!workspaceTerminalResultState.settled || workspaceTerminalResultState.terminalPublished) {
      workspaceTerminalResultDraft = undefined;
      workspaceTerminalResultState = { settled: false, terminalPublished: false };
    }
    appendWorkspaceMainProgressEvent({ kind: "lifecycle", at: Date.now(), phase: "agent_start" });
  });

  pi.on("turn_start", () => {
    workspaceMainAssistantText = "";
    workspaceCurrentTurnAssistantMessage = undefined;
    appendWorkspaceMainProgressEvent({ kind: "lifecycle", at: Date.now(), phase: "turn_start" });
  });

  pi.on("message_update", (event) => {
    if (event.assistantMessageEvent.type === "text_start") {
      workspaceMainAssistantText = "";
      workspaceMainAssistantEventOpen = false;
      return;
    }
    if (event.assistantMessageEvent.type !== "text_delta") return;
    workspaceMainAssistantText = truncateUtf8Tail(
      workspaceMainAssistantText + event.assistantMessageEvent.delta,
      MAIN_SESSION_PROGRESS_TEXT_BYTES,
    );
    updateWorkspaceMainAssistantText(workspaceMainAssistantText);
  });

  pi.on("tool_execution_start", (event) => {
    appendWorkspaceMainProgressEvent({
      kind: "tool",
      at: Date.now(),
      toolCallId: truncateUtf8Tail(event.toolCallId, 256),
      toolName: truncateUtf8Tail(event.toolName, 256),
      status: "running",
    });
  });

  pi.on("tool_execution_end", (event) => {
    appendWorkspaceMainProgressEvent({
      kind: "tool",
      at: Date.now(),
      toolCallId: truncateUtf8Tail(event.toolCallId, 256),
      toolName: truncateUtf8Tail(event.toolName, 256),
      status: event.isError ? "failed" : "completed",
    });
  });

  pi.on("turn_end", () => {
    appendWorkspaceMainProgressEvent({ kind: "lifecycle", at: Date.now(), phase: "turn_end" });
  });

  // Turn-level advisor: low-frequency quality review of this session's turns.
  pi.on("agent_end", (event, ctx) => {
    workspaceTerminalResultDraft = deriveWorkspaceWindowTerminalResult(
      workspaceCurrentTurnAssistantMessage === undefined ? [] : [workspaceCurrentTurnAssistantMessage],
    );
    appendWorkspaceMainProgressEvent({ kind: "lifecycle", at: Date.now(), phase: "agent_end" });
    void runAdvisorReview(event, ctx);
  });

  pi.on("agent_settled", async () => {
    const at = Date.now();
    recordWorkspaceMainSettle(at);
    appendWorkspaceMainProgressEvent({ kind: "lifecycle", at, phase: "agent_settled" });
    workspaceTerminalResultState.settled = true;
    const terminalPublished = await publishWorkspaceWindowTerminalResults(
      workspaceTerminalResultDraft ?? { outcome: "no-result" },
    );
    workspaceTerminalResultState.terminalPublished = terminalPublished;
    if (!terminalPublished) {
      logDiagnosticError("[pi-maestro-teammate] settled workspace terminal result was not published; keeping the resident worker available for reconciliation.");
    }
  });

  pi.on("session_compact", (_event, ctx) => {
    widgetCtx = ctx;
    installMonitorEscapeTap(ctx.ui);
    setPersistentUi(ctx.ui);
    const previousFence = captureRootSessionFence();
    state.baseCwd = ctx.cwd;
    state.currentSessionId = ctx.sessionManager?.getSessionId() ?? null;
    state.currentWorkspaceId = completionWorkspaceId(ctx.cwd);
    state.currentSourceId = state.currentSessionId ?? undefined;
    const projectionChanged = !ownsRootSessionFence(previousFence);
    if (projectionChanged) {
      reconcileSettledAgentsForSession(state, { preserveExact: true });
      bindStateTurnRecorder();
      void initializeRuntimeReadModel(ctx.cwd, state.currentSourceId ?? "");
    }
    // Rebind if compaction moved to a different workspace.
    rebindMailboxHostForSession();
    void refreshModelCatalogSources(ctx);
    workspacePeerSessionName = ctx.sessionManager?.getSessionName?.() ?? undefined;
    // Compaction/rebind rotates ownerNonce and the WindowSupervisor actor generation.
    startWorkspacePeers(ctx);
    syncMonitorInteractionStatus();
    updateAgentWidget();
  });

  pi.on("session_shutdown", async (event) => {
    const shutdownReason = event?.reason ?? "quit";
    const outgoingFence = captureRootSessionFence();
    state.settlementOwner = projectionForRootFence(outgoingFence);
    const closingRuntimeReadHandle = runtimeReadHandle;
    runtimeReadHandle = undefined;
    runtimeReadToken += 1;
    cancelRuntimeReadHandle(closingRuntimeReadHandle);
    state.sessionGeneration = (state.sessionGeneration ?? 0) + 1;
    state.currentSessionId = null;
    workspaceTerminalResultState.settled = true;
    const terminalPublished = await publishWorkspaceWindowTerminalResults(
      workspaceTerminalResultDraft ?? {
        outcome: "cancelled",
        error: `Worker session shut down before publishing a final response (${shutdownReason}).`,
      },
    );
    workspaceTerminalResultState.terminalPublished = terminalPublished;
    const terminalFlushed = await flushWorkspaceTerminalResultPublications();
    if (!terminalPublished || !terminalFlushed) {
      logDiagnosticError("[pi-maestro-teammate] workspace terminal publication did not flush before peer shutdown.");
    }
    completionCoordinator.unbindSession();
    if (shutdownReason === "quit" || shutdownReason === "reload") disposeTuiLocaleEvents();
    uninstallMonitorEscapeTap();
    disposeTeammateSettings();
    stopWidgetTimer();
    stopWakeableEvictionTimer();
    runtimeReadReady = false;
    const closingRuntimeReadBridge = closingRuntimeReadHandle?.bridge;
    if (closingRuntimeReadBridge) {
      await closingRuntimeReadBridge.publish([]).catch((error) => {
        logDiagnosticWarn("[pi-maestro-teammate] Runtime V2 terminal tombstone publish failed:", error);
      });
      await closingRuntimeReadBridge.close().catch((error) => {
        logDiagnosticWarn("[pi-maestro-teammate] Runtime V2 read bridge shutdown failed:", error);
      });
    }
    try {
      await shutdownRemoteMonitorBinding();
    } catch (error) {
      logDiagnosticError("[pi-maestro-teammate] remote Monitor shutdown failed:", sanitizeRemoteMonitorError(error, "shutdown"));
    }
    workspaceBackgroundJobs = [];
    activePromptLoopIds = [];
    workspacePeerLifecycle = workspacePeerLifecycle.then(async () => {
      await stopAllManagedWindows();
      await stopWorkspacePeers();
    });
    await workspacePeerLifecycle;
    if (workspaceReceiptReconcileTimer) {
      clearInterval(workspaceReceiptReconcileTimer);
      workspaceReceiptReconcileTimer = undefined;
    }
    redrivenIncoming.clear();
    replayedIncoming.clear();
    await completionCoordinator.drain();
    completionCoordinator.dispose();
    // Dispose EventBus subscriptions on shutdown (defensive; framework may auto-dispose).
    for (const d of disposers) {
      try { d(); } catch {}
    }
    // Stop the mailbox consumer BEFORE killing agents so no in-flight poll can
    // inject into a dying session (previously never stopped at all).
    const stoppedMailbox = mailboxHost;
    mailboxHost = undefined;
    mailboxWorkspaceId = undefined;
    rootGlobals[MAILBOX_REGISTRY_KEY] = undefined;
    monitorRegistry.replaceEndpoints([]);
    monitorRegistry.thread.rebuild([]);
    exitMonitorInteractionMode();
    if (shutdownReason === "quit" || shutdownReason === "reload") {
      if (getSessionHostRegistry(rootGlobals) === sessionHostRegistry) {
        publishSessionHostRegistry(undefined, rootGlobals);
        publishSessionHostDirectoryRefresh(undefined, rootGlobals);
      }
      sessionHostRegistry = undefined;
    }
    await stoppedMailbox?.stop().catch((error) => {
      logDiagnosticError(`[pi-maestro-teammate] mailbox host stop failed:`, error);
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
  deliverDurableFailureWithFallback,
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
  reconcileSettledAgentsForSession,
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

