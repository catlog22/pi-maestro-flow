import { randomUUID } from "node:crypto";
import {
  COCKPIT_MAESTRO_QUERY_EVENT,
  MAESTRO_UI_SNAPSHOT_EVENT,
  MAESTRO_UI_SNAPSHOT_VERSION,
  type MaestroGoalV1,
  type MaestroModeV1,
  type MaestroSwarmV1,
  type MaestroUiSnapshotV1,
  type MaestroUiStateSnapshotV1,
  type MaestroWorkflowV1,
} from "pi-cockpit/v1/events";
import type { WorkflowViewModel } from "./session/view-model.ts";
import type { TeamSwarmProjection } from "./swarm/projection.ts";
import type { GoalDetailEntry } from "./tui/goal-widget.ts";

export interface MaestroUiProjectionInput {
  workflow: WorkflowViewModel | null | undefined;
  goals: readonly GoalDetailEntry[];
  currentGoalId?: string;
  swarm: TeamSwarmProjection | null | undefined;
  planMode: string;
  approvalMode: string;
}

export type MaestroUiProjectionV1 = Pick<
  MaestroUiStateSnapshotV1,
  "workflow" | "goals" | "currentGoalId" | "swarm" | "mode"
>;

export interface MaestroUiPublisherOptions {
  read: () => MaestroUiProjectionInput;
  emit: (
    event: typeof MAESTRO_UI_SNAPSHOT_EVENT,
    snapshot: MaestroUiSnapshotV1,
  ) => void;
  now?: () => number;
  generation?: () => string;
}

export function projectMaestroUiState(input: MaestroUiProjectionInput): MaestroUiProjectionV1 {
  const goals = projectGoals(input.goals);
  const currentGoalId = input.currentGoalId && goals.some((goal) => goal.id === input.currentGoalId)
    ? input.currentGoalId
    : undefined;
  return {
    workflow: projectWorkflow(input.workflow),
    goals,
    ...(currentGoalId ? { currentGoalId } : {}),
    swarm: projectSwarm(input.swarm),
    mode: projectMode(input.planMode, input.approvalMode),
  };
}

export class MaestroUiPublisher {
  private readonly read: () => MaestroUiProjectionInput;
  private readonly emitSnapshot: MaestroUiPublisherOptions["emit"];
  private readonly now: () => number;
  private readonly createGeneration: () => string;
  private sessionGeneration: string;
  private revision = -1;
  private lastFingerprint: string | undefined;

  constructor(options: MaestroUiPublisherOptions) {
    this.read = options.read;
    this.emitSnapshot = options.emit;
    this.now = options.now ?? Date.now;
    this.createGeneration = options.generation ?? randomUUID;
    this.sessionGeneration = this.createGeneration();
  }

  beginSession(): void {
    this.rotateGeneration();
  }

  publish(force = false): MaestroUiStateSnapshotV1 | undefined {
    const projection = projectMaestroUiState(this.read());
    const fingerprint = JSON.stringify(projection);
    if (!force && fingerprint === this.lastFingerprint) return undefined;

    const snapshot: MaestroUiStateSnapshotV1 = {
      ...this.nextEnvelope(),
      ...projection,
    };
    this.emitSnapshot(MAESTRO_UI_SNAPSHOT_EVENT, snapshot);
    this.lastFingerprint = fingerprint;
    return snapshot;
  }

  publishFull(): MaestroUiStateSnapshotV1 {
    return this.publish(true)!;
  }

  clear(): MaestroUiSnapshotV1 {
    const snapshot: MaestroUiSnapshotV1 = {
      ...this.nextEnvelope(),
      cleared: true,
    };
    this.emitSnapshot(MAESTRO_UI_SNAPSHOT_EVENT, snapshot);
    this.lastFingerprint = undefined;
    return snapshot;
  }

