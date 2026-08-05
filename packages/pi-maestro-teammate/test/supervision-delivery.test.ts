import assert from "node:assert/strict";
import test from "node:test";
import { DeliveryGate, normalizeDeliveryMessage } from "../src/supervision/delivery.ts";

test("normalize collapses case, diacritics and punctuation", () => {
  assert.equal(normalizeDeliveryMessage("Stop."), "stop");
  assert.equal(normalizeDeliveryMessage("*Stop*"), "stop");
  assert.equal(normalizeDeliveryMessage("  STOP  "), "stop");
});

test("phrase filter suppresses empty chatter", () => {
  const gate = new DeliveryGate();
  assert.equal(gate.gate("a", "Stop.", "interrupt"), undefined);
  assert.equal(gate.gate("a", "lgtm", "batch"), undefined);
});

test("cooldown suppresses repeated delivery to the same target", () => {
  const gate = new DeliveryGate({
    cooldownMs: 60_000,
    dedup: { scope: "target" },
    phraseFilter: false,
    perWindowLimit: 10,
  });
  assert.equal(gate.gate("a", "first", "interrupt"), "interrupt");
  assert.equal(gate.gate("a", "second", "interrupt"), undefined);
  // Different target is not affected
  assert.equal(gate.gate("b", "first", "interrupt"), "interrupt");
});

test("cooldown window can be configured to zero", () => {
  const gate = new DeliveryGate({
    cooldownMs: 0,
    dedup: { scope: "target" },
    phraseFilter: false,
    perWindowLimit: 10,
  });
  assert.equal(gate.gate("a", "first", "batch"), "batch");
  assert.equal(gate.gate("a", "second", "batch"), "batch");
});

test("normalized dedupe drops repeated content", () => {
  const gate = new DeliveryGate({
    cooldownMs: 0,
    dedup: { capacity: 16, scope: "global" },
    phraseFilter: false,
    perWindowLimit: 10,
  });
  assert.equal(gate.gate("a", "Fix the leak.", "concern" as never), "concern" as never);
  assert.equal(gate.gate("a", "Fix the leak!", "concern" as never), undefined);
});

test("per-window limit bounds deliveries per target", () => {
  const gate = new DeliveryGate({ cooldownMs: 0, dedup: undefined, phraseFilter: false, perWindowLimit: 1 });
  assert.equal(gate.gate("a", "one", "batch"), "batch");
  assert.equal(gate.gate("a", "two", "batch"), undefined);
  gate.beginWindow();
  assert.equal(gate.gate("a", "two", "batch"), "batch");
});

test("interrupt downgrades to batch for downgradeAfter windows", () => {
  const gate = new DeliveryGate({
    cooldownMs: 0,
    dedup: undefined,
    phraseFilter: false,
    perWindowLimit: 1,
    downgradeAfter: 3,
  });
  // First interrupt is delivered as interrupt and arms the downgrade budget.
  assert.equal(gate.gate("a", "m1", "interrupt"), "interrupt");
  gate.beginWindow();
  assert.equal(gate.gate("a", "m2", "interrupt"), "batch");
  gate.beginWindow();
  assert.equal(gate.gate("a", "m3", "interrupt"), "batch");
  gate.beginWindow();
  assert.equal(gate.gate("a", "m4", "interrupt"), "batch");
  gate.beginWindow();
  // Budget exhausted — next interrupt is delivered again.
  assert.equal(gate.gate("a", "m5", "interrupt"), "interrupt");
});

test("reset clears dedupe, cooldown and downgrade state", () => {
  const gate = new DeliveryGate({ cooldownMs: 60_000, dedup: { capacity: 16 } });
  assert.equal(gate.gate("a", "note", "concern" as never), "concern" as never);
  assert.equal(gate.gate("a", "note again", "concern" as never), undefined);
  gate.reset();
  assert.equal(gate.gate("a", "note again", "concern" as never), "concern" as never);
});
