import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ElicitationCompleteNotificationSchema,
  type ReadResourceResult,
  type UrlElicitationRequiredError,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  McpTool,
  McpResource,
  ServerDefinition,
  ServerStreamResultPatchNotification,
  Transport,
} from "./types.ts";
import { serverStreamResultPatchNotificationSchema } from "./types.ts";
import { resolveNpxBinary } from "./npx-resolver.ts";
import { logger } from "./logger.ts";
import { McpOAuthProvider } from "./mcp-oauth-provider.ts";
import { extractOAuthConfig, supportsOAuth } from "./mcp-auth-flow.ts";
import { registerSamplingHandler, type ServerSamplingConfig } from "./sampling-handler.ts";
import {
  handleUrlElicitation,
  registerElicitationHandler,
  type ServerElicitationConfig,
} from "./elicitation-handler.ts";
import { interpolateEnvRecord, resolveBearerToken, resolveConfigPath } from "./utils.ts";
import { abortable, throwIfAborted } from "./abort.ts";

export interface ServerConnection {
  client: Client;
  transport: Transport;
  definition: ServerDefinition;
  tools: McpTool[];
  resources: McpResource[];
  lastUsedAt: number;
  inFlight: number;
  status: "connected" | "closed" | "needs-auth";
  lifecycle?: AbortController;
}

export interface ServerConnectionLease {
  connection: ServerConnection;
  requestOptions: RequestOptions | undefined;
  release(): void;
}

/**
 * A manager-owned single-flight startup reservation. The startup is driven by
 * a lifecycle controller owned by the manager (not by the first caller's
 * signal), so one caller aborting its wait never cancels the shared startup.
 * `close()` aborts the controller to fence the pending startup.
 */
interface CloseableResource {
  close(): Promise<void>;
}

interface TrackedStartupResource {
  description: string;
  closePromise?: Promise<void>;
}

interface PendingConnect {
  promise: Promise<ServerConnection>;
  controller: AbortController;
  resources: Map<CloseableResource, TrackedStartupResource>;
  forcedClosing: boolean;
}

export interface McpServerManagerOptions {
  startupDrainTimeoutMs?: number;
  connectionLeaseDrainTimeoutMs?: number;
  resourceCloseTimeoutMs?: number;
}

type TrackStartupResource = (resource: CloseableResource, description: string) => void;

type UiStreamListener = (serverName: string, notification: ServerStreamResultPatchNotification["params"]) => void;

const MCP_DISCOVERY_MAX_PAGES = 100;
const MCP_DISCOVERY_MAX_ITEMS = 10_000;
const MCP_DISCOVERY_MAX_METADATA_BYTES = 8 * 1024 * 1024;
const DEFAULT_STARTUP_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECTION_LEASE_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_RESOURCE_CLOSE_TIMEOUT_MS = 5_000;

class McpDiscoveryPaginationError extends Error {}

class McpMetadataLimitExceeded extends Error {}

class McpMetadataValueError extends Error {}

interface McpDiscoveryPage<T> {
  items: T[];
  nextCursor?: string;
}

type JsonByteCountFrame =
  | { kind: "value"; value: unknown }
  | { kind: "array"; value: unknown[]; index: number }
  | { kind: "object"; value: Record<string, unknown>; keys: string[]; index: number };

function countJsonStringBytes(value: string, addBytes: (bytes: number) => void): void {
  addBytes(2); // Quotes.
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      addBytes(2);
    } else if (codeUnit <= 0x1f) {
      addBytes(
        codeUnit === 0x08
          || codeUnit === 0x09
          || codeUnit === 0x0a
          || codeUnit === 0x0c
          || codeUnit === 0x0d
          ? 2
          : 6,
      );
    } else if (codeUnit <= 0x7f) {
      addBytes(1);
    } else if (codeUnit <= 0x7ff) {
      addBytes(2);
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        addBytes(4);
        index += 1;
      } else {
        addBytes(6);
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      addBytes(6);
    } else {
      addBytes(3);
    }
  }
}

