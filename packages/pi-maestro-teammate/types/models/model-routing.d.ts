import type { RunTeammateParams } from "../runs/execution.ts";
import { type TeammateThinkingLevel } from "../shared/thinking.ts";
export declare const TEAMMATE_TASK_TYPES: readonly ["explore", "analysis", "debug", "planning", "development", "review", "testing"];
export type TeammateTaskType = (typeof TEAMMATE_TASK_TYPES)[number];
export declare const TEAMMATE_TASK_TYPE_META: Record<TeammateTaskType, {
    label: string;
    roles: string;
    description: string;
}>;
export interface ModelRoutingConfig {
    version: 2;
    mappings: Partial<Record<TeammateTaskType, string | null>>;
    thinkingLevels: Partial<Record<TeammateTaskType, TeammateThinkingLevel | null>>;
}
export interface TaskTypeInput {
    taskType?: TeammateTaskType;
    prompt?: string;
    agent?: string;
    task?: string;
}
export declare function getGlobalModelRoutingPath(): string;
export declare function getProjectModelRoutingPath(cwd: string): string;
export declare function loadModelRoutingConfig(cwd: string): ModelRoutingConfig;
export declare function saveProjectThinkingLevel(cwd: string, taskType: TeammateTaskType, thinking: TeammateThinkingLevel | null): ModelRoutingConfig;
export declare function saveProjectModelMapping(cwd: string, taskType: TeammateTaskType, model: string | null): ModelRoutingConfig;
export declare function inferTaskType(input: TaskTypeInput): TeammateTaskType | undefined;
export declare function applyModelRouting(params: RunTeammateParams, cwd: string, availableModels?: readonly string[]): RunTeammateParams;
export declare function formatModelRoutingConfig(cwd: string): string;
