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
  canProxySendTo,
  checkActiveAgentBudget,
  createForegroundDeadline,
  createProgressFlushGate,
  displayMessageForResult,
  emitTeammateStarted,
  foregroundWaitWindowMs,
  formatRetryDelay,
  handleChildLifecycleEvent,
  resolveProxyParentCorrelationId,
  summarizeGraphResults,
  trimAgentBuffers,
  wakeSleepingAgent,
} from "./index.ts";
import type { TeammateRuntimeOptions } from "./index.ts";



// ===========================================================================
// Helpers
// ===========================================================================

export type AgentListView = "active" | "named" | "all";
export type TeammateListView = AgentListView | "roles";
export type ListedAgentStatus = ActiveAgent["status"] | AgentProgressSnapshot["status"];

export interface ListedAgent {
  agent: string;
  name?: string;
  correlationId: string;
  parentCorrelationId?: string;
  startedAt: string;
  durationMs: number;
  idleMs: number;
  inboxSize: number;
  hasStdin: boolean;
  spawnedBy?: string;
  depth: number;
  treePrefix: string;
  status: ListedAgentStatus;
  taskIndex?: number;
  dependencies?: number[];
  toolCount?: number;
  tokens?: number;
  /** Set once a consumable result exists but the process has not settled. */
  resultReadyAt?: number;
  /** Relayed permission/question requests this agent is blocked on. */
  pendingInteractions?: number;
  requestedModel?: string;
  resolvedModel?: string;
  attemptedModels?: string[];
}

export function buildRoleList(cwd: string): { entries: AgentSummary[]; text: string } {
  const entries = listAgentSummaries(cwd);
  const text = entries.length > 0
    ? `Available teammate roles for ${cwd}:\n${formatAgentCatalog(cwd, Number.MAX_SAFE_INTEGER, 160)}`
    : `No teammate roles discovered for ${cwd}.`;
  return { entries, text };
}

export function progressDurationMs(progress: AgentProgressSnapshot, parent: ActiveAgent): number {
  const startedAt = progress.startedAt
    ? new Date(progress.startedAt).getTime()
    : parent.startedAt;
  const completedAt = progress.completedAt
    ? new Date(progress.completedAt).getTime()
    : Date.now();
  return Math.max(0, completedAt - startedAt);
}

export function correlationIdPrefix(
  correlationId: string,
  correlationIds: Iterable<string>,
  minimumLength = 8,
): string {
  const ids = [...new Set(correlationIds)];
  const maximumLength = Math.max(correlationId.length, ...ids.map((id) => id.length));
  let length = Math.min(minimumLength, correlationId.length);
  while (
    length < maximumLength
    && ids.some((id) => id !== correlationId && id.startsWith(correlationId.slice(0, length)))
  ) {
    length += 1;
  }
  return correlationId.slice(0, length);
}

export function buildAgentList(
  state: TeammateState,
  view: AgentListView,
): { entries: ListedAgent[]; text: string } {
  const entries: ListedAgent[] = [];
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];

  const physicalVisible = (entry: ActiveAgent): boolean => {
    if (view === "active" && entry.status === "completed") return false;
    if (view === "named" && !entry.name && !entry.progress?.some((item) => item.name)) return false;
    return true;
  };

  for (const [cid, entry] of state.activeRuns) {
    if (!physicalVisible(entry)) continue;
    if (entry.spawnedBy && state.activeRuns.has(entry.spawnedBy)) {
      const siblings = childrenOf.get(entry.spawnedBy) ?? [];
      siblings.push(cid);
      childrenOf.set(entry.spawnedBy, siblings);
    } else {
      roots.push(cid);
    }
  }

  function visitPhysical(
    cid: string,
    treePrefix: string,
    descendantsPrefix: string,
    depth: number,
  ): void {
    const entry = state.activeRuns.get(cid);
    if (!entry || !physicalVisible(entry)) return;

    entries.push({
      agent: entry.agent,
      name: entry.name,
      correlationId: cid,
      startedAt: new Date(entry.startedAt).toISOString(),
      durationMs: agentActiveMs(entry),
      idleMs: Date.now() - entry.lastActivityAt,
      inboxSize: entry.inbox.length,
      hasStdin: Boolean(entry.stdin?.writable),
      spawnedBy: entry.spawnedBy,
      depth,
      treePrefix,
      status: entry.status,
      requestedModel: entry.requestedModel,
      resolvedModel: entry.resolvedModel,
      attemptedModels: entry.attemptedModels,
      ...(entry.resultReadyAt !== undefined ? { resultReadyAt: entry.resultReadyAt } : {}),
      ...(entry.pendingInteractions?.size ? { pendingInteractions: entry.pendingInteractions.size } : {}),
    });

    const physicalChildren = (childrenOf.get(cid) ?? [])
      .filter((childCid) => {
        const child = state.activeRuns.get(childCid);
        return Boolean(child && physicalVisible(child));
      });
    const graphChildren = (entry.progress ?? [])
      .filter((progress) => !state.activeRuns.has(progress.correlationId))
      .filter((progress) => view !== "named" || Boolean(progress.name))
      .sort((a, b) => a.taskIndex - b.taskIndex);
    const childCount = physicalChildren.length + graphChildren.length;
    let childIndex = 0;

    for (const childCid of physicalChildren) {
      const isLast = childIndex === childCount - 1;
      visitPhysical(
        childCid,
        `${descendantsPrefix}${isLast ? "└─ " : "├─ "}`,
        `${descendantsPrefix}${isLast ? "   " : "│  "}`,
        depth + 1,
      );
      childIndex++;
    }

    for (const progress of graphChildren) {
      const isLast = childIndex === childCount - 1;
      entries.push({
        agent: progress.agent,
        name: progress.name,
        correlationId: progress.correlationId,
        parentCorrelationId: cid,
        startedAt: progress.startedAt ?? new Date(entry.startedAt).toISOString(),
        durationMs: progressDurationMs(progress, entry),
        idleMs: Date.now() - entry.lastActivityAt,
        inboxSize: 0,
        hasStdin: false,
        spawnedBy: cid,
        depth: depth + 1,
        treePrefix: `${descendantsPrefix}${isLast ? "└─ " : "├─ "}`,
        // A completed container means every task succeeded; trust it over a
        // lifecycle-pending snapshot that was never rewritten back to terminal.
        status: entry.status === "completed" ? "completed" : progress.status,
        taskIndex: progress.taskIndex,
        dependencies: progress.dependencies,
        toolCount: progress.toolCount,
        tokens: progress.tokens,
        requestedModel: progress.requestedModel,
        resolvedModel: progress.resolvedModel,
        attemptedModels: progress.attemptedModels,
        ...(progress.resultReadyAt !== undefined ? { resultReadyAt: progress.resultReadyAt } : {}),
      });
      childIndex++;
    }
  }

  roots.forEach((cid) => visitPhysical(cid, "", "", 0));
  const listedCorrelationIds = entries.map((entry) => entry.correlationId);

  const iconFor = (status: ListedAgentStatus): string => {
    if (status === "pending") return "○";
    if (status === "running") return "●";
    if (status === "retrying") return "↻";
    if (status === "sleeping") return "◉";
    if (status === "failed") return "✗";
    return "✓";
  };
  const text = entries.length > 0
    ? entries.map((entry) => {
        const identity = entry.name
          ? `[${entry.agent}] name="${entry.name}"`
          : `[${entry.agent}]`;
        // This text is the model's whole picture of whether an agent is making
        // progress. Duration alone cannot distinguish a long task from a hung
        // one, so the derived state — result ready, blocked on a prompt, or
        // silent past the stall ceiling — has to be on the line too.
        const idleSeconds = Math.round(entry.idleMs / 1000);
        const stalled = entry.status !== "completed"
          && entry.status !== "failed"
          && entry.resultReadyAt === undefined
          && !entry.pendingInteractions
          && entry.idleMs >= (entry.status === "pending"
            ? TEAMMATE_PENDING_STALL_TIMEOUT_MS
            : TEAMMATE_STALL_TIMEOUT_MS);
        const metadata = [
          `id=${correlationIdPrefix(entry.correlationId, listedCorrelationIds)}`,
          entry.taskIndex !== undefined ? `task=${entry.taskIndex + 1}` : "",
          entry.dependencies?.length
            ? `deps=${entry.dependencies.map((dependency) => dependency + 1).join(",")}`
            : "",
          `${Math.round(entry.durationMs / 1000)}s`,
          entry.resultReadyAt !== undefined ? "result ready" : "",
          entry.pendingInteractions
            ? `awaiting ${entry.pendingInteractions} prompt${entry.pendingInteractions > 1 ? "s" : ""}`
            : "",
          stalled ? `STALLED idle ${idleSeconds}s` : idleSeconds >= 5 ? `idle ${idleSeconds}s` : "",
          entry.toolCount ? `${entry.toolCount} tools` : "",
          entry.tokens ? `${entry.tokens} tok` : "",
          entry.resolvedModel
            ? `model=${entry.resolvedModel}`
            : entry.requestedModel
              ? `requested=${entry.requestedModel}`
              : "",
          entry.attemptedModels && entry.attemptedModels.length > 1
            ? `attempted=${entry.attemptedModels.join(",")}`
            : "",
          entry.inboxSize ? `inbox=${entry.inboxSize}` : "",
        ].filter(Boolean).join(" · ");
        return `${entry.treePrefix}${iconFor(entry.status)} ${identity} · ${metadata}`;
      }).join("\n")
    : "No active teammate agents.";

  return { entries, text };
}

