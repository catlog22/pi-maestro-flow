export declare const DEFAULT_MODEL_CIRCUIT_BREAKER_THRESHOLD = 3;
export declare const DEFAULT_MODEL_CIRCUIT_BREAKER_COOLDOWN_MS = 60000;
export type ModelCircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";
/**
 * Per-model circuit breaker policy. Omitted fields fall back to the breaker's
 * constructor defaults, so a partial policy like `{ threshold: 2 }` keeps the
 * global cooldown while tightening the failure count.
 */
export interface ModelCircuitPolicy {
    threshold?: number;
    cooldownMs?: number;
}
export interface ModelCircuitBreakerOptions {
    threshold?: number;
    cooldownMs?: number;
    now?: () => number;
    /** Optional transition hook fired on every CLOSED/OPEN/HALF_OPEN transition. */
    onTransition?: (transition: ModelCircuitTransition) => void;
}
export interface ModelCircuitTransition {
    model: string;
    from: ModelCircuitState;
    to: ModelCircuitState;
    consecutiveFailures: number;
    at: number;
}
export interface AcquiredModelCandidate {
    allowed: true;
    model: string;
    state: "CLOSED" | "HALF_OPEN";
    generation: number;
}
export interface RejectedModelCandidate {
    allowed: false;
    model: string;
    state: "OPEN" | "HALF_OPEN";
    retryAt?: number;
}
export type ModelCandidateAcquisition = AcquiredModelCandidate | RejectedModelCandidate;
export interface ModelCircuitSnapshot {
    model: string;
    state: ModelCircuitState;
    consecutiveFailures: number;
    openedAt?: number;
    retryAt?: number;
    halfOpenTrialInProgress: boolean;
}
export type ModelHealthScope = "deployment" | "route";
/** Canonical registry route identity used by the two health scopes. */
export interface ModelHealthTarget {
    deploymentId: string;
    modelRegistrationId: string;
}
/** Structural subset of the dispatch projection needed to reconcile health. */
export interface ModelHealthProjection {
    hash: string;
    routesByRegistrationId: ReadonlyMap<string, ModelHealthTarget>;
    deploymentsById: ReadonlyMap<string, unknown>;
    modelAliases: ReadonlyMap<string, string>;
}
export interface AcquiredModelHealthCandidate {
    allowed: true;
    target: ModelHealthTarget;
    deployment: AcquiredModelCandidate;
    route: AcquiredModelCandidate;
}
export interface RejectedModelHealthCandidate {
    allowed: false;
    target: ModelHealthTarget;
    blockedScope: ModelHealthScope;
    circuit: RejectedModelCandidate;
}
export type ModelHealthCandidateAcquisition = AcquiredModelHealthCandidate | RejectedModelHealthCandidate;
export interface ModelHealthSnapshot {
    projectionFingerprint?: string;
    deployments: readonly ModelCircuitSnapshot[];
    routes: readonly ModelCircuitSnapshot[];
}
export interface ModelHealthCoordinatorOptions {
    deploymentBreaker?: ModelCircuitBreaker;
    routeBreaker?: ModelCircuitBreaker;
    deployment?: ModelCircuitBreakerOptions;
    route?: ModelCircuitBreakerOptions;
}
export declare class ModelCircuitBreaker {
    private readonly threshold;
    private readonly cooldownMs;
    private readonly now;
    private readonly onTransition;
    private readonly circuits;
    private readonly policies;
    constructor(options?: ModelCircuitBreakerOptions);
    /**
     * Configure a per-model policy; `null` (or an empty policy) removes the
     * override and restores the constructor defaults for that model.
     */
    setPolicy(model: string, policy: ModelCircuitPolicy | null): void;
    /** Remove every per-model policy, restoring constructor defaults for all models. */
    clearPolicies(): void;
    acquireCandidate(model: string): ModelCandidateAcquisition;
    recordSuccess(acquisition: AcquiredModelCandidate): void;
    recordRetryableFailure(acquisition: AcquiredModelCandidate): void;
    releaseCandidate(acquisition: AcquiredModelCandidate): void;
    /**
     * Return an unspent HALF_OPEN permit to OPEN without starting a fresh
     * cooldown. This is used only to roll back a multi-key acquisition when a
     * later key rejects it; legacy callers keep the releaseCandidate semantics.
     */
    cancelCandidate(acquisition: AcquiredModelCandidate): void;
    /** Drop one key during an authoritative namespace reconciliation. */
    forget(model: string): boolean;
    /**
     * Force a model back to a healthy, never-tried circuit by dropping its
     * recorded state. Use when a human explicitly selects the model (model
     * selector, /model, or Ctrl+P cycling): the manual choice is treated as an
     * override of the automatic breaker, so the next turn attempts it directly
     * instead of skipping it or auto-switching away. Returns true when a
     * non-CLOSED circuit was actually reset.
     */
    reset(model: string): boolean;
    snapshot(): readonly ModelCircuitSnapshot[];
    private getOrCreateCircuit;
    private open;
    private emitTransition;
    private retryAt;
    private effectiveThreshold;
    private effectiveCooldownMs;
}
export declare const sharedModelCircuitBreaker: ModelCircuitBreaker;
/**
 * Stable sort of model selectors by circuit health: healthy/never-tried
 * candidates first, recovering (HALF_OPEN) trials next, OPEN last. Equal
 * health keeps the input (configured) order — `Array.prototype.sort` is
 * stable. OPEN candidates are still gated by {@link acquireCandidate}; the
 * rank only decides the order in which candidates are attempted.
 */
