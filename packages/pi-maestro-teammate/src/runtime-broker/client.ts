import { isUtf8 } from "node:buffer";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_BROKER_PROTOCOL,
  RUNTIME_BROKER_PROTOCOL_VERSION,
  RUNTIME_BROKER_SCHEMA_VERSION,
  RuntimeBrokerError,
  assertJsonValue,
  type AcquireLeaseRequest,
  type ActorLease,
  type CompareAndSwapLeaseRequest,
  type HeartbeatLeaseRequest,
  type JsonValue,
  type ReleaseLeaseRequest,
  type RuntimeBrokerCommitRequest,
  type RuntimeBrokerCommitResult,
  type RuntimeBrokerErrorCode,
  type RuntimeBrokerFailureEnvelope,
  type RuntimeBrokerListStreamsRequest,
  type RuntimeBrokerMethod,
  type RuntimeBrokerProbeResult,
  type RuntimeBrokerReadEventsPage,
  type RuntimeBrokerSuccessEnvelope,
  type RuntimeBrokerReadModelSourceState,
  type RuntimeBrokerStreamAuthorization,
  type StoredRuntimeBrokerCursorEvent,
  type StoredRuntimeBrokerEvent,
  type TakeoverLeaseRequest,
} from "./contracts.ts";
import {
  RUNTIME_BROKER_DAEMON_LOCK_FILE,
  getRuntimeBrokerEndpoint,
  getRuntimeBrokerEndpointWorkspaceId,
  getRuntimeBrokerStateDirectory,
} from "./private-state.ts";

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const MAX_REQUEST_ID_BYTES = 256;
const MAX_DAEMON_IDENTITY_BYTES = 256;
const BROKER_START_RETRY_MS = 40;
const BROKER_PROBE_TIMEOUT_MS = 250;
const BROKER_BOOTSTRAP_TIMEOUT_MS = 5_000;
const BROKER_CHILD_TERMINATION_GRACE_MS = 300;
const BROKER_CHILD_FORCE_WAIT_MS = 5_000;
const BROKER_CHILD_RECLAIM_POLL_MS = 25;
const BROKER_WINDOWS_TASKKILL_TIMEOUT_MS = BROKER_CHILD_FORCE_WAIT_MS;
const BROKER_MAX_LAUNCH_ATTEMPTS = 2;
const BROKER_BIN_PATH = fileURLToPath(new URL("../../bin/pi-teammate-broker.mjs", import.meta.url));

interface BrokerAuthority {
  daemonToken: string;
  generation: string;
}

interface BrokerBootstrap {
  authority: BrokerAuthority;
  child?: ChildProcess;
  childPid?: number;
  childExit?: Promise<void>;
  childExited: boolean;
  readiness: Promise<void>;
  settled: boolean;
  failed: boolean;
  reclaimed: boolean;
  reclamation?: Promise<void>;
}

interface BrokerBootstrapSlot {
  endpoint: string;
  stateDirectory: string;
  attempts: number;
  waiters: number;
  current?: BrokerBootstrap;
  lastError?: unknown;
}

const brokerBootstraps = new Map<string, BrokerBootstrapSlot>();

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ValidatedRuntimeBrokerClientOptions {
  timeoutMs: number;
  maxLineBytes: number;
  maxPendingRequests: number;
  daemonExecutable: string;
  daemonBinPath: string;
}

export interface RuntimeBrokerClientOptions {
  stateDirectory?: string;
  endpoint?: string;
  timeoutMs?: number;
  maxLineBytes?: number;
  maxPendingRequests?: number;
  /** Override used by embedders and failure-injection tests; defaults to process.execPath. */
  daemonExecutable?: string;
  /** Override used by embedders and failure-injection tests; defaults to the packaged broker bin. */
  daemonBinPath?: string;
}

class RuntimeBrokerClientTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeBrokerClientTransportError";
  }
}

class RuntimeBrokerBootstrapError extends RuntimeBrokerClientTransportError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeBrokerBootstrapError";
  }
}

class RuntimeBrokerHandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeBrokerHandshakeError";
  }
}

class RuntimeBrokerCallerDeadlineError extends RuntimeBrokerClientTransportError {
  constructor() {
    super("Timed out waiting for runtime broker readiness");
    this.name = "RuntimeBrokerCallerDeadlineError";
  }
}

export function isRuntimeBrokerTransportError(error: unknown): boolean {
  if (error instanceof RuntimeBrokerClientTransportError) return true;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT"
    || code === "ECONNREFUSED"
    || code === "ECONNRESET"
    || code === "ECONNABORTED"
    || code === "EPIPE"
    || code === "ETIMEDOUT"
    || code === "ERR_STREAM_DESTROYED";
}

export class RuntimeBrokerClient {
  readonly endpoint: string;
  readonly #socket: net.Socket;
  readonly #timeoutMs: number;
  readonly #maxLineBytes: number;
  readonly #maxPendingRequests: number;
  readonly #pending = new Map<string, PendingRequest>();
  #readiness?: RuntimeBrokerProbeResult;
  #closed = false;

