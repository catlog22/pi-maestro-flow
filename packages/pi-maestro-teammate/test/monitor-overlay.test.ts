import assert from "node:assert/strict";
import test from "node:test";
import { MonitorOverlay, type MonitorSessionRow } from "../src/tui/monitor-overlay.ts";
import { statusIcon } from "../src/extension/monitor.ts";

function agentRow(overrides: Partial<MonitorSessionRow> = {}): MonitorSessionRow {
  return {
    correlationId: "local-cid-1",
    displayName: "worker-1",
    agentRole: "general",
    status: "running",
    idleSeconds: 3,
    bound: false,
    source: "local",
    kind: "agent",
    ownerId: "local",
    bindable: false,
    depth: 0,
    ...overrides,
  };
}

function nestedAgentRow(overrides: Partial<MonitorSessionRow> = {}): MonitorSessionRow {
  return {
    correlationId: "local-cid-2",
    displayName: "sub-1",
    agentRole: "general",
    status: "sleeping",
    idleSeconds: 12,
    bound: false,
    source: "local",
    kind: "agent",
    ownerId: "local",
    bindable: false,
    depth: 1,
    parentCorrelationId: "local-cid-1",
    ...overrides,
  };
}

function localWindowRow(agentCount: number): MonitorSessionRow {
  return {
    correlationId: "local",
    displayName: "本窗口",
    agentRole: `window · ${agentCount} agents`,
    status: agentCount === 0 ? "idle" : "running",
    idleSeconds: 0,
    bound: false,
    source: "local",
    kind: "window",
    ownerId: "local",
    bindable: false,
  };
}

function idleWindowRow(overrides: Partial<MonitorSessionRow> = {}): MonitorSessionRow {
  return {
    correlationId: "owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    displayName: "window:aaaaaa",
    agentRole: "window · 0 agents",
    status: "idle",
    idleSeconds: 0,
    bound: false,
    source: "remote:aaaaaa",
    kind: "window",
    ownerId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    bindable: true,
    ...overrides,
  };
}

function makeOverlay(rows: MonitorSessionRow[]) {
  let result: unknown;
  const overlay = new MonitorOverlay({
    getSessions: () => rows,
    close: (value) => {
      result = value;
    },
  });
  overlay.setRequestRender(() => {});
  return { overlay, lastResult: (): unknown => result };
}

/** Strip ANSI color codes for plain-text assertions. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test("monitor overlay renders a window → agent → sub-agent tree", () => {
  const { overlay } = makeOverlay([
    localWindowRow(2),
    agentRow(),
    nestedAgentRow(),
    idleWindowRow(),
  ]);
  const view = stripAnsi(overlay.render(100).join("\n"));
  assert.match(view, /\[窗口\] 本窗口/);
  assert.match(view, /└─ . \[代理\] worker-1/);
  assert.match(view, / {3}└─ . \[代理\] sub-1/);
  assert.match(view, /\[窗口\] window:aaaaaa/);
  assert.match(view, /window · 0 agents/);
  assert.match(view, /idle/);
});

test("monitor overlay selects window rows but refuses agent rows", () => {
  const { overlay, lastResult } = makeOverlay([
    localWindowRow(1),
    agentRow(),
    idleWindowRow(),
  ]);

  // Row order: 0=local window (display-only), 1=worker-1 (agent, refused),
  // 2=remote idle window (selectable).
  overlay.handleInput("\x1b[B"); // → worker-1
  overlay.handleInput(" "); // agent must be refused
  assert.match(stripAnsi(overlay.render(100).join("\n")), /Sub-agents are supervised by their window's main session/);

  overlay.handleInput("\x1b[A"); // → local window (display-only)
  overlay.handleInput(" "); // local window must be refused
  assert.match(stripAnsi(overlay.render(100).join("\n")), /The current window is where you are — monitor remote windows/);

  overlay.handleInput("\x1b[B"); // → worker-1
  overlay.handleInput("\x1b[B"); // → remote window
  overlay.handleInput(" "); // select the window
  overlay.handleInput("\r");
  const result = lastResult() as { selected: string[]; mode: string } | null;
  assert.ok(result, "confirm() should close with a result");
  assert.deepEqual(result.selected, ["owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
  assert.equal(result.mode, "auto");
});

test("standalone agents without a window root are not monitor targets", () => {
  const { overlay } = makeOverlay([
    agentRow({ ownerId: "ghost-owner" }),
    nestedAgentRow({ ownerId: "ghost-owner" }),
  ]);
  const view = stripAnsi(overlay.render(100).join("\n"));
  assert.doesNotMatch(view, /worker-1/);
  assert.doesNotMatch(view, /sub-1/);
  assert.match(view, /No active sessions/);
});

test("status icons cover idle window rows", () => {
  assert.equal(statusIcon("idle"), "▢");
});
