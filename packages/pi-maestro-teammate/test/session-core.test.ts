import assert from "node:assert/strict";
import test from "node:test";
import {
  EndpointDirectory,
  MessageRouter,
  SESSION_HOST_REGISTRY_KEY,
  SessionHostRegistry,
  WindowThreadStore,
  createChildIpcTransportAdapter,
  createLocalAgentMailboxTransportAdapter,
  createLocalRootTransportAdapter,
  createWorkspacePeerV1TransportAdapter,
  getSessionHostRegistry,
  parseSessionSurfaceMode,
  projectSessionEndpoints,
  publishSessionHostRegistry,
  sessionAgentEndpointId,
  sessionRootEndpointId,
  normalizeSessionMessageKind,
  sessionMessageTriggersTurn,
  sessionSurfaceModeFromEnv,
  type LegacySessionAuthority,
  type SessionEndpoint,
  type SessionMessageRequest,
  type SessionOwnerProjection,
  type SessionTransportAdapter,
  type WindowThreadEntryInput,
} from "../src/sessions/session-core.ts";

const LOCAL_OWNER = "a".repeat(32);
const LOCAL_NONCE = "1".repeat(32);
const REMOTE_OWNER = "b".repeat(32);
const REMOTE_NONCE = "2".repeat(32);
const WORKSPACE_ID = "c".repeat(64);

function owners(): SessionOwnerProjection[] {
  return [
    {
      workspaceId: WORKSPACE_ID,
      ownerId: LOCAL_OWNER,
      ownerNonce: LOCAL_NONCE,
      scope: "local",
      status: "running",
      sessionId: "local-session",
      sessionName: "current-window",
      agents: [
        {
          workspaceId: WORKSPACE_ID,
          ownerId: LOCAL_OWNER,
          ownerNonce: LOCAL_NONCE,
          correlationId: "local-correlation",
          status: "sleeping",
          name: "reviewer",
          agent: "general",
          phase: "waiting",
          wakeable: true,
        },
      ],
    },
    {
      workspaceId: WORKSPACE_ID,
      ownerId: REMOTE_OWNER,
      ownerNonce: REMOTE_NONCE,
      scope: "workspace-peer",
      status: "running",
      sessionId: "remote-session",
      sessionName: "review-window",
      agents: [
        {
          workspaceId: WORKSPACE_ID,
          ownerId: REMOTE_OWNER,
          ownerNonce: REMOTE_NONCE,
          correlationId: "remote-correlation",
          status: "running",
          name: "reviewer",
          agent: "analyst",
        },
      ],
    },
  ];
}

function endpointBy(
  endpoints: readonly SessionEndpoint[],
  predicate: (endpoint: SessionEndpoint) => boolean,
): SessionEndpoint {
  const endpoint = endpoints.find(predicate);
  assert.ok(endpoint);
  return endpoint;
}

function request(overrides: Partial<SessionMessageRequest> = {}): SessionMessageRequest {
  return { selector: "local-correlation", message: "inspect", mode: "follow_up", ...overrides };
}

test("session surface parsing is fail-closed to legacy", () => {
  assert.equal(parseSessionSurfaceMode("legacy"), "legacy");
  assert.equal(parseSessionSurfaceMode("shadow"), "shadow");
  assert.equal(parseSessionSurfaceMode("unified"), "unified");
  assert.equal(parseSessionSurfaceMode("SHADOW"), "legacy");
  assert.equal(sessionSurfaceModeFromEnv({ PI_TEAMMATE_SESSION_SURFACE: " Unified " }), "unified");
  assert.equal(sessionSurfaceModeFromEnv({ PI_TEAMMATE_SESSION_SURFACE: "invalid" }), "legacy");
});

test("status messages require a trusted host source to stay context-only", () => {
  assert.equal(normalizeSessionMessageKind("status"), "coordination");
  assert.equal(normalizeSessionMessageKind("status", false), "coordination");
  assert.equal(normalizeSessionMessageKind("status", true), "status");
  assert.equal(normalizeSessionMessageKind("request"), "request");
  assert.equal(sessionMessageTriggersTurn(normalizeSessionMessageKind("status")), true);
  assert.equal(sessionMessageTriggersTurn(normalizeSessionMessageKind("status", true)), false);
});

