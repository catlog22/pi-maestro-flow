/**
 * Goal-linked monitoring context — lightweight interop with the pi-peer
 * goal board (`.pi/peer-goals.json`, G:\github_lib\pi-peer goal-store).
 *
 * The Monitor does not depend on pi-peer: when the file exists it injects
 * the goal's closure standards into drift analysis so "drifting" is judged
 * against the real completion criteria; when the file is missing or the goal
 * is unknown, supervision falls back to the plain objective + output tail.
 */
export declare const PEER_GOAL_BOARD_RELATIVE_PATH = ".pi/peer-goals.json";
export declare const PEER_GOAL_JOURNAL_RELATIVE_PATH = ".pi/peer-goals.journal.jsonl";
export interface GoalClosureContext {
    goalId: string;
    title?: string;
    status?: string;
    requiredVotes?: number;
    minIndependentVotes?: number;
    requiredEvidence?: string[];
    openProposals?: number;
    activeClaims?: number;
}
/** Best-effort load of one goal's closure context from the pi-peer board. */
export declare function loadPeerGoalContext(root: string, goalId: string): Promise<GoalClosureContext | undefined>;
export declare function extractGoalClosureContext(goalId: string, goal: unknown): GoalClosureContext | undefined;
/**
 * Compact closure-standard block injected into drift analysis prompts so the
 * analyst judges the agent against the goal's real completion gates.
 */
export declare function buildGoalContextBlock(context: GoalClosureContext): string;
/**
 * Append a blocking objection event to the pi-peer goal journal
 * (`.pi/peer-goals.journal.jsonl`, `{ type: "event", goalId, event }` shape).
 * Best-effort: unknown goals, missing boards, or write failures are ignored
 * so supervision never fails because of the board.
 */
export declare function appendPeerGoalObjection(root: string, goalId: string, input: {
    peerId: string;
    summary: string;
    severity?: string;
}): Promise<boolean>;
