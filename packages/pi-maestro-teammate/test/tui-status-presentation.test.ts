import assert from "node:assert/strict";
import test from "node:test";
import {
  DERIVED_STATUS_PRESENTATION,
  STATUS_PRESENTATION,
  displayStatusPresentation,
  effectiveDisplayStatus,
  idleSeconds,
} from "../src/shared/agent-status.ts";
import { TEAMMATE_STALL_TIMEOUT_MS } from "../src/shared/limits.ts";
import { AttachOverlay } from "../src/tui/attach-overlay.ts";
import { buildProgressTree } from "../src/tui/progress-tree.ts";
import { renderTeammateResult } from "../src/tui/render.ts";
import type { ActiveAgent, AgentProgressSnapshot } from "../src/shared/types.ts";

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
const palette = {
  dim: (text: string) => text,
  accent: (text: string) => text,
  running: (text: string) => text,
  success: (text: string) => text,
  error: (text: string) => text,
  bold: (text: string) => text,
};

function activeAgent(overrides: Partial<ActiveAgent> = {}): ActiveAgent {
  const now = Date.now();
  return {
    agent: "worker",
    name: "worker",
    correlationId: "aaaaaaaa-worker",
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    status: "running",
    depth: 0,
    sleepMs: 0,
    ...overrides,
  } as ActiveAgent;
}

test("status presentation covers every canonical status exactly once", () => {
  assert.deepEqual(
    Object.keys(STATUS_PRESENTATION).sort(),
    ["completed", "failed", "pending", "retrying", "running", "sleeping", "terminated"],
  );
  // Activity is deliberately two-state; internal statuses survive only as phase/outcome text.
  assert.match(STATUS_PRESENTATION.retrying.text, /^running/);
  assert.match(STATUS_PRESENTATION.pending.text, /^running/);
  assert.match(STATUS_PRESENTATION.completed.text, /^sleeping/);
  assert.match(STATUS_PRESENTATION.failed.text, /^sleeping/);
  assert.match(STATUS_PRESENTATION.terminated.text, /^sleeping/);
  assert.equal(displayStatusPresentation("stalled"), DERIVED_STATUS_PRESENTATION.stalled);
  assert.equal(displayStatusPresentation("running"), STATUS_PRESENTATION.running);
});

test("effective display status derives result-ready and stalled from the shared threshold", () => {
  const now = 1_000_000;
  assert.equal(effectiveDisplayStatus("running", undefined, now, now), "running");
  assert.equal(effectiveDisplayStatus("running", undefined, undefined, now), "running");
  assert.equal(
    effectiveDisplayStatus("running", undefined, now - TEAMMATE_STALL_TIMEOUT_MS + 1, now),
    "running",
  );
  assert.equal(
    effectiveDisplayStatus("running", undefined, now - TEAMMATE_STALL_TIMEOUT_MS, now),
    "stalled",
  );
  // result-ready outranks stalled: the agent is not stuck, it is confirming.
  assert.equal(
    effectiveDisplayStatus("running", now - 1_000, now - 10 * TEAMMATE_STALL_TIMEOUT_MS, now),
    "result-ready",
  );
  // Non-running statuses are shown verbatim, never re-derived.
  for (const status of ["pending", "retrying", "sleeping", "completed", "failed", "terminated"] as const) {
    assert.equal(effectiveDisplayStatus(status, undefined, now - 600_000, now), status);
  }
  assert.equal(idleSeconds(now - 90_000, now), 90);
  assert.equal(idleSeconds(undefined, now), 0);
});

test("progress tree renders retrying tasks distinctly instead of pending", () => {
  const rows = buildProgressTree([
    { agent: "general", name: "flaky", correlationId: "flaky", taskIndex: 0, dependencies: [], status: "retrying" },
    { agent: "general", name: "waiting", correlationId: "waiting", taskIndex: 1, dependencies: [], status: "pending" },
  ] as AgentProgressSnapshot[], palette);

  assert.match(rows[0].text, /■ running · retrying/);
  assert.doesNotMatch(rows[0].text, /pending/);
  assert.match(rows[1].text, /■ running · starting/);
});

test("streaming child agents render retrying without a success checkmark", () => {
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "delegating" }],
    details: {
      mode: "single",
      results: [],
      childCalls: [{
        agent: "reviewer",
        name: "review",
        correlationId: "review-child",
        status: "retrying",
      }],
    },
  }, { expanded: false }, theme as never).render(100).join("\n");

  assert.match(rendered, /■ @review child agent · running · retrying/);
  assert.doesNotMatch(rendered, /✓/);
});

test("attach overlay detail view surfaces a stalled agent instead of plain Running", () => {
  const now = Date.now();
  const agent = activeAgent({ lastActivityAt: now - 120_000 });
  const overlay = new AttachOverlay(agent, () => {}, () => new Map([[agent.correlationId, agent]]));
  try {
    const rendered = overlay.render(100, 20).join("\n");
    assert.match(rendered, /stalled 12\ds/);
    assert.doesNotMatch(rendered, /Running/);
    // An idle tool row must expose how long it has been idle.
    assert.match(rendered, /Tools · idle 12\ds/);

    const fresh = activeAgent({ correlationId: "bbbbbbbb-fresh", lastActivityAt: now });
    const freshOverlay = new AttachOverlay(fresh, () => {}, () => new Map([[fresh.correlationId, fresh]]));
    try {
      const freshRendered = freshOverlay.render(100, 20).join("\n");
      assert.match(freshRendered, /Running/);
      assert.doesNotMatch(freshRendered, /stalled/);
    } finally {
      freshOverlay.dispose();
    }
  } finally {
    overlay.dispose();
  }
});

