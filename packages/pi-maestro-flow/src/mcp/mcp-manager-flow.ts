import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { McpManagerOverlay, type McpManagerAction, type McpManagerServerView, type McpManagerStatus, type McpManagerUiState } from "./mcp-manager.ts";
import {
  McpManagerStore,
  type McpConfigScope,
  type McpManagedServer,
  type McpManagerSnapshot,
  validateServerName,
} from "./mcp-manager-store.ts";
import type { ServerEntry } from "./types.ts";

export interface McpManagerRuntime {
  status(serverName: string): McpManagerStatus;
  toolNames(serverName: string): string[];
  canAuthenticate(serverName: string): boolean;
  reconnect(serverName: string): Promise<boolean>;
  authenticate(serverName: string): Promise<{ ok: boolean; message?: string }>;
}

export interface McpManagerFlowResult {
  configChanged: boolean;
}

export async function runMcpManager(
  ctx: ExtensionContext,
  store: McpManagerStore,
  runtime: McpManagerRuntime,
): Promise<McpManagerFlowResult> {
  let snapshot = await store.load();
  let uiState: Partial<McpManagerUiState> = { scope: "all", detail: false, query: "" };
  let notice = snapshot.servers.length === 0 ? "No servers yet · press A to add one" : undefined;
  let configChanged = false;

  while (true) {
    const action = await openManagerOverlay(ctx, buildViews(snapshot, runtime), uiState, notice);
    uiState = action.uiState;
    if (action.kind === "close") break;
    const selected = action.serverName
      ? snapshot.servers.find((server) => server.name === action.serverName)
      : undefined;

    if (action.kind === "add" || action.kind === "edit") {
      if (action.kind === "edit" && !selected) {
        notice = "Cannot edit · no server selected";
        continue;
      }
      try {
        const draft = await promptForServer(ctx, action.kind === "edit" ? selected : undefined);
        if (!draft) {
          notice = "Edit cancelled · no changes saved";
          continue;
        }
        ctx.ui.setStatus("mcp-manager", `MCP · Saving ${draft.name}…`);
        snapshot = await store.save({
          previousName: selected?.readOnly ? undefined : selected?.name,
          name: draft.name,
          entry: draft.entry,
          scope: draft.scope,
          allowImportedOverride: selected?.readOnly === true,
        });
        configChanged = true;
        uiState = { ...uiState, selectedName: draft.name };
        notice = `Saved · ${draft.name} · reload pending`;
      } catch (error) {
        notice = `Save failed · ${errorMessage(error)}`;
      } finally {
        ctx.ui.setStatus("mcp-manager", undefined);
      }
      continue;
    }

    if (!selected) {
      notice = `Cannot ${action.kind} · no server selected`;
      continue;
    }

    if (action.kind === "delete") {
      if (selected.readOnly) {
        notice = `Cannot delete · ${selected.name} is imported and read-only`;
        continue;
      }
      const confirmed = await ctx.ui.confirm(
        `Delete MCP server "${selected.name}"?`,
        `This removes the ${scopeLabel(selected.scope)} configuration from:\n${selected.path}\nOther MCP servers are unchanged.`,
      );
      if (!confirmed) {
        notice = "Delete cancelled · server kept";
        continue;
      }
      try {
        ctx.ui.setStatus("mcp-manager", `MCP · Deleting ${selected.name}…`);
        snapshot = await store.delete(selected);
        configChanged = true;
        uiState = { ...uiState, selectedName: undefined, detail: false };
        notice = `Deleted · ${selected.name} · reload pending`;
      } catch (error) {
        notice = `Delete failed · ${errorMessage(error)}`;
      } finally {
        ctx.ui.setStatus("mcp-manager", undefined);
      }
      continue;
    }

    if (action.kind === "reconnect") {
      ctx.ui.setStatus("mcp-manager", `MCP · Connecting ${selected.name}…`);
      try {
        const connected = await runtime.reconnect(selected.name);
        notice = connected ? `Connected · ${selected.name}` : `Reconnect failed · ${selected.name}`;
      } catch (error) {
        notice = `Reconnect failed · ${errorMessage(error)}`;
      } finally {
        ctx.ui.setStatus("mcp-manager", undefined);
      }
      continue;
    }

    if (action.kind === "authenticate") {
      if (!runtime.canAuthenticate(selected.name)) {
        notice = `Cannot authenticate · ${selected.name} does not use OAuth`;
        continue;
      }
      ctx.ui.setStatus("mcp-manager", `MCP · Authenticating ${selected.name}…`);
      try {
        const result = await runtime.authenticate(selected.name);
        notice = result.ok
          ? `Authenticated · ${selected.name}`
          : `Authentication failed · ${result.message ?? selected.name}`;
      } catch (error) {
        notice = `Authentication failed · ${errorMessage(error)}`;
      } finally {
        ctx.ui.setStatus("mcp-manager", undefined);
      }
    }
  }

  return { configChanged };
}

