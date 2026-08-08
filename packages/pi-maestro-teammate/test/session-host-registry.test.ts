import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerTeammateExtension from "../src/extension/index.ts";
import {
  SESSION_HOST_REGISTRY_KEY,
  getSessionHostRegistry,
  publishSessionHostRegistry,
} from "../src/sessions/session-core.ts";

const ROOT_REGISTRY_KEY = Symbol.for("pi-maestro-teammate.root-registry");

function extensionApi(): ExtensionAPI {
  return new Proxy({
    events: {
      on() { return () => {}; },
      emit() {},
    },
    on() { return () => {}; },
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
    registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
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
    const shutdown = handlers.get("session_shutdown")?.[0];
    assert.ok(shutdown);
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
