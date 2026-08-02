/**
 * Teammate monitor — persistent observation and supervision.
 *
 * Design principles:
 *   - Monitor is a MODE (like Plan): enter/exit lifecycle, persistent state,
 *     status-bar integration, compact output by default.
 *   - Token efficiency: default output is one compact line per target.
 *     Verbose output is opt-in.
 *
 * Pure algorithms with no dependency on extension/index.ts. The tool
 * registration in index.ts injects the watch/wait callbacks.
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
    modeState.lastSnapshot = capture();
    onRefresh(modeState.lastSnapshot);
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


// ===========================================================================
// MonitorEngine — active supervision with drift detection and intervention
// ===========================================================================

export type MonitorSupervisionMode = "auto" | "custom";

/** A single intervention action taken by the engine. */
export interface InterventionRecord {
  timestamp: number;
  /** Why the intervention was triggered. */
  reason: "stalled" | "failed" | "interaction-needed" | "drift" | "custom";
  /** The corrective message sent to the agent. */
  message: string;
  mode: "steer" | "follow_up";
}

/** Binding between a monitor and a single session (1:1). */
export interface MonitorBinding {
  /** The monitored agent's correlationId. */
  correlationId: string;
  /** Display name for the session. */
  displayName: string;
  mode: MonitorSupervisionMode;
  customPrompt?: string;
  startedAt: number;
  lastCheckAt: number;
  lastInterventionAt: number;
  interventions: InterventionRecord[];
  /** Whether the latest analysis detected drift. */
  driftDetected: boolean;
  /** Last notified reason for dedup (avoid spamming main session). */
  lastNotifiedReason?: string;
}

/** Agent info snapshot provided by the host (index.ts) to the engine. */
export interface EngineAgentInfo {
  correlationId: string;
  name: string;
  status: string;
  idleSeconds: number;
  /** Recent output log lines (tail). */
  outputTail: string[];
  /** The original task prompt (from inbox[0] if available). */
  objective: string;
  /** Whether the agent has pending interactions (waiting on user). */
  hasPendingInteractions: boolean;
}

/** Callbacks injected from index.ts for engine operations. */
export interface EngineCallbacks {
  /** Get current info for a monitored agent. Returns undefined if gone. */
  getAgentInfo: (correlationId: string) => EngineAgentInfo | undefined;
  /** Send an intervention message to an agent. */
  sendIntervention: (correlationId: string, message: string, mode: "steer" | "follow_up") => boolean | Promise<boolean>;
  /** Update the status bar text. */
  onStatusUpdate: (statusText: string | undefined) => void;
  /** Notify the main session (e.g., interaction needed). */
  notifyMain: (message: string) => void;
  /** LLM analysis (Phase C). Returns undefined if not available or failed. */
  analyze?: (binding: MonitorBinding, info: EngineAgentInfo) => Promise<AnalysisResult | undefined>;
}

/** Result from LLM drift analysis. */
export interface AnalysisResult {
  status: "on-track" | "drift";
  reason?: string;
  action?: "none" | "send";
  message?: string;
}

// ---------------------------------------------------------------------------
// Engine constants
// ---------------------------------------------------------------------------

/** Minimum seconds between interventions on the same session. */
export const INTERVENTION_COOLDOWN_MS = 60_000;
/** Engine tick interval. */
export const ENGINE_TICK_MS = 15_000;
/** Idle threshold for stalled detection. */
export const ENGINE_STALL_IDLE_SECONDS = 60;
/** Max output lines to feed to analysis. */
export const ENGINE_ANALYSIS_TAIL_LINES = 20;
/** Max interventions recorded per binding. */
export const ENGINE_MAX_INTERVENTION_LOG = 20;

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------

export interface MonitorEngineState {
  running: boolean;
  /** Guards against overlapping ticks. */
  ticking: boolean;
  bindings: Map<string, MonitorBinding>;
  timer?: ReturnType<typeof setInterval>;
  startedAt: number;
  callbacks?: EngineCallbacks;
  /** Aborts in-flight analysis on stop. */
  abortController?: AbortController;
}

export function createEngineState(): MonitorEngineState {
  return { running: false, ticking: false, bindings: new Map(), startedAt: 0 };
}

// ---------------------------------------------------------------------------
// Binding management (1:1 constraint)
// ---------------------------------------------------------------------------

