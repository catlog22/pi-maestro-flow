import { randomUUID } from "node:crypto";
import {
  SETTINGS_ANNOUNCE_EVENT,
  SETTINGS_DISCOVER_EVENT,
  SETTINGS_PROTOCOL_VERSION,
  type ConfiguredSettingValue,
  type EffectiveSettingValue,
  type JsonValue,
  type SettingDefinition,
  type SettingsActivationPlan,
  type SettingsAnnounceEventV1,
  type SettingsChange,
  type SettingsContextV1,
  type SettingsDiscoverEventV1,
  type SettingsOverviewRow,
  type SettingsProviderV1,
  type SettingsResourceRevision,
  type SettingsSnapshot,
  type SettingsValidationIssue,
} from "pi-maestro-settings-core/v1";
import { SETTINGS_SECRET_SET_PLACEHOLDER } from "pi-maestro-settings-core/v1/schema";
import { loadApiRetrySettings, saveApiRetrySettings } from "../providers/api-provider-config.ts";
import { readModelsRoot, writeModelsRoot } from "../providers/api-provider-ops.ts";
import {
  AGENT_CACHE_RETENTION_DEFAULT,
  applyCacheRetentionEnv,
  CACHE_RETENTION_SETTING_DEFAULT,
  isAgentCacheRetention,
  isCacheRetentionSetting,
  isPromptCachePolicy,
  loadAgentCacheRetention,
  loadCacheRetentionSetting,
  loadPromptCachePolicy,
  PROMPT_CACHE_POLICIES,
  PROMPT_CACHE_POLICY_DEFAULT,
  saveAgentCacheRetention,
  saveCacheRetentionSetting,
  savePromptCachePolicy,
  type CacheRetention,
  type CacheRetentionSetting,
  type PromptCachePolicy,
} from "../providers/prompt-cache-policy.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "pi-maestro-api-manager";
const PROVIDER_VERSION = "1.1.0";

const API_KINDS = [
  "openai-responses",
  "openai-completions",
  "anthropic-messages",
  "azure-openai-responses",
] as const;

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
  getModelsPath?: () => string;
  getSettingsPath?: () => string;
  getAgentDir?: () => string;
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
    group: "api.group.providers",
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

const PROVIDER_FIELDS: readonly SettingDefinition[] = [
  field("id", "text", "api.field.id"),
  field("baseUrl", "text", "api.field.baseUrl"),
  field("api", "enum", "api.field.api", {
    options: API_KINDS.map((kind) => ({ value: kind, labelKey: `api.apiKind.${kind}` })),
  }, "openai-responses"),
  field("enabled", "boolean", "api.field.enabled", {}, true),
  field("apiKey", "secret", "api.field.apiKey", { writeOnly: true }),
  field("models", "json", "api.field.models", { multiline: true }),
];

const DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: "api.providers",
    group: "api.group.providers",
    order: 0,
    labelKey: "api.providers",
    descriptionKey: "api.providers.description",
    scopes: ["global"],
    merge: "provider-defined",
    activation: "next-invocation",
    sensitivity: "private",
    reversibility: "full",
    editor: {
      kind: "list-crud",
      itemLabelKey: "api.item.provider",
      addLabelKey: "api.action.addProvider",
      itemFields: PROVIDER_FIELDS,
    },
  },
  {
    key: "api.retry.enabled",
    group: "api.group.retry",
    order: 10,
    labelKey: "api.retry.enabled",
    scopes: ["global"],
    merge: "provider-defined",
    activation: "next-invocation",
    sensitivity: "public",
    reversibility: "full",
    editor: { kind: "boolean" },
  },
  {
    key: "api.retry.maxRetries",
    group: "api.group.retry",
    order: 11,
    labelKey: "api.retry.maxRetries",
    scopes: ["global"],
    merge: "provider-defined",
    activation: "next-invocation",
    sensitivity: "public",
    reversibility: "full",
    editor: { kind: "integer", min: 0, max: 10, step: 1 },
  },
  {
    key: "api.retry.baseDelayMs",
    group: "api.group.retry",
    order: 12,
    labelKey: "api.retry.baseDelayMs",
    descriptionKey: "api.retry.baseDelayMs.description",
    scopes: ["global"],
    merge: "provider-defined",
    activation: "next-invocation",
    sensitivity: "public",
    reversibility: "full",
    editor: { kind: "integer", min: 0, max: 600000, step: 100 },
  },
  {
    key: "api.promptCache",
    group: "api.group.cache",
    order: 12,
    labelKey: "api.promptCache",
    descriptionKey: "api.promptCache.description",
    scopes: ["global"],
    merge: "provider-defined",
    activation: "next-invocation",
    sensitivity: "public",
    reversibility: "full",
    defaultValue: PROMPT_CACHE_POLICY_DEFAULT,
    editor: {
      kind: "enum",
      options: PROMPT_CACHE_POLICIES.map((value) => ({ value, labelKey: `api.promptCache.${value}` })),
    },
  },
  {
    key: "api.cacheRetention",
    group: "api.group.cache",
    order: 13,
    labelKey: "api.cacheRetention",
    descriptionKey: "api.cacheRetention.description",
    scopes: ["global"],
    merge: "provider-defined",
    activation: "next-invocation",
    sensitivity: "public",
    reversibility: "full",
    defaultValue: CACHE_RETENTION_SETTING_DEFAULT,
    editor: {
      kind: "enum",
      options: ["auto", "short", "long", "none"].map((value) => ({ value, labelKey: `api.cacheRetention.${value}` })),
    },
  },
  {
    key: "api.agentCacheRetention",
    group: "api.group.cache",
    order: 14,
    labelKey: "api.agentCacheRetention",
    descriptionKey: "api.agentCacheRetention.description",
    scopes: ["global"],
    merge: "provider-defined",
    activation: "next-invocation",
    sensitivity: "public",
    reversibility: "full",
    defaultValue: AGENT_CACHE_RETENTION_DEFAULT,
    editor: {
      kind: "enum",
      options: ["short", "long", "none"].map((value) => ({ value, labelKey: `api.agentCacheRetention.${value}` })),
    },
  },
  {
    key: "api.overview",
    group: "api.group.diagnostics",
    order: 20,
    labelKey: "api.overview",
    descriptionKey: "api.overview.description",
    scopes: ["global"],
    merge: "provider-defined",
    activation: "live",
    sensitivity: "private",
    reversibility: "none",
    editor: { kind: "overview" },
  },
];

