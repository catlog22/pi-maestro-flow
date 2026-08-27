import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_TURN_EVENT_CUSTOM_TYPE,
  AGENT_TURN_VERSION,
  MESSAGE_PROVENANCE_VERSION,
  agentTurnLedgerAgent,
  applyAgentTurnEvent,
  createAgentTurnLedger,
  foldAgentTurnEvents,
  rebuildAgentTurnLedger,
  validateAgentTurnEvent,
  type AgentTurnMessageMetadataV1,
  type MessageProvenanceV1,
} from "../src/public/v1/types.ts";

function trigger(messageId = "trigger-1"): MessageProvenanceV1 {
  return {
    version: MESSAGE_PROVENANCE_VERSION,
    messageId,
    source: "initial-task",
    messageKind: "task",
    deliveryMode: "prompt",
    confidence: "verified",
    sender: { kind: "human", ownerId: "owner-root" },
  };
}

function assistantMessage(timestamp: number, messageId = `result-${timestamp}`): AgentTurnMessageMetadataV1 {
  return {
    role: "assistant",
    timestamp,
    provenance: {
      version: MESSAGE_PROVENANCE_VERSION,
      messageId,
      source: "completion-outbox",
      messageKind: "result",
      deliveryMode: "notify",
      confidence: "verified",
      sender: { kind: "system", ownerId: "owner-runtime" },
    },
  };
}

interface EventBaseOverrides {
  turnId?: string;
  correlationId?: string;
  runtimeGeneration?: number;
  promptSeq?: number;
  loopSeq?: number;
  trigger?: MessageProvenanceV1;
}

function eventBase(timestamp: number, overrides: EventBaseOverrides = {}) {
  return {
    version: AGENT_TURN_VERSION,
    turnId: overrides.turnId ?? "turn-1",
    correlationId: overrides.correlationId ?? "agent-1",
    runtimeGeneration: overrides.runtimeGeneration ?? 1,
    promptSeq: overrides.promptSeq ?? 1,
    loopSeq: overrides.loopSeq ?? 1,
    trigger: overrides.trigger ?? trigger(),
    timestamp,
  } as const;
}

test("folds a happy trigger, start, and progress lifecycle into one immutable current snapshot", () => {
  const lastMessage = assistantMessage(104, "progress-message");
  const folded = foldAgentTurnEvents([
    { ...eventBase(100), type: "trigger-enqueued" },
    { ...eventBase(101), type: "trigger-accepted" },
    { ...eventBase(102), type: "turn-started", phase: "prompting" },
    {
      ...eventBase(104),
      type: "progress",
      phase: "tool-execution",
      toolActivity: "active",
      lastMessage,
    },
  ]);

  assert.equal(folded.applied, 4);
  assert.equal(folded.rejected, 0);
  const agent = agentTurnLedgerAgent(folded.ledger, "agent-1");
  assert.ok(agent);
  assert.equal(agent.last, undefined);
  assert.deepEqual(agent.current, {
    version: AGENT_TURN_VERSION,
    turnId: "turn-1",
    correlationId: "agent-1",
    runtimeGeneration: 1,
    promptSeq: 1,
    loopSeq: 1,
    trigger: trigger(),
    startedAt: 102,
    lastActivityAt: 104,
    phase: "tool-execution",
    toolActivity: "active",
    lastMessage,
    state: "active",
  });
  assert.equal(Object.isFrozen(folded.ledger), true);
  assert.equal(Object.isFrozen(agent.current), true);
  assert.equal(Object.isFrozen(agent.current.trigger), true);
});

test("preserves resultReadyAt through result-ready, settling, and settled states", () => {
  const lastMessage = assistantMessage(204);
  let ledger = foldAgentTurnEvents([
    { ...eventBase(200), type: "turn-started", phase: "prompting" },
  ]).ledger;

  const ready = applyAgentTurnEvent(ledger, {
    ...eventBase(204),
    type: "result-ready",
    lastMessage,
  });
  assert.equal(ready.status, "applied");
  ledger = ready.ledger;
  assert.equal(ready.agent.current.state, "result-ready");
  assert.equal(ready.agent.current.resultReadyAt, 204);

  const settling = applyAgentTurnEvent(ledger, {
    ...eventBase(205),
    type: "turn-ended",
    lastMessage,
  });
  assert.equal(settling.status, "applied");
  ledger = settling.ledger;
  assert.equal(settling.agent.current.state, "settling");
  assert.equal(settling.agent.current.resultReadyAt, 204);

  const settled = applyAgentTurnEvent(ledger, {
    ...eventBase(206),
    type: "turn-settled",
    outcome: "completed",
    lastMessage,
  });
  assert.equal(settled.status, "applied");
  ledger = settled.ledger;
  assert.equal(settled.agent.current.state, "settled");
  assert.equal(settled.agent.current.resultReadyAt, 204);
  assert.equal(settled.agent.current.settledAt, 206);

  const lateProgress = applyAgentTurnEvent(ledger, {
    ...eventBase(207),
    type: "progress",
    phase: "continuing",
  });
  assert.equal(lateProgress.status, "ignored");
  assert.equal(lateProgress.diagnostic.code, "terminal-absorbed");
  assert.equal(lateProgress.ledger, ledger);
  assert.equal(agentTurnLedgerAgent(ledger, "agent-1")?.current.state, "settled");
});

