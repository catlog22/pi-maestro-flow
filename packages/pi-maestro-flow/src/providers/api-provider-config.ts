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
import {
  EFFORT_LEVELS,
  EFFORT_STATUS_KEY,
  effortProgressBar,
  isThinkingLevel as isCanonicalThinkingLevel,
} from "../effort-display.ts";

export type ApiProviderId = "maestro-openai" | "maestro-qwen" | "maestro-anthropic";

/**
 * API protocols accepted by pi's provider contract (KnownApi). Custom channels
 * may pick any of these; the three built-in presets fix their own protocol.
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

export interface ApiProviderSettings {
  /** Provider id: a built-in preset id or any user-defined channel id. */
  provider: string;
  baseUrl: string;
  modelId: string;
  contextWindow?: number;
  reasoning: boolean;
  apiKey: string;
  maxThinking?: boolean;
  /** API protocol. Required for custom channels; presets derive it from PROVIDERS. */
  api?: string;
  /** Display name for custom channels. */
  name?: string;
  /** Provider-level compat (e.g. qwen thinking format) for custom channels. */
  compat?: Record<string, unknown>;
  /** Max output tokens for custom channels. */
  maxTokens?: number;
  /** Custom request headers for custom channels. */
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
}

type ApiProviderAction = "configure" | "delete" | "list" | "logout" | "reset" | "show";
type ApiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const DEFAULT_THINKING_LEVEL: ApiThinkingLevel = "medium";

