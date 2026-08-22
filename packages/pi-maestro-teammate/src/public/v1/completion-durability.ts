import { createHash } from "node:crypto";

export const COMPLETION_DURABILITY_VERSION = 1 as const;
export const COMPLETION_DURABILITY_REGISTRY_KEY = Symbol.for(
  "pi-maestro-teammate.completion-durability-registry.v1",
);

export type CompletionMode = "single" | "parallel" | "chain" | "graph";
export type CompletionKind = "single" | "graph" | "additional" | "failure";
export type CompletionOutcome = "completed" | "failed" | "terminated";
export type CompletionReplyTarget = "main" | "caller";

export interface CompletionTarget {
  workspaceId: string;
  sessionId: string;
  correlationId?: string;
}

export interface CompletionResource {
  correlationId: string;
  publicationId: string;
  uri: `agent://${string}`;
  originCwd: string;
  name?: string;
  agent?: string;
  summary: string;
  outcome: CompletionOutcome;
}

export interface CompletionDispatchSeed {
  dispatchId: string;
  deliveryGroupId: string;
  reservationId: string;
  mode: CompletionMode;
  target: CompletionTarget;
  replyTarget: CompletionReplyTarget;
  originCwd: string;
  expectedTasks: readonly string[];
  createdAt: number;
}

export interface CompletionDispatchHandle {
  dispatchId: string;
  reservationId: string;
  deliveryGroupId: string;
}

export interface CompletionNotificationRequirement {
  dispatchId: string;
  reservationId: string;
  kind: CompletionKind;
  requiredAt: number;
}

export interface CompletionPublicationInput {
  dispatchId: string;
  reservationId: string;
  resource: CompletionResource;
  stagedAt: number;
}

export interface CompletionPublicationCommit {
  dispatchId: string;
  reservationId: string;
  publicationId: string;
  committedAt: number;
}

export interface CompletionFinalizeInput {
  dispatchId: string;
  reservationId: string;
  kind: CompletionKind;
  outcome: CompletionOutcome;
  summary: string;
  resources: readonly CompletionResource[];
  finalizedAt: number;
}

export interface CompletionIntent {
  version: typeof COMPLETION_DURABILITY_VERSION;
  deliveryId: string;
  dispatchId: string;
  reservationId: string;
  mode: CompletionMode;
  kind: CompletionKind;
  target: CompletionTarget;
  replyTarget: CompletionReplyTarget;
  outcome: CompletionOutcome;
  summary: string;
  resources: readonly CompletionResource[];
  createdAt: number;
  finalizedAt: number;
  contentRevision: string;
}

export function computeCompletionDeliveryId(
  intent: Pick<CompletionIntent, "dispatchId" | "reservationId" | "kind" | "target" | "resources">,
): string {
  return createHash("sha256").update(JSON.stringify({
    dispatchId: intent.dispatchId,
    reservationId: intent.reservationId,
    kind: intent.kind,
    target: intent.target,
    publications: intent.resources.map((resource) => resource.publicationId),
  }), "utf8").digest("hex");
}

export function computeCompletionIntentRevision(
  intent: Omit<CompletionIntent, "contentRevision">,
): string {
  return createHash("sha256").update(JSON.stringify(intent), "utf8").digest("hex");
}

export interface CompletionAppliedReceipt {
  deliveryId: string;
  dispatchId: string;
  target: CompletionTarget;
  contentRevision: string;
  appliedAt: number;
}

export interface CompletionAbandonInput {
  dispatchId: string;
  reservationId: string;
  reason: string;
  abandonedAt: number;
}

export interface CompletionDurabilityProvider {
  beginDispatch(seed: CompletionDispatchSeed): Promise<CompletionDispatchHandle>;
  requireNotification(input: CompletionNotificationRequirement): Promise<void>;
  stagePublication(input: CompletionPublicationInput): Promise<void>;
  commitPublication(input: CompletionPublicationCommit): Promise<void>;
  finalizeDelivery(input: CompletionFinalizeInput): Promise<CompletionIntent>;
  listRecoverable(target: CompletionTarget): Promise<readonly CompletionIntent[]>;
  acknowledgeApplied(receipt: CompletionAppliedReceipt): Promise<void>;
  abandonDispatch(input: CompletionAbandonInput): Promise<void>;
  prune(now: number): Promise<void>;
}

export interface CompletionDurabilityRegistrySnapshot {
  generation: number;
  provider?: CompletionDurabilityProvider;
}

export type CompletionDurabilityRegistryListener = (
  snapshot: CompletionDurabilityRegistrySnapshot,
) => void;

export interface CompletionDurabilityRegistry {
  current(): CompletionDurabilityProvider | undefined;
  snapshot(): CompletionDurabilityRegistrySnapshot;
  register(provider: CompletionDurabilityProvider): () => void;
  subscribe(listener: CompletionDurabilityRegistryListener): () => void;
}

export {
  CompletionDurabilityRegistryImpl,
  getCompletionDurabilityRegistry,
} from "../../completion-outbox/registry.ts";
