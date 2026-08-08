import {
  addBinding,
  createEngineState,
  flushPendingMonitorLedger,
  recordBindingExits,
  removeBinding,
  type MonitorBinding,
  type MonitorEngineState,
  type MonitorSupervisionMode,
} from "./monitor.ts";
import { MonitorLeaseAdapter, type MonitorLeaseCapture } from "./monitor-lease.ts";
import { MonitorRuntime, type MonitorRuntimeOptions } from "./monitor-runtime.ts";
import type { SessionEndpoint } from "../sessions/session-core.ts";
import type { MonitorLedgerRecord } from "./monitor-ledger.ts";

export interface MonitorControllerBindingRequest {
  key: string;
  endpoint: SessionEndpoint;
  displayName: string;
  mode: MonitorSupervisionMode;
  customPrompt?: string;
  goalId?: string;
  resumed?: boolean;
}

export interface MonitorControllerBindResult {
  bound: string[];
  errors: Array<{ key: string; error: string }>;
}

export interface MonitorControllerOptions {
  engine?: MonitorEngineState;
  leases: MonitorLeaseAdapter;
  runtime: Omit<
    MonitorRuntimeOptions,
    "engine" | "leases" | "getControllerGeneration" | "onBindingMissing"
  >;
  endpointIsCurrent: (endpoint: SessionEndpoint) => boolean;
  flushLedger?: (emit: (record: MonitorLedgerRecord) => void | Promise<void>) => void;
  awaitLedger?: () => Promise<void>;
  onBindingsChanged?: () => void;
}

/** Owns Monitor generations, bindings, scheduler quiescence, ledger exits, and leases. */
export class MonitorController {
  readonly engine: MonitorEngineState;
  readonly leases: MonitorLeaseAdapter;
  readonly runtime: MonitorRuntime;
  readonly options: MonitorControllerOptions;
  #generation = 0;
  #tail: Promise<void> = Promise.resolve();
  #missing = new Map<string, MonitorBinding>();
  #missingQueued = false;

  constructor(options: MonitorControllerOptions) {
    this.options = options;
    this.engine = options.engine ?? createEngineState();
    this.leases = options.leases;
    this.runtime = new MonitorRuntime({
      ...options.runtime,
      engine: this.engine,
      leases: this.leases,
      getControllerGeneration: () => this.#generation,
      onBindingMissing: (key, binding) => this.#queueMissing(key, binding),
    });
  }

