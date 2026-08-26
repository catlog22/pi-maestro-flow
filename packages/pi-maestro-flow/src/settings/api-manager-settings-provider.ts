import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
import { NETWORK_RETRY_POLICY } from "pi-maestro-teammate/v1/retry";
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

/**
 * Agent identity header presets, extracted from sub2api's outbound identity
 * layer (Wei-Shaw/sub2api): each upstream gateway fingerprints the client by
 * User-Agent (and friends) and rejects traffic that does not look like the
 * official CLI. Selecting a preset stamps the same identity on pi's requests.
 *
 * - claude-code: claude.DefaultHeaders + applyClaudeCodeMimicHeaders (claude-cli/2.1.220)
 * - codex: codexCLIUserAgent = codex-tui/0.146.0 (Ubuntu 22.4.0; x86_64) xterm-256color
 * - grok: xai CLI identity = xai-grok-workspace/0.2.114 + x-grok-client-version + x-grok-client-identifier
 * - antigravity: antigravity/1.23.2 windows/amd64
 */
export const AGENT_HEADER_PRESETS = {
  none: {},
  "claude-code": {
    "User-Agent": "claude-cli/2.1.220 (external, cli)",
    "X-Stainless-Lang": "js",
    "X-Stainless-Package-Version": "0.94.0",
    "X-Stainless-OS": "Linux",
    "X-Stainless-Arch": "arm64",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Runtime-Version": "v24.3.0",
    "X-Stainless-Retry-Count": "0",
    "X-Stainless-Timeout": "600",
    "X-App": "cli",
    "Anthropic-Dangerous-Direct-Browser-Access": "true",
  },
  codex: {
    "User-Agent": "codex-tui/0.146.0 (Ubuntu 22.4.0; x86_64) xterm-256color",
  },
  grok: {
    "User-Agent": "xai-grok-workspace/0.2.114",
    "X-Grok-Client-Version": "0.2.114",
    "X-Grok-Client-Identifier": "grok-shell",
  },
  antigravity: {
    "User-Agent": "antigravity/1.23.2 windows/amd64",
  },
} as const;

export type AgentHeaderPreset = keyof typeof AGENT_HEADER_PRESETS;

export function isAgentHeaderPreset(value: unknown): value is AgentHeaderPreset {
  return typeof value === "string" && value in AGENT_HEADER_PRESETS;
}

