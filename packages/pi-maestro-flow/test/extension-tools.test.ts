import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerMaestroExtension from "../src/extension/index.ts";
import { shutdownIntelligenceTools } from "../src/tools/intelligence.ts";

test("extension registers LSP, browser, and BM25 discovery", async () => {
  const tools: ToolDefinition[] = [];
  const active: string[] = [];
  const commands: string[] = [];
  const renderers: string[] = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const api = new Proxy({} as ExtensionAPI, {
    get(_target, property) {
      if (property === "registerTool") return (tool: ToolDefinition) => { tools.push(tool); active.push(tool.name); };
      if (property === "registerCommand") return (name: string) => { commands.push(name); };
      if (property === "registerMessageRenderer") return (name: string) => { renderers.push(name); };
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
  assert.ok(names.includes("run-control"));
  assert.ok(commands.includes("maestro-session"));
  assert.ok(renderers.includes("run-event"));

  const runControl = tools.find((tool) => tool.name === "run-control");
  const actionSchema = (runControl?.parameters as { properties?: { action?: { anyOf?: Array<{ const?: string }> } } })
    ?.properties?.action;
  assert.deepEqual(actionSchema?.anyOf?.map((item) => item.const), [
    "status", "brief", "prepare", "advance", "complete", "retry", "cancel",
  ]);

  const maestro = tools.find((tool) => tool.name === "maestro");
  const maestroProperties = (maestro?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.ok(maestroProperties?.name, "maestro delegate schema should expose a stable task name");
  assert.ok(maestroProperties?.concurrency, "maestro explore schema should expose a concurrency bound");

  const askTool = tools.find((tool) => tool.name === "ask-user-question");
  assert.ok(askTool?.renderResult);
  const renderAskResult = askTool.renderResult as unknown as (
    result: unknown,
    options: { expanded: boolean; isPartial: boolean },
    theme: { fg(name: string, text: string): string },
  ) => { render(width: number): string[] };
  const askResult = {
    content: [{ type: "text", text: "ok" }],
    details: {
      answers: [
        { question: "First question?", selected: ["Alpha"] },
        { question: "Second question?", selected: ["Beta"], text: "with detail" },
      ],
    },
  };
  const theme = { fg: (_name: string, text: string) => text };
  const collapsed = renderAskResult(askResult, { expanded: false, isPartial: false }, theme).render(120);
  const expanded = renderAskResult(askResult, { expanded: true, isPartial: false }, theme).render(120);
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0], /First question\?.*Alpha/);
  assert.doesNotMatch(collapsed[0], /Second question/);
  assert.deepEqual(expanded.slice(1), [
    "1. First question? → Alpha",
    "2. Second question? → Beta — with detail",
  ]);

  let permissionPrompts = 0;
  const ctx = {
    cwd: "D:/workspace",
    hasUI: true,
    ui: {
      setWidget() {},
      setStatus() {},
      notify() {},
      async select() {
        permissionPrompts++;
        return "Deny";
      },
    },
    sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined, getSessionName: () => undefined },
  } as unknown as ExtensionContext;
  let toolResult: unknown;
  const toolEvent = { type: "tool_call", toolName: "bash", toolCallId: "permission-1", input: { command: "npm test" } };
  for (const handler of handlers.get("tool_call") ?? []) {
    toolResult = await handler(toolEvent, ctx);
    if ((toolResult as { block?: boolean } | undefined)?.block) break;
  }
  assert.equal(permissionPrompts, 1);
  assert.match((toolResult as { reason?: string }).reason ?? "", /denied by user/i);
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
