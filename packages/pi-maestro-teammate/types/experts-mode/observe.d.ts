import { readActiveStage } from "./stage-policy.ts";
import type { DispatchRecord, ExpertsCanvasSnapshot, InFlightExpert, KnowledgeHarvestSuggestion, RosterEntry } from "./types.ts";
export declare function recordLastDispatch(record: DispatchRecord, cwd?: string, statePath?: string): DispatchRecord;
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
export declare function getStatus(cwd?: string, statePath?: string): ExpertsStatus;
/**
 * P6: lightweight JSON snapshot for cockpit / external observers.
 * Not a full Canvas UI — schema only.
 */
export declare function buildCanvasSnapshot(cwd?: string, statePath?: string): ExpertsCanvasSnapshot;
