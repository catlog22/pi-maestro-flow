import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
  type SettingsOverviewStatus,
  type SettingsProviderV1,
  type SettingsResourceRevision,
  type SettingsSelectOption,
  type SettingsSnapshot,
  type SettingsValidationIssue,
  type SupportedSettingsLocale,
} from "pi-maestro-settings-core/v1";
import { SETTINGS_SECRET_SET_PLACEHOLDER } from "pi-maestro-settings-core/v1/schema";
import {
  ALL_CONFIG_KEYS,
  SMART_SEARCH_CONFIG_KEYS,
  SmartSearchConfigStore,
  WEB_ACCESS_SYNC_MAPPINGS,
  configGroupForKey,
  isSmartSearchSecretKey,
  resolveSmartSearchConfigPath,
  syncMappingForSmartSearchKey,
  type SmartSearchConfig,
} from "../tools/smart-search-config.ts";
import { invalidateWebConfigCaches } from "../tools/web-access/web-config-cache.ts";

const PROVIDER_ID = "pi-maestro-smart-search";
const PROVIDER_VERSION = "1.0.0";

const OVERVIEW_KEY = "smartSearch.sync";
const ACTION_KEY = "smartSearch.pushSync";

type SmartSearchSettingsAction = (context: SettingsContextV1) => Promise<void> | void;

interface SettingsEventBus {
  on(event: string, handler: (payload: unknown) => void): void | (() => void);
  emit(event: string, payload: unknown): void;
}

export interface SmartSearchSettingsProvider extends SettingsProviderV1 {
  readonly providerId: typeof PROVIDER_ID;
  readonly instanceId: string;
}

export interface SmartSearchSettingsProviderOptions {
  getConfigPath?: () => string;
  getWebConfigPath?: () => string;
  actions?: Readonly<Record<string, SmartSearchSettingsAction>>;
}

type ConfigEditorKind = "text" | "number" | "boolean" | "secret" | "enum";

const BOOLEAN_CONFIG_KEYS = new Set([
  "OPENAI_COMPATIBLE_STREAM",
  "TAVILY_ENABLED",
  "SMART_SEARCH_DEBUG",
  "SMART_SEARCH_OUTPUT_CLEANUP",
  "SMART_SEARCH_LOG_TO_FILE",
  "SSL_VERIFY",
  // Native web-search keys.
  "ALLOW_BROWSER_COOKIES",
  "SSRF_TRUST_ENV_PROXY",
  "WEB_SEARCH_ENABLED",
  "VIDEO_ENABLED",
  "YOUTUBE_ENABLED",
]);

const NUMBER_CONFIG_KEYS = new Set([
  "INTENT_EMBEDDING_THRESHOLD",
  "INTENT_EMBEDDING_MARGIN",
  "INTENT_ROUTER_TIMEOUT_SECONDS",
  "EXA_TIMEOUT_SECONDS",
  "CONTEXT7_TIMEOUT_SECONDS",
  "ZHIPU_TIMEOUT_SECONDS",
  "ZHIPU_MCP_TIMEOUT_SECONDS",
  "JINA_TIMEOUT_SECONDS",
  "TAVILY_TIMEOUT_SECONDS",
  "ANYSEARCH_TIMEOUT_SECONDS",
  "SMART_SEARCH_RETRY_MAX_ATTEMPTS",
  "SMART_SEARCH_RETRY_MULTIPLIER",
  "SMART_SEARCH_RETRY_MAX_WAIT",
  // Native web-search keys.
  "CURATOR_TIMEOUT_SECONDS",
  "VIDEO_MAX_SIZE_MB",
]);

const ENUM_OPTIONS: Readonly<Record<string, readonly SettingsSelectOption[]>> = {
  SMART_SEARCH_VALIDATION_LEVEL: [
    { value: "fast", labelKey: "smartSearch.option.validation.fast" },
    { value: "balanced", labelKey: "smartSearch.option.validation.balanced" },
    { value: "strict", labelKey: "smartSearch.option.validation.strict" },
  ],
  SMART_SEARCH_FALLBACK_MODE: [
    { value: "auto", labelKey: "smartSearch.option.fallback.auto" },
    { value: "off", labelKey: "smartSearch.option.fallback.off" },
  ],
  SMART_SEARCH_MINIMUM_PROFILE: [
    { value: "standard", labelKey: "smartSearch.option.profile.standard" },
    { value: "off", labelKey: "smartSearch.option.profile.off" },
  ],
  SMART_SEARCH_INTENT_ROUTER: [
    { value: "hybrid", labelKey: "smartSearch.option.router.hybrid" },
    { value: "rules", labelKey: "smartSearch.option.router.rules" },
    { value: "off", labelKey: "smartSearch.option.router.off" },
  ],
};

function configEditorKind(key: string): ConfigEditorKind {
  if (isSmartSearchSecretKey(key)) return "secret";
  if (BOOLEAN_CONFIG_KEYS.has(key)) return "boolean";
  if (NUMBER_CONFIG_KEYS.has(key)) return "number";
  if (Object.hasOwn(ENUM_OPTIONS, key)) return "enum";
  return "text";
}

