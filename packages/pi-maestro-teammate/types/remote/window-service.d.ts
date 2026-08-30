import type { RemoteWorkerIdentity, ResolvedRemoteWorkspace } from "./types.ts";
import type { RuntimeEventDraftV2 } from "../runtime-v2/contracts.ts";
import { type RemoteWindowListParams, type RemoteWindowListResult, type RemoteWindowNotification, type RemoteWindowObserveParams, type RemoteWindowObserveResult, type RemoteWindowReceiptParams, type RemoteWindowReceiptResult, type RemoteWindowSendParams, type RemoteWindowSendResult } from "./window-protocol.ts";
export interface RemoteWindowServiceOptions {
    workspaces: readonly ResolvedRemoteWorkspace[];
    identity: RemoteWorkerIdentity;
    notify: (monitorOwnerNonce: string, notification: RemoteWindowNotification) => void;
    onDomainEvent?: (event: RuntimeEventDraftV2) => void;
    now?: () => number;
    maxRelays?: number;
}
export declare class RemoteWindowService {
    #private;
    constructor(options: RemoteWindowServiceOptions);
    list(params: RemoteWindowListParams): Promise<RemoteWindowListResult>;
    observe(params: RemoteWindowObserveParams): Promise<RemoteWindowObserveResult>;
    send(params: RemoteWindowSendParams): Promise<RemoteWindowSendResult>;
    receipt(params: RemoteWindowReceiptParams): Promise<RemoteWindowReceiptResult>;
    tick(): Promise<void>;
    close(): void;
}