  get readiness(): RuntimeBrokerProbeResult {
    if (!this.#readiness) throw new Error("Runtime broker readiness was not established");
    return this.#readiness;
  }

  private constructor(
    socket: net.Socket,
    endpoint: string,
    options: ValidatedRuntimeBrokerClientOptions,
  ) {
    this.#socket = socket;
    this.endpoint = endpoint;
    this.#timeoutMs = options.timeoutMs;
    this.#maxLineBytes = options.maxLineBytes;
    this.#maxPendingRequests = options.maxPendingRequests;
    const decoder = new ClientLineDecoder(this.#maxLineBytes, (line) => this.#handleLine(line));
    socket.on("data", (chunk: Buffer) => {
      try {
        decoder.write(chunk);
      } catch (error) {
        this.#failAll(error instanceof Error ? error : new Error(String(error)));
        socket.destroy();
      }
    });
    socket.on("end", () => {
      try {
        decoder.end();
      } catch (error) {
        this.#failAll(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", (error) => this.#failAll(error));
    socket.on("close", () => this.#failAll(new RuntimeBrokerClientTransportError("Runtime broker connection closed")));
  }

  static connect(options: RuntimeBrokerClientOptions = {}): Promise<RuntimeBrokerClient> {
    return RuntimeBrokerClient.#connect(options);
  }

  static async connectOrStart(options: RuntimeBrokerClientOptions = {}): Promise<RuntimeBrokerClient> {
    const validated = validateClientOptions(options);
    const deadline = Date.now() + validated.timeoutMs;
    if (options.endpoint !== undefined) return RuntimeBrokerClient.#connect(options, undefined, deadline);
    const stateDirectory = options.stateDirectory ?? getRuntimeBrokerStateDirectory();
    const endpoint = getRuntimeBrokerEndpoint(stateDirectory);
    try {
      return await RuntimeBrokerClient.#connectCanonical(
        options,
        stateDirectory,
        deadline,
        BROKER_PROBE_TIMEOUT_MS,
      );
    } catch (error) {
      if (!isRuntimeBrokerTransportError(error)) throw error;
      if (Date.now() >= deadline) throw error;
    }

    const slot = getOrCreateBootstrapSlot(endpoint, stateDirectory);
    slot.waiters += 1;
    try {
      while (true) {
        if (Date.now() >= deadline) throw new RuntimeBrokerCallerDeadlineError();
        const bootstrap = slot.current ?? createBootstrap(slot, validated);
        try {
          await waitForCaller(bootstrap.readiness, deadline);
          return await RuntimeBrokerClient.#connectCanonical(
            options,
            stateDirectory,
            deadline,
            Math.max(1, deadline - Date.now()),
            bootstrap.authority,
          );
        } catch (error) {
          if (error instanceof RuntimeBrokerCallerDeadlineError) throw error;
          if (!isRuntimeBrokerTransportError(error)) throw error;
          if (Date.now() >= deadline) throw new RuntimeBrokerCallerDeadlineError();
          await invalidateBootstrap(slot, bootstrap, error);
          try {
            return await RuntimeBrokerClient.#connectCanonical(
              options,
              stateDirectory,
              deadline,
              BROKER_PROBE_TIMEOUT_MS,
            );
          } catch (canonicalError) {
            if (!isRuntimeBrokerTransportError(canonicalError)) throw canonicalError;
            if (Date.now() >= deadline) throw new RuntimeBrokerCallerDeadlineError();
            slot.lastError = error;
          }
          // A peer may already have created the allowed retry generation. Always
          // loop and join it before considering the shared attempt budget spent.
          if (slot.current) continue;
          if (slot.attempts >= BROKER_MAX_LAUNCH_ATTEMPTS) {
            throw new RuntimeBrokerBootstrapError(
              `Runtime broker failed after ${slot.attempts} launch attempts: ${errorMessage(slot.lastError)}`,
              { cause: slot.lastError },
            );
          }
        }
      }
    } finally {
      slot.waiters -= 1;
      maybeDeleteBootstrapSlot(slot);
    }
  }

  static async #connect(
    options: RuntimeBrokerClientOptions,
    expectedAuthority?: BrokerAuthority,
    absoluteDeadline?: number,
  ): Promise<RuntimeBrokerClient> {
    const validated = validateClientOptions(options);
    const endpoint = options.endpoint
      ?? getRuntimeBrokerEndpoint(options.stateDirectory ?? getRuntimeBrokerStateDirectory());
    const deadline = absoluteDeadline ?? Date.now() + validated.timeoutMs;
    const connectTimeoutMs = remainingTime(deadline, "Timed out connecting to runtime broker");
    const socket = net.createConnection(endpoint);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new RuntimeBrokerClientTransportError("Timed out connecting to runtime broker")),
        connectTimeoutMs,
      );
      timer.unref?.();
      const finish = (error?: Error) => {
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onError);
        if (error) {
          socket.destroy();
          reject(error);
        } else resolve();
      };
      const onConnect = () => finish();
      const onError = (error: Error) => finish(error);
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
    socket.setNoDelay(true);
    const client = new RuntimeBrokerClient(socket, endpoint, {
      ...validated,
      timeoutMs: remainingTime(deadline, "Timed out probing runtime broker readiness"),
    });
    try {
      await client.#establishReadiness(expectedAuthority);
      return client;
    } catch (error) {
      client.#closed = true;
      client.#failAll(error instanceof Error ? error : new Error(String(error)));
      socket.destroy();
      throw error;
    }
  }

  static async #connectCanonical(
    options: RuntimeBrokerClientOptions,
    stateDirectory: string,
    deadline: number,
    attemptTimeoutMs: number,
    expectedAuthority?: BrokerAuthority,
  ): Promise<RuntimeBrokerClient> {
    const attemptDeadline = Math.min(deadline, Date.now() + Math.max(1, attemptTimeoutMs));
    const client = await RuntimeBrokerClient.#connect({
      ...options,
      endpoint: undefined,
      stateDirectory,
      timeoutMs: Math.max(1, attemptDeadline - Date.now()),
    }, expectedAuthority, attemptDeadline);
    try {
      validateCanonicalDaemonAuthority(stateDirectory, client.readiness, expectedAuthority);
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async #establishReadiness(expectedAuthority?: BrokerAuthority): Promise<void> {
    const challenge = randomUUID();
    const result = await this.request<RuntimeBrokerProbeResult>(
      "broker.probe",
      { challenge },
      `broker-probe:${randomUUID()}`,
    );
    validateProbeResult(result, this.endpoint, challenge, expectedAuthority);
    this.#readiness = result;
  }

  request<TResult = JsonValue>(
    method: RuntimeBrokerMethod,
    params: JsonValue,
    requestId: string = randomUUID(),
  ): Promise<TResult> {
    if (this.#closed || this.#socket.destroyed) {
      return Promise.reject(new RuntimeBrokerClientTransportError("Runtime broker client is closed"));
    }
    if (this.#pending.size >= this.#maxPendingRequests) return Promise.reject(new Error("Runtime broker pending request limit reached"));
    if (!isRuntimeBrokerMethod(method)) return Promise.reject(new Error("Unknown runtime broker method"));
    if (!params || typeof params !== "object" || Array.isArray(params) || !isJsonValue(params)) {
      return Promise.reject(new Error("Runtime broker params must be a finite JSON object"));
    }
    if (!requestId || Buffer.byteLength(requestId, "utf8") > MAX_REQUEST_ID_BYTES || requestId.includes("\0")
      || this.#pending.has(requestId)) {
      return Promise.reject(new Error("Runtime broker requestId must be unique, non-empty, and bounded"));
    }
    let encoded: string;
    try {
      encoded = `${JSON.stringify({
        protocol: RUNTIME_BROKER_PROTOCOL,
        version: RUNTIME_BROKER_PROTOCOL_VERSION,
        requestId,
        method,
        params,
      })}\n`;
    } catch {
      return Promise.reject(new Error("Runtime broker request must be serializable JSON"));
    }
    if (Buffer.byteLength(encoded, "utf8") > this.#maxLineBytes) {
      return Promise.reject(new Error("Runtime broker request exceeds the line limit"));
    }
    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new RuntimeBrokerClientTransportError(`Runtime broker request timed out: ${requestId}`);
        this.#failAll(error);
        this.#socket.destroy();
      }, this.#timeoutMs);
      timer.unref?.();
      this.#pending.set(requestId, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timer,
      });
      this.#socket.write(encoded, (error?: Error | null) => {
        if (!error) return;
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        this.#pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  acquireLease(params: AcquireLeaseRequest, requestId?: string): Promise<ActorLease> {
    return this.request("lease.acquire", params as unknown as JsonValue, requestId);
  }

  heartbeatLease(params: HeartbeatLeaseRequest, requestId?: string): Promise<ActorLease> {
    return this.request("lease.heartbeat", params as unknown as JsonValue, requestId);
  }

  compareAndSwapLease(params: CompareAndSwapLeaseRequest, requestId?: string): Promise<ActorLease> {
    return this.request("lease.compare-and-swap", params as unknown as JsonValue, requestId);
  }

  takeoverLease(params: TakeoverLeaseRequest, requestId?: string): Promise<ActorLease> {
    return this.request("lease.takeover", params as unknown as JsonValue, requestId);
  }

  commit(params: RuntimeBrokerCommitRequest, requestId?: string): Promise<RuntimeBrokerCommitResult> {
    return this.request("commit", params as unknown as JsonValue, requestId);
  }

  async releaseLease(params: ReleaseLeaseRequest, requestId?: string): Promise<void> {
    await this.request("lease.release", params as unknown as JsonValue, requestId);
  }

  getStreamRevision(streamId: string, requestId?: string): Promise<number> {
    return this.request("stream.revision", { streamId }, requestId);
  }

  readEvents(streamId: string, afterRevision?: number, requestId?: string): Promise<StoredRuntimeBrokerEvent[]>;
  readEvents(
    streamId: string,
    afterRevision: number,
    authorization: RuntimeBrokerStreamAuthorization,
    requestId?: string,
  ): Promise<StoredRuntimeBrokerEvent[]>;
  async readEvents(
    streamId: string,
    afterRevision = 0,
    authorizationOrRequestId?: RuntimeBrokerStreamAuthorization | string,
    requestId?: string,
  ): Promise<StoredRuntimeBrokerEvent[]> {
    const authorization = typeof authorizationOrRequestId === "string" ? undefined : authorizationOrRequestId;
    const resolvedRequestId = typeof authorizationOrRequestId === "string" ? authorizationOrRequestId : requestId;
    const authorizationParams: Record<string, JsonValue> = authorization === undefined ? {} : {
      actorId: authorization.actorId,
      lease: { epoch: authorization.lease.epoch, nonce: authorization.lease.nonce },
    };
    try {
      const legacyEvents = await this.request<StoredRuntimeBrokerEvent[]>("stream.events", {
        streamId,
        afterRevision,
        ...authorizationParams,
      }, resolvedRequestId);
      validateLegacyEvents(legacyEvents, streamId, afterRevision);
      return legacyEvents;
    } catch (error) {
      if (!requiresPagedStreamEvents(error)) throw error;
    }

    const events: StoredRuntimeBrokerEvent[] = [];
    let cursor = afterRevision;
    let throughRevision: number | undefined;
    let pageIndex = 0;
    while (true) {
      const page = await this.request<RuntimeBrokerReadEventsPage>("stream.events.page", {
        streamId,
        afterRevision: cursor,
        ...(throughRevision === undefined ? {} : { throughRevision }),
        limit: 128,
        ...authorizationParams,
      }, derivePageRequestId(resolvedRequestId, pageIndex));
      validateEventsPage(page, streamId, cursor, throughRevision);
      throughRevision ??= page.throughRevision;
      events.push(...page.events);
      if (page.done) return events;
      if (page.nextRevision <= cursor) throw new Error("Runtime broker stream event page made no progress");
      cursor = page.nextRevision;
      pageIndex += 1;
    }
  }

  listStreams(params: RuntimeBrokerListStreamsRequest, requestId?: string): Promise<string[]> {
    return this.request("stream.list", params as unknown as JsonValue, requestId);
  }

  readRuntimeReadModelEvents(
    workspaceId: string,
    afterCursor = 0,
    limit = 128,
    requestId?: string,
  ): Promise<StoredRuntimeBrokerCursorEvent[]> {
    return this.request("read-model.events", { workspaceId, afterCursor, limit }, requestId);
  }

  readRuntimeReadModelSources(
    workspaceId: string,
    afterStreamId = "",
    limit = 128,
    requestId?: string,
  ): Promise<RuntimeBrokerReadModelSourceState[]> {
    return this.request("read-model.sources", { workspaceId, afterStreamId, limit }, requestId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new RuntimeBrokerClientTransportError("Runtime broker client closed"));
    if (this.#socket.destroyed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.#socket.destroy(), 250);
      timer.unref?.();
      this.#socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.#socket.end();
    });
  }

  #handleLine(line: string): void {
    let envelope: unknown;
    try {
      envelope = JSON.parse(line);
    } catch {
      this.#failProtocol("Runtime broker returned invalid JSON");
      return;
    }
    if (!isResponseEnvelope(envelope)) {
      this.#failProtocol("Runtime broker returned an invalid response envelope");
      return;
    }
    const pending = this.#pending.get(envelope.requestId);
    if (!pending) {
      this.#failProtocol(`Runtime broker returned an unknown requestId: ${envelope.requestId}`);
      return;
    }
    this.#pending.delete(envelope.requestId);
    clearTimeout(pending.timer);
    if (envelope.ok) pending.resolve(envelope.result);
    else pending.reject(new RuntimeBrokerError(envelope.error.code, envelope.error.message, envelope.error.details));
  }

  #failProtocol(message: string): void {
    this.#failAll(new Error(message));
    this.#socket.destroy();
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function validateClientOptions(options: RuntimeBrokerClientOptions): ValidatedRuntimeBrokerClientOptions {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxPendingRequests = options.maxPendingRequests ?? 256;
  const daemonExecutable = options.daemonExecutable ?? process.execPath;
  const daemonBinPath = options.daemonBinPath ?? BROKER_BIN_PATH;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Runtime broker timeout must be positive");
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1024) {
    throw new Error("Runtime broker line limit must be at least 1024 bytes");
  }
  if (!Number.isSafeInteger(maxPendingRequests) || maxPendingRequests < 1) {
    throw new Error("Runtime broker pending request limit must be positive");
  }
  if (!daemonExecutable || daemonExecutable.includes("\0")) {
    throw new Error("Runtime broker daemon executable must be a non-empty path");
  }
  if (!daemonBinPath || daemonBinPath.includes("\0")) {
    throw new Error("Runtime broker daemon bin must be a non-empty path");
  }
  return { timeoutMs, maxLineBytes, maxPendingRequests, daemonExecutable, daemonBinPath };
}

