import assert from "node:assert/strict";
import test from "node:test";
import { retryDelayMs } from "../src/runs/retry.ts";

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
