import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MailboxFileStore } from "../src/extension/mailbox/file-store.ts";
import type { MailboxAuthority } from "../src/extension/mailbox/router.ts";
import { FileRuntimeTransport } from "../src/runtime-broker/file-transport.ts";

const WORKSPACE_ID = "a".repeat(64);

function authority(): MailboxAuthority {
  return {
    canRoute: () => ({ allowed: true }),
    currentGeneration: () => 1,
    currentLeaseEpoch: () => 1,
    currentLeaseNonce: () => "lease-nonce",
    isFenced: () => false,
    isStaleUnauthorized: () => false,
    managesRecipient: () => true,
  };
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for runtime transport state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("file transport enqueues, consumes accepted, and auto-applies successful dispatch", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "runtime-broker-transport-"));
  const transport = new FileRuntimeTransport({
    rootDir,
    authority: authority(),
    recipientCorrelationId: "recipient-1",
    workspaceId: WORKSPACE_ID,
    teamId: "team-1",
    ownerId: "owner-1",
    pollMs: 5,
  });

  try {
    const enqueued = await transport.enqueue({
      senderId: "sender-1",
      recipientId: "owner-2",
      recipientCorrelationId: "recipient-1",
      kind: "follow_up",
      mode: "follow_up",
      payload: "deliver once",
      requestId: "request-1",
    });
    assert.ok(enqueued.ok);
    assert.equal(await transport.state(enqueued.messageId), "ready");
    assert.equal(await transport.hasPendingMessages(), true);

    const dispatchStates: Array<string | undefined> = [];
    await transport.consume(async (message) => {
      assert.equal(message.messageId, enqueued.messageId);
      assert.equal(message.payload, "deliver once");
      dispatchStates.push(await transport.state(message.messageId));
    });

    await waitFor(async () => await transport.state(enqueued.messageId) === "applied");
    assert.deepEqual(dispatchStates, ["accepted"]);
    assert.equal(await transport.hasPendingMessages(), false);

    assert.equal(await transport.acknowledge(enqueued.messageId), false);
    assert.equal(await transport.acknowledge(enqueued.messageId), false);
    assert.equal(await transport.state(enqueued.messageId), "applied");
  } finally {
    await transport.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("external acknowledge wins after the rejection applied read and remains terminal", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "runtime-broker-transport-ack-"));
  const transport = new FileRuntimeTransport({
    rootDir,
    authority: authority(),
    recipientCorrelationId: "recipient-1",
    workspaceId: WORKSPACE_ID,
    teamId: "team-1",
    ownerId: "owner-1",
    pollMs: 5,
  });
  let releaseDispatch!: () => void;
  let dispatchCalls = 0;
  const dispatchBarrier = new Promise<void>((resolve) => { releaseDispatch = resolve; });
  const originalReadEnvelope = MailboxFileStore.prototype.readEnvelope;
  let targetMessageId: string | undefined;
  let interceptAppliedReads = false;
  let appliedReads = 0;
  let markFirstAppliedRead!: () => void;
  let continueRejection!: () => void;
  let markRejectionContinued!: () => void;
  const firstAppliedRead = new Promise<void>((resolve) => { markFirstAppliedRead = resolve; });
  const rejectionMayContinue = new Promise<void>((resolve) => { continueRejection = resolve; });
  const rejectionContinued = new Promise<void>((resolve) => { markRejectionContinued = resolve; });

  MailboxFileStore.prototype.readEnvelope = async function (state, messageId) {
    const envelope = await originalReadEnvelope.call(this, state, messageId);
    if (!interceptAppliedReads || state !== "applied" || messageId !== targetMessageId) return envelope;
    appliedReads += 1;
    if (appliedReads === 1) {
      assert.equal(envelope, undefined, "rejection observes no applied record before ack rename");
      markFirstAppliedRead();
      await rejectionMayContinue;
    } else if (appliedReads === 2) {
      assert.ok(envelope, "serialized rejection rechecks applied after ack completes");
      markRejectionContinued();
    }
    return envelope;
  };

  try {
    const enqueued = await transport.enqueue({
      senderId: "sender-1",
      recipientId: "owner-2",
      recipientCorrelationId: "recipient-1",
      kind: "follow_up",
      mode: "follow_up",
      payload: "external ack",
    });
    assert.ok(enqueued.ok);
    targetMessageId = enqueued.messageId;

    await transport.consume(async () => {
      dispatchCalls += 1;
      await dispatchBarrier;
      throw new Error("late local dispatch failure");
    });
    await waitFor(async () => await transport.state(enqueued.messageId) === "accepted");

    interceptAppliedReads = true;
    releaseDispatch();
    await firstAppliedRead;
    assert.equal(await transport.acknowledge(enqueued.messageId), true);
    continueRejection();
    await rejectionContinued;

    assert.equal(await transport.state(enqueued.messageId), "applied");
    assert.equal(await transport.acknowledge(enqueued.messageId), false);
    assert.equal(await transport.hasPendingMessages(), false);
    assert.equal(dispatchCalls, 1);
  } finally {
    MailboxFileStore.prototype.readEnvelope = originalReadEnvelope;
    continueRejection();
    releaseDispatch();
    await transport.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});
