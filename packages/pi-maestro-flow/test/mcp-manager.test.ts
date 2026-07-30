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
    canAuthenticate: false,
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
    canAuthenticate: true,
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
    canAuthenticate: false,
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

test("MCP 管理面板认证快捷键仅对可认证服务生效", () => {
  // Navigate to manage screen and select private-registry (index 1, canAuthenticate: true)
  const auth = createOverlay();
  auth.overlay.render(80);
  auth.overlay.handleInput("\r"); // enter manage
  auth.overlay.handleInput("\x1b[B"); // down to private-registry
  auth.overlay.handleInput("a");
  assert.equal(auth.action()?.kind, "authenticate");
  assert.equal(auth.action()?.serverName, "private-registry");

  // filesystem (index 0, canAuthenticate: false) should not trigger authenticate
  const noAuth = createOverlay();
  noAuth.overlay.render(80);
  noAuth.overlay.handleInput("\r"); // enter manage
  noAuth.overlay.handleInput("a");
  assert.equal(noAuth.action(), undefined, "不可认证的服务不触发 authenticate");

  // Wide layout shows auth hint for needs-auth server
  const wide = createOverlay({ detail: false });
  wide.overlay.render(80);
  wide.overlay.handleInput("\r");
  wide.overlay.handleInput("\x1b[B");
  const wideOutput = wide.overlay.render(100).join("\n");
  assert.match(wideOutput, /按 A 进行 OAuth 认证/);
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
