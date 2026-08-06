import { type TeammateThinkingLevel } from "../shared/thinking.ts";
export interface AvailableModelEntry {
    provider: string;
    id: string;
    name?: string;
    reasoning?: boolean;
    thinkingLevelMap?: Partial<Record<TeammateThinkingLevel, string | null>>;
    /** Supported input modalities; `image` marks a vision-capable model. */
    input?: readonly ("text" | "image")[];
}
export interface TeammateModelCapability {
    id: string;
    reasoning?: boolean;
    thinkingLevels?: readonly TeammateThinkingLevel[];
    /** Supported input modalities, when declared. */
    input?: readonly ("text" | "image")[];
}
export declare function isMultimodalEntry(model: AvailableModelEntry | TeammateModelCapability): boolean;
export interface ModelCatalogSnapshot {
    signature: string;
    systemPrompt: string;
    modelIds: string[];
    models: TeammateModelCapability[];
}
/**
 * Declared thinking depth support for a model. The teammate layer never
 * restricts thinking depth: a reasoning model is advertised as supporting the
 * full level range, and the child Pi host clamps to its own provider-specific
 * capability boundary when a level cannot be honored. The model's
 * thinkingLevelMap is advisory (how a level maps to a provider parameter),
 * not an availability gate.
 */
export declare function supportedThinkingLevels(model: AvailableModelEntry): TeammateThinkingLevel[] | undefined;
export declare function createModelCatalogSnapshot(models: AvailableModelEntry[]): ModelCatalogSnapshot;
export declare function appendModelCatalog(systemPrompt: string, snapshot: ModelCatalogSnapshot): string;
