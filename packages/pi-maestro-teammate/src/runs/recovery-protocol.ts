export const RECOVERY_PROTOCOL_VERSION = 1 as const;

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

export type ReplayFence =
  | {
      completedTools: readonly string[];
      blocked: false;
      blockedReason?: undefined;
    }
  | {
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

export type RecoveryIntent =
  | RecoveryRetryProviderIntent
  | RecoveryFallbackModelIntent
  | RecoveryCompactContextIntent
  | RecoveryContinueOutputIntent
  | RecoveryDrainQueueIntent
  | RecoverySettleIntent;

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

export type RecoveryAttemptEndedEvent =
  | RecoveryAttemptSucceededEvent
  | RecoveryAttemptFailedEvent
  | RecoveryAttemptCancelledEvent;

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

export type RecoveryDecisionEvent =
  | RecoveryRetryProviderDecisionEvent
  | RecoveryFallbackModelDecisionEvent
  | RecoveryCompactContextDecisionEvent
  | RecoveryContinueOutputDecisionEvent
  | RecoveryDrainQueueDecisionEvent
  | RecoverySettleDecisionEvent;

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

export type RecoverySettledEvent =
  | RecoverySucceededEvent
  | RecoveryFailedEvent
  | RecoveryCancelledEvent;

export type RecoveryProtocolEvent =
  | RecoveryAttemptEndedEvent
  | RecoveryDecisionEvent
  | RecoverySettledEvent;

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

export type RecoveryProtocolViolationCode =
  | "protocol-version"
  | "recovery-id"
  | "sequence"
  | "attempt-id"
  | "duplicate-attempt"
  | "missing-decision"
  | "unknown-attempt"
  | "duplicate-decision"
  | "settling"
  | "settle-decision"
  | "settle-outcome"
  | "intent-id"
  | "ownership"
  | "replay-fence"
  | "budget";

export interface RecoveryProtocolViolation {
  code: RecoveryProtocolViolationCode;
  message: string;
}

export type RecoveryProtocolValidation =
  | { valid: true; absorbed: boolean }
  | { valid: false; violation: RecoveryProtocolViolation };

export class RecoveryProtocolError extends Error {
  readonly code: RecoveryProtocolViolationCode;

  constructor(violation: RecoveryProtocolViolation) {
    super(violation.message);
    this.name = "RecoveryProtocolError";
    this.code = violation.code;
  }
}

export function createRecoveryProtocolState(recoveryId: string): RecoveryProtocolState {
  if (recoveryId.length === 0) throw new TypeError("Recovery id must not be empty");
  return {
    protocolVersion: RECOVERY_PROTOCOL_VERSION,
    recoveryId,
    phase: "active",
    attempts: [],
  };
}

export function validateRecoveryEvent(
  state: RecoveryProtocolState,
  event: RecoveryProtocolEvent,
): RecoveryProtocolValidation {
  if (event.protocolVersion !== RECOVERY_PROTOCOL_VERSION) {
    return invalid("protocol-version", `Unsupported recovery protocol version: ${event.protocolVersion}`);
  }
  if (event.recoveryId !== state.recoveryId) {
    return invalid("recovery-id", `Recovery event belongs to ${event.recoveryId}, expected ${state.recoveryId}`);
  }
  const expectedOwner: RecoveryOwner = event.scope === "main" ? "pi-core" : "teammate";
  if (event.owner !== expectedOwner) {
    return invalid("ownership", `Recovery scope ${event.scope} requires owner ${expectedOwner}`);
  }
  if ((state.scope !== undefined && event.scope !== state.scope)
    || (state.owner !== undefined && event.owner !== state.owner)) {
    return invalid("ownership", "Recovery event scope and owner must remain stable within one stream");
  }
  // Terminal absorption applies only to late events from the same owned
  // recovery stream. Misrouted events must remain visible to callers.
  if (state.phase === "settled") return { valid: true, absorbed: true };

  if (!Number.isInteger(event.sequence)
    || event.sequence < 0
    || (state.lastSequence !== undefined && event.sequence <= state.lastSequence)) {
    return invalid("sequence", "Recovery event sequence must increase monotonically");
  }
  if (event.attemptId.length === 0) {
    return invalid("attempt-id", "Recovery attempt id must not be empty");
  }

  if (event.type === "attempt-ended") {
    if (state.phase !== "active") {
      return invalid("settling", "A new attempt cannot end after a settle decision");
    }
    if (state.attempts.some((attempt) => attempt.ended.attemptId === event.attemptId)) {
      return invalid("duplicate-attempt", `Attempt ${event.attemptId} already ended`);
    }
    if (state.attempts.some((attempt) => attempt.decision === undefined)) {
      return invalid("missing-decision", "Every ended attempt requires one decision before the next attempt");
    }
    return { valid: true, absorbed: false };
  }

  const attempt = state.attempts.find((candidate) => candidate.ended.attemptId === event.attemptId);
  if (!attempt) return invalid("unknown-attempt", `Attempt ${event.attemptId} has not ended`);

  if (event.type === "decision") {
    if (state.phase !== "active") {
      return invalid("settling", "A decision cannot follow a settle decision");
    }
    if (attempt.decision) {
      return invalid("duplicate-decision", `Attempt ${event.attemptId} already has a decision`);
    }
    if (event.intent.intentId.length === 0) {
      return invalid("intent-id", "Recovery intent id must not be empty");
    }
    if (event.intent.kind === "fallback_model"
      && event.intent.mode === "restart"
      && event.intent.replayFence.blocked) {
      return invalid("replay-fence", "A blocked replay fence cannot authorize a fallback restart");
    }
    const budgetViolation = validateIntentBudget(event.intent);
    if (budgetViolation) return { valid: false, violation: budgetViolation };
    return { valid: true, absorbed: false };
  }

  if (state.phase !== "settling") {
    return invalid("settling", "Settlement requires a preceding settle decision");
  }
  const settleIntent = attempt.decision?.intent;
  if (settleIntent?.kind !== "settle") {
    return invalid("settle-decision", `Attempt ${event.attemptId} was not selected for settlement`);
  }
  if (settleIntent.outcome !== event.outcome || settleIntent.reason !== event.reason) {
    return invalid("settle-outcome", "Settlement must match the preceding settle decision");
  }
  return { valid: true, absorbed: false };
}

export function reduceRecoveryEvent(
  state: RecoveryProtocolState,
  event: RecoveryProtocolEvent,
): RecoveryProtocolState {
  const validation = validateRecoveryEvent(state, event);
  if (!validation.valid) throw new RecoveryProtocolError(validation.violation);
  if (validation.absorbed) return state;

  if (event.type === "attempt-ended") {
    return {
      ...state,
      scope: state.scope ?? event.scope,
      owner: state.owner ?? event.owner,
      lastSequence: event.sequence,
      attempts: [...state.attempts, { ended: event }],
    };
  }

  if (event.type === "decision") {
    return {
      ...state,
      phase: event.intent.kind === "settle" ? "settling" : "active",
      lastSequence: event.sequence,
      attempts: state.attempts.map((attempt) => attempt.ended.attemptId === event.attemptId
        ? { ...attempt, decision: event }
        : attempt),
    };
  }

  return {
    ...state,
    phase: "settled",
    lastSequence: event.sequence,
    settled: event,
  };
}

function validateIntentBudget(intent: RecoveryIntent): RecoveryProtocolViolation | undefined {
  if (intent.kind === "retry_provider") return validateBudget(intent.budget, "provider-retry");
  if (intent.kind === "compact_context") return validateBudget(intent.budget, "compaction");
  if (intent.kind === "continue_output") return validateBudget(intent.budget, "output-continuation");
  return undefined;
}

function validateBudget(
  budget: RecoveryBudget,
  expectedName: RecoveryBudgetName,
): RecoveryProtocolViolation | undefined {
  const arithmeticIsValid = Number.isInteger(budget.maxRetries)
    && budget.maxRetries >= 0
    && Number.isInteger(budget.retriesUsed)
    && budget.retriesUsed >= 0
    && Number.isInteger(budget.remainingRetries)
    && budget.remainingRetries >= 0
    && budget.retriesUsed <= budget.maxRetries
    && budget.remainingRetries === budget.maxRetries - budget.retriesUsed;
  if (budget.name === expectedName && arithmeticIsValid) return undefined;
  return {
    code: "budget",
    message: `Recovery budget ${expectedName} must satisfy remainingRetries = maxRetries - retriesUsed`,
  };
}

function invalid(code: RecoveryProtocolViolationCode, message: string): RecoveryProtocolValidation {
  return { valid: false, violation: { code, message } };
}
