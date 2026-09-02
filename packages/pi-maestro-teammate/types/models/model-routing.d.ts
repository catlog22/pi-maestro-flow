import type { RunTeammateParams } from "../runs/execution.ts";
import { type TeammateTaskType } from "../shared/task-types.ts";
import { type TeammateThinkingLevel } from "../shared/thinking.ts";
import type { ModelCircuitPolicy, ModelCircuitBreaker, ModelHealthCoordinator } from "./model-circuit-breaker.ts";
import type { DispatchAuthorityProjection, ModelDeploymentRoute, ModelDispatchRoute } from "./model-registry.ts";
export { TEAMMATE_TASK_TYPES, parseTeammateTaskType } from "../shared/task-types.ts";
export type { TeammateTaskType } from "../shared/task-types.ts";
export declare const TEAMMATE_TASK_TYPE_META: Record<string, {
    label: string;
    roles: string;
    description: string;
}>;
/**
 * Effective metadata for a task type: the user-defined `typeMeta` keywords
 * from the routing config, if any (custom types have no built-in meta).
 */
export declare function resolveTaskTypeMeta(config: ModelRoutingConfig, taskType: TeammateTaskType): {
    keywords?: string[];
} | undefined;
export interface ModelRoutingRoleRules {
    model?: string | null;
    fallbackModels?: string[] | null;
    thinking?: TeammateThinkingLevel | null;
    /** Per-role circuit breaker policy applied to the role's mapped model. */
    circuit?: ModelCircuitPolicy | null;
    /** Assigned task type; outranks the agent's frontmatter taskType at routing time. */
    taskType?: TeammateTaskType | null;
}
/** User-editable metadata for a task type: trigger keywords, like a skill description. */
export interface ModelRoutingTypeMeta {
    /** Trigger keywords defining when to use the type; `null` clears them. */
    keywords?: string[] | null;
}
export interface ModelRoutingRules {
    mappings: Partial<Record<TeammateTaskType, string | null>>;
    fallbackMappings?: Partial<Record<TeammateTaskType, string[] | null>>;
    thinkingLevels: Partial<Record<TeammateTaskType, TeammateThinkingLevel | null>>;
    roleMappings?: Record<string, ModelRoutingRoleRules | null>;
    /** Trigger-keyword metadata per task type; `null` clears an override. */
    typeMeta?: Record<string, ModelRoutingTypeMeta | null>;
}
export interface ModelRoutingProfile extends ModelRoutingRules {
    name: string;
}
export interface GlobalModelRoutingStore {
    version: 3;
    defaultProfile: string;
    profiles: Record<string, ModelRoutingProfile>;
    retiredProfileIds?: string[];
    /** Ask the user to confirm/pick model provider + thinking before each root dispatch. */
    askBeforeDispatch?: boolean;
}
export interface ProjectModelRoutingStore {
    version: 3;
    activeProfile?: string;
    applyOverrides: boolean;
    overrides: ModelRoutingRules;
}
export interface ModelRoutingConfig extends ModelRoutingRules {
    version: 3;
    profileId: string;
    profileName: string;
    projectOverridesEnabled: boolean;
}
export interface ModelRoutingState {
    global: GlobalModelRoutingStore;
    project: ProjectModelRoutingStore;
    config: ModelRoutingConfig;
    /** Effective ask-before-dispatch flag (global store, default off). */
    askBeforeDispatch: boolean;
    requestedProfile?: string;
    missingProfile?: string;
    changedProfileId?: string;
}
export interface TaskTypeInput {
    taskType?: TeammateTaskType;
    agent?: string;
    task?: string;
}
export declare function getGlobalModelRoutingPath(): string;
export declare function getProjectModelRoutingPath(cwd: string): string;
/**
 * Per-session routing overrides file path. The sessionId is sanitized to a
 * filesystem-safe slug so an untrusted id cannot escape the `.pi/` directory.
 * Session overrides stack on top of project overrides at the task-type mapping
 * layer and are scoped to the single Pi session that wrote them.
 */
