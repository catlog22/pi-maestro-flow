import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TeammateTaskType } from "pi-maestro-teammate/v1/model-routing";
import { normalizeModelId } from "./model-discovery.ts";

export const MODEL_INTELLIGENCE_DIMENSIONS = [
  "intelligence",
  "coding",
  "agentic",
  "price",
  "latency",
] as const;

export type ModelIntelligenceDimension = typeof MODEL_INTELLIGENCE_DIMENSIONS[number];

export const MODEL_INTELLIGENCE_PREFERENCES = ["economy", "balanced", "sota"] as const;
export type ModelIntelligencePreference = typeof MODEL_INTELLIGENCE_PREFERENCES[number];

interface OpenRouterPricing {
  prompt?: string;
  completion?: string;
}

interface OpenRouterModelEntry {
  id: string;
  canonical_slug?: string;
  context_length?: number;
  pricing?: OpenRouterPricing;
}

interface ModelIntelligenceCacheFile {
  version: 1;
  fetchedAt: number;
  lists: Partial<Record<ModelIntelligenceDimension, OpenRouterModelEntry[]>>;
}

export interface AvailableModelIdentity {
  registrationId: string;
  modelId?: string;
}

export interface ModelIntelligenceRank {
  rank: number;
  total: number;
}

export interface ModelIntelligenceCandidate {
  registration_id: string;
  benchmark_model_id: string;
  strengths: string[];
  ranks: Partial<Record<ModelIntelligenceDimension, ModelIntelligenceRank>>;
  reference_pricing_usd_per_million?: {
    input: number;
    output: number;
  };
  context_length?: number;
  confidence: "low" | "medium" | "high";
}

export interface ModelIntelligenceView {
  status: "available" | "stale" | "unavailable";
  task_type: TeammateTaskType;
  preference: ModelIntelligencePreference;
  recommendation: string | null;
  candidates: ModelIntelligenceCandidate[];
  unmatched_models: string[];
  sources: Array<{
    id: "openrouter-models-api";
    url: string;
    fetched_at: string;
    expires_at: string;
    reference_only: true;
  }>;
  note: string;
}

export interface LoadModelIntelligenceOptions {
  cachePath?: string;
  ttlMs?: number;
  baseUrl?: string;
  timeoutMs?: number;
  limit?: number;
  preference?: ModelIntelligencePreference;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

const SORT_BY_DIMENSION: Record<ModelIntelligenceDimension, string> = {
  intelligence: "intelligence-high-to-low",
  coding: "coding-high-to-low",
  agentic: "agentic-high-to-low",
  price: "pricing-low-to-high",
  latency: "latency-low-to-high",
};

const TASK_DIMENSIONS: Record<string, readonly ModelIntelligenceDimension[]> = {
  explore: ["latency", "price", "intelligence"],
  analysis: ["intelligence", "price", "latency"],
  debug: ["coding", "intelligence", "agentic"],
  planning: ["intelligence", "price", "latency"],
  development: ["coding", "agentic", "intelligence"],
  review: ["intelligence", "coding", "agentic"],
  testing: ["coding", "agentic", "price"],
};

const SOTA_DIMENSIONS: Record<string, readonly ModelIntelligenceDimension[]> = {
  explore: ["intelligence", "coding", "agentic"],
  analysis: ["intelligence", "agentic", "coding"],
  debug: ["coding", "intelligence", "agentic"],
  planning: ["intelligence", "agentic", "coding"],
  development: ["coding", "agentic", "intelligence"],
  review: ["intelligence", "coding", "agentic"],
  testing: ["coding", "agentic", "intelligence"],
};

function selectionDimensions(
  taskType: TeammateTaskType,
  preference: ModelIntelligencePreference,
): readonly ModelIntelligenceDimension[] {
  const balanced = TASK_DIMENSIONS[taskType] ?? ["intelligence", "price", "latency"];
  if (preference === "sota") return SOTA_DIMENSIONS[taskType] ?? ["intelligence", "coding", "agentic"];
  if (preference === "economy") {
    return ["price", ...balanced.filter((dimension) => dimension !== "price")];
  }
  return balanced;
}

function cachePath(): string {
  return join(getAgentDir(), "model-intelligence-openrouter.json");
}

function isEntry(value: unknown): value is OpenRouterModelEntry {
  return !!value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string";
}

function normalizeLists(value: unknown): ModelIntelligenceCacheFile["lists"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const lists: ModelIntelligenceCacheFile["lists"] = {};
  for (const dimension of MODEL_INTELLIGENCE_DIMENSIONS) {
    const list = (value as Record<string, unknown>)[dimension];
    if (!Array.isArray(list)) continue;
    const entries = list.filter(isEntry).map((entry) => ({
      id: entry.id,
      ...(typeof entry.canonical_slug === "string" ? { canonical_slug: entry.canonical_slug } : {}),
      ...(typeof entry.context_length === "number" && Number.isFinite(entry.context_length)
        ? { context_length: entry.context_length }
        : {}),
      ...(entry.pricing && typeof entry.pricing === "object" ? {
        pricing: {
          ...(typeof entry.pricing.prompt === "string" ? { prompt: entry.pricing.prompt } : {}),
          ...(typeof entry.pricing.completion === "string" ? { completion: entry.pricing.completion } : {}),
        },
      } : {}),
    }));
    if (entries.length > 0) lists[dimension] = entries;
  }
  return Object.keys(lists).length > 0 ? lists : undefined;
}

async function readCache(path: string): Promise<ModelIntelligenceCacheFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ModelIntelligenceCacheFile>;
    const lists = normalizeLists(parsed.lists);
    if (parsed.version !== 1 || typeof parsed.fetchedAt !== "number" || !lists) return undefined;
    return { version: 1, fetchedAt: parsed.fetchedAt, lists };
  } catch {
    return undefined;
  }
}

