import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ActorAddressV2, RuntimeEventDraftV2, RuntimeEventV2 } from "../runtime-v2/contracts.ts";
import { normalizePersistedRuntimeEventV2 } from "../runtime-v2/validation.ts";
import { RuntimeV2ShadowJournal, type RuntimeV2JournalStream } from "../runtime-v2/journal.ts";
import { RuntimeBrokerClient, type RuntimeBrokerClientOptions } from "./client.ts";
import {
  RuntimeBrokerError,
  type ActorLease,
  type JsonValue,
  type RuntimeBrokerCommitRequest,
  type RuntimeBrokerCommitResult,
  type RuntimeBrokerListStreamsRequest,
} from "./contracts.ts";
import { getRuntimeBrokerStateDirectory } from "./private-state.ts";
import { runtimeBrokerModeFromEnv, type RuntimeBrokerMode } from "./rollout.ts";

export const DEFAULT_RUNTIME_ACTOR_LEASE_TTL_MS = 20_000;
export const DEFAULT_RUNTIME_ACTOR_HEARTBEAT_MS = 5_000;

export interface RuntimeActorRegistration {
  /** Stable lease identity across actor generations. */
  leaseActorId: string;
  holderId: string;
  streamId: string;
  actor: ActorAddressV2;
  correlationId?: string;
  ttlMs?: number;
  heartbeatMs?: number;
}

export interface RuntimeActorLease {
  readonly mode: Exclude<RuntimeBrokerMode, "off">;
  readonly registration: RuntimeActorRegistration;
  readonly credential: Readonly<{ epoch: number; nonce: string }>;
  readonly revision: number;
  readonly active: boolean;
  heartbeat(): Promise<void>;
  replay(afterSequence?: number): Promise<readonly RuntimeEventV2[]>;
  append(events: readonly RuntimeEventDraftV2[]): Promise<readonly RuntimeEventV2[]>;
  release(): Promise<void>;
}

/** Driver-neutral client contract. Store and server authority stay private to the sidecar. */
export interface RuntimeActorHostClient {
  readonly mode: RuntimeBrokerMode;
  acquire(registration: RuntimeActorRegistration): Promise<RuntimeActorLease | undefined>;
  listStreams?(request: RuntimeBrokerListStreamsRequest): Promise<readonly string[]>;
  stop(): Promise<void>;
}

export interface RuntimeActorBrokerClient {
  acquireLease: RuntimeBrokerClient["acquireLease"];
  heartbeatLease: RuntimeBrokerClient["heartbeatLease"];
  commit: RuntimeBrokerClient["commit"];
  releaseLease: RuntimeBrokerClient["releaseLease"];
  getStreamRevision: RuntimeBrokerClient["getStreamRevision"];
  readEvents: RuntimeBrokerClient["readEvents"];
  listStreams?: RuntimeBrokerClient["listStreams"];
  close(): Promise<void>;
}

export interface RuntimeActorHostOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  mode?: RuntimeBrokerMode;
  stateDirectory?: string;
  clientOptions?: RuntimeBrokerClientOptions;
  sqliteClientFactory?: () => Promise<RuntimeActorBrokerClient>;
  fileJournalFactory?: (rootDirectory: string) => RuntimeV2JournalAppender;
}

export interface RuntimeV2JournalAppender {
  append(event: RuntimeEventDraftV2 & { producerEpoch: number }): RuntimeEventV2;
  read?(streamId: string): RuntimeV2JournalStream | undefined;
  listStreams?(request: RuntimeBrokerListStreamsRequest): readonly string[];
}

interface DriverLeaseState {
  lease: ActorLease;
  revision: number;
}