const CATALOGS = {
  en: {
    "api.provider": "API Manager",
    "api.provider.description": "Providers, models, endpoints, credentials, defaults and retry policy",
    "api.group.providers": "Providers and models",
    "api.group.retry": "Retry policy",
    "api.group.cache": "Prompt cache policy",
    "api.group.diagnostics": "Configuration overview",
    "api.providers": "Providers",
    "api.providers.description": "Provider endpoints, credentials and the models each provider serves — fully editable here",
    "api.field.id": "Provider id",
    "api.field.baseUrl": "Base URL",
    "api.field.api": "API protocol",
    "api.field.enabled": "Enabled",
    "api.field.apiKey": "API key",
    "api.field.models": "Models (JSON)",
    "api.item.provider": "{id}",
    "api.action.addProvider": "Add provider",
    "api.apiKind.openai-responses": "OpenAI Responses",
    "api.apiKind.openai-completions": "OpenAI Completions",
    "api.apiKind.anthropic-messages": "Anthropic Messages",
    "api.apiKind.azure-openai-responses": "Azure OpenAI Responses",
    "api.retry.enabled": "Auto-retry enabled",
    "api.retry.maxRetries": "Max retries",
    "api.retry.baseDelayMs": "Retry base delay (ms)",
    "api.retry.baseDelayMs.description": "Base delay for retry backoff. Applies to the next invocation.",
    "api.promptCache": "Prompt cache policy",
    "api.promptCache.description": "Whether OpenAI prompt-cache parameters (prompt_cache_options / prompt_cache_retention) are sent on OpenAI-format requests. Strict gateways reject them: off never sends them, auto sends them only for gpt-5.6+ models, on always sends them",
    "api.promptCache.auto": "Auto (gpt-5.6+ only)",
    "api.promptCache.off": "Off (never send)",
    "api.promptCache.on": "On (always send)",
    "api.settings.invalidPromptCache": "Prompt cache policy must be auto, off or on",
    "api.cacheRetention": "Main-flow cache tier",
    "api.cacheRetention.description": "Cache tier for the main agent: long keeps cache entries for 1h (Anthropic) / 24h (OpenAI); short is 5m / implicit 30m; none disables caching. auto keeps an existing PI_CACHE_RETENTION env untouched",
    "api.cacheRetention.auto": "Auto (keep env)",
    "api.cacheRetention.short": "Short (5m / 30m)",
    "api.cacheRetention.long": "Long (1h / 24h)",
    "api.cacheRetention.none": "None (no caching)",
    "api.agentCacheRetention": "Agent cache tier",
    "api.agentCacheRetention.description": "Cache tier for teammate subprocesses; they never inherit the main flow's long tier (default short)",
    "api.agentCacheRetention.short": "Short (5m / 30m)",
    "api.agentCacheRetention.long": "Long (1h / 24h)",
    "api.agentCacheRetention.none": "None (no caching)",
    "api.settings.invalidCacheRetention": "Cache retention must be auto, short, long or none",
    "api.settings.invalidAgentCacheRetention": "Agent cache retention must be short, long or none",
    "api.overview": "Configuration overview",
    "api.overview.description": "Effective providers, retry policy and config file paths",
    "api.action.manage": "Open API Manager",
    "api.action.manage.description": "Opens the full API Manager menu for all provider operations",
    "api.action.configure": "Add or edit a provider model",
    "api.action.configure.description": "Configure provider endpoints, model IDs, API keys and model capabilities",
    "api.action.retry": "Configure API retries",
    "api.action.retry.description": "Review or change the global retry policy used for API requests",
    "api.action.cache": "Prompt cache policy",
    "api.action.cache.description": "Choose whether OpenAI prompt-cache parameters are sent (auto / off / on)",
    "api.action.list": "Show configured providers and models",
    "api.action.list.description": "Display the effective provider, model, defaults and retry configuration",
    "api.settings.readOnly": "API Manager entries are actions and cannot be committed as draft values",
    "api.settings.invalidProviders": "Providers must be a list of objects with an id",
    "api.settings.invalidRetry": "Retry values are invalid",
    "api.overview.providers": "Providers",
    "api.overview.retry": "Auto-retry",
    "api.overview.retryOn": "On · max {count} · base {delay}ms",
    "api.overview.retryOff": "Off",
    "api.overview.promptCache": "Prompt cache",
    "api.overview.cacheRetention": "Cache tiers (main / agent)",
    "api.overview.file": "Config file",
    "api.overview.unconfigured": "No providers configured",
  },
  "zh-CN": {
    "api.provider": "API Manager",
    "api.provider.description": "管理 Provider、模型、端点、凭据、默认值与重试策略",
    "api.group.providers": "Provider 与模型",
    "api.group.retry": "API 重试策略",
    "api.group.cache": "提示缓存策略",
    "api.group.diagnostics": "配置概览",
    "api.providers": "Providers",
    "api.providers.description": "Provider 端点、凭据与各 provider 提供的模型 —— 均可在此完整配置",
    "api.field.id": "Provider ID",
    "api.field.baseUrl": "Base URL",
    "api.field.api": "API 协议",
    "api.field.enabled": "启用",
    "api.field.apiKey": "API Key",
    "api.field.models": "模型（JSON）",
    "api.item.provider": "{id}",
    "api.action.addProvider": "新增 Provider",
    "api.apiKind.openai-responses": "OpenAI Responses",
    "api.apiKind.openai-completions": "OpenAI Completions",
    "api.apiKind.anthropic-messages": "Anthropic Messages",
    "api.apiKind.azure-openai-responses": "Azure OpenAI Responses",
    "api.retry.enabled": "启用自动重试",
    "api.retry.maxRetries": "最大重试次数",
    "api.retry.baseDelayMs": "重试基础延迟（毫秒）",
    "api.retry.baseDelayMs.description": "重试退避的基础延迟。下一次调用生效。",
    "api.promptCache": "提示缓存策略",
    "api.promptCache.description": "控制是否发送 OpenAI 提示缓存参数（prompt_cache_options / prompt_cache_retention）。部分网关会拒绝这些参数：禁止模式不发送，自动模式仅对 gpt-5.6+ 模型发送，开启模式始终发送",
    "api.promptCache.auto": "自动（仅 gpt-5.6+）",
    "api.promptCache.off": "禁止（不发送）",
    "api.promptCache.on": "开启（始终发送）",
    "api.settings.invalidPromptCache": "提示缓存策略必须是 auto、off 或 on",
    "api.cacheRetention": "主流程缓存档位",
    "api.cacheRetention.description": "主 agent 的缓存档位：long 保留 1h（Anthropic）/ 24h（OpenAI）；short 为 5m / 隐含 30m；none 关闭缓存。auto 保持现有 PI_CACHE_RETENTION 环境变量不变",
    "api.cacheRetention.auto": "自动（保留环境变量）",
    "api.cacheRetention.short": "短档（5m / 30m）",
    "api.cacheRetention.long": "长档（1h / 24h）",
    "api.cacheRetention.none": "关闭（不缓存）",
    "api.agentCacheRetention": "Agent 缓存档位",
    "api.agentCacheRetention.description": "teammate 子进程的缓存档位；子进程不继承主流程的 long 档（默认 short）",
    "api.agentCacheRetention.short": "短档（5m / 30m）",
    "api.agentCacheRetention.long": "长档（1h / 24h）",
    "api.agentCacheRetention.none": "关闭（不缓存）",
    "api.settings.invalidCacheRetention": "缓存档位必须是 auto、short、long 或 none",
    "api.settings.invalidAgentCacheRetention": "Agent 缓存档位必须是 short、long 或 none",
    "api.overview": "配置概览",
    "api.overview.description": "当前生效的 Provider、重试策略与配置文件路径",
    "api.action.manage": "打开 API Manager",
    "api.action.manage.description": "进入完整 API Manager 菜单，执行全部 Provider 管理操作",
    "api.action.configure": "新增或编辑 Provider 模型",
    "api.action.configure.description": "配置 Provider 端点、模型 ID、API Key 与模型能力",
    "api.action.retry": "配置 API 重试",
    "api.action.retry.description": "查看或修改 API 请求使用的全局重试策略",
    "api.action.cache": "提示缓存策略",
    "api.action.cache.description": "选择是否发送 OpenAI 提示缓存参数（自动 / 禁止 / 开启）",
    "api.action.list": "查看已配置的 Provider 与模型",
    "api.action.list.description": "显示当前生效的 Provider、模型、默认值与重试配置",
    "api.settings.readOnly": "API Manager 项目是管理操作，不能作为草稿值提交",
    "api.settings.invalidProviders": "Providers 必须是含 id 的对象列表",
    "api.settings.invalidRetry": "重试配置值无效",
    "api.overview.providers": "Providers",
    "api.overview.retry": "自动重试",
    "api.overview.retryOn": "开启 · 最大 {count} 次 · 基础 {delay}ms",
    "api.overview.retryOff": "关闭",
    "api.overview.promptCache": "提示缓存",
    "api.overview.cacheRetention": "缓存档位（主流程 / agent）",
    "api.overview.file": "配置文件",
    "api.overview.unconfigured": "尚未配置任何 Provider",
  },
} as const;

