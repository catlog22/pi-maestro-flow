import type { ExpertsMode, ExpertsRules } from "./types.ts";
export declare const EXPERTS_REMINDER_START = "<!-- experts-mode-reminder:start -->";
export declare const EXPERTS_REMINDER_END = "<!-- experts-mode-reminder:end -->";
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
export declare function buildTurnReminder(mode?: ExpertsMode, opts?: TurnReminderOptions): string;
/**
 * Inject or replace the experts reminder block in a system prompt.
 */
export declare function injectTurnReminder(systemPrompt: string, opts?: {
    mode?: ExpertsMode;
    cwd?: string;
} & TurnReminderOptions): string;
