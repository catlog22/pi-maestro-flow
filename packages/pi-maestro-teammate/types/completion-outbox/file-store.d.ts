import { type CompletionDispatchSeed, type CompletionIntent, type CompletionTarget } from "../public/v1/completion-durability.ts";
import { type CompletionOutboxGcResult, type CompletionOutboxRecord, type CompletionOutboxTryGcResult, type CompletionOutboxUsage, type CompletionReservationRecord } from "./types.ts";
interface StoreOptions {
    rootDir?: string;
    now?: () => number;
    ownerId?: string;
    maxLiveRecords?: number;
    maxLiveBytes?: number;
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
    listForTarget(target: CompletionTarget): Promise<CompletionOutboxRecord[]>;
    acquireClaim(target: CompletionTarget, deliveryId: string): Promise<CompletionOutboxRecord | undefined>;
    markQueued(target: CompletionTarget, deliveryId: string, receiptDeadlineAt: number): Promise<CompletionOutboxRecord | undefined>;
    returnToPending(target: CompletionTarget, deliveryId: string, error?: string): Promise<CompletionOutboxRecord | undefined>;
    markApplied(target: CompletionTarget, deliveryId: string): Promise<CompletionOutboxRecord | undefined>;
    markProviderAcknowledged(target: CompletionTarget, deliveryId: string): Promise<CompletionOutboxRecord | undefined>;
    markDead(target: CompletionTarget, deliveryId: string, error: string): Promise<CompletionOutboxRecord | undefined>;
    usage(workspaceId: string): Promise<CompletionOutboxUsage>;
    gc(workspaceId: string): Promise<CompletionOutboxGcResult>;
    /**
     * Non-blocking GC for the periodic reconcile path. If the workspace lock is
     * already held by a concurrent writer, returns `{ busy: true }` instead of
     * waiting or throwing — a maintenance sweep must never crash or warn on
     * transient contention. Also honors a cross-process `.gc-marker` so that
     * when multiple Pi processes share the outbox only one sweeps within
     * TRY_GC_MARKER_MIN_INTERVAL_MS; the others return `{ skipped: true }`.
     * Expired records are inert (acquireClaim/deliverDue reject them), so
     * skipping a sweep is safe; the next reconcile reclaims them.
     */
    tryGc(workspaceId: string): Promise<CompletionOutboxTryGcResult>;
}
export {};
