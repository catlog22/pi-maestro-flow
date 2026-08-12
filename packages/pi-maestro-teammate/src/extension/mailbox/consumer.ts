/**
 * Mailbox consumer: single-claimer per recipient with priority scheduler,
 * heartbeat renewal, and stale claim reclaim.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { MailboxFileStore } from "./file-store.ts";
import { type MailboxRouter } from "./router.ts";
import {
  type MailboxClaim,
  type MailboxEnvelope,
  type MailboxPriority,
  CLAIM_HEARTBEAT_MS,
  CLAIM_LEASE_MS,
  CLAIM_RENEW_MS,
  CLAIM_STALE_MS,
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

export interface MailboxConsumerOptions {
  store: MailboxFileStore;
  router: MailboxRouter;
  /** Unique nonce identifying this consumer instance. */
  consumerNonce?: string;
  /** Recipient correlation ID this consumer serves. */
  recipientCorrelationId: string;
  /** Workspace ID the consumer serves; messages from other workspaces are skipped. */
  workspaceId: string;
  /** Callback invoked when a message is ready for injection. */
  onDispatch: (envelope: MailboxEnvelope) => Promise<void>;
  /** Poll interval override (default 50ms). */
  pollMs?: number;
  now?: () => number;
}

export class MailboxConsumer extends EventEmitter {
  readonly consumerNonce: string;
  readonly recipientCorrelationId: string;
  readonly workspaceId: string;

  readonly #store: MailboxFileStore;
  readonly #router: MailboxRouter;
  readonly #onDispatch: (envelope: MailboxEnvelope) => Promise<void>;
  readonly #pollMs: number;
  readonly #now: () => number;

  #timer: ReturnType<typeof setInterval> | undefined;
  #polling: Promise<void> | undefined;
  #consecutiveHigh = 0;
  #dispatchFailures = new Map<string, number>();
  #activeClaim: { messageId: string; claim: MailboxClaim; renewTimer: ReturnType<typeof setInterval> } | undefined;
  #stopped = false;

  constructor(options: MailboxConsumerOptions) {
    super();
    this.consumerNonce = options.consumerNonce ?? randomUUID();
    this.recipientCorrelationId = options.recipientCorrelationId;
    this.workspaceId = options.workspaceId;
    this.#store = options.store;
    this.#router = options.router;
    this.#onDispatch = options.onDispatch;
    this.#pollMs = options.pollMs ?? POLL_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
  }

  start(): void {
    if (this.#timer) return;
    this.#stopped = false;
    void this.#pollSafe();
    this.#timer = setInterval(() => void this.#pollSafe(), this.#pollMs);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#stopRenewTimer();
    await this.#polling?.catch(() => undefined);
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
    if (!MESSAGE_ID_PATTERN.test(messageId)) return false;
    const applied = await this.#store.apply(messageId);
    if (applied) {
      this.emit("ack", { messageId } satisfies ConsumerAckEvent);
    }
    return applied;
  }

  /**
   * Replay messages stranded in accepted (crashed mid-dispatch, no ack) back
   * to ready so they are re-dispatched after a restart. At-least-once delivery.
   */
  async replayAcceptedToReady(): Promise<number> {
    if (this.#stopped) return 0;
    let replayed = 0;
    const acceptedIds = await this.#store.listMessages("accepted");
    for (const messageId of acceptedIds) {
      if (this.#stopped) break;
      const envelope = await this.#store.readEnvelope("accepted", messageId);
      if (!envelope) continue;
      // Workspace isolation: only replay messages this consumer serves.
      if (envelope.workspaceId !== this.workspaceId) continue;
      await this.#store.remove("accepted", messageId);
      await this.#store.writeStaging(envelope);
      await this.#store.promoteToReady(messageId);
      replayed += 1;
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
      if (!record?.claim) continue;
      const staleThreshold = record.claim.lastHeartbeatAt + CLAIM_STALE_MS;
      if (now >= staleThreshold) {
        // Move back to ready by reversing the claim transition
        const envelope = await this.#store.readEnvelope("claimed", messageId);
        if (!envelope) continue;
        // Remove from claimed, write back to ready
        await this.#store.remove("claimed", messageId);
        await this.#store.removeClaimLock(messageId);
        await this.#store.writeStaging(envelope);
        await this.#store.promoteToReady(messageId);
        reclaimed.push(messageId);
      }
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
      if (this.#now() > envelope.expiresAt) {
        await this.#store.expire(messageId);
        continue;
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
      claimedAt: now,
      leaseExpiresAt: now + CLAIM_LEASE_MS,
      lastHeartbeatAt: now,
    };

    const claimed = await this.#store.claim(next.messageId, claim);
    if (!claimed) return; // Another consumer got it

    // Start heartbeat renewal
    this.#startRenewTimer(next.messageId, claim);

    try {
      // Transition to accepted (injection dispatched)
      const accepted = await this.#store.accept(next.messageId, claim);
      if (!accepted) {
        this.#stopRenewTimer();
        return;
      }

      // Dispatch to the child
      this.emit("dispatch", { messageId: next.messageId, envelope: next } satisfies ConsumerDispatchEvent);
      await this.#onDispatch(next);

      // In-process dispatch success is the delivery confirmation: ACCEPTED → APPLIED.
      this.#dispatchFailures.delete(next.messageId);
      await this.#completeDispatch(next.messageId);

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
      const failures = (this.#dispatchFailures.get(next.messageId) ?? 0) + 1;
      if (failures >= MAX_DISPATCH_RETRIES) {
        // Bounded retries: dead-letter instead of hot-looping every poll.
        this.#dispatchFailures.delete(next.messageId);
        await this.#store.dead(next.messageId, "accepted", "dispatch retries exceeded").catch(() => undefined);
      } else {
        // On dispatch failure, move back to ready for retry
        this.#dispatchFailures.set(next.messageId, failures);
        await this.#store.remove("accepted", next.messageId);
        await this.#store.writeStaging(next);
        await this.#store.promoteToReady(next.messageId);
      }
    } finally {
      this.#stopRenewTimer();
    }
  }

  /** Transition ACCEPTED → APPLIED and emit the ack event. */
  async #completeDispatch(messageId: string): Promise<void> {
    await this.#store.apply(messageId);
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

  #stopRenewTimer(): void {
    if (this.#activeClaim) {
      clearInterval(this.#activeClaim.renewTimer);
      this.#activeClaim = undefined;
    }
  }
}
