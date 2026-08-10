import type { ExpertsRules, StageExpertsPlan } from "./types.ts";
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
export declare function resolveMaestroStageFromWorkspace(cwd?: string, opts?: ResolveMaestroStageOptions): MaestroStageInfo | null;
/**
 * Best-effort: set process.env.MAESTRO_STAGE when it is not already set.
 * Never overrides an explicit stage.
 */
export declare function setMaestroStageEnvIfUnset(stage: string): void;
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
export declare function syncActiveStageFromMaestro(cwd?: string, opts?: SyncMaestroStageOptions): StageExpertsPlan | null;
/**
 * Short leader-facing birth packet for the stage: stage, source, pipeline
 * taskTypes, agents, and the first lines of leaderInstructions. Designed to
 * be passed as stageHint into buildTurnReminder / injectTurnReminder.
 */
export declare function formatStageBirthPacket(plan: StageExpertsPlan): string;
