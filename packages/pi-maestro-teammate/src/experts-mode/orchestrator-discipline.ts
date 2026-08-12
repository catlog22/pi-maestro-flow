import type { ExpertsRules, TeammateTaskLike } from "./types.ts";

/**
 * P5.1 — Orchestrator discipline for Experts Mode.
 *
 * Reinforces the /maestro run-loop discipline in the per-turn reminder:
 * the Leader only owns session/run lifecycle + teammate dispatch +
 * synthesis, never business code. For multi-step stage pipelines the
 * workflow agent may be suggested as optional vice-lead (decompose +
 * dispatch DAG), while the Lead keeps session done/check/seal.
 */

/** Stable marker for the discipline fragment (used by tests + extension). */
export const ORCHESTRATOR_DISCIPLINE_MARK = "Orchestrator discipline";

export interface OrchestratorDisciplineOptions {
  stage?: string;
  /** taskTypes from active stage plan / pipeline */
  taskTypes?: string[];
  /** agents from plan */
  agents?: string[];
  /**
   * Explicit vice-lead control: true forces guidance, false suppresses it.
   * Undefined → rules.orchestrator.viceLead (default true) + multi-step check.
   */
  viceLead?: boolean;
  /** optional project flag from rules */
  rules?: ExpertsRules;
}

/**
 * True when rules.orchestrator.viceLead !== false AND the pipeline is
 * multi-step (>=2 taskTypes or >=2 agents) or force is set.
 */
export function shouldSuggestViceLead(opts: {
  taskTypes?: string[];
  agents?: string[];
  rules?: ExpertsRules;
  force?: boolean;
}): boolean {
  if (opts.rules?.orchestrator?.viceLead === false) return false;
  const taskTypes = opts.taskTypes ?? [];
  const agents = opts.agents ?? [];
  const multiStep = taskTypes.length >= 2 || agents.length >= 2;
  return opts.force === true || multiStep;
}

/** Compact multi-line fragment (no HTML wrapper), <12 lines. */
export function buildOrchestratorDisciplineFragment(
  opts: OrchestratorDisciplineOptions = {},
): string {
  // Business-code and artifact-path constraints live in the outer experts
  // reminder (buildTurnReminder); only list increments here to avoid repeating
  // the same instruction inside one injected block.
  const lines = [
    `${ORCHESTRATOR_DISCIPLINE_MARK}: Lead only maestro session/run lifecycle + teammate dispatch + synthesize RESULT into report/outputs.`,
    "Prefer automatic continuation when authority=automatic (session next/done loop).",
  ];
  const viceLead =
    opts.viceLead === false
      ? false
      : shouldSuggestViceLead({
        taskTypes: opts.taskTypes,
        agents: opts.agents,
        rules: opts.rules,
        force: opts.viceLead === true,
      });
  if (viceLead) {
    lines.push(
      "Multi-step pipeline: optionally dispatch agent=workflow taskType=planning as vice-lead to decompose/dispatch DAG; Lead still owns session done/check/seal.",
    );
  }
  return lines.join("\n");
}

/**
 * Optional helper: sample task shape for the workflow vice-lead.
 * Role-based only (agent + taskType + prompt text); never a model id.
 */
export function buildViceLeadDispatchHint(
  stage?: string,
  intent?: string,
): TeammateTaskLike {
  return {
    agent: "workflow",
    taskType: "planning",
    name: "vice-lead",
    prompt: [
      `Act as vice-lead for stage "${stage || "current"}".`,
      intent ? `Intent: ${intent}` : "",
      "Decompose the stage into a dependency-aware teammate DAG and dispatch it; Lead keeps session done/check/seal.",
    ].filter(Boolean).join("\n"),
  };
}
