import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  COMPLETION_DURABILITY_VERSION,
  CompletionDurabilityRegistryImpl,
  computeCompletionDeliveryId,
  computeCompletionIntentRevision,
  type CompletionAppliedReceipt,
  type CompletionDispatchSeed,
  type CompletionDurabilityProvider,
  type CompletionFinalizeInput,
  type CompletionIntent,
  type CompletionResource,
  type CompletionTarget,
} from "../src/public/v1/completion-durability.ts";
import {
  CompletionDeliveryCoordinator,
  type CompletionDeliveryEnvelope,
} from "../src/completion-outbox/coordinator.ts";
import { CompletionOutboxFileStore } from "../src/completion-outbox/file-store.ts";
import { COMPLETION_OUTBOX_MAX_ATTEMPTS } from "../src/completion-outbox/types.ts";

class FakeProvider implements CompletionDurabilityProvider {
  readonly seeds = new Map<string, CompletionDispatchSeed>();
  readonly required = new Set<string>();
  readonly intents = new Map<string, CompletionIntent>();
  readonly applied: CompletionAppliedReceipt[] = [];
  acknowledgeFailuresRemaining = 0;

  async beginDispatch(seed: CompletionDispatchSeed) {
    this.seeds.set(seed.dispatchId, seed);
    return { dispatchId: seed.dispatchId, reservationId: seed.reservationId, deliveryGroupId: seed.deliveryGroupId };
  }
  async requireNotification(input: { dispatchId: string }) { this.required.add(input.dispatchId); }
  async stagePublication() {}
  async commitPublication() {}
  async finalizeDelivery(input: CompletionFinalizeInput): Promise<CompletionIntent> {
    const seed = this.seeds.get(input.dispatchId);
    if (!seed || !this.required.has(input.dispatchId)) throw new Error("not ready");
    const base: Omit<CompletionIntent, "contentRevision"> = {
      version: COMPLETION_DURABILITY_VERSION,
      deliveryId: "",
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      mode: seed.mode,
      kind: input.kind,
      target: seed.target,
      replyTarget: seed.replyTarget,
      outcome: input.outcome,
      summary: input.summary,
      resources: [...input.resources],
      createdAt: seed.createdAt,
      finalizedAt: input.finalizedAt,
    };
    const identified = { ...base, deliveryId: computeCompletionDeliveryId(base) };
    const intent = { ...identified, contentRevision: computeCompletionIntentRevision(identified) };
    this.intents.set(intent.deliveryId, intent);
    return intent;
  }
  async listRecoverable(target: CompletionTarget) {
    return [...this.intents.values()].filter((intent) => intent.target.workspaceId === target.workspaceId
      && intent.target.sessionId === target.sessionId
      && intent.target.correlationId === target.correlationId
      && !this.applied.some((receipt) => receipt.deliveryId === intent.deliveryId));
  }
  async acknowledgeApplied(receipt: CompletionAppliedReceipt) {
    if (this.acknowledgeFailuresRemaining > 0) {
      this.acknowledgeFailuresRemaining -= 1;
      throw new Error("injected acknowledgement crash");
    }
    this.applied.push(receipt);
  }
  async abandonDispatch() {}
  async prune() {}
}

const target: CompletionTarget = { workspaceId: "workspace", sessionId: "session" };
const resource: CompletionResource = {
  correlationId: "correlation",
  publicationId: "publication",
  uri: "agent://publication",
  summary: "done",
  outcome: "completed",
};

function seed(owner = target): CompletionDispatchSeed {
  return {
    dispatchId: "dispatch",
    deliveryGroupId: "group",
    reservationId: "reservation",
    mode: "single",
    target: owner,
    replyTarget: "main",
    originCwd: "D:/workspace",
    expectedTasks: [resource.correlationId],
    createdAt: 1_000,
  };
}

