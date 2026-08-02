import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import { Type } from "typebox";
import { showStatus, showTools, reconnectServers, authenticateServer, logoutServer, openMcpAuthPanel, openMcpManager, openMcpPanel, openMcpSetup } from "./commands.ts";
import { loadMcpConfig } from "./config.ts";
import { buildProxyDescription, createDirectToolExecutor, getMissingConfiguredDirectToolServers, resolveDirectTools } from "./direct-tools.ts";
import { flushMetadataCache, initializeMcp, updateStatusBar } from "./init.ts";
import { loadMetadataCache } from "./metadata-cache.ts";
import { executeAuthComplete, executeAuthStart, executeCall, executeConnect, executeDescribe, executeList, executeSearch, executeStatus, executeUiMessages } from "./proxy-modes.ts";
import { getConfigPathFromArgv, normalizeDirectToolInputSchema, truncateAtWord } from "./utils.ts";
import { initializeOAuth, shutdownOAuth } from "./mcp-auth-flow.ts";
import { createMcpDirectToolCallRenderer, createMcpDirectToolResultRenderer, renderMcpProxyToolCall, renderMcpProxyToolResult } from "./tool-result-renderer.ts";
import { toolErrorOverride } from "./error-signal.ts";

export interface McpAdapterHandle {
  openManager(ctx: ExtensionContext): Promise<void>;
}

export interface McpSessionLifecycleOptions {
  initializationDrainTimeoutMs?: number;
}

const DEFAULT_INITIALIZATION_DRAIN_TIMEOUT_MS = 5_000;

