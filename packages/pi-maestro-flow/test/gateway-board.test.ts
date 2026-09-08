import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";
import { GATEWAY_MCP_INSTRUCTIONS } from "../src/gateway/prompt-guidance.ts";
import { workspaceIdForPath } from "../src/gateway/state-paths.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";

function taskOf(result: Awaited<ReturnType<GatewayRuntime["call"]>>) {
  return (result.data as { task?: { id: string; revision: number; status: string; phase: string; claim?: { generation: number }; endpointBindings?: Array<{ kind: string; endpointId: string; principalId: string }>; sessionBinding?: { sessionId: string }; planBinding?: { todoIds: string[] }; handoff?: { summary?: string; nextSteps?: string[]; resourceUris?: string[] }; result?: { handoff?: { summary?: string; nextSteps?: string[]; resourceUris?: string[] } } } } | undefined)?.task;
}

test("13-tool runtime closes the workspace Board to Session/Todo collaboration loop", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-board-runtime-"));
  const otherRoot = await mkdtemp(join(tmpdir(), "gateway-board-runtime-other-"));
  const config = createTestGatewayConfig(root, { mode: "bearer", token: "secret" });
  config.workspaces.push({ path: otherRoot, mode: "permanent" });
  const runtime = await GatewayRuntime.create({ config, cwd: root });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); await rm(otherRoot, { recursive: true, force: true }); });

  const workspaceId = workspaceIdForPath(root);
  const otherWorkspaceId = workspaceIdForPath(otherRoot);
  const pi = createGatewayPrincipal("stdio", "dispatcher", { authenticated: true, workspaceId });
  const web = createGatewayPrincipal("http", "web", { authenticated: true, workspaceId });
  const foreign = createGatewayPrincipal("http", "foreign", { authenticated: true, workspaceId: otherWorkspaceId });

  assert.deepEqual(runtime.catalog.list().map((tool) => tool.name), ["workspace", "board", "host", "exec", "job", "file", "teammate", "session", "todo", "monitor", "handoff", "skill", "maestro_cli"]);
  assert.equal((await runtime.call("board", { action: "list", workspaceId, extra: true }, web)).error?.code, "invalid_arguments");
  assert.equal((await runtime.call("teammate", { action: "start", workspaceId, params: { tasks: [{ prompt: "work", unknown: true }] } }, web)).error?.code, "invalid_arguments");
  assert.equal((await runtime.call("teammate", { action: "start", workspaceId, prompt: "work", options: { onProgress: "unsafe" } }, web)).error?.code, "invalid_arguments");

  const session = await runtime.call("session", {
    action: "create", sessionId: "board-session", workspaceId, ownerId: "web-member",
    expectedSessionRevision: 0, operationId: "session-create", leaseTtlMs: 60_000,
  }, web);
  assert.equal(session.ok, true);
  const todo = await runtime.call("todo", {
    action: "create", sessionId: "board-session", memberId: "web-member", todoId: "todo-1",
    subject: "Implement the Board task", expectedSessionRevision: 1, operationId: "todo-create",
  }, web);
  assert.equal(todo.ok, true);

  const created = await runtime.call("board", {
    action: "create", workspaceId, taskId: "board-1", title: "Ship collaborative Board",
    acceptanceCriteria: ["The linked Todo is completed"], completionPolicy: { requireLinkedTodosCompleted: true, requireReview: true },
    expectedRevision: 0, operationId: "board-create",
  }, pi);
  assert.equal(created.ok, true);
  assert.equal(taskOf(created)?.status, "open");

  const listed = await runtime.call("board", { action: "list", workspaceId, status: "open" }, web);
  assert.deepEqual((listed.data as { tasks: Array<{ id: string }> }).tasks.map((task) => task.id), ["board-1"]);
  assert.equal((await runtime.call("board", { action: "get", workspaceId, taskId: "board-1" }, foreign)).error?.code, "not_found");

  const claimed = await runtime.call("board", {
    action: "claim", workspaceId, taskId: "board-1", sessionId: "board-session", memberId: "web-member",
    leaseTtlMs: 60_000, expectedRevision: 1, operationId: "board-claim",
  }, web);
  assert.equal(claimed.ok, true);
  assert.equal(taskOf(claimed)?.claim?.generation, 1);
  assert.equal(taskOf(claimed)?.sessionBinding?.sessionId, "board-session");
  assert.equal((await runtime.call("board", {
    action: "renew", workspaceId, taskId: "board-1", claimGeneration: 1,
    expectedRevision: 1, operationId: "stale-renew",
  }, web)).error?.code, "board_conflict");
  assert.equal((await runtime.call("board", {
    action: "renew", workspaceId, taskId: "board-1", claimGeneration: 1,
    expectedRevision: 2, operationId: "foreign-renew",
  }, foreign)).error?.code, "not_found");

  const planned = await runtime.call("board", {
    action: "link-plan", workspaceId, taskId: "board-1", sessionId: "board-session", todoIds: ["todo-1"],
    claimGeneration: 1, expectedRevision: 2, operationId: "board-plan",
  }, web);
  assert.deepEqual(taskOf(planned)?.planBinding?.todoIds, ["todo-1"]);
  const active = await runtime.call("board", {
    action: "transition", workspaceId, taskId: "board-1", status: "active", phase: "execution",
    claimGeneration: 1, expectedRevision: 3, operationId: "board-active",
  }, web);
  assert.equal(taskOf(active)?.status, "active");
  const handoff = await runtime.call("board", {
    action: "handoff", workspaceId, taskId: "board-1",
    handoff: { summary: "Resume from review", nextSteps: ["Run the final verification"], resourceUris: ["agent://handoff"] },
    expectedRevision: 4, operationId: "board-handoff",
  }, web);
  assert.equal(taskOf(handoff)?.handoff?.summary, "Resume from review");

  assert.equal((await runtime.call("todo", {
    action: "claim", sessionId: "board-session", memberId: "web-member", todoId: "todo-1",
    expectedSessionRevision: 2, operationId: "todo-claim",
  }, web)).ok, true);
  assert.equal((await runtime.call("todo", {
    action: "advance", sessionId: "board-session", memberId: "web-member", todoId: "todo-1", status: "completed",
    expectedSessionRevision: 3, operationId: "todo-complete",
  }, web)).ok, true);

  const review = await runtime.call("board", {
    action: "transition", workspaceId, taskId: "board-1", phase: "review", claimGeneration: 1,
    expectedRevision: 5, operationId: "board-review",
  }, web);
  assert.equal(taskOf(review)?.phase, "review");
  const completed = await runtime.call("board", {
    action: "transition", workspaceId, taskId: "board-1", status: "completed", claimGeneration: 1,
    summary: "Verified", resourceUris: ["agent://verified"], expectedRevision: 6, operationId: "board-complete",
  }, web);
  assert.equal(taskOf(completed)?.status, "completed");

  const released = await runtime.call("board", {
    action: "release", workspaceId, taskId: "board-1", claimGeneration: 1,
    expectedRevision: 7, operationId: "board-release",
  }, web);
  assert.equal(released.ok, true);
  assert.equal(taskOf(released)?.status, "completed");
  assert.equal(taskOf(released)?.claim, undefined);
  assert.equal(taskOf(released)?.sessionBinding?.sessionId, "board-session");
  assert.deepEqual(taskOf(released)?.planBinding?.todoIds, ["todo-1"]);
  assert.equal(taskOf(released)?.result?.handoff?.summary, "Resume from review");
  const searched = await runtime.call("board", { action: "search", workspaceId, query: "Resume verification", limit: 8 }, web);
  assert.deepEqual((searched.data as { tasks: Array<{ id: string }> }).tasks.map((task) => task.id), ["board-1"]);

  const observed = await runtime.call("board", { action: "observe", workspaceId, cursor: 0, limit: 32 }, web);
  const events = (observed.data as { events: Array<{ cursor: number; type: string }>; nextCursor: number }).events;
  assert.deepEqual(events.map((event) => event.type), ["task.created", "task.claimed", "plan.linked", "status.changed", "handoff.updated", "status.changed", "task.completed", "task.released"]);
  assert.equal((observed.data as { nextCursor: number }).nextCursor, 8);
});

