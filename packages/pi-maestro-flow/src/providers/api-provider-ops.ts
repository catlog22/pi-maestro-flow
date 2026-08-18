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
import { fsyncDirectory } from "../settings/durable-write.ts";
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
import { lockSettingsResource } from "../settings/resource-lock.ts";
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
import { lookupBuiltinPricing } from "./cost-backfill.ts";
import { loadVisionDelegationConfig } from "./vision-assist.ts";
import { getTuiLocale } from "../tui/locale.ts";
import {
  isCacheRetention,
  isOpenAIFormatApi,
  isPromptCachePolicy,
  loadAgentCacheRetention,
  loadPromptCachePolicy,
  loadPromptCachePolicySync,
  promptCacheCompatFlags,
  type CacheRetention,
  type PromptCachePolicy,
} from "./prompt-cache-policy.ts";

const OPS_CATALOGS = {
  en: {
    "value.on": "On",
    "value.off": "Off",
    "menu.title": "Choose an action",
    "menu.list": "View all models",
    "menu.configure": "Add or edit a model",
    "menu.show": "View model details",
    "menu.vision": "Vision multimodal policy (current: {state})",
    "menu.effort": "Adjust thinking effort",
    "menu.toggle": "Enable or disable a Provider",
    "menu.delete": "Delete a model",
    "menu.retry": "Automatic retry (current: {state})",
    "menu.cache": "Prompt cache policy (current: {value})",
    "menu.cacheAgent": "Agent cache tier (current: {value})",
    "menu.price": "Backfill model pricing (built-in table + OpenRouter)",
    "menu.logout": "Sign out a Provider",
    "menu.reset": "Reset a Provider",
    "menu.export": "Export API configuration to a file",
    "menu.import": "Import API configuration from a file",
    "export.empty": "No API Manager managed Provider is configured; nothing to export.",
    "export.done": "Exported {providers} Providers ({models} models)",
    "export.saved": "Export file: {path}",
    "export.secretNote": "The export contains API keys; keep the file safe.",
    "import.notFound": "Import file not found: {path}",
    "import.invalid": "Invalid import file {path}: {message}",
    "import.done": "Imported {providers} Providers ({models} models) from {path}",
    "thinking.title": "Default thinking effort (current model)",
    "saved.backup": "Backup: {path}",
    "saved.config": "Config: {path}",
    "compaction.unavailable": "Estimated hard compaction: current model window unavailable",
    "compaction.hard": "Estimated hard compaction: context exceeds {tokens} tokens ({percent}%)",
    "compaction.configured": "Configured threshold: {tokens} tokens; {reason}",
    "compaction.outputWarning": "Notice: the model output limit puts the response clamp ({tokens} tokens, {percent}%) before the hard threshold; automatic pruning moves to the clamp point.",
    "compaction.nudgeUnreachable": "Notice: the hard compaction threshold precedes the soft warning, so the warning is unreachable.",
    "compaction.pruneUnreachable": "Notice: the hard compaction threshold precedes soft pruning, so hard compaction may run directly.",
    "threshold.configured": "determined by the configured compaction reserve",
    "threshold.ratioFloor": "lowered by the 5% context-window safety floor",
    "threshold.maxOutput": "lowered by max-output protection",
    "threshold.capped": "max output is too large; safe reserve capped at 90% of the window",
    "validation.window": "Max output ({max}) must be smaller than the context window ({window}); otherwise no room remains for input.",
  },
  "zh-CN": {
    "value.on": "开启",
    "value.off": "关闭",
    "menu.title": "选择操作",
    "menu.list": "查看全部模型",
    "menu.configure": "新增或修改模型",
    "menu.show": "查看模型详情",
    "menu.vision": "Vision 多模态策略（当前：{state}）",
    "menu.effort": "调整思考强度",
    "menu.toggle": "启用或停用 Provider",
    "menu.delete": "删除模型",
    "menu.retry": "自动重试（当前：{state}）",
    "menu.cache": "提示缓存策略（当前：{value}）",
    "menu.cacheAgent": "Agent 缓存档位（当前：{value}）",
    "menu.price": "回填模型价格（内置表 + OpenRouter 在线）",
    "menu.logout": "注销 Provider",
    "menu.reset": "重置 Provider",
    "menu.export": "导出 API 配置到文件",
    "menu.import": "从文件导入 API 配置",
    "export.empty": "尚未配置 API Manager 管理的 Provider，无可导出内容。",
    "export.done": "已导出 {providers} 个 Provider（{models} 个模型）",
    "export.saved": "导出文件：{path}",
    "export.secretNote": "导出文件包含 API key，请妥善保管。",
    "import.notFound": "导入文件不存在：{path}",
    "import.invalid": "导入文件 {path} 无效：{message}",
    "import.done": "已从 {path} 导入 {providers} 个 Provider（{models} 个模型）",
    "thinking.title": "默认思考强度（当前 model）",
    "saved.backup": "备份：{path}",
    "saved.config": "配置：{path}",
    "compaction.unavailable": "预计硬压缩：当前模型窗口不可用",
    "compaction.hard": "预计实际硬压缩：上下文超过 {tokens} Token（{percent}%）",
    "compaction.configured": "配置阈值：{tokens} Token；{reason}",
    "compaction.outputWarning": "提醒：模型输出上限使响应钳制点（{tokens} Token，{percent}%）早于硬阈值，自动剪枝已提前至截断点。",
    "compaction.nudgeUnreachable": "提醒：当前硬压缩阈值早于软提醒，软提醒不可达。",
    "compaction.pruneUnreachable": "提醒：当前硬压缩阈值早于软裁剪，可能直接硬压缩。",
    "threshold.configured": "由压缩配置预留决定",
    "threshold.ratioFloor": "受上下文窗口 5% 安全底线下调",
    "threshold.maxOutput": "受单次最大输出保护下调",
    "threshold.capped": "单次最大输出过大，安全预留已封顶为窗口 90%",
    "validation.window": "单次最大输出 maxTokens（{max}）必须小于上下文窗口 contextWindow（{window}）；否则没有空间容纳输入。",
  },
} as const;

