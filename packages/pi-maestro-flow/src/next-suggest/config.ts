/**
 * Next-step suggestion configuration.
 *
 * Settings are independent of the session model and persist in the API
 * manager file (`api-manager.json`, nextSuggest section) so the model
 * selection and the feature itself stay co-located with the API manager UI.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  fileExists,
  isRecord,
  readModelsRoot,
  serializeMutation,
  writeModelsRoot,
} from "../providers/api-provider-ops.ts";

export const NEXT_SUGGEST_SECTION = "nextSuggest";

/** Sentinel returned by the model when no plausible next message exists. */
export const NO_SUGGESTION_TOKEN = "__NO_SUGGESTION__";

/** Keys the suggestion accept shortcut may use (registerShortcut has no unregister surface). */
export type NextSuggestAcceptKey = "f2" | "alt+shift+n";

export interface NextSuggestConfig {
  /** Master switch for the feature. */
  enabled: boolean;
  /**
   * Model used to generate suggestions.
   * - "session": follow the currently selected session model.
   * - "provider/modelId": pin a dedicated model from models.json.
   */
  modelRef: string;
  /** Thinking level for the generation call; "default" follows the session. */
  thinking: ThinkingLevel | "default";
  /** Maximum length of a suggested prompt, in characters. */
  maxSuggestionChars: number;
  /** Shortcut key that accepts the suggestion into the editor. */
  acceptKey: NextSuggestAcceptKey;
}

export const DEFAULT_NEXT_SUGGEST_CONFIG: NextSuggestConfig = {
  enabled: false,
  modelRef: "session",
  thinking: "default",
  maxSuggestionChars: 200,
  acceptKey: "f2",
};

function normalizeConfig(value: unknown): NextSuggestConfig {
  const record = isRecord(value) ? value : {};
  const enabled = record.enabled === undefined ? DEFAULT_NEXT_SUGGEST_CONFIG.enabled : Boolean(record.enabled);
  const modelRef = typeof record.modelRef === "string" && record.modelRef.trim().length > 0
    ? record.modelRef.trim()
    : DEFAULT_NEXT_SUGGEST_CONFIG.modelRef;
  const thinking = typeof record.thinking === "string" && record.thinking !== "default"
    ? (record.thinking as ThinkingLevel)
    : DEFAULT_NEXT_SUGGEST_CONFIG.thinking;
  const maxSuggestionChars = typeof record.maxSuggestionChars === "number" && record.maxSuggestionChars > 0
    ? Math.min(Math.floor(record.maxSuggestionChars), 2000)
    : DEFAULT_NEXT_SUGGEST_CONFIG.maxSuggestionChars;
  const acceptKey = record.acceptKey === "alt+shift+n"
    ? "alt+shift+n"
    : DEFAULT_NEXT_SUGGEST_CONFIG.acceptKey;
  return { enabled, modelRef, thinking, maxSuggestionChars, acceptKey };
}

export async function loadNextSuggestConfig(defaultsPath: string): Promise<NextSuggestConfig> {
  if (!await fileExists(defaultsPath)) return { ...DEFAULT_NEXT_SUGGEST_CONFIG };
  const root = await readModelsRoot(defaultsPath);
  return normalizeConfig(root[NEXT_SUGGEST_SECTION]);
}

export async function saveNextSuggestConfig(
  config: NextSuggestConfig,
  defaultsPath: string,
): Promise<void> {
  await serializeMutation(defaultsPath, async () => {
    const exists = await fileExists(defaultsPath);
    const root = await readModelsRoot(defaultsPath);
    await writeModelsRoot(
      { ...root, version: 1, [NEXT_SUGGEST_SECTION]: { ...config } },
      defaultsPath,
      exists,
    );
  });
}