export function expandAgentHeaderPreset(
  preset: AgentHeaderPreset | undefined,
  custom: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const presetHeaders = preset && preset !== "none" ? { ...AGENT_HEADER_PRESETS[preset] } : {};
  const merged = { ...presetHeaders, ...(custom ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

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
  field("headerPreset", "enum", "api.field.headerPreset", {
    options: (Object.keys(AGENT_HEADER_PRESETS) as AgentHeaderPreset[]).map((value) => ({ value, labelKey: `api.headerPreset.${value}` })),
  }, "none"),
  field("headers", "json", "api.field.headers", { multiline: true }),
];

/** Item fields for the flat api.models list; providerId reuses an existing provider's url+key. */
function modelItemFields(providerIds: readonly string[]): readonly SettingDefinition[] {
  // labelKey falls back to the key itself, so a provider id renders verbatim.
  const providerOptions = providerIds.map((id) => ({ value: id, labelKey: id }));
  return [
    field("providerId", "enum", "api.field.providerId", {
      options: providerOptions,
    }, providerIds[0]),
    field("id", "text", "api.field.modelId"),
    field("name", "text", "api.field.modelName"),
    field("reasoning", "boolean", "api.field.reasoning", {}, true),
    field("input", "string-list", "api.field.input", {}, ["text", "image"]),
    field("contextWindow", "integer", "api.field.contextWindow", {}, 800000),
    field("maxTokens", "integer", "api.field.maxTokens", {}, 128000),
    field("thinkingLevelMap", "json", "api.field.thinkingLevelMap", { multiline: true }, { off: null, xhigh: "max" }),
  ];
}

function modelsDefinition(providerIds: readonly string[]): SettingDefinition {
  return {
    key: "api.models",
    group: "api.group.models",
    order: 1,
    labelKey: "api.models",
    descriptionKey: "api.models.description",
    scopes: ["global"],
    merge: "provider-defined",
    activation: "next-invocation",
    sensitivity: "public",
    reversibility: "full",
    editor: {
      kind: "list-crud",
      itemLabelKey: "api.item.model",
      addLabelKey: "api.models.add",
      itemFields: modelItemFields(providerIds),
    },
  };
}

function allDefinitions(providerIds: readonly string[]): readonly SettingDefinition[] {
  // Models slot in right after Providers (order 1) so the setting list stays grouped.
  return [DEFINITIONS[0], modelsDefinition(providerIds), ...DEFINITIONS.slice(1)];
}

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
    editor: { kind: "integer", min: 0, max: 20, step: 1 },
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
    key: "api.retry.maxDelayMs",
    group: "api.group.retry",
    order: 13,
    labelKey: "api.retry.maxDelayMs",
    descriptionKey: "api.retry.maxDelayMs.description",
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
    "api.group.providers": "Providers",
    "api.group.models": "Models",
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
    "api.field.headerPreset": "Agent response headers",
    "api.field.headers": "Custom headers (JSON)",
    "api.headerPreset.none": "None (pi default)",
    "api.headerPreset.claude-code": "Claude Code CLI",
    "api.headerPreset.codex": "Codex CLI",
    "api.headerPreset.grok": "Grok CLI",
    "api.headerPreset.antigravity": "Antigravity CLI",
    "api.field.providerId": "Provider",
    "api.field.modelId": "Model id",
    "api.field.modelName": "Name",
    "api.field.reasoning": "Reasoning",
    "api.field.input": "Input modalities",
    "api.field.contextWindow": "Context window",
    "api.field.maxTokens": "Max tokens",
    "api.field.thinkingLevelMap": "Thinking level map (JSON)",
    "api.item.provider": "{id}",
    "api.action.addProvider": "Add provider",
    "api.models": "Models",
    "api.models.description": "Every model across providers. Adding a model to an existing provider reuses its base URL and API key — only the model part needs setting.",
    "api.item.model": "{providerId} / {id}",
    "api.models.add": "Add model",
    "api.apiKind.openai-responses": "OpenAI Responses",
    "api.apiKind.openai-completions": "OpenAI Completions",
    "api.apiKind.anthropic-messages": "Anthropic Messages",
    "api.apiKind.azure-openai-responses": "Azure OpenAI Responses",
    "api.retry.enabled": "Auto-retry enabled",
    "api.retry.maxRetries": "Max retries",
    "api.retry.baseDelayMs": "Retry base delay (ms)",
    "api.retry.baseDelayMs.description": "Base delay for retry backoff. Applies to the next invocation.",
    "api.retry.maxDelayMs": "Max backoff delay (ms)",
    "api.retry.maxDelayMs.description": "Backoff cap for the last retry: exponential growth stops here. 0 waits nothing on the final retry. Applies to the next invocation.",
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
    "api.action.filter": "Filter teammate-visible models",
    "api.action.filter.description": "Hide selected models for an account-scoped provider so they don't appear in the teammate model selector",
    "api.settings.readOnly": "API Manager entries are actions and cannot be committed as draft values",
    "api.settings.invalidProviders": "Providers must be a list of objects with an id",
    "api.settings.invalidModels": "Each model needs an existing provider and a non-empty model id",
    "api.settings.invalidHeaders": "Custom headers must be a JSON object with string values",
    "api.settings.invalidRetry": "Retry values are invalid",
    "api.overview.providers": "Providers",
    "api.overview.models": "Models",
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
    "api.group.providers": "Providers",
    "api.group.models": "模型",
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
    "api.field.headerPreset": "Agent 响应头",
    "api.field.headers": "自定义请求头（JSON）",
    "api.headerPreset.none": "无（pi 默认）",
    "api.headerPreset.claude-code": "Claude Code CLI",
    "api.headerPreset.codex": "Codex CLI",
    "api.headerPreset.grok": "Grok CLI",
    "api.headerPreset.antigravity": "Antigravity CLI",
    "api.field.providerId": "Provider",
    "api.field.modelId": "模型 ID",
    "api.field.modelName": "名称",
    "api.field.reasoning": "推理",
    "api.field.input": "输入模态",
    "api.field.contextWindow": "上下文窗口",
    "api.field.maxTokens": "最大 Tokens",
    "api.field.thinkingLevelMap": "思考等级映射（JSON）",
    "api.item.provider": "{id}",
    "api.action.addProvider": "新增 Provider",
    "api.models": "模型",
    "api.models.description": "所有 Provider 下的全部模型。向已有 Provider 添加模型会自动复用其 Base URL 与 API Key —— 只需配置模型部分。",
    "api.item.model": "{providerId} / {id}",
    "api.models.add": "添加模型",
    "api.apiKind.openai-responses": "OpenAI Responses",
    "api.apiKind.openai-completions": "OpenAI Completions",
    "api.apiKind.anthropic-messages": "Anthropic Messages",
    "api.apiKind.azure-openai-responses": "Azure OpenAI Responses",
    "api.retry.enabled": "启用自动重试",
    "api.retry.maxRetries": "最大重试次数",
    "api.retry.baseDelayMs": "重试基础延迟（毫秒）",
    "api.retry.baseDelayMs.description": "重试退避的基础延迟。下一次调用生效。",
    "api.retry.maxDelayMs": "最大退避延迟（毫秒）",
    "api.retry.maxDelayMs.description": "最后一次重试的退避上限：指数增长在此封顶。0 表示最后一次重试不等待。下一次调用生效。",
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
    "api.action.filter": "过滤 teammate 可见模型",
    "api.action.filter.description": "为账号型 Provider 屏蔽指定模型，避免其出现在 teammate 模型选择器中",
    "api.settings.readOnly": "API Manager 项目是管理操作，不能作为草稿值提交",
    "api.settings.invalidProviders": "Providers 必须是含 id 的对象列表",
    "api.settings.invalidModels": "每个模型需要已存在的 Provider 与不为空的模型 id",
    "api.settings.invalidHeaders": "自定义请求头必须是字符串值的 JSON 对象",
    "api.settings.invalidRetry": "重试配置值无效",
    "api.overview.providers": "Providers",
    "api.overview.models": "模型",
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
  headerPreset?: AgentHeaderPreset;
  headers?: Record<string, string>;
  models?: JsonValue;
}

function parseProviderEntry(value: unknown): ApiProviderEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.length === 0) return undefined;
  const headers = entry.headers !== undefined && entry.headers !== null
    && typeof entry.headers === "object" && !Array.isArray(entry.headers)
    ? Object.fromEntries(
      Object.entries(entry.headers).filter(([, headerValue]) => typeof headerValue === "string"),
    ) as Record<string, string>
    : undefined;
  return {
    id: entry.id,
    baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : "",
    api: typeof entry.api === "string" ? entry.api : "openai-responses",
    enabled: entry.enabled !== false,
    apiKey: typeof entry.apiKey === "string" ? entry.apiKey : null,
    headerPreset: isAgentHeaderPreset(entry.headerPreset) ? entry.headerPreset : "none",
    headers,
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
  if (entry.headerPreset && entry.headerPreset !== "none") config.headerPreset = entry.headerPreset;
  // Preset expansion wins; custom headers override same-name preset headers.
  // Without a preset, keep any existing custom headers untouched.
  const expandedHeaders = expandAgentHeaderPreset(entry.headerPreset, entry.headers);
  if (expandedHeaders) config.headers = expandedHeaders;
  else if (entry.headers) config.headers = entry.headers;
  return config;
}

