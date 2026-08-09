export declare const WORKSPACE_PEER_PROTOCOL_VERSION: 1;
/**
 * Reserved targetCorrelationId for commands addressed to a window's main
 * session (window-level monitor interventions) instead of a sub-agent.
 */
export declare const WORKSPACE_MAIN_SESSION_MARKER: "window-main-session";
export declare const DEFAULT_PEER_STALE_MS = 20000;
export declare const DEFAULT_PEER_HEARTBEAT_MS = 5000;
export declare const DEFAULT_PEER_PUBLISH_THROTTLE_MS = 200;
export declare const DEFAULT_COMMAND_TIMEOUT_MS = 5000;
export declare const MAX_OWNER_AGENTS = 256;
export declare const MAX_OWNER_SETTLED = 256;
export declare const MAX_OWNER_BACKGROUND_JOBS = 32;
export declare const MAX_OWNER_FILE_BYTES: number;
export declare const MAX_COMMAND_FILE_BYTES: number;
export declare const MAX_RESPONSE_FILE_BYTES: number;
export declare const MAX_COMMAND_MESSAGE_BYTES: number;
export declare const MONITOR_LEASE_STALE_MS = 60000;
export type WorkspaceAgentStatus = "running" | "sleeping";
export type WorkspaceSettledStatus = "completed" | "failed" | "terminated";
export type WorkspacePeerCommandAction = "steer" | "follow_up";
export type WorkspacePeerResponseStatus = "accepted" | "rejected" | "error" | "expired";
export interface WorkspacePeerPaths {
    rootDir: string;
    ownersDir: string;
    commandsDir: string;
    responsesDir: string;
}
export interface WorkspacePeerIdentity {
    version: typeof WORKSPACE_PEER_PROTOCOL_VERSION;
    normalizedCwd: string;
    workspaceId: string;
    ownerId: string;
    ownerNonce: string;
    paths: WorkspacePeerPaths;
}
export interface WorkspaceAgentSnapshot {
    correlationId: string;
    name?: string;
    agent: string;
    status: WorkspaceAgentStatus;
    phase?: string;
    lastOutcome?: {
        status: WorkspaceSettledStatus;
        message?: string;
        settledAt: number;
    };
    startedAt: number;
    lastActivityAt: number;
    resultReadyAt?: number;
    summary?: string;
    objective?: string;
    outputTail?: string[];
    pendingInteractions?: number;
    depth?: number;
    parentCorrelationId?: string;
    wakeable?: boolean;
}
export interface WorkspaceSettledSnapshot {
    correlationId: string;
    name?: string;
    agent: string;
    status: WorkspaceSettledStatus;
    settledAt: number;
    summary?: string;
}
export interface WorkspaceBackgroundJobSnapshot {
    id: string;
    command: string;
    status: "running" | "stopping";
    /** False while bash_bg action=run still owns the foreground tool call. */
    background: boolean;
    startedAt: number;
    updatedAt: number;
}
export interface WorkspaceOwnerState {
    agents: readonly WorkspaceAgentSnapshot[];
    settled?: readonly WorkspaceSettledSnapshot[];
    backgroundJobs?: readonly WorkspaceBackgroundJobSnapshot[];
    sessionId?: string;
    sessionName?: string;
    /** Context pressure as percentage of the window's context window (0-100). */
    contextPressure?: number;
}
export interface WorkspaceOwnerSnapshot {
    version: typeof WORKSPACE_PEER_PROTOCOL_VERSION;
    kind: "owner";
    workspaceId: string;
    normalizedCwd: string;
    ownerId: string;
    ownerNonce: string;
    pid: number;
    publishedAt: number;
    sessionId?: string;
    sessionName?: string;
    /** Context pressure as percentage of the window's context window (0-100). */
    contextPressure?: number;
    agents: WorkspaceAgentSnapshot[];
    settled: WorkspaceSettledSnapshot[];
    backgroundJobs?: WorkspaceBackgroundJobSnapshot[];
}
export interface WorkspacePeerWindowListing {
    /** Selector accepted by teammate-send for the window's main session. */
    target: string;
    ownerId: string;
    sessionId?: string;
    sessionName?: string;
    status: "running" | "sleeping";
    agentCount: number;
    publishedAt: number;
    contextPressure?: number;
}
/** Peer discovery result retained for existing callers and ledger reconciliation. */
export interface WorkspacePeerDiscovery {
    peers: WorkspaceOwnerSnapshot[];
    staleOwnerIds: string[];
    corruptFiles: string[];
}
export interface WorkspaceResolvedTarget {
    scope: "local" | "remote";
    ownerId: string;
    ownerNonce: string;
    state: "active" | "settled";
    agent: WorkspaceAgentSnapshot | WorkspaceSettledSnapshot;
}
export type WorkspaceTargetResolutionCode = "invalid" | "not_found" | "ambiguous" | "not_routable";
export declare class WorkspaceTargetResolutionError extends Error {
    readonly code: WorkspaceTargetResolutionCode;
    readonly candidates: readonly string[];
    constructor(code: WorkspaceTargetResolutionCode, message: string, candidates?: readonly string[]);
}
export interface WorkspacePeerCommand {
    version: typeof WORKSPACE_PEER_PROTOCOL_VERSION;
    kind: "command";
    workspaceId: string;
    commandId: string;
    fromOwnerId: string;
    fromOwnerNonce: string;
    toOwnerId: string;
    toOwnerNonce: string;
    targetCorrelationId: string;
    action: WorkspacePeerCommandAction;
    message: string;
    createdAt: number;
    expiresAt: number;
}
export interface WorkspacePeerCommandResponse {
    version: typeof WORKSPACE_PEER_PROTOCOL_VERSION;
    kind: "response";
    workspaceId: string;
    commandId: string;
    fromOwnerId: string;
    fromOwnerNonce: string;
    toOwnerId: string;
    toOwnerNonce: string;
    targetCorrelationId: string;
    status: WorkspacePeerResponseStatus;
    message?: string;
    respondedAt: number;
    expiresAt: number;
}
export interface WorkspaceCommandHandlerResult {
    status?: Exclude<WorkspacePeerResponseStatus, "expired">;
    message?: string;
}
export interface WorkspaceConsumedCommand {
    commandId: string;
    replayed: boolean;
    response: WorkspacePeerCommandResponse;
}
export interface WorkspacePeerRuntimeOptions {
    cwd: string;
    rootDir?: string;
    ownerId?: string;
    ownerNonce?: string;
    heartbeatMs?: number;
    publishThrottleMs?: number;
    now?: () => number;
    getState: () => WorkspaceOwnerState;
}
export interface StopWorkspacePeerRuntimeOptions {
    removeOwnerFile?: boolean;
}
export declare function normalizeWorkspacePath(cwd: string, platform?: NodeJS.Platform): string;
export declare function workspaceIdForCwd(cwd: string, platform?: NodeJS.Platform): string;
export declare function defaultWorkspacePeerRoot(cwd: string): string;
export declare function createWorkspacePeerPaths(cwd: string, rootDir?: string): WorkspacePeerPaths;
export declare function createWorkspacePeerIdentity(cwd: string, options?: {
    rootDir?: string;
    ownerId?: string;
    ownerNonce?: string;
}): WorkspacePeerIdentity;
export declare function ownerSnapshotPath(identity: WorkspacePeerIdentity, ownerId?: string): string;
export declare function commandMailboxPath(identity: WorkspacePeerIdentity, ownerId: string): string;
export declare function responseMailboxPath(identity: WorkspacePeerIdentity, ownerId: string): string;
export declare function ensureWorkspacePeerDirectories(identity: WorkspacePeerIdentity): Promise<void>;
export declare function writePrivateJsonAtomic(path: string, value: unknown, maximumBytes: number): Promise<void>;
/**
 * Lease file declaring that `monitorOwnerId` supervises `targetOwnerId`.
 * Lives next to the target's owner snapshot in the shared workspace root, so
 * any Pi root session can see who is monitoring a window before binding.
 */
