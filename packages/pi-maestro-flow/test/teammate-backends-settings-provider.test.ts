import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SettingsContextV1 } from "pi-maestro-settings-core/v1";
import { SETTINGS_SECRET_SET_PLACEHOLDER } from "pi-maestro-settings-core/v1/schema";
import { createTeammateBackendsSettingsProvider } from "../src/settings/teammate-backends-settings-provider.ts";

const PI_TEST_CATALOG = {
  en: {
    "pi.resultReadyGraceMs": "Result-ready grace (ms)",
  },
  "zh-CN": {
    "pi.resultReadyGraceMs": "结果就绪宽限（毫秒）",
  },
} as const;

const DSH_TEST_CATALOG = {
  en: {
    "dsh.cordisConfig": "cordis.yml path",
    "dsh.model": "Model",
    "dsh.apiKeyEnv": "API key variable name",
  },
  "zh-CN": {
    "dsh.cordisConfig": "cordis.yml 路径",
    "dsh.model": "模型",
    "dsh.apiKeyEnv": "API 密钥变量名",
  },
} as const;

const context: SettingsContextV1 = { cwd: "/workspace", locale: "en" };

const BACKENDS = [
  { name: "pi-subprocess", module: "pi-subprocess", configFields: [
    { key: "resultReadyGraceMs", kind: "integer" as const, labelKey: "pi.resultReadyGraceMs" },
  ], catalogs: PI_TEST_CATALOG },
  { name: "dsh", module: "pi-maestro-backends/dsh", configFields: [
    { key: "cordisConfig", kind: "path" as const, labelKey: "dsh.cordisConfig", required: true },
    { key: "model", kind: "text" as const, labelKey: "dsh.model", default: "deepseek-v4-flash" },
    {
      key: "apiKeyEnv",
      kind: "credential-ref" as const,
      credentialLocation: "env-file-key" as const,
      labelKey: "dsh.apiKeyEnv",
      default: "DEEPSEEK_API_KEY",
    },
  ], catalogs: DSH_TEST_CATALOG },
];

function provider() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "tb-ws-"));
  const credentialRoot = mkdtempSync(join(tmpdir(), "tb-cred-"));
  return {
    workspaceRoot,
    credentialRoot,
    documentPath: join(workspaceRoot, ".pi", "teammate-backends.json"),
    envPath: (backend: string) => join(credentialRoot, backend, ".env"),
    instance: createTeammateBackendsSettingsProvider({ workspaceRoot, backends: BACKENDS, credentialRoot }),
  };
}

async function commit(p: ReturnType<typeof provider>, changes: Parameters<typeof p.instance.validate>[0]["changes"]) {
  const prepared = await p.instance.prepare!({ context, transactionId: "t-1", changes });
  if (!prepared.prepared) return prepared.validation;
  await p.instance.commit!({ context, transactionId: "t-1", prepareToken: prepared.prepareToken! });
  return prepared.validation;
}

test("each backend's own declared fields become settings without this provider knowing them", async () => {
  const p = provider();
  const described = await p.instance.describe({ context });
  const keys = described.settings.map((s) => s.key);
  assert.ok(keys.includes("teammateBackends.mode"));
  assert.ok(keys.includes("teammateBackends.pi-subprocess.resultReadyGraceMs"));
  assert.ok(keys.includes("teammateBackends.dsh.cordisConfig"));
  assert.ok(keys.includes("teammateBackends.dsh.model"));
});

test("a credential field yields a public name and a secret value, in different scopes", async () => {
  const p = provider();
  const described = await p.instance.describe({ context });
  const name = described.settings.find((s) => s.key === "teammateBackends.dsh.apiKeyEnv");
  const value = described.settings.find((s) => s.key === "teammateBackends.dsh.apiKeyEnv.value");
  assert.equal(name?.sensitivity, "public");
  assert.deepEqual(name?.scopes, ["project"]);
  assert.equal(value?.sensitivity, "secret");
  assert.deepEqual(value?.scopes, ["global"]);
  assert.equal(value?.editor.kind, "secret");
});

