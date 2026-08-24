/**
 * Durable mailbox envelope types and state machine definitions.
 * Schema: teammate-mailbox/v1
 */

import type { MessageProvenanceV1 } from "../../shared/types.ts";

// --- Constants ---

export const MAILBOX_SCHEMA_VERSION = 1 as const;

/** Maximum payload size in bytes. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;
/** Maximum total envelope size in bytes. */
export const MAX_ENVELOPE_BYTES = 96 * 1024;

/** Claim lease duration before renewal is required. */
export const CLAIM_LEASE_MS = 30_000;
/** Claim renewal interval. */
export const CLAIM_RENEW_MS = 10_000;
/** Heartbeat interval for active claims. */
export const CLAIM_HEARTBEAT_MS = 5_000;
/** Duration after which an unrenewed claim is considered stale. */
export const CLAIM_STALE_MS = 20_000;

/** Cross-process poll interval. */
export const POLL_INTERVAL_MS = 50;

/** Maximum consecutive dispatch failures before a message is dead-lettered. */
export const MAX_DISPATCH_RETRIES = 5;

/** Maximum consecutive high-priority messages before servicing one normal. */
export const STARVATION_BOUND = 8;

// --- Quota ---

/** Hard total live message limit. */
export const QUOTA_HARD_TOTAL = 512;
/** Slots reserved for critical priority (lifecycle/result/control). */
export const QUOTA_CRITICAL_RESERVE = 64;
/** Maximum normal-priority messages (QUOTA_HARD_TOTAL - QUOTA_CRITICAL_RESERVE). */
export const QUOTA_NORMAL_MAX = QUOTA_HARD_TOTAL - QUOTA_CRITICAL_RESERVE;
/** Hard total size limit in bytes (~48 MiB). */
export const QUOTA_HARD_BYTES = 48 * 1024 * 1024;

// --- TTLs ---

export const TTL_NORMAL_MS = 24 * 60 * 60_000;
export const TTL_STEER_MS = 10 * 60_000;
export const TTL_RECEIPT_MS = 24 * 60 * 60_000;
export const TTL_DEAD_MS = 7 * 24 * 60 * 60_000;
export const TTL_STAGING_MS = 60 * 60_000;

// --- State Machine ---

export type MailboxState =
  | "staging"
  | "ready"
  | "claimed"
  | "accepted"
  | "applied"
  | "rejected"
  | "expired"
  | "dead";

/** Terminal states that require no further processing. */
export const TERMINAL_STATES: ReadonlySet<MailboxState> = new Set([
  "applied",
  "rejected",
  "expired",
  "dead",
]);

/** States eligible for GC after retention period. */
export const GC_ELIGIBLE_STATES: ReadonlySet<MailboxState> = new Set([
  "applied",
  "expired",
  "dead",
]);

// --- Message Kinds and Priority ---

export type MailboxMessageKind =
  | "lifecycle"
  | "result"
  | "steer"
  | "follow_up"
  | "task"
  | "control";

export type MailboxPriority = "critical" | "high" | "normal";

/** Maps message kind to its default priority lane. */
export function priorityForKind(kind: MailboxMessageKind): MailboxPriority {
  switch (kind) {
    case "lifecycle":
    case "result":
    case "control":
      return "critical";
    case "steer":
      return "high";
    case "follow_up":
    case "task":
      return "normal";
  }
}

/** Delivery mode for the message. */
export type MailboxDeliveryMode = "steer" | "follow_up" | "abort" | "notify";

// --- Envelope ---

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
  /** Structured host attribution; absent on legacy mailbox records. */
  provenance?: MessageProvenanceV1;
  /** SHA-256 hash of the canonical JSON envelope (excluding hash field). */
  hash: string;
  /** Optional request identifier for request-response correlation. */
  requestId?: string;
  /** Optional correlation identifier for threading. */
  correlationId?: string;
}

// --- Claim Metadata ---

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

// --- State Transition Record ---

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

// --- Enqueue Result ---

export type MailboxEnqueueResult =
  | { ok: true; messageId: string; state: "ready" }
  | { ok: false; code: "quota_exceeded" | "route_invalid" | "generation_mismatch" | "lease_invalid" | "duplicate" | "payload_too_large" | "envelope_too_large"; message: string };

// --- Directory Layout ---

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
export function stateDirKey(state: MailboxState): keyof Omit<MailboxPaths, "rootDir" | "seenDir"> {
  switch (state) {
    case "staging": return "stagingDir";
    case "ready": return "readyDir";
    case "claimed": return "claimedDir";
    case "accepted": return "acceptedDir";
    case "applied": return "appliedDir";
    case "rejected": return "rejectedDir";
    case "expired": return "expiredDir";
    case "dead": return "deadDir";
  }
}

// --- Validation Patterns ---

export const MESSAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const OWNER_ID_PATTERN = /^[a-f0-9]{32}$/;
export const WORKSPACE_ID_PATTERN = /^[a-f0-9]{64}$/;
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Path-safe identifier pattern applied to workspace/owner ids before they are
 * joined into filesystem paths. Rejects empty strings, path separators, and
 * traversal sequences while staying compatible with test fixtures ("a") and
 * production values ("caller", sha256 hex, workspace-peer owner ids).
 */
export const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