class ClientLineDecoder {
  #buffer = Buffer.alloc(0);
  readonly #maxLineBytes: number;
  readonly #onLine: (line: string) => void;

  constructor(maxLineBytes: number, onLine: (line: string) => void) {
    this.#maxLineBytes = maxLineBytes;
    this.#onLine = onLine;
  }

  write(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > this.#maxLineBytes) throw new Error("Runtime broker response exceeds the line limit");
      const record = this.#buffer.subarray(0, newline);
      if (!isUtf8(record)) throw new Error("Runtime broker response is not valid UTF-8");
      const line = record.toString("utf8");
      this.#buffer = this.#buffer.subarray(newline + 1);
      this.#onLine(line);
    }
    if (this.#buffer.length > this.#maxLineBytes) throw new Error("Runtime broker response exceeds the line limit");
  }

  end(): void {
    if (this.#buffer.length > 0) throw new Error("Runtime broker response ended with an incomplete record");
  }
}

function isResponseEnvelope(value: unknown): value is RuntimeBrokerSuccessEnvelope | RuntimeBrokerFailureEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.protocol !== RUNTIME_BROKER_PROTOCOL
    || envelope.version !== RUNTIME_BROKER_PROTOCOL_VERSION
    || typeof envelope.requestId !== "string"
    || !envelope.requestId
    || Buffer.byteLength(envelope.requestId, "utf8") > MAX_REQUEST_ID_BYTES
    || envelope.requestId.includes("\0")
    || typeof envelope.ok !== "boolean") return false;
  if (envelope.ok) {
    return hasExactKeys(envelope, ["ok", "protocol", "requestId", "result", "version"])
      && isJsonValue(envelope.result);
  }
  if (!hasExactKeys(envelope, ["error", "ok", "protocol", "requestId", "version"])
    || !envelope.error || typeof envelope.error !== "object" || Array.isArray(envelope.error)) return false;
  const error = envelope.error as Record<string, unknown>;
  const expectedErrorKeys = error.details === undefined ? ["code", "message"] : ["code", "details", "message"];
  return hasExactKeys(error, expectedErrorKeys)
    && isRuntimeBrokerErrorCode(error.code)
    && typeof error.message === "string"
    && (error.details === undefined
      || (!!error.details && typeof error.details === "object" && !Array.isArray(error.details) && isJsonValue(error.details)));
}

