/**
 * Centralized diagnostic logger for pi-maestro-teammate.
 *
 * Replaces scattered `console.error`/`console.warn` calls with a single
 * sink that:
 *   1. Appends the message to a per-day log file under
 *      `<rootDir>/logs/error-YYYY-MM-DD.log` (default root: `~/.pi/teammate`).
 *   2. Rotates by day and by size (a file exceeding `maxFileBytes` is renamed
 *      to `*.1` and a fresh file is started; at most `maxRotatedFiles` rotated
 *      copies are kept).
 *   3. Prunes log files older than `retentionDays`.
 *   4. Tracks an in-memory summary (count + last message) so the extension's
 *      status bar segment can surface a badge without re-reading the file.
 *   5. Optionally fires a one-shot UI notify/toast when a new error arrives,
 *      and exposes the status key the footer reads.
 *
 * The module is process-singleton: one logger instance per Pi process.
 * Writes are synchronous (`appendFileSync`) so diagnostics survive a crash
 * that follows immediately after — matching the reliability expectation of
 * an error reporter. All file I/O is best-effort: a write failure must never
 * throw back into the caller's error-handling path.
 */
export declare const DIAGNOSTIC_STATUS_KEY = "pi-teammate-diagnostic";
export type DiagnosticLevel = "error" | "warn";
export interface DiagnosticLogConfig {
    /** Root directory holding the `logs/` folder. Defaults to `~/.pi/teammate`. */
    rootDir: string;
    /** Max bytes before a log file is rotated. */
    maxFileBytes: number;
    /** Number of rotated `*.1` copies to keep per day. */
    maxRotatedFiles: number;
    /** Days of log files to retain; older files are pruned. */
    retentionDays: number;
}
export declare const DEFAULT_DIAGNOSTIC_CONFIG: DiagnosticLogConfig;
export interface DiagnosticUiBridge {
    /** Set the status-bar segment text; pass undefined to clear. */
    setStatus(text: string | undefined): void;
    /** Fire a one-shot toast. */
    notify(message: string, type: "info" | "warning" | "error"): void;
}
export interface DiagnosticSummary {
    /** Total errors logged since the process started (monotonic). */
    errorCount: number;
    /** Total warnings logged since the process started (monotonic). */
    warnCount: number;
    /** Unread error count — reset by `acknowledge()`. */
    unreadErrors: number;
    /** Truncated last error message (first line), or undefined when none. */
    lastErrorMessage: string | undefined;
    /** ISO timestamp of the last error, or undefined when none. */
    lastErrorAt: string | undefined;
}
export interface DiagnosticLogger {
    logError(message: string, error?: unknown): void;
    logWarn(message: string, error?: unknown): void;
    /** Get a snapshot of the current in-memory summary. */
    getSummary(): Readonly<DiagnosticSummary>;
    /** Mark all currently-unread errors as acknowledged (resets the badge). */
    acknowledge(): void;
    /** Inject the UI bridge; without it, logging still writes files. */
    setUiBridge(bridge: DiagnosticUiBridge | undefined): void;
    /** Reconfigure (mainly for tests with a temp rootDir). */
    configure(config: Partial<DiagnosticLogConfig>): void;
}
declare function todayStamp(d?: Date): string;
declare function todayLogFile(config: DiagnosticLogConfig): string;
declare function extractFirstLine(value: string): string;
declare function buildLogLine(level: DiagnosticLevel, message: string, error?: unknown): string;
/**
 * Get the process-wide diagnostic logger. The first call lazily initializes it
 * with the default config; tests may call `configureDiagnosticLogger` to point
 * it at a temp directory before exercising it.
 */
export declare function getDiagnosticLogger(): DiagnosticLogger;
/**
 * Configure (or reset) the process singleton. Intended for tests that need a
 * temp `rootDir` and deterministic size/retention thresholds.
 */
export declare function configureDiagnosticLogger(config: Partial<DiagnosticLogConfig>): DiagnosticLogger;
/**
 * Reset the singleton to a fresh instance (tests only). Swaps out the in-memory
 * summary so tests start clean.
 */
export declare function resetDiagnosticLogger(config?: Partial<DiagnosticLogConfig>): DiagnosticLogger;
/**
 * Convenience entry points so call sites can write
 * `logDiagnosticError("…", err)` without holding a logger reference.
 */
export declare function logDiagnosticError(message: string, error?: unknown): void;
export declare function logDiagnosticWarn(message: string, error?: unknown): void;
export { todayStamp, todayLogFile, buildLogLine, extractFirstLine };
export declare const DIAGNOSTIC_LOG_CONSTANTS: {
    LOG_DIR_NAME: string;
    LOG_FILE_PREFIX: string;
    LOG_FILE_SUFFIX: string;
    ROTATED_SUFFIX: string;
};