async function openManagerOverlay(
  ctx: ExtensionContext,
  servers: McpManagerServerView[],
  initialState: Partial<McpManagerUiState>,
  notice: string | undefined,
): Promise<McpManagerAction> {
  return ctx.ui.custom<McpManagerAction>((tui, theme, _keybindings, done) => new McpManagerOverlay({
    servers,
    theme,
    notice,
    initialState,
    requestRender: () => tui.requestRender(),
    done,
  }), {
    overlay: true,
    overlayOptions: { anchor: "center", width: "94%", maxHeight: "92%" },
  });
}

function buildViews(snapshot: McpManagerSnapshot, runtime: McpManagerRuntime): McpManagerServerView[] {
  return snapshot.servers.map((server) => ({
    ...server,
    status: runtime.status(server.name),
    toolNames: runtime.toolNames(server.name),
    canAuthenticate: runtime.canAuthenticate(server.name),
  }));
}

interface ServerDraft {
  name: string;
  scope: McpConfigScope;
  entry: ServerEntry;
}

async function promptForServer(ctx: ExtensionContext, current?: McpManagedServer): Promise<ServerDraft | undefined> {
  const copyImported = current?.readOnly === true;
  const nameInput = await ctx.ui.input(
    copyImported ? "Copy imported MCP server as User override" : current ? "MCP server name" : "New MCP server name",
    current?.name ?? "",
  );
  if (nameInput === undefined) return undefined;
  const name = validateServerName(nameInput);

  const currentTransport = current?.entry.url ? "HTTP" : "stdio";
  const transport = await selectCurrentFirst(ctx, "Transport", currentTransport, ["stdio", "HTTP"] as const);
  if (!transport) return undefined;

  let scope: McpConfigScope;
  if (current && !copyImported) {
    scope = current.scope as McpConfigScope;
  } else {
    const selectedScope = await selectScope(ctx);
    if (!selectedScope) return undefined;
    scope = selectedScope;
  }

  const lifecycle = await selectCurrentFirst(
    ctx,
    "Lifecycle",
    current?.entry.lifecycle ?? "lazy",
    ["lazy", "keep-alive", "eager"] as const,
  );
  if (!lifecycle) return undefined;

  const currentDirectMode = Array.isArray(current?.entry.directTools)
    ? "Keep selected direct tools"
    : current?.entry.directTools === true ? "Direct + proxy" : "Proxy only";
  const directMode = await selectCurrentFirst(
    ctx,
    "Tool exposure",
    currentDirectMode,
    ["Proxy only", "Direct + proxy", "Keep selected direct tools"] as const,
  );
  if (!directMode) return undefined;

  const resources = await selectCurrentFirst(
    ctx,
    "MCP resources",
    current?.entry.exposeResources ? "Expose as tools" : "Keep hidden",
    ["Keep hidden", "Expose as tools"] as const,
  );
  if (!resources) return undefined;

  const timeoutInput = await ctx.ui.input(
    "Request timeout in milliseconds (blank = default)",
    current?.entry.requestTimeoutMs ? String(current.entry.requestTimeoutMs) : "",
  );
  if (timeoutInput === undefined) return undefined;
  const requestTimeoutMs = optionalPositiveInteger(timeoutInput, "Request timeout");

  const base: ServerEntry = {
    ...(current?.entry ?? {}),
    lifecycle,
    directTools: directMode === "Keep selected direct tools"
      ? current?.entry.directTools
      : directMode === "Direct + proxy",
    exposeResources: resources === "Expose as tools",
  };
  if (requestTimeoutMs) base.requestTimeoutMs = requestTimeoutMs;
  else delete base.requestTimeoutMs;

  let entry: ServerEntry;
  if (transport === "stdio") {
    const commandInput = await ctx.ui.input("Command", currentTransport === "stdio" ? current?.entry.command ?? "" : "");
    if (commandInput === undefined) return undefined;
    const command = required(commandInput, "Command");
    const argsInput = await ctx.ui.input(
      "Arguments as JSON array",
      currentTransport === "stdio" && current?.entry.args ? JSON.stringify(current.entry.args) : "[]",
    );
    if (argsInput === undefined) return undefined;
    const cwdInput = await ctx.ui.input("Working directory (blank = current project)", currentTransport === "stdio" ? current?.entry.cwd ?? "" : "");
    if (cwdInput === undefined) return undefined;
    const envInput = await ctx.ui.input(
      `Environment as JSON object${currentTransport === "stdio" && current?.entry.env ? " (blank keeps existing)" : ""}`,
      "",
    );
    if (envInput === undefined) return undefined;
    const env = envInput.trim()
      ? parseStringRecord(envInput, "Environment")
      : currentTransport === "stdio" ? current?.entry.env : undefined;
    entry = {
      ...base,
      command,
      args: parseStringArray(argsInput, "Arguments"),
      ...(cwdInput.trim() ? { cwd: cwdInput.trim() } : {}),
      ...(env ? { env } : {}),
    };
    if (!env) delete entry.env;
    delete entry.url;
    delete entry.headers;
    delete entry.auth;
    delete entry.bearerToken;
    delete entry.bearerTokenEnv;
    delete entry.oauth;
  } else {
    const urlInput = await ctx.ui.input("MCP server URL", currentTransport === "HTTP" ? current?.entry.url ?? "" : "");
    if (urlInput === undefined) return undefined;
    const url = normalizeHttpUrl(urlInput);
    const auth = await selectCurrentFirst(
      ctx,
      "Authentication",
      authChoice(current?.entry),
      ["Auto detect", "OAuth", "Bearer token from env", "No authentication"] as const,
    );
    if (!auth) return undefined;
    const headersInput = await ctx.ui.input(
      `Headers as JSON object${currentTransport === "HTTP" && current?.entry.headers ? " (blank keeps existing)" : ""}`,
      "",
    );
    if (headersInput === undefined) return undefined;
    const headers = headersInput.trim()
      ? parseStringRecord(headersInput, "Headers")
      : currentTransport === "HTTP" ? current?.entry.headers : undefined;
    let bearerTokenEnv: string | undefined;
    if (auth === "Bearer token from env") {
      const bearerInput = await ctx.ui.input("Bearer token environment variable", current?.entry.bearerTokenEnv ?? "MCP_TOKEN");
      if (bearerInput === undefined) return undefined;
      bearerTokenEnv = required(bearerInput, "Bearer token environment variable");
    }
    entry = {
      ...base,
      url,
      auth: auth === "OAuth" ? "oauth" : auth === "Bearer token from env" ? "bearer" : auth === "No authentication" ? false : undefined,
      ...(bearerTokenEnv ? { bearerTokenEnv } : {}),
      ...(headers ? { headers } : {}),
    };
    delete entry.command;
    delete entry.args;
    delete entry.env;
    delete entry.cwd;
    if (!headers) delete entry.headers;
    if (auth !== "OAuth") delete entry.oauth;
    if (auth !== "Bearer token from env") {
      delete entry.bearerToken;
      delete entry.bearerTokenEnv;
    }
    if (auth === "Auto detect") delete entry.auth;
  }

  const confirmed = await ctx.ui.confirm(
    `${current ? copyImported ? "Copy" : "Save" : "Add"} MCP server "${name}"?`,
    [
      `Scope: ${scopeLabel(scope)}`,
      `Transport: ${transport}`,
      transport === "stdio" ? `Command: ${entry.command}` : `URL: ${entry.url}`,
      `Lifecycle: ${entry.lifecycle}`,
      `Tools: ${entry.directTools ? "direct + proxy" : "proxy only"}`,
      `Resources: ${entry.exposeResources ? "exposed" : "hidden"}`,
    ].join("\n"),
  );
  return confirmed ? { name, scope, entry } : undefined;
}