export type WatchTarget =
  | { kind: "agent"; agent: ActiveAgent }
  | { kind: "graph-task"; agent: ActiveAgent; progress: AgentProgressSnapshot };

export interface AgentTargetSelector {
  value: string;
  decorated?: { name: string; idPrefix: string };
}

export function parseAgentTargetSelector(target: string): AgentTargetSelector {
  const value = target.trim().replace(/^@/, "");
  const marker = value.lastIndexOf("#");
  return marker > 0 && marker < value.length - 1
    ? { value, decorated: { name: value.slice(0, marker), idPrefix: value.slice(marker + 1) } }
    : { value };
}

export function resolveWatchTarget(
  state: TeammateState,
  target: string,
): { match?: WatchTarget; error?: string; available: string[] } {
  const selector = parseAgentTargetSelector(target);
  const available = new Set<string>();
  const correlationIds = new Set<string>();
  for (const [cid, agent] of state.activeRuns) {
    correlationIds.add(cid);
    for (const progress of agent.progress ?? []) correlationIds.add(progress.correlationId);
  }
  for (const [cid, agent] of state.activeRuns) {
    available.add(agent.name ?? correlationIdPrefix(cid, correlationIds));
    for (const progress of agent.progress ?? []) {
      available.add(progress.name ?? correlationIdPrefix(progress.correlationId, correlationIds));
    }
  }

  const namedCid = state.namedAgents.get(selector.value);
  if (namedCid) {
    const agent = state.activeRuns.get(namedCid);
    if (agent) return { match: { kind: "agent", agent }, available: [...available] };
  }

  if (selector.decorated) {
    const decoratedCid = state.namedAgents.get(selector.decorated.name);
    const agent = decoratedCid?.startsWith(selector.decorated.idPrefix)
      ? state.activeRuns.get(decoratedCid)
      : undefined;
    if (agent) return { match: { kind: "agent", agent }, available: [...available] };
  }

  const exactAgent = state.activeRuns.get(selector.value);
  if (exactAgent) return { match: { kind: "agent", agent: exactAgent }, available: [...available] };

  const exactTaskMatches: Array<{ agent: ActiveAgent; progress: AgentProgressSnapshot }> = [];
  for (const agent of state.activeRuns.values()) {
    for (const progress of agent.progress ?? []) {
      if (state.activeRuns.has(progress.correlationId)) continue;
      if (
        progress.correlationId === selector.value
        || progress.name === selector.value
        || (selector.decorated
          && progress.name === selector.decorated.name
          && progress.correlationId.startsWith(selector.decorated.idPrefix))
      ) {
        exactTaskMatches.push({ agent, progress });
      }
    }
  }
  if (exactTaskMatches.length === 1) {
    return { match: { kind: "graph-task", ...exactTaskMatches[0] }, available: [...available] };
  }
  if (exactTaskMatches.length > 1) {
    return { error: `Agent target "${target}" is ambiguous. Use its id from teammate-list.`, available: [...available] };
  }

  const prefixMatches: WatchTarget[] = [];
  const idPrefix = selector.decorated?.idPrefix ?? selector.value;
  for (const [cid, agent] of state.activeRuns) {
    const label = agent.name ?? agent.agent;
    if (cid.startsWith(idPrefix) && (!selector.decorated || label === selector.decorated.name)) {
      prefixMatches.push({ kind: "agent", agent });
    }
    for (const progress of agent.progress ?? []) {
      if (state.activeRuns.has(progress.correlationId)) continue;
      if (
        progress.correlationId.startsWith(idPrefix)
        && (!selector.decorated || progress.name === selector.decorated.name)
      ) {
        prefixMatches.push({ kind: "graph-task", agent, progress });
      }
    }
  }
  if (prefixMatches.length === 1) return { match: prefixMatches[0], available: [...available] };
  if (prefixMatches.length > 1) {
    return { error: `Agent id prefix "${target}" is ambiguous. Use a longer id from teammate-list.`, available: [...available] };
  }
  return { available: [...available] };
}

export function buildWatchOutput(target: WatchTarget, lineCount: number): string[] {
  if (target.kind === "agent") {
    const { agent } = target;
    const label = agent.name ?? agent.correlationId.slice(0, 8);
    const log = agent.outputLog.slice(-lineCount);
    const uptime = Math.round(agentActiveMs(agent) / 1000);
    const idle = Math.round((Date.now() - agent.lastActivityAt) / 1000);
    const output = [
      `[${agent.agent}/${label}] id=${agent.correlationId.slice(0, 8)} | ${agent.status} | up ${uptime}s | idle ${idle}s | log ${agent.outputLog.length} | inbox ${agent.inbox.length}`,
      "---",
      ...log,
    ];
    if (agent.resolvedModel || agent.requestedModel) {
      output.push(
        `Model: ${agent.resolvedModel ?? "not reported"}`
        + (agent.requestedModel ? ` (requested ${agent.requestedModel})` : ""),
      );
    }
    if (agent.attemptedModels && agent.attemptedModels.length > 1) {
      output.push(`Attempted models: ${agent.attemptedModels.join(", ")}`);
    }
    if (agent.status === "retrying" && agent.retry) {
      const retryIn = Math.max(0, Math.ceil((agent.retry.nextRetryAt - Date.now()) / 1000));
      output.push(`Retry ${agent.retry.attempt}/${agent.retry.maxRetries} in ${retryIn}s: ${agent.retry.lastError}`);
    }
    if (agent.resultReadyAt !== undefined && agent.status === "running") {
      output.push("Pi completed a no-tool assistant turn; final agent_end confirmation is pending.");
    }
    const lastResult = agent.lastResult?.trim();
    if (lastResult) {
      output.push("--- last result ---", ...lastResult.split("\n").slice(-lineCount));
    } else if (agent.status === "running" && log.length === 0) {
      output.push("Waiting for model capacity or first activity…");
    }
    if (agent.status === "sleeping") {
      output.push("", "[sleeping — messages remain visible; use teammate-send to wake]");
    }
    if (agent.inbox.length > 0) {
      output.push("--- inbox ---");
      for (const message of agent.inbox.slice(-5)) {
        const time = new Date(message.timestamp).toISOString().slice(11, 19);
        output.push(`[${time}] ◀ ${message.from}: ${message.payload.slice(0, 120)}`);
      }
    }
    return output;
  }

  const { agent, progress } = target;
  const shortId = progress.correlationId.slice(0, 8);
  const marker = progress.name ? `@${progress.name}#${shortId}` : `${progress.agent}#${shortId}`;
  const log = agent.outputLog.filter((line) => line.includes(marker)).slice(-lineCount);
  const label = progress.name ?? shortId;
  const output = [
    `[${progress.agent}/${label}] id=${shortId} | ${progress.status} | parent=${agent.correlationId.slice(0, 8)} (${agent.status}) | task=${progress.taskIndex + 1}`,
    "---",
    ...log,
  ];
  if (progress.resolvedModel || progress.requestedModel) {
    output.push(
      `Model: ${progress.resolvedModel ?? "not reported"}`
      + (progress.requestedModel ? ` (requested ${progress.requestedModel})` : ""),
    );
  }
  if (progress.attemptedModels && progress.attemptedModels.length > 1) {
    output.push(`Attempted models: ${progress.attemptedModels.join(", ")}`);
  }
  const lastMessage = progress.lastMessage?.trim();
  if (progress.resultReadyAt !== undefined && progress.status === "running") {
    output.push("Pi completed a no-tool assistant turn; final agent_end confirmation is pending.");
  }
  if (lastMessage) {
    output.push("--- last message ---", ...lastMessage.split("\n").slice(-lineCount));
  } else if (log.length === 0) {
    output.push(
      progress.status === "pending"
        ? "Waiting for dependencies…"
        : progress.status === "running"
          ? "Waiting for model capacity or first activity…"
          : "No message captured yet.",
    );
  }
  if (agent.status === "sleeping") {
    output.push("", "[graph is sleeping — this task's captured messages remain available]");
  }
  return output;
}

