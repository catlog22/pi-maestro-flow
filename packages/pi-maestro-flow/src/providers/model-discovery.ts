/**
 * Dynamic model discovery for the API Manager.
 *
 * Given a Provider's connection (Base URL + API key), probe its OpenAI-style
 * `/models` endpoint to list the models the gateway actually serves, so the
 * user can pick which ones to inject into `models.json` instead of typing each
 * Model ID by hand.
 *
 * Gateways rarely advertise context/output limits, so discovered models are
 * enriched with reference specs from models.dev (same source as pi's own
 * generated catalogs), cached on disk for 24h. Gateway-advertised values
 * always win; a failed or offline spec fetch degrades to plain discovery. The
 * caller decides which discovered models to register.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { normalizeBaseUrl } from "./api-provider-config.ts";

export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ModelSpec {
  context?: number;
  output?: number;
}

export interface DiscoverOptions {
  /** Provider Base URL; validated through normalizeBaseUrl. */
  baseUrl: string;
  /** API key; sent as `Authorization: Bearer <key>` when present. */
  apiKey?: string;
  /** Explicit override; otherwise derived as `${baseUrl}/models`. */
  modelsUrl?: string;
  /** Extra request headers merged on top of the auth header. */
  headers?: Record<string, string>;
  /** Per-request timeout in ms; defaults to 8000. */
  timeoutMs?: number;
  /** Optional abort signal (composed with the timeout signal). */
  signal?: AbortSignal;
  /** Overrides the models.dev spec source and its cache path; tests only. */
  specs?: { url?: string; cachePath?: string };
}

const DEFAULT_DISCOVER_TIMEOUT_MS = 8000;

/**
 * Resolve the models-list URL for a Provider. An explicit `modelsUrl` wins;
 * otherwise the Base URL is stripped of trailing slashes and suffixed with
 * `/models`. `https://relay/v1` → `https://relay/v1/models`.
 */
export function modelsUrlForProvider(opts: Pick<DiscoverOptions, "baseUrl" | "modelsUrl">): string {
  const explicit = opts.modelsUrl?.trim();
  if (explicit) return explicit;
  const base = normalizeBaseUrl(opts.baseUrl);
  return `${base}/models`;
}

function authHeaders(opts: DiscoverOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  const apiKey = opts.apiKey;
  // "$ENV" secrets are resolved by the caller before discovery; a bare
  // placeholder key ("unused") is treated as no key so public /models
  // endpoints (e.g. some relays) still work.
  if (apiKey && apiKey !== "unused") headers.authorization = `Bearer ${apiKey}`;
  return { ...headers, ...(opts.headers ?? {}) };
}

/** Pull the raw model list out of any of the three common response shapes. */
function extractRawModels(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data;
    if (Array.isArray(record.models)) return record.models;
  }
  return [];
}

function coerceModel(item: unknown): DiscoveredModel | undefined {
  if (typeof item === "string") {
    const id = item.trim();
    return id ? { id } : undefined;
  }
  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return undefined;
  return {
    id: record.id,
    name: typeof record.name === "string"
      ? record.name
      : typeof record.display_name === "string"
        ? record.display_name
        : undefined,
    contextWindow: typeof record.context_window === "number" ? record.context_window : undefined,
    maxTokens: typeof record.max_tokens === "number" ? record.max_tokens : undefined,
  };
}

/**
 * Match a model id against the spec table. Relay ids are messy
 * ("gpt-5.5", "openai/gpt-5.5", dated suffixes, ":"/"_" variants), so ids are
 * normalized first; then the longest bidirectional prefix match wins to keep
 * "gpt-5" from matching "gpt-50".
 */
