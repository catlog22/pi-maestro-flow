/** Authenticated local IPC host for MCP stdio framing. */
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { createConnection, createServer, type Server as NetServer, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GATEWAY_STATE_VERSION } from "./contracts.ts";
import { constantTimeEqual } from "./auth.ts";
import { createLocalGatewayPrincipal } from "./principal.ts";
import type { GatewayRuntime } from "./runtime.ts";
import { gatewayOwnerPath } from "./state-paths.ts";

const AUTH_TYPE = "pi-maestro-gateway-auth";
const MAX_AUTH_BYTES = 8 * 1024;
const MAX_CONTROL_RESPONSE_BYTES = 4 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 5_000;

export type GatewayIpcControlAction =
  | "status"
  | "stop"
  | "pair"
  | "pair-bootstrap"
  | "pair-list"
  | "pair-revoke"
  | "workspace-list"
  | "workspace-register"
  | "workspace-renew"
  | "workspace-remove";

interface GatewayIpcAuthFrame {
  type: typeof AUTH_TYPE;
  version: typeof GATEWAY_STATE_VERSION;
  ownerToken: string;
  control?: GatewayIpcControlAction;
  data?: Record<string, unknown>;
}

interface GatewayIpcAckFrame {
  type: typeof AUTH_TYPE;
  version: typeof GATEWAY_STATE_VERSION;
  ok: boolean;
  error?: string;
  data?: unknown;
}

export interface GatewayIpcServerOptions {
  ownerToken: string;
  address?: string;
  homeDir?: string;
  onControl?: (action: GatewayIpcControlAction, data?: Record<string, unknown>) => void | unknown | Promise<unknown>;
}

export interface GatewayIpcServerHandle {
  readonly address: string;
  readonly server: NetServer;
  close(): Promise<void>;
}

export interface GatewayIpcConnectOptions {
  address: string;
  ownerToken: string;
  timeoutMs?: number;
}

export function gatewayIpcAddress(homeDir = homedir(), ownerPath = gatewayOwnerPath(homeDir)): string {
  const identity = `${process.platform}:${ownerPath}`;
  const digest = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 24);
  if (process.platform === "win32") return `\\\\.\\pipe\\pi-maestro-gateway-${digest}`;
  return join(tmpdir(), `pi-maestro-gateway-${typeof process.getuid === "function" ? process.getuid() : "user"}-${digest}.sock`);
}

export async function startGatewayIpcServer(runtime: GatewayRuntime, options: GatewayIpcServerOptions): Promise<GatewayIpcServerHandle> {
  if (!options.ownerToken) throw new Error("Gateway IPC owner token is required");
  const address = options.address ?? gatewayIpcAddress(options.homeDir);
  if (process.platform !== "win32") await rm(address, { force: true });
  const sockets = new Set<Socket>();
  const sessions = new Set<Promise<void>>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.once("close", () => sockets.delete(socket));
    authenticateSocket(socket, options, runtime, sessions);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(address, () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    if (process.platform !== "win32") await rm(address, { force: true }).catch(() => undefined);
    throw error;
  }
  let closed = false;
  return {
    address,
    server,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled([...sessions]);
      if (process.platform !== "win32") await rm(address, { force: true });
    },
  };
}

