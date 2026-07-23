export const NETWORK_RETRY_POLICY = Object.freeze({
  maxRetries: 5,
  initialDelayMs: 1_000,
  maxDelayMs: 16_000,
});

export type RetryErrorKind = "network" | "provider" | "non-retryable";

const NON_RETRYABLE_ERROR =
  /usage[_\s-]*limit|multi-auth rotation failed|unauthori[sz]ed|invalid api key|forbidden|invalid model|unknown model|context[_\s-]*length[_\s-]*exceeded|input exceeds the context window|schema[-\s]*valid|validation (?:failed|error)/i;

const NETWORK_ERROR =
  /\b(?:econnreset|econnrefused|ehostunreach|enotfound|eai_again|etimedout|socket hang up|fetch failed|network(?: error| request)?|websocket closed|sse response headers timed out|headers timed out|tls|certificate)\b/i;

const PROVIDER_ERROR =
  /\b(?:429|5\d\d|rate limit(?:ed)?|capacity|overloaded|unavailable|provider returned error)\b/i;

export function classifyRetryError(message: string | undefined): RetryErrorKind {
  if (!message || NON_RETRYABLE_ERROR.test(message)) return "non-retryable";
  if (NETWORK_ERROR.test(message)) return "network";
  if (PROVIDER_ERROR.test(message)) return "provider";
  return "non-retryable";
}

export function isRetryableProviderError(message: string | undefined): boolean {
  return classifyRetryError(message) !== "non-retryable";
}

export function retryDelayMs(retry: number): number {
  const normalizedRetry = Math.max(1, Math.floor(retry));
  return Math.min(
    NETWORK_RETRY_POLICY.initialDelayMs * 2 ** (normalizedRetry - 1),
    NETWORK_RETRY_POLICY.maxDelayMs,
  );
}