test("provider, mode, backend, field, and error keys have bilingual catalogs", async () => {
  const p = provider();
  const description = await p.instance.describe({ context });
  const catalogs = description.catalogs!;
  const referenced = new Set<string>([
    description.labelKey,
    description.descriptionKey!,
    "teammateBackends.error.documentMalformed",
    "teammateBackends.error.unknownKey",
    "teammateBackends.error.invalidMode",
    "teammateBackends.error.unknownBackend",
    "teammateBackends.error.credentialNameInvalid",
    "teammateBackends.error.credentialNameMissing",
    "teammateBackends.error.credentialValueInvalid",
  ]);
  for (const setting of description.settings) {
    referenced.add(setting.group);
    referenced.add(setting.labelKey);
    if (setting.descriptionKey) referenced.add(setting.descriptionKey);
    for (const option of setting.editor.options ?? []) referenced.add(option.labelKey);
  }
  for (const key of referenced) {
    assert.ok(catalogs.en[key], `English catalog missing ${key}`);
    assert.ok(catalogs["zh-CN"][key], `Chinese catalog missing ${key}`);
    assert.notEqual(catalogs.en[key], key, `English catalog exposes raw key ${key}`);
    assert.notEqual(catalogs["zh-CN"][key], key, `Chinese catalog exposes raw key ${key}`);
  }
});

test("the dispatch mode defaults to legacy so an unwritten document changes nothing", async () => {
  const p = provider();
  const snapshot = await p.instance.read({ context });
  const mode = snapshot.effective.values.find((v) => v.key === "teammateBackends.mode");
  assert.equal(mode?.value, "legacy");
  assert.equal(mode?.source, "default");
});

test("commit reports the keys it applied and activates", async () => {
  const p = provider();
  const changes = [
    { operation: "set" as const, key: "teammateBackends.mode", scope: "project" as const, value: "backend-registry" },
    { operation: "set" as const, key: "teammateBackends.dsh.model", scope: "project" as const, value: "deepseek-v4" },
  ];
  const prepared = await p.instance.prepare!({ context, transactionId: "t-metadata", changes });
  assert.equal(prepared.prepared, true);
  const committed = await p.instance.commit!({
    context,
    transactionId: "t-metadata",
    prepareToken: prepared.prepareToken!,
  });
  const keys = changes.map((change) => change.key);
  assert.deepEqual(committed.changedKeys, keys);
  assert.deepEqual(committed.activation, [{ boundary: "next-invocation", keys }]);
});

test("setting the mode writes it to the registration document", async () => {
  const p = provider();
  await commit(p, [{ operation: "set", key: "teammateBackends.mode", scope: "project", value: "backend-registry" }]);
  const document = JSON.parse(readFileSync(p.documentPath, "utf-8"));
  assert.equal(document.mode, "backend-registry");
});

test("an invalid mode is rejected instead of written", async () => {
  const p = provider();
  const result = await commit(p, [{ operation: "set", key: "teammateBackends.mode", scope: "project", value: "registry" }]);
  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.code, "invalid-mode");
  assert.equal(existsSync(p.documentPath), false);
});

test("a default naming an unregistered backend is rejected", async () => {
  const p = provider();
  const result = await commit(p, [{ operation: "set", key: "teammateBackends.default", scope: "project", value: "codex" }]);
  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.code, "unknown-backend");
});

test("an unknown key is rejected rather than silently ignored", async () => {
  const p = provider();
  const result = await commit(p, [{ operation: "set", key: "teammateBackends.dsh.nonsense", scope: "project", value: 1 }]);
  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.code, "unknown-key");
});

test("backend fields land under that backend's registration", async () => {
  const p = provider();
  await commit(p, [
    { operation: "set", key: "teammateBackends.dsh.cordisConfig", scope: "project", value: "/etc/dsh/cordis.yml" },
    { operation: "set", key: "teammateBackends.dsh.model", scope: "project", value: "deepseek-v4" },
  ]);
  const document = JSON.parse(readFileSync(p.documentPath, "utf-8"));
  assert.equal(document.backends.dsh.config.cordisConfig, "/etc/dsh/cordis.yml");
  assert.equal(document.backends.dsh.config.model, "deepseek-v4");
});

