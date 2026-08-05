import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import { McpManagerOverlay, type McpManagerAction, type McpManagerServerView, type McpManagerStatus, type McpManagerUiState } from "./mcp-manager.ts";
import {
  McpManagerStore,
  type McpManagedServer,
  type McpManagerSnapshot,
  validateServerName,
} from "./mcp-manager-store.ts";
import type { ServerEntry } from "./types.ts";

export interface McpManagerRuntime {
  status(serverName: string): McpManagerStatus;
  toolNames(serverName: string): string[];
  canAuthenticate(serverName: string): boolean;
  authenticate(serverName: string): Promise<{ ok: boolean; message?: string }>;
}

export interface McpManagerFlowResult {
  configChanged: boolean;
}

interface ConfigEditorResult {
  configChanged: boolean;
  notice?: string;
  snapshot?: McpManagerSnapshot;
}

const CATALOGS = {
  en: {
    "notice.noServers": "No servers · press E to paste or edit the MCP config",
    "notice.noSelection": "Cannot act · no server selected",
    "status.togglingOn": "MCP · enabling {name}…",
    "status.togglingOff": "MCP · disabling {name}…",
    "notice.toggledOn": "Enabled · {name} · reload after closing",
    "notice.toggledOff": "Disabled · {name} · reload after closing",
    "notice.toggleFailed": "Failed to update the toggle · {message}",
    "notice.cannotAuth": "Cannot authenticate · {name} does not support OAuth (set auth: \"oauth\" or omit auth for auto-detection)",
    "status.authing": "MCP · authenticating {name}…",
    "notice.authOk": "Authenticated · {name} · takes effect after reload",
    "notice.authFailed": "Authentication failed · {name} · {message}",
    "notice.authFailedNoMsg": "Authentication failed · {name}",
    "notice.cannotDeleteReadonly": "Cannot delete · {name} is a read-only import",
    "confirm.deleteTitle": "Delete MCP server “{name}”?",
    "confirm.deleteMessage": "This removes the server from the {scope} configuration:\n{path}\nOther MCP servers are unaffected.",
    "notice.deleteCancelled": "Delete cancelled · server unchanged",
    "status.deleting": "MCP · deleting {name}…",
    "notice.deleted": "Deleted · {name} · reload after closing",
    "notice.deleteFailed": "Delete failed · {message}",
    "status.saving": "MCP · saving configuration…",
    "editor.title": "Edit MCP configuration · {path}",
    "notice.editCancelled": "Edit cancelled · no changes saved",
    "notice.configSaved": "Configuration saved · reload after closing",
    "notice.saveFailed": "Failed to save configuration · {message}",
    "scope.user": "user",
    "scope.project": "project",
    "scope.import": "import",
  },
  "zh-CN": {
    "notice.noServers": "没有服务 · 按 E 粘贴或编辑 MCP 配置",
    "notice.noSelection": "无法操作 · 未选择服务",
    "status.togglingOn": "MCP · 正在启用 {name}…",
    "status.togglingOff": "MCP · 正在停用 {name}…",
    "notice.toggledOn": "已启用 · {name} · 关闭后重载",
    "notice.toggledOff": "已停用 · {name} · 关闭后重载",
    "notice.toggleFailed": "更新开关失败 · {message}",
    "notice.cannotAuth": "无法认证 · {name} 不支持 OAuth（需设置 auth: \"oauth\" 或省略 auth 自动检测）",
    "status.authing": "MCP · 正在认证 {name}…",
    "notice.authOk": "认证成功 · {name} · 关闭后重载生效",
    "notice.authFailed": "认证失败 · {name} · {message}",
    "notice.authFailedNoMsg": "认证失败 · {name}",
    "notice.cannotDeleteReadonly": "无法删除 · {name} 是只读导入项",
    "confirm.deleteTitle": "删除 MCP 服务「{name}」？",
    "confirm.deleteMessage": "这会从{scope}配置中删除该服务：\n{path}\n其他 MCP 服务不会受影响。",
    "notice.deleteCancelled": "已取消删除 · 服务保持不变",
    "status.deleting": "MCP · 正在删除 {name}…",
    "notice.deleted": "已删除 · {name} · 关闭后重载",
    "notice.deleteFailed": "删除失败 · {message}",
    "status.saving": "MCP · 正在保存配置…",
    "editor.title": "编辑 MCP 配置 · {path}",
    "notice.editCancelled": "已取消编辑 · 未保存更改",
    "notice.configSaved": "已保存配置 · 关闭后重载",
    "notice.saveFailed": "保存配置失败 · {message}",
    "scope.user": "用户",
    "scope.project": "项目",
    "scope.import": "导入",
  },
} as const;

type CatalogKey = keyof (typeof CATALOGS)["zh-CN"];

