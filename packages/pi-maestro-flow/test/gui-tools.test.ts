import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { startGuiServer } from "../src/gui/gui-server.ts";
import { registerToolRoutes } from "../src/gui/tool-routes.ts";
import { registerGuiTool, getGuiTool, listGuiTools, clearGuiTools } from "../src/gui/gui-registry.ts";
import { registerGuiTool as registerTeammateGuiTool } from "../../pi-maestro-teammate/src/shared/gui-registry.ts";

function fakeTool(name: string, label = name): ToolDefinition {
  return {
    name,
    label,
    description: `${name} description`,
    parameters: { type: "object", properties: { action: { type: "string" } } },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  } as unknown as ToolDefinition;
}

async function requestJson(port: number, path: string, token: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test("gui-registry: registers, looks up, lists, and classifies tools", () => {
  clearGuiTools();
  try {
    registerGuiTool(fakeTool("todo"), "pi-maestro-flow");
    registerTeammateGuiTool(fakeTool("teammate-list"), "pi-maestro-teammate");
    registerGuiTool(fakeTool("fs_read", "MCP: fs"), "mcp");

    const todo = getGuiTool("todo");
    assert.ok(todo);
    assert.equal(todo.owner, "pi-maestro-flow");
    assert.equal(todo.mutating, true);
    assert.equal(typeof todo.execute, "function");
    assert.deepEqual(todo.parameters, {
      type: "object",
      properties: { action: { type: "string" } },
    });

    const list = getGuiTool("teammate-list");
    assert.ok(list);
    assert.equal(list.mutating, false, "teammate-list is read-only");

    assert.equal(listGuiTools().length, 3);
    assert.equal(getGuiTool("missing"), undefined);

    // Re-registration replaces the prior entry (idempotent by name).
    registerGuiTool(fakeTool("todo"), "pi-maestro-flow");
    assert.equal(listGuiTools().length, 3);

    // Only the locked UCL surface may enter the cross-extension registry.
    registerGuiTool(fakeTool("lsp"), "pi-maestro-flow");
    registerGuiTool(fakeTool("browser"), "pi-maestro-flow");
    registerGuiTool(fakeTool("ffgrep"), "pi-maestro-flow");
    registerGuiTool(fakeTool("plan-status"), "pi-maestro-flow");
    registerGuiTool(fakeTool("anything"), "mcp");
    registerTeammateGuiTool(fakeTool("structured_output"), "pi-maestro-teammate");
    registerTeammateGuiTool(fakeTool("teammate-send"), "pi-maestro-teammate");

    assert.equal(getGuiTool("lsp"), undefined);
    assert.equal(getGuiTool("browser"), undefined);
    assert.equal(getGuiTool("ffgrep"), undefined);
    assert.equal(getGuiTool("structured_output"), undefined);
    assert.ok(getGuiTool("plan-status"));
    assert.ok(getGuiTool("anything"));
    assert.ok(getGuiTool("teammate-send"));
  } finally {
    clearGuiTools();
  }
});

test("GET /tools merges host catalog schema with registry invocability", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-tools-"));
  const server = await startGuiServer({ sessionId: "sess-tools", cwd, writeDiscovery: false });
  try {
    // Registry knows `todo` (invocable); catalog also lists `read` (not invocable).
    registerGuiTool(fakeTool("todo"), "pi-maestro-flow");

    const catalog: ToolInfo[] = [
      {
        name: "todo",
        description: "Task management",
        parameters: { type: "object", properties: { action: { type: "string" } } },
        sourceInfo: { kind: "extension" },
      },
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        sourceInfo: { kind: "builtin" },
      },
    ] as unknown as ToolInfo[];

    registerToolRoutes(server, { listAllTools: () => catalog });

    const resp = await requestJson(server.port, "/tools", server.token);
    assert.equal(resp.status, 200);
    assert.equal(resp.body.ok, true);
    const tools: any[] = resp.body.result;
    assert.equal(tools.length, 2);

    const todoView = tools.find((t) => t.name === "todo");
    assert.ok(todoView);
    assert.equal(todoView.guiCallable, true);
    assert.equal(todoView.owner, "pi-maestro-flow");
    assert.equal(todoView.mutating, true);
    assert.deepEqual(todoView.parameters, { type: "object", properties: { action: { type: "string" } } });

    const readView = tools.find((t) => t.name === "read");
    assert.ok(readView);
    assert.equal(readView.guiCallable, false, "builtin read is not in the GUI registry");
    assert.equal(readView.owner, "pi-core");
  } finally {
    server.close("test-done");
    clearGuiTools();
  }
});

test("GET /tools requires a valid token", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gui-tools-"));
  const server = await startGuiServer({ sessionId: "sess-auth", cwd, writeDiscovery: false });
  try {
    registerToolRoutes(server, { listAllTools: () => [] });
    const res = await fetch(`http://127.0.0.1:${server.port}/tools`);
    assert.equal(res.status, 403);
  } finally {
    server.close("test-done");
  }
});
