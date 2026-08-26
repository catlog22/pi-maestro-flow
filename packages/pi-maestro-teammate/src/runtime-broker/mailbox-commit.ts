import { createHash } from "node:crypto";
import { RuntimeBrokerClient, type RuntimeBrokerClientOptions } from "./client.ts";
import type { RuntimeBrokerCommitResult } from "./contracts.ts";
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
  #clientPromise: Promise<RuntimeBrokerClient> | undefined;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: RuntimeBrokerMailboxCommitterOptions) {
    this.#options = options;
  }

  commit(envelope: MailboxEnvelope): Promise<RuntimeBrokerCommitResult> {
    const operation = this.#tail.then(() => this.#commit(envelope));
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    const client = await this.#clientPromise?.catch(() => undefined);
    await client?.close();
  }

  async #commit(envelope: MailboxEnvelope): Promise<RuntimeBrokerCommitResult> {
    if (this.#closed) throw new Error("Runtime broker mailbox committer is closed");
    const client = await this.#getClient();
    if (this.#closed) throw new Error("Runtime broker mailbox committer closed while connecting");
    const streamId = runtimeBrokerMailboxStreamId(envelope.messageId);
    const lease = await client.acquireLease({
      actorId: streamId,
      streamId,
      holderId: this.#options.holderId,
      ttlMs: MAILBOX_COMMIT_LEASE_TTL_MS,
    });
    if (this.#closed) {
      await client.releaseLease({ actorId: streamId, lease });
      throw new Error("Runtime broker mailbox committer closed while acquiring its lease");
    }
    try {
      const result = await client.commit({
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
      });
      if (this.#closed) throw new Error("Runtime broker mailbox committer closed after persisting the mailbox effect");
      return result;
    } finally {
      await client.releaseLease({ actorId: streamId, lease });
    }
  }

  async #getClient(): Promise<RuntimeBrokerClient> {
    this.#clientPromise ??= this.#options.clientFactory?.()
      ?? RuntimeBrokerClient.connectOrStart({
        ...this.#options.clientOptions,
        stateDirectory: this.#options.stateDirectory,
      });
    try {
      return await this.#clientPromise;
    } catch (error) {
      this.#clientPromise = undefined;
      throw error;
    }
  }
}
