import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ProviderConfig,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { NETWORK_RETRY_POLICY } from "pi-maestro-teammate/v1/retry";
import {
  EFFORT_LEVELS,
  EFFORT_STATUS_KEY,
  effortProgressBar,
  isThinkingLevel as isCanonicalThinkingLevel,
} from "../effort-display.ts";
import { readCompactionSettings } from "../compaction/compaction-settings.ts";
import { deriveCompactionThreshold, type CompactionThresholdReason } from "../compaction/compaction-threshold.ts";
import {
  showApiModelEditor,
  type ApiModelFormChoice,
  type ApiModelFormValues,
} from "../tui/api-model-editor.ts";

export type ApiProviderId = "maestro-openai" | "maestro-qwen" | "maestro-anthropic";

/**
 * API protocols accepted by pi's provider contract (KnownApi). A Provider
 * chooses one protocol; multiple Providers may use the same protocol with
 * independent URLs, API keys, and model sets.
 */
export const KNOWN_APIS: readonly string[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "azure-openai-responses",
  "openai-codex-responses",
  "mistral-conversations",
  "bedrock-converse-stream",
  "google-vertex",
];

const API_FORMAT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
  "google-generative-ai": "Google Generative AI",
  "azure-openai-responses": "Azure OpenAI Responses",
  "openai-codex-responses": "OpenAI Codex Responses",
  "mistral-conversations": "Mistral Conversations",
  "bedrock-converse-stream": "Amazon Bedrock Converse Stream",
  "google-vertex": "Google Vertex AI",
});

export interface ApiProviderSettings {
  /** Provider id used by Pi to qualify models and isolate URL/API key configuration. */
  provider: string;
  baseUrl: string;
  modelId: string;
  contextWindow?: number;
  reasoning: boolean;
  apiKey: string;
  maxThinking?: boolean;
  /** API protocol. Required for user-defined Providers; presets derive it from PROVIDERS. */
  api?: string;
  /** Optional Provider display name. */
  name?: string;
  /** Provider-level protocol compatibility options. */
  compat?: Record<string, unknown>;
  /** Max output tokens for user-defined Providers. */
  maxTokens?: number;
  /** Whether omitted Provider compat/headers/authHeader values should be cleared. */
  replaceProviderOptions?: boolean;
  /** Custom request headers for this Provider. */
  headers?: Record<string, string>;
  /** Whether to send Authorization: Bearer. Undefined lets pi decide. */
  authHeader?: boolean;
}

/**
 * thinkingFormat variants for OpenAI-compatible completions APIs. "auto" leaves
 * the field unset so pi detects the format from the baseUrl (e.g. api.x.ai → Grok).
 */
const THINKING_FORMAT_OPTIONS: ReadonlyArray<{ label: string; value?: string }> = [
  { label: "自动（按 URL 识别，推荐）" },
  { label: "openai（reasoning_effort）", value: "openai" },
  { label: "openrouter（reasoning.effort）", value: "openrouter" },
  { label: "deepseek（thinking.type · 亦适用 api.z.ai 直连）", value: "deepseek" },
  { label: "zai（enable_thinking · DashScope 托管 GLM）", value: "zai" },
  { label: "qwen（enable_thinking）", value: "qwen" },
  { label: "qwen-chat-template（chat_template_kwargs）", value: "qwen-chat-template" },
];

const AUTO_LABEL = "自动（按 URL 识别）";

function apiFormatLabel(api: string): string {
  const name = API_FORMAT_NAMES[api];
  return name ? `${name} (${api})` : api;
}

interface LoadedApiProviderSettings extends ApiProviderSettings {
  configured: boolean;
}

interface ProviderDefaults {
  id: ApiProviderId;
  name: string;
  api: "openai-responses" | "openai-completions" | "anthropic-messages";
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  compat?: Record<string, unknown>;
}

interface SaveApiProviderResult {
  path: string;
  backupPath?: string;
}

export interface RegisterApiProviderOptions {
  modelsPath?: string;
  defaultsPath?: string;
  settingsPath?: string;
}

export interface ApiRetrySettings {
  enabled: boolean;
  maxRetries: number;
}

type ApiProviderAction = "configure" | "delete" | "disable" | "enable" | "list" | "logout" | "reset" | "retry" | "show" | "toggle";
type ApiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const DEFAULT_THINKING_LEVEL: ApiThinkingLevel = "medium";
const API_RETRY_MAX_RETRIES = NETWORK_RETRY_POLICY.maxRetries;
const DEFAULT_API_RETRY_SETTINGS: Readonly<ApiRetrySettings> = Object.freeze({
  enabled: true,
  maxRetries: API_RETRY_MAX_RETRIES,
});

const PROVIDERS: readonly ProviderDefaults[] = [
  {
    id: "maestro-openai",
    name: "OpenAI Responses",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-5.4",
    contextWindow: 400_000,
    maxTokens: 128_000,
  },
  {
    id: "maestro-qwen",
    name: "Qwen · OpenAI Chat Completions",
    api: "openai-completions",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    modelId: "qwen3.8-max-preview",
    contextWindow: 400_000,
    maxTokens: 128_000,
    compat: {
      supportsDeveloperRole: false,
      thinkingFormat: "qwen",
    },
  },
  {
    id: "maestro-anthropic",
    name: "Anthropic Messages",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    modelId: "claude-sonnet-4-5",
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
];

const mutationQueues = new Map<string, Promise<void>>();

/**
 * Register API Providers through Pi's documented models.json contract. A Provider
 * owns provider-level connection config (URL, API key, format, headers, auth) and
 * hosts one or more models; models under the same Provider share that connection.
 */
export function registerApiProviderConfigs(
  pi: ExtensionAPI,
  options: RegisterApiProviderOptions = {},
): void {
  const modelsPath = options.modelsPath ?? join(getAgentDir(), "models.json");
  const defaultsPath = options.defaultsPath ?? join(dirname(modelsPath), "api-manager.json");
  const settingsPath = options.settingsPath ?? join(dirname(modelsPath), "settings.json");
  const configured = configuredProviderIds(modelsPath);
  if (typeof pi.registerProvider === "function") {
    for (const provider of PROVIDERS) {
      if (configured.has(provider.id)) {
        pi.registerProvider(provider.id, configuredProviderRegistration(provider.id, modelsPath));
      }
    }
    for (const id of managedProviderIdsSync(defaultsPath)) {
      if (findPreset(id) || !hasEnabledProviderSync(id, modelsPath)) continue;
      pi.registerProvider(id, configuredProviderRegistration(id, modelsPath));
    }
  }

  if (typeof pi.registerCommand !== "function") return;
  pi.registerCommand("api-manager", {
    description: "管理 API 模型与 Provider 配置",
    async handler(args, ctx) {
      try {
        await showApiProviderManager(pi, args, ctx, modelsPath, defaultsPath, settingsPath);
      } catch (error) {
        ctx.ui.notify(`API 配置失败：${errorMessage(error)}`, "error");
      }
    },
  });
  pi.registerCommand("effort", {
    description: "调整当前模型的思考强度",
    async handler(_args, ctx) {
      if (!ctx.model) {
        ctx.ui.notify("当前没有模型，无法调整思考强度。", "warning");
        return;
      }
      const current = pi.getThinkingLevel();
      const supported = getSupportedThinkingLevels(ctx.model).filter(isThinkingLevel);
      const labels = new Map<string, ThinkingLevel>();
      const options = supported.map((level) => {
        const label = `${level}${level === current ? "（当前）" : ""} ${effortProgressBar(level)}`;
        labels.set(label, level);
        return label;
      });
      const choice = await ctx.ui.select(`选择思考强度（当前：${current}）`, options);
      if (choice === undefined) return;
      const selected = labels.get(choice);
      if (!selected) return;
      try {
        await saveModelThinkingDefault(ctx.model.provider, ctx.model.id, selected, defaultsPath);
      } catch (error) {
        ctx.ui.notify(`思考强度保存失败：${errorMessage(error)}`, "error");
        return;
      }
      try {
        setPiThinkingLevel(pi, selected);
      } catch (error) {
        ctx.ui.notify(`思考强度应用失败：${errorMessage(error)}`, "error");
        return;
      }
      syncEffortStatus(ctx, selected);
      ctx.ui.notify(`思考强度已设为 ${selected} ${effortProgressBar(selected)}`, "info");
    },
  });
  if (typeof pi.on === "function") {
    pi.on("session_start", async (_event, ctx) => {
      try {
        await ensureApiRetryDefaults(settingsPath);
      } catch (error) {
        ctx.ui.notify(`Retry 默认配置初始化失败：${errorMessage(error)}`, "warning");
      }
      syncEffortStatus(ctx, pi.getThinkingLevel());
    });
    pi.on("model_select", async (event, ctx) => {
      const level = await loadModelThinkingDefault(event.model.provider, event.model.id, defaultsPath);
      if (level) setPiThinkingLevel(pi, level);
      syncEffortStatus(ctx, level ?? pi.getThinkingLevel());
    });
    pi.on("thinking_level_select", (event, ctx) => syncEffortStatus(ctx, event.level));
    pi.on("session_shutdown", (_event, ctx) => syncEffortStatus(ctx, undefined));
  }
}

export async function loadApiProviderSettings(
  provider: string,
  modelsPath = join(getAgentDir(), "models.json"),
  modelId?: string | null,
): Promise<LoadedApiProviderSettings> {
  await migrateLegacyProviderThinkingMaps(provider, modelsPath);
  const preset = findPreset(provider);
  const root = await readModelsRoot(modelsPath);
  const providers = isRecord(root.providers) ? root.providers : {};
  // Bind before guarding: narrowing only flows through an aliased condition
  // when the guarded value is itself a const, not a repeated index expression.
  const candidate = providers[provider];
  const configured = isRecord(candidate);
  const config = configured ? candidate : {};
  const models = Array.isArray(config.models) ? config.models.filter(isRecord) : [];
  const model = modelId === null
    ? undefined
    : modelId
      ? models.find((entry) => entry.id === modelId)
      : models[0];
  const thinkingLevelMap = isRecord(model?.thinkingLevelMap) ? model.thinkingLevelMap : {};
  // Legacy model-level overrides are still read during migration; canonical API Manager
  // entries keep connection/format fields on the Provider because Provider is the model identity.
  const api = typeof model?.api === "string"
    ? model.api
    : typeof config.api === "string"
      ? config.api
      : preset?.api;
  const compat = isRecord(model?.compat)
    ? { ...model.compat }
    : isRecord(config.compat)
      ? { ...config.compat }
      : undefined;
  const headers = isStringRecord(model?.headers)
    ? { ...model.headers }
    : isStringRecord(config.headers)
      ? { ...config.headers }
      : undefined;
  return {
    configured,
    provider,
    baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : preset?.baseUrl ?? "",
    modelId: typeof model?.id === "string" ? model.id : preset?.modelId ?? "",
    contextWindow: typeof model?.contextWindow === "number"
      ? model.contextWindow
      : preset?.contextWindow ?? 128_000,
    reasoning: typeof model?.reasoning === "boolean" ? model.reasoning : true,
    apiKey: typeof config.apiKey === "string" ? config.apiKey : "",
    maxThinking: thinkingLevelMap.xhigh === "max" || thinkingLevelMap.max === "max",
    api,
    name: typeof config.name === "string" ? config.name : preset?.name,
    compat,
    headers,
    authHeader: typeof config.authHeader === "boolean" ? config.authHeader : undefined,
    maxTokens: typeof model?.maxTokens === "number"
      ? model.maxTokens
      : preset?.maxTokens ?? 16_384,
  };
}

export async function saveApiProviderSettings(
  settings: ApiProviderSettings,
  modelsPath = join(getAgentDir(), "models.json"),
): Promise<SaveApiProviderResult> {
  const normalized: ApiProviderSettings = {
    provider: normalizeChannelId(settings.provider),
    baseUrl: normalizeBaseUrl(settings.baseUrl),
    modelId: required(settings.modelId, "Model ID"),
    contextWindow: settings.contextWindow === undefined
      ? undefined
      : positiveInteger(settings.contextWindow, "上下文窗口 contextWindow"),
    reasoning: settings.reasoning,
    apiKey: required(settings.apiKey ?? "", "API key config"),
    maxThinking: settings.maxThinking === true,
    api: settings.api,
    name: settings.name?.trim() || undefined,
    compat: settings.compat,
    maxTokens: settings.maxTokens === undefined
      ? undefined
      : positiveInteger(settings.maxTokens, "单次最大输出 maxTokens"),
    replaceProviderOptions: settings.replaceProviderOptions === true,
    headers: settings.headers && Object.keys(settings.headers).length > 0 ? settings.headers : undefined,
    authHeader: settings.authHeader,
  };
  let result: SaveApiProviderResult | undefined;
  await serializeMutation(modelsPath, async () => {
    result = await writeApiProviderSettings(normalized, modelsPath);
  });
  if (!result) throw new Error("API Provider settings were not written");
  return result;
}

export async function setApiProviderEnabled(
  provider: string,
  enabled: boolean,
  modelsPath = join(getAgentDir(), "models.json"),
): Promise<SaveApiProviderResult> {
  let result: SaveApiProviderResult | undefined;
  await serializeMutation(modelsPath, async () => {
    const exists = await fileExists(modelsPath);
    const root = await readModelsRoot(modelsPath);
    const providers = isRecord(root.providers) ? { ...root.providers } : {};
    const current = isRecord(providers[provider]) ? { ...providers[provider] } : undefined;
    if (!current) throw new Error(`Provider ${provider} is not configured`);
    providers[provider] = { ...current, enabled };
    result = await writeModelsRoot({ ...root, providers }, modelsPath, exists);
  });
  if (!result) throw new Error("API Provider state was not written");
  return result;
}

export async function deleteApiProviderSettings(
  provider: string,
  modelsPath = join(getAgentDir(), "models.json"),
): Promise<SaveApiProviderResult> {
  let result: SaveApiProviderResult | undefined;
  await serializeMutation(modelsPath, async () => {
    const exists = await fileExists(modelsPath);
    const root = await readModelsRoot(modelsPath);
    const providers = isRecord(root.providers) ? { ...root.providers } : {};
    delete providers[provider];
    result = await writeModelsRoot({ ...root, providers }, modelsPath, exists);
  });
  if (!result) throw new Error("API Provider settings were not deleted");
  return result;
}

export async function deleteApiProviderModelSettings(
  provider: string,
  modelId: string,
  modelsPath = join(getAgentDir(), "models.json"),
): Promise<SaveApiProviderResult> {
  let result: SaveApiProviderResult | undefined;
  await serializeMutation(modelsPath, async () => {
    const exists = await fileExists(modelsPath);
    const root = await readModelsRoot(modelsPath);
    const providers = isRecord(root.providers) ? { ...root.providers } : {};
    const config = isRecord(providers[provider]) ? { ...providers[provider] } : undefined;
    if (!config) throw new Error(`Provider ${provider} is not configured`);
    const rawModels = Array.isArray(config.models) ? config.models : [];
    if (rawModels.some((model) => !isRecord(model) || typeof model.id !== "string")) {
      throw new Error(`Provider ${provider} contains malformed model entries; refusing a lossy delete`);
    }
    const models = rawModels as Record<string, unknown>[];
    const remaining = models.filter((model) => model.id !== modelId);
    if (remaining.length === models.length) throw new Error(`Model ${modelId} is not configured`);
    if (remaining.length === 0) delete providers[provider];
    else providers[provider] = { ...config, models: remaining };
    result = await writeModelsRoot({ ...root, providers }, modelsPath, exists);
  });
  if (!result) throw new Error("API model settings were not deleted");
  return result;
}

export const ALLOW_INSECURE_PROVIDER_HTTP_ENV = "PI_ALLOW_INSECURE_PROVIDER_HTTP";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const ipv4 = normalized.split(".");
  return ipv4.length === 4
    && ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && Number(ipv4[0]) === 127;
}

