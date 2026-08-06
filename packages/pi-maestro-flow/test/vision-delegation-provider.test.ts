import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SettingsChange, SettingsContextV1 } from "pi-maestro-settings-core/v1";
import { createVisionDelegationSettingsProvider } from "../src/settings/vision-delegation-provider.ts";

const context: SettingsContextV1 = { cwd: "/project", locale: "en" };

function harness(initial?: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), "vision-provider-"));
  const configPath = join(directory, "vision-delegation.json");
  if (initial) writeFileSync(configPath, JSON.stringify(initial, null, 2));
  const provider = createVisionDelegationSettingsProvider({ getConfigPath: () => configPath });
  return { provider, configPath, directory, context };
}

function setChange(key: string, value: unknown): SettingsChange {
  return { operation: "set", key, scope: "global", value };
}

test("vision provider describes the delegation settings", async () => {
  const { provider, directory } = harness();
  try {
    const description = await provider.describe({ context });
    assert.equal(description.id, "pi-maestro-flow-vision");
    const keys = description.settings.map((setting) => setting.key);
    assert.ok(keys.includes("enabled"));
    assert.ok(keys.includes("visionModel"));
    assert.ok(keys.includes("customPrompt"));
    assert.ok(keys.includes("cache.enabled"));
    assert.ok(keys.includes("fallbackModels"));
    const fallback = description.settings.find((setting) => setting.key === "fallbackModels")!;
    assert.equal(fallback.editor.kind, "string-list");
    const prompt = description.settings.find((setting) => setting.key === "customPrompt")!;
    assert.equal(prompt.editor.kind, "text");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("vision read returns defaults and configured values", async () => {
  const { provider, directory, configPath } = harness({ enabled: false, visionModel: "openai/gpt-5.6-sol", cache: { enabled: true, maxEntries: 99 } });
  try {
    const snapshot = await provider.read({ context });
    const effective = (key: string) => snapshot.effective.values.find((entry) => entry.key === key)?.value;
    assert.equal(effective("enabled"), false);
    assert.equal(effective("visionModel"), "openai/gpt-5.6-sol");
    assert.equal(effective("cache.maxEntries"), 99);
    assert.equal(effective("cache.enabled"), true);
    assert.equal(effective("maxRetries"), 0, "unset falls back to default");
    assert.equal(effective("timeoutMs"), 60_000, "unset falls back to default");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("vision prepare+commit persists nested keys and preserves unknown keys", async () => {
  const { provider, directory, configPath } = harness({ custom: { keep: true } });
  try {
    const before = await provider.read({ context });
    const prepared = await provider.prepare!({
      context,
      transactionId: "v1",
      changes: [setChange("cache.maxEntries", 123), setChange("visionModel", "opencode/deepseek-v4-flash"), setChange("fallbackModels", ["a/b", "c/d"])],
      expectedRevisions: before.configured.resources,
    });
    assert.equal(prepared.prepared, true);
    await provider.commit!({ context, transactionId: "v1", prepareToken: prepared.prepareToken! });
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.equal((raw.cache as Record<string, unknown>).maxEntries, 123);
    assert.equal(raw.visionModel, "opencode/deepseek-v4-flash");
    assert.deepEqual(raw.fallbackModels, ["a/b", "c/d"]);
    assert.deepEqual(raw.custom, { keep: true }, "unknown keys preserved");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("vision validation rejects unknown keys and bad values", async () => {
  const { provider, directory } = harness();
  try {
    const unknown = await provider.validate({ context, transactionId: "v2", changes: [setChange("nope", 1)] });
    assert.equal(unknown.valid, false);
    const badInt = await provider.validate({ context, transactionId: "v2", changes: [setChange("maxRetries", -5)] });
    assert.equal(badInt.valid, false);
    const ok = await provider.validate({ context, transactionId: "v2", changes: [setChange("maxRetries", 3)] });
    assert.equal(ok.valid, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("vision rollback restores prior bytes", async () => {
  const { provider, directory, configPath } = harness({ maxRetries: 1 });
  try {
    const prepared = await provider.prepare!({ context, transactionId: "v3", changes: [setChange("maxRetries", 5)] });
    await provider.commit!({ context, transactionId: "v3", prepareToken: prepared.prepareToken! });
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).maxRetries, 5);
    await provider.rollback!({ context, transactionId: "v3", prepareToken: prepared.prepareToken!, committedRevisions: [] });
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).maxRetries, 1, "rollback restores prior value");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
