import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createModelAvailabilityTool } from "../src/tools/model-availability.ts";

function mockContext(models: Array<{ provider: string; id: string }>): ExtensionContext {
  return { modelRegistry: { getAvailable: () => models } } as unknown as ExtensionContext;
}

test("streams progressive detail updates and returns both model sources", async () => {
  const tool = createModelAvailabilityTool();
  const updates: Array<AgentToolResult> = [];
  const ctx = mockContext([
    { provider: "deepseek", id: "deepseek-v4-pro" },
    { provider: "maestro-openai", id: "gpt-5.6-sol" },
  ]);

  const result = await tool.execute(
    "t1",
    {},
    undefined,
    (partial) => updates.push(partial),
    ctx,
  );

  assert.ok(updates.length >= 3, `expected progressive streaming updates, got ${updates.length}`);

  const details = result.details;
  assert.ok(details, "result should carry details");
  assert.deepEqual(details.teammate_models, [
    "deepseek/deepseek-v4-pro",
    "maestro-openai/gpt-5.6-sol",
  ]);
  assert.ok(Array.isArray(details.delegate_tools));
  assert.ok(Array.isArray(details.delegate_fallback));

  const text = result.content[0].type === "text" ? result.content[0].text : "";
  const parsed = JSON.parse(text);
  assert.ok(parsed.hint.includes("--to"), "hint must warn about the mandatory --to flag");
});

test("delegate tools not namespaced under a teammate model are flagged as fallback", async () => {
  const tool = createModelAvailabilityTool();
  const ctx = mockContext([{ provider: "codex", id: "gpt-5.5" }]);

  const result = await tool.execute("t2", {}, undefined, undefined, ctx);
  const details = result.details;
  assert.ok(details);

  const fallbackNames = new Set(details.delegate_fallback.map((tool) => tool.name));
  for (const delegateTool of details.delegate_tools) {
    const covered = delegateTool.name === "codex";
    if (covered) {
      assert.ok(!fallbackNames.has(delegateTool.name), "codex/ namespaced model should not be fallback");
    }
  }
});

test("filter narrows teammate models by substring", async () => {
  const tool = createModelAvailabilityTool();
  const ctx = mockContext([
    { provider: "deepseek", id: "deepseek-v4-pro" },
    { provider: "maestro-openai", id: "gpt-5.6-sol" },
  ]);

  const result = await tool.execute("t3", { filter: "deepseek" }, undefined, undefined, ctx);
  assert.deepEqual(result.details?.teammate_models, ["deepseek/deepseek-v4-pro"]);
});