function groupFor(key: string): string {
  return `smartSearch.group.${configGroupForKey(key)?.id ?? "custom"}`;
}

function editorFor(key: string, kind: ConfigEditorKind): SettingDefinition["editor"] {
  switch (kind) {
    case "secret":
      return { kind: "secret", writeOnly: true };
    case "enum":
      return { kind: "enum", options: ENUM_OPTIONS[key] };
    case "number":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    default:
      return { kind: "text" };
  }
}

const DEFINITIONS: readonly SettingDefinition[] = [
  ...ALL_CONFIG_KEYS.map((key, index): SettingDefinition => {
    const kind = configEditorKind(key);
    return {
      key,
      group: groupFor(key),
      order: index,
      labelKey: `smartSearch.key.${key}`,
      scopes: ["global"],
      merge: "provider-defined",
      activation: "next-invocation",
      sensitivity: kind === "secret" ? "secret" : "public",
      reversibility: "full",
      editor: editorFor(key, kind),
    };
  }),
  {
    key: OVERVIEW_KEY,
    group: "smartSearch.group.overview",
    order: 100,
    labelKey: "smartSearch.sync",
    descriptionKey: "smartSearch.sync.description",
    scopes: ["global"],
    merge: "provider-defined",
    activation: "live",
    sensitivity: "private",
    reversibility: "none",
    editor: { kind: "overview" },
  },
  {
    key: ACTION_KEY,
    group: "smartSearch.group.manage",
    order: 101,
    labelKey: "smartSearch.action.pushSync",
    descriptionKey: "smartSearch.action.pushSync.description",
    scopes: ["global"],
    merge: "provider-defined",
    activation: "live",
    sensitivity: "private",
    reversibility: "none",
    editor: { kind: "action", actionId: ACTION_KEY },
  },
];

const DEFINITION_BY_KEY: ReadonlyMap<string, SettingDefinition> = new Map(
  DEFINITIONS.map((definition) => [definition.key, definition]),
);