export function addBinding(
  engine: MonitorEngineState,
  correlationId: string,
  displayName: string,
  mode: MonitorSupervisionMode,
  customPrompt?: string,
): { ok: boolean; error?: string } {
  if (engine.bindings.has(correlationId)) {
    return { ok: false, error: `Session ${displayName} already has a monitor.` };
  }
  engine.bindings.set(correlationId, {
    correlationId,
    displayName,
    mode,
    customPrompt,
    startedAt: Date.now(),
    lastCheckAt: 0,
    lastInterventionAt: 0,
    interventions: [],
    driftDetected: false,
    lastNotifiedReason: undefined,
  });
  return { ok: true };
}

export function removeBinding(engine: MonitorEngineState, correlationId: string): boolean {
  return engine.bindings.delete(correlationId);
}

export function clearBindings(engine: MonitorEngineState): void {
  engine.bindings.clear();
}

// ---------------------------------------------------------------------------
// Heuristic checks (no LLM needed)
// ---------------------------------------------------------------------------

export interface HeuristicResult {
  needsIntervention: boolean;
  reason?: InterventionRecord["reason"];
  message?: string;
  notifyOnly?: boolean; // true = notify main session, don't send to agent
}

export function heuristicCheck(info: EngineAgentInfo): HeuristicResult {
  // Failed agent
  if (info.status === "failed") {
    return {
      needsIntervention: false,
      reason: "failed",
      notifyOnly: true,
      message: `Agent @${info.name} has failed.`,
    };
  }

  // Waiting on user interaction
  if (info.hasPendingInteractions) {
    return {
      needsIntervention: false,
      reason: "interaction-needed",
      notifyOnly: true,
      message: `Agent @${info.name} is waiting for user input.`,
    };
  }

  // Stalled (running but idle too long)
  if (info.status === "running" && info.idleSeconds >= ENGINE_STALL_IDLE_SECONDS) {
    return {
      needsIntervention: true,
      reason: "stalled",
      message: `You appear to be stalled (idle ${info.idleSeconds}s). Please continue working on your task or report what is blocking you.`,
    };
  }

  return { needsIntervention: false };
}

// ---------------------------------------------------------------------------
// Intervention with cooldown
// ---------------------------------------------------------------------------

export function canIntervene(binding: MonitorBinding, now: number): boolean {
  return now - binding.lastInterventionAt >= INTERVENTION_COOLDOWN_MS;
}

export function recordIntervention(
  binding: MonitorBinding,
  reason: InterventionRecord["reason"],
  message: string,
  mode: "steer" | "follow_up",
): void {
  binding.lastInterventionAt = Date.now();
  binding.interventions.push({ timestamp: Date.now(), reason, message, mode });
  // Trim log
  if (binding.interventions.length > ENGINE_MAX_INTERVENTION_LOG) {
    binding.interventions = binding.interventions.slice(-ENGINE_MAX_INTERVENTION_LOG);
  }
}

// ---------------------------------------------------------------------------
// Engine tick
// ---------------------------------------------------------------------------

/**
 * One engine tick: check all bindings, run heuristics, optionally run LLM
 * analysis, and intervene if needed.
 *
 * Returns the number of interventions taken.
 */
export async function engineTick(engine: MonitorEngineState): Promise<number> {
  const cb = engine.callbacks;
  if (!cb || engine.ticking) return 0;
  engine.ticking = true;
  const now = Date.now();
  let interventionCount = 0;
  try {

  for (const [cid, binding] of engine.bindings) {
    const info = cb.getAgentInfo(cid);
    if (!info) {
      // Agent is gone — remove binding
      engine.bindings.delete(cid);
      continue;
    }

    binding.lastCheckAt = now;

    // 1. Heuristic fast check
    const heuristic = heuristicCheck(info);

    if (heuristic.notifyOnly && heuristic.message) {
      // Dedup: only notify on state transition, not every tick
      if (binding.lastNotifiedReason !== heuristic.reason) {
        binding.lastNotifiedReason = heuristic.reason;
        cb.notifyMain(heuristic.message);
      }
      continue;
    }
    // Clear notification dedup when agent recovers
    if (binding.lastNotifiedReason && !heuristic.notifyOnly) {
      binding.lastNotifiedReason = undefined;
    }

    if (heuristic.needsIntervention && heuristic.message && canIntervene(binding, now)) {
      const sent = await cb.sendIntervention(cid, heuristic.message, "steer");
      if (sent) {
        recordIntervention(binding, heuristic.reason!, heuristic.message, "steer");
        interventionCount++;
      }
      continue;
    }

    // 2. LLM analysis (only for running agents that pass heuristic)
    if (cb.analyze && info.status === "running" && info.idleSeconds < ENGINE_STALL_IDLE_SECONDS) {
      const result = await cb.analyze(binding, info).catch(() => undefined);
      if (result) {
        binding.driftDetected = result.status === "drift";
        if (result.status === "drift" && result.action === "send" && result.message && canIntervene(binding, now)) {
          const sent = await cb.sendIntervention(cid, result.message, "steer");
          if (sent) {
            recordIntervention(binding, binding.mode === "custom" ? "custom" : "drift", result.message, "steer");
            interventionCount++;
          }
        }
      }
    }
  }

  return interventionCount;
  } finally {
    engine.ticking = false;
  }
}

