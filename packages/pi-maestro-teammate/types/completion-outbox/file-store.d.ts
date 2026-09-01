import { type CompletionDispatchSeed, type CompletionIntent, type CompletionTarget } from "../public/v1/completion-durability.ts";
import { type CompletionOutboxGcResult, type CompletionOutboxRecord, type CompletionOutboxTryGcResult, type CompletionOutboxUsage, type CompletionReservationRecord } from "./types.ts";
interface StoreOptions {
    rootDir?: string;
    now?: () => number;
    ownerId?: string;
    maxLiveRecords?: number;
    maxLiveBytes?: number;
}
export interface CompletionOutboxCleanupOptions {
    apply?: boolean;
    maxEntries?: number;
}
export interface CompletionOutboxCleanupResult {
    apply: boolean;
    busy: boolean;
    scannedEntries: number;
    scannedFiles: number;
    replacementFiles: number;
    preservedFiles: number;
    candidateFiles: number;
    candidateBytes: number;
    removedFiles: number;
    removedBytes: number;
    candidateSample: string[];
}
export declare function computeCompletionContentRevision(record: Omit<CompletionOutboxRecord, "contentRevision">): string;
export declare class CompletionOutboxFileStore {
    #private;
    readonly rootDir: string;
    readonly ownerId: string;
    constructor(options?: StoreOptions);
    reserve(seed: CompletionDispatchSeed, reservedBytes?: number): Promise<CompletionReservationRecord>;
    releaseReservation(target: CompletionTarget, reservationId: string): Promise<boolean>;
    importIntent(intent: CompletionIntent): Promise<CompletionOutboxRecord>;
    /**
     * Import an already-finalized provider intent after its original capacity
     * reservation was lost or expired. Finalization is irreversible: recreate
     * only the same dispatch/target fence and never abandon committed intent.
     */
    recoverFinalizedIntent(intent: CompletionIntent): Promise<CompletionOutboxRecord>;
    listForTarget(target: CompletionTarget): Promise<CompletionOutboxRecord[]>;
    acquireClaim(target: CompletionTarget, deliveryId: string): Promise<CompletionOutboxRecord | undefined>;
    markQueued(target: CompletionTarget, deliveryId: string, receiptDeadlineAt: number): Promise<CompletionOutboxRecord | undefined>;
    returnToPending(target: CompletionTarget, deliveryId: string, error?: string): Promise<CompletionOutboxRecord | undefined>;
    markApplied(target: CompletionTarget, deliveryId: string): Promise<CompletionOutboxRecord | undefined>;
    markProviderAcknowledged(target: CompletionTarget, deliveryId: string): Promise<CompletionOutboxRecord | undefined>;
    markDead(target: CompletionTarget, deliveryId: string, error: string): Promise<CompletionOutboxRecord | undefined>;
    usage(workspaceId: string): Promise<CompletionOutboxUsage>;
    gc(workspaceId: string): Promise<CompletionOutboxGcResult>;
    cleanupRemnants(workspaceId: string, options?: CompletionOutboxCleanupOptions): Promise<CompletionOutboxCleanupResult>;
    /**
     * Non-blocking GC for the periodic reconcile path. If the workspace lock is
     * already held by a concurrent writer, returns `{ busy: true }` instead of
     * waiting or throwing — a maintenance sweep must never crash or warn on
     * transient contention. The cross-process marker cools down every bounded
     * page and, after a complete sweep, suppresses unchanged work until the first
     * retained record can expire. Expired records are inert until a later sweep.
     */
    tryGc(workspaceId: string): Promise<CompletionOutboxTryGcResult>;
}
export {};
