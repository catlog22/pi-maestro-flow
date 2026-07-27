import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type SmartSearchConfig = Record<string, unknown>;
export type SmartSearchConfigPathSource = "environment" | "default" | "legacy_windows_home";

export interface SmartSearchConfigPath {
  configDir: string;
  configFile: string;
  source: SmartSearchConfigPathSource;
  defaultConfigFile: string;
  legacyConfigFile: string;
}

export interface SmartSearchConfigPathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  exists?: (path: string) => boolean;
}

export interface SmartSearchConfigStoreIO {
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  rename: typeof rename;
  unlink: typeof unlink;
}

export interface SmartSearchConfigStoreOptions extends SmartSearchConfigPathOptions {
  configFile?: string;
  io?: Partial<SmartSearchConfigStoreIO>;
  temporaryId?: () => string;
}

const DEFAULT_IO: SmartSearchConfigStoreIO = { mkdir, readFile, writeFile, rename, unlink };

export interface SmartSearchConfigGroup {
  id: string;
  label: string;
  capability: string;
  aliases: readonly string[];
  keys: readonly string[];
}

export const SMART_SEARCH_CONFIG_GROUPS = [
  {
    id: "xai",
    label: "xAI Responses",
    capability: "main_search",
    aliases: ["grok", "primary search"],
    keys: ["XAI_API_URL", "XAI_API_KEY", "XAI_MODEL", "XAI_TOOLS"],
  },
  {
    id: "openai-compatible",
    label: "OpenAI Compatible",
    capability: "main_search",
    aliases: ["openai", "relay", "primary search"],
    keys: ["OPENAI_COMPATIBLE_API_URL", "OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_MODEL", "OPENAI_COMPATIBLE_FALLBACK_MODELS", "OPENAI_COMPATIBLE_STREAM"],
  },
  {
    id: "search-policy",
    label: "Search Policy",
    capability: "routing",
    aliases: ["validation", "fallback", "research providers"],
    keys: ["SMART_SEARCH_VALIDATION_LEVEL", "SMART_SEARCH_FALLBACK_MODE", "SMART_SEARCH_MINIMUM_PROFILE", "SMART_SEARCH_RESEARCH_PREFERRED_PROVIDERS", "SMART_SEARCH_RESEARCH_DISABLED_PROVIDERS"],
  },
  {
    id: "intent-router",
    label: "Intent Router",
    capability: "routing",
    aliases: ["embedding", "classifier", "semantic route"],
    keys: ["SMART_SEARCH_INTENT_ROUTER", "INTENT_EMBEDDING_API_URL", "INTENT_EMBEDDING_API_KEY", "INTENT_EMBEDDING_MODEL", "INTENT_EMBEDDING_THRESHOLD", "INTENT_EMBEDDING_MARGIN", "INTENT_CLASSIFIER_API_URL", "INTENT_CLASSIFIER_API_KEY", "INTENT_CLASSIFIER_MODEL", "INTENT_ROUTER_TIMEOUT_SECONDS"],
  },
  {
    id: "exa",
    label: "Exa",
    capability: "docs_search",
    aliases: ["docs", "papers", "official sources"],
    keys: ["EXA_API_KEY", "EXA_BASE_URL", "EXA_TIMEOUT_SECONDS"],
  },
  {
    id: "context7",
    label: "Context7",
    capability: "docs_search",
    aliases: ["docs", "library", "api docs"],
    keys: ["CONTEXT7_API_KEY", "CONTEXT7_BASE_URL", "CONTEXT7_TIMEOUT_SECONDS"],
  },
  {
    id: "zhipu",
    label: "Zhipu Web Search",
    capability: "web_search",
    aliases: ["智谱", "中文搜索", "current search"],
    keys: ["ZHIPU_API_KEY", "ZHIPU_API_URL", "ZHIPU_SEARCH_ENGINE", "ZHIPU_TIMEOUT_SECONDS"],
  },
  {
    id: "zhipu-mcp",
    label: "Zhipu Coding Plan MCP",
    capability: "web_search web_fetch repo_docs",
    aliases: ["智谱 MCP", "webReader", "zread"],
    keys: ["ZHIPU_MCP_API_KEY", "ZHIPU_MCP_SEARCH_API_URL", "ZHIPU_MCP_READER_API_URL", "ZHIPU_MCP_ZREAD_API_URL", "ZHIPU_MCP_TIMEOUT_SECONDS"],
  },
  {
    id: "jina",
    label: "Jina Reader",
    capability: "web_fetch",
    aliases: ["reader", "page extraction"],
    keys: ["JINA_API_KEY", "JINA_READER_API_URL", "JINA_RESPOND_WITH", "JINA_TIMEOUT_SECONDS"],
  },
  {
    id: "tavily",
    label: "Tavily",
    capability: "web_fetch web_search",
    aliases: ["fetch", "discovery"],
    keys: ["TAVILY_API_KEY", "TAVILY_API_URL", "TAVILY_ENABLED", "TAVILY_TIMEOUT_SECONDS"],
  },
  {
    id: "firecrawl",
    label: "Firecrawl",
    capability: "web_fetch web_search",
    aliases: ["crawl", "fetch"],
    keys: ["FIRECRAWL_API_KEY", "FIRECRAWL_API_URL"],
  },
  {
    id: "anysearch",
    label: "AnySearch",
    capability: "vertical_search",
    aliases: ["vertical", "experimental"],
    keys: ["ANYSEARCH_API_KEY", "ANYSEARCH_API_URL", "ANYSEARCH_TIMEOUT_SECONDS"],
  },
  {
    id: "runtime",
    label: "Runtime",
    capability: "runtime",
    aliases: ["debug", "logging", "retry", "ssl"],
    keys: ["SMART_SEARCH_DEBUG", "SMART_SEARCH_LOG_LEVEL", "SMART_SEARCH_LOG_DIR", "SMART_SEARCH_RETRY_MAX_ATTEMPTS", "SMART_SEARCH_RETRY_MULTIPLIER", "SMART_SEARCH_RETRY_MAX_WAIT", "SMART_SEARCH_OUTPUT_CLEANUP", "SMART_SEARCH_LOG_TO_FILE", "SSL_VERIFY"],
  },
] as const satisfies readonly SmartSearchConfigGroup[];

