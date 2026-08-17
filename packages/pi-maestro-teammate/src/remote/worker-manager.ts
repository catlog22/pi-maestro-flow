import { randomUUID } from "node:crypto";
import { resolveRemoteTarget, type RemoteConfig } from "./config.ts";
import type { RemoteConnection, RemoteConnectionFactory } from "./driver.ts";
import {
  captureMatches,
  type RemoteInitializeResult,
  type RemoteProtocolNotification,
  type RemoteRunInputResult,
  type RemoteRunCancelResult,
  type RemoteRunStartResult,
} from "./protocol.ts";
import { applyRemoteRunEvent, createRemoteRunSnapshot } from "./state.ts";
import {
  REMOTE_PROTOCOL_VERSION,
  isRemoteStatus,
  isRemoteTerminalStatus,
  type RemoteInputMode,
  type RemoteRunCapture,
  type RemoteRunEvent,
  type RemoteRunResultEvent,
  type RemoteRunSnapshot,
  type RemoteStatus,
  type RemoteWorkerHeartbeat,
  type ResolvedRemoteTarget,
} from "./types.ts";

export const REMOTE_MANAGER_MAX_OWNED_RUNS = 512;
export const REMOTE_MANAGER_MAX_START_COMMANDS = 4096;
export const REMOTE_MANAGER_MAX_ORPHAN_EVENTS = 1024;

export class RemoteOwnershipError extends Error {
  constructor(message = "Remote run ownership capture mismatch") {
    super(message);
    this.name = "RemoteOwnershipError";
  }
}

export class RemoteWorkerQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerQuotaError";
  }
}

export class RemoteWorkerDisconnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerDisconnectedError";
  }
}

export interface RemoteWorkerManagerOptions {
  config: RemoteConfig;
  connectionFactory: RemoteConnectionFactory;
  monitorOwnerNonce?: string;
  maxRunsPerHost?: number;
  maxOwnedRuns?: number;
  maxStartCommands?: number;
  maxOrphanEvents?: number;
  commandIdFactory?: () => string;
  now?: () => number;
  onEvent?: (capture: RemoteRunCapture, event: RemoteRunEvent) => void;
  onSnapshot?: (capture: RemoteRunCapture, snapshot: RemoteRunSnapshot) => void;
}

export interface RemoteWorkerStartRequest {
  targetId: string;
  name: string;
  objective: string;
  commandId?: string;
  outputSchema?: unknown;
  signal?: AbortSignal;
}

export interface RemoteWorkerAttachRequest {
  capture: RemoteRunCapture;
  snapshot?: RemoteRunSnapshot;
  commandId?: string;
  signal?: AbortSignal;
}

