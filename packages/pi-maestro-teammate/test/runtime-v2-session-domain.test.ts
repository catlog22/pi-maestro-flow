import assert from "node:assert/strict";
import test from "node:test";
import { projectTeammateSessionEndpoints } from "../src/extension/session-endpoints.ts";
import type { RemoteWindowMonitorListing } from "../src/extension/remote-window-monitor.ts";
import type { TeammateState } from "../src/shared/types.ts";
import type { RuntimeDomainEventV2, RuntimeEventDraftV2 } from "../src/runtime-v2/contracts.ts";
import {
  SESSION_MESSAGE_ACCEPTED_EVENT_V2,
  SESSION_MESSAGE_INJECTED_EVENT_V2,
  SESSION_MESSAGE_REPLIED_EVENT_V2,
  SESSION_WINDOW_ADVERTISED_EVENT_V2,
  SESSION_WINDOW_HEARTBEAT_EVENT_V2,
  SESSION_WINDOW_WITHDRAWN_EVENT_V2,
  SessionDomainProjectionV2,
  compareSessionEndpointShadowV2,
  createSessionDomainEventDraftV2,
  sessionRouteCaptureV2FromEndpoint,
  type SessionDomainEventTypeV2,
  type SessionMessageDomainPayloadV2,
  type SessionWindowDomainPayloadV2,
} from "../src/runtime-v2/session-domain.ts";
import {
  SESSION_RUNTIME_V2_OUTBOX_ENV,
  SESSION_RUNTIME_V2_READ_ENV,
  resolveSessionRuntimeV2Rollout,
  selectSessionEndpointReadModelV2,
  sessionOutboxAuthority,
  sessionReadAuthority,
} from "../src/runtime-v2/session-rollout.ts";
import { SessionDomainBrokerCommitter } from "../src/runtime-broker/session-commit.ts";
import { SessionDomainBrokerReadModelV2 } from "../src/runtime-v2/session-broker-read-model.ts";
import type {
  JsonValue,
  RuntimeBrokerCommitRequest,
  RuntimeBrokerCommitResult,
  RuntimeBrokerReadModelSourceState,
  StoredRuntimeBrokerCursorEvent,
} from "../src/runtime-broker/contracts.ts";

function state(): TeammateState {
  return {
    activeRuns: new Map(),
    currentWorkspaceId: "local-workspace",
    currentSessionId: "local-session",
    currentSourceId: "local-source",
    sessionGeneration: 1,
  } as unknown as TeammateState;
}

function remoteListing(instanceNonce = "gateway-instance-1", ownerNonce = "c".repeat(32)): RemoteWindowMonitorListing {
  const capture = {
    workspaceRef: "prod/app",
    authorityId: "prod",
    gatewayWorkerId: "gateway-worker-1",
    gatewayInstanceNonce: instanceNonce,
    monitorOwnerNonce: "monitor-1",
    workspaceId: "a".repeat(64),
    ownerId: "b".repeat(32),
    ownerNonce,
    generation: 2,
    transportVersion: 1 as const,
    capabilities: ["observe", "steer", "follow_up", "receipt", "reply"] as const,
    cancel: false as const,
  };
  return {
    capture,
    target: `ssh-window:prod/app:${capture.ownerId}`,
    workspaceRef: "prod/app",
    authorityId: "prod",
    sessionId: "remote-session",
    sessionName: "remote-window",
    status: "running",
    agentCount: 2,
    publishedAt: 100,
    cancel: false,
  };
}

function endpoints(remote = remoteListing()) {
  return projectTeammateSessionEndpoints(
    state(),
    { workspaceId: "local-workspace", ownerId: "1".repeat(32), ownerNonce: "2".repeat(32) },
    [],
    "local-window",
    false,
    [remote],
  );
}