export const SMART_SEARCH_CONFIG_KEYS: readonly string[] = SMART_SEARCH_CONFIG_GROUPS.flatMap((group) => group.keys);

const SMART_SEARCH_CONFIG_GROUP_BY_KEY: ReadonlyMap<string, SmartSearchConfigGroup> = new Map<string, SmartSearchConfigGroup>(
  SMART_SEARCH_CONFIG_GROUPS.flatMap((group) => group.keys.map((key) => [key, group] as const)),
);

export function smartSearchConfigGroupForKey(key: string): SmartSearchConfigGroup | undefined {
  return SMART_SEARCH_CONFIG_GROUP_BY_KEY.get(key);
}

// ---------------------------------------------------------------------------
// pi-web-access native provider config groups
// ---------------------------------------------------------------------------

export const WEB_ACCESS_CONFIG_GROUPS = [
  {
    id: "wa-perplexity",
    label: "Perplexity (native)",
    capability: "web_search",
    aliases: ["pplx", "answer engine"],
    keys: ["PERPLEXITY_API_KEY"],
  },
  {
    id: "wa-openai",
    label: "OpenAI Search (native)",
    capability: "web_search",
    aliases: ["openai web", "codex search"],
    keys: ["OPENAI_API_KEY"],
  },
  {
    id: "wa-brave",
    label: "Brave Search (native)",
    capability: "web_search",
    aliases: ["brave"],
    keys: ["BRAVE_API_KEY"],
  },
  {
    id: "wa-parallel",
    label: "Parallel AI (native)",
    capability: "web_search web_fetch",
    aliases: ["parallel"],
    keys: ["PARALLEL_API_KEY"],
  },
  {
    id: "wa-serpdive",
    label: "SERPdive (native)",
    capability: "web_search",
    aliases: ["serpdive", "krill", "mako"],
    keys: ["SERPDIVE_API_KEY", "SERPDIVE_MODEL"],
  },
  {
    id: "wa-searxng",
    label: "SearXNG (native)",
    capability: "web_search",
    aliases: ["searxng", "self-hosted"],
    keys: ["SEARXNG_BASE_URL"],
  },
  {
    id: "wa-gemini",
    label: "Gemini Platform",
    capability: "web_search web_fetch",
    aliases: ["gemini", "google", "gemini web"],
    keys: ["GEMINI_API_KEY", "GEMINI_BASE_URL", "CLOUDFLARE_API_KEY", "GEMINI_WEB_MODEL", "ALLOW_BROWSER_COOKIES", "CHROME_PROFILE"],
  },
  {
    id: "wa-ssrf",
    label: "SSRF Protection",
    capability: "security",
    aliases: ["ssrf", "domain policy", "network safety"],
    keys: ["SSRF_ALLOW_RANGES", "SSRF_TRUST_ENV_PROXY", "FETCH_DOMAIN_ALLOW", "FETCH_DOMAIN_DENY"],
  },
  {
    id: "wa-workflow",
    label: "Curator & Workflow",
    capability: "workflow",
    aliases: ["curator", "summary", "websearch ui"],
    keys: ["WEB_SEARCH_PROVIDER", "WEB_SEARCH_WORKFLOW", "CURATOR_TIMEOUT_SECONDS", "SUMMARY_MODEL", "WEB_SEARCH_ENABLED"],
  },
  {
    id: "wa-video",
    label: "Video Analysis",
    capability: "media",
    aliases: ["video", "youtube", "ffmpeg"],
    keys: ["VIDEO_MAX_SIZE_MB", "VIDEO_ENABLED", "VIDEO_PREFERRED_MODEL", "YOUTUBE_ENABLED", "YOUTUBE_PREFERRED_MODEL"],
  },
] as const satisfies readonly SmartSearchConfigGroup[];

