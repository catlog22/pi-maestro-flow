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
