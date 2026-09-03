import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  SETTINGS_ANNOUNCE_EVENT,
  SETTINGS_DISCOVER_EVENT,
  SETTINGS_PROTOCOL_VERSION,
  type SettingsContextV1,
} from "pi-maestro-settings-core/v1";
import {
  createFlowSettingsProvider,
  registerFlowSettingsProvider,
  type FlowSettingsProviderOptions,
} from "../src/settings/flow-settings-provider.ts";
import {
  createApiManagerSettingsProvider,
  registerApiManagerSettingsProvider,
} from "../src/settings/api-manager-settings-provider.ts";

function fixture(options: Pick<FlowSettingsProviderOptions, "replacementOperations" | "preparedTransactionTtlMs"> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-settings-provider-"));
  const globalSettings = path.join(root, "home", "settings.json");
  const projectSettings = path.join(root, "project", ".pi", "settings.json");
  const globalFailover = path.join(root, "home", "model-failover.json");
  const projectFailover = path.join(root, "project", ".pi", "model-failover.json");
  const context: SettingsContextV1 = { cwd: path.join(root, "project"), locale: "en" };
  const createProvider = () => createFlowSettingsProvider({
    getGlobalSettingsPath: () => globalSettings,
    getProjectSettingsPath: () => projectSettings,
    getGlobalFailoverPath: () => globalFailover,
    getProjectFailoverPath: () => projectFailover,
    ...options,
  });
  const provider = createProvider();
  return { root, globalSettings, projectSettings, globalFailover, projectFailover, context, provider, createProvider };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function synthesizeInterruptedReplacement(destination: string, content: string): { backup: string; journal: string } {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const backup = `${destination}.restart.backup`;
  const journal = `${destination}.replace-journal`;
  fs.writeFileSync(backup, content, "utf8");
  fs.writeFileSync(journal, `${JSON.stringify({ version: 1, destination, backup })}\n`, "utf8");
  return { backup, journal };
}

test("Flow provider describes editable settings, complex actions and bilingual catalogs", async () => {
  const { provider, context } = fixture();
  const description = await provider.describe({ context });
  assert.equal(description.id, "pi-maestro-flow");
  assert.equal(description.capabilities.prepareCommit, true);
  assert.ok(description.settings.some((entry) => entry.key === "compaction.soft.velocity.minFullness"));
  assert.equal(description.settings.find((entry) => entry.key === "compaction.keepRecentTokens")?.editor.max, 2_000_000);
  const newContext = description.settings.find((entry) => entry.key === "compaction.newContext.enabled");
  assert.equal(newContext?.defaultValue, true);
  assert.equal(newContext?.editor.kind, "boolean");
  assert.equal(newContext?.descriptionKey, "flow.compaction.newContext.enabled.description");
  const failoverDef = description.settings.find((entry) => entry.key === "failover.fallbackModels")!;
  assert.equal(failoverDef.editor.kind, "list-crud");
  assert.ok(failoverDef.editor.itemFields?.some((f) => f.key === "fallbacks" && f.editor.kind === "string-list"));
  const responseLanguage = description.settings.find((entry) => entry.key === "responseLanguage.manage");
  assert.equal(responseLanguage?.descriptionKey, "flow.action.responseLanguage.description");
  assert.deepEqual(responseLanguage?.editor.options?.map((entry) => entry.value), ["default", "zh-CN"]);
  assert.equal(description.catalogs?.en["flow.compaction.enabled"], "Enable compaction");
  assert.equal(description.catalogs?.["zh-CN"]["flow.compaction.enabled"], "启用上下文压缩");
  assert.match(description.catalogs?.en["flow.compaction.newContext.enabled.description"] ?? "", /Space toggles/);
  assert.match(description.catalogs?.["zh-CN"]["flow.compaction.newContext.enabled.description"] ?? "", /空格切换/);
  const snapshot = await provider.read({ context });
  assert.deepEqual(snapshot.effective.values.find((entry) => entry.key === "compaction.newContext.enabled"), {
    key: "compaction.newContext.enabled",
    value: true,
    source: "default",
  });
  const keys = new Set(description.settings.flatMap((entry) => [
    entry.group,
    entry.labelKey,
    ...(entry.descriptionKey ? [entry.descriptionKey] : []),
    ...(entry.editor.options?.map((option) => option.labelKey) ?? []),
  ]));
  for (const locale of ["en", "zh-CN"] as const) {
    for (const key of keys) assert.equal(typeof description.catalogs?.[locale][key], "string", `${locale} missing ${key}`);
  }
});

test("API Manager provider exposes settings, retry policy and the original manager routes", async () => {
  const calls: string[] = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "api-settings-"));
  try {
    const provider = createApiManagerSettingsProvider({
      getModelsPath: () => path.join(directory, "models.json"),
      getSettingsPath: () => path.join(directory, "settings.json"),
    });
    const context: SettingsContextV1 = { cwd: "/project", locale: "en" };
    const description = await provider.describe({ context });
    assert.equal(description.id, "pi-maestro-api-manager");
    assert.equal(description.labelKey, "api.provider");
    assert.equal(description.capabilities.write, true);
    assert.deepEqual(description.settings.map((entry) => entry.key), [
      "api.providers",
      "api.models",
      "api.retry.enabled",
      "api.retry.maxRetries",
      "api.retry.baseDelayMs",
      "api.retry.maxDelayMs",
      "api.promptCache",
      "api.cacheRetention",
      "api.agentCacheRetention",
      "api.overview",
    ]);
    assert.equal(description.catalogs?.["zh-CN"]["api.group.diagnostics"], "配置概览");
    const snapshot = await provider.read({ context });
    assert.equal(snapshot.effective.values.length, 10);
    assert.equal((await provider.validate({
      context,
      transactionId: "t1",
      changes: [{ operation: "set", key: "api.providers", scope: "global", value: "not-a-list" }],
    })).valid, false);

    const events = new EventEmitter();
    registerApiManagerSettingsProvider(events, provider);
    const announcements: unknown[] = [];
    events.on(SETTINGS_ANNOUNCE_EVENT, (payload) => announcements.push(payload));
    events.emit(SETTINGS_DISCOVER_EVENT, { version: SETTINGS_PROTOCOL_VERSION, requestId: "api-request", context });
    assert.equal((announcements.at(-1) as { providerId?: string }).providerId, "pi-maestro-api-manager");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Flow provider reports configured and effective values across global and project scopes", async () => {
  const { provider, context, globalSettings, projectSettings, globalFailover, projectFailover } = fixture();
  writeJson(globalSettings, { unknownRoot: true, compaction: { enabled: false, hard: { reserveTokens: 10000 }, soft: { enabled: false }, newContext: { enabled: true } } });
  writeJson(projectSettings, { compaction: { hard: { keepRecentTokens: 9000 }, soft: { enabled: true, velocity: { enabled: true } }, newContext: { enabled: false } } });
  writeJson(globalFailover, { enabled: true, fallbackModels: { "openai/main": ["qwen/fallback"] }, unknownGlobal: 1 });
  writeJson(projectFailover, { fallbackModels: { "qwen/main": ["openai/fallback"] } });

  const snapshot = await provider.read({ context });
  const configured = snapshot.configured.values;
  assert.equal(configured.find((entry) => entry.key === "compaction.enabled" && entry.scope === "global")?.value, false);
  assert.equal(configured.find((entry) => entry.key === "compaction.keepRecentTokens" && entry.scope === "project")?.value, 9000);
  const enabled = snapshot.effective.values.find((entry) => entry.key === "compaction.enabled");
  assert.deepEqual(enabled, {
    key: "compaction.enabled",
    value: false,
    source: "configured",
    scope: "global",
    resource: snapshot.configured.resources.find((entry) => entry.resource.id.startsWith("global:compaction"))?.resource,
  });
  const softEnabled = snapshot.effective.values.find((entry) => entry.key === "compaction.soft.enabled");
  assert.equal(softEnabled?.value, true);
  assert.equal(softEnabled?.scope, "project");
  const newContextEnabled = snapshot.effective.values.find((entry) => entry.key === "compaction.newContext.enabled");
  assert.equal(newContextEnabled?.value, false);
  assert.equal(newContextEnabled?.scope, "project");
  assert.deepEqual(snapshot.effective.values.find((entry) => entry.key === "failover.fallbackModels")?.value, [
    { model: "openai/main", fallbacks: ["qwen/fallback"] },
    { model: "qwen/main", fallbacks: ["openai/fallback"] },
  ]);
  const derived = snapshot.effective.values.find((entry) => entry.key === "compaction.derived");
  assert.equal(derived?.source, "runtime");
  const derivedRows = derived?.value as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(derivedRows) && derivedRows.length >= 4);
  assert.equal(derivedRows.find((row) => row.labelKey === "flow.overview.enabled")?.value, "off");
  assert.equal(derivedRows.find((row) => row.labelKey === "flow.overview.newContext")?.value, "off");
  const chains = snapshot.effective.values.find((entry) => entry.key === "failover.overview")?.value as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(chains) && chains.length >= 2);
  assert.ok(chains.some((row) => String(row.label).includes("qwen/main")));
});

