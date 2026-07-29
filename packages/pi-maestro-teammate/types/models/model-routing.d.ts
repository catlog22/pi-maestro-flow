import type { RunTeammateParams } from "../runs/execution.ts";
import { type TeammateTaskType } from "../shared/task-types.ts";
import { type TeammateThinkingLevel } from "../shared/thinking.ts";
export { TEAMMATE_TASK_TYPES, parseTeammateTaskType } from "../shared/task-types.ts";
export type { TeammateTaskType } from "../shared/task-types.ts";
export declare const TEAMMATE_TASK_TYPE_META: Record<string, {
    label: string;
    roles: string;
    description: string;
}>;
export interface ModelRoutingConfig {
    version: 2;
    mappings: Partial<Record<TeammateTaskType, string | null>>;
    fallbackMappings?: Partial<Record<TeammateTaskType, string[] | null>>;
    thinkingLevels: Partial<Record<TeammateTaskType, TeammateThinkingLevel | null>>;
}
export interface TaskTypeInput {
    taskType?: TeammateTaskType;
    agent?: string;
    task?: string;
}
export declare function getGlobalModelRoutingPath(): string;
export declare function getProjectModelRoutingPath(cwd: string): string;
export declare function loadModelRoutingConfig(cwd: string): ModelRoutingConfig;
export declare function discoverRoutingTaskTypes(cwd: string, agents?: readonly {
    taskType?: TeammateTaskType;
}[]): TeammateTaskType[];
export declare function saveProjectThinkingLevel(cwd: string, taskType: TeammateTaskType, thinking: TeammateThinkingLevel | null): ModelRoutingConfig;
export declare function saveProjectModelMapping(cwd: string, taskType: TeammateTaskType, model: string | null): ModelRoutingConfig;
export declare function saveProjectFallbackMapping(cwd: string, taskType: TeammateTaskType, models: string[] | null): ModelRoutingConfig;
export declare function inferTaskType(input: TaskTypeInput): TeammateTaskType | undefined;
export declare function applyModelRouting(params: RunTeammateParams, cwd: string, availableModels?: readonly string[]): RunTeammateParams;
export declare function formatModelRoutingConfig(cwd: string, agents?: readonly {
    taskType?: TeammateTaskType;
}[]): string;
