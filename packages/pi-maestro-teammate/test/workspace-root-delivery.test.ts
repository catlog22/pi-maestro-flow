import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { WindowThreadStore, type WindowThreadEntry, type WindowThreadEntryInput } from "../src/sessions/session-core.ts";
import { WorkspaceRootDelivery, workspaceRootMessageMode, type WorkspaceRootDeliveryAuthority } from "../src/extension/workspace-root-delivery.ts";
import {
  WORKSPACE_MAIN_SESSION_MARKER, claimWorkspaceOwnerIdentity, commandMailboxPath,
  cleanupWorkspacePeerMailboxes, consumeWorkspacePeerCommands, createWorkspacePeerIdentity, enqueueWorkspacePeerCommand,
  ensureWorkspacePeerDirectories, finalizeWorkspacePeerResponse, readWorkspacePeerResponse,
  responseMailboxPath, shouldReplayWorkspaceRootQueue,
  type WorkspacePeerCommand, type WorkspacePeerCommandResponse, type WorkspaceResolvedTarget,
} from "../src/sessions/workspace-peer-core.ts";

const A = "a".repeat(32), B = "b".repeat(32), NA = "1".repeat(32), NB = "2".repeat(32), ID = "d".repeat(32);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "workspace-root-delivery-"));
  dirs.push(base);
  const cwd = join(base, "project"), rootDir = join(base, "runtime");
  await mkdir(cwd);
  const sender = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: A, ownerNonce: NA });
  const target = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: B, ownerNonce: NB });
  await ensureWorkspacePeerDirectories(sender);
  await ensureWorkspacePeerDirectories(target);
  const resolved: WorkspaceResolvedTarget = { scope: "remote", ownerId: B, ownerNonce: NB, state: "active",
    agent: { correlationId: WORKSPACE_MAIN_SESSION_MARKER, agent: "main", status: "running", startedAt: 1, lastActivityAt: 1, wakeable: true } };
  const journal: unknown[] = [], errors: unknown[] = [];
  let failPersistence = false;
  const incoming = new WindowThreadStore({ persist: (entry) => {
    if (failPersistence) throw new Error("journal IO failure");
    journal.push({ type: "custom", customType: "teammate-window-thread", data: entry });
  } });
  const outgoing = new WindowThreadStore();
  let authority: WorkspaceRootDeliveryAuthority | undefined = { key: "root-1:publisher-1", sessionId: "session-b", identity: target };
  const queued: Array<{ role: string; customType: string; details: Record<string, unknown> }> = [];
  const modes: string[] = [];
  const targetDelivery = new WorkspaceRootDelivery({ thread: () => incoming, authority: () => authority, sessionEntries: () => journal, onError: (error) => errors.push(error) });
  targetDelivery.bindSession(target.workspaceId, "session-b");
  const senderDelivery = new WorkspaceRootDelivery({ thread: () => outgoing,
    authority: () => ({ key: "sender-1", sessionId: "session-a", identity: sender }), onError: (error) => errors.push(error) });
  function input(command: WorkspacePeerCommand, direction: "incoming" | "outgoing", extra: Partial<WindowThreadEntryInput> = {}): WindowThreadEntryInput {
    return { messageId: command.commandId, workspaceId: command.workspaceId,
      peerOwnerId: direction === "incoming" ? command.fromOwnerId : command.toOwnerId,
      peerOwnerNonce: direction === "incoming" ? command.fromOwnerNonce : command.toOwnerNonce,
      localOwnerNonce: direction === "incoming" ? command.toOwnerNonce : command.fromOwnerNonce,
      direction, source: "monitor", messageKind: "coordination", targetCorrelationId: command.targetCorrelationId,
      targetSessionId: direction === "incoming" ? "session-b" : "session-a", mode: command.action, effectiveMode: command.action,
      body: command.message, status: "pending", createdAt: command.createdAt, updatedAt: command.createdAt, ...extra };
  }
  function message(entry: WindowThreadEntry, token: string) {
    return { role: "custom", customType: "teammate-message", details: { source: "workspace-peer", messageId: entry.messageId,
      fromOwnerId: entry.peerOwnerId, fromOwnerNonce: entry.peerOwnerNonce, localOwnerNonce: entry.localOwnerNonce,
      mode: workspaceRootMessageMode(entry), deliveryToken: token } };
  }
  function admit(entry: WindowThreadEntry, delivery = targetDelivery) {
    return delivery.enqueue(entry, (token, mode) => { modes.push(mode); queued.push(message(entry, token)); return true; });
  }
  async function publish(mode: "steer" | "follow_up" = "follow_up") {
    const command = await enqueueWorkspacePeerCommand(sender, resolved, mode, "inspect this workspace", { commandId: ID });
    outgoing.record(input(command, "outgoing"));
    return command;
  }
  async function accept(command: WorkspacePeerCommand, immediate = false) {
    await consumeWorkspacePeerCommands(target, () => {
      const entry = incoming.record(input(command, "incoming"));
      admit(entry);
      if (immediate) targetDelivery.consume(queued[0]);
      return { status: "accepted", effectiveAction: command.action, deliveryStage: "queued" };
    });
    await targetDelivery.reconcile();
    await senderDelivery.reconcile();
  }
  return { base, cwd, rootDir, sender, target, resolved, incoming, outgoing, journal, errors, queued, modes,
    targetDelivery, senderDelivery, input, message, admit, publish, accept,
    getAuthority: () => authority, rotate: (value: WorkspaceRootDeliveryAuthority | undefined) => { authority = value; },
    failPersistence: (value: boolean) => { failPersistence = value; } };
}

