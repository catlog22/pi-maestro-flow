export declare const WORKSPACE_PEER_PROTOCOL_VERSION: 1;
/**
 * Reserved targetCorrelationId for commands addressed to a window's main
 * session (window-level monitor interventions) instead of a sub-agent.
 */
export declare const WORKSPACE_MAIN_SESSION_MARKER: "window-main-session";
export declare const DEFAULT_PEER_STALE_MS = 20000;
export declare const DEFAULT_PEER_HEARTBEAT_MS = 5000;
export declare const DEFAULT_PEER_PUBLISH_THROTTLE_MS = 200;
export declare const DEFAULT_PEER_MAILBOX_CLEANUP_INTERVAL_MS: number;
export declare const DEFAULT_COMMAND_TIMEOUT_MS = 5000;
export declare const MAX_OWNER_AGENTS = 256;
export declare const MAX_OWNER_SETTLED = 256;
export declare const MAX_OWNER_BACKGROUND_JOBS = 32;
export declare const MAX_OWNER_FILE_BYTES: number;
export declare const MAX_COMMAND_FILE_BYTES: number;
export declare const MAX_RESPONSE_FILE_BYTES: number;
export declare const MAX_COMMAND_MESSAGE_BYTES: number;
export declare const MAX_WINDOW_LISTING_ACTIVE_AGENTS = 8;
export declare const MONITOR_LEASE_STALE_MS = 60000;
/** A window whose main session was active within this window is busy even with zero sub-agents. */
export declare const MAIN_SESSION_ACTIVE_MS = 60000;
/** Per-settled-agent result payload cap (keeps owner snapshots under MAX_OWNER_FILE_BYTES). */
export declare const SETTLED_RESULT_BYTES: number;
/** Max settled records that carry a result body in the owner snapshot. */
export declare const SETTLED_RESULT_MAX = 8;
/** Owner snapshot deletion threshold for stale cleanup (listing staleness stays at DEFAULT_PEER_STALE_MS). */
export declare const CLEANUP_STALE_DEFAULT_MS = 120000;
/** Version of the per-session owner identity file. */
export declare const IDENTITY_FILE_VERSION: 1;
export type WorkspaceAgentStatus = "running" | "sleeping";
export type WorkspaceSettledStatus = "completed" | "failed" | "terminated";
export type WorkspacePeerCommandAction = "steer" | "follow_up";
export type WorkspacePeerResponseStatus = "accepted" | "rejected" | "error" | "expired";
export type WorkspacePeerMessageSource = "user" | "monitor" | "system";
/**
 * Model-visible semantics for cross-window messages. `message` is the v1
 * compatibility value and is deliberately interpreted as coordination-only.
 */
export type WorkspacePeerMessageKind = "message" | "coordination" | "request" | "status" | "supervision";
export type WorkspacePeerDeliveryStage = "queued" | "injected";
export interface WorkspacePeerPaths {
    rootDir: string;
    ownersDir: string;
    commandsDir: string;
    responsesDir: string;
    identitiesDir: string;
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
    /** Final result body of the settled agent (bounded, most-recent SETTLED_RESULT_MAX only). */
    result?: string;
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
    /** Last main-session activity timestamp — liveness signal when no sub-agents are running. */
    mainActivityAt?: number;
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
    /** Last main-session activity timestamp — liveness signal when no sub-agents are running. */
    mainActivityAt?: number;
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
    displayName?: string;
    status: "running" | "sleeping";
    agentCount: number;
    activeAgents?: Array<{
        role: string;
        name?: string;
        status: WorkspaceAgentStatus;
        objective?: string;
        summary?: string;
    }>;
    publishedAt: number;
    contextPressure?: number;
}
export declare function workspacePeerDisplayName(sessionName: string | undefined, ownerId: string): string;
export interface WorkspaceWindowLifecycle {
    /** Live work: running sub-agents, bash_bg jobs, or a recently active main session. */
    busy: boolean;
    /** All work settled — safe to report the window as completed. */
    settled: boolean;
    /** Agents exist, none running without a result, and no background jobs — results are readable. */
    resultReady: boolean;
    status: "running" | "result-ready" | "completed" | "sleeping";
}
/**
 * Liveness classification of a workspace window from its owner snapshot.
 * The main-session activity signal prevents `completed / 0 agents` misreports
 * while a window's main session is itself working (no teammate sub-agents).
 */
