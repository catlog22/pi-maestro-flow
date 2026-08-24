import { createHash } from "node:crypto";
import type { WorkflowRun, WorkflowSnapshot } from "../session/types.ts";
import { deriveWorkflowStatus } from "../session/view-model.ts";

export interface PublishedPlanIdentity {
  session_id: string;
  run_id: string;
  artifact_id: string;
  source_checksum: string;
  handoff_key: string;
  request_id: string;
}

export function derivePlanPublishRequestId(handoffKey: string): string {
  const normalized = handoffKey.trim();
  if (!normalized) throw new Error("Plan handoff key must be non-empty");
  return `req_plan_publish_${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32)}`;
}

export function parsePublishedPlanIdentity(
  envelope: { ok: boolean; request_id: string | null; result: unknown },
  expectedHandoffKey: string,
  expectedRequestId: string,
): PublishedPlanIdentity {
  const result = parsePublishedPlanResultBase(envelope, expectedRequestId);
  if (result.handoff_key !== expectedHandoffKey) {
    throw new Error("Maestro plan publisher response does not match the approved Plan handoff identity");
  }
  return result as unknown as PublishedPlanIdentity;
}

/** Parse the coordinator's redacted projection after its private correlation check succeeded. */
export function parseProjectedPublishedPlanIdentity(
  envelope: { ok: boolean; request_id: string | null; result: unknown },
  expectedHandoffKey: string,
  expectedRequestId: string,
): PublishedPlanIdentity {
  const result = parsePublishedPlanResultBase(envelope, expectedRequestId, false);
  if ("handoff_key" in result) {
    throw new Error("Public Plan publication result unexpectedly exposed its handoff key");
  }
  return { ...result, handoff_key: expectedHandoffKey } as PublishedPlanIdentity;
}

function parsePublishedPlanResultBase(
  envelope: { ok: boolean; request_id: string | null; result: unknown },
  expectedRequestId: string,
  requireHandoffKey = true,
): Record<string, string> {
  if (!envelope.ok || !isRecord(envelope.result)) {
    throw new Error("Maestro plan publisher did not return a successful result");
  }
  const result = envelope.result;
  const fields = ["session_id", "run_id", "artifact_id", "source_checksum", "request_id"] as const;
  for (const field of requireHandoffKey ? [...fields, "handoff_key"] : fields) {
    if (typeof result[field] !== "string" || !result[field].trim()) {
      throw new Error(`Maestro plan publisher result is missing ${field}`);
    }
  }
  if (envelope.request_id !== expectedRequestId || result.request_id !== expectedRequestId) {
    throw new Error("Maestro plan publisher response does not match the expected request identity");
  }
  return result as Record<string, string>;
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
    || producer.primaryArtifactId !== published.artifact_id
    || !isPublishedPlanHandoff(producer, published)) {
    throw new Error(`Published Plan producer Run ${published.run_id} is not canonical`);
  }
}

export function assertPublishedPlanSnapshotV3(
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
  // session/3.0 + run/3.0: the core `maestro plan publish` CLI drives a real
  // producer Run that seals a plan/1.0 artifact under the current-plan alias.
  // Assert the Artifact Registry actually holds that sealed artifact and the
  // published identity matches it (no synthetic envelope, no goal_ref-only step).
  const session = snapshot.session;
  if (session.aliases["current-plan"] !== published.artifact_id) {
    throw new Error(
      `Published Plan artifact ${published.artifact_id} is not bound to the current-plan alias in Session ${published.session_id}`,
    );
  }
  const artifact = session.artifacts.find((item) => item.artifactId === published.artifact_id);
  if (!artifact) {
    throw new Error(`Published Plan artifact ${published.artifact_id} is missing from Session ${published.session_id} registry`);
  }
  if (artifact.status !== "sealed") {
    throw new Error(`Published Plan artifact ${published.artifact_id} is ${artifact.status}, expected sealed`);
  }
  if (artifact.runId !== published.run_id) {
    throw new Error(
      `Published Plan artifact ${published.artifact_id} producer Run ${artifact.runId} does not match published Run ${published.run_id}`,
    );
  }
  if (artifact.kind !== "plan" || artifact.schemaVersion !== "plan/1.0") {
    throw new Error(
      `Published Plan artifact ${published.artifact_id} is ${artifact.kind}/${artifact.schemaVersion ?? "?"}, expected plan/1.0`,
    );
  }
}

export function requirePublishedExecutionRun(
  snapshot: WorkflowSnapshot,
  published: PublishedPlanIdentity,
): WorkflowRun {
  const session = snapshot.session;
  if (!session) {
    throw new Error("Workflow Plan was published, but no execution Run was allocated");
  }
  const derived = deriveWorkflowStatus(snapshot);
  const execution = derived.authority === "execution-derived" ? snapshot.execution : undefined;
  const activeRunId = derived.authority === "execution-derived"
    ? execution?.activeRunId
    : session.activeRunId;
  const chain = derived.authority === "execution-derived"
    ? execution?.chain
    : session.chain;
  const active = activeRunId
    ? session.runs.find((run) => run.runId === activeRunId)
    : undefined;
  if (!active || !chain) {
    throw new Error("Workflow Plan was published, but no execution Run was allocated");
  }
  const producer = session.runs.find((run) => run.runId === published.run_id);
  const chainSteps = chain.filter((step) => step.runId === active.runId);
  const chainStep = chainSteps[0];
  const producerEndedAt = producer?.endedAt ? Date.parse(producer.endedAt) : Number.NaN;
  const executionStartedAt = Date.parse(active.startedAt);
  if (active.command !== "execute"
    || chainSteps.length !== 1
    || chainStep?.command !== "execute"
    || (derived.authority === "execution-derived"
      && (session.currentExecutionId !== execution?.executionId
        || execution?.sessionId !== session.sessionId))
    || session.aliases["current-plan"] !== published.artifact_id
    || !producer
    || !isPublishedPlanHandoff(producer, published)
    || !Number.isFinite(producerEndedAt)
    || !Number.isFinite(executionStartedAt)
    || executionStartedAt < producerEndedAt) {
    throw new Error(`Active Workflow Run ${active.runId} is not correlated to the published Plan`);
  }
  return active;
}

function isPublishedPlanHandoff(
  producer: WorkflowRun,
  published: PublishedPlanIdentity,
): boolean {
  const handoff = producer.handoff;
  if (typeof published.handoff_key !== "string"
    || !published.handoff_key
    || typeof published.request_id !== "string"
    || !published.request_id
    || !handoff
    || handoff.producer_run_id !== published.run_id
    || handoff.command !== "plan-publish"
    || !["ready", "ready_with_concerns"].includes(String(handoff.verdict))) {
    return false;
  }
  const artifactRefs = Array.isArray(handoff.artifact_refs) ? handoff.artifact_refs : [];
  return artifactRefs.includes(published.artifact_id)
    && producer.planPublication?.requestId === published.request_id
    && producer.planPublication.handoffKeyHash === planHandoffKeyHash(published.handoff_key);
}

function planHandoffKeyHash(handoffKey: string): string {
  return `sha256:${createHash("sha256").update(handoffKey, "utf8").digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
