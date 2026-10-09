import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNewContextContinuation,
  describeNewContextRecoveryFocus,
  type RecoveryFocusInput,
} from "../src/compaction/recovery-focus.ts";

type Task = RecoveryFocusInput["todo"]["tasks"][number];
type Goal = NonNullable<RecoveryFocusInput["goal"]>["goals"][number];

function task(id: string, status: Task["status"], overrides: Partial<Task> = {}): Task {
  return {
    id,
    status,
    subject: `Task ${id}`,
    blockedBy: [],
    skills: [],
    resourceUris: [],
    createdBy: { kind: "root", id: "root", label: "root" },
    assignee: { kind: "root", id: "root", label: "root" },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function input(tasks: Task[] = [], actorId = "root"): RecoveryFocusInput {
  return {
    todo: { stateVersion: 6, revision: 1, tasks },
    plan: { mode: "act", status: "approved", revision: 3, handoffStatus: "todo-required", handoffKey: "approval-3", checksum: "checksum-3", path: "/plans/approvals/3.md" },
    newContext: {
      requestId: 1,
      source: "tool",
      actorId,
      resourceUris: [],
      plan: { status: "approved", revision: 3, handoffKey: "approval-3", checksum: "checksum-3", path: "/plans/approvals/3.md", markdown: "FULL_PLAN_BODY_MUST_NOT_BE_EMBEDDED" },
    },
  };
}

function withGoal(value: RecoveryFocusInput, overrides: Partial<Goal> = {}): RecoveryFocusInput {
  value.goal = {
    stateVersion: 2,
    currentGoalId: "goal-1",
    goals: [{ id: "goal-1", objective: "GOAL_OBJECTIVE_NOT_REQUIRED", status: "active", iteration: 2, tokensUsed: 100, ...overrides }],
  };
  return value;
}

function withWorkflow(value: RecoveryFocusInput, todoId?: string): RecoveryFocusInput {
  value.workflow = { sessionId: "session-1", runId: "run-1", todoId, gates: { passed: 1, total: 2, failed: 0 }, artifactRefs: [], nextAction: "run brief run-1" };
  return value;
}

function text(value: RecoveryFocusInput): string {
  return describeNewContextRecoveryFocus(value).lines.join("\n");
}

const child = { kind: "teammate" as const, id: "child-1", label: "child-1" };

test("first decomposition reloads and verifies the exact approved snapshot, not the full body", () => {
  const value = input();
  const focus = describeNewContextRecoveryFocus(value);
  assert.equal(focus.kind, "plan-decomposition");
  assert.match(text(value), /read the exact approved snapshot and verify revision, handoff key, checksum/);
  assert.match(text(value), /existing task bindings against live state/);
  assert.match(text(value), /\/plans\/approvals\/3.md/);
  assert.match(text(value), /checksum-3/);
  assert.match(text(value), /plan-decompose/);
  assert.match(text(value), /existing execution authorization/);
  assert.doesNotMatch(text(value), /FULL_PLAN_BODY/);
});

test("approved todo-required after all bound tasks completed is reference, not first decomposition", () => {
  const value = withGoal(input([task("1", "completed", { planHandoffKey: "approval-3" })]));
  assert.equal(describeNewContextRecoveryFocus(value).kind, "reference");
  assert.match(text(value), /All Todos bound to this Plan are completed/);
  assert.match(text(value), /do not re-decompose or infer Goal completion/);
});

test("deleted bound task history also prevents duplicate decomposition", () => {
  const value = input([task("1", "deleted", { planHandoffKey: "approval-3" })]);
  assert.equal(describeNewContextRecoveryFocus(value).kind, "reference");
  assert.match(text(value), /already has bound Todos/);
});

test("owned runnable pending task is prepared instead of repeating decomposition", () => {
  const value = input([task("1", "pending", { planHandoffKey: "approval-3" })]);
  assert.equal(describeNewContextRecoveryFocus(value).kind, "todo-pending");
  assert.match(text(value), /Prepare pending Todo #1/);
  assert.match(text(value), /Activate this owned runnable Todo/);
  assert.match(text(value), /do not create duplicate tasks/);
});

test("completed dependencies make a pending Todo runnable", () => {
  const value = input([task("1", "completed"), task("2", "pending", { blockedBy: ["1"], planHandoffKey: "approval-3" })]);
  assert.equal(describeNewContextRecoveryFocus(value).kind, "todo-pending");
  assert.match(text(value), /Prepare pending Todo #2/);
});

test("incomplete or unknown dependencies preserve blockers without a new decomposition", () => {
  for (const dependency of [task("1", "pending"), task("1", "deleted")]) {
    const value = input([dependency, task("2", "in_progress", { blockedBy: ["1", "unknown"], context: "Waiting for external credentials", planHandoffKey: "approval-3" })]);
    assert.equal(describeNewContextRecoveryFocus(value).kind, "blocked");
    assert.match(text(value), /blocked by #1, #unknown/);
    assert.match(text(value), /Waiting for external credentials/);
    assert.match(text(value), /do not bypass dependencies/);
  }
});

test("explicit blocked status remains blocked even without a dependency edge", () => {
  const value = input([task("1", "blocked", { context: "Waiting for user decision", planHandoffKey: "approval-3" })]);
  assert.equal(describeNewContextRecoveryFocus(value).kind, "blocked");
  assert.match(text(value), /Waiting for user decision/);
  assert.match(text(value), /report it; do not invent work/);
});

test("auxiliary blocker recovery preserves gates, failure budgets and actor ownership", () => {
  for (const actor of ["root", "child-1"]) {
    const assignee = actor === "root" ? { kind: "root" as const, id: "root", label: "root" } : child;
    for (const status of ["in_progress", "blocked"] as const) {
      const dependencyOwner = actor === "root" ? child : { kind: "root" as const, id: "root", label: "root" };
      const value = input([task("1", "pending", { assignee: dependencyOwner }), task("2", status, { assignee, blockedBy: ["1"], planHandoffKey: "approval-3" })], actor);
      const before = structuredClone(value);
      const focus = describeNewContextRecoveryFocus(value);
      assert.equal(focus.kind, "blocked");
      assert.match(focus.lines.join("\n"), /dependency's necessity and any simpler equivalent option/);
      assert.match(focus.lines.join("\n"), /keep the block until resolved through the authorized lifecycle/);
      assert.match(focus.lines.join("\n"), /budgets remain cumulative across workers and resets/);
      assert.deepEqual(value, before);
    }
  }
});

test("active auxiliary work recovery reports alternatives without restarting the Plan", () => {
  for (const actor of ["root", "child-1"]) {
    const assignee = actor === "root" ? { kind: "root" as const, id: "root", label: "root" } : child;
    const value = input([task("1", "in_progress", { assignee, planHandoffKey: "approval-3" })], actor);
    assert.equal(describeNewContextRecoveryFocus(value).kind, "todo-active");
    assert.match(text(value), /Carry cumulative failed-attempt budgets across workers and resets/);
    assert.match(text(value), /report its necessity and a simpler equivalent option to the root\/user/);
    assert.match(text(value), /without bypassing gates or re-decomposing the Plan/);
  }
});

test("owned active task takes precedence over pending tasks and old unrelated Plan", () => {
  const value = input([task("1", "pending", { planHandoffKey: "approval-3" }), task("2", "in_progress", { planHandoffKey: "newer-plan" })]);
  value.todo.activeTaskId = "2";
  assert.equal(describeNewContextRecoveryFocus(value).kind, "todo-active");
  assert.match(text(value), /Resume active Todo #2/);
  assert.match(text(value), /Read only the portion needed for the current action/);
  assert.doesNotMatch(text(value), /Before first decomposition|First action: reload/);
});

test("actor-specific active task wins over global activeTaskId owned by another actor", () => {
  const tasks = [task("root-task", "in_progress"), task("child-task", "in_progress", { assignee: child })];
  for (const actor of ["root", "child-1"]) {
    const value = input(tasks, actor);
    value.todo.activeTaskId = actor === "root" ? "child-task" : "root-task";
    assert.equal(describeNewContextRecoveryFocus(value).kind, "todo-active");
    assert.match(text(value), new RegExp(`Resume active Todo #${actor === "root" ? "root-task" : "child-task"}`));
  }
});

test("each actor prepares only its own pending tasks", () => {
  const tasks = [task("root-task", "pending", { planHandoffKey: "approval-3" }), task("child-task", "pending", { assignee: child, planHandoffKey: "approval-3" })];
  for (const actor of ["root", "child-1"]) {
    assert.match(text(input(tasks, actor)), new RegExp(`Prepare pending Todo #${actor === "root" ? "root-task" : "child-task"}`));
  }
});

test("foreign active and pending tasks are never new execution instructions", () => {
  for (const actor of ["root", "child-1"]) {
    const assignee = actor === "root" ? child : { kind: "root" as const, id: "root", label: "root" };
    for (const status of ["pending", "in_progress"] as const) {
      const value = input([task("foreign-task", status, { assignee, planHandoffKey: "approval-3" })], actor);
      value.todo.activeTaskId = "foreign-task";
      assert.equal(describeNewContextRecoveryFocus(value).kind, "reference");
      assert.doesNotMatch(text(value), /Resume active Todo|Prepare pending Todo/);
      assert.match(text(value), /do not take another actor's task/);
    }
  }
});

test("child cannot decompose an approved root Plan without assigned work", () => {
  const value = input([], "child-1");
  assert.equal(describeNewContextRecoveryFocus(value).kind, "reference");
  assert.doesNotMatch(text(value), /call plan-decompose/);
});

test("Plan mode remains read-only even when an active Todo and approved Plan exist", () => {
  for (const status of ["draft", "approved"] as const) {
    const value = input([task("1", "in_progress")]);
    value.plan = { ...value.plan!, mode: "plan", status };
    assert.equal(describeNewContextRecoveryFocus(value).kind, "plan-draft");
    assert.match(text(value), /Remain read-only/);
    assert.match(text(value), /does not exit Plan mode/);
    assert.doesNotMatch(text(value), /Resume active Todo/);
  }
});

test("a draft in Act mode is not execution approval for the draft", () => {
  const value = input();
  value.plan = { ...value.plan!, status: "draft", handoffStatus: "none" };
  value.newContext!.plan = undefined;
  assert.equal(describeNewContextRecoveryFocus(value).kind, "plan-draft");
  assert.match(text(value), /do not execute the draft/);
});

test("paused Goal gates only the Todo bound to that current Goal", () => {
  const value = withGoal(input([task("1", "in_progress", { goalId: "goal-1" })]), { status: "paused", pauseReason: "user" });
  assert.equal(describeNewContextRecoveryFocus(value).kind, "paused");
  assert.match(text(value), /reason: user/);
  assert.match(text(value), /Do not resume, replace, clear/);
});

test("paused Goal does not gate a task bound to another known Goal", () => {
  const value = withGoal(input([task("1", "in_progress", { goalId: "independent-goal" })]), { status: "paused", pauseReason: "user" });
  value.goal!.goals.push({ id: "independent-goal", objective: "Other scope", status: "active", iteration: 1, tokensUsed: 0 });
  assert.equal(describeNewContextRecoveryFocus(value).kind, "todo-active");
  assert.doesNotMatch(text(value), /Do not resume, replace, clear/);
});

test("unbound root task under a paused Goal gets conservative scope guidance, not a global stop", () => {
  const value = withGoal(input([task("1", "in_progress")]), { status: "paused", pauseReason: "user" });
  assert.equal(describeNewContextRecoveryFocus(value).kind, "todo-active");
  assert.match(text(value), /Confirm scope before direct Goal work/);
  assert.match(text(value), /do not stop independent work or auto-resume/);
});

test("unknown bound Goal status must be recovered, not inferred complete", () => {
  const value = withGoal(input([task("1", "pending", { goalId: "missing-goal" })]));
  assert.equal(describeNewContextRecoveryFocus(value).kind, "todo-pending");
  assert.match(text(value), /Bound Goal missing-goal has unknown status/);
  assert.match(text(value), /before Goal-gated execution/);
});

test("paused Goal tied to undecomposed approved Plan does not grant lifecycle override", () => {
  const value = withGoal(input(), { status: "paused", pauseReason: "user", planHandoffKey: "approval-3" });
  assert.equal(describeNewContextRecoveryFocus(value).kind, "paused");
  assert.match(text(value), /reason: user/);
  assert.doesNotMatch(text(value), /call plan-decompose/);
});

test("a done related Goal does not restart its approved Plan", () => {
  const value = withGoal(input(), { status: "done", planHandoffKey: "approval-3" });
  assert.equal(describeNewContextRecoveryFocus(value).kind, "reference");
  assert.doesNotMatch(text(value), /call plan-decompose/);
});

test("an unrelated current Goal makes old Plan a reference rather than first action", () => {
  const value = withGoal(input(), { planHandoffKey: "other-approval" });
  assert.equal(describeNewContextRecoveryFocus(value).kind, "reference");
  assert.match(text(value), /old or unrelated Plan/);
  assert.doesNotMatch(text(value), /Before first decomposition/);
});

test("Workflow corresponding to actor's Todo takes priority over Plan decomposition", () => {
  for (const actor of ["root", "child-1"]) {
    const value = withWorkflow(input([task("1", "in_progress", actor === "root" ? {} : { assignee: child })], actor), "1");
    assert.equal(describeNewContextRecoveryFocus(value).kind, "todo-active");
    assert.match(text(value), /Current Workflow: session session-1, Run run-1/);
    assert.match(text(value), /run brief run-1/);
    assert.doesNotMatch(text(value), /Before first decomposition/);
  }
});

test("Todo origin associates only the exact Workflow session and Run", () => {
  for (const runId of ["run-1", "other-run"]) {
    const value = withWorkflow(input([task("1", "in_progress", { origin: { sessionId: "session-1", runId, step: "execute" } })]));
    assert.equal(text(value).includes("Current Workflow: session"), runId === "run-1");
  }
});

test("Workflow without Todo runs root recovery, but does not instruct an unbound child", () => {
  const root = withWorkflow(input());
  assert.equal(describeNewContextRecoveryFocus(root).kind, "workflow");
  assert.match(text(root), /not a new Plan decomposition/);
  const value = withWorkflow(input([], "child-1"));
  assert.equal(describeNewContextRecoveryFocus(value).kind, "reference");
  assert.doesNotMatch(text(value), /Current Workflow: session/);
});

test("paused Workflow-associated Goal is a scoped gate, while unrelated paused Goal is not", () => {
  for (const sessionId of ["session-1", "other-session"]) {
    const value = withGoal(withWorkflow(input()), { status: "paused", pauseReason: "user", workflowSessionId: sessionId });
    assert.equal(describeNewContextRecoveryFocus(value).kind, sessionId === "session-1" ? "paused" : "workflow");
  }
});

test("failed Workflow gates are retained rather than bypassed", () => {
  const value = withWorkflow(input());
  value.workflow!.gates.failed = 1;
  assert.match(text(value), /1 failed gate\(s\)/);
  assert.match(text(value), /do not bypass them/);
});

test("stale request Plan cannot substitute or restart a different live approval", () => {
  const value = input();
  value.plan = { ...value.plan!, revision: 4, handoffKey: "approval-4", path: "/plans/4.md" };
  assert.equal(describeNewContextRecoveryFocus(value).kind, "reference");
  assert.match(text(value), /identity conflicts with the live snapshot/);
  assert.match(text(value), /approval-4|\/plans\/4.md/);
  assert.doesNotMatch(text(value), /approval-3|call plan-decompose/);
  value.plan.status = "draft";
  assert.equal(describeNewContextRecoveryFocus(value).kind, "reference");
  value.plan.mode = "plan";
  assert.equal(describeNewContextRecoveryFocus(value).kind, "plan-draft");
});

test("mismatched Plan history requires reconciliation, not another decomposition", () => {
  const value = input([task("1", "completed", { planHandoffKey: "approval-3" })]);
  value.plan!.handoffKey = "different-current-plan";
  assert.equal(describeNewContextRecoveryFocus(value).kind, "reference");
  assert.match(text(value), /identity conflicts/);
  assert.doesNotMatch(text(value), /call plan-decompose|All Todos bound/);
});

test("request draft does not inherit execution approval from the live snapshot", () => {
  const value = input();
  value.newContext!.plan!.status = "draft";
  assert.equal(describeNewContextRecoveryFocus(value).kind, "reference");
  assert.match(text(value), /identity conflicts/);
  assert.doesNotMatch(text(value), /call plan-decompose/);
});

test("missing approved identity gets bounded reference guidance, not guessed authorization", () => {
  const value = input();
  value.plan!.handoffKey = undefined;
  value.newContext!.plan = undefined;
  assert.equal(describeNewContextRecoveryFocus(value).kind, "reference");
  assert.match(text(value), /identity is incomplete/);
  assert.doesNotMatch(text(value), /call plan-decompose/);
});

test("missing newContext defaults to root ownership and empty state remains idle", () => {
  const value = input([task("1", "in_progress")]);
  value.newContext = undefined;
  assert.equal(describeNewContextRecoveryFocus(value).kind, "todo-active");
  assert.match(text(value), /Recovery actor: root/);
  value.todo.tasks = [];
  value.plan = undefined;
  assert.equal(describeNewContextRecoveryFocus(value).kind, "idle");
});

test("unbound Goal does not make an independent undecomposed approved Plan reference-only", () => {
  for (const status of ["active", "paused"] as const) {
    const value = withGoal(input(), { status, pauseReason: status === "paused" ? "user" : undefined });
    assert.equal(describeNewContextRecoveryFocus(value).kind, "plan-decomposition");
    assert.match(text(value), /existing execution authorization/);
    if (status === "paused") assert.match(text(value), /do not auto-resume it or stop independent authorized work/);
  }
});

test("live approval checksum is used without a reset payload", () => {
  const value = input();
  value.plan!.checksum = "live-checksum";
  value.newContext!.plan = undefined;
  assert.match(text(value), /checksum: live-checksum/);
});

test("conflicting checksums fail closed without mixing snapshot identities", () => {
  const value = input();
  value.plan!.path = "/plans/live-approval.md";
  value.plan!.checksum = "live-checksum";
  assert.equal(describeNewContextRecoveryFocus(value).kind, "reference");
  assert.match(text(value), /identity conflicts/);
  assert.match(text(value), /\/plans\/live-approval.md/);
  assert.doesNotMatch(text(value), /checksum-3|call plan-decompose/);
});

test("payload-only approval still requires live verification before first decomposition", () => {
  const value = input();
  value.plan = undefined;
  assert.equal(describeNewContextRecoveryFocus(value).kind, "plan-decomposition");
  assert.match(text(value), /existing task bindings against live state/);
});

test("Goal-only state preserves recorded paused/done state without inferring completion", () => {
  for (const status of ["active", "paused", "done"] as const) {
    const value = withGoal(input(), { status, pauseReason: status === "paused" ? "user" : undefined });
    value.plan = undefined;
    value.newContext = undefined;
    assert.equal(describeNewContextRecoveryFocus(value).kind, status === "paused" ? "paused" : "goal");
    assert.match(text(value), /user-owned/);
  }
});

test("output is deterministic, bounded, body-free and does not mutate recovery state", () => {
  const value = withGoal(withWorkflow(input([task("1", "in_progress", { goalId: "missing-goal" })]), "1"));
  value.newContext!.actorId = "root";
  value.plan!.path = "界".repeat(100_000);
  value.newContext!.plan!.path = "界".repeat(100_000);
  value.newContext!.plan!.markdown = "LARGE_PLAN_BODY".repeat(100_000);
  value.newContext!.carryForward = "LARGE_CARRY_FORWARD".repeat(100_000);
  value.workflow!.nextAction = "LONG_WORKFLOW_ACTION\n".repeat(100_000);
  const before = structuredClone(value);
  const first = describeNewContextRecoveryFocus(value);
  assert.deepEqual(first, describeNewContextRecoveryFocus(value));
  assert.deepEqual(value, before);
  assert.ok(first.lines.length <= 8);
  for (const line of first.lines) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 480);
    assert.doesNotMatch(line, /[\r\n\t\ufffd]/);
  }
  const continuation = buildNewContextContinuation(value);
  assert.ok(Buffer.byteLength(continuation, "utf8") <= 4096);
  assert.doesNotMatch(continuation, /LARGE_PLAN_BODY|LARGE_CARRY_FORWARD|GOAL_OBJECTIVE_NOT_REQUIRED/);
  assert.ok(continuation.endsWith(first.lines.join("\n")));
});

test("matching key and checksum cannot hide a different approved source path", () => {
  const value = input();
  value.newContext!.plan!.path = "/plans/stale.md";
  assert.equal(describeNewContextRecoveryFocus(value).kind, "reference");
  assert.match(text(value), /identity conflicts/);
  assert.doesNotMatch(text(value), /stale.md|call plan-decompose/);
  value.newContext!.plan!.path = value.plan!.path!;
  value.plan!.checksum = undefined;
  assert.equal(describeNewContextRecoveryFocus(value).kind, "reference");
});

test("equivalent Windows approval paths use the live canonical pointer", () => {
  const value = input();
  value.plan!.path = "D:/Plans/approvals/3.md";
  value.newContext!.plan!.path = "d:/plans/approvals/./3.md";
  assert.equal(describeNewContextRecoveryFocus(value).kind, "plan-decomposition");
  assert.match(text(value), /D:\/Plans\/approvals\/3.md/);
  assert.doesNotMatch(text(value), /identity conflicts/);
});
