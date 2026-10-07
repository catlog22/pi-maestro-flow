import assert from "node:assert/strict";
import test from "node:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingsAnnounceEventV1, SettingsProviderV1 } from "pi-maestro-settings-core/v1";
import { classifierConfig, classifierStatus, resetClassifierForTest } from "pi-maestro-teammate/v1/classify";
import {
  applyClassifierEnvOverrides,
  DEFAULT_CLASSIFIER_CONFIG,
  envOverrideForClassifier,
  normalizeClassifierConfig,
  loadClassifierConfig,
  saveClassifierConfig,
} from "../src/classifier/config.ts";
import { buildDomainTestInput, signalTypeDomain } from "../src/classifier/domains.ts";
import registerClassifier from "../src/classifier/extension.ts";

test("normalizeClassifierConfig applies defaults and validates fields", () => {
  const config = normalizeClassifierConfig(undefined);
  assert.equal(config.enabled, false);
  assert.deepEqual(config.domains, DEFAULT_CLASSIFIER_CONFIG.domains);

  const loaded = normalizeClassifierConfig({
    enabled: true,
    endpoint: "openrouter",
    model: "typesafe/jev-1.13",
    timeoutMs: 2500,
    maxCallsPerSession: 7,
    domains: { "retry-error": "shadow", "file-value": "bogus", "signal-type": "jev" },
  });
  assert.equal(loaded.enabled, true);
  assert.equal(loaded.endpoint, "openrouter");
  assert.equal(loaded.model, "typesafe/jev-1.13");
  assert.equal(loaded.timeoutMs, 2500);
  assert.equal(loaded.maxCallsPerSession, 7);
  assert.equal(loaded.domains["retry-error"], "shadow");
  assert.equal(loaded.domains["signal-type"], "jev");
  // Invalid mode entries are dropped, not normalized.
  assert.equal(loaded.domains["file-value"], DEFAULT_CLASSIFIER_CONFIG.domains["file-value"]);

  // Unknown endpoint values are rejected.
  assert.equal(normalizeClassifierConfig({ endpoint: "other" }).endpoint, undefined);
  // Non-object input falls back to defaults.
  assert.equal(normalizeClassifierConfig("yes").enabled, false);
});

test("envOverrideForClassifier parses truthy flags only", () => {
  assert.equal(envOverrideForClassifier(undefined), undefined);
  assert.equal(envOverrideForClassifier("1"), true);
  assert.equal(envOverrideForClassifier("yes"), true);
  assert.equal(envOverrideForClassifier("off"), false);
  assert.equal(envOverrideForClassifier("0"), false);
});

test("applyClassifierEnvOverrides reads endpoint/model env vars", () => {
  const savedEndpoint = process.env.PI_CLASSIFIER_ENDPOINT;
  const savedModel = process.env.PI_CLASSIFIER_MODEL;
  try {
    process.env.PI_CLASSIFIER_ENDPOINT = "typesafe";
    process.env.PI_CLASSIFIER_MODEL = "jev-latest";
    const config = applyClassifierEnvOverrides(normalizeClassifierConfig(undefined));
    assert.equal(config.endpoint, "typesafe");
    assert.equal(config.model, "jev-latest");
    process.env.PI_CLASSIFIER_ENDPOINT = "bogus";
    assert.equal(applyClassifierEnvOverrides(normalizeClassifierConfig(undefined)).endpoint, undefined);
  } finally {
    if (savedEndpoint === undefined) delete process.env.PI_CLASSIFIER_ENDPOINT;
    else process.env.PI_CLASSIFIER_ENDPOINT = savedEndpoint;
    if (savedModel === undefined) delete process.env.PI_CLASSIFIER_MODEL;
    else process.env.PI_CLASSIFIER_MODEL = savedModel;
  }
});

