/**
 * Mailbox router: route validation, authority revalidation, quota admission,
 * and fenced-queue semantics.
 */

import { randomUUID } from "node:crypto";
import { MailboxFileStore } from "./file-store.ts";
import { QuotaAdmission } from "./gc.ts";
import {
  type MailboxDeliveryMode,
  type MailboxEnvelope,
  type MailboxEnqueueResult,
  type MailboxMessageKind,
  type MailboxPriority,
  MAILBOX_SCHEMA_VERSION,
  MAX_PAYLOAD_BYTES,
  priorityForKind,
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
  /** Current lease epoch. */
  currentLeaseEpoch(): number;
  /** Current lease nonce. */
  currentLeaseNonce(): string;
  /** Whether the recipient agent is fenced (queued but not dispatched). */
  isFenced(recipientCorrelationId: string): boolean;
  /** Whether the recipient agent is stale/unauthorized (should dead-letter). */
  isStaleUnauthorized(recipientCorrelationId: string): boolean;
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
  #senderSeq = 0;

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
    const ttlMs = ttlForKind(request.kind);
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
      senderSeq: ++this.#senderSeq,
      createdAt: now,
      expiresAt: now + ttlMs,
      ttlMs,
      sessionGeneration: this.#authority.currentGeneration(),
      leaseEpoch: this.#authority.currentLeaseEpoch(),
      leaseNonce: this.#authority.currentLeaseNonce(),
      payload: request.payload,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ...(request.correlationId ? { correlationId: request.correlationId } : {}),
    };

    // Compute hash
    const { computeEnvelopeHash } = await import("./file-store.ts");
    const hash = computeEnvelopeHash(envelopeBase);
    const envelope: MailboxEnvelope = { ...envelopeBase, hash };

    // 5. Deduplication check
    if (await this.#store.isSeen(messageId)) {
      return { ok: false, code: "duplicate", message: `message ${messageId} already processed` };
    }

    // 6. Write to staging
    try {
      await this.#store.writeStaging(envelope);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("payload exceeds")) {
        return { ok: false, code: "payload_too_large", message };
      }
      if (message.includes("exceeds")) {
        return { ok: false, code: "envelope_too_large", message };
      }
      throw error;
    }

    // 7. Promote to ready
    const promoted = await this.#store.promoteToReady(messageId);
    if (!promoted) {
      return { ok: false, code: "route_invalid", message: "failed to promote staging to ready" };
    }

    // 8. Mark as seen for deduplication
    await this.#store.markSeen(messageId);

    return { ok: true, messageId, state: "ready" };
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

    // Check lease epoch + nonce
    const currentEpoch = this.#authority.currentLeaseEpoch();
    const currentNonce = this.#authority.currentLeaseNonce();
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
