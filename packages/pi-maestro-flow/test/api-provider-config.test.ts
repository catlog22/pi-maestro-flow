import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getModels } from "@earendil-works/pi-ai/compat";

// pi-coding-agent's exports map blocks deep subpath specifiers and declares only
// an "import" condition, and npm may place the package in the workspace root or
// in this package's node_modules. Resolve its dist directory from the public ESM
// entry instead of hardcoding a hoist layout.
const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { AuthStorage } = await import(pathToFileURL(join(piDist, "core/auth-storage.js")).href);
const { ModelRegistry } = await import(pathToFileURL(join(piDist, "core/model-registry.js")).href);
const { ModelRuntime } = await import(pathToFileURL(join(piDist, "core/model-runtime.js")).href);

/** pi 0.80+ replaced ModelRegistry.create(auth, path) with an injected ModelRuntime. */
async function createModelRegistry(credentials: unknown, modelsPath: string) {
  return new ModelRegistry(await ModelRuntime.create({ credentials, modelsPath }));
}
import {
  ALLOW_INSECURE_PROVIDER_HTTP_ENV,
  deleteApiProviderModelSettings,
  ensureApiRetryDefaults,
  loadApiProviderSettings,
  loadApiRetrySettings,
  normalizeBaseUrl,
  registerApiProviderConfigs,
  saveApiProviderSettings,
  saveApiRetrySettings,
} from "../src/providers/api-provider-config.ts";

function createEffortHarness(options: {
  modelsPath: string;
  defaultsPath: string;
  current?: string;
  apply?: (level: string) => void;
  registerProvider?: (name: string, config: any) => void;
}) {
  const commands = new Map<string, any>();
  let modelSelect: ((event: any) => Promise<void>) | undefined;
  registerApiProviderConfigs({
    registerProvider: options.registerProvider ?? (() => {}),
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    getThinkingLevel() {
      return options.current ?? "medium";
    },
    setThinkingLevel(level: string) {
      options.apply?.(level);
    },
    on(event: string, handler: (event: any) => Promise<void>) {
      if (event === "model_select") modelSelect = handler;
    },
  } as any, options);
  return {
    command: commands.get("effort"),
    commands,
    get modelSelect() {
      return modelSelect;
    },
  };
}

test("upserts multiple models under the same API provider", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-multi-model-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const base = { provider: "maestro-openai" as const, baseUrl: "https://gateway.example.com/v1", apiKey: "secret" };
  await saveApiProviderSettings({ ...base, modelId: "model-a", reasoning: true }, modelsPath);
  await saveApiProviderSettings({ ...base, modelId: "model-b", reasoning: true }, modelsPath);
  await saveApiProviderSettings({ ...base, modelId: "model-a", reasoning: false }, modelsPath);

  let saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.deepEqual(saved.providers["maestro-openai"].models.map((model: any) => model.id), ["model-a", "model-b"]);
  assert.equal(saved.providers["maestro-openai"].models[0].reasoning, false);
  assert.equal(saved.providers["maestro-openai"].models[1].reasoning, true);

  await deleteApiProviderModelSettings("maestro-openai", "model-a", modelsPath);
  saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.deepEqual(saved.providers["maestro-openai"].models.map((model: any) => model.id), ["model-b"]);
  assert.equal(saved.providers["maestro-openai"].baseUrl, "https://gateway.example.com/v1");
});

test("registers configured providers and the /api-manager command", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-register-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  await saveApiProviderSettings({
    provider: "maestro-openai",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-5.4",
    reasoning: true,
    apiKey: "openai-secret",
  }, modelsPath);
  await saveApiProviderSettings({
    provider: "maestro-qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    modelId: "qwen3.8-max-preview",
    reasoning: true,
    apiKey: "qwen-secret",
  }, modelsPath);
  await saveApiProviderSettings({
    provider: "maestro-anthropic",
    baseUrl: "https://api.anthropic.com",
    modelId: "claude-sonnet-4-5",
    reasoning: true,
    apiKey: "anthropic-secret",
  }, modelsPath);
  const registered: Array<{ name: string; config: any }> = [];
  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider(name: string, config: any) {
      registered.push({ name, config });
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
  } as any, { modelsPath });

  assert.deepEqual(registered.map((entry) => entry.name), ["maestro-openai", "maestro-qwen", "maestro-anthropic"]);
  assert.equal(registered[0].config.name, undefined);
  assert.equal(registered[0].config.models[0].id, "gpt-5.4");
  assert.equal(registered[1].config.name, undefined);
  assert.equal(registered[1].config.models[0].id, "qwen3.8-max-preview");
  assert.equal(registered[2].config.name, undefined);
  assert.equal(registered[2].config.models[0].id, "claude-sonnet-4-5");
  assert.deepEqual(registered[2].config.models[0].thinkingLevelMap, { xhigh: "high" });
  assert.equal(commands.size, 2);
  assert.ok(commands.has("api-manager"));
  assert.ok(commands.has("effort"));
  assert.equal(commands.has("api-login"), false);

  assert.ok(getModels("openai").length > 0);
  assert.ok(getModels("openai").every((model) => model.api === "openai-responses"));
  assert.ok(getModels("anthropic").length > 0);
  assert.ok(getModels("anthropic").every((model) => model.api === "anthropic-messages"));
});

test("runtime registration rejects remote HTTP provider and model URLs", (t) => {
  const previous = process.env[ALLOW_INSECURE_PROVIDER_HTTP_ENV];
  t.after(() => {
    if (previous === undefined) delete process.env[ALLOW_INSECURE_PROVIDER_HTTP_ENV];
    else process.env[ALLOW_INSECURE_PROVIDER_HTTP_ENV] = previous;
  });
  delete process.env[ALLOW_INSECURE_PROVIDER_HTTP_ENV];

  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-insecure-http-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  writeFileSync(modelsPath, JSON.stringify({
    providers: {
      "maestro-openai": {
        baseUrl: "http://198.51.100.10:8080/v1",
        api: "openai-responses",
        apiKey: "test-key",
        models: [{ id: "unsafe-provider-model" }],
      },
      "maestro-qwen": {
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        apiKey: "test-key",
        models: [
          { id: "unsafe-model-override", baseUrl: "http://203.0.113.10:8080/v1" },
          { id: "safe-model" },
        ],
      },
    },
  }));

  const registered = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider(name: string, config: any) {
      registered.set(name, config);
    },
  } as any, { modelsPath });

  assert.equal(registered.get("maestro-openai")?.baseUrl, undefined);
  assert.equal(registered.get("maestro-openai")?.models, undefined);
  assert.equal(registered.get("maestro-qwen")?.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.deepEqual(
    registered.get("maestro-qwen")?.models.map((model: any) => model.id),
    ["safe-model"],
  );
});

test("API Manager retry defaults are enabled and preserve explicit overrides", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-retry-defaults-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const settingsPath = join(tempDir, "settings.json");

  assert.deepEqual(await loadApiRetrySettings(settingsPath), { enabled: true, maxRetries: 12 });
  await ensureApiRetryDefaults(settingsPath);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).retry, {
    enabled: true,
    maxRetries: 12,
  });

  writeFileSync(settingsPath, JSON.stringify({
    theme: "custom",
    retry: {
      enabled: false,
      baseDelayMs: 3_000,
      provider: { maxRetries: 0, maxRetryDelayMs: 600_000 },
    },
  }));
  await ensureApiRetryDefaults(settingsPath);
  const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(saved.theme, "custom");
  assert.deepEqual(saved.retry, {
    enabled: false,
    maxRetries: 12,
    baseDelayMs: 3_000,
    provider: { maxRetries: 0, maxRetryDelayMs: 600_000 },
  });
});

