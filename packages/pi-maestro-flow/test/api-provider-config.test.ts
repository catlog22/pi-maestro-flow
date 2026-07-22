import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getModels } from "@earendil-works/pi-ai";
import { AuthStorage } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { ModelRegistry } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js";
import {
  deleteApiProviderModelSettings,
  normalizeBaseUrl,
  registerApiProviderConfigs,
  saveApiProviderSettings,
} from "../src/providers/api-provider-config.ts";

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
  assert.deepEqual(registered[0].config, { name: "OpenAI Responses (Custom)" });
  assert.deepEqual(registered[1].config, { name: "Qwen Compatible (Custom)" });
  assert.deepEqual(registered[2].config, { name: "Anthropic (Custom)" });
  assert.equal(commands.size, 1);
  assert.ok(commands.has("api-manager"));
  assert.equal(commands.has("api-login"), false);

  assert.ok(getModels("openai").length > 0);
  assert.ok(getModels("openai").every((model) => model.api === "openai-responses"));
  assert.ok(getModels("anthropic").length > 0);
  assert.ok(getModels("anthropic").every((model) => model.api === "anthropic-messages"));
});

test("validates custom API base URLs", () => {
  assert.equal(normalizeBaseUrl(" https://gateway.example.com/v1/ "), "https://gateway.example.com/v1");
  assert.throws(() => normalizeBaseUrl("file:///tmp/api"), /http or https/);
  assert.throws(() => normalizeBaseUrl(""), /cannot be empty/);
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
  assert.deepEqual(qwen.models[0].thinkingLevelMap, { off: null, xhigh: "xhigh", max: "max" });
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

  const inputAnswers = ["https://proxy.example.com/v1/", "gpt-5.4", "openai-secret"];
  const selectAnswers = [
    "启用：minimal / low / medium / high / xhigh / max",
    "max",
  ];
  const selectOptions: string[][] = [];
  const notifications: Array<{ type: string; message: string }> = [];
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
      async confirm() {
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
  assert.equal(saved.providers["maestro-openai"].models[0].thinkingLevelMap.max, "max");
  assert.equal(saved.providers["maestro-openai"].apiKey, "openai-secret");
  const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"));
  assert.equal(settings.defaultProvider, "maestro-openai");
  assert.equal(settings.defaultModel, "gpt-5.4");
  assert.equal(settings.defaultThinkingLevel, "max");
  assert.deepEqual(appliedThinkingLevels, []);
  assert.ok(modelSelectHandler);
  await modelSelectHandler!({ model: { provider: "maestro-openai", id: "gpt-5.4" } });
  assert.deepEqual(appliedThinkingLevels, ["max"]);
  const defaults = JSON.parse(readFileSync(join(tempDir, "api-manager.json"), "utf8"));
  assert.equal(defaults.modelDefaults["maestro-openai/gpt-5.4"], "max");
  assert.ok(selectOptions[1]?.includes("max"));
  assert.doesNotMatch(selectOptions.flat().join("\n"), /环境变量|保留当前 API key/);
  assert.deepEqual(unregistered, []);
  assert.equal(registrations.length, 1);
  assert.deepEqual(registrations.at(-1), {
    name: "maestro-openai",
    config: { name: "OpenAI Responses (Custom)" },
  });
  assert.match(notifications.at(-1)?.message ?? "", /默认模型为 maestro-openai\/gpt-5\.4/);
  assert.equal(notifications.at(-1)?.type, "info");
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
  assert.equal(saved.providers["maestro-qwen"].models[0].thinkingLevelMap.max, "max");
  const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"));
  assert.equal(settings.defaultProvider, "maestro-qwen");
  assert.equal(settings.defaultModel, "qwen3.8-max-preview");
  assert.equal(settings.defaultThinkingLevel, "high");
  assert.ok(selectOptions[0]?.includes("启用：off / minimal / low / medium / high / xhigh / max"));
  assert.deepEqual(registrations.at(-1), {
    name: "maestro-qwen",
    config: { name: "Qwen Compatible (Custom)" },
  });
});

test("/api-manager rejects empty URL and API key instead of reusing current values", async (t) => {
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

  const emptyUrl = makeContext([""]);
  await command.handler("set openai", emptyUrl.ctx);
  let saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.equal(saved.providers["maestro-openai"].baseUrl, "https://old.example.com/v1");
  assert.equal(saved.providers["maestro-openai"].apiKey, "old-secret");
  assert.equal(emptyUrl.confirms, 0);
  assert.match(emptyUrl.notifications.at(-1)?.message ?? "", /Base URL cannot be empty/);

  const emptyKey = makeContext(
    ["https://new.example.com/v1", "gpt-new", ""],
    ["启用：minimal / low / medium / high / xhigh / max", "medium"],
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

test("models.json custom API settings preserve DeepSeek models", (t) => {
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
  const registry = ModelRegistry.create(authStorage, modelsPath);
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
  assert.equal(registry.getProviderDisplayName("maestro-openai"), "OpenAI Responses (Custom)");
  assert.equal(registry.getProviderDisplayName("maestro-anthropic"), "maestro-anthropic");

  const deepseekAfter = registry.getAll()
    .filter((model) => model.provider === "deepseek")
    .map((model) => ({ id: model.id, name: model.name }));
  assert.deepEqual(deepseekAfter, deepseekBefore);
  assert.ok(deepseekAfter.some((model) => model.id === "deepseek-v4-pro"));
});
