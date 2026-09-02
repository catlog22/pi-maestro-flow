import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildNewContextRecoveryCapsule,
  createNewContextController,
  NEW_CONTEXT_MAX_BYTES,
  newContextFirstKeptEntryId,
} from "../src/compaction/new-context.ts";
import {
  CompactionArbiter,
  compactionRequestFromInstructions,
} from "../src/compaction/compaction-arbiter.ts";
import {
  createMaestroCompaction,
  type MaestroCompactionDetails,
} from "../src/compaction/maestro-compaction.ts";
import type { TodoTask } from "../src/tools/todo.ts";
import { createNewContextTool } from "../src/tools/new-context.ts";

async function enabledProject(): Promise<{ cwd: string; dispose(): Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), "maestro-new-context-"));
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
    compaction: { newContext: { enabled: true } },
  }));
  return { cwd, dispose: () => rm(cwd, { recursive: true, force: true }) };
}

function context(cwd: string, sessionId = "session-1") {
  const notifications: string[] = [];
  let compactOptions: {
    customInstructions?: string;
    onComplete?: () => void;
    onError?: (error: Error) => void;
  } | undefined;
  return {
    notifications,
    get compactOptions() { return compactOptions; },
    ctx: {
      cwd,
      sessionManager: { getSessionId: () => sessionId },
      ui: { notify(message: string) { notifications.push(message); } },
      compact(options: typeof compactOptions) { compactOptions = options; },
    },
  };
}

function task(input: Partial<TodoTask> & Pick<TodoTask, "id" | "subject" | "status">): TodoTask {
  return {
    id: input.id,
    subject: input.subject,
    status: input.status,
    blockedBy: input.blockedBy ?? [],
    skills: input.skills ?? [],
    resourceUris: input.resourceUris ?? [],
    createdBy: input.createdBy ?? { kind: "root", id: "root", label: "root" },
    assignee: input.assignee ?? { kind: "root", id: "root", label: "root" },
    createdAt: input.createdAt ?? 1,
    updatedAt: input.updatedAt ?? 1,
    ...input,
  };
}

function details(tasks: TodoTask[] = []): MaestroCompactionDetails {
  return {
    kind: "maestro-session-checkpoint",
    schemaVersion: 4,
    checkpointId: "checkpoint-2",
    previousCheckpointId: "checkpoint-1",
    sessionId: "session-1",
    projectRoot: "D:/repo",
    createdAt: "2026-09-01T00:00:00.000Z",
    workflow: {
      sessionId: "workflow-1",
      runId: "run-1",
      gates: { passed: 1, total: 2, failed: 0 },
      artifactRefs: [],
      nextAction: "run check",
    },
    todo: { stateVersion: 6, revision: 9, tasks },
    goal: {
      stateVersion: 2,
      currentGoalId: "goal-1",
      goals: [{
        id: "goal-1",
        objective: "Ship the bounded reset",
        status: "active",
        iteration: 1,
        tokensUsed: 100,
        acceptance: ["Focused tests pass"],
      }],
    },
    plan: {
      mode: "act",
      status: "approved",
      revision: 3,
      handoffStatus: "ready",
      handoffKey: "handoff-1",
      path: "D:/plans/current.md",
    },
    activeSkills: [],
    references: [{
      path: "D:/repo/reference.md",
      role: "read",
      status: "active",
      firstSeenCompaction: "checkpoint-1",
      lastConfirmedCompaction: "checkpoint-2",
    }],
    knowhowPath: "D:/repo/knowhow.md",
    newContext: {
      requestId: 1,
      source: "tool",
      carryForward: "Continue with focused verification.",
      resourceUris: ["agent://publication-1"],
    },
    trigger: { owner: "new-context", requestId: 1, source: "tool" },
  };
}

