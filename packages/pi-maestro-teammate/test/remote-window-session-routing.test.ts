import assert from "node:assert/strict";
import test from "node:test";
import {
  EndpointDirectory,
  MessageRouter,
  WindowThreadStore,
  captureSessionRoute,
  createRemoteWorkspaceRpcV1TransportAdapter,
  sessionRootEndpointId,
  type SessionEndpoint,
} from "../src/sessions/session-core.ts";
import { projectTeammateSessionEndpoints } from "../src/extension/session-endpoints.ts";
import {
  remoteWindowIncomingThreadEntry,
  remoteWindowReceiptThreadStatus,
} from "../src/extension/remote-window-session.ts";
import type { RemoteWindowMonitorListing } from "../src/extension/remote-window-monitor.ts";
import type { TeammateState } from "../src/shared/types.ts";

function listing(instanceNonce = "gateway-instance-1"): RemoteWindowMonitorListing {
  const capture = {
    workspaceRef: "prod/app",
    authorityId: "prod",
    gatewayWorkerId: "gateway-worker-1",
    gatewayInstanceNonce: instanceNonce,
    monitorOwnerNonce: "monitor-1",
    workspaceId: "a".repeat(64),
    ownerId: "b".repeat(32),
    ownerNonce: "c".repeat(32),
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
    sessionId: "session-remote",
    sessionName: "remote-window",
    status: "running",
    agentCount: 3,
    publishedAt: 100,
    cancel: false,
  };
}

function state(): TeammateState {
  return {
    activeRuns: new Map(),
    currentWorkspaceId: "local-workspace",
    currentSessionId: "local-session",
    currentSourceId: "local-source",
    sessionGeneration: 1,
  } as unknown as TeammateState;
}

test("remote window inbox mapping preserves reply route and advances receipts monotonically", () => {
  const window = listing();
  const notification = {
    type: "window/message" as const,
    capture: window.capture,
    relayId: "d".repeat(32),
    messageId: "reply-1",
    inReplyTo: "message-1",
    mode: "follow_up" as const,
    source: "system" as const,
    messageKind: "coordination" as const,
    message: "remote reply",
    createdAt: 10,
    receivedAt: 20,
  };
  const provenance = {
    version: 1 as const,
    messageId: notification.messageId,
    source: "session-router" as const,
    messageKind: "coordination" as const,
    deliveryMode: "follow_up" as const,
    confidence: "verified" as const,
    sender: { kind: "root-agent" as const, ownerId: notification.capture.ownerId, label: "remote" },
  };
  const input = remoteWindowIncomingThreadEntry(notification, window.target, {
    messageKind: "coordination",
    provenance,
    status: "pending",
    updatedAt: 20,
    targetSessionId: "session-local",
  });
  assert.equal(input.replyTo, window.target);
  assert.equal(input.peerOwnerNonce, notification.capture.ownerNonce);
  assert.equal(input.traceId, "message-1");

  const store = new WindowThreadStore();
  store.record(input);
  store.transition("reply-1", "incoming", remoteWindowReceiptThreadStatus("injected"), 30, "follow_up");
  store.transition("reply-1", "incoming", remoteWindowReceiptThreadStatus("replied"), 40, "follow_up");
  const entry = store.get("reply-1", "incoming");
  assert.equal(entry?.status, "replied");
  assert.equal(entry?.body, "remote reply");
  assert.equal(remoteWindowReceiptThreadStatus("expired"), "timeout");
  assert.equal(remoteWindowReceiptThreadStatus("unknown"), "queued");
});

test("remote Pi windows project into canonical endpoints without changing local ids", () => {
  const localIdentity = {
    workspaceId: "local-workspace",
    ownerId: "1".repeat(32),
    ownerNonce: "2".repeat(32),
  };
  const endpoints = projectTeammateSessionEndpoints(state(), localIdentity, [], "local", true, [listing()]);
  const local = endpoints.find((endpoint) => endpoint.scope === "local")!;
  const remote = endpoints.find((endpoint) => endpoint.scope === "ssh-window")!;
  assert.equal(local.id, sessionRootEndpointId(localIdentity));
  assert.equal(remote.target, `ssh-window:prod/app:${"b".repeat(32)}`);
  assert.equal(remote.transport, "remote-workspace-rpc-v1");
  assert.equal(remote.routeAuthority?.kind, "ssh");
  assert.equal(remote.routeAuthority?.authorityId, "prod");
  assert.equal(remote.routeAuthority?.instanceNonce, "gateway-instance-1");
  assert.equal(remote.sourceId, "gateway-worker-1");
  assert.equal(remote.workspaceRef, "prod/app");
  assert.equal(remote.agentCount, 3);
  assert.deepEqual(remote.capabilities, ["inspect", "message", "steer", "follow_up", "receipt", "reply"]);
  assert.equal(remote.capabilities.includes("interrupt"), false);
  assert.equal(remote.capabilities.includes("abort"), false);

  const directory = new EndpointDirectory(endpoints);
  assert.equal(directory.resolve(remote.target!).endpoint?.id, remote.id);
  assert.equal(directory.resolve(remote.target!).selectorKind, "remote-window");
});

test("remote workspace route capture freezes gateway and capability decisions", async () => {
  const first = projectTeammateSessionEndpoints(
    state(),
    { workspaceId: "local-workspace", ownerId: "1".repeat(32), ownerNonce: "2".repeat(32) },
    [],
    undefined,
    false,
    [listing("gateway-instance-1")],
  ).find((endpoint) => endpoint.scope === "ssh-window")!;
  const delivered: SessionEndpoint[] = [];
  const directory = new EndpointDirectory([first]);
  const router = new MessageRouter({
    directory,
    surface: "unified",
    adapters: [createRemoteWorkspaceRpcV1TransportAdapter(async (endpoint) => {
      delivered.push(endpoint);
      return { delivered: true, endpointId: endpoint.id, transport: endpoint.transport };
    })],
  });
  const capture = captureSessionRoute(first);
  assert.equal(capture.routeAuthority?.instanceNonce, "gateway-instance-1");
  assert.deepEqual(capture.capabilities, first.capabilities);
  assert.equal((await router.route({
    selector: first.target!,
    message: "hello",
    mode: "steer",
    routeCapture: capture,
  })).delivered, true);
  assert.equal(delivered.length, 1);

  const replacement = projectTeammateSessionEndpoints(
    state(),
    { workspaceId: "local-workspace", ownerId: "1".repeat(32), ownerNonce: "2".repeat(32) },
    [],
    undefined,
    false,
    [listing("gateway-instance-2")],
  ).find((endpoint) => endpoint.scope === "ssh-window")!;
  directory.replace([replacement]);
  const stale = await router.route({
    selector: replacement.target!,
    message: "stale",
    mode: "steer",
    routeCapture: capture,
  });
  assert.equal(stale.delivered, false);
  assert.match(stale.error ?? "", /captured session route no longer matches/);

  const unsupported = await router.route({
    selector: replacement.target!,
    message: "stop",
    mode: "interrupt",
  });
  assert.equal(unsupported.delivered, false);
  assert.match(unsupported.error ?? "", /does not support interrupt/);
});
