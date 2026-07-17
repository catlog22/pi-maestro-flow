/**
 * Teammate Extension Entry Point
 *
 * Tools: teammate (dispatch), teammate-send (RPC message injection), teammate-list (status)
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
import { truncateToWidth } from "@earendil-works/pi-tui";
import { TeammateParams, TeammateSendParams, TeammateListParams, TeammateWatchParams } from "./schemas.ts";
import {
  runTeammate,
  runGraph,
  normalizeTeammateParams,
  inferGraphMode,
  taskDependencyNames,
  sendRpcMessage,
  truncateUtf8Tail,
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
  renderTeammateCall,
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
import type {
  Details,
  TeammateState,
  AgentProgress,
  AgentProgressSnapshot,
  ActiveAgent,
  MessageEnvelope,
  SingleResult,
  TeammateInteractionRecord,
} from "../shared/types.ts";
import {
  TEAMMATE_COMPLETE_EVENT,
  TEAMMATE_STARTED_EVENT,
  TEAMMATE_MESSAGE_EVENT,
} from "../shared/types.ts";
import {
  appendAgentCatalog,
  discoverAgents,
  formatAgentCatalog,
  listAgentSummaries,
  type AgentSummary,
} from "../agents/agents.ts";
import { formatPromptCatalog } from "../prompts/prompts.ts";
import {
  appendModelCatalog,
  createModelCatalogSnapshot,
  type ModelCatalogSnapshot,
  type TeammateModelCapability,
} from "../models/model-catalog.ts";
import {
  applyModelRouting,
  formatModelRoutingConfig,
} from "../models/model-routing.ts";
import {
  getTeammateChildToolBroker,
  getTeammatePermissionBroker,
  registerTeammateChildProxyCaller,
} from "../runs/child-extensions.ts";

export const TEAMMATE_PROMPT_SNIPPET =
  "Dispatch bounded work to discovered teammate roles for parallel, sequential, or specialist execution.";

export const TEAMMATE_PROMPT_GUIDELINES = [
  "Use teammate when work can be split into bounded independent tasks, or when a discovered specialist role materially improves correctness.",
  "Do not use teammate for trivial, tightly coupled, single-step work that is faster to complete directly.",
  "Use teammate tasks for parallel or DAG work; {name} and {name.field} references create dependencies between named tasks, and dependsOn declares ordering without injecting output.",
  "Give every multi-task teammate item a stable unique name so nested work remains traceable and addressable; a {ref} that matches no task name is passed through as literal text.",
  "Set teammate concurrency explicitly for provider-safe fan-out; use background: false whenever the caller needs child results before continuing.",
  'Use teammate with context: "fork" only when the child needs the current conversation history; fresh context is the default, and in multi-task mode prefer per-task fork over a top-level default.',
  "Use teammate-list or teammate-watch only when status or live output is needed, and teammate-send for steering or follow-up.",
  "Omit model to use teammate task-type model routing; an exact task-level provider/model overrides the top-level model, and the top-level model overrides automatic routing.",
];

export function buildTeammateToolDescription(cwd: string): string {
  return `Dispatch tasks to teammate agents. Teammates run as Pi subprocesses with their own tools and context.

Call forms:
  - Single: { agent: "delegate", taskType: "analysis", task: "...", model: "provider/model" }
  - Explore: { agent: "explorer", taskType: "explore", task: "FIND: ...\\nSCOPE: ..." }
  - Fork: { agent: "delegate", task: "...", context: "fork" }
  - Parallel: { tasks: [{ agent: "explorer", name: "scan", task: "..." }, { agent: "delegate", name: "review", task: "..." }], concurrency: 2, background: false }
  - DAG: name tasks and reference {name} or {name.field} from dependent tasks, or declare dependsOn: ["name"] for ordering without output injection
  - Fixed prompt: { agent: "delegate", prompt: "analysis", task: "Inspect auth", promptArgs: ["@src/auth", "file:line findings"] }

Use an exact role name from the Available Teammate Agents section in the active system prompt. Unknown names are rejected.

Available teammate agents for ${cwd}:
${formatAgentCatalog(cwd, Number.MAX_SAFE_INTEGER, 160)}

Available teammate prompts for ${cwd}:
${formatPromptCatalog(cwd)}

Configured task-type model routing for ${cwd}:
${formatModelRoutingConfig(cwd)}`;
}

const TEAMMATE_SEND_DESCRIPTION = `Send a message to a running teammate agent, addressed by name, correlation ID, or unique ID prefix.

Modes (default: follow_up):
  - "steer" — interrupt the current turn and inject immediately
  - "follow_up" — queue after the current turn completes
  - "abort" — terminate the agent (message optional)`;
const TEAMMATE_SEND_SNIPPET = "Steer, follow up with, or abort a named running teammate agent.";
const TEAMMATE_SEND_GUIDELINES = [
  "Use teammate-send only for a named running or sleeping agent; use follow_up by default, steer for urgent correction, and abort only to terminate work.",
];

const TEAMMATE_LIST_DESCRIPTION =
  'List available roles or active teammate agents. Use view="roles" for builtin, project, and user-defined agent names and descriptions.';
const TEAMMATE_LIST_SNIPPET = "List available teammate roles or inspect active and named agent status.";
const TEAMMATE_LIST_GUIDELINES = [
  'Use teammate-list with view="roles" when an available builtin or custom agent name is needed; use active/named/all for running work.',
];

const TEAMMATE_WATCH_DESCRIPTION =
  "View a running or sleeping teammate agent's recent output, tool activity, inbox messages, and last result.";
const TEAMMATE_WATCH_SNIPPET = "Inspect a specific teammate agent's recent activity and output.";
const TEAMMATE_WATCH_GUIDELINES = [
  "Use teammate-watch for targeted live inspection after selecting an agent name or correlation ID from teammate-list.",
];

export const AGENT_BUFFER_LIMITS = Object.freeze({
  inboxItems: 64,
  sleepingInboxItems: 5,
  inboxBytes: 256 * 1024,
  logLines: 200,
  sleepingLogLines: 100,
  logLineBytes: 16 * 1024,
  logBytes: 512 * 1024,
  lastResultBytes: 256 * 1024,
});

export const WAKEABLE_AGENT_BUDGET = Object.freeze({
  maxSleepingAgents: 12,
  anonymousTtlMs: 15 * 60_000,
  namedTtlMs: 60 * 60_000,
});

const AGENT_WIDGET_SLEEP_HIDE_MS = 60_000;

function trimAgentBuffers(agent: ActiveAgent, sleeping = false): void {
  const inboxLimit = sleeping
    ? AGENT_BUFFER_LIMITS.sleepingInboxItems
    : AGENT_BUFFER_LIMITS.inboxItems;
  let inboxBytes = 0;
  const retainedInbox: MessageEnvelope[] = [];
  for (let index = agent.inbox.length - 1; index >= 0 && retainedInbox.length < inboxLimit; index -= 1) {
    const message = agent.inbox[index];
    const payload = truncateUtf8Tail(message.payload, AGENT_BUFFER_LIMITS.inboxBytes);
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (retainedInbox.length > 0 && inboxBytes + payloadBytes > AGENT_BUFFER_LIMITS.inboxBytes) break;
    retainedInbox.push({ ...message, payload });
    inboxBytes += payloadBytes;
  }
  agent.inbox = retainedInbox.reverse();

  const lineLimit = sleeping
    ? AGENT_BUFFER_LIMITS.sleepingLogLines
    : AGENT_BUFFER_LIMITS.logLines;
  let logBytes = 0;
  const retainedLog: string[] = [];
  for (let index = agent.outputLog.length - 1; index >= 0 && retainedLog.length < lineLimit; index -= 1) {
    const line = truncateUtf8Tail(agent.outputLog[index], AGENT_BUFFER_LIMITS.logLineBytes);
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (retainedLog.length > 0 && logBytes + lineBytes > AGENT_BUFFER_LIMITS.logBytes) break;
    retainedLog.push(line);
    logBytes += lineBytes;
  }
  agent.outputLog = retainedLog.reverse();
  if (agent.lastResult !== undefined) {
    agent.lastResult = truncateUtf8Tail(agent.lastResult, AGENT_BUFFER_LIMITS.lastResultBytes);
  }
}

export function retainBoundedAgentHistory(agent: ActiveAgent, sleeping = false): void {
  trimAgentBuffers(agent, sleeping);
}

export interface ProgressFlushGate {
  mark(terminal?: boolean): void;
  flush(): void;
  dispose(): void;
}

export function createProgressFlushGate(
  onFlush: () => void,
  intervalMs = 300,
): ProgressFlushGate {
  let dirty = false;
  let lastFlushAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancelTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const flush = () => {
    cancelTimer();
    if (!dirty) return;
    dirty = false;
    lastFlushAt = Date.now();
    onFlush();
  };
  const mark = (terminal = false) => {
    dirty = true;
    if (terminal || Date.now() - lastFlushAt >= intervalMs) {
      flush();
      return;
    }
    if (!timer) {
      timer = setTimeout(flush, Math.max(0, intervalMs - (Date.now() - lastFlushAt)));
      timer.unref?.();
    }
  };
  return { mark, flush, dispose: cancelTimer };
}

export function flushProgressBatch<T>(
  pending: Map<number, T>,
  latest: T | undefined,
  apply: (value: T) => void,
  publish: (latestValue: T) => void,
): void {
  if (!latest || pending.size === 0) return;
  const values = [...pending.values()];
  pending.clear();
  for (const value of values) apply(value);
  publish(latest);
}

export async function runWithProgressFlushCleanup<T>(
  run: () => Promise<T>,
  gate: ProgressFlushGate | undefined,
): Promise<T> {
  try {
    return await run();
  } finally {
    gate?.flush();
    gate?.dispose();
  }
}

interface AgentWidgetTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}

export async function switchConversationSession(
  ctx: Pick<ExtensionCommandContext, "switchSession">,
  sessionFile: string,
  onSwitched: () => Promise<void> | void,
): Promise<void> {
  await ctx.switchSession(sessionFile, { withSession: async () => { await onSwitched(); } });
}

interface AgentWidgetRow {
  correlationId: string;
  label: string;
  agent: string;
  status: AgentProgressSnapshot["status"] | "sleeping";
  action: string;
  direction: "↑" | "↓";
  toolCount: number;
  tokens: number;
}

function compactMetric(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 100_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function toolAction(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized === "write" || normalized === "edit" || normalized.includes("patch")) return "writing file";
  if (normalized === "read" || normalized === "grep" || normalized === "ls") return "reading files";
  if (normalized === "bash" || normalized.includes("command")) return "running command";
  return `using ${name}`;
}

function agentWidgetRows(agents: ActiveAgent[]): AgentWidgetRow[] {
  const rows = new Map<string, AgentWidgetRow>();
  const directAgents = new Map(agents.map((agent) => [agent.correlationId, agent]));
  for (const active of agents) {
    const snapshots = active.progress ?? [];
    const effective = snapshots.length > 1 ? snapshots : [snapshots[0]];
    for (const progress of effective) {
      const correlationId = progress?.correlationId ?? active.correlationId;
      const direct = directAgents.get(correlationId);
      const runningTool = progress?.recentTools?.find((tool) => tool.status === "running");
      const status = direct?.status === "sleeping" || (!direct && active.status === "sleeping")
        ? "sleeping"
        : progress?.status ?? direct?.status ?? active.status;
      const action = runningTool
        ? toolAction(runningTool.name)
        : status === "sleeping"
          ? "sleeping"
          : status === "pending"
            ? "waiting for dependencies"
            : status === "failed"
              ? "failed"
              : status === "completed"
                ? "completed"
                : progress?.lastMessage
                  ? "streaming"
                  : "waiting for model";
      const existing = rows.get(correlationId);
      if (!progress && existing) {
        rows.set(correlationId, {
          ...existing,
          label: direct?.name ?? existing.label,
          agent: direct?.agent ?? existing.agent,
          status,
          action: status === "sleeping" ? "sleeping" : existing.action,
        });
        continue;
      }
      rows.set(correlationId, {
        correlationId,
        label: progress?.name ?? direct?.name ?? active.name ?? correlationId.slice(0, 8),
        agent: progress?.agent ?? direct?.agent ?? active.agent,
        status,
        action,
        direction: runningTool ? "↓" : "↑",
        toolCount: progress?.toolCount ?? 0,
        tokens: progress?.tokens ?? 0,
      });
    }
  }
  return [...rows.values()];
}

export function renderAgentStatusWidget(
  agents: ActiveAgent[],
  width: number,
  theme: AgentWidgetTheme,
): string[] {
  const safeWidth = Math.max(1, width);
  const rows = agentWidgetRows(agents);
  if (rows.length === 0) return [];
  const statusRank = (status: AgentWidgetRow["status"]): number => {
    if (status === "failed") return 0;
    if (status === "running") return 1;
    if (status === "sleeping") return 2;
    if (status === "pending") return 3;
    return 4;
  };
  rows.sort((a, b) => statusRank(a.status) - statusRank(b.status));

  const maxVisible = safeWidth < 20 ? 3 : safeWidth < 40 ? 4 : 6;
  const required = new Set<AgentWidgetRow>();
  const failedAnchor = rows.find((row) => row.status === "failed");
  const running = rows.find((row) => row.status === "running");
  if (failedAnchor) required.add(failedAnchor);
  if (running) required.add(running);
  for (const row of rows) {
    if (required.size >= maxVisible) break;
    required.add(row);
  }
  const visible = [...required].sort((a, b) => statusRank(a.status) - statusRank(b.status));
  const hidden = rows.length - visible.length;
  const icon = (row: AgentWidgetRow): string => {
    if (row.status === "running") return theme.fg("success", "■");
    if (row.status === "sleeping") return theme.fg("warning", "◉");
    if (row.status === "failed") return theme.fg("error", "✗");
    if (row.status === "completed") return theme.fg("muted", "✓");
    return theme.fg("dim", "□");
  };

  if (safeWidth < 20) {
    const compact = visible.map((row) => truncateToWidth(
      `${icon(row)} @${row.label} ${row.action}`,
      safeWidth,
      "…",
    ));
    if (hidden > 0) compact.push(truncateToWidth(theme.fg("dim", `… ${hidden} more`), safeWidth, "…"));
    return compact;
  }

  const runningCount = rows.filter((row) => row.status === "running").length;
  const sleeping = rows.filter((row) => row.status === "sleeping").length;
  const pending = rows.filter((row) => row.status === "pending").length;
  const failedCount = rows.filter((row) => row.status === "failed").length;
  const summary = [
    runningCount ? `${runningCount} running` : "",
    sleeping ? `${sleeping} sleeping` : "",
    pending ? `${pending} pending` : "",
    failedCount ? `${failedCount} failed` : "",
  ].filter(Boolean).join(" · ");
  const lines = [truncateToWidth(
    `${theme.bold("Agents")}  ${theme.fg("dim", `${summary} · Alt+R`)}`,
    safeWidth,
    "…",
  )];
  for (let index = 0; index < visible.length; index++) {
    const row = visible[index];
    const connector = index === visible.length - 1 && hidden === 0 ? "└─" : "├─";
    const metrics = [
      row.tokens ? `${row.direction} ${compactMetric(row.tokens)} tokens` : "",
      row.toolCount ? `${row.toolCount} tools` : "",
    ].filter(Boolean).join(" · ");
    const meta = metrics ? ` · ${metrics}` : "";
    lines.push(truncateToWidth(
      `${theme.fg("dim", connector)} ${icon(row)} ${theme.fg("accent", `@${row.label}`)} ${theme.fg("muted", row.agent)} · ${row.action}${theme.fg("dim", meta)}`,
      safeWidth,
      "…",
    ));
  }
  if (hidden > 0) {
    lines.push(truncateToWidth(theme.fg("dim", `└─ … ${hidden} more · Alt+R to inspect`), safeWidth, "…"));
  }
  return lines;
}

export function handleChildLifecycleEvent(
  state: TeammateState,
  event: Record<string, unknown>,
): void {
  const correlationId = event.correlationId as string | undefined;
  if (!correlationId) return;
  const agent = state.activeRuns.get(correlationId);
  if (!agent) return;
  const eventSessionFile = event.sessionFile as string | undefined;
  if (eventSessionFile && !isSessionPathContained(agent.sessionDir, eventSessionFile)) return;

  if (event.type === "teammate_session_ready") {
    agent.sessionId = event.sessionId as string | undefined;
    agent.sessionFile = eventSessionFile;
    return;
  }
  const pendingHandoff = agent.pendingHandoff;
  if (event.type === "teammate_handoff_ready" && pendingHandoff && event.nonce === pendingHandoff.nonce) {
    agent.sessionId = event.sessionId as string | undefined;
    agent.sessionFile = eventSessionFile;
    if (agent.lease) agent.lease = confirmParked(agent.lease);
    agent.lastParkNonce = pendingHandoff.nonce;
    clearTimeout(pendingHandoff.timer);
    pendingHandoff.resolve(true);
    agent.pendingHandoff = undefined;
    return;
  }
  if (event.type === "teammate_handoff_returned") {
    const pending = agent.pendingHandback;
    if (!pending
      || event.nonce !== pending.nonce
      || event.sessionId !== pending.sessionId
      || event.sessionFile !== pending.sessionFile
    ) return;
    if (agent.lease) agent.lease = confirmChildReloaded(agent.lease);
    if (agent.lease) agent.sendControl?.({ type: "teammate_lease_update", token: leaseToken(agent.lease) });
    agent.pendingHandback = undefined;
    agent.status = "running";
    return;
  }
  if (event.type === "teammate_handoff_cancelled"
    && agent.lease?.state === "fenced"
    && agent.pendingCancel?.nonce === event.nonce
    && agent.pendingCancel.fencedEpoch === agent.lease.epoch
  ) {
    agent.lease = recoverChild(agent.lease);
    agent.sendControl?.({ type: "teammate_lease_update", token: leaseToken(agent.lease) });
    agent.pendingCancel = undefined;
  }
}

export function restoreMainOwnershipIfHandbackPending(
  agent: ActiveAgent,
): LeaseToken | undefined {
  const lease = agent.lease;
  const pending = agent.pendingHandback;
  if (!lease
    || !pending
    || lease.owner !== "none"
    || lease.state !== "reloading"
    || lease.epoch !== pending.epoch
    || lease.nonce !== pending.nonce
  ) return undefined;

  agent.lease = restoreMainOwnership(lease);
  agent.pendingHandback = undefined;
  return leaseToken(agent.lease);
}

const CHILD_PROXY_TIMEOUT_MS = 30 * 60 * 1_000;

export interface PendingChildProxyRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

export type ChildProxyPendingRequests = Map<string, PendingChildProxyRequest>;

function takeChildProxyRequest(
  pendingRequests: ChildProxyPendingRequests,
  requestId: string,
): PendingChildProxyRequest | undefined {
  const pending = pendingRequests.get(requestId);
  if (!pending) return undefined;
  pendingRequests.delete(requestId);
  clearTimeout(pending.timer);
  if (pending.signal && pending.abortHandler) {
    pending.signal.removeEventListener("abort", pending.abortHandler);
  }
  return pending;
}

function childProxyAbortError(): Error {
  const error = new Error("Teammate proxy request aborted.");
  error.name = "AbortError";
  return error;
}

/** @internal Exported for lifecycle regression tests. */
export function resolveChildProxyRequest(
  pendingRequests: ChildProxyPendingRequests,
  requestId: string,
  result: unknown,
): boolean {
  const pending = takeChildProxyRequest(pendingRequests, requestId);
  if (!pending) return false;
  pending.resolve(result);
  return true;
}

