import fs from "node:fs";
import path from "node:path";
import { clearInFlight, settleInFlight } from "./inflight.ts";
import { harvestKnowledgeOnSettle } from "./knowledge-harvest.ts";
import { getMode, resolveStatePath } from "./mode.ts";
import type { SettleHarvestResult } from "./types.ts";

export interface LeaderWaitingState {
  leaderWaiting: boolean;
  activeCount: number;
  updatedAt: string | null;
  lastAgentIds: string[];
}

function readRaw(cwd: string, statePath?: string): Record<string, unknown> {
  const file = resolveStatePath(cwd, statePath);
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeRaw(cwd: string, next: Record<string, unknown>, statePath?: string): void {
  const file = resolveStatePath(cwd, statePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export function getLeaderWaiting(cwd = process.cwd(), statePath?: string): LeaderWaitingState {
  const raw = readRaw(cwd, statePath);
  const lw = raw.leaderWaiting;
  const activeCount = typeof raw.leaderWaitingCount === "number" ? raw.leaderWaitingCount : 0;
  const lastAgentIds = Array.isArray(raw.leaderWaitingAgentIds)
    ? (raw.leaderWaitingAgentIds as string[]).map(String)
    : [];
  return {
    leaderWaiting: lw === true || activeCount > 0,
    activeCount,
    updatedAt: typeof raw.leaderWaitingUpdatedAt === "string" ? raw.leaderWaitingUpdatedAt : null,
    lastAgentIds,
  };
}

/**
 * Mark Leader as waiting on experts (Qoder leaderWaitingExperts analogue).
 * activeDelta: +N when dispatching, -N when one finishes; clamp at 0.
 */
export function setLeaderWaiting(
  waiting: boolean,
  opts: {
    cwd?: string;
    statePath?: string;
    activeDelta?: number;
    agentIds?: string[];
  } = {},
): LeaderWaitingState {
  const cwd = opts.cwd ?? process.cwd();
  const prev = readRaw(cwd, opts.statePath);
  const prevCount = typeof prev.leaderWaitingCount === "number" ? prev.leaderWaitingCount : 0;
  let count = prevCount;
  if (typeof opts.activeDelta === "number") {
    count = Math.max(0, prevCount + opts.activeDelta);
  } else if (waiting) {
    count = Math.max(1, prevCount || 1);
  } else {
    count = 0;
  }

  const agentIds = opts.agentIds
    ? opts.agentIds.map(String)
    : Array.isArray(prev.leaderWaitingAgentIds)
      ? (prev.leaderWaitingAgentIds as string[]).map(String)
      : [];

  const next = {
    ...prev,
    mode: prev.mode === "experts" || prev.mode === "normal" ? prev.mode : getMode(cwd, opts.statePath),
    leaderWaiting: waiting || count > 0,
    leaderWaitingCount: count,
    leaderWaitingAgentIds: agentIds,
    leaderWaitingUpdatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeRaw(cwd, next, opts.statePath);
  return getLeaderWaiting(cwd, opts.statePath);
}

export function clearLeaderWaiting(
  cwd = process.cwd(),
  opts: { statePath?: string; reason?: string } = {},
): LeaderWaitingState {
  const prev = readRaw(cwd, opts.statePath);
  const next = {
    ...prev,
    leaderWaiting: false,
    leaderWaitingCount: 0,
    leaderWaitingAgentIds: [],
    leaderWaitingUpdatedAt: new Date().toISOString(),
    leaderWaitingClearReason: opts.reason ?? "cleared",
    updatedAt: new Date().toISOString(),
  };
  writeRaw(cwd, next, opts.statePath);
  return getLeaderWaiting(cwd, opts.statePath);
}


/**
 * P3: auto-clear / decrement when an expert (teammate) settles.
 * Prefer settledCount for batch end; agentId removes one name from the waiting list.
 */
export function noteExpertsSettled(
  cwd = process.cwd(),
  opts: {
    statePath?: string;
    settledCount?: number;
    agentId?: string;
    reason?: string;
    /** P7: expert RESULT / summary text to harvest knowhow suggestions from. */
    content?: string;
    contents?: string[];
    taskType?: string;
    stage?: string;
    sessionId?: string;
    runId?: string;
    evidenceRefs?: string[];
    /** When false, skip harvest even if content provided. */
    harvest?: boolean;
  } = {},
): LeaderWaitingState & { knowledgeHarvest?: SettleHarvestResult } {
  const prev = getLeaderWaiting(cwd, opts.statePath);
  if (!prev.leaderWaiting && prev.activeCount <= 0) {
    // Still allow P7 harvest when content is provided (settle without waiting).
    const harvestOnly = maybeHarvest(cwd, opts);
    return harvestOnly
      ? { ...prev, knowledgeHarvest: harvestOnly }
      : prev;
  }
  const n = Math.max(1, opts.settledCount ?? 1);
  let ids = prev.lastAgentIds.slice();
  if (opts.agentId) {
    const id = String(opts.agentId);
    ids = ids.filter((x) => x !== id);
  } else if (n >= ids.length) {
    ids = [];
  } else {
    ids = ids.slice(0, Math.max(0, ids.length - n));
  }
  const next = setLeaderWaiting(false, {
    cwd,
    statePath: opts.statePath,
    activeDelta: -n,
    agentIds: ids,
  });
  // P6: drop settled experts from in-flight list.
  try {
    if (opts.agentId) {
      settleInFlight(opts.agentId, { cwd, statePath: opts.statePath });
    } else if (next.activeCount <= 0) {
      clearInFlight(cwd, { statePath: opts.statePath });
    } else if (prev.lastAgentIds.length) {
      const removed = prev.lastAgentIds.filter((id) => !ids.includes(id));
      if (removed.length) settleInFlight(removed, { cwd, statePath: opts.statePath });
    }
  } catch {
    /* ignore inflight failures */
  }
  if (opts.reason) {
    try {
      const raw = readRaw(cwd, opts.statePath);
      raw.leaderWaitingClearReason = opts.reason;
      raw.updatedAt = new Date().toISOString();
      writeRaw(cwd, raw, opts.statePath);
    } catch {
      /* ignore */
    }
  }
  const knowledgeHarvest = maybeHarvest(cwd, opts);
  const waiting = getLeaderWaiting(cwd, opts.statePath);
  return knowledgeHarvest ? { ...waiting, knowledgeHarvest } : waiting;
}

function maybeHarvest(
  cwd: string,
  opts: {
    statePath?: string;
    agentId?: string;
    content?: string;
    contents?: string[];
    taskType?: string;
    stage?: string;
    sessionId?: string;
    runId?: string;
    evidenceRefs?: string[];
    harvest?: boolean;
  },
): SettleHarvestResult | undefined {
  if (opts.harvest === false) return undefined;
  const hasContent = Boolean(
    (typeof opts.content === "string" && opts.content.trim())
    || (Array.isArray(opts.contents) && opts.contents.some((c) => String(c || "").trim())),
  );
  if (!hasContent) return undefined;
  try {
    return harvestKnowledgeOnSettle(
      {
        content: opts.content,
        contents: opts.contents,
        agentId: opts.agentId,
        taskType: opts.taskType,
        stage: opts.stage,
        sessionId: opts.sessionId,
        runId: opts.runId,
        evidenceRefs: opts.evidenceRefs,
      },
      { cwd, statePath: opts.statePath, record: true },
    );
  } catch {
    return undefined;
  }
}

export const EXPERTS_WAITING_START = "<!-- experts-mode-waiting:start -->";
export const EXPERTS_WAITING_END = "<!-- experts-mode-waiting:end -->";

/** Prompt fragment when Leader is waiting on active experts. */
export function buildWaitingFragment(state: LeaderWaitingState): string {
  if (!state.leaderWaiting) return "";
  const ids = state.lastAgentIds.length
    ? ` agents=[${state.lastAgentIds.slice(0, 8).join(", ")}]`
    : "";
  return [
    EXPERTS_WAITING_START,
    `<experts_mode_waiting active="${state.activeCount}"${ids}>`,
    "Leader waiting: one or more experts (teammates) are still running.",
    "Do not start dependent synthesis until they complete.",
    "Use observe/wait or await the teammate-complete notification; then clear waiting by consuming results.",
    "</experts_mode_waiting>",
    EXPERTS_WAITING_END,
  ].join("\n");
}

export function injectWaitingFragment(
  systemPrompt: string,
  state: LeaderWaitingState,
): string {
  const block = buildWaitingFragment(state);
  const start = systemPrompt.indexOf(EXPERTS_WAITING_START);
  if (!block) {
    if (start < 0) return systemPrompt;
    const end = systemPrompt.indexOf(EXPERTS_WAITING_END, start);
    if (end < 0) return systemPrompt.slice(0, start).trimEnd();
    return `${systemPrompt.slice(0, start).trimEnd()}${systemPrompt.slice(end + EXPERTS_WAITING_END.length)}`.trimEnd();
  }
  if (start < 0) return `${systemPrompt.trimEnd()}\n\n${block}`;
  const end = systemPrompt.indexOf(EXPERTS_WAITING_END, start);
  if (end < 0) return `${systemPrompt.slice(0, start).trimEnd()}\n\n${block}`;
  return `${systemPrompt.slice(0, start).trimEnd()}\n\n${block}${systemPrompt.slice(end + EXPERTS_WAITING_END.length)}`;
}
