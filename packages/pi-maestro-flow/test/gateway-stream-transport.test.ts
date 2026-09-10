import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayEventNotification } from "../src/gateway/event-contracts.ts";
import { GatewayEventJournal } from "../src/gateway/event-journal.ts";
import { GatewayEventStream } from "../src/gateway/event-stream.ts";

function event(journal: GatewayEventJournal, cursor: number) {
  journal.append({ workspaceId: "w", sessionId: "s", handle: "h", cursor, kind: "progress", payload: { cursor }, at: cursor });
}
async function tick() { await new Promise<void>((resolve) => setImmediate(resolve)); }

test("one watermark hands replay to live delivery without disorder or duplicates and allows one in-flight write", async () => {
  const journal = new GatewayEventJournal();
  for (let cursor = 1; cursor <= 3; cursor += 1) event(journal, cursor);
  const stream = new GatewayEventStream(journal);
  const delivered: number[] = [];
  let inFlight = 0; let maximumInFlight = 0;
  const subscription = stream.subscribe({
    connectionId: "connection", workspaceId: "w", sessionId: "s", memberId: "m", memberGeneration: 1, handle: "h", cursor: 0,
    write: async (notification: GatewayEventNotification) => {
      inFlight += 1; maximumInFlight = Math.max(maximumInFlight, inFlight);
      await tick(); delivered.push(notification.params.cursor); inFlight -= 1;
    },
  });
  assert.equal(subscription.watermark, 3);
  event(journal, 4); event(journal, 5);
  for (let attempt = 0; attempt < 20 && delivered.length < 5; attempt += 1) await tick();
  assert.deepEqual(delivered, [1, 2, 3, 4, 5]);
  assert.equal(maximumInFlight, 1);
  assert.deepEqual(stream.unsubscribe(subscription.subscriptionId, "connection"), { subscriptionId: subscription.subscriptionId, unsubscribed: true, cursor: 5 });
  assert.deepEqual(stream.stats(), { subscribers: 0, connections: 0, queuedEvents: 0, queuedBytes: 0 });
});

test("slow consumers close within subscriber and connection bounds and return a recoverable cursor/gap", async () => {
  const journal = new GatewayEventJournal(); event(journal, 1);
  const stream = new GatewayEventStream(journal, {
    maxQueuedEventsPerSubscriber: 2, maxQueuedBytesPerSubscriber: 4096,
    maxQueuedEventsPerConnection: 2, maxQueuedBytesPerConnection: 4096,
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const subscription = stream.subscribe({
    connectionId: "slow", workspaceId: "w", sessionId: "s", memberId: "m", memberGeneration: 1, handle: "h",
    write: () => blocked,
  });
  event(journal, 2); event(journal, 3);
  const state = stream.state(subscription.subscriptionId)!;
  assert.equal(state.closed, true);
  assert.equal(state.gap?.reason, "slow-consumer");
  assert.equal(state.gap?.resumeCursor, 0);
  const closed = stream.unsubscribe(subscription.subscriptionId, "slow");
  assert.equal(closed.cursor, 0); assert.equal(closed.gap?.reason, "slow-consumer");
  assert.deepEqual(journal.page("h", closed.gap!.resumeCursor, 10).events.map((item) => item.cursor), [1, 2, 3]);
  assert.equal(stream.stats().queuedEvents, 0);
  release(); await tick();
});

test("generation validation and connection close revoke all owned subscriptions", async () => {
  const journal = new GatewayEventJournal(); event(journal, 1);
  const stream = new GatewayEventStream(journal);
  let valid = true;
  const first = stream.subscribe({ connectionId: "c", workspaceId: "w", sessionId: "s", memberId: "m", memberGeneration: 1, handle: "h", write: async () => undefined, validate: () => valid });
  for (let attempt = 0; attempt < 10 && stream.state(first.subscriptionId)?.cursor !== 1; attempt += 1) await tick();
  valid = false; event(journal, 2); await tick();
  assert.equal(stream.state(first.subscriptionId)?.gap?.reason, "revoked");

  const second = stream.subscribe({ connectionId: "c", workspaceId: "w", sessionId: "s", memberId: "m", memberGeneration: 2, handle: "h", cursor: 1, write: async () => undefined });
  stream.closeConnection("c");
  assert.equal(stream.state(second.subscriptionId)?.gap?.reason, "connection-closed");
  assert.equal(stream.stats().subscribers, 0);
});
