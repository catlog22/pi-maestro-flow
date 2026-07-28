import assert from "node:assert/strict";
import test from "node:test";
import { notifyBackgroundFailure } from "../src/extension/index.ts";

test("background promise failures emit completion and trigger a turn", () => {
  const emitted: unknown[] = [];
  const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const pi = {
    events: { emit: (...args: unknown[]) => emitted.push(args) },
    sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => sent.push({ message, options }),
  };

  notifyBackgroundFailure(pi as never, "tool-id", "general", "cid", new Error("boom"));
  assert.equal(emitted.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.customType, "teammate-complete");
  assert.match(String(sent[0].message.content), /boom/);
  assert.match(String(sent[0].message.content), /agent=general/);
  assert.match(String(sent[0].message.content), /correlationId=cid/);
  assert.match(String(sent[0].message.content), /phase=background-promise/);
  assert.equal(sent[0].options.triggerTurn, true);
});
