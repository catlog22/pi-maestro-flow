import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_RESERVE_TOKENS,
  DEFAULT_SOFT_COMPACTION,
} from "../src/compaction/compaction-settings.ts";
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
  setApiProviderEnabled,
} from "../src/providers/api-provider-config.ts";
import {
  applyCacheRetentionEnv,
  loadAgentCacheRetention,
  loadCacheRetentionSetting,
  loadPromptCachePolicy,
  promptCacheCompatFlags,
  PROMPT_CACHE_POLICY_DEFAULT,
  saveAgentCacheRetention,
  saveCacheRetentionSetting,
  savePromptCachePolicy,
  supportsOpenAIPromptCacheOptions,
} from "../src/providers/prompt-cache-policy.ts";

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

test("adds multiple models under one Provider and deletes only the selected model", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-multi-model-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const base = { provider: "maestro-openai" as const, baseUrl: "https://gateway.example.com/v1", apiKey: "secret" };
  await saveApiProviderSettings({ ...base, modelId: "model-a", reasoning: true }, modelsPath);
  await saveApiProviderSettings({ ...base, modelId: "model-b", reasoning: true }, modelsPath);
  let saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.deepEqual(saved.providers["maestro-openai"].models.map((model: any) => model.id), ["model-a", "model-b"]);
  assert.equal(saved.providers["maestro-openai"].apiKey, "secret");

  // Updating an existing model replaces it in place and keeps the sibling.
  await saveApiProviderSettings({ ...base, modelId: "model-a", reasoning: false }, modelsPath);
  saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.deepEqual(saved.providers["maestro-openai"].models.map((model: any) => model.id), ["model-a", "model-b"]);
  assert.equal(saved.providers["maestro-openai"].models[0].reasoning, false);
  assert.equal(saved.providers["maestro-openai"].models[1].reasoning, true);

  // Deleting one model keeps the Provider and its remaining model.
  await deleteApiProviderModelSettings("maestro-openai", "model-a", modelsPath);
  saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.deepEqual(saved.providers["maestro-openai"].models.map((model: any) => model.id), ["model-b"]);
  assert.equal(saved.providers["maestro-openai"].baseUrl, "https://gateway.example.com/v1");

  // Deleting the last model removes the Provider entirely.
  await deleteApiProviderModelSettings("maestro-openai", "model-b", modelsPath);
  saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.equal(saved.providers["maestro-openai"], undefined);
});

test("persists explicit multimodal capability and preserves it when omitted", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-multimodal-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const base = {
    provider: "maestro-openai" as const,
    baseUrl: "https://gateway.example.com/v1",
    apiKey: "secret",
  };

  await saveApiProviderSettings({
    ...base,
    modelId: "text-only",
    reasoning: true,
    multimodal: false,
  }, modelsPath);
  await saveApiProviderSettings({
    ...base,
    modelId: "vision",
    reasoning: true,
    multimodal: true,
  }, modelsPath);

  let saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.deepEqual(saved.providers["maestro-openai"].models[0].input, ["text"]);
  assert.deepEqual(saved.providers["maestro-openai"].models[1].input, ["text", "image"]);
  assert.equal((await loadApiProviderSettings("maestro-openai", modelsPath, "text-only")).multimodal, false);
  assert.equal((await loadApiProviderSettings("maestro-openai", modelsPath, "vision")).multimodal, true);

  await saveApiProviderSettings({
    ...base,
    modelId: "text-only",
    reasoning: false,
  }, modelsPath);
  saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.deepEqual(saved.providers["maestro-openai"].models[0].input, ["text"]);
});

test("keeps Providers flat when the same API format uses different URLs", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-flat-format-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const defaultsPath = join(tempDir, "api-manager.json");
  await saveApiProviderSettings({
    provider: "openai-east",
    api: "openai-completions",
    baseUrl: "https://east.example.com/v1",
    modelId: "model-east",
    reasoning: true,
    apiKey: "east-secret",
  }, modelsPath);
  await saveApiProviderSettings({
    provider: "openai-west",
    api: "openai-completions",
    baseUrl: "https://west.example.com/v1",
    modelId: "model-west-a",
    reasoning: true,
    apiKey: "west-secret",
  }, modelsPath);
  await saveApiProviderSettings({
    provider: "openai-west-b",
    api: "openai-completions",
    baseUrl: "https://west-b.example.com/v1",
    modelId: "model-west-b",
    reasoning: false,
    apiKey: "west-b-secret",
  }, modelsPath);
  writeFileSync(defaultsPath, JSON.stringify({
    version: 1,
    managedProviders: ["openai-east", "openai-west", "openai-west-b"],
  }));

  const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.deepEqual(Object.keys(saved.providers), ["openai-east", "openai-west", "openai-west-b"]);
  assert.equal(saved.providers["openai-east"].api, "openai-completions");
  assert.equal(saved.providers["openai-west"].api, "openai-completions");
  assert.equal(saved.providers["openai-west-b"].api, "openai-completions");
  assert.equal(saved.providers["openai-east"].baseUrl, "https://east.example.com/v1");
  assert.equal(saved.providers["openai-west"].baseUrl, "https://west.example.com/v1");
  assert.equal(saved.providers["openai-west-b"].baseUrl, "https://west-b.example.com/v1");
  assert.deepEqual(saved.providers["openai-west"].models.map((model: any) => model.id), ["model-west-a"]);
  assert.deepEqual(saved.providers["openai-west-b"].models.map((model: any) => model.id), ["model-west-b"]);

  const registered = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider(name: string, config: any) { registered.set(name, config); },
  } as any, { modelsPath, defaultsPath });
  assert.deepEqual([...registered.keys()], ["openai-east", "openai-west", "openai-west-b"]);
  assert.deepEqual(registered.get("openai-west")?.models.map((model: any) => model.id), ["model-west-a"]);
  assert.deepEqual(registered.get("openai-west-b")?.models.map((model: any) => model.id), ["model-west-b"]);
});