function authenticateSocket(
  socket: Socket,
  options: GatewayIpcServerOptions,
  runtime: GatewayRuntime,
  sessions: Set<Promise<void>>,
): void {
  let buffer = Buffer.alloc(0);
  let settled = false;
  const timer = setTimeout(() => refuse("Gateway IPC authentication timed out"), AUTH_TIMEOUT_MS);
  timer.unref?.();
  const cleanup = (): void => {
    clearTimeout(timer);
    socket.off("data", onData);
  };
  const refuse = (message: string): void => {
    if (settled) return;
    settled = true;
    cleanup();
    const ack: GatewayIpcAckFrame = { type: AUTH_TYPE, version: GATEWAY_STATE_VERSION, ok: false, error: message };
    socket.end(`${JSON.stringify(ack)}\n`);
  };
  const onData = (chunk: Buffer): void => {
    if (settled) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.byteLength > MAX_AUTH_BYTES) return refuse("Gateway IPC authentication frame is too large");
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) return;
    let frame: GatewayIpcAuthFrame;
    try { frame = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as GatewayIpcAuthFrame; }
    catch { return refuse("Gateway IPC authentication frame is invalid"); }
    if (frame.type !== AUTH_TYPE || frame.version !== GATEWAY_STATE_VERSION || typeof frame.ownerToken !== "string" || !constantTimeEqual(frame.ownerToken, options.ownerToken)) {
      return refuse("Gateway IPC owner token is invalid");
    }
    if (frame.control !== undefined && ![
      "status", "stop", "pair", "pair-bootstrap", "pair-list", "pair-revoke",
      "workspace-list", "workspace-register", "workspace-renew", "workspace-remove",
    ].includes(frame.control)) {
      return refuse("Gateway IPC control action is invalid");
    }
    settled = true;
    cleanup();
    if (frame.control) {
      void respondToControl(socket, frame.control, frame.data, runtime, options.onControl);
      return;
    }
    const remainder = buffer.subarray(newline + 1);
    const ack: GatewayIpcAckFrame = { type: AUTH_TYPE, version: GATEWAY_STATE_VERSION, ok: true };
    socket.write(`${JSON.stringify(ack)}\n`, () => {
      const session = serveSocket(runtime, socket, remainder);
      sessions.add(session);
      void session.finally(() => sessions.delete(session));
    });
  };
  socket.on("data", onData);
  socket.once("error", cleanup);
  socket.once("close", cleanup);
}

async function respondToControl(
  socket: Socket,
  action: GatewayIpcControlAction,
  requestData: Record<string, unknown> | undefined,
  runtime: GatewayRuntime,
  onControl: GatewayIpcServerOptions["onControl"],
): Promise<void> {
  if (action !== "status" && !onControl) {
    const ack: GatewayIpcAckFrame = {
      type: AUTH_TYPE,
      version: GATEWAY_STATE_VERSION,
      ok: false,
      error: `Gateway IPC ${action} control is unavailable`,
    };
    socket.end(`${JSON.stringify(ack)}\n`);
    return;
  }
  try {
    const data = action === "status"
      ? (onControl ? await onControl(action, requestData) : runtime.host.test(createLocalGatewayPrincipal("local-control", {
        workspacePath: runtime.cwd,
        source: "local-ipc-control",
        scopes: ["gateway.control"],
      })))
      : action === "stop"
        ? { accepted: true, status: "stopping", pid: process.pid }
        : await onControl?.(action, requestData);
    const ack: GatewayIpcAckFrame = { type: AUTH_TYPE, version: GATEWAY_STATE_VERSION, ok: true, data };
    socket.end(`${JSON.stringify(ack)}\n`, () => {
      if (action === "stop") queueMicrotask(() => { void onControl?.(action, requestData); });
    });
  } catch (error) {
    const ack: GatewayIpcAckFrame = { type: AUTH_TYPE, version: GATEWAY_STATE_VERSION, ok: false, error: error instanceof Error ? error.message : String(error) };
    socket.end(`${JSON.stringify(ack)}\n`);
  }
}

async function serveSocket(runtime: GatewayRuntime, socket: Socket, remainder: Buffer): Promise<void> {
  const input = new PassThrough();
  const principal = createLocalGatewayPrincipal("local-owner", {
    workspacePath: runtime.cwd,
    source: "local-ipc",
    scopes: ["gateway"],
  });
  const mcpServer = runtime.createMcpServer(principal);
  const transport = new StdioServerTransport(input, socket, { maxBufferSize: runtime.config.limits.maxRequestBytes });
  const closeInput = (): void => { input.end(); };
  const destroyInput = (error: Error): void => { input.destroy(error); };
  socket.on("end", closeInput);
  socket.on("error", destroyInput);
  try {
    await mcpServer.connect(transport);
    if (remainder.byteLength > 0) input.write(remainder);
    socket.pipe(input, { end: true });
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  } finally {
    socket.off("end", closeInput);
    socket.off("error", destroyInput);
    socket.unpipe(input);
    input.end();
    await transport.close().catch(() => undefined);
    await mcpServer.close().catch(() => undefined);
  }
}

