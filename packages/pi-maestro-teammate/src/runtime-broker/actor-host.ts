import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ActorAddressV2, RuntimeEventDraftV2, RuntimeEventV2 } from "../runtime-v2/contracts.ts";
import { normalizePersistedRuntimeEventV2 } from "../runtime-v2/validation.ts";
import { RuntimeV2ShadowJournal, type RuntimeV2JournalStream } from "../runtime-v2/journal.ts";
import {
  RuntimeBrokerClient,
  isRuntimeBrokerTransportError,
  type RuntimeBrokerClientOptions,
} from "./client.ts";
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
  /** Explicit legacy workspace identities accepted while replaying or extending this stream. */
  workspaceAliases?: readonly string[];
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
  beginClose(): void;
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
  readonly #pendingOperations = new Set<Promise<unknown>>();
  #stopped = false;
  #stopPromise: Promise<void> | undefined;

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
    return this.#trackOperation(this.#acquireEnabled(registration, driver));
  }

  async #acquireEnabled(
    registration: RuntimeActorRegistration,
    driver: ActorDriver,
  ): Promise<RuntimeActorLease | undefined> {
    let state: DriverLeaseState;
    try {
      state = await driver.acquire(registration);
    } catch (error) {
      if (error instanceof RuntimeBrokerError && error.code === "lease_unavailable") return undefined;
      throw error;
    }
    try {
      validateLeaseForRegistration(state.lease, registration);
    } catch (error) {
      await driver.release(registration, state).catch(() => undefined);
      throw error;
    }
    if (this.#stopped) {
      await driver.release(registration, state).catch(() => undefined);
      throw new Error("Runtime actor host stopped during lease acquisition");
    }
    let controller!: RuntimeActorLeaseController;
    controller = new RuntimeActorLeaseController(
      this.mode as Exclude<RuntimeBrokerMode, "off">,
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
    const driver = this.#driver;
    if (!driver) throw new Error(`${this.mode} runtime actor driver is not configured`);
    return this.#trackOperation(driver.listStreams(request));
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopped = true;
    this.#driver?.beginClose();
    const leases = [...this.#leases];
    this.#leases.clear();
    const releases = leases.map((lease) => lease.release());
    this.#stopPromise = this.#drainAndStop(releases);
    return this.#stopPromise;
  }

  async #trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.#pendingOperations.add(operation);
    try {
      return await operation;
    } finally {
      this.#pendingOperations.delete(operation);
    }
  }

  async #drainAndStop(releases: readonly Promise<void>[]): Promise<void> {
    await Promise.allSettled([...this.#pendingOperations]);
    await Promise.allSettled(releases);
    await this.#driver?.stop();
  }
}

type RuntimeActorLeaseLifecycle = "active" | "closing" | "released";

class RuntimeActorLeaseController implements RuntimeActorLease {
  readonly mode: Exclude<RuntimeBrokerMode, "off">;
  readonly registration: RuntimeActorRegistration;
  readonly #driver: ActorDriver;
  readonly #onRelease: () => void;
  #state: DriverLeaseState;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #tail: Promise<void> = Promise.resolve();
  #lifecycle: RuntimeActorLeaseLifecycle = "active";
  #releasePromise: Promise<void> | undefined;
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
    return this.#lifecycle === "active" && this.#failure === undefined;
  }

  startHeartbeat(): void {
    const intervalMs = this.registration.heartbeatMs ?? DEFAULT_RUNTIME_ACTOR_HEARTBEAT_MS;
    this.#heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch(() => undefined);
    }, intervalMs);
    this.#heartbeatTimer.unref?.();
  }

  heartbeat(): Promise<void> {
    const run = this.#enqueue(async (state) => {
      const next = await this.#driver.heartbeat(this.registration, state);
      validateLeaseForRegistration(next.lease, this.registration);
      validateLeaseContinuation(state.lease, next.lease);
      this.#assertCurrent(state);
      this.#state = next;
    });
    return run.catch((error) => {
      this.#recordFailure(error);
      throw error;
    });
  }

  replay(afterSequence = 0): Promise<readonly RuntimeEventV2[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("Runtime actor replay cursor must be non-negative");
    const run = this.#enqueue(async (state) => {
      const events = await this.#driver.replay(this.registration, state, afterSequence);
      this.#assertCurrent(state);
      return events;
    });
    return this.#trackStaleFailure(run);
  }

  append(events: readonly RuntimeEventDraftV2[]): Promise<readonly RuntimeEventV2[]> {
    if (events.length === 0) return this.active ? Promise.resolve([]) : Promise.reject(this.#staleLeaseError());
    const run = this.#enqueue(async (state) => {
      for (const event of events) validateEventForRegistration(event, this.registration);
      const result = await this.#driver.append(this.registration, state, events);
      validateLeaseForRegistration(result.state.lease, this.registration);
      validateLeaseContinuation(state.lease, result.state.lease);
      this.#assertCurrent(state);
      this.#state = result.state;
      return result.events;
    });
    return run.catch((error) => {
      this.#recordFailure(error);
      throw error;
    });
  }

  release(): Promise<void> {
    if (this.#releasePromise) return this.#releasePromise;
    if (this.#lifecycle === "released") return Promise.resolve();
    this.#lifecycle = "closing";
    this.#stopHeartbeat();
    this.#releasePromise = (async () => {
      await this.#tail.catch(() => undefined);
      const state = this.#state;
      try {
        await this.#driver.release(this.registration, state);
      } finally {
        this.#lifecycle = "released";
        this.#onRelease();
      }
    })();
    return this.#releasePromise;
  }

  #enqueue<T>(operation: (state: DriverLeaseState) => Promise<T>): Promise<T> {
    if (this.#lifecycle !== "active" || this.#failure !== undefined) {
      return Promise.reject(this.#staleLeaseError());
    }
    const run = this.#tail.catch(() => undefined).then(async () => {
      const captured = this.#state;
      this.#assertCurrent(captured);
      return operation(captured);
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  #assertCurrent(captured: DriverLeaseState): void {
    if (this.#lifecycle === "released" || this.#failure !== undefined || this.#state !== captured) {
      throw this.#staleLeaseError();
    }
  }

  #trackStaleFailure<T>(operation: Promise<T>): Promise<T> {
    return operation.catch((error) => {
      if (error instanceof RuntimeBrokerError && error.code === "stale_lease") this.#recordFailure(error);
      throw error;
    });
  }

  #recordFailure(error: unknown): void {
    this.#failure ??= error;
    this.#stopHeartbeat();
    void this.release().catch(() => undefined);
  }

  #staleLeaseError(): RuntimeBrokerError {
    return new RuntimeBrokerError("stale_lease", "Runtime actor lease is not accepting new operations", {
      actorId: this.registration.leaseActorId,
      streamId: this.registration.streamId,
      generation: this.registration.actor.generation,
    });
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }
}

