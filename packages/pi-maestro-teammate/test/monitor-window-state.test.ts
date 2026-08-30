import assert from "node:assert/strict";
import test from "node:test";
import {
  MONITOR_WINDOW_STATE_VERSION,
  getMonitorWindowFacetProvider,
  readMonitorWindowFacets,
  registerMonitorWindowFacetProvider,
  type MonitorWorkRefV1,
  type MonitorWindowCompletionEvidenceV1,
  type MonitorWindowFacetTargetV1,
  type MonitorWindowIdentityV1,
} from "../src/public/v1/monitor-window-state.ts";
import {
  reduceMonitorWindowStateV1,
  type MonitorWindowThreadEvidenceV1,
} from "../src/extension/monitor-window-state.ts";
import {
  SESSION_ENDPOINT_VERSION,
  type SessionEndpoint,
  type WindowThreadEntry,
} from "../src/sessions/session-core.ts";
import {
  WORKSPACE_PEER_PROTOCOL_VERSION,
  type WorkspaceOwnerSnapshot,
} from "../src/sessions/workspace-peer-core.ts";

const WORKSPACE = "a".repeat(64);
const OWNER = "b".repeat(32);
const NONCE_A = "c".repeat(32);
const NONCE_B = "d".repeat(32);
const ENDPOINT_ID = "pi-session/v1/workspace/root";
const WORK: MonitorWorkRefV1 = { kind: "message", id: "e".repeat(32) };

function endpoint(ownerNonce = NONCE_A, overrides: Partial<SessionEndpoint> = {}): SessionEndpoint {
  return {
    version: SESSION_ENDPOINT_VERSION,
    id: ENDPOINT_ID,
    kind: "root",
    scope: "workspace-peer",
    transport: "workspace-peer-v1",
    status: "running",
    capabilities: ["inspect", "message"],
    ordinal: 0,
    contentRevision: "endpoint-revision-1",
    workspaceId: WORKSPACE,
    ownerId: OWNER,
    ownerNonce,
    sessionId: "session-a",
    sessionName: "worker-a",
    ...overrides,
  };
}

function identity(ownerNonce = NONCE_A): MonitorWindowIdentityV1 {
  return { workspaceId: WORKSPACE, ownerId: OWNER, ownerNonce, endpointId: ENDPOINT_ID };
}

function target(ownerNonce = NONCE_A, workRef = WORK): Required<MonitorWindowFacetTargetV1> {
  return { identity: identity(ownerNonce), workRef };
}

function owner(ownerNonce = NONCE_A, publishedAt = 1_000, overrides: Partial<WorkspaceOwnerSnapshot> = {}): WorkspaceOwnerSnapshot {
  return {
    version: WORKSPACE_PEER_PROTOCOL_VERSION,
    kind: "owner",
    workspaceId: WORKSPACE,
    normalizedCwd: "/workspace",
    ownerId: OWNER,
    ownerNonce,
    pid: 42,
    publishedAt,
    sessionId: "session-a",
    sessionName: "worker-a",
    agents: [],
    settled: [],
    ...overrides,
  };
}

function thread(
  status: WindowThreadEntry["status"],
  ownerNonce = NONCE_A,
  updatedAt = 2_000,
): WindowThreadEntry {
  return {
    version: SESSION_ENDPOINT_VERSION,
    messageId: WORK.id,
    workspaceId: WORKSPACE,
    peerOwnerId: OWNER,
    peerOwnerNonce: ownerNonce,
    direction: "outgoing",
    source: "monitor",
    messageKind: "coordination",
    mode: "follow_up",
    body: "work",
    status,
    createdAt: 1_500,
    updatedAt,
    revision: 1,
    contentRevision: `thread-${status}`,
  };
}

function deliveryEvidence(status: WindowThreadEntry["status"], ownerNonce = NONCE_A): MonitorWindowThreadEvidenceV1 {
  return { target: target(ownerNonce), entry: thread(status, ownerNonce) };
}

