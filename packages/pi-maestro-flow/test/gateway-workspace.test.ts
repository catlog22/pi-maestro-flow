import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { workspaceIdForPath } from "../src/gateway/state-paths.ts";
import { WorkspaceRegistry } from "../src/gateway/workspace-registry.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";

test("workspace discovery is principal-filtered, lease-aware, redacted, and ID-addressable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-workspace-discovery-"));
  const first = join(root, "first");
  const second = join(root, "second");
  await mkdir(first);
  await mkdir(second);
  await writeFile(join(first, "value.txt"), "visible", "utf8");
  let now = Date.now();
  const registry = new WorkspaceRegistry({ path: join(root, "registry.json"), now: () => now });
  const firstRecord = await registry.register(first, { ttlMs: 1_000, ownerToken: "first-owner-token-1234" });
  const secondRecord = await registry.register(second, { mode: "permanent" });
  const config = createTestGatewayConfig(root, { mode: "bearer", token: "secret" });
  config.workspaces = [];
  const runtime = await GatewayRuntime.create({ config, cwd: root, workspaceRegistry: registry });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });

  const firstPrincipal = createGatewayPrincipal("http", "first", { authenticated: true, workspaceId: firstRecord.id });
  const secondPrincipal = createGatewayPrincipal("http", "second", { authenticated: true, workspaceId: secondRecord.id });
  const listed = await runtime.call("workspace", { action: "list", limit: 10 }, firstPrincipal);
  assert.equal(listed.ok, true);
  const firstPage = listed.data as { workspaces: Array<{ id: string; ownerToken?: string }>; nextCursor: number; hasMore: boolean };
  assert.deepEqual(firstPage.workspaces.map((workspace) => workspace.id), [firstRecord.id]);
  assert.equal(firstPage.workspaces[0]?.ownerToken, undefined);
  assert.equal(firstPage.nextCursor, 1);
  assert.equal(firstPage.hasMore, false);

  const hidden = await runtime.call("workspace", { action: "get", workspaceId: secondRecord.id }, firstPrincipal);
  assert.equal(hidden.error?.code, "not_found");
  const visible = await runtime.call("workspace", { action: "get", workspaceId: secondRecord.id }, secondPrincipal);
  assert.equal((visible.data as { workspace: { id: string; ownerToken?: string } }).workspace.id, secondRecord.id);
  assert.equal((visible.data as { workspace: { ownerToken?: string } }).workspace.ownerToken, undefined);

  const read = await runtime.call("file", { action: "read", workspaceId: firstRecord.id, path: "value.txt" }, firstPrincipal);
  assert.equal(read.ok, true);
  assert.equal((read.data as { content: string }).content, "visible");
  const executed = await runtime.call("exec", { action: "run", workspaceId: firstRecord.id, command: process.execPath, args: ["-e", "process.stdout.write(process.cwd())"] }, firstPrincipal);
  assert.equal(executed.ok, true);
  assert.equal((executed.data as { cwd: string }).cwd, firstRecord.path);
  const startedJob = await runtime.call("job", { action: "start", workspaceId: firstRecord.id, command: process.execPath, args: ["-e", "process.stdout.write(process.cwd())"] }, firstPrincipal);
  assert.equal(startedJob.ok, true);
  const jobId = (startedJob.data as { job: { id: string } }).job.id;
  let jobStatus: { status?: string; cwd?: string } | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await runtime.call("job", { action: "status", id: jobId }, firstPrincipal);
    jobStatus = (status.data as { job?: { status?: string; cwd?: string } } | undefined)?.job;
    if (jobStatus?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(jobStatus?.status, "completed");
  assert.equal(jobStatus?.cwd, firstRecord.path);
  const session = await runtime.call("session", {
    action: "create",
    workspaceId: firstRecord.id,
    ownerId: "first-member",
    expectedSessionRevision: 0,
    operationId: "create-by-workspace-id",
  }, firstPrincipal);
  assert.equal(session.ok, true);
  assert.equal((session.data as { session: { workspaceId: string } }).session.workspaceId, workspaceIdForPath(first));

  now += 1_001;
  const expired = await runtime.call("workspace", { action: "list" }, firstPrincipal);
  assert.deepEqual((expired.data as { workspaces: unknown[] }).workspaces, []);
  assert.equal((await runtime.call("workspace", { action: "get", path: first }, firstPrincipal)).error?.code, "not_found");
});

test("workspace schemas reject unknown fields and missing get references", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-workspace-schema-"));
  const runtime = await GatewayRuntime.create({ config: createTestGatewayConfig(root), cwd: root });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const principal = createGatewayPrincipal("stdio", "owner", { authenticated: true, workspacePath: root });
  assert.equal((await runtime.call("workspace", { action: "list", extra: true }, principal)).error?.code, "invalid_arguments");
  assert.equal((await runtime.call("workspace", { action: "get" }, principal)).error?.code, "invalid_arguments");
});