test("status messages never trigger a model turn by themselves", () => {
  assert.equal(sessionMessageTriggersTurn("status"), false);
  assert.equal(sessionMessageTriggersTurn("coordination"), true);
  assert.equal(sessionMessageTriggersTurn(undefined), true);
});

test("canonical endpoint ids carry the complete owner fence", () => {
  const identity = { workspaceId: "workspace / one", ownerId: LOCAL_OWNER, ownerNonce: LOCAL_NONCE };
  const rootId = sessionRootEndpointId(identity);
  const agentId = sessionAgentEndpointId({ ...identity, correlationId: "correlation / one" });
  assert.match(rootId, /workspace%20%2F%20one/);
  assert.match(rootId, new RegExp(`${LOCAL_OWNER}/${LOCAL_NONCE}/root$`));
  assert.match(agentId, new RegExp(`${LOCAL_OWNER}/${LOCAL_NONCE}/agent/correlation%20%2F%20one$`));
});

test("projection has deterministic ordinals and ignores heartbeat-only fields", () => {
  const firstOwners = owners();
  const projected = projectSessionEndpoints(firstOwners);
  const reordered = projectSessionEndpoints([...firstOwners].reverse());
  const heartbeatOnly = projectSessionEndpoints(firstOwners.map((owner, index) => ({
    ...owner,
    publishedAt: 1_000 + index,
  })) as unknown as SessionOwnerProjection[]);

  assert.deepEqual(projected.map((endpoint) => endpoint.id), reordered.map((endpoint) => endpoint.id));
  assert.deepEqual(projected.map((endpoint) => endpoint.ordinal), [0, 1, 2, 3]);
  assert.deepEqual(
    projected.map((endpoint) => [endpoint.id, endpoint.ordinal, endpoint.contentRevision]),
    heartbeatOnly.map((endpoint) => [endpoint.id, endpoint.ordinal, endpoint.contentRevision]),
  );
  assert.equal(endpointBy(projected, (endpoint) => endpoint.scope === "local" && endpoint.kind === "agent").transport, "local-agent-mailbox");
  assert.equal(endpointBy(projected, (endpoint) => endpoint.scope === "workspace-peer" && endpoint.kind === "agent").transport, "workspace-peer-v1");
});

test("semantic endpoint changes advance only the affected content revision", () => {
  const before = projectSessionEndpoints(owners());
  const originalOwners = owners();
  const changedOwners: SessionOwnerProjection[] = [
    {
      ...originalOwners[0]!,
      agents: originalOwners[0]!.agents.map((agent) => ({ ...agent, phase: "tool" })),
    },
    originalOwners[1]!,
  ];
  const after = projectSessionEndpoints(changedOwners);
  const changedId = sessionAgentEndpointId({
    workspaceId: WORKSPACE_ID,
    ownerId: LOCAL_OWNER,
    ownerNonce: LOCAL_NONCE,
    correlationId: "local-correlation",
  });
  for (const endpoint of before) {
    const next = endpointBy(after, (candidate) => candidate.id === endpoint.id);
    assert.equal(endpoint.contentRevision === next.contentRevision, endpoint.id !== changedId);
  }
});