test("Provider enable/disable preserves config and controls runtime registration", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-enabled-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  await saveApiProviderSettings({
    provider: "maestro-openai",
    baseUrl: "https://gateway.example.com/v1",
    modelId: "model-a",
    reasoning: true,
    apiKey: "secret",
  }, modelsPath);
  await setApiProviderEnabled("maestro-openai", false, modelsPath);

  const registered: string[] = [];
  const unregistered: string[] = [];
  const commands = new Map<string, any>();
  let refreshes = 0;
  registerApiProviderConfigs({
    registerProvider(name: string) { registered.push(name); },
    unregisterProvider(name: string) { unregistered.push(name); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
  } as any, { modelsPath });
  assert.deepEqual(registered, []);

  const notifications: string[] = [];
  const ctx = {
    cwd: tempDir,
    hasUI: false,
    modelRegistry: { refresh() { refreshes += 1; } },
    ui: { notify(message: string) { notifications.push(message); } },
  };
  await commands.get("api-manager").handler("enable openai", ctx);
  assert.deepEqual(registered, ["maestro-openai"]);
  await commands.get("api-manager").handler("disable openai", ctx);
  assert.deepEqual(unregistered, ["maestro-openai"]);
  await commands.get("api-manager").handler("list", ctx);
  assert.match(notifications.at(-1) ?? "", /maestro-openai.*停用/);
  assert.equal(refreshes, 2);

  const saved = JSON.parse(readFileSync(modelsPath, "utf8")).providers["maestro-openai"];
  assert.equal(saved.enabled, false);
  assert.equal(saved.baseUrl, "https://gateway.example.com/v1");
  assert.equal(saved.apiKey, "secret");
  assert.deepEqual(saved.models.map((model: any) => model.id), ["model-a"]);
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

test("runtime registration warns on remote HTTP provider and model URLs but still accepts them", (t) => {
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

  assert.equal(registered.get("maestro-openai")?.baseUrl, "http://198.51.100.10:8080/v1");
  assert.deepEqual(
    registered.get("maestro-openai")?.models.map((model: any) => model.id),
    ["unsafe-provider-model"],
  );
  // Models stay under their Provider; model-level URL overrides are preserved on the model entry.
  assert.equal(registered.get("maestro-qwen")?.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.deepEqual(
    registered.get("maestro-qwen")?.models.map((model: any) => model.id),
    ["unsafe-model-override", "safe-model"],
  );
  assert.equal(
    registered.get("maestro-qwen")?.models.find((model: any) => model.id === "unsafe-model-override")?.baseUrl,
    "http://203.0.113.10:8080/v1",
  );
  assert.equal(registered.get("maestro-qwen--safe-model"), undefined);
});

test("API Manager retry defaults are enabled and preserve explicit overrides", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-retry-defaults-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const settingsPath = join(tempDir, "settings.json");

  assert.deepEqual(await loadApiRetrySettings(settingsPath), { enabled: true, maxRetries: 3 });
  await ensureApiRetryDefaults(settingsPath);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).retry, {
    enabled: true,
    maxRetries: 3,
    baseDelayMs: 2_000,
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
    maxRetries: 3,
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
    () => saveApiRetrySettings({ enabled: true, maxRetries: 11 }, settingsPath),
    /1-5/,
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
  assert.deepEqual(await loadApiRetrySettings(settingsPath), { enabled: true, maxRetries: 3 });

  const manager = commands.get("api-manager");
  await manager.handler("retry off", baseContext);
  assert.deepEqual(await loadApiRetrySettings(settingsPath), { enabled: false, maxRetries: 3 });
  await manager.handler("retry on 4", baseContext);
  assert.deepEqual(await loadApiRetrySettings(settingsPath), { enabled: true, maxRetries: 4 });
  await manager.handler("retry show", baseContext);
  assert.match(notifications.at(-1) ?? "", /Provider 自动重试：开启/);
  assert.match(notifications.at(-1) ?? "", /最大重试次数：4/);

  const selections = ["自动重试", "关闭"];
  await manager.handler("", {
    ...baseContext,
    hasUI: true,
    ui: {
      async select(_title: string, options: string[]) {
        const wanted = selections.shift();
        return options.find((option) => option === wanted || option.startsWith(wanted));
      },
      async input() { throw new Error("disabled retry must not request a count"); },
      async confirm() { return true; },
      notify(message: string) { notifications.push(message); },
    },
  });
  assert.deepEqual(await loadApiRetrySettings(settingsPath), { enabled: false, maxRetries: 4 });

  const enableSelections = ["自动重试", "开启"];
  await manager.handler("", {
    ...baseContext,
    hasUI: true,
    ui: {
      async select(_title: string, options: string[]) {
        const wanted = enableSelections.shift();
        return options.find((option) => option === wanted || option.startsWith(wanted));
      },
      async input() { return "5"; },
      async confirm() { return true; },
      notify(message: string) { notifications.push(message); },
    },
  });
  assert.deepEqual(await loadApiRetrySettings(settingsPath), { enabled: true, maxRetries: 5 });
});

test("prompt-cache detection gates on gpt-5.6 and later only", () => {
  for (const supported of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-chat-latest", "gpt-6", "gpt-6.1"]) {
    assert.equal(supportsOpenAIPromptCacheOptions(supported), true, supported);
  }
  for (const unsupported of ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5", "gpt-4.1", "o3", "o4-mini", "deepseek-v4-flash", "qwen3.8-max-preview", "claude-opus-4-6", ""] as const) {
    assert.equal(supportsOpenAIPromptCacheOptions(unsupported), false, unsupported);
  }
});

test("prompt-cache policy maps to pi compat flags", () => {
  assert.deepEqual(promptCacheCompatFlags("off", "gpt-5.6-sol"), { supportsExplicitPromptCacheMode: false, supportsLongCacheRetention: false });
  assert.deepEqual(promptCacheCompatFlags("on", "gpt-5.5"), { supportsExplicitPromptCacheMode: true, supportsLongCacheRetention: true });
  assert.deepEqual(promptCacheCompatFlags("auto", "gpt-5.6-sol"), { supportsExplicitPromptCacheMode: true, supportsLongCacheRetention: true });
  assert.deepEqual(promptCacheCompatFlags("auto", "gpt-5.5"), { supportsExplicitPromptCacheMode: false, supportsLongCacheRetention: false });
  assert.deepEqual(promptCacheCompatFlags("auto", "deepseek-v4-flash"), { supportsExplicitPromptCacheMode: false, supportsLongCacheRetention: false });
});

test("prompt-cache policy persists to settings.json and defaults to off", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-prompt-cache-policy-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const settingsPath = join(tempDir, "settings.json");
  assert.equal(PROMPT_CACHE_POLICY_DEFAULT, "off");
  assert.equal(await loadPromptCachePolicy(settingsPath), "off");
  await savePromptCachePolicy("auto", settingsPath);
  assert.equal(await loadPromptCachePolicy(settingsPath), "auto");
  await savePromptCachePolicy("on", settingsPath);
  assert.equal(await loadPromptCachePolicy(settingsPath), "on");
  await assert.rejects(() => savePromptCachePolicy("always" as never, settingsPath), /Invalid prompt cache policy/);
  assert.equal(await loadPromptCachePolicy(settingsPath), "on", "invalid save must not corrupt the stored policy");
});

test("registration injects prompt-cache compat flags per policy and API format", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-prompt-cache-register-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const settingsPath = join(tempDir, "settings.json");
  await saveApiProviderSettings({
    provider: "maestro-openai",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-5.6-sol",
    reasoning: true,
    apiKey: "sk-a",
  }, modelsPath);
  await saveApiProviderSettings({
    provider: "maestro-qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    modelId: "deepseek-v4-flash",
    reasoning: true,
    apiKey: "sk-b",
  }, modelsPath);
  await saveApiProviderSettings({
    provider: "maestro-anthropic",
    baseUrl: "https://api.anthropic.com",
    modelId: "claude-sonnet-4-5",
    reasoning: true,
    apiKey: "sk-c",
  }, modelsPath);

  const capture = () => {
    const registered: Array<{ name: string; config: any }> = [];
    registerApiProviderConfigs({
      registerProvider(name: string, config: any) { registered.push({ name, config }); },
      registerCommand() {},
    } as any, { modelsPath, settingsPath });
    return registered;
  };

  // auto: gpt-5.6-sol advertises the flags; non-5.6 OpenAI-format models and
  // Anthropic-format models (separate cache_control mechanism) do not.
  await savePromptCachePolicy("auto", settingsPath);
  let registered = capture();
  let openai = registered.find((entry) => entry.name === "maestro-openai")!.config.models[0];
  assert.equal(openai.compat.supportsExplicitPromptCacheMode, true);
  assert.equal(openai.compat.supportsLongCacheRetention, true);
  let qwen = registered.find((entry) => entry.name === "maestro-qwen")!.config.models[0];
  assert.equal(qwen.compat.supportsExplicitPromptCacheMode, false);
  assert.equal(qwen.compat.supportsLongCacheRetention, false);
  let anthropic = registered.find((entry) => entry.name === "maestro-anthropic")!.config.models[0];
  assert.equal(anthropic.compat?.supportsExplicitPromptCacheMode, undefined);

  // off: even gpt-5.6 models stop advertising the flags (prompt_cache_options never sent).
  await savePromptCachePolicy("off", settingsPath);
  registered = capture();
  openai = registered.find((entry) => entry.name === "maestro-openai")!.config.models[0];
  assert.equal(openai.compat.supportsExplicitPromptCacheMode, false);
  assert.equal(openai.compat.supportsLongCacheRetention, false);

  // on: non-5.6 OpenAI-format models advertise them too (admin opt-in).
  await savePromptCachePolicy("on", settingsPath);
  registered = capture();
  qwen = registered.find((entry) => entry.name === "maestro-qwen")!.config.models[0];
  assert.equal(qwen.compat.supportsExplicitPromptCacheMode, true);
  assert.equal(qwen.compat.supportsLongCacheRetention, true);
});

test("/api-manager manages prompt-cache policy from commands and the interactive menu", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-cache-command-"));
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
  assert.equal(await loadPromptCachePolicy(settingsPath), "off");

  const manager = commands.get("api-manager");
  await manager.handler("cache auto", baseContext);
  assert.equal(await loadPromptCachePolicy(settingsPath), "auto");
  await manager.handler("cache on", baseContext);
  assert.equal(await loadPromptCachePolicy(settingsPath), "on");
  await manager.handler("cache show", baseContext);
  assert.match(notifications.at(-1) ?? "", /提示缓存策略：on（始终发送）/);
  await manager.handler("cache off", baseContext);
  assert.equal(await loadPromptCachePolicy(settingsPath), "off");

  const selections = ["提示缓存策略", "auto"];
  await manager.handler("", {
    ...baseContext,
    hasUI: true,
    ui: {
      async select(_title: string, options: string[]) {
        const wanted = selections.shift();
        return options.find((option) => option === wanted || option.startsWith(wanted));
      },
      async confirm() { return true; },
      notify(message: string) { notifications.push(message); },
    },
  });
  assert.equal(await loadPromptCachePolicy(settingsPath), "auto");
});

