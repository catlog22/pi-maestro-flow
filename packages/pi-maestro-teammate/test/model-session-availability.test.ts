import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerTeammateExtension from "../src/extension/index.ts";
import { sharedModelHealthCoordinator } from "../src/models/model-circuit-breaker.ts";
import {
  REMOTE_MODEL_SESSION_UNAVAILABLE_REASON,
  projectSessionModelCatalog,
} from "../src/models/model-session-availability.ts";
import {
  compileModelRegistryManifest,
  parseModelRegistryManifest,
  type InternalModelCatalogRoute,
} from "../src/models/model-registry.ts";

function discovery() {
  return compileModelRegistryManifest(parseModelRegistryManifest(JSON.stringify({
    version: 2,
    mode: "model-registry",
    default: "pi-local",
    defaultModel: "pi/default",
    backends: {
      "pi-local": { module: "pi-subprocess" },
      "remote-secret-target": {
        module: "remote-workers",
        config: { targetId: "sensitive-host", driver: "pi-rpc" },
      },
      "third-party": {
        module: "secret-adapter-package",
        config: { token: "do-not-surface" },
      },
    },
    models: {
      "pi/default": {
        modelId: "openai/gpt-5",
        deployment: "pi-local",
        selector: { kind: "adapter-model", value: "openai/gpt-5" },
        deploymentDefault: true,
        displayName: "Default Pi",
        capabilities: { reasoning: true, input: ["text", "image"] },
      },
      "pi/unhealthy": {
        modelId: "openai/gpt-bad",
        deployment: "pi-local",
        selector: { kind: "adapter-model", value: "openai/gpt-bad" },
      },
      "remote/fixed": {
        modelId: "remote/private-model",
        deployment: "remote-secret-target",
        selector: { kind: "fixed" },
        capabilities: { reasoning: false, input: ["text"] },
      },
      "adapter/default": {
        modelId: "adapter/private-model",
        deployment: "third-party",
        selector: { kind: "deployment-default" },
      },
    },
  }))).discovery;
}

const unhealthy = (route: InternalModelCatalogRoute) => ({
  healthy: route.modelRegistrationId !== "pi/unhealthy",
  ...(route.modelRegistrationId === "pi/unhealthy"
    ? { unavailableReason: "Model route is temporarily unavailable." }
    : {}),
});

test("session projection enforces resolvable, session-authority, and health gates", () => {
  const projected = projectSessionModelCatalog(discovery(), {
    isChild: false,
    hasCurrentRootMonitorAuthority: false,
    health: unhealthy,
  });

  assert.deepEqual(projected.entries, [{
    provider: "pi",
    id: "default",
    name: "Default Pi",
    reasoning: true,
    input: ["text", "image"],
  }]);
  assert.equal(projected.diagnostics.includes(REMOTE_MODEL_SESSION_UNAVAILABLE_REASON), true);
  assert.equal(projected.diagnostics.includes("Model route is temporarily unavailable."), true);
  assert.match(projected.diagnostics.join("\n"), /adapter\/default.*deployment is not resolvable/);
  assert.doesNotMatch(projected.diagnostics.join("\n"), /sensitive-host|do-not-surface|secret-adapter-package/);
  assert.doesNotMatch(JSON.stringify(projected.entries), /openai\/gpt-5|private-model|deployment|selector/);
});

test("remote routes require current root Monitor authority and stay absent for children", () => {
  const projection = discovery();
  const monitor = projectSessionModelCatalog(projection, {
    isChild: false,
    hasCurrentRootMonitorAuthority: true,
    health: unhealthy,
  });
  assert.deepEqual(monitor.entries.map((entry) => `${entry.provider}/${entry.id}`), [
    "pi/default",
    "remote/fixed",
  ]);
  assert.equal(monitor.diagnostics.includes(REMOTE_MODEL_SESSION_UNAVAILABLE_REASON), false);

  const monitorChild = projectSessionModelCatalog(projection, {
    isChild: true,
    hasCurrentRootMonitorAuthority: true,
    health: unhealthy,
  });
  assert.deepEqual(monitorChild.entries.map((entry) => `${entry.provider}/${entry.id}`), ["pi/default"]);
  assert.equal(monitorChild.diagnostics.includes(REMOTE_MODEL_SESSION_UNAVAILABLE_REASON), true);
});

test("catalog projection publishes registration ids rather than adapter model ids", () => {
  const projected = projectSessionModelCatalog(discovery(), {
    isChild: false,
    hasCurrentRootMonitorAuthority: true,
  });
  assert.equal(projected.entries.some((entry) => entry.provider === "remote" && entry.id === "fixed"), true);
  assert.equal(projected.entries.some((entry) => entry.provider === "remote" && entry.id === "private-model"), false);
});