test("a credential value goes to the runtime's env file and never into the document", async () => {
  const p = provider();
  await commit(p, [
    { operation: "set", key: "teammateBackends.dsh.apiKeyEnv.value", scope: "global", value: "sk-not-a-real-key" },
  ]);
  const document = readFileSync(p.documentPath, "utf-8");
  assert.equal(document.includes("sk-not-a-real-key"), false);
  const env = readFileSync(p.envPath("dsh"), "utf-8");
  assert.match(env, /^DEEPSEEK_API_KEY=sk-not-a-real-key$/m);
});

test("credential values containing CR, LF, or NUL fail closed without being echoed", async () => {
  for (const [name, value] of [
    ["LF", "sk-secret\nINJECTED=1"],
    ["CR", "sk-secret\rINJECTED=1"],
    ["NUL", "sk-secret\0INJECTED=1"],
  ] as const) {
    const p = provider();
    const result = await commit(p, [{
      operation: "set",
      key: "teammateBackends.dsh.apiKeyEnv.value",
      scope: "global",
      value,
    }]);
    assert.equal(result.valid, false, `${name} must be rejected`);
    assert.equal(result.issues[0]?.code, "credential-value-invalid");
    assert.equal(JSON.stringify(result).includes("INJECTED=1"), false);
    assert.equal(existsSync(p.envPath("dsh")), false);
  }
});

test("the credential file is written owner-only", async () => {
  const p = provider();
  await commit(p, [
    { operation: "set", key: "teammateBackends.dsh.apiKeyEnv.value", scope: "global", value: "sk-x" },
  ]);
  if (process.platform !== "win32") {
    assert.equal(statSync(p.envPath("dsh")).mode & 0o777, 0o600);
  }
});

test("a set credential reads back masked, never echoed", async () => {
  const p = provider();
  await commit(p, [
    { operation: "set", key: "teammateBackends.dsh.apiKeyEnv.value", scope: "global", value: "sk-secret" },
  ]);
  const snapshot = await p.instance.read({ context });
  const value = snapshot.configured.values.find((v) => v.key === "teammateBackends.dsh.apiKeyEnv.value");
  assert.equal(value?.state, "set");
  assert.equal(value?.value, SETTINGS_SECRET_SET_PLACEHOLDER);
  assert.equal(JSON.stringify(snapshot).includes("sk-secret"), false);
});

test("clearing a credential removes the entry rather than blanking it", async () => {
  const p = provider();
  await commit(p, [
    { operation: "set", key: "teammateBackends.dsh.apiKeyEnv.value", scope: "global", value: "sk-x" },
  ]);
  const second = createTeammateBackendsSettingsProvider({
    workspaceRoot: p.workspaceRoot, backends: BACKENDS, credentialRoot: p.credentialRoot,
  });
  const prepared = await second.prepare!({
    context,
    transactionId: "t-2",
    changes: [{ operation: "unset", key: "teammateBackends.dsh.apiKeyEnv.value", scope: "global" }],
  });
  await second.commit!({ context, transactionId: "t-2", prepareToken: prepared.prepareToken! });
  assert.equal(readFileSync(p.envPath("dsh"), "utf-8").includes("DEEPSEEK_API_KEY"), false);
});

test("a custom variable name is honoured for the credential entry", async () => {
  const p = provider();
  await commit(p, [
    { operation: "set", key: "teammateBackends.dsh.apiKeyEnv", scope: "project", value: "MY_DEEPSEEK_KEY" },
  ]);
  const second = createTeammateBackendsSettingsProvider({
    workspaceRoot: p.workspaceRoot, backends: BACKENDS, credentialRoot: p.credentialRoot,
  });
  const prepared = await second.prepare!({
    context,
    transactionId: "t-3",
    changes: [{ operation: "set", key: "teammateBackends.dsh.apiKeyEnv.value", scope: "global", value: "sk-y" }],
  });
  await second.commit!({ context, transactionId: "t-3", prepareToken: prepared.prepareToken! });
  assert.match(readFileSync(p.envPath("dsh"), "utf-8"), /^MY_DEEPSEEK_KEY=sk-y$/m);
});

