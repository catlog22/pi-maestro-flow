import assert from "node:assert/strict";
import test from "node:test";
import { notifyBackgroundFailure, safeSendMessage } from "../src/extension/index.ts";

const STALE_CTX_MESSAGE = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

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

test("background failure notification survives a stale extension ctx", () => {
  const emitted: unknown[] = [];
  const pi = {
    events: { emit: (...args: unknown[]) => emitted.push(args) },
    sendMessage: () => {
      throw new Error(STALE_CTX_MESSAGE);
    },
  };

  // The .catch background path must never escalate into an unhandled
  // rejection that kills the pi process after session replacement.
  assert.doesNotThrow(() => {
    notifyBackgroundFailure(pi as never, "tool-id", "general", "cid", new Error("boom"));
  });
  // State settlement (eventBus emit) is not guarded by assertActive and must
  // still happen even though the notification was dropped.
  assert.equal(emitted.length, 1);
});

test("safeSendMessage drops stale-ctx sends and contains unexpected errors", () => {
  const stalePi = {
    sendMessage: () => {
      throw new Error(STALE_CTX_MESSAGE);
    },
  };
  assert.doesNotThrow(() => {
    safeSendMessage(stalePi as never, { customType: "x", content: "y", display: true });
  });

  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const brokenPi = {
      sendMessage: () => {
        throw new Error("host rejected the message");
      },
    };
    assert.doesNotThrow(() => {
      safeSendMessage(brokenPi as never, { customType: "x", content: "y", display: true });
    });
    assert.equal(logged.length, 1);
    assert.match(String(logged[0]), /host rejected the message/);
  } finally {
    console.error = original;
  }
});
