export const NETWORK_RETRY_POLICY = Object.freeze({
  maxRetries: 5,
  initialDelayMs: 1_000,
  maxDelayMs: 16_000,
});

export type RetryErrorKind = "network" | "provider" | "fallback-only" | "auth" | "non-retryable";

/**
 * Authentication/permission failures: a bad key, expired/revoked token, or a
 * 401/403 response. Retrying the same model/credential cannot clear these, so
 * callers switch candidates instead of backing off (see `retryDelayMs`).
 *
 * Split out of the old non-retryable bucket so the main-agent failover can
 * keep its "auth never initiates a fresh logical replay" semantics while the
 * teammate candidate sweep treats auth as fallback-eligible (the next model
 * may carry a valid key).
 */
const AUTH_ERROR =
  /\b(?:unauthori[sz]ed|unauthenticated|authentication failed|invalid api key|(?:api |access |auth )?token (?:expired|invalid|revoked)|invalid credentials?|forbidden)\b/i;

// Status codes carry a (?<![:.\w]) guard instead of a leading \b so host:port
// text in connection errors ("ECONNREFUSED 127.0.0.1:401") is not mistaken
// for an HTTP 401/403 response and wrongly classified as permanent.
const NON_RETRYABLE_ERROR =
  /usage[_\s-]*limit|multi-auth rotation failed|bad request|invalid request|invalid model|unknown model|context[_\s-]*length[_\s-]*exceeded|input exceeds the context window|schema[-\s]*valid|validation (?:failed|error)/i;

const FALLBACK_ONLY_ERROR =
  /\b(?:402|insufficient[_\s-]*(?:quota|balance|credits?)|credits? exhausted|billing quota|quota exceeded|out of budget)\b/i;

const STREAM_READ_ERROR = /\bstream[_\s-]*read[_\s-]*error\b/i;

const NETWORK_ERROR =
  /\b(?:econnreset|econnrefused|econnaborted|enetunreach|enetdown|ehostunreach|enotfound|eai_again|etimedout|epipe|socket hang up|fetch failed|failed to fetch|getaddrinfo|network(?: ?error| request)?|connection (?:error|failed|failure|reset|refused|lost|timed out|timeout|closed|terminated)|other side closed|upstream connect|reset before headers|request timed out|timed out waiting|signal timed out|timed? out|timeout|terminated|(?:web)?socket (?:was )?(?:closed|error)|sse response headers timed out|headers timed out|stream ended (?:without|before)|http2 request did not get a response|connectionerror|connectionreseterror|connectionrefusederror|connectionabortederror|brokenpipeerror|timeouterror|remotedisconnected|read timed out|requests\.exceptions)\b/i;

const PROVIDER_ERROR =
  /\b(?:408|429|500|502|503|504|524|rate[_\s-]*limit(?:ed|[_\s-]*exceeded|[_\s-]*error)?|too many requests|capacity|overloaded(?:_error)?|service[_\s-]*unavailable|provider returned error|server[_\s-]*error|internal[_\s-]*error|resource[_\s-]*exhausted)\b/i;

// Mirrors the status-class guard above: a 3-digit 4xx/5xx token NOT preceded by
// a colon/dot/word char. The trailing \b keeps 4-digit numbers ("4000") and
// fractional timings ("0.500") from matching.
const HTTP_STATUS_IN_MESSAGE = /(?<![:.\w])\b(4\d\d|5\d\d)\b/i;

