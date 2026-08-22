import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backendRegistryConfigSync,
  dispatchRegistrySync,
  forgetBackendRegistryConfigSync,
  modelRegistryPairSync,
  PI_SUBPROCESS,
  publishedModelRegistryPairSync,
} from "../src/backends/registry-host.ts";
import {
  compileModelRegistryManifest,
  deriveModelRuntimeDescriptor,
  parseModelRegistryManifest,
  type ModelRegistryManifestV2,
} from "../src/models/model-registry.ts";

function manifest(overrides: Partial<ModelRegistryManifestV2> = {}): ModelRegistryManifestV2 {
  return {
    version: 2,
    mode: "model-registry",
    default: "pi-local",
    defaultModel: "pi/default",
    backends: {
      "pi-local": { module: "pi-subprocess" },
      "dsh-local": { module: "pi-maestro-backends/dsh", config: { model: "flash" } },
      "acp-local": {
        module: "pi-maestro-teammate/v1/acp-cli",
        config: { command: "agent", modelId: "cli/cursor" },
      },
      "remote-pi": {
        module: "remote-workers",
        config: { targetId: "beta", driver: "pi-rpc" },
      },
    },
    models: {
      "pi/default": {
        modelId: "openai/gpt-default",
        deployment: "pi-local",
        selector: { kind: "adapter-model", value: "openai/gpt-default" },
        deploymentDefault: true,
        capabilities: { reasoning: true, input: ["text", "image"] },
      },
    },
    ...overrides,
  };
}

function parsed(value: ModelRegistryManifestV2): ModelRegistryManifestV2 {
  return parseModelRegistryManifest(JSON.stringify(value), "test-manifest.json");
}

function workspace(value: unknown): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "teammate-model-registry-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  const file = join(root, ".pi", "teammate-backends.json");
  writeFileSync(file, JSON.stringify(value), "utf8");
  forgetBackendRegistryConfigSync(root);
  return { root, file };
}

test("one semantic revision produces separate immutable projections with identical identity", () => {
  const compiled = compileModelRegistryManifest(parsed(manifest()));
  assert.equal(compiled.discovery.revision, 1);
  assert.equal(compiled.discovery.revision, compiled.dispatch.revision);
  assert.equal(compiled.discovery.hash, compiled.dispatch.hash);
  assert.notEqual(compiled.discovery, compiled.dispatch);
  assert.equal(compiled.discovery.entries.length, 1);
  assert.equal(compiled.dispatch.routesByRegistrationId.size, 1);

  const discovered = compiled.discovery.entries[0]!;
  const deployment = compiled.dispatch.deploymentsById.get(discovered.deploymentId)!;
  assert.notEqual(discovered.runtime, deployment.runtime);
  assert.notEqual(discovered.capabilities, compiled.dispatch.routesByRegistrationId.get("pi/default")!.capabilities);
  assert.equal(Object.isFrozen(compiled.discovery.entries), true);
  assert.equal(Object.isFrozen(discovered), true);
  assert.equal("set" in compiled.dispatch.routesByRegistrationId, false);
  assert.throws(
    () => (compiled.dispatch.routesByRegistrationId as Map<string, unknown>).set("bad", {}),
    /set is not a function/,
  );
});

test("the semantic hash ignores JSON layout and the revision advances only for changed meaning", () => {
  const firstManifest = parsed(manifest());
  const first = compileModelRegistryManifest(firstManifest);
  const reordered = parseModelRegistryManifest(JSON.stringify({
    models: firstManifest.models,
    backends: firstManifest.backends,
    defaultModel: firstManifest.defaultModel,
    default: firstManifest.default,
    mode: firstManifest.mode,
    version: firstManifest.version,
  }, null, 4));
  const same = compileModelRegistryManifest(reordered, { previousIdentity: first.discovery });
  assert.equal(same.discovery.hash, first.discovery.hash);
  assert.equal(same.discovery.revision, 1);

  const changed = compileModelRegistryManifest(parsed(manifest({
    models: {
      ...firstManifest.models,
      "pi/default": { ...firstManifest.models["pi/default"]!, displayName: "Default Pi" },
    },
  })), { previousIdentity: same.discovery });
  assert.notEqual(changed.discovery.hash, first.discovery.hash);
  assert.equal(changed.discovery.revision, 2);
});

