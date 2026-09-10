import assert from "node:assert/strict";
import test from "node:test";
import { GatewayEventJournal } from "../src/gateway/event-journal.ts";

function append(journal: GatewayEventJournal, handle: string, cursor: number, workspaceId = "workspace") {
  return journal.append({ workspaceId, sessionId: "session", handle, cursor, kind: "progress", payload: { n: cursor }, at: cursor });
}

test("10k small events remain bounded and replay in exact cursor order", () => {
  const journal = new GatewayEventJournal({
    maxEventsPerExecution: 10_000, maxBytesPerExecution: 2 * 1024 * 1024,
    maxEventsPerWorkspace: 10_000, maxBytesPerWorkspace: 2 * 1024 * 1024,
  });
  for (let cursor = 1; cursor <= 10_000; cursor += 1) append(journal, "execution", cursor);
  const page = journal.page("execution", 0, 10_000);
  assert.equal(page.events.length, 10_000);
  assert.deepEqual(page.events.map((event) => event.cursor), Array.from({ length: 10_000 }, (_, index) => index + 1));
  assert.equal(new Set(page.events.map((event) => event.eventId)).size, 10_000);
  assert.equal(page.gap, undefined);
  assert.ok(journal.stats("execution").bytes <= 2 * 1024 * 1024);
});

test("execution and workspace count/byte bounds expose a stable explicit recovery gap", () => {
  const journal = new GatewayEventJournal({
    maxEventsPerExecution: 3, maxBytesPerExecution: 1024,
    maxEventsPerWorkspace: 4, maxBytesPerWorkspace: 2048, maxEventBytes: 512,
  });
  for (let cursor = 1; cursor <= 6; cursor += 1) append(journal, "a", cursor);
  const first = journal.page("a", 0, 10);
  assert.deepEqual(first.events.map((event) => event.cursor), [4, 5, 6]);
  assert.deepEqual(first.gap, { reason: "retention", fromCursor: 1, toCursor: 3, resumeCursor: 3 });
  assert.deepEqual(journal.page("a", first.gap!.resumeCursor, 10).events.map((event) => event.cursor), [4, 5, 6]);

  append(journal, "b", 1); append(journal, "b", 2);
  assert.ok(journal.stats().events <= 4, "workspace count is bounded across executions");
  assert.ok(journal.stats().bytes <= 2048, "workspace bytes are bounded across executions");
});

test("oversized producer events and discontinuous cursors fail closed", () => {
  const journal = new GatewayEventJournal({ maxEventBytes: 256, maxBytesPerExecution: 512, maxBytesPerWorkspace: 512 });
  assert.throws(() => journal.append({ workspaceId: "w", sessionId: "s", handle: "h", cursor: 1, kind: "progress", payload: "x".repeat(512), at: 1 }), /exceeds/);
  append(journal, "h", 1, "w");
  assert.throws(() => append(journal, "h", 3, "w"), /cursor must be 2/);
});
