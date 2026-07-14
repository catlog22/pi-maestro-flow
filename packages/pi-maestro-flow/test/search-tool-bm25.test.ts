import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { buildToolSearchIndex, searchTools, toDiscoverableTool } from "../src/tools/tool-discovery.ts";
import { createSearchToolBm25 } from "../src/tools/search-tool-bm25.ts";

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
});

test("search tool reports empty queries as stable tool errors", async () => {
  const tool = createSearchToolBm25({
    getAllTools: () => tools,
    getActiveTools: () => [],
    setActiveTools() {},
  });
  await assert.rejects(() => tool.execute("call-2", { query: "   " }, undefined, undefined, {} as never), /must not be empty/);
});
