export declare const RECOVERY_PROTOCOL_VERSION: 1;
export type RecoveryProtocolVersion = typeof RECOVERY_PROTOCOL_VERSION;
export type RecoveryScope = "main" | "teammate";
export type RecoveryOwner = "pi-core" | "teammate";
export interface RecoveryEventBase {
    protocolVersion: RecoveryProtocolVersion;
    recoveryId: string;
    sequence: number;
    scope: RecoveryScope;
    owner: RecoveryOwner;
}
export type RecoveryBudgetName = "provider-retry" | "compaction" | "output-continuation";
/** `maxRetries` counts retries after the initial attempt. */
export interface RecoveryBudget<Name extends RecoveryBudgetName = RecoveryBudgetName> {
    name: Name;
    maxRetries: number;
    retriesUsed: number;
    remainingRetries: number;
}
export type ReplayFence = {
    completedTools: readonly string[];
    blocked: false;
    blockedReason?: undefined;
} | {
    completedTools: readonly string[];
    blocked: true;
    blockedReason: string;
};
interface RecoveryIntentBase {
    intentId: string;
}
export interface RecoveryRetryProviderIntent extends RecoveryIntentBase {
    kind: "retry_provider";
    model: string;
    delayMs: number;
    budget: RecoveryBudget<"provider-retry">;
}
export interface RecoveryFallbackModelIntent extends RecoveryIntentBase {
    kind: "fallback_model";
    fromModel: string;
    toModel: string;
    mode: "continue_context" | "restart";
    replayFence: ReplayFence;
}
export interface RecoveryCompactContextIntent extends RecoveryIntentBase {
    kind: "compact_context";
    reason: "context_overflow";
    budget: RecoveryBudget<"compaction">;
}
export interface RecoveryContinueOutputIntent extends RecoveryIntentBase {
    kind: "continue_output";
    budget: RecoveryBudget<"output-continuation">;
}
export interface RecoveryDrainQueueIntent extends RecoveryIntentBase {
    kind: "drain_queue";
    messageId: string;
    origin: "user" | "extension";
}
export interface RecoverySettleIntent extends RecoveryIntentBase {
    kind: "settle";
    outcome: "success" | "failure" | "cancelled";
    reason?: string;
}
export type RecoveryIntent = RecoveryRetryProviderIntent | RecoveryFallbackModelIntent | RecoveryCompactContextIntent | RecoveryContinueOutputIntent | RecoveryDrainQueueIntent | RecoverySettleIntent;
interface RecoveryAttemptEndedEventBase extends RecoveryEventBase {
    type: "attempt-ended";
    attemptId: string;
}
export interface RecoveryAttemptSucceededEvent extends RecoveryAttemptEndedEventBase {
    outcome: "success";
}
export interface RecoveryAttemptFailedEvent extends RecoveryAttemptEndedEventBase {
    outcome: "failure";
    retryable: boolean;
    error?: string;
}
export interface RecoveryAttemptCancelledEvent extends RecoveryAttemptEndedEventBase {
    outcome: "cancelled";
    reason?: string;
}
export type RecoveryAttemptEndedEvent = RecoveryAttemptSucceededEvent | RecoveryAttemptFailedEvent | RecoveryAttemptCancelledEvent;
interface RecoveryDecisionEventBase extends RecoveryEventBase {
    type: "decision";
    attemptId: string;
}
export interface RecoveryRetryProviderDecisionEvent extends RecoveryDecisionEventBase {
    intent: RecoveryRetryProviderIntent;
}
export interface RecoveryFallbackModelDecisionEvent extends RecoveryDecisionEventBase {
    intent: RecoveryFallbackModelIntent;
}
export interface RecoveryCompactContextDecisionEvent extends RecoveryDecisionEventBase {
    intent: RecoveryCompactContextIntent;
}
export interface RecoveryContinueOutputDecisionEvent extends RecoveryDecisionEventBase {
    intent: RecoveryContinueOutputIntent;
}
export interface RecoveryDrainQueueDecisionEvent extends RecoveryDecisionEventBase {
    intent: RecoveryDrainQueueIntent;
}
export interface RecoverySettleDecisionEvent extends RecoveryDecisionEventBase {
    intent: RecoverySettleIntent;
}
export type RecoveryDecisionEvent = RecoveryRetryProviderDecisionEvent | RecoveryFallbackModelDecisionEvent | RecoveryCompactContextDecisionEvent | RecoveryContinueOutputDecisionEvent | RecoveryDrainQueueDecisionEvent | RecoverySettleDecisionEvent;
interface RecoverySettledEventBase extends RecoveryEventBase {
    type: "settled";
    attemptId: string;
    reason?: string;
}
export interface RecoverySucceededEvent extends RecoverySettledEventBase {
    outcome: "success";
}
export interface RecoveryFailedEvent extends RecoverySettledEventBase {
    outcome: "failure";
}
export interface RecoveryCancelledEvent extends RecoverySettledEventBase {
    outcome: "cancelled";
}
export type RecoverySettledEvent = RecoverySucceededEvent | RecoveryFailedEvent | RecoveryCancelledEvent;
export type RecoveryProtocolEvent = RecoveryAttemptEndedEvent | RecoveryDecisionEvent | RecoverySettledEvent;
export type RecoveryProtocolPhase = "active" | "settling" | "settled";
export interface RecoveryAttemptState {
    ended: RecoveryAttemptEndedEvent;
    decision?: RecoveryDecisionEvent;
}
export interface RecoveryProtocolState {
    protocolVersion: RecoveryProtocolVersion;
    recoveryId: string;
    phase: RecoveryProtocolPhase;
    scope?: RecoveryScope;
    owner?: RecoveryOwner;
    lastSequence?: number;
    attempts: readonly RecoveryAttemptState[];
    settled?: RecoverySettledEvent;
}
export type RecoveryProtocolViolationCode = "protocol-version" | "recovery-id" | "sequence" | "attempt-id" | "duplicate-attempt" | "missing-decision" | "unknown-attempt" | "duplicate-decision" | "settling" | "settle-decision" | "settle-outcome" | "intent-id" | "ownership" | "replay-fence" | "budget";
export interface RecoveryProtocolViolation {
    code: RecoveryProtocolViolationCode;
    message: string;
}
export type RecoveryProtocolValidation = {
    valid: true;
    absorbed: boolean;
} | {
    valid: false;
    violation: RecoveryProtocolViolation;
};
export declare class RecoveryProtocolError extends Error {
    readonly code: RecoveryProtocolViolationCode;
    constructor(violation: RecoveryProtocolViolation);
}
export declare function createRecoveryProtocolState(recoveryId: string): RecoveryProtocolState;
export declare function validateRecoveryEvent(state: RecoveryProtocolState, event: RecoveryProtocolEvent): RecoveryProtocolValidation;
export declare function reduceRecoveryEvent(state: RecoveryProtocolState, event: RecoveryProtocolEvent): RecoveryProtocolState;
export {};
