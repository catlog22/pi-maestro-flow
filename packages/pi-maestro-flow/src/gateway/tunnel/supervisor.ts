/** Bounded, generation-fenced lifecycle supervisor for one tunnel instance. */
import { randomUUID } from "node:crypto";
import type {
  GatewayTunnelExit,
  GatewayTunnelOperationOptions,
  GatewayTunnelProcessIdentity,
  GatewayTunnelProvider,
  GatewayTunnelProviderRequest,
  GatewayTunnelRestartBudget,
  GatewayTunnelStartResult,
  GatewayTunnelState,
} from "./contracts.ts";
import { GATEWAY_TUNNEL_RECORD_VERSION } from "./contracts.ts";
import { GatewayTunnelProcessOwner, canonicalTunnelExecutable, gatewayTunnelInvocationDigest } from "./process-owner.ts";
import { createGatewayTunnelDeadline, probeGatewayTunnel, runWithinTunnelDeadline, type GatewayTunnelDeadline } from "./probe.ts";
import { GatewayTunnelStateConflictError, GatewayTunnelStateStore, type GatewayTunnelStateFence } from "./state-store.ts";
import type { GatewayObservationSink } from "../observability.ts";

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_RESTART_BUDGET: GatewayTunnelRestartBudget = { maxRestarts: 3, windowMs: 60_000 };

export interface GatewayTunnelSupervisorOptions {
  provider: GatewayTunnelProvider;
  instance?: string;
  stateStore: GatewayTunnelStateStore;
  processOwner?: GatewayTunnelProcessOwner;
  restartBudget?: Partial<GatewayTunnelRestartBudget>;
  operationTimeoutMs?: number;
  now?: () => number;
  canonicalizeExecutable?: (path: string) => Promise<string>;
  observer?: GatewayObservationSink;
}

interface InternalStartOptions extends GatewayTunnelOperationOptions { automatic?: boolean; }

export class GatewayTunnelSupervisor {
  readonly provider: GatewayTunnelProvider;
  readonly instance: string;
  readonly stateStore: GatewayTunnelStateStore;
  private readonly processOwner: GatewayTunnelProcessOwner;
  private readonly restartBudget: GatewayTunnelRestartBudget;
  private readonly operationTimeoutMs: number;
  private readonly now: () => number;
  private readonly canonicalizeExecutable: (path: string) => Promise<string>;
  private readonly observer?: GatewayObservationSink;
  private tail: Promise<void> = Promise.resolve();
  private startPromise?: Promise<GatewayTunnelState>;
  private closed = false;

  constructor(options: GatewayTunnelSupervisorOptions) {
    if (options.provider.name !== options.stateStore.provider) throw new Error("Tunnel provider and state store do not match");
    this.provider = options.provider;
    this.instance = options.instance ?? options.stateStore.instance;
    if (this.instance !== options.stateStore.instance) throw new Error("Tunnel instance and state store do not match");
    this.stateStore = options.stateStore;
    this.processOwner = options.processOwner ?? new GatewayTunnelProcessOwner();
    this.restartBudget = {
      maxRestarts: options.restartBudget?.maxRestarts ?? DEFAULT_RESTART_BUDGET.maxRestarts,
      windowMs: options.restartBudget?.windowMs ?? DEFAULT_RESTART_BUDGET.windowMs,
    };
    if (!Number.isSafeInteger(this.restartBudget.maxRestarts) || this.restartBudget.maxRestarts < 0) throw new Error("Tunnel maxRestarts must be a non-negative integer");
    if (!Number.isSafeInteger(this.restartBudget.windowMs) || this.restartBudget.windowMs < 1) throw new Error("Tunnel restart window must be positive");
    this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.canonicalizeExecutable = options.canonicalizeExecutable ?? canonicalTunnelExecutable;
    this.observer = options.observer;
  }

  status(): Promise<GatewayTunnelState | undefined> { return this.stateStore.read(); }

  start(options: GatewayTunnelOperationOptions = {}): Promise<GatewayTunnelState> {
    if (this.closed) return Promise.reject(new Error("Tunnel supervisor is closed"));
    if (this.startPromise) return this.startPromise;
    // Deadline starts at API entry, not when this operation reaches the queue.
    const normalized: InternalStartOptions = { ...options, deadlineAt: this.deadlineAt(options) };
    const operation = this.serial(() => this.startOnce(normalized));
    this.startPromise = operation;
    void operation.finally(() => { if (this.startPromise === operation) this.startPromise = undefined; }).catch(() => undefined);
    return operation;
  }