function isRuntimeBrokerMethod(value: unknown): value is RuntimeBrokerMethod {
  return value === "broker.probe"
    || value === "commit"
    || value === "lease.acquire"
    || value === "lease.heartbeat"
    || value === "lease.compare-and-swap"
    || value === "lease.takeover"
    || value === "lease.release"
    || value === "stream.revision"
    || value === "stream.events"
    || value === "stream.events.page"
    || value === "stream.list"
    || value === "read-model.events"
    || value === "read-model.sources";
}

function derivePageRequestId(requestId: string | undefined, pageIndex: number): string | undefined {
  if (requestId === undefined || pageIndex === 0) return requestId;
  const candidate = `${requestId}:page:${pageIndex}`;
  if (Buffer.byteLength(candidate, "utf8") <= MAX_REQUEST_ID_BYTES) return candidate;
  return `page:${createHash("sha256").update(candidate).digest("hex")}`;
}

function requiresPagedStreamEvents(error: unknown): boolean {
  return error instanceof RuntimeBrokerError
    && error.code === "invalid_request"
    && error.details?.requiredMethod === "stream.events.page";
}

function validateLegacyEvents(value: StoredRuntimeBrokerEvent[], streamId: string, afterRevision: number): void {
  if (!Array.isArray(value)) throw new Error("Runtime broker returned an invalid legacy stream event replay");
  let revision = afterRevision;
  for (const event of value) {
    if (!event || typeof event !== "object" || Array.isArray(event)
      || event.streamId !== streamId
      || !Number.isSafeInteger(event.revision)
      || event.revision <= revision) {
      throw new Error("Runtime broker returned an invalid legacy stream event replay");
    }
    revision = event.revision;
  }
}

