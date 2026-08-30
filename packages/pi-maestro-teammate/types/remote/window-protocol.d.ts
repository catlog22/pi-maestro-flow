import { type WorkspaceOwnerSnapshot, type WorkspacePeerCommandAction, type WorkspacePeerDeliveryStage, type WorkspacePeerMessageKind, type WorkspacePeerMessageSource } from "../sessions/workspace-peer-core.ts";
export declare const REMOTE_WINDOW_TRANSPORT_VERSION: 1;
export declare const REMOTE_WINDOW_MAX_MESSAGE_BYTES: number;
export declare const REMOTE_WINDOW_MAX_RECEIPT_DETAIL_BYTES: number;
export declare const REMOTE_WINDOW_CAPABILITIES: readonly ["observe", "steer", "follow_up", "receipt", "reply"];
export type RemoteWindowCapability = typeof REMOTE_WINDOW_CAPABILITIES[number];
export type RemoteWindowMode = WorkspacePeerCommandAction;
export type RemoteWindowReceiptStatus = "queued" | "injected" | "replied" | "rejected" | "expired" | "unknown";
/** Complete immutable route fence for one externally-owned Pi root window. */
export interface RemoteWindowCapture {
    workspaceRef: string;
    authorityId: string;
    gatewayWorkerId: string;
    gatewayInstanceNonce: string;
    monitorOwnerNonce: string;
    workspaceId: string;
    ownerId: string;
    ownerNonce: string;
    generation: number;
    transportVersion: typeof REMOTE_WINDOW_TRANSPORT_VERSION;
    capabilities: readonly RemoteWindowCapability[];
    /** External Pi windows are never lifecycle-owned by the SSH Monitor. */
    cancel: false;
}
export interface RemoteWindowListing {
    capture: RemoteWindowCapture;
    sessionId?: string;
    sessionName?: string;
    status: "running" | "sleeping";
    agentCount: number;
    publishedAt: number;
    cancel: false;
}
export interface RemoteWindowReceipt {
    capture: RemoteWindowCapture;
    messageId: string;
    requestedMode: RemoteWindowMode;
    effectiveMode?: RemoteWindowMode;
    status: RemoteWindowReceiptStatus;
    updatedAt: number;
    expiresAt: number;
    relayId?: string;
    detail?: string;
}
export interface RemoteWindowListParams {
    commandId: string;
    monitorOwnerNonce: string;
    workspaceRef: string;
    authorityId: string;
    transportVersion: typeof REMOTE_WINDOW_TRANSPORT_VERSION;
}
export interface RemoteWindowListResult {
    windows: readonly RemoteWindowListing[];
}
export interface RemoteWindowObserveParams {
    commandId: string;
    monitorOwnerNonce: string;
    capture: RemoteWindowCapture;
}
export interface RemoteWindowObserveResult {
    capture: RemoteWindowCapture;
    owner: WorkspaceOwnerSnapshot;
    observedAt: number;
}
export interface RemoteWindowSendParams {
    commandId: string;
    monitorOwnerNonce: string;
    capture: RemoteWindowCapture;
    messageId: string;
    mode: RemoteWindowMode;
    message: string;
    source: WorkspacePeerMessageSource;
    messageKind: WorkspacePeerMessageKind;
    ttlMs?: number;
}
export interface RemoteWindowSendResult {
    receipt: RemoteWindowReceipt;
}
export interface RemoteWindowReceiptParams {
    commandId: string;
    monitorOwnerNonce: string;
    capture: RemoteWindowCapture;
    messageId: string;
    direction?: "outgoing" | "incoming";
    /** Acknowledges that an inbound relay message reached the local Monitor ledger. */
    acknowledge?: Extract<WorkspacePeerDeliveryStage, "injected">;
}
export interface RemoteWindowReceiptResult {
    receipt?: RemoteWindowReceipt;
    acknowledged?: boolean;
}
export interface RemoteWindowStateNotification {
    type: "window/state";
    capture: RemoteWindowCapture;
    state: "available" | "updated" | "unavailable";
    observedAt: number;
    receipt?: RemoteWindowReceipt;
    reason?: "owner-replaced" | "gateway-replaced" | "monitor-exited" | "expired";
}
export interface RemoteWindowMessageNotification {
    type: "window/message";
    capture: RemoteWindowCapture;
    relayId: string;
    messageId: string;
    inReplyTo: string;
    mode: RemoteWindowMode;
    source: WorkspacePeerMessageSource;
    messageKind: WorkspacePeerMessageKind;
    message: string;
    createdAt: number;
    receivedAt: number;
}
export type RemoteWindowNotification = RemoteWindowStateNotification | RemoteWindowMessageNotification;
export declare function normalizeRemoteWindowCapture(value: unknown, expected?: Partial<Omit<RemoteWindowCapture, "capabilities">>): RemoteWindowCapture;
export declare function remoteWindowCaptureMatches(left: RemoteWindowCapture, right: RemoteWindowCapture): boolean;
export declare function normalizeRemoteWindowListing(value: unknown): RemoteWindowListing;
export declare function normalizeRemoteWindowListParams(value: unknown): RemoteWindowListParams;
export declare function normalizeRemoteWindowObserveParams(value: unknown): RemoteWindowObserveParams;
export declare function normalizeRemoteWindowSendParams(value: unknown): RemoteWindowSendParams;
export declare function normalizeRemoteWindowReceiptParams(value: unknown): RemoteWindowReceiptParams;
export declare function normalizeRemoteWindowListResult(value: unknown): RemoteWindowListResult;
export declare function normalizeRemoteWindowObserveResult(value: unknown): RemoteWindowObserveResult;
export declare function normalizeRemoteWindowReceipt(value: unknown): RemoteWindowReceipt;
export declare function normalizeRemoteWindowReceiptResult(value: unknown): RemoteWindowReceiptResult;
export declare function normalizeRemoteWindowStateNotification(value: unknown): RemoteWindowStateNotification;
export declare function normalizeRemoteWindowMessageNotification(value: unknown): RemoteWindowMessageNotification;
export declare function normalizeRemoteWindowNotification(value: unknown): RemoteWindowNotification;
