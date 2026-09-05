import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startGatewayHttpServer } from "../src/gateway/http-server.ts";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";

async function runtimeFor(root: string, auth: Parameters<typeof createTestGatewayConfig>[1]): Promise<GatewayRuntime> {
  const config = createTestGatewayConfig(root, auth);
  config.transport.http.enabled = true;
  return GatewayRuntime.create({ config, cwd: root });
}

test("rejects open authentication on a non-loopback HTTP listener", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-http-open-"));
  const runtime = await runtimeFor(root, { mode: "open" });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(() => startGatewayHttpServer(runtime, { host: "0.0.0.0", port: 0 }), /open is allowed only on loopback/);
  runtime.config.server.disableLocalhostProtection = true;
  await assert.rejects(() => startGatewayHttpServer(runtime, { host: "127.0.0.1", port: 0 }), /open is allowed only on loopback/);
});

test("rejects authenticated plaintext on a non-loopback listener", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-http-plaintext-"));
  const runtime = await runtimeFor(root, { mode: "bearer", token: "test-bearer-token" });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(() => startGatewayHttpServer(runtime, { host: "0.0.0.0", port: 0 }), /requires native TLS/);
});

test("bearer HTTP sessions authenticate and share the eight-tool catalog", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-http-bearer-"));
  const runtime = await runtimeFor(root, { mode: "bearer", token: "test-bearer-token" });
  const server = await startGatewayHttpServer(runtime, { host: "127.0.0.1", port: 0 });
  t.after(async () => { await server.close(); await runtime.close(); await rm(root, { recursive: true, force: true }); });

  const unauthorized = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "unauthorized", version: "1" } } }),
  });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate") ?? "", /oauth-protected-resource\/mcp/);

  const client = new Client({ name: "gateway-http-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { authorization: "Bearer test-bearer-token" } },
  });
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["host", "exec", "job", "file", "teammate", "session", "todo", "monitor"]);
  const called = await client.callTool({ name: "host", arguments: { action: "describe" } });
  const block = called.content[0];
  const envelope = JSON.parse(block && block.type === "text" ? block.text : "null") as { ok: boolean; data?: { service?: string }; meta?: { principalId?: string } };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data?.service, "gateway");
  assert.match(envelope.meta?.principalId ?? "", /^bearer:/);
  await client.close();

  const unknown = await fetch(new URL("/", server.url));
  assert.equal(unknown.status, 404);
});

test("health/readiness expose no secrets and persisted pairing tokens authenticate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-http-health-"));
  const runtime = await runtimeFor(root, { mode: "bearer", token: "configured-secret" });
  const issued = await runtime.pairingStore.issue({ ttlMs: 60_000 });
  const server = await startGatewayHttpServer(runtime, { host: "127.0.0.1", port: 0 });
  t.after(async () => { await server.close(); await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const health = await fetch(new URL("/healthz", server.url));
  assert.equal(health.status, 200);
  assert.doesNotMatch(await health.text(), /configured-secret|pair-/);
  assert.equal((await fetch(new URL("/readyz", server.url))).status, 200);
  server.setReady(false);
  assert.equal((await fetch(new URL("/readyz", server.url))).status, 503);
  server.setReady(true);

  const client = new Client({ name: "gateway-pairing-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${issued.token}` } } });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 8);
  await client.close();
});

test("OAuth metadata, password authorization callback, token exchange, and MCP access work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-http-oauth-"));
  const runtime = await runtimeFor(root, { mode: "oauth", oauth: { password: "ops-password", tokenTtlMs: 60_000 } });
  const server = await startGatewayHttpServer(runtime, { host: "127.0.0.1", port: 0 });
  t.after(async () => { await server.close(); await runtime.close(); await rm(root, { recursive: true, force: true }); });

  const metadata = await fetch(new URL("/.well-known/oauth-authorization-server", server.url));
  assert.equal(metadata.status, 200);
  const metadataBody = await metadata.json() as { token_endpoint?: string };
  assert.equal(metadataBody.token_endpoint, new URL("/token", server.url).href);

  const redirectUri = "http://127.0.0.1/callback";
  const registration = await fetch(new URL("/register", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri] }),
  });
  assert.equal(registration.status, 201);
  const { client_id: clientId } = await registration.json() as { client_id: string };

  const authorize = new URL("/authorize", server.url);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("state", "state-1");
  authorize.searchParams.set("code_challenge", "verifier");
  authorize.searchParams.set("code_challenge_method", "plain");
  const page = await fetch(authorize);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Operations password/);

  const approval = await fetch(new URL("/authorize", server.url), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      state: "state-1",
      code_challenge: "verifier",
      code_challenge_method: "plain",
      password: "ops-password",
    }),
  });
  assert.equal(approval.status, 302);
  const callback = new URL(approval.headers.get("location")!);
  assert.equal(callback.searchParams.get("state"), "state-1");
  const code = callback.searchParams.get("code")!;

  const exchanged = await fetch(new URL("/token", server.url), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: "verifier",
    }),
  });
  assert.equal(exchanged.status, 200);
  const { access_token: accessToken } = await exchanged.json() as { access_token: string };

  const client = new Client({ name: "gateway-oauth-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 8);
  await client.close();
});
