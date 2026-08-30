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
import {
  wizardDeploymentAdd,
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

const importThirdParty = async (): Promise<unknown> => ({
  default: { configFields: THIRD_PARTY_FIELDS },
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
    global: { version: 3, hosts: {}, targets: {}, workspaces: {} },
    project: { version: 3, hosts: {}, targets: {}, workspaces: {} },
    config: { version: 3, hosts: {}, targets: {}, workspaces: {} },
  };
}

test("remote host invalid port re-prompts in place and persists the validated draft", async () => {
  const state = emptyRemoteState();
  let persisted: RemoteConfigStorePair | undefined;
  const ui = new ScriptedWizardUi([
    input("build"),
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
