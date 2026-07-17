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

export type ApiProviderId = "maestro-openai" | "maestro-anthropic";

export interface ApiProviderSettings {
  provider: ApiProviderId;
  baseUrl: string;
  modelId: string;
  reasoning: boolean;
  apiKey?: string;
  maxThinking?: boolean;
}

interface ProviderDefaults {
  id: ApiProviderId;
  name: string;
  api: "openai-responses" | "anthropic-messages";
  apiKey: string;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
}

interface SaveApiProviderResult {
  path: string;
  backupPath?: string;
}

export interface RegisterApiProviderOptions {
  modelsPath?: string;
}

type ApiProviderAction = "configure" | "delete" | "list" | "logout" | "reset" | "show";
type ApiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const DEFAULT_THINKING_LEVEL: ApiThinkingLevel = "medium";

const PROVIDERS: readonly ProviderDefaults[] = [
  {
    id: "maestro-openai",
    name: "OpenAI Responses (Custom)",
    api: "openai-responses",
    apiKey: "$OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-5.4",
    contextWindow: 400_000,
    maxTokens: 128_000,
  },
  {
    id: "maestro-anthropic",
    name: "Anthropic (Custom)",
    api: "anthropic-messages",
    apiKey: "$ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com",
    modelId: "claude-sonnet-4-5",
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
];

const mutationQueues = new Map<string, Promise<void>>();

/**
 * Register custom OpenAI Responses and Anthropic providers through Pi's
 * documented models.json contract. /api-manager manages the provider config and
 * models.json API key without requiring changes to Pi itself.
 */
export function registerApiProviderConfigs(
  pi: ExtensionAPI,
  options: RegisterApiProviderOptions = {},
): void {
  const modelsPath = options.modelsPath ?? join(getAgentDir(), "models.json");
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
    description: "增删查改 OpenAI Responses / Anthropic API 配置",
    async handler(args, ctx) {
      try {
        await showApiProviderManager(pi, args, ctx, modelsPath);
      } catch (error) {
        ctx.ui.notify(`API 配置失败：${errorMessage(error)}`, "error");
      }
    },
  });
}

export async function loadApiProviderSettings(
  provider: ApiProviderId,
  modelsPath = join(getAgentDir(), "models.json"),
): Promise<ApiProviderSettings> {
  const defaults = providerDefaults(provider);
  const root = await readModelsRoot(modelsPath);
  const providers = isRecord(root.providers) ? root.providers : {};
  const config = isRecord(providers[provider]) ? providers[provider] : {};
  const models = Array.isArray(config.models) ? config.models.filter(isRecord) : [];
  const model = models[0];
  const thinkingLevelMap = isRecord(model?.thinkingLevelMap) ? model.thinkingLevelMap : {};
  return {
    provider,
    baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : defaults.baseUrl,
    modelId: typeof model?.id === "string" ? model.id : defaults.modelId,
    reasoning: typeof model?.reasoning === "boolean" ? model.reasoning : true,
    apiKey: typeof config.apiKey === "string" ? config.apiKey : defaults.apiKey,
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
    apiKey: settings.apiKey === undefined
      ? providerDefaults(settings.provider).apiKey
      : required(settings.apiKey, "API key config"),
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
    ctx.ui.notify("请指定 provider：openai 或 anthropic。", "warning");
    return;
  }
  if (action === "show") {
    await showProvider(ctx, provider, modelsPath);
    return;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify(`/api-manager ${action} 需要交互式 Pi 会话。`, "warning");
    return;
  }
  if (action === "configure") {
    await configureProvider(pi, provider, ctx, modelsPath);
  } else if (action === "delete") {
    await deleteProvider(pi, provider, ctx, modelsPath);
  } else if (action === "logout") {
    await removeProviderKey(pi, provider, ctx, modelsPath);
  } else {
    await resetProvider(pi, provider, ctx, modelsPath);
  }
}

