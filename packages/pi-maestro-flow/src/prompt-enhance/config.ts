/**
 * Prompt-enhance configuration.
 *
 * Settings persist in the API manager file (`api-manager.json`, `enhance`
 * section) so the model selection and feature switches stay co-located with
 * the API manager UI, mirroring the next-suggest pattern.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  fileExists,
  isRecord,
  readModelsRoot,
  serializeMutation,
  writeModelsRoot,
} from "../providers/api-provider-ops.ts";

export const ENHANCE_SECTION = "enhance";

/** Thinking levels the enhancer accepts; "default" follows the session. */
const ENHANCE_THINKING_LEVELS: readonly (ThinkingLevel | "default")[] = [
  "default", "minimal", "low", "medium", "high", "xhigh", "max",
];

/** How much surrounding context the enhancer may gather. */
export type EnhanceContextDepth = "none" | "session" | "codebase";

export interface EnhanceConfig {
  /** Master switch for the feature (on by default — enhance is opt-in per invocation). */
  enabled: boolean;
  /**
   * Model used to enhance prompts.
   * - "session": follow the currently selected session model.
   * - "provider/modelId": pin a dedicated model from models.json.
   */
  modelRef: string;
  /** Thinking level for the generation call; "default" follows the session. */
  thinking: ThinkingLevel | "default";
  /** Maximum length of an enhanced prompt, in characters. */
  maxChars: number;
  /** How much context to gather: none / session / codebase (default). */
  contextDepth: EnhanceContextDepth;
  /** Whether to include recent git log lines. */
  includeGit: boolean;
  /** Maximum number of referenced files whose contents are read. */
  maxFiles: number;
  /** Whether to search the Maestro knowledge base for grounding hits. */
  knowledgeSearch: boolean;
  /** Number of knowledge hits to feed the enhancer (top-N). */
  knowledgeTopN: number;
}

export const DEFAULT_ENHANCE_CONFIG: EnhanceConfig = {
  enabled: true,
  modelRef: "session",
  thinking: "default",
  maxChars: 2000,
  contextDepth: "codebase",
  includeGit: true,
  maxFiles: 3,
  knowledgeSearch: true,
  knowledgeTopN: 5,
};

const CONTEXT_DEPTHS: readonly EnhanceContextDepth[] = ["none", "session", "codebase"];

function normalizeConfig(value: unknown): EnhanceConfig {
  const record = isRecord(value) ? value : {};
  const enabled = record.enabled === undefined ? DEFAULT_ENHANCE_CONFIG.enabled : Boolean(record.enabled);
  const modelRef = typeof record.modelRef === "string" && record.modelRef.trim().length > 0
    ? record.modelRef.trim()
    : DEFAULT_ENHANCE_CONFIG.modelRef;
  const thinking = typeof record.thinking === "string" &&
    (ENHANCE_THINKING_LEVELS as readonly string[]).includes(record.thinking)
    ? (record.thinking as ThinkingLevel | "default")
    : DEFAULT_ENHANCE_CONFIG.thinking;
  const maxChars = typeof record.maxChars === "number" && record.maxChars >= 1
    ? Math.min(Math.floor(record.maxChars), 8000)
    : DEFAULT_ENHANCE_CONFIG.maxChars;
  const contextDepth = typeof record.contextDepth === "string" &&
    CONTEXT_DEPTHS.includes(record.contextDepth as EnhanceContextDepth)
    ? (record.contextDepth as EnhanceContextDepth)
    : DEFAULT_ENHANCE_CONFIG.contextDepth;
  const includeGit = record.includeGit === undefined
    ? DEFAULT_ENHANCE_CONFIG.includeGit
    : Boolean(record.includeGit);
  const maxFiles = typeof record.maxFiles === "number" && record.maxFiles >= 0
    ? Math.min(Math.floor(record.maxFiles), 10)
    : DEFAULT_ENHANCE_CONFIG.maxFiles;
  const knowledgeSearch = record.knowledgeSearch === undefined
    ? DEFAULT_ENHANCE_CONFIG.knowledgeSearch
    : Boolean(record.knowledgeSearch);
  const knowledgeTopN = typeof record.knowledgeTopN === "number" && record.knowledgeTopN > 0
    ? Math.min(Math.floor(record.knowledgeTopN), 20)
    : DEFAULT_ENHANCE_CONFIG.knowledgeTopN;
  return { enabled, modelRef, thinking, maxChars, contextDepth, includeGit, maxFiles, knowledgeSearch, knowledgeTopN };
}

export async function loadEnhanceConfig(defaultsPath: string): Promise<EnhanceConfig> {
  if (!await fileExists(defaultsPath)) return { ...DEFAULT_ENHANCE_CONFIG };
  const root = await readModelsRoot(defaultsPath);
  return normalizeConfig(root[ENHANCE_SECTION]);
}

export async function saveEnhanceConfig(
  config: EnhanceConfig,
  defaultsPath: string,
): Promise<void> {
  await serializeMutation(defaultsPath, async () => {
    const exists = await fileExists(defaultsPath);
    const root = await readModelsRoot(defaultsPath);
    await writeModelsRoot(
      { ...root, version: 1, [ENHANCE_SECTION]: { ...config } },
      defaultsPath,
      exists,
    );
  });
}
