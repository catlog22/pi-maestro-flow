import fs from "node:fs";
import path from "node:path";
import { getInFlight } from "./inflight.ts";
import { getKnowledgeSuggestions } from "./knowledge-harvest.ts";
import { getMode, readState, resolveStatePath } from "./mode.ts";
import { getRoster } from "./roster.ts";
import { loadRules } from "./rules.ts";
import { readActiveStage } from "./stage-policy.ts";
import { getLeaderWaiting } from "./waiting.ts";
import type {
  DispatchRecord,
  ExpertsCanvasSnapshot,
  ExpertsMode,
  InFlightExpert,
  KnowledgeHarvestSuggestion,
  RosterEntry,
} from "./types.ts";

export function recordLastDispatch(
  record: DispatchRecord,
  cwd = process.cwd(),
  statePath?: string,
): DispatchRecord {
  const file = resolveStatePath(cwd, statePath);
  let prev: Record<string, unknown> = {};
  try {
    if (fs.existsSync(file)) prev = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    prev = {};
  }
  const mode = prev.mode === "experts" || prev.mode === "normal"
    ? prev.mode
    : getMode(cwd, statePath);
  const next = {
    ...prev,
    mode,
    lastDispatch: record,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return record;
}

export interface ExpertsStatus {
  mode: string;
  path: string;
  updatedAt: string | null;
  lastDispatch: unknown;
  leaderWaiting: boolean;
  leaderWaitingCount: number;
  leaderWaitingAgentIds: string[];
  /** P4: last resolved Maestro stage policy snapshot. */
  activeStage: ReturnType<typeof readActiveStage>;
  /** P6: project experts roster (role → agent → default taskType). */
  roster: RosterEntry[];
  /** P6: in-flight expert units (names / correlation ids when known). */
  inFlight: InFlightExpert[];
  /** P7: pending knowhow suggestions from settle harvest (not promoted). */
  knowledgeSuggestions: KnowledgeHarvestSuggestion[];
}

export function getStatus(cwd = process.cwd(), statePath?: string): ExpertsStatus {
  const state = readState(cwd, statePath);
  const waiting = getLeaderWaiting(cwd, statePath);
  const rules = loadRules();
  return {
    mode: state.mode,
    path: state.path,
    updatedAt: state.updatedAt ?? null,
    lastDispatch: state.lastDispatch ?? null,
    leaderWaiting: waiting.leaderWaiting,
    leaderWaitingCount: waiting.activeCount,
    leaderWaitingAgentIds: waiting.lastAgentIds,
    activeStage: readActiveStage(cwd, statePath),
    roster: getRoster(rules),
    inFlight: getInFlight(cwd, statePath),
    knowledgeSuggestions: getKnowledgeSuggestions(cwd, statePath),
  };
}

/**
 * P6: lightweight JSON snapshot for cockpit / external observers.
 * Not a full Canvas UI — schema only.
 */
export function buildCanvasSnapshot(
  cwd = process.cwd(),
  statePath?: string,
): ExpertsCanvasSnapshot {
  const status = getStatus(cwd, statePath);
  const mode = (status.mode === "experts" || status.mode === "normal"
    ? status.mode
    : "normal") as ExpertsMode;
  const last = (status.lastDispatch && typeof status.lastDispatch === "object"
    ? status.lastDispatch
    : null) as DispatchRecord | null;
  return {
    schema: "experts-canvas/1.0",
    mode,
    updatedAt: new Date().toISOString(),
    activeStage: status.activeStage?.stage ?? null,
    leaderWaiting: status.leaderWaiting,
    leaderWaitingCount: status.leaderWaitingCount,
    inFlight: status.inFlight,
    lastDispatch: last,
    roster: status.roster.map((r) => ({
      id: r.id,
      agent: r.agent,
      defaultTaskType: r.defaultTaskType,
      label: r.label,
      enabled: r.enabled,
    })),
    knowledgeSuggestions: status.knowledgeSuggestions.map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title,
      score: s.score,
      fingerprint: s.fingerprint,
    })),
  };
}