test("previous projection identity rejects malformed revisions and hashes before derivation", () => {
  const source = parsed(manifest());
  const validHash = "a".repeat(64);
  const invalid: Array<[string, unknown, RegExp]> = [
    ["negative revision", { revision: -1, hash: validHash }, /revision must be a safe non-negative integer/],
    ["fractional revision", { revision: 1.5, hash: validHash }, /revision must be a safe non-negative integer/],
    ["unsafe revision", { revision: Number.MAX_SAFE_INTEGER + 1, hash: validHash }, /revision must be a safe non-negative integer/],
    ["empty hash", { revision: 1, hash: "" }, /hash must be a lowercase 64-character SHA-256 hexadecimal string/],
    ["short hash", { revision: 1, hash: "a".repeat(63) }, /hash must be a lowercase 64-character SHA-256 hexadecimal string/],
    ["uppercase hash", { revision: 1, hash: "A".repeat(64) }, /hash must be a lowercase 64-character SHA-256 hexadecimal string/],
    ["non-hex hash", { revision: 1, hash: "g".repeat(64) }, /hash must be a lowercase 64-character SHA-256 hexadecimal string/],
  ];

  for (const [name, previousIdentity, expected] of invalid) {
    assert.throws(
      () => compileModelRegistryManifest(source, { previousIdentity: previousIdentity as never }),
      expected,
      name,
    );
  }

  assert.throws(
    () => compileModelRegistryManifest(source, {
      previousIdentity: { revision: Number.MAX_SAFE_INTEGER, hash: validHash },
    }),
    /revision cannot advance beyond the maximum safe integer/,
  );
});

test("strict schema and graph invariants reject errors by registration or deployment name", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["version", { ...manifest(), version: 3 }, /requires version 2/],
    ["top-level", { ...manifest(), surprise: true }, /unknown field "surprise"/],
    ["registration", manifest({ models: {
      "pi/default": { ...manifest().models["pi/default"]!, secret: "no" } as never,
    } }), /model registration "pi\/default" has unknown field "secret"/],
    ["unknown deployment", manifest({ models: {
      "pi/default": { ...manifest().models["pi/default"]!, deployment: "missing" },
    } }), /pi\/default.*unknown deployment "missing"/],
    ["default", manifest({ defaultModel: "missing" }), /defaultModel "missing" is not an explicit/],
    ["default marker", manifest({ models: {
      "pi/default": { ...manifest().models["pi/default"]!, deploymentDefault: false },
    } }), /defaultModel.*deploymentDefault true/],
    ["selector control", manifest({ models: {
      "pi/default": { ...manifest().models["pi/default"]!, selector: { kind: "adapter-model", value: "bad\nvalue" } },
    } }), /selector value.*control/],
    ["fixed local", manifest({ models: {
      "pi/default": { ...manifest().models["pi/default"]!, selector: { kind: "fixed" } },
    } }), /pi\/default.*fixed selector.*native modelSelection/],
    ["adapter remote", manifest({
      default: "remote-pi",
      models: {
        "pi/default": {
          ...manifest().models["pi/default"]!,
          deployment: "remote-pi",
          selector: { kind: "adapter-model", value: "model" },
        },
      },
    }), /adapter-model.*modelSelection is unsupported/],
    ["alias target", manifest({ compatibility: { version: 1, modelAliases: { old: "missing" } } }), /alias "old" targets unknown/],
    ["alias shadow", manifest({ compatibility: { version: 1, modelAliases: { "pi/default": "pi/default" } } }), /shadows a canonical/],
  ];
  for (const [name, value, expected] of cases) {
    assert.throws(() => compileModelRegistryManifest(parseModelRegistryManifest(JSON.stringify(value))), expected, name);
  }
});