test("accepted busy root stays queued beyond 60s/10min, then consumes once and reconciles late receipt", async (t) => {
  const f = await fixture();
  const command = await f.publish();
  await f.accept(command);
  const initial = Date.now();
  let clock = initial;
  t.mock.method(Date, "now", () => clock);
  for (const elapsed of [61_000, 601_000, 3_600_000]) {
    clock = initial + elapsed;
    await f.targetDelivery.reconcile();
    await f.senderDelivery.reconcile();
    f.admit(f.incoming.get(ID, "incoming")!); // repeated replay/sweep attempts cannot admit twice
    assert.equal(f.incoming.get(ID, "incoming")?.status, "queued");
    assert.equal(f.outgoing.get(ID, "outgoing")?.status, "queued");
  }
  assert.equal(f.queued.length, 1);
  f.targetDelivery.consume(f.queued[0]);
  f.targetDelivery.consume(f.queued[0]);
  await f.targetDelivery.reconcile();
  await f.senderDelivery.reconcile();
  assert.equal(f.incoming.get(ID, "incoming")?.status, "injected");
  assert.equal(f.outgoing.get(ID, "outgoing")?.status, "injected");
  assert.equal(f.journal.filter((row: any) => row.data.status === "injected").length, 1);
  assert.equal(f.queued.length, 1);
  assert.deepEqual(f.errors, []);
});

test("exact accepted late receipt repairs legacy observational timeout, not expired/rejected evidence", async () => {
  const f = await fixture();
  const command = await f.publish();
  f.outgoing.transition(ID, "outgoing", "timeout", Date.now() + 601_000);
  await f.accept(command);
  assert.equal(f.outgoing.get(ID, "outgoing")?.status, "queued", "legacy wait timeout is observational");
  f.targetDelivery.consume(f.queued[0]);
  await f.targetDelivery.reconcile();
  await f.senderDelivery.reconcile();
  const response = (await readWorkspacePeerResponse(f.sender, ID))!;
  for (const status of ["expired", "rejected", "error"] as const) {
    const terminal = new WindowThreadStore();
    terminal.record(f.input(command, "outgoing", { status: status === "expired" ? "timeout" : "rejected", receiptStatus: status }));
    terminal.reconcileAcceptedReceipt(ID, response, f.sender);
    assert.equal(terminal.get(ID, "outgoing")?.receiptStatus, status);
    assert.equal(terminal.get(ID, "outgoing")?.status, status === "expired" ? "timeout" : "rejected");
  }
  assert.equal(f.outgoing.get(ID, "outgoing")?.status, "injected");
  assert.deepEqual(f.errors, []);
});

test("immediate consumption before response creation survives missing response, IO failure and duplicate callbacks", async () => {
  const f = await fixture();
  const command = await f.publish("steer");
  const entry = f.incoming.record(f.input(command, "incoming"));
  let failures = 1, finalizeAttempts = 0;
  const delivery = new WorkspaceRootDelivery({ thread: () => f.incoming, authority: f.getAuthority, onError: (error) => f.errors.push(error),
    finalize: async (...args) => { finalizeAttempts++; if (failures-- > 0) throw new Error("response IO failure"); return finalizeWorkspacePeerResponse(...args); } });
  delivery.enqueue(entry, (token) => { delivery.consume(f.message(entry, token)); return true; });
  await delivery.reconcile();
  assert.equal(f.incoming.get(ID, "incoming")?.status, "injected");
  assert.equal(await readWorkspacePeerResponse(f.sender, ID), undefined);
  // Receipt is written after the handler, the ordering that caused the original race.
  await consumeWorkspacePeerCommands(f.target, () => ({ status: "accepted", effectiveAction: "steer", deliveryStage: "queued" }));
  await delivery.reconcile();
  await f.senderDelivery.reconcile();
  assert.equal((await readWorkspacePeerResponse(f.sender, ID))?.deliveryStage, "injected");
  assert.equal(f.outgoing.get(ID, "outgoing")?.status, "injected");
  assert.equal(f.errors.length, 1);
  assert.match(String(f.errors[0]), /response IO failure/);
  const durableAttempts = finalizeAttempts;
  await delivery.reconcile();
  await delivery.reconcile();
  assert.equal(finalizeAttempts, durableAttempts, "durable finalization ends the retry loop");
});

