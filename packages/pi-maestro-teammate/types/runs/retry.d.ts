export declare const NETWORK_RETRY_POLICY: Readonly<{
    maxRetries: 5;
    initialDelayMs: 1000;
    maxDelayMs: 16000;
}>;
export type RetryErrorKind = "network" | "provider" | "fallback-only" | "auth" | "non-retryable";
/**
 * Classify a provider failure for retry/fallback decisions.
 *
 * `status` (when known) short-circuits via {@link classifyByStatus}; otherwise
 * a 3-digit 4xx/5xx token is extracted from the message. With no status the
 * message patterns apply, in order: auth → permanent → quota/payment →
 * transport → provider overload.
 */
export declare function classifyRetryError(message: string | undefined, status?: number): RetryErrorKind;
/**
 * Pi core owns same-model provider retries in both the root session and
 * teammate children, but older Pi retry classifiers do not recognize the
 * machine-readable `stream_read_error` code. Add a semantic marker they
 * understand without replacing the original diagnostic.
 */
export declare function normalizePiRetryErrorMessage(message: string | undefined): string | undefined;
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
 * Quota/payment, auth, and permanent failures return 0 — those conditions
 * are resolved by switching candidates, not by waiting on the same one.
 * Transient failures get the exponential backoff (1s → maxDelayMs); a
 * provider-requested `retryAfterMs` caps the delay (earliest of the two).
 */
export declare function retryDelayMs(retry: number, kind?: RetryErrorKind, retryAfterMs?: number): number;