  private nextEnvelope(): Pick<MaestroUiStateSnapshotV1, "version" | "sessionGeneration" | "revision" | "publishedAt"> {
    if (this.revision >= Number.MAX_SAFE_INTEGER) this.rotateGeneration();
    this.revision += 1;
    return {
      version: MAESTRO_UI_SNAPSHOT_VERSION,
      sessionGeneration: this.sessionGeneration,
      revision: this.revision,
      publishedAt: this.now(),
    };
  }

  private rotateGeneration(): void {
    this.sessionGeneration = this.createGeneration();
    this.revision = -1;
    this.lastFingerprint = undefined;
  }
}

export interface MaestroUiQueryEvents {
  on: (
    event: typeof COCKPIT_MAESTRO_QUERY_EVENT,
    listener: (payload: unknown) => void,
  ) => unknown;
}

export function registerMaestroUiQuery(
  events: MaestroUiQueryEvents,
  publisher: MaestroUiPublisher,
  isActive: () => boolean = () => true,
): void {
  events.on(COCKPIT_MAESTRO_QUERY_EVENT, (query: unknown) => {
    const payload = query as { version?: unknown } | null;
    if (payload?.version !== MAESTRO_UI_SNAPSHOT_VERSION || !isActive()) return;
    publisher.publishFull();
  });
}

function projectWorkflow(view: WorkflowViewModel | null | undefined): MaestroWorkflowV1 | null {
  if (!view) return null;
  return {
    session: {
      id: view.sessionId,
      label: view.sessionLabel,
      status: view.status,
    },
    run: view.activeRun ? {
      id: view.activeRun.id,
      command: view.activeRun.command,
      status: view.activeRun.status,
    } : null,
    chain: {
      completed: view.chain.completed,
      running: view.chain.running,
      pending: view.chain.pending,
      total: view.chain.total,
    },
    gates: view.gates ? {
      passed: view.gates.passed,
      total: view.gates.total,
    } : {
      passed: 0,
      total: 0,
    },
    next: view.nextAction ?? view.recoveryAction ?? null,
    ...(view.knowledge ? {
      knowledge: {
        consumed: view.knowledge.consumed,
        cited: view.knowledge.cited,
        validated: view.knowledge.validated,
        contradicted: view.knowledge.contradicted,
        pending: view.knowledge.pendingCandidates,
        corroborated: view.knowledge.corroboratedCandidates,
        review: view.knowledge.reviewRequired,
        promoted: view.knowledge.promotedCandidates,
      },
    } : {}),
  };
}

function projectGoals(entries: readonly GoalDetailEntry[]): MaestroGoalV1[] {
  return [...entries]
    .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
    .map((entry) => ({
      id: entry.id,
      objective: entry.objective,
      status: entry.status,
      ...(entry.pauseReason ? { pauseReason: entry.pauseReason } : {}),
      iteration: entry.iteration,
      tokensUsed: entry.tokensUsed,
      ...(entry.tokenBudget === undefined ? {} : { tokenBudget: entry.tokenBudget }),
      timeUsedSeconds: entry.timeUsedSeconds,
      startedAt: entry.startedAt,
      updatedAt: entry.updatedAt,
    }));
}

function projectSwarm(projection: TeamSwarmProjection | null | undefined): MaestroSwarmV1 | null {
  if (!projection) return null;
  const updatedAt = Date.parse(projection.updatedAt);
  return {
    sessionId: projection.sessionId,
    objective: projection.objective,
    status: projection.status,
    iteration: projection.iteration,
    maxIterations: projection.maxIterations,
    workers: [...new Set(projection.activeWorkers)]
      .sort((left, right) => left.localeCompare(right))
      .map((id) => ({ id, status: "active" })),
    best: projection.best ? {
      workerId: projection.best.antId,
      iteration: projection.best.iteration,
      score: projection.best.score,
      ...(projection.best.summary ? { summary: projection.best.summary } : {}),
    } : null,
    updatedAt: Number.isFinite(updatedAt) && updatedAt >= 0 ? updatedAt : 0,
  };
}

function projectMode(planMode: string, approvalMode: string): MaestroModeV1 {
  return { kind: planMode, label: approvalMode };
}
