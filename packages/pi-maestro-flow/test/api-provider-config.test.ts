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
  loadApiProviderSettings,
  normalizeBaseUrl,
  registerApiProviderConfigs,
  saveApiProviderSettings,
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
  assert.equal(commands.size, 2);
  assert.ok(commands.has("api-manager"));
  assert.ok(commands.has("effort"));
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
  let rendered: string[] = [];
  await harness.command.handler("", {
    model: {
      provider: "maestro-openai",
      id: "gpt-5.4",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh" },
    },
    ui: {
      async select(_title: string, options: string[]) {
        rendered = options;
        return "high [████░]";
      },
      notify(message: string, type: string) { notifications.push({ message, type }); },
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
  assert.deepEqual(applied, ["high"]);
  assert.deepEqual(notifications.at(-1), { message: "思考强度已设为 high [████░]", type: "info" });
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
  const registry = ModelRegistry.create(AuthStorage.inMemory({
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

test("model_select restores canonical effort and never passes max", async (t) => {
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
  const harness = createEffortHarness({
    modelsPath: join(tempDir, "models.json"),
    defaultsPath,
    apply(level) { applied.push(level); },
  });
  assert.ok(harness.modelSelect);
  await harness.modelSelect!({ model: { provider: "maestro-openai", id: "gpt-5.4" } });
  await harness.modelSelect!({ model: { provider: "anthropic", id: "claude-sonnet" } });
  assert.deepEqual(applied, ["xhigh", "xhigh"]);
  assert.equal(applied.includes("max"), false);
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
