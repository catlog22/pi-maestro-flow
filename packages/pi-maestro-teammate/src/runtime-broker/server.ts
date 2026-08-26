import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import {
  RUNTIME_BROKER_PROTOCOL,
  RUNTIME_BROKER_PROTOCOL_VERSION,
  RUNTIME_BROKER_SCHEMA_VERSION,
  RuntimeBrokerError,
  assertJsonValue,
  type AcquireLeaseRequest,
  type CompareAndSwapLeaseRequest,
  type HeartbeatLeaseRequest,
  type JsonValue,
  type LeaseCredential,
  type ReleaseLeaseRequest,
  type RuntimeBrokerCommitRequest,
  type RuntimeBrokerFailureEnvelope,
  type RuntimeBrokerListStreamsRequest,
  type RuntimeBrokerMethod,
  type RuntimeBrokerProbeRequest,
  type RuntimeBrokerProbeResult,
  type RuntimeBrokerReadEventsPageRequest,
  type RuntimeBrokerRequestEnvelope,
  type RuntimeBrokerSuccessEnvelope,
  type TakeoverLeaseRequest,
} from "./contracts.ts";
import {
  RuntimeBrokerClient,
  isRuntimeBrokerTransportError,
} from "./client.ts";
import { RuntimeBrokerLeaseManager } from "./lease-manager.ts";
import {
  assertSecureRuntimeBrokerFile,
  ensurePrivateRuntimeBrokerDirectory,
  getRuntimeBrokerDatabasePath,
  getRuntimeBrokerEndpoint,
  getRuntimeBrokerEndpointWorkspaceId,
  getRuntimeBrokerStateDirectory,
  secureRuntimeBrokerFile,
} from "./private-state.ts";
import {
  RUNTIME_STREAM_EVENTS_PAGE_MAX_BYTES,
  RuntimeBrokerSqliteStore,
} from "./sqlite-store.ts";

export const RUNTIME_BROKER_MAX_LINE_BYTES = 1024 * 1024;
export const RUNTIME_BROKER_MAX_REQUEST_ID_BYTES = 256;

interface ClientState {
  socket: net.Socket;
  decoder: BoundedJsonLineDecoder;
  closed: boolean;
}

interface QuarantinedUnixEndpoint {
  path: string;
  identity: { dev: number; ino: number };
  owned: boolean;
}

class RuntimeBrokerDaemonAuthorityError extends Error {
  constructor(cause: unknown) {
    super("Runtime broker daemon authority was lost", { cause });
    this.name = "RuntimeBrokerDaemonAuthorityError";
  }
}

export interface RuntimeBrokerServerOptions {
  stateDirectory?: string;
  databasePath?: string;
  maxLineBytes?: number;
  daemonToken?: string;
  daemonGeneration?: string;
  /** Production daemon fence; direct embedded servers may omit it. */
  assertDaemonAuthority?: () => boolean | void;
}

export class RuntimeBrokerServer {
  readonly stateDirectory: string;
  readonly databasePath: string;
  readonly endpoint: string;
  readonly daemonToken: string;
  readonly daemonGeneration: string;
  readonly workspaceId: string;
  readonly #maxLineBytes: number;
  readonly #assertDaemonAuthority?: () => boolean | void;
  readonly #clients = new Set<ClientState>();
  #server?: net.Server;
  #store?: RuntimeBrokerSqliteStore;
  #leases?: RuntimeBrokerLeaseManager;
  #socketIdentity?: { dev: number; ino: number };
  #closing?: Promise<void>;
  #closed = false;