function countUtf8StringBytes(value: string, maxBytes: number): number {
  let bytes = 0;
  const addBytes = (additionalBytes: number): void => {
    if (additionalBytes > maxBytes - bytes) throw new McpMetadataLimitExceeded();
    bytes += additionalBytes;
  };

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      addBytes(1);
    } else if (codeUnit <= 0x7ff) {
      addBytes(2);
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        addBytes(4);
        index += 1;
      } else {
        addBytes(3);
      }
    } else {
      addBytes(3);
    }
  }
  return bytes;
}

function countJsonCompatibleBytes(value: unknown, maxBytes: number): number {
  let bytes = 0;
  const activeObjects = new Set<object>();
  const frames: JsonByteCountFrame[] = [{ kind: "value", value }];
  const addBytes = (additionalBytes: number): void => {
    if (additionalBytes > maxBytes - bytes) throw new McpMetadataLimitExceeded();
    bytes += additionalBytes;
  };

  while (frames.length > 0) {
    const frame = frames.pop()!;
    if (frame.kind === "array") {
      if (frame.index >= frame.value.length) {
        addBytes(1);
        activeObjects.delete(frame.value);
        continue;
      }
      if (frame.index > 0) addBytes(1);
      const index = frame.index;
      frame.index += 1;
      frames.push(frame, { kind: "value", value: frame.value[index] });
      continue;
    }

    if (frame.kind === "object") {
      if (frame.index >= frame.keys.length) {
        addBytes(1);
        activeObjects.delete(frame.value);
        continue;
      }
      if (frame.index > 0) addBytes(1);
      const key = frame.keys[frame.index];
      frame.index += 1;
      countJsonStringBytes(key, addBytes);
      addBytes(1);
      frames.push(frame, { kind: "value", value: frame.value[key] });
      continue;
    }

    const current = frame.value;
    if (current === null) {
      addBytes(4);
      continue;
    }
    switch (typeof current) {
      case "string":
        countJsonStringBytes(current, addBytes);
        continue;
      case "boolean":
        addBytes(current ? 4 : 5);
        continue;
      case "number":
        if (!Number.isFinite(current)) {
          throw new McpMetadataValueError("non-finite numbers are not JSON-compatible");
        }
        addBytes(String(current).length);
        continue;
      case "object": {
        if (activeObjects.has(current)) {
          throw new McpMetadataValueError("cyclic values are not JSON-compatible");
        }
        activeObjects.add(current);
        if (Array.isArray(current)) {
          addBytes(1);
          frames.push({ kind: "array", value: current, index: 0 });
          continue;
        }

        let prototype: object | null;
        let keys: string[];
        try {
          prototype = Object.getPrototypeOf(current);
          keys = Object.keys(current);
        } catch {
          throw new McpMetadataValueError("metadata objects must be inspectable");
        }
        if (prototype !== Object.prototype && prototype !== null) {
          throw new McpMetadataValueError("objects with non-JSON prototypes are not supported");
        }
        addBytes(1);
        frames.push({
          kind: "object",
          value: current as Record<string, unknown>,
          keys,
          index: 0,
        });
        continue;
      }
      default:
        throw new McpMetadataValueError(`values of type ${typeof current} are not JSON-compatible`);
    }
  }

  return bytes;
}

function metadataLimitError(kind: "tools" | "resources"): McpDiscoveryPaginationError {
  return new McpDiscoveryPaginationError(
    `MCP ${kind} discovery exceeded metadata limit of ${MCP_DISCOVERY_MAX_METADATA_BYTES} bytes.`,
  );
}

function countMcpPageMetadataBytes(
  kind: "tools" | "resources",
  value: unknown,
  remainingBytes: number,
): number {
  try {
    return countJsonCompatibleBytes(value, remainingBytes);
  } catch (error) {
    if (error instanceof McpMetadataLimitExceeded) throw metadataLimitError(kind);
    if (error instanceof McpMetadataValueError) {
      throw new McpDiscoveryPaginationError(
        `MCP ${kind} discovery received invalid metadata: ${error.message}.`,
      );
    }
    throw error;
  }
}

