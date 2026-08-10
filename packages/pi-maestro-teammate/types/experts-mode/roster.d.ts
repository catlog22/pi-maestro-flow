import type { ExpertsRules, RosterEntry } from "./types.ts";
/**
 * P6: resolve the project experts roster.
 * Prefer explicit rules.roster (+ expertProfiles overlay); fall back to taskTypes.
 * Role name ≠ model id — optional model/channel/skills are config mappings only.
 */
export declare function getRoster(rules?: ExpertsRules): RosterEntry[];
/** Lookup one roster entry by role id, agent name, or defaultTaskType. */
export declare function resolveRosterEntry(query: string, rules?: ExpertsRules): RosterEntry | undefined;
/** Map taskType → preferred agent via roster (else taskTypes / defaultAgent). */
export declare function agentForTaskTypeFromRoster(taskType: string, rules?: ExpertsRules): string;