type OpsCatalogKey = keyof (typeof OPS_CATALOGS)["en"];

function opsText(key: OpsCatalogKey, vars?: Readonly<Record<string, string | number>>): string {
  const locale = getTuiLocale();
  const template = OPS_CATALOGS[locale]?.[key] ?? OPS_CATALOGS.en[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`);
}


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
    `Provider 自动重试：${retry.enabled ? "开启" : "关闭"} · 最大 ${retry.maxRetries} 次 · 退避上限 ${retry.maxDelayMs ?? NETWORK_RETRY_POLICY.maxDelayMs}ms`,
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
  const renameFrom = settings.previousModelId && settings.previousModelId !== settings.modelId
    ? settings.previousModelId
    : undefined;
  const existingIndex = currentModels.findIndex((model) => model.id === (renameFrom ?? settings.modelId));
  if (renameFrom && existingIndex < 0) {
    throw new Error(`Model ${renameFrom} is not configured; cannot rename`);
  }
  if (renameFrom) {
    const collisionIndex = currentModels.findIndex((model, index) => index !== existingIndex && model.id === settings.modelId);
    if (collisionIndex >= 0) throw new Error(`Model ${settings.modelId} already exists; cannot rename`);
  }
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
    name: typeof existingModel.name === "string" && existingModel.name !== renameFrom
      ? existingModel.name
      : settings.modelId,
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
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, modelsPath);
    await fsyncDirectory(dirname(modelsPath));
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
  const mutation = previous.catch(() => undefined).then(async () => {
    const release = await lockSettingsResource(path);
    try {
      await mutate();
    } finally {
      await release();
    }
  });
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

/** Every provider id present in models.json, native ones (e.g. "openai") included. */
export function providerIdsInModels(modelsPath: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.providers)) return [];
    // Hoisted: TypeScript drops property narrowing inside the filter callback.
    const providers = parsed.providers;
    return Object.keys(providers).filter((id) => isRecord(providers[id]));
  } catch {
    return [];
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

  const promptCachePolicy = loadPromptCachePolicySync(join(dirname(modelsPath), "settings.json"));
  const registrationApi = typeof config.api === "string" ? config.api : undefined;

  registration.models = config.models.filter(isRecord).flatMap((model) => {
    if (typeof model.id !== "string" || model.id.length === 0) return [];
    const normalizedMap = canonicalizeLegacyThinkingLevelMap(model.thinkingLevelMap).map;
    const input: Array<"text" | "image"> = Array.isArray(model.input)
        && model.input.every((value) => value === "text" || value === "image")
      ? [...model.input]
      : ["text"];
    const cost = isCost(model.cost)
      ? { ...model.cost }
      // Custom channels rarely carry cost in models.json; fall back to the
      // built-in pi-ai catalog so the footer shows real spend instead of $0.
      // Prefer the catalog matching this channel's API driver (e.g. Azure
      // pricing for azure-openai-responses channels).
      : (lookupBuiltinPricing(model.id, typeof model.api === "string" ? model.api : registrationApi)?.cost
        ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
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
    // Unified prompt-cache policy: control whether the model advertises the
    // OpenAI prompt-cache compat flags pi-ai turns into prompt_cache_options /
    // prompt_cache_retention request parameters (strict gateways reject them).
    // Anthropic-style cache_control is a separate mechanism and stays untouched.
    if (isOpenAIFormatApi(clone.api ?? registrationApi)) {
      clone.compat = { ...(clone.compat ?? {}), ...promptCacheCompatFlags(promptCachePolicy, model.id) };
    }
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

export interface CacheManagerArgs {
  policy?: PromptCachePolicy;
  showOnly?: boolean;
}

export interface CacheAgentManagerArgs {
  retention?: CacheRetention;
  showOnly?: boolean;
}

export interface ParsedManagerArgs {
  action?: ApiProviderAction;
  target?: ChannelTarget;
  /** File path operand for export/import; preserved with original casing. */
  filePath?: string;
  retry?: RetryManagerArgs;
  cache?: CacheManagerArgs;
  cacheAgent?: CacheAgentManagerArgs;
}

export function parseManagerArgs(args: string): ParsedManagerArgs {
  const values = args.trim().split(/\s+/).filter(Boolean);
  const normalized = values.map((value) => value.toLowerCase());
  if (values.length === 0) return {};
  if (normalized[0] === "cache" || normalized[0] === "prompt-cache" || normalized[0] === "promptcache") {
    if (values.length === 1) return { action: "cache" };
    if (normalized[1] === "agent" && values.length === 2) {
      return { action: "cache-agent" };
    }
    if (normalized[1] === "agent" && values.length === 3) {
      if (normalized[2] === "show" || normalized[2] === "status") {
        return { action: "cache-agent", cacheAgent: { showOnly: true } };
      }
      if (isCacheRetention(normalized[2])) {
        return { action: "cache-agent", cacheAgent: { retention: normalized[2] } };
      }
      throw usageError();
    }
    if ((normalized[1] === "show" || normalized[1] === "status") && values.length === 2) {
      return { action: "cache", cache: { showOnly: true } };
    }
    if (values.length === 2 && isPromptCachePolicy(normalized[1])) {
      return { action: "cache", cache: { policy: normalized[1] } };
    }
    throw usageError();
  }
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
  if (normalized[0] === "export" || normalized[0] === "import") {
    if (values.length === 1) return { action: normalized[0] };
    if (values.length === 2) return { action: normalized[0], filePath: values[1] };
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
    `用法：/api-manager list | retry [show|on [1-${API_RETRY_MAX_RETRIES}]|off] | cache [show|auto|off|on] | cache agent [show|short|long|none] | price [openai|qwen|anthropic|<Provider ID>] | show|set|delete|enable|disable|logout|reset [openai|qwen|anthropic|<Provider ID>|new] | export [path] | import [path]`,
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
    { action: "list", label: opsText("menu.list") },
    { action: "configure", label: opsText("menu.configure") },
    { action: "show", label: opsText("menu.show") },
    { action: "vision", label: opsText("menu.vision", { state: opsText(vision.enabled ? "value.on" : "value.off") }) },
    { action: "effort", label: opsText("menu.effort") },
    { action: "toggle", label: opsText("menu.toggle") },
    { action: "delete", label: opsText("menu.delete") },
    { action: "retry", label: opsText("menu.retry", { state: opsText(retry.enabled ? "value.on" : "value.off") }) },
    { action: "cache", label: opsText("menu.cache", { value: await loadPromptCachePolicy(settingsPath) }) },
    { action: "cache-agent", label: opsText("menu.cacheAgent", { value: await loadAgentCacheRetention(settingsPath) }) },
    { action: "price", label: opsText("menu.price") },
    { action: "export", label: opsText("menu.export") },
    { action: "import", label: opsText("menu.import") },
    { action: "logout", label: opsText("menu.logout") },
    { action: "reset", label: opsText("menu.reset") },
  ];
  const choice = await ctx.ui.select(opsText("menu.title"), choices.map((entry) => entry.label));
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
  if (value === "cache" || value === "prompt-cache" || value === "promptcache") return "cache";
  if (value === "cache-agent" || value === "agent-cache") return "cache-agent";
  if (value === "vision") return "vision";
  if (value === "effort") return "effort";
  if (value === "nextsuggest" || value === "next-suggest" || value === "suggest") return "nextsuggest";
  if (value === "price" || value === "pricing" || value === "cost") return "price";
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
  return await ctx.ui.select(opsText("thinking.title"), options) as ApiThinkingLevel | undefined;
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

export async function renameModelThinkingDefault(
  provider: string,
  oldModelId: string,
  newModelId: string,
  defaultsPath: string,
): Promise<void> {
  if (oldModelId === newModelId || !await fileExists(defaultsPath)) return;
  await serializeMutation(defaultsPath, async () => {
    const root = await readModelsRoot(defaultsPath);
    const modelDefaults = isRecord(root.modelDefaults) ? { ...root.modelDefaults } : {};
    const oldKey = modelThinkingKey(provider, oldModelId);
    const legacyOldKey = legacyModelThinkingKey(provider, oldModelId);
    const value = modelDefaults[oldKey] ?? modelDefaults[legacyOldKey];
    if (value === undefined) return;
    delete modelDefaults[oldKey];
    if (legacyOldKey !== oldKey) delete modelDefaults[legacyOldKey];
    modelDefaults[modelThinkingKey(provider, newModelId)] = value;
    await writeModelsRoot({ ...root, version: 1, modelDefaults }, defaultsPath, true);
  });
}

export async function renameDefaultModelRef(
  ctx: ExtensionCommandContext,
  modelsPath: string,
  provider: string,
  oldModelId: string,
  newModelId: string,
): Promise<void> {
  if (oldModelId === newModelId) return;
  const manager = SettingsManager.create(ctx.cwd, dirname(modelsPath));
  if (manager.getDefaultProvider() !== provider || manager.getDefaultModel() !== oldModelId) return;
  manager.setDefaultModel(newModelId);
  await manager.flush();
  const errors = manager.drainErrors();
  if (errors.length > 0) {
    throw new Error(`Unable to update default model reference: ${errors.map((entry) => entry.error.message).join("; ")}`);
  }
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
  const backup = result.backupPath ? `\n${opsText("saved.backup", { path: result.backupPath })}` : "";
  ctx.ui.notify(`${displayName} ${suffix}\n${opsText("saved.config", { path: result.path })}${backup}`, "info");
}

export function compactionPreviewLines(projectRoot: string, contextWindow: number, maxTokens: number): string[] {
  const compaction = readCompactionSettings(projectRoot).effective;
  const model = deriveCompactionThreshold({
    reserveTokens: compaction.reserveTokens,
    contextWindow,
    modelMaxTokens: maxTokens,
    soft: compaction.soft,
  });
  if (!model.usable) return [opsText("compaction.unavailable")];
  const configuredThreshold = contextWindow - compaction.reserveTokens;
  const lines = [
    opsText("compaction.hard", {
      tokens: model.thresholdTokens.toLocaleString(getTuiLocale()),
      percent: model.thresholdPercent.toFixed(0),
    }),
  ];
  if (configuredThreshold !== model.thresholdTokens) {
    lines.push(opsText("compaction.configured", {
      tokens: configuredThreshold.toLocaleString(getTuiLocale()),
      reason: providerThresholdReason(model.reason),
    }));
  }
  if (model.soft && model.soft.outputConstrained && model.soft.truncationPointTokens !== undefined) {
    lines.push(opsText("compaction.outputWarning", {
      tokens: model.soft.truncationPointTokens.toLocaleString(getTuiLocale()),
      percent: ((model.soft.truncationPointTokens / contextWindow) * 100).toFixed(0),
    }));
  }
  if (model.soft && !model.soft.nudgeReachable) {
    lines.push(opsText("compaction.nudgeUnreachable"));
  } else if (model.soft && !model.soft.pruneReachable) {
    lines.push(opsText("compaction.pruneUnreachable"));
  }
  return lines;
}

export function providerThresholdReason(reason: CompactionThresholdReason): string {
  if (reason === "configured") return opsText("threshold.configured");
  if (reason === "ratio-floor") return opsText("threshold.ratioFloor");
  if (reason === "max-output") return opsText("threshold.maxOutput");
  return opsText("threshold.capped");
}

export function validateModelWindow(contextWindow: number, maxTokens: number): void {
  if (maxTokens >= contextWindow) {
    throw new Error(opsText("validation.window", {
      max: maxTokens.toLocaleString(getTuiLocale()),
      window: contextWindow.toLocaleString(getTuiLocale()),
    }));
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

// max 已是 canonical level（与 Pi runtime 的 ThinkingLevel 一致），不再降级为 xhigh。
export function canonicalThinkingLevel(level: ApiThinkingLevel): ThinkingLevel {
  return level;
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

// --- Configuration export / import -----------------------------------------

export const API_MANAGER_EXPORT_KIND = "pi-maestro-api-manager";
export const API_MANAGER_EXPORT_VERSION = 1;

export function defaultApiManagerExportPath(modelsPath: string): string {
  return join(dirname(modelsPath), "api-manager-export.json");
}

/** Provider ids owned by the API Manager: configured presets plus managed user-defined Providers. */
function apiManagerOwnedIds(modelsRoot: Record<string, unknown>, defaultsPath: string): string[] {
  const providers = isRecord(modelsRoot.providers) ? modelsRoot.providers : {};
  const ids: string[] = [];
  for (const preset of PROVIDERS) {
    if (isRecord(providers[preset.id])) ids.push(preset.id);
  }
  for (const id of managedProviderIdsSync(defaultsPath)) {
    if (!findPreset(id) && !ids.includes(id) && isRecord(providers[id])) ids.push(id);
  }
  return ids;
}

function countProviderModels(providers: Record<string, Record<string, unknown>>): number {
  let count = 0;
  for (const entry of Object.values(providers)) {
    if (Array.isArray(entry.models)) count += entry.models.filter(isRecord).length;
  }
  return count;
}

/** Export payload: owned Provider entries verbatim from models.json plus their per-model thinking defaults. */
export async function buildApiManagerExport(
  modelsPath: string,
  defaultsPath: string,
): Promise<Record<string, unknown>> {
  const root = await readModelsRoot(modelsPath);
  const providers = isRecord(root.providers) ? root.providers : {};
  const ids = apiManagerOwnedIds(root, defaultsPath);
  const exported: Record<string, Record<string, unknown>> = {};
  for (const id of ids) {
    const entry = providers[id];
    if (isRecord(entry)) exported[id] = entry;
  }
  const defaultsRoot = await readModelsRoot(defaultsPath);
  const modelDefaults = isRecord(defaultsRoot.modelDefaults) ? defaultsRoot.modelDefaults : {};
  const exportedDefaults: Record<string, unknown> = {};
  for (const id of ids) {
    const prefixes = [`${encodeURIComponent(id)}/`, `${id}/`];
    for (const [key, value] of Object.entries(modelDefaults)) {
      if (typeof value === "string" && prefixes.some((prefix) => key.startsWith(prefix))) {
        exportedDefaults[key] = value;
      }
    }
  }
  return {
    kind: API_MANAGER_EXPORT_KIND,
    version: API_MANAGER_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    providers: exported,
    ...(Object.keys(exportedDefaults).length > 0 ? { modelDefaults: exportedDefaults } : {}),
  };
}

export async function exportApiManagerConfig(
  ctx: ExtensionCommandContext,
  exportPath: string,
  modelsPath: string,
  defaultsPath: string,
): Promise<void> {
  const payload = await buildApiManagerExport(modelsPath, defaultsPath);
  const providers = payload.providers as Record<string, Record<string, unknown>>;
  const providerCount = Object.keys(providers).length;
  if (providerCount === 0) {
    ctx.ui.notify(opsText("export.empty"), "info");
    return;
  }
  const result = await writeModelsRoot(payload, exportPath, await fileExists(exportPath));
  ctx.ui.notify([
    opsText("export.done", { providers: providerCount, models: countProviderModels(providers) }),
    opsText("export.saved", { path: result.path }),
    ...(result.backupPath ? [opsText("saved.backup", { path: result.backupPath })] : []),
    opsText("export.secretNote"),
  ].join("\n"), "info");
}

export async function importApiManagerConfig(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  importPath: string,
  modelsPath: string,
  defaultsPath: string,
  settingsPath: string,
): Promise<void> {
  if (!await fileExists(importPath)) {
    ctx.ui.notify(opsText("import.notFound", { path: importPath }), "warning");
    return;
  }
  let payload: Record<string, unknown>;
  let imported: Record<string, Record<string, unknown>>;
  try {
    const parsed = JSON.parse(await readFile(importPath, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("root must be a JSON object");
    if (parsed.kind !== undefined && parsed.kind !== API_MANAGER_EXPORT_KIND) {
      throw new Error(`kind must be ${API_MANAGER_EXPORT_KIND}`);
    }
    if (parsed.version !== undefined && parsed.version !== API_MANAGER_EXPORT_VERSION) {
      throw new Error(`unsupported version: ${String(parsed.version)}`);
    }
    payload = parsed;
    imported = validateImportedProviders(parsed.providers);
  } catch (error) {
    ctx.ui.notify(opsText("import.invalid", { path: importPath, message: errorMessage(error) }), "error");
    return;
  }
  const importedIds = Object.keys(imported);
  const removedModels: Array<[string, string]> = [];
  let result: SaveApiProviderResult | undefined;
  await serializeMutation(modelsPath, async () => {
    const exists = await fileExists(modelsPath);
    const root = await readModelsRoot(modelsPath);
    const providers = isRecord(root.providers) ? { ...root.providers } : {};
    for (const id of importedIds) {
      const entry = { ...imported[id] };
      const current = providers[id];
      // An export may omit the API key (e.g. a redacted copy); keep the local
      // key so an already configured Provider stays usable after the merge.
      if ((typeof entry.apiKey !== "string" || entry.apiKey === "")
        && isRecord(current) && typeof current.apiKey === "string" && current.apiKey !== "") {
        entry.apiKey = current.apiKey;
      }
      if (isRecord(current) && Array.isArray(current.models)) {
        const importedModelIds = new Set(
          Array.isArray(entry.models) ? entry.models.filter(isRecord).map((model) => model.id) : [],
        );
        for (const model of current.models.filter(isRecord)) {
          if (typeof model.id === "string" && !importedModelIds.has(model.id)) {
            removedModels.push([id, model.id]);
          }
        }
      }
      providers[id] = entry;
    }
    result = await writeModelsRoot({ ...root, providers }, modelsPath, exists);
  });
  if (!result) throw new Error("API Manager import was not written");
  await applyImportedDefaults(importedIds, payload.modelDefaults, defaultsPath);
  for (const [providerId, modelId] of removedModels) {
    await clearDeletedDefaultModel(settingsPath, providerId, modelId);
  }
  for (const id of importedIds) {
    reloadProviderRegistration(pi, ctx, id, modelsPath);
  }
  ctx.ui.notify([
    opsText("import.done", {
      providers: importedIds.length,
      models: countProviderModels(imported),
      path: importPath,
    }),
    opsText("saved.config", { path: result.path }),
    ...(result.backupPath ? [opsText("saved.backup", { path: result.backupPath })] : []),
  ].join("\n"), "info");
}

function validateImportedProviders(value: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(value)) throw new Error("providers must be a JSON object");
  const ids = Object.keys(value);
  if (ids.length === 0) throw new Error("providers is empty");
  const result: Record<string, Record<string, unknown>> = {};
  for (const id of ids) {
    const entry = value[id];
    if (!isRecord(entry)) throw new Error(`Provider ${id} must be an object`);
    normalizeChannelId(id);
    if (entry.api !== undefined && typeof entry.api !== "string") {
      throw new Error(`Provider ${id} api must be a string`);
    }
    if (!findPreset(id) && typeof entry.api !== "string") {
      throw new Error(`Provider ${id} requires an api field`);
    }
    if (entry.baseUrl !== undefined && typeof entry.baseUrl !== "string") {
      throw new Error(`Provider ${id} baseUrl must be a string`);
    }
    if (entry.apiKey !== undefined && typeof entry.apiKey !== "string") {
      throw new Error(`Provider ${id} apiKey must be a string`);
    }
    if (entry.name !== undefined && typeof entry.name !== "string") {
      throw new Error(`Provider ${id} name must be a string`);
    }
    if (entry.authHeader !== undefined && typeof entry.authHeader !== "boolean") {
      throw new Error(`Provider ${id} authHeader must be a boolean`);
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
      throw new Error(`Provider ${id} enabled must be a boolean`);
    }
    if (entry.headers !== undefined && !isStringRecord(entry.headers)) {
      throw new Error(`Provider ${id} headers must be a string map`);
    }
    if (entry.compat !== undefined && !isRecord(entry.compat)) {
      throw new Error(`Provider ${id} compat must be an object`);
    }
    if (entry.models !== undefined) {
      if (!Array.isArray(entry.models)) throw new Error(`Provider ${id} models must be an array`);
      const seen = new Set<string>();
      for (const model of entry.models) {
        if (!isRecord(model) || typeof model.id !== "string" || model.id.length === 0) {
          throw new Error(`Provider ${id} has a model entry without a string id`);
        }
        if (seen.has(model.id)) throw new Error(`Provider ${id} duplicates model ${model.id}`);
        seen.add(model.id);
        if (model.contextWindow !== undefined && !isPositiveInteger(model.contextWindow)) {
          throw new Error(`Provider ${id} model ${model.id} contextWindow must be a positive integer`);
        }
        if (model.maxTokens !== undefined && !isPositiveInteger(model.maxTokens)) {
          throw new Error(`Provider ${id} model ${model.id} maxTokens must be a positive integer`);
        }
        if (model.reasoning !== undefined && typeof model.reasoning !== "boolean") {
          throw new Error(`Provider ${id} model ${model.id} reasoning must be a boolean`);
        }
      }
    }
    result[id] = entry;
  }
  return result;
}

/** Replace the thinking defaults of imported Providers with the exported values and track managed ids. */
async function applyImportedDefaults(
  importedIds: string[],
  incomingDefaults: unknown,
  defaultsPath: string,
): Promise<void> {
  await serializeMutation(defaultsPath, async () => {
    const exists = await fileExists(defaultsPath);
    const root = await readModelsRoot(defaultsPath);
    const modelDefaults = isRecord(root.modelDefaults) ? { ...root.modelDefaults } : {};
    for (const id of importedIds) {
      const prefixes = [`${encodeURIComponent(id)}/`, `${id}/`];
      for (const key of Object.keys(modelDefaults)) {
        if (prefixes.some((prefix) => key.startsWith(prefix))) delete modelDefaults[key];
      }
    }
    const ownerParts = new Set<string>();
    for (const id of importedIds) {
      ownerParts.add(id);
      ownerParts.add(encodeURIComponent(id));
    }
    const incoming = isRecord(incomingDefaults) ? incomingDefaults : {};
    for (const [key, value] of Object.entries(incoming)) {
      const providerPart = key.split("/")[0];
      if (!ownerParts.has(providerPart) || !isThinkingLevel(value)) continue;
      modelDefaults[key] = value;
    }
    const managed = managedProviderIds(root);
    for (const id of importedIds) {
      if (!findPreset(id) && !managed.includes(id)) managed.push(id);
    }
    await writeModelsRoot({
      ...withoutLegacyManagedChannels(root),
      version: 1,
      modelDefaults,
      managedProviders: managed,
    }, defaultsPath, exists);
  });
}

