/** Sequence, idempotency, and lifecycle helpers for remote run state. */
import type { RemoteRunCapture, RemoteRunEvent, RemoteRunSnapshot, RemoteStatus } from "./types.ts";
export declare const REMOTE_COMMAND_DEDUP_LIMIT = 4096;
export type RemoteSequenceDecision = {
    accepted: true;
    expectedSequence: number;
} | {
    accepted: false;
    reason: "duplicate" | "gap";
    expectedSequence: number;
};
export declare class RemoteCommandDeduplicator {
    #private;
    constructor(limit?: number);
    accept(commandId: string): boolean;
    get size(): number;
}
export declare class RemoteEventSequenceTracker {
    #private;
    constructor(lastSequence?: number);
    accept(sequence: number): RemoteSequenceDecision;
    get lastSequence(): number;
}
export declare function createRemoteRunSnapshot(capture: RemoteRunCapture, status?: RemoteStatus, updatedAt?: number): RemoteRunSnapshot;
export declare function applyRemoteRunEvent(snapshot: RemoteRunSnapshot, event: RemoteRunEvent): RemoteRunSnapshot;
