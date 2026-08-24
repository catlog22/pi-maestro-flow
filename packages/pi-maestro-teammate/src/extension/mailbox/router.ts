/**
 * Mailbox router: route validation, authority revalidation, quota admission,
 * and fenced-queue semantics.
 */

import { randomUUID } from "node:crypto";
import {
  MESSAGE_PROVENANCE_VERSION,
  normalizeMessageProvenanceV1,
  type MessageProvenanceKind,
  type MessageProvenanceV1,
  type VerifiedMessageProvenanceV1,
} from "../../shared/types.ts";
import { MailboxFileStore } from "./file-store.ts";
import { QuotaAdmission } from "./gc.ts";
import {
  type MailboxDeliveryMode,
  type MailboxEnvelope,
  type MailboxEnqueueResult,
  type MailboxMessageKind,
  type MailboxPriority,
  CORRELATION_ID_PATTERN,
  MAILBOX_SCHEMA_VERSION,
  MAX_PAYLOAD_BYTES,
  priorityForKind,
  SAFE_ID_PATTERN,
  TTL_NORMAL_MS,
  TTL_STEER_MS,
} from "./types.ts";

// --- Authority Context ---

/** Injected authority checks for route and lease validation. */
export interface MailboxAuthority {
  /** Validate that the sender can route to the recipient. */
  canRoute(senderId: string, recipientCorrelationId: string, mode: MailboxDeliveryMode): { allowed: boolean; reason?: string };
  /** Current session generation for revalidation. */
  currentGeneration(): number;
  /** Current lease epoch for the recipient (unbound when no recipient). */
  currentLeaseEpoch(recipientCorrelationId?: string): number;
  /** Current lease nonce for the recipient (unbound when no recipient). */
  currentLeaseNonce(recipientCorrelationId?: string): string;
  /** Whether the recipient agent is fenced (queued but not dispatched). */
  isFenced(recipientCorrelationId: string): boolean;
  /** Whether the recipient agent is stale/unauthorized (should dead-letter). */
  isStaleUnauthorized(recipientCorrelationId: string): boolean;
  /** Whether this host instance owns the recipient (local activeRuns). */
  managesRecipient(recipientCorrelationId: string): boolean;
}

// --- Enqueue Request ---

export interface MailboxEnqueueRequest {
  workspaceId: string;
  teamId: string;
  senderId: string;
  recipientId: string;
  recipientCorrelationId: string;
  kind: MailboxMessageKind;
  mode: MailboxDeliveryMode;
  payload: string;
  provenance?: MessageProvenanceV1;
  requestId?: string;
  correlationId?: string;
}

// --- TTL Resolution ---

function ttlForKind(kind: MailboxMessageKind): number {
  switch (kind) {
    case "steer":
    case "control":
      return TTL_STEER_MS;
    default:
      return TTL_NORMAL_MS;
  }
}

function provenanceKindForMailbox(kind: MailboxMessageKind): MessageProvenanceKind {
  switch (kind) {
    case "task": return "task";
    case "result": return "result";
    case "lifecycle": return "lifecycle";
    case "control": return "control";
    case "steer":
    case "follow_up":
      return "message";
  }
}

// --- Router ---

export interface MailboxRouterOptions {
  store: MailboxFileStore;
  authority: MailboxAuthority;
  quota: QuotaAdmission;
  /** Workspace this router belongs to; enqueue requests from other workspaces are rejected. */
  workspaceId?: string;
  now?: () => number;
}

export class MailboxRouter {
  readonly #store: MailboxFileStore;
  readonly #authority: MailboxAuthority;
  readonly #quota: QuotaAdmission;
  readonly #workspaceId: string | undefined;
  readonly #now: () => number;
  #senderSeqBySender = new Map<string, number>();

