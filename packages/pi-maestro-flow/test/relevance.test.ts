import assert from "node:assert/strict";
import test from "node:test";
import {
  RELEVANCE_MAX_QUERY_TOKENS,
  scoreRelevanceBatch,
  tokenizeRelevance,
} from "../src/compaction/relevance.ts";

test("BM25 ranks an exact UUID match above unrelated output", () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const scores = scoreRelevanceBatch([
    `record id=${uuid} status=failed`,
    "record id=123e4567-e89b-12d3-a456-426614174000 status=ok",
  ], `find record ${uuid}`, "bm25");
  assert.ok(scores[0] > scores[1]);
});

test("BM25 downweights common terms and rewards discriminative terms", () => {
  const scores = scoreRelevanceBatch([
    "shared zeta",
    "shared alpha",
    "shared beta",
    "shared gamma",
  ], "shared zeta", "bm25");
  assert.ok(scores[0] > scores[1]);
  assert.ok(scores[0] > scores[2]);
});

test("keyword mode scores unique query-term overlap", () => {
  const scores = scoreRelevanceBatch([
    "connection refused error",
    "request completed",
  ], "connection error", "keyword");
  assert.equal(scores[0], 1);
  assert.equal(scores[1], 0);
});

test("CJK bigrams make Chinese prompts lexically rankable", () => {
  assert.deepEqual(tokenizeRelevance("缓存命中"), ["缓存", "存命", "命中"]);
  const scores = scoreRelevanceBatch([
    "缓存命中率下降",
    "构建产物已完成",
  ], "检查缓存命中", "bm25");
  assert.ok(scores[0] > scores[1]);
});

test("relevance token budgets stop high-cardinality query work", () => {
  const noisyTerms = Array.from(
    { length: RELEVANCE_MAX_QUERY_TOKENS * 4 },
    (_, index) => `noise_${index}`,
  );
  const query = ["needle", ...noisyTerms, "needle", "needle"].join(" ");
  assert.equal(tokenizeRelevance(query, 64).length, 64);
  const baseline = scoreRelevanceBatch(["needle"], "needle", "bm25")[0];
  const bounded = scoreRelevanceBatch(["needle"], query, "bm25")[0];
  assert.equal(bounded, baseline, "query terms beyond the budget cannot amplify work or score");
});

test("empty query preserves an all-zero stable tie", () => {
  assert.deepEqual(scoreRelevanceBatch(["a", "b"], "", "bm25"), [0, 0]);
});