export type TeammateWaitStatus = "completed" | "failed" | "terminated" | "result-ready" | "stalled" | "timeout" | "not-found" | "delayed" | "aborted";

export interface TeammateWaitResult {
  status: TeammateWaitStatus;
  output: string[];
}

export interface PendingTeammateWaiter {
  resolve: (result: TeammateWaitResult) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

export const teammateWaiters = new WeakMap<TeammateState, Map<string, Set<PendingTeammateWaiter>>>();

export function waitOutput(status: TeammateWaitStatus, target?: string): string[] {
  const subject = target ? `Agent "${target}"` : "Delay";
  if (status === "completed") return [`${subject} completed.`];
  if (status === "failed") return [`${subject} failed.`];
  if (status === "terminated") return [`${subject} was terminated.`];
  if (status === "result-ready") return [`${subject} produced a final no-tool assistant turn; final agent_end confirmation is pending.`];
  if (status === "stalled") return [`${subject} stopped reporting activity; inspect its captured output before retrying or terminating it.`];
  if (status === "timeout") return [`${subject} did not settle before the wait timeout.`];
  if (status === "aborted") return [`${subject} wait was aborted.`];
  if (status === "not-found") return [`${subject} was not found.`];
  return [`${subject} elapsed.`];
}

export function clearWaiter(waiters: Set<PendingTeammateWaiter>, waiter: PendingTeammateWaiter): void {
  waiters.delete(waiter);
  if (waiter.timer) clearTimeout(waiter.timer);
  if (waiter.signal && waiter.abortHandler) waiter.signal.removeEventListener("abort", waiter.abortHandler);
}

export function settleTeammateWaiters(
  state: TeammateState,
  correlationId: string,
  status: Extract<TeammateWaitStatus, "completed" | "failed" | "terminated" | "result-ready">,
): void {
  const byAgent = teammateWaiters.get(state);
  const waiters = byAgent?.get(correlationId);
  if (!waiters) return;
  byAgent?.delete(correlationId);
  for (const waiter of [...waiters]) {
    clearWaiter(waiters, waiter);
    waiter.resolve({ status, output: waitOutput(status, correlationId) });
  }
}

/**
 * Marks a target's `result-ready` as delivered and reports whether this call
 * was the one that delivered it. `result-ready` is an edge, not a level: the
 * result becomes consumable once, and the agent then keeps running until its
 * lifecycle confirms. Reporting it on every subsequent wait meant a caller
 * that waited again — to observe the real terminal state — got `result-ready`
 * back immediately, forever, and could never reach `completed`.
 */
export function claimResultReadyNotice(state: TeammateState | undefined, correlationId: string): boolean {
  if (!state) return true;
  const notified = state.resultReadyNotified ??= new Set<string>();
  if (notified.has(correlationId)) return false;
  notified.add(correlationId);
  return true;
}

export function watchTargetStalledAt(target: WatchTarget, state?: TeammateState): number {
  const status = target.kind === "agent" ? target.agent.status : target.progress.status;
  const lastActivityAt = target.kind === "agent"
    ? target.agent.lastActivityAt
    : target.progress.lastActivityAt ?? target.agent.lastActivityAt;
  const idleCeiling = status === "pending"
    ? TEAMMATE_PENDING_STALL_TIMEOUT_MS
    : TEAMMATE_STALL_TIMEOUT_MS;
  const baseStalledAt = lastActivityAt + idleCeiling;
  if (status !== "retrying") return baseStalledAt;
  const correlationId = target.kind === "agent"
    ? target.agent.correlationId
    : target.progress.correlationId;
  const retry = target.kind === "agent"
    ? target.agent.retry
    : state?.activeRuns.get(correlationId)?.retry;
  return retry
    ? Math.max(baseStalledAt, retry.nextRetryAt + TEAMMATE_STALL_TIMEOUT_MS)
    : baseStalledAt;
}

export function statusForWatchTarget(
  target: WatchTarget,
  now = Date.now(),
  state?: TeammateState,
): Extract<TeammateWaitStatus, "completed" | "failed" | "terminated" | "result-ready" | "stalled"> | undefined {
  const status = target.kind === "agent" ? target.agent.status : target.progress.status;
  if (status === "sleeping" || status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "terminated") return "terminated";
  const resultReadyAt = target.kind === "agent" ? target.agent.resultReadyAt : target.progress.resultReadyAt;
  const targetCid = target.kind === "agent" ? target.agent.correlationId : target.progress.correlationId;
  if (resultReadyAt !== undefined && claimResultReadyNotice(state, targetCid)) return "result-ready";
  // An agent blocked on a relayed permission or question is waiting on a human,
  // not stalled. Reporting it as stalled told callers to terminate a healthy
  // agent; the wait's own timeout remains the backstop.
  if (target.kind === "agent" && (target.agent.pendingInteractions?.size ?? 0) > 0) return undefined;
  if (now >= watchTargetStalledAt(target, state)) return "stalled";
  return undefined;
}

export function waitDelayForWatchTarget(
  target: WatchTarget,
  timeoutAt: number | undefined,
  state?: TeammateState,
): number {
  const stalledAt = watchTargetStalledAt(target, state);
  const nextAt = Math.min(stalledAt, timeoutAt ?? Number.POSITIVE_INFINITY);
  // A floor, not just a positive value: an already-elapsed deadline used to
  // clamp to 1ms, turning the waiter into a ~100Hz busy loop.
  return Math.max(TEAMMATE_WAIT_POLL_FLOOR_MS, nextAt - Date.now());
}

export function waitForTeammate(
  state: TeammateState,
  params: { name?: string; timeoutMs?: number; waitMs?: number },
  signal?: AbortSignal,
): Promise<TeammateWaitResult> {
  if (!params.name) {
    if (!params.waitMs) {
      return Promise.resolve({ status: "not-found", output: ["Provide an agent name or waitMs."] });
    }
    if (signal?.aborted) return Promise.resolve({ status: "aborted", output: waitOutput("aborted") });
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abortHandler = () => finish("aborted");
      const finish = (status: "delayed" | "aborted") => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", abortHandler);
        resolve({ status, output: waitOutput(status) });
      };
      signal?.addEventListener("abort", abortHandler, { once: true });
      timer = setTimeout(() => finish("delayed"), params.waitMs);
    });
  }

  const resolved = resolveWatchTarget(state, params.name);
  if (!resolved.match) {
    // A settled agent is gone from activeRuns, so "not found" would read as a
    // bad name and invite a retry that can never succeed. Report what actually
    // happened to it instead.
    const settledRecord = findSettledAgent(state, params.name);
    if (settledRecord) {
      const agoSeconds = Math.round((Date.now() - settledRecord.settledAt) / 1000);
      const label = settledRecord.name ?? settledRecord.agent;
      return Promise.resolve({
        status: settledRecord.status,
        output: [
          `@${label} already ${settledRecord.status} ${agoSeconds}s ago; it is no longer running.`,
          ...(settledRecord.lastResult ? [settledRecord.lastResult] : []),
        ],
      });
    }
    return Promise.resolve({ status: "not-found", output: [
      resolved.error ?? `Agent "${params.name}" not found.${resolved.available.length ? ` Available: ${resolved.available.join(", ")}` : ""}`,
    ] });
  }
  const settled = statusForWatchTarget(resolved.match, Date.now(), state);
  if (settled) {
    return Promise.resolve({
      status: settled,
      output: [...waitOutput(settled, params.name), ...buildWatchOutput(resolved.match, 20)],
    });
  }
  if (signal?.aborted) return Promise.resolve({ status: "aborted", output: waitOutput("aborted", params.name) });

  const correlationId = resolved.match.kind === "agent"
    ? resolved.match.agent.correlationId
    : resolved.match.progress.correlationId;
  const byAgent = teammateWaiters.get(state) ?? new Map<string, Set<PendingTeammateWaiter>>();
  teammateWaiters.set(state, byAgent);
  const waiters = byAgent.get(correlationId) ?? new Set<PendingTeammateWaiter>();
  byAgent.set(correlationId, waiters);
  return new Promise((resolve) => {
    const waiter: PendingTeammateWaiter = { resolve };
    const finish = (status: "completed" | "failed" | "terminated" | "result-ready" | "stalled" | "timeout" | "aborted") => {
      clearWaiter(waiters, waiter);
      if (waiters.size === 0) byAgent.delete(correlationId);
      const output = status === "result-ready"
        || status === "stalled"
        || status === "completed"
        || status === "failed"
        || status === "terminated"
        ? [...waitOutput(status, params.name), ...buildWatchOutput(resolved.match!, 20)]
        : waitOutput(status, params.name);
      resolve({ status, output });
    };
    // Never unbounded: an omitted timeoutMs previously meant "wait forever",
    // and a target that never reaches a terminal status left the tool call
    // hanging for the rest of the session.
    const timeoutAt = Date.now() + (params.timeoutMs || TEAMMATE_WAIT_DEFAULT_TIMEOUT_MS);
    const check = () => {
      const currentStatus = statusForWatchTarget(resolved.match!, Date.now(), state);
      if (currentStatus) return finish(currentStatus);
      if (timeoutAt !== undefined && Date.now() >= timeoutAt) return finish("timeout");
      waiter.timer = setTimeout(check, waitDelayForWatchTarget(resolved.match!, timeoutAt, state));
    };
    if (signal) {
      waiter.signal = signal;
      waiter.abortHandler = () => finish("aborted");
      signal.addEventListener("abort", waiter.abortHandler, { once: true });
    }
    waiters.add(waiter);
    check();
  });
}