  stop(options: GatewayTunnelOperationOptions & { reason?: "explicit" | "restart" | "shutdown" } = {}): Promise<GatewayTunnelState> {
    const deadlineAt = this.deadlineAt(options);
    return this.serial(() => this.stopOnce({ ...options, deadlineAt }, options.reason ?? "explicit"));
  }

  async restart(options: GatewayTunnelOperationOptions = {}): Promise<GatewayTunnelState> {
    const deadlineAt = this.deadlineAt(options);
    await this.stop({ ...options, deadlineAt, reason: "restart" });
    return this.start({ ...options, deadlineAt });
  }

  quiesce(deadlineAt: number): Promise<GatewayTunnelState> {
    return this.stop({ deadlineAt, reason: "shutdown" });
  }

  /** Recover desired=running without ever trusting a PID by itself. */
  recover(options: GatewayTunnelOperationOptions = {}): Promise<GatewayTunnelState | undefined> {
    const deadlineAt = this.deadlineAt(options);
    return this.serial(async () => {
      const state = await this.stateStore.read();
      if (!state || state.desiredState !== "running") return state;
      if (!hasIdentity(state)) {
        queueMicrotask(() => { void this.start({ ...options, deadlineAt, input: options.input }).catch(() => undefined); });
        return state;
      }
      const identity = identityFromState(state);
      const deadline = this.createDeadline({ ...options, deadlineAt });
      try {
        const ownership = await runWithinTunnelDeadline(deadline, "adopt", () => this.processOwner.verify(identity, state.generation));
        if (!ownership.owned) {
          const failed = await this.saveSameGeneration(state, {
            ...state,
            observed: { phase: "failed", changedAt: this.now(), detail: `Persisted process was not adopted: ${ownership.reason}` },
            updatedAt: this.now(),
          });
          queueMicrotask(() => { void this.start({ ...options, deadlineAt, input: options.input }).catch(() => undefined); });
          return failed;
        }
        const request = this.requestFor(state, options.input);
        const adopted = await runWithinTunnelDeadline(deadline, "adopt", () => this.provider.adopt?.(deadline, identity, request));
        const process: GatewayTunnelStartResult = adopted ?? {
          pid: identity.pid,
          executablePath: identity.executableRealpath,
          args: [],
          processStartIdentity: identity.processStartIdentity,
          endpoint: state.observed.endpoint,
          opaqueId: state.observed.opaqueId,
        };
        const result = await probeGatewayTunnel(deadline, () => this.provider.probe(deadline, process, request));
        const next = await this.saveSameGeneration(state, {
          ...state,
          observed: {
            phase: result.ready ? "ready" : "degraded",
            changedAt: this.now(),
            ...(result.detail ? { detail: result.detail } : {}),
            ...(result.endpoint ?? state.observed.endpoint ? { endpoint: result.endpoint ?? state.observed.endpoint } : {}),
            ...(result.opaqueId ?? state.observed.opaqueId ? { opaqueId: result.opaqueId ?? state.observed.opaqueId } : {}),
          },
          updatedAt: this.now(),
        });
        this.watchExit(process, next, options.input);
        return next;
      } catch (error) {
        return this.saveFailure(state, error);
      } finally { deadline.close(); }
    });
  }

  async close(deadlineAt = this.now() + this.operationTimeoutMs): Promise<void> {
    this.closed = true;
    await this.quiesce(deadlineAt).catch(() => undefined);
  }