  constructor(options: MailboxRouterOptions) {
    this.#store = options.store;
    this.#authority = options.authority;
    this.#quota = options.quota;
    this.#workspaceId = options.workspaceId;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Enqueue a message through the full authority + quota pipeline.
   * Returns a result indicating success (message in ready state) or failure code.
   */
  async enqueue(request: MailboxEnqueueRequest): Promise<MailboxEnqueueResult> {
    const now = this.#now();

    // 0. Workspace isolation: reject cross-workspace enqueue attempts.
    if (this.#workspaceId !== undefined && request.workspaceId !== this.#workspaceId) {
      return { ok: false, code: "route_invalid", message: "workspace mismatch: message from another workspace" };
    }

    // 0.5 Validate identifiers before any routing or path construction. senderId
    // and workspaceId are joined into file paths and authority decisions, so
    // reject anything unsafe (traversal, separators, empty). "caller" (the root
    // tool identity) already matches SAFE_ID_PATTERN.
    if (!SAFE_ID_PATTERN.test(request.senderId)) {
      return { ok: false, code: "route_invalid", message: "invalid senderId" };
    }
    if (!SAFE_ID_PATTERN.test(request.workspaceId)) {
      return { ok: false, code: "route_invalid", message: "invalid workspaceId" };
    }
    if (!CORRELATION_ID_PATTERN.test(request.recipientCorrelationId)) {
      return { ok: false, code: "route_invalid", message: "invalid recipientCorrelationId" };
    }

    // 1. Validate route
    const route = this.#authority.canRoute(request.senderId, request.recipientCorrelationId, request.mode);
    if (!route.allowed) {
      return { ok: false, code: "route_invalid", message: route.reason ?? "route validation failed" };
    }

    // 2. Check payload size
    const payloadBytes = Buffer.byteLength(request.payload, "utf8");
    if (payloadBytes > MAX_PAYLOAD_BYTES) {
      return { ok: false, code: "payload_too_large", message: `payload exceeds ${MAX_PAYLOAD_BYTES} bytes` };
    }

    // 3. Resolve priority and check quota
    const priority: MailboxPriority = priorityForKind(request.kind);
    const admission = await this.#quota.check(priority);
    if (!admission.allowed) {
      return { ok: false, code: "quota_exceeded", message: `quota exceeded (live: ${admission.live})` };
    }

    // 4. Build envelope
    const messageId = randomUUID();
    const generatedProvenance: VerifiedMessageProvenanceV1 = {
      version: MESSAGE_PROVENANCE_VERSION,
      messageId,
      source: "mailbox",
      messageKind: provenanceKindForMailbox(request.kind),
      deliveryMode: request.mode,
      confidence: "verified",
      sender: request.senderId === "caller"
        ? { kind: "root-agent", ownerId: request.teamId, label: "caller" }
        : { kind: "system", ownerId: request.senderId, label: request.senderId },
    };
    const provenance = request.provenance === undefined
      ? generatedProvenance
      : normalizeMessageProvenanceV1(request.provenance);
    const ttlMs = ttlForKind(request.kind);
    const senderSeq = (this.#senderSeqBySender.get(request.senderId) ?? 0) + 1;
    this.#senderSeqBySender.set(request.senderId, senderSeq);
    const envelopeBase: Omit<MailboxEnvelope, "hash"> = {
      messageId,
      schemaVersion: MAILBOX_SCHEMA_VERSION,
      workspaceId: request.workspaceId,
      teamId: request.teamId,
      senderId: request.senderId,
      recipientId: request.recipientId,
      recipientCorrelationId: request.recipientCorrelationId,
      kind: request.kind,
      mode: request.mode,
      priority,
      senderSeq,
      createdAt: now,
      expiresAt: now + ttlMs,
      ttlMs,
      sessionGeneration: this.#authority.currentGeneration(),
      leaseEpoch: this.#authority.currentLeaseEpoch(request.recipientCorrelationId),
      leaseNonce: this.#authority.currentLeaseNonce(request.recipientCorrelationId),
      payload: request.payload,
      provenance,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ...(request.correlationId ? { correlationId: request.correlationId } : {}),
    };

    // Compute hash
    const { computeEnvelopeHash } = await import("./file-store.ts");
    const hash = computeEnvelopeHash(envelopeBase);
    const envelope: MailboxEnvelope = { ...envelopeBase, hash };

    // 5. Deduplication — keyed on the caller-provided request id so a retried
    // logical message (e.g. taskId via the v1 registry) is not injected twice.
    // The key is claimed atomically (exclusive create) BEFORE any file write:
    // a check-then-mark-after-promote sequence would let two concurrent
    // enqueues with the same request id both pass and double-deliver. Without
    // a request id there is nothing meaningful to deduplicate against, so no
    // marker is written (the messageId is a fresh UUID every time and would
    // make the seen-set both unbounded and useless).
    const dedupKey = request.requestId ?? request.correlationId;
    if (dedupKey) {
      const claimed = await this.#store.tryMarkSeen(dedupKey);
      if (!claimed) {
        return { ok: false, code: "duplicate", message: `message ${dedupKey} already processed` };
      }
    }

    // Failed enqueues must release the dedup claim, or a legitimate retry of
    // the same logical message would be rejected as a duplicate.
    const releaseDedup = async (): Promise<void> => {
      if (dedupKey) await this.#store.unmarkSeen(dedupKey);
    };

    // 6. Write to staging
    try {
      await this.#store.writeStaging(envelope);
    } catch (error) {
      await releaseDedup();
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("payload exceeds")) {
        return { ok: false, code: "payload_too_large", message };
      }
      if (message.includes("envelope exceeds")) {
        return { ok: false, code: "envelope_too_large", message };
      }
      throw error;
    }

    // 7. Promote to ready
    const promoted = await this.#store.promoteToReady(messageId);
    if (!promoted) {
      await releaseDedup();
      return { ok: false, code: "route_invalid", message: "failed to promote staging to ready" };
    }

    return { ok: true, messageId, state: "ready" };
  }

  /** Whether this host's authority owns the recipient (consumer "*" filtering). */
  managesRecipient(recipientCorrelationId: string): boolean {
    return this.#authority.managesRecipient(recipientCorrelationId);
  }

  /**
   * Revalidate authority for a message before dispatch.
   * Called by the consumer before injecting into the child.
   * Returns true if dispatch is allowed, false if blocked.
   */
  async revalidateForDispatch(envelope: MailboxEnvelope): Promise<{ allowed: boolean; action: "dispatch" | "dead" | "hold"; reason?: string }> {
    // Workspace isolation: a message from another workspace can never dispatch here.
    if (this.#workspaceId !== undefined && envelope.workspaceId !== this.#workspaceId) {
      return { allowed: false, action: "dead", reason: "workspace mismatch on dispatch" };
    }

    // Check generation
    const currentGen = this.#authority.currentGeneration();
    if (envelope.sessionGeneration !== currentGen) {
      return { allowed: false, action: "dead", reason: `generation mismatch (envelope: ${envelope.sessionGeneration}, current: ${currentGen})` };
    }

    // Check lease epoch + nonce (bound to the recipient's current SessionLease)
    const currentEpoch = this.#authority.currentLeaseEpoch(envelope.recipientCorrelationId);
    const currentNonce = this.#authority.currentLeaseNonce(envelope.recipientCorrelationId);
    if (envelope.leaseEpoch !== currentEpoch || envelope.leaseNonce !== currentNonce) {
      return { allowed: false, action: "dead", reason: "lease epoch/nonce mismatch" };
    }

    // Check stale unauthorized
    if (this.#authority.isStaleUnauthorized(envelope.recipientCorrelationId)) {
      return { allowed: false, action: "dead", reason: "recipient is stale/unauthorized" };
    }

    // Check fenced — allow queue but block dispatch
    if (this.#authority.isFenced(envelope.recipientCorrelationId)) {
      return { allowed: false, action: "hold", reason: "recipient is fenced" };
    }

    // Re-validate route
    const route = this.#authority.canRoute(envelope.senderId, envelope.recipientCorrelationId, envelope.mode);
    if (!route.allowed) {
      return { allowed: false, action: "dead", reason: route.reason ?? "route no longer valid" };
    }

    return { allowed: true, action: "dispatch" };
  }
}
