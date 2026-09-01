import { createHash } from "node:crypto";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { getWorkspaceProjectionProvider, registerWorkspaceProjectionProvider } from "../src/public/v1/workspace-projections.ts";
import {
  createLocalWorkspacePeerDiscoveryProvider,
  projectTeammateSessionEndpoints,
  sameMonitorRootSessionClaim,
  selectMonitorVisibleRootEndpoints,
} from "../src/extension/session-endpoints.ts";
import {
  buildWorkspaceOwnerSnapshot,
  type WorkspacePeerIdentity,
} from "../src/extension/workspace-peers.ts";
import type { TeammateState } from "../src/shared/types.ts";
import {
  projectSessionEndpoints,
  type SessionEndpoint,
  type SessionOwnerProjection,
} from "../src/sessions/session-core.ts";

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
  assert.deepEqual(remote.capabilities, ["flow-schedule-todo-binding", "flow-schedule-todo-projection"]);

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

test("local settled projection excludes prior sessions and carries current source generation", () => {
  const state = {
    activeRuns: new Map(),
    currentWorkspaceId: "workspace-current",
    currentSessionId: "session-current",
    currentSourceId: "source-current",
    sessionGeneration: 4,
    recentlySettled: new Map([
      ["stale", {
        correlationId: "stale",
        agent: "general",
        status: "completed",
        settledAt: 1,
        workspaceId: "workspace-old",
        sessionId: "session-old",
        sourceId: "source-old",
        sessionGeneration: 3,
      }],
      ["current", {
        correlationId: "current",
        agent: "general",
        status: "completed",
        settledAt: 2,
        workspaceId: "workspace-current",
        sessionId: "session-current",
        sourceId: "source-current",
        sessionGeneration: 4,
      }],
    ]),
  } as unknown as TeammateState;
  const endpoints = projectTeammateSessionEndpoints(
    state,
    { workspaceId: "workspace-current", ownerId: "a".repeat(32), ownerNonce: "b".repeat(32) },
    [],
  );
  assert.deepEqual(
    endpoints.filter((endpoint) => endpoint.kind === "agent").map((endpoint) => endpoint.correlationId),
    ["current"],
  );
  const current = endpoints.find((endpoint) => endpoint.correlationId === "current");
  assert.equal(current?.sessionId, "session-current");
  assert.equal(current?.sourceId, "source-current");
  assert.equal(current?.generation, 4);
});

test("workspace aggregation is advertised only for explicit Monitor projection", () => {
  const state = {
    activeRuns: new Map(),
    currentWorkspaceId: "workspace-current",
    currentSessionId: "session-current",
    currentSourceId: "source-current",
    sessionGeneration: 4,
  } as unknown as TeammateState;
  const identity = { workspaceId: "workspace-current", ownerId: "a".repeat(32), ownerNonce: "b".repeat(32) };
  const local = projectTeammateSessionEndpoints(state, identity, [], undefined, false);
  const monitor = projectTeammateSessionEndpoints(state, identity, [], undefined, true);
  assert.equal(local[0]?.capabilities.includes("monitor-workspace-aggregation"), false);
  assert.equal(monitor[0]?.capabilities.includes("monitor-workspace-aggregation"), true);
});

