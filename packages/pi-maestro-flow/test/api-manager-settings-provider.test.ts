import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SettingsContextV1 } from "pi-maestro-settings-core/v1";
import { SETTINGS_SECRET_SET_PLACEHOLDER } from "pi-maestro-settings-core/v1/schema";
import { createApiManagerSettingsProvider, AGENT_HEADER_PRESETS } from "../src/settings/api-manager-settings-provider.ts";

interface Harness {
  provider: ReturnType<typeof createApiManagerSettingsProvider>;
  modelsPath: string;
  settingsPath: string;
  context: SettingsContextV1;
}

function harness(initialModels: Record<string, unknown> = {}, initialSettings: Record<string, unknown> = {}): Harness {
  const directory = mkdtempSync(join(tmpdir(), "api-settings-e2e-"));
  const modelsPath = join(directory, "models.json");
  const settingsPath = join(directory, "settings.json");
  writeFileSync(modelsPath, JSON.stringify(initialModels, null, 2));
  writeFileSync(settingsPath, JSON.stringify(initialSettings, null, 2));
  const provider = createApiManagerSettingsProvider({
    getModelsPath: () => modelsPath,
    getSettingsPath: () => settingsPath,
  });
  return { provider, modelsPath, settingsPath, context: { cwd: "/project", locale: "en" } };
}

test("api manager read surfaces providers with a masked apiKey placeholder", async () => {
  const { provider, context } = harness({
    providers: {
      "maestro-openai": { baseUrl: "https://gateway.example.com/v1", api: "openai-responses", apiKey: "sk-live", models: [{ id: "gpt-5.6" }] },
      "qwen": { baseUrl: "https://q.example.com/v1", api: "openai-completions", enabled: false },
    },
  });
  const snapshot = await provider.read({ context });
  const providers = snapshot.effective.values.find((entry) => entry.key === "api.providers")?.value as Array<Record<string, unknown>>;
  assert.equal(providers.length, 2);
  const openai = providers.find((entry) => entry.id === "maestro-openai")!;
  assert.equal(openai.apiKey, SETTINGS_SECRET_SET_PLACEHOLDER, "read must never expose the plaintext key");
  assert.equal(openai.enabled, true);
  assert.deepEqual(openai.models, [{ id: "gpt-5.6" }], "read surfaces the provider's models for in-shell editing");
  const qwen = providers.find((entry) => entry.id === "qwen")!;
  assert.equal(qwen.enabled, false);
});

test("api manager provider edits preserve existing models and unmanaged fields", async () => {
  const { provider, modelsPath, context } = harness({
    providers: {
      "maestro-openai": {
        baseUrl: "https://gateway.example.com/v1",
        api: "openai-responses",
        apiKey: "sk-live",
        models: [{ id: "gpt-5.6" }],
        compat: { supportsDeveloperRole: true },
        name: "openai",
      },
    },
  });
  const transactionId = "tx-providers";
  const prepared = await provider.prepare!({
    context,
    transactionId,
    changes: [{
      operation: "set" as const,
      key: "api.providers",
      scope: "global" as const,
      value: [{ id: "maestro-openai", baseUrl: "https://gateway.example.com/v2", api: "openai-responses", enabled: true, apiKey: SETTINGS_SECRET_SET_PLACEHOLDER }],
    }],
  });
  assert.equal(prepared.prepared, true);
  await provider.commit!({ context, transactionId, prepareToken: prepared.prepareToken! });
  const written = JSON.parse(readFileSync(modelsPath, "utf8")) as Record<string, any>;
  assert.equal(written.providers["maestro-openai"].baseUrl, "https://gateway.example.com/v2", "url edited");
  assert.deepEqual(written.providers["maestro-openai"].models, [{ id: "gpt-5.6" }], "existing models preserved (owned by api.models)");
  assert.equal(written.providers["maestro-openai"].compat.supportsDeveloperRole, true, "unmanaged compat field preserved");
  assert.equal(written.providers["maestro-openai"].name, "openai", "unmanaged name field preserved");
  assert.equal(written.providers["maestro-openai"].apiKey, "sk-live", "masked key resolved to the existing key");
});

