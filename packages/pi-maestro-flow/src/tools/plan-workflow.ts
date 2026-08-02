import { activeWorkflowRun, type WorkflowRun, type WorkflowSnapshot } from "../session/types.ts";

export interface PublishedPlanIdentity {
  session_id: string;
  run_id: string;
  artifact_id: string;
}

export function assertPublishedPlanSnapshot(
  snapshot: WorkflowSnapshot,
  published: PublishedPlanIdentity,
  expectedSessionId?: string,
): void {
  if (expectedSessionId && published.session_id !== expectedSessionId) {
    throw new Error(
      `Published Plan belongs to Workflow Session ${published.session_id}, expected ${expectedSessionId}`,
    );
  }
  if (snapshot.source !== "canonical"
    || snapshot.canonicalClaim?.status !== "valid"
    || snapshot.canonicalClaim.activeSessionId !== published.session_id
    || snapshot.session?.sessionId !== published.session_id) {
    throw new Error(
      `Canonical Workflow Session does not match published Plan Session ${published.session_id}`,
    );
  }
  const artifact = snapshot.session.artifacts.find((candidate) => candidate.artifactId === published.artifact_id);
  if (!artifact
    || artifact.kind !== "plan"
    || artifact.role !== "primary"
    || artifact.status !== "sealed"
    || artifact.runId !== published.run_id
    || snapshot.session.aliases["current-plan"] !== published.artifact_id) {
    throw new Error(`Published Plan artifact ${published.artifact_id} is not the sealed current-plan authority`);
  }
  const producer = snapshot.session.runs.find((run) => run.runId === published.run_id);
  if (!producer
    || producer.command !== "plan-publish"
    || producer.status !== "sealed"
    || producer.primaryArtifactId !== published.artifact_id) {
    throw new Error(`Published Plan producer Run ${published.run_id} is not canonical`);
  }
}

export function requirePublishedExecutionRun(
  snapshot: WorkflowSnapshot,
  published: PublishedPlanIdentity,
): WorkflowRun {
  const session = snapshot.session;
  const active = activeWorkflowRun(snapshot);
  if (!session || !active) {
    throw new Error("Workflow Plan was published, but no execution Run was allocated");
  }
  const producer = session.runs.find((run) => run.runId === published.run_id);
  const chainStep = session.chain.find((step) => step.runId === active.runId);
  const producerEndedAt = producer?.endedAt ? Date.parse(producer.endedAt) : Number.NaN;
  const executionStartedAt = Date.parse(active.startedAt);
  if (active.command !== "execute"
    || chainStep?.command !== "execute"
    || session.aliases["current-plan"] !== published.artifact_id
    || !Number.isFinite(producerEndedAt)
    || !Number.isFinite(executionStartedAt)
    || executionStartedAt < producerEndedAt) {
    throw new Error(`Active Workflow Run ${active.runId} is not correlated to the published Plan`);
  }
  return active;
}