export function normalizeModelId(modelId: string): string {
  return modelId.toLowerCase().replace(/^.*\//, "").replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/[:_]/g, "-");
}

export function lookupModelSpec(specs: Map<string, ModelSpec>, modelId: string): ModelSpec | undefined {
  const normalized = normalizeModelId(modelId);
  const exact = specs.get(modelId) ?? specs.get(normalized);
  if (exact) return exact;
  let best: { key: string; len: number } | undefined;
  for (const [key, value] of specs) {
    const nk = normalizeModelId(key);
    if ((normalized.startsWith(nk) || nk.startsWith(normalized)) && (!best || Math.min(nk.length, normalized.length) > best.len)) {
      best = { key, len: Math.min(nk.length, normalized.length) };
    }
  }
  return best ? specs.get(best.key) : undefined;
}

async function enrichWithModelSpecs(models: DiscoveredModel[], opts?: DiscoverOptions): Promise<DiscoveredModel[]> {
  if (models.length === 0) return models;
  let specs: Map<string, ModelSpec>;
  try {
    specs = await loadModelSpecs(opts?.specs);
  } catch {
    // Specs are a best-effort enhancement; plain discovery results stay valid.
    return models;
  }
  return models.map((model) => ({
    ...model,
    contextWindow: model.contextWindow ?? lookupModelSpec(specs, model.id)?.context,
    maxTokens: model.maxTokens ?? lookupModelSpec(specs, model.id)?.output,
  }));
}

/**
 * Probe a Provider's `/models` endpoint and return the models it advertises.
 *
 * Accepts the OpenAI-style `{ data: [...] }` envelope, a bare `{ models: [...] }`
 * object, and a top-level array. Each entry may be a bare model-id string or an
 * object with `id` / `name` / `display_name` / `context_window` / `max_tokens`.
 * Throws on HTTP errors, timeouts, or unparseable bodies so the caller can fall
 * back to manual entry.
 */
export async function discoverModels(opts: DiscoverOptions): Promise<DiscoveredModel[]> {
  const url = modelsUrlForProvider(opts);
  // Compose the caller's signal with a timeout so either can abort the fetch.
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DISCOVER_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  const response = await fetch(url, {
    signal,
    headers: {
      accept: "application/json",
      ...authHeaders(opts),
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as unknown;
  const raw = extractRawModels(payload);
  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const model = coerceModel(item);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return enrichWithModelSpecs(models, opts);
}

// ============================================================================
// Reference specs from models.dev
//
// Most relays do not advertise context/output limits in /models. models.dev
// publishes per-model limits (the same source pi's generated catalogs use);
// they are fetched once and cached on disk for 24h, mirroring the
// OpenRouter pricing cache in cost-backfill.ts: a stale snapshot beats an
// empty one, and a failed fetch never fails discovery itself.
// ============================================================================

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const MODEL_SPECS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MODEL_SPECS_FETCH_TIMEOUT_MS = 10_000;

interface ModelsDevEntry {
  models?: Record<string, { limit?: { context?: number; output?: number } }>;
}

interface ModelSpecsCacheFile {
  fetchedAt: number;
  specs: Record<string, ModelSpec>;
}

function modelSpecsCachePath(): string {
  return join(getAgentDir(), "model-specs-cache.json");
}

function parseModelsDevSpecs(payload: unknown): Map<string, ModelSpec> {
  const specs = new Map<string, ModelSpec>();
  if (!payload || typeof payload !== "object") return specs;
  const db = payload as Record<string, ModelsDevEntry>;
  for (const entry of Object.values(db)) {
    const models = entry?.models;
    if (!models || typeof models !== "object") continue;
    for (const [modelId, model] of Object.entries(models)) {
      const limit = model?.limit;
      if (!limit || typeof limit !== "object") continue;
      // The same id may appear under several providers; first wins.
      if (!specs.has(modelId) && limit) {
        specs.set(modelId, { context: limit.context, output: limit.output });
      }
    }
  }
  return specs;
}

async function readModelSpecsCache(path: string, ttlMs: number): Promise<Map<string, ModelSpec> | undefined> {
  try {
    const cached = JSON.parse(await readFile(path, "utf8")) as ModelSpecsCacheFile;
    if (typeof cached.fetchedAt !== "number" || Date.now() - cached.fetchedAt >= ttlMs) return undefined;
    if (!cached.specs || typeof cached.specs !== "object") return undefined;
    const specs = new Map<string, ModelSpec>(
      Object.entries(cached.specs).filter(([, spec]) => spec && typeof spec === "object"),
    );
    return specs.size > 0 ? specs : undefined;
  } catch {
    return undefined;
  }
}

async function writeModelSpecsCache(path: string, specs: Map<string, ModelSpec>): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const file: ModelSpecsCacheFile = { fetchedAt: Date.now(), specs: Object.fromEntries(specs) };
    await writeFile(path, `${JSON.stringify(file)}\n`, "utf8");
  } catch {
    // Cache is best-effort; a failed write must not fail discovery.
  }
}

/**
 * Load reference model specs from models.dev, served from the disk cache when
 * fresh and falling back to a stale snapshot when the network is unavailable.
 * Throws only when there is no usable snapshot at all; callers must treat a
 * rejection as "no specs available", never as a discovery failure.
 */
export async function loadModelSpecs(opts?: { cachePath?: string; ttlMs?: number; url?: string }): Promise<Map<string, ModelSpec>> {
  const cachePath = opts?.cachePath ?? modelSpecsCachePath();
  const ttlMs = opts?.ttlMs ?? MODEL_SPECS_CACHE_TTL_MS;
  const url = opts?.url ?? MODELS_DEV_API_URL;
  const fresh = await readModelSpecsCache(cachePath, ttlMs);
  if (fresh) return fresh;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(MODEL_SPECS_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`);
    const specs = parseModelsDevSpecs(await response.json());
    if (specs.size === 0) throw new Error("models.dev returned no model specs");
    await writeModelSpecsCache(cachePath, specs);
    return specs;
  } catch (error) {
    // Stale beats empty: reuse the expired snapshot when the fetch fails.
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as ModelSpecsCacheFile;
      if (cached.specs && typeof cached.specs === "object") {
        const specs = new Map<string, ModelSpec>(
          Object.entries(cached.specs).filter(([, spec]) => spec && typeof spec === "object"),
        );
        if (specs.size > 0) return specs;
      }
    } catch {
      /* no usable snapshot */
    }
    throw error;
  }
}

/** Test seam: drop the on-disk specs cache so a test starts from a cold state. */
export async function clearModelSpecsCache(opts?: { cachePath?: string }): Promise<void> {
  const cachePath = opts?.cachePath ?? modelSpecsCachePath();
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify({ fetchedAt: 0, specs: {} })}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}