test("Monitor visibility includes exact self and same-workspace roots without changing capabilities", () => {
  const normalizedCwd = "D:/peer";
  const workspaceId = createHash("sha256").update(normalizedCwd, "utf8").digest("hex");
  const identity = { workspaceId, ownerId: "a".repeat(32), ownerNonce: "b".repeat(32) };
  const state = {
    activeRuns: new Map(),
    currentWorkspaceId: workspaceId,
    currentSessionId: "session-current",
    currentSourceId: "source-current",
    sessionGeneration: 4,
  } as unknown as TeammateState;
  const peerIdentity: WorkspacePeerIdentity = {
    version: 1,
    normalizedCwd,
    workspaceId,
    ownerId: "c".repeat(32),
    ownerNonce: "d".repeat(32),
    paths: {
      rootDir: "D:/peer-root",
      ownersDir: "D:/peer-root/owners",
      commandsDir: "D:/peer-root/commands",
      responsesDir: "D:/peer-root/responses",
      identitiesDir: "D:/peer-root/identities",
    },
  };
  const selfOwner = buildWorkspaceOwnerSnapshot({
    ...peerIdentity,
    ownerId: identity.ownerId,
    ownerNonce: identity.ownerNonce,
  }, {
    agents: [],
    settled: [],
    sessionId: "session-current",
    sessionName: "self",
  }, 100);
  const peer = buildWorkspaceOwnerSnapshot(peerIdentity, {
    agents: [],
    settled: [],
    sessionId: "session-peer",
    sessionName: "peer",
  }, 100);
  const projected = projectTeammateSessionEndpoints(state, identity, [peer], "self", true);
  const self = projected.find((endpoint) => endpoint.kind === "root" && endpoint.scope === "local")!;
  const sameWorkspacePeer = projected.find((endpoint) => endpoint.kind === "root" && endpoint.scope === "workspace-peer")!;
  const foreignPeer = {
    ...sameWorkspacePeer,
    id: `${sameWorkspacePeer.id}-foreign`,
    workspaceId: "f".repeat(64),
  } satisfies SessionEndpoint;
  const replacedSelf = {
    ...self,
    id: `${self.id}-replacement`,
    ownerNonce: "9".repeat(32),
  } satisfies SessionEndpoint;

  const visible = selectMonitorVisibleRootEndpoints(
    [...projected, foreignPeer, replacedSelf],
    identity,
    [selfOwner, peer],
  );
  assert.deepEqual(visible.map((endpoint) => endpoint.id), [self.id, sameWorkspacePeer.id]);
  assert.deepEqual(
    selectMonitorVisibleRootEndpoints(projected, identity, [peer]).map((endpoint) => endpoint.id),
    [sameWorkspacePeer.id],
    "a directory-only self endpoint is not observable without its validated owner snapshot",
  );
  assert.equal(visible[0], self, "selection must not rewrite capabilities or route authority");
  assert.deepEqual(visible[0]?.capabilities, self.capabilities);
  assert.equal(visible[0]?.sessionId, "session-current");
  assert.equal(visible[0]?.sessionName, "self");
  assert.equal(visible[1]?.sessionId, "session-peer");

  const rotatedPeer = {
    ...sameWorkspacePeer,
    sessionId: "session-peer-rotated",
    sourceId: "session-peer-rotated",
    generation: 2,
  } satisfies SessionEndpoint;
  const rotatedOwner = {
    ...peer,
    sessionId: "session-peer-rotated",
    ownerGeneration: 2,
  };
  const finalVisible = selectMonitorVisibleRootEndpoints([rotatedPeer], identity, [rotatedOwner]);
  assert.deepEqual(finalVisible.map((endpoint) => endpoint.id), [sameWorkspacePeer.id]);
  assert.equal(
    sameMonitorRootSessionClaim(sameWorkspacePeer, finalVisible[0]!),
    false,
    "same owner identity and endpoint id cannot hide a rotated session/source/generation claim",
  );
});

test("local workspace discovery provider exposes authority and revalidates owner capture after await", async () => {
  const state = {
    activeRuns: new Map(),
    currentWorkspaceId: "workspace-current",
    currentSessionId: "session-current",
    currentSourceId: "source-current",
    sessionGeneration: 4,
  } as unknown as TeammateState;
  const identity: WorkspacePeerIdentity = {
    version: 1,
    normalizedCwd: "D:/worker",
    workspaceId: "e".repeat(64),
    ownerId: "a".repeat(32),
    ownerNonce: "b".repeat(32),
    paths: {
      rootDir: "D:/peer",
      ownersDir: "D:/peer/owners",
      commandsDir: "D:/peer/commands",
      responsesDir: "D:/peer/responses",
      identitiesDir: "D:/peer/identities",
    },
  };
  const provider = createLocalWorkspacePeerDiscoveryProvider({
    state,
    identity,
    cleanupStale: false,
    discover: async () => ({ peers: [], staleOwnerIds: [], corruptFiles: [] }),
  });
  assert.deepEqual(provider.authority, {
    kind: "local",
    authorityId: identity.workspaceId,
    instanceNonce: identity.ownerNonce,
  });
  const endpoints = await provider.refresh();
  assert.equal(endpoints.length, 1);
  assert.equal(endpoints[0]?.ownerId, identity.ownerId);
  await provider.close();
  assert.deepEqual(await provider.refresh(), []);

  let releaseDiscovery!: () => void;
  const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
  const changing = createLocalWorkspacePeerDiscoveryProvider({
    state,
    identity,
    discover: async () => {
      await discoveryGate;
      return { peers: [], staleOwnerIds: [], corruptFiles: [] };
    },
  });
  const refresh = changing.refresh();
  identity.ownerNonce = "c".repeat(32);
  releaseDiscovery();
  await assert.rejects(refresh, /owner changed while discovery was in flight/);
  await changing.close();
});
