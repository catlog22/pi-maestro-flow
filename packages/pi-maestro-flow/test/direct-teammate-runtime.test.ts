import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTeammatePermissionBroker } from "pi-maestro-teammate/v1/child-extensions";
import { createDirectTeammateRunOptions } from "../src/tools/direct-teammate.ts";

test("direct teammate options install the parent-authoritative request bridge", async () => {
  const emitted: unknown[] = [];
  const pi = {
    sendMessage() {},
    events: { emit(name: string, payload: unknown) { emitted.push({ name, payload }); } },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: "D:/workspace", hasUI: false } as ExtensionContext;
  const signal = new AbortController().signal;
  const unregister = registerTeammatePermissionBroker(async (request) => {
    assert.equal(request.toolName, "read");
    return { action: "allow_once" };
  });

  try {
    const options = createDirectTeammateRunOptions(pi, ctx, { baseCwd: ctx.cwd, signal });
    assert.equal(options.baseCwd, ctx.cwd);
    assert.equal(options.signal, signal);
    assert.equal(typeof options.onChildRequest, "function");

    const reply = await new Promise<any>((resolve) => options.onChildRequest?.({
      type: "teammate_interaction_request",
      requestId: "direct-runtime-permission",
      interaction: "permission",
      payload: {
        authorization: "parent",
        toolName: "read",
        input: { path: "README.md" },
      },
    }, resolve));
    assert.equal(reply.result.action, "allow_once");
    assert.equal(emitted.length, 1);
  } finally {
    unregister();
  }
});

test("every non-Swarm direct teammate consumer uses the shared options factory", () => {
  for (const relative of ["delegate.ts", "explore.ts", "moa.ts", "goal.ts"]) {
    const source = readFileSync(new URL(`../src/tools/${relative}`, import.meta.url), "utf8");
    assert.match(source, /createDirectTeammateRunOptions\(/, relative);
  }
});
