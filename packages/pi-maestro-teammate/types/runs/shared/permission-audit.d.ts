/**
 * Best-effort permission audit logging, isolated from the reply path.
 *
 * One JSONL stream belongs to one parent Pi session. Writes are queued on a
 * promise tail, serialized in-process, and fully contained so filesystem
 * failure can never change a permission decision or delay its IPC reply.
 */
import type { FileHandle } from "node:fs/promises";
export declare const PERMISSION_AUDIT_MAX_BYTES: number;
export declare const PERMISSION_AUDIT_FILE_COUNT = 3;
export declare const PERMISSION_AUDIT_REASON_MAX_BYTES = 1024;
export declare const PERMISSION_AUDIT_RELATIVE_PATH: string;
export type PermissionAuditEventType = "permission_request" | "permission_decision";
export type PermissionAuditSource = "child" | "automatic" | "broker" | "ui" | "headless" | "queue_cancel" | "queue_timeout" | "queue_error" | "error";
export interface PermissionAuditInput {
    parentSessionFile?: string | null;
    event: PermissionAuditEventType;
    requestId: string;
    correlationId?: string;
    agent?: string;
    toolName?: string;
    input?: unknown;
    action: string;
    source: PermissionAuditSource;
    reason?: unknown;
    timestamp?: number;
}
export interface PermissionAuditRecord {
    version: 1;
    timestamp: string;
    event: PermissionAuditEventType;
    requestId: string;
    correlationId?: string;
    agent?: string;
    toolName: string;
    preview?: string;
    action: string;
    source: PermissionAuditSource;
    reason?: string;
}
export interface PermissionAuditIdentity {
    correlationId?: string;
    agent?: string;
}
export interface PermissionRequestAuditAdmission {
    parentSessionFile: string | null;
    decisionRecorded: boolean;
}
/** Preserve queue admission context without mutating the child-owned event. */
export declare function markPermissionRequestAuditAdmission(event: Record<string, unknown>, parentSessionFile: string | null | undefined): void;
export declare function permissionRequestAuditAdmission(event: Record<string, unknown>): PermissionRequestAuditAdmission | undefined;
export declare function permissionAuditFilePath(parentSessionFile: string | null | undefined): string | undefined;
export declare function buildPermissionAuditRecord(input: PermissionAuditInput): PermissionAuditRecord;
type PermissionAuditFileOpen = (filePath: string, flags: number, mode: number) => Promise<FileHandle>;
export declare function appendPermissionAuditRecord(filePath: string, record: PermissionAuditRecord, maxBytes?: number): Promise<void>;
type PermissionAuditWriter = typeof appendPermissionAuditRecord;
/** Schedule an audit record without exposing filesystem work to the reply path. */
export declare function schedulePermissionAudit(input: PermissionAuditInput): void;
/** Test-only writer injection for deterministic slow/failing I/O coverage. */
export declare function setPermissionAuditWriterForTests(writer: PermissionAuditWriter): () => void;
/** Test-only open injection for deterministic post-open validation failures. */
export declare function setPermissionAuditFileOpenForTests(openFile: PermissionAuditFileOpen): () => void;
/** Test/cleanup barrier for work already appended to the promise tail. */
export declare function flushPermissionAuditWrites(): Promise<void>;
export declare function schedulePermissionRequestAudit(parentSessionFile: string | null | undefined, event: Record<string, unknown>, identity?: PermissionAuditIdentity): void;
export declare function schedulePermissionDecisionAudit(parentSessionFile: string | null | undefined, event: Record<string, unknown>, identity: PermissionAuditIdentity, action: string, source: Exclude<PermissionAuditSource, "child">, reason?: unknown): void;
export {};
