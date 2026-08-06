import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SettingsContextV1, SettingsSnapshot } from "pi-maestro-settings-core/v1";
import { SETTINGS_SECRET_SET_PLACEHOLDER } from "pi-maestro-settings-core/v1/schema";
import { ALL_CONFIG_KEYS, SMART_SEARCH_CONFIG_KEYS } from "../src/tools/smart-search-config.ts";
import { createSmartSearchSettingsProvider } from "../src/settings/smart-search-settings-provider.ts";

interface Harness {
  provider: ReturnType<typeof createSmartSearchSettingsProvider>;
  configPath: string;
  webPath: string;
  context: SettingsContextV1;
  directory: string;
}

function harness(
  initialConfig: Record<string, unknown> = {},
  initialWeb: Record<string, unknown> = {},
): Harness {
  const directory = mkdtempSync(join(tmpdir(), "smart-search-settings-e2e-"));
  const configPath = join(directory, "config.json");
  const webPath = join(directory, "web-search.json");
  if (Object.keys(initialConfig).length > 0) writeFileSync(configPath, JSON.stringify(initialConfig, null, 2));
  if (Object.keys(initialWeb).length > 0) writeFileSync(webPath, JSON.stringify(initialWeb, null, 2));
  const provider = createSmartSearchSettingsProvider({
    getConfigPath: () => configPath,
    getWebConfigPath: () => webPath,
  });
  const context: SettingsContextV1 = { cwd: "/project", locale: "en" };
  return { provider, configPath, webPath, context, directory };
}

function readConfig(configPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
}

function effectiveMap(snapshot: SettingsSnapshot): Map<string, unknown> {
  return new Map(snapshot.effective.values.map((entry) => [entry.key, entry.value]));
}

test("smart search read surfaces typed values, masked secrets and a sync overview", async () => {
  const { provider, context } = harness({
    XAI_API_KEY: "sk-live-secret",
    XAI_MODEL: "grok-4",
    TAVILY_ENABLED: false,
    EXA_TIMEOUT_SECONDS: 30,
  });
  const snapshot = await provider.read({ context });
  const effective = effectiveMap(snapshot);
  assert.equal(effective.get("XAI_API_KEY"), SETTINGS_SECRET_SET_PLACEHOLDER, "secret must be masked on read");
  assert.equal(effective.get("XAI_MODEL"), "grok-4");
  assert.equal(effective.get("TAVILY_ENABLED"), false);
  assert.equal(effective.get("EXA_TIMEOUT_SECONDS"), 30);

  const configured = new Map(snapshot.configured.values.map((entry) => [entry.key, entry]));
  assert.equal(configured.get("XAI_API_KEY")?.state, "set");
  assert.equal(configured.get("XAI_API_KEY")?.value, SETTINGS_SECRET_SET_PLACEHOLDER);
  assert.equal(configured.get("SMART_SEARCH_LOG_DIR")?.state, "absent");

  const rows = snapshot.effective.values.find((entry) => entry.key === "smartSearch.sync")?.value as Array<Record<string, unknown>>;
  assert.equal(rows.length, SMART_SEARCH_CONFIG_KEYS.length, "one row per config key");
  assert.ok(rows.some((row) => row.labelKey === "smartSearch.key.XAI_API_KEY"));
});

test("smart search commit writes typed values and keeps a placeholder secret unchanged", async () => {
  const { provider, configPath, context } = harness({ EXA_API_KEY: "sk-original", XAI_MODEL: "old" });
  const transactionId = "tx-commit";
  const prepared = await provider.prepare!({
    context,
    transactionId,
    changes: [
      { operation: "set", key: "XAI_MODEL", scope: "global", value: "grok-4" },
      { operation: "set", key: "EXA_API_KEY", scope: "global", value: SETTINGS_SECRET_SET_PLACEHOLDER },
      { operation: "set", key: "TAVILY_ENABLED", scope: "global", value: true },
      { operation: "set", key: "EXA_TIMEOUT_SECONDS", scope: "global", value: 25 },
    ],
    expectedRevisions: [],
  });
  assert.equal(prepared.prepared, true);
  const committed = await provider.commit!({ context, transactionId, prepareToken: transactionId });
  assert.deepEqual([...committed.changedKeys].sort(), ["EXA_API_KEY", "EXA_TIMEOUT_SECONDS", "TAVILY_ENABLED", "XAI_MODEL"]);

  const config = readConfig(configPath);
  assert.equal(config.XAI_MODEL, "grok-4");
  assert.equal(config.EXA_API_KEY, "sk-original", "placeholder on a secret must keep the original value");
  assert.equal(config.TAVILY_ENABLED, true);
  assert.equal(config.EXA_TIMEOUT_SECONDS, 25);
});

