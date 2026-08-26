export const RUNTIME_V2_VERSION = 2 as const;
export const RUNTIME_V2_REVISION = 1 as const;

export type RuntimeActorKindV2 = "root" | "teammate" | "remote" | "process" | "schedule" | "dispatch";

export interface ActorAddressV2 {
  version: typeof RUNTIME_V2_VERSION;
  revision: typeof RUNTIME_V2_REVISION;
  workspaceId: string;
  actorKind: RuntimeActorKindV2;
  actorId: string;
  generation: number;
}

export type RuntimeCommandKindV2 = "run.start" | "run.input" | "run.cancel" | "process.reclaim";

export interface RuntimeCommandV2 {
  version: typeof RUNTIME_V2_VERSION;
  revision: typeof RUNTIME_V2_REVISION;
  commandId: string;
  streamId: string;
  target: ActorAddressV2;
  kind: RuntimeCommandKindV2;
  issuedAt: number;
  payload?: unknown;
}

interface RuntimeEventBaseV2 {
  version: typeof RUNTIME_V2_VERSION;
  revision: typeof RUNTIME_V2_REVISION;
  streamId: string;
  sequence: number;
  actor: ActorAddressV2;
  producerEpoch?: number;
  occurredAt: number;
}

export interface RuntimeToolStartedEventV2 extends RuntimeEventBaseV2 {
  kind: "tool.started";
  toolCallId: string;
  toolName: string;
}

export interface RuntimeToolFinishedEventV2 extends RuntimeEventBaseV2 {
  kind: "tool.finished";
  toolCallId: string;
  toolName: string;
  outcome: "succeeded" | "failed";
}

export interface RuntimeResultPublishedEventV2 extends RuntimeEventBaseV2 {
  kind: "result.published";
  publicationId: string;
  hasStructuredOutput: boolean;
}

export interface RuntimeRunSettledEventV2 extends RuntimeEventBaseV2 {
  kind: "run.settled";
  outcome: "completed" | "failed" | "cancelled" | "lost";
  error?: string;
}

export interface RuntimeProcessReclaimedEventV2 extends RuntimeEventBaseV2 {
  kind: "process.reclaimed";
  processId: string;
  exitCode: number | null;
  signal: string | null;
}

/**
 * Driver-neutral domain event carried by a durable actor stream. Domain
 * packages own eventType/payload validation; the Runtime Broker owns sequence,
 * lease fencing, and persistence only.
 */
export interface RuntimeDomainEventV2 extends RuntimeEventBaseV2 {
  kind: "domain.event";
  eventType: string;
  eventId: string;
  payload: unknown;
}

export type RuntimeEventV2 =
  | RuntimeToolStartedEventV2
  | RuntimeToolFinishedEventV2
  | RuntimeResultPublishedEventV2
  | RuntimeRunSettledEventV2
  | RuntimeProcessReclaimedEventV2
  | RuntimeDomainEventV2;

export type RuntimeEventDraftV2 = RuntimeEventV2 extends infer Event
  ? Event extends RuntimeEventV2 ? Omit<Event, "sequence" | "producerEpoch"> : never
  : never;

export interface RuntimeLeaseV2 {
  version: typeof RUNTIME_V2_VERSION;
  revision: typeof RUNTIME_V2_REVISION;
  leaseId: string;
  streamId: string;
  holder: ActorAddressV2;
  epoch: number;
  acquiredAt: number;
  expiresAt: number;
}

export interface RuntimeProjectionV2 {
  version: typeof RUNTIME_V2_VERSION;
  revision: typeof RUNTIME_V2_REVISION;
  streamId: string;
  lastSequence: number;
  lifecycle: "pending" | "running" | "settled" | "reclaimed";
  activeToolCallIds: string[];
  resultPublished: boolean;
  outcome?: RuntimeRunSettledEventV2["outcome"];
  updatedAt: number;
}
