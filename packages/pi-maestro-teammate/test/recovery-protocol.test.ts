import assert from "node:assert/strict";
import test from "node:test";
import {
  RECOVERY_PROTOCOL_VERSION,
  RecoveryProtocolError,
  createRecoveryProtocolState,
  reduceRecoveryEvent,
  validateRecoveryEvent,
  type RecoveryAttemptEndedEvent,
  type RecoveryBudget,
  type RecoveryBudgetName,
  type RecoveryDecisionEvent,
  type RecoveryEventBase,
  type RecoveryIntent,
  type RecoveryProtocolEvent,
  type RecoverySettledEvent,
} from "../src/public/v1/retry.ts";

const recoveryId = "recovery-1";

function eventBase(sequence: number): RecoveryEventBase {
  return {
    protocolVersion: RECOVERY_PROTOCOL_VERSION,
    recoveryId,
    sequence,
    scope: "main",
    owner: "pi-core",
  };
}

function budget<Name extends RecoveryBudgetName>(
  name: Name,
  maxRetries = 2,
  retriesUsed = 0,
): RecoveryBudget<Name> {
  return { name, maxRetries, retriesUsed, remainingRetries: maxRetries - retriesUsed };
}

function attemptEnded(
  sequence: number,
  attemptId: string,
  outcome: "success" | "failure" = "failure",
): RecoveryAttemptEndedEvent {
  return outcome === "success"
    ? { ...eventBase(sequence), type: "attempt-ended", attemptId, outcome }
    : { ...eventBase(sequence), type: "attempt-ended", attemptId, outcome, retryable: true };
}

function decision(sequence: number, attemptId: string, intent: RecoveryIntent): RecoveryDecisionEvent {
  const event = { ...eventBase(sequence), type: "decision" as const, attemptId };
  switch (intent.kind) {
    case "retry_provider": return { ...event, intent };
    case "fallback_model": return { ...event, intent };
    case "compact_context": return { ...event, intent };
    case "continue_output": return { ...event, intent };
    case "drain_queue": return { ...event, intent };
    case "settle": return { ...event, intent };
  }
}

function settled(
  sequence: number,
  attemptId: string,
  outcome: "success" | "failure" | "cancelled" = "success",
  reason?: string,
): RecoverySettledEvent {
  return { ...eventBase(sequence), type: "settled", attemptId, outcome, ...(reason ? { reason } : {}) };
}

function expectViolation(action: () => unknown, code: RecoveryProtocolError["code"]): void {
  assert.throws(action, (error) => error instanceof RecoveryProtocolError && error.code === code);
}

const retryProvider: RecoveryIntent = {
  intentId: "retry-provider",
  kind: "retry_provider",
  model: "provider/model",
  delayMs: 1_000,
  budget: budget("provider-retry", 3, 1),
};

const fallbackModel: RecoveryIntent = {
  intentId: "fallback-model",
  kind: "fallback_model",
  fromModel: "provider/primary",
  toModel: "provider/fallback",
  mode: "continue_context",
  replayFence: {
    completedTools: ["read", "grep"],
    blocked: true,
    blockedReason: "completed tools prohibit a fresh restart",
  },
};

const compactContext: RecoveryIntent = {
  intentId: "compact-context",
  kind: "compact_context",
  reason: "context_overflow",
  budget: budget("compaction", 2, 0),
};

const continueOutput: RecoveryIntent = {
  intentId: "continue-output",
  kind: "continue_output",
  budget: budget("output-continuation", 1, 0),
};

const drainQueue: RecoveryIntent = {
  intentId: "drain-queue",
  kind: "drain_queue",
  messageId: "message-1",
  origin: "extension",
};

const settleSuccess: RecoveryIntent = {
  intentId: "settle-success",
  kind: "settle",
  outcome: "success",
};

test("public v1 contract represents all six typed recovery intents", () => {
  const intents = [retryProvider, fallbackModel, compactContext, continueOutput, drainQueue, settleSuccess];

  for (const [index, intent] of intents.entries()) {
    const ended = reduceRecoveryEvent(createRecoveryProtocolState(recoveryId), attemptEnded(0, `attempt-${index}`));
    const decided = reduceRecoveryEvent(ended, decision(1, `attempt-${index}`, intent));
    assert.equal(decided.attempts[0]?.decision?.intent.kind, intent.kind);
    assert.equal(decided.phase, intent.kind === "settle" ? "settling" : "active");
  }

  assert.deepEqual(retryProvider, {
    intentId: "retry-provider",
    kind: "retry_provider",
    model: "provider/model",
    delayMs: 1_000,
    budget: { name: "provider-retry", maxRetries: 3, retriesUsed: 1, remainingRetries: 2 },
  });
  assert.deepEqual(fallbackModel.replayFence, {
    completedTools: ["read", "grep"],
    blocked: true,
    blockedReason: "completed tools prohibit a fresh restart",
  });
  assert.equal(compactContext.reason, "context_overflow");
  assert.equal(continueOutput.budget.name, "output-continuation");
  assert.equal(drainQueue.origin, "extension");
  assert.equal(settleSuccess.outcome, "success");
});