test("API Manager retry save validates the shared cap and preserves sibling settings", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-retry-save-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const settingsPath = join(tempDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({
    defaultModel: "model-a",
    retry: { baseDelayMs: 2_000, provider: { timeoutMs: 30_000 } },
  }));

  await saveApiRetrySettings({ enabled: false, maxRetries: 4 }, settingsPath);
  const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(saved.defaultModel, "model-a");
  assert.deepEqual(saved.retry, {
    enabled: false,
    maxRetries: 4,
    baseDelayMs: 2_000,
    provider: { timeoutMs: 30_000 },
  });
  await assert.rejects(
    () => saveApiRetrySettings({ enabled: true, maxRetries: 13 }, settingsPath),
    /1-12/,
  );
});

test("/api-manager manages retry from commands and the interactive menu", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-retry-command-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const settingsPath = join(tempDir, "settings.json");
  const commands = new Map<string, any>();
  let sessionStart: ((event: unknown, ctx: any) => Promise<void>) | undefined;
  registerApiProviderConfigs({
    registerCommand(name: string, command: any) { commands.set(name, command); },
    getThinkingLevel() { return "medium"; },
    on(event: string, handler: (event: unknown, ctx: any) => Promise<void>) {
      if (event === "session_start") sessionStart = handler;
    },
  } as any, { modelsPath, settingsPath });
  const notifications: string[] = [];
  const baseContext = {
    cwd: tempDir,
    hasUI: false,
    ui: { notify(message: string) { notifications.push(message); } },
  };

  assert.ok(sessionStart);
  await sessionStart!({}, baseContext);
  assert.deepEqual(await loadApiRetrySettings(settingsPath), { enabled: true, maxRetries: 12 });

  const manager = commands.get("api-manager");
  await manager.handler("retry off", baseContext);
  assert.deepEqual(await loadApiRetrySettings(settingsPath), { enabled: false, maxRetries: 12 });
  await manager.handler("retry on 6", baseContext);
  assert.deepEqual(await loadApiRetrySettings(settingsPath), { enabled: true, maxRetries: 6 });
  await manager.handler("retry show", baseContext);
  assert.match(notifications.at(-1) ?? "", /Provider 自动重试：开启/);
  assert.match(notifications.at(-1) ?? "", /最大重试次数：6/);

  const selections = ["Provider 自动重试", "关闭"];
  await manager.handler("", {
    ...baseContext,
    hasUI: true,
    ui: {
      async select() { return selections.shift(); },
      async input() { throw new Error("disabled retry must not request a count"); },
      async confirm() { return true; },
      notify(message: string) { notifications.push(message); },
    },
  });
  assert.deepEqual(await loadApiRetrySettings(settingsPath), { enabled: false, maxRetries: 6 });

  const enableSelections = ["Provider 自动重试", "开启"];
  await manager.handler("", {
    ...baseContext,
    hasUI: true,
    ui: {
      async select() { return enableSelections.shift(); },
      async input() { return "8"; },
      async confirm() { return true; },
      notify(message: string) { notifications.push(message); },
    },
  });
  assert.deepEqual(await loadApiRetrySettings(settingsPath), { enabled: true, maxRetries: 8 });
});

test("validates custom API base URLs", (t) => {
  const previous = process.env[ALLOW_INSECURE_PROVIDER_HTTP_ENV];
  t.after(() => {
    if (previous === undefined) delete process.env[ALLOW_INSECURE_PROVIDER_HTTP_ENV];
    else process.env[ALLOW_INSECURE_PROVIDER_HTTP_ENV] = previous;
  });
  delete process.env[ALLOW_INSECURE_PROVIDER_HTTP_ENV];

  assert.equal(normalizeBaseUrl(" https://gateway.example.com/v1/ "), "https://gateway.example.com/v1");
  assert.equal(normalizeBaseUrl("http://localhost:8080/v1/"), "http://localhost:8080/v1");
  assert.equal(normalizeBaseUrl("http://127.23.45.67:8080/v1"), "http://127.23.45.67:8080/v1");
  assert.equal(normalizeBaseUrl("http://[::1]:8080/v1"), "http://[::1]:8080/v1");
  assert.throws(() => normalizeBaseUrl("http://198.51.100.10:8080/v1"), /must use https/);
  assert.throws(() => normalizeBaseUrl("file:///tmp/api"), /http or https/);
  assert.throws(() => normalizeBaseUrl(""), /cannot be empty/);

  process.env[ALLOW_INSECURE_PROVIDER_HTTP_ENV] = "1";
  assert.equal(
    normalizeBaseUrl("http://198.51.100.10:8080/v1/"),
    "http://198.51.100.10:8080/v1",
  );
});

test("requires an explicit API key when saving API settings", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-required-key-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");

  await assert.rejects(
    () => saveApiProviderSettings({
      provider: "maestro-openai",
      baseUrl: "https://gateway.example.com/v1",
      modelId: "gpt-5.4",
      reasoning: true,
      apiKey: "",
    }, modelsPath),
    /API key config cannot be empty/,
  );
  assert.equal(existsSync(modelsPath), false);
});

test("atomically saves API settings while preserving other providers", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-store-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const deepseek = {
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
    apiKey: "DEEPSEEK_API_KEY",
    models: [{ id: "deepseek-v4-pro", reasoning: true }],
  };
  writeFileSync(modelsPath, JSON.stringify({ version: 1, providers: { deepseek } }));

  const result = await saveApiProviderSettings({
    provider: "maestro-openai",
    baseUrl: "https://gateway.example.com/v1/",
    modelId: "gpt-5.4",
    reasoning: true,
    apiKey: "openai-secret",
  }, modelsPath);
  const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.deepEqual(saved.providers.deepseek, deepseek);
  assert.equal(saved.version, 1);
  assert.equal(saved.providers["maestro-openai"].baseUrl, "https://gateway.example.com/v1");
  assert.equal(saved.providers["maestro-openai"].api, "openai-responses");
  assert.equal(saved.providers["maestro-openai"].apiKey, "openai-secret");
  assert.deepEqual(saved.providers["maestro-openai"].models[0].thinkingLevelMap, { off: null, xhigh: "xhigh" });
  assert.ok(result.backupPath);
  assert.equal(existsSync(result.backupPath!), true);
});

test("saves Qwen as an OpenAI-compatible completions provider", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-qwen-store-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");

  await saveApiProviderSettings({
    provider: "maestro-qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/",
    modelId: "qwen3.8-max-preview",
    reasoning: true,
    apiKey: "qwen-secret",
    maxThinking: true,
  }, modelsPath);

  const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  const qwen = saved.providers["maestro-qwen"];
  assert.equal(qwen.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(qwen.api, "openai-completions");
  assert.equal(qwen.apiKey, "qwen-secret");
  assert.deepEqual(qwen.compat, {
    supportsDeveloperRole: false,
    thinkingFormat: "qwen",
  });
  assert.equal(qwen.models[0].id, "qwen3.8-max-preview");
  assert.deepEqual(qwen.models[0].thinkingLevelMap, { off: null, xhigh: "max" });
});