interface ApiProviderEntry {
  id: string;
  baseUrl: string;
  api: string;
  enabled: boolean;
  apiKey: string | null;
  models?: JsonValue;
}

function parseProviderEntry(value: unknown): ApiProviderEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.length === 0) return undefined;
  return {
    id: entry.id,
    baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : "",
    api: typeof entry.api === "string" ? entry.api : "openai-responses",
    enabled: entry.enabled !== false,
    apiKey: typeof entry.apiKey === "string" ? entry.apiKey : null,
    models: Array.isArray(entry.models) ? (entry.models as JsonValue) : undefined,
  };
}

function providerConfig(entry: ApiProviderEntry): Record<string, unknown> {
  const config: Record<string, unknown> = {
    baseUrl: entry.baseUrl,
    api: entry.api,
    enabled: entry.enabled,
  };
  if (entry.apiKey && entry.apiKey !== SETTINGS_SECRET_SET_PLACEHOLDER) config.apiKey = entry.apiKey;
  if (Array.isArray(entry.models)) config.models = entry.models;
  return config;
}

export function createApiManagerSettingsProvider(
  options: ApiManagerSettingsProviderOptions = {},
): ApiManagerSettingsProvider {
  const instanceId = randomUUID();
  const getModelsPath = options.getModelsPath ?? (() => `${getAgentDir()}/models.json`);
  const getSettingsPath = options.getSettingsPath ?? (() => `${getAgentDir()}/settings.json`);
  const originals = new Map<string, { models: string; settings: string }>();
  const preparedChanges = new Map<string, readonly SettingsChange[]>();

  const load = async (): Promise<{
    providers: ApiProviderEntry[];
    modelsRoot: Record<string, unknown>;
    retry: { enabled: boolean; maxRetries: number; baseDelayMs?: number };
    promptCache: PromptCachePolicy;
    cacheRetention: CacheRetentionSetting;
    agentCacheRetention: CacheRetention;
    modelsContent: string;
    settingsContent: string;
  }> => {
    const modelsPath = getModelsPath();
    const settingsPath = getSettingsPath();
    const modelsRoot = await readModelsRoot(modelsPath);
    const providersRecord = modelsRoot.providers !== undefined && modelsRoot.providers !== null
      && typeof modelsRoot.providers === "object"
      ? modelsRoot.providers as Record<string, unknown>
      : {};
    const providers = Object.entries(providersRecord)
      .map(([id, config]) => {
        const entry = config !== undefined && config !== null && typeof config === "object"
          ? config as Record<string, unknown>
          : {};
        const parsed = parseProviderEntry({ ...entry, id });
        if (!parsed) return undefined;
        return {
          ...parsed,
          apiKey: typeof entry.apiKey === "string" ? SETTINGS_SECRET_SET_PLACEHOLDER : null,
        };
      })
      .filter((entry): entry is ApiProviderEntry => entry !== undefined)
      .sort((left, right) => left.id.localeCompare(right.id));
    const retry = await loadApiRetrySettings(settingsPath);
    const promptCache = await loadPromptCachePolicy(settingsPath);
    const cacheRetention = await loadCacheRetentionSetting(settingsPath);
    const agentCacheRetention = await loadAgentCacheRetention(settingsPath);
    const { readFile } = await import("node:fs/promises");
    const readContent = async (path: string): Promise<string> => {
      try { return await readFile(path, "utf8"); } catch { return ""; }
    };
    return { providers, modelsRoot, retry, promptCache, cacheRetention, agentCacheRetention, modelsContent: await readContent(modelsPath), settingsContent: await readContent(settingsPath) };
  };

  const snapshotFor = (
    instanceId: string,
    data: Awaited<ReturnType<typeof load>>,
    definitions: readonly SettingDefinition[],
  ): SettingsSnapshot => {
    const configured: ConfiguredSettingValue[] = [];
    const effective: EffectiveSettingValue[] = [];
    for (const definition of definitions) {
      if (definition.key === "api.providers") {
        configured.push({ key: definition.key, scope: "global", state: "set", value: data.providers as unknown as JsonValue });
        effective.push({ key: definition.key, value: data.providers as unknown as JsonValue, source: "configured", scope: "global" });
      } else if (definition.key === "api.retry.enabled") {
        configured.push({ key: definition.key, scope: "global", state: "set", value: data.retry.enabled });
        effective.push({ key: definition.key, value: data.retry.enabled, source: "configured", scope: "global" });
      } else if (definition.key === "api.retry.maxRetries") {
        configured.push({ key: definition.key, scope: "global", state: "set", value: data.retry.maxRetries });
        effective.push({ key: definition.key, value: data.retry.maxRetries, source: "configured", scope: "global" });
      } else if (definition.key === "api.retry.baseDelayMs") {
        configured.push({ key: definition.key, scope: "global", state: "set", value: data.retry.baseDelayMs ?? 2000 });
        effective.push({ key: definition.key, value: data.retry.baseDelayMs ?? 2000, source: "configured", scope: "global" });
      } else if (definition.key === "api.promptCache") {
        configured.push({ key: definition.key, scope: "global", state: "set", value: data.promptCache });
        effective.push({ key: definition.key, value: data.promptCache, source: "configured", scope: "global" });
      } else if (definition.key === "api.cacheRetention") {
        configured.push({ key: definition.key, scope: "global", state: "set", value: data.cacheRetention });
        effective.push({ key: definition.key, value: data.cacheRetention, source: "configured", scope: "global" });
      } else if (definition.key === "api.agentCacheRetention") {
        configured.push({ key: definition.key, scope: "global", state: "set", value: data.agentCacheRetention });
        effective.push({ key: definition.key, value: data.agentCacheRetention, source: "configured", scope: "global" });
      } else if (definition.key === "api.overview") {
        const rows: SettingsOverviewRow[] = [
          ...(data.providers.length === 0
            ? [{ label: "", value: "", status: "dim" as const }]
            : data.providers.map((entry) => ({
              label: entry.id,
              value: entry.enabled ? `${entry.api} · ${entry.baseUrl || "no base URL"}` : "disabled",
              status: (entry.enabled ? "ok" : "warn") as "ok" | "warn",
            }))),
          {
            labelKey: "api.overview.retry",
            value: data.retry.enabled
              ? `On · max ${data.retry.maxRetries}`
              : "Off",
            status: data.retry.enabled ? "ok" : "dim",
          },
          {
            labelKey: "api.overview.promptCache",
            value: data.promptCache,
            status: "ok",
          },
          {
            labelKey: "api.overview.cacheRetention",
            value: `${data.cacheRetention} / agent ${data.agentCacheRetention}`,
            status: "ok",
          },
          { labelKey: "api.overview.file", value: getModelsPath(), status: "dim" },
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
      labelKey: "api.provider",
      descriptionKey: "api.provider.description",
      order: 15,
      capabilities: { read: true, write: true, prepareCommit: true, rollback: "compensating", hotUpdate: true },
      settings: DEFINITIONS,
      catalogs: CATALOGS,
    }),
    read: async (request) => snapshotFor(instanceId, await load(), DEFINITIONS),
    validate: (request) => {
      const issues: SettingsValidationIssue[] = [];
      for (const change of request.changes) {
        if (change.key === "api.providers" && change.operation === "set") {
          if (!Array.isArray(change.value) || !change.value.every((entry) => parseProviderEntry(entry))) {
            issues.push({
              severity: "error",
              key: change.key,
              scope: change.scope,
              code: "invalid-providers",
              messageKey: "api.settings.invalidProviders",
            });
          }
        }
        if (change.key === "api.retry.maxRetries" && change.operation === "set"
          && (!Number.isSafeInteger(change.value) || (change.value as number) < 0 || (change.value as number) > 10)) {
          issues.push({
            severity: "error",
            key: change.key,
            scope: change.scope,
            code: "invalid-retry",
            messageKey: "api.settings.invalidRetry",
          });
        }
        if (change.key === "api.promptCache" && change.operation === "set" && !isPromptCachePolicy(change.value)) {
          issues.push({
            severity: "error",
            key: change.key,
            scope: change.scope,
            code: "invalid-prompt-cache",
            messageKey: "api.settings.invalidPromptCache",
          });
        }
        if (change.key === "api.cacheRetention" && change.operation === "set" && !isCacheRetentionSetting(change.value)) {
          issues.push({
            severity: "error",
            key: change.key,
            scope: change.scope,
            code: "invalid-cache-retention",
            messageKey: "api.settings.invalidCacheRetention",
          });
        }
        if (change.key === "api.agentCacheRetention" && change.operation === "set" && !isAgentCacheRetention(change.value)) {
          issues.push({
            severity: "error",
            key: change.key,
            scope: change.scope,
            code: "invalid-agent-cache-retention",
            messageKey: "api.settings.invalidAgentCacheRetention",
          });
        }
      }
      return { valid: issues.length === 0, issues, conflicts: [] };
    },
    prepare: async (request) => {
      const data = await load();
      const changedKeys = request.changes.map((change) => change.key);
      if (changedKeys.includes("api.providers") || changedKeys.includes("api.retry.enabled")
        || changedKeys.includes("api.retry.maxRetries") || changedKeys.includes("api.promptCache")
        || changedKeys.includes("api.cacheRetention") || changedKeys.includes("api.agentCacheRetention")) {
        originals.set(request.transactionId, { models: data.modelsContent, settings: data.settingsContent });
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
      const modelsPath = getModelsPath();
      const settingsPath = getSettingsPath();
      const data = await load();
      const changes = preparedChanges.get(request.transactionId) ?? [];
      const providersChange = changes.find((change) => change.key === "api.providers");
      const retryEnabled = changes.find((change) => change.key === "api.retry.enabled");
      const retryMax = changes.find((change) => change.key === "api.retry.maxRetries");
      const promptCacheChange = changes.find((change) => change.key === "api.promptCache");
      const cacheRetentionChange = changes.find((change) => change.key === "api.cacheRetention");
      const agentCacheRetentionChange = changes.find((change) => change.key === "api.agentCacheRetention");
      let modelsWritten = false;
      try {
        if (providersChange?.operation === "set" && Array.isArray(providersChange.value)) {
          const entries = providersChange.value.map((entry) => parseProviderEntry(entry)).filter((entry): entry is ApiProviderEntry => entry !== undefined);
          const existing = data.modelsRoot.providers !== undefined && typeof data.modelsRoot.providers === "object"
            ? data.modelsRoot.providers as Record<string, unknown>
            : {};
          const nextProviders: Record<string, unknown> = {};
          for (const entry of entries) {
            const previous = typeof existing[entry.id] === "object" && existing[entry.id] !== null
              ? existing[entry.id] as Record<string, unknown>
              : undefined;
            const config = providerConfig(entry);
            if (previous && (entry.apiKey === null || entry.apiKey === SETTINGS_SECRET_SET_PLACEHOLDER)) {
              if (typeof previous.apiKey === "string") config.apiKey = previous.apiKey;
            }
            if (Array.isArray(entry.models)) config.models = entry.models;
            else if (previous && Array.isArray(previous.models)) config.models = previous.models;
            nextProviders[entry.id] = config;
          }
          const nextRoot = { ...data.modelsRoot, providers: nextProviders };
          await writeModelsRoot(nextRoot, modelsPath, await existsFile(modelsPath));
          modelsWritten = true;
        }
        const retryBase = changes.find((change) => change.key === "api.retry.baseDelayMs");
        if (retryEnabled?.operation === "set" || retryMax?.operation === "set" || retryBase?.operation === "set") {
          const next = {
            enabled: retryEnabled?.operation === "set" ? retryEnabled.value as boolean : data.retry.enabled,
            maxRetries: retryMax?.operation === "set" ? retryMax.value as number : data.retry.maxRetries,
            baseDelayMs: retryBase?.operation === "set" ? retryBase.value as number : data.retry.baseDelayMs ?? 2000,
          };
          await saveApiRetrySettings(next, settingsPath);
        }
        if (promptCacheChange?.operation === "set") {
          await savePromptCachePolicy(promptCacheChange.value as PromptCachePolicy, settingsPath);
        }
        if (cacheRetentionChange?.operation === "set") {
          await saveCacheRetentionSetting(cacheRetentionChange.value as CacheRetentionSetting, settingsPath);
        }
        if (agentCacheRetentionChange?.operation === "set") {
          await saveAgentCacheRetention(agentCacheRetentionChange.value as CacheRetention, settingsPath);
        }
        if (cacheRetentionChange?.operation === "set" || agentCacheRetentionChange?.operation === "set") {
          applyCacheRetentionEnv(settingsPath);
        }
      } catch (error) {
        if (modelsWritten) {
          try { await writeModelsRoot(data.modelsRoot, modelsPath, true); } catch { /* best-effort restore */ }
        }
        throw error;
      }
      originals.delete(request.transactionId);
      preparedChanges.delete(request.transactionId);
      const snapshot = snapshotFor(instanceId, await load(), DEFINITIONS);
      return {
        snapshot,
        revisions: [{
          resource: { providerId: PROVIDER_ID, scope: "global", id: getModelsPath() },
          etag: `api-${Date.now()}`,
        }],
        changedKeys: changes.map((change) => change.key),
        activation: [{ boundary: "next-invocation", keys: changes.map((change) => change.key) }],
      };
    },
    abort: (request) => {
      originals.delete(request.transactionId);
    },
    rollback: async (request) => {
      const original = originals.get(request.transactionId);
      originals.delete(request.transactionId);
      if (!original) return { rolledBack: false };
      try {
        if (original.models !== "") await writeModelsRoot(JSON.parse(original.models) as Record<string, unknown>, getModelsPath(), true);
        if (original.settings !== "") await writeModelsRoot(JSON.parse(original.settings) as Record<string, unknown>, getSettingsPath(), true);
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

async function existsFile(path: string): Promise<boolean> {
  const { access } = await import("node:fs/promises");
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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

function isDiscover(payload: unknown): payload is SettingsDiscoverEventV1 {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as Partial<SettingsDiscoverEventV1>;
  return candidate.version === SETTINGS_PROTOCOL_VERSION
    && typeof candidate.requestId === "string"
    && Boolean(candidate.context)
    && typeof candidate.context?.cwd === "string";
}