export const WEB_ACCESS_CONFIG_KEYS: readonly string[] = WEB_ACCESS_CONFIG_GROUPS.flatMap((group) => group.keys);

const WEB_ACCESS_CONFIG_GROUP_BY_KEY: ReadonlyMap<string, SmartSearchConfigGroup> = new Map<string, SmartSearchConfigGroup>(
  WEB_ACCESS_CONFIG_GROUPS.flatMap((group) => group.keys.map((key) => [key, group] as const)),
);

export function webAccessConfigGroupForKey(key: string): SmartSearchConfigGroup | undefined {
  return WEB_ACCESS_CONFIG_GROUP_BY_KEY.get(key);
}

// ---------------------------------------------------------------------------
// Combined view: Python CLI groups + native web-access groups
// ---------------------------------------------------------------------------

export const ALL_CONFIG_GROUPS: readonly SmartSearchConfigGroup[] = [...SMART_SEARCH_CONFIG_GROUPS, ...WEB_ACCESS_CONFIG_GROUPS];

export const ALL_CONFIG_KEYS: readonly string[] = [...SMART_SEARCH_CONFIG_KEYS, ...WEB_ACCESS_CONFIG_KEYS];

const ALL_CONFIG_GROUP_BY_KEY: ReadonlyMap<string, SmartSearchConfigGroup> = new Map<string, SmartSearchConfigGroup>(
  ALL_CONFIG_GROUPS.flatMap((group) => group.keys.map((key) => [key, group] as const)),
);

export function configGroupForKey(key: string): SmartSearchConfigGroup | undefined {
  return ALL_CONFIG_GROUP_BY_KEY.get(key);
}

// ---------------------------------------------------------------------------
// Config sync mapping: Smart Search key <-> web-search.json key
// ---------------------------------------------------------------------------

export interface WebAccessSyncMapping {
  readonly smartSearchKey: string;
  readonly webSearchJsonKey: string;
}