export function emitComplete(
  pi: ExtensionAPI,
  id: string | undefined,
  agent: string,
  correlationId: string,
  exitCode: number,
  durationMs: number,
  wakeable?: boolean,
  cancelled?: boolean,
): void {
  pi.events.emit(TEAMMATE_COMPLETE_EVENT, {
    ...(id ? { id } : {}),
    agent, correlationId, exitCode, durationMs,
    ...(wakeable !== undefined ? { wakeable } : {}),
    ...(cancelled !== undefined ? { cancelled } : {}),
  });
}

/**
 * Deferred background and IPC callbacks routinely outlive session replacement:
 * after ctx.newSession()/fork()/switchSession()/reload() the host invalidates
 * the captured ExtensionAPI and every action method throws synchronously via
 * assertActive. The notification target no longer exists, and agent state has
 * already settled via settleAgent/killAgent plus eventBus emit (which is not
 * guarded), so drop the send instead of letting the throw escape into an
 * unhandled rejection that kills the pi process.
 *
 * Returns whether the message was actually delivered. Callers that rely on
 * the notification as the only result channel (detached/background runs)
 * should treat `false` as "settled state remains inspectable but the model
 * was not turned": the result stays reachable through observe / the
 * settled record, it just does not arrive as a new turn.
 */
export function safeSendMessage(
  pi: ExtensionAPI,
  message: Parameters<ExtensionAPI["sendMessage"]>[0],
  options?: Parameters<ExtensionAPI["sendMessage"]>[1],
): boolean {
  try {
    pi.sendMessage(message, options);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("extension ctx is stale")) {
      // Not silent-by-design: a dropped notification is exactly the "finished
      // but nothing came back" case that misreads as a hang. The completion
      // event already fired and state is settled, so this is observability,
      // not a delivery retry.
      console.warn(
        "[pi-maestro-teammate] deferred completion notification dropped: the extension "
        + "ctx became stale (session switched/reloaded). The result is settled and "
        + "inspectable via observe; it will not arrive as a new turn.",
      );
      return false;
    }
    console.error("[pi-maestro-teammate] deferred sendMessage failed:", error);
    return false;
  }
}

export function notifyBackgroundFailure(
  pi: ExtensionAPI,
  id: string,
  agent: string,
  correlationId: string,
  error: unknown,
  state?: TeammateState,
): void {
  const message =
    `Background teammate failed (agent=${agent}, correlationId=${correlationId}, phase=background-promise): `
    + `${error instanceof Error ? error.message : String(error)}`;
  emitComplete(
    pi,
    id,
    agent,
    correlationId,
    1,
    0,
  );
  const delivered = safeSendMessage(
    pi,
    {
      customType: "teammate-complete",
      content: message,
      display: true,
    },
    { triggerTurn: true },
  );
  if (!delivered && state) markSettledResultInspectable(state, correlationId);
}

/**
 * When a deferred completion notification cannot reach the model (stale
 * extension ctx after session switch/reload), the result must stay findable
 * instead of vanishing with the same silence that reads as a hang. The agent
 * record — sleeping for success, a two-minute failed tombstone otherwise —
 * keeps its lastResult; this marker tells observe readers that the
 * missing turn is a dropped notification, not a missing result.
 */
export function markSettledResultInspectable(state: TeammateState, correlationId: string): void {
  const agent = state.activeRuns.get(correlationId);
  if (!agent) return;
  agent.outputLog.push(
    `[${new Date().toISOString().slice(11, 19)}] ! result settled; completion notification dropped `
    + `(extension ctx stale). Inspect via this record / observe.`,
  );
  trimAgentBuffers(agent);
  agent.lastActivityAt = Date.now();
}

export function retireAgent(
  state: TeammateState,
  correlationId: string,
  lastResult?: string,
): void {
  const agent = state.activeRuns.get(correlationId);
  if (!agent) return;
  agent.status = "sleeping";
  agent.retry = undefined;
  agent.lastResult = lastResult === undefined
    ? undefined
    : truncateUtf8Tail(lastResult, AGENT_BUFFER_LIMITS.lastResultBytes);
  agent.sleptAt = Date.now();
  agent.lastActivityAt = Date.now();
  trimAgentBuffers(agent, true);
  settleTeammateWaiters(state, correlationId, "completed");
  enforceWakeableAgentBudget(state);
}

