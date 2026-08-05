/**
 * Mailbox router: route validation, authority revalidation, quota admission,
 * and fenced-queue semantics.
 */
import { MailboxFileStore } from "./file-store.ts";
import { QuotaAdmission } from "./gc.ts";
import { type MailboxDeliveryMode, type MailboxEnvelope, type MailboxEnqueueResult, type MailboxMessageKind } from "./types.ts";
/** Injected authority checks for route and lease validation. */
export interface MailboxAuthority {
    /** Validate that the sender can route to the recipient. */
    canRoute(senderId: string, recipientCorrelationId: string, mode: MailboxDeliveryMode): {
        allowed: boolean;
        reason?: string;
    };
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
}
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
export interface MailboxRouterOptions {
    store: MailboxFileStore;
    authority: MailboxAuthority;
    quota: QuotaAdmission;
    /** Workspace this router belongs to; enqueue requests from other workspaces are rejected. */
    workspaceId?: string;
    now?: () => number;
}
export declare class MailboxRouter {
    #private;
    constructor(options: MailboxRouterOptions);
    /**
     * Enqueue a message through the full authority + quota pipeline.
     * Returns a result indicating success (message in ready state) or failure code.
     */
    enqueue(request: MailboxEnqueueRequest): Promise<MailboxEnqueueResult>;
    /**
     * Revalidate authority for a message before dispatch.
     * Called by the consumer before injecting into the child.
     * Returns true if dispatch is allowed, false if blocked.
     */
    revalidateForDispatch(envelope: MailboxEnvelope): Promise<{
        allowed: boolean;
        action: "dispatch" | "dead" | "hold";
        reason?: string;
    }>;
}