test("Flow provider validates ranges, effective compaction invariants and fallback maps", async () => {
  const { provider, context } = fixture();
  const baseline = await provider.read({ context });
  const result = await provider.validate({
    context,
    transactionId: "invalid",
    expectedRevisions: baseline.configured.resources,
    changes: [
      { operation: "set", key: "compaction.keepRecentTokens", scope: "global", value: 2_000_001 },
      { operation: "set", key: "compaction.soft.nudgeRatio", scope: "global", value: 0.9 },
      { operation: "set", key: "compaction.soft.pruneRatio", scope: "global", value: 0.8 },
      { operation: "set", key: "failover.fallbackModels", scope: "project", value: { bad: ["also-bad"] } },
    ],
  });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((entry) => entry.messageKey === "flow.settings.invalidValue"));
  assert.ok(result.issues.some((entry) => entry.messageKey === "flow.settings.invalidEffective"));
});

test("Flow provider commits multiple physical resources while preserving unknown fields", async () => {
  const { provider, context, globalSettings, projectFailover } = fixture();
  writeJson(globalSettings, { theme: "custom", compaction: { unknownCompaction: 7, hard: { unknownHard: 8 } } });
  writeJson(projectFailover, { unknownFailover: true, fallbackModels: { "old/model": ["old/fallback"] } });
  const baseline = await provider.read({ context });
  const changes = [
    { operation: "set" as const, key: "compaction.reserveTokens", scope: "global" as const, value: 32000 },
    { operation: "set" as const, key: "compaction.soft.cache.enabled", scope: "global" as const, value: false },
    { operation: "set" as const, key: "failover.enabled", scope: "project" as const, value: true },
    { operation: "set" as const, key: "failover.fallbackModels", scope: "project" as const, value: { "openai/main": ["qwen/fallback"] } },
  ];
  const prepared = await provider.prepare!({ context, transactionId: "commit", changes, expectedRevisions: baseline.configured.resources });
  assert.equal(prepared.prepared, true);
  const committed = await provider.commit!({ context, transactionId: "commit", prepareToken: prepared.prepareToken! });
  assert.deepEqual(committed.activation.map((entry) => entry.boundary).sort(), ["next-invocation", "next-turn"]);
  const settings = JSON.parse(fs.readFileSync(globalSettings, "utf8"));
  assert.equal(settings.theme, "custom");
  assert.equal(settings.compaction.unknownCompaction, 7);
  assert.equal(settings.compaction.hard.unknownHard, 8);
  assert.equal(settings.compaction.hard.reserveTokens, 32000);
  assert.equal(settings.compaction.soft.cache.enabled, false);
  const failover = JSON.parse(fs.readFileSync(projectFailover, "utf8"));
  assert.equal(failover.unknownFailover, true);
  assert.equal(failover.enabled, true);
  assert.deepEqual(failover.fallbackModels, { "openai/main": ["qwen/fallback"] });
});

