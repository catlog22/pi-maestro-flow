import type {
  WorkflowRun,
  WorkflowSession,
  WorkflowSnapshot,
} from "./types.ts";

export type WorkflowStatus =
  | "running"
  | "paused"
  | "blocked"
  | "waiting_user"
  | "retrying"
  | "sealed"
  | "failed"
  | "cancelled"
  | "ready"
  | "completed"
  | "pending"
  | "unknown";

export interface WorkflowSnapshotGoalLike {
  objective?: string;
  status?: string;
  tokensUsed?: number;
  tokenBudget?: number;
}

export interface WorkflowSnapshotTodoLike {
  id: string;
  subject: string;
  status?: string;
  origin?: string;
  blockedBy?: readonly string[];
}

export interface WorkflowSnapshotRunLike extends Omit<WorkflowRun, "status"> {
  status: string;
}

export interface WorkflowSnapshotSessionLike extends Omit<WorkflowSession, "runs" | "status"> {
  label?: string;
  status: string;
  runs: WorkflowSnapshotRunLike[];
}

/** Canonical bridge snapshot with optional host projections unavailable to the CLI store. */
export type WorkflowSnapshotLike = Omit<WorkflowSnapshot, "session"> & {
  session?: WorkflowSnapshotSessionLike;
  goal?: WorkflowSnapshotGoalLike | null;
  todos?: readonly WorkflowSnapshotTodoLike[];
  decisionPoints?: ReadonlyArray<{ status?: string }>;
  nextAction?: string;
  recoveryAction?: string;
};

export interface WorkflowRunView {
  id: string;
  sequence?: number;
  command: string;
  status: WorkflowStatus;
  glyph: string;
  verdict?: string;
  gate?: string;
  artifactsCount: number;
  nextAction?: string;
  blockedBy?: string;
  attempt?: number;
}

export interface WorkflowTodoView {
  id: string;
  subject: string;
  status: WorkflowStatus;
  glyph: string;
  origin?: string;
  blockedBy: readonly string[];
}

export interface WorkflowViewModel {
  revision?: WorkflowSnapshot["revision"];
  sessionId: string;
  sessionLabel: string;
  status: WorkflowStatus;
  glyph: string;
  activeRun?: WorkflowRunView;
  runs: readonly WorkflowRunView[];
  todos: readonly WorkflowTodoView[];
  goal?: {
    objective: string;
    status: WorkflowStatus;
    glyph: string;
    tokensUsed?: number;
    tokenBudget?: number;
  };
  chain: {
    completed: number;
    running: number;
    pending: number;
    total: number;
  };
  gates?: { passed: number; total: number };
  decisionPending: boolean;
  nextAction?: string;
  recoveryAction?: string;
}

const GLYPHS: Record<WorkflowStatus, string> = {
  running: "▶",
  paused: "⏸",
  blocked: "!",
  waiting_user: "?",
  retrying: "↻",
  sealed: "✓",
  failed: "×",
  cancelled: "⊘",
  ready: "✓",
  completed: "✓",
  pending: "○",
  unknown: "□",
};

const STATUS_ALIASES: Record<string, WorkflowStatus> = {
  active: "running",
  in_progress: "running",
  "in-progress": "running",
  waiting: "waiting_user",
  waiting_user: "waiting_user",
  "waiting-user": "waiting_user",
  ready_wc: "ready",
  succeeded: "completed",
  complete: "completed",
  done: "completed",
  archived: "completed",
  created: "pending",
  planned: "pending",
  canceled: "cancelled",
};

export function normalizeWorkflowStatus(value: string | undefined): WorkflowStatus {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "unknown";
  if (normalized in GLYPHS) return normalized as WorkflowStatus;
  return STATUS_ALIASES[normalized] ?? "unknown";
}

export function workflowStatusText(status: WorkflowStatus, attempt?: number): string {
  if (status === "waiting_user") return "waiting user";
  if (status === "retrying" && attempt != null) return `retry ${attempt}`;
  return status;
}

export function workflowStatusLabel(status: WorkflowStatus, attempt?: number): string {
  return `${GLYPHS[status]} ${workflowStatusText(status, attempt)}`;
}

