import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "ssh2";
import type { RemoteConnection, RemoteConnectionFactory } from "./driver.ts";
import {
  REMOTE_MAX_LINE_BYTES,
  createRemoteRequest,
  encodeRemoteEnvelope,
  parseRemoteEnvelopeLine,
  type RemoteInitializeParams,
  type RemoteInitializeResult,
  type RemoteJsonRpcEnvelope,
  type RemoteJsonRpcId,
  type RemoteProtocolNotification,
  type RemoteRequestMethod,
  type RemoteRequestParamsByMethod,
  type RemoteResultByMethod,
  type RemoteRunAttachParams,
  type RemoteRunAttachResult,
  type RemoteRunCancelParams,
  type RemoteRunCancelResult,
  type RemoteRunInputParams,
  type RemoteRunInputResult,
  type RemoteRunListResult,
  type RemoteRunStartParams,
  type RemoteRunStartResult,
} from "./protocol.ts";
import type {
  RemoteHostConfig,
  RemoteStatus,
  RemoteWorkerIdentity,
  ResolvedRemoteTarget,
} from "./types.ts";

export const REMOTE_GATEWAY_COMMAND = "pi-teammate-remote connect --stdio" as const;
export const SSH_DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const SSH_DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
export const SSH_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const SSH_DEFAULT_KEEPALIVE_MS = 10_000;
export const SSH_DEFAULT_KEEPALIVE_COUNT = 3;
export const SSH_DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
export const SSH_DEFAULT_MAX_BUFFERED_OUTPUT_BYTES = 4 * 1024 * 1024;

export type SshTransportErrorCode =
  | "authentication"
  | "connect-timeout"
  | "handshake-timeout"
  | "host-key"
  | "identity"
  | "output-limit"
  | "pool-limit"
  | "protocol"
  | "request-timeout"
  | "transport";

export class SshTransportError extends Error {
  readonly code: SshTransportErrorCode;

  constructor(code: SshTransportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SshTransportError";
    this.code = code;
  }
}

export class RemoteRpcResponseError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RemoteRpcResponseError";
    this.code = code;
    this.data = data;
  }
}

export interface SshClientConnectConfig {
  host: string;
  port: number;
  username: string;
  hostVerifier: (presentedKey: Buffer) => boolean;
  privateKey?: Buffer;
  agent?: string;
  authHandler: readonly ["publickey"] | readonly ["agent"];
  keepaliveInterval: number;
  keepaliveCountMax: number;
  timeout: number;
  readyTimeout: number;
  strictVendor: boolean;
  tryKeyboard: false;
}

export interface SshChannelLike extends NodeJS.ReadWriteStream {
  readonly stderr: NodeJS.ReadableStream;
  destroy(error?: Error): this;
}