/** @internal Exported for lifecycle regression tests. */
export function rejectChildProxyRequest(
  pendingRequests: ChildProxyPendingRequests,
  requestId: string,
  error: Error,
): boolean {
  const pending = takeChildProxyRequest(pendingRequests, requestId);
  if (!pending) return false;
  pending.reject(error);
  return true;
}

/** @internal Exported for lifecycle regression tests. */
export function rejectAllChildProxyRequests(
  pendingRequests: ChildProxyPendingRequests,
  error: Error,
): void {
  const pending = [...pendingRequests.values()];
  pendingRequests.clear();
  for (const request of pending) {
    clearTimeout(request.timer);
    if (request.signal && request.abortHandler) {
      request.signal.removeEventListener("abort", request.abortHandler);
    }
    request.reject(error);
  }
}

/** @internal Exported for lifecycle regression tests. */
export function createChildProxyRequest(
  pendingRequests: ChildProxyPendingRequests,
  requestId: string,
  message: Record<string, unknown>,
  send: (message: Record<string, unknown>, callback: (error: Error | null) => void) => boolean,
  timeoutMs = CHILD_PROXY_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(childProxyAbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rejectChildProxyRequest(
        pendingRequests,
        requestId,
        new Error(`Teammate proxy request timed out after ${timeoutMs}ms.`),
      );
    }, timeoutMs);
    const abortHandler = signal
      ? () => rejectChildProxyRequest(pendingRequests, requestId, childProxyAbortError())
      : undefined;
    pendingRequests.set(requestId, { resolve, reject, timer, signal, abortHandler });
    if (signal && abortHandler) signal.addEventListener("abort", abortHandler, { once: true });
    if (signal?.aborted) abortHandler?.();
    if (!pendingRequests.has(requestId)) return;

    try {
      send(message, (error) => {
        if (error) rejectChildProxyRequest(pendingRequests, requestId, error);
      });
    } catch (error) {
      rejectChildProxyRequest(
        pendingRequests,
        requestId,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  });
}

