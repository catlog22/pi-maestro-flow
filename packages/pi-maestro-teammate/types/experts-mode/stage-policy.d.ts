import type { ExpertsMode, ExpertsRules, StageExpertsPlan, StagePolicy } from "./types.ts";
/** Built-in aliases so Maestro chain commands map to policy keys. */
export declare const DEFAULT_STAGE_ALIASES: Record<string, string>;
export interface ResolveStageExpertsPlanOptions {
    mode?: ExpertsMode;
    cwd?: string;
    rules?: ExpertsRules;
    chainCommand?: string;
    /** When true, persist activeStage + lastStagePlan into .experts-mode.json */
    record?: boolean;
    /** Extra leader-facing notes appended to leaderInstructions */
    extraLeaderNotes?: string;
}
/**
 * Normalize a Maestro step/command/stage string to a stage policy key.
 */
export declare function resolveStageName(stageOrCommand: string | undefined | null, rules?: ExpertsRules): string | undefined;
export declare function getStagePolicy(stageOrCommand: string | undefined | null, rules?: ExpertsRules): {
    stage: string;
    policy: StagePolicy;
} | undefined;
/**
 * Resolve the experts plan for a Maestro chain stage.
 * Stage policy defaults beat keyword triage when a policy exists.
 * In normal mode returns empty tasks (no force).
 */
export declare function resolveStageExpertsPlan(stageOrCommand: string, intent: string, opts?: ResolveStageExpertsPlanOptions): StageExpertsPlan;
export interface ActiveStageState {
    stage: string;
    source?: string;
    taskTypes?: string[];
    agents?: string[];
    intentPreview?: string;
    /** P4.1: Maestro session/run that produced this stage (source="maestro-session"). */
    sessionId?: string;
    runId?: string;
    at?: string;
}
export declare function writeActiveStage(cwd: string | undefined, activeStage: ActiveStageState, statePath?: string): void;
export declare function readActiveStage(cwd?: string, statePath?: string): ActiveStageState | null;
/**
 * Given a single teammate task without taskType, fill from stage policy primary step.
 * Returns undefined when no stage policy applies.
 */
export declare function primaryStageAssignment(stageOrCommand: string | undefined, rules?: ExpertsRules): {
    taskType: string;
    agent: string;
    stage: string;
} | undefined;
