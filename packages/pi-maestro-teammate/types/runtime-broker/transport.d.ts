import type { MessageProvenanceV1 } from "../shared/types.ts";
export type RuntimeTransportDriver = "file" | "sqlite";
export type RuntimeTransportMessageKind = "lifecycle" | "result" | "steer" | "follow_up" | "task" | "control";
export type RuntimeTransportDeliveryMode = "steer" | "follow_up" | "abort" | "notify";
export type RuntimeTransportPriority = "critical" | "high" | "normal";
export type RuntimeTransportDeliveryState = "staging" | "ready" | "claimed" | "accepted" | "applied" | "rejected" | "expired" | "dead";
export interface RuntimeTransportEnqueueRequest {
    senderId: string;
    recipientId: string;
    recipientCorrelationId: string;
    kind: RuntimeTransportMessageKind;
    mode: RuntimeTransportDeliveryMode;
    payload: string;
    provenance?: MessageProvenanceV1;
    requestId?: string;
    correlationId?: string;
}
export interface RuntimeTransportMessage extends RuntimeTransportEnqueueRequest {
    messageId: string;
    workspaceId: string;
    teamId: string;
    priority: RuntimeTransportPriority;
    createdAt: number;
    expiresAt: number;
}
export type RuntimeTransportEnqueueFailureCode = "quota_exceeded" | "route_invalid" | "generation_mismatch" | "lease_invalid" | "duplicate" | "payload_too_large" | "envelope_too_large";
export type RuntimeTransportEnqueueResult = {
    ok: true;
    messageId: string;
    state: "ready";
} | {
    ok: false;
    code: RuntimeTransportEnqueueFailureCode;
    message: string;
};
export type RuntimeTransportDispatch = (message: RuntimeTransportMessage) => Promise<void>;
/**
 * Compatibility transport boundary for durable runtime delivery.
 *
 * A resolved dispatch means the accepted message was delivered successfully
 * and MUST be auto-applied by the transport. acknowledge() exists only for
 * external IPC compatibility and is idempotent: false means no state changed.
 */
export interface RuntimeTransport {
    readonly driver: RuntimeTransportDriver;
    enqueue(request: RuntimeTransportEnqueueRequest): Promise<RuntimeTransportEnqueueResult>;
    consume(dispatch: RuntimeTransportDispatch): Promise<void>;
    acknowledge(messageId: string): Promise<boolean>;
    state(messageId: string): Promise<RuntimeTransportDeliveryState | undefined>;
    hasPendingMessages(): Promise<boolean>;
    stop(): Promise<void>;
}
/** Injection boundary for a future broker client without importing its module. */
export interface SqliteRuntimeTransportClient extends RuntimeTransport {
    readonly driver: "sqlite";
}
export type RuntimeTransportFactory = () => RuntimeTransport;
