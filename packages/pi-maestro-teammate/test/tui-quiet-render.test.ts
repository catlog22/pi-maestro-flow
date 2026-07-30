import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach } from "node:test";
import { isQuietMode, setQuietMode } from "../src/quiet-state.ts";
import { renderTeammateCall, renderTeammateResult } from "../src/tui/render.ts";
import type { SingleResult } from "../src/shared/types.ts";

// Identity theme strips color so assertions read the plain text the quiet
// renderer emits (two spaces + glyph + name + rest).
const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

afterEach(() => setQuietMode(false));

function okResult(): SingleResult {
  return {
    agent: "scout",
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

test("quiet single-task call is one line without key hints or tree glyphs", () => {
  setQuietMode(true);
  const rendered = renderTeammateCall({ agent: "general", name: "ping", prompt: "reply pong" }, theme as never, { expanded: true }).render(80);
  assert.equal(rendered.length, 1);
  assert.doesNotMatch(rendered[0], /\n/);
  assert.match(rendered[0], /^\s*⋯\s+teammate\s+@ping\s+\(general\)/);
  assert.doesNotMatch(rendered[0], /Alt\+B/);
  assert.doesNotMatch(rendered[0], /[├└│]/);
});

test("quiet multi-task chain call is one line without the launch header or key hints", () => {
  setQuietMode(true);
  const rendered = renderTeammateCall({
    tasks: [
      { agent: "explorer", name: "pkgs", prompt: "inspect packages" },
      { agent: "general", name: "summary", prompt: "summarize {pkgs}" },
    ],
    background: false,
  }, theme as never, { expanded: true }).render(80);
  assert.equal(rendered.length, 1);
  assert.match(rendered[0], /2 agents chain/);
  assert.doesNotMatch(rendered[0], /launched/);
  assert.doesNotMatch(rendered[0], /Alt\+R/);
  assert.doesNotMatch(rendered[0], /[├└│]/);
});

test("quiet streaming progress is one aggregate line with no tree, child subtree or stream tail", () => {
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
      }],
    },
  }, { expanded: true }, theme as never).render(120);
  assert.equal(rendered.length, 1);
  assert.doesNotMatch(rendered[0], /\n/);
  assert.match(rendered[0], /running/);
  assert.match(rendered[0], /@focus/);
  assert.match(rendered[0], /using read/);
  assert.doesNotMatch(rendered[0], /SECRET_TAIL_TEXT/);
  assert.doesNotMatch(rendered[0], /[├└│]/);
  assert.doesNotMatch(rendered[0], /Alt\+R/);
});

test("quiet streaming progress collapses to state-only on a narrow viewport", () => {
  setQuietMode(true);
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "working" }],
    details: {
      mode: "single",
      results: [],
      progress: [{ agent: "general", name: "focus", correlationId: "focus-agent", taskIndex: 0, dependencies: [], status: "running" }],
    },
  }, { expanded: false }, theme as never).render(15);
  assert.equal(rendered.length, 1);
  // Narrow viewport: the line is truncated and the focus segment is dropped
  // (w < 20), so only the glyph + tool name survive. Assert the prefix and the
  // absence of the focus handle — not the state word, which truncateToWidth
  // cuts off (and it appends an ANSI reset at the cut point).
  assert.match(rendered[0], /^\s*■\s+teammate/);
  assert.doesNotMatch(rendered[0], /@focus/);
  assert.doesNotMatch(rendered[0], /[├└│]/);
});

test("quiet completed single result is one success line with token total", () => {
  setQuietMode(true);
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "complete output" }],
    details: { mode: "single", results: [okResult()] },
  }, { expanded: true }, theme as never).render(120);
  assert.equal(rendered.length, 1);
  assert.match(rendered[0], /✓/);
  assert.match(rendered[0], /scout done/);
  assert.match(rendered[0], /30 tokens/);
  assert.doesNotMatch(rendered[0], /Alt\+R/);
});

test("quiet failed result is one error line carrying the first error line", () => {
  setQuietMode(true);
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "boom error line" }],
    details: { mode: "single", results: [failedResult()] },
  }, { expanded: true }, theme as never).render(120);
  assert.equal(rendered.length, 1);
  assert.match(rendered[0], /✗/);
  assert.match(rendered[0], /failed/);
  assert.match(rendered[0], /boom error line/);
  assert.doesNotMatch(rendered[0], /stack trace noise/);
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
