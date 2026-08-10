import { type WindowThreadDirection, type WindowThreadEntry, type WindowThreadStatus } from "./session-core.ts";
export interface WindowInboxQuery {
    session?: string;
    peer?: string;
    direction?: WindowThreadDirection;
    status?: WindowThreadStatus;
    limit?: number;
}
export interface WindowInboxEntry {
    sessionId: string;
    sessionName?: string;
    sessionFile: string;
    current: boolean;
    messageId: string;
    peerOwnerId: string;
    direction: WindowThreadDirection;
    source: WindowThreadEntry["source"];
    messageKind?: WindowThreadEntry["messageKind"];
    mode: WindowThreadEntry["mode"];
    effectiveMode?: WindowThreadEntry["effectiveMode"];
    body: string;
    bodyTruncated: boolean;
    status: WindowThreadStatus;
    createdAt: number;
    updatedAt: number;
    revision: number;
}
export interface WindowInboxResult {
    entries: WindowInboxEntry[];
    scannedSessionCount: number;
    matchedSessionCount: number;
    skippedSessionFileCount: number;
    archiveTruncated: boolean;
    selector?: string;
}
export declare function resolveWindowInboxAnchor(mainSessionFile: string | null | undefined, contextSessionFile: string | null | undefined): string | undefined;
export declare function loadWorkspaceWindowInbox(currentSessionFile: string | null | undefined, query?: WindowInboxQuery): Promise<WindowInboxResult>;
export declare function formatWorkspaceWindowInbox(result: WindowInboxResult): string;
