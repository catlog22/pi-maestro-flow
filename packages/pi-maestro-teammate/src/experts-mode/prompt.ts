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
    ? `Current Maestro stage: "${opts.stage}". Prefer resolveStageExpertsPlan / ensureExpertsDispatch({ stage }) so stagePolicies fill taskType before keyword triage.`
    : "When executing a Maestro chain step, pass stage=analyze|plan|execute|review|test|debug into ensureExpertsDispatch so stagePolicies apply.";
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
    "For any non-trivial work: dispatch teammate with an explicit taskType (explore|analysis|debug|planning|development|review|testing|verification).",
    "Do NOT hardcode model ids — routing applies models from taskType via teammate-models.",
    "Prefer agent/role for capability profile (explorer, general-executor, reviewer, …); never use role name as a model id.",
    "While experts are running: wait for completion (observe/wait or completion notification) before synthesizing; do not package the heavy work yourself with write/edit/bash.",
    "Lead discipline (P5): business write/edit/bash are DENIED for the Leader. Rewrite as teammate+taskType. Orchestration paths only: report.md, outputs/**, .workflow/**, notes/**; bash allowlist: maestro/git-read/tests.",
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