interface ActorDriver {
  listStreams(request: RuntimeBrokerListStreamsRequest): Promise<readonly string[]>;
  acquire(registration: RuntimeActorRegistration): Promise<DriverLeaseState>;
  heartbeat(registration: RuntimeActorRegistration, state: DriverLeaseState): Promise<DriverLeaseState>;
  replay(
    registration: RuntimeActorRegistration,
    state: DriverLeaseState,
    afterSequence: number,
  ): Promise<readonly RuntimeEventV2[]>;
  append(
    registration: RuntimeActorRegistration,
    state: DriverLeaseState,
    events: readonly RuntimeEventDraftV2[],
  ): Promise<{ state: DriverLeaseState; events: readonly RuntimeEventV2[] }>;
  release(registration: RuntimeActorRegistration, state: DriverLeaseState): Promise<void>;
  stop(): Promise<void>;
}

export class RuntimeActorHost implements RuntimeActorHostClient {
  readonly mode: RuntimeBrokerMode;
  readonly #driver: ActorDriver | undefined;
  readonly #leases = new Set<RuntimeActorLeaseController>();
  #stopped = false;

  constructor(mode: RuntimeBrokerMode, driver?: ActorDriver) {
    this.mode = mode;
    this.#driver = driver;
  }

  async acquire(registration: RuntimeActorRegistration): Promise<RuntimeActorLease | undefined> {
    if (this.#stopped) throw new Error("Runtime actor host is stopped");
    validateRegistration(registration);
    if (this.mode === "off") return undefined;
    const driver = this.#driver;
    if (!driver) throw new Error(`${this.mode} runtime actor driver is not configured`);
    const state = await driver.acquire(registration);
    if (this.#stopped) {
      await driver.release(registration, state).catch(() => undefined);
      throw new Error("Runtime actor host stopped during lease acquisition");
    }
    let controller!: RuntimeActorLeaseController;
    controller = new RuntimeActorLeaseController(
      this.mode,
      registration,
      driver,
      state,
      () => this.#leases.delete(controller),
    );
    this.#leases.add(controller);
    controller.startHeartbeat();
    return controller;
  }

  async listStreams(request: RuntimeBrokerListStreamsRequest): Promise<readonly string[]> {
    if (this.#stopped) throw new Error("Runtime actor host is stopped");
    if (this.mode === "off") return [];
    if (!this.#driver) throw new Error(`${this.mode} runtime actor driver is not configured`);
    return this.#driver.listStreams(request);
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const leases = [...this.#leases];
    this.#leases.clear();
    await Promise.allSettled(leases.map((lease) => lease.release()));
    await this.#driver?.stop();
  }
}

class RuntimeActorLeaseController implements RuntimeActorLease {
  readonly mode: Exclude<RuntimeBrokerMode, "off">;
  readonly registration: RuntimeActorRegistration;
  readonly #driver: ActorDriver;
  readonly #onRelease: () => void;
  #state: DriverLeaseState;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #tail: Promise<void> = Promise.resolve();
  #active = true;
  #failure: unknown;

  constructor(
    mode: Exclude<RuntimeBrokerMode, "off">,
    registration: RuntimeActorRegistration,
    driver: ActorDriver,
    state: DriverLeaseState,
    onRelease: () => void,
  ) {
    this.mode = mode;
    this.registration = registration;
    this.#driver = driver;
    this.#state = state;
    this.#onRelease = onRelease;
  }

  get credential(): Readonly<{ epoch: number; nonce: string }> {
    return { epoch: this.#state.lease.epoch, nonce: this.#state.lease.nonce };
  }

  get revision(): number {
    return this.#state.revision;
  }

  get active(): boolean {
    return this.#active && this.#failure === undefined;
  }

  startHeartbeat(): void {
    const intervalMs = this.registration.heartbeatMs ?? DEFAULT_RUNTIME_ACTOR_HEARTBEAT_MS;
    this.#heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch((error) => {
        this.#failure = error;
        this.#stopHeartbeat();
      });
    }, intervalMs);
    this.#heartbeatTimer.unref?.();
  }

  heartbeat(): Promise<void> {
    return this.#enqueue(async (state) => {
      const next = await this.#driver.heartbeat(this.registration, state);
      this.#assertCurrent(state);
      this.#state = next;
    });
  }

  replay(afterSequence = 0): Promise<readonly RuntimeEventV2[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("Runtime actor replay cursor must be non-negative");
    return this.#enqueue(async (state) => {
      const events = await this.#driver.replay(this.registration, state, afterSequence);
      this.#assertCurrent(state);
      return events;
    });
  }

  append(events: readonly RuntimeEventDraftV2[]): Promise<readonly RuntimeEventV2[]> {
    if (events.length === 0) return Promise.resolve([]);
    return this.#enqueue(async (state) => {
      for (const event of events) validateEventForRegistration(event, this.registration);
      const result = await this.#driver.append(this.registration, state, events);
      this.#assertCurrent(state);
      this.#state = result.state;
      return result.events;
    });
  }

  async release(): Promise<void> {
    if (!this.#active) return;
    this.#active = false;
    this.#stopHeartbeat();
    await this.#tail.catch(() => undefined);
    const state = this.#state;
    try {
      await this.#driver.release(this.registration, state);
    } finally {
      this.#onRelease();
    }
  }

  #enqueue<T>(operation: (state: DriverLeaseState) => Promise<T>): Promise<T> {
    const run = this.#tail.catch(() => undefined).then(async () => {
      const captured = this.#state;
      this.#assertCurrent(captured);
      return operation(captured);
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  #assertCurrent(captured: DriverLeaseState): void {
    if (!this.#active || this.#failure !== undefined || this.#state !== captured) {
      throw new RuntimeBrokerError("stale_lease", "Runtime actor lease changed while an operation was pending", {
        actorId: this.registration.leaseActorId,
        generation: this.registration.actor.generation,
      });
    }
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }
}

