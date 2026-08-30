import { type SessionEndpoint, type SessionEndpointCapability, type SessionEndpointTransport } from "../sessions/session-core.ts";
import { type ActorAddressV2, type RuntimeDomainEventV2, type RuntimeEventDraftV2 } from "./contracts.ts";
export declare const SESSION_DOMAIN_VERSION_V2: 1;
export declare const SESSION_WINDOW_ADVERTISED_EVENT_V2: "session.window.advertised";
export declare const SESSION_WINDOW_HEARTBEAT_EVENT_V2: "session.window.heartbeat";
export declare const SESSION_WINDOW_WITHDRAWN_EVENT_V2: "session.window.withdrawn";
export declare const SESSION_MESSAGE_ACCEPTED_EVENT_V2: "session.message.accepted";
export declare const SESSION_MESSAGE_INJECTED_EVENT_V2: "session.message.injected";
export declare const SESSION_MESSAGE_REPLIED_EVENT_V2: "session.message.replied";
export type SessionDomainEventTypeV2 = typeof SESSION_WINDOW_ADVERTISED_EVENT_V2 | typeof SESSION_WINDOW_HEARTBEAT_EVENT_V2 | typeof SESSION_WINDOW_WITHDRAWN_EVENT_V2 | typeof SESSION_MESSAGE_ACCEPTED_EVENT_V2 | typeof SESSION_MESSAGE_INJECTED_EVENT_V2 | typeof SESSION_MESSAGE_REPLIED_EVENT_V2;
export interface SessionRouteAuthorityV2 {
    kind: "local" | "ssh";
    authorityId: string;
    instanceNonce?: string;
}
export interface SessionRouteCaptureV2 {
    version: typeof SESSION_DOMAIN_VERSION_V2;
    authority: SessionRouteAuthorityV2;
    actor: ActorAddressV2;
    transport: Extract<SessionEndpointTransport, "workspace-peer-v1" | "remote-workspace-rpc-v1" | "local-root"> | "runtime-broker-v2";
    capabilities: readonly SessionEndpointCapability[];
    workspaceRef?: string;
    target?: string;
    ownerId: string;
    ownerNonce: string;
    cancel: false;
}
export interface SessionWindowDomainPayloadV2 {
    version: typeof SESSION_DOMAIN_VERSION_V2;
    route: SessionRouteCaptureV2;
    status: "running" | "sleeping" | "unavailable";
    sessionId?: string;
    sessionName?: string;
    agentCount: number;
    reason?: "owner-replaced" | "gateway-replaced" | "monitor-exited" | "expired";
}
export interface SessionMessageDomainPayloadV2 {
    version: typeof SESSION_DOMAIN_VERSION_V2;
    route: SessionRouteCaptureV2;
    messageId: string;
    direction: "incoming" | "outgoing";
    mode: "steer" | "follow_up";
    inReplyTo?: string;
}
export type SessionDomainPayloadV2 = SessionWindowDomainPayloadV2 | SessionMessageDomainPayloadV2;
export interface SessionWindowReadEntityV2 extends SessionWindowDomainPayloadV2 {
    updatedAt: number;
    lastSequence: number;
}
export interface SessionMessageReadEntityV2 extends SessionMessageDomainPayloadV2 {
    stage: "accepted" | "injected" | "replied";
    updatedAt: number;
    lastSequence: number;
}
export interface SessionDomainReadModelSnapshotV2 {
    version: typeof SESSION_DOMAIN_VERSION_V2;
    cursor: number;
    windows: readonly SessionWindowReadEntityV2[];
    messages: readonly SessionMessageReadEntityV2[];
}
export declare function parseSessionRouteCaptureV2(value: unknown): SessionRouteCaptureV2;
export declare function sessionRouteCaptureV2FromEndpoint(endpoint: SessionEndpoint): SessionRouteCaptureV2;
export declare function parseSessionDomainPayloadV2(eventType: SessionDomainEventTypeV2, value: unknown): SessionDomainPayloadV2;
export declare function createSessionDomainEventDraftV2(input: {
    eventType: SessionDomainEventTypeV2;
    streamId: string;
    actor: ActorAddressV2;
    eventId: string;
    occurredAt: number;
    payload: SessionDomainPayloadV2;
}): RuntimeEventDraftV2;
export declare class SessionDomainProjectionV2 {
    #private;
    apply(event: RuntimeDomainEventV2, cursor?: number): boolean;
    snapshot(): SessionDomainReadModelSnapshotV2;
}
export declare function sessionEndpointsFromReadModelV2(snapshot: SessionDomainReadModelSnapshotV2): readonly SessionEndpoint[];
export interface SessionShadowComparisonV2 {
    matches: boolean;
    missingFromV2: readonly string[];
    unexpectedInV2: readonly string[];
    changed: readonly string[];
}
export declare function compareSessionEndpointShadowV2(endpoints: readonly SessionEndpoint[], snapshot: SessionDomainReadModelSnapshotV2): SessionShadowComparisonV2;