async function waitUntilDeadline(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<"settled" | "deadline"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => "settled" as const),
      new Promise<"deadline">((resolve) => {
        timeout = setTimeout(() => resolve("deadline"), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

interface InitializationRecord<T> {
  generation: number;
  controller: AbortController;
  promise: Promise<T>;
  completion: Promise<void>;
  cleanupReason: string;
}

export class McpSessionLifecycle<T> {
  private generation = 0;
  private operationTail: Promise<void> = Promise.resolve();
  private state: T | null = null;
  private initialization: InitializationRecord<T> | null = null;

  constructor(
    private readonly dispose: (state: T, reason: string) => Promise<void>,
    private readonly onStateChange: (state: T | null) => void,
    private readonly onInitPromiseChange: (promise: Promise<T> | null) => void,
    private readonly onReady: (state: T) => void,
    private readonly onError: (message: string, error: unknown) => void,
    options: McpSessionLifecycleOptions = {},
  ) {
    this.initializationDrainTimeoutMs = normalizeDrainTimeoutMs(
      options.initializationDrainTimeoutMs,
      DEFAULT_INITIALIZATION_DRAIN_TIMEOUT_MS,
    );
  }

  private readonly initializationDrainTimeoutMs: number;

  restart(
    reason: string,
    prepare: () => Promise<void>,
    initialize: (signal: AbortSignal) => Promise<T>,
  ): Promise<void> {
    const generation = ++this.generation;
    this.abortInitialization(reason);
    return this.enqueue(async () => {
      await this.disposeOwned(reason);
      if (generation !== this.generation) return;
      await prepare();
      if (generation !== this.generation) return;
      this.beginInitialization(generation, initialize);
    });
  }

  shutdown(reason: string, prepare: () => Promise<void>): Promise<void> {
    ++this.generation;
    this.abortInitialization(reason);
    return this.enqueue(async () => {
      const results = await Promise.allSettled([
        this.disposeOwned(reason),
        prepare(),
      ]);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    });
  }

  async awaitInitializedState(): Promise<T | null> {
    if (this.state) return this.state;
    const record = this.initialization;
    if (!record) return null;
    const resolved = await record.promise;
    if (record.generation !== this.generation || this.initialization !== record) return this.state;
    return this.state ?? resolved;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.catch(() => {});
    return result;
  }

  private abortInitialization(reason: string): void {
    const record = this.initialization;
    if (!record) return;
    record.cleanupReason = reason;
    record.controller.abort(new Error(`MCP initialization aborted: ${reason}`));
  }

  private beginInitialization(
    generation: number,
    initialize: (signal: AbortSignal) => Promise<T>,
  ): void {
    const controller = new AbortController();
    const promise = initialize(controller.signal);
    const record: InitializationRecord<T> = {
      generation,
      controller,
      promise,
      completion: Promise.resolve(),
      cleanupReason: "stale_session_start",
    };
    this.initialization = record;
    this.onInitPromiseChange(promise);

    record.completion = promise.then(async (nextState) => {
      if (generation !== this.generation || this.initialization !== record) {
        await this.dispose(nextState, record.cleanupReason);
        return;
      }
      this.state = nextState;
      this.initialization = null;
      this.onStateChange(nextState);
      this.onInitPromiseChange(null);
      try {
        this.onReady(nextState);
      } catch (error) {
        this.onError("MCP initialization completion failed", error);
      }
    }, (error) => {
      if (this.initialization === record) {
        this.initialization = null;
        this.onInitPromiseChange(null);
      }
      if (!controller.signal.aborted) {
        this.onError("MCP initialization failed", error);
      }
    });
  }

  private async disposeOwned(reason: string): Promise<void> {
    const currentState = this.state;
    const record = this.initialization;
    this.state = null;
    this.initialization = null;
    this.onStateChange(null);
    this.onInitPromiseChange(null);
    if (record) {
      record.cleanupReason = reason;
      record.controller.abort(new Error(`MCP initialization aborted: ${reason}`));
    }

    const results = await Promise.allSettled([
      currentState ? this.dispose(currentState, reason) : Promise.resolve(),
      record ? this.drainInitialization(record, reason) : Promise.resolve(),
    ]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private async drainInitialization(record: InitializationRecord<T>, reason: string): Promise<void> {
    const completion = record.completion;
    const outcome = await waitUntilDeadline(completion, this.initializationDrainTimeoutMs);
    if (outcome === "settled") return;

    void completion.catch((error) => {
      this.emitTerminalDiagnostic("MCP detached initialization cleanup failed", error);
    });
    this.emitTerminalDiagnostic(
      "MCP initialization cleanup deadline exceeded",
      new Error(
        `MCP initialization did not settle within ${this.initializationDrainTimeoutMs}ms during ${reason}; late cleanup detached.`,
      ),
    );
  }

  private emitTerminalDiagnostic(message: string, error: unknown): void {
    try {
      this.onError(message, error);
    } catch (diagnosticError) {
      console.error(`${message}: diagnostic handler failed`, diagnosticError);
    }
  }
}

function normalizeDrainTimeoutMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export default function mcpAdapter(pi: ExtensionAPI): McpAdapterHandle {
  let state: McpExtensionState | null = null;
  let initPromise: Promise<McpExtensionState> | null = null;

  async function shutdownState(currentState: McpExtensionState | null, reason: string): Promise<void> {
    if (!currentState) return;

    if (currentState.uiServer) {
      currentState.uiServer.close(reason);
      currentState.uiServer = null;
    }

    let flushError: unknown;
    try {
      flushMetadataCache(currentState);
    } catch (error) {
      flushError = error;
    }

    try {
      await currentState.lifecycle.gracefulShutdown();
    } catch (error) {
      if (flushError) {
        console.error("MCP: graceful shutdown failed after metadata flush error", error);
      } else {
        throw error;
      }
    }

    if (flushError) {
      throw flushError;
    }
  }

  const sessionLifecycle = new McpSessionLifecycle<McpExtensionState>(
    shutdownState,
    (nextState) => { state = nextState; },
    (nextPromise) => { initPromise = nextPromise; },
    updateStatusBar,
    (message, error) => { console.error(`${message}:`, error); },
  );

  async function awaitInitializedState(): Promise<McpExtensionState | null> {
    return sessionLifecycle.awaitInitializedState();
  }

  const earlyConfigPath = getConfigPathFromArgv();
  // Extension registration happens before a session context can establish workspace trust.
  // Only explicit/global MCP config may contribute direct tools at this stage.
  const earlyConfig = loadMcpConfig(earlyConfigPath, process.cwd(), { includeProject: false });
  const earlyCache = loadMetadataCache();
  const prefix = earlyConfig.settings?.toolPrefix ?? "server";

  const envRaw = process.env.MCP_DIRECT_TOOLS;
  const directSpecs = envRaw === "__none__"
    ? []
    : resolveDirectTools(
        earlyConfig,
        earlyCache,
        prefix,
        envRaw?.split(",").map(s => s.trim()).filter(Boolean),
      );
  const missingConfiguredDirectToolServers = getMissingConfiguredDirectToolServers(earlyConfig, earlyCache);
  const shouldRegisterProxyTool =
    earlyConfig.settings?.disableProxyTool !== true
    || directSpecs.length === 0
    || missingConfiguredDirectToolServers.length > 0;

  for (const spec of directSpecs) {
    (pi.registerTool as (tool: unknown) => unknown)({
      name: spec.prefixedName,
      label: `MCP: ${spec.originalName}`,
      description: spec.description || "(no description)",
      promptSnippet: truncateAtWord(spec.description, 100) || `MCP tool from ${spec.serverName}`,
      parameters: Type.Unsafe(normalizeDirectToolInputSchema(spec.inputSchema) as never),
      renderShell: "self",
      execute: createDirectToolExecutor(() => state, () => initPromise, spec),
      renderCall: createMcpDirectToolCallRenderer(spec.prefixedName),
      renderResult: createMcpDirectToolResultRenderer(spec.prefixedName),
    });
  }

  const getPiTools = (): ToolInfo[] => pi.getAllTools();

  pi.registerFlag("mcp-config", {
    description: "Path to MCP config file",
    type: "string",
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      await sessionLifecycle.restart(
        "session_restart",
        async () => {
          await shutdownOAuth();
          await initializeOAuth().catch(err => {
            console.error("MCP OAuth initialization failed:", err);
          });
        },
        (lifecycleSignal) => {
          const signal = ctx.signal
            ? AbortSignal.any([ctx.signal, lifecycleSignal])
            : lifecycleSignal;
          const initContext = new Proxy(ctx, {
            get(target, property) {
              if (property === "signal") return signal;
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          return initializeMcp(pi, initContext);
        },
      );
    } catch (error) {
      console.error("MCP: failed to replace previous session state", error);
    }
  });

  pi.on("session_shutdown", async () => {
    try {
      await sessionLifecycle.shutdown("session_shutdown", shutdownOAuth);
    } catch (error) {
      console.error("MCP: session shutdown cleanup failed", error);
    }
  });

  // Re-flag returned MCP tool failures so pi registers them as errors (see toolErrorOverride).
  pi.on("tool_result", (event) => toolErrorOverride(event.details));

  pi.registerCommand("mcp", {
    description: "管理 MCP 服务与配置",
    handler: async (args, ctx) => {
      if (!state && initPromise) {
        try {
          state = await awaitInitializedState();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
          return;
        }
      }
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }

      const parts = args?.trim()?.split(/\s+/) ?? [];
      const subcommand = parts[0] ?? "";
      const targetServer = parts[1];
      const rest = parts.slice(1).join(" ");

      switch (subcommand) {
        case "reconnect":
          await reconnectServers(state, ctx, targetServer);
          break;
        case "tools":
          await showTools(state, ctx);
          break;
        case "direct": {
          const result = await openMcpPanel(state, pi, ctx, earlyConfigPath);
          if (result?.configChanged) {
            await ctx.reload();
            return;
          }
          break;
        }
        case "setup": {
          const result = await openMcpSetup(state, pi, ctx, earlyConfigPath, "setup");
          if (result?.configChanged) {
            await ctx.reload();
            return;
          }
          break;
        }
        case "manage":
        case "manager": {
          const result = await openMcpManager(state, pi, ctx, earlyConfigPath);
          if (result.configChanged) {
            await ctx.reload();
            return;
          }
          break;
        }
        case "config":
        case "配置": {
          const result = await openMcpManager(state, pi, ctx, earlyConfigPath);
          if (result.configChanged) {
            await ctx.reload();
            return;
          }
          break;
        }
        case "logout": {
          const serverName = rest;
          if (!serverName) {
            if (ctx.hasUI) ctx.ui.notify("Usage: /mcp logout <server>", "error");
            return;
          }
          await logoutServer(serverName, state, ctx);
          break;
        }
        case "status":
        case "":
        default:
          if (ctx.hasUI) {
            const result = await openMcpManager(state, pi, ctx, earlyConfigPath);
            if (result?.configChanged) {
              await ctx.reload();
              return;
            }
          } else {
            await showStatus(state, ctx);
          }
          break;
      }
    },
  });

  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an MCP server (OAuth)",
    handler: async (args, ctx) => {
      const serverName = args?.trim();
      if (!serverName && !ctx.hasUI) {
        return;
      }

      if (!state && initPromise) {
        try {
          state = await awaitInitializedState();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
          return;
        }
      }
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }

      if (!serverName) {
        await openMcpAuthPanel(state, pi, ctx, earlyConfigPath);
        return;
      }

      await authenticateServer(serverName, state.config, ctx);
    },
  });

  if (shouldRegisterProxyTool) {
    (pi.registerTool as (tool: unknown) => unknown)({
      name: "mcp",
      label: "MCP",
      description: buildProxyDescription(earlyConfig, earlyCache, directSpecs),
      promptSnippet: "MCP gateway - connect to MCP servers and call their tools",
      renderShell: "self",
      renderCall: renderMcpProxyToolCall,
      parameters: Type.Object({
        tool: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'xcodebuild_list_sims')" })),
        args: Type.Optional(Type.String({ description: "Arguments as JSON string (e.g., '{\"key\": \"value\"}')" })),
        connect: Type.Optional(Type.String({ description: "Server name to connect (lazy connect + metadata refresh)" })),
        describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)" })),
        search: Type.Optional(Type.String({ description: "Search tools by name/description" })),
        regex: Type.Optional(Type.Boolean({ description: "Treat search as regex (default: substring match)" })),
        includeSchemas: Type.Optional(Type.Boolean({ description: "Include parameter schemas in search results (default: true)" })),
        server: Type.Optional(Type.String({ description: "Filter to specific server (also disambiguates tool calls)" })),
        action: Type.Optional(Type.String({ description: "Action: 'ui-messages', 'auth-start', or 'auth-complete'" })),
      }),
      renderResult: renderMcpProxyToolResult,
      async execute(_toolCallId: string, params: {
        tool?: string;
        args?: string;
        connect?: string;
        describe?: string;
        search?: string;
        regex?: boolean;
        includeSchemas?: boolean;
        server?: string;
        action?: string;
      }, signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) {
        let parsedArgs: Record<string, unknown> | undefined;
        if (params.args) {
          try {
            parsedArgs = JSON.parse(params.args);
            if (typeof parsedArgs !== "object" || parsedArgs === null || Array.isArray(parsedArgs)) {
              const gotType = Array.isArray(parsedArgs) ? "array" : parsedArgs === null ? "null" : typeof parsedArgs;
              throw new Error(`Invalid args: expected a JSON object, got ${gotType}`);
            }
          } catch (error) {
            if (error instanceof SyntaxError) {
              throw new Error(`Invalid args JSON: ${error.message}`, { cause: error });
            }
            throw error;
          }
        }

        if (!state && initPromise) {
          try {
            state = await awaitInitializedState();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
              details: { error: "init_failed", message },
            };
          }
        }
        if (!state) {
          return {
            content: [{ type: "text" as const, text: "MCP not initialized" }],
            details: { error: "not_initialized" },
          };
        }

        if (params.action === "ui-messages") {
          return executeUiMessages(state);
        }
        if (params.action === "auth-start") {
          if (!params.server) {
            return {
              content: [{ type: "text" as const, text: "auth-start requires `server`. Example: mcp({ action: \"auth-start\", server: \"linear-server\" })" }],
              details: { mode: "auth-start", error: "missing_server" },
            };
          }
          return executeAuthStart(state, params.server);
        }
        if (params.action === "auth-complete") {
          if (!params.server) {
            return {
              content: [{ type: "text" as const, text: "auth-complete requires `server`." }],
              details: { mode: "auth-complete", error: "missing_server" },
            };
          }
          const input = parsedArgs?.redirectUrl ?? parsedArgs?.code ?? parsedArgs?.input;
          if (typeof input !== "string" || input.trim().length === 0) {
            return {
              content: [{ type: "text" as const, text: "auth-complete requires args with `redirectUrl`, `code`, or `input`." }],
              details: { mode: "auth-complete", error: "missing_input" },
            };
          }
          return executeAuthComplete(state, params.server, input);
        }
        if (params.tool) {
          return executeCall(state, params.tool, parsedArgs, params.server, getPiTools, signal);
        }
        if (params.connect) {
          return executeConnect(state, params.connect, signal);
        }
        if (params.describe) {
          return executeDescribe(state, params.describe);
        }
        if (params.search) {
          return executeSearch(state, params.search, params.regex, params.server, params.includeSchemas);
        }
        if (params.server) {
          return executeList(state, params.server);
        }
        return executeStatus(state);
      },
    });
  }

  return {
    async openManager(ctx) {
      if (!state && initPromise) {
        try {
          state = await awaitInitializedState();
        } catch (error) {
          ctx.ui.notify(`MCP initialization failed: ${error instanceof Error ? error.message : String(error)}`, "error");
          return;
        }
      }
      if (!state) {
        ctx.ui.notify("MCP not initialized", "error");
        return;
      }
      const result = await openMcpManager(state, pi, ctx, earlyConfigPath);
      if (result.configChanged) ctx.ui.notify("MCP changes will apply after the extension reloads.", "info");
    },
  };
}
