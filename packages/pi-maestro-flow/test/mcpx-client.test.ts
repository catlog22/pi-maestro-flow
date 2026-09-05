import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  McpxClientError,
  McpxStreamableHttpClient,
  parseMcpxResponseBody,
  type McpxRemoteSession,
} from "../src/tui/mcpx-client.ts";

function rpc(id: unknown, result: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function toolResult(id: unknown, structuredContent: Record<string, unknown>, isError = false): string {
  return rpc(id, { structuredContent, ...(isError ? { isError: true } : {}) });
}

test("parseMcpxResponseBody keeps the last valid SSE JSON-RPC frame", () => {
  const parsed = parseMcpxResponseBody("text/event-stream", [
    "event: message",
    "data: {broken",
    "",
    "data: {\"jsonrpc\":\"2.0\",",
    "data: \"id\":2,\"result\":{\"ok\":true}}",
    "",
  ].join("\n"));
  assert.equal(parsed?.id, 2);
  assert.deepEqual(parsed?.result, { ok: true });
});

test("Streamable HTTP client initializes, reuses the session header, and types pi_window calls", async (t) => {
  const sessionHeader = "mcpx-session-test";
  const seen: Array<{ method: string; session?: string; args?: Record<string, unknown> }> = [];
  let sendAttempts = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      seen.push({ method: payload.method, session: req.headers["mcp-session-id"] as string | undefined, args: payload.params?.arguments });
      if (payload.method === "initialize") {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Mcp-Session-Id", sessionHeader);
        res.end(rpc(payload.id, { protocolVersion: "2025-11-25", serverInfo: { name: "mcpx", version: "test" }, capabilities: {} }));
        return;
      }
      assert.equal(req.headers["mcp-session-id"], sessionHeader);
      if (payload.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (payload.method === "tools/list") {
        res.setHeader("Content-Type", "text/event-stream");
        res.end(`event: message\ndata: ${rpc(payload.id, { tools: [{ name: "pi_window", inputSchema: { properties: { action: { enum: ["list", "send", "observe"] } } } }] })}\n\n`);
        return;
      }
      if (payload.params?.name === "session") {
        res.setHeader("Content-Type", "application/json");
        res.end(toolResult(payload.id, { status: "ok", data: { sessions: [{ remote_session_id: "rs_1", workspace_name: "demo", label: "primary", status: "running" }] } }));
        return;
      }
      const args = payload.params?.arguments ?? {};
      if (args.action === "list") {
        res.setHeader("Content-Type", "text/event-stream");
        res.end(`data: ${toolResult(payload.id, { status: "ok", data: { windows: [
          { id: "owner-1", kind: "registered", managed: false, display_name: "editor", target: "owner:owner-1", owner_id: "owner-1", pid: 12, status: "running", cursor: 2 },
          { id: "piw_1", kind: "managed", managed: true, display_name: "worker", target: "piw_1", owner_id: "piw_1", pid: 13, status: "settled", cursor: 4 },
        ] } })}\n\n`);
        return;
      }
      if (args.action === "observe") {
        res.setHeader("Content-Type", "application/json");
        res.end(toolResult(payload.id, { status: "ok", data: {
          source: "registered", status: "running", cursor: 3, next_cursor: 3, oldest_cursor: 1, has_more: false,
          window: { id: "owner-1", kind: "registered", managed: false, display_name: "editor", target: "owner:owner-1", owner_id: "owner-1", pid: 12, status: "running", cursor: 3 },
          events: [{ cursor: 3, kind: "tool", at: 123, tool_call_id: "tc_1", tool_name: "bash", status: "completed" }],
        } }));
        return;
      }
      if (args.action === "send") {
        sendAttempts++;
        res.setHeader("Content-Type", "application/json");
        if (args.user_confirmed !== true) {
          res.end(toolResult(payload.id, { status: "needs_confirmation", error: { code: "user_confirmation_required", message: "confirm" }, data: {} }, true));
        } else {
          res.end(toolResult(payload.id, { status: "ok", data: { window_id: "piw_new", action: "prompt", created: true } }));
        }
        return;
      }
      res.statusCode = 500;
      res.end("unexpected request");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`;
  const client = new McpxStreamableHttpClient(endpoint);

  const sessions = await client.listRemoteSessions();
  assert.deepEqual(sessions, [{ sessionId: "rs_1", workspace: "demo", label: "primary", status: "running" }]);
  const windows = await client.listWindows(sessions[0]);
  assert.deepEqual(windows.map((window) => [window.kind, window.displayName, window.remoteSessionId]), [
    ["registered", "editor", "rs_1"],
    ["managed", "worker", "rs_1"],
  ]);
  const observation = await client.observeWindow(sessions[0], windows[0], 2, 20);
  assert.equal(observation.source, "registered");
  assert.equal(observation.nextCursor, 3);
  assert.deepEqual(observation.events[0], { cursor: 3, kind: "tool", at: 123, toolCallId: "tc_1", toolName: "bash", status: "completed" });
  const sent = await client.sendWindow({
    remoteSessionId: "rs_1", purpose: "new work", message: "do it", targetMode: "new",
    idempotencyKey: "idem-1", confirmed: true,
  });
  assert.equal(sent.windowId, "piw_new");
  assert.equal(sendAttempts, 2);
  assert.equal(seen.filter((entry) => entry.method === "initialize").length, 1);
  assert.ok(seen.slice(1).every((entry) => entry.session === sessionHeader));
});

test("Streamable HTTP client sends bearer auth and recovers after initialization failure", async (t) => {
  let initializeAttempts = 0;
  const authHeaders: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    authHeaders.push(req.headers.authorization);
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body) as { id?: number; method: string; params?: { name?: string } };
      if (payload.method === "initialize") {
        initializeAttempts++;
        if (initializeAttempts === 1) {
          res.statusCode = 500;
          res.end("temporary failure");
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Mcp-Session-Id", "session-auth");
        res.end(rpc(payload.id, { protocolVersion: "2025-11-25", capabilities: {} }));
        return;
      }
      if (payload.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      assert.equal(payload.params?.name, "session");
      res.setHeader("Content-Type", "application/json");
      res.end(toolResult(payload.id, { status: "ok", data: { sessions: [] } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const client = new McpxStreamableHttpClient(
    `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`,
    1_000,
    fetch,
    "bearer-secret",
  );
  await assert.rejects(client.listRemoteSessions(), /MCP HTTP 500/);
  assert.deepEqual(await client.listRemoteSessions(), []);
  assert.equal(initializeAttempts, 2);
  assert.ok(authHeaders.filter(Boolean).every((value) => value === "Bearer bearer-secret"));
});

test("Streamable HTTP client retries pi_window capability discovery after a failed schema", async (t) => {
  let capabilityAttempts = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body) as { id?: number; method: string };
      res.setHeader("Content-Type", "application/json");
      if (payload.method === "initialize") {
        res.end(rpc(payload.id, { protocolVersion: "2025-11-25", capabilities: {} }));
      } else if (payload.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
      } else if (payload.method === "tools/list") {
        capabilityAttempts++;
        const actions = capabilityAttempts === 1 ? ["list", "send"] : ["list", "send", "observe"];
        res.end(rpc(payload.id, { tools: [{ name: "pi_window", inputSchema: { properties: { action: { enum: actions } } } }] }));
      } else {
        res.end(toolResult(payload.id, { status: "ok", data: { windows: [] } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const client = new McpxStreamableHttpClient(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`);
  const remote: McpxRemoteSession = { sessionId: "rs_retry", workspace: "demo", status: "running" };
  await assert.rejects(client.listWindows(remote), (error: unknown) => error instanceof McpxClientError && error.kind === "unsupported");
  assert.deepEqual(await client.listWindows(remote), []);
  assert.equal(capabilityAttempts, 2);
});

test("Streamable HTTP client classifies authentication and old pi_window schemas", async (t) => {
  const authServer = createServer((_req, res) => {
    res.statusCode = 401;
    res.end("unauthorized");
  });
  await new Promise<void>((resolve) => authServer.listen(0, "127.0.0.1", resolve));
  t.after(() => authServer.close());
  const authAddress = authServer.address();
  const authClient = new McpxStreamableHttpClient(`http://127.0.0.1:${typeof authAddress === "object" && authAddress ? authAddress.port : 0}/mcp`);
  await assert.rejects(authClient.listRemoteSessions(), (error: unknown) => error instanceof McpxClientError && error.kind === "auth");

  let initialized = false;
  const oldServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body) as { id?: number; method: string };
      res.setHeader("Content-Type", "application/json");
      if (payload.method === "initialize") {
        initialized = true;
        res.end(rpc(payload.id, { protocolVersion: "2025-11-25", capabilities: {} }));
      } else if (payload.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
      } else {
        res.end(rpc(payload.id, { tools: [{ name: "pi_window", inputSchema: { properties: { action: { enum: ["list", "send"] }, cursor: { description: "observe cursor for newer runtimes" } } } }] }));
      }
    });
  });
  await new Promise<void>((resolve) => oldServer.listen(0, "127.0.0.1", resolve));
  t.after(() => oldServer.close());
  const oldAddress = oldServer.address();
  const oldClient = new McpxStreamableHttpClient(`http://127.0.0.1:${typeof oldAddress === "object" && oldAddress ? oldAddress.port : 0}/mcp`);
  const remote: McpxRemoteSession = { sessionId: "rs_old", workspace: "demo", status: "running" };
  await assert.rejects(oldClient.listWindows(remote), (error: unknown) => error instanceof McpxClientError && error.kind === "unsupported");
  assert.equal(initialized, true);
});