async function fixture(run: (input: {
  coordinator: CompletionDeliveryCoordinator;
  store: CompletionOutboxFileStore;
  registry: CompletionDurabilityRegistryImpl;
  provider: FakeProvider;
  sent: CompletionDeliveryEnvelope[];
  bind(entries?: readonly unknown[], owner?: CompletionTarget): Promise<void>;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "completion-coordinator-"));
  const store = new CompletionOutboxFileStore({ rootDir: root, now: () => 2_000, ownerId: "test" });
  const registry = new CompletionDurabilityRegistryImpl();
  const provider = new FakeProvider();
  registry.register(provider);
  const sent: CompletionDeliveryEnvelope[] = [];
  const coordinator = new CompletionDeliveryCoordinator({ store, registry, now: () => 2_000, defer: (next) => queueMicrotask(next) });
  try {
    await run({
      coordinator,
      store,
      registry,
      provider,
      sent,
      async bind(entries = [], owner = target) {
        await coordinator.bindSession({ target: owner, entries, send(envelope) { sent.push(envelope); return true; } });
      },
    });
  } finally {
    await coordinator.drain();
    coordinator.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

async function complete(coordinator: CompletionDeliveryCoordinator, owner = target): Promise<void> {
  const dispatch = seed(owner);
  const state = await coordinator.beginDispatch(dispatch);
  assert.equal(state.durable, true);
  await coordinator.requireNotification({
    dispatchId: dispatch.dispatchId,
    reservationId: dispatch.reservationId,
    kind: "single",
    requiredAt: 1_100,
  });
  await coordinator.publishCompletion({
    dispatchId: dispatch.dispatchId,
    reservationId: dispatch.reservationId,
    kind: "single",
    outcome: "completed",
    summary: "worker completed",
    resources: [resource],
    finalizedAt: 1_200,
  });
}

test("queue acceptance remains queued until matching message_end receipt", async () => {
  await fixture(async ({ coordinator, store, provider, sent, bind }) => {
    await bind();
    await complete(coordinator);
    assert.equal(sent.length, 1);
    let record = (await store.listForTarget(target))[0]!;
    assert.equal(record.state, "queued");
    assert.equal(provider.applied.length, 0);

    assert.equal(await coordinator.receiveMessageEnd(sent[0], target), true);
    record = (await store.listForTarget(target))[0]!;
    assert.equal(record.state, "applied");
    assert.equal(provider.applied.length, 1);
    assert.equal(record.providerAcknowledgedAt, 2_000);
  });
});

test("transcript rebuild applies a queued notice without reinjection", async () => {
  await fixture(async ({ coordinator, store, registry, provider, sent, bind }) => {
    await bind();
    await complete(coordinator);
    const persisted = sent[0]!;
    await coordinator.drain();
    coordinator.dispose();

    const afterRestart: CompletionDeliveryEnvelope[] = [];
    const restarted = new CompletionDeliveryCoordinator({ store, registry, now: () => 2_100, defer: (next) => queueMicrotask(next) });
    try {
      await restarted.bindSession({ target, entries: [persisted], send(envelope) { afterRestart.push(envelope); return true; } });
      await restarted.drain();
      assert.equal(afterRestart.length, 0);
      assert.equal((await store.listForTarget(target))[0]?.state, "applied");
      assert.equal(provider.applied.length, 1);
    } finally { restarted.dispose(); }
  });
});

test("a different or forked session cannot claim the original completion", async () => {
  await fixture(async ({ coordinator, sent, bind }) => {
    const other = { workspaceId: target.workspaceId, sessionId: "fork-session" };
    await bind([], other);
    await complete(coordinator, target);
    assert.equal(sent.length, 0);
  });
});

test("provider registration after session binding triggers idempotent recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-late-provider-"));
  const store = new CompletionOutboxFileStore({ rootDir: root, now: () => 2_000, ownerId: "late" });
  const registry = new CompletionDurabilityRegistryImpl();
  const provider = new FakeProvider();
  const dispatch = seed();
  await store.reserve(dispatch);
  await provider.beginDispatch(dispatch);
  await provider.requireNotification({ dispatchId: dispatch.dispatchId });
  const intent = await provider.finalizeDelivery({
    dispatchId: dispatch.dispatchId,
    reservationId: dispatch.reservationId,
    kind: "single",
    outcome: "completed",
    summary: "late",
    resources: [resource],
    finalizedAt: 1_500,
  });
  provider.intents.set(intent.deliveryId, intent);
  const sent: CompletionDeliveryEnvelope[] = [];
  const coordinator = new CompletionDeliveryCoordinator({ store, registry, now: () => 2_000, defer: (next) => queueMicrotask(next) });
  try {
    await coordinator.bindSession({ target, entries: [], send(envelope) { sent.push(envelope); return true; } });
    assert.equal(sent.length, 0);
    registry.register(provider);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await coordinator.drain();
    assert.equal(sent.length, 1);
  } finally {
    await coordinator.drain();
    coordinator.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("a rejected send stays pending without consuming an attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-rejected-send-"));
  const store = new CompletionOutboxFileStore({ rootDir: root, now: () => 2_000, ownerId: "reject" });
  const registry = new CompletionDurabilityRegistryImpl();
  registry.register(new FakeProvider());
  const coordinator = new CompletionDeliveryCoordinator({ store, registry, now: () => 2_000, defer: (next) => queueMicrotask(next) });
  try {
    await coordinator.bindSession({ target, entries: [], send() { return false; } });
    await complete(coordinator);
    const record = (await store.listForTarget(target))[0]!;
    assert.equal(record.state, "pending");
    assert.equal(record.attempts, 0);
  } finally {
    await coordinator.drain();
    coordinator.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("eight accepted sends without a receipt become dead", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-attempts-"));
  let now = 2_000;
  const store = new CompletionOutboxFileStore({ rootDir: root, now: () => now, ownerId: "attempts" });
  const registry = new CompletionDurabilityRegistryImpl();
  registry.register(new FakeProvider());
  const coordinator = new CompletionDeliveryCoordinator({ store, registry, now: () => now, defer: (next) => queueMicrotask(next) });
  try {
    await coordinator.bindSession({ target, entries: [], send() { return true; } });
    await complete(coordinator);
    for (let attempt = 1; attempt < COMPLETION_OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      now += 61_000;
      await coordinator.redrive();
    }
    now += 61_000;
    await coordinator.redrive();
    const record = (await store.listForTarget(target))[0]!;
    assert.equal(record.attempts, COMPLETION_OUTBOX_MAX_ATTEMPTS);
    assert.equal(record.state, "dead");
  } finally {
    await coordinator.drain();
    coordinator.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("applied receipt retries provider acknowledgement after a crash", async () => {
  await fixture(async ({ coordinator, store, provider, sent, bind }) => {
    provider.acknowledgeFailuresRemaining = 1;
    await bind();
    await complete(coordinator);
    assert.equal(await coordinator.receiveMessageEnd(sent[0], target), true);
    assert.equal((await store.listForTarget(target))[0]?.state, "applied");
    assert.equal((await store.listForTarget(target))[0]?.providerAcknowledgedAt, undefined);
    assert.equal(provider.applied.length, 0);

    await coordinator.bindSession({ target, entries: [sent[0]], send() { return true; } });
    await coordinator.drain();
    assert.equal(provider.applied.length, 1);
    assert.equal((await store.listForTarget(target))[0]?.providerAcknowledgedAt, 2_000);
  });
});

test("disabled redelivery keeps legacy mode and creates no reservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-disabled-"));
  const store = new CompletionOutboxFileStore({ rootDir: root });
  const registry = new CompletionDurabilityRegistryImpl();
  registry.register(new FakeProvider());
  const coordinator = new CompletionDeliveryCoordinator({ store, registry, enabled: () => false, defer: (next) => queueMicrotask(next) });
  try {
    assert.deepEqual(await coordinator.beginDispatch(seed()), { durable: false });
    assert.deepEqual(await store.usage(target.workspaceId), { liveRecords: 0, liveBytes: 0, reservations: 0 });
  } finally {
    coordinator.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt outbox records are never replayed", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-corrupt-"));
  const workspace = createHash("sha256").update(target.workspaceId).digest("hex");
  const session = createHash("sha256").update(target.sessionId).digest("hex");
  const pending = join(root, workspace, session, "pending");
  await mkdir(pending, { recursive: true });
  await writeFile(join(pending, `${"f".repeat(64)}.json`), "{ not-json\n");
  const store = new CompletionOutboxFileStore({ rootDir: root });
  try {
    assert.deepEqual(await store.listForTarget(target), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
