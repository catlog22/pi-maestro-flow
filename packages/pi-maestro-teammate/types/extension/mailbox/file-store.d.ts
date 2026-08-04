/**
 * Atomic file-store for the durable mailbox state machine.
 * Every transition is an immutable file write + atomic rename + parent fsync.
 */
import { type MailboxClaim, type MailboxEnvelope, type MailboxPaths, type MailboxState, type MailboxStateRecord } from "./types.ts";
export declare function createMailboxPaths(rootDir: string): MailboxPaths;
export declare function ensureMailboxDirectories(paths: MailboxPaths): Promise<void>;
export declare function computeEnvelopeHash(envelope: Omit<MailboxEnvelope, "hash">): string;
export declare function verifyEnvelopeHash(envelope: MailboxEnvelope): boolean;
export interface FileStoreOptions {
    paths: MailboxPaths;
    now?: () => number;
}
export declare class MailboxFileStore {
    #private;
    readonly paths: MailboxPaths;
    constructor(options: FileStoreOptions);
    /** Write an envelope to staging. Returns false if payload/envelope too large. */
    writeStaging(envelope: MailboxEnvelope): Promise<void>;
    /** Promote a staging envelope to ready. Atomic rename. */
    promoteToReady(messageId: string): Promise<boolean>;
    /** Claim a ready envelope. The claimerNonce provides ownership. */
    claim(messageId: string, claim: MailboxClaim): Promise<boolean>;
    /** Accept a claimed envelope (injection dispatched, awaiting IPC ack). */
    accept(messageId: string, claim: MailboxClaim): Promise<boolean>;
    /** Apply an accepted envelope (IPC ack received). */
    apply(messageId: string): Promise<boolean>;
    /** Reject an envelope from ready or claimed state. */
    reject(messageId: string, fromState: "ready" | "claimed", reason: string): Promise<boolean>;
    /** Expire an envelope from ready state. */
    expire(messageId: string): Promise<boolean>;
    /** Move an envelope to dead-letter from any non-terminal state. */
    dead(messageId: string, fromState: MailboxState, reason: string): Promise<boolean>;
    /** Renew a claim's lease and heartbeat. Rewrites the state record in-place. */
    renewClaim(messageId: string, claim: MailboxClaim): Promise<void>;
    /** Read an envelope from a specific state directory. */
    readEnvelope(state: MailboxState, messageId: string): Promise<MailboxEnvelope | undefined>;
    /** Read the state record for a message in a specific state directory. */
    readStateRecord(state: MailboxState, messageId: string): Promise<MailboxStateRecord | undefined>;
    /** List message IDs in a specific state directory. */
    listMessages(state: MailboxState): Promise<string[]>;
    /**
     * List message IDs that have a state record but no envelope in the same
     * directory. These are orphaned by interrupted transitions or manual removal
     * and should be garbage collected.
     */
    listOrphanStateRecords(state: MailboxState): Promise<string[]>;
    /** Remove an orphaned state record without touching any envelope. */
    removeStateRecordOnly(state: MailboxState, messageId: string): Promise<void>;
    /** Release a claim lock (no-op if absent). */
    removeClaimLock(messageId: string): Promise<void>;
    /** True if a claim lock is currently held for the message. */
    hasClaimLock(messageId: string): Promise<boolean>;
    /** Check if a dedup key has been seen (durable deduplication). */
    isSeen(key: string): Promise<boolean>;
    /** Mark a dedup key as seen for durable deduplication. */
    markSeen(key: string): Promise<void>;
    /** List all seen markers (filename + seenAt) for GC retention sweeping. */
    listSeen(): Promise<Array<{
        file: string;
        seenAt: number;
    }>>;
    /** Remove a seen marker file by its listed name (GC). */
    removeSeen(file: string): Promise<void>;
    /** Remove a message envelope and its state record from a state directory. */
    remove(state: MailboxState, messageId: string): Promise<void>;
    /** Count messages in a specific state. */
    count(state: MailboxState): Promise<number>;
    /** Count total live messages (staging + ready + claimed + accepted). */
    countLive(): Promise<number>;
}
