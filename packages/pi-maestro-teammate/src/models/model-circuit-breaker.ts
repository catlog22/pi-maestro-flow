export const DEFAULT_MODEL_CIRCUIT_BREAKER_THRESHOLD = 3;
export const DEFAULT_MODEL_CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

export type ModelCircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

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

interface MutableModelCircuit {
  state: ModelCircuitState;
  consecutiveFailures: number;
  generation: number;
  openedAt?: number;
  halfOpenTrialInProgress: boolean;
  /** Timestamp when the circuit entered HALF_OPEN; used as a watchdog deadline. */
  halfOpenEnteredAt?: number;
}

export class ModelCircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly onTransition: ((transition: ModelCircuitTransition) => void) | undefined;
  private readonly circuits = new Map<string, MutableModelCircuit>();

  constructor(options: ModelCircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? DEFAULT_MODEL_CIRCUIT_BREAKER_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_MODEL_CIRCUIT_BREAKER_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
    this.onTransition = options.onTransition;

    if (!Number.isInteger(this.threshold) || this.threshold < 1) {
      throw new RangeError("Model circuit breaker threshold must be a positive integer");
    }
    if (!Number.isFinite(this.cooldownMs) || this.cooldownMs < 0) {
      throw new RangeError("Model circuit breaker cooldownMs must be a non-negative number");
    }
  }

  acquireCandidate(model: string): ModelCandidateAcquisition {
    const circuit = this.getOrCreateCircuit(model);

    if (circuit.state === "CLOSED") {
      return {
        allowed: true,
        model,
        state: "CLOSED",
        generation: circuit.generation,
      };
    }

    if (circuit.state === "HALF_OPEN") {
      // Watchdog: if the HALF_OPEN trial has not settled within cooldownMs,
      // the trial holder likely crashed or leaked.  Re-open so the normal
      // OPEN → cooldown → HALF_OPEN recovery cycle can proceed.
      // Skipped when cooldownMs is 0 because the watchdog would fire
      // immediately and break the single-trial invariant.
      if (this.cooldownMs > 0
        && circuit.halfOpenEnteredAt !== undefined
        && this.now() >= circuit.halfOpenEnteredAt + this.cooldownMs) {
        this.open(circuit, model);
        // Fall through to the OPEN branch below (retryAt check).
      } else {
        return {
          allowed: false,
          model,
          state: "HALF_OPEN",
        };
      }
    }

    const retryAt = this.retryAt(circuit);
    if (this.now() < retryAt) {
      return {
        allowed: false,
        model,
        state: "OPEN",
        retryAt,
      };
    }

    const from = circuit.state;
    circuit.state = "HALF_OPEN";
    circuit.halfOpenTrialInProgress = true;
    circuit.halfOpenEnteredAt = this.now();
    this.emitTransition(model, from, circuit.state);
    return {
      allowed: true,
      model,
      state: "HALF_OPEN",
      generation: circuit.generation,
    };
  }

  recordSuccess(acquisition: AcquiredModelCandidate): void {
    const circuit = this.circuits.get(acquisition.model);
    if (!circuit || circuit.generation !== acquisition.generation) return;
    if (acquisition.state === "HALF_OPEN" && circuit.state !== "HALF_OPEN") return;
    if (acquisition.state === "CLOSED" && circuit.state !== "CLOSED") return;

    const from = circuit.state;
    circuit.state = "CLOSED";
    circuit.consecutiveFailures = 0;
    circuit.openedAt = undefined;
    circuit.halfOpenTrialInProgress = false;
    circuit.halfOpenEnteredAt = undefined;
    if (acquisition.state === "HALF_OPEN") circuit.generation += 1;
    this.emitTransition(acquisition.model, from, circuit.state);
  }

  recordRetryableFailure(acquisition: AcquiredModelCandidate): void {
    const circuit = this.circuits.get(acquisition.model);
    if (!circuit || circuit.generation !== acquisition.generation) return;

    if (acquisition.state === "HALF_OPEN") {
      if (circuit.state !== "HALF_OPEN") return;
      this.open(circuit, acquisition.model);
      return;
    }

    if (circuit.state !== "CLOSED") return;
    circuit.consecutiveFailures += 1;
    if (circuit.consecutiveFailures >= this.threshold) this.open(circuit, acquisition.model);
  }

  releaseCandidate(acquisition: AcquiredModelCandidate): void {
    if (acquisition.state !== "HALF_OPEN") return;
    const circuit = this.circuits.get(acquisition.model);
    if (!circuit || circuit.generation !== acquisition.generation || circuit.state !== "HALF_OPEN") return;
    this.open(circuit, acquisition.model);
  }

  snapshot(): readonly ModelCircuitSnapshot[] {
    const snapshots = [...this.circuits.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([model, circuit]) => Object.freeze({
        model,
        state: circuit.state,
        consecutiveFailures: circuit.consecutiveFailures,
        ...(circuit.openedAt === undefined ? {} : {
          openedAt: circuit.openedAt,
          retryAt: this.retryAt(circuit),
        }),
        halfOpenTrialInProgress: circuit.halfOpenTrialInProgress,
      }));
    return Object.freeze(snapshots);
  }

  private getOrCreateCircuit(model: string): MutableModelCircuit {
    if (model.length === 0) throw new TypeError("Model circuit breaker key must not be empty");
    let circuit = this.circuits.get(model);
    if (!circuit) {
      circuit = {
        state: "CLOSED",
        consecutiveFailures: 0,
        generation: 0,
        halfOpenTrialInProgress: false,
      };
      this.circuits.set(model, circuit);
    }
    return circuit;
  }

  private open(circuit: MutableModelCircuit, model: string): void {
    const from = circuit.state;
    circuit.state = "OPEN";
    circuit.openedAt = this.now();
    circuit.halfOpenTrialInProgress = false;
    circuit.halfOpenEnteredAt = undefined;
    circuit.generation += 1;
    this.emitTransition(model, from, circuit.state);
  }

  private emitTransition(model: string, from: ModelCircuitState, to: ModelCircuitState): void {
    const circuit = this.circuits.get(model);
    if (!this.onTransition) return;
    this.onTransition({
      model,
      from,
      to,
      consecutiveFailures: circuit?.consecutiveFailures ?? 0,
      at: this.now(),
    });
  }

  private retryAt(circuit: MutableModelCircuit): number {
    return (circuit.openedAt ?? this.now()) + this.cooldownMs;
  }
}

