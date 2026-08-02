import assert from "node:assert/strict";
import test from "node:test";
import type {
  SettingDefinition,
  SettingsChange,
  SettingsContextV1,
  SettingsProviderV1,
  SettingsSnapshot,
} from "pi-maestro-settings-core/v1";

const context: SettingsContextV1 = {
  cwd: "/workspace",
  locale: "en",
  projectTrusted: true,
};

const definition = {
  key: "ui.locale",
  group: "general",
  labelKey: "settings.locale.label",
  descriptionKey: "settings.locale.description",
  defaultValue: "en",
  scopes: ["global"],
  merge: "override",
  activation: "live",
  sensitivity: "public",
  reversibility: "full",
  editor: {
    kind: "enum",
    options: [
      { value: "en", labelKey: "locale.en" },
      { value: "zh-CN", labelKey: "locale.zh-CN" },
    ],
  },
} satisfies SettingDefinition;

const snapshot: SettingsSnapshot = {
  providerId: "example",
  providerInstanceId: "example-1",
  configured: {
    values: [
      { key: definition.key, scope: "global", state: "absent" },
    ],
    resources: [],
  },
  effective: {
    values: [
      {
        key: definition.key,
        value: definition.defaultValue,
        source: "default",
      },
    ],
  },
};

const changes = [
  { operation: "set", key: definition.key, scope: "global", value: "zh-CN" },
] satisfies readonly SettingsChange[];

const provider: SettingsProviderV1 = {
  describe: () => ({
    id: "example",
    version: "1.0.0",
    instanceId: "example-1",
    labelKey: "provider.example",
    capabilities: {
      read: true,
      write: true,
      prepareCommit: true,
      rollback: "full",
      hotUpdate: true,
    },
    settings: [definition],
    catalogs: {
      en: { "provider.example": "Example" },
      "zh-CN": { "provider.example": "示例" },
    },
  }),
  read: () => snapshot,
  validate: (request) => ({
    valid: request.changes.length > 0,
    issues: [],
  }),
  prepare: (request) => ({
    prepared: true,
    prepareToken: `${request.transactionId}:prepared`,
    validation: { valid: true, issues: [] },
    activation: [{ boundary: "live", keys: request.changes.map((change) => change.key) }],
  }),
  commit: () => ({
    snapshot,
    revisions: [],
    changedKeys: [definition.key],
    activation: [{ boundary: "live", keys: [definition.key] }],
  }),
  abort: () => undefined,
  rollback: () => ({ rolledBack: true, snapshot }),
  applyRuntime: () => ({
    appliedKeys: [definition.key],
    deferred: [],
    failed: [],
  }),
  invokeAction: (request) => ({ handled: request.actionId === "open-advanced" }),
};

test("public schema and provider type samples are executable", async () => {
  assert.equal(changes.length, 1);
  assert.equal((await provider.describe({ context })).id, "example");
  assert.equal((await provider.read({ context })).effective.values[0]?.value, "en");
  assert.equal(
    (await provider.validate({ context, transactionId: "tx-1", changes })).valid,
    true,
  );
});