test("smart search commit deletes keys on unset", async () => {
  const { provider, configPath, context } = harness({ XAI_MODEL: "grok-4", XAI_TOOLS: "web_search" });
  const transactionId = "tx-unset";
  await provider.prepare!({
    context,
    transactionId,
    changes: [{ operation: "unset", key: "XAI_TOOLS", scope: "global" }],
    expectedRevisions: [],
  });
  await provider.commit!({ context, transactionId, prepareToken: transactionId });
  const config = readConfig(configPath);
  assert.equal(config.XAI_MODEL, "grok-4");
  assert.equal("XAI_TOOLS" in config, false, "unset removes the key from the config file");
});

test("smart search rollback restores the original config content", async () => {
  const { provider, configPath, context } = harness({ XAI_MODEL: "grok-4" });
  const transactionId = "tx-rollback";
  await provider.prepare!({
    context,
    transactionId,
    changes: [{ operation: "set", key: "XAI_MODEL", scope: "global", value: "grok-5" }],
    expectedRevisions: [],
  });
  await provider.commit!({ context, transactionId, prepareToken: transactionId });
  assert.equal(readConfig(configPath).XAI_MODEL, "grok-5");
  const rolledBack = await provider.rollback!({ context, transactionId, prepareToken: transactionId, committedRevisions: [] });
  assert.equal(rolledBack.rolledBack, true);
  assert.equal(readConfig(configPath).XAI_MODEL, "grok-4");
});

test("smart search validates per-key types and rejects read-only keys", async () => {
  const { provider, context } = harness();
  const invalid = [
    { operation: "set" as const, key: "TAVILY_ENABLED" as const, scope: "global" as const, value: "yes" },
    { operation: "set" as const, key: "EXA_TIMEOUT_SECONDS" as const, scope: "global" as const, value: "30" },
    { operation: "set" as const, key: "XAI_MODEL" as const, scope: "global" as const, value: 42 },
    { operation: "set" as const, key: "SMART_SEARCH_VALIDATION_LEVEL" as const, scope: "global" as const, value: "extreme" },
    { operation: "set" as const, key: "NOT_A_KEY" as const, scope: "global" as const, value: "x" },
    { operation: "set" as const, key: "smartSearch.sync" as const, scope: "global" as const, value: [] },
    { operation: "set" as const, key: "XAI_MODEL" as const, scope: "project" as const, value: "x" },
  ];
  for (const change of invalid) {
    const result = await provider.validate!({ context, transactionId: "t1", changes: [change] });
    assert.equal(result.valid, false, `${change.key} (${JSON.stringify(change.value)}) must be rejected`);
  }
  const valid = await provider.validate!({
    context,
    transactionId: "t1",
    changes: [
      { operation: "set", key: "TAVILY_ENABLED", scope: "global", value: true },
      { operation: "set", key: "EXA_TIMEOUT_SECONDS", scope: "global", value: 30 },
      { operation: "set", key: "XAI_MODEL", scope: "global", value: "grok-4" },
      { operation: "set", key: "SMART_SEARCH_VALIDATION_LEVEL", scope: "global", value: "strict" },
      { operation: "unset", key: "SMART_SEARCH_LOG_DIR", scope: "global" },
    ],
  });
  assert.equal(valid.valid, true);
});

test("smart search describe exposes typed editors and complete bilingual catalogs", async () => {
  const { provider, context } = harness();
  const description = await provider.describe({ context });
  assert.equal(description.id, "pi-maestro-smart-search");
  const settings = new Map(description.settings.map((entry) => [entry.key, entry]));
  assert.equal(settings.size, ALL_CONFIG_KEYS.length + 2);
  assert.equal(settings.get("PERPLEXITY_API_KEY")?.editor.kind, "secret", "native web-search key exposed as secret");
  assert.equal(settings.get("WEB_SEARCH_ENABLED")?.editor.kind, "boolean", "native web-search boolean exposed");
  assert.equal(settings.get("SSRF_TRUST_ENV_PROXY")?.editor.kind, "boolean");
  assert.equal(settings.get("XAI_API_KEY")?.editor.kind, "secret");
  assert.equal(settings.get("XAI_API_KEY")?.editor.writeOnly, true);
  assert.equal(settings.get("XAI_API_KEY")?.sensitivity, "secret");
  assert.equal(settings.get("XAI_MODEL")?.editor.kind, "text");
  assert.equal(settings.get("TAVILY_ENABLED")?.editor.kind, "boolean");
  assert.equal(settings.get("EXA_TIMEOUT_SECONDS")?.editor.kind, "number");
  assert.equal(settings.get("SMART_SEARCH_VALIDATION_LEVEL")?.editor.kind, "enum");
  assert.deepEqual(settings.get("SMART_SEARCH_INTENT_ROUTER")?.editor.options?.map((entry) => entry.value), ["hybrid", "rules", "off"]);
  assert.equal(settings.get("smartSearch.sync")?.editor.kind, "overview");
  assert.equal(settings.get("smartSearch.pushSync")?.editor.kind, "action");
  assert.equal(settings.get("smartSearch.pushSync")?.editor.actionId, "smartSearch.pushSync");

  const referenced = new Set<string>();
  for (const entry of description.settings) {
    referenced.add(entry.group);
    referenced.add(entry.labelKey);
    if (entry.descriptionKey) referenced.add(entry.descriptionKey);
    for (const option of entry.editor.options ?? []) referenced.add(option.labelKey);
  }
  for (const locale of ["en", "zh-CN"] as const) {
    for (const key of referenced) {
      assert.equal(typeof description.catalogs?.[locale]?.[key], "string", `${locale} missing catalog key ${key}`);
    }
  }
});