test("api.models add persists a model onto an existing provider reusing its url and key", async () => {
  const { provider, modelsPath, context } = harness({
    providers: {
      "maestro-openai": { baseUrl: "https://gateway.example.com/v1", api: "openai-responses", apiKey: "sk-live", models: [{ id: "gpt-5.6" }] },
    },
  });
  const transactionId = "tx-models";
  const prepared = await provider.prepare!({
    context,
    transactionId,
    changes: [{
      operation: "set" as const,
      key: "api.models",
      scope: "global" as const,
      value: [
        { providerId: "maestro-openai", id: "gpt-5.6", name: "gpt-5.6", reasoning: true },
        { providerId: "maestro-openai", id: "grok-4.5", name: "grok-4.5", reasoning: true, input: ["text", "image"], contextWindow: 450000, maxTokens: 128000, thinkingLevelMap: { off: null, xhigh: "max" } },
      ],
    }],
  });
  assert.equal(prepared.prepared, true);
  await provider.commit!({ context, transactionId, prepareToken: prepared.prepareToken! });
  const written = JSON.parse(readFileSync(modelsPath, "utf8")) as Record<string, any>;
  const writtenProvider = written.providers["maestro-openai"];
  assert.equal(writtenProvider.baseUrl, "https://gateway.example.com/v1", "existing url reused, not rewritten");
  assert.equal(writtenProvider.apiKey, "sk-live", "existing key reused, not rewritten");
  assert.deepEqual(writtenProvider.models, [
    { id: "gpt-5.6", name: "gpt-5.6", reasoning: true },
    { id: "grok-4.5", name: "grok-4.5", reasoning: true, input: ["text", "image"], contextWindow: 450000, maxTokens: 128000, thinkingLevelMap: { off: null, xhigh: "max" } },
  ], "new model written onto the provider, old model kept");
});

test("api.models round-trip preserves unmanaged model fields when editing another model", async () => {
  const { provider, modelsPath, context } = harness({
    providers: {
      "maestro-openai": {
        baseUrl: "https://gateway.example.com/v1",
        api: "openai-responses",
        apiKey: "sk-live",
        models: [
          { id: "gpt-5.6", cost: { input: 1, output: 2 }, headers: { "X-Model": "gpt" }, compat: { unknownFlag: "keep" } },
          { id: "grok-4.5", name: "Grok 4.5", reasoning: true },
        ],
      },
    },
  });
  // Simulate the list-crud shell: read the flat list, edit one field of one item.
  const snapshot = await provider.read({ context });
  const flat = snapshot.effective.values.find((entry) => entry.key === "api.models")?.value as Array<Record<string, unknown>>;
  const edited = flat.map((item) => item.id === "gpt-5.6" ? { ...item, name: "GPT-5.6 renamed" } : item);
  const transactionId = "tx-models-preserve";
  const prepared = await provider.prepare!({ context, transactionId, changes: [{ operation: "set" as const, key: "api.models", scope: "global" as const, value: edited }] });
  assert.equal(prepared.prepared, true);
  await provider.commit!({ context, transactionId, prepareToken: prepared.prepareToken! });
  const written = JSON.parse(readFileSync(modelsPath, "utf8")) as Record<string, any>;
  assert.deepEqual(written.providers["maestro-openai"].models, [
    { id: "gpt-5.6", name: "GPT-5.6 renamed", cost: { input: 1, output: 2 }, headers: { "X-Model": "gpt" }, compat: { unknownFlag: "keep" } },
    { id: "grok-4.5", name: "Grok 4.5", reasoning: true },
  ], "unmanaged model fields survive an unrelated edit");
});