const EN_CATALOG = {
  "smartSearch.provider": "Smart Search",
  "smartSearch.provider.description": "Search provider credentials, routing, retry policy and web-search.json sync",
  "smartSearch.group.xai": "xAI Responses",
  "smartSearch.group.openai-compatible": "OpenAI Compatible",
  "smartSearch.group.search-policy": "Search Policy",
  "smartSearch.group.intent-router": "Intent Router",
  "smartSearch.group.exa": "Exa",
  "smartSearch.group.context7": "Context7",
  "smartSearch.group.zhipu": "Zhipu Web Search",
  "smartSearch.group.zhipu-mcp": "Zhipu Coding Plan MCP",
  "smartSearch.group.jina": "Jina Reader",
  "smartSearch.group.tavily": "Tavily",
  "smartSearch.group.firecrawl": "Firecrawl",
  "smartSearch.group.anysearch": "AnySearch",
  "smartSearch.group.runtime": "Runtime",
  "smartSearch.group.wa-perplexity": "Perplexity (native)",
  "smartSearch.group.wa-openai": "OpenAI Search (native)",
  "smartSearch.group.wa-brave": "Brave Search (native)",
  "smartSearch.group.wa-parallel": "Parallel AI (native)",
  "smartSearch.group.wa-serpdive": "SERPdive (native)",
  "smartSearch.group.wa-searxng": "SearXNG (native)",
  "smartSearch.group.wa-gemini": "Gemini Platform",
  "smartSearch.group.wa-ssrf": "SSRF Protection",
  "smartSearch.group.wa-workflow": "Curator & Workflow",
  "smartSearch.group.wa-video": "Video Analysis",
  "smartSearch.group.overview": "Sync overview",
  "smartSearch.group.manage": "Smart Search management",
  "smartSearch.group.custom": "Custom",
  "smartSearch.sync": "web-search.json sync",
  "smartSearch.sync.description": "Per-key sync state between the Smart Search config and web-search.json",
  "smartSearch.action.pushSync": "Push to web-search.json",
  "smartSearch.action.pushSync.description": "Writes every mapped Smart Search value into web-search.json",
  "smartSearch.action.pushSync.done": "Pushed Smart Search → web-search.json",
  "smartSearch.key.XAI_API_URL": "xAI API URL",
  "smartSearch.key.XAI_API_KEY": "xAI API key",
  "smartSearch.key.XAI_MODEL": "xAI model",
  "smartSearch.key.XAI_TOOLS": "xAI tools",
  "smartSearch.key.OPENAI_COMPATIBLE_API_URL": "OpenAI-compatible API URL",
  "smartSearch.key.OPENAI_COMPATIBLE_API_KEY": "OpenAI-compatible API key",
  "smartSearch.key.OPENAI_COMPATIBLE_MODEL": "OpenAI-compatible model",
  "smartSearch.key.OPENAI_COMPATIBLE_FALLBACK_MODELS": "OpenAI-compatible fallback models",
  "smartSearch.key.OPENAI_COMPATIBLE_STREAM": "Stream OpenAI-compatible responses",
  "smartSearch.key.SMART_SEARCH_VALIDATION_LEVEL": "Validation level",
  "smartSearch.key.SMART_SEARCH_FALLBACK_MODE": "Fallback mode",
  "smartSearch.key.SMART_SEARCH_MINIMUM_PROFILE": "Minimum profile",
  "smartSearch.key.SMART_SEARCH_RESEARCH_PREFERRED_PROVIDERS": "Preferred research providers",
  "smartSearch.key.SMART_SEARCH_RESEARCH_DISABLED_PROVIDERS": "Disabled research providers",
  "smartSearch.key.SMART_SEARCH_INTENT_ROUTER": "Intent router mode",
  "smartSearch.key.INTENT_EMBEDDING_API_URL": "Embedding API URL",
  "smartSearch.key.INTENT_EMBEDDING_API_KEY": "Embedding API key",
  "smartSearch.key.INTENT_EMBEDDING_MODEL": "Embedding model",
  "smartSearch.key.INTENT_EMBEDDING_THRESHOLD": "Embedding similarity threshold",
  "smartSearch.key.INTENT_EMBEDDING_MARGIN": "Embedding decision margin",
  "smartSearch.key.INTENT_CLASSIFIER_API_URL": "Classifier API URL",
  "smartSearch.key.INTENT_CLASSIFIER_API_KEY": "Classifier API key",
  "smartSearch.key.INTENT_CLASSIFIER_MODEL": "Classifier model",
  "smartSearch.key.INTENT_ROUTER_TIMEOUT_SECONDS": "Router timeout (seconds)",
  "smartSearch.key.EXA_API_KEY": "Exa API key",
  "smartSearch.key.EXA_BASE_URL": "Exa base URL",
  "smartSearch.key.EXA_TIMEOUT_SECONDS": "Exa timeout (seconds)",
  "smartSearch.key.CONTEXT7_API_KEY": "Context7 API key",
  "smartSearch.key.CONTEXT7_BASE_URL": "Context7 base URL",
  "smartSearch.key.CONTEXT7_TIMEOUT_SECONDS": "Context7 timeout (seconds)",
  "smartSearch.key.ZHIPU_API_KEY": "Zhipu API key",
  "smartSearch.key.ZHIPU_API_URL": "Zhipu API URL",
  "smartSearch.key.ZHIPU_SEARCH_ENGINE": "Zhipu search engine",
  "smartSearch.key.ZHIPU_TIMEOUT_SECONDS": "Zhipu timeout (seconds)",
  "smartSearch.key.ZHIPU_MCP_API_KEY": "Zhipu MCP API key",
  "smartSearch.key.ZHIPU_MCP_SEARCH_API_URL": "Zhipu MCP search URL",
  "smartSearch.key.ZHIPU_MCP_READER_API_URL": "Zhipu MCP reader URL",
  "smartSearch.key.ZHIPU_MCP_ZREAD_API_URL": "Zhipu MCP zread URL",
  "smartSearch.key.ZHIPU_MCP_TIMEOUT_SECONDS": "Zhipu MCP timeout (seconds)",
  "smartSearch.key.JINA_API_KEY": "Jina API key",
  "smartSearch.key.JINA_READER_API_URL": "Jina reader URL",
  "smartSearch.key.JINA_RESPOND_WITH": "Jina response format",
  "smartSearch.key.JINA_TIMEOUT_SECONDS": "Jina timeout (seconds)",
  "smartSearch.key.TAVILY_API_KEY": "Tavily API key",
  "smartSearch.key.TAVILY_API_URL": "Tavily API URL",
  "smartSearch.key.TAVILY_ENABLED": "Tavily enabled",
  "smartSearch.key.TAVILY_TIMEOUT_SECONDS": "Tavily timeout (seconds)",
  "smartSearch.key.FIRECRAWL_API_KEY": "Firecrawl API key",
  "smartSearch.key.FIRECRAWL_API_URL": "Firecrawl API URL",
  "smartSearch.key.ANYSEARCH_API_KEY": "AnySearch API key",
  "smartSearch.key.ANYSEARCH_API_URL": "AnySearch API URL",
  "smartSearch.key.ANYSEARCH_TIMEOUT_SECONDS": "AnySearch timeout (seconds)",
  "smartSearch.key.SMART_SEARCH_DEBUG": "Debug mode",
  "smartSearch.key.SMART_SEARCH_LOG_LEVEL": "Log level",
  "smartSearch.key.SMART_SEARCH_LOG_DIR": "Log directory",
  "smartSearch.key.SMART_SEARCH_RETRY_MAX_ATTEMPTS": "Retry max attempts",
  "smartSearch.key.SMART_SEARCH_RETRY_MULTIPLIER": "Retry backoff multiplier",
  "smartSearch.key.SMART_SEARCH_RETRY_MAX_WAIT": "Retry max wait (seconds)",
  "smartSearch.key.SMART_SEARCH_OUTPUT_CLEANUP": "Clean up tool output",
  "smartSearch.key.SMART_SEARCH_LOG_TO_FILE": "Log to file",
  "smartSearch.key.SSL_VERIFY": "Verify TLS certificates",
  "smartSearch.option.validation.fast": "Fast",
  "smartSearch.option.validation.balanced": "Balanced",
  "smartSearch.option.validation.strict": "Strict",
  "smartSearch.option.fallback.auto": "Auto",
  "smartSearch.option.fallback.off": "Off",
  "smartSearch.option.profile.standard": "Standard",
  "smartSearch.option.profile.off": "Off",
  "smartSearch.option.router.hybrid": "Hybrid",
  "smartSearch.option.router.rules": "Rules",
  "smartSearch.option.router.off": "Off",
  "smartSearch.sync.synced": "✓ synced",
  "smartSearch.sync.conflict": "⚠ conflict",
  "smartSearch.sync.smartOnly": "→ smart-only",
  "smartSearch.sync.webOnly": "← web-only",
  "smartSearch.sync.unmapped": "— unmapped",
  "smartSearch.settings.unknownKey": "Unknown Smart Search setting",
  "smartSearch.settings.invalidScope": "Smart Search settings support only the global scope",
  "smartSearch.settings.invalidValue": "Invalid Smart Search setting value",
  "smartSearch.settings.readOnly": "Smart Search sync and actions cannot be committed as draft values",
} as const;

