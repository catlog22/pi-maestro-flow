/**
 * Public v1 mailbox API — versioned interface for external consumers (Flow host).
 *
 * Flow imports ONLY this subpath (`pi-maestro-teammate/v1/mailbox`).
 * The teammate package never imports from Flow.
 */
export type { MailboxCapability, MailboxServiceOptions, } from "../../extension/mailbox/service.ts";
export { MailboxService, negotiateCapability, MAILBOX_CAPABILITY_HEADER, } from "../../extension/mailbox/service.ts";
export type { MailboxEnvelope, MailboxEnqueueResult, MailboxMessageKind, MailboxDeliveryMode, MailboxPriority, MailboxState, MailboxPaths, } from "../../extension/mailbox/types.ts";
export { MAILBOX_SCHEMA_VERSION, priorityForKind, } from "../../extension/mailbox/types.ts";
export type { MailboxAuthority, MailboxEnqueueRequest } from "../../extension/mailbox/router.ts";
/** Shared-process registry key published by the root teammate extension. */
export declare const MAILBOX_REGISTRY_KEY: unique symbol;
export type AgentMessageMode = "steer" | "follow_up";
export interface AgentMessageDeliveryRequest {
    recipientCorrelationId: string;
    recipientLabel?: string;
    message: string;
    mode?: AgentMessageMode;
}
export interface AgentMessageDeliveryResult {
    delivered: boolean;
    error?: string;
    mode?: AgentMessageMode | "prompt";
    wasSleeping?: boolean;
}
/**
 * Minimal interface the Flow host uses to interact with the mailbox.
 * Decoupled from the full MailboxService to keep the public surface small.
 */
export interface MailboxHostRegistry {
    /** Enqueue a task notification for an agent. */
    enqueueTaskNotification(request: {
        senderId: string;
        recipientId: string;
        recipientCorrelationId: string;
        payload: string;
        taskId?: string;
    }): Promise<MailboxEnqueueResult>;
    /** Deliver user input to a live or restorable agent by correlation id. */
    deliverAgentMessage(request: AgentMessageDeliveryRequest): Promise<AgentMessageDeliveryResult>;
    /** Query pending mail count for an agent. */
    pendingCount(recipientCorrelationId: string): Promise<number>;
    /** Negotiate capability with a peer. */
    negotiate(remoteCapability: string | undefined): MailboxCapability;
}
import type { MailboxCapability } from "../../extension/mailbox/service.ts";
import type { MailboxEnqueueResult } from "../../extension/mailbox/types.ts";
export declare function createDirectAgentHostRegistry(deliverAgentMessage: (request: AgentMessageDeliveryRequest) => Promise<AgentMessageDeliveryResult>): MailboxHostRegistry;
/**
 * Create a host registry backed by a MailboxService instance.
 * Called by the Flow extension host during initialization.
 */
export declare function createMailboxHostRegistry(service: import("../../extension/mailbox/service.ts").MailboxService, localCapability?: MailboxCapability, deliverAgentMessage?: (request: AgentMessageDeliveryRequest) => Promise<AgentMessageDeliveryResult>): MailboxHostRegistry;
