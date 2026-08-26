import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  COMPLETION_DURABILITY_VERSION,
  CompletionDurabilityRegistryImpl,
  computeCompletionDeliveryId,
  computeCompletionIntentRevision,
  type CompletionAppliedReceipt,
  type CompletionAbandonInput,
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

class FakeProvider implements CompletionDurabilityProvider {
  readonly seeds = new Map<string, CompletionDispatchSeed>();
  readonly required = new Set<string>();
  readonly intents = new Map<string, CompletionIntent>();
  readonly applied: CompletionAppliedReceipt[] = [];
  acknowledgeFailuresRemaining = 0;
  listRecoverableCalls = 0;

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
    this.listRecoverableCalls += 1;
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
    const intent = [...this.intents.values()].find((candidate) => candidate.dispatchId === receipt.dispatchId);
    if (!intent || intent.deliveryId !== receipt.deliveryId || intent.contentRevision !== receipt.contentRevision) {
      throw new Error(`Completion applied receipt mismatch for ${receipt.dispatchId}.`);
    }
    this.applied.push(receipt);
  }
  async abandonDispatch(_input: CompletionAbandonInput) {}
  async prune() {}
}

const target: CompletionTarget = { workspaceId: "workspace", sessionId: "session" };
const resource: CompletionResource = {
  correlationId: "correlation",
  publicationId: "publication",
  uri: "agent://publication",
  originCwd: "D:/workspace",
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
    assert.equal(provider.applied[0]?.contentRevision, provider.intents.get(sent[0]!.details.deliveryId)?.contentRevision);
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

test("a finalize rejection after durable commit is re-read through the pinned provider and forbids fallback", async () => {
  await fixture(async ({ coordinator, provider, sent, bind }) => {
    await bind();
    const dispatch = seed();
    assert.equal((await coordinator.beginDispatch(dispatch)).durable, true);
    await coordinator.requireNotification({
      dispatchId: dispatch.dispatchId,
      reservationId: dispatch.reservationId,
      kind: "single",
      requiredAt: 1_100,
    });
    const finalize = provider.finalizeDelivery.bind(provider);
    (provider as { finalizeDelivery: typeof provider.finalizeDelivery }).finalizeDelivery = async (input) => {
      await finalize(input);
      throw new Error("injected cleanup failure after finalized manifest commit");
    };

    const result = await coordinator.publishCompletion({
      dispatchId: dispatch.dispatchId,
      reservationId: dispatch.reservationId,
      kind: "single",
      outcome: "completed",
      summary: "committed before cleanup",
      resources: [resource],
      finalizedAt: 1_200,
    });

    assert.equal(result.finalized, true, "a pinned exact re-read proves the finalize commit point was crossed");
    assert.ok(result.finalized && result.record, "the recovered committed intent is imported normally");
    assert.equal(sent.length, 1);
    assert.ok(provider.listRecoverableCalls > 0, "post-error state was re-read only through the pinned provider");
  });
});

test("post-finalize import failure is contained and reconciles one durable notification", async () => {
  await fixture(async ({ coordinator, store, sent, bind }) => {
    await bind();
    const dispatch = seed();
    assert.equal((await coordinator.beginDispatch(dispatch)).durable, true);
    await coordinator.requireNotification({
      dispatchId: dispatch.dispatchId,
      reservationId: dispatch.reservationId,
      kind: "single",
      requiredAt: 1_100,
    });
    const originalImport = store.importIntent.bind(store);
    const originalRecover = store.recoverFinalizedIntent.bind(store);
    let failImport = true;
    (store as { importIntent: typeof store.importIntent }).importIntent = async (value) => {
      if (failImport) throw new Error("injected post-finalize import crash");
      return originalImport(value);
    };
    (store as { recoverFinalizedIntent: typeof store.recoverFinalizedIntent }).recoverFinalizedIntent = async (value) => {
      if (failImport) throw new Error("injected finalized recovery crash");
      return originalRecover(value);
    };

    const result = await coordinator.publishCompletion({
      dispatchId: dispatch.dispatchId,
      reservationId: dispatch.reservationId,
      kind: "single",
      outcome: "completed",
      summary: "durably finalized",
      resources: [resource],
      finalizedAt: 1_200,
    });
    assert.deepEqual(result, { finalized: true }, "post-commit failure is discriminated from pre-commit fallback");
    await coordinator.drain();
    assert.equal(sent.length, 0);

    failImport = false;
    await coordinator.reconcile();
    await coordinator.drain();
    assert.equal(sent.length, 1);
    assert.equal((await store.listForTarget(target)).length, 1);
    await coordinator.reconcile();
    assert.equal(sent.length, 1, "the same deliveryId is never directly duplicated");
  });
});

test("post-finalize recovery stays on the dispatch-pinned provider after registry replacement", async () => {
  await fixture(async ({ coordinator, store, registry, provider: pinnedProvider, sent, bind }) => {
    await bind();
    const dispatch = seed();
    assert.equal((await coordinator.beginDispatch(dispatch)).durable, true);
    await coordinator.requireNotification({
      dispatchId: dispatch.dispatchId,
      reservationId: dispatch.reservationId,
      kind: "single",
      requiredAt: 1_100,
    });
    const originalImport = store.importIntent.bind(store);
    const originalRecover = store.recoverFinalizedIntent.bind(store);
    let allowRecovery = false;
    (store as { importIntent: typeof store.importIntent }).importIntent = async (value) => {
      if (!allowRecovery) throw new Error("injected import failure before provider replacement");
      return originalImport(value);
    };
    (store as { recoverFinalizedIntent: typeof store.recoverFinalizedIntent }).recoverFinalizedIntent = async (value) => {
      if (!allowRecovery) throw new Error("injected recovery failure before provider replacement");
      return originalRecover(value);
    };

    const published = await coordinator.publishCompletion({
      dispatchId: dispatch.dispatchId,
      reservationId: dispatch.reservationId,
      kind: "single",
      outcome: "completed",
      summary: "pinned",
      resources: [resource],
      finalizedAt: 1_200,
    });
    assert.deepEqual(published, { finalized: true });
    const replacementProvider = new FakeProvider();
    registry.register(replacementProvider);
    allowRecovery = true;
    await coordinator.reconcile();
    await coordinator.drain();

    assert.equal(sent.length, 1, "captured finalized intent was imported exactly once");
    assert.ok(pinnedProvider.listRecoverableCalls > 0, "reconciliation queried the pinned provider");
    assert.equal(replacementProvider.intents.size, 0, "the current provider did not take ownership");
    assert.equal((await store.listForTarget(target))[0]?.dispatchId, dispatch.dispatchId);
  });
});

test("a throwing replacement provider cannot block prioritized pinned enumeration or delivery", async () => {
  await fixture(async ({ coordinator, registry, provider: pinnedProvider, sent, bind }) => {
    const dispatch = seed();
    assert.equal((await coordinator.beginDispatch(dispatch)).durable, true);
    await coordinator.requireNotification({
      dispatchId: dispatch.dispatchId,
      reservationId: dispatch.reservationId,
      kind: "single",
      requiredAt: 1_100,
    });
    await pinnedProvider.finalizeDelivery({
      dispatchId: dispatch.dispatchId,
      reservationId: dispatch.reservationId,
      kind: "single",
      outcome: "completed",
      summary: "pinned enumeration",
      resources: [resource],
      finalizedAt: 1_200,
    });

    const enumerationOrder: string[] = [];
    const pinnedList = pinnedProvider.listRecoverable.bind(pinnedProvider);
    (pinnedProvider as { listRecoverable: typeof pinnedProvider.listRecoverable }).listRecoverable = async (owner) => {
      enumerationOrder.push("pinned");
      return pinnedList(owner);
    };
    const replacement = new FakeProvider();
    replacement.listRecoverable = async () => {
      enumerationOrder.push("replacement");
      throw new Error("replacement enumeration unavailable");
    };
    registry.register(replacement);

    await bind();
    await coordinator.drain();
    assert.deepEqual(enumerationOrder.slice(0, 2), ["pinned", "replacement"]);
    assert.equal(sent.length, 1, "delivery continues after another provider fails enumeration");
    assert.equal(sent[0]?.details.dispatchId, dispatch.dispatchId);
  });
});

test("drain waits for fire-and-forget publication import and delivery", async () => {
  await fixture(async ({ coordinator, store, sent, bind }) => {
    await bind();
    const dispatch = seed();
    assert.equal((await coordinator.beginDispatch(dispatch)).durable, true);
    await coordinator.requireNotification({ dispatchId: dispatch.dispatchId, reservationId: dispatch.reservationId, kind: "single", requiredAt: 1_100 });
    const originalImport = store.importIntent.bind(store);
    let releaseImport!: () => void;
    const gate = new Promise<void>((resolve) => { releaseImport = resolve; });
    (store as { importIntent: typeof store.importIntent }).importIntent = async (value) => {
      await gate;
      return originalImport(value);
    };
    void coordinator.publishCompletion({
      dispatchId: dispatch.dispatchId,
      reservationId: dispatch.reservationId,
      kind: "single",
      outcome: "completed",
      summary: "tracked",
      resources: [resource],
      finalizedAt: 1_200,
    });
    let drained = false;
    const draining = coordinator.drain().then(() => { drained = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    releaseImport();
    await draining;
    assert.equal(sent.length, 1);
  });
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

test("an accepted follow-up is not enqueued again until its coordinator restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-accepted-host-"));
  let now = 2_000;
  const store = new CompletionOutboxFileStore({ rootDir: root, now: () => now, ownerId: "accepted-host" });
  const registry = new CompletionDurabilityRegistryImpl();
  registry.register(new FakeProvider());
  const sent: CompletionDeliveryEnvelope[] = [];
  const coordinator = new CompletionDeliveryCoordinator({ store, registry, now: () => now, defer: (next) => queueMicrotask(next) });
  try {
    await coordinator.bindSession({ target, entries: [], send(envelope) { sent.push(envelope); return true; } });
    await complete(coordinator);
    assert.equal(sent.length, 1);

    now += 61_000;
    await coordinator.redrive();
    assert.equal(sent.length, 1);
    assert.equal((await store.listForTarget(target))[0]?.attempts, 1);

    await coordinator.drain();
    coordinator.dispose();
    const restarted = new CompletionDeliveryCoordinator({ store, registry, now: () => now, defer: (next) => queueMicrotask(next) });
    try {
      await restarted.bindSession({ target, entries: [], send(envelope) { sent.push(envelope); return true; } });
      assert.equal(sent.length, 2);
      assert.equal((await store.listForTarget(target))[0]?.attempts, 2);
    } finally {
      await restarted.drain();
      restarted.dispose();
    }
  } finally {
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

test("every root, nested, workspace, and additional caller branches on fulfilled finalized:false", async () => {
  const rootSource = await readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  const nestedSource = await readFile(new URL("../src/extension/teammate-proxy.ts", import.meta.url), "utf8");

  const workspace = rootSource.slice(
    rootSource.indexOf("const publishWorkspaceTerminalCompletion = ("),
    rootSource.indexOf("const consumeWorkspaceTerminalCommand = ("),
  );
  assert.match(workspace, /const publishResult = await completionCoordinator\.publishCompletion\([\s\S]*?return publishResult\.finalized;/);

  const durableHelper = rootSource.slice(
    rootSource.indexOf("const publishDurableCompletion = async ("),
    rootSource.indexOf("const publishDurableFailure = async ("),
  );
  assert.match(durableHelper, /const publishResult = await completionCoordinator\.publishCompletion\([\s\S]*?return publishResult\.finalized;/);

  const rootAdditional = rootSource.slice(
    rootSource.indexOf("const publishAdditionalTurnCompletion = ("),
    rootSource.indexOf("const parentSessionFile =", rootSource.indexOf("const publishAdditionalTurnCompletion = (")),
  );
  assert.match(rootAdditional, /\.then\(\(publishResult\) => \{\s*if \(!publishResult\.finalized\) fallbackDelivery\(\);/);

  const nested = nestedSource.slice(
    nestedSource.indexOf("void publishNestedDurableCompletion"),
    nestedSource.indexOf("finishProxyDispatchTracking();", nestedSource.indexOf("void publishNestedDurableCompletion")),
  );
  assert.match(nested, /if \(!result\.finalized\) \{\s*fallbackDelivery\(\)/);
  assert.doesNotMatch(nested, /if \(!record\) \{\s*fallbackDelivery\(\)/);

  const nestedAdditional = nestedSource.slice(
    nestedSource.indexOf("const publishAdditionalNestedTurn = ("),
    nestedSource.indexOf("normalizedTasks?.forEach", nestedSource.indexOf("const publishAdditionalNestedTurn = (")),
  );
  assert.match(nestedAdditional, /if \(!publishResult\.finalized\) \{\s*fallbackDelivery\(\)/);
});

test("child session shutdown awaits coordinator drain before disposing authorities", async () => {
  const source = await readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  const childShutdown = source.slice(source.indexOf('pi.on("session_shutdown", async () => {'));
  const awaitDrain = childShutdown.indexOf("await childCompletionCoordinator.drain();");
  const disposeCoordinator = childShutdown.indexOf("childCompletionCoordinator.dispose();");
  const disposeProxy = childShutdown.indexOf("disposeChildProxyCaller();");
  assert.ok(awaitDrain >= 0 && disposeCoordinator > awaitDrain && disposeProxy > disposeCoordinator);
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

test("a finalized manifest recreates its missing reservation and is never abandoned", async () => {
  // Finalization is the irreversible commit point. Recovery must recreate the
  // same dispatch/target reservation fence instead of deleting the manifest.
  const root = await mkdtemp(join(tmpdir(), "completion-stale-manifest-"));
  const store = new CompletionOutboxFileStore({ rootDir: root, now: () => 2_000, ownerId: "stale" });
  const registry = new CompletionDurabilityRegistryImpl();
  const abandoned: Array<{ dispatchId: string; reservationId: string }> = [];
  // A provider that exposes one finalized intent but never reserved it in
  // the outbox store, and records abandonDispatch calls.
  class StaleProvider extends FakeProvider {
    override async abandonDispatch(input: CompletionAbandonInput): Promise<void> {
      abandoned.push({ dispatchId: input.dispatchId, reservationId: input.reservationId });
      const intent = [...this.intents.values()].find((candidate) => candidate.dispatchId === input.dispatchId);
      if (intent) this.intents.delete(intent.deliveryId);
    }
  }
  const staleProvider = new StaleProvider();
  registry.register(staleProvider);
  const coordinator = new CompletionDeliveryCoordinator({ store, registry, now: () => 2_000, defer: (next) => queueMicrotask(next) });
  try {
    // Seed a finalized intent for the bound target with no matching reservation.
    const staleSeed = { ...seed(), dispatchId: "stale-dispatch", reservationId: "stale-reservation" };
    staleProvider.seeds.set("stale-dispatch", staleSeed);
    staleProvider.required.add("stale-dispatch");
    await staleProvider.finalizeDelivery({
      dispatchId: "stale-dispatch",
      reservationId: "stale-reservation",
      kind: "single",
      outcome: "completed",
      summary: "stale",
      resources: [resource],
      finalizedAt: 1_200,
    });
    assert.equal((await store.listForTarget(target)).length, 0, "no reservation exists");
    assert.equal((await staleProvider.listRecoverable(target)).length, 1);

    await coordinator.bindSession({ target, entries: [], send() { return false; } });
    await coordinator.reconcile();
    await coordinator.drain();

    assert.equal(abandoned.length, 0, "a committed intent is never abandoned");
    assert.equal((await staleProvider.listRecoverable(target)).length, 1, "provider intent remains until applied acknowledgement");
    const records = await store.listForTarget(target);
    assert.equal(records.length, 1, "the finalized intent was imported after fenced reservation recovery");
    assert.equal(records[0]?.dispatchId, "stale-dispatch");
    assert.equal(records[0]?.state, "pending", "rejected send retains the durable completion for redelivery");

    await coordinator.reconcile();
    await coordinator.drain();
    assert.equal(abandoned.length, 0, "repeated recovery never abandons finalized intent");
    assert.equal((await store.listForTarget(target)).length, 1, "recovery remains idempotent");
  } finally {
    await coordinator.drain();
    coordinator.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