test("restart recovers pending/queued once, keeps effective steer/follow_up, and never replays consumed work", async () => {
  for (const mode of ["steer", "follow_up"] as const) {
    const f = await fixture();
    const command = await f.publish(mode);
    await f.accept(command);
    const resumed = new WindowThreadStore();
    resumed.rebuild(f.journal);
    const delivery = new WorkspaceRootDelivery({ thread: () => resumed, authority: f.getAuthority, onError: (error) => f.errors.push(error) });
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const entry of resumed.list()) {
        if ((entry.status === "pending" || entry.status === "queued")
          && shouldReplayWorkspaceRootQueue("resume", entry.targetSessionId, "session-b")) f.admit(entry, delivery);
      }
    }
    assert.deepEqual(f.modes, [mode, mode], "one enqueue in each host incarnation, never a replay loop");
    delivery.consume(f.queued[1]);
    await delivery.reconcile();
    // Rebuild from persisted actual-consumption acknowledgment, not a queue marker.
    const afterConsumption = new WindowThreadStore();
    afterConsumption.rebuild([...f.journal, { type: "custom", customType: "teammate-window-thread", data: resumed.get(ID, "incoming") }]);
    assert.equal(afterConsumption.get(ID, "incoming")?.status, "injected");
    assert.equal(afterConsumption.list().filter((entry) => entry.status === "queued").length, 0);
    assert.equal(shouldReplayWorkspaceRootQueue("reload", "session-b", "session-b"), false);
    assert.equal(shouldReplayWorkspaceRootQueue("fork", "session-b", "other-session"), false);
  }
});

test("recipient/root generation rotation fences stale consumption and enqueue; sender rotation fences postawait receipt", async () => {
  const f = await fixture();
  const command = await f.publish();
  await f.accept(command);
  f.rotate({ ...f.getAuthority()!, key: "root-2:publisher-2" });
  f.targetDelivery.consume(f.queued[0]);
  await f.targetDelivery.reconcile();
  assert.equal(f.incoming.get(ID, "incoming")?.status, "queued");
  f.admit(f.incoming.get(ID, "incoming")!);
  assert.equal(f.queued.length, 1);
  f.rotate({ ...f.getAuthority()!, sessionId: "other-session" });
  assert.equal(f.admit(f.incoming.get(ID, "incoming")!), false);
  let resolve!: (receipt: WorkspacePeerCommandResponse) => void;
  let authority = { key: "sender-1", sessionId: "session-a", identity: f.sender };
  const senderDelivery = new WorkspaceRootDelivery({ thread: () => f.outgoing, authority: () => authority, onError: (error) => f.errors.push(error),
    readResponse: () => new Promise((done) => { resolve = done; }) });
  const work = senderDelivery.reconcile();
  authority = { ...authority, key: "sender-2" };
  resolve({ ...(await readWorkspacePeerResponse(f.sender, ID))!, deliveryStage: "injected" });
  await work;
  assert.equal(f.outgoing.get(ID, "outgoing")?.status, "queued");
});

test("exact incarnation receipts only: wrong peer/local nonces and targets cannot repair timeout", async () => {
  const f = await fixture();
  const command = await f.publish();
  await f.accept(command);
  f.targetDelivery.consume(f.queued[0]);
  await f.targetDelivery.reconcile();
  const receipt = (await readWorkspacePeerResponse(f.sender, ID))!;
  for (const replacement of [{ fromOwnerNonce: "9".repeat(32) }, { toOwnerNonce: "9".repeat(32) },
    { fromOwnerId: A }, { toOwnerId: B }, { workspaceId: "9".repeat(64) }, { targetCorrelationId: "other-target" }]) {
    const thread = new WindowThreadStore();
    thread.record(f.input(command, "outgoing", { status: "timeout" }));
    thread.reconcileAcceptedReceipt(ID, { ...receipt, ...replacement }, f.sender);
    assert.equal(thread.get(ID, "outgoing")?.status, "timeout");
  }
});

test("actual-consumption journal failure retries, and persisted custom evidence repairs crash without replay", async () => {
  const f = await fixture();
  const command = await f.publish();
  await f.accept(command);
  f.failPersistence(true);
  f.targetDelivery.consume(f.queued[0]);
  await f.targetDelivery.reconcile();
  assert.equal(f.incoming.get(ID, "incoming")?.status, "queued");
  assert.equal((await readWorkspacePeerResponse(f.sender, ID))?.deliveryStage, "queued");
  const crashJournal = [...f.journal, { type: "custom_message", customType: "teammate-message", details: f.queued[0].details }];
  for (const replacement of [{ fromOwnerId: B }, { fromOwnerNonce: "9".repeat(32) }, { localOwnerNonce: "9".repeat(32) }]) {
    const stale = new WindowThreadStore();
    stale.rebuild([...f.journal, { type: "custom_message", customType: "teammate-message", details: { ...f.queued[0].details, ...replacement } }]);
    assert.equal(stale.get(ID, "incoming")?.status, "queued", "foreign incarnation custom evidence cannot acknowledge consumption");
  }
  const recovered = new WindowThreadStore();
  recovered.rebuild(crashJournal);
  assert.equal(recovered.get(ID, "incoming")?.status, "injected");
  f.failPersistence(false);
  await f.targetDelivery.reconcile();
  await f.senderDelivery.reconcile();
  assert.equal(f.incoming.get(ID, "incoming")?.status, "injected");
  assert.equal(f.outgoing.get(ID, "outgoing")?.status, "injected");
  const durableAckOnly = new WindowThreadStore();
  durableAckOnly.rebuild(f.journal);
  assert.equal(durableAckOnly.get(ID, "incoming")?.status, "injected");
  assert.ok(f.errors.length >= 1);
});