class FileActorDriver implements ActorDriver {
  readonly #journal: RuntimeV2JournalAppender;
  readonly #leasesDirectory: string;
  readonly #streamAuthoritiesDirectory: string;

  constructor(journal: RuntimeV2JournalAppender, rootDirectory: string) {
    this.#journal = journal;
    this.#leasesDirectory = path.join(rootDirectory, "leases");
    this.#streamAuthoritiesDirectory = path.join(this.#leasesDirectory, "streams");
    ensurePrivateDirectory(this.#leasesDirectory);
    ensurePrivateDirectory(this.#streamAuthoritiesDirectory);
  }

  beginClose(): void {}

  async listStreams(request: RuntimeBrokerListStreamsRequest): Promise<readonly string[]> {
    return this.#journal.listStreams?.(request) ?? [];
  }

  async acquire(registration: RuntimeActorRegistration): Promise<DriverLeaseState> {
    return this.#withAuthorityMutex(registration, () => {
      const now = Date.now();
      const actorAuthority = this.#readLease(registration.leaseActorId);
      const streamAuthority = this.#readStreamAuthority(registration.streamId);
      if (actorAuthority && actorAuthority.expiresAt > now) {
        throw new RuntimeBrokerError("lease_unavailable", "Runtime actor lease is already held", {
          actorId: registration.leaseActorId,
          streamId: actorAuthority.streamId,
        });
      }
      if (streamAuthority && streamAuthority.expiresAt > now) {
        throw new RuntimeBrokerError("lease_unavailable", "Runtime actor stream is already held", {
          actorId: streamAuthority.actorId,
          streamId: registration.streamId,
        });
      }
      // Read authoritative history before publication so corruption cannot strand a
      // fresh lease or be mistaken for a new revision-zero stream.
      const revision = this.#journal.read?.(registration.streamId)?.metadata.lastSequence ?? 0;
      const ttlMs = registration.ttlMs ?? DEFAULT_RUNTIME_ACTOR_LEASE_TTL_MS;
      const epoch = Math.max(actorAuthority?.epoch ?? 0, streamAuthority?.epoch ?? 0) + 1;
      if (!Number.isSafeInteger(epoch)) throw new Error("Runtime actor file lease epoch lineage is exhausted");
      const lease: ActorLease = {
        actorId: registration.leaseActorId,
        streamId: registration.streamId,
        holderId: registration.holderId,
        epoch,
        nonce: randomUUID(),
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: now + ttlMs,
      };
      this.#writeAuthorities(lease);
      return { lease, revision };
    });
  }