export interface RemoteWorkerWaitOptions {
  statuses?: readonly RemoteStatus[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RemoteWorkerView {
  targetHostId: string;
  workerId: string;
  instanceNonce: string;
  concurrency: number;
  activeRuns: number;
  status: RemoteStatus;
}

interface WorkerBinding {
  hostId: string;
  target: ResolvedRemoteTarget;
  connection: RemoteConnection;
  hello?: RemoteInitializeResult;
  status: RemoteStatus;
  remoteActiveRuns: number;
  startedSinceHeartbeat: number;
  reservations: number;
  heartbeatEpoch: number;
  orphanEvents: Map<string, RemoteRunEvent[]>;
  orphanCount: number;
  earlyHeartbeat?: RemoteProtocolNotification & { method: "worker/heartbeat" };
  pump?: Promise<void>;
}

interface OwnedRun {
  capture: RemoteRunCapture;
  target: ResolvedRemoteTarget;
  snapshot: RemoteRunSnapshot;
  quotaBinding?: WorkerBinding;
  quotaEpoch?: number;
  waiters: Set<RunWaiter>;
}

interface RunWaiter {
  statuses: ReadonlySet<RemoteStatus>;
  resolve: (snapshot: RemoteRunSnapshot) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface StartCommand {
  fingerprint: string;
  promise: Promise<RemoteRunCapture>;
  settled: boolean;
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function validateHello(value: RemoteInitializeResult): void {
  if (!validIdentity(value.workerId)
    || !validIdentity(value.instanceNonce)
    || value.protocolVersion !== REMOTE_PROTOCOL_VERSION
    || !Number.isInteger(value.concurrency)
    || value.concurrency < 1
    || value.concurrency > 128
    || !Number.isInteger(value.activeRuns)
    || value.activeRuns < 0
    || value.activeRuns > value.concurrency
    || (value.status !== "ready" && value.status !== "running" && value.status !== "waiting")) {
    throw new Error("Invalid remote worker hello");
  }
}

/** The protocol version an unupgraded `pi-teammate-remote` daemon still speaks. */
const LEGACY_REMOTE_PROTOCOL_VERSION = "remote/1";

// A `remote/1` daemon refuses a `remote/2` handshake before it ever reaches its
// own version check: parameter validation runs first and demands the
// `capabilities` array this host stopped sending, so the operator is handed
// `-32602 Invalid capabilities` instead of the `-32002` refusal that names both
// versions. Read both codes as version skew — `-32002` is the same failure once
// the daemon is new enough to diagnose itself.
function isVersionSkewRefusal(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === -32002 || (code === -32602 && error.message.includes("capabilities"));
}

function versionSkewDiagnostic(host: string, error: Error): Error {
  return new Error(
    `Remote handshake with ${host} failed: the local monitor speaks ${REMOTE_PROTOCOL_VERSION}`
    + ` and the daemon on ${host} answered like a ${LEGACY_REMOTE_PROTOCOL_VERSION} daemon.`
    + ` Upgrade pi-teammate-remote on ${host} and restart serve, then retry.`
    + ` Remote reply: ${error.message}`,
    { cause: error },
  );
}

function validateStartResult(value: RemoteRunStartResult): void {
  if (!validIdentity(value.workerId)
    || !validIdentity(value.instanceNonce)
    || !validIdentity(value.runId)
    || !Number.isInteger(value.generation)
    || value.generation < 1
    || (value.status !== "running" && value.status !== "waiting")
    || !Number.isInteger(value.firstSequence)
    || value.firstSequence < 1) {
    throw new Error("Invalid remote run start result");
  }
}

function snapshotMatchesCapture(snapshot: RemoteRunSnapshot, capture: RemoteRunCapture): boolean {
  return snapshot.workerId === capture.workerId
    && snapshot.instanceNonce === capture.instanceNonce
    && snapshot.runId === capture.runId
    && snapshot.generation === capture.generation
    && (snapshot.targetId === undefined || snapshot.targetId === capture.targetId);
}

function eventIdentityMatches(event: RemoteRunEvent, capture: RemoteRunCapture): boolean {
  return event.workerId === capture.workerId
    && event.instanceNonce === capture.instanceNonce
    && event.runId === capture.runId
    && event.generation === capture.generation;
}

function cloneSnapshot(snapshot: RemoteRunSnapshot): RemoteRunSnapshot {
  return { ...snapshot };
}

function ensureCaptureShape(capture: RemoteRunCapture): void {
  if (!validIdentity(capture.workerId)
    || !validIdentity(capture.instanceNonce)
    || !validIdentity(capture.runId)
    || !Number.isInteger(capture.generation)
    || capture.generation < 1
    || !validIdentity(capture.monitorOwnerNonce)
    || !capture.targetId) {
    throw new RemoteOwnershipError("Invalid remote run ownership capture");
  }
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 1) throw new Error(`${label} must be a positive integer`);
  return normalized;
}

function startFingerprint(request: RemoteWorkerStartRequest): string {
  return JSON.stringify({
    targetId: request.targetId,
    name: request.name,
    objective: request.objective,
    outputSchema: request.outputSchema,
  });
}

/** Owns configured remote workers and exact owner-fenced run captures. */
export class RemoteWorkerManager {
  readonly monitorOwnerNonce: string;
  readonly #config: RemoteConfig;
  readonly #connectionFactory: RemoteConnectionFactory;
  readonly #maxRunsPerHost: number;
  readonly #maxOwnedRuns: number;
  readonly #maxStartCommands: number;
  readonly #maxOrphanEvents: number;
  readonly #commandIdFactory: () => string;
  readonly #now: () => number;
  readonly #onEvent?: (capture: RemoteRunCapture, event: RemoteRunEvent) => void;
  readonly #onSnapshot?: (capture: RemoteRunCapture, snapshot: RemoteRunSnapshot) => void;
  readonly #workers = new Map<string, WorkerBinding>();
  readonly #connecting = new Map<string, Promise<WorkerBinding>>();
  readonly #ownedRuns = new Map<string, OwnedRun>();
  readonly #startCommands = new Map<string, StartCommand>();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: RemoteWorkerManagerOptions) {
    this.#config = options.config;
    this.#connectionFactory = options.connectionFactory;
    this.monitorOwnerNonce = options.monitorOwnerNonce ?? randomUUID();
    if (!validIdentity(this.monitorOwnerNonce)) throw new Error("Invalid monitor owner nonce");
    this.#maxRunsPerHost = positiveLimit(options.maxRunsPerHost, 128, "Remote runs per host");
    this.#maxOwnedRuns = positiveLimit(options.maxOwnedRuns, REMOTE_MANAGER_MAX_OWNED_RUNS, "Remote owned runs");
    this.#maxStartCommands = positiveLimit(options.maxStartCommands, REMOTE_MANAGER_MAX_START_COMMANDS, "Remote start commands");
    this.#maxOrphanEvents = positiveLimit(options.maxOrphanEvents, REMOTE_MANAGER_MAX_ORPHAN_EVENTS, "Remote orphan events");
    this.#commandIdFactory = options.commandIdFactory ?? (() => randomUUID());
    this.#now = options.now ?? Date.now;
    this.#onEvent = options.onEvent;
    this.#onSnapshot = options.onSnapshot;
  }

  resolveTarget(targetId: string): ResolvedRemoteTarget {
    return resolveRemoteTarget(this.#config, targetId);
  }

  async connect(targetId: string, signal?: AbortSignal): Promise<RemoteWorkerView> {
    const target = this.resolveTarget(targetId);
    const binding = await this.#workerFor(target, signal);
    return this.#workerView(binding);
  }

  workers(): RemoteWorkerView[] {
    return [...this.#workers.values()].map((binding) => this.#workerView(binding));
  }

  start(request: RemoteWorkerStartRequest): Promise<RemoteRunCapture> {
    if (this.#closed) return Promise.reject(new Error("Remote worker manager is closed"));
    if (request.signal?.aborted) return Promise.reject(abortError("Remote run start was aborted"));
    const commandId = request.commandId ?? this.#commandIdFactory();
    if (!validIdentity(commandId)) return Promise.reject(new Error("Invalid remote start command id"));
    const fingerprint = startFingerprint(request);
    const existing = this.#startCommands.get(commandId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new Error("Remote start command id was reused with different parameters"));
      }
      return existing.promise;
    }
    while (this.#startCommands.size >= this.#maxStartCommands) {
      const settled = [...this.#startCommands].find(([, entry]) => entry.settled);
      if (!settled) return Promise.reject(new RemoteWorkerQuotaError("Remote start command registry limit reached"));
      this.#startCommands.delete(settled[0]);
    }
    const promise = this.#start(request, commandId);
    const command: StartCommand = { fingerprint, promise, settled: false };
    this.#startCommands.set(commandId, command);
    void promise.then(
      () => { command.settled = true; },
      () => { command.settled = true; },
    );
    return promise;
  }

  async attach(request: RemoteWorkerAttachRequest): Promise<RemoteRunCapture> {
    this.#assertManagerOpen();
    this.#assertOwnedCapture(request.capture, false);
    if (request.signal?.aborted) throw abortError("Remote run attach was aborted");
    const existing = this.#ownedRuns.get(request.capture.runId);
    if (existing) {
      this.#requireOwned(request.capture);
      await this.replay(request.capture, request.commandId, request.signal);
      return { ...existing.capture };
    }
    if (this.#ownedRuns.size >= this.#maxOwnedRuns) throw new RemoteWorkerQuotaError("Remote owned-run registry limit reached");
    const target = this.resolveTarget(request.capture.targetId);
    const binding = await this.#workerFor(target, request.signal);
    const baseline = request.snapshot;
    if (baseline && !snapshotMatchesCapture(baseline, request.capture)) throw new RemoteOwnershipError();
    const lastSequence = baseline?.lastSequence ?? 0;
    const result = await binding.connection.attach({
      commandId: request.commandId ?? this.#commandIdFactory(),
      runId: request.capture.runId,
      generation: request.capture.generation,
      monitorOwnerNonce: this.monitorOwnerNonce,
      lastSequence,
    });
    if (result.workerId !== request.capture.workerId
      || result.instanceNonce !== request.capture.instanceNonce
      || result.runId !== request.capture.runId
      || result.generation !== request.capture.generation) {
      throw new RemoteOwnershipError("Remote attach returned a stale ownership capture");
    }
    const snapshot = baseline
      ? cloneSnapshot(baseline)
      : createRemoteRunSnapshot(request.capture, result.status, this.#now());
    const record: OwnedRun = {
      capture: { ...request.capture },
      target,
      snapshot,
      waiters: new Set(),
    };
    this.#admit(record, binding);
    return { ...record.capture };
  }

  async replay(capture: RemoteRunCapture, commandId = this.#commandIdFactory(), signal?: AbortSignal): Promise<RemoteRunSnapshot> {
    this.#assertManagerOpen();
    const record = this.#requireOwned(capture);
    if (signal?.aborted) throw abortError("Remote run replay was aborted");
    const binding = await this.#workerFor(record.target, signal);
    const beforeSequence = record.snapshot.lastSequence;
    const result = await binding.connection.attach({
      commandId,
      runId: capture.runId,
      generation: capture.generation,
      monitorOwnerNonce: this.monitorOwnerNonce,
      lastSequence: beforeSequence,
    });
    if (result.workerId !== capture.workerId
      || result.instanceNonce !== capture.instanceNonce
      || result.runId !== capture.runId
      || result.generation !== capture.generation) {
      throw new RemoteOwnershipError("Remote replay returned a stale ownership capture");
    }
    if (record.snapshot.lastSequence === beforeSequence) {
      record.snapshot = { ...record.snapshot, status: result.status, updatedAt: this.#now() };
      this.#publishSnapshot(record);
    }
    return cloneSnapshot(record.snapshot);
  }

  async send(capture: RemoteRunCapture, mode: RemoteInputMode, message: string, commandId = this.#commandIdFactory()): Promise<RemoteRunInputResult> {
    this.#assertManagerOpen();
    const record = this.#requireOwned(capture);
    if (isRemoteTerminalStatus(record.snapshot.status)) throw new Error("Cannot send input to a terminal remote run");
    const binding = this.#connectedBinding(record.target.host);
    return binding.connection.input({
      commandId,
      runId: capture.runId,
      generation: capture.generation,
      monitorOwnerNonce: this.monitorOwnerNonce,
      mode,
      message,
    });
  }

  followUp(capture: RemoteRunCapture, message: string, commandId?: string): Promise<RemoteRunInputResult> {
    return this.send(capture, "follow_up", message, commandId);
  }

  steer(capture: RemoteRunCapture, message: string, commandId?: string): Promise<RemoteRunInputResult> {
    return this.send(capture, "steer", message, commandId);
  }

  async cancel(
    capture: RemoteRunCapture,
    reason?: string,
    commandId = this.#commandIdFactory(),
  ): Promise<RemoteRunCancelResult> {
    this.#assertManagerOpen();
    const record = this.#requireOwned(capture);
    const binding = this.#connectedBinding(record.target.host);
    return binding.connection.cancel({
      commandId,
      runId: capture.runId,
      generation: capture.generation,
      monitorOwnerNonce: this.monitorOwnerNonce,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  snapshot(capture: RemoteRunCapture): RemoteRunSnapshot {
    return cloneSnapshot(this.#requireOwned(capture).snapshot);
  }

  snapshots(): RemoteRunSnapshot[] {
    return [...this.#ownedRuns.values()].map((record) => cloneSnapshot(record.snapshot));
  }

  wait(capture: RemoteRunCapture, options: RemoteWorkerWaitOptions = {}): Promise<RemoteRunSnapshot> {
    if (this.#closed) return Promise.reject(new Error("Remote worker manager is closed"));
    const record = this.#requireOwned(capture);
    const statuses = new Set<RemoteStatus>(options.statuses ?? ["completed", "failed", "cancelled", "lost"]);
    if (statuses.size < 1 || [...statuses].some((status) => !isRemoteStatus(status))) {
      return Promise.reject(new Error("Invalid remote wait statuses"));
    }
    if (statuses.has(record.snapshot.status)) return Promise.resolve(cloneSnapshot(record.snapshot));
    if (options.signal?.aborted) return Promise.reject(abortError("Remote run wait was aborted"));
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1)) {
      return Promise.reject(new Error("Remote wait timeout must be a positive integer"));
    }
    return new Promise((resolve, reject) => {
      const waiter: RunWaiter = { statuses, resolve, reject, ...(options.signal ? { signal: options.signal } : {}) };
      if (options.timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          record.waiters.delete(waiter);
          this.#cleanupWaiter(waiter);
          reject(new Error("Timed out waiting for remote run"));
        }, options.timeoutMs);
        waiter.timer.unref?.();
      }
      if (options.signal) {
        waiter.onAbort = () => {
          record.waiters.delete(waiter);
          this.#cleanupWaiter(waiter);
          reject(abortError("Remote run wait was aborted"));
        };
        options.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      record.waiters.add(waiter);
    });
  }

  async disconnect(targetId: string): Promise<void> {
    const target = this.resolveTarget(targetId);
    const binding = this.#workers.get(target.host);
    if (!binding) return;
    this.#workers.delete(target.host);
    this.#markDisconnected(binding);
    await binding.connection.close();
  }

  async reconnect(targetId: string, signal?: AbortSignal): Promise<RemoteWorkerView> {
    this.#assertManagerOpen();
    if (signal?.aborted) throw abortError("Remote worker reconnect was aborted");
    const target = this.resolveTarget(targetId);
    const existing = this.#workers.get(target.host);
    if (existing) {
      this.#workers.delete(target.host);
      this.#markDisconnected(existing);
      await existing.connection.close();
    }
    const binding = await this.#workerFor(target, signal);
    this.#assertCurrentBinding(target.host, binding);
    const remote = await binding.connection.list(this.#commandIdFactory(), this.monitorOwnerNonce);
    this.#assertCurrentBinding(target.host, binding);
    if (signal?.aborted) throw abortError("Remote worker reconnect was aborted");
    const remoteRuns = new Map(remote.runs.map((snapshot) => [snapshot.runId, snapshot]));
    const records = [...this.#ownedRuns.values()].filter((record) => record.target.host === target.host
      && !isRemoteTerminalStatus(record.snapshot.status));
    let transientFailure: { error: unknown } | undefined;
    for (const record of records) {
      const found = remoteRuns.get(record.capture.runId);
      if (!found || !snapshotMatchesCapture(found, record.capture)) {
        this.#markLost(record, "Remote worker no longer owns the captured run");
        continue;
      }
      try {
        this.#assertCurrentBinding(target.host, binding);
        await this.replay(record.capture, this.#commandIdFactory(), signal);
        this.#assertCurrentBinding(target.host, binding);
      } catch (error) {
        if (error instanceof RemoteOwnershipError) {
          this.#markLost(record, "Remote run ownership changed during replay");
          continue;
        }
        this.#markRunDisconnected(record, "Remote run replay is temporarily unavailable");
        transientFailure ??= { error };
        if (signal?.aborted) break;
      }
    }
    if (transientFailure) throw transientFailure.error;
    return this.#workerView(binding);
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    const closing = this.#closeResources();
    this.#closePromise = closing;
    return closing;
  }

  async #closeResources(): Promise<void> {
    const pendingStarts = [...this.#startCommands.values()]
      .filter((command) => !command.settled)
      .map((command) => command.promise);
    const pendingConnections = [...this.#connecting.values()];
    await Promise.allSettled([...pendingStarts, ...pendingConnections]);

    const bindings = [...this.#workers.values()];
    this.#workers.clear();
    for (const binding of bindings) this.#markDisconnected(binding);
    for (const record of this.#ownedRuns.values()) {
      for (const waiter of record.waiters) {
        this.#cleanupWaiter(waiter);
        waiter.reject(new RemoteWorkerDisconnectedError("Remote worker manager closed while waiting"));
      }
      record.waiters.clear();
    }
    await Promise.allSettled(bindings.map((binding) => binding.connection.close()));
    const closeFactory = this.#connectionFactory as RemoteConnectionFactory & { close?: () => Promise<void> };
    if (closeFactory.close) await closeFactory.close();
  }

  async #start(request: RemoteWorkerStartRequest, commandId: string): Promise<RemoteRunCapture> {
    const target = this.resolveTarget(request.targetId);
    const binding = await this.#workerFor(target, request.signal);
    this.#assertManagerOpen();
    if (this.#ownedRuns.size >= this.#maxOwnedRuns) throw new RemoteWorkerQuotaError("Remote owned-run registry limit reached");
    const capacity = Math.min(binding.hello!.concurrency, this.#maxRunsPerHost);
    const occupied = binding.remoteActiveRuns + binding.startedSinceHeartbeat + binding.reservations;
    if (occupied >= capacity) throw new RemoteWorkerQuotaError(`Remote host ${binding.hostId} concurrency limit reached`);
    binding.reservations += 1;
    let result: RemoteRunStartResult | undefined;
    try {
      result = await binding.connection.start({
        commandId,
        targetId: target.id,
        monitorOwnerNonce: this.monitorOwnerNonce,
        name: request.name,
        objective: request.objective,
        cwd: target.cwd,
        driver: target.driver,
        command: target.command,
        ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
      });
      this.#assertManagerOpen();
      if (request.signal?.aborted) throw abortError("Remote run start was aborted after dispatch");
      validateStartResult(result);
      if (result.workerId !== binding.hello!.workerId || result.instanceNonce !== binding.hello!.instanceNonce) {
        throw new RemoteOwnershipError("Remote start returned a stale worker identity");
      }
      const capture: RemoteRunCapture = {
        workerId: result.workerId,
        instanceNonce: result.instanceNonce,
        runId: result.runId,
        generation: result.generation,
        monitorOwnerNonce: this.monitorOwnerNonce,
        targetId: target.id,
      };
      const record: OwnedRun = {
        capture,
        target,
        snapshot: createRemoteRunSnapshot(capture, result.status, this.#now()),
        quotaBinding: binding,
        quotaEpoch: binding.heartbeatEpoch,
        waiters: new Set(),
      };
      this.#assertManagerOpen();
      binding.startedSinceHeartbeat += 1;
      try {
        this.#admit(record, binding);
      } catch (error) {
        binding.startedSinceHeartbeat = Math.max(0, binding.startedSinceHeartbeat - 1);
        await this.#rollbackStart(binding, result);
        result = undefined;
        throw error;
      }
      return { ...capture };
    } catch (error) {
      if (result) await this.#rollbackStart(binding, result);
      throw error;
    } finally {
      binding.reservations = Math.max(0, binding.reservations - 1);
    }
  }

  async #rollbackStart(binding: WorkerBinding, result: RemoteRunStartResult): Promise<void> {
    if (!validIdentity(result.runId) || !Number.isInteger(result.generation) || result.generation < 1) {
      await binding.connection.close();
      return;
    }
    try {
      await binding.connection.cancel({
        commandId: this.#commandIdFactory(),
        runId: result.runId,
        generation: result.generation,
        monitorOwnerNonce: this.monitorOwnerNonce,
        reason: "local-admission-rollback",
      });
    } catch {
      await binding.connection.close();
    }
  }

  #admit(record: OwnedRun, binding: WorkerBinding): void {
    const existing = this.#ownedRuns.get(record.capture.runId);
    if (existing) {
      if (!captureMatches(existing.capture, record.capture)) throw new RemoteOwnershipError("Remote run id collision");
      return;
    }
    this.#ownedRuns.set(record.capture.runId, record);
    try {
      const orphaned = binding.orphanEvents.get(record.capture.runId) ?? [];
      binding.orphanEvents.delete(record.capture.runId);
      binding.orphanCount -= orphaned.length;
      for (const event of orphaned) this.#applyEvent(record, event);
      this.#publishSnapshot(record);
    } catch (error) {
      this.#ownedRuns.delete(record.capture.runId);
      throw error;
    }
  }

  async #workerFor(target: ResolvedRemoteTarget, signal?: AbortSignal): Promise<WorkerBinding> {
    this.#assertManagerOpen();
    const existing = this.#workers.get(target.host);
    if (existing) return existing;
    const connecting = this.#connecting.get(target.host);
    if (connecting) return connecting;
    const setup = this.#setupWorker(target, signal);
    this.#connecting.set(target.host, setup);
    try { return await setup; }
    finally {
      if (this.#connecting.get(target.host) === setup) this.#connecting.delete(target.host);
    }
  }

  async #setupWorker(target: ResolvedRemoteTarget, signal?: AbortSignal): Promise<WorkerBinding> {
    const connection = await this.#connectionFactory.connect(target, signal);
    const binding: WorkerBinding = {
      hostId: target.host,
      target,
      connection,
      status: "connecting",
      remoteActiveRuns: 0,
      startedSinceHeartbeat: 0,
      reservations: 0,
      heartbeatEpoch: 0,
      orphanEvents: new Map(),
      orphanCount: 0,
    };
    binding.pump = this.#pump(binding);
    try {
      const hello = await connection.initialize({
        commandId: this.#commandIdFactory(),
        protocolVersions: [REMOTE_PROTOCOL_VERSION],
        monitorOwnerNonce: this.monitorOwnerNonce,
      });
      validateHello(hello);
      binding.hello = hello;
      binding.status = hello.status;
      binding.remoteActiveRuns = hello.activeRuns;
      if (binding.earlyHeartbeat) this.#handleHeartbeat(binding, binding.earlyHeartbeat.params);
      if (this.#closed) throw new Error("Remote worker manager closed during setup");
      this.#workers.set(target.host, binding);
      return binding;
    } catch (error) {
      await connection.close();
      throw isVersionSkewRefusal(error) ? versionSkewDiagnostic(target.host, error) : error;
    }
  }

  async #pump(binding: WorkerBinding): Promise<void> {
    let reason = "Remote gateway disconnected";
    try {
      for await (const notification of binding.connection.notifications()) this.#handleNotification(binding, notification);
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.#workers.get(binding.hostId) === binding) {
        this.#workers.delete(binding.hostId);
        this.#markDisconnected(binding, reason);
      }
    }
  }

  #handleNotification(binding: WorkerBinding, notification: RemoteProtocolNotification): void {
    if (notification.method === "worker/heartbeat") {
      if (!binding.hello) binding.earlyHeartbeat = notification;
      else this.#handleHeartbeat(binding, notification.params);
      return;
    }
    const event = notification.params as RemoteRunEvent;
    if (event.type !== notification.method
      || !validIdentity(event.workerId)
      || !validIdentity(event.instanceNonce)
      || !validIdentity(event.runId)
      || !Number.isInteger(event.generation)
      || event.generation < 1
      || !Number.isInteger(event.sequence)
      || event.sequence < 1) {
      throw new Error("Invalid remote run notification");
    }
    const record = this.#ownedRuns.get(event.runId);
    if (!record) {
      if (binding.orphanCount >= this.#maxOrphanEvents) throw new Error("Remote orphan event buffer limit reached");
      const events = binding.orphanEvents.get(event.runId) ?? [];
      events.push(event);
      binding.orphanEvents.set(event.runId, events);
      binding.orphanCount += 1;
      return;
    }
    if (record.target.host !== binding.hostId) throw new RemoteOwnershipError("Remote event arrived from the wrong configured host");
    this.#applyEvent(record, event);
  }

  #handleHeartbeat(binding: WorkerBinding, heartbeat: RemoteWorkerHeartbeat): void {
    const hello = binding.hello!;
    if (heartbeat.workerId !== hello.workerId
      || heartbeat.instanceNonce !== hello.instanceNonce
      || !Number.isInteger(heartbeat.activeRuns)
      || heartbeat.activeRuns < 0
      || heartbeat.activeRuns > hello.concurrency
      || heartbeat.concurrency !== hello.concurrency) {
      throw new RemoteOwnershipError("Remote heartbeat does not match the admitted worker");
    }
    binding.status = heartbeat.status;
    binding.remoteActiveRuns = heartbeat.activeRuns;
    binding.startedSinceHeartbeat = 0;
    binding.heartbeatEpoch += 1;
  }

  #applyEvent(record: OwnedRun, event: RemoteRunEvent): void {
    if (!eventIdentityMatches(event, record.capture)) throw new RemoteOwnershipError();
    if (event.sequence <= record.snapshot.lastSequence) return;
    record.snapshot = applyRemoteRunEvent(record.snapshot, event);
    if (isRemoteTerminalStatus(record.snapshot.status)) this.#releaseRunQuota(record);
    this.#onEvent?.({ ...record.capture }, event);
    this.#publishSnapshot(record);
    this.#settleWaiters(record);
  }

  #releaseRunQuota(record: OwnedRun): void {
    const binding = record.quotaBinding;
    if (!binding) return;
    if (record.quotaEpoch === binding.heartbeatEpoch && binding.startedSinceHeartbeat > 0) {
      binding.startedSinceHeartbeat -= 1;
    } else {
      binding.remoteActiveRuns = Math.max(0, binding.remoteActiveRuns - 1);
    }
    record.quotaBinding = undefined;
    record.quotaEpoch = undefined;
  }

  #markDisconnected(binding: WorkerBinding, reason = "Remote gateway disconnected"): void {
    binding.status = "disconnected";
    for (const record of this.#ownedRuns.values()) {
      if (record.target.host !== binding.hostId || isRemoteTerminalStatus(record.snapshot.status)) continue;
      this.#markRunDisconnected(record, reason);
    }
  }

  #markRunDisconnected(record: OwnedRun, reason: string): void {
    if (isRemoteTerminalStatus(record.snapshot.status)) return;
    record.snapshot = {
      ...record.snapshot,
      status: "disconnected",
      updatedAt: this.#now(),
      degradedReason: reason.slice(0, 4096),
    };
    this.#publishSnapshot(record);
    this.#settleWaiters(record);
  }

  #markLost(record: OwnedRun, reason: string): void {
    if (isRemoteTerminalStatus(record.snapshot.status)) return;
    const event: RemoteRunResultEvent = {
      type: "run/result",
      workerId: record.capture.workerId,
      instanceNonce: record.capture.instanceNonce,
      runId: record.capture.runId,
      generation: record.capture.generation,
      sequence: record.snapshot.lastSequence + 1,
      status: "lost",
      updatedAt: this.#now(),
      error: reason,
      degradedReason: "reconnect-ownership-lost",
    };
    this.#applyEvent(record, event);
  }

  #workerView(binding: WorkerBinding): RemoteWorkerView {
    const hello = binding.hello!;
    return {
      targetHostId: binding.hostId,
      workerId: hello.workerId,
      instanceNonce: hello.instanceNonce,
      concurrency: hello.concurrency,
      activeRuns: binding.remoteActiveRuns + binding.startedSinceHeartbeat,
      status: binding.status,
    };
  }

  #connectedBinding(hostId: string): WorkerBinding {
    const binding = this.#workers.get(hostId);
    if (!binding) throw new RemoteWorkerDisconnectedError(`Remote host ${hostId} is disconnected`);
    return binding;
  }

  #assertCurrentBinding(hostId: string, binding: WorkerBinding): void {
    this.#assertManagerOpen();
    if (this.#workers.get(hostId) !== binding) {
      throw new RemoteWorkerDisconnectedError(`Remote host ${hostId} changed during reconnect`);
    }
  }

  #requireOwned(capture: RemoteRunCapture): OwnedRun {
    this.#assertOwnedCapture(capture, true);
    return this.#ownedRuns.get(capture.runId)!;
  }

  #assertOwnedCapture(capture: RemoteRunCapture, requireRegistered: boolean): void {
    ensureCaptureShape(capture);
    if (capture.monitorOwnerNonce !== this.monitorOwnerNonce) throw new RemoteOwnershipError();
    const existing = this.#ownedRuns.get(capture.runId);
    if (requireRegistered && (!existing || !captureMatches(existing.capture, capture))) throw new RemoteOwnershipError();
    if (!requireRegistered && existing && !captureMatches(existing.capture, capture)) throw new RemoteOwnershipError();
  }

  #publishSnapshot(record: OwnedRun): void {
    this.#onSnapshot?.({ ...record.capture }, cloneSnapshot(record.snapshot));
  }

  #settleWaiters(record: OwnedRun): void {
    for (const waiter of [...record.waiters]) {
      if (!waiter.statuses.has(record.snapshot.status)) continue;
      record.waiters.delete(waiter);
      this.#cleanupWaiter(waiter);
      waiter.resolve(cloneSnapshot(record.snapshot));
    }
  }

  #cleanupWaiter(waiter: RunWaiter): void {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  }

  #assertManagerOpen(): void {
    if (this.#closed) throw new Error("Remote worker manager is closed");
  }
}
