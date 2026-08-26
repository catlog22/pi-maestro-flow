/**
 * Mailbox consumer: single-claimer per recipient with priority scheduler,
 * heartbeat renewal, and stale claim reclaim.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  activateMailboxOwner,
  deactivateMailboxOwner,
  isMailboxClaimOwnerLive,
  MailboxFileStore,
} from "./file-store.ts";
import { type MailboxRouter } from "./router.ts";
import { RuntimeBrokerError } from "../../runtime-broker/contracts.ts";
import {
  type MailboxClaim,
  type MailboxEnvelope,
  type MailboxOwnerFence,
  type MailboxPriority,
  CLAIM_HEARTBEAT_MS,
  CLAIM_LEASE_MS,
  CLAIM_RENEW_MS,
  MAX_DISPATCH_RETRIES,
  MESSAGE_ID_PATTERN,
  POLL_INTERVAL_MS,
  STARVATION_BOUND,
} from "./types.ts";

// --- Priority Scheduling ---

const PRIORITY_ORDER: MailboxPriority[] = ["critical", "high", "normal"];

/**
 * Select the next message to dispatch from a sorted candidate list.
 * Enforces starvation bound: after STARVATION_BOUND consecutive high-priority
 * dispatches, service one normal-priority message if available.
 */
export function selectNext(
  candidates: MailboxEnvelope[],
  consecutiveHigh: number,
): MailboxEnvelope | undefined {
  if (candidates.length === 0) return undefined;

  const byPriority: Record<MailboxPriority, MailboxEnvelope[]> = {
    critical: [],
    high: [],
    normal: [],
  };
  for (const env of candidates) {
    byPriority[env.priority].push(env);
  }
  // FIFO within each priority lane. senderSeq is a per-sender in-memory
  // counter (it resets on sender restart and collides across senders), so it
  // cannot provide a global order; the enqueue timestamp governs, with
  // senderSeq breaking same-millisecond ties (preserving per-sender FIFO for
  // bursts) and messageId as a final deterministic tiebreak.
  for (const lane of PRIORITY_ORDER) {
    byPriority[lane].sort((a, b) =>
      (a.createdAt - b.createdAt)
      || (a.senderSeq - b.senderSeq)
      || a.messageId.localeCompare(b.messageId));
  }

  // Starvation bound: after 8 consecutive high/critical, force one normal
  if (consecutiveHigh >= STARVATION_BOUND && byPriority.normal.length > 0) {
    return byPriority.normal[0];
  }

  // Otherwise pick highest priority available
  for (const lane of PRIORITY_ORDER) {
    if (byPriority[lane].length > 0) return byPriority[lane][0];
  }
  return undefined;
}

/** Whether a priority counts toward the starvation bound. */
export function isHighPriority(priority: MailboxPriority): boolean {
  return priority === "critical" || priority === "high";
}

// --- Consumer Events ---

export interface ConsumerDispatchEvent {
  messageId: string;
  envelope: MailboxEnvelope;
}

export interface ConsumerAckEvent {
  messageId: string;
}

export interface ConsumerErrorEvent {
  messageId: string;
  error: string;
}

// --- Consumer ---

export type MailboxDispatchDisposition = "applied" | "deferred";

export interface MailboxConsumerOptions {
  store: MailboxFileStore;
  router: MailboxRouter;
  /** Unique nonce identifying this consumer instance. */
  consumerNonce?: string;
  /** Stable host owner id used with the per-consumer nonce. */
  ownerId?: string;
  /** Session generation captured by this consumer incarnation. */
  sessionGeneration?: number;
  /** Recipient correlation ID this consumer serves. */
  recipientCorrelationId: string;
  /** Workspace ID the consumer serves; messages from other workspaces are skipped. */
  workspaceId: string;
  /** Persist the authoritative applied effect before child injection or acknowledgement. */
  commitApplied?: (envelope: MailboxEnvelope) => Promise<void>;
  /** Callback invoked when a message is ready for injection. */
  onDispatch: (envelope: MailboxEnvelope) => Promise<MailboxDispatchDisposition | void>;
  /** Poll interval override (default 50ms). */
  pollMs?: number;
  now?: () => number;
}

export class MailboxConsumer extends EventEmitter {
  readonly consumerNonce: string;
  readonly recipientCorrelationId: string;
  readonly workspaceId: string;
  readonly ownerFence: MailboxOwnerFence;

