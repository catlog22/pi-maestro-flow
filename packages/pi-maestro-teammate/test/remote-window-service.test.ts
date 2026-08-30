import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  WORKSPACE_MAIN_SESSION_MARKER,
  consumeWorkspacePeerCommands,
  createWorkspacePeerIdentity,
  defaultWorkspacePeerRoot,
  enqueueWorkspacePeerCommand,
  ownerSnapshotPath,
  publishWorkspaceOwner,
  type WorkspacePeerCommand,
  type WorkspaceResolvedTarget,
} from "../src/sessions/workspace-peer-core.ts";
import { RemoteWindowService } from "../src/remote/window-service.ts";
import type { RemoteWindowMessageNotification, RemoteWindowNotification } from "../src/remote/window-protocol.ts";
import type { RuntimeEventDraftV2 } from "../src/runtime-v2/contracts.ts";
import type { ResolvedRemoteWorkspace } from "../src/remote/types.ts";

const OWNER_ID = "1".repeat(32);
const OWNER_NONCE = "2".repeat(32);
const REPLACEMENT_NONCE = "3".repeat(32);

async function fixture() {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "remote-window-service-")));
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });
  const runtimeRoot = defaultWorkspacePeerRoot(cwd);
  const peer = createWorkspacePeerIdentity(cwd, { ownerId: OWNER_ID, ownerNonce: OWNER_NONCE });
  await publishWorkspaceOwner(peer, {
    agents: [],
    settled: [],
    sessionId: "session-remote",
    sessionName: "remote-window",
    relay: { versions: [1], capabilities: ["receipt", "reply"] },
  });
  const workspace: ResolvedRemoteWorkspace = {
    workspaceRef: "prod/app",
    host: "prod",
    cwd,
    requiredPlugin: "pi-maestro-teammate",
    minimumWindowProtocol: 1,
    hostConfig: {
      host: "example.invalid",
      user: "tester",
      port: 22,
      hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAA==",
    },
  };
  const notifications: Array<{ monitorOwnerNonce: string; notification: RemoteWindowNotification }> = [];
  const domainEvents: RuntimeEventDraftV2[] = [];
  let clock = Date.now();
  const service = new RemoteWindowService({
    workspaces: [workspace],
    identity: { workerId: "worker-1", instanceNonce: "instance-1" },
    now: () => clock,
    notify: (monitorOwnerNonce, notification) => notifications.push({ monitorOwnerNonce, notification }),
    onDomainEvent: (event) => domainEvents.push(event),
  });
  return {
    cwd,
    peer,
    service,
    notifications,
    domainEvents,
    setClock(value: number) { clock = value; },
    getClock() { return clock; },
    async cleanup() {
      service.close();
      await rm(runtimeRoot, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    },
  };
}

function listParams() {
  return {
    commandId: "list-1",
    monitorOwnerNonce: "monitor-1",
    workspaceRef: "prod/app",
    authorityId: "prod",
    transportVersion: 1 as const,
  };
}

test("remote window service discovers only compatible Pi owners and fences observation", async () => {
  const value = await fixture();
  try {
    const listed = await value.service.list(listParams());
    assert.equal(listed.windows.length, 1);
    assert.equal(value.domainEvents[0]?.kind, "domain.event");
    assert.equal(value.domainEvents[0]?.kind === "domain.event" ? value.domainEvents[0].eventType : undefined, "session.window.advertised");
    const [window] = listed.windows;
    assert.equal(window?.capture.ownerId, OWNER_ID);
    assert.equal(window?.capture.cancel, false);
    assert.deepEqual(window?.capture.capabilities, ["observe", "steer", "follow_up", "receipt", "reply"]);
    const observed = await value.service.observe({
      commandId: "observe-1",
      monitorOwnerNonce: "monitor-1",
      capture: window!.capture,
    });
    assert.equal(observed.owner.sessionName, "remote-window");

    const replacement = createWorkspacePeerIdentity(value.cwd, { ownerId: OWNER_ID, ownerNonce: REPLACEMENT_NONCE });
    await publishWorkspaceOwner(replacement, { agents: [], settled: [], sessionName: "replacement" });
    await assert.rejects(
      value.service.observe({ commandId: "observe-2", monitorOwnerNonce: "monitor-1", capture: window!.capture }),
      /owner capture mismatch/,
    );
  } finally {
    await value.cleanup();
  }
});

