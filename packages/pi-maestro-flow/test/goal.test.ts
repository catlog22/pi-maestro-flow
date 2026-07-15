import assert from "node:assert/strict";
import test from "node:test";
import {
  collectVerifierEvidence,
  executeGoal,
  initGoal,
  onAgentEnd,
  onBeforeAgentStart,
  parseVerifierOutput,
  onSessionShutdown,
  onSessionStart,
  type GoalContext,
} from "../src/tools/goal.ts";

function createContext(overrides: Partial<GoalContext> = {}): GoalContext {
  return {
    cwd: "D:/workspace",
    ui: {
      notify() {},
      setStatus() {},
    },
    ...overrides,
  };
}

test("verifier parsing is fail-closed and requires consistent concrete evidence", () => {
  assert.equal(parseVerifierOutput("The goal is incomplete and does not pass verification.").pass, false);

  const contradictory = parseVerifierOutput(JSON.stringify({
    pass: true,
    reasoning: "Looks complete",
    unmet: ["Missing runtime verification"],
    evidence: ["npm test passed"],
  }));
  assert.equal(contradictory.pass, false);
  assert.match(contradictory.reasoning, /contradictory/);

  const grounded = parseVerifierOutput(JSON.stringify({
    pass: true,
    reasoning: "All requested paths are covered",
    unmet: [],
    evidence: ["npm run test:goal: 3 tests passed"],
  }));
  assert.equal(grounded.pass, true);
});

test("verifier receives bounded raw tool evidence produced after the goal started", () => {
  const since = Date.parse("2026-07-15T00:00:00.000Z");
  const ctx = createContext({
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          timestamp: "2026-07-14T23:59:59.000Z",
          message: { role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "stale output" }] },
        },
        {
          type: "message",
          timestamp: "2026-07-15T00:00:01.000Z",
          message: { role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "3 tests passed" }] },
        },
        {
          type: "message",
          timestamp: "2026-07-15T00:00:02.000Z",
          message: { role: "toolResult", toolName: "goal", isError: true, content: [{ type: "text", text: "verifier feedback" }] },
        },
      ],
    },
  });

  const evidence = collectVerifierEvidence(ctx, since);
  assert.doesNotMatch(evidence, /stale output/);
  assert.match(evidence, /\[OK\] bash\n3 tests passed/);
  assert.match(evidence, /\[ERROR\] goal\nverifier feedback/);
});

test("goal set inside an active tool turn does not queue a stale follow-up", async () => {
  const sent: Array<{ message: string; options?: { deliverAs?: string } }> = [];
  initGoal({
    appendEntry() {},
    async sendUserMessage(message: string, options?: { deliverAs?: string }) {
      sent.push({ message, options });
    },
  } as never);
  const ctx = createContext({
    isIdle: () => false,
    hasPendingMessages: () => false,
  });

  try {
    const result = await executeGoal({ action: "set", objective: "Verify the Goal lifecycle" }, ctx);
    assert.equal(result.isError, false);
    assert.deepEqual(sent, []);

    await executeGoal({ action: "set", objective: "Verify the updated Goal lifecycle" }, ctx);
    await executeGoal({ action: "pause" }, ctx);
    await executeGoal({ action: "pause" }, ctx);
    assert.deepEqual(sent, []);

    await onAgentEnd({ messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, ctx);
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.message ?? "", /^Continue the active goal:/);
    assert.equal(sent[0]?.options?.deliverAs, "followUp");
  } finally {
    await executeGoal({ action: "clear" }, ctx);
    onSessionShutdown(ctx);
  }
});

test("goal set from an idle command still starts the goal immediately", async () => {
  const sent: Array<{ message: string; options?: { deliverAs?: string } }> = [];
  initGoal({
    appendEntry() {},
    async sendUserMessage(message: string, options?: { deliverAs?: string }) {
      sent.push({ message, options });
    },
  } as never);
  const ctx = createContext({ isIdle: () => true });

  try {
    await executeGoal({ action: "set", objective: "Verify the idle command path" }, ctx);
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.message ?? "", /^Goal mode is active\./);
    assert.equal(sent[0]?.options, undefined);
  } finally {
    await executeGoal({ action: "clear" }, ctx);
    onSessionShutdown(ctx);
  }
});

test("active Goal does not rewrite the per-turn system prompt", () => {
  initGoal({ appendEntry() {} } as never);
  const ctx = {
    cwd: "D:/workspace",
    ui: {
      notify() {},
      setStatus() {},
    },
    sessionManager: {
      getEntries: () => [{
        type: "custom",
        customType: "goal-state",
        data: {
          goal: {
            id: "goal-1",
            text: "Finish the implementation",
            status: "active",
            startedAt: 1,
            updatedAt: 2,
            iteration: 3,
            tokenBudget: 100_000,
            tokensUsed: 42_000,
            timeUsedSeconds: 60,
            baselineTokens: 0,
          },
        },
      }],
    },
  } as unknown as GoalContext;

  onSessionStart(ctx);
  try {
    assert.equal(onBeforeAgentStart({ prompt: "continue" }), undefined);
  } finally {
    onSessionShutdown(ctx);
  }
});