test("prototype-reserved registrations and aliases remain own canonical entries", () => {
  const source = manifest({
    default: "constructor",
    defaultModel: "__proto__",
    backends: {
      constructor: { module: "pi-subprocess" },
      prototype: { module: "pi-maestro-backends/dsh" },
    },
    models: Object.fromEntries([
      ["__proto__", {
        modelId: "openai/prototype-safe",
        deployment: "constructor",
        selector: { kind: "adapter-model", value: "openai/prototype-safe" },
        deploymentDefault: true,
      }],
      ["prototype", {
        modelId: "dsh/prototype-safe",
        deployment: "prototype",
        selector: { kind: "adapter-model", value: "prototype-safe" },
      }],
    ]),
    compatibility: {
      version: 1,
      modelAliases: { constructor: "__proto__" },
      backendAliases: Object.fromEntries([["__proto__", "constructor"]]),
      remoteLocations: { "remote:prototype": "__proto__" },
    },
  });

  const parsedSource = parsed(source);
  assert.equal(Object.hasOwn(parsedSource.models, "__proto__"), true);
  assert.equal(Object.hasOwn(parsedSource.backends, "constructor"), true);
  assert.equal(Object.getPrototypeOf(parsedSource.models), null);
  assert.equal(Object.getPrototypeOf(parsedSource.backends), null);

  const compiled = compileModelRegistryManifest(parsedSource);
  assert.equal(compiled.dispatch.defaultModel, "__proto__");
  assert.equal(compiled.dispatch.routesByRegistrationId.has("__proto__"), true);
  assert.equal(compiled.dispatch.modelAliases.get("constructor"), "__proto__");
  assert.equal(compiled.dispatch.backendAliases.get("__proto__"), "constructor");
  assert.equal(compiled.dispatch.remoteLocations.get("remote:prototype"), "__proto__");
});

test("duplicate selectors, deployment defaults, and conflicting intrinsic metadata fail closed", () => {
  const base = manifest();
  assert.throws(() => parsed(manifest({ models: {
    ...base.models,
    duplicate: {
      modelId: "other/model",
      deployment: "pi-local",
      selector: { kind: "adapter-model", value: "openai/gpt-default" },
    },
  } })), /duplicate the same deployment selector/);

  assert.throws(() => parsed(manifest({ models: {
    ...base.models,
    second: {
      modelId: "other/model",
      deployment: "pi-local",
      selector: { kind: "adapter-model", value: "other/model" },
      deploymentDefault: true,
    },
  } })), /multiple deployment defaults/);

  assert.throws(() => parsed(manifest({ models: {
    ...base.models,
    second: {
      modelId: "openai/gpt-default",
      deployment: "dsh-local",
      selector: { kind: "adapter-model", value: "gpt" },
      capabilities: { reasoning: false, input: ["text"] },
    },
  } })), /conflicting intrinsic capabilities/);
});

