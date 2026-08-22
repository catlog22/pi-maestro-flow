import {
  getCompletionDurabilityRegistry,
  type CompletionAppliedReceipt,
  type CompletionDispatchHandle,
  type CompletionDispatchSeed,
  type CompletionDurabilityProvider,
  type CompletionDurabilityRegistry,
  type CompletionFinalizeInput,
  type CompletionIntent,
  type CompletionNotificationRequirement,
  type CompletionTarget,
} from "../public/v1/completion-durability.ts";
import { CompletionOutboxFileStore } from "./file-store.ts";
import { COMPLETION_OUTBOX_MAX_ATTEMPTS, type CompletionOutboxRecord } from "./types.ts";

const RECEIPT_DEADLINE_MS = 60_000;

export interface CompletionDeliveryEnvelope {
  customType: "teammate-complete";
  content: string;
  display: true;
  details: {
    source: "completion-outbox";
    deliveryId: string;
    contentRevision: string;
    targetSessionId: string;
    dispatchId: string;
    mode: CompletionIntent["mode"];
    resources: readonly string[];
    replayed: boolean;
  };
}

export interface CompletionSessionBinding {
  target: CompletionTarget;
  entries: readonly unknown[];
  send(envelope: CompletionDeliveryEnvelope): boolean;
}

export interface CompletionDispatchDurability {
  durable: boolean;
  handle?: CompletionDispatchHandle;
}

export interface CompletionCoordinatorOptions {
  store?: CompletionOutboxFileStore;
  registry?: CompletionDurabilityRegistry;
  now?: () => number;
  enabled?: () => boolean;
  defer?: (run: () => void) => void;
}

interface PersistedCompletionMessage {
  deliveryId: string;
  contentRevision: string;
  targetSessionId: string;
}

function completionReceipt(value: unknown): PersistedCompletionMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as { type?: unknown; customType?: unknown; message?: unknown; details?: unknown };
  const candidate = entry.type === "custom_message"
    ? entry
    : entry.message && typeof entry.message === "object"
      ? entry.message as typeof entry
      : entry;
  if (candidate.customType !== "teammate-complete" || !candidate.details || typeof candidate.details !== "object") return undefined;
  const details = candidate.details as Record<string, unknown>;
  return details.source === "completion-outbox"
    && typeof details.deliveryId === "string"
    && typeof details.contentRevision === "string"
    && typeof details.targetSessionId === "string"
    ? {
        deliveryId: details.deliveryId,
        contentRevision: details.contentRevision,
        targetSessionId: details.targetSessionId,
      }
    : undefined;
}

function targetEquals(left: CompletionTarget, right: CompletionTarget): boolean {
  return left.workspaceId === right.workspaceId
    && left.sessionId === right.sessionId
    && left.correlationId === right.correlationId;
}

export function completionRedeliveryEnabled(): boolean {
  return process.env.PI_TEAMMATE_COMPLETION_REDELIVERY !== "0";
}

export class CompletionDeliveryCoordinator {
  readonly store: CompletionOutboxFileStore;
  readonly registry: CompletionDurabilityRegistry;
  readonly #now: () => number;
  readonly #enabled: () => boolean;
  readonly #defer: (run: () => void) => void;
  readonly #dispatches = new Map<string, { handle: CompletionDispatchHandle; provider: CompletionDurabilityProvider }>();
  readonly #inflight = new Map<string, Promise<void>>();
  readonly #deferred = new Set<Promise<void>>();
  #binding: CompletionSessionBinding | undefined;
  #unsubscribe: (() => void) | undefined;
  #disposed = false;