function validateEventsPage(
  value: RuntimeBrokerReadEventsPage,
  streamId: string,
  afterRevision: number,
  expectedThroughRevision: number | undefined,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !hasExactKeys(value as unknown as Record<string, unknown>, ["done", "events", "nextRevision", "throughRevision"])
    || !Array.isArray(value.events)
    || typeof value.done !== "boolean"
    || !Number.isSafeInteger(value.nextRevision) || value.nextRevision < afterRevision
    || !Number.isSafeInteger(value.throughRevision) || value.throughRevision < 0
    || (expectedThroughRevision !== undefined && value.throughRevision !== expectedThroughRevision)) {
    throw new Error("Runtime broker returned an invalid stream event page");
  }
  let revision = afterRevision;
  for (const event of value.events) {
    if (!event || typeof event !== "object" || Array.isArray(event)
      || event.streamId !== streamId
      || !Number.isSafeInteger(event.revision)
      || event.revision <= revision
      || event.revision > value.throughRevision) {
      throw new Error("Runtime broker returned an invalid stream event page");
    }
    revision = event.revision;
  }
  if ((value.events.length > 0 && value.nextRevision !== revision)
    || (value.events.length === 0 && value.nextRevision !== afterRevision)
    || (value.done && value.nextRevision < value.throughRevision)
    || (!value.done && value.nextRevision >= value.throughRevision)) {
    throw new Error("Runtime broker returned an invalid stream event page");
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  try {
    assertJsonValue(value, "value");
    return true;
  } catch {
    return false;
  }
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRuntimeBrokerErrorCode(value: unknown): value is RuntimeBrokerErrorCode {
  return value === "idempotency_conflict"
    || value === "invalid_request"
    || value === "lease_unavailable"
    || value === "revision_conflict"
    || value === "stale_lease";
}

export async function probeRuntimeBrokerAuthority(options: {
  stateDirectory?: string;
  endpoint?: string;
  timeoutMs?: number;
  daemonToken?: string;
  generation?: string;
}): Promise<RuntimeBrokerProbeResult> {
  const client = await RuntimeBrokerClient.connect({
    stateDirectory: options.stateDirectory,
    endpoint: options.endpoint,
    timeoutMs: options.timeoutMs ?? BROKER_PROBE_TIMEOUT_MS,
  });
  try {
    const expected = options.daemonToken === undefined && options.generation === undefined
      ? undefined
      : { daemonToken: options.daemonToken ?? "", generation: options.generation ?? "" };
    validateProbeResult(client.readiness, client.endpoint, client.readiness.challenge, expected);
    return client.readiness;
  } finally {
    await client.close();
  }
}

function validateProbeResult(
  value: RuntimeBrokerProbeResult,
  endpoint: string,
  challenge: string,
  expectedAuthority?: BrokerAuthority,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !hasExactKeys(value as unknown as Record<string, unknown>, [
      "challenge",
      "daemonToken",
      "generation",
      "protocol",
      "readiness",
      "schemaVersion",
      "version",
      "workspaceId",
    ])
    || value.protocol !== RUNTIME_BROKER_PROTOCOL
    || value.version !== RUNTIME_BROKER_PROTOCOL_VERSION
    || value.schemaVersion !== RUNTIME_BROKER_SCHEMA_VERSION
    || value.workspaceId !== getRuntimeBrokerEndpointWorkspaceId(endpoint)
    || value.readiness !== "ready"
    || value.challenge !== challenge
    || !isDaemonIdentityPart(value.daemonToken)
    || !isDaemonIdentityPart(value.generation)) {
    throw new RuntimeBrokerHandshakeError("Runtime broker readiness handshake mismatch");
  }
  if (expectedAuthority
    && (value.daemonToken !== expectedAuthority.daemonToken
      || value.generation !== expectedAuthority.generation)) {
    throw new RuntimeBrokerHandshakeError("Runtime broker daemon authority mismatch");
  }
}

