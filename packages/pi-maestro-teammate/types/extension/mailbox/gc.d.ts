import type { MailboxFileStore, MailboxMutationAuthority } from "./file-store.ts";
import { type MailboxPriority, type MailboxState } from "./types.ts";
export interface GCResult {
    removed: number;
    errors: string[];
}
export interface GCCandidate {
    state: MailboxState;
    messageId: string;
    reason: string;
}
export interface MailboxGCOptions {
    store: MailboxFileStore;
    now?: () => number;
    /** Mutation-authority preflight; false makes a sweep a no-op. */
    canMutate?: () => boolean | Promise<boolean>;
    /** Revalidated from inside every destructive store commit. */
    mutationAuthority?: MailboxMutationAuthority;
    /** Maximum records inspected/mutated by one sweep. */
    maxSweep?: number;
}
export declare class MailboxGC {
    #private;
    constructor(options: MailboxGCOptions);
    collectEligible(): Promise<GCCandidate[]>;
    run(): Promise<GCResult>;
}
export interface QuotaAdmissionOptions {
    store: MailboxFileStore;
    /** Override hard total for testing (default: QUOTA_HARD_TOTAL). */
    hardTotal?: number;
    /** Override normal max for testing (default: QUOTA_NORMAL_MAX). */
    normalMax?: number;
}
export interface QuotaAdmissionResult {
    allowed: boolean;
    code?: "quota_exceeded";
    live: number;
}
export declare class QuotaAdmission {
    #private;
    constructor(options: QuotaAdmissionOptions);
    check(priority: MailboxPriority): Promise<QuotaAdmissionResult>;
}