test("directory resolves canonical ids, local names, owner selectors, and ambiguity", () => {
  const directory = new EndpointDirectory(projectSessionEndpoints(owners()));
  const local = directory.resolve("reviewer");
  assert.equal(local.code, "resolved");
  assert.equal(local.endpoint?.scope, "local");
  assert.equal(directory.resolve(`owner:${REMOTE_OWNER}`).endpoint?.kind, "root");
  assert.equal(directory.resolve(`owner:${REMOTE_OWNER}:remote-correlation`).endpoint?.correlationId, "remote-correlation");
  assert.equal(directory.resolve("review-window").endpoint?.ownerId, REMOTE_OWNER);
  assert.equal(directory.resolve("root").endpoint?.scope, "local");
  assert.equal(directory.resolve("@root").endpoint?.kind, "root");
  assert.equal(directory.resolve("remote-cor").endpoint?.correlationId, "remote-correlation");
  assert.equal(directory.resolve("reviewer", { localFirst: false }).code, "ambiguous");

  const rootNamedAgentOwners = owners();
  rootNamedAgentOwners[0] = {
    ...rootNamedAgentOwners[0]!,
    agents: rootNamedAgentOwners[0]!.agents.map((agent) => ({ ...agent, name: "root" })),
  };
  const reservedRootDirectory = new EndpointDirectory(projectSessionEndpoints(rootNamedAgentOwners));
  assert.equal(reservedRootDirectory.resolve("root").endpoint?.kind, "root");
  assert.equal(reservedRootDirectory.resolve("@root").endpoint?.kind, "root");
  assert.equal(reservedRootDirectory.resolve("root#local").endpoint?.kind, "agent");

  const collisionOwners = owners();
  const collisionDirectory = new EndpointDirectory(projectSessionEndpoints([
    {
      ...collisionOwners[0]!,
      agents: collisionOwners[0]!.agents.map((agent) => ({ ...agent, name: `owner:${REMOTE_OWNER}` })),
    },
    collisionOwners[1]!,
  ]));
  assert.equal(collisionDirectory.resolve(`owner:${REMOTE_OWNER}`).endpoint?.scope, "local");
  assert.equal(collisionDirectory.resolve(`owner:${REMOTE_OWNER}`, { localFirst: false }).endpoint?.kind, "root");
});

test("shadow compares only and legacy remains the sole delivery authority", async () => {
  const endpoints = projectSessionEndpoints(owners());
  const directory = new EndpointDirectory(endpoints);
  const local = endpointBy(endpoints, (endpoint) => endpoint.correlationId === "local-correlation");
  let legacyDeliveries = 0;
  let unifiedDeliveries = 0;
  const comparisons: boolean[] = [];
  const legacy: LegacySessionAuthority = {
    resolve: (input) => directory.resolve(input.selector),
    classify: () => ({ transport: "local-agent-mailbox", routable: true }),
    deliver: async () => {
      legacyDeliveries++;
      return { delivered: true, endpointId: local.id, transport: "local-agent-mailbox" };
    },
  };
  const adapter = createLocalAgentMailboxTransportAdapter(async (endpoint) => {
    unifiedDeliveries++;
    return { delivered: true, endpointId: endpoint.id, transport: "local-agent-mailbox" };
  });
  const router = new MessageRouter({
    directory,
    surface: "shadow",
    legacy,
    adapters: [adapter],
    onShadowComparison: (comparison) => comparisons.push(comparison.matches),
  });

  assert.deepEqual(await router.route(request()), {
    delivered: true,
    endpointId: local.id,
    transport: "local-agent-mailbox",
  });
  assert.equal(legacyDeliveries, 1);
  assert.equal(unifiedDeliveries, 0, "shadow classification must never invoke adapter delivery");
  assert.deepEqual(comparisons, [true]);

  router.setSurface("unified");
  assert.equal((await router.route(request())).delivered, true);
  assert.equal(legacyDeliveries, 1);
  assert.equal(unifiedDeliveries, 1);
});