  constructor(options: RuntimeBrokerServerOptions = {}) {
    this.stateDirectory = options.stateDirectory ?? getRuntimeBrokerStateDirectory();
    this.databasePath = path.resolve(options.databasePath ?? getRuntimeBrokerDatabasePath(this.stateDirectory));
    if (path.dirname(this.databasePath) !== path.resolve(this.stateDirectory)) {
      throw new Error("Runtime broker database must be inside its private state directory");
    }
    this.endpoint = getRuntimeBrokerEndpoint(this.stateDirectory);
    this.workspaceId = getRuntimeBrokerEndpointWorkspaceId(this.endpoint);
    this.daemonToken = options.daemonToken ?? randomUUID();
    this.daemonGeneration = options.daemonGeneration ?? randomUUID();
    assertDaemonIdentityPart(this.daemonToken, "token");
    assertDaemonIdentityPart(this.daemonGeneration, "generation");
    this.#assertDaemonAuthority = options.assertDaemonAuthority;
    this.#maxLineBytes = options.maxLineBytes ?? RUNTIME_BROKER_MAX_LINE_BYTES;
    if (!Number.isSafeInteger(this.#maxLineBytes) || this.#maxLineBytes < 1024) {
      throw new Error("Runtime broker line limit must be at least 1024 bytes");
    }
  }

  async listen(): Promise<void> {
    if (this.#closed) throw new Error("Runtime broker server is closed");
    if (this.#server || this.#store) throw new Error("Runtime broker server is already listening");
    ensurePrivateRuntimeBrokerDirectory(this.stateDirectory);
    assertSecureRuntimeBrokerFile(this.databasePath, "database");
    assertSecureRuntimeBrokerFile(`${this.databasePath}-wal`, "WAL");
    assertSecureRuntimeBrokerFile(`${this.databasePath}-shm`, "shared memory");
    if (process.platform !== "win32") await removeStaleUnixSocket(this.endpoint);

    try {
      const store = new RuntimeBrokerSqliteStore(this.databasePath);
      this.#store = store;
      this.#leases = new RuntimeBrokerLeaseManager(store);
      secureRuntimeBrokerFile(this.databasePath);
      secureSqliteCompanionFiles(this.databasePath);

      const server = net.createServer((socket) => this.#accept(socket));
      this.#server = server;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.endpoint);
      });
      if (process.platform !== "win32") {
        fs.chmodSync(this.endpoint, 0o600);
        const stat = fs.lstatSync(this.endpoint);
        if (!stat.isSocket() || stat.isSymbolicLink()) throw new Error("Runtime broker endpoint is not a Unix socket");
        this.#socketIdentity = { dev: stat.dev, ino: stat.ino };
      }
    } catch (error) {
      try {
        await this.close();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Runtime broker startup and cleanup failed");
      }
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    const errors: unknown[] = [];
    for (const client of this.#clients) {
      try {
        this.#disconnect(client);
      } catch (error) {
        errors.push(error);
      }
    }
    this.#clients.clear();
    const server = this.#server;
    const store = this.#store;
    this.#server = undefined;
    this.#store = undefined;
    this.#leases = undefined;

    let quarantinedEndpoint: QuarantinedUnixEndpoint | undefined;
    try {
      quarantinedEndpoint = this.#quarantineCurrentUnixEndpoint();
    } catch (error) {
      errors.push(error);
    }
    if (server) {
      try {
        await closeServer(server);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this.#finishUnixEndpointCleanup(quarantinedEndpoint);
    } catch (error) {
      errors.push(error);
    } finally {
      this.#socketIdentity = undefined;
    }
    try {
      store?.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, "Runtime broker server shutdown failed");
  }

  #accept(socket: net.Socket): void {
    socket.setNoDelay(true);
    const client = {} as ClientState;
    client.socket = socket;
    client.closed = false;
    client.decoder = new BoundedJsonLineDecoder(this.#maxLineBytes, (line) => this.#handleLine(client, line));
    this.#clients.add(client);
    socket.on("data", (chunk: Buffer) => {
      try {
        client.decoder.write(chunk);
      } catch (error) {
        this.#rejectAndClose(client, "invalid", invalidRequest(error));
      }
    });
    socket.on("end", () => {
      try {
        client.decoder.end();
        this.#disconnect(client);
      } catch (error) {
        this.#rejectAndClose(client, "invalid", invalidRequest(error));
      }
    });
    socket.on("error", () => this.#disconnect(client));
    socket.on("close", () => this.#disconnect(client, false));
  }

  #handleLine(client: ClientState, line: string): void {
    if (client.closed) return;
    let request: RuntimeBrokerRequestEnvelope;
    try {
      request = parseRequest(line);
    } catch (error) {
      this.#sendFailure(client, extractRequestId(line), invalidRequest(error));
      return;
    }
    try {
      this.#assertCurrentDaemonAuthority();
      let result: JsonValue;
      try {
        result = this.#dispatch(request.requestId, request.method, request.params);
      } finally {
        this.#assertCurrentDaemonAuthority();
      }
      this.#send(client, {
        protocol: RUNTIME_BROKER_PROTOCOL,
        version: RUNTIME_BROKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result,
      });
    } catch (error) {
      if (error instanceof RuntimeBrokerDaemonAuthorityError) {
        this.#rejectAndClose(client, request.requestId, invalidRequest(error));
        return;
      }
      const brokerError = error instanceof RuntimeBrokerError ? error : invalidRequest(error);
      this.#sendFailure(client, request.requestId, brokerError);
    }
  }

  #assertCurrentDaemonAuthority(): void {
    if (!this.#assertDaemonAuthority) return;
    try {
      if (this.#assertDaemonAuthority() === false) {
        throw new Error("Runtime broker daemon authority check failed");
      }
    } catch (error) {
      throw new RuntimeBrokerDaemonAuthorityError(error);
    }
  }

  #dispatch(requestId: string, method: RuntimeBrokerMethod, params: JsonValue): JsonValue {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new RuntimeBrokerError("invalid_request", "params must be an object", { field: "params" });
    }
    const store = this.#store;
    const leases = this.#leases;
    if (!store || !leases) throw new Error("Runtime broker server is not listening");
    switch (method) {
      case "broker.probe": {
        const request = params as unknown as RuntimeBrokerProbeRequest;
        if (!hasExactKeys(params as unknown as Record<string, unknown>, ["challenge"])
          || typeof request.challenge !== "string"
          || request.challenge.length === 0
          || Buffer.byteLength(request.challenge, "utf8") > RUNTIME_BROKER_MAX_REQUEST_ID_BYTES
          || request.challenge.includes("\0")) {
          throw new RuntimeBrokerError("invalid_request", "broker probe challenge must be bounded", { field: "challenge" });
        }
        return {
          protocol: RUNTIME_BROKER_PROTOCOL,
          version: RUNTIME_BROKER_PROTOCOL_VERSION,
          schemaVersion: RUNTIME_BROKER_SCHEMA_VERSION,
          workspaceId: this.workspaceId,
          daemonToken: this.daemonToken,
          generation: this.daemonGeneration,
          readiness: "ready",
          challenge: request.challenge,
        } satisfies RuntimeBrokerProbeResult as unknown as JsonValue;
      }
      case "commit": return store.commit(params as unknown as RuntimeBrokerCommitRequest) as unknown as JsonValue;
      case "lease.acquire": return leases.acquire(params as unknown as AcquireLeaseRequest, requestId) as unknown as JsonValue;
      case "lease.heartbeat": return leases.heartbeat(params as unknown as HeartbeatLeaseRequest, requestId) as unknown as JsonValue;
      case "lease.compare-and-swap": return leases.compareAndSwap(params as unknown as CompareAndSwapLeaseRequest, requestId) as unknown as JsonValue;
      case "lease.takeover": return leases.takeover(params as unknown as TakeoverLeaseRequest, requestId) as unknown as JsonValue;
      case "lease.release":
        leases.release(params as unknown as ReleaseLeaseRequest, requestId);
        return null;
      case "stream.revision": return store.getStreamRevision((params as { streamId?: string }).streamId ?? "");
      case "stream.events": {
        const request = params as { streamId?: string; afterRevision?: number; actorId?: string; lease?: LeaseCredential };
        const streamId = request.streamId ?? "";
        const events = store.readAuthorizedEvents(streamId, request.afterRevision ?? 0, {
          actorId: request.actorId ?? "",
          lease: request.lease as LeaseCredential,
        });
        const encoded = `${JSON.stringify({
          protocol: RUNTIME_BROKER_PROTOCOL,
          version: RUNTIME_BROKER_PROTOCOL_VERSION,
          requestId,
          ok: true,
          result: events,
        })}\n`;
        if (Buffer.byteLength(encoded, "utf8") > this.#maxLineBytes) {
          throw new RuntimeBrokerError(
            "invalid_request",
            "stream.events requires pagination; use stream.events.page",
            { requiredMethod: "stream.events.page" },
          );
        }
        return events as unknown as JsonValue;
      }
      case "stream.events.page": {
        const request = params as unknown as RuntimeBrokerReadEventsPageRequest;
        return store.readAuthorizedEventsPage(request, this.#streamEventsPageByteBudget()) as unknown as JsonValue;
      }
      case "stream.list": return store.listStreams(params as unknown as RuntimeBrokerListStreamsRequest) as unknown as JsonValue;
      case "read-model.events": {
        const request = params as { workspaceId?: string; afterCursor?: number; limit?: number };
        return store.readRuntimeReadModelEvents(
          request.workspaceId ?? "",
          request.afterCursor ?? 0,
          request.limit ?? 128,
        ) as unknown as JsonValue;
      }
      case "read-model.sources": {
        const request = params as { workspaceId?: string; afterStreamId?: string; limit?: number };
        return store.readRuntimeReadModelSources(
          request.workspaceId ?? "",
          request.afterStreamId ?? "",
          request.limit ?? 128,
        ) as unknown as JsonValue;
      }
    }
  }

  #streamEventsPageByteBudget(): number {
    return Math.min(RUNTIME_STREAM_EVENTS_PAGE_MAX_BYTES, Math.max(256, this.#maxLineBytes - 4 * 1024));
  }

  #send(client: ClientState, envelope: RuntimeBrokerSuccessEnvelope | RuntimeBrokerFailureEnvelope): void {
    if (client.closed || !client.socket.writable) return;
    let encoded = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > this.#maxLineBytes) {
      encoded = `${JSON.stringify(failureEnvelope(envelope.requestId, new RuntimeBrokerError(
        "invalid_request",
        "response exceeds the runtime broker line limit",
      )))}\n`;
    }
    client.socket.write(encoded);
  }

  #sendFailure(client: ClientState, requestId: string, error: RuntimeBrokerError): void {
    this.#send(client, failureEnvelope(requestId, error));
  }