test("Streamable HTTP client types CollaborativeSession, Gateway Todo, and Monitor actions", async (t) => {
  const seen: Array<{ name?: string; args?: Record<string, unknown> }> = [];
  const now = Date.now();
  const session = { version: 1, id: "collab", status: "active", revision: 4, workspaceId: "a".repeat(64), workspacePath: "/work", createdAt: now, updatedAt: now };
  const member = { version: 1, id: "owner", sessionId: "collab", principalId: "http:bearer:test", role: "owner", status: "active", capabilities: ["session:read", "todo:read", "todo:write"], generation: 1, leaseExpiresAt: now + 60_000, joinedAt: now, updatedAt: now };
  const todo = { version: 1, id: "gw-1", sessionId: "collab", revision: 1, subject: "Gateway work", status: "pending", dependencyIds: [], creatorId: "owner", createdAt: now, updatedAt: now };
  const task = { version: 1, id: "handle-1", status: "lost", objective: "work", cwd: "/work", createdAt: now, updatedAt: now, workspaceId: "a".repeat(64), eventCursor: 12, resultCount: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      res.setHeader("Content-Type", "application/json");
      if (payload.method === "initialize") { res.end(rpc(payload.id, { protocolVersion: "2025-11-25", capabilities: {} })); return; }
      if (payload.method === "notifications/initialized") { res.statusCode = 202; res.end(); return; }
      const name = payload.params?.name; const args = payload.params?.arguments ?? {};
      seen.push({ name, args });
      if (name === "session" && args.action === "list") res.end(toolResult(payload.id, { status: "ok", data: { sessions: [session] } }));
      else if (name === "session") res.end(toolResult(payload.id, { status: "ok", data: { version: 1, session, members: [member], todos: [todo], operations: [], events: [] } }));
      else if (name === "todo" && args.action === "list") res.end(toolResult(payload.id, { status: "ok", data: { todos: [todo] } }));
      else if (name === "todo") res.end(toolResult(payload.id, { status: "ok", data: { todo: { ...todo, status: "in_progress", assigneeId: "owner" } } }));
      else if (name === "monitor" && args.action === "list") res.end(toolResult(payload.id, { status: "ok", data: { monitors: [{ handle: "handle-1", task }] } }));
      else if (name === "monitor" && args.action === "observe") res.end(toolResult(payload.id, { status: "ok", data: { handle: "handle-1", task, events: [{ cursor: 12, taskId: "handle-1", type: "state", at: now }], nextCursor: 12, oldestCursor: 8, hasMore: false, gap: true } }));
      else if (name === "monitor" && args.action === "cancel") res.end(toolResult(payload.id, { status: "ok", data: { handle: "handle-1", task } }));
      else { res.statusCode = 500; res.end("unexpected request"); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const client = new McpxStreamableHttpClient(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`);

  assert.deepEqual(await client.listRemoteSessions(["owner"]), [{ sessionId: "collab", workspace: "/work", label: undefined, status: "active" }]);
  assert.equal((await client.getGatewaySession("collab", "owner")).session.revision, 4);
  await client.renewGatewayMember("collab", "owner", 4, 1);
  assert.equal((await client.listGatewayTodos("collab", "owner"))[0]!.subject, "Gateway work");
  assert.equal((await client.mutateGatewayTodo({ action: "claim", sessionId: "collab", memberId: "owner", expectedSessionRevision: 4, todoId: "gw-1" })).status, "in_progress");
  assert.equal((await client.listGatewayMonitors("collab", "owner"))[0]!.task.status, "lost");
  const observation = await client.observeGatewayMonitor("collab", "owner", "handle-1", 7);
  assert.equal(observation.gap, true);
  assert.equal(observation.oldestCursor, 8);
  await client.cancelGatewayMonitor("collab", "owner", "handle-1");
  assert.equal(seen.find((entry) => entry.name === "session")?.args?.memberId, "owner");
  const renewal = seen.find((entry) => entry.name === "session" && entry.args?.action === "renew")!;
  assert.equal(renewal.args?.expectedGeneration, 1);
  assert.equal(typeof renewal.args?.operationId, "string");
  const mutation = seen.find((entry) => entry.name === "todo" && entry.args?.action === "claim")!;
  assert.equal(mutation.args?.expectedSessionRevision, 4);
  assert.equal(typeof mutation.args?.operationId, "string");
});

test("remote session discovery probes member identities concurrently", async () => {
  let active = 0;
  let maxActive = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { arguments?: { memberId?: string } } };
    if (payload.method === "initialize") {
      return new Response(rpc(payload.id, { protocolVersion: "2025-11-25", capabilities: {} }), {
        headers: { "Content-Type": "application/json", "Mcp-Session-Id": "parallel-session" },
      });
    }
    if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    const memberId = payload.params?.arguments?.memberId ?? "unknown";
    return new Response(toolResult(payload.id, {
      status: "ok",
      data: { sessions: [{ id: `session-${memberId}`, workspacePath: "/work", status: "active" }] },
    }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const client = new McpxStreamableHttpClient("http://gateway.test/mcp", 1_000, fetchImpl);

  const sessions = await client.listRemoteSessions(["member-a", "member-b", "member-c"]);
  assert.equal(sessions.length, 3);
  assert.ok(maxActive > 1, "one slow member must not serialize every status probe behind it");
});