async function writeCache(path: string, cache: ModelIntelligenceCacheFile): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, `${JSON.stringify(cache)}\n`, "utf8");
    await rename(temp, path);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

async function fetchLists(
  baseUrl: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  callerSignal?: AbortSignal,
): Promise<ModelIntelligenceCacheFile["lists"]> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  const settled = await Promise.allSettled(MODEL_INTELLIGENCE_DIMENSIONS.map(async (dimension) => {
    const url = new URL(baseUrl);
    url.searchParams.set("sort", SORT_BY_DIMENSION[dimension]);
    const response = await fetchFn(url, {
      headers: { accept: "application/json" },
      signal,
    });
    if (!response.ok) throw new Error(`OpenRouter models API HTTP ${response.status}`);
    const payload = await response.json() as { data?: unknown };
    const entries = Array.isArray(payload.data) ? payload.data.filter(isEntry) : [];
    if (entries.length === 0) throw new Error(`OpenRouter returned no ${dimension} ranking`);
    return [dimension, entries] as const;
  }));

  const lists: ModelIntelligenceCacheFile["lists"] = {};
  for (const result of settled) {
    if (result.status === "fulfilled") lists[result.value[0]] = result.value[1];
  }
  if (Object.keys(lists).length === 0) throw new Error("OpenRouter returned no model rankings");
  return lists;
}

async function loadCache(options: LoadModelIntelligenceOptions): Promise<{
  cache?: ModelIntelligenceCacheFile;
  stale: boolean;
}> {
  const path = options.cachePath ?? cachePath();
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const existing = await readCache(path);
  if (existing && Date.now() - existing.fetchedAt < ttlMs) return { cache: existing, stale: false };
  try {
    const lists = await fetchLists(
      options.baseUrl ?? OPENROUTER_MODELS_URL,
      options.timeoutMs ?? FETCH_TIMEOUT_MS,
      options.fetchFn ?? fetch,
      options.signal,
    );
    const next: ModelIntelligenceCacheFile = { version: 1, fetchedAt: Date.now(), lists };
    await writeCache(path, next);
    return { cache: next, stale: false };
  } catch {
    if (options.signal?.aborted) throw new Error("Model intelligence request aborted");
    return existing ? { cache: existing, stale: true } : { stale: false };
  }
}

function aliases(model: AvailableModelIdentity): string[] {
  return [...new Set([model.registrationId, model.modelId]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map(normalizeModelId))];
}

function rankFor(
  list: readonly OpenRouterModelEntry[] | undefined,
  modelAliases: readonly string[],
): { entry: OpenRouterModelEntry; rank: ModelIntelligenceRank } | undefined {
  if (!list) return undefined;
  const index = list.findIndex((entry) => {
    const entryAliases = [entry.id, entry.canonical_slug].filter((value): value is string => typeof value === "string").map(normalizeModelId);
    return entryAliases.some((entryAlias) => modelAliases.includes(entryAlias));
  });
  return index < 0 ? undefined : { entry: list[index]!, rank: { rank: index + 1, total: list.length } };
}

function perMillion(value: string | undefined): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : undefined;
}

