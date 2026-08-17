import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { RemoteDriver, RemoteRunHandle } from "./driver.ts";
import {
  ensurePrivateRemoteDirectory,
  getRemoteStateDirectory,
  RemoteRunJournal,
  type RemoteStoredCommand,
} from "./journal.ts";
import { AcpDriver } from "./acp-driver.ts";
import { PiRpcDriver } from "./pi-rpc-driver.ts";
import {
  REMOTE_JSONRPC_VERSION,
  REMOTE_MAX_ID_LENGTH,
  REMOTE_MAX_LINE_BYTES,
  REMOTE_MAX_OBJECTIVE_BYTES,
  encodeRemoteEnvelope,
  parseRemoteEnvelopeLine,
  type RemoteInitializeParams,
  type RemoteJsonRpcEnvelope,
  type RemoteJsonRpcFailure,
  type RemoteJsonRpcId,
  type RemoteJsonRpcRequest,
  type RemoteJsonRpcSuccess,
  type RemoteRequestMethod,
  type RemoteRequestParamsByMethod,
  type RemoteResultByMethod,
  type RemoteRunAttachParams,
  type RemoteRunCancelParams,
  type RemoteRunInputParams,
  type RemoteRunStartParams,
} from "./protocol.ts";
import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteRunCapture,
  type RemoteRunEvent,
  type ResolvedRemoteTarget,
} from "./types.ts";
import { redactRemoteError } from "./child-security.ts";

export const REMOTE_SOCKET_FILE = "bridge.sock";
export const REMOTE_DAEMON_LOCK_FILE = "daemon.lock";
export const REMOTE_HEARTBEAT_MS = 15_000;
export const REMOTE_CLIENT_EGRESS_BYTES = 16 * 1024 * 1024;

class RemoteRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

interface ClientState {
  socket: net.Socket;
  monitorOwnerNonce?: string;
  subscriptions: Map<string, number>;
  requestTail: Promise<void>;
  writeTail: Promise<void>;
  egressBytes: number;
  closed: boolean;
}

export interface RemoteBridgeServerOptions {
  stateDirectory?: string;
  journal?: RemoteRunJournal;
  targets: readonly ResolvedRemoteTarget[];
  drivers?: readonly RemoteDriver[];
  concurrency?: number;
  heartbeatMs?: number;
  clientEgressBytes?: number;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeErrorData(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[REDACTED]";
  if (typeof value === "string") return redactRemoteError(value);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeErrorData(entry, depth + 1));
  if (plainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeErrorData(entry, depth + 1)]));
  }
  return undefined;
}

