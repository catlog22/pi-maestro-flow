import type { ExpertsMode, ExpertsRules, GateResult, RewriteSuggestion } from "./types.ts";
export interface HardGateOptions {
    mode?: ExpertsMode;
    cwd?: string;
    rules?: ExpertsRules;
    /** Tool arguments (write path, bash command, …). */
    toolInput?: unknown;
    /** Optional Maestro stage override; falls back to activeStage / MAESTRO_STAGE. */
    stage?: string;
    /**
     * CV-01: who is calling the tool.
     * - leader (default): hard-gate applies
     * - expert: teammate child / relayed permission — always allow
     */
    caller?: "leader" | "expert";
}
/**
 * P5 Lead discipline hard-gate for tool calls under Experts Mode.
 *
 * Defaults (default-rules): write/edit/bash → deny, with:
 * - path allowlist for orchestration artifacts (report/outputs/.workflow/notes)
 * - bash allowlist for maestro/git-read/test/search commands
 * - deny reason always carries rewriteSuggestion → teammate + taskType
 */
export declare function evaluateHardGate(toolName: string, opts?: HardGateOptions): GateResult;
/**
 * Build a teammate rewrite suggestion for a blocked heavy tool call.
 * Pure helper — safe to call from adapters without re-evaluating the gate.
 */
export declare function buildRewriteSuggestion(toolName: string, toolInput: unknown, stage: string | undefined, rules?: ExpertsRules, cwd?: string): RewriteSuggestion;
/**
 * H2: reject shell chaining / substitution that can bypass bash prefix allowlist.
 * True means the command is unsafe for Leader allowlist even if prefix matches.
 */
export declare function hasDangerousShellMetachar(command: string): boolean;
export declare function formatDenyReason(toolName: string, rewrite: RewriteSuggestion): string;
export declare function formatAskReason(toolName: string, rewrite: RewriteSuggestion): string;
/** Prefix match with word boundary so "npm test" does not allow "npm testify". */
export declare function bashPrefixMatches(command: string, prefix: string): boolean;
/**
 * Minimal glob matcher: supports ** and * segments, case-insensitive on win.
 */
export declare function matchPathPattern(filePath: string, pattern: string, cwd?: string): boolean;
export declare function isHeavyMutationTool(toolName: string): boolean;