function t(locale: SupportedSettingsLocale, key: CatalogKey, vars?: Readonly<Record<string, string | number>>): string {
  const catalog = CATALOGS[locale] ?? CATALOGS["zh-CN"];
  const template: unknown = catalog[key];
  const text = typeof template === "string" ? template : CATALOGS["zh-CN"][key] as string;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (_match, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`);
}

export async function runMcpManager(
  ctx: ExtensionContext,
  store: McpManagerStore,
  runtime: McpManagerRuntime,
  locale: SupportedSettingsLocale = "zh-CN",
): Promise<McpManagerFlowResult> {
  let snapshot = await store.load();
  let uiState: Partial<McpManagerUiState> = { detail: false, query: "" };
  let notice = snapshot.servers.length === 0 ? t(locale, "notice.noServers") : undefined;
  let configChanged = false;

  while (true) {
    const action = await openManagerOverlay(ctx, buildViews(snapshot, runtime), uiState, notice, locale);
    uiState = action.uiState;
    if (action.kind === "close") break;
    const selected = action.serverName
      ? snapshot.servers.find((server) => server.name === action.serverName)
      : undefined;

    if (action.kind === "edit-config") {
      const result = await editMcpConfig(ctx, store, locale);
      if (result.snapshot) snapshot = result.snapshot;
      configChanged ||= result.configChanged;
      notice = result.notice;
      continue;
    }

    if (!selected) {
      notice = t(locale, "notice.noSelection");
      continue;
    }

    if (action.kind === "toggle") {
      try {
        const nextEnabled = selected.entry.enabled === false;
        ctx.ui.setStatus("mcp-manager", t(locale, nextEnabled ? "status.togglingOn" : "status.togglingOff", { name: selected.name }));
        snapshot = await store.toggle(selected);
        configChanged = true;
        uiState = { ...uiState, selectedName: selected.name };
        notice = t(locale, nextEnabled ? "notice.toggledOn" : "notice.toggledOff", { name: selected.name });
      } catch (error) {
        notice = t(locale, "notice.toggleFailed", { message: errorMessage(error) });
      } finally {
        ctx.ui.setStatus("mcp-manager", undefined);
      }
      continue;
    }

    if (action.kind === "authenticate") {
      if (!runtime.canAuthenticate(selected.name)) {
        notice = t(locale, "notice.cannotAuth", { name: selected.name });
        continue;
      }
      try {
        ctx.ui.setStatus("mcp-manager", t(locale, "status.authing", { name: selected.name }));
        const result = await runtime.authenticate(selected.name);
        if (result.ok) {
          notice = t(locale, "notice.authOk", { name: selected.name });
        } else {
          notice = result.message
            ? t(locale, "notice.authFailed", { name: selected.name, message: result.message })
            : t(locale, "notice.authFailedNoMsg", { name: selected.name });
        }
      } catch (error) {
        notice = t(locale, "notice.authFailed", { name: selected.name, message: errorMessage(error) });
      } finally {
        ctx.ui.setStatus("mcp-manager", undefined);
      }
      uiState = { ...uiState, selectedName: selected.name };
      continue;
    }

    if (action.kind === "delete") {
      if (selected.readOnly) {
        notice = t(locale, "notice.cannotDeleteReadonly", { name: selected.name });
        continue;
      }
      const confirmed = await ctx.ui.confirm(
        t(locale, "confirm.deleteTitle", { name: selected.name }),
        t(locale, "confirm.deleteMessage", { scope: scopeLabel(locale, selected.scope), path: selected.path }),
      );
      if (!confirmed) {
        notice = t(locale, "notice.deleteCancelled");
        continue;
      }
      try {
        ctx.ui.setStatus("mcp-manager", t(locale, "status.deleting", { name: selected.name }));
        snapshot = await store.delete(selected);
        configChanged = true;
        uiState = { ...uiState, selectedName: undefined, detail: false };
        notice = t(locale, "notice.deleted", { name: selected.name });
      } catch (error) {
        notice = t(locale, "notice.deleteFailed", { message: errorMessage(error) });
      } finally {
        ctx.ui.setStatus("mcp-manager", undefined);
      }
    }
  }

  return { configChanged };
}

async function editMcpConfig(
  ctx: ExtensionContext,
  store: McpManagerStore,
  locale: SupportedSettingsLocale,
): Promise<ConfigEditorResult> {
  try {
    const document = store.getEditableConfig();
    const nextText = await ctx.ui.editor(t(locale, "editor.title", { path: document.path }), document.text);
    if (nextText === undefined) return { configChanged: false, notice: t(locale, "notice.editCancelled") };
    ctx.ui.setStatus("mcp-manager", t(locale, "status.saving"));
    const snapshot = await store.replaceEditableConfig(nextText);
    return { configChanged: true, snapshot, notice: t(locale, "notice.configSaved") };
  } catch (error) {
    return { configChanged: false, notice: t(locale, "notice.saveFailed", { message: errorMessage(error) }) };
  } finally {
    ctx.ui.setStatus("mcp-manager", undefined);
  }
}

async function openManagerOverlay(
  ctx: ExtensionContext,
  servers: McpManagerServerView[],
  initialState: Partial<McpManagerUiState>,
  notice: string | undefined,
  locale: SupportedSettingsLocale,
): Promise<McpManagerAction> {
  return ctx.ui.custom<McpManagerAction>((tui, theme, _keybindings, done) => new McpManagerOverlay({
    servers,
    theme,
    notice,
    initialState,
    locale,
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
    status: server.entry.enabled === false ? "disabled" : runtime.status(server.name),
    toolNames: server.entry.enabled === false ? [] : runtime.toolNames(server.name),
    canAuthenticate: server.entry.enabled !== false && runtime.canAuthenticate(server.name),
  }));
}

interface RecognizedMcpServer {
  name: string;
  entry: ServerEntry;
}

/** Serializes one server as a portable .mcp.json snippet for copying or editing. */
export function serializeMcpServerJson(name: string, entry: ServerEntry): string {
  return `${JSON.stringify({ mcpServers: { [validateServerName(name)]: entry } }, null, 2)}\n`;
}

/**
 * Recognizes standard MCP JSON snippets from Pi, Cursor, Claude, Codex, and
 * VS Code. A raw server entry is intentionally rejected because it has no
 * portable server name.
 */
export function parseMcpJsonServers(value: string): RecognizedMcpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("MCP JSON is invalid", { cause: error });
  }
  if (!isRecord(parsed)) throw new Error("MCP JSON must be an object");

  const rawServers = parsed.mcpServers ?? parsed["mcp-servers"];
  if (!isRecord(rawServers)) {
    throw new Error('MCP JSON must contain an "mcpServers" object');
  }
  const candidates = Object.entries(rawServers).map(([name, rawEntry]) => ({
    name: validateServerName(name),
    entry: validateMcpServerEntry(rawEntry),
  }));
  if (candidates.length === 0) throw new Error("MCP JSON contains no servers");
  return candidates;
}

function validateMcpServerEntry(value: unknown): ServerEntry {
  if (!isRecord(value)) throw new Error("Each MCP server must be a JSON object");
  const entry = value as ServerEntry;
  if (typeof entry.command !== "string" && typeof entry.url !== "string") {
    throw new Error("Each MCP server needs a string command or URL");
  }
  if (entry.command !== undefined && typeof entry.command !== "string") throw new Error("MCP command must be a string");
  if (entry.url !== undefined) normalizeHttpUrl(entry.url);
  if (entry.args !== undefined && (!Array.isArray(entry.args) || !entry.args.every((arg) => typeof arg === "string"))) {
    throw new Error("MCP arguments must be a JSON array of strings");
  }
  validateStringRecord(entry.env, "MCP environment");
  validateStringRecord(entry.headers, "MCP headers");
  if (entry.lifecycle !== undefined && !["lazy", "keep-alive", "eager"].includes(entry.lifecycle)) {
    throw new Error("MCP lifecycle must be lazy, keep-alive, or eager");
  }
  if (entry.auth !== undefined && entry.auth !== "oauth" && entry.auth !== "bearer" && entry.auth !== false) {
    throw new Error("MCP authentication must be oauth, bearer, or false");
  }
  if (entry.directTools !== undefined && entry.directTools !== true && entry.directTools !== false
    && (!Array.isArray(entry.directTools) || !entry.directTools.every((tool) => typeof tool === "string"))) {
    throw new Error("MCP directTools must be a boolean or string array");
  }
  if (entry.excludeTools !== undefined && (!Array.isArray(entry.excludeTools) || !entry.excludeTools.every((tool) => typeof tool === "string"))) {
    throw new Error("MCP excludeTools must be a string array");
  }
  if (entry.requestTimeoutMs !== undefined && (!Number.isInteger(entry.requestTimeoutMs) || entry.requestTimeoutMs <= 0)) {
    throw new Error("MCP requestTimeoutMs must be a positive integer");
  }
  return entry;
}

function validateStringRecord(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!isRecord(value) || !Object.values(value).every((item) => typeof item === "string")) {
    throw new Error(`${label} must be a JSON object with string values`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function scopeLabel(locale: SupportedSettingsLocale, scope: McpManagedServer["scope"]): string {
  if (scope === "user") return t(locale, "scope.user");
  if (scope === "project") return t(locale, "scope.project");
  return t(locale, "scope.import");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