function boundedString(value: unknown, label: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value) || Buffer.byteLength(value, "utf8") > maxBytes || value.includes("\0")) {
    throw new RemoteRpcError(-32602, `Invalid ${label}`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string, allowZero = false): number {
  if (!Number.isInteger(value) || (allowZero ? (value as number) < 0 : (value as number) < 1)) {
    throw new RemoteRpcError(-32602, `Invalid ${label}`);
  }
  return value as number;
}

function validateCommandId(value: unknown): string {
  return boundedString(value, "commandId", REMOTE_MAX_ID_LENGTH);
}

function validateOwner(value: unknown): string {
  return boundedString(value, "monitorOwnerNonce", REMOTE_MAX_ID_LENGTH);
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function statusForRuns(activeRuns: number): "ready" | "running" {
  return activeRuns > 0 ? "running" : "ready";
}

export function getRemoteSocketPath(stateDirectory = getRemoteStateDirectory()): string {
  const resolved = path.resolve(stateDirectory);
  if (process.platform === "win32") {
    const key = createHash("sha256").update(resolved).digest("hex").slice(0, 24);
    return `\\\\.\\pipe\\pi-teammate-remote-${key}`;
  }
  const socketPath = path.join(resolved, REMOTE_SOCKET_FILE);
  if (Buffer.byteLength(socketPath) > 100) throw new Error("Remote state directory is too long for a Unix-domain socket");
  return socketPath;
}

class BoundedLineDecoder {
  #buffer = Buffer.alloc(0);
  readonly #onLine: (line: string) => void;

  constructor(onLine: (line: string) => void) {
    this.#onLine = onLine;
  }

  write(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > REMOTE_MAX_LINE_BYTES) throw new Error("Remote protocol record exceeds the line limit");
      const record = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      this.#onLine(`${record.toString("utf8")}\n`);
    }
    if (this.#buffer.length > REMOTE_MAX_LINE_BYTES) throw new Error("Remote protocol record exceeds the line limit");
  }

  end(): void {
    if (this.#buffer.length > 0) throw new Error("Remote protocol stream ended with an incomplete record");
  }
}

export class RemoteBridgeServer {
  readonly journal: RemoteRunJournal;
  readonly socketPath: string;
  readonly #targets: Map<string, ResolvedRemoteTarget>;
  readonly #drivers: Map<string, RemoteDriver>;
  readonly #clients = new Set<ClientState>();
  readonly #handles = new Map<string, RemoteRunHandle>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #inflightCommands = new Map<string, { fingerprint: string; promise: Promise<NonNullable<RemoteStoredCommand["outcome"]>> }>();
  readonly #concurrency: number;
  readonly #heartbeatMs: number;
  readonly #clientEgressBytes: number;
  #startingRuns = 0;
  #server?: net.Server;
  #heartbeat?: NodeJS.Timeout;
  #socketIdentity?: { dev: number; ino: number };

  constructor(options: RemoteBridgeServerOptions) {
    this.journal = options.journal ?? new RemoteRunJournal(options.stateDirectory);
    this.socketPath = getRemoteSocketPath(this.journal.stateDirectory);
    this.#targets = new Map(options.targets.map((target) => [target.id, target]));
    const drivers = options.drivers ?? [
      new PiRpcDriver({ scratchRoot: path.join(this.journal.stateDirectory, "tmp") }),
      new AcpDriver(),
    ];
    this.#drivers = new Map(drivers.map((driver) => [driver.id, driver]));
    this.#concurrency = options.concurrency ?? 4;
    this.#heartbeatMs = options.heartbeatMs ?? REMOTE_HEARTBEAT_MS;
    this.#clientEgressBytes = options.clientEgressBytes ?? REMOTE_CLIENT_EGRESS_BYTES;
    if (!Number.isInteger(this.#concurrency) || this.#concurrency < 1 || this.#concurrency > 128) {
      throw new Error("Remote daemon concurrency must be between 1 and 128");
    }
    if (!Number.isSafeInteger(this.#clientEgressBytes) || this.#clientEgressBytes < REMOTE_MAX_LINE_BYTES) {
      throw new Error(`Remote client egress limit must be at least ${REMOTE_MAX_LINE_BYTES} bytes`);
    }
  }

  async listen(): Promise<void> {
    if (this.#server) throw new Error("Remote bridge server is already listening");
    ensurePrivateRemoteDirectory(this.journal.stateDirectory);
    if (process.platform !== "win32") await this.#removeStaleSocket();
    const server = net.createServer((socket) => this.#accept(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.socketPath);
    });
    if (process.platform !== "win32") {
      fs.chmodSync(this.socketPath, 0o600);
      const stat = fs.lstatSync(this.socketPath);
      if (!stat.isSocket() || stat.isSymbolicLink()) throw new Error("Remote daemon path is not a Unix socket");
      this.#socketIdentity = { dev: stat.dev, ino: stat.ino };
    }
    this.#heartbeat = setInterval(() => this.#broadcastHeartbeat(), this.#heartbeatMs);
    this.#heartbeat.unref?.();
  }

  async close(): Promise<void> {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    for (const client of this.#clients) this.#disconnectClient(client);
    this.#clients.clear();
    for (const controller of this.#controllers.values()) controller.abort();
    this.#controllers.clear();
    await Promise.allSettled([...this.#drivers.values()].map((driver) => driver.close()));
    this.#handles.clear();
    const server = this.#server;
    this.#server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.#unlinkOwnedSocket();
  }

  #accept(socket: net.Socket): void {
    socket.setNoDelay(true);
    const client: ClientState = {
      socket,
      subscriptions: new Map(),
      requestTail: Promise.resolve(),
      writeTail: Promise.resolve(),
      egressBytes: 0,
      closed: false,
    };
    this.#clients.add(client);
    const decoder = new BoundedLineDecoder((line) => {
      client.requestTail = client.requestTail
        .then(() => this.#handleLine(client, line))
        .catch((error: unknown) => {
          this.#sendFailure(client, null, -32000, redactRemoteError(error));
          this.#disconnectClient(client);
        });
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        decoder.write(chunk);
      } catch (error) {
        this.#sendFailure(client, null, -32700, redactRemoteError(error));
        this.#disconnectClient(client);
      }
    });
    socket.on("end", () => {
      try {
        decoder.end();
      } catch (error) {
        this.#sendFailure(client, null, -32700, redactRemoteError(error));
        this.#disconnectClient(client);
      }
    });
    socket.on("close", () => this.#disconnectClient(client, false));
    socket.on("error", () => this.#disconnectClient(client, false));
  }

  async #handleLine(client: ClientState, line: string): Promise<void> {
    let envelope: RemoteJsonRpcEnvelope;
    try { envelope = parseRemoteEnvelopeLine(line); } catch (error) {
      this.#sendFailure(client, null, -32700, (error as Error).message);
      return;
    }
    if (!("method" in envelope) || !("id" in envelope)) {
      this.#sendFailure(client, null, -32600, "Remote daemon accepts JSON-RPC requests only");
      return;
    }
    const request = envelope as RemoteJsonRpcRequest;
    try {
      if (!this.#isRequestMethod(request.method)) throw new RemoteRpcError(-32601, `Unknown remote method: ${request.method}`);
      const result = await this.#dispatch(client, request.method, request.params);
      this.#send(client, { jsonrpc: REMOTE_JSONRPC_VERSION, id: request.id, result });
    } catch (error) {
      const rpcError = error instanceof RemoteRpcError
        ? error
        : new RemoteRpcError(-32000, redactRemoteError(error));
      this.#sendFailure(client, request.id, rpcError.code, redactRemoteError(rpcError.message), sanitizeErrorData(rpcError.data));
    }
  }

  async #dispatch<Method extends RemoteRequestMethod>(
    client: ClientState,
    method: Method,
    rawParams: unknown,
  ): Promise<RemoteResultByMethod[Method]> {
    if (!plainObject(rawParams)) throw new RemoteRpcError(-32602, "Remote request params must be an object");
    const commandId = validateCommandId(rawParams.commandId);
    const monitorOwnerNonce = validateOwner(rawParams.monitorOwnerNonce);
    if (method !== "remote/initialize") {
      if (!client.monitorOwnerNonce) throw new RemoteRpcError(-32001, "Remote connection is not initialized");
      if (client.monitorOwnerNonce !== monitorOwnerNonce) throw new RemoteRpcError(-32003, "Monitor ownership nonce mismatch");
    }
    const params = this.#validateParams(method, rawParams) as RemoteRequestParamsByMethod[Method];
    const outcome = await this.#idempotent(commandId, method, params, async () => {
      switch (method) {
        case "remote/initialize": return this.#initialize(params as RemoteInitializeParams);
        case "run/start": return this.#start(client, params as RemoteRunStartParams);
        case "run/attach": return this.#attach(client, params as RemoteRunAttachParams);
        case "run/input": return this.#input(params as RemoteRunInputParams);
        case "run/cancel": return this.#cancel(params as RemoteRunCancelParams);
        case "run/list": return { runs: this.journal.listRuns(monitorOwnerNonce).map((record) => record.snapshot) };
      }
    });
    if (!outcome.ok) throw new RemoteRpcError(outcome.code, outcome.message, outcome.data);
    if (method === "remote/initialize") client.monitorOwnerNonce = monitorOwnerNonce;
    return outcome.result as RemoteResultByMethod[Method];
  }

  #initialize(params: RemoteInitializeParams): RemoteResultByMethod["remote/initialize"] {
    if (!params.protocolVersions.includes(REMOTE_PROTOCOL_VERSION)) {
      throw new RemoteRpcError(
        -32002,
        `Unsupported remote protocol; this daemon speaks ${REMOTE_PROTOCOL_VERSION} `
        + `and the client offered ${params.protocolVersions.join(", ")}`,
      );
    }
    const activeRuns = this.#handles.size;
    return {
      ...this.journal.identity,
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      concurrency: this.#concurrency,
      activeRuns,
      status: statusForRuns(activeRuns),
    };
  }

  async #start(client: ClientState, params: RemoteRunStartParams): Promise<RemoteResultByMethod["run/start"]> {
    if (this.#handles.size + this.#startingRuns >= this.#concurrency) {
      throw new RemoteRpcError(-32005, "Remote daemon concurrency limit reached");
    }
    const target = this.#targets.get(params.targetId);
    if (!target) throw new RemoteRpcError(-32004, `Unknown configured remote target: ${params.targetId}`);
    if (params.cwd !== target.cwd || params.driver !== target.driver || !sameArgv(params.command, target.command)) {
      throw new RemoteRpcError(-32003, "Run request does not match the trusted configured target");
    }
    const driver = this.#drivers.get(target.driver);
    if (!driver) throw new RemoteRpcError(-32004, `Remote driver is not available: ${target.driver}`);
    const controller = new AbortController();
    this.#startingRuns += 1;
    let handle: RemoteRunHandle | undefined;
    try {
      handle = await driver.start(params, { ...this.journal.identity, target, signal: controller.signal });
    } catch (error) {
      controller.abort();
      if (handle) await handle.close();
      throw error;
    } finally {
      this.#startingRuns -= 1;
    }
    try {
      this.journal.createRun(handle.capture, params);
    } catch (error) {
      controller.abort();
      await handle.close();
      throw error;
    }
    this.#handles.set(handle.capture.runId, handle);
    this.#controllers.set(handle.capture.runId, controller);
    client.subscriptions.set(handle.capture.runId, 0);
    void this.#pump(handle);
    return {
      workerId: handle.capture.workerId,
      instanceNonce: handle.capture.instanceNonce,
      runId: handle.capture.runId,
      generation: handle.capture.generation,
      status: "running",
      firstSequence: 1,
    };
  }

  #attach(client: ClientState, params: RemoteRunAttachParams): RemoteResultByMethod["run/attach"] {
    const record = this.#ownedRun(params);
    if (params.lastSequence > record.snapshot.lastSequence) throw new RemoteRpcError(-32602, "Replay sequence is ahead of the run journal");
    client.subscriptions.set(params.runId, params.lastSequence);
    const events = this.journal.readEvents(params.runId, params.lastSequence);
    for (const event of events) this.#sendRunEvent(client, event);
    return {
      workerId: record.capture.workerId,
      instanceNonce: record.capture.instanceNonce,
      runId: record.capture.runId,
      generation: record.capture.generation,
      status: record.snapshot.status,
      replayFromSequence: events[0]?.sequence ?? record.snapshot.lastSequence + 1,
      lastSequence: record.snapshot.lastSequence,
    };
  }

  async #input(params: RemoteRunInputParams): Promise<RemoteResultByMethod["run/input"]> {
    this.#ownedRun(params);
    const handle = this.#handles.get(params.runId);
    if (!handle) throw new RemoteRpcError(-32004, "Remote run is not active in this daemon instance");
    return handle.input(params);
  }

  async #cancel(params: RemoteRunCancelParams): Promise<RemoteResultByMethod["run/cancel"]> {
    const record = this.#ownedRun(params);
    const handle = this.#handles.get(params.runId);
    if (!handle) return { accepted: false, status: record.snapshot.status };
    return handle.cancel(params);
  }

  #ownedRun(params: { runId: string; generation: number; monitorOwnerNonce: string }) {
    const record = this.journal.getRun(params.runId);
    if (!record
      || record.capture.generation !== params.generation
      || record.capture.monitorOwnerNonce !== params.monitorOwnerNonce) {
      throw new RemoteRpcError(-32003, "Remote run ownership capture mismatch");
    }
    return record;
  }

  async #pump(handle: RemoteRunHandle): Promise<void> {
    try {
      for await (const event of handle.events()) {
        this.journal.appendEvent(handle.capture, event);
        for (const client of this.#clients) this.#sendRunEvent(client, event);
      }
    } catch (error) {
      await Promise.allSettled([
        handle.cancel({
          commandId: `journal-failure-${randomUUID()}`,
          runId: handle.capture.runId,
          generation: handle.capture.generation,
          monitorOwnerNonce: handle.capture.monitorOwnerNonce,
          reason: redactRemoteError(error),
        }),
      ]);
    } finally {
      this.#handles.delete(handle.capture.runId);
      this.#controllers.delete(handle.capture.runId);
    }
  }

  async #idempotent(
    commandId: string,
    method: string,
    params: unknown,
    action: () => Promise<unknown> | unknown,
  ): Promise<NonNullable<RemoteStoredCommand["outcome"]>> {
    const fingerprint = RemoteRunJournal.fingerprint(
      method,
      method === "remote/initialize" ? [params, this.journal.identity.instanceNonce] : params,
    );
    const stored = this.journal.getCommand(commandId);
    if (stored) {
      if (stored.fingerprint !== fingerprint) throw new RemoteRpcError(-32009, "Command id was reused with different parameters");
      if (stored.state === "completed" && stored.outcome) return stored.outcome;
      const inflight = this.#inflightCommands.get(commandId);
      if (inflight?.fingerprint === fingerprint) return inflight.promise;
      throw new RemoteRpcError(-32009, "Command outcome is indeterminate after daemon interruption");
    }
    this.journal.beginCommand(commandId, fingerprint);
    const promise = (async (): Promise<NonNullable<RemoteStoredCommand["outcome"]>> => {
      let outcome: NonNullable<RemoteStoredCommand["outcome"]>;
      try {
        outcome = { ok: true, result: await action() };
      } catch (error) {
        const rpcError = error instanceof RemoteRpcError
          ? error
          : new RemoteRpcError(-32000, redactRemoteError(error));
        outcome = {
          ok: false,
          code: rpcError.code,
          message: redactRemoteError(rpcError.message),
          ...(rpcError.data === undefined ? {} : { data: sanitizeErrorData(rpcError.data) }),
        };
      }
      this.journal.completeCommand(commandId, fingerprint, outcome);
      return outcome;
    })();
    this.#inflightCommands.set(commandId, { fingerprint, promise });
    try { return await promise; } finally {
      if (this.#inflightCommands.get(commandId)?.promise === promise) this.#inflightCommands.delete(commandId);
    }
  }

  #validateParams(method: RemoteRequestMethod, raw: Record<string, unknown>): unknown {
    switch (method) {
      case "remote/initialize": {
        if (!Array.isArray(raw.protocolVersions) || raw.protocolVersions.length > 8
          || raw.protocolVersions.some((version) => typeof version !== "string" || Buffer.byteLength(version) > 64)) {
          throw new RemoteRpcError(-32602, "Invalid protocolVersions");
        }
        return {
          commandId: validateCommandId(raw.commandId),
          protocolVersions: [...raw.protocolVersions],
          monitorOwnerNonce: validateOwner(raw.monitorOwnerNonce),
        };
      }
      case "run/start": {
        if (!Array.isArray(raw.command) || raw.command.length < 1 || raw.command.length > 64
          || raw.command.some((argument) => typeof argument !== "string" || !argument || argument.includes("\0") || Buffer.byteLength(argument) > 8192)) {
          throw new RemoteRpcError(-32602, "Invalid trusted command argv");
        }
        const outputSchema = raw.outputSchema;
        if (outputSchema !== undefined && Buffer.byteLength(JSON.stringify(outputSchema), "utf8") > REMOTE_MAX_OBJECTIVE_BYTES) {
          throw new RemoteRpcError(-32602, "Output schema exceeds the protocol limit");
        }
        return {
          commandId: validateCommandId(raw.commandId),
          targetId: boundedString(raw.targetId, "targetId", 128),
          monitorOwnerNonce: validateOwner(raw.monitorOwnerNonce),
          name: boundedString(raw.name, "name", 1024),
          objective: boundedString(raw.objective, "objective", REMOTE_MAX_OBJECTIVE_BYTES),
          cwd: boundedString(raw.cwd, "cwd", 4096),
          driver: raw.driver === "pi-rpc" || raw.driver === "acp" ? raw.driver : (() => { throw new RemoteRpcError(-32602, "Invalid driver"); })(),
          command: [...raw.command] as [string, ...string[]],
          ...(outputSchema === undefined ? {} : { outputSchema }),
        };
      }
      case "run/attach":
        return {
          commandId: validateCommandId(raw.commandId),
          runId: boundedString(raw.runId, "runId", REMOTE_MAX_ID_LENGTH),
          generation: positiveInteger(raw.generation, "generation"),
          monitorOwnerNonce: validateOwner(raw.monitorOwnerNonce),
          lastSequence: positiveInteger(raw.lastSequence, "lastSequence", true),
        };
      case "run/input":
        return {
          commandId: validateCommandId(raw.commandId),
          runId: boundedString(raw.runId, "runId", REMOTE_MAX_ID_LENGTH),
          generation: positiveInteger(raw.generation, "generation"),
          monitorOwnerNonce: validateOwner(raw.monitorOwnerNonce),
          mode: raw.mode === "steer" || raw.mode === "follow_up" ? raw.mode : (() => { throw new RemoteRpcError(-32602, "Invalid input mode"); })(),
          message: boundedString(raw.message, "message", REMOTE_MAX_OBJECTIVE_BYTES),
        };
      case "run/cancel":
        return {
          commandId: validateCommandId(raw.commandId),
          runId: boundedString(raw.runId, "runId", REMOTE_MAX_ID_LENGTH),
          generation: positiveInteger(raw.generation, "generation"),
          monitorOwnerNonce: validateOwner(raw.monitorOwnerNonce),
          ...(raw.reason === undefined ? {} : { reason: boundedString(raw.reason, "reason", 4096, true) }),
        };
      case "run/list":
        return { commandId: validateCommandId(raw.commandId), monitorOwnerNonce: validateOwner(raw.monitorOwnerNonce) };
    }
  }

  #sendRunEvent(client: ClientState, event: RemoteRunEvent): void {
    const last = client.subscriptions.get(event.runId);
    if (last === undefined || event.sequence <= last) return;
    client.subscriptions.set(event.runId, event.sequence);
    this.#send(client, { jsonrpc: REMOTE_JSONRPC_VERSION, method: event.type, params: event });
  }

  #broadcastHeartbeat(): void {
    const activeRuns = this.#handles.size;
    for (const client of this.#clients) {
      if (!client.monitorOwnerNonce) continue;
      this.#send(client, {
        jsonrpc: REMOTE_JSONRPC_VERSION,
        method: "worker/heartbeat",
        params: {
          type: "worker/heartbeat",
          ...this.journal.identity,
          status: statusForRuns(activeRuns),
          activeRuns,
          concurrency: this.#concurrency,
          timestamp: Date.now(),
        },
      });
    }
  }

  #send(client: ClientState, envelope: RemoteJsonRpcEnvelope): void {
    if (client.closed) return;
    let encoded: string;
    try {
      encoded = encodeRemoteEnvelope(envelope);
    } catch (error) {
      redactRemoteError(error);
      this.#disconnectClient(client);
      return;
    }
    const bytes = Buffer.byteLength(encoded, "utf8");
    client.egressBytes += bytes;
    if (client.egressBytes > this.#clientEgressBytes) {
      this.#disconnectClient(client);
      return;
    }
    client.writeTail = client.writeTail
      .then(() => new Promise<void>((resolve, reject) => {
        if (client.closed || client.socket.destroyed || !client.socket.writable) {
          client.egressBytes = Math.max(0, client.egressBytes - bytes);
          resolve();
          return;
        }
        client.socket.write(encoded, (error?: Error | null) => {
          client.egressBytes = Math.max(0, client.egressBytes - bytes);
          if (error) reject(error);
          else resolve();
        });
      }))
      .catch((error: unknown) => {
        redactRemoteError(error);
        this.#disconnectClient(client);
      });
  }

  #sendFailure(client: ClientState, id: RemoteJsonRpcId | null, code: number, message: string, data?: unknown): void {
    const failure: RemoteJsonRpcFailure = {
      jsonrpc: REMOTE_JSONRPC_VERSION,
      id,
      error: {
        code,
        message: redactRemoteError(message, { maximumBytes: 4096 }),
        ...(data === undefined ? {} : { data: sanitizeErrorData(data) }),
      },
    };
    this.#send(client, failure);
  }

  #disconnectClient(client: ClientState, destroy = true): void {
    if (!client.closed) {
      client.closed = true;
      client.subscriptions.clear();
      client.egressBytes = 0;
      this.#clients.delete(client);
    }
    if (destroy && !client.socket.destroyed) client.socket.destroy();
  }

  #isRequestMethod(method: string): method is RemoteRequestMethod {
    return method === "remote/initialize"
      || method === "run/start"
      || method === "run/attach"
      || method === "run/input"
      || method === "run/cancel"
      || method === "run/list";
  }

  async #removeStaleSocket(): Promise<void> {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(this.socketPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!stat.isSocket() || stat.isSymbolicLink()) throw new Error(`Refusing to replace non-socket daemon path: ${this.socketPath}`);
    const live = await new Promise<boolean>((resolve, reject) => {
      const probe = net.createConnection(this.socketPath);
      probe.once("connect", () => { probe.destroy(); resolve(true); });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
        else reject(error);
      });
    });
    if (live) throw new Error("Remote bridge daemon is already running");
    fs.rmSync(this.socketPath);
  }

  #unlinkOwnedSocket(): void {
    if (process.platform === "win32" || !this.#socketIdentity) return;
    try {
      const stat = fs.lstatSync(this.socketPath);
      if (stat.isSocket() && stat.dev === this.#socketIdentity.dev && stat.ino === this.#socketIdentity.ino) fs.rmSync(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function connectRemoteSocket(stateDirectory = getRemoteStateDirectory()): Promise<net.Socket> {
  const socketPath = getRemoteSocketPath(stateDirectory);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => { socket.off("error", reject); resolve(socket); });
    socket.once("error", reject);
  });
}

export function relayBoundedRemoteStream(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const decoder = new BoundedLineDecoder((line) => {
      if (!output.write(line)) input.pause();
    });
    output.on("drain", () => input.resume());
    input.on("data", (chunk: Buffer | string) => {
      try { decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); } catch (error) { reject(error); }
    });
    input.on("end", () => {
      try { decoder.end(); resolve(); } catch (error) { reject(error); }
    });
    input.on("error", reject);
    output.on("error", reject);
  });
}
