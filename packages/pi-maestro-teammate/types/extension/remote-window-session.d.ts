import type { RemoteWindowMessageNotification, RemoteWindowReceiptStatus } from "../remote/window-protocol.ts";
import type { MessageProvenanceV1 } from "../shared/types.ts";
import type { SessionMessageKind, WindowThreadEntryInput, WindowThreadStatus } from "../sessions/session-core.ts";
export declare function remoteWindowReceiptThreadStatus(status: RemoteWindowReceiptStatus): WindowThreadStatus;
export declare function remoteWindowIncomingThreadEntry(notification: RemoteWindowMessageNotification, target: string, options: {
    messageKind: SessionMessageKind;
    provenance: MessageProvenanceV1;
    status: WindowThreadStatus;
    updatedAt: number;
    targetSessionId?: string;
    effectiveMode?: "steer" | "follow_up";
}): WindowThreadEntryInput;
