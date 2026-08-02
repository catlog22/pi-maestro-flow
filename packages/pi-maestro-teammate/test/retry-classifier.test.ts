import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRetryError,
  isFallbackProviderError,
  isRetryableProviderError,
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

test("host:port text in connection errors is not mistaken for an HTTP status", () => {
  assert.equal(classifyRetryError("connect ECONNREFUSED 127.0.0.1:401"), "network");
  assert.equal(classifyRetryError("connect ECONNREFUSED 10.0.0.1:403"), "network");
  assert.equal(classifyRetryError("request to http://localhost:4000/v1 failed: connection refused"), "network");
});

test("genuine permanent errors stay non-retryable", () => {
  assert.equal(classifyRetryError("Unauthorized: invalid API key"), "non-retryable");
  assert.equal(classifyRetryError("HTTP 401 Unauthorized"), "non-retryable");
  assert.equal(classifyRetryError("status 403 forbidden"), "non-retryable");
  assert.equal(classifyRetryError("Error code: (401)"), "non-retryable");
  assert.equal(classifyRetryError("context_length_exceeded"), "non-retryable");
  assert.equal(classifyRetryError(undefined), "non-retryable");
  assert.equal(isRetryableProviderError("HTTP 401 Unauthorized"), false);
});

test("provider and quota classes keep their existing routing", () => {
  assert.equal(classifyRetryError("Provider overloaded: 503"), "provider");
  assert.equal(classifyRetryError("429 Too Many Requests"), "provider");
  assert.equal(classifyRetryError("402 insufficient_quota"), "fallback-only");
  assert.equal(isRetryableProviderError("402 insufficient_quota"), false);
  assert.equal(isFallbackProviderError("402 insufficient_quota"), true);
});

test("HTTP 408 and Python-style transport names classify as retryable", () => {
  assert.equal(classifyRetryError("HTTP 408 Request Timeout"), "network");
  assert.equal(classifyRetryError("Provider error: 408"), "provider");
  assert.equal(classifyRetryError("requests.exceptions.ConnectionError: Max retries exceeded"), "network");
  assert.equal(classifyRetryError("ConnectionResetError: connection reset by peer"), "network");
  assert.equal(classifyRetryError("urllib3 ConnectionRefusedError"), "network");
  assert.equal(classifyRetryError("BrokenPipeError: [Errno 32]"), "network");
  assert.equal(classifyRetryError("TimeoutError: Read timed out"), "network");
  assert.equal(isRetryableProviderError("ConnectionResetError"), true);
});
