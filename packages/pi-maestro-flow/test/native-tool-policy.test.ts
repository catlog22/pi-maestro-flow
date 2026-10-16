import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createToolSearchExtension } from "@earendil-works/pi-coding-agent";
import { applyNativeToolPolicy, isNativeDiscoverySelected, withNativeToolPolicy } from "../src/tools/native-tool-policy.ts";
import { registerSearchToolBm25 } from "../src/tools/search-tool-bm25.ts";

function tool(name: string): ToolDefinition {
  return { name, label: name, description: name, parameters: Type.Object({}), async execute() { return { content: [], details: {} }; } };
}

test("native discovery defaults on and honors explicit settings and CLI tool selection", () => {
  assert.equal(isNativeDiscoverySelected({}), true);
  assert.equal(isNativeDiscoverySelected({ defaultTools: ["+browser"] }), true);
  assert.equal(isNativeDiscoverySelected({ defaultTools: ["read", "bash"] }), false);
  assert.equal(isNativeDiscoverySelected({ defaultTools: [] }), false);
  assert.equal(isNativeDiscoverySelected({ defaultTools: ["-tool_search"] }), false);
  assert.equal(isNativeDiscoverySelected({ defaultTools: ["-tool_search", "+tool_search"] }), true);
  assert.equal(isNativeDiscoverySelected({ defaultTools: ["-tool_search", "tool_search"] }), false);
  assert.equal(isNativeDiscoverySelected({ extensions: ["-builtin:tool-search"] }), false);
  assert.equal(isNativeDiscoverySelected({ cli: { excludeTools: ["tool_*"] } }), false);
  assert.equal(isNativeDiscoverySelected({ cli: { tools: ["read", "tool_*"] } }), true);
  assert.equal(isNativeDiscoverySelected({ defaultTools: ["+tool_search"] }), true);
  assert.equal(isNativeDiscoverySelected({ defaultTools: ["+tool_search", "-tool_search"] }), false);
  assert.equal(isNativeDiscoverySelected({ defaultTools: ["+tool_search"], extensions: ["-builtin:tool-search"] }), false);
  assert.equal(isNativeDiscoverySelected({ defaultTools: ["+tool_search"], extensions: ["!builtin:*"] }), false);
  assert.equal(isNativeDiscoverySelected({ defaultTools: ["+tool_search"], cli: { extensions: ["!builtin:*"] } }), false);
  assert.equal(isNativeDiscoverySelected({ defaultTools: ["+tool_search"], cli: { tools: ["read"] } }), false);
  assert.equal(isNativeDiscoverySelected({ cli: { tools: ["tool_search"], noTools: true } }), false);
  assert.equal(isNativeDiscoverySelected({ cli: { tools: ["tool_search"], excludeTools: ["tool_search"] } }), false);
  assert.equal(isNativeDiscoverySelected({ cli: { tools: ["tool_search"], noExtensions: true } }), false);
  assert.equal(isNativeDiscoverySelected({ cli: { tools: ["tool_search"], noExtensions: true, extensions: ["builtin:tool-search"] } }), true);
});

test("native registrations preserve execution and output contracts and isolate controls", () => {
  const original = { ...tool("browser"), outputSchema: Type.Object({ ok: Type.Boolean() }), annotations: { readOnlyHint: false } };
  const result = applyNativeToolPolicy(original, true);
  assert.equal(result.exposure, "deferred");
  assert.equal(result.execute, original.execute);
  assert.equal(result.parameters, original.parameters);
  assert.equal(result.outputSchema, original.outputSchema);
  assert.equal(result.annotations, original.annotations);
  assert.equal(applyNativeToolPolicy(tool("browser"), false).exposure, "direct");
  for (const name of ["todo", "run-control", "plan-confirm", "ask-user-question", "new_context"]) {
    assert.equal(applyNativeToolPolicy(tool(name), true).exposure, "model-only");
  }
  assert.equal(applyNativeToolPolicy({ ...tool("browser"), exposure: "hidden" }, true).exposure, "hidden");
});

test("legacy and unknown hosts retain the original API without native metadata", () => {
  const api = {} as ExtensionAPI;
  assert.equal(withNativeToolPolicy(api, "0.87.0", true), api);
  assert.equal(withNativeToolPolicy(api, undefined, true), api);
  const registered: ToolDefinition[] = [];
  const native = withNativeToolPolicy({ registerTool(definition: ToolDefinition) { registered.push(definition); }, on() {} } as unknown as ExtensionAPI, "0.99.0", true);
  native.registerTool(tool("lsp"));
  assert.equal(registered[0]?.exposure, "deferred");
});

test("registration decorators compose without mutating or recursively calling the host API", () => {
  const registered: ToolDefinition[] = [];
  const originalRegister = (definition: ToolDefinition): void => { registered.push(definition); };
  const original = { registerTool: originalRegister, on() {} } as unknown as ExtensionAPI;
  const native = withNativeToolPolicy(original, "0.99.0", true);
  const previous = native.registerTool.bind(native);
  native.registerTool = (definition: ToolDefinition): void => previous({ ...definition, label: "wrapped" });
  native.registerTool(tool("todo"));
  assert.equal(registered.length, 1);
  assert.equal(registered[0]?.exposure, "model-only");
  assert.equal(registered[0]?.label, "wrapped");
  assert.equal(original.registerTool, originalRegister);
});

type StartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => unknown;

