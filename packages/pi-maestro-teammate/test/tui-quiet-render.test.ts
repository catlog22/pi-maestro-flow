import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach } from "node:test";
import { isQuietMode, setQuietMode } from "../src/quiet-state.ts";
import { auxToolCallFallback, auxToolResultFallback, renderQuietTeammateAux, renderTeammateCall, renderTeammateListCall, renderTeammateListResult, renderTeammateResult } from "../src/tui/render.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details, SingleResult } from "../src/shared/types.ts";

// Identity theme strips color so assertions read the plain text the quiet
// renderer emits (two spaces + glyph + name + rest).
const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

afterEach(() => setQuietMode(false, "check"));

function okResult(): SingleResult {
  return {
    agent: "scout",
    name: "inspection",
    task: "inspect",
    exitCode: 0,
    messages: [{ role: "assistant", content: "complete output" }],
    usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
    model: "test-model",
    correlationId: "scout-correlation",
    durationMs: 1000,
  };
}

function failedResult(): SingleResult {
  return {
    ...okResult(),
    exitCode: 1,
    messages: [{ role: "assistant", content: "boom error line\nstack trace noise" }],
  };
}

test("quiet flag mirror flips with setQuietMode", () => {
  setQuietMode(true);
  assert.equal(isQuietMode(), true);
  setQuietMode(false);
  assert.equal(isQuietMode(), false);
});

test("quiet auxiliary teammate surfaces use lifecycle rows without message bodies", () => {
  setQuietMode(true);
  const cases = [
    ["teammate-started", "@parent spawned @child", "success"],
    ["teammate-send", "@child · follow_up", "running"],
    ["teammate-wait", "completed", "success"],
    ["teammate-watch", "inspected", "success"],
    ["teammate-monitor", "status @child", "success"],
    ["observe", "all · 2/2 settled", "success"],
  ] as const;

  for (const [name, rest, status] of cases) {
    const rendered = renderQuietTeammateAux(name, rest, status, theme as never)?.render(100);
    assert.equal(rendered?.length, 1);
    assert.match(rendered?.[0] ?? "", new RegExp(name));
    assert.ok((rendered?.[0] ?? "").includes(rest));
  }

  setQuietMode(false);
  assert.equal(renderQuietTeammateAux("teammate-send", "SECRET_MESSAGE", "running", theme as never), undefined);
});

test("auxiliary tool fallbacks are total Components mirroring host default rendering", () => {
  const call = auxToolCallFallback("teammate-send", theme as never);
  assert.equal(typeof call.render, "function");
  assert.deepEqual(call.render(80).map((line) => line.trimEnd()), ["teammate-send"]);

  const result = auxToolResultFallback({
    content: [{ type: "text", text: "Message delivered." }, { type: "text", text: "Second line." }],
  } as never, theme as never);
  assert.deepEqual(result.render(80).map((line) => line.trimEnd()), ["Message delivered.", "Second line."]);

  const empty = auxToolResultFallback({ content: [] } as never, theme as never);
  assert.equal(typeof empty.render, "function");
  assert.deepEqual(empty.render(80), []);
});

test("quiet single-task call leaves all rendering to the result component", () => {
  setQuietMode(true);
  const rendered = renderTeammateCall({ agent: "general", name: "ping", prompt: "reply pong" }, theme as never, { expanded: true }).render(80);
  assert.deepEqual(rendered, []);
});

test("quiet multi-task call leaves all rendering to the result component", () => {
  setQuietMode(true);
  const rendered = renderTeammateCall({
    tasks: [
      { agent: "explorer", name: "pkgs", prompt: "inspect packages" },
      { agent: "general", name: "summary", prompt: "summarize {pkgs}" },
    ],
    background: false,
  }, theme as never, { expanded: true }).render(80);
  assert.deepEqual(rendered, []);
});

