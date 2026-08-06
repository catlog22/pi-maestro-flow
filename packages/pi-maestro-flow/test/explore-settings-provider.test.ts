import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SettingsChange, SettingsContextV1 } from "pi-maestro-settings-core/v1";
import { SETTINGS_SECRET_SET_PLACEHOLDER } from "pi-maestro-settings-core/v1/schema";
import { createExploreSettingsProvider } from "../src/settings/explore-settings-provider.ts";

const context: SettingsContextV1 = { cwd: "/project", locale: "en" };

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "explore-provider-"));
  const configPath = join(directory, "api.json");
  const legacyPath = join(directory, "api-explore.json");
  mkdirSync(directory, { recursive: true });
  const provider = createExploreSettingsProvider({ getConfigPath: () => configPath, getLegacyPath: () => legacyPath });
  return { provider, configPath, legacyPath, directory, context };
}

function setChange(key: string, value: unknown): SettingsChange {
  return { operation: "set", key, scope: "global", value };
}

test("explore provider describes endpoints list-crud and defaults", async () => {
  const { provider, directory } = harness();
  try {
    const description = await provider.describe({ context });
    assert.equal(description.id, "pi-maestro-flow-explore");
    const endpoints = description.settings.find((s) => s.key === "explore.endpoints")!;
    assert.equal(endpoints.editor.kind, "list-crud");
    assert.ok(endpoints.editor.itemFields?.some((f) => f.key === "apiKey" && f.editor.kind === "secret"));
    assert.ok(endpoints.editor.itemFields?.some((f) => f.key === "format" && f.editor.kind === "enum"));
    assert.ok(description.settings.some((s) => s.key === "explore.maxTurns" && s.editor.kind === "integer"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explore read surfaces endpoints with masked apiKey and defaults", async () => {
  const { provider, directory, configPath } = harness();
  try {
    writeFileSync(configPath, JSON.stringify({
      endpoints: {
        primary: { baseUrl: "https://api.example.com", apiKey: "sk-live", model: "grok-4.5", format: "openai" },
        legacy: { baseUrl: "https://old.example.com" },
      },
      maxTurns: 20,
    }, null, 2));
    const snapshot = await provider.read({ context });
    const endpoints = snapshot.effective.values.find((e) => e.key === "explore.endpoints")?.value as Array<Record<string, unknown>>;
    assert.equal(endpoints.length, 2);
    const primary = endpoints.find((e) => e.name === "primary")!;
    assert.equal(primary.apiKey, SETTINGS_SECRET_SET_PLACEHOLDER, "apiKey masked on read");
    assert.equal(primary.baseUrl, "https://api.example.com");
    assert.equal(primary.format, "openai");
    assert.equal(snapshot.effective.values.find((e) => e.key === "explore.maxTurns")?.value, 20);
    assert.equal(snapshot.effective.values.find((e) => e.key === "explore.concurrency")?.value, 4, "unset falls back to default");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explore prepare+commit writes endpoints and preserves unknown keys", async () => {
  const { provider, directory, configPath } = harness();
  try {
    writeFileSync(configPath, JSON.stringify({ customRoot: true }, null, 2));
    const before = await provider.read({ context });
    const prepared = await provider.prepare!({
      context,
      transactionId: "e1",
      changes: [setChange("explore.endpoints", [
        { name: "primary", baseUrl: "https://api.example.com", apiKey: "sk-new", model: "grok-4.5", format: "openai" },
      ]), setChange("explore.maxTurns", 15)],
      expectedRevisions: before.configured.resources,
    });
    assert.equal(prepared.prepared, true);
    await provider.commit!({ context, transactionId: "e1", prepareToken: prepared.prepareToken! });
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(raw.customRoot, true, "unknown root keys preserved");
    assert.equal((raw.endpoints as Record<string, unknown>).primary.apiKey, "sk-new");
    assert.equal((raw.endpoints as Record<string, unknown>).primary.model, "grok-4.5");
    assert.equal(raw.maxTurns, 15);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explore validation rejects unknown keys and non-global scopes", async () => {
  const { provider, directory } = harness();
  try {
    const unknown = await provider.validate({ context, transactionId: "e2", changes: [setChange("explore.nope", 1)] });
    assert.equal(unknown.valid, false);
    const badScope = await provider.validate({ context, transactionId: "e2", changes: [{ operation: "set", key: "explore.maxTurns", scope: "project", value: 5 }] });
    assert.equal(badScope.valid, false);
    const badInt = await provider.validate({ context, transactionId: "e2", changes: [setChange("explore.maxTurns", 0)] });
    assert.equal(badInt.valid, false);
    const ok = await provider.validate({ context, transactionId: "e2", changes: [setChange("explore.maxTurns", 5)] });
    assert.equal(ok.valid, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explore falls back to the legacy api-explore.json when canonical is absent", async () => {
  const { provider, directory, legacyPath } = harness();
  try {
    writeFileSync(legacyPath, JSON.stringify({ endpoints: { old: { baseUrl: "https://old.example.com" } } }, null, 2));
    const snapshot = await provider.read({ context });
    const endpoints = snapshot.effective.values.find((e) => e.key === "explore.endpoints")?.value as Array<Record<string, unknown>>;
    assert.equal(endpoints.length, 1);
    assert.equal(endpoints[0]?.name, "old");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
