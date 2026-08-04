import assert from "node:assert/strict";
import test from "node:test";
import { decideViewingInput } from "../src/tui/viewing-widget.ts";

test("decideViewingInput: routes only while viewing", () => {
  assert.deepEqual(decideViewingInput("hello", { viewing: false, canSend: true }), { action: "continue" });
  assert.deepEqual(decideViewingInput("hello", { viewing: true, canSend: true }), { action: "forward", text: "hello" });
});

test("decideViewingInput: slash commands go to the main conversation", () => {
  assert.deepEqual(decideViewingInput("/model fast", { viewing: true, canSend: true }), { action: "continue" });
});

test("decideViewingInput: read-only (history) agents swallow input", () => {
  assert.deepEqual(decideViewingInput("hello", { viewing: true, canSend: false }), { action: "handled" });
});
