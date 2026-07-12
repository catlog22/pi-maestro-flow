import assert from "node:assert/strict";
import test from "node:test";
import {
  initGoal,
  onBeforeAgentStart,
  onSessionShutdown,
  onSessionStart,
  type GoalContext,
} from "../src/tools/goal.ts";

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