test("attach overlay task status shows retrying rather than pending", () => {
  const now = Date.now();
  const progress: AgentProgressSnapshot[] = [
    { agent: "general", name: "flaky", correlationId: "flaky", taskIndex: 0, dependencies: [], status: "retrying" },
    { agent: "general", name: "waiting", correlationId: "waiting", taskIndex: 1, dependencies: [], status: "pending" },
  ];
  const agent = activeAgent({ lastActivityAt: now, progress });
  const overlay = new AttachOverlay(agent, () => {}, () => new Map([[agent.correlationId, agent]]));
  try {
    overlay.setProgress(agent.correlationId, progress);
    // The overlay emits raw ANSI between the icon and the label.
    assert.match(overlay.render(100, 24).join("\n"), /■.*running · retrying/);
    overlay.handleInput("1");
    const selected = overlay.render(100, 24).join("\n");
    assert.match(selected, /running.*retrying/i);
    assert.doesNotMatch(selected, /Pending/);
  } finally {
    overlay.dispose();
  }
});

test("background tab updates never repaint the visible frame", () => {
  const now = Date.now();
  const first = activeAgent({ correlationId: "aaaaaaaa-first", name: "first", lastActivityAt: now });
  const second = activeAgent({ correlationId: "bbbbbbbb-second", name: "second", lastActivityAt: now });
  const runs = new Map([[first.correlationId, first], [second.correlationId, second]]);
  const overlay = new AttachOverlay(first, () => {}, () => runs);
  let renders = 0;
  overlay.setRequestRender(() => { renders += 1; });
  try {
    overlay.appendLog(second.correlationId, "background line", "output");
    overlay.setStreamingText(second.correlationId, "background stream");
    overlay.setActiveTools(second.correlationId, [{ name: "read", status: "running", startedAt: now }]);
    overlay.applyProgressEvent(second.correlationId, {
      progress: [{
        agent: "general",
        correlationId: second.correlationId,
        taskIndex: 0,
        dependencies: [],
        status: "running",
      }],
      lines: [{ text: "more background", kind: "output" }],
    });
    assert.equal(renders, 0, "background agent events must not request a frame");

    overlay.appendLog(first.correlationId, "foreground line", "output");
    assert.equal(renders, 1, "active agent events still repaint");

    // The buffered data is intact once the tab becomes visible.
    overlay.handleInput("\x1b[C");
    const rendered = overlay.render(100, 24).join("\n");
    assert.match(rendered, /background line/);
    assert.match(rendered, /more background/);
  } finally {
    overlay.dispose();
  }
});

test("attach overlay ticks only for visible spinner frames and elapsed seconds", async () => {
  const now = Date.now();
  const agent = activeAgent({ startedAt: now - 5_000, lastActivityAt: now });
  const overlay = new AttachOverlay(agent, () => {}, () => new Map([[agent.correlationId, agent]]));
  let renders = 0;
  overlay.setRequestRender(() => { renders += 1; });
  try {
    overlay.setActiveTools(agent.correlationId, [{ name: "read", status: "running", startedAt: now }]);
    overlay.render(10, 24);
    renders = 0;
    await new Promise((resolve) => setTimeout(resolve, 280));
    assert.equal(renders, 0, "a spinner hidden by compact layout must not repaint");

    overlay.render(80, 24);
    await new Promise((resolve) => setTimeout(resolve, 280));
    assert.ok(renders >= 1, "a visible running tool must animate its spinner");

    overlay.setActiveTools(agent.correlationId, []);
    overlay.render(80, 24);
    renders = 0;
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    assert.ok(renders >= 1 && renders <= 2, `uptime should repaint only across seconds, got ${renders}`);
  } finally {
    overlay.dispose();
  }
});

test("attach overlay log cache invalidates on append and bounds inbox payloads", () => {
  const now = Date.now();
  const agent = activeAgent({ correlationId: "cccccccc-log", lastActivityAt: now });
  const overlay = new AttachOverlay(agent, () => {}, () => new Map([[agent.correlationId, agent]]));
  try {
    overlay.appendLog(agent.correlationId, "first log line", "output");
    const before = overlay.render(100, 24).join("\n");
    assert.match(before, /first log line/);
    assert.equal(before, overlay.render(100, 24).join("\n"), "identical state must render identically");

    overlay.appendLog(agent.correlationId, "second log line", "output");
    assert.match(overlay.render(100, 24).join("\n"), /second log line/);

    agent.inbox.push({
      id: "1",
      from: "caller",
      to: "worker",
      kind: "task",
      payload: `head ${"x".repeat(60_000)} tail-marker`,
      timestamp: now,
    });
    const withInbox = overlay.render(100, 40).join("\n");
    assert.match(withInbox, /caller: head/);
    assert.doesNotMatch(withInbox, /tail-marker/, "oversized payloads must be truncated before wrapping");
  } finally {
    overlay.dispose();
  }
});

test("expanded results reuse their wrapped body and bound very large messages", () => {
  const huge = Array.from({ length: 5_000 }, (_, index) => `body line ${index + 1}`).join("\n");
  const component = renderTeammateResult({
    content: [{ type: "text", text: huge }],
    details: {
      mode: "single",
      results: [{
        agent: "scout",
        task: "inspect",
        exitCode: 0,
        messages: [{ role: "assistant", content: huge }],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
        model: "test-model",
        correlationId: "scout",
        durationMs: 10,
      }],
    },
  }, { expanded: true }, theme as never);

  const first = component.render(80);
  const second = component.render(80);
  assert.deepEqual(first, second);
  assert.notEqual(first, second, "memoized output must not alias the cached array");
  assert.ok(first.length < 300, `expanded body must stay bounded, got ${first.length} lines`);
  assert.match(first.join("\n"), /body line 1\b/);
});
