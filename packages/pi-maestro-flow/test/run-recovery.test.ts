import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  createMaestroCompaction,
  type MaestroCompactionDetails,
  type WorkflowRecoveryIdentity,
} from "../src/compaction/maestro-compaction.ts";
import { TodoSkillLoadError, TodoSkillLoader } from "../src/skills/skill-loader.ts";
import { SkillRuntime } from "../src/skills/skill-runtime.ts";
import {
  executeGoal,
  executeGoalCommand,
  getActiveGoal,
  initGoal,
  onCompact as onGoalCompact,
  reconcileWorkflowGoal,
  onSessionShutdown as onGoalSessionShutdown,
  onSessionStart as onGoalSessionStart,
  setWorkflowCoordinator,
  type GoalContext,
} from "../src/tools/goal.ts";
import {
  executeTodo,
  getVisibleTasks,
  initTodo,
  onBeforeAgentStartTodo,
  onContextTodo,
  onSessionShutdown as onTodoSessionShutdown,
  onSessionStart as onTodoSessionStart,
  type TodoContext,
} from "../src/tools/todo.ts";
import type { WorkflowSnapshot } from "../src/session/types.ts";

test("session-mode flows from skill frontmatter into compiled and activation metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-skill-session-mode-"));
  const skillDir = join(root, ".pi", "skills", "demo");
  const skillPath = join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await writeFile(skillPath, skillSource("run"));
  const skill = {
    name: "demo",
    description: "session mode test",
    filePath: skillPath,
    baseDir: skillDir,
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: false,
  } satisfies Skill;
  const resourceLoader = {
    async reload() {},
    getSkills: () => ({ skills: [skill], diagnostics: [] }),
  };
  const loader = new TodoSkillLoader({ cwd: root, agentDir: join(root, "agent"), resourceLoader });

  try {
    const loaded = await loader.load({ name: "demo" });
    assert.equal(loaded.sessionMode, "run");
    assert.equal(typeof loaded.compiledKey, "string");

    const activation = await new SkillRuntime(loader).activate([{ name: "demo", role: "primary" }]);
    assert.equal(activation.bindings[0]?.sessionMode, "run");
    assert.match(activation.stackRevision, /^[a-f0-9]{64}$/);

    await writeFile(skillPath, skillSource("invalid-mode"));
    await assert.rejects(
      loader.load({ name: "demo" }),
      (error: unknown) => error instanceof TodoSkillLoadError
        && error.code === "E_SKILL_FRONTMATTER_INVALID",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint v3 preserves Workflow recovery identity across compactions", async () => {
  const workflow: WorkflowRecoveryIdentity = {
    sessionId: "workflow-session-1",
    runId: "run-003",
    todoId: "todo-003",
    stackRevision: "a".repeat(64),
    gates: { passed: 2, total: 3, failed: 1 },
    artifactRefs: ["artifact:plan", "artifact:review"],
    nextAction: "resolve GATE-003-02",
  };

  const first = await createMaestroCompaction(
    compactEvent([]),
    compactContext(),
    {
      checkpointId: () => "checkpoint-v2",
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      getWorkflowIdentity: () => workflow,
      completeSummary: checkpointSummary,
    },
  );
  const firstDetails = first?.compaction?.details as MaestroCompactionDetails;
  assert.equal(firstDetails.schemaVersion, 3);
  assert.deepEqual(firstDetails.workflow, workflow);
  assert.notEqual(firstDetails.workflow?.artifactRefs, workflow.artifactRefs);

  const second = await createMaestroCompaction(
    compactEvent([{
      type: "compaction",
      id: "checkpoint-entry-v2",
      parentId: null,
      timestamp: "2026-07-15T00:00:01.000Z",
      summary: "previous checkpoint",
      firstKeptEntryId: "kept-1",
      tokensBefore: 100,
      details: firstDetails,
    }]),
    compactContext(),
    {
      checkpointId: () => "checkpoint-v2-next",
      now: () => new Date("2026-07-15T00:00:02.000Z"),
      completeSummary: checkpointSummary,
    },
  );
  const secondDetails = second?.compaction?.details as MaestroCompactionDetails;
  assert.deepEqual(secondDetails.workflow, workflow);
  assert.equal(secondDetails.previousCheckpointId, "checkpoint-v2");

  const cleared = await createMaestroCompaction(
    compactEvent([{
      type: "compaction",
      id: "checkpoint-entry-v2",
      parentId: null,
      timestamp: "2026-07-15T00:00:03.000Z",
      summary: "previous checkpoint",
      firstKeptEntryId: "kept-1",
      tokensBefore: 100,
      details: firstDetails,
    }]),
    compactContext(),
    {
      checkpointId: () => "checkpoint-v2-cleared",
      now: () => new Date("2026-07-15T00:00:04.000Z"),
      getWorkflowIdentity: () => undefined,
      completeSummary: checkpointSummary,
    },
  );
  const clearedDetails = cleared?.compaction?.details as MaestroCompactionDetails;
  assert.equal(clearedDetails.workflow, undefined);
});

