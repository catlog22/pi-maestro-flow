import type {
  WorkflowExecution,
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

export type DerivedWorkflowLifecycle =
  | "legacy"
  | "executing"
  | "blocked"
  | "runnable"
  | "idle"
  | "archived";

export interface DerivedWorkflowStatus {
  authority: "legacy-session" | "execution-derived";
  lifecycle: DerivedWorkflowLifecycle;
  status: WorkflowStatus;
}

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
  createdBy?: { id: string; label: string };
  assignee?: { id: string; label: string };
}

export interface WorkflowSnapshotRunLike extends Omit<WorkflowRun, "status"> {
  status: string;
}

export interface WorkflowSnapshotSessionLike extends Omit<WorkflowSession, "runs" | "status"> {
  label?: string;
  status?: string;
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
  createdBy?: { id: string; label: string };
  assignee?: { id: string; label: string };
}

export interface WorkflowViewModel {
  revision?: WorkflowSnapshot["revision"];
  sessionId: string;
  sessionLabel: string;
  status: WorkflowStatus;
  lifecycle: DerivedWorkflowLifecycle;
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
  knowledge?: {
    consumed: number;
    cited: number;
    validated: number;
    contradicted: number;
    pendingCandidates: number;
    corroboratedCandidates: number;
    reviewRequired: number;
    promotedCandidates: number;
    /** Per-source signal totals for the current Session's knowledge evolution. */
    bySource: Record<string, { consumed: number; cited: number; validated: number; contradicted: number }>;
    /** Knowledge-id attribution detail (newest first, bounded). */
    inputs: Array<{
      runId: string;
      knowledgeId: string;
      signal: string;
      source: string;
      count: number;
    }>;
  };
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

/**
 * The sole Session/Execution lifecycle projection. session/1.x keeps its
 * persisted Session status; session/2.0 is derived only from archive metadata
 * and the pointed Execution.
 */
export function deriveWorkflowStatus(
  snapshot: WorkflowSnapshotLike,
): DerivedWorkflowStatus {
  const session = snapshot.session;
  const statusless = session?.lifecycleAuthority === "execution-derived"
    || session?.schemaVersion === "session/2.0";
  if (!session || !statusless) {
    return {
      authority: "legacy-session",
      lifecycle: "legacy",
      status: normalizeWorkflowStatus(session?.status),
    };
  }
  if (session.archivedAt) {
    return { authority: "execution-derived", lifecycle: "archived", status: "completed" };
  }
  const execution = snapshot.execution;
  if (!execution || execution.status === "sealed") {
    return { authority: "execution-derived", lifecycle: "idle", status: "completed" };
  }
  if (execution.status === "paused" || executionHasBlocker(execution, session)) {
    return { authority: "execution-derived", lifecycle: "blocked", status: "blocked" };
  }
  if (execution.activeRunId || execution.chain.some((step) => step.status === "running")) {
    return { authority: "execution-derived", lifecycle: "executing", status: "running" };
  }
  if (execution.chain.some((step) => step.status === "pending")) {
    return { authority: "execution-derived", lifecycle: "runnable", status: "pending" };
  }
  return { authority: "execution-derived", lifecycle: "idle", status: "completed" };
}

export function deriveWorkflowViewModel(
  snapshot: WorkflowSnapshotLike | null | undefined,
): WorkflowViewModel | null {
  const session = snapshot?.session;
  if (!snapshot || !session) return null;

  const workflowStatus = deriveWorkflowStatus(snapshot);
  const chain = workflowStatus.authority === "execution-derived"
    ? snapshot.execution?.chain ?? []
    : session.chain;
  const activeRunId = workflowStatus.authority === "execution-derived"
    ? snapshot.execution?.activeRunId ?? null
    : session.activeRunId;
  const sequenceByRunId = new Map(
    chain
      .map((step, index) => step.runId ? [step.runId, index + 1] as const : undefined)
      .filter((entry): entry is readonly [string, number] => entry != null),
  );
  const runs = session.runs
    .map((run) => toRunView(run, sequenceByRunId.get(run.runId), session))
    .sort(compareRuns);
  const sessionStatus = workflowStatus.status;
  const activeRun = (activeRunId ? runs.find((run) => run.id === activeRunId) : undefined)
    ?? (workflowStatus.authority === "legacy-session"
      ? runs.find((run) => isActiveStatus(run.status))
      : undefined);
  const todos = (snapshot.todos ?? []).map((todo) => {
    const status = normalizeWorkflowStatus(todo.status);
    return {
      id: todo.id,
      subject: todo.subject,
      status,
      glyph: GLYPHS[status],
      origin: todo.origin,
      blockedBy: todo.blockedBy ?? [],
      createdBy: todo.createdBy,
      assignee: todo.assignee,
    } satisfies WorkflowTodoView;
  });
  const completed = runs.filter((run) => isCompletedStatus(run.status)).length;
  const running = runs.filter((run) => isActiveStatus(run.status)).length;
  const goalInput = snapshot.goal === null
    ? undefined
    : snapshot.goal ?? {
      objective: session.intent,
      status: sessionStatus,
    };
  const goalStatus = normalizeWorkflowStatus(goalInput?.status);
  const decisionPoints = snapshot.decisionPoints ?? snapshot.execution?.decisionPoints ?? [];
  const decisionPending = decisionPoints.some(
    (point) => normalizeWorkflowStatus(point.status) === "pending",
  );
  const nextAction = snapshot.nextAction
    ?? activeRun?.nextAction;
  const totalGates = session.gates.length;
  const passedGates = session.gates.filter((gate) =>
    gate.status === "passed" || gate.status === "waived" || gate.status === "skipped",
  ).length;

  return {
    revision: snapshot.revision,
    sessionId: session.sessionId,
    sessionLabel: session.label ?? session.sessionId,
    status: sessionStatus,
    lifecycle: workflowStatus.lifecycle,
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

function executionHasBlocker(
  execution: WorkflowExecution,
  session: WorkflowSnapshotSessionLike,
): boolean {
  const executionRunIds = new Set(
    execution.chain.flatMap((step) => step.runId ? [step.runId] : []),
  );
  if (execution.activeRunId) executionRunIds.add(execution.activeRunId);
  const executionRuns = session.runs.filter((run) => executionRunIds.has(run.runId));
  const gates = [
    ...session.gates.filter((gate) => !gate.runId || executionRunIds.has(gate.runId)),
    ...executionRuns.flatMap((run) => run.gates),
  ];
  return execution.chain.some((step) => ["blocked", "failed"].includes(step.status))
    || executionRuns.some((run) => ["blocked", "failed"].includes(run.status))
    || gates.some((gate) => gate.blocking && ["blocked", "failed"].includes(gate.status))
    || execution.decisionPoints.some((point) =>
      point.status === "escalated" || (!execution.activeRunId && point.status === "pending")
    );
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
