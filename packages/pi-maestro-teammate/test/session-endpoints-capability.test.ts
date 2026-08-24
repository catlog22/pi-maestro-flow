import { createHash } from "node:crypto";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { getWorkspaceProjectionProvider, registerWorkspaceProjectionProvider } from "../src/public/v1/workspace-projections.ts";
import { projectTeammateSessionEndpoints } from "../src/extension/session-endpoints.ts";
import {
  buildWorkspaceOwnerSnapshot,
  type WorkspacePeerIdentity,
} from "../src/extension/workspace-peers.ts";
import type { TeammateState } from "../src/shared/types.ts";
import { projectSessionEndpoints, type SessionOwnerProjection } from "../src/sessions/session-core.ts";

const disposers: Array<() => void> = [];
function cleanup(): void {
  for (const dispose of disposers) dispose();
  disposers.length = 0;
}
afterEach(cleanup);

function localOwner(extraCapabilities?: string[]): SessionOwnerProjection {
  return {
    workspaceId: "ws",
    ownerId: "a".repeat(32),
    ownerNonce: "b".repeat(32),
    scope: "local",
    status: "running",
    ...(extraCapabilities ? { extraCapabilities: extraCapabilities as SessionOwnerProjection["extraCapabilities"] } : {}),
    agents: [],
  };
}

test("root endpoint advertises flow-schedule-todo-binding only when a todo projection provider is registered", () => {
  // Without a registered provider: no extra capability.
  const without = projectSessionEndpoints([localOwner()]);
  const rootWithout = without.find((e) => e.kind === "root")!;
  assert.ok(!rootWithout.capabilities.includes("flow-schedule-todo-binding"));

  // Register a 'todo' provider -> capability appears.
  const reg = registerWorkspaceProjectionProvider({
    kind: "todo",
    snapshot: () => [{ kind: "todo", data: { id: "t1" } }],
  });
  disposers.push(reg.dispose);
  assert.ok(getWorkspaceProjectionProvider("todo") !== undefined);

  // Simulate session-endpoints.ts logic: set extraCapabilities when provider registered.
  const withProvider = projectSessionEndpoints([
    localOwner(getWorkspaceProjectionProvider("todo") !== undefined ? ["flow-schedule-todo-binding"] : []),
  ]);
  const rootWith = withProvider.find((e) => e.kind === "root")!;
  assert.ok(rootWith.capabilities.includes("flow-schedule-todo-binding"));
  // Base capabilities still present.
  assert.ok(rootWith.capabilities.includes("message"));
  assert.ok(rootWith.capabilities.includes("follow_up"));
  assert.ok(rootWith.capabilities.includes("inspect"));

  // After dispose: back to no extra capability.
  reg.dispose();
  const afterDispose = projectSessionEndpoints([
    localOwner(getWorkspaceProjectionProvider("todo") !== undefined ? ["flow-schedule-todo-binding"] : []),
  ]);
  const rootAfter = afterDispose.find((e) => e.kind === "root")!;
  assert.ok(!rootAfter.capabilities.includes("flow-schedule-todo-binding"));
});

test("worker owner snapshot propagates Todo-binding capability to the Monitor peer endpoint", () => {
  const registration = registerWorkspaceProjectionProvider({
    kind: "todo",
    snapshot: () => [{
      kind: "todo",
      data: { id: "todo-1", subject: "Verify", status: "in_progress", updatedAt: 100 },
    }],
  });
  disposers.push(registration.dispose);
  const normalizedCwd = "D:/worker";
  const workerIdentity = {
    version: 1,
    normalizedCwd,
    workspaceId: createHash("sha256").update(normalizedCwd, "utf8").digest("hex"),
    ownerId: "c".repeat(32),
    ownerNonce: "d".repeat(32),
    paths: {
      rootDir: "D:/peer",
      ownersDir: "D:/peer/owners",
      commandsDir: "D:/peer/commands",
      responsesDir: "D:/peer/responses",
      identitiesDir: "D:/peer/identities",
    },
  } satisfies WorkspacePeerIdentity;
  const remote = buildWorkspaceOwnerSnapshot(workerIdentity, {
    agents: [],
    settled: [],
    sessionId: "worker-session",
  }, 100);
  assert.deepEqual(remote.capabilities, ["flow-schedule-todo-binding"]);

  registration.dispose();
  const endpoints = projectTeammateSessionEndpoints(
    { activeRuns: new Map(), currentSessionId: "monitor-session" } as TeammateState,
    { workspaceId: "local-workspace", ownerId: "a".repeat(32), ownerNonce: "b".repeat(32) },
    [remote],
  );
  const workerRoot = endpoints.find((endpoint) => endpoint.kind === "root" && endpoint.ownerId === workerIdentity.ownerId);
  assert.ok(workerRoot?.capabilities.includes("flow-schedule-todo-binding"));
  const monitorRoot = endpoints.find((endpoint) => endpoint.kind === "root" && endpoint.ownerId === "a".repeat(32));
  assert.equal(monitorRoot?.capabilities.includes("flow-schedule-todo-binding"), false);
});

test("extraCapabilities merge without duplicating base capabilities", () => {
  const projected = projectSessionEndpoints([localOwner(["flow-schedule-todo-binding"])]);
  const root = projected.find((e) => e.kind === "root")!;
  // No duplicates.
  assert.equal(new Set(root.capabilities).size, root.capabilities.length);
  assert.equal(root.capabilities.filter((c) => c === "flow-schedule-todo-binding").length, 1);
});

test("root endpoint without extraCapabilities has only the base 4 capabilities", () => {
  const projected = projectSessionEndpoints([localOwner()]);
  const root = projected.find((e) => e.kind === "root")!;
  assert.deepEqual([...root.capabilities].sort(), ["follow_up", "inspect", "message", "steer"]);
});