test("/api-manager creates or updates URL, model, reasoning, and API key", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-login-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const registrations: Array<{ name: string; config: any }> = [];
  const unregistered: string[] = [];
  const appliedThinkingLevels: string[] = [];
  let modelSelectHandler: ((event: any) => Promise<void>) | undefined;
  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider(name: string, config: any) {
      registrations.push({ name, config });
    },
    unregisterProvider(name: string) {
      unregistered.push(name);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    setThinkingLevel(level: string) {
      appliedThinkingLevels.push(level);
    },
    on(event: string, handler: (event: any) => Promise<void>) {
      if (event === "model_select") modelSelectHandler = handler;
    },
  } as any, { modelsPath });

  const inputAnswers = ["https://proxy.example.com/v1/", "gpt-5.4", "400000", "128000", "openai-secret"];
  const selectAnswers = [
    "启用：minimal / low / medium / high / xhigh / max",
    "max",
  ];
  const selectOptions: string[][] = [];
  const notifications: Array<{ type: string; message: string }> = [];
  const confirmations: string[] = [];
  const command = commands.get("api-manager");
  assert.ok(command);
  await command.handler("openai", {
    cwd: tempDir,
    hasUI: true,
    model: { provider: "maestro-openai", id: "other-model" },
    modelRegistry: {
      refresh() {},
      getAll() { return [{ thinkingLevelMap: { max: "max" } }]; },
    },
    ui: {
      async input() {
        return inputAnswers.shift();
      },
      async select(_title: string, options: string[]) {
        selectOptions.push(options);
        return selectAnswers.shift();
      },
      async confirm(_title: string, details: string) {
        confirmations.push(details);
        return true;
      },
      notify(message: string, type: string) {
        notifications.push({ message, type });
      },
    },
  });

  const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.equal(saved.providers["maestro-openai"].baseUrl, "https://proxy.example.com/v1");
  assert.equal(saved.providers["maestro-openai"].models[0].id, "gpt-5.4");
  assert.equal(saved.providers["maestro-openai"].models[0].reasoning, true);
  assert.equal(saved.providers["maestro-openai"].models[0].contextWindow, 400_000);
  assert.equal(saved.providers["maestro-openai"].models[0].maxTokens, 128_000);
  assert.equal(saved.providers["maestro-openai"].models[0].thinkingLevelMap.xhigh, "max");
  assert.equal("max" in saved.providers["maestro-openai"].models[0].thinkingLevelMap, false);
  assert.equal(saved.providers["maestro-openai"].apiKey, "openai-secret");
  const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"));
  assert.equal(settings.defaultProvider, "maestro-openai");
  assert.equal(settings.defaultModel, "gpt-5.4");
  assert.equal(settings.defaultThinkingLevel, "max");
  assert.deepEqual(appliedThinkingLevels, []);
  assert.ok(modelSelectHandler);
  await modelSelectHandler!({ model: { provider: "maestro-openai", id: "gpt-5.4" } });
  assert.deepEqual(appliedThinkingLevels, ["xhigh"]);
  const defaults = JSON.parse(readFileSync(join(tempDir, "api-manager.json"), "utf8"));
  assert.equal(defaults.modelDefaults["maestro-openai/gpt-5.4"], "xhigh");
  assert.ok(selectOptions[1]?.includes("max"));
  assert.doesNotMatch(selectOptions.flat().join("\n"), /环境变量|保留当前 API key/);
  assert.deepEqual(unregistered, []);
  assert.equal(registrations.length, 1);
  assert.equal(registrations.at(-1)?.name, "maestro-openai");
  assert.equal(registrations.at(-1)?.config.name, undefined);
  assert.equal(registrations.at(-1)?.config.models[0].id, "gpt-5.4");
  assert.match(confirmations[0] ?? "", /上下文窗口 contextWindow：400,000 Token/);
  assert.match(confirmations[0] ?? "", /单次最大输出 maxTokens：128,000 Token/);
  assert.match(confirmations[0] ?? "", /预计实际硬压缩：上下文超过 272,000 Token/);
  assert.match(confirmations[0] ?? "", /软提醒不可达/);
  assert.match(notifications.at(-1)?.message ?? "", /默认模型为 maestro-openai\/gpt-5\.4/);
  assert.equal(notifications.at(-1)?.type, "info");
});

test("/api-manager edits a concrete OpenAI model and shows its API format", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-openai-model-edit-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const base = {
    provider: "maestro-openai",
    baseUrl: "https://gateway.example.com/v1",
    apiKey: "openai-secret",
  };
  await saveApiProviderSettings({ ...base, modelId: "model-a", contextWindow: 111_000, maxTokens: 32_000, reasoning: false }, modelsPath);
  await saveApiProviderSettings({ ...base, modelId: "model-b", contextWindow: 222_000, reasoning: true }, modelsPath);
  const before = JSON.parse(readFileSync(modelsPath, "utf8"));
  const modelABefore = before.providers["maestro-openai"].models[0];

  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider() {},
    unregisterProvider() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
    setThinkingLevel() {},
  } as any, { modelsPath });
  const inputs = ["https://gateway.example.com/v1", "model-b", "333000", "64000", "openai-secret"];
  const selections = ["model-b", "关闭：仅 off", "off"];
  const rendered: string[][] = [];
  const confirmations: string[] = [];
  await commands.get("api-manager").handler("set openai", {
    cwd: tempDir,
    hasUI: true,
    modelRegistry: { refresh() {}, getAll() { return []; } },
    ui: {
      async input() { return inputs.shift(); },
      async select(_title: string, options: string[]) {
        rendered.push(options);
        return selections.shift();
      },
      async confirm(_title: string, details: string) {
        confirmations.push(details);
        return true;
      },
      notify() {},
    },
  });

  const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  const openai = saved.providers["maestro-openai"];
  assert.equal(openai.api, "openai-responses");
  assert.deepEqual(openai.models[0], modelABefore);
  assert.equal(openai.models[1].id, "model-b");
  assert.equal(openai.models[1].contextWindow, 333_000);
  assert.equal(openai.models[1].maxTokens, 64_000);
  assert.equal(openai.models[1].reasoning, false);
  assert.equal(openai.models[1].thinkingLevelMap, undefined);
  assert.deepEqual(rendered[0], ["model-a", "model-b", "➕ 新增 model…"]);
  assert.match(confirmations[0] ?? "", /API format：openai-responses/);
  assert.match(confirmations[0] ?? "", /其余 1 个 model/);
});

test("/api-manager shows one concrete Anthropic model with anthropic-messages format", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-anthropic-show-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const base = {
    provider: "maestro-anthropic",
    baseUrl: "https://anthropic.example.com",
    apiKey: "anthropic-secret-must-not-be-shown",
  };
  await saveApiProviderSettings({ ...base, modelId: "claude-a", contextWindow: 200_000, reasoning: true }, modelsPath);
  await saveApiProviderSettings({ ...base, modelId: "claude-b", contextWindow: 250_000, reasoning: false }, modelsPath);

  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
  } as any, { modelsPath });
  const notifications: string[] = [];
  await commands.get("api-manager").handler("show anthropic", {
    cwd: tempDir,
    hasUI: true,
    ui: {
      async select(_title: string, options: string[]) {
        assert.deepEqual(options, ["claude-a", "claude-b"]);
        return "claude-b";
      },
      notify(message: string) { notifications.push(message); },
    },
  });

  const output = notifications.at(-1) ?? "";
  assert.match(output, /API format：anthropic-messages/);
  assert.match(output, /Model：claude-b/);
  assert.match(output, /上下文窗口 contextWindow：250,000 Token/);
  assert.match(output, /单次最大输出 maxTokens：64,000 Token/);
  assert.match(output, /Reasoning：disabled/);
  assert.doesNotMatch(output, /claude-a/);
  assert.doesNotMatch(output, /anthropic-secret-must-not-be-shown/);
});

