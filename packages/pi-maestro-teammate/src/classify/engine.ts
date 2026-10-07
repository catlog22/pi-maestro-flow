/**
 * Unified classifier engine — layered pipeline shared by every classification
 * domain in the plugin.
 *
 * Pipeline per call:
 *   L0 rules  → deterministic verdict; `terminal` hits short-circuit.
 *   L1 JEV    → semantic decision via the System One model (choice/score/noul
 *               with probabilities + confidence), reached only when rules were
 *               absent or non-terminal AND the domain is in "jev" mode.
 *   degraded  → any transport/parse/budget failure resolves to the provisional
 *               rule label (or the domain's own fallback) — never throws.
 *
 * Modes per domain:
 *   "off"    — L0 only; identical to today's behavior.
 *   "shadow" — L0 decides synchronously; JEV judges the same input in the
 *              background and the pair is reported via `onShadow` so real
 *              traffic builds an eval corpus before adjudication is trusted.
 *   "jev"    — L0 → L1 adjudication for async callers. Sync callers still get
 *              the L0 result plus a shadow observation (they cannot await).
 *
 * Host-free: config (incl. API keys) is injected via {@link configureClassifier};
 * the engine never reads files, the env, or UI surfaces itself — except the
 * two documented env lookups delegated to `resolveJevEndpoint`.
 */

import { createHash } from "node:crypto";
import { getPiFeatureOwner } from "pi-maestro-settings-core/v1";
import {
  createJevClient,
  createNativeJevClient,
  type ClassifierRuntime,
  prepareJevDecision,
  resolveJevEndpoint,
  type JevClient,
  type JevClientOptions,
  type JevEndpoint,
} from "./client.ts";
import type {
  ClassifierDomainMode,
  ClassifyDomain,
  ClassifyResult,
  ClassifyShadowRecord,
  JevResponse,
  RuleVerdict,
} from "./types.ts";

export interface ClassifierConfig {
  /** Master switch. When false, every call is L0-only regardless of domain modes. */
  enabled: boolean;
  /** Explicit host version for host-free callers; unknown hosts cannot use HTTP. */
  hostVersion?: string;
  /** Preferred endpoint; when absent, inferred from which API key env exists. */
  endpoint?: JevEndpoint;
  /** Explicit API key; when absent, read from the endpoint's env var. */
  apiKey?: string;
  /** Model override (e.g. `jev-latest`, `typesafe/jev-1.13`). */
  model?: string;
  /** Test seam: override the endpoint URL. */
  baseUrl?: string;
  /** Per-call timeout (default 4000ms; JEV is a low-latency decision model). */
  timeoutMs?: number;
  /** Answer cache TTL (default 10min — error text repeats heavily). */
  cacheTtlMs?: number;
  /** Max JEV calls per configure cycle (default 30). */
  maxCallsPerSession?: number;
  /** domain name → mode. Absent = "off". */
  domains?: Record<string, ClassifierDomainMode>;
  /** Test seam for HTTP. */
  fetchFn?: typeof fetch;
  /** Shadow observation sink (host decides where/how to persist). */
  onShadow?: (record: ClassifyShadowRecord) => void;
}

export interface ClassifierDomainStatus {
  mode: ClassifierDomainMode;
  supportedModes: readonly ClassifierDomainMode[];
}

export interface ClassifierStatus {
  enabled: boolean;
  endpoint?: JevEndpoint;
  apiKeyPresent: boolean;
  model?: string;
  callsUsed: number;
  maxCalls: number;
  cacheSize: number;
  domains: Record<string, ClassifierDomainStatus>;
}

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CALLS = 30;

let config: ClassifierConfig = { enabled: false };
let client: JevClient | undefined;
let hostBinding: { hostVersion: string; runtime: ClassifierRuntime } | undefined;
let unavailableReason = "Classifier host runtime unavailable";
let callsUsed = 0;
const registry = new Map<string, ClassifyDomain<string, unknown>>();
const cache = new Map<string, { response: JevResponse; at: number }>();
const pending = new Map<string, Promise<JevResponse>>();
// One live token, not an ever-growing collection of per-generation caches.
let generation = {};

function fenceGeneration(): void {
  generation = {};
  callsUsed = 0;
  cache.clear();
  pending.clear();
}

function captureGeneration() {
  return { generation, config, client, unavailableReason };
}

type Generation = ReturnType<typeof captureGeneration>;

function assertCurrent(owner: Generation): void {
  if (owner.generation !== generation) throw new Error("Classifier generation changed");
}

/** Bind only the current process's host facade, never a child/remote runtime. */
export function bindClassifierRuntime(binding: { hostVersion: string; runtime: ClassifierRuntime }): void {
  hostBinding = binding;
  configureClassifier(config);
}

export function unbindClassifierRuntime(runtime: ClassifierRuntime): void {
  if (hostBinding?.runtime !== runtime) return;
  fenceGeneration();
  hostBinding = undefined;
  client = undefined;
  unavailableReason = "Classifier host runtime unavailable";
}