const PROVIDERS: readonly ProviderDefaults[] = [
  {
    id: "maestro-openai",
    name: "OpenAI Responses (Custom)",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-5.4",
    contextWindow: 400_000,
    maxTokens: 128_000,
  },
  {
    id: "maestro-qwen",
    name: "Qwen Compatible (Custom)",
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
    name: "Anthropic (Custom)",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    modelId: "claude-sonnet-4-5",
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
];

const mutationQueues = new Map<string, Promise<void>>();

/**
 * Register custom OpenAI Responses, Qwen-compatible, and Anthropic providers through Pi's
 * documented models.json contract. /api-manager manages the provider config and
 * models.json API key without requiring changes to Pi itself.
 */
export function registerApiProviderConfigs(
  pi: ExtensionAPI,
  options: RegisterApiProviderOptions = {},
): void {
  const modelsPath = options.modelsPath ?? join(getAgentDir(), "models.json");
  const defaultsPath = options.defaultsPath ?? join(dirname(modelsPath), "api-manager.json");
  const configured = configuredProviderIds(modelsPath);
  if (typeof pi.registerProvider === "function") {
    for (const provider of PROVIDERS) {
      if (configured.has(provider.id)) {
        pi.registerProvider(provider.id, configuredProviderRegistration(provider.id, modelsPath));
      }
    }
    for (const id of managedChannelIdsSync(defaultsPath)) {
      if (findPreset(id) || !hasConfiguredProviderSync(id, modelsPath)) continue;
      pi.registerProvider(id, configuredProviderRegistration(id, modelsPath));
    }
  }

  if (typeof pi.registerCommand !== "function") return;
  pi.registerCommand("api-manager", {
    description: "增删查改 API 渠道（OpenAI / Qwen / Anthropic 预设 + 自定义渠道）",
    async handler(args, ctx) {
      try {
        await showApiProviderManager(pi, args, ctx, modelsPath, defaultsPath);
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
    pi.on("session_start", (_event, ctx) => {
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
  const model = models[0];
  const thinkingLevelMap = isRecord(model?.thinkingLevelMap) ? model.thinkingLevelMap : {};
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
    api: typeof config.api === "string" ? config.api : preset?.api,
    name: typeof config.name === "string" ? config.name : preset?.name,
  };
}

export async function saveApiProviderSettings(
  settings: ApiProviderSettings,
  modelsPath = join(getAgentDir(), "models.json"),
): Promise<SaveApiProviderResult> {
  const normalized: ApiProviderSettings = {
    provider: settings.provider,
    baseUrl: normalizeBaseUrl(settings.baseUrl),
    modelId: required(settings.modelId, "Model ID"),
    contextWindow: settings.contextWindow === undefined
      ? undefined
      : positiveInteger(settings.contextWindow, "Context window"),
    reasoning: settings.reasoning,
    apiKey: required(settings.apiKey ?? "", "API key config"),
    maxThinking: settings.maxThinking === true,
    api: settings.api,
    name: settings.name?.trim() || undefined,
    compat: settings.compat,
    maxTokens: settings.maxTokens === undefined
      ? undefined
      : positiveInteger(settings.maxTokens, "Max tokens"),
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
    const models = Array.isArray(config.models) ? config.models.filter(isRecord) : [];
    const remaining = models.filter((model) => model.id !== modelId);
    if (remaining.length === models.length) throw new Error(`Model ${modelId} is not configured`);
    if (remaining.length === 0) delete providers[provider];
    else providers[provider] = { ...config, models: remaining };
    result = await writeModelsRoot({ ...root, providers }, modelsPath, exists);
  });
  if (!result) throw new Error("API model settings were not deleted");
  return result;
}

export function normalizeBaseUrl(value: string): string {
  const normalized = required(value, "Base URL").replace(/\/+$/, "");
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL must use http or https");
  }
  return normalized;
}

async function showApiProviderManager(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
): Promise<void> {
  const parsed = parseManagerArgs(args);
  if (!ctx.hasUI && !parsed.action) {
    ctx.ui.notify("/api-manager 交互菜单需要交互式 Pi 会话。", "warning");
    return;
  }
  const action = parsed.action ?? await chooseAction(ctx);
  if (!action) return;
  if (action === "list") {
    await listProviders(ctx, modelsPath, defaultsPath);
    return;
  }
  const target = parsed.target ?? (ctx.hasUI ? await chooseChannel(ctx, action, modelsPath, defaultsPath) : undefined);
  if (!target) {
    ctx.ui.notify("请指定渠道：openai、qwen、anthropic 或自定义渠道 id。", "warning");
    return;
  }
  if (action === "configure") {
    if (!ctx.hasUI) {
      ctx.ui.notify("/api-manager configure 需要交互式 Pi 会话。", "warning");
      return;
    }
    if (target.kind === "preset") await configureProvider(pi, target.preset, ctx, modelsPath, defaultsPath);
    else await configureCustomChannel(pi, ctx, modelsPath, defaultsPath, target.id || undefined);
    return;
  }
  const ref = await resolveChannelRef(target, ctx, modelsPath);
  if (!ref) return;
  if (action === "show") {
    await showProvider(ctx, ref.id, ref.name, modelsPath, defaultsPath);
    return;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify(`/api-manager ${action} 需要交互式 Pi 会话。`, "warning");
    return;
  }
  if (action === "delete") {
    await deleteProvider(pi, ref.id, ref.name, ctx, modelsPath, defaultsPath);
  } else if (action === "logout") {
    await removeProviderKey(pi, ref.id, ref.name, ctx, modelsPath, defaultsPath);
  } else {
    await resetProvider(pi, ref.id, ref.name, ctx, modelsPath, defaultsPath);
  }
}

async function configureProvider(
  pi: ExtensionAPI,
  provider: ProviderDefaults,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
): Promise<void> {
  const current = await loadApiProviderSettings(provider.id, modelsPath);
  const maxThinking = current.maxThinking === true || runtimeSupportsMaxThinking(ctx);
  const baseUrlInput = await ctx.ui.input(`${provider.name} Base URL`, current.configured ? current.baseUrl : "");
  if (baseUrlInput === undefined) return;
  const baseUrl = normalizeBaseUrl(baseUrlInput);
  const modelInput = await ctx.ui.input(`${provider.name} model ID`, current.configured ? current.modelId : provider.modelId);
  if (modelInput === undefined) return;
  const modelId = required(modelInput, "Model ID");
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
    await loadModelThinkingDefault(provider.id, modelId, defaultsPath)
      ?? currentDefaultThinkingLevel(ctx, modelsPath),
    maxThinking,
  );
  if (!defaultThinkingLevel) return;

  const contextWindowInput = await ctx.ui.input(
    `${provider.name} context window（Token）`,
    String(current.contextWindow ?? provider.contextWindow),
  );
  if (contextWindowInput === undefined) return;
  const contextWindow = positiveInteger(contextWindowInput, "Context window");

  const keyInput = await ctx.ui.input(`${provider.name} API key`, "");
  if (keyInput === undefined) return;
  const apiKey = required(keyInput, "API key");

  const next: ApiProviderSettings = {
    provider: provider.id,
    baseUrl,
    modelId,
    contextWindow,
    reasoning: reasoningChoice === enabledLabel,
    apiKey,
    maxThinking,
  };
  const confirmed = await ctx.ui.confirm(
    `保存 ${provider.name} API 配置？`,
    [
      `Base URL：${next.baseUrl}`,
      `Model：${next.modelId}`,
      `Context window：${next.contextWindow?.toLocaleString("en-US")} Token`,
      `Reasoning：${next.reasoning ? "enabled" : "disabled"}`,
      `Default thinking（Pi 全局）：${defaultThinkingLevel}`,
      "Auth：stored API key",
    ].join("\n"),
  );
  if (!confirmed) return;
  const result = await saveApiProviderSettings(next, modelsPath);
  await saveModelThinkingDefault(
    provider.id,
    next.modelId,
    canonicalThinkingLevel(defaultThinkingLevel),
    defaultsPath,
  );
  await saveDefaultModelAndThinking(ctx, modelsPath, provider.id, next.modelId, defaultThinkingLevel);
  reloadProviderRegistration(pi, ctx, provider.id, modelsPath);
  applyThinkingLevelToActiveModel(pi, ctx, provider.id, next.modelId, canonicalThinkingLevel(defaultThinkingLevel));
  notifySaved(
    ctx,
    provider.name,
    result,
    `已保存；默认模型为 ${provider.id}/${next.modelId}，默认思考强度为 ${defaultThinkingLevel}`,
  );
}

async function configureCustomChannel(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
  initialId?: string,
): Promise<void> {
  const idInput = await ctx.ui.input("自定义渠道 ID（provider id）", initialId ?? "");
  if (idInput === undefined) return;
  const providerId = normalizeChannelId(idInput);
  const preset = findPreset(providerId);
  if (preset) {
    await configureProvider(pi, preset, ctx, modelsPath, defaultsPath);
    return;
  }
  const current = await loadApiProviderSettings(providerId, modelsPath);
  const apiChoice = await ctx.ui.select("API 协议", [...KNOWN_APIS]);
  if (!apiChoice) return;
  const api = apiChoice;
  const nameInput = await ctx.ui.input("渠道显示名称", current.name ?? providerId);
  if (nameInput === undefined) return;
  const displayName = nameInput.trim() || providerId;
  const baseUrlInput = await ctx.ui.input(`${displayName} Base URL`, current.configured ? current.baseUrl : "");
  if (baseUrlInput === undefined) return;
  const baseUrl = normalizeBaseUrl(baseUrlInput);
  const modelInput = await ctx.ui.input(`${displayName} model ID`, current.configured ? current.modelId : "");
  if (modelInput === undefined) return;
  const modelId = required(modelInput, "Model ID");
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
    await loadModelThinkingDefault(providerId, modelId, defaultsPath)
      ?? currentDefaultThinkingLevel(ctx, modelsPath),
    maxThinking,
  );
  if (!defaultThinkingLevel) return;
  const contextWindowInput = await ctx.ui.input(
    `${displayName} context window（Token）`,
    String(current.configured ? current.contextWindow : 128_000),
  );
  if (contextWindowInput === undefined) return;
  const contextWindow = positiveInteger(contextWindowInput, "Context window");
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
        "max tokens 字段",
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

  const next: ApiProviderSettings = {
    provider: providerId,
    baseUrl,
    modelId,
    contextWindow,
    reasoning,
    apiKey,
    maxThinking,
    api,
    name: displayName,
    compat,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    authHeader,
  };
  const confirmed = await ctx.ui.confirm(
    `保存自定义渠道 ${displayName}？`,
    [
      `Provider ID：${providerId}`,
      `API 协议：${api}`,
      `Base URL：${next.baseUrl}`,
      `Model：${next.modelId}`,
      `Context window：${next.contextWindow?.toLocaleString("en-US")} Token`,
      `Reasoning：${next.reasoning ? "enabled" : "disabled"}`,
      `Default thinking（Pi 全局）：${defaultThinkingLevel}`,
      `Compat：${compat ? JSON.stringify(compat) : "自动"}`,
      `请求头：${Object.keys(headers).length > 0 ? Object.keys(headers).join(", ") : "无"}`,
      `Authorization：${authHeader === undefined ? "自动" : authHeader ? "Bearer" : "关闭"}`,
      "Auth：stored API key",
    ].join("\n"),
  );
  if (!confirmed) return;
  const result = await saveApiProviderSettings(next, modelsPath);
  await saveModelThinkingDefault(providerId, modelId, canonicalThinkingLevel(defaultThinkingLevel), defaultsPath);
  await saveDefaultModelAndThinking(ctx, modelsPath, providerId, modelId, defaultThinkingLevel);
  await addManagedChannel(defaultsPath, providerId);
  reloadProviderRegistration(pi, ctx, providerId, modelsPath);
  applyThinkingLevelToActiveModel(pi, ctx, providerId, modelId, canonicalThinkingLevel(defaultThinkingLevel));
  notifySaved(
    ctx,
    displayName,
    result,
    `已保存自定义渠道；默认模型为 ${providerId}/${modelId}，默认思考强度为 ${defaultThinkingLevel}`,
  );
}

async function removeProviderKey(
  pi: ExtensionAPI,
  providerId: string,
  displayName: string,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
): Promise<void> {
  if (!await isProviderConfigured(providerId, modelsPath)) {
    ctx.ui.notify(`${displayName} 尚未配置，无需注销。`, "info");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    `注销 ${displayName}？`,
    "将删除该渠道的 Base URL、models 和 API key；重新新增必须显式输入独立 URL 和 API key。",
  );
  if (!confirmed) return;
  const result = await deleteApiProviderSettings(providerId, modelsPath);
  await deleteProviderThinkingDefaults(providerId, defaultsPath);
  await removeManagedChannel(defaultsPath, providerId);
  pi.unregisterProvider(providerId);
  ctx.modelRegistry.refresh();
  notifySaved(ctx, displayName, result, "已注销；连接配置和 API key 已移除");
}

async function resetProvider(
  pi: ExtensionAPI,
  providerId: string,
  displayName: string,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
): Promise<void> {
  if (!await isProviderConfigured(providerId, modelsPath)) {
    ctx.ui.notify(`${displayName} 尚未配置，无需重置。`, "info");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    `重置 ${displayName}？`,
    "将清除该渠道的连接配置、models、API key 和思考强度默认值；不会写入环境变量占位。",
  );
  if (!confirmed) return;
  const result = await deleteApiProviderSettings(providerId, modelsPath);
  await deleteProviderThinkingDefaults(providerId, defaultsPath);
  await removeManagedChannel(defaultsPath, providerId);
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
): Promise<void> {
  if (!await isProviderConfigured(providerId, modelsPath)) {
    ctx.ui.notify(`${displayName} 尚未配置，无需删除。`, "info");
    return;
  }
  const modelIds = await configuredModelIds(providerId, modelsPath);
  const modelId = modelIds.length === 1
    ? modelIds[0]
    : await ctx.ui.select(`选择要删除的 ${displayName} model`, modelIds);
  if (!modelId) return;
  const confirmed = await ctx.ui.confirm(
    `删除 ${displayName}/${modelId}？`,
    modelIds.length === 1
      ? "这是最后一个 model，渠道配置也会一并删除；其他渠道不受影响。"
      : "只删除所选 model；同渠道的其他 model 与连接配置会保留。",
  );
  if (!confirmed) return;
  const result = await deleteApiProviderModelSettings(providerId, modelId, modelsPath);
  await deleteModelThinkingDefault(providerId, modelId, defaultsPath);
  if (modelIds.length === 1) {
    await removeManagedChannel(defaultsPath, providerId);
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
): Promise<void> {
  const root = await readModelsRoot(modelsPath);
  const providers = isRecord(root.providers) ? root.providers : {};
  const presetLines = PROVIDERS.map((provider) => {
    const config = providers[provider.id];
    if (!isRecord(config)) return `- ${provider.name}：未配置`;
    const models = Array.isArray(config.models) ? config.models.filter(isRecord) : [];
    const modelIds = models.map((model) => model.id).filter((id): id is string => typeof id === "string");
    return `- ${provider.name}（${modelIds.length}）：${modelIds.join(", ")} · ${authSource(config.apiKey)}`;
  });
  const customLines = managedChannelIdsSync(defaultsPath)
    .flatMap((id) => {
      const config = providers[id];
      if (findPreset(id) || !isRecord(config)) return [];
      const models = Array.isArray(config.models) ? config.models.filter(isRecord) : [];
      const modelIds = models.map((model) => model.id).filter((mid): mid is string => typeof mid === "string");
      const name = typeof config.name === "string" && config.name ? config.name : id;
      const api = typeof config.api === "string" ? config.api : "?";
      return [`- ${name}（自定义·${api}·${modelIds.length}）：${modelIds.join(", ")} · ${authSource(config.apiKey)}`];
    });
  ctx.ui.notify([
    "API 渠道配置：",
    ...presetLines,
    ...(customLines.length > 0 ? ["自定义渠道：", ...customLines] : []),
    `Pi 全局默认思考强度：${currentDefaultThinkingLevel(ctx, modelsPath)}`,
    `文件：${modelsPath}`,
  ].join("\n"), "info");
}

async function showProvider(
  ctx: ExtensionCommandContext,
  providerId: string,
  displayName: string,
  modelsPath: string,
  defaultsPath: string,
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
  const modelLines = await Promise.all(models.map(async (model) => {
    const id = typeof model.id === "string" ? model.id : "<invalid>";
    const level = id === "<invalid>" ? undefined : await loadModelThinkingDefault(providerId, id, defaultsPath);
    return `- ${id} · reasoning=${model.reasoning === true ? "enabled" : "disabled"} · default=${level ?? "global"}`;
  }));
  const api = typeof config.api === "string" ? config.api : preset?.api ?? "?";
  ctx.ui.notify([
    displayName,
    `Provider ID：${providerId}`,
    `API 协议：${api}`,
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
  const currentModels = Array.isArray(currentProvider.models)
    ? currentProvider.models.filter(isRecord)
    : [];
  const existingIndex = currentModels.findIndex((model) => model.id === settings.modelId);
  const existingModel = existingIndex >= 0 ? currentModels[existingIndex] : {};
  const nextModel: Record<string, unknown> = {
    ...existingModel,
    id: settings.modelId,
    name: typeof existingModel.name === "string" ? existingModel.name : settings.modelId,
    reasoning: settings.reasoning,
    input: Array.isArray(existingModel.input) ? existingModel.input : ["text", "image"],
    contextWindow: settings.contextWindow
      ?? (typeof existingModel.contextWindow === "number" ? existingModel.contextWindow : defaults.contextWindow),
    maxTokens: typeof existingModel.maxTokens === "number"
      ? existingModel.maxTokens
      : defaults.maxTokens,
  };
  if (settings.reasoning) {
    const thinkingLevelMap: Record<string, string | null> = defaults.api === "anthropic-messages"
      ? { xhigh: "high" }
      : { off: null, xhigh: "xhigh" };
    if (settings.maxThinking) thinkingLevelMap.xhigh = "max";
    nextModel.thinkingLevelMap = thinkingLevelMap;
  } else {
    delete nextModel.thinkingLevelMap;
  }
  const nextProvider: Record<string, unknown> = {
    ...currentProvider,
    baseUrl: settings.baseUrl,
    api: defaults.api,
    apiKey: settings.apiKey,
    models: existingIndex >= 0
      ? currentModels.map((model, index) => index === existingIndex ? nextModel : model)
      : [...currentModels, nextModel],
  };
  if (defaults.compat) nextProvider.compat = defaults.compat;
  if (settings.name) nextProvider.name = settings.name;
  if (settings.headers && Object.keys(settings.headers).length > 0) nextProvider.headers = { ...settings.headers };
  if (settings.authHeader !== undefined) nextProvider.authHeader = settings.authHeader;
  providers[settings.provider] = nextProvider;
  const nextRoot = { ...root, providers };

  return writeModelsRoot(nextRoot, modelsPath, exists);
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

interface ChannelWriteDefaults {
  api: string;
  contextWindow: number;
  maxTokens: number;
  compat?: Record<string, unknown>;
}

/** Resolve protocol/limits for a save: presets use PROVIDERS, custom channels use explicit settings. */
function resolveWriteDefaults(settings: ApiProviderSettings): ChannelWriteDefaults {
  const preset = findPreset(settings.provider);
  if (preset) {
    return {
      api: preset.api,
      contextWindow: settings.contextWindow ?? preset.contextWindow,
      maxTokens: preset.maxTokens,
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
      .filter((provider) => isRecord(providers[provider.id]))
      .map((provider) => provider.id));
  } catch {
    return new Set();
  }
}

function hasConfiguredProviderSync(providerId: string, modelsPath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as unknown;
    return isRecord(parsed) && isRecord(parsed.providers) && isRecord(parsed.providers[providerId]);
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
  if (typeof config.baseUrl === "string") registration.baseUrl = config.baseUrl;
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
    if (typeof model.baseUrl === "string") clone.baseUrl = model.baseUrl;
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

interface ParsedManagerArgs {
  action?: ApiProviderAction;
  target?: ChannelTarget;
}

function parseManagerArgs(args: string): ParsedManagerArgs {
  const values = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (values.length === 0) return {};
  if (values.length === 1) {
    const action = actionFromArg(values[0]);
    if (action) return { action };
    const target = resolveTargetToken(values[0]);
    if (target) return { action: "configure", target };
    throw usageError();
  }
  const action = actionFromArg(values[0]);
  const target = resolveTargetToken(values[1]);
  if (action && target) return { action, target };
  throw usageError();
}

function resolveTargetToken(value: string): ChannelTarget | undefined {
  const preset = providerFromArg(value);
  if (preset) return { kind: "preset", preset };
  if (value === "new" || value === "custom" || value === "add-custom") return { kind: "custom", id: "" };
  return { kind: "custom", id: value };
}

function usageError(): Error {
  return new Error(
    "用法：/api-manager list | show|set|delete|logout|reset [openai|qwen|anthropic|<自定义渠道 id>|new]",
  );
}

async function chooseChannel(
  ctx: ExtensionCommandContext,
  action: ApiProviderAction,
  modelsPath: string,
  defaultsPath: string,
): Promise<ChannelTarget | undefined> {
  const options: Array<{ label: string; target: ChannelTarget }> = PROVIDERS.map((preset) => ({
    label: preset.name,
    target: { kind: "preset", preset },
  }));
  for (const id of managedChannelIdsSync(defaultsPath)) {
    if (findPreset(id) || !await isProviderConfigured(id, modelsPath)) continue;
    const name = await channelDisplayName(id, modelsPath);
    options.push({ label: `${name}（自定义）`, target: { kind: "custom", id } });
  }
  if (action === "configure") {
    options.push({ label: "➕ 新增自定义渠道…", target: { kind: "custom", id: "" } });
  }
  const choice = await ctx.ui.select("选择 API 渠道", options.map((entry) => entry.label));
  return options.find((entry) => entry.label === choice)?.target;
}

async function resolveChannelRef(
  target: ChannelTarget,
  ctx: ExtensionCommandContext,
  modelsPath: string,
): Promise<ChannelRef | undefined> {
  if (target.kind === "preset") return { id: target.preset.id, name: target.preset.name };
  if (!target.id) {
    ctx.ui.notify("请指定自定义渠道 id。", "warning");
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
  const id = required(value, "Channel ID").trim();
  if (/\s/.test(id)) throw new Error("Channel ID cannot contain whitespace");
  return id;
}

async function chooseAction(ctx: ExtensionCommandContext): Promise<ApiProviderAction | undefined> {
  const choices: Array<{ action: ApiProviderAction; label: string }> = [
    { action: "list", label: "查看全部渠道" },
    { action: "configure", label: "新增或修改渠道" },
    { action: "show", label: "查看单个渠道" },
    { action: "delete", label: "删除渠道配置" },
    { action: "logout", label: "注销渠道配置" },
    { action: "reset", label: "重置为未配置" },
  ];
  const choice = await ctx.ui.select("选择操作", choices.map((entry) => entry.label));
  return choices.find((entry) => entry.label === choice)?.action;
}

function actionFromArg(value: string): ApiProviderAction | undefined {
  if (value === "configure" || value === "config" || value === "set" || value === "add" || value === "update") {
    return "configure";
  }
  if (value === "delete" || value === "remove") return "delete";
  if (value === "list" || value === "ls") return "list";
  if (value === "show" || value === "get") return "show";
  if (value === "logout") return "logout";
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
  return await ctx.ui.select("默认思考强度（Pi 全局）", options) as ApiThinkingLevel | undefined;
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

async function saveDefaultModelAndThinking(
  ctx: ExtensionCommandContext,
  modelsPath: string,
  // Custom channels are not preset ids, and they save defaults through here too.
  provider: string,
  modelId: string,
  level: ApiThinkingLevel,
): Promise<void> {
  const manager = SettingsManager.create(ctx.cwd, dirname(modelsPath));
  manager.setDefaultModelAndProvider(provider, modelId);
  const setDefaultThinkingLevel = manager.setDefaultThinkingLevel.bind(manager) as (value: ApiThinkingLevel) => void;
  setDefaultThinkingLevel(level);
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
  return `${provider}/${modelId}`;
}

async function loadModelThinkingDefault(
  provider: string,
  modelId: string,
  defaultsPath: string,
): Promise<ThinkingLevel | undefined> {
  const root = await readModelsRoot(defaultsPath);
  if (!isRecord(root.modelDefaults)) return undefined;
  const value = root.modelDefaults[modelThinkingKey(provider, modelId)];
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
    modelDefaults[modelThinkingKey(provider, modelId)] = level;
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
    delete modelDefaults[modelThinkingKey(provider, modelId)];
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
    const prefix = `${provider}/`;
    for (const key of Object.keys(modelDefaults)) {
      if (key.startsWith(prefix)) delete modelDefaults[key];
    }
    await writeModelsRoot({ ...root, modelDefaults }, defaultsPath, true);
  });
}

/**
 * Custom channels created through /api-manager are tracked here so startup can
 * re-register them. Built-in presets are handled separately and never listed.
 */
function managedChannelIdsSync(defaultsPath: string): string[] {
  try {
    const root = JSON.parse(readFileSync(defaultsPath, "utf8")) as unknown;
    if (!isRecord(root) || !Array.isArray(root.managedChannels)) return [];
    return root.managedChannels.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

async function addManagedChannel(defaultsPath: string, id: string): Promise<void> {
  if (findPreset(id)) return;
  await serializeMutation(defaultsPath, async () => {
    const exists = await fileExists(defaultsPath);
    const root = await readModelsRoot(defaultsPath);
    const current = Array.isArray(root.managedChannels)
      ? root.managedChannels.filter((value): value is string => typeof value === "string")
      : [];
    if (current.includes(id)) return;
    await writeModelsRoot({ ...root, version: 1, managedChannels: [...current, id] }, defaultsPath, exists);
  });
}

async function removeManagedChannel(defaultsPath: string, id: string): Promise<void> {
  if (!await fileExists(defaultsPath)) return;
  await serializeMutation(defaultsPath, async () => {
    const root = await readModelsRoot(defaultsPath);
    const current = Array.isArray(root.managedChannels)
      ? root.managedChannels.filter((value): value is string => typeof value === "string")
      : [];
    if (!current.includes(id)) return;
    await writeModelsRoot({ ...root, managedChannels: current.filter((value) => value !== id) }, defaultsPath, true);
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
  pi.registerProvider(providerId, configuredProviderRegistration(providerId, modelsPath));
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
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
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