export function normalizeBaseUrl(value: string): string {
  const normalized = required(value, "Base URL").replace(/\/+$/, "");
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL must use http or https");
  }
  if (
    parsed.protocol === "http:"
    && !isLoopbackHostname(parsed.hostname)
    && process.env[ALLOW_INSECURE_PROVIDER_HTTP_ENV] !== "1"
  ) {
    console.warn(
      `[WARN] Remote Base URL uses insecure HTTP (${value}); set ${ALLOW_INSECURE_PROVIDER_HTTP_ENV}=1 to suppress this warning`,
    );
  }
  return normalized;
}

export async function loadApiRetrySettings(
  settingsPath = join(getAgentDir(), "settings.json"),
): Promise<ApiRetrySettings> {
  const root = await readModelsRoot(settingsPath);
  const retry = isRecord(root.retry) ? root.retry : {};
  return {
    enabled: typeof retry.enabled === "boolean" ? retry.enabled : DEFAULT_API_RETRY_SETTINGS.enabled,
    maxRetries: isPositiveInteger(retry.maxRetries)
      ? retry.maxRetries
      : DEFAULT_API_RETRY_SETTINGS.maxRetries,
  };
}

export async function saveApiRetrySettings(
  settings: ApiRetrySettings,
  settingsPath = join(getAgentDir(), "settings.json"),
): Promise<void> {
  const maxRetries = retryCount(settings.maxRetries);
  await serializeMutation(settingsPath, async () => {
    const exists = await fileExists(settingsPath);
    const root = await readModelsRoot(settingsPath);
    const retry = isRecord(root.retry) ? root.retry : {};
    await writeModelsRoot({
      ...root,
      retry: {
        ...retry,
        enabled: settings.enabled,
        maxRetries,
        baseDelayMs: isPositiveInteger(retry.baseDelayMs)
          ? retry.baseDelayMs
          : NETWORK_RETRY_POLICY.initialDelayMs,
      },
    }, settingsPath, exists);
  });
}

export async function ensureApiRetryDefaults(
  settingsPath = join(getAgentDir(), "settings.json"),
): Promise<void> {
  const root = await readModelsRoot(settingsPath);
  const retry = isRecord(root.retry) ? root.retry : {};
  if (
    typeof retry.enabled === "boolean"
    && isPositiveInteger(retry.maxRetries)
    && isPositiveInteger(retry.baseDelayMs)
  ) return;
  await saveApiRetrySettings({
    enabled: typeof retry.enabled === "boolean" ? retry.enabled : DEFAULT_API_RETRY_SETTINGS.enabled,
    maxRetries: isPositiveInteger(retry.maxRetries)
      ? retry.maxRetries
      : DEFAULT_API_RETRY_SETTINGS.maxRetries,
  }, settingsPath);
}

async function manageRetrySettings(
  ctx: ExtensionCommandContext,
  settingsPath: string,
  command?: RetryManagerArgs,
): Promise<void> {
  const current = await loadApiRetrySettings(settingsPath);
  if (command?.enabled !== undefined) {
    const next = {
      enabled: command.enabled,
      maxRetries: command.maxRetries ?? current.maxRetries,
    };
    await saveApiRetrySettings(next, settingsPath);
    notifyRetrySettings(ctx, next, settingsPath);
    return;
  }
  if (!ctx.hasUI || command?.showOnly) {
    notifyRetrySettings(ctx, current, settingsPath);
    return;
  }

  const enabledLabel = `开启${current.enabled ? "（当前）" : ""}`;
  const disabledLabel = `关闭${current.enabled ? "" : "（当前）"}`;
  const enabledChoice = await ctx.ui.select("Provider 自动重试", [enabledLabel, disabledLabel]);
  if (!enabledChoice) return;
  const enabled = enabledChoice === enabledLabel;
  let maxRetries = current.maxRetries;
  if (enabled) {
    const input = await ctx.ui.input(
      `最大重试次数（1-${API_RETRY_MAX_RETRIES}）`,
      String(current.maxRetries),
    );
    if (input === undefined) return;
    maxRetries = retryCount(input);
  }
  const confirmed = await ctx.ui.confirm(
    "保存 Provider 重试配置？",
    [
      `自动重试：${enabled ? "开启" : "关闭"}`,
      `最大重试次数：${maxRetries}`,
      "执行所有权：Pi core（指数退避，TUI 显示实时状态）",
    ].join("\n"),
  );
  if (!confirmed) return;
  const next = { enabled, maxRetries };
  await saveApiRetrySettings(next, settingsPath);
  notifyRetrySettings(ctx, next, settingsPath);
}

function notifyRetrySettings(
  ctx: Pick<ExtensionCommandContext, "ui">,
  settings: ApiRetrySettings,
  settingsPath: string,
): void {
  ctx.ui.notify([
    `Provider 自动重试：${settings.enabled ? "开启" : "关闭"}`,
    `最大重试次数：${settings.maxRetries}`,
    `配置：${settingsPath}`,
  ].join("\n"), "info");
}

async function showApiProviderManager(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
  settingsPath: string,
): Promise<void> {
  const parsed = parseManagerArgs(args);
  if (!ctx.hasUI && !parsed.action) {
    ctx.ui.notify("/api-manager 交互菜单需要交互式 Pi 会话。", "warning");
    return;
  }
  const action = parsed.action ?? await chooseAction(ctx, settingsPath);
  if (!action) return;
  if (action === "list") {
    await listProviders(ctx, modelsPath, defaultsPath, settingsPath);
    return;
  }
  if (action === "retry") {
    await manageRetrySettings(ctx, settingsPath, parsed.retry);
    return;
  }
  if (action === "enable" || action === "disable" || action === "toggle") {
    if (!ctx.hasUI && !parsed.target) {
      ctx.ui.notify(`/api-manager ${action} 需要指定 Provider ID。`, "warning");
      return;
    }
    const target = parsed.target ?? await chooseProvider(ctx, modelsPath, defaultsPath);
    if (!target) return;
    const ref = await resolveChannelRef(target, ctx, modelsPath);
    if (!ref) return;
    const current = await isProviderEnabled(ref.id, modelsPath);
    const enabled = action === "enable" ? true : action === "disable" ? false : !current;
    await toggleProvider(pi, ref.id, ref.name, enabled, ctx, modelsPath);
    return;
  }
  if (action === "configure") {
    if (!ctx.hasUI) {
      ctx.ui.notify("/api-manager configure 需要交互式 Pi 会话。", "warning");
      return;
    }
    if (parsed.target) {
      if (parsed.target.kind === "preset") {
        await configureProvider(pi, parsed.target.preset, ctx, modelsPath, defaultsPath);
      } else {
        const requireNew = parsed.target.id === "";
        await configureCustomChannel(
          pi,
          ctx,
          modelsPath,
          defaultsPath,
          parsed.target.id || undefined,
          requireNew,
        );
      }
      return;
    }
    const pick = await chooseModelGlobally(ctx, "configure", modelsPath, defaultsPath);
    if (!pick) return;
    await dispatchGlobalModelPick(pi, pick, "configure", ctx, modelsPath, defaultsPath, settingsPath);
    return;
  }
  if (action === "show" || action === "delete") {
    if (parsed.target) {
      const ref = await resolveChannelRef(parsed.target, ctx, modelsPath);
      if (!ref) return;
      if (action === "show") {
        await showProvider(ctx, ref.id, ref.name, modelsPath, defaultsPath);
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(`/api-manager ${action} 需要交互式 Pi 会话。`, "warning");
        return;
      }
      await deleteProvider(pi, ref.id, ref.name, ctx, modelsPath, defaultsPath, settingsPath);
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(`/api-manager ${action} 需要交互式 Pi 会话。`, "warning");
      return;
    }
    const pick = await chooseModelGlobally(ctx, action, modelsPath, defaultsPath);
    if (!pick) return;
    await dispatchGlobalModelPick(pi, pick, action, ctx, modelsPath, defaultsPath, settingsPath);
    return;
  }
  // logout / reset 是 Provider（URL/key）级操作。
  const target = parsed.target ?? (ctx.hasUI ? await chooseProvider(ctx, modelsPath, defaultsPath) : undefined);
  if (!target) {
    ctx.ui.notify("请指定 Provider：openai、qwen、anthropic 或用户定义的 Provider ID。", "warning");
    return;
  }
  const ref = await resolveChannelRef(target, ctx, modelsPath);
  if (!ref) return;
  if (!ctx.hasUI) {
    ctx.ui.notify(`/api-manager ${action} 需要交互式 Pi 会话。`, "warning");
    return;
  }
  if (action === "logout") {
    await removeProviderKey(pi, ref.id, ref.name, ctx, modelsPath, defaultsPath, settingsPath);
  } else {
    await resetProvider(pi, ref.id, ref.name, ctx, modelsPath, defaultsPath, settingsPath);
  }
}

async function configureProvider(
  pi: ExtensionAPI,
  provider: ProviderDefaults,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
): Promise<void> {
  const target = await chooseModelToConfigure(provider.id, provider.name, ctx, modelsPath);
  if (!target) return;
  await configurePresetModelTarget(pi, provider, target, ctx, modelsPath, defaultsPath);
}

async function configurePresetModelTarget(
  pi: ExtensionAPI,
  provider: ProviderDefaults,
  target: ConfigureModelTarget,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
): Promise<void> {
  if (supportsApiModelForm(ctx)) {
    await configurePresetModelWithForm(pi, provider, ctx, modelsPath, defaultsPath, target.adding ? null : target.modelId);
    return;
  }
  await configurePresetModelWithSteps(pi, provider, target, ctx, modelsPath, defaultsPath);
}

/** Legacy step-by-step fallback for hosts without the custom form overlay. */
async function configurePresetModelWithSteps(
  pi: ExtensionAPI,
  provider: ProviderDefaults,
  target: ConfigureModelTarget,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
): Promise<void> {
  const current = await loadApiProviderSettings(provider.id, modelsPath, target.modelId);
  const maxThinking = current.maxThinking === true || runtimeSupportsMaxThinking(ctx);
  const baseUrlInput = await ctx.ui.input(`${provider.name} Base URL`, current.configured ? current.baseUrl : "");
  if (baseUrlInput === undefined) return;
  const baseUrl = normalizeBaseUrl(baseUrlInput);
  const modelInput = await ctx.ui.input(
    `${provider.name} model ID`,
    target.adding ? "" : current.configured ? current.modelId : provider.modelId,
  );
  if (modelInput === undefined) return;
  const modelIds = parseModelIdList(modelInput);
  if (modelIds.length === 0) throw new Error("Model ID 不能为空");
  const targetProviderId = provider.id;
  const maxSuffix = maxThinking ? " / max" : "";
  const enabledLabel = provider.api === "openai-responses"
    ? `启用：minimal / low / medium / high / xhigh${maxSuffix}`
    : `启用：off / minimal / low / medium / high / xhigh${maxSuffix}`;
  const disabledLabel = "关闭：仅 off";
  const reasoningChoice = await ctx.ui.select(
    "推理强度支持",
    current.reasoning ? [enabledLabel, disabledLabel] : [disabledLabel, enabledLabel],
  );
  if (!reasoningChoice) return;
  const defaultThinkingLevel = await chooseDefaultThinkingLevel(
    ctx,
    provider.api,
    reasoningChoice === enabledLabel,
    await loadModelThinkingDefault(targetProviderId, modelIds[0], defaultsPath)
      ?? currentDefaultThinkingLevel(ctx, modelsPath),
    maxThinking,
  );
  if (!defaultThinkingLevel) return;

  const contextWindowInput = await ctx.ui.input(
    `${provider.name} 上下文窗口 contextWindow（输入+输出总 Token，本地注册值）`,
    String(current.contextWindow ?? provider.contextWindow),
  );
  if (contextWindowInput === undefined) return;
  const contextWindow = positiveInteger(contextWindowInput, "上下文窗口 contextWindow");
  const maxTokensInput = await ctx.ui.input(
    `${provider.name} 单次最大输出 maxTokens（运行时按剩余窗口动态收缩）`,
    String(current.maxTokens ?? provider.maxTokens),
  );
  if (maxTokensInput === undefined) return;
  const maxTokens = positiveInteger(maxTokensInput, "单次最大输出 maxTokens");
  validateModelWindow(contextWindow, maxTokens);

  const keyInput = await ctx.ui.input(`${provider.name} API key`, "");
  if (keyInput === undefined) return;
  const apiKey = required(keyInput, "API key");

  const confirmed = await ctx.ui.confirm(
    `保存 ${provider.name} API 配置？`,
    [
      `Provider：${targetProviderId}`,
      `API format：${apiFormatLabel(provider.api)}`,
      `Base URL：${baseUrl}`,
      `Model：${modelIds.join(", ")}`,
      `上下文窗口 contextWindow：${contextWindow.toLocaleString("en-US")} Token（输入+输出总量，本地注册值）`,
      `单次最大输出 maxTokens：${maxTokens.toLocaleString("en-US")} Token`,
      ...compactionPreviewLines(ctx.cwd, contextWindow, maxTokens),
      `Reasoning：${reasoningChoice === enabledLabel ? "enabled" : "disabled"}`,
      `Default thinking（当前 model）：${defaultThinkingLevel}`,
      "Auth：stored API key",
    ].join("\n"),
  );
  if (!confirmed) return;
  const reasoning = reasoningChoice === enabledLabel;
  let result: SaveApiProviderResult | undefined;
  for (const [index, nextModelId] of modelIds.entries()) {
    const next: ApiProviderSettings = {
      provider: targetProviderId,
      baseUrl,
      modelId: nextModelId,
      contextWindow,
      maxTokens,
      reasoning,
      apiKey,
      maxThinking,
    };
    result = await saveApiProviderSettings(next, modelsPath);
    await saveModelThinkingDefault(
      targetProviderId,
      nextModelId,
      canonicalThinkingLevel(defaultThinkingLevel),
      defaultsPath,
    );
    if (index === 0) await saveDefaultModelAndThinking(ctx, modelsPath, targetProviderId, nextModelId, target.modelId === null);
  }
  if (!findPreset(targetProviderId)) await addManagedProvider(defaultsPath, targetProviderId);
  reloadProviderRegistration(pi, ctx, targetProviderId, modelsPath);
  applyThinkingLevelToActiveModel(
    pi,
    ctx,
    targetProviderId,
    modelIds[0],
    canonicalThinkingLevel(defaultThinkingLevel),
  );
  if (!result) throw new Error("API Provider settings were not written");
  notifySaved(
    ctx,
    provider.name,
    result,
    `已保存 ${modelIds.length} 个模型：${modelIds.map((id) => `${targetProviderId}/${id}`).join(", ")}，默认思考强度为 ${defaultThinkingLevel}`,
  );
}

