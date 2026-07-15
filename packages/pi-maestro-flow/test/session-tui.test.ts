import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createRunEventComponent, renderRunEvent } from "../src/session/run-event.ts";
import {
  deriveWorkflowViewModel,
  type WorkflowSnapshotLike,
} from "../src/session/view-model.ts";
import {
  nextMaestroPanelMode,
  renderMaestroPanel,
  type MaestroPanelMode,
} from "../src/tui/maestro-panel.ts";
import { SessionOverlay } from "../src/tui/session-overlay.ts";

const snapshot: WorkflowSnapshotLike = {
  source: "canonical",
  projectRoot: "D:\\pi-maestro-flow",
  loadedAt: "2026-07-15T00:00:00.000Z",
  revision: { sessionRevision: 7, fingerprint: "snapshot-7" },
  diagnostics: [],
  session: {
    sessionId: "20260715-auth-m1",
    label: "auth-m1",
    intent: "JWT authentication module",
    status: "paused",
    revision: 7,
    activeRunId: "003",
    definitionOfDone: "Auth verified",
    gates: [
      { id: "GATE-001", blocking: true, status: "passed" },
      { id: "GATE-002", blocking: true, status: "passed" },
      { id: "GATE-003-02", blocking: true, status: "pending" },
    ],
    chain: ["analyze", "grill", "plan", "execute", "verify", "retry", "seal", "archive"]
      .map((command, index) => ({
        step: String(index + 1),
        command,
        status: index < 2 ? "completed" : "pending",
        runId: String(index + 1).padStart(3, "0"),
      })),
    runs: [
      run("001", "analyze", "ready", { verdict: "pass" }),
      run("002", "grill", "sealed", { verdict: "pass" }),
      run("003", "plan", "blocked", { nextAction: "Resolve gate" }, "GATE-003-02"),
      run("004", "execute", "pending", { blockedBy: "003" }),
      run("005", "verify", "waiting_user"),
      run("006", "retry", "retrying", { attempt: 2 }),
      run("007", "seal", "failed"),
      run("008", "archive", "cancelled"),
    ],
    artifacts: [
      { artifactId: "a1", kind: "plan", role: "primary", runId: "001", path: "plan.md", hash: "h1", status: "ready", replaces: null },
      { artifactId: "a2", kind: "report", role: "primary", runId: "003", path: "report.md", hash: "h2", status: "ready", replaces: null },
      { artifactId: "a3", kind: "evidence", role: "support", runId: "003", path: "evidence.json", hash: "h3", status: "ready", replaces: null },
    ],
    aliases: {},
  },
  nextAction: "Resolve GATE-003-02",
  recoveryAction: "Resume from gate",
  goal: {
    objective: "JWT authentication module",
    status: "paused",
    tokensUsed: 45_000,
    tokenBudget: 300_000,
  },
  todos: [
    { id: "mirror-3", subject: "Mirror active run", status: "in_progress", origin: "mirror" },
    { id: "local-1", subject: "Update README", status: "pending", origin: "local" },
  ],
  decisionPoints: [{ status: "pending" }],
};

function run(
  runId: string,
  command: string,
  status: string,
  handoff: Record<string, unknown> | null = null,
  gate?: string,
) {
  return {
    runId,
    parentRunId: null,
    command,
    status,
    goal: null,
    args: [],
    gates: gate ? [{ id: gate, blocking: true, status: "pending" as const }] : [],
    primaryArtifactId: null,
    handoff,
    startedAt: "2026-07-15T00:00:00.000Z",
    endedAt: null,
  };
}

test("WorkflowViewModel derives one status projection for Session, Run, Goal and Todo", () => {
  const view = deriveWorkflowViewModel(snapshot);
  assert.ok(view);
  assert.equal(view.activeRun?.id, "003");
  assert.equal(view.activeRun?.glyph, "!");
  assert.deepEqual(view.chain, { completed: 2, running: 3, pending: 3, total: 8 });
  assert.equal(view.decisionPending, true);
  assert.equal(view.recoveryAction, "Resume from gate");
  assert.equal(view.goal?.glyph, "⏸");
});

