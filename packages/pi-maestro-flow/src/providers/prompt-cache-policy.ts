// Unified prompt-cache policy for OpenAI-format providers.
//
// pi-ai sends OpenAI prompt-cache parameters on requests when the model declares
// matching compat flags (see @earendil-works/pi-ai openai-responses):
// - compat.supportsExplicitPromptCacheMode -> sends
//   `prompt_cache_options: { mode: "explicit" }` when cache retention is "none"
//   (compaction / branch-summary requests);
// - compat.supportsLongCacheRetention -> sends `prompt_cache_retention: "24h"`
//   when cache retention is "long".
// Strict gateways reject these parameters ("Unsupported parameter:
// prompt_cache_options"), so the API Manager exposes a unified policy to control
// them client-side without touching the gateway:
// - "off" (default): never advertise the flags -> pi never sends the parameters;
// - "auto": advertise the flags only for models that actually support them
//   (gpt-5.6 and later, per the OpenAI prompt-caching contract);
// - "on": always advertise the flags (admin opt-in for cache-capable upstreams).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  fileExists,
  isErrno,
  isRecord,
  readModelsRoot,
  serializeMutation,
  writeModelsRoot,
} from "./api-provider-ops.ts";

export type PromptCachePolicy = "auto" | "off" | "on";

export const PROMPT_CACHE_POLICIES: readonly PromptCachePolicy[] = ["auto", "off", "on"] as const;

/** "off" keeps the historical behavior: no cache parameters are sent, no gateway 400. */
export const PROMPT_CACHE_POLICY_DEFAULT: PromptCachePolicy = "off";

/** settings.json root key holding the policy (camelCase, matching sibling settings). */
const PROMPT_CACHE_SETTINGS_KEY = "promptCache";

export function isPromptCachePolicy(value: unknown): value is PromptCachePolicy {
  return value === "auto" || value === "off" || value === "on";
}

/**
 * Cache tier pi-ai applies to requests: "short" (5m on Anthropic, implicit
 * 30m on OpenAI), "long" (1h on Anthropic, 24h retention on OpenAI) or "none"
 * (no caching parameters at all).
 */
export type CacheRetention = "short" | "long" | "none";

/** Main-flow cache tier; "auto" leaves any existing PI_CACHE_RETENTION env untouched. */
export type CacheRetentionSetting = CacheRetention | "auto";

export const CACHE_RETENTION_DEFAULT: CacheRetention = "short";
export const CACHE_RETENTION_SETTING_DEFAULT: CacheRetentionSetting = "auto";
export const AGENT_CACHE_RETENTION_DEFAULT: CacheRetention = "short";

const CACHE_RETENTION_SETTINGS_KEY = "cacheRetention";
const AGENT_CACHE_RETENTION_SETTINGS_KEY = "agentCacheRetention";

export function isCacheRetention(value: unknown): value is CacheRetention {
  return value === "short" || value === "long" || value === "none";
}

export function isCacheRetentionSetting(value: unknown): value is CacheRetentionSetting {
  return value === "auto" || isCacheRetention(value);
}

export function isAgentCacheRetention(value: unknown): value is CacheRetention {
  return isCacheRetention(value);
}

/** Whether an API format speaks the OpenAI prompt-cache parameter vocabulary. */
export function isOpenAIFormatApi(api: string | undefined): boolean {
  return api === "openai-responses" || api === "openai-completions" || api === "azure-openai-responses";
}

/**
 * Whether the model accepts the OpenAI `prompt_cache_options` / `prompt_cache_retention`
 * request parameters. OpenAI supports them on gpt-5.6 and later models only;
 * gpt-5.5 / gpt-5.4 / o3 and non-OpenAI models reject them upstream.
 */
export function supportsOpenAIPromptCacheOptions(modelId: string): boolean {
  const match = /^gpt-(\d+)(?:\.(\d+))?/.exec(modelId.trim().toLowerCase());
  if (!match) return false;
  const major = Number(match[1]);
  if (major > 5) return true;
  if (major < 5) return false;
  const minor = match[2] === undefined ? -1 : Number(match[2]);
  return minor >= 6;
}

export interface PromptCacheCompatFlags {
  supportsExplicitPromptCacheMode: boolean;
  supportsLongCacheRetention: boolean;
}

export function promptCacheCompatFlags(policy: PromptCachePolicy, modelId: string): PromptCacheCompatFlags {
  if (policy === "on") {
    return { supportsExplicitPromptCacheMode: true, supportsLongCacheRetention: true };
  }
  if (policy === "off") {
    return { supportsExplicitPromptCacheMode: false, supportsLongCacheRetention: false };
  }
  const supported = supportsOpenAIPromptCacheOptions(modelId);
  return { supportsExplicitPromptCacheMode: supported, supportsLongCacheRetention: supported };
}

export function defaultPromptCacheSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

