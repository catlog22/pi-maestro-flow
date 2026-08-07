/**
 * Agent discovery and configuration.
 *
 * Discovers agent definitions from package, compatible project, and user locations.
 * Precedence: package > project .pi/agents > project .agents > user global dirs > builtin.
 */
import { type TeammateTaskType } from "../shared/task-types.ts";
import { type TeammateThinkingLevel } from "../shared/thinking.ts";
type SystemPromptMode = "append" | "replace";
export type AgentSource = "builtin" | "package" | "user" | "project";
export declare const BUILTIN_AGENT_NAMES: readonly ["general", "explorer", "planner", "analyst", "research", "verifier", "workflow"];
export type BuiltinAgentName = (typeof BUILTIN_AGENT_NAMES)[number];
export declare const PUBLIC_BUILTIN_AGENT_NAMES: readonly ["general", "explorer", "planner", "analyst", "research", "verifier", "workflow"];
export interface AgentConfig {
    name: string;
    description: string;
    tools?: string[];
    model?: string;
    fallbackModels?: string[];
    taskType?: TeammateTaskType;
    thinking?: TeammateThinkingLevel;
    systemPromptMode: SystemPromptMode;
    inheritProjectContext: boolean;
    inheritSkills: boolean;
    defaultContext?: "fresh" | "fork";
    systemPrompt: string;
    source: AgentSource;
    filePath: string;
}
export interface AgentSummary {
    name: string;
    description: string;
    source: AgentSource;
}
export interface AgentCatalogSnapshot {
    signature: string;
    systemPrompt: string;
}
export declare function isBuiltinAgentName(name: string): name is BuiltinAgentName;
/**
 * Discover all agent definitions, merged by priority:
 * package > project > user > builtin (name collisions: higher priority wins).
 */
export declare function discoverAgents(cwd: string, homeDir?: string): AgentConfig[];
/**
 * Resolve a single agent by name.
 */
export declare function resolveAgent(cwd: string, agentName: string): AgentConfig | undefined;
/** Return resolved role metadata without exposing the role prompt body. */
export declare function listAgentSummaries(cwd: string, homeDir?: string): AgentSummary[];
/** Format a compact, deterministic role catalog for teammate tool metadata. */
export declare function formatAgentCatalog(cwd: string, maxRoles?: number, maxDescriptionLength?: number): string;
/**
 * Hit/miss counters for the role catalog cache, reset by
 * {@link invalidateAgentCatalogCache}. Observability only; never consulted
 * for cache decisions.
 */
export declare const agentCatalogCacheStats: {
    hits: number;
    misses: number;
};
/**
 * Drop every cached catalog snapshot. Called when the extension re-registers
 * (reload); cwd changes and role additions/edits invalidate themselves via the
 * cache key and manifest signature respectively.
 */
export declare function invalidateAgentCatalogCache(): void;
/** Build the compact role directory appended to the active parent prompt. */
export declare function createAgentCatalogSnapshot(cwd: string, maxDescriptionLength?: number): AgentCatalogSnapshot;
/** Replace an existing role directory or append a fresh one to the prompt. */
export declare function appendAgentCatalog(systemPrompt: string, cwd: string): string;
export {};