function candidateFor(
  model: AvailableModelIdentity,
  lists: ModelIntelligenceCacheFile["lists"],
  dimensions: readonly ModelIntelligenceDimension[],
): ModelIntelligenceCandidate | undefined {
  const modelAliases = aliases(model);
  const matches = new Map<ModelIntelligenceDimension, ReturnType<typeof rankFor>>();
  for (const dimension of MODEL_INTELLIGENCE_DIMENSIONS) {
    matches.set(dimension, rankFor(lists[dimension], modelAliases));
  }
  const representative = MODEL_INTELLIGENCE_DIMENSIONS.map((dimension) => matches.get(dimension)).find(Boolean);
  if (!representative) return undefined;

  const ranks: ModelIntelligenceCandidate["ranks"] = {};
  const strengths: string[] = [];
  for (const dimension of MODEL_INTELLIGENCE_DIMENSIONS) {
    const match = matches.get(dimension);
    if (!match) continue;
    ranks[dimension] = match.rank;
    if (match.rank.rank <= Math.max(1, Math.ceil(match.rank.total / 4))) strengths.push(dimension);
  }
  const input = perMillion(representative.entry.pricing?.prompt);
  const output = perMillion(representative.entry.pricing?.completion);
  const evidenceCount = dimensions.filter((dimension) => ranks[dimension] !== undefined).length;
  const confidence = evidenceCount >= dimensions.length
    ? "high"
    : evidenceCount >= Math.max(1, dimensions.length - 1)
      ? "medium"
      : "low";
  return {
    registration_id: model.registrationId,
    benchmark_model_id: representative.entry.canonical_slug ?? representative.entry.id,
    strengths,
    ranks,
    ...(input === undefined || output === undefined ? {} : {
      reference_pricing_usd_per_million: { input, output },
    }),
    ...(representative.entry.context_length === undefined ? {} : { context_length: representative.entry.context_length }),
    confidence,
  };
}

function compareCandidates(
  left: ModelIntelligenceCandidate,
  right: ModelIntelligenceCandidate,
  dimensions: readonly ModelIntelligenceDimension[],
): number {
  for (const dimension of dimensions) {
    const leftRank = left.ranks[dimension];
    const rightRank = right.ranks[dimension];
    const leftValue = leftRank ? leftRank.rank / Math.max(1, leftRank.total) : Number.POSITIVE_INFINITY;
    const rightValue = rightRank ? rightRank.rank / Math.max(1, rightRank.total) : Number.POSITIVE_INFINITY;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return left.registration_id.localeCompare(right.registration_id);
}

export async function loadModelIntelligence(
  taskType: TeammateTaskType,
  models: readonly AvailableModelIdentity[],
  options: LoadModelIntelligenceOptions = {},
): Promise<ModelIntelligenceView> {
  const loaded = await loadCache(options);
  const preference = options.preference ?? "balanced";
  const dimensions = selectionDimensions(taskType, preference);
  if (!loaded.cache) {
    return {
      status: "unavailable",
      task_type: taskType,
      preference,
      recommendation: null,
      candidates: [],
      unmatched_models: models.map((model) => model.registrationId),
      sources: [],
      note: "No current or cached benchmark snapshot is available; retain configured routing.",
    };
  }

  const candidates: ModelIntelligenceCandidate[] = [];
  const unmatched: string[] = [];
  for (const model of models) {
    const candidate = candidateFor(model, loaded.cache.lists, dimensions);
    if (candidate) candidates.push(candidate);
    else unmatched.push(model.registrationId);
  }
  candidates.sort((left, right) => compareCandidates(left, right, dimensions));
  const limit = Math.max(1, Math.min(10, options.limit ?? 5));
  const visible = candidates.slice(0, limit);
  const fetchedAt = loaded.cache.fetchedAt;
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  return {
    status: loaded.stale ? "stale" : "available",
    task_type: taskType,
    preference,
    recommendation: loaded.stale || visible[0]?.confidence === "low"
      ? null
      : visible[0]?.registration_id ?? null,
    candidates: visible,
    unmatched_models: unmatched,
    sources: [{
      id: "openrouter-models-api",
      url: options.baseUrl ?? OPENROUTER_MODELS_URL,
      fetched_at: new Date(fetchedAt).toISOString(),
      expires_at: new Date(fetchedAt + ttlMs).toISOString(),
      reference_only: true,
    }],
    note: `External ranks and prices are advisory OpenRouter reference data ranked for the ${preference} preference; availability and explicit user choices remain authoritative.`,
  };
}
