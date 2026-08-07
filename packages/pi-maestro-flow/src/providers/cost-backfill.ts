/**
 * Cost-rate backfill for API Manager channels.
 *
 * pi computes per-turn cost locally from the model's `cost` rates (USD per
 * 1M tokens, see pi-ai calculateCost). Custom channels registered through
 * models.json default to zero rates, so their cost never shows. This module
 * supplies those rates from two sources:
 *
 *  1. The pi-ai built-in catalog (offline, generated at publish time) — the
 *     same MODELS table the official providers ship with.
 *  2. OpenRouter's official /api/v1/models pricing (online, fresh) — converted
 *     from per-token to per-1M-token rates, including cache tiers.
 */
import { getBuiltinModel, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelCost } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface CostMatch {
  cost: ModelCost;
  /** Human-readable source label, e.g. "openai" or "openrouter:openai/gpt-5.6-sol". */
  source: string;
}

// Official/vendor catalogs first so a model id shared with a gateway resolves
// to list pricing rather than a reseller's rates. Unknown providers trail.
const BUILTIN_PROVIDER_PRIORITY = [
  "openai",
  "anthropic",
  "deepseek",
  "xai",
  "google",
  "mistral",
  "moonshotai",
  "zai",
  "openrouter",
  "together",
  "groq",
];

export function validCostRates(value: unknown): value is ModelCost {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const cost = value as Record<string, unknown>;
  return typeof cost.input === "number"
    && typeof cost.output === "number"
    && typeof cost.cacheRead === "number"
    && typeof cost.cacheWrite === "number";
}

function isZeroRates(cost: ModelCost): boolean {
  return cost.input === 0 && cost.output === 0 && cost.cacheRead === 0 && cost.cacheWrite === 0;
}

/**
 * Look up a model's pricing in the pi-ai built-in catalog by model id.
 * When `api` is given, providers whose catalog matches that API driver are
 * preferred (a gpt-5.6-sol served over azure-openai-responses prices like
 * Azure, not like OpenAI). All-zero entries (e.g. token-plan placeholders
 * whose rate is unknown) are treated as missing so they never masquerade as
 * "free".
 */
export function lookupBuiltinPricing(modelId: string, api?: string): CostMatch | undefined {
  const providers = getBuiltinProviders();
  const ordered = [
    ...BUILTIN_PROVIDER_PRIORITY.filter((id) => providers.includes(id as never)),
    ...providers.filter((id) => !BUILTIN_PROVIDER_PRIORITY.includes(id as never)),
  ];
  const first = (list: readonly string[]): CostMatch | undefined => {
    for (const provider of list) {
      const model = getBuiltinModel(provider as never, modelId) as { api?: string; cost?: unknown } | undefined;
      const cost = model?.cost;
      if (!validCostRates(cost) || isZeroRates(cost)) continue;
      return { cost, source: provider };
    }
    return undefined;
  };
  if (api) {
    const apiMatched = first(ordered.filter((id) => {
      const model = getBuiltinModel(id as never, modelId) as { api?: string } | undefined;
      return model?.api === api;
    }));
    if (apiMatched) return apiMatched;
  }
  return first(ordered);
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_FETCH_TIMEOUT_MS = 10_000;
const OPENROUTER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface OpenRouterTier {
  min_prompt_tokens?: number;
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
}

interface OpenRouterModelEntry {
  id: string;
  pricing?: Record<string, string | undefined> & { overrides?: OpenRouterTier[] };
}

interface OpenRouterCacheFile {
  fetchedAt: number;
  entries: Array<{ id: string; pricing?: OpenRouterModelEntry["pricing"] }>;
}

/** OpenRouter prices are USD per token; pi rates are USD per 1M tokens. */
function perTokenToRates(pricing: OpenRouterModelEntry["pricing"]): ModelCost {
  const parse = (value: string | undefined): number =>
    typeof value === "string" && value !== "" ? parseFloat(value) * 1_000_000 : 0;
  const cost: ModelCost = {
    input: parse(pricing?.prompt),
    output: parse(pricing?.completion),
    cacheRead: parse(pricing?.input_cache_read),
    cacheWrite: parse(pricing?.input_cache_write),
  };
  const overrides = (pricing?.overrides ?? []).filter(
    (tier) => typeof tier.min_prompt_tokens === "number" && tier.min_prompt_tokens > 0,
  );
  if (overrides.length > 0) {
    cost.tiers = overrides.map((tier) => ({
      inputTokensAbove: tier.min_prompt_tokens!,
      input: parse(tier.prompt),
      output: parse(tier.completion),
      cacheRead: parse(tier.input_cache_read),
      cacheWrite: parse(tier.input_cache_write),
    }));
  }
  return cost;
}

function openRouterCachePath(): string {
  return join(getAgentDir(), "openrouter-pricing.json");
}

async function readOpenRouterCache(path: string): Promise<Map<string, ModelCost> | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const cached = JSON.parse(raw) as OpenRouterCacheFile;
    if (!Array.isArray(cached.entries) || cached.entries.length === 0) return undefined;
    return entriesToRates(cached.entries);
  } catch {
    return undefined;
  }
}

