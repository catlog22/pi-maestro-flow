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

export const SMART_SEARCH_CONFIG_KEYS = [
  "XAI_API_URL",
  "XAI_API_KEY",
  "XAI_MODEL",
  "XAI_TOOLS",
  "OPENAI_COMPATIBLE_API_URL",
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENAI_COMPATIBLE_MODEL",
  "OPENAI_COMPATIBLE_FALLBACK_MODELS",
  "OPENAI_COMPATIBLE_STREAM",
  "SMART_SEARCH_VALIDATION_LEVEL",
  "SMART_SEARCH_FALLBACK_MODE",
  "SMART_SEARCH_MINIMUM_PROFILE",
  "SMART_SEARCH_RESEARCH_PREFERRED_PROVIDERS",
  "SMART_SEARCH_RESEARCH_DISABLED_PROVIDERS",
  "SMART_SEARCH_INTENT_ROUTER",
  "INTENT_EMBEDDING_API_URL",
  "INTENT_EMBEDDING_API_KEY",
  "INTENT_EMBEDDING_MODEL",
  "INTENT_EMBEDDING_THRESHOLD",
  "INTENT_EMBEDDING_MARGIN",
  "INTENT_CLASSIFIER_API_URL",
  "INTENT_CLASSIFIER_API_KEY",
  "INTENT_CLASSIFIER_MODEL",
  "INTENT_ROUTER_TIMEOUT_SECONDS",
  "EXA_API_KEY",
  "EXA_BASE_URL",
  "EXA_TIMEOUT_SECONDS",
  "CONTEXT7_API_KEY",
  "CONTEXT7_BASE_URL",
  "CONTEXT7_TIMEOUT_SECONDS",
  "ZHIPU_API_KEY",
  "ZHIPU_API_URL",
  "ZHIPU_SEARCH_ENGINE",
  "ZHIPU_TIMEOUT_SECONDS",
  "ZHIPU_MCP_API_KEY",
  "ZHIPU_MCP_SEARCH_API_URL",
  "ZHIPU_MCP_READER_API_URL",
  "ZHIPU_MCP_ZREAD_API_URL",
  "ZHIPU_MCP_TIMEOUT_SECONDS",
  "JINA_API_KEY",
  "JINA_READER_API_URL",
  "JINA_RESPOND_WITH",
  "JINA_TIMEOUT_SECONDS",
  "TAVILY_API_KEY",
  "TAVILY_API_URL",
  "TAVILY_ENABLED",
  "TAVILY_TIMEOUT_SECONDS",
  "FIRECRAWL_API_KEY",
  "FIRECRAWL_API_URL",
  "ANYSEARCH_API_KEY",
  "ANYSEARCH_API_URL",
  "ANYSEARCH_TIMEOUT_SECONDS",
  "SMART_SEARCH_DEBUG",
  "SMART_SEARCH_LOG_LEVEL",
  "SMART_SEARCH_LOG_DIR",
  "SMART_SEARCH_RETRY_MAX_ATTEMPTS",
  "SMART_SEARCH_RETRY_MULTIPLIER",
  "SMART_SEARCH_RETRY_MAX_WAIT",
  "SMART_SEARCH_OUTPUT_CLEANUP",
  "SMART_SEARCH_LOG_TO_FILE",
  "SSL_VERIFY",
] as const;

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
