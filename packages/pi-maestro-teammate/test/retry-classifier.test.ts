import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import {
  classifyRetryError,
  extractRetryAfterMs,
  isAuthError,
  isFallbackProviderError,
  isRetryableProviderError,
  normalizePiRetryErrorMessage,
} from "../src/runs/retry.ts";

test("standalone transport terminations and timeouts classify as network errors", () => {
  // undici fetch aborts surface as a bare "terminated" error; pi-ai's own
  // retry classifier treats it as transient, so the failover classifier must
  // agree or the main agent and teammate paths silently skip retry/fallback.
  assert.equal(classifyRetryError("Error: terminated"), "network");
  assert.equal(classifyRetryError("terminated"), "network");
  assert.equal(classifyRetryError("connection terminated"), "network");
  assert.equal(classifyRetryError("Error: timeout"), "network");
  assert.equal(classifyRetryError("request timed out"), "network");
  assert.equal(classifyRetryError("fetch failed"), "network");
  assert.equal(isRetryableProviderError("Error: terminated"), true);
  assert.equal(isFallbackProviderError("Error: terminated"), true);
});

test("stream_read_error is normalized into Pi-owned provider retry", () => {
  const raw = "stream_read_error: upstream response body closed";
  assert.equal(classifyRetryError(raw), "network");
  assert.equal(classifyRetryError("Stream read error"), "network");
  assert.equal(isRetryableProviderError(raw), true);
  assert.equal(isFallbackProviderError(raw), true);

  const normalized = normalizePiRetryErrorMessage(raw);
  assert.equal(normalized, `${raw} (network error)`);
  assert.equal(normalizePiRetryErrorMessage(normalized), normalized);
  assert.equal(normalizePiRetryErrorMessage("context_length_exceeded"), "context_length_exceeded");
  assert.equal(
    normalizePiRetryErrorMessage("stream_read_error: HTTP 400 bad request"),
    "stream_read_error: HTTP 400 bad request",
  );
  assert.equal(isRetryableAssistantError({
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: normalized,
    timestamp: 0,
  }), true);
});

test("host:port text in connection errors is not mistaken for an HTTP status", () => {
  assert.equal(classifyRetryError("connect ECONNREFUSED 127.0.0.1:401"), "network");
  assert.equal(classifyRetryError("connect ECONNREFUSED 10.0.0.1:403"), "network");
  assert.equal(classifyRetryError("request to http://localhost:4000/v1 failed: connection refused"), "network");
});

test("auth failures classify as auth and are fallback-eligible but never retried", () => {
  assert.equal(classifyRetryError("Unauthorized: invalid API key"), "auth");
  assert.equal(classifyRetryError("HTTP 401 Unauthorized"), "auth");
  assert.equal(classifyRetryError("status 403 forbidden"), "auth");
  assert.equal(classifyRetryError("Error code: (401)"), "auth");
  assert.equal(classifyRetryError("access token expired"), "auth");
  assert.equal(classifyRetryError("authentication failed"), "auth");
  assert.equal(isAuthError("invalid api key"), true);
  assert.equal(isAuthError("connection reset"), false);
  // A broken credential will not heal by retrying the same model — but a
  // different model (with its own key) can recover, so fallback stays open.
  assert.equal(isRetryableProviderError("HTTP 401 Unauthorized"), false);
  assert.equal(isFallbackProviderError("Unauthorized: invalid API key"), true);
});

test("HTTP status short-circuits message text (authoritative)", () => {
  assert.equal(classifyRetryError("Provider returned error", 401), "auth");
  assert.equal(classifyRetryError("everything looks fine", 403), "auth");
  assert.equal(classifyRetryError("random failure", 402), "fallback-only");
  assert.equal(classifyRetryError("random failure", 429), "provider");
  assert.equal(classifyRetryError("random failure", 503), "provider");
  assert.equal(classifyRetryError("random failure", 400), "non-retryable");
  assert.equal(classifyRetryError("random failure", 404), "non-retryable");
  assert.equal(classifyRetryError("random failure", 422), "non-retryable");
  // A sub-400 status leaves the message text in charge.
  assert.equal(classifyRetryError("fetch failed", 200), "network");
  // Statuses embedded in messages take the same authoritative path.
  assert.equal(classifyRetryError("Provider error: 408"), "provider");
  assert.equal(classifyRetryError("429 Too Many Requests"), "provider");
});

