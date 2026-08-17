import type { RemoteRunStartParams } from "./protocol.ts";
import { type RemoteRunCapture, type RemoteRunEvent, type RemoteRunSnapshot, type RemoteWorkerIdentity } from "./types.ts";
export declare const REMOTE_JOURNAL_VERSION: 1;
export declare const REMOTE_MAX_JOURNAL_EVENTS = 50000;
export declare const REMOTE_MAX_JOURNAL_BYTES: number;
export declare const REMOTE_MAX_COMMAND_RECORDS = 4096;
export declare const REMOTE_PRIVATE_DIRECTORY_MODE = 448;
export declare const REMOTE_PRIVATE_FILE_MODE = 384;
export interface RemoteJournalRunRecord {
    version: typeof REMOTE_JOURNAL_VERSION;
    capture: RemoteRunCapture;
    request: RemoteRunStartParams;
    capabilities: readonly string[];
    snapshot: RemoteRunSnapshot;
    createdAt: number;
    updatedAt: number;
}
export interface RemoteStoredCommand {
    version: typeof REMOTE_JOURNAL_VERSION;
    commandId: string;
    fingerprint: string;
    state: "pending" | "completed";
    createdAt: number;
    completedAt?: number;
    outcome?: {
        ok: true;
        result: unknown;
    } | {
        ok: false;
        code: number;
        message: string;
        data?: unknown;
    };
}
export declare function getRemoteStateDirectory(): string;
export declare function ensurePrivateRemoteDirectory(directoryPath: string): void;
export declare class RemoteRunJournal {
    #private;
    readonly stateDirectory: string;
    readonly identity: RemoteWorkerIdentity;
    constructor(stateDirectory?: string);
    static fingerprint(method: string, params: unknown): string;
    createRun(capture: RemoteRunCapture, request: RemoteRunStartParams, capabilities?: readonly string[], now?: number): RemoteJournalRunRecord;
    getRun(runId: string): RemoteJournalRunRecord | undefined;
    listRuns(monitorOwnerNonce?: string): RemoteJournalRunRecord[];
    appendEvent(capture: RemoteRunCapture, event: RemoteRunEvent): RemoteJournalRunRecord;
    readEvents(runId: string, afterSequence?: number): RemoteRunEvent[];
    getCommand(commandId: string): RemoteStoredCommand | undefined;
    beginCommand(commandId: string, fingerprint: string, now?: number): RemoteStoredCommand;
    completeCommand(commandId: string, fingerprint: string, outcome: NonNullable<RemoteStoredCommand["outcome"]>, now?: number): RemoteStoredCommand;
}
