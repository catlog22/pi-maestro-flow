import { type TeammateThinkingLevel } from "../shared/thinking.ts";
export interface AvailableModelEntry {
    provider: string;
    id: string;
    name?: string;
    reasoning?: boolean;
    thinkingLevelMap?: Partial<Record<TeammateThinkingLevel, string | null>>;
}
export interface TeammateModelCapability {
    id: string;
    reasoning?: boolean;
    thinkingLevels?: readonly TeammateThinkingLevel[];
}
export interface ModelCatalogSnapshot {
    signature: string;
    systemPrompt: string;
    modelIds: string[];
    models: TeammateModelCapability[];
}
export declare function supportedThinkingLevels(model: AvailableModelEntry): TeammateThinkingLevel[] | undefined;
export declare function createModelCatalogSnapshot(models: AvailableModelEntry[]): ModelCatalogSnapshot;
export declare function appendModelCatalog(systemPrompt: string, snapshot: ModelCatalogSnapshot): string;