function discoveryHarness(options: { search?: boolean; rejectSearch?: boolean } = {}) {
  const definitions = new Map<string, ToolDefinition>();
  const handlers: StartHandler[] = [];
  const notifications: string[] = [];
  const activations: string[][] = [];
  let active = ["read", "bash"];
  const api = {
    registerTool(definition: ToolDefinition) {
      definitions.set(definition.name, definition);
      const exposure = definition.exposure ?? "direct";
      if ((exposure === "direct" || exposure === "model-only") && definition.defaultActive !== false && !active.includes(definition.name)) {
        active.push(definition.name);
      }
    },
    getAllTools() { return [...definitions.values()]; },
    getActiveTools() { return [...active]; },
    setActiveTools(names: string[]) {
      active = names.filter((name) => name !== "tool_search" || !options.rejectSearch);
      activations.push([...active]);
    },
    on(event: string, handler: StartHandler) { if (event === "session_start") handlers.push(handler); },
  } as unknown as ExtensionAPI;
  const ctx = { ui: { notify(message: string) { notifications.push(message); } } } as unknown as ExtensionContext;
  if (options.search !== false) createToolSearchExtension()(api);
  const native = withNativeToolPolicy(api, "0.99.0", true);
  return {
    api, native, definitions, activations, notifications, ctx,
    start(reason: SessionStartEvent["reason"] = "startup") {
      for (const handler of handlers) handler({ type: "session_start", reason }, ctx);
    },
  };
}

test("session start enables host search while low-frequency tools stay deferred and discoverable", async () => {
  const h = discoveryHarness();
  for (const name of ["browser", "computer_use", "lsp", "loop", "conflict", "smart_search", "source_check", "model-availability"]) h.native.registerTool(tool(name));
  h.native.registerTool(tool("todo"));
  h.native.registerTool(tool("search"));
  h.api.registerTool(tool("foreign-tool"));
  h.start();
  assert.deepEqual(h.api.getActiveTools(), ["read", "bash", "todo", "search", "foreign-tool", "tool_search"]);
  assert.equal(h.definitions.has("search_tool_bm25"), false);
  assert.deepEqual(h.notifications, []);
  const search = h.definitions.get("tool_search")!;
  const result = await search.execute("discover-browser", { query: "browser", limit: 1 }, undefined, undefined, h.ctx);
  assert.deepEqual(result.details, { loaded: ["browser"] });
  assert.equal(h.api.getActiveTools().includes("browser"), true);
  assert.equal(h.definitions.get("browser")?.exposure, "deferred");
});

test("resume, fork, and reload keep previously discovered and foreign tools active", () => {
  for (const reason of ["resume", "fork", "reload"] as const) {
    const h = discoveryHarness();
    h.native.registerTool(tool("browser"));
    h.api.setActiveTools(["read", "bash", "browser", "foreign-tool"]);
    h.start(reason);
    assert.deepEqual(h.api.getActiveTools(), ["read", "bash", "browser", "foreign-tool", "tool_search"]);
    h.start(reason);
    assert.equal(h.activations.length, 2, "already active search is not reactivated");
  }
});

test("missing, hidden, or unactivatable native search restores only plugin-owned deferred defaults", () => {
  for (const state of ["missing", "hidden", "rejected"] as const) {
    const h = discoveryHarness({ search: state !== "missing", rejectSearch: state === "rejected" });
    if (state === "hidden") h.api.registerTool({ ...tool("tool_search"), exposure: "hidden" });
    const browser = tool("browser");
    h.native.registerTool(browser);
    h.native.registerTool({ ...tool("lsp"), exposure: "hidden" });
    h.api.registerTool({ ...tool("foreign-deferred"), exposure: "deferred" });
    h.start();
    assert.equal(h.definitions.get("browser")?.exposure, "direct");
    assert.equal(h.definitions.get("browser")?.execute, browser.execute);
    assert.equal(h.api.getActiveTools().includes("browser"), true);
    assert.equal(h.definitions.get("lsp")?.exposure, "hidden");
    assert.equal(h.definitions.get("foreign-deferred")?.exposure, "deferred");
    assert.equal(h.api.getActiveTools().includes("foreign-deferred"), false);
    assert.equal(h.definitions.has("search_tool_bm25"), false);
    assert.equal(h.notifications.length, 1);
    h.start("reload");
    assert.equal(h.notifications.length, 1);
    h.native.registerTool(tool("loop"));
    assert.equal(h.definitions.get("loop")?.exposure, "direct");
  }
});

test("explicit opt-out keeps tools direct without activating host search", () => {
  const registered: ToolDefinition[] = [];
  const api = {
    registerTool(definition: ToolDefinition) { registered.push(definition); },
    on() { assert.fail("opt-out must not register activation hooks"); },
  } as unknown as ExtensionAPI;
  const native = withNativeToolPolicy(api, "0.99.0", isNativeDiscoverySelected({ defaultTools: ["-tool_search"] }));
  native.registerTool(tool("browser"));
  assert.equal(registered[0]?.exposure, "direct");
});

test("native and unknown hosts never register legacy discovery or its lifecycle handlers", () => {
  for (const version of ["0.99.0", "0.100.0", "0.99.0-rc.1", undefined]) {
    const api = new Proxy({} as ExtensionAPI, { get() { return () => assert.fail("legacy action attempted"); } });
    registerSearchToolBm25(api, version);
  }
});