type CatalogKey = keyof typeof EN_CATALOG;

const ZH_CATALOG: Record<CatalogKey, string> = {
  "smartSearch.provider": "Smart Search",
  "smartSearch.provider.description": "管理搜索 Provider 凭据、路由、重试策略与 web-search.json 同步",
  "smartSearch.group.xai": "xAI Responses",
  "smartSearch.group.openai-compatible": "OpenAI Compatible",
  "smartSearch.group.search-policy": "搜索策略",
  "smartSearch.group.intent-router": "意图路由",
  "smartSearch.group.exa": "Exa",
  "smartSearch.group.context7": "Context7",
  "smartSearch.group.zhipu": "智谱网络搜索",
  "smartSearch.group.zhipu-mcp": "智谱 Coding Plan MCP",
  "smartSearch.group.jina": "Jina Reader",
  "smartSearch.group.tavily": "Tavily",
  "smartSearch.group.firecrawl": "Firecrawl",
  "smartSearch.group.anysearch": "AnySearch",
  "smartSearch.group.runtime": "运行环境",
  "smartSearch.group.wa-perplexity": "Perplexity（原生）",
  "smartSearch.group.wa-openai": "OpenAI 搜索（原生）",
  "smartSearch.group.wa-brave": "Brave 搜索（原生）",
  "smartSearch.group.wa-parallel": "Parallel AI（原生）",
  "smartSearch.group.wa-serpdive": "SERPdive（原生）",
  "smartSearch.group.wa-searxng": "SearXNG（原生）",
  "smartSearch.group.wa-gemini": "Gemini 平台",
  "smartSearch.group.wa-ssrf": "SSRF 防护",
  "smartSearch.group.wa-workflow": "Curator 与工作流",
  "smartSearch.group.wa-video": "视频分析",
  "smartSearch.group.overview": "同步概览",
  "smartSearch.group.manage": "Smart Search 管理",
  "smartSearch.group.custom": "自定义",
  "smartSearch.sync": "web-search.json 同步",
  "smartSearch.sync.description": "Smart Search 配置与 web-search.json 之间每个键的同步状态",
  "smartSearch.action.pushSync": "推送到 web-search.json",
  "smartSearch.action.pushSync.description": "把每个已映射的 Smart Search 值写入 web-search.json",
  "smartSearch.action.pushSync.done": "已推送 Smart Search → web-search.json",
  "smartSearch.key.XAI_API_URL": "xAI API URL",
  "smartSearch.key.XAI_API_KEY": "xAI API Key",
  "smartSearch.key.XAI_MODEL": "xAI 模型",
  "smartSearch.key.XAI_TOOLS": "xAI 工具",
  "smartSearch.key.OPENAI_COMPATIBLE_API_URL": "OpenAI 兼容 API URL",
  "smartSearch.key.OPENAI_COMPATIBLE_API_KEY": "OpenAI 兼容 API Key",
  "smartSearch.key.OPENAI_COMPATIBLE_MODEL": "OpenAI 兼容模型",
  "smartSearch.key.OPENAI_COMPATIBLE_FALLBACK_MODELS": "OpenAI 兼容回退模型",
  "smartSearch.key.OPENAI_COMPATIBLE_STREAM": "流式响应 OpenAI 兼容请求",
  "smartSearch.key.SMART_SEARCH_VALIDATION_LEVEL": "校验级别",
  "smartSearch.key.SMART_SEARCH_FALLBACK_MODE": "回退模式",
  "smartSearch.key.SMART_SEARCH_MINIMUM_PROFILE": "最低配置档位",
  "smartSearch.key.SMART_SEARCH_RESEARCH_PREFERRED_PROVIDERS": "首选研究提供商",
  "smartSearch.key.SMART_SEARCH_RESEARCH_DISABLED_PROVIDERS": "禁用的研究提供商",
  "smartSearch.key.SMART_SEARCH_INTENT_ROUTER": "意图路由模式",
  "smartSearch.key.INTENT_EMBEDDING_API_URL": "Embedding API URL",
  "smartSearch.key.INTENT_EMBEDDING_API_KEY": "Embedding API Key",
  "smartSearch.key.INTENT_EMBEDDING_MODEL": "Embedding 模型",
  "smartSearch.key.INTENT_EMBEDDING_THRESHOLD": "Embedding 相似度阈值",
  "smartSearch.key.INTENT_EMBEDDING_MARGIN": "Embedding 判定边距",
  "smartSearch.key.INTENT_CLASSIFIER_API_URL": "分类器 API URL",
  "smartSearch.key.INTENT_CLASSIFIER_API_KEY": "分类器 API Key",
  "smartSearch.key.INTENT_CLASSIFIER_MODEL": "分类器模型",
  "smartSearch.key.INTENT_ROUTER_TIMEOUT_SECONDS": "路由超时（秒）",
  "smartSearch.key.EXA_API_KEY": "Exa API Key",
  "smartSearch.key.EXA_BASE_URL": "Exa Base URL",
  "smartSearch.key.EXA_TIMEOUT_SECONDS": "Exa 超时（秒）",
  "smartSearch.key.CONTEXT7_API_KEY": "Context7 API Key",
  "smartSearch.key.CONTEXT7_BASE_URL": "Context7 Base URL",
  "smartSearch.key.CONTEXT7_TIMEOUT_SECONDS": "Context7 超时（秒）",
  "smartSearch.key.ZHIPU_API_KEY": "智谱 API Key",
  "smartSearch.key.ZHIPU_API_URL": "智谱 API URL",
  "smartSearch.key.ZHIPU_SEARCH_ENGINE": "智谱搜索引擎",
  "smartSearch.key.ZHIPU_TIMEOUT_SECONDS": "智谱超时（秒）",
  "smartSearch.key.ZHIPU_MCP_API_KEY": "智谱 MCP API Key",
  "smartSearch.key.ZHIPU_MCP_SEARCH_API_URL": "智谱 MCP 搜索 URL",
  "smartSearch.key.ZHIPU_MCP_READER_API_URL": "智谱 MCP 阅读器 URL",
  "smartSearch.key.ZHIPU_MCP_ZREAD_API_URL": "智谱 MCP zread URL",
  "smartSearch.key.ZHIPU_MCP_TIMEOUT_SECONDS": "智谱 MCP 超时（秒）",
  "smartSearch.key.JINA_API_KEY": "Jina API Key",
  "smartSearch.key.JINA_READER_API_URL": "Jina Reader URL",
  "smartSearch.key.JINA_RESPOND_WITH": "Jina 响应格式",
  "smartSearch.key.JINA_TIMEOUT_SECONDS": "Jina 超时（秒）",
  "smartSearch.key.TAVILY_API_KEY": "Tavily API Key",
  "smartSearch.key.TAVILY_API_URL": "Tavily API URL",
  "smartSearch.key.TAVILY_ENABLED": "启用 Tavily",
  "smartSearch.key.TAVILY_TIMEOUT_SECONDS": "Tavily 超时（秒）",
  "smartSearch.key.FIRECRAWL_API_KEY": "Firecrawl API Key",
  "smartSearch.key.FIRECRAWL_API_URL": "Firecrawl API URL",
  "smartSearch.key.ANYSEARCH_API_KEY": "AnySearch API Key",
  "smartSearch.key.ANYSEARCH_API_URL": "AnySearch API URL",
  "smartSearch.key.ANYSEARCH_TIMEOUT_SECONDS": "AnySearch 超时（秒）",
  "smartSearch.key.SMART_SEARCH_DEBUG": "调试模式",
  "smartSearch.key.SMART_SEARCH_LOG_LEVEL": "日志级别",
  "smartSearch.key.SMART_SEARCH_LOG_DIR": "日志目录",
  "smartSearch.key.SMART_SEARCH_RETRY_MAX_ATTEMPTS": "最大重试次数",
  "smartSearch.key.SMART_SEARCH_RETRY_MULTIPLIER": "重试退避乘数",
  "smartSearch.key.SMART_SEARCH_RETRY_MAX_WAIT": "重试最大等待（秒）",
  "smartSearch.key.SMART_SEARCH_OUTPUT_CLEANUP": "清理工具输出",
  "smartSearch.key.SMART_SEARCH_LOG_TO_FILE": "写入日志文件",
  "smartSearch.key.SSL_VERIFY": "校验 TLS 证书",
  "smartSearch.option.validation.fast": "快速",
  "smartSearch.option.validation.balanced": "均衡",
  "smartSearch.option.validation.strict": "严格",
  "smartSearch.option.fallback.auto": "自动",
  "smartSearch.option.fallback.off": "关闭",
  "smartSearch.option.profile.standard": "标准",
  "smartSearch.option.profile.off": "关闭",
  "smartSearch.option.router.hybrid": "混合",
  "smartSearch.option.router.rules": "规则",
  "smartSearch.option.router.off": "关闭",
  "smartSearch.sync.synced": "✓ 已同步",
  "smartSearch.sync.conflict": "⚠ 冲突",
  "smartSearch.sync.smartOnly": "→ 仅 Smart Search",
  "smartSearch.sync.webOnly": "← 仅 web-search",
  "smartSearch.sync.unmapped": "— 未映射",
  "smartSearch.settings.unknownKey": "未知的 Smart Search 设置",
  "smartSearch.settings.invalidScope": "Smart Search 设置仅支持全局作用域",
  "smartSearch.settings.invalidValue": "Smart Search 设置值无效",
  "smartSearch.settings.readOnly": "Smart Search 同步与操作项不能作为草稿值提交",
};