test("api.models deleting the last model of a provider clears it", async () => {
  const { provider, modelsPath, context } = harness({
    providers: {
      "maestro-openai": { baseUrl: "https://gateway.example.com/v1", api: "openai-responses", apiKey: "sk-live", models: [{ id: "gpt-5.6" }] },
    },
  });
  const transactionId = "tx-models-clear";
  const prepared = await provider.prepare!({ context, transactionId, changes: [{ operation: "set" as const, key: "api.models", scope: "global" as const, value: [] }] });
  assert.equal(prepared.prepared, true);
  await provider.commit!({ context, transactionId, prepareToken: prepared.prepareToken! });
  const written = JSON.parse(readFileSync(modelsPath, "utf8")) as Record<string, any>;
  assert.deepEqual(written.providers["maestro-openai"].models, [], "last model deletion really persists");
});

test("api.models commit snapshot keeps the models baseline for the next edit", async () => {
  const { provider, context } = harness({
    providers: {
      "maestro-openai": { baseUrl: "https://gateway.example.com/v1", api: "openai-responses", apiKey: "sk-live", models: [{ id: "gpt-5.6" }] },
    },
  });
  const transactionId = "tx-models-baseline";
  const prepared = await provider.prepare!({
    context,
    transactionId,
    changes: [{
      operation: "set" as const,
      key: "api.providers",
      scope: "global" as const,
      value: [{ id: "maestro-openai", baseUrl: "https://gateway.example.com/v1", api: "openai-responses", enabled: true, apiKey: SETTINGS_SECRET_SET_PLACEHOLDER }],
    }],
  });
  const committed = await provider.commit!({ context, transactionId, prepareToken: prepared.prepareToken! });
  const baseline = committed.snapshot.configured.values.find((entry) => entry.key === "api.models");
  assert.ok(baseline, "post-commit baseline carries api.models");
  assert.deepEqual(baseline.value, [{ providerId: "maestro-openai", id: "gpt-5.6" }]);
});

test("api.models validate rejects non-object items and duplicate identities", async () => {
  const { provider, context } = harness({
    providers: {
      "maestro-openai": { baseUrl: "https://gateway.example.com/v1", api: "openai-responses", apiKey: "sk-live" },
    },
  });
  const nonObject = await provider.validate!({ context, changes: [{ operation: "set" as const, key: "api.models", scope: "global" as const, value: ["nope"] }] });
  assert.equal(nonObject.valid, false);
  assert.equal(nonObject.issues[0]?.code, "invalid-models");
  const duplicates = await provider.validate!({ context, changes: [{
    operation: "set" as const,
    key: "api.models",
    scope: "global" as const,
    value: [
      { providerId: "maestro-openai", id: "gpt-5.6" },
      { providerId: "maestro-openai", id: "gpt-5.6" },
    ],
  }] });
  assert.equal(duplicates.valid, false);
  assert.equal(duplicates.issues[0]?.code, "invalid-models");
  const valid = await provider.validate!({ context, changes: [{ operation: "set" as const, key: "api.models", scope: "global" as const, value: [{ providerId: "maestro-openai", id: "gpt-5.6" }] }] });
  assert.equal(valid.valid, true);
});

test("api.providers validate rejects duplicate ids", async () => {
  const { provider, context } = harness();
  const duplicate = await provider.validate!({ context, changes: [{
    operation: "set" as const,
    key: "api.providers",
    scope: "global" as const,
    value: [
      { id: "dup", baseUrl: "https://a.example.com/v1", api: "openai-responses" },
      { id: "dup", baseUrl: "https://b.example.com/v1", api: "openai-responses" },
    ],
  }] });
  assert.equal(duplicate.valid, false);
  assert.equal(duplicate.issues[0]?.code, "invalid-providers");
});

test("api manager read surfaces the prompt cache policy and defaults to off", async () => {
  const { provider, context } = harness();
  const snapshot = await provider.read({ context });
  const value = snapshot.effective.values.find((entry) => entry.key === "api.promptCache")?.value;
  assert.equal(value, "off");
});