test("committing without a prepared transaction is refused", async () => {
  const p = provider();
  await assert.rejects(
    async () => p.instance.commit!({ context, transactionId: "t-9", prepareToken: "t-9" }),
    /no prepared transaction/,
  );
});

test("a registration names the loadable module, not the backend's own name", async () => {
  const p = provider();
  await commit(p, [
    { operation: "set", key: "teammateBackends.dsh.cordisConfig", scope: "project", value: "/etc/dsh/cordis.yml" },
  ]);
  const document = JSON.parse(readFileSync(p.documentPath, "utf-8"));
  assert.equal(document.backends.dsh.module, "pi-maestro-backends/dsh");
});

test("a written document always names a mode and a default, so the registry can load it", async () => {
  const p = provider();
  await commit(p, [
    { operation: "set", key: "teammateBackends.dsh.model", scope: "project", value: "deepseek-v4" },
  ]);
  const document = JSON.parse(readFileSync(p.documentPath, "utf-8"));
  // The reader rejects a document missing either; editing one backend field
  // must not produce a file that the very next dispatch refuses to load.
  assert.equal(document.mode, "legacy");
  assert.equal(document.default, "pi-subprocess");
});

test("a pasted key in the reference field is rejected without being echoed back", async () => {
  const p = provider();
  const result = await commit(p, [
    { operation: "set", key: "teammateBackends.dsh.apiKeyEnv", scope: "project", value: "sk-0123456789abcdef" },
  ]);
  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.code, "credential-name-invalid");
  assert.equal(JSON.stringify(result.issues).includes("sk-0123456789abcdef"), false);
  assert.equal(existsSync(p.documentPath), false);
});

test("a name that would inject a second variable is rejected", async () => {
  const p = provider();
  const result = await commit(p, [
    { operation: "set", key: "teammateBackends.dsh.apiKeyEnv", scope: "project", value: "A=1\nPATH" },
  ]);
  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.code, "credential-name-invalid");
});

test("renaming the variable carries its value instead of stranding it", async () => {
  const p = provider();
  await commit(p, [
    { operation: "set", key: "teammateBackends.dsh.apiKeyEnv.value", scope: "global", value: "sk-carried" },
  ]);
  const second = createTeammateBackendsSettingsProvider({
    workspaceRoot: p.workspaceRoot, backends: BACKENDS, credentialRoot: p.credentialRoot,
  });
  const prepared = await second.prepare!({
    context,
    transactionId: "t-rename",
    changes: [{ operation: "set", key: "teammateBackends.dsh.apiKeyEnv", scope: "project", value: "OTHER_KEY" }],
  });
  await second.commit!({ context, transactionId: "t-rename", prepareToken: prepared.prepareToken! });
  const env = readFileSync(p.envPath("dsh"), "utf-8");
  assert.match(env, /^OTHER_KEY=sk-carried$/m);
  assert.equal(env.includes("DEEPSEEK_API_KEY="), false);
});

