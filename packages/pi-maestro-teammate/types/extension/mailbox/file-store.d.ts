/**
 * Crash-consistent file store for the durable mailbox state machine.
 *
 * Envelopes are immutable. State changes use a durable transition journal,
 * destination metadata, a cross-directory rename, file/directory fsync, and
 * only then cleanup. Mutable metadata replacement retains recoverable .new and
 * .bak candidates and never unlinks the sole committed value.
 */
import { type MailboxClaim, type MailboxDedupRecord, type MailboxEnvelope, type MailboxOwnerFence, type MailboxPaths, type MailboxState, type MailboxStateRecord } from "./types.ts";
export type MailboxPersistenceBoundary = "dedup-prepared" | "envelope-prepared" | "envelope-published" | "transition-prepared" | "transition-metadata" | "transition-renamed" | "transition-directories-synced" | "transition-source-cleaned" | "transition-finished" | "replacement-prepared" | "replacement-backup" | "replacement-published" | "replacement-finished";
export declare function createMailboxPaths(rootDir: string): MailboxPaths;
export declare function ensureMailboxDirectories(paths: MailboxPaths): Promise<void>;
export declare function computeEnvelopeHash(envelope: Omit<MailboxEnvelope, "hash">): string;
export declare function verifyEnvelopeHash(envelope: MailboxEnvelope): boolean;
export declare function activateMailboxOwner(fence: MailboxOwnerFence): void;
export declare function deactivateMailboxOwner(fence: MailboxOwnerFence): void;
export declare function isMailboxClaimOwnerLive(claim: MailboxClaim, now?: number): boolean;
export interface FileStoreOptions {
    paths: MailboxPaths;
    now?: () => number;
    /** Test-only crash-window observer. Throwing preserves durable remnants. */
    onPersistenceBoundary?: (boundary: MailboxPersistenceBoundary) => void;
}
/** Exact owner incarnation plus a live generation/token revalidation hook. */
export interface MailboxMutationAuthority {
    owner: MailboxOwnerFence;
    isCurrent: () => boolean | Promise<boolean>;
}
export type PrepareEnqueueResult = {
    status: "prepared";
    messageId: string;
} | {
    status: "duplicate";
    messageId: string;
} | {
    status: "conflict";
    messageId: string;
};
export declare class MailboxFileStore {
    #private;
    readonly paths: MailboxPaths;
    constructor(options: FileStoreOptions);
    /** Recover interrupted transitions, request prepares, replacements, and legacy seen markers. */
    recover(): Promise<void>;
    /** Durable requestId prepare; an existing record is reconciled before duplicate/conflict returns. */
    prepareEnqueue(dedupKey: string, requestHash: string, envelope: MailboxEnvelope): Promise<PrepareEnqueueResult>;
    /** Write an immutable staging envelope, failing closed on messageId collisions. */
    writeStaging(envelope: MailboxEnvelope): Promise<void>;
    promoteToReady(messageId: string): Promise<boolean>;
    claim(messageId: string, claim: MailboxClaim): Promise<boolean>;
    accept(messageId: string, claim: MailboxClaim): Promise<boolean>;
    apply(messageId: string, owner?: MailboxOwnerFence): Promise<boolean>;
    reject(messageId: string, fromState: "ready" | "claimed", reason: string, owner?: MailboxOwnerFence): Promise<boolean>;
    expire(messageId: string, mutationAuthority?: MailboxMutationAuthority): Promise<boolean>;
    dead(messageId: string, fromState: MailboxState, reason: string, owner?: MailboxOwnerFence): Promise<boolean>;
    /** Non-destructive reverse transition used for retry/takeover. */
    requeue(messageId: string, fromState: "claimed" | "accepted", options?: {
        owner?: MailboxOwnerFence;
        allowTakeover?: boolean;
    }): Promise<boolean>;
    renewClaim(messageId: string, claim: MailboxClaim): Promise<boolean>;
    renewAccepted(messageId: string, claim: MailboxClaim): Promise<boolean>;
    readEnvelope(state: MailboxState, messageId: string): Promise<MailboxEnvelope | undefined>;
    readStateRecord(state: MailboxState, messageId: string): Promise<MailboxStateRecord | undefined>;
    listMessages(state: MailboxState, limit?: number): Promise<string[]>;
    listOrphanStateRecords(state: MailboxState, limit?: number): Promise<string[]>;
    removeStateRecordOnly(state: MailboxState, messageId: string, mutationAuthority?: MailboxMutationAuthority): Promise<boolean>;
    removeClaimLock(messageId: string): Promise<void>;
    hasClaimLock(messageId: string): Promise<boolean>;
    hasTransition(messageId: string): Promise<boolean>;
    isSeen(key: string): Promise<boolean>;
    /** Legacy compatibility helper. Router enqueue uses prepareEnqueue instead. */
    markSeen(key: string): Promise<void>;
    /** Legacy compatibility helper. Router enqueue uses prepareEnqueue instead. */
    tryMarkSeen(key: string): Promise<boolean>;
    unmarkSeen(key: string): Promise<void>;
    listSeen(limit?: number): Promise<Array<{
        file: string;
        seenAt: number;
    }>>;
    listDedupRecords(limit?: number): Promise<MailboxDedupRecord[]>;
    removeSeen(file: string, mutationAuthority?: MailboxMutationAuthority): Promise<boolean>;
    remove(state: MailboxState, messageId: string, mutationAuthority?: MailboxMutationAuthority): Promise<boolean>;
    count(state: MailboxState): Promise<number>;
    countLive(): Promise<number>;
}
