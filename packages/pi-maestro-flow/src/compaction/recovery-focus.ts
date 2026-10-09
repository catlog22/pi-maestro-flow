import { posix, win32 } from "node:path";
import type { MaestroCompactionDetails } from "./maestro-compaction.ts";

export type RecoveryFocusInput = Pick<
  MaestroCompactionDetails,
  "todo" | "goal" | "plan" | "workflow" | "newContext"
>;

export type NewContextRecoveryFocusKind =
  | "plan-draft"
  | "plan-decomposition"
  | "todo-active"
  | "todo-pending"
  | "workflow"
  | "blocked"
  | "paused"
  | "goal"
  | "reference"
  | "idle";

export interface NewContextRecoveryFocus {
  kind: NewContextRecoveryFocusKind;
  lines: string[];
}

// Keep the focus usable even when its caller has no budget for task or Plan bodies.
const MAX_LINES = 8;
const MAX_LINE_BYTES = 480;
const AUXILIARY_BLOCKER_GUIDANCE = "If auxiliary work blocks the requested outcome, report the dependency's necessity and any simpler equivalent option to the root/user; keep the block until resolved through the authorized lifecycle. Failed-attempt budgets remain cumulative across workers and resets.";

function bounded(value: string, maxBytes = 160): string {
  const text = value.replace(/[\r\n\t]+/g, " ").trim();
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = " [truncated; recover exact value]";
  let output = "";
  let bytes = Buffer.byteLength(suffix, "utf8");
  for (const point of text) {
    const width = Buffer.byteLength(point, "utf8");
    if (bytes + width > maxBytes) break;
    output += point;
    bytes += width;
  }
  return output + suffix;
}

function planPathKey(path: string | undefined): string | undefined {
  if (!path) return undefined;
  // Compare lexical absolute identities without introducing filesystem I/O into reset.
  return /^[a-z]:[\\/]|^\\\\/i.test(path)
    ? win32.normalize(path).toLowerCase()
    : posix.normalize(path);
}

function recoveryPlanIdentityConflicts(input: RecoveryFocusInput): boolean {
  const payload = input.newContext?.plan;
  const live = input.plan;
  if (!payload || !live) return false;
  return !(payload.status === live.status
    && payload.revision === live.revision
    && payload.handoffKey === live.handoffKey
    && planPathKey(payload.path) !== undefined
    && planPathKey(payload.path) === planPathKey(live.path)
    && (live.status === "approved"
      ? Boolean(live.checksum && payload.checksum === live.checksum)
      : payload.checksum === live.checksum));
}

/** The live pointer wins; a request alone remains only a conditional recovery reference. */
export function getRecoveryPlanIdentity(input: RecoveryFocusInput) {
  return input.plan ?? input.newContext?.plan;
}