test("quiet streaming progress keeps agent and child trees but hides stream content", () => {
  setQuietMode(true);
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "working" }],
    details: {
      mode: "single",
      results: [],
      progress: [{
        agent: "general",
        name: "focus",
        correlationId: "focus-agent",
        taskIndex: 0,
        dependencies: [],
        status: "running",
        lastMessage: "SECRET_TAIL_TEXT that must not leak in quiet mode",
        recentTools: [{ name: "read", status: "running" }],
      }],
      childCalls: [{
        agent: "reviewer",
        name: "review",
        correlationId: "review-child",
        parentCorrelationId: "focus-agent",
        parentName: "focus",
        status: "running",
        lastMessage: "CHILD_SECRET_TAIL",
        recentTools: [{ name: "bash", status: "running" }],
      }],
    },
  }, { expanded: true }, theme as never).render(120);
  assert.equal(rendered.length, 3);
  assert.match(rendered[0], /running/);
  assert.match(rendered[1], /@focus/);
  assert.match(rendered[2], /└─.*@review.*child agent/);
  assert.doesNotMatch(rendered.join("\n"), /using|streaming|SECRET_TAIL_TEXT|CHILD_SECRET_TAIL/);
  assert.doesNotMatch(rendered.join("\n"), /Alt\+R/);
});

test("quiet streaming progress retains a structural row on a narrow viewport", () => {
  setQuietMode(true);
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "working" }],
    details: {
      mode: "single",
      results: [],
      progress: [{ agent: "general", name: "focus", correlationId: "focus-agent", taskIndex: 0, dependencies: [], status: "running" }],
    },
  }, { expanded: false }, theme as never).render(15);
  assert.equal(rendered.length, 2);
  assert.match(rendered[0], /^\s*…\s+teammate/);
  assert.match(rendered[1], /^•\s+1/);
});

test("teammate-list call and result own mutually exclusive unbacked phases", () => {
  const call = renderTeammateListCall({ view: "active" }, theme as never, { isPartial: true }).render(80);
  const settledCall = renderTeammateListCall({ view: "active" }, theme as never, { isPartial: false }).render(80);
  const partialResult = renderTeammateListResult({
    content: [{ type: "text", text: "@worker running" }],
    details: { agents: [] },
  }, { isPartial: true }, theme as never).render(80);
  const result = renderTeammateListResult({
    content: [{ type: "text", text: "@worker running" }],
    details: { agents: [] },
  }, { isPartial: false }, theme as never).render(80);

  assert.match(call[0], /teammate-list active/);
  assert.deepEqual(settledCall, []);
  assert.deepEqual(partialResult, []);
  assert.deepEqual(result, ["@worker running"]);
});

test("quiet completed single result is one concise named line without its message body", () => {
  setQuietMode(true);
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "complete output" }],
    details: { mode: "single", results: [okResult()] },
  }, { expanded: true }, theme as never).render(120);
  assert.equal(rendered.length, 1);
  assert.match(rendered[0], /✓/);
  assert.match(rendered[0], /@inspection/);
  assert.match(rendered[0], /\(scout\)/);
  assert.match(rendered[0], /done/);
  assert.match(rendered[0], /30 tokens/);
  assert.doesNotMatch(rendered[0], /teammate|1\/1/);
  assert.doesNotMatch(rendered.join("\n"), /complete output|Alt\+R/);
});

test("quiet completed result keeps named progress rows without completed message bodies", () => {
  setQuietMode(true);
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "complete output" }],
    details: {
      mode: "single",
      results: [okResult()],
      progress: [{
        agent: "scout",
        name: "inspection",
        correlationId: "scout-correlation",
        taskIndex: 0,
        dependencies: [],
        status: "completed",
        durationMs: 1000,
        inputTokens: 10,
        outputTokens: 20,
      }],
    },
  }, { expanded: true }, theme as never).render(120);
  assert.equal(rendered.length, 1);
  assert.match(rendered[0], /@inspection.*\(scout\)/);
  assert.doesNotMatch(rendered.join("\n"), /complete output/);
});