export function applyAgentRetryState(
  state: TeammateState,
  retry: {
    correlationId: string;
    attempt: number;
    maxRetries: number;
    delayMs: number;
    nextRetryAt: number;
    error: string;
  },
): void {
  const agent = state.activeRuns.get(retry.correlationId);
  if (!agent) return;
  agent.status = "retrying";
  agent.retry = {
    attempt: retry.attempt,
    maxRetries: retry.maxRetries,
    nextRetryAt: retry.nextRetryAt,
    lastError: truncateUtf8Tail(retry.error, AGENT_BUFFER_LIMITS.logLineBytes),
  };
  agent.lastActivityAt = Date.now();
  agent.outputLog.push(
    `[${new Date(agent.lastActivityAt).toISOString().slice(11, 19)}] ↻ retry ${retry.attempt}/${retry.maxRetries} in ${Math.ceil(retry.delayMs / 1000)}s: ${agent.retry.lastError}`,
  );
  trimAgentBuffers(agent);
  for (const parent of state.activeRuns.values()) {
    const progress = parent.progress?.find((item) => item.correlationId === retry.correlationId);
    if (!progress) continue;
    progress.status = "retrying";
    progress.lastMessage = agent.retry.lastError;
    progress.lastActivityAt = agent.lastActivityAt;
  }
}

/**
 * A strict Pi `turn_end` can make the assistant answer consumable before the
 * authoritative `agent_end` lifecycle line arrives. Keep the run active, but
 * release event-driven waiters with that distinction made explicit.
 */
export function applyAgentResultReadyState(
  state: TeammateState,
  resultReady: { correlationId: string; resultReadyAt: number },
): void {
  const agent = state.activeRuns.get(resultReady.correlationId);
  if (!agent) return;
  agent.resultReadyAt = resultReady.resultReadyAt;
  agent.lastActivityAt = Math.max(agent.lastActivityAt, resultReady.resultReadyAt);
  const marker = "◆ Pi final assistant turn received; awaiting agent_end.";
  if (agent.outputLog.at(-1) !== marker) agent.outputLog.push(marker);
  trimAgentBuffers(agent);
  for (const parent of state.activeRuns.values()) {
    const progress = parent.progress?.find((item) => item.correlationId === resultReady.correlationId);
    if (!progress) continue;
    progress.resultReadyAt = resultReady.resultReadyAt;
    progress.lastActivityAt = Math.max(progress.lastActivityAt ?? 0, resultReady.resultReadyAt);
  }
  settleTeammateWaiters(state, resultReady.correlationId, "result-ready");
}

export function clearAgentResultReadyState(state: TeammateState, correlationId: string): void {
  const agent = state.activeRuns.get(correlationId);
  if (agent) agent.resultReadyAt = undefined;
  for (const parent of state.activeRuns.values()) {
    const progress = parent.progress?.find((item) => item.correlationId === correlationId);
    if (progress) progress.resultReadyAt = undefined;
  }
  // Clearing the flag re-arms the edge: a later result becomes reportable again.
  state.resultReadyNotified?.delete(correlationId);
}

export interface WakeableAgentCohort {
  controller: AbortController;
  agents: ActiveAgent[];
  named: boolean;
  lastActivityAt: number;
}

export function wakeableAgentCohorts(state: TeammateState): WakeableAgentCohort[] {
  const byController = new Map<AbortController, ActiveAgent[]>();
  for (const agent of state.activeRuns.values()) {
    // Failed tombstones retain diagnostics only; they do not own a process and
    // must not pin otherwise-sleeping graph members out of eviction.
    if (agent.status === "failed" || agent.status === "completed") continue;
    const controller = agent.graphAbortController ?? agent.abortController;
    const cohort = byController.get(controller) ?? [];
    cohort.push(agent);
    byController.set(controller, cohort);
  }
  const namedIds = new Set(state.namedAgents.values());
  return [...byController.entries()]
    .filter(([, agents]) => agents.length > 0 && agents.every((agent) => agent.status === "sleeping"))
    .map(([controller, agents]) => ({
      controller,
      agents,
      named: agents.some((agent) => Boolean(agent.name) || namedIds.has(agent.correlationId)),
      lastActivityAt: Math.max(...agents.map((agent) => agent.lastActivityAt)),
    }));
}

export function terminateAndRemoveWakeableCohort(
  state: TeammateState,
  cohort: WakeableAgentCohort,
): string[] {
  const ids = new Set(cohort.agents.map((agent) => agent.correlationId));
  // Terminate first so lifecycle callbacks can still resolve the registry owner.
  cohort.controller.abort();
  for (const agent of cohort.agents) {
    killAgent(state, agent.correlationId, agent.name, "terminated", false);
  }
  return [...ids];
}

/**
 * Parent-side backstop for an agent that published a consumable result and
 * never confirmed its lifecycle. The child arms its own deadline, so this only
 * catches a process that can no longer speak at all — a wedged pipe, a SIGKILL.
 * Deliberately well above the child's own grace so the child normally wins.
 */
export const RESULT_READY_RECLAIM_MS = 3 * 60_000;

/**
 * Retires agents stuck in `running` with a published result. Such an agent is
 * neither live nor settled: it never reaches a `sleeping` cohort, so the
 * wakeable budget cannot evict it, and it holds an active-agent slot forever.
 */
export function reclaimResultReadyAgents(
  state: TeammateState,
  now = Date.now(),
): string[] {
  const reclaimed: string[] = [];
  for (const [correlationId, agent] of [...state.activeRuns]) {
    if (agent.status !== "running" || agent.resultReadyAt === undefined) continue;
    if (now - agent.resultReadyAt < RESULT_READY_RECLAIM_MS) continue;
    agent.outputLog.push(
      `[${new Date(now).toISOString().slice(11, 19)}] ◆ result published but agent_end never arrived after ` +
      `${Math.round((now - agent.resultReadyAt) / 1000)}s; retiring.`,
    );
    retireAgent(state, correlationId, agent.lastResult);
    reclaimed.push(correlationId);
  }
  return reclaimed;
}

export function enforceWakeableAgentBudget(
  state: TeammateState,
  now = Date.now(),
): string[] {
  const evicted: string[] = [];
  const expired = wakeableAgentCohorts(state)
    .filter((cohort) => now - cohort.lastActivityAt >= (cohort.named
      ? WAKEABLE_AGENT_BUDGET.namedTtlMs
      : WAKEABLE_AGENT_BUDGET.anonymousTtlMs))
    .sort((left, right) => left.lastActivityAt - right.lastActivityAt);
  for (const cohort of expired) {
    if (!cohort.agents.some((agent) => state.activeRuns.has(agent.correlationId))) continue;
    evicted.push(...terminateAndRemoveWakeableCohort(state, cohort));
  }

  let sleepingCount = [...state.activeRuns.values()].filter((agent) => agent.status === "sleeping").length;
  const overflowCandidates = wakeableAgentCohorts(state).sort((left, right) =>
    Number(left.named) - Number(right.named)
      || left.lastActivityAt - right.lastActivityAt
  );
  for (const cohort of overflowCandidates) {
    if (sleepingCount <= WAKEABLE_AGENT_BUDGET.maxSleepingAgents) break;
    if (!cohort.agents.some((agent) => state.activeRuns.has(agent.correlationId))) continue;
    evicted.push(...terminateAndRemoveWakeableCohort(state, cohort));
    sleepingCount -= cohort.agents.length;
  }
  return evicted;
}

export function nextWakeableAgentExpiryDelay(
  state: TeammateState,
  now = Date.now(),
): number | undefined {
  const delays = wakeableAgentCohorts(state).map((cohort) =>
    (cohort.named ? WAKEABLE_AGENT_BUDGET.namedTtlMs : WAKEABLE_AGENT_BUDGET.anonymousTtlMs)
      - (now - cohort.lastActivityAt)
  );
  if (delays.length === 0) return undefined;
  return Math.max(1, Math.min(...delays));
}

export function hasTeammateWidgetWork(
  state: TeammateState,
  now = Date.now(),
): boolean {
  return [...state.activeRuns.values()].some((agent) =>
    agent.status === "running"
      || agent.status === "retrying"
      || (agent.status === "pending"
        && now - agent.lastActivityAt <= AGENT_WIDGET_IDLE_HIDE_MS)
      || (agent.status === "sleeping"
        && (!agent.sleptAt || now - agent.sleptAt <= AGENT_WIDGET_IDLE_HIDE_MS))
      // A failed tombstone is work: the timer has to keep running to render it
      // and, once its window closes, to sweep it.
      || (agent.status === "failed"
        && now - (agent.failedAt ?? agent.lastActivityAt) <= FAILED_AGENT_RETENTION_MS)
  );
}