export function deriveWorkflowViewModel(
  snapshot: WorkflowSnapshotLike | null | undefined,
): WorkflowViewModel | null {
  const session = snapshot?.session;
  if (!snapshot || !session) return null;

  const sequenceByRunId = new Map(
    session.chain
      .map((step, index) => step.runId ? [step.runId, index + 1] as const : undefined)
      .filter((entry): entry is readonly [string, number] => entry != null),
  );
  const runs = session.runs
    .map((run) => toRunView(run, sequenceByRunId.get(run.runId), session))
    .sort(compareRuns);
  const sessionStatus = normalizeWorkflowStatus(session.status);
  const activeRun = runs.find((run) => run.id === session.activeRunId)
    ?? runs.find((run) => isActiveStatus(run.status));
  const todos = (snapshot.todos ?? []).map((todo) => {
    const status = normalizeWorkflowStatus(todo.status);
    return {
      id: todo.id,
      subject: todo.subject,
      status,
      glyph: GLYPHS[status],
      origin: todo.origin,
      blockedBy: todo.blockedBy ?? [],
    } satisfies WorkflowTodoView;
  });
  const completed = runs.filter((run) => isCompletedStatus(run.status)).length;
  const running = runs.filter((run) => isActiveStatus(run.status)).length;
  const goalInput = snapshot.goal === null
    ? undefined
    : snapshot.goal ?? {
      objective: session.intent,
      status: session.status,
    };
  const goalStatus = normalizeWorkflowStatus(goalInput?.status);
  const decisionPending = (snapshot.decisionPoints ?? []).some(
    (point) => normalizeWorkflowStatus(point.status) === "pending",
  );
  const nextTodo = todos.find((todo) => todo.status === "running")
    ?? todos.find((todo) => todo.status === "pending" && todo.blockedBy.length === 0)
    ?? todos.find((todo) => todo.status === "blocked" || todo.status === "pending");
  const nextAction = snapshot.nextAction
    ?? activeRun?.nextAction
    ?? nextTodo?.subject;
  const totalGates = session.gates.length;
  const passedGates = session.gates.filter((gate) =>
    gate.status === "passed" || gate.status === "waived" || gate.status === "skipped",
  ).length;

  return {
    revision: snapshot.revision,
    sessionId: session.sessionId,
    sessionLabel: session.label ?? session.sessionId,
    status: sessionStatus,
    glyph: GLYPHS[sessionStatus],
    activeRun,
    runs,
    todos,
    goal: goalInput ? {
      objective: goalInput.objective ?? session.intent,
      status: goalStatus,
      glyph: GLYPHS[goalStatus],
      tokensUsed: goalInput.tokensUsed,
      tokenBudget: goalInput.tokenBudget,
    } : undefined,
    chain: {
      completed,
      running,
      pending: Math.max(0, runs.length - completed - running),
      total: runs.length,
    },
    gates: totalGates > 0 ? { passed: passedGates, total: totalGates } : undefined,
    decisionPending,
    nextAction,
    recoveryAction: snapshot.recoveryAction ?? inferRecoveryAction(sessionStatus, activeRun),
  };
}

function toRunView(
  run: WorkflowSnapshotRunLike,
  sequence: number | undefined,
  session: WorkflowSnapshotSessionLike,
): WorkflowRunView {
  const status = normalizeWorkflowStatus(run.status);
  const handoff = run.handoff ?? {};
  const gate = run.gates.find((item) =>
    item.blocking && !["passed", "waived", "skipped"].includes(item.status)
  )?.id;
  return {
    id: run.runId,
    sequence,
    command: run.command,
    status,
    glyph: GLYPHS[status],
    verdict: stringField(handoff, "verdict"),
    gate,
    artifactsCount: session.artifacts.filter((artifact) => artifact.runId === run.runId).length,
    nextAction: stringField(handoff, "nextAction") ?? stringField(handoff, "next"),
    blockedBy: stringField(handoff, "blockedBy"),
    attempt: numberField(handoff, "attempt"),
  };
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === "number" ? value[key] : undefined;
}

function compareRuns(left: WorkflowRunView, right: WorkflowRunView): number {
  if (left.sequence != null && right.sequence != null) return left.sequence - right.sequence;
  if (left.sequence != null) return -1;
  if (right.sequence != null) return 1;
  return left.id.localeCompare(right.id);
}

function isActiveStatus(status: WorkflowStatus): boolean {
  return status === "running"
    || status === "paused"
    || status === "blocked"
    || status === "waiting_user"
    || status === "retrying";
}

function isCompletedStatus(status: WorkflowStatus): boolean {
  return status === "sealed" || status === "ready" || status === "completed";
}

function inferRecoveryAction(
  status: WorkflowStatus,
  activeRun: WorkflowRunView | undefined,
): string | undefined {
  if (status === "paused") return "Resume session";
  if (status === "blocked") return activeRun?.nextAction ?? "Resolve blocking gate";
  if (status === "waiting_user") return "Resolve pending decision";
  if (status === "failed") return "Retry failed run";
  return undefined;
}
