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
} from "@earendil-works/pi-coding-agent";

export type ApiProviderId = "maestro-openai" | "maestro-qwen" | "maestro-anthropic";

export interface ApiProviderSettings {
  provider: ApiProviderId;
  baseUrl: string;
  modelId: string;
  reasoning: boolean;
  apiKey: string;
  maxThinking?: boolean;
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
        pi.registerProvider(provider.id, configuredProviderRegistration(provider));
      }
    }
  }

  if (typeof pi.registerCommand !== "function") return;
  pi.registerCommand("api-manager", {
    description: "增删查改 OpenAI Responses / Qwen Compatible / Anthropic API 配置",
    async handler(args, ctx) {
      try {
        await showApiProviderManager(pi, args, ctx, modelsPath, defaultsPath);
      } catch (error) {
        ctx.ui.notify(`API 配置失败：${errorMessage(error)}`, "error");
      }
    },
  });
  if (typeof pi.on === "function") {
    pi.on("model_select", async (event) => {
      const level = await loadModelThinkingDefault(event.model.provider, event.model.id, defaultsPath);
      if (level) setPiThinkingLevel(pi, level);
    });
  }
}

export async function loadApiProviderSettings(
  provider: ApiProviderId,
  modelsPath = join(getAgentDir(), "models.json"),
): Promise<LoadedApiProviderSettings> {
  const defaults = providerDefaults(provider);
  const root = await readModelsRoot(modelsPath);
  const providers = isRecord(root.providers) ? root.providers : {};
  const configured = isRecord(providers[provider]);
  const config = configured ? providers[provider] : {};
  const models = Array.isArray(config.models) ? config.models.filter(isRecord) : [];
  const model = models[0];
  const thinkingLevelMap = isRecord(model?.thinkingLevelMap) ? model.thinkingLevelMap : {};
  return {
    configured,
    provider,
    baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : defaults.baseUrl,
    modelId: typeof model?.id === "string" ? model.id : defaults.modelId,
    reasoning: typeof model?.reasoning === "boolean" ? model.reasoning : true,
    apiKey: typeof config.apiKey === "string" ? config.apiKey : "",
    maxThinking: typeof thinkingLevelMap.max === "string",
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
    reasoning: settings.reasoning,
    apiKey: required(settings.apiKey ?? "", "API key config"),
    maxThinking: settings.maxThinking === true,
  };
  let result: SaveApiProviderResult | undefined;
  await serializeMutation(modelsPath, async () => {
    result = await writeApiProviderSettings(normalized, modelsPath);
  });
  if (!result) throw new Error("API Provider settings were not written");
  return result;
}

export async function deleteApiProviderSettings(
  provider: ApiProviderId,
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
  provider: ApiProviderId,
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
    await listProviders(ctx, modelsPath);
    return;
  }
  const provider = parsed.provider ?? (ctx.hasUI ? await chooseProvider(ctx) : undefined);
  if (!provider) {
    ctx.ui.notify("请指定 provider：openai、qwen 或 anthropic。", "warning");
    return;
  }
  if (action === "show") {
    await showProvider(ctx, provider, modelsPath, defaultsPath);
    return;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify(`/api-manager ${action} 需要交互式 Pi 会话。`, "warning");
    return;
  }
  if (action === "configure") {
    await configureProvider(pi, provider, ctx, modelsPath, defaultsPath);
  } else if (action === "delete") {
    await deleteProvider(pi, provider, ctx, modelsPath, defaultsPath);
  } else if (action === "logout") {
    await removeProviderKey(pi, provider, ctx, modelsPath, defaultsPath);
  } else {
    await resetProvider(pi, provider, ctx, modelsPath, defaultsPath);
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
    provider,
    reasoningChoice === enabledLabel,
    await loadModelThinkingDefault(provider.id, modelId, defaultsPath)
      ?? currentDefaultThinkingLevel(ctx, modelsPath),
    maxThinking,
  );
  if (!defaultThinkingLevel) return;

  const keyInput = await ctx.ui.input(`${provider.name} API key`, "");
  if (keyInput === undefined) return;
  const apiKey = required(keyInput, "API key");

  const next: ApiProviderSettings = {
    provider: provider.id,
    baseUrl,
    modelId,
    reasoning: reasoningChoice === enabledLabel,
    apiKey,
    maxThinking,
  };
  const confirmed = await ctx.ui.confirm(
    `保存 ${provider.name} API 配置？`,
    [
      `Base URL：${next.baseUrl}`,
      `Model：${next.modelId}`,
      `Reasoning：${next.reasoning ? "enabled" : "disabled"}`,
      `Default thinking（Pi 全局）：${defaultThinkingLevel}`,
      "Auth：stored API key",
    ].join("\n"),
  );
  if (!confirmed) return;
  const result = await saveApiProviderSettings(next, modelsPath);
  await saveModelThinkingDefault(provider.id, next.modelId, defaultThinkingLevel, defaultsPath);
  await saveDefaultModelAndThinking(ctx, modelsPath, provider.id, next.modelId, defaultThinkingLevel);
  reloadProviderRegistration(pi, ctx, provider);
  applyThinkingLevelToActiveModel(pi, ctx, provider, next.modelId, defaultThinkingLevel);
  notifySaved(
    ctx,
    provider,
    result,
    `已保存；默认模型为 ${provider.id}/${next.modelId}，默认思考强度为 ${defaultThinkingLevel}`,
  );
}