test("crash before initial response commit retains processing command and reconstructs only exact durable consumption", async () => {
  const f = await fixture();
  const claim = await claimWorkspaceOwnerIdentity(f.cwd, { rootDir: f.rootDir, sessionKey: "recover-session", generation: 1 });
  const identity = claim.identity;
  const target = { ...f.resolved, ownerId: identity.ownerId, ownerNonce: identity.ownerNonce };
  await ensureWorkspacePeerDirectories(identity);
  const command = await enqueueWorkspacePeerCommand(f.sender, target, "steer", "crash after consumption", { commandId: ID });
  const entry = f.incoming.record(f.input(command, "incoming"));
  f.incoming.reconcileInjected(ID, Date.now(), "steer");
  const mailbox = responseMailboxPath(identity, A);
  await assert.rejects(consumeWorkspacePeerCommands(identity, async () => {
    await rm(mailbox, { recursive: true, force: true });
    await writeFile(mailbox, "block response persistence");
    return { status: "accepted", effectiveAction: "steer", deliveryStage: "queued" };
  }));
  assert.ok(await readFile(join(commandMailboxPath(identity, identity.ownerId), `${ID}.${identity.ownerNonce}.processing`), "utf8"));
  await rm(mailbox);
  await mkdir(mailbox);
  await claim.release();
  const restarted = await claimWorkspaceOwnerIdentity(f.cwd, { rootDir: f.rootDir, sessionKey: "recover-session", generation: 2 });
  try {
    const thread = new WindowThreadStore();
    thread.rebuild(f.journal);
    const delivery = new WorkspaceRootDelivery({ thread: () => thread,
      authority: () => ({ key: "restart-2", sessionId: "session-b", identity: restarted.identity }), onError: (error) => f.errors.push(error) });
    assert.notEqual(restarted.identity.ownerNonce, entry.localOwnerNonce);
    const result = await consumeWorkspacePeerCommands(restarted.identity, () => { throw new Error("must not deliver twice"); },
      { recoverDelivery: (value) => delivery.recoveryReceipt(value) });
    assert.equal(result[0]?.response.status, "accepted");
    assert.equal(result[0]?.response.deliveryStage, "injected");
    assert.equal(result[0]?.response.fromOwnerNonce, identity.ownerNonce, "original incarnation binding survives recovery");
    assert.equal(delivery.recoveryReceipt({ ...command, fromOwnerNonce: "9".repeat(32) }), undefined);
    assert.equal(delivery.recoveryReceipt({ ...command, toOwnerNonce: "9".repeat(32) }), undefined);
    assert.equal(delivery.recoveryReceipt({ ...command, message: "different body" }), undefined);
  } finally { await restarted.release(); }
});

test("receipt finalization cannot overwrite newer replied or a mismatched incarnation", async () => {
  const f = await fixture();
  const command = await f.publish();
  await f.accept(command);
  await finalizeWorkspacePeerResponse(f.target, A, ID, "replied");
  f.targetDelivery.consume(f.queued[0]);
  await f.targetDelivery.reconcile();
  assert.equal((await readWorkspacePeerResponse(f.sender, ID))?.deliveryStage, "replied");
  assert.equal(await finalizeWorkspacePeerResponse({ ...f.target, ownerNonce: "9".repeat(32) }, A, ID, "injected"), false);
  assert.equal(await finalizeWorkspacePeerResponse(f.target, A, ID, "replied", { senderOwnerNonce: "9".repeat(32) }), false);
});

