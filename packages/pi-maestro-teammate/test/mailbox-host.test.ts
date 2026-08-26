import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { createMailboxAuthority, mailboxModeFromEnv, MailboxHost } from "../src/extension/mailbox/host.ts";
import type { TeammateState } from "../src/shared/types.ts";
import { MailboxService } from "../src/extension/mailbox/service.ts";

const temporaryDirectories: string[] = [];
let baseDir: string;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((p) => rm(p, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 25,
  })));
});

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "mailbox-host-"));
  temporaryDirectories.push(baseDir);
});

function makeState(): TeammateState {
  return {
    baseCwd: "D:/test/project",
    currentSessionId: null,
    sessionGeneration: 1,
    activeRuns: new Map(),
    namedAgents: new Map(),
  };
}

function registerMailboxRecipient(state: TeammateState, correlationId: string): void {
  state.activeRuns.set(correlationId, {
    agent: "worker",
    correlationId,
    startedAt: Date.now(),
    abortController: new AbortController(),
    ownsChildProcess: true,
    inbox: [],
    outputLog: [],
    lastActivityAt: Date.now(),
    depth: 0,
    status: "running",
    runtimeGeneration: 1,
    sleepMs: 0,
    stdin: { writable: true },
    lease: { owner: "child", state: "active", epoch: 1, nonce: "owner-1" },
  } as never);
}

// --- Env parsing ---

test("mailboxModeFromEnv defaults to authoritative", () => {
  assert.equal(mailboxModeFromEnv({}), "authoritative");
  assert.equal(mailboxModeFromEnv({ PI_TEAMMATE_MAILBOX: undefined }), "authoritative");
});

test("mailboxModeFromEnv parses valid modes", () => {
  assert.equal(mailboxModeFromEnv({ PI_TEAMMATE_MAILBOX: "authoritative" }), "authoritative");
  assert.equal(mailboxModeFromEnv({ PI_TEAMMATE_MAILBOX: "shadow" }), "shadow");
  assert.equal(mailboxModeFromEnv({ PI_TEAMMATE_MAILBOX: "disabled" }), "disabled");
  assert.equal(mailboxModeFromEnv({ PI_TEAMMATE_MAILBOX: "AUTHORITATIVE" }), "authoritative");
});

test("mailboxModeFromEnv rejects unknown modes with authoritative fallback", () => {
  assert.equal(mailboxModeFromEnv({ PI_TEAMMATE_MAILBOX: "bogus" }), "authoritative");
});

// --- Authority adapter ---

test("createMailboxAuthority routes caller to any agent", () => {
  const state = makeState();
  const authority = createMailboxAuthority({ state, ownerId: "owner-1" });
  const result = authority.canRoute("caller", "corr-1", "follow_up");
  assert.equal(result.allowed, true);
});

test("createMailboxAuthority reports current generation from state", () => {
  const state = makeState();
  state.sessionGeneration = 42;
  const authority = createMailboxAuthority({ state, ownerId: "owner-1" });
  assert.equal(authority.currentGeneration(), 42);
});

test("createMailboxAuthority reads the recipient lease epoch and nonce at each boundary", () => {
  const state = makeState();
  const agent = {
    correlationId: "corr-lease",
    lease: { owner: "child", state: "active" as const, epoch: 7, nonce: "nonce-7" },
  };
  state.activeRuns.set(agent.correlationId, agent as never);
  const authority = createMailboxAuthority({ state, ownerId: "owner-fallback" });

  assert.equal(authority.currentLeaseEpoch(agent.correlationId), 7);
  assert.equal(authority.currentLeaseNonce(agent.correlationId), "nonce-7");

  agent.lease.epoch = 8;
  agent.lease.nonce = "nonce-8";
  assert.equal(authority.currentLeaseEpoch(agent.correlationId), 8);
  assert.equal(authority.currentLeaseNonce(agent.correlationId), "nonce-8");
  assert.equal(authority.currentLeaseEpoch("missing"), 1);
  assert.equal(authority.currentLeaseNonce("missing"), "owner-fallback");
});

test("createMailboxAuthority treats non-active lease as fenced", () => {
  const state = makeState();
  const agent = {
    correlationId: "corr-1",
    lease: { owner: "main", state: "parking" as const, epoch: 2, nonce: "n" },
  };
  state.activeRuns.set("corr-1", agent as never);
  const authority = createMailboxAuthority({ state, ownerId: "owner-1" });
  assert.equal(authority.isFenced("corr-1"), true);
});

