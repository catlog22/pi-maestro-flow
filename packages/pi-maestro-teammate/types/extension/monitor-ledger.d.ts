/**
 * Durable monitor control-plane ledger.
 *
 * Port of pi-peer's `.pi/peer-control-ledger.jsonl` pattern
 * (G:\github_lib\pi-peer\src\peers\control-ledger.mjs) for the fleet
 * Monitor engine: append-only JSONL records, short directory-lock around
 * every append, tolerant load (trailing partial line), and a derived
 * read-model that lets a restarted session reconcile supervision state that
 * outlived the process that created it.
 *
 * Pure file module — no dependency on monitor.ts or index.ts.
 */
export declare const MONITOR_LEDGER_RELATIVE_PATH = ".pi/monitor-ledger.jsonl";
export declare const MONITOR_LEDGER_LOCK_STALE_MS = 30000;
export declare const MONITOR_LEDGER_LOCK_RETRY_MS = 10;
export declare const MONITOR_LEDGER_LOCK_TIMEOUT_MS = 5000;
export type MonitorLedgerRecordKind = "binding" | "intervention" | "outcome" | "analysis" | "delivery" | "review" | "checkpoint";
export interface MonitorLedgerRecord {
    id: string;
    at: string;
    kind: MonitorLedgerRecordKind;
    action: string;
    status?: string;
    target?: string;
    traceId?: string;
    reason?: string;
    mode?: string;
    message?: string;
    outcome?: string;
    attempts?: number;
    metadata?: Record<string, unknown>;
}
export declare function monitorLedgerPath(root: string): string;
export declare function normalizeMonitorLedgerRecord(input: unknown): MonitorLedgerRecord;
export declare function appendMonitorLedgerRecord(root: string, record: MonitorLedgerRecord | Omit<MonitorLedgerRecord, "id" | "at">): Promise<MonitorLedgerRecord>;
export declare function loadMonitorLedger(root: string): Promise<{
    records: MonitorLedgerRecord[];
    warnings: string[];
}>;
export interface MonitorBindingLedgerState {
    target: string;
    displayName?: string;
    mode?: string;
    customPrompt?: string;
    goalId?: string;
    /** Last binding status: active | disconnected | gone | removed | cleared | user-exit | shutdown */
    status: string;
    startedAt?: string;
    updatedAt: string;
    interventionCount: number;
    outcomeCount: number;
    escalated: boolean;
}
export interface MonitorLedgerState {
    records: number;
    bindings: MonitorBindingLedgerState[];
    activeBindings: MonitorBindingLedgerState[];
    disconnectedBindings: MonitorBindingLedgerState[];
    interventions: MonitorLedgerRecord[];
    outcomes: MonitorLedgerRecord[];
    deadLetters: MonitorLedgerRecord[];
    analyses: MonitorLedgerRecord[];
    reviews: MonitorLedgerRecord[];
}
export declare function deriveMonitorLedgerState(records: readonly (MonitorLedgerRecord | Omit<MonitorLedgerRecord, "id" | "at">)[], _options?: {
    nowMs?: number;
}): MonitorLedgerState;
export declare function reconcileMonitorLedger(root: string, input?: {
    liveTargets?: readonly string[];
    nowMs?: number;
}): Promise<{
    records: MonitorLedgerRecord[];
    state: MonitorLedgerState;
    warnings: string[];
}>;
