export declare const TEAMMATE_TASK_TYPES: readonly ["explore", "analysis", "debug", "planning", "development", "review", "testing"];
/** Built-in types remain ordered defaults; custom agents may declare more. */
export type TeammateTaskType = string;
export declare function parseTeammateTaskType(value: unknown): TeammateTaskType | undefined;