test("Flow provider abort rejects a mismatched transaction without consuming the prepared change", async () => {
  const { provider, context, globalSettings } = fixture();
  writeJson(globalSettings, { compaction: { enabled: false } });
  const baseline = await provider.read({ context });
  const prepared = await provider.prepare!({
    context,
    transactionId: "abort-owner",
    expectedRevisions: baseline.configured.resources,
    changes: [{ operation: "set", key: "compaction.enabled", scope: "global", value: true }],
  });

  await assert.rejects(
    provider.abort!({ context, transactionId: "abort-other", prepareToken: prepared.prepareToken! }),
    /prepared Flow settings transaction is unavailable/,
  );
  await provider.commit!({ context, transactionId: "abort-owner", prepareToken: prepared.prepareToken! });
  assert.equal(JSON.parse(fs.readFileSync(globalSettings, "utf8")).compaction.enabled, true);
});

test("Flow provider expires abandoned prepares and releases staged files and locks", async () => {
  const { provider, context, globalSettings } = fixture({ preparedTransactionTtlMs: 30 });
  writeJson(globalSettings, { compaction: { enabled: false } });
  const baseline = await provider.read({ context });
  const prepared = await provider.prepare!({
    context,
    transactionId: "abandoned",
    expectedRevisions: baseline.configured.resources,
    changes: [{ operation: "set", key: "compaction.enabled", scope: "global", value: true }],
  });
  const directory = path.dirname(globalSettings);
  assert.ok(fs.readdirSync(directory).some((entry) => entry.endsWith(".tmp")));
  assert.ok(fs.readdirSync(directory).some((entry) => entry.endsWith(".lock")));

  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.deepEqual(fs.readdirSync(directory), [path.basename(globalSettings)]);
  await assert.rejects(
    provider.commit!({ context, transactionId: "abandoned", prepareToken: prepared.prepareToken! }),
    /prepared Flow settings transaction is unavailable/,
  );
  assert.equal(JSON.parse(fs.readFileSync(globalSettings, "utf8")).compaction.enabled, false);

  const retry = await provider.prepare!({
    context,
    transactionId: "after-expiry",
    changes: [{ operation: "set", key: "compaction.enabled", scope: "global", value: true }],
  });
  assert.equal(retry.prepared, true);
  await provider.abort!({ context, transactionId: "after-expiry", prepareToken: retry.prepareToken! });
  assert.deepEqual(fs.readdirSync(directory), [path.basename(globalSettings)]);
});