export const sharedModelCircuitBreaker = new ModelCircuitBreaker();

/**
 * Health rank: lower is healthier. Models with no circuit history (never
 * attempted) rank as healthy; CLOSED models rank by consecutive failures
 * (fewer first); HALF_OPEN recovery trials rank next; OPEN models last.
 */
function modelHealthRank(snapshot: ModelCircuitSnapshot | undefined): number {
  if (!snapshot) return 0;
  if (snapshot.state === "OPEN") return 10_000 + snapshot.consecutiveFailures;
  if (snapshot.state === "HALF_OPEN") return 5_000 + snapshot.consecutiveFailures;
  return snapshot.consecutiveFailures;
}

/**
 * Stable sort of model selectors by circuit health: healthy/never-tried
 * candidates first, recovering (HALF_OPEN) trials next, OPEN last. Equal
 * health keeps the input (configured) order — `Array.prototype.sort` is
 * stable. OPEN candidates are still gated by {@link acquireCandidate}; the
 * rank only decides the order in which candidates are attempted.
 */
export function rankModelsByHealth(
  models: readonly string[],
  breaker: ModelCircuitBreaker,
): string[] {
  const snapshots = new Map(breaker.snapshot().map((entry) => [entry.model, entry]));
  return [...models].sort((left, right) =>
    modelHealthRank(snapshots.get(left)) - modelHealthRank(snapshots.get(right)),
  );
}
