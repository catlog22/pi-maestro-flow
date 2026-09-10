import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunTeammateOptions, RunTeammateParams } from "pi-maestro-teammate/v1/execution";
import type { SingleResult } from "pi-maestro-teammate/v1/types";
import { hashGatewayOperationPayload } from "../src/gateway/operation-contracts.ts";
import {
  GatewayOperationReceiptCapacityError,
  GatewayOperationReceiptConflictError,
  GatewayOperationReceiptStore,
} from "../src/gateway/operation-receipt-store.ts";
import { createGatewayPrincipal, principalKey } from "../src/gateway/principal.ts";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import type { GatewayTeammatePort } from "../src/gateway/services/teammate-service.ts";
import { TaskJournal } from "../src/gateway/task-journal.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";

const key = {
  principalId: "stdio:owner",
  workspaceId: "workspace",
  sessionId: "session",
  memberId: "owner",
  memberGeneration: 1,
  tool: "session" as const,
  action: "start-pi" as const,
  operationId: "operation-1",
};

class BlockingPort implements GatewayTeammatePort {
  runs = 0;
  sends = 0;
  resolve?: (value: SingleResult[]) => void;
  runTeammate(_params: RunTeammateParams, options: RunTeammateOptions): Promise<SingleResult[]> {
    this.runs += 1;
    options.onChildSpawned?.({} as never, () => true, undefined, options.taskCorrelationIds?.[0] ?? "child", 1);
    return new Promise((resolve) => { this.resolve = resolve; });
  }
  send(): boolean { this.sends += 1; return true; }
}

async function session(runtime: GatewayRuntime, root: string) {
  const owner = createGatewayPrincipal("stdio", "owner", { authenticated: true });
  const created = await runtime.call("session", { action: "create", sessionId: "session", workspacePath: root, ownerId: "owner", expectedSessionRevision: 0, operationId: "create" }, owner);
  assert.equal(created.ok, true);
  return owner;
}

async function eventually(check: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) { if (check()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  assert.fail("condition did not become true");
}

test("canonical receipts bind payloads without persisting prompt or transport requestId", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-receipt-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new GatewayOperationReceiptStore({ root, maxReceipts: 2, now: () => 10 });
  const payloadHash = hashGatewayOperationPayload({ prompt: "TOP SECRET", agent: "general", requestId: "transport-a" });
  assert.equal(payloadHash, hashGatewayOperationPayload({ requestId: "transport-b", agent: "general", prompt: "TOP SECRET" }));
  const first = await store.prepare({ ...key, payloadHash });
  const duplicate = await store.prepare({ ...key, payloadHash });
  assert.equal(first.created, true); assert.equal(duplicate.created, false); assert.deepEqual(duplicate.receipt, first.receipt);
  await assert.rejects(() => store.prepare({ ...key, payloadHash: hashGatewayOperationPayload({ prompt: "different" }) }), GatewayOperationReceiptConflictError);
  const dispatching = await store.markDispatching(first.receipt);
  const accepted = await store.markAccepted(dispatching, { ok: true, status: "accepted", data: { taskId: "task-1", monitorHandle: "task-1" } });
  const terminal = await store.markTerminal(accepted);
  assert.equal(terminal.state, "terminal");
  const raw = await readFile(store.receiptPath(first.receipt.id), "utf8");
  assert.doesNotMatch(raw, /TOP SECRET|transport-a|transport-b/);
  assert.equal((await store.list(0, 1)).hasMore, false);
});

test("capacity is reserved before dispatch and interrupted dispatch becomes outcome-unknown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-receipt-capacity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new GatewayOperationReceiptStore({ root, maxReceipts: 1 });
  const prepared = await store.prepare({ ...key, payloadHash: hashGatewayOperationPayload({ prompt: "one" }) });
  await assert.rejects(() => store.prepare({ ...key, operationId: "operation-2", payloadHash: hashGatewayOperationPayload({ prompt: "two" }) }), GatewayOperationReceiptCapacityError);
  await store.markDispatching(prepared.receipt);
  const recovered = await store.recoverInterrupted();
  assert.equal(recovered[0]?.state, "outcome-unknown");
  await assert.rejects(() => store.markDispatching(recovered[0]!), /outcome-unknown/);
});

