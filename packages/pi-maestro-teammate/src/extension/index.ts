/**
 * Teammate Extension Entry Point
 *
 * Tools: teammate (dispatch), teammate-send (RPC message injection), teammate-list (status), observe
 * TUI: Alt+R composer panel, widget above editor, Alt+B foreground→background detach
 * Mode: RPC subprocess — stdin open for steer/follow_up/abort
 */

import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Check } from "typebox/value";
import { isGuiTeammateToolAllowed, registerGuiTool, unregisterGuiTool } from "../shared/gui-registry.ts";
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
  createProgressFlushGate,
  flushProgressBatch,
  runWithProgressFlushCleanup,
  summarizeGraphResults,
  aggregateGraphStructuredOutput,
  foregroundWaitWindowMs,
  createForegroundDeadline,
  backgroundWaitGuidance,
  buildAgentSelectorRows,
  renderAgentSelectorPanel,
  switchConversationSession,
  restoreMainOwnershipIfHandbackPending,
  AGENT_WIDGET_IDLE_HIDE_MS,
  renderAgentStatusWidget,
  COCKPIT_UI_OWNERSHIP_EVENT,
} from "./teammate-core.ts";
import type { TeammateRuntimeOptions, ProgressFlushGate, AgentWidgetTheme, AgentWidgetRow, AgentSelectorRow, PendingChildProxyRequest, ChildProxyPendingRequests, IpcSender } from "./teammate-core.ts";


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

  const refreshModelCatalog = (ctx: ExtensionContext): ModelCatalogSnapshot => {
    const next = createModelCatalogSnapshot(ctx.modelRegistry?.getAvailable?.() ?? []);
    if (next.signature !== modelCatalog.signature) modelCatalog = next;
    return modelCatalog;
  };

  const injectTeammateContext = (
    event: { systemPrompt: string },
    ctx: ExtensionContext,
  ): { systemPrompt: string } => {
    const withModels = appendModelCatalog(event.systemPrompt, refreshModelCatalog(ctx));
    const withAgents = appendAgentCatalog(withModels, ctx.cwd);
    return { systemPrompt: appendTeammateDepthContext(withAgents, currentDepth, currentMaxDispatchDepth) };
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
      proxyTeammateTool.description = buildTeammateToolDescription(ctx.cwd);
      if (canDispatchNestedTeammate) pi.registerTool(proxyTeammateTool);
    });
    pi.on("before_agent_start", injectTeammateContext);
    pi.on("session_compact", (_event, ctx) => publishSessionIdentity(ctx));
    pi.on("message_end", (_event, ctx) => publishSessionIdentity(ctx));
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
      options: { detail: "summary" | "tail" | "full"; lines: number; deadline?: number },
      signal?: AbortSignal,
    ): Promise<ObservationSnapshot> => {
      const response = await proxyCall<{ output: string[]; result: ObserveResult }>("observe", {
        action,
        targets: [{ kind: "teammate", id }],
        detail: options.detail,
        lines: options.lines,
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

    const proxyTeammateTool: ToolDefinition<typeof TeammateParams, Details> = {
      name: "teammate",
      label: "Teammate",
      renderShell: "self",
      description: buildTeammateToolDescription(process.cwd()),
      promptSnippet: TEAMMATE_PROMPT_SNIPPET,
      promptGuidelines: TEAMMATE_PROMPT_GUIDELINES,
      parameters: TeammateParams,
      async execute(_id: string, params: RunTeammateParams, signal: AbortSignal) {
        return proxyCall<Details>("teammate", params, signal);
      },
      renderCall(args, theme, context) {
        return renderTeammateCall(args, theme, context);
      },
      renderResult(result, options, theme) {
        return renderTeammateResult(result, options, theme);
      },
    };
    if (canDispatchNestedTeammate) pi.registerTool(proxyTeammateTool);

    pi.registerTool({
      name: "teammate-send",
      label: "Teammate Send",
      description: TEAMMATE_SEND_DESCRIPTION,
      promptSnippet: TEAMMATE_SEND_SNIPPET,
      promptGuidelines: TEAMMATE_SEND_GUIDELINES,
      parameters: TeammateSendParams,
      async execute(_id: string, params: { to: string; message?: string; mode?: RpcMessageMode }, signal: AbortSignal) {
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
      async execute(_id: string, params: { view?: TeammateListView }, signal: AbortSignal) {
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
      description: OBSERVE_DESCRIPTION,
      promptSnippet: OBSERVE_SNIPPET,
      promptGuidelines: OBSERVE_GUIDELINES,
      parameters: ObserveParams,
      async execute(_id: string, params: UnifiedObserveParams, signal: AbortSignal) {
        const result = await observeTargets(params, signal);
        const output = formatObserveResult(result, params.detail === "full");
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

  let workspacePeerPublisher: WorkspacePeerPublisher | undefined;
  let workspacePeerConsumer: WorkspacePeerCommandConsumer | undefined;
  let workspacePeerSessionName: string | undefined;
  let workspacePeerOwners: WorkspaceOwnerSnapshot[] = [];
  let workspacePeerRefresh: Promise<WorkspaceOwnerSnapshot[]> | undefined;
  let workspacePeerLifecycle = Promise.resolve();

  const markWorkspacePeerDirty = (): void => workspacePeerPublisher?.markDirty();

  const refreshWorkspacePeerOwners = async (): Promise<WorkspaceOwnerSnapshot[]> => {
    if (workspacePeerRefresh) return workspacePeerRefresh;
    const publisher = workspacePeerPublisher;
    if (!publisher) return [];
    workspacePeerRefresh = discoverWorkspacePeers(publisher.identity, { cleanupStale: true })
      .then((result) => {
        workspacePeerOwners = result.peers;
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

  const workspaceBindingKey = (target: WorkspaceResolvedTarget): string => target.scope === "local"
    ? target.agent.correlationId
    : `${target.ownerId}:${target.agent.correlationId}`;

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
    const localState = buildWorkspaceOwnerState(state, workspacePeerSessionName);
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

  const resolveWorkspaceMonitorTarget = (query: string): WorkspaceResolvedTarget | undefined => {
    const publisher = workspacePeerPublisher;
    if (!publisher) return undefined;
    try {
      return resolveWorkspaceTarget(
        query,
        publisher.identity,
        buildWorkspaceOwnerState(state, workspacePeerSessionName),
        workspacePeerOwners,
      );
    } catch {
      return undefined;
    }
  };

  const deliverLocalAgentMessage = (
    correlationId: string,
    targetLabel: string,
    message: string,
    requestedMode: "steer" | "follow_up",
  ): { delivered: boolean; error?: string; mode?: RpcMessageMode; wasSleeping?: boolean } => {
    const agent = state.activeRuns.get(correlationId);
    if (!agent?.stdin?.writable) return { delivered: false, error: `Agent "${targetLabel}" is no longer running.` };
    if (!agent.lease || !canChildWrite(agent.lease)) {
      const ownership = agent.lease ? `${agent.lease.owner} (${agent.lease.state})` : "an unavailable lease";
      return { delivered: false, error: `Agent "${targetLabel}" is currently owned by ${ownership}.` };
    }
    const mode: RpcMessageMode = agent.status === "sleeping" ? "prompt" : requestedMode;
    const sent = sendRpcMessage(agent.stdin, message, mode, leaseToken(agent.lease));
    if (!sent) return { delivered: false, error: `Failed to send message to "${targetLabel}".` };

    const now = Date.now();
    if (mode === "prompt") agent.promptSeq = (agent.promptSeq ?? 0) + 1;
    const wasSleeping = wakeSleepingAgent(pi, agent, now);
    agent.inbox.push({
      id: randomUUID(),
      from: "caller",
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
      from: "caller",
      to: targetLabel,
      mode,
      message,
      lastActivityAt: now,
      isSend: true,
    });
    markWorkspacePeerDirty();
    return { delivered: true, mode, wasSleeping };
  };

  const stopWorkspacePeers = async (): Promise<void> => {
    const consumer = workspacePeerConsumer;
    const publisher = workspacePeerPublisher;
    workspacePeerConsumer = undefined;
    workspacePeerPublisher = undefined;
    workspacePeerOwners = [];
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
          getState: () => buildWorkspaceOwnerState(state, workspacePeerSessionName),
        });
        await publisher.start();
        workspacePeerPublisher = publisher;
        const consumer = createWorkspacePeerCommandConsumer(publisher.identity, (command) => {
          const target = state.activeRuns.get(command.targetCorrelationId);
          if (!target) return { status: "rejected" as const, message: "target agent is not owned by this session" };
          const delivered = deliverLocalAgentMessage(
            command.targetCorrelationId,
            target.name ?? command.targetCorrelationId.slice(0, 8),
            command.message,
            command.action,
          );
          return delivered.delivered
            ? { status: "accepted" as const, message: delivered.mode ?? command.action }
            : { status: "rejected" as const, message: delivered.error ?? "message was not delivered" };
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
      params = applyModelRouting(
        params,
        baseCwd,
        refreshModelCatalog(ctx).modelIds,
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
      const childMaxDispatchDepth = rootChildMaxDispatchDepth(params.maxNestingDepth);
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
        replyTo: params.reply_to,
        // Root-tool dispatches start the tree.
        depth: 0,
        maxDispatchDepth: childMaxDispatchDepth,
        status: "running",
        sleepMs: 0,
        lease: createChildLease(),
        promptSeq: 1,
        expectsStructuredOutput: isMultiTask
          ? params.outputSchema !== undefined
          : singleTask.outputSchema !== undefined,
        ...(isMultiTask ? { progress: progressSnapshot() } : {}),
      };
      state.activeRuns.set(correlationId, activeAgent);

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
            depth: activeAgent.depth,
            maxDispatchDepth: childMaxDispatchDepth,
            status: "pending",
            sleepMs: 0,
            lease: createChildLease(),
            promptSeq: 1,
            expectsStructuredOutput: (task.outputSchema ?? params.outputSchema) !== undefined,
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

      emitTeammateStarted(pi, activeAgent, { id });

      let dispatchLifecyclePending = false;
      let singlePublishedResult: SingleResult | undefined;
      let singleTerminalResult: SingleResult | undefined;
      let singleTerminalStatus: AgentTerminalStatus | undefined;
      let singleCompletionNotificationRequested = false;
      let singleCompletionDelivered = false;
      const deliverSingleCompletion = (): void => {
        if (!ownsDispatchGeneration()) {
          singleCompletionDelivered = true;
          return;
        }
        if (singleCompletionDelivered || !singlePublishedResult || !singleTerminalResult) return;
        singleCompletionDelivered = true;
        emitComplete(
          pi,
          id,
          agentLabel,
          correlationId,
          singleTerminalResult.exitCode,
          singleTerminalResult.durationMs,
          singleTerminalResult.wakeable,
          singleTerminalStatus === "terminated",
        );
        if (singleCompletionNotificationRequested) {
          const lastMessage = displayMessageForResult(singleTerminalResult);
          const delivered = safeSendMessage(
            pi,
            {
              customType: "teammate-complete",
              content: lastMessage,
              display: true,
              details: {
                mode: "single",
                results: [singleTerminalResult],
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
          ...(isMultiTask ? { taskSignals: taskAbortControllers.map((controller) => controller.signal) } : {}),
          parentSessionFile,
          initialLeaseToken: (childId: string) => {
          const target = state.activeRuns.get(childId) ?? activeAgent;
          return target.lease ? leaseToken(target.lease) : undefined;
          },
          onChildSpawned: (
            stdin: import("node:stream").Writable,
            sendControl: (message: Record<string, unknown>) => boolean,
            sessionDir?: string,
            childId?: string,
          ) => {
          const target = childId ? state.activeRuns.get(childId) ?? activeAgent : activeAgent;
          target.stdin = stdin;
          target.sendControl = sendControl;
          target.sessionDir = sessionDir;
          target.status = "running";
          target.retry = undefined;
          target.resultReadyAt = undefined;
          if (target.lease) sendControl({ type: "teammate_lease_update", token: leaseToken(target.lease) });
          },
          onChildEvent: (event: Record<string, unknown>) => handleChildLifecycleEvent(state, event),
          onRetry: (retry) => applyAgentRetryState(state, retry),
          onReclamationOutcome: (childId, outcome) => {
            recordChildReclamationOutcome(state, childId, outcome);
          },
          onTurnComplete: (result: SingleResult, terminalStatus?: AgentTerminalStatus) => {
            const canonicalStatus = terminalStatusForResult(result, terminalStatus);
            result.terminalStatus = canonicalStatus;
            const target = state.activeRuns.get(result.correlationId) ?? activeAgent;
            target.resolvedModel = target.resolvedModel ?? result.model;
            if (result.attemptedModels) target.attemptedModels = [...result.attemptedModels];
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
            if (isMultiTask) {
              graphTerminalIds.add(result.correlationId);
              graphTerminalStatuses.set(result.correlationId, canonicalStatus);
              deliverGraphCompletion();
            } else if (!singleTerminalResult) {
              singleTerminalResult = result;
              singleTerminalStatus = canonicalStatus;
              deliverSingleCompletion();
            }
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
            } else {
              clearAgentResultReadyState(state, entry.correlationId);
            }
            const childAgent = state.activeRuns.get(entry.correlationId);
            if (childAgent) {
              childAgent.requestedModel = entry.requestedModel ?? childAgent.requestedModel;
              childAgent.resolvedModel = entry.resolvedModel ?? childAgent.resolvedModel;
              childAgent.attemptedModels = entry.attemptedModels ?? childAgent.attemptedModels;
            }
            if (childAgent && childAgent !== activeAgent) {
              childAgent.lastActivityAt = Date.now();
              childAgent.status = entry.status === "completed" ? "sleeping" : entry.status;
              if (entry.status === "running") childAgent.retry = undefined;
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
            pendingByTask.set(data.taskIndex ?? 0, data);
            latestPendingProgress = data;
            flushGate.mark(data.status === "completed" || data.status === "failed");
          };
          })(),
          onChildRequest: (event: Record<string, unknown>, reply: (msg: unknown) => void) => {
          if (event.type === "teammate_interaction_request" || event.type === "teammate_rpc_ui_request") {
            enqueueChildInteraction(event, reply, ctx, correlationId);
            return;
          }
          if (event.type === "teammate_proxy_cancel" && typeof event.requestId === "string") {
            cancelProxyDispatch(state, event.requestId);
            return;
          }
          handleProxyRequest(
            pi,
            state,
            event,
            reply,
            correlationId,
            refreshModelCatalog(ctx).models,
            (request, respond, childId) => enqueueChildInteraction(request, respond, ctx, childId),
            publishChildCallStatus,
            runtimeOptions,
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
                wakeable: params.context !== "fork",
              }, true);
            }).catch((error) => {
              failGraphDispatch(error);
            });
          };

          if (params.background === false) {
            const graphPromise = executeGraph();
            const waitMs = foregroundWaitWindowMs(normalizedTasks, runtimeOptions.foregroundMaxRunMs);
            const deadline = createForegroundDeadline(waitMs);
            let race:
              | { done: true; result: Awaited<typeof graphPromise> }
              | { done: false; result: null };
            try {
              race = await Promise.race([
                graphPromise.then((result) => ({ done: true as const, result })),
                deadline.promise.then(() => ({ done: false as const, result: null })),
              ]);
            } finally {
              deadline.dispose();
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
                wakeable: params.context !== "fork",
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

            detached = true;
            completeGraphInBackground(graphPromise);
            return {
              content: [{
                type: "text",
                text: `${warningPrefix}${normalizedTasks.length} tasks (${activeGraphMode}) moved to background after ${waitMs}ms. ${backgroundWaitGuidance(correlationId)}`,
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
          const deadline = createForegroundDeadline(waitMs);

          const removeListener = ctx.hasUI
            ? ctx.ui.onTerminalInput((data: string) => {
                if (data !== "\x1bb") return undefined;
                detachResolve?.("manual"); // Alt+B
                return { consume: true };
              })
            : null;

          let runPromise: Promise<SingleResult>;
          let race:
            | { done: true; result: SingleResult; reason: undefined }
            | { done: false; result: null; reason: "manual" | "timeout" };
          try {
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
            deadline.dispose();
          }

          if (race.done) {
            const result = race.result;
            if (!result) throw new Error("Foreground teammate finished without a result.");
            publishSingleResult(result, false);
            const lastMessage = displayMessageForResult(result);
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
              text: `${detachText} ${backgroundWaitGuidance(correlationId)}`,
            }],
            isError: false,
            details: { mode: "single", results: [] },
          };
        }

        // --- BACKGROUND (default) ---
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

    renderResult(result, options, theme) {
      return renderTeammateResult(result, options, theme);
    },
  };

  // =========================================================================
  // Tool 2: teammate-send — send message to named agent
  // =========================================================================

  const sendTool: ToolDefinition<typeof TeammateSendParams, { delivered: boolean }> = {
    name: "teammate-send",
    label: "Teammate Send",
    description: TEAMMATE_SEND_DESCRIPTION,
    promptSnippet: TEAMMATE_SEND_SNIPPET,
    promptGuidelines: TEAMMATE_SEND_GUIDELINES,

    parameters: TeammateSendParams,

    async execute(
      _id: string,
      params: { to: string; message?: string; mode?: RpcMessageMode },
    ): Promise<TeammateToolResult<{ delivered: boolean }>> {
      const requestedMode = params.mode ?? "follow_up";
      const message = params.message ?? "";
      if (!message && requestedMode !== "abort") {
        return {
          content: [{ type: "text", text: `"message" is required for mode "${requestedMode}".` }],
          isError: true,
          details: { delivered: false },
        };
      }

      const cid = resolveAgentCorrelationId(state, params.to);
      if (!cid) {
        const available = Array.from(state.namedAgents.keys());
        return {
          content: [{ type: "text", text: `Agent "${params.to}" not found. ${available.length > 0 ? `Available: ${available.join(", ")}` : "No named agents running."}` }],
          isError: true,
          details: { delivered: false },
        };
      }

      const agent = state.activeRuns.get(cid);
      if (agent && !LIVE_AGENT_STATUSES.has(agent.status)) {
        return {
          content: [{ type: "text", text: `Agent "${params.to}" is already ${agent.status} and cannot receive commands.` }],
          isError: true,
          details: { delivered: false },
        };
      }
      if (agent && requestedMode === "abort") {
        if (agent.stdin?.writable && canChildWrite(agent.lease)) {
          sendRpcMessage(agent.stdin, message, "abort", agent.lease ? leaseToken(agent.lease) : undefined);
        }
        const now = Date.now();
        agent.outputLog.push(`[${new Date(now).toISOString().slice(11, 19)}] ◀ abort: ${message.slice(0, 100)}`);
        agent.lastActivityAt = now;
        pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
          correlationId: cid,
          from: "caller",
          to: params.to,
          mode: "abort",
          message,
          lastActivityAt: now,
          isSend: true,
        });
        const terminated = killAgentTree(state, cid);
        markWorkspacePeerDirty();
        return {
          content: [{
            type: "text",
            text: `Agent "${params.to}" aborted; terminated ${terminated.length} agent${terminated.length === 1 ? "" : "s"} in its subtree.`,
          }],
          isError: false,
          details: { delivered: true },
        };
      }
      const delivery = deliverLocalAgentMessage(
        cid,
        params.to,
        message,
        requestedMode === "steer" ? "steer" : "follow_up",
      );
      if (!delivery.delivered) {
        if (!state.activeRuns.get(cid)?.stdin?.writable) state.namedAgents.delete(params.to);
        return {
          content: [{ type: "text", text: delivery.error ?? `Failed to send message to "${params.to}".` }],
          isError: true,
          details: { delivered: false },
        };
      }

      const modeLabel = delivery.wasSleeping
        ? "woken up + prompt"
        : delivery.mode === "steer" ? "interrupted + injected" : "queued after current turn";
      return {
        content: [{ type: "text", text: `Message ${modeLabel} for "${params.to}".${delivery.wasSleeping ? " Agent woken up." : ""}` }],
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
      params: { view?: TeammateListView },
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
      await workspacePeerLifecycle;
      await refreshWorkspacePeerOwners();
      const local = buildAgentList(state, view);
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
          sessionId: owner.sessionId,
          sessionName: owner.sessionName,
          source: "workspace-peer",
        }))];
      });
      const remoteText = remoteEntries.map((entry) => {
        const icon = entry.status === "failed" ? "✗" : entry.status === "completed" ? "✓" : "●";
        const identity = entry.name ? `[${entry.agent}] name="${entry.name}"` : `[${entry.agent}]`;
        const source = entry.sessionName ?? `owner ${entry.ownerId.slice(0, 8)}`;
        return `${icon} ${identity} · id=${entry.correlationId.slice(0, 8)} · ${entry.status} · workspace peer ${source}`;
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

  const monitorEngine: MonitorEngineState = createEngineState();
  let monitorPeerRefreshTimer: ReturnType<typeof setInterval> | undefined;

  /** Build EngineAgentInfo from a local agent or a cached remote snapshot. */
  function buildEngineAgentInfo(bindingKey: string): EngineAgentInfo | undefined {
    const localAgent = state.activeRuns.get(bindingKey);
    if (localAgent) {
      const label = localAgent.name ?? bindingKey.slice(0, 8);
      const objective = localAgent.inbox.length > 0 ? localAgent.inbox[0].payload.slice(0, 500) : "";
      return {
        correlationId: bindingKey,
        name: label,
        status: localAgent.status,
        idleSeconds: Math.round((Date.now() - localAgent.lastActivityAt) / 1000),
        outputTail: localAgent.outputLog.slice(-20),
        objective,
        hasPendingInteractions: (localAgent.pendingInteractions?.size ?? 0) > 0,
      };
    }
    const target = targetForWorkspaceBinding(bindingKey);
    if (!target || target.scope !== "remote") return undefined;
    const remote = target.agent;
    if (target.state === "settled" && remote.status !== "failed") return undefined;
    const owner = workspacePeerOwners.find((candidate) => candidate.ownerId === target.ownerId);
    return {
      correlationId: bindingKey,
      name: remote.name ?? remote.correlationId.slice(0, 8),
      status: remote.status,
      idleSeconds: Math.round((Date.now() - ("lastActivityAt" in remote ? remote.lastActivityAt : remote.settledAt)) / 1000),
      outputTail: "outputTail" in remote ? (remote.outputTail ?? []) : remote.summary ? [remote.summary] : [],
      objective: "objective" in remote ? (remote.objective ?? "") : "",
      hasPendingInteractions: "pendingInteractions" in remote && (remote.pendingInteractions ?? 0) > 0,
      ...(owner?.sessionName ? { name: `${remote.name ?? remote.correlationId.slice(0, 8)} [${owner.sessionName}]` } : {}),
    };
  }

  /** Start the monitor engine with wired callbacks. */
  function startMonitorEngine(ctx: ExtensionContext): void {
    if (monitorPeerRefreshTimer) clearInterval(monitorPeerRefreshTimer);
    void refreshWorkspacePeerOwners();
    monitorPeerRefreshTimer = setInterval(() => void refreshWorkspacePeerOwners(), 5_000);
    monitorPeerRefreshTimer.unref?.();
    startEngine(monitorEngine, {
      getAgentInfo: buildEngineAgentInfo,
      sendIntervention: async (bindingKey, message, mode) => {
        const target = targetForWorkspaceBinding(bindingKey);
        if (!target || target.state !== "active") return false;
        if (target.scope === "local") {
          return deliverLocalAgentMessage(
            target.agent.correlationId,
            target.agent.name ?? target.agent.correlationId.slice(0, 8),
            message,
            mode,
          ).delivered;
        }
        const publisher = workspacePeerPublisher;
        if (!publisher) return false;
        const result = await sendWorkspacePeerCommand(publisher.identity, target, mode, message);
        return result.response?.status === "accepted";
      },
      onStatusUpdate: (text) => ctx.ui.setStatus(MONITOR_STATUS_KEY, text),
      notifyMain: (message) => {
        safeSendMessage(pi, {
          customType: "teammate-message",
          content: `[monitor] ${message}`,
          display: true,
          details: { source: "monitor" },
        }, { triggerTurn: false });
      },
      analyze: async (binding, info) => {
        const prompt = binding.mode === "custom" && binding.customPrompt
          ? buildCustomAnalysisPrompt(binding.customPrompt, info.objective, info.outputTail)
          : buildAutoAnalysisPrompt(info.objective, info.outputTail);
        try {
          const result = await runSingleTeammate(
            { agent: "analyst", task: prompt, thinking: "low", timeoutMs: 30_000 },
            { baseCwd: state.baseCwd || process.cwd(), depth: 0 },
          );
          const text = result.messages[result.messages.length - 1]?.content ?? "";
          return parseAnalysisResult(text);
        } catch {
          return undefined; // Analysis failure never blocks the monitor
        }
      },
    });
    ctx.ui.setStatus(MONITOR_STATUS_KEY, formatEngineStatusBar(monitorEngine));
  }

  /** Stop the monitor engine and clear status. */
  function stopMonitorEngine(ctx: ExtensionContext): void {
    if (monitorPeerRefreshTimer) clearInterval(monitorPeerRefreshTimer);
    monitorPeerRefreshTimer = undefined;
    stopEngine(monitorEngine);
    clearBindings(monitorEngine);
    ctx.ui.setStatus(MONITOR_STATUS_KEY, undefined);
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

  function teammateSnapshot(id: string, detail: "summary" | "tail" | "full", lines: number): ObservationSnapshot {
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
    return {
      target: { kind: "teammate", id },
      found: true,
      nativeStatus,
      phase: settled ? "settled" : nativeStatus === "pending" ? "pending" : "active",
      ...(nativeStatus === "failed"
        ? { outcome: "failure" as const }
        : nativeStatus === "terminated" ? { outcome: "aborted" as const }
          : settled ? { outcome: "success" as const } : {}),
      ...(monitored.waitStatus ? { waitStatus: monitored.waitStatus as ObservationWaitStatus } : {}),
      summary: monitored.summary || output.at(-1) || nativeStatus,
      ...(detail === "summary" ? {} : { detail: output }),
      updatedAt: Date.now(),
      capabilities: teammateObservationCapabilities,
    };
  }

  function teammateWaitObservation(id: string, result: TeammateWaitResult): ObservationSnapshot {
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
    return {
      target: { kind: "teammate", id },
      found: waitStatus !== "not-found",
      nativeStatus: result.status,
      phase,
      outcome,
      waitStatus,
      summary: result.output[0] ?? result.status,
      detail: result.output,
      updatedAt: Date.now(),
      capabilities: teammateObservationCapabilities,
      ...(waitStatus === "not-found" ? { error: result.output[0] } : {}),
    };
  }

  const teammateObservationProvider: ObservationProvider = {
    kind: "teammate",
    capabilities: teammateObservationCapabilities,
    snapshot: (id, options) => teammateSnapshot(id, options.detail, options.lines),
    wait: async (id, options) => teammateWaitObservation(id, await waitForTeammate(state, {
      name: id,
      timeoutMs: Math.max(1, options.deadline - Date.now()),
    }, options.signal)),
  };
  registerObservationProvider(teammateObservationProvider);

  // --- LLM tool: observe (mixed provider status + wait) ---

  const observeTool: ToolDefinition<typeof ObserveParams, { output: string[]; result: ObserveResult }> = {
    name: "observe",
    label: "Observe",
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
      const output = formatObserveResult(result, params.detail === "full");
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

  // =========================================================================
  // Register tools (LLM-callable)
  // =========================================================================

  pi.registerTool(tool);
  pi.registerTool(sendTool);
  pi.registerTool(listTool);
  pi.registerTool(observeTool);
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
    key: string,
    create: (requestRender: () => void, done: (value: T) => void) => ComposerPanel,
    cancelValue: T,
  ): Promise<T> {
    interactivePanelActive = true;
    updateAgentWidget();

    return new Promise<T>((resolve, reject) => {
      let panel: ComposerPanel | undefined;
      let unsubscribe = () => {};
      let settled = false;
      let panelDisposed = false;

      const disposePanel = (): void => {
        if (panelDisposed) return;
        panelDisposed = true;
        panel?.dispose?.();
      };

      const cleanup = (): void => {
        unsubscribe();
        ctx.ui.setWidget(key, undefined);
        interactivePanelActive = false;
        updateAgentWidget();
      };
      const done = (value: T): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      try {
        ctx.ui.setWidget(key, (tui) => {
          panel = create(() => tui.requestRender(), done);
          return {
            render: (width: number) => panel?.render(width) ?? [],
            handleInput: (data: string) => panel?.handleInput(data),
            invalidate: () => panel?.invalidate(),
            dispose: () => {
              disposePanel();
              done(cancelValue);
            },
          };
        }, { placement: "aboveEditor" });
        unsubscribe = ctx.ui.onTerminalInput((data) => {
          panel?.handleInput(data === "\x03" ? "\x1b" : data);
          return { consume: true };
        });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  async function showAttachOverlay(correlationId: string, ctx: ExtensionContext): Promise<void> {
    const agent = state.activeRuns.get(correlationId);
    if (!agent) {
      ctx.ui.notify("Agent is no longer active.", "error");
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
          () => state.activeRuns,
          async (cid, message) => {
            const target = state.activeRuns.get(cid);
            if (!target?.stdin?.writable) {
              return { ok: false, message: "Agent is no longer writable" };
            }
            const writableLease = target.lease;
            if (!writableLease || !canChildWrite(writableLease)) {
              const ownership = writableLease
                ? `${writableLease.owner} (${writableLease.state})`
                : "an unavailable lease";
              return { ok: false, message: `Session owned by ${ownership}` };
            }
            const sendMode: RpcMessageMode = target.status === "sleeping" ? "prompt" : "follow_up";
            const sent = sendRpcMessage(target.stdin, message, sendMode, target.lease ? leaseToken(target.lease) : undefined);
            if (!sent) return { ok: false, message: "Send failed" };
            if (sendMode === "prompt") target.promptSeq = (target.promptSeq ?? 0) + 1;

            const now = Date.now();
            wakeSleepingAgent(pi, target, now);
            const label = target.name ?? target.correlationId.slice(0, 8);
            target.inbox.push({
              id: randomUUID(),
              from: "caller",
              to: label,
              kind: "task",
              payload: message,
              timestamp: now,
            });
            target.outputLog.push(`[${new Date(now).toISOString().slice(11, 19)}] ◀ follow_up: ${message.slice(0, 100)}`);
            trimAgentBuffers(target);
            target.lastActivityAt = now;
            pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
              correlationId: cid,
              from: "caller",
              to: label,
              mode: sendMode,
              message,
              lastActivityAt: now,
              isSend: true,
            });
            return { ok: true, message: `Queued for ${label}` };
          },
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
        };
        const completeHandler = (data: unknown) => {
          const evt = data as Record<string, unknown>;
          const cid = evt.correlationId as string;
          if (!cid) return;
          overlay.appendLog(cid, `COMPLETED exitCode=${evt.exitCode} ${evt.durationMs}ms`, "system");
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

  async function showAgentSelector(ctx: ExtensionContext): Promise<void> {
    if (buildAgentSelectorRows(Array.from(state.activeRuns.values())).length === 0) {
      ctx.ui.notify("No active teammates. Start one with the teammate tool.", "warning");
      return;
    }
    const initialRows = buildAgentSelectorRows(Array.from(state.activeRuns.values()));
    if (initialRows.length === 1) {
      await showAttachOverlay(initialRows[0].correlationId, ctx);
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
      "teammate-agent-selector",
      (requestRender, done) => {
        let query = "";
        let cursor = 0;
        let lastWidth = 80;
        const pasteDecoder = new BracketedPasteDecoder();
        let pasteFlushTimer: ReturnType<typeof setTimeout> | undefined;
        const refreshTimer = setInterval(requestRender, 1000);
        refreshTimer.unref?.();

        function filtered(): AgentSelectorRow[] {
          const rows = buildAgentSelectorRows(Array.from(state.activeRuns.values()));
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
            clearInterval(refreshTimer);
          },
        };
      },
      null,
    );

    if (selected) {
      await showAttachOverlay(selected, ctx);
    }
  }

  async function prepareAgentHandoff(
    agent: ActiveAgent,
    selectedLease: LeaseSelection,
    timeoutMs = 15_000,
  ): Promise<LeaseSelection | undefined> {
    if (!agent.sendControl) return undefined;
    const parkingLease = transitionLeaseIfCurrent(agent.lease, selectedLease, requestPark);
    if (!parkingLease) return undefined;
    agent.lease = parkingLease;
    const parkingSelection = leaseSelection(parkingLease);
    const nonce = agent.lease.nonce;
    const ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (agent.pendingHandoff?.nonce !== nonce) return;
        agent.pendingHandoff = undefined;
        if (!sameLeaseSelection(agent.lease, parkingSelection)) {
          resolve(false);
          return;
        }
        agent.lease = fenceLease(agent.lease!);
        if (agent.lease) agent.pendingCancel = { nonce, fencedEpoch: agent.lease.epoch };
        agent.sendControl?.({ type: "teammate_handoff_cancel", nonce });
        resolve(false);
      }, timeoutMs);
      agent.pendingHandoff = { nonce, resolve, timer };
    });
    if (!agent.sendControl({
      type: "teammate_handoff_request",
      nonce,
      requiredPromptSeq: agent.promptSeq ?? 0,
    })) {
      if (agent.pendingHandoff) clearTimeout(agent.pendingHandoff.timer);
      agent.pendingHandoff = undefined;
      const activeLease = transitionLeaseIfCurrent(agent.lease, parkingSelection, cancelPark);
      if (activeLease) agent.lease = activeLease;
      return undefined;
    }
    if (!await ready || !agent.lease) return undefined;
    const parkedSelection = leaseSelection(agent.lease);
    if (parkedSelection.owner !== "child"
      || parkedSelection.state !== "parked"
      || !sameLeaseToken(parkingSelection, parkedSelection)) {
      return undefined;
    }
    return parkedSelection;
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
  }

  let activeHandoff: { shutdownObserved: boolean } | undefined;

  async function handleTeammateSession(ctx: ExtensionCommandContext): Promise<void> {
      const currentFile = ctx.sessionManager.getSessionFile();
      const attached = Array.from(state.activeRuns.values()).find((agent) =>
        agent.sessionFile === currentFile
          && agent.lease?.owner === "main"
          && agent.lease.state === "main_active"
      );
      if (attached) {
        if (!state.mainSessionFile) {
          ctx.ui.notify("Main session path is unavailable.", "error");
          return;
        }
        const selectedLease = leaseSelection(attached.lease!);
        await ctx.waitForIdle();
        const reloadingLease = transitionLeaseIfCurrent(attached.lease, selectedLease, requestHandback);
        if (!reloadingLease) {
          ctx.ui.notify("Session lease changed while waiting; retry handback.", "warning");
          return;
        }
        attached.lease = reloadingLease;
        {
          const token = leaseToken(reloadingLease);
          attached.pendingHandback = {
            nonce: token.nonce,
            epoch: token.epoch,
            sessionId: attached.sessionId,
            sessionFile: attached.sessionFile,
          };
          attached.sendControl?.({ type: "teammate_lease_update", token });
        }
        const handoff = { shutdownObserved: false };
        activeHandoff = handoff;
        state.handoffSwitching = true;
        try {
          await switchConversationSession(ctx, state.mainSessionFile, async () => {
              if (activeHandoff === handoff) activeHandoff = undefined;
              state.handoffSwitching = false;
              if (!attached.stdin || !attached.sessionFile) return;
              const reloadSent = sendRpcMessage(attached.stdin, `/teammate-handoff-reload ${encodeURIComponent(attached.sessionFile)}`, "prompt");
              if (!reloadSent && attached.lease) {
                const cancelNonce = attached.pendingHandback?.nonce;
                attached.lease = fenceLease(attached.lease);
                attached.pendingHandback = undefined;
                if (cancelNonce) attached.pendingCancel = { nonce: cancelNonce, fencedEpoch: attached.lease.epoch };
                for (const message of buildFenceRecoveryMessages(attached.lease, cancelNonce)) {
                  attached.sendControl?.(message);
                }
                return;
              }
              setTimeout(() => {
                if (attached.lease?.state === "reloading") {
                  const cancelNonce = attached.pendingHandback?.nonce;
                  attached.lease = fenceLease(attached.lease);
                  attached.pendingHandback = undefined;
                  if (cancelNonce) {
                    attached.pendingCancel = { nonce: cancelNonce, fencedEpoch: attached.lease.epoch };
                  }
                  for (const message of buildFenceRecoveryMessages(attached.lease, cancelNonce)) {
                    attached.sendControl?.(message);
                  }
                  attached.status = "sleeping";
                }
              }, 15_000);
          });
        } catch (error) {
          state.handoffSwitching = false;
          if (activeHandoff === handoff) activeHandoff = undefined;
          if (handoff.shutdownObserved) {
            teardownRootSession();
          } else {
            const restoredToken = restoreMainOwnershipIfHandbackPending(attached);
            if (restoredToken) {
              attached.sendControl?.({ type: "teammate_lease_update", token: restoredToken });
            }
          }
          throw error;
        }
        return;
      }

      const candidates = Array.from(state.activeRuns.values())
        .filter((agent) => Boolean(
          agent.sessionDir
            && agent.sessionFile
            && agent.sendControl
            && agent.lease?.owner === "child"
            && agent.lease.state === "active",
        ))
        .map((agent) => ({ agent, selectedLease: leaseSelection(agent.lease!) }));
      if (candidates.length === 0) {
        ctx.ui.notify("No attachable teammate sessions.", "warning");
        return;
      }
      const labels = candidates.map(({ agent }) => `${agent.name ?? agent.correlationId.slice(0, 8)} · ${agent.agent} · ${agent.status}`);
      const selected = await ctx.ui.select("Switch to teammate session", labels);
      const index = selected ? labels.indexOf(selected) : -1;
      if (index < 0) return;
      const { agent, selectedLease } = candidates[index];
      if (!sameLeaseSelection(agent.lease, selectedLease)) {
        ctx.ui.notify("Session lease changed while selecting; retry handoff.", "warning");
        return;
      }
      ctx.ui.notify(`Waiting for ${agent.name ?? agent.agent} to finish its current loop…`, "info");
      const parkedLease = await prepareAgentHandoff(agent, selectedLease);
      if (!parkedLease) {
        ctx.ui.notify("Session handoff timed out and was fenced.", "error");
        return;
      }
      if (!agent.sessionFile || !agent.lease) return;
      const mainLease = transitionLeaseIfCurrent(agent.lease, parkedLease, transferToMain);
      if (!mainLease) {
        ctx.ui.notify("Session lease changed before transfer; retry handoff.", "warning");
        return;
      }
      agent.lease = mainLease;
      agent.sendControl?.({ type: "teammate_lease_update", token: leaseToken(agent.lease) });
      const handoff = { shutdownObserved: false };
      activeHandoff = handoff;
      state.handoffSwitching = true;
      try {
        await switchConversationSession(ctx, agent.sessionFile, async (sessionCtx) => {
            (sessionCtx.sessionManager as unknown as {
              appendCustomEntry(customType: string, data: unknown): string;
            }).appendCustomEntry("maestro-teammate-attach", {
              version: 1,
              correlationId: agent.correlationId,
              attachedAt: Date.now(),
            });
            if (activeHandoff === handoff) activeHandoff = undefined;
            state.handoffSwitching = false;
        });
      } catch (error) {
        state.handoffSwitching = false;
        if (activeHandoff === handoff) activeHandoff = undefined;
        if (handoff.shutdownObserved) {
          teardownRootSession();
        } else {
          agent.lease = recoverChild(fenceLease(agent.lease));
          for (const message of buildFenceRecoveryMessages(agent.lease, agent.lastParkNonce)) {
            agent.sendControl?.(message);
          }
          agent.lastParkNonce = undefined;
        }
        throw error;
      }
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
      onOpenAgent: async (correlationId) => showAttachOverlay(correlationId, ctx),
    });
  }

  pi.registerCommand("teammate-session", {
    description: "Switch the main Pi conversation to a teammate session or return to main",
    async handler(_args, ctx) {
      await handleTeammateSession(ctx);
    },
  });

  pi.registerCommand("teammate-models", {
    description: "Open teammate roles, collaboration status, and model routing",
    async handler(_args, ctx) {
      await showTeammateControlCenter(ctx);
      tool.description = buildTeammateToolDescription(ctx.cwd);
      pi.registerTool(tool);
    },
  });

  // ---------------------------------------------------------------------------
  // /monitor — user-only monitor mode lifecycle
  // ---------------------------------------------------------------------------

  function monitorSessionRows(): MonitorSessionRow[] {
    const localRows: MonitorSessionRow[] = [...state.activeRuns.values()].map((agent) => ({
      correlationId: agent.correlationId,
      displayName: agent.name ?? agent.correlationId.slice(0, 8),
      agentRole: agent.agent,
      status: agent.status,
      idleSeconds: Math.round((Date.now() - agent.lastActivityAt) / 1000),
      bound: monitorEngine.bindings.has(agent.correlationId),
      source: "local",
    }));
    const remoteRows = workspacePeerOwners.flatMap((owner) => owner.agents.map((agent) => {
      const key = `${owner.ownerId}:${agent.correlationId}`;
      return {
        correlationId: key,
        displayName: agent.name ?? agent.correlationId.slice(0, 8),
        agentRole: agent.agent,
        status: agent.status,
        idleSeconds: Math.round((Date.now() - agent.lastActivityAt) / 1000),
        bound: monitorEngine.bindings.has(key),
        source: owner.sessionName ?? `remote:${owner.ownerId.slice(0, 6)}`,
      } satisfies MonitorSessionRow;
    }));
    return [...localRows, ...remoteRows];
  }

  pi.registerCommand("monitor", {
    description: "Monitor: /monitor <targets...> [auto|custom:<prompt>] | /monitor exit | /monitor [status]",
    getArgumentCompletions(prefix: string) {
      void refreshWorkspacePeerOwners();
      const agents = monitorSessionRows().map((agent) => ({
        value: agent.displayName,
        label: agent.displayName,
        description: `${agent.agentRole} · ${agent.status}${agent.source === "local" ? "" : ` · ${agent.source}`}`,
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

      // /monitor (no args) — open TUI overlay
      if (trimmed === "" || trimmed === "ui") {
        await refreshWorkspacePeerOwners();
        const sessions = monitorSessionRows();

        const result = await showMonitorOverlay(ctx, {
          getSessions: () => sessions,
        });

        if (!result) return; // cancelled

        // Apply selections
        let bound = 0;
        for (const bindingKey of result.selected) {
          const target = targetForWorkspaceBinding(bindingKey);
          if (!target || target.state !== "active") continue;
          const owner = target.scope === "remote"
            ? workspacePeerOwners.find((candidate) => candidate.ownerId === target.ownerId)
            : undefined;
          const displayName = `${target.agent.name ?? target.agent.correlationId.slice(0, 8)}${owner ? ` [${owner.sessionName ?? "remote"}]` : ""}`;
          const res = addBinding(monitorEngine, bindingKey, displayName, result.mode, result.customPrompt);
          if (res.ok) bound++;
        }

        if (bound > 0) {
          if (!monitorEngine.running) startMonitorEngine(ctx);
          else ctx.ui.setStatus(MONITOR_STATUS_KEY, formatEngineStatusBar(monitorEngine));
          ctx.ui.notify(`Monitoring ${bound} session${bound === 1 ? "" : "s"} (${result.mode})`, "info");
        } else {
          ctx.ui.notify("No new bindings created.", "warning");
        }
        return;
      }

      // /monitor exit — stop engine and clear bindings
      if (trimmed === "exit" || trimmed === "stop") {
        if (!monitorEngine.running) {
          ctx.ui.notify("Monitor is not active.", "warning");
          return;
        }
        stopMonitorEngine(ctx);
        ctx.ui.notify("Monitor stopped.", "info");
        return;
      }

      // /monitor status — show bindings + snapshot
      if (trimmed === "status") {
        if (!monitorEngine.running && monitorEngine.bindings.size === 0) {
          ctx.ui.notify("Monitor is not active. Use /monitor <targets...> to start.", "warning");
          return;
        }
        const bindingLines = [...monitorEngine.bindings.values()].map((b) => {
          const icon = b.driftDetected ? "▲" : "✓";
          const fixes = b.interventions.length;
          return `  ${icon} @${b.displayName} ${b.mode}${fixes ? ` · ${fixes} fixes` : ""}`;
        });
        const lines = [
          `MONITOR ${monitorEngine.running ? "active" : "idle"} · ${monitorEngine.bindings.size} bindings`,
          ...bindingLines,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // /monitor <targets...> [auto|custom:<prompt>] — create bindings and start engine
      // Split at custom: boundary to support multi-word prompts
      let mode: MonitorSupervisionMode = "auto";
      let customPrompt: string | undefined;
      let targetPart = trimmed;

      const customIdx = trimmed.indexOf("custom:");
      if (customIdx >= 0) {
        mode = "custom";
        customPrompt = trimmed.slice(customIdx + 7).trim();
        targetPart = trimmed.slice(0, customIdx).trim();
      } else if (trimmed.endsWith(" auto") || trimmed === "auto") {
        targetPart = trimmed.replace(/\s*auto$/, "").trim();
      }

      const targets = targetPart.split(/\s+/).filter((t) => t && t !== "auto");

      if (targets.length === 0) {
        ctx.ui.notify("Usage: /monitor <target1> [target2 ...] [auto|custom:<prompt>]", "warning");
        return;
      }

      // Resolve targets across the current workspace and create bindings.
      await refreshWorkspacePeerOwners();
      let bound = 0;
      const errors: string[] = [];
      for (const name of targets) {
        const target = resolveWorkspaceMonitorTarget(name);
        if (!target || target.state !== "active") {
          errors.push(`${name}: not found or settled`);
          continue;
        }
        const bindingKey = workspaceBindingKey(target);
        const owner = target.scope === "remote"
          ? workspacePeerOwners.find((candidate) => candidate.ownerId === target.ownerId)
          : undefined;
        const displayName = `${target.agent.name ?? target.agent.correlationId.slice(0, 8)}${owner ? ` [${owner.sessionName ?? "remote"}]` : ""}`;
        const result = addBinding(monitorEngine, bindingKey, displayName, mode, customPrompt);
        if (result.ok) bound++;
        else errors.push(result.error ?? `${name}: unknown error`);
      }

      if (bound === 0) {
        ctx.ui.notify(`No bindings created. ${errors.join("; ")}`, "warning");
        return;
      }

      // Start engine if not running
      if (!monitorEngine.running) {
        startMonitorEngine(ctx);
      } else {
        ctx.ui.setStatus(MONITOR_STATUS_KEY, formatEngineStatusBar(monitorEngine));
      }

      const modeLabel = mode === "custom" ? `custom: ${customPrompt?.slice(0, 40)}` : "auto";
      ctx.ui.notify(`Monitoring ${bound} session${bound === 1 ? "" : "s"} (${modeLabel})${errors.length ? ` · ${errors.length} errors` : ""}`, "info");
    },
  });

  // =========================================================================
  // TUI — only in parent mode (child processes have no terminal)
  // =========================================================================

  pi.registerShortcut("alt+r", {
    description: "Open the teammate agent view",
    async handler(ctx) {
      await showAgentSelector(ctx);
    },
  });

  pi.registerShortcut("alt+m", {
    description: "Open the teammate control center",
    async handler(ctx) {
      await showTeammateControlCenter(ctx);
      tool.description = buildTeammateToolDescription(ctx.cwd);
      pi.registerTool(tool);
    },
  });

  let widgetCtx: ExtensionContext | null = null;
  let cockpitOwnsAgents = false;

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

  function startWidgetTimer(): void {
    if (widgetTimer) return;
    stopWakeableEvictionTimer();
    widgetTimer = setInterval(() => {
      // A result-ready zombie keeps hasTeammateWidgetWork true, so this tick is
      // exactly where it stays reachable until reclaimed. Publishing the
      // retirement keeps delta-only consumers (cockpit roster) in sync.
      reclaimResultReadyAgents(state, pi);
      sweepFailedAgents(state);
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
  pi.events.on(COCKPIT_UI_OWNERSHIP_EVENT, (payload) => {
    if (!payload || typeof payload !== "object") return;
    const ownership = payload as { agents?: unknown; quiet?: unknown; quietSymbols?: unknown };
    cockpitOwnsAgents = ownership.agents === true;
    setQuietMode(ownership.quiet === true, ownership.quietSymbols);
    updateAgentWidget();
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

  pi.on("session_start", (_event, ctx) => {
    state.sessionGeneration = (state.sessionGeneration ?? 0) + 1;
    widgetCtx = ctx;
    state.baseCwd = ctx.cwd;
    refreshModelCatalog(ctx);
    tool.description = buildTeammateToolDescription(ctx.cwd);
    pi.registerTool(tool);
    state.currentSessionId = ctx.sessionManager?.getSessionId() ?? null;
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    const isAgentSession = Array.from(state.activeRuns.values()).some((agent) => agent.sessionFile === sessionFile);
    if (sessionFile && !isAgentSession) state.mainSessionFile = sessionFile;
    startWorkspacePeers(ctx);
  });

  pi.on("before_agent_start", injectTeammateContext);

  pi.on("session_compact", (_event, ctx) => {
    widgetCtx = ctx;
    state.baseCwd = ctx.cwd;
    state.currentSessionId = ctx.sessionManager?.getSessionId() ?? null;
    workspacePeerSessionName = ctx.sessionManager?.getSessionName?.() ?? undefined;
    markWorkspacePeerDirty();
    updateAgentWidget();
  });

  pi.on("session_shutdown", () => {
    stopWidgetTimer();
    stopWakeableEvictionTimer();
    if (monitorPeerRefreshTimer) clearInterval(monitorPeerRefreshTimer);
    monitorPeerRefreshTimer = undefined;
    stopEngine(monitorEngine);
    if (state.handoffSwitching && activeHandoff) {
      activeHandoff.shutdownObserved = true;
      widgetCtx = null;
      state.currentSessionId = null;
      return;
    }
    workspacePeerLifecycle = workspacePeerLifecycle.then(stopWorkspacePeers);
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
  resolveWatchTarget,
  safeSendMessage,
  settleAgent,
  settleGraphContainerAgent,
  settleGraphTaskAgent,
  statusForWatchTarget,
  sweepFailedAgents,
  ts,
  waitForTeammate,
  waitOutput,
} from "./teammate-helpers.ts";
import type { TeammateListView, TeammateWaitResult, TeammateWaitStatus } from "./teammate-helpers.ts";

