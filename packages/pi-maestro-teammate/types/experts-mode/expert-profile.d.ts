import type { ExpertsMode, ExpertsRules } from "./types.ts";
export declare const EXPERTS_SKILLS_START = "<!-- experts-skills:start -->";
export declare const EXPERTS_SKILLS_END = "<!-- experts-skills:end -->";
export interface ExpertProfileResolved {
    id: string;
    agent: string;
    defaultTaskType: string;
    model?: string;
    fallbackModels?: string[];
    thinking?: string;
    channel?: string;
    skills?: string[];
    source: "roster" | "taskTypes-fallback";
}
/** Resolve channel alias via rules.channels, else return the raw channel string. */
export declare function resolveChannel(channel: string | undefined, rules: ExpertsRules): string | undefined;
/**
 * Build a full provider/model ref.
 * - model with "/" is returned as-is
 * - bare model + channel → `${resolvedChannel}/${model}`
 * - bare model only → model
 */
export declare function resolveModelRef(model: string | undefined, channel: string | undefined, rules: ExpertsRules): string | undefined;
/** Lookup roster entry by agent / taskType / name and resolve model through channel. */
export declare function resolveExpertProfile(query: {
    agent?: string;
    taskType?: string;
    name?: string;
}, rules?: ExpertsRules): ExpertProfileResolved | undefined;
/**
 * Apply expert roster profiles onto teammate params (experts mode only).
 * Fills model / fallbackModels / thinking when unset; injects skills marker into prompt.
 * Never overrides explicit task.model.
 */
export declare function applyExpertProfiles<T extends object>(params: T, opts?: {
    cwd?: string;
    rules?: ExpertsRules;
    mode?: ExpertsMode;
}): T;
