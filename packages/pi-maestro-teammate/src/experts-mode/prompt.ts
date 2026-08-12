import { getMode } from "./mode.ts";
import { buildOrchestratorDisciplineFragment } from "./orchestrator-discipline.ts";
import type { ExpertsMode, ExpertsRules } from "./types.ts";

export const EXPERTS_REMINDER_START = "<!-- experts-mode-reminder:start -->";
export const EXPERTS_REMINDER_END = "<!-- experts-mode-reminder:end -->";

export interface TurnReminderOptions {
  stage?: string;
  stageHint?: string;
  /** P5.1: taskTypes from the active stage plan/pipeline (vice-lead hint). */
  taskTypes?: string[];
  /** P5.1: agents from the active stage plan. */
  agents?: string[];
  /** P5.1: project rules; orchestrator.disciplineReminder/viceLead consulted. */
  rules?: ExpertsRules;
  /** P5.1: explicit switch for the discipline fragment (default true). */
  discipline?: boolean;
}

/**
 * Qoder-like per-turn hard prompt (system_reminder analogue).
 * Only meaningful when mode=experts; empty string in normal.
 */
export function buildTurnReminder(
  mode: ExpertsMode = "experts",
  opts: TurnReminderOptions = {},
): string {
  if (mode !== "experts") return "";
  const stageLine = opts.stage
    ? `Current Maestro stage: "${opts.stage}". Give every dispatched task an explicit taskType; the stage policy supplies defaults for this stage.`
    : "When executing a Maestro chain step, give every dispatched task an explicit taskType; the host resolves the stage automatically.";
  const extra = opts.stageHint ? opts.stageHint : "";
  const discipline =
    opts.discipline !== false && opts.rules?.orchestrator?.disciplineReminder !== false
      ? buildOrchestratorDisciplineFragment({
        stage: opts.stage,
        taskTypes: opts.taskTypes,
        agents: opts.agents,
        rules: opts.rules,
      })
      : "";
  return [
    EXPERTS_REMINDER_START,
    "<experts_mode_reminder>",
    "Experts Mode is ON. You are the Leader (orchestrator).",
    stageLine,
    "For any non-trivial work: dispatch teammate with an explicit taskType (explore|analysis|debug|planning|development|review|testing).",
    "Do NOT hardcode model ids — routing applies models from taskType automatically.",
    "Prefer agent/role for capability profile (explorer, planner, analyst, …; fallback: general when a role is unavailable); never use a role name as a model id.",
    "While experts are running: wait for completion (observe/wait or completion notification) before synthesizing.",
    "Lead discipline: never perform business write/edit/bash yourself — rewrite the work as a teammate dispatch with a taskType. The Leader writes orchestration artifacts only (report.md, outputs/**, .workflow/**, notes/**) and uses bash only for maestro/git-read/tests.",
    "When summarizing an expert result, keep agentId/name and a clear RESULT body.",
    extra,
    discipline,
    "</experts_mode_reminder>",
    EXPERTS_REMINDER_END,
  ].filter(Boolean).join("\n");
}

/**
 * Inject or replace the experts reminder block in a system prompt.
 */
export function injectTurnReminder(
  systemPrompt: string,
  opts: { mode?: ExpertsMode; cwd?: string } & TurnReminderOptions = {},
): string {
  const mode = opts.mode ?? getMode(opts.cwd ?? process.cwd());
  const block = buildTurnReminder(mode, {
    stage: opts.stage,
    stageHint: opts.stageHint,
    taskTypes: opts.taskTypes,
    agents: opts.agents,
    rules: opts.rules,
    discipline: opts.discipline,
  });
  if (!block) {
    // Strip prior block if mode flipped off
    const start = systemPrompt.indexOf(EXPERTS_REMINDER_START);
    if (start < 0) return systemPrompt;
    const end = systemPrompt.indexOf(EXPERTS_REMINDER_END, start);
    if (end < 0) return systemPrompt.slice(0, start).trimEnd();
    return `${systemPrompt.slice(0, start).trimEnd()}${systemPrompt.slice(end + EXPERTS_REMINDER_END.length)}`.trimEnd();
  }

  const start = systemPrompt.indexOf(EXPERTS_REMINDER_START);
  if (start < 0) return `${systemPrompt.trimEnd()}\n\n${block}`;
  const end = systemPrompt.indexOf(EXPERTS_REMINDER_END, start);
  if (end < 0) return `${systemPrompt.slice(0, start).trimEnd()}\n\n${block}`;
  return `${systemPrompt.slice(0, start).trimEnd()}\n\n${block}${systemPrompt.slice(end + EXPERTS_REMINDER_END.length)}`;
}