async function configureProvider(
  pi: ExtensionAPI,
  provider: ProviderDefaults,
  ctx: ExtensionCommandContext,
  modelsPath: string,
): Promise<void> {
  const current = await loadApiProviderSettings(provider.id, modelsPath);
  const maxThinking = current.maxThinking === true || runtimeSupportsMaxThinking(ctx);
  const baseUrlInput = await ctx.ui.input(`${provider.name} Base URL`, current.baseUrl);
  if (baseUrlInput === undefined) return;
  const modelInput = await ctx.ui.input(`${provider.name} model ID`, current.modelId);
  if (modelInput === undefined) return;
  const maxSuffix = maxThinking ? " / max" : "";
  const enabledLabel = provider.id === "maestro-openai"
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
    currentDefaultThinkingLevel(ctx, modelsPath),
    maxThinking,
  );
  if (!defaultThinkingLevel) return;

  const useEnvironmentLabel = `使用环境变量 ${provider.apiKey}`;
  const enterKeyLabel = hasLiteralApiKey(current.apiKey, provider.apiKey)
    ? "更新 API key"
    : "输入 API key";
  const keepKeyLabel = "保留当前 API key";
  const keyOptions = hasLiteralApiKey(current.apiKey, provider.apiKey)
    ? [keepKeyLabel, enterKeyLabel, useEnvironmentLabel]
    : [enterKeyLabel, useEnvironmentLabel];
  const keyChoice = await ctx.ui.select("认证方式", keyOptions);
  if (!keyChoice) return;
  let apiKey = current.apiKey ?? provider.apiKey;
  if (keyChoice === enterKeyLabel) {
    const keyInput = await ctx.ui.input(`${provider.name} API key`, "输入后将写入 models.json");
    if (keyInput === undefined) return;
    apiKey = required(keyInput, "API key");
  } else if (keyChoice === useEnvironmentLabel) {
    apiKey = provider.apiKey;
  }

  const next: ApiProviderSettings = {
    provider: provider.id,
    baseUrl: normalizeBaseUrl(baseUrlInput.trim() || current.baseUrl),
    modelId: required(modelInput.trim() || current.modelId, "Model ID"),
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
      `Auth：${apiKey === provider.apiKey ? provider.apiKey : "stored API key"}`,
    ].join("\n"),
  );
  if (!confirmed) return;
  const result = await saveApiProviderSettings(next, modelsPath);
  await saveDefaultThinkingLevel(ctx, modelsPath, defaultThinkingLevel);
  reloadProviderRegistration(pi, ctx, provider);
  applyThinkingLevelToActiveProvider(pi, ctx, provider, defaultThinkingLevel);
  notifySaved(
    ctx,
    provider,
    result,
    `已保存；默认思考强度为 ${defaultThinkingLevel}，打开 /model 即可选择模型`,
  );
}

async function removeProviderKey(
  pi: ExtensionAPI,
  provider: ProviderDefaults,
  ctx: ExtensionCommandContext,
  modelsPath: string,
): Promise<void> {
  const current = await loadApiProviderSettings(provider.id, modelsPath);
  const confirmed = await ctx.ui.confirm(
    `移除 ${provider.name} API key？`,
    `将恢复为环境变量 ${provider.apiKey}；Base URL 和模型配置会保留。`,
  );
  if (!confirmed) return;
  const result = await saveApiProviderSettings({ ...current, apiKey: provider.apiKey }, modelsPath);
  reloadProviderRegistration(pi, ctx, provider);
  notifySaved(ctx, provider, result, `已移除已保存 key；现在使用 ${provider.apiKey}`);
}

async function resetProvider(
  pi: ExtensionAPI,
  provider: ProviderDefaults,
  ctx: ExtensionCommandContext,
  modelsPath: string,
): Promise<void> {
  const confirmed = await ctx.ui.confirm(
    `恢复 ${provider.name} 默认配置？`,
    "Base URL、model、推理能力和 API key 配置都会恢复默认值。",
  );
  if (!confirmed) return;
  const result = await saveApiProviderSettings({
    provider: provider.id,
    baseUrl: provider.baseUrl,
    modelId: provider.modelId,
    reasoning: true,
    apiKey: provider.apiKey,
    maxThinking: runtimeSupportsMaxThinking(ctx),
  }, modelsPath);
  await saveDefaultThinkingLevel(ctx, modelsPath, DEFAULT_THINKING_LEVEL);
  reloadProviderRegistration(pi, ctx, provider);
  applyThinkingLevelToActiveProvider(pi, ctx, provider, DEFAULT_THINKING_LEVEL);
  notifySaved(ctx, provider, result, `已恢复默认配置；默认思考强度为 ${DEFAULT_THINKING_LEVEL}`);
}