test("createMailboxAuthority holds (fences) a live agent whose stdin is not wired yet", () => {
  const state = makeState();
  const agent = {
    correlationId: "corr-2",
    stdin: undefined,
    status: "running",
  };
  state.activeRuns.set("corr-2", agent as never);
  const authority = createMailboxAuthority({ state, ownerId: "owner-1" });
  // Transient spawn/restart window: hold, do not dead-letter.
  assert.equal(authority.isStaleUnauthorized("corr-2"), false);
  assert.equal(authority.isFenced("corr-2"), true);
});

test("createMailboxAuthority treats a settled agent as stale", () => {
  const state = makeState();
  const agent = {
    correlationId: "corr-3",
    stdin: undefined,
    status: "failed",
  };
  state.activeRuns.set("corr-3", agent as never);
  const authority = createMailboxAuthority({ state, ownerId: "owner-1" });
  assert.equal(authority.isStaleUnauthorized("corr-3"), true);
  assert.equal(authority.isFenced("corr-3"), false);
});

test("createMailboxAuthority managesRecipient reflects activeRuns membership", () => {
  const state = makeState();
  const authority = createMailboxAuthority({ state, ownerId: "owner-1" });
  assert.equal(authority.managesRecipient("corr-local"), false);
  registerMailboxRecipient(state, "corr-local");
  assert.equal(authority.managesRecipient("corr-local"), true);
});

// --- MailboxHost lifecycle ---

test("MailboxHost defaults to authoritative mode", async () => {
  const state = makeState();
  const host = new MailboxHost({
    rootDir: join(baseDir, "mb"),
    state,
    ownerId: "owner-1",
    workspaceId: "a".repeat(64),
    teamId: "team-root",
    inject: async () => {},
  });
  assert.equal(host.mode, "authoritative");
  assert.equal(host.rollout.mode, "authoritative");
  await new Promise((resolve) => setTimeout(resolve, 100)); // let service.start settle
  await host.stop();
});

test("MailboxHost disabled mode never starts consumer", async () => {
  const state = makeState();
  const host = new MailboxHost({
    rootDir: join(baseDir, "mb"),
    state,
    ownerId: "owner-1",
    workspaceId: "a".repeat(64),
    teamId: "team-root",
    inject: async () => {},
    mode: "disabled",
  });
  assert.equal(host.mode, "disabled");
  assert.equal(host.rollout.mode, "disabled");
  await host.stop();
});

test("MailboxHost shadow mode enqueues but does not consume", async () => {
  const state = makeState();
  const injected: string[] = [];
  const host = new MailboxHost({
    rootDir: join(baseDir, "mb"),
    state,
    ownerId: "owner-1",
    workspaceId: "a".repeat(64),
    teamId: "team-root",
    inject: async (e) => { injected.push(e.payload); },
    mode: "shadow",
    pollMs: 10,
  });
  await new Promise((resolve) => setTimeout(resolve, 50)); // let service start

  const result = await host.rollout.deliver({
    senderId: "caller",
    recipientId: "target",
    recipientCorrelationId: "corr-1",
    kind: "follow_up",
    mode: "follow_up",
    payload: "shadow message",
  });
  assert.equal(result.path, "shadow");

  // Direct inject happened (shadow delivers direct + writes v2)
  assert.equal(injected.length, 1);
  assert.equal(injected[0], "shadow message");

  await host.stop();
});

