/**
 * Teammate Extension Entry Point
 *
 * Tools: teammate (dispatch), teammate-send (RPC message injection), teammate-list (status), teammate-wait
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
import { isGuiTeammateToolAllowed, registerGuiTool } from "../shared/gui-registry.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { TeammateParams, TeammateSendParams, TeammateListParams, TeammateWatchParams, TeammateWaitParams } from "./schemas.ts";
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
  ChildAgentCallSnapshot,
  ActiveAgent,
  AgentStatus,
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

export const TEAMMATE_PROMPT_SNIPPET =
  "Dispatch bounded work to discovered teammate roles for parallel, sequential, or specialist execution.";

export const TEAMMATE_PROMPT_GUIDELINES = [
  "Use teammate when work can be split into bounded independent tasks, or when a discovered specialist role materially improves correctness.",
  "Do not use teammate for trivial, tightly coupled, single-step work that is faster to complete directly.",
  "Use teammate tasks for parallel or DAG work; {name} and {name.field} references create dependencies between named tasks, and dependsOn declares ordering without injecting output.",
  "Give every multi-task teammate item a stable unique name so nested work remains traceable and addressable; a {ref} that matches no task name is passed through as literal text.",
  "Set teammate concurrency explicitly for provider-safe fan-out; background defaults to false, so the call waits for results until completion or its foreground timeoutMs window, then moves unfinished work to background without terminating it.",
  'Use teammate with context: "fork" only when the child needs the current conversation history; fresh context is the default, and in multi-task mode prefer per-task fork over a top-level default.',
  "After teammate returns a background acknowledgement (explicit background, manual detach, or elapsed foreground window), normally end the current turn and wait for the automatic teammate-complete notification, which will trigger a new turn with the result.",
  "Do not poll teammate-watch or teammate-list after starting background work; use teammate-watch only for a one-off inspection explicitly needed for debugging or requested by the user.",
  "If the current turn must wait for an already-backgrounded result, call teammate-wait exactly once with the returned name or correlation ID and a bounded timeout; never loop teammate-watch.",
  "Use teammate-send for steering or follow-up while a teammate remains running or wakeable.",
  "Omit model to use teammate task-type model routing; an exact task-level provider/model overrides the top-level model, and the top-level model overrides automatic routing.",
];

function displayMessageForResult(result: SingleResult): string {
  const lastMessage = result.messages.at(-1)?.content ?? "(no output)";
  if (result.exitCode === 0) return lastMessage;

  const schemaDiagnostic = result.messages
    .filter((message) => isStructuredOutputSettlementDiagnostic(message.content))
    .at(-1)?.content;
  const primaryDiagnostics = result.messages
    .filter((message) => message.role === "system" && !isStructuredOutputSettlementDiagnostic(message.content));
  const primaryDiagnostic = primaryDiagnostics
    .find((message) => !message.content.startsWith("Fork requested but parent session file not available"))
    ?.content
    ?? primaryDiagnostics.at(-1)?.content;

  if (primaryDiagnostic && schemaDiagnostic && primaryDiagnostic !== schemaDiagnostic) {
    return `${primaryDiagnostic}\n\nStructured output: ${schemaDiagnostic}`;
  }
  return primaryDiagnostic ?? schemaDiagnostic ?? lastMessage;
}

function summarizeGraphResults(results: readonly SingleResult[], tasks: readonly NormalizedTask[]): string {
  return results
    .map((result, index) => (
      `[${result.agent}${tasks[index]?.name ? `/${tasks[index].name}` : ""}] `
      + `${result.exitCode === 0 ? "OK" : "FAIL"}: ${displayMessageForResult(result)}`
    ))
    .join("\n\n");
}

function aggregateGraphStructuredOutput(
  results: readonly SingleResult[],
  tasks: readonly NormalizedTask[],
): Record<string, unknown> | undefined {
  const structuredOutput: Record<string, unknown> = {};
  results.forEach((result, index) => {
    if (result.structuredOutput !== undefined) {
      structuredOutput[tasks[index]?.name ?? String(index)] = result.structuredOutput;
    }
  });
  return Object.keys(structuredOutput).length > 0 ? structuredOutput : undefined;
}

export type TeammateRuntimeOptions = Pick<
  RunTeammateOptions,
  "spawnChildProcess" | "resultReadyGraceMs" | "foregroundMaxRunMs"
> & {
  /** @internal Observes the real runtime callbacks for public-path lifecycle tests. */
  onRunOptionsCreated?: (options: RunTeammateOptions) => void;
};

export function buildTeammateToolDescription(cwd: string): string {
  return `Dispatch tasks to teammate agents. Teammates run as Pi subprocesses with their own tools and context.

Call form:
  { tasks: [{ prompt: "Inspect auth", agent: "general", taskType: "analysis" }] }

Every dispatch uses a non-empty tasks array. Task-level values override top-level defaults. Tasks that omit agent inherit the top-level agent, then default to "general".
Use {name} or {name.field} in a dependent task's prompt, or dependsOn: ["name"] for ordering without output injection.

Use an exact role name from the Available Teammate Agents section in the active system prompt. Unknown names are rejected.

For background work, wait for the automatic teammate-complete notification. Do not poll teammate-watch or teammate-list; if the current turn must wait, call teammate-wait once with the returned correlation ID.

Configured task-type model routing for ${cwd}:
${formatModelRoutingConfig(cwd, discoverAgents(cwd))}`;
}

const TEAMMATE_SEND_DESCRIPTION = `Send a message to a running or sleeping teammate agent, addressed by name, @name, displayed name#id-prefix, correlation ID, or unique ID prefix.

Modes (default: follow_up):
  - "steer" — interrupt the current turn and inject immediately
  - "follow_up" — queue after the current turn completes
  - "abort" — terminate the agent (message optional)`;
const TEAMMATE_SEND_SNIPPET = "Steer, follow up with, or abort a named running teammate agent.";
const TEAMMATE_SEND_GUIDELINES = [
  "Use teammate-send only for a named running or sleeping agent; use follow_up by default, steer for urgent correction, and abort only to terminate work.",
];

const TEAMMATE_LIST_DESCRIPTION = `List available roles or teammate agents. view defaults to "active".

- "active": live agents except completed entries
- "named": addressable named agents
- "all": all tracked live entries
- "roles": builtin, project, and user-defined role definitions`;
const TEAMMATE_LIST_SNIPPET = "List available teammate roles or inspect active and named agent status.";
const TEAMMATE_LIST_GUIDELINES = [
  'Use teammate-list with view="roles" when an available builtin or custom agent name is needed; use active/named/all for running work.',
];

const TEAMMATE_WATCH_DESCRIPTION =
  "Perform a one-shot inspection of a running or sleeping teammate agent's recent output, tool activity, inbox messages, and last result. This is not a completion-wait tool.";
const TEAMMATE_WATCH_SNIPPET = "Inspect a specific teammate agent's recent activity and output.";
const TEAMMATE_WATCH_GUIDELINES = [
  "Use teammate-watch only for a one-off live inspection after selecting an agent name, displayed selector, or correlation ID; never call it repeatedly to wait for completion.",
  "Use teammate-wait once when completion or a result is required, or wait for the automatic teammate-complete notification.",
];
const TEAMMATE_WAIT_DESCRIPTION =
  "Wait once for a teammate result or lifecycle settlement by name, or provide waitMs for a fixed delay. Named waits default to a bounded 10-minute timeout. Agent waits are event-driven and replace repeated teammate-watch calls.";
const TEAMMATE_WAIT_SNIPPET = "Wait once for a teammate result or for a bounded delay.";
const TEAMMATE_WAIT_GUIDELINES = [
  "Call teammate-wait exactly once with a returned name or correlation ID and a bounded timeout instead of repeatedly calling teammate-watch.",
  "Treat result-ready as a usable teammate result; do not continue waiting only for agent_end lifecycle confirmation.",
];

const TEAMMATE_DEPTH_START_MARKER = "<teammate_nesting_context>";
const TEAMMATE_DEPTH_END_MARKER = "</teammate_nesting_context>";

function appendTeammateDepthContext(systemPrompt: string, depth: number): string {
  const current = Math.max(0, Math.min(MAX_DEFAULT_DEPTH, depth));
  const remaining = Math.max(0, MAX_DEFAULT_DEPTH - current);
  const role = current === 0 ? "main agent" : "teammate agent";
  const dispatchGuidance = remaining === 0
    ? "This is the terminal teammate level. The teammate dispatch tool is intentionally unavailable; complete the assigned work directly and do not attempt further delegation."
    : `You may delegate through the teammate tool for ${remaining} more level${remaining === 1 ? "" : "s"}.`;
  const depthContext = [
    TEAMMATE_DEPTH_START_MARKER,
    "# Teammate Nesting Context",
    `You are the ${role} at depth ${current}/${MAX_DEFAULT_DEPTH}. Remaining teammate depth: ${remaining}.`,
    dispatchGuidance,
    TEAMMATE_DEPTH_END_MARKER,
  ].join("\n");
  const start = systemPrompt.indexOf(TEAMMATE_DEPTH_START_MARKER);
  const end = systemPrompt.indexOf(TEAMMATE_DEPTH_END_MARKER);
  if (start >= 0 && end >= start) {
    return `${systemPrompt.slice(0, start)}${depthContext}${systemPrompt.slice(end + TEAMMATE_DEPTH_END_MARKER.length)}`;
  }
  return `${systemPrompt}\n\n${depthContext}`;
}

