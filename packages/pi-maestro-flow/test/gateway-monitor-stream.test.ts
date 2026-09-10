import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RunTeammateOptions, RunTeammateParams } from "pi-maestro-teammate/v1/execution";
import type { SingleResult } from "pi-maestro-teammate/v1/types";
import { GatewayDaemon } from "../src/gateway/daemon.ts";
import { GATEWAY_EVENT_NOTIFICATION_METHOD, type GatewayEventNotification } from "../src/gateway/event-contracts.ts";
import type { GatewayTeammatePort } from "../src/gateway/services/teammate-service.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
class LivePort implements GatewayTeammatePort {
  resolve?: (results: SingleResult[]) => void;
  runTeammate(_params: RunTeammateParams, options: RunTeammateOptions): Promise<SingleResult[]> {
    const correlationId = options.taskCorrelationIds?.[0] ?? "child";
    options.onChildSpawned?.({} as never, () => true, undefined, correlationId, 1);
    options.onProgress?.({ agent: "general", correlationId, status: "running", recentTools: [], toolCount: 1, tokens: 1, durationMs: 1, lastActivityAt: Date.now(), startedAt: Date.now() });
    return new Promise((resolve) => { this.resolve = resolve; });
  }
  send(): boolean { return true; }
}
function envelope(result: Awaited<ReturnType<Client["callTool"]>>) {
  const block = result.content[0];
  return JSON.parse(block?.type === "text" ? block.text : "null") as { ok: boolean; data?: Record<string, any>; error?: { code: string } };
}
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) { if (check()) return; await new Promise<void>((resolve) => setTimeout(resolve, 5)); }
  assert.fail("condition did not become true");
}