test("cache tiers persist to settings.json and apply to process env", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-cache-tiers-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const settingsPath = join(tempDir, "settings.json");
  const savedMain = process.env.PI_CACHE_RETENTION;
  const savedAgent = process.env.PI_TEAMMATE_CACHE_RETENTION;
  t.after(() => {
    if (savedMain === undefined) delete process.env.PI_CACHE_RETENTION;
    else process.env.PI_CACHE_RETENTION = savedMain;
    if (savedAgent === undefined) delete process.env.PI_TEAMMATE_CACHE_RETENTION;
    else process.env.PI_TEAMMATE_CACHE_RETENTION = savedAgent;
  });

  assert.equal(await loadCacheRetentionSetting(settingsPath), "auto");
  assert.equal(await loadAgentCacheRetention(settingsPath), "short");

  // auto leaves an existing main env untouched, but still pins the agent tier.
  process.env.PI_CACHE_RETENTION = "long";
  await saveCacheRetentionSetting("auto", settingsPath);
  await saveAgentCacheRetention("none", settingsPath);
  applyCacheRetentionEnv(settingsPath);
  assert.equal(process.env.PI_CACHE_RETENTION, "long", "auto must keep the user-set env");
  assert.equal(process.env.PI_TEAMMATE_CACHE_RETENTION, "none");

  // Explicit main tier overrides the env.
  await saveCacheRetentionSetting("long", settingsPath);
  applyCacheRetentionEnv(settingsPath);
  assert.equal(process.env.PI_CACHE_RETENTION, "long");
  await saveCacheRetentionSetting("short", settingsPath);
  applyCacheRetentionEnv(settingsPath);
  assert.equal(process.env.PI_CACHE_RETENTION, "short");
  assert.equal(await loadCacheRetentionSetting(settingsPath), "short");
  assert.equal(await loadAgentCacheRetention(settingsPath), "none");
});

test("/api-manager manages agent cache tier from commands and the interactive menu", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-cache-agent-"));
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
  assert.equal(await loadAgentCacheRetention(settingsPath), "short");

  const manager = commands.get("api-manager");
  await manager.handler("cache agent long", baseContext);
  assert.equal(await loadAgentCacheRetention(settingsPath), "long");
  await manager.handler("cache agent show", baseContext);
  assert.match(notifications.at(-1) ?? "", /Agent 缓存档位：long（1h \/ 24h）/);
  await manager.handler("cache agent none", baseContext);
  assert.equal(await loadAgentCacheRetention(settingsPath), "none");
  await manager.handler("cache agent short", baseContext);
  assert.equal(await loadAgentCacheRetention(settingsPath), "short");

  const selections = ["Agent 缓存档位", "long"];
  await manager.handler("", {
    ...baseContext,
    hasUI: true,
    ui: {
      async select(_title: string, options: string[]) {
        const wanted = selections.shift();
        return options.find((option) => option === wanted || option.startsWith(wanted));
      },
      async confirm() { return true; },
      notify(message: string) { notifications.push(message); },
    },
  });
  assert.equal(await loadAgentCacheRetention(settingsPath), "long");
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
  assert.equal(normalizeBaseUrl("http://198.51.100.10:8080/v1"), "http://198.51.100.10:8080/v1");
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

  qwen.compat.openRouterRouting = { allow_fallbacks: false };
  qwen.compat.unknownForwardOption = "keep";
  writeFileSync(modelsPath, JSON.stringify(saved));
  await saveApiProviderSettings({
    provider: "maestro-qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    modelId: "qwen3.8-max-preview",
    reasoning: true,
    apiKey: "qwen-secret",
    maxThinking: true,
  }, modelsPath);
  const updatedCompat = JSON.parse(readFileSync(modelsPath, "utf8")).providers["maestro-qwen"].compat;
  assert.deepEqual(updatedCompat, {
    supportsDeveloperRole: false,
    thinkingFormat: "qwen",
    openRouterRouting: { allow_fallbacks: false },
    unknownForwardOption: "keep",
  });
});

test("/api-manager creates or updates URL, model, reasoning, and API key", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-login-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const projectSettingsPath = join(tempDir, ".pi", "settings.json");
  mkdirSync(dirname(projectSettingsPath), { recursive: true });
  writeFileSync(projectSettingsPath, JSON.stringify({
    compaction: {
      enabled: true,
      reserveTokens: DEFAULT_RESERVE_TOKENS,
      keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
      soft: DEFAULT_SOFT_COMPACTION,
    },
  }));
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
    "启用：支持图片输入",
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
  // Configuring a model must not overwrite the global thinking fallback; the selected
  // level is persisted per model (api-manager.json modelDefaults, asserted below).
  assert.equal(settings.defaultThinkingLevel, undefined);
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
  assert.equal(registrations.at(-1)?.name, "maestro-openai");
  assert.equal(registrations.at(-1)?.config.name, undefined);
  assert.equal(registrations.at(-1)?.config.models[0].id, "gpt-5.4");
  assert.match(confirmations[0] ?? "", /上下文窗口 contextWindow：400,000 Token/);
  assert.match(confirmations[0] ?? "", /单次最大输出 maxTokens：128,000 Token/);
  assert.match(confirmations[0] ?? "", /预计实际硬压缩：上下文超过 360,000 Token/);
  assert.match(confirmations[0] ?? "", /受上下文窗口 5% 安全底线下调/);
  assert.doesNotMatch(confirmations[0] ?? "", /软提醒不可达|软裁剪/);
  assert.match(notifications.at(-1)?.message ?? "", /已保存 1 个模型：maestro-openai\/gpt-5\.4/);
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
  await saveApiProviderSettings({
    provider: "maestro-openai--model-b",
    api: "openai-responses",
    baseUrl: "https://model-b.example.com/v1",
    apiKey: "model-b-secret",
    modelId: "model-b",
    contextWindow: 222_000,
    maxTokens: 48_000,
    reasoning: true,
  }, modelsPath);
  const before = JSON.parse(readFileSync(modelsPath, "utf8"));
  const modelBBefore = before.providers["maestro-openai--model-b"];

  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider() {},
    unregisterProvider() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
    setThinkingLevel() {},
  } as any, { modelsPath });
  const inputs = ["https://gateway.example.com/v1", "model-a", "333000", "64000", "openai-secret"];
  const selections = ["model-a", "关闭：仅 off", "off", "启用：支持图片输入"];
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
  assert.equal(openai.models[0].id, "model-a");
  assert.equal(openai.models[0].contextWindow, 333_000);
  assert.equal(openai.models[0].maxTokens, 64_000);
  assert.equal(openai.models[0].reasoning, false);
  assert.equal(openai.models[0].thinkingLevelMap, undefined);
  assert.deepEqual(saved.providers["maestro-openai--model-b"], modelBBefore);
  assert.deepEqual(rendered[0], ["model-a", "➕ 新增模型…"]);
  assert.match(confirmations[0] ?? "", /API format：OpenAI Responses \(openai-responses\)/);
  assert.doesNotMatch(confirmations[0] ?? "", /其余 .*model|同时用于/);
});

test("/api-manager form preloads an existing model and preserves its API key", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-form-edit-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  await saveApiProviderSettings({
    provider: "maestro-openai",
    baseUrl: "https://existing.example.com/v1",
    modelId: "existing-model",
    contextWindow: 333_000,
    maxTokens: 64_000,
    reasoning: true,
    apiKey: "existing-secret-must-stay",
  }, modelsPath);

  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
    setThinkingLevel() {},
  } as any, { modelsPath });
  let form = "";
  await commands.get("api-manager").handler("set openai", {
    cwd: tempDir,
    hasUI: true,
    modelRegistry: {
      refresh() {},
      getAll() { return [{ thinkingLevelMap: { xhigh: "max" } }]; },
    },
    ui: {
      async select(_title: string, options: string[]) {
        assert.deepEqual(options, ["existing-model", "➕ 新增模型…"]);
        return "existing-model";
      },
      async custom(factory: any) {
        const overlay = factory(
          { requestRender() {} },
          { fg: (_role: string, text: string) => text, bold: (text: string) => text },
          {},
          () => undefined,
        );
        form = overlay.render(120).join("\n");
        return {
          values: {
            provider: "maestro-openai",
            api: "openai-responses",
            baseUrl: "https://existing.example.com/v1",
            modelId: "attempted-rename",
            reasoning: true,
            defaultThinking: "medium",
            contextWindow: "333000",
            maxTokens: "96000",
            apiKey: "existing-secret-must-stay",
          },
        };
      },
      async confirm() { return true; },
      notify() {},
    },
  });

  assert.match(form, /https:\/\/existing\.example\.com\/v1/);
  assert.match(form, /existing-model/);
  assert.match(form, /333000/);
  assert.match(form, /64000/);
  assert.doesNotMatch(form, /existing-secret-must-stay/);
  const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  const provider = saved.providers["maestro-openai"];
  assert.equal(provider.models[0].maxTokens, 96_000);
  assert.equal(provider.models[0].contextWindow, 333_000);
  assert.equal(provider.models[0].id, "existing-model");
  assert.equal(provider.models.length, 1);
  assert.equal(provider.models[0].thinkingLevelMap.xhigh, "xhigh");
  assert.equal(provider.apiKey, "existing-secret-must-stay");
});

