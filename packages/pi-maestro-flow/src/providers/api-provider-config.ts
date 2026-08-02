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
  isThinkingLevel as isCanonicalThinkingLevel,
} from "../effort-display.ts";
import { readCompactionSettings } from "../compaction/compaction-settings.ts";
import { deriveCompactionThreshold, type CompactionThresholdReason } from "../compaction/compaction-threshold.ts";
import {
  showApiModelEditor,
  type ApiModelFormChoice,
  type ApiModelFormValues,
} from "../tui/api-model-editor.ts";
import { showVisionDelegationManager } from "./vision-assist.ts";

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
  /** Whether the model supports multimodal input (text + image). Derived from model.input array. */
  multimodal?: boolean;
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

export function apiFormatLabel(api: string): string {
  const name = API_FORMAT_NAMES[api];
  return name ? `${name} (${api})` : api;
}

interface LoadedApiProviderSettings extends ApiProviderSettings {
  configured: boolean;
}

export interface ProviderDefaults {
  id: ApiProviderId;
  name: string;
  api: "openai-responses" | "openai-completions" | "anthropic-messages";
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  compat?: Record<string, unknown>;
}

export interface SaveApiProviderResult {
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

export type ApiProviderAction = "configure" | "delete" | "disable" | "enable" | "list" | "logout" | "reset" | "retry" | "show" | "toggle" | "vision";
export type ApiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const DEFAULT_THINKING_LEVEL: ApiThinkingLevel = "medium";
export const API_RETRY_MAX_RETRIES = NETWORK_RETRY_POLICY.maxRetries;
const DEFAULT_API_RETRY_SETTINGS: Readonly<ApiRetrySettings> = Object.freeze({
  enabled: true,
  maxRetries: API_RETRY_MAX_RETRIES,
});

export const PROVIDERS: readonly ProviderDefaults[] = [
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

export const mutationQueues = new Map<string, Promise<void>>();

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
      const levelMap = ctx.model.thinkingLevelMap;
      const supportsMax = levelMap?.xhigh === "max" || levelMap?.max === "max";
      const supported = [...new Set([
        ...getSupportedThinkingLevels(ctx.model).filter(isThinkingLevel),
        ...(supportsMax ? ["max" as ThinkingLevel] : []),
      ])];
      const labels = new Map<string, ThinkingLevel>();
      const options = supported.map((level) => {
        const label = `${level}${level === current ? "（当前）" : ""}`;
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
      ctx.ui.notify(`思考强度已设为 ${selected}`, "info");
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
    // Missing capability metadata must default conservatively to text-only so
    // runtime routing (isMultimodalModel) and config display agree: an unknown
    // model is never assumed to accept images.
    multimodal: Array.isArray(model?.input) && model.input.includes("image"),
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
    multimodal: settings.multimodal,
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
  const action = parsed.action ?? await chooseAction(ctx, settingsPath, dirname(modelsPath));
  if (!action) return;
  if (action === "vision") {
    if (!ctx.hasUI) {
      ctx.ui.notify("/api-manager vision 需要交互式 Pi 会话；状态查看可使用 /vision status。", "warning");
      return;
    }
    await showVisionDelegationManager(ctx, dirname(modelsPath));
    return;
  }
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

export async function configurePresetModelTarget(
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
  const multimodalChoice = await ctx.ui.select(
    "多模态（视觉）支持",
    current.multimodal !== false
      ? ["启用：支持图片输入", "关闭：仅文本"]
      : ["关闭：仅文本", "启用：支持图片输入"],
  );
  if (!multimodalChoice) return;
  const multimodal = multimodalChoice.startsWith("启用");

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
      `多模态（视觉）：${multimodal ? "enabled" : "disabled"}`,
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
      multimodal,
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

export async function configureCustomModelTarget(
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
  const multimodalChoice = await ctx.ui.select(
    "多模态（视觉）支持",
    current.multimodal !== false
      ? ["启用：支持图片输入", "关闭：仅文本"]
      : ["关闭：仅文本", "启用：支持图片输入"],
  );
  if (!multimodalChoice) return;
  const multimodal = multimodalChoice.startsWith("启用");

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
      `多模态（视觉）：${multimodal ? "enabled" : "disabled"}`,
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
      multimodal,
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
      {
        id: "multimodal",
        label: "多模态（视觉）",
        kind: "toggle",
        value: current.multimodal !== false,
        help: "开启时写入 input: [text, image]；关闭时写入 input: [text]，用于视觉委托能力判断。",
      },
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
  const multimodal = formBooleanOrDefault(result.values, "multimodal", current.multimodal !== false);
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
      multimodal,
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
      multimodal,
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
      {
        id: "multimodal",
        label: "多模态（视觉）",
        kind: "toggle",
        value: current.multimodal !== false,
        help: "开启时写入 input: [text, image]；关闭时写入 input: [text]，用于视觉委托能力判断。",
      },
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
  const multimodal = formBooleanOrDefault(result.values, "multimodal", current.multimodal !== false);
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
        multimodal,
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
      multimodal,
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
  multimodal: boolean;
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
    `多模态（视觉）：${input.multimodal ? "enabled" : "disabled"}`,
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

function formBooleanOrDefault(values: ApiModelFormValues, id: string, fallback: boolean): boolean {
  const value = values[id];
  return typeof value === "boolean" ? value : fallback;
}

function formThinkingLevel(values: ApiModelFormValues, id: string): ApiThinkingLevel {
  const value = formText(values, id);
  if (!isThinkingLevel(value)) throw new Error(`思考强度 ${value} 无效`);
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

export * from "./api-provider-ops.ts";
import {
  addManagedProvider,
  applyThinkingLevelToActiveModel,
  canonicalThinkingLevel,
  channelDisplayName,
  chooseAction,
  chooseDefaultThinkingLevel,
  chooseModelGlobally,
  chooseModelToConfigure,
  chooseProvider,
  compactionPreviewLines,
  configuredModelIds,
  configuredProviderIds,
  configuredProviderRegistration,
  currentDefaultThinkingLevel,
  deleteProvider,
  dispatchGlobalModelPick,
  errorMessage,
  fileExists,
  findPreset,
  hasEnabledProviderSync,
  isPositiveInteger,
  isProviderConfigured,
  isProviderEnabled,
  isRecord,
  isStringRecord,
  isThinkingLevel,
  listProviders,
  loadModelThinkingDefault,
  managedProviderIdsSync,
  migrateLegacyProviderThinkingMaps,
  normalizeChannelId,
  notifySaved,
  parseManagerArgs,
  positiveInteger,
  readModelsRoot,
  reloadProviderRegistration,
  removeProviderKey,
  required,
  resetProvider,
  resolveChannelRef,
  retryCount,
  runtimeSupportsMaxThinking,
  saveDefaultModelAndThinking,
  saveModelThinkingDefault,
  serializeMutation,
  setPiThinkingLevel,
  showProvider,
  syncEffortStatus,
  toggleProvider,
  validateModelWindow,
  writeApiProviderSettings,
  writeModelsRoot,
} from "./api-provider-ops.ts";
import type { ConfigureModelTarget, RetryManagerArgs } from "./api-provider-ops.ts";