  async heartbeat(registration: RuntimeActorRegistration, state: DriverLeaseState): Promise<DriverLeaseState> {
    return this.#withAuthorityMutex(registration, () => {
      const current = this.#current(registration, state);
      const now = Date.now();
      const ttlMs = registration.ttlMs ?? DEFAULT_RUNTIME_ACTOR_LEASE_TTL_MS;
      const lease = { ...current, heartbeatAt: now, expiresAt: now + ttlMs };
      this.#writeAuthorities(lease);
      return { ...state, lease };
    });
  }

  async replay(
    registration: RuntimeActorRegistration,
    state: DriverLeaseState,
    afterSequence: number,
  ): Promise<readonly RuntimeEventV2[]> {
    return this.#withAuthorityMutex(registration, () => {
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
    return this.#withAuthorityMutex(registration, () => {
      this.#current(registration, state);
      const appended = events.map((event) => this.#journal.append({
        ...event,
        producerEpoch: state.lease.epoch,
      }));
      return { state: { ...state, revision: state.revision + appended.length }, events: appended };
    });
  }

  async release(registration: RuntimeActorRegistration, state: DriverLeaseState): Promise<void> {
    await this.#withAuthorityMutex(registration, () => {
      const current = this.#current(registration, state, false);
      const now = Date.now();
      this.#writeAuthorities({ ...current, heartbeatAt: now, expiresAt: now });
    });
  }

  async stop(): Promise<void> {}

  #current(registration: RuntimeActorRegistration, state: DriverLeaseState, requireUnexpired = true): ActorLease {
    const actorAuthority = this.#readLease(registration.leaseActorId);
    const streamAuthority = this.#readStreamAuthority(registration.streamId);
    if (!actorAuthority
      || !streamAuthority
      || !sameLeaseAuthority(actorAuthority, streamAuthority)
      || streamAuthority.actorId !== registration.leaseActorId
      || streamAuthority.epoch !== state.lease.epoch
      || streamAuthority.nonce !== state.lease.nonce
      || (requireUnexpired && streamAuthority.expiresAt <= Date.now())) {
      throw new RuntimeBrokerError("stale_lease", "Runtime actor file lease is stale");
    }
    return streamAuthority;
  }

  async #withAuthorityMutex<T>(registration: RuntimeActorRegistration, operation: () => T): Promise<T> {
    return this.#withMutex(registration.leaseActorId, () =>
      this.#withMutex(`stream\0${registration.streamId}`, operation));
  }

  async #withMutex<T>(identity: string, operation: () => T | Promise<T>): Promise<T> {
    const key = createHash("sha256").update(identity, "utf8").digest("hex");
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
        if (Date.now() >= deadline) throw new Error(`Timed out acquiring Runtime actor file mutex for ${identity}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    try {
      return await operation();
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

  #streamAuthorityPath(streamId: string): string {
    const key = createHash("sha256").update(streamId, "utf8").digest("hex");
    return path.join(this.#streamAuthoritiesDirectory, `${key}.json`);
  }

  #readLease(actorId: string): ActorLease | undefined {
    return this.#readAuthority(this.#leasePath(actorId), { actorId });
  }

  #readStreamAuthority(streamId: string): ActorLease | undefined {
    return this.#readAuthority(this.#streamAuthorityPath(streamId), { streamId });
  }

  #readAuthority(
    filePath: string,
    expected: { actorId?: string; streamId?: string },
  ): ActorLease | undefined {
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) {
        throw new Error("Invalid Runtime actor lease authority file");
      }
      const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as ActorLease;
      if ((expected.actorId !== undefined && value.actorId !== expected.actorId)
        || (expected.streamId !== undefined && value.streamId !== expected.streamId)
        || typeof value.actorId !== "string"
        || !value.actorId
        || typeof value.streamId !== "string"
        || !value.streamId
        || typeof value.holderId !== "string"
        || !value.holderId
        || !Number.isSafeInteger(value.epoch)
        || value.epoch < 1
        || typeof value.nonce !== "string"
        || !value.nonce
        || !Number.isSafeInteger(value.acquiredAt)
        || !Number.isSafeInteger(value.heartbeatAt)
        || !Number.isSafeInteger(value.expiresAt)) {
        throw new Error("Invalid Runtime actor lease authority record");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  #writeAuthorities(lease: ActorLease): void {
    this.#writeAuthority(this.#leasePath(lease.actorId), lease);
    this.#writeAuthority(this.#streamAuthorityPath(lease.streamId), lease);
  }

  #writeAuthority(destination: string, lease: ActorLease): void {
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(lease)}\n`, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, destination);
      if (process.platform !== "win32") fs.chmodSync(destination, 0o600);
      fsyncPrivateDirectory(path.dirname(destination));
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
    }
  }
}