test("installed SDK custom followUp/steer queue and idle custom prompt drive actual message_end acknowledgments", async () => {
  for (const mode of ["follow_up", "steer"] as const) {
    const f = await fixture();
    const command = await f.publish(mode);
    const entry = f.incoming.record(f.input(command, "incoming"));
    const firstStream = createAssistantMessageEventStream();
    let first = true;
    const assistant: any = { role: "assistant", content: [{ type: "text", text: "done" }], api: "test", provider: "test", model: "test",
      stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const agent = new Agent({ streamFn: () => {
      if (first) { first = false; return firstStream; }
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: assistant });
      return stream;
    } });
    const seen: unknown[] = [];
    agent.subscribe((event) => { if (event.type === "message_end" && event.message.role === "custom") {
      seen.push(event.message); f.targetDelivery.consume(event.message);
    } });
    // Execute the installed SDK's actual ingestion method with a narrow host
    // fixture; Agent itself performs queue draining and emits real message_end.
    const host: any = { agent, isStreaming: true, _runAgentPrompt: (messages: any) => agent.prompt(messages) };
    const turn = agent.prompt("busy target");
    while (first) await new Promise((done) => setImmediate(done));
    f.targetDelivery.enqueue(entry, (token) => {
      const message = f.message(entry, token);
      void AgentSession.prototype.sendCustomMessage.call(host, { customType: message.customType, content: "workspace message", display: true, details: message.details },
        { triggerTurn: true, deliverAs: mode === "steer" ? "steer" : "followUp" });
      return true;
    });
    await f.targetDelivery.reconcile();
    assert.equal(f.incoming.get(ID, "incoming")?.status, "queued");
    assert.equal(seen.length, 0, "queue acceptance and before-agent hooks cannot prove consumption");
    firstStream.push({ type: "done", reason: "stop", message: assistant });
    await turn;
    assert.equal(seen.length, 1);
    await consumeWorkspacePeerCommands(f.target, () => ({ status: "accepted", effectiveAction: mode, deliveryStage: "queued" }));
    await f.targetDelivery.reconcile();
    await f.senderDelivery.reconcile();
    assert.equal(f.outgoing.get(ID, "outgoing")?.status, "injected");
    // The SDK's idle triggerTurn path also emits consumption via the agent loop,
    // without relying on the extension's before_agent_start injection hook.
    const idleId = "e".repeat(32);
    const idle = f.incoming.record({ ...f.input(command, "incoming"), messageId: idleId });
    host.isStreaming = false;
    let idleRun!: Promise<void>;
    f.targetDelivery.enqueue(idle, (token) => {
      const message = f.message(idle, token);
      idleRun = AgentSession.prototype.sendCustomMessage.call(host, { customType: message.customType, content: "idle workspace message", display: true, details: message.details }, { triggerTurn: true });
      return true;
    });
    await idleRun;
    await f.targetDelivery.reconcile();
    assert.equal(f.incoming.get(idleId, "incoming")?.status, "injected");
    assert.equal(seen.length, 2);
    assert.deepEqual(f.errors, []);
  }
});


test("installed SDK context-only queued custom message acknowledges only after durable append (no extension message_end)", async () => {
  const f = await fixture();
  const command = await f.publish();
  const entry = f.incoming.record(f.input(command, "incoming", { messageKind: "status" }));
  const host: any = { isStreaming: true, _pendingCustomMessages: [], _refreshFinalizedContext() {}, _emit() {},
    _appendCustomMessage: (AgentSession.prototype as any)._appendCustomMessage,
    sessionManager: { appendCustomMessageEntry(customType: string, _content: unknown, _display: boolean, details: unknown) {
      f.journal.push({ type: "custom_message", customType, details });
    } } };
  f.targetDelivery.enqueue(entry, (token) => {
    const message = f.message(entry, token);
    void AgentSession.prototype.sendCustomMessage.call(host, { customType: message.customType, content: "status context", display: true, details: message.details },
      { triggerTurn: false, deliverAs: "followUp" });
    return true;
  });
  await consumeWorkspacePeerCommands(f.target, () => ({ status: "accepted", effectiveAction: "follow_up", deliveryStage: "queued" }));
  await f.targetDelivery.reconcile();
  assert.equal(f.incoming.get(ID, "incoming")?.status, "queued");
  (AgentSession.prototype as any)._flushPendingCustomMessages.call(host);
  await f.targetDelivery.reconcile();
  await f.senderDelivery.reconcile();
  assert.equal(f.incoming.get(ID, "incoming")?.status, "injected");
  assert.equal(f.outgoing.get(ID, "outgoing")?.status, "injected");
  assert.deepEqual(f.errors, []);
});

test("actual session replacement recovers once, but repeated same-session binds cannot duplicate a busy queue", async () => {
  const f = await fixture();
  const command = await f.publish("steer");
  await f.accept(command);
  f.targetDelivery.bindSession(f.target.workspaceId, "session-b");
  f.admit(f.incoming.get(ID, "incoming")!);
  assert.equal(f.queued.length, 1);
  // The host replaced the active session (and its queue), then resumed this one.
  f.targetDelivery.bindSession(f.target.workspaceId, "other-session");
  f.rotate({ ...f.getAuthority()!, key: "session-recovery-2" });
  f.targetDelivery.bindSession(f.target.workspaceId, "session-b");
  for (let i = 0; i < 3; i++) f.admit(f.incoming.get(ID, "incoming")!);
  assert.equal(f.queued.length, 2);
  assert.deepEqual(f.modes, ["steer", "steer"]);
  f.targetDelivery.consume(f.queued[0]); // prior incarnation token is not valid
  assert.equal(f.incoming.get(ID, "incoming")?.status, "queued");
  f.targetDelivery.consume(f.queued[1]);
  await f.targetDelivery.reconcile();
  assert.equal(f.incoming.get(ID, "incoming")?.status, "injected");
});

