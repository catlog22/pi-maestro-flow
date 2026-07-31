export const NETWORK_RETRY_POLICY = Object.freeze({
  maxRetries: 10,
  initialDelayMs: 1_000,
  maxDelayMs: 16_000,
});

export type RetryErrorKind = "network" | "provider" | "fallback-only" | "non-retryable";

const NON_RETRYABLE_ERROR =
  /usage[_\s-]*limit|multi-auth rotation failed|unauthori[sz]ed|unauthenticated|authentication failed|invalid api key|(?:api |access |auth )?token (?:expired|invalid|revoked)|invalid credentials?|forbidden|\b(?:400|401|403|404|405|422)\b|bad request|invalid request|invalid model|unknown model|context[_\s-]*length[_\s-]*exceeded|input exceeds the context window|schema[-\s]*valid|validation (?:failed|error)/i;

const FALLBACK_ONLY_ERROR =
  /\b(?:402|insufficient[_\s-]*(?:quota|balance|credits?)|credits? exhausted|billing quota|quota exceeded|out of budget)\b/i;

const NETWORK_ERROR =
  /\b(?:econnreset|econnrefused|econnaborted|enetunreach|enetdown|ehostunreach|enotfound|eai_again|etimedout|epipe|socket hang up|fetch failed|getaddrinfo|network(?: error| request)?|connection (?:error|failed|failure|reset|refused|lost|timed out|timeout|closed)|other side closed|upstream connect|reset before headers|request timed out|timed out waiting|websocket (?:closed|error)|sse response headers timed out|headers timed out|stream ended (?:without|before)|http2 request did not get a response)\b/i;

const PROVIDER_ERROR =
  /\b(?:429|500|502|503|504|524|rate[_\s-]*limit(?:ed|_error)?|too many requests|capacity|overloaded(?:_error)?|service[_\s-]*unavailable|provider returned error|server[_\s-]*error|internal[_\s-]*error|resource[_\s-]*exhausted)\b/i;

export function classifyRetryError(message: string | undefined): RetryErrorKind {
  if (!message || NON_RETRYABLE_ERROR.test(message)) return "non-retryable";
  if (FALLBACK_ONLY_ERROR.test(message)) return "fallback-only";
  if (NETWORK_ERROR.test(message)) return "network";
  if (PROVIDER_ERROR.test(message)) return "provider";
  return "non-retryable";
}

export function isRetryableProviderError(message: string | undefined): boolean {
  const kind = classifyRetryError(message);
  return kind === "network" || kind === "provider";
}

export function isFallbackProviderError(message: string | undefined): boolean {
  return classifyRetryError(message) !== "non-retryable";
}

export function retryDelayMs(retry: number): number {
  const normalizedRetry = Math.max(1, Math.floor(retry));
  return Math.min(
    NETWORK_RETRY_POLICY.initialDelayMs * 2 ** (normalizedRetry - 1),
    NETWORK_RETRY_POLICY.maxDelayMs,
  );
}
