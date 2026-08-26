import { type CompletionDispatchHandle, type CompletionDispatchSeed, type CompletionDurabilityRegistry, type CompletionFinalizeInput, type CompletionIntent, type CompletionNotificationRequirement, type CompletionTarget } from "../public/v1/completion-durability.ts";
import { CompletionOutboxFileStore } from "./file-store.ts";
import { type CompletionOutboxRecord } from "./types.ts";
import { type MessageProvenanceV1 } from "../shared/types.ts";
export interface CompletionDeliveryEnvelope {
    customType: "teammate-complete";
    content: string;
    display: true;
    details: {
        source: "completion-outbox";
        deliveryId: string;
        contentRevision: string;
        targetSessionId: string;
        dispatchId: string;
        mode: CompletionIntent["mode"];
        resources: readonly string[];
        replayed: boolean;
        /** Structured system attribution; absent on envelopes from older coordinators. */
        provenance?: MessageProvenanceV1;
    };
}
export interface CompletionSessionBinding {
    target: CompletionTarget;
    /** Read-only aliases from pre-canonical workspace hashing. New writes use target.workspaceId. */
    legacyWorkspaceIds?: readonly string[];
    entries: readonly unknown[];
    send(envelope: CompletionDeliveryEnvelope): boolean;
}
export interface CompletionDispatchDurability {
    durable: boolean;
    handle?: CompletionDispatchHandle;
}
/** Distinguishes a pre-commit miss from post-finalize reconciliation work. */
export type CompletionPublishResult = {
    finalized: false;
} | {
    finalized: true;
    record?: CompletionOutboxRecord;
};
export interface CompletionCoordinatorOptions {
    store?: CompletionOutboxFileStore;
    registry?: CompletionDurabilityRegistry;
    now?: () => number;
    enabled?: () => boolean;
    defer?: (run: () => void) => void;
}
export declare function completionRedeliveryEnabled(): boolean;
export declare class CompletionDeliveryCoordinator {
    #private;
    readonly store: CompletionOutboxFileStore;
    readonly registry: CompletionDurabilityRegistry;
    constructor(options?: CompletionCoordinatorOptions);
    beginDispatch(seed: CompletionDispatchSeed): Promise<CompletionDispatchDurability>;
    requireNotification(input: CompletionNotificationRequirement): Promise<void>;
    abandon(seed: CompletionDispatchSeed, reason: string): Promise<void>;
    publishCompletion(input: CompletionFinalizeInput): Promise<CompletionPublishResult>;
    settleForeground(seed: CompletionDispatchSeed): Promise<void>;
    bindSession(binding: CompletionSessionBinding): Promise<void>;
    drain(): Promise<void>;
    unbindSession(sessionId?: string): void;
    reconcile(): Promise<void>;
    receiveMessageEnd(message: unknown, currentTarget: CompletionTarget): Promise<boolean>;
    redrive(): Promise<void>;
    dispose(): void;
    deliveryEnvelope(record: CompletionOutboxRecord, replayed: boolean): CompletionDeliveryEnvelope;
}
