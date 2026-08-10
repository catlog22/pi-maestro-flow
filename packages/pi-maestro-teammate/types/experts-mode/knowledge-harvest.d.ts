import type { ExpertsRules, KnowledgeHarvestSuggestion, KnowledgeStageCommand, SettleHarvestInput, SettleHarvestResult } from "./types.ts";
/**
 * P7: harvest knowledge *suggestions* from expert settle content.
 * - Suggest only (default); never auto-promote.
 * - Quality bar rejects raw traces / trivial ops.
 * - Fingerprint dedup against prior suggestions in .experts-mode.json.
 */
export declare function harvestKnowledgeOnSettle(input: SettleHarvestInput, opts?: {
    cwd?: string;
    statePath?: string;
    rules?: ExpertsRules;
    record?: boolean;
    maxSuggestions?: number;
}): SettleHarvestResult;
/** Build a copy-pasteable `maestro knowledge stage` command (never auto-runs). */
export declare function buildStageCommand(suggestion: KnowledgeHarvestSuggestion, input?: Pick<SettleHarvestInput, "sessionId" | "runId" | "evidenceRefs">): KnowledgeStageCommand;
export declare function getKnowledgeSuggestions(cwd?: string, statePath?: string): KnowledgeHarvestSuggestion[];
export declare function clearKnowledgeSuggestions(cwd?: string, opts?: {
    statePath?: string;
    keepFingerprints?: boolean;
}): void;
/** Pure quality gate used by harvest + tests. */
export declare function assessKnowledgeCandidate(text: string): {
    ok: boolean;
    reason: string;
    kind: KnowledgeHarvestSuggestion["kind"];
    score: number;
};