export const WEB_ACCESS_SYNC_MAPPINGS: readonly WebAccessSyncMapping[] = [
  { smartSearchKey: "PERPLEXITY_API_KEY", webSearchJsonKey: "perplexityApiKey" },
  { smartSearchKey: "OPENAI_API_KEY", webSearchJsonKey: "openaiApiKey" },
  { smartSearchKey: "BRAVE_API_KEY", webSearchJsonKey: "braveApiKey" },
  { smartSearchKey: "PARALLEL_API_KEY", webSearchJsonKey: "parallelApiKey" },
  { smartSearchKey: "TAVILY_API_KEY", webSearchJsonKey: "tavilyApiKey" },
  { smartSearchKey: "SERPDIVE_API_KEY", webSearchJsonKey: "serpdiveApiKey" },
  { smartSearchKey: "SERPDIVE_MODEL", webSearchJsonKey: "serpdiveModel" },
  { smartSearchKey: "EXA_API_KEY", webSearchJsonKey: "exaApiKey" },
  { smartSearchKey: "FIRECRAWL_API_KEY", webSearchJsonKey: "firecrawlApiKey" },
  { smartSearchKey: "FIRECRAWL_API_URL", webSearchJsonKey: "firecrawlBaseUrl" },
  { smartSearchKey: "ANYSEARCH_API_KEY", webSearchJsonKey: "anysearchApiKey" },
  { smartSearchKey: "SEARXNG_BASE_URL", webSearchJsonKey: "searxngBaseUrl" },
  { smartSearchKey: "GEMINI_API_KEY", webSearchJsonKey: "geminiApiKey" },
  { smartSearchKey: "GEMINI_BASE_URL", webSearchJsonKey: "geminiBaseUrl" },
  { smartSearchKey: "CLOUDFLARE_API_KEY", webSearchJsonKey: "cloudflareApiKey" },
  { smartSearchKey: "ALLOW_BROWSER_COOKIES", webSearchJsonKey: "allowBrowserCookies" },
  { smartSearchKey: "CHROME_PROFILE", webSearchJsonKey: "chromeProfile" },
  { smartSearchKey: "WEB_SEARCH_PROVIDER", webSearchJsonKey: "provider" },
  { smartSearchKey: "WEB_SEARCH_WORKFLOW", webSearchJsonKey: "workflow" },
  { smartSearchKey: "CURATOR_TIMEOUT_SECONDS", webSearchJsonKey: "curatorTimeoutSeconds" },
  { smartSearchKey: "SUMMARY_MODEL", webSearchJsonKey: "summaryModel" },
  { smartSearchKey: "WEB_SEARCH_ENABLED", webSearchJsonKey: "webSearch.enabled" },
  { smartSearchKey: "SSRF_ALLOW_RANGES", webSearchJsonKey: "ssrf.allowRanges" },
  { smartSearchKey: "SSRF_TRUST_ENV_PROXY", webSearchJsonKey: "ssrf.trustEnvProxy" },
  { smartSearchKey: "FETCH_DOMAIN_ALLOW", webSearchJsonKey: "fetchContent.domainPolicy.allow" },
  { smartSearchKey: "FETCH_DOMAIN_DENY", webSearchJsonKey: "fetchContent.domainPolicy.deny" },
  { smartSearchKey: "VIDEO_MAX_SIZE_MB", webSearchJsonKey: "video.maxSizeMB" },
  { smartSearchKey: "VIDEO_ENABLED", webSearchJsonKey: "video.enabled" },
  { smartSearchKey: "VIDEO_PREFERRED_MODEL", webSearchJsonKey: "video.preferredModel" },
  { smartSearchKey: "YOUTUBE_ENABLED", webSearchJsonKey: "youtube.enabled" },
  { smartSearchKey: "YOUTUBE_PREFERRED_MODEL", webSearchJsonKey: "youtube.preferredModel" },
];

const SYNC_BY_SMART_SEARCH_KEY: ReadonlyMap<string, WebAccessSyncMapping> = new Map(
  WEB_ACCESS_SYNC_MAPPINGS.map((m) => [m.smartSearchKey, m]),
);

const SYNC_BY_WEB_SEARCH_KEY: ReadonlyMap<string, WebAccessSyncMapping> = new Map(
  WEB_ACCESS_SYNC_MAPPINGS.map((m) => [m.webSearchJsonKey, m]),
);

export function syncMappingForSmartSearchKey(key: string): WebAccessSyncMapping | undefined {
  return SYNC_BY_SMART_SEARCH_KEY.get(key);
}