test("event base carries explicit scope and owner without duplicating owner on the intent", () => {
  const event = decision(1, "attempt-1", retryProvider);
  assert.equal(event.scope, "main");
  assert.equal(event.owner, "pi-core");
  assert.equal("owner" in event.intent, false);
});

test("event base enforces stable scope ownership", () => {
  const invalidMainOwner = { ...attemptEnded(0, "attempt-1"), owner: "teammate" as const };
  expectViolation(
    () => reduceRecoveryEvent(createRecoveryProtocolState(recoveryId), invalidMainOwner),
    "ownership",
  );

  const initial = reduceRecoveryEvent(createRecoveryProtocolState(recoveryId), attemptEnded(0, "attempt-1"));
  const switchedScope = {
    ...decision(1, "attempt-1", retryProvider),
    scope: "teammate" as const,
    owner: "teammate" as const,
  };
  expectViolation(() => reduceRecoveryEvent(initial, switchedScope), "ownership");
});

test("reduces provider retry followed by a matching terminal settlement without mutating prior states", () => {
  const initial = createRecoveryProtocolState(recoveryId);
  const firstEnded = reduceRecoveryEvent(initial, attemptEnded(0, "attempt-1"));
  const retrying = reduceRecoveryEvent(firstEnded, decision(2, "attempt-1", retryProvider));
  const secondEnded = reduceRecoveryEvent(retrying, attemptEnded(3, "attempt-2", "success"));
  const settling = reduceRecoveryEvent(secondEnded, decision(4, "attempt-2", settleSuccess));
  const terminal = reduceRecoveryEvent(settling, settled(5, "attempt-2"));

  assert.equal(initial.attempts.length, 0);
  assert.equal(firstEnded.lastSequence, 0);
  assert.equal(retrying.phase, "active");
  assert.equal(retrying.attempts[0]?.decision?.intent.kind, "retry_provider");
  assert.equal(settling.phase, "settling");
  assert.equal(terminal.phase, "settled");
  assert.equal(terminal.settled?.outcome, "success");
  assert.equal(terminal.attempts.length, 2);
});

test("validates named retry-budget arithmetic", () => {
  const ended = reduceRecoveryEvent(createRecoveryProtocolState(recoveryId), attemptEnded(0, "attempt-1"));
  const wrongRemaining = structuredClone(retryProvider);
  wrongRemaining.budget.remainingRetries = 1;
  expectViolation(() => reduceRecoveryEvent(ended, decision(1, "attempt-1", wrongRemaining)), "budget");

  const wrongName = structuredClone(retryProvider) as RecoveryIntent & { kind: "retry_provider" };
  wrongName.budget.name = "compaction" as "provider-retry";
  expectViolation(() => reduceRecoveryEvent(ended, decision(1, "attempt-1", wrongName)), "budget");

  const noRetryBudget = budget("provider-retry", 0, 0);
  assert.deepEqual(noRetryBudget, {
    name: "provider-retry",
    maxRetries: 0,
    retriesUsed: 0,
    remainingRetries: 0,
  });
});

test("requires strictly increasing event sequence while permitting gaps", () => {
  const ended = reduceRecoveryEvent(createRecoveryProtocolState(recoveryId), attemptEnded(10, "attempt-1"));

  expectViolation(() => reduceRecoveryEvent(ended, decision(10, "attempt-1", retryProvider)), "sequence");
  expectViolation(() => reduceRecoveryEvent(ended, decision(9, "attempt-1", retryProvider)), "sequence");
  assert.equal(reduceRecoveryEvent(ended, decision(20, "attempt-1", retryProvider)).lastSequence, 20);
});

test("allows exactly one decision for each ended attempt", () => {
  const firstEnded = reduceRecoveryEvent(createRecoveryProtocolState(recoveryId), attemptEnded(0, "attempt-1"));
  expectViolation(() => reduceRecoveryEvent(firstEnded, attemptEnded(1, "attempt-2")), "missing-decision");

  const allowedFallback = structuredClone(fallbackModel);
  allowedFallback.replayFence = { completedTools: [], blocked: false };
  const decided = reduceRecoveryEvent(firstEnded, decision(1, "attempt-1", allowedFallback));
  expectViolation(() => reduceRecoveryEvent(decided, decision(2, "attempt-1", settleSuccess)), "duplicate-decision");
  expectViolation(() => reduceRecoveryEvent(decided, settled(2, "attempt-1")), "settling");
});

