/** Dependency-free canonical session discovery and message routing primitives. */
import { type MessageProvenanceV1 } from "../shared/types.ts";
export declare const SESSION_ENDPOINT_VERSION: 1;
export declare const SESSION_ENDPOINT_ID_PREFIX: "pi-session/v1";
export declare const SESSION_HOST_REGISTRY_KEY: unique symbol;
export declare const SESSION_SURFACE_ENV_VAR: "PI_TEAMMATE_SESSION_SURFACE";
export declare const SESSION_HOST_REGISTRY_EVENT: "teammate:sessions";
export declare const WINDOW_THREAD_EVENT: "teammate:window-thread";
export declare const WINDOW_THREAD_ENTRY_TYPE: "teammate-window-thread";
export declare const DEFAULT_WINDOW_THREAD_LIMIT = 512;
export type SessionSurfaceMode = "legacy" | "shadow" | "unified";
export type SessionViewMode = "agents" | "windows";
export type SessionWindowModeAction = "enter" | "exit";
export type SessionEndpointKind = "root" | "agent";
export type SessionEndpointScope = "local" | "workspace-peer";
export type SessionEndpointTransport = "local-root" | "local-agent-mailbox" | "workspace-peer-v1" | "child-ipc";
export type SessionEndpointStatus = "running" | "sleeping" | "settled";
export type SessionMessageMode = "steer" | "follow_up" | "abort";
export type SessionMessageSource = "user" | "monitor" | "system";
export type SessionMessageKind = "message" | "coordination" | "request" | "status" | "supervision";
export type SessionDeliveryStage = "queued" | "injected";
/** Model-originated status is coordination; only trusted host telemetry stays context-only. */
export declare function normalizeSessionMessageKind(kind: SessionMessageKind | undefined, trustedStatus?: boolean): SessionMessageKind | undefined;
/** Status messages update context but never start a model turn by themselves. */
export declare function sessionMessageTriggersTurn(kind: SessionMessageKind | undefined): boolean;
export type SessionEndpointCapability = "inspect" | "message" | "steer" | "follow_up" | "abort" | "wake" | "flow-schedule-todo-binding";
export interface SessionEndpointIdentity {
    workspaceId: string;
    ownerId: string;
    ownerNonce: string;
    correlationId?: string;
}
export interface SessionEndpoint extends SessionEndpointIdentity {
    version: typeof SESSION_ENDPOINT_VERSION;
    id: string;
    kind: SessionEndpointKind;
    scope: SessionEndpointScope;
    transport: SessionEndpointTransport;
    status: SessionEndpointStatus;
    capabilities: readonly SessionEndpointCapability[];
    /** Deterministic position in the canonical endpoint ordering. */
    ordinal: number;
    /** Hash of semantic content; heartbeat-only timestamps are not projected. */
    contentRevision: string;
    sessionId?: string;
    sessionName?: string;
    name?: string;
    agent?: string;
    phase?: string;
    parentCorrelationId?: string;
    summary?: string;
    contextPressure?: number;
    agentCount?: number;
}
export interface SessionAgentProjection extends SessionEndpointIdentity {
    correlationId: string;
    status: SessionEndpointStatus;
    name?: string;
    agent?: string;
    phase?: string;
    parentCorrelationId?: string;
    summary?: string;
    wakeable?: boolean;
}
export interface SessionOwnerProjection extends Omit<SessionEndpointIdentity, "correlationId"> {
    scope: SessionEndpointScope;
    status: "running" | "sleeping";
    /** Optional caller-side proxy transport; root hosts use the scope defaults. */
    transport?: SessionEndpointTransport;
    sessionId?: string;
    sessionName?: string;
    contextPressure?: number;
    /** Extra root-endpoint capabilities this owner advertises (e.g. flow-schedule-todo-binding). */
    extraCapabilities?: readonly SessionEndpointCapability[];
    agents: readonly SessionAgentProjection[];
}
export type SessionSelectorKind = "endpoint-id" | "local-root" | "owner-root" | "owner-agent" | "session-name" | "window-owner-prefix" | "name" | "name-id-prefix" | "correlation-id" | "correlation-prefix";
export type SessionResolutionCode = "resolved" | "invalid" | "not_found" | "ambiguous" | "not_routable";
export interface SessionResolution {
    code: SessionResolutionCode;
    selector: string;
    selectorKind?: SessionSelectorKind;
    endpoint?: SessionEndpoint;
    candidates: readonly SessionEndpoint[];
    message?: string;
}
export interface SessionResolveOptions {
    includeSettled?: boolean;
    localFirst?: boolean;
    /** Pin delivery to this correlation id instead of re-resolving the selector. */
    targetCorrelationId?: string;
}
export declare function parseSessionSurfaceMode(value: unknown): SessionSurfaceMode;
export declare function sessionSurfaceModeFromEnv(env?: Readonly<Record<string, string | undefined>>): SessionSurfaceMode;
export declare function sessionRootEndpointId(identity: Omit<SessionEndpointIdentity, "correlationId">): string;
export declare function sessionAgentEndpointId(identity: SessionEndpointIdentity & {
    correlationId: string;
}): string;
/** Stable 64-bit FNV-1a; suitable for change detection, not security. */
export declare function sessionContentRevision(value: unknown): string;
export declare function projectSessionEndpoints(owners: readonly SessionOwnerProjection[]): readonly SessionEndpoint[];
export declare class EndpointDirectory {
    #private;
    constructor(endpoints?: readonly SessionEndpoint[]);
    replace(endpoints: readonly SessionEndpoint[]): void;
    list(): readonly SessionEndpoint[];
    get(id: string): SessionEndpoint | undefined;
    get contentRevision(): string;
    snapshot(): SessionEndpointSnapshot;
    subscribe(subscriber: (snapshot: SessionEndpointSnapshot) => void, options?: {
        emitCurrent?: boolean;
    }): () => void;
    resolve(rawSelector: string, options?: SessionResolveOptions): SessionResolution;
}
export interface SessionMessageRequest {
    selector: string;
    message: string;
    mode: SessionMessageMode;
    messageId?: string;
    source?: SessionMessageSource;
    messageKind?: SessionMessageKind;
    /** Structured host attribution; absent on legacy callers. */
    provenance?: MessageProvenanceV1;
    /** Authorizes context-only status semantics; never serialized or model-controlled. */
    trustedStatus?: boolean;
    traceId?: string;
    replyTo?: string;
    /** Request one bounded terminal status reply from a root workspace worker. */
    terminalResultRequested?: true;
    fromSessionName?: string;
    /** Pin delivery target; avoids TOCTOU when the selector is rebound between check and route. */
    targetCorrelationId?: string;
    /** Sender correlation id for local agent envelope formatting and inbox attribution. */
    senderCorrelationId?: string;
    /** In-process authority fence checked immediately before external publication; never serialized. */
    authorize?: () => boolean;
    signal?: AbortSignal;
}
export interface SessionEndpointSnapshot {
    contentRevision: string;
    endpoints: readonly SessionEndpoint[];
}
export type WindowThreadDirection = "outgoing" | "incoming";
export type WindowThreadStatus = "pending" | "queued" | "injected" | "accepted" | "rejected" | "timeout";
export interface WindowThreadEntry {
    version: typeof SESSION_ENDPOINT_VERSION;
    messageId: string;
    workspaceId: string;
    peerOwnerId: string;
    peerOwnerNonce: string;
    direction: WindowThreadDirection;
    source: SessionMessageSource;
    messageKind?: SessionMessageKind;
    /** Structured host attribution; absent on legacy journal entries. */
    provenance?: MessageProvenanceV1;
    traceId?: string;
    replyTo?: string;
    /** Opt-in terminal-result contract; absent on legacy journal entries. */
    terminalResultRequested?: true;
    fromSessionName?: string;
    /** Receiving Pi session; prevents inherited fork entries from replaying into the child. */
    targetSessionId?: string;
    targetCorrelationId?: string;
    mode: Exclude<SessionMessageMode, "abort">;
    effectiveMode?: Exclude<SessionMessageMode, "abort">;
    body: string;
    status: WindowThreadStatus;
    createdAt: number;
    updatedAt: number;
    revision: number;
    contentRevision: string;
}
export interface WindowThreadSnapshot {
    contentRevision: string;
    entries: readonly WindowThreadEntry[];
}
export type WindowThreadEntryInput = Omit<WindowThreadEntry, "version" | "revision" | "contentRevision">;
/** Only injected/legacy-accepted entries prove model consumption; queued entries remain recoverable. */
export declare function windowThreadReplayReceipt(entry: WindowThreadEntry | undefined): {
    status: "accepted" | "rejected";
    message: string;
} | undefined;
export interface WindowThreadStoreOptions {
    limit?: number;
    persist?: (entry: WindowThreadEntry) => void;
}
/** Bounded local projection of cross-window command history. */
export declare class WindowThreadStore {
    #private;
    readonly limit: number;
    constructor(options?: WindowThreadStoreOptions);
    get contentRevision(): string;
    list(): readonly WindowThreadEntry[];
    get(messageId: string, direction?: WindowThreadDirection): WindowThreadEntry | undefined;
    transition(messageId: string, direction: WindowThreadDirection, status: WindowThreadStatus, updatedAt?: number, effectiveMode?: Exclude<SessionMessageMode, "abort">): WindowThreadEntry | undefined;
    reconcileInjected(messageId: string, updatedAt?: number, effectiveMode?: Exclude<SessionMessageMode, "abort">): WindowThreadEntry | undefined;
    snapshot(): WindowThreadSnapshot;
    subscribe(subscriber: (snapshot: WindowThreadSnapshot) => void, options?: {
        emitCurrent?: boolean;
    }): () => void;
    record(input: WindowThreadEntryInput): WindowThreadEntry;
    rebuild(sessionEntries: readonly unknown[]): WindowThreadSnapshot;
}
export interface SessionRouteClassification {
    transport: SessionEndpointTransport;
    routable: boolean;
    reason?: string;
}
export interface SessionMessageResult {
    delivered: boolean;
    endpointId?: string;
    transport?: SessionEndpointTransport;
    error?: string;
    receipt?: {
        mode?: string;
        requestedMode?: SessionMessageMode;
        effectiveMode?: SessionMessageMode;
        deliveryStage?: SessionDeliveryStage;
        publicationStage?: "published" | "accepted" | "rejected";
        messageId?: string;
        traceId?: string;
        wasSleeping?: boolean;
        contextDeferred?: boolean;
        terminatedCount?: number;
    };
}
export interface SessionTransportAdapter {
    readonly transport: SessionEndpointTransport;
    classify(endpoint: SessionEndpoint, request: SessionMessageRequest): SessionRouteClassification;
    deliver(endpoint: SessionEndpoint, request: SessionMessageRequest): Promise<SessionMessageResult>;
}
export interface LegacySessionAuthority {
    resolve(request: SessionMessageRequest): SessionResolution;
    classify(request: SessionMessageRequest, resolution: SessionResolution): SessionRouteClassification;
    deliver(request: SessionMessageRequest, resolution: SessionResolution): Promise<SessionMessageResult>;
}
export interface SessionShadowComparison {
    selector: string;
    legacy: {
        resolution: SessionResolutionCode;
        endpointId?: string;
        transport?: SessionEndpointTransport;
        routable: boolean;
    };
    unified: {
        resolution: SessionResolutionCode;
        endpointId?: string;
        transport?: SessionEndpointTransport;
        routable: boolean;
    };
    matches: boolean;
}
export interface MessageRouterOptions {
    directory: EndpointDirectory;
    surface?: SessionSurfaceMode;
    adapters?: readonly SessionTransportAdapter[];
    legacy?: LegacySessionAuthority;
    onShadowComparison?: (comparison: SessionShadowComparison) => void;
}
export declare class MessageRouter {
    #private;
    readonly directory: EndpointDirectory;
    constructor(options: MessageRouterOptions);
    get surface(): SessionSurfaceMode;
    setSurface(surface: SessionSurfaceMode): void;
    classify(request: SessionMessageRequest, resolution?: SessionResolution): SessionRouteClassification;
    compare(request: SessionMessageRequest): SessionShadowComparison | undefined;
    route(request: SessionMessageRequest): Promise<SessionMessageResult>;
}
export interface SessionHostControls {
    requestWindowMode?: (action: SessionWindowModeAction) => void | Promise<void>;
}
export interface SessionHostRegistryOptions extends Omit<MessageRouterOptions, "directory"> {
    endpoints?: readonly SessionEndpoint[];
    thread?: WindowThreadStore;
    controls?: SessionHostControls;
    /** Canonical host boundary applied to every public send entry point. */
    prepareMessage?: (request: SessionMessageRequest) => SessionMessageRequest;
}
export interface SessionHostSnapshot {
    version: typeof SESSION_ENDPOINT_VERSION;
    contentRevision: string;
    endpointContentRevision: string;
    threadContentRevision: string;
    viewMode: SessionViewMode;
    endpoints: readonly SessionEndpoint[];
    thread: readonly WindowThreadEntry[];
}
export declare class SessionHostRegistry {
    #private;
    readonly version: 1;
    readonly directory: EndpointDirectory;
    readonly router: MessageRouter;
    readonly thread: WindowThreadStore;
    constructor(options?: SessionHostRegistryOptions);
    get contentRevision(): string;
    get viewMode(): SessionViewMode;
    replaceEndpoints(endpoints: readonly SessionEndpoint[]): void;
    listEndpoints(): readonly SessionEndpoint[];
    resolve(selector: string, options?: SessionResolveOptions): SessionResolution;
    send(request: SessionMessageRequest): Promise<SessionMessageResult>;
    setControls(controls: SessionHostControls): void;
    setViewMode(mode: SessionViewMode): void;
    requestWindowMode(action: SessionWindowModeAction): Promise<void>;
    snapshot(): SessionHostSnapshot;
    subscribe(subscriber: (snapshot: SessionHostSnapshot) => void, options?: {
        emitCurrent?: boolean;
    }): () => void;
}
export declare function getSessionHostRegistry(host?: typeof globalThis & Record<symbol, unknown>): SessionHostRegistry | undefined;
export declare function publishSessionHostRegistry(registry: SessionHostRegistry | undefined, host?: typeof globalThis & Record<symbol, unknown>): void;
export type SessionTransportDelivery = (endpoint: SessionEndpoint, request: SessionMessageRequest) => Promise<SessionMessageResult>;
export declare function createLocalRootTransportAdapter(deliver: SessionTransportDelivery): SessionTransportAdapter;
export declare function createLocalAgentMailboxTransportAdapter(deliver: SessionTransportDelivery): SessionTransportAdapter;
export declare function createWorkspacePeerV1TransportAdapter(deliver: SessionTransportDelivery): SessionTransportAdapter;
/** Child callers proxy every target to the root; the root remains delivery authority. */
export declare function createChildIpcTransportAdapter(deliver: SessionTransportDelivery): SessionTransportAdapter;