class FileActorDriver implements ActorDriver {
  readonly #journal: RuntimeV2JournalAppender;
  readonly #leasesDirectory: string;

  constructor(journal: RuntimeV2JournalAppender, rootDirectory: string) {
    this.#journal = journal;
    this.#leasesDirectory = path.join(rootDirectory, "leases");
    ensurePrivateDirectory(this.#leasesDirectory);
  }

  async listStreams(request: RuntimeBrokerListStreamsRequest): Promise<readonly string[]> {
    return this.#journal.listStreams?.(request) ?? [];
  }

  async acquire(registration: RuntimeActorRegistration): Promise<DriverLeaseState> {
    return this.#withMutex(registration.leaseActorId, () => {
      const now = Date.now();
      const current = this.#readLease(registration.leaseActorId);
      if (current && current.expiresAt > now) {
        throw new RuntimeBrokerError("lease_unavailable", "Runtime actor lease is already held");
      }
      const ttlMs = registration.ttlMs ?? DEFAULT_RUNTIME_ACTOR_LEASE_TTL_MS;
      const lease: ActorLease = {
        actorId: registration.leaseActorId,
        streamId: registration.streamId,
        holderId: registration.holderId,
        epoch: (current?.epoch ?? 0) + 1,
        nonce: randomUUID(),
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: now + ttlMs,
      };
      this.#writeLease(lease);
      const revision = this.#journal.read?.(registration.streamId)?.metadata.lastSequence ?? 0;
      return { lease, revision };
    });
  }

  async heartbeat(registration: RuntimeActorRegistration, state: DriverLeaseState): Promise<DriverLeaseState> {
    return this.#withMutex(registration.leaseActorId, () => {
      const current = this.#current(registration, state);
      const now = Date.now();
      const ttlMs = registration.ttlMs ?? DEFAULT_RUNTIME_ACTOR_LEASE_TTL_MS;
      const lease = { ...current, heartbeatAt: now, expiresAt: now + ttlMs };
      this.#writeLease(lease);
      return { ...state, lease };
    });
  }

  async replay(
    registration: RuntimeActorRegistration,
    state: DriverLeaseState,
    afterSequence: number,
  ): Promise<readonly RuntimeEventV2[]> {
    return this.#withMutex(registration.leaseActorId, () => {
      this.#current(registration, state);
      const events = (this.#journal.read?.(registration.streamId)?.events ?? [])
        .filter((event) => event.sequence > afterSequence);
      for (const event of events) validateReplayedEventForRegistration(event, registration);
      return events;
    });
  }

  async append(
    registration: RuntimeActorRegistration,
    state: DriverLeaseState,
    events: readonly RuntimeEventDraftV2[],
  ): Promise<{ state: DriverLeaseState; events: readonly RuntimeEventV2[] }> {
    return this.#withMutex(registration.leaseActorId, () => {
      this.#current(registration, state);
      const appended = events.map((event) => this.#journal.append({
        ...event,
        producerEpoch: state.lease.epoch,
      }));
      return { state: { ...state, revision: state.revision + appended.length }, events: appended };
    });
  }

  async release(registration: RuntimeActorRegistration, state: DriverLeaseState): Promise<void> {
    await this.#withMutex(registration.leaseActorId, () => {
      const current = this.#current(registration, state, false);
      const now = Date.now();
      this.#writeLease({ ...current, heartbeatAt: now, expiresAt: now });
    });
  }

  async stop(): Promise<void> {}

  #current(registration: RuntimeActorRegistration, state: DriverLeaseState, requireUnexpired = true): ActorLease {
    const current = this.#readLease(registration.leaseActorId);
    if (!current
      || current.streamId !== registration.streamId
      || current.epoch !== state.lease.epoch
      || current.nonce !== state.lease.nonce
      || (requireUnexpired && current.expiresAt <= Date.now())) {
      throw new RuntimeBrokerError("stale_lease", "Runtime actor file lease is stale");
    }
    return current;
  }

  async #withMutex<T>(actorId: string, operation: () => T): Promise<T> {
    const key = createHash("sha256").update(actorId, "utf8").digest("hex");
    const mutex = path.join(this.#leasesDirectory, `${key}.lock`);
    const token = `${process.pid}:${randomUUID()}`;
    const deadline = Date.now() + 2_000;
    while (true) {
      let created = false;
      try {
        fs.mkdirSync(mutex, { mode: 0o700 });
        created = true;
        fs.writeFileSync(path.join(mutex, "owner.json"), `${JSON.stringify({ token, pid: process.pid })}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        break;
      } catch (error) {
        if (created) fs.rmSync(mutex, { recursive: true, force: true });
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        this.#recoverStaleMutex(mutex);
        if (Date.now() >= deadline) throw new Error(`Timed out acquiring Runtime actor file mutex for ${actorId}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    try {
      return operation();
    } finally {
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(mutex, "owner.json"), "utf8")) as { token?: string };
        if (owner.token === token) fs.rmSync(mutex, { recursive: true, force: true });
      } catch {}
    }
  }

  #recoverStaleMutex(mutex: string): void {
    try {
      const stat = fs.lstatSync(mutex);
      if (!stat.isDirectory() || stat.isSymbolicLink() || Date.now() - stat.mtimeMs < 5_000) return;
      let owner: { pid?: number } | undefined;
      try {
        owner = JSON.parse(fs.readFileSync(path.join(mutex, "owner.json"), "utf8")) as { pid?: number };
      } catch {}
      const ownerPid = owner?.pid;
      if (Number.isSafeInteger(ownerPid) && ownerPid! > 0 && processIsAlive(ownerPid!)) return;
      const quarantined = `${mutex}.stale-${randomUUID()}`;
      fs.renameSync(mutex, quarantined);
      fs.rmSync(quarantined, { recursive: true, force: true });
    } catch {}
  }

  #leasePath(actorId: string): string {
    const key = createHash("sha256").update(actorId, "utf8").digest("hex");
    return path.join(this.#leasesDirectory, `${key}.json`);
  }

  #readLease(actorId: string): ActorLease | undefined {
    try {
      const filePath = this.#leasePath(actorId);
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) {
        throw new Error("Invalid Runtime actor lease file");
      }
      const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as ActorLease;
      if (value.actorId !== actorId
        || typeof value.streamId !== "string"
        || !value.streamId
        || typeof value.holderId !== "string"
        || !Number.isSafeInteger(value.epoch)
        || value.epoch < 1
        || typeof value.nonce !== "string"
        || !Number.isSafeInteger(value.acquiredAt)
        || !Number.isSafeInteger(value.heartbeatAt)
        || !Number.isSafeInteger(value.expiresAt)) {
        throw new Error("Invalid Runtime actor lease record");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  #writeLease(lease: ActorLease): void {
    const destination = this.#leasePath(lease.actorId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(lease)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, destination);
      if (process.platform !== "win32") fs.chmodSync(destination, 0o600);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}

