import type { SessionMessageKind } from "./session-core.ts";
export declare const REMOTE_HISTORY_ENTRY_TYPE = "teammate-remote-history";
export declare const REMOTE_HISTORY_VERSION: 1;
export declare const REMOTE_HISTORY_MAX_BODY_CHARS = 8000;
export declare const REMOTE_HISTORY_MAX_ENTRIES = 8192;
export type RemoteHistoryKind = "message" | "receipt" | "lifecycle" | "result";
export type RemoteHistoryDirection = "outgoing" | "incoming";
export type RemoteHistoryStatus = "pending" | "queued" | "injected" | "accepted" | "rejected" | "timeout";
export type RemoteHistoryMode = "follow_up" | "steer";
export interface RemoteHistoryEntry {
    version: typeof REMOTE_HISTORY_VERSION;
    entryId: string;
    target: string;
    runId: string;
    targetId: string;
    kind: RemoteHistoryKind;
    direction: RemoteHistoryDirection;
    source: "remote";
    messageKind?: SessionMessageKind;
    requestedMode: RemoteHistoryMode;
    effectiveMode?: RemoteHistoryMode;
    body: string;
    bodyTruncated: boolean;
    status: RemoteHistoryStatus;
    createdAt: number;
    updatedAt: number;
    revision: number;
}
export type RemoteHistoryEntryInput = Omit<RemoteHistoryEntry, "version" | "body" | "bodyTruncated"> & {
    body: string;
};
export declare function createRemoteHistoryEntry(input: RemoteHistoryEntryInput): RemoteHistoryEntry;
export declare function parseRemoteHistoryEntry(value: unknown): RemoteHistoryEntry | undefined;
export declare function remoteHistoryEntryData(value: unknown): unknown;
export declare function rebuildRemoteHistory(values: readonly unknown[]): RemoteHistoryEntry[];