test("configured upstream model-unavailable failures switch candidates without same-model retry", () => {
  const groupedAccountError =
    'OpenAI API error (404): {"message":"Model \\"gpt-5.3-spark\\" is not supported by any configured account in this group","type":"model_not_found"}';
  assert.equal(classifyRetryError(groupedAccountError), "fallback-only");
  assert.equal(classifyRetryError("404 model_not_found", 404), "fallback-only");
  assert.equal(
    classifyRetryError('The model "retired-model" does not exist or you do not have access', 404),
    "fallback-only",
  );
  assert.equal(
    classifyRetryError('The model "retired-model" does not exist or you do not have access', 403),
    "fallback-only",
  );
  assert.equal(isRetryableProviderError(groupedAccountError), false);
  assert.equal(isFallbackProviderError(groupedAccountError), true);
});

test("genuine permanent errors stay non-retryable and not fallback-eligible", () => {
  assert.equal(classifyRetryError("context_length_exceeded"), "non-retryable");
  assert.equal(classifyRetryError("invalid model: gpt-9"), "non-retryable");
  assert.equal(classifyRetryError("validation error"), "non-retryable");
  assert.equal(isFallbackProviderError("context_length_exceeded"), false);
});

test("unrecognized failures default to retryable provider", () => {
  // Real-world unknown diagnostics observed in failover events: these used to
  // be judged permanent and killed runs; the default now retries/falls back.
  assert.equal(classifyRetryError("Provider finish_reason: error"), "provider");
  assert.equal(classifyRetryError("ERROR"), "provider");
  assert.equal(classifyRetryError("some totally new failure mode"), "provider");
  assert.equal(classifyRetryError(""), "provider");
  assert.equal(classifyRetryError(undefined), "provider");
  assert.equal(isRetryableProviderError("Provider finish_reason: error"), true);
  assert.equal(isFallbackProviderError("ERROR"), true);
});

test("provider and quota classes keep their existing routing", () => {
  assert.equal(classifyRetryError("Provider overloaded: 503"), "provider");
  assert.equal(classifyRetryError("402 insufficient_quota"), "fallback-only");
  assert.equal(isRetryableProviderError("402 insufficient_quota"), false);
  assert.equal(isFallbackProviderError("402 insufficient_quota"), true);
});

test("concurrency-limit wording without a status code classifies as retryable provider", () => {
  assert.equal(classifyRetryError("concurrency_limit_error: Too many concurrent requests"), "provider");
  assert.equal(classifyRetryError("maximum concurrent requests reached"), "provider");
  assert.equal(classifyRetryError("Too many concurrent invokes"), "provider");
  assert.equal(classifyRetryError("concurrency limit exceeded"), "provider");
  assert.equal(classifyRetryError("too many simultaneous requests"), "provider");
  assert.equal(classifyRetryError("You are sending requests too quickly"), "provider");
  assert.equal(isRetryableProviderError("Too many concurrent invokes"), true);
  assert.equal(isFallbackProviderError("concurrency limit exceeded"), true);
});

test("Python-style transport names classify as retryable", () => {
  assert.equal(classifyRetryError("requests.exceptions.ConnectionError: Max retries exceeded"), "network");
  assert.equal(classifyRetryError("ConnectionResetError: connection reset by peer"), "network");
  assert.equal(classifyRetryError("urllib3 ConnectionRefusedError"), "network");
  assert.equal(classifyRetryError("BrokenPipeError: [Errno 32]"), "network");
  assert.equal(classifyRetryError("TimeoutError: Read timed out"), "network");
  assert.equal(isRetryableProviderError("ConnectionResetError"), true);
});

test("retry-after hints parse into relative delays", () => {
  const now = 1_800_000_000_000;
  assert.equal(extractRetryAfterMs("Retry-After: 30", now), 30_000);
  assert.equal(extractRetryAfterMs("retry-after: 120", now), 120_000);
  assert.equal(extractRetryAfterMs("x-ratelimit-reset-ms: 1800000300000", now), 300_000);
  assert.equal(extractRetryAfterMs("x-ratelimit-reset: 1800000300", now), 300_000);
  assert.equal(extractRetryAfterMs("reset at 2027-01-01T00:00:00Z", Date.parse("2027-01-01T00:00:00Z")), 0);
  assert.equal(extractRetryAfterMs("no hints here", now), undefined);
  assert.equal(extractRetryAfterMs(undefined), undefined);
  // A bare status code is not a retry hint.
  assert.equal(extractRetryAfterMs("Provider overloaded: 503", now), undefined);
});
