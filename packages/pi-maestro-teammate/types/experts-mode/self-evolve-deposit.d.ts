import type { KnowledgeHarvestSuggestion } from "./types.ts";
/**
 * P7b: deposit experts harvest suggestions into the self-evolve *pending*
 * suggestions pool (`~/.maestro/self-evolve/suggestions/YYYY-MM-DD.jsonl`).
 *
 * Compatible with SelfEvolveSignal schema (schemaVersion 1, kind candidate)
 * so `/self-evolve review` and auto-deposit can see them later.
 *
 * Never promotes. Never runs `maestro knowledge stage` here — that stays on
 * self-evolve auto-deposit after human/LLM review, or Leader manual stage.
 */
export interface SelfEvolvePoolDepositResult {
    written: number;
    skipped: number;
    filePath?: string;
    ids: string[];
    errors: string[];
}
export interface DepositToSelfEvolvePoolOptions {
    /** Override output root (default ~/.maestro/self-evolve or SELF_EVOLVE_OUTPUT_DIR). */
    outputRoot?: string;
    cwd?: string;
    sessionId?: string;
    runId?: string;
    project?: string;
    /** Skip ids already present in today's file (default true). */
    dedupe?: boolean;
}
export declare function selfEvolveOutputRoot(envValue?: string): string;
export declare function suggestionsDirPath(outputRoot: string): string;
export declare function dailySuggestionFileName(date?: Date): string;
/** Map harvest suggestion → SelfEvolveSignal-compatible record. */
export declare function harvestToSelfEvolveSignal(suggestion: KnowledgeHarvestSuggestion, opts?: {
    sessionId?: string;
    runId?: string;
    project?: string;
}): Record<string, unknown>;
/**
 * Append harvest suggestions to today's self-evolve suggestions jsonl.
 */
export declare function depositHarvestToSelfEvolvePool(suggestions: readonly KnowledgeHarvestSuggestion[], opts?: DepositToSelfEvolvePoolOptions): SelfEvolvePoolDepositResult;
