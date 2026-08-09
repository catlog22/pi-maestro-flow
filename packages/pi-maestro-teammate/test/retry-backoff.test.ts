import assert from "node:assert/strict";
import test from "node:test";
import { retryDelayMs, resolveNetworkRetryPolicy } from "../src/runs/retry.ts";

test("quota, auth, and permanent failures switch candidates without backoff", () => {
  assert.equal(retryDelayMs(1, "fallback-only"), 0);
  assert.equal(retryDelayMs(5, "auth"), 0);
  assert.equal(retryDelayMs(3, "non-retryable"), 0);
});

test("transient failures back off exponentially up to the policy cap", () => {
  assert.equal(retryDelayMs(1, "network"), 1_000);
  assert.equal(retryDelayMs(2, "provider"), 2_000);
  assert.equal(retryDelayMs(3, "network"), 4_000);
  assert.equal(retryDelayMs(4, "provider"), 8_000);
  assert.equal(retryDelayMs(6, "network"), 16_000); // maxDelayMs cap
  assert.equal(retryDelayMs(20, "provider"), 16_000);
});

test("legacy single-argument signature keeps the exponential policy", () => {
  assert.equal(retryDelayMs(1), 1_000);
  assert.equal(retryDelayMs(2), 2_000);
  assert.equal(retryDelayMs(9), 16_000);
});

test("a provider retry-after hint caps the backoff (earliest of the two)", () => {
  assert.equal(retryDelayMs(1, "provider", 250), 250);
  assert.equal(retryDelayMs(1, "network", 0), 0);
  // Hint longer than the backoff: the backoff wins.
  assert.equal(retryDelayMs(3, "network", 30_000), 4_000);
  // Hints never apply to switch-immediately kinds.
  assert.equal(retryDelayMs(2, "fallback-only", 60_000), 0);
});

test("PI_RETRY_MAX_DELAY_MS overrides the backoff cap (last retry wait)", async () => {
  const policy = resolveNetworkRetryPolicy({ PI_RETRY_MAX_DELAY_MS: "32000" });
  assert.equal(policy.maxDelayMs, 32_000);
  assert.equal(policy.maxRetries, 5);
  assert.equal(policy.initialDelayMs, 1_000);
  assert.equal(resolveNetworkRetryPolicy({ PI_RETRY_MAX_DELAY_MS: "-5" }).maxDelayMs, 16_000);
  assert.equal(resolveNetworkRetryPolicy({ PI_RETRY_MAX_DELAY_MS: "abc" }).maxDelayMs, 16_000);

  process.env.PI_RETRY_MAX_DELAY_MS = "32000";
  try {
    // Query-string specifier forces a fresh module instance so the env
    // override is re-read; a bare path would hit the ESM cache.
    const specifier = new URL("../src/runs/retry.ts", import.meta.url).href + "?cap=32000";
    const fresh = await import(specifier);
    assert.equal(fresh.RESOLVED_NETWORK_RETRY_POLICY.maxDelayMs, 32_000);
    assert.equal(fresh.retryDelayMs(9, "network"), 32_000);
  } finally {
    delete process.env.PI_RETRY_MAX_DELAY_MS;
  }
});