  readonly #store: MailboxFileStore;
  readonly #router: MailboxRouter;
  readonly #commitApplied: ((envelope: MailboxEnvelope) => Promise<void>) | undefined;
  readonly #onDispatch: (envelope: MailboxEnvelope) => Promise<MailboxDispatchDisposition | void>;
  readonly #pollMs: number;
  readonly #now: () => number;

  #timer: ReturnType<typeof setInterval> | undefined;
  #polling: Promise<void> | undefined;
  #consecutiveHigh = 0;
  #dispatchFailures = new Map<string, number>();
  #commitDeferredUntil = new Map<string, number>();
  #activeClaim: { messageId: string; claim: MailboxClaim; renewTimer: ReturnType<typeof setInterval> } | undefined;
  #acceptedHeartbeats = new Map<string, { claim: MailboxClaim; timer: ReturnType<typeof setInterval> }>();
  #acknowledgements = new Map<string, Promise<boolean>>();
  #ownerActive = false;
  #stopped = false;

  constructor(options: MailboxConsumerOptions) {
    super();
    this.consumerNonce = options.consumerNonce ?? randomUUID();
    this.recipientCorrelationId = options.recipientCorrelationId;
    this.workspaceId = options.workspaceId;
    this.ownerFence = {
      ownerId: options.ownerId ?? this.consumerNonce,
      ownerNonce: this.consumerNonce,
      sessionGeneration: options.sessionGeneration ?? 0,
      ownerPid: process.pid,
    };
    this.#store = options.store;
    this.#router = options.router;
    this.#commitApplied = options.commitApplied;
    this.#onDispatch = options.onDispatch;
    this.#pollMs = options.pollMs ?? POLL_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
  }

