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

import {
  API_RETRY_MAX_RETRIES,
  apiFormatLabel,
  DEFAULT_THINKING_LEVEL,
  deleteApiProviderModelSettings,
  deleteApiProviderSettings,
  loadApiRetrySettings,
  mutationQueues,
  normalizeBaseUrl,
  PROVIDERS,
  setApiProviderEnabled,
  configurePresetModelTarget,
  configureCustomModelTarget,
} from "./api-provider-config.ts";
import type { ApiProviderAction, ApiProviderId, ApiProviderSettings, ApiThinkingLevel, ProviderDefaults, SaveApiProviderResult } from "./api-provider-config.ts";
import { loadVisionDelegationConfig } from "./vision-assist.ts";


export async function removeProviderKey(
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

export async function toggleProvider(
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

export async function resetProvider(
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

export async function deleteProvider(
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

export async function deleteProviderModel(
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

export async function listProviders(
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

export async function appendListLines(
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
      `vision=${Array.isArray(model.input) && model.input.includes("image") ? "on" : "off"}`,
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

export async function showProvider(
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
      `多模态（视觉）：${Array.isArray(model.input) && model.input.includes("image") ? "enabled" : "disabled"}`,
      `Default thinking：${level ?? "global"}`,
      `Auth：${authSource(config.apiKey)}`,
      `文件：${modelsPath}`,
    ].join("\n"), "info");
    return;
  }
  const modelLines = await Promise.all(models.map(async (model) => {
    const id = typeof model.id === "string" ? model.id : "<invalid>";
    const level = id === "<invalid>" ? undefined : await loadModelThinkingDefault(providerId, id, defaultsPath);
    return `- ${id} · reasoning=${model.reasoning === true ? "enabled" : "disabled"} · vision=${Array.isArray(model.input) && model.input.includes("image") ? "on" : "off"} · default=${level ?? "global"}`;
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

export async function writeApiProviderSettings(
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
  const input = settings.multimodal === undefined
    ? Array.isArray(existingModel.input)
        && existingModel.input.every((value) => value === "text" || value === "image")
      ? [...existingModel.input]
      // Unknown capability defaults conservatively to text-only, matching
      // runtime isMultimodalModel and the registration path.
      : ["text"]
    : settings.multimodal
      ? ["text", "image"]
      : ["text"];
  const nextModel: Record<string, unknown> = {
    ...existingModel,
    id: settings.modelId,
    name: typeof existingModel.name === "string" ? existingModel.name : settings.modelId,
    reasoning: settings.reasoning,
    input,
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

export async function writeModelsRoot(
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

export async function readModelsRoot(modelsPath: string): Promise<Record<string, unknown>> {
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

export async function serializeMutation(path: string, mutate: () => Promise<void>): Promise<void> {
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

export function findPreset(provider: string): ProviderDefaults | undefined {
  return PROVIDERS.find((entry) => entry.id === provider);
}

export function providerDefaults(provider: ApiProviderId): ProviderDefaults {
  const defaults = findPreset(provider);
  if (!defaults) throw new Error(`Unsupported API provider: ${provider}`);
  return defaults;
}

export interface ProviderWriteDefaults {
  api: string;
  contextWindow: number;
  maxTokens: number;
  compat?: Record<string, unknown>;
}

/** Resolve protocol/limits for a save: presets use PROVIDERS, user-defined Providers use explicit settings. */
export function resolveWriteDefaults(settings: ApiProviderSettings): ProviderWriteDefaults {
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

export function configuredProviderIds(modelsPath: string): Set<ApiProviderId> {
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

export function hasEnabledProviderSync(providerId: string, modelsPath: string): boolean {
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

export function configuredProviderRegistration(
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

export type ChannelTarget =
  | { kind: "preset"; preset: ProviderDefaults }
  | { kind: "custom"; id: string };

export interface ChannelRef {
  id: string;
  name: string;
}

export interface ConfigureModelTarget {
  modelId: string | null;
  adding: boolean;
}

export interface RetryManagerArgs {
  enabled?: boolean;
  maxRetries?: number;
  showOnly?: boolean;
}

export interface ParsedManagerArgs {
  action?: ApiProviderAction;
  target?: ChannelTarget;
  retry?: RetryManagerArgs;
}

export function parseManagerArgs(args: string): ParsedManagerArgs {
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

export function resolveTargetToken(value: string): ChannelTarget | undefined {
  const normalized = value.toLowerCase();
  const preset = providerFromArg(normalized);
  if (preset) return { kind: "preset", preset };
  if (normalized === "new" || normalized === "custom" || normalized === "add-custom") {
    return { kind: "custom", id: "" };
  }
  return { kind: "custom", id: value };
}

export function usageError(): Error {
  return new Error(
    "用法：/api-manager list | retry [show|on [1-10]|off] | show|set|delete|enable|disable|logout|reset [openai|qwen|anthropic|<Provider ID>|new]",
  );
}

export async function chooseModelToConfigure(
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

export async function chooseProvider(
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

export type GlobalModelPick =
  | { kind: "model"; providerId: string; modelId: string }
  | { kind: "new-model" };

export interface GlobalModelOption {
  label: string;
  pick: GlobalModelPick;
}

/** Model picker: lists every configured model under its Provider. */
export async function chooseModelGlobally(
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

export async function buildGlobalModelOptions(
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
export function modelCentricProviderOrder(defaultsPath: string): string[] {
  return [
    ...PROVIDERS.map((preset) => preset.id),
    ...managedProviderIdsSync(defaultsPath).filter((id) => !findPreset(id)),
  ];
}

/** Pick the target Provider for a new model, then open its add form. */
export async function configureNewModel(
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

export async function dispatchGlobalModelPick(
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

export function numberedOptionLabel(index: number, label: string): string {
  return `${index + 1}. ${label}`;
}

export async function resolveChannelRef(
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

export async function channelDisplayName(providerId: string, modelsPath: string): Promise<string> {
  const preset = findPreset(providerId);
  if (preset) return preset.name;
  const root = await readModelsRoot(modelsPath);
  const config = isRecord(root.providers) && isRecord(root.providers[providerId])
    ? root.providers[providerId]
    : undefined;
  return typeof config?.name === "string" && config.name ? config.name : providerId;
}

export function normalizeChannelId(value: string): string {
  const id = required(value, "Provider ID").trim();
  if (/\s/.test(id)) throw new Error("Provider ID cannot contain whitespace");
  if (id === "__proto__" || id === "prototype" || id === "constructor") {
    throw new Error(`Provider ID ${id} is reserved`);
  }
  return id;
}

export async function chooseAction(
  ctx: ExtensionCommandContext,
  settingsPath: string,
  visionAgentDir = dirname(settingsPath),
): Promise<ApiProviderAction | undefined> {
  const retry = await loadApiRetrySettings(settingsPath);
  const vision = loadVisionDelegationConfig(visionAgentDir);
  const choices: Array<{ action: ApiProviderAction; label: string }> = [
    { action: "list", label: "查看全部模型" },
    { action: "configure", label: "新增或修改模型" },
    { action: "show", label: "查看模型详情" },
    { action: "vision", label: `Vision 多模态策略（当前：${vision.enabled ? "开启" : "关闭"}）` },
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

export function actionFromArg(value: string): ApiProviderAction | undefined {
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
  if (value === "vision") return "vision";
  if (value === "reset") return "reset";
  return undefined;
}

export function providerFromArg(value: string): ProviderDefaults | undefined {
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

export async function chooseDefaultThinkingLevel(
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

export function currentDefaultThinkingLevel(
  ctx: ExtensionCommandContext,
  modelsPath: string,
): ApiThinkingLevel {
  const manager = SettingsManager.create(ctx.cwd, dirname(modelsPath));
  return (manager.getDefaultThinkingLevel() as ApiThinkingLevel | undefined) ?? DEFAULT_THINKING_LEVEL;
}

export async function saveDefaultThinkingLevel(
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

export async function clearDeletedDefaultModel(
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

export async function saveDefaultModelAndThinking(
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

export function applyThinkingLevelToActiveModel(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  providerId: string,
  modelId: string,
  level: ThinkingLevel,
): void {
  if (ctx.model?.provider !== providerId || ctx.model.id !== modelId) return;
  setPiThinkingLevel(pi, level);
}

export function setPiThinkingLevel(pi: ExtensionAPI, level: ThinkingLevel): void {
  pi.setThinkingLevel(level);
}

export function modelThinkingKey(provider: string, modelId: string): string {
  return `${encodeURIComponent(provider)}/${encodeURIComponent(modelId)}`;
}

export function legacyModelThinkingKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

export async function loadModelThinkingDefault(
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

export async function saveModelThinkingDefault(
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

export async function deleteModelThinkingDefault(
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

export async function deleteProviderThinkingDefaults(
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

export function managedProviderIdsSync(defaultsPath: string): string[] {
  try {
    const root = JSON.parse(readFileSync(defaultsPath, "utf8")) as unknown;
    return isRecord(root) ? managedProviderIds(root) : [];
  } catch {
    return [];
  }
}

export function managedProviderIds(root: Record<string, unknown>): string[] {
  const current = Array.isArray(root.managedProviders) ? root.managedProviders : [];
  const legacy = Array.isArray(root.managedChannels) ? root.managedChannels : [];
  return [...new Set([...current, ...legacy].filter((id): id is string => typeof id === "string"))];
}

export function withoutLegacyManagedChannels(root: Record<string, unknown>): Record<string, unknown> {
  const next = { ...root };
  delete next.managedChannels;
  return next;
}

export async function addManagedProvider(defaultsPath: string, id: string): Promise<void> {
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

export async function removeManagedProvider(defaultsPath: string, id: string): Promise<void> {
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

export function runtimeSupportsMaxThinking(ctx: ExtensionCommandContext): boolean {
  return ctx.modelRegistry.getAll().some((model) => {
    const map = model.thinkingLevelMap as Record<string, string | null> | undefined;
    return map?.xhigh === "max" || map?.max === "max";
  });
}

export function reloadProviderRegistration(
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

export async function migrateLegacyProviderThinkingMaps(
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

export function isEnabledProviderConfig(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && providerEnabled(value);
}

export function providerEnabled(config: Record<string, unknown>): boolean {
  return config.enabled !== false;
}

export async function isProviderEnabled(provider: string, modelsPath: string): Promise<boolean> {
  const root = await readModelsRoot(modelsPath);
  return isRecord(root.providers)
    && isRecord(root.providers[provider])
    && providerEnabled(root.providers[provider]);
}

export async function isProviderConfigured(provider: string, modelsPath: string): Promise<boolean> {
  const root = await readModelsRoot(modelsPath);
  return isRecord(root.providers) && isRecord(root.providers[provider]);
}

export async function configuredModelIds(provider: string, modelsPath: string): Promise<string[]> {
  const root = await readModelsRoot(modelsPath);
  if (!isRecord(root.providers) || !isRecord(root.providers[provider])) return [];
  const models = root.providers[provider].models;
  if (!Array.isArray(models)) return [];
  return models.filter(isRecord)
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string");
}

export function authSource(value: unknown): string {
  return typeof value === "string" && value ? "models.json 已保存 key" : "未配置";
}

export function notifySaved(
  ctx: ExtensionCommandContext,
  displayName: string,
  result: SaveApiProviderResult,
  suffix: string,
): void {
  const backup = result.backupPath ? `\n备份：${result.backupPath}` : "";
  ctx.ui.notify(`${displayName} ${suffix}\n配置：${result.path}${backup}`, "info");
}

export function compactionPreviewLines(projectRoot: string, contextWindow: number, maxTokens: number): string[] {
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

export function providerThresholdReason(reason: CompactionThresholdReason): string {
  if (reason === "configured") return "由压缩配置预留决定";
  if (reason === "ratio-floor") return "受上下文窗口 5% 安全底线下调";
  if (reason === "max-output") return "受单次最大输出保护下调";
  return "单次最大输出过大，安全预留已封顶为窗口 90%";
}

export function validateModelWindow(contextWindow: number, maxTokens: number): void {
  if (maxTokens >= contextWindow) {
    throw new Error(
      `单次最大输出 maxTokens（${maxTokens.toLocaleString("en-US")}）必须小于上下文窗口 contextWindow（${contextWindow.toLocaleString("en-US")}）；否则没有空间容纳输入。`,
    );
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty`);
  return trimmed;
}

export function positiveInteger(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(/[\u3400-\u9fff]/.test(label)
      ? `${label} 必须是大于 0 的整数`
      : `${label} must be a positive integer`);
  }
  return parsed;
}

export function retryCount(value: string | number): number {
  const parsed = positiveInteger(value, "最大重试次数");
  if (parsed > API_RETRY_MAX_RETRIES) {
    throw new Error(`最大重试次数必须在 1-${API_RETRY_MAX_RETRIES} 之间`);
  }
  return parsed;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

export function isCost(value: unknown): value is ProviderModelConfig["cost"] {
  return isRecord(value)
    && typeof value.input === "number"
    && typeof value.output === "number"
    && typeof value.cacheRead === "number"
    && typeof value.cacheWrite === "number";
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return isCanonicalThinkingLevel(value);
}

export function syncEffortStatus(
  ctx: Pick<ExtensionCommandContext, "ui"> | undefined,
  level: unknown,
): void {
  const setStatus = ctx?.ui?.setStatus;
  if (typeof setStatus === "function") {
    setStatus(EFFORT_STATUS_KEY, isThinkingLevel(level) ? level : undefined);
  }
}

export function canonicalThinkingLevel(level: ApiThinkingLevel): ThinkingLevel {
  return level === "max" ? "xhigh" : level;
}

export function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

