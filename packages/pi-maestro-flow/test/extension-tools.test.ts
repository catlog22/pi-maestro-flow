import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerMaestroExtension from "../src/extension/index.ts";
import { shutdownIntelligenceTools } from "../src/tools/intelligence.ts";

test("extension registers LSP, browser, and BM25 discovery", async () => {
  const tools: ToolDefinition[] = [];
  const active: string[] = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const api = new Proxy({} as ExtensionAPI, {
    get(_target, property) {
      if (property === "registerTool") return (tool: ToolDefinition) => { tools.push(tool); active.push(tool.name); };
      if (property === "getAllTools") return () => tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, sourceInfo: { path: "test", type: "extension" } }));
      if (property === "getActiveTools") return () => [...active];
      if (property === "setActiveTools") return (names: string[]) => { active.splice(0, active.length, ...names); };
      if (property === "on") return (event: string, handler: (...args: unknown[]) => unknown) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      };
      if (property === "getFlag") return () => undefined;
      if (property === "exec") return async () => ({ code: 0, stdout: "", stderr: "" });
      return () => undefined;
    },
  });

  registerMaestroExtension(api);
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes("lsp"));
  assert.ok(names.includes("browser"));
  assert.ok(names.includes("search_tool_bm25"));
  assert.equal(names.filter((name) => name === "lsp").length, 1);
  assert.equal(names.filter((name) => name === "browser").length, 1);
  assert.equal(names.filter((name) => name === "search_tool_bm25").length, 1);

  const ctx = {
    cwd: "D:/workspace",
    ui: { setWidget() {}, setStatus() {}, notify() {} },
    sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined, getSessionName: () => undefined },
  } as unknown as ExtensionContext;
  for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);
});

test("intelligence shutdown awaits both managers and contains cleanup failures", async () => {
  const calls: string[] = [];
  await shutdownIntelligenceTools({
    lsp: { async shutdown() { await new Promise((resolve) => setTimeout(resolve, 10)); calls.push("lsp"); } },
    browser: { async closeAll() { calls.push("browser"); throw new Error("close failed"); } },
  }, 100);
  assert.deepEqual(calls.sort(), ["browser", "lsp"]);
});
