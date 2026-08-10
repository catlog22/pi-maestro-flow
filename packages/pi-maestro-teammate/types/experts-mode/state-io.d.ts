/**
 * Atomic JSON state write for .experts-mode.json (and similar).
 * Writes to a temp file in the same directory then renames (best-effort
 * atomic on Windows with short retries).
 */
export declare function writeJsonStateFile(filePath: string, data: unknown, opts?: {
    retries?: number;
}): void;
export declare function readJsonStateFile(filePath: string): Record<string, unknown>;
/**
 * MV-02: serialize async RMW on a state file.
 * Callers that await between read and write should wrap the whole critical section.
 */
export declare function withStateLock<T>(filePath: string, fn: () => T | Promise<T>): Promise<T>;
/**
 * MV-02: single-process sync critical section for state RMW.
 * Nesting on the same path is allowed (depth counter); concurrent async
 * callers still rely on withStateLock or on not awaiting mid-mutation.
 */
export declare function withStateLockSync<T>(filePath: string, fn: () => T): T;
/**
 * Read → mutate → atomic write under the sync lock (preferred RMW helper).
 */
export declare function mutateJsonStateFile(filePath: string, mutator: (prev: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown>;
