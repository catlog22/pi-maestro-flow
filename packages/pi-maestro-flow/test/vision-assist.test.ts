import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DESCRIBE_IMAGE_TOOL_NAME,
  analyzeAttachedImage,
  loadVisionDelegationConfig,
  registerVisionDelegation,
  saveVisionDelegationConfig,
} from "../src/providers/vision-assist.ts";

function model(provider: string, id: string, multimodal: boolean): any {
  return { provider, id, name: id, api: "openai-completions", baseUrl: "https://example.com/v1", reasoning: false,
    input: multimodal ? ["text", "image"] : ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000, maxTokens: 16_384 };
}
function assistant(text: string): any { return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, timestamp: Date.now() }; }
function registry(models: any[]) { return { getAvailable: () => models, find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id), async getApiKeyAndHeaders() { return { ok: true, apiKey: "secret", headers: {} }; } }; }
function harness(agentDir: string, completeFn: any) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  let active = [DESCRIBE_IMAGE_TOOL_NAME, "read"];
  const pi = {
    on(name: string, handler: any) { handlers.set(name, handler); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    getActiveTools() { return [...active]; },
    setActiveTools(next: string[]) { active = [...next]; },
  } as any;
  registerVisionDelegation(pi, { agentDir, completeFn });
  return { handlers, tools, commands, get active() { return active; }, setActive(next: string[]) { active = [...next]; } };
}