  #rejectAndClose(client: ClientState, requestId: string, error: RuntimeBrokerError): void {
    this.#sendFailure(client, requestId, error);
    this.#disconnect(client, false);
    if (client.socket.writable) client.socket.end();
    else client.socket.destroy();
  }

  #disconnect(client: ClientState, destroy = true): void {
    if (!client.closed) {
      client.closed = true;
      this.#clients.delete(client);
    }
    if (destroy && !client.socket.destroyed) client.socket.destroy();
  }

  #quarantineCurrentUnixEndpoint(): QuarantinedUnixEndpoint | undefined {
    if (process.platform === "win32" || !this.#socketIdentity) return undefined;
    try {
      const stat = fs.lstatSync(this.endpoint);
      const owned = stat.isSocket()
        && !stat.isSymbolicLink()
        && stat.dev === this.#socketIdentity.dev
        && stat.ino === this.#socketIdentity.ino;
      const quarantined = quarantineUnixPath(this.endpoint, stat.dev, stat.ino, "endpoint during close");
      return { ...quarantined, owned };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  #finishUnixEndpointCleanup(quarantined: QuarantinedUnixEndpoint | undefined): void {
    try {
      if (!quarantined) return;
      if (quarantined.owned) {
        removeQuarantinedUnixPath(quarantined.path, quarantined.identity, "owned endpoint");
      } else {
        restoreQuarantinedUnixPath(quarantined.path, this.endpoint, quarantined.identity, "foreign endpoint");
      }
    } finally {
      this.#socketIdentity = undefined;
    }
  }
}