export function describeNewContextRecoveryFocus(input: RecoveryFocusInput): NewContextRecoveryFocus {
  const actor = input.newContext?.actorId ?? "root";
  const tasks = input.todo.tasks;
  const owned = tasks.filter((task) => task.assignee.id === actor);
  const currentGoal = input.goal?.goals.find((goal) => goal.id === input.goal?.currentGoalId);
  const plan = getRecoveryPlanIdentity(input);
  const planPath = plan?.path;
  const planChecksum = plan?.checksum;
  const planKey = plan?.handoffKey;
  const bound = planKey ? tasks.filter((task) => task.planHandoffKey === planKey) : [];
  const planReference = plan && plan.status !== "empty"
    ? `Plan reference: ${plan.status}, revision ${plan.revision}${planKey ? `, handoff ${bounded(planKey)}` : ""}${planPath ? `, path ${bounded(planPath, 200)}` : ""}. Read only the portion needed for the current action; do not re-decompose prior execution.`
    : undefined;
  const finish = (kind: NewContextRecoveryFocusKind, lines: string[]): NewContextRecoveryFocus => ({
    kind,
    lines: [`Recovery actor: ${bounded(actor)}. Live state and existing authorization remain authoritative.`, ...lines]
      .slice(0, MAX_LINES)
      .map((line) => bounded(line, MAX_LINE_BYTES)),
  });
  const dependencies = (task: typeof tasks[number]) => task.blockedBy.filter((id) =>
    !tasks.some((dependency) => dependency.id === id && dependency.status === "completed"));
  const active = owned.find((task) => task.id === input.todo.activeTaskId && task.status === "in_progress")
    ?? owned.find((task) => task.status === "in_progress");
  const pending = owned.find((task) => task.status === "pending" && dependencies(task).length === 0);
  const selected = active ?? pending;
  const workflowFor = (task: typeof tasks[number]) => input.workflow && (
    input.workflow.todoId
      ? input.workflow.todoId === task.id
      : task.origin?.sessionId === input.workflow.sessionId && task.origin.runId === input.workflow.runId
  );
  const workflowLines = () => input.workflow ? [
    `Current Workflow: session ${bounded(input.workflow.sessionId)}, Run ${bounded(input.workflow.runId)}. Recover its Run brief and follow its recorded next action, not a new Plan decomposition.`,
    ...(input.workflow.nextAction ? [`Recorded Workflow next action: ${bounded(input.workflow.nextAction, 320)}`] : []),
    ...(input.workflow.gates.failed > 0 ? [`Workflow has ${input.workflow.gates.failed} failed gate(s); preserve their blockers and do not bypass them.`] : []),
  ] : [];
  const pausedLines = (goal = currentGoal) => goal ? [
    `Goal ${bounded(goal.id)} is paused; reason: ${bounded(goal.pauseReason ?? "not recorded")}. Do not resume, replace, clear, or execute its gated work without the user's lifecycle decision.`,
  ] : [];

  if (input.plan?.mode === "plan") {
    return finish("plan-draft", [
      "Plan mode is active. Remain read-only: recover the current draft or review state and continue planning; do not execute or decompose implementation work.",
      ...(planReference ? [planReference] : []),
      "Approval and execution choices remain the user's decision; this recovery text does not exit Plan mode.",
    ]);
  }

  if (recoveryPlanIdentityConflicts(input)) {
    return finish("reference", [
      "Plan recovery identity conflicts with the live snapshot. Reconcile status, revision, handoff key and checksum before Plan-dependent execution; do not restart, decompose, or substitute another Plan automatically.",
      ...(planReference ? [planReference] : []),
    ]);
  }

  if (selected) {
    const taskLines = [`${active ? "Resume active" : "Prepare pending"} Todo #${bounded(selected.id)} assigned to this actor. Recover its exact next action from its context and handoff; use only task-relevant Plan slices.`];
    const boundGoal = input.goal?.goals.find((goal) => goal.id === selected.goalId);
    if (boundGoal?.status === "paused") {
      return finish("paused", [...pausedLines(boundGoal), ...taskLines, ...(planReference ? [planReference] : [])]);
    }
    const unmet = dependencies(selected);
    if (unmet.length > 0) {
      return finish("blocked", [
        `Todo #${bounded(selected.id)} is blocked by ${unmet.slice(0, 4).map((id) => `#${bounded(id, 64)}`).join(", ")}${unmet.length > 4 ? " (more dependencies omitted)" : ""}. Recover the recorded blocker; do not bypass dependencies or re-decompose the Plan.`,
        AUXILIARY_BLOCKER_GUIDANCE,
        ...(selected.context ? [`Recorded Todo context: ${bounded(selected.context, 320)}`] : []),
        ...(planReference ? [planReference] : []),
      ]);
    }
    if (!active) taskLines.push("Activate this owned runnable Todo through the Todo lifecycle before execution; do not create duplicate tasks or decompose the Plan again.");
    if (selected.goalId && !input.goal?.goals.some((goal) => goal.id === selected.goalId)) {
      taskLines.push(`Bound Goal ${bounded(selected.goalId)} has unknown status. Recover its live state before Goal-gated execution; do not infer completion or permission.`);
    } else if (!selected.goalId && actor === "root" && currentGoal?.status === "paused") {
      taskLines.push(`Current Goal ${bounded(currentGoal.id)} is paused (${bounded(currentGoal.pauseReason ?? "reason not recorded")}), but this Todo is not bound to it. Confirm scope before direct Goal work; do not stop independent work or auto-resume the Goal.`);
    }
    if (workflowFor(selected)) taskLines.push(...workflowLines());
    if (planReference) taskLines.push(planReference);
    taskLines.push("Reuse still-valid task evidence. Todo completion is not evidence that a Goal has completed. Carry cumulative failed-attempt budgets across workers and resets; if auxiliary work blocks the requested outcome, report its necessity and a simpler equivalent option to the root/user, without bypassing gates or re-decomposing the Plan.");
    return finish(active ? "todo-active" : "todo-pending", taskLines);
  }

  const blocked = owned.find((task) => task.status === "blocked" || (task.status === "pending" && dependencies(task).length > 0));
  if (blocked) {
    const boundGoal = input.goal?.goals.find((goal) => goal.id === blocked.goalId);
    if (boundGoal?.status === "paused") {
      return finish("paused", [...pausedLines(boundGoal), `Todo #${bounded(blocked.id)} remains blocked; preserve its recorded dependencies and reason.`]);
    }
    const unmet = dependencies(blocked);
    return finish("blocked", [
      `Owned Todo #${bounded(blocked.id)} remains blocked${unmet.length ? ` by ${unmet.slice(0, 4).map((id) => `#${bounded(id, 64)}`).join(", ")}` : ""}. Read its recorded blocker and report it; do not invent work, bypass the block, or re-decompose the Plan.`,
      AUXILIARY_BLOCKER_GUIDANCE,
      ...(blocked.context ? [`Recorded Todo context: ${bounded(blocked.context, 320)}`] : []),
      ...(planReference ? [planReference] : []),
    ]);
  }

  const workflow = input.workflow;
  const workflowOwned = workflow && actor === "root" && !workflow.todoId;
  if (workflowOwned) {
    if (currentGoal?.status === "paused" && currentGoal.workflowSessionId === workflow.sessionId) {
      return finish("paused", [...pausedLines(), ...workflowLines()]);
    }
    return finish("workflow", [...workflowLines(), ...(planReference ? [planReference] : [])]);
  }

  if (plan?.status === "draft") {
    return finish("plan-draft", [
      "The Plan is a draft, not execution approval. Recover the needed draft slice and continue requested planning/review; do not execute the draft.",
      ...(planReference ? [planReference] : []),
    ]);
  }
  if (plan?.status === "approved" && bound.length === 0 && actor === "root") {
    const relatedGoal = currentGoal?.planHandoffKey === planKey && planKey !== undefined;
    if (relatedGoal && currentGoal?.status === "paused") return finish("paused", [...pausedLines(), ...(planReference ? [planReference] : [])]);
    if (relatedGoal && currentGoal?.status === "done") {
      return finish("reference", ["The related Goal is recorded done. Keep its Plan as a reference; no new execution or decomposition is established by this reset.", ...(planReference ? [planReference] : [])]);
    }
    // Missing Goal binding is not evidence that the Plan belongs to another scope.
    const unrelatedGoal = currentGoal?.planHandoffKey && currentGoal.planHandoffKey !== planKey;
    if (!unrelatedGoal && !workflow?.todoId) {
      if (!planKey || !planPath) {
        return finish("reference", ["Approved Plan identity is incomplete. Recover its live approved snapshot and handoff key before deciding whether first decomposition is authorized.", ...(planReference ? [planReference] : [])]);
      }
      return finish("plan-decomposition", [
        "No Todo is bound to this approved Plan in the snapshot. Before first decomposition, read the exact approved snapshot and verify revision, handoff key, checksum and existing task bindings against live state; do not use an unverified or truncated body.",
        `Approved snapshot pointer: ${bounded(planPath, 260)}.`,
        `Expected handoff key: ${bounded(planKey, 220)}; revision: ${plan.revision}${planChecksum ? `; checksum: ${bounded(planChecksum, 100)}` : "; recover the approved checksum from the Plan store"}.`,
        ...(currentGoal?.status === "paused" && !relatedGoal ? ["The paused current Goal is not bound to this Plan. Confirm scope before direct Goal work; do not auto-resume it or stop independent authorized work."] : []),
        "Only if live state confirms approval, existing execution authorization and no prior decomposition, call plan-decompose for complex work (or create the authorized simple Todo) with the exact handoff key. Do not widen the approved scope.",
      ]);
    }
  }

  if (planReference && (bound.length > 0 || actor !== "root" || plan?.status === "approved")) {
    return finish("reference", [
      ...(bound.length > 0 ? [bound.every((task) => task.status === "completed")
        ? "All Todos bound to this Plan are completed. Keep the Plan as a reference; do not re-decompose or infer Goal completion."
        : "This Plan already has bound Todos, but none is runnable for this actor. Inspect owned task state only as needed; do not take another actor's task or repeat decomposition."] : ["No executable Plan work is established for this actor and scope. Keep the Plan as a reference; do not treat an old or unrelated Plan as the mandatory first action."]),
      planReference,
      "Recover the current Goal or Workflow only when relevant to the requested work. This reference does not authorize a lifecycle change.",
    ]);
  }
  if (actor === "root" && currentGoal) {
    return finish(currentGoal.status === "paused" ? "paused" : "goal", [
      ...(currentGoal.status === "paused" ? pausedLines() : [
        `Current Goal ${bounded(currentGoal.id)} is ${currentGoal.status}. Recover its live acceptance and next action only for direct Goal work; do not infer completion from Todo status or create competing work.`,
      ]),
      "Goal state applies to its own scope, not independent work; stopping, resuming and clearing remain user-owned.",
    ]);
  }
  return finish("idle", [
    "No owned active or runnable Todo is established. Recover only the missing state needed for the current request; do not claim another actor's task or invent execution from historical Plan/Goal references.",
  ]);
}

export function buildNewContextContinuation(input: RecoveryFocusInput): string {
  return [
    "Continue from the deterministic recovery capsule. Recover only facts needed for the next authorized action; do not reconstruct the full conversation.",
    ...describeNewContextRecoveryFocus(input).lines,
  ].join("\n");
}
