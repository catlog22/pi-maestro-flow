import assert from "node:assert/strict";
import test from "node:test";
import { createUiSessionMessageBuffer } from "../src/mcp/ui-server.ts";

test("MCP UI message retention keeps a bounded tail across message kinds", () => {
  const buffer = createUiSessionMessageBuffer({ maxItems: 3, maxBytes: 1_024, maxItemBytes: 128 });
  buffer.addPrompt("first");
  buffer.addNotification("second");
  buffer.addIntent("third", { value: 3 });
  buffer.addPrompt("fourth");

  const snapshot = buffer.snapshot();
  assert.deepEqual(snapshot.prompts, ["fourth"]);
  assert.deepEqual(snapshot.notifications, ["second"]);
  assert.deepEqual(snapshot.intents, [{ intent: "third", params: { value: 3 } }]);
  assert.equal(snapshot.retention?.droppedItems, 1);
});

test("MCP UI message retention truncates oversized strings and intent params", () => {
  const buffer = createUiSessionMessageBuffer({ maxItems: 10, maxBytes: 1_024, maxItemBytes: 64 });
  buffer.addPrompt("x".repeat(256));
  buffer.addIntent("intent", { payload: "y".repeat(256) });

  const snapshot = buffer.snapshot();
  assert.ok(Buffer.byteLength(snapshot.prompts[0] ?? "", "utf8") <= 64);
  assert.deepEqual(snapshot.intents, [{ intent: "intent", params: { _truncated: true } }]);
  assert.equal(snapshot.retention?.truncatedItems, 2);
});

test("MCP UI message retention enforces a total byte budget", () => {
  const buffer = createUiSessionMessageBuffer({ maxItems: 10, maxBytes: 100, maxItemBytes: 80 });
  buffer.addPrompt("a".repeat(50));
  buffer.addNotification("b".repeat(50));
  buffer.addPrompt("c".repeat(50));

  const snapshot = buffer.snapshot();
  assert.ok((snapshot.retention?.retainedBytes ?? Number.POSITIVE_INFINITY) <= 100);
  assert.ok((snapshot.retention?.droppedItems ?? 0) >= 1);
  assert.deepEqual(snapshot.prompts, ["c".repeat(50)]);
});
