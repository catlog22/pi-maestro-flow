import assert from "node:assert/strict";
import test from "node:test";
import {
  CACHE_PRUNE_MIN_SAVINGS_RATIO,
  cacheWorthwhileDepth,
  dynamicPruneMinRatio,
  isCacheColdByTime,
  suffixTokenSums,
} from "../src/compaction/auto-compaction.ts";
import { createDefaultSoftCompaction } from "../src/compaction/compaction-settings.ts";

// ── dynamicPruneMinRatio (P1a) ───────────────────────────────────────────────

test("dynamicPruneMinRatio pivots the fixed 25% baseline on the hit ratio", () => {
  assert.equal(dynamicPruneMinRatio(0.5), CACHE_PRUNE_MIN_SAVINGS_RATIO);
  assert.ok(dynamicPruneMinRatio(0.9) > CACHE_PRUNE_MIN_SAVINGS_RATIO, "hot cache demands more savings");
  assert.ok(dynamicPruneMinRatio(0.1) < CACHE_PRUNE_MIN_SAVINGS_RATIO, "cold cache demands less");
});

test("dynamicPruneMinRatio clamps into the configured range", () => {
  assert.equal(dynamicPruneMinRatio(0, [0.2, 0.4]), 0.2);
  assert.equal(dynamicPruneMinRatio(0.5, [0.2, 0.4]), 0.25);
  // 0.375 is inside [0.2, 0.4], so no clamp applies.
  assert.equal(dynamicPruneMinRatio(1, [0.2, 0.4]), 0.375);
  assert.equal(dynamicPruneMinRatio(1, [0.1, 0.5]), 0.375);
});

// ── isCacheColdByTime (P1b) ──────────────────────────────────────────────────

function assistantWithTimestamp(timestamp: number) {
  return [{
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    timestamp,
  }] as never;
}

test("isCacheColdByTime fires only past the threshold", () => {
  const now = Date.now();
  const old = now - 2 * 3600 * 1000; // 2h ago
  const recent = now - 10 * 60 * 1000; // 10m ago
  assert.equal(isCacheColdByTime(assistantWithTimestamp(old), 60, now), true);
  assert.equal(isCacheColdByTime(assistantWithTimestamp(recent), 60, now), false);
  assert.equal(isCacheColdByTime([{
    role: "assistant",
    content: [],
    timestamp: new Date(old).toISOString(),
  }] as never, 60, now), true);
});

test("isCacheColdByTime is conservative on unknown age", () => {
  assert.equal(isCacheColdByTime([{ role: "assistant", content: [] }] as never, 60), false);
  assert.equal(isCacheColdByTime([] as never, 60), false);
  assert.equal(isCacheColdByTime(assistantWithTimestamp(Date.now() - 3600e3), 0, Date.now()), false);
  const old = Date.now() - 2 * 3600e3;
  assert.equal(isCacheColdByTime([
    ...assistantWithTimestamp(old),
    { role: "assistant", content: [] },
  ] as never, 60), false, "an unknown latest timestamp must not fall back to older activity");
});

// ── gate composition: hit ratio pivots the depth decision ────────────────────

test("hot cache raises the savings bar so the same candidate run is vetoed", () => {
  // One candidate saving 3.7K at index 1; invalidated suffix ~18K.
  const candidates = [{ index: 1, saved: 3_747 }];
  const suffix = [18_455, 18_402, 14_575, 14_551, 22, 0];
  // hit=0.655 -> minRatio ~0.289 -> needs 5.3K > 3.7K -> depth 0 (gate holds)
  assert.equal(cacheWorthwhileDepth(candidates, suffix, dynamicPruneMinRatio(0.655)), 0);
  // hit=0.05 -> minRatio ~0.1375 -> needs 2.5K <= 3.7K -> depth 1 (gate passes)
  assert.equal(cacheWorthwhileDepth(candidates, suffix, dynamicPruneMinRatio(0.05)), 1);
  // baseline unchanged at hit=0.5
  assert.equal(dynamicPruneMinRatio(0.5), CACHE_PRUNE_MIN_SAVINGS_RATIO);
});

test("cross-tier planning retains the earliest invalidated prefix", () => {
  const suffix: number[] = [];
  suffix[2] = 10_000;
  suffix[8] = 2_000;
  // Tier concatenation can make indices non-monotonic. Candidate 2 must still
  // pay from index 2, not the later index 8 where it happens to appear.
  const candidates = [{ index: 2, saved: 1_000 }, { index: 8, saved: 1_000 }];
  assert.equal(cacheWorthwhileDepth(candidates, suffix, 0.25), 0);
});

test("settings default exposes the lossless/timeBased/cache toggles", () => {
  const soft = createDefaultSoftCompaction();
  assert.equal(soft.lossless.enabled, true);
  assert.equal(soft.timeBased?.enabled, false);
  assert.equal(soft.timeBased?.gapThresholdMinutes, 60);
  assert.deepEqual(soft.cache.minRatioRange, [0.1, 0.5]);
  assert.deepEqual(soft.relevance, { enabled: false, mode: "bm25" });
});

test("suffixTokenSums stays monotonic (support for gate math)", () => {
  const messages = [
    { role: "assistant", content: [] },
    { role: "toolResult", toolCallId: "a", toolName: "bash", content: [{ type: "text", text: "x".repeat(8_000) }], isError: false },
    { role: "toolResult", toolCallId: "b", toolName: "read", content: [{ type: "text", text: "y".repeat(4_000) }], isError: false },
  ] as never;
  const suffix = suffixTokenSums(messages);
  assert.ok(suffix[0] >= suffix[1] && suffix[1] >= suffix[2] && suffix[2] >= suffix[3]);
  assert.equal(suffix[suffix.length - 1], 0);
});