test("all physical adapters classify their canonical transport, including child IPC", async () => {
  const deliveries: string[] = [];
  const adapters: SessionTransportAdapter[] = [
    createLocalRootTransportAdapter(async (endpoint) => ({ delivered: true, endpointId: endpoint.id, transport: "local-root" })),
    createLocalAgentMailboxTransportAdapter(async (endpoint) => ({ delivered: true, endpointId: endpoint.id, transport: "local-agent-mailbox" })),
    createWorkspacePeerV1TransportAdapter(async (endpoint) => ({ delivered: true, endpointId: endpoint.id, transport: "workspace-peer-v1" })),
    createChildIpcTransportAdapter(async (endpoint) => {
      deliveries.push(endpoint.id);
      return { delivered: true, endpointId: endpoint.id, transport: "child-ipc" };
    }),
  ];
  const childEndpoint = projectSessionEndpoints([{ ...owners()[0]!, transport: "child-ipc" }])[0]!;
  const child = adapters[3]!;
  assert.deepEqual(child.classify(childEndpoint, request({ selector: childEndpoint.id })), {
    transport: "child-ipc",
    routable: true,
  });
  await child.deliver(childEndpoint, request({ selector: childEndpoint.id }));
  assert.deepEqual(deliveries, [childEndpoint.id]);
});

test("session host registry publishes through the versioned global symbol", () => {
  const host = {} as typeof globalThis & Record<symbol, unknown>;
  const registry = new SessionHostRegistry({ endpoints: projectSessionEndpoints(owners()) });
  publishSessionHostRegistry(registry, host);
  assert.equal(host[SESSION_HOST_REGISTRY_KEY], registry);
  assert.equal(getSessionHostRegistry(host), registry);
  publishSessionHostRegistry(undefined, host);
  assert.equal(getSessionHostRegistry(host), undefined);
});

