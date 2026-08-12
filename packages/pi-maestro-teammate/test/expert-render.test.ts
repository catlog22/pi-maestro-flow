import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { afterEach } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { visibleWidth } from "@earendil-works/pi-tui";
import { setQuietMode } from "../src/quiet-state.ts";
import type { Details, SingleResult } from "../src/shared/types.ts";
import { renderTeammateCall, renderTeammateResult } from "../src/tui/render.ts";

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
const expertArgs = {
  mode: "expert",
  tasks: [{ prompt: "Audit the authentication boundary", todo: "#42" }],
};

afterEach(() => setQuietMode(false, "check"));

function workflowResult(exitCode = 0): SingleResult {
  return {
    agent: "workflow",
    name: "expert-leader",
    task: "coordinate",
    exitCode,
    messages: [{ role: "assistant", content: exitCode === 0 ? "Evidence-based synthesis" : "Unresolved blocker" }],
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
    model: "test-model",
    correlationId: "leader-correlation",
    durationMs: 1000,
  };
}

test("expert call renders a dedicated width-safe Component with a sanitized objective", () => {
  const args = {
    mode: "expert",
    tasks: [{ prompt: "Audit\nauth\u001b[2J\tboundary", todo: "SECRET_TODO" }],
  };
  const component = renderTeammateCall(args, theme as never, { isPartial: true });
  assert.equal(typeof component.render, "function");
  assert.equal(typeof component.invalidate, "function");

  const lines = component.render(80);
  assert.match(lines[0] ?? "", /◆ EXPERT/);
  assert.doesNotMatch(lines[0] ?? "", /workflow Leader/);
  assert.match(lines[1] ?? "", /objective Audit auth \[2J boundary/);
  assert.doesNotMatch(lines.join(""), /[\n\r\u001b]/);
  assert.doesNotMatch(lines.join(" "), /SECRET_TODO/);

  for (const width of [1, 8, 20, 40, 80]) {
    for (const line of component.render(width)) {
      assert.ok(visibleWidth(line) <= width, `line must fit width ${width}: ${JSON.stringify(line)}`);
    }
  }
});

test("quiet expert call keeps the strategy label but hides objective and Todo content", () => {
  setQuietMode(true, "check");
  const lines = renderTeammateCall(expertArgs, theme as never, { isPartial: true }).render(100);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /◆ EXPERT/);
  assert.doesNotMatch(lines[0] ?? "", /workflow Leader/);
  assert.doesNotMatch(lines.join(" "), /authentication|#42|objective/);
});

test("expert streaming result frames the existing Leader and delegated-agent tree", () => {
  const result: AgentToolResult<Details> = {
    content: [{ type: "text", text: "working" }],
    details: {
      mode: "single",
      results: [],
      progress: [{
        agent: "workflow",
        name: "expert-leader",
        correlationId: "leader-correlation",
        taskIndex: 0,
        dependencies: [],
        status: "running",
        recentTools: [{ name: "teammate", status: "running" }],
        lastMessage: "Coordinating evidence",
      }],
      childCalls: [{
        agent: "reviewer",
        name: "review",
        correlationId: "review-correlation",
        parentCorrelationId: "leader-correlation",
        parentName: "expert-leader",
        status: "running",
      }],
    },
  };
  const component = renderTeammateResult(result, { expanded: true }, theme as never, expertArgs);
  assert.equal(typeof component.render, "function");
  const lines = component.render(120);
  assert.match(lines[0] ?? "", /■ Leader coordinating.*1 delegated/);
  assert.doesNotMatch(lines[0] ?? "", /EXPERT|workflow Leader/);
  assert.match(lines.join("\n"), /@expert-leader/);
  assert.match(lines.join("\n"), /@review/);
  assert.doesNotMatch(lines.join("\n"), /#42/);
});

test("expert in-flight rows stay stable while live telemetry changes", () => {
  const now = Date.now();
  const result: AgentToolResult<Details> = {
    content: [{ type: "text", text: "working" }],
    details: {
      mode: "single",
      results: [],
      progress: [{
        agent: "workflow",
        name: "expert-leader",
        correlationId: "leader-correlation",
        taskIndex: 0,
        dependencies: [],
        status: "running",
        startedAt: new Date(now - 65_000).toISOString(),
        lastActivityAt: now,
        durationMs: 60_000,
        inputTokens: 100,
        outputTokens: 20,
        toolCount: 1,
      }],
      childCalls: [{
        agent: "reviewer",
        name: "review",
        correlationId: "review-correlation",
        parentCorrelationId: "leader-correlation",
        status: "running",
        startedAt: now - 65_000,
        lastActivityAt: now,
        durationMs: 60_000,
        inputTokens: 50,
        outputTokens: 10,
      }],
    },
  };
  const component = renderTeammateResult(result, { expanded: false }, theme as never, expertArgs);
  const first = component.render(120);
  const firstLeader = first.find((line) => line.includes("@expert-leader"));
  const firstChild = first.find((line) => line.includes("@review"));
  assert.ok(firstLeader);
  assert.ok(firstChild);
  assert.doesNotMatch(firstLeader, /1m|in 100|out 20|tool/);
  assert.doesNotMatch(firstChild, /1m|in 50|out 10|stalled/);
  assert.match(first.join("\n"), /1m5s.*in 100.*out 20/);

  result.details = {
    ...result.details!,
    progress: result.details!.progress!.map((entry) => ({
      ...entry,
      durationMs: 64_000,
      inputTokens: 140,
      outputTokens: 30,
      toolCount: 2,
    })),
    childCalls: result.details!.childCalls!.map((child) => ({
      ...child,
      durationMs: 64_000,
      inputTokens: 70,
      outputTokens: 15,
    })),
  };
  component.invalidate();
  const second = component.render(120);
  assert.equal(second.find((line) => line.includes("@expert-leader")), firstLeader);
  assert.equal(second.find((line) => line.includes("@review")), firstChild);
});

test("expert completed and failed results expose accurate terminal headers", () => {
  const completed = renderTeammateResult({
    content: [{ type: "text", text: "done" }],
    details: { mode: "single", results: [workflowResult()] },
  }, { expanded: false }, theme as never, expertArgs).render(100);
  assert.match(completed[0] ?? "", /✓ Leader synthesized/);
  assert.match(completed.join("\n"), /workflow/);

  const failed = renderTeammateResult({
    content: [{ type: "text", text: "failed" }],
    isError: true,
    details: { mode: "single", results: [workflowResult(1)] },
  } as AgentToolResult<Details>, { expanded: false }, theme as never, expertArgs).render(100);
  assert.match(failed[0] ?? "", /✗ Leader completed with issues/);
});

test("ordinary teammate rendering remains unframed", () => {
  assert.deepEqual(
    renderTeammateCall({ tasks: [{ prompt: "inspect" }] }, theme as never).render(80),
    [],
  );
  const lines = renderTeammateResult({
    content: [{ type: "text", text: "done" }],
    details: { mode: "single", results: [workflowResult()] },
  }, { expanded: false }, theme as never).render(100);
  assert.doesNotMatch(lines.join("\n"), /EXPERT/);
});

test("root and proxy result renderers pass original args to the expert renderer", () => {
  const source = fs.readFileSync(path.resolve("src/extension/index.ts"), "utf8");
  assert.equal(
    source.match(/renderTeammateResult\(result, options, theme, context\?\.args\)/g)?.length,
    2,
  );
});