test("supported registry deployment forms derive closed descriptors without probes", () => {
  const cases = [
    {
      name: "Pi local",
      id: "pi-local",
      registration: { module: "pi-subprocess" },
      expected: {
        harness: "pi",
        transport: { kind: "local-process", protocol: "pi-rpc" },
        modelSelection: "native",
        resolvable: true,
      },
    },
    {
      name: "DSH local",
      id: "dsh-local",
      registration: { module: "pi-maestro-backends/dsh", config: { model: "flash" } },
      expected: {
        harness: "dsh",
        transport: { kind: "local-process", protocol: "json-rpc-stdio" },
        modelSelection: "native",
        resolvable: true,
      },
    },
    {
      name: "DSH direct SSH",
      id: "dsh-ssh",
      registration: { module: "pi-maestro-backends/dsh", config: { mode: "ssh", host: "build-box", user: "ci" } },
      expected: {
        harness: "dsh",
        transport: { kind: "dsh-direct-ssh", protocol: "json-rpc-stdio" },
        modelSelection: "native",
        resolvable: true,
      },
    },
    {
      name: "DSH invalid mode",
      id: "dsh-invalid-mode",
      registration: { module: "pi-maestro-backends/dsh", config: { mode: "tunnel" } },
      expected: {
        harness: "dsh",
        transport: { kind: "local-process", protocol: "json-rpc-stdio" },
        modelSelection: "native",
        resolvable: false,
        unavailableReason: 'deployment "dsh-invalid-mode" has invalid DSH mode "tunnel"',
      },
    },
    {
      name: "ACP local",
      id: "acp-local",
      registration: { module: "pi-maestro-teammate/v1/acp-cli", config: { mode: "local" } },
      expected: {
        harness: "acp",
        transport: { kind: "local-process", protocol: "acp" },
        modelSelection: "native",
        resolvable: true,
      },
    },
    {
      name: "ACP direct SSH",
      id: "acp-ssh",
      registration: { module: "pi-maestro-teammate/v1/acp-cli", config: { mode: "ssh" } },
      expected: {
        harness: "acp",
        transport: { kind: "acp-direct-ssh", protocol: "acp" },
        modelSelection: "native",
        resolvable: true,
      },
    },
    {
      name: "remote Pi",
      id: "remote-pi",
      registration: {
        module: "remote-workers",
        config: { targetId: "beta", driver: "pi-rpc" },
      },
      expected: {
        harness: "pi",
        transport: { kind: "remote-worker", gateway: "ssh", protocol: "remote/2", driver: "pi-rpc" },
        modelSelection: "unsupported",
        resolvable: true,
      },
    },
    {
      name: "remote ACP",
      id: "remote-acp",
      registration: {
        module: "remote-workers",
        config: { targetId: "gamma", driver: "acp" },
      },
      expected: {
        harness: "acp",
        transport: { kind: "remote-worker", gateway: "ssh", protocol: "remote/2", driver: "acp" },
        modelSelection: "unsupported",
        resolvable: true,
      },
    },
  ] as const;

  for (const entry of cases) {
    assert.deepEqual(deriveModelRuntimeDescriptor(entry.id, entry.registration), entry.expected, entry.name);
  }
  assert.equal(deriveModelRuntimeDescriptor("third-party", { module: "third-party" }).resolvable, false);
});

test("authenticated host models project only through an explicitly named Pi deployment", () => {
  const source = parsed(manifest({ compatibility: { version: 1, hostModelsDeployment: "pi-local" } }));
  const first = compileModelRegistryManifest(source, {
    hostModels: [{ provider: "openai", id: "gpt-host", name: "Host", reasoning: true, input: ["text"] }],
  });
  assert.equal(first.dispatch.routesByRegistrationId.get("openai/gpt-host")?.deploymentId, "pi-local");
  assert.equal(first.dispatch.routesByRegistrationId.get("openai/gpt-host")?.selector.kind, "adapter-model");
  assert.equal(first.discovery.entries.find((entry) => entry.modelRegistrationId === "openai/gpt-host")?.displayName, "Host");

  const changed = compileModelRegistryManifest(source, {
    hostModels: [{ provider: "openai", id: "gpt-other" }],
    previousIdentity: first.discovery,
  });
  assert.equal(changed.discovery.revision, 2);
  assert.notEqual(changed.discovery.hash, first.discovery.hash);
  assert.equal(changed.dispatch.routesByRegistrationId.has("openai/gpt-host"), false);
});