test("/api-manager qwen creates an OpenAI-compatible provider and default model", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-qwen-login-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const registrations: Array<{ name: string; config: any }> = [];
  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider(name: string, config: any) {
      registrations.push({ name, config });
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    setThinkingLevel() {},
  } as any, { modelsPath });

  const inputAnswers = [
    "https://dashscope.aliyuncs.com/compatible-mode/v1/",
    "qwen3.8-max-preview",
    "1000000",
    "128000",
    "qwen-secret",
  ];
  const selectAnswers = [
    "启用：off / minimal / low / medium / high / xhigh / max",
    "high",
  ];
  const selectOptions: string[][] = [];
  const command = commands.get("api-manager");
  assert.ok(command);
  await command.handler("qwen", {
    cwd: tempDir,
    hasUI: true,
    modelRegistry: {
      refresh() {},
      getAll() { return [{ thinkingLevelMap: { max: "max" } }]; },
    },
    ui: {
      async input() {
        return inputAnswers.shift();
      },
      async select(_title: string, options: string[]) {
        selectOptions.push(options);
        return selectAnswers.shift();
      },
      async confirm() {
        return true;
      },
      notify() {},
    },
  });

  const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.equal(saved.providers["maestro-qwen"].api, "openai-completions");
  assert.deepEqual(saved.providers["maestro-qwen"].compat, {
    supportsDeveloperRole: false,
    thinkingFormat: "qwen",
  });
  assert.equal(saved.providers["maestro-qwen"].models[0].id, "qwen3.8-max-preview");
  assert.equal(saved.providers["maestro-qwen"].models[0].contextWindow, 1_000_000);
  assert.equal(saved.providers["maestro-qwen"].models[0].thinkingLevelMap.xhigh, "max");
  assert.equal("max" in saved.providers["maestro-qwen"].models[0].thinkingLevelMap, false);
  const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"));
  assert.equal(settings.defaultProvider, "maestro-qwen");
  assert.equal(settings.defaultModel, "qwen3.8-max-preview");
  assert.equal(settings.defaultThinkingLevel, "high");
  assert.ok(selectOptions[0]?.includes("启用：off / minimal / low / medium / high / xhigh / max"));
  assert.equal(registrations.at(-1)?.name, "maestro-qwen");
  assert.equal(registrations.at(-1)?.config.name, undefined);
  assert.equal(registrations.at(-1)?.config.models[0].id, "qwen3.8-max-preview");
});

test("/api-manager rejects invalid URL, context window, and API key", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-explicit-input-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  await saveApiProviderSettings({
    provider: "maestro-openai",
    baseUrl: "https://old.example.com/v1",
    modelId: "gpt-old",
    reasoning: true,
    apiKey: "old-secret",
  }, modelsPath);
  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider() {},
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
  } as any, { modelsPath });
  const command = commands.get("api-manager");
  const makeContext = (
    inputAnswers: Array<string | undefined>,
    selectAnswers: Array<string | undefined> = [],
  ) => {
    const notifications: Array<{ type: string; message: string }> = [];
    const selectOptions: string[][] = [];
    let confirms = 0;
    return {
      notifications,
      selectOptions,
      ctx: {
        cwd: tempDir,
        hasUI: true,
        modelRegistry: {
          refresh() {},
          getAll() { return [{ thinkingLevelMap: { max: "max" } }]; },
        },
        ui: {
          async input() {
            return inputAnswers.shift();
          },
          async select(_title: string, options: string[]) {
            selectOptions.push(options);
            return selectAnswers.shift();
          },
          async confirm() {
            confirms += 1;
            return true;
          },
          notify(message: string, type: string) {
            notifications.push({ message, type });
          },
        },
      },
      get confirms() {
        return confirms;
      },
    };
  };

  const emptyUrl = makeContext([""], ["gpt-old"]);
  await command.handler("set openai", emptyUrl.ctx);
  let saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.equal(saved.providers["maestro-openai"].baseUrl, "https://old.example.com/v1");
  assert.equal(saved.providers["maestro-openai"].apiKey, "old-secret");
  assert.equal(emptyUrl.confirms, 0);
  assert.match(emptyUrl.notifications.at(-1)?.message ?? "", /Base URL cannot be empty/);

  const invalidContext = makeContext(
    ["https://new.example.com/v1", "gpt-new", "0"],
    ["gpt-old", "启用：minimal / low / medium / high / xhigh / max", "medium"],
  );
  await command.handler("set openai", invalidContext.ctx);
  saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.equal(saved.providers["maestro-openai"].models[0].id, "gpt-old");
  assert.equal(invalidContext.confirms, 0);
  assert.match(invalidContext.notifications.at(-1)?.message ?? "", /上下文窗口 contextWindow 必须是大于 0 的整数/);

  const invalidMax = makeContext(
    ["https://new.example.com/v1", "gpt-new", "400000", "400000"],
    ["gpt-old", "启用：minimal / low / medium / high / xhigh / max", "medium"],
  );
  await command.handler("set openai", invalidMax.ctx);
  saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.equal(saved.providers["maestro-openai"].models[0].id, "gpt-old");
  assert.equal(invalidMax.confirms, 0);
  assert.match(invalidMax.notifications.at(-1)?.message ?? "", /没有空间容纳输入/);

  const emptyKey = makeContext(
    ["https://new.example.com/v1", "gpt-new", "400000", "128000", ""],
    ["gpt-old", "启用：minimal / low / medium / high / xhigh / max", "medium"],
  );
  await command.handler("set openai", emptyKey.ctx);
  saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.equal(saved.providers["maestro-openai"].baseUrl, "https://old.example.com/v1");
  assert.equal(saved.providers["maestro-openai"].models[0].id, "gpt-old");
  assert.equal(saved.providers["maestro-openai"].apiKey, "old-secret");
  assert.equal(emptyKey.confirms, 0);
  assert.match(emptyKey.notifications.at(-1)?.message ?? "", /API key cannot be empty/);
  assert.doesNotMatch(emptyKey.selectOptions.flat().join("\n"), /环境变量|保留当前 API key/);
});

test("/api-manager logout clears provider config instead of falling back to env vars", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-logout-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const defaultsPath = join(tempDir, "api-manager.json");
  await saveApiProviderSettings({
    provider: "maestro-openai",
    baseUrl: "https://proxy.example.com/v1",
    modelId: "gpt-private",
    reasoning: false,
    apiKey: "stored-secret",
  }, modelsPath);
  writeFileSync(defaultsPath, JSON.stringify({
    version: 1,
    modelDefaults: {
      "maestro-openai/gpt-private": "high",
      "deepseek/deepseek-private": "low",
    },
  }));
  const commands = new Map<string, any>();
  const unregistered: string[] = [];
  let refreshes = 0;
  registerApiProviderConfigs({
    registerProvider() {},
    unregisterProvider(name: string) { unregistered.push(name); },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
  } as any, { modelsPath });

  await commands.get("api-manager").handler("logout openai", {
    cwd: tempDir,
    hasUI: true,
    modelRegistry: {
      refresh() { refreshes += 1; },
      getAll() { return [{ thinkingLevelMap: { max: "max" } }]; },
    },
    ui: {
      async confirm() { return true; },
      notify() {},
    },
  });

  const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.equal(saved.providers["maestro-openai"], undefined);
  const defaults = JSON.parse(readFileSync(defaultsPath, "utf8"));
  assert.equal(defaults.modelDefaults["maestro-openai/gpt-private"], undefined);
  assert.equal(defaults.modelDefaults["deepseek/deepseek-private"], "low");
  assert.deepEqual(unregistered, ["maestro-openai"]);
  assert.equal(refreshes, 1);
});

test("/api-manager reset clears provider config and restores the global thinking default", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-reset-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const defaultsPath = join(tempDir, "api-manager.json");
  await saveApiProviderSettings({
    provider: "maestro-anthropic",
    baseUrl: "https://anthropic-proxy.example.com",
    modelId: "claude-private",
    reasoning: false,
    apiKey: "anthropic-secret",
  }, modelsPath);
  writeFileSync(defaultsPath, JSON.stringify({
    version: 1,
    modelDefaults: {
      "maestro-anthropic/claude-private": "high",
    },
  }));
  const commands = new Map<string, any>();
  const unregistered: string[] = [];
  let refreshes = 0;
  registerApiProviderConfigs({
    registerProvider() {},
    unregisterProvider(name: string) { unregistered.push(name); },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
  } as any, { modelsPath });

  await commands.get("api-manager").handler("reset anthropic", {
    cwd: tempDir,
    hasUI: true,
    modelRegistry: {
      refresh() { refreshes += 1; },
      getAll() { return [{ thinkingLevelMap: { max: "max" } }]; },
    },
    ui: {
      async confirm() { return true; },
      notify() {},
    },
  });

  const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.equal(saved.providers["maestro-anthropic"], undefined);
  const defaults = JSON.parse(readFileSync(defaultsPath, "utf8"));
  assert.equal(defaults.modelDefaults["maestro-anthropic/claude-private"], undefined);
  const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"));
  assert.equal(settings.defaultThinkingLevel, "medium");
  assert.deepEqual(unregistered, ["maestro-anthropic"]);
  assert.equal(refreshes, 1);
});

