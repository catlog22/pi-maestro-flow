import type { TodoSkillBinding } from "../skills/skill-composer.ts";

export type WorkflowSessionStatus = "planned" | "running" | "paused" | "sealed" | "archived" | "failed";
export type WorkflowRunStatus = "created" | "running" | "blocked" | "failed" | "completed" | "sealed";
export type WorkflowGateStatus = "pending" | "running" | "passed" | "failed" | "blocked" | "waived" | "skipped";

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
}

export interface WorkflowRun {
  schemaVersion?: string;
  runId: string;
  parentRunId: string | null;
  command: string;
  status: WorkflowRunStatus;
  goal: string | null;
  args: string[];
  gates: WorkflowGate[];
  primaryArtifactId: string | null;
  handoff: Record<string, unknown> | null;
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
  status: WorkflowSessionStatus;
  revision: number;
  identityRevision?: number;
  activityRevision?: number;
  activeRunId: string | null;
  definitionOfDone: string;
  gates: WorkflowGate[];
  chain: WorkflowChainStep[];
  runs: WorkflowRun[];
  artifacts: WorkflowArtifact[];
  aliases: Record<string, string>;
}

export interface WorkflowSnapshotRevision {
  sessionRevision: number;
  fingerprint: string;
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
  session?: WorkflowSession;
  diagnostics: string[];
}

export interface TodoTaskOrigin {
  sessionId: string;
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
  return [origin.sessionId, origin.step, origin.runId ?? "", origin.runSeq ?? ""].join("\u0000");
}

export function activeWorkflowRun(snapshot: WorkflowSnapshot): WorkflowRun | undefined {
  const activeRunId = snapshot.session?.activeRunId;
  return activeRunId ? snapshot.session?.runs.find((run) => run.runId === activeRunId) : undefined;
}