test("HTTPS Streamable MCP and real SSH-stdio relay deliver identical ordered Monitor notifications while polling remains available", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "gateway-stream-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "gateway-stream-workspace-"));
  const cert = join(home, "cert.pem"); const key = join(home, "key.pem");
  await execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-sha256", "-days", "1", "-nodes", "-subj", "/CN=localhost"]);
  const config = createTestGatewayConfig(workspace, { mode: "bearer", token: "stream-secret" });
  config.state.ownerPath = join(home, ".pi", "agent", "gateway", "v1", "owner.json");
  config.transport.http = { enabled: true, host: "127.0.0.1", port: 0, path: "/mcp", tls: { enabled: true, certFile: cert, keyFile: key } };
  const port = new LivePort();
  const daemon = new GatewayDaemon({ config, cwd: workspace, teammatePort: port, http: true, httpPort: 0, tunnelProviders: [] });
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  t.after(async () => {
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
    port.resolve?.([]); await daemon.stop(); await rm(home, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true });
  });
  await daemon.start();

  const stdioNotifications: GatewayEventNotification[] = [];
  const stdio = new Client({ name: "stdio-stream", version: "1" });
  stdio.fallbackNotificationHandler = async (notification) => { if (notification.method === GATEWAY_EVENT_NOTIFICATION_METHOD) stdioNotifications.push(notification as GatewayEventNotification); };
  const stdioTransport = new StdioClientTransport({ command: process.execPath, args: [join(packageRoot, "bin", "pi-maestro-gateway.mjs"), "connect", "--stdio"], cwd: packageRoot, env: { ...getDefaultEnvironment(), HOME: home, USERPROFILE: home }, stderr: "pipe" });
  await stdio.connect(stdioTransport);

  const httpNotifications: GatewayEventNotification[] = [];
  const http = new Client({ name: "https-stream", version: "1" });
  http.fallbackNotificationHandler = async (notification) => { if (notification.method === GATEWAY_EVENT_NOTIFICATION_METHOD) httpNotifications.push(notification as GatewayEventNotification); };
  const httpTransport = new StreamableHTTPClientTransport(new URL(daemon.http!.url), { requestInit: { headers: { authorization: "Bearer stream-secret" } } });
  await http.connect(httpTransport);
  assert.ok(http.getServerCapabilities()?.experimental?.["monitor-stream-v1"]);

  const described = envelope(await http.callTool({ name: "host", arguments: { action: "describe" } }));
  assert.equal((described.data?.features as string[]).includes("monitor-stream-v1"), true);
  const created = envelope(await stdio.callTool({ name: "session", arguments: { action: "create", sessionId: "stream", workspacePath: workspace, ownerId: "owner", expectedSessionRevision: 0, operationId: "create" } }));
  assert.equal(created.ok, true);
  const fingerprint = createHash("sha256").update("stream-secret").digest("hex").slice(0, 24);
  assert.equal((await daemon.runtime!.sessionStore.require("stream")).members[0]?.principalId, "stdio:local-owner");
  const joined = envelope(await stdio.callTool({ name: "session", arguments: { action: "join", sessionId: "stream", memberId: "owner", expectedSessionRevision: 1, operationId: "join", joiningMemberId: "web", joiningPrincipalId: `http:bearer:${fingerprint}`, role: "web", leaseTtlMs: 60_000 } }));
  assert.equal(joined.ok, true, JSON.stringify(joined));
  const started = envelope(await http.callTool({ name: "session", arguments: { action: "start-pi", sessionId: "stream", memberId: "web", operationId: "start", prompt: "stream" } }));
  assert.equal(started.ok, true); const handle = started.data!.monitorHandle as string;
  await until(() => port.resolve !== undefined);

  const httpSub = envelope(await http.callTool({ name: "monitor", arguments: { action: "subscribe", sessionId: "stream", memberId: "web", handle, cursor: 0 } }));
  const stdioSub = envelope(await stdio.callTool({ name: "monitor", arguments: { action: "subscribe", sessionId: "stream", memberId: "owner", handle, cursor: 0 } }));
  assert.equal(httpSub.ok, true); assert.equal(stdioSub.ok, true);
  const sent = envelope(await stdio.callTool({ name: "monitor", arguments: { action: "message", sessionId: "stream", memberId: "owner", operationId: "message", handle, message: "continue" } }));
  assert.equal(sent.ok, true);
  await until(() => httpNotifications.length >= 3 && stdioNotifications.length >= 3);
  const httpShape = httpNotifications.map((item) => [item.params.cursor, item.params.kind, item.params.handle]);
  const stdioShape = stdioNotifications.map((item) => [item.params.cursor, item.params.kind, item.params.handle]);
  assert.deepEqual(httpShape, stdioShape);
  assert.deepEqual(httpNotifications.map((item) => item.params.cursor), [...httpNotifications.map((item) => item.params.cursor)].sort((a, b) => a - b));
  assert.equal(new Set(httpNotifications.map((item) => item.params.eventId)).size, httpNotifications.length);

  const observed = envelope(await http.callTool({ name: "monitor", arguments: { action: "observe", sessionId: "stream", memberId: "web", handle, cursor: 0, limit: 16 } }));
  assert.equal(observed.ok, true); assert.ok((observed.data?.events as unknown[]).length >= 3, "observe polling is preserved");
  const waited = envelope(await http.callTool({ name: "monitor", arguments: { action: "wait", sessionId: "stream", memberId: "web", handle, timeoutMs: 5 } }));
  assert.equal(waited.ok, true); assert.equal(waited.data?.done, false, "wait polling is preserved");
  const result = envelope(await http.callTool({ name: "monitor", arguments: { action: "result", sessionId: "stream", memberId: "web", handle } }));
  assert.equal(result.ok, true); assert.equal(result.data?.done, false, "result polling is preserved");

  assert.equal(envelope(await http.callTool({ name: "monitor", arguments: { action: "unsubscribe", sessionId: "stream", memberId: "web", subscriptionId: httpSub.data!.subscriptionId } })).data?.unsubscribed, true);
  assert.equal(envelope(await stdio.callTool({ name: "monitor", arguments: { action: "unsubscribe", sessionId: "stream", memberId: "owner", subscriptionId: stdioSub.data!.subscriptionId } })).data?.unsubscribed, true);
  await http.close(); await stdio.close();
});
