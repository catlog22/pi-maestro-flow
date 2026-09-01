import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendConfigField } from "pi-maestro-backend-core/v1/backend";
import { renderLegacyUpgradeSkeleton } from "../src/models/cli-list.ts";
import {
  compileModelRegistryManifest,
  parseModelRegistryManifest,
} from "../src/models/model-registry.ts";
import type { RemoteConfigState, RemoteConfigStorePair } from "../src/remote/config.ts";
import { REMOTE_CONFIG_VERSION } from "../src/remote/types.ts";
import {
  wizardDeploymentAdd,
  wizardDeploymentEdit,
  wizardLegacyUpgrade,
  wizardRemoteHost,
  type WizardUi,
} from "../src/tui/connection-wizards.ts";

type ScriptedResponse =
  | { kind: "input"; value?: string }
  | { kind: "select"; value?: string }
  | { kind: "confirm"; value: boolean };

class ScriptedWizardUi implements WizardUi {
  readonly inputPrompts: string[] = [];
  readonly selectPrompts: Array<{ prompt: string; options: readonly string[] }> = [];
  readonly confirmPrompts: string[] = [];
  private readonly responses: ScriptedResponse[];

  constructor(responses: ScriptedResponse[]) {
    this.responses = [...responses];
  }

  async input(prompt: string): Promise<string | undefined> {
    this.inputPrompts.push(prompt);
    const response = this.responses.shift();
    assert.equal(response?.kind, "input", `unexpected input prompt: ${prompt}`);
    return response.kind === "input" ? response.value : undefined;
  }

  async select(prompt: string, options: readonly string[]): Promise<string | undefined> {
    this.selectPrompts.push({ prompt, options });
    const response = this.responses.shift();
    assert.equal(response?.kind, "select", `unexpected select prompt: ${prompt}`);
    return response.kind === "select" ? response.value : undefined;
  }

  async confirm(prompt: string): Promise<boolean> {
    this.confirmPrompts.push(prompt);
    const response = this.responses.shift();
    assert.equal(response?.kind, "confirm", `unexpected confirm prompt: ${prompt}`);
    return response.kind === "confirm" ? response.value : false;
  }

  assertDrained(): void {
    assert.deepEqual(this.responses, []);
  }
}

const input = (value?: string): ScriptedResponse => ({ kind: "input", value });
const select = (value?: string): ScriptedResponse => ({ kind: "select", value });
const confirm = (value: boolean): ScriptedResponse => ({ kind: "confirm", value });

function baselineManifest(): string {
  return `${JSON.stringify({
    version: 2,
    mode: "model-registry",
    default: "existing",
    defaultModel: "existing/default",
    backends: {
      existing: { module: "vendor/existing", config: { endpoint: "old" } },
    },
    models: {
      "existing/default": {
        modelId: "vendor/default",
        deployment: "existing",
        selector: { kind: "adapter-model", value: "shared/model" },
        deploymentDefault: true,
      },
    },
  }, null, 2)}\n`;
}

const THIRD_PARTY_FIELDS: readonly BackendConfigField[] = [
  { key: "endpoint", kind: "text", labelKey: "test.endpoint", required: true },
];

const SSH_REFERENCE_FIELDS: readonly BackendConfigField[] = [
  {
    key: "mode",
    kind: "enum",
    labelKey: "test.mode",
    options: [
      { value: "local", labelKey: "test.mode.local" },
      { value: "ssh", labelKey: "test.mode.ssh" },
    ],
    default: "local",
  },
  { key: "sshHostRef", kind: "text", labelKey: "test.sshHostRef" },
  { key: "host", kind: "text", labelKey: "test.host" },
  { key: "user", kind: "text", labelKey: "test.user" },
];

const importThirdParty = async (): Promise<unknown> => ({
  default: { configFields: THIRD_PARTY_FIELDS },
});

const importSshReferenceBackend = async (): Promise<unknown> => ({
  default: { configFields: SSH_REFERENCE_FIELDS },
});

