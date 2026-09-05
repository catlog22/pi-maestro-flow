import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { ClientChannel } from "ssh2";
import {
  DEFAULT_SSH_TIMEOUT_SECONDS,
  type SshCommandChannel,
  type SshExecutor,
} from "./executor.ts";
import { SSH_GATEWAY_COMMAND } from "./guide.ts";
import {
  GatewaySessionLauncher,
  type SshStartPiInput,
} from "./gateway-session-launch.ts";
import type { TodoTask } from "../tools/todo.ts";
import type { SshGatewayBinding, SshHost } from "./model.ts";

const DEFAULT_POOL_SIZE = 4;
const MAX_STDIO_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;

export type SshGatewayInput =
  | { action: "guide" }
  | { action: "status" }
  | { action: "list" }
  | { action: "describe"; tool: string }
  | { action: "call"; tool: string; args?: Record<string, unknown>; timeout?: number }
  | SshStartPiInput;

export interface SshGatewayStartPiContext {
  readonly piSessionRef: string;
  readonly todos: readonly TodoTask[];
}

export interface SshGatewayActionResult {
  readonly action: SshGatewayInput["action"];
  readonly tool?: string;
  readonly data: unknown;
  readonly text: string;
  readonly isError?: boolean;
  readonly summary: string;
  readonly durationMs: number;
}

export class SshGatewayCapabilityError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      `Pi Maestro Gateway is unavailable on the selected SSH server. Install and start it there, then verify \`${SSH_GATEWAY_COMMAND}\`. No shell fallback was attempted.`,
      options,
    );
    this.name = "SshGatewayCapabilityError";
  }
}

interface GatewayPoolEntry {
  readonly key: string;
  readonly hostId: string;
  readonly client: Client;
  readonly transport: Transport;
  readonly mode: "https" | "stdio";
}

export interface SshGatewayBindingSource {
  getGatewayBinding(hostId: string): SshGatewayBinding | undefined;
}

export interface SshGatewayClientPoolOptions {
  maxEntries?: number;
  bindingSource?: SshGatewayBindingSource;
  fetch?: typeof fetch;
  now?: () => number;
}