test("WorkflowViewModel hides terminal-success gates and displays unresolved blocking gates", () => {
  const terminal = structuredClone(snapshot);
  const active = terminal.session!.runs.find((candidate) => candidate.runId === "003")!;
  active.gates = [
    { id: "GATE-PASSED", blocking: true, status: "passed" },
    { id: "GATE-WAIVED", blocking: true, status: "waived" },
    { id: "GATE-SKIPPED", blocking: true, status: "skipped" },
  ];
  const terminalView = deriveWorkflowViewModel(terminal);
  assert.ok(terminalView);
  assert.equal(terminalView.activeRun?.gate, undefined);
  assert.doesNotMatch(renderMaestroPanel(terminalView, "panorama", 120).join("\n"), /GATE-(?:PASSED|WAIVED|SKIPPED)/);

  active.gates.push({ id: "GATE-BLOCKED", blocking: true, status: "blocked" });
  const blockedView = deriveWorkflowViewModel(terminal);
  assert.equal(blockedView?.activeRun?.gate, "GATE-BLOCKED");
});

test("Maestro Panel cycles collapsed, todo and panorama with a 1..120 width matrix", () => {
  const view = deriveWorkflowViewModel(snapshot);
  assert.ok(view);
  let mode: MaestroPanelMode = "collapsed";
  mode = nextMaestroPanelMode(mode);
  assert.equal(mode, "todo");
  mode = nextMaestroPanelMode(mode);
  assert.equal(mode, "panorama");
  assert.equal(nextMaestroPanelMode(mode), "collapsed");

  for (const current of ["collapsed", "todo", "panorama"] as const) {
    for (let width = 1; width <= 120; width++) {
      for (const line of renderMaestroPanel(view, current, width)) {
        assert.ok(visibleWidth(line) <= width, `${current} width ${width}: ${line}`);
      }
    }
  }

  assert.match(renderMaestroPanel(view, "collapsed", 80)[0], /^» Resume from gate/);
  const panorama = renderMaestroPanel(view, "panorama", 120).join("\n");
  assert.match(panorama, /! blocked/);
  assert.match(panorama, /\? waiting user/);
  assert.match(panorama, /↻ retry 2/);
  assert.match(panorama, /Update README/);
  assert.doesNotMatch(panorama, /Mirror active run/);
});

test("run-event renderer keeps the recovery action first and fits every width", () => {
  const event = {
    runId: "003",
    command: "plan",
    status: "blocked",
    verdict: "gate_failed",
    artifactsCount: 2,
    nextAction: "Resume from gate",
  };
  for (const expanded of [false, true]) {
    for (let width = 1; width <= 120; width++) {
      for (const line of renderRunEvent(event, expanded, width)) {
        assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
      }
    }
  }
  assert.match(renderRunEvent(event, false, 80)[0], /^» Resume from gate · ! blocked/);
  assert.match(createRunEventComponent(event, true).render(80).join("\n"), /Artifacts: 2/);
});

test("Session overlay provides list/detail/confirm controls and preserves selection on failure", async () => {
  const view = deriveWorkflowViewModel(snapshot);
  assert.ok(view);
  const actions: Array<{ action: string; runId?: string }> = [];
  let closed = 0;
  const overlay = new SessionOverlay({
    view,
    requestRender() {},
    close() { closed++; },
    async onAction(action, runId) {
      actions.push({ action, runId });
      if (action === "pause") throw new Error("gate service unavailable");
    },
  });

  for (let width = 1; width <= 120; width++) {
    for (const line of overlay.render(width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
    }
  }
  assert.match(overlay.render(100).join("\n"), /! blocked/);
  assert.match(overlay.render(100).join("\n"), /» Resume from gate/);

  overlay.handleInput("\x1b[B");
  overlay.handleInput("\r");
  assert.match(overlay.render(100).join("\n"), /002\/grill/);
  overlay.handleInput("x");
  assert.match(overlay.render(100).join("\n"), /⊘ Cancel 002/);
  overlay.handleInput("\r");
  await flushAsync();
  assert.deepEqual(actions, [{ action: "cancel", runId: "002" }]);
  overlay.handleInput("p");
  await flushAsync();
  const failed = overlay.render(100).join("\n");
  assert.match(failed, /002\/grill/);
  assert.match(failed, /Action failed: gate service unavailable/);
  assert.deepEqual(actions, [
    { action: "cancel", runId: "002" },
    { action: "pause", runId: "002" },
  ]);

  overlay.handleInput("\x1b");
  overlay.handleInput("\x1b");
  assert.equal(closed, 1);
});

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
