import fs from "node:fs";
import path from "node:path";
import { getMode } from "./mode.ts";
import { loadRules } from "./rules.ts";
import {
  resolveStageExpertsPlan,
  resolveStageName,
  writeActiveStage,
} from "./stage-policy.ts";
import type { ExpertsRules, StageExpertsPlan } from "./types.ts";

/**
 * P4.1 — Maestro stage auto-injection.
 *
 * The Maestro session.json is the single source of truth for the current
 * chain step (orchestration.chain[].stage + active_run_id). These helpers
 * read that file (never write it) so Leaders no longer need to pass
 * stage/MAESTRO_STAGE by hand: the stage is auto-detected from the running
 * session and injected into ensureExpertsDispatch / the turn reminder.
 */

const ACTIVE_STEP_STATUSES = new Set(["running", "active", "in_progress"]);
const SEALED_STEP_STATUSES = new Set([
  "done",
  "completed",
  "sealed",
  "skipped",
  "failed",
  "cancelled",
  "aborted",
  "blocked",
]);

/** Lightweight shape of a Maestro session.json (read-only, best-effort). */
interface SessionFileLike {
  session_id?: unknown;
  intent?: unknown;
  status?: unknown;
  active_run_id?: unknown;
  lifecycle?: { sealed_at?: unknown };
  orchestration?: {
    chain?: Array<{
      step_id?: unknown;
      command?: unknown;
      status?: unknown;
      run_id?: unknown;
      stage?: unknown;
    }>;
  };
}

export interface MaestroStageInfo {
  /** Session id owning the current step. */
  sessionId: string;
  /** active_run_id (or the matched step's run_id). */
  runId?: string;
  /** Normalized stage policy key (aliases resolved, e.g. maestro-execute → execute). */
  stage: string;
  /** Raw step id when known. */
  stepId?: string;
  /** Raw chain command (e.g. execute / maestro-execute). */
  command?: string;
  /** Session intent text when present. */
  intent?: string;
  /** Where the stage came from: MAESTRO_SESSION_ID env or workspace scan. */
  source: "env" | "workspace";
}

