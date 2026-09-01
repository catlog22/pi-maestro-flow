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
import { logDiagnosticError, logDiagnosticWarn } from "../shared/diagnostic-log.ts";
import { CompletionOutboxFileStore } from "./file-store.ts";
import { COMPLETION_OUTBOX_MAX_ATTEMPTS, type CompletionOutboxRecord } from "./types.ts";
import {
  MESSAGE_PROVENANCE_VERSION,
  type MessageProvenanceV1,
  type VerifiedMessageProvenanceV1,
} from "../shared/types.ts";

const RECEIPT_DEADLINE_MS = 60_000;
// Minimum gap between two store.gc() runs triggered by reconcile(). Expired
// records are inert until swept, so a 60s gap trades promptness for far less
// lock contention with concurrent reserve()/importIntent() writers.
const RECONCILE_GC_MIN_INTERVAL_MS = 60_000;

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
    /** Structured system attribution; absent on envelopes from older coordinators. */
    provenance?: MessageProvenanceV1;
  };
}

export interface CompletionSessionBinding {
  target: CompletionTarget;
  /** Read-only aliases from pre-canonical workspace hashing. New writes use target.workspaceId. */
  legacyWorkspaceIds?: readonly string[];
  entries: readonly unknown[];
  send(envelope: CompletionDeliveryEnvelope): boolean;
}

export interface CompletionDispatchDurability {
  durable: boolean;
  handle?: CompletionDispatchHandle;
}

/** Distinguishes a pre-commit miss from post-finalize reconciliation work. */
export type CompletionPublishResult =
  | { finalized: false }
  | { finalized: true; record?: CompletionOutboxRecord };

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

function bindingTargets(binding: CompletionSessionBinding): CompletionTarget[] {
  return [...new Set([binding.target.workspaceId, ...(binding.legacyWorkspaceIds ?? [])])]
    .map((workspaceId) => ({ ...binding.target, workspaceId }));
}

function bindingAcceptsTarget(binding: CompletionSessionBinding, target: CompletionTarget): boolean {
  return binding.target.sessionId === target.sessionId
    && binding.target.correlationId === target.correlationId
    && bindingTargets(binding).some((candidate) => candidate.workspaceId === target.workspaceId);
}

