import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  SETTINGS_ANNOUNCE_EVENT,
  SETTINGS_DISCOVER_EVENT,
  SETTINGS_PROTOCOL_VERSION,
  type SettingsAnnounceEventV1,
  type SettingsContextV1,
} from "pi-maestro-settings-core/v1";
import {
  createTeammateSettingsProvider,
  registerTeammateSettingsProvider,
} from "../src/settings/teammate-settings-provider.ts";

const context = (cwd: string): SettingsContextV1 => ({ cwd, locale: "en" });

function paths(root: string) {
  return {
    global: path.join(root, "global", "teammate-models.json"),
    project: (cwd: string) => path.join(cwd, ".pi", "teammate-models.json"),
  };
}

function providerAt(root: string, action?: () => void) {
  const configPaths = paths(root);
  return createTeammateSettingsProvider({
    getGlobalPath: () => configPaths.global,
    getProjectPath: configPaths.project,
    discoverTaskTypes: () => ["analysis", "testing"],
    openLegacySettings: action,
  });
}

class FakeEventBus {
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
  on(event: string, handler: (payload: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }
  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

test("Teammate provider exposes model, fallback and thinking routing per task type", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teammate-settings-provider-"));
  try {
    const provider = providerAt(root);
    const description = await provider.describe({ context: context(root) });
    assert.equal(description.id, "pi-maestro-teammate");
    assert.equal(description.capabilities.rollback, "compensating");
    assert.equal(description.settings.filter((setting) => setting.group === "routing.analysis").length, 3);
    assert.ok(description.settings.some((setting) => setting.key === "routing.analysis.model" && setting.editor.kind === "model"));
    assert.ok(description.settings.some((setting) => setting.key === "routing.testing.thinking" && setting.editor.kind === "enum"));
    const keys = new Set(description.settings.flatMap((entry) => [
      entry.group,
      entry.labelKey,
      ...(entry.descriptionKey ? [entry.descriptionKey] : []),
      ...(entry.editor.options?.map((option) => option.labelKey) ?? []),
    ]));
    for (const locale of ["en", "zh-CN"] as const) {
      const catalog = description.catalogs?.[locale];
      assert.ok(catalog);
      for (const key of keys) assert.equal(typeof catalog[key], "string", `${locale} missing ${key}`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("configured values preserve global/project scopes and project overrides effective routing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teammate-settings-provider-"));
  try {
    const configPaths = paths(root);
    fs.mkdirSync(path.dirname(configPaths.global), { recursive: true });
    fs.mkdirSync(path.dirname(configPaths.project(root)), { recursive: true });
    fs.writeFileSync(configPaths.global, JSON.stringify({
      version: 3,
      defaultProfile: "default",
      profiles: { default: { name: "Default", mappings: { analysis: "global/model" }, thinkingLevels: { analysis: "low" } } },
    }));
    fs.writeFileSync(configPaths.project(root), JSON.stringify({
      version: 3,
      activeProfile: "default",
      applyOverrides: true,
      overrides: { mappings: { analysis: "project/model" }, fallbackMappings: { analysis: ["backup/a"] }, thinkingLevels: {} },
    }));
    const snapshot = await providerAt(root).read({ context: context(root) });
    assert.equal(snapshot.configured.values.find((value) => value.key === "routing.analysis.model" && value.scope === "global")?.value, "global/model");
    assert.equal(snapshot.configured.values.find((value) => value.key === "routing.analysis.model" && value.scope === "project")?.value, "project/model");
    assert.equal(snapshot.effective.values.find((value) => value.key === "routing.analysis.model")?.value, "project/model");
    assert.equal(snapshot.effective.values.find((value) => value.key === "routing.analysis.model")?.scope, "project");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("multi-scope commit preserves profiles and defers until next invocation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teammate-settings-provider-"));
  try {
    const configPaths = paths(root);
    fs.mkdirSync(path.dirname(configPaths.global), { recursive: true });
    fs.mkdirSync(path.dirname(configPaths.project(root)), { recursive: true });
    fs.writeFileSync(configPaths.global, JSON.stringify({
      version: 3,
      defaultProfile: "default",
      profiles: {
        default: { name: "Default", mappings: { future: "keep" }, thinkingLevels: {} },
        secondary: { name: "Secondary", mappings: { analysis: "secondary/model" }, thinkingLevels: {} },
      },
    }));
    fs.writeFileSync(configPaths.project(root), JSON.stringify({
      version: 3,
      activeProfile: "default",
      applyOverrides: true,
      overrides: { mappings: {}, fallbackMappings: { future: ["keep"] }, thinkingLevels: {} },
    }));
    const provider = providerAt(root);
    const before = await provider.read({ context: context(root) });
    const changes = [
      { operation: "set" as const, key: "routing.analysis.model", scope: "global" as const, value: "provider/primary" },
      { operation: "set" as const, key: "routing.analysis.fallbacks", scope: "project" as const, value: ["provider/a", "provider/a", "provider/b"] },
      { operation: "set" as const, key: "routing.analysis.thinking", scope: "project" as const, value: "high" },
    ];
    const prepared = await provider.prepare!({ context: context(root), transactionId: "tx", changes, expectedRevisions: before.configured.resources });
    assert.equal(prepared.prepared, true);
    const committed = await provider.commit!({ context: context(root), transactionId: "tx", prepareToken: prepared.prepareToken! });
    const runtime = await provider.applyRuntime!({ context: context(root), transactionId: "tx", changes, snapshot: committed.snapshot });
    assert.deepEqual(runtime.deferred, [{ boundary: "next-invocation", keys: changes.map((change) => change.key) }]);
    const globalRaw = JSON.parse(fs.readFileSync(configPaths.global, "utf8"));
    const projectRaw = JSON.parse(fs.readFileSync(configPaths.project(root), "utf8"));
    assert.equal(globalRaw.profiles.default.mappings.future, "keep");
    assert.equal(globalRaw.profiles.default.mappings.analysis, "provider/primary");
    assert.equal(globalRaw.profiles.secondary.mappings.analysis, "secondary/model");
    assert.equal(projectRaw.activeProfile, "default");
    assert.equal(projectRaw.applyOverrides, true);
    assert.deepEqual(projectRaw.overrides.fallbackMappings.future, ["keep"]);
    assert.deepEqual(projectRaw.overrides.fallbackMappings.analysis, ["provider/a", "provider/b"]);
    assert.equal(projectRaw.overrides.thinkingLevels.analysis, "high");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("unset removes only the selected scope override", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teammate-settings-provider-"));
  try {
    const configPaths = paths(root);
    fs.mkdirSync(path.dirname(configPaths.global), { recursive: true });
    fs.mkdirSync(path.dirname(configPaths.project(root)), { recursive: true });
    fs.writeFileSync(configPaths.global, JSON.stringify({
      version: 3,
      defaultProfile: "default",
      profiles: { default: { name: "Default", mappings: { analysis: "global/model" }, thinkingLevels: {} } },
    }));
    fs.writeFileSync(configPaths.project(root), JSON.stringify({
      version: 3,
      activeProfile: "default",
      applyOverrides: true,
      overrides: { mappings: { analysis: "project/model", future: "keep" }, thinkingLevels: {} },
    }));
    const provider = providerAt(root);
    const before = await provider.read({ context: context(root) });
    const changes = [{ operation: "unset" as const, key: "routing.analysis.model", scope: "project" as const }];
    const prepared = await provider.prepare!({ context: context(root), transactionId: "unset", changes, expectedRevisions: before.configured.resources });
    const committed = await provider.commit!({ context: context(root), transactionId: "unset", prepareToken: prepared.prepareToken! });
    await provider.applyRuntime!({ context: context(root), transactionId: "unset", changes, snapshot: committed.snapshot });
    const raw = JSON.parse(fs.readFileSync(configPaths.project(root), "utf8"));
    assert.equal(raw.overrides.mappings.analysis, undefined);
    assert.equal(raw.overrides.mappings.future, "keep");
    assert.equal(raw.activeProfile, "default");
    assert.equal(committed.snapshot.effective.values.find((value) => value.key === "routing.analysis.model")?.value, "global/model");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("disabled project overrides remain configured but do not change effective routing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teammate-settings-provider-"));
  try {
    const configPaths = paths(root);
    fs.mkdirSync(path.dirname(configPaths.global), { recursive: true });
    fs.mkdirSync(path.dirname(configPaths.project(root)), { recursive: true });
    fs.writeFileSync(configPaths.global, JSON.stringify({
      version: 3,
      defaultProfile: "default",
      profiles: { default: { name: "Default", mappings: { analysis: "global/model" }, thinkingLevels: {} } },
    }));
    fs.writeFileSync(configPaths.project(root), JSON.stringify({
      version: 3,
      activeProfile: "default",
      applyOverrides: false,
      overrides: { mappings: { analysis: "project/model" }, thinkingLevels: {} },
    }));
    const snapshot = await providerAt(root).read({ context: context(root) });
    assert.equal(snapshot.configured.values.find((value) => value.key === "routing.analysis.model" && value.scope === "project")?.value, "project/model");
    assert.equal(snapshot.effective.values.find((value) => value.key === "routing.analysis.model")?.value, "global/model");
    assert.equal(snapshot.effective.values.find((value) => value.key === "routing.analysis.model")?.scope, "global");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("malformed routing resources fail preparation without changing bytes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teammate-settings-provider-"));
  try {
    const configPaths = paths(root);
    fs.mkdirSync(path.dirname(configPaths.project(root)), { recursive: true });
    const malformed = "{ not-json";
    fs.writeFileSync(configPaths.project(root), malformed);
    const provider = providerAt(root);
    const before = await provider.read({ context: context(root) });
    const result = await provider.prepare!({
      context: context(root),
      transactionId: "malformed",
      changes: [{ operation: "set", key: "routing.analysis.model", scope: "project", value: "ours/model" }],
      expectedRevisions: before.configured.resources,
    });
    assert.equal(result.prepared, false);
    assert.equal(fs.readFileSync(configPaths.project(root), "utf8"), malformed);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("stale revision conflicts do not overwrite external routing changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teammate-settings-provider-"));
  try {
    const configPaths = paths(root);
    const provider = providerAt(root);
    const before = await provider.read({ context: context(root) });
    fs.mkdirSync(path.dirname(configPaths.project(root)), { recursive: true });
    fs.writeFileSync(configPaths.project(root), JSON.stringify({
      version: 3,
      activeProfile: "default",
      applyOverrides: true,
      overrides: { mappings: { analysis: "external/model" }, thinkingLevels: {} },
    }));
    const result = await provider.prepare!({
      context: context(root),
      transactionId: "conflict",
      changes: [{ operation: "set", key: "routing.analysis.model", scope: "project", value: "ours/model" }],
      expectedRevisions: before.configured.resources,
    });
    assert.equal(result.prepared, false);
    assert.equal(result.conflicts?.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(configPaths.project(root), "utf8")).overrides.mappings.analysis, "external/model");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("committed global and project changes roll back to exact previous bytes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teammate-settings-provider-"));
  try {
    const configPaths = paths(root);
    fs.mkdirSync(path.dirname(configPaths.global), { recursive: true });
    fs.mkdirSync(path.dirname(configPaths.project(root)), { recursive: true });
    const globalBefore = `${JSON.stringify({
      version: 3,
      defaultProfile: "default",
      profiles: { default: { name: "Default", mappings: { analysis: "g" }, thinkingLevels: {} } },
    }, null, 2)}\n`;
    const projectBefore = `${JSON.stringify({
      version: 3,
      activeProfile: "default",
      applyOverrides: true,
      overrides: { mappings: { analysis: "p" }, thinkingLevels: {} },
    }, null, 2)}\n`;
    fs.writeFileSync(configPaths.global, globalBefore);
    fs.writeFileSync(configPaths.project(root), projectBefore);
    const provider = providerAt(root);
    const before = await provider.read({ context: context(root) });
    const changes = [
      { operation: "set" as const, key: "routing.analysis.model", scope: "global" as const, value: "new-g" },
      { operation: "set" as const, key: "routing.analysis.model", scope: "project" as const, value: "new-p" },
    ];
    const prepared = await provider.prepare!({ context: context(root), transactionId: "rollback", changes, expectedRevisions: before.configured.resources });
    const committed = await provider.commit!({ context: context(root), transactionId: "rollback", prepareToken: prepared.prepareToken! });
    const rollback = await provider.rollback!({ context: context(root), transactionId: "rollback", prepareToken: prepared.prepareToken!, committedRevisions: committed.revisions });
    assert.equal(rollback.rolledBack, true);
    assert.equal(fs.readFileSync(configPaths.global, "utf8"), globalBefore);
    assert.equal(fs.readFileSync(configPaths.project(root), "utf8"), projectBefore);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("legacy action and synchronous discovery stay provider-owned", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teammate-settings-provider-"));
  try {
    let actions = 0;
    const provider = providerAt(root, () => { actions++; });
    await provider.invokeAction!({ context: context(root), actionId: "teammate.routing.manage" });
    assert.equal(actions, 1);
    const bus = new FakeEventBus();
    registerTeammateSettingsProvider(bus, provider);
    bus.emit(SETTINGS_DISCOVER_EVENT, { version: SETTINGS_PROTOCOL_VERSION, requestId: "r", context: context(root) });
    const announcements = bus.emitted.filter((entry) => entry.event === SETTINGS_ANNOUNCE_EVENT);
    assert.equal(announcements.length, 2);
    assert.equal((announcements[1]?.payload as SettingsAnnounceEventV1).providerId, "pi-maestro-teammate");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
