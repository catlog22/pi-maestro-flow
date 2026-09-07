/** Authenticated in-process MCP client for the local persistent Gateway. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Socket } from "node:net";
import { GatewayControlClient, type GatewayControlStatus } from "./control-client.ts";
import { connectGatewayIpc } from "./ipc.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_STDIO_BUFFER_BYTES = 4 * 1024 * 1024;

export interface GatewayControlStarter {
  start(): Promise<GatewayControlStatus>;
}

export interface GatewayLocalClientOptions {
  cwd: string;
  timeoutMs?: number;
  controlClient?: GatewayControlStarter;
}

export class GatewayLocalClient {
  private readonly timeoutMs: number;
  private readonly controlClient: GatewayControlStarter;

  constructor(private readonly options: GatewayLocalClientOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.controlClient = options.controlClient ?? new GatewayControlClient({ cwd: options.cwd });
  }

  async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Gateway call was cancelled");
    const status = await this.controlClient.start();
    const address = status.owner?.socket;
    const ownerToken = status.owner?.ownerToken;
    if (!status.online || !address || !ownerToken) throw new Error(status.error ?? "Gateway owner IPC endpoint is unavailable");
    const socket = await connectGatewayIpc({ address, ownerToken, timeoutMs: this.timeoutMs });
    const transport = new GatewaySocketTransport(socket);
    const client = new Client({ name: "pi-maestro-flow-native", version: "1" });
    const requestOptions = {
      signal,
      timeout: this.timeoutMs,
      maxTotalTimeout: this.timeoutMs,
    };
    try {
      await client.connect(transport, requestOptions);
      return await client.callTool({ name: tool, arguments: args }, undefined, requestOptions) as CallToolResult;
    } finally {
      await client.close().catch(() => transport.close());
    }
  }
}

class GatewaySocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly readBuffer = new ReadBuffer({ maxBufferSize: MAX_STDIO_BUFFER_BYTES });
  private started = false;
  private closed = false;

  constructor(private readonly socket: Socket) {}

  async start(): Promise<void> {
    if (this.started) throw new Error("Gateway IPC transport is already started");
    if (this.closed) throw new Error("Gateway IPC transport is closed");
    this.started = true;
    this.socket.on("data", this.handleData);
    this.socket.once("error", this.handleError);
    this.socket.once("close", this.handleClose);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.started || this.closed || !this.socket.writable) throw new Error("Gateway IPC transport is not connected");
    await new Promise<void>((resolve, reject) => {
      this.socket.write(serializeMessage(message), (error?: Error | null) => {
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

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.readBuffer.clear();
    this.socket.off("data", this.handleData);
    this.socket.off("error", this.handleError);
    this.socket.off("close", this.handleClose);
    this.socket.destroy();
    this.onclose?.();
  }
}

export function createGatewayLocalClient(options: GatewayLocalClientOptions): GatewayLocalClient {
  return new GatewayLocalClient(options);
}