  private async startOnce(options: InternalStartOptions): Promise<GatewayTunnelState> {
    const current = await this.stateStore.read();
    if (options.expectedGeneration !== undefined && (current?.generation ?? 0) !== options.expectedGeneration) {
      throw new GatewayTunnelStateConflictError(`Tunnel generation is stale (expected ${options.expectedGeneration}, current ${current?.generation ?? 0})`);
    }
    if (current?.desiredState === "running" && (current.observed.phase === "starting" || current.observed.phase === "ready") && hasIdentity(current)) {
      const ownership = await this.processOwner.verify(identityFromState(current), current.generation);
      if (ownership.owned) return current;
    }
    const deadline = this.createDeadline(options);
    const generation = (current?.generation ?? 0) + 1;
    const ownerToken = randomUUID();
    const requestedAt = this.now();
    const initial: GatewayTunnelState = {
      version: GATEWAY_TUNNEL_RECORD_VERSION,
      provider: this.provider.name,
      instance: this.instance,
      desiredState: "running",
      observed: { phase: "starting", changedAt: requestedAt },
      generation,
      ownerToken,
      restartHistory: options.automatic ? (current?.restartHistory ?? []) : [],
      updatedAt: requestedAt,
    };
    await this.saveState(initial, current ? { expectedGeneration: current.generation, expectedOwnerToken: current.ownerToken } : { expectedGeneration: 0 });
    const request = this.requestFor(initial, options.input);
    let started: GatewayTunnelStartResult | undefined;
    try {
      deadline.throwIfExpired("doctor");
      const doctor = await runWithinTunnelDeadline(deadline, "doctor", () => this.provider.doctor(deadline, request));
      if (!doctor.ok) throw tunnelError("tunnel_doctor_failed", doctor.detail ?? `Tunnel provider ${this.provider.name} is unavailable`);
      started = await runWithinTunnelDeadline(deadline, "start", () => this.provider.start(deadline, request));
      const executableRealpath = await runWithinTunnelDeadline(deadline, "start", () => this.canonicalizeExecutable(started!.executablePath));
      const observed = await runWithinTunnelDeadline(deadline, "start", () => this.processOwner.inspect(started!.pid));
      const processStartIdentity = started.processStartIdentity ?? observed.processStartIdentity;
      if (!processStartIdentity) throw tunnelError("tunnel_identity_unavailable", "Tunnel process start identity is unavailable");
      const invocationDigest = gatewayTunnelInvocationDigest(executableRealpath, started.args);
      const withProcess: GatewayTunnelState = {
        ...initial,
        pid: started.pid,
        executableRealpath,
        processStartIdentity,
        invocationDigest,
        observed: {
          phase: "starting",
          changedAt: this.now(),
          ...(started.endpoint ? { endpoint: started.endpoint } : {}),
          ...(started.opaqueId ? { opaqueId: started.opaqueId } : {}),
        },
        updatedAt: this.now(),
      };
      await this.saveState(withProcess, { expectedGeneration: generation, expectedOwnerToken: ownerToken });
      let publishedEndpoint = withProcess.observed.endpoint;
      let publishedOpaqueId = withProcess.observed.opaqueId;
      const probed = await probeGatewayTunnel(
        deadline,
        () => this.provider.probe(deadline, started!, request),
        100,
        async (result) => {
          const nextEndpoint = result.endpoint ?? publishedEndpoint;
          const nextOpaqueId = result.opaqueId ?? publishedOpaqueId;
          if (nextEndpoint === publishedEndpoint && nextOpaqueId === publishedOpaqueId) return;
          const interim: GatewayTunnelState = {
            ...withProcess,
            observed: {
              phase: "starting",
              changedAt: this.now(),
              ...(result.detail ? { detail: result.detail } : {}),
              ...(nextEndpoint ? { endpoint: nextEndpoint } : {}),
              ...(nextOpaqueId ? { opaqueId: nextOpaqueId } : {}),
            },
            updatedAt: this.now(),
          };
          await this.saveState(interim, { expectedGeneration: generation, expectedOwnerToken: ownerToken });
          publishedEndpoint = nextEndpoint;
          publishedOpaqueId = nextOpaqueId;
        },
      );
      if (!probed.ready) throw tunnelError("tunnel_probe_failed", probed.detail ?? "Tunnel readiness probe failed");
      const ready: GatewayTunnelState = {
        ...withProcess,
        observed: {
          phase: "ready",
          changedAt: this.now(),
          ...(probed.detail ? { detail: probed.detail } : {}),
          ...(probed.endpoint ?? publishedEndpoint ?? started.endpoint ? { endpoint: probed.endpoint ?? publishedEndpoint ?? started.endpoint } : {}),
          ...(probed.opaqueId ?? publishedOpaqueId ?? started.opaqueId ? { opaqueId: probed.opaqueId ?? publishedOpaqueId ?? started.opaqueId } : {}),
        },
        updatedAt: this.now(),
      };
      await this.saveState(ready, { expectedGeneration: generation, expectedOwnerToken: ownerToken });
      this.watchExit(started, ready, options.input);
      return ready;
    } catch (error) {
      const latest = await this.stateStore.read().catch(() => undefined);
      if (started && latest && latest.generation === generation && latest.ownerToken === ownerToken && hasIdentity(latest)) {
        await this.stopOwned(deadline, latest, "startup-failed", options.input).catch(() => undefined);
      }
      if (latest && latest.generation === generation && latest.ownerToken === ownerToken) await this.saveFailure(latest, error).catch(() => undefined);
      throw error;
    } finally { deadline.close(); }
  }