export declare function workspaceWindowLifecycle(owner: Pick<WorkspaceOwnerSnapshot, "agents" | "backgroundJobs" | "mainActivityAt">, now?: number, options?: {
    mainActiveMs?: number;
}): WorkspaceWindowLifecycle;
export declare function projectWorkspacePeerWindow(owner: WorkspaceOwnerSnapshot): WorkspacePeerWindowListing;
export declare function formatWorkspacePeerWindowListings(windows: readonly WorkspacePeerWindowListing[]): string;
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
    source?: WorkspacePeerMessageSource;
    messageKind?: WorkspacePeerMessageKind;
    traceId?: string;
    replyTo?: string;
    fromSessionName?: string;
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
    effectiveAction?: WorkspacePeerCommandAction;
    deliveryStage?: WorkspacePeerDeliveryStage;
    traceId?: string;
    respondedAt: number;
    expiresAt: number;
}
export interface WorkspaceCommandHandlerResult {
    status?: Exclude<WorkspacePeerResponseStatus, "expired">;
    message?: string;
    effectiveAction?: WorkspacePeerCommandAction;
    deliveryStage?: WorkspacePeerDeliveryStage;
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
    mailboxCleanupIntervalMs?: number;
    now?: () => number;
    /** @internal Test hook for deterministic cleanup failure coverage. */
    cleanupMailboxes?: typeof cleanupWorkspacePeerMailboxes;
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
export declare function writePrivateJsonAtomic(path: string, value: unknown, maximumBytes: number, options?: {
    beforeCommit?: () => void;
}): Promise<void>;
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
export declare function workspaceMainSessionDeliveryDecision(requested: WorkspacePeerCommandAction, backgroundJobs: readonly WorkspaceBackgroundJobSnapshot[], messageKind?: WorkspacePeerMessageKind): WorkspaceMainSessionDeliveryDecision;
export declare function workspaceMainSessionDeliveryAction(requested: WorkspacePeerCommandAction, backgroundJobs: readonly WorkspaceBackgroundJobSnapshot[]): WorkspacePeerCommandAction;
export declare function shouldReplayWorkspaceRootQueue(reason: "startup" | "reload" | "new" | "resume" | "fork", targetSessionId?: string, currentSessionId?: string): boolean;
export interface WorkspaceRemoteRootMessage {
    messageId: string;
    fromOwnerId: string;
    message: string;
    effectiveAction: WorkspacePeerCommandAction;
    source?: WorkspacePeerMessageSource;
    messageKind?: WorkspacePeerMessageKind;
    traceId?: string;
    replyTo?: string;
    fromSessionName?: string;
}
/** Canonical model-visible envelope for all remote root messages. */
export declare function formatWorkspaceRemoteRootMessage(input: WorkspaceRemoteRootMessage): string;
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
    cleanupStaleAfterMs?: number;
    includeSelf?: boolean;
}): Promise<WorkspacePeerDiscovery>;
export interface PersistedOwnerIdentity {
    version: typeof IDENTITY_FILE_VERSION;
    ownerId: string;
}
export declare function workspacePeerIdentityPath(identity: WorkspacePeerIdentity, sessionKey: string): string;
export declare function loadPersistedOwnerIdentity(identity: WorkspacePeerIdentity, sessionKey: string): Promise<PersistedOwnerIdentity | undefined>;
export declare function persistOwnerIdentity(identity: WorkspacePeerIdentity, sessionKey: string, ownerId: string): Promise<void>;
/**
 * Resolve the ownerId for a window's workspace-peer incarnation. Reuses the
 * persisted per-session ownerId unless a live foreign process already holds it
 * (double-attach guard); otherwise mints and persists a fresh one. The
 * ownerNonce still rotates every start, so commands sent to a previous
 * incarnation are rejected with a definitive response instead of orphaned.
 */
export declare function resolveWorkspaceOwnerIdentity(cwd: string, options?: {
    rootDir?: string;
    sessionKey?: string;
    pid?: number;
    now?: number;
    staleMs?: number;
}): Promise<string>;
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
    readonly mailboxCleanupIntervalMs: number;
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
    source?: WorkspacePeerMessageSource;
    messageKind?: WorkspacePeerMessageKind;
    traceId?: string;
    replyTo?: string;
    fromSessionName?: string;
    beforePublish?: (command: WorkspacePeerCommand) => void | Promise<void>;
    /** Synchronous ownership check at the atomic rename boundary. */
    beforeCommit?: (command: WorkspacePeerCommand) => void;
}): Promise<WorkspacePeerCommand>;
/** Self-consistency read of a response file addressed to this owner (receipt reconciliation). */
export declare function readWorkspacePeerResponse(identity: WorkspacePeerIdentity, commandId: string): Promise<WorkspacePeerCommandResponse | undefined>;
/**
 * Finalize a command response after the message is actually injected. The
 * claim-time response is written with deliveryStage "queued"; this rewrites it
 * in place (preserving the envelope fields a sender validates against) once
 * the target-side injection is confirmed. Returns false when there is nothing
 * to finalize (missing file, non-accepted status, or already finalized).
 */
export declare function finalizeWorkspacePeerResponse(identity: WorkspacePeerIdentity, fromOwnerId: string, commandId: string, deliveryStage: WorkspacePeerDeliveryStage, options?: {
    now?: number;
}): Promise<boolean>;
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
    source?: WorkspacePeerMessageSource;
    messageKind?: WorkspacePeerMessageKind;
    traceId?: string;
    replyTo?: string;
    fromSessionName?: string;
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
