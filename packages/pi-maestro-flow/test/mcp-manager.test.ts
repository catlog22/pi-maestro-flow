import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { McpManagerOverlay, type McpManagerAction, type McpManagerServerView } from "../src/mcp/mcp-manager.ts";

const servers: McpManagerServerView[] = [
  {
    name: "filesystem",
    scope: "user",
    path: "/user/mcp.json",
    readOnly: false,
    status: "connected",
    toolNames: ["read_file", "write_file", "list_directory"],
    entry: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      env: { MCP_TOKEN: "super-secret", LOG_LEVEL: "info" },
      lifecycle: "lazy",
      directTools: true,
      exposeResources: true,
    },
  },
  {
    name: "private-registry",
    scope: "project",
    path: "/project/.mcp.json",
    readOnly: false,
    status: "needs-auth",
    toolNames: ["search_packages"],
    entry: { url: "https://mcp.example.com", auth: "oauth", lifecycle: "eager" },
  },
  {
    name: "cursor-import",
    scope: "import",
    path: "/user/mcp.json",
    readOnly: true,
    importKind: "cursor",
    status: "failed",
    toolNames: [],
    entry: { command: "cursor-mcp" },
  },
];

const theme = {
  fg(_role: string, text: string) { return text; },
  bold(text: string) { return text; },
};

function createOverlay(initialState = {}) {
  let action: McpManagerAction | undefined;
  let renders = 0;
  const overlay = new McpManagerOverlay({
    servers,
    theme,
    initialState,
    notice: "Saved · filesystem · reload pending",
    requestRender: () => { renders++; },
    done: (next) => { action = next; },
  });
  return { overlay, action: () => action, renders: () => renders };
}

test("MCP manager renders width-safely from 1 through 120 columns", () => {
  const { overlay } = createOverlay();
  for (let width = 1; width <= 120; width++) {
    for (const line of overlay.render(width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
    }
  }
  const wide = overlay.render(100).join("\n");
  assert.match(wide, /管理服务/);
  assert.match(wide, /编辑配置/);
  assert.match(overlay.render(12)[0], /Esc/);
});

test("MCP 菜单进入管理与配置，管理页使用显式筛选", () => {
  const filtered = createOverlay();
  filtered.overlay.render(60);
  filtered.overlay.handleInput("\r");
  assert.match(filtered.overlay.render(60).join("\n"), /filesystem/);
  assert.match(filtered.overlay.render(60).join("\n"), /按 \/ 输入服务名/);

  filtered.overlay.handleInput("/");
  filtered.overlay.handleInput("private-registry");
  assert.match(filtered.overlay.render(60).join("\n"), /private-registry/);
  assert.doesNotMatch(filtered.overlay.render(60).join("\n"), /filesystem · 本地/);
  assert.ok(filtered.renders() > 0);

  filtered.overlay.handleInput("D");
  assert.equal(filtered.action(), undefined, "筛选中不能触发字母功能键");
  filtered.overlay.handleInput("\x1b");
  assert.match(filtered.overlay.render(60).join("\n"), /filesystem/);

  const toggle = createOverlay();
  toggle.overlay.render(80);
  toggle.overlay.handleInput("\r");
  toggle.overlay.handleInput(" ");
  assert.equal(toggle.action()?.kind, "toggle");
  assert.equal(toggle.action()?.serverName, "filesystem");

  const remove = createOverlay();
  remove.overlay.render(80);
  remove.overlay.handleInput("\r");
  remove.overlay.handleInput("d");
  assert.equal(remove.action()?.kind, "delete");

  const edit = createOverlay();
  edit.overlay.render(80);
  edit.overlay.handleInput("2");
  assert.equal(edit.action()?.kind, "edit-config");
});

test("MCP 菜单为空配置保留编辑入口", () => {
  let action: McpManagerAction | undefined;
  const overlay = new McpManagerOverlay({
    servers: [],
    theme,
    requestRender() {},
    done: (next) => { action = next; },
  });
  assert.match(overlay.render(48).join("\n"), /编辑配置/);
  overlay.handleInput("2");
  assert.equal(action?.kind, "edit-config");
});
