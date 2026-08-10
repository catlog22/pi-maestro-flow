import type { ExpertsStatus } from "./observe.ts";
/** Pure formatter — no disk writes, no model ids. */
export declare function formatExpertsStatusPanelFromStatus(status: ExpertsStatus): string;
export declare function formatExpertsStatusPanel(cwd?: string, statePath?: string): string;
/** CLI panel views for the /experts command (roster|waiting|harvest|status). */
export type ExpertsPanelView = "status" | "roster" | "waiting" | "harvest";
/**
 * Roster section — roles only, never models.
 * Enabled entries first; each row: id | agent | taskType | label | caps | enabled.
 */
export declare function formatExpertsRosterPanelFromStatus(status: ExpertsStatus): string;
/**
 * Waiting section — leaderWaiting + in-flight expert units + active stage.
 * While leaderWaiting, the Lead must not claim done.
 */
export declare function formatExpertsWaitingPanelFromStatus(status: ExpertsStatus): string;
/**
 * Harvest section — pending P7 knowhow suggestions (never auto-promoted).
 * Suggestion rows: id | kind | title (≤72) | score; max 20 rows.
 */
export declare function formatExpertsHarvestPanelFromStatus(status: ExpertsStatus): string;
/** View dispatcher for the /experts CLI (default status view). */
export declare function formatExpertsPanelFromStatus(status: ExpertsStatus, view?: ExpertsPanelView): string;
export declare function formatExpertsPanel(cwd?: string, view?: ExpertsPanelView, statePath?: string): string;