test("quiet completed graph is an unbacked one-line-per-agent list with dependencies", () => {
  setQuietMode(true);
  const first = okResult();
  const second = { ...okResult(), agent: "reviewer", name: "review", correlationId: "review-correlation" };
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "done" }],
    details: {
      mode: "graph",
      results: [first, second],
      progress: [
        { agent: "scout", name: "inspection", correlationId: first.correlationId, taskIndex: 0, dependencies: [], status: "completed" },
        { agent: "reviewer", name: "review", correlationId: second.correlationId, taskIndex: 1, dependencies: [0], status: "completed" },
      ],
    },
  }, { expanded: true }, theme as never).render(160);
  assert.equal(rendered.length, 2);
  assert.match(rendered[0], /@inspection.*\(scout\)/);
  assert.match(rendered[1], /@review.*\(reviewer\).*← result #1/);
  assert.doesNotMatch(rendered.join("\n"), /teammate|2\/2 done/);
});

test("quiet completed graph trusts results over lifecycle-pending progress snapshots", () => {
  setQuietMode(true);
  const first = okResult();
  const second = { ...okResult(), agent: "reviewer", name: "review", correlationId: "review-correlation" };
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "done" }],
    details: {
      mode: "parallel",
      results: [first, second],
      // executeGraph rewrites lifecycle-pending tasks back to "running" for the
      // live admission gate; the terminal quiet row must show the real outcome.
      progress: [
        { agent: "scout", name: "inspection", correlationId: first.correlationId, taskIndex: 0, dependencies: [], status: "running", resultReadyAt: Date.now() },
        { agent: "reviewer", name: "review", correlationId: second.correlationId, taskIndex: 1, dependencies: [], status: "running", resultReadyAt: Date.now() },
      ],
    },
  }, { expanded: false }, theme as never).render(160);
  assert.equal(rendered.length, 2);
  assert.match(rendered[0], /◉ sleeping · completed @inspection/);
  assert.match(rendered[1], /◉ sleeping · completed @review/);
  assert.doesNotMatch(rendered.join("\n"), /running|result ready/);
});

test("quiet completed graph marks failed results even when the snapshot is still running", () => {
  setQuietMode(true);
  const failed = failedResult();
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "boom" }],
    details: {
      mode: "parallel",
      results: [failed],
      progress: [
        { agent: "scout", name: "inspection", correlationId: failed.correlationId, taskIndex: 0, dependencies: [], status: "running" },
      ],
    },
  }, { expanded: false }, theme as never).render(160);
  assert.equal(rendered.length, 1);
  assert.match(rendered[0], /◉ sleeping · failed @inspection/);
  assert.match(rendered[0], /boom error line/);
  assert.doesNotMatch(rendered[0], /running/);
});

test("quiet single background ack keeps a running mark instead of a false completion", () => {
  setQuietMode(true);
  const ack: AgentToolResult<Details> = {
    content: [{ type: "text", text: "■ @ping running in background. Use teammate-wait to settle." }],
    details: { mode: "single", results: [] },
  };
  const rendered = renderTeammateResult(ack, { expanded: false }, theme as never).render(120);
  assert.equal(rendered.length, 1);
  assert.match(rendered[0], /^\s*…\s+teammate @ping running in background/);
  assert.doesNotMatch(rendered[0], /✓|child agents/);
});

test("quiet rejected dispatch shows a failure mark, not a success", () => {
  setQuietMode(true);
  // pi attaches isError to tool results at runtime; the declared type does not
  // carry it, so the cast keeps the literal honest without an excess property.
  const rejection = {
    content: [{ type: "text", text: "Teammate agent budget exhausted: 8 agents are already live" }],
    isError: true,
    details: { mode: "single", results: [] },
  } as AgentToolResult<Details>;
  const rendered = renderTeammateResult(rejection, { expanded: false }, theme as never).render(120);
  assert.match(rendered[0], /✕ teammate Teammate agent budget exhausted/);
  assert.doesNotMatch(rendered[0], /✓|child agents/);
});