test("/api-manager form reconciles an incompatible global thinking default", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-form-thinking-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  await saveApiProviderSettings({
    provider: "maestro-openai",
    baseUrl: "https://existing.example.com/v1",
    modelId: "non-reasoning-model",
    reasoning: false,
    apiKey: "existing-secret",
  }, modelsPath);

  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
    setThinkingLevel() {},
  } as any, { modelsPath });
  let rendered = "";
  await commands.get("api-manager").handler("set openai", {
    cwd: tempDir,
    hasUI: true,
    modelRegistry: { refresh() {}, getAll() { return []; } },
    ui: {
      async select() { return "non-reasoning-model"; },
      async custom(factory: any) {
        return await new Promise((resolve) => {
          const overlay = factory(
            { requestRender() {} },
            { fg: (_role: string, text: string) => text, bold: (text: string) => text },
            {},
            resolve,
          );
          rendered = overlay.render(120).join("\n");
          overlay.handleInput("\x13");
        });
      },
      async confirm() { return true; },
      notify() {},
    },
  });

  assert.match(rendered, /默认思考强度\s+off/);
  const defaults = JSON.parse(readFileSync(join(tempDir, "api-manager.json"), "utf8"));
  assert.equal(defaults.modelDefaults["maestro-openai/non-reasoning-model"], "off");
});

test("loadApiProviderSettings returns advanced user-defined Provider form parameters", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-form-advanced-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  await saveApiProviderSettings({
    provider: "advanced-proxy",
    name: "Advanced Proxy",
    api: "openai-completions",
    baseUrl: "https://advanced.example.com/v1",
    modelId: "advanced-model",
    contextWindow: 200_000,
    maxTokens: 32_000,
    reasoning: true,
    apiKey: "advanced-secret",
    compat: { thinkingFormat: "deepseek", supportsDeveloperRole: false, unknownFlag: "keep" },
    headers: { "X-Title": "pi", "X-Custom": "value" },
    authHeader: false,
  }, modelsPath);

  const loaded = await loadApiProviderSettings("advanced-proxy", modelsPath, "advanced-model");
  assert.equal(loaded.name, "Advanced Proxy");
  assert.equal(loaded.api, "openai-completions");
  assert.deepEqual(loaded.compat, {
    thinkingFormat: "deepseek",
    supportsDeveloperRole: false,
    unknownFlag: "keep",
  });
  assert.deepEqual(loaded.headers, { "X-Title": "pi", "X-Custom": "value" });
  assert.equal(loaded.authHeader, false);

  await saveApiProviderSettings({
    provider: "advanced-proxy--sibling-model",
    baseUrl: "https://advanced.example.com/v1",
    modelId: "sibling-model",
    reasoning: false,
    apiKey: "advanced-secret",
    api: "openai-completions",
    name: "Sibling Model",
  }, modelsPath);
  let providers = JSON.parse(readFileSync(modelsPath, "utf8")).providers;
  assert.deepEqual(providers["advanced-proxy"].compat, {
    thinkingFormat: "deepseek",
    supportsDeveloperRole: false,
    unknownFlag: "keep",
  });
  assert.deepEqual(providers["advanced-proxy"].headers, { "X-Title": "pi", "X-Custom": "value" });
  assert.equal(providers["advanced-proxy"].authHeader, false);
  assert.equal(providers["advanced-proxy--sibling-model"].models[0].id, "sibling-model");

  await saveApiProviderSettings({
    provider: "advanced-proxy--sibling-model",
    baseUrl: "https://advanced.example.com/v1",
    modelId: "sibling-model",
    reasoning: false,
    apiKey: "advanced-secret",
    api: "openai-completions",
    name: "Sibling Model",
    replaceProviderOptions: true,
  }, modelsPath);
  providers = JSON.parse(readFileSync(modelsPath, "utf8")).providers;
  assert.equal("compat" in providers["advanced-proxy--sibling-model"], false);
  assert.equal("headers" in providers["advanced-proxy--sibling-model"], false);
  assert.equal("authHeader" in providers["advanced-proxy--sibling-model"], false);
  assert.deepEqual(providers["advanced-proxy"].compat, {
    thinkingFormat: "deepseek",
    supportsDeveloperRole: false,
    unknownFlag: "keep",
  });
  assert.deepEqual(providers["advanced-proxy"].headers, { "X-Title": "pi", "X-Custom": "value" });
});

test("/api-manager custom form preserves advanced parameters and unknown compat fields", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-custom-form-edit-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const defaultsPath = join(tempDir, "api-manager.json");
  await saveApiProviderSettings({
    provider: "advanced-proxy",
    name: "Advanced Proxy",
    api: "openai-completions",
    baseUrl: "https://advanced.example.com/v1",
    modelId: "advanced-model",
    contextWindow: 200_000,
    maxTokens: 32_000,
    reasoning: true,
    apiKey: "advanced-secret-must-stay",
    compat: { thinkingFormat: "deepseek", supportsDeveloperRole: false, unknownFlag: "keep" },
    headers: { "X-Title": "pi" },
    authHeader: false,
  }, modelsPath);

  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
    setThinkingLevel() {},
  } as any, { modelsPath, defaultsPath });
  await commands.get("api-manager").handler("set advanced-proxy", {
    cwd: tempDir,
    hasUI: true,
    modelRegistry: { refresh() {}, getAll() { return []; } },
    ui: {
      async input(_title: string, initial: string) {
        assert.equal(initial, "advanced-proxy");
        return initial;
      },
      async select(_title: string, options: string[]) {
        assert.deepEqual(options, ["advanced-model", "➕ 新增模型…"]);
        return "advanced-model";
      },
      async custom() {
        return {
          values: {
            provider: "advanced-proxy",
            api: "openai-completions",
            name: "Advanced Proxy",
            baseUrl: "https://advanced.example.com/v1",
            modelId: "attempted-custom-rename",
            reasoning: true,
            defaultThinking: "medium",
            contextWindow: "200000",
            maxTokens: "48000",
            thinkingFormat: "deepseek",
            supportsDeveloperRole: "false",
            supportsReasoningEffort: "true",
            maxTokensField: "",
            headers: "{\"X-Title\":\"pi\"}",
            authHeader: "false",
            apiKey: "advanced-secret-must-stay",
          },
        };
      },
      async confirm() { return true; },
      notify() {},
    },
  });

  const saved = JSON.parse(readFileSync(modelsPath, "utf8")).providers["advanced-proxy"];
  assert.equal(saved.apiKey, "advanced-secret-must-stay");
  assert.equal(saved.models[0].maxTokens, 48_000);
  assert.equal(saved.models[0].id, "advanced-model");
  assert.equal(saved.models.length, 1);
  assert.deepEqual(saved.compat, {
    thinkingFormat: "deepseek",
    supportsDeveloperRole: false,
    unknownFlag: "keep",
    supportsReasoningEffort: true,
  });
  assert.deepEqual(saved.headers, { "X-Title": "pi" });
  assert.equal(saved.models[0].compat, undefined);
  assert.equal(saved.models[0].headers, undefined);
  assert.equal(saved.authHeader, false);
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
      notify(message: string) { notifications.push(message); },
    },
  });

  const output = notifications.at(-1) ?? "";
  assert.match(output, /API format：Anthropic Messages \(anthropic-messages\)/);
  assert.match(output, /Model：claude-b/);
  assert.match(output, /上下文窗口 contextWindow：250,000 Token/);
  assert.match(output, /单次最大输出 maxTokens：64,000 Token/);
  assert.match(output, /Reasoning：disabled/);
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
    "启用：支持图片输入",
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
  // Global defaultThinkingLevel is only a fallback; configuring a model leaves it untouched.
  assert.equal(settings.defaultThinkingLevel, undefined);
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
  assert.match(notifications.at(-1) ?? "", /maestro-openai\/gpt-private · format: OpenAI Responses \(openai-responses\)/);
  assert.match(notifications.at(-1) ?? "", /Anthropic Messages）· 未配置/);
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

test("/effort renders canonical capability order with current marker", async (t) => {
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
        return "high";
      },
      notify(message: string, type: string) { notifications.push({ message, type }); },
      setStatus(key: string, value: string | undefined) { statuses.push({ key, value }); },
    },
  });

  assert.deepEqual(rendered, [
    "off",
    "minimal",
    "low",
    "medium（当前）",
    "high",
    "xhigh",
  ]);
  assert.equal(title, "选择思考强度（当前：medium）");
  assert.deepEqual(applied, ["high"]);
  assert.deepEqual(notifications.at(-1), { message: "思考强度已设为 high", type: "info" });
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
  assert.deepEqual(rendered, ["low", "medium（当前）", "high"]);
});

