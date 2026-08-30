import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRemoteWindowListParams,
  normalizeRemoteWindowNotification,
  normalizeRemoteWindowObserveParams,
  normalizeRemoteWindowReceiptParams,
  normalizeRemoteWindowSendParams,
  type RemoteWindowCapture,
} from "../src/remote/window-protocol.ts";

function capture(): RemoteWindowCapture {
  return {
    workspaceRef: "prod/app",
    authorityId: "prod",
    gatewayWorkerId: "worker-1",
    gatewayInstanceNonce: "instance-1",
    monitorOwnerNonce: "monitor-1",
    workspaceId: "a".repeat(64),
    ownerId: "b".repeat(32),
    ownerNonce: "c".repeat(32),
    generation: 1,
    transportVersion: 1,
    capabilities: ["observe", "steer", "follow_up", "receipt"],
    cancel: false,
  };
}

test("remote window request normalizers freeze trusted captures and reject unknown fields", () => {
  const listed = normalizeRemoteWindowListParams({
    commandId: "list-1",
    monitorOwnerNonce: "monitor-1",
    workspaceRef: "prod/app",
    authorityId: "prod",
    transportVersion: 1,
  });
  assert.equal(Object.isFrozen(listed), true);
  assert.throws(() => normalizeRemoteWindowListParams({ ...listed, cwd: "/arbitrary" }), /list params/);

  const observed = normalizeRemoteWindowObserveParams({
    commandId: "observe-1",
    monitorOwnerNonce: "monitor-1",
    capture: capture(),
  });
  assert.equal(Object.isFrozen(observed.capture.capabilities), true);
  assert.throws(() => normalizeRemoteWindowObserveParams({
    ...observed,
    monitorOwnerNonce: "monitor-2",
  }), /capture monitorOwnerNonce fence changed/);
});

test("remote window send and receipt normalizers enforce message and acknowledgement bounds", () => {
  const sent = normalizeRemoteWindowSendParams({
    commandId: "send-1",
    monitorOwnerNonce: "monitor-1",
    capture: capture(),
    messageId: "message-1",
    mode: "steer",
    message: "hello",
    source: "monitor",
    messageKind: "coordination",
    ttlMs: 1_000,
  });
  assert.equal(sent.mode, "steer");
  assert.throws(() => normalizeRemoteWindowSendParams({ ...sent, ttlMs: 10 * 60_000 + 1 }), /send params/);
  assert.throws(() => normalizeRemoteWindowSendParams({ ...sent, message: "x".repeat(64 * 1024 + 1) }), /send params/);

  assert.throws(() => normalizeRemoteWindowReceiptParams({
    commandId: "receipt-1",
    monitorOwnerNonce: "monitor-1",
    capture: capture(),
    messageId: "message-1",
    direction: "outgoing",
    acknowledge: "injected",
  }), /receipt params/);
  const incoming = normalizeRemoteWindowReceiptParams({
    commandId: "receipt-2",
    monitorOwnerNonce: "monitor-1",
    capture: capture(),
    messageId: "reply-1",
    direction: "incoming",
    acknowledge: "injected",
  });
  assert.equal(incoming.acknowledge, "injected");
});

test("remote window notifications reject receipt captures from another owner", () => {
  const value = capture();
  assert.throws(() => normalizeRemoteWindowNotification({
    type: "window/state",
    capture: value,
    state: "updated",
    observedAt: 10,
    receipt: {
      capture: { ...value, ownerNonce: "d".repeat(32) },
      messageId: "message-1",
      requestedMode: "steer",
      status: "queued",
      updatedAt: 10,
      expiresAt: 20,
    },
  }), /receipt capture mismatch/);
});