function countMcpCursorBytes(
  kind: "tools" | "resources",
  cursor: string,
  remainingBytes: number,
): number {
  if (typeof cursor !== "string") {
    throw new McpDiscoveryPaginationError(
      `MCP ${kind} discovery received an invalid non-string pagination cursor.`,
    );
  }
  try {
    return countUtf8StringBytes(cursor, remainingBytes);
  } catch (error) {
    if (error instanceof McpMetadataLimitExceeded) throw metadataLimitError(kind);
    throw error;
  }
}

async function collectPaginatedMcpItems<T>(
  kind: "tools" | "resources",
  fetchPage: (cursor: string | undefined) => Promise<McpDiscoveryPage<T>>,
  signal?: AbortSignal,
): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  let metadataBytes = 0;

  while (true) {
    throwIfAborted(signal);
    if (pageCount >= MCP_DISCOVERY_MAX_PAGES) {
      throw new McpDiscoveryPaginationError(
        `MCP ${kind} discovery exceeded page limit of ${MCP_DISCOVERY_MAX_PAGES}.`,
      );
    }

    const page = await fetchPage(cursor);
    throwIfAborted(signal);
    pageCount += 1;

    if (items.length + page.items.length > MCP_DISCOVERY_MAX_ITEMS) {
      throw new McpDiscoveryPaginationError(
        `MCP ${kind} discovery exceeded item limit of ${MCP_DISCOVERY_MAX_ITEMS}.`,
      );
    }

    metadataBytes += countMcpPageMetadataBytes(
      kind,
      page.items,
      MCP_DISCOVERY_MAX_METADATA_BYTES - metadataBytes,
    );
    items.push(...page.items);

    const nextCursor = page.nextCursor;
    if (!nextCursor) return items;
    if (seenCursors.has(nextCursor)) {
      throw new McpDiscoveryPaginationError(
        `MCP ${kind} discovery received a repeated pagination cursor.`,
      );
    }
    metadataBytes += countMcpCursorBytes(
      kind,
      nextCursor,
      MCP_DISCOVERY_MAX_METADATA_BYTES - metadataBytes,
    );
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

async function closeResource(
  resource: CloseableResource,
  description: string,
  timeoutMs = DEFAULT_RESOURCE_CLOSE_TIMEOUT_MS,
): Promise<void> {
  let closePromise: Promise<void>;
  try {
    closePromise = resource.close();
  } catch (error) {
    closePromise = Promise.reject(error);
  }
  const outcome = await waitForSettlementUntilDeadline(closePromise, timeoutMs);
  if (outcome === "deadline") {
    void closePromise.catch((error) => {
      logger.debug(`Failed to close detached ${description}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    logger.error(
      "MCP resource close deadline exceeded; cleanup detached",
      new Error(`${description} did not close within ${timeoutMs}ms.`),
      { timeoutMs },
    );
    return;
  }

  try {
    await closePromise;
  } catch (error) {
    logger.debug(`Failed to close ${description}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function waitForSettlementUntilDeadline(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<"settled" | "deadline"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      new Promise<"deadline">((resolve) => {
        timeout = setTimeout(() => resolve("deadline"), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function closeTrackedStartupResource(
  resources: Map<CloseableResource, TrackedStartupResource>,
  resource: CloseableResource,
  description: string,
): Promise<void> {
  const tracked = resources.get(resource);
  if (tracked?.closePromise) return tracked.closePromise;
  const closePromise = closeResource(resource, tracked?.description ?? description);
  if (tracked) tracked.closePromise = closePromise;
  return closePromise;
}

export class McpServerManager {
  private connections = new Map<string, ServerConnection>();
  private connectPromises = new Map<string, PendingConnect>();
  private uiStreamListeners = new Map<string, UiStreamListener>();
  private samplingConfig: ServerSamplingConfig | undefined;
  private elicitationConfig: ServerElicitationConfig | undefined;
  private acceptedUrlElicitations = new Map<string, Set<string>>();
  private connectionDrainWaiters = new WeakMap<ServerConnection, Set<() => void>>();
  private connectionLeaseCounts = new WeakMap<ServerConnection, number>();
  private defaultRequestTimeoutMs: number | undefined;
  private readonly startupDrainTimeoutMs: number;
  private readonly connectionLeaseDrainTimeoutMs: number;
  private readonly resourceCloseTimeoutMs: number;

  /** Default cwd for stdio servers without an explicit config `cwd`. */
  constructor(
    private readonly defaultCwd?: string,
    options: McpServerManagerOptions = {},
  ) {
    this.startupDrainTimeoutMs = normalizeDrainTimeoutMs(
      options.startupDrainTimeoutMs,
      DEFAULT_STARTUP_DRAIN_TIMEOUT_MS,
    );
    this.connectionLeaseDrainTimeoutMs = normalizeDrainTimeoutMs(
      options.connectionLeaseDrainTimeoutMs,
      DEFAULT_CONNECTION_LEASE_DRAIN_TIMEOUT_MS,
    );
    this.resourceCloseTimeoutMs = normalizeDrainTimeoutMs(
      options.resourceCloseTimeoutMs,
      DEFAULT_RESOURCE_CLOSE_TIMEOUT_MS,
    );
  }

  setSamplingConfig(config: ServerSamplingConfig | undefined): void {
    this.samplingConfig = config;
  }

  setElicitationConfig(config: ServerElicitationConfig | undefined): void {
    this.elicitationConfig = config;
  }

  setDefaultRequestTimeoutMs(timeoutMs: number | undefined): void {
    this.defaultRequestTimeoutMs = normalizeRequestTimeoutMs(timeoutMs);
  }

  getRequestOptions(name: string, signal?: AbortSignal): RequestOptions | undefined {
    const connection = this.connections.get(name);
    return this.requestOptionsForConnection(connection, signal);
  }

  private requestOptionsForConnection(
    connection: ServerConnection | undefined,
    signal?: AbortSignal,
  ): RequestOptions | undefined {
    if (!connection) return this.buildRequestOptions(undefined, signal);
    const lifecycle = connection.lifecycle ??= new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, lifecycle.signal])
      : lifecycle.signal;
    return this.buildRequestOptions(connection.definition, combinedSignal);
  }

  private getResolvedRequestTimeoutMs(definition?: ServerDefinition): number | undefined {
    if (definition?.requestTimeoutMs !== undefined) {
      return normalizeRequestTimeoutMs(definition.requestTimeoutMs);
    }
    return this.defaultRequestTimeoutMs;
  }

  private buildRequestOptions(
    definition?: ServerDefinition,
    signal?: AbortSignal,
  ): RequestOptions | undefined {
    const timeout = this.getResolvedRequestTimeoutMs(definition);

    if (!signal && timeout === undefined) {
      return undefined;
    }

    return {
      ...(signal ? { signal } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    };
  }

  async connect(name: string, definition: ServerDefinition, signal?: AbortSignal): Promise<ServerConnection> {
    throwIfAborted(signal);
    // Dedupe concurrent connection attempts. Every caller waits on the shared
    // startup through its own signal, so one caller aborting never cancels the
    // manager-owned startup for the others.
    const pending = this.connectPromises.get(name);
    if (pending) {
      return abortable(pending.promise, signal);
    }

    // Reuse existing connection if healthy
    const existing = this.connections.get(name);
    if (existing?.status === "connected") {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    // The startup is owned by a manager lifecycle controller, not by the first
    // caller's signal. close() aborts this controller to fence the startup.
    const controller = new AbortController();
    const startupResources = new Map<CloseableResource, TrackedStartupResource>();
    let pendingState: PendingConnect | undefined;
    const trackStartupResource: TrackStartupResource = (resource, description) => {
      startupResources.set(resource, { description });
      if (pendingState?.forcedClosing) {
        void closeTrackedStartupResource(startupResources, resource, description);
      }
    };
    const startup = this.createConnection(
      name,
      definition,
      controller.signal,
      trackStartupResource,
    ).then(
      async (connection) => {
        if (this.connectPromises.get(name)?.controller !== controller) {
          // Fenced by close(): reclaim the late resource and fail waiters rather
          // than inserting into or overwriting a newer generation's registry.
          await Promise.all([
            closeTrackedStartupResource(startupResources, connection.client, `${name} client`),
            closeTrackedStartupResource(startupResources, connection.transport, `${name} transport`),
          ]);
          throw new Error(`Server "${name}" was closed during startup.`);
        }
        connection.lifecycle ??= new AbortController();
        this.connections.set(name, connection);
        this.connectPromises.delete(name);
        return connection;
      },
      (error) => {
        if (this.connectPromises.get(name)?.controller === controller) {
          this.connectPromises.delete(name);
        }
        throw error;
      },
    );
    // Prevent an unhandled rejection when the startup is fenced with no waiters.
    startup.catch(() => {});
    pendingState = {
      promise: startup,
      controller,
      resources: startupResources,
      forcedClosing: false,
    };
    this.connectPromises.set(name, pendingState);
    return abortable(startup, signal);
  }

  protected async createConnection(
    name: string,
    definition: ServerDefinition,
    signal?: AbortSignal,
    trackStartupResource?: TrackStartupResource,
  ): Promise<ServerConnection> {
    throwIfAborted(signal);
    const client = this.createClient(name);
    trackStartupResource?.(client, `${name} client`);

    let transport: Transport;

    if (definition.command) {
      let command = definition.command;
      let args = definition.args ?? [];

      if (command === "npx" || command === "npm") {
        const resolved = await resolveNpxBinary(command, args);
        if (resolved) {
          command = resolved.isJs ? "node" : resolved.binPath;
          args = resolved.isJs ? [resolved.binPath, ...resolved.extraArgs] : resolved.extraArgs;
          logger.debug(`${name} resolved to ${resolved.binPath} (skipping npm parent)`);
        }
      }

      transport = new StdioClientTransport({
        command,
        args,
        env: resolveEnv(definition.env),
        cwd: resolveConfigPath(definition.cwd) ?? this.defaultCwd,
        stderr: definition.debug ? "inherit" : "ignore",
      });
      trackStartupResource?.(transport, `${name} transport`);
    } else if (definition.url) {
      // HTTP transport with fallback
      transport = await this.createHttpTransport(
        definition,
        name,
        signal,
        trackStartupResource,
      );
      trackStartupResource?.(transport, `${name} transport`);
    } else {
      throw new Error(`Server ${name} has no command or url`);
    }

    const requestOptions = this.buildRequestOptions(definition, signal);

    try {
      await client.connect(transport, requestOptions);
      this.attachAdapterNotificationHandlers(name, client);

      // Discover tools and resources
      const [tools, resources] = await Promise.all([
        this.fetchAllTools(client, requestOptions),
        this.fetchAllResources(client, requestOptions),
      ]);

      return {
        client,
        transport,
        definition,
        tools,
        resources,
        lastUsedAt: Date.now(),
        inFlight: 0,
        status: "connected",
        lifecycle: new AbortController(),
      };
    } catch (error) {
      // Check for UnauthorizedError - server requires OAuth
      if (error instanceof UnauthorizedError && supportsOAuth(definition)) {
        // Clean up both client and transport before reporting needs-auth.
        await closeResource(client, `${name} client`);
        await closeResource(transport, `${name} transport`);

        return {
          client,
          transport,
          definition,
          tools: [],
          resources: [],
          lastUsedAt: Date.now(),
          inFlight: 0,
          status: "needs-auth",
          lifecycle: new AbortController(),
        };
      }

      // Clean up both client and transport on any error
      await closeResource(client, `${name} client`);
      await closeResource(transport, `${name} transport`);
      throw error;
    }
  }

  private buildClientCapabilities() {
    return {
      ...(this.samplingConfig ? { sampling: {} } : {}),
      ...(this.elicitationConfig
        ? {
            elicitation: {
              form: {},
              ...(this.elicitationConfig.allowUrl ? { url: {} } : {}),
            },
          }
        : {}),
    };
  }

  private createClient(serverName: string): Client {
    const capabilities = this.buildClientCapabilities();
    const client = new Client(
      { name: `pi-mcp-${serverName}`, version: "1.0.0" },
      Object.keys(capabilities).length > 0 ? { capabilities } : undefined,
    );
    if (this.samplingConfig) {
      registerSamplingHandler(client, { ...this.samplingConfig, serverName });
    }
    if (this.elicitationConfig) {
      registerElicitationHandler(client, {
        ...this.elicitationConfig,
        serverName,
        onUrlAccepted: elicitationId => this.rememberUrlElicitation(serverName, elicitationId),
      });
      if (this.elicitationConfig.allowUrl) {
        client.setNotificationHandler(ElicitationCompleteNotificationSchema, notification => {
          const accepted = this.acceptedUrlElicitations.get(serverName);
          if (!accepted?.delete(notification.params.elicitationId)) return;
          this.elicitationConfig?.ui.notify(
            `MCP browser interaction for ${serverName} completed. You can retry the tool now.`,
            "info",
          );
        });
      }
    }
    return client;
  }

  async handleUrlElicitationRequired(
    serverName: string,
    error: UrlElicitationRequiredError,
  ): Promise<"accept" | "decline" | "cancel"> {
    if (!this.elicitationConfig?.allowUrl) return "cancel";
    for (const params of error.elicitations) {
      const result = await handleUrlElicitation({
        ...this.elicitationConfig,
        serverName,
        onUrlAccepted: elicitationId => this.rememberUrlElicitation(serverName, elicitationId),
      }, params);
      if (result.action !== "accept") return result.action;
    }
    return "accept";
  }

  private rememberUrlElicitation(serverName: string, elicitationId: string): void {
    let accepted = this.acceptedUrlElicitations.get(serverName);
    if (!accepted) {
      accepted = new Set();
      this.acceptedUrlElicitations.set(serverName, accepted);
    }
    accepted.add(elicitationId);
  }

  private async createHttpTransport(
    definition: ServerDefinition,
    serverName: string,
    signal?: AbortSignal,
    trackStartupResource?: TrackStartupResource,
  ): Promise<Transport> {
    throwIfAborted(signal);
    const url = new URL(definition.url!);

    // Build headers first (including any bearer token)
    const headers = resolveHeaders(definition.headers) ?? {};

    // For bearer auth, add the token to headers BEFORE creating requestInit
    if (definition.auth === "bearer") {
      const token = resolveBearerToken(definition);
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
    }

    // Create request init with headers (Authorization now included for bearer auth)
    const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;

    // For OAuth servers, create an auth provider
    let authProvider: McpOAuthProvider | undefined;
    if (supportsOAuth(definition)) {
      const oauthConfig = extractOAuthConfig(definition);
      authProvider = new McpOAuthProvider(
        serverName,
        definition.url!,
        oauthConfig,
        {
          onRedirect: async (_authUrl) => {
            // URL is captured by startAuth, no need to log
          },
        }
      );
    }

    // Try StreamableHTTP first (modern MCP servers)
    const streamableTransport = new StreamableHTTPClientTransport(url, {
      requestInit,
      authProvider,
    });
    trackStartupResource?.(streamableTransport, `${serverName} Streamable HTTP probe transport`);

    try {
      // Create a test client to verify the transport works
      const testClient = new Client({ name: "pi-mcp-probe", version: "2.1.2" });
      trackStartupResource?.(testClient, `${serverName} Streamable HTTP probe client`);
      await testClient.connect(streamableTransport, this.buildRequestOptions(definition, signal));
      await closeResource(testClient, "Streamable HTTP probe client");
      // Close probe transport before creating fresh one
      await closeResource(streamableTransport, "Streamable HTTP probe transport");

      // StreamableHTTP works - create fresh transport for actual use
      return new StreamableHTTPClientTransport(url, { requestInit, authProvider });
    } catch (error) {
      // StreamableHTTP failed, close and try SSE fallback
      await closeResource(streamableTransport, "failed Streamable HTTP transport");

      // Host cancellation is not transport capability evidence; do not fall
      // through to SSE when the caller is trying to cancel the connect.
      if (signal?.aborted) {
        throwIfAborted(signal);
      }

      // If this was an UnauthorizedError, don't try SSE - the server needs auth
      if (error instanceof UnauthorizedError) {
        throw error;
      }

      // SSE is the legacy transport
      const sseTransport = new SSEClientTransport(url, { requestInit, authProvider });
      trackStartupResource?.(sseTransport, `${serverName} SSE transport`);
      return sseTransport;
    }
  }

  private async fetchAllTools(client: Client, requestOptions?: RequestOptions): Promise<McpTool[]> {
    return collectPaginatedMcpItems(
      "tools",
      async (cursor) => {
        const result = await client.listTools(cursor ? { cursor } : undefined, requestOptions);
        return { items: result.tools ?? [], nextCursor: result.nextCursor };
      },
      requestOptions?.signal,
    );
  }

  private async fetchAllResources(client: Client, requestOptions?: RequestOptions): Promise<McpResource[]> {
    try {
      return await collectPaginatedMcpItems(
        "resources",
        async (cursor) => {
          const result = await client.listResources(cursor ? { cursor } : undefined, requestOptions);
          return { items: result.resources ?? [], nextCursor: result.nextCursor };
        },
        requestOptions?.signal,
      );
    } catch (error) {
      if (requestOptions?.signal?.aborted) {
        throwIfAborted(requestOptions.signal);
      }
      if (error instanceof McpDiscoveryPaginationError) {
        throw error;
      }
      // Server may not support resources
      return [];
    }
  }

  private attachAdapterNotificationHandlers(serverName: string, client: Client): void {
    const notificationClient = client as unknown as {
      setNotificationHandler(
        schema: unknown,
        handler: (notification: ServerStreamResultPatchNotification) => void,
      ): void;
    };
    notificationClient.setNotificationHandler(serverStreamResultPatchNotificationSchema, (notification) => {
      const listener = this.uiStreamListeners.get(notification.params.streamToken);
      if (!listener) return;
      listener(serverName, notification.params);
    });
  }

  registerUiStreamListener(streamToken: string, listener: UiStreamListener): void {
    this.uiStreamListeners.set(streamToken, listener);
  }

  removeUiStreamListener(streamToken: string): void {
    this.uiStreamListeners.delete(streamToken);
  }

  async readResource(name: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
    const lease = this.acquireConnection(name, signal);
    if (!lease) {
      throw new Error(`Server "${name}" is not connected`);
    }

    try {
      return await lease.connection.client.readResource({ uri }, lease.requestOptions);
    } finally {
      lease.release();
    }
  }

  async close(name: string): Promise<void> {
    // Generation-owned shutdown order: fence the visible connection first,
    // then cancel/settle pending startup and reclaim both generations. A
    // concurrent connect() must never reuse a connection close() already owns.
    const connection = this.connections.get(name);
    if (connection) {
      connection.status = "closed";
      this.connections.delete(name);
      this.acceptedUrlElicitations.delete(name);
    }

    const pending = this.connectPromises.get(name);
    if (pending) {
      // Fence first: abort and remove the reservation before any deadline wait,
      // so its completion can never publish into this or a replacement lifecycle.
      pending.controller.abort(new Error(`Server "${name}" startup aborted during close.`));
      this.connectPromises.delete(name);
      const outcome = await waitForSettlementUntilDeadline(
        pending.promise,
        this.startupDrainTimeoutMs,
      );
      if (outcome === "deadline") {
        logger.error(
          "MCP server startup drain deadline exceeded; cleanup detached",
          new Error(`Server "${name}" startup ignored shutdown for ${this.startupDrainTimeoutMs}ms.`),
          { server: name, timeoutMs: this.startupDrainTimeoutMs },
        );
        this.forceClosePendingResources(pending);
      }
    }

    if (!connection) return;
    connection.lifecycle ??= new AbortController();
    connection.lifecycle.abort(new Error(`Server "${name}" is closing.`));
    const drainOutcome = await waitForSettlementUntilDeadline(
      this.waitForConnectionDrain(connection),
      this.connectionLeaseDrainTimeoutMs,
    );
    if (drainOutcome === "deadline") {
      logger.error(
        "MCP connection lease drain deadline exceeded; forcing resource close",
        new Error(
          `Server "${name}" retained ${this.connectionLeaseCounts.get(connection) ?? 0} lease(s) after ${this.connectionLeaseDrainTimeoutMs}ms.`,
        ),
        { server: name, timeoutMs: this.connectionLeaseDrainTimeoutMs },
      );
      this.forceCloseConnection(connection, name);
      return;
    }
    await Promise.all([
      closeResource(connection.client, `${name} client`, this.resourceCloseTimeoutMs),
      closeResource(connection.transport, `${name} transport`, this.resourceCloseTimeoutMs),
    ]);
  }

  private forceClosePendingResources(pending: PendingConnect): void {
    pending.forcedClosing = true;
    for (const [resource, tracked] of pending.resources) {
      void closeTrackedStartupResource(pending.resources, resource, tracked.description);
    }
  }

  private forceCloseConnection(connection: ServerConnection, name: string): void {
    void closeResource(connection.client, `${name} client`, this.resourceCloseTimeoutMs);
    void closeResource(connection.transport, `${name} transport`, this.resourceCloseTimeoutMs);
  }

  async closeAll(): Promise<void> {
    const names = [...new Set([...this.connections.keys(), ...this.connectPromises.keys()])];
    await Promise.all(names.map(name => this.close(name)));
  }

  getConnection(name: string): ServerConnection | undefined {
    return this.connections.get(name);
  }

  getAllConnections(): Map<string, ServerConnection> {
    return new Map(this.connections);
  }

  touch(name: string): void {
    const connection = this.connections.get(name);
    if (connection) {
      connection.lastUsedAt = Date.now();
    }
  }

  acquireConnection(name: string, signal?: AbortSignal): ServerConnectionLease | undefined {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") return undefined;
    connection.inFlight += 1;
    this.connectionLeaseCounts.set(connection, (this.connectionLeaseCounts.get(connection) ?? 0) + 1);
    connection.lastUsedAt = Date.now();
    let released = false;
    return {
      connection,
      requestOptions: this.requestOptionsForConnection(connection, signal),
      release: () => {
        if (released) return;
        released = true;
        connection.inFlight = Math.max(0, connection.inFlight - 1);
        const remainingLeases = Math.max(0, (this.connectionLeaseCounts.get(connection) ?? 1) - 1);
        if (remainingLeases === 0) this.connectionLeaseCounts.delete(connection);
        else this.connectionLeaseCounts.set(connection, remainingLeases);
        connection.lastUsedAt = Date.now();
        if (remainingLeases !== 0) return;
        const waiters = this.connectionDrainWaiters.get(connection);
        if (!waiters) return;
        this.connectionDrainWaiters.delete(connection);
        for (const settle of waiters) settle();
      },
    };
  }

  private waitForConnectionDrain(connection: ServerConnection): Promise<void> {
    if ((this.connectionLeaseCounts.get(connection) ?? 0) <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.connectionDrainWaiters.get(connection) ?? new Set<() => void>();
      waiters.add(resolve);
      this.connectionDrainWaiters.set(connection, waiters);
    });
  }

  /** @deprecated Use acquireConnection() so release targets the same identity. */
  incrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection) {
      connection.inFlight = (connection.inFlight ?? 0) + 1;
    }
  }

  /** @deprecated Use the lease release() so reconnect cannot retarget cleanup. */
  decrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection && connection.inFlight) {
      connection.inFlight--;
    }
  }

  isIdle(name: string, timeoutMs: number): boolean {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") return false;
    if (connection.inFlight > 0) return false;
    return (Date.now() - connection.lastUsedAt) > timeoutMs;
  }
}

/**
 * Resolve environment variables with interpolation.
 */
function resolveEnv(env?: Record<string, string>): Record<string, string> {
  // Copy process.env, filtering out undefined values
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      resolved[key] = value;
    }
  }

  if (!env) return resolved;

  const overrides = interpolateEnvRecord(env);
  return overrides ? { ...resolved, ...overrides } : resolved;
}

/**
 * Resolve headers with environment variable interpolation.
 */
function resolveHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  return interpolateEnvRecord(headers);
}

function normalizeRequestTimeoutMs(timeoutMs: number | undefined): number | undefined {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : undefined;
}

function normalizeDrainTimeoutMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