test("/effort offers max when the model maps a max wire value", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-effort-max-level-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const harness = createEffortHarness({
    modelsPath: join(tempDir, "models.json"),
    defaultsPath: join(tempDir, "api-manager.json"),
  });
  let rendered: string[] = [];
  await harness.command.handler("", {
    model: {
      provider: "maestro-qwen",
      id: "qwen3.8-max-preview",
      reasoning: true,
      thinkingLevelMap: { off: null, xhigh: "max" },
    },
    ui: {
      async select(_title: string, options: string[]) {
        rendered = options;
        return undefined;
      },
      notify() {},
    },
  });
  assert.ok(rendered.includes("max"));
  assert.equal(rendered.at(-1), "max");
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
    "high",
  );
  await invoke(
    { provider: "anthropic", id: "claude-sonnet", reasoning: true, thinkingLevelMap: { xhigh: "high" } },
    "xhigh",
  );
  await invoke(
    { provider: "team", id: "a/b", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
    "low",
  );
  await invoke(
    { provider: "team/a", id: "b", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
    "high",
  );

  const defaults = JSON.parse(readFileSync(defaultsPath, "utf8"));
  assert.equal(defaults.modelDefaults["maestro-openai/gpt-5.4"], "high");
  assert.equal(defaults.modelDefaults["anthropic/claude-sonnet"], "xhigh");
  assert.equal(defaults.modelDefaults["team/a%2Fb"], "low");
  assert.equal(defaults.modelDefaults["team%2Fa/b"], "high");
  assert.equal(defaults.modelDefaults["team/a/b"], undefined);
  assert.deepEqual(applied, ["high", "xhigh", "low", "high"]);
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
    // Unified prompt-cache policy (default off) pins the compat flags pi-ai
    // turns into prompt_cache_options / prompt_cache_retention request params.
    supportsExplicitPromptCacheMode: false,
    supportsLongCacheRetention: false,
  });
  assert.equal(live.thinkingLevelMap?.xhigh, "max");
  assert.equal("max" in (live.thinkingLevelMap ?? {}), false);
  const request = await registry.getApiKeyAndHeaders(live);
  assert.equal(request.ok, true);
  assert.deepEqual(request.headers, { "X-Provider": "qwen", "X-Model": "qwen-max" });

  await harness.command.handler("", {
    model: live,
    ui: {
      async select() { return "xhigh（当前）"; },
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
      async select() { return "high"; },
      notify(message: string, type: string) { notifications.push({ message, type }); },
    },
  });
  assert.deepEqual(readFileSync(defaultsPath), before);
  assert.deepEqual(applied, []);
  assert.equal(notifications.at(-1)?.type, "error");
  assert.match(notifications.at(-1)?.message ?? "", /^思考强度保存失败：/);
});

test("model_select restores canonical effort, synchronizes the status, and passes max through", async (t) => {
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
  assert.deepEqual(applied, ["max", "max"]);
  assert.equal(applied.includes("max"), true);
  assert.deepEqual(statuses, [
    { key: "maestro-effort", value: "max" },
    { key: "maestro-effort", value: "max" },
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
    ui: { async select() { return "high"; }, notify() {} },
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
      async select() { return "high"; },
      notify(message: string, type: string) { notifications.push({ message, type }); },
    },
  });
  const defaults = JSON.parse(readFileSync(defaultsPath, "utf8"));
  assert.equal(defaults.modelDefaults["openai/gpt"], "high");
  assert.equal(notifications.at(-1)?.type, "error");
  assert.match(notifications.at(-1)?.message ?? "", /^思考强度应用失败：/);
  assert.equal(notifications.some((entry) => entry.message.startsWith("思考强度已设为")), false);
});

test("saveApiProviderSettings stores explicit api, compat, and name for a user-defined Provider", async (t) => {
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
  // Provider is the model identity, so api/compat live on the single-model Provider.
  assert.deepEqual(custom.compat, { supportsDeveloperRole: false, thinkingFormat: "qwen" });
  assert.equal(custom.models[0].id, "my-model");
  assert.equal(custom.models[0].api, undefined);
  assert.equal(custom.models[0].compat, undefined);
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

test("/api-manager creates a user-defined Provider with a free-form id and chosen format", async (t) => {
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
    "启用：支持图片输入",
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
  assert.equal(custom.models[0].compat, undefined);
  assert.equal(custom.models[0].headers, undefined);
  assert.equal(custom.authHeader, true);
  assert.equal(custom.models[0].id, "my-model");
  assert.equal(custom.models[0].contextWindow, 200_000);
  assert.equal(custom.models[0].maxTokens, 32_768);
  assert.equal(custom.models[0].reasoning, true);
  assert.equal(custom.models[0].thinkingLevelMap.xhigh, "max");

  const defaults = JSON.parse(readFileSync(join(tempDir, "api-manager.json"), "utf8"));
  assert.deepEqual(defaults.managedProviders, ["my-proxy"]);
  assert.equal(defaults.modelDefaults["my-proxy/my-model"], "high");

  const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"));
  assert.equal(settings.defaultProvider, "my-proxy");
  assert.equal(settings.defaultModel, "my-model");

  assert.equal(registrations.at(-1)?.name, "my-proxy");
  assert.equal(registrations.at(-1)?.config.api, "openai-completions");
  assert.equal(registrations.at(-1)?.config.name, "My Proxy");
  assert.deepEqual(registrations.at(-1)?.config.headers, { "X-Custom": "custom-val" });
  assert.equal(registrations.at(-1)?.config.models[0].headers, undefined);
  assert.equal(registrations.at(-1)?.config.authHeader, true);
  assert.equal(registrations.at(-1)?.config.models[0].compat.thinkingFormat, "deepseek");
  assert.equal(registrations.at(-1)?.config.models[0].id, "my-model");
  assert.match(notifications.at(-1)?.message ?? "", /已保存 1 个模型：my-proxy\/my-model/);
});

test("startup registers legacy managedChannels entries as user-defined Providers", async (t) => {
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

test("/api-manager list shows flat user-defined Providers without leaking API keys", async (t) => {
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
  assert.match(output, /API 模型（平铺展示）：/);
  assert.match(output, /my-proxy\/my-model · format: OpenAI Chat Completions \(openai-completions\)/);
  assert.match(output, /my-proxy（My Proxy · 用户定义） · 启用 · format: OpenAI Chat Completions \(openai-completions\)/);
  assert.doesNotMatch(output, /proxy-secret-must-not-be-shown/);
});

test("/api-manager delete removes a user-defined Provider and migrates its managed entry", async (t) => {
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
    managedProviders: ["new-kept", "my-proxy"],
    managedChannels: ["my-proxy", "old-kept"],
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
  assert.deepEqual(defaults.managedProviders, ["new-kept", "old-kept"]);
  assert.equal(defaults.managedChannels, undefined);
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
    "启用：支持图片输入",
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
  assert.deepEqual(chan.compat, { thinkingFormat: "zai" });
  assert.equal(chan.authHeader, false);
  assert.equal(chan.models[0].headers, undefined);
  assert.equal(chan.models[0].compat, undefined);

  writeFileSync(defaultsPath, JSON.stringify({ version: 1, managedChannels: ["hdr-chan"] }));
  const registrations: Array<{ name: string; config: any }> = [];
  registerApiProviderConfigs({
    registerProvider(name: string, config: any) { registrations.push({ name, config }); },
    registerCommand() {},
  } as any, { modelsPath, defaultsPath });

  const registration = registrations.find((entry) => entry.name === "hdr-chan")?.config;
  assert.ok(registration);
  assert.deepEqual(registration.headers, { "X-Title": "pi", "HTTP-Referer": "https://pi.local" });
  assert.equal(registration.models[0].headers, undefined);
  assert.equal(registration.authHeader, false);
  assert.equal(registration.models[0].compat.thinkingFormat, "zai");
});

test("startup keeps multiple models under one Provider and preserves model defaults", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-multi-startup-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const defaultsPath = join(tempDir, "api-manager.json");
  const settingsPath = join(tempDir, "settings.json");
  const modelsBytes = JSON.stringify({
    providers: {
      "maestro-qwen": {
        baseUrl: "https://opencode.ai/zen/go/v1",
        api: "openai-completions",
        apiKey: "shared-secret",
        authHeader: false,
        compat: { supportsDeveloperRole: false, thinkingFormat: "qwen" },
        models: [
          { id: "qwen3.8-max-preview", reasoning: true, contextWindow: 400_000, maxTokens: 128_000 },
          { id: "deepseek-v4-flash", reasoning: true, contextWindow: 600_000, maxTokens: 128_000, compat: {} },
        ],
      },
      untouched: {
        baseUrl: "https://untouched.example.com/v1",
        api: "openai-completions",
        models: [{ id: "untouched-model", reasoning: false, contextWindow: 32_000, maxTokens: 4_096 }],
      },
    },
  });
  const defaultsBytes = JSON.stringify({
    version: 1,
    modelDefaults: {
      "maestro-qwen/qwen3.8-max-preview": "high",
      "maestro-qwen/deepseek-v4-flash": "medium",
    },
  });
  const settingsBytes = JSON.stringify({
    defaultProvider: "maestro-qwen",
    defaultModel: "deepseek-v4-flash",
    defaultThinkingLevel: "high",
  });
  writeFileSync(modelsPath, modelsBytes);
  writeFileSync(defaultsPath, defaultsBytes);
  writeFileSync(settingsPath, settingsBytes);

  const registrations = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider(name: string, config: any) { registrations.set(name, config); },
  } as any, { modelsPath, defaultsPath, settingsPath });

  // No identity migration: both models stay under maestro-qwen and no file is rewritten.
  assert.deepEqual(JSON.parse(readFileSync(modelsPath, "utf8")), JSON.parse(modelsBytes));
  assert.equal(readFileSync(defaultsPath, "utf8"), defaultsBytes);
  assert.equal(readFileSync(settingsPath, "utf8"), settingsBytes);
  assert.deepEqual([...registrations.keys()], ["maestro-qwen"]);
  assert.deepEqual(
    registrations.get("maestro-qwen")?.models.map((m: any) => m.id),
    ["qwen3.8-max-preview", "deepseek-v4-flash"],
  );

  // Editing one model under a multi-model Provider keeps the sibling intact.
  await saveApiProviderSettings({
    provider: "maestro-qwen",
    api: "openai-completions",
    name: "Qwen",
    baseUrl: "https://deepseek.example.com/v1",
    apiKey: "deepseek-secret",
    modelId: "deepseek-v4-flash",
    contextWindow: 700_000,
    maxTokens: 96_000,
    reasoning: true,
    compat: { thinkingFormat: "deepseek" },
    replaceProviderOptions: true,
  }, modelsPath);
  const edited = JSON.parse(readFileSync(modelsPath, "utf8")).providers;
  assert.equal(edited["maestro-qwen"].baseUrl, "https://deepseek.example.com/v1");
  assert.equal(edited["maestro-qwen"].apiKey, "deepseek-secret");
  assert.deepEqual(edited["maestro-qwen"].compat, {
    supportsDeveloperRole: false,
    thinkingFormat: "qwen",
  });
  assert.deepEqual(
    edited["maestro-qwen"].models.map((m: any) => m.id),
    ["qwen3.8-max-preview", "deepseek-v4-flash"],
  );
  assert.equal(edited["maestro-qwen"].models[1].contextWindow, 700_000);
  assert.equal(edited["maestro-qwen"].models[0].contextWindow, 400_000);
  assert.deepEqual(JSON.parse(readFileSync(defaultsPath, "utf8")).modelDefaults, {
    "maestro-qwen/qwen3.8-max-preview": "high",
    "maestro-qwen/deepseek-v4-flash": "medium",
  });
});

test("save/delete reject malformed siblings and reserved Provider IDs without data loss", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-lossless-guard-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const bytes = JSON.stringify({
    providers: {
      guarded: {
        baseUrl: "https://guarded.example.com/v1",
        api: "openai-completions",
        apiKey: "secret",
        models: [
          { id: "valid", reasoning: false, contextWindow: 10_000, maxTokens: 1_000 },
          "future-entry",
        ],
      },
    },
  });
  writeFileSync(modelsPath, bytes);

  await assert.rejects(
    () => saveApiProviderSettings({
      provider: "guarded",
      api: "openai-completions",
      baseUrl: "https://guarded.example.com/v1",
      apiKey: "secret",
      modelId: "valid",
      reasoning: false,
    }, modelsPath),
    /malformed model entries/,
  );
  await assert.rejects(
    () => deleteApiProviderModelSettings("guarded", "valid", modelsPath),
    /malformed model entries/,
  );
  await assert.rejects(
    () => saveApiProviderSettings({
      provider: "__proto__",
      api: "openai-completions",
      baseUrl: "https://guarded.example.com/v1",
      apiKey: "secret",
      modelId: "valid",
      reasoning: false,
    }, modelsPath),
    /reserved/,
  );
  assert.equal(readFileSync(modelsPath, "utf8"), bytes);
});

