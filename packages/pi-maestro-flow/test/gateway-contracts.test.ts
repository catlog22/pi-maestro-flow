import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GATEWAY_CAPABILITIES_SCHEMA,
  GATEWAY_OWNER_RECORD_SCHEMA,
  GATEWAY_RESULT_SCHEMA,
  GATEWAY_STATE_VERSION,
  GATEWAY_TOOL_SCHEMA,
} from "../src/gateway/contracts.ts";
import {
  GatewayValidationError,
  parseGatewayCapabilities,
  parseGatewayOwnerRecord,
  parseGatewayResult,
  parseGatewayTool,
} from "../src/gateway/validation.ts";
import { decodeGatewayResult, encodeGatewayResult, gatewayError, gatewayOk } from "../src/gateway/result.ts";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";
import { GatewayPolicy } from "../src/gateway/policy.ts";
import { GatewayOwnerIdentityMismatchError, GatewayOwnerStore } from "../src/gateway/owner-store.ts";
import { WorkspaceLeaseConflictError, WorkspaceRegistry } from "../src/gateway/workspace-registry.ts";
import { Value } from "typebox/value";

const ownerToken = "owner-token-123456";
const now = 1_700_000_000_000;

function validTool(): Record<string, unknown> {
  return {
    version: GATEWAY_STATE_VERSION,
    name: "exec",
    description: "Execute a bounded command",
    inputSchema: { type: "object" },
    kind: "exec",
    executionMode: "sync",
    mutating: true,
  };
}

test("Gateway contracts are versioned and strict", () => {
  assert.deepEqual(parseGatewayTool(validTool()), validTool());
  assert.equal(Value.Check(GATEWAY_TOOL_SCHEMA, { ...validTool(), unknown: true }), false);
  assert.throws(() => parseGatewayTool({ ...validTool(), unknown: true }), GatewayValidationError);
  assert.deepEqual(parseGatewayCapabilities({ version: 1, tools: ["exec"], features: ["bounded-exec"] }).tools, ["exec"]);
  assert.equal(Value.Check(GATEWAY_CAPABILITIES_SCHEMA, { version: 1, tools: [], features: [], extra: true }), false);

  const owner = { version: 1, pid: 123, ownerToken, port: 9090, commandIdentity: "pi-maestro-gateway", startedAt: now };
  assert.deepEqual(parseGatewayOwnerRecord(owner), owner);
  assert.equal(Value.Check(GATEWAY_OWNER_RECORD_SCHEMA, { ...owner, extra: true }), false);
  assert.throws(() => parseGatewayOwnerRecord({ ...owner, port: 9090, socket: "x" }), GatewayValidationError);

  const ok = gatewayOk({ answer: 42 }, "request-1");
  const failed = gatewayError({ code: "denied", message: "No" }, "request-2");
  assert.deepEqual(ok.data, { answer: 42 });
  assert.equal((ok as Record<string, unknown>).value, undefined);
  assert.deepEqual(decodeGatewayResult(encodeGatewayResult(ok)), ok);
  assert.deepEqual(decodeGatewayResult(encodeGatewayResult(failed)), failed);
  assert.deepEqual(parseGatewayResult(ok), ok);
  assert.equal(Value.Check(GATEWAY_RESULT_SCHEMA, { ...ok, extra: true }), false);
  assert.throws(() => parseGatewayResult({ ...ok, error: { code: "bad", message: "bad" } }), GatewayValidationError);
});

test("workspace registry normalizes, renews, and fences stale generations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-registry-"));
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
  let clock = now;
  const registry = new WorkspaceRegistry({ path: join(root, "workspaces.json"), now: () => clock, maxTtlMs: 60_000 });
  const first = await registry.register(root, { ttlMs: 5_000, ownerToken });
  assert.equal(first.generation, 1);
  assert.equal(first.mode, "lease");
  assert.equal(first.canonicalPath, first.path);
  const renewed = await registry.renew(root, { expectedGeneration: 1, ownerToken, ttlMs: 10_000 });
  assert.equal(renewed.generation, 1);
  clock += 11_000;
  assert.equal(await registry.get(root), undefined);
  const replacement = await registry.register(root, { mode: "permanent", expectedGeneration: 1, ownerToken });
  assert.equal(replacement.generation, 2);
  await assert.rejects(() => registry.renew(root, { expectedGeneration: 1 }), WorkspaceLeaseConflictError);
  const persisted = JSON.parse(await readFile(join(root, "workspaces.json"), "utf8"));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.workspaces[0].mode, "permanent");
});