class SqliteActorDriver implements ActorDriver {
  readonly #clientFactory: () => Promise<RuntimeActorBrokerClient>;
  #client: RuntimeActorBrokerClient | undefined;
  #connecting: Promise<RuntimeActorBrokerClient> | undefined;

  constructor(clientFactory: () => Promise<RuntimeActorBrokerClient>) {
    this.#clientFactory = clientFactory;
  }

  async listStreams(request: RuntimeBrokerListStreamsRequest): Promise<readonly string[]> {
    return await (await this.#getClient()).listStreams?.(request) ?? [];
  }

  async acquire(registration: RuntimeActorRegistration): Promise<DriverLeaseState> {
    const client = await this.#getClient();
    const lease = await client.acquireLease({
      actorId: registration.leaseActorId,
      streamId: registration.streamId,
      holderId: registration.holderId,
      ttlMs: registration.ttlMs ?? DEFAULT_RUNTIME_ACTOR_LEASE_TTL_MS,
    });
    const revision = await client.getStreamRevision(registration.streamId);
    const currentLease = await client.heartbeatLease({
      actorId: registration.leaseActorId,
      lease,
      ttlMs: registration.ttlMs ?? DEFAULT_RUNTIME_ACTOR_LEASE_TTL_MS,
    });
    return { lease: currentLease, revision };
  }

  async heartbeat(registration: RuntimeActorRegistration, state: DriverLeaseState): Promise<DriverLeaseState> {
    const lease = await (await this.#getClient()).heartbeatLease({
      actorId: registration.leaseActorId,
      lease: state.lease,
      ttlMs: registration.ttlMs ?? DEFAULT_RUNTIME_ACTOR_LEASE_TTL_MS,
    });
    return { ...state, lease };
  }

