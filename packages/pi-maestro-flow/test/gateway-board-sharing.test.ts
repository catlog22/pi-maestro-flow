import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayPrincipal, principalKey } from "../src/gateway/principal.ts";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { workspaceIdForPath } from "../src/gateway/state-paths.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";

test("Pi and Web endpoints share one workspace Board task and collaborative Session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-board-sharing-"));
  const runtime = await GatewayRuntime.create({ config: createTestGatewayConfig(root, { mode: "bearer", token: "secret" }), cwd: root });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  const workspaceId = workspaceIdForPath(root);
  const web = createGatewayPrincipal("http", "web", { authenticated: true, workspaceId });
  const pi = createGatewayPrincipal("stdio", "pi", { authenticated: true, workspaceId });
  assert.equal((await runtime.call("session", {
    action: "create", sessionId: "shared-session", workspaceId, ownerId: "web-member",
    expectedSessionRevision: 0, operationId: "session-create", leaseTtlMs: 60_000,
  }, web)).ok, true);
  assert.equal((await runtime.call("session", {
    action: "join", sessionId: "shared-session", memberId: "web-member",
    joiningMemberId: "pi-member", joiningPrincipalId: principalKey(pi), role: "agent", leaseTtlMs: 60_000,
    expectedSessionRevision: 1, operationId: "session-join-pi",
  }, web)).ok, true);
  const visibleToPi = await runtime.call("session", {
    action: "get", sessionId: "shared-session", memberId: "pi-member",
  }, pi);
  const members = (visibleToPi.data as { state?: { members?: Array<{ id: string; principalId: string }> } })?.state?.members
    ?? (visibleToPi.data as { members?: Array<{ id: string; principalId: string }> })?.members
    ?? [];
  assert.deepEqual(members.map((member) => member.id).sort(), ["pi-member", "web-member"]);

  assert.equal((await runtime.call("board", {
    action: "create", workspaceId, taskId: "shared-board", title: "Coordinate Pi and Web",
    expectedRevision: 0, operationId: "board-create",
  }, web)).ok, true);
  assert.equal((await runtime.call("board", {
    action: "attach-endpoint", workspaceId, taskId: "shared-board", endpointId: "web-window-1",
    expectedRevision: 1, operationId: "board-attach-web",
  }, web)).ok, true);
  const piAttached = await runtime.call("board", {
    action: "attach-endpoint", workspaceId, taskId: "shared-board", endpointId: "pi-session-1",
    expectedRevision: 2, operationId: "board-attach-pi",
  }, pi);
  const task = (piAttached.data as { task?: { claim?: unknown; endpointBindings?: Array<{ kind: string; endpointId: string }> } })?.task;
  assert.deepEqual(task?.endpointBindings?.map(({ kind, endpointId }) => ({ kind, endpointId })), [
    { kind: "web", endpointId: "web-window-1" },
    { kind: "pi", endpointId: "pi-session-1" },
  ]);
  assert.equal(task?.claim, undefined, "participation endpoints do not acquire execution ownership");

  const claimed = await runtime.call("board", {
    action: "claim", workspaceId, taskId: "shared-board", sessionId: "shared-session", memberId: "web-member",
    expectedRevision: 3, operationId: "board-claim", leaseTtlMs: 60_000,
  }, web);
  const claimedTask = (claimed.data as { task?: { claim?: { generation: number }; sessionBinding?: { sessionId: string }; endpointBindings?: unknown[] } })?.task;
  assert.equal(claimedTask?.claim?.generation, 1);
  assert.equal(claimedTask?.sessionBinding?.sessionId, "shared-session");
  assert.equal(claimedTask?.endpointBindings?.length, 2);
});