// ---------------------------------------------------------------------------
// Engine lifecycle
// ---------------------------------------------------------------------------

export function startEngine(
  engine: MonitorEngineState,
  callbacks: EngineCallbacks,
): void {
  stopEngine(engine);
  engine.running = true;
  engine.ticking = false;
  engine.startedAt = Date.now();
  engine.callbacks = callbacks;
  engine.abortController = new AbortController();

  engine.timer = setInterval(() => {
    void engineTick(engine);
  }, ENGINE_TICK_MS);

  // Background work — never prevent process exit
  if (engine.timer && typeof engine.timer === "object" && "unref" in engine.timer) {
    (engine.timer as NodeJS.Timeout).unref();
  }

  // Initial tick
  void engineTick(engine);
}

export function stopEngine(engine: MonitorEngineState): void {
  if (engine.timer !== undefined) {
    clearInterval(engine.timer);
    engine.timer = undefined;
  }
  engine.abortController?.abort();
  engine.abortController = undefined;
  engine.running = false;
  engine.ticking = false;
  engine.callbacks?.onStatusUpdate(undefined);
  engine.callbacks = undefined;
}

// ---------------------------------------------------------------------------
// Engine status bar
// ---------------------------------------------------------------------------

export function formatEngineStatusBar(engine: MonitorEngineState): string {
  const total = engine.bindings.size;
  if (total === 0) return "MON idle";

  const elapsed = Math.round((Date.now() - engine.startedAt) / 1000);
  const totalFixes = [...engine.bindings.values()].reduce((n, b) => n + b.interventions.length, 0);
  const anyDrift = [...engine.bindings.values()].some((b) => b.driftDetected);

  let suffix = "";
  if (anyDrift) suffix = " · ▲ drift";
  else if (totalFixes > 0) suffix = ` · ◆ ${totalFixes} fix${totalFixes === 1 ? "" : "es"}`;

  return `MON ${total} · ${elapsed}s${suffix}`;
}

// ---------------------------------------------------------------------------
// Analysis prompt builders (Phase C)
// ---------------------------------------------------------------------------

export function buildAutoAnalysisPrompt(objective: string, outputTail: string[]): string {
  return [
    "Analyze the following agent output and determine if it is drifting from its task objective.",
    "",
    `Task objective: ${objective}`,
    "",
    "Recent output:",
    ...outputTail.slice(-ENGINE_ANALYSIS_TAIL_LINES),
    "",
    'Return ONLY a JSON object: { "status": "on-track" | "drift", "reason": "...", "action": "none" | "send", "message": "corrective prompt if drift" }',
    "If on-track, action should be \"none\" and message can be empty.",
    "If drift detected, action should be \"send\" with a short corrective message.",
  ].join("\n");
}

export function buildCustomAnalysisPrompt(customPrompt: string, objective: string, outputTail: string[]): string {
  return [
    "You are a task supervisor. Check the agent output against the management requirements below.",
    "",
    `Management requirements: ${customPrompt}`,
    "",
    `Original task objective: ${objective}`,
    "",
    "Recent output:",
    ...outputTail.slice(-ENGINE_ANALYSIS_TAIL_LINES),
    "",
    'Return ONLY a JSON object: { "status": "on-track" | "drift", "reason": "...", "action": "none" | "send", "message": "corrective prompt if needed" }',
    "If requirements are met, action should be \"none\".",
    "If requirements are not met, action should be \"send\" with a specific corrective message.",
  ].join("\n");
}

export function parseAnalysisResult(raw: string): AnalysisResult | undefined {
  try {
    // Extract JSON from potential markdown code blocks
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return undefined;
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const status = parsed.status === "drift" ? "drift" : "on-track";
    return {
      status,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      action: parsed.action === "send" ? "send" : "none",
      message: typeof parsed.message === "string" ? parsed.message : undefined,
    };
  } catch {
    return undefined;
  }
}