test("editing an existing model does not switch the Pi global default model", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-default-stable-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const settingsPath = join(tempDir, "settings.json");

  await saveApiProviderSettings({
    provider: "maestro-openai",
    baseUrl: "https://gateway.example.com/v1",
    apiKey: "shared-secret",
    modelId: "model-a",
    contextWindow: 111_000,
    maxTokens: 32_000,
    reasoning: true,
  }, modelsPath);
  await saveApiProviderSettings({
    provider: "maestro-openai--model-b",
    api: "openai-responses",
    baseUrl: "https://gateway.example.com/v1",
    apiKey: "shared-secret",
    modelId: "model-b",
    contextWindow: 222_000,
    maxTokens: 32_000,
    reasoning: true,
  }, modelsPath);
  writeFileSync(settingsPath, JSON.stringify({
    defaultProvider: "maestro-openai--model-b",
    defaultModel: "model-b",
  }));

  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
    setThinkingLevel() {},
  } as any, { modelsPath });

  await commands.get("api-manager").handler("set openai", {
    cwd: tempDir,
    hasUI: true,
    modelRegistry: { refresh() {}, getAll() { return []; } },
    ui: {
      async select() { return "model-a"; },
      async custom() {
        return { values: {
          provider: "maestro-openai", api: "openai-responses",
          baseUrl: "https://gateway.example.com/v1", apiKey: "shared-secret",
          modelId: "model-a", reasoning: true, defaultThinking: "medium",
          contextWindow: "999000", maxTokens: "32000",
        } };
      },
      async confirm() { return true; },
      notify() {},
    },
  });

  // Editing model-a must not steal the default back from model-b, and the
  // global thinking fallback must stay untouched.
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(settings.defaultModel, "model-b");
  assert.equal(settings.defaultThinkingLevel, undefined);
  const openai = JSON.parse(readFileSync(modelsPath, "utf8")).providers["maestro-openai"];
  assert.equal(openai.models.find((m: any) => m.id === "model-a").contextWindow, 999_000);
});

test("/api-manager no-arg configure lists every model globally and edits through one preloaded form", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-manager-global-edit-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  await saveApiProviderSettings({
    provider: "maestro-openai",
    baseUrl: "https://gateway.example.com/v1",
    modelId: "model-a",
    contextWindow: 111_000,
    maxTokens: 32_000,
    reasoning: true,
    apiKey: "openai-secret",
  }, modelsPath);
  await saveApiProviderSettings({
    provider: "maestro-qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    modelId: "qwen-model",
    reasoning: true,
    apiKey: "qwen-secret",
  }, modelsPath);
  const qwenBefore = JSON.parse(readFileSync(modelsPath, "utf8")).providers["maestro-qwen"];

  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
    setThinkingLevel() {},
  } as any, { modelsPath });

  const selectCalls: Array<{ title: string; options: string[] }> = [];
  let form = "";
  await commands.get("api-manager").handler("", {
    cwd: tempDir,
    hasUI: true,
    modelRegistry: { refresh() {}, getAll() { return []; } },
    ui: {
      async select(title: string, options: string[]) {
        selectCalls.push({ title, options });
        if (title === "选择操作") return options.find((option) => option.startsWith("新增或修改模型"));
        return options.find((option) => option.includes("maestro-openai / model-a"));
      },
      async custom(factory: any) {
        const overlay = factory(
          { requestRender() {} },
          { fg: (_role: string, text: string) => text, bold: (text: string) => text },
          {},
          () => undefined,
        );
        form = overlay.render(120).join("\n");
        return {
          values: {
            provider: "maestro-openai",
            api: "openai-responses",
            baseUrl: "https://gateway.example.com/v1",
            modelId: "model-a",
            reasoning: true,
            defaultThinking: "medium",
            contextWindow: "111000",
            maxTokens: "48000",
            apiKey: "openai-secret",
          },
        };
      },
      async confirm() { return true; },
      notify() {},
    },
  });

  // Model-centric navigation: one list shows every model; format is only an attribute.
  assert.ok(selectCalls[0]?.options.includes("启用或停用 Provider"));
  assert.ok(selectCalls[0]?.options.some((option) => option.startsWith("Vision 多模态策略")));
  const global = selectCalls.find((call) => call.title !== "选择操作");
  assert.ok(global);
  assert.ok(global!.options.some((option) => option.includes("maestro-openai / model-a")));
  assert.ok(global!.options.some((option) => option.includes("maestro-qwen / qwen-model")));
  assert.ok(global!.options.some((option) => option.includes("➕ 新增模型…")));
  assert.equal(global!.options.some((option) => option.includes("新增独立 model ·")), false);

  // The single form renders the original model parameters, grouped by Provider/model level.
  assert.match(form, /修改 OpenAI Responses \/ model-a/);
  assert.match(form, /连接（Provider \/ URL 级）/);
  assert.match(form, /模型（Model 级）/);
  assert.match(form, /https:\/\/gateway\.example\.com\/v1/);
  assert.match(form, /111000/);
  assert.match(form, /32000/);
  assert.doesNotMatch(form, /openai-secret/);

  const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.equal(saved.providers["maestro-openai"].models[0].maxTokens, 48_000);
  assert.deepEqual(saved.providers["maestro-qwen"], qwenBefore);
});