export interface MonitorLease {
    version: typeof WORKSPACE_PEER_PROTOCOL_VERSION;
    monitorOwnerId: string;
    targetOwnerId: string;
    sessionName?: string;
    pid: number;
    since: number;
}
export declare function monitorLeasePath(identity: WorkspacePeerIdentity, targetOwnerId: string): string;
export declare function validateMonitorLease(value: unknown): MonitorLease | undefined;
/** Read the current physical lease without changing the workspace-peer protocol. */
export declare function readMonitorLease(identity: WorkspacePeerIdentity, targetOwnerId: string): Promise<MonitorLease | undefined>;
export interface AcquireMonitorLeaseResult {
    ok: boolean;
    error?: string;
    lease?: MonitorLease;
}
export interface AcquireMonitorLeaseOptions {
    sessionName?: string;
    /** Lease staleness: an offline holder's lease may be taken over. */
    staleMs?: number;
    now?: number;
}
/**
 * Acquire the supervision lease for a peer window. Refuses when another
 * live monitor already holds it (double-monitoring prevention); a stale
 * lease whose holder has gone offline is taken over silently.
 */
export declare function acquireMonitorLease(identity: WorkspacePeerIdentity, targetOwnerId: string, options?: AcquireMonitorLeaseOptions): Promise<AcquireMonitorLeaseResult>;
/**
 * Release the supervision lease. Only the lease holder may release it;
 * returns false when the lease belongs to someone else.
 */
