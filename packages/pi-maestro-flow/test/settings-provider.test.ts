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
} from "../src/settings/flow-settings-provider.ts";
import {
  createApiManagerSettingsProvider,
  registerApiManagerSettingsProvider,
} from "../src/settings/api-manager-settings-provider.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-settings-provider-"));
  const globalSettings = path.join(root, "home", "settings.json");
  const projectSettings = path.join(root, "project", ".pi", "settings.json");
  const globalFailover = path.join(root, "home", "model-failover.json");
  const projectFailover = path.join(root, "project", ".pi", "model-failover.json");
  const context: SettingsContextV1 = { cwd: path.join(root, "project"), locale: "en" };
  const provider = createFlowSettingsProvider({
    getGlobalSettingsPath: () => globalSettings,
    getProjectSettingsPath: () => projectSettings,
    getGlobalFailoverPath: () => globalFailover,
    getProjectFailoverPath: () => projectFailover,
  });
  return { root, globalSettings, projectSettings, globalFailover, projectFailover, context, provider };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("Flow provider describes editable settings, complex actions and bilingual catalogs", async () => {
  const { provider, context } = fixture();
  const description = await provider.describe({ context });
  assert.equal(description.id, "pi-maestro-flow");
  assert.equal(description.capabilities.prepareCommit, true);
  assert.ok(description.settings.some((entry) => entry.key === "compaction.soft.velocity.minFullness"));
  assert.equal(description.settings.find((entry) => entry.key === "compaction.keepRecentTokens")?.editor.max, 2_000_000);
  assert.ok(description.settings.some((entry) => entry.key === "failover.fallbackModels" && entry.editor.kind === "json"));
  assert.ok(description.settings.some((entry) => entry.key === "mcp.manage" && entry.editor.kind === "action"));
  const responseLanguage = description.settings.find((entry) => entry.key === "responseLanguage.manage");
  assert.equal(responseLanguage?.descriptionKey, "flow.action.responseLanguage.description");
  assert.deepEqual(responseLanguage?.editor.options?.map((entry) => entry.value), ["default", "zh-CN"]);
  assert.equal(description.catalogs?.en["flow.compaction.enabled"], "Enable compaction");
  assert.equal(description.catalogs?.["zh-CN"]["flow.compaction.enabled"], "启用上下文压缩");
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

test("API Manager provider exposes focused actions and invokes the original manager routes", async () => {
  const calls: string[] = [];
  const provider = createApiManagerSettingsProvider({
    actions: {
      "api.manage": () => { calls.push("manage"); },
      "api.configure": () => { calls.push("configure"); },
      "api.retry": () => { calls.push("retry"); },
      "api.list": () => { calls.push("list"); },
    },
  });
  const context: SettingsContextV1 = { cwd: "/project", locale: "en" };
  const description = await provider.describe({ context });
  assert.equal(description.id, "pi-maestro-api-manager");
  assert.equal(description.labelKey, "api.provider");
  assert.equal(description.capabilities.write, false);
  assert.deepEqual(description.settings.map((entry) => entry.key), [
    "api.manage",
    "api.configure",
    "api.retry",
    "api.list",
  ]);
  assert.equal(description.catalogs?.["zh-CN"]["api.action.manage"], "打开完整 API Manager");
  const snapshot = await provider.read({ context });
  assert.equal(snapshot.effective.values.length, 4);
  for (const actionId of ["api.manage", "api.configure", "api.retry", "api.list"]) {
    assert.deepEqual(await provider.invokeAction!({ context, actionId }), { handled: true, refresh: false });
  }
  assert.deepEqual(calls, ["manage", "configure", "retry", "list"]);
  assert.equal((await provider.validate({
    context,
    transactionId: "read-only",
    changes: [{ operation: "set", key: "api.retry", scope: "global", value: true }],
  })).valid, false);

  const events = new EventEmitter();
  registerApiManagerSettingsProvider(events, provider);
  const announcements: unknown[] = [];
  events.on(SETTINGS_ANNOUNCE_EVENT, (payload) => announcements.push(payload));
  events.emit(SETTINGS_DISCOVER_EVENT, { version: SETTINGS_PROTOCOL_VERSION, requestId: "api-request", context });
  assert.equal((announcements.at(-1) as { providerId?: string }).providerId, "pi-maestro-api-manager");
});

test("Flow provider reports configured and effective values across global and project scopes", async () => {
  const { provider, context, globalSettings, projectSettings, globalFailover, projectFailover } = fixture();
  writeJson(globalSettings, { unknownRoot: true, compaction: { enabled: false, hard: { reserveTokens: 10000 }, soft: { enabled: false } } });
  writeJson(projectSettings, { compaction: { hard: { keepRecentTokens: 9000 }, soft: { enabled: true, velocity: { enabled: true } } } });
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
  assert.deepEqual(snapshot.effective.values.find((entry) => entry.key === "failover.fallbackModels")?.value, {
    "openai/main": ["qwen/fallback"],
    "qwen/main": ["openai/fallback"],
  });
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

test("Flow provider rollback restores exact original bytes", async () => {
  const { provider, context, projectSettings, projectFailover } = fixture();
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
      "skills.manage": () => { calls.push("skills"); },
      "responseLanguage.manage": () => { chinese = !chinese; },
    },
  });
  assert.deepEqual(await provider.invokeAction!({ context, actionId: "skills.manage" }), { handled: true, refresh: false });
  assert.deepEqual(calls, ["skills"]);
  assert.equal((await provider.read({ context })).effective.values.find((entry) => entry.key === "responseLanguage.manage")?.value, "default");
  assert.deepEqual(await provider.invokeAction!({ context, actionId: "responseLanguage.manage" }), { handled: true, refresh: true });
  assert.equal((await provider.read({ context })).effective.values.find((entry) => entry.key === "responseLanguage.manage")?.value, "zh-CN");

  const events = new EventEmitter();
  registerFlowSettingsProvider(events, provider);
  const announcements: unknown[] = [];
  events.on(SETTINGS_ANNOUNCE_EVENT, (payload) => announcements.push(payload));
  events.emit(SETTINGS_DISCOVER_EVENT, { version: SETTINGS_PROTOCOL_VERSION, requestId: "request", context });
  assert.equal(announcements.length, 1);
  assert.equal((announcements[0] as { requestId: string }).requestId, "request");
});