function validateCanonicalDaemonAuthority(
  stateDirectory: string,
  readiness: RuntimeBrokerProbeResult,
  expectedAuthority?: BrokerAuthority,
): void {
  const lock = readDaemonLockAuthority(stateDirectory);
  if (!lock
    || lock.daemonToken !== readiness.daemonToken
    || lock.generation !== readiness.generation
    || (expectedAuthority
      && (lock.daemonToken !== expectedAuthority.daemonToken
        || lock.generation !== expectedAuthority.generation))) {
    throw new RuntimeBrokerHandshakeError("Runtime broker daemon lock authority mismatch");
  }
}

function readDaemonLockAuthority(stateDirectory: string): BrokerAuthority | undefined {
  const lockPath = path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE);
  let before: fs.Stats;
  try {
    before = fs.lstatSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > 4096) {
    throw new RuntimeBrokerHandshakeError("Invalid runtime broker daemon lock");
  }
  const content = fs.readFileSync(lockPath, "utf8");
  const after = fs.lstatSync(lockPath);
  if (before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || !content.endsWith("\n")) {
    throw new RuntimeBrokerHandshakeError("Runtime broker daemon lock changed during readiness validation");
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new RuntimeBrokerHandshakeError("Invalid runtime broker daemon lock");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeBrokerHandshakeError("Invalid runtime broker daemon lock");
  }
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ["generation", "pid", "startedAt", "token", "version"])
    || record.version !== 2
    || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0
    || !Number.isSafeInteger(record.startedAt) || (record.startedAt as number) < 0
    || !isDaemonIdentityPart(record.token)
    || !isDaemonIdentityPart(record.generation)) {
    throw new RuntimeBrokerHandshakeError("Invalid runtime broker daemon lock");
  }
  return { daemonToken: record.token, generation: record.generation };
}

function getOrCreateBootstrapSlot(endpoint: string, stateDirectory: string): BrokerBootstrapSlot {
  const existing = brokerBootstraps.get(endpoint);
  if (existing) return existing;
  const slot: BrokerBootstrapSlot = { endpoint, stateDirectory, attempts: 0, waiters: 0 };
  brokerBootstraps.set(endpoint, slot);
  return slot;
}

