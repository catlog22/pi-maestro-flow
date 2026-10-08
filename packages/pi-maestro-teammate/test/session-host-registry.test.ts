import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bindClassifierRuntime, configureClassifier, classifierStatus, classify, resetClassifierForTest } from "../src/classify/engine.ts";
import { fileValueDomain } from "../src/classify/domains.ts";
import registerTeammateExtension from "../src/extension/index.ts";
import {
  SESSION_HOST_REGISTRY_KEY,
  getSessionHostRegistry,
  publishSessionHostRegistry,
} from "../src/sessions/session-core.ts";

const ROOT_REGISTRY_KEY = Symbol.for("pi-maestro-teammate.root-registry");

function extensionApi(on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => () => void = () => () => {}): ExtensionAPI {
  return new Proxy({
    events: {
      on() { return () => {}; },
      emit() {},
    },
    on,
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
    registerMessageRenderer() {},
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  }) as unknown as ExtensionAPI;
}

test("root extension publishes the parsed session surface registry", () => {
  const previousChild = process.env.PI_TEAMMATE_CHILD;
  const previousSurface = process.env.PI_TEAMMATE_SESSION_SURFACE;
  delete process.env.PI_TEAMMATE_CHILD;
  process.env.PI_TEAMMATE_SESSION_SURFACE = " shadow ";
  const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
  delete globals[ROOT_REGISTRY_KEY];
  publishSessionHostRegistry(undefined, globals);

  try {
    registerTeammateExtension(extensionApi());
    const registry = getSessionHostRegistry(globals);
    assert.ok(registry);
    assert.equal(registry.router.surface, "shadow");
    assert.deepEqual(registry.listEndpoints(), []);
    assert.equal(globals[SESSION_HOST_REGISTRY_KEY], registry);
  } finally {
    publishSessionHostRegistry(undefined, globals);
    delete globals[ROOT_REGISTRY_KEY];
    if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previousChild;
    if (previousSurface === undefined) delete process.env.PI_TEAMMATE_SESSION_SURFACE;
    else process.env.PI_TEAMMATE_SESSION_SURFACE = previousSurface;
  }
});

test("teammate classifier session binding preserves the real identity quota across extension registration", async () => {
  const previousChild = process.env.PI_TEAMMATE_CHILD;
  delete process.env.PI_TEAMMATE_CHILD;
  const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
  delete globals[ROOT_REGISTRY_KEY];
  publishSessionHostRegistry(undefined, globals);
  resetClassifierForTest();
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const api = extensionApi((event, handler) => {
    const list = handlers.get(event) ?? [];
    list.push(handler); handlers.set(event, list);
    return () => {};
  });
  let sessionId = "real-session";
  const selected = { type: "classifier" as const, provider: "typesafe", id: "jev-latest", api: "typesafe-system-one" as const, name: "JEV", baseUrl: "https://api.typesafe.ai", input: ["text" as const], contextWindow: 32000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const runtime = { getAvailableOfType: async () => [selected], getModelOfType: () => selected,
    classify: async () => ({ api: selected.api, provider: selected.provider, model: selected.id,
      answers: { value: { type: "choice" as const, choice: "required", confidence: .9, probabilities: { required: .9 } } },
      stopReason: "stop" as const, timestamp: 0 }) };
  const ctx = { cwd: "/project", sessionManager: { getSessionId: () => sessionId }, modelRegistry: runtime } as unknown as ExtensionContext;
  try {
    bindClassifierRuntime({ hostVersion: "0.99.0", runtime, sessionId, cwd: ctx.cwd });
    configureClassifier({ enabled: true, domains: { "file-value": "jev" }, maxCallsPerSession: 1 });
    assert.equal((await classify(fileValueDomain, { path: "first.ts" })).layer, "jev");
    registerTeammateExtension(api);
    const start = handlers.get("session_start")![0]!;
    await start({}, ctx); // Only the classifier hook; unrelated host services are not exercised.
    assert.equal(classifierStatus().callsUsed, 1);
    assert.match((await classify(fileValueDomain, { path: "excess.ts" })).degradedReason ?? "", /budget/);
    sessionId = "new-session";
    await start({}, ctx);
    assert.equal(classifierStatus().callsUsed, 0);
    sessionId = "real-session";
    await start({}, ctx);
    assert.equal(classifierStatus().callsUsed, 1);
  } finally {
    resetClassifierForTest(); publishSessionHostRegistry(undefined, globals); delete globals[ROOT_REGISTRY_KEY];
    if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD; else process.env.PI_TEAMMATE_CHILD = previousChild;
  }
});

test("session replacement keeps the canonical registry published for the following session_start", async () => {
  const previousChild = process.env.PI_TEAMMATE_CHILD;
  delete process.env.PI_TEAMMATE_CHILD;
  const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
  delete globals[ROOT_REGISTRY_KEY];
  publishSessionHostRegistry(undefined, globals);
  const handlers = new Map<string, Array<(event?: unknown, ctx?: unknown) => unknown>>();
  const api = new Proxy({
    events: { on() { return () => {}; }, emit() {} },
    on(event: string, handler: (event?: unknown, ctx?: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, getActiveTools() { return []; },
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  }) as unknown as ExtensionAPI;

  try {
    registerTeammateExtension(api);
    const registry = getSessionHostRegistry(globals);
    assert.ok(registry);
    const shutdownHandlers = handlers.get("session_shutdown");
    assert.equal(shutdownHandlers?.length, 2, "classifier and session registry own separate shutdown hooks");
    const shutdown = async (event: unknown) => {
      for (const handler of shutdownHandlers!) await handler(event);
    };
    await shutdown({ reason: "resume" });
    assert.equal(getSessionHostRegistry(globals), registry);
    assert.deepEqual(registry.listEndpoints(), []);
    await shutdown({ reason: "quit" });
    assert.equal(getSessionHostRegistry(globals), undefined);
  } finally {
    publishSessionHostRegistry(undefined, globals);
    delete globals[ROOT_REGISTRY_KEY];
    if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previousChild;
  }
});
