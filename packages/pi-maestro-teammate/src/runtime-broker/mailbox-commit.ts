import { createHash, randomUUID } from "node:crypto";
import {
  RuntimeBrokerClient,
  isRuntimeBrokerTransportError,
  type RuntimeBrokerClientOptions,
} from "./client.ts";
import { RuntimeBrokerError, type RuntimeBrokerCommitResult } from "./contracts.ts";
import type { MailboxEnvelope } from "../extension/mailbox/types.ts";

const MAILBOX_COMMIT_LEASE_TTL_MS = 5_000;

export interface RuntimeBrokerMailboxCommitterOptions {
  stateDirectory: string;
  holderId: string;
  clientOptions?: Omit<RuntimeBrokerClientOptions, "stateDirectory">;
  clientFactory?: () => Promise<RuntimeBrokerClient>;
}

export function runtimeBrokerMailboxStreamId(messageId: string): string {
  return `mailbox-message:${createHash("sha256").update(messageId).digest("hex")}`;
}

/** Persists the authoritative mailbox effect before the compatibility consumer publishes it. */
export class RuntimeBrokerMailboxCommitter {
  readonly #options: RuntimeBrokerMailboxCommitterOptions;
  #clientGeneration: MailboxClientGeneration | undefined;
  #clientPromise: Promise<MailboxClientGeneration> | undefined;
  #faultedGeneration: MailboxClientGeneration | undefined;
  #bootstrapFault: Error | undefined;
  readonly #retiredGenerations = new Map<number, MailboxClientGeneration>();
  #nextClientGeneration = 1;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: RuntimeBrokerMailboxCommitterOptions) {
    this.#options = options;
  }

  /** Start the client connection and expose completion for callers that must gate dispatch on readiness. */
  prewarm(): Promise<void> {
    if (this.#closed || this.#clientGeneration) return Promise.resolve();
    return this.#getClient().then(() => undefined, () => undefined);
  }

  commit(envelope: MailboxEnvelope): Promise<RuntimeBrokerCommitResult> {
    const requestIds = mailboxOperationRequestIds();
    return this.#enqueue(() => this.#commit(envelope, requestIds));
  }

  commitIfReady(envelope: MailboxEnvelope): Promise<RuntimeBrokerCommitResult | undefined> {
    const generation = this.#clientGeneration;
    if (!generation) {
      this.prewarm();
      const admissionFault = this.#faultedGeneration?.validationFault ?? this.#bootstrapFault;
      return admissionFault
        ? Promise.reject(admissionFault)
        : Promise.resolve(undefined);
    }

    generation.outstandingWork += 1;
    const requestIds = mailboxOperationRequestIds();
    return this.#enqueue(async () => {
      try {
        return await this.#commitWithClient(envelope, generation.client, requestIds);
      } catch (error) {
        if (error instanceof RuntimeBrokerError) throw error;
        if (!isRuntimeBrokerTransportError(error)) {
          const fault = await this.#latchValidationFault(error, generation);
          throw fault;
        }
        await this.#discardGeneration(generation);
        this.prewarm();
        // Faults belong to the immutable generation captured when this work was
        // admitted. A validated replacement is clean for new work, but cannot
        // make queued work on the invalidated generation fail open.
        if (generation.validationFault) throw generation.validationFault;
        return undefined;
      } finally {
        this.#releaseGeneration(generation);
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    const generation = this.#clientGeneration;
    this.#clientGeneration = undefined;
    this.#clientPromise = undefined;
    this.#faultedGeneration = undefined;
    this.#bootstrapFault = undefined;
    this.#retiredGenerations.clear();
    await generation?.client.close();
  }

  async #commit(
    envelope: MailboxEnvelope,
    requestIds: MailboxOperationRequestIds,
  ): Promise<RuntimeBrokerCommitResult> {
    if (this.#closed) throw new Error("Runtime broker mailbox committer is closed");
    const generation = await this.#getClient();
    if (this.#closed) throw new Error("Runtime broker mailbox committer closed while connecting");
    try {
      return await this.#commitWithClient(envelope, generation.client, requestIds);
    } catch (error) {
      if (!isRuntimeBrokerTransportError(error)) {
        if (!(error instanceof RuntimeBrokerError)) await this.#latchValidationFault(error, generation);
        throw error;
      }
      await this.#discardGeneration(generation);
    }

    const retryGeneration = await this.#getClient();
    try {
      return await this.#commitWithClient(envelope, retryGeneration.client, requestIds);
    } catch (error) {
      if (isRuntimeBrokerTransportError(error)) {
        await this.#discardGeneration(retryGeneration);
      } else if (!(error instanceof RuntimeBrokerError)) {
        await this.#latchValidationFault(error, retryGeneration);
      }
      throw error;
    }
  }

  async #commitWithClient(
    envelope: MailboxEnvelope,
    client: RuntimeBrokerClient,
    requestIds: MailboxOperationRequestIds,
  ): Promise<RuntimeBrokerCommitResult> {
    if (this.#closed) throw new Error("Runtime broker mailbox committer is closed");
    const streamId = runtimeBrokerMailboxStreamId(envelope.messageId);
    const lease = await client.acquireLease({
      actorId: streamId,
      streamId,
      holderId: this.#options.holderId,
      ttlMs: MAILBOX_COMMIT_LEASE_TTL_MS,
    }, requestIds.acquire);
    if (this.#closed) {
      await client.releaseLease({ actorId: streamId, lease }, requestIds.release);
      throw new Error("Runtime broker mailbox committer closed while acquiring its lease");
    }

    let result: RuntimeBrokerCommitResult;
    try {
      result = await client.commit({
        messageId: envelope.messageId,
        actorId: streamId,
        lease,
        streamId,
        expectedRevision: 0,
        events: [{
          eventId: `mailbox-applied:${createHash("sha256").update(envelope.messageId).digest("hex")}`,
          eventType: "mailbox.applied",
          occurredAt: envelope.createdAt,
          correlationId: envelope.correlationId,
          payload: {
            version: 2,
            messageId: envelope.messageId,
            workspaceId: envelope.workspaceId,
            senderId: envelope.senderId,
            recipientCorrelationId: envelope.recipientCorrelationId,
            kind: envelope.kind,
            mode: envelope.mode,
          },
        }],
        inboxResult: {
          state: "applied",
          recipientCorrelationId: envelope.recipientCorrelationId,
        },
      }, requestIds.commit);
    } catch (error) {
      if (!isRuntimeBrokerTransportError(error)) {
        await client.releaseLease({ actorId: streamId, lease }, requestIds.release).catch(() => undefined);
      }
      throw error;
    }

    if (this.#closed) {
      await client.releaseLease({ actorId: streamId, lease }, requestIds.release);
      throw new Error("Runtime broker mailbox committer closed after persisting the mailbox effect");
    }
    await client.releaseLease({ actorId: streamId, lease }, requestIds.release);
    return result;
  }

  async #discardGeneration(generation: MailboxClientGeneration): Promise<void> {
    if (this.#clientGeneration === generation) {
      this.#clientGeneration = undefined;
      this.#clientPromise = undefined;
    }
    generation.closePromise ??= Promise.resolve()
      .then(() => generation.client.close())
      .catch(() => undefined);
    await generation.closePromise;
  }

  async #latchValidationFault(
    error: unknown,
    generation: MailboxClientGeneration,
  ): Promise<Error> {
    const fault = error instanceof Error ? error : new Error(String(error));
    generation.validationFault ??= fault;
    this.#retiredGenerations.set(generation.id, generation);
    if (this.#clientGeneration === generation) {
      this.#clientGeneration = undefined;
      this.#clientPromise = undefined;
      this.#faultedGeneration = generation;
    } else if (!this.#clientGeneration && !this.#faultedGeneration) {
      this.#faultedGeneration = generation;
    }
    await this.#discardGeneration(generation);
    this.prewarm();
    return generation.validationFault;
  }

  #releaseGeneration(generation: MailboxClientGeneration): void {
    generation.outstandingWork -= 1;
    this.#collectRetiredGeneration(generation);
  }

  #collectRetiredGeneration(generation: MailboxClientGeneration): void {
    if (
      generation.outstandingWork === 0
      && this.#clientGeneration !== generation
      && this.#faultedGeneration !== generation
    ) {
      this.#retiredGenerations.delete(generation.id);
    }
  }

  #enqueue<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const queued = this.#tail.then(operation);
    this.#tail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async #getClient(): Promise<MailboxClientGeneration> {
    if (this.#clientGeneration) return this.#clientGeneration;
    // The generation promise, rather than only the raw client promise, is the
    // single-flight unit. Every waiter therefore receives the same immutable
    // wrapper for a physical connection and shares its fault/retirement state.
    const connecting = this.#clientPromise ??= this.#createClientGeneration();
    try {
      return await connecting;
    } catch (error) {
      if (this.#clientPromise === connecting) {
        this.#clientPromise = undefined;
        if (!this.#closed && !isRuntimeBrokerTransportError(error)) {
          const hadAdmissionFault = !!(
            this.#faultedGeneration?.validationFault
            ?? this.#bootstrapFault
          );
          this.#bootstrapFault ??= error instanceof Error ? error : new Error(String(error));
          // Start one replacement for the first validation failure. If that
          // replacement also fails validation, later callers retry while the
          // original admission fault remains latched instead of hot-looping.
          if (!hadAdmissionFault) this.prewarm();
        }
      }
      throw error;
    }
  }

  async #createClientGeneration(): Promise<MailboxClientGeneration> {
    const client = await (this.#options.clientFactory?.()
      ?? RuntimeBrokerClient.connectOrStart({
        ...this.#options.clientOptions,
        stateDirectory: this.#options.stateDirectory,
      }));
    if (this.#closed) {
      await client.close();
      throw new Error("Runtime broker mailbox committer closed while connecting");
    }
    const generation: MailboxClientGeneration = {
      id: this.#nextClientGeneration++,
      client,
      outstandingWork: 0,
    };
    const replacedFault = this.#faultedGeneration;
    this.#clientGeneration = generation;
    // clientFactory/connectOrStart returns only after the broker readiness
    // handshake has validated this replacement connection. Only that fully
    // validated generation clears bootstrap and generation admission faults;
    // merely starting a replacement must never clear either latch.
    this.#faultedGeneration = undefined;
    this.#bootstrapFault = undefined;
    if (replacedFault) this.#collectRetiredGeneration(replacedFault);
    return generation;
  }
}

interface MailboxClientGeneration {
  readonly id: number;
  readonly client: RuntimeBrokerClient;
  outstandingWork: number;
  validationFault?: Error;
  closePromise?: Promise<void>;
}

interface MailboxOperationRequestIds {
  acquire: string;
  commit: string;
  release: string;
}

function mailboxOperationRequestIds(): MailboxOperationRequestIds {
  const invocationId = randomUUID();
  return {
    acquire: `mailbox:lease.acquire:${invocationId}`,
    commit: `mailbox:commit:${invocationId}`,
    release: `mailbox:lease.release:${invocationId}`,
  };
}