export async function removeStaleUnixSocket(endpoint: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isSocket() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to replace non-socket runtime broker endpoint: ${endpoint}`);
  }
  const staleIdentity = { dev: stat.dev, ino: stat.ino };
  let client: RuntimeBrokerClient | undefined;
  try {
    client = await RuntimeBrokerClient.connect({ endpoint, timeoutMs: 500 });
    throw new Error(
      `Runtime broker daemon is already running (generation ${client.readiness.generation})`,
    );
  } catch (error) {
    if (!isRuntimeBrokerTransportError(error)) throw error;
  } finally {
    await client?.close();
  }
  let quarantined: { path: string; identity: { dev: number; ino: number } };
  try {
    quarantined = quarantineUnixPath(
      endpoint,
      staleIdentity.dev,
      staleIdentity.ino,
      "stale endpoint",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  removeQuarantinedUnixPath(quarantined.path, quarantined.identity, "stale endpoint");
}

function quarantineUnixPath(
  sourcePath: string,
  expectedDev: number,
  expectedIno: number,
  label: string,
): { path: string; identity: { dev: number; ino: number } } {
  const quarantinePath = `${sourcePath}.quarantine-${process.pid}-${randomUUID()}`;
  fs.renameSync(sourcePath, quarantinePath);
  const moved = fs.lstatSync(quarantinePath);
  if (moved.dev !== expectedDev || moved.ino !== expectedIno) {
    const unexpected = { dev: moved.dev, ino: moved.ino };
    try {
      restoreQuarantinedUnixPath(quarantinePath, sourcePath, unexpected, `unexpected ${label}`);
    } catch {
      // Keep an unexpected inode isolated rather than deleting or overwriting another endpoint.
    }
    throw new Error(`Runtime broker ${label} changed before quarantine`);
  }
  return { path: quarantinePath, identity: { dev: moved.dev, ino: moved.ino } };
}

function removeQuarantinedUnixPath(
  quarantinePath: string,
  expected: { dev: number; ino: number },
  label: string,
): void {
  const current = fs.lstatSync(quarantinePath);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`Runtime broker ${label} changed inside quarantine`);
  }
  fs.rmSync(quarantinePath);
}

function restoreQuarantinedUnixPath(
  quarantinePath: string,
  destinationPath: string,
  expected: { dev: number; ino: number },
  label: string,
): void {
  const quarantined = fs.lstatSync(quarantinePath);
  if (quarantined.dev !== expected.dev || quarantined.ino !== expected.ino) {
    throw new Error(`Runtime broker ${label} changed inside quarantine`);
  }
  try {
    fs.linkSync(quarantinePath, destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Runtime broker endpoint changed while closing; preserved replacement at ${quarantinePath}`);
    }
    throw error;
  }
  const restored = fs.lstatSync(destinationPath);
  if (restored.dev !== expected.dev || restored.ino !== expected.ino) {
    throw new Error(`Runtime broker ${label} changed while restoring`);
  }
  removeQuarantinedUnixPath(quarantinePath, expected, label);
}