/** Main-flow cache tier from settings.json; "auto" (default) keeps the env untouched. */
export async function loadCacheRetentionSetting(
  settingsPath = defaultPromptCacheSettingsPath(),
): Promise<CacheRetentionSetting> {
  const root = await readModelsRoot(settingsPath);
  const value = root[CACHE_RETENTION_SETTINGS_KEY];
  return isCacheRetentionSetting(value) ? value : CACHE_RETENTION_SETTING_DEFAULT;
}

export function loadCacheRetentionSettingSync(settingsPath: string): CacheRetentionSetting {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    const value = isRecord(parsed) ? parsed[CACHE_RETENTION_SETTINGS_KEY] : undefined;
    return isCacheRetentionSetting(value) ? value : CACHE_RETENTION_SETTING_DEFAULT;
  } catch {
    return CACHE_RETENTION_SETTING_DEFAULT;
  }
}

/** Agent-subprocess cache tier from settings.json; defaults to the short tier. */
export async function loadAgentCacheRetention(
  settingsPath = defaultPromptCacheSettingsPath(),
): Promise<CacheRetention> {
  const root = await readModelsRoot(settingsPath);
  const value = root[AGENT_CACHE_RETENTION_SETTINGS_KEY];
  return isAgentCacheRetention(value) ? value : AGENT_CACHE_RETENTION_DEFAULT;
}

export function loadAgentCacheRetentionSync(settingsPath: string): CacheRetention {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    const value = isRecord(parsed) ? parsed[AGENT_CACHE_RETENTION_SETTINGS_KEY] : undefined;
    return isAgentCacheRetention(value) ? value : AGENT_CACHE_RETENTION_DEFAULT;
  } catch {
    return AGENT_CACHE_RETENTION_DEFAULT;
  }
}

/**
 * Apply the persisted tiers to this process: the main-flow tier lands on
 * PI_CACHE_RETENTION (read by pi-ai per request) and the agent tier on
 * PI_TEAMMATE_CACHE_RETENTION (read by the teammate spawn pin). "auto" leaves
 * an existing PI_CACHE_RETENTION untouched so a user-set env wins.
 */
export function applyCacheRetentionEnv(
  settingsPath = defaultPromptCacheSettingsPath(),
): void {
  const main = loadCacheRetentionSettingSync(settingsPath);
  if (main !== "auto") process.env.PI_CACHE_RETENTION = main;
  process.env.PI_TEAMMATE_CACHE_RETENTION = loadAgentCacheRetentionSync(settingsPath);
}

export async function saveCacheRetentionSetting(
  retention: CacheRetentionSetting,
  settingsPath = defaultPromptCacheSettingsPath(),
): Promise<void> {
  if (!isCacheRetentionSetting(retention)) {
    throw new Error(`Invalid cache retention setting: ${String(retention)}`);
  }
  await serializeMutation(settingsPath, async () => {
    const root = await readModelsRoot(settingsPath);
    await writeModelsRoot(
      { ...root, [CACHE_RETENTION_SETTINGS_KEY]: retention },
      settingsPath,
      await fileExists(settingsPath),
    );
  });
}

export async function saveAgentCacheRetention(
  retention: CacheRetention,
  settingsPath = defaultPromptCacheSettingsPath(),
): Promise<void> {
  if (!isAgentCacheRetention(retention)) {
    throw new Error(`Invalid agent cache retention: ${String(retention)}`);
  }
  await serializeMutation(settingsPath, async () => {
    const root = await readModelsRoot(settingsPath);
    await writeModelsRoot(
      { ...root, [AGENT_CACHE_RETENTION_SETTINGS_KEY]: retention },
      settingsPath,
      await fileExists(settingsPath),
    );
  });
}

export async function loadPromptCachePolicy(
  settingsPath = defaultPromptCacheSettingsPath(),
): Promise<PromptCachePolicy> {
  const root = await readModelsRoot(settingsPath);
  const value = root[PROMPT_CACHE_SETTINGS_KEY];
  return isPromptCachePolicy(value) ? value : PROMPT_CACHE_POLICY_DEFAULT;
}

/** Synchronous variant for provider-registration hot paths (mirrors configuredProviderIds). */
export function loadPromptCachePolicySync(settingsPath: string): PromptCachePolicy {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    const value = isRecord(parsed) ? parsed[PROMPT_CACHE_SETTINGS_KEY] : undefined;
    return isPromptCachePolicy(value) ? value : PROMPT_CACHE_POLICY_DEFAULT;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return PROMPT_CACHE_POLICY_DEFAULT;
    return PROMPT_CACHE_POLICY_DEFAULT;
  }
}

export async function savePromptCachePolicy(
  policy: PromptCachePolicy,
  settingsPath = defaultPromptCacheSettingsPath(),
): Promise<void> {
  if (!isPromptCachePolicy(policy)) {
    throw new Error(`Invalid prompt cache policy: ${String(policy)}`);
  }
  await serializeMutation(settingsPath, async () => {
    const root = await readModelsRoot(settingsPath);
    await writeModelsRoot(
      { ...root, [PROMPT_CACHE_SETTINGS_KEY]: policy },
      settingsPath,
      await fileExists(settingsPath),
    );
  });
}
