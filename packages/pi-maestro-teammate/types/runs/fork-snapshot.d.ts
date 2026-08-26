export type ForkSnapshotDestination = {
    kind: "path";
    path: string;
} | {
    kind: "temp";
    directory?: string;
};
export interface CreateForkSnapshotOptions {
    sourcePath: string;
    spawningToolCallId: string;
    destination: ForkSnapshotDestination;
}
export type ForkSnapshotDiagnosticCode = "invalid-options" | "source-read-failed" | "invalid-jsonl" | "invalid-session-header" | "unsupported-session-version" | "invalid-entry" | "duplicate-entry-id" | "broken-parent-chain" | "parent-cycle" | "spawning-tool-call-not-found" | "invalid-compaction" | "invalid-tool-call" | "duplicate-tool-call" | "invalid-tool-result" | "unknown-tool-result" | "duplicate-tool-result" | "unmatched-tool-call" | "destination-write-failed";
export interface ForkSnapshotDiagnostic {
    kind: "fork-snapshot-invalid";
    code: ForkSnapshotDiagnosticCode;
    message: string;
    sourcePath: string;
    line?: number;
    entryId?: string;
    toolCallId?: string;
}
export interface ForkSnapshotSuccess {
    ok: true;
    sourcePath: string;
    snapshotPath: string;
    sessionId: string;
    spawningToolCallId: string;
    excludedMessageId: string;
    retainedEntryCount: number;
    retainedLeafId: string | null;
    temporaryDirectory?: string;
    /**
     * Set when a synthetic compaction boundary was injected into the snapshot so
     * the child's provider context excludes the oldest retained history. Callers
     * surface this to the transcript so dispatchers know the forked context was
     * truncated rather than carrying the full parent history.
     */
    injectedCompactionBoundary?: boolean;
}
export interface ForkSnapshotFailure {
    ok: false;
    diagnostic: ForkSnapshotDiagnostic;
}
export type ForkSnapshotResult = ForkSnapshotSuccess | ForkSnapshotFailure;
/**
 * Materialize a Pi v3 fork source immediately before one exact tool call.
 * The spawning assistant message and every descendant are excluded together.
 */
export declare function createForkSnapshot(options: CreateForkSnapshotOptions): ForkSnapshotResult;
