import assert from "node:assert/strict";
import test from "node:test";
import { buildProgressTree, selectPriorityProgressRows } from "../src/tui/progress-tree.ts";
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

test("progress tree renders one row per task index when snapshots repeat", () => {
  const palette = {
    dim: (text: string) => text,
    accent: (text: string) => text,
    running: (text: string) => text,
    success: (text: string) => text,
    error: (text: string) => text,
    bold: (text: string) => text,
  };
  const rows = buildProgressTree([
    {
      agent: "delegate",
      correlationId: "first-correlation",
      taskIndex: 0,
      dependencies: [],
      status: "running",
      startedAt: new Date().toISOString(),
      toolCount: 0,
      tokens: 0,
    },
    {
      agent: "delegate",
      correlationId: "second-correlation",
      taskIndex: 0,
      dependencies: [],
      status: "completed",
      startedAt: new Date().toISOString(),
      toolCount: 1,
      tokens: 10,
    },
  ], palette);

  assert.equal(rows.length, 1);
  assert.match(rows[0]?.text ?? "", /✓ completed delegate/);
  assert.match(rows[0]?.text ?? "", /second-c/);
});

test("progress tree shows dependencies as result flow rather than agent hierarchy", () => {
  const palette = {
    dim: (text: string) => text,
    accent: (text: string) => text,
    running: (text: string) => text,
    success: (text: string) => text,
    error: (text: string) => text,
    bold: (text: string) => text,
  };
  const rows = buildProgressTree([
    { agent: "researcher", name: "research", correlationId: "research", taskIndex: 0, dependencies: [], status: "completed" },
    { agent: "writer", name: "write", correlationId: "write", taskIndex: 1, dependencies: [0], status: "pending" },
  ], palette);

  assert.match(rows[0]?.text ?? "", /^• 1/);
  assert.match(rows[1]?.text ?? "", /^→ 2/);
  assert.match(rows[1]?.text ?? "", /result #1/);
  assert.doesNotMatch(rows[1]?.text ?? "", /[├└│]/);
});

test("streaming progress shows live duration and split token usage", () => {
  const now = Date.now();
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "working" }],
    details: {
      mode: "single",
      results: [],
      progress: [{
        agent: "delegate",
        name: "metrics",
        correlationId: "metrics-agent",
        taskIndex: 0,
        dependencies: [],
        status: "running",
        startedAt: new Date(now - 65_000).toISOString(),
        lastActivityAt: now - 45_000,
        durationMs: 60_000,
        inputTokens: 1_234,
        outputTokens: 56,
        tokens: 1_290,
      }],
    },
  }, { expanded: false }, theme as never).render(120).join("\n");

  assert.match(rendered, /1m5s/);
  assert.match(rendered, /in 1\.2k/);
  assert.match(rendered, /out 56/);
  assert.match(rendered, /stalled 4[45]s/);
});

test("streaming progress shows a Pi result-ready turn instead of stalled", () => {
  const now = Date.now();
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "answer captured" }],
    details: {
      mode: "single",
      results: [],
      progress: [{
        agent: "explorer",
        name: "explorer",
        correlationId: "explorer-agent",
        taskIndex: 0,
        dependencies: [],
        status: "running",
        startedAt: new Date(now - 65_000).toISOString(),
        lastActivityAt: now - 45_000,
        resultReadyAt: now - 44_000,
      }],
    },
  }, { expanded: false }, theme as never).render(120).join("\n");

  assert.match(rendered, /result ready; confirming terminal/);
  assert.doesNotMatch(rendered, /stalled/);
});

test("streaming teammate result shows child agent lifecycle separately from task progress", () => {
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "delegating" }],
    details: {
      mode: "single",
      results: [],
      childCalls: [{
        agent: "reviewer",
        name: "review",
        correlationId: "review-child",
        parentCorrelationId: "planner-parent",
        parentName: "planner",
        status: "running",
        recentTools: [{ name: "teammate", status: "running" }],
      }],
    },
  }, { expanded: false }, theme as never).render(100).join("\n");

  assert.match(rendered, /1 child agent/);
  assert.match(rendered, /@review child agent · running · using teammate · called by @planner/);
});

test("streaming child agent shows stalled state, duration, and split tokens", () => {
  const now = Date.now();
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "delegating" }],
    details: {
      mode: "single",
      results: [],
      childCalls: [{
        agent: "reviewer",
        name: "review",
        correlationId: "review-child",
        status: "running",
        startedAt: now - 70_000,
        lastActivityAt: now - 40_000,
        durationMs: 65_000,
        inputTokens: 200,
        outputTokens: 30,
      }],
    },
  }, { expanded: false }, theme as never).render(120).join("\n");

  assert.match(rendered, /@review child agent · stalled 4[01]s · 1m1[01]s/);
  assert.match(rendered, /in 200 · out 30/);
});

test("streaming teammate result wraps long agent output instead of truncating it", () => {
  const message = "There are no previous user messages, no prior assistant turns, and no inherited parent context visible.";
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "streaming" }],
    details: {
      mode: "single",
      results: [],
      progress: [{
        agent: "delegate",
        name: "fresh",
        correlationId: "fresh-agent",
        taskIndex: 0,
        dependencies: [],
        status: "running",
        lastMessage: message,
      }],
    },
  }, { expanded: false }, theme as never).render(40).join("\n");

  assert.match(rendered, /previous user messages/);
  assert.match(rendered, /inherited parent context visible/);
  assert.doesNotMatch(rendered.split("\n").filter((line) => line.startsWith("│")).join("\n"), /…/);
});