test("finalization checks postawait root authority at the atomic rename boundary", async () => {
  const f = await fixture();
  const command = await f.publish();
  await f.accept(command);
  f.incoming.reconcileInjected(ID, Date.now(), "follow_up");
  const delivery = new WorkspaceRootDelivery({ thread: () => f.incoming, authority: f.getAuthority, onError: (error) => f.errors.push(error),
    finalize: async (...args) => {
      f.rotate({ ...f.getAuthority()!, key: "root-rotated-after-capture" });
      return finalizeWorkspacePeerResponse(...args);
    } });
  await delivery.reconcile();
  assert.equal((await readWorkspacePeerResponse(f.sender, ID))?.deliveryStage, "queued");
  assert.equal(f.errors.length, 1);
  assert.match(String(f.errors[0]), /authority changed/);
});


test("restart recovers durable pending work once and sender restart reads its original-incarnation late receipt", async () => {
  const f = await fixture();
  const command = await f.publish("steer");
  f.incoming.record(f.input(command, "incoming")); // crash before initial host admission
  const resumed = new WindowThreadStore();
  resumed.rebuild(f.journal);
  const delivery = new WorkspaceRootDelivery({ thread: () => resumed, authority: f.getAuthority, onError: (error) => f.errors.push(error) });
  for (let i = 0; i < 3; i++) f.admit(resumed.get(ID, "incoming")!, delivery);
  assert.deepEqual(f.modes, ["steer"]);
  assert.equal(resumed.get(ID, "incoming")?.status, "queued");
  await consumeWorkspacePeerCommands(f.target, () => ({ status: "accepted", effectiveAction: "steer", deliveryStage: "queued" }));
  delivery.consume(f.queued[0]);
  await delivery.reconcile();
  const senderRestart = createWorkspacePeerIdentity(f.cwd, { rootDir: f.rootDir, ownerId: A, ownerNonce: "9".repeat(32) });
  const restartedSender = new WorkspaceRootDelivery({ thread: () => f.outgoing,
    authority: () => ({ key: "sender-restarted", sessionId: "session-a", identity: senderRestart }), onError: (error) => f.errors.push(error) });
  await restartedSender.reconcile();
  assert.equal(f.outgoing.get(ID, "outgoing")?.status, "injected");
  assert.equal(f.outgoing.get(ID, "outgoing")?.localOwnerNonce, NA, "receipt binding is never rewritten to the new publisher nonce");
  assert.deepEqual(f.errors, []);
});


test("deferred steer recovery preserves effective follow_up, not the originally requested mode", async () => {
  const f = await fixture();
  const command = await f.publish("steer");
  const entry = f.incoming.record(f.input(command, "incoming", { effectiveMode: "follow_up" }));
  f.admit(entry);
  const resumed = new WindowThreadStore();
  resumed.rebuild(f.journal);
  const delivery = new WorkspaceRootDelivery({ thread: () => resumed, authority: f.getAuthority, onError: (error) => f.errors.push(error) });
  f.admit(resumed.get(ID, "incoming")!, delivery);
  assert.deepEqual(f.modes, ["follow_up", "follow_up"]);
  assert.equal(resumed.get(ID, "incoming")?.mode, "steer");
  assert.equal(resumed.get(ID, "incoming")?.effectiveMode, "follow_up");
});

function legacyJournal(rows: readonly unknown[]): unknown[] {
  return rows.map((row: any) => {
    const { localOwnerNonce: _nonce, receiptStatus: _receipt, contentRevision: _hash, ...data } = row.data;
    return { ...row, data };
  });
}