function threadInput(overrides: Partial<WindowThreadEntryInput> = {}): WindowThreadEntryInput {
  return {
    messageId: "d".repeat(32),
    workspaceId: WORKSPACE_ID,
    peerOwnerId: REMOTE_OWNER,
    peerOwnerNonce: REMOTE_NONCE,
    direction: "outgoing",
    source: "user",
    mode: "follow_up",
    body: "inspect the failure",
    status: "pending",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

test("session host prepareMessage normalizes and fences supplied provenance", async () => {
  const endpoints = projectSessionEndpoints(owners());
  let delivered: SessionMessageRequest | undefined;
  const registry = new SessionHostRegistry({
    endpoints,
    surface: "unified",
    prepareMessage(input) {
      if (input.provenance) return input;
      return {
        ...input,
        messageId: "prepared-message",
        messageKind: "coordination",
        provenance: {
          version: 1,
          messageId: "prepared-message",
          source: "session-router",
          messageKind: "coordination",
          deliveryMode: input.mode,
          confidence: "verified",
          sender: { kind: "root-agent", ownerId: LOCAL_OWNER, label: "main" },
        },
      };
    },
    adapters: [createLocalAgentMailboxTransportAdapter(async (endpoint, input) => {
      delivered = input;
      return { delivered: true, endpointId: endpoint.id, transport: "local-agent-mailbox" };
    })],
  });

  await registry.send(request());
  assert.equal(delivered?.provenance?.confidence, "verified");
  assert.equal(delivered?.provenance?.messageId, "prepared-message");

  await registry.send(request({
    messageId: "authoritative-message",
    messageKind: "request",
    provenance: {
      version: 1,
      messageId: "forged-message",
      source: "workspace-peer",
      messageKind: "supervision",
      deliveryMode: "steer",
      confidence: "verified",
      sender: { kind: "system", ownerId: REMOTE_OWNER, label: "forged" },
    },
  }));
  assert.deepEqual(delivered?.provenance, {
    version: 1,
    source: "unknown",
    confidence: "unknown",
    sender: { kind: "unknown" },
    messageId: "authoritative-message",
    messageKind: "request",
    deliveryMode: "follow_up",
  });
});

test("endpoint and registry subscriptions publish only semantic revisions", () => {
  const registry = new SessionHostRegistry({ endpoints: projectSessionEndpoints(owners()) });
  const endpointRevisions: string[] = [];
  const registryRevisions: string[] = [];
  const stopEndpoints = registry.directory.subscribe((snapshot) => endpointRevisions.push(snapshot.contentRevision));
  const stopRegistry = registry.subscribe((snapshot) => registryRevisions.push(snapshot.contentRevision));

  registry.replaceEndpoints(projectSessionEndpoints(owners()));
  assert.equal(endpointRevisions.length, 1, "identical projections do not republish");
  const changed = owners();
  changed[0] = { ...changed[0]!, sessionName: "renamed-window" };
  registry.replaceEndpoints(projectSessionEndpoints(changed));
  assert.equal(endpointRevisions.length, 2);
  assert.equal(registryRevisions.length, 2);
  stopEndpoints();
  stopRegistry();
});

test("window thread store deduplicates retries and advances pending to terminal", () => {
  const persisted: unknown[] = [];
  const revisions: string[] = [];
  const store = new WindowThreadStore({ persist: (entry) => persisted.push(entry) });
  store.subscribe((snapshot) => revisions.push(snapshot.contentRevision));

  const pending = store.record(threadInput());
  assert.equal(pending.revision, 1);
  assert.equal(store.record(threadInput()), pending, "same command retry is a logical no-op");
  const accepted = store.record(threadInput({ status: "accepted", updatedAt: 1_100 }));
  assert.equal(accepted.revision, 2);
  assert.equal(store.record(threadInput({ status: "rejected", updatedAt: 1_200 })), accepted, "terminal status is immutable");
  assert.equal(persisted.length, 2);
  assert.equal(revisions.length, 3, "initial snapshot plus two mutations");
});

test("window thread transitions pending to queued to injected without losing replay metadata", () => {
  const persisted: unknown[] = [];
  const store = new WindowThreadStore({ persist: (entry) => persisted.push(entry) });
  const messageId = "8".repeat(32);
  store.record(threadInput({
    messageId,
    direction: "incoming",
    source: "monitor",
    messageKind: "supervision",
    traceId: "mon_trace-8",
    replyTo: `owner:${LOCAL_OWNER}`,
    fromSessionName: "control",
    targetSessionId: "session-a",
    targetCorrelationId: "window-main-session",
  }));
  const queued = store.transition(messageId, "incoming", "queued", 1_100, "follow_up");
  assert.equal(queued?.status, "queued");
  assert.equal(queued?.traceId, "mon_trace-8");
  assert.equal(queued?.targetSessionId, "session-a");
  assert.equal(store.transition(messageId, "incoming", "pending", 1_150), queued, "queued does not regress to pending");
  const injected = store.reconcileInjected(messageId, 1_200, "follow_up");
  assert.equal(injected?.status, "injected");
  assert.equal(injected?.revision, 3);
  assert.equal(persisted.length, 2, "injection reconciliation does not persist a crash-inverted thread receipt");
  assert.equal(store.transition(messageId, "incoming", "rejected", 1_300), injected, "injected is terminal");
});

test("window thread ownership changes advance the semantic revision", () => {
  const persisted: unknown[] = [];
  const store = new WindowThreadStore({ persist: (entry) => persisted.push(entry) });
  const first = store.record(threadInput({
    direction: "incoming",
    targetSessionId: "session-a",
  }));
  const second = store.record(threadInput({
    direction: "incoming",
    targetSessionId: "session-b",
  }));

  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.equal(second.targetSessionId, "session-b");
  assert.equal(persisted.length, 2);
});

test("window thread persistence failure leaves the published record transition unchanged", () => {
  let rejectPersistence = false;
  let store!: WindowThreadStore;
  const ordering: string[] = [];
  store = new WindowThreadStore({
    persist() {
      ordering.push(`persist:${store.list().length}`);
      if (rejectPersistence) throw new Error("journal unavailable");
    },
  });
  store.subscribe((snapshot) => ordering.push(`publish:${snapshot.entries.length}`), { emitCurrent: false });

  store.record(threadInput());
  assert.deepEqual(ordering, ["persist:0", "publish:1"], "durability precedes in-memory publication");
  rejectPersistence = true;
  assert.throws(
    () => store.transition("d".repeat(32), "outgoing", "queued", 1_100, "follow_up"),
    /journal unavailable/,
  );
  assert.equal(store.get("d".repeat(32), "outgoing")?.status, "pending");
  assert.equal(store.get("d".repeat(32), "outgoing")?.revision, 1);
  assert.deepEqual(ordering, ["persist:0", "publish:1", "persist:1"]);
});

test("window thread rebuild deduplicates persisted teammate messages against queued incoming entries", () => {
  const messageId = "9".repeat(32);
  const journal: unknown[] = [];
  const source = new WindowThreadStore({
    persist: (entry) => journal.push({ type: "custom", customType: "teammate-window-thread", data: entry }),
  });
  source.record(threadInput({
    messageId,
    direction: "incoming",
    targetCorrelationId: "window-main-session",
  }));
  source.transition(messageId, "incoming", "queued", 1_100, "steer");
  journal.push({
    type: "custom_message",
    customType: "teammate-message",
    details: { messageId, mode: "steer" },
  });

  const rebuilt = new WindowThreadStore();
  rebuilt.rebuild(journal);
  assert.equal(rebuilt.get(messageId, "incoming")?.status, "injected");
  assert.equal(rebuilt.get(messageId, "incoming")?.effectiveMode, "steer");
  assert.equal(
    rebuilt.list().filter((entry) => entry.direction === "incoming" && (entry.status === "pending" || entry.status === "queued")).length,
    0,
    "a durable model-visible message is not eligible for replay",
  );
});

test("window thread rebuild deduplicates revisions and enforces its bound", () => {
  const journal: Array<{ type: "custom"; customType: string; data: unknown }> = [];
  const source = new WindowThreadStore({ persist: (entry) => journal.push({ type: "custom", customType: "teammate-window-thread", data: entry }) });
  const first = source.record(threadInput({ messageId: "1".repeat(32) }));
  source.record(threadInput({ messageId: "1".repeat(32), status: "timeout", updatedAt: 1_200 }));
  source.record(threadInput({ messageId: "2".repeat(32), createdAt: 2_000, updatedAt: 2_000 }));
  source.record(threadInput({ messageId: "3".repeat(32), direction: "incoming", createdAt: 3_000, updatedAt: 3_000 }));
  journal.push({ type: "custom", customType: "teammate-window-thread", data: first });
  journal.push({ type: "custom", customType: "unrelated", data: first });

  const resumed = new WindowThreadStore({ limit: 2 });
  resumed.rebuild(journal);
  assert.deepEqual(resumed.list().map((entry) => entry.messageId), ["2".repeat(32), "3".repeat(32)]);
  assert.equal(resumed.get("1".repeat(32)), undefined);
  assert.equal(resumed.list()[1]?.direction, "incoming");
});

test("sender records outgoing timeout and rejection terminal states", () => {
  const store = new WindowThreadStore();
  for (const [index, status] of (["timeout", "rejected"] as const).entries()) {
    const messageId = String(index + 4).repeat(32);
    const pending = threadInput({ messageId, createdAt: 4_000 + index, updatedAt: 4_000 + index });
    store.record(pending);
    store.record({ ...pending, status, updatedAt: 4_100 + index });
  }
  assert.deepEqual(store.list().map((entry) => [entry.direction, entry.status, entry.revision]), [
    ["outgoing", "timeout", 2],
    ["outgoing", "rejected", 2],
  ]);
});

test("receiver records one incoming command and fences duplicate delivery", () => {
  const persisted: unknown[] = [];
  const store = new WindowThreadStore({ persist: (entry) => persisted.push(entry) });
  let deliveries = 0;
  const consume = (messageId: string): void => {
    if (store.get(messageId, "incoming")) return;
    const incoming = threadInput({
      messageId,
      direction: "incoming",
      source: "system",
      createdAt: 5_000,
      updatedAt: 5_000,
    });
    store.record(incoming);
    deliveries++;
    store.record({ ...incoming, status: "accepted", updatedAt: 5_100 });
  };

  consume("6".repeat(32));
  consume("6".repeat(32));
  assert.equal(deliveries, 1);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0]?.direction, "incoming");
  assert.equal(store.list()[0]?.status, "accepted");
  assert.equal(persisted.length, 2, "pending and terminal revisions persist once each");
});