test("/api-manager lists and deletes one provider without changing DeepSeek", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-delete-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const deepseek = {
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
    apiKey: "deepseek-secret",
    models: [{ id: "deepseek-private", reasoning: true }],
  };
  writeFileSync(modelsPath, JSON.stringify({ providers: { deepseek } }));
  await saveApiProviderSettings({
    provider: "maestro-openai",
    baseUrl: "https://gateway.example.com/v1",
    modelId: "gpt-private",
    reasoning: true,
    apiKey: "openai-secret-must-not-be-shown",
  }, modelsPath);

  const commands = new Map<string, any>();
  const notifications: string[] = [];
  const unregistered: string[] = [];
  let refreshes = 0;
  registerApiProviderConfigs({
    registerProvider() {},
    unregisterProvider(name: string) { unregistered.push(name); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
  } as any, { modelsPath });
  const command = commands.get("api-manager");

  await command.handler("list", {
    cwd: tempDir,
    hasUI: false,
    ui: { notify(message: string) { notifications.push(message); } },
  });
  assert.match(notifications.at(-1) ?? "", /gpt-private/);
  assert.match(notifications.at(-1) ?? "", /Anthropic \(Custom\)：未配置/);
  assert.match(notifications.at(-1) ?? "", /Pi 全局默认思考强度：medium/);
  assert.doesNotMatch(notifications.at(-1) ?? "", /openai-secret-must-not-be-shown/);

  await command.handler("delete openai", {
    cwd: tempDir,
    hasUI: true,
    modelRegistry: { refresh() { refreshes += 1; } },
    ui: {
      async confirm() { return true; },
      notify(message: string) { notifications.push(message); },
    },
  });
  const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.equal(saved.providers["maestro-openai"], undefined);
  assert.deepEqual(saved.providers.deepseek, deepseek);
  assert.deepEqual(unregistered, ["maestro-openai"]);
  assert.equal(refreshes, 1);
  assert.match(notifications.at(-1) ?? "", /已删除/);
});

test("models.json custom API settings preserve DeepSeek models", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-config-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  writeFileSync(modelsPath, JSON.stringify({
    providers: {
      "maestro-openai": {
        baseUrl: "https://gateway.example.com/v1",
        api: "openai-responses",
        apiKey: "openai-test-key",
        models: [{
          id: "gpt-5.4",
          name: "GPT-5.4 Gateway",
          reasoning: true,
          thinkingLevelMap: { off: null, xhigh: "xhigh" },
          input: ["text", "image"],
          contextWindow: 400_000,
          maxTokens: 128_000,
        }],
      },
    },
  }));

  const authStorage = AuthStorage.inMemory({
    "maestro-openai": { type: "api_key", key: "openai-test-key" },
    deepseek: { type: "api_key", key: "deepseek-test-key" },
  });
  const registry = await createModelRegistry(authStorage, modelsPath);
  const deepseekBefore = registry.getAll()
    .filter((model) => model.provider === "deepseek")
    .map((model) => ({ id: model.id, name: model.name }));

  registerApiProviderConfigs({
    registerProvider(name: string, config: any) {
      registry.registerProvider(name, config);
    },
  } as any, { modelsPath });

  const customOpenAi = registry.find("maestro-openai", "gpt-5.4");
  assert.equal(customOpenAi?.baseUrl, "https://gateway.example.com/v1");
  assert.equal(customOpenAi?.reasoning, true);
  assert.deepEqual(customOpenAi?.thinkingLevelMap, { off: null, xhigh: "xhigh" });
  assert.equal(registry.getProviderDisplayName("maestro-openai"), "maestro-openai");
  assert.equal(registry.getProviderDisplayName("maestro-anthropic"), "maestro-anthropic");

  const deepseekAfter = registry.getAll()
    .filter((model) => model.provider === "deepseek")
    .map((model) => ({ id: model.id, name: model.name }));
  assert.deepEqual(deepseekAfter, deepseekBefore);
  assert.ok(deepseekAfter.some((model) => model.id === "deepseek-v4-pro"));
});

test("/effort renders canonical capability order with current marker and progress bars", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-effort-canonical-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const defaultsPath = join(tempDir, "api-manager.json");
  const applied: string[] = [];
  const harness = createEffortHarness({
    modelsPath: join(tempDir, "models.json"),
    defaultsPath,
    current: "medium",
    apply(level) { applied.push(level); },
  });
  const notifications: Array<{ message: string; type: string }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  let rendered: string[] = [];
  let title = "";
  await harness.command.handler("", {
    model: {
      provider: "maestro-openai",
      id: "gpt-5.4",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh" },
    },
    ui: {
      async select(nextTitle: string, options: string[]) {
        title = nextTitle;
        rendered = options;
        return "high [████░]";
      },
      notify(message: string, type: string) { notifications.push({ message, type }); },
      setStatus(key: string, value: string | undefined) { statuses.push({ key, value }); },
    },
  });

  assert.deepEqual(rendered, [
    "off [░░░░░]",
    "minimal [█░░░░]",
    "low [██░░░]",
    "medium（当前） [███░░]",
    "high [████░]",
    "xhigh [█████]",
  ]);
  assert.equal(title, "选择思考强度（当前：medium）");
  assert.deepEqual(applied, ["high"]);
  assert.deepEqual(notifications.at(-1), { message: "思考强度已设为 high [████░]", type: "info" });
  assert.deepEqual(statuses.at(-1), { key: "maestro-effort", value: "high" });
});

test("/effort filters unsupported canonical levels", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-effort-filter-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const harness = createEffortHarness({
    modelsPath: join(tempDir, "models.json"),
    defaultsPath: join(tempDir, "api-manager.json"),
  });
  let rendered: string[] = [];
  await harness.command.handler("", {
    model: {
      provider: "test",
      id: "filtered",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, xhigh: null },
    },
    ui: {
      async select(_title: string, options: string[]) {
        rendered = options;
        return undefined;
      },
      notify() {},
    },
  });
  assert.deepEqual(rendered, ["low [██░░░]", "medium（当前） [███░░]", "high [████░]"]);
});

test("/effort persists API Manager and system providers by model key", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-effort-provider-keys-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const defaultsPath = join(tempDir, "api-manager.json");
  writeFileSync(modelsPath, "invalid models file");
  const applied: string[] = [];
  const harness = createEffortHarness({
    modelsPath,
    defaultsPath,
    apply(level) { applied.push(level); },
  });
  const invoke = async (model: any, selected: string) => {
    await harness.command.handler("", {
      model,
      ui: {
        async select() { return selected; },
        notify() {},
      },
    });
  };
  await invoke(
    { provider: "maestro-openai", id: "gpt-5.4", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
    "high [████░]",
  );
  await invoke(
    { provider: "anthropic", id: "claude-sonnet", reasoning: true, thinkingLevelMap: { xhigh: "high" } },
    "xhigh [█████]",
  );

  const defaults = JSON.parse(readFileSync(defaultsPath, "utf8"));
  assert.equal(defaults.modelDefaults["maestro-openai/gpt-5.4"], "high");
  assert.equal(defaults.modelDefaults["anthropic/claude-sonnet"], "xhigh");
  assert.deepEqual(applied, ["high", "xhigh"]);
  assert.equal(readFileSync(modelsPath, "utf8"), "invalid models file");
});

