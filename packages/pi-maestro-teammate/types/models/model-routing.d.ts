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
export interface ModelRoutingRules {
    mappings: Partial<Record<TeammateTaskType, string | null>>;
    fallbackMappings?: Partial<Record<TeammateTaskType, string[] | null>>;
    thinkingLevels: Partial<Record<TeammateTaskType, TeammateThinkingLevel | null>>;
}
export interface ModelRoutingProfile extends ModelRoutingRules {
    name: string;
}
export interface GlobalModelRoutingStore {
    version: 3;
    defaultProfile: string;
    profiles: Record<string, ModelRoutingProfile>;
    retiredProfileIds?: string[];
}
export interface ProjectModelRoutingStore {
    version: 3;
    activeProfile?: string;
    applyOverrides: boolean;
    overrides: ModelRoutingRules;
}
export interface ModelRoutingConfig extends ModelRoutingRules {
    version: 3;
    profileId: string;
    profileName: string;
    projectOverridesEnabled: boolean;
}
export interface ModelRoutingState {
    global: GlobalModelRoutingStore;
    project: ProjectModelRoutingStore;
    config: ModelRoutingConfig;
    requestedProfile?: string;
    missingProfile?: string;
    changedProfileId?: string;
}
export interface TaskTypeInput {
    taskType?: TeammateTaskType;
    agent?: string;
    task?: string;
}
export declare function getGlobalModelRoutingPath(): string;
export declare function getProjectModelRoutingPath(cwd: string): string;
export declare function loadModelRoutingState(cwd: string, globalFilePath?: string): ModelRoutingState;
export declare function loadModelRoutingConfig(cwd: string, globalFilePath?: string): ModelRoutingConfig;
export interface ModelRoutingStorePair {
    global: GlobalModelRoutingStore;
    project: ProjectModelRoutingStore;
}
export interface ModelRoutingStoreContentPair {
    global: string;
    project: string;
}
/** @internal Shared persistence bridge for the unified Settings provider. */
export declare function loadModelRoutingStores(globalFilePath: string, projectFilePath: string): ModelRoutingStorePair;
/** @internal Publish a prepared Settings transaction through the routing lock/journal protocol. */
export declare function replaceModelRoutingStores(globalFilePath: string, projectFilePath: string, expected: ModelRoutingStorePair, next: ModelRoutingStorePair, expectedContent?: ModelRoutingStoreContentPair): ModelRoutingStorePair;
export declare function discoverRoutingTaskTypes(cwd: string, agents?: readonly {
    taskType?: TeammateTaskType;
}[], loadedConfig?: ModelRoutingConfig): TeammateTaskType[];
export declare function saveProjectThinkingLevel(cwd: string, taskType: TeammateTaskType, thinking: TeammateThinkingLevel | null, globalFilePath?: string): ModelRoutingConfig;
export declare function saveProjectModelMapping(cwd: string, taskType: TeammateTaskType, model: string | null, globalFilePath?: string): ModelRoutingConfig;
export declare function saveProjectFallbackMapping(cwd: string, taskType: TeammateTaskType, models: string[] | null, globalFilePath?: string): ModelRoutingConfig;
export declare function saveGlobalProfileModelMapping(cwd: string, profileId: string, taskType: TeammateTaskType, model: string | null, globalFilePath?: string): ModelRoutingState;
export declare function saveGlobalProfileThinkingLevel(cwd: string, profileId: string, taskType: TeammateTaskType, thinking: TeammateThinkingLevel | null, globalFilePath?: string): ModelRoutingState;
export declare function saveGlobalProfileFallbackMapping(cwd: string, profileId: string, taskType: TeammateTaskType, models: string[] | null, globalFilePath?: string): ModelRoutingState;
export declare function createGlobalModelRoutingProfile(cwd: string, name: string, sourceProfileId?: string, globalFilePath?: string): ModelRoutingState;
export declare function createAndActivateGlobalModelRoutingProfile(cwd: string, name: string, sourceProfileId?: string, globalFilePath?: string): ModelRoutingState;
export declare function renameGlobalModelRoutingProfile(cwd: string, profileId: string, name: string, globalFilePath?: string): ModelRoutingState;
export declare function setDefaultGlobalModelRoutingProfile(cwd: string, profileId: string, globalFilePath?: string): ModelRoutingState;
export declare function setProjectActiveModelRoutingProfile(cwd: string, profileId: string, globalFilePath?: string): ModelRoutingState;
export declare function setProjectModelRoutingOverridesEnabled(cwd: string, enabled: boolean, globalFilePath?: string): ModelRoutingState;
export declare function clearProjectModelRoutingOverrides(cwd: string, globalFilePath?: string): ModelRoutingState;
export declare function promoteProjectModelRoutingOverrides(cwd: string, name: string, globalFilePath?: string): ModelRoutingState;
export declare function deleteGlobalModelRoutingProfile(cwd: string, profileId: string, globalFilePath?: string): ModelRoutingState;
export declare function inferTaskType(input: TaskTypeInput): TeammateTaskType | undefined;
export declare function applyModelRouting(params: RunTeammateParams, cwd: string, availableModels?: readonly string[], globalFilePath?: string): RunTeammateParams;
export declare function formatModelRoutingConfig(cwd: string, agents?: readonly {
    taskType?: TeammateTaskType;
}[]): string;