export function fenceProxyDispatchesForAgents(
  state: TeammateState,
  selected: ReadonlySet<string>,
): void {
  for (const [requestId, correlationId] of state.proxyDispatchByRequest ?? []) {
    if (!selected.has(correlationId)) continue;
    if (state.proxyDispatchByRequest?.get(requestId) === correlationId) {
      state.proxyDispatchByRequest.delete(requestId);
    }
    (state.cancelledProxyDispatches ??= new Map()).set(requestId, correlationId);
  }
}

export function terminateNestedDispatchesOwnedBy(
  state: TeammateState,
  parentCorrelationId: string,
): string[] {
  for (const [requestId, parentId] of state.pendingProxyDispatchParents ?? []) {
    if (parentId !== parentCorrelationId) continue;
    state.pendingProxyDispatchParents?.delete(requestId);
    state.pendingProxyDispatchRequests?.delete(requestId);
  }

  const parent = state.activeRuns.get(parentCorrelationId);
  const parentDepth = parent?.depth ?? -1;
  const selected = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const agent of state.activeRuns.values()) {
      const directlyNested = agent.spawnedBy === parentCorrelationId && agent.depth > parentDepth;
      const nestedDescendant = agent.spawnedBy !== undefined && selected.has(agent.spawnedBy);
      if ((!directlyNested && !nestedDescendant) || selected.has(agent.correlationId)) continue;
      selected.add(agent.correlationId);
      changed = true;
    }
  }
  if (selected.size === 0) return [];

  fenceProxyDispatchesForAgents(state, selected);
  const controllers = new Set<AbortController>();
  for (const correlationId of selected) {
    const agent = state.activeRuns.get(correlationId);
    if (agent) controllers.add(agent.abortController);
  }
  for (const controller of controllers) controller.abort();
  for (const correlationId of selected) {
    const agent = state.activeRuns.get(correlationId);
    if (agent) killAgent(state, correlationId, agent.name, "terminated", false);
  }
  return [...selected];
}

export function settleAgent(
  state: TeammateState,
  correlationId: string,
  exitCode: number,
  lastResult?: string,
  wakeable = true,
  terminalStatus?: AgentTerminalStatus,
): void {
  settleAgentLifecycle(state, correlationId, exitCode, lastResult, wakeable, true, terminalStatus);
}

export function settleGraphTaskAgent(
  state: TeammateState,
  correlationId: string,
  exitCode: number,
  lastResult?: string,
  wakeable = true,
  terminalStatus?: AgentTerminalStatus,
): void {
  // A graph member owns a task-local process controller. Natural settlement
  // converges only this registry record; graph cancellation is container-owned.
  settleAgentLifecycle(state, correlationId, exitCode, lastResult, wakeable, false, terminalStatus);
}

export function settleGraphContainerAgent(
  state: TeammateState,
  correlationId: string,
  exitCode: number,
  lastResult?: string,
  wakeable = true,
  terminalStatus?: AgentTerminalStatus,
): void {
  // The container owns no child process. Natural aggregate settlement must not
  // fan out cancellation to successful wakeable graph members.
  settleAgentLifecycle(state, correlationId, exitCode, lastResult, wakeable, false, terminalStatus);
}

export function settleAgentLifecycle(
  state: TeammateState,
  correlationId: string,
  exitCode: number,
  lastResult: string | undefined,
  wakeable: boolean,
  abortProcess: boolean,
  terminalStatus?: AgentTerminalStatus,
): void {
  clearAgentResultReadyState(state, correlationId);
  if (terminalStatus === "terminated") {
    terminateNestedDispatchesOwnedBy(state, correlationId);
    const agent = state.activeRuns.get(correlationId);
    if (agent && lastResult !== undefined) {
      agent.lastResult = truncateUtf8Tail(lastResult, AGENT_BUFFER_LIMITS.lastResultBytes);
    }
    killAgent(state, correlationId, undefined, "terminated", abortProcess);
    return;
  }
  if (exitCode !== 0) {
    terminateNestedDispatchesOwnedBy(state, correlationId);
    const agent = state.activeRuns.get(correlationId);
    if (agent && lastResult !== undefined) {
      agent.lastResult = truncateUtf8Tail(lastResult, AGENT_BUFFER_LIMITS.lastResultBytes);
    }
    killAgent(state, correlationId, undefined, "failed", abortProcess);
    return;
  }
  if (wakeable) {
    retireAgent(state, correlationId, lastResult);
    return;
  }
  // Succeeded, but not wakeable — a fork hands its session to the parent and
  // has nothing left to wake. Its nested dispatches have no requester left.
  terminateNestedDispatchesOwnedBy(state, correlationId);
  killAgent(state, correlationId, undefined, "completed", abortProcess);
}

export function resolveAgentCorrelationId(
  state: TeammateState,
  target: string,
): string | undefined {
  const selector = parseAgentTargetSelector(target);
  const named = state.namedAgents.get(selector.value);
  if (named) return named;
  if (selector.decorated) {
    const decorated = state.namedAgents.get(selector.decorated.name);
    if (decorated?.startsWith(selector.decorated.idPrefix)) return decorated;
  }
  if (state.activeRuns.has(selector.value)) return selector.value;
  const idPrefix = selector.decorated?.idPrefix ?? selector.value;
  const matches = [...state.activeRuns].filter(([correlationId, agent]) =>
    correlationId.startsWith(idPrefix)
      && (!selector.decorated || (agent.name ?? agent.agent) === selector.decorated.name)
  );
  return matches.length === 1 ? matches[0][0] : undefined;
}

/** How many settled agents stay recallable after leaving `activeRuns`. */
export const SETTLED_AGENT_MEMO_LIMIT = 32;

export function recordSettledAgent(
  state: TeammateState,
  agent: ActiveAgent,
  status: SettledAgentRecord["status"],
): void {
  const memo = state.recentlySettled ??= new Map<string, SettledAgentRecord>();
  // Re-insert so a repeat settle moves to the back of the eviction order.
  memo.delete(agent.correlationId);
  memo.set(agent.correlationId, {
    correlationId: agent.correlationId,
    agent: agent.agent,
    ...(agent.name ? { name: agent.name } : {}),
    status,
    settledAt: Date.now(),
    ...(agent.lastResult ? { lastResult: agent.lastResult } : {}),
    ...(agent.requestedModel ? { requestedModel: agent.requestedModel } : {}),
    ...(agent.resolvedModel ? { resolvedModel: agent.resolvedModel } : {}),
    ...(agent.attemptedModels ? { attemptedModels: [...agent.attemptedModels] } : {}),
  });
  while (memo.size > SETTLED_AGENT_MEMO_LIMIT) {
    const oldest = memo.keys().next();
    if (oldest.done) break;
    memo.delete(oldest.value);
  }
}

/** Finds a settled agent by correlationId, name, or correlationId prefix. */
export function findSettledAgent(
  state: TeammateState,
  target: string,
): SettledAgentRecord | undefined {
  const memo = state.recentlySettled;
  if (!memo) return undefined;
  const value = target.trim().replace(/^@/, "");
  const bare = value.includes("#") ? value.slice(0, value.lastIndexOf("#")) : value;
  const direct = memo.get(value);
  if (direct) return direct;
  let prefixMatch: SettledAgentRecord | undefined;
  for (const record of memo.values()) {
    if (record.name === bare) return record;
    if (record.correlationId.startsWith(value)) prefixMatch ??= record;
  }
  return prefixMatch;
}

/**
 * How long a failed agent stays visible before it is swept.
 *
 * Success is visible and failure was not: `retireAgent` leaves a successful
 * agent in `activeRuns` as `sleeping`, but failure was written straight to
 * `completed` and deleted in the same frame — the one status the widget filter
 * discards. Every failure affordance downstream (the red ✗, the anchor that
 * pins a failed row past `maxVisible`, the `N failed` summary) was therefore
 * unreachable, and the run that needed attention was the one that vanished.
 *
 * A failed agent holds no child process, and `LIVE_AGENT_STATUSES` excludes
 * `failed`, so a tombstone costs no concurrency or nesting budget.
 */
