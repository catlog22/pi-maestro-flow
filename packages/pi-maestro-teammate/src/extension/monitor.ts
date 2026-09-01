/**
 * Teammate monitor — root-mode supervision primitives.
 *
 * Pure context, snapshot, state, barrier, and validation helpers with no
 * dependency on extension/index.ts.
 */

import { hashMonitorWindowSemanticV1 } from "./monitor-window-state.ts";
import {
  remoteWindowCaptureMatches,
  type RemoteWindowCapture,
  type RemoteWindowObserveResult,
} from "../remote/protocol.ts";
import type {
  MonitorWindowAttentionV1,
  MonitorWindowCardV1,
  MonitorWindowIdentityV1,
  MonitorWindowStateV1,
} from "../public/v1/monitor-window-state.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** LLM-callable actions (enter/exit are user-only via /monitor command). */
export type MonitorAction = "status" | "wait";
export type MonitorWaitMode = "all" | "any" | "count";

/** A single target's observed state — compact by design. */
export interface MonitorTargetSnapshot {
  name: string;
  found: boolean;
  error?: string;
  /** Agent status: pending/running/retrying/sleeping/completed/failed */
  agentStatus?: string;
  /** Wait-level status when settled (completed/failed/stalled/result-ready) */
  waitStatus?: string;
  idleSeconds?: number;
  /** One-line summary (last meaningful output line, truncated) */
  summary: string;
  /** Full watch output lines — only populated when verbose is requested */
  detail?: string[];
}