  get generation(): number { return this.#generation; }
  get running(): boolean { return this.runtime.running; }

  bind(requests: readonly MonitorControllerBindingRequest[]): Promise<MonitorControllerBindResult> {
    return this.#serialize(() => this.#bind(requests));
  }

  remove(key: string, status = "removed", reason?: string): Promise<boolean> {
    return this.#serialize(() => this.#remove(key, status, reason));
  }

  resume(): Promise<boolean> {
    return this.#serialize(async () => {
      if (this.engine.bindings.size === 0) return false;
      ++this.#generation;
      if (this.runtime.running) await this.runtime.stop({ stopSession: false });
      this.runtime.start();
      this.options.onBindingsChanged?.();
      return true;
    });
  }

  exit(status = "user-exit", reason?: string): Promise<void> {
    return this.#serialize(() => this.#exit(status, reason));
  }

  shutdown(): Promise<void> {
    return this.exit("shutdown");
  }

  async #bind(requests: readonly MonitorControllerBindingRequest[]): Promise<MonitorControllerBindResult> {
    const result: MonitorControllerBindResult = { bound: [], errors: [] };
    const admissionGeneration = this.#generation;
    const admitted: Array<{ request: MonitorControllerBindingRequest; lease: MonitorLeaseCapture }> = [];
    const seen = new Set<string>();

    for (const request of requests) {
      if (seen.has(request.key) || this.engine.bindings.has(request.key)) {
        result.errors.push({ key: request.key, error: `Session ${request.displayName} already has a monitor.` });
        continue;
      }
      seen.add(request.key);
      if (!this.options.endpointIsCurrent(request.endpoint)) {
        result.errors.push({ key: request.key, error: "Session endpoint changed before monitor admission." });
        continue;
      }
      const acquired = await this.leases.acquire({
        key: request.key,
        ownerId: request.endpoint.ownerId,
        ownerNonce: request.endpoint.ownerNonce,
      });
      const lease = acquired.capture;
      const admissionCurrent = this.#generation === admissionGeneration
        && this.options.endpointIsCurrent(request.endpoint)
        && Boolean(lease && this.leases.isCurrent(lease))
        && lease?.ownerId === request.endpoint.ownerId
        && lease.ownerNonce === request.endpoint.ownerNonce
        && lease.monitorOwnerId === lease.identity.ownerId
        && lease.monitorOwnerNonce === lease.identity.ownerNonce;
      if (!acquired.ok || !lease || !admissionCurrent) {
        if (lease) await this.leases.release(lease);
        result.errors.push({ key: request.key, error: acquired.error ?? "Monitor ownership changed during admission." });
        continue;
      }
      admitted.push({ request, lease });
    }

    if (admitted.length === 0) return result;
    ++this.#generation;
    if (this.runtime.running) await this.runtime.stop({ stopSession: false });

    for (const { request, lease } of admitted) {
      if (!this.options.endpointIsCurrent(request.endpoint) || !this.leases.isCurrent(lease)) {
        await this.leases.release(lease);
        result.errors.push({ key: request.key, error: "Session endpoint or monitor lease changed before binding commit." });
        continue;
      }
      const added = addBinding(
        this.engine,
        request.key,
        request.displayName,
        request.mode,
        request.customPrompt,
        {
          ...(request.resumed ? { resumed: true } : {}),
          ...(request.goalId ? { goalId: request.goalId } : {}),
        },
      );
      if (!added.ok) {
        await this.leases.release(lease);
        result.errors.push({ key: request.key, error: added.error ?? "Monitor binding could not be created." });
        continue;
      }
      result.bound.push(request.key);
    }

    this.#flushPendingLedger();
    if (this.engine.bindings.size > 0) this.runtime.start();
    this.options.onBindingsChanged?.();
    return result;
  }

  async #remove(key: string, status: string, reason?: string): Promise<boolean> {
    const binding = this.engine.bindings.get(key);
    if (!binding) return false;
    const lease = this.leases.get(key);
    ++this.#generation;
    await this.runtime.stop({ stopSession: this.engine.bindings.size === 1 });
    if (this.engine.bindings.get(key) !== binding) return false;
    const removed = removeBinding(this.engine, key, status, reason);
    this.#flushPendingLedger();
    await this.options.awaitLedger?.();
    if (lease && this.leases.get(key) === lease) await this.leases.release(lease);
    if (this.engine.bindings.size > 0) this.runtime.start();
    this.options.onBindingsChanged?.();
    return removed;
  }

  async #exit(status: string, reason?: string): Promise<void> {
    ++this.#generation;
    await this.runtime.stop({ stopSession: true });
    recordBindingExits(this.engine, status, reason);
    this.engine.bindings.clear();
    this.#missing.clear();
    this.#flushPendingLedger();
    await this.options.awaitLedger?.();
    await this.leases.releaseAll();
    this.options.onBindingsChanged?.();
  }

  #queueMissing(key: string, binding: MonitorBinding): void {
    if (this.engine.bindings.get(key) !== binding) return;
    this.#missing.set(key, binding);
    if (this.#missingQueued) return;
    this.#missingQueued = true;
    queueMicrotask(() => {
      this.#missingQueued = false;
      void this.#serialize(() => this.#removeMissing());
    });
  }

  async #removeMissing(): Promise<void> {
    const missing = [...this.#missing].filter(([key, binding]) => this.engine.bindings.get(key) === binding);
    this.#missing.clear();
    if (missing.length === 0) return;
    const removingLast = missing.length === this.engine.bindings.size;
    ++this.#generation;
    await this.runtime.stop({ stopSession: removingLast });
    const releases: MonitorLeaseCapture[] = [];
    for (const [key, binding] of missing) {
      if (this.engine.bindings.get(key) !== binding) continue;
      const lease = this.leases.get(key);
      removeBinding(this.engine, key, "gone");
      if (lease) releases.push(lease);
    }
    this.#flushPendingLedger();
    await this.options.awaitLedger?.();
    for (const lease of releases) {
      if (this.leases.get(lease.key) === lease) await this.leases.release(lease);
    }
    if (this.engine.bindings.size > 0) this.runtime.start();
    this.options.onBindingsChanged?.();
  }

  #flushPendingLedger(): void {
    const emit = this.options.runtime.recordLedger;
    if (!emit) return;
    if (this.options.flushLedger) this.options.flushLedger(emit);
    else flushPendingMonitorLedger(this.engine, emit);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