test("legacy Qwen entry path preserves ProviderConfig metadata, compat, and live max mapping", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-effort-qwen-entry-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const defaultsPath = join(tempDir, "api-manager.json");
  const siblingModel = {
    id: "qwen-sibling",
    name: "Qwen Sibling",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    contextWindow: 32_000,
    maxTokens: 4_096,
  };
  const otherProvider = {
    baseUrl: "https://other.example.com/v1",
    api: "openai-completions",
    apiKey: "other-secret",
    models: [{ ...siblingModel, id: "other-model" }],
  };
  writeFileSync(modelsPath, JSON.stringify({
    rootSentinel: { keep: true },
    providers: {
      "maestro-qwen": {
        name: "Qwen Fixture",
        baseUrl: "https://qwen.example.com/v1",
        api: "openai-completions",
        apiKey: "qwen-secret",
        headers: { "X-Provider": "qwen" },
        authHeader: false,
        compat: {
          supportsDeveloperRole: false,
          thinkingFormat: "qwen",
          openRouterRouting: { allow_fallbacks: true, data_collection: "deny" },
          vercelGatewayRouting: { only: ["provider-default"], order: ["provider-default", "backup"] },
        },
        models: [{
          id: "qwen-max",
          name: "Qwen Max",
          api: "openai-completions",
          baseUrl: "https://qwen-model.example.com/v1",
          reasoning: true,
          thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max", extra: "keep-me" },
          input: ["text", "image"],
          cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
          contextWindow: 400_000,
          maxTokens: 128_000,
          headers: { "X-Model": "qwen-max" },
          compat: {
            supportsDeveloperRole: true,
            openRouterRouting: { allow_fallbacks: false, require_parameters: true },
            vercelGatewayRouting: { order: ["model-first"] },
          },
        }, siblingModel],
      },
      other: otherProvider,
    },
  }, null, 2));
  const registry = await createModelRegistry(AuthStorage.inMemory({
    "maestro-qwen": { type: "api_key", key: "qwen-secret" },
  }), modelsPath);
  const captured: Array<{ name: string; config: any }> = [];
  const applied: string[] = [];
  const harness = createEffortHarness({
    modelsPath,
    defaultsPath,
    current: "xhigh",
    apply(level) { applied.push(level); },
    registerProvider(name, config) {
      captured.push({ name, config });
      registry.registerProvider(name, config);
    },
  });

  const registration = captured.find((entry) => entry.name === "maestro-qwen")?.config;
  assert.ok(registration);
  assert.equal("compat" in registration, false);
  assert.deepEqual(registration.headers, { "X-Provider": "qwen" });
  assert.equal(registration.authHeader, false);
  const registeredModel = registration.models.find((model: any) => model.id === "qwen-max");
  assert.deepEqual(registeredModel.headers, { "X-Model": "qwen-max" });
  assert.deepEqual(registeredModel.thinkingLevelMap, { off: null, xhigh: "max", extra: "keep-me" });
  assert.equal("max" in registeredModel.thinkingLevelMap, false);

  const live = registry.find("maestro-qwen", "qwen-max")!;
  assert.equal(live.provider, "maestro-qwen");
  assert.equal(live.api, "openai-completions");
  assert.equal(live.baseUrl, "https://qwen-model.example.com/v1");
  assert.equal(live.reasoning, true);
  assert.deepEqual(live.input, ["text", "image"]);
  assert.deepEqual(live.cost, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  assert.equal(live.contextWindow, 400_000);
  assert.equal(live.maxTokens, 128_000);
  assert.deepEqual(live.compat, {
    supportsDeveloperRole: true,
    thinkingFormat: "qwen",
    openRouterRouting: { allow_fallbacks: false, data_collection: "deny", require_parameters: true },
    vercelGatewayRouting: { only: ["provider-default"], order: ["model-first"] },
  });
  assert.equal(live.thinkingLevelMap?.xhigh, "max");
  assert.equal("max" in (live.thinkingLevelMap ?? {}), false);
  const request = await registry.getApiKeyAndHeaders(live);
  assert.equal(request.ok, true);
  assert.deepEqual(request.headers, { "X-Provider": "qwen", "X-Model": "qwen-max" });

  await harness.command.handler("", {
    model: live,
    ui: {
      async select() { return "xhigh（当前） [█████]"; },
      notify() {},
    },
  });
  assert.ok(harness.modelSelect);
  await harness.modelSelect!({ model: live });
  assert.deepEqual(applied, ["xhigh", "xhigh"]);

  const loaded = await loadApiProviderSettings("maestro-qwen", modelsPath);
  assert.equal(loaded.maxThinking, true);
  const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.deepEqual(saved.rootSentinel, { keep: true });
  assert.deepEqual(saved.providers.other, otherProvider);
  assert.deepEqual(saved.providers["maestro-qwen"].models[1], siblingModel);
  assert.deepEqual(saved.providers["maestro-qwen"].models[0].thinkingLevelMap, {
    off: null,
    xhigh: "max",
    extra: "keep-me",
  });
});

test("runtime max capability accepts legacy and canonical mappings", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-effort-runtime-max-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
  } as any, { modelsPath });
  const manager = commands.get("api-manager");
  for (const thinkingLevelMap of [{ max: "max" }, { xhigh: "max" }]) {
    const inputs = ["https://qwen.example.com/v1", "qwen-max"];
    const rendered: string[][] = [];
    await manager.handler("qwen", {
      hasUI: true,
      modelRegistry: { getAll() { return [{ thinkingLevelMap }]; } },
      ui: {
        async input() { return inputs.shift(); },
        async select(_title: string, options: string[]) {
          rendered.push(options);
          return undefined;
        },
        notify() {},
      },
    });
    assert.ok(rendered[0]?.includes("启用：off / minimal / low / medium / high / xhigh / max"));
  }

  await saveApiProviderSettings({
    provider: "maestro-qwen",
    baseUrl: "https://qwen.example.com/v1",
    modelId: "qwen-max",
    reasoning: true,
    apiKey: "qwen-secret",
    maxThinking: true,
  }, modelsPath);
  const registrations: any[] = [];
  registerApiProviderConfigs({
    registerProvider(name: string, config: any) { registrations.push({ name, config }); },
  } as any, { modelsPath });
  const map = registrations[0].config.models[0].thinkingLevelMap;
  assert.deepEqual(map, { off: null, xhigh: "max" });
  assert.equal("max" in map, false);
});

test("/effort cancellation and missing model are no-ops", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-effort-noop-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const defaultsPath = join(tempDir, "api-manager.json");
  const applied: string[] = [];
  const harness = createEffortHarness({
    modelsPath: join(tempDir, "models.json"),
    defaultsPath,
    apply(level) { applied.push(level); },
  });
  await harness.command.handler("", {
    model: { provider: "openai", id: "gpt", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
    ui: { async select() { return undefined; }, notify() {} },
  });
  assert.equal(existsSync(defaultsPath), false);
  assert.deepEqual(applied, []);

  const notifications: Array<{ message: string; type: string }> = [];
  await harness.command.handler("", {
    model: undefined,
    ui: { notify(message: string, type: string) { notifications.push({ message, type }); } },
  });
  assert.equal(notifications.at(-1)?.type, "warning");
  assert.equal(notifications.at(-1)?.message, "当前没有模型，无法调整思考强度。");
  assert.deepEqual(applied, []);
});

