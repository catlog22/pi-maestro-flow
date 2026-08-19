/**
 * Dynamic model discovery for the API Manager.
 *
 * Given a Provider's connection (Base URL + API key), probe its OpenAI-style
 * `/models` endpoint to list the models the gateway actually serves, so the
 * user can pick which ones to inject into `models.json` instead of typing each
 * Model ID by hand.
 *
 * This mirrors the `/v1/models` probing in the `multi-relay` reference
 * extension, but stays read-only: it never writes anything. The caller decides
 * which discovered models to register. Discovery is an optional enhancement —
 * a network failure or a gateway without a `/models` endpoint is surfaced as a
 * thrown error and degrades to the manual entry flow.
 */
import { normalizeBaseUrl } from "./api-provider-config.ts";

export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
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
  return models;
}