const CATALOGS = buildCatalogs();

/** Human-readable label for a config key (e.g. PERPLEXITY_API_KEY → Perplexity API key). */
function humanizeKey(key: string): string {
  return key
    .split("_")
    .map((part) => {
      const upper = part.toUpperCase();
      return ["API", "URL", "MCP", "SSRF", "SSL", "HTTP", "TLS", "LLM", "AI", "DB"].includes(upper)
        ? upper
        : `${part.charAt(0)}${part.slice(1).toLowerCase()}`;
    })
    .join(" ");
}

/** Explicit catalogs + auto-generated labels for every configured key. */
function buildCatalogs(): Record<string, Record<string, string>> {
  const merge = (base: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = { ...base };
    for (const key of ALL_CONFIG_KEYS) {
      const labelKey = `smartSearch.key.${key}`;
      if (!out[labelKey]) out[labelKey] = humanizeKey(key);
    }
    return out;
  };
  return { en: merge(EN_CATALOG), "zh-CN": merge(ZH_CATALOG) };
}

// ---------------------------------------------------------------------------
// web-search.json sync — mirrors the TUI's WebAccessConfigSync so the settings
// provider stays free of the TUI renderer dependency.
// ---------------------------------------------------------------------------

export type SmartSearchSyncStatus = "synced" | "conflict" | "smart-only" | "web-only" | "unmapped";

