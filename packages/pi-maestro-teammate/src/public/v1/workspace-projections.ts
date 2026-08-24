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

const REGISTRY_KEY = Symbol.for("pi-maestro.workspace-projection-providers.v1");
const DIRTY_LISTENERS_KEY = Symbol.for("pi-maestro.workspace-projection-dirty-listeners.v1");
const globals = globalThis as typeof globalThis & Record<symbol, unknown>;

function registry(): Map<string, WorkspaceProjectionProvider> {
  const existing = globals[REGISTRY_KEY];
  if (existing instanceof Map) return existing as Map<string, WorkspaceProjectionProvider>;
  const created = new Map<string, WorkspaceProjectionProvider>();
  globals[REGISTRY_KEY] = created;
  return created;
}

function dirtyListeners(): Set<() => void> {
  const existing = globals[DIRTY_LISTENERS_KEY];
  if (existing instanceof Set) return existing as Set<() => void>;
  const created = new Set<() => void>();
  globals[DIRTY_LISTENERS_KEY] = created;
  return created;
}

function notifyWorkspaceProjectionDirty(): void {
  for (const listener of dirtyListeners()) {
    try {
      listener();
    } catch {
      // Owner republish notification is best-effort.
    }
  }
}

/** Bind the active workspace owner publisher to projection dirty notifications. */
export function registerWorkspaceProjectionDirtyListener(listener: () => void): () => void {
  dirtyListeners().add(listener);
  return () => dirtyListeners().delete(listener);
}

/**
 * Register a workspace projection provider. Replaces an existing provider with
 * the same `kind`. Returns a dispose function that unregisters it. Never throws
 * on a bad provider — logs and returns a no-op disposer instead, so a faulty
 * provider never breaks owner snapshot publishing.
 */
export function registerWorkspaceProjectionProvider(
  provider: WorkspaceProjectionProvider,
): WorkspaceProjectionRegistration {
  if (!provider || typeof provider.kind !== "string" || !provider.kind.trim()) {
    return { kind: "", markDirty: () => undefined, dispose: () => undefined };
  }
  registry().set(provider.kind, provider);
  return {
    kind: provider.kind,
    markDirty: notifyWorkspaceProjectionDirty,
    dispose: () => {
      if (registry().get(provider.kind) !== provider) return;
      registry().delete(provider.kind);
      notifyWorkspaceProjectionDirty();
    },
  };
}

export function getWorkspaceProjectionProvider(kind: string): WorkspaceProjectionProvider | undefined {
  return registry().get(kind);
}

export function listWorkspaceProjectionProviders(): WorkspaceProjectionProvider[] {
  return [...registry().values()];
}

/**
 * Collect bounded, sanitized projection items from all registered providers.
 * Called by the owner snapshot builder. A throwing provider is logged and
 * skipped so one bad provider never breaks snapshot publishing.
 */
export function collectWorkspaceProjections(log?: (message: string) => void): WorkspaceProjectionItem[] {
  const items: WorkspaceProjectionItem[] = [];
  for (const provider of listWorkspaceProjectionProviders()) {
    try {
      const emitted = provider.snapshot();
      if (Array.isArray(emitted)) {
        for (const item of emitted) {
          if (item && typeof item.kind === "string" && item.kind === provider.kind) {
            items.push(item);
          }
        }
      }
    } catch (error) {
      log?.(`workspace projection provider "${provider.kind}" snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return items;
}

/**
 * Notify every provider with a `markDirty` hook that its projection changed.
 * This is a fan-out convenience; providers own the actual republish trigger.
 */
export function markAllWorkspaceProjectionsDirty(): void {
  for (const provider of listWorkspaceProjectionProviders()) {
    try {
      provider.markDirty?.();
    } catch {
      // markDirty best-effort; ignore failures.
    }
  }
  notifyWorkspaceProjectionDirty();
}
