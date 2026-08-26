import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import {
  RUNTIME_BROKER_PROTOCOL,
  RUNTIME_BROKER_PROTOCOL_VERSION,
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
  type RuntimeBrokerRequestEnvelope,
  type RuntimeBrokerSuccessEnvelope,
  type TakeoverLeaseRequest,
} from "./contracts.ts";
import { RuntimeBrokerLeaseManager } from "./lease-manager.ts";
import {
  assertSecureRuntimeBrokerFile,
  ensurePrivateRuntimeBrokerDirectory,
  getRuntimeBrokerDatabasePath,
  getRuntimeBrokerEndpoint,
  getRuntimeBrokerStateDirectory,
  secureRuntimeBrokerFile,
} from "./private-state.ts";
import { RuntimeBrokerSqliteStore } from "./sqlite-store.ts";

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

export interface RuntimeBrokerServerOptions {
  stateDirectory?: string;
  databasePath?: string;
  maxLineBytes?: number;
}

export class RuntimeBrokerServer {
  readonly stateDirectory: string;
  readonly databasePath: string;
  readonly endpoint: string;
  readonly #maxLineBytes: number;
  readonly #clients = new Set<ClientState>();
  #server?: net.Server;
  #store?: RuntimeBrokerSqliteStore;
  #leases?: RuntimeBrokerLeaseManager;
  #socketIdentity?: { dev: number; ino: number };
  #closing?: Promise<void>;

  constructor(options: RuntimeBrokerServerOptions = {}) {
    this.stateDirectory = options.stateDirectory ?? getRuntimeBrokerStateDirectory();
    this.databasePath = path.resolve(options.databasePath ?? getRuntimeBrokerDatabasePath(this.stateDirectory));
    if (path.dirname(this.databasePath) !== path.resolve(this.stateDirectory)) {
      throw new Error("Runtime broker database must be inside its private state directory");
    }
    this.endpoint = getRuntimeBrokerEndpoint(this.stateDirectory);
    this.#maxLineBytes = options.maxLineBytes ?? RUNTIME_BROKER_MAX_LINE_BYTES;
    if (!Number.isSafeInteger(this.#maxLineBytes) || this.#maxLineBytes < 1024) {
      throw new Error("Runtime broker line limit must be at least 1024 bytes");
    }
  }

  async listen(): Promise<void> {
    if (this.#server || this.#store) throw new Error("Runtime broker server is already listening");
    ensurePrivateRuntimeBrokerDirectory(this.stateDirectory);
    assertSecureRuntimeBrokerFile(this.databasePath, "database");
    assertSecureRuntimeBrokerFile(`${this.databasePath}-wal`, "WAL");
    assertSecureRuntimeBrokerFile(`${this.databasePath}-shm`, "shared memory");
    if (process.platform !== "win32") await removeStaleUnixSocket(this.endpoint);

    const store = new RuntimeBrokerSqliteStore(this.databasePath);
    this.#store = store;
    this.#leases = new RuntimeBrokerLeaseManager(store);
    secureRuntimeBrokerFile(this.databasePath);
    secureSqliteCompanionFiles(this.databasePath);

    const server = net.createServer((socket) => this.#accept(socket));
    this.#server = server;
    try {
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
      await this.close();
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    for (const client of this.#clients) this.#disconnect(client);
    this.#clients.clear();
    const server = this.#server;
    this.#server = undefined;
    const store = this.#store;
    this.#store = undefined;
    const quarantinedEndpoint = this.#quarantineCurrentUnixEndpoint();
    try {
      if (server) {
        await new Promise<void>((resolve) => {
          try {
            server.close(() => resolve());
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolve();
            else throw error;
          }
        });
      }
    } finally {
      try {
        this.#finishUnixEndpointCleanup(quarantinedEndpoint);
      } finally {
        this.#leases = undefined;
        store?.close();
      }
    }
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
    let request: RuntimeBrokerRequestEnvelope;
    try {
      request = parseRequest(line);
    } catch (error) {
      this.#sendFailure(client, extractRequestId(line), invalidRequest(error));
      return;
    }
    try {
      const result = this.#dispatch(request.method, request.params);
      this.#send(client, {
        protocol: RUNTIME_BROKER_PROTOCOL,
        version: RUNTIME_BROKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result,
      });
    } catch (error) {
      const brokerError = error instanceof RuntimeBrokerError ? error : invalidRequest(error);
      this.#sendFailure(client, request.requestId, brokerError);
    }
  }

  #dispatch(method: RuntimeBrokerMethod, params: JsonValue): JsonValue {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new RuntimeBrokerError("invalid_request", "params must be an object", { field: "params" });
    }
    const store = this.#store;
    const leases = this.#leases;
    if (!store || !leases) throw new Error("Runtime broker server is not listening");
    switch (method) {
      case "commit": return store.commit(params as unknown as RuntimeBrokerCommitRequest) as unknown as JsonValue;
      case "lease.acquire": return leases.acquire(params as unknown as AcquireLeaseRequest) as unknown as JsonValue;
      case "lease.heartbeat": return leases.heartbeat(params as unknown as HeartbeatLeaseRequest) as unknown as JsonValue;
      case "lease.compare-and-swap": return leases.compareAndSwap(params as unknown as CompareAndSwapLeaseRequest) as unknown as JsonValue;
      case "lease.takeover": return leases.takeover(params as unknown as TakeoverLeaseRequest) as unknown as JsonValue;
      case "lease.release":
        leases.release(params as unknown as ReleaseLeaseRequest);
        return null;
      case "stream.revision": return store.getStreamRevision((params as { streamId?: string }).streamId ?? "");
      case "stream.events": {
        const request = params as { streamId?: string; afterRevision?: number; actorId?: string; lease?: LeaseCredential };
        return store.readAuthorizedEvents(
          request.streamId ?? "",
          request.afterRevision ?? 0,
          { actorId: request.actorId ?? "", lease: request.lease as LeaseCredential },
        ) as unknown as JsonValue;
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
  const live = await new Promise<boolean>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const timer = setTimeout(() => finish(new Error("Timed out probing existing runtime broker socket")), 500);
    timer.unref?.();
    let settled = false;
    const finish = (error?: Error, value?: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      socket.removeAllListeners();
      if (error) reject(error);
      else resolve(value!);
    };
    socket.once("connect", () => finish(undefined, true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish(undefined, false);
      else finish(error);
    });
  });
  if (live) throw new Error("Runtime broker daemon is already running");
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

function secureSqliteCompanionFiles(databasePath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      secureRuntimeBrokerFile(`${databasePath}${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