  private async stopOnce(options: GatewayTunnelOperationOptions, reason: "explicit" | "restart" | "shutdown"): Promise<GatewayTunnelState> {
    const current = await this.stateStore.read();
    if (!current) return this.initialStopped();
    if (options.expectedGeneration !== undefined && current.generation !== options.expectedGeneration) {
      throw new GatewayTunnelStateConflictError(`Tunnel generation is stale (expected ${options.expectedGeneration}, current ${current.generation})`);
    }
    if (current.desiredState === "stopped" && current.observed.phase === "stopped") return current;
    const quiescing: GatewayTunnelState = {
      ...current,
      desiredState: "stopped", // Fence auto-restart before signalling the process.
      observed: { ...current.observed, phase: "quiescing", changedAt: this.now() },
      updatedAt: this.now(),
    };
    await this.saveState(quiescing, { expectedGeneration: current.generation, expectedOwnerToken: current.ownerToken });
    const deadline = this.createDeadline(options);
    try {
      if (hasIdentity(quiescing)) {
        const ownership = await runWithinTunnelDeadline(deadline, "stop", () => this.processOwner.verify(identityFromState(quiescing), quiescing.generation));
        if (ownership.alive && !ownership.owned) throw tunnelError("tunnel_ownership_denied", `Refused to stop tunnel process: ${ownership.reason}`);
        if (ownership.owned) await runWithinTunnelDeadline(deadline, "stop", () => this.provider.stop(deadline, identityFromState(quiescing), { ...this.requestFor(quiescing, options.input), reason }));
      }
      const stopped: GatewayTunnelState = {
        ...withoutProcess(quiescing),
        desiredState: "stopped",
        observed: { phase: "stopped", changedAt: this.now() },
        updatedAt: this.now(),
      };
      return await this.saveState(stopped, { expectedGeneration: quiescing.generation, expectedOwnerToken: quiescing.ownerToken });
    } catch (error) {
      await this.saveFailure(quiescing, error).catch(() => undefined);
      throw error;
    } finally { deadline.close(); }
  }

  private async stopOwned(deadline: GatewayTunnelDeadline, state: GatewayTunnelState, reason: "startup-failed", input?: Readonly<Record<string, unknown>>): Promise<void> {
    const identity = identityFromState(state);
    const ownership = await runWithinTunnelDeadline(deadline, "stop", () => this.processOwner.verify(identity, state.generation));
    if (!ownership.owned) throw new Error(`Tunnel startup cleanup ownership check failed: ${ownership.reason}`);
    await runWithinTunnelDeadline(deadline, "stop", () => this.provider.stop(deadline, identity, { ...this.requestFor(state, input), reason }));
  }

  private watchExit(process: GatewayTunnelStartResult, state: GatewayTunnelState, input?: Readonly<Record<string, unknown>>): void {
    if (!process.exited) return;
    void process.exited.then(
      (exit) => this.serial(() => this.handleExit(state.generation, state.ownerToken, exit, input)),
      (error) => this.serial(() => this.handleExit(state.generation, state.ownerToken, { code: null, at: this.now(), detail: error instanceof Error ? error.message : String(error) }, input)),
    ).catch(() => undefined);
  }