test("remote window send advances receipts and relays one acknowledged reply", async () => {
  const value = await fixture();
  try {
    const capture = (await value.service.list(listParams())).windows[0]!.capture;
    const sent = await value.service.send({
      commandId: "send-1",
      monitorOwnerNonce: "monitor-1",
      capture,
      messageId: "message-1",
      mode: "follow_up",
      message: "remote request",
      source: "monitor",
      messageKind: "request",
    });
    assert.equal(sent.receipt.status, "queued");
    assert.ok(value.domainEvents.some((event) => event.kind === "domain.event" && event.eventType === "session.message.accepted"));
    assert.match(sent.receipt.relayId ?? "", /^[a-f0-9]{32}$/);

    let request: WorkspacePeerCommand | undefined;
    const consumed = await consumeWorkspacePeerCommands(value.peer, (command) => {
      request = command;
      return { status: "accepted", effectiveAction: command.action, deliveryStage: "injected" };
    });
    assert.equal(consumed.length, 1);
    assert.equal(request?.targetCorrelationId, WORKSPACE_MAIN_SESSION_MARKER);
    assert.equal(request?.replyTo, `relay:${sent.receipt.relayId}`);

    const receipt = await value.service.receipt({
      commandId: "receipt-1",
      monitorOwnerNonce: "monitor-1",
      capture,
      messageId: "message-1",
      direction: "outgoing",
    });
    assert.equal(receipt.receipt?.status, "injected");
    assert.ok(value.domainEvents.some((event) => event.kind === "domain.event" && event.eventType === "session.message.injected"));

    const relayTarget: WorkspaceResolvedTarget = {
      scope: "remote",
      ownerId: request!.fromOwnerId,
      ownerNonce: request!.fromOwnerNonce,
      state: "active",
      agent: {
        correlationId: WORKSPACE_MAIN_SESSION_MARKER,
        agent: "window",
        status: "running",
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
      },
    };
    await enqueueWorkspacePeerCommand(value.peer, relayTarget, "follow_up", "remote reply", {
      messageId: "reply-1",
      source: "system",
      messageKind: "coordination",
    });
    await value.service.receipt({
      commandId: "receipt-2",
      monitorOwnerNonce: "monitor-1",
      capture,
      messageId: "message-1",
      direction: "outgoing",
    });
    const message = value.notifications
      .map((entry) => entry.notification)
      .find((notification): notification is RemoteWindowMessageNotification => notification.type === "window/message");
    assert.equal(message?.message, "remote reply");
    assert.equal(message?.inReplyTo, "message-1");

    await value.service.tick();
    assert.ok(value.notifications.filter((entry) => entry.notification.type === "window/message").length >= 2,
      "unacknowledged inbound reply is replayed on reconnect ticks");
    const acknowledged = await value.service.receipt({
      commandId: "receipt-3",
      monitorOwnerNonce: "monitor-1",
      capture,
      messageId: message!.messageId,
      direction: "incoming",
      acknowledge: "injected",
    });
    assert.equal(acknowledged.acknowledged, true);
    const before = value.notifications.length;
    await value.service.tick();
    assert.equal(value.notifications.length, before, "acknowledged inbound reply is not replayed");
  } finally {
    await value.cleanup();
  }
});

test("remote window receipts remain readable after delivery TTL and legacy owners are inspect-ineligible", async () => {
  const value = await fixture();
  try {
    const capture = (await value.service.list(listParams())).windows[0]!.capture;
    await value.service.send({
      commandId: "send-expiring",
      monitorOwnerNonce: "monitor-1",
      capture,
      messageId: "message-expiring",
      mode: "steer",
      message: "expires",
      source: "monitor",
      messageKind: "coordination",
      ttlMs: 10,
    });
    value.setClock(value.getClock() + 11);
    const expired = await value.service.receipt({
      commandId: "receipt-expired",
      monitorOwnerNonce: "monitor-1",
      capture,
      messageId: "message-expiring",
    });
    assert.equal(expired.receipt?.status, "expired");

    const snapshotPath = ownerSnapshotPath(value.peer);
    const legacy = JSON.parse(await readFile(snapshotPath, "utf8")) as Record<string, unknown>;
    delete legacy.plugin;
    delete legacy.protocol;
    await writeFile(snapshotPath, `${JSON.stringify(legacy)}\n`, "utf8");
    assert.deepEqual((await value.service.list(listParams())).windows, []);
  } finally {
    await value.cleanup();
  }
});