/** Existing provider ids from models.json, for the api.models provider enum. */
function readProviderIdsSync(getModelsPath: () => string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(getModelsPath(), "utf8")) as { providers?: unknown };
    if (parsed?.providers && typeof parsed.providers === "object" && !Array.isArray(parsed.providers)) {
      return Object.keys(parsed.providers);
    }
  } catch {
    // Missing or invalid config is the normal unconfigured state.
  }
  return [];
}

/** Flatten every provider's models[] into a flat [{providerId, ...model}] list. */
function flattenModels(providers: readonly ApiProviderEntry[]): JsonValue {
  const items: Array<Record<string, unknown>> = [];
  for (const provider of providers) {
    if (!Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!model || typeof model !== "object" || Array.isArray(model)) continue;
      // Carry the full model record: the list-crud shell only edits declared
      // itemFields and preserves unknown keys, so unmanaged fields (cost,
      // headers, compat, model-level url/api, extensions) survive the round trip.
      items.push({ providerId: provider.id, ...(model as Record<string, unknown>) });
    }
  }
  return items as unknown as JsonValue;
}

/** Rebuild each provider's models[] from the flat list, grouped by providerId. */
function unflattenModels(items: JsonValue, providers: Record<string, unknown>): void {
  const byProvider = new Map<string, Array<Record<string, unknown>>>();
  if (Array.isArray(items)) {
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = { ...(item as Record<string, unknown>) };
      const providerId = record.providerId;
      if (typeof providerId !== "string" || typeof record.id !== "string" || !record.id.trim()) continue;
      delete record.providerId;
      const list = byProvider.get(providerId) ?? [];
      list.push(record);
      byProvider.set(providerId, list);
    }
  }
  // Single source of truth: every provider's models[] equals its grouped flat
  // items (empty when the flat list holds no item for it), so deleting the
  // last model of a provider really clears it instead of leaving the old array.
  for (const [providerId, config] of Object.entries(providers)) {
    if (config && typeof config === "object" && !Array.isArray(config)) {
      (config as Record<string, unknown>).models = byProvider.get(providerId) ?? [];
    }
  }
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
    retry: { enabled: boolean; maxRetries: number; baseDelayMs?: number; maxDelayMs?: number };
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
      } else if (definition.key === "api.retry.maxDelayMs") {
        configured.push({ key: definition.key, scope: "global", state: "set", value: data.retry.maxDelayMs ?? NETWORK_RETRY_POLICY.maxDelayMs });
        effective.push({ key: definition.key, value: data.retry.maxDelayMs ?? NETWORK_RETRY_POLICY.maxDelayMs, source: "configured", scope: "global" });
      } else if (definition.key === "api.promptCache") {
        configured.push({ key: definition.key, scope: "global", state: "set", value: data.promptCache });
        effective.push({ key: definition.key, value: data.promptCache, source: "configured", scope: "global" });
      } else if (definition.key === "api.cacheRetention") {
        configured.push({ key: definition.key, scope: "global", state: "set", value: data.cacheRetention });
        effective.push({ key: definition.key, value: data.cacheRetention, source: "configured", scope: "global" });
      } else if (definition.key === "api.agentCacheRetention") {
        configured.push({ key: definition.key, scope: "global", state: "set", value: data.agentCacheRetention });
        effective.push({ key: definition.key, value: data.agentCacheRetention, source: "configured", scope: "global" });
      } else if (definition.key === "api.models") {
        configured.push({ key: definition.key, scope: "global", state: "set", value: flattenModels(data.providers) as unknown as JsonValue });
        effective.push({ key: definition.key, value: flattenModels(data.providers) as unknown as JsonValue, source: "configured", scope: "global" });
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
            labelKey: "api.overview.models",
            value: String((flattenModels(data.providers) as Array<Record<string, unknown>>).length),
            status: "ok",
          },
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
      settings: allDefinitions(readProviderIdsSync(getModelsPath)),
      catalogs: CATALOGS,
    }),
    read: async () => snapshotFor(instanceId, await load(), allDefinitions(readProviderIdsSync(getModelsPath))),
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
          } else if (Array.isArray(change.value)
            && new Set(change.value.map((entry) => (entry as Record<string, unknown>).id)).size !== change.value.length) {
            issues.push({
              severity: "error",
              key: change.key,
              scope: change.scope,
              code: "invalid-providers",
              messageKey: "api.settings.invalidProviders",
            });
          } else if (Array.isArray(change.value) && change.value.some((entry) => {
            const headers = (entry as Record<string, unknown>).headers;
            return headers !== undefined && headers !== null && typeof headers === "object"
              && !Array.isArray(headers)
              && Object.values(headers).some((value) => typeof value !== "string");
          })) {
            issues.push({
              severity: "error",
              key: change.key,
              scope: change.scope,
              code: "invalid-headers",
              messageKey: "api.settings.invalidHeaders",
            });
          }
        }
        if (change.key === "api.models" && change.operation === "set") {
          const providerIds = readProviderIdsSync(getModelsPath);
          const items = Array.isArray(change.value) ? change.value : [];
          const seen = new Set<string>();
          const invalid = !Array.isArray(change.value) || items.some((item) => {
            // Reject non-object entries (null, strings, ...) before field access.
            if (!item || typeof item !== "object" || Array.isArray(item)) return true;
            const record = item as Record<string, unknown>;
            if (typeof record.providerId !== "string" || !providerIds.includes(record.providerId)
              || typeof record.id !== "string" || !record.id.trim()) return true;
            const identity = `${record.providerId}/${record.id.trim()}`;
            if (seen.has(identity)) return true;
            seen.add(identity);
            return false;
          });
          if (invalid) {
            issues.push({
              severity: "error",
              key: change.key,
              scope: change.scope,
              code: "invalid-models",
              messageKey: "api.settings.invalidModels",
            });
          }
        }
        if (change.key === "api.retry.maxRetries" && change.operation === "set"
          && (!Number.isSafeInteger(change.value) || (change.value as number) < 0 || (change.value as number) > 20)) {
          issues.push({
            severity: "error",
            key: change.key,
            scope: change.scope,
            code: "invalid-retry",
            messageKey: "api.settings.invalidRetry",
          });
        }
        if ((change.key === "api.retry.baseDelayMs" || change.key === "api.retry.maxDelayMs") && change.operation === "set"
          && (!Number.isSafeInteger(change.value) || (change.value as number) < 0 || (change.value as number) > 600000)) {
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
      if (changedKeys.includes("api.providers") || changedKeys.includes("api.models") || changedKeys.includes("api.retry.enabled")
        || changedKeys.includes("api.retry.maxRetries") || changedKeys.includes("api.retry.baseDelayMs")
        || changedKeys.includes("api.retry.maxDelayMs") || changedKeys.includes("api.promptCache")
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
      const retryBase = changes.find((change) => change.key === "api.retry.baseDelayMs");
      const retryMaxDelay = changes.find((change) => change.key === "api.retry.maxDelayMs");
      const promptCacheChange = changes.find((change) => change.key === "api.promptCache");
      const cacheRetentionChange = changes.find((change) => change.key === "api.cacheRetention");
      const agentCacheRetentionChange = changes.find((change) => change.key === "api.agentCacheRetention");
      let modelsWritten = false;
      try {
        const modelsChange = changes.find((change) => change.key === "api.models");
        if ((providersChange?.operation === "set" && Array.isArray(providersChange.value)) || modelsChange?.operation === "set") {
          const existing = data.modelsRoot.providers !== undefined && typeof data.modelsRoot.providers === "object"
            ? data.modelsRoot.providers as Record<string, unknown>
            : {};
          const nextProviders: Record<string, unknown> = {};
          if (providersChange?.operation === "set" && Array.isArray(providersChange.value)) {
            for (const raw of providersChange.value) {
              const entry = parseProviderEntry(raw);
              if (!entry) continue;
              const previous = typeof existing[entry.id] === "object" && existing[entry.id] !== null
                ? existing[entry.id] as Record<string, unknown>
                : undefined;
              const config = providerConfig(entry);
              if (previous && typeof previous === "object") {
                if ((entry.apiKey === null || entry.apiKey === SETTINGS_SECRET_SET_PLACEHOLDER) && typeof previous.apiKey === "string") {
                  config.apiKey = previous.apiKey;
                }
                // models are owned by api.models; preserve whatever is already there
                if (Array.isArray(previous.models)) config.models = previous.models;
                // preserve provider fields the editor does not manage (compat, name, ...)
                for (const [key, value] of Object.entries(previous)) {
                  if (!(key in config)) config[key] = value;
                }
                // Explicitly cleared managed fields must not be resurrected from
                // the previous record: "none" clears the preset, null clears headers.
                if (entry.headerPreset === "none") delete config.headerPreset;
                if (raw !== null && typeof raw === "object" && !Array.isArray(raw)
                  && (raw as Record<string, unknown>).headers == null) {
                  delete config.headers;
                }
              }
              nextProviders[entry.id] = config;
            }
          } else {
            Object.assign(nextProviders, existing);
          }
          if (modelsChange?.operation === "set") {
            unflattenModels(modelsChange.value as JsonValue, nextProviders);
          }
          const nextRoot = { ...data.modelsRoot, providers: nextProviders };
          await writeModelsRoot(nextRoot, modelsPath, await existsFile(modelsPath));
          modelsWritten = true;
        }
        const retryBase = changes.find((change) => change.key === "api.retry.baseDelayMs");
        const retryMaxDelay = changes.find((change) => change.key === "api.retry.maxDelayMs");
        if (retryEnabled?.operation === "set" || retryMax?.operation === "set" || retryBase?.operation === "set" || retryMaxDelay?.operation === "set") {
          const next = {
            enabled: retryEnabled?.operation === "set" ? retryEnabled.value as boolean : data.retry.enabled,
            maxRetries: retryMax?.operation === "set" ? retryMax.value as number : data.retry.maxRetries,
            baseDelayMs: retryBase?.operation === "set" ? retryBase.value as number : data.retry.baseDelayMs ?? 2000,
            maxDelayMs: retryMaxDelay?.operation === "set" ? retryMaxDelay.value as number : data.retry.maxDelayMs ?? NETWORK_RETRY_POLICY.maxDelayMs,
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
      const snapshot = snapshotFor(instanceId, await load(), allDefinitions(readProviderIdsSync(getModelsPath)));
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