test("extension refresh coalesces and invalidates model-registry views across Monitor and registry transitions", async () => {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> | void }>();
  let activeTools: string[] = [];
  const pi = new Proxy({
    events: { on: () => () => {}, emit() {} },
    registerTool(tool: { name: string }) {
      if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> | void }) {
      commands.set(name, command);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools(names: string[]) { activeTools = [...names]; },
    on(event: string, handler: (event: any, ctx: any) => any) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-session-models-"));
  const registryDir = path.join(root, ".pi");
  const registryFile = path.join(registryDir, "teammate-backends.json");
  fs.mkdirSync(registryDir, { recursive: true });
  const document = JSON.parse(JSON.stringify({
    version: 2,
    mode: "model-registry",
    default: "pi-local",
    defaultModel: "pi/default",
    backends: {
      "pi-local": { module: "pi-subprocess" },
      "acp-missing": {
        module: "pi-maestro-teammate/v1/acp-cli",
        config: { command: "definitely-not-installed", modelId: "cli/missing" },
      },
      "remote-beta": { module: "remote-workers", config: { targetId: "beta", driver: "pi-rpc" } },
    },
    models: {
      "pi/default": {
        modelId: "openai/gpt-5",
        deployment: "pi-local",
        selector: { kind: "adapter-model", value: "openai/gpt-5" },
        deploymentDefault: true,
      },
      "remote/fixed": {
        modelId: "remote/private",
        deployment: "remote-beta",
        selector: { kind: "fixed" },
      },
    },
    compatibility: { version: 1, teammateCliToolsProjection: { enabled: true } },
  }));
  fs.writeFileSync(registryFile, JSON.stringify(document), "utf8");
  fs.writeFileSync(path.join(registryDir, "teammate-cli-tools.json"), JSON.stringify({
    version: "1",
    tools: { missing: { enabled: true, command: "definitely-not-installed" } },
  }), "utf8");

  let releaseRefresh!: () => void;
  const refreshReleased = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  let refreshCalls = 0;
  let hostModels: Array<{ provider: string; id: string }> = [];
  const ctx = {
    cwd: root,
    hasUI: true,
    ui: {
      notify() {}, setStatus() {}, setWidget() {}, onTerminalInput: () => () => {},
    },
    modelRegistry: {
      getAvailable: () => hostModels,
      async refresh() {
        refreshCalls++;
        await refreshReleased;
      },
    },
    sessionManager: {
      getSessionId: () => "root-session",
      getSessionFile: () => "root-session.jsonl",
      getSessionName: () => "root-session",
      getEntries: () => [],
    },
  };

  const previousChild = process.env.PI_TEAMMATE_CHILD;
  delete process.env.PI_TEAMMATE_CHILD;
  try {
    registerTeammateExtension(pi as unknown as ExtensionAPI);
    if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previousChild;
    handlers.get("session_start")![0]({}, ctx);
    const firstPending = handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, ctx);
    const secondPending = handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, ctx);
    await Promise.resolve();
    assert.equal(refreshCalls, 1);
    releaseRefresh();
    const [first, second] = await Promise.all([firstPending, secondPending]);
    for (const prompt of [first.systemPrompt, second.systemPrompt]) {
      const catalog = prompt.match(/<available_teammate_models>[\s\S]*?<\/available_teammate_models>/)?.[0] ?? "";
      assert.match(catalog, /pi\/default/);
      assert.match(catalog, /cli\/missing/);
      assert.doesNotMatch(catalog, /remote\/fixed/);
      assert.doesNotMatch(catalog, /openai\/gpt-5|remote\/private|targetId|sensitive-host/);
    }

    const monitor = commands.get("monitor");
    assert.ok(monitor);
    await monitor.handler("", ctx);
    const monitorPrompt = await handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, ctx);
    assert.match(monitorPrompt.systemPrompt, /remote\/fixed/);

    for (let attempt = 0; attempt < 3; attempt++) {
      const acquisition = sharedModelHealthCoordinator.acquireCandidate("remote/fixed");
      assert.equal(acquisition.allowed, true);
      if (acquisition.allowed) sharedModelHealthCoordinator.recordFailure(acquisition, "route");
    }
    const unhealthyPrompt = await handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, ctx);
    assert.doesNotMatch(unhealthyPrompt.systemPrompt, /remote\/fixed/);
    sharedModelHealthCoordinator.routeBreaker.reset("remote/fixed");
    const recoveredPrompt = await handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, ctx);
    assert.match(recoveredPrompt.systemPrompt, /remote\/fixed/);

    delete document.models["remote/fixed"];
    fs.writeFileSync(registryFile, JSON.stringify(document), "utf8");
    const editedPrompt = await handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, ctx);
    assert.doesNotMatch(editedPrompt.systemPrompt, /remote\/fixed/);

    document.models["remote/fixed"] = {
      modelId: "remote/private",
      deployment: "remote-beta",
      selector: { kind: "fixed" },
    };
    fs.writeFileSync(registryFile, JSON.stringify(document), "utf8");
    await monitor.handler("exit", ctx);
    const exitedPrompt = await handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, ctx);
    assert.doesNotMatch(exitedPrompt.systemPrompt, /remote\/fixed/);

    hostModels = [{ provider: "host", id: "authenticated" }];
    fs.writeFileSync(registryFile, JSON.stringify({
      mode: "backend-registry",
      default: "pi-subprocess",
      backends: {},
    }), "utf8");
    fs.writeFileSync(path.join(registryDir, "teammate-cli-tools.json"), JSON.stringify({
      version: "1",
      tools: { legacy: { enabled: true, command: "node" } },
    }), "utf8");
    const legacyPrompt = await handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, ctx);
    const legacyCatalog = legacyPrompt.systemPrompt
      .match(/<available_teammate_models>[\s\S]*?<\/available_teammate_models>/)?.[0] ?? "";
    assert.match(legacyCatalog, /host\/authenticated/);
    assert.match(legacyCatalog, /cli\/legacy/);
  } finally {
    if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previousChild;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