test("/api-manager adds a second model to the same Provider through the new-model flow", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-manager-global-add-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const defaultsPath = join(tempDir, "api-manager.json");
  await saveApiProviderSettings({
    provider: "maestro-openai",
    baseUrl: "https://gateway.example.com/v1",
    modelId: "model-a",
    contextWindow: 111_000,
    maxTokens: 32_000,
    reasoning: true,
    apiKey: "shared-secret",
  }, modelsPath);

  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
    setThinkingLevel() {},
  } as any, { modelsPath, defaultsPath });

  let form = "";
  await commands.get("api-manager").handler("", {
    cwd: tempDir,
    hasUI: true,
    modelRegistry: { refresh() {}, getAll() { return []; } },
    ui: {
      async select(title: string, options: string[]) {
        if (title === "选择操作") return options.find((option) => option.startsWith("新增或修改模型"));
        if (title === "新增模型到哪个 Provider？") {
          return options.find((option) => option.includes("Provider ID: maestro-openai"));
        }
        return options.find((option) => option.includes("➕ 新增模型…"));
      },
      async custom(factory: any) {
        const overlay = factory(
          { requestRender() {} },
          { fg: (_role: string, text: string) => text, bold: (text: string) => text },
          {},
          () => undefined,
        );
        form = overlay.render(120).join("\n");
        return {
          values: {
            provider: "maestro-openai",
            api: "openai-responses",
            baseUrl: "https://gateway.example.com/v1",
            modelId: "model-b",
            reasoning: true,
            defaultThinking: "medium",
            contextWindow: "400000",
            maxTokens: "128000",
            apiKey: "shared-secret",
          },
        };
      },
      async confirm() { return true; },
      notify() {},
    },
  });

  // The new-model flow opens the Provider's add form preloaded with its connection config.
  assert.match(form, /新增 OpenAI Responses 模型/);
  assert.match(form, /https:\/\/gateway\.example\.com\/v1/);
  assert.match(form, /Model ID\s+未设置/);
  // Provider-level key is preloaded but only ever rendered masked.
  assert.match(form, /sha\*+cret/);
  assert.doesNotMatch(form, /shared-secret/);

  const providers = JSON.parse(readFileSync(modelsPath, "utf8")).providers;
  assert.deepEqual(providers["maestro-openai"].models.map((model: any) => model.id), ["model-a", "model-b"]);
  assert.equal(providers["maestro-openai"].models[0].contextWindow, 111_000);
  assert.equal(providers["maestro-openai"].models[1].contextWindow, 400_000);
  assert.equal(providers["maestro-openai"].models[1].maxTokens, 128_000);
  assert.equal(providers["maestro-openai"].apiKey, "shared-secret");
  assert.equal(providers["maestro-openai"].baseUrl, "https://gateway.example.com/v1");
  assert.equal(providers["maestro-openai--model-b"], undefined);
  const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"));
  assert.equal(settings.defaultProvider, "maestro-openai");
  assert.equal(settings.defaultModel, "model-b");
});

test("/api-manager manages Vision routing and only offers multimodal models", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-manager-vision-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
    setThinkingLevel() {},
  } as any, { modelsPath });

  const imageModel = { provider: "vision-provider", id: "vision-model", input: ["text", "image"] };
  const textModel = { provider: "text-provider", id: "text-model", input: ["text"] };
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  let visionMenuCalls = 0;
  await commands.get("api-manager").handler("", {
    cwd: tempDir,
    hasUI: true,
    model: textModel,
    modelRegistry: { getAvailable() { return [textModel, imageModel]; } },
    ui: {
      async select(title: string, options: string[]) {
        selectCalls.push({ title, options });
        if (title === "选择操作") return options.find((option) => option.startsWith("Vision 多模态策略"));
        if (title === "Vision 委托设置") {
          visionMenuCalls += 1;
          return visionMenuCalls === 1 ? "选择 Vision 模型" : "完成";
        }
        if (title === "选择多模态 Vision 模型") return "vision-provider/vision-model";
        return undefined;
      },
      notify() {},
    },
  });

  const picker = selectCalls.find((call) => call.title === "选择多模态 Vision 模型");
  assert.deepEqual(picker?.options, ["自动检测", "vision-provider/vision-model"]);
  const saved = JSON.parse(readFileSync(join(tempDir, "vision-delegation.json"), "utf8"));
  assert.equal(saved.visionModel, "vision-provider/vision-model");
  assert.equal(saved.enabled, true);
});

test("/api-manager creates multiple models in one form submission from a comma-separated Model ID list", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-manager-batch-models-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const defaultsPath = join(tempDir, "api-manager.json");
  await saveApiProviderSettings({
    provider: "maestro-openai",
    baseUrl: "https://gateway.example.com/v1",
    modelId: "model-a",
    contextWindow: 111_000,
    maxTokens: 32_000,
    reasoning: true,
    apiKey: "shared-secret",
  }, modelsPath);

  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
    setThinkingLevel() {},
  } as any, { modelsPath, defaultsPath });

  let confirmDetails = "";
  await commands.get("api-manager").handler("", {
    cwd: tempDir,
    hasUI: true,
    modelRegistry: { refresh() {}, getAll() { return []; } },
    ui: {
      async select(title: string, options: string[]) {
        if (title === "选择操作") return options.find((option) => option.startsWith("新增或修改模型"));
        if (title === "新增模型到哪个 Provider？") {
          return options.find((option) => option.includes("Provider ID: maestro-openai"));
        }
        return options.find((option) => option.includes("➕ 新增模型…"));
      },
      async custom() {
        return {
          values: {
            provider: "maestro-openai",
            api: "openai-responses",
            baseUrl: "https://gateway.example.com/v1",
            modelId: "model-b, model-c",
            reasoning: true,
            defaultThinking: "medium",
            contextWindow: "400000",
            maxTokens: "128000",
            apiKey: "shared-secret",
          },
        };
      },
      async confirm(_title: string, details: string) {
        confirmDetails = details;
        return true;
      },
      notify() {},
    },
  });

  // One submission created both models; the preview listed them as a batch.
  assert.match(confirmDetails, /Model：model-b, model-c/);
  const providers = JSON.parse(readFileSync(modelsPath, "utf8")).providers;
  assert.deepEqual(providers["maestro-openai"].models.map((model: any) => model.id), ["model-a", "model-b", "model-c"]);
  for (const model of providers["maestro-openai"].models) {
    assert.equal(model.contextWindow, model.id === "model-a" ? 111_000 : 400_000);
    assert.equal(model.maxTokens, model.id === "model-a" ? 32_000 : 128_000);
  }
  assert.equal(providers["maestro-openai"].apiKey, "shared-secret");
  // First new model became the default; every model got its own thinking default.
  const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"));
  assert.equal(settings.defaultProvider, "maestro-openai");
  assert.equal(settings.defaultModel, "model-b");
  const defaults = JSON.parse(readFileSync(defaultsPath, "utf8")).modelDefaults;
  assert.equal(defaults["maestro-openai/model-b"], "medium");
  assert.equal(defaults["maestro-openai/model-c"], "medium");
});