export declare function getSessionModelRoutingPath(cwd: string, sessionId: string): string;
export interface SessionModelRoutingStore {
    version: 3;
    sessionId: string;
    createdAtMs: number;
    rules: ModelRoutingRules;
}
/**
 * Persist a session-scoped routing override. Session overrides stack on top
 * of project overrides (and the active profile) and apply only to the single
 * Pi session identified by `sessionId`. The file is written atomically under
 * the same lock protocol as the project config. A corrupted session file is
 * ignored at read time, so a bad write never blocks dispatch.
 */
export declare function saveSessionModelRoutingOverrides(cwd: string, sessionId: string, rules: ModelRoutingRules, globalFilePath?: string): ModelRoutingConfig;
/**
 * Persist the ask-before-dispatch flag on the global teammate model config.
 * The flag is user-level (not per profile/project): it controls whether the
 * root teammate tool asks the user to confirm or pick model provider/thinking
 * before every dispatch.
 */
export declare function setGlobalAskBeforeDispatch(enabled: boolean, globalFilePath?: string): boolean;
/** Effective ask-before-dispatch flag without a cwd (global store only). */
export declare function getGlobalAskBeforeDispatch(globalFilePath?: string): boolean;
export declare function loadModelRoutingState(cwd: string, globalFilePath?: string, sessionId?: string): ModelRoutingState;
export declare function loadModelRoutingConfig(cwd: string, globalFilePath?: string, sessionId?: string): ModelRoutingConfig;
export interface ModelRoutingStorePair {
    global: GlobalModelRoutingStore;
    project: ProjectModelRoutingStore;
}
export interface ModelRoutingStoreContentPair {
    global: string;
    project: string;
}
/** @internal Shared persistence bridge for the unified Settings provider. */
export declare function loadModelRoutingStores(globalFilePath: string, projectFilePath: string): ModelRoutingStorePair;
/** @internal Publish a prepared Settings transaction through the routing lock/journal protocol. */
export declare function replaceModelRoutingStores(globalFilePath: string, projectFilePath: string, expected: ModelRoutingStorePair, next: ModelRoutingStorePair, expectedContent?: ModelRoutingStoreContentPair): ModelRoutingStorePair;
export declare function discoverRoutingTaskTypes(cwd: string, agents?: readonly {
    taskType?: TeammateTaskType;
}[], loadedConfig?: ModelRoutingConfig): TeammateTaskType[];
export declare function saveProjectThinkingLevel(cwd: string, taskType: TeammateTaskType, thinking: TeammateThinkingLevel | null, globalFilePath?: string): ModelRoutingConfig;
export declare function saveProjectModelMapping(cwd: string, taskType: TeammateTaskType, model: string | null, globalFilePath?: string): ModelRoutingConfig;
export declare function saveProjectFallbackMapping(cwd: string, taskType: TeammateTaskType, models: string[] | null, globalFilePath?: string): ModelRoutingConfig;
export declare function saveProjectRoleMapping(cwd: string, role: string, rules: ModelRoutingRoleRules | null, globalFilePath?: string): ModelRoutingConfig;
/** A saved teammate model routing template (called a Profile in the Control Center). */
export interface ModelRoutingProfileSummary {
    id: string;
    name: string;
    active: boolean;
    default: boolean;
}
/** List saved routing templates with the current project's active selection. */
export declare function listModelRoutingProfiles(cwd: string, globalFilePath?: string): ModelRoutingProfileSummary[];
/** Resolve a stable Profile id or display name without changing the selection. */
export declare function resolveModelRoutingProfile(cwd: string, reference: string, globalFilePath?: string): ModelRoutingProfileSummary;
export declare function saveGlobalProfileModelMapping(cwd: string, profileId: string, taskType: TeammateTaskType, model: string | null, globalFilePath?: string): ModelRoutingState;
export declare function saveGlobalProfileThinkingLevel(cwd: string, profileId: string, taskType: TeammateTaskType, thinking: TeammateThinkingLevel | null, globalFilePath?: string): ModelRoutingState;
export declare function saveGlobalProfileFallbackMapping(cwd: string, profileId: string, taskType: TeammateTaskType, models: string[] | null, globalFilePath?: string): ModelRoutingState;
export declare function saveGlobalProfileRoleMapping(cwd: string, profileId: string, role: string, rules: ModelRoutingRoleRules | null, globalFilePath?: string): ModelRoutingState;
/** Atomically assign a task type to the requested roles and clear stale assignments to that type. */
export declare function saveGlobalProfileTypeRoles(cwd: string, profileId: string, taskType: TeammateTaskType, roles: readonly string[], globalFilePath?: string): ModelRoutingState;
/** Set, merge, or clear (null) the user-editable keywords for a task type. */
export declare function saveGlobalProfileTypeMeta(cwd: string, profileId: string, taskType: TeammateTaskType, meta: ModelRoutingTypeMeta | null, globalFilePath?: string): ModelRoutingState;
/**
 * Register a custom agent type in the active Profile. The type is marked by
 * an explicit `mappings[type] = null` entry ("auto model"), which keeps it
 * discoverable for routing configuration without forcing a model.
 */