function receiptRevision(record: CompletionOutboxRecord): string {
  return record.intentRevision ?? record.contentRevision;
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
  readonly #dispatches = new Map<string, {
    handle: CompletionDispatchHandle;
    seed: CompletionDispatchSeed;
    provider: CompletionDurabilityProvider;
    releaseProviderPin: () => void;
  }>();
  readonly #acceptedByHost = new Set<string>();
  readonly #deliveryInProgress = new Set<string>();
  readonly #finalizedRecovery = new Map<string, {
    intent: CompletionIntent;
    provider: CompletionDurabilityProvider;
  }>();
  readonly #recoveredProviderPins = new Map<string, {
    provider: CompletionDurabilityProvider;
    release: () => void;
  }>();
  readonly #inflight = new Map<string, Promise<void>>();
  readonly #deferred = new Set<Promise<void>>();
  readonly #operations = new Set<Promise<unknown>>();
  #binding: CompletionSessionBinding | undefined;
  #unsubscribe: (() => void) | undefined;
  #disposed = false;
  // Throttle GC attempts inside reconcile(). tryGc() also persists a cross-process
  // page/expiry fence, but this local guard prevents one coordinator from
  // immediately reacquiring the maintenance lock while a backlog remains.
  // Seeded lazily so the first reconcile still attempts one non-blocking page.
  #lastReconcileGcAt: number | undefined;

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
    const existing = this.#dispatches.get(seed.dispatchId);
    if (existing) {
      if (existing.handle.reservationId !== seed.reservationId
        || existing.handle.deliveryGroupId !== seed.deliveryGroupId) {
        throw new Error(`Completion dispatch ${seed.dispatchId} is already pinned to another reservation.`);
      }
      return { durable: true, handle: existing.handle };
    }
    const provider = this.registry.current();
    if (!provider) return { durable: false };
    await this.store.reserve(seed);
    try {
      const handle = await provider.beginDispatch(seed);
      // Pin the provider instance in the shared registry as well as this
      // coordinator. Flow publication capture resolves stage/commit through
      // this dispatch ownership fence even after a provider reload.
      const releaseProviderPin = this.registry.pinDispatch(seed.dispatchId, provider);
      this.#dispatches.set(seed.dispatchId, { handle, seed, provider, releaseProviderPin });
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
      this.#releaseDispatch(seed.dispatchId);
    }
  }

  publishCompletion(input: CompletionFinalizeInput): Promise<CompletionPublishResult> {
    return this.#track(this.#publishCompletion(input));
  }

  async #publishCompletion(input: CompletionFinalizeInput): Promise<CompletionPublishResult> {
    const dispatch = this.#dispatches.get(input.dispatchId);
    if (!dispatch) return { finalized: false };
    const provider = dispatch.provider;
    let intent: CompletionIntent;
    try {
      intent = await provider.finalizeDelivery(input);
    } catch (finalizeError) {
      // A provider writer can throw while releasing its lock or cleaning a
      // replacement backup after the finalized manifest and its directory are
      // already durable. Re-read only through the dispatch-pinned provider: a
      // recoverable intent with the exact dispatch/reservation proves that the
      // irreversible commit point was crossed, so direct fallback is forbidden.
      let recovered: readonly CompletionIntent[];
      try {
        recovered = await provider.listRecoverable(dispatch.seed.target);
      } catch {
        throw finalizeError;
      }
      const committed = recovered.find((candidate) =>
        candidate.dispatchId === input.dispatchId
        && candidate.reservationId === input.reservationId);
      if (!committed) throw finalizeError;
      intent = committed;
      logDiagnosticWarn(`[pi-maestro-teammate] completion finalize returned an error after durable commit for ${intent.deliveryId}; continuing with pinned recovery:`, finalizeError);
    }
    // finalizeDelivery (or the exact pinned re-read above) is the durable commit
    // point. Everything after it is reconciliatory work: contain import/delivery
    // failures so callers never fall back to an untagged direct notification
    // that would later duplicate the recoverable intent.
    try {
      const record = await this.store.importIntent(intent);
      this.#finalizedRecovery.delete(intent.deliveryId);
      await this.#deliverDue(record.target, true);
      return { finalized: true, record };
    } catch (error) {
      this.#finalizedRecovery.set(intent.deliveryId, { intent, provider });
      logDiagnosticWarn(`[pi-maestro-teammate] finalized completion will be reconciled for ${intent.deliveryId}:`, error);
      this.#scheduleReconcile();
      return { finalized: true };
    }
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
      this.#releaseDispatch(seed.dispatchId);
    }
  }

  async bindSession(binding: CompletionSessionBinding): Promise<void> {
    this.#binding = binding;
    await this.#runOnce(binding.target, async () => {
      for (const target of bindingTargets(binding)) {
        await this.#importRecoverable(target);
        await this.#rebuildReceipts(target, binding.entries);
        await this.#deliverDue(target, true);
      }
    });
    this.#scheduleReconcile();
  }

  async drain(): Promise<void> {
    // Publication calls may be fire-and-forget at their call site. Keep looping
    // because a settled import can enqueue delivery/ack/reconcile work.
    while (this.#deferred.size > 0 || this.#inflight.size > 0 || this.#operations.size > 0) {
      await Promise.allSettled([
        ...this.#deferred,
        ...this.#inflight.values(),
        ...this.#operations,
      ]);
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
      const targets = bindingTargets(binding);
      for (const target of targets) {
        await this.#importRecoverable(target);
        await this.#rebuildReceipts(target, binding.entries);
        await this.#deliverDue(target, true);
      }
      const now = this.#now();
      // Use the non-blocking tryGc(): if a concurrent writer holds the workspace
      // lock, the sweep returns { busy } / { skipped } instead of throwing, so a
      // contended lock never produces a "periodic completion reconciliation
      // failed" warning. Canonical and legacy roots remain isolated and are
      // swept independently; no alias root is merged or deleted.
      if (this.#lastReconcileGcAt === undefined || now - this.#lastReconcileGcAt >= RECONCILE_GC_MIN_INTERVAL_MS) {
        let attempted = false;
        for (const target of targets) {
          const result = await this.store.tryGc(target.workspaceId);
          if (!result.busy && !result.skipped) attempted = true;
        }
        if (attempted) this.#lastReconcileGcAt = now;
      }
      const providers = new Set<CompletionDurabilityProvider>();
      const currentProvider = this.registry.current();
      if (currentProvider) providers.add(currentProvider);
      for (const pinned of this.#dispatches.values()) providers.add(pinned.provider);
      for (const pinned of this.#recoveredProviderPins.values()) providers.add(pinned.provider);
      await Promise.all([...providers].map((provider) => provider.prune(now)));
    });
  }

  receiveMessageEnd(message: unknown, currentTarget: CompletionTarget): Promise<boolean> {
    return this.#track(this.#receiveMessageEnd(message, currentTarget));
  }

  async #receiveMessageEnd(message: unknown, currentTarget: CompletionTarget): Promise<boolean> {
    const receipt = completionReceipt(message);
    if (!receipt || receipt.targetSessionId !== currentTarget.sessionId) return false;
    const binding = this.#binding && targetEquals(this.#binding.target, currentTarget)
      ? this.#binding
      : { target: currentTarget, entries: [], send: () => false } satisfies CompletionSessionBinding;
    for (const target of bindingTargets(binding)) {
      const records = await this.store.listForTarget(target);
      const record = records.find((entry) => entry.deliveryId === receipt.deliveryId);
      if (!record || receiptRevision(record) !== receipt.contentRevision || !targetEquals(record.target, target)) continue;
      await this.#apply(record);
      return true;
    }
    return false;
  }

  async redrive(): Promise<void> {
    if (!this.#binding) return;
    for (const target of bindingTargets(this.#binding)) await this.#deliverDue(target, true);
  }

  dispose(): void {
    this.#disposed = true;
    this.#binding = undefined;
    this.#acceptedByHost.clear();
    this.#deliveryInProgress.clear();
    for (const dispatchId of new Set([
      ...this.#dispatches.keys(),
      ...this.#recoveredProviderPins.keys(),
    ])) this.#releaseDispatch(dispatchId);
    this.#finalizedRecovery.clear();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  async #importRecoverable(target: CompletionTarget): Promise<void> {
    // First retry captured commit-point intents directly. This path cannot be
    // redirected by a later registry generation and does not depend on the new
    // provider being able to enumerate the old provider's storage root.
    for (const [deliveryId, recovery] of [...this.#finalizedRecovery]) {
      if (!targetEquals(recovery.intent.target, target)) continue;
      this.#ensureRecoveredProviderPin(recovery.intent.dispatchId, recovery.provider);
      try {
        await this.store.recoverFinalizedIntent(recovery.intent);
        this.#finalizedRecovery.delete(deliveryId);
      } catch (error) {
        logDiagnosticWarn(`[pi-maestro-teammate] finalized completion recovery retained for ${deliveryId}:`, error);
      }
    }

    // Generation-owned providers are authoritative for their dispatches. Query
    // them before the replaceable current provider, and contain enumeration per
    // provider so one unhealthy generation cannot silence another generation's
    // finalized intents or skip the delivery pass that follows this method.
    const providers = new Set<CompletionDurabilityProvider>();
    for (const pinned of this.#dispatches.values()) providers.add(pinned.provider);
    for (const pinned of this.#recoveredProviderPins.values()) providers.add(pinned.provider);
    const current = this.registry.current();
    if (current) providers.add(current);
    for (const provider of providers) {
      let recoverable: readonly CompletionIntent[];
      try {
        recoverable = await provider.listRecoverable(target);
      } catch (error) {
        logDiagnosticWarn("[pi-maestro-teammate] completion provider enumeration failed; continuing pinned reconciliation:", error);
        continue;
      }
      for (const intent of recoverable) {
        try {
          this.#ensureRecoveredProviderPin(intent.dispatchId, provider);
          await this.store.importIntent(intent);
        } catch (error) {
          if (error instanceof Error && /No live completion reservation/.test(error.message)) {
            try {
              await this.store.recoverFinalizedIntent(intent);
              continue;
            } catch (recoveryError) {
              // Finalization is irreversible. Keep the provider manifest and
              // its provider pin observable/retryable instead of abandoning it.
              this.#finalizedRecovery.set(intent.deliveryId, { intent, provider });
              logDiagnosticWarn(`[pi-maestro-teammate] finalized completion reservation recovery failed for ${intent.deliveryId}:`, recoveryError);
              continue;
            }
          }
          logDiagnosticWarn(`[pi-maestro-teammate] completion intent import failed for ${intent.deliveryId}:`, error);
        }
      }
    }
  }

  async #rebuildReceipts(target: CompletionTarget, entries: readonly unknown[]): Promise<void> {
    const receipts = entries.map(completionReceipt).filter((entry): entry is PersistedCompletionMessage => Boolean(entry));
    if (receipts.length === 0) return;
    const records = await this.store.listForTarget(target);
    for (const receipt of receipts) {
      const record = records.find((entry) => entry.deliveryId === receipt.deliveryId);
      if (record && receipt.targetSessionId === target.sessionId && receipt.contentRevision === receiptRevision(record)) {
        await this.#apply(record);
      }
    }
  }

  async #deliverDue(target: CompletionTarget, replayed: boolean): Promise<void> {
    const binding = this.#binding;
    if (!binding || !bindingAcceptsTarget(binding, target)) return;
    const now = this.#now();
    const records = await this.store.listForTarget(target);
    for (const candidate of records) {
      let record = candidate;
      if (record.state === "queued" && this.#acceptedByHost.has(record.deliveryId)) continue;
      if (record.state === "queued" && (record.receiptDeadlineAt ?? Number.MAX_SAFE_INTEGER) <= now) {
        if (record.attempts >= COMPLETION_OUTBOX_MAX_ATTEMPTS) {
          await this.store.markDead(target, record.deliveryId, "completion receipt retries exhausted");
          continue;
        }
        record = await this.store.returnToPending(target, record.deliveryId, "completion receipt deadline elapsed") ?? record;
      }
      if (record.state !== "pending" || record.nextAttemptAt > now) continue;
      // Reconciles from two provider generations may overlap. Fence delivery
      // before the first await so both passes cannot observe pending/queued on
      // opposite sides of markQueued and inject the same envelope twice.
      if (this.#acceptedByHost.has(record.deliveryId) || this.#deliveryInProgress.has(record.deliveryId)) continue;
      this.#deliveryInProgress.add(record.deliveryId);
      try {
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
          this.#acceptedByHost.add(record.deliveryId);
          try {
            await this.store.markQueued(target, record.deliveryId, now + RECEIPT_DEADLINE_MS);
          } catch (error) {
            // The model may already have the accepted envelope. Do not let this
            // escape to the caller, which would trigger a second direct send.
            // The durable pending record remains replayable and identifiable by
            // the same deliveryId if the first envelope never reaches message_end.
            logDiagnosticWarn(`[pi-maestro-teammate] accepted completion could not persist queued state for ${record.deliveryId}:`, error);
          }
        } else {
          await this.store.returnToPending(target, record.deliveryId, "sendMessage rejected completion");
        }
      } finally {
        this.#deliveryInProgress.delete(record.deliveryId);
      }
    }
  }

  async #apply(record: CompletionOutboxRecord): Promise<void> {
    if (record.state === "applied" && record.providerAcknowledgedAt !== undefined) return;
    const applied = await this.store.markApplied(record.target, record.deliveryId);
    if (!applied || applied.providerAcknowledgedAt !== undefined) return;
    this.#acceptedByHost.delete(applied.deliveryId);
    // Acknowledge through the provider that owns the dispatch, not whichever
    // provider happens to be current now — a registry replacement must not
    // strand the original manifest without a receipt.
    const provider = this.#pinnedProvider(applied.dispatchId);
    const receipt: CompletionAppliedReceipt = {
      deliveryId: applied.deliveryId,
      dispatchId: applied.dispatchId,
      target: applied.target,
      contentRevision: receiptRevision(applied),
      appliedAt: this.#now(),
    };
    try {
      await provider.acknowledgeApplied(receipt);
      await this.store.markProviderAcknowledged(applied.target, applied.deliveryId);
      // Delivery fully settled: release the pinned provider reference.
      if (this.#dispatches.get(applied.dispatchId)?.provider === provider
        || this.#recoveredProviderPins.get(applied.dispatchId)?.provider === provider) {
        this.#releaseDispatch(applied.dispatchId);
      }
    } catch (error) {
      logDiagnosticWarn(`[pi-maestro-teammate] completion provider acknowledgement failed for ${applied.deliveryId}:`, error);
    }
  }

  deliveryEnvelope(record: CompletionOutboxRecord, replayed: boolean): CompletionDeliveryEnvelope {
    const resources = record.resources.map((resource) => resource.uri);
    const suffix = resources.length > 0 ? `\n\nResults: ${resources.join(", ")}` : "";
    const provenance: VerifiedMessageProvenanceV1 = {
      version: MESSAGE_PROVENANCE_VERSION,
      messageId: record.dispatchId,
      source: "completion-outbox",
      messageKind: "result",
      deliveryMode: "notify",
      confidence: "verified",
      sender: { kind: "system", ownerId: record.target.sessionId, label: "completion-outbox" },
    };
    return {
      customType: "teammate-complete",
      content: `${record.summary}${suffix}`,
      display: true,
      details: {
        source: "completion-outbox",
        deliveryId: record.deliveryId,
        contentRevision: receiptRevision(record),
        targetSessionId: record.target.sessionId,
        dispatchId: record.dispatchId,
        mode: record.kind === "graph" ? "graph" : "single",
        resources,
        replayed,
        provenance,
      },
    };
  }

  #scheduleReconcile(): void {
    let finish = (): void => undefined;
    const tracked = new Promise<void>((resolve) => { finish = resolve; });
    this.#deferred.add(tracked);
    this.#defer(() => {
      void this.reconcile().catch((error) => {
        logDiagnosticWarn("[pi-maestro-teammate] deferred completion reconciliation failed:", error);
      }).finally(() => {
        this.#deferred.delete(tracked);
        finish();
      });
    });
  }

  #ensureRecoveredProviderPin(
    dispatchId: string,
    provider: CompletionDurabilityProvider,
  ): void {
    if (this.#dispatches.has(dispatchId)) return;
    const current = this.#recoveredProviderPins.get(dispatchId);
    if (current) {
      if (current.provider !== provider) {
        throw new Error(`Completion dispatch ${dispatchId} recovery changed provider ownership.`);
      }
      return;
    }
    this.#recoveredProviderPins.set(dispatchId, {
      provider,
      release: this.registry.pinDispatch(dispatchId, provider),
    });
  }

  #pinnedProvider(dispatchId: string): CompletionDurabilityProvider {
    const pinned = this.#dispatches.get(dispatchId);
    if (pinned) return pinned.provider;
    const recovered = this.#recoveredProviderPins.get(dispatchId);
    if (recovered) return recovered.provider;
    const provider = this.registry.providerForDispatch(dispatchId) ?? this.registry.current();
    if (!provider) throw new Error("Completion durability provider became unavailable.");
    return provider;
  }

  #releaseDispatch(dispatchId: string): void {
    const pinned = this.#dispatches.get(dispatchId);
    if (pinned) {
      this.#dispatches.delete(dispatchId);
      pinned.releaseProviderPin();
    }
    const recovered = this.#recoveredProviderPins.get(dispatchId);
    if (recovered) {
      this.#recoveredProviderPins.delete(dispatchId);
      recovered.release();
    }
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    this.#operations.add(operation);
    void operation.finally(() => this.#operations.delete(operation)).catch(() => undefined);
    return operation;
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