test("legacy no-nonce incoming/outgoing restart migrates matching old receipt durably and preserves provenance/mode", async () => {
  const f = await fixture();
  const command = await f.publish("steer");
  f.incoming.record(f.input(command, "incoming", { effectiveMode: "follow_up", traceId: "legacy-trace" }));
  await consumeWorkspacePeerCommands(f.target, () => ({ status: "accepted", effectiveAction: "follow_up", deliveryStage: "queued" }));
  const journal = legacyJournal(f.journal);
  const incoming = new WindowThreadStore({ persist: (data) => journal.push({ type: "custom", customType: "teammate-window-thread", data }) });
  incoming.rebuild(journal);
  const targetRestart = { ...f.target, ownerNonce: "8".repeat(32) };
  const delivery = new WorkspaceRootDelivery({ thread: () => incoming,
    authority: () => ({ key: "restart", sessionId: "session-b", identity: targetRestart }), onError: (error) => f.errors.push(error) });
  const legacy = incoming.get(ID, "incoming")!;
  f.admit(legacy, delivery); // already admitted before asynchronous binding migration
  await delivery.reconcile();
  assert.equal(incoming.get(ID, "incoming")?.localOwnerNonce, NB);
  delivery.consume(f.queued[0]);
  await delivery.reconcile();
  const response = (await readWorkspacePeerResponse(f.sender, ID))!;
  assert.equal(response.fromOwnerNonce, NB);
  assert.equal(response.deliveryStage, "injected");
  assert.equal(response.effectiveAction, "follow_up");
  const outgoingJournal: unknown[] = [];
  const outgoing = new WindowThreadStore({ persist: (data) => outgoingJournal.push({ type: "custom", customType: "teammate-window-thread", data }) });
  outgoing.record(f.input(command, "outgoing", { localOwnerNonce: undefined, status: "timeout", effectiveMode: "follow_up" }));
  const senderRestart = { ...f.sender, ownerNonce: "9".repeat(32) };
  await new WorkspaceRootDelivery({ thread: () => outgoing,
    authority: () => ({ key: "sender-restart", sessionId: "session-a", identity: senderRestart }), onError: (error) => f.errors.push(error) }).reconcile();
  const reread = new WindowThreadStore();
  reread.rebuild(outgoingJournal);
  assert.equal(reread.get(ID, "outgoing")?.localOwnerNonce, NA);
  assert.equal(reread.get(ID, "outgoing")?.status, "injected");
  reread.rebuild(journal);
  assert.equal(reread.get(ID, "incoming")?.localOwnerNonce, NB);
  assert.equal(reread.get(ID, "incoming")?.mode, "steer");
  assert.equal(reread.get(ID, "incoming")?.effectiveMode, "follow_up");
  assert.equal(reread.get(ID, "incoming")?.source, "monitor");
  assert.equal(reread.get(ID, "incoming")?.messageKind, "coordination");
  assert.equal(reread.get(ID, "incoming")?.traceId, "legacy-trace");
  assert.deepEqual(f.errors, []);
});

test("legacy no-nonce original processing command migrates only exact evidence and survives another restart", async () => {
  const f = await fixture();
  const command = await f.publish();
  f.incoming.record(f.input(command, "incoming", { localOwnerNonce: undefined, status: "queued" }));
  for (const replacement of [{ fromOwnerNonce: "9".repeat(32) }, { message: "wrong" }, { createdAt: command.createdAt + 1 }]) {
    assert.equal(f.targetDelivery.recoveryReceipt({ ...command, ...replacement }), undefined);
    assert.equal(f.incoming.get(ID, "incoming")?.localOwnerNonce, undefined);
  }
  assert.equal(f.targetDelivery.recoveryReceipt(command)?.deliveryStage, "queued");
  const restarted = new WindowThreadStore();
  restarted.rebuild(f.journal);
  assert.equal(restarted.get(ID, "incoming")?.localOwnerNonce, NB);
  assert.equal(f.targetDelivery.recoveryReceipt({ ...command, toOwnerNonce: "9".repeat(32) }), undefined);
});

test("legacy no-nonce absent or mismatching receipt fails closed without inventing current binding", async () => {
  const f = await fixture();
  const command = await f.publish();
  f.incoming.record(f.input(command, "incoming", { localOwnerNonce: undefined, status: "injected" }));
  f.outgoing.record(f.input(command, "outgoing", { localOwnerNonce: undefined }));
  await f.targetDelivery.reconcile();
  await f.senderDelivery.reconcile();
  assert.equal(f.incoming.get(ID, "incoming")?.localOwnerNonce, undefined);
  assert.equal(f.outgoing.get(ID, "outgoing")?.localOwnerNonce, undefined);
  assert.equal(await readWorkspacePeerResponse(f.sender, ID), undefined);
  await consumeWorkspacePeerCommands(f.target, () => ({ status: "accepted", deliveryStage: "queued" }));
  const path = join(responseMailboxPath(f.sender, A), `${ID}.json`);
  const receipt = (await readWorkspacePeerResponse(f.sender, ID))!;
  await writeFile(path, JSON.stringify({ ...receipt, toOwnerNonce: "9".repeat(32), fromOwnerNonce: "8".repeat(32) }));
  await f.targetDelivery.reconcile();
  await f.senderDelivery.reconcile();
  assert.equal(f.incoming.get(ID, "incoming")?.localOwnerNonce, undefined);
  assert.equal(f.outgoing.get(ID, "outgoing")?.localOwnerNonce, undefined);
});

