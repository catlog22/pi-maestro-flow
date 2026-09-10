import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayPairingStore } from "../src/gateway/pairing-store.ts";
import { principalHasGatewayAction } from "../src/gateway/capabilities.ts";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";

test("pairings bind scopes, workspace, audience, provider, instance, generation, expiry, and replacement revocation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-pairing-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_000;
  const path = join(root, "pairings.json");
  const store = new GatewayPairingStore({ path, now: () => now });
  const issued = await store.issue({
    ttlMs: 100,
    scopes: ["gateway.file.read"],
    audience: "gateway.tunnel",
    workspaceId: "workspace-a",
    provider: "cloudflare",
    instance: "tunnel-1",
    generation: 3,
  });
  assert.equal((await store.authenticate(issued.token, { audience: "gateway.tunnel", workspaceId: "workspace-a", provider: "cloudflare", instance: "tunnel-1", generation: 3 }))?.id, issued.id);
  assert.equal(await store.authenticate(issued.token, { audience: "gateway" }), undefined);
  assert.equal(await store.authenticate(issued.token, { audience: "gateway.tunnel", workspaceId: "workspace-b" }), undefined);
  assert.equal(await store.authenticate(issued.token, { audience: "gateway.tunnel", generation: 4 }), undefined);

  const replacement = await store.issue({ ttlMs: 100, audience: "gateway.tunnel", scopes: ["gateway.file.read"], replacesId: issued.id });
  assert.equal(await store.authenticate(issued.token, { audience: "gateway.tunnel" }), undefined);
  const inactive = await store.list({ includeInactive: true });
  assert.equal(inactive.find((entry) => entry.id === issued.id)?.replacedById, replacement.id);
  assert.equal(inactive.find((entry) => entry.id === issued.id)?.revokedAt, now);

  now += 101;
  assert.equal(await store.authenticate(replacement.token, { audience: "gateway.tunnel" }), undefined, "expiry is fail closed");
  assert.doesNotMatch(await readFile(path, "utf8"), new RegExp(issued.token));
});

test("action capabilities keep primary umbrellas compatible without widening narrow pairings", () => {
  const primary = createGatewayPrincipal("http", "primary", { authenticated: true, scopes: ["gateway.*"] });
  const narrow = createGatewayPrincipal("http", "narrow", { authenticated: true, scopes: ["gateway.file.read"] });
  assert.equal(principalHasGatewayAction(primary, "exec", "run"), true);
  assert.equal(principalHasGatewayAction(narrow, "file", "read"), true);
  assert.equal(principalHasGatewayAction(narrow, "file", "write"), false);
  assert.equal(principalHasGatewayAction(narrow, "host", "status"), false);
});