/** Inject classifier configuration (host loads `.pi/classifier.json` / env). */
export function configureClassifier(next: ClassifierConfig): void {
  fenceGeneration();
  config = { ...next, ...(next.domains ? { domains: { ...next.domains } } : {}) };
  const runtime = hostBinding?.runtime;
  const owner = getPiFeatureOwner(hostBinding?.hostVersion ?? next.hostVersion, !!runtime && typeof runtime.classify === "function" && typeof runtime.getAvailableOfType === "function" && typeof runtime.getModelOfType === "function");
  client = undefined;
  unavailableReason = "Classifier host runtime unavailable";
  if (!config.enabled) return;
  if (owner === "native" && runtime) {
    client = createNativeJevClient(runtime, { endpoint: next.endpoint ?? "typesafe", model: next.model, timeoutMs: next.timeoutMs });
    return;
  }
  if (owner !== "legacy") return;
  unavailableReason = "Legacy JEV client unavailable (missing API key)";
  const resolved = next.apiKey?.trim()
    ? { endpoint: next.endpoint ?? "typesafe", apiKey: next.apiKey.trim() }
    : resolveJevEndpoint(next.endpoint);
  client = config.enabled && resolved
    ? createJevClient({
      endpoint: resolved.endpoint,
      apiKey: resolved.apiKey,
      ...(next.model ? { model: next.model } : {}),
      ...(next.baseUrl ? { baseUrl: next.baseUrl } : {}),
      ...(next.timeoutMs !== undefined ? { timeoutMs: next.timeoutMs } : {}),
      ...(next.fetchFn ? { fetchFn: next.fetchFn } : {}),
    } as JevClientOptions)
    : undefined;
}

export function classifierConfig(): ClassifierConfig {
  return { ...config };
}

/** @internal Test seam: restore the disabled-by-default engine state. */
export function resetClassifierForTest(): void {
  fenceGeneration();
  config = { enabled: false };
  client = undefined;
  hostBinding = undefined;
  unavailableReason = "Classifier host runtime unavailable";
  registry.clear();
}

export function registerClassifyDomain<D extends string, I>(domain: ClassifyDomain<D, I>): void {
  registry.set(domain.name, domain as unknown as ClassifyDomain<string, unknown>);
}

export function classifyDomain(name: string): ClassifyDomain<string, unknown> | undefined {
  return registry.get(name);
}

export function listClassifyDomains(): string[] {
  return [...registry.keys()].sort();
}