test("Flow provider unsets project overrides without removing neighboring configuration", async () => {
  const { provider, context, globalSettings, projectSettings, projectFailover } = fixture();
  writeJson(globalSettings, { compaction: { enabled: false } });
  writeJson(projectSettings, { compaction: { enabled: true, unknown: "keep" } });
  writeJson(projectFailover, { enabled: true, fallbackModels: {}, unknown: "keep" });
  const baseline = await provider.read({ context });
  const changes = [
    { operation: "unset" as const, key: "compaction.enabled", scope: "project" as const },
    { operation: "unset" as const, key: "failover.enabled", scope: "project" as const },
  ];
  const prepared = await provider.prepare!({ context, transactionId: "unset", changes, expectedRevisions: baseline.configured.resources });
  await provider.commit!({ context, transactionId: "unset", prepareToken: prepared.prepareToken! });
  const snapshot = await provider.read({ context });
  assert.equal(snapshot.effective.values.find((entry) => entry.key === "compaction.enabled")?.value, false);
  assert.equal(JSON.parse(fs.readFileSync(projectSettings, "utf8")).compaction.unknown, "keep");
  assert.equal(JSON.parse(fs.readFileSync(projectFailover, "utf8")).unknown, "keep");
});

test("Flow provider refuses to overwrite malformed owned resources", async () => {
  const { provider, context, projectSettings } = fixture();
  fs.mkdirSync(path.dirname(projectSettings), { recursive: true });
  fs.writeFileSync(projectSettings, "{ malformed", "utf8");
  const baseline = await provider.read({ context });
  assert.equal(baseline.configured.values.find((entry) => entry.key === "compaction.enabled" && entry.scope === "project")?.state, "invalid");
  const result = await provider.prepare!({
    context,
    transactionId: "malformed",
    expectedRevisions: baseline.configured.resources,
    changes: [{ operation: "set", key: "compaction.enabled", scope: "project", value: true }],
  });
  assert.equal(result.prepared, false);
  assert.ok(result.validation.issues.some((entry) => entry.messageKey === "flow.settings.malformedResource"));
  assert.equal(fs.readFileSync(projectSettings, "utf8"), "{ malformed");
});

test("Flow provider detects etag conflicts before staging", async () => {
  const { provider, context, globalSettings } = fixture();
  writeJson(globalSettings, { compaction: { enabled: true } });
  const baseline = await provider.read({ context });
  writeJson(globalSettings, { compaction: { enabled: false } });
  const prepared = await provider.prepare!({
    context,
    transactionId: "conflict",
    expectedRevisions: baseline.configured.resources,
    changes: [{ operation: "set", key: "compaction.enabled", scope: "global", value: true }],
  });
  assert.equal(prepared.prepared, false);
  assert.equal(prepared.conflicts?.length, 1);
});

test("Flow provider rechecks revisions at commit and preserves a post-prepare external write", async () => {
  const { provider, context, globalSettings } = fixture();
  writeJson(globalSettings, { compaction: { enabled: false }, owner: "baseline" });
  const baseline = await provider.read({ context });
  const prepared = await provider.prepare!({
    context,
    transactionId: "late-conflict",
    expectedRevisions: baseline.configured.resources,
    changes: [{ operation: "set", key: "compaction.enabled", scope: "global", value: true }],
  });
  const external = `${JSON.stringify({ compaction: { enabled: false }, owner: "external" }, null, 2)}\n`;
  fs.writeFileSync(globalSettings, external, "utf8");
  await assert.rejects(
    provider.commit!({ context, transactionId: "late-conflict", prepareToken: prepared.prepareToken! }),
    /changed after prepare/,
  );
  assert.equal(fs.readFileSync(globalSettings, "utf8"), external);
  await provider.abort!({ context, transactionId: "late-conflict", prepareToken: prepared.prepareToken! });
});