  start(): void {
    if (this.#timer) return;
    this.#stopped = false;
    this.#activateOwner();
    void this.#pollSafe();
    this.#timer = setInterval(() => void this.#pollSafe(), this.#pollMs);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#polling?.catch(() => undefined);
    // Ack work is allowed to finish while this incarnation still owns its
    // ACCEPTED records. Only then are heartbeat/owner authority released.
    await Promise.allSettled([...this.#acknowledgements.values()]);
    this.#stopRenewTimer();
    for (const messageId of [...this.#acceptedHeartbeats.keys()]) this.#stopAcceptedHeartbeat(messageId);
    if (this.#ownerActive) {
      deactivateMailboxOwner(this.ownerFence);
      this.#ownerActive = false;
    }
  }

  /** True only while this incarnation owns mutation/GC authority. */
  ownsMutationAuthority(): boolean {
    return this.#ownerActive && !this.#stopped;
  }

  /** Notify the consumer that same-process messages may be available. */
  notify(): void {
    if (this.#stopped) return;
    void this.#pollSafe();
  }

  /**
   * Poll wrapper that never rejects. The poll chain can throw before reaching
   * the dispatch try/catch (stale-claim reclaim, listMessages, readEnvelope —
   * any non-ENOENT fs error such as EPERM/EACCES on Windows). Escaping a
   * `setInterval` callback as an unhandled rejection would terminate the host
   * process, so surface it as an "error" event when a listener exists and
   * otherwise swallow it to keep the host alive.
   */
  #pollSafe(): Promise<void> {
    return this.#poll().catch((error) => {
      if (this.listenerCount("error") > 0) {
        this.emit("error", {
          messageId: "",
          error: error instanceof Error ? error.message : String(error),
        } satisfies ConsumerErrorEvent);
      }
    });
  }

  /**
   * Acknowledge that a message was successfully injected and confirmed via IPC.
   * Transitions ACCEPTED → APPLIED. In-process dispatch already auto-applies;
   * this entry point serves external IPC-ack consumers and is idempotent.
   */
  async acknowledge(messageId: string): Promise<boolean> {
    if (this.#stopped || !MESSAGE_ID_PATTERN.test(messageId)) return false;
    this.#activateOwner();
    const existing = this.#acknowledgements.get(messageId);
    if (existing) return existing;
    const operation = this.#acknowledgeWithRetry(messageId).finally(() => {
      if (this.#acknowledgements.get(messageId) === operation) this.#acknowledgements.delete(messageId);
    });
    this.#acknowledgements.set(messageId, operation);
    return operation;
  }

  async #acknowledgeWithRetry(messageId: string): Promise<boolean> {
    const delays = [0, 25, 50, 100, 200, 400];
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (delays[attempt]! > 0) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      try {
        const accepted = await this.#store.readEnvelope("accepted", messageId);
        if (!accepted) return false;
        const record = await this.#store.readStateRecord("accepted", messageId);
        if (record?.claim && !this.#ownsClaim(record.claim)) return false;
        await this.#commitApplied?.(accepted);
        const applied = await this.#store.apply(messageId, this.ownerFence);
        if (applied) {
          this.#stopAcceptedHeartbeat(messageId);
          this.emit("ack", { messageId } satisfies ConsumerAckEvent);
          return true;
        }
        return false;
      } catch (error) {
        if (attempt === delays.length - 1) {
          if (this.listenerCount("error") > 0) {
            this.emit("error", {
              messageId,
              error: error instanceof Error ? error.message : String(error),
            } satisfies ConsumerErrorEvent);
          }
          return false; // ACCEPTED is retained for later retry/recovery.
        }
      }
    }
    return false;
  }

  /**
   * Replay messages stranded in accepted (crashed mid-dispatch, no ack) back
   * to ready so they are re-dispatched after a restart. At-least-once delivery.
   */
  async replayAcceptedToReady(): Promise<number> {
    let replayed = 0;
    const acceptedIds = await this.#store.listMessages("accepted");
    for (const messageId of acceptedIds) {
      const envelope = await this.#store.readEnvelope("accepted", messageId);
      if (!envelope) continue;
      // Workspace isolation: only replay messages this consumer serves.
      if (envelope.workspaceId !== this.workspaceId) continue;
      const record = await this.#store.readStateRecord("accepted", messageId);
      // Modern records carry a process/incarnation fence. Legacy ACCEPTED
      // records cannot prove a live owner and are conservatively migrated back
      // to ready during startup.
      if (record?.claim?.ownerId !== undefined && isMailboxClaimOwnerLive(record.claim, this.#now())) continue;
      const moved = await this.#store.requeue(messageId, "accepted", { allowTakeover: true });
      if (moved) replayed += 1;
    }
    return replayed;
  }

  /**
   * Reclaim stale claims: if a claimed message's heartbeat is older than
   * CLAIM_STALE_MS, move it back to ready for re-claim.
   */
  async reclaimStaleClaims(): Promise<string[]> {
    const now = this.#now();
    const reclaimed: string[] = [];
    const claimedIds = await this.#store.listMessages("claimed");

    for (const messageId of claimedIds) {
      const record = await this.#store.readStateRecord("claimed", messageId);
      // Recordless claimed entries are recognized incomplete legacy
      // transitions. A valid live owner remains authoritative; otherwise the
      // journalled reverse transition preserves the sole envelope.
      if (record?.claim && isMailboxClaimOwnerLive(record.claim, now)) continue;
      const moved = await this.#store.requeue(messageId, "claimed", { allowTakeover: true });
      if (moved) reclaimed.push(messageId);
    }
    return reclaimed;
  }

  async #poll(): Promise<void> {
    if (this.#polling) return this.#polling;
    this.#polling = this.#doPoll();
    try {
      await this.#polling;
    } finally {
      this.#polling = undefined;
    }
  }

  async #doPoll(): Promise<void> {
    if (this.#stopped) return;

    // First reclaim any stale claims
    await this.reclaimStaleClaims();
    if (this.#stopped) return;

    // Skip if we already have an active claim being processed
    if (this.#activeClaim) return;

    // List ready messages for this recipient
    const readyIds = await this.#store.listMessages("ready");
    const candidates: MailboxEnvelope[] = [];

    for (const messageId of readyIds) {
      const envelope = await this.#store.readEnvelope("ready", messageId);
      if (!envelope) {
        // Unreadable (tampered/corrupt/oversized) — dead-letter rather than stall.
        await this.#store.dead(messageId, "ready", "envelope unreadable or integrity check failed").catch(() => undefined);
        continue;
      }
      if (this.#stopped) return;
      // Workspace isolation: never consume messages from other workspaces.
      if (envelope.workspaceId !== this.workspaceId) continue;
      // "*" consumer matches every recipient owned by this host; foreign
      // recipients are left in ready for another pi process in the workspace.
      if (this.recipientCorrelationId !== "*"
        && envelope.recipientCorrelationId !== this.recipientCorrelationId) continue;
      if (this.recipientCorrelationId === "*"
        && !this.#router.managesRecipient(envelope.recipientCorrelationId)) continue;
      // Check expiry
      const now = this.#now();
      if (now > envelope.expiresAt) {
        this.#commitDeferredUntil.delete(messageId);
        await this.#store.expire(messageId);
        continue;
      }
      // A live broker lease is authority contention, not a failed child
      // dispatch. Leave the envelope ready and do not reacquire it until the
      // broker-provided deadline; otherwise a quick restart burns the ordinary
      // retry budget long before the orphaned lease can expire.
      const commitDeferredUntil = this.#commitDeferredUntil.get(messageId);
      if (commitDeferredUntil !== undefined) {
        if (now < commitDeferredUntil) continue;
        this.#commitDeferredUntil.delete(messageId);
      }
      candidates.push(envelope);
    }

    if (candidates.length === 0) return;

    // Select the next dispatchable message. A message whose recipient is
    // fenced ("hold") must stay in ready, but it must not head-of-line block
    // every other recipient in the workspace: skip that recipient for this
    // round (preserving its per-recipient order) and keep selecting.
    let pool = candidates;
    let next: MailboxEnvelope | undefined;
    while (pool.length > 0) {
      const candidate = selectNext(pool, this.#consecutiveHigh);
      if (!candidate) return;

      // Revalidate authority before dispatch
      const validation = await this.#router.revalidateForDispatch(candidate);
      if (this.#stopped) return;
      if (validation.allowed) {
        next = candidate;
        break;
      }
      if (validation.action === "dead") {
        await this.#store.dead(candidate.messageId, "ready", validation.reason ?? "revalidation failed");
        pool = pool.filter((envelope) => envelope.messageId !== candidate.messageId);
      } else {
        // "hold": leave in ready and skip this recipient's queue for now.
        pool = pool.filter((envelope) => envelope.recipientCorrelationId !== candidate.recipientCorrelationId);
      }
    }
    if (!next) return;

    // Claim the message
    const now = this.#now();
    const claim: MailboxClaim = {
      messageId: next.messageId,
      claimerNonce: this.consumerNonce,
      ownerId: this.ownerFence.ownerId,
      ownerNonce: this.ownerFence.ownerNonce,
      sessionGeneration: this.ownerFence.sessionGeneration,
      ownerPid: this.ownerFence.ownerPid,
      claimedAt: now,
      leaseExpiresAt: now + CLAIM_LEASE_MS,
      lastHeartbeatAt: now,
    };

    const claimed = await this.#store.claim(next.messageId, claim);
    if (!claimed) return; // Another consumer got it

    // Start heartbeat renewal
    this.#startRenewTimer(next.messageId, claim);

    let failurePhase: "commit" | "dispatch" = "commit";
    try {
      // Transition to accepted (injection dispatched)
      const accepted = await this.#store.accept(next.messageId, claim);
      if (!accepted) {
        this.#stopRenewTimer();
        return;
      }
      this.#stopRenewTimer();
      this.#startAcceptedHeartbeat(next.messageId, claim);

      // The broker inbox receipt and mailbox.applied domain event commit before
      // any child-visible injection. The file ACCEPTED/APPLIED states below are
      // compatibility projections of that authoritative transaction.
      // Once a claim is accepted, stop() drains this active unit instead of
      // abandoning it half-way through adoption/ack publication.
      if (next.mode !== "notify") await this.#commitApplied?.(next);

      // Dispatch to the child
      failurePhase = "dispatch";
      this.emit("dispatch", { messageId: next.messageId, envelope: next } satisfies ConsumerDispatchEvent);
      const disposition = await this.#onDispatch(next);

      // Deferred context remains ACCEPTED until a substantive turn consumes it
      // and explicitly acknowledges the mailbox messageId. Crash recovery moves
      // accepted records back to ready, preserving at-least-once delivery.
      this.#commitDeferredUntil.delete(next.messageId);
      this.#dispatchFailures.delete(next.messageId);
      if (disposition !== "deferred") await this.#completeDispatch(next.messageId);

      // Track starvation bound
      if (isHighPriority(next.priority)) {
        this.#consecutiveHigh++;
      } else {
        this.#consecutiveHigh = 0;
      }
    } catch (error) {
      this.emit("error", {
        messageId: next.messageId,
        error: error instanceof Error ? error.message : String(error),
      } satisfies ConsumerErrorEvent);
      const commitDeferredUntil = failurePhase === "commit"
        ? leaseUnavailableExpiresAt(error)
        : undefined;
      if (commitDeferredUntil !== undefined) {
        // lease_unavailable remains fail-closed: do not publish to the child.
        // Requeue without consuming the child-dispatch retry budget, and use
        // the broker's authority clock deadline to avoid a 50ms hot loop.
        this.#commitDeferredUntil.set(next.messageId, commitDeferredUntil);
        await this.#requeueAccepted(next);
      } else {
        const failures = (this.#dispatchFailures.get(next.messageId) ?? 0) + 1;
        if (failures >= MAX_DISPATCH_RETRIES) {
          // Bounded retries: dead-letter instead of hot-looping every poll.
          this.#commitDeferredUntil.delete(next.messageId);
          this.#dispatchFailures.delete(next.messageId);
          this.#stopAcceptedHeartbeat(next.messageId);
          await this.#store.dead(
            next.messageId,
            "accepted",
            "dispatch retries exceeded",
            this.ownerFence,
          ).catch(() => undefined);
        } else {
          // On dispatch failure, move back to ready for retry
          this.#dispatchFailures.set(next.messageId, failures);
          await this.#requeueAccepted(next);
        }
      }
    } finally {
      this.#stopRenewTimer();
    }
  }

  async #requeueAccepted(envelope: MailboxEnvelope): Promise<void> {
    const requeued = await this.#store.requeue(envelope.messageId, "accepted", { owner: this.ownerFence });
    if (requeued) this.#stopAcceptedHeartbeat(envelope.messageId);
  }

  /** Transition ACCEPTED → APPLIED and emit the ack event. */
  async #completeDispatch(messageId: string): Promise<void> {
    const applied = await this.#store.apply(messageId, this.ownerFence);
    if (!applied) return;
    this.#stopAcceptedHeartbeat(messageId);
    this.emit("ack", { messageId } satisfies ConsumerAckEvent);
  }

  #startRenewTimer(messageId: string, baseClaim: MailboxClaim): void {
    this.#stopRenewTimer();
    const renewTimer = setInterval(() => {
      const now = this.#now();
      const renewedClaim: MailboxClaim = {
        ...baseClaim,
        lastHeartbeatAt: now,
        leaseExpiresAt: now + CLAIM_LEASE_MS,
      };
      void this.#store.renewClaim(messageId, renewedClaim).catch(() => undefined);
    }, CLAIM_RENEW_MS);
    renewTimer.unref?.();
    this.#activeClaim = { messageId, claim: baseClaim, renewTimer };
  }

  #startAcceptedHeartbeat(messageId: string, baseClaim: MailboxClaim): void {
    this.#stopAcceptedHeartbeat(messageId);
    const timer = setInterval(() => {
      const now = this.#now();
      const current = this.#acceptedHeartbeats.get(messageId);
      if (!current) return;
      const renewed: MailboxClaim = {
        ...current.claim,
        lastHeartbeatAt: now,
        leaseExpiresAt: now + CLAIM_LEASE_MS,
      };
      current.claim = renewed;
      void this.#store.renewAccepted(messageId, renewed).then((owned) => {
        if (!owned) this.#stopAcceptedHeartbeat(messageId);
      }).catch(() => undefined);
    }, CLAIM_HEARTBEAT_MS);
    timer.unref?.();
    this.#acceptedHeartbeats.set(messageId, { claim: baseClaim, timer });
  }

  #stopAcceptedHeartbeat(messageId: string): void {
    const current = this.#acceptedHeartbeats.get(messageId);
    if (!current) return;
    clearInterval(current.timer);
    this.#acceptedHeartbeats.delete(messageId);
  }

  #ownsClaim(claim: MailboxClaim): boolean {
    if (claim.ownerId === undefined) return true; // legacy records have no stronger fence.
    return claim.ownerId === this.ownerFence.ownerId
      && claim.ownerNonce === this.ownerFence.ownerNonce
      && claim.sessionGeneration === this.ownerFence.sessionGeneration
      && claim.ownerPid === this.ownerFence.ownerPid;
  }

  #activateOwner(): void {
    if (this.#ownerActive) return;
    activateMailboxOwner(this.ownerFence);
    this.#ownerActive = true;
  }

  #stopRenewTimer(): void {
    if (this.#activeClaim) {
      clearInterval(this.#activeClaim.renewTimer);
      this.#activeClaim = undefined;
    }
  }
}

function leaseUnavailableExpiresAt(error: unknown): number | undefined {
  if (!(error instanceof RuntimeBrokerError) || error.code !== "lease_unavailable") return undefined;
  const expiresAt = error.details?.expiresAt;
  return typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt >= 0
    ? expiresAt
    : undefined;
}