function extractHttpStatusFromMessage(message: string): number | undefined {
  const match = HTTP_STATUS_IN_MESSAGE.exec(message);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Map an HTTP status to its retry kind. Status is authoritative over message
 * text: a real 401/403 is always auth, a real 429/5xx is always provider,
 * other 4xx are permanent. Returns `undefined` for sub-400 statuses so the
 * message-path classifiers decide.
 */
function classifyByStatus(status: number | undefined): RetryErrorKind | undefined {
  if (status === undefined) return undefined;
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "fallback-only";
  if (status === 408 || status === 429 || status >= 500) return "provider";
  if (status >= 400 && status < 500) return "non-retryable";
  return undefined;
}

/**
 * Classify a provider failure for retry/fallback decisions.
 *
 * `status` (when known) short-circuits via {@link classifyByStatus}; otherwise
 * a 3-digit 4xx/5xx token is extracted from the message. With no status the
 * message patterns apply, in order: auth → permanent → quota/payment →
 * transport → provider overload.
 */
export function classifyRetryError(message: string | undefined, status?: number): RetryErrorKind {
  if (!message) return "non-retryable";
  const effectiveStatus = status ?? extractHttpStatusFromMessage(message);
  const byStatus = classifyByStatus(effectiveStatus);
  if (byStatus !== undefined) return byStatus;
  if (AUTH_ERROR.test(message)) return "auth";
  if (NON_RETRYABLE_ERROR.test(message)) return "non-retryable";
  if (FALLBACK_ONLY_ERROR.test(message)) return "fallback-only";
  if (STREAM_READ_ERROR.test(message)) return "network";
  if (NETWORK_ERROR.test(message)) return "network";
  if (PROVIDER_ERROR.test(message)) return "provider";
  return "non-retryable";
}

/**
 * Pi core owns child provider retries, but older Pi retry classifiers do not
 * recognize the machine-readable `stream_read_error` code. Add a semantic
 * marker they understand without replacing the original diagnostic.
 */
export function normalizePiRetryErrorMessage(message: string | undefined): string | undefined {
  if (
    !message
    || classifyRetryError(message) !== "network"
    || !STREAM_READ_ERROR.test(message)
    || /\bnetwork(?: ?error| request)?\b/i.test(message)
  ) {
    return message;
  }
  return `${message} (network error)`;
}

/** True when the failure is an authentication/permission problem. */
export function isAuthError(message: string | undefined, status?: number): boolean {
  return classifyRetryError(message, status) === "auth";
}

/** Whether the same model/credential is worth retrying (transient transport or provider overload). */
export function isRetryableProviderError(message: string | undefined, status?: number): boolean {
  const kind = classifyRetryError(message, status);
  return kind === "network" || kind === "provider";
}

/** Whether switching to another model candidate can plausibly recover the failure. */
export function isFallbackProviderError(message: string | undefined, status?: number): boolean {
  return classifyRetryError(message, status) !== "non-retryable";
}

/**
 * Extract a provider-requested retry delay from an error message, in
 * milliseconds relative to `now`. Understands the standard `Retry-After`
 * header (relative seconds), `x-ratelimit-reset-ms` (epoch ms),
 * `x-ratelimit-reset` (epoch seconds, or ms past the 1e12 boundary), and an
 * ISO-8601 reset timestamp. Returns `undefined` when no hint is present.
 */
export function extractRetryAfterMs(message: string | undefined, now = Date.now()): number | undefined {
  if (!message) return undefined;

  const retryAfter = /retry[-_ ]?after\s*[:=]\s*(\d+)/i.exec(message);
  if (retryAfter) {
    const seconds = Number(retryAfter[1]);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  }

  const resetMs = /x-ratelimit-reset-ms\s*[:=]\s*(\d+)/i.exec(message);
  if (resetMs) {
    const value = Number(resetMs[1]);
    if (Number.isFinite(value)) return Math.max(0, value - now);
  }

  const reset = /x-ratelimit-reset\s*[:=]\s*(\d+)/i.exec(message);
  if (reset) {
    const value = Number(reset[1]);
    if (!Number.isFinite(value)) return undefined;
    if (value > 1_000_000_000_000) return Math.max(0, value - now);
    return Math.max(0, value * 1000 - now);
  }

  const iso = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(message);
  if (iso) {
    const parsed = Date.parse(iso[1]);
    if (Number.isFinite(parsed)) return Math.max(0, parsed - now);
  }

  return undefined;
}

/**
 * Backoff delay before the next attempt, in milliseconds.
 *
 * Quota/payment, auth, and permanent failures return 0 — those conditions
 * are resolved by switching candidates, not by waiting on the same one.
 * Transient failures get the exponential backoff (1s → maxDelayMs); a
 * provider-requested `retryAfterMs` caps the delay (earliest of the two).
 */
export function retryDelayMs(retry: number, kind?: RetryErrorKind, retryAfterMs?: number): number {
  if (kind === "fallback-only" || kind === "auth" || kind === "non-retryable") return 0;
  const normalizedRetry = Math.max(1, Math.floor(retry));
  const backoff = Math.min(
    NETWORK_RETRY_POLICY.initialDelayMs * 2 ** (normalizedRetry - 1),
    NETWORK_RETRY_POLICY.maxDelayMs,
  );
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(backoff, retryAfterMs);
  }
  return backoff;
}
