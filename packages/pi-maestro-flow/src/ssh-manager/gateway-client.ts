import { Client } from "@modelcontextprotocol/sdk/client/index.js";
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
import type { SshHost } from "./model.ts";

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
  readonly transport: SshGatewayTransport;
}

export interface SshGatewayClientPoolOptions {
  maxEntries?: number;
}

/** A bounded pool of initialized MCP clients, isolated by SSH host id and full host digest. */
export class SshGatewayClientPool {
  private readonly entries = new Map<string, Promise<GatewayPoolEntry>>();
  private readonly launches = new GatewaySessionLauncher();
  private readonly hostFences = new Map<string, string>();
  private readonly hostEpochs = new Map<string, number>();
  private poolEpoch = 0;
  private readonly maxEntries: number;

  constructor(
    private readonly executor: Pick<SshExecutor, "openChannel">,
    options: SshGatewayClientPoolOptions = {},
  ) {
    const maxEntries = options.maxEntries ?? DEFAULT_POOL_SIZE;
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 32) {
      throw new Error("SSH Gateway client pool size must be an integer between 1 and 32");
    }
    this.maxEntries = maxEntries;
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
    const entry = await this.acquire(host, effectiveDigest, cacheFence, timeoutSeconds, signal);
    let data: unknown;
    let isError = false;
    let summary: string;

    if (input.action === "start_pi") {
      if (!startPiContext) throw new Error("start_pi requires the current host Pi session context");
      data = await this.launches.start(
        async (tool, args, timeout, requestSignal) => decodeGatewayEnvelope(await entry.client.callTool(
          { name: tool, arguments: args },
          undefined,
          { signal: requestSignal, timeout: timeout * 1000, maxTotalTimeout: timeout * 1000 },
        )),
        host.id,
        cacheFence,
        startPiContext.piSessionRef,
        startPiContext.todos,
        input,
        signal,
      );
      summary = `Pi execution ${(data as { executionHandle: string }).executionHandle} · monitor ready`;
    } else if (input.action === "status") {
      const listed = await entry.client.listTools({}, requestOptions);
      data = {
        connected: true,
        command: SSH_GATEWAY_COMMAND,
        server: entry.client.getServerVersion(),
        tools: listed.tools.map((tool) => tool.name),
      };
      summary = `gateway connected · ${listed.tools.length} tools`;
    } else if (input.action === "list") {
      const listed = await entry.client.listTools({}, requestOptions);
      data = { tools: listed.tools };
      summary = `${listed.tools.length} gateway tools`;
    } else if (input.action === "describe") {
      const listed = await entry.client.listTools({}, requestOptions);
      const tool = listed.tools.find((candidate) => candidate.name === input.tool);
      if (!tool) throw new Error(`Gateway tool ${JSON.stringify(input.tool)} is not available`);
      data = tool;
      summary = `gateway tool ${input.tool}`;
    } else {
      const prepared = input.tool === "monitor"
        ? this.launches.prepareMonitorCall(host.id, cacheFence, input.args ?? {})
        : { args: input.args ?? {}, record: undefined };
      if (input.tool === "monitor" && prepared.record) {
        await this.launches.refreshMonitorLease(
          async (tool, args, timeout, requestSignal) => decodeGatewayEnvelope(await entry.client.callTool(
            { name: tool, arguments: args },
            undefined,
            { signal: requestSignal, timeout: timeout * 1000, maxTotalTimeout: timeout * 1000 },
          )),
          prepared.record,
          timeoutSeconds,
          signal,
        );
      }
      const result = await entry.client.callTool(
        { name: input.tool, arguments: prepared.args },
        undefined,
        requestOptions,
      );
      data = result;
      isError = result.isError === true;
      if (!isError && input.tool === "monitor") {
        this.launches.updateMonitorCursor(prepared.record, decodeGatewayEnvelope(result));
      }
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
    const handle = await this.executor.openChannel(host, {
      command: SSH_GATEWAY_COMMAND,
      timeout: timeoutSeconds,
    }, { signal });
    if (handle.effectiveDigest !== undefined && handle.effectiveDigest !== effectiveDigest) {
      handle.close();
      throw new Error("SSH Gateway connection chain changed while opening");
    }
    let transport!: SshGatewayTransport;
    transport = new SshGatewayTransport(handle, () => {
      const current = this.entries.get(key);
      if (!current) return;
      void current.then((entry) => {
        if (entry.transport === transport && this.entries.get(key) === current) this.entries.delete(key);
      }, () => {
        if (this.entries.get(key) === current) this.entries.delete(key);
      });
    });
    const client = new Client({ name: "pi-maestro-flow-ssh", version: "1" });
    try {
      await client.connect(transport, {
        signal,
        timeout: timeoutSeconds * 1000,
        maxTotalTimeout: timeoutSeconds * 1000,
      });
      if (client.getServerVersion()?.name !== "pi-maestro-gateway") {
        throw new Error("The fixed remote command did not identify as Pi Maestro Gateway");
      }
      return { key, hostId: host.id, client, transport };
    } catch (error) {
      await client.close().catch(() => transport.close());
      throw error;
    }
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
