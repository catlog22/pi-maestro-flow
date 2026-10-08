import assert from "node:assert/strict";
import test from "node:test";
import { registerTeammateHostObserver } from "../src/public/v1/events.ts";
import { nextTeammateHostSequence, publishTeammateHostBoundary } from "../src/runs/host-observers.ts";

test("host observer owner replacement is token-fenced and cleanup removes only its generation", () => {
  const events: string[] = [];
  const old = registerTeammateHostObserver("test", () => events.push("old"));
  const current = registerTeammateHostObserver("test", (boundary) => { events.push(boundary.correlationId); boundary.steer("reflection"); });
  old(); let delivered = "";
  const sequence = nextTeammateHostSequence();
  const boundary = { correlationId: "actor-from-host", incarnation: "process", sequence, runtimeGeneration: 3, parentSessionFile: "parent.jsonl", event: { type: "turn_end", correlationId: "untrusted-actor" }, steer(message: string) { delivered = message; return true; } };
  try {
    publishTeammateHostBoundary(boundary);
    assert.deepEqual(events, ["actor-from-host"]); assert.equal(delivered, "reflection");
    assert.ok(nextTeammateHostSequence() > sequence);
    current(); publishTeammateHostBoundary(boundary); assert.equal(events.length, 1);
  } finally { current(); }
});
test("observer failures cannot break the subprocess or another observer; capacity is bounded", () => {
  const cleanup: Array<() => void> = [];
  let observed = 0;
  try {
    cleanup.push(registerTeammateHostObserver("throws", () => { throw new Error("passive failure"); }));
    cleanup.push(registerTeammateHostObserver("healthy", () => { observed++; }));
    publishTeammateHostBoundary({ correlationId: "child", incarnation: "process", sequence: nextTeammateHostSequence(), runtimeGeneration: 0, event: { type: "turn_end" }, steer: () => false });
    assert.equal(observed, 1);
    for (let i = 2; i < 64; i++) cleanup.push(registerTeammateHostObserver(`test-${i}`, () => {}));
    assert.throws(() => registerTeammateHostObserver("overflow", () => {}), /full/);
  } finally { for (const dispose of cleanup) dispose(); }
});