  private async handleExit(generation: number, ownerToken: string, exit: GatewayTunnelExit, input?: Readonly<Record<string, unknown>>): Promise<void> {
    const current = await this.stateStore.read();
    if (!current || current.generation !== generation || current.ownerToken !== ownerToken) return;
    const at = exit.at ?? this.now();
    if (current.desiredState === "stopped" || current.observed.phase === "quiescing") {
      await this.saveState({ ...withoutProcess(current), observed: { phase: "stopped", changedAt: at, lastExit: { ...exit, at } }, updatedAt: at }, { expectedGeneration: generation, expectedOwnerToken: ownerToken });
      return;
    }
    const restartHistory = current.restartHistory.filter((entry) => entry >= at - this.restartBudget.windowMs);
    restartHistory.push(at);
    const exhausted = restartHistory.length > this.restartBudget.maxRestarts;
    const next: GatewayTunnelState = {
      ...withoutProcess(current),
      restartHistory,
      observed: { phase: exhausted ? "failed" : "degraded", changedAt: at, detail: exhausted ? "Tunnel restart budget exhausted" : "Tunnel process exited unexpectedly", lastExit: { ...exit, at } },
      updatedAt: at,
    };
    await this.saveState(next, { expectedGeneration: generation, expectedOwnerToken: ownerToken });
    if (!exhausted && !this.closed) queueMicrotask(() => { void this.start({ automatic: true, ...(input ? { input } : {}) } as InternalStartOptions).catch(() => undefined); });
  }

  private saveSameGeneration(current: GatewayTunnelState, next: GatewayTunnelState): Promise<GatewayTunnelState> {
    return this.saveState(next, { expectedGeneration: current.generation, expectedOwnerToken: current.ownerToken });
  }

  private async saveState(state: GatewayTunnelState, fence: GatewayTunnelStateFence): Promise<GatewayTunnelState> {
    const saved = await this.stateStore.save(state, fence);
    this.observer?.observe({ category: "tunnel", event: "transition", phase: saved.observed.phase });
    return saved;
  }

  private saveFailure(current: GatewayTunnelState, error: unknown): Promise<GatewayTunnelState> {
    const message = error instanceof Error ? error.message : String(error);
    return this.saveSameGeneration(current, {
      ...current,
      observed: { ...current.observed, phase: "failed", changedAt: this.now(), detail: message.slice(0, 16 * 1024) },
      updatedAt: this.now(),
    });
  }

  private requestFor(state: GatewayTunnelState, input?: Readonly<Record<string, unknown>>): GatewayTunnelProviderRequest {
    return { provider: state.provider, instance: state.instance, generation: state.generation, ownerToken: state.ownerToken, ...(input ? { input } : {}) };
  }

  private initialStopped(): GatewayTunnelState {
    const now = this.now();
    return { version: GATEWAY_TUNNEL_RECORD_VERSION, provider: this.provider.name, instance: this.instance, desiredState: "stopped", observed: { phase: "stopped", changedAt: now }, generation: 0, ownerToken: randomUUID(), restartHistory: [], updatedAt: now };
  }

  private deadlineAt(options: GatewayTunnelOperationOptions): number {
    if (options.deadlineAt !== undefined) return options.deadlineAt;
    const timeout = options.timeoutMs ?? this.operationTimeoutMs;
    if (!Number.isFinite(timeout) || timeout < 1) throw new Error("Tunnel timeoutMs must be positive");
    return this.now() + timeout;
  }

  private createDeadline(options: GatewayTunnelOperationOptions): GatewayTunnelDeadline {
    return createGatewayTunnelDeadline(Math.max(1, (options.deadlineAt ?? this.deadlineAt(options)) - this.now()), { deadlineAt: options.deadlineAt ?? this.deadlineAt(options), now: this.now });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function identityFromState(state: GatewayTunnelState): GatewayTunnelProcessIdentity {
  if (!hasIdentity(state)) throw new Error("Tunnel state has no complete process identity");
  return {
    pid: state.pid,
    executableRealpath: state.executableRealpath,
    processStartIdentity: state.processStartIdentity,
    invocationDigest: state.invocationDigest,
    generation: state.generation,
    ownerToken: state.ownerToken,
  };
}

function hasIdentity(state: GatewayTunnelState): state is GatewayTunnelState & Required<Pick<GatewayTunnelState, "pid" | "executableRealpath" | "processStartIdentity" | "invocationDigest">> {
  return state.pid !== undefined && state.executableRealpath !== undefined && state.processStartIdentity !== undefined && state.invocationDigest !== undefined;
}

function withoutProcess(state: GatewayTunnelState): GatewayTunnelState {
  const { pid: _pid, executableRealpath: _executable, processStartIdentity: _start, invocationDigest: _digest, ...rest } = state;
  return rest;
}

function tunnelError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