test("folds failed and terminated outcomes without erasing prior result readiness", () => {
  const failedMessage = assistantMessage(304, "failed-result");
  const folded = foldAgentTurnEvents([
    { ...eventBase(300, { turnId: "turn-failed", correlationId: "agent-failed" }), type: "turn-started" },
    {
      ...eventBase(304, { turnId: "turn-failed", correlationId: "agent-failed" }),
      type: "result-ready",
      lastMessage: failedMessage,
    },
    {
      ...eventBase(305, { turnId: "turn-failed", correlationId: "agent-failed" }),
      type: "failed",
      outcome: "failed",
      error: "provider failed",
      lastMessage: failedMessage,
    },
    { ...eventBase(310, { turnId: "turn-terminated", correlationId: "agent-terminated" }), type: "turn-started" },
    {
      ...eventBase(311, { turnId: "turn-terminated", correlationId: "agent-terminated" }),
      type: "terminated",
      outcome: "terminated",
      reason: "caller abort",
    },
  ]);

  const failed = agentTurnLedgerAgent(folded.ledger, "agent-failed")?.current;
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.resultReadyAt, 304);
  assert.equal(failed?.outcome, "failed");
  assert.equal(failed && "error" in failed ? failed.error : undefined, "provider failed");

  const terminated = agentTurnLedgerAgent(folded.ledger, "agent-terminated")?.current;
  assert.equal(terminated?.state, "terminated");
  assert.equal(terminated?.outcome, "terminated");
  assert.equal(terminated && "reason" in terminated ? terminated.reason : undefined, "caller abort");
});

test("fences older generations and rejects turn ownership reuse", () => {
  let ledger = foldAgentTurnEvents([
    { ...eventBase(400, { turnId: "turn-generation-1" }), type: "turn-started" },
    {
      ...eventBase(500, { turnId: "turn-generation-2", runtimeGeneration: 2 }),
      type: "turn-started",
      phase: "restoring",
    },
  ]).ledger;
  const beforeLateEvent = ledger;
  const lateGeneration = applyAgentTurnEvent(ledger, {
    ...eventBase(600, { turnId: "turn-generation-1" }),
    type: "progress",
    phase: "tool-execution",
  });
  assert.equal(lateGeneration.status, "ignored");
  assert.equal(lateGeneration.diagnostic.code, "stale-generation");
  assert.equal(lateGeneration.ledger, beforeLateEvent);

  const agent = agentTurnLedgerAgent(ledger, "agent-1");
  assert.equal(agent?.current.turnId, "turn-generation-2");
  assert.equal(agent?.current.runtimeGeneration, 2);
  assert.equal(agent?.last?.turnId, "turn-generation-1");

  const reusedTurnId = applyAgentTurnEvent(ledger, {
    ...eventBase(601, {
      turnId: "turn-generation-2",
      correlationId: "agent-other",
      runtimeGeneration: 1,
    }),
    type: "turn-started",
  });
  assert.equal(reusedTurnId.status, "rejected");
  assert.equal(reusedTurnId.diagnostic.code, "turn-ownership");
  assert.equal(reusedTurnId.ledger, ledger);

  const regressiveReplacementTime = applyAgentTurnEvent(ledger, {
    ...eventBase(499, { turnId: "turn-generation-3", runtimeGeneration: 3 }),
    type: "turn-started",
  });
  assert.equal(regressiveReplacementTime.status, "ignored");
  assert.equal(regressiveReplacementTime.diagnostic.code, "stale-timestamp");
  assert.equal(regressiveReplacementTime.ledger, ledger);
});