test("Gateway MCP publication keeps detailed action schemas and contract guidance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-schema-publication-"));
  const runtime = await GatewayRuntime.create({ config: createTestGatewayConfig(root), cwd: root });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });

  const published = runtime.catalog.list();
  const board = published.find((tool) => tool.name === "board");
  const boardSchema = board?.inputSchema as { oneOf?: Array<{ properties?: { action?: { const?: string } }; required?: string[] }> };
  assert.equal(boardSchema.oneOf?.length, 16);
  const create = boardSchema.oneOf?.find((schema) => schema.properties?.action?.const === "create");
  assert.deepEqual(create?.required, ["action", "title", "expectedRevision", "operationId"]);
  assert.match(board?.description ?? "", /create publishes work/);
  assert.doesNotMatch(board?.description ?? "", /publish, claim/);

  const handoff = published.find((tool) => tool.name === "handoff");
  const skill = published.find((tool) => tool.name === "skill");
  const maestroCli = published.find((tool) => tool.name === "maestro_cli");
  assert.equal((handoff?.inputSchema as { oneOf?: unknown[] }).oneOf?.length, 3);
  assert.equal((skill?.inputSchema as { oneOf?: unknown[] }).oneOf?.length, 2);
  assert.equal((maestroCli?.inputSchema as { oneOf?: unknown[] }).oneOf?.length, 3);
  assert.match(GATEWAY_MCP_INSTRUCTIONS, /governing knowledge/);
  assert.match(GATEWAY_MCP_INSTRUCTIONS, /never promote automatically/);
  assert.doesNotMatch(GATEWAY_MCP_INSTRUCTIONS, /create, list, get, update/);

  const monitor = published.find((tool) => tool.name === "monitor");
  const monitorSchema = monitor?.inputSchema as { oneOf?: Array<{ properties?: { action?: { const?: string }; handle?: { description?: string } } }> };
  const observe = monitorSchema.oneOf?.find((schema) => schema.properties?.action?.const === "observe");
  assert.match(observe?.properties?.handle?.description ?? "", /session\.start-pi/);
  assert.match(monitor?.description ?? "", /taskId or session\.start-pi\.monitorHandle/);
});

