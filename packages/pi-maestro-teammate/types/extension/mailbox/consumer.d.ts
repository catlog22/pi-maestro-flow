/**
 * Mailbox consumer: single-claimer per recipient with priority scheduler,
 * heartbeat renewal, and stale claim reclaim.
 */
import { EventEmitter } from "node:events";
import { MailboxFileStore } from "./file-store.ts";
import { type MailboxRouter } from "./router.ts";
import { type MailboxEnvelope, type MailboxPriority } from "./types.ts";
/**
 * Select the next message to dispatch from a sorted candidate list.
 * Enforces starvation bound: after STARVATION_BOUND consecutive high-priority
 * dispatches, service one normal-priority message if available.
 */
export declare function selectNext(candidates: MailboxEnvelope[], consecutiveHigh: number): MailboxEnvelope | undefined;
/** Whether a priority counts toward the starvation bound. */
export declare function isHighPriority(priority: MailboxPriority): boolean;
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
export interface MailboxConsumerOptions {
    store: MailboxFileStore;
    router: MailboxRouter;
    /** Unique nonce identifying this consumer instance. */
    consumerNonce?: string;
    /** Recipient correlation ID this consumer serves. */
    recipientCorrelationId: string;
    /** Callback invoked when a message is ready for injection. */
    onDispatch: (envelope: MailboxEnvelope) => Promise<void>;
    /** Poll interval override (default 50ms). */
    pollMs?: number;
    now?: () => number;
}
export declare class MailboxConsumer extends EventEmitter {
    #private;
    readonly consumerNonce: string;
    readonly recipientCorrelationId: string;
    constructor(options: MailboxConsumerOptions);
    start(): void;
    stop(): Promise<void>;
    /** Notify the consumer that same-process messages may be available. */
    notify(): void;
    /**
     * Acknowledge that a message was successfully injected and confirmed via IPC.
     * Transitions ACCEPTED → APPLIED.
     */
    acknowledge(messageId: string): Promise<boolean>;
    /**
     * Reclaim stale claims: if a claimed message's heartbeat is older than
     * CLAIM_STALE_MS, move it back to ready for re-claim.
     */
    reclaimStaleClaims(): Promise<string[]>;
}