test("ignores regressive prompt, loop, event, and message timestamps", () => {
  const promptTwo = eventBase(700, { turnId: "turn-prompt-2", promptSeq: 2 });
  let ledger = foldAgentTurnEvents([
    { ...promptTwo, type: "turn-started" },
    { ...eventBase(710, { turnId: "turn-prompt-2", promptSeq: 2, loopSeq: 2 }), type: "turn-started" },
    {
      ...eventBase(720, { turnId: "turn-prompt-2", promptSeq: 2, loopSeq: 2 }),
      type: "progress",
      lastMessage: assistantMessage(720, "new-message"),
    },
  ]).ledger;

  const stalePrompt = applyAgentTurnEvent(ledger, {
    ...eventBase(730, { turnId: "turn-prompt-1", promptSeq: 1 }),
    type: "progress",
  });
  assert.equal(stalePrompt.status, "ignored");
  assert.equal(stalePrompt.diagnostic.code, "stale-sequence");

  const staleLoop = applyAgentTurnEvent(ledger, {
    ...eventBase(730, { turnId: "turn-prompt-2", promptSeq: 2, loopSeq: 1 }),
    type: "progress",
  });
  assert.equal(staleLoop.status, "ignored");
  assert.equal(staleLoop.diagnostic.code, "stale-sequence");

  const staleEventTime = applyAgentTurnEvent(ledger, {
    ...eventBase(719, { turnId: "turn-prompt-2", promptSeq: 2, loopSeq: 2 }),
    type: "progress",
    phase: "continuing",
  });
  assert.equal(staleEventTime.status, "ignored");
  assert.equal(staleEventTime.diagnostic.code, "stale-timestamp");

  const staleMessageTime = applyAgentTurnEvent(ledger, {
    ...eventBase(721, { turnId: "turn-prompt-2", promptSeq: 2, loopSeq: 2 }),
    type: "progress",
    phase: "continuing",
    lastMessage: assistantMessage(719, "old-message"),
  });
  assert.equal(staleMessageTime.status, "ignored");
  assert.equal(staleMessageTime.diagnostic.code, "stale-timestamp");
  assert.equal(staleMessageTime.ledger, ledger);
});

test("absorbs identical duplicates and rejects conflicting lifecycle-slot duplicates", () => {
  const started = { ...eventBase(800), type: "turn-started", phase: "prompting" } as const;
  const first = applyAgentTurnEvent(createAgentTurnLedger(), started);
  assert.equal(first.status, "applied");

  const duplicate = applyAgentTurnEvent(first.ledger, structuredClone(started));
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.diagnostic.code, "duplicate-event");
  assert.equal(duplicate.ledger, first.ledger);

  const conflict = applyAgentTurnEvent(first.ledger, {
    ...started,
    timestamp: 801,
    phase: "tool-execution",
  });
  assert.equal(conflict.status, "rejected");
  assert.equal(conflict.diagnostic.code, "conflicting-duplicate");
  assert.equal(conflict.ledger, first.ledger);

  const progress = applyAgentTurnEvent(first.ledger, {
    ...eventBase(802),
    type: "progress",
    phase: "continuing",
  });
  assert.equal(progress.status, "applied");
  const progressConflict = applyAgentTurnEvent(progress.ledger, {
    ...eventBase(802),
    type: "progress",
    phase: "tool-execution",
  });
  assert.equal(progressConflict.status, "rejected");
  assert.equal(progressConflict.diagnostic.code, "conflicting-duplicate");
  assert.equal(progressConflict.ledger, progress.ledger);
});

