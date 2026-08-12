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
export declare const ORCHESTRATOR_DISCIPLINE_MARK = "Orchestrator discipline";
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
export declare function shouldSuggestViceLead(opts: {
    taskTypes?: string[];
    agents?: string[];
    rules?: ExpertsRules;
    force?: boolean;
}): boolean;
/** Compact multi-line fragment (no HTML wrapper), <12 lines. */
export declare function buildOrchestratorDisciplineFragment(opts?: OrchestratorDisciplineOptions): string;
/**
 * Optional helper: sample task shape for the workflow vice-lead.
 * Role-based only (agent + taskType + prompt text); never a model id.
 */
export declare function buildViceLeadDispatchHint(stage?: string, intent?: string): TeammateTaskLike;