function entriesToRates(entries: Array<{ id: string; pricing?: OpenRouterModelEntry["pricing"] }>): Map<string, ModelCost> {
  const map = new Map<string, ModelCost>();
  for (const entry of entries) {
    if (typeof entry.id === "string" && entry.pricing) map.set(entry.id, perTokenToRates(entry.pricing));
  }
  return map;
}

async function writeOpenRouterCache(path: string, entries: Array<{ id: string; pricing?: OpenRouterModelEntry["pricing"] }>): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ fetchedAt: Date.now(), entries } satisfies OpenRouterCacheFile, null, 2)}\n`, "utf8");
  } catch {
    // Cache is best-effort; a failed write must not fail the backfill.
  }
}

/**
 * Fetch OpenRouter's official model pricing. Results are cached on disk for
 * OPENROUTER_CACHE_TTL_MS and reused when the network is unavailable, so a
 * stale snapshot beats an empty one.
 */
export async function fetchOpenRouterPricing(opts?: { cachePath?: string; ttlMs?: number; url?: string }): Promise<Map<string, ModelCost>> {
  const cachePath = opts?.cachePath ?? openRouterCachePath();
  const ttlMs = opts?.ttlMs ?? OPENROUTER_CACHE_TTL_MS;
  const url = opts?.url ?? OPENROUTER_MODELS_URL;
  const cached = await readOpenRouterCache(cachePath);
  if (cached && Date.now() - (await cacheFetchedAt(cachePath)) < ttlMs) return cached;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(OPENROUTER_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`OpenRouter models API HTTP ${response.status}`);
    const body = (await response.json()) as { data?: OpenRouterModelEntry[] };
    const entries = (body.data ?? []).filter((entry) => entry && typeof entry.id === "string" && entry.pricing);
    if (entries.length === 0) throw new Error("OpenRouter models API returned no models");
    await writeOpenRouterCache(cachePath, entries);
    return entriesToRates(entries);
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
}

async function cacheFetchedAt(path: string): Promise<number> {
  try {
    const raw = await readFile(path, "utf8");
    const cached = JSON.parse(raw) as OpenRouterCacheFile;
    return typeof cached.fetchedAt === "number" ? cached.fetchedAt : 0;
  } catch {
    return 0;
  }
}

/**
 * Match a channel model id against OpenRouter pricing. OpenRouter ids carry a
 * provider prefix ("openai/gpt-5.6-sol"); channel ids are usually bare
 * ("gpt-5.6-sol"), so exact id wins, then the suffix after the last "/".
 */
export function matchOpenRouterPricing(
  models: Map<string, ModelCost>,
  modelId: string,
): CostMatch | undefined {
  const exact = models.get(modelId);
  if (exact) return { cost: exact, source: "openrouter" };
  for (const [id, cost] of models) {
    const suffix = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
    if (suffix === modelId) return { cost, source: `openrouter:${id}` };
  }
  return undefined;
}

/**
 * Resolve pricing for one model: built-in catalog first (api-aware), then
 * OpenRouter. OpenRouter is only consulted when `online` is true and the
 * built-in table missed, so offline runs never wait on the network.
 */
export async function resolveModelCost(modelId: string, api?: string, online = false): Promise<CostMatch | undefined> {
  const builtin = lookupBuiltinPricing(modelId, api);
  if (builtin) return builtin;
  if (!online) return undefined;
  try {
    const openRouter = await fetchOpenRouterPricing();
    return matchOpenRouterPricing(openRouter, modelId);
  } catch {
    return undefined;
  }
}