function backgroundWaitGuidance(correlationId: string): string {
  return `correlationId=${correlationId}. Automatic teammate-complete notification will trigger a new turn with the result. Do not poll teammate-watch or teammate-list. If this turn must consume the result, call teammate-wait exactly once with { name: "${correlationId}" }; otherwise end the turn now.`;
}

function foregroundWaitWindowMs(
  tasks: ReadonlyArray<{ timeoutMs?: number }>,
  fallbackMs?: number,
): number | undefined {
  const configured = tasks
    .map((task) => task.timeoutMs)
    .filter((timeout): timeout is number => timeout !== undefined);
  return configured.length > 0 ? Math.min(...configured) : fallbackMs;
}

function createForegroundDeadline(timeoutMs?: number): {
  promise: Promise<"timeout">;
  dispose(): void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = timeoutMs === undefined
    ? new Promise<"timeout">(() => {})
    : new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
  return {
    promise,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

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
export const TEAMMATE_STALL_TIMEOUT_MS = 30_000;

/**
 * Stall ceiling for queued work. A `pending` graph task is waiting on a
 * dependency or a concurrency slot, which is expected — it just must not wait
 * without any ceiling at all.
 */
export const TEAMMATE_PENDING_STALL_TIMEOUT_MS = 5 * 60_000;

/** Lower bound on teammate-wait re-poll spacing. */
export const TEAMMATE_WAIT_POLL_FLOOR_MS = 250;

/**
 * Backstop for `teammate-wait` calls that omit `timeoutMs`. The tool's own
 * description tells callers to pass a bounded timeout, but an unbounded wait
 * must still terminate on its own.
 */
export const TEAMMATE_WAIT_DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * Ceiling on how long one relayed permission/question may hold a child agent
 * before it is answered on the child's behalf. The terminal is a single shared
 * resource, so these requests are answered one at a time; without a ceiling one
 * unattended prompt stalls every other agent queued behind it, and any parent
 * waiting on those agents stalls with them.
 */
export const TEAMMATE_INTERACTION_TIMEOUT_MS = 5 * 60_000;

/**
 * Ceiling on queued relayed interactions. Past this the queue is answering
 * slower than agents are asking, so newcomers are declined immediately rather
 * than joining a line they would time out in anyway.
 */
export const TEAMMATE_INTERACTION_QUEUE_LIMIT = 16;

export const WAKEABLE_AGENT_BUDGET = Object.freeze({
  maxSleepingAgents: 12,
  anonymousTtlMs: 15 * 60_000,
  namedTtlMs: 60 * 60_000,
});

const AGENT_WIDGET_IDLE_HIDE_MS = 60_000;
const COCKPIT_UI_OWNERSHIP_EVENT = "cockpit:ui-ownership";

/**
 * Appends one marker-prefixed activity line to an agent's log. Shared so the
 * single-task and graph proxy paths record the same shape; the single-task path
 * previously recorded nothing, leaving `teammate-watch` on a nested agent with
 * only "Waiting for model capacity or first activity…".
 */
function appendAgentProgressLine(
  agent: ActiveAgent,
  data: AgentProgress,
  correlationId: string,
): void {
  const lastLine = data.lastMessage?.split("\n").pop()?.trim();
  if (!lastLine) return;
  const shortId = correlationId.slice(0, 8);
  const marker = data.name ? `@${data.name}#${shortId}` : `${data.agent}#${shortId}`;
  agent.outputLog.push(
    truncateUtf8Tail(`${marker} │ ${lastLine}`, AGENT_BUFFER_LIMITS.logLineBytes),
  );
  trimAgentBuffers(agent);
}

/** Agents that still hold (or are about to hold) a child process. */
const LIVE_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  "pending",
  "running",
  "retrying",
  "sleeping",
]);

/**
 * Bounds the whole dispatch tree, not a single call. `maxAgents` caps one
 * dispatch's task count, so nesting multiplies rather than adds: without this
 * gate a depth-3 tree of 15-task graphs reaches 15^3 child processes.
 */
export function checkActiveAgentBudget(
  state: TeammateState,
  additional = 1,
): { allowed: boolean; active: number; max: number } {
  let active = 0;
  for (const agent of state.activeRuns.values()) {
    if (LIVE_AGENT_STATUSES.has(agent.status)) active += 1;
  }
  const max = resolveMaxActiveAgents();
  return { allowed: active + additional <= max, active, max };
}

/**
 * Whether a log is provably within every limit, using a byte upper bound rather
 * than encoding. False means "trim to be sure", never "definitely over".
 */
function logNeedsNoTrim(lines: readonly string[], lineLimit: number): boolean {
  if (lines.length > lineLimit) return false;
  let upperBound = 0;
  for (const line of lines) {
    if (typeof line !== "string") return false;
    const lineUpperBound = line.length * 3;
    if (lineUpperBound > AGENT_BUFFER_LIMITS.logLineBytes) return false;
    upperBound += lineUpperBound;
    if (upperBound > AGENT_BUFFER_LIMITS.logBytes) return false;
  }
  return true;
}

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
  // This runs on every progress flush, and almost every call has nothing to
  // trim — yet it rebuilt the array and re-encoded every retained line to find
  // that out. A UTF-16 unit encodes to at most 3 UTF-8 bytes, so `length * 3`
  // is a sound upper bound that costs O(1) per line instead of a full scan.
  if (logNeedsNoTrim(agent.outputLog, lineLimit)) {
    if (agent.lastResult !== undefined) {
      agent.lastResult = truncateUtf8Tail(agent.lastResult, AGENT_BUFFER_LIMITS.lastResultBytes);
    }
    return;
  }
  let logBytes = 0;
  const retainedLog: string[] = [];
  for (let index = agent.outputLog.length - 1; index >= 0 && retainedLog.length < lineLimit; index -= 1) {
    const existingLine = agent.outputLog[index];
    if (typeof existingLine !== "string") continue;
    const line = truncateUtf8Tail(existingLine, AGENT_BUFFER_LIMITS.logLineBytes);
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
  parentCorrelationId?: string;
  label: string;
  agent: string;
  status: AgentProgressSnapshot["status"] | "sleeping";
  action: string;
  direction: "↑" | "↓";
  toolCount: number;
  tokens: number;
  inputTokens?: number;
  outputTokens?: number;
  startedAt: number;
  durationMs: number;
  lastActivityAt: number;
  resultReadyAt?: number;
  parentLabel?: string;
  resultLabels?: string[];
}

export interface AgentSelectorRow {
  correlationId: string;
  agent: string;
  name?: string;
  label: string;
  parentLabel?: string;
  status: ActiveAgent["status"];
  startedAt: number;
  depth: number;
  treePrefix: string;
  recentTools: Array<{ name: string; status: string }>;
  lastMessage?: string;
}

/** Walks `spawnedBy` to the top of an agent's dispatch tree. */
export function rootDispatchAncestor(state: TeammateState, correlationId: string): string {
  const seen = new Set<string>();
  let cursor = correlationId;
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const parent = state.activeRuns.get(cursor)?.spawnedBy;
    if (!parent || parent === cursor) break;
    cursor = parent;
  }
  return cursor;
}

/**
 * Decides whether a proxied `teammate-send` may act on `targetCid`.
 *
 * A nested agent could name any agent in the process and act on it — including
 * `abort`, which terminates the target's whole subtree. Nothing checked that
 * the two were related, so a depth-2 worker could tear down an unrelated
 * dispatch tree it had no business knowing about.
 *
 * The split is by blast radius. Messaging stays open within the requester's own
 * dispatch tree, because peer coordination between siblings is the normal
 * pattern. Terminating is limited to the requester's own descendants: an agent
 * may dismantle what it built, not what built it or what runs beside it.
 */
export function canProxySendTo(
  state: TeammateState,
  requesterCid: string | undefined,
  targetCid: string,
  mode: RpcMessageMode,
): { allowed: boolean; reason?: string } {
  // No requester means the root tool itself, driven by the user's own model.
  if (!requesterCid) return { allowed: true };
  if (requesterCid === targetCid) return { allowed: true };

  if (mode === "abort") {
    if (isAgentDescendantOf(state, targetCid, requesterCid)) return { allowed: true };
    return {
      allowed: false,
      reason: "only agents you dispatched may be aborted; this one is not in your subtree",
    };
  }

  if (rootDispatchAncestor(state, requesterCid) === rootDispatchAncestor(state, targetCid)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: "that agent belongs to a different dispatch tree",
  };
}