test("unrelated lines in the runtime's env file survive a credential write", async () => {
  const p = provider();
  mkdirSync(join(p.credentialRoot, "dsh"), { recursive: true });
  writeFileSync(
    p.envPath("dsh"),
    "# operator note\nDSH_LOG_LEVEL=debug\nDEEPSEEK_API_KEY=sk-old\n",
    "utf-8",
  );
  await commit(p, [
    { operation: "set", key: "teammateBackends.dsh.apiKeyEnv.value", scope: "global", value: "sk-new" },
  ]);
  const env = readFileSync(p.envPath("dsh"), "utf-8");
  assert.match(env, /^# operator note$/m);
  assert.match(env, /^DSH_LOG_LEVEL=debug$/m);
  assert.match(env, /^DEEPSEEK_API_KEY=sk-new$/m);
  assert.equal(env.includes("sk-old"), false);
});

test("the credential directory is owner-only, not just the file", async () => {
  const p = provider();
  await commit(p, [
    { operation: "set", key: "teammateBackends.dsh.apiKeyEnv.value", scope: "global", value: "sk-x" },
  ]);
  if (process.platform !== "win32") {
    assert.equal(statSync(join(p.credentialRoot, "dsh")).mode & 0o777, 0o700);
  }
});

test("a credential the host cannot place gets no editor rather than a misplaced write", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "tb-ws-"));
  const credentialRoot = mkdtempSync(join(tmpdir(), "tb-cred-"));
  const instance = createTeammateBackendsSettingsProvider({
    workspaceRoot,
    credentialRoot,
    backends: [{
      name: "envvar", module: "some-backend", configFields: [{
        key: "token",
        kind: "credential-ref" as const,
        credentialLocation: "env-var" as const,
        labelKey: "envvar.token",
      }],
    }],
  });
  const keys = (await instance.describe({ context })).settings.map((s) => s.key);
  // The reference name is still editable; only the secret value is refused,
  // because this provider writes into the runtime's own env file and nothing
  // would ever read a process variable it cannot set.
  assert.ok(keys.includes("teammateBackends.envvar.token"));
  assert.equal(keys.includes("teammateBackends.envvar.token.value"), false);
});

test("a refused credential is absent from read() too, not just from describe()", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "tb-ws-"));
  const credentialRoot = mkdtempSync(join(tmpdir(), "tb-cred-"));
  const instance = createTeammateBackendsSettingsProvider({
    workspaceRoot,
    credentialRoot,
    backends: [{
      name: "envvar", module: "some-backend", configFields: [{
        key: "token",
        kind: "credential-ref" as const,
        credentialLocation: "env-var" as const,
        labelKey: "envvar.token",
      }],
    }],
  });
  const snapshot = await instance.read({ context });
  // Reporting a value for a setting describe() does not declare leaves the
  // shell holding a key it cannot render, edit, or explain.
  const declared = new Set((await instance.describe({ context })).settings.map((s) => s.key));
  for (const value of snapshot.configured.values) {
    assert.ok(declared.has(value.key), `read() reported undeclared setting ${value.key}`);
  }
});

test("a malformed document is left alone rather than replaced with a plausible one", async () => {
  const p = provider();
  mkdirSync(join(p.workspaceRoot, ".pi"), { recursive: true });
  const broken = '{ "mode": "backend-registry", "backends": { "dsh": }\n';
  writeFileSync(p.documentPath, broken, "utf-8");
  const result = await commit(p, [
    { operation: "set", key: "teammateBackends.mode", scope: "project", value: "legacy" },
  ]);
  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.code, "document-malformed");
  // The operator's file is what they are about to repair; a commit rebuilt
  // from the empty parse would silently destroy it.
  assert.equal(readFileSync(p.documentPath, "utf-8"), broken);
});

test("the shell still renders over a malformed document", async () => {
  const p = provider();
  mkdirSync(join(p.workspaceRoot, ".pi"), { recursive: true });
  writeFileSync(p.documentPath, "{ not json", "utf-8");
  const snapshot = await p.instance.read({ context });
  assert.equal(
    snapshot.effective.values.find((v) => v.key === "teammateBackends.mode")?.value,
    "legacy",
  );
});

test("a document edited after prepare is refused rather than overwritten", async () => {
  const p = provider();
  const prepared = await p.instance.prepare!({
    context,
    transactionId: "t-cas",
    changes: [{ operation: "set", key: "teammateBackends.mode", scope: "project", value: "backend-registry" }],
  });
  // Somebody else writes the document between prepare and commit.
  mkdirSync(join(p.workspaceRoot, ".pi"), { recursive: true });
  writeFileSync(p.documentPath, JSON.stringify({ mode: "legacy", default: "dsh", backends: {} }), "utf-8");
  await assert.rejects(
    async () => p.instance.commit!({ context, transactionId: "t-cas", prepareToken: prepared.prepareToken! }),
    /changed since this transaction was prepared/,
  );
  assert.equal(JSON.parse(readFileSync(p.documentPath, "utf-8")).default, "dsh");
});

