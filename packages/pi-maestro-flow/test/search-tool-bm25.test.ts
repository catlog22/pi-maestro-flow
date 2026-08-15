import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { buildToolSearchIndex, searchTools, toDiscoverableTool } from "../src/tools/tool-discovery.ts";
import { createSearchToolBm25, deferLowFrequencyTools, registerSearchToolBm25 } from "../src/tools/search-tool-bm25.ts";

const tools: ToolInfo[] = [
  {
    name: "browser",
    description: "Control a headless browser and capture screenshots",
    parameters: Type.Object({ action: Type.String(), url: Type.Optional(Type.String()) }),
    sourceInfo: { path: "test", type: "extension" },
  },
  {
    name: "lsp",
    description: "Query language servers for diagnostics and symbol definitions",
    parameters: Type.Object({ action: Type.String(), file: Type.Optional(Type.String()) }),
    sourceInfo: { path: "test", type: "extension" },
  },
  {
    name: "todo",
    description: "Track multi-step tasks",
    parameters: Type.Object({ subject: Type.String() }),
    sourceInfo: { path: "test", type: "extension" },
  },
];

test("weighted BM25 ranks names and schema keys ahead of unrelated descriptions", () => {
  const index = buildToolSearchIndex(tools.map(toDiscoverableTool));
  assert.equal(searchTools(index, "browser screenshot", 2)[0]?.tool.name, "browser");
  assert.equal(searchTools(index, "diagnostics file", 2)[0]?.tool.name, "lsp");
  assert.throws(() => searchTools(index, "---", 3), /at least one letter or number/);
  assert.throws(() => searchTools(index, "browser", 0), /positive integer/);
});

test("session startup defers only low-frequency tools and keeps core tools eager", () => {
  let active = ["read", "todo", "mcp", "resource", "browser", "lsp", "smart_search"];
  const deferred = deferLowFrequencyTools({
    getActiveTools: () => active,
    setActiveTools: (names) => { active = names; },
  });

  assert.deepEqual(deferred, ["browser", "lsp", "smart_search"]);
  assert.deepEqual(active, ["read", "todo", "mcp", "resource"]);
});

test("search tool returns ranked details and activates only inactive matches", async () => {
  let active = ["todo"];
  const tool = createSearchToolBm25({
    getAllTools: () => tools,
    getActiveTools: () => active,
    setActiveTools: (names) => { active = names; },
  });
  const result = await tool.execute("call-1", { query: "browser screenshot", limit: 1 }, undefined, undefined, {} as never);
  assert.equal(result.isError, undefined);
  assert.equal(result.details?.tools[0]?.name, "browser");
  assert.equal(result.details?.tools[0]?.label, "Browser");
  assert.match(result.details?.tools[0]?.summary ?? "", /headless browser/);
  assert.deepEqual(result.details?.activated_tools, ["browser"]);
  assert.deepEqual(active, ["todo", "browser"]);

  const repeated = await tool.execute("call-2", { query: "browser screenshot", limit: 1 }, undefined, undefined, {} as never);
  assert.deepEqual(repeated.details?.activated_tools, []);
  assert.deepEqual(active, ["todo", "browser"], "activated tools stay sticky for the session");
});

test("search tool does not activate inactive tools outside its deferred pool", async () => {
  let active = ["todo"];
  const tool = createSearchToolBm25({
    getAllTools: () => tools,
    getActiveTools: () => active,
    setActiveTools: (names) => { active = names; },
  }, { canActivate: (name) => name === "lsp" });

  const result = await tool.execute("call-3", { query: "browser screenshot", limit: 1 }, undefined, undefined, {} as never);
  assert.equal(result.details?.tools[0]?.name, "browser");
  assert.deepEqual(result.details?.activated_tools, []);
  assert.deepEqual(active, ["todo"]);
});

test("registered search preserves consumed and pending eligibility across extension reload", async () => {
  let active = ["todo", "browser", "lsp"];
  const sessionManager = { getSessionId: () => "tool-search-session" };
  const createApi = () => {
    let registered: ReturnType<typeof createSearchToolBm25> | undefined;
    const handlers = new Map<string, (event: { reason?: string }, ctx: unknown) => void>();
    const api = {
      registerTool(tool: ReturnType<typeof createSearchToolBm25>) { registered = tool; },
      on(event: string, handler: (event: { reason?: string }, ctx: unknown) => void) { handlers.set(event, handler); },
      getAllTools: () => tools,
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => { active = names; },
    };
    registerSearchToolBm25(api as never);
    return { get tool() { return registered!; }, handlers };
  };
  const ctx = { sessionManager };

  const firstExtension = createApi();
  firstExtension.handlers.get("session_start")?.({ reason: "new" }, ctx);
  assert.deepEqual(active, ["todo"]);
  const sessionDescription = firstExtension.tool.description;
  assert.match(sessionDescription, /Tools hidden at session start and discoverable here:/);
  assert.match(sessionDescription, /- browser: Control a headless browser and capture screenshots/);
  assert.match(sessionDescription, /- lsp: Query language servers for diagnostics and symbol definitions/);
  assert.doesNotMatch(sessionDescription, /- todo:/);

  const first = await firstExtension.tool.execute("call-4", { query: "browser screenshot", limit: 1 }, undefined, undefined, {} as never);
  assert.deepEqual(first.details?.activated_tools, ["browser"]);
  assert.deepEqual(active, ["todo", "browser"]);
  assert.equal(firstExtension.tool.description, sessionDescription, "activation does not change the session-start description");

  active = ["todo"];
  const afterUserDisable = await firstExtension.tool.execute("call-5", { query: "browser screenshot", limit: 1 }, undefined, undefined, {} as never);
  assert.deepEqual(afterUserDisable.details?.activated_tools, []);
  assert.deepEqual(active, ["todo"], "search must not override a later user disable");
  assert.equal(firstExtension.tool.description, sessionDescription, "later active-tool changes do not change the description");

  firstExtension.handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
  const reloadedExtension = createApi();
  reloadedExtension.handlers.get("session_start")?.({ reason: "reload" }, ctx);
  assert.deepEqual(active, ["todo"], "reload does not re-defer or reactivate consumed tools");
  assert.equal(reloadedExtension.tool.description, sessionDescription, "reload reuses the original session description");

  const pending = await reloadedExtension.tool.execute("call-6", { query: "diagnostics file", limit: 1 }, undefined, undefined, {} as never);
  assert.deepEqual(pending.details?.activated_tools, ["lsp"], "unconsumed eligibility survives reload");
  assert.deepEqual(active, ["todo", "lsp"]);

  reloadedExtension.handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
});

test("search tool reports empty queries as stable tool errors", async () => {
  const tool = createSearchToolBm25({
    getAllTools: () => tools,
    getActiveTools: () => [],
    setActiveTools() {},
  });
  await assert.rejects(() => tool.execute("call-2", { query: "   " }, undefined, undefined, {} as never), /must not be empty/);
});