export function classifierStatus(): ClassifierStatus {
  const domains: Record<string, ClassifierDomainStatus> = {};
  for (const [name, domain] of registry) {
    domains[name] = { mode: effectiveMode(domain), supportedModes: domain.modes };
  }
  return {
    enabled: config.enabled === true,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    apiKeyPresent: client !== undefined,
    ...(config.model ? { model: config.model } : {}),
    callsUsed,
    maxCalls: config.maxCallsPerSession ?? DEFAULT_MAX_CALLS,
    cacheSize: cache.size,
    domains,
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function effectiveMode(domain: ClassifyDomain<string, unknown>): ClassifierDomainMode {
  const requested = config.domains?.[domain.name] ?? "off";
  return domain.modes.includes(requested) ? requested : "off";
}

function safeRules<D extends string, I>(
  domain: ClassifyDomain<D, I>,
  input: I,
): RuleVerdict<D> | undefined {
  try {
    return domain.rules(input);
  } catch {
    return undefined;
  }
}

function degraded<D extends string, I>(
  domain: ClassifyDomain<D, I>,
  provisional: RuleVerdict<D> | undefined,
  reason: string,
): ClassifyResult<D> {
  if (provisional) {
    return { label: provisional.label, confidence: 0, layer: "degraded", degradedReason: reason };
  }
  const fallback = domain.fallback(reason);
  return { label: fallback.label, confidence: fallback.confidence, layer: "degraded", degradedReason: reason };
}

async function jevDecide<D extends string, I>(
  domain: ClassifyDomain<D, I>,
  state: string,
  owner: Generation,
): Promise<JevResponse> {
  assertCurrent(owner);
  if (!owner.client) throw new Error(owner.unavailableReason);
  const questions = domain.questions();
  const prepared = await prepareJevDecision(owner.client, { state, questions });
  assertCurrent(owner);
  const key = createHash("sha256")
    .update(JSON.stringify([domain.name, prepared.identity, questions, state]))
    .digest("hex");
  const entry = cache.get(key);
  if (entry && Date.now() - entry.at <= (owner.config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS)) {
    return entry.response;
  }
  cache.delete(key);
  const existing = pending.get(key);
  if (existing) {
    const response = await existing;
    assertCurrent(owner);
    return response;
  }
  if (callsUsed >= (owner.config.maxCallsPerSession ?? DEFAULT_MAX_CALLS)) {
    throw new Error("JEV session call budget exhausted");
  }
  callsUsed += 1;
  // Reserve before invoking host code, which may re-enter configuration.
  const decision = Promise.resolve().then(() => {
    assertCurrent(owner);
    return prepared.decide();
  });
  pending.set(key, decision);
  try {
    const response = await decision;
    assertCurrent(owner);
    cache.set(key, { response, at: Date.now() });
    return response;
  } finally {
    // A late old request must not remove a new generation's reservation.
    if (owner.generation === generation && pending.get(key) === decision) pending.delete(key);
  }
}

/**
 * Shadow path: rules stay authoritative; JEV judges the same state in the
 * background and the pair goes to `onShadow`. Never throws, never blocks.
 */
function fireShadow<D extends string, I>(
  domain: ClassifyDomain<D, I>,
  input: I,
  verdict: RuleVerdict<D> | undefined,
): void {
  const owner = captureGeneration();
  const record: ClassifyShadowRecord = {
    domain: domain.name,
    at: new Date().toISOString(),
    state: "",
    rule: verdict ? { label: verdict.label, terminal: verdict.terminal } : null,
  };
  void (async () => {
    try {
      record.state = domain.state(input).slice(0, 4_000);
      const response = await jevDecide(domain, record.state, owner);
      assertCurrent(owner);
      const decided = domain.decide(response.answers);
      if (!decided) {
        record.error = "JEV answers did not map to a domain label";
      } else {
        record.jev = {
          label: decided.label,
          confidence: decided.confidence,
          ...(response.model ? { model: response.model } : {}),
        };
        record.agree = decided.label === verdict?.label;
      }
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
    }
    try {
      if (owner.generation === generation) owner.config.onShadow?.(record);
    } catch {
      // Shadow reporting must never break the caller.
    }
  })();
}

/**
 * Synchronous classification — the only path sync call sites (e.g. the retry
 * boundary inside `classifyRetryError`) can use. L0 rules always answer; when
 * enabled and the domain is not "off", a background JEV shadow observation is
 * fired for eval purposes. The returned label is always the rule/fallback one.
 */
export function classifySync<D extends string, I>(
  domainOrName: ClassifyDomain<D, I> | string,
  input: I,
): ClassifyResult<D> {
  const domain = (typeof domainOrName === "string" ? registry.get(domainOrName) : domainOrName) as
    | ClassifyDomain<D, I>
    | undefined;
  if (!domain) throw new Error(`Unknown classifier domain: ${String(domainOrName)}`);
  const verdict = safeRules(domain, input);
  const mode = config.enabled === true ? effectiveMode(domain as ClassifyDomain<string, unknown>) : "off";
  if (mode !== "off") fireShadow(domain, input, verdict);
  if (verdict) {
    return {
      label: verdict.label,
      confidence: verdict.terminal ? 1 : 0,
      layer: "rule",
      ...(verdict.terminal ? {} : { degradedReason: "rule default branch" }),
    };
  }
  const fallback = domain.fallback(mode === "off" ? "classifier disabled" : "no rule verdict");
  return { label: fallback.label, confidence: fallback.confidence, layer: "degraded", degradedReason: mode === "off" ? "classifier disabled" : "no rule verdict" };
}

/**
 * Async classification — full L0 → L1 pipeline for callers that can await.
 * Never throws: failures degrade to the provisional rule label or the domain
 * fallback with `layer: "degraded"` and a `degradedReason`.
 */
export async function classify<D extends string, I>(
  domainOrName: ClassifyDomain<D, I> | string,
  input: I,
): Promise<ClassifyResult<D>> {
  const domain = (typeof domainOrName === "string" ? registry.get(domainOrName) : domainOrName) as
    | ClassifyDomain<D, I>
    | undefined;
  if (!domain) throw new Error(`Unknown classifier domain: ${String(domainOrName)}`);
  const verdict = safeRules(domain, input);
  const mode = config.enabled === true ? effectiveMode(domain as ClassifyDomain<string, unknown>) : "off";
  if (verdict?.terminal === true) {
    if (mode === "shadow") fireShadow(domain, input, verdict);
    return { label: verdict.label, confidence: 1, layer: "rule" };
  }
  if (mode !== "jev") {
    if (mode === "shadow") fireShadow(domain, input, verdict);
    if (verdict) {
      return {
        label: verdict.label,
        confidence: 0,
        layer: "rule",
        degradedReason: "rule default branch",
      };
    }
    const fallback = domain.fallback(mode === "off" ? "classifier disabled" : "no rule verdict");
    return { label: fallback.label, confidence: fallback.confidence, layer: "degraded", degradedReason: mode === "off" ? "classifier disabled" : "no rule verdict" };
  }
  const owner = captureGeneration();
  try {
    const state = domain.state(input);
    const response = await jevDecide(domain, state, owner);
    assertCurrent(owner);
    const decided = domain.decide(response.answers);
    assertCurrent(owner);
    if (!decided) return degraded(domain, verdict, "JEV answers did not map to a domain label");
    return {
      label: decided.label,
      confidence: decided.confidence,
      layer: "jev",
      ...(decided.probabilities ? { probabilities: decided.probabilities } : {}),
      ...(response.model ? { model: response.model } : {}),
    };
  } catch (error) {
    return degraded(domain, verdict, error instanceof Error ? error.message : String(error));
  }
}
