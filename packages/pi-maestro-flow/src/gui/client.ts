import http from "node:http";
import { readFile } from "node:fs/promises";
import type { GuiDiscoveryFile, GuiEnvelope, GuiInvokeResult, GuiStateSnapshot } from "./types.ts";
import type { GuiToolView } from "./tool-routes.ts";

/**
 * Reference client for the UCL sidecar (Node). GUI developers can use this
 * directly or adapt it (REST via fetch, SSE via node:http; in a browser, swap
 * the SSE reader for EventSource). Conversation/message/model control is NOT
 * here — that lives on `pi --mode rpc` (RpcClient).
 */
export interface GuiClientOptions {
  port: number;
  token: string;
  host?: string;
}

export class GuiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "GuiClientError";
  }
}

export interface GuiInvokeOptions {
  /** Client-chosen id for correlation and cancellation (defaults to a server UUID). */
  invokeId?: string;
  /** Abort the invoke after this many milliseconds. */
  timeoutMs?: number;
}

export type GuiEventHandler = (event: { name: string; data: unknown }) => void;

export class GuiClient {
  private readonly host: string;
  private readonly port: number;
  private readonly token: string;

  constructor(options: GuiClientOptions) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port;
    this.token = options.token;
  }

  /** Build a client from a `.workflow/gui.json` discovery file. */
  static async fromDiscovery(discoveryPath: string): Promise<GuiClient> {
    const discovery = JSON.parse(await readFile(discoveryPath, "utf-8")) as GuiDiscoveryFile;
    return new GuiClient({ port: discovery.port, token: discovery.token });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`http://${this.host}:${this.port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const envelope = (await res.json()) as GuiEnvelope<T>;
    if (!envelope.ok) throw new GuiClientError(envelope.error, res.status, envelope.code);
    return envelope.result;
  }

  health(): Promise<{ healthy: boolean; sessionId: string; [key: string]: unknown }> {
    return this.request("GET", "/health");
  }

  listTools(): Promise<GuiToolView[]> {
    return this.request("GET", "/tools");
  }

  invoke(name: string, args: Record<string, unknown> = {}, options: GuiInvokeOptions = {}): Promise<GuiInvokeResult> {
    return this.request("POST", `/tools/${encodeURIComponent(name)}`, { args, ...options });
  }

  cancel(invokeId: string): Promise<{ cancelled: boolean; invokeId: string }> {
    return this.request("POST", "/cancel", { invokeId });
  }

  getState(): Promise<GuiStateSnapshot> {
    return this.request("GET", "/state");
  }

  getStateSub(sub: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/state/${encodeURIComponent(sub)}`);
  }

  /** Subscribe to the SSE event stream; returns an unsubscribe function. */
  subscribe(onEvent: GuiEventHandler, onError?: (error: unknown) => void): () => void {
    const req = http.get(
      { host: this.host, port: this.port, path: `/events?session=${this.token}` },
      (res) => {
        let buffer = "";
        let current: Partial<{ event: string; data: string }> = {};
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf-8");
          let idx: number;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line.startsWith(":")) continue;
            if (line === "") {
              if (current.data !== undefined) {
                let data: unknown;
                try {
                  data = JSON.parse(current.data);
                } catch {
                  data = current.data;
                }
                onEvent({ name: current.event ?? "message", data });
              }
              current = {};
              continue;
            }
            const colon = line.indexOf(":");
            const field = colon >= 0 ? line.slice(0, colon) : line;
            const value = colon >= 0 ? line.slice(colon + 1).trimStart() : "";
            if (field === "event") current.event = value;
            else if (field === "data") current.data = value;
          }
        });
        res.on("error", (error) => onError?.(error));
      },
    );
    req.on("error", (error) => onError?.(error));
    return () => req.destroy();
  }
}