function draft(
  eventType: SessionDomainEventTypeV2,
  streamId: string,
  eventId: string,
  occurredAt: number,
  payload: SessionWindowDomainPayloadV2 | SessionMessageDomainPayloadV2,
): RuntimeEventDraftV2 {
  return createSessionDomainEventDraftV2({ eventType, streamId, actor: payload.route.actor, eventId, occurredAt, payload });
}

function persisted(event: RuntimeEventDraftV2, sequence: number): RuntimeDomainEventV2 {
  assert.equal(event.kind, "domain.event");
  return { ...event, sequence, producerEpoch: 1 } as RuntimeDomainEventV2;
}

test("session domain shadow matches local and SSH endpoints and fences lifecycle replacements", () => {
  const initial = endpoints();
  const projection = new SessionDomainProjectionV2();
  let cursor = 0;
  const sequence = new Map<string, number>();
  const apply = (
    eventType: SessionDomainEventTypeV2,
    payload: SessionWindowDomainPayloadV2 | SessionMessageDomainPayloadV2,
    eventId: string,
  ) => {
    const streamId = `session:${payload.route.authority.kind}:${payload.route.ownerId}:${payload.route.ownerNonce}`;
    const next = (sequence.get(streamId) ?? 0) + 1;
    sequence.set(streamId, next);
    cursor += 1;
    return projection.apply(persisted(draft(eventType, streamId, eventId, 100 + cursor, payload), next), cursor);
  };

  for (const endpoint of initial.filter((candidate) => candidate.kind === "root")) {
    assert.equal(apply(SESSION_WINDOW_ADVERTISED_EVENT_V2, {
      version: 1,
      route: sessionRouteCaptureV2FromEndpoint(endpoint),
      status: endpoint.status === "settled" ? "sleeping" : endpoint.status,
      ...(endpoint.sessionId === undefined ? {} : { sessionId: endpoint.sessionId }),
      ...(endpoint.sessionName === undefined ? {} : { sessionName: endpoint.sessionName }),
      agentCount: endpoint.agentCount ?? 0,
    }, `advertised:${endpoint.id}`), true);
  }
  assert.equal(compareSessionEndpointShadowV2(initial, projection.snapshot()).matches, true);
  const canonicalDecision = resolveSessionRuntimeV2Rollout({
    [SESSION_RUNTIME_V2_READ_ENV]: "canonical",
  }, "sqlite");
  const selected = selectSessionEndpointReadModelV2(canonicalDecision, initial, projection.snapshot());
  assert.equal(selected.source, "runtime-v2");
  assert.equal(selected.endpoints.length, initial.filter((endpoint) => endpoint.kind === "root").length);
  assert.equal(selectSessionEndpointReadModelV2(canonicalDecision, initial, undefined).source, "v1");

  const remote = initial.find((endpoint) => endpoint.scope === "ssh-window")!;
  const route = sessionRouteCaptureV2FromEndpoint(remote);
  assert.equal(apply(SESSION_WINDOW_HEARTBEAT_EVENT_V2, {
    version: 1, route, status: "running", sessionId: remote.sessionId, sessionName: remote.sessionName, agentCount: 2,
  }, "heartbeat-1"), true);
  assert.equal(apply(SESSION_MESSAGE_ACCEPTED_EVENT_V2, {
    version: 1, route, messageId: "message-1", direction: "outgoing", mode: "steer",
  }, "message-1:accepted"), true);
  assert.equal(apply(SESSION_MESSAGE_ACCEPTED_EVENT_V2, {
    version: 1, route, messageId: "message-1", direction: "outgoing", mode: "steer",
  }, "message-1:accepted-duplicate"), true);
  assert.equal(apply(SESSION_MESSAGE_INJECTED_EVENT_V2, {
    version: 1, route, messageId: "message-1", direction: "outgoing", mode: "steer",
  }, "message-1:injected"), true);
  assert.equal(apply(SESSION_MESSAGE_REPLIED_EVENT_V2, {
    version: 1, route, messageId: "message-1", direction: "outgoing", mode: "steer",
  }, "message-1:replied"), true);
  assert.equal(projection.snapshot().messages[0]?.stage, "replied");

  const stale = persisted(draft(SESSION_WINDOW_HEARTBEAT_EVENT_V2, "stale-stream", "stale", 999, {
    version: 1, route, status: "running", agentCount: 2,
  }), 2);
  assert.equal(projection.apply(stale, cursor + 1), false, "out-of-sequence event bypassed the lease/sequence fence");

  const replacementEndpoints = endpoints(remoteListing("gateway-instance-2", "d".repeat(32)));
  const replacement = replacementEndpoints.find((endpoint) => endpoint.scope === "ssh-window")!;
  assert.equal(apply(SESSION_WINDOW_ADVERTISED_EVENT_V2, {
    version: 1,
    route: sessionRouteCaptureV2FromEndpoint(replacement),
    status: "running",
    sessionId: replacement.sessionId,
    sessionName: replacement.sessionName,
    agentCount: 2,
  }, "replacement-advertised"), true);
  const drift = compareSessionEndpointShadowV2(replacementEndpoints, projection.snapshot());
  assert.equal(drift.matches, false);
  assert.ok(drift.unexpectedInV2.length >= 1, "old gateway/owner remained invisible to shadow comparison");

  assert.equal(apply(SESSION_WINDOW_WITHDRAWN_EVENT_V2, {
    version: 1,
    route,
    status: "unavailable",
    agentCount: 0,
    reason: "gateway-replaced",
  }, "old-withdrawn"), true);
  assert.equal(compareSessionEndpointShadowV2(replacementEndpoints, projection.snapshot()).matches, true);
});

