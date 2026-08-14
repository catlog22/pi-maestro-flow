import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createRunEventComponent, renderRunEvent } from "../src/session/run-event.ts";
import {
  deriveWorkflowViewModel,
  type WorkflowSnapshotLike,
} from "../src/session/view-model.ts";
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

test("WorkflowViewModel derives statusless session/2.0 lifecycle from Execution facts", () => {
  const executing = statuslessSnapshot("active", "run-1", "running");
  assert.deepEqual(
    pickLifecycle(deriveWorkflowViewModel(executing)),
    { lifecycle: "executing", status: "running", activeRunId: "run-1" },
  );

  const blocked = statuslessSnapshot("paused", null, "pending");
  assert.deepEqual(
    pickLifecycle(deriveWorkflowViewModel(blocked)),
    { lifecycle: "blocked", status: "blocked", activeRunId: undefined },
  );

  const runnable = statuslessSnapshot("active", null, "pending");
  assert.deepEqual(
    pickLifecycle(deriveWorkflowViewModel(runnable)),
    { lifecycle: "runnable", status: "pending", activeRunId: undefined },
  );

  const gated = statuslessSnapshot("active", null, "pending");
  gated.session!.runs[0]!.gates = [{ id: "execution-gate", blocking: true, status: "failed" }];
  assert.equal(deriveWorkflowViewModel(gated)?.lifecycle, "blocked");

  const awaitingDecision = statuslessSnapshot("active", null, "pending");
  awaitingDecision.execution!.decisionPoints = [{
    pointId: "decision-1",
    afterStepId: null,
    status: "pending",
    retryCount: 0,
    maxRetries: 1,
    evidenceRef: null,
  }];
  assert.equal(deriveWorkflowViewModel(awaitingDecision)?.lifecycle, "blocked");

  const idle = statuslessSnapshot();
  assert.deepEqual(
    pickLifecycle(deriveWorkflowViewModel(idle)),
    { lifecycle: "idle", status: "completed", activeRunId: undefined },
  );

  const sealed = statuslessSnapshot("sealed", null, "completed");
  assert.deepEqual(
    pickLifecycle(deriveWorkflowViewModel(sealed)),
    { lifecycle: "idle", status: "completed", activeRunId: undefined },
  );

  const archived = statuslessSnapshot();
  archived.session!.archivedAt = "2026-07-18T03:00:00.000Z";
  archived.session!.archivedBy = "pi-owner";
  assert.deepEqual(
    pickLifecycle(deriveWorkflowViewModel(archived)),
    { lifecycle: "archived", status: "completed", activeRunId: undefined },
  );
});

test("WorkflowViewModel never promotes a Todo title into the statusline action", () => {
  const withoutWorkflowAction = structuredClone(snapshot);
  withoutWorkflowAction.nextAction = undefined;
  withoutWorkflowAction.session!.runs.find((candidate) => candidate.runId === "003")!.handoff = null;

  const view = deriveWorkflowViewModel(withoutWorkflowAction);
  assert.ok(view);
  assert.equal(view.nextAction, undefined);
  assert.equal(view.todos.find((todo) => todo.id === "local-1")?.subject, "Update README");
});

test("WorkflowViewModel treats an explicit null Goal as session-scoped absence", () => {
  const withoutGoal = structuredClone(snapshot);
  withoutGoal.goal = null;
  const view = deriveWorkflowViewModel(withoutGoal);
  assert.ok(view);
  assert.equal(view.goal, undefined);
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

  active.gates.push({ id: "GATE-BLOCKED", blocking: true, status: "blocked" });
  const blockedView = deriveWorkflowViewModel(terminal);
  assert.equal(blockedView?.activeRun?.gate, "GATE-BLOCKED");
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
  overlay.handleInput("D");
  assert.match(overlay.render(100).join("\n"), /✓ Complete 002/);
  overlay.handleInput("\r");
  await flushAsync();
  assert.deepEqual(actions, [{ action: "done", runId: "002" }]);
  overlay.handleInput("p");
  await flushAsync();
  const failed = overlay.render(100).join("\n");
  assert.match(failed, /002\/grill/);
  assert.match(failed, /Action failed: gate service unavailable/);
  assert.deepEqual(actions, [
    { action: "done", runId: "002" },
    { action: "pause", runId: "002" },
  ]);

  overlay.handleInput("\x1b");
  overlay.handleInput("\x1b");
  assert.equal(closed, 1);
});

test("Session overlay accepts keypad Enter and protocol Escape encodings", () => {
  const view = deriveWorkflowViewModel(snapshot);
  assert.ok(view);
  let closed = 0;
  const overlay = new SessionOverlay({
    view,
    requestRender() {},
    close() { closed++; },
    onAction() {},
  });

  overlay.handleInput("\x1b[106u");
  overlay.handleInput("\x1bOM");
  assert.match(overlay.render(100).join("\n"), /002\/grill/);
  overlay.handleInput("\x1b[27u");
  assert.doesNotMatch(overlay.render(100).join("\n"), /run detail/);
  overlay.handleInput("\x1b[27;1;27~");
  assert.equal(closed, 1);
});

function statuslessSnapshot(
  executionStatus?: "active" | "paused" | "sealed",
  activeRunId: string | null = null,
  stepStatus = "pending",
): WorkflowSnapshotLike {
  const sessionId = "statusless-session";
  const executionId = "execution-1";
  const runRecord = run("run-1", "execute", activeRunId ? "running" : stepStatus);
  return {
    source: "canonical",
    projectRoot: "D:/workspace",
    loadedAt: "2026-07-18T00:00:00.000Z",
    revision: {
      sessionRevision: 5,
      ...(executionStatus ? { executionRevision: 3 } : {}),
      fingerprint: `statusless-${executionStatus ?? "idle"}`,
    },
    diagnostics: [],
    locator: {
      sessionId,
      ...(executionStatus ? { executionId, generation: 1 } : {}),
      ...(activeRunId ? { runId: activeRunId } : {}),
    },
    session: {
      schemaVersion: "session/2.0",
      sessionId,
      intent: "Derive lifecycle",
      lifecycleAuthority: "execution-derived",
      revision: 5,
      activityRevision: 5,
      currentExecutionId: executionStatus ? executionId : null,
      latestExecutionId: executionStatus ? executionId : null,
      latestCompletedRunId: null,
      archivedAt: null,
      archivedBy: null,
      activeRunId: null,
      definitionOfDone: "",
      chain: [],
      runs: [runRecord],
      artifacts: [],
      aliases: {},
    },
    ...(executionStatus ? {
      execution: {
        schemaVersion: "execution/1.0",
        executionId,
        sessionId,
        generation: 1,
        status: executionStatus,
        revision: 3,
        activeRunId,
        chain: [{ step: "execute", command: "execute", status: stepStatus, runId: "run-1" }],
        decisionPoints: [],
        gatesRef: "gates.json",
        artifactsRef: "artifacts.json",
        evidenceRef: "evidence.json",
        lease: null,
        startedAt: "2026-07-18T00:00:00.000Z",
        sealedAt: executionStatus === "sealed" ? "2026-07-18T01:00:00.000Z" : null,
        sealSummary: executionStatus === "sealed" ? "done" : null,
        finalOutcome: executionStatus === "sealed" ? "done" : null,
      },
    } : {}),
  };
}

function pickLifecycle(view: ReturnType<typeof deriveWorkflowViewModel>) {
  assert.ok(view);
  return {
    lifecycle: view.lifecycle,
    status: view.status,
    activeRunId: view.activeRun?.id,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
