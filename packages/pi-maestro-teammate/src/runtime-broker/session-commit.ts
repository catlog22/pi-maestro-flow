import type { RuntimeEventDraftV2, RuntimeDomainEventV2 } from "../runtime-v2/contracts.ts";
import { parseRuntimeEventV2 } from "../runtime-v2/validation.ts";
import {
  assertJsonValue,
  type JsonValue,
  type LeaseCredential,
  type RuntimeBrokerCommitRequest,
  type RuntimeBrokerCommitResult,
} from "./contracts.ts";
import {
  parseSessionDomainPayloadV2,
  type SessionDomainEventTypeV2,
  type SessionDomainReadModelSnapshotV2,
} from "../runtime-v2/session-domain.ts";

export interface SessionDomainBrokerCommitPort {
  commit(request: RuntimeBrokerCommitRequest, requestId?: string): Promise<RuntimeBrokerCommitResult>;
}

export interface SessionDomainOutboxDraft {
  outboxId: string;
  destination: string;
  payload: unknown;
  availableAt?: number;
}

export interface SessionDomainBrokerCommitterOptions {
  port: SessionDomainBrokerCommitPort;
  actorId: string;
  lease: LeaseCredential;
  streamId: string;
  revision?: number;
  projectionId?: string;
}

/** Atomically commits one validated session event, its projection, and optional transport outbox. */
export class SessionDomainBrokerCommitter {
  readonly #port: SessionDomainBrokerCommitPort;
  readonly #actorId: string;
  readonly #lease: LeaseCredential;
  readonly #streamId: string;
  readonly #projectionId: string;
  #revision: number;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: SessionDomainBrokerCommitterOptions) {
    this.#port = options.port;
    this.#actorId = options.actorId;
    this.#lease = { ...options.lease };
    this.#streamId = options.streamId;
    this.#revision = options.revision ?? 0;
    this.#projectionId = options.projectionId ?? `session-domain:${options.streamId}`;
    if (!this.#actorId || !this.#streamId || !Number.isSafeInteger(this.#revision) || this.#revision < 0) {
      throw new Error("Invalid Runtime V2 session broker committer options");
    }
  }

  get revision(): number { return this.#revision; }

  commit(input: {
    messageId: string;
    event: RuntimeEventDraftV2;
    projection: SessionDomainReadModelSnapshotV2;
    outbox?: readonly SessionDomainOutboxDraft[];
    requestId?: string;
  }): Promise<RuntimeBrokerCommitResult> {
    let result!: RuntimeBrokerCommitResult;
    const run = this.#tail.then(async () => {
      if (input.event.kind !== "domain.event") throw new Error("Session broker accepts domain events only");
      if (input.event.streamId !== this.#streamId) throw new Error("Session broker event stream mismatch");
      const eventType = input.event.eventType as SessionDomainEventTypeV2;
      parseSessionDomainPayloadV2(eventType, input.event.payload);
      const persisted = parseRuntimeEventV2({
        ...input.event,
        sequence: this.#revision + 1,
        producerEpoch: this.#lease.epoch,
      }) as RuntimeDomainEventV2;
      const eventPayload = structuredClone(persisted);
      const projectionValue = structuredClone(input.projection);
      assertJsonValue(eventPayload, "sessionDomainEvent");
      assertJsonValue(projectionValue, "sessionDomainProjection");
      const outbox = input.outbox?.map((draft) => {
        const payload = structuredClone(draft.payload);
        assertJsonValue(payload, "sessionDomainOutbox");
        return {
          outboxId: draft.outboxId,
          destination: draft.destination,
          payload: payload as JsonValue,
          eventId: persisted.eventId,
          ...(draft.availableAt === undefined ? {} : { availableAt: draft.availableAt }),
        };
      });
      const request: RuntimeBrokerCommitRequest = {
        messageId: input.messageId,
        actorId: this.#actorId,
        lease: this.#lease,
        streamId: this.#streamId,
        expectedRevision: this.#revision,
        events: [{
          eventId: persisted.eventId,
          eventType: persisted.kind,
          payload: eventPayload as JsonValue,
          occurredAt: persisted.occurredAt,
        }],
        ...(outbox === undefined ? {} : { outbox }),
        projections: [{ projectionId: this.#projectionId, value: projectionValue as JsonValue }],
        inboxResult: {
          eventType: persisted.eventType,
          sequence: persisted.sequence,
        },
      };
      result = await this.#port.commit(request, input.requestId);
      if (result.streamId !== this.#streamId || result.revision < this.#revision) {
        throw new Error("Runtime broker returned an invalid session commit result");
      }
      this.#revision = result.revision;
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run.then(() => result);
  }
}