async function configureCustomChannel(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
  initialId?: string,
  requireNew = false,
): Promise<void> {
  const idInput = await ctx.ui.input("Provider ID", initialId ?? "");
  if (idInput === undefined) return;
  const providerId = normalizeChannelId(idInput);
  if (requireNew && (findPreset(providerId) || await isProviderConfigured(providerId, modelsPath))) {
    ctx.ui.notify(`Provider ID ${providerId} 已存在；新建操作不会修改已有 Provider。`, "warning");
    return;
  }
  const preset = findPreset(providerId);
  if (preset) {
    await configureProvider(pi, preset, ctx, modelsPath, defaultsPath);
    return;
  }
  if (requireNew) {
    await configureCustomModelTarget(
      pi,
      providerId,
      { modelId: null, adding: true },
      ctx,
      modelsPath,
      defaultsPath,
    );
    return;
  }
  const target = await chooseModelToConfigure(providerId, await channelDisplayName(providerId, modelsPath), ctx, modelsPath);
  if (!target) return;
  await configureCustomModelTarget(pi, providerId, target, ctx, modelsPath, defaultsPath);
}

async function configureCustomModelTarget(
  pi: ExtensionAPI,
  providerId: string,
  target: ConfigureModelTarget,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
): Promise<void> {
  if (supportsApiModelForm(ctx)) {
    await configureCustomModelWithForm(pi, providerId, ctx, modelsPath, defaultsPath, target.adding ? null : target.modelId);
    return;
  }
  await configureCustomModelWithSteps(pi, providerId, target, ctx, modelsPath, defaultsPath);
}

/** Legacy step-by-step fallback for hosts without the custom form overlay. */
async function configureCustomModelWithSteps(
  pi: ExtensionAPI,
  providerId: string,
  target: ConfigureModelTarget,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
): Promise<void> {
  const currentDisplayName = await channelDisplayName(providerId, modelsPath);
  const current = await loadApiProviderSettings(providerId, modelsPath, target.modelId);
  const apiOptions = current.api && KNOWN_APIS.includes(current.api)
    ? [current.api, ...KNOWN_APIS.filter((api) => api !== current.api)]
    : [...KNOWN_APIS];
  const apiLabels = apiOptions.map(apiFormatLabel);
  const apiChoice = await ctx.ui.select("API format", apiLabels);
  if (!apiChoice) return;
  const api = apiOptions.find((candidate) => apiFormatLabel(candidate) === apiChoice)
    ?? (apiOptions.includes(apiChoice) ? apiChoice : undefined);
  if (!api) return;
  const nameInput = await ctx.ui.input("Provider 显示名称", current.name ?? providerId);
  if (nameInput === undefined) return;
  const displayName = nameInput.trim() || providerId;
  const baseUrlInput = await ctx.ui.input(`${displayName} Base URL`, current.configured ? current.baseUrl : "");
  if (baseUrlInput === undefined) return;
  const baseUrl = normalizeBaseUrl(baseUrlInput);
  const modelInput = await ctx.ui.input(
    `${displayName} model ID`,
    target.adding ? "" : current.configured ? current.modelId : "",
  );
  if (modelInput === undefined) return;
  const modelIds = parseModelIdList(modelInput);
  if (modelIds.length === 0) throw new Error("Model ID 不能为空");
  const targetProviderId = providerId;
  const maxThinking = current.maxThinking === true || runtimeSupportsMaxThinking(ctx);
  const maxSuffix = maxThinking ? " / max" : "";
  const enabledLabel = api === "openai-responses"
    ? `启用：minimal / low / medium / high / xhigh${maxSuffix}`
    : `启用：off / minimal / low / medium / high / xhigh${maxSuffix}`;
  const disabledLabel = "关闭：仅 off";
  const reasoningChoice = await ctx.ui.select(
    "推理强度支持",
    current.reasoning ? [enabledLabel, disabledLabel] : [disabledLabel, enabledLabel],
  );
  if (!reasoningChoice) return;
  const reasoning = reasoningChoice === enabledLabel;
  const defaultThinkingLevel = await chooseDefaultThinkingLevel(
    ctx,
    api,
    reasoning,
    await loadModelThinkingDefault(targetProviderId, modelIds[0], defaultsPath)
      ?? currentDefaultThinkingLevel(ctx, modelsPath),
    maxThinking,
  );
  if (!defaultThinkingLevel) return;
  const contextWindowInput = await ctx.ui.input(
    `${displayName} 上下文窗口 contextWindow（输入+输出总 Token，本地注册值）`,
    String(current.configured ? current.contextWindow : 128_000),
  );
  if (contextWindowInput === undefined) return;
  const contextWindow = positiveInteger(contextWindowInput, "上下文窗口 contextWindow");
  const maxTokensInput = await ctx.ui.input(
    `${displayName} 单次最大输出 maxTokens（运行时按剩余窗口动态收缩）`,
    String(current.configured ? current.maxTokens : 16_384),
  );
  if (maxTokensInput === undefined) return;
  const maxTokens = positiveInteger(maxTokensInput, "单次最大输出 maxTokens");
  validateModelWindow(contextWindow, maxTokens);
  let compat: Record<string, unknown> | undefined;
  if (api === "openai-completions") {
    const compatAccumulator: Record<string, unknown> = {};
    const thinkingChoice = await ctx.ui.select(
      "thinking 格式",
      THINKING_FORMAT_OPTIONS.map((entry) => entry.label),
    );
    if (!thinkingChoice) return;
    const thinkingFormat = THINKING_FORMAT_OPTIONS.find((entry) => entry.label === thinkingChoice)?.value;
    if (thinkingFormat) compatAccumulator.thinkingFormat = thinkingFormat;
    const advancedChoice = await ctx.ui.select("高级兼容选项", [AUTO_LABEL, "手动设置…"]);
    if (!advancedChoice) return;
    if (advancedChoice === "手动设置…") {
      const developerChoice = await ctx.ui.select(
        "developer 角色支持",
        [AUTO_LABEL, "支持（developer 角色）", "不支持（用 system）"],
      );
      if (!developerChoice) return;
      if (developerChoice !== AUTO_LABEL) compatAccumulator.supportsDeveloperRole = developerChoice.startsWith("支持");
      const effortChoice = await ctx.ui.select(
        "reasoning_effort 支持（xAI grok-4.5 需手动开启）",
        [AUTO_LABEL, "支持", "不支持"],
      );
      if (!effortChoice) return;
      if (effortChoice !== AUTO_LABEL) compatAccumulator.supportsReasoningEffort = effortChoice === "支持";
      const maxTokensFieldChoice = await ctx.ui.select(
        "最大输出请求字段（兼容选项，不是 maxTokens 数值）",
        [AUTO_LABEL, "max_completion_tokens", "max_tokens"],
      );
      if (!maxTokensFieldChoice) return;
      if (maxTokensFieldChoice !== AUTO_LABEL) compatAccumulator.maxTokensField = maxTokensFieldChoice;
    }
    if (Object.keys(compatAccumulator).length > 0) compat = compatAccumulator;
  }

  const headers: Record<string, string> = {};
  const addHeaders = await ctx.ui.confirm(
    "添加自定义请求头？",
    "例如 OpenRouter 的 HTTP-Referer / X-Title，或 anthropic-version。留空 name 结束。",
  );
  if (addHeaders) {
    while (true) {
      const headerNameInput = await ctx.ui.input("请求头 name（留空结束）", "");
      if (headerNameInput === undefined) return;
      const headerName = headerNameInput.trim();
      if (!headerName) break;
      const headerValueInput = await ctx.ui.input(`请求头 "${headerName}" 的值`, "");
      if (headerValueInput === undefined) return;
      headers[headerName] = headerValueInput;
    }
  }
  const authHeaderChoice = await ctx.ui.select(
    "Authorization 头",
    [AUTO_LABEL, "强制 Bearer（authHeader=true）", "不发 Bearer（authHeader=false）"],
  );
  if (!authHeaderChoice) return;
  const authHeader = authHeaderChoice === AUTO_LABEL
    ? undefined
    : authHeaderChoice.startsWith("强制");

  const keyInput = await ctx.ui.input(`${displayName} API key`, "");
  if (keyInput === undefined) return;
  const apiKey = required(keyInput, "API key");

  const confirmed = await ctx.ui.confirm(
    `保存 Provider ${displayName}？`,
    [
      `Provider ID：${targetProviderId}`,
      `API format：${apiFormatLabel(api)}`,
      `Base URL：${baseUrl}`,
      `Model：${modelIds.join(", ")}`,
      `上下文窗口 contextWindow：${contextWindow.toLocaleString("en-US")} Token（输入+输出总量，本地注册值）`,
      `单次最大输出 maxTokens：${maxTokens.toLocaleString("en-US")} Token`,
      ...compactionPreviewLines(ctx.cwd, contextWindow, maxTokens),
      `Reasoning：${reasoning ? "enabled" : "disabled"}`,
      `Default thinking（当前 model）：${defaultThinkingLevel}`,
      `Compat：${compat ? JSON.stringify(compat) : "自动"}`,
      `请求头：${Object.keys(headers).length > 0 ? Object.keys(headers).join(", ") : "无"}`,
      `Authorization：${authHeader === undefined ? "自动" : authHeader ? "Bearer" : "关闭"}`,
      "Auth：stored API key",
    ].join("\n"),
  );
  if (!confirmed) return;
  let result: SaveApiProviderResult | undefined;
  for (const [index, nextModelId] of modelIds.entries()) {
    const next: ApiProviderSettings = {
      provider: targetProviderId,
      baseUrl,
      modelId: nextModelId,
      contextWindow,
      maxTokens,
      reasoning,
      apiKey,
      maxThinking,
      api,
      name: displayName,
      compat,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      authHeader,
    };
    result = await saveApiProviderSettings(next, modelsPath);
    await saveModelThinkingDefault(
      targetProviderId,
      nextModelId,
      canonicalThinkingLevel(defaultThinkingLevel),
      defaultsPath,
    );
    if (index === 0) await saveDefaultModelAndThinking(ctx, modelsPath, targetProviderId, nextModelId, target.modelId === null);
  }
  await addManagedProvider(defaultsPath, targetProviderId);
  reloadProviderRegistration(pi, ctx, targetProviderId, modelsPath);
  applyThinkingLevelToActiveModel(
    pi,
    ctx,
    targetProviderId,
    modelIds[0],
    canonicalThinkingLevel(defaultThinkingLevel),
  );
  if (!result) throw new Error("API Provider settings were not written");
  notifySaved(
    ctx,
    displayName,
    result,
    `已保存 ${modelIds.length} 个模型：${modelIds.map((id) => `${targetProviderId}/${id}`).join(", ")}，默认思考强度为 ${defaultThinkingLevel}`,
  );
}

