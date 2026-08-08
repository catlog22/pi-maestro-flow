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
