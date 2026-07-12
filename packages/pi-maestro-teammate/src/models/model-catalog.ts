export interface AvailableModelEntry {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

export interface ModelCatalogSnapshot {
  signature: string;
  systemPrompt: string;
  modelIds: string[];
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
  const lines = entries.length > 0
    ? entries.map((model) => `- ${model.provider}/${model.id}${model.reasoning ? " [reasoning]" : ""}`)
    : ["- (none; configure provider authentication before selecting a teammate model)"];

  return {
    signature: entries
      .map((model) => `${model.provider}/${model.id}:${model.reasoning ? "reasoning" : "standard"}`)
      .join("\n"),
    modelIds,
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