async function configurePresetModelWithForm(
  pi: ExtensionAPI,
  provider: ProviderDefaults,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
  modelId: string | null,
): Promise<void> {
  const adding = modelId === null;
  const current = await loadApiProviderSettings(provider.id, modelsPath, modelId);
  const maxThinking = adding
    ? current.maxThinking === true || runtimeSupportsMaxThinking(ctx)
    : current.maxThinking === true;
  const existingModelIds = await configuredModelIds(provider.id, modelsPath);
  const currentThinking = modelId
    ? await loadModelThinkingDefault(provider.id, modelId, defaultsPath)
      ?? currentDefaultThinkingLevel(ctx, modelsPath)
    : currentDefaultThinkingLevel(ctx, modelsPath);
  const result = await showApiModelEditor(ctx, {
    title: adding ? `新增 ${provider.name} 模型` : `修改 ${provider.name} / ${modelId}`,
    fields: [
      { id: "connection-section", label: "连接（Provider / URL 级）", kind: "section", value: "" },
      { id: "provider", label: "Provider", kind: "readonly", value: provider.id },
      { id: "api", label: "API format", kind: "readonly", value: apiFormatLabel(provider.api) },
      { id: "baseUrl", label: "Base URL", kind: "text", value: current.baseUrl },
      {
        id: "apiKey",
        label: "API key",
        kind: "secret",
        value: current.apiKey,
        help: "API key 仅显示掩码；不编辑即可保留 models.json 中的当前值。",
      },
      { id: "model-section", label: "模型（Model 级）", kind: "section", value: "" },
      {
        id: "modelId",
        label: "Model ID",
        kind: adding ? "text" : "readonly",
        value: adding ? (current.configured ? "" : provider.modelId) : current.modelId,
        help: adding ? "多个 Model ID 用逗号分隔，一次新增多个模型（其余字段作为模板应用到每个模型）" : undefined,
      },
      { id: "reasoning", label: "推理能力", kind: "toggle", value: current.reasoning },
      {
        id: "defaultThinking",
        label: "默认思考强度",
        kind: "choice",
        value: reconcileFormThinkingLevel(provider.api, current.reasoning, currentThinking, maxThinking),
        choices: thinkingFormChoices(provider.api, maxThinking),
      },
      { id: "contextWindow", label: "上下文窗口", kind: "number", value: String(current.contextWindow) },
      { id: "maxTokens", label: "单次最大输出", kind: "number", value: String(current.maxTokens) },
    ],
    validate: (values) => validateApiModelForm(
      values,
      provider.api,
      maxThinking,
      adding ? existingModelIds : undefined,
    ),
  });
  if (!result) return;

  const baseUrl = normalizeBaseUrl(formText(result.values, "baseUrl"));
  const nextModelIds = modelId
    ? [modelId]
    : parseModelIdList(formText(result.values, "modelId"));
  const targetProviderId = provider.id;
  const reasoning = formBoolean(result.values, "reasoning");
  const defaultThinkingLevel = formThinkingLevel(result.values, "defaultThinking");
  const contextWindow = positiveInteger(formText(result.values, "contextWindow"), "上下文窗口 contextWindow");
  const maxTokens = positiveInteger(formText(result.values, "maxTokens"), "单次最大输出 maxTokens");
  validateModelWindow(contextWindow, maxTokens);
  const apiKey = required(formText(result.values, "apiKey"), "API key");
  const confirmed = await ctx.ui.confirm(
    `保存 ${provider.name} API 配置？`,
    modelSavePreview({
      providerId: targetProviderId,
      api: provider.api,
      displayName: provider.name,
      baseUrl,
      modelIds: nextModelIds,
      contextWindow,
      maxTokens,
      reasoning,
      defaultThinkingLevel,
      cwd: ctx.cwd,
    }),
  );
  if (!confirmed) return;
  let saveResult: SaveApiProviderResult | undefined;
  for (const [index, nextModelId] of nextModelIds.entries()) {
    const next: ApiProviderSettings = {
      provider: targetProviderId,
      baseUrl,
      modelId: nextModelId,
      contextWindow,
      maxTokens,
      reasoning,
      apiKey,
      maxThinking,
    };
    saveResult = await saveApiProviderSettings(next, modelsPath);
    await saveModelThinkingDefault(
      targetProviderId,
      nextModelId,
      canonicalThinkingLevel(defaultThinkingLevel),
      defaultsPath,
    );
    if (index === 0) await saveDefaultModelAndThinking(ctx, modelsPath, targetProviderId, nextModelId, adding);
  }
  if (!findPreset(targetProviderId)) await addManagedProvider(defaultsPath, targetProviderId);
  reloadProviderRegistration(pi, ctx, targetProviderId, modelsPath);
  applyThinkingLevelToActiveModel(
    pi,
    ctx,
    targetProviderId,
    nextModelIds[0],
    canonicalThinkingLevel(defaultThinkingLevel),
  );
  if (!saveResult) throw new Error("API Provider settings were not written");
  notifySaved(
    ctx,
    provider.name,
    saveResult,
    `已保存 ${nextModelIds.length} 个模型：${nextModelIds.map((id) => `${targetProviderId}/${id}`).join(", ")}，默认思考强度为 ${defaultThinkingLevel}`,
  );
}

async function configureCustomModelWithForm(
  pi: ExtensionAPI,
  providerId: string,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
  modelId: string | null,
): Promise<void> {
  const adding = modelId === null;
  const current = await loadApiProviderSettings(providerId, modelsPath, modelId);
  const displayName = current.name ?? providerId;
  const maxThinking = adding
    ? current.maxThinking === true || runtimeSupportsMaxThinking(ctx)
    : current.maxThinking === true;
  const currentApi = current.api ?? "openai-completions";
  const existingModelIds = await configuredModelIds(providerId, modelsPath);
  const currentThinking = modelId
    ? await loadModelThinkingDefault(providerId, modelId, defaultsPath)
      ?? currentDefaultThinkingLevel(ctx, modelsPath)
    : currentDefaultThinkingLevel(ctx, modelsPath);
  const compat = current.compat ?? {};
  const result = await showApiModelEditor(ctx, {
    title: adding ? `新增 ${displayName} 模型` : `修改 ${displayName} / ${modelId}`,
    fields: [
      { id: "connection-section", label: "连接（Provider / URL 级）", kind: "section", value: "" },
      { id: "provider", label: "Provider", kind: "readonly", value: providerId },
      {
        id: "api",
        label: "API format",
        kind: "choice",
        value: currentApi,
        choices: formChoicesWithCurrent(
          currentApi,
          KNOWN_APIS.map((api) => ({ label: apiFormatLabel(api), value: api })),
        ),
      },
      { id: "name", label: "Provider 显示名称", kind: "text", value: current.name ?? providerId },
      { id: "baseUrl", label: "Base URL", kind: "text", value: current.baseUrl },
      {
        id: "apiKey",
        label: "API key",
        kind: "secret",
        value: current.apiKey,
        help: "API key 仅显示掩码；不编辑即可保留 models.json 中的当前值。",
      },
      {
        id: "headers",
        label: "请求头 JSON",
        kind: "secret",
        value: JSON.stringify(current.headers ?? {}),
        help: "请求头可能包含凭据，表单仅显示掩码；编辑时需输入完整 JSON 对象。",
      },
      {
        id: "authHeader",
        label: "Authorization",
        kind: "choice",
        value: triStateValue(current.authHeader),
        choices: [
          { label: "自动", value: "auto" },
          { label: "Bearer", value: "true" },
          { label: "不发送", value: "false" },
        ],
      },
      { id: "compat-section", label: "兼容（format 级）", kind: "section", value: "" },
      {
        id: "thinkingFormat",
        label: "Thinking format",
        kind: "choice",
        value: typeof compat.thinkingFormat === "string" ? compat.thinkingFormat : "",
        choices: formChoicesWithCurrent(
          typeof compat.thinkingFormat === "string" ? compat.thinkingFormat : "",
          [{ label: "自动（按 URL 识别）", value: "" }, ...THINKING_FORMAT_OPTIONS.flatMap((entry) =>
            entry.value ? [{ label: entry.label, value: entry.value }] : []
          )],
        ),
      },
      {
        id: "supportsDeveloperRole",
        label: "Developer 角色",
        kind: "choice",
        value: triStateValue(compat.supportsDeveloperRole),
        choices: TRI_STATE_CHOICES,
      },
      {
        id: "supportsReasoningEffort",
        label: "Reasoning effort",
        kind: "choice",
        value: triStateValue(compat.supportsReasoningEffort),
        choices: TRI_STATE_CHOICES,
      },
      {
        id: "maxTokensField",
        label: "输出请求字段",
        kind: "choice",
        value: typeof compat.maxTokensField === "string" ? compat.maxTokensField : "",
        choices: formChoicesWithCurrent(
          typeof compat.maxTokensField === "string" ? compat.maxTokensField : "",
          [
            { label: "自动", value: "" },
            { label: "max_completion_tokens", value: "max_completion_tokens" },
            { label: "max_tokens", value: "max_tokens" },
          ],
        ),
      },
      { id: "model-section", label: "模型（Model 级）", kind: "section", value: "" },
      {
        id: "modelId",
        label: "Model ID",
        kind: adding ? "text" : "readonly",
        value: adding ? "" : current.modelId,
        help: adding ? "多个 Model ID 用逗号分隔，一次新增多个模型（其余字段作为模板应用到每个模型）" : undefined,
      },
      { id: "reasoning", label: "推理能力", kind: "toggle", value: current.reasoning },
      {
        id: "defaultThinking",
        label: "默认思考强度",
        kind: "choice",
        value: reconcileFormThinkingLevel(currentApi, current.reasoning, currentThinking, maxThinking),
        choices: thinkingFormChoices(currentApi, maxThinking),
      },
      { id: "contextWindow", label: "上下文窗口", kind: "number", value: String(current.contextWindow) },
      { id: "maxTokens", label: "单次最大输出", kind: "number", value: String(current.maxTokens) },
    ],
    validate: (values) => {
      const errors = validateApiModelForm(
        values,
        formText(values, "api"),
        maxThinking,
        adding ? existingModelIds : undefined,
      );
      try {
        parseHeadersForm(formText(values, "headers"));
      } catch (error) {
        errors.push(errorMessage(error));
      }
      return errors;
    },
  });
  if (!result) return;

  const api = required(formText(result.values, "api"), "API type");
  const nextDisplayName = formText(result.values, "name").trim() || providerId;
  const baseUrl = normalizeBaseUrl(formText(result.values, "baseUrl"));
  const nextModelIds = modelId
    ? [modelId]
    : parseModelIdList(formText(result.values, "modelId"));
  const targetProviderId = providerId;
  const reasoning = formBoolean(result.values, "reasoning");
  const defaultThinkingLevel = formThinkingLevel(result.values, "defaultThinking");
  const contextWindow = positiveInteger(formText(result.values, "contextWindow"), "上下文窗口 contextWindow");
  const maxTokens = positiveInteger(formText(result.values, "maxTokens"), "单次最大输出 maxTokens");
  validateModelWindow(contextWindow, maxTokens);
  const apiKey = required(formText(result.values, "apiKey"), "API key");
  const headers = parseHeadersForm(formText(result.values, "headers"));
  const nextCompat = { ...compat };
  setOptionalCompatString(nextCompat, "thinkingFormat", formText(result.values, "thinkingFormat"));
  setOptionalCompatBoolean(nextCompat, "supportsDeveloperRole", formText(result.values, "supportsDeveloperRole"));
  setOptionalCompatBoolean(nextCompat, "supportsReasoningEffort", formText(result.values, "supportsReasoningEffort"));
  setOptionalCompatString(nextCompat, "maxTokensField", formText(result.values, "maxTokensField"));
  const authHeaderValue = formText(result.values, "authHeader");
  const authHeader = authHeaderValue === "auto" ? undefined : authHeaderValue === "true";
  const confirmed = await ctx.ui.confirm(
    `保存 Provider ${nextDisplayName}？`,
    [
      modelSavePreview({
        providerId: targetProviderId,
        api,
        displayName: nextDisplayName,
        baseUrl,
        modelIds: nextModelIds,
        contextWindow,
        maxTokens,
        reasoning,
        defaultThinkingLevel,
        cwd: ctx.cwd,
      }),
      `Compat：${nextCompat && Object.keys(nextCompat).length > 0 ? JSON.stringify(nextCompat) : "自动"}`,
      `请求头：${Object.keys(headers).length > 0 ? Object.keys(headers).join(", ") : "无"}`,
      `Authorization：${authHeader === undefined ? "自动" : authHeader ? "Bearer" : "关闭"}`,
    ].join("\n"),
  );
  if (!confirmed) return;
  let saveResult: SaveApiProviderResult | undefined;
  for (const [index, nextModelId] of nextModelIds.entries()) {
    const next: ApiProviderSettings = {
      provider: targetProviderId,
      baseUrl,
      modelId: nextModelId,
      contextWindow,
      maxTokens,
      reasoning,
      apiKey,
      maxThinking,
      api,
      name: nextDisplayName,
      compat: Object.keys(nextCompat).length > 0 ? nextCompat : undefined,
      replaceProviderOptions: true,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      authHeader,
    };
    saveResult = await saveApiProviderSettings(next, modelsPath);
    await saveModelThinkingDefault(
      targetProviderId,
      nextModelId,
      canonicalThinkingLevel(defaultThinkingLevel),
      defaultsPath,
    );
    if (index === 0) await saveDefaultModelAndThinking(ctx, modelsPath, targetProviderId, nextModelId, adding);
  }
  await addManagedProvider(defaultsPath, targetProviderId);
  reloadProviderRegistration(pi, ctx, targetProviderId, modelsPath);
  applyThinkingLevelToActiveModel(
    pi,
    ctx,
    targetProviderId,
    nextModelIds[0],
    canonicalThinkingLevel(defaultThinkingLevel),
  );
  if (!saveResult) throw new Error("API Provider settings were not written");
  notifySaved(
    ctx,
    nextDisplayName,
    saveResult,
    `已保存 ${nextModelIds.length} 个模型：${nextModelIds.map((id) => `${targetProviderId}/${id}`).join(", ")}，默认思考强度为 ${defaultThinkingLevel}`,
  );
}

interface ModelSavePreviewInput {
  providerId: string;
  api: string;
  displayName: string;
  baseUrl: string;
  modelIds: string[];
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  defaultThinkingLevel: ApiThinkingLevel;
  cwd: string;
}

function modelSavePreview(input: ModelSavePreviewInput): string {
  return [
    `Provider：${input.providerId}`,
    `API format：${apiFormatLabel(input.api)}`,
    `Base URL：${input.baseUrl}`,
    `Model：${input.modelIds.join(", ")}`,
    `上下文窗口 contextWindow：${input.contextWindow.toLocaleString("en-US")} Token（输入+输出总量，本地注册值）`,
    `单次最大输出 maxTokens：${input.maxTokens.toLocaleString("en-US")} Token`,
    ...compactionPreviewLines(input.cwd, input.contextWindow, input.maxTokens),
    `Reasoning：${input.reasoning ? "enabled" : "disabled"}`,
    `Default thinking（当前 model）：${input.defaultThinkingLevel}`,
    "Auth：stored API key",
    "隔离：同 Provider 下所有模型共享 URL 与 API key",
  ].join("\n");
}

