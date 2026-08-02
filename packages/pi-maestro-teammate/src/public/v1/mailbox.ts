/**
 * Public v1 mailbox API — versioned interface for external consumers (Flow host).
 *
 * Flow imports ONLY this subpath (`pi-maestro-teammate/v1/mailbox`).
 * The teammate package never imports from Flow.
 */

// Re-export types needed by external consumers
export type {
  MailboxCapability,
  MailboxServiceOptions,
} from "../../extension/mailbox/service.ts";

export {
  MailboxService,
  negotiateCapability,
  MAILBOX_CAPABILITY_HEADER,
} from "../../extension/mailbox/service.ts";

export type {
  MailboxEnvelope,
  MailboxEnqueueResult,
  MailboxMessageKind,
  MailboxDeliveryMode,
  MailboxPriority,
  MailboxState,
  MailboxPaths,
} from "../../extension/mailbox/types.ts";

export {
  MAILBOX_SCHEMA_VERSION,
  priorityForKind,
} from "../../extension/mailbox/types.ts";

export type { MailboxAuthority, MailboxEnqueueRequest } from "../../extension/mailbox/router.ts";

// --- Host Registry Interface ---

/**
 * Minimal interface the Flow host uses to interact with the mailbox.
 * Decoupled from the full MailboxService to keep the public surface small.
 */
export interface MailboxHostRegistry {
  /** Enqueue a task notification for an agent. */
  enqueueTaskNotification(request: {
    senderId: string;
    recipientId: string;
    recipientCorrelationId: string;
    payload: string;
    taskId?: string;
  }): Promise<MailboxEnqueueResult>;

  /** Query pending mail count for an agent. */
  pendingCount(recipientCorrelationId: string): Promise<number>;

  /** Negotiate capability with a peer. */
  negotiate(remoteCapability: string | undefined): MailboxCapability;
}

import { negotiateCapability as _negotiateCapability } from "../../extension/mailbox/service.ts";
import type { MailboxCapability, MailboxServiceOptions } from "../../extension/mailbox/service.ts";
import type { MailboxEnqueueResult } from "../../extension/mailbox/types.ts";

/**
 * Create a host registry backed by a MailboxService instance.
 * Called by the Flow extension host during initialization.
 */
export function createMailboxHostRegistry(
  service: import("../../extension/mailbox/service.ts").MailboxService,
  localCapability: MailboxCapability = "v2",
): MailboxHostRegistry {
  return {
    async enqueueTaskNotification(request) {
      return service.enqueue({
        senderId: request.senderId,
        recipientId: request.recipientId,
        recipientCorrelationId: request.recipientCorrelationId,
        kind: "task",
        mode: "notify",
        payload: request.payload,
        correlationId: request.taskId,
      });
    },

    async pendingCount(recipientCorrelationId) {
      // The service's pendingCount is for its own recipient;
      // for querying other recipients, count ready messages directly.
      const ready = await service.store.listMessages("ready");
      let count = 0;
      for (const id of ready) {
        const envelope = await service.store.readEnvelope("ready", id);
        if (envelope?.recipientCorrelationId === recipientCorrelationId) count++;
      }
      return count;
    },

    negotiate(remoteCapability) {
      return _negotiateCapability(localCapability, remoteCapability as MailboxCapability | undefined);
    },
  };
}
