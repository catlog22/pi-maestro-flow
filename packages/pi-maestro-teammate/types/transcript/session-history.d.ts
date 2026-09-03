/**
 * Bounded, read-only projection of host-authorized Pi transcripts.
 *
 * Callers never supply transcript paths. Each inventory candidate is opened
 * once, without following symlinks where the platform exposes O_NOFOLLOW,
 * then fstat, bounded-read, parse, active-chain selection, and projection all
 * operate from that same handle snapshot. No transcript bytes are cached.
 */
export declare const SESSION_HISTORY_VERSION: 1;
export declare const SESSION_HISTORY_URI_SCHEME: "session://";
export declare const MAX_SESSION_HISTORY_FILES = 20;
export declare const MAX_SESSION_HISTORY_BYTES: number;
export declare const MAX_SESSION_HISTORY_MATCHES = 20;
export declare const MAX_SESSION_HISTORY_SNIPPET_CHARS = 1000;
export declare const MAX_SESSION_HISTORY_QUERY_CHARS = 4096;
export declare const MAX_SESSION_HISTORY_OMISSIONS = 64;
export declare const SESSION_HISTORY_INCLUDES: readonly ["user", "assistant", "visible_custom", "compaction", "tool_result"];
export declare const DEFAULT_SESSION_HISTORY_INCLUDE: readonly ["user", "assistant", "visible_custom", "compaction"];
export type SessionHistoryInclude = (typeof SESSION_HISTORY_INCLUDES)[number];
/** Paths exist only in the host-side inventory and are never returned. */
export interface SessionHistoryInventoryEntry {
    path: string;
    sessionId?: string;
    fileName?: string;
    id?: string;
    sizeBytes?: number;
    modified?: Date | number | string;
    revision?: string;
    headerValid?: boolean;
    cwd?: string;
}
export interface SessionHistoryInventory {
    generation?: number;
    entries: readonly SessionHistoryInventoryEntry[];
}
export type SessionHistoryInventoryValue = SessionHistoryInventory | readonly SessionHistoryInventoryEntry[];
export type SessionHistoryInventoryProvider = (signal?: AbortSignal) => SessionHistoryInventoryValue | Promise<SessionHistoryInventoryValue>;
export interface SessionHistoryInventoryProviderObject {
    list(signal?: AbortSignal): SessionHistoryInventoryValue | Promise<SessionHistoryInventoryValue>;
}
export type SessionHistoryInventorySource = SessionHistoryInventoryValue | SessionHistoryInventoryProvider | SessionHistoryInventoryProviderObject;
export interface SessionHistoryServiceOptions {
    inventory: SessionHistoryInventorySource;
}
export type SessionHistoryOmissionReason = "invalid-inventory" | "missing" | "symlink" | "non-regular" | "over-budget" | "invalid-header" | "session-id-mismatch" | "duplicate" | "duplicate-session-id" | "read-error" | "inventory-error" | "file-limit" | "result-limit";
export interface SessionHistoryOmission {
    reason: SessionHistoryOmissionReason;
    fileName?: string;
    sessionId?: string;
    id?: string;
    message?: string;
    count?: number;
}
export interface SessionHistoryOptions {
    include?: readonly SessionHistoryInclude[];
    /** One result limit: sessions for list, matches for search, entries for reads. */
    limit?: number;
    signal?: AbortSignal;
}
export type SessionHistoryListOptions = SessionHistoryOptions;
export type SessionHistorySearchOptions = SessionHistoryOptions;
export type SessionHistoryReadOptions = SessionHistoryOptions;
export type SessionHistoryCompactionOptions = Omit<SessionHistoryOptions, "include">;
export interface SessionHistorySession {
    sessionId: string;
    resourceUri: string;
    startedAt?: number;
    updatedAt: number;
    sizeBytes: number;
    entryCount: number;
    messageCount: number;
    turnCount: number;
    firstMessage?: string;
    compacted: boolean;
}
export interface SessionHistoryEntry {
    sessionId: string;
    entryId: string;
    turn: number;
    resourceUri: string;
    kind: SessionHistoryInclude;
    text: string;
    timestamp: number;
}
export interface SessionHistoryTurn {
    sessionId: string;
    turn: number;
    startedAt: number;
    userText: string;
    rowCount: number;
    textLength: number;
    entries: readonly SessionHistoryEntry[];
}
interface ScanMetrics {
    filesRead: number;
    bytesRead: number;
    truncated: boolean;
    omissions: readonly SessionHistoryOmission[];
}
export interface SessionHistoryListResult extends ScanMetrics {
    version: typeof SESSION_HISTORY_VERSION;
    generation?: number;
    sessions: readonly SessionHistorySession[];
}
export interface SessionHistorySearchMatch {
    sessionId: string;
    entryId: string;
    turn: number;
    resourceUri: string;
    kind: SessionHistoryInclude;
    timestamp: number;
    snippet: string;
}
export interface SessionHistorySearchResult extends ScanMetrics {
    version: typeof SESSION_HISTORY_VERSION;
    generation?: number;
    query: string;
    matches: readonly SessionHistorySearchMatch[];
    matchCount: number;
}
export interface SessionHistoryCompactionResult extends ScanMetrics {
    version: typeof SESSION_HISTORY_VERSION;
    generation?: number;
    checkpoints: readonly SessionHistoryEntry[];
    checkpointCount: number;
}
export interface SessionHistoryEntryRead {
    sessionId: string;
    entryId: string;
    turn: number;
    resourceUri: string;
    entries: readonly SessionHistoryEntry[];
}
export interface SessionHistoryReadResult extends ScanMetrics {
    version: typeof SESSION_HISTORY_VERSION;
    generation?: number;
    sessionId: string;
    found: boolean;
    selectedTurn?: number;
    selectedEntryId?: string;
    turn?: SessionHistoryTurn;
    selectedEntry?: SessionHistoryEntryRead;
}
export interface SessionHistoryReadRequest extends SessionHistoryReadOptions {
    sessionId: string;
    entryId?: string;
    turn?: number;
}
export declare function sessionHistoryUri(sessionId: string): string;
export declare function sessionEntryUri(sessionId: string, entryId: string): string;
export declare const sessionHistoryEntryUri: typeof sessionEntryUri;
export interface ParsedSessionHistoryUri {
    sessionId: string;
    entryId?: string;
}
export declare function parseSessionHistoryUri(value: string): ParsedSessionHistoryUri | undefined;
export declare class SessionHistoryService {
    #private;
    constructor(source: SessionHistoryInventorySource | SessionHistoryServiceOptions);
    list(options?: SessionHistoryListOptions): Promise<SessionHistoryListResult>;
    listSessions(options?: SessionHistoryListOptions): Promise<SessionHistoryListResult>;
    search(query: string, options?: SessionHistorySearchOptions): Promise<SessionHistorySearchResult>;
    searchSessions(query: string, options?: SessionHistorySearchOptions): Promise<SessionHistorySearchResult>;
    compactions(options?: SessionHistoryCompactionOptions): Promise<SessionHistoryCompactionResult>;
    listCompactions(options?: SessionHistoryCompactionOptions): Promise<SessionHistoryCompactionResult>;
    read(sessionId: string, options?: SessionHistoryReadOptions): Promise<SessionHistoryReadResult>;
    read(request: SessionHistoryReadRequest): Promise<SessionHistoryReadResult>;
    readSession(sessionId: string, options?: SessionHistoryReadOptions): Promise<SessionHistoryReadResult>;
    readEntry(sessionId: string, entryId: string, options?: SessionHistoryReadOptions): Promise<SessionHistoryEntryRead | undefined>;
    readTurn(sessionId: string, turn: number, options?: SessionHistoryReadOptions): Promise<SessionHistoryTurn | undefined>;
    readUri(uri: string, options?: SessionHistoryReadOptions): Promise<SessionHistoryReadResult>;
}
export declare function createSessionHistoryService(source: SessionHistoryInventorySource | SessionHistoryServiceOptions): SessionHistoryService;
export declare function listSessionHistory(source: SessionHistoryInventorySource | SessionHistoryServiceOptions, options?: SessionHistoryListOptions): Promise<SessionHistoryListResult>;
export declare function searchSessionHistory(source: SessionHistoryInventorySource | SessionHistoryServiceOptions, query: string, options?: SessionHistorySearchOptions): Promise<SessionHistorySearchResult>;
export declare function listSessionCompactions(source: SessionHistoryInventorySource | SessionHistoryServiceOptions, options?: SessionHistoryCompactionOptions): Promise<SessionHistoryCompactionResult>;
export declare function readSessionHistory(source: SessionHistoryInventorySource | SessionHistoryServiceOptions, request: SessionHistoryReadRequest): Promise<SessionHistoryReadResult>;
export declare function readSessionHistoryEntry(source: SessionHistoryInventorySource | SessionHistoryServiceOptions, sessionId: string, entryId: string, options?: SessionHistoryReadOptions): Promise<SessionHistoryEntryRead | undefined>;
export declare function readSessionHistoryTurn(source: SessionHistoryInventorySource | SessionHistoryServiceOptions, sessionId: string, turn: number, options?: SessionHistoryReadOptions): Promise<SessionHistoryTurn | undefined>;
export {};
