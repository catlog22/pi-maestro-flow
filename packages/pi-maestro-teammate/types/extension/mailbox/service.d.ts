/**
 * MailboxService: unified entry point for the durable mailbox system.
 * Ties together file-store, router, consumer, and GC into a single service
 * that root, proxy, and workspace agents share.
 */
import { EventEmitter } from "node:events";
import { MailboxConsumer, type MailboxDispatchDisposition } from "./consumer.ts";
import { MailboxFileStore } from "./file-store.ts";
import { MailboxGC, QuotaAdmission, type GCResult } from "./gc.ts";
import { type MailboxAuthority, MailboxRouter } from "./router.ts";
import type { MessageProvenanceV1 } from "../../shared/types.ts";
import { type MailboxEnvelope, type MailboxEnqueueResult, type MailboxMessageKind, type MailboxDeliveryMode, type MailboxPaths } from "./types.ts";
export type MailboxCapability = "v1" | "v2";
export declare const MAILBOX_CAPABILITY_HEADER = "x-mailbox-capability";
/** Negotiate mailbox capability between two peers. */
export declare function negotiateCapability(local: MailboxCapability, remote: MailboxCapability | undefined): MailboxCapability;
export interface MailboxServiceOptions {
    /** Root directory for mailbox storage. */
    rootDir: string;
    /** Authority provider for route/lease validation. */
    authority: MailboxAuthority;
    /** Recipient correlation ID this service instance serves. */
    recipientCorrelationId: string;
    /** Workspace ID. */
    workspaceId: string;
    /** Team ID. */
    teamId: string;
    /** Owner ID of this service instance. */
    ownerId: string;
    /** Persist the authoritative applied effect before child injection or acknowledgement. */
    commitApplied?: (envelope: MailboxEnvelope) => Promise<void>;
    /** Callback invoked when a message is ready for injection into the child. */
    onDispatch: (envelope: MailboxEnvelope) => Promise<MailboxDispatchDisposition | void>;
    /** Poll interval for the consumer. */
    pollMs?: number;
    /** Host reconciliation must settle before enqueues or consumer activation. */
    startupBarrier?: Promise<void>;
    now?: () => number;
}
export declare class MailboxService extends EventEmitter {
    #private;
    readonly paths: MailboxPaths;
    readonly store: MailboxFileStore;
    readonly router: MailboxRouter;
    readonly consumer: MailboxConsumer;
    readonly gc: MailboxGC;
    readonly quota: QuotaAdmission;
    readonly capability: MailboxCapability;
    constructor(options: MailboxServiceOptions);
    /**
     * Initialize directories and start the consumer.
     * startConsumer=false (shadow mode) initializes directories only — the
     * shadow contract is "enqueue + validate but NEVER consume/inject".
     */
    start(startConsumer?: boolean): Promise<void>;
    /** Start just the consumer (rollout upgrade to authoritative). */
    startConsumer(): Promise<void>;
    /** Stop the consumer. */
    stop(): Promise<void>;
    /** Stop just the consumer (rollout downgrade away from authoritative). */
    stopConsumer(): Promise<void>;
    /**
     * Enqueue a message for delivery.
     * This is the primary entry point replacing direct stdin delivery.
     */
    enqueue(request: {
        /** Stable caller-selected UUID for retry/receipt reconciliation. */
        messageId?: string;
        senderId: string;
        recipientId: string;
        recipientCorrelationId: string;
        kind: MailboxMessageKind;
        mode: MailboxDeliveryMode;
        /** Route capabilities frozen into the immutable envelope. */
        capabilities?: readonly string[];
        payload: string;
        provenance?: MessageProvenanceV1;
        requestId?: string;
        correlationId?: string;
    }): Promise<MailboxEnqueueResult>;
    /**
     * Acknowledge IPC confirmation that a message was injected.
     * Transitions ACCEPTED → APPLIED.
     */
    acknowledge(messageId: string): Promise<boolean>;
    /** Run garbage collection. Every admitted sweep is drained by stop(). */
    runGC(): Promise<GCResult>;
    /** Check if there is pending mail for the recipient (blocks eviction). */
    hasPendingMail(): Promise<boolean>;
    /** Get pending mail count for observability. */
    pendingCount(): Promise<number>;
}