const SYNC_STATUS_VALUE_KEY: Record<SmartSearchSyncStatus, CatalogKey> = {
  synced: "smartSearch.sync.synced",
  conflict: "smartSearch.sync.conflict",
  "smart-only": "smartSearch.sync.smartOnly",
  "web-only": "smartSearch.sync.webOnly",
  unmapped: "smartSearch.sync.unmapped",
};

const SYNC_STATUS_TONE: Record<SmartSearchSyncStatus, SettingsOverviewStatus> = {
  synced: "ok",
  conflict: "warn",
  "smart-only": "dim",
  "web-only": "dim",
  unmapped: "dim",
};

function resolveWebSearchJsonPath(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  const base = envDir
    ?? (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "pi") : join(homedir(), ".pi"));
  return join(base, "web-search.json");
}

function getNestedValue(obj: Record<string, unknown>, dottedPath: string): unknown {
  const parts = dottedPath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, dottedPath: string, value: unknown): void {
  const parts = dottedPath.split(".");
  let current = obj;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (current[part] === null || current[part] === undefined || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

class WebSearchConfigSync {
  private webConfig: Record<string, unknown> | undefined;

  constructor(private readonly webSearchJsonPath: string) {}

  loadWebConfig(): Record<string, unknown> {
    if (this.webConfig) return this.webConfig;
    try {
      if (!existsSync(this.webSearchJsonPath)) {
        this.webConfig = {};
        return this.webConfig;
      }
      const parsed: unknown = JSON.parse(readFileSync(this.webSearchJsonPath, "utf8"));
      this.webConfig = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      this.webConfig = {};
    }
    return this.webConfig;
  }

  statusFor(smartSearchConfig: SmartSearchConfig, key: string): SmartSearchSyncStatus {
    const mapping = syncMappingForSmartSearchKey(key);
    if (!mapping) return "unmapped";
    const webValue = getNestedValue(this.loadWebConfig(), mapping.webSearchJsonKey);
    const smartValue = smartSearchConfig[key];
    const smartEmpty = isEmptyValue(smartValue);
    const webEmpty = isEmptyValue(webValue);
    if (smartEmpty && webEmpty) return "synced";
    if (smartEmpty && !webEmpty) return "web-only";
    if (!smartEmpty && webEmpty) return "smart-only";
    return String(smartValue) === String(webValue) ? "synced" : "conflict";
  }

  push(smartSearchConfig: SmartSearchConfig): void {
    const web = { ...this.loadWebConfig() };
    for (const mapping of WEB_ACCESS_SYNC_MAPPINGS) {
      const value = smartSearchConfig[mapping.smartSearchKey];
      if (value !== undefined && value !== null && value !== "") {
        setNestedValue(web, mapping.webSearchJsonKey, value);
      }
    }
    const dir = dirname(this.webSearchJsonPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const temporaryPath = join(dir, `.web-search.json.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(web, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporaryPath, this.webSearchJsonPath);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // best-effort temp cleanup
      }
      throw error;
    }
    this.webConfig = web;
    invalidateWebConfigCaches();
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function createSmartSearchSettingsProvider(
  options: SmartSearchSettingsProviderOptions = {},
): SmartSearchSettingsProvider {
  const instanceId = randomUUID();
  const getConfigPath = options.getConfigPath ?? (() => resolveSmartSearchConfigPath().configFile);
  const getWebConfigPath = options.getWebConfigPath ?? resolveWebSearchJsonPath;
  const store = new SmartSearchConfigStore({ configFile: getConfigPath() });
  const originals = new Map<string, string>();
  const preparedChanges = new Map<string, readonly SettingsChange[]>();

  const load = async (): Promise<{ config: SmartSearchConfig; content: string }> => {
    const config = await store.load();
    let content = "";
    try {
      content = await readFile(getConfigPath(), "utf8");
    } catch {
      content = "";
    }
    return { config, content };
  };

  const snapshotFor = (
    config: SmartSearchConfig,
    sync: WebSearchConfigSync,
    locale: SupportedSettingsLocale,
  ): SettingsSnapshot => {
    const configured: ConfiguredSettingValue[] = [];
    const effective: EffectiveSettingValue[] = [];
    for (const definition of DEFINITIONS) {
      if (definition.key === OVERVIEW_KEY) {
        configured.push({ key: definition.key, scope: "global", state: "absent" });
        effective.push({
          key: definition.key,
          value: syncOverviewRows(locale, config, sync) as unknown as JsonValue,
          source: "runtime",
        });
        continue;
      }
      if (definition.key === ACTION_KEY) {
        configured.push({ key: definition.key, scope: "global", state: "absent" });
        effective.push({ key: definition.key, value: "open", source: "runtime" });
        continue;
      }
      const raw = config[definition.key];
      const secret = configEditorKind(definition.key) === "secret";
      const present = !isEmptyValue(raw);
      const value = present && secret ? SETTINGS_SECRET_SET_PLACEHOLDER : raw;
      configured.push({
        key: definition.key,
        scope: "global",
        state: present ? "set" : "absent",
        ...(present ? { value: value as JsonValue } : {}),
      });
      effective.push({
        key: definition.key,
        value: present ? value as JsonValue : null,
        source: present ? "configured" : "default",
      });
    }
    return {
      providerId: PROVIDER_ID,
      providerInstanceId: instanceId,
      configured: { values: configured, resources: [] },
      effective: { values: effective },
    };
  };

  const validateChanges = (changes: readonly SettingsChange[]): { valid: boolean; issues: SettingsValidationIssue[] } => {
    const issues: SettingsValidationIssue[] = [];
    for (const change of changes) {
      const definition = DEFINITION_BY_KEY.get(change.key);
      if (!definition) {
        issues.push({
          severity: "error",
          key: change.key,
          scope: change.scope,
          code: "unknown-key",
          messageKey: "smartSearch.settings.unknownKey",
        });
        continue;
      }
      if (definition.key === OVERVIEW_KEY || definition.key === ACTION_KEY) {
        issues.push({
          severity: "error",
          key: change.key,
          scope: change.scope,
          code: "read-only",
          messageKey: "smartSearch.settings.readOnly",
        });
        continue;
      }
      if (change.scope !== "global") {
        issues.push({
          severity: "error",
          key: change.key,
          scope: change.scope,
          code: "invalid-scope",
          messageKey: "smartSearch.settings.invalidScope",
        });
        continue;
      }
      if (change.operation === "set" && !isValidValue(change.key, change.value)) {
        issues.push({
          severity: "error",
          key: change.key,
          scope: change.scope,
          code: "invalid-value",
          messageKey: "smartSearch.settings.invalidValue",
        });
      }
    }
    return { valid: issues.length === 0, issues };
  };

  const revisionFor = (content: string): SettingsResourceRevision => ({
    resource: { providerId: PROVIDER_ID, scope: "global", id: getConfigPath() },
    etag: createHash("sha256").update(content || "<missing>").digest("hex"),
  });

  return {
    providerId: PROVIDER_ID,
    instanceId,
    describe: () => ({
      id: PROVIDER_ID,
      version: PROVIDER_VERSION,
      instanceId,
      labelKey: "smartSearch.provider",
      descriptionKey: "smartSearch.provider.description",
      order: 20,
      capabilities: { read: true, write: true, prepareCommit: true, rollback: "compensating", hotUpdate: true },
      settings: DEFINITIONS,
      catalogs: CATALOGS,
    }),
    read: async (request) => {
      const config = await store.load();
      return snapshotFor(config, new WebSearchConfigSync(getWebConfigPath()), request.context.locale);
    },
    validate: (request) => {
      const result = validateChanges(request.changes);
      return { ...result, conflicts: [] };
    },
    prepare: async (request) => {
      const validation = validateChanges(request.changes);
      if (!validation.valid) return { prepared: false, validation, conflicts: [] };
      const data = await load();
      originals.set(request.transactionId, data.content);
      preparedChanges.set(request.transactionId, request.changes);
      const changedKeys = request.changes.map((change) => change.key);
      return {
        prepared: true,
        prepareToken: request.transactionId,
        validation: { valid: true, issues: [], conflicts: [] },
        activation: [{ boundary: "next-invocation", keys: changedKeys }],
      };
    },
    commit: async (request) => {
      const changes = preparedChanges.get(request.transactionId) ?? [];
      const data = await load();
      const patch: Record<string, unknown | undefined> = {};
      for (const change of changes) {
        if (change.operation === "unset") {
          patch[change.key] = undefined;
          continue;
        }
        if (configEditorKind(change.key) === "secret" && change.value === SETTINGS_SECRET_SET_PLACEHOLDER) {
          continue; // placeholder on a secret keeps the stored value untouched
        }
        patch[change.key] = change.value;
      }
      await store.save(patch);
      // Keep the original content until rollback (a later provider's commit
      // failure triggers compensating rollback) or applyRuntime consumes it.
      const config = await store.load();
      const sync = new WebSearchConfigSync(getWebConfigPath());
      const snapshot = snapshotFor(config, sync, request.context.locale);
      return {
        snapshot,
        revisions: [revisionFor(JSON.stringify(config))],
        changedKeys: changes.map((change) => change.key),
        activation: [{ boundary: "next-invocation", keys: changes.map((change) => change.key) }],
      };
    },
    abort: (request) => {
      originals.delete(request.transactionId);
      preparedChanges.delete(request.transactionId);
    },
    applyRuntime: (request) => {
      originals.delete(request.transactionId);
      preparedChanges.delete(request.transactionId);
      return {
        appliedKeys: [],
        deferred: [{ boundary: "next-invocation", keys: request.changes.map((change) => change.key) }],
        failed: [],
      };
    },
    rollback: async (request) => {
      const original = originals.get(request.transactionId);
      originals.delete(request.transactionId);
      preparedChanges.delete(request.transactionId);
      if (original === undefined) return { rolledBack: false };
      try {
        restoreConfigContent(getConfigPath(), original);
      } catch {
        return { rolledBack: false };
      }
      const config = await store.load();
      const snapshot = snapshotFor(config, new WebSearchConfigSync(getWebConfigPath()), request.context.locale);
      return { rolledBack: true, snapshot };
    },
    invokeAction: async (request) => {
      if (request.actionId === ACTION_KEY) {
        const config = await store.load();
        new WebSearchConfigSync(getWebConfigPath()).push(config);
        return { handled: true, refresh: true, messageKey: "smartSearch.action.pushSync.done" };
      }
      const handler = options.actions?.[request.actionId];
      if (!handler) return { handled: false };
      await handler(request.context);
      return { handled: true, refresh: false };
    },
  };
}

export function registerSmartSearchSettingsProvider(
  events: SettingsEventBus,
  provider: SmartSearchSettingsProvider,
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

function syncOverviewRows(
  locale: SupportedSettingsLocale,
  config: SmartSearchConfig,
  sync: WebSearchConfigSync,
): SettingsOverviewRow[] {
  const catalog = CATALOGS[locale] ?? CATALOGS.en;
  return SMART_SEARCH_CONFIG_KEYS.map((key) => {
    const status = sync.statusFor(config, key);
    return {
      labelKey: `smartSearch.key.${key}`,
      value: catalog[SYNC_STATUS_VALUE_KEY[status]],
      status: SYNC_STATUS_TONE[status],
    };
  });
}

function isValidValue(key: string, value: JsonValue): boolean {
  switch (configEditorKind(key)) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "secret":
      return typeof value === "string";
    case "enum":
      return typeof value === "string"
        && ENUM_OPTIONS[key]?.some((option) => option.value === value) === true;
    default:
      return typeof value === "string";
  }
}

function restoreConfigContent(configPath: string, content: string): void {
  if (content === "") {
    try {
      unlinkSync(configPath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    return;
  }
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true });
  const temporaryPath = join(dir, `.config.json.${process.pid}.${randomUUID()}.rollback`);
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, configPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // best-effort temp cleanup
    }
    throw error;
  }
}

function isErrno(value: unknown, code: string): value is NodeJS.ErrnoException {
  return typeof value === "object" && value !== null && (value as { code?: unknown }).code === code;
}