test("Flow provider restores a Windows replacement when the second rename fails", async () => {
  let installAttempts = 0;
  let journalObserved = false;
  let backupObserved = false;
  const { provider, context, globalSettings } = fixture({
    replacementOperations: {
      platform: "win32",
      renameSync(source, destination) {
        if (source.endsWith(".tmp") && destination === globalSettings) {
          installAttempts += 1;
          if (installAttempts === 1) {
            throw Object.assign(new Error("injected replacement conflict"), { code: "EPERM" });
          }
          if (installAttempts === 2) {
            const entries = fs.readdirSync(path.dirname(destination));
            journalObserved = entries.includes(`${path.basename(destination)}.replace-journal`);
            backupObserved = entries.some((entry) => entry.startsWith(`${path.basename(destination)}.`) && entry.endsWith(".backup"));
            throw Object.assign(new Error("injected install failure"), { code: "EIO" });
          }
        }
        fs.renameSync(source, destination);
      },
    },
  });
  const original = '{"owner":"original","compaction":{"enabled":false}}\n';
  fs.mkdirSync(path.dirname(globalSettings), { recursive: true });
  fs.writeFileSync(globalSettings, original, "utf8");
  const baseline = await provider.read({ context });
  const prepared = await provider.prepare!({
    context,
    transactionId: "windows-second-rename-failure",
    expectedRevisions: baseline.configured.resources,
    changes: [{ operation: "set", key: "compaction.enabled", scope: "global", value: true }],
  });

  await assert.rejects(
    provider.commit!({
      context,
      transactionId: "windows-second-rename-failure",
      prepareToken: prepared.prepareToken!,
    }),
    /injected install failure/,
  );

  assert.equal(installAttempts, 2);
  assert.equal(journalObserved, true);
  assert.equal(backupObserved, true);
  assert.equal(fs.readFileSync(globalSettings, "utf8"), original);
  assert.deepEqual(fs.readdirSync(path.dirname(globalSettings)), [path.basename(globalSettings)]);
});

test("Flow provider recovers a journaled backup when immediate restoration faults", async () => {
  let installAttempts = 0;
  let backupRestoreAttempts = 0;
  const { provider, context, globalSettings } = fixture({
    replacementOperations: {
      platform: "win32",
      renameSync(source, destination) {
        if (source.endsWith(".tmp") && destination === globalSettings) {
          installAttempts += 1;
          throw Object.assign(
            new Error(installAttempts === 1 ? "injected replacement conflict" : "injected install failure"),
            { code: installAttempts === 1 ? "EPERM" : "EIO" },
          );
        }
        if (source.endsWith(".backup") && destination === globalSettings && backupRestoreAttempts++ === 0) {
          throw Object.assign(new Error("injected restore failure"), { code: "EBUSY" });
        }
        fs.renameSync(source, destination);
      },
    },
  });
  const original = '{"owner":"recoverable","compaction":{"enabled":false}}\n';
  fs.mkdirSync(path.dirname(globalSettings), { recursive: true });
  fs.writeFileSync(globalSettings, original, "utf8");
  const baseline = await provider.read({ context });
  const prepared = await provider.prepare!({
    context,
    transactionId: "windows-journal-recovery",
    expectedRevisions: baseline.configured.resources,
    changes: [{ operation: "set", key: "compaction.enabled", scope: "global", value: true }],
  });

  await assert.rejects(
    provider.commit!({
      context,
      transactionId: "windows-journal-recovery",
      prepareToken: prepared.prepareToken!,
    }),
    /Could not install or restore/,
  );

  assert.equal(installAttempts, 2);
  assert.ok(backupRestoreAttempts >= 2);
  assert.equal(fs.readFileSync(globalSettings, "utf8"), original);
  assert.deepEqual(fs.readdirSync(path.dirname(globalSettings)), [path.basename(globalSettings)]);
});

