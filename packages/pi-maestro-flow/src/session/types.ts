import type { TodoSkillBinding } from "../skills/skill-composer.ts";

export type WorkflowSessionStatus = "planned" | "running" | "sealed" | "archived" | "failed";
export type WorkflowRunStatus = "created" | "running" | "blocked" | "failed" | "completed" | "sealed";
export type WorkflowGateStatus = "pending" | "running" | "passed" | "failed" | "blocked" | "waived" | "skipped";
export type WorkflowExecutionStatus = "active" | "paused" | "sealed";
export type WorkflowExecutionOwnerKind = "pi" | "claude" | "codex" | "agy" | "manual";
export type WorkflowLifecycleAuthority = "legacy-session" | "execution-derived";

export interface WorkflowGate {
  id: string;
  runId?: string;
  phase?: "entry" | "phase" | "exit" | "transition" | "knowledge" | "session";
  blocking: boolean;
  status: WorkflowGateStatus;
  source?: "contract" | "prepared" | "handoff";
}

export interface WorkflowChainStep {
  step: string;
  command: string;
  status: string;
  runId: string | null;
  skill?: string;
  /** session/3.0 decision gate: the decision id that must resolve before the chain advances past this step. */
  decisionRef?: string | null;
}

export interface WorkflowRun {
  schemaVersion?: string;
  /** Run entity revision for session/3.0 CAS mutations (run.json revision). */
  revision?: number;
  runId: string;
  /** v2 command-run lineage only; run/3.0 expresses lineage via retryOfRunId/attempt instead. */
  parentRunId?: string | null;
  /** run/3.0 retry lineage: the run id this run retries (null when it is not a retry). */
  retryOfRunId?: string | null;
  /** run/3.0 attempt ordinal (positive). */
  attempt?: number;
  command: string;
  status: WorkflowRunStatus;
  goal: string | null;
  args: string[];
  gates: WorkflowGate[];
  primaryArtifactId: string | null;
  handoff: Record<string, unknown> | null;
  /** Redacted exact-correlation metadata for canonical Plan producer Runs. */
  planPublication?: {
    requestId: string;
    handoffKeyHash: string;
  };
  startedAt: string;
  endedAt: string | null;
}

export interface WorkflowArtifact {
  artifactId: string;
  kind: string;
  role: string;
  runId: string;
  path: string;
  hash: string;
  status: string;
  replaces: string | null;
}

export interface WorkflowSession {
  schemaVersion?: string;
  sessionId: string;
  intent: string;
  /** Persisted lifecycle authority for session/1.x only; omitted at runtime for session/2.0. */
  status: WorkflowSessionStatus;
  lifecycleAuthority?: WorkflowLifecycleAuthority;
  revision: number;
  /** Legacy session/1.x and session/2.0 identity fence, when projected separately from activity. */
  identityRevision?: number;
  orchestrationRevision?: number;
  activityRevision?: number;
  /** session/2.0 Execution/history pointers. */
  currentExecutionId?: string | null;
  latestExecutionId?: string | null;
  latestCompletedRunId?: string | null;
  archivedAt?: string | null;
  archivedBy?: string | null;
  activeRunId: string | null;
  definitionOfDone: string;
  chain: WorkflowChainStep[];
  runs: WorkflowRun[];
  artifacts: WorkflowArtifact[];
  aliases: Record<string, string>;
}

export interface WorkflowDecisionPoint {
  pointId: string;
  afterStepId: string | null;
  status: "pending" | "passed" | "escalated";
  retryCount: number;
  maxRetries: number;
  evidenceRef: string | null;
}

/** Public Execution lease metadata. The private lease_id is never projected. */
export interface WorkflowExecutionLease {
  schemaVersion?: string;
  sessionId: string;
  executionId: string;
  ownerId: string;
  ownerKind: WorkflowExecutionOwnerKind;
  epoch: number;
  acquiredAt: string;
  /**
   * @deprecated Long-lived lease heartbeats are superseded by the Session/Run
   * minimal-state architecture (docs/session-run-minimal-state-architecture-20260812.md):
   * v3 removes leases/heartbeats in favor of participant identity and
   * fine-grained revision CAS. Removed in v3.
   */
  heartbeatAt: string;
  /**
   * @deprecated Lease handoff is superseded by the Session/Run minimal-state
   * architecture (docs/session-run-minimal-state-architecture-20260812.md):
   * v3 has no handoff; other participants simply submit CAS mutations.
   * Removed in v3.
   */
  handoffTo: string | null;
}

export interface WorkflowExecution {
  schemaVersion?: string;
  executionId: string;
  sessionId: string;
  generation: number;
  status: WorkflowExecutionStatus;
  revision: number;
  activeRunId: string | null;
  chain: WorkflowChainStep[];
  decisionPoints: WorkflowDecisionPoint[];
  gatesRef: string;
  artifactsRef: string;
  evidenceRef: string;
  lease: WorkflowExecutionLease | null;
  startedAt: string;
  sealedAt: string | null;
  sealSummary: string | null;
  finalOutcome: "done" | "done_with_concerns" | "failed" | null;
  /** True only for the deterministic compatibility projection of session/1.x. */
  legacyProjection?: true;
}

export interface WorkflowSnapshotRevision {
  sessionRevision: number;
  executionRevision?: number;
  fingerprint: string;
}

export interface WorkflowSnapshotLocator {
  sessionId: string;
  executionId?: string;
  generation?: number;
  runId?: string;
}

export interface WorkflowCanonicalClaim {
  activeSessionId?: string;
  status: "valid" | "invalid";
  error?: string;
}

export interface WorkflowSnapshot {
  source: "canonical" | "legacy" | "none";
  projectRoot: string;
  loadedAt: string;
  revision: WorkflowSnapshotRevision;
  /** Stable identity boundary for consumers that own projected session state. */
  sessionGeneration?: string;
  /** Present whenever state.json authoritatively declares an active canonical Session. */
  canonicalClaim?: WorkflowCanonicalClaim;
  /** Canonical Session/Execution/Run identity for execution-aware consumers. */
  locator?: WorkflowSnapshotLocator;
  session?: WorkflowSession;
  /** Current Execution, or a deterministic compatibility projection for session/1.x. */
  execution?: WorkflowExecution;
  diagnostics: string[];
}

export interface TodoTaskOrigin {
  sessionId: string;
  /** Projection identity boundary; absent on persisted legacy Todo mirrors. */
  sessionGeneration?: string;
  runId?: string;
  runSeq?: string;
  step: string;
}

export interface TodoMirrorTaskSpec {
  origin: TodoTaskOrigin;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  blockedByOriginKeys: string[];
  context?: string;
  skills: TodoSkillBinding[];
  summary?: string;
}

export function todoOriginKey(origin: TodoTaskOrigin): string {
  const legacyKey = [origin.sessionId, origin.step, origin.runId ?? "", origin.runSeq ?? ""].join("\u0000");
  return origin.sessionGeneration === undefined
    ? legacyKey
    : `${legacyKey}\u0000${origin.sessionGeneration}`;
}

export function activeWorkflowRun(snapshot: WorkflowSnapshot): WorkflowRun | undefined {
  const activeRunId = snapshot.execution?.legacyProjection
    ? snapshot.session?.activeRunId
    : snapshot.execution?.activeRunId ?? snapshot.session?.activeRunId;
  return activeRunId ? snapshot.session?.runs.find((run) => run.runId === activeRunId) : undefined;
}