export const FAILED_AGENT_RETENTION_MS = 2 * 60_000;

export function killAgent(
  state: TeammateState,
  correlationId: string,
  name?: string,
  waitStatus: Extract<TeammateWaitStatus, "completed" | "failed" | "terminated"> = "terminated",
  abortProcess = true,
): void {
  const agent = state.activeRuns.get(correlationId);
  if (!agent) return;
  recordSettledAgent(state, agent, waitStatus);
  clearAgentResultReadyState(state, correlationId);
  // Before the agent leaves activeRuns: anything it queued on the shared
  // interaction queue would otherwise hold that queue for a process that is
  // already gone, stalling every agent lined up behind it.
  state.cancelInteractions?.(correlationId, "The teammate was terminated before this was answered.");
  if (abortProcess) agent.abortController.abort();
  settleTeammateWaiters(state, correlationId, waitStatus);

  if (waitStatus === "failed") {
    // Keep the failure on screen for its retention window. `sweepFailedAgents`
    // removes it; an explicit terminate still deletes immediately below, since
    // a user-initiated kill is not a failure to report back.
    agent.status = "failed";
    agent.retry = undefined;
    agent.failedAt = Date.now();
    agent.lastActivityAt = Date.now();
    trimAgentBuffers(agent, true);
    releaseAgentMemory(agent);
    return;
  }

  releaseAgentMemory(agent);
  agent.status = "completed";
  removeAgentFromRegistry(state, correlationId, name);
}

/**
 * Binds a display name to an agent, surfacing the collision when one occurs.
 *
 * Names are last-wins by design, but the displacement used to be silent: the
 * previous holder stayed alive and reachable only through its `name#id-prefix`
 * form, while `teammate-wait @name` and `teammate-send @name` quietly retargeted
 * to the newcomer. Both logs now say so, so a misrouted message is traceable.
 */
export function bindAgentName(state: TeammateState, name: string, correlationId: string): void {
  const previousId = state.namedAgents.get(name);
  state.namedAgents.set(name, correlationId);
  if (!previousId || previousId === correlationId) return;
  const previous = state.activeRuns.get(previousId);
  if (!previous || !LIVE_AGENT_STATUSES.has(previous.status)) return;

  const stamp = new Date().toISOString().slice(11, 19);
  const shortPrevious = previousId.slice(0, 8);
  const shortNext = correlationId.slice(0, 8);
  previous.outputLog.push(
    `[${stamp}] ! name "@${name}" taken over by #${shortNext}; reach this agent as "${name}#${shortPrevious}".`,
  );
  trimAgentBuffers(previous);
  state.activeRuns.get(correlationId)?.outputLog.push(
    `[${stamp}] ! name "@${name}" was already held by #${shortPrevious}, which is still running.`,
  );
}

export function removeAgentFromRegistry(
  state: TeammateState,
  correlationId: string,
  name?: string,
): void {
  state.activeRuns.delete(correlationId);
  if (name) state.namedAgents.delete(name);
  for (const [agentName, id] of state.namedAgents) {
    if (id === correlationId) state.namedAgents.delete(agentName);
  }
}

/** Drops failed tombstones past their retention window. */
export function sweepFailedAgents(
  state: TeammateState,
  now = Date.now(),
): string[] {
  const swept: string[] = [];
  for (const [correlationId, agent] of [...state.activeRuns]) {
    if (agent.status !== "failed") continue;
    if (now - (agent.failedAt ?? agent.lastActivityAt) < FAILED_AGENT_RETENTION_MS) continue;
    releaseAgentMemory(agent);
    removeAgentFromRegistry(state, correlationId, agent.name);
    swept.push(correlationId);
  }
  return swept;
}

export function killAgentTree(
  state: TeammateState,
  correlationId: string,
): string[] {
  if (!state.activeRuns.has(correlationId)) return [];

  const selected = new Set([correlationId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const agent of state.activeRuns.values()) {
      if (
        !selected.has(agent.correlationId)
        && agent.spawnedBy
        && selected.has(agent.spawnedBy)
      ) {
        selected.add(agent.correlationId);
        changed = true;
      }
    }
  }

  fenceProxyDispatchesForAgents(state, selected);
  const controllers = new Set<AbortController>();
  for (const id of selected) {
    const agent = state.activeRuns.get(id);
    if (agent) controllers.add(agent.abortController);
  }
  for (const controller of controllers) controller.abort();
  for (const id of selected) {
    const agent = state.activeRuns.get(id);
    if (!agent) continue;
    killAgent(state, id, agent.name, "terminated", false);
  }
  return [...selected];
}

export function agentActiveMs(a: ActiveAgent): number {
  const total = Date.now() - a.startedAt;
  const sleeping = a.sleptAt ? Date.now() - a.sleptAt : 0;
  return total - a.sleepMs - sleeping;
}

export function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

export function releaseAgentMemory(agent: ActiveAgent): void {
  if (agent.pendingHandoff) {
    clearTimeout(agent.pendingHandoff.timer);
    agent.pendingHandoff.resolve(false);
    agent.pendingHandoff = undefined;
  }
  agent.inbox.length = 0;
  if (agent.stdin) {
    try { agent.stdin.end(); } catch { /* already closed */ }
    agent.stdin = undefined;
  }
  agent.pendingInteractions?.clear();
  agent.sendControl = undefined;
}

export interface RelayedQuestionOption {
  label: string;
  description?: string;
}

export interface RelayedQuestion {
  question: string;
  header?: string;
  options?: RelayedQuestionOption[];
  multiSelect?: boolean;
}