export declare function saveGlobalProfileCustomType(cwd: string, profileId: string, taskType: TeammateTaskType, meta?: ModelRoutingTypeMeta | null, globalFilePath?: string): ModelRoutingState;
/** Remove a custom agent type and all of its routing entries from the active Profile. */
export declare function deleteGlobalProfileCustomType(cwd: string, profileId: string, taskType: TeammateTaskType, globalFilePath?: string): ModelRoutingState;
export declare function createGlobalModelRoutingProfile(cwd: string, name: string, sourceProfileId?: string, globalFilePath?: string): ModelRoutingState;
export declare function createAndActivateGlobalModelRoutingProfile(cwd: string, name: string, sourceProfileId?: string, globalFilePath?: string): ModelRoutingState;
export declare function renameGlobalModelRoutingProfile(cwd: string, profileId: string, name: string, globalFilePath?: string): ModelRoutingState;
export declare function setDefaultGlobalModelRoutingProfile(cwd: string, profileId: string, globalFilePath?: string): ModelRoutingState;
export declare function setProjectActiveModelRoutingProfile(cwd: string, profileId: string, globalFilePath?: string): ModelRoutingState;
/**
 * Activate a saved routing template for this project by stable id or display
 * name. Profile resolution and the project write share the existing global +
 * project lock, so a concurrent rename/delete cannot race the selection.
 */
export declare function activateModelRoutingProfile(cwd: string, reference: string, globalFilePath?: string): ModelRoutingState;
export declare function setProjectModelRoutingOverridesEnabled(cwd: string, enabled: boolean, globalFilePath?: string): ModelRoutingState;
export declare function clearProjectModelRoutingOverrides(cwd: string, globalFilePath?: string): ModelRoutingState;
export declare function promoteProjectModelRoutingOverrides(cwd: string, name: string, globalFilePath?: string): ModelRoutingState;
export declare function deleteGlobalModelRoutingProfile(cwd: string, profileId: string, globalFilePath?: string): ModelRoutingState;
export declare function inferTaskType(input: TaskTypeInput): TeammateTaskType | undefined;
/**
 * Match a task prompt against configured type keywords: the first type whose
 * keyword appears as a whole word wins, in discovery order (built-ins first,
 * then custom types alphabetically). Keywords are lowercased at normalize.
 */