test("new-context scheduler coalesces same-actor inputs and consumes only its fenced request at settle", async () => {
  const fixture = await enabledProject();
  try {
    const arbiter = new CompactionArbiter();
    let continuations = 0;
    const controller = createNewContextController(arbiter, {
      continueAfterReset() { continuations += 1; },
    });
    const harness = context(fixture.cwd);
    controller.onSessionStart(harness.ctx as never);

    const first = controller.schedule({
      source: "tool",
      actorId: "root",
      carryForward: "first",
      resourceUris: ["agent://one"],
    }, harness.ctx as never);
    const second = controller.schedule({
      source: "tool",
      actorId: "root",
      carryForward: "replacement",
      resourceUris: ["agent://two", "agent://one"],
    }, harness.ctx as never);
    assert.equal(second.requestId, first.requestId);
    assert.equal(second.coalesced, true);
    assert.equal(controller.onAgentSettled(harness.ctx as never), true);

    const request = compactionRequestFromInstructions(harness.compactOptions?.customInstructions);
    assert.deepEqual(request, { owner: "new-context", id: 1 });
    const observed = arbiter.observeStart(request);
    assert.equal(observed.trigger?.owner, "new-context");
    if (observed.trigger?.owner !== "new-context") assert.fail("missing new-context trigger");
    const consumed = controller.consume(observed.trigger, harness.ctx as never);
    assert.equal(consumed?.carryForward, "replacement");
    assert.deepEqual(consumed?.resourceUris, ["agent://one", "agent://two"]);
    assert.equal(controller.consume(observed.trigger, harness.ctx as never), undefined);
    harness.compactOptions?.onComplete?.();
    assert.equal(continuations, 1);
    assert.equal(arbiter.currentOwner(), undefined);
  } finally {
    await fixture.dispose();
  }
});

test("new-context scheduler is actor/session fenced and Plan handoff ownership wins", async () => {
  const fixture = await enabledProject();
  try {
    const arbiter = new CompactionArbiter();
    const controller = createNewContextController(arbiter);
    const harness = context(fixture.cwd);
    controller.onSessionStart(harness.ctx as never);
    controller.schedule({ source: "tool", actorId: "root" }, harness.ctx as never);
    assert.throws(
      () => controller.schedule({ source: "tool", actorId: "other" }, harness.ctx as never),
      /another actor or session generation/,
    );
    const planLease = arbiter.request("plan-handoff", { owner: "plan-handoff", reason: "clean-context" });
    assert.ok(planLease);
    assert.equal(controller.onAgentSettled(harness.ctx as never), false);
    assert.equal(harness.compactOptions, undefined);
    assert.match(harness.notifications.join("\n"), /equivalent deterministic Plan/);
    assert.equal(controller.hasPending(), false);
    planLease.release();

    controller.schedule({ source: "tool", actorId: "root" }, harness.ctx as never);
    const preservingPlan = arbiter.request("plan-handoff", { owner: "plan-handoff", reason: "preserve-approved-plan" });
    assert.ok(preservingPlan);
    assert.equal(controller.onAgentSettled(harness.ctx as never), false);
    assert.equal(controller.hasPending(), true);
    assert.match(harness.notifications.join("\n"), /deferred until the active Plan compaction settles/);
    preservingPlan.release();
    assert.equal(controller.onAgentSettled(harness.ctx as never), true);
    harness.compactOptions?.onError?.(new Error("test cleanup"));

    controller.schedule({ source: "tool", actorId: "root" }, harness.ctx as never);
    controller.onSessionStart({ sessionManager: { getSessionId: () => "session-2" } } as never);
    assert.equal(controller.hasPending(), false);
  } finally {
    await fixture.dispose();
  }
});

