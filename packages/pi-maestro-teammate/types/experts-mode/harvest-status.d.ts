import type { KnowledgeHarvestSuggestion } from "./types.ts";
/** Extension status key for cockpit footer + Maestro statusline. */
export declare const EXPERTS_HARVEST_STATUS_KEY = "experts-harvest";
/**
 * Compact status text for pending experts knowledgeSuggestions.
 * Empty string → clear the status segment.
 *
 * Formats:
 * - 0 → ""
 * - n → "HARVEST n"
 * - with kinds → "HARVEST n · pitfall:1 trade-off:2" (short)
 */
export declare function formatExpertsHarvestStatus(suggestions: readonly KnowledgeHarvestSuggestion[] | number): string;
/** Read state file and format status for UI. */
export declare function expertsHarvestStatusFromCwd(cwd?: string, statePath?: string): string;
