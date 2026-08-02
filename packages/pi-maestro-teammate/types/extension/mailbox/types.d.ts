/**
 * Durable mailbox envelope types and state machine definitions.
 * Schema: teammate-mailbox/v1
 */
export declare const MAILBOX_SCHEMA_VERSION: 1;
/** Maximum payload size in bytes. */
export declare const MAX_PAYLOAD_BYTES: number;
/** Maximum total envelope size in bytes. */
export declare const MAX_ENVELOPE_BYTES: number;
/** Claim lease duration before renewal is required. */
export declare const CLAIM_LEASE_MS = 30000;
/** Claim renewal interval. */
export declare const CLAIM_RENEW_MS = 10000;
/** Heartbeat interval for active claims. */
export declare const CLAIM_HEARTBEAT_MS = 5000;
/** Duration after which an unrenewed claim is considered stale. */
export declare const CLAIM_STALE_MS = 20000;
/** Cross-process poll interval. */
export declare const POLL_INTERVAL_MS = 50;
/** Maximum consecutive high-priority messages before servicing one normal. */
export declare const STARVATION_BOUND = 8;
/** Hard total live message limit. */
export declare const QUOTA_HARD_TOTAL = 512;
/** Slots reserved for critical priority (lifecycle/result/control). */
export declare const QUOTA_CRITICAL_RESERVE = 64;
/** Maximum normal-priority messages (QUOTA_HARD_TOTAL - QUOTA_CRITICAL_RESERVE). */
export declare const QUOTA_NORMAL_MAX: number;
/** Hard total size limit in bytes (~48 MiB). */
export declare const QUOTA_HARD_BYTES: number;
export declare const TTL_NORMAL_MS: number;
export declare const TTL_STEER_MS: number;
export declare const TTL_RECEIPT_MS: number;
export declare const TTL_DEAD_MS: number;
export declare const TTL_STAGING_MS: number;
export type MailboxState = "staging" | "ready" | "claimed" | "accepted" | "applied" | "rejected" | "expired" | "dead";
/** Terminal states that require no further processing. */
export declare const TERMINAL_STATES: ReadonlySet<MailboxState>;
/** States eligible for GC after retention period. */
export declare const GC_ELIGIBLE_STATES: ReadonlySet<MailboxState>;
export type MailboxMessageKind = "lifecycle" | "result" | "steer" | "follow_up" | "task" | "control";
export type MailboxPriority = "critical" | "high" | "normal";
/** Maps message kind to its default priority lane. */
export declare function priorityForKind(kind: MailboxMessageKind): MailboxPriority;
/** Delivery mode for the message. */
export type MailboxDeliveryMode = "steer" | "follow_up" | "abort" | "notify";
export interface MailboxEnvelope {
    /** Unique message identifier (UUID v4). */
    messageId: string;
    /** Schema version for forward compatibility. */
    schemaVersion: typeof MAILBOX_SCHEMA_VERSION;
    /** Workspace identifier (SHA-256 hex of normalized cwd). */
    workspaceId: string;
    /** Team identifier (implicit via root dispatch correlationId). */
    teamId: string;
    /** Sender owner identifier. */
    senderId: string;
    /** Recipient owner identifier. */
    recipientId: string;
    /** Recipient agent correlation id. */
    recipientCorrelationId: string;
    /** Message kind determines priority lane and TTL. */
    kind: MailboxMessageKind;
    /** Delivery mode. */
    mode: MailboxDeliveryMode;
    /** Priority lane for scheduling. */
    priority: MailboxPriority;
    /** Monotonic sender sequence for FIFO ordering within sender+priority. */
    senderSeq: number;
    /** Unix ms timestamp when the envelope was created. */
    createdAt: number;
    /** Unix ms timestamp when the envelope expires. */
    expiresAt: number;
    /** Time-to-live in milliseconds. */
    ttlMs: number;
    /** Session generation at enqueue time for authority revalidation. */
    sessionGeneration: number;
    /** Lease epoch at enqueue time. */
    leaseEpoch: number;
    /** Lease nonce at enqueue time. */
    leaseNonce: string;
    /** The message payload (text content). */
    payload: string;
    /** SHA-256 hash of the canonical JSON envelope (excluding hash field). */
    hash: string;
    /** Optional request identifier for request-response correlation. */
    requestId?: string;
    /** Optional correlation identifier for threading. */
    correlationId?: string;
}
export interface MailboxClaim {
    /** The message being claimed. */
    messageId: string;
    /** Owner nonce of the claimer. */
    claimerNonce: string;
    /** Unix ms when the claim was acquired. */
    claimedAt: number;
    /** Unix ms when the claim lease expires. */
    leaseExpiresAt: number;
    /** Unix ms of the last heartbeat. */
    lastHeartbeatAt: number;
}
export interface MailboxStateRecord {
    messageId: string;
    state: MailboxState;
    transitionedAt: number;
    /** Previous state for audit trail. */
    previousState: MailboxState | null;
    /** Claim metadata when state is claimed/accepted. */
    claim?: MailboxClaim;
    /** Reason for terminal states. */
    reason?: string;
}
export type MailboxEnqueueResult = {
    ok: true;
    messageId: string;
    state: "ready";
} | {
    ok: false;
    code: "quota_exceeded" | "route_invalid" | "generation_mismatch" | "lease_invalid" | "duplicate" | "payload_too_large" | "envelope_too_large";
    message: string;
};
export interface MailboxPaths {
    /** Root mailbox directory. */
    rootDir: string;
    /** Staging area for in-progress writes. */
    stagingDir: string;
    /** Ready messages awaiting claim. */
    readyDir: string;
    /** Claimed messages being processed. */
    claimedDir: string;
    /** Accepted messages awaiting IPC ack. */
    acceptedDir: string;
    /** Applied receipts. */
    appliedDir: string;
    /** Rejected messages. */
    rejectedDir: string;
    /** Expired messages. */
    expiredDir: string;
    /** Dead-letter messages. */
    deadDir: string;
    /** Durable deduplication seen-set. */
    seenDir: string;
}
/** Maps a MailboxState to its directory key within MailboxPaths. */
export declare function stateDirKey(state: MailboxState): keyof Omit<MailboxPaths, "rootDir" | "seenDir">;
export declare const MESSAGE_ID_PATTERN: RegExp;
export declare const OWNER_ID_PATTERN: RegExp;
export declare const WORKSPACE_ID_PATTERN: RegExp;
export declare const CORRELATION_ID_PATTERN: RegExp;