test("smart search overview reports synced, conflict, smart-only and unmapped rows", async () => {
  const { provider, context } = harness(
    { EXA_API_KEY: "sk-exa", TAVILY_API_KEY: "sk-tavily", FIRECRAWL_API_KEY: "sk-fc", XAI_MODEL: "grok-4" },
    { exaApiKey: "sk-exa", tavilyApiKey: "different" },
  );
  const snapshot = await provider.read({ context });
  const rows = snapshot.effective.values.find((entry) => entry.key === "smartSearch.sync")?.value as Array<{
    labelKey: string;
    value: string;
    status: string;
  }>;
  const row = (key: string) => rows.find((entry) => entry.labelKey === `smartSearch.key.${key}`)!;
  assert.equal(row("EXA_API_KEY").status, "ok", "matching values are synced");
  assert.equal(row("TAVILY_API_KEY").status, "warn", "mismatched values conflict");
  assert.equal(row("FIRECRAWL_API_KEY").status, "dim", "smart-only falls to dim");
  assert.equal(row("XAI_MODEL").status, "dim", "unmapped keys are dim");
  assert.equal(row("EXA_API_KEY").value, "✓ synced");
});

test("smart search pushSync writes mapped values into web-search.json", async () => {
  const { provider, webPath, context } = harness(
    { EXA_API_KEY: "sk-exa", TAVILY_API_KEY: "sk-tavily" },
    { provider: "exa" },
  );
  const result = await provider.invokeAction!({ context, actionId: "smartSearch.pushSync" });
  assert.equal(result.handled, true);
  assert.equal(result.refresh, true);
  const web = JSON.parse(readFileSync(webPath, "utf8")) as Record<string, unknown>;
  assert.equal(web.exaApiKey, "sk-exa");
  assert.equal(web.tavilyApiKey, "sk-tavily");
  assert.equal(web.provider, "exa", "unmapped-in-smart-search web keys are preserved");
  const untouched = await provider.invokeAction!({ context, actionId: "smartSearch.nope" });
  assert.equal(untouched.handled, false);
});

test("smart search custom actions are dispatched through options", async () => {
  const calls: string[] = [];
  const directory = mkdtempSync(join(tmpdir(), "smart-search-settings-action-"));
  const configPath = join(directory, "config.json");
  const webPath = join(directory, "web-search.json");
  const provider = createSmartSearchSettingsProvider({
    getConfigPath: () => configPath,
    getWebConfigPath: () => webPath,
    actions: { "smartSearch.custom": () => { calls.push("custom"); } },
  });
  const context: SettingsContextV1 = { cwd: "/project", locale: "en" };
  assert.deepEqual(await provider.invokeAction!({ context, actionId: "smartSearch.custom" }), { handled: true, refresh: false });
  assert.deepEqual(calls, ["custom"]);
  rmSync(directory, { recursive: true, force: true });
});

test("smart search stores secrets in the config file and keeps unrelated keys", async () => {
  const { provider, configPath, context } = harness({ UNKNOWN_PLUGIN_KEY: { enabled: true } });
  const transactionId = "tx-secret";
  await provider.prepare!({
    context,
    transactionId,
    changes: [
      { operation: "set", key: "XAI_API_KEY", scope: "global", value: "xai-secret-live" },
      { operation: "set", key: "XAI_MODEL", scope: "global", value: "grok-4" },
    ],
    expectedRevisions: [],
  });
  await provider.commit!({ context, transactionId, prepareToken: transactionId });
  const config = readConfig(configPath);
  assert.equal(config.XAI_API_KEY, "xai-secret-live", "a fresh plaintext secret is written once");
  assert.equal(config.XAI_MODEL, "grok-4");
  assert.deepEqual(config.UNKNOWN_PLUGIN_KEY, { enabled: true }, "unknown keys are preserved");
});