export default function registerTeammateExtension(pi: ExtensionAPI): void {
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
    return { systemPrompt: appendAgentCatalog(withModels, ctx.cwd) };
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
      if (typeof process.send === "function") process.send(message);
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
      pi.registerTool(proxyTeammateTool);
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
            if (bridge.pollTimer) clearInterval(bridge.pollTimer);
            bridge.pollTimer = undefined;
            bridge.parking = false;
            bridge.parked = true;
            sendChildEvent({
              type: "teammate_handoff_ready",
              correlationId: process.env.PI_TEAMMATE_CORRELATION_ID,
              nonce: bridge.nonce,
              sessionId: bridge.ctx.sessionManager.getSessionId(),
              sessionFile: bridge.ctx.sessionManager.getSessionFile(),
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
    ): Promise<AgentToolResult<T>> {
      if (typeof process.send !== "function" || process.connected === false) {
        return {
          content: [{ type: "text", text: "IPC not available. Teammate proxy requires IPC channel." }],
          isError: true,
        } as AgentToolResult<T>;
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
        (message, callback) => process.send!(message, callback),
        CHILD_PROXY_TIMEOUT_MS,
        signal,
      );
      return result as AgentToolResult<T>;
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

    const proxyTeammateTool: ToolDefinition<typeof TeammateParams, Details> = {
      name: "teammate",
      label: "Teammate",
      description: buildTeammateToolDescription(process.cwd()),
      promptSnippet: TEAMMATE_PROMPT_SNIPPET,
      promptGuidelines: TEAMMATE_PROMPT_GUIDELINES,
      parameters: TeammateParams,
      async execute(_id: string, params: RunTeammateParams, signal: AbortSignal) {
        const ctx = bridge.ctx;
        const routed = applyModelRouting(
          params,
          ctx?.cwd ?? process.cwd(),
          ctx ? refreshModelCatalog(ctx).modelIds : modelCatalog.modelIds,
        );
        return proxyCall<Details>("teammate", routed, signal);
      },
    };
    pi.registerTool(proxyTeammateTool);

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
      description: TEAMMATE_LIST_DESCRIPTION,
      promptSnippet: TEAMMATE_LIST_SNIPPET,
      promptGuidelines: TEAMMATE_LIST_GUIDELINES,
      parameters: TeammateListParams,
      async execute(_id: string, params: { view?: TeammateListView }, signal: AbortSignal) {
        return proxyCall<{ agents: unknown[] }>("teammate-list", params, signal);
      },
    });

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
    activeRuns: new Map(),
    namedAgents: new Map(),
  };
  rootGlobals[registryKey] = state;
  let interactionQueue: Promise<void> = Promise.resolve();

  const enqueueChildInteraction = (
    event: Record<string, unknown>,
    reply: (msg: unknown) => void,
    ctx: ExtensionContext | null | undefined,
    fallbackCorrelationId?: string,
  ): void => {
    interactionQueue = interactionQueue
      .then(() => event.type === "teammate_rpc_ui_request"
        ? handleChildRpcUiRequest(event, reply, ctx)
        : handleChildInteractionRequest(
            pi,
            state,
            event,
            reply,
            ctx,
            fallbackCorrelationId,
          ))
      .catch((error) => {
        const requestId = typeof event.requestId === "string" ? event.requestId : "unknown";
        if (event.type === "teammate_rpc_ui_request" && typeof event.id === "string") {
          reply({ type: "extension_ui_response", id: event.id, cancelled: true });
        } else {
          reply({
            type: "teammate_interaction_response",
            requestId,
            result: { action: "cancel", error: error instanceof Error ? error.message : String(error) },
          });
        }
      });
  };

  // =========================================================================
  // Tool 1: teammate — dispatch
  // =========================================================================

  const tool: ToolDefinition<typeof TeammateParams, Details> = {
    name: "teammate",
    label: "Teammate",
    description: buildTeammateToolDescription(process.cwd()),
    promptSnippet: TEAMMATE_PROMPT_SNIPPET,
    promptGuidelines: TEAMMATE_PROMPT_GUIDELINES,

    parameters: TeammateParams,

    async execute(
      id: string,
      params: RunTeammateParams,
      signal: AbortSignal,
      onUpdate:
        | ((result: AgentToolResult<Details>) => void)
        | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<Details>> {
      params = applyModelRouting(
        params,
        (params.cwd ?? state.baseCwd) || ctx.cwd,
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
      const normalizedTasks: NormalizedTask[] = normalization.tasks ?? [];
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
          });
        });
      }

      const progressSnapshot = (): AgentProgressSnapshot[] =>
        [...progressState.values()].sort((a, b) => a.taskIndex - b.taskIndex);

      const correlationId = randomUUID();

      const abortController = new AbortController();

      const agentLabel = isMultiTask ? `graph(${normalizedTasks.length})` : params.agent!;

      const activeAgent: ActiveAgent = {
        agent: agentLabel,
        name: params.name,
        correlationId,
        startedAt: Date.now(),
        abortController,
        inbox: [],
        outputLog: [],
        lastActivityAt: Date.now(),
        replyTo: params.reply_to,
        status: "running",
        sleepMs: 0,
        lease: createChildLease(),
        promptSeq: params.task ? 1 : 0,
        ...(isMultiTask ? { progress: progressSnapshot() } : {}),
      };
      state.activeRuns.set(correlationId, activeAgent);

      if (isMultiTask) {
        normalizedTasks.forEach((task, index) => {
          const childId = taskCorrelationIds[index];
          const childAgent: ActiveAgent = {
            agent: task.agent,
            name: task.name,
            correlationId: childId,
            startedAt: Date.now(),
            abortController,
            inbox: [],
            outputLog: [],
            lastActivityAt: Date.now(),
            spawnedBy: correlationId,
            status: "pending",
            sleepMs: 0,
            lease: createChildLease(),
            promptSeq: task.task ? 1 : 0,
          };
          state.activeRuns.set(childId, childAgent);
          if (task.name) state.namedAgents.set(task.name, childId);
        });
      }

      if (params.name) {
        state.namedAgents.set(params.name, correlationId);
      }

      pi.events.emit(TEAMMATE_STARTED_EVENT, {
        id,
        agent: agentLabel,
        name: params.name,
        correlationId,
      });

      const abortForward = () => abortController.abort();
      signal.addEventListener("abort", abortForward, { once: true });

      const parentSessionFile = ctx.sessionManager?.getSessionFile?.() ?? undefined;
      let progressFlushGate: ProgressFlushGate | undefined;

      const makeOptions = () => ({
        baseCwd: state.baseCwd || ctx.cwd,
        modelCapabilities: refreshModelCatalog(ctx).models,
        ...(isSingle ? { correlationId } : {}),
        ...(isMultiTask ? { taskCorrelationIds } : {}),
        signal: abortController.signal,
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
          if (target.lease) sendControl({ type: "teammate_lease_update", token: leaseToken(target.lease) });
        },
        onChildEvent: (event: Record<string, unknown>) => handleChildLifecycleEvent(state, {
          ...event,
          correlationId,
        }),
        onTurnComplete: (result: SingleResult) => {
          const lastMessage = result.messages[result.messages.length - 1]?.content;
          retireAgent(state, result.correlationId, lastMessage);
        },
        onProgress: (() => {
          const UPDATE_INTERVAL = 300; // ms — throttle TUI updates
          const logStates = new Map<string, {
            loggedToolCount: number;
            streamingLineIdx: number;
            loggedToolLines: Map<number, number>;
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
              ...(data.lastMessage
                ? { lastMessage: truncateUtf8Tail(data.lastMessage, AGENT_BUFFER_LIMITS.lastResultBytes) }
                : {}),
              ...(data.status === "completed" || data.status === "failed"
                ? { completedAt: new Date().toISOString() }
                : {}),
            };
            progressState.set(progressKey, entry);
            const childAgent = state.activeRuns.get(entry.correlationId);
            if (childAgent && childAgent !== activeAgent) {
              childAgent.lastActivityAt = Date.now();
              childAgent.status = entry.status === "completed" ? "sleeping" : entry.status;
              childAgent.outputLog = [...activeAgent.outputLog];
              trimAgentBuffers(childAgent, childAgent.status === "sleeping");
            }

            const shortId = entry.correlationId.slice(0, 8);
            const logKey = entry.correlationId;
            const logState = logStates.get(logKey) ?? {
              loggedToolCount: 0,
              streamingLineIdx: -1,
              loggedToolLines: new Map<number, number>(),
            };
            logStates.set(logKey, logState);
            const logLabel = data.name
              ? `@${data.name}#${shortId}`
              : `${data.agent}#${shortId}`;

            // Record a bounded aggregate history while keeping per-agent cursors independent.
            if (data.recentTools?.length) {
              for (let ti = logState.loggedToolCount; ti < data.recentTools.length; ti++) {
                const tool = data.recentTools[ti];
                logState.loggedToolLines.set(ti, activeAgent.outputLog.length);
                activeAgent.outputLog.push(`[${new Date().toISOString().slice(11, 19)}] ${logLabel} ~ ${tool.name}`);
                logState.streamingLineIdx = -1;
              }
              for (let ti = 0; ti < data.recentTools.length; ti++) {
                const tool = data.recentTools[ti];
                if (tool.status !== "running") {
                  const lineIndex = logState.loggedToolLines.get(ti);
                  if (lineIndex !== undefined && activeAgent.outputLog[lineIndex]?.includes("~ ")) {
                    activeAgent.outputLog[lineIndex] = activeAgent.outputLog[lineIndex].replace("~ ", "✓ ");
                  }
                }
              }
              logState.loggedToolCount = data.recentTools.length;
            }
            if (data.lastMessage) {
              const lastLine = data.lastMessage.split("\n").pop()?.trim();
              if (lastLine) {
                const streamLine = `${logLabel} │ ${lastLine}`;
                if (logState.streamingLineIdx >= 0) {
                  activeAgent.outputLog[logState.streamingLineIdx] = streamLine;
                } else {
                  logState.streamingLineIdx = activeAgent.outputLog.length;
                  activeAgent.outputLog.push(streamLine);
                }
              }
            }
            const logLengthBeforeTrim = activeAgent.outputLog.length;
            trimAgentBuffers(activeAgent);
            if (activeAgent.outputLog.length !== logLengthBeforeTrim) logStates.clear();
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
              progress: currentProgress,
            });

            onUpdate?.({
              content: [{
                type: "text",
                text: `[${data.name ?? data.agent}] ${data.status} · tools ${data.toolCount} · tokens ${data.tokens}`,
              }],
              details: {
                mode: (graphMode ?? "single") as Details["mode"],
                results: [],
                progress: currentProgress,
              },
            });
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
          handleProxyRequest(
            pi,
            state,
            event,
            reply,
            correlationId,
            refreshModelCatalog(ctx).models,
            (request, respond, childId) => enqueueChildInteraction(request, respond, ctx, childId),
          );
        },
      });

      let detached = false;

      try {
        // --- MULTI-TASK MODE (parallel / chain / graph) ---
        if (isMultiTask) {
          const executeGraph = async () => {
            const options = makeOptions();
            const results = await runWithProgressFlushCleanup(
              () => runGraph(normalizedTasks, params.concurrency ?? 4, options),
              progressFlushGate,
            );

            const hasError = results.some((r) => r.exitCode !== 0);
            const totalDur = graphMode === "chain"
              ? results.reduce((s, r) => s + r.durationMs, 0)
              : Math.max(...results.map((r) => r.durationMs), 0);

            const summaries = results
              .map((r, i) => `[${r.agent}${normalizedTasks[i]?.name ? "/" + normalizedTasks[i].name : ""}] ${r.exitCode === 0 ? "OK" : "FAIL"}: ${r.messages[r.messages.length - 1]?.content ?? "(no output)"}`)
              .join("\n\n");

            // Aggregate structured outputs by task name (fallback to index for unnamed)
            const structuredOutputs: Record<string, unknown> = {};
            for (let i = 0; i < results.length; i++) {
              const task = normalizedTasks[i];
              if (results[i].structuredOutput !== undefined) {
                const key = task.name ?? String(i);
                structuredOutputs[key] = results[i].structuredOutput;
              }
            }
            const structuredOutput = Object.keys(structuredOutputs).length > 0
              ? structuredOutputs
              : undefined;

            results.forEach((result, index) => {
              const current = progressState.get(index);
              progressState.set(index, {
                agent: result.agent,
                ...(normalizedTasks[index]?.name ? { name: normalizedTasks[index].name } : {}),
                correlationId: result.correlationId,
                taskIndex: index,
                dependencies: current?.dependencies ?? [],
                status: result.exitCode === 0 ? "completed" : "failed",
                ...(current?.startedAt ? { startedAt: current.startedAt } : {}),
                completedAt: new Date().toISOString(),
                recentTools: current?.recentTools ?? [],
                toolCount: current?.toolCount ?? 0,
                tokens: result.usage.inputTokens + result.usage.outputTokens,
                lastMessage: result.messages[result.messages.length - 1]?.content ?? "",
              });
            });
            const progress = progressSnapshot();
            activeAgent.progress = progress;

            return { results, hasError, totalDur, summaries, structuredOutput, progress };
          };

          if (params.background === false) {
            // Foreground: block until completion
            const { results, hasError, totalDur, summaries, structuredOutput, progress } = await executeGraph();

            emitComplete(pi, id, graphMode, correlationId, hasError ? 1 : 0, totalDur);
            settleAgent(state, correlationId, hasError ? 1 : 0, summaries);

            return {
              content: [{ type: "text", text: warningPrefix + summaries }],
              isError: hasError,
              details: {
                mode: graphMode as Details["mode"],
                results,
                progress,
                ...(structuredOutput !== undefined ? { structuredOutput } : {}),
              },
            };
          }

          // Background (default)
          const bgPromise = executeGraph();

          bgPromise.then(({ results, summaries, progress }) => {
            settleAgent(state, correlationId, results.some((result) => result.exitCode !== 0) ? 1 : 0, summaries);

            pi.sendMessage(
              {
                customType: "teammate-complete",
                content: summaries,
                display: true,
                details: { mode: graphMode, results, progress },
              },
              { triggerTurn: true },
            );
          }).catch((error) => {
            killAgent(state, correlationId);
            notifyBackgroundFailure(pi, id, graphMode, correlationId, error);
          });

          return {
            content: [{
              type: "text",
              text: `${warningPrefix}${normalizedTasks.length} tasks (${graphMode}) running in background. correlationId=${correlationId}. Use teammate-list to check status.`,
            }],
            isError: false,
            details: { mode: graphMode as Details["mode"], results: [], progress: progressSnapshot() },
          };
        }

        if (params.background === false) {
          // --- FOREGROUND: block until completion, Alt+B to detach ---
          let detachResolve: (() => void) | null = null;
          const detachPromise = new Promise<void>((r) => { detachResolve = r; });

          const removeListener = ctx.hasUI
            ? ctx.ui.onTerminalInput((data: string) => {
                if (data === "\x1bb") detachResolve?.(); // Alt+B
              })
            : null;

          const options = makeOptions();
          const runPromise = runWithProgressFlushCleanup(
            () => runTeammate(params, options),
            progressFlushGate,
          );
          const race = await Promise.race([
            runPromise.then((r) => ({ done: true as const, result: r })),
            detachPromise.then(() => ({ done: false as const, result: null })),
          ]);

          removeListener?.();

          if (race.done) {
            const result = race.result!;
            emitComplete(pi, id, params.agent, correlationId, result.exitCode, result.durationMs);
            const lastMessage = result.messages[result.messages.length - 1]?.content ?? "(no output)";
            settleAgent(state, correlationId, result.exitCode, lastMessage);
            const toolResult: AgentToolResult<Details> = {
              content: [{ type: "text", text: warningPrefix + lastMessage }],
              isError: result.exitCode !== 0,
              details: { mode: "single", results: [result] },
            };
            if (result.structuredOutput !== undefined) {
              toolResult.details!.structuredOutput = result.structuredOutput;
            }
            return toolResult;
          }

          // Alt+B: detach to background
          detached = true;
          runPromise.then((result) => {
            emitComplete(pi, id, params.agent, correlationId, result.exitCode, result.durationMs);
            const lastMsg = result.messages[result.messages.length - 1]?.content ?? "(no output)";
            settleAgent(state, correlationId, result.exitCode, lastMsg);
            pi.sendMessage(
              {
                customType: "teammate-complete",
                content: lastMsg,
                display: true,
                details: { mode: "single", results: [result] },
              },
              { triggerTurn: true },
            );
          }).catch((error) => {
            killAgent(state, correlationId);
            notifyBackgroundFailure(pi, id, params.agent, correlationId, error);
          });
          return {
            content: [{ type: "text", text: `■ @${params.name ?? params.agent} detached · completion notification enabled` }],
            isError: false,
            details: { mode: "single", results: [] },
          };
        }

        // --- BACKGROUND (default) ---
        const options = makeOptions();
        const bgPromise = runWithProgressFlushCleanup(
          () => runTeammate(params, options),
          progressFlushGate,
        );

        bgPromise.then((result) => {
          emitComplete(pi, id, params.agent, correlationId, result.exitCode, result.durationMs);
          const lastMsg = result.messages[result.messages.length - 1]?.content ?? "(no output)";
          settleAgent(state, correlationId, result.exitCode, lastMsg);

          pi.sendMessage(
            {
              customType: "teammate-complete",
              content: lastMsg,
              display: true,
              details: { mode: "single", results: [result] },
            },
            { triggerTurn: true },
          );
        }).catch((error) => {
          killAgent(state, correlationId);
          notifyBackgroundFailure(pi, id, params.agent, correlationId, error);
        });

        return {
          content: [{
            type: "text",
            text: `${warningPrefix}■ @${params.name ?? params.agent} running in background · teammate-list status · teammate-send message`,
          }],
          isError: false,
          details: { mode: "single", results: [] },
        };
      } finally {
        if (params.background === false && !detached) {
          const agent = state.activeRuns.get(correlationId);
          if (agent?.status === "running") killAgent(state, correlationId);
        }
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
    ): Promise<AgentToolResult<{ delivered: boolean }>> {
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
      if (!agent?.stdin?.writable) {
        state.namedAgents.delete(params.to);
        return {
          content: [{ type: "text", text: `Agent "${params.to}" is no longer running.` }],
          isError: true,
          details: { delivered: false },
        };
      }

      if (!canChildWrite(agent.lease)) {
        return {
          content: [{ type: "text", text: `Agent "${params.to}" is currently owned by ${agent.lease.owner} (${agent.lease.state}).` }],
          isError: true,
          details: { delivered: false },
        };
      }

      const mode: RpcMessageMode = agent.status === "sleeping" && requestedMode !== "abort"
        ? "prompt"
        : requestedMode;
      const sent = sendRpcMessage(agent.stdin, message, mode, agent.lease ? leaseToken(agent.lease) : undefined);
      if (!sent) {
        return {
          content: [{ type: "text", text: `Failed to send message to "${params.to}".` }],
          isError: true,
          details: { delivered: false },
        };
      }

      if (mode === "prompt") agent.promptSeq = (agent.promptSeq ?? 0) + 1;
      const wasSleeping = agent.status === "sleeping";
      if (wasSleeping && mode !== "abort") {
        agent.status = "running";
        if (agent.sleptAt) {
          agent.sleepMs += Date.now() - agent.sleptAt;
          agent.sleptAt = undefined;
        }
      }

      const now = Date.now();
      agent.inbox.push({ id: randomUUID(), from: "caller", to: params.to, kind: mode === "abort" ? "notification" : "task", payload: message, timestamp: now });
      agent.outputLog.push(`[${new Date(now).toISOString().slice(11, 19)}] ◀ ${mode}: ${message.slice(0, 100)}`);
      trimAgentBuffers(agent);
      agent.lastActivityAt = now;

      pi.events.emit(TEAMMATE_MESSAGE_EVENT, { correlationId: cid, from: "caller", to: params.to, mode, message, isSend: true });

      if (mode === "abort") {
        killAgent(state, cid, params.to);
        return {
          content: [{ type: "text", text: `Agent "${params.to}" aborted and terminated.` }],
          isError: false,
          details: { delivered: true },
        };
      }

      const modeLabel = wasSleeping ? "woken up + prompt" : mode === "steer" ? "interrupted + injected" : "queued after current turn";
      return {
        content: [{ type: "text", text: `Message ${modeLabel} for "${params.to}".${wasSleeping ? " Agent woken up." : ""}` }],
        isError: false,
        details: { delivered: true },
      };
    },
  };

  // =========================================================================
  // Tool 3: teammate-list — list active agents
  // =========================================================================

  const listTool: ToolDefinition<typeof TeammateListParams, { agents: unknown[] }> = {
    name: "teammate-list",
    label: "Teammate List",
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
    ): Promise<AgentToolResult<{ agents: unknown[] }>> {
      const view = params.view ?? "active";
      if (view === "roles") {
        const { entries, text } = buildRoleList(ctx.cwd);
        return {
          content: [{ type: "text", text }],
          isError: false,
          details: { agents: entries },
        };
      }
      const { entries, text } = buildAgentList(state, view);

      return {
        content: [{ type: "text", text }],
        isError: false,
        details: { agents: entries },
      };
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
    ): Promise<AgentToolResult<{ output: string[] }>> {
      const lines = params.lines ?? 20;
      const resolved = resolveWatchTarget(state, params.name);
      if (!resolved.match) {
        const suffix = resolved.available.length > 0
          ? ` Available: ${resolved.available.join(", ")}`
          : " No agents are available.";
        return {
          content: [{ type: "text", text: resolved.error ?? `Agent "${params.name}" not found.${suffix}` }],
          isError: true,
          details: { output: [] },
        };
      }
      const output = buildWatchOutput(resolved.match, lines);

      return {
        content: [{ type: "text", text: output.join("\n") }],
        isError: false,
        details: { output },
      };
    },
  };

  // =========================================================================
  // Register tools (LLM-callable)
  // =========================================================================

  pi.registerTool(tool);
  pi.registerTool(sendTool);
  pi.registerTool(listTool);
  pi.registerTool(watchTool);

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
            if (!canChildWrite(target.lease)) {
              return { ok: false, message: `Session owned by ${target.lease.owner} (${target.lease.state})` };
            }
            const sendMode: RpcMessageMode = target.status === "sleeping" ? "prompt" : "follow_up";
            const sent = sendRpcMessage(target.stdin, message, sendMode, target.lease ? leaseToken(target.lease) : undefined);
            if (!sent) return { ok: false, message: "Send failed" };
            if (sendMode === "prompt") target.promptSeq = (target.promptSeq ?? 0) + 1;

            const now = Date.now();
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
            if (target.status === "sleeping") {
              target.status = "running";
              if (target.sleptAt) {
                target.sleepMs += now - target.sleptAt;
                target.sleptAt = undefined;
              }
            }
            pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
              correlationId: cid,
              from: "caller",
              to: label,
              mode: sendMode,
              message,
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
    const entries = Array.from(state.activeRuns.entries()).filter(([, a]) => a.status !== "completed");
    if (entries.length === 0) {
      ctx.ui.notify("No active teammates. Start one with the teammate tool.", "warning");
      return;
    }
    if (entries.length === 1) {
      await showAttachOverlay(entries[0][0], ctx);
      return;
    }

    // Fuzzy search panel above the editor for agent selection.
    const { truncateToWidth: trunc } = await import("@earendil-works/pi-tui");
    type AgentEntry = [string, ActiveAgent];

    function matchScore(entry: AgentEntry, rawQuery: string): number | undefined {
      const [, agent] = entry;
      const text = `${agent.agent} ${agent.name ?? ""} ${agent.correlationId.slice(0, 8)}`.toLowerCase();
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

        function filtered(): AgentEntry[] {
          if (!query) return entries;
          return entries
            .map((entry, index) => ({ entry, index, score: matchScore(entry, query) }))
            .filter((item): item is { entry: AgentEntry; index: number; score: number } => item.score !== undefined)
            .sort((a, b) => b.score - a.score || a.index - b.index)
            .map((item) => item.entry);
        }

        function handleDecodedInput(data: string): void {
          const matches = filtered();
          if (data === "\r" || data === "\n") {
            done(matches[cursor]?.[0] ?? null);
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
          } else {
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
            const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
            const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
            const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
            const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
            const w = Math.max(1, Math.min(width, 60));
            lastWidth = w;
            const matches = filtered();
            if (w < 20) {
              const current = matches[cursor];
              const compact = current
                ? `${current[1].status === "sleeping" ? yellow("◉") : green("■")} ${current[1].agent}/${current[1].name ?? current[0].slice(0, 6)} ${dim(current[1].status)}`
                : `${dim("□")} no matches · Backspace clears filter`;
              const queryPrefix = query ? `${query} ${dim("»")} ` : "";
              return [trunc(`Esc · ${queryPrefix}${compact}`, w, "…")];
            }

            const inner = w - 2;
            const out: string[] = [];
            const frameLine = (content: string) =>
              dim("│") + trunc(` ${content}`, inner, "…", true) + dim("│");
            const maxVisible = 5;
            const start = Math.max(0, Math.min(
              Math.max(0, matches.length - maxVisible),
              cursor - Math.floor(maxVisible / 2),
            ));
            const visibleMatches = matches.slice(start, start + maxVisible);
            const range = matches.length > maxVisible
              ? dim(` ${start + 1}-${start + visibleMatches.length}/${matches.length}`)
              : "";

            out.push(dim("╭" + "─".repeat(inner) + "╮"));
            out.push(frameLine(`${green("❯")} ${query}${dim("│")}${range}`));
            out.push(dim("├" + "─".repeat(inner) + "┤"));

            for (let i = 0; i < visibleMatches.length; i++) {
              const absoluteIndex = start + i;
              const [cid, a] = visibleMatches[i];
              const icon = a.status === "sleeping" ? yellow("◉") : green("■");
              const name = a.name ?? cid.slice(0, 8);
              const up = Math.round((Date.now() - a.startedAt) / 1000);
              const status = a.status === "sleeping" ? yellow("Sleeping") : green("Running");
              const prefix = absoluteIndex === cursor ? green("▸") : " ";
              out.push(frameLine(`${prefix} ${icon} ${bold(`${a.agent}/${name}`)} ${status} ${dim(`${up}s`)}`));
            }
            if (matches.length === 0) {
              out.push(frameLine(dim("□ no matches · Backspace clears the filter")));
            }

            out.push(dim("╰" + "─".repeat(inner) + "╯"));
            const footer = w < 46
              ? " Esc cancel · Enter attach · ↑↓ select"
              : " Esc cancel · Enter attach · ↑↓ select · type to filter";
            out.push(trunc(dim(footer), w, "…"));
            return out;
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
          dispose() { if (pasteFlushTimer) clearTimeout(pasteFlushTimer); },
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
        state.handoffSwitching = true;
        try {
          await switchConversationSession(ctx, state.mainSessionFile, async () => {
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
          const restoredToken = restoreMainOwnershipIfHandbackPending(attached);
          if (restoredToken) {
            attached.sendControl?.({ type: "teammate_lease_update", token: restoredToken });
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
      state.handoffSwitching = true;
      try {
        await switchConversationSession(ctx, agent.sessionFile, async () => {
            state.handoffSwitching = false;
        });
      } catch (error) {
        state.handoffSwitching = false;
        agent.lease = recoverChild(fenceLease(agent.lease));
        for (const message of buildFenceRecoveryMessages(agent.lease, agent.lastParkNonce)) {
          agent.sendControl?.(message);
        }
        agent.lastParkNonce = undefined;
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

  function updateAgentWidget(): void {
    if (!widgetCtx) return;
    if (interactivePanelActive) {
      widgetCtx.ui.setWidget("teammate-agents", undefined);
      return;
    }
    const now = Date.now();
    const visible = Array.from(state.activeRuns.entries()).filter(([, a]) => {
      if (a.status === "completed") return false;
      if (a.status === "sleeping" && a.sleptAt && now - a.sleptAt > AGENT_WIDGET_SLEEP_HIDE_MS) return false;
      return true;
    });
    if (visible.length === 0) {
      widgetCtx.ui.setWidget("teammate-agents", undefined);
      return;
    }

    // Sort: running first, sleeping last
    visible.sort(([, a], [, b]) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (a.status !== "running" && b.status === "running") return 1;
      return a.startedAt - b.startedAt;
    });

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
      enforceWakeableAgentBudget(state);
      updateAgentWidget();
      scheduleWakeableEvictionTimer();
    }, delay);
    wakeableEvictionTimer.unref?.();
  }

  if (!isChild) {
  pi.events.on(TEAMMATE_STARTED_EVENT, () => {
    updateAgentWidget();
    startWidgetTimer();
  });
  pi.events.on(TEAMMATE_COMPLETE_EVENT, () => {
    setTimeout(() => {
      enforceWakeableAgentBudget(state);
      updateAgentWidget();
      if (!hasTeammateWidgetWork(state)) {
        stopWidgetTimer();
        scheduleWakeableEvictionTimer();
      }
    }, 100);
  });

  // =========================================================================
  // Session lifecycle — agents live until session ends
  // =========================================================================

  pi.on("session_start", (_event, ctx) => {
    widgetCtx = ctx;
    state.baseCwd = ctx.cwd;
    refreshModelCatalog(ctx);
    tool.description = buildTeammateToolDescription(ctx.cwd);
    pi.registerTool(tool);
    state.currentSessionId = ctx.sessionManager?.getSessionId() ?? null;
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    const isAgentSession = Array.from(state.activeRuns.values()).some((agent) => agent.sessionFile === sessionFile);
    if (sessionFile && !isAgentSession) state.mainSessionFile = sessionFile;
  });

  pi.on("before_agent_start", injectTeammateContext);

  pi.on("session_compact", (_event, ctx) => {
    widgetCtx = ctx;
    state.baseCwd = ctx.cwd;
    state.currentSessionId = ctx.sessionManager?.getSessionId() ?? null;
    updateAgentWidget();
  });

  pi.on("session_shutdown", () => {
    stopWidgetTimer();
    stopWakeableEvictionTimer();
    if (state.handoffSwitching) {
      widgetCtx = null;
      state.currentSessionId = null;
      return;
    }
    for (const [cid, run] of state.activeRuns) {
      killAgent(state, cid, run.name);
    }
    state.namedAgents.clear();
    state.currentSessionId = null;
    widgetCtx?.ui.setWidget("teammate-agents", undefined);
    widgetCtx = null;
  });
} // end if (!isChild)
} // end registerTeammateExtension

// ===========================================================================
// Helpers
// ===========================================================================

type AgentListView = "active" | "named" | "all";
type TeammateListView = AgentListView | "roles";
type ListedAgentStatus = ActiveAgent["status"] | AgentProgressSnapshot["status"];

interface ListedAgent {
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
}

export function buildRoleList(cwd: string): { entries: AgentSummary[]; text: string } {
  const entries = listAgentSummaries(cwd);
  const text = entries.length > 0
    ? `Available teammate roles for ${cwd}:\n${formatAgentCatalog(cwd, Number.MAX_SAFE_INTEGER, 160)}`
    : `No teammate roles discovered for ${cwd}.`;
  return { entries, text };
}

function progressDurationMs(progress: AgentProgressSnapshot, parent: ActiveAgent): number {
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
        status: progress.status,
        taskIndex: progress.taskIndex,
        dependencies: progress.dependencies,
        toolCount: progress.toolCount,
        tokens: progress.tokens,
      });
      childIndex++;
    }
  }

  roots.forEach((cid) => visitPhysical(cid, "", "", 0));
  const listedCorrelationIds = entries.map((entry) => entry.correlationId);

  const iconFor = (status: ListedAgentStatus): string => {
    if (status === "pending") return "○";
    if (status === "running") return "●";
    if (status === "sleeping") return "◉";
    if (status === "failed") return "✗";
    return "✓";
  };
  const text = entries.length > 0
    ? entries.map((entry) => {
        const identity = entry.name
          ? `[${entry.agent}] name="${entry.name}"`
          : `[${entry.agent}]`;
        const metadata = [
          `id=${correlationIdPrefix(entry.correlationId, listedCorrelationIds)}`,
          entry.taskIndex !== undefined ? `task=${entry.taskIndex + 1}` : "",
          entry.dependencies?.length
            ? `deps=${entry.dependencies.map((dependency) => dependency + 1).join(",")}`
            : "",
          `${Math.round(entry.durationMs / 1000)}s`,
          entry.toolCount ? `${entry.toolCount} tools` : "",
          entry.tokens ? `${entry.tokens} tok` : "",
          entry.inboxSize ? `inbox=${entry.inboxSize}` : "",
        ].filter(Boolean).join(" · ");
        return `${entry.treePrefix}${iconFor(entry.status)} ${identity} · ${metadata}`;
      }).join("\n")
    : "No active teammate agents.";

  return { entries, text };
}