test("vision config persists normalized model references", () => {
  const dir = mkdtempSync(join(tmpdir(), "vision-config-"));
  try {
    const config = loadVisionDelegationConfig(dir);
    const file = saveVisionDelegationConfig({ ...config, visionModel: "p/main", fallbackModels: ["p/fallback", "p/fallback", "invalid"] }, dir);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.visionModel, "p/main");
    assert.deepEqual(saved.fallbackModels, ["p/fallback"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tool gating follows model capability and preserves user-disabled state", () => {
  const dir = mkdtempSync(join(tmpdir(), "vision-gating-"));
  try {
    const runtime = harness(dir, async () => assistant("unused"));
    const text = model("p", "text", false);
    const vision = model("p", "vision", true);
    runtime.handlers.get("session_start")?.({}, { model: vision });
    assert.deepEqual(runtime.active, ["read"]);
    runtime.handlers.get("model_select")?.({ model: text });
    assert.deepEqual(runtime.active, ["read", DESCRIBE_IMAGE_TOOL_NAME]);
    const enabled = loadVisionDelegationConfig(dir);
    saveVisionDelegationConfig({ ...enabled, enabled: false }, dir);
    runtime.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, { model: text });
    assert.deepEqual(runtime.active, ["read"]);
    saveVisionDelegationConfig({ ...enabled, enabled: true }, dir);
    runtime.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, { model: text });
    assert.deepEqual(runtime.active, ["read", DESCRIBE_IMAGE_TOOL_NAME]);
    runtime.setActive(["read"]);
    runtime.handlers.get("model_select")?.({ model: vision });
    runtime.handlers.get("model_select")?.({ model: text });
    assert.deepEqual(runtime.active, ["read"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("vision guidance composes with the current system prompt only for text-only models", () => {
  const dir = mkdtempSync(join(tmpdir(), "vision-prompt-"));
  try {
    const runtime = harness(dir, async () => assistant("unused"));
    const handler = runtime.handlers.get("before_agent_start");
    const textResult = handler?.({ systemPrompt: "base prompt" }, { model: model("p", "text", false) });
    assert.match(textResult?.systemPrompt ?? "", /^base prompt/);
    assert.match(textResult?.systemPrompt ?? "", /## Vision capability/);
    assert.match(textResult?.systemPrompt ?? "", /describe_image/);
    const multimodalResult = handler?.({ systemPrompt: "base prompt" }, { model: model("p", "vision", true) });
    assert.equal(multimodalResult, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("/vision typed commands show status and persist multimodal routing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vision-command-"));
  try {
    const runtime = harness(dir, async () => assistant("unused"));
    const text = model("p", "text", false);
    const primary = model("p", "vision", true);
    const fallback = model("p", "fallback", true);
    const notifications: string[] = [];
    const ctx = {
      cwd: dir,
      hasUI: false,
      model: text,
      modelRegistry: registry([text, primary, fallback]),
      ui: { notify(message: string) { notifications.push(message); } },
    } as any;
    const command = runtime.commands.get("vision");
    assert.ok(command);
    await command.handler("model p/vision", ctx);
    await command.handler("fallback p/fallback", ctx);
    await command.handler("show", ctx);
    let saved = loadVisionDelegationConfig(dir);
    assert.equal(saved.visionModel, "p/vision");
    assert.deepEqual(saved.fallbackModels, ["p/fallback"]);
    assert.match(notifications.at(-1) ?? "", /mode: delegate/);
    assert.match(notifications.at(-1) ?? "", /vision model: p\/vision/);
    await command.handler("off", ctx);
    saved = loadVisionDelegationConfig(dir);
    assert.equal(saved.enabled, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("interactive Vision manager edits complete policy and warns about stale model capabilities", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vision-manager-"));
  try {
    const initial = loadVisionDelegationConfig(dir);
    saveVisionDelegationConfig({ ...initial, visionModel: "p/vision", fallbackModels: ["p/stale"] }, dir);
    const runtime = harness(dir, async () => assistant("unused"));
    const text = model("p", "text", false);
    const models = [text, model("p", "vision", true), model("p", "fallback-a", true), model("p", "fallback-b", true)];
    const actions = ["编辑 Fallback 模型链", "设置缓存容量", "设置重试次数", "设置超时时间", "完成"];
    const notifications: Array<{ message: string; level?: string }> = [];
    let actionIndex = 0;
    const ctx = {
      cwd: dir,
      hasUI: true,
      model: text,
      modelRegistry: registry(models),
      ui: {
        async select(title: string) { return title === "Vision 委托设置" ? actions[actionIndex++] : undefined; },
        async input(title: string) {
          if (title.startsWith("Vision fallback")) return "p/fallback-a, p/fallback-b";
          if (title.startsWith("Vision 缓存")) return "77";
          if (title.startsWith("每个 Vision")) return "2";
          if (title.startsWith("单次 Vision")) return "45000";
          return undefined;
        },
        notify(message: string, level?: string) { notifications.push({ message, level }); },
      },
    } as any;
    await runtime.commands.get("vision").handler("", ctx);
    const saved = loadVisionDelegationConfig(dir);
    assert.deepEqual(saved.fallbackModels, ["p/fallback-a", "p/fallback-b"]);
    assert.equal(saved.cache.maxEntries, 77);
    assert.equal(saved.maxRetries, 2);
    assert.equal(saved.timeoutMs, 45_000);
    assert.ok(notifications.some((entry) => entry.level === "warning" && entry.message.includes("p/stale")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("describe_image auto-selects multimodal model and caches success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vision-cache-"));
  try {
    const file = join(dir, "image.png"); writeFileSync(file, Buffer.from("fake"));
    let calls = 0;
    const runtime = harness(dir, async () => { calls += 1; return assistant("analysis"); });
    const text = model("p", "text", false); const vision = model("p", "vision", true);
    const ctx = { cwd: dir, model: text, modelRegistry: registry([text, vision]) } as any;
    const tool = runtime.tools.get(DESCRIBE_IMAGE_TOOL_NAME);
    const first = await tool.execute("1", { image_path: file, prompt: "analyze" }, undefined, undefined, ctx);
    const second = await tool.execute("2", { image_path: file, prompt: "analyze" }, undefined, undefined, ctx);
    assert.equal(first.details.cached, false); assert.equal(second.details.cached, true); assert.equal(calls, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("non-cooperative provider times out and falls back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vision-timeout-"));
  try {
    const file = join(dir, "image.png"); writeFileSync(file, Buffer.from("fake"));
    const config = loadVisionDelegationConfig(dir);
    saveVisionDelegationConfig({ ...config, visionModel: "p/stuck", fallbackModels: ["p/fallback"], maxRetries: 0, timeoutMs: 1_000, cache: { enabled: false, maxEntries: 10 } }, dir);
    const calls: string[] = [];
    const runtime = harness(dir, async (selected: any) => { calls.push(selected.id); return selected.id === "stuck" ? new Promise(() => undefined) : assistant("fallback"); });
    const models = [model("p", "stuck", true), model("p", "fallback", true)];
    const result = await runtime.tools.get(DESCRIBE_IMAGE_TOOL_NAME).execute("1", { image_path: file }, undefined, undefined, { cwd: dir, model: model("p", "text", false), modelRegistry: registry(models) });
    assert.equal(result.details.model, "p/fallback"); assert.deepEqual(calls, ["stuck", "fallback"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("caller cancellation is reported as aborted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vision-abort-"));
  try {
    const file = join(dir, "image.png"); writeFileSync(file, Buffer.from("fake"));
    const config = loadVisionDelegationConfig(dir);
    saveVisionDelegationConfig({ ...config, visionModel: "p/vision", maxRetries: 0, cache: { enabled: false, maxEntries: 10 } }, dir);
    const vision = model("p", "vision", true); const runtime = harness(dir, async () => new Promise(() => undefined));
    const controller = new AbortController(); setTimeout(() => controller.abort(), 10);
    const result = await runtime.tools.get(DESCRIBE_IMAGE_TOOL_NAME).execute("1", { image_path: file }, controller.signal, undefined, { cwd: dir, model: model("p", "text", false), modelRegistry: registry([vision]) });
    assert.equal(result.details.error, "aborted");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attached image analysis is available to failover integration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vision-attached-"));
  try {
    const vision = model("p", "vision", true);
    const result = await analyzeAttachedImage({ cwd: dir, model: model("p", "text", false), modelRegistry: registry([vision]) } as any,
      { data: Buffer.from("attached").toString("base64"), mimeType: "image/png" },
      { agentDir: dir, completeFn: async () => assistant("attached analysis") as any });
    assert.equal(result.text, "attached analysis"); assert.equal(result.model, "p/vision");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
