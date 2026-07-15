import {
  TEAMMATE_THINKING_LEVELS,
  parseTeammateThinkingLevel,
  type TeammateThinkingLevel,
} from "../shared/thinking.ts";

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

export function supportedThinkingLevels(model: AvailableModelEntry): TeammateThinkingLevel[] | undefined {
  if (model.reasoning === false) return ["off"];
  if (model.reasoning !== true) return undefined;

  return TEAMMATE_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level !== "xhigh" || mapped !== undefined;
  });
}

const START_MARKER = "<available_teammate_models>";
const END_MARKER = "</available_teammate_models>";

function normalizedEntries(models: AvailableModelEntry[]): AvailableModelEntry[] {
  const entries = new Map<string, AvailableModelEntry>();
  for (const model of models) {
    const provider = model.provider.trim();
    const id = model.id.trim();
    if (!provider || !id) continue;
    const key = `${provider}/${id}`;
    if (!entries.has(key)) entries.set(key, { ...model, provider, id });
  }
  return [...entries.values()].sort((left, right) =>
    `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`),
  );
}

export function createModelCatalogSnapshot(models: AvailableModelEntry[]): ModelCatalogSnapshot {
  const entries = normalizedEntries(models);
  const modelIds = entries.map((model) => `${model.provider}/${model.id}`);
  const capabilities = entries.map((model) => {
    const thinkingLevels = supportedThinkingLevels(model);
    return {
      id: `${model.provider}/${model.id}`,
      reasoning: model.reasoning,
      thinkingLevels,
    };
  });
  const lines = capabilities.length > 0
    ? capabilities.map((model) => {
      const levels = model.thinkingLevels;
      const thinking = levels ? ` [thinking:${levels.join(",")}]` : model.reasoning ? " [reasoning]" : "";
      return `- ${model.id}${thinking}`;
    })
    : ["- (none; configure provider authentication before selecting a teammate model)"];

  return {
    signature: capabilities
      .map((model) => `${model.id}:${model.reasoning ?? "unknown"}:${model.thinkingLevels?.join(",") ?? "unknown"}`)
      .join("\n"),
    modelIds,
    models: capabilities,
    systemPrompt: `${START_MARKER}\nAvailable authenticated models for the teammate tool:\n${lines.join("\n")}\n\nUse an exact provider/model identifier in the top-level model field or a task-level model field. Task-level model overrides the top-level default.\n${END_MARKER}`,
  };
}

export function appendModelCatalog(
  systemPrompt: string,
  snapshot: ModelCatalogSnapshot,
): string {
  const start = systemPrompt.indexOf(START_MARKER);
  const end = systemPrompt.indexOf(END_MARKER);
  if (start >= 0 && end >= start) {
    return `${systemPrompt.slice(0, start)}${snapshot.systemPrompt}${systemPrompt.slice(end + END_MARKER.length)}`;
  }
  return `${systemPrompt}\n\n${snapshot.systemPrompt}`;
}
