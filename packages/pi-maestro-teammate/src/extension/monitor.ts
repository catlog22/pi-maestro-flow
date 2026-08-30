/**
 * Teammate monitor — root-mode supervision primitives.
 *
 * Pure context, snapshot, state, barrier, and validation helpers with no
 * dependency on extension/index.ts.
 */

import { createHash } from "node:crypto";
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
  "This session is the monitor control window. Its responsibility is to supervise and coordinate other workspace sessions and remote workers according to their tasks and the user's monitoring instructions. It may create and close Monitor-owned Pi windows through workspace-window and configured SSH-backed runs through remote-worker, but it must delegate project implementation to those workers instead of doing the work itself.",
  "Use workspace-window only for local Pi worker windows. Create only when the user's coordination request requires a new local worker; interactive is the default presentation. The objective is delivered by create, so do not resend it afterward. Retain the optional completion handle: settled results remain readable through its immutable agent:// resource after exit, and close forms a cancelled completion for pending work. The tool waits for workspace registration and returns the exact owner target for direct observation and messaging. Never attempt to close discovered external peer windows.",
  "Use remote-worker targets to inspect configured SSH targets, create to start only after the SSH bridge handshake and admission, list to inspect runs owned by this Monitor session, and close with the returned remote:<runId> target for lifecycle cancellation. Never treat a remote worker as a workspace owner or pass it to workspace-window.",
  "Use monitor list/get/wait for ordinary attention-first window status and single-window waits. Retain the exact target and cursor it returns. Use observe only for raw provider snapshots, turns/todos/diagnose views, or multi-target all/any/count barriers; monitor never replaces those advanced observe semantics. Use teammate-list with view=windows only for compatibility discovery. Use teammate-send with follow_up or steer for interventions. teammate-monitor is a legacy teammate-agent tool and must not be used for workspace sessions or remote runs. Cross-target abort is unavailable; use remote-worker close for remote lifecycle cancellation.",
  "Use flow-schedule for durable ordered work in an existing managed workspace window. todoBinding.requireCompleted and conflictCheck are opt-in per step and require the worker's flow-schedule-todo-binding capability. A capability mismatch is an intentional graceful degradation: no Todo instruction or binding is created, and those gates are not enforced; status shows gate=none (not negotiated). Flow-schedule status shows dispatch, binding, and exact result evidence.",
  "Use observe with view=todos on workspace targets to inspect the worker root session's projected Todo state across processes. This view is display-only and never completion authority; a Flow schedule advances from an exact correlated report. A negotiated requireCompleted or conflictCheck gate uses the report's todoOutcome as additional evidence; without such a gate, the exact report remains the completion authority.",
  "Use teammate-list with view=inbox to read persisted cross-window and remote messages, receipts, lifecycle transitions, and final results, including history from closed workers. The inbox is time-filtered to the last 24h by default; pass since with an ISO timestamp, a relative duration like \"7d\", or \"all\" to widen or disable the window. Inbox history never proves that a workspace window or remote run is still live; use monitor list/get for ordinary liveness and attention, reserving observe for raw provider evidence.",
  "Todo gate evidence waits up to 30 seconds by default; missing or mismatched evidence, target replacement, or a terminal worker without an exact report becomes ambiguous. Inspect flow-schedule status before retrying, and retry only when duplicate work is acceptable.",
  "Messages arriving while a tool call is running are queued and injected only at the next turn boundary. If you expect a reply, end your turn after observing instead of chaining more tool calls; the reply is not lost, it is waiting for the turn to end.",
  "Choose whether recurring monitoring is needed from the user's intent. Do not create a loop for a one-shot monitor list/get request or a bounded monitor wait. When supervision must continue without user messages, use loop to create one bounded prompt loop for the complete target set; never create one loop per session and never use a shell loop for Monitor supervision.",
  "Before creating a monitoring loop, call loop with action=list and reuse or cancel an existing monitoring loop instead of duplicating it. Each loop tick should use monitor list/get for ordinary normalized window state, compare new evidence with prior state, and intervene only on new evidence of stall, drift, or failure. Use observe only when that tick specifically needs raw turns/todos/diagnose evidence or a multi-target barrier. Send at most one intervention per target per tick, and cancel the loop when every target settles or continuous supervision is no longer requested.",
  "Write every teammate-send body as a concrete instruction carrying new information, a correction, an explicitly requested response, or a safety/lifecycle constraint. Routing metadata and reply instructions are added automatically; do not put routing boilerplate in the body. Do not send routine acknowledgements or status pings. Use steer for time-sensitive corrections and follow_up for non-urgent work.",
  "A queued or accepted receipt proves enqueueing only, not model consumption. Never repeat that message while it remains queued or accepted; wait for target-side injection or new peer-state evidence, and send again only when a later correction or constraint is necessary.",
  "Do not implement project work, edit files, run shell commands, or start unrelated research in this control window. Delegate or message the appropriate peer session instead.",
  "Treat user messages in the #control tab as monitoring policy, priorities, or intervention instructions. Generic loops are not owned by Monitor mode and are not stopped by /monitor exit. Before asking the user to exit, list active loops and cancel monitoring loops; ask the user to run /monitor exit before handling unrelated work in this session.",
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
export const MONITOR_QUERY_POLL_MS = 250;

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
  const capture = dependencies.captureAuthority();
  if (!capture) return emptyMonitorQueryResult(params.action, "aborted", "Active root Monitor authority is required.");
  if (signal.aborted) return emptyMonitorQueryResult(params.action, "aborted", abortReason(signal));

  const first = await readFencedMonitorSnapshot(params.action, capture, dependencies, signal);
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

  const timeoutMs = params.timeoutMs ?? MONITOR_QUERY_DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let latestSnapshot = first.snapshot;
  let latestWindow = initialWindow;
  while (true) {
    if (signal.aborted) {
      return selectedMonitorQueryResult(params.action, latestSnapshot, latestWindow, "aborted", abortReason(signal));
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return selectedMonitorQueryResult(params.action, latestSnapshot, latestWindow, "timeout", `No ${until} event before timeout.`);
    }
    try {
      await (dependencies.waitForWake ?? waitForMonitorQueryDelay)(
        capture,
        Math.min(MONITOR_QUERY_POLL_MS, remaining),
        signal,
      );
    } catch (error) {
      if (signal.aborted) {
        return selectedMonitorQueryResult(params.action, latestSnapshot, latestWindow, "aborted", abortReason(signal));
      }
      if (!dependencies.isAuthorityCurrent(capture)) {
        return selectedMonitorQueryResult(params.action, latestSnapshot, latestWindow, "stale", "Root session or Monitor generation changed while waiting.");
      }
      return selectedMonitorQueryResult(params.action, latestSnapshot, latestWindow, "aborted", errorMessage(error));
    }
    if (!dependencies.isAuthorityCurrent(capture)) {
      return selectedMonitorQueryResult(params.action, latestSnapshot, latestWindow, "stale", "Root session or Monitor generation changed while waiting.");
    }

    const next = await readFencedMonitorSnapshot(params.action, capture, dependencies, signal);
    if ("result" in next) {
      if (next.result.status === "aborted" && !signal.aborted) {
        return selectedMonitorQueryResult(params.action, latestSnapshot, latestWindow, "stale", next.result.reason);
      }
      return next.result;
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

async function readFencedMonitorSnapshot(
  action: MonitorQueryAction,
  capture: MonitorQueryAuthorityFence,
  dependencies: MonitorQueryDependencies,
  signal: AbortSignal,
): Promise<{ snapshot: MonitorQuerySnapshot } | { result: MonitorQueryResult }> {
  try {
    const snapshot = await dependencies.read(capture, signal);
    if (signal.aborted) return { result: emptyMonitorQueryResult(action, "aborted", abortReason(signal)) };
    if (!dependencies.isAuthorityCurrent(capture)) {
      return { result: emptyMonitorQueryResult(action, "stale", "Root session or Monitor generation changed during snapshot refresh.") };
    }
    validateMonitorQuerySnapshot(snapshot);
    return { snapshot };
  } catch (error) {
    if (signal.aborted) return { result: emptyMonitorQueryResult(action, "aborted", abortReason(signal)) };
    const status: MonitorQueryStatus = dependencies.isAuthorityCurrent(capture) ? "aborted" : "stale";
    return { result: emptyMonitorQueryResult(action, status, errorMessage(error)) };
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
  const revision = createHash("sha256").update(JSON.stringify(semantic), "utf8").digest("hex");
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