export declare function rankModelsByHealth(models: readonly string[], breaker: ModelCircuitBreaker): string[];
/**
 * Registry-mode health authority. Deployment failures suppress every route on
 * that deployment, while route failures remain isolated to the canonical
 * model registration (aliases resolve to that same key).
 */
export declare class ModelHealthCoordinator {
    readonly deploymentBreaker: ModelCircuitBreaker;
    readonly routeBreaker: ModelCircuitBreaker;
    private projectionHash;
    private targets;
    private aliases;
    private reconcilesBreakerNamespace;
    constructor(options?: ModelHealthCoordinatorOptions);
    get projectionFingerprint(): string | undefined;
    /**
     * Capture one projection's target namespace while sharing this coordinator's
     * process-wide breaker stores. Catalog refreshes can then reconcile their own
     * maps without changing how an admitted dispatch resolves canonical ids.
     */
    createProjectionView(projection: ModelHealthProjection): ModelHealthCoordinator;
    /**
     * Reconcile keys only when the authoritative projection fingerprint moves.
     * Health for still-present canonical ids survives a refresh; removed ids are
     * forgotten so deleting and later re-adding a registration starts healthy.
     */
    reconcileProjection(projection: ModelHealthProjection): boolean;
    resolveTarget(modelRegistrationId: string): ModelHealthTarget | undefined;
    /** Read-only composite availability; absent circuit history is healthy. */
    isHealthy(modelRegistrationId: string): boolean;
    acquireCandidate(modelRegistrationId: string): ModelHealthCandidateAcquisition;
    recordSuccess(acquisition: AcquiredModelHealthCandidate): void;
    /** Charge only the failed scope and conclusively settle the paired permit. */
    recordFailure(acquisition: AcquiredModelHealthCandidate, scope: ModelHealthScope): void;
    /** Settle an inconclusive attempt using the legacy fresh-cooldown release rule. */
    releaseCandidate(acquisition: AcquiredModelHealthCandidate): void;
    /** Return both permits without charging either scope or extending cooldown. */
    cancelCandidate(acquisition: AcquiredModelHealthCandidate): void;
    rankCandidates(modelRegistrationIds: readonly string[]): string[];
    snapshot(): ModelHealthSnapshot;
}
export declare const sharedModelHealthCoordinator: ModelHealthCoordinator;
export declare function rankModelRegistrationsByHealth(modelRegistrationIds: readonly string[], health: ModelHealthCoordinator): string[];