test("CLI compatibility projection is explicit, probe-free, and requires one ACP deployment", () => {
  const disabled = compileModelRegistryManifest(parsed(manifest()), {
    cliToolsConfig: { version: "1", tools: { cursor: { enabled: true, command: "does-not-exist" } } },
  });
  assert.equal(disabled.dispatch.routesByRegistrationId.has("cli/cursor"), false);

  const enabledManifest = parsed(manifest({
    compatibility: { version: 1, teammateCliToolsProjection: { enabled: true } },
  }));
  const enabled = compileModelRegistryManifest(enabledManifest, {
    cliToolsConfig: { version: "1", tools: { cursor: { enabled: true, command: "does-not-exist" } } },
  });
  assert.equal(enabled.dispatch.routesByRegistrationId.get("cli/cursor")?.deploymentId, "acp-local");
  assert.equal(enabled.dispatch.routesByRegistrationId.get("cli/cursor")?.selector.kind, "deployment-default");

  const ambiguousManifest = parsed(manifest({
    backends: {
      ...manifest().backends,
      "acp-other": {
        module: "pi-maestro-teammate/v1/acp-cli",
        config: { command: "other", modelId: "cli/cursor" },
      },
    },
    compatibility: { version: 1, teammateCliToolsProjection: { enabled: true } },
  }));
  const ambiguous = compileModelRegistryManifest(ambiguousManifest, {
    cliToolsConfig: { version: "1", tools: { cursor: { enabled: true } } },
  });
  assert.equal(ambiguous.dispatch.routesByRegistrationId.has("cli/cursor"), false);
  assert.match(ambiguous.discovery.diagnostics.join("\n"), /multiple ACP deployments.*acp-local, acp-other/);
});

test("workspace publication swaps atomically and invalid changed v2 input serves no stale pair", () => {
  const { root, file } = workspace(manifest());
  const pinned = modelRegistryPairSync(root)!;
  assert.equal(publishedModelRegistryPairSync(root), pinned);
  assert.equal(modelRegistryPairSync(root), pinned, "unchanged semantics reuse the published pair");

  writeFileSync(file, JSON.stringify(manifest({ defaultModel: "missing" })), "utf8");
  assert.throws(() => modelRegistryPairSync(root), /defaultModel "missing"/);
  assert.equal(publishedModelRegistryPairSync(root), undefined);
  assert.throws(() => backendRegistryConfigSync(root), /defaultModel "missing"/);
  assert.equal(pinned.dispatch.routesByRegistrationId.has("pi/default"), true, "captured in-flight pair remains pinned");

  const base = manifest();
  writeFileSync(file, JSON.stringify(manifest({ models: {
    ...base.models,
    "pi/default": { ...base.models["pi/default"]!, displayName: "Repaired" },
  } })), "utf8");
  const repaired = modelRegistryPairSync(root)!;
  assert.equal(repaired.discovery.revision, pinned.discovery.revision + 1);
  assert.notEqual(repaired.discovery.hash, pinned.discovery.hash);
  assert.equal(backendRegistryConfigSync(root).backends["pi-local"]?.module, "pi-subprocess");
  assert.equal(backendRegistryConfigSync(root).mode, "model-registry");
});

test("dispatch refreshes model-registry input and rejects an invalid edit without a manual pair refresh", () => {
  const { root, file } = workspace(manifest());
  const extras = (): never => { throw new Error("no run is started in this test"); };
  const registry = dispatchRegistrySync(root, extras);
  assert.equal(registry?.defaultBackendName(), "pi-local");
  assert.notEqual(publishedModelRegistryPairSync(root), undefined);

  writeFileSync(file, JSON.stringify(manifest({ defaultModel: "missing" })), "utf8");
  assert.throws(() => dispatchRegistrySync(root, extras), /defaultModel "missing"/);
  assert.equal(publishedModelRegistryPairSync(root), undefined);
});

test("same-workspace legacy edits remain read-once across catalog and public dispatch reads", () => {
  const { root, file } = workspace({
    mode: "legacy",
    default: PI_SUBPROCESS,
    backends: {},
  });
  const initial = backendRegistryConfigSync(root);
  assert.equal(initial.mode, "legacy");

  writeFileSync(file, "{ malformed after legacy cache", "utf8");
  const extras = (): never => { throw new Error("no run is started in this test"); };
  assert.equal(modelRegistryPairSync(root), undefined, "catalog refresh cannot parse past cached legacy mode");
  assert.equal(backendRegistryConfigSync(root), initial);
  assert.equal(dispatchRegistrySync(root, extras), undefined);

  writeFileSync(file, JSON.stringify({
    mode: "backend-registry",
    default: PI_SUBPROCESS,
    backends: {},
  }), "utf8");
  assert.equal(modelRegistryPairSync(root), undefined, "catalog refresh cannot replace cached legacy mode");
  assert.equal(backendRegistryConfigSync(root), initial);
  assert.equal(dispatchRegistrySync(root, extras), undefined);

  forgetBackendRegistryConfigSync(root);
  assert.equal(backendRegistryConfigSync(root).mode, "backend-registry");
  assert.notEqual(dispatchRegistrySync(root, extras), undefined);
});