test("session broker read model rebuilds one local/SSH view and excludes expired lease streams", async () => {
  const projectedEndpoints = endpoints();
  const sources: RuntimeBrokerReadModelSourceState[] = [];
  const events: StoredRuntimeBrokerCursorEvent[] = [];
  let cursor = 0;
  for (const endpoint of projectedEndpoints.filter((candidate) => candidate.kind === "root")) {
    const route = sessionRouteCaptureV2FromEndpoint(endpoint);
    const streamId = `session-source:${endpoint.scope}`;
    sources.push({ streamId, generation: route.actor.generation, active: true });
    const event = persisted(draft(SESSION_WINDOW_ADVERTISED_EVENT_V2, streamId, `advertised:${endpoint.id}`, 100 + cursor, {
      version: 1,
      route,
      status: endpoint.status === "settled" ? "sleeping" : endpoint.status,
      ...(endpoint.sessionId === undefined ? {} : { sessionId: endpoint.sessionId }),
      ...(endpoint.sessionName === undefined ? {} : { sessionName: endpoint.sessionName }),
      agentCount: endpoint.agentCount ?? 0,
    }), 1);
    cursor += 1;
    events.push({
      eventId: `event-${cursor}`,
      messageId: `message-${cursor}`,
      streamId,
      revision: 1,
      eventType: "domain.event",
      payload: structuredClone(event) as unknown as JsonValue,
      producerEpoch: 1,
      occurredAt: event.occurredAt,
      cursor,
    });
  }
  let duplicateCursor = false;
  const port = {
    async readRuntimeReadModelSources(_workspaceId: string, afterStreamId = "") {
      return sources.filter((source) => source.streamId > afterStreamId).sort((left, right) => left.streamId.localeCompare(right.streamId));
    },
    async readRuntimeReadModelEvents(_workspaceId: string, afterCursor = 0) {
      const selected = events.filter((event) => event.cursor > afterCursor);
      return duplicateCursor && selected.length > 1
        ? [{ ...selected[0]!, cursor: afterCursor + 1 }, { ...selected[1]!, cursor: afterCursor + 1 }]
        : selected;
    },
  };
  const reader = new SessionDomainBrokerReadModelV2({ port, workspaceId: "local-workspace" });
  const snapshot = await reader.refresh();
  assert.equal(compareSessionEndpointShadowV2(projectedEndpoints, snapshot).matches, true);

  const remoteSource = sources.find((source) => source.streamId.includes("ssh-window"))!;
  remoteSource.active = false;
  const withoutRemote = await reader.refresh();
  assert.equal(withoutRemote.windows.length, 1);
  assert.equal(compareSessionEndpointShadowV2(projectedEndpoints, withoutRemote).matches, false);

  remoteSource.active = true;
  duplicateCursor = true;
  await assert.rejects(reader.refresh(), /cursor did not advance/);
  assert.equal(reader.snapshot().windows.length, 1, "failed refresh replaced the last valid snapshot");
});