test("load and apply share all env priorities and leave configured values intact", async () => {
  const envKeys = ["PI_CLASSIFIER", "PI_CLASSIFIER_ENDPOINT", "PI_CLASSIFIER_MODEL"];
  const saved = envKeys.map((key) => process.env[key]);
  const directory = mkdtempSync(join(tmpdir(), "classifier-env-"));
  mkdirSync(join(directory, ".pi"));
  writeFileSync(join(directory, ".pi", "classifier.json"), JSON.stringify({ enabled: true, endpoint: "openrouter", model: "file" }));
  try {
    process.env.PI_CLASSIFIER = "off";
    process.env.PI_CLASSIFIER_ENDPOINT = " typesafe ";
    process.env.PI_CLASSIFIER_MODEL = " env-model ";
    const configured = await loadClassifierConfig(directory, { applyEnv: false });
    const loaded = await loadClassifierConfig(directory);
    assert.equal(configured.enabled, true);
    assert.equal(configured.endpoint, "openrouter");
    assert.equal(configured.model, "file");
    assert.deepEqual(loaded, applyClassifierEnvOverrides(configured));
    assert.equal(loaded.enabled, false);
    assert.equal(loaded.endpoint, "typesafe");
    assert.equal(loaded.model, "env-model");
    process.env.PI_CLASSIFIER = "on";
    assert.equal((await loadClassifierConfig(directory)).enabled, true);
    process.env.PI_CLASSIFIER_ENDPOINT = "invalid";
    process.env.PI_CLASSIFIER_MODEL = " ";
    delete process.env.PI_CLASSIFIER;
    assert.deepEqual(await loadClassifierConfig(directory), configured);
  } finally {
    envKeys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("slash commands respect env, save configured values and publish only after persistence", async () => {
  const envKeys = ["PI_CLASSIFIER", "PI_CLASSIFIER_ENDPOINT", "PI_CLASSIFIER_MODEL"];
  const saved = envKeys.map((key) => process.env[key]);
  const directory = mkdtempSync(join(tmpdir(), "classifier-slash-"));
  const path = join(directory, ".pi", "classifier.json");
  mkdirSync(join(directory, ".pi"));
  writeFileSync(path, JSON.stringify({ enabled: false, endpoint: "openrouter", model: "file" }));
  let handler!: (args: string, context: ExtensionCommandContext) => Promise<void>;
  const notices: string[] = [];
  let provider!: SettingsProviderV1;
  const pi = {
    events: {
      on: () => undefined,
      emit: (_event: string, payload: SettingsAnnounceEventV1) => { provider = payload.provider; },
    },
    on: () => undefined,
    registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
  } as unknown as ExtensionAPI;
  const context = { cwd: directory, modelRegistry: {}, ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionCommandContext;
  try {
    process.env.PI_CLASSIFIER = "1";
    process.env.PI_CLASSIFIER_ENDPOINT = "typesafe";
    process.env.PI_CLASSIFIER_MODEL = "env-model";
    registerClassifier(pi);
    await handler("status", context);
    assert.equal(classifierStatus().enabled, true);
    assert.equal(classifierConfig().model, "env-model");
    await handler("off", context);
    assert.equal(classifierStatus().enabled, true);
    assert.match(notices.at(-1)!, /enabled.*saved off.*overridden by PI_CLASSIFIER/);
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(persisted.enabled, false);
    assert.equal(persisted.endpoint, "openrouter");
    assert.equal(persisted.model, "file");
    process.env.PI_CLASSIFIER = "0";
    await handler("on", context);
    assert.equal(classifierStatus().enabled, false);
    assert.match(notices.at(-1)!, /disabled.*saved on.*overridden by PI_CLASSIFIER/);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).enabled, true);
    const settingsContext = { cwd: directory, locale: "en" as const };
    const changes = [{ operation: "set" as const, scope: "project" as const, key: "classifier.model", value: "settings-file" }];
    const prepared = await provider.prepare!({ context: settingsContext, transactionId: "live", changes });
    const committed = await provider.commit!({ context: settingsContext, transactionId: "live", prepareToken: prepared.prepareToken! });
    await provider.applyRuntime!({ context: settingsContext, transactionId: "live", changes, snapshot: committed.snapshot });
    assert.equal(classifierStatus().enabled, false);
    assert.equal(classifierConfig().endpoint, "typesafe");
    assert.equal(classifierConfig().model, "env-model");
    await handler("off", context);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).model, "settings-file");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).endpoint, "openrouter");
    await handler("reset", context);
    assert.equal(classifierStatus().enabled, false);
    assert.equal(classifierConfig().model, "env-model");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).model, undefined);
    delete process.env.PI_CLASSIFIER;
    delete process.env.PI_CLASSIFIER_ENDPOINT;
    delete process.env.PI_CLASSIFIER_MODEL;
    await handler("mode file-value shadow", context);
    assert.equal(classifierConfig().model, undefined);
    assert.equal(classifierConfig().domains?.["file-value"], "shadow");
    // A directory at the destination deterministically makes writeFile fail.
    rmSync(path);
    mkdirSync(path);
    const beforeFailure = classifierConfig();
    await assert.rejects(handler("on", context));
    assert.deepEqual(classifierConfig(), beforeFailure);
  } finally {
    resetClassifierForTest();
    envKeys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("partial save failure preserves the destination and cleans staged bytes", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "classifier-partial-"));
  const path = join(directory, ".pi", "classifier.json");
  mkdirSync(join(directory, ".pi"));
  const before = '{"enabled":false,"model":"before"}\n';
  writeFileSync(path, before);
  const original = fsPromises.writeFile;
  t.mock.method(fsPromises, "writeFile", async (target: Parameters<typeof original>[0]) => {
    await original(target, "{");
    throw Object.assign(new Error("partial write"), { code: "ENOSPC" });
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(saveClassifierConfig(normalizeClassifierConfig({ enabled: true }), directory), /partial write/);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.deepEqual(readdirSync(join(directory, ".pi")), ["classifier.json"]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("atomic saves reject existing and newly introduced configuration symlinks", async (t) => {
  for (const phase of ["initial", "staged"] as const) {
    const directory = mkdtempSync(join(tmpdir(), "classifier-link-"));
    const path = join(directory, ".pi", "classifier.json");
    const target = join(directory, "shared.json");
    mkdirSync(join(directory, ".pi"));
    writeFileSync(target, "before");
    if (phase === "initial") symlinkSync(target, path, "file");
    else {
      writeFileSync(path, "{}");
      const original = fsPromises.writeFile;
      t.mock.method(fsPromises, "writeFile", async (...args: Parameters<typeof original>) => {
        await original(...args);
        rmSync(path);
        symlinkSync(target, path, "file");
      });
      syncBuiltinESMExports();
    }
    try {
      await assert.rejects(saveClassifierConfig(normalizeClassifierConfig({ enabled: true }), directory), /regular file/);
      assert.equal(lstatSync(path).isSymbolicLink(), true);
      assert.equal(readFileSync(target, "utf8"), "before");
      assert.deepEqual(readdirSync(join(directory, ".pi")), ["classifier.json"]);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("buildDomainTestInput shapes per-domain inputs from free text", () => {
  assert.deepEqual(buildDomainTestInput("retry-error", "HTTP 429 rate limit"), {
    message: "HTTP 429 rate limit",
    status: 429,
  });
  assert.deepEqual(buildDomainTestInput("retry-error", "plain error"), { message: "plain error" });
  assert.deepEqual(buildDomainTestInput("file-value", "src/a.ts fix the bug"), {
    path: "src/a.ts",
    nextAction: "fix the bug",
  });
  assert.deepEqual(buildDomainTestInput("signal-type", "决定采用 X 因为 Y"), { text: "决定采用 X 因为 Y" });
});

test("signal-type domain rules treat unknown as provisional", () => {
  const spec = signalTypeDomain.rules({ text: "决策：采用方案 A 因为 B" });
  assert.equal(spec?.label, "spec");
  assert.equal(spec?.terminal, true);
  const narration = signalTypeDomain.rules({ text: "I checked the file and it looks fine." });
  assert.equal(narration?.label, "unknown");
  assert.equal(narration?.terminal, false);
});
