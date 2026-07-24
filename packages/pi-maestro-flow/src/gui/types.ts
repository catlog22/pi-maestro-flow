import type { IncomingMessage } from "node:http";

/**
 * Wire contract for the Unified Communication Layer (UCL) sidecar server.
 *
 * The sidecar exposes extension tools, aggregated state, and change events to
 * an external GUI process over loopback HTTP + SSE. Conversation/message/model
 * control stays on `pi --mode rpc`; this layer only covers tool discovery,
 * invocation, state reads, and event push.
 */

/** Every JSON response is wrapped in this envelope. */
export type GuiEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: string; code?: string };

export interface GuiRequest {
  /** Path parameters captured from the route pattern (e.g. `/tools/:name`). */
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body for POST requests. */
  body?: Record<string, unknown>;
  raw: IncomingMessage;
}

export interface GuiRouteResult {
  /** HTTP status; defaults to 200 on success, 400 when `error` is set. */
  status?: number;
  /** Success payload, wrapped as `{ ok: true, result }`. */
  result?: unknown;
  /** When set, the response becomes `{ ok: false, error, code }`. */
  error?: string;
  code?: string;
}

export type GuiRouteHandler = (req: GuiRequest) => Promise<GuiRouteResult> | GuiRouteResult;

export type GuiHttpMethod = "GET" | "POST";

export interface GuiServerOptions {
  /** Active pi session id; reported in /health and the discovery file. */
  sessionId: string;
  /** Project root; the discovery file is written under `<cwd>/.workflow`. */
  cwd: string;
  /** Bind port; 0 (default) lets the OS assign an ephemeral loopback port. */
  port?: number;
  /** Session token; a random UUID is generated when omitted. */
  token?: string;
  /** Override the discovery directory (defaults to `<cwd>/.workflow`). */
  discoveryDir?: string;
  /** Write the discovery file on start and remove it on close (default true). */
  writeDiscovery?: boolean;
  /** SSE keep-alive interval in ms (default 15000). */
  heartbeatMs?: number;
  /** Extra fields merged into the /health result. */
  getHealth?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface GuiServerHandle {
  /** Base URL including the session token query. */
  url: string;
  port: number;
  /** Bound address; always loopback ("127.0.0.1"). */
  address: string;
  token: string;
  sessionId: string;
  /** Absolute path of the discovery file, when written. */
  discoveryPath?: string;
  close: (reason?: string) => void;
  /** Broadcast an SSE event to all connected clients. */
  pushEvent: (name: string, payload: unknown) => void;
  /** Register a route; may be called before or after listen. */
  registerRoute: (method: GuiHttpMethod, pattern: string, handler: GuiRouteHandler) => void;
  sseClientCount: () => number;
}

/** Shape of the well-known discovery file (`.workflow/gui.json`). */
export interface GuiDiscoveryFile {
  version: 1;
  port: number;
  token: string;
  sessionId: string;
  /** Base URL with the session token query. */
  url: string;
  /** SSE event stream URL with the session token query. */
  eventsUrl: string;
  pid: number;
  startedAt: string;
}

export const GUI_DISCOVERY_FILENAME = "gui.json";

/**
 * Permission gateway the UCL invoke path must pass before executing any tool.
 * Mirrors the LLM tool-call chain (plan boundary -> hooks -> authorize). Returning
 * `{ block, reason }` denies; returning `undefined` allows (input may be mutated
 * in place by the gateway, e.g. via an approval dialog answer).
 */
export interface GuiPermissionGateway {
  authorize(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ block: true; reason: string } | undefined>;
  /** Current effective permission mode (for /health and GUI display). */
  mode(): string;
}

/** Shape of the GET /state aggregated snapshot. */
export interface GuiStateSnapshot {
  workflow: unknown;
  todos: unknown;
  goal: unknown;
  plan: unknown;
  teammates: unknown;
  swarm: unknown;
  approvalMode: string | null;
  sessionId: string | null;
}

/** Successful tool invocation result envelope payload. */
export interface GuiInvokeResult {
  toolCallId: string;
  content: unknown;
  details: unknown;
  terminate?: boolean;
}
