import { type CompletionDispatchSeed, type CompletionIntent, type CompletionTarget } from "../public/v1/completion-durability.ts";
import { type CompletionOutboxGcResult, type CompletionOutboxRecord, type CompletionOutboxUsage, type CompletionReservationRecord } from "./types.ts";
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
}
export {};
