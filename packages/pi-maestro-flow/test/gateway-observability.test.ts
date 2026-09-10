import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayAuditSink } from "../src/gateway/audit.ts";
import { GatewayDaemon } from "../src/gateway/daemon.ts";
import { GatewayEventJournal } from "../src/gateway/event-journal.ts";
import { GatewayEventStream } from "../src/gateway/event-stream.ts";
import { GatewayObserver } from "../src/gateway/observability.ts";
import { hashGatewayOperationPayload } from "../src/gateway/operation-contracts.ts";
import { GatewayOperationReceiptStore } from "../src/gateway/operation-receipt-store.ts";
import { gatewayIpcAddress } from "../src/gateway/ipc.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";

const receiptKey = {
  principalId: "stdio:owner", workspaceId: "workspace", sessionId: "session", memberId: "member", memberGeneration: 1,
  tool: "monitor" as const, action: "message" as const, operationId: "operation-1",
};

function append(journal: GatewayEventJournal, cursor: number): void {
  journal.append({ workspaceId: "workspace", sessionId: "session", handle: "handle", cursor, kind: "progress", payload: { cursor }, at: cursor });
}

test("one observer projects an allow-listed low-cardinality shape and never serializes arbitrary text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-observer-redaction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "audit.jsonl");
  const audit = new GatewayAuditSink(path);
  const observer = new GatewayObserver(audit);
  const secret = "token-secret raw-command --password=secret https://endpoint.test/mcp?token=secret error body";
  for (let index = 0; index < 1_000; index += 1) {
    observer.observe({ category: "transport", event: "connect", transport: "https", token: secret, endpoint: secret, command: secret, error: secret } as never);
  }
  observer.observe({ category: "receipt", event: "conflict" });
  observer.observe({ category: "stream", event: "slow-consumer" });
  observer.observe({ category: "lifecycle", event: "drain", outcome: "timeout" });
  await audit.flush();
  const snapshot = observer.snapshot();
  assert.deepEqual(snapshot.events, [
    { key: "lifecycle.drain.timeout", count: 1 },
    { key: "receipt.conflict", count: 1 },
    { key: "stream.slow-consumer", count: 1 },
    { key: "transport.connect.https", count: 1_000 },
  ]);
  assert.equal(snapshot.events.length, 4, "repetition cannot create identifier-, endpoint-, or error-derived metric keys");
  const serialized = await readFile(path, "utf8");
  assert.doesNotMatch(serialized, /token-secret|raw-command|password|endpoint\.test|error body|query/iu);
  assert.ok(serialized.trim().split("\n").every((line) => Object.keys(JSON.parse(line)).every((key) => ["version", "recordType", "at", "category", "event", "transport", "phase", "outcome"].includes(key))));
});

test("receipt replay/conflict/unknown and stream subscribe/gap/slow-consumer share observer counters", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-observer-components-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const observer = new GatewayObserver();
  const receipts = new GatewayOperationReceiptStore({ root: join(root, "receipts"), observer, now: () => 10 });
  const payloadHash = hashGatewayOperationPayload({ handle: "handle", message: "not persisted here" });
  const prepared = await receipts.prepare({ ...receiptKey, payloadHash });
  await receipts.prepare({ ...receiptKey, payloadHash });
  await assert.rejects(receipts.prepare({ ...receiptKey, payloadHash: "f".repeat(64) }), /different canonical payload/);
  await receipts.markDispatching(prepared.receipt);
  await receipts.markOutcomeUnknown(prepared.receipt);

  const journal = new GatewayEventJournal(); append(journal, 1);
  const stream = new GatewayEventStream(journal, {
    observer,
    maxQueuedEventsPerSubscriber: 2,
    maxQueuedBytesPerSubscriber: 4096,
    maxQueuedEventsPerConnection: 2,
    maxQueuedBytesPerConnection: 4096,
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  stream.subscribe({ connectionId: "connection", workspaceId: "workspace", sessionId: "session", memberId: "member", memberGeneration: 1, handle: "handle", write: () => blocked });
  append(journal, 2); append(journal, 3);
  const metrics = new Map(observer.snapshot().events.map((event) => [event.key, event.count]));
  assert.equal(metrics.get("receipt.replay"), 1);
  assert.equal(metrics.get("receipt.conflict"), 1);
  assert.equal(metrics.get("receipt.outcome-unknown"), 1);
  assert.equal(metrics.get("stream.subscribe"), 1);
  assert.equal(metrics.get("stream.slow-consumer"), 1);
  assert.equal(metrics.get("stream.gap"), 1);
  release();
});

test("Gateway status exposes bounded observation/stream/audit metrics and lifecycle drain outcomes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-observer-status-"));
  const config = createTestGatewayConfig(root);
  config.logging.auditFile = join(root, "audit.jsonl");
  const daemon = new GatewayDaemon({ config, cwd: root, ipcAddress: gatewayIpcAddress(root, config.state.ownerPath), http: false, tunnelProviders: [] });
  await daemon.start();
  t.after(async () => { await daemon.close(); await rm(root, { recursive: true, force: true }); });
  daemon.runtime!.observer.observe({ category: "tunnel", event: "transition", phase: "ready" });
  const status = await daemon.controlDispatcher!.dispatch("status") as { metrics: { observations: { events: Array<{ key: string; count: number }> }; stream: { subscribers: number }; audit: { enabled: boolean } } };
  assert.deepEqual(status.metrics.observations.events, [{ key: "tunnel.transition.ready", count: 1 }]);
  assert.equal(status.metrics.stream.subscribers, 0);
  assert.equal(status.metrics.audit.enabled, true);
  assert.equal(await daemon.runtime!.beginQuiesce(Date.now() + 100), true);
  const keys = daemon.runtime!.observer.snapshot().events.map((event) => event.key);
  assert.ok(keys.includes("lifecycle.quiesce.started"));
  assert.ok(keys.includes("lifecycle.drain.completed"));
});
