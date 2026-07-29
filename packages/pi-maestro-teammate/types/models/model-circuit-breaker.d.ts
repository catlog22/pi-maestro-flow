export declare const DEFAULT_MODEL_CIRCUIT_BREAKER_THRESHOLD = 3;
export declare const DEFAULT_MODEL_CIRCUIT_BREAKER_COOLDOWN_MS = 60000;
export type ModelCircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";
export interface ModelCircuitBreakerOptions {
    threshold?: number;
    cooldownMs?: number;
    now?: () => number;
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
    private readonly circuits;
    constructor(options?: ModelCircuitBreakerOptions);
    acquireCandidate(model: string): ModelCandidateAcquisition;
    recordSuccess(acquisition: AcquiredModelCandidate): void;
    recordRetryableFailure(acquisition: AcquiredModelCandidate): void;
    releaseCandidate(acquisition: AcquiredModelCandidate): void;
    snapshot(): readonly ModelCircuitSnapshot[];
    private getOrCreateCircuit;
    private open;
    private retryAt;
}
export declare const sharedModelCircuitBreaker: ModelCircuitBreaker;
