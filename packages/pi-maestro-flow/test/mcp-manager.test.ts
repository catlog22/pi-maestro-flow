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
    canAuthenticate: false,
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
    canAuthenticate: true,
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
    canAuthenticate: false,
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
  assert.match(wide, /MCP Control Center/);
  assert.match(wide, /filesystem/);
  assert.match(wide, /read_file, write_file, list_directory/);
  assert.match(wide, /MCP_TOKEN=\*\*\*\*\*\*\*\*/);
  assert.doesNotMatch(wide, /super-secret/);
  assert.match(overlay.render(12)[0], /Esc/);
});

test("MCP manager supports paste filtering, scope cycling, detail back navigation, and actions", () => {
  const filtered = createOverlay();
  filtered.overlay.render(60);
  filtered.overlay.handleInput("private-registry");
  assert.match(filtered.overlay.render(60).join("\n"), /private-registry/);
  assert.doesNotMatch(filtered.overlay.render(60).join("\n"), /› ● Connected filesystem/);
  assert.ok(filtered.renders() > 0);

  filtered.overlay.handleInput("a");
  assert.equal(filtered.action(), undefined, "lowercase text must remain available to the filter");
  filtered.overlay.handleInput("\x7f");

  filtered.overlay.handleInput("\r");
  assert.match(filtered.overlay.render(60).join("\n"), /https:\/\/mcp\.example\.com/);
  filtered.overlay.handleInput("\x1b");
  assert.doesNotMatch(filtered.overlay.render(60).join("\n"), /https:\/\/mcp\.example\.com/);
  filtered.overlay.handleInput("\x1b");
  assert.match(filtered.overlay.render(60).join("\n"), /filesystem/);

  const scoped = createOverlay();
  scoped.overlay.render(80);
  scoped.overlay.handleInput("\t");
  const userOnly = scoped.overlay.render(80).join("\n");
  assert.match(userOnly, /\[User\]/);
  assert.match(userOnly, /filesystem/);
  assert.doesNotMatch(userOnly, /private-registry/);

  scoped.overlay.handleInput("E");
  assert.equal(scoped.action()?.kind, "edit");
  assert.equal(scoped.action()?.serverName, "filesystem");
  assert.equal(scoped.action()?.uiState.scope, "user");
});

test("MCP manager keeps an add recovery path for empty configurations", () => {
  let action: McpManagerAction | undefined;
  const overlay = new McpManagerOverlay({
    servers: [],
    theme,
    requestRender() {},
    done: (next) => { action = next; },
  });
  assert.match(overlay.render(48).join("\n"), /press A to add one/);
  overlay.handleInput("A");
  assert.equal(action?.kind, "add");
});