type WatchTarget =
  | { kind: "agent"; agent: ActiveAgent }
  | { kind: "graph-task"; agent: ActiveAgent; progress: AgentProgressSnapshot };

export function resolveWatchTarget(
  state: TeammateState,
  target: string,
): { match?: WatchTarget; error?: string; available: string[] } {
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

  const namedCid = state.namedAgents.get(target);
  if (namedCid) {
    const agent = state.activeRuns.get(namedCid);
    if (agent) return { match: { kind: "agent", agent }, available: [...available] };
  }

  const exactAgent = state.activeRuns.get(target);
  if (exactAgent) return { match: { kind: "agent", agent: exactAgent }, available: [...available] };

  const exactTaskMatches: Array<{ agent: ActiveAgent; progress: AgentProgressSnapshot }> = [];
  for (const agent of state.activeRuns.values()) {
    for (const progress of agent.progress ?? []) {
      if (state.activeRuns.has(progress.correlationId)) continue;
      if (progress.correlationId === target || progress.name === target) {
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
  for (const [cid, agent] of state.activeRuns) {
    if (cid.startsWith(target)) prefixMatches.push({ kind: "agent", agent });
    for (const progress of agent.progress ?? []) {
      if (state.activeRuns.has(progress.correlationId)) continue;
      if (progress.correlationId.startsWith(target)) {
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
  const lastMessage = progress.lastMessage?.trim();
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

function emitComplete(
  pi: ExtensionAPI,
  id: string,
  agent: string,
  correlationId: string,
  exitCode: number,
  durationMs: number,
): void {
  pi.events.emit(TEAMMATE_COMPLETE_EVENT, {
    id, agent, correlationId, exitCode, durationMs,
  });
}

export function notifyBackgroundFailure(
  pi: ExtensionAPI,
  id: string,
  agent: string,
  correlationId: string,
  error: unknown,
): void {
  const message = `Background teammate ${agent} failed: ${error instanceof Error ? error.message : String(error)}`;
  emitComplete(pi, id, agent, correlationId, 1, 0);
  pi.sendMessage(
    {
      customType: "teammate-complete",
      content: message,
      display: true,
    },
    { triggerTurn: true },
  );
}

function retireAgent(
  state: TeammateState,
  correlationId: string,
  lastResult?: string,
): void {
  const agent = state.activeRuns.get(correlationId);
  if (!agent) return;
  agent.status = "sleeping";
  agent.lastResult = lastResult === undefined
    ? undefined
    : truncateUtf8Tail(lastResult, AGENT_BUFFER_LIMITS.lastResultBytes);
  agent.sleptAt = Date.now();
  agent.lastActivityAt = Date.now();
  trimAgentBuffers(agent, true);
  enforceWakeableAgentBudget(state);
}

interface WakeableAgentCohort {
  controller: AbortController;
  agents: ActiveAgent[];
  named: boolean;
  lastActivityAt: number;
}

function wakeableAgentCohorts(state: TeammateState): WakeableAgentCohort[] {
  const byController = new Map<AbortController, ActiveAgent[]>();
  for (const agent of state.activeRuns.values()) {
    const cohort = byController.get(agent.abortController) ?? [];
    cohort.push(agent);
    byController.set(agent.abortController, cohort);
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

function terminateAndRemoveWakeableCohort(
  state: TeammateState,
  cohort: WakeableAgentCohort,
): string[] {
  const ids = new Set(cohort.agents.map((agent) => agent.correlationId));
  // Terminate first so lifecycle callbacks can still resolve the registry owner.
  cohort.controller.abort();
  for (const agent of cohort.agents) {
    releaseAgentMemory(agent);
    agent.status = "completed";
  }
  for (const id of ids) state.activeRuns.delete(id);
  for (const [name, id] of state.namedAgents) {
    if (ids.has(id)) state.namedAgents.delete(name);
  }
  return [...ids];
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
      || agent.status === "pending"
      || (agent.status === "sleeping"
        && (!agent.sleptAt || now - agent.sleptAt <= AGENT_WIDGET_SLEEP_HIDE_MS))
  );
}

export function settleAgent(
  state: TeammateState,
  correlationId: string,
  exitCode: number,
  lastResult?: string,
): void {
  if (exitCode === 0) retireAgent(state, correlationId, lastResult);
  else killAgent(state, correlationId);
}

export function resolveAgentCorrelationId(
  state: TeammateState,
  target: string,
): string | undefined {
  const named = state.namedAgents.get(target);
  if (named) return named;
  if (state.activeRuns.has(target)) return target;
  const matches = [...state.activeRuns.keys()].filter((correlationId) => correlationId.startsWith(target));
  return matches.length === 1 ? matches[0] : undefined;
}

function killAgent(
  state: TeammateState,
  correlationId: string,
  name?: string,
): void {
  const agent = state.activeRuns.get(correlationId);
  if (!agent) return;
  agent.abortController.abort();
  releaseAgentMemory(agent);
  agent.status = "completed";
  state.activeRuns.delete(correlationId);
  if (name) state.namedAgents.delete(name);
  for (const [agentName, id] of state.namedAgents) {
    if (id === correlationId) state.namedAgents.delete(agentName);
  }
}

function agentActiveMs(a: ActiveAgent): number {
  const total = Date.now() - a.startedAt;
  const sleeping = a.sleptAt ? Date.now() - a.sleptAt : 0;
  return total - a.sleepMs - sleeping;
}

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

function releaseAgentMemory(agent: ActiveAgent): void {
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

interface RelayedQuestionOption {
  label: string;
  description?: string;
}

interface RelayedQuestion {
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
    pi.sendMessage({
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
      result = await showRelayedPermission(ctx, agentLabel, payload);
    } else {
      result = await showRelayedQuestions(ctx, agentLabel, payload);
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
    isInteraction: true,
  });
  replyInteraction(reply, requestId, result);
}

export async function handleChildRpcUiRequest(
  event: Record<string, unknown>,
  reply: (msg: unknown) => void,
  ctx: ExtensionContext | null | undefined,
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
    const value = await ctx.ui.select(String(event.title ?? "Select"), options);
    reply(value === undefined
      ? { type: "extension_ui_response", id, cancelled: true }
      : { type: "extension_ui_response", id, value });
    return;
  }
  if (method === "confirm") {
    const confirmed = await ctx.ui.confirm(String(event.title ?? "Confirm"), String(event.message ?? ""));
    reply({ type: "extension_ui_response", id, confirmed });
    return;
  }
  if (method === "input" || method === "editor") {
    const value = method === "editor"
      ? await ctx.ui.editor(String(event.title ?? "Edit"), typeof event.prefill === "string" ? event.prefill : undefined)
      : await ctx.ui.input(String(event.title ?? "Input"), typeof event.placeholder === "string" ? event.placeholder : undefined);
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
 * Build the child-request bridge required by direct runTeammate/runGraph users.
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
  let interactionQueue: Promise<void> = Promise.resolve();

  return (event, reply) => {
    if (event.type === "teammate_rpc_ui_request" || event.type === "teammate_interaction_request") {
      interactionQueue = interactionQueue
        .then(() => event.type === "teammate_rpc_ui_request"
          ? handleChildRpcUiRequest(event, reply, ctx)
          : handleChildInteractionRequest(
              pi,
              state,
              event,
              reply,
              ctx,
              options.fallbackCorrelationId,
            ))
        .catch((error) => replyChildRequestFailure(event, reply, error));
      return;
    }

    if (event.type === "teammate_proxy_request") {
      void dispatchRegisteredChildTool(event, reply, state).then((handled) => {
        if (!handled) replyUnavailableDirectProxy(event, reply);
      }).catch((error) => replyProxyFailure(event, reply, error));
    }
  };
}

function replyUnavailableDirectProxy(
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

function replyProxyFailure(
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

function replyChildRequestFailure(
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

async function showRelayedPermission(
  ctx: ExtensionContext,
  agentLabel: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const toolName = typeof payload.toolName === "string" ? payload.toolName : "unknown tool";
  const reason = typeof payload.reason === "string" ? payload.reason : "User approval required.";
  const detail = interactionDetail(payload.input);
  const choice = await ctx.ui.select(
    `@${agentLabel} requests ${toolName}\n\n${detail}\n\n${reason}`,
    ["Allow once", "Always allow", "Deny"],
  );
  if (choice === "Allow once") return { action: "allow_once" };
  if (choice === "Always allow") return { action: "always_allow" };
  return { action: "deny" };
}

async function showRelayedQuestions(
  ctx: ExtensionContext,
  agentLabel: string,
  payload: Record<string, unknown>,
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
      const text = await ctx.ui.input(title, "Enter response");
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
      ? await selectMultiple(ctx, title, normalizedOptions)
      : await selectOne(ctx, title, normalizedOptions);
    if (!selected) return { action: "cancel" };
    answers.push({
      question: question.question,
      ...(question.header ? { header: question.header } : {}),
      selected,
    });
  }
  return { action: "answer", answers };
}

async function selectOne(
  ctx: ExtensionContext,
  title: string,
  options: RelayedQuestionOption[],
): Promise<string[] | undefined> {
  const labels = options.map((option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`);
  const choice = await ctx.ui.select(title, labels);
  const index = choice ? labels.indexOf(choice) : -1;
  return index >= 0 ? [options[index].label] : undefined;
}

async function selectMultiple(
  ctx: ExtensionContext,
  title: string,
  options: RelayedQuestionOption[],
): Promise<string[] | undefined> {
  const selected = new Set<number>();
  while (true) {
    const labels = options.map((option, index) =>
      `${selected.has(index) ? "[x]" : "[ ]"} ${index + 1}. ${option.label}`
    );
    const done = `Done (${selected.size})`;
    const choice = await ctx.ui.select(title, [...labels, done]);
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

function normalizeRelayedQuestion(value: Record<string, unknown>): RelayedQuestion | undefined {
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

function replyInteraction(
  reply: (msg: unknown) => void,
  requestId: string,
  result: Record<string, unknown>,
): void {
  reply({ type: "teammate_interaction_response", requestId, result });
}

function interactionDetail(value: unknown): string {
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

function questionSummary(value: unknown): string {
  if (!Array.isArray(value)) return "No questions";
  return value.filter(isRecord).map((question, index) =>
    `${index + 1}. ${typeof question.question === "string" ? question.question : "Invalid question"}`
  ).join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ===========================================================================
// Flat model: handle proxy requests from child processes
// ===========================================================================

async function dispatchRegisteredChildTool(
  event: Record<string, unknown>,
  reply: (message: unknown) => void,
  state?: TeammateState,
): Promise<boolean> {
  const toolName = typeof event.tool === "string" ? event.tool : "";
  const broker = getTeammateChildToolBroker(toolName);
  if (!broker) return false;
  const correlationId = typeof event.correlationId === "string"
    ? event.correlationId
    : typeof event.parentCid === "string"
      ? event.parentCid
      : "unknown";
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

async function handleProxyRequest(
  pi: ExtensionAPI,
  state: TeammateState,
  event: Record<string, unknown>,
  reply: (msg: unknown) => void,
  spawnedBy?: string,
  modelCapabilities: readonly TeammateModelCapability[] = [],
  onInteraction?: (
    event: Record<string, unknown>,
    reply: (message: unknown) => void,
    correlationId: string,
  ) => void,
): Promise<void> {
  const tool = event.tool as string;
  const requestId = event.requestId as string;
  const params = event.params as Record<string, unknown>;
  const parentCid = (event.parentCid as string | undefined) ?? spawnedBy;

  if (await dispatchRegisteredChildTool(event, reply, state)) return;

  switch (tool) {
    case "teammate": {
      const p = params as RunTeammateParams;
      const cid = randomUUID();

      // Normalize (shared with the root tool execute path)
      const normalization = normalizeTeammateParams(p);
      if (normalization.error) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: normalization.error }],
          isError: true, details: { mode: "single", results: [] },
        }});
        return;
      }
      const normalizedTasks: NormalizedTask[] | null = normalization.tasks;
      const warningPrefix = normalization.warnings.length
        ? normalization.warnings.map((w) => `[warn] ${w}`).join("\n") + "\n\n"
        : "";

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
        });
      });
      const progressSnapshot = (): AgentProgressSnapshot[] =>
        [...progressState.values()].sort((left, right) => left.taskIndex - right.taskIndex);
      const pendingProgressByTask = new Map<number, AgentProgress>();

      const abortCtrl = new AbortController();
      const activeAgent: ActiveAgent = {
        agent: p.agent ?? `graph(${normalizedTasks?.length ?? 0})`,
        name: p.name,
        correlationId: cid,
        startedAt: Date.now(),
        abortController: abortCtrl,
        inbox: [],
        outputLog: [],
        lastActivityAt: Date.now(),
        spawnedBy: parentCid,
        status: "running",
        sleepMs: 0,
        lease: createChildLease(),
        promptSeq: p.task ? 1 : 0,
        ...(normalizedTasks ? { progress: progressSnapshot() } : {}),
      };
      state.activeRuns.set(cid, activeAgent);
      if (p.name) state.namedAgents.set(p.name, cid);
      normalizedTasks?.forEach((task, index) => {
        const childId = taskCorrelationIds[index];
        state.activeRuns.set(childId, {
          agent: task.agent,
          name: task.name,
          correlationId: childId,
          startedAt: Date.now(),
          abortController: abortCtrl,
          inbox: [],
          outputLog: [],
          lastActivityAt: Date.now(),
          spawnedBy: cid,
          status: "pending",
          sleepMs: 0,
          lease: createChildLease(),
          promptSeq: task.task ? 1 : 0,
        });
        if (task.name) state.namedAgents.set(task.name, childId);
      });

      const spawnerAgent = parentCid ? state.activeRuns.get(parentCid) : undefined;
      const spawnerLabel = spawnerAgent?.name ?? spawnerAgent?.agent ?? "proxy";
      pi.sendMessage(
        {
          customType: "teammate-started",
          content: `● @${spawnerLabel} spawned @${p.name ?? p.agent ?? activeAgent.agent}`,
          display: true,
        },
        { triggerTurn: true },
      );
      pi.events.emit(TEAMMATE_STARTED_EVENT, {
        correlationId: cid,
        agent: activeAgent.agent,
        name: p.name,
        spawnedBy: parentCid,
      });

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
          startedAt: new Date(data.startedAt).toISOString(),
          recentTools: data.recentTools,
          toolCount: data.toolCount,
          tokens: data.tokens,
          ...(data.lastMessage
            ? { lastMessage: truncateUtf8Tail(data.lastMessage, AGENT_BUFFER_LIMITS.lastResultBytes) }
            : {}),
          ...(data.status === "completed" || data.status === "failed"
            ? { completedAt: new Date().toISOString() }
            : {}),
        };
        progressState.set(taskIndex, entry);
        activeAgent.lastActivityAt = Date.now();

        const childAgent = state.activeRuns.get(correlationId);
        if (childAgent && childAgent !== activeAgent) {
          childAgent.lastActivityAt = Date.now();
          childAgent.status = data.status === "completed" ? "sleeping" : data.status;
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
      const proxyProgressFlushGate = normalizedTasks
        ? createProgressFlushGate(() => {
            const pending = [...pendingProgressByTask.values()];
            pendingProgressByTask.clear();
            for (const data of pending) processProxyProgress(data);
            activeAgent.progress = progressSnapshot();
          })
        : undefined;

      const runOpts: RunTeammateOptions = {
        baseCwd: state.baseCwd,
        modelCapabilities,
        ...(normalizedTasks ? { taskCorrelationIds } : { correlationId: cid }),
        signal: abortCtrl.signal,
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
          if (target.lease) sendControl({ type: "teammate_lease_update", token: leaseToken(target.lease) });
        },
        onChildEvent: (childEvent) => handleChildLifecycleEvent(state, {
          ...childEvent,
          correlationId: cid,
        }),
        onTurnComplete: (result) => {
          if (result.correlationId !== cid) {
            const lastMessage = result.messages[result.messages.length - 1]?.content;
            settleAgent(state, result.correlationId, result.exitCode, lastMessage);
          }
        },
        onProgress: normalizedTasks
          ? (data) => {
              const taskIndex = data.taskIndex ?? taskCorrelationIds.indexOf(data.correlationId ?? "");
              if (taskIndex < 0) return;
              activeAgent.lastActivityAt = Date.now();
              pendingProgressByTask.set(taskIndex, data);
              proxyProgressFlushGate!.mark(data.status === "completed" || data.status === "failed");
            }
          : undefined,
        onChildRequest: (evt, rep) => {
          if (evt.type === "teammate_interaction_request" || evt.type === "teammate_rpc_ui_request") {
            onInteraction?.(evt, rep, cid);
            return;
          }
          handleProxyRequest(pi, state, evt, rep, cid, modelCapabilities, onInteraction);
        },
      };

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
          const hasError = results.some((r) => r.exitCode !== 0);
          const summaries = results
            .map((r, i) => `[${r.agent}${normalizedTasks![i]?.name ? "/" + normalizedTasks![i].name : ""}] ${r.exitCode === 0 ? "OK" : "FAIL"}: ${r.messages[r.messages.length - 1]?.content ?? "(no output)"}`)
            .join("\n\n");
          results.forEach((result, index) => {
            const current = progressState.get(index);
            progressState.set(index, {
              agent: result.agent,
              ...(normalizedTasks![index]?.name ? { name: normalizedTasks![index].name } : {}),
              correlationId: result.correlationId,
              taskIndex: index,
              dependencies: current?.dependencies ?? [],
              status: result.exitCode === 0 ? "completed" : "failed",
              ...(current?.startedAt ? { startedAt: current.startedAt } : {}),
              completedAt: new Date().toISOString(),
              recentTools: current?.recentTools ?? [],
              toolCount: current?.toolCount ?? 0,
              tokens: result.usage.inputTokens + result.usage.outputTokens,
              lastMessage: result.messages[result.messages.length - 1]?.content ?? "",
            });
          });
          const progress = progressSnapshot();
          activeAgent.progress = progress;
          return {
            resultPayload: {
              content: [{ type: "text", text: warningPrefix + summaries }],
              isError: hasError,
              details: { mode, results, progress },
            },
            summary: summaries,
            exitCode: hasError ? 1 : 0,
            mode,
            results,
            progress,
          };
        }

        const result = await runTeammate(p, runOpts);
        const lastMsg = result.messages[result.messages.length - 1]?.content ?? "(no output)";
        return {
          resultPayload: {
            content: [{ type: "text", text: warningPrefix + lastMsg }],
            isError: result.exitCode !== 0,
            details: { mode: "single", results: [result] },
          },
          summary: lastMsg,
          exitCode: result.exitCode,
          mode: "single" as const,
          results: [result],
          progress: undefined,
        };
      };

      if (p.background === false) {
        try {
          const completed = await executeNested();
          settleAgent(state, cid, completed.exitCode, completed.summary);
          reply({ type: "teammate_proxy_result", requestId, result: completed.resultPayload });
        } catch (error) {
          killAgent(state, cid);
          reply({ type: "teammate_proxy_result", requestId, result: {
            content: [{
              type: "text",
              text: `Nested teammate failed: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
            details: { mode: normalizedTasks ? inferGraphMode(normalizedTasks) : "single", results: [] },
          }});
        }
        return;
      }

      void executeNested().then((completed) => {
        settleAgent(state, cid, completed.exitCode, completed.summary);
        pi.sendMessage(
          {
            customType: "teammate-complete",
            content: completed.summary,
            display: true,
            details: {
              mode: completed.mode,
              results: completed.results,
              ...(completed.progress ? { progress: completed.progress } : {}),
            },
          },
          { triggerTurn: true },
        );
      }).catch((error) => {
        killAgent(state, cid);
        notifyBackgroundFailure(pi, requestId, activeAgent.agent, cid, error);
      });

      const mode = normalizedTasks ? inferGraphMode(normalizedTasks) : "single";
      const runningLabel = p.name ?? p.agent ?? activeAgent.agent;
      reply({ type: "teammate_proxy_result", requestId, result: {
        content: [{
          type: "text",
          text: `${warningPrefix}@${runningLabel} running in background. correlationId=${cid}. Use teammate-list to check status.`,
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

    case "teammate-send": {
      const to = params.to as string;
      const message = (params.message as string | undefined) ?? "";
      const requestedMode = (params.mode as RpcMessageMode) ?? "follow_up";

      if (!message && requestedMode !== "abort") {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: `"message" is required for mode "${requestedMode}".` }],
          isError: true, details: { delivered: false },
        }});
        return;
      }

      const cid = resolveAgentCorrelationId(state, to);
      if (!cid) {
        const available = Array.from(state.namedAgents.keys());
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: `Agent "${to}" not found. ${available.length > 0 ? `Available: ${available.join(", ")}` : "No named agents."}` }],
          isError: true, details: { delivered: false },
        }});
        return;
      }

      const agent = state.activeRuns.get(cid);
      if (!agent?.stdin?.writable) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: `Agent "${to}" is no longer running.` }],
          isError: true, details: { delivered: false },
        }});
        return;
      }
      if (!canChildWrite(agent.lease)) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: `Agent "${to}" is currently owned by ${agent.lease.owner} (${agent.lease.state}).` }],
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
      if (mode === "prompt") agent.promptSeq = (agent.promptSeq ?? 0) + 1;
      if (agent.status === "sleeping" && mode === "prompt") {
        agent.status = "running";
        if (agent.sleptAt) {
          agent.sleepMs += Date.now() - agent.sleptAt;
          agent.sleptAt = undefined;
        }
      }
      const now = Date.now();
      agent.inbox.push({ id: randomUUID(), from: spawnedBy ?? "proxy", to, kind: mode === "abort" ? "notification" : "task", payload: message, timestamp: now });
      agent.outputLog.push(`[${new Date(now).toISOString().slice(11, 19)}] ◀ ${mode}: ${message.slice(0, 100)}`);
      trimAgentBuffers(agent);
      agent.lastActivityAt = now;

      // Notify main session TUI
      const senderAgent = spawnedBy ? state.activeRuns.get(spawnedBy) : undefined;
      const senderLabel = senderAgent?.name ?? senderAgent?.agent ?? "agent";
      pi.sendMessage(
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
      const { entries, text } = buildAgentList(state, view);
      reply({ type: "teammate_proxy_result", requestId, result: {
        content: [{ type: "text", text }], isError: false, details: { agents: entries },
      }});
      return;
    }

    case "teammate-watch": {
      const name = params.name as string;
      const lineCount = (params.lines as number) ?? 20;
      const resolved = resolveWatchTarget(state, name);
      if (!resolved.match) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: resolved.error ?? `Agent "${name}" not found.` }], isError: true, details: { output: [] },
        }});
        return;
      }
      const output = buildWatchOutput(resolved.match, lineCount);
      reply({ type: "teammate_proxy_result", requestId, result: {
        content: [{ type: "text", text: output.join("\n") }], isError: false, details: { output },
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
}