/** Split a comma-separated Model ID list (form array input) into non-empty IDs. */
function parseModelIdList(value: string): string[] {
  return value.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
}

const TRI_STATE_CHOICES: readonly ApiModelFormChoice[] = [
  { label: "自动", value: "auto" },
  { label: "支持", value: "true" },
  { label: "不支持", value: "false" },
];

function supportsApiModelForm(ctx: ExtensionCommandContext): boolean {
  return typeof (ctx.ui as { custom?: unknown }).custom === "function";
}

function thinkingFormChoices(_api: string, maxThinking: boolean): ApiModelFormChoice[] {
  const levels: ApiThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
  if (maxThinking) levels.push("max");
  return levels.map((level) => ({ label: level, value: level }));
}

function supportedThinkingFormValues(api: string, maxThinking: boolean): ApiThinkingLevel[] {
  const levels: ApiThinkingLevel[] = api === "openai-responses"
    ? ["minimal", "low", "medium", "high", "xhigh"]
    : ["off", "minimal", "low", "medium", "high", "xhigh"];
  if (maxThinking) levels.push("max");
  return levels;
}

function reconcileFormThinkingLevel(
  api: string,
  reasoning: boolean,
  current: ApiThinkingLevel,
  maxThinking: boolean,
): ApiThinkingLevel {
  const supported: ApiThinkingLevel[] = reasoning ? supportedThinkingFormValues(api, maxThinking) : ["off"];
  if (supported.includes(current)) return current;
  return supported.includes(DEFAULT_THINKING_LEVEL) ? DEFAULT_THINKING_LEVEL : supported[0];
}

function formChoicesWithCurrent(current: string, choices: readonly ApiModelFormChoice[]): ApiModelFormChoice[] {
  return choices.some((choice) => choice.value === current)
    ? [...choices]
    : [{ label: `${current}（当前）`, value: current }, ...choices];
}

function validateApiModelForm(
  values: ApiModelFormValues,
  api: string,
  maxThinking: boolean,
  duplicateModelIds?: readonly string[],
): string[] {
  const errors: string[] = [];
  try {
    normalizeBaseUrl(formText(values, "baseUrl"));
    const modelIds = parseModelIdList(formText(values, "modelId"));
    if (modelIds.length === 0) throw new Error("Model ID 不能为空");
    const seen = new Set<string>();
    for (const modelId of modelIds) {
      if (seen.has(modelId)) errors.push(`Model ID ${modelId} 重复；每个模型只能出现一次`);
      seen.add(modelId);
      if (duplicateModelIds?.includes(modelId)) {
        errors.push(`Model ${modelId} 已存在；请返回列表选择该 model 进行修改`);
      }
    }
    const contextWindow = positiveInteger(formText(values, "contextWindow"), "上下文窗口 contextWindow");
    const maxTokens = positiveInteger(formText(values, "maxTokens"), "单次最大输出 maxTokens");
    validateModelWindow(contextWindow, maxTokens);
    required(formText(values, "apiKey"), "API key");
    const reasoning = formBoolean(values, "reasoning");
    const thinking = formThinkingLevel(values, "defaultThinking");
    const supported: ApiThinkingLevel[] = reasoning ? supportedThinkingFormValues(api, maxThinking) : ["off"];
    if (!supported.includes(thinking)) {
      errors.push(`默认思考强度 ${thinking} 与当前 API / 推理能力不兼容`);
    }
  } catch (error) {
    errors.push(errorMessage(error));
  }
  return errors;
}

function formText(values: ApiModelFormValues, id: string): string {
  const value = values[id];
  if (typeof value !== "string") throw new Error(`表单字段 ${id} 无效`);
  return value;
}

function formBoolean(values: ApiModelFormValues, id: string): boolean {
  const value = values[id];
  if (typeof value !== "boolean") throw new Error(`表单字段 ${id} 无效`);
  return value;
}

function formThinkingLevel(values: ApiModelFormValues, id: string): ApiThinkingLevel {
  const value = formText(values, id);
  if (!(value === "max" || isThinkingLevel(value))) throw new Error(`思考强度 ${value} 无效`);
  return value;
}

function triStateValue(value: unknown): string {
  return typeof value === "boolean" ? String(value) : "auto";
}

function setOptionalCompatString(target: Record<string, unknown>, key: string, value: string): void {
  if (value) target[key] = value;
  else delete target[key];
}

function setOptionalCompatBoolean(target: Record<string, unknown>, key: string, value: string): void {
  if (value === "auto") delete target[key];
  else target[key] = value === "true";
}

function parseHeadersForm(value: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "{}");
  } catch {
    throw new Error("请求头 JSON 格式无效");
  }
  if (!isStringRecord(parsed)) throw new Error("请求头必须是字符串键值的 JSON 对象");
  return { ...parsed };
}

async function removeProviderKey(
  pi: ExtensionAPI,
  providerId: string,
  displayName: string,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
  settingsPath: string,
): Promise<void> {
  if (!await isProviderConfigured(providerId, modelsPath)) {
    ctx.ui.notify(`${displayName} 尚未配置，无需注销。`, "info");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    `注销 ${displayName}？`,
    "将删除该 Provider 的 Base URL、models 和 API key；重新新增必须显式输入独立 URL 和 API key。",
  );
  if (!confirmed) return;
  const modelIds = await configuredModelIds(providerId, modelsPath);
  const result = await deleteApiProviderSettings(providerId, modelsPath);
  await deleteProviderThinkingDefaults(providerId, defaultsPath);
  for (const modelId of modelIds) {
    await clearDeletedDefaultModel(settingsPath, providerId, modelId);
  }
  await removeManagedProvider(defaultsPath, providerId);
  pi.unregisterProvider(providerId);
  ctx.modelRegistry.refresh();
  notifySaved(ctx, displayName, result, "已注销；连接配置和 API key 已移除");
}

async function toggleProvider(
  pi: ExtensionAPI,
  providerId: string,
  displayName: string,
  enabled: boolean,
  ctx: ExtensionCommandContext,
  modelsPath: string,
): Promise<void> {
  if (!await isProviderConfigured(providerId, modelsPath)) {
    ctx.ui.notify(`${displayName} 尚未配置。`, "warning");
    return;
  }
  const current = await isProviderEnabled(providerId, modelsPath);
  if (current === enabled) {
    ctx.ui.notify(`${displayName} 已经${enabled ? "启用" : "停用"}。`, "info");
    return;
  }
  if (ctx.hasUI) {
    const confirmed = await ctx.ui.confirm(
      `${enabled ? "启用" : "停用"} ${displayName}？`,
      enabled
        ? "将重新注册该 Provider，其 models 会恢复到 /model。"
        : "将从运行时移除该 Provider 的 models，但保留 URL、API key 和全部模型配置。",
    );
    if (!confirmed) return;
  }
  const result = await setApiProviderEnabled(providerId, enabled, modelsPath);
  if (enabled) pi.registerProvider(providerId, configuredProviderRegistration(providerId, modelsPath));
  else pi.unregisterProvider(providerId);
  ctx.modelRegistry.refresh();
  notifySaved(ctx, displayName, result, enabled ? "已启用；models 已恢复到 /model" : "已停用；配置仍完整保留");
}

async function resetProvider(
  pi: ExtensionAPI,
  providerId: string,
  displayName: string,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
  settingsPath: string,
): Promise<void> {
  if (!await isProviderConfigured(providerId, modelsPath)) {
    ctx.ui.notify(`${displayName} 尚未配置，无需重置。`, "info");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    `重置 ${displayName}？`,
    "将清除该 Provider 的连接配置、models、API key 和思考强度默认值；不会写入环境变量占位。",
  );
  if (!confirmed) return;
  const modelIds = await configuredModelIds(providerId, modelsPath);
  const result = await deleteApiProviderSettings(providerId, modelsPath);
  await deleteProviderThinkingDefaults(providerId, defaultsPath);
  for (const modelId of modelIds) {
    await clearDeletedDefaultModel(settingsPath, providerId, modelId);
  }
  await removeManagedProvider(defaultsPath, providerId);
  await saveDefaultThinkingLevel(ctx, modelsPath, DEFAULT_THINKING_LEVEL);
  pi.unregisterProvider(providerId);
  ctx.modelRegistry.refresh();
  notifySaved(ctx, displayName, result, `已重置为未配置；默认思考强度为 ${DEFAULT_THINKING_LEVEL}`);
}

async function deleteProvider(
  pi: ExtensionAPI,
  providerId: string,
  displayName: string,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
  settingsPath: string,
): Promise<void> {
  if (!await isProviderConfigured(providerId, modelsPath)) {
    ctx.ui.notify(`${displayName} 尚未配置，无需删除。`, "info");
    return;
  }
  const modelIds = await configuredModelIds(providerId, modelsPath);
  const modelId = modelIds.length === 1
    ? modelIds[0]
    : await ctx.ui.select(`选择要删除的 ${displayName} 模型`, modelIds);
  if (!modelId) return;
  await deleteProviderModel(
    pi,
    providerId,
    displayName,
    modelId,
    ctx,
    modelsPath,
    defaultsPath,
    settingsPath,
  );
}

async function deleteProviderModel(
  pi: ExtensionAPI,
  providerId: string,
  displayName: string,
  modelId: string,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
  settingsPath: string,
): Promise<void> {
  const modelIds = await configuredModelIds(providerId, modelsPath);
  const confirmed = await ctx.ui.confirm(
    `删除 ${displayName}/${modelId}？`,
    "将删除该模型；同一 Provider 的其他模型与连接配置不受影响。",
  );
  if (!confirmed) return;
  const result = await deleteApiProviderModelSettings(providerId, modelId, modelsPath);
  await deleteModelThinkingDefault(providerId, modelId, defaultsPath);
  await clearDeletedDefaultModel(settingsPath, providerId, modelId);
  if (modelIds.length === 1) {
    await removeManagedProvider(defaultsPath, providerId);
    pi.unregisterProvider(providerId);
  } else {
    reloadProviderRegistration(pi, ctx, providerId, modelsPath);
  }
  ctx.modelRegistry.refresh();
  notifySaved(ctx, displayName, result, `已删除 ${modelId}；该模型已从 /model 移除`);
}

async function listProviders(
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
  settingsPath: string,
): Promise<void> {
  const root = await readModelsRoot(modelsPath);
  const retry = await loadApiRetrySettings(settingsPath);
  const providers = isRecord(root.providers) ? root.providers : {};
  const modelLines: string[] = [];
  const providerLines: string[] = [];
  for (const preset of PROVIDERS) {
    const config = providers[preset.id];
    if (!isRecord(config)) {
      providerLines.push(`- ${preset.id}（${preset.name}）· 未配置`);
      continue;
    }
    const api = typeof config.api === "string" ? config.api : preset.api;
    await appendListLines(
      config,
      preset.id,
      preset.name,
      api,
      false,
      providerEnabled(config),
      modelLines,
      providerLines,
      defaultsPath,
    );
  }
  for (const id of managedProviderIdsSync(defaultsPath)) {
    if (findPreset(id) || !isRecord(providers[id])) continue;
    const config = providers[id];
    const name = typeof config.name === "string" && config.name ? config.name : id;
    const api = typeof config.api === "string" ? config.api : "?";
    await appendListLines(
      config,
      id,
      name,
      api,
      true,
      providerEnabled(config),
      modelLines,
      providerLines,
      defaultsPath,
    );
  }
  ctx.ui.notify([
    "API 模型（平铺展示）：",
    ...(modelLines.length > 0 ? modelLines : ["（尚未配置任何模型）"]),
    "Providers（URL / API key 级配置）：",
    ...providerLines,
    `Pi 全局默认思考强度：${currentDefaultThinkingLevel(ctx, modelsPath)}`,
    `Provider 自动重试：${retry.enabled ? "开启" : "关闭"} · 最大 ${retry.maxRetries} 次`,
    `文件：${modelsPath}`,
  ].join("\n"), "info");
}

async function appendListLines(
  config: Record<string, unknown>,
  providerId: string,
  name: string,
  api: string,
  custom: boolean,
  enabled: boolean,
  modelLines: string[],
  providerLines: string[],
  defaultsPath: string,
): Promise<void> {
  const models = Array.isArray(config.models) ? config.models.filter(isRecord) : [];
  for (const model of models) {
    if (typeof model.id !== "string") continue;
    const level = await loadModelThinkingDefault(providerId, model.id, defaultsPath);
    const modelApi = typeof model.api === "string" ? model.api : api;
    modelLines.push([
      `- ${providerId}/${model.id}`,
      `format: ${apiFormatLabel(modelApi)}`,
      `ctx ${typeof model.contextWindow === "number" ? model.contextWindow.toLocaleString("en-US") : "?"}`,
      `max ${typeof model.maxTokens === "number" ? model.maxTokens.toLocaleString("en-US") : "?"}`,
      `reasoning=${model.reasoning === true ? "on" : "off"}`,
      `default: ${level ?? "global"}`,
    ].join(" · "));
  }
  providerLines.push([
    `- ${providerId}（${name}${custom ? " · 用户定义" : ""}）`,
    enabled ? "启用" : "停用",
    `format: ${apiFormatLabel(api)}`,
    typeof config.baseUrl === "string" ? config.baseUrl : "?",
    authSource(config.apiKey),
    `${models.length} model`,
  ].join(" · "));
}

