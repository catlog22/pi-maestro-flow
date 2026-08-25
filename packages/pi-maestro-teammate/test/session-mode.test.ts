import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionHostRegistry,
  projectSessionEndpoints,
  windowThreadReplayReceipt,
} from "../src/sessions/session-core.ts";

const WORKSPACE = "a".repeat(64);
const OWNER = "b".repeat(32);
const NONCE = "c".repeat(32);

function endpoint() {
  return projectSessionEndpoints([{
    workspaceId: WORKSPACE,
    ownerId: OWNER,
    ownerNonce: NONCE,
    scope: "workspace-peer",
    status: "running",
    sessionName: "build",
    contextPressure: 42,
    agents: [{
      workspaceId: WORKSPACE,
      ownerId: OWNER,
      ownerNonce: NONCE,
      correlationId: "agent-1",
      status: "running",
      name: "worker",
    }],
  }])[0]!;
}

test("session registry defaults to agents mode and publishes semantic mode changes", async () => {
  const root = endpoint();
  const snapshots: string[] = [];
  const registry = new SessionHostRegistry({ endpoints: [root] });
  registry.subscribe((snapshot) => snapshots.push(snapshot.contentRevision));
  assert.equal(registry.snapshot().viewMode, "agents");

  await registry.requestWindowMode("enter");
  assert.equal(registry.snapshot().viewMode, "windows");
  await registry.requestWindowMode("exit");
  assert.equal(registry.snapshot().viewMode, "agents");
  assert.equal(snapshots.length, 3);
  assert.equal(new Set(snapshots).size, 2);
  assert.equal(snapshots[0], snapshots[2]);
});

test("session registry delegates window mode controls", async () => {
  const root = endpoint();
  const calls: string[] = [];
  const registry = new SessionHostRegistry({
    endpoints: [root],
    controls: {
      requestWindowMode(action) {
        calls.push(`mode:${action}`);
        registry.setViewMode(action === "enter" ? "windows" : "agents");
      },
    },
  });
  await registry.requestWindowMode("enter");
  assert.deepEqual(calls, ["mode:enter"]);
  assert.equal(registry.viewMode, "windows");
});

test("pending incoming thread entries retry while terminal entries return receipts", () => {
  const base = {
    version: 1 as const,
    messageId: "f".repeat(32),
    workspaceId: WORKSPACE,
    peerOwnerId: OWNER,
    peerOwnerNonce: NONCE,
    direction: "incoming" as const,
    source: "system" as const,
    mode: "follow_up" as const,
    body: "message",
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    contentRevision: "r1",
  };
  assert.equal(windowThreadReplayReceipt({ ...base, status: "pending" }), undefined);
  assert.equal(windowThreadReplayReceipt({ ...base, status: "queued" }), undefined);
  assert.deepEqual(windowThreadReplayReceipt({ ...base, status: "injected" }), {
    status: "accepted",
    message: "workspace command was already consumed",
  });
  assert.deepEqual(windowThreadReplayReceipt({ ...base, status: "accepted" }), {
    status: "accepted",
    message: "workspace command was already consumed",
  });
  assert.equal(windowThreadReplayReceipt({ ...base, status: "timeout" })?.status, "rejected");
});

test("root endpoint projects window context and active agent count", () => {
  const root = endpoint();
  assert.equal(root.contextPressure, 42);
  assert.equal(root.agentCount, 1);
});