export interface SshClientLike {
  connect(config: SshClientConnectConfig): unknown;
  exec(command: string, callback: (error: Error | undefined, channel: SshChannelLike) => void): unknown;
  on(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  once(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  off(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  end(): unknown;
  destroy(): unknown;
}

export interface SshRemoteConnectionFactoryOptions {
  createClient?: () => SshClientLike;
  readIdentityFile?: (filePath: string) => Buffer;
  agentSocket?: string;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  keepaliveCountMax?: number;
  maxConnectionsPerHost?: number;
  maxChannelsPerConnection?: number;
  maxPendingPerHost?: number;
  maxStderrBytes?: number;
  maxBufferedOutputBytes?: number;
}

interface NormalizedSshOptions {
  createClient: () => SshClientLike;
  readIdentityFile: (filePath: string) => Buffer;
  agentSocket?: string;
  connectTimeoutMs: number;
  handshakeTimeoutMs: number;
  requestTimeoutMs: number;
  keepaliveIntervalMs: number;
  keepaliveCountMax: number;
  maxConnectionsPerHost: number;
  maxChannelsPerConnection: number;
  maxPendingPerHost: number;
  maxStderrBytes: number;
  maxBufferedOutputBytes: number;
}

interface PoolSlot {
  client: SshClientLike;
  activeChannels: number;
  closed: boolean;
}

interface PoolLease {
  client: SshClientLike;
  release(): void;
}

interface PendingLease {
  resolve: (lease: PoolLease) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface PendingResponse {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function positiveInteger(value: number | undefined, fallback: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return normalized;
}

function normalizeOptions(options: SshRemoteConnectionFactoryOptions): NormalizedSshOptions {
  const agentSocket = options.agentSocket ?? process.env.SSH_AUTH_SOCK;
  return {
    createClient: options.createClient ?? (() => new Client() as unknown as SshClientLike),
    readIdentityFile: options.readIdentityFile ?? readPrivateIdentityFile,
    ...(agentSocket ? { agentSocket } : {}),
    connectTimeoutMs: positiveInteger(options.connectTimeoutMs, SSH_DEFAULT_CONNECT_TIMEOUT_MS, "SSH connect timeout"),
    handshakeTimeoutMs: positiveInteger(options.handshakeTimeoutMs, SSH_DEFAULT_HANDSHAKE_TIMEOUT_MS, "SSH handshake timeout"),
    requestTimeoutMs: positiveInteger(options.requestTimeoutMs, SSH_DEFAULT_REQUEST_TIMEOUT_MS, "SSH request timeout"),
    keepaliveIntervalMs: positiveInteger(options.keepaliveIntervalMs, SSH_DEFAULT_KEEPALIVE_MS, "SSH keepalive interval"),
    keepaliveCountMax: positiveInteger(options.keepaliveCountMax, SSH_DEFAULT_KEEPALIVE_COUNT, "SSH keepalive count", 100),
    maxConnectionsPerHost: positiveInteger(options.maxConnectionsPerHost, 2, "SSH connections per host", 32),
    maxChannelsPerConnection: positiveInteger(options.maxChannelsPerConnection, 4, "SSH channels per connection", 128),
    maxPendingPerHost: positiveInteger(options.maxPendingPerHost, 64, "SSH pending requests per host", 4096),
    maxStderrBytes: positiveInteger(options.maxStderrBytes, SSH_DEFAULT_MAX_STDERR_BYTES, "SSH stderr limit"),
    maxBufferedOutputBytes: positiveInteger(
      options.maxBufferedOutputBytes,
      SSH_DEFAULT_MAX_BUFFERED_OUTPUT_BYTES,
      "SSH buffered output limit",
    ),
  };
}

export function expandIdentityPath(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) return path.join(os.homedir(), filePath.slice(2));
  return path.resolve(filePath);
}

export function readPrivateIdentityFile(filePath: string): Buffer {
  const resolved = expandIdentityPath(filePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1024 * 1024) {
    throw new SshTransportError("identity", "SSH identity reference is not a bounded regular file");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new SshTransportError("identity", "SSH identity file permissions must deny group and other access");
  }
  return fs.readFileSync(resolved);
}

function normalizedFingerprint(value: string): string {
  return value.slice("SHA256:".length).replace(/=+$/, "");
}

/** Creates a fail-closed verifier for the OpenSSH SHA256 host-key fingerprint form. */
export function createPinnedHostKeyVerifier(expectedFingerprint: string): (presentedKey: Buffer) => boolean {
  if (!/^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/.test(expectedFingerprint)) {
    throw new SshTransportError("host-key", "Invalid configured SSH host-key fingerprint");
  }
  const expected = Buffer.from(normalizedFingerprint(expectedFingerprint), "utf8");
  return (presentedKey: Buffer): boolean => {
    const actual = Buffer.from(createHash("sha256").update(presentedKey).digest("base64").replace(/=+$/, ""), "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
}

function hostPoolKey(host: RemoteHostConfig): string {
  return JSON.stringify([host.host, host.port, host.user, host.hostKeySha256, host.identityFile ?? "agent"]);
}

function validateTarget(target: ResolvedRemoteTarget): void {
  if (!path.posix.isAbsolute(target.cwd) || target.cwd.includes("\0")) {
    throw new SshTransportError("protocol", "Configured remote target cwd must be an absolute POSIX path");
  }
  if (target.command.length < 1 || target.command.some((argument) => !argument || argument.includes("\0"))) {
    throw new SshTransportError("protocol", "Configured remote target command argv is invalid");
  }
  if (!target.hostConfig.host || !target.hostConfig.user || !Number.isInteger(target.hostConfig.port)) {
    throw new SshTransportError("protocol", "Configured remote SSH host is invalid");
  }
}

function abortError(): Error {
  const error = new Error("SSH connection request was aborted");
  error.name = "AbortError";
  return error;
}

class HostConnectionPool {
  readonly #host: RemoteHostConfig;
  readonly #options: NormalizedSshOptions;
  readonly #slots: PoolSlot[] = [];
  readonly #pending: PendingLease[] = [];
  #connecting = 0;
  #closed = false;

  constructor(host: RemoteHostConfig, options: NormalizedSshOptions) {
    this.#host = host;
    this.#options = options;
  }

  acquire(signal?: AbortSignal): Promise<PoolLease> {
    if (this.#closed) return Promise.reject(new SshTransportError("transport", "SSH host pool is closed"));
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.#pending.length >= this.#options.maxPendingPerHost) {
      return Promise.reject(new SshTransportError("pool-limit", "SSH host pool pending limit reached"));
    }
    return new Promise<PoolLease>((resolve, reject) => {
      const pending: PendingLease = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        pending.onAbort = () => {
          const index = this.#pending.indexOf(pending);
          if (index >= 0) this.#pending.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.#pending.push(pending);
      this.#drain();
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.splice(0)) {
      this.#cleanupPending(pending);
      pending.reject(new SshTransportError("transport", "SSH host pool closed before admission"));
    }
    for (const slot of this.#slots.splice(0)) {
      slot.closed = true;
      slot.client.end();
    }
  }

  #drain(): void {
    if (this.#closed) return;
    while (this.#pending.length > 0) {
      const slot = this.#slots.find((candidate) => !candidate.closed
        && candidate.activeChannels < this.#options.maxChannelsPerConnection);
      if (slot) {
        const pending = this.#pending.shift()!;
        if (pending.signal?.aborted) {
          this.#cleanupPending(pending);
          pending.reject(abortError());
          continue;
        }
        slot.activeChannels += 1;
        this.#cleanupPending(pending);
        pending.resolve(this.#lease(slot));
        continue;
      }
      if (this.#slots.length + this.#connecting >= this.#options.maxConnectionsPerHost) return;
      const pending = this.#pending.shift()!;
      if (pending.signal?.aborted) {
        this.#cleanupPending(pending);
        pending.reject(abortError());
        continue;
      }
      this.#cleanupPending(pending);
      this.#connecting += 1;
      void this.#openSlot().then((created) => {
        this.#connecting -= 1;
        if (this.#closed) {
          created.client.end();
          pending.reject(new SshTransportError("transport", "SSH host pool closed during setup"));
          return;
        }
        created.activeChannels = 1;
        this.#slots.push(created);
        pending.resolve(this.#lease(created));
        this.#drain();
      }, (error: unknown) => {
        this.#connecting -= 1;
        pending.reject(error instanceof Error ? error : new Error(String(error)));
        this.#drain();
      });
    }
  }

  #lease(slot: PoolSlot): PoolLease {
    let released = false;
    return {
      client: slot.client,
      release: () => {
        if (released) return;
        released = true;
        slot.activeChannels = Math.max(0, slot.activeChannels - 1);
        this.#drain();
      },
    };
  }

  #cleanupPending(pending: PendingLease): void {
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
  }

  async #openSlot(): Promise<PoolSlot> {
    const client = this.#options.createClient();
    const slot: PoolSlot = { client, activeChannels: 0, closed: false };
    await connectSshClient(client, this.#host, this.#options);
    client.on("error", () => client.destroy());
    client.once("close", () => {
      slot.closed = true;
      const index = this.#slots.indexOf(slot);
      if (index >= 0) this.#slots.splice(index, 1);
      this.#drain();
    });
    return slot;
  }
}

function connectSshClient(
  client: SshClientLike,
  host: RemoteHostConfig,
  options: NormalizedSshOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let connected = false;
    let hostKeyRejected = false;
    let connectTimer: NodeJS.Timeout | undefined;
    let handshakeTimer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (handshakeTimer) clearTimeout(handshakeTimer);
      client.off("connect", onConnect);
      client.off("ready", onReady);
      client.off("error", onError);
      client.off("close", onClose);
      if (error) {
        client.destroy();
        reject(error);
      } else resolve();
    };
    const onConnect = () => {
      connected = true;
      if (connectTimer) clearTimeout(connectTimer);
      handshakeTimer = setTimeout(() => finish(new SshTransportError(
        "handshake-timeout",
        "Timed out during SSH handshake and authentication",
      )), options.handshakeTimeoutMs);
      handshakeTimer.unref?.();
    };
    const onReady = () => finish();
    const onError = (error: unknown) => finish(new SshTransportError(
      hostKeyRejected ? "host-key" : "transport",
      hostKeyRejected ? "Configured SSH host key fingerprint did not match" : "SSH connection or authentication failed",
      { cause: error },
    ));
    const onClose = () => finish(new SshTransportError(
      hostKeyRejected ? "host-key" : (connected ? "transport" : "connect-timeout"),
      hostKeyRejected
        ? "Configured SSH host key fingerprint did not match"
        : (connected ? "SSH connection closed during setup" : "SSH connection closed before transport setup"),
    ));
    client.once("connect", onConnect);
    client.once("ready", onReady);
    client.once("error", onError);
    client.once("close", onClose);
    connectTimer = setTimeout(() => finish(new SshTransportError(
      "connect-timeout",
      "Timed out connecting to configured SSH host",
    )), options.connectTimeoutMs);
    connectTimer.unref?.();

    try {
      const privateKey = host.identityFile ? options.readIdentityFile(host.identityFile) : undefined;
      if (!privateKey && !options.agentSocket) throw new SshTransportError(
        "authentication",
        "Configured SSH host requires an identity-file reference or an available ssh-agent",
      );
      const verifyHostKey = createPinnedHostKeyVerifier(host.hostKeySha256);
      client.connect({
        host: host.host,
        port: host.port,
        username: host.user,
        hostVerifier: (key: Buffer) => {
          const accepted = verifyHostKey(key);
          hostKeyRejected = !accepted;
          return accepted;
        },
        ...(privateKey ? { privateKey, authHandler: ["publickey" as const] } : {
          agent: options.agentSocket,
          authHandler: ["agent" as const],
        }),
        keepaliveInterval: options.keepaliveIntervalMs,
        keepaliveCountMax: options.keepaliveCountMax,
        timeout: options.connectTimeoutMs,
        readyTimeout: options.handshakeTimeoutMs,
        strictVendor: true,
        tryKeyboard: false,
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
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
      if (newline > REMOTE_MAX_LINE_BYTES) throw new SshTransportError("output-limit", "Remote gateway record exceeds limit");
      const line = this.#buffer.subarray(0, newline + 1).toString("utf8");
      this.#buffer = this.#buffer.subarray(newline + 1);
      this.#onLine(line);
    }
    if (this.#buffer.length > REMOTE_MAX_LINE_BYTES) {
      throw new SshTransportError("output-limit", "Remote gateway record exceeds limit");
    }
  }

  end(): void {
    if (this.#buffer.length > 0) throw new SshTransportError("protocol", "Remote gateway ended with an incomplete record");
  }
}

class BoundedAsyncQueue<T> implements AsyncIterable<T> {
  readonly #limit: number;
  readonly #items: Array<{ value: T; bytes: number }> = [];
  readonly #waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  #bytes = 0;
  #ended = false;
  #error?: Error;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(value: T, bytes: number): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }
    if (this.#bytes + bytes > this.#limit) {
      throw new SshTransportError("output-limit", "Remote notification buffer exceeded limit");
    }
    this.#items.push({ value, bytes });
    this.#bytes += bytes;
  }

  end(error?: Error): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item) {
          this.#bytes -= item.bytes;
          return Promise.resolve({ value: item.value, done: false });
        }
        if (this.#ended) {
          return this.#error
            ? Promise.reject(this.#error)
            : Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}

class SshRemoteConnection implements RemoteConnection {
  readonly #stream: SshChannelLike;
  readonly #release: () => void;
  readonly #requestTimeoutMs: number;
  readonly #maxStderrBytes: number;
  readonly #notifications: BoundedAsyncQueue<RemoteProtocolNotification>;
  readonly #pending = new Map<RemoteJsonRpcId, PendingResponse>();
  readonly #decoder: BoundedLineDecoder;
  #status: RemoteStatus = "connecting";
  #identity?: RemoteWorkerIdentity;
  #stderrBytes = 0;
  #exitCode?: number;
  #closed = false;
  #released = false;
  #writeTail = Promise.resolve();
  #closedPromise: Promise<void>;
  #resolveClosed!: () => void;

  constructor(stream: SshChannelLike, release: () => void, options: NormalizedSshOptions) {
    this.#stream = stream;
    this.#release = release;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#maxStderrBytes = options.maxStderrBytes;
    this.#notifications = new BoundedAsyncQueue(options.maxBufferedOutputBytes);
    this.#decoder = new BoundedLineDecoder((line) => this.#handleEnvelope(parseRemoteEnvelopeLine(line), Buffer.byteLength(line)));
    this.#closedPromise = new Promise((resolve) => { this.#resolveClosed = resolve; });
    stream.on("data", (chunk: Buffer | string) => {
      try { this.#decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); }
      catch (error) { this.#fail(error instanceof Error ? error : new Error(String(error))); }
    });
    stream.stderr.on("data", (chunk: Buffer | string) => {
      this.#stderrBytes += Buffer.byteLength(chunk);
      if (this.#stderrBytes > this.#maxStderrBytes) {
        this.#fail(new SshTransportError("output-limit", "Remote gateway stderr exceeded limit"));
      }
    });
    stream.once("exit", (code: number) => { this.#exitCode = code; });
    stream.once("close", () => this.#finalize(this.#closed
      ? undefined
      : new SshTransportError("transport", this.#exitCode
        ? `Remote gateway exited with status ${this.#exitCode}`
        : "Remote gateway disconnected")));
    stream.once("error", (error: Error) => this.#fail(new SshTransportError(
      "transport",
      "Remote gateway stream failed",
      { cause: error },
    )));
  }

  get status(): RemoteStatus { return this.#status; }
  get identity(): RemoteWorkerIdentity | undefined { return this.#identity; }

  async initialize(params: RemoteInitializeParams): Promise<RemoteInitializeResult> {
    const result = await this.request("remote/initialize", params);
    this.#identity = Object.freeze({ workerId: result.workerId, instanceNonce: result.instanceNonce });
    this.#status = result.status;
    return result;
  }

  async request<Method extends RemoteRequestMethod>(
    method: Method,
    params: RemoteRequestParamsByMethod[Method],
  ): Promise<RemoteResultByMethod[Method]> {
    if (this.#closed) throw new SshTransportError("transport", "Remote gateway connection is closed");
    const id = `ssh-rpc-${randomUUID()}`;
    const response = new Promise<RemoteResultByMethod[Method]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new SshTransportError("request-timeout", `Timed out waiting for remote ${method} response`));
      }, this.#requestTimeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve: (value) => resolve(value as RemoteResultByMethod[Method]), reject, timer });
    });
    try {
      const encoded = encodeRemoteEnvelope(createRemoteRequest(id, method, params));
      this.#writeTail = this.#writeTail.then(async () => {
        if (this.#closed) throw new SshTransportError("transport", "Remote gateway connection is closed");
        if (!this.#stream.write(encoded)) {
          await new Promise<void>((resolve) => this.#stream.once("drain", resolve));
        }
      });
      await this.#writeTail;
      return await response;
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
  }

  start(params: RemoteRunStartParams): Promise<RemoteRunStartResult> { return this.request("run/start", params); }
  attach(params: RemoteRunAttachParams): Promise<RemoteRunAttachResult> { return this.request("run/attach", params); }
  input(params: RemoteRunInputParams): Promise<RemoteRunInputResult> { return this.request("run/input", params); }
  cancel(params: RemoteRunCancelParams): Promise<RemoteRunCancelResult> { return this.request("run/cancel", params); }
  list(commandId: string, monitorOwnerNonce: string): Promise<RemoteRunListResult> {
    return this.request("run/list", { commandId, monitorOwnerNonce });
  }
  notifications(): AsyncIterable<RemoteProtocolNotification> { return this.#notifications; }

  async close(): Promise<void> {
    if (this.#closed) return this.#closedPromise;
    this.#closed = true;
    this.#stream.end();
    const timer = setTimeout(() => this.#stream.destroy(), 1_000);
    timer.unref?.();
    await this.#closedPromise;
    clearTimeout(timer);
  }

  #handleEnvelope(envelope: RemoteJsonRpcEnvelope, bytes: number): void {
    if ("id" in envelope) {
      if ("method" in envelope) throw new SshTransportError("protocol", "Remote gateway sent an unexpected request");
      if (envelope.id === null) throw new SshTransportError("protocol", "Remote gateway returned an uncorrelated response");
      const pending = this.#pending.get(envelope.id);
      if (!pending) return;
      this.#pending.delete(envelope.id);
      clearTimeout(pending.timer);
      if ("error" in envelope) pending.reject(new RemoteRpcResponseError(
        envelope.error.code,
        envelope.error.message,
        envelope.error.data,
      ));
      else pending.resolve(envelope.result);
      return;
    }
    if (envelope.method !== "run/state"
      && envelope.method !== "run/event"
      && envelope.method !== "run/result"
      && envelope.method !== "worker/heartbeat") {
      throw new SshTransportError("protocol", `Unknown remote notification method: ${envelope.method}`);
    }
    this.#notifications.push(envelope as RemoteProtocolNotification, bytes);
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#finalize(error);
    this.#stream.destroy();
  }

  #finalize(error?: Error): void {
    if (!this.#released) {
      this.#released = true;
      this.#release();
    }
    this.#status = "disconnected";
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new SshTransportError("transport", "Remote gateway connection closed"));
    }
    this.#pending.clear();
    try { this.#decoder.end(); } catch (decodeError) { error ??= decodeError as Error; }
    this.#notifications.end(error);
    this.#resolveClosed();
  }
}

async function execGateway(client: SshClientLike): Promise<SshChannelLike> {
  return new Promise((resolve, reject) => {
    client.exec(REMOTE_GATEWAY_COMMAND, (error, stream) => {
      if (error) reject(new SshTransportError("transport", "Failed to launch fixed remote gateway", { cause: error }));
      else resolve(stream);
    });
  });
}

/** Pooled SSH factory for configured POSIX remote targets. */
export class SshRemoteConnectionFactory implements RemoteConnectionFactory {
  readonly #options: NormalizedSshOptions;
  readonly #pools = new Map<string, HostConnectionPool>();
  #closed = false;

  constructor(options: SshRemoteConnectionFactoryOptions = {}) {
    this.#options = normalizeOptions(options);
  }

  async connect(target: ResolvedRemoteTarget, signal?: AbortSignal): Promise<RemoteConnection> {
    if (this.#closed) throw new SshTransportError("transport", "SSH connection factory is closed");
    validateTarget(target);
    const key = hostPoolKey(target.hostConfig);
    let pool = this.#pools.get(key);
    if (!pool) {
      pool = new HostConnectionPool(target.hostConfig, this.#options);
      this.#pools.set(key, pool);
    }
    const lease = await pool.acquire(signal);
    try {
      const stream = await execGateway(lease.client);
      return new SshRemoteConnection(stream, lease.release, this.#options);
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const pool of this.#pools.values()) pool.close();
    this.#pools.clear();
  }
}