test("quiet failed result keeps an agent row and a single error summary", () => {
  setQuietMode(true);
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "boom error line" }],
    details: { mode: "single", results: [failedResult()] },
  }, { expanded: true }, theme as never).render(120);
  assert.equal(rendered.length, 1);
  assert.match(rendered[0], /✕/);
  assert.match(rendered[0], /@inspection/);
  assert.match(rendered[0], /failed/);
  assert.match(rendered[0], /boom error line/);
  assert.doesNotMatch(rendered.join("\n"), /stack trace noise/);
});

test("dot symbol mode applies to teammate running, success, and failure rows", () => {
  setQuietMode(true, "dot");
  const call = renderTeammateCall({ agent: "general", prompt: "inspect" }, theme as never).render(80);
  assert.deepEqual(call, []);

  const success = renderTeammateResult({
    content: [{ type: "text", text: "complete output" }],
    details: { mode: "single", results: [okResult()] },
  }, { expanded: false }, theme as never).render(80);
  assert.match(success[0], /^\s*●\s+@inspection/);

  const failure = renderTeammateResult({
    content: [{ type: "text", text: "boom error line" }],
    details: { mode: "single", results: [failedResult()] },
  }, { expanded: false }, theme as never).render(80);
  assert.match(failure[0], /^\s*!\s+@inspection/);
});

test("started, send, observe, wait, watch, and monitor are wired to the shared quiet renderer", () => {
  const source = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  for (const name of ["teammate-started", "teammate-send", "observe", "teammate-wait", "teammate-watch", "teammate-monitor"]) {
    assert.match(source, new RegExp(`renderQuietTeammateAux\\(\\"${name}\\"`));
  }
});

test("auxiliary teammate renderers make call and result phases mutually exclusive", () => {
  const source = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  assert.equal((source.match(/if \(context\.isPartial === false\) return new Text\("", 0, 0\);/g) ?? []).length, 5);
  assert.equal((source.match(/if \(options\.isPartial\) return new Text\("", 0, 0\);/g) ?? []).length, 5);
});

test("auxiliary teammate tools use a self render shell in root and nested registrations", () => {
  const source = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  for (const name of ["teammate-send", "teammate-watch", "teammate-wait", "observe", "teammate-monitor"]) {
    assert.equal(
      (source.match(new RegExp(`name: \"${name}\",\\r?\\n\\s+label: \"[^\"]*\",\\r?\\n\\s+renderShell: \"self\",`, "g")) ?? []).length,
      2,
      `${name} should declare renderShell: "self" in both root and nested registrations`,
    );
  }
});

test("root and nested self-rendered teammate tools share renderers", () => {
  const source = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  assert.equal((source.match(/return renderTeammateCall\(/g) ?? []).length, 2);
  assert.equal((source.match(/return renderTeammateResult\(/g) ?? []).length, 3);
  assert.equal((source.match(/return renderTeammateListCall\(/g) ?? []).length, 2);
  assert.equal((source.match(/return renderTeammateListResult\(/g) ?? []).length, 2);
});

// Uniqueness guard (not a behaviour test): the ownership event is the single
// wire that drives the teammate quiet mirror. This regex breaks if the
// setQuietMode(...) call is removed from the COCKPIT_UI_OWNERSHIP_EVENT handler
// or stops reading payload.quiet, so the mirror cannot silently drift off the
// shared cockpit event. Behaviour (flag -> rendering) is covered above.
test("ownership handler is the unique wire for the teammate quiet mirror", () => {
  const source = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  assert.match(source, /pi\.events\.on\(COCKPIT_UI_OWNERSHIP_EVENT[\s\S]*?setQuietMode\([\s\S]*?quiet[\s\S]*?===\s*true/);
});
