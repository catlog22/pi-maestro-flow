import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../src/agents/agents.ts";
import registerTeammateExtension from "../src/extension/index.ts";
import {
  appendModelCatalog,
  createModelCatalogSnapshot,
  supportedThinkingLevels,
  type AvailableModelEntry,
} from "../src/models/model-catalog.ts";
import { buildPiArgs, clampThinkingForModel, normalizeChainToTasks } from "../src/runs/execution.ts";

const baseAgent: AgentConfig = {
  name: "delegate",
  description: "Delegate",
  tools: ["read"],
  systemPromptMode: "append",
  inheritProjectContext: true,
  inheritSkills: false,
  systemPrompt: "Delegate prompt",
  source: "builtin",
  filePath: "delegate.md",
};

test("model catalog is deterministic, deduplicated, and replaceable", () => {
  const first = createModelCatalogSnapshot([
    { provider: "openai", id: "gpt-5", reasoning: true, thinkingLevelMap: { off: null } },
    { provider: "anthropic", id: "claude-opus" },
    { provider: "openai", id: "gpt-5", reasoning: true },
  ]);
  assert.deepEqual(first.modelIds, ["anthropic/claude-opus", "openai/gpt-5"]);

  const injected = appendModelCatalog("base", first);
  assert.match(injected, /anthropic\/claude-opus/);
  assert.match(injected, /openai\/gpt-5 \[thinking:minimal,low,medium,high\]/);

  const second = createModelCatalogSnapshot([{ provider: "google", id: "gemini-pro" }]);
  const refreshed = appendModelCatalog(injected, second);
  assert.match(refreshed, /google\/gemini-pro/);
  assert.doesNotMatch(refreshed, /openai\/gpt-5/);
  assert.equal((refreshed.match(/<available_teammate_models>/g) ?? []).length, 1);
});

test("model catalog exposes legacy and modern thinking capabilities", () => {
  assert.deepEqual(supportedThinkingLevels({
    provider: "maestro-openai",
    id: "gpt-5",
    reasoning: true,
    thinkingLevelMap: { off: null },
  }), ["minimal", "low", "medium", "high"]);
  assert.deepEqual(supportedThinkingLevels({
    provider: "maestro-anthropic",
    id: "claude-sonnet-4-5",
    reasoning: true,
    thinkingLevelMap: { xhigh: "high" },
  }), ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.equal(supportedThinkingLevels({ provider: "custom", id: "unknown" }), undefined);
});

test("model catalog signature changes when the same model capability changes", () => {
  const basic = createModelCatalogSnapshot([{ provider: "openai", id: "gpt-5" }]);
  const reasoning = createModelCatalogSnapshot([{
    provider: "openai",
    id: "gpt-5",
    reasoning: true,
    thinkingLevelMap: { off: null },
  }]);
  assert.notEqual(reasoning.signature, basic.signature);
});

test("session start snapshots models and before_agent_start refreshes changed registries", async () => {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const pi = new Proxy({
    events: { on: () => () => {}, emit() {} },
    registerTool() {},
    on(event: string, handler: (event: any, ctx: any) => any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  });

  const previousChild = process.env.PI_TEAMMATE_CHILD;
  delete process.env.PI_TEAMMATE_CHILD;
  let models: AvailableModelEntry[] = [{ provider: "openai", id: "gpt-5" }];
  const ctx = {
    cwd: process.cwd(),
    modelRegistry: { getAvailable: () => models },
    sessionManager: {
      getSessionId: () => "session",
      getSessionFile: () => "session.jsonl",
    },
  };

  try {
    registerTeammateExtension(pi as unknown as ExtensionAPI);
    assert.equal(handlers.get("session_start")?.length, 1);
    assert.equal(handlers.get("before_agent_start")?.length, 1);

    await handlers.get("session_start")![0]({}, ctx);
    const first = await handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, ctx);
    assert.match(first.systemPrompt, /openai\/gpt-5/);

    models = [{ provider: "openai", id: "gpt-5", reasoning: true, thinkingLevelMap: { off: null } }];
    const capabilityRefresh = await handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, ctx);
    assert.match(capabilityRefresh.systemPrompt, /openai\/gpt-5 \[thinking:minimal,low,medium,high\]/);

    models = [{ provider: "anthropic", id: "claude-opus" }];
    const second = await handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, ctx);
    assert.match(second.systemPrompt, /anthropic\/claude-opus/);
    assert.doesNotMatch(second.systemPrompt, /openai\/gpt-5/);
  } finally {
    if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previousChild;
  }
});