test("blocked replay fences cannot authorize fallback restarts", () => {
  const ended = reduceRecoveryEvent(createRecoveryProtocolState(recoveryId), attemptEnded(0, "attempt-1"));
  const blockedRestart = structuredClone(fallbackModel);
  blockedRestart.mode = "restart";
  expectViolation(() => reduceRecoveryEvent(ended, decision(1, "attempt-1", blockedRestart)), "replay-fence");

  assert.equal(reduceRecoveryEvent(ended, decision(1, "attempt-1", fallbackModel)).phase, "active");
});

test("force_restart explicitly authorizes a blocked replay fence", () => {
  const ended = reduceRecoveryEvent(createRecoveryProtocolState(recoveryId), attemptEnded(0, "attempt-1"));
  const forcedRestart = structuredClone(fallbackModel);
  forcedRestart.mode = "force_restart";

  const decided = reduceRecoveryEvent(ended, decision(1, "attempt-1", forcedRestart));
  assert.equal(decided.phase, "active");
  assert.equal(decided.attempts[0]?.decision?.intent.kind, "fallback_model");
  assert.equal(decided.attempts[0]?.decision?.intent.mode, "force_restart");
  assert.equal(decided.attempts[0]?.decision?.intent.replayFence.blocked, true);
});

test("settlement must match the settle intent outcome and reason", () => {
  const ended = reduceRecoveryEvent(createRecoveryProtocolState(recoveryId), attemptEnded(0, "attempt-1"));
  const settleFailure: RecoveryIntent = {
    intentId: "settle-failure",
    kind: "settle",
    outcome: "failure",
    reason: "provider exhausted",
  };
  const settling = reduceRecoveryEvent(ended, decision(1, "attempt-1", settleFailure));

  expectViolation(() => reduceRecoveryEvent(settling, settled(2, "attempt-1", "success")), "settle-outcome");
  const terminal = reduceRecoveryEvent(settling, settled(2, "attempt-1", "failure", "provider exhausted"));
  assert.equal(terminal.settled?.reason, "provider exhausted");
});

test("terminal state absorbs only later events from the same recovery stream", () => {
  let state = createRecoveryProtocolState(recoveryId);
  state = reduceRecoveryEvent(state, attemptEnded(0, "attempt-1", "success"));
  state = reduceRecoveryEvent(state, decision(1, "attempt-1", settleSuccess));
  const terminal = reduceRecoveryEvent(state, settled(2, "attempt-1"));
  const lateEvent = attemptEnded(1, "attempt-2");

  assert.deepEqual(validateRecoveryEvent(terminal, lateEvent), { valid: true, absorbed: true });
  assert.equal(reduceRecoveryEvent(terminal, lateEvent), terminal);

  const misrouted = { ...lateEvent, recoveryId: "other" };
  assert.deepEqual(validateRecoveryEvent(terminal, misrouted), {
    valid: false,
    violation: { code: "recovery-id", message: "Recovery event belongs to other, expected recovery-1" },
  });

  const misowned = { ...lateEvent, owner: "teammate" as const };
  assert.deepEqual(validateRecoveryEvent(terminal, misowned), {
    valid: false,
    violation: { code: "ownership", message: "Recovery scope main requires owner pi-core" },
  });
});

test("validates stream identity, protocol version, and intent identity", () => {
  const initial = createRecoveryProtocolState(recoveryId);
  const wrongRecovery = { ...attemptEnded(0, "attempt-1"), recoveryId: "other" };
  const wrongVersion = { ...attemptEnded(0, "attempt-1"), protocolVersion: 2 } as unknown as RecoveryProtocolEvent;

  assert.deepEqual(validateRecoveryEvent(initial, wrongRecovery), {
    valid: false,
    violation: { code: "recovery-id", message: "Recovery event belongs to other, expected recovery-1" },
  });
  assert.equal(validateRecoveryEvent(initial, wrongVersion).valid, false);

  const ended = reduceRecoveryEvent(initial, attemptEnded(0, "attempt-1"));
  const emptyIntent = structuredClone(retryProvider);
  emptyIntent.intentId = "";
  expectViolation(() => reduceRecoveryEvent(ended, decision(1, "attempt-1", emptyIntent)), "intent-id");
});