  async replay(
    registration: RuntimeActorRegistration,
    state: DriverLeaseState,
    afterSequence: number,
  ): Promise<readonly RuntimeEventV2[]> {
    const stored = await (await this.#getClient()).readEvents(
      registration.streamId,
      afterSequence,
      { actorId: registration.leaseActorId, lease: state.lease },
    );
    return stored.map((event) => {
      if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
        throw new RuntimeBrokerError("invalid_request", "Runtime broker replay event payload is invalid");
      }
      const runtimeEvent = normalizePersistedRuntimeEventV2({
        ...event.payload,
        producerEpoch: event.producerEpoch,
      });
      if (runtimeEvent.streamId !== registration.streamId || runtimeEvent.sequence !== event.revision) {
        throw new RuntimeBrokerError("invalid_request", "Runtime broker replay event identity is invalid");
      }
      validateReplayedEventForRegistration(runtimeEvent, registration);
      return runtimeEvent;
    });
  }

  async append(
    registration: RuntimeActorRegistration,
    state: DriverLeaseState,
    events: readonly RuntimeEventDraftV2[],
  ): Promise<{ state: DriverLeaseState; events: readonly RuntimeEventV2[] }> {
    const sequenced = events.map((event, index) => ({
      ...event,
      producerEpoch: state.lease.epoch,
      sequence: state.revision + index + 1,
    })) as RuntimeEventV2[];
    const request: RuntimeBrokerCommitRequest = {
      messageId: randomUUID(),
      actorId: registration.leaseActorId,
      lease: state.lease,
      streamId: registration.streamId,
      expectedRevision: state.revision,
      events: sequenced.map((event) => ({
        eventId: randomUUID(),
        eventType: event.kind,
        payload: toJsonValue(event),
        occurredAt: event.occurredAt,
        ...(registration.correlationId === undefined ? {} : { correlationId: registration.correlationId }),
      })),
    };
    const result: RuntimeBrokerCommitResult = await (await this.#getClient()).commit(request);
    return { state: { ...state, revision: result.revision }, events: sequenced };
  }

  async release(registration: RuntimeActorRegistration, state: DriverLeaseState): Promise<void> {
    await (await this.#getClient()).releaseLease({
      actorId: registration.leaseActorId,
      lease: state.lease,
    });
  }

  async stop(): Promise<void> {
    const client = this.#client ?? await this.#connecting?.catch(() => undefined);
    this.#client = undefined;
    this.#connecting = undefined;
    await client?.close();
  }

  async #getClient(): Promise<RuntimeActorBrokerClient> {
    if (this.#client) return this.#client;
    this.#connecting ??= this.#clientFactory();
    try {
      const client = await this.#connecting;
      this.#client = client;
      return client;
    } finally {
      this.#connecting = undefined;
    }
  }
}