export interface MonitorParams {
  action: MonitorAction;
  targets: string[];
  waitMode?: MonitorWaitMode;
  waitCount?: number;
  timeoutMs?: number;
  lines?: number;
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MONITOR_STATUS_KEY = "teammate-monitor";

export const MONITOR_DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const MONITOR_DEFAULT_LINES = 3;
export const MONITOR_MAX_TARGETS = 15;

/** Status-bar refresh interval while monitor mode is active. */
export const MONITOR_STATUS_REFRESH_MS = 5_000;

export const MONITOR_MODE_CONTEXT_START = "<monitor_mode>";
export const MONITOR_MODE_CONTEXT_END = "</monitor_mode>";

const MONITOR_MODE_CONTEXT = [
  MONITOR_MODE_CONTEXT_START,
  "# Monitor Mode",
  "## Role and authority",
  "This session is the monitor control window. It supervises and coordinates workspace sessions and remote workers under the user's monitoring policy, but delegates all project implementation, file edits, shell commands, and unrelated research to workers. It may manage only Monitor-owned local windows and remote runs; messages in the #control tab set priorities, policy, and intervention instructions rather than turning this control window into an implementation worker.",
  "## Complete-project orchestration",
  "For a complete software project, begin with monitor list and relevant lifecycle list tools to inventory existing work and reuse suitable workers. Never dispatch an undivided project objective directly to implementation. If no decision-complete plan exists, create one read-only planning or technical-lead worker to inspect project knowledge and current code and return requirements, architecture, interfaces, risks, acceptance criteria, and a dependency-aware phase plan. Read its exact completion resource, then bring only genuine product or architecture decisions to the user.",
  "After decisions are locked, execute a phase DAG. Every worker objective must state purpose, owned scope, dependencies, locked interfaces, acceptance criteria, focused verification, and required result resources. Create only runnable workers, parallelize only independent scopes, and keep each shared interface or state machine under one owner until stable. Use explicit phase barriers for dependencies between different windows; never infer dependency completion from timing or message delivery.",
  "At a phase barrier, establish lifecycle state with monitor or observe as appropriate, then read exact completion resources and correlated Flow reports before accepting work; settled windows alone do not prove project success. Reuse still-valid verification evidence, diagnose failed or ambiguous work before retrying, and dispatch integration, review, or verification only after its dependencies pass. The project is ready only when integrated behavior and acceptance criteria are verified. Release or deployment is not implied by implementation: it requires explicit user authorization and a dedicated worker.",
  "## Tool routing",
  "Use workspace-window only for local Pi workers. Create only a required worker; native interactive is the default. provider=herdr requires an already-running local Herdr session, supports interactive presentation only, and never starts or stops the Herdr server. Create already delivers the objective, so do not resend it. Retain the returned exact owner target and completion handle, read settled results through its immutable agent:// resource, and close only windows created by this Monitor; never close discovered external peers.",
  "Use remote-worker targets when a configured SSH target is unknown, create only after handshake and admission, list for Monitor-owned runs, and close with the returned remote:<runId> target. Never treat a remote run as a workspace owner or pass it to workspace-window. Cross-target abort is unavailable; use remote-worker close for owned remote lifecycle cancellation after collecting required results.",
  "Use monitor list/get/wait for normalized attention-first state and single-window waits, retaining each exact target and cursor. Use observe only for raw provider snapshots, turns/todos/diagnose views, or multi-target all/any/count barriers. teammate-list view=windows is compatibility discovery only. teammate-list view=inbox reads persisted messages, receipts, lifecycle transitions, and final results, including closed-worker history; its default horizon is 24h and since accepts an ISO timestamp, a relative duration such as \"7d\", or \"all\". Inbox history is not liveness evidence. teammate-monitor is legacy and must not be used for workspace sessions or remote runs.",
  "Use teammate-send steer for time-sensitive corrections and follow_up for non-urgent work. Each body must carry concrete new information, a correction, an explicitly requested response, or a safety/lifecycle constraint; omit routing boilerplate, routine acknowledgements, and status pings. A queued or accepted receipt proves enqueueing, not model consumption, so never resend it without later target-side injection, reply, or new peer-state evidence that justifies a changed instruction.",
  "Use flow-schedule create then start for durable ordered steps in one existing managed workspace window; use append with afterStepId for later steps. Queued or accepted delivery is not completion: status separates transport, binding, and exact correlated result evidence. todoBinding.requireCompleted and conflictCheck are opt-in and require flow-schedule-todo-binding; capability mismatch intentionally creates no Todo binding and reports gate=none (not negotiated). observe view=todos is display-only, while the exact correlated Flow report remains completion authority and todoOutcome is additional gate evidence. Missing or mismatched evidence, target replacement, or terminal-without-report becomes ambiguous after the default 30-second Todo gate; inspect status before retrying and retry only when duplicate work is acceptable.",
  "## Recurring supervision",
  "Treat a deferred condition followed by an action, such as 'after the other current workspace windows finish, publish a new version', as unattended recurring supervision even without the word 'recurring'. Do not create a loop for one-shot status or a bounded wait. Before recurring supervision, call loop list to reuse or cancel an existing monitoring loop, resolve and freeze the exact current-phase target set with monitor list, and skip loop creation when the condition is already true. Use one bounded prompt loop for the complete phase, never one loop per target and never a shell loop.",
  "A project loop supervises only its frozen phase. When orchestration adds or replaces targets, cancel it and create one new bounded prompt loop rather than widening the old barrier. At each tick, capture the target and cursor set, use monitor list/get for normalized state, compare with prior evidence, and revalidate the exact owner after every await before intervening. Use observe only when raw evidence or a multi-target barrier is specifically required. Intervene only on new stall, drift, or failure evidence, at most once per target per tick.",
  "A loop grants monitoring authority, not new action authorization. When the frozen condition becomes true, revalidate it, confirm no equivalent follow-up was already dispatched, cancel the current loop, and only then delegate an explicitly authorized non-idempotent action exactly once. Cancel the loop when its phase settles or recurring supervision is no longer requested. Release, publish, deploy, and other project mutations always run in an appropriate worker, never in this control window or a shell loop.",
  "## Message timing and exit",
  "Messages arriving during a tool call are queued until the next turn boundary. If a reply is expected, end the turn after observing instead of chaining more tools; the reply is waiting, not lost.",
  "Generic loops are not owned by Monitor mode and /monitor exit does not stop them. Before asking the user to exit, list active loops and cancel monitoring loops, then ask the user to run /monitor exit before unrelated work continues in this session.",
  MONITOR_MODE_CONTEXT_END,
].join("\n");

export function stripMonitorModeContext(systemPrompt: string): string {
  const start = systemPrompt.indexOf(MONITOR_MODE_CONTEXT_START);
  if (start < 0) return systemPrompt;
  const end = systemPrompt.indexOf(MONITOR_MODE_CONTEXT_END, start);
  if (end < 0) return systemPrompt.slice(0, start).trimEnd();
  const before = systemPrompt.slice(0, start).trimEnd();
  const after = systemPrompt.slice(end + MONITOR_MODE_CONTEXT_END.length).trimStart();
  return before && after ? `${before}\n\n${after}` : before || after;
}

export function appendMonitorModeContext(systemPrompt: string): string {
  const start = systemPrompt.indexOf(MONITOR_MODE_CONTEXT_START);
  if (start < 0) return `${systemPrompt}\n\n${MONITOR_MODE_CONTEXT}`;
  const end = systemPrompt.indexOf(MONITOR_MODE_CONTEXT_END, start);
  if (end < 0) return `${systemPrompt.slice(0, start).trimEnd()}\n\n${MONITOR_MODE_CONTEXT}`;
  return `${systemPrompt.slice(0, start).trimEnd()}\n\n${MONITOR_MODE_CONTEXT}${systemPrompt.slice(end + MONITOR_MODE_CONTEXT_END.length)}`;
}

export function applyMonitorModeContext(systemPrompt: string, active: boolean): string {
  return active ? appendMonitorModeContext(systemPrompt) : stripMonitorModeContext(systemPrompt);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Extract active prompt loops from the Flow loop service's event snapshot. */
export function activePromptLoopIdsFromPayload(payload: unknown): string[] | undefined {
  if (!plainObject(payload) || !Array.isArray(payload.jobs)) return undefined;
  const ids = new Set<string>();
  for (const job of payload.jobs) {
    if (!plainObject(job)
      || job.kind !== "prompt"
      || (job.status !== "scheduled" && job.status !== "running")
      || typeof job.id !== "string"
      || !job.id.trim()) continue;
    ids.add(job.id);
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// Status icons (matches shared/agent-status.ts)
// ---------------------------------------------------------------------------

const STATUS_ICONS: Record<string, string> = {
  pending: "□",
  running: "■",
  retrying: "↻",
  sleeping: "◉",
  completed: "✓",
  failed: "✗",
  idle: "▢",
};

export function statusIcon(status?: string): string {
  return STATUS_ICONS[status ?? ""] ?? "?";
}

// ---------------------------------------------------------------------------
// Compact formatting (token-efficient)
// ---------------------------------------------------------------------------

/** One-line-per-target compact format. Default for all output. */
export function formatCompact(targets: MonitorTargetSnapshot[]): string[] {
  return targets.map((t) => {
    if (!t.found) return `✗ ${t.name} not-found`;
    const icon = statusIcon(t.agentStatus);
    const idle = t.idleSeconds !== undefined ? ` ${t.idleSeconds}s` : "";
    const sum = t.summary.length > 60 ? t.summary.slice(0, 57) + "…" : t.summary;
    return `${icon} ${t.name}${idle} ${sum}`.trimEnd();
  });
}

/** Verbose format: compact line + indented detail. Opt-in only. */
export function formatVerbose(targets: MonitorTargetSnapshot[]): string[] {
  const lines: string[] = [];
  for (const t of targets) {
    if (!t.found) {
      lines.push(`✗ ${t.name} not-found${t.error ? ` — ${t.error}` : ""}`);
      continue;
    }
    const icon = statusIcon(t.agentStatus);
    const idle = t.idleSeconds !== undefined ? ` idle ${t.idleSeconds}s` : "";
    lines.push(`${icon} ${t.agentStatus}${idle} @${t.name}`);
    if (t.detail) {
      for (const d of t.detail) lines.push(`  ${d}`);
    } else if (t.summary) {
      lines.push(`  ${t.summary}`);
    }
  }
  return lines;
}

/** Header line: counts only, no per-target detail. */
export function formatHeader(targets: MonitorTargetSnapshot[]): string {
  const found = targets.filter((t) => t.found);
  const active = found.filter((t) => t.agentStatus !== "completed" && t.agentStatus !== "failed" && t.agentStatus !== "sleeping");
  const done = found.filter((t) => t.agentStatus === "completed" || t.agentStatus === "sleeping");
  const failed = found.filter((t) => t.agentStatus === "failed");
  const parts: string[] = [];
  if (active.length) parts.push(`${active.length} active`);
  if (done.length) parts.push(`${done.length} done`);
  if (failed.length) parts.push(`${failed.length} failed`);
  if (!found.length) parts.push("none found");
  return `${targets.length} targets: ${parts.join(" · ")}`;
}

/** Status bar value: ultra-compact, e.g. "MON 2/3 · 45s" */
export function formatStatusBar(targets: MonitorTargetSnapshot[], startedAt: number): string {
  const found = targets.filter((t) => t.found);
  const active = found.filter((t) => t.agentStatus !== "completed" && t.agentStatus !== "failed" && t.agentStatus !== "sleeping");
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  return `MON ${active.length}/${found.length} · ${elapsed}s`;
}


// ---------------------------------------------------------------------------
// Snapshot capture (injected resolver)
// ---------------------------------------------------------------------------

export type TargetResolver = (name: string, lines: number) => MonitorTargetSnapshot;

export function takeSnapshot(resolve: TargetResolver, targets: string[], lines: number): MonitorTargetSnapshot[] {
  return targets.map((name) => resolve(name, lines));
}

function sameTargetSnapshot(
  previous: MonitorTargetSnapshot,
  next: MonitorTargetSnapshot,
): boolean {
  if (previous === next) return true;
  const previousKeys = Object.keys(previous) as Array<keyof MonitorTargetSnapshot>;
  const nextKeys = Object.keys(next) as Array<keyof MonitorTargetSnapshot>;
  return previousKeys.length === nextKeys.length
    && previousKeys.every((key) => Object.is(previous[key], next[key]));
}

function sameMonitorSnapshot(
  previous: MonitorTargetSnapshot[],
  next: MonitorTargetSnapshot[],
): boolean {
  return previous === next
    || (previous.length === next.length
      && previous.every((target, index) => sameTargetSnapshot(target, next[index])));
}


// ---------------------------------------------------------------------------
// Monitor mode state
// ---------------------------------------------------------------------------

export interface MonitorModeState {
  active: boolean;
  targets: string[];
  startedAt: number;
  verbose: boolean;
  timer?: ReturnType<typeof setInterval>;
  lastSnapshot: MonitorTargetSnapshot[];
}

export function createMonitorModeState(): MonitorModeState {
  return { active: false, targets: [], startedAt: 0, verbose: false, lastSnapshot: [] };
}

/**
 * Start the monitor mode background refresh.
 * Calls `onRefresh` every MONITOR_STATUS_REFRESH_MS with the latest snapshot.
 * The timer is unref'd so it never prevents process exit.
 */
export function startMonitorMode(
  modeState: MonitorModeState,
  targets: string[],
  verbose: boolean,
  capture: () => MonitorTargetSnapshot[],
  onRefresh: (snapshot: MonitorTargetSnapshot[]) => void,
): void {
  stopMonitorMode(modeState);
  modeState.active = true;
  modeState.targets = targets;
  modeState.verbose = verbose;
  modeState.startedAt = Date.now();
  modeState.lastSnapshot = capture();
  onRefresh(modeState.lastSnapshot);

  modeState.timer = setInterval(() => {
    const nextSnapshot = capture();
    if (sameMonitorSnapshot(modeState.lastSnapshot, nextSnapshot)) return;
    modeState.lastSnapshot = nextSnapshot;
    onRefresh(nextSnapshot);
  }, MONITOR_STATUS_REFRESH_MS);

  if (modeState.timer && typeof modeState.timer === "object" && "unref" in modeState.timer) {
    (modeState.timer as NodeJS.Timeout).unref();
  }
}

export function stopMonitorMode(modeState: MonitorModeState): void {
  if (modeState.timer !== undefined) {
    clearInterval(modeState.timer);
    modeState.timer = undefined;
  }
  modeState.active = false;
}

// ---------------------------------------------------------------------------
// Barrier wait
// ---------------------------------------------------------------------------

export interface BarrierEntry {
  name: string;
  promise: Promise<{ status: string; output: string[] }>;
}

export interface BarrierSettled {
  name: string;
  status: string;
  output: string[];
}

/**
 * Waits for multiple targets according to the barrier mode.
 * Remaining waits are aborted via the provided AbortController once the
 * condition is met.
 */
export async function barrierWait(
  entries: BarrierEntry[],
  mode: MonitorWaitMode,
  count: number,
  abortController: AbortController,
): Promise<{ settled: BarrierSettled[]; exitReason: string }> {
  const total = entries.length;
  const effectiveCount = mode === "count" ? Math.min(count, total) : mode === "any" ? 1 : total;
  const settled: BarrierSettled[] = [];

  return new Promise((resolve) => {
    let remaining = total;

    const checkCondition = () => {
      if (settled.length >= effectiveCount) {
        abortController.abort();
        const reason = mode === "all"
          ? `all ${total}/${total} settled`
          : mode === "any"
            ? `first of ${total} settled`
            : `${settled.length}/${total} settled (target: ${effectiveCount})`;
        resolve({ settled: [...settled], exitReason: reason });
      }
    };

    for (const entry of entries) {
      entry.promise.then(
        (result) => {
          settled.push({ name: entry.name, status: result.status, output: result.output });
          remaining--;
          checkCondition();
          if (remaining === 0 && settled.length < effectiveCount) {
            resolve({ settled: [...settled], exitReason: `all ${total} settled (target: ${effectiveCount} not reached)` });
          }
        },
        (err) => {
          settled.push({ name: entry.name, status: "error", output: [String(err)] });
          remaining--;
          checkCondition();
          if (remaining === 0 && settled.length < effectiveCount) {
            resolve({ settled: [...settled], exitReason: `all ${total} settled with errors` });
          }
        },
      );
    }

    if (total === 0) {
      resolve({ settled: [], exitReason: "no targets" });
    }
  });
}

/** Compact barrier result — one line per target. */
export function formatBarrierCompact(
  settled: BarrierSettled[],
  exitReason: string,
  durationMs: number,
): string[] {
  const seconds = Math.round(durationMs / 1000);
  const lines = [`BARRIER ${exitReason} · ${seconds}s`];
  for (const s of settled) {
    const icon = s.status === "completed" ? "✓" : s.status === "failed" ? "✗" : "◆";
    const first = s.output.length > 0 ? s.output[0] : "";
    const sum = first.length > 60 ? first.slice(0, 57) + "…" : first;
    lines.push(`${icon} ${s.name} ${s.status} ${sum}`.trimEnd());
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateMonitorParams(params: MonitorParams): string | undefined {
  if (params.targets.length === 0) {
    return "At least one target is required.";
  }
  if (params.targets.length > MONITOR_MAX_TARGETS) {
    return `Too many targets (${params.targets.length}); maximum is ${MONITOR_MAX_TARGETS}.`;
  }
  if (params.action === "wait" && params.waitMode === "count") {
    if (!params.waitCount || params.waitCount < 1) {
      return "waitCount must be >= 1 when waitMode is 'count'.";
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Window-domain Monitor query adapter
// ---------------------------------------------------------------------------

/** The new `monitor` tool is deliberately narrower than the provider-level `observe` tool. */
export type MonitorQueryAction = "list" | "get" | "wait";
export type MonitorQueryDetail = "summary" | "full";
export type MonitorQueryUntil = "change" | "attention" | "settled";

export interface MonitorQueryParams {
  action: MonitorQueryAction;
  target?: string;
  detail?: MonitorQueryDetail;
  cursor?: string;
  until?: MonitorQueryUntil;
  timeoutMs?: number;
}

/** Root Pi session plus one admitted Monitor generation. */
export interface MonitorQueryAuthorityFence {
  rootGeneration: number;
  sessionId: string;
  workspaceId: string;
  sourceId: string;
  monitorGeneration: number;
}

export interface MonitorQueryTimelineEntry {
  at?: number;
  label: string;
  detail?: string;
}

export interface MonitorQueryTimelineGroup {
  group: string;
  entries: readonly MonitorQueryTimelineEntry[];
}

/** Exact address and optional bounded timeline for one card in a captured state. */
export interface MonitorQueryTargetSnapshot {
  target: string;
  aliases?: readonly string[];
  identity: MonitorWindowIdentityV1;
  timeline?: readonly MonitorQueryTimelineGroup[];
}

export interface MonitorQuerySnapshot {
  state: MonitorWindowStateV1;
  targets: readonly MonitorQueryTargetSnapshot[];
}

export interface MonitorQueryDependencies {
  captureAuthority(): MonitorQueryAuthorityFence | undefined;
  isAuthorityCurrent(capture: MonitorQueryAuthorityFence): boolean;
  /**
   * Refresh providers, capture exact endpoints/owners, await facets, then
   * revalidate those exact captures before returning.
   */
  read(capture: MonitorQueryAuthorityFence, signal: AbortSignal): Promise<MonitorQuerySnapshot>;
  /** A wake hint only. The adapter always performs a fresh, fenced read afterward. */
  waitForWake?(capture: MonitorQueryAuthorityFence, timeoutMs: number, signal: AbortSignal): Promise<void>;
}

export interface MonitorRemoteWindowRevalidationTarget {
  endpointId: string;
  target: string;
  startingCapture: RemoteWindowCapture;
}

export interface MonitorRemoteWindowObservation {
  target: MonitorRemoteWindowRevalidationTarget;
  observed: RemoteWindowObserveResult;
}

export interface MonitorRemoteWindowObservationDependencies {
  observe(target: string): Promise<RemoteWindowObserveResult>;
  isCurrent(): boolean;
}

export type MonitorQueryStatus = "ok" | "not-found" | "timeout" | "aborted" | "stale";

export interface MonitorQueryWindow {
  /** Exact address retained from the first fenced snapshot. */
  target: string;
  /** Window-scoped semantic cursor; changes in other windows do not advance it. */
  cursor: string;
  window: MonitorWindowCardV1;
  /** Present only for detail=full and therefore only for get/wait. */
  timeline?: readonly MonitorQueryTimelineGroup[];
}

export interface MonitorQueryResult {
  version: 1;
  action: MonitorQueryAction;
  status: MonitorQueryStatus;
  observedAt: number;
  stateRevision?: string;
  cursor?: string;
  windows: readonly MonitorQueryWindow[];
  attention: readonly MonitorWindowAttentionV1[];
  reason?: string;
}

export const MONITOR_QUERY_DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Node clamps larger one-shot timer delays to 1ms. */
export const MONITOR_QUERY_MAX_TIMEOUT_MS = 2_147_483_647;
export const MONITOR_QUERY_POLL_MS = 250;

/** Aggregate every post-facet SSH observation before final synchronous validation. */
export async function observeMonitorRemoteWindowsForRevalidation(
  targets: readonly MonitorRemoteWindowRevalidationTarget[],
  dependencies: MonitorRemoteWindowObservationDependencies,
): Promise<MonitorRemoteWindowObservation[]> {
  const observations = await Promise.all(targets.map(async (target) => {
    const observed = await dependencies.observe(target.target);
    if (!dependencies.isCurrent()) {
      throw new Error(`Monitor query authority changed during remote window ${target.endpointId} revalidation.`);
    }
    return { target, observed };
  }));
  if (!dependencies.isCurrent()) {
    throw new Error("Monitor query authority changed during remote window revalidation.");
  }
  return observations;
}

/** No remote await may occur between this full capture sweep and reduction. */
export function revalidateMonitorRemoteWindowCaptures(
  observations: readonly MonitorRemoteWindowObservation[],
  capture: (target: string) => RemoteWindowCapture | undefined,
): void {
  for (const { target, observed } of observations) {
    const currentCapture = capture(target.target);
    if (!currentCapture
      || !remoteWindowCaptureMatches(target.startingCapture, observed.capture)
      || !remoteWindowCaptureMatches(target.startingCapture, currentCapture)
      || observed.owner.workspaceId !== target.startingCapture.workspaceId
      || observed.owner.ownerId !== target.startingCapture.ownerId
      || observed.owner.ownerNonce !== target.startingCapture.ownerNonce) {
      throw new Error(`Remote window ${target.endpointId} changed owner during snapshot reduction.`);
    }
  }
}

/**
 * Execute one window-domain Monitor query.
 *
 * Authority is checked before and after every await. Wait captures one exact
 * owner identity from its start snapshot and never silently follows a selector
 * to a replacement owner.
 */
export async function runMonitorQuery(
  params: MonitorQueryParams,
  dependencies: MonitorQueryDependencies,
  signal: AbortSignal,
): Promise<MonitorQueryResult> {
  if (params.timeoutMs !== undefined
    && (!Number.isSafeInteger(params.timeoutMs)
      || params.timeoutMs < 1
      || params.timeoutMs > MONITOR_QUERY_MAX_TIMEOUT_MS)) {
    return emptyMonitorQueryResult(
      params.action,
      "aborted",
      `timeoutMs must be an integer between 1 and ${MONITOR_QUERY_MAX_TIMEOUT_MS}.`,
    );
  }
  const requestStartedAt = Date.now();
  const waitTimeoutMs = params.action === "wait"
    ? (params.timeoutMs ?? MONITOR_QUERY_DEFAULT_TIMEOUT_MS)
    : undefined;
  const deadline = waitTimeoutMs === undefined ? undefined : requestStartedAt + waitTimeoutMs;
  const capture = dependencies.captureAuthority();
  if (!capture) return emptyMonitorQueryResult(params.action, "aborted", "Active root Monitor authority is required.");
  if (signal.aborted) return emptyMonitorQueryResult(params.action, "aborted", abortReason(signal));

  const first = await readFencedMonitorSnapshot(params.action, capture, dependencies, signal, deadline);
  if ("result" in first) return first.result;
  if (params.action === "list") return listMonitorQueryResult(first.snapshot);

  const requested = params.target?.trim();
  if (!requested) return snapshotError(params.action, first.snapshot, "not-found", "A target is required.");
  const initialTarget = resolveMonitorQueryTarget(first.snapshot, requested);
  if (!initialTarget) {
    return snapshotError(params.action, first.snapshot, "not-found", `Monitor window ${JSON.stringify(requested)} was not found.`);
  }
  const initialWindow = windowForTarget(first.snapshot, initialTarget, params.detail === "full");
  if (!initialWindow) return snapshotError(params.action, first.snapshot, "stale", "The exact Monitor window disappeared during the start snapshot.");
  if (params.action === "get") return selectedMonitorQueryResult(params.action, first.snapshot, initialWindow);

  const until = params.until ?? "change";
  const baselineCursor = params.cursor ?? initialWindow.cursor;
  if (waitConditionMet(until, initialWindow, baselineCursor)) {
    return selectedMonitorQueryResult(params.action, first.snapshot, initialWindow);
  }

  const waitDeadline = deadline!;
  let latestSnapshot = first.snapshot;
  let latestWindow = initialWindow;
  while (true) {
    if (signal.aborted) {
      return selectedMonitorQueryResult(params.action, latestSnapshot, latestWindow, "aborted", abortReason(signal));
    }
    const remaining = waitDeadline - Date.now();
    if (remaining <= 0) {
      if (!dependencies.isAuthorityCurrent(capture)) {
        return selectedMonitorQueryResult(params.action, latestSnapshot, latestWindow, "stale", "Root session or Monitor generation changed while waiting.");
      }
      return selectedMonitorQueryResult(params.action, latestSnapshot, latestWindow, "timeout", `No ${until} event before timeout.`);
    }
    try {
      await awaitMonitorQueryOperation(
        (operationSignal) => (dependencies.waitForWake ?? waitForMonitorQueryDelay)(
          capture,
          Math.min(MONITOR_QUERY_POLL_MS, remaining),
          operationSignal,
        ),
        signal,
        waitDeadline,
      );
    } catch (error) {
      if (signal.aborted) {
        return selectedMonitorQueryResult(params.action, latestSnapshot, latestWindow, "aborted", abortReason(signal));
      }
      if (!dependencies.isAuthorityCurrent(capture)) {
        return selectedMonitorQueryResult(params.action, latestSnapshot, latestWindow, "stale", "Root session or Monitor generation changed while waiting.");
      }
      if (error instanceof MonitorQueryDeadlineError) {
        return selectedMonitorQueryResult(params.action, latestSnapshot, latestWindow, "timeout", `No ${until} event before timeout.`);
      }
      return selectedMonitorQueryResult(params.action, latestSnapshot, latestWindow, "aborted", errorMessage(error));
    }
    if (!dependencies.isAuthorityCurrent(capture)) {
      return selectedMonitorQueryResult(params.action, latestSnapshot, latestWindow, "stale", "Root session or Monitor generation changed while waiting.");
    }

    const next = await readFencedMonitorSnapshot(params.action, capture, dependencies, signal, waitDeadline);
    if ("result" in next) {
      const reason = next.result.status === "timeout"
        ? `No ${until} event before timeout.`
        : next.result.reason;
      return selectedMonitorQueryResult(
        params.action,
        latestSnapshot,
        latestWindow,
        next.result.status,
        reason,
      );
    }
    const exact = exactMonitorQueryTarget(next.snapshot, initialTarget.identity);
    const resolved = resolveMonitorQueryTarget(next.snapshot, requested);
    if (!exact || !resolved || !sameMonitorIdentity(resolved.identity, initialTarget.identity)) {
      return selectedMonitorQueryResult(
        params.action,
        latestSnapshot,
        latestWindow,
        "stale",
        "The exact Monitor window owner was replaced or disappeared while waiting.",
      );
    }
    const selected = windowForTarget(next.snapshot, exact, params.detail === "full");
    if (!selected) {
      return selectedMonitorQueryResult(params.action, latestSnapshot, latestWindow, "stale", "The exact Monitor window state became unavailable.");
    }
    latestSnapshot = next.snapshot;
    latestWindow = selected;
    if (waitConditionMet(until, selected, baselineCursor)) {
      return selectedMonitorQueryResult(params.action, next.snapshot, selected);
    }
  }
}

/** Compact model-facing rendering; list never includes per-window timeline content. */
export function formatMonitorQueryResult(result: MonitorQueryResult): string[] {
  if (result.windows.length === 0) {
    return [`MONITOR ${result.action} ${result.status}${result.reason ? ` · ${result.reason}` : ""}`];
  }
  const lines = [`MONITOR ${result.action} ${result.status} · ${result.windows.length} window${result.windows.length === 1 ? "" : "s"}`];
  for (const selected of result.windows) {
    const card = selected.window;
    const label = card.window.name ?? card.window.sessionName ?? selected.target;
    const topAttention = highestAttention(card.attention);
    lines.push([
      topAttention ? severityIcon(topAttention.severity) : "·",
      selected.target,
      label === selected.target ? undefined : label,
      card.window.lifecycle.status,
      `work=${card.work.status}`,
      card.attention.length > 0 ? `attention=${card.attention.length}` : undefined,
    ].filter(Boolean).join(" · "));
    if (selected.timeline) {
      for (const group of selected.timeline) {
        lines.push(`-- ${group.group} --`);
        for (const entry of group.entries) {
          lines.push(`${entry.at === undefined ? "" : `${new Date(entry.at).toISOString()} `}${entry.label}${entry.detail ? ` · ${entry.detail}` : ""}`);
        }
      }
    }
  }
  if (result.reason) lines.push(result.reason);
  return lines;
}

function listMonitorQueryResult(snapshot: MonitorQuerySnapshot): MonitorQueryResult {
  const windows = snapshot.targets.map((target) => windowForTarget(snapshot, target, false))
    .filter((item): item is MonitorQueryWindow => item !== undefined)
    .sort(compareAttentionFirst);
  return {
    version: 1,
    action: "list",
    status: "ok",
    observedAt: snapshot.state.observedAt,
    stateRevision: snapshot.state.revision,
    cursor: snapshot.state.cursor,
    windows,
    attention: windows.flatMap((item) => item.window.attention),
  };
}

function selectedMonitorQueryResult(
  action: MonitorQueryAction,
  snapshot: MonitorQuerySnapshot,
  window: MonitorQueryWindow,
  status: MonitorQueryStatus = "ok",
  reason?: string,
): MonitorQueryResult {
  return {
    version: 1,
    action,
    status,
    observedAt: snapshot.state.observedAt,
    stateRevision: snapshot.state.revision,
    cursor: window.cursor,
    windows: [window],
    attention: window.window.attention,
    ...(reason === undefined ? {} : { reason }),
  };
}

function snapshotError(
  action: MonitorQueryAction,
  snapshot: MonitorQuerySnapshot,
  status: MonitorQueryStatus,
  reason: string,
): MonitorQueryResult {
  return {
    version: 1,
    action,
    status,
    observedAt: snapshot.state.observedAt,
    stateRevision: snapshot.state.revision,
    cursor: snapshot.state.cursor,
    windows: [],
    attention: [],
    reason,
  };
}

function emptyMonitorQueryResult(action: MonitorQueryAction, status: MonitorQueryStatus, reason: string): MonitorQueryResult {
  return { version: 1, action, status, observedAt: Date.now(), windows: [], attention: [], reason };
}

class MonitorQueryDeadlineError extends Error {
  constructor() {
    super("Monitor query deadline elapsed.");
    this.name = "MonitorQueryDeadlineError";
  }
}

function awaitMonitorQueryOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  requestSignal: AbortSignal,
  deadline?: number,
): Promise<T> {
  if (requestSignal.aborted) return Promise.reject(requestSignal.reason ?? new Error("Monitor query aborted."));
  if (deadline !== undefined && deadline <= Date.now()) return Promise.reject(new MonitorQueryDeadlineError());

  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      requestSignal.removeEventListener("abort", onAbort);
    };
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      settle();
    };
    const onAbort = (): void => {
      const reason = requestSignal.reason ?? new Error("Monitor query aborted.");
      controller.abort(reason);
      finish(() => reject(reason));
    };
    requestSignal.addEventListener("abort", onAbort, { once: true });
    if (deadline !== undefined) {
      timer = setTimeout(() => {
        const error = new MonitorQueryDeadlineError();
        controller.abort(error);
        finish(() => reject(error));
      }, Math.max(0, deadline - Date.now()));
    }

    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => {
          if (deadline !== undefined && Date.now() >= deadline) {
            const error = new MonitorQueryDeadlineError();
            controller.abort(error);
            finish(() => reject(error));
            return;
          }
          finish(() => resolve(value));
        },
        (error) => finish(() => reject(error)),
      );
  });
}

async function readFencedMonitorSnapshot(
  action: MonitorQueryAction,
  capture: MonitorQueryAuthorityFence,
  dependencies: MonitorQueryDependencies,
  signal: AbortSignal,
  deadline?: number,
): Promise<{ snapshot: MonitorQuerySnapshot } | { result: MonitorQueryResult }> {
  try {
    const snapshot = await awaitMonitorQueryOperation(
      (operationSignal) => dependencies.read(capture, operationSignal),
      signal,
      deadline,
    );
    if (signal.aborted) return { result: emptyMonitorQueryResult(action, "aborted", abortReason(signal)) };
    if (!dependencies.isAuthorityCurrent(capture)) {
      return { result: emptyMonitorQueryResult(action, "stale", "Root session or Monitor generation changed during snapshot refresh.") };
    }
    validateMonitorQuerySnapshot(snapshot);
    return { snapshot };
  } catch (error) {
    if (signal.aborted) return { result: emptyMonitorQueryResult(action, "aborted", abortReason(signal)) };
    if (!dependencies.isAuthorityCurrent(capture)) {
      return { result: emptyMonitorQueryResult(action, "stale", "Root session or Monitor generation changed during snapshot refresh.") };
    }
    if (error instanceof MonitorQueryDeadlineError) {
      return { result: emptyMonitorQueryResult(action, "timeout", "Monitor snapshot read exceeded the wait deadline.") };
    }
    return { result: emptyMonitorQueryResult(action, "aborted", errorMessage(error)) };
  }
}

function validateMonitorQuerySnapshot(snapshot: MonitorQuerySnapshot): void {
  const identities = new Map(snapshot.state.windows.map((window) => [monitorIdentityKey(window.identity), window]));
  const targets = new Set<string>();
  for (const target of snapshot.targets) {
    if (!target.target || targets.has(target.target)) throw new Error("Monitor snapshot contains duplicate or empty targets.");
    targets.add(target.target);
    if (!identities.has(monitorIdentityKey(target.identity))) {
      throw new Error(`Monitor target ${target.target} has no exact window state.`);
    }
  }
  if (targets.size !== snapshot.state.windows.length) {
    throw new Error("Monitor snapshot does not address every window exactly once.");
  }
}

function resolveMonitorQueryTarget(snapshot: MonitorQuerySnapshot, requested: string): MonitorQueryTargetSnapshot | undefined {
  const matches = snapshot.targets.filter((target) =>
    target.target === requested || target.aliases?.includes(requested) === true
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function exactMonitorQueryTarget(
  snapshot: MonitorQuerySnapshot,
  identity: MonitorWindowIdentityV1,
): MonitorQueryTargetSnapshot | undefined {
  return snapshot.targets.find((target) => sameMonitorIdentity(target.identity, identity));
}

function windowForTarget(
  snapshot: MonitorQuerySnapshot,
  target: MonitorQueryTargetSnapshot,
  full: boolean,
): MonitorQueryWindow | undefined {
  const window = snapshot.state.windows.find((candidate) => sameMonitorIdentity(candidate.identity, target.identity));
  if (!window) return undefined;
  return {
    target: target.target,
    cursor: monitorWindowCursor(window),
    window,
    ...(full ? { timeline: (target.timeline ?? []).map((group) => ({
      group: group.group,
      entries: group.entries.map((entry) => ({ ...entry })),
    })) } : {}),
  };
}

function monitorWindowCursor(window: MonitorWindowCardV1): string {
  const semantic = {
    ...window,
    window: {
      ...window.window,
      lifecycle: {
        ...window.window.lifecycle,
        ownerPublishedAt: undefined,
        ...(window.window.lifecycle.lastSettle === undefined
          ? {}
          : { lastSettle: { ...window.window.lifecycle.lastSettle, at: undefined } }),
      },
    },
    work: {
      ...window.work,
      delivery: { ...window.work.delivery, updatedAt: undefined },
      completion: { ...window.work.completion, completedAt: undefined },
      todos: window.work.todos.map((todo) => ({ ...todo, updatedAt: undefined })),
    },
  };
  const revision = hashMonitorWindowSemanticV1(semantic);
  return `monitor-window:v1:${revision}`;
}

function waitConditionMet(until: MonitorQueryUntil, selected: MonitorQueryWindow, baselineCursor: string): boolean {
  if (until === "change") return selected.cursor !== baselineCursor;
  if (until === "attention") return selected.window.attention.length > 0;
  return selected.window.window.lifecycle.status === "settled"
    || selected.window.window.lifecycle.status === "failed"
    || selected.window.window.lifecycle.status === "disconnected"
    || selected.window.work.completion.outcome !== "unknown";
}

function compareAttentionFirst(left: MonitorQueryWindow, right: MonitorQueryWindow): number {
  const severity = attentionRank(right.window.attention) - attentionRank(left.window.attention);
  return severity !== 0 ? severity : left.target.localeCompare(right.target);
}

function attentionRank(attention: readonly MonitorWindowAttentionV1[]): number {
  return attention.reduce((rank, item) => Math.max(rank, item.severity === "error" ? 3 : item.severity === "warning" ? 2 : 1), 0);
}

function highestAttention(attention: readonly MonitorWindowAttentionV1[]): MonitorWindowAttentionV1 | undefined {
  return [...attention].sort((left, right) => attentionRank([right]) - attentionRank([left]))[0];
}

function severityIcon(severity: MonitorWindowAttentionV1["severity"]): string {
  return severity === "error" ? "✗" : severity === "warning" ? "!" : "i";
}

function sameMonitorIdentity(left: MonitorWindowIdentityV1, right: MonitorWindowIdentityV1): boolean {
  return monitorIdentityKey(left) === monitorIdentityKey(right);
}

function monitorIdentityKey(identity: MonitorWindowIdentityV1): string {
  return [identity.workspaceId, identity.ownerId, identity.ownerNonce, identity.endpointId].join("\u0000");
}

function waitForMonitorQueryDelay(
  _capture: MonitorQueryAuthorityFence,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Monitor wait aborted."));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Monitor wait aborted."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): string {
  return signal.reason === undefined ? "Monitor query aborted." : errorMessage(signal.reason);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