export declare function inferTaskTypeByKeywords(config: ModelRoutingConfig, task: string | undefined): TeammateTaskType | undefined;
export declare function applyModelRouting(params: RunTeammateParams, cwd: string, availableModels?: readonly string[], globalFilePath?: string, inheritModel?: string, sessionId?: string): RunTeammateParams;
/**
 * Sync per-role circuit policies from the routing config onto a circuit
 * breaker: each role rule with a `circuit` policy uses the assigned task
 * type's mapped model first, then the role model when the type has no model.
 * The breaker's policy map is rebuilt from the config on every call, so
 * removed policies do not linger.
 */
export declare function syncModelCircuitPolicies(breaker: ModelCircuitBreaker, cwd: string, globalFilePath?: string): void;
/** Reconcile registry-mode health against the dispatch projection's stable hash. */
export declare function reconcileModelHealthProjection(health: ModelHealthCoordinator, projection: DispatchAuthorityProjection): boolean;
export interface ModelRegistrationRoutingInput {
    model?: string;
    fallbackModels?: readonly string[];
    backend?: string;
    cwd?: string;
}
export interface ResolvedModelRegistrationCandidate {
    modelRegistrationId: string;
    route: ModelDispatchRoute;
    deployment: ModelDeploymentRoute;
}
export interface ResolvedModelRegistrationRouting {
    candidates: readonly ResolvedModelRegistrationCandidate[];
    requestedDeploymentId?: string;
    remoteLocation?: string;
}
/**
 * Resolve one registry-mode task entirely through the captured dispatch
 * authority. No adapter model id, backend heuristic, or remote target name is
 * treated as a registration implicitly.
 */
export declare function resolveModelRegistrationRouting(projection: DispatchAuthorityProjection, input: ModelRegistrationRoutingInput): ResolvedModelRegistrationRouting;
/** Pi can hot-switch only between adapter selectors owned by one Pi deployment. */
export declare function canHotSwitchModelRegistration(from: ResolvedModelRegistrationCandidate, to: ResolvedModelRegistrationCandidate): boolean;
export interface ModelRegistryRefreshContext {
    modelRegistry?: {
        refresh?: () => Promise<unknown>;
    } | undefined;
}
/**
 * Await a coalesced refresh of the host model registry before reading its
 * getAvailable() snapshot. The sync snapshot is only rebuilt by refresh();
 * without it, models deleted from config/auth stay visible to catalog,
 * routing and modelCapabilities validation until unrelated code refreshes.
 */
export declare function refreshModelRegistry(ctx: ModelRegistryRefreshContext): Promise<void>;
/**
 * Configured routing targets that the current teammate catalog cannot reach.
 *
 * `mappedModel` skips unreachable targets silently (the dispatch then falls
 * back down the inheritance chain), so this is the one place an operator can
 * see that a task-type or role mapping names a model no gate currently
 * admits. Empty `availableModels` means "no catalog knowledge" and yields no
 * findings — absence of evidence must not read as breakage.
 */
export interface UnreachableRoutingTarget {
    kind: "taskType" | "role";
    key: string;
    model: string;
}
export declare function unreachableRoutingTargets(config: ModelRoutingConfig, availableModels: readonly string[]): UnreachableRoutingTarget[];
export declare function formatModelRoutingConfig(cwd: string, agents?: readonly {
    taskType?: TeammateTaskType;
}[], globalFilePath?: string, availableModels?: readonly string[]): string;
export declare const TASK_TYPE_ROUTING_START_MARKER = "<!-- teammate-tasktype-routing:start -->";
export declare const TASK_TYPE_ROUTING_END_MARKER = "<!-- teammate-tasktype-routing:end -->";
/**
 * Inject concise taskType model-routing guidance for agents that can dispatch
 * teammates. Replaces an existing block in place so repeated injection stays
 * idempotent.
 */
export declare function appendTaskTypeRoutingContext(systemPrompt: string, cwd: string, agents?: readonly {
    taskType?: TeammateTaskType;
}[], globalFilePath?: string, availableModels?: readonly string[]): string;
