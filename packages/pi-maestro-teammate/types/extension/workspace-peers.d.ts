import { type MessageProvenanceV1 } from "../shared/types.ts";
import { type WorkspaceWindowTerminalResultDraft } from "../public/v1/workspace-completion.ts";
import { type WorkspaceProjectionItem, type WorkspaceTodoSnapshot } from "../public/v1/workspace-projections.ts";
export { createWorkspaceWindowTerminalResult, decodeWorkspaceWindowTerminalResult, encodeWorkspaceWindowTerminalResult, validateWorkspaceWindowTerminalResult, WORKSPACE_MAIN_SESSION_MARKER, WORKSPACE_WINDOW_TERMINAL_RESULT_TYPE, workspaceWindowCompletionHandle, workspaceWindowTerminalPublicationId, workspaceWindowTerminalReservationId, workspaceWindowTerminalResultMessageId, } from "../public/v1/workspace-completion.ts";
export type { WorkspaceWindowCompletionHandle, WorkspaceWindowTerminalOutcome, WorkspaceWindowTerminalResult, WorkspaceWindowTerminalResultDraft, } from "../public/v1/workspace-completion.ts";
export type { WorkspaceTodoSnapshot } from "../public/v1/workspace-projections.ts";
export declare const WORKSPACE_PEER_PROTOCOL_VERSION: 1;
export declare const DEFAULT_PEER_STALE_MS = 20000;
export declare const DEFAULT_PEER_HEARTBEAT_MS = 5000;
export declare const DEFAULT_PEER_PUBLISH_THROTTLE_MS = 200;
export declare const DEFAULT_PEER_MAILBOX_CLEANUP_INTERVAL_MS: number;
export declare const DEFAULT_COMMAND_TIMEOUT_MS = 5000;
export declare const MAX_OWNER_AGENTS = 256;
export declare const MAX_OWNER_SETTLED = 256;
export declare const MAX_OWNER_BACKGROUND_JOBS = 32;
export declare const WORKSPACE_OWNER_CAPABILITIES: readonly ["flow-schedule-todo-binding", "flow-schedule-todo-projection", "flow-schedule-todo-mutation", "flow-schedule-report"];
export type WorkspaceOwnerCapability = typeof WORKSPACE_OWNER_CAPABILITIES[number];
/** Maximum todo items in one owner snapshot. */
export declare const MAX_OWNER_TODOS = 32;
/** Maximum bytes for a single todo snapshot field (subject/assigneeLabel). */
export declare const MAX_TODO_FIELD_BYTES: number;
export declare const MAX_MAIN_SESSION_PROGRESS_EVENTS = 16;
export declare const MAIN_SESSION_PROGRESS_TEXT_BYTES: number;
export declare const MAX_OWNER_FILE_BYTES: number;
/** Maximum projection items contributed across all providers in one owner snapshot. */
export declare const MAX_OWNER_PROJECTION_ITEMS = 32;
/** Maximum bytes for a single projection item's JSON encoding. */
export declare const MAX_PROJECTION_ITEM_BYTES: number;
export declare const MAX_COMMAND_FILE_BYTES: number;
export declare const MAX_RESPONSE_FILE_BYTES: number;
export declare const MAX_COMMAND_MESSAGE_BYTES: number;
/** Maximum UTF-8 bytes retained from a worker's final assistant text. */
export declare const MAX_WORKSPACE_WINDOW_FINAL_TEXT_BYTES: number;
/** Maximum UTF-8 bytes retained from a worker terminal diagnostic. */
export declare const MAX_WORKSPACE_WINDOW_ERROR_BYTES: number;
export declare const MAX_WINDOW_LISTING_ACTIVE_AGENTS = 8;
/** A window whose main session was active within this window is busy even with zero sub-agents. */
export declare const MAIN_SESSION_ACTIVE_MS = 60000;
/** Legacy settled-result payload bound retained for v1 snapshot decoding compatibility. */
export declare const SETTLED_RESULT_BYTES: number;
/** Legacy public limit retained for consumers of the v1 snapshot contract. */
export declare const SETTLED_RESULT_MAX = 8;
/** Owner snapshot deletion threshold for stale cleanup (listing staleness stays at DEFAULT_PEER_STALE_MS). */
export declare const CLEANUP_STALE_DEFAULT_MS = 120000;
/** Version of the per-session owner identity file. */
export declare const IDENTITY_FILE_VERSION: 1;
/** Version of the immutable per-session owner claim file. */
export declare const OWNER_CLAIM_FILE_VERSION: 1;
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
    claimsDir?: string;
}
export interface WorkspacePeerIdentity {
    version: typeof WORKSPACE_PEER_PROTOCOL_VERSION;
    normalizedCwd: string;
    workspaceId: string;
    legacyWorkspaceIds?: readonly string[];
    ownerId: string;
    ownerNonce: string;
    ownerToken?: string;
    ownerGeneration?: number;
    sessionClaimKey?: string;
    paths: WorkspacePeerPaths;
    legacyPaths?: readonly WorkspacePeerPaths[];
}
export interface WorkspaceOwnerClaim {
    readonly identity: WorkspacePeerIdentity;
    readonly claimPath: string;
    readonly token: string;
    readonly generation: number;
    assertOwned(): Promise<void>;
    heartbeat(publishedAt?: number): Promise<void>;
    release(): Promise<void>;
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
    /** Legacy v1 field accepted when decoding old snapshots; new publications omit result bodies. */
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
export type WorkspaceMainSessionProgressEvent = {
    kind: "assistant";
    at: number;
    text: string;
} | {
    kind: "tool";
    at: number;
    toolCallId: string;
    toolName: string;
    status: "running" | "completed" | "failed";
} | {
    kind: "lifecycle";
    at: number;
    phase: "agent_start" | "turn_start" | "turn_end" | "agent_end" | "agent_settled";
};
/** Bounded, content-safe projection of the window's root Pi session. */
export interface WorkspaceMainSessionProgress {
    updatedAt: number;
    /** Monotonic semantic mutation counter; unlike sequence, advances for streamed text replacement. */
    revision?: number;
    /** Absolute cursor of the newest event ever appended by this window. */
    sequence: number;
    /** Absolute cursor immediately before events[0]; equals sequence when empty. */
    baseCursor: number;
    events: WorkspaceMainSessionProgressEvent[];
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
    /** Optional assistant/tool/lifecycle projection for cross-process observers. */
    mainProgress?: WorkspaceMainSessionProgress;
    /** Bounded Todo projection (worker root session). */
    todos?: readonly WorkspaceTodoSnapshot[];
}
export interface WorkspaceOwnerSnapshot {
    version: typeof WORKSPACE_PEER_PROTOCOL_VERSION;
    kind: "owner";
    workspaceId: string;
    normalizedCwd: string;
    ownerId: string;
    ownerNonce: string;
    /** Additive token/generation fence for claimed session owners. */
    ownerToken?: string;
    ownerGeneration?: number;
    sessionClaimKey?: string;
    pid: number;
    publishedAt: number;
    sessionId?: string;
    sessionName?: string;
    /** Optional capabilities advertised by this owner root session. */
    capabilities?: WorkspaceOwnerCapability[];
    /** Context pressure as percentage of the window's context window (0-100). */
    contextPressure?: number;
    /** Last main-session activity timestamp — liveness signal when no sub-agents are running. */
    mainActivityAt?: number;
    /** Optional assistant/tool/lifecycle projection for cross-process observers. */
    mainProgress?: WorkspaceMainSessionProgress;
    agents: WorkspaceAgentSnapshot[];
    settled: WorkspaceSettledSnapshot[];
    backgroundJobs?: WorkspaceBackgroundJobSnapshot[];
    /** Bounded projections contributed by registered workspace projection providers. */
    projections?: WorkspaceProjectionItem[];
    /** Bounded Todo projection from the worker root session (when a todo provider is registered). */
    todos?: WorkspaceTodoSnapshot[];
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
    /** Structured sender attribution; absent on legacy commands. */
    provenance?: MessageProvenanceV1;
    traceId?: string;
    replyTo?: string;
    /** Opt-in request for one terminal result status reply from a root worker window. */
    terminalResultRequested?: true;
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
    ownerClaim?: WorkspaceOwnerClaim;
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
export declare function workspaceProtocolCommandId(messageId: string | undefined): string | undefined;
/** Classify the authoritative final worker turn without treating empty output as success. */
export declare function deriveWorkspaceWindowTerminalResult(messages: readonly unknown[]): WorkspaceWindowTerminalResultDraft;
export declare function normalizeWorkspacePath(cwd: string, platform?: NodeJS.Platform): string;
export declare function workspaceIdForCwd(cwd: string, platform?: NodeJS.Platform): string;
export declare function defaultWorkspacePeerRoot(cwd: string): string;
export declare function createWorkspacePeerPaths(cwd: string, rootDir?: string): WorkspacePeerPaths;
export declare function createWorkspacePeerIdentity(cwd: string, options?: {
    rootDir?: string;
    ownerId?: string;
    ownerNonce?: string;
    ownerToken?: string;
    ownerGeneration?: number;
    sessionClaimKey?: string;
}): WorkspacePeerIdentity;
export declare function ownerSnapshotPath(identity: WorkspacePeerIdentity, ownerId?: string): string;
export declare function commandMailboxPath(identity: WorkspacePeerIdentity, ownerId: string): string;
export declare function responseMailboxPath(identity: WorkspacePeerIdentity, ownerId: string): string;
export declare function ensureWorkspacePeerDirectories(identity: WorkspacePeerIdentity): Promise<void>;
export declare function writePrivateJsonAtomic(path: string, value: unknown, maximumBytes: number, options?: {
    beforeCommit?: () => void | Promise<void>;
    /** Wrap the atomic rename in an ownership/lease critical section. */
    commit?: (renameCommit: () => Promise<void>) => Promise<void>;
}): Promise<void>;
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
export declare function validateWorkspaceMainSessionProgress(value: unknown): WorkspaceMainSessionProgress | undefined;
export declare function validateWorkspaceOwnerSnapshot(value: unknown, expected?: {
    workspaceId?: string;
    ownerId?: string;
}): WorkspaceOwnerSnapshot | undefined;
export declare function buildWorkspaceOwnerSnapshot(identity: WorkspacePeerIdentity, state: WorkspaceOwnerState, publishedAt?: number): WorkspaceOwnerSnapshot;
export declare function publishWorkspaceOwner(identity: WorkspacePeerIdentity, state: WorkspaceOwnerState, publishedAt?: number, options?: {
    /** @internal Test hook that runs after temp-file fsync and before the fenced rename. */
    beforeCommit?: () => void | Promise<void>;
}): Promise<WorkspaceOwnerSnapshot>;
export declare function discoverWorkspacePeers(identity: WorkspacePeerIdentity, options?: {
    now?: number;
    staleAfterMs?: number;
    cleanupStale?: boolean;
    cleanupStaleAfterMs?: number;
    includeSelf?: boolean;
    /** @internal Test hook for reverse stale-cleanup interleavings. */
    beforeCleanupStale?: (path: string, snapshot: WorkspaceOwnerSnapshot) => void | Promise<void>;
}): Promise<WorkspacePeerDiscovery>;
export interface PersistedOwnerIdentity {
    version: typeof IDENTITY_FILE_VERSION;
    ownerId: string;
}
export declare function workspacePeerIdentityPath(identity: WorkspacePeerIdentity, sessionKey: string): string;
export declare function workspacePeerClaimPath(identity: WorkspacePeerIdentity, sessionKey: string): string;
export declare function loadPersistedOwnerIdentity(identity: WorkspacePeerIdentity, sessionKey: string): Promise<PersistedOwnerIdentity | undefined>;
export declare function persistOwnerIdentity(identity: WorkspacePeerIdentity, sessionKey: string, ownerId: string): Promise<void>;
export declare function claimWorkspaceOwnerIdentity(cwd: string, options?: {
    rootDir?: string;
    sessionKey?: string;
    pid?: number;
    generation?: number;
    staleMs?: number;
    now?: () => number;
    /** @internal Test hook for canonical/legacy root conflict coverage. */
    legacyRootDirs?: readonly string[];
    /** @internal Runs after observing contention but before the takeover mutex. */
    beforeTakeover?: () => void | Promise<void>;
}): Promise<WorkspaceOwnerClaim>;
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
    provenance?: MessageProvenanceV1;
    traceId?: string;
    replyTo?: string;
    terminalResultRequested?: true;
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
    provenance?: MessageProvenanceV1;
    traceId?: string;
    replyTo?: string;
    terminalResultRequested?: true;
    fromSessionName?: string;
}): Promise<{
    command: WorkspacePeerCommand;
    response?: WorkspacePeerCommandResponse;
    timedOut: boolean;
}>;
export declare function consumeWorkspacePeerCommands(identity: WorkspacePeerIdentity, handler: (command: WorkspacePeerCommand) => WorkspaceCommandHandlerResult | void | Promise<WorkspaceCommandHandlerResult | void>, options?: {
    now?: number;
    limit?: number;
    /** @internal Test hook after claiming/reading a command but before handler fencing. */
    beforeHandle?: (command: WorkspacePeerCommand) => void | Promise<void>;
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
