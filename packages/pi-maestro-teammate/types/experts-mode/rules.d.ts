import type { ExpertsRules } from "./types.ts";
/** Project-level override (merged over package defaults). */
export declare const PROJECT_RULES_FILENAME = ".experts-rules.json";
/**
 * Load experts rules: package default-rules.json, optionally merged with
 * `<cwd>/.experts-rules.json` (shallow + settle/hardGate/stagePolicies deep-ish merge).
 * Missing/corrupt base file falls back to BUILTIN_FALLBACK_RULES instead of throwing.
 */
export declare function loadRules(rulesPath?: string, cwd?: string): ExpertsRules;
export declare function clearRulesCache(): void;
export declare function defaultRulesPath(): string;
export declare function projectRulesPath(cwd?: string): string;
/** Shallow merge with nested merge for settle / hardGate / stagePolicies / roster / stageAliases. */
export declare function mergeRules(base: ExpertsRules, overlay: ExpertsRules): ExpertsRules;
/**
 * M5: deep-merge roster / expertProfiles maps so a project overlay that only
 * sets skills/model does not wipe package defaults (agent, capabilities, …).
 * Overlay field wins when defined; arrays are replaced (not concatenated).
 */
export declare function mergeRosterMaps<T extends Record<string, unknown> = Record<string, unknown>>(base: Record<string, T> | undefined, overlay: Record<string, T> | undefined): Record<string, T>;
