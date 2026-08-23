import type { ModelHealthScope, ModelHealthTarget } from "../models/model-circuit-breaker.ts";
export declare const NETWORK_RETRY_POLICY: Readonly<{
    maxRetries: 10;
    initialDelayMs: 1000;
    maxDelayMs: 16000;
}>;
/**
 * Resolve the network retry policy, honoring the `PI_RETRY_MAX_DELAY_MS`
 * override for the backoff cap (last retry's maximum wait).
 */
export declare function resolveNetworkRetryPolicy(env?: Record<string, string | undefined>): Readonly<{
    maxRetries: number;
    initialDelayMs: number;
    maxDelayMs: number;
}>;
export declare const RESOLVED_NETWORK_RETRY_POLICY: Readonly<{
    maxRetries: number;
    initialDelayMs: number;
    maxDelayMs: number;
}>;
export type RetryErrorKind = "network" | "provider" | "fallback-only" | "auth" | "non-retryable";
export type ModelHealthFailureScope = ModelHealthScope | "none";
export interface ModelHealthFailureInput {
    message?: string;
    status?: number;
    /** Authoritative backend-aware override when the text cannot identify ownership. */
    scope?: ModelHealthFailureScope;
}
export interface ModelHealthFailureFacts extends ModelHealthFailureInput {
    retryKind: RetryErrorKind;
}
export interface ModelHealthFailureClassification {
    retryKind: RetryErrorKind;
    scope: ModelHealthFailureScope;
    affectsCircuit: boolean;
    suppressAuth: boolean;
}
/** Optional backend hook for assigning a failure to deployment or route health. */
export type ModelHealthFailureScopeClassifier = (failure: Readonly<ModelHealthFailureFacts>) => ModelHealthFailureScope | undefined;
export interface ModelHealthAttemptSnapshot {
    projectionFingerprint?: string;
    quarantinedDeployments: readonly string[];
    authSuppressions: readonly string[];
}
/**
 * Classify a provider failure for retry/fallback decisions.
 *
 * `status` (when known) normally short-circuits via {@link classifyByStatus};
 * an explicit upstream model-unavailable diagnostic is the narrow exception
 * because another configured candidate may still work. Otherwise the message
 * patterns apply, in order: auth → abort/cancel → permanent → local
 * infrastructure → quota/payment → transport → provider overload. Anything
 * unrecognized defaults to retryable (`provider`): at the provider boundary an
 * unknown diagnostic is far more often transient than permanent, and the
 * retry/fallback paths are bounded anyway. Abort/cancel diagnostics are the
 * exception: a user/lifecycle cancellation is never a model failure, so they
 * classify as `non-retryable` to avoid replaying stopped work on any model.
 */
export declare function classifyRetryError(message: string | undefined, status?: number): RetryErrorKind;
/**
 * Classify a registry-mode failure without coupling retry text parsing to a
 * backend implementation. Backends may supply a scope directly or a hook for
 * structured transport/provider errors; the retry kind remains the shared
 * legacy classifier result.
 */
export declare function classifyModelHealthFailure(failure: ModelHealthFailureInput, classifyScope?: ModelHealthFailureScopeClassifier): ModelHealthFailureClassification;
/** Collision-safe key for an attempt-local, scope-specific auth suppression. */
export declare function modelHealthAuthSuppressionKey(scope: ModelHealthScope, target: ModelHealthTarget): string;
export declare function isModelHealthAuthSuppressed(suppressions: ReadonlySet<string>, target: ModelHealthTarget): boolean;
/** Candidate-sweep state; never survives the attempt that created it. */
export declare class ModelHealthAttemptState {
    private fingerprint;
    private readonly quarantinedDeployments;
    private readonly authSuppressions;
    constructor(projectionFingerprint?: string);
    get projectionFingerprint(): string | undefined;
    /** Clear attempt-local decisions when a new registry projection is observed. */
    reconcileProjectionFingerprint(projectionFingerprint: string): boolean;
    quarantineDeployment(deploymentId: string): void;
    isDeploymentQuarantined(deploymentId: string): boolean;
    suppressAuth(scope: ModelHealthScope, target: ModelHealthTarget): void;
    isAuthSuppressed(target: ModelHealthTarget): boolean;
    shouldSkip(target: ModelHealthTarget): boolean;
    noteFailure(target: ModelHealthTarget, failure: ModelHealthFailureClassification): void;
    snapshot(): ModelHealthAttemptSnapshot;
}
/**
 * Pi core owns same-model provider retries in both the root session and
 * teammate children, but older Pi retry classifiers do not recognize the
 * machine-readable `stream_read_error` code. Add a semantic marker they
 * understand without replacing the original diagnostic.
 */
export declare function normalizePiRetryErrorMessage(message: string | undefined): string | undefined;
/** Preserve the provider diagnostic while making a raced user cancellation non-retryable to Pi core. */
export declare function markPiRetryErrorCancelled(message: string | undefined): string;
/** True when the failure is an authentication/permission problem. */
export declare function isAuthError(message: string | undefined, status?: number): boolean;
/** Whether the same model/credential is worth retrying (transient transport or provider overload). */
export declare function isRetryableProviderError(message: string | undefined, status?: number): boolean;
/** Whether switching to another model candidate can plausibly recover the failure. */
export declare function isFallbackProviderError(message: string | undefined, status?: number): boolean;
/**
 * Extract a provider-requested retry delay from an error message, in
 * milliseconds relative to `now`. Understands the standard `Retry-After`
 * header (relative seconds), `x-ratelimit-reset-ms` (epoch ms),
 * `x-ratelimit-reset` (epoch seconds, or ms past the 1e12 boundary), and an
 * ISO-8601 reset timestamp. Returns `undefined` when no hint is present.
 */
export declare function extractRetryAfterMs(message: string | undefined, now?: number): number | undefined;
/**
 * Backoff delay before the next attempt, in milliseconds.
 *
 * Quota/payment, model-unavailable, auth, and permanent failures return 0 —
 * those conditions are resolved by switching candidates or reporting the
 * terminal error, not by waiting on the same model. Transient failures get
 * the exponential backoff (1s → maxDelayMs); a
 * provider-requested `retryAfterMs` caps the delay (earliest of the two).
 */
export declare function retryDelayMs(retry: number, kind?: RetryErrorKind, retryAfterMs?: number): number;