test("standalone new_context fails closed while the config gate is disabled", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "maestro-new-context-disabled-"));
  try {
    const controller = createNewContextController(new CompactionArbiter());
    const harness = context(cwd);
    controller.onSessionStart(harness.ctx as never);
    const tool = createNewContextTool(controller, "root");
    const execute = tool.execute! as unknown as (
      id: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: undefined,
      ctx: unknown,
    ) => Promise<{ isError?: boolean; details?: { scheduled?: boolean }; content: Array<{ type: string; text?: string }> }>;
    const result = await execute("call-1", {}, new AbortController().signal, undefined, harness.ctx);
    assert.equal(result.isError, true);
    assert.equal(result.details?.scheduled, false);
    assert.match(result.content[0]?.text ?? "", /disabled/);
    assert.equal(controller.hasPending(), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("recovery capsule is deterministic, priority ordered, bounded, and includes recovery identities", () => {
  const runtime = details([
    task({ id: "2", subject: "teammate active", status: "in_progress", assignee: { kind: "teammate", id: "a", label: "agent" }, context: "next child action" }),
    task({ id: "1", subject: "root active", status: "in_progress", context: "next root action", resourceUris: ["session://session-1/entry/e1"] }),
    task({ id: "3", subject: "runnable", status: "pending" }),
    task({ id: "4", subject: "blocked", status: "blocked", blockedBy: ["3"] }),
    task({ id: "5", subject: "completed", status: "completed", summary: "verified", completedAt: 10 }),
  ]);
  const capsule = buildNewContextRecoveryCapsule(runtime);
  assert.equal(capsule, buildNewContextRecoveryCapsule(runtime));
  assert.ok(Buffer.byteLength(capsule, "utf8") <= NEW_CONTEXT_MAX_BYTES);
  assert.ok(capsule.indexOf("[#1] root active") < capsule.indexOf("[#2] teammate active"));
  assert.match(capsule, /Workflow Session: workflow-1/);
  assert.match(capsule, /Handoff Key: handoff-1/);
  assert.match(capsule, /agent:\/\/publication-1/);
  assert.match(capsule, /session_history/);
  assert.match(capsule, /<recovery_capsule version="1">/);
  assert.ok(capsule.endsWith("</recovery_capsule>"));

  const manyActive = details(Array.from({ length: 8 }, (_, index) => task({
    id: `actor-${index}`,
    subject: `active actor ${index}`,
    status: "in_progress",
    context: "next action ".repeat(500),
    assignee: index === 0
      ? { kind: "root", id: "root", label: "root" }
      : { kind: "teammate", id: `agent-${index}`, label: `agent-${index}` },
    updatedAt: 100 - index,
  })));
  const allActors = buildNewContextRecoveryCapsule(manyActive);
  for (let index = 0; index < 8; index++) assert.match(allActors, new RegExp(`\\[#actor-${index}\\]`));
  assert.match(allActors, /active=0,/);

  const oversized = details(Array.from({ length: 40 }, (_, index) => task({
    id: String(index + 1),
    subject: `active-${index}`,
    status: "in_progress",
    context: "🧭".repeat(2_000),
    updatedAt: 100 - index,
  })));
  oversized.newContext!.resourceUris = Array.from(
    { length: 16 },
    (_, index) => `agent://${index}-${"é".repeat(900)}`,
  );
  oversized.references = Array.from({ length: 20 }, (_, index) => ({
    path: `D:/repo/${index}-${"文".repeat(500)}`,
    role: "read" as const,
    status: "active" as const,
    firstSeenCompaction: "checkpoint-1",
    lastConfirmedCompaction: "checkpoint-2",
  }));
  const bounded = buildNewContextRecoveryCapsule(oversized);
  assert.ok(Buffer.byteLength(bounded, "utf8") <= NEW_CONTEXT_MAX_BYTES);
  assert.ok(bounded.endsWith("</recovery_capsule>"));
  assert.match(bounded, /active=0,/);
  for (let index = 0; index < 40; index++) assert.match(bounded, new RegExp(`\\[#${index + 1}\\]`));
  assert.match(bounded, /transitionResources=[1-9]\d*/);
});

test("deterministic new-context compaction bypasses the model summary and drops the old recent boundary", async () => {
  let summarizerCalled = false;
  const runtime = details([task({ id: "1", subject: "active", status: "in_progress", context: "continue" })]);
  const request = {
    requestId: 1,
    source: "tool" as const,
    actorId: "root",
    lifecycleGeneration: 3,
    sessionId: "session-1",
    todoRevision: 9,
    resourceUris: ["agent://publication-1"],
  };
  const result = await createMaestroCompaction(
    {
      preparation: {
        firstKeptEntryId: "old-recent-entry",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 1_200,
        fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
        settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
      },
      branchEntries: [],
      customInstructions: "new context",
    } as never,
    {
      cwd: "D:/repo",
      model: undefined,
      sessionManager: { getSessionId: () => "session-1" },
      ui: { notify() {} },
    } as never,
    {
      checkpointId: () => "child-checkpoint",
      now: () => new Date("2026-09-01T00:00:00.000Z"),
      recoveryState: {
        todo: runtime.todo,
        goal: runtime.goal!,
        plan: runtime.plan!,
        workflow: runtime.workflow,
      },
      newContext: runtime.newContext,
      summaryOverrideFactory: buildNewContextRecoveryCapsule,
      firstKeptEntryIdOverride: newContextFirstKeptEntryId(request),
      completeSummary: async () => {
        summarizerCalled = true;
        return { content: [] };
      },
      failClosed: true,
    },
  );
  assert.equal(summarizerCalled, false);
  assert.equal(result?.compaction?.firstKeptEntryId, "maestro-new-context-3-1");
  assert.match(result?.compaction?.summary ?? "", /New Context Recovery Capsule/);
  const captured = result?.compaction?.details as MaestroCompactionDetails;
  assert.equal(captured.schemaVersion, 4);
  assert.equal(captured.todo.revision, 9);
  assert.equal(captured.goal?.currentGoalId, "goal-1");
  assert.equal(captured.plan?.handoffKey, "handoff-1");
  assert.equal(captured.workflow?.sessionId, "workflow-1");
});
