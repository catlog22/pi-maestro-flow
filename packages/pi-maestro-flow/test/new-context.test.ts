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
  blocksNativeCompactionFallback,
  CompactionArbiter,
  compactionRequestFromInstructions,
} from "../src/compaction/compaction-arbiter.ts";
import {
  createMaestroCompaction,
  type MaestroCompactionDetails,
  type MaestroRecoveryState,
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
    assert.equal(await controller.onAgentSettled(harness.ctx as never), true);

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

test("child new-context publishes recovery phases and cancellation without reporting failure", async () => {
  const fixture = await enabledProject();
  const previousChild = process.env.PI_TEAMMATE_CHILD;
  const previousCorrelation = process.env.PI_TEAMMATE_CORRELATION_ID;
  const originalSend = process.send;
  const events: Array<Record<string, unknown>> = [];
  process.env.PI_TEAMMATE_CHILD = "1";
  process.env.PI_TEAMMATE_CORRELATION_ID = "new-context-relay-test";
  Object.defineProperty(process, "send", {
    configurable: true,
    writable: true,
    value: (message: Record<string, unknown>) => {
      events.push(message);
      return true;
    },
  });

  try {
    const arbiter = new CompactionArbiter();
    const controller = createNewContextController(arbiter);
    const harness = context(fixture.cwd);
    controller.onSessionStart(harness.ctx as never);
    const first = controller.schedule({ source: "tool", actorId: "child" }, harness.ctx as never);
    assert.equal(await controller.onAgentSettled(harness.ctx as never), true);
    const request = compactionRequestFromInstructions(harness.compactOptions?.customInstructions);
    const observed = arbiter.observeStart(request);
    assert.ok(observed.trigger);
    controller.consume(observed.trigger!, harness.ctx as never);
    harness.compactOptions?.onComplete?.();

    const pending = controller.schedule({ source: "tool", actorId: "child" }, harness.ctx as never);
    assert.equal(pending.requestId, first.requestId + 1);
    const pendingMessageContext = { ...harness.ctx, hasPendingMessages: () => true };
    assert.equal(await controller.onAgentSettled(pendingMessageContext as never), false);

    assert.deepEqual(events.map((event) => event.phase), [
      "pending", "completed", "continuation", "pending", "cancelled",
    ]);
    assert.ok(events.every((event) => event.type === "teammate_compaction_state"));
    assert.ok(events.every((event) => event.correlationId === "new-context-relay-test"));
    assert.equal(events[0]?.generation, first.requestId);
    assert.equal(events[3]?.generation, pending.requestId);
  } finally {
    await fixture.dispose();
    if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previousChild;
    if (previousCorrelation === undefined) delete process.env.PI_TEAMMATE_CORRELATION_ID;
    else process.env.PI_TEAMMATE_CORRELATION_ID = previousCorrelation;
    if (originalSend === undefined) delete (process as { send?: typeof process.send }).send;
    else Object.defineProperty(process, "send", { configurable: true, writable: true, value: originalSend });
  }
});

test("new-context cancels a pending reset when a newer message is queued", async () => {
  const fixture = await enabledProject();
  try {
    const controller = createNewContextController(new CompactionArbiter());
    const harness = context(fixture.cwd);
    controller.onSessionStart(harness.ctx as never);
    controller.schedule({ source: "tool", actorId: "root" }, harness.ctx as never);

    const pendingMessageContext = {
      ...harness.ctx,
      hasPendingMessages: () => true,
    };
    assert.equal(await controller.onAgentSettled(pendingMessageContext as never), false);
    assert.equal(controller.hasPending(), false);
    assert.equal(harness.compactOptions, undefined);
    assert.match(harness.notifications.join("\n"), /newer message is pending/);
    assert.match(harness.notifications.join("\n"), /continuing with the current context/);
  } finally {
    await fixture.dispose();
  }
});

test("new-context keeps pending across active owners and retries after settlement", async () => {
  const fixture = await enabledProject();
  try {
    const arbiter = new CompactionArbiter();
    const controller = createNewContextController(arbiter);
    const harness = context(fixture.cwd);
    controller.onSessionStart(harness.ctx as never);
    const native = arbiter.observeStart(undefined);
    assert.equal(native.allowed, true);
    controller.schedule({ source: "tool", actorId: "root" }, harness.ctx as never);
    assert.equal(await controller.onAgentSettled(harness.ctx as never), false);
    assert.equal(controller.hasPending(), true, "active-owner denial must not consume the request");
    assert.equal(harness.compactOptions, undefined);

    native.finalize("success");
    assert.equal(await controller.onAgentSettled(harness.ctx as never), true);
    const request = compactionRequestFromInstructions(harness.compactOptions?.customInstructions);
    assert.deepEqual(request, { owner: "new-context", id: 2 });
    const observed = arbiter.observeStart(request);
    assert.equal(observed.allowed, true);
    if (observed.trigger?.owner !== "new-context") assert.fail("missing new-context trigger");
    assert.ok(controller.consume(observed.trigger, harness.ctx as never));
    harness.compactOptions?.onComplete?.();
    assert.equal(await controller.onAgentSettled(harness.ctx as never), false, "a consumed request cannot start twice");
  } finally {
    await fixture.dispose();
  }
});

test("new-context tombstone waits for explicit host settlement acknowledgement", async () => {
  const fixture = await enabledProject();
  try {
    const arbiter = new CompactionArbiter(100);
    const controller = createNewContextController(arbiter);
    const harness = context(fixture.cwd);
    controller.onSessionStart(harness.ctx as never);
    arbiter.observeStart(undefined);
    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.ok(arbiter.timeoutTombstone());
    controller.schedule({ source: "tool", actorId: "root" }, harness.ctx as never);
    assert.equal(await controller.onAgentSettled(harness.ctx as never), false);
    assert.equal(controller.hasPending(), true);
    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.equal(await controller.onAgentSettled(harness.ctx as never), false, "elapsed time alone must not prove settlement");
    assert.equal(harness.compactOptions, undefined);
    arbiter.complete("success");
    assert.equal(await controller.onCompactionSettled(harness.ctx as never), true);
    const request = compactionRequestFromInstructions(harness.compactOptions?.customInstructions);
    if (!request || request.owner !== "new-context") assert.fail("missing acknowledged new-context lease");
    const observed = arbiter.observeStart(request);
    assert.ok(controller.consume(observed.trigger!, harness.ctx as never));
    harness.compactOptions?.onComplete?.();
  } finally {
    await fixture.dispose();
  }
});

test("new-context drops stale error callbacks after a session generation change", async () => {
  const fixture = await enabledProject();
  try {
    let continuations = 0;
    const controller = createNewContextController(new CompactionArbiter(), {
      continueAfterReset: () => { continuations += 1; },
    });
    const harness = context(fixture.cwd);
    controller.onSessionStart(harness.ctx as never);
    controller.schedule({ source: "tool", actorId: "root" }, harness.ctx as never);
    assert.equal(await controller.onAgentSettled(harness.ctx as never), true);
    controller.onSessionStart({ sessionManager: { getSessionId: () => "session-2" } } as never);
    harness.compactOptions?.onError?.(new Error("late session-1 failure"));
    assert.equal(continuations, 0);
    assert.doesNotMatch(harness.notifications.join("\n"), /late session-1 failure/);
  } finally {
    await fixture.dispose();
  }
});

test("new-context post-refresh denial still coalesces an equivalent Plan handoff", async () => {
  const fixture = await enabledProject();
  try {
    const runtime = details([task({ id: "1", subject: "active", status: "in_progress" })]);
    const arbiter = new CompactionArbiter();
    let planLease: ReturnType<CompactionArbiter["request"]> | undefined;
    const controller = createNewContextController(arbiter, {
      refreshRecoveryState: async () => {
        planLease = arbiter.request("plan-handoff", { owner: "plan-handoff", reason: "clean-context" });
        return runtime;
      },
    });
    const harness = context(fixture.cwd);
    controller.onSessionStart(harness.ctx as never);
    controller.schedule({ source: "tool", actorId: "child" }, harness.ctx as never);
    assert.equal(await controller.onAgentSettled(harness.ctx as never), false);
    assert.equal(controller.hasPending(), false);
    assert.match(harness.notifications.join("\n"), /equivalent deterministic Plan/);
    planLease?.release();
  } finally {
    await fixture.dispose();
  }
});

test("new-context recovery policy blocks native model summarization fallback", () => {
  assert.equal(blocksNativeCompactionFallback({ owner: "new-context", requestId: 1, source: "tool" }), true);
  assert.equal(blocksNativeCompactionFallback({
    owner: "mid-turn",
    recovery: "provider-pressure",
    estimatedTokens: 100,
    contextWindow: 100,
    effectiveThresholdTokens: 90,
    configuredThresholdTokens: 90,
    effectiveReserveTokens: 10,
    configuredReserveTokens: 10,
    reason: "configured",
  }), true);
  assert.equal(blocksNativeCompactionFallback({ owner: "plan-handoff", reason: "clean-context" }), false);
});

test("child recovery state refresh happens at lease time and fails closed", async () => {
  const fixture = await enabledProject();
  try {
    const runtime = details([task({ id: "1", subject: "active", status: "in_progress" })]);
    const refreshed: MaestroRecoveryState = {
      todo: { ...runtime.todo, revision: 27 },
      goal: runtime.goal!,
      plan: runtime.plan!,
      workflow: runtime.workflow,
    };
    let refreshCalls = 0;
    const arbiter = new CompactionArbiter();
    const controller = createNewContextController(arbiter, {
      refreshRecoveryState: async () => {
        refreshCalls += 1;
        return refreshed;
      },
    });
    const harness = context(fixture.cwd);
    controller.onSessionStart(harness.ctx as never);
    controller.schedule({ source: "tool", actorId: "child", recoveryState: runtime }, harness.ctx as never);
    assert.equal(await controller.onAgentSettled(harness.ctx as never), true);
    assert.equal(refreshCalls, 1);
    const request = compactionRequestFromInstructions(harness.compactOptions?.customInstructions);
    if (!request || request.owner !== "new-context") assert.fail("missing refreshed new-context lease");
    const observed = arbiter.observeStart(request);
    const consumed = controller.consume(observed.trigger!, harness.ctx as never);
    assert.equal(consumed?.recoveryState?.todo.revision, 27);
    harness.compactOptions?.onError?.(new Error("test cleanup"));

    const failedHarness = context(fixture.cwd, "session-2");
    const failed = createNewContextController(new CompactionArbiter(), {
      refreshRecoveryState: async () => undefined,
    });
    failed.onSessionStart(failedHarness.ctx as never);
    failed.schedule({ source: "tool", actorId: "child" }, failedHarness.ctx as never);
    assert.equal(await failed.onAgentSettled(failedHarness.ctx as never), false);
    assert.equal(failed.hasPending(), false);
    assert.equal(failedHarness.compactOptions, undefined);
    assert.match(failedHarness.notifications.join("\n"), /could not refresh root recovery state/);
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
    assert.equal(await controller.onAgentSettled(harness.ctx as never), false);
    assert.equal(harness.compactOptions, undefined);
    assert.match(harness.notifications.join("\n"), /equivalent deterministic Plan/);
    assert.equal(controller.hasPending(), false);
    planLease.release();

    controller.schedule({ source: "tool", actorId: "root" }, harness.ctx as never);
    const preservingPlan = arbiter.request("plan-handoff", { owner: "plan-handoff", reason: "preserve-approved-plan" });
    assert.ok(preservingPlan);
    assert.equal(await controller.onAgentSettled(harness.ctx as never), false);
    assert.equal(controller.hasPending(), true);
    assert.match(harness.notifications.join("\n"), /deferred until the active Plan compaction settles/);
    preservingPlan.release();
    assert.equal(await controller.onAgentSettled(harness.ctx as never), true);
    harness.compactOptions?.onError?.(new Error("test cleanup"));

    controller.schedule({ source: "tool", actorId: "root", carryForward: "payload must survive" }, harness.ctx as never);
    const payloadPlan = arbiter.request("plan-handoff", { owner: "plan-handoff", reason: "clean-context" });
    assert.ok(payloadPlan);
    assert.equal(await controller.onAgentSettled(harness.ctx as never), false);
    assert.equal(controller.hasPending(), true, "Plan coalescing must preserve requests with unique payload");
    payloadPlan.release();
    assert.equal(await controller.onAgentSettled(harness.ctx as never), true);
    const payloadRequest = compactionRequestFromInstructions(harness.compactOptions?.customInstructions);
    if (!payloadRequest || payloadRequest.owner !== "new-context") assert.fail("missing payload new-context lease");
    const payloadObserved = arbiter.observeStart(payloadRequest);
    assert.ok(controller.consume(payloadObserved.trigger!, harness.ctx as never)?.carryForward);
    harness.compactOptions?.onError?.(new Error("test cleanup"));

    controller.schedule({ source: "tool", actorId: "root" }, harness.ctx as never);
    controller.onSessionStart({ sessionManager: { getSessionId: () => "session-2" } } as never);
    assert.equal(controller.hasPending(), false);
  } finally {
    await fixture.dispose();
  }
});

test("new_context guidance uses Todo checkpoints and pressure only for urgency", () => {
  const tool = createNewContextTool(
    createNewContextController(new CompactionArbiter()),
    "root",
  );
  assert.match(tool.description, /completed Todo checkpoint/);
  const guidance = tool.promptGuidelines.join("\\n");
  assert.match(guidance, /primary semantic reset/);
  assert.match(guidance, /critical prioritizes it before the next Todo/);
  assert.match(guidance, /do not interrupt the task merely because pressure rises/);
  assert.match(guidance, /Do not emit or infer pressure-driven reminders without a Todo completion checkpoint/);
});

test("standalone new_context fails closed while the config gate is disabled", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "maestro-new-context-disabled-"));
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
      compaction: { newContext: { enabled: false } },
    }));
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

test("standalone new_context guidance treats Todo pressure as a post-advance decision", () => {
  const tool = createNewContextTool(createNewContextController(new CompactionArbiter()), "root");
  const guidance = tool.promptGuidelines?.join("\n") ?? "";
  assert.match(guidance, /pressure advisory arrives only after its completion-form advance has committed/);
  assert.match(guidance, /task activated in that same result/);
  assert.match(guidance, /call this standalone tool/);
  assert.match(guidance, /Never treat the advisory as a retroactive transition/);
  assert.match(guidance, /critical prioritizes it before the next Todo/);
  assert.doesNotMatch(guidance, /do not reset when it reports critical pressure/);
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
  assert.match(capsule, /compact_history/);
  assert.doesNotMatch(capsule, /session_history/);
  assert.match(capsule, /<recovery_capsule version="2">/);
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