/** A bounded pool of initialized MCP clients, isolated by SSH host id and full host digest. */
export class SshGatewayClientPool {
  private readonly entries = new Map<string, Promise<GatewayPoolEntry>>();
  private readonly launches = new GatewaySessionLauncher();
  private readonly hostFences = new Map<string, string>();
  private readonly hostEpochs = new Map<string, number>();
  private poolEpoch = 0;
  private readonly maxEntries: number;
  private readonly bindingSource?: SshGatewayBindingSource;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly executor: Pick<SshExecutor, "openChannel">,
    options: SshGatewayClientPoolOptions = {},
  ) {
    const maxEntries = options.maxEntries ?? DEFAULT_POOL_SIZE;
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 32) {
      throw new Error("SSH Gateway client pool size must be an integer between 1 and 32");
    }
    this.maxEntries = maxEntries;
    this.bindingSource = options.bindingSource;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.entries.size;
  }

  async execute(
    host: SshHost,
    effectiveDigest: string,
    input: Exclude<SshGatewayInput, { action: "guide" }>,
    signal?: AbortSignal,
    startPiContext?: SshGatewayStartPiContext,
    cacheFence = effectiveDigest,
  ): Promise<SshGatewayActionResult> {
    const startedAt = Date.now();
    const timeoutSeconds = input.action === "call" || input.action === "start_pi"
      ? input.timeout ?? DEFAULT_SSH_TIMEOUT_SECONDS
      : DEFAULT_SSH_TIMEOUT_SECONDS;
    const requestOptions = {
      signal,
      timeout: timeoutSeconds * 1000,
      maxTotalTimeout: timeoutSeconds * 1000,
    };
    let entry = await this.acquire(host, effectiveDigest, cacheFence, timeoutSeconds, signal);
    let reconnects = 0;
    const invoke = async <T>(operation: (client: Client) => Promise<T>): Promise<T> => {
      try { return await operation(entry.client); }
      catch (error) {
        if (entry.mode !== "https" || reconnects >= 1 || !isHttpSessionLoss(error)) throw error;
        reconnects += 1;
        await this.retireEntry(entry);
        entry = await this.acquire(host, effectiveDigest, cacheFence, timeoutSeconds, signal);
        try { return await operation(entry.client); }
        catch (retryError) {
          if (entry.mode !== "https" || !isTransientServerFailure(retryError)) throw retryError;
          await this.retireEntry(entry);
          entry = await this.publishStdioReplacement(host, effectiveDigest, cacheFence, timeoutSeconds, signal);
          return operation(entry.client);
        }
      }
    };
    const callGateway = (tool: string, args: Record<string, unknown>, timeout: number, requestSignal?: AbortSignal) => invoke((client) => client.callTool(
      { name: tool, arguments: args }, undefined,
      { signal: requestSignal, timeout: timeout * 1000, maxTotalTimeout: timeout * 1000 },
    ));
    let data: unknown;
    let isError = false;
    let summary: string;

    if (input.action === "start_pi") {
      if (!startPiContext) throw new Error("start_pi requires the current host Pi session context");
      data = await this.launches.start(
        async (tool, args, timeout, requestSignal) => decodeGatewayEnvelope(await callGateway(tool, args, timeout, requestSignal)),
        host.id, cacheFence, startPiContext.piSessionRef, startPiContext.todos, input, signal,
      );
      summary = `Pi execution ${(data as { executionHandle: string }).executionHandle} · monitor ready`;
    } else if (input.action === "status") {
      const listed = await invoke((client) => client.listTools({}, requestOptions));
      data = { connected: true, command: SSH_GATEWAY_COMMAND, server: entry.client.getServerVersion(), tools: listed.tools.map((tool) => tool.name) };
      summary = `gateway connected · ${listed.tools.length} tools`;
    } else if (input.action === "list") {
      const listed = await invoke((client) => client.listTools({}, requestOptions));
      data = { tools: listed.tools };
      summary = `${listed.tools.length} gateway tools`;
    } else if (input.action === "describe") {
      const listed = await invoke((client) => client.listTools({}, requestOptions));
      const tool = listed.tools.find((candidate) => candidate.name === input.tool);
      if (!tool) throw new Error(`Gateway tool ${JSON.stringify(input.tool)} is not available`);
      data = tool;
      summary = `gateway tool ${input.tool}`;
    } else {
      const prepared = input.tool === "monitor" ? this.launches.prepareMonitorCall(host.id, cacheFence, input.args ?? {}) : { args: input.args ?? {}, record: undefined };
      if (input.tool === "monitor" && prepared.record) {
        await this.launches.refreshMonitorLease(async (tool, args, timeout, requestSignal) => decodeGatewayEnvelope(await callGateway(tool, args, timeout, requestSignal)), prepared.record, timeoutSeconds, signal);
      }
      const result = await invoke((client) => client.callTool({ name: input.tool, arguments: prepared.args }, undefined, requestOptions));
      data = result;
      isError = result.isError === true;
      if (!isError && input.tool === "monitor") this.launches.updateMonitorCursor(prepared.record, decodeGatewayEnvelope(result));
      summary = `${input.tool} · ${isError ? "failed" : "completed"}`;
    }

    return {
      action: input.action,
      ...(input.action === "describe" || input.action === "call" ? { tool: input.tool } : {}),
      data,
      text: JSON.stringify(data, null, 2),
      ...(isError ? { isError: true } : {}),
      summary,
      durationMs: Date.now() - startedAt,
    };
  }

  async invalidateHost(hostId: string): Promise<void> {
    this.hostEpochs.set(hostId, (this.hostEpochs.get(hostId) ?? 0) + 1);
    this.launches.invalidateHost(hostId);
    this.hostFences.delete(hostId);
    const prefix = `${hostId}\0`;
    const matches = [...this.entries.entries()].filter(([key]) => key.startsWith(prefix));
    for (const [key] of matches) this.entries.delete(key);
    await this.closePending(matches.map(([, pending]) => pending));
  }

  async close(): Promise<void> {
    this.poolEpoch += 1;
    const pending = [...this.entries.values()];
    this.entries.clear();
    this.launches.clear();
    this.hostFences.clear();
    await this.closePending(pending);
  }

  private async acquire(
    host: SshHost,
    effectiveDigest: string,
    cacheFence: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<GatewayPoolEntry> {
    const key = poolKey(host.id, cacheFence);
    const existing = this.entries.get(key);
    if (existing) return existing;

    const retired: Promise<GatewayPoolEntry>[] = [];
    const previousFence = this.hostFences.get(host.id);
    if (previousFence !== undefined && previousFence !== cacheFence) {
      this.hostEpochs.set(host.id, (this.hostEpochs.get(host.id) ?? 0) + 1);
      this.launches.invalidateHost(host.id);
      const prefix = `${host.id}\0`;
      for (const [staleKey, stale] of this.entries) {
        if (!staleKey.startsWith(prefix)) continue;
        this.entries.delete(staleKey);
        retired.push(stale);
      }
    }
    this.hostFences.set(host.id, cacheFence);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.entries().next().value as [string, Promise<GatewayPoolEntry>] | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      retired.push(oldest[1]);
    }

    const hostEpoch = this.hostEpochs.get(host.id) ?? 0;
    const poolEpoch = this.poolEpoch;
    let pending!: Promise<GatewayPoolEntry>;
    pending = this.createAdmittedEntry(
      key,
      host,
      effectiveDigest,
      timeoutSeconds,
      retired,
      () => this.entries.get(key) === pending
        && this.poolEpoch === poolEpoch
        && (this.hostEpochs.get(host.id) ?? 0) === hostEpoch,
      signal,
    );
    this.entries.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.entries.get(key) === pending) this.entries.delete(key);
      if (signal?.aborted) throw error;
      throw new SshGatewayCapabilityError({ cause: error });
    }
  }

  private async createAdmittedEntry(
    key: string,
    host: SshHost,
    effectiveDigest: string,
    timeoutSeconds: number,
    retired: readonly Promise<GatewayPoolEntry>[],
    isCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<GatewayPoolEntry> {
    await this.closePending(retired);
    if (!isCurrent()) throw new Error("SSH Gateway client admission was invalidated");
    const entry = await this.createEntry(key, host, effectiveDigest, timeoutSeconds, signal);
    if (isCurrent()) return entry;
    await entry.client.close().catch(() => undefined);
    throw new Error("SSH Gateway client admission was invalidated");
  }

  private async createEntry(
    key: string,
    host: SshHost,
    effectiveDigest: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<GatewayPoolEntry> {
    const binding = this.bindingSource?.getGatewayBinding(host.id);
    if (!binding) return this.createStdioEntry(key, host, effectiveDigest, timeoutSeconds, signal);
    if (binding.effectiveHostDigest !== effectiveDigest) throw new Error("SSH Gateway binding no longer matches the effective host configuration");
    if (binding.expiresAt <= this.now()) throw new Error("SSH Gateway pairing has expired");
    try {
      return await this.createHttpEntry(key, host.id, binding, timeoutSeconds, signal);
    } catch (error) {
      if (!allowsStdioFallback(error)) throw error;
      return this.createStdioEntry(key, host, effectiveDigest, timeoutSeconds, signal);
    }
  }

  private async createHttpEntry(key: string, hostId: string, binding: SshGatewayBinding, timeoutSeconds: number, signal?: AbortSignal): Promise<GatewayPoolEntry> {
    const requestController = new AbortController();
    const abort = (): void => requestController.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => requestController.abort(new Error("Gateway HTTPS request timed out")), timeoutSeconds * 1000);
    let transport!: StreamableHTTPClientTransport;
    const classifiedFetch: typeof fetch = async (input, init) => {
      try {
        const requestSignal = init?.signal ? AbortSignal.any([requestController.signal, init.signal]) : requestController.signal;
        const response = await this.fetchImpl(input, { ...init, signal: requestSignal });
        if ([401, 403].includes(response.status)) { await response.body?.cancel(); throw new GatewayHttpFailure("auth", response.status); }
        if ([404, 405].includes(response.status) && String(init?.method ?? "GET").toUpperCase() === "POST") { await response.body?.cancel(); throw new GatewayHttpFailure("protocol", response.status); }
        if (response.status >= 500) { await response.body?.cancel(); throw new GatewayHttpFailure("server", response.status); }
        return response;
      } catch (error) {
        if (error instanceof GatewayHttpFailure) throw error;
        throw classifyNetworkFailure(error);
      }
    };
    transport = new StreamableHTTPClientTransport(new URL(binding.endpoint), {
      requestInit: { headers: { authorization: `Bearer ${binding.token}` } },
      fetch: classifiedFetch,
      reconnectionOptions: { initialReconnectionDelay: 100, maxReconnectionDelay: 500, reconnectionDelayGrowFactor: 1, maxRetries: 1 },
    });
    this.bindDisconnect(key, transport);
    const client = new Client({ name: "pi-maestro-flow-ssh", version: "1" });
    try {
      await client.connect(transport, { signal: requestController.signal, timeout: timeoutSeconds * 1000, maxTotalTimeout: timeoutSeconds * 1000 });
      await verifyGatewayIdentity(client, { signal: requestController.signal, timeout: timeoutSeconds * 1000, maxTotalTimeout: timeoutSeconds * 1000 });
      return { key, hostId, client, transport, mode: "https" };
    } catch (error) {
      await client.close().catch(() => transport.close());
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  private async createStdioEntry(key: string, host: SshHost, effectiveDigest: string, timeoutSeconds: number, signal?: AbortSignal): Promise<GatewayPoolEntry> {
    const handle = await this.executor.openChannel(host, { command: SSH_GATEWAY_COMMAND, timeout: timeoutSeconds }, { signal });
    if (handle.effectiveDigest !== undefined && handle.effectiveDigest !== effectiveDigest) {
      handle.close();
      throw new Error("SSH Gateway connection chain changed while opening");
    }
    const transport = new SshGatewayTransport(handle, () => this.dropDisconnected(key, transport));
    const client = new Client({ name: "pi-maestro-flow-ssh", version: "1" });
    try {
      await client.connect(transport, { signal, timeout: timeoutSeconds * 1000, maxTotalTimeout: timeoutSeconds * 1000 });
      await verifyGatewayIdentity(client, { signal, timeout: timeoutSeconds * 1000, maxTotalTimeout: timeoutSeconds * 1000 });
      return { key, hostId: host.id, client, transport, mode: "stdio" };
    } catch (error) {
      await client.close().catch(() => transport.close());
      throw error;
    }
  }

  private bindDisconnect(key: string, transport: Transport): void {
    const prior = transport.onclose;
    transport.onclose = () => { prior?.(); this.dropDisconnected(key, transport); };
  }

  private dropDisconnected(key: string, transport: Transport): void {
    const current = this.entries.get(key);
    if (!current) return;
    void current.then((entry) => {
      if (entry.transport === transport && this.entries.get(key) === current) this.entries.delete(key);
    }, () => { if (this.entries.get(key) === current) this.entries.delete(key); });
  }

  private async retireEntry(entry: GatewayPoolEntry): Promise<void> {
    const pending = this.entries.get(entry.key);
    if (pending) this.entries.delete(entry.key);
    await entry.client.close().catch(() => entry.transport.close());
  }

  private async publishStdioReplacement(host: SshHost, effectiveDigest: string, cacheFence: string, timeoutSeconds: number, signal?: AbortSignal): Promise<GatewayPoolEntry> {
    const key = poolKey(host.id, cacheFence);
    const hostEpoch = this.hostEpochs.get(host.id) ?? 0;
    const poolEpoch = this.poolEpoch;
    const entry = await this.createStdioEntry(key, host, effectiveDigest, timeoutSeconds, signal);
    if (poolEpoch !== this.poolEpoch || hostEpoch !== (this.hostEpochs.get(host.id) ?? 0) || this.entries.has(key)) {
      await entry.client.close().catch(() => undefined);
      throw new Error("SSH Gateway reconnect fallback was invalidated");
    }
    this.entries.set(key, Promise.resolve(entry));
    return entry;
  }

  private async closePending(pending: Iterable<Promise<GatewayPoolEntry>>): Promise<void> {
    const entries = await Promise.all([...pending].map((entry) => entry.catch(() => undefined)));
    await Promise.all(entries.map((entry) => entry?.client.close().catch(() => undefined)));
  }
}

class SshGatewayTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly readBuffer = new ReadBuffer({ maxBufferSize: MAX_STDIO_BUFFER_BYTES });
  private started = false;
  private closed = false;
  private stderrBytes = 0;

  constructor(
    private readonly handle: SshCommandChannel,
    private readonly onDisconnect: () => void,
  ) {}

  async start(): Promise<void> {
    if (this.started) throw new Error("SSH Gateway transport is already started");
    if (this.closed) throw new Error("SSH Gateway transport is closed");
    this.started = true;
    this.handle.channel.on("data", this.handleData);
    this.handle.channel.once("error", this.handleError);
    this.handle.channel.once("close", this.handleClose);
    this.handle.channel.stderr.on("data", this.handleStderr);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.started || this.closed || !this.handle.channel.writable) {
      throw new Error("SSH Gateway transport is not connected");
    }
    await new Promise<void>((resolve, reject) => {
      this.handle.channel.write(serializeMessage(message), (error?: Error | null) => {
        if (error) reject(error); else resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.finish();
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    try {
      this.readBuffer.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
      let message: JSONRPCMessage | null;
      while ((message = this.readBuffer.readMessage()) !== null) this.onmessage?.(message);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      this.finish();
    }
  };

  private readonly handleError = (error: Error): void => {
    this.onerror?.(error);
    this.finish();
  };

  private readonly handleClose = (): void => this.finish();

  private readonly handleStderr = (chunk: Buffer | string): void => {
    this.stderrBytes = Math.min(
      MAX_STDERR_BYTES,
      this.stderrBytes + (Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk, "utf8")),
    );
  };

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.readBuffer.clear();
    this.handle.channel.off("data", this.handleData);
    this.handle.channel.off("error", this.handleError);
    this.handle.channel.off("close", this.handleClose);
    this.handle.channel.stderr.off("data", this.handleStderr);
    this.handle.close();
    this.onDisconnect();
    this.onclose?.();
  }
}

class GatewayHttpFailure extends Error {
  constructor(readonly category: "availability" | "protocol" | "auth" | "tls" | "server", readonly status?: number, options?: ErrorOptions) {
    super(`Secure Gateway HTTPS ${category} failure`, options);
    this.name = "GatewayHttpFailure";
  }
}

function classifyNetworkFailure(error: unknown): GatewayHttpFailure {
  const value = error as { cause?: { code?: unknown }; code?: unknown; name?: unknown; message?: unknown };
  const code = String(value?.cause?.code ?? value?.code ?? "");
  const message = String(value?.message ?? "").toLowerCase();
  const tls = /CERT|TLS|SSL|HOSTNAME|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/u.test(code)
    || /certificate|hostname|tls|ssl/u.test(message);
  if (tls) return new GatewayHttpFailure("tls", undefined, { cause: error });
  const available = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT/u.test(code)
    || /timed out|timeout|connection refused/u.test(message);
  return new GatewayHttpFailure(available ? "availability" : "tls", undefined, { cause: error });
}

function isHttpSessionLoss(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 400 && /session|initialize|valid session/iu.test(error.message);
}

function isTransientServerFailure(error: unknown): boolean {
  return error instanceof GatewayHttpFailure && error.category === "server"
    || error instanceof StreamableHTTPError && error.code !== undefined && error.code >= 500 && error.code <= 599;
}

function allowsStdioFallback(error: unknown): boolean {
  if (error instanceof GatewayHttpFailure) return error.category === "availability" || error.category === "protocol";
  if (error instanceof StreamableHTTPError) return error.code === 404 || error.code === 405;
  return false;
}

async function verifyGatewayIdentity(client: Client, requestOptions: { signal?: AbortSignal; timeout: number; maxTotalTimeout: number }): Promise<void> {
  if (client.getServerVersion()?.name !== "pi-maestro-gateway") throw new Error("Gateway server identity verification failed");
  const listed = await client.listTools({}, requestOptions);
  if (!listed.tools.some((tool) => tool.name === "host")) throw new Error("Gateway tool identity verification failed");
}

function poolKey(hostId: string, hostDigest: string): string {
  return `${hostId}\0${hostDigest}`;
}

function decodeGatewayEnvelope(result: unknown): unknown {
  if (!result || typeof result !== "object") throw new Error("Gateway returned an invalid MCP tool result");
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("Gateway returned an invalid MCP tool result");
  const text = content.find((item): item is { type: "text"; text: string } => Boolean(
    item && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string",
  ))?.text;
  if (text === undefined) throw new Error("Gateway returned no result envelope");
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error("Gateway returned malformed result JSON"); }
}
