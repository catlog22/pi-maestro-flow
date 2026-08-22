export const DEFAULT_MODEL_CIRCUIT_BREAKER_THRESHOLD = 3;
export const DEFAULT_MODEL_CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

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

export type ModelHealthCandidateAcquisition =
  | AcquiredModelHealthCandidate
  | RejectedModelHealthCandidate;

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
  private readonly policies = new Map<string, ModelCircuitPolicy>();

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

  /**
   * Configure a per-model policy; `null` (or an empty policy) removes the
   * override and restores the constructor defaults for that model.
   */
  setPolicy(model: string, policy: ModelCircuitPolicy | null): void {
    if (model.length === 0) throw new TypeError("Model circuit breaker key must not be empty");
    if (!policy || (policy.threshold === undefined && policy.cooldownMs === undefined)) {
      this.policies.delete(model);
      return;
    }
    if (policy.threshold !== undefined
      && (!Number.isInteger(policy.threshold) || policy.threshold < 1)) {
      throw new RangeError("Model circuit breaker threshold must be a positive integer");
    }
    if (policy.cooldownMs !== undefined
      && (!Number.isFinite(policy.cooldownMs) || policy.cooldownMs < 0)) {
      throw new RangeError("Model circuit breaker cooldownMs must be a non-negative number");
    }
    this.policies.set(model, { ...policy });
  }

  /** Remove every per-model policy, restoring constructor defaults for all models. */
  clearPolicies(): void {
    this.policies.clear();
  }

  acquireCandidate(model: string): ModelCandidateAcquisition {
    const circuit = this.getOrCreateCircuit(model);
    const cooldownMs = this.effectiveCooldownMs(model);

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
      if (cooldownMs > 0
        && circuit.halfOpenEnteredAt !== undefined
        && this.now() >= circuit.halfOpenEnteredAt + cooldownMs) {
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

    const retryAt = this.retryAt(circuit, model);
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
    if (circuit.consecutiveFailures >= this.effectiveThreshold(acquisition.model)) this.open(circuit, acquisition.model);
  }

  releaseCandidate(acquisition: AcquiredModelCandidate): void {
    if (acquisition.state !== "HALF_OPEN") return;
    const circuit = this.circuits.get(acquisition.model);
    if (!circuit || circuit.generation !== acquisition.generation || circuit.state !== "HALF_OPEN") return;
    this.open(circuit, acquisition.model);
  }

  /**
   * Return an unspent HALF_OPEN permit to OPEN without starting a fresh
   * cooldown. This is used only to roll back a multi-key acquisition when a
   * later key rejects it; legacy callers keep the releaseCandidate semantics.
   */
  cancelCandidate(acquisition: AcquiredModelCandidate): void {
    if (acquisition.state !== "HALF_OPEN") return;
    const circuit = this.circuits.get(acquisition.model);
    if (!circuit || circuit.generation !== acquisition.generation || circuit.state !== "HALF_OPEN") return;
    const from = circuit.state;
    circuit.state = "OPEN";
    circuit.halfOpenTrialInProgress = false;
    circuit.halfOpenEnteredAt = undefined;
    circuit.generation += 1;
    this.emitTransition(acquisition.model, from, circuit.state);
  }

  /** Drop one key during an authoritative namespace reconciliation. */
  forget(model: string): boolean {
    if (model.length === 0) throw new TypeError("Model circuit breaker key must not be empty");
    this.policies.delete(model);
    return this.circuits.delete(model);
  }

  /**
   * Force a model back to a healthy, never-tried circuit by dropping its
   * recorded state. Use when a human explicitly selects the model (model
   * selector, /model, or Ctrl+P cycling): the manual choice is treated as an
   * override of the automatic breaker, so the next turn attempts it directly
   * instead of skipping it or auto-switching away. Returns true when a
   * non-CLOSED circuit was actually reset.
   */
  reset(model: string): boolean {
    if (model.length === 0) throw new TypeError("Model circuit breaker key must not be empty");
    const circuit = this.circuits.get(model);
    if (!circuit || circuit.state === "CLOSED") return false;
    const from = circuit.state;
    this.circuits.delete(model);
    this.emitTransition(model, from, "CLOSED");
    return true;
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
          retryAt: this.retryAt(circuit, model),
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

  private retryAt(circuit: MutableModelCircuit, model: string): number {
    return (circuit.openedAt ?? this.now()) + this.effectiveCooldownMs(model);
  }

  private effectiveThreshold(model: string): number {
    return this.policies.get(model)?.threshold ?? this.threshold;
  }

  private effectiveCooldownMs(model: string): number {
    return this.policies.get(model)?.cooldownMs ?? this.cooldownMs;
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

function scopedHealthRank(snapshot: ModelCircuitSnapshot | undefined): readonly [number, number] {
  if (!snapshot) return [0, 0];
  const band = snapshot.state === "OPEN" ? 2 : snapshot.state === "HALF_OPEN" ? 1 : 0;
  return [band, snapshot.consecutiveFailures];
}

function compareCompositeHealth(
  left: ModelHealthTarget,
  right: ModelHealthTarget,
  deploymentSnapshots: ReadonlyMap<string, ModelCircuitSnapshot>,
  routeSnapshots: ReadonlyMap<string, ModelCircuitSnapshot>,
): number {
  const leftDeployment = scopedHealthRank(deploymentSnapshots.get(left.deploymentId));
  const leftRoute = scopedHealthRank(routeSnapshots.get(left.modelRegistrationId));
  const rightDeployment = scopedHealthRank(deploymentSnapshots.get(right.deploymentId));
  const rightRoute = scopedHealthRank(routeSnapshots.get(right.modelRegistrationId));
  const leftRank = [
    Math.max(leftDeployment[0], leftRoute[0]),
    leftDeployment[0] + leftRoute[0],
    leftDeployment[1] + leftRoute[1],
  ];
  const rightRank = [
    Math.max(rightDeployment[0], rightRoute[0]),
    rightDeployment[0] + rightRoute[0],
    rightDeployment[1] + rightRoute[1],
  ];
  for (let index = 0; index < leftRank.length; index += 1) {
    const difference = leftRank[index]! - rightRank[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
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

/**
 * Registry-mode health authority. Deployment failures suppress every route on
 * that deployment, while route failures remain isolated to the canonical
 * model registration (aliases resolve to that same key).
 */
export class ModelHealthCoordinator {
  readonly deploymentBreaker: ModelCircuitBreaker;
  readonly routeBreaker: ModelCircuitBreaker;

  private projectionHash: string | undefined;
  private targets = new Map<string, ModelHealthTarget>();
  private aliases = new Map<string, string>();
  private reconcilesBreakerNamespace = true;

  constructor(options: ModelHealthCoordinatorOptions = {}) {
    if (options.deploymentBreaker && options.deployment) {
      throw new TypeError("Provide either deploymentBreaker or deployment options, not both");
    }
    if (options.routeBreaker && options.route) {
      throw new TypeError("Provide either routeBreaker or route options, not both");
    }
    if (options.deploymentBreaker !== undefined && options.deploymentBreaker === options.routeBreaker) {
      throw new TypeError("Deployment and route health require separate breaker instances");
    }
    this.deploymentBreaker = options.deploymentBreaker ?? new ModelCircuitBreaker(options.deployment);
    this.routeBreaker = options.routeBreaker ?? new ModelCircuitBreaker(options.route);
  }

  get projectionFingerprint(): string | undefined {
    return this.projectionHash;
  }

  /**
   * Capture one projection's target namespace while sharing this coordinator's
   * process-wide breaker stores. Catalog refreshes can then reconcile their own
   * maps without changing how an admitted dispatch resolves canonical ids.
   */
  createProjectionView(projection: ModelHealthProjection): ModelHealthCoordinator {
    const view = new ModelHealthCoordinator({
      deploymentBreaker: this.deploymentBreaker,
      routeBreaker: this.routeBreaker,
    });
    // Namespace reclamation belongs to the process-wide coordinator. A pinned
    // dispatch may outlive a catalog refresh and must never prune newer keys.
    view.reconcilesBreakerNamespace = false;
    view.reconcileProjection(projection);
    return view;
  }

  /**
   * Reconcile keys only when the authoritative projection fingerprint moves.
   * Health for still-present canonical ids survives a refresh; removed ids are
   * forgotten so deleting and later re-adding a registration starts healthy.
   */
  reconcileProjection(projection: ModelHealthProjection): boolean {
    if (!projection.hash) throw new TypeError("Model health projection hash must not be empty");
    if (projection.hash === this.projectionHash) return false;

    const nextTargets = new Map<string, ModelHealthTarget>();
    for (const [registrationId, route] of projection.routesByRegistrationId) {
      if (!registrationId || !route.deploymentId || route.modelRegistrationId !== registrationId) {
        throw new TypeError(`Invalid model health route projection for "${registrationId}"`);
      }
      if (!projection.deploymentsById.has(route.deploymentId)) {
        throw new TypeError(`Model health route "${registrationId}" references unknown deployment "${route.deploymentId}"`);
      }
      nextTargets.set(registrationId, Object.freeze({
        deploymentId: route.deploymentId,
        modelRegistrationId: registrationId,
      }));
    }

    const nextAliases = new Map<string, string>();
    for (const [alias, target] of projection.modelAliases) {
      if (!alias || !nextTargets.has(target)) {
        throw new TypeError(`Invalid model health alias "${alias}" -> "${target}"`);
      }
      nextAliases.set(alias, target);
    }

    if (this.reconcilesBreakerNamespace) {
      const deployments = new Set(projection.deploymentsById.keys());
      for (const snapshot of this.deploymentBreaker.snapshot()) {
        if (!deployments.has(snapshot.model)) this.deploymentBreaker.forget(snapshot.model);
      }
      for (const snapshot of this.routeBreaker.snapshot()) {
        if (!nextTargets.has(snapshot.model)) this.routeBreaker.forget(snapshot.model);
      }
    }
    this.targets = nextTargets;
    this.aliases = nextAliases;
    this.projectionHash = projection.hash;
    return true;
  }

  resolveTarget(modelRegistrationId: string): ModelHealthTarget | undefined {
    if (!modelRegistrationId) throw new TypeError("Model registration id must not be empty");
    const canonical = this.aliases.get(modelRegistrationId) ?? modelRegistrationId;
    return this.targets.get(canonical);
  }

  /** Read-only composite availability; absent circuit history is healthy. */
  isHealthy(modelRegistrationId: string): boolean {
    const target = this.resolveTarget(modelRegistrationId);
    if (!target) return true;
    const deployment = this.deploymentBreaker.snapshot().find((entry) => entry.model === target.deploymentId);
    const route = this.routeBreaker.snapshot().find((entry) => entry.model === target.modelRegistrationId);
    return (deployment === undefined || deployment.state === "CLOSED")
      && (route === undefined || route.state === "CLOSED");
  }

  acquireCandidate(modelRegistrationId: string): ModelHealthCandidateAcquisition {
    const target = this.resolveTarget(modelRegistrationId);
    if (!target) throw new TypeError(`Unknown model registration "${modelRegistrationId}"`);

    const deployment = this.deploymentBreaker.acquireCandidate(target.deploymentId);
    if (!deployment.allowed) {
      return { allowed: false, target, blockedScope: "deployment", circuit: deployment };
    }

    const route = this.routeBreaker.acquireCandidate(target.modelRegistrationId);
    if (!route.allowed) {
      // The paired permit is atomic from the caller's point of view. Returning
      // the deployment's unspent trial prevents a hidden HALF_OPEN holder.
      this.deploymentBreaker.cancelCandidate(deployment);
      return { allowed: false, target, blockedScope: "route", circuit: route };
    }
    return { allowed: true, target, deployment, route };
  }

  recordSuccess(acquisition: AcquiredModelHealthCandidate): void {
    this.deploymentBreaker.recordSuccess(acquisition.deployment);
    this.routeBreaker.recordSuccess(acquisition.route);
  }

  /** Charge only the failed scope and conclusively settle the paired permit. */
  recordFailure(acquisition: AcquiredModelHealthCandidate, scope: ModelHealthScope): void {
    if (scope === "deployment") {
      this.deploymentBreaker.recordRetryableFailure(acquisition.deployment);
      this.routeBreaker.cancelCandidate(acquisition.route);
      return;
    }
    this.deploymentBreaker.recordSuccess(acquisition.deployment);
    this.routeBreaker.recordRetryableFailure(acquisition.route);
  }

  /** Settle an inconclusive attempt using the legacy fresh-cooldown release rule. */
  releaseCandidate(acquisition: AcquiredModelHealthCandidate): void {
    this.deploymentBreaker.releaseCandidate(acquisition.deployment);
    this.routeBreaker.releaseCandidate(acquisition.route);
  }

  /** Return both permits without charging either scope or extending cooldown. */
  cancelCandidate(acquisition: AcquiredModelHealthCandidate): void {
    this.deploymentBreaker.cancelCandidate(acquisition.deployment);
    this.routeBreaker.cancelCandidate(acquisition.route);
  }

  rankCandidates(modelRegistrationIds: readonly string[]): string[] {
    const deploymentSnapshots = new Map(this.deploymentBreaker.snapshot().map((entry) => [entry.model, entry]));
    const routeSnapshots = new Map(this.routeBreaker.snapshot().map((entry) => [entry.model, entry]));
    return [...modelRegistrationIds].sort((left, right) => {
      const leftTarget = this.resolveTarget(left);
      const rightTarget = this.resolveTarget(right);
      if (!leftTarget) return rightTarget ? 1 : 0;
      if (!rightTarget) return -1;
      return compareCompositeHealth(leftTarget, rightTarget, deploymentSnapshots, routeSnapshots);
    });
  }

  snapshot(): ModelHealthSnapshot {
    return Object.freeze({
      ...(this.projectionHash === undefined ? {} : { projectionFingerprint: this.projectionHash }),
      deployments: this.deploymentBreaker.snapshot(),
      routes: this.routeBreaker.snapshot(),
    });
  }
}

export const sharedModelHealthCoordinator = new ModelHealthCoordinator();

export function rankModelRegistrationsByHealth(
  modelRegistrationIds: readonly string[],
  health: ModelHealthCoordinator,
): string[] {
  return health.rankCandidates(modelRegistrationIds);
}
