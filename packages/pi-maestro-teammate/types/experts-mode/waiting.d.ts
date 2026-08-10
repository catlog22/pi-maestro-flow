import type { SettleHarvestResult } from "./types.ts";
export interface LeaderWaitingState {
    leaderWaiting: boolean;
    activeCount: number;
    updatedAt: string | null;
    lastAgentIds: string[];
}
export declare function getLeaderWaiting(cwd?: string, statePath?: string): LeaderWaitingState;
/**
 * Mark Leader as waiting on experts (Qoder leaderWaitingExperts analogue).
 * activeDelta: +N when dispatching, -N when one finishes; clamp at 0.
 */
export declare function setLeaderWaiting(waiting: boolean, opts?: {
    cwd?: string;
    statePath?: string;
    activeDelta?: number;
    agentIds?: string[];
}): LeaderWaitingState;
export declare function clearLeaderWaiting(cwd?: string, opts?: {
    statePath?: string;
    reason?: string;
}): LeaderWaitingState;
/**
 * P3: auto-clear / decrement when an expert (teammate) settles.
 * Prefer settledCount for batch end; agentId removes one name from the waiting list.
 */
export declare function noteExpertsSettled(cwd?: string, opts?: {
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
}): LeaderWaitingState & {
    knowledgeHarvest?: SettleHarvestResult;
};
export declare const EXPERTS_WAITING_START = "<!-- experts-mode-waiting:start -->";
export declare const EXPERTS_WAITING_END = "<!-- experts-mode-waiting:end -->";
/** Prompt fragment when Leader is waiting on active experts. */
export declare function buildWaitingFragment(state: LeaderWaitingState): string;
export declare function injectWaitingFragment(systemPrompt: string, state: LeaderWaitingState): string;
