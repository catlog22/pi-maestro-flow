import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBeforeAgentStartInput } from "../src/before-agent-start.ts";

test("before_agent_start accepts legacy and Pi 1.2 user prompts", () => {
  assert.deepEqual(normalizeBeforeAgentStartInput({ prompt: "legacy" }), { messageType: "user", text: "legacy" });
  assert.deepEqual(normalizeBeforeAgentStartInput({ messageType: "user", prompt: "current" }), { messageType: "user", text: "current" });
});

test("before_agent_start custom text keeps its origin and ignores non-text blocks", () => {
  assert.deepEqual(normalizeBeforeAgentStartInput({
    messageType: "custom",
    message: { customType: "mb-peer", content: "peer wake" },
  }), { messageType: "custom", customType: "mb-peer", text: "peer wake" });
  assert.deepEqual(normalizeBeforeAgentStartInput({
    messageType: "custom",
    message: {
      customType: "background-wake",
      content: [{ type: "text", text: "first" }, { type: "image" }, { type: "text", text: "second" }],
    },
  }), { messageType: "custom", customType: "background-wake", text: "first\nsecond" });
  assert.deepEqual(normalizeBeforeAgentStartInput({
    messageType: "custom",
    message: { customType: "loop", content: [] },
  }), { messageType: "custom", customType: "loop", text: "" });
});