export async function connectGatewayIpc(options: GatewayIpcConnectOptions): Promise<Socket> {
  const socket = createConnection(options.address);
  socket.setNoDelay(true);
  const timeoutMs = options.timeoutMs ?? AUTH_TIMEOUT_MS;
  return new Promise<Socket>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("error", onError);
      socket.off("data", onData);
      socket.off("connect", onConnect);
      if (error) { socket.destroy(); reject(error); }
      else resolve(socket);
    };
    const onError = (error: Error): void => finish(error);
    const onConnect = (): void => {
      const frame: GatewayIpcAuthFrame = { type: AUTH_TYPE, version: GATEWAY_STATE_VERSION, ownerToken: options.ownerToken };
      socket.write(`${JSON.stringify(frame)}\n`);
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_AUTH_BYTES) return finish(new Error("Gateway IPC acknowledgement is too large"));
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      let ack: GatewayIpcAckFrame;
      try { ack = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as GatewayIpcAckFrame; }
      catch { return finish(new Error("Gateway IPC acknowledgement is invalid")); }
      if (ack.type !== AUTH_TYPE || ack.version !== GATEWAY_STATE_VERSION || ack.ok !== true) return finish(new Error(ack.error ?? "Gateway IPC authentication failed"));
      const remainder = buffer.subarray(newline + 1);
      if (remainder.byteLength > 0) socket.unshift(remainder);
      finish();
    };
    const timer = setTimeout(() => finish(new Error(`Gateway IPC connection timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    socket.once("error", onError);
    socket.once("connect", onConnect);
    socket.on("data", onData);
  });
}

function retryableIpcStartupError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

function requestGatewayIpcControlOnce(
  options: GatewayIpcConnectOptions & { action: GatewayIpcControlAction; data?: Record<string, unknown> },
  timeoutMs: number,
): Promise<unknown> {
  const socket = createConnection(options.address);
  socket.setNoDelay(true);
  return new Promise<unknown>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, data?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("error", onError);
      socket.off("data", onData);
      socket.off("connect", onConnect);
      socket.destroy();
      if (error) reject(error); else resolve(data);
    };
    const onError = (error: Error): void => finish(error);
    const onConnect = (): void => {
      const frame: GatewayIpcAuthFrame = {
        type: AUTH_TYPE,
        version: GATEWAY_STATE_VERSION,
        ownerToken: options.ownerToken,
        control: options.action,
        ...(options.data === undefined ? {} : { data: options.data }),
      };
      socket.write(`${JSON.stringify(frame)}\n`);
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_CONTROL_RESPONSE_BYTES) return finish(new Error("Gateway IPC control response is too large"));
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      let ack: GatewayIpcAckFrame;
      try { ack = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as GatewayIpcAckFrame; }
      catch { return finish(new Error("Gateway IPC control response is invalid")); }
      if (ack.type !== AUTH_TYPE || ack.version !== GATEWAY_STATE_VERSION || ack.ok !== true) {
        return finish(new Error(ack.error ?? "Gateway IPC control request failed"));
      }
      finish(undefined, ack.data);
    };
    const timer = setTimeout(() => finish(new Error(`Gateway IPC control timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    socket.once("error", onError);
    socket.once("connect", onConnect);
    socket.on("data", onData);
  });
}

export async function requestGatewayIpcControl(
  options: GatewayIpcConnectOptions & { action: GatewayIpcControlAction; data?: Record<string, unknown> },
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? AUTH_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      return await requestGatewayIpcControlOnce(options, remaining);
    } catch (error) {
      if (!retryableIpcStartupError(error) || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
  }
}
