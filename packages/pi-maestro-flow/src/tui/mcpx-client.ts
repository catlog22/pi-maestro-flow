export type McpxWindowSource = "registered" | "managed";

export interface McpxRemoteSession {
  sessionId: string;
  workspace: string;
  label?: string;
  status: string;
}

export interface McpxRuntimeWindow {
  id: string;
  kind: McpxWindowSource;
  managed: boolean;
  displayName: string;
  sessionName?: string;
  target: string;
  ownerId: string;
  pid: number;
  publishedAt: number;
  agentCount: number;
  contextPressure?: number;
  status: string;
  cursor: number;
  remoteSessionId: string;
  remoteSessionLabel: string;
  workspace: string;
}

export type McpxWindowEvent =
  | { cursor: number; kind: "assistant"; at: number; text: string }
  | { cursor: number; kind: "tool"; at: number; toolCallId?: string; toolName: string; status?: string }
  | { cursor: number; kind: "lifecycle"; at: number; phase: string }
  | { cursor: number; kind: "rpc"; at: number; type: string; summary?: string; payload?: unknown };

export interface McpxWindowObservation {
  source: McpxWindowSource;
  window: McpxRuntimeWindow;
  status: string;
  cursor: number;
  nextCursor: number;
  oldestCursor: number;
  events: McpxWindowEvent[];
  hasMore: boolean;
  progress?: Record<string, unknown>;
  updatedAt?: number;
}

export interface McpxWindowSendInput {
  remoteSessionId: string;
  purpose: string;
  message: string;
  window?: string;
  targetMode?: "existing" | "new";
  mode?: "steer" | "follow_up";
  name?: string;
  model?: string;
  idempotencyKey?: string;
  confirmed?: boolean;
}

export interface McpxWindowSendResult {
  windowId?: string;
  action?: string;
  created?: boolean;
  status?: string;
  raw: Record<string, unknown>;
}

export type McpxClientErrorKind = "auth" | "unsupported" | "http" | "protocol" | "tool";

export class McpxClientError extends Error {
  constructor(
    message: string,
    readonly kind: McpxClientErrorKind,
    readonly status?: number,
    readonly code?: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "McpxClientError";
  }
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
}

interface McpToolResult {
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

const PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_TIMEOUT_MS = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

/** Parse either a JSON response or one/more Streamable-HTTP SSE data frames. */
export function parseMcpxResponseBody(contentType: string, body: string): JsonRpcResponse | undefined {
  if (!body.trim()) return undefined;
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed)) throw new Error("MCP response is not a JSON object");
    return parsed as JsonRpcResponse;
  }

  let last: JsonRpcResponse | undefined;
  let dataLines: string[] = [];
  const flush = (): void => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data || data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (isRecord(parsed)) last = parsed as JsonRpcResponse;
    } catch {
      // A malformed event does not discard the last valid JSON-RPC frame.
    }
  };
  for (const line of body.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  flush();
  return last;
}

function structuredToolEnvelope(result: McpToolResult): Record<string, unknown> {
  if (isRecord(result.structuredContent)) return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text;
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // Fall through to a concise protocol error below.
    }
  }
  throw new McpxClientError("MCP tool response has no structured content", "protocol");
}

function envelopeData(envelope: Record<string, unknown>): Record<string, unknown> {
  const data = isRecord(envelope.data) ? envelope.data : envelope;
  const status = stringValue(envelope.status);
  if (status && status !== "ok" && status !== "success") {
    const error = isRecord(envelope.error) ? envelope.error : undefined;
    const code = stringValue(error?.code ?? envelope.code);
    const message = stringValue(error?.message ?? envelope.message) || `MCP tool failed (${status})`;
    const kind: McpxClientErrorKind = code.toLowerCase().includes("invalid_action") ? "unsupported" : "tool";
    throw new McpxClientError(message, kind, undefined, code || undefined, data);
  }
  return data;
}