export declare function releaseMonitorLease(identity: WorkspacePeerIdentity, targetOwnerId: string, monitorOwnerId?: string): Promise<boolean>;
export declare function activeWorkspaceBackgroundJobsFromPayload(payload: unknown): WorkspaceBackgroundJobSnapshot[] | undefined;
export interface WorkspaceMainSessionDeliveryDecision {
    action: WorkspacePeerCommandAction;
    deliverAs: "steer" | "followUp";
    deferred: boolean;
}
export declare function workspaceMainSessionDeliveryDecision(requested: WorkspacePeerCommandAction, backgroundJobs: readonly WorkspaceBackgroundJobSnapshot[]): WorkspaceMainSessionDeliveryDecision;
export declare function workspaceMainSessionDeliveryAction(requested: WorkspacePeerCommandAction, backgroundJobs: readonly WorkspaceBackgroundJobSnapshot[]): WorkspacePeerCommandAction;
export declare function validateWorkspaceBackgroundJobSnapshot(value: unknown): WorkspaceBackgroundJobSnapshot | undefined;
export declare function validateWorkspaceOwnerSnapshot(value: unknown, expected?: {
    workspaceId?: string;
    ownerId?: string;
}): WorkspaceOwnerSnapshot | undefined;
export declare function buildWorkspaceOwnerSnapshot(identity: WorkspacePeerIdentity, state: WorkspaceOwnerState, publishedAt?: number): WorkspaceOwnerSnapshot;
export declare function publishWorkspaceOwner(identity: WorkspacePeerIdentity, state: WorkspaceOwnerState, publishedAt?: number): Promise<WorkspaceOwnerSnapshot>;
export declare function discoverWorkspacePeers(identity: WorkspacePeerIdentity, options?: {
    now?: number;
    staleAfterMs?: number;
    cleanupStale?: boolean;
    includeSelf?: boolean;
}): Promise<WorkspacePeerDiscovery>;
/**
 * Resolve a workspace peer window by its sessionName (window title).
 * Accepts an exact name, a unique name prefix, or the `name#ownerIdPrefix`
 * disambiguator used elsewhere in the peer protocol.
 */
