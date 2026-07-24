import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { GoalOverlay, type GoalOverlayAction } from "../src/tui/goal-overlay.ts";
import type { GoalDetailEntry } from "../src/tui/goal-widget.ts";

const identity = (_color: string, text: string): string => text;
const mockTheme = {
  fg: identity,
  bg: identity,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function entry(id: string, objective: string, overrides: Partial<GoalDetailEntry> = {}): GoalDetailEntry {
  return {
    id,
    objective,
    status: "paused",
    iteration: 0,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    startedAt: 1,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function sampleEntries(): GoalDetailEntry[] {
  return [
    entry("g1", "First gate", { status: "done", timeUsedSeconds: 5, todoSubject: "Task A" }),
    entry("g2", "Second gate", {
      status: "active",
      iteration: 1,
      tokensUsed: 12_000,
      tokenBudget: 50_000,
      timeUsedSeconds: 60,
      todoSubject: "Task B",
      acceptance: ["npm test"],
      workflowSessionId: "sess-1",
    }),
    entry("g3", "Final acceptance", { status: "paused", pauseReason: "user" }),
  ];
}

interface Harness {
  overlay: GoalOverlay;
  actions: Array<{ action: GoalOverlayAction; goalId: string }>;
  renders: number;
  closed: number;
  setEntries: (entries: GoalDetailEntry[]) => void;
  currentId: string | undefined;
}

function harness(
  options: { onAction?: (action: GoalOverlayAction, goalId: string) => void | Promise<void> } = {},
): Harness {
  let entries = sampleEntries();
  const state: Harness = {
    overlay: undefined as never,
    actions: [],
    renders: 0,
    closed: 0,
    setEntries: (next) => { entries = next; },
    currentId: "g2",
  };
  state.overlay = new GoalOverlay({
    getEntries: () => entries,
    getCurrentGoalId: () => state.currentId,
    getPhase: () => "normal",
    requestRender: () => { state.renders++; },
    close: () => { state.closed++; },
    theme: mockTheme,
    onAction: options.onAction ?? ((action, goalId) => { state.actions.push({ action, goalId }); }),
  });
  return state;
}

test("Goal overlay renders width-safely in list, detail, and confirm modes", () => {
  const h = harness();
  const assertSafe = (mode: string) => {
    for (let width = 1; width <= 140; width++) {
      for (const line of h.overlay.render(width)) {
        assert.ok(visibleWidth(line) <= width, `${mode} @ width ${width}: ${line}`);
      }
    }
  };
  assertSafe("list");
  h.overlay.handleInput("\r");
  assertSafe("detail");
  h.overlay.handleInput("\x1b");
  h.overlay.handleInput("x");
  assertSafe("confirm");
  h.overlay.handleInput("\x1b");
  h.overlay.handleInput("\x1b");
  assert.equal(h.closed, 1);
});

test("Goal overlay lists every goal with status chips and marks the current one", () => {
  const h = harness();
  const text = h.overlay.render(100).join("\n");
  assert.match(text, /Goal center · 3 goals/);
  assert.match(text, /1 active · 1 stopped · 1 done/);
  assert.match(text, /› ✓ 1\/3 · verified/);
  assert.match(text, /▶ 2\/3 · ACTIVE · 12k\/50k · current/);
  assert.match(text, /⏸ 3\/3 · stopped/);
  assert.match(text, /Esc close/);
});

test("Goal overlay navigates with j/k and arrows with wrap-around", () => {
  const h = harness();
  h.overlay.handleInput("j");
  assert.match(h.overlay.render(100).join("\n"), /› ▶ 2\/3 · ACTIVE/);
  h.overlay.handleInput("\x1b[B");
  assert.match(h.overlay.render(100).join("\n"), /› ⏸ 3\/3 · stopped/);
  h.overlay.handleInput("j");
  assert.match(h.overlay.render(100).join("\n"), /› ✓ 1\/3 · verified/);
  h.overlay.handleInput("k");
  assert.match(h.overlay.render(100).join("\n"), /› ⏸ 3\/3 · stopped/);
  assert.ok(h.renders >= 4);
});

test("Goal overlay detail mode shows the full objective and lifecycle fields", () => {
  const h = harness();
  h.overlay.handleInput("j");
  h.overlay.handleInput("\r");
  const text = h.overlay.render(60).join("\n");
  assert.match(text, /Goal 2\/3 · ACTIVE · current/);
  assert.match(text, /Second gate/);
  assert.match(text, /Status\s+active/);
  assert.match(text, /Round\s+2/);
  assert.match(text, /Elapsed\s+1m/);
  assert.match(text, /Tokens\s+12k\/50k \[██░░░░░░░░\] 24%/);
  assert.match(text, /Task\s+Task B/);
  assert.match(text, /Acceptance\s+npm test/);
  assert.match(text, /Workflow\s+sess-1/);
  assert.match(text, /Updated\s+0s ago/);
  assert.match(text, /Esc back/);
  h.overlay.handleInput("\x1b");
  assert.doesNotMatch(h.overlay.render(60).join("\n"), /Esc back/);
});

test("Goal overlay wide mode renders the list and detail panes side by side", () => {
  const h = harness();
  const text = h.overlay.render(120).join("\n");
  assert.match(text, /│/);
  assert.match(text, /1\/3/);
  assert.match(text, /2\/3/);
  assert.match(text, /3\/3/);
  assert.match(text, /Status\s+done/);
  assert.match(text, /First gate/);
});

test("Goal overlay dispatches switch/stop/resume and gates clear behind a confirm", async () => {
  const h = harness();
  h.overlay.handleInput("s");
  await tick();
  assert.deepEqual(h.actions, [{ action: "switch", goalId: "g1" }]);

  h.overlay.handleInput("j");
  h.overlay.handleInput("p");
  await tick();
  h.overlay.handleInput("j");
  h.overlay.handleInput("r");
  await tick();
  assert.deepEqual(h.actions, [
    { action: "switch", goalId: "g1" },
    { action: "stop", goalId: "g2" },
    { action: "resume", goalId: "g3" },
  ]);

  h.overlay.handleInput("x");
  const confirm = h.overlay.render(80).join("\n");
  assert.match(confirm, /Clear Goal 3\/3\?/);
  assert.match(confirm, /Final acceptance/);
  assert.match(confirm, /Enter confirm · Esc back/);
  h.overlay.handleInput("\x1b");
  assert.equal(h.actions.length, 3);

  h.overlay.handleInput("x");
  h.overlay.handleInput("\r");
  await tick();
  assert.deepEqual(h.actions[3], { action: "clear", goalId: "g3" });
});

test("Goal overlay surfaces failed actions without closing", async () => {
  const h = harness({
    onAction: () => { throw new Error("goal is done"); },
  });
  h.overlay.handleInput("p");
  await tick();
  assert.match(h.overlay.render(80).join("\n"), /Action failed: goal is done/);
  assert.equal(h.closed, 0);
});

test("Goal overlay tracks live entry changes and clamps the selection", () => {
  const h = harness();
  h.overlay.handleInput("j");
  h.overlay.handleInput("j");
  h.setEntries(sampleEntries().slice(0, 1));
  const text = h.overlay.render(80).join("\n");
  assert.match(text, /Goal center · 1 goal /);
  assert.match(text, /› ✓ 1\/1/);
});

test("Goal overlay degrades to a single line below width 20", () => {
  const h = harness();
  const lines = h.overlay.render(12);
  assert.equal(lines.length, 1);
  assert.ok(visibleWidth(lines[0]) <= 12);
  assert.match(lines[0], /1\/3/);
});