test("workspace registry serializes distinct writers across instances", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-registry-race-"));
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
  const path = join(root, "workspaces.json");
  const first = new WorkspaceRegistry({ path });
  const second = new WorkspaceRegistry({ path });
  await Promise.all([
    first.register(join(root, "one"), { mode: "permanent" }),
    second.register(join(root, "two"), { mode: "permanent" }),
  ]);
  assert.deepEqual((await first.list()).map((entry) => entry.path).sort(), [join(root, "one"), join(root, "two")].map((entry) => entry.toLowerCase()).sort());
});

test("stale lease removal cannot delete a newer generation and expiry cannot authorize policy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-registry-fence-"));
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
  let clock = now;
  const registry = new WorkspaceRegistry({ path: join(root, "workspaces.json"), now: () => clock });
  const first = await registry.register(root, { ttlMs: 100, ownerToken });
  const replacement = await registry.register(root, { ttlMs: 100, expectedGeneration: first.generation, ownerToken });
  await assert.rejects(
    () => registry.unregister(root, { expectedGeneration: first.generation, ownerToken }),
    WorkspaceLeaseConflictError,
  );
  assert.equal((await registry.get(root))?.generation, replacement.generation);
  clock += 101;
  assert.deepEqual(await registry.list(), []);
  assert.equal((await registry.list({ includeExpired: true })).length, 1);
  const policy = new GatewayPolicy({ registry });
  const principal = createGatewayPrincipal("stdio", "expired", { workspacePath: root });
  assert.equal((await policy.authorizePath(principal, root, ".", "read")).allowed, false);
});

test("owner store rejects stale legacy identity and only adopts exact matches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-owner-"));
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
  const ownerPath = join(root, "owner.json");
  const pidPath = join(root, "legacy.pid");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(pidPath, "42\n", "utf8"));
  const options = {
    path: ownerPath,
    legacyPidPath: pidPath,
    now: () => now,
    isProcessAlive: (pid: number) => pid === 42,
    getProcessIdentity: async (_pid: number) => "other-command",
  };
  const store = new GatewayOwnerStore(options);
  await assert.rejects(() => store.adoptLegacyPid({ expectedCommandIdentity: "pi-maestro-gateway", socket: join(root, "gateway.sock") }), GatewayOwnerIdentityMismatchError);

  const matching = new GatewayOwnerStore({ ...options, getProcessIdentity: async () => "pi-maestro-gateway" });
  const owner = await matching.adoptLegacyPid({ expectedCommandIdentity: "pi-maestro-gateway", socket: join(root, "gateway.sock") });
  assert.equal(owner?.pid, 42);
  assert.equal(await matching.isOwned(owner!.ownerToken), true);
  assert.equal(await matching.release(owner!.ownerToken), true);
  assert.equal(await matching.read(), undefined);
});

test("policy canonicalizes paths before authorization and enforces hard bounds", async () => {
  const principal = createGatewayPrincipal("stdio", "window", { workspacePath: process.cwd() });
  const policy = new GatewayPolicy({ workspaceRoot: process.cwd(), limits: { maxRequestBytes: 10, maxOutputBytes: 10 } });
  const decision = await policy.authorizePath(principal, process.cwd(), "./package.json", "read");
  assert.equal(decision.allowed, true);
  assert.ok(decision.canonicalPath);
  const denied = await policy.authorizePath(principal, process.cwd(), "../outside", "read");
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /escapes/);
  assert.throws(() => policy.checkRequest("12345678901"), /exceeds/);
  const release = policy.acquire("request");
  assert.equal(policy.activeCount("request"), 1);
  release();
  assert.equal(policy.activeCount("request"), 0);
});