test("startup canonical/legacy conflict persistently rejects raced enqueue and consumer activation", async () => {
  const state = makeState();
  const rootDir = join(baseDir, "conflicted-mb");
  const canonicalWorkspaceId = "a".repeat(64);
  const legacyWorkspaceId = "b".repeat(64);
  const authority = createMailboxAuthority({ state, ownerId: "seed-owner" });
  const createSeeder = (workspaceId: string) => new MailboxService({
    rootDir,
    authority,
    recipientCorrelationId: "*",
    workspaceId,
    teamId: "team-root",
    ownerId: `seed-${workspaceId[0]}`,
    onDispatch: async () => {},
  });
  const canonical = createSeeder(canonicalWorkspaceId);
  const legacy = createSeeder(legacyWorkspaceId);
  await Promise.all([canonical.start(false), legacy.start(false)]);
  const seeded = await canonical.enqueue({
    senderId: "caller",
    recipientId: "target",
    recipientCorrelationId: "corr-1",
    kind: "follow_up",
    mode: "follow_up",
    payload: "pre-existing canonical state",
  });
  assert.ok(seeded.ok);
  const existing = await canonical.store.readEnvelope("ready", seeded.messageId);
  assert.ok(existing);
  await legacy.store.writeStaging(existing);
  await Promise.all([canonical.stop(), legacy.stop()]);

  const injected: string[] = [];
  const host = new MailboxHost({
    rootDir,
    state,
    ownerId: "owner-conflict",
    workspaceId: canonicalWorkspaceId,
    legacyWorkspaceIds: [legacyWorkspaceId],
    teamId: "team-root",
    inject: async (envelope) => { injected.push(envelope.payload); },
    mode: "authoritative",
    pollMs: 5,
  });
  try {
    const racedDelivery = host.rollout.deliver({
      senderId: "caller",
      recipientId: "target",
      recipientCorrelationId: "corr-1",
      kind: "follow_up",
      mode: "follow_up",
      payload: "must not be stranded",
    });
    await assert.rejects(racedDelivery, /Conflicting canonical and legacy mailbox state/);
    await assert.rejects(host.service.startConsumer(), /Conflicting canonical and legacy mailbox state/);
    await assert.rejects(host.service.enqueue({
      senderId: "caller",
      recipientId: "target",
      recipientCorrelationId: "corr-1",
      kind: "follow_up",
      mode: "follow_up",
      payload: "persistent retry must reject",
    }), /Conflicting canonical and legacy mailbox state/);
    assert.deepEqual(injected, []);
    assert.equal((await host.service.store.listMessages("ready")).length, 1);
  } finally {
    await host.stop();
  }
});

test("MailboxHost authoritative mode enqueues and consumer injects", async () => {
  const state = makeState();
  registerMailboxRecipient(state, "corr-1");
  const injected: string[] = [];
  const host = new MailboxHost({
    rootDir: join(baseDir, "mb"),
    state,
    ownerId: "owner-1",
    workspaceId: "a".repeat(64),
    teamId: "team-root",
    inject: async (e) => { injected.push(e.payload); },
    mode: "authoritative",
    pollMs: 10,
  });
  await new Promise((resolve) => setTimeout(resolve, 50)); // let service start

  const result = await host.rollout.deliver({
    senderId: "caller",
    recipientId: "target",
    recipientCorrelationId: "corr-1",
    kind: "follow_up",
    mode: "follow_up",
    payload: "authoritative message",
  });
  assert.equal(result.path, "v2");
  assert.ok(result.result.ok);

  // Consumer should inject via onDispatch → inject callback
  await new Promise((resolve) => setTimeout(resolve, 150));
  await host.stop();

  assert.equal(injected.length, 1);
  assert.equal(injected[0], "authoritative message");
});

test("MailboxHost authoritative consumer dispatch auto-applies", async () => {
  const state = makeState();
  registerMailboxRecipient(state, "corr-1");
  const host = new MailboxHost({
    rootDir: join(baseDir, "mb"),
    state,
    ownerId: "owner-1",
    workspaceId: "a".repeat(64),
    teamId: "team-root",
    inject: async () => {},
    mode: "authoritative",
    pollMs: 10,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const result = await host.rollout.deliver({
    senderId: "caller",
    recipientId: "target",
    recipientCorrelationId: "corr-1",
    kind: "follow_up",
    mode: "follow_up",
    payload: "ack test",
  });
  assert.ok(result.result.ok);

  // Wait for consumer dispatch → applied (poll until it appears or timeout)
  const messageId = (result.result as { messageId: string }).messageId;
  const deadline = Date.now() + 5000;
  let applied = await host.service.store.readEnvelope("applied", messageId);
  while (!applied && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    applied = await host.service.store.readEnvelope("applied", messageId);
  }
  assert.ok(applied, "message should be in applied state after dispatch");
  // Auto-ack means the message no longer lingers in accepted (quota leak fix).
  assert.equal(await host.service.store.readEnvelope("accepted", messageId), undefined);

  await host.stop();
});

// --- Stop is idempotent ---

test("MailboxHost stop is safe even without start", async () => {
  const state = makeState();
  const host = new MailboxHost({
    rootDir: join(baseDir, "mb"),
    state,
    ownerId: "owner-1",
    workspaceId: "a".repeat(64),
    teamId: "team-root",
    inject: async () => {},
    mode: "authoritative",
    pollMs: 10,
  });
  // Wait for the fire-and-forget service.start to settle before stopping.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await host.stop();
  await host.stop();
});