test("Flow provider recovers a destination-missing Windows replacement before restart reads and prepare", async () => {
  const readCase = fixture({ replacementOperations: { platform: "win32" } });
  const readBytes = '{"owner":"read-restart","compaction":{"enabled":false,"sibling":{"keep":1}},"rootSibling":true}\r\n';
  const readArtifacts = synthesizeInterruptedReplacement(readCase.globalSettings, readBytes);
  const readProvider = readCase.createProvider();

  const recoveredSnapshot = await readProvider.read({ context: readCase.context });

  assert.equal(fs.readFileSync(readCase.globalSettings, "utf8"), readBytes);
  assert.equal(
    recoveredSnapshot.configured.values.find((entry) => entry.key === "compaction.enabled" && entry.scope === "global")?.value,
    false,
  );
  assert.equal(fs.existsSync(readArtifacts.backup), false);
  assert.equal(fs.existsSync(readArtifacts.journal), false);

  const prepareCase = fixture({ replacementOperations: { platform: "win32" } });
  const prepareBytes = '{"owner":"prepare-restart","compaction":{"enabled":false,"sibling":{"keep":2}},"rootSibling":{"keep":3}}\r\n';
  const prepareArtifacts = synthesizeInterruptedReplacement(prepareCase.globalSettings, prepareBytes);
  const prepareProvider = prepareCase.createProvider();

  const prepared = await prepareProvider.prepare!({
    context: prepareCase.context,
    transactionId: "windows-restart-prepare",
    changes: [{ operation: "set", key: "compaction.enabled", scope: "global", value: true }],
  });

  assert.equal(prepared.prepared, true);
  assert.equal(fs.readFileSync(prepareCase.globalSettings, "utf8"), prepareBytes);
  assert.equal(fs.existsSync(prepareArtifacts.backup), false);
  assert.equal(fs.existsSync(prepareArtifacts.journal), false);

  await prepareProvider.commit!({
    context: prepareCase.context,
    transactionId: "windows-restart-prepare",
    prepareToken: prepared.prepareToken!,
  });
  const committed = JSON.parse(fs.readFileSync(prepareCase.globalSettings, "utf8"));
  assert.equal(committed.owner, "prepare-restart");
  assert.equal(committed.compaction.enabled, true);
  assert.deepEqual(committed.compaction.sibling, { keep: 2 });
  assert.deepEqual(committed.rootSibling, { keep: 3 });
  assert.deepEqual(fs.readdirSync(path.dirname(prepareCase.globalSettings)), [path.basename(prepareCase.globalSettings)]);
});

test("Flow provider rollback after a failed commit does not overwrite the external write", async () => {
  const { provider, context, globalSettings } = fixture();
  writeJson(globalSettings, { compaction: { enabled: false }, owner: "baseline" });
  const baseline = await provider.read({ context });
  const prepared = await provider.prepare!({
    context,
    transactionId: "rollback-after-fail",
    expectedRevisions: baseline.configured.resources,
    changes: [{ operation: "set", key: "compaction.enabled", scope: "global", value: true }],
  });
  const external = `${JSON.stringify({ compaction: { enabled: false }, owner: "external-write" }, null, 2)}\n`;
  fs.writeFileSync(globalSettings, external, "utf8");
  await assert.rejects(
    provider.commit!({ context, transactionId: "rollback-after-fail", prepareToken: prepared.prepareToken! }),
    /changed after prepare/,
  );
  // The host follows the protocol and asks for a rollback; it must refuse to restore
  // prepare-time bytes because the transaction never committed (no committedRevision).
  const rollback = await provider.rollback!({ context, transactionId: "rollback-after-fail", prepareToken: prepared.prepareToken! });
  assert.equal(rollback.rolledBack, false);
  assert.equal(fs.readFileSync(globalSettings, "utf8"), external);
});

test("Flow provider rollback restores exact original bytes after the prepare expiry window", async () => {
  const { provider, context, projectSettings, projectFailover } = fixture({ preparedTransactionTtlMs: 30 });
  const settingsBytes = '{"unknown":1,"compaction":{"enabled":false}}\n';
  const failoverBytes = '{"enabled":false,"fallbackModels":{},"unknown":2}\n';
  fs.mkdirSync(path.dirname(projectSettings), { recursive: true });
  fs.writeFileSync(projectSettings, settingsBytes);
  fs.writeFileSync(projectFailover, failoverBytes);
  const baseline = await provider.read({ context });
  const changes = [
    { operation: "set" as const, key: "compaction.enabled", scope: "project" as const, value: true },
    { operation: "set" as const, key: "failover.enabled", scope: "project" as const, value: true },
  ];
  const prepared = await provider.prepare!({ context, transactionId: "rollback", changes, expectedRevisions: baseline.configured.resources });
  const committed = await provider.commit!({ context, transactionId: "rollback", prepareToken: prepared.prepareToken! });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const rolledBack = await provider.rollback!({
    context,
    transactionId: "rollback",
    prepareToken: prepared.prepareToken!,
    committedRevisions: committed.revisions,
  });
  assert.equal(rolledBack.rolledBack, true);
  assert.equal(fs.readFileSync(projectSettings, "utf8"), settingsBytes);
  assert.equal(fs.readFileSync(projectFailover, "utf8"), failoverBytes);
});