function createBootstrap(
  slot: BrokerBootstrapSlot,
  options: ValidatedRuntimeBrokerClientOptions,
): BrokerBootstrap {
  if (slot.attempts >= BROKER_MAX_LAUNCH_ATTEMPTS) {
    throw new RuntimeBrokerBootstrapError(
      `Runtime broker failed after ${slot.attempts} launch attempts: ${errorMessage(slot.lastError)}`,
      { cause: slot.lastError },
    );
  }
  slot.attempts += 1;
  const bootstrap: BrokerBootstrap = {
    authority: { daemonToken: randomUUID(), generation: randomUUID() },
    childExited: false,
    readiness: Promise.resolve(),
    settled: false,
    failed: false,
    reclaimed: false,
  };
  slot.current = bootstrap;
  bootstrap.readiness = launchAndVerifyBootstrap(slot, bootstrap, options);
  bootstrap.readiness.then(
    () => {
      bootstrap.settled = true;
      maybeDeleteBootstrapSlot(slot);
    },
    (error: unknown) => {
      bootstrap.settled = true;
      bootstrap.failed = true;
      slot.lastError = error;
      maybeDeleteBootstrapSlot(slot);
    },
  );
  // The cache owns the generation even when every caller deadline expires.
  void bootstrap.readiness.catch(() => undefined);
  return bootstrap;
}

async function launchAndVerifyBootstrap(
  slot: BrokerBootstrapSlot,
  bootstrap: BrokerBootstrap,
  options: ValidatedRuntimeBrokerClientOptions,
): Promise<void> {
  try {
    await launchBootstrapGeneration(slot, bootstrap, options);
  } catch (error) {
    bootstrap.failed = true;
    try {
      await reclaimBootstrapChild(bootstrap);
    } catch (cleanupError) {
      throw new RuntimeBrokerBootstrapError(
        `Runtime broker daemon failed and its process tree could not be reclaimed: ${errorMessage(cleanupError)}`,
        { cause: new AggregateError([error, cleanupError], "Runtime broker bootstrap cleanup failed") },
      );
    }
    throw error;
  }
}

function launchBootstrapGeneration(
  slot: BrokerBootstrapSlot,
  bootstrap: BrokerBootstrap,
  options: ValidatedRuntimeBrokerClientOptions,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let child: ChildProcess | undefined;
    let retryTimer: NodeJS.Timeout | undefined;
    let initialProbe: NodeJS.Immediate | undefined;
    const startupDeadline = Date.now() + BROKER_BOOTSTRAP_TIMEOUT_MS;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      child?.off("error", onError);
      child?.off("exit", onExit);
      if (retryTimer) clearTimeout(retryTimer);
      if (initialProbe) clearImmediate(initialProbe);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => finish(new RuntimeBrokerBootstrapError(
      `Runtime broker daemon spawn failed: ${error.message}`,
      { cause: error },
    ));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new RuntimeBrokerBootstrapError(
      `Runtime broker daemon exited before readiness (code=${code ?? "null"}, signal=${signal ?? "null"})`,
    ));
    try {
      child = spawn(options.daemonExecutable, [
        options.daemonBinPath,
        "serve",
        "--state-dir",
        slot.stateDirectory,
        "--daemon-token",
        bootstrap.authority.daemonToken,
        "--daemon-generation",
        bootstrap.authority.generation,
      ], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      trackBootstrapChild(bootstrap, child);
      child.on("error", () => undefined);
      child.once("error", onError);
      child.once("exit", onExit);
      child.unref();
    } catch (error) {
      finish(new RuntimeBrokerBootstrapError(
        `Runtime broker daemon spawn failed: ${errorMessage(error)}`,
        { cause: error },
      ));
      return;
    }

    const poll = async () => {
      if (settled) return;
      try {
        const readiness = await probeRuntimeBrokerAuthority({
          stateDirectory: slot.stateDirectory,
          timeoutMs: Math.min(BROKER_PROBE_TIMEOUT_MS, Math.max(1, startupDeadline - Date.now())),
          daemonToken: bootstrap.authority.daemonToken,
          generation: bootstrap.authority.generation,
        });
        validateCanonicalDaemonAuthority(slot.stateDirectory, readiness, bootstrap.authority);
        finish();
      } catch (error) {
        if (settled) return;
        if (!isRuntimeBrokerTransportError(error)) {
          finish(error instanceof Error ? error : new RuntimeBrokerHandshakeError(String(error)));
          return;
        }
        if (Date.now() >= startupDeadline) {
          finish(new RuntimeBrokerBootstrapError(
            `Timed out verifying runtime broker daemon readiness: ${errorMessage(error)}`,
            { cause: error },
          ));
          return;
        }
        retryTimer = setTimeout(
          () => void poll(),
          Math.min(BROKER_START_RETRY_MS, startupDeadline - Date.now()),
        );
      }
    };
    initialProbe = setImmediate(() => void poll());
  });
}

function trackBootstrapChild(bootstrap: BrokerBootstrap, child: ChildProcess): void {
  bootstrap.child = child;
  bootstrap.childPid = child.pid;
  bootstrap.childExit = new Promise<void>((resolve) => {
    let exited = false;
    const finish = () => {
      if (exited) return;
      exited = true;
      bootstrap.childExited = true;
      child.off("exit", finish);
      child.off("close", finish);
      child.off("error", onSpawnError);
      resolve();
    };
    const onSpawnError = () => {
      if (child.pid === undefined) finish();
    };
    child.once("exit", finish);
    child.once("close", finish);
    child.once("error", onSpawnError);
  });
}

