import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_STORED_RESULTS,
  clearResults,
  getAllResults,
  getResult,
  storeResult,
  type StoredSearchData,
} from "../src/tools/web-access/storage.ts";

function result(id: string, timestamp = Date.now()): StoredSearchData {
  return { id, type: "research", timestamp, artifact: { id } };
}

test("web research storage enforces TTL and LRU capacity", () => {
  clearResults();
  try {
    storeResult("expired", result("expired", 0));
    assert.equal(getResult("expired"), null);

    for (let index = 0; index <= MAX_STORED_RESULTS; index += 1) {
      const id = `result-${index}`;
      storeResult(id, result(id));
    }
    assert.equal(getAllResults().length, MAX_STORED_RESULTS);
    assert.equal(getResult("result-0"), null);
    assert.equal(getResult(`result-${MAX_STORED_RESULTS}`)?.id, `result-${MAX_STORED_RESULTS}`);
  } finally {
    clearResults();
  }
});

test("web research storage refreshes an existing id in LRU order", () => {
  clearResults();
  try {
    for (let index = 0; index < MAX_STORED_RESULTS; index += 1) {
      const id = `result-${index}`;
      storeResult(id, result(id));
    }
    storeResult("result-0", result("result-0"));
    storeResult("newest", result("newest"));

    assert.equal(getResult("result-0")?.id, "result-0");
    assert.equal(getResult("result-1"), null);
    assert.equal(getResult("newest")?.id, "newest");
  } finally {
    clearResults();
  }
});