export interface ResolveMaestroStageOptions {
  /** Rules for resolveStageName alias mapping (defaults to loadRules()). */
  rules?: ExpertsRules;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function nonEmptyStr(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

type ChainStep = {
  step_id?: unknown;
  command?: unknown;
  status?: unknown;
  run_id?: unknown;
  stage?: unknown;
};

function sessionChain(session: SessionFileLike): ChainStep[] {
  const chain = session?.orchestration?.chain;
  return Array.isArray(chain) ? (chain as ChainStep[]) : [];
}

function readSessionFile(file: string): SessionFileLike | null {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as SessionFileLike;
    if (!raw || typeof raw !== "object") return null;
    return raw;
  } catch {
    return null;
  }
}

function hasActiveStep(session: SessionFileLike): boolean {
  const chain = sessionChain(session);
  if (chain.length === 0) return false;
  if (nonEmptyStr(session.active_run_id)) {
    if (chain.some((s) => s.run_id === session.active_run_id)) return true;
  }
  return chain.some((s) =>
    ACTIVE_STEP_STATUSES.has(String(s.status || "").toLowerCase()),
  );
}

function hasSealedAt(session: SessionFileLike): boolean {
  return nonEmptyStr(session.lifecycle?.sealed_at);
}

function selectActiveStep(session: SessionFileLike): ChainStep | undefined {
  const chain = sessionChain(session);
  if (chain.length === 0) return undefined;
  // 1. step matching active_run_id
  if (nonEmptyStr(session.active_run_id)) {
    const byRun = chain.find((s) => s.run_id === session.active_run_id);
    if (byRun) return byRun;
  }
  // 2. first step with an active status
  const active = chain.find((s) =>
    ACTIVE_STEP_STATUSES.has(String(s.status || "").toLowerCase()),
  );
  if (active) return active;
  // 3. first non-sealed step
  return chain.find((s) =>
    !SEALED_STEP_STATUSES.has(String(s.status || "").toLowerCase()),
  );
}

interface ScannedSession {
  session: SessionFileLike;
  sessionId: string;
  mtime: number;
}

function scanSessions(sessionsRoot: string): ScannedSession | undefined {
  if (!fs.existsSync(sessionsRoot)) return undefined;
  let entries;
  try {
    entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const parsed: ScannedSession[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionId = entry.name;
    const file = path.join(sessionsRoot, sessionId, "session.json");
    const session = readSessionFile(file);
    if (!session) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      // keep mtime 0
    }
    parsed.push({ session, sessionId, mtime });
  }
  if (parsed.length === 0) return undefined;
  const byMtime = (a: ScannedSession, b: ScannedSession): number => b.mtime - a.mtime;
  // Tier 1: running session with an active_run_id (latest wins).
  const tier1 = parsed
    .filter((p) => {
      const status = String(p.session.status || "").toLowerCase();
      return status === "running" && nonEmptyStr(p.session.active_run_id);
    })
    .sort(byMtime);
  if (tier1[0]) return tier1[0];
  // Tier 2: latest running-or-unsealed session that still has an active step.
  const tier2 = parsed
    .filter((p) => {
      const status = String(p.session.status || "").toLowerCase();
      if (status !== "running" && hasSealedAt(p.session)) return false;
      return hasActiveStep(p.session);
    })
    .sort(byMtime);
  return tier2[0] ?? undefined;
}

/**
 * Resolve the current Maestro stage from the workspace without throwing.
 *
 * 1. MAESTRO_SESSION_ID env wins when its session.json exists;
 * 2. otherwise scan the .workflow/sessions directory for the latest
 *    running session.json (with active_run_id) or latest non-sealed
 *    session with an active step;
 * 3. stage = step.stage || step.command, normalized via resolveStageName.
 *
 * Returns null (never throws) when nothing usable is found.
 */
export function resolveMaestroStageFromWorkspace(
  cwd = process.cwd(),
  opts: ResolveMaestroStageOptions = {},
): MaestroStageInfo | null {
  try {
    const rules = opts.rules ?? loadRules();
    const sessionsRoot = path.resolve(cwd, ".workflow", "sessions");
    const envSessionId = nonEmptyStr(process.env.MAESTRO_SESSION_ID)
      ? String(process.env.MAESTRO_SESSION_ID)
      : undefined;

    let scanned: ScannedSession | undefined;
    if (envSessionId) {
      const session = readSessionFile(path.join(sessionsRoot, envSessionId, "session.json"));
      if (session) scanned = { session, sessionId: envSessionId, mtime: 0 };
    }
    if (!scanned) scanned = scanSessions(sessionsRoot);
    if (!scanned) return null;

    const step = selectActiveStep(scanned.session);
    if (!step) return null;
    const stageRaw = str(step.stage) || str(step.command) || "";
    const stage = resolveStageName(stageRaw, rules) || stageRaw || "unknown";
    return {
      sessionId: scanned.sessionId,
      runId: str(scanned.session.active_run_id) || str(step.run_id) || undefined,
      stage,
      stepId: str(step.step_id) || undefined,
      command: str(step.command) || undefined,
      intent: str(scanned.session.intent) || undefined,
      source: envSessionId ? "env" : "workspace",
    };
  } catch {
    return null;
  }
}

/**
 * Best-effort: set process.env.MAESTRO_STAGE when it is not already set.
 * Never overrides an explicit stage.
 */
export function setMaestroStageEnvIfUnset(stage: string): void {
  try {
    if (!nonEmptyStr(process.env.MAESTRO_STAGE)) process.env.MAESTRO_STAGE = stage;
  } catch {
    // env mutation must never break dispatch/context injection
  }
}

export interface SyncMaestroStageOptions {
  /** Mode gate: only writes activeStage under experts. Defaults to getMode(cwd). */
  mode?: "experts" | "normal";
  rules?: ExpertsRules;
  /** When false, process.env.MAESTRO_STAGE is left untouched. Default true. */
  setEnv?: boolean;
}

/**
 * Auto-inject the Maestro stage into experts state:
 * resolve stage from session.json → writeActiveStage (with source
 * "maestro-session" + session/run ids) → return the stage experts plan.
 *
 * No-ops (returns null) when no running session is found; never throws.
 */
export function syncActiveStageFromMaestro(
  cwd = process.cwd(),
  opts: SyncMaestroStageOptions = {},
): StageExpertsPlan | null {
  const mode = opts.mode ?? getMode(cwd);
  const found = resolveMaestroStageFromWorkspace(cwd, { rules: opts.rules });
  if (!found) return null;
  if (mode === "experts" && opts.setEnv !== false) {
    setMaestroStageEnvIfUnset(found.stage);
  }
  const plan = resolveStageExpertsPlan(found.stage, found.intent || "", {
    cwd,
    rules: opts.rules,
    record: mode === "experts",
  });
  if (mode === "experts") {
    try {
      writeActiveStage(cwd, {
        stage: plan.stage,
        source: "maestro-session",
        sessionId: found.sessionId,
        runId: found.runId,
        taskTypes: plan.tasks.map((t) => String(t.taskType || "")),
        agents: plan.tasks.map((t) => String(t.agent || "")),
        intentPreview: String(found.intent || "").slice(0, 160),
        at: new Date().toISOString(),
      });
    } catch {
      // state persistence must not break stage sync
    }
  }
  return plan;
}

/**
 * Short leader-facing birth packet for the stage: stage, source, pipeline
 * taskTypes, agents, and the first lines of leaderInstructions. Designed to
 * be passed as stageHint into buildTurnReminder / injectTurnReminder.
 */
export function formatStageBirthPacket(plan: StageExpertsPlan): string {
  const taskTypes =
    (plan.tasks?.map((t) => String(t.taskType || "")).filter(Boolean) || []).join(" → ") || "—";
  const agents =
    (plan.tasks?.map((t) => String(t.agent || "")).filter(Boolean) || []).join(", ") || "—";
  const leaderFirstLines = String(plan.leaderInstructions || "")
    .split("\n")
    .filter(Boolean)
    .slice(0, 3)
    .join("\n");
  return [
    `Stage birth: "${plan.stage}" (mode=${plan.mode}, source=${plan.source}).`,
    `Pipeline: ${taskTypes}.`,
    `Agents: ${agents}.`,
    leaderFirstLines,
  ].filter(Boolean).join("\n");
}