test("api manager commit persists the prompt cache policy to settings.json", async () => {
  const { provider, modelsPath, settingsPath, context } = harness({}, { promptCache: "auto" });
  const transactionId = "tx-cache";
  const prepared = await provider.prepare!({
    context,
    transactionId,
    changes: [{ operation: "set" as const, key: "api.promptCache", scope: "global" as const, value: "on" }],
    expectedRevisions: [],
  });
  assert.equal(prepared.prepared, true);
  const committed = await provider.commit!({ context, transactionId, prepareToken: transactionId });
  assert.ok(committed.changedKeys.includes("api.promptCache"));
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { promptCache: string };
  assert.equal(settings.promptCache, "on");
  const snapshot = await provider.read({ context });
  assert.equal(snapshot.effective.values.find((entry) => entry.key === "api.promptCache")?.value, "on");
});

test("api manager validate rejects an invalid prompt cache policy", async () => {
  const { provider, context } = harness();
  const invalid = await provider.validate!({
    context,
    changes: [{ operation: "set" as const, key: "api.promptCache", scope: "global" as const, value: "always" }],
  });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.issues[0]?.code, "invalid-prompt-cache");
  const valid = await provider.validate!({
    context,
    changes: [{ operation: "set" as const, key: "api.promptCache", scope: "global" as const, value: "auto" }],
  });
  assert.equal(valid.valid, true);
});

test("api manager read surfaces cache tiers with defaults (auto / short)", async () => {
  const { provider, context } = harness();
  const snapshot = await provider.read({ context });
  const values = snapshot.effective.values;
  assert.equal(values.find((entry) => entry.key === "api.cacheRetention")?.value, "auto");
  assert.equal(values.find((entry) => entry.key === "api.agentCacheRetention")?.value, "short");
});

test("api manager commit persists cache tiers and validates them", async () => {
  const { provider, modelsPath, settingsPath, context } = harness({}, { cacheRetention: "long", agentCacheRetention: "short" });
  const transactionId = "tx-cache-tiers";
  const prepared = await provider.prepare!({
    context,
    transactionId,
    changes: [
      { operation: "set" as const, key: "api.cacheRetention", scope: "global" as const, value: "long" },
      { operation: "set" as const, key: "api.agentCacheRetention", scope: "global" as const, value: "none" },
    ],
    expectedRevisions: [],
  });
  assert.equal(prepared.prepared, true);
  const committed = await provider.commit!({ context, transactionId, prepareToken: transactionId });
  assert.ok(committed.changedKeys.includes("api.cacheRetention"));
  assert.ok(committed.changedKeys.includes("api.agentCacheRetention"));
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { cacheRetention: string; agentCacheRetention: string };
  assert.equal(settings.cacheRetention, "long");
  assert.equal(settings.agentCacheRetention, "none");

  const invalid = await provider.validate!({
    context,
    changes: [{ operation: "set" as const, key: "api.agentCacheRetention", scope: "global" as const, value: "forever" }],
  });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.issues[0]?.code, "invalid-agent-cache-retention");
  const invalidMain = await provider.validate!({
    context,
    changes: [{ operation: "set" as const, key: "api.cacheRetention", scope: "global" as const, value: "bogus" }],
  });
  assert.equal(invalidMain.valid, false);
  assert.equal(invalidMain.issues[0]?.code, "invalid-cache-retention");
});

test("api manager commit adds a provider, keeps an untouched secret and writes retry policy", async () => {
  const { provider, modelsPath, settingsPath, context } = harness({
    providers: {
      "maestro-openai": { baseUrl: "https://gateway.example.com/v1", api: "openai-responses", apiKey: "sk-live", models: [{ id: "gpt-5.6" }] },
    },
  });
  const changes = [
    { operation: "set" as const, key: "api.providers", scope: "global" as const, value: [
      { id: "maestro-openai", baseUrl: "https://gateway.example.com/v1", api: "openai-responses", enabled: true, apiKey: SETTINGS_SECRET_SET_PLACEHOLDER },
      { id: "new-vendor", baseUrl: "https://n.example.com/v1", api: "anthropic-messages", enabled: true, apiKey: "sk-new" },
    ]},
    { operation: "set" as const, key: "api.retry.enabled", scope: "global" as const, value: true },
    { operation: "set" as const, key: "api.retry.maxRetries", scope: "global" as const, value: 4 },
  ];
  const transactionId = "tx-1";
  const prepared = await provider.prepare!({ context, transactionId, changes, expectedRevisions: [] });
  assert.equal(prepared.prepared, true);
  const committed = await provider.commit!({ context, transactionId, prepareToken: transactionId });
  assert.ok(committed.changedKeys.includes("api.providers"));

  const models = JSON.parse(readFileSync(modelsPath, "utf8")) as Record<string, unknown>;
  const providers = models.providers as Record<string, Record<string, unknown>>;
  assert.equal(providers["maestro-openai"]!.apiKey, "sk-live", "placeholder on an existing provider must keep the original key");
  assert.equal(providers["new-vendor"]!.apiKey, "sk-new", "a fresh plaintext key must be written once");
  assert.deepEqual(providers["maestro-openai"]!.models, [{ id: "gpt-5.6" }], "existing models are preserved");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { retry: { enabled: boolean; maxRetries: number } };
  assert.equal(settings.retry.enabled, true);
  assert.equal(settings.retry.maxRetries, 4);
});