export class BoundedJsonLineDecoder {
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
      if (newline > this.#maxLineBytes) throw new Error("Runtime broker protocol record exceeds the line limit");
      const record = this.#buffer.subarray(0, newline);
      if (!isUtf8(record)) throw new Error("Runtime broker protocol record is not valid UTF-8");
      const line = record.toString("utf8");
      this.#buffer = this.#buffer.subarray(newline + 1);
      this.#onLine(line);
    }
    if (this.#buffer.length > this.#maxLineBytes) throw new Error("Runtime broker protocol record exceeds the line limit");
  }

  end(): void {
    if (this.#buffer.length > 0) throw new Error("Runtime broker protocol stream ended with an incomplete record");
  }
}

function parseRequest(line: string): RuntimeBrokerRequestEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new RuntimeBrokerError("invalid_request", "request is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeBrokerError("invalid_request", "request envelope must be an object");
  }
  const request = value as Record<string, unknown>;
  if (!hasExactKeys(request, ["method", "params", "protocol", "requestId", "version"])) {
    throw new RuntimeBrokerError("invalid_request", "request envelope has unexpected fields");
  }
  if (request.protocol !== RUNTIME_BROKER_PROTOCOL || request.version !== RUNTIME_BROKER_PROTOCOL_VERSION) {
    throw new RuntimeBrokerError("invalid_request", "unsupported runtime broker protocol or version");
  }
  if (typeof request.requestId !== "string" || !request.requestId
    || Buffer.byteLength(request.requestId, "utf8") > RUNTIME_BROKER_MAX_REQUEST_ID_BYTES
    || request.requestId.includes("\0")) {
    throw new RuntimeBrokerError("invalid_request", "requestId must be a bounded non-empty string", { field: "requestId" });
  }
  if (!isRuntimeBrokerMethod(request.method)) {
    throw new RuntimeBrokerError("invalid_request", "unknown runtime broker method", { field: "method" });
  }
  if (!("params" in request)) {
    throw new RuntimeBrokerError("invalid_request", "params is required", { field: "params" });
  }
  assertJsonValue(request.params, "params");
  return request as unknown as RuntimeBrokerRequestEnvelope;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
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

function extractRequestId(line: string): string {
  try {
    const value = JSON.parse(line) as { requestId?: unknown };
    if (typeof value?.requestId === "string" && value.requestId
      && Buffer.byteLength(value.requestId, "utf8") <= RUNTIME_BROKER_MAX_REQUEST_ID_BYTES
      && !value.requestId.includes("\0")) return value.requestId;
  } catch {
    // A malformed record has no trustworthy correlation id.
  }
  return "invalid";
}

function invalidRequest(_error: unknown): RuntimeBrokerError {
  return new RuntimeBrokerError("invalid_request", "runtime broker request was rejected");
}

function failureEnvelope(requestId: string, error: RuntimeBrokerError): RuntimeBrokerFailureEnvelope {
  return {
    protocol: RUNTIME_BROKER_PROTOCOL,
    version: RUNTIME_BROKER_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: error.toJSON(),
  };
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    try {
      server.close((error?: Error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolve();
      else reject(error);
    }
  });
}

function assertDaemonIdentityPart(value: string, label: string): void {
  if (!value || Buffer.byteLength(value, "utf8") > 256 || value.includes("\0")) {
    throw new Error(`Runtime broker daemon ${label} must be a bounded non-empty string`);
  }
}

function secureSqliteCompanionFiles(databasePath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      secureRuntimeBrokerFile(`${databasePath}${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
