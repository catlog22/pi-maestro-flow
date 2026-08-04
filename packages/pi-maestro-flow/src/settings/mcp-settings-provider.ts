import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import {
  SETTINGS_ANNOUNCE_EVENT,
  SETTINGS_DISCOVER_EVENT,
  SETTINGS_PROTOCOL_VERSION,
  type ConfiguredSettingValue,
  type EffectiveSettingValue,
  type JsonValue,
  type SettingDefinition,
  type SettingsAnnounceEventV1,
  type SettingsChange,
  type SettingsContextV1,
  type SettingsDiscoverEventV1,
  type SettingsOverviewRow,
  type SettingsProviderV1,
  type SettingsSnapshot,
  type SettingsValidationIssue,
} from "pi-maestro-settings-core/v1";
import { SETTINGS_SECRET_SET_PLACEHOLDER } from "pi-maestro-settings-core/v1/schema";
import { getPiGlobalConfigPath, writeMcpConfigDocument } from "../mcp/config.ts";

const PROVIDER_ID = "pi-maestro-mcp";
const PROVIDER_VERSION = "1.0.0";

type McpSettingsAction = (context: SettingsContextV1) => Promise<void> | void;

interface SettingsEventBus {
  on(event: string, handler: (payload: unknown) => void): void | (() => void);
  emit(event: string, payload: unknown): void;
}

export interface McpSettingsProvider extends SettingsProviderV1 {
  readonly providerId: typeof PROVIDER_ID;
  readonly instanceId: string;
}

export interface McpSettingsProviderOptions {
  actions?: Readonly<Record<string, McpSettingsAction>>;
  getConfigPath?: () => string;
}

/** Normalized list-crud item for a single MCP server entry. */
interface McpServerItem {
  name: string;
  enabled: boolean;
  command: string;
  args: string[];
  url: string;
  auth: "oauth" | "bearer" | false;
  bearerToken: string | null;
}

function field(
  key: string,
  kind: SettingDefinition["editor"]["kind"],
  labelKey: string,
  extra: Partial<SettingDefinition["editor"]> = {},
  defaultValue?: JsonValue,
): SettingDefinition {
  return {
    key,
    group: "mcp.group.servers",
    labelKey,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    scopes: ["global"],
    merge: "provider-defined",
    activation: "next-invocation",
    sensitivity: "public",
    reversibility: "full",
    editor: { kind, ...extra },
  };
}

const MCP_SERVER_FIELDS: readonly SettingDefinition[] = [
  field("name", "text", "mcp.field.name"),
  field("enabled", "boolean", "mcp.field.enabled", {}, true),
  field("command", "text", "mcp.field.command"),
  field("args", "json", "mcp.field.args"),
  field("url", "text", "mcp.field.url"),
  field("auth", "enum", "mcp.field.auth", {
    options: [
      { value: "oauth", labelKey: "mcp.auth.oauth" },
      { value: "bearer", labelKey: "mcp.auth.bearer" },
      { value: false, labelKey: "mcp.auth.none" },
    ],
  }, "oauth"),
  field("bearerToken", "secret", "mcp.field.bearerToken", { writeOnly: true }),
];

const DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: "mcp.servers",
    group: "mcp.group.servers",
    order: 0,
    labelKey: "mcp.servers",
    descriptionKey: "mcp.servers.description",
    scopes: ["global"],
    merge: "provider-defined",
    activation: "next-invocation",
    sensitivity: "private",
    reversibility: "full",
    editor: {
      kind: "list-crud",
      itemLabelKey: "mcp.item.server",
      addLabelKey: "mcp.action.addServer",
      itemFields: MCP_SERVER_FIELDS,
    },
  },
  {
    key: "mcp.overview",
    group: "mcp.group.diagnostics",
    order: 10,
    labelKey: "mcp.overview",
    descriptionKey: "mcp.overview.description",
    scopes: ["global"],
    merge: "provider-defined",
    activation: "live",
    sensitivity: "private",
    reversibility: "none",
    editor: { kind: "overview" },
  },
  {
    key: "mcp.editConfig",
    group: "mcp.group.diagnostics",
    order: 20,
    labelKey: "mcp.editConfig",
    descriptionKey: "mcp.editConfig.description",
    scopes: ["global"],
    merge: "provider-defined",
    activation: "live",
    sensitivity: "private",
    reversibility: "none",
    editor: { kind: "action", actionId: "mcp.editConfig" },
  },
];

