import type { RemoteWindowMessageNotification, RemoteWindowReceiptStatus } from "../remote/window-protocol.ts";
import type { MessageProvenanceV1 } from "../shared/types.ts";
import { WORKSPACE_MAIN_SESSION_MARKER } from "../sessions/workspace-peer-core.ts";
import type {
  SessionMessageKind,
  WindowThreadEntryInput,
  WindowThreadStatus,
} from "../sessions/session-core.ts";

export function remoteWindowReceiptThreadStatus(status: RemoteWindowReceiptStatus): WindowThreadStatus {
  if (status === "injected") return "injected";
  if (status === "replied") return "replied";
  if (status === "rejected") return "rejected";
  if (status === "expired") return "timeout";
  return "queued";
}

export function remoteWindowIncomingThreadEntry(
  notification: RemoteWindowMessageNotification,
  target: string,
  options: {
    messageKind: SessionMessageKind;
    provenance: MessageProvenanceV1;
    status: WindowThreadStatus;
    updatedAt: number;
    targetSessionId?: string;
    effectiveMode?: "steer" | "follow_up";
  },
): WindowThreadEntryInput {
  return {
    messageId: notification.messageId,
    workspaceId: notification.capture.workspaceId,
    peerOwnerId: notification.capture.ownerId,
    peerOwnerNonce: notification.capture.ownerNonce,
    direction: "incoming",
    source: notification.source,
    messageKind: options.messageKind,
    provenance: options.provenance,
    traceId: notification.inReplyTo,
    replyTo: target,
    ...(options.targetSessionId === undefined ? {} : { targetSessionId: options.targetSessionId }),
    targetCorrelationId: WORKSPACE_MAIN_SESSION_MARKER,
    mode: notification.mode,
    ...(options.effectiveMode === undefined ? {} : { effectiveMode: options.effectiveMode }),
    body: notification.message,
    status: options.status,
    createdAt: notification.createdAt,
    updatedAt: options.updatedAt,
  };
}
