import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startGatewayHttpServer } from "../src/gateway/http-server.ts";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";
import { workspaceIdForPath } from "../src/gateway/state-paths.ts";
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

test("bearer HTTP sessions authenticate and share the workspace-first catalog", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-http-bearer-"));
  const runtime = await runtimeFor(root, { mode: "bearer", token: "test-bearer-token" });
  const workspaceId = workspaceIdForPath(root);
  const published = await runtime.call("board", {
    action: "create", workspaceId, taskId: "http-board", title: "Claim over HTTP",
    expectedRevision: 0, operationId: "http-board-create",
  }, createGatewayPrincipal("stdio", "dispatcher", { authenticated: true, workspaceId }));
  assert.equal(published.ok, true);
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
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["workspace", "board", "host", "exec", "job", "file", "teammate", "session", "todo", "monitor"]);
  for (const tool of listed.tools) {
    assert.equal(tool.outputSchema?.type, "object");
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean");
    assert.equal(typeof tool.annotations?.destructiveHint, "boolean");
    assert.equal(typeof tool.annotations?.idempotentHint, "boolean");
    assert.equal(typeof tool.annotations?.openWorldHint, "boolean");
  }
  const boardList = await client.callTool({ name: "board", arguments: { action: "list", workspaceId } });
  const boardBlock = boardList.content[0];
  const boardEnvelope = JSON.parse(boardBlock && boardBlock.type === "text" ? boardBlock.text : "null") as { ok: boolean; data?: { tasks?: Array<{ id: string }> } };
  assert.deepEqual(boardEnvelope.data?.tasks?.map((task) => task.id), ["http-board"]);
  const claimed = await client.callTool({ name: "board", arguments: {
    action: "claim", workspaceId, taskId: "http-board", leaseTtlMs: 60_000,
    expectedRevision: 1, operationId: "http-board-claim",
  } });
  const claimBlock = claimed.content[0];
  const claimEnvelope = JSON.parse(claimBlock && claimBlock.type === "text" ? claimBlock.text : "null") as { ok: boolean; data?: { task?: { claim?: { actorType: string } } } };
  assert.equal(claimEnvelope.ok, true);
  assert.equal(claimEnvelope.data?.task?.claim?.actorType, "web");
  const called = await client.callTool({ name: "host", arguments: { action: "describe" } });
  const block = called.content[0];
  const envelope = JSON.parse(block && block.type === "text" ? block.text : "null") as { ok: boolean; data?: { service?: string }; meta?: { principalId?: string } };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data?.service, "gateway");
  assert.match(envelope.meta?.principalId ?? "", /^bearer:/);
  assert.equal(called.isError, false);
  assert.deepEqual(called.structuredContent, envelope);
  const invalid = await client.callTool({ name: "host", arguments: { action: "unknown" } });
  assert.equal(invalid.isError, true);
  assert.equal((invalid.structuredContent as { ok?: boolean } | undefined)?.ok, false);
  await client.close();

  const unknown = await fetch(new URL("/", server.url));
  assert.equal(unknown.status, 404);
});

test("open HTTP mutation migration is explicit, warns once for legacy access, and never restricts stdio owners", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-http-open-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceId = workspaceIdForPath(root);
  const openHttp = createGatewayPrincipal("http", "open-client", { authenticated: false, scopes: ["gateway"], workspaceId });
  const stdioOwner = createGatewayPrincipal("stdio", "owner", { authenticated: true, workspaceId });
  const warnings: string[] = [];
  const legacyConfig = createTestGatewayConfig(root, { mode: "open" });
  const legacy = await GatewayRuntime.create({ config: legacyConfig, cwd: root, warningSink: (message) => warnings.push(message) });
  const legacyWrite = await legacy.call("file", { action: "write", workspaceId, path: "legacy.txt", content: "legacy" }, openHttp);
  assert.equal(legacyWrite.ok, true);
  assert.equal((await legacy.call("file", { action: "stat", workspaceId, path: "legacy.txt" }, openHttp)).ok, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /allow_open_mutations/u);
  await legacy.close();

  const safeConfig = createTestGatewayConfig(root, { mode: "open", allowOpenMutations: false });
  const safe = await GatewayRuntime.create({ config: safeConfig, cwd: root });
  const denied = await safe.call("file", { action: "write", workspaceId, path: "http.txt", content: "denied" }, openHttp);
  assert.equal(denied.error?.code, "open_mutation_denied");
  const ownerWrite = await safe.call("file", { action: "write", workspaceId, path: "owner.txt", content: "owner" }, stdioOwner);
  assert.equal(ownerWrite.ok, true);
  assert.equal(await readFile(join(root, "owner.txt"), "utf8"), "owner");
  const restricted = createGatewayPrincipal("http", "restricted", { authenticated: true, scopes: ["unrelated"] });
  assert.equal((await safe.call("host", { action: "status" }, restricted)).error?.code, "capability_denied");
  await safe.close();
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
  assert.equal((await client.listTools()).tools.length, 10);
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
  assert.equal((await client.listTools()).tools.length, 10);
  await client.close();
});