test("accepted busy root receipt survives 24h cleanup and expires only after actual consumption", async (t) => {
  const f = await fixture();
  const command = await f.publish();
  await f.accept(command);
  const now = Date.now() + 25 * 60 * 60_000;
  t.mock.method(Date, "now", () => now);
  assert.equal(await cleanupWorkspacePeerMailboxes(f.sender, { now }), 0);
  assert.equal((await readWorkspacePeerResponse(f.sender, ID))?.deliveryStage, "queued");
  f.admit(f.incoming.get(ID, "incoming")!);
  assert.equal(f.queued.length, 1);
  f.targetDelivery.consume(f.queued[0]);
  await f.targetDelivery.reconcile();
  await f.senderDelivery.reconcile();
  assert.equal(f.outgoing.get(ID, "outgoing")?.status, "injected");
  assert.equal(await cleanupWorkspacePeerMailboxes(f.sender, { now: now + 25 * 60 * 60_000 }), 1);
  assert.equal(await readWorkspacePeerResponse(f.sender, ID), undefined);
});

test("missing aged accepted receipt reconstructs only after token consumption or durable ack with original identity", async (t) => {
  for (const durable of [false, true]) {
    const f = await fixture();
    const command = await f.publish("steer");
    await f.accept(command);
    const now = Date.now() + 25 * 60 * 60_000;
    t.mock.method(Date, "now", () => now);
    await rm(join(responseMailboxPath(f.sender, A), `${ID}.json`));
    await f.targetDelivery.reconcile();
    assert.equal(await readWorkspacePeerResponse(f.sender, ID), undefined, "queued acceptance cannot reconstruct");
    if (durable) {
      const thread = new WindowThreadStore();
      thread.rebuild([...f.journal, { type: "custom_message", customType: "teammate-message", details: f.queued[0].details }]);
      assert.equal(thread.get(ID, "incoming")?.status, "injected");
      await new WorkspaceRootDelivery({ thread: () => thread,
        authority: () => ({ key: "recovered-ack", sessionId: "session-b", identity: { ...f.target, ownerNonce: "9".repeat(32) } }),
        onError: (error) => f.errors.push(error) }).reconcile();
    } else {
      f.targetDelivery.consume(f.queued[0]);
      await f.targetDelivery.reconcile();
    }
    await f.senderDelivery.reconcile();
    const receipt = (await readWorkspacePeerResponse(f.sender, ID))!;
    assert.equal(receipt.fromOwnerNonce, NB);
    assert.equal(receipt.toOwnerNonce, NA);
    assert.equal(receipt.deliveryStage, "injected");
    assert.equal(receipt.effectiveAction, "steer");
    assert.equal(f.outgoing.get(ID, "outgoing")?.status, "injected");
    assert.deepEqual(f.errors, []);
  }
});

test("reconstruction never resurrects terminal/malformed receipts or unfenced/no-accepted evidence", async () => {
  for (const status of ["rejected", "expired", "error", "malformed", "unproved", "mismatch"] as const) {
    const f = await fixture();
    const command = await f.publish();
    await f.accept(command);
    const path = join(responseMailboxPath(f.sender, A), `${ID}.json`);
    const receipt = (await readWorkspacePeerResponse(f.sender, ID))!;
    if (status === "unproved") {
      const thread = new WindowThreadStore();
      thread.record(f.input(command, "incoming", { status: "injected" }));
      await rm(path);
      await new WorkspaceRootDelivery({ thread: () => thread, authority: f.getAuthority, onError: (error) => f.errors.push(error) }).reconcile();
      assert.equal(await readWorkspacePeerResponse(f.sender, ID), undefined);
      continue;
    }
    const raw = status === "malformed" ? "{}" : JSON.stringify(status === "mismatch"
      ? { ...receipt, fromOwnerNonce: "9".repeat(32) } : { ...receipt, status });
    await writeFile(path, raw);
    f.targetDelivery.consume(f.queued[0]);
    await f.targetDelivery.reconcile();
    assert.equal(await readFile(path, "utf8"), raw);
    if (status === "rejected" || status === "expired" || status === "error") {
      assert.equal(f.incoming.get(ID, "incoming")?.receiptStatus, status);
      await rm(path); // terminal retention cleanup must not resurrect an accepted receipt
      const thread = new WindowThreadStore();
      thread.rebuild(f.journal);
      await new WorkspaceRootDelivery({ thread: () => thread, authority: f.getAuthority, onError: (error) => f.errors.push(error) }).reconcile();
      assert.equal(await readWorkspacePeerResponse(f.sender, ID), undefined);
    }
  }
});

test("missing receipt reconstruction retains atomic root-generation fencing", async () => {
  const f = await fixture();
  const command = await f.publish();
  await f.accept(command);
  f.incoming.reconcileInjected(ID);
  await rm(join(responseMailboxPath(f.sender, A), `${ID}.json`));
  const delivery = new WorkspaceRootDelivery({ thread: () => f.incoming, authority: f.getAuthority,
    onError: (error) => f.errors.push(error), finalize: async (...args) => {
      f.rotate({ ...f.getAuthority()!, key: "new-generation" });
      return finalizeWorkspacePeerResponse(...args);
    } });
  await delivery.reconcile();
  assert.equal(await readWorkspacePeerResponse(f.sender, ID), undefined);
  assert.equal(f.errors.length, 1);
  assert.match(String(f.errors[0]), /authority changed/);
});