export function syncMappingForWebSearchKey(key: string): WebAccessSyncMapping | undefined {
  return SYNC_BY_WEB_SEARCH_KEY.get(key);
}

export function resolveSmartSearchConfigPath(options: SmartSearchConfigPathOptions = {}): SmartSearchConfigPath {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();
  const pathExists = options.exists ?? existsSync;
  const legacyConfigFile = join(home, ".config", "smart-search", "config.json");
  const defaultConfigDir = platform === "win32" && env.LOCALAPPDATA
    ? join(env.LOCALAPPDATA, "smart-search")
    : join(home, ".config", "smart-search");
  const defaultConfigFile = join(defaultConfigDir, "config.json");

  if (env.SMART_SEARCH_CONFIG_DIR) {
    const configDir = env.SMART_SEARCH_CONFIG_DIR;
    return {
      configDir,
      configFile: join(configDir, "config.json"),
      source: "environment",
      defaultConfigFile,
      legacyConfigFile,
    };
  }
  if (platform === "win32" && defaultConfigFile !== legacyConfigFile
    && !pathExists(defaultConfigFile) && pathExists(legacyConfigFile)) {
    return {
      configDir: dirname(legacyConfigFile),
      configFile: legacyConfigFile,
      source: "legacy_windows_home",
      defaultConfigFile,
      legacyConfigFile,
    };
  }
  return {
    configDir: defaultConfigDir,
    configFile: defaultConfigFile,
    source: "default",
    defaultConfigFile,
    legacyConfigFile,
  };
}

export function isSmartSearchSecretKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return normalized.includes("KEY") || normalized.includes("TOKEN") || normalized.includes("SECRET");
}

export function maskSmartSearchSecret(value: string): string {
  if (!value || value.length <= 8) return "***";
  return `${value.slice(0, 4)}${"*".repeat(value.length - 8)}${value.slice(-4)}`;
}

export function displaySmartSearchConfigValue(key: string, value: unknown): string {
  if (value === undefined || value === null || value === "") return "Not configured";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return isSmartSearchSecretKey(key) ? maskSmartSearchSecret(text) : text;
}

export class SmartSearchConfigStore {
  readonly path: SmartSearchConfigPath;
  private readonly io: SmartSearchConfigStoreIO;
  private readonly temporaryId: () => string;

  constructor(options: SmartSearchConfigStoreOptions = {}) {
    const resolved = resolveSmartSearchConfigPath(options);
    this.path = options.configFile
      ? { ...resolved, configDir: dirname(options.configFile), configFile: options.configFile }
      : resolved;
    this.io = { ...DEFAULT_IO, ...options.io };
    this.temporaryId = options.temporaryId ?? randomUUID;
  }

  async load(): Promise<SmartSearchConfig> {
    try {
      const text = await this.io.readFile(this.path.configFile, "utf8");
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) throw new Error("config root must be a JSON object");
      return parsed;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return {};
      throw new Error(`Unable to read Smart Search config: ${errorMessage(error)}`, { cause: error });
    }
  }

  async save(patch: Record<string, unknown | undefined>): Promise<SmartSearchConfig> {
    const current = await this.load();
    const next: SmartSearchConfig = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    await this.atomicWrite(next);
    return next;
  }

  private async atomicWrite(value: SmartSearchConfig): Promise<void> {
    await this.io.mkdir(this.path.configDir, { recursive: true, mode: 0o700 });
    const temporaryPath = join(this.path.configDir, `.config.json.${process.pid}.${this.temporaryId()}.tmp`);
    try {
      await this.io.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await this.io.rename(temporaryPath, this.path.configFile);
    } catch (error) {
      try {
        await this.io.unlink(temporaryPath);
      } catch (cleanupError) {
        if (!isErrno(cleanupError, "ENOENT")) {
          throw new AggregateError([error, cleanupError], "Unable to save Smart Search config and clean up temporary file");
        }
      }
      throw new Error(`Unable to save Smart Search config: ${errorMessage(error)}`, { cause: error });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(value: unknown, code: string): value is NodeJS.ErrnoException {
  return isRecord(value) && value.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
