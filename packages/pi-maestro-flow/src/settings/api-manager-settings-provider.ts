import { randomUUID } from "node:crypto";
import {
  SETTINGS_ANNOUNCE_EVENT,
  SETTINGS_DISCOVER_EVENT,
  SETTINGS_PROTOCOL_VERSION,
  type SettingDefinition,
  type SettingsAnnounceEventV1,
  type SettingsContextV1,
  type SettingsDiscoverEventV1,
  type SettingsProviderV1,
  type SettingsSnapshot,
  type SettingsValidationIssue,
} from "pi-maestro-settings-core/v1";

const PROVIDER_ID = "pi-maestro-api-manager";
const PROVIDER_VERSION = "1.0.0";

type ApiManagerAction = (context: SettingsContextV1) => Promise<void> | void;

interface SettingsEventBus {
  on(event: string, handler: (payload: unknown) => void): void | (() => void);
  emit(event: string, payload: unknown): void;
}

export interface ApiManagerSettingsProvider extends SettingsProviderV1 {
  readonly providerId: typeof PROVIDER_ID;
  readonly instanceId: string;
}

export interface ApiManagerSettingsProviderOptions {
  actions?: Readonly<Record<string, ApiManagerAction>>;
}

const DEFINITIONS: readonly SettingDefinition[] = [
  action("api.manage", "api.group.providers", "api.action.manage", "api.action.manage.description", 0),
  action("api.configure", "api.group.providers", "api.action.configure", "api.action.configure.description", 1),
  action("api.retry", "api.group.retry", "api.action.retry", "api.action.retry.description", 0),
  action("api.list", "api.group.diagnostics", "api.action.list", "api.action.list.description", 0),
];

const CATALOGS = {
  en: {
    "api.provider": "API Manager",
    "api.provider.description": "Providers, models, endpoints, credentials, defaults and retry policy",
    "api.group.providers": "Providers and models",
    "api.group.retry": "Retry policy",
    "api.group.diagnostics": "Configuration overview",
    "api.action.manage": "Open full API Manager",
    "api.action.manage.description": "Open the original API Manager menu for all provider operations",
    "api.action.configure": "Add or edit a provider model",
    "api.action.configure.description": "Configure provider endpoints, model IDs, API keys and model capabilities",
    "api.action.retry": "Configure API retries",
    "api.action.retry.description": "Review or change the global retry policy used for API requests",
    "api.action.list": "Show configured providers and models",
    "api.action.list.description": "Display the effective provider, model, defaults and retry configuration",
    "api.settings.readOnly": "API Manager entries are actions and cannot be committed as draft values",
  },
  "zh-CN": {
    "api.provider": "API Manager",
    "api.provider.description": "管理 Provider、模型、端点、凭据、默认值与重试策略",
    "api.group.providers": "Provider 与模型",
    "api.group.retry": "API 重试策略",
    "api.group.diagnostics": "配置概览",
    "api.action.manage": "打开完整 API Manager",
    "api.action.manage.description": "进入原生 API Manager 菜单，执行全部 Provider 管理操作",
    "api.action.configure": "新增或编辑 Provider 模型",
    "api.action.configure.description": "配置 Provider 端点、模型 ID、API Key 与模型能力",
    "api.action.retry": "配置 API 重试",
    "api.action.retry.description": "查看或修改 API 请求使用的全局重试策略",
    "api.action.list": "查看已配置的 Provider 与模型",
    "api.action.list.description": "显示当前生效的 Provider、模型、默认值与重试配置",
    "api.settings.readOnly": "API Manager 项目是管理操作，不能作为草稿值提交",
  },
} as const;

export function createApiManagerSettingsProvider(
  options: ApiManagerSettingsProviderOptions = {},
): ApiManagerSettingsProvider {
  const instanceId = randomUUID();
  return {
    providerId: PROVIDER_ID,
    instanceId,
    describe: () => ({
      id: PROVIDER_ID,
      version: PROVIDER_VERSION,
      instanceId,
      labelKey: "api.provider",
      descriptionKey: "api.provider.description",
      order: 15,
      capabilities: { read: true, write: false, prepareCommit: false, rollback: "none", hotUpdate: true },
      settings: DEFINITIONS,
      catalogs: CATALOGS,
    }),
    read: () => snapshot(instanceId),
    validate: (request) => {
      const issues: SettingsValidationIssue[] = request.changes.map((change) => ({
        severity: "error",
        key: change.key,
        scope: change.scope,
        code: "read-only",
        messageKey: "api.settings.readOnly",
      }));
      return { valid: issues.length === 0, issues, conflicts: [] };
    },
    invokeAction: async (request) => {
      const handler = options.actions?.[request.actionId];
      if (!handler) return { handled: false };
      await handler(request.context);
      return { handled: true, refresh: false };
    },
  };
}

export function registerApiManagerSettingsProvider(
  events: SettingsEventBus,
  provider: ApiManagerSettingsProvider,
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

function action(
  key: string,
  group: string,
  labelKey: string,
  descriptionKey: string,
  order: number,
): SettingDefinition {
  return {
    key,
    group,
    order,
    labelKey,
    descriptionKey,
    scopes: ["global"],
    merge: "provider-defined",
    activation: "live",
    sensitivity: "private",
    reversibility: "none",
    editor: { kind: "action", actionId: key },
  };
}

function snapshot(instanceId: string): SettingsSnapshot {
  return {
    providerId: PROVIDER_ID,
    providerInstanceId: instanceId,
    configured: {
      values: DEFINITIONS.map((definition) => ({ key: definition.key, scope: "global", state: "absent" })),
      resources: [],
    },
    effective: {
      values: DEFINITIONS.map((definition) => ({ key: definition.key, value: "open", source: "runtime" })),
    },
  };
}

function isDiscover(payload: unknown): payload is SettingsDiscoverEventV1 {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as Partial<SettingsDiscoverEventV1>;
  return candidate.version === SETTINGS_PROTOCOL_VERSION
    && typeof candidate.requestId === "string"
    && Boolean(candidate.context)
    && typeof candidate.context?.cwd === "string";
}
