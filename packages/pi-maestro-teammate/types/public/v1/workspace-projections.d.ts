/**
 * Workspace projection providers — single-direction, runtime-registered
 * bounded projections that extend the cross-process {@link WorkspaceOwnerSnapshot}.
 *
 * Design constraints (Flow→Teammate dependency):
 * - `pi-maestro-flow` depends on `pi-maestro-teammate`; the reverse is forbidden.
 *   So Teammate cannot import Flow's todo store. Instead Teammate exposes this
 *   registration surface; Flow registers a provider at session start and
 *   disposes it at shutdown. The provider runs in the registering process
 *   (the worker's root session) and is consulted while building the owner
 *   snapshot that is published to peers (including the Monitor).
 *
 * This mirrors {@link registerObservationProvider}: a symbol-keyed global
 * registry + a dispose function that unregisters.
 */
/** Canonical Todo status exposed through the bounded workspace owner snapshot. */
export type WorkspaceTodoStatus = "pending" | "in_progress" | "completed" | "blocked" | "deleted";
/** Bounded projection of one worker-root Todo for cross-process observers. */
export interface WorkspaceTodoSnapshot {
    id: string;
    subject: string;
    status: WorkspaceTodoStatus;
    assigneeLabel?: string;
    dispatchId?: string;
    scheduleId?: string;
    stepId?: string;
    /** Durable-derived binding liveness. Omitted when no binding is known. */
    bindingActive?: boolean;
    updatedAt: number;
}
/** A single bounded, sanitized projection item contributed to the owner snapshot. */
export interface WorkspaceProjectionItem {
    /** Provider kind that emitted this item (echoes the provider's `kind`). */
    kind: string;
    /** Opaque, provider-specific structured payload. Must be JSON-serializable. */
    data: unknown;
}
export interface WorkspaceProjectionProvider {
    /** Stable, non-empty provider kind. */
    kind: string;
    /**
     * Return the current bounded projection items. Called synchronously during
     * owner snapshot construction. Implementations must be cheap and bounded;
     * throw only on genuine fatal errors (which will be logged and dropped).
     */
    snapshot(): WorkspaceProjectionItem[];
    /**
     * Notify the provider that the owner snapshot should be republished because
     * its projection changed. The provider typically forwards this to the
     * workspace peer publisher's `markDirty()`.
     */
    markDirty?(): void;
}
export interface WorkspaceProjectionRegistration {
    readonly kind: string;
    /** Request owner snapshot republishing after the provider's projection changes. */
    markDirty(): void;
    /** Remove this registration from the global registry. */
    dispose(): void;
}
/** Bind the active workspace owner publisher to projection dirty notifications. */
export declare function registerWorkspaceProjectionDirtyListener(listener: () => void): () => void;
/**
 * Register a workspace projection provider. Replaces an existing provider with
 * the same `kind`. Returns a dispose function that unregisters it. Never throws
 * on a bad provider — logs and returns a no-op disposer instead, so a faulty
 * provider never breaks owner snapshot publishing.
 */
export declare function registerWorkspaceProjectionProvider(provider: WorkspaceProjectionProvider): WorkspaceProjectionRegistration;
export declare function getWorkspaceProjectionProvider(kind: string): WorkspaceProjectionProvider | undefined;
export declare function listWorkspaceProjectionProviders(): WorkspaceProjectionProvider[];
/**
 * Collect bounded, sanitized projection items from all registered providers.
 * Called by the owner snapshot builder. A throwing provider is logged and
 * skipped so one bad provider never breaks snapshot publishing.
 */
export declare function collectWorkspaceProjections(log?: (message: string) => void): WorkspaceProjectionItem[];
/**
 * Notify every provider with a `markDirty` hook that its projection changed.
 * This is a fan-out convenience; providers own the actual republish trigger.
 */
export declare function markAllWorkspaceProjectionsDirty(): void;