async function deleteProvider(
  pi: ExtensionAPI,
  provider: ProviderDefaults,
  ctx: ExtensionCommandContext,
  modelsPath: string,
): Promise<void> {
  if (!await isProviderConfigured(provider.id, modelsPath)) {
    ctx.ui.notify(`${provider.name} 尚未配置，无需删除。`, "info");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    `删除 ${provider.name}？`,
    "将从 models.json 删除该 provider 的 URL、model、推理能力和 API key；其他 provider 不受影响。",
  );
  if (!confirmed) return;
  const result = await deleteApiProviderSettings(provider.id, modelsPath);
  pi.unregisterProvider(provider.id);
  ctx.modelRegistry.refresh();
  notifySaved(ctx, provider, result, "已删除；该模型已从 /model 移除");
}

async function listProviders(ctx: ExtensionCommandContext, modelsPath: string): Promise<void> {
  const root = await readModelsRoot(modelsPath);
  const providers = isRecord(root.providers) ? root.providers : {};
  const lines = PROVIDERS.map((provider) => {
    const configured = isRecord(providers[provider.id]);
    if (!configured) return `- ${provider.name}：未配置`;
    const config = providers[provider.id];
    const models = Array.isArray(config.models) ? config.models.filter(isRecord) : [];
    const modelId = typeof models[0]?.id === "string" ? models[0].id : provider.modelId;
    return `- ${provider.name}：${modelId} · ${authSource(config.apiKey, provider)}`;
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
): Promise<void> {
  if (!await isProviderConfigured(provider.id, modelsPath)) {
    ctx.ui.notify(`${provider.name}：未配置。使用 /api-manager set ${provider.id.replace("maestro-", "")} 新增。`, "info");
    return;
  }
  const settings = await loadApiProviderSettings(provider.id, modelsPath);
  ctx.ui.notify([
    provider.name,
    `Base URL：${settings.baseUrl}`,
    `Model：${settings.modelId}`,
    `Reasoning：${settings.reasoning ? "enabled" : "disabled"}`,
    `Default thinking（Pi 全局）：${currentDefaultThinkingLevel(ctx, modelsPath)}`,
    `Auth：${authSource(settings.apiKey, provider)}`,
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
  const existingModel = currentModels.find((model) => model.id === settings.modelId) ?? {};
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
    const thinkingLevelMap: Record<string, string | null> = settings.provider === "maestro-openai"
      ? { off: null, xhigh: "xhigh" }
      : { xhigh: "high" };
    if (settings.maxThinking) thinkingLevelMap.max = "max";
    nextModel.thinkingLevelMap = thinkingLevelMap;
  } else {
    delete nextModel.thinkingLevelMap;
  }
  providers[settings.provider] = {
    ...currentProvider,
    baseUrl: settings.baseUrl,
    api: defaults.api,
    apiKey: settings.apiKey ?? defaults.apiKey,
    models: [nextModel],
  };
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
    "用法：/api-manager list | show|set|delete|logout|reset [openai|anthropic]",
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
    { action: "logout", label: "移除保存的 API key" },
    { action: "reset", label: "恢复默认配置" },
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
  if (value === "anthropic" || value === "maestro-anthropic") {
    return providerDefaults("maestro-anthropic");
  }
  return undefined;
}

function hasLiteralApiKey(value: string | undefined, defaultEnvironmentKey: string): boolean {
  return Boolean(value && value !== defaultEnvironmentKey);
}

async function chooseDefaultThinkingLevel(
  ctx: ExtensionCommandContext,
  provider: ProviderDefaults,
  reasoning: boolean,
  current: ApiThinkingLevel,
  maxThinking: boolean,
): Promise<ApiThinkingLevel | undefined> {
  const supported: ApiThinkingLevel[] = reasoning
    ? provider.id === "maestro-openai"
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

function applyThinkingLevelToActiveProvider(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  provider: ProviderDefaults,
  level: ApiThinkingLevel,
): void {
  if (ctx.model?.provider !== provider.id) return;
  const setThinkingLevel = pi.setThinkingLevel.bind(pi) as (value: ApiThinkingLevel) => void;
  setThinkingLevel(level);
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

function authSource(value: unknown, provider: ProviderDefaults): string {
  if (value === provider.apiKey) {
    const environmentName = provider.apiKey.slice(1);
    return `${provider.apiKey}（${process.env[environmentName] ? "已设置" : "未设置"}）`;
  }
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
