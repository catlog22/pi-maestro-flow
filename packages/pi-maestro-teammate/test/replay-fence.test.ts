import assert from "node:assert/strict";
import test from "node:test";
import { buildReplayFence } from "../src/runs/recovery-protocol.ts";

test("clean evidence produces an unblocked fence", () => {
  const fence = buildReplayFence({ completedTools: [], unknownEffect: false });
  assert.equal(fence.blocked, false);
  assert.deepEqual(fence.completedTools, []);
});

test("completed tool names block with a named evidence reason", () => {
  const fence = buildReplayFence({ completedTools: ["write", "edit"], unknownEffect: false });
  assert.equal(fence.blocked, true);
  assert.equal(fence.blocked, true);
  assert.equal(
    fence.blockedReason,
    "Fresh replay blocked after completed tools: write, edit.",
  );
});

test("unknown effect blocks even with no completed tools", () => {
  const fence = buildReplayFence({ completedTools: [], unknownEffect: true });
  assert.equal(fence.blocked, true);
  assert.equal(
    fence.blockedReason,
    "Fresh replay blocked after one or more tool effects could not be confirmed.",
  );
});

test("count-based evidence blocks and accepts an explicit reason", () => {
  const fence = buildReplayFence({
    completedToolCount: 2,
    unknownEffect: false,
    blockedReason: "Fresh replay blocked after completedTools=2, inFlightTools=0.",
  });
  assert.equal(fence.blocked, true);
  assert.equal(fence.blockedReason, "Fresh replay blocked after completedTools=2, inFlightTools=0.");

  const inFlight = buildReplayFence({ completedToolCount: 0, unknownEffect: true });
  assert.equal(inFlight.blocked, true);

  const clear = buildReplayFence({ completedToolCount: 0, unknownEffect: false });
  assert.equal(clear.blocked, false);
});

test("default reason for count-only evidence names the count", () => {
  const fence = buildReplayFence({ completedToolCount: 3, unknownEffect: false });
  assert.equal(fence.blocked, true);
  assert.equal(fence.blockedReason, "Fresh replay blocked after completed tools: 3.");
});

test("fences freeze their evidence arrays", () => {
  const names = ["read"];
  const fence = buildReplayFence({ completedTools: names, unknownEffect: false });
  names.push("write");
  assert.deepEqual(fence.completedTools, ["read"], "fence must not alias the caller's array");
  assert.throws(() => {
    // @ts-expect-error frozen array is read-only
    fence.completedTools.push("write");
  });
});