test("Board service derives Pi and Web endpoint kinds from authenticated transports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-board-endpoints-"));
  const runtime = await GatewayRuntime.create({ config: createTestGatewayConfig(root, { mode: "bearer", token: "secret" }), cwd: root });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });

  const workspaceId = workspaceIdForPath(root);
  const pi = createGatewayPrincipal("stdio", "dispatcher", { authenticated: true, workspaceId });
  const web = createGatewayPrincipal("http", "web", { authenticated: true, workspaceId });
  assert.equal((await runtime.call("board", {
    action: "create", workspaceId, taskId: "endpoint-board", title: "Share across endpoints",
    expectedRevision: 0, operationId: "endpoint-create",
  }, pi)).ok, true);
  const piAttached = await runtime.call("board", {
    action: "attach-endpoint", workspaceId, taskId: "endpoint-board", endpointId: "pi-session-1",
    expectedRevision: 1, operationId: "endpoint-attach-pi",
  }, pi);
  assert.equal(taskOf(piAttached)?.endpointBindings?.[0]?.kind, "pi");
  const webAttached = await runtime.call("board", {
    action: "attach-endpoint", workspaceId, taskId: "endpoint-board", endpointId: "web-session-1",
    expectedRevision: 2, operationId: "endpoint-attach-web",
  }, web);
  assert.deepEqual(taskOf(webAttached)?.endpointBindings?.map(({ kind, endpointId }) => ({ kind, endpointId })), [
    { kind: "pi", endpointId: "pi-session-1" },
    { kind: "web", endpointId: "web-session-1" },
  ]);
  assert.equal((await runtime.call("board", {
    action: "attach-endpoint", workspaceId, taskId: "endpoint-board", endpointId: "spoofed", kind: "pi",
    expectedRevision: 3, operationId: "endpoint-spoof",
  }, web)).error?.code, "invalid_arguments");
  const detached = await runtime.call("board", {
    action: "detach-endpoint", workspaceId, taskId: "endpoint-board", endpointId: "pi-session-1",
    expectedRevision: 3, operationId: "endpoint-detach-pi",
  }, pi);
  assert.deepEqual(taskOf(detached)?.endpointBindings?.map((binding) => binding.endpointId), ["web-session-1"]);
  assert.equal(taskOf(detached)?.claim, undefined);
});

