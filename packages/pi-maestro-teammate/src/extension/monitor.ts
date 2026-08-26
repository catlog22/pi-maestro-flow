/**
 * Teammate monitor — root-mode supervision primitives.
 *
 * Pure context, snapshot, state, barrier, and validation helpers with no
 * dependency on extension/index.ts.
 */

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
  "Use teammate-list with view=windows to discover local Pi peer sessions. For one-shot or bounded checks, observe local peers as kind=workspace and remote runs as kind=remote using their remote:<runId> targets. Use teammate-send with follow_up or steer for interventions. teammate-monitor is a legacy teammate-agent tool and must not be used for workspace sessions or remote runs. Cross-target abort is unavailable; use remote-worker close for remote lifecycle cancellation.",
  "Use flow-schedule for durable ordered work in an existing managed workspace window. todoBinding.requireCompleted and conflictCheck are opt-in per step and require the worker's flow-schedule-todo-binding capability. A capability mismatch is an intentional graceful degradation: no Todo instruction or binding is created, and those gates are not enforced; status shows gate=none (not negotiated). Flow-schedule status shows dispatch, binding, and exact result evidence.",
  "Use observe with view=todos on workspace targets to inspect the worker root session's projected Todo state across processes. This view is display-only and never completion authority; a Flow schedule advances from an exact correlated report. A negotiated requireCompleted or conflictCheck gate uses the report's todoOutcome as additional evidence; without such a gate, the exact report remains the completion authority.",
  "Use teammate-list with view=inbox to read persisted cross-window and remote messages, receipts, lifecycle transitions, and final results, including history from closed workers. The inbox is time-filtered to the last 24h by default; pass since with an ISO timestamp, a relative duration like \"7d\", or \"all\" to widen or disable the window. Inbox history never proves that a workspace window or remote run is still live; use observe for liveness.",
  "Todo gate evidence waits up to 30 seconds by default; missing or mismatched evidence, target replacement, or a terminal worker without an exact report becomes ambiguous. Inspect flow-schedule status before retrying, and retry only when duplicate work is acceptable.",
  "Messages arriving while a tool call is running are queued and injected only at the next turn boundary. If you expect a reply, end your turn after observing instead of chaining more tool calls; the reply is not lost, it is waiting for the turn to end.",
  "Choose whether recurring monitoring is needed from the user's intent. Do not create a loop for a one-shot status request or a bounded observe wait/watch. When supervision must continue without user messages, use loop to create one bounded prompt loop for the complete target set; never create one loop per session and never use a shell loop for Monitor supervision.",
  "Before creating a monitoring loop, call loop with action=list and reuse or cancel an existing monitoring loop instead of duplicating it. Each loop tick should rediscover the named workspace sessions, observe all targets in one call, compare new evidence with prior state, and intervene only on new evidence of stall, drift, or failure. Send at most one intervention per target per tick, and cancel the loop when every target settles or continuous supervision is no longer requested.",
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