test("api manager commit replaces the provider list, dropping removed providers", async () => {
  const { provider, modelsPath, context } = harness({
    providers: {
      "keep": { baseUrl: "https://k.example.com/v1", api: "openai-responses" },
      "drop": { baseUrl: "https://d.example.com/v1", api: "openai-completions" },
    },
  });
  const transactionId = "tx-2";
  await provider.prepare!({
    context, transactionId,
    changes: [{ operation: "set", key: "api.providers", scope: "global", value: [
      { id: "keep", baseUrl: "https://k.example.com/v1", api: "openai-responses", enabled: true },
    ] }],
    expectedRevisions: [],
  });
  await provider.commit!({ context, transactionId, prepareToken: transactionId });
  const providers = (JSON.parse(readFileSync(modelsPath, "utf8")) as { providers: Record<string, unknown> }).providers;
  assert.deepEqual(Object.keys(providers), ["keep"]);
});

test("api manager validates malformed provider lists", async () => {
  const { provider, context } = harness();
  const invalid = await provider.validate!({
    context, transactionId: "tx-3",
    changes: [{ operation: "set", key: "api.providers", scope: "global", value: [{ baseUrl: "no-id" }] }],
  });
  assert.equal(invalid.valid, false);
  const valid = await provider.validate!({
    context, transactionId: "tx-3",
    changes: [{ operation: "set", key: "api.providers", scope: "global", value: [{ id: "ok", enabled: true }] }],
  });
  assert.equal(valid.valid, true);
});

test("api manager overview carries provider and retry rows", async () => {
  const { provider, context } = harness({
    providers: { "maestro-openai": { baseUrl: "https://g/v1", api: "openai-responses", enabled: true } },
  }, { retry: { enabled: true, maxRetries: 3 } });
  const snapshot = await provider.read({ context });
  const rows = snapshot.effective.values.find((entry) => entry.key === "api.overview")?.value as Array<Record<string, unknown>>;
  assert.ok(rows.length >= 3);
  assert.ok(rows.some((row) => String(row.label).includes("maestro-openai")));
  assert.ok(rows.some((row) => row.labelKey === "api.overview.retry"));
});

test("api manager read surfaces headerPreset and custom headers", async () => {
  const { provider, context } = harness({
    providers: {
      "cc": { baseUrl: "https://a.example.com", api: "anthropic-messages", headerPreset: "claude-code", headers: { "X-Extra": "1" } },
      "legacy": { baseUrl: "https://b.example.com", api: "openai-responses", headers: { "X-Hand-Edited": "keep" } },
    },
  });
  const snapshot = await provider.read({ context });
  const providers = snapshot.effective.values.find((entry) => entry.key === "api.providers")?.value as Array<Record<string, unknown>>;
  const cc = providers.find((entry) => entry.id === "cc")!;
  assert.equal(cc.headerPreset, "claude-code");
  assert.deepEqual(cc.headers, { "X-Extra": "1" }, "custom headers surfaced for in-shell editing");
  const legacy = providers.find((entry) => entry.id === "legacy")!;
  assert.equal(legacy.headerPreset, "none", "providers without a preset surface none");
  assert.deepEqual(legacy.headers, { "X-Hand-Edited": "keep" }, "hand-edited headers are not lost");
});

