/** Dependency-free canonical session discovery and message routing primitives. */
export declare const SESSION_ENDPOINT_VERSION: 1;
export declare const SESSION_ENDPOINT_ID_PREFIX: "pi-session/v1";
export declare const SESSION_HOST_REGISTRY_KEY: unique symbol;
export declare const SESSION_SURFACE_ENV_VAR: "PI_TEAMMATE_SESSION_SURFACE";
export declare const SESSION_HOST_REGISTRY_EVENT: "teammate:sessions";
export declare const WINDOW_THREAD_EVENT: "teammate:window-thread";
export declare const WINDOW_THREAD_ENTRY_TYPE: "teammate-window-thread";
export declare const DEFAULT_WINDOW_THREAD_LIMIT = 512;
export type SessionSurfaceMode = "legacy" | "shadow" | "unified";
export type SessionEndpointKind = "root" | "agent";
export type SessionEndpointScope = "local" | "workspace-peer";
export type SessionEndpointTransport = "local-root" | "local-agent-mailbox" | "workspace-peer-v1" | "child-ipc";
export type SessionEndpointStatus = "running" | "sleeping" | "settled";
export type SessionMessageMode = "steer" | "follow_up" | "abort";
export type SessionMessageSource = "user" | "monitor" | "system";
export type SessionEndpointCapability = "inspect" | "message" | "steer" | "follow_up" | "abort" | "wake";
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
    agents: readonly SessionAgentProjection[];
}
export type SessionSelectorKind = "endpoint-id" | "owner-root" | "owner-agent" | "session-name" | "window-owner-prefix" | "name" | "name-id-prefix" | "correlation-id" | "correlation-prefix";
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
    source?: SessionMessageSource;
    signal?: AbortSignal;
}
export interface SessionEndpointSnapshot {
    contentRevision: string;
    endpoints: readonly SessionEndpoint[];
}
export type WindowThreadDirection = "outgoing" | "incoming";
export type WindowThreadStatus = "pending" | "accepted" | "rejected" | "timeout";
export interface WindowThreadEntry {
    version: typeof SESSION_ENDPOINT_VERSION;
    messageId: string;
    workspaceId: string;
    peerOwnerId: string;
    peerOwnerNonce: string;
    direction: WindowThreadDirection;
    source: SessionMessageSource;
    mode: Exclude<SessionMessageMode, "abort">;
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
        wasSleeping?: boolean;
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
export interface SessionHostRegistryOptions extends Omit<MessageRouterOptions, "directory"> {
    endpoints?: readonly SessionEndpoint[];
    thread?: WindowThreadStore;
}
export interface SessionHostSnapshot {
    version: typeof SESSION_ENDPOINT_VERSION;
    contentRevision: string;
    endpointContentRevision: string;
    threadContentRevision: string;
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
    replaceEndpoints(endpoints: readonly SessionEndpoint[]): void;
    listEndpoints(): readonly SessionEndpoint[];
    resolve(selector: string, options?: SessionResolveOptions): SessionResolution;
    send(request: SessionMessageRequest): Promise<SessionMessageResult>;
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