async function selectScope(ctx: ExtensionContext): Promise<McpConfigScope | undefined> {
  const choice = await ctx.ui.select("Configuration scope", ["User · all projects", "Project · current workspace"]);
  if (choice === "User · all projects") return "user";
  if (choice === "Project · current workspace") return "project";
  return undefined;
}

async function selectCurrentFirst<T extends string>(
  ctx: ExtensionContext,
  title: string,
  current: T,
  choices: readonly T[],
): Promise<T | undefined> {
  const ordered = [current, ...choices.filter((choice) => choice !== current)];
  return await ctx.ui.select(title, ordered) as T | undefined;
}

export function parseStringArray(value: string, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "[]");
  } catch (error) {
    throw new Error(`${label} must be a JSON array. Example: ["-y", "server-package"]`, { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`${label} must contain only strings`);
  }
  return parsed;
}

export function parseStringRecord(value: string, label: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "{}");
  } catch (error) {
    throw new Error(`${label} must be a JSON object. Example: {"KEY":"value"}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const entries = Object.entries(parsed);
  if (!entries.every(([, item]) => typeof item === "string")) {
    throw new Error(`${label} values must all be strings`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export function normalizeHttpUrl(value: string): string {
  const normalized = required(value, "MCP server URL").replace(/\/+$/, "");
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("MCP server URL must use http or https");
  }
  return normalized;
}

function optionalPositiveInteger(value: string, label: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function authChoice(entry: ServerEntry | undefined): "Auto detect" | "OAuth" | "Bearer token from env" | "No authentication" {
  if (entry?.auth === "oauth") return "OAuth";
  if (entry?.auth === "bearer") return "Bearer token from env";
  if (entry?.auth === false) return "No authentication";
  return "Auto detect";
}

function scopeLabel(scope: McpManagedServer["scope"]): string {
  if (scope === "user") return "User";
  if (scope === "project") return "Project";
  return "Imported";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