test("compaction recovery reads only the Run bound to the current Goal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-run-recovery-order-"));
  const skillDir = join(root, ".pi", "skills", "demo");
  const skillPath = join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await writeFile(skillPath, skillSource("run"));
  const skill = {
    name: "demo",
    description: "session mode test",
    filePath: skillPath,
    baseDir: skillDir,
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: false,
  } satisfies Skill;
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [skill], diagnostics: [] }) },
  });
  initTodo({ appendEntry() {} } as never);
  const todoContext: TodoContext = {
    cwd: root,
    ui: { setStatus() {} },
    skillLoader: loader,
    sessionManager: { getEntries: () => [] },
  };
  onTodoSessionStart(todoContext);
  const toolContext = { cwd: root, ui: { setStatus() {} } } as never;
  await executeTodo({ action: "create", subject: "Recover", skills: [{ name: "demo", role: "primary" }] }, toolContext);
  await executeTodo({ action: "next" }, toolContext);
  const stackRevision = getVisibleTasks()[0]?.skillActivation?.stackRevision;

  const events: string[] = [];
  const continuationPrompts: string[] = [];
  let hasPendingMessages = false;
  let markerCalls = 0;
  initGoal({
    appendEntry() {},
    sendMessage(message: { content: string; display: boolean }) {
      assert.match(message.content, /^Continue the active goal —/);
      assert.equal(message.display, false);
      events.push("continuation");
      continuationPrompts.push(message.content);
    },
  } as never);
  const goalContext: GoalContext = {
    cwd: root,
    ui: { notify() {}, setStatus() {} },
    sessionManager: { getEntries: () => [] },
    isIdle: () => false,
    hasPendingMessages: () => hasPendingMessages,
  };
  await onGoalSessionStart(goalContext);
  const snapshot = recoverySnapshot();
  setWorkflowCoordinator({
    status: () => snapshot,
    async brief() {
      events.push("brief");
      return {};
    },
    continuationMarker: () => {
      markerCalls++;
      return "workflow-session-1:run-003:1:1";
    },
    acceptsContinuation: () => true,
  } as never);

  try {
    const created = await executeGoal({ action: "create", objective: "Independent compaction recovery" }, goalContext);
    assert.equal(created.isError, false, created.text);
    assert.equal(getActiveGoal()?.status, "active");
    await onGoalCompact({}, goalContext);
    assert.equal(markerCalls, 0);
    assert.deepEqual(events, ["continuation"]);
    assert.doesNotMatch(continuationPrompts[0] ?? "", /<active_run/);

    await executeGoalCommand({ action: "clear" }, goalContext);
    events.length = 0;
    continuationPrompts.length = 0;
    reconcileWorkflowGoal(snapshot, goalContext);
    await onGoalCompact({}, goalContext);
    assert.equal(markerCalls, 1);
    assert.deepEqual(events, ["brief", "continuation"]);
    assert.match(continuationPrompts[0] ?? "", /<active_run id="run-003">/);

    events.length = 0;
    await onGoalCompact({ willRetry: true }, goalContext);
    assert.deepEqual(events, ["brief"], "Pi retry must reacquire the active Run brief before retrying");

    events.length = 0;
    hasPendingMessages = true;
    await onGoalCompact({}, goalContext);
    assert.deepEqual(events, ["brief"], "queued continuation must still be fenced by a fresh Run brief");
    hasPendingMessages = false;

    assert.equal(onBeforeAgentStartTodo(), undefined);
    const injected = await onContextTodo([]);
    const injectedContent = String((injected?.messages[0] as { content?: string } | undefined)?.content ?? "");
    assert.equal(injectedContent.match(/<active_skill_stack>/g)?.length, 1);
    assert.equal(getVisibleTasks()[0]?.skillActivation?.stackRevision, stackRevision);
  } finally {
    setWorkflowCoordinator(undefined);
    await executeGoalCommand({ action: "clear" }, goalContext);
    onGoalSessionShutdown(goalContext);
    onTodoSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

function recoverySnapshot(): WorkflowSnapshot {
  return {
    source: "canonical",
    projectRoot: "D:/workspace",
    loadedAt: "2026-07-15T00:00:00.000Z",
    revision: { sessionRevision: 1, fingerprint: "recovery" },
    sessionGeneration: "canonical:valid:workflow-session-1:1",
    canonicalClaim: { activeSessionId: "workflow-session-1", status: "valid" },
    diagnostics: [],
    session: {
      sessionId: "workflow-session-1",
      intent: "Recover the active Run",
      status: "running",
      revision: 1,
      activeRunId: "run-003",
      definitionOfDone: "Run is sealed",
      gates: [],
      chain: [{ step: "execute", command: "execute", status: "running", runId: "run-003" }],
      runs: [{
        runId: "run-003",
        parentRunId: null,
        command: "execute",
        status: "running",
        goal: "Execute",
        args: [],
        gates: [],
        primaryArtifactId: null,
        handoff: null,
        startedAt: "2026-07-15T00:00:00.000Z",
        endedAt: null,
      }],
      artifacts: [],
      aliases: {},
    },
  };
}

function skillSource(sessionMode: string): string {
  return `---\nname: demo\ndescription: session mode test\nsession-mode: ${sessionMode}\n---\n# Demo`;
}

function compactEvent(branchEntries: unknown[]): Parameters<typeof createMaestroCompaction>[0] {
  return {
    preparation: {
      firstKeptEntryId: "kept-1",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 100,
      fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
      settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 },
    },
    branchEntries,
    signal: new AbortController().signal,
    type: "session_before_compact",
  } as unknown as Parameters<typeof createMaestroCompaction>[0];
}

function compactContext(): Parameters<typeof createMaestroCompaction>[1] {
  return {
    cwd: "D:\\repo",
    model: { id: "faux", maxTokens: 2000 },
    sessionManager: { getSessionId: () => "host-session-1" },
  } as unknown as Parameters<typeof createMaestroCompaction>[1];
}

async function checkpointSummary() {
  return {
    stopReason: "stop",
    content: [{ type: "text", text: "## Session\n- Current Objective: recover safely" }],
  };
}
