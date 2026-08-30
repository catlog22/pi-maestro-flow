import type { RemoteConnectionFactory } from "../remote/driver.ts";
import { type RemoteWindowBridgeDiagnosticCode, type RemoteWindowCapture, type RemoteWindowListing, type RemoteWindowMessageNotification, type RemoteWindowNotification, type RemoteWindowObserveResult, type RemoteWindowReceipt } from "../remote/protocol.ts";
import type { RemoteConfig } from "../remote/config.ts";
import type { SessionMessageKind, SessionMessageMode, SessionMessageSource } from "../sessions/session-core.ts";
export interface RemoteWindowMonitorListing extends RemoteWindowListing {
    target: string;
    workspaceRef: string;
    authorityId: string;
}
export interface RemoteWindowMonitorDiagnostic {
    workspaceRef: string;
    code: RemoteWindowBridgeDiagnosticCode | "transport";
    message: string;
}
export interface RemoteWindowMonitorListResult {
    windows: readonly RemoteWindowMonitorListing[];
    diagnostics: readonly RemoteWindowMonitorDiagnostic[];
}
export interface RemoteWindowMonitorOptions {
    config: RemoteConfig;
    connectionFactory: RemoteConnectionFactory & {
        close?(): Promise<void>;
    };
    monitorOwnerNonce: string;
    isCurrent: () => boolean;
    onNotification?: (target: string, notification: RemoteWindowNotification) => void;
    commandIdFactory?: () => string;
}
declare function stableTarget(capture: Pick<RemoteWindowCapture, "workspaceRef" | "ownerId">): string;
declare function parseTarget(target: string): {
    workspaceRef: string;
    ownerId: string;
} | undefined;
export declare class RemoteWindowMonitor {
    #private;
    constructor(options: RemoteWindowMonitorOptions);
    list(signal?: AbortSignal): Promise<RemoteWindowMonitorListResult>;
    capture(target: string): RemoteWindowCapture | undefined;
    listing(target: string): RemoteWindowMonitorListing | undefined;
    listings(): readonly RemoteWindowMonitorListing[];
    observe(target: string): Promise<RemoteWindowObserveResult>;
    send(target: string, mode: Extract<SessionMessageMode, "steer" | "follow_up">, message: string, options: {
        messageId: string;
        source: SessionMessageSource;
        messageKind: SessionMessageKind;
        ttlMs?: number;
    }): Promise<RemoteWindowReceipt>;
    receipt(target: string, messageId: string): Promise<RemoteWindowReceipt | undefined>;
    acknowledge(target: string, notification: RemoteWindowMessageNotification): Promise<boolean>;
    close(): Promise<void>;
}
export { parseTarget as parseRemoteWindowTarget, stableTarget as remoteWindowTarget };