test("api manager commit expands an agent header preset into headers", async () => {
  const { provider, modelsPath, context } = harness({
    providers: { "maestro-openai": { baseUrl: "https://g/v1", api: "openai-responses", models: [{ id: "gpt-5.6" }] } },
  });
  const transactionId = "tx-headers";
  await provider.prepare!({
    context, transactionId,
    changes: [{
      operation: "set", key: "api.providers", scope: "global",
      value: [
        { id: "maestro-openai", baseUrl: "https://g/v1", api: "openai-responses", enabled: true, headerPreset: "claude-code", headers: { "User-Agent": "custom-ua/1.0" }, models: [{ id: "gpt-5.6" }] },
      ],
    }],
  });
  await provider.commit!({ context, transactionId, prepareToken: transactionId });
  const written = (JSON.parse(readFileSync(modelsPath, "utf8")) as { providers: Record<string, any> }).providers["maestro-openai"];
  assert.equal(written.headerPreset, "claude-code", "preset persisted for the editor");
  assert.equal(written.headers["User-Agent"], "custom-ua/1.0", "custom header overrides the preset's same-name header");
  assert.equal(written.headers["X-App"], "cli", "preset identity headers expanded");
  assert.equal(written.headers["X-Stainless-Lang"], "js");
});

test("api manager commit keeps hand-edited headers when no preset is chosen", async () => {
  const { provider, modelsPath, context } = harness({
    providers: { "p": { baseUrl: "https://p/v1", api: "openai-completions", headers: { "X-Keep": "yes" }, models: [{ id: "m1" }] } },
  });
  const transactionId = "tx-keep-headers";
  // The list-crud editor echoes back the loaded entry (headers included); a
  // preset-less commit must keep them and must not persist a "none" preset.
  await provider.prepare!({
    context, transactionId,
    changes: [{
      operation: "set", key: "api.providers", scope: "global",
      value: [{ id: "p", baseUrl: "https://p/v1", api: "openai-completions", enabled: true, headerPreset: "none", headers: { "X-Keep": "yes" }, models: [{ id: "m1" }] }],
    }],
  });
  await provider.commit!({ context, transactionId, prepareToken: transactionId });
  const written = (JSON.parse(readFileSync(modelsPath, "utf8")) as { providers: Record<string, any> }).providers["p"];
  assert.deepEqual(written.headers, { "X-Keep": "yes" }, "existing headers survive a commit without a preset");
  assert.equal(written.headerPreset, undefined, "none preset is not persisted");
});

test("api manager validate rejects non-string header values", async () => {
  const { provider, context } = harness();
  const invalid = await provider.validate!({
    context, transactionId: "tx-hdr",
    changes: [{ operation: "set", key: "api.providers", scope: "global", value: [{ id: "p", headers: { "X-Num": 42 } }] }],
  });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.issues[0]?.code, "invalid-headers");
  const valid = await provider.validate!({
    context, transactionId: "tx-hdr",
    changes: [{ operation: "set", key: "api.providers", scope: "global", value: [{ id: "p", headers: { "X-Str": "ok" } }] }],
  });
  assert.equal(valid.valid, true);
});

test("agent header presets cover all sub2api agent identities", () => {
  assert.ok("claude-code" in AGENT_HEADER_PRESETS);
  assert.ok("codex" in AGENT_HEADER_PRESETS);
  assert.ok("grok" in AGENT_HEADER_PRESETS);
  assert.ok("antigravity" in AGENT_HEADER_PRESETS);
  assert.match(AGENT_HEADER_PRESETS["claude-code"]["User-Agent"], /^claude-cli\//);
  assert.match(AGENT_HEADER_PRESETS["codex"]["User-Agent"], /^codex-tui\//);
  assert.match(AGENT_HEADER_PRESETS["grok"]["User-Agent"], /^xai-grok-workspace\//);
  assert.match(AGENT_HEADER_PRESETS["antigravity"]["User-Agent"], /^antigravity\//);
});
