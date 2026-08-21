import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SettingDefinition, SettingsContextV1 } from "pi-maestro-settings-core/v1";
import dshBackend, { DSH_SETTINGS_CATALOGS } from "pi-maestro-backends/dsh";
import acpCliBackend, { ACP_CLI_SETTINGS_CATALOGS } from "pi-maestro-teammate/v1/acp-cli";
import { createApiManagerSettingsProvider } from "../src/settings/api-manager-settings-provider.ts";
import { createFlowSettingsProvider } from "../src/settings/flow-settings-provider.ts";
import { createMcpSettingsProvider } from "../src/settings/mcp-settings-provider.ts";
import { createSkillsSettingsProvider } from "../src/settings/skills-settings-provider.ts";
import { createSmartSearchSettingsProvider } from "../src/settings/smart-search-settings-provider.ts";
import { createTeammateBackendsSettingsProvider } from "../src/settings/teammate-backends-settings-provider.ts";

const context: SettingsContextV1 = { cwd: "/workspace", locale: "en" };

function referencedKeys(settings: readonly SettingDefinition[]): Set<string> {
  const keys = new Set<string>();
  for (const entry of settings) {
    keys.add(entry.group);
    keys.add(entry.labelKey);
    if (entry.descriptionKey) keys.add(entry.descriptionKey);
    if (entry.editor.options) {
      for (const option of entry.editor.options) {
        // Dynamic options (theme names, provider ids) use the value as their own
        // labelKey and render via the key-fallback; they are not catalog keys.
        if (option.labelKey === String(option.value)) continue;
        keys.add(option.labelKey);
        if (option.descriptionKey) keys.add(option.descriptionKey);
      }
    }
    if (entry.editor.itemFields) {
      for (const field of entry.editor.itemFields) {
        keys.add(field.group);
        keys.add(field.labelKey);
        if (field.descriptionKey) keys.add(field.descriptionKey);
      }
    }
    if (entry.editor.addLabelKey) keys.add(entry.editor.addLabelKey);
    if (entry.editor.itemLabelKey) keys.add(entry.editor.itemLabelKey);
  }
  return keys;
}

function assertBilingualCatalog(name: string, settings: readonly SettingDefinition[], catalogs: unknown): void {
  const catalog = catalogs as { en: Record<string, string>; "zh-CN": Record<string, string> };
  const en = catalog.en ?? {};
  const zh = catalog["zh-CN"] ?? {};
  const enKeys = new Set(Object.keys(en));
  const zhKeys = new Set(Object.keys(zh));
  const missingInZh = [...enKeys].filter((key) => !zhKeys.has(key));
  const missingInEn = [...zhKeys].filter((key) => !enKeys.has(key));
  assert.deepEqual(missingInZh, [], `${name}: en keys missing from zh-CN`);
  assert.deepEqual(missingInEn, [], `${name}: zh-CN keys missing from en`);
  for (const key of referencedKeys(settings)) {
    assert.ok(enKeys.has(key), `${name}: referenced key "${key}" missing from en catalog`);
    assert.ok(zhKeys.has(key), `${name}: referenced key "${key}" missing from zh-CN catalog`);
  }
}

/**
 * Builds the teammate-backends provider over the backends the extension really
 * registers, so this gate reads the shipped wiring rather than a fixture: a
 * backend whose fields arrive without a catalog is exactly the defect that has
 * to fail here.
 */
function teammateBackendsProvider(catalogs: {
  dsh?: typeof DSH_SETTINGS_CATALOGS;
  acpCli?: typeof ACP_CLI_SETTINGS_CATALOGS;
}) {
  return createTeammateBackendsSettingsProvider({
    workspaceRoot: mkdtempSync(join(tmpdir(), "catalog-ws-")),
    credentialRoot: mkdtempSync(join(tmpdir(), "catalog-cred-")),
    backends: [
      {
        name: dshBackend.name,
        module: "pi-maestro-backends/dsh",
        configFields: dshBackend.configFields,
        ...(catalogs.dsh === undefined ? {} : { catalogs: catalogs.dsh }),
      },
      {
        name: acpCliBackend.name,
        module: "pi-maestro-teammate/v1/acp-cli",
        configFields: acpCliBackend.configFields,
        ...(catalogs.acpCli === undefined ? {} : { catalogs: catalogs.acpCli }),
      },
    ],
  });
}

test("every settings provider ships a complete en/zh-CN catalog with identical key sets", async () => {
  const providers = [
    { name: "flow", describe: (await createFlowSettingsProvider({}).describe({ context })) },
    { name: "api-manager", describe: (await createApiManagerSettingsProvider({}).describe({ context })) },
    { name: "mcp", describe: (await createMcpSettingsProvider({}).describe({ context })) },
    { name: "skills", describe: (await createSkillsSettingsProvider({}).describe({ context })) },
    { name: "smart-search", describe: (await createSmartSearchSettingsProvider({}).describe({ context })) },
    {
      name: "teammate-backends",
      describe: await teammateBackendsProvider({
        dsh: DSH_SETTINGS_CATALOGS,
        acpCli: ACP_CLI_SETTINGS_CATALOGS,
      }).describe({ context }),
    },
  ];
  for (const { name, describe } of providers) {
    assertBilingualCatalog(name, describe.settings, describe.catalogs);
  }
});

test("a backend registered without a catalog fails the same gate rather than rendering its keys", async () => {
  const described = await teammateBackendsProvider({ dsh: DSH_SETTINGS_CATALOGS }).describe({ context });
  assert.throws(
    () => assertBilingualCatalog("teammate-backends", described.settings, described.catalogs),
    /acpCli\./,
  );
});

test("list-crud item fields and label keys are all translated", async () => {
  const providers = [
    { name: "api-manager", describe: (await createApiManagerSettingsProvider({}).describe({ context })) },
    { name: "mcp", describe: (await createMcpSettingsProvider({}).describe({ context })) },
    { name: "skills", describe: (await createSkillsSettingsProvider({}).describe({ context })) },
  ];
  for (const { name, describe } of providers) {
    const listCrud = describe.settings.filter((entry) => entry.editor.kind === "list-crud");
    assert.ok(listCrud.length > 0, `${name}: expected at least one list-crud setting`);
    for (const entry of listCrud) {
      assert.ok(entry.editor.itemFields && entry.editor.itemFields.length > 0, `${name}: list-crud must declare itemFields`);
      assertBilingualCatalog(`${name}.${entry.key}`, entry.editor.itemFields, describe.catalogs);
    }
  }
});
