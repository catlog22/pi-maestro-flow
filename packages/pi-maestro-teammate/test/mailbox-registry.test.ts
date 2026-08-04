/**
 * Contract tests for the public v1 mailbox registry (pi-maestro-teammate/v1/mailbox).
 * These are the external-consumer surface the Flow host integrates through:
 * enqueueTaskNotification → durable dispatch, pendingCount, negotiate, and
 * taskId-based dedup.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { createMailboxHostRegistry } from "../src/public/v1/mailbox.ts";
import { type MailboxAuthority } from "../src/extension/mailbox/router.ts";
import { MailboxService } from "../src/extension/mailbox/service.ts";

const temporaryDirectories: string[] = [];
let baseDir: string;
let nowMs: number;

function permissiveAuthority(): MailboxAuthority {
  return {
    canRoute: () => ({ allowed: true }),
    currentGeneration: () => 1,
    currentLeaseEpoch: () => 1,
    currentLeaseNonce: () => "nonce-abc",
    isFenced: () => false,
    isStaleUnauthorized: () => false,
  };
}

function makeService(onDispatch: (payload: string) => void): MailboxService {
  return new MailboxService({
    rootDir: join(baseDir, "mailbox"),
    authority: permissiveAuthority(),
    recipientCorrelationId: "*",
    workspaceId: "a".repeat(64),
    teamId: "team-root",
    ownerId: "registry-owner",
    onDispatch: async (envelope) => { onDispatch(envelope.payload); },
    pollMs: 10,
    now: () => nowMs,
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "mailbox-registry-"));
  temporaryDirectories.push(baseDir);
  nowMs = 1_700_000_000_000;
});

test("registry enqueueTaskNotification dispatches durably to the agent", async () => {
  const dispatched: string[] = [];
  const service = makeService((p) => dispatched.push(p));
  const registry = createMailboxHostRegistry(service, "v2");
  await service.start();

  const result = await registry.enqueueTaskNotification({
    senderId: "flow-host",
    recipientId: "child",
    recipientCorrelationId: "corr-child-1",
    payload: "task from flow host",
  });
  assert.ok(result.ok);

  // Consumer dispatches the durable notification.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(dispatched, ["task from flow host"]);
  await service.stop();
});

test("registry pendingCount reflects undelivered notifications per recipient", async () => {
  const service = makeService(() => {});
  const registry = createMailboxHostRegistry(service, "v2");
  await service.start();
  // Slow down the consumer so the message stays ready during the check.
  await service.stop();

  await registry.enqueueTaskNotification({
    senderId: "flow-host",
    recipientId: "child",
    recipientCorrelationId: "corr-child-1",
    payload: "one",
  });
  await registry.enqueueTaskNotification({
    senderId: "flow-host",
    recipientId: "child",
    recipientCorrelationId: "corr-child-2",
    payload: "two",
  });

  assert.equal(await registry.pendingCount("corr-child-1"), 1);
  assert.equal(await registry.pendingCount("corr-child-2"), 1);
  assert.equal(await registry.pendingCount("corr-other"), 0);
  await service.stop();
});

test("registry negotiate follows the v1/v2 capability matrix", () => {
  const service = makeService(() => {});
  const registry = createMailboxHostRegistry(service, "v2");
  assert.equal(registry.negotiate("v2"), "v2");
  assert.equal(registry.negotiate("v1"), "v1");
  assert.equal(registry.negotiate(undefined), "v1");

  const v1Registry = createMailboxHostRegistry(service, "v1");
  assert.equal(v1Registry.negotiate("v2"), "v1");
});

test("registry taskId dedups repeated notifications of the same logical task", async () => {
  const dispatched: string[] = [];
  const service = makeService((p) => dispatched.push(p));
  const registry = createMailboxHostRegistry(service, "v2");
  await service.start();

  const first = await registry.enqueueTaskNotification({
    senderId: "flow-host",
    recipientId: "child",
    recipientCorrelationId: "corr-child-1",
    payload: "first attempt",
    taskId: "task-42",
  });
  assert.ok(first.ok);
  const retry = await registry.enqueueTaskNotification({
    senderId: "flow-host",
    recipientId: "child",
    recipientCorrelationId: "corr-child-1",
    payload: "retried attempt",
    taskId: "task-42",
  });
  assert.equal(retry.ok, false, "same taskId must not be enqueued twice");
  assert.equal((retry as { code?: string }).code, "duplicate");

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(dispatched, ["first attempt"]);
  await service.stop();
});