test("top-level, task, and legacy chain model overrides reach child Pi", () => {
  const args = buildPiArgs(baseAgent, { agent: "delegate", model: "openai/gpt-5" }, "prompt.md");
  assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5");

  const tasks = normalizeChainToTasks([
    { agent: "delegate", model: "anthropic/claude-opus" },
    { agent: "reviewer", task: "Review {previous}", model: "google/gemini-pro" },
  ]);
  assert.equal(tasks[0].model, "anthropic/claude-opus");
  assert.equal(tasks[1].model, "google/gemini-pro");
});

test("thinking overrides reach child Pi once and legacy chains preserve them", () => {
  const explicit = buildPiArgs(
    { ...baseAgent, thinking: "medium" },
    { agent: "delegate", thinking: "xhigh" },
    "prompt.md",
  );
  assert.equal(explicit[explicit.indexOf("--thinking") + 1], "xhigh");
  assert.equal(explicit.filter((arg) => arg === "--thinking").length, 1);

  const fallback = buildPiArgs({ ...baseAgent, thinking: "minimal" }, { agent: "delegate" }, "prompt.md");
  assert.equal(fallback[fallback.indexOf("--thinking") + 1], "minimal");
  assert.equal(buildPiArgs(baseAgent, { agent: "delegate" }, "prompt.md").includes("--thinking"), false);

  const tasks = normalizeChainToTasks([{ agent: "delegate", thinking: "high" }], "task");
  assert.equal(tasks[0].thinking, "high");

  const maxAlias = buildPiArgs(baseAgent, { agent: "delegate", thinking: "max" }, "prompt.md");
  assert.equal(maxAlias[maxAlias.indexOf("--thinking") + 1], "xhigh");
  assert.equal(normalizeChainToTasks([{ agent: "delegate", thinking: "max" }], "task")[0].thinking, "xhigh");
});

test("thinking clamps to the final model capability before child Pi", () => {
  const capabilities = [
    { id: "maestro-openai/gpt-5", reasoning: true, thinkingLevels: ["minimal", "low", "medium", "high"] },
    { id: "maestro-anthropic/claude-sonnet-4-5", reasoning: true, thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"] },
    { id: "custom/plain", reasoning: false, thinkingLevels: ["off"] },
  ] as const;

  assert.equal(clampThinkingForModel("xhigh", "maestro-openai/gpt-5", capabilities), "high");
  assert.equal(clampThinkingForModel("off", "maestro-openai/gpt-5", capabilities), "minimal");
  assert.equal(clampThinkingForModel("xhigh", "custom/plain", capabilities), "off");
  assert.equal(clampThinkingForModel("xhigh", "unknown/model", capabilities), "xhigh");

  const fallbackAttempt = buildPiArgs(
    baseAgent,
    { agent: "delegate", thinking: "max" },
    "prompt.md",
    "maestro-openai/gpt-5",
    undefined,
    undefined,
    undefined,
    capabilities,
  );
  assert.equal(fallbackAttempt[fallbackAttempt.indexOf("--thinking") + 1], "high");

  const anthropic = buildPiArgs(
    baseAgent,
    { agent: "delegate", model: "maestro-anthropic/claude-sonnet-4-5", thinking: "max" },
    "prompt.md",
    undefined,
    undefined,
    undefined,
    undefined,
    capabilities,
  );
  assert.equal(anthropic[anthropic.indexOf("--thinking") + 1], "xhigh");
});