test("Board service exposes update, renewable release, explicit Session binding, and fenced takeover", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-board-actions-"));
  const config = createTestGatewayConfig(root, { mode: "bearer", token: "secret" });
  const runtime = await GatewayRuntime.create({ config, cwd: root });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });

  const workspaceId = workspaceIdForPath(root);
  const pi = createGatewayPrincipal("stdio", "dispatcher", { authenticated: true, workspaceId });
  const web = createGatewayPrincipal("http", "web", { authenticated: true, workspaceId });
  const admin = createGatewayPrincipal("http", "admin", { authenticated: true, workspaceId, scopes: ["board.admin"] });
  assert.equal((await runtime.call("session", {
    action: "create", sessionId: "binding-session", workspaceId, ownerId: "web-member",
    expectedSessionRevision: 0, operationId: "binding-session-create", leaseTtlMs: 60_000,
  }, web)).ok, true);

  assert.equal((await runtime.call("board", {
    action: "create", workspaceId, taskId: "board-actions", title: "Initial",
    expectedRevision: 0, operationId: "actions-create",
  }, pi)).ok, true);
  const updated = await runtime.call("board", {
    action: "update", workspaceId, taskId: "board-actions", title: "Refined", description: "Ready to claim",
    expectedRevision: 1, operationId: "actions-update",
  }, pi);
  assert.equal(taskOf(updated)?.revision, 2);

  const firstClaim = await runtime.call("board", {
    action: "claim", workspaceId, taskId: "board-actions", leaseTtlMs: 60_000,
    expectedRevision: 2, operationId: "actions-claim-1",
  }, web);
  assert.equal(taskOf(firstClaim)?.claim?.generation, 1);
  const renewed = await runtime.call("board", {
    action: "renew", workspaceId, taskId: "board-actions", claimGeneration: 1, leaseTtlMs: 60_000,
    expectedRevision: 3, operationId: "actions-renew",
  }, web);
  assert.equal(taskOf(renewed)?.revision, 4);
  const released = await runtime.call("board", {
    action: "release", workspaceId, taskId: "board-actions", claimGeneration: 1,
    expectedRevision: 4, operationId: "actions-release",
  }, web);
  assert.equal(taskOf(released)?.claim, undefined);

  const secondClaim = await runtime.call("board", {
    action: "claim", workspaceId, taskId: "board-actions", leaseTtlMs: 100,
    expectedRevision: 5, operationId: "actions-claim-2",
  }, web);
  assert.equal(taskOf(secondClaim)?.claim?.generation, 2, "release must retain the monotonic ownership fence");
  const bound = await runtime.call("board", {
    action: "bind-session", workspaceId, taskId: "board-actions", sessionId: "binding-session", memberId: "web-member",
    claimGeneration: 2, expectedRevision: 6, operationId: "actions-bind",
  }, web);
  assert.equal(taskOf(bound)?.sessionBinding?.sessionId, "binding-session");

  await new Promise((resolve) => setTimeout(resolve, 110));
  const taken = await runtime.call("board", {
    action: "takeover", workspaceId, taskId: "board-actions", leaseTtlMs: 60_000, reason: "recover expired work",
    expectedRevision: 7, operationId: "actions-takeover",
  }, admin);
  assert.equal(taskOf(taken)?.claim?.generation, 3);
  assert.equal((await runtime.call("board", {
    action: "renew", workspaceId, taskId: "board-actions", claimGeneration: 3,
    expectedRevision: 8, operationId: "former-owner-renew",
  }, web)).error?.code, "not_found");
});
