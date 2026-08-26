import { RUNTIME_V2_REVISION, RUNTIME_V2_VERSION, type RuntimeEventDraftV2, type RuntimeEventV2 } from "./contracts.ts";
export declare const RUNTIME_V2_MAX_EVENTS = 50000;
export declare const RUNTIME_V2_MAX_STREAM_BYTES: number;
export declare const RUNTIME_V2_MAX_LINE_BYTES: number;
export interface RuntimeV2JournalMetadata {
    version: typeof RUNTIME_V2_VERSION;
    revision: typeof RUNTIME_V2_REVISION;
    streamId: string;
    /** Immutable owner derived from the first Runtime event. Absent only on legacy empty streams. */
    workspaceId?: string;
    eventCount: number;
    lastSequence: number;
    eventsBytes: number;
    updatedAt: number;
}
export interface RuntimeV2JournalStream {
    metadata: RuntimeV2JournalMetadata;
    events: RuntimeEventV2[];
}
export interface RuntimeV2ShadowJournalOptions {
    maxEvents?: number;
    maxBytes?: number;
    maxLineBytes?: number;
    onQuarantine?: (directory: string, error: unknown) => void;
}
export interface RuntimeV2JournalListOptions {
    workspaceId: string;
    prefix: string;
    afterStreamId?: string;
    limit: number;
}
export declare class RuntimeV2ShadowJournal {
    #private;
    readonly rootDirectory: string;
    constructor(rootDirectory: string, options?: RuntimeV2ShadowJournalOptions);
    append(draft: RuntimeEventDraftV2): RuntimeEventV2;
    read(streamId: string): RuntimeV2JournalStream | undefined;
    replay(streamId: string, afterSequence?: number): RuntimeEventV2[];
    listStreams(options: RuntimeV2JournalListOptions): string[];
}