async function showProvider(
  ctx: ExtensionCommandContext,
  providerId: string,
  displayName: string,
  modelsPath: string,
  defaultsPath: string,
  preferredModelId?: string,
): Promise<void> {
  const preset = findPreset(providerId);
  if (!await isProviderConfigured(providerId, modelsPath)) {
    const hint = preset ? providerId.replace("maestro-", "") : providerId;
    ctx.ui.notify(`${displayName}：未配置。使用 /api-manager set ${hint} 新增。`, "info");
    return;
  }
  const root = await readModelsRoot(modelsPath);
  const providers = isRecord(root.providers) ? root.providers : {};
  const config = isRecord(providers[providerId]) ? providers[providerId] : {};
  const models = Array.isArray(config.models) ? config.models.filter(isRecord) : [];
  const api = typeof config.api === "string" ? config.api : preset?.api ?? "?";
  if (ctx.hasUI && models.length > 0) {
    const modelIds = models
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string");
    const modelId = preferredModelId
      ?? (modelIds.length === 1
        ? modelIds[0]
        : await ctx.ui.select(`选择要查看的 ${displayName} 模型`, modelIds));
    if (!modelId) return;
    const model = models.find((entry) => entry.id === modelId) ?? {};
    const level = await loadModelThinkingDefault(providerId, modelId, defaultsPath);
    const modelApi = typeof model.api === "string" ? model.api : api;
    ctx.ui.notify([
      displayName,
      `Provider：${providerId}`,
      `Provider 状态：${providerEnabled(config) ? "启用" : "停用"}`,
      `API format：${apiFormatLabel(modelApi)}`,
      `Base URL：${typeof config.baseUrl === "string" ? config.baseUrl : preset?.baseUrl ?? ""}`,
      `Model：${modelId}`,
      `上下文窗口 contextWindow：${typeof model.contextWindow === "number" ? model.contextWindow.toLocaleString("en-US") : "?"} Token（输入+输出总量，本地注册值）`,
      `单次最大输出 maxTokens：${typeof model.maxTokens === "number" ? model.maxTokens.toLocaleString("en-US") : "?"} Token`,
      ...(typeof model.contextWindow === "number" && typeof model.maxTokens === "number"
        ? compactionPreviewLines(ctx.cwd, model.contextWindow, model.maxTokens)
        : []),
      `Reasoning：${model.reasoning === true ? "enabled" : "disabled"}`,
      `Default thinking：${level ?? "global"}`,
      `Auth：${authSource(config.apiKey)}`,
      `文件：${modelsPath}`,
    ].join("\n"), "info");
    return;
  }
  const modelLines = await Promise.all(models.map(async (model) => {
    const id = typeof model.id === "string" ? model.id : "<invalid>";
    const level = id === "<invalid>" ? undefined : await loadModelThinkingDefault(providerId, id, defaultsPath);
    return `- ${id} · reasoning=${model.reasoning === true ? "enabled" : "disabled"} · default=${level ?? "global"}`;
  }));
  ctx.ui.notify([
    displayName,
    `Provider：${providerId}`,
    `Provider 状态：${providerEnabled(config) ? "启用" : "停用"}`,
    `API format：${apiFormatLabel(api)}`,
    `Base URL：${typeof config.baseUrl === "string" ? config.baseUrl : preset?.baseUrl ?? ""}`,
    `Models（${models.length}）：`,
    ...modelLines,
    `Default thinking（Pi 全局）：${currentDefaultThinkingLevel(ctx, modelsPath)}`,
    `Auth：${authSource(config.apiKey)}`,
    `文件：${modelsPath}`,
  ].join("\n"), "info");
}

async function writeApiProviderSettings(
  settings: ApiProviderSettings,
  modelsPath: string,
): Promise<SaveApiProviderResult> {
  const defaults = resolveWriteDefaults(settings);
  const exists = await fileExists(modelsPath);
  const root = await readModelsRoot(modelsPath);
  const providers = isRecord(root.providers) ? { ...root.providers } : {};
  const currentEntry = providers[settings.provider];
  const currentProvider = isRecord(currentEntry) ? { ...currentEntry } : {};
  const preset = findPreset(settings.provider);
  const rawModels = Array.isArray(currentProvider.models) ? currentProvider.models : [];
  if (rawModels.some((model) => !isRecord(model) || typeof model.id !== "string")) {
    throw new Error(`Provider ${settings.provider} contains malformed model entries; refusing a lossy save`);
  }
  const currentModels = rawModels as Record<string, unknown>[];
  const existingIndex = currentModels.findIndex((model) => model.id === settings.modelId);
  const existingModel = existingIndex >= 0 ? currentModels[existingIndex] : {};
  const contextWindow = settings.contextWindow
    ?? (typeof existingModel.contextWindow === "number" ? existingModel.contextWindow : defaults.contextWindow);
  const maxTokens = settings.maxTokens
    ?? (typeof existingModel.maxTokens === "number" ? existingModel.maxTokens : defaults.maxTokens);
  validateModelWindow(contextWindow, maxTokens);
  const nextModel: Record<string, unknown> = {
    ...existingModel,
    id: settings.modelId,
    name: typeof existingModel.name === "string" ? existingModel.name : settings.modelId,
    reasoning: settings.reasoning,
    input: Array.isArray(existingModel.input) ? existingModel.input : ["text", "image"],
    contextWindow,
    maxTokens,
  };
  // Connection/format fields are Provider-level; model entries keep only model-specific settings.
  delete nextModel.api;
  delete nextModel.baseUrl;
  delete nextModel.compat;
  delete nextModel.headers;
  if (settings.reasoning) {
    const thinkingLevelMap: Record<string, string | null> = defaults.api === "anthropic-messages"
      ? { xhigh: "high" }
      : { off: null, xhigh: "xhigh" };
    if (settings.maxThinking) thinkingLevelMap.xhigh = "max";
    nextModel.thinkingLevelMap = thinkingLevelMap;
  } else {
    delete nextModel.thinkingLevelMap;
  }

  const existingCompat = isRecord(existingModel.compat)
    ? materializeProviderCompat(currentProvider.compat, existingModel.compat)
    : isRecord(currentProvider.compat)
      ? { ...currentProvider.compat }
      : undefined;
  const existingHeaders = isStringRecord(existingModel.headers)
    ? { ...existingModel.headers }
    : isStringRecord(currentProvider.headers)
      ? { ...currentProvider.headers }
      : undefined;
  const nextModels = existingIndex >= 0
    ? currentModels.map((model, index) => index === existingIndex ? nextModel : model)
    : [...currentModels, nextModel];
  const nextProvider: Record<string, unknown> = {
    ...currentProvider,
    baseUrl: settings.baseUrl,
    api: defaults.api,
    apiKey: settings.apiKey,
    models: nextModels,
  };
  if (defaults.compat) {
    nextProvider.compat = preset
      ? { ...(existingCompat ?? {}), ...defaults.compat }
      : { ...defaults.compat };
  } else if (!preset && settings.replaceProviderOptions) {
    delete nextProvider.compat;
  } else if (existingCompat) {
    nextProvider.compat = existingCompat;
  }
  if (settings.name) nextProvider.name = settings.name;
  if (settings.headers && Object.keys(settings.headers).length > 0) {
    nextProvider.headers = { ...settings.headers };
  } else if (!preset && settings.replaceProviderOptions) {
    delete nextProvider.headers;
  } else if (existingHeaders) {
    nextProvider.headers = existingHeaders;
  }
  if (settings.authHeader !== undefined) nextProvider.authHeader = settings.authHeader;
  else if (!preset && settings.replaceProviderOptions) delete nextProvider.authHeader;
  providers[settings.provider] = nextProvider;
  return writeModelsRoot({ ...root, providers }, modelsPath, exists);
}

async function writeModelsRoot(
  root: Record<string, unknown>,
  modelsPath: string,
  exists: boolean,
): Promise<SaveApiProviderResult> {
  await mkdir(dirname(modelsPath), { recursive: true, mode: 0o700 });
  const backupPath = exists ? `${modelsPath}.bak-${Date.now()}-${randomUUID().slice(0, 8)}` : undefined;
  if (backupPath) await copyFile(modelsPath, backupPath);
  const temporaryPath = `${modelsPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(root, null, 2)}\n`, "utf8");
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, modelsPath);
  } finally {
    await handle?.close();
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
  return { path: modelsPath, backupPath };
}