test("Model ID list validation rejects duplicates and models that already exist", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-model-list-validate-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const defaultsPath = join(tempDir, "api-manager.json");
  await saveApiProviderSettings({
    provider: "maestro-openai",
    baseUrl: "https://gateway.example.com/v1",
    modelId: "model-a",
    contextWindow: 111_000,
    maxTokens: 32_000,
    reasoning: true,
    apiKey: "secret",
  }, modelsPath);

  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
  } as any, { modelsPath, defaultsPath });
  let validate: (values: Record<string, string | boolean>) => string[] | undefined;
  await commands.get("api-manager").handler("configure maestro-openai", {
    cwd: tempDir,
    hasUI: true,
    modelRegistry: { refresh() {}, getAll() { return []; } },
    ui: {
      async select(_title: string, options: string[]) {
        return options.find((option) => option === "➕ 新增模型…");
      },
      async custom(factory: any) {
        const overlay = factory(
          { requestRender() {} },
          { fg: (_role: string, text: string) => text, bold: (text: string) => text },
          {},
          () => undefined,
        );
        validate = (overlay as any).params.validate;
        return undefined;
      },
      notify() {},
    },
  });
  assert.ok(validate);
  const base = {
    provider: "maestro-openai",
    api: "openai-responses",
    baseUrl: "https://gateway.example.com/v1",
    reasoning: true,
    defaultThinking: "medium",
    contextWindow: "400000",
    maxTokens: "128000",
    apiKey: "secret",
  };
  assert.deepEqual(validate({ ...base, modelId: "model-b, model-b" }), ["Model ID model-b 重复；每个模型只能出现一次"]);
  assert.deepEqual(validate({ ...base, modelId: "model-a, model-b" }), ["Model model-a 已存在；请返回列表选择该 model 进行修改"]);
  assert.deepEqual(validate({ ...base, modelId: "" }), ["Model ID 不能为空"]);
  assert.deepEqual(validate({ ...base, modelId: "model-b, model-c" }), []);
});

test("new Provider flow rejects an occupied identity without loading its credentials", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-strict-create-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  await saveApiProviderSettings({
    provider: "occupied-provider",
    api: "openai-completions",
    baseUrl: "https://occupied.example.com/v1",
    apiKey: "occupied-secret",
    modelId: "occupied-model",
    reasoning: false,
  }, modelsPath);
  const before = readFileSync(modelsPath, "utf8");
  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
  } as any, { modelsPath });
  let customCalled = false;
  const notifications: string[] = [];

  await commands.get("api-manager").handler("configure new", {
    cwd: tempDir,
    hasUI: true,
    modelRegistry: { refresh() {} },
    ui: {
      async input() { return "occupied-provider"; },
      async custom() { customCalled = true; return undefined; },
      notify(message: string) { notifications.push(message); },
    },
  });

  assert.equal(customCalled, false);
  assert.match(notifications.at(-1) ?? "", /已存在.*不会修改/);
  assert.equal(readFileSync(modelsPath, "utf8"), before);
});

test("custom Provider command targets preserve case", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-case-id-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  await saveApiProviderSettings({
    provider: "CaseID",
    api: "openai-completions",
    baseUrl: "https://upper.example.com/v1",
    apiKey: "upper-secret",
    modelId: "upper-model",
    reasoning: false,
  }, modelsPath);
  await saveApiProviderSettings({
    provider: "caseid",
    api: "openai-completions",
    baseUrl: "https://lower.example.com/v1",
    apiKey: "lower-secret",
    modelId: "lower-model",
    reasoning: false,
  }, modelsPath);
  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
  } as any, { modelsPath });
  const notifications: string[] = [];

  await commands.get("api-manager").handler("show CaseID", {
    cwd: tempDir,
    hasUI: false,
    ui: { notify(message: string) { notifications.push(message); } },
  });

  assert.match(notifications.at(-1) ?? "", /upper-model/);
  assert.doesNotMatch(notifications.at(-1) ?? "", /lower-model/);
});

test("global model picker keeps slash-delimited identities distinct", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-slash-picker-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const defaultsPath = join(tempDir, "api-manager.json");
  const common = {
    api: "openai-completions" as const,
    baseUrl: "https://same.example.com/v1",
    apiKey: "same-secret",
    reasoning: false,
  };
  await saveApiProviderSettings({ ...common, provider: "team", modelId: "org/model" }, modelsPath);
  await saveApiProviderSettings({ ...common, provider: "team/org", modelId: "model" }, modelsPath);
  writeFileSync(defaultsPath, JSON.stringify({ managedProviders: ["team", "team/org"] }));
  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider() {},
    unregisterProvider() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
  } as any, { modelsPath, defaultsPath });
  let pickerOptions: string[] = [];

  await commands.get("api-manager").handler("", {
    cwd: tempDir,
    hasUI: true,
    modelRegistry: { refresh() {} },
    ui: {
      async select(title: string, options: string[]) {
        if (title === "选择操作") return options.find((option) => option.startsWith("删除模型"));
        pickerOptions = options;
        return options[1];
      },
      async confirm() { return true; },
      notify() {},
    },
  });

  assert.notEqual(pickerOptions[0], pickerOptions[1]);
  assert.match(pickerOptions[0], /team \/ org\/model/);
  assert.match(pickerOptions[1], /team\/org \/ model/);
  const providers = JSON.parse(readFileSync(modelsPath, "utf8")).providers;
  assert.ok(providers.team);
  assert.equal(providers["team/org"], undefined);
});

test("Provider-level picker targets duplicate display names by Provider ID", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-provider-duplicate-name-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const defaultsPath = join(tempDir, "api-manager.json");
  const common = {
    name: "Same Name",
    api: "openai-completions" as const,
    baseUrl: "https://same.example.com/v1",
    apiKey: "same-secret",
    reasoning: false,
  };
  await saveApiProviderSettings({ ...common, provider: "provider-a", modelId: "model-a" }, modelsPath);
  await saveApiProviderSettings({ ...common, provider: "provider-b", modelId: "model-b" }, modelsPath);
  writeFileSync(defaultsPath, JSON.stringify({ managedProviders: ["provider-a", "provider-b"] }));
  const commands = new Map<string, any>();
  registerApiProviderConfigs({
    registerProvider() {},
    unregisterProvider() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
  } as any, { modelsPath, defaultsPath });
  let providerOptions: string[] = [];

  await commands.get("api-manager").handler("logout", {
    cwd: tempDir,
    hasUI: true,
    modelRegistry: { refresh() {} },
    ui: {
      async select(_title: string, options: string[]) {
        providerOptions = options;
        return options[1];
      },
      async confirm() { return true; },
      notify() {},
    },
  });

  assert.match(providerOptions[0], /Provider ID: provider-a/);
  assert.match(providerOptions[1], /Provider ID: provider-b/);
  const providers = JSON.parse(readFileSync(modelsPath, "utf8")).providers;
  assert.ok(providers["provider-a"]);
  assert.equal(providers["provider-b"], undefined);
});

test("/api-manager no-arg delete removes only the globally selected model", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-api-manager-global-delete-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const modelsPath = join(tempDir, "models.json");
  const base = {
    provider: "maestro-openai",
    baseUrl: "https://gateway.example.com/v1",
    apiKey: "openai-secret",
  };
  const defaultsPath = join(tempDir, "api-manager.json");
  const settingsPath = join(tempDir, "settings.json");
  await saveApiProviderSettings({ ...base, modelId: "model-a", reasoning: true }, modelsPath);
  await saveApiProviderSettings({
    provider: "maestro-openai--model-b",
    api: "openai-responses",
    baseUrl: "https://gateway.example.com/v1",
    apiKey: "openai-secret",
    modelId: "model-b",
    reasoning: true,
  }, modelsPath);
  writeFileSync(defaultsPath, JSON.stringify({
    version: 1,
    managedProviders: ["maestro-openai--model-b"],
  }));
  writeFileSync(settingsPath, JSON.stringify({
    defaultProvider: "maestro-openai--model-b",
    defaultModel: "model-b",
    defaultThinkingLevel: "high",
  }));

  const commands = new Map<string, any>();
  let refreshes = 0;
  registerApiProviderConfigs({
    registerProvider() {},
    unregisterProvider() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
  } as any, { modelsPath, defaultsPath, settingsPath });

  const selectCalls: Array<{ title: string; options: string[] }> = [];
  await commands.get("api-manager").handler("", {
    cwd: tempDir,
    hasUI: true,
    modelRegistry: { refresh() { refreshes += 1; } },
    ui: {
      async select(title: string, options: string[]) {
        selectCalls.push({ title, options });
        if (title === "选择操作") return options.find((option) => option.startsWith("删除模型"));
        return options.find((option) => option.includes("maestro-openai--model-b / model-b"));
      },
      async confirm() { return true; },
      notify() {},
    },
  });

  const global = selectCalls.find((call) => call.title !== "选择操作");
  assert.ok(global);
  assert.deepEqual(global!.options, [
    "1. maestro-openai / model-a",
    "2. maestro-openai--model-b / model-b",
  ]);

  const saved = JSON.parse(readFileSync(modelsPath, "utf8")).providers;
  assert.deepEqual(saved["maestro-openai"].models.map((model: any) => model.id), ["model-a"]);
  assert.equal(saved["maestro-openai"].baseUrl, "https://gateway.example.com/v1");
  assert.equal(saved["maestro-openai--model-b"], undefined);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(settings.defaultProvider, undefined);
  assert.equal(settings.defaultModel, undefined);
  assert.equal(settings.defaultThinkingLevel, "high");
  assert.ok(refreshes >= 1);
});