const CATALOGS = {
  en: {
    "mcp.provider": "MCP Servers",
    "mcp.provider.description": "Managed MCP servers, authentication and raw JSON configuration",
    "mcp.group.servers": "MCP servers",
    "mcp.group.diagnostics": "Configuration overview",
    "mcp.servers": "MCP servers",
    "mcp.servers.description": "Managed MCP server entries stored in the Pi global MCP config",
    "mcp.field.name": "Server name",
    "mcp.field.enabled": "Enabled",
    "mcp.field.command": "Command",
    "mcp.field.args": "Arguments",
    "mcp.field.url": "URL",
    "mcp.field.auth": "Authentication",
    "mcp.field.bearerToken": "Bearer token",
    "mcp.auth.oauth": "OAuth",
    "mcp.auth.bearer": "Bearer token",
    "mcp.auth.none": "None",
    "mcp.item.server": "{name}",
    "mcp.action.addServer": "Add server",
    "mcp.overview": "MCP configuration overview",
    "mcp.overview.description": "Configured MCP servers and the config file location",
    "mcp.overview.servers": "Servers",
    "mcp.overview.enabled": "Enabled",
    "mcp.overview.file": "Config file",
    "mcp.editConfig": "Edit raw MCP config (JSON)",
    "mcp.editConfig.description": "Open the full MCP config file in a JSON editor",
    "mcp.settings.invalidServers": "MCP servers must be a list of objects with a non-empty name",
  },
  "zh-CN": {
    "mcp.provider": "MCP 服务",
    "mcp.provider.description": "托管 MCP 服务、认证方式与原始 JSON 配置",
    "mcp.group.servers": "MCP 服务",
    "mcp.group.diagnostics": "配置概览",
    "mcp.servers": "MCP 服务",
    "mcp.servers.description": "托管 MCP 服务条目，存储于 Pi 全局 MCP 配置",
    "mcp.field.name": "服务名称",
    "mcp.field.enabled": "启用",
    "mcp.field.command": "命令",
    "mcp.field.args": "参数",
    "mcp.field.url": "URL",
    "mcp.field.auth": "认证方式",
    "mcp.field.bearerToken": "Bearer Token",
    "mcp.auth.oauth": "OAuth",
    "mcp.auth.bearer": "Bearer Token",
    "mcp.auth.none": "无",
    "mcp.item.server": "{name}",
    "mcp.action.addServer": "新增服务",
    "mcp.overview": "MCP 配置概览",
    "mcp.overview.description": "已配置的 MCP 服务与配置文件位置",
    "mcp.overview.servers": "服务数",
    "mcp.overview.enabled": "启用数",
    "mcp.overview.file": "配置文件",
    "mcp.editConfig": "编辑原始 MCP 配置（JSON）",
    "mcp.editConfig.description": "在 JSON 编辑器中打开完整 MCP 配置文件",
    "mcp.settings.invalidServers": "MCP 服务必须是包含非空 name 的对象列表",
  },
} as const;

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readConfigObject(configPath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${configPath} root must be an object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return {};
    if (error instanceof SyntaxError) {
      throw new Error(`Unable to parse ${configPath}: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

function serversObject(raw: Record<string, unknown>): Record<string, unknown> {
  const servers = raw.mcpServers ?? raw["mcp-servers"] ?? {};
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
  return servers as Record<string, unknown>;
}

function toServerItem(name: string, value: unknown): McpServerItem {
  const entry = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    name,
    enabled: entry.enabled !== false,
    command: typeof entry.command === "string" ? entry.command : "",
    args: Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [],
    url: typeof entry.url === "string" ? entry.url : "",
    auth: entry.auth === "oauth" || entry.auth === "bearer" ? entry.auth : "oauth",
    bearerToken: typeof entry.bearerToken === "string" && entry.bearerToken.length > 0
      ? SETTINGS_SECRET_SET_PLACEHOLDER
      : null,
  };
}

function parseServerItem(value: unknown): McpServerItem | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const name = typeof item.name === "string" ? item.name.trim() : "";
  if (!name) return undefined;
  return {
    name,
    enabled: item.enabled !== false,
    command: typeof item.command === "string" ? item.command : "",
    args: Array.isArray(item.args) ? item.args.filter((arg): arg is string => typeof arg === "string") : [],
    url: typeof item.url === "string" ? item.url : "",
    auth: item.auth === "oauth" || item.auth === "bearer" ? item.auth : false,
    bearerToken: typeof item.bearerToken === "string" && item.bearerToken.length > 0 ? item.bearerToken : null,
  };
}

function hasValidServerName(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const name = (value as Record<string, unknown>).name;
  return typeof name === "string" && name.trim().length > 0;
}

export function createMcpSettingsProvider(
  options: McpSettingsProviderOptions = {},
): McpSettingsProvider {
  const instanceId = randomUUID();
  const getConfigPath = options.getConfigPath ?? (() => getPiGlobalConfigPath());
  const originals = new Map<string, { path: string; content: string }>();
  const preparedChanges = new Map<string, readonly SettingsChange[]>();

  const load = async (): Promise<{ servers: McpServerItem[]; raw: Record<string, unknown>; content: string }> => {
    const configPath = getConfigPath();
    const raw = await readConfigObject(configPath);
    const servers = Object.entries(serversObject(raw))
      .map(([name, entry]) => toServerItem(name, entry))
      .sort((left, right) => left.name.localeCompare(right.name));
    let content = "";
    try {
      content = await readFile(configPath, "utf8");
    } catch {
      content = "";
    }
    return { servers, raw, content };
  };

  const snapshotFor = (
    instanceId: string,
    data: Awaited<ReturnType<typeof load>>,
    definitions: readonly SettingDefinition[],
  ): SettingsSnapshot => {
    const configured: ConfiguredSettingValue[] = [];
    const effective: EffectiveSettingValue[] = [];
    for (const definition of definitions) {
      if (definition.key === "mcp.servers") {
        configured.push({ key: definition.key, scope: "global", state: "set", value: data.servers as unknown as JsonValue });
        effective.push({ key: definition.key, value: data.servers as unknown as JsonValue, source: "configured", scope: "global" });
      } else if (definition.key === "mcp.overview") {
        const rows: SettingsOverviewRow[] = [
          { labelKey: "mcp.overview.servers", value: String(data.servers.length), status: "ok" },
          { labelKey: "mcp.overview.enabled", value: String(data.servers.filter((server) => server.enabled).length), status: "ok" },
          { labelKey: "mcp.overview.file", value: getConfigPath(), status: "dim" },
        ];
        configured.push({ key: definition.key, scope: "global", state: "absent" });
        effective.push({ key: definition.key, value: rows as unknown as JsonValue, source: "runtime" });
      } else {
        configured.push({ key: definition.key, scope: "global", state: "absent" });
        effective.push({ key: definition.key, value: "open", source: "runtime" });
      }
    }
    return {
      providerId: PROVIDER_ID,
      providerInstanceId: instanceId,
      configured: { values: configured, resources: [] },
      effective: { values: effective },
    };
  };

  return {
    providerId: PROVIDER_ID,
    instanceId,
    describe: () => ({
      id: PROVIDER_ID,
      version: PROVIDER_VERSION,
      instanceId,
      labelKey: "mcp.provider",
      descriptionKey: "mcp.provider.description",
      order: 16,
      capabilities: { read: true, write: true, prepareCommit: true, rollback: "compensating", hotUpdate: true },
      settings: DEFINITIONS,
      catalogs: CATALOGS,
    }),
    read: async (request) => snapshotFor(instanceId, await load(), DEFINITIONS),
    validate: (request) => {
      const issues: SettingsValidationIssue[] = [];
      for (const change of request.changes) {
        if (change.key === "mcp.servers" && change.operation === "set") {
          if (!Array.isArray(change.value) || !change.value.every((entry) => hasValidServerName(entry))) {
            issues.push({
              severity: "error",
              key: change.key,
              scope: change.scope,
              code: "invalid-servers",
              messageKey: "mcp.settings.invalidServers",
            });
          }
        }
      }
      return { valid: issues.length === 0, issues, conflicts: [] };
    },
    prepare: async (request) => {
      const data = await load();
      const changedKeys = request.changes.map((change) => change.key);
      if (changedKeys.includes("mcp.servers")) {
        originals.set(request.transactionId, { path: getConfigPath(), content: data.content });
      }
      preparedChanges.set(request.transactionId, request.changes);
      return {
        prepared: true,
        prepareToken: request.transactionId,
        validation: { valid: true, issues: [], conflicts: [] },
        activation: [{ boundary: "next-invocation", keys: changedKeys }],
      };
    },
    commit: async (request) => {
      const configPath = getConfigPath();
      const data = await load();
      const changes = preparedChanges.get(request.transactionId) ?? [];
      const serversChange = changes.find((change) => change.key === "mcp.servers");
      if (serversChange?.operation === "set" && Array.isArray(serversChange.value)) {
        const items = serversChange.value
          .map((value) => parseServerItem(value))
          .filter((item): item is McpServerItem => item !== undefined);
        const existing = serversObject(data.raw);
        const nextServers: Record<string, unknown> = {};
        for (const item of items) {
          const previous = typeof existing[item.name] === "object" && existing[item.name] !== null
            ? existing[item.name] as Record<string, unknown>
            : undefined;
          const server: Record<string, unknown> = { ...(previous ?? {}) };
          server.enabled = item.enabled !== false;
          server.command = item.command;
          server.args = item.args;
          server.url = item.url;
          server.auth = item.auth;
          if (typeof item.bearerToken === "string" && item.bearerToken.length > 0) {
            if (item.bearerToken !== SETTINGS_SECRET_SET_PLACEHOLDER) {
              server.bearerToken = item.bearerToken;
            }
          } else {
            delete server.bearerToken;
          }
          nextServers[item.name] = server;
        }
        const nextRaw = { ...data.raw };
        delete nextRaw["mcp-servers"];
        nextRaw.mcpServers = nextServers;
        writeMcpConfigDocument(configPath, `${JSON.stringify(nextRaw, null, 2)}\n`);
      }
      originals.delete(request.transactionId);
      preparedChanges.delete(request.transactionId);
      const snapshot = snapshotFor(instanceId, await load(), DEFINITIONS);
      return {
        snapshot,
        revisions: [{
          resource: { providerId: PROVIDER_ID, scope: "global", id: configPath },
          etag: `mcp-${Date.now()}`,
        }],
        changedKeys: changes.map((change) => change.key),
        activation: [{ boundary: "next-invocation", keys: changes.map((change) => change.key) }],
      };
    },
    abort: (request) => {
      originals.delete(request.transactionId);
      preparedChanges.delete(request.transactionId);
    },
    rollback: async (request) => {
      const original = originals.get(request.transactionId);
      originals.delete(request.transactionId);
      if (!original) return { rolledBack: false };
      try {
        if (original.content !== "") {
          writeMcpConfigDocument(original.path, original.content);
        } else {
          await rm(original.path, { force: true });
        }
      } catch {
        return { rolledBack: false };
      }
      return { rolledBack: true };
    },
    invokeAction: async (request) => {
      const handler = options.actions?.[request.actionId];
      if (!handler) return { handled: false };
      await handler(request.context);
      return { handled: true, refresh: false };
    },
  };
}

export function registerMcpSettingsProvider(
  events: SettingsEventBus,
  provider: McpSettingsProvider,
): () => void {
  const announce = (requestId?: string): void => {
    events.emit(SETTINGS_ANNOUNCE_EVENT, {
      version: SETTINGS_PROTOCOL_VERSION,
      requestId,
      providerId: provider.providerId,
      instanceId: provider.instanceId,
      provider,
    } satisfies SettingsAnnounceEventV1);
  };
  const result = events.on(SETTINGS_DISCOVER_EVENT, (payload) => {
    if (isDiscover(payload)) announce(payload.requestId);
  });
  announce();
  return () => { if (typeof result === "function") result(); };
}

function isDiscover(payload: unknown): payload is SettingsDiscoverEventV1 {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as Partial<SettingsDiscoverEventV1>;
  return candidate.version === SETTINGS_PROTOCOL_VERSION
    && typeof candidate.requestId === "string"
    && Boolean(candidate.context)
    && typeof candidate.context?.cwd === "string";
}