async function readModelsRoot(modelsPath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(modelsPath, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("models.json root must be an object");
    return parsed;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return {};
    if (error instanceof SyntaxError) {
      throw new Error(`Unable to parse ${modelsPath}: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

async function serializeMutation(path: string, mutate: () => Promise<void>): Promise<void> {
  const previous = mutationQueues.get(path) ?? Promise.resolve();
  const mutation = previous.catch(() => undefined).then(mutate);
  const settled = mutation.then(() => undefined, () => undefined);
  mutationQueues.set(path, settled);
  try {
    await mutation;
  } finally {
    if (mutationQueues.get(path) === settled) mutationQueues.delete(path);
  }
}

function findPreset(provider: string): ProviderDefaults | undefined {
  return PROVIDERS.find((entry) => entry.id === provider);
}

function providerDefaults(provider: ApiProviderId): ProviderDefaults {
  const defaults = findPreset(provider);
  if (!defaults) throw new Error(`Unsupported API provider: ${provider}`);
  return defaults;
}

interface ProviderWriteDefaults {
  api: string;
  contextWindow: number;
  maxTokens: number;
  compat?: Record<string, unknown>;
}

/** Resolve protocol/limits for a save: presets use PROVIDERS, user-defined Providers use explicit settings. */
function resolveWriteDefaults(settings: ApiProviderSettings): ProviderWriteDefaults {
  const preset = findPreset(settings.provider);
  if (preset) {
    return {
      api: preset.api,
      contextWindow: settings.contextWindow ?? preset.contextWindow,
      maxTokens: settings.maxTokens ?? preset.maxTokens,
      compat: preset.compat,
    };
  }
  return {
    api: required(settings.api ?? "", "API type"),
    contextWindow: settings.contextWindow ?? 128_000,
    maxTokens: settings.maxTokens ?? 16_384,
    compat: settings.compat,
  };
}

function configuredProviderIds(modelsPath: string): Set<ApiProviderId> {
  try {
    const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as unknown;
    if (!isRecord(parsed)) return new Set();
    // Hoisted: TypeScript drops property narrowing inside the filter callback.
    const providers = parsed.providers;
    if (!isRecord(providers)) return new Set();
    return new Set(PROVIDERS
      .filter((provider) => isEnabledProviderConfig(providers[provider.id]))
      .map((provider) => provider.id));
  } catch {
    return new Set();
  }
}

function hasEnabledProviderSync(providerId: string, modelsPath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.providers)) return false;
    const provider = parsed.providers[providerId];
    return isRecord(provider) && providerEnabled(provider);
  } catch {
    return false;
  }
}

export function canonicalizeLegacyThinkingLevelMap(value: unknown): {
  map: Record<string, string | null> | undefined;
  changed: boolean;
} {
  if (!isRecord(value)) return { map: undefined, changed: false };
  const map = Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string | null] =>
      typeof entry[1] === "string" || entry[1] === null
    ),
  );
  if (map.xhigh !== "xhigh" || map.max !== "max") return { map, changed: false };
  map.xhigh = "max";
  delete map.max;
  return { map, changed: true };
}

export function materializeProviderCompat(providerCompat: unknown, modelCompat: unknown):
  ProviderModelConfig["compat"] | undefined {
  const provider = isRecord(providerCompat) ? { ...providerCompat } : undefined;
  const model = isRecord(modelCompat) ? { ...modelCompat } : undefined;
  if (!provider && !model) return undefined;
  const merged: Record<string, unknown> = { ...provider, ...model };
  for (const key of ["openRouterRouting", "vercelGatewayRouting"] as const) {
    const providerRouting = isRecord(provider?.[key]) ? provider[key] : undefined;
    const modelRouting = isRecord(model?.[key]) ? model[key] : undefined;
    if (providerRouting || modelRouting) merged[key] = { ...providerRouting, ...modelRouting };
  }
  return merged as ProviderModelConfig["compat"];
}

function configuredProviderRegistration(
  providerId: string,
  modelsPath: string,
): ProviderConfig {
  const fallbackName = findPreset(providerId)?.name ?? providerId;
  let config: Record<string, unknown> | undefined;
  try {
    const root = JSON.parse(readFileSync(modelsPath, "utf8")) as unknown;
    if (isRecord(root) && isRecord(root.providers)) {
      const providerConfig = root.providers[providerId];
      if (isRecord(providerConfig)) config = providerConfig;
    }
  } catch {
    return { name: fallbackName };
  }
  if (!config || !Array.isArray(config.models)) return { name: fallbackName };

  const registration: ProviderConfig = {};
  if (typeof config.name === "string") registration.name = config.name;
  if (typeof config.baseUrl === "string") {
    try {
      registration.baseUrl = normalizeBaseUrl(config.baseUrl);
    } catch {
      return { name: fallbackName };
    }
  }
  if (typeof config.apiKey === "string") registration.apiKey = config.apiKey;
  if (typeof config.api === "string") registration.api = config.api;
  if (typeof config.streamSimple === "function") registration.streamSimple = config.streamSimple as ProviderConfig["streamSimple"];
  if (isStringRecord(config.headers)) registration.headers = { ...config.headers };
  if (typeof config.authHeader === "boolean") registration.authHeader = config.authHeader;
  if (isRecord(config.oauth)) registration.oauth = { ...config.oauth } as ProviderConfig["oauth"];

  registration.models = config.models.filter(isRecord).flatMap((model) => {
    if (typeof model.id !== "string" || model.id.length === 0) return [];
    const normalizedMap = canonicalizeLegacyThinkingLevelMap(model.thinkingLevelMap).map;
    const input: Array<"text" | "image"> = Array.isArray(model.input)
        && model.input.every((value) => value === "text" || value === "image")
      ? [...model.input]
      : ["text"];
    const cost = isCost(model.cost)
      ? { ...model.cost }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const clone: ProviderModelConfig = {
      id: model.id,
      name: typeof model.name === "string" ? model.name : model.id,
      reasoning: typeof model.reasoning === "boolean" ? model.reasoning : false,
      input,
      cost,
      contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : 128_000,
      maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : 16_384,
    };
    if (typeof model.api === "string") clone.api = model.api;
    if (typeof model.baseUrl === "string") {
      try {
        clone.baseUrl = normalizeBaseUrl(model.baseUrl);
      } catch {
        return [];
      }
    }
    if (normalizedMap) clone.thinkingLevelMap = normalizedMap;
    if (isStringRecord(model.headers)) clone.headers = { ...model.headers };
    const compat = materializeProviderCompat(config.compat, model.compat);
    if (compat) clone.compat = compat;
    return [clone];
  });
  return registration;
}

type ChannelTarget =
  | { kind: "preset"; preset: ProviderDefaults }
  | { kind: "custom"; id: string };

interface ChannelRef {
  id: string;
  name: string;
}

interface ConfigureModelTarget {
  modelId: string | null;
  adding: boolean;
}

interface RetryManagerArgs {
  enabled?: boolean;
  maxRetries?: number;
  showOnly?: boolean;
}

interface ParsedManagerArgs {
  action?: ApiProviderAction;
  target?: ChannelTarget;
  retry?: RetryManagerArgs;
}

function parseManagerArgs(args: string): ParsedManagerArgs {
  const values = args.trim().split(/\s+/).filter(Boolean);
  const normalized = values.map((value) => value.toLowerCase());
  if (values.length === 0) return {};
  if (normalized[0] === "retry") {
    if (values.length === 1) return { action: "retry" };
    if ((normalized[1] === "show" || normalized[1] === "status") && values.length === 2) {
      return { action: "retry", retry: { showOnly: true } };
    }
    if (normalized[1] === "off" || normalized[1] === "disable" || normalized[1] === "disabled") {
      if (values.length !== 2) throw usageError();
      return { action: "retry", retry: { enabled: false } };
    }
    if (normalized[1] === "on" || normalized[1] === "enable" || normalized[1] === "enabled") {
      if (values.length > 3) throw usageError();
      return {
        action: "retry",
        retry: {
          enabled: true,
          ...(values[2] ? { maxRetries: retryCount(values[2]) } : {}),
        },
      };
    }
    throw usageError();
  }
  if (values.length === 1) {
    const action = actionFromArg(normalized[0]);
    if (action) return { action };
    const target = resolveTargetToken(values[0]);
    if (target) return { action: "configure", target };
    throw usageError();
  }
  const action = actionFromArg(normalized[0]);
  const target = resolveTargetToken(values[1]);
  if (action && target) return { action, target };
  throw usageError();
}

function resolveTargetToken(value: string): ChannelTarget | undefined {
  const normalized = value.toLowerCase();
  const preset = providerFromArg(normalized);
  if (preset) return { kind: "preset", preset };
  if (normalized === "new" || normalized === "custom" || normalized === "add-custom") {
    return { kind: "custom", id: "" };
  }
  return { kind: "custom", id: value };
}

function usageError(): Error {
  return new Error(
    "用法：/api-manager list | retry [show|on [1-10]|off] | show|set|delete|enable|disable|logout|reset [openai|qwen|anthropic|<Provider ID>|new]",
  );
}

async function chooseModelToConfigure(
  providerId: string,
  displayName: string,
  ctx: ExtensionCommandContext,
  modelsPath: string,
): Promise<ConfigureModelTarget | undefined> {
  const modelIds = await configuredModelIds(providerId, modelsPath);
  if (modelIds.length === 0) return { modelId: null, adding: true };
  const addLabel = "➕ 新增模型…";
  const choice = await ctx.ui.select(
    `选择要修改的 ${displayName} 模型`,
    [...modelIds, addLabel],
  );
  if (!choice) return undefined;
  if (choice === addLabel) return { modelId: null, adding: true };
  return { modelId: choice, adding: false };
}

async function chooseProvider(
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
): Promise<ChannelTarget | undefined> {
  const options: Array<{ label: string; target: ChannelTarget }> = [];
  for (const preset of PROVIDERS) {
    if (!await isProviderConfigured(preset.id, modelsPath)) continue;
    options.push({
      label: numberedOptionLabel(
        options.length,
        `${preset.name} · Provider ID: ${preset.id}（${await isProviderEnabled(preset.id, modelsPath) ? "启用" : "停用"}）`,
      ),
      target: { kind: "preset", preset },
    });
  }
  for (const id of managedProviderIdsSync(defaultsPath)) {
    if (findPreset(id) || !await isProviderConfigured(id, modelsPath)) continue;
    const name = await channelDisplayName(id, modelsPath);
    options.push({
      label: numberedOptionLabel(
        options.length,
        `${name} · Provider ID: ${id}（用户定义 · ${await isProviderEnabled(id, modelsPath) ? "启用" : "停用"}）`,
      ),
      target: { kind: "custom", id },
    });
  }
  if (options.length === 0) return undefined;
  const choice = await ctx.ui.select("选择 Provider（连接级操作）", options.map((entry) => entry.label));
  return options.find((entry) => entry.label === choice)?.target;
}

type GlobalModelPick =
  | { kind: "model"; providerId: string; modelId: string }
  | { kind: "new-model" };

interface GlobalModelOption {
  label: string;
  pick: GlobalModelPick;
}

/** Model picker: lists every configured model under its Provider. */
async function chooseModelGlobally(
  ctx: ExtensionCommandContext,
  action: "configure" | "show" | "delete",
  modelsPath: string,
  defaultsPath: string,
): Promise<GlobalModelPick | undefined> {
  const options = await buildGlobalModelOptions(action, modelsPath, defaultsPath);
  if (options.length === 0) {
    ctx.ui.notify("尚未配置任何模型。", "info");
    return undefined;
  }
  const title = action === "configure"
    ? "选择要修改的模型，或新增"
    : action === "show"
      ? "选择要查看的模型"
      : "选择要删除的模型";
  const choice = await ctx.ui.select(title, options.map((entry) => entry.label));
  return options.find((entry) => entry.label === choice)?.pick;
}

async function buildGlobalModelOptions(
  action: "configure" | "show" | "delete",
  modelsPath: string,
  defaultsPath: string,
): Promise<GlobalModelOption[]> {
  const root = await readModelsRoot(modelsPath);
  const providers = isRecord(root.providers) ? root.providers : {};
  const options: GlobalModelOption[] = [];
  for (const providerId of modelCentricProviderOrder(defaultsPath)) {
    const config = providers[providerId];
    if (!isRecord(config)) continue;
    const models = Array.isArray(config.models) ? config.models.filter(isRecord) : [];
    for (const model of models) {
      if (typeof model.id !== "string") continue;
      options.push({
        label: numberedOptionLabel(options.length, `${providerId} / ${model.id}`),
        pick: { kind: "model", providerId, modelId: model.id },
      });
    }
  }
  if (action !== "configure") return options;
  options.push({
    label: numberedOptionLabel(options.length, "➕ 新增模型…"),
    pick: { kind: "new-model" },
  });
  return options;
}

/** Presets first, then managed user-defined Providers; models remain a flat list. */
function modelCentricProviderOrder(defaultsPath: string): string[] {
  return [
    ...PROVIDERS.map((preset) => preset.id),
    ...managedProviderIdsSync(defaultsPath).filter((id) => !findPreset(id)),
  ];
}

/** Pick the target Provider for a new model, then open its add form. */
async function configureNewModel(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
): Promise<void> {
  const options: Array<{ label: string; target: ChannelTarget }> = [];
  for (const preset of PROVIDERS) {
    options.push({
      label: numberedOptionLabel(
        options.length,
        `${preset.name} · Provider ID: ${preset.id}`,
      ),
      target: { kind: "preset", preset },
    });
  }
  for (const id of managedProviderIdsSync(defaultsPath)) {
    if (findPreset(id) || !await isProviderConfigured(id, modelsPath)) continue;
    const name = await channelDisplayName(id, modelsPath);
    options.push({
      label: numberedOptionLabel(options.length, `${name} · Provider ID: ${id}`),
      target: { kind: "custom", id },
    });
  }
  const customInputLabel = numberedOptionLabel(options.length, "自定义 Provider ID…");
  const choice = await ctx.ui.select(
    "新增模型到哪个 Provider？",
    [...options.map((entry) => entry.label), customInputLabel],
  );
  if (choice === undefined) return;
  const target = options.find((entry) => entry.label === choice)?.target;
  if (!target && choice !== customInputLabel) return;
  if (choice === customInputLabel) {
    const idInput = await ctx.ui.input("Provider ID", "");
    if (idInput === undefined) return;
    const providerId = normalizeChannelId(idInput);
    const preset = findPreset(providerId);
    if (preset) {
      await configurePresetModelTarget(pi, preset, { modelId: null, adding: true }, ctx, modelsPath, defaultsPath);
    } else {
      await configureCustomModelTarget(pi, providerId, { modelId: null, adding: true }, ctx, modelsPath, defaultsPath);
    }
    return;
  }
  if (target!.kind === "preset") {
    await configurePresetModelTarget(pi, target!.preset, { modelId: null, adding: true }, ctx, modelsPath, defaultsPath);
    return;
  }
  await configureCustomModelTarget(pi, target!.id, { modelId: null, adding: true }, ctx, modelsPath, defaultsPath);
}

async function dispatchGlobalModelPick(
  pi: ExtensionAPI,
  pick: GlobalModelPick,
  action: "configure" | "show" | "delete",
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
  settingsPath: string,
): Promise<void> {
  if (pick.kind === "new-model") {
    await configureNewModel(pi, ctx, modelsPath, defaultsPath);
    return;
  }
  const displayName = await channelDisplayName(pick.providerId, modelsPath);
  if (action === "show") {
    await showProvider(ctx, pick.providerId, displayName, modelsPath, defaultsPath, pick.modelId);
    return;
  }
  if (action === "delete") {
    await deleteProviderModel(
      pi,
      pick.providerId,
      displayName,
      pick.modelId,
      ctx,
      modelsPath,
      defaultsPath,
      settingsPath,
    );
    return;
  }
  const preset = findPreset(pick.providerId);
  const target: ConfigureModelTarget = { modelId: pick.modelId, adding: false };
  if (preset) await configurePresetModelTarget(pi, preset, target, ctx, modelsPath, defaultsPath);
  else await configureCustomModelTarget(pi, pick.providerId, target, ctx, modelsPath, defaultsPath);
}

function numberedOptionLabel(index: number, label: string): string {
  return `${index + 1}. ${label}`;
}

async function resolveChannelRef(
  target: ChannelTarget,
  ctx: ExtensionCommandContext,
  modelsPath: string,
): Promise<ChannelRef | undefined> {
  if (target.kind === "preset") return { id: target.preset.id, name: target.preset.name };
  if (!target.id) {
    ctx.ui.notify("请指定 Provider ID。", "warning");
    return undefined;
  }
  return { id: target.id, name: await channelDisplayName(target.id, modelsPath) };
}

async function channelDisplayName(providerId: string, modelsPath: string): Promise<string> {
  const preset = findPreset(providerId);
  if (preset) return preset.name;
  const root = await readModelsRoot(modelsPath);
  const config = isRecord(root.providers) && isRecord(root.providers[providerId])
    ? root.providers[providerId]
    : undefined;
  return typeof config?.name === "string" && config.name ? config.name : providerId;
}

function normalizeChannelId(value: string): string {
  const id = required(value, "Provider ID").trim();
  if (/\s/.test(id)) throw new Error("Provider ID cannot contain whitespace");
  if (id === "__proto__" || id === "prototype" || id === "constructor") {
    throw new Error(`Provider ID ${id} is reserved`);
  }
  return id;
}

async function chooseAction(
  ctx: ExtensionCommandContext,
  settingsPath: string,
): Promise<ApiProviderAction | undefined> {
  const retry = await loadApiRetrySettings(settingsPath);
  const choices: Array<{ action: ApiProviderAction; label: string }> = [
    { action: "list", label: "查看全部模型" },
    { action: "configure", label: "新增或修改模型" },
    { action: "show", label: "查看模型详情" },
    { action: "toggle", label: "启用或停用 Provider" },
    { action: "delete", label: "删除模型" },
    {
      action: "retry",
      label: `自动重试（当前：${retry.enabled ? "开启" : "关闭"}）`,
    },
    { action: "logout", label: "注销 Provider" },
    { action: "reset", label: "重置 Provider" },
  ];
  const choice = await ctx.ui.select("选择操作", choices.map((entry) => entry.label));
  return choices.find((entry) => entry.label === choice)?.action;
}

function actionFromArg(value: string): ApiProviderAction | undefined {
  if (value === "configure" || value === "config" || value === "set" || value === "add" || value === "update") {
    return "configure";
  }
  if (value === "delete" || value === "remove") return "delete";
  if (value === "enable" || value === "on") return "enable";
  if (value === "disable" || value === "off") return "disable";
  if (value === "list" || value === "ls") return "list";
  if (value === "show" || value === "get") return "show";
  if (value === "logout") return "logout";
  if (value === "retry") return "retry";
  if (value === "reset") return "reset";
  return undefined;
}

function providerFromArg(value: string): ProviderDefaults | undefined {
  if (value === "openai" || value === "maestro-openai") {
    return providerDefaults("maestro-openai");
  }
  if (value === "qwen" || value === "maestro-qwen") {
    return providerDefaults("maestro-qwen");
  }
  if (value === "anthropic" || value === "maestro-anthropic") {
    return providerDefaults("maestro-anthropic");
  }
  return undefined;
}

async function chooseDefaultThinkingLevel(
  ctx: ExtensionCommandContext,
  api: string,
  reasoning: boolean,
  current: ApiThinkingLevel,
  maxThinking: boolean,
): Promise<ApiThinkingLevel | undefined> {
  const supported: ApiThinkingLevel[] = reasoning
    ? api === "openai-responses"
      ? ["minimal", "low", "medium", "high", "xhigh"]
      : ["off", "minimal", "low", "medium", "high", "xhigh"]
    : ["off"];
  if (reasoning && maxThinking) supported.push("max");
  const fallback = supported.includes(DEFAULT_THINKING_LEVEL)
    ? DEFAULT_THINKING_LEVEL
    : supported[0];
  const selected = supported.includes(current) ? current : fallback;
  const options = [selected, ...supported.filter((level) => level !== selected)];
  return await ctx.ui.select("默认思考强度（当前 model）", options) as ApiThinkingLevel | undefined;
}

function currentDefaultThinkingLevel(
  ctx: ExtensionCommandContext,
  modelsPath: string,
): ApiThinkingLevel {
  const manager = SettingsManager.create(ctx.cwd, dirname(modelsPath));
  return (manager.getDefaultThinkingLevel() as ApiThinkingLevel | undefined) ?? DEFAULT_THINKING_LEVEL;
}

async function saveDefaultThinkingLevel(
  ctx: ExtensionCommandContext,
  modelsPath: string,
  level: ApiThinkingLevel,
): Promise<void> {
  const manager = SettingsManager.create(ctx.cwd, dirname(modelsPath));
  const setDefaultThinkingLevel = manager.setDefaultThinkingLevel.bind(manager) as (value: ApiThinkingLevel) => void;
  setDefaultThinkingLevel(level);
  await manager.flush();
  const errors = manager.drainErrors();
  if (errors.length > 0) {
    throw new Error(`Unable to save default thinking level: ${errors.map((entry) => entry.error.message).join("; ")}`);
  }
}

async function clearDeletedDefaultModel(
  settingsPath: string,
  providerId: string,
  modelId: string,
): Promise<void> {
  if (!await fileExists(settingsPath)) return;
  await serializeMutation(settingsPath, async () => {
    const root = await readModelsRoot(settingsPath);
    if (root.defaultProvider !== providerId || root.defaultModel !== modelId) return;
    const next = { ...root };
    delete next.defaultProvider;
    delete next.defaultModel;
    await writeModelsRoot(next, settingsPath, true);
  });
}

async function saveDefaultModelAndThinking(
  ctx: ExtensionCommandContext,
  modelsPath: string,
  // User-defined Providers are not preset ids, and they save defaults through here too.
  provider: string,
  modelId: string,
  isAdding: boolean,
): Promise<void> {
  // Per-model thinking defaults are persisted separately (saveModelThinkingDefault) and
  // applied on model_select; settings.json.defaultThinkingLevel is only a global fallback,
  // so configuring a model must never overwrite it. Only a newly ADDED model becomes the
  // default model — editing an existing model leaves the current default untouched so
  // same-format siblings are not affected.
  if (!isAdding) return;
  const manager = SettingsManager.create(ctx.cwd, dirname(modelsPath));
  manager.setDefaultModelAndProvider(provider, modelId);
  await manager.flush();
  const errors = manager.drainErrors();
  if (errors.length > 0) {
    throw new Error(`Unable to save default model settings: ${errors.map((entry) => entry.error.message).join("; ")}`);
  }
}

function applyThinkingLevelToActiveModel(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  providerId: string,
  modelId: string,
  level: ThinkingLevel,
): void {
  if (ctx.model?.provider !== providerId || ctx.model.id !== modelId) return;
  setPiThinkingLevel(pi, level);
}

function setPiThinkingLevel(pi: ExtensionAPI, level: ThinkingLevel): void {
  pi.setThinkingLevel(level);
}

function modelThinkingKey(provider: string, modelId: string): string {
  return `${encodeURIComponent(provider)}/${encodeURIComponent(modelId)}`;
}

function legacyModelThinkingKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

async function loadModelThinkingDefault(
  provider: string,
  modelId: string,
  defaultsPath: string,
): Promise<ThinkingLevel | undefined> {
  const root = await readModelsRoot(defaultsPath);
  if (!isRecord(root.modelDefaults)) return undefined;
  const key = modelThinkingKey(provider, modelId);
  const legacyKey = legacyModelThinkingKey(provider, modelId);
  const value = root.modelDefaults[key] ?? root.modelDefaults[legacyKey];
  if (value === "max") return "xhigh";
  return isThinkingLevel(value) ? value : undefined;
}

async function saveModelThinkingDefault(
  provider: string,
  modelId: string,
  level: ThinkingLevel,
  defaultsPath: string,
): Promise<void> {
  await serializeMutation(defaultsPath, async () => {
    const exists = await fileExists(defaultsPath);
    const root = await readModelsRoot(defaultsPath);
    const modelDefaults = isRecord(root.modelDefaults) ? { ...root.modelDefaults } : {};
    const key = modelThinkingKey(provider, modelId);
    const legacyKey = legacyModelThinkingKey(provider, modelId);
    modelDefaults[key] = level;
    if (legacyKey !== key) delete modelDefaults[legacyKey];
    await writeModelsRoot({ ...root, version: 1, modelDefaults }, defaultsPath, exists);
  });
}

async function deleteModelThinkingDefault(
  provider: string,
  modelId: string,
  defaultsPath: string,
): Promise<void> {
  if (!await fileExists(defaultsPath)) return;
  await serializeMutation(defaultsPath, async () => {
    const root = await readModelsRoot(defaultsPath);
    const modelDefaults = isRecord(root.modelDefaults) ? { ...root.modelDefaults } : {};
    const key = modelThinkingKey(provider, modelId);
    const legacyKey = legacyModelThinkingKey(provider, modelId);
    delete modelDefaults[key];
    if (legacyKey !== key) delete modelDefaults[legacyKey];
    await writeModelsRoot({ ...root, modelDefaults }, defaultsPath, true);
  });
}

async function deleteProviderThinkingDefaults(
  provider: string,
  defaultsPath: string,
): Promise<void> {
  if (!await fileExists(defaultsPath)) return;
  await serializeMutation(defaultsPath, async () => {
    const root = await readModelsRoot(defaultsPath);
    const modelDefaults = isRecord(root.modelDefaults) ? { ...root.modelDefaults } : {};
    const prefix = `${encodeURIComponent(provider)}/`;
    for (const key of Object.keys(modelDefaults)) {
      if (key.startsWith(prefix)) delete modelDefaults[key];
    }
    await writeModelsRoot({ ...root, modelDefaults }, defaultsPath, true);
  });
}

function managedProviderIdsSync(defaultsPath: string): string[] {
  try {
    const root = JSON.parse(readFileSync(defaultsPath, "utf8")) as unknown;
    return isRecord(root) ? managedProviderIds(root) : [];
  } catch {
    return [];
  }
}

function managedProviderIds(root: Record<string, unknown>): string[] {
  const current = Array.isArray(root.managedProviders) ? root.managedProviders : [];
  const legacy = Array.isArray(root.managedChannels) ? root.managedChannels : [];
  return [...new Set([...current, ...legacy].filter((id): id is string => typeof id === "string"))];
}

function withoutLegacyManagedChannels(root: Record<string, unknown>): Record<string, unknown> {
  const next = { ...root };
  delete next.managedChannels;
  return next;
}

async function addManagedProvider(defaultsPath: string, id: string): Promise<void> {
  if (findPreset(id)) return;
  await serializeMutation(defaultsPath, async () => {
    const exists = await fileExists(defaultsPath);
    const root = await readModelsRoot(defaultsPath);
    const current = managedProviderIds(root);
    if (current.includes(id) && Array.isArray(root.managedProviders) && !("managedChannels" in root)) return;
    await writeModelsRoot({
      ...withoutLegacyManagedChannels(root),
      version: 1,
      managedProviders: current.includes(id) ? current : [...current, id],
    }, defaultsPath, exists);
  });
}

async function removeManagedProvider(defaultsPath: string, id: string): Promise<void> {
  if (!await fileExists(defaultsPath)) return;
  await serializeMutation(defaultsPath, async () => {
    const root = await readModelsRoot(defaultsPath);
    const current = managedProviderIds(root);
    if (!current.includes(id) && Array.isArray(root.managedProviders) && !("managedChannels" in root)) return;
    await writeModelsRoot({
      ...withoutLegacyManagedChannels(root),
      managedProviders: current.filter((value) => value !== id),
    }, defaultsPath, true);
  });
}

function runtimeSupportsMaxThinking(ctx: ExtensionCommandContext): boolean {
  return ctx.modelRegistry.getAll().some((model) => {
    const map = model.thinkingLevelMap as Record<string, string | null> | undefined;
    return map?.xhigh === "max" || map?.max === "max";
  });
}

function reloadProviderRegistration(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  providerId: string,
  modelsPath: string,
): void {
  ctx.modelRegistry.refresh();
  if (hasEnabledProviderSync(providerId, modelsPath)) {
    pi.registerProvider(providerId, configuredProviderRegistration(providerId, modelsPath));
  } else {
    pi.unregisterProvider(providerId);
  }
}

async function migrateLegacyProviderThinkingMaps(
  provider: string,
  modelsPath: string,
): Promise<void> {
  await serializeMutation(modelsPath, async () => {
    const exists = await fileExists(modelsPath);
    if (!exists) return;
    const root = await readModelsRoot(modelsPath);
    if (!isRecord(root.providers) || !isRecord(root.providers[provider])) return;
    const currentProvider = root.providers[provider];
    if (!Array.isArray(currentProvider.models)) return;
    let changed = false;
    const models = currentProvider.models.map((model) => {
      if (!isRecord(model)) return model;
      const normalized = canonicalizeLegacyThinkingLevelMap(model.thinkingLevelMap);
      if (!normalized.changed || !normalized.map) return model;
      changed = true;
      return { ...model, thinkingLevelMap: normalized.map };
    });
    if (!changed) return;
    const providers = {
      ...root.providers,
      [provider]: { ...currentProvider, models },
    };
    await writeModelsRoot({ ...root, providers }, modelsPath, true);
  });
}

function isEnabledProviderConfig(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && providerEnabled(value);
}

function providerEnabled(config: Record<string, unknown>): boolean {
  return config.enabled !== false;
}

async function isProviderEnabled(provider: string, modelsPath: string): Promise<boolean> {
  const root = await readModelsRoot(modelsPath);
  return isRecord(root.providers)
    && isRecord(root.providers[provider])
    && providerEnabled(root.providers[provider]);
}

async function isProviderConfigured(provider: string, modelsPath: string): Promise<boolean> {
  const root = await readModelsRoot(modelsPath);
  return isRecord(root.providers) && isRecord(root.providers[provider]);
}

async function configuredModelIds(provider: string, modelsPath: string): Promise<string[]> {
  const root = await readModelsRoot(modelsPath);
  if (!isRecord(root.providers) || !isRecord(root.providers[provider])) return [];
  const models = root.providers[provider].models;
  if (!Array.isArray(models)) return [];
  return models.filter(isRecord)
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string");
}

function authSource(value: unknown): string {
  return typeof value === "string" && value ? "models.json 已保存 key" : "未配置";
}

function notifySaved(
  ctx: ExtensionCommandContext,
  displayName: string,
  result: SaveApiProviderResult,
  suffix: string,
): void {
  const backup = result.backupPath ? `\n备份：${result.backupPath}` : "";
  ctx.ui.notify(`${displayName} ${suffix}\n配置：${result.path}${backup}`, "info");
}

function compactionPreviewLines(projectRoot: string, contextWindow: number, maxTokens: number): string[] {
  const compaction = readCompactionSettings(projectRoot).effective;
  const model = deriveCompactionThreshold({
    reserveTokens: compaction.reserveTokens,
    contextWindow,
    modelMaxTokens: maxTokens,
    soft: compaction.soft,
  });
  if (!model.usable) return ["预计硬压缩：当前模型窗口不可用"];
  const configuredThreshold = contextWindow - compaction.reserveTokens;
  const lines = [
    `预计实际硬压缩：上下文超过 ${model.thresholdTokens.toLocaleString("en-US")} Token（${(model.thresholdPercent).toFixed(0)}%）`,
  ];
  if (configuredThreshold !== model.thresholdTokens) {
    lines.push(
      `配置阈值：${configuredThreshold.toLocaleString("en-US")} Token；${providerThresholdReason(model.reason)}`,
    );
  }
  if (model.soft && model.soft.outputConstrained && model.soft.truncationPointTokens !== undefined) {
    lines.push(
      `提醒：模型输出上限使响应钳制点（${model.soft.truncationPointTokens.toLocaleString("en-US")} Token，${((model.soft.truncationPointTokens / contextWindow) * 100).toFixed(0)}%）早于硬阈值，自动剪枝已提前至截断点。`,
    );
  }
  if (model.soft && !model.soft.nudgeReachable) {
    lines.push("提醒：当前硬压缩阈值早于软提醒，软提醒不可达。");
  } else if (model.soft && !model.soft.pruneReachable) {
    lines.push("提醒：当前硬压缩阈值早于软裁剪，可能直接硬压缩。");
  }
  return lines;
}

function providerThresholdReason(reason: CompactionThresholdReason): string {
  if (reason === "configured") return "由压缩配置预留决定";
  if (reason === "ratio-floor") return "受上下文窗口 5% 安全底线下调";
  if (reason === "max-output") return "受单次最大输出保护下调";
  return "单次最大输出过大，安全预留已封顶为窗口 90%";
}

function validateModelWindow(contextWindow: number, maxTokens: number): void {
  if (maxTokens >= contextWindow) {
    throw new Error(
      `单次最大输出 maxTokens（${maxTokens.toLocaleString("en-US")}）必须小于上下文窗口 contextWindow（${contextWindow.toLocaleString("en-US")}）；否则没有空间容纳输入。`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty`);
  return trimmed;
}

function positiveInteger(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(/[\u3400-\u9fff]/.test(label)
      ? `${label} 必须是大于 0 的整数`
      : `${label} must be a positive integer`);
  }
  return parsed;
}

function retryCount(value: string | number): number {
  const parsed = positiveInteger(value, "最大重试次数");
  if (parsed > API_RETRY_MAX_RETRIES) {
    throw new Error(`最大重试次数必须在 1-${API_RETRY_MAX_RETRIES} 之间`);
  }
  return parsed;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isCost(value: unknown): value is ProviderModelConfig["cost"] {
  return isRecord(value)
    && typeof value.input === "number"
    && typeof value.output === "number"
    && typeof value.cacheRead === "number"
    && typeof value.cacheWrite === "number";
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return isCanonicalThinkingLevel(value);
}

function syncEffortStatus(
  ctx: Pick<ExtensionCommandContext, "ui"> | undefined,
  level: unknown,
): void {
  const setStatus = ctx?.ui?.setStatus;
  if (typeof setStatus === "function") {
    setStatus(EFFORT_STATUS_KEY, isThinkingLevel(level) ? level : undefined);
  }
}

function canonicalThinkingLevel(level: ApiThinkingLevel): ThinkingLevel {
  return level === "max" ? "xhigh" : level;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}