/** Walks `spawnedBy` links up from `descendant`, looking for `ancestor`. */
function isAgentDescendantOf(
  state: TeammateState,
  descendant: string,
  ancestor: string,
): boolean {
  const seen = new Set<string>();
  let cursor: string | undefined = descendant;
  while (cursor && !seen.has(cursor)) {
    if (cursor === ancestor) return true;
    seen.add(cursor);
    cursor = state.activeRuns.get(cursor)?.spawnedBy;
  }
  return false;
}

/**
 * Resolves which agent a proxied request belongs to.
 *
 * A child may legitimately name an id other than the one this process bound to
 * its transport: a graph runs several task children behind a single request
 * handler, so `event.correlationId` is how they tell each other apart. But the
 * id arrives over the wire from the child, and taking it on faith let a child
 * re-parent itself onto any agent it could name — including a shallower one,
 * which resets the depth its own dispatches are measured against and reopens
 * unbounded nesting. So a claim is honoured only when it resolves to an agent
 * inside the spawner's own subtree; otherwise the request is attributed to the
 * spawner this process actually launched.
 */
export function resolveProxyParentCorrelationId(
  event: Record<string, unknown>,
  spawnedBy?: string,
  state?: TeammateState,
): string | undefined {
  const claimed = typeof event.parentCid === "string" ? event.parentCid
    : typeof event.correlationId === "string" ? event.correlationId
      : undefined;
  if (!claimed) return spawnedBy;
  if (!spawnedBy) return claimed;
  if (claimed === spawnedBy) return spawnedBy;
  if (state && isAgentDescendantOf(state, claimed, spawnedBy)) return claimed;
  return spawnedBy;
}

function selectorAgentLabel(agent: ActiveAgent): string {
  if (agent.name) return agent.name;
  const kind = agent.agent.startsWith("graph(") ? "graph" : "unnamed";
  return `${kind}#${agent.correlationId.slice(0, 8)}`;
}

function emitTeammateStarted(
  pi: ExtensionAPI,
  agent: ActiveAgent,
  extra: Record<string, unknown> = {},
): void {
  pi.events.emit(TEAMMATE_STARTED_EVENT, {
    ...extra,
    correlationId: agent.correlationId,
    agent: agent.agent,
    name: agent.name,
    spawnedBy: agent.spawnedBy,
    startedAt: agent.startedAt,
    lastActivityAt: agent.lastActivityAt,
    status: agent.status,
  });
}

/** Reactivate a wakeable child and republish it to lifecycle-only consumers. */
function wakeSleepingAgent(
  pi: ExtensionAPI,
  agent: ActiveAgent,
  now = Date.now(),
): boolean {
  if (agent.status !== "sleeping") return false;
  agent.status = "running";
  if (agent.sleptAt) {
    agent.sleepMs += now - agent.sleptAt;
    agent.sleptAt = undefined;
  }
  agent.lastActivityAt = now;
  emitTeammateStarted(pi, agent);
  return true;
}

export function buildAgentSelectorRows(agents: ActiveAgent[]): AgentSelectorRow[] {
  const visible = agents.filter((agent) => agent.status !== "completed");
  const byId = new Map(visible.map((agent) => [agent.correlationId, agent]));
  const progressById = new Map<string, AgentProgressSnapshot>();
  for (const agent of visible) {
    for (const progress of agent.progress ?? []) {
      progressById.set(progress.correlationId, progress);
    }
  }

  const childrenByParent = new Map<string, ActiveAgent[]>();
  for (const agent of visible) {
    if (!agent.spawnedBy || !byId.has(agent.spawnedBy)) continue;
    const children = childrenByParent.get(agent.spawnedBy) ?? [];
    children.push(agent);
    childrenByParent.set(agent.spawnedBy, children);
  }

  const rows: AgentSelectorRow[] = [];
  const visited = new Set<string>();
  const append = (agent: ActiveAgent, depth: number, prefix: string, isLast: boolean): void => {
    if (visited.has(agent.correlationId)) return;
    visited.add(agent.correlationId);
    const progress = progressById.get(agent.correlationId)
      ?? agent.progress?.find((item) => item.correlationId === agent.correlationId);
    const parent = agent.spawnedBy ? byId.get(agent.spawnedBy) : undefined;
    const logTail = agent.outputLog.at(-1);
    const lastMessage = progress?.lastMessage ?? agent.lastResult ?? logTail;
    rows.push({
      correlationId: agent.correlationId,
      agent: agent.agent,
      ...(agent.name ? { name: agent.name } : {}),
      label: selectorAgentLabel(agent),
      ...(parent ? { parentLabel: selectorAgentLabel(parent) } : {}),
      status: agent.status,
      startedAt: agent.startedAt,
      depth,
      treePrefix: depth === 0 ? "" : `${prefix}${isLast ? "└─ " : "├─ "}`,
      recentTools: progress?.recentTools ?? [],
      ...(lastMessage ? { lastMessage } : {}),
    });

    const children = childrenByParent.get(agent.correlationId) ?? [];
    const childPrefix = depth === 0 ? "" : `${prefix}${isLast ? "   " : "│  "}`;
    children.forEach((child, index) => append(child, depth + 1, childPrefix, index === children.length - 1));
  };

  const roots = visible.filter((agent) => !agent.spawnedBy || !byId.has(agent.spawnedBy));
  roots.forEach((root, index) => append(root, 0, "", index === roots.length - 1));
  // Rescue pass: an agent can be unreachable from every root if its spawnedBy
  // links form a cycle. `visited` makes this a no-op for everything the tree
  // walk already emitted, so it only surfaces what would otherwise vanish.
  visible.forEach((agent, index) => append(agent, 0, "", index === visible.length - 1));
  return rows;
}

