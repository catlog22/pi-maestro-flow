import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import { GatewayHttpAuth } from "../src/gateway/auth.ts";
import { GatewayPairingStore } from "../src/gateway/pairing-store.ts";

test("tunnel audience credentials cannot acquire the primary Gateway umbrella", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-credential-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new GatewayPairingStore({ path: join(root, "pairings.json") });
  for (const scope of ["gateway", "gateway.*", "*"]) {
    await assert.rejects(
      () => store.issue({ audience: "gateway.tunnel", scopes: [scope], provider: "cloudflare", instance: "edge-1" }),
      /cannot receive a primary Gateway umbrella/u,
    );
  }
  const tunnel = await store.issue({
    audience: "gateway.tunnel",
    scopes: ["gateway.host.status"],
    provider: "cloudflare",
    instance: "edge-1",
    generation: 2,
  });
  assert.equal(await store.authenticate(tunnel.token), undefined, "primary HTTPS rejects a tunnel-audience token");
  assert.equal(await store.authenticate(tunnel.token, { audience: "gateway.tunnel", provider: "other" }), undefined);
  assert.equal((await store.authenticate(tunnel.token, { audience: "gateway.tunnel", provider: "cloudflare", instance: "edge-1", generation: 2 }))?.scopes[0], "gateway.host.status");
});

test("tunnel audience token is accepted only on the loopback child-to-Gateway hop with narrow scopes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-loopback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new GatewayPairingStore({ path: join(root, "pairings.json") });
  const issued = await store.issue({
    ttlMs: 10_000,
    audience: "gateway.tunnel",
    scopes: ["gateway.host.status"],
    provider: "openai",
    instance: "default",
    generation: 4,
  });
  const auth = new GatewayHttpAuth({ mode: "bearer", token: "primary-secret" }, store);
  const request = (remoteAddress: string) => ({
    socket: { remoteAddress },
    headers: { authorization: `Bearer ${issued.token}` },
  }) as IncomingMessage;
  const loopback = await auth.authenticate(request("127.0.0.1"), "http://127.0.0.1/.well-known/oauth-protected-resource");
  assert.equal(loopback.principal?.scopes[0], "gateway.host.status");
  assert.match(loopback.principal?.source ?? "", /openai/u);
  const external = await auth.authenticate(request("203.0.113.10"), "https://gateway.example/.well-known/oauth-protected-resource");
  assert.equal(external.status, 401);
  assert.equal(external.principal, undefined);
});

test("legacy primary pairing defaults remain compatible", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-primary-credential-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new GatewayPairingStore({ path: join(root, "pairings.json") });
  const primary = await store.issue({ ttlMs: 1_000 });
  const accepted = await store.authenticate(primary.token, { audience: "gateway" });
  assert.deepEqual(accepted?.scopes, ["gateway"]);
  assert.equal(accepted?.audience, "gateway");
});