test("Flow provider invokes plugin-owned actions and participates in discovery", async () => {
  const calls: string[] = [];
  const { context } = fixture();
  let chinese = false;
  const provider = createFlowSettingsProvider({
    getAgentResponseLanguage: () => chinese ? "zh-CN" : "default",
    actions: {
      "responseLanguage.manage": () => { chinese = !chinese; return chinese ? "已切换到中文回复" : "已切换到默认回复"; },
    },
  });
  assert.equal((await provider.read({ context })).effective.values.find((entry) => entry.key === "responseLanguage.manage")?.value, "default");
  const acted = await provider.invokeAction!({ context, actionId: "responseLanguage.manage" });
  assert.equal(acted.handled, true);
  assert.equal(acted.refresh, true);
  assert.equal(acted.message, "已切换到中文回复");
  assert.equal((await provider.read({ context })).effective.values.find((entry) => entry.key === "responseLanguage.manage")?.value, "zh-CN");

  const events = new EventEmitter();
  registerFlowSettingsProvider(events, provider);
  const announcements: unknown[] = [];
  events.on(SETTINGS_ANNOUNCE_EVENT, (payload) => announcements.push(payload));
  events.emit(SETTINGS_DISCOVER_EVENT, { version: SETTINGS_PROTOCOL_VERSION, requestId: "request", context });
  assert.equal(announcements.length, 1);
  assert.equal((announcements[0] as { requestId: string }).requestId, "request");
});

test("Flow provider round-trips the registered soft compaction fields", async () => {
  const { provider, context, globalSettings } = fixture();
  const baseline = await provider.read({ context });
  const changes = [
    { operation: "set" as const, key: "compaction.soft.cache.minRatioRange", scope: "global" as const, value: [0.2, 0.6] },
    { operation: "set" as const, key: "compaction.soft.timeBased.enabled", scope: "global" as const, value: true },
    { operation: "set" as const, key: "compaction.soft.timeBased.gapThresholdMinutes", scope: "global" as const, value: 90 },
    { operation: "set" as const, key: "compaction.soft.relevance.enabled", scope: "global" as const, value: true },
    { operation: "set" as const, key: "compaction.soft.relevance.mode", scope: "global" as const, value: "keyword" },
    { operation: "set" as const, key: "compaction.soft.crossTurnDedup.minLines", scope: "global" as const, value: 5 },
    { operation: "set" as const, key: "compaction.soft.lossless.enabled", scope: "global" as const, value: false },
  ];
  const prepared = await provider.prepare!({ context, transactionId: "soft", changes, expectedRevisions: baseline.configured.resources });
  assert.equal(prepared.prepared, true);
  await provider.commit!({ context, transactionId: "soft", prepareToken: prepared.prepareToken! });

  const settings = JSON.parse(fs.readFileSync(globalSettings, "utf8"));
  assert.deepEqual(settings.compaction.soft.cache.minRatioRange, [0.2, 0.6]);
  assert.equal(settings.compaction.soft.timeBased.enabled, true);
  assert.equal(settings.compaction.soft.timeBased.gapThresholdMinutes, 90);
  assert.equal(settings.compaction.soft.relevance.mode, "keyword");
  assert.equal(settings.compaction.soft.crossTurnDedup.minLines, 5);
  assert.equal(settings.compaction.soft.lossless.enabled, false);

  const snapshot = await provider.read({ context });
  const effective = snapshot.effective.values;
  assert.deepEqual(effective.find((entry) => entry.key === "compaction.soft.cache.minRatioRange")?.value, [0.2, 0.6]);
  assert.equal(effective.find((entry) => entry.key === "compaction.soft.timeBased.enabled")?.value, true);
  assert.equal(effective.find((entry) => entry.key === "compaction.soft.timeBased.gapThresholdMinutes")?.value, 90);
  assert.equal(effective.find((entry) => entry.key === "compaction.soft.relevance.mode")?.value, "keyword");
  assert.equal(effective.find((entry) => entry.key === "compaction.soft.lossless.enabled")?.value, false);
  const configured = snapshot.configured.values.filter((entry) => entry.key === "compaction.soft.timeBased.enabled");
  assert.equal(configured[0]?.state, "set");
  assert.equal(configured[0]?.scope, "global");
});

