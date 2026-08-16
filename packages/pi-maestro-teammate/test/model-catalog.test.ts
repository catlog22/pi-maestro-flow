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
import { buildPiArgs } from "../src/runs/execution.ts";

const baseAgent: AgentConfig = {
  name: "general",
  description: "Delegate",
  tools: ["read"],
  systemPromptMode: "append",
  inheritProjectContext: true,
  inheritSkills: false,
  systemPrompt: "Delegate prompt",
  source: "builtin",
  filePath: "general.md",
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
  assert.match(injected, /openai\/gpt-5 \[thinking:off,minimal,low,medium,high,xhigh,max\]/);

  const second = createModelCatalogSnapshot([{ provider: "google", id: "gemini-pro" }]);
  const refreshed = appendModelCatalog(injected, second);
  assert.match(refreshed, /google\/gemini-pro/);
  assert.doesNotMatch(refreshed, /openai\/gpt-5/);
  assert.equal((refreshed.match(/<available_teammate_models>/g) ?? []).length, 1);
});

test("model catalog advertises the full thinking range for reasoning models", () => {
  assert.deepEqual(supportedThinkingLevels({
    provider: "maestro-openai",
    id: "gpt-5",
    reasoning: true,
    thinkingLevelMap: { off: null },
  }), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(supportedThinkingLevels({
    provider: "maestro-anthropic",
    id: "claude-sonnet-4-5",
    reasoning: true,
    thinkingLevelMap: { xhigh: "high" },
  }), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(supportedThinkingLevels({
    provider: "custom",
    id: "plain",
    reasoning: false,
  }), ["off"]);
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
  const tools = new Map<string, { name: string; description?: string }>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> | void }>();
  let activeTools: string[] = [];
  const pi = new Proxy({
    events: { on: () => () => {}, emit() {} },
    registerTool(tool: { name: string; description?: string }) {
      tools.set(tool.name, tool);
      if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> | void }) {
      commands.set(name, command);
    },
    getActiveTools() { return [...activeTools]; },
    setActiveTools(names: string[]) { activeTools = [...names]; },
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
    hasUI: true,
    ui: {
      notify() {},
      setStatus() {},
      setWidget() {},
      onTerminalInput: () => () => {},
    },
    modelRegistry: { getAvailable: () => models },
    sessionManager: {
      getSessionId: () => "session",
      getSessionFile: () => "session.jsonl",
      getSessionName: () => "session",
      getEntries: () => [],
    },
  };

  try {
    registerTeammateExtension(pi as unknown as ExtensionAPI);
    assert.equal(handlers.get("session_start")?.length, 1);
    assert.equal(handlers.get("before_agent_start")?.length, 1);

    await handlers.get("session_start")![0]({}, ctx);
    const first = await handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, ctx);
    assert.match(first.systemPrompt, /openai\/gpt-5/);
    assert.doesNotMatch(first.systemPrompt, /<monitor_mode>/);
    assert.match(tools.get("teammate-list")?.description ?? "", /owned by this Pi process/);
    assert.equal(activeTools.includes("workspace-window"), false);
    assert.equal(activeTools.includes("remote-worker"), false);

    const monitorCommand = commands.get("monitor");
    assert.ok(monitorCommand);
    await monitorCommand.handler("", ctx);
    assert.match(tools.get("teammate-list")?.description ?? "", /cross-session windows/);
    assert.equal(activeTools.includes("workspace-window"), true);
    assert.equal(activeTools.includes("remote-worker"), true);
    const monitorPrompt = await handlers.get("before_agent_start")![0]({ systemPrompt: first.systemPrompt }, ctx);
    assert.match(monitorPrompt.systemPrompt, /<monitor_mode>/);

    await monitorCommand.handler("exit", ctx);
    assert.match(tools.get("teammate-list")?.description ?? "", /owned by this Pi process/);
    assert.equal(activeTools.includes("workspace-window"), false);
    assert.equal(activeTools.includes("remote-worker"), false);
    const restoredPrompt = await handlers.get("before_agent_start")![0]({ systemPrompt: monitorPrompt.systemPrompt }, ctx);
    assert.doesNotMatch(restoredPrompt.systemPrompt, /<monitor_mode>/);

    models = [{ provider: "openai", id: "gpt-5", reasoning: true, thinkingLevelMap: { off: null } }];
    const capabilityRefresh = await handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, ctx);
    assert.match(capabilityRefresh.systemPrompt, /openai\/gpt-5 \[thinking:off,minimal,low,medium,high,xhigh,max\]/);

    models = [{ provider: "anthropic", id: "claude-opus" }];
    const second = await handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, ctx);
    assert.match(second.systemPrompt, /anthropic\/claude-opus/);
    assert.doesNotMatch(second.systemPrompt, /openai\/gpt-5/);
  } finally {
    if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previousChild;
  }
});

test("explicit model overrides reach child Pi", () => {
  const args = buildPiArgs(baseAgent, { agent: "general", model: "openai/gpt-5" }, "prompt.md");
  assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5");
});

test("thinking overrides reach child Pi once", () => {
  const explicit = buildPiArgs(
    { ...baseAgent, thinking: "medium" },
    { agent: "general", thinking: "xhigh" },
    "prompt.md",
  );
  assert.equal(explicit[explicit.indexOf("--thinking") + 1], "xhigh");
  assert.equal(explicit.filter((arg) => arg === "--thinking").length, 1);

  const fallback = buildPiArgs({ ...baseAgent, thinking: "minimal" }, { agent: "general" }, "prompt.md");
  assert.equal(fallback[fallback.indexOf("--thinking") + 1], "minimal");
  assert.equal(buildPiArgs(baseAgent, { agent: "general" }, "prompt.md").includes("--thinking"), false);

  const maxLevel = buildPiArgs(baseAgent, { agent: "general", thinking: "max" }, "prompt.md");
  assert.equal(maxLevel[maxLevel.indexOf("--thinking") + 1], "max");
});

test("thinking overrides pass through unchanged; capability is advisory", () => {
  // The teammate layer never clamps thinking depth: the exact requested level
  // reaches the child Pi, which clamps to its own provider capability boundary.
  const narrowCapabilities = [
    { id: "maestro-openai/gpt-5", reasoning: true, thinkingLevels: ["minimal", "low", "medium", "high"] },
    { id: "custom/plain", reasoning: false, thinkingLevels: ["off"] },
  ] as const;

  const gpt5 = buildPiArgs(
    baseAgent,
    { agent: "general", thinking: "xhigh" },
    "prompt.md",
    "maestro-openai/gpt-5",
    undefined,
    undefined,
    undefined,
    narrowCapabilities,
  );
  assert.equal(gpt5[gpt5.indexOf("--thinking") + 1], "xhigh");

  const plain = buildPiArgs(
    baseAgent,
    { agent: "general", thinking: "off" },
    "prompt.md",
    "custom/plain",
    undefined,
    undefined,
    undefined,
    narrowCapabilities,
  );
  assert.equal(plain[plain.indexOf("--thinking") + 1], "off");

  // With no routed model there is no capability data either; the level still
  // passes through unchanged.
  const unmodeled = buildPiArgs(
    baseAgent,
    { agent: "general", thinking: "high" },
    "prompt.md",
  );
  assert.equal(unmodeled[unmodeled.indexOf("--thinking") + 1], "high");
});
