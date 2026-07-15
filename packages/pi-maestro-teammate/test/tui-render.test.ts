import assert from "node:assert/strict";
import test from "node:test";
import { selectPriorityProgressRows } from "../src/tui/progress-tree.ts";
import { renderTeammateResult } from "../src/tui/render.ts";
import type { SingleResult } from "../src/shared/types.ts";

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

function makeResult(): SingleResult {
  return {
    agent: "scout",
    task: "inspect output",
    exitCode: 0,
    messages: [{ role: "assistant", content: "complete output" }],
    usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
    model: "test-model",
    correlationId: "scout-correlation",
    durationMs: 1000,
  };
}

test("completed teammate results expose the expand affordance", () => {
  const result = makeResult();
  const collapsed = renderTeammateResult({
    content: [{ type: "text", text: "complete output" }],
    details: { mode: "single", results: [result] },
  }, { expanded: false }, theme as never).render(80);
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0], /Alt\+R details/);
});

test("priority progress rows keep failures and the live edge visible", () => {
  const rows = Array.from({ length: 9 }, (_, taskIndex) => ({ taskIndex, text: `task ${taskIndex}` }));
  const visible = selectPriorityProgressRows(rows, 5, 1, [7, 8]);
  assert.equal(visible.rows.length, 5);
  assert.ok(visible.rows.some((row) => row.taskIndex === 1));
  assert.ok(visible.rows.some((row) => row.taskIndex === 7));
  assert.ok(visible.rows.some((row) => row.taskIndex === 8));
  assert.equal(visible.hidden, 4);
});

test("priority progress rows reserve the live edge when failures exceed the budget", () => {
  const rows = Array.from({ length: 8 }, (_, taskIndex) => ({ taskIndex, text: `task ${taskIndex}` }));
  const visible = selectPriorityProgressRows(rows, 5, 7, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(visible.rows.length, 5);
  assert.ok(visible.rows.some((row) => row.taskIndex === 7));
  assert.ok(visible.rows.some((row) => row.taskIndex === 0));
});