export declare function resolveWorkspaceOwnerByName(owners: readonly WorkspaceOwnerSnapshot[], selector: string): WorkspaceOwnerSnapshot | undefined;
export declare function resolveWorkspaceTarget(query: string, localIdentity: WorkspacePeerIdentity, localState: WorkspaceOwnerState, remoteOwners: readonly WorkspaceOwnerSnapshot[], options?: {
    includeSettled?: boolean;
}): WorkspaceResolvedTarget;
export declare function requireRoutableWorkspaceTarget(target: WorkspaceResolvedTarget): WorkspaceResolvedTarget & {
    state: "active";
};
export declare class WorkspacePeerPublisher {
    #private;
    readonly identity: WorkspacePeerIdentity;
    readonly heartbeatMs: number;
    readonly publishThrottleMs: number;
    constructor(options: WorkspacePeerRuntimeOptions);
    start(): Promise<void>;
    markDirty(): void;
    publishNow(): Promise<void>;
    stop(options?: StopWorkspacePeerRuntimeOptions): Promise<void>;
}
export declare function createWorkspacePeerRuntime(options: WorkspacePeerRuntimeOptions): WorkspacePeerPublisher;
export declare function validateWorkspacePeerCommand(value: unknown, workspaceId?: string): WorkspacePeerCommand | undefined;
export declare function validateWorkspacePeerCommandResponse(value: unknown, command?: WorkspacePeerCommand): WorkspacePeerCommandResponse | undefined;
export declare function enqueueWorkspacePeerCommand(identity: WorkspacePeerIdentity, target: WorkspaceResolvedTarget, action: WorkspacePeerCommandAction, message: string, options?: {
    now?: number;
    ttlMs?: number;
    commandId?: string;
}): Promise<WorkspacePeerCommand>;
export declare function waitForWorkspacePeerCommandResponse(identity: WorkspacePeerIdentity, command: WorkspacePeerCommand, options?: {
    timeoutMs?: number;
    pollMs?: number;
    signal?: AbortSignal;
}): Promise<WorkspacePeerCommandResponse | undefined>;
export declare function sendWorkspacePeerCommand(identity: WorkspacePeerIdentity, target: WorkspaceResolvedTarget, action: WorkspacePeerCommandAction, message: string, options?: {
    timeoutMs?: number;
    pollMs?: number;
    ttlMs?: number;
    signal?: AbortSignal;
}): Promise<{
    command: WorkspacePeerCommand;
    response?: WorkspacePeerCommandResponse;
    timedOut: boolean;
}>;
export declare function consumeWorkspacePeerCommands(identity: WorkspacePeerIdentity, handler: (command: WorkspacePeerCommand) => WorkspaceCommandHandlerResult | void | Promise<WorkspaceCommandHandlerResult | void>, options?: {
    now?: number;
    limit?: number;
}): Promise<WorkspaceConsumedCommand[]>;
export declare class WorkspacePeerCommandConsumer {
    #private;
    readonly identity: WorkspacePeerIdentity;
    readonly pollMs: number;
    constructor(identity: WorkspacePeerIdentity, handler: (command: WorkspacePeerCommand) => WorkspaceCommandHandlerResult | void | Promise<WorkspaceCommandHandlerResult | void>, options?: {
        pollMs?: number;
    });
    start(): void;
    poll(): Promise<WorkspaceConsumedCommand[]>;
    stop(): Promise<void>;
}
export declare function createWorkspacePeerCommandConsumer(identity: WorkspacePeerIdentity, handler: (command: WorkspacePeerCommand) => WorkspaceCommandHandlerResult | void | Promise<WorkspaceCommandHandlerResult | void>, options?: {
    pollMs?: number;
}): WorkspacePeerCommandConsumer;
export declare function cleanupWorkspacePeerMailboxes(identity: WorkspacePeerIdentity, options?: {
    now?: number;
}): Promise<number>;