function schemaActionValues(schema: unknown): Set<string> {
  const actions = new Set<string>();
  const visit = (value: unknown): void => {
    if (!isRecord(value)) {
      if (Array.isArray(value)) value.forEach(visit);
      return;
    }
    const properties = isRecord(value.properties) ? value.properties : undefined;
    const action = properties && isRecord(properties.action) ? properties.action : undefined;
    if (action) {
      if (typeof action.const === "string") actions.add(action.const);
      if (Array.isArray(action.enum)) {
        for (const item of action.enum) if (typeof item === "string") actions.add(item);
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(schema);
  return actions;
}

function normalizeWindow(
  raw: Record<string, unknown>,
  session: McpxRemoteSession,
): McpxRuntimeWindow | undefined {
  const kind = raw.kind === "managed" ? "managed" : raw.kind === "registered" ? "registered" : undefined;
  const id = stringValue(raw.id ?? raw.owner_id);
  if (!kind || !id) return undefined;
  return {
    id,
    kind,
    managed: booleanValue(raw.managed) || kind === "managed",
    displayName: stringValue(raw.display_name) || `${kind}:${id.slice(0, 8)}`,
    sessionName: optionalString(raw.session_name),
    target: stringValue(raw.target) || id,
    ownerId: stringValue(raw.owner_id) || id,
    pid: numberValue(raw.pid),
    publishedAt: numberValue(raw.published_at),
    agentCount: numberValue(raw.agent_count),
    contextPressure: typeof raw.context_pressure === "number" ? raw.context_pressure : undefined,
    status: stringValue(raw.status) || "unknown",
    cursor: numberValue(raw.cursor),
    remoteSessionId: session.sessionId,
    remoteSessionLabel: session.label || session.workspace || session.sessionId.slice(0, 8),
    workspace: session.workspace,
  };
}

function normalizeEvent(raw: unknown): McpxWindowEvent | undefined {
  if (!isRecord(raw)) return undefined;
  const cursor = numberValue(raw.cursor);
  const atValue = raw.at ?? raw.created_at;
  const at = typeof atValue === "number"
    ? atValue
    : typeof atValue === "string"
      ? Date.parse(atValue)
      : 0;
  if (raw.kind === "assistant") {
    return { cursor, kind: "assistant", at, text: stringValue(raw.text) };
  }
  if (raw.kind === "tool") {
    return {
      cursor,
      kind: "tool",
      at,
      toolCallId: optionalString(raw.tool_call_id),
      toolName: stringValue(raw.tool_name),
      status: optionalString(raw.status),
    };
  }
  if (raw.kind === "lifecycle") {
    return { cursor, kind: "lifecycle", at, phase: stringValue(raw.phase) };
  }
  const type = stringValue(raw.type) || "event";
  return { cursor, kind: "rpc", at, type, summary: optionalString(raw.summary), payload: raw.payload };
}

export class McpxStreamableHttpClient {
  private sessionId?: string;
  private requestId = 0;
  private initializePromise?: Promise<void>;
  private capabilityPromise?: Promise<void>;

  constructor(
    readonly endpoint: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly bearerToken?: string,
  ) {}

  private resetTransport(): void {
    this.sessionId = undefined;
    this.initializePromise = undefined;
    this.capabilityPromise = undefined;
  }

  async listRemoteSessions(): Promise<McpxRemoteSession[]> {
    const data = await this.callTool("session", { action: "list", limit: 20 });
    const sessions = isRecord(data.data) && Array.isArray(data.data.sessions)
      ? data.data.sessions
      : Array.isArray(data.sessions)
        ? data.sessions
        : [];
    return sessions.flatMap((candidate) => {
      if (!isRecord(candidate)) return [];
      const sessionId = stringValue(candidate.remote_session_id);
      if (!sessionId) return [];
      return [{
        sessionId,
        workspace: stringValue(candidate.workspace_name ?? candidate.workspace),
        label: optionalString(candidate.label),
        status: stringValue(candidate.status),
      }];
    });
  }

  async listWindows(session: McpxRemoteSession): Promise<McpxRuntimeWindow[]> {
    await this.requirePiWindowActions();
    const data = await this.callTool("pi_window", {
      action: "list",
      remote_session_id: session.sessionId,
    });
    const windows = Array.isArray(data.windows) ? data.windows : [];
    return windows.flatMap((candidate) => isRecord(candidate) ? normalizeWindow(candidate, session) ?? [] : []);
  }

  async observeWindow(
    session: McpxRemoteSession,
    window: McpxRuntimeWindow,
    cursor = 0,
    limit = 50,
  ): Promise<McpxWindowObservation> {
    await this.requirePiWindowActions();
    const data = await this.callTool("pi_window", {
      action: "observe",
      remote_session_id: session.sessionId,
      window: window.id,
      cursor,
      limit,
    });
    const rawWindow = isRecord(data.window) ? data.window : {};
    const normalized = normalizeWindow(rawWindow, session) ?? window;
    return {
      source: data.source === "managed" ? "managed" : "registered",
      window: normalized,
      status: stringValue(data.status) || normalized.status,
      cursor: numberValue(data.cursor),
      nextCursor: numberValue(data.next_cursor),
      oldestCursor: numberValue(data.oldest_cursor),
      events: (Array.isArray(data.events) ? data.events : []).flatMap((event) => normalizeEvent(event) ?? []),
      hasMore: booleanValue(data.has_more),
      progress: isRecord(data.progress) ? data.progress : undefined,
      updatedAt: typeof data.updated_at === "number" ? data.updated_at : undefined,
    };
  }

  async sendWindow(input: McpxWindowSendInput): Promise<McpxWindowSendResult> {
    await this.requirePiWindowActions();
    const args: Record<string, unknown> = {
      action: "send",
      remote_session_id: input.remoteSessionId,
      purpose: input.purpose,
      message: input.message,
      target_mode: input.targetMode ?? "existing",
      ...(input.window ? { window: input.window } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
    };
    let data: Record<string, unknown>;
    try {
      data = await this.callTool("pi_window", args);
    } catch (error) {
      if (!(error instanceof McpxClientError)
        || error.code?.toLowerCase() !== "user_confirmation_required"
        || input.confirmed !== true) throw error;
      data = await this.callTool("pi_window", { ...args, user_confirmed: true });
    }
    return {
      windowId: optionalString(data.window_id),
      action: optionalString(data.action),
      created: typeof data.created === "boolean" ? data.created : undefined,
      status: optionalString(data.status),
      raw: data,
    };
  }

  private async requirePiWindowActions(): Promise<void> {
    if (!this.capabilityPromise) {
      const capability = (async () => {
        const response = await this.rpc("tools/list", {});
        const tools = Array.isArray(response.result?.tools) ? response.result.tools : [];
        const tool = tools.find((candidate) => isRecord(candidate) && candidate.name === "pi_window");
        if (!isRecord(tool)) throw new McpxClientError("Runtime does not expose pi_window", "unsupported");
        const actions = schemaActionValues(tool.inputSchema);
        if (!["list", "send", "observe"].every((action) => actions.has(action))) {
          throw new McpxClientError("Runtime pi_window lacks unified list/send/observe actions", "unsupported");
        }
      })();
      const recoverable = capability.catch((error) => {
        if (this.capabilityPromise === recoverable) this.capabilityPromise = undefined;
        throw error;
      });
      this.capabilityPromise = recoverable;
    }
    return this.capabilityPromise;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.rpc("tools/call", { name, arguments: args });
    const result = (response.result ?? {}) as McpToolResult;
    const envelope = structuredToolEnvelope(result);
    if (result.isError === true && !stringValue(envelope.status)) {
      throw new McpxClientError(`MCP tool ${name} failed`, "tool", undefined, undefined, envelope);
    }
    return envelopeData(envelope);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initializePromise) {
      const initialization = (async () => {
        await this.rpcDirect("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "pi-maestro-flow-mcpx", version: "1.0.0" },
        }, false);
        await this.notify("notifications/initialized");
      })();
      const recoverable = initialization.catch((error) => {
        if (this.initializePromise === recoverable) this.resetTransport();
        throw error;
      });
      this.initializePromise = recoverable;
    }
    return this.initializePromise;
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    await this.ensureInitialized();
    return this.rpcDirect(method, params, true);
  }

  private async notify(method: string): Promise<void> {
    await this.post({ jsonrpc: "2.0", method }, true);
  }

  private async rpcDirect(
    method: string,
    params: Record<string, unknown>,
    includeSession: boolean,
  ): Promise<JsonRpcResponse> {
    const id = ++this.requestId;
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, includeSession);
    if (!response) throw new McpxClientError(`Empty MCP response for ${method}`, "protocol");
    if (response.error) {
      const unsupported = response.error.code === -32601;
      throw new McpxClientError(
        response.error.message || `MCP ${method} failed`,
        unsupported ? "unsupported" : "protocol",
        undefined,
        response.error.code === undefined ? undefined : String(response.error.code),
      );
    }
    return response;
  }

  private async post(payload: Record<string, unknown>, includeSession: boolean): Promise<JsonRpcResponse | undefined> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": PROTOCOL_VERSION,
          ...(includeSession && this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
          ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new McpxClientError(error instanceof Error ? error.message : String(error), "http");
    }
    if (response.status === 401 || response.status === 403) {
      this.resetTransport();
      throw new McpxClientError(`MCP authentication required (HTTP ${response.status})`, "auth", response.status);
    }
    if (response.status === 404 && includeSession) {
      this.resetTransport();
      throw new McpxClientError("MCP session expired (HTTP 404)", "http", response.status);
    }
    if (!response.ok) {
      throw new McpxClientError(`MCP HTTP ${response.status}`, "http", response.status);
    }
    const nextSession = response.headers.get("Mcp-Session-Id");
    if (nextSession) this.sessionId = nextSession;
    const body = await response.text();
    try {
      return parseMcpxResponseBody(response.headers.get("content-type") ?? "", body);
    } catch (error) {
      throw new McpxClientError(error instanceof Error ? error.message : String(error), "protocol");
    }
  }
}