class SqliteActorDriver implements ActorDriver {
  readonly #clientFactory: () => Promise<RuntimeActorBrokerClient>;
  #client: RuntimeActorBrokerClient | undefined;
  #connecting: Promise<RuntimeActorBrokerClient> | undefined;
  #closing = false;

  constructor(clientFactory: () => Promise<RuntimeActorBrokerClient>) {
    this.#clientFactory = clientFactory;
  }

  beginClose(): void {
    this.#closing = true;
  }

  async listStreams(request: RuntimeBrokerListStreamsRequest): Promise<readonly string[]> {
    const requestId = randomUUID();
    return this.#withTransportRetry(async (client) => await client.listStreams?.(request, requestId) ?? []);
  }

  async acquire(registration: RuntimeActorRegistration): Promise<DriverLeaseState> {
    const ttlMs = registration.ttlMs ?? DEFAULT_RUNTIME_ACTOR_LEASE_TTL_MS;
    const acquireRequest = {
      actorId: registration.leaseActorId,
      streamId: registration.streamId,
      holderId: registration.holderId,
      ttlMs,
    };
    const acquireRequestId = randomUUID();
    const lease = await this.#withTransportRetry((client) => client.acquireLease(acquireRequest, acquireRequestId));
    try {
      validateLeaseForRegistration(lease, registration);
      const revisionRequestId = randomUUID();
      const revision = await this.#withTransportRetry(
        (client) => client.getStreamRevision(registration.streamId, revisionRequestId),
      );
      const heartbeatRequest = { actorId: registration.leaseActorId, lease, ttlMs };
      const heartbeatRequestId = randomUUID();
      const currentLease = await this.#withTransportRetry(
        (client) => client.heartbeatLease(heartbeatRequest, heartbeatRequestId),
      );
      validateLeaseForRegistration(currentLease, registration);
      validateLeaseContinuation(lease, currentLease);
      return { lease: currentLease, revision };
    } catch (error) {
      await this.#release(registration.leaseActorId, lease).catch(() => undefined);
      throw error;
    }
  }

  async heartbeat(registration: RuntimeActorRegistration, state: DriverLeaseState): Promise<DriverLeaseState> {
    const request = {
      actorId: registration.leaseActorId,
      lease: state.lease,
      ttlMs: registration.ttlMs ?? DEFAULT_RUNTIME_ACTOR_LEASE_TTL_MS,
    };
    const requestId = randomUUID();
    const lease = await this.#withTransportRetry((client) => client.heartbeatLease(request, requestId));
    return { ...state, lease };
  }

  async replay(
    registration: RuntimeActorRegistration,
    state: DriverLeaseState,
    afterSequence: number,
  ): Promise<readonly RuntimeEventV2[]> {
    const requestId = randomUUID();
    const stored = await this.#withTransportRetry((client) => client.readEvents(
      registration.streamId,
      afterSequence,
      { actorId: registration.leaseActorId, lease: state.lease },
      requestId,
    ));
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
    const requestId = randomUUID();
    const result: RuntimeBrokerCommitResult = await this.#withTransportRetry(
      (client) => client.commit(request, requestId),
    );
    validateCommitReceipt(request, result);
    return { state: { ...state, revision: result.revision }, events: sequenced };
  }

  async release(registration: RuntimeActorRegistration, state: DriverLeaseState): Promise<void> {
    await this.#release(registration.leaseActorId, state.lease);
  }

  async #release(actorId: string, lease: ActorLease): Promise<void> {
    const request = { actorId, lease };
    const requestId = randomUUID();
    await this.#withTransportRetry((client) => client.releaseLease(request, requestId));
  }

  async stop(): Promise<void> {
    this.beginClose();
    const client = this.#client ?? await this.#connecting?.catch(() => undefined);
    this.#client = undefined;
    this.#connecting = undefined;
    await client?.close();
  }

  async #withTransportRetry<TResult>(
    operation: (client: RuntimeActorBrokerClient) => Promise<TResult>,
  ): Promise<TResult> {
    const client = await this.#getClient();
    let transportError: unknown;
    try {
      return await operation(client);
    } catch (error) {
      if (!isRuntimeBrokerTransportError(error)) throw error;
      transportError = error;
      await this.#discardClient(client);
      if (this.#closing) throw error;
    }

    let retryClient: RuntimeActorBrokerClient;
    try {
      retryClient = await this.#getClient();
    } catch (error) {
      if (this.#closing) throw transportError;
      throw error;
    }
    if (this.#closing || this.#client !== retryClient) {
      await this.#discardClient(retryClient);
      throw transportError;
    }
    try {
      return await operation(retryClient);
    } catch (error) {
      if (isRuntimeBrokerTransportError(error)) await this.#discardClient(retryClient);
      throw error;
    }
  }

  async #discardClient(client: RuntimeActorBrokerClient): Promise<void> {
    if (this.#client === client) this.#client = undefined;
    await client.close().catch(() => undefined);
  }

  async #getClient(): Promise<RuntimeActorBrokerClient> {
    if (this.#client) return this.#client;
    if (!this.#connecting) {
      if (this.#closing) throw new Error("Runtime actor SQLite driver is closing");
      this.#connecting = this.#clientFactory();
    }
    const connecting = this.#connecting;
    try {
      const client = await connecting;
      if (this.#closing || this.#connecting !== connecting) {
        await this.#discardClient(client);
        throw new Error("Runtime actor SQLite driver closed while connecting");
      }
      this.#client = client;
      return client;
    } finally {
      if (this.#connecting === connecting) this.#connecting = undefined;
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
  const workspaceIds = [registration.actor.workspaceId, ...(registration.workspaceAliases ?? [])];
  for (const workspaceId of workspaceIds) {
    if (typeof workspaceId !== "string" || !workspaceId || workspaceId.includes("\0") || Buffer.byteLength(workspaceId, "utf8") > 1024) {
      throw new Error("Runtime actor workspace identities must be bounded non-empty strings");
    }
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
    || !registrationWorkspaceIds(registration).has(event.actor.workspaceId)
    || event.actor.actorKind !== registration.actor.actorKind
    || event.actor.actorId !== registration.actor.actorId
    || event.actor.generation !== registration.actor.generation) {
    throw new RuntimeBrokerError("invalid_request", "Runtime event identity does not match its actor lease");
  }
}

function validateReplayedEventForRegistration(event: RuntimeEventV2, registration: RuntimeActorRegistration): void {
  if (event.streamId !== registration.streamId
    || !registrationWorkspaceIds(registration).has(event.actor.workspaceId)
    || event.actor.actorKind !== registration.actor.actorKind
    || event.actor.actorId !== registration.actor.actorId
    || event.actor.generation !== registration.actor.generation) {
    throw new RuntimeBrokerError("invalid_request", "Runtime replay event identity does not match its actor registration");
  }
}

function registrationWorkspaceIds(registration: RuntimeActorRegistration): ReadonlySet<string> {
  return new Set([registration.actor.workspaceId, ...(registration.workspaceAliases ?? [])]);
}

function validateLeaseForRegistration(lease: ActorLease, registration: RuntimeActorRegistration): void {
  if (lease.actorId !== registration.leaseActorId
    || lease.streamId !== registration.streamId
    || lease.holderId !== registration.holderId
    || !Number.isSafeInteger(lease.epoch)
    || lease.epoch < 1
    || typeof lease.nonce !== "string"
    || !lease.nonce) {
    throw new RuntimeBrokerError("stale_lease", "Runtime broker returned a lease for another actor or stream", {
      actorId: registration.leaseActorId,
      streamId: registration.streamId,
    });
  }
}

function sameLeaseAuthority(left: ActorLease, right: ActorLease): boolean {
  return left.actorId === right.actorId
    && left.streamId === right.streamId
    && left.holderId === right.holderId
    && left.epoch === right.epoch
    && left.nonce === right.nonce;
}

function validateLeaseContinuation(previous: ActorLease, next: ActorLease): void {
  if (next.epoch !== previous.epoch || next.nonce !== previous.nonce) {
    throw new RuntimeBrokerError("stale_lease", "Runtime actor lease credential changed during an admitted operation", {
      actorId: previous.actorId,
      streamId: previous.streamId,
      expectedEpoch: previous.epoch,
      actualEpoch: next.epoch,
    });
  }
}

function validateCommitReceipt(
  request: RuntimeBrokerCommitRequest,
  result: RuntimeBrokerCommitResult,
): void {
  const expectedEventIds = request.events.map((event) => event.eventId);
  if (result.messageId !== request.messageId
    || result.streamId !== request.streamId
    || result.previousRevision !== request.expectedRevision
    || result.revision !== request.expectedRevision + request.events.length
    || !Array.isArray(result.eventIds)
    || result.eventIds.length !== expectedEventIds.length
    || result.eventIds.some((eventId, index) => eventId !== expectedEventIds[index])) {
    throw new RuntimeBrokerError("invalid_request", "Runtime broker returned a commit receipt for another mutation", {
      messageId: request.messageId,
      streamId: request.streamId,
    });
  }
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Invalid Runtime actor directory: ${directory}`);
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
}

function fsyncPrivateDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
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
