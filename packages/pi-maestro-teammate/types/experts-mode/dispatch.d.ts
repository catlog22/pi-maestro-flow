import type { ExpertsMode, ExpertsRules } from "./types.ts";
export interface EnsureExpertsDispatchOptions {
    mode?: ExpertsMode;
    cwd?: string;
    record?: boolean;
    rules?: ExpertsRules;
    /**
     * P4: Maestro chain stage / command name.
     * When set under experts mode, missing taskType is filled from stagePolicies
     * before keyword triage.
     */
    stage?: string;
}
/** Meta attached by ensureExpertsDispatch when experts mode forced assignments. */
export type ExpertsDispatchMeta = {
    mode: ExpertsMode;
    forced: boolean;
    stage?: string;
    stageForced?: boolean;
    triage: Array<{
        taskType?: string;
        agent?: string;
    }>;
    /** HV-03: how many leaderWaiting slots this dispatch reserved (+N). */
    waitingDelta?: number;
    /** Task ids/names reserved for waiting/inFlight (for early-return settle). */
    waitingAgentIds?: string[];
};
/**
 * Ensure teammate-like params carry taskType/agent when Experts Mode is on.
 * Then applyExpertProfiles may fill model/channel/skills from roster config
 * (explicit task.model still wins). Keyword triage never invents models.
 *
 * Call order (required):
 *   ensureExpertsDispatch(params) → applyModelRouting(params, ...)
 *
 * The param contract is deliberately loose (`T extends object`): callers pass
 * RunTeammateParams / teammate tool params whose task specs carry no index
 * signature, so they do not structurally match TeammateParamsLike. We widen
 * internally and preserve the caller's concrete type on the way out.
 */
export declare function ensureExpertsDispatch<T extends object>(params: T, opts?: EnsureExpertsDispatchOptions): T & {
    __experts?: ExpertsDispatchMeta;
};