export function createRuntimeActorHost(options: RuntimeActorHostOptions = {}): RuntimeActorHostClient {
  const mode = options.mode ?? runtimeBrokerModeFromEnv(options.env);
  if (mode === "off") return new RuntimeActorHost("off");
  const cwd = options.cwd ?? process.cwd();
  const stateDirectory = options.stateDirectory ?? getRuntimeBrokerStateDirectory(cwd);
  if (mode === "file") {
    const journal = options.fileJournalFactory?.(path.join(stateDirectory, "actor-journal"))
      ?? new RuntimeV2ShadowJournal(path.join(stateDirectory, "actor-journal"));
    return new RuntimeActorHost("file", new FileActorDriver(journal, path.join(stateDirectory, "actor-journal")));
  }
  const clientFactory = options.sqliteClientFactory
    ?? (() => RuntimeBrokerClient.connectOrStart({
      ...options.clientOptions,
      stateDirectory: options.clientOptions?.stateDirectory ?? stateDirectory,
    }));
  return new RuntimeActorHost("sqlite", new SqliteActorDriver(clientFactory));
}

function validateRegistration(registration: RuntimeActorRegistration): void {
  for (const [value, name] of [
    [registration.leaseActorId, "leaseActorId"],
    [registration.holderId, "holderId"],
    [registration.streamId, "streamId"],
  ] as const) {
    if (!value || value.includes("\0")) throw new Error(`Runtime actor ${name} must be non-empty`);
  }
  const ttlMs = registration.ttlMs ?? DEFAULT_RUNTIME_ACTOR_LEASE_TTL_MS;
  const heartbeatMs = registration.heartbeatMs ?? DEFAULT_RUNTIME_ACTOR_HEARTBEAT_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 2) throw new Error("Runtime actor ttlMs must be at least 2ms");
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs >= ttlMs) {
    throw new Error("Runtime actor heartbeatMs must be positive and less than ttlMs");
  }
}

function validateEventForRegistration(event: RuntimeEventDraftV2, registration: RuntimeActorRegistration): void {
  if (event.streamId !== registration.streamId
    || event.actor.workspaceId !== registration.actor.workspaceId
    || event.actor.actorKind !== registration.actor.actorKind
    || event.actor.actorId !== registration.actor.actorId
    || event.actor.generation !== registration.actor.generation) {
    throw new RuntimeBrokerError("invalid_request", "Runtime event identity does not match its actor lease");
  }
}

function validateReplayedEventForRegistration(event: RuntimeEventV2, registration: RuntimeActorRegistration): void {
  if (event.actor.workspaceId !== registration.actor.workspaceId) {
    throw new RuntimeBrokerError("invalid_request", "Runtime replay event workspace does not match its actor registration");
  }
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Invalid Runtime actor directory: ${directory}`);
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