test("session read and outbox authority switches are independent and SQLite-gated", () => {
  const env = {
    [SESSION_RUNTIME_V2_READ_ENV]: "canonical",
    [SESSION_RUNTIME_V2_OUTBOX_ENV]: "canonical",
  };
  const file = resolveSessionRuntimeV2Rollout(env, "file");
  assert.equal(file.read, "shadow");
  assert.equal(file.outbox, "shadow");
  assert.equal(sessionReadAuthority(file, true), "v1");
  assert.equal(sessionOutboxAuthority(file, true), "v1");
  assert.equal(file.reasons.length, 2);

  const sqlite = resolveSessionRuntimeV2Rollout({
    [SESSION_RUNTIME_V2_READ_ENV]: "canonical",
    [SESSION_RUNTIME_V2_OUTBOX_ENV]: "shadow",
  }, "sqlite");
  assert.equal(sessionReadAuthority(sqlite, true), "runtime-v2");
  assert.equal(sessionReadAuthority(sqlite, false), "v1", "shadow drift did not force read rollback");
  assert.equal(sessionOutboxAuthority(sqlite, true), "v1");
});

test("session broker committer atomically carries event projection and outbox with idempotent revision", async () => {
  const requests: RuntimeBrokerCommitRequest[] = [];
  const port = {
    async commit(request: RuntimeBrokerCommitRequest): Promise<RuntimeBrokerCommitResult> {
      requests.push(request);
      const duplicate = requests.slice(0, -1).some((candidate) => candidate.messageId === request.messageId);
      return {
        messageId: request.messageId,
        streamId: request.streamId,
        previousRevision: duplicate ? 0 : request.expectedRevision,
        revision: duplicate ? 1 : request.expectedRevision + request.events.length,
        eventIds: request.events.map((event) => event.eventId),
        outboxIds: request.outbox?.map((entry) => entry.outboxId) ?? [],
        appliedAt: 100,
        recovered: duplicate,
      };
    },
  };
  const endpoint = endpoints().find((candidate) => candidate.scope === "ssh-window")!;
  const route = sessionRouteCaptureV2FromEndpoint(endpoint);
  const event = draft(SESSION_MESSAGE_ACCEPTED_EVENT_V2, "session-stream", "message-1:accepted", 100, {
    version: 1, route, messageId: "message-1", direction: "outgoing", mode: "follow_up",
  });
  const committer = new SessionDomainBrokerCommitter({
    port,
    actorId: "session-actor",
    lease: { epoch: 1, nonce: "lease-1" },
    streamId: "session-stream",
  });
  const projection = { version: 1 as const, cursor: 1, windows: [], messages: [] };
  const input = {
    messageId: "commit-message-1",
    event,
    projection,
    outbox: [{ outboxId: "outbox-1", destination: endpoint.target!, payload: { messageId: "message-1" } }],
  };
  const first = await committer.commit(input);
  assert.equal(first.revision, 1);
  assert.equal(requests[0]?.events.length, 1);
  assert.equal(requests[0]?.projections?.length, 1);
  assert.equal(requests[0]?.outbox?.length, 1);
  assert.equal((requests[0]?.events[0]?.payload as { eventType?: string }).eventType, SESSION_MESSAGE_ACCEPTED_EVENT_V2);

  const duplicate = await committer.commit(input);
  assert.equal(duplicate.recovered, true);
  assert.equal(committer.revision, 1);
});