async function invalidateBootstrap(
  slot: BrokerBootstrapSlot,
  bootstrap: BrokerBootstrap,
  error: unknown,
): Promise<void> {
  if (slot.current !== bootstrap) return;
  bootstrap.failed = true;
  slot.lastError = error;
  try {
    await reclaimBootstrapChild(bootstrap);
  } catch (cleanupError) {
    slot.lastError = cleanupError;
    throw cleanupError;
  }
  if (slot.current === bootstrap) slot.current = undefined;
}

async function reclaimBootstrapChild(bootstrap: BrokerBootstrap): Promise<void> {
  if (bootstrap.reclaimed) return;
  bootstrap.reclamation ??= reclaimBootstrapChildOnce(bootstrap);
  return bootstrap.reclamation;
}

async function reclaimBootstrapChildOnce(bootstrap: BrokerBootstrap): Promise<void> {
  const childPid = bootstrap.childPid;
  if (childPid === undefined) {
    await bootstrap.childExit;
    bootstrap.child = undefined;
    bootstrap.reclaimed = true;
    return;
  }
  if (await waitForBootstrapReclamation(bootstrap, 0)) {
    bootstrap.child = undefined;
    bootstrap.reclaimed = true;
    return;
  }

  const signalErrors: unknown[] = [];
  try {
    signalBootstrapProcessTree(childPid, false);
  } catch (error) {
    signalErrors.push(error);
  }
  if (await waitForBootstrapReclamation(bootstrap, BROKER_CHILD_TERMINATION_GRACE_MS)) {
    bootstrap.child = undefined;
    bootstrap.reclaimed = true;
    return;
  }
  try {
    signalBootstrapProcessTree(childPid, true);
  } catch (error) {
    signalErrors.push(error);
  }
  if (await waitForBootstrapReclamation(bootstrap, BROKER_CHILD_FORCE_WAIT_MS)) {
    bootstrap.child = undefined;
    bootstrap.reclaimed = true;
    return;
  }
  throw new RuntimeBrokerBootstrapError(
    `Runtime broker daemon process tree ${childPid} did not exit after forced termination`,
    signalErrors.length > 0
      ? { cause: new AggregateError(signalErrors, "Runtime broker process-tree signalling failed") }
      : undefined,
  );
}

async function waitForBootstrapReclamation(
  bootstrap: BrokerBootstrap,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  if (!bootstrap.childExited) {
    const childExit = bootstrap.childExit;
    if (!childExit || timeoutMs === 0) return false;
    const exited = await waitForPromiseUntil(childExit, deadline);
    if (!exited) return false;
  }
  if (process.platform === "win32" || bootstrap.childPid === undefined) return true;
  while (bootstrapProcessTreeExists(bootstrap.childPid)) {
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(BROKER_CHILD_RECLAIM_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return true;
}

async function waitForPromiseUntil(promise: Promise<void>, deadline: number): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish(false), remaining);
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    promise.then(() => finish(true), () => finish(true));
  });
}

function signalBootstrapProcessTree(pid: number, force: boolean): void {
  if (process.platform === "win32") {
    const executable = process.env.SystemRoot
      ? path.win32.join(process.env.SystemRoot, "System32", "taskkill.exe")
      : "taskkill.exe";
    const result = spawnSync(executable, ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
      windowsHide: true,
      stdio: "ignore",
      timeout: BROKER_WINDOWS_TASKKILL_TIMEOUT_MS,
    });
    if (result.error && (result.error as NodeJS.ErrnoException).code !== "ESRCH") throw result.error;
    if (result.status !== null && result.status !== 0 && result.status !== 128) {
      throw new Error(`taskkill failed with status ${result.status}`);
    }
    return;
  }
  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    try {
      process.kill(pid, signal);
    } catch (directError) {
      if ((directError as NodeJS.ErrnoException).code !== "ESRCH") throw directError;
    }
  }
}

function bootstrapProcessTreeExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function maybeDeleteBootstrapSlot(slot: BrokerBootstrapSlot): void {
  if (slot.waiters !== 0) return;
  if (slot.current && (!slot.current.settled || (slot.current.failed && !slot.current.reclaimed))) return;
  if (brokerBootstraps.get(slot.endpoint) === slot) brokerBootstraps.delete(slot.endpoint);
}

async function waitForCaller(readiness: Promise<void>, deadline: number): Promise<void> {
  const remaining = remainingTime(deadline, "Timed out waiting for runtime broker readiness");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new RuntimeBrokerCallerDeadlineError()), remaining);
    timer.unref?.();
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    readiness.then(() => finish(), (error) => finish(error));
  });
}

function remainingTime(deadline: number, message: string): number {
  const remaining = deadline - Date.now();
  if (remaining < 1) throw new RuntimeBrokerClientTransportError(message);
  return remaining;
}

function isDaemonIdentityPart(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_DAEMON_IDENTITY_BYTES
    && !value.includes("\0");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown failure");
}