export function renderAgentSelectorPanel(
  rows: AgentSelectorRow[],
  cursor: number,
  query: string,
  width: number,
): string[] {
  const dim = (value: string) => `\x1b[2m${value}\x1b[22m`;
  const bold = (value: string) => `\x1b[1m${value}\x1b[22m`;
  const green = (value: string) => `\x1b[32m${value}\x1b[39m`;
  const yellow = (value: string) => `\x1b[33m${value}\x1b[39m`;
  const red = (value: string) => `\x1b[31m${value}\x1b[39m`;
  const w = Math.max(1, Math.min(width, 60));
  const selectedIndex = Math.max(0, Math.min(cursor, Math.max(0, rows.length - 1)));
  const selected = rows[selectedIndex];
  const statusView = (row: AgentSelectorRow): { icon: string; text: string } => {
    if (row.status === "sleeping") return { icon: yellow("◉"), text: yellow("Sleeping") };
    if (row.status === "failed") return { icon: red("✗"), text: red("Failed") };
    if (row.status === "pending") return { icon: dim("□"), text: dim("Pending") };
    // Retrying fell through to the default and read as a healthy green
    // "Running" — the one state where the agent is not making progress.
    if (row.status === "retrying") return { icon: yellow("↻"), text: yellow("Retrying") };
    return { icon: green("■"), text: green("Running") };
  };

  if (w < 20) {
    if (!selected) return [truncateToWidth(`${dim("□")} no matches`, w, "…")];
    const status = statusView(selected);
    return [truncateToWidth(
      `Esc · ${status.icon} ${selected.agent}/${selected.label} ${dim(selected.status)}`,
      w,
      "…",
    )];
  }

  const inner = w - 2;
  const out: string[] = [];
  const frameLine = (content: string) =>
    dim("│") + truncateToWidth(` ${content}`, inner, "…", true) + dim("│");
  const maxVisible = 5;
  const start = Math.max(0, Math.min(
    Math.max(0, rows.length - maxVisible),
    selectedIndex - Math.floor(maxVisible / 2),
  ));
  const visibleRows = rows.slice(start, start + maxVisible);
  const range = rows.length > maxVisible
    ? dim(` ${start + 1}-${start + visibleRows.length}/${rows.length}`)
    : "";
  const nestedCount = rows.filter((row) => row.depth > 0).length;
  const scope = w >= 46 && rows.length > 0
    ? dim(` · ${rows.length - nestedCount} root · ${nestedCount} nested`)
    : "";

  out.push(dim("╭" + "─".repeat(inner) + "╮"));
  out.push(frameLine(`${green("❯")} ${query}${dim("│")}${range}${scope}`));
  out.push(dim("├" + "─".repeat(inner) + "┤"));

  for (let index = 0; index < visibleRows.length; index++) {
    const absoluteIndex = start + index;
    const row = visibleRows[index];
    const status = statusView(row);
    const up = Math.round((Date.now() - row.startedAt) / 1000);
    const selection = absoluteIndex === selectedIndex ? green("▸") : " ";
    out.push(frameLine(
      `${selection} ${status.icon} ${bold(`${row.treePrefix}${row.agent}/${row.label}`)} ${status.text} ${dim(`${up}s`)}`,
    ));
  }
  if (rows.length === 0) out.push(frameLine(dim("□ no matches · Backspace clears the filter")));

  if (selected) {
    out.push(dim("├" + "─".repeat(inner) + "┤"));
    const lineage = selected.parentLabel ? `child of ${selected.parentLabel}` : "root run";
    out.push(frameLine(`${green("»")} ${bold(`${selected.agent}/${selected.label}`)} ${dim(lineage)}`));
    const recentTool = selected.recentTools.find((tool) => tool.status === "running")
      ?? selected.recentTools.at(-1);
    if (recentTool) {
      const toolIcon = recentTool.status === "running" ? yellow("■") : recentTool.status === "failed" ? red("✗") : dim("✓");
      out.push(frameLine(`${dim("Tool")} ${toolIcon} ${sanitizeSingleLineInput(recentTool.name)}`));
    } else {
      out.push(frameLine(`${dim("Tool")} ${dim("idle")}`));
    }
    const message = selected.lastMessage
      ? sanitizeSingleLineInput(selected.lastMessage.split(/\r?\n/).filter((line) => line.trim()).at(-1) ?? "")
      : "";
    out.push(frameLine(`${dim("│")} ${message || (selected.status === "pending" ? "Waiting for dependencies…" : "Waiting for output…")}`));
  }

  out.push(dim("╰" + "─".repeat(inner) + "╯"));
  const footer = w < 46
    ? " Esc cancel · Enter attach · ↑↓ select"
    : " Esc cancel · Enter attach · ↑↓ select · type to filter";
  out.push(truncateToWidth(dim(footer), w, "…"));
  return out;
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
  const labelFor = (agent: ActiveAgent): string => agent.name ?? agent.agent;
  for (const active of agents) {
    const snapshots = active.progress ?? [];
    const effective = snapshots.length > 1 ? snapshots : [snapshots[0]];
    const snapshotByIndex = new Map(snapshots.map((snapshot) => [snapshot.taskIndex, snapshot]));
    for (const progress of effective) {
      const correlationId = progress?.correlationId ?? active.correlationId;
      const direct = directAgents.get(correlationId);
      const parent = direct?.spawnedBy ? directAgents.get(direct.spawnedBy) : undefined;
      const resultLabels = progress?.dependencies
        .map((dependency) => snapshotByIndex.get(dependency))
        .filter((dependency): dependency is AgentProgressSnapshot => dependency !== undefined)
        .map((dependency) => dependency.name ?? `task ${dependency.taskIndex + 1}`);
      const runningTool = progress?.recentTools?.find((tool) => tool.status === "running");
      const status = direct?.status === "sleeping" || (!direct && active.status === "sleeping")
        ? "sleeping"
        : progress?.status ?? direct?.status ?? active.status;
      const action = runningTool
        ? toolAction(runningTool.name)
        : status === "running" && (progress?.resultReadyAt ?? direct?.resultReadyAt) !== undefined
          ? "result returned; lifecycle pending"
        : status === "sleeping"
          ? "sleeping"
          : status === "retrying"
            ? `retry ${direct?.retry?.attempt ?? "?"}/${direct?.retry?.maxRetries ?? "?"}`
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
          startedAt: direct?.startedAt ?? existing.startedAt,
          ...(direct?.spawnedBy ? { parentCorrelationId: direct.spawnedBy } : {}),
          ...(parent ? { parentLabel: labelFor(parent) } : {}),
        });
        continue;
      }
      rows.set(correlationId, {
        correlationId,
        ...(direct?.spawnedBy ? { parentCorrelationId: direct.spawnedBy } : {}),
        label: progress?.name ?? direct?.name ?? active.name ?? correlationId.slice(0, 8),
        agent: progress?.agent ?? direct?.agent ?? active.agent,
        status,
        action,
        direction: runningTool ? "↓" : "↑",
        toolCount: progress?.toolCount ?? 0,
        tokens: progress?.tokens ?? 0,
        inputTokens: progress?.inputTokens,
        outputTokens: progress?.outputTokens,
        startedAt: direct?.startedAt
          ?? (progress?.startedAt ? new Date(progress.startedAt).getTime() : active.startedAt),
        durationMs: direct
          ? agentActiveMs(direct)
          : progress?.completedAt
            ? progressDurationMs(progress, active)
            : status === "sleeping"
              ? agentActiveMs(active)
              : progress
                ? Math.max(progress.durationMs ?? 0, progressDurationMs(progress, active))
                : agentActiveMs(active),
        lastActivityAt: progress?.lastActivityAt ?? direct?.lastActivityAt ?? active.lastActivityAt,
        ...(status === "running" && (progress?.resultReadyAt ?? direct?.resultReadyAt)
          ? { resultReadyAt: progress?.resultReadyAt ?? direct?.resultReadyAt }
          : {}),
        ...(parent ? { parentLabel: labelFor(parent) } : {}),
        ...(resultLabels?.length ? { resultLabels } : {}),
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
  const activityOrder = (a: AgentWidgetRow, b: AgentWidgetRow): number =>
    b.lastActivityAt - a.lastActivityAt || a.correlationId.localeCompare(b.correlationId);
  const unorderedRows = agentWidgetRows(agents);
  const byId = new Map(unorderedRows.map((row) => [row.correlationId, row]));
  const children = new Map<string, AgentWidgetRow[]>();
  const roots: AgentWidgetRow[] = [];
  for (const row of unorderedRows) {
    const parentId = row.parentCorrelationId;
    if (!parentId || parentId === row.correlationId || !byId.has(parentId)) {
      roots.push(row);
      continue;
    }
    const siblings = children.get(parentId) ?? [];
    siblings.push(row);
    children.set(parentId, siblings);
  }
  roots.sort(activityOrder);
  for (const siblings of children.values()) siblings.sort(activityOrder);
  const rows: AgentWidgetRow[] = [];
  const visited = new Set<string>();
  const append = (row: AgentWidgetRow): void => {
    if (visited.has(row.correlationId)) return;
    visited.add(row.correlationId);
    rows.push(row);
    for (const child of children.get(row.correlationId) ?? []) append(child);
  };
  for (const root of roots) append(root);
  for (const row of [...unorderedRows].sort(activityOrder)) append(row);
  if (rows.length === 0) return [];

  const maxVisible = safeWidth < 20 ? 3 : safeWidth < 40 ? 4 : 6;
  const selected = new Set<string>();
  const liveEdge = rows.find((row) => LIVE_AGENT_STATUSES.has(row.status));
  if (liveEdge) selected.add(liveEdge.correlationId);
  for (const row of rows) {
    if (row.status === "failed" && selected.size < maxVisible) selected.add(row.correlationId);
  }
  for (const row of rows) {
    if (selected.size >= maxVisible) break;
    selected.add(row.correlationId);
  }
  const visible = rows.filter((row) => selected.has(row.correlationId));
  const hidden = rows.length - visible.length;
  const icon = (row: AgentWidgetRow): string => {
    if (row.status === "running") return theme.fg("success", "■");
    if (row.status === "retrying") return theme.fg("warning", "↻");
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
  const retryingCount = rows.filter((row) => row.status === "retrying").length;
  const sleeping = rows.filter((row) => row.status === "sleeping").length;
  const pending = rows.filter((row) => row.status === "pending").length;
  const failedCount = rows.filter((row) => row.status === "failed").length;
  const summary = [
    runningCount ? `${runningCount} running` : "",
    retryingCount ? `${retryingCount} retrying` : "",
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
    const now = Date.now();
    const duration = `${Math.max(0, Math.floor(row.durationMs / 1000))}s`;
    const idleMs = Math.max(0, now - row.lastActivityAt);
    const stalled = row.status === "running" && row.resultReadyAt === undefined && idleMs >= TEAMMATE_STALL_TIMEOUT_MS;
    const state = row.resultReadyAt !== undefined && row.status === "running"
      ? "result returned; lifecycle pending"
      : stalled
      ? `stalled ${Math.floor(idleMs / 1000)}s`
      : row.status === "running"
        ? `running · ${row.action}`
        : row.status === "retrying"
          ? `retrying · ${row.action}`
        : row.action;
    const tokenMetrics = row.inputTokens !== undefined || row.outputTokens !== undefined
      ? [`in ${compactMetric(row.inputTokens ?? 0)}`, `out ${compactMetric(row.outputTokens ?? 0)}`]
      : row.tokens
        ? [`${row.direction} ${compactMetric(row.tokens)} tokens`]
        : [];
    const metrics = [
      duration,
      ...tokenMetrics,
      row.toolCount ? `${row.toolCount} tools` : "",
    ].filter(Boolean).join(" · ");
    const relationship = [
      row.parentLabel ? `child of @${row.parentLabel}` : "",
      row.resultLabels?.length
        ? `result from ${row.resultLabels.map((label) => `@${label}`).join(", ")}`
        : "",
    ].filter(Boolean).join(" · ");
    const relationshipText = relationship ? ` · ${relationship}` : "";
    const agentText = safeWidth < 40 ? "" : ` ${theme.fg("muted", row.agent)}`;
    const rowContent = safeWidth < 40
      ? `${theme.fg("accent", `@${row.label}`)} · ${state} · ${theme.fg("dim", duration)}`
      : `${theme.fg("accent", `@${row.label}`)}${agentText} · ${theme.fg("dim", metrics)} · ${state}${theme.fg("dim", relationshipText)}`;
    lines.push(truncateToWidth(
      `${theme.fg("dim", connector)} ${icon(row)} ${rowContent}`,
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
  const lease = agent.lease;
  const pendingCancel = agent.pendingCancel;
  if (event.type === "teammate_handoff_cancelled"
    && lease?.state === "fenced"
    && pendingCancel
    && pendingCancel?.nonce === event.nonce
    && pendingCancel.fencedEpoch === lease.epoch
  ) {
    agent.lease = recoverChild(lease);
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
    // Giving up locally is not enough: the root already created an agent for
    // this request and is running it. Without telling the root, that agent has
    // no consumer and no one left to settle it — an orphan that outlives the
    // child that asked for it. Best-effort; an older root simply ignores it.
    const notifyRootGaveUp = (reason: "timeout" | "aborted") => {
      try {
        send({ type: "teammate_proxy_cancel", requestId, reason }, () => {});
      } catch {
        // The channel is already gone, which is itself the cancellation.
      }
    };
    const timer = setTimeout(() => {
      notifyRootGaveUp("timeout");
      rejectChildProxyRequest(
        pendingRequests,
        requestId,
        new Error(`Teammate proxy request timed out after ${timeoutMs}ms.`),
      );
    }, timeoutMs);
    const abortHandler = signal
      ? () => {
        notifyRootGaveUp("aborted");
        rejectChildProxyRequest(pendingRequests, requestId, childProxyAbortError());
      }
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

export default function registerTeammateExtension(
  pi: ExtensionAPI,
  runtimeOptions: TeammateRuntimeOptions = {},
): void {
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
  const canDispatchNestedTeammate = !isChild || currentDepth < MAX_DEFAULT_DEPTH;

  // UCL: expose teammate tools to the GUI sidecar via the shared cross-extension
  // registry (globalThis symbol). Each extension owns a distinct registerTool, so
  // this capture is independent of pi-maestro-flow's. Root mode only.
  if (!isChild) {
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
    return { systemPrompt: appendTeammateDepthContext(withAgents, currentDepth) };
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
      const send = process.send;
      if (typeof send !== "function" || process.connected === false) {
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
        (message, callback) => send(message, callback),
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

    const proxyTeammateTool: ToolDefinition<typeof TeammateParams, Details> = {
      name: "teammate",
      label: "Teammate",
      description: buildTeammateToolDescription(process.cwd()),
      promptSnippet: TEAMMATE_PROMPT_SNIPPET,
      promptGuidelines: TEAMMATE_PROMPT_GUIDELINES,
      parameters: TeammateParams,
      async execute(_id: string, params: RunTeammateParams, signal: AbortSignal) {
        return proxyCall<Details>("teammate", params, signal);
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
  const interactionQueue = createTeammateInteractionQueue(pi, state);
  const foregroundToolRuns = new Set<string>();
  state.cancelInteractions = (correlationId, reason) =>
    void interactionQueue.cancelForAgent(correlationId, reason);

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
      const singleTask = normalizedTasks[0];
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
          });
        });
      }

      const progressSnapshot = (): AgentProgressSnapshot[] =>
        [...progressState.values()].sort((a, b) => a.taskIndex - b.taskIndex);

      const correlationId = randomUUID();

      const abortController = new AbortController();

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
        inbox: [],
        outputLog: [],
        lastActivityAt: Date.now(),
        replyTo: params.reply_to,
        // Root-tool dispatches start the tree.
        depth: 0,
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
            abortController,
            inbox: [],
            outputLog: [],
            lastActivityAt: Date.now(),
            spawnedBy: correlationId,
            // Graph tasks belong to their dispatch, so they share its depth;
            // a teammate call made *by* one of them is what advances it.
            depth: activeAgent.depth,
            status: "pending",
            sleepMs: 0,
            lease: createChildLease(),
            promptSeq: 1,
            expectsStructuredOutput: (task.outputSchema ?? params.outputSchema) !== undefined,
          };
          state.activeRuns.set(childId, childAgent);
          if (task.name) bindAgentName(state, task.name, childId);
          emitTeammateStarted(pi, childAgent);
        });
      }

      if (!isMultiTask && singleTask.name) {
        bindAgentName(state, singleTask.name, correlationId);
      }

      emitTeammateStarted(pi, activeAgent, { id });

      const abortForward = () => abortController.abort();
      signal.addEventListener("abort", abortForward, { once: true });

      const parentSessionFile = ctx.sessionManager?.getSessionFile?.() ?? undefined;
      let progressFlushGate: ProgressFlushGate | undefined;

      const makeOptions = (): RunTeammateOptions => {
        const options: RunTeammateOptions = {
          baseCwd: state.baseCwd || ctx.cwd,
          modelCapabilities: refreshModelCatalog(ctx).models,
          ...(isSingle ? { correlationId } : {}),
          ...(isMultiTask ? { taskCorrelationIds } : {}),
          depth: activeAgent.depth,
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
          target.retry = undefined;
          target.resultReadyAt = undefined;
          if (target.lease) sendControl({ type: "teammate_lease_update", token: leaseToken(target.lease) });
          },
          onChildEvent: (event: Record<string, unknown>) => handleChildLifecycleEvent(state, {
            ...event,
            correlationId,
          }),
          onRetry: (retry) => applyAgentRetryState(state, retry),
          onTurnComplete: (result: SingleResult) => {
          const lastMessage = displayMessageForResult(result);
          const settle = isMultiTask ? settleGraphTaskAgent : settleAgent;
          settle(
            state,
            result.correlationId,
            result.exitCode,
            lastMessage,
            result.wakeable !== false,
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
              durationMs: data.durationMs,
              lastActivityAt: data.lastActivityAt,
              resultReadyAt: data.resultReadyAt,
              ...(data.lastMessage
                ? { lastMessage: truncateUtf8Tail(data.lastMessage, AGENT_BUFFER_LIMITS.lastResultBytes) }
                : {}),
              ...(data.status === "completed" || data.status === "failed"
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

            const hasError = results.some((r) => r.exitCode !== 0);
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
                status: lifecyclePending ? "running" : result.exitCode === 0 ? "completed" : "failed",
                ...(current?.startedAt ? { startedAt: current.startedAt } : {}),
                ...(!lifecyclePending ? { completedAt: new Date().toISOString() } : {}),
                recentTools: current?.recentTools ?? [],
                toolCount: current?.toolCount ?? 0,
                tokens: result.usage.inputTokens + result.usage.outputTokens,
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                durationMs: result.durationMs,
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

          const completeGraphInBackground = (
            bgPromise: ReturnType<typeof executeGraph>,
          ): void => {
            void bgPromise.then(({ results, summaries, progress, totalDur }) => {
              const exitCode = results.some((result) => result.exitCode !== 0) ? 1 : 0;
              settleAgent(state, correlationId, exitCode, summaries, params.context !== "fork");
              emitComplete(pi, id, activeGraphMode, correlationId, exitCode, totalDur);

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
              killAgent(state, correlationId, undefined, "failed");
              notifyBackgroundFailure(pi, id, activeGraphMode, correlationId, error);
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
              emitComplete(pi, id, activeGraphMode, correlationId, hasError ? 1 : 0, totalDur);
              settleAgent(state, correlationId, hasError ? 1 : 0, summaries, params.context !== "fork");

              return {
                content: [{ type: "text", text: warningPrefix + summaries }],
                isError: hasError,
                details: {
                  mode: activeGraphMode,
                  results,
                  progress,
                  ...(structuredOutput !== undefined ? { structuredOutput } : {}),
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
            emitComplete(pi, id, agentLabel, correlationId, result.exitCode, result.durationMs);
            const lastMessage = displayMessageForResult(result);
            if (!result.lifecyclePending) {
              settleAgent(state, correlationId, result.exitCode, lastMessage, result.wakeable !== false);
            }
            const details: Details = { mode: "single", results: [result] };
            if (result.structuredOutput !== undefined) {
              details.structuredOutput = result.structuredOutput;
            }
            return {
              content: [{ type: "text", text: warningPrefix + lastMessage }],
              isError: result.exitCode !== 0,
              details,
            };
          }

          // Manual and timed detach share the same background completion path.
          detached = true;
          runPromise.then((result) => {
            emitComplete(pi, id, agentLabel, correlationId, result.exitCode, result.durationMs);
            const lastMsg = displayMessageForResult(result);
            if (!result.lifecyclePending) {
              settleAgent(state, correlationId, result.exitCode, lastMsg, result.wakeable !== false);
            }
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
            killAgent(state, correlationId, undefined, "failed");
            notifyBackgroundFailure(pi, id, agentLabel, correlationId, error);
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
          emitComplete(pi, id, agentLabel, correlationId, result.exitCode, result.durationMs);
          const lastMsg = displayMessageForResult(result);
          if (!result.lifecyclePending) {
            settleAgent(state, correlationId, result.exitCode, lastMsg, result.wakeable !== false);
          }

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
          killAgent(state, correlationId, undefined, "failed");
          notifyBackgroundFailure(pi, id, agentLabel, correlationId, error);
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
          if (agent?.status === "running") {
            // Its result already went back to the caller, so the run is over
            // either way. Without the second branch a result-ready agent stayed
            // `running` for the session: never evictable, never reported done.
            if (agent.resultReadyAt === undefined) killAgent(state, correlationId, undefined, "failed");
            else retireAgent(state, correlationId, agent.lastResult);
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
        return {
          content: [{
            type: "text",
            text: `Agent "${params.to}" aborted; terminated ${terminated.length} agent${terminated.length === 1 ? "" : "s"} in its subtree.`,
          }],
          isError: false,
          details: { delivered: true },
        };
      }
      if (!agent?.stdin?.writable) {
        state.namedAgents.delete(params.to);
        return {
          content: [{ type: "text", text: `Agent "${params.to}" is no longer running.` }],
          isError: true,
          details: { delivered: false },
        };
      }

      const writableLease = agent.lease;
      if (!writableLease || !canChildWrite(writableLease)) {
        const ownership = writableLease
          ? `${writableLease.owner} (${writableLease.state})`
          : "an unavailable lease";
        return {
          content: [{ type: "text", text: `Agent "${params.to}" is currently owned by ${ownership}.` }],
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

      const now = Date.now();
      if (mode === "prompt") agent.promptSeq = (agent.promptSeq ?? 0) + 1;
      const wasSleeping = mode !== "abort" && wakeSleepingAgent(pi, agent, now);
      agent.inbox.push({ id: randomUUID(), from: "caller", to: params.to, kind: mode === "abort" ? "notification" : "task", payload: message, timestamp: now });
      agent.outputLog.push(`[${new Date(now).toISOString().slice(11, 19)}] ◀ ${mode}: ${message.slice(0, 100)}`);
      trimAgentBuffers(agent);
      agent.lastActivityAt = now;

      pi.events.emit(TEAMMATE_MESSAGE_EVENT, {
        correlationId: cid,
        from: "caller",
        to: params.to,
        mode,
        message,
        lastActivityAt: now,
        isSend: true,
      });

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
    ): Promise<TeammateToolResult<{ output: string[] }>> {
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
      const result = await waitForTeammate(state, params, signal);
      return {
        content: [{ type: "text", text: result.output.join("\n") }],
        isError: result.status === "not-found" || result.status === "stalled" || result.status === "timeout" || result.status === "aborted",
        details: { status: result.status, output: result.output },
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
  pi.registerTool(waitTool);

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
      // exactly where it stays reachable until reclaimed.
      reclaimResultReadyAgents(state);
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
    cockpitOwnsAgents = (payload as { agents?: unknown }).agents === true;
    updateAgentWidget();
  });
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
  /** Set once a consumable result exists but the process has not settled. */
  resultReadyAt?: number;
  /** Relayed permission/question requests this agent is blocked on. */
  pendingInteractions?: number;
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
        status: progress.status,
        taskIndex: progress.taskIndex,
        dependencies: progress.dependencies,
        toolCount: progress.toolCount,
        tokens: progress.tokens,
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

interface AgentTargetSelector {
  value: string;
  decorated?: { name: string; idPrefix: string };
}

function parseAgentTargetSelector(target: string): AgentTargetSelector {
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

interface PendingTeammateWaiter {
  resolve: (result: TeammateWaitResult) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

const teammateWaiters = new WeakMap<TeammateState, Map<string, Set<PendingTeammateWaiter>>>();

function waitOutput(status: TeammateWaitStatus, target?: string): string[] {
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

function clearWaiter(waiters: Set<PendingTeammateWaiter>, waiter: PendingTeammateWaiter): void {
  waiters.delete(waiter);
  if (waiter.timer) clearTimeout(waiter.timer);
  if (waiter.signal && waiter.abortHandler) waiter.signal.removeEventListener("abort", waiter.abortHandler);
}

function settleTeammateWaiters(
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
function claimResultReadyNotice(state: TeammateState | undefined, correlationId: string): boolean {
  if (!state) return true;
  const notified = state.resultReadyNotified ??= new Set<string>();
  if (notified.has(correlationId)) return false;
  notified.add(correlationId);
  return true;
}

function statusForWatchTarget(
  target: WatchTarget,
  now = Date.now(),
  state?: TeammateState,
): Extract<TeammateWaitStatus, "completed" | "failed" | "result-ready" | "stalled"> | undefined {
  const status = target.kind === "agent" ? target.agent.status : target.progress.status;
  if (status === "sleeping" || status === "completed") return "completed";
  if (status === "failed") return "failed";
  const resultReadyAt = target.kind === "agent" ? target.agent.resultReadyAt : target.progress.resultReadyAt;
  const targetCid = target.kind === "agent" ? target.agent.correlationId : target.progress.correlationId;
  if (resultReadyAt !== undefined && claimResultReadyNotice(state, targetCid)) return "result-ready";
  // An agent blocked on a relayed permission or question is waiting on a human,
  // not stalled. Reporting it as stalled told callers to terminate a healthy
  // agent; the wait's own timeout remains the backstop.
  if (target.kind === "agent" && (target.agent.pendingInteractions?.size ?? 0) > 0) return undefined;
  const lastActivityAt = target.kind === "agent"
    ? target.agent.lastActivityAt
    : target.progress.lastActivityAt ?? target.agent.lastActivityAt;
  // Every non-terminal status needs a stall ceiling, not just `running`. Graph
  // tasks sit in `pending` until a concurrency slot frees up and stop
  // refreshing lastActivityAt, so a `running`-only check left them with no
  // terminating condition at all — the waiter then rescheduled forever.
  // Queued work gets a longer ceiling: waiting on a dependency is expected.
  const idleCeiling = status === "pending"
    ? TEAMMATE_PENDING_STALL_TIMEOUT_MS
    : TEAMMATE_STALL_TIMEOUT_MS;
  if (now - lastActivityAt >= idleCeiling) return "stalled";
  return undefined;
}

function waitDelayForWatchTarget(target: WatchTarget, timeoutAt: number | undefined): number {
  const lastActivityAt = target.kind === "agent"
    ? target.agent.lastActivityAt
    : target.progress.lastActivityAt ?? target.agent.lastActivityAt;
  const stalledAt = lastActivityAt + TEAMMATE_STALL_TIMEOUT_MS;
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
        status: settledRecord.status === "failed" ? "failed" : "completed",
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
    const finish = (status: "completed" | "failed" | "result-ready" | "stalled" | "timeout" | "aborted") => {
      clearWaiter(waiters, waiter);
      if (waiters.size === 0) byAgent.delete(correlationId);
      const output = status === "result-ready" || status === "stalled" || status === "completed" || status === "failed"
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
      waiter.timer = setTimeout(check, waitDelayForWatchTarget(resolved.match!, timeoutAt));
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
  const message =
    `Background teammate failed (agent=${agent}, correlationId=${correlationId}, phase=background-promise): `
    + `${error instanceof Error ? error.message : String(error)}`;
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

function clearAgentResultReadyState(state: TeammateState, correlationId: string): void {
  const agent = state.activeRuns.get(correlationId);
  if (agent) agent.resultReadyAt = undefined;
  for (const parent of state.activeRuns.values()) {
    const progress = parent.progress?.find((item) => item.correlationId === correlationId);
    if (progress) progress.resultReadyAt = undefined;
  }
  // Clearing the flag re-arms the edge: a later result becomes reportable again.
  state.resultReadyNotified?.delete(correlationId);
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
    recordSettledAgent(state, agent, "terminated");
    releaseAgentMemory(agent);
    agent.status = "completed";
    settleTeammateWaiters(state, agent.correlationId, "terminated");
  }
  for (const id of ids) state.activeRuns.delete(id);
  for (const [name, id] of state.namedAgents) {
    if (ids.has(id)) state.namedAgents.delete(name);
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

export function settleAgent(
  state: TeammateState,
  correlationId: string,
  exitCode: number,
  lastResult?: string,
  wakeable = true,
): void {
  settleAgentLifecycle(state, correlationId, exitCode, lastResult, wakeable, true);
}

function settleGraphTaskAgent(
  state: TeammateState,
  correlationId: string,
  exitCode: number,
  lastResult?: string,
  wakeable = true,
): void {
  // graph task 与容器共享 controller；task 自然结算只收敛自身状态，
  // cohort cancellation 仍由 graph 容器或显式 killAgentTree 拥有。
  settleAgentLifecycle(state, correlationId, exitCode, lastResult, wakeable, false);
}

function settleAgentLifecycle(
  state: TeammateState,
  correlationId: string,
  exitCode: number,
  lastResult: string | undefined,
  wakeable: boolean,
  abortProcess: boolean,
): void {
  clearAgentResultReadyState(state, correlationId);
  if (exitCode !== 0) {
    killAgent(state, correlationId, undefined, "failed", abortProcess);
    return;
  }
  if (wakeable) {
    retireAgent(state, correlationId, lastResult);
    return;
  }
  // Succeeded, but not wakeable — a fork hands its session to the parent and
  // has nothing left to wake. It was folded into the failure branch, which
  // resolved its waiters as `failed`; harmless while failure was invisible,
  // and a red ✗ on a successful run now that it is not.
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

function killAgent(
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

function removeAgentFromRegistry(
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
    const controllers = new Set(
      [...selected]
        .map((id) => state.activeRuns.get(id)?.abortController)
        .filter((controller): controller is AbortController => controller !== undefined),
    );
    for (const agent of state.activeRuns.values()) {
      if (
        selected.has(agent.correlationId)
        || (agent.spawnedBy && selected.has(agent.spawnedBy))
        || controllers.has(agent.abortController)
      ) {
        if (!selected.has(agent.correlationId)) {
          selected.add(agent.correlationId);
          changed = true;
        }
      }
    }
  }

  const controllers = new Set<AbortController>();
  for (const id of selected) {
    const agent = state.activeRuns.get(id);
    if (agent) controllers.add(agent.abortController);
  }
  for (const controller of controllers) controller.abort();
  for (const id of selected) {
    const agent = state.activeRuns.get(id);
    if (!agent) continue;
    releaseAgentMemory(agent);
    agent.status = "completed";
    settleTeammateWaiters(state, id, "terminated");
    state.activeRuns.delete(id);
  }
  for (const [agentName, id] of state.namedAgents) {
    if (selected.has(id)) state.namedAgents.delete(agentName);
  }
  return [...selected];
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
    ...(agent ? { lastActivityAt: agent.lastActivityAt } : {}),
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
    // The handler keeps the terminal until the human dismisses it, so a timeout
    // cannot revoke the prompt — it only stops the child from waiting on it.
    // Hence reply-once rather than abort.
    const guardedReply = (msg: unknown): void => {
      if (settled) return;
      settled = true;
      waiting.delete(key);
      reply(msg);
    };
    const settle = (reason: string): void => {
      if (settled) return;
      const correlationId = correlationFor(event, fallbackCorrelationId);
      const agent = correlationId ? state.activeRuns.get(correlationId) : undefined;
      agent?.pendingInteractions?.delete(key);
      settled = true;
      waiting.delete(key);
      replyChildRequestFailure(event, reply, new Error(reason));
    };
    waiting.set(key, { correlationId: correlationFor(event, fallbackCorrelationId), settle });

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
        if (event.type === "teammate_rpc_ui_request") {
          await handleChildRpcUiRequest(event, guardedReply, ctx);
        } else {
          await handleChildInteractionRequest(
            pi,
            state,
            event,
            guardedReply,
            ctx,
            fallbackCorrelationId,
          );
        }
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
    let text: string | undefined;
    if (selected.includes("None of the above")) {
      const custom = await ctx.ui.input(title, "What would you like instead? (optional)");
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
  const cid = state.proxyDispatchByRequest?.get(requestId);
  if (!cid) return [];
  state.proxyDispatchByRequest?.delete(requestId);
  const agent = state.activeRuns.get(cid);
  if (!agent) return [];
  agent.outputLog.push(
    `[${new Date().toISOString().slice(11, 19)}] ✗ cancelled: ${reason}.`,
  );
  return killAgentTree(state, cid);
}

/** Records which agent a proxy request created, so a later give-up can find it. */
function trackProxyDispatch(state: TeammateState, requestId: string, correlationId: string): void {
  (state.proxyDispatchByRequest ??= new Map()).set(requestId, correlationId);
}

/** Parse untrusted child IPC parameters before they enter shared normalization. */
export function parseProxyTeammateParams(
  params: Record<string, unknown>,
): RunTeammateParams | undefined {
  if (!Check(TeammateParams, params)) return undefined;
  return {
    ...params,
    taskType: parseTeammateTaskType(params.taskType),
    thinking: parseThinkingInput(params.thinking),
    outputSchema: parseOutputSchema(params.outputSchema),
    tasks: params.tasks.map((task) => ({
      ...task,
      taskType: parseTeammateTaskType(task.taskType),
      thinking: parseThinkingInput(task.thinking),
      outputSchema: parseOutputSchema(task.outputSchema),
    })),
  };
}

function parseThinkingInput(value: unknown): TeammateThinkingInput | undefined {
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

function parseOutputSchema(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export async function handleProxyRequest(
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
  onChildStatus?: (child: ChildAgentCallSnapshot) => void,
  runtimeOptions: TeammateRuntimeOptions = {},
): Promise<void> {
  const tool = event.tool as string;
  const requestId = event.requestId as string;
  const params = event.params as Record<string, unknown>;
  const parentCid = resolveProxyParentCorrelationId(event, spawnedBy, state);

  if (await dispatchRegisteredChildTool(event, reply, state, parentCid)) return;

  switch (tool) {
    case "teammate": {
      const p = parseProxyTeammateParams(params);
      if (!p) {
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
      const depthCheck = checkDepthGuard(dispatchDepth);
      if (!depthCheck.allowed) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: `Teammate nesting depth exceeded: current=${depthCheck.current}, max=${depthCheck.max}. Prevent recursive fork-bomb.` }],
          isError: true, details: { mode: "single", results: [] },
        }});
        return;
      }

      const budget = checkActiveAgentBudget(state);
      if (!budget.allowed) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: `Teammate agent budget exhausted: ${budget.active} agents are already live (max ${budget.max}). Wait for running agents to settle, or raise the limit via PI_TEAMMATE_MAX_ACTIVE_AGENTS.` }],
          isError: true, details: { mode: "single", results: [] },
        }});
        return;
      }

      const routedParams = applyModelRouting(
        p,
        state.baseCwd || process.cwd(),
        modelCapabilities.map((model) => model.id),
      );

      // Normalize (shared with the root tool execute path). The root process is
      // the routing authority because the child catalog can be stale or scoped.
      const normalization = normalizeTeammateParams(routedParams);
      if (normalization.error) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: normalization.error }],
          isError: true, details: { mode: "single", results: [] },
        }});
        return;
      }
      const allTasks = normalization.tasks;
      const singleTask = allTasks[0];
      const normalizedTasks = normalization.isMultiTask ? allTasks : null;
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
        agent: normalizedTasks ? `graph(${normalizedTasks.length})` : singleTask.agent,
        name: normalizedTasks ? undefined : singleTask.name,
        correlationId: cid,
        startedAt: Date.now(),
        abortController: abortCtrl,
        inbox: [],
        outputLog: [],
        lastActivityAt: Date.now(),
        spawnedBy: parentCid,
        depth: dispatchDepth,
        status: "running",
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
      const reportChildStatus = (
        status: ChildAgentCallSnapshot["status"],
        progress?: AgentProgress,
      ): void => {
        onChildStatus?.({
          agent: activeAgent.agent,
          ...(!normalizedTasks && singleTask.name ? { name: singleTask.name } : {}),
          correlationId: cid,
          ...(parentCid ? { parentCorrelationId: parentCid } : {}),
          ...(parentAgent ? { parentName: parentAgent.name ?? parentAgent.agent } : {}),
          startedAt: activeAgent.startedAt,
          status,
          ...(progress ? {
            durationMs: progress.durationMs,
            lastActivityAt: progress.lastActivityAt,
            resultReadyAt: progress.resultReadyAt,
            recentTools: progress.recentTools,
            inputTokens: progress.inputTokens,
            outputTokens: progress.outputTokens,
            ...(progress.lastMessage ? { lastMessage: truncateUtf8Tail(progress.lastMessage, AGENT_BUFFER_LIMITS.lastResultBytes) } : {}),
          } : {}),
        });
      };

      /**
       * Publishes the same lifecycle event a root dispatch publishes. Nested
       * dispatches never did, so the widget timer, the wakeable budget and the
       * cockpit row all kept treating them as live for the rest of the session.
       */
      const emitNestedComplete = (exitCode: number): void => {
        emitComplete(pi, requestId, activeAgent.agent, cid, exitCode, Date.now() - activeAgent.startedAt);
      };

      reportChildStatus("running");
      normalizedTasks?.forEach((task, index) => {
        const childId = taskCorrelationIds[index];
        const childAgent: ActiveAgent = {
          agent: task.agent,
          name: task.name,
          correlationId: childId,
          startedAt: Date.now(),
          abortController: abortCtrl,
          inbox: [],
          outputLog: [],
          lastActivityAt: Date.now(),
          spawnedBy: cid,
          depth: dispatchDepth,
          status: "pending",
          sleepMs: 0,
          lease: createChildLease(),
          promptSeq: 1,
          expectsStructuredOutput: (task.outputSchema ?? p.outputSchema) !== undefined,
        };
        state.activeRuns.set(childId, childAgent);
        if (task.name) bindAgentName(state, task.name, childId);
        emitTeammateStarted(pi, childAgent);
      });

      const spawnerAgent = parentCid ? state.activeRuns.get(parentCid) : undefined;
      const spawnerLabel = spawnerAgent?.name ?? spawnerAgent?.agent ?? "proxy";
      pi.sendMessage(
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
          startedAt: new Date(data.startedAt).toISOString(),
          recentTools: data.recentTools,
          toolCount: data.toolCount,
          tokens: data.tokens,
          inputTokens: data.inputTokens,
          outputTokens: data.outputTokens,
          durationMs: data.durationMs,
          lastActivityAt: data.lastActivityAt,
          resultReadyAt: data.resultReadyAt,
          ...(data.lastMessage
            ? { lastMessage: truncateUtf8Tail(data.lastMessage, AGENT_BUFFER_LIMITS.lastResultBytes) }
            : {}),
          ...(data.status === "completed" || data.status === "failed"
            ? { completedAt: new Date().toISOString() }
            : {}),
        };
        progressState.set(taskIndex, entry);
        if (data.resultReadyAt !== undefined) {
          applyAgentResultReadyState(state, {
            correlationId: entry.correlationId,
            resultReadyAt: data.resultReadyAt,
          });
        } else {
          clearAgentResultReadyState(state, entry.correlationId);
        }
        activeAgent.lastActivityAt = Date.now();

        const childAgent = state.activeRuns.get(correlationId);
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
      // Aggregate the graph's task progress into one childCall snapshot so the
      // parent sees advancing activity. Without this the parent's record stayed
      // frozen at its initial "running" and every nested graph rendered as
      // stalled 30s after launch.
      const aggregateTaskProgress = (): AgentProgress | undefined => {
        const entries = [...progressState.values()];
        if (entries.length === 0) return undefined;
        const running = entries.find((entry) => entry.status === "running");
        return {
          agent: activeAgent.agent,
          ...(!normalizedTasks && singleTask.name ? { name: singleTask.name } : {}),
          correlationId: cid,
          status: "running",
          recentTools: running?.recentTools ?? [],
          toolCount: entries.reduce((total, entry) => total + (entry.toolCount ?? 0), 0),
          tokens: entries.reduce((total, entry) => total + (entry.tokens ?? 0), 0),
          inputTokens: entries.reduce((total, entry) => total + (entry.inputTokens ?? 0), 0),
          outputTokens: entries.reduce((total, entry) => total + (entry.outputTokens ?? 0), 0),
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
        if (normalizedTasks) {
          for (const data of pending) processProxyProgress(data);
          activeAgent.progress = progressSnapshot();
          reportChildStatus("running", aggregateTaskProgress());
          return;
        }
        const latest = pending[pending.length - 1];
        if (!latest) return;
        reportChildStatus(
          latest.status === "completed" ? "completed" : latest.status === "failed" ? "failed" : "running",
          latest,
        );
      });

      const runOpts: RunTeammateOptions = {
        ...runtimeOptions,
        baseCwd: state.baseCwd,
        modelCapabilities,
        ...(normalizedTasks ? { taskCorrelationIds } : { correlationId: cid }),
        depth: dispatchDepth,
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
          target.retry = undefined;
          target.resultReadyAt = undefined;
          if (target.lease) sendControl({ type: "teammate_lease_update", token: leaseToken(target.lease) });
        },
        onChildEvent: (childEvent) => handleChildLifecycleEvent(state, {
          ...childEvent,
          correlationId: cid,
        }),
        onRetry: (retry) => {
          applyAgentRetryState(state, retry);
          reportChildStatus("retrying");
        },
        onTurnComplete: (result) => {
          const lastMessage = displayMessageForResult(result);
          const settle = normalizedTasks ? settleGraphTaskAgent : settleAgent;
          settle(
            state,
            result.correlationId,
            result.exitCode,
            lastMessage,
            result.wakeable !== false,
          );
          if (result.correlationId === cid) {
            reportChildStatus(result.exitCode === 0 ? "completed" : "failed");
          }
        },
        onProgress: (data) => {
          // Refreshed on every branch. This is the only input to every stall
          // verdict (the status widget, teammate-wait, teammate-list), and the
          // single-task path never wrote it — so the most common nested shape
          // reported itself stalled after 30s of healthy work.
          activeAgent.lastActivityAt = Date.now();

          if (!normalizedTasks) {
            if (data.resultReadyAt !== undefined) {
              applyAgentResultReadyState(state, { correlationId: cid, resultReadyAt: data.resultReadyAt });
            } else {
              clearAgentResultReadyState(state, cid);
            }
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
          if (evt.type === "teammate_interaction_request" || evt.type === "teammate_rpc_ui_request") {
            onInteraction?.(evt, rep, cid);
            return;
          }
          handleProxyRequest(pi, state, evt, rep, cid, modelCapabilities, onInteraction, onChildStatus, runtimeOptions);
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
              status: lifecyclePending ? "running" : result.exitCode === 0 ? "completed" : "failed",
              ...(current?.startedAt ? { startedAt: current.startedAt } : {}),
              ...(!lifecyclePending ? { completedAt: new Date().toISOString() } : {}),
              recentTools: current?.recentTools ?? [],
              toolCount: current?.toolCount ?? 0,
              tokens: result.usage.inputTokens + result.usage.outputTokens,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              durationMs: result.durationMs,
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
              },
            },
            summary: summaries,
            exitCode: hasError ? 1 : 0,
            mode,
            results,
            progress,
            lifecyclePending: false,
          };
        }

        const result = await runSingleTeammate(singleRunParams, runOpts);
        const lastMsg = displayMessageForResult(result);
        return {
          resultPayload: {
            content: [{ type: "text", text: warningPrefix + lastMsg }],
            isError: result.exitCode !== 0,
            details: {
              mode: "single",
              results: [result],
              ...(result.structuredOutput !== undefined ? { structuredOutput: result.structuredOutput } : {}),
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

      // Once the dispatch reaches its own terminal handling, a late cancel must
      // not tear down an agent that already settled (or, worse, an unrelated
      // one that reused the id).
      const untrackDispatch = () => state.proxyDispatchByRequest?.delete(requestId);
      const nestedPromise = executeNested();
      const mode = normalizedTasks ? inferGraphMode(normalizedTasks) : "single";
      const runningLabel = singleTask.name ?? activeAgent.agent;

      const completeNestedInBackground = (): void => {
        void nestedPromise.then((completed) => {
          untrackDispatch();
          if (!completed.lifecyclePending) {
            settleAgent(state, cid, completed.exitCode, completed.summary, p.context !== "fork");
            reportChildStatus(completed.exitCode === 0 ? "completed" : "failed");
            emitNestedComplete(completed.exitCode);
          }
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
          untrackDispatch();
          killAgent(state, cid, undefined, "failed");
          reportChildStatus("failed");
          notifyBackgroundFailure(pi, requestId, activeAgent.agent, cid, error);
        });
      };

      if (p.background === false) {
        const waitMs = foregroundWaitWindowMs(allTasks, runtimeOptions.foregroundMaxRunMs);
        const deadline = createForegroundDeadline(waitMs);
        const race = await Promise.race([
          nestedPromise.then(
            (completed) => ({ status: "completed" as const, completed }),
            (error: unknown) => ({ status: "failed" as const, error }),
          ),
          deadline.promise.then(() => ({ status: "timeout" as const })),
        ]);
        deadline.dispose();

        if (race.status === "failed") {
          untrackDispatch();
          killAgent(state, cid, undefined, "failed");
          reportChildStatus("failed");
          emitNestedComplete(1);
          reply({ type: "teammate_proxy_result", requestId, result: {
            content: [{
              type: "text",
              text: `Nested teammate failed: ${race.error instanceof Error ? race.error.message : String(race.error)}`,
            }],
            isError: true,
            details: { mode, results: [] },
          }});
          return;
        }

        if (race.status === "completed") {
          const completed = race.completed;
          untrackDispatch();
          if (!completed.lifecyclePending) {
            settleAgent(state, cid, completed.exitCode, completed.summary, p.context !== "fork");
            reportChildStatus(completed.exitCode === 0 ? "completed" : "failed");
            emitNestedComplete(completed.exitCode);
          }
          reply({ type: "teammate_proxy_result", requestId, result: completed.resultPayload });
          return;
        }

        completeNestedInBackground();
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{
            type: "text",
            text: `${warningPrefix}@${runningLabel} moved to background after ${waitMs}ms. ${backgroundWaitGuidance(cid)}`,
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

      completeNestedInBackground();
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
      // Without the requester's signal this wait outlived the agent that
      // issued it: cancelling that agent left the poll running to its full
      // timeout with no way to interrupt it.
      const result = await waitForTeammate(
        state,
        {
          name: typeof params.name === "string" ? params.name : undefined,
          timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
          waitMs: typeof params.waitMs === "number" ? params.waitMs : undefined,
        },
        parentCid ? state.activeRuns.get(parentCid)?.abortController.signal : undefined,
      );
      reply({ type: "teammate_proxy_result", requestId, result: {
        content: [{ type: "text", text: result.output.join("\n") }],
        // `stalled` belongs here too: the target stopped reporting, which is
        // the outcome the caller most needs to act on.
        isError: result.status === "not-found"
          || result.status === "timeout"
          || result.status === "aborted"
          || result.status === "stalled",
        details: { status: result.status, output: result.output },
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
      if (!agent?.stdin?.writable) {
        reply({ type: "teammate_proxy_result", requestId, result: {
          content: [{ type: "text", text: `Agent "${to}" is no longer running.` }],
          isError: true, details: { delivered: false },
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