async function removeProviderKey(
  pi: ExtensionAPI,
  provider: ProviderDefaults,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
): Promise<void> {
  if (!await isProviderConfigured(provider.id, modelsPath)) {
    ctx.ui.notify(`${provider.name} 尚未配置，无需注销。`, "info");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    `注销 ${provider.name}？`,
    "将删除该 provider 的 Base URL、models 和 API key；重新新增必须显式输入独立 URL 和 API key。",
  );
  if (!confirmed) return;
  const result = await deleteApiProviderSettings(provider.id, modelsPath);
  await deleteProviderThinkingDefaults(provider.id, defaultsPath);
  pi.unregisterProvider(provider.id);
  ctx.modelRegistry.refresh();
  notifySaved(ctx, provider, result, "已注销；连接配置和 API key 已移除");
}

async function resetProvider(
  pi: ExtensionAPI,
  provider: ProviderDefaults,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
): Promise<void> {
  if (!await isProviderConfigured(provider.id, modelsPath)) {
    ctx.ui.notify(`${provider.name} 尚未配置，无需重置。`, "info");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    `重置 ${provider.name}？`,
    "将清除该 provider 的连接配置、models、API key 和思考强度默认值；不会写入环境变量占位。",
  );
  if (!confirmed) return;
  const result = await deleteApiProviderSettings(provider.id, modelsPath);
  await deleteProviderThinkingDefaults(provider.id, defaultsPath);
  await saveDefaultThinkingLevel(ctx, modelsPath, DEFAULT_THINKING_LEVEL);
  pi.unregisterProvider(provider.id);
  ctx.modelRegistry.refresh();
  notifySaved(ctx, provider, result, `已重置为未配置；默认思考强度为 ${DEFAULT_THINKING_LEVEL}`);
}

async function deleteProvider(
  pi: ExtensionAPI,
  provider: ProviderDefaults,
  ctx: ExtensionCommandContext,
  modelsPath: string,
  defaultsPath: string,
): Promise<void> {
  if (!await isProviderConfigured(provider.id, modelsPath)) {
    ctx.ui.notify(`${provider.name} 尚未配置，无需删除。`, "info");
    return;
  }
  const modelIds = await configuredModelIds(provider.id, modelsPath);
  const modelId = modelIds.length === 1
    ? modelIds[0]
    : await ctx.ui.select(`选择要删除的 ${provider.name} model`, modelIds);
  if (!modelId) return;
  const confirmed = await ctx.ui.confirm(
    `删除 ${provider.name}/${modelId}？`,
    modelIds.length === 1
      ? "这是最后一个 model，provider 配置也会一并删除；其他 provider 不受影响。"
      : "只删除所选 model；同 provider 的其他 model 与连接配置会保留。",
  );
  if (!confirmed) return;
  const result = await deleteApiProviderModelSettings(provider.id, modelId, modelsPath);
  await deleteModelThinkingDefault(provider.id, modelId, defaultsPath);
  if (modelIds.length === 1) pi.unregisterProvider(provider.id);
  else reloadProviderRegistration(pi, ctx, provider);
  ctx.modelRegistry.refresh();
  notifySaved(ctx, provider, result, `已删除 ${modelId}；该模型已从 /model 移除`);
}

