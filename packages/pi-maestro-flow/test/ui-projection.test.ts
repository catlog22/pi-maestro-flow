import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  COCKPIT_MAESTRO_QUERY_EVENT,
  MAESTRO_UI_SNAPSHOT_EVENT,
  MAESTRO_UI_SNAPSHOT_VERSION,
  type MaestroUiSnapshotV1,
} from "pi-cockpit/v1/events";
import type { WorkflowViewModel } from "../src/session/view-model.ts";
import type { TeamSwarmProjection } from "../src/swarm/projection.ts";
import type { GoalDetailEntry } from "../src/tui/goal-widget.ts";
import {
  MaestroUiPublisher,
  projectMaestroUiState,
  registerMaestroUiQuery,
  type MaestroUiProjectionInput,
} from "../src/ui-projection.ts";

function workflow(): WorkflowViewModel {
  const activeRun = {
    id: "run-1",
    command: "implement",
    status: "running" as const,
    glyph: ">",
    artifactsCount: 2,
  };
  return {
    sessionId: "session-1",
    sessionLabel: "Current session",
    status: "running",
    glyph: ">",
    activeRun,
    runs: [activeRun],
    todos: [],
    chain: { completed: 1, running: 1, pending: 2, total: 4 },
    gates: { passed: 2, total: 3 },
    decisionPending: false,
    nextAction: "maestro run next",
  };
}

function goals(): GoalDetailEntry[] {
  return [
    {
      id: "goal-2",
      objective: "Second goal",
      status: "paused",
      pauseReason: "gate",
      iteration: 3,
      tokensUsed: 120,
      tokenBudget: 500,
      timeUsedSeconds: 20,
      startedAt: 20,
      updatedAt: 30,
    },
    {
      id: "goal-1",
      objective: "First goal",
      status: "active",
      iteration: 2,
      tokensUsed: 80,
      timeUsedSeconds: 10,
      startedAt: 10,
      updatedAt: 15,
    },
  ];
}

function swarm(): TeamSwarmProjection {
  return {
    source: "team-swarm-json",
    teamDir: "D:/project/team",
    runDir: "D:/project/run",
    outputsDir: "D:/project/outputs",
    sessionId: "swarm-1",
    objective: "Search the solution space",
    status: "active",
    iteration: 2,
    maxIterations: 5,
    antsPerIteration: 2,
    activeWorkers: ["worker-b", "worker-a", "worker-a"],
    completedIterations: [1],
    nodes: [],
    edges: [],
    metrics: [],
    best: {
      antId: "worker-b",
      iteration: 2,
      score: 0.91,
      path: [],
      summary: "Best candidate",
      evidence: [],
    },
    updatedAt: "2026-07-27T12:00:00.000Z",
  };
}

function input(): MaestroUiProjectionInput {
  return {
    workflow: workflow(),
    goals: goals(),
    currentGoalId: "goal-1",
    swarm: swarm(),
    artifact: { available: true, revision: 3, status: "draft" },
    planMode: "plan",
    approvalMode: "bypassPermissions",
  };
}

test("projects workflow, Goal, mode, and read-only Team Swarm state into v1", () => {
  const projection = projectMaestroUiState(input());

  assert.deepEqual(projection.workflow, {
    session: { id: "session-1", label: "Current session", status: "running" },
    run: { id: "run-1", command: "implement", status: "running" },
    chain: { completed: 1, running: 1, pending: 2, total: 4 },
    gates: { passed: 2, total: 3 },
    next: "maestro run next",
  });
  assert.deepEqual(projection.goals.map((goal) => goal.id), ["goal-1", "goal-2"]);
  assert.deepEqual(projection.goals[1], {
    id: "goal-2",
    objective: "Second goal",
    status: "paused",
    pauseReason: "gate",
    iteration: 3,
    tokensUsed: 120,
    tokenBudget: 500,
    timeUsedSeconds: 20,
    startedAt: 20,
    updatedAt: 30,
  });
  assert.equal(projection.currentGoalId, "goal-1");
  assert.deepEqual(projection.mode, { kind: "plan", label: "bypassPermissions" });
  assert.deepEqual(projection.artifact, {
    available: true,
    planRevision: 3,
    planStatus: "draft",
  });
  assert.deepEqual(projection.swarm, {
    sessionId: "swarm-1",
    objective: "Search the solution space",
    status: "active",
    iteration: 2,
    maxIterations: 5,
    workers: [
      { id: "worker-a", status: "active" },
      { id: "worker-b", status: "active" },
    ],
    best: {
      workerId: "worker-b",
      iteration: 2,
      score: 0.91,
      summary: "Best candidate",
    },
    updatedAt: Date.parse("2026-07-27T12:00:00.000Z"),
  });
  assert.deepEqual(Object.keys(projection).sort(), ["artifact", "currentGoalId", "goals", "mode", "swarm", "workflow"]);
});

test("session-bound staged Knowledge makes the Artifact entry available without a Plan", () => {
  const next = input();
  next.artifact = {
    available: false,
    revision: 0,
    status: "empty",
    knowledgeAvailable: true,
    knowledgeSessionId: "session-1",
  };
  delete next.workflow?.knowledge;
  assert.deepEqual(projectMaestroUiState(next).artifact, {
    available: true,
    planRevision: 0,
    planStatus: "empty",
    knowledgeSessionId: "session-1",
  });
});