test("entering model-registry from cached backend mode requires explicit invalidation", () => {
  const { root, file } = workspace({
    mode: "backend-registry",
    default: PI_SUBPROCESS,
    backends: {},
  });
  const extras = (): never => { throw new Error("no run is started in this test"); };
  const cachedDispatch = dispatchRegistrySync(root, extras);
  assert.equal(cachedDispatch?.defaultBackendName(), PI_SUBPROCESS);

  writeFileSync(file, JSON.stringify(manifest()), "utf8");
  assert.equal(modelRegistryPairSync(root), undefined, "catalog refresh cannot activate model mode");
  assert.equal(publishedModelRegistryPairSync(root), undefined);
  assert.equal(dispatchRegistrySync(root, extras)?.defaultBackendName(), PI_SUBPROCESS);

  forgetBackendRegistryConfigSync(root);
  const pair = modelRegistryPairSync(root);
  assert.notEqual(pair, undefined);
  assert.equal(pair?.dispatch.defaultDeployment, "pi-local");
  assert.equal(dispatchRegistrySync(root, extras)?.defaultBackendName(), "pi-local");
});

test("a model-registry rollback freezes again until the next invalidation boundary", () => {
  const { root, file } = workspace(manifest());
  const first = modelRegistryPairSync(root)!;
  const extras = (): never => { throw new Error("no run is started in this test"); };

  writeFileSync(file, JSON.stringify({
    mode: "legacy",
    default: PI_SUBPROCESS,
    backends: {},
  }), "utf8");
  assert.equal(modelRegistryPairSync(root), undefined);
  assert.equal(backendRegistryConfigSync(root).mode, "legacy");
  assert.equal(dispatchRegistrySync(root, extras), undefined);

  writeFileSync(file, JSON.stringify(manifest({
    models: {
      ...manifest().models,
      "pi/second": {
        modelId: "openai/gpt-second",
        deployment: "pi-local",
        selector: { kind: "adapter-model", value: "openai/gpt-second" },
      },
    },
  })), "utf8");
  assert.equal(modelRegistryPairSync(root), undefined, "old mode remains frozen after rollback");
  assert.equal(dispatchRegistrySync(root, extras), undefined);

  forgetBackendRegistryConfigSync(root);
  const reentered = modelRegistryPairSync(root)!;
  assert.equal(reentered.dispatch.routesByRegistrationId.has("pi/second"), true);
  assert.equal(reentered.dispatch.revision, first.dispatch.revision + 1);
});

test("a malformed enabled CLI overlay republishes both projections without stale compatibility routes", () => {
  const { root } = workspace(manifest({
    compatibility: { version: 1, teammateCliToolsProjection: { enabled: true } },
  }));
  const globalFile = join(root, "global-cli-tools.json");
  writeFileSync(globalFile, JSON.stringify({ version: "1", tools: { cursor: { enabled: true, command: "ignored" } } }), "utf8");
  const valid = modelRegistryPairSync(root, { cliToolsGlobalFilePath: globalFile })!;
  assert.equal(valid.dispatch.routesByRegistrationId.has("cli/cursor"), true);

  writeFileSync(globalFile, "{ malformed", "utf8");
  const degraded = modelRegistryPairSync(root, { cliToolsGlobalFilePath: globalFile })!;
  assert.equal(degraded.dispatch.routesByRegistrationId.has("cli/cursor"), false);
  assert.equal(degraded.dispatch.routesByRegistrationId.has("pi/default"), true);
  assert.equal(degraded.discovery.revision, valid.discovery.revision + 1);
  assert.match(degraded.discovery.diagnostics.join("\n"), /CLI compatibility projection.*not valid JSON/);
  assert.equal(publishedModelRegistryPairSync(root), degraded);
});