function completion(
  source: MonitorWindowCompletionEvidenceV1["source"],
  outcome: MonitorWindowCompletionEvidenceV1["outcome"],
  ownerNonce = NONCE_A,
  completedAt = 3_000,
): MonitorWindowCompletionEvidenceV1 {
  return {
    target: target(ownerNonce),
    source,
    outcome,
    revision: `${source}-${outcome}`,
    completedAt,
    summary: `${source} says ${outcome}`,
  };
}

test("reducer preserves exact endpoint identity and rejects rotated owner evidence and late results", () => {
  const state = reduceMonitorWindowStateV1({
    observedAt: 4_000,
    windows: [{
      endpoint: endpoint(NONCE_B),
      owner: owner(NONCE_A, 3_500, {
        todos: [{ id: "old", subject: "old owner todo", status: "completed", updatedAt: 3_000 }],
      }),
      managed: {
        target: { identity: identity(NONCE_A) },
        metadata: { name: "stale-name", sessionName: "stale-session", objective: "stale objective" },
      },
      workRef: WORK,
      delivery: [deliveryEvidence("replied", NONCE_A)],
      completion: [
        completion("canonical-completion", "completed", NONCE_A),
        {
          ...completion("canonical-completion", "completed", NONCE_B),
          target: target(NONCE_B, { kind: "message", id: "f".repeat(32) }),
        },
      ],
    }],
  });

  assert.equal(state.version, MONITOR_WINDOW_STATE_VERSION);
  assert.deepEqual(state.windows[0]?.identity, {
    workspaceId: WORKSPACE,
    ownerId: OWNER,
    ownerNonce: NONCE_B,
    endpointId: ENDPOINT_ID,
  });
  assert.equal(state.windows[0]?.work.completion.outcome, "unknown");
  assert.equal(state.windows[0]?.work.delivery.source, "unknown");
  assert.deepEqual(state.windows[0]?.work.todos, []);
  assert.equal(state.windows[0]?.window.name, undefined);
  assert.ok(state.windows[0]?.attention.some((item) => item.code === "owner-identity-mismatch"));
  assert.ok(state.windows[0]?.attention.some((item) => item.code === "completion-identity-mismatch"));
});

test("delivery keeps publication and model consumption as separate monotonic stages", () => {
  const expected = {
    accepted: { publicationStage: "accepted", consumptionStage: "unknown", consumed: false },
    queued: { publicationStage: "accepted", consumptionStage: "queued", consumed: false },
    injected: { publicationStage: "accepted", consumptionStage: "injected", consumed: true },
    replied: { publicationStage: "accepted", consumptionStage: "replied", consumed: true },
  } as const;

  for (const status of Object.keys(expected) as Array<keyof typeof expected>) {
    const card = reduceMonitorWindowStateV1({
      observedAt: 4_000,
      windows: [{
        endpoint: endpoint(),
        owner: owner(),
        workRef: WORK,
        delivery: [deliveryEvidence(status)],
      }],
    }).windows[0]!;
    assert.equal(card.work.delivery.publicationStage, expected[status].publicationStage, status);
    assert.equal(card.work.delivery.consumptionStage, expected[status].consumptionStage, status);
    assert.equal(card.work.delivery.consumed, expected[status].consumed, status);
    assert.notEqual(card.work.status, "completed", `${status} must not imply completion`);
  }

  const monotonic = reduceMonitorWindowStateV1({
    observedAt: 4_000,
    windows: [{
      endpoint: endpoint(),
      owner: owner(),
      workRef: WORK,
      delivery: [deliveryEvidence("queued"), deliveryEvidence("injected"), deliveryEvidence("accepted")],
    }],
  }).windows[0]!;
  assert.equal(monotonic.work.delivery.consumptionStage, "injected");
});