test("cold full publish, stable dedupe, safe revisions, and session generations are ordered", () => {
  let state = input();
  const emitted: Array<{ event: string; snapshot: MaestroUiSnapshotV1 }> = [];
  const generations = ["generation-cold", "generation-session"];
  let now = 100;
  const publisher = new MaestroUiPublisher({
    read: () => state,
    emit: (event, snapshot) => emitted.push({ event, snapshot }),
    generation: () => generations.shift()!,
    now: () => now++,
  });
  let queryListener: ((payload: unknown) => void) | undefined;
  registerMaestroUiQuery({
    on(event, listener) {
      assert.equal(event, COCKPIT_MAESTRO_QUERY_EVENT);
      queryListener = listener;
    },
  }, publisher);

  queryListener?.({ version: MAESTRO_UI_SNAPSHOT_VERSION });
  const cold = emitted[0]?.snapshot;
  assert.ok(cold && cold.cleared !== true);
  assert.equal(cold.revision, 0);
  assert.equal(cold.sessionGeneration, "generation-cold");
  assert.equal(emitted[0]?.event, MAESTRO_UI_SNAPSHOT_EVENT);

  assert.equal(publisher.publish(), undefined);
  assert.equal(emitted.length, 1);

  state = {
    ...state,
    goals: [...state.goals].reverse(),
    swarm: { ...state.swarm!, activeWorkers: [...state.swarm!.activeWorkers].reverse() },
  };
  assert.equal(publisher.publish(), undefined, "source ordering alone must not publish a new revision");

  const queryReply = publisher.publishFull();
  assert.equal(queryReply.revision, 1, "a cold/recovery query always receives a full newer snapshot");

  state = { ...state, approvalMode: "default" };
  const changed = publisher.publish();
  assert.equal(changed?.revision, 2);
  assert.deepEqual(changed?.mode, { kind: "plan", label: "default" });

  publisher.beginSession();
  const nextSession = publisher.publish();
  assert.equal(nextSession?.revision, 0);
  assert.equal(nextSession?.sessionGeneration, "generation-session");
  assert.equal(Number.isSafeInteger(nextSession?.revision), true);
});

test("inactive query guard cannot resurrect state after shutdown clear", () => {
  const emitted: MaestroUiSnapshotV1[] = [];
  let active = true;
  let queryListener: ((payload: unknown) => void) | undefined;
  const publisher = new MaestroUiPublisher({
    read: input,
    emit: (_event, snapshot) => emitted.push(snapshot),
    generation: () => "generation-inactive",
    now: () => 500,
  });
  registerMaestroUiQuery({
    on(_event, listener) { queryListener = listener; },
  }, publisher, () => active);

  queryListener?.({ version: MAESTRO_UI_SNAPSHOT_VERSION });
  assert.equal(emitted.length, 1);
  active = false;
  publisher.clear();
  queryListener?.({ version: MAESTRO_UI_SNAPSHOT_VERSION });
  assert.equal(emitted.length, 2);
  assert.equal(emitted.at(-1)?.cleared, true);
});

test("shutdown clear is a minimal tombstone ordered after the last full snapshot", () => {
  const emitted: MaestroUiSnapshotV1[] = [];
  const publisher = new MaestroUiPublisher({
    read: input,
    emit: (_event, snapshot) => emitted.push(snapshot),
    generation: () => "generation-clear",
    now: () => 1234,
  });

  const full = publisher.publishFull();
  const clear = publisher.clear();
  assert.equal(clear.sessionGeneration, full.sessionGeneration);
  assert.equal(clear.revision, full.revision + 1);
  assert.deepEqual(clear, {
    version: MAESTRO_UI_SNAPSHOT_VERSION,
    sessionGeneration: "generation-clear",
    revision: 1,
    publishedAt: 1234,
    cleared: true,
  });
  assert.deepEqual(Object.keys(clear).sort(), ["cleared", "publishedAt", "revision", "sessionGeneration", "version"]);
  assert.equal(emitted.length, 2);
});

test("root extension source composes existing listeners and publishes every required lifecycle", () => {
  const extensionSource = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  const swarmSource = readFileSync(new URL("../src/tools/swarm.ts", import.meta.url), "utf8");
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts?: Record<string, string>;
  };

  const childFence = extensionSource.indexOf("if (process.env.PI_TEAMMATE_CHILD === \"1\")");
  const publisherCreation = extensionSource.indexOf("new MaestroUiPublisher");
  assert.ok(childFence >= 0 && publisherCreation > childFence, "only the root extension creates the publisher");
  assert.match(extensionSource, /registerMaestroUiQuery\(pi\.events, maestroUiPublisher, \(\) => maestroUiSessionActive\)/);
  assert.match(extensionSource, /setGoalStateChangeListener\(\(\) => \{[\s\S]*?emitGoalChanged\(\)[\s\S]*?publishMaestroUi\(\)/);
  assert.match(extensionSource, /setPlanModeChangeListener[\s\S]*?publishMaestroUi\(\)/);
  assert.match(extensionSource, /async function refreshWorkflow[\s\S]*?updateTodoWidget\(\);\s*publishMaestroUi\(\);/);
  assert.match(extensionSource, /registerSwarmDisplay\(pi, \{[\s\S]*?onProjectionChange[\s\S]*?publishMaestroUi\(\)/);
  assert.match(extensionSource, /pi\.on\("session_start"[\s\S]*?beginSession\(\)[\s\S]*?publishMaestroUi\(\)/);
  assert.match(extensionSource, /pi\.on\("session_shutdown"[\s\S]*?maestroUiSessionActive = false;[\s\S]*?maestroUiPublisher\.clear\(\)/);

  assert.doesNotMatch(swarmSource, /registerTool\(|registerCommand\(|swarm_runtime/);
  assert.match(swarmSource, /onProjectionChange\?\.\(snapshot\)/);
  assert.match(swarmSource, /onProjectionChange\?\.\(undefined\)/);
  assert.match(packageJson.scripts?.["test:session"] ?? "", /test\/ui-projection\.test\.ts/);
});