test("advances a retry loop on the same conversation turn without rotating turn history", () => {
  const sharedTrigger = trigger("retry-trigger");
  let ledger = foldAgentTurnEvents([
    {
      ...eventBase(900, { turnId: "turn-retry", trigger: sharedTrigger }),
      type: "turn-started",
      phase: "prompting",
    },
    {
      ...eventBase(901, { turnId: "turn-retry", trigger: sharedTrigger }),
      type: "agent-ended",
    },
  ]).ledger;
  assert.equal(agentTurnLedgerAgent(ledger, "agent-1")?.current.state, "settling");

  const retryStart = applyAgentTurnEvent(ledger, {
    ...eventBase(902, { turnId: "turn-retry", loopSeq: 2, trigger: sharedTrigger }),
    type: "turn-started",
    phase: "retrying",
  });
  assert.equal(retryStart.status, "applied");
  ledger = retryStart.ledger;
  assert.equal(retryStart.agent.current.state, "active");
  assert.equal(retryStart.agent.current.loopSeq, 2);
  assert.equal(retryStart.agent.current.startedAt, 900);
  assert.equal(retryStart.agent.last, undefined);

  const progressMessage = assistantMessage(903, "retry-progress");
  const progress = applyAgentTurnEvent(ledger, {
    ...eventBase(903, { turnId: "turn-retry", loopSeq: 2, trigger: sharedTrigger }),
    type: "progress",
    phase: "tool-execution",
    toolActivity: "active",
    lastMessage: progressMessage,
  });
  assert.equal(progress.status, "applied");
  assert.equal(progress.agent.current.phase, "tool-execution");
  assert.equal(progress.agent.current.toolActivity, "active");
  assert.deepEqual(progress.agent.current.lastMessage, progressMessage);
  assert.deepEqual(progress.agent.current.trigger, sharedTrigger);

  const changedTrigger = applyAgentTurnEvent(progress.ledger, {
    ...eventBase(904, {
      turnId: "turn-retry",
      loopSeq: 2,
      trigger: trigger("different-trigger"),
    }),
    type: "progress",
    phase: "continuing",
  });
  assert.equal(changedTrigger.status, "rejected");
  assert.equal(changedTrigger.diagnostic.code, "trigger-ownership");
  assert.equal(changedTrigger.ledger, progress.ledger);
});

test("cold rebuild skips unrelated entries and diagnoses malformed legacy turn events", () => {
  const valid = { ...eventBase(1_000, { turnId: "turn-cold" }), type: "turn-started" } as const;
  const legacy = {
    type: "turn-started",
    turnId: "legacy-turn",
    correlationId: "legacy-agent",
    timestamp: 999,
  };
  const malformedTrigger = {
    ...eventBase(1_001, { turnId: "turn-malformed", correlationId: "agent-malformed" }),
    type: "turn-started",
    trigger: { source: "legacy", from: "old-agent" },
  };
  const rebuilt = rebuildAgentTurnLedger([
    { type: "custom", customType: "unrelated", data: valid },
    { type: "custom", customType: AGENT_TURN_EVENT_CUSTOM_TYPE, data: legacy },
    { type: "custom", customType: AGENT_TURN_EVENT_CUSTOM_TYPE, data: valid },
    { type: "custom", customType: AGENT_TURN_EVENT_CUSTOM_TYPE, data: structuredClone(valid) },
    { type: "custom", customType: AGENT_TURN_EVENT_CUSTOM_TYPE, data: malformedTrigger },
    { type: "custom", customType: AGENT_TURN_EVENT_CUSTOM_TYPE },
  ]);

  assert.equal(rebuilt.applied, 1);
  assert.equal(rebuilt.duplicates, 1);
  assert.equal(rebuilt.ignored, 0);
  assert.equal(rebuilt.rejected, 3);
  assert.deepEqual(rebuilt.diagnostics.map((entry) => [entry.code, entry.eventIndex]), [
    ["unsupported-version", 1],
    ["duplicate-event", 3],
    ["malformed-event", 4],
    ["malformed-event", 5],
  ]);
  assert.equal(agentTurnLedgerAgent(rebuilt.ledger, "agent-1")?.current.turnId, "turn-cold");
  assert.equal(agentTurnLedgerAgent(rebuilt.ledger, "legacy-agent"), undefined);
  assert.equal(validateAgentTurnEvent(legacy).valid, false);
});

test("cold rebuild folds large progress histories without quadratic map copying", { timeout: 3_000 }, () => {
  const entries: unknown[] = [{
    type: "custom",
    customType: AGENT_TURN_EVENT_CUSTOM_TYPE,
    data: { ...eventBase(2_000, { turnId: "turn-large" }), type: "turn-started", phase: "prompting" },
  }];
  for (let index = 1; index <= 5_000; index += 1) {
    entries.push({
      type: "custom",
      customType: AGENT_TURN_EVENT_CUSTOM_TYPE,
      data: {
        ...eventBase(2_000 + index, { turnId: "turn-large" }),
        type: "progress",
        phase: "prompting",
        toolActivity: "idle",
      },
    });
  }

  const rebuilt = rebuildAgentTurnLedger(entries);

  assert.equal(rebuilt.applied, 5_001);
  assert.equal(rebuilt.rejected, 0);
  assert.equal(rebuilt.ignored, 0);
  assert.equal(agentTurnLedgerAgent(rebuilt.ledger, "agent-1")?.current.lastActivityAt, 7_000);
  assert.equal(Object.isFrozen(rebuilt.ledger), true);
});