test("canonical completion wins over exact reports while lifecycle and Todo remain display-only", () => {
  const projectedOwner = owner(NONCE_A, 3_500, {
    mainLastSettle: { at: 3_100, lastResult: "root turn ended" },
    todos: [{
      id: "todo-1",
      subject: "Display this",
      status: "completed",
      dispatchId: "dispatch-1",
      bindingActive: false,
      updatedAt: 3_200,
    }],
  });
  const withoutEvidence = reduceMonitorWindowStateV1({
    observedAt: 4_000,
    windows: [{ endpoint: endpoint(), owner: projectedOwner, workRef: WORK }],
  }).windows[0]!;
  assert.equal(withoutEvidence.work.status, "unknown");
  assert.deepEqual(withoutEvidence.work.completion, { outcome: "unknown", source: "unknown" });
  assert.equal(withoutEvidence.work.todos[0]?.authority, "display-only");
  assert.equal(withoutEvidence.window.lifecycle.lastSettle?.source, "lifecycle");
  assert.match(
    withoutEvidence.attention.find((item) => item.dedupeKey === "completion-unknown")?.message ?? "",
    /lifecycle settled.*completion is still unknown/,
  );

  const authoritative = reduceMonitorWindowStateV1({
    observedAt: 4_000,
    windows: [{
      endpoint: endpoint(),
      owner: projectedOwner,
      workRef: WORK,
      completion: [
        completion("exact-report", "failed", NONCE_A, 3_900),
        completion("canonical-completion", "completed", NONCE_A, 3_000),
      ],
    }],
  }).windows[0]!;
  assert.equal(authoritative.work.status, "completed");
  assert.equal(authoritative.work.completion.source, "canonical-completion");
});

test("attention is deduplicated and semantic revision ignores observation and heartbeat-only timestamps", () => {
  const duplicateFacet = {
    kind: "flow-schedule",
    target: { identity: identity() },
    revision: "facet-1",
    data: { schedule: "schedule-1" },
    attention: [
      { code: "needs-review", dedupeKey: "same", severity: "info", message: "informational duplicate" },
      { code: "needs-review", dedupeKey: "same", severity: "error", message: "important duplicate" },
    ],
  } as const;
  const first = reduceMonitorWindowStateV1({
    observedAt: 4_000,
    windows: [{ endpoint: endpoint(), owner: owner(NONCE_A, 1_000), facets: [duplicateFacet] }],
  });
  const second = reduceMonitorWindowStateV1({
    observedAt: 9_000,
    windows: [{ endpoint: endpoint(), owner: owner(NONCE_A, 8_000), facets: [duplicateFacet] }],
  });

  const deduped = first.windows[0]!.attention.filter((item) => item.dedupeKey === "same");
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]?.severity, "error");
  assert.equal(first.revision, second.revision);
  assert.equal(first.cursor, second.cursor);
  assert.notEqual(first.observedAt, second.observedAt);
  assert.notEqual(first.windows[0]?.window.lifecycle.ownerPublishedAt, second.windows[0]?.window.lifecycle.ownerPublishedAt);
});

test("root-side facet registry is replacement-safe and reads only exact captured targets", async () => {
  const kind = `monitor-test-${process.pid}-${Date.now()}`;
  const captured = target();
  const firstProvider = {
    kind,
    read: () => [{ kind, target: captured, revision: "first", data: { provider: "first" } }] as const,
  };
  const secondProvider = {
    kind,
    read: () => [
      { kind, target: captured, revision: "second", data: { provider: "second" } },
      { kind, target: target(NONCE_B), revision: "stale", data: { provider: "stale" } },
    ] as const,
  };
  const disposeFirst = registerMonitorWindowFacetProvider(firstProvider);
  const disposeSecond = registerMonitorWindowFacetProvider(secondProvider);
  disposeFirst();
  assert.equal(getMonitorWindowFacetProvider(kind), secondProvider);
  try {
    const errors: string[] = [];
    const facets = await readMonitorWindowFacets({ version: MONITOR_WINDOW_STATE_VERSION, targets: [captured] }, (message) => errors.push(message));
    assert.equal(facets.length, 1);
    assert.equal(facets[0]?.revision, "second");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /uncaptured facet/);
  } finally {
    disposeSecond();
  }
  assert.equal(getMonitorWindowFacetProvider(kind), undefined);
});
