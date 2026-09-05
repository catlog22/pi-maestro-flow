import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";
import { GatewayPolicy } from "../src/gateway/policy.ts";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { FileService } from "../src/gateway/services/file-service.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";

const principal = (id: string, workspace: string) => createGatewayPrincipal("stdio", id, { authenticated: true, workspacePath: workspace });

test("Gateway runtime strictly rejects unknown and action-inapplicable RPC fields and audits redacted outcomes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-security-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = createTestGatewayConfig(root);
  config.logging.auditFile = join(root, "audit", "gateway.jsonl");
  const runtime = await GatewayRuntime.create({ config, cwd: root });
  t.after(() => runtime.close());
  const transportPrincipal = principal("transport-owner", root);

  const allowed = await runtime.call("host", { action: "describe", requestId: "allowed-1" }, transportPrincipal);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.meta.principalId, "transport-owner");

  const secret = "raw-secret-command-must-not-be-logged";
  const denied = await runtime.call("host", { action: "describe", command: secret, principal: { id: "forged" }, requestId: "denied-1" }, transportPrincipal);
  assert.equal(denied.ok, false);
  assert.equal(denied.error?.code, "invalid_arguments");
  assert.equal(denied.meta.principalId, "transport-owner");
  const errored = await runtime.call("missing", { action: "ignored", requestId: "error-1" }, transportPrincipal);
  assert.equal(errored.error?.code, "tool_not_found");

  const records = (await readFile(config.logging.auditFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.outcome), ["allowed", "denied", "error"]);
  assert.ok(records.every((record) => record.principalId === "transport-owner"));
  assert.doesNotMatch(JSON.stringify(records), /raw-secret|forged/);
});

test("policy uses one-way principal containment and expires configured leases", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "gateway-security-policy-"));
  const child = join(parent, "child");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(child));
  t.after(() => rm(parent, { recursive: true, force: true }));
  let clock = 100;
  const policy = new GatewayPolicy({ workspaces: [{ path: parent }, { path: child, mode: "lease", ttlMs: 10 }], now: () => clock });
  const childPrincipal = principal("child-owner", child);

  assert.equal((await policy.authorizeWorkspace(childPrincipal, parent)).allowed, false, "a child-bound principal must not authorize its parent");
  assert.equal((await policy.authorizeWorkspace(childPrincipal, child)).allowed, true);
  clock = 111;
  const expired = await policy.authorizeWorkspace(childPrincipal, child);
  assert.equal(expired.allowed, false);
  assert.match(expired.reason, /expired/);
});

test("trustedFullAccess changes only unmatched defaults inside canonical trusted roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-security-trusted-"));
  const outside = await mkdtemp(join(tmpdir(), "gateway-security-untrusted-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const config = createTestGatewayConfig(root, { mode: "bearer", token: "secret" });
  config.security.trustedFullAccess = { enabled: true, workspaceRoots: [root] };
  config.security.commands.default = "deny";
  const runtime = await GatewayRuntime.create({ config, cwd: root });
  t.after(() => runtime.close());
  const owner = principal("trusted-owner", root);
  const allowed = await runtime.exec.run({ command: process.execPath, args: ["-e", "process.stdout.write('ok')"], cwd: root, principal: owner });
  assert.equal(allowed.ok, true);
  runtime.exec.commandPolicy.deny.push("*");
  const denied = await runtime.exec.run({ command: process.execPath, args: ["-e", ""], cwd: root, principal: owner });
  assert.equal(denied.error?.code, "command_denied");
  const escaped = await runtime.exec.run({ command: process.execPath, args: ["-e", ""], cwd: outside, principal: owner });
  assert.equal(escaped.ok, false);
  assert.ok(["policy_denied", "command_denied"].includes(escaped.error?.code ?? ""));
});

test("file mutation keeps transport attribution, rejects symlink escapes, and serializes expected-hash commits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-security-file-"));
  const outside = await mkdtemp(join(tmpdir(), "gateway-security-outside-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const owner = principal("file-transport-owner", root);
  const policy = new GatewayPolicy({ workspaceRoot: root });
  const service = new FileService({ policy, workspaceRoot: root });

  const missing = await service.read({ workspace: root, path: "missing.txt", principal: owner });
  assert.equal(missing.ok, false);
  assert.equal(missing.meta.principalId, "file-transport-owner");

  const target = join(root, "target.txt");
  await writeFile(target, "before", "utf8");
  const initial = await service.read({ workspace: root, path: "target.txt", principal: owner });
  const [first, second] = await Promise.all([
    service.edit({ workspace: root, path: "target.txt", principal: owner, expectedSha256: initial.data!.sha256, content: "first" }),
    service.edit({ workspace: root, path: "target.txt", principal: owner, expectedSha256: initial.data!.sha256, content: "second" }),
  ]);
  assert.equal([first, second].filter((result) => result.ok).length, 1);
  assert.equal([first, second].filter((result) => result.error?.code === "hash_conflict").length, 1);

  const outsideTarget = join(outside, "outside.txt");
  await writeFile(outsideTarget, "safe", "utf8");
  await symlink(outsideTarget, join(root, "escape.txt"));
  const escaped = await service.write({ workspace: root, path: "escape.txt", principal: owner, content: "unsafe" });
  assert.equal(escaped.ok, false);
  assert.equal(await readFile(outsideTarget, "utf8"), "safe");
});
