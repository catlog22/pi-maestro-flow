import { type AgentTerminalStatus, type AgentTurnEvent, type AgentTurnSnapshot } from "./types.ts";
export declare const AGENT_TURN_LEDGER_VERSION: 1;
export declare const AGENT_TURN_EVENT_CUSTOM_TYPE = "teammate-turn-event";
export interface AgentTurnLedgerAgentState {
    correlationId: string;
    current: AgentTurnSnapshot;
    last?: AgentTurnSnapshot;
}
export interface AgentTurnLedgerOwner {
    correlationId: string;
    runtimeGeneration: number;
    promptSeq: number;
}
/**
 * Immutable reducer state. The ownership and fingerprint maps are retained so
 * incremental live updates and a cold fold make the same decisions.
 */
export interface AgentTurnLedger {
    version: typeof AGENT_TURN_LEDGER_VERSION;
    agents: ReadonlyMap<string, AgentTurnLedgerAgentState>;
    turnOwners: ReadonlyMap<string, AgentTurnLedgerOwner>;
    eventFingerprints: ReadonlyMap<string, string>;
}
export type AgentTurnLedgerDiagnosticCode = "malformed-event" | "unsupported-version" | "duplicate-event" | "conflicting-duplicate" | "turn-ownership" | "trigger-ownership" | "stale-generation" | "stale-sequence" | "stale-timestamp" | "stale-lifecycle" | "terminal-absorbed";
export interface AgentTurnLedgerDiagnostic {
    code: AgentTurnLedgerDiagnosticCode;
    message: string;
    correlationId?: string;
    turnId?: string;
    eventIndex?: number;
}
export type AgentTurnEventValidation = {
    valid: true;
    event: AgentTurnEvent;
} | {
    valid: false;
    diagnostic: AgentTurnLedgerDiagnostic;
};
export type AgentTurnLedgerApplyResult = {
    status: "applied";
    ledger: AgentTurnLedger;
    agent: AgentTurnLedgerAgentState;
} | {
    status: "duplicate";
    ledger: AgentTurnLedger;
    diagnostic: AgentTurnLedgerDiagnostic;
    agent?: AgentTurnLedgerAgentState;
} | {
    status: "ignored";
    ledger: AgentTurnLedger;
    diagnostic: AgentTurnLedgerDiagnostic;
    agent?: AgentTurnLedgerAgentState;
} | {
    status: "rejected";
    ledger: AgentTurnLedger;
    diagnostic: AgentTurnLedgerDiagnostic;
};
export interface AgentTurnLedgerFoldResult {
    ledger: AgentTurnLedger;
    diagnostics: readonly AgentTurnLedgerDiagnostic[];
    applied: number;
    duplicates: number;
    ignored: number;
    rejected: number;
}
export declare function createAgentTurnLedger(): AgentTurnLedger;
export declare function agentTurnLedgerAgent(ledger: AgentTurnLedger, correlationId: string): AgentTurnLedgerAgentState | undefined;
/** Validate and canonicalize persisted or live event input without throwing. */
export declare function validateAgentTurnEvent(value: unknown): AgentTurnEventValidation;
/**
 * Apply one event. Rejections, stale events, terminal absorption, and exact
 * duplicates retain the identical ledger reference.
 */
export declare function applyAgentTurnEvent(ledger: AgentTurnLedger, value: unknown): AgentTurnLedgerApplyResult;
export declare const reduceAgentTurnLedger: typeof applyAgentTurnEvent;
/** Build the one terminal event owned by the final orchestration outcome. */
export declare function createAgentTurnTerminalEvent(turn: AgentTurnSnapshot, status: AgentTerminalStatus, message?: string, timestamp?: number): AgentTurnEvent;
/** Fold canonical event values, retaining every diagnostic with its source index. */
export declare function foldAgentTurnEvents(values: readonly unknown[], initialLedger?: AgentTurnLedger): AgentTurnLedgerFoldResult;
/**
 * Rebuild from Pi parent-session entries. Unrelated custom entries are ignored;
 * malformed entries for this module are rejected diagnostically.
 */
export declare function rebuildAgentTurnLedger(entries: readonly unknown[], initialLedger?: AgentTurnLedger): AgentTurnLedgerFoldResult;