test("deployment add publishes a compiler-valid manifest and rotates the baseline to .bak", async () => {
  const root = mkdtempSync(join(tmpdir(), "connection-wizard-add-"));
  const file = join(root, "registry.json");
  const baseline = baselineManifest();
  writeFileSync(file, baseline, "utf8");
  try {
    const ui = new ScriptedWizardUi([
      select("third-party"),
      input("vendor/new-backend"),
      input("new-deployment"),
      input("https://backend.example"),
      select("new-deployment"),
      input("new/default"),
      input("vendor/new-model"),
      select("deployment-default"),
      confirm(true),
    ]);
    const outcome = await wizardDeploymentAdd(ui, {
      filePath: file,
      manifestRaw: baseline,
      importModule: importThirdParty,
    });
    ui.assertDrained();
    assert.equal("reloadCatalog" in outcome ? outcome.reloadCatalog : false, true);
    const raw = readFileSync(file, "utf8");
    const manifest = parseModelRegistryManifest(raw, file);
    compileModelRegistryManifest(manifest);
    assert.equal(manifest.backends["new-deployment"]!.module, "vendor/new-backend");
    assert.equal(manifest.models["new/default"]!.deployment, "new-deployment");
    assert.equal(readFileSync(`${file}.bak`, "utf8"), baseline);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment add accepts sshHostRef without forcing embedded host and user", async () => {
  const root = mkdtempSync(join(tmpdir(), "connection-wizard-ssh-ref-add-"));
  const file = join(root, "registry.json");
  const baseline = baselineManifest();
  writeFileSync(file, baseline, "utf8");
  try {
    const ui = new ScriptedWizardUi([
      select("third-party"),
      input("vendor/ssh-reference"),
      input("referenced"),
      input("ssh"),
      select("Select from unlocked /ssh manager"),
      select("Production · manager-host"),
      input(""),
      input(""),
      select("referenced"),
      input("referenced/default"),
      input("vendor/model"),
      select("deployment-default"),
      confirm(true),
    ]);
    const outcome = await wizardDeploymentAdd(ui, {
      filePath: file,
      manifestRaw: baseline,
      importModule: importSshReferenceBackend,
      listHostRefs: async () => [{ id: "manager-host", label: "Production", compatible: true }],
    });
    ui.assertDrained();
    assert.equal("reloadCatalog" in outcome ? outcome.reloadCatalog : false, true);
    const manifest = parseModelRegistryManifest(readFileSync(file, "utf8"), file);
    assert.deepEqual(manifest.backends.referenced!.config, {
      mode: "ssh",
      sshHostRef: "manager-host",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment add reports a locked /ssh provider before collecting embedded fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "connection-wizard-ssh-ref-locked-"));
  const file = join(root, "registry.json");
  const baseline = baselineManifest();
  writeFileSync(file, baseline, "utf8");
  try {
    const ui = new ScriptedWizardUi([
      select("third-party"),
      input("vendor/ssh-reference"),
      input("referenced"),
      input("ssh"),
      select("Select from unlocked /ssh manager"),
    ]);
    const outcome = await wizardDeploymentAdd(ui, {
      filePath: file,
      manifestRaw: baseline,
      importModule: importSshReferenceBackend,
      listHostRefs: async () => { throw new Error("SSH manager is locked; open /ssh"); },
    });
    ui.assertDrained();
    assert.equal("ok" in outcome ? outcome.ok : true, false);
    assert.match("message" in outcome ? outcome.message ?? "" : "", /SSH manager is locked; open \/ssh/);
    assert.equal(readFileSync(file, "utf8"), baseline);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment edit accepts sshHostRef without forcing embedded host and user", async () => {
  const root = mkdtempSync(join(tmpdir(), "connection-wizard-ssh-ref-edit-"));
  const file = join(root, "registry.json");
  const baseline = `${JSON.stringify({
    version: 2,
    mode: "model-registry",
    default: "referenced",
    defaultModel: "referenced/default",
    backends: {
      referenced: { module: "vendor/ssh-reference", config: { mode: "local" } },
    },
    models: {
      "referenced/default": {
        modelId: "vendor/model",
        deployment: "referenced",
        selector: { kind: "deployment-default" },
        deploymentDefault: true,
      },
    },
  }, null, 2)}\n`;
  writeFileSync(file, baseline, "utf8");
  try {
    const ui = new ScriptedWizardUi([
      select("referenced/default"),
      input("ssh"),
      input("manager-host"),
      input(""),
      input(""),
    ]);
    const outcome = await wizardDeploymentEdit(ui, {
      filePath: file,
      manifestRaw: baseline,
      rows: [{
        registrationId: "referenced/default",
        modelId: "vendor/model",
        deploymentId: "referenced",
        deploymentDefault: true,
        harness: "adapter-owned",
        transportKind: "adapter-owned",
        protocol: "adapter-owned",
        modelSelection: "adapter-owned",
        registered: true,
        resolvable: true,
        healthyStatic: true,
        sessionAvailable: "n/a",
      }],
      importModule: importSshReferenceBackend,
    });
    ui.assertDrained();
    assert.equal("reloadCatalog" in outcome ? outcome.reloadCatalog : false, true);
    const manifest = parseModelRegistryManifest(readFileSync(file, "utf8"), file);
    assert.deepEqual(manifest.backends.referenced!.config, {
      mode: "ssh",
      sshHostRef: "manager-host",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate selector is numbered, then a corrected registration block succeeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "connection-wizard-duplicate-"));
  const file = join(root, "registry.json");
  const baseline = baselineManifest();
  writeFileSync(file, baseline, "utf8");
  try {
    const ui = new ScriptedWizardUi([
      select("third-party"),
      input("vendor/new-backend"),
      input("new-deployment"),
      input("https://backend.example"),
      // First registration targets the existing deployment and duplicates its selector.
      select("existing"),
      input("new/model"),
      input("vendor/new-model"),
      select("adapter-model"),
      input("shared/model"),
      confirm(false),
      // Numbered compiler error, then re-enter the complete registration block.
      confirm(true),
      select("new-deployment"),
      input("new/model"),
      input("vendor/new-model"),
      select("deployment-default"),
      confirm(true),
    ]);
    const outcome = await wizardDeploymentAdd(ui, {
      filePath: file,
      manifestRaw: baseline,
      importModule: importThirdParty,
    });
    ui.assertDrained();
    assert.equal("ok" in outcome && outcome.ok, true);
    assert.match(ui.confirmPrompts[1]!, /1\. model registrations .*duplicate the same deployment selector/);
    const manifest = parseModelRegistryManifest(readFileSync(file, "utf8"), file);
    assert.equal(manifest.models["new/model"]!.deployment, "new-deployment");
    assert.deepEqual(manifest.models["new/model"]!.selector, { kind: "deployment-default" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy upgrade writes only the explicit sibling and refuses an existing copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "connection-wizard-legacy-"));
  const file = join(root, "teammate-backends.json");
  const legacyRaw = `${JSON.stringify({
    version: 2,
    mode: "backend-registry",
    default: "legacy",
    backends: { legacy: { module: "pi-subprocess" } },
  }, null, 2)}\n`;
  writeFileSync(file, legacyRaw, "utf8");
  const preview = renderLegacyUpgradeSkeleton(JSON.parse(legacyRaw), file);
  try {
    const firstUi = new ScriptedWizardUi([confirm(true)]);
    const first = await wizardLegacyUpgrade(firstUi, preview, file);
    firstUi.assertDrained();
    assert.equal("ok" in first && first.ok, true);
    assert.equal(readFileSync(file, "utf8"), legacyRaw);
    const copyPath = `${file}.upgraded.json`;
    const copy = JSON.parse(readFileSync(copyPath, "utf8")) as Record<string, unknown>;
    assert.equal(copy.mode, "model-registry");

    const copyBefore = readFileSync(copyPath, "utf8");
    const secondUi = new ScriptedWizardUi([confirm(true)]);
    const second = await wizardLegacyUpgrade(secondUi, preview, file);
    secondUi.assertDrained();
    assert.equal("ok" in second && second.ok, false);
    assert.match("message" in second ? second.message ?? "" : "", /already exists/);
    assert.equal(readFileSync(file, "utf8"), legacyRaw);
    assert.equal(readFileSync(copyPath, "utf8"), copyBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function emptyRemoteState(): RemoteConfigState {
  return {
    global: { version: REMOTE_CONFIG_VERSION, hosts: {}, targets: {}, workspaces: {} },
    project: { version: REMOTE_CONFIG_VERSION, hosts: {}, targets: {}, workspaces: {} },
    config: { version: REMOTE_CONFIG_VERSION, hosts: {}, targets: {}, workspaces: {} },
  };
}

test("remote host invalid port re-prompts in place and persists the validated draft", async () => {
  const state = emptyRemoteState();
  let persisted: RemoteConfigStorePair | undefined;
  const ui = new ScriptedWizardUi([
    input("build"),
    select("Inline SSH settings"),
    input("build.example.com"),
    input("ci"),
    input("not-a-port"),
    input("2222"),
    input("SHA256:AAAAAAAAAAAAAAAAAAAA"),
    input(""),
  ]);
  const outcome = await wizardRemoteHost(ui, {
    state,
    scope: "project",
    persist: (_cwd, _expected, next) => {
      persisted = next;
    },
  });
  ui.assertDrained();
  assert.deepEqual(outcome, {
    ok: true,
    message: "Saved host build.",
    reloadRemote: true,
  });
  const portPrompts = ui.inputPrompts.filter((prompt) => prompt.includes("port ["));
  assert.equal(portPrompts.length, 2);
  assert.ok(portPrompts[1]!.startsWith("expected an integer\n"));
  assert.deepEqual(persisted?.project.hosts.build, {
    host: "build.example.com",
    user: "ci",
    port: 2222,
    hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAA",
  });
  assert.deepEqual(state.project.hosts, {}, "wizard must not mutate its CAS baseline");
});

test("remote host wizard selects only compatible unlocked /ssh references", async () => {
  const state = emptyRemoteState();
  let persisted: RemoteConfigStorePair | undefined;
  const ui = new ScriptedWizardUi([
    input("managed"),
    select("Select from unlocked /ssh manager"),
    select("Production · manager-host"),
  ]);
  const outcome = await wizardRemoteHost(ui, {
    state,
    scope: "global",
    listHostRefs: async () => [
      { id: "manager-host", label: "Production", compatible: true },
      { id: "password-host", label: "Password", compatible: false, issue: "unsupported-password-authentication" },
    ],
    persist: (_cwd, _expected, next) => { persisted = next; },
  });
  ui.assertDrained();
  assert.deepEqual(outcome, { ok: true, message: "Saved host managed.", reloadRemote: true });
  assert.deepEqual(persisted?.global.hosts.managed, { sshHostRef: "manager-host" });
  assert.deepEqual(ui.selectPrompts[1]?.options, ["Production · manager-host"]);
});

test("remote host wizard reports a locked /ssh provider without falling back to inline credentials", async () => {
  const ui = new ScriptedWizardUi([
    input("managed"),
    select("Select from unlocked /ssh manager"),
  ]);
  const outcome = await wizardRemoteHost(ui, {
    state: emptyRemoteState(),
    scope: "global",
    listHostRefs: async () => { throw new Error("SSH manager is locked. Open /ssh to unlock it."); },
    persist: () => { throw new Error("locked provider must not persist"); },
  });
  ui.assertDrained();
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /locked.*Open \/ssh/u);
  assert.equal(outcome.reloadRemote, false);
});
