import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { startGatewayIpcServer } from "../src/gateway/ipc.ts";
import { GatewayLocalClient } from "../src/gateway/local-client.ts";
import { createGatewayBoardTool, type GatewayBoardCaller } from "../src/tools/gateway-board.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";

function okResult(): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true, data: { tasks: [] } }) }],
    structuredContent: { ok: true, data: { tasks: [] } },
  };
}

test("native Board tool injects workspace, operation ids, and the current Pi session endpoint", async () => {
  const calls: Array<{ args: Record<string, unknown>; cwd: string }> = [];
  const caller: GatewayBoardCaller = {
    async call(args, options) {
      calls.push({ args, cwd: options.cwd });
      return okResult();
    },
  };
  const tool = createGatewayBoardTool(caller);
  const ctx = {
    cwd: "C:/workspace/project",
    sessionManager: { getSessionId: () => "pi-session-1" },
  } as never;

  await tool.execute("attach", {
    action: "attach-endpoint", taskId: "board-1", expectedRevision: 2,
  }, undefined, undefined, ctx);
  assert.equal(calls[0]?.cwd, "C:/workspace/project");
  assert.equal(calls[0]?.args.workspacePath, "C:/workspace/project");
  assert.equal(calls[0]?.args.endpointId, "pi-session-1");
  assert.equal(typeof calls[0]?.args.requestId, "string");
  assert.equal(typeof calls[0]?.args.operationId, "string");
  assert.equal(calls[0]?.args.kind, undefined);

  await tool.execute("list", { action: "list" }, undefined, undefined, ctx);
  assert.equal(calls[1]?.args.workspacePath, "C:/workspace/project");
  assert.equal(calls[1]?.args.endpointId, undefined);
  assert.equal(calls[1]?.args.operationId, undefined);
  assert.equal(typeof calls[1]?.args.requestId, "string");
});

test("GatewayLocalClient calls the persistent Gateway over authenticated IPC MCP", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-native-client-"));
  const runtime = await GatewayRuntime.create({ config: createTestGatewayConfig(root), cwd: root });
  const ownerToken = randomUUID();
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\pi-maestro-gateway-test-${randomUUID()}`
    : join(root, "gateway.sock");
  const ipc = await startGatewayIpcServer(runtime, { ownerToken, address });
  t.after(async () => {
    await ipc.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  const client = new GatewayLocalClient({
    cwd: root,
    controlClient: {
      async start() {
        return { online: true, owner: { socket: ipc.address, ownerToken } } as never;
      },
    },
  });
  const result = await client.call("board", { action: "list", workspacePath: root });
  assert.equal(result.isError, false);
  assert.equal((result.structuredContent as { ok?: unknown })?.ok, true);
});
