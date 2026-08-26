import type { MailboxAuthority } from "../extension/mailbox/router.ts";
import { MailboxService } from "../extension/mailbox/service.ts";
import {
  type MailboxEnvelope,
  type MailboxState,
  MAX_DISPATCH_RETRIES,
} from "../extension/mailbox/types.ts";
import type {
  RuntimeTransport,
  RuntimeTransportDeliveryState,
  RuntimeTransportDispatch,
  RuntimeTransportEnqueueRequest,
  RuntimeTransportEnqueueResult,
} from "./transport.ts";

const DELIVERY_STATES: readonly MailboxState[] = [
  "staging",
  "ready",
  "claimed",
  "accepted",
  "applied",
  "rejected",
  "expired",
  "dead",
];

export interface FileRuntimeTransportOptions {
  rootDir: string;
  authority: MailboxAuthority;
  recipientCorrelationId: string;
  workspaceId: string;
  teamId: string;
  ownerId: string;
  pollMs?: number;
  now?: () => number;
}

/** File-backed compatibility adapter. It does not alter mailbox production wiring. */
export class FileRuntimeTransport implements RuntimeTransport {
  readonly driver = "file" as const;
  readonly #service: MailboxService;
  #dispatch: RuntimeTransportDispatch | undefined;
  #consuming = false;
  readonly #messageTransitions = new Map<string, Promise<void>>();
  readonly #dispatchFailures = new Map<string, number>();

  constructor(options: FileRuntimeTransportOptions) {
    this.#service = new MailboxService({
      ...options,
      onDispatch: async (envelope) => {
        const dispatch = this.#dispatch;
        if (!dispatch) throw new Error("runtime transport consumer is not registered");
        try {
          await dispatch(envelope);
          this.#dispatchFailures.delete(envelope.messageId);
        } catch (error) {
          // An external IPC consumer can acknowledge while its local dispatch
          // promise is still settling. Once that ack made the message applied,
          // a later local rejection must not resurrect it through mailbox retry.
          if (await this.#service.store.readEnvelope("applied", envelope.messageId)) return;
          return this.#settleDispatchRejection(envelope, error);
        }
      },
    });
  }

  async enqueue(request: RuntimeTransportEnqueueRequest): Promise<RuntimeTransportEnqueueResult> {
    // Compatibility callers may enqueue before registering a consumer. Initialize
    // the durable directories without starting mailbox consumption or authority.
    await this.#service.start(false);
    return this.#service.enqueue(request);
  }

  async consume(dispatch: RuntimeTransportDispatch): Promise<void> {
    if (this.#consuming) throw new Error("runtime transport consumer is already running");
    this.#dispatch = dispatch;
    this.#consuming = true;
    try {
      await this.#service.start();
    } catch (error) {
      this.#dispatch = undefined;
      this.#consuming = false;
      throw error;
    }
  }

  acknowledge(messageId: string): Promise<boolean> {
    return this.#withMessageTransition(messageId, async () => {
      const applied = await this.#service.acknowledge(messageId);
      if (applied) this.#dispatchFailures.delete(messageId);
      return applied;
    });
  }

  async state(messageId: string): Promise<RuntimeTransportDeliveryState | undefined> {
    for (const state of DELIVERY_STATES) {
      if (await this.#service.store.readEnvelope(state, messageId)) return state;
    }
    return undefined;
  }

  hasPendingMessages(): Promise<boolean> {
    return this.#service.hasPendingMail();
  }

  async stop(): Promise<void> {
    await this.#service.stop();
    this.#dispatch = undefined;
    this.#consuming = false;
    this.#dispatchFailures.clear();
  }

  async #settleDispatchRejection(envelope: MailboxEnvelope, error: unknown): Promise<"deferred"> {
    await this.#withMessageTransition(envelope.messageId, async () => {
      if (await this.#service.store.readEnvelope("applied", envelope.messageId)) {
        this.#dispatchFailures.delete(envelope.messageId);
        return;
      }
      if (!(await this.#service.store.readEnvelope("accepted", envelope.messageId))) return;

      const failures = (this.#dispatchFailures.get(envelope.messageId) ?? 0) + 1;
      if (failures >= MAX_DISPATCH_RETRIES) {
        this.#dispatchFailures.delete(envelope.messageId);
        await this.#service.store.dead(
          envelope.messageId,
          "accepted",
          `dispatch retries exceeded: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }

      this.#dispatchFailures.set(envelope.messageId, failures);
      await this.#service.store.remove("accepted", envelope.messageId);
      await this.#service.store.writeStaging(envelope);
      await this.#service.store.promoteToReady(envelope.messageId);
    });
    return "deferred";
  }

  async #withMessageTransition<T>(messageId: string, transition: () => Promise<T>): Promise<T> {
    const previous = this.#messageTransitions.get(messageId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#messageTransitions.set(messageId, current);
    await previous;
    try {
      return await transition();
    } finally {
      release();
      if (this.#messageTransitions.get(messageId) === current) {
        this.#messageTransitions.delete(messageId);
      }
    }
  }
}

export function createFileRuntimeTransport(options: FileRuntimeTransportOptions): FileRuntimeTransport {
  return new FileRuntimeTransport(options);
}