test("Flow provider rejects invalid values for registered compaction fields", async () => {
  const { provider, context } = fixture();
  const baseline = await provider.read({ context });
  const invalidChanges = [
    { operation: "set" as const, key: "compaction.soft.cache.minRatioRange", scope: "global" as const, value: [0.6, 0.2] },
    { operation: "set" as const, key: "compaction.model", scope: "global" as const, value: "   " },
    { operation: "set" as const, key: "compaction.reserveTokens", scope: "global" as const, value: 1.5 },
    { operation: "set" as const, key: "compaction.soft.crossTurnDedup.minLines", scope: "global" as const, value: 0 },
    { operation: "set" as const, key: "compaction.soft.relevance.mode", scope: "global" as const, value: "tfidf" },
  ];
  const prepared = await provider.prepare!({ context, transactionId: "invalid", changes: invalidChanges, expectedRevisions: baseline.configured.resources });
  assert.equal(prepared.prepared, false);
  assert.ok(prepared.validation.issues.length >= invalidChanges.length);
});

test("failover chain edits through the list-crud value persist to the file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-failover-crud-"));
  try {
    const globalFailover = path.join(root, "home", "model-failover.json");
    const projectFailover = path.join(root, "project", ".pi", "model-failover.json");
    fs.mkdirSync(path.dirname(projectFailover), { recursive: true });
    const provider = createFlowSettingsProvider({
      getGlobalFailoverPath: () => globalFailover,
      getProjectFailoverPath: () => projectFailover,
    });
    const context: SettingsContextV1 = { cwd: path.join(root, "project"), locale: "en" };
    writeJson(projectFailover, { enabled: true, fallbackModels: { "openai/main": ["qwen/fallback"] } });
    const snapshot = await provider.read({ context });
    assert.deepEqual(snapshot.effective.values.find((entry) => entry.key === "failover.fallbackModels")?.value, [
      { model: "openai/main", fallbacks: ["qwen/fallback"] },
    ]);
    const prepared = await provider.prepare!({
      context,
      transactionId: "tx-fc",
      changes: [{ operation: "set", key: "failover.fallbackModels", scope: "project", value: [
        { model: "openai/main", fallbacks: ["qwen/fallback", "anthropic/fallback"] },
        { model: "deepseek/main", fallbacks: ["qwen/main"] },
      ] }],
    });
    assert.equal(prepared.prepared, true);
    await provider.commit!({ context, transactionId: "tx-fc", prepareToken: prepared.prepareToken! });
    const written = JSON.parse(fs.readFileSync(projectFailover, "utf8"));
    assert.deepEqual(written.fallbackModels, {
      "openai/main": ["qwen/fallback", "anthropic/fallback"],
      "deepseek/main": ["qwen/main"],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Flow provider exposes the permission rules as a read-only overview", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-settings-provider-perm-"));
  try {
    const context: SettingsContextV1 = { cwd: path.join(root, "project"), locale: "en" };
    const provider = createFlowSettingsProvider({
      getGlobalSettingsPath: () => path.join(root, "home", "settings.json"),
      getProjectSettingsPath: () => path.join(root, "project", ".pi", "settings.json"),
      getGlobalFailoverPath: () => path.join(root, "home", "model-failover.json"),
      getProjectFailoverPath: () => path.join(root, "project", ".pi", "model-failover.json"),
      getPermissionOverview: () => ({
        mode: "default",
        allow: ["Read(x)"],
        ask: ["Bash(git *)"],
        deny: ["Bash(rm *)"],
        sources: "home settings.json",
      }),
    });
    const description = await provider.describe({ context });
    assert.ok(description.settings.some((entry) => entry.key === "flow.permissions" && entry.editor.kind === "overview"));
    assert.ok(!description.settings.some((entry) => entry.key === "permissions.manage"), "legacy action removed");
    const snapshot = await provider.read({ context });
    const rows = snapshot.effective.values.find((entry) => entry.key === "flow.permissions")?.value as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(rows));
    assert.equal(rows[0]?.labelKey, "flow.permissions.mode");
    assert.equal(rows[0]?.value, "default");
    assert.ok(rows.some((row) => row.labelKey === "flow.permissions.allow" && row.value === "Read(x)"));
    assert.ok(rows.some((row) => row.labelKey === "flow.permissions.sources"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