test("receipt capacity failure happens before start-pi side effects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-receipt-before-effect-"));
  const store = new GatewayOperationReceiptStore({ root: join(root, "state", "operation-receipts"), maxReceipts: 1 });
  const port = new BlockingPort();
  const runtime = await GatewayRuntime.create({ config: createTestGatewayConfig(root, { mode: "bearer", token: "secret" }), cwd: root, teammatePort: port, operationReceiptStore: store });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const owner = await session(runtime, root);
  const state = await runtime.sessionStore.require("session");
  await store.prepare({ ...key, principalId: principalKey(owner), workspaceId: state.session.workspaceId, tool: "monitor", action: "cancel", operationId: "reserved", payloadHash: hashGatewayOperationPayload({ handle: "unused", reason: "reserved" }) });
  const result = await runtime.call("session", { action: "start-pi", sessionId: "session", memberId: "owner", operationId: "blocked", prompt: "must not dispatch" }, owner);
  assert.equal(result.error?.code, "operation_receipt_capacity");
  assert.equal(port.runs, 0);
});

test("start-pi and monitor mutations are single-flight, replayable, and conflict on changed behavior", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-receipt-runtime-"));
  const port = new BlockingPort();
  const runtime = await GatewayRuntime.create({ config: createTestGatewayConfig(root, { mode: "bearer", token: "secret" }), cwd: root, teammatePort: port });
  t.after(async () => { port.resolve?.([]); await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const owner = await session(runtime, root);
  const launch = { action: "start-pi", sessionId: "session", memberId: "owner", operationId: "launch", prompt: "private launch prompt" };
  const [left, right] = await Promise.all([runtime.call("session", launch, owner), runtime.call("session", { ...launch, requestId: "other-transport" }, owner)]);
  assert.equal(left.ok, true); assert.equal(right.ok, true); assert.equal(port.runs, 1);
  assert.deepEqual((left.data as { receipt: unknown }).receipt, (right.data as { receipt: unknown }).receipt);
  const handle = (left.data as { taskId: string }).taskId;
  await eventually(() => port.runs === 1);
  const conflict = await runtime.call("session", { ...launch, prompt: "changed prompt" }, owner);
  assert.equal(conflict.error?.code, "operation_receipt_conflict"); assert.equal(port.runs, 1);

  const message = { action: "message", sessionId: "session", memberId: "owner", operationId: "message", handle, message: "private control message" };
  const sent = await Promise.all([runtime.call("monitor", message, owner), runtime.call("monitor", { ...message, requestId: "retry" }, owner)]);
  assert.equal(sent[0].ok, true); assert.equal(sent[1].ok, true); assert.equal(port.sends, 1);
  const messageConflict = await runtime.call("monitor", { ...message, message: "changed" }, owner);
  assert.equal(messageConflict.error?.code, "operation_receipt_conflict"); assert.equal(port.sends, 1);

  const cancel = { action: "cancel", sessionId: "session", memberId: "owner", operationId: "cancel", handle, reason: "stop" };
  const cancelled = await Promise.all([runtime.call("monitor", cancel, owner), runtime.call("monitor", cancel, owner)]);
  assert.equal(cancelled[0].ok, true); assert.equal(cancelled[1].ok, true);
  assert.deepEqual((cancelled[0].data as { receipt: unknown }).receipt, (cancelled[1].data as { receipt: unknown }).receipt);
});

test("daemon restart fences dispatching receipts and reports unreattachable tasks as lost", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-receipt-restart-"));
  const config = createTestGatewayConfig(root, { mode: "bearer", token: "secret" });
  const initial = await GatewayRuntime.create({ config, cwd: root, teammatePort: new BlockingPort() });
  const owner = await session(initial, root);
  await initial.close();
  const journal = new TaskJournal({ path: join(root, "state", "tasks", "journal.json") });
  await journal.upsert({ version: 1, id: "lost-task", status: "running", cwd: root, workspaceId: "workspace", principalId: principalKey(owner), sessionId: "session", memberId: "owner", createdAt: 1, updatedAt: 2 });
  const receipts = new GatewayOperationReceiptStore({ root: join(root, "state", "operation-receipts") });
  const pending = await receipts.prepare({ ...key, principalId: principalKey(owner), workspaceId: (await initial.sessionStore.require("session")).session.workspaceId, payloadHash: hashGatewayOperationPayload({ prompt: "secret crash prompt" }) });
  await receipts.markDispatching(pending.receipt);

  const restartedPort = new BlockingPort();
  const restarted = await GatewayRuntime.create({ config, cwd: root, teammatePort: restartedPort });
  t.after(async () => { await restarted.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal((await restarted.operationReceipts.get(pending.receipt.id))?.state, "outcome-unknown");
  const lost = await restarted.call("monitor", { action: "result", sessionId: "session", memberId: "owner", handle: "lost-task" }, owner);
  assert.equal(lost.ok, true); assert.equal((lost.data as { status: string }).status, "lost"); assert.equal(restartedPort.runs, 0);
});