test("/effort persistence failure preserves existing default bytes and runtime", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-effort-save-failure-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const defaultsPath = join(tempDir, "api-manager.json");
  writeFileSync(defaultsPath, "[\n  \"sentinel\"\n]\n");
  const before = readFileSync(defaultsPath);
  const applied: string[] = [];
  const harness = createEffortHarness({
    modelsPath: join(tempDir, "models.json"),
    defaultsPath,
    apply(level) { applied.push(level); },
  });
  const notifications: Array<{ message: string; type: string }> = [];
  await harness.command.handler("", {
    model: { provider: "openai", id: "gpt", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
    ui: {
      async select() { return "high [████░]"; },
      notify(message: string, type: string) { notifications.push({ message, type }); },
    },
  });
  assert.deepEqual(readFileSync(defaultsPath), before);
  assert.deepEqual(applied, []);
  assert.equal(notifications.at(-1)?.type, "error");
  assert.match(notifications.at(-1)?.message ?? "", /^思考强度保存失败：/);
});

test("model_select restores canonical effort, synchronizes the status, and never passes max", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-effort-model-select-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const defaultsPath = join(tempDir, "api-manager.json");
  writeFileSync(defaultsPath, JSON.stringify({
    version: 1,
    modelDefaults: {
      "maestro-openai/gpt-5.4": "max",
      "anthropic/claude-sonnet": "max",
    },
  }));
  const applied: string[] = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const harness = createEffortHarness({
    modelsPath: join(tempDir, "models.json"),
    defaultsPath,
    apply(level) { applied.push(level); },
  });
  assert.ok(harness.modelSelect);
  const ctx = { ui: { setStatus(key: string, value: string | undefined) { statuses.push({ key, value }); } } };
  await harness.modelSelect!({ model: { provider: "maestro-openai", id: "gpt-5.4" } }, ctx);
  await harness.modelSelect!({ model: { provider: "anthropic", id: "claude-sonnet" } }, ctx);
  assert.deepEqual(applied, ["xhigh", "xhigh"]);
  assert.equal(applied.includes("max"), false);
  assert.deepEqual(statuses, [
    { key: "maestro-effort", value: "xhigh" },
    { key: "maestro-effort", value: "xhigh" },
  ]);
});

test("/effort does not change global defaultThinkingLevel", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-effort-global-default-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const settingsPath = join(tempDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ defaultThinkingLevel: "medium", sentinel: true }));
  const harness = createEffortHarness({
    modelsPath: join(tempDir, "models.json"),
    defaultsPath: join(tempDir, "api-manager.json"),
  });
  await harness.command.handler("", {
    cwd: tempDir,
    model: { provider: "openai", id: "gpt", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
    ui: { async select() { return "high [████░]"; }, notify() {} },
  });
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(settings.defaultThinkingLevel, "medium");
  assert.equal(settings.sentinel, true);
});

test("/effort reports synchronous runtime apply errors after durable save", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-effort-apply-failure-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const defaultsPath = join(tempDir, "api-manager.json");
  const harness = createEffortHarness({
    modelsPath: join(tempDir, "models.json"),
    defaultsPath,
    apply() { throw new Error("runtime unavailable"); },
  });
  const notifications: Array<{ message: string; type: string }> = [];
  await harness.command.handler("", {
    model: { provider: "openai", id: "gpt", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
    ui: {
      async select() { return "high [████░]"; },
      notify(message: string, type: string) { notifications.push({ message, type }); },
    },
  });
  const defaults = JSON.parse(readFileSync(defaultsPath, "utf8"));
  assert.equal(defaults.modelDefaults["openai/gpt"], "high");
  assert.equal(notifications.at(-1)?.type, "error");
  assert.match(notifications.at(-1)?.message ?? "", /^思考强度应用失败：/);
  assert.equal(notifications.some((entry) => entry.message.startsWith("思考强度已设为")), false);
});

test("saveApiProviderSettings stores explicit api, compat, and name for a custom channel", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-custom-save-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");

  await saveApiProviderSettings({
    provider: "my-proxy",
    baseUrl: "https://proxy.example.com/v1",
    modelId: "my-model",
    reasoning: true,
    apiKey: "proxy-secret",
    api: "openai-completions",
    name: "My Proxy",
    contextWindow: 200_000,
    maxTokens: 32_768,
    compat: { supportsDeveloperRole: false, thinkingFormat: "qwen" },
  }, modelsPath);

  const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  const custom = saved.providers["my-proxy"];
  assert.equal(custom.api, "openai-completions");
  assert.equal(custom.name, "My Proxy");
  assert.equal(custom.baseUrl, "https://proxy.example.com/v1");
  assert.deepEqual(custom.compat, { supportsDeveloperRole: false, thinkingFormat: "qwen" });
  assert.equal(custom.models[0].id, "my-model");
  assert.equal(custom.models[0].contextWindow, 200_000);
  assert.equal(custom.models[0].maxTokens, 32_768);

  await assert.rejects(
    () => saveApiProviderSettings({
      provider: "no-protocol",
      baseUrl: "https://proxy.example.com/v1",
      modelId: "m",
      reasoning: false,
      apiKey: "k",
    }, modelsPath),
    /API type cannot be empty/,
  );
});

test("/api-manager creates a custom channel with a free-form id and chosen protocol", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-custom-create-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const registrations: Array<{ name: string; config: any }> = [];
  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider(name: string, config: any) {
      registrations.push({ name, config });
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    setThinkingLevel() {},
  } as any, { modelsPath });

  const inputAnswers = [
    "my-proxy",
    "My Proxy",
    "https://proxy.example.com/v1/",
    "my-model",
    "200000",
    "32768",
    "X-Custom",
    "custom-val",
    "",
    "proxy-secret",
  ];
  const selectAnswers = [
    "openai-completions",
    "启用：off / minimal / low / medium / high / xhigh / max",
    "high",
    "deepseek（thinking.type · 亦适用 api.z.ai 直连）",
    "手动设置…",
    "不支持（用 system）",
    "支持",
    "max_tokens",
    "强制 Bearer（authHeader=true）",
  ];
  const notifications: Array<{ type: string; message: string }> = [];
  const command = commands.get("api-manager");
  assert.ok(command);
  await command.handler("set my-proxy", {
    cwd: tempDir,
    hasUI: true,
    modelRegistry: {
      refresh() {},
      getAll() { return [{ thinkingLevelMap: { max: "max" } }]; },
    },
    ui: {
      async input() { return inputAnswers.shift(); },
      async select() { return selectAnswers.shift(); },
      async confirm() { return true; },
      notify(message: string, type: string) { notifications.push({ message, type }); },
    },
  });

  const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  const custom = saved.providers["my-proxy"];
  assert.equal(custom.api, "openai-completions");
  assert.equal(custom.name, "My Proxy");
  assert.equal(custom.baseUrl, "https://proxy.example.com/v1");
  assert.deepEqual(custom.compat, {
    thinkingFormat: "deepseek",
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    maxTokensField: "max_tokens",
  });
  assert.deepEqual(custom.headers, { "X-Custom": "custom-val" });
  assert.equal(custom.authHeader, true);
  assert.equal(custom.models[0].id, "my-model");
  assert.equal(custom.models[0].contextWindow, 200_000);
  assert.equal(custom.models[0].maxTokens, 32_768);
  assert.equal(custom.models[0].reasoning, true);
  assert.equal(custom.models[0].thinkingLevelMap.xhigh, "max");

  const defaults = JSON.parse(readFileSync(join(tempDir, "api-manager.json"), "utf8"));
  assert.deepEqual(defaults.managedChannels, ["my-proxy"]);
  assert.equal(defaults.modelDefaults["my-proxy/my-model"], "high");

  const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"));
  assert.equal(settings.defaultProvider, "my-proxy");
  assert.equal(settings.defaultModel, "my-model");

  assert.equal(registrations.at(-1)?.name, "my-proxy");
  assert.equal(registrations.at(-1)?.config.api, "openai-completions");
  assert.equal(registrations.at(-1)?.config.name, "My Proxy");
  assert.deepEqual(registrations.at(-1)?.config.headers, { "X-Custom": "custom-val" });
  assert.equal(registrations.at(-1)?.config.authHeader, true);
  assert.equal(registrations.at(-1)?.config.models[0].compat.thinkingFormat, "deepseek");
  assert.equal(registrations.at(-1)?.config.models[0].id, "my-model");
  assert.match(notifications.at(-1)?.message ?? "", /已保存自定义渠道；默认模型为 my-proxy\/my-model/);
});

