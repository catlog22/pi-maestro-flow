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
import { type ClassifierRuntime, type ClassifierRuntimeReadiness, type JevEndpoint } from "./client.ts";
import type { ClassifierDomainMode, ClassifyDomain, ClassifyResult, ClassifyShadowRecord } from "./types.ts";
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
    /** Max JEV calls per process-local session + cwd identity (default 30). */
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
    runtimeStatus?: ClassifierRuntimeReadiness["status"];
    runtimeReason?: string;
    effectiveModel?: string;
    callsUsed: number;
    maxCalls: number;
    cacheSize: number;
    domains: Record<string, ClassifierDomainStatus>;
}
export interface ClassifierRuntimeBinding {
    hostVersion: string;
    runtime: ClassifierRuntime;
    sessionId?: string;
    cwd?: string;
}
export type { ClassifierRuntimeReadiness } from "./client.ts";
/** Bind only the current process's host facade, never a child/remote runtime. */
export declare function bindClassifierRuntime(binding: ClassifierRuntimeBinding): void;
export declare function unbindClassifierRuntime(runtime: ClassifierRuntime): void;
/** Inject classifier configuration (host loads `.pi/classifier.json` / env). */
export declare function configureClassifier(next: ClassifierConfig): void;
/** Refresh authentication/model readiness without spending model-call quota. */
export declare function probeClassifierRuntime(signal?: AbortSignal): Promise<ClassifierRuntimeReadiness>;
export declare function classifierConfig(): ClassifierConfig;
/** @internal Test seam: restore the disabled-by-default engine state. */
export declare function resetClassifierForTest(): void;
export declare function registerClassifyDomain<D extends string, I>(domain: ClassifyDomain<D, I>): void;
export declare function classifyDomain(name: string): ClassifyDomain<string, unknown> | undefined;
export declare function listClassifyDomains(): string[];
export declare function classifierStatus(): ClassifierStatus;
/**
 * Synchronous classification — the only path sync call sites (e.g. the retry
 * boundary inside `classifyRetryError`) can use. L0 rules always answer; when
 * enabled and the domain is not "off", a background JEV shadow observation is
 * fired for eval purposes. The returned label is always the rule/fallback one.
 */
export declare function classifySync<D extends string, I>(domainOrName: ClassifyDomain<D, I> | string, input: I): ClassifyResult<D>;
/**
 * Async classification — full L0 → L1 pipeline for callers that can await.
 * Never throws: failures degrade to the provisional rule label or the domain
 * fallback with `layer: "degraded"` and a `degradedReason`.
 */
export declare function classify<D extends string, I>(domainOrName: ClassifyDomain<D, I> | string, input: I): Promise<ClassifyResult<D>>;
