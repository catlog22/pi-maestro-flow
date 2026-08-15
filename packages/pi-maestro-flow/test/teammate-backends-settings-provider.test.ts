import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SettingsContextV1 } from "pi-maestro-settings-core/v1";
import { SETTINGS_SECRET_SET_PLACEHOLDER } from "pi-maestro-settings-core/v1/schema";
import { createTeammateBackendsSettingsProvider } from "../src/settings/teammate-backends-settings-provider.ts";

const context: SettingsContextV1 = { cwd: "/workspace", locale: "en" };

const BACKENDS = [
  { name: "pi-subprocess", module: "pi-subprocess", configFields: [
    { key: "resultReadyGraceMs", kind: "integer" as const, labelKey: "pi.resultReadyGraceMs" },
  ] },
  { name: "dsh", module: "pi-maestro-backends/dsh", configFields: [
    { key: "cordisConfig", kind: "path" as const, labelKey: "dsh.cordisConfig", required: true },
    { key: "model", kind: "text" as const, labelKey: "dsh.model", default: "deepseek-v4-flash" },
    {
      key: "apiKeyEnv",
      kind: "credential-ref" as const,
      credentialLocation: "env-var" as const,
      labelKey: "dsh.apiKeyEnv",
      default: "DEEPSEEK_API_KEY",
    },
  ] },
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

test("the dispatch mode defaults to legacy so an unwritten document changes nothing", async () => {
  const p = provider();
  const snapshot = await p.instance.read({ context });
  const mode = snapshot.effective.values.find((v) => v.key === "teammateBackends.mode");
  assert.equal(mode?.value, "legacy");
  assert.equal(mode?.source, "default");
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

test("the credential file is written owner-only", async () => {
  const p = provider();
  await commit(p, [
    { operation: "set", key: "teammateBackends.dsh.apiKeyEnv.value", scope: "global", value: "sk-x" },
  ]);
  assert.equal(statSync(p.envPath("dsh")).mode & 0o777, 0o600);
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
  assert.equal(statSync(join(p.credentialRoot, "dsh")).mode & 0o777, 0o700);
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