export async function handleChildInteractionRequest(
  pi: ExtensionAPI,
  state: TeammateState,
  event: Record<string, unknown>,
  reply: (msg: unknown) => void,
  ctx: ExtensionContext | null | undefined,
  fallbackCorrelationId?: string,
  signal?: AbortSignal,
): Promise<void> {
  const requestId = typeof event.requestId === "string" ? event.requestId : randomUUID();
  const interaction = event.interaction === "permission" ? "permission"
    : event.interaction === "question" ? "question"
      : undefined;
  const payload = isRecord(event.payload) ? event.payload : {};
  const correlationId = typeof event.correlationId === "string"
    ? event.correlationId
    : fallbackCorrelationId;
  const agent = correlationId ? state.activeRuns.get(correlationId) : undefined;
  const agentLabel = agent?.name ?? agent?.agent ?? correlationId?.slice(0, 8) ?? "teammate";

  if (!interaction) {
    replyInteraction(reply, requestId, { action: "cancel", error: "Unknown interaction type" });
    return;
  }

  // structured_output is the teammate's result-return channel: it only writes the
  // parent-provided schema output file and terminates (no code edit, no command, no
  // arbitrary path). Auto-approve it regardless of approval mode or UI availability —
  // a headless child has no UI to approve it interactively, and every outputSchema
  // teammate (e.g. the Goal verifier) depends on it to return a verdict.
  //
  // The tool name comes from the child, so the grant is scoped to agents the
  // parent actually dispatched with a schema. Otherwise any child could reach
  // the auto-approval simply by calling its tool `structured_output`. An agent
  // we cannot identify at all gets no grant.
  if (interaction === "permission"
    && payload.toolName === "structured_output"
    && agent?.expectsStructuredOutput === true) {
    if (agent) {
      agent.outputLog.push(`[${new Date().toISOString().slice(11, 19)}] ◀ permission allow_once (structured_output)`);
      trimAgentBuffers(agent);
      agent.lastActivityAt = Date.now();
    }
    replyInteraction(reply, requestId, { action: "allow_once", updatedInput: payload.input });
    return;
  }

  const record: TeammateInteractionRecord = {
    requestId,
    interaction,
    createdAt: Date.now(),
    payload,
  };
  if (agent) {
    agent.pendingInteractions ??= new Map();
    agent.pendingInteractions.set(requestId, record);
    agent.lastActivityAt = Date.now();
    agent.outputLog.push(`[${new Date().toISOString().slice(11, 19)}] ? ${interaction} request`);
    trimAgentBuffers(agent);
  }

  const requestSummary = interaction === "permission"
    ? `${payload.toolName ?? "tool"}: ${interactionDetail(payload.input)}`
    : questionSummary(payload.questions);
  const parentAuthorization = interaction === "permission" && payload.authorization === "parent";
  if (!parentAuthorization) {
    safeSendMessage(pi, {
      customType: "teammate-interaction-request",
      content: `? @${agentLabel} ${interaction}\n${requestSummary}`,
      display: true,
      details: { requestId, interaction, correlationId, payload },
    }, { triggerTurn: false });
  }

  let result: Record<string, unknown>;
  try {
    if (interaction === "permission" && payload.authorization === "parent") {
      const broker = getTeammatePermissionBroker();
      const toolName = typeof payload.toolName === "string" ? payload.toolName : undefined;
      const input = isRecord(payload.input) ? payload.input : undefined;
      result = broker && toolName && input && ctx
        ? { ...await broker({ toolName, input }, ctx) }
        : { action: "deny", reason: "No parent permission broker is available." };
    } else if (!ctx?.hasUI) {
      result = interaction === "permission" ? { action: "deny" } : { action: "cancel" };
    } else if (interaction === "permission") {
      result = await showRelayedPermission(ctx, agentLabel, payload, signal);
    } else {
      result = await showRelayedQuestions(ctx, agentLabel, payload, signal);
    }
  } catch (error) {
    result = {
      action: interaction === "permission" ? "deny" : "cancel",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    agent?.pendingInteractions?.delete(requestId);
  }

  if (agent) {
    const action = typeof result.action === "string" ? result.action : "cancel";
    agent.outputLog.push(`[${new Date().toISOString().slice(11, 19)}] ◀ ${interaction} ${action}`);
    trimAgentBuffers(agent);
    agent.lastActivityAt = Date.now();
  }
  pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
    correlationId,
    agent: agentLabel,
    interaction,
    requestId,
    action: result.action,
    ...(agent ? { lastActivityAt: agent.lastActivityAt } : {}),
    isInteraction: true,
  });
  replyInteraction(reply, requestId, result);
}

export async function handleChildRpcUiRequest(
  event: Record<string, unknown>,
  reply: (msg: unknown) => void,
  ctx: ExtensionContext | null | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const id = typeof event.id === "string" ? event.id : randomUUID();
  if (!ctx?.hasUI) {
    reply({ type: "extension_ui_response", id, cancelled: true });
    return;
  }
  const method = typeof event.method === "string" ? event.method : "";
  if (method === "select") {
    const options = Array.isArray(event.options)
      ? event.options.filter((value): value is string => typeof value === "string")
      : [];
    const value = await ctx.ui.select(String(event.title ?? "Select"), options, { signal });
    reply(value === undefined
      ? { type: "extension_ui_response", id, cancelled: true }
      : { type: "extension_ui_response", id, value });
    return;
  }
  if (method === "confirm") {
    const confirmed = await ctx.ui.confirm(
      String(event.title ?? "Confirm"),
      String(event.message ?? ""),
      { signal },
    );
    reply({ type: "extension_ui_response", id, confirmed });
    return;
  }
  if (method === "input" || method === "editor") {
    const value = method === "editor"
      ? await ctx.ui.editor(String(event.title ?? "Edit"), typeof event.prefill === "string" ? event.prefill : undefined)
      : await ctx.ui.input(
          String(event.title ?? "Input"),
          typeof event.placeholder === "string" ? event.placeholder : undefined,
          { signal },
        );
    reply(value === undefined
      ? { type: "extension_ui_response", id, cancelled: true }
      : { type: "extension_ui_response", id, value });
    return;
  }
  if (method === "notify") {
    const notifyType = event.notifyType === "warning" || event.notifyType === "error" ? event.notifyType : "info";
    ctx.ui.notify(String(event.message ?? ""), notifyType);
  } else if (method === "setStatus") {
    ctx.ui.setStatus(String(event.statusKey ?? "teammate"), typeof event.statusText === "string" ? event.statusText : undefined);
  } else if (method === "setWidget") {
    const lines = Array.isArray(event.widgetLines)
      ? event.widgetLines.filter((value): value is string => typeof value === "string")
      : undefined;
    ctx.ui.setWidget(String(event.widgetKey ?? "teammate"), lines, {
      placement: event.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor",
    });
  } else if (method === "setTitle") {
    ctx.ui.setTitle(String(event.title ?? ""));
  } else if (method === "set_editor_text") {
    ctx.ui.setEditorText(String(event.text ?? ""));
  }
  reply({ type: "extension_ui_response", id, cancelled: true });
}

export interface TeammateDirectChildRequestHandlerOptions {
  state?: TeammateState;
  fallbackCorrelationId?: string;
}

/**
 * Build the child-request bridge required by direct runSingleTeammate/runGraph users.
 *
 * The root teammate tool installs the same interaction routing internally, but
 * native orchestrators such as Swarm call the public execution API directly.
 * Without this bridge a child permission request is delivered over IPC and
 * then waits until its timeout because no parent handler replies.
 */
export function createTeammateDirectChildRequestHandler(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: TeammateDirectChildRequestHandlerOptions = {},
): NonNullable<RunTeammateOptions["onChildRequest"]> {
  const state = options.state ?? {
    baseCwd: ctx.cwd,
    currentSessionId: null,
    activeRuns: new Map(),
    namedAgents: new Map(),
  };
  const interactionQueue = createTeammateInteractionQueue(pi, state);

  return (event, reply) => {
    if (event.type === "teammate_rpc_ui_request" || event.type === "teammate_interaction_request") {
      interactionQueue.enqueue(event, reply, ctx, options.fallbackCorrelationId);
      return;
    }

    if (event.type === "teammate_proxy_cancel" && typeof event.requestId === "string") {
      cancelProxyDispatch(state, event.requestId);
      return;
    }

    if (event.type === "teammate_proxy_request") {
      void dispatchRegisteredChildTool(event, reply, state).then((handled) => {
        if (!handled) replyUnavailableDirectProxy(event, reply);
      }).catch((error) => replyProxyFailure(event, reply, error));
    }
  };
}

export function replyUnavailableDirectProxy(
  event: Record<string, unknown>,
  reply: (message: unknown) => void,
): void {
  const requestId = typeof event.requestId === "string" ? event.requestId : randomUUID();
  reply({
    type: "teammate_proxy_result",
    requestId,
    result: {
      content: [{
        type: "text",
        text: "Nested teammate calls are unavailable in this direct runtime; return control to the parent orchestrator.",
      }],
      isError: true,
      details: { mode: "single", results: [] },
    },
  });
}

export function replyProxyFailure(
  event: Record<string, unknown>,
  reply: (message: unknown) => void,
  error: unknown,
): void {
  reply({
    type: "teammate_proxy_result",
    requestId: typeof event.requestId === "string" ? event.requestId : randomUUID(),
    result: {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    },
  });
}

export interface TeammateInteractionQueue {
  /** Serializes one relayed child request behind any already in flight. */
  enqueue(
    event: Record<string, unknown>,
    reply: (msg: unknown) => void,
    ctx: ExtensionContext | null | undefined,
    fallbackCorrelationId?: string,
  ): void;
  /** Settles every request belonging to a gone agent. Returns how many. */
  cancelForAgent(correlationId: string, reason: string): number;
  /** Requests still waiting for an answer, in flight or queued. */
  pendingCount(): number;
}
export * from "./teammate-proxy.ts";
import { cancelProxyDispatch, createTeammateInteractionQueue, dispatchRegisteredChildTool, interactionDetail, isRecord, questionSummary, replyInteraction, showRelayedPermission, showRelayedQuestions } from "./teammate-proxy.ts";