  constructor(options: CompletionCoordinatorOptions = {}) {
    this.store = options.store ?? new CompletionOutboxFileStore();
    this.registry = options.registry ?? getCompletionDurabilityRegistry();
    this.#now = options.now ?? Date.now;
    this.#enabled = options.enabled ?? completionRedeliveryEnabled;
    this.#defer = options.defer ?? ((run) => queueMicrotask(run));
    this.#unsubscribe = this.registry.subscribe((snapshot) => {
      if (!snapshot.provider || !this.#binding || this.#disposed) return;
      this.#scheduleReconcile();
    });
  }

  async beginDispatch(seed: CompletionDispatchSeed): Promise<CompletionDispatchDurability> {
    if (!this.#enabled()) return { durable: false };
    const provider = this.registry.current();
    if (!provider) return { durable: false };
    await this.store.reserve(seed);
    try {
      const handle = await provider.beginDispatch(seed);
      // Pin the provider instance for this dispatch so a later registry
      // replacement/unload cannot redirect or fail finalization mid-flight.
      this.#dispatches.set(seed.dispatchId, { handle, provider });
      return { durable: true, handle };
    } catch (error) {
      await this.store.releaseReservation(seed.target, seed.reservationId).catch(() => undefined);
      throw error;
    }
  }

  async requireNotification(input: CompletionNotificationRequirement): Promise<void> {
    if (!this.#dispatches.has(input.dispatchId)) return;
    const provider = this.#pinnedProvider(input.dispatchId);
    await provider.requireNotification(input);
  }

  async abandon(seed: CompletionDispatchSeed, reason: string): Promise<void> {
    const handle = this.#dispatches.get(seed.dispatchId);
    if (!handle) return;
    try {
      await this.#pinnedProvider(seed.dispatchId).abandonDispatch({
        dispatchId: seed.dispatchId,
        reservationId: seed.reservationId,
        reason,
        abandonedAt: this.#now(),
      });
    } finally {
      await this.store.releaseReservation(seed.target, seed.reservationId);
      this.#dispatches.delete(seed.dispatchId);
    }
  }

  async publishCompletion(input: CompletionFinalizeInput): Promise<CompletionOutboxRecord | undefined> {
    if (!this.#dispatches.has(input.dispatchId)) return undefined;
    const intent = await this.#pinnedProvider(input.dispatchId).finalizeDelivery(input);
    const record = await this.store.importIntent(intent);
    await this.#deliverDue(record.target, true);
    return record;
  }

  async settleForeground(seed: CompletionDispatchSeed): Promise<void> {
    if (!this.#dispatches.has(seed.dispatchId)) return;
    try {
      await this.#pinnedProvider(seed.dispatchId).abandonDispatch({
        dispatchId: seed.dispatchId,
        reservationId: seed.reservationId,
        reason: "foreground tool result consumed completion",
        abandonedAt: this.#now(),
      });
    } finally {
      await this.store.releaseReservation(seed.target, seed.reservationId);
      this.#dispatches.delete(seed.dispatchId);
    }
  }

  async bindSession(binding: CompletionSessionBinding): Promise<void> {
    this.#binding = binding;
    await this.#runOnce(binding.target, async () => {
      await this.#importRecoverable(binding.target);
      await this.#rebuildReceipts(binding.target, binding.entries);
      await this.#deliverDue(binding.target, true);
    });
    this.#scheduleReconcile();
  }

  async drain(): Promise<void> {
    while (this.#deferred.size > 0 || this.#inflight.size > 0) {
      await Promise.allSettled([...this.#deferred, ...this.#inflight.values()]);
    }
  }

  unbindSession(sessionId?: string): void {
    if (!this.#binding || (sessionId && this.#binding.target.sessionId !== sessionId)) return;
    this.#binding = undefined;
  }

  async reconcile(): Promise<void> {
    const binding = this.#binding;
    if (!binding || this.#disposed) return;
    await this.#runOnce(binding.target, async () => {
      await this.#importRecoverable(binding.target);
      await this.#rebuildReceipts(binding.target, binding.entries);
      await this.#deliverDue(binding.target, true);
      await this.store.gc(binding.target.workspaceId);
      await this.registry.current()?.prune(this.#now());
    });
  }

  async receiveMessageEnd(message: unknown, currentTarget: CompletionTarget): Promise<boolean> {
    const receipt = completionReceipt(message);
    if (!receipt || receipt.targetSessionId !== currentTarget.sessionId) return false;
    const records = await this.store.listForTarget(currentTarget);
    const record = records.find((entry) => entry.deliveryId === receipt.deliveryId);
    if (!record || record.contentRevision !== receipt.contentRevision || !targetEquals(record.target, currentTarget)) return false;
    await this.#apply(record);
    return true;
  }

  async redrive(): Promise<void> {
    if (!this.#binding) return;
    await this.#deliverDue(this.#binding.target, true);
  }

  dispose(): void {
    this.#disposed = true;
    this.#binding = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  async #importRecoverable(target: CompletionTarget): Promise<void> {
    const provider = this.registry.current();
    if (!provider) return;
    for (const intent of await provider.listRecoverable(target)) {
      try { await this.store.importIntent(intent); }
      catch (error) {
        console.warn(`[pi-maestro-teammate] completion intent import failed for ${intent.deliveryId}:`, error);
      }
    }
  }

  async #rebuildReceipts(target: CompletionTarget, entries: readonly unknown[]): Promise<void> {
    const receipts = entries.map(completionReceipt).filter((entry): entry is PersistedCompletionMessage => Boolean(entry));
    if (receipts.length === 0) return;
    const records = await this.store.listForTarget(target);
    for (const receipt of receipts) {
      const record = records.find((entry) => entry.deliveryId === receipt.deliveryId);
      if (record && receipt.targetSessionId === target.sessionId && receipt.contentRevision === record.contentRevision) {
        await this.#apply(record);
      }
    }
  }

  async #deliverDue(target: CompletionTarget, replayed: boolean): Promise<void> {
    const binding = this.#binding;
    if (!binding || !targetEquals(binding.target, target)) return;
    const now = this.#now();
    const records = await this.store.listForTarget(target);
    for (const candidate of records) {
      let record = candidate;
      if (record.state === "queued" && (record.receiptDeadlineAt ?? Number.MAX_SAFE_INTEGER) <= now) {
        if (record.attempts >= COMPLETION_OUTBOX_MAX_ATTEMPTS) {
          await this.store.markDead(target, record.deliveryId, "completion receipt retries exhausted");
          continue;
        }
        record = await this.store.returnToPending(target, record.deliveryId, "completion receipt deadline elapsed") ?? record;
      }
      if (record.state !== "pending" || record.nextAttemptAt > now) continue;
      const claimed = await this.store.acquireClaim(target, record.deliveryId);
      if (!claimed) continue;
      const envelope = this.deliveryEnvelope(claimed, replayed);
      let accepted = false;
      try { accepted = binding.send(envelope); }
      catch (error) {
        await this.store.returnToPending(target, record.deliveryId, error instanceof Error ? error.message : String(error));
        continue;
      }
      if (accepted) {
        try {
          await this.store.markQueued(target, record.deliveryId, now + RECEIPT_DEADLINE_MS);
        } catch (error) {
          // The model may already have the accepted envelope. Do not let this
          // escape to the caller, which would trigger a second direct send.
          // The durable pending record remains replayable and identifiable by
          // the same deliveryId if the first envelope never reaches message_end.
          console.warn(`[pi-maestro-teammate] accepted completion could not persist queued state for ${record.deliveryId}:`, error);
        }
      } else {
        await this.store.returnToPending(target, record.deliveryId, "sendMessage rejected completion");
      }
    }
  }

  async #apply(record: CompletionOutboxRecord): Promise<void> {
    if (record.state === "applied" && record.providerAcknowledgedAt !== undefined) return;
    const applied = await this.store.markApplied(record.target, record.deliveryId);
    if (!applied || applied.providerAcknowledgedAt !== undefined) return;
    const provider = this.registry.current();
    if (!provider) return;
    const receipt: CompletionAppliedReceipt = {
      deliveryId: applied.deliveryId,
      dispatchId: applied.dispatchId,
      target: applied.target,
      contentRevision: applied.contentRevision,
      appliedAt: this.#now(),
    };
    try {
      await provider.acknowledgeApplied(receipt);
      await this.store.markProviderAcknowledged(applied.target, applied.deliveryId);
    } catch (error) {
      console.warn(`[pi-maestro-teammate] completion provider acknowledgement failed for ${applied.deliveryId}:`, error);
    }
  }

  deliveryEnvelope(record: CompletionOutboxRecord, replayed: boolean): CompletionDeliveryEnvelope {
    const resources = record.resources.map((resource) => resource.uri);
    const suffix = resources.length > 0 ? `\n\nResults: ${resources.join(", ")}` : "";
    return {
      customType: "teammate-complete",
      content: `${record.summary}${suffix}`,
      display: true,
      details: {
        source: "completion-outbox",
        deliveryId: record.deliveryId,
        contentRevision: record.contentRevision,
        targetSessionId: record.target.sessionId,
        dispatchId: record.dispatchId,
        mode: record.kind === "graph" ? "graph" : "single",
        resources,
        replayed,
      },
    };
  }

  #scheduleReconcile(): void {
    let finish = (): void => undefined;
    const tracked = new Promise<void>((resolve) => { finish = resolve; });
    this.#deferred.add(tracked);
    this.#defer(() => {
      void this.reconcile().catch((error) => {
        console.warn("[pi-maestro-teammate] deferred completion reconciliation failed:", error);
      }).finally(() => {
        this.#deferred.delete(tracked);
        finish();
      });
    });
  }

  #pinnedProvider(dispatchId: string): CompletionDurabilityProvider {
    const pinned = this.#dispatches.get(dispatchId);
    if (pinned) return pinned.provider;
    const provider = this.registry.current();
    if (!provider) throw new Error("Completion durability provider became unavailable.");
    return provider;
  }

  async #runOnce(target: CompletionTarget, run: () => Promise<void>): Promise<void> {
    const providerGeneration = this.registry.snapshot().generation;
    const key = `${providerGeneration}:${target.workspaceId}:${target.sessionId}:${target.correlationId ?? "main"}`;
    const current = this.#inflight.get(key);
    if (current) return current;
    const operation = run().finally(() => {
      if (this.#inflight.get(key) === operation) this.#inflight.delete(key);
    });
    this.#inflight.set(key, operation);
    return operation;
  }
}
