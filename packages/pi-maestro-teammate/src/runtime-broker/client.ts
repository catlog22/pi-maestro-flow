import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_BROKER_PROTOCOL,
  RUNTIME_BROKER_PROTOCOL_VERSION,
  RuntimeBrokerError,
  assertJsonValue,
  type AcquireLeaseRequest,
  type ActorLease,
  type HeartbeatLeaseRequest,
  type JsonValue,
  type ReleaseLeaseRequest,
  type RuntimeBrokerCommitRequest,
  type RuntimeBrokerCommitResult,
  type RuntimeBrokerErrorCode,
  type RuntimeBrokerFailureEnvelope,
  type RuntimeBrokerListStreamsRequest,
  type RuntimeBrokerMethod,
  type RuntimeBrokerSuccessEnvelope,
  type RuntimeBrokerReadModelSourceState,
  type RuntimeBrokerStreamAuthorization,
  type StoredRuntimeBrokerCursorEvent,
  type StoredRuntimeBrokerEvent,
} from "./contracts.ts";
import { getRuntimeBrokerEndpoint, getRuntimeBrokerStateDirectory } from "./private-state.ts";

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const MAX_REQUEST_ID_BYTES = 256;
const BROKER_START_RETRY_MS = 40;
const BROKER_BIN_PATH = fileURLToPath(new URL("../../bin/pi-teammate-broker.mjs", import.meta.url));

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ValidatedRuntimeBrokerClientOptions {
  timeoutMs: number;
  maxLineBytes: number;
  maxPendingRequests: number;
}

export interface RuntimeBrokerClientOptions {
  stateDirectory?: string;
  endpoint?: string;
  timeoutMs?: number;
  maxLineBytes?: number;
  maxPendingRequests?: number;
}

export class RuntimeBrokerClient {
  readonly endpoint: string;
  readonly #socket: net.Socket;
  readonly #timeoutMs: number;
  readonly #maxLineBytes: number;
  readonly #maxPendingRequests: number;
  readonly #pending = new Map<string, PendingRequest>();
  #closed = false;

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
    socket.on("close", () => this.#failAll(new Error("Runtime broker connection closed")));
  }

  static async connect(options: RuntimeBrokerClientOptions = {}): Promise<RuntimeBrokerClient> {
    const validated = validateClientOptions(options);
    const endpoint = options.endpoint
      ?? getRuntimeBrokerEndpoint(options.stateDirectory ?? getRuntimeBrokerStateDirectory());
    const socket = net.createConnection(endpoint);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Timed out connecting to runtime broker")), validated.timeoutMs);
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
    try {
      return new RuntimeBrokerClient(socket, endpoint, validated);
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  static async connectOrStart(options: RuntimeBrokerClientOptions = {}): Promise<RuntimeBrokerClient> {
    const validated = validateClientOptions(options);
    try {
      return await RuntimeBrokerClient.connect(options);
    } catch (error) {
      if (options.endpoint !== undefined || !isBrokerUnavailable(error)) throw error;
      const stateDirectory = options.stateDirectory ?? getRuntimeBrokerStateDirectory();
      launchRuntimeBrokerDaemon(stateDirectory);
      const deadline = Date.now() + validated.timeoutMs;
      let lastError: unknown = error;
      while (Date.now() < deadline) {
        await delay(Math.min(BROKER_START_RETRY_MS, Math.max(1, deadline - Date.now())));
        try {
          return await RuntimeBrokerClient.connect({
            ...options,
            timeoutMs: Math.max(1, Math.min(250, deadline - Date.now())),
          });
        } catch (retryError) {
          if (!isBrokerUnavailable(retryError)) throw retryError;
          lastError = retryError;
        }
      }
      throw lastError;
    }
  }

  request<TResult = JsonValue>(
    method: RuntimeBrokerMethod,
    params: JsonValue,
    requestId: string = randomUUID(),
  ): Promise<TResult> {
    if (this.#closed || this.#socket.destroyed) return Promise.reject(new Error("Runtime broker client is closed"));
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
        const error = new Error(`Runtime broker request timed out: ${requestId}`);
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
  readEvents(
    streamId: string,
    afterRevision = 0,
    authorizationOrRequestId?: RuntimeBrokerStreamAuthorization | string,
    requestId?: string,
  ): Promise<StoredRuntimeBrokerEvent[]> {
    const authorization = typeof authorizationOrRequestId === "string" ? undefined : authorizationOrRequestId;
    const resolvedRequestId = typeof authorizationOrRequestId === "string" ? authorizationOrRequestId : requestId;
    return this.request("stream.events", {
      streamId,
      afterRevision,
      ...(authorization === undefined ? {} : {
        actorId: authorization.actorId,
        lease: { epoch: authorization.lease.epoch, nonce: authorization.lease.nonce },
      }),
    }, resolvedRequestId);
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
    this.#failAll(new Error("Runtime broker client closed"));
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
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxPendingRequests = options.maxPendingRequests ?? 256;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Runtime broker timeout must be positive");
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1024) {
    throw new Error("Runtime broker line limit must be at least 1024 bytes");
  }
  if (!Number.isSafeInteger(maxPendingRequests) || maxPendingRequests < 1) {
    throw new Error("Runtime broker pending request limit must be positive");
  }
  return { timeoutMs, maxLineBytes, maxPendingRequests };
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
  return value === "commit"
    || value === "lease.acquire"
    || value === "lease.heartbeat"
    || value === "lease.compare-and-swap"
    || value === "lease.takeover"
    || value === "lease.release"
    || value === "stream.revision"
    || value === "stream.events"
    || value === "stream.list"
    || value === "read-model.events"
    || value === "read-model.sources";
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

function isBrokerUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

function launchRuntimeBrokerDaemon(stateDirectory: string): void {
  const child = spawn(process.execPath, [
    BROKER_BIN_PATH,
    "serve",
    "--state-dir",
    stateDirectory,
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("error", () => undefined);
  child.unref();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