test("a model-registry backend edit preserves every non-target v2 section and unknown field", async () => {
  const p = provider();
  mkdirSync(join(p.workspaceRoot, ".pi"), { recursive: true });
  const original = {
    version: 2,
    mode: "model-registry",
    default: "dsh.prod",
    defaultModel: "registry/default",
    thirdPartyTopLevel: { retain: true },
    backends: {
      "dsh.prod": {
        module: "pi-maestro-backends/dsh",
        registrationNote: "retain",
        config: { model: "old-model", cordisConfig: "/old.yml", unknownFlag: true },
      },
      "vendor.deploy": {
        module: "vendor/private-adapter",
        config: { opaque: "retain", credentialRef: "VENDOR_TOKEN" },
        vendorExtension: ["retain"],
      },
    },
    models: {
      "registry/default": {
        modelId: "private/intrinsic",
        deployment: "dsh.prod",
        selector: { kind: "adapter-model", value: "old-model" },
        deploymentDefault: true,
      },
    },
    compatibility: {
      version: 1,
      modelAliases: { "registry/old": "registry/default" },
      remoteLocations: {},
    },
  };
  writeFileSync(p.documentPath, JSON.stringify(original), "utf-8");

  const described = await p.instance.describe({ context });
  assert.ok(described.settings.some((setting) => setting.key === "teammateBackends.dsh.prod.model"));
  assert.ok(described.settings.some((setting) => setting.key === "teammateBackends.mode"
    && setting.editor.kind === "enum"
    && setting.editor.options?.some((option) => option.value === "model-registry")));

  await commit(p, [{
    operation: "set",
    key: "teammateBackends.dsh.prod.model",
    scope: "project",
    value: "new-model",
  }]);
  const written = JSON.parse(readFileSync(p.documentPath, "utf-8"));
  assert.equal(written.backends["dsh.prod"].config.model, "new-model");
  assert.equal(written.backends["dsh.prod"].config.unknownFlag, true);
  assert.equal(written.backends["dsh.prod"].registrationNote, "retain");
  assert.deepEqual(written.backends["vendor.deploy"], original.backends["vendor.deploy"]);
  assert.deepEqual(written.models, original.models);
  assert.deepEqual(written.compatibility, original.compatibility);
  assert.deepEqual(written.thirdPartyTopLevel, original.thirdPartyTopLevel);
  assert.equal(written.version, 2);
  assert.equal(written.defaultModel, "registry/default");
});

test("custom deployment keys are resolved exactly even when ids contain dots or prefix each other", async () => {
  const p = provider();
  mkdirSync(join(p.workspaceRoot, ".pi"), { recursive: true });
  writeFileSync(p.documentPath, JSON.stringify({
    version: 2,
    mode: "model-registry",
    default: "dsh",
    defaultModel: "registry/default",
    backends: {
      dsh: { module: "pi-maestro-backends/dsh", config: { model: "base" } },
      "dsh.prod": { module: "pi-maestro-backends/dsh", config: { model: "prod" } },
    },
    models: {
      "registry/default": {
        modelId: "private/default",
        deployment: "dsh",
        selector: { kind: "adapter-model", value: "base" },
        deploymentDefault: true,
      },
    },
  }), "utf-8");

  await commit(p, [{
    operation: "set",
    key: "teammateBackends.dsh.prod.model",
    scope: "project",
    value: "prod-next",
  }]);
  const written = JSON.parse(readFileSync(p.documentPath, "utf-8"));
  assert.equal(written.backends.dsh.config.model, "base");
  assert.equal(written.backends["dsh.prod"].config.model, "prod-next");
});