test("startup registers managed custom channels alongside presets", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-custom-startup-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const defaultsPath = join(tempDir, "api-manager.json");
  writeFileSync(modelsPath, JSON.stringify({
    providers: {
      "my-proxy": {
        name: "My Proxy",
        baseUrl: "https://proxy.example.com/v1",
        api: "openai-completions",
        apiKey: "proxy-secret",
        models: [{ id: "my-model", reasoning: true, contextWindow: 200_000, maxTokens: 32_768 }],
      },
    },
  }));
  writeFileSync(defaultsPath, JSON.stringify({ version: 1, managedChannels: ["my-proxy", "ghost"] }));

  const registered: Array<{ name: string; config: any }> = [];
  registerApiProviderConfigs({
    registerProvider(name: string, config: any) { registered.push({ name, config }); },
    registerCommand() {},
  } as any, { modelsPath, defaultsPath });

  assert.deepEqual(registered.map((entry) => entry.name), ["my-proxy"]);
  assert.equal(registered[0].config.api, "openai-completions");
  assert.equal(registered[0].config.name, "My Proxy");
  assert.equal(registered[0].config.models[0].id, "my-model");
});

test("/api-manager list shows custom channels without leaking API keys", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-custom-list-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const defaultsPath = join(tempDir, "api-manager.json");
  await saveApiProviderSettings({
    provider: "my-proxy",
    baseUrl: "https://proxy.example.com/v1",
    modelId: "my-model",
    reasoning: true,
    apiKey: "proxy-secret-must-not-be-shown",
    api: "openai-completions",
    name: "My Proxy",
  }, modelsPath);
  writeFileSync(defaultsPath, JSON.stringify({ version: 1, managedChannels: ["my-proxy"] }));

  const commands = new Map<string, any>();
  const notifications: string[] = [];
  registerApiProviderConfigs({
    registerProvider() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
  } as any, { modelsPath, defaultsPath });

  await commands.get("api-manager").handler("list", {
    cwd: tempDir,
    hasUI: false,
    ui: { notify(message: string) { notifications.push(message); } },
  });
  const output = notifications.at(-1) ?? "";
  assert.match(output, /自定义渠道：/);
  assert.match(output, /My Proxy（自定义·openai-completions·1）：my-model/);
  assert.doesNotMatch(output, /proxy-secret-must-not-be-shown/);
});

test("/api-manager delete removes a custom channel and its managed entry", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-custom-delete-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const defaultsPath = join(tempDir, "api-manager.json");
  await saveApiProviderSettings({
    provider: "my-proxy",
    baseUrl: "https://proxy.example.com/v1",
    modelId: "my-model",
    reasoning: true,
    apiKey: "proxy-secret",
    api: "openai-completions",
    name: "My Proxy",
  }, modelsPath);
  writeFileSync(defaultsPath, JSON.stringify({
    version: 1,
    managedChannels: ["my-proxy", "other-kept"],
    modelDefaults: { "my-proxy/my-model": "high" },
  }));

  const commands = new Map<string, any>();
  const unregistered: string[] = [];
  let refreshes = 0;
  registerApiProviderConfigs({
    registerProvider() {},
    unregisterProvider(name: string) { unregistered.push(name); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
  } as any, { modelsPath, defaultsPath });

  await commands.get("api-manager").handler("delete my-proxy", {
    cwd: tempDir,
    hasUI: true,
    modelRegistry: { refresh() { refreshes += 1; } },
    ui: {
      async confirm() { return true; },
      notify() {},
    },
  });

  const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.equal(saved.providers["my-proxy"], undefined);
  const defaults = JSON.parse(readFileSync(defaultsPath, "utf8"));
  assert.deepEqual(defaults.managedChannels, ["other-kept"]);
  assert.equal(defaults.modelDefaults["my-proxy/my-model"], undefined);
  assert.deepEqual(unregistered, ["my-proxy"]);
  assert.equal(refreshes, 1);
});

test("/api-manager leaves compat/headers unset on the auto path so pi detects xai from URL", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-custom-xai-auto-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const registrations: Array<{ name: string; config: any }> = [];
  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider(name: string, config: any) { registrations.push({ name, config }); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    setThinkingLevel() {},
  } as any, { modelsPath });

  const inputAnswers = [
    "grok-proxy",
    "Grok Proxy",
    "https://api.x.ai/v1",
    "grok-3",
    "131072",
    "32768",
    "xai-secret",
  ];
  const selectAnswers = [
    "openai-completions",
    "启用：off / minimal / low / medium / high / xhigh",
    "medium",
    "自动（按 URL 识别，推荐）",
    "自动（按 URL 识别）",
    "自动（按 URL 识别）",
  ];
  const confirmAnswers = [false, true];
  const command = commands.get("api-manager");
  await command.handler("set grok-proxy", {
    cwd: tempDir,
    hasUI: true,
    modelRegistry: {
      refresh() {},
      getAll() { return []; },
    },
    ui: {
      async input() { return inputAnswers.shift(); },
      async select() { return selectAnswers.shift(); },
      async confirm() { return confirmAnswers.shift(); },
      notify() {},
    },
  });

  const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  const custom = saved.providers["grok-proxy"];
  assert.equal(custom.api, "openai-completions");
  assert.equal(custom.baseUrl, "https://api.x.ai/v1");
  assert.equal("compat" in custom, false);
  assert.equal("headers" in custom, false);
  assert.equal("authHeader" in custom, false);
  assert.equal(custom.models[0].thinkingLevelMap.xhigh, "xhigh");
  assert.equal(registrations.at(-1)?.name, "grok-proxy");
  assert.equal("compat" in (registrations.at(-1)?.config ?? {}), false);
});

test("saveApiProviderSettings writes headers and authHeader, and registration passes them through", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-custom-headers-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const defaultsPath = join(tempDir, "api-manager.json");

  await saveApiProviderSettings({
    provider: "hdr-chan",
    baseUrl: "https://gateway.example.com/v1",
    modelId: "hdr-model",
    reasoning: false,
    apiKey: "hdr-secret",
    api: "openai-completions",
    name: "Header Channel",
    headers: { "X-Title": "pi", "HTTP-Referer": "https://pi.local" },
    authHeader: false,
    compat: { thinkingFormat: "zai" },
  }, modelsPath);

  const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  const chan = saved.providers["hdr-chan"];
  assert.deepEqual(chan.headers, { "X-Title": "pi", "HTTP-Referer": "https://pi.local" });
  assert.equal(chan.authHeader, false);
  assert.deepEqual(chan.compat, { thinkingFormat: "zai" });

  writeFileSync(defaultsPath, JSON.stringify({ version: 1, managedChannels: ["hdr-chan"] }));
  const registrations: Array<{ name: string; config: any }> = [];
  registerApiProviderConfigs({
    registerProvider(name: string, config: any) { registrations.push({ name, config }); },
    registerCommand() {},
  } as any, { modelsPath, defaultsPath });

  const registration = registrations.find((entry) => entry.name === "hdr-chan")?.config;
  assert.ok(registration);
  assert.deepEqual(registration.headers, { "X-Title": "pi", "HTTP-Referer": "https://pi.local" });
  assert.equal(registration.authHeader, false);
  assert.equal(registration.models[0].compat.thinkingFormat, "zai");
});
