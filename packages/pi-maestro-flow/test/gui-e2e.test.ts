import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { startGuiServer } from "../src/gui/gui-server.ts";
import { registerToolRoutes } from "../src/gui/tool-routes.ts";
import { registerStateRoutes } from "../src/gui/gui-state.ts";
import { registerGuiTool, clearGuiTools } from "../src/gui/gui-registry.ts";
import { GuiClient, GuiClientError } from "../src/gui/client.ts";
import type { GuiPermissionGateway } from "../src/gui/types.ts";

const fakeCtx = {} as never;

function tool(name: string, execute: ToolDefinition["execute"]): ToolDefinition {
  return {
    name,
    label: name,
    description: `${name} desc`,
    parameters: { type: "object", properties: { action: { type: "string" } } },
    execute,
  } as unknown as ToolDefinition;
}

/** Gateway that denies when args.deny === true, else allows. */
const conditionalGateway: GuiPermissionGateway = {
  mode: () => "default",
  authorize: async (_name, input) =>
    input.deny === true ? { block: true as const, reason: "denied by test" } : undefined,
};

function hangingTool(name: string): ToolDefinition {
  return tool(name, async (_id, _params, signal) => {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve({ content: [{ type: "text", text: "done" }], details: {} }),
        5000,
      );
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
  });
}

test("e2e: GuiClient runs discover -> invoke (allow/deny) -> state -> events", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-e2e-"));
  const server = await startGuiServer({ sessionId: "sess-e2e", cwd });
  try {
    registerGuiTool(
      tool("todo", async (_id, params) => ({
        content: [{ type: "text", text: "ok" }],
        details: { echoed: params },
      })),
      "pi-maestro-flow",
    );
    registerToolRoutes(server, {
      listAllTools: () =>
        [
          {
            name: "todo",
            description: "Task management",
            parameters: { type: "object", properties: { action: { type: "string" } } },
            sourceInfo: { kind: "extension" },
          },
        ] as never,
      gateway: conditionalGateway,
      getCtx: () => fakeCtx,
    });
    registerStateRoutes(server, {
      goal: () => ({ objective: "ship ucl" }),
      todos: () => [{ id: "t1", status: "pending" }],
      approvalMode: () => "default",
      sessionId: () => "sess-e2e",
    });

    const client = await GuiClient.fromDiscovery(server.discoveryPath!);

    // health
    const health = await client.health();
    assert.equal(health.healthy, true);

    // discover
    const tools = await client.listTools();
    const todoView = tools.find((t) => t.name === "todo");
    assert.ok(todoView);
    assert.equal(todoView.guiCallable, true);
    assert.deepEqual(todoView.parameters, { type: "object", properties: { action: { type: "string" } } });

    // events: subscribe, then trigger via invoke
    const events: Array<{ name: string; data: unknown }> = [];
    const unsubscribe = client.subscribe((event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // invoke allow branch
    const ok = await client.invoke("todo", { action: "list" });
    assert.deepEqual(ok.details, { echoed: { action: "list" } });
    assert.ok(ok.toolCallId);

    // invoke deny branch
    await assert.rejects(
      () => client.invoke("todo", { deny: true }),
      (err: unknown) =>
        err instanceof GuiClientError && err.status === 403 && err.code === "permission_denied",
    );

    // state
    const state = await client.getState();
    assert.deepEqual(state.goal, { objective: "ship ucl" });
    assert.deepEqual(state.todos, [{ id: "t1", status: "pending" }]);
    assert.equal(state.approvalMode, "default");
    const goalSub = await client.getStateSub("goal");
    assert.deepEqual(goalSub, { goal: { objective: "ship ucl" } });

    // events received (tool.invoked for the successful invoke)
    await new Promise((resolve) => setTimeout(resolve, 100));
    const invoked = events.find((e) => e.name === "tool.invoked");
    assert.ok(invoked, "expected a tool.invoked event");
    assert.equal((invoked!.data as any).name, "todo");
    assert.equal((invoked!.data as any).ok, true);

    unsubscribe();
  } finally {
    server.close("done");
    clearGuiTools();
  }
});

test("hardening: server binds loopback only and every route requires a token", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-sec-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  try {
    assert.equal(server.address, "127.0.0.1", "must bind loopback only");
    registerToolRoutes(server, { listAllTools: () => [], gateway: conditionalGateway, getCtx: () => fakeCtx });
    registerStateRoutes(server, { goal: () => ({}) });

    const noToken = async (path: string, init?: RequestInit) =>
      (await fetch(`http://127.0.0.1:${server.port}${path}`, init)).status;
    assert.equal(await noToken("/tools"), 403);
    assert.equal(await noToken("/state"), 403);
    assert.equal(await noToken("/events"), 403);
    assert.equal(await noToken("/health"), 403);
    assert.equal(await noToken("/tools/todo", { method: "POST", body: JSON.stringify({ args: {} }) }), 403);
  } finally {
    server.close("done");
    clearGuiTools();
  }
});

test("hardening: concurrency limit returns 429", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-rl-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  try {
    registerGuiTool(hangingTool("todo"), "pi-maestro-flow");
    registerGuiTool(tool("goal", async () => ({ content: [], details: {} })), "pi-maestro-flow");
    registerToolRoutes(server, {
      listAllTools: () => [],
      gateway: conditionalGateway,
      getCtx: () => fakeCtx,
      maxConcurrentInvokes: 1,
    });
    const client = new GuiClient({ port: server.port, token: server.token });

    const first = client.invoke("todo", {}); // occupies the single slot for ~5s
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(
      () => client.invoke("goal", {}),
      (err: unknown) => err instanceof GuiClientError && err.status === 429 && err.code === "rate_limited",
    );
    // Clean up the in-flight slow invoke via cancel.
    first.catch(() => {});
  } finally {
    server.close("done");
    clearGuiTools();
  }
});

test("hardening: client timeoutMs aborts a hanging invoke (499)", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-to-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  try {
    registerGuiTool(hangingTool("todo"), "pi-maestro-flow");
    registerToolRoutes(server, { listAllTools: () => [], gateway: conditionalGateway, getCtx: () => fakeCtx });
    const client = new GuiClient({ port: server.port, token: server.token });
    await assert.rejects(
      () => client.invoke("todo", {}, { timeoutMs: 100 }),
      (err: unknown) => err instanceof GuiClientError && err.status === 499 && err.code === "cancelled",
    );
  } finally {
    server.close("done");
    clearGuiTools();
  }
});

test("hardening: explicit cancel(invokeId) aborts an in-flight invoke", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-cancel-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  try {
    registerGuiTool(hangingTool("todo"), "pi-maestro-flow");
    registerToolRoutes(server, { listAllTools: () => [], gateway: conditionalGateway, getCtx: () => fakeCtx });
    const client = new GuiClient({ port: server.port, token: server.token });

    const pending = client.invoke("todo", {}, { invokeId: "my-invoke-1" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cancelResult = await client.cancel("my-invoke-1");
    assert.equal(cancelResult.cancelled, true);
    await assert.rejects(
      () => pending,
      (err: unknown) => err instanceof GuiClientError && err.status === 499 && err.code === "cancelled",
    );

    // Cancelling an unknown id -> 404.
    await assert.rejects(
      () => client.cancel("nope"),
      (err: unknown) => err instanceof GuiClientError && err.status === 404,
    );
  } finally {
    server.close("done");
    clearGuiTools();
  }
});
