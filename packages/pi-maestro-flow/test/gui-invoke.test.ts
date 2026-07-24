import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { startGuiServer } from "../src/gui/gui-server.ts";
import { registerToolRoutes } from "../src/gui/tool-routes.ts";
import { registerGuiTool, clearGuiTools } from "../src/gui/gui-registry.ts";
import type { GuiPermissionGateway } from "../src/gui/types.ts";

const fakeCtx = {} as ExtensionContext;

function tool(name: string, execute: ToolDefinition["execute"]): ToolDefinition {
  return {
    name,
    label: name,
    description: `${name} desc`,
    parameters: { type: "object", properties: {} },
    execute,
  } as unknown as ToolDefinition;
}

const allowGateway: GuiPermissionGateway = {
  mode: () => "default",
  authorize: async () => undefined,
};

function denyGateway(reason: string): GuiPermissionGateway {
  return { mode: () => "default", authorize: async () => ({ block: true as const, reason }) };
}

async function postInvoke(
  port: number,
  token: string,
  name: string,
  args: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/tools/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ args }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function collectSse(port: number, token: string, eventName: string, timeoutMs = 2000): Promise<any[]> {
  return new Promise((resolve) => {
    const events: any[] = [];
    const req = http.get({ host: "127.0.0.1", port, path: `/events?session=${token}` }, (res) => {
      let buffer = "";
      let current: Partial<{ event: string; data: string }> = {};
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.startsWith(":")) continue;
          if (line === "") {
            if (current.event === eventName && current.data !== undefined) events.push(JSON.parse(current.data));
            current = {};
            continue;
          }
          const colon = line.indexOf(":");
          const field = colon >= 0 ? line.slice(0, colon) : line;
          const value = colon >= 0 ? line.slice(colon + 1).trimStart() : "";
          if (field === "event") current.event = value;
          else if (field === "data") current.data = value;
        }
      });
    });
    setTimeout(() => {
      req.destroy();
      resolve(events);
    }, timeoutMs);
  });
}

test("POST /tools/:name invokes the tool and serializes the result", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-invoke-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  try {
    let receivedArgs: unknown;
    registerGuiTool(
      tool("todo", async (_id, params) => {
        receivedArgs = params;
        return { content: [{ type: "text", text: "listed" }], details: { tasks: [1, 2, 3] } };
      }),
      "pi-maestro-flow",
    );
    registerToolRoutes(server, { listAllTools: () => [], gateway: allowGateway, getCtx: () => fakeCtx });

    const resp = await postInvoke(server.port, server.token, "todo", { action: "list" });
    assert.equal(resp.status, 200);
    assert.equal(resp.body.ok, true);
    assert.ok(resp.body.result.toolCallId);
    assert.deepEqual(resp.body.result.content, [{ type: "text", text: "listed" }]);
    assert.deepEqual(resp.body.result.details, { tasks: [1, 2, 3] });
    assert.deepEqual(receivedArgs, { action: "list" });
  } finally {
    server.close("done");
    clearGuiTools();
  }
});

test("POST /tools/:name enforces the permission gateway (deny blocks execute)", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-invoke-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  try {
    let executed = false;
    registerGuiTool(
      tool("goal", async () => {
        executed = true;
        return { content: [], details: {} };
      }),
      "pi-maestro-flow",
    );
    registerToolRoutes(server, {
      listAllTools: () => [],
      gateway: denyGateway("approval required"),
      getCtx: () => fakeCtx,
    });

    const resp = await postInvoke(server.port, server.token, "goal", { action: "create" });
    assert.equal(resp.status, 403);
    assert.equal(resp.body.ok, false);
    assert.equal(resp.body.code, "permission_denied");
    assert.equal(resp.body.error, "approval required");
    assert.equal(executed, false, "execute must not run when the gateway denies");
  } finally {
    server.close("done");
    clearGuiTools();
  }
});

test("POST /tools/:name handles unknown tool, missing ctx, and execute errors", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-invoke-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  try {
    registerGuiTool(
      tool("maestro", async () => {
        throw new Error("kaboom");
      }),
      "pi-maestro-flow",
    );
    registerToolRoutes(server, { listAllTools: () => [], gateway: allowGateway, getCtx: () => fakeCtx });

    const unknown = await postInvoke(server.port, server.token, "nope", {});
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, "not_invocable");

    const boom = await postInvoke(server.port, server.token, "maestro", {});
    assert.equal(boom.status, 500);
    assert.equal(boom.body.code, "tool_error");
    assert.match(boom.body.error, /kaboom/);
  } finally {
    server.close("done");
    clearGuiTools();
  }

  // No active context -> 503.
  const cwd2 = await mkdtemp(join(tmpdir(), "gui-invoke-"));
  const server2 = await startGuiServer({ sessionId: "s2", cwd: cwd2, writeDiscovery: false });
  try {
    registerGuiTool(tool("todo", async () => ({ content: [], details: {} })), "pi-maestro-flow");
    registerToolRoutes(server2, { listAllTools: () => [], gateway: allowGateway, getCtx: () => undefined });
    const resp = await postInvoke(server2.port, server2.token, "todo", {});
    assert.equal(resp.status, 503);
    assert.equal(resp.body.code, "no_context");
  } finally {
    server2.close("done");
    clearGuiTools();
  }
});

test("POST /tools/:name bridges onUpdate to SSE tool.progress", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-invoke-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  try {
    registerGuiTool(
      tool("maestro", async (_id, _params, _signal, onUpdate) => {
        onUpdate?.({ content: [{ type: "text", text: "partial" }], details: { step: 1 } });
        return { content: [{ type: "text", text: "final" }], details: { step: 2 } };
      }),
      "pi-maestro-flow",
    );
    registerToolRoutes(server, { listAllTools: () => [], gateway: allowGateway, getCtx: () => fakeCtx });

    const progress = collectSse(server.port, server.token, "tool.progress");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const resp = await postInvoke(server.port, server.token, "maestro", {});
    assert.equal(resp.status, 200);
    assert.deepEqual(resp.body.result.details, { step: 2 });

    const events = await progress;
    assert.ok(events.length >= 1, "expected at least one tool.progress event");
    assert.equal(events[0].name, "maestro");
    assert.deepEqual(events[0].partial.details, { step: 1 });
  } finally {
    server.close("done");
    clearGuiTools();
  }
});
