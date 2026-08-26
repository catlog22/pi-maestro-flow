import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RuntimeBrokerClient } from "../src/runtime-broker/client.ts";
import { RuntimeBrokerServer } from "../src/runtime-broker/server.ts";
import {
  RuntimeBrokerMailboxCommitter,
  runtimeBrokerMailboxStreamId,
} from "../src/runtime-broker/mailbox-commit.ts";
import {
  MAILBOX_SCHEMA_VERSION,
  type MailboxEnvelope,
} from "../src/extension/mailbox/types.ts";

function envelope(messageId = randomUUID()): MailboxEnvelope {
  return {
    messageId,
    schemaVersion: MAILBOX_SCHEMA_VERSION,
    workspaceId: "a".repeat(64),
    teamId: "team-root",
    senderId: "caller",
    recipientId: "worker",
    recipientCorrelationId: "worker-correlation",
    kind: "follow_up",
    mode: "follow_up",
    priority: "normal",
    senderSeq: 1,
    createdAt: 10,
    expiresAt: 10_000,
    ttlMs: 9_990,
    sessionGeneration: 1,
    leaseEpoch: 1,
    leaseNonce: "lease-nonce",
    payload: "do work",
    hash: "compatibility-file-hash",
    correlationId: "correlation-a",
  };
}

test("mailbox applied receipt and domain event commit atomically before duplicate delivery", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "runtime-broker-mailbox-"));
  const server = new RuntimeBrokerServer({ stateDirectory });
  const committer = new RuntimeBrokerMailboxCommitter({ stateDirectory, holderId: "window-a" });
  try {
    await server.listen();
    const message = envelope();
    const first = await committer.commit(message);
    const duplicate = await committer.commit(message);
    assert.equal(first.recovered, false);
    assert.equal(duplicate.recovered, true);
    assert.equal(duplicate.revision, first.revision);
    assert.deepEqual(duplicate.eventIds, first.eventIds);

    const database = new DatabaseSync(server.databasePath, { readOnly: true });
    try {
      const inbox = database.prepare(
        "SELECT stream_id, applied_revision, result_json FROM inbox WHERE message_id = ?",
      ).get(message.messageId) as { stream_id: string; applied_revision: number; result_json: string };
      const events = database.prepare(
        "SELECT stream_id, revision, event_type FROM events WHERE message_id = ?",
      ).all(message.messageId) as Array<{ stream_id: string; revision: number; event_type: string }>;
      assert.equal(inbox.stream_id, runtimeBrokerMailboxStreamId(message.messageId));
      assert.equal(inbox.applied_revision, 1);
      const storedResult = JSON.parse(inbox.result_json) as { reply?: unknown };
      assert.deepEqual(storedResult.reply, {
        state: "applied",
        recipientCorrelationId: message.recipientCorrelationId,
      });
      assert.deepEqual(events.map((event) => ({ ...event })), [{
        stream_id: runtimeBrokerMailboxStreamId(message.messageId),
        revision: 1,
        event_type: "mailbox.applied",
      }]);
    } finally {
      database.close();
    }
  } finally {
    await committer.close();
    await server.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("mailbox broker commit fails closed while the sidecar is unavailable", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "runtime-broker-mailbox-down-"));
  const committer = new RuntimeBrokerMailboxCommitter({
    stateDirectory,
    holderId: "window-a",
    clientFactory: () => RuntimeBrokerClient.connect({ stateDirectory, timeoutMs: 100 }),
  });
  try {
    await assert.rejects(committer.commit(envelope()));
  } finally {
    await committer.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});
