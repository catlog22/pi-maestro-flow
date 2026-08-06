import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentCacheRetention } from "../src/runs/execution.ts";

test("agent subprocesses pin the short cache tier by default", () => {
  assert.equal(resolveAgentCacheRetention({}), "short");
  assert.equal(
    resolveAgentCacheRetention({ PI_CACHE_RETENTION: "long" }),
    "short",
    "an inherited long retention on the main process must not leak into agents",
  );
});

test("agent cache tier honors an explicit PI_TEAMMATE_CACHE_RETENTION override", () => {
  assert.equal(resolveAgentCacheRetention({ PI_TEAMMATE_CACHE_RETENTION: "long" }), "long");
  assert.equal(resolveAgentCacheRetention({ PI_TEAMMATE_CACHE_RETENTION: "none" }), "none");
  assert.equal(resolveAgentCacheRetention({ PI_TEAMMATE_CACHE_RETENTION: "bogus" }), "short");
});