test("an occupied built-in name with a different module is not given the built-in editor", async () => {
  const p = provider();
  mkdirSync(join(p.workspaceRoot, ".pi"), { recursive: true });
  writeFileSync(p.documentPath, JSON.stringify({
    mode: "backend-registry",
    default: "dsh",
    backends: { dsh: { module: "vendor/not-dsh", config: { model: "opaque" } } },
  }), "utf-8");
  const keys = (await p.instance.describe({ context })).settings.map((setting) => setting.key);
  assert.equal(keys.includes("teammateBackends.dsh.model"), false);
  const result = await commit(p, [{
    operation: "set",
    key: "teammateBackends.dsh.model",
    scope: "project",
    value: "must-not-write",
  }]);
  assert.equal(result.valid, false);
  assert.equal(JSON.parse(readFileSync(p.documentPath, "utf-8")).backends.dsh.config.model, "opaque");
});


test("a dynamic field is described as a sourced picker and filled from the backend", async () => {
  const probes: { field: string; config: Record<string, unknown> }[] = [];
  const workspaceRoot = mkdtempSync(join(tmpdir(), "tb-dyn-"));
  mkdirSync(join(workspaceRoot, ".pi"), { recursive: true });
  writeFileSync(
    join(workspaceRoot, ".pi", "teammate-backends.json"),
    JSON.stringify({
      mode: "backend-registry",
      default: "cursor",
      backends: { cursor: { module: "m", config: { command: "agent", args: ["acp"] } } },
    }),
  );
  const instance = createTeammateBackendsSettingsProvider({
    workspaceRoot,
    backends: [{
      name: "cursor",
      module: "m",
      configFields: [{ key: "acpModel", kind: "dynamic-enum" as const, labelKey: "x.acpModel" }],
      listConfigOptions: async (field, config) => {
        probes.push({ field, config });
        return [{ value: "composer-2.5[fast=true]", label: "composer-2.5" }];
      },
    }],
  });

  // The description names a source rather than carrying values it cannot know.
  const described = await instance.describe({ context });
  const definition = described.settings.find((setting) => setting.key === "teammateBackends.cursor.acpModel");
  assert.ok(definition, "expected the dynamic field to be described");
  assert.equal(definition!.editor.kind, "enum");
  assert.equal(typeof definition!.editor.optionsSource, "string");
  assert.equal(definition!.editor.options, undefined);

  const listed = await instance.listOptions!({
    context,
    key: "teammateBackends.cursor.acpModel",
    optionsSource: definition!.editor.optionsSource!,
  });
  assert.equal(listed.failure, undefined);
  assert.deepEqual(listed.options, [{ value: "composer-2.5[fast=true]", label: "composer-2.5" }]);
  // The probe was handed the registration being edited, not an empty config, so
  // it launches what that registration actually configures.
  assert.equal(probes[0]?.field, "acpModel");
  assert.deepEqual(probes[0]?.config, { command: "agent", args: ["acp"] });
});

test("an options source that cannot answer is reported as a failure, not an empty list", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "tb-dyn-fail-"));
  const instance = createTeammateBackendsSettingsProvider({
    workspaceRoot,
    backends: [{
      name: "cursor",
      module: "m",
      configFields: [{ key: "acpModel", kind: "dynamic-enum" as const, labelKey: "x.acpModel" }],
      listConfigOptions: async () => {
        throw new Error("CLI tool \"cursor\" is not launchable: executable \"agent\" unreachable");
      },
    }],
  });
  const listed = await instance.listOptions!({
    context,
    key: "teammateBackends.cursor.acpModel",
    optionsSource: "teammateBackends.backend-options",
  });
  // Empty would read as "this backend offers no models"; the operator needs the
  // reason instead, because it is something they can act on.
  assert.deepEqual(listed.options, []);
  assert.match(listed.failure ?? "", /not launchable/);

  const unknown = await instance.listOptions!({
    context,
    key: "teammateBackends.cursor.acpModel",
    optionsSource: "some.other.source",
  });
  assert.match(unknown.failure ?? "", /Unknown options source/);
});