async function listProviders(ctx: ExtensionCommandContext, modelsPath: string): Promise<void> {
  const root = await readModelsRoot(modelsPath);
  const providers = isRecord(root.providers) ? root.providers : {};
  const lines = PROVIDERS.map((provider) => {
    const configured = isRecord(providers[provider.id]);
    if (!configured) return `- ${provider.name}：未配置`;
    const config = providers[provider.id];
    const models = Array.isArray(config.models) ? config.models.filter(isRecord) : [];
    const modelIds = models.map((model) => model.id).filter((id): id is string => typeof id === "string");
    return `- ${provider.name}（${modelIds.length}）：${modelIds.join(", ")} · ${authSource(config.apiKey)}`;
  });
  ctx.ui.notify([
    "API Provider 配置：",
    ...lines,
    `Pi 全局默认思考强度：${currentDefaultThinkingLevel(ctx, modelsPath)}`,
    `文件：${modelsPath}`,
  ].join("\n"), "info");
}

async function showProvider(
  ctx: ExtensionCommandContext,
  provider: ProviderDefaults,
  modelsPath: string,
  defaultsPath: string,
): Promise<void> {
  if (!await isProviderConfigured(provider.id, modelsPath)) {
    ctx.ui.notify(`${provider.name}：未配置。使用 /api-manager set ${provider.id.replace("maestro-", "")} 新增。`, "info");
    return;
  }
  const root = await readModelsRoot(modelsPath);
  const providers = isRecord(root.providers) ? root.providers : {};
  const config = isRecord(providers[provider.id]) ? providers[provider.id] : {};
  const models = Array.isArray(config.models) ? config.models.filter(isRecord) : [];
  const modelLines = await Promise.all(models.map(async (model) => {
    const id = typeof model.id === "string" ? model.id : "<invalid>";
    const level = id === "<invalid>" ? undefined : await loadModelThinkingDefault(provider.id, id, defaultsPath);
    return `- ${id} · reasoning=${model.reasoning === true ? "enabled" : "disabled"} · default=${level ?? "global"}`;
  }));
  ctx.ui.notify([
    provider.name,
    `Base URL：${typeof config.baseUrl === "string" ? config.baseUrl : provider.baseUrl}`,
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
  const defaults = providerDefaults(settings.provider);
  const exists = await fileExists(modelsPath);
  const root = await readModelsRoot(modelsPath);
  const providers = isRecord(root.providers) ? { ...root.providers } : {};
  const currentProvider = isRecord(providers[settings.provider])
    ? { ...providers[settings.provider] }
    : {};
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
    contextWindow: typeof existingModel.contextWindow === "number"
      ? existingModel.contextWindow
      : defaults.contextWindow,
    maxTokens: typeof existingModel.maxTokens === "number"
      ? existingModel.maxTokens
      : defaults.maxTokens,
  };
  if (settings.reasoning) {
    const thinkingLevelMap: Record<string, string | null> = defaults.api === "anthropic-messages"
      ? { xhigh: "high" }
      : { off: null, xhigh: "xhigh" };
    if (settings.maxThinking) thinkingLevelMap.max = "max";
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

function providerDefaults(provider: ApiProviderId): ProviderDefaults {
  const defaults = PROVIDERS.find((entry) => entry.id === provider);
  if (!defaults) throw new Error(`Unsupported API provider: ${provider}`);
  return defaults;
}

function configuredProviderIds(modelsPath: string): Set<ApiProviderId> {
  try {
    const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.providers)) return new Set();
    return new Set(PROVIDERS
      .filter((provider) => isRecord(parsed.providers[provider.id]))
      .map((provider) => provider.id));
  } catch {
    return new Set();
  }
}

function configuredProviderRegistration(
  provider: ProviderDefaults,
): { name: string } {
  return { name: provider.name };
}

function parseManagerArgs(args: string): {
  action?: ApiProviderAction;
  provider?: ProviderDefaults;
} {
  const values = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (values.length === 0) return {};
  if (values.length === 1) {
    const provider = providerFromArg(values[0]);
    if (provider) return { action: "configure", provider };
    const action = actionFromArg(values[0]);
    if (action === "list") return { action };
  }
  if (values.length === 2) {
    const action = actionFromArg(values[0]);
    const provider = providerFromArg(values[1]);
    if (action && provider) return { action, provider };
  }
  throw new Error(
    "用法：/api-manager list | show|set|delete|logout|reset [openai|qwen|anthropic]",
  );
}

async function chooseProvider(ctx: ExtensionCommandContext): Promise<ProviderDefaults | undefined> {
  const labels = PROVIDERS.map((provider) => provider.name);
  const choice = await ctx.ui.select("选择 API Provider", labels);
  return PROVIDERS.find((provider) => provider.name === choice);
}

async function chooseAction(ctx: ExtensionCommandContext): Promise<ApiProviderAction | undefined> {
  const choices: Array<{ action: ApiProviderAction; label: string }> = [
    { action: "list", label: "查看全部配置" },
    { action: "configure", label: "新增或修改配置" },
    { action: "show", label: "查看单个配置" },
    { action: "delete", label: "删除 provider 配置" },
    { action: "logout", label: "注销 provider 配置" },
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
  provider: ProviderDefaults,
  reasoning: boolean,
  current: ApiThinkingLevel,
  maxThinking: boolean,
): Promise<ApiThinkingLevel | undefined> {
  const supported: ApiThinkingLevel[] = reasoning
    ? provider.api === "openai-responses"
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
  provider: ApiProviderId,
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
  provider: ProviderDefaults,
  modelId: string,
  level: ApiThinkingLevel,
): void {
  if (ctx.model?.provider !== provider.id || ctx.model.id !== modelId) return;
  setPiThinkingLevel(pi, level);
}

function setPiThinkingLevel(pi: ExtensionAPI, level: ApiThinkingLevel): void {
  const setThinkingLevel = pi.setThinkingLevel.bind(pi) as (value: ApiThinkingLevel) => void;
  setThinkingLevel(level);
}

function modelThinkingKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

async function loadModelThinkingDefault(
  provider: string,
  modelId: string,
  defaultsPath: string,
): Promise<ApiThinkingLevel | undefined> {
  const root = await readModelsRoot(defaultsPath);
  if (!isRecord(root.modelDefaults)) return undefined;
  const value = root.modelDefaults[modelThinkingKey(provider, modelId)];
  return typeof value === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
    ? value as ApiThinkingLevel
    : undefined;
}

async function saveModelThinkingDefault(
  provider: ApiProviderId,
  modelId: string,
  level: ApiThinkingLevel,
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
  provider: ApiProviderId,
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
  provider: ApiProviderId,
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

function runtimeSupportsMaxThinking(ctx: ExtensionCommandContext): boolean {
  return ctx.modelRegistry.getAll().some((model) =>
    isRecord(model.thinkingLevelMap) && typeof model.thinkingLevelMap.max === "string"
  );
}

function reloadProviderRegistration(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  provider: ProviderDefaults,
): void {
  ctx.modelRegistry.refresh();
  pi.registerProvider(provider.id, configuredProviderRegistration(provider));
}

async function isProviderConfigured(provider: ApiProviderId, modelsPath: string): Promise<boolean> {
  const root = await readModelsRoot(modelsPath);
  return isRecord(root.providers) && isRecord(root.providers[provider]);
}

async function configuredModelIds(provider: ApiProviderId, modelsPath: string): Promise<string[]> {
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
  provider: ProviderDefaults,
  result: SaveApiProviderResult,
  suffix: string,
): void {
  const backup = result.backupPath ? `\n备份：${result.backupPath}` : "";
  ctx.ui.notify(`${provider.name} ${suffix}\n配置：${result.path}${backup}`, "info");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty`);
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
