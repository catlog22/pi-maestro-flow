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
import { getSupportedThinkingLevels, type ModelCost } from "@earendil-works/pi-ai";
import { NETWORK_RETRY_POLICY, RESOLVED_NETWORK_RETRY_POLICY } from "pi-maestro-teammate/v1/retry";
import { getTuiLocale } from "../tui/locale.ts";
import {
  DEFAULT_NEXT_SUGGEST_CONFIG,
  loadNextSuggestConfig,
  saveNextSuggestConfig,
} from "../next-suggest/config.ts";
import {
  DEFAULT_ENHANCE_CONFIG,
  loadEnhanceConfig,
  saveEnhanceConfig,
  type EnhanceContextDepth,
} from "../prompt-enhance/config.ts";
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
import {
  fetchOpenRouterPricing,
  lookupBuiltinPricing,
  matchOpenRouterPricing,
} from "./cost-backfill.ts";
import { discoverModels, type DiscoveredModel } from "./model-discovery.ts";

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

/** UI copy for the API Manager menu and notification surface. */
const CATALOGS = {
  en: {
    "effort.noModel": "No active model; cannot adjust thinking effort.",
    "effort.currentMarker": " (current)",
    "effort.title": "Choose thinking effort (current: {level})",
    "effort.saveFailed": "Failed to save thinking effort: {message}",
    "effort.applyFailed": "Failed to apply thinking effort: {message}",
    "effort.applied": "Thinking effort set to {level}",
    "effort.manageEntry": "⚙ Manage thinking levels…",
    "effort.mgmt.title": "Manage thinking levels",
    "effort.mgmt.add": "➕ Add level",
    "effort.mgmt.remove": "🗑 Delete level",
    "effort.mgmt.rename": "✏ Rename level",
    "effort.mgmt.reset": "♻ Restore defaults",
    "effort.mgmt.namePrompt": "Level display name",
    "effort.mgmt.targetPrompt": "Map to canonical level",
    "effort.mgmt.pickPrompt": "Select a level entry",
    "effort.mgmt.renamePrompt": "New display name",
    "effort.mgmt.duplicateName": "{name} already exists",
    "effort.mgmt.lastEntry": "At least one thinking level must remain",
    "effort.mgmt.saved": "Thinking levels saved",
    "effort.mgmt.resetDone": "Thinking levels restored to defaults",
    "retry.on": "On",
    "retry.off": "Off",
    "retry.menuTitle": "Provider auto-retry",
    "retry.countPrompt": "Max retry count (1-{max})",
    "retry.confirmTitle": "Save Provider retry settings?",
    "retry.summary": "Auto-retry: {state}",
    "retry.count": "Max retry count: {count}",
    "retry.maxDelay": "Max backoff delay (last retry wait): {delay}ms",
    "retry.maxDelayPrompt": "Max backoff delay in ms before the final retry (0-600000)",
    "retry.owner": "Execution owner: Pi core (exponential backoff, live status in TUI)",
    "retry.notifySummary": "Provider auto-retry: {state}",
    "retry.notifyPath": "Config: {path}",
    "manager.needTui": "/api-manager interactive menu requires an interactive Pi session.",
    "manager.visionNeedTui": "/api-manager vision requires an interactive Pi session; use /vision status to view state.",
    "manager.effortNeedTui": "/api-manager effort requires an interactive Pi session.",
    "manager.needProviderId": "/api-manager {action} requires a Provider ID.",
    "manager.configureNeedTui": "/api-manager configure requires an interactive Pi session.",
    "manager.actionNeedTui": "/api-manager {action} requires an interactive Pi session.",
    "manager.specifyProvider": "Specify a Provider: openai, qwen, anthropic, or a user-defined Provider ID.",
    "manager.configFailed": "API configuration failed: {message}",
    "manager.exportPathPrompt": "Export file path",
    "manager.importPathPrompt": "Import file path",
    "manager.commandDescription": "Manage API models and Provider configuration",
    "effort.commandDescription": "Adjust thinking effort for the current model (shortcut for /api-manager effort)",
    "retry.initFailed": "Failed to initialize default retry settings: {message}",
    "form.title.add": "Add {name} model",
    "form.title.edit": "Edit {name} / {model}",
    "form.section.connection": "Connection (Provider / URL level)",
    "form.section.compat": "Compatibility (format level)",
    "form.section.model": "Model settings",
    "form.label.providerName": "Provider display name",
    "form.label.headers": "Request headers JSON",
    "form.label.authHeader": "Authorization",
    "form.label.developerRole": "Developer role",
    "form.label.maxTokensField": "Output request field",
    "form.label.reasoning": "Reasoning capability",
    "form.label.defaultThinking": "Default thinking effort",
    "form.label.contextWindow": "Context window",
    "form.label.maxTokens": "Max output per response",
    "form.label.multimodal": "Multimodal (vision)",
    "form.help.apiKey": "The API key is masked; leave it untouched to preserve the current models.json value.",
    "form.help.headers": "Headers may contain credentials. The form only shows a mask; enter the complete JSON object when editing.",
    "form.help.modelAdd": "Separate multiple Model IDs with commas to add them together; the remaining fields are used as a template.",
    "form.help.modelEdit": "Changing the Model ID renames this entry and migrates its thinking default and default-model reference; the new ID must not collide.",
    "form.help.multimodal": "On writes input: [text, image]; off writes input: [text] for vision delegation capability checks.",
    "form.choice.auto": "Auto",
    "form.choice.autoUrl": "Auto (detect from URL)",
    "form.choice.bearer": "Bearer",
    "form.choice.noSend": "Do not send",
    "form.choice.supported": "Supported",
    "form.choice.unsupported": "Unsupported",
    "form.confirm.preset": "Save {name} API configuration?",
    "form.confirm.provider": "Save Provider {name}?",
    "form.preview.compat": "Compat: {value}",
    "form.preview.headers": "Headers: {value}",
    "form.preview.authorization": "Authorization: {value}",
    "form.value.none": "none",
    "form.saved": "Saved {count} models: {models}; default thinking effort is {level}",
    "preview.contextWindow": "Context window: {value} tokens (combined input and output; local registration)",
    "preview.provider": "Provider: {value}",
    "preview.api": "API format: {value}",
    "preview.baseUrl": "Base URL: {value}",
    "preview.model": "Model: {value}",
    "preview.maxTokens": "Max output per response: {value} tokens",
    "preview.reasoning": "Reasoning: {value}",
    "preview.multimodal": "Multimodal (vision): {value}",
    "preview.defaultThinking": "Default thinking (current model): {value}",
    "preview.auth": "Auth: stored API key",
    "preview.isolation": "Isolation: models under one Provider share the URL and API key",
    "preview.enabled": "enabled",
    "preview.disabled": "disabled",
    "validation.modelRequired": "Model ID is required",
    "validation.singleModel": "Editing an existing model requires exactly one Model ID",
    "validation.duplicateModel": "Model ID {model} is duplicated; each model may appear only once",
    "validation.modelExists": "Model {model} already exists; return to the list and select it for editing",
    "validation.thinkingIncompatible": "Default thinking effort {level} is incompatible with the current API or reasoning capability",
    "validation.fieldInvalid": "Form field {field} is invalid",
    "validation.thinkingInvalid": "Thinking effort {level} is invalid",
    "validation.headersJson": "Request headers JSON is invalid",
    "validation.headersObject": "Request headers must be a JSON object with string keys and values",
    "discovery.prompt": "Discover available models from the server's /models endpoint?",
    "discovery.discovering": "Discovering models from {url} …",
    "discovery.failed": "Could not discover models: {message}",
    "discovery.empty": "The server returned no models.",
    "discovery.selectTitle": "Select models to inject (pick one at a time; repeat)",
    "discovery.done": "✅ Done — inject {count} selected model(s)",
    "discovery.selected": "（selected）",
    "discovery.alreadyConfigured": "（configured）",
    "discovery.injected": "Injected {count} model(s): {models}",
    "discovery.injectedNone": "No new models selected.",
    "discovery.keepManual": "Continuing with manual Model ID entry.",
    "discovery.noConnection": "Discovery needs a valid Base URL (fill it in the form first).",
  },
  "zh-CN": {
    "effort.noModel": "当前没有模型，无法调整思考强度。",
    "effort.currentMarker": "（当前）",
    "effort.title": "选择思考强度（当前：{level}）",
    "effort.saveFailed": "思考强度保存失败：{message}",
    "effort.applyFailed": "思考强度应用失败：{message}",
    "effort.applied": "思考强度已设为 {level}",
    "effort.manageEntry": "⚙ 管理思考等级…",
    "effort.mgmt.title": "管理思考等级",
    "effort.mgmt.add": "➕ 新增等级",
    "effort.mgmt.remove": "🗑 删除等级",
    "effort.mgmt.rename": "✏ 重命名",
    "effort.mgmt.reset": "♻ 恢复默认",
    "effort.mgmt.namePrompt": "等级显示名称",
    "effort.mgmt.targetPrompt": "映射到 canonical 档位",
    "effort.mgmt.pickPrompt": "选择等级条目",
    "effort.mgmt.renamePrompt": "新的显示名称",
    "effort.mgmt.duplicateName": "{name} 已存在",
    "effort.mgmt.lastEntry": "至少保留一个思考等级",
    "effort.mgmt.saved": "思考等级列表已保存",
    "effort.mgmt.resetDone": "已恢复默认思考等级",
    "retry.on": "开启",
    "retry.off": "关闭",
    "retry.menuTitle": "Provider 自动重试",
    "retry.countPrompt": "最大重试次数（1-{max}）",
    "retry.confirmTitle": "保存 Provider 重试配置？",
    "retry.summary": "自动重试：{state}",
    "retry.count": "最大重试次数：{count}",
    "retry.maxDelay": "最大退避延迟（最后一次重试等待）：{delay}ms",
    "retry.maxDelayPrompt": "最后一次重试前的最大退避毫秒数（0-600000）",
    "retry.owner": "执行所有权：Pi core（指数退避，TUI 显示实时状态）",
    "retry.notifySummary": "Provider 自动重试：{state}",
    "retry.notifyPath": "配置：{path}",
    "manager.needTui": "/api-manager 交互菜单需要交互式 Pi 会话。",
    "manager.visionNeedTui": "/api-manager vision 需要交互式 Pi 会话；状态查看可使用 /vision status。",
    "manager.effortNeedTui": "/api-manager effort 需要交互式 Pi 会话。",
    "manager.needProviderId": "/api-manager {action} 需要指定 Provider ID。",
    "manager.configureNeedTui": "/api-manager configure 需要交互式 Pi 会话。",
    "manager.actionNeedTui": "/api-manager {action} 需要交互式 Pi 会话。",
    "manager.specifyProvider": "请指定 Provider：openai、qwen、anthropic 或用户定义的 Provider ID。",
    "manager.configFailed": "API 配置失败：{message}",
    "manager.exportPathPrompt": "导出文件路径",
    "manager.importPathPrompt": "导入文件路径",
    "manager.commandDescription": "管理 API 模型与 Provider 配置",
    "effort.commandDescription": "调整当前模型的思考强度（/api-manager effort 的快捷入口）",
    "retry.initFailed": "Retry 默认配置初始化失败：{message}",
    "form.title.add": "新增 {name} 模型",
    "form.title.edit": "修改 {name} / {model}",
    "form.section.connection": "连接（Provider / URL 级）",
    "form.section.compat": "兼容（format 级）",
    "form.section.model": "模型（Model 级）",
    "form.label.providerName": "Provider 显示名称",
    "form.label.headers": "请求头 JSON",
    "form.label.authHeader": "Authorization",
    "form.label.developerRole": "Developer 角色",
    "form.label.maxTokensField": "输出请求字段",
    "form.label.reasoning": "推理能力",
    "form.label.defaultThinking": "默认思考强度",
    "form.label.contextWindow": "上下文窗口",
    "form.label.maxTokens": "单次最大输出",
    "form.label.multimodal": "多模态（视觉）",
    "form.help.apiKey": "API key 仅显示掩码；不编辑即可保留 models.json 中的当前值。",
    "form.help.headers": "请求头可能包含凭据，表单仅显示掩码；编辑时需输入完整 JSON 对象。",
    "form.help.modelAdd": "多个 Model ID 用逗号分隔，一次新增多个模型（其余字段作为模板应用到每个模型）。",
    "form.help.modelEdit": "修改 Model ID 将重命名该模型，并迁移思考强度默认值与默认模型引用；新 ID 不能与其他模型冲突。",
    "form.help.multimodal": "开启时写入 input: [text, image]；关闭时写入 input: [text]，用于视觉委托能力判断。",
    "form.choice.auto": "自动",
    "form.choice.autoUrl": "自动（按 URL 识别）",
    "form.choice.bearer": "Bearer",
    "form.choice.noSend": "不发送",
    "form.choice.supported": "支持",
    "form.choice.unsupported": "不支持",
    "form.confirm.preset": "保存 {name} API 配置？",
    "form.confirm.provider": "保存 Provider {name}？",
    "form.preview.compat": "Compat：{value}",
    "form.preview.headers": "请求头：{value}",
    "form.preview.authorization": "Authorization：{value}",
    "form.value.none": "无",
    "form.saved": "已保存 {count} 个模型：{models}，默认思考强度为 {level}",
    "preview.contextWindow": "上下文窗口：{value} Token（输入+输出总量，本地注册值）",
    "preview.provider": "Provider：{value}",
    "preview.api": "API format：{value}",
    "preview.baseUrl": "Base URL：{value}",
    "preview.model": "Model：{value}",
    "preview.maxTokens": "单次最大输出：{value} Token",
    "preview.reasoning": "推理能力：{value}",
    "preview.multimodal": "多模态（视觉）：{value}",
    "preview.defaultThinking": "默认思考强度（当前 model）：{value}",
    "preview.auth": "认证：已保存 API key",
    "preview.isolation": "隔离：同 Provider 下所有模型共享 URL 与 API key",
    "preview.enabled": "enabled",
    "preview.disabled": "disabled",
    "validation.modelRequired": "Model ID 不能为空",
    "validation.singleModel": "修改已有模型时只能指定一个 Model ID",
    "validation.duplicateModel": "Model ID {model} 重复；每个模型只能出现一次",
    "validation.modelExists": "Model {model} 已存在；请返回列表选择该 model 进行修改",
    "validation.thinkingIncompatible": "默认思考强度 {level} 与当前 API / 推理能力不兼容",
    "validation.fieldInvalid": "表单字段 {field} 无效",
    "validation.thinkingInvalid": "思考强度 {level} 无效",
    "validation.headersJson": "请求头 JSON 格式无效",
    "validation.headersObject": "请求头必须是字符串键值的 JSON 对象",
    "discovery.prompt": "从服务端 /models 接口识别可用模型？",
    "discovery.discovering": "正在从 {url} 识别模型 …",
    "discovery.failed": "未能识别模型：{message}",
    "discovery.empty": "服务端未返回任何模型。",
    "discovery.selectTitle": "选择要注入的模型（每次选一个，可重复）",
    "discovery.done": "✅ 完成 — 注入已选的 {count} 个模型",
    "discovery.selected": "（已选）",
    "discovery.alreadyConfigured": "（已配置）",
    "discovery.injected": "已注入 {count} 个模型：{models}",
    "discovery.injectedNone": "未选择新模型。",
    "discovery.keepManual": "继续手动填写 Model ID。",
    "discovery.noConnection": "识别模型需要有效的 Base URL（请先在表单中填写）。",
  },
} as const;

type CatalogKey = keyof (typeof CATALOGS)["en"];

/** Translate a catalog key using the current shared TUI locale. */
function t(key: CatalogKey, vars?: Readonly<Record<string, string | number>>): string {
  const catalog = CATALOGS[getTuiLocale()] ?? CATALOGS.en;
  const template: unknown = catalog[key];
  const text = typeof template === "string" ? template : CATALOGS.en[key] as string;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (_match, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`);
}

export interface ApiProviderSettings {
  /** Provider id used by Pi to qualify models and isolate URL/API key configuration. */
  provider: string;
  baseUrl: string;
  modelId: string;
  /** Previous identity when this save renames an existing model; matches and renames the entry in place, rejecting collisions. */
  previousModelId?: string;
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

function thinkingFormatOptions(): ReadonlyArray<{ label: string; value?: string }> {
  if (getTuiLocale() === "zh-CN") return THINKING_FORMAT_OPTIONS;
  return [
    { label: "Auto (detect from URL, recommended)" },
    { label: "openai (reasoning_effort)", value: "openai" },
    { label: "openrouter (reasoning.effort)", value: "openrouter" },
    { label: "deepseek (thinking.type; also direct api.z.ai)", value: "deepseek" },
    { label: "zai (enable_thinking; DashScope-hosted GLM)", value: "zai" },
    { label: "qwen (enable_thinking)", value: "qwen" },
    { label: "qwen-chat-template (chat_template_kwargs)", value: "qwen-chat-template" },
  ];
}

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
  /** Optional: saved callers preserve the existing value; loaders always resolve a default. */
  baseDelayMs?: number;
  /** Optional: backoff cap (last retry's maximum wait); loaders resolve `RESOLVED_NETWORK_RETRY_POLICY.maxDelayMs` by default. */
  maxDelayMs?: number;
}

export type ApiProviderAction = "cache" | "cache-agent" | "configure" | "delete" | "disable" | "effort" | "enable" | "enhance" | "export" | "import" | "list" | "logout" | "nextsuggest" | "price" | "provider" | "reset" | "retry" | "show" | "stats" | "toggle" | "vision";
export type ApiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const DEFAULT_THINKING_LEVEL: ApiThinkingLevel = "medium";
export const API_RETRY_MAX_RETRIES = NETWORK_RETRY_POLICY.maxRetries;
// Defaults mirror the pi runtime (settings-manager): maxRetries 3 / baseDelayMs 2000.
export const API_RETRY_DEFAULT_MAX_RETRIES = 3;
export const API_RETRY_DEFAULT_BASE_DELAY_MS = 2000;
const DEFAULT_API_RETRY_SETTINGS: Readonly<ApiRetrySettings> = Object.freeze({
  enabled: true,
  maxRetries: API_RETRY_DEFAULT_MAX_RETRIES,
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
    modelId: "qwen3.8-max",
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
 * Interactive thinking-effort picker backed by api-manager.json (defaultsPath).
 * The picker renders the managed level list (effortLevels section; absent means
 * all canonical levels) filtered to levels the current model supports, plus an
 * entry point into the add/delete/rename management submenu.
 * Shared by the /effort shortcut and the /api-manager effort action.
 */
async function adjustThinkingEffort(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  defaultsPath: string,
): Promise<void> {
  if (!ctx.model) {
    ctx.ui.notify(t("effort.noModel"), "warning");
    return;
  }
  const current = pi.getThinkingLevel();
  const levelMap = ctx.model.thinkingLevelMap;
  const supportsMax = levelMap?.xhigh === "max" || levelMap?.max === "max";
  const supported = new Set<ThinkingLevel>([
    ...getSupportedThinkingLevels(ctx.model).filter(isThinkingLevel),
    ...(supportsMax ? ["max" as ThinkingLevel] : []),
  ]);
  const manageLabel = t("effort.manageEntry");
  while (true) {
    const entries = (await loadEffortLevels(defaultsPath)).filter((entry) => supported.has(entry.level));
    const labels = new Map<string, EffortLevelEntry>();
    const options = entries.map((entry) => {
      const base = entry.name === entry.level ? entry.name : `${entry.name} → ${entry.level}`;
      const label = `${base}${entry.level === current ? t("effort.currentMarker") : ""}`;
      labels.set(label, entry);
      return label;
    });
    const choice = await ctx.ui.select(t("effort.title", { level: current }), [...options, manageLabel]);
    if (choice === undefined) return;
    if (choice === manageLabel) {
      await manageEffortLevels(ctx, defaultsPath);
      continue;
    }
    const selected = labels.get(choice);
    if (!selected) continue;
    try {
      await saveModelThinkingDefault(ctx.model.provider, ctx.model.id, selected.level, defaultsPath);
    } catch (error) {
      ctx.ui.notify(t("effort.saveFailed", { message: errorMessage(error) }), "error");
      return;
    }
    try {
      setPiThinkingLevel(pi, selected.level);
    } catch (error) {
      ctx.ui.notify(t("effort.applyFailed", { message: errorMessage(error) }), "error");
      return;
    }
    syncEffortStatus(ctx, selected.level);
    ctx.ui.notify(t("effort.applied", { level: selected.level }), "info");
    return;
  }
}

/** Add/delete/rename the managed /effort level list persisted in api-manager.json. */
async function manageEffortLevels(
  ctx: ExtensionCommandContext,
  defaultsPath: string,
): Promise<void> {
  const actions = [
    { label: t("effort.mgmt.add"), run: () => addEffortLevel(ctx, defaultsPath) },
    { label: t("effort.mgmt.remove"), run: () => removeEffortLevel(ctx, defaultsPath) },
    { label: t("effort.mgmt.rename"), run: () => renameEffortLevel(ctx, defaultsPath) },
    { label: t("effort.mgmt.reset"), run: () => resetEffortLevelsAction(ctx, defaultsPath) },
  ];
  const choice = await ctx.ui.select(t("effort.mgmt.title"), actions.map((action) => action.label));
  if (choice === undefined) return;
  const action = actions.find((entry) => entry.label === choice);
  if (!action) return;
  try {
    await action.run();
  } catch (error) {
    ctx.ui.notify(t("effort.saveFailed", { message: errorMessage(error) }), "error");
  }
}

async function addEffortLevel(ctx: ExtensionCommandContext, defaultsPath: string): Promise<void> {
  const nameInput = await ctx.ui.input(t("effort.mgmt.namePrompt"), "");
  if (nameInput === undefined) return;
  const name = nameInput.trim();
  if (!name) return;
  const entries = await loadEffortLevels(defaultsPath);
  if (entries.some((entry) => entry.name === name)) {
    ctx.ui.notify(t("effort.mgmt.duplicateName", { name }), "warning");
    return;
  }
  const level = await ctx.ui.select(t("effort.mgmt.targetPrompt"), [...EFFORT_LEVELS]) as ThinkingLevel | undefined;
  if (!level) return;
  await saveEffortLevels([...entries, { name, level }], defaultsPath);
  ctx.ui.notify(t("effort.mgmt.saved"), "info");
}

async function removeEffortLevel(ctx: ExtensionCommandContext, defaultsPath: string): Promise<void> {
  const entries = await loadEffortLevels(defaultsPath);
  if (entries.length <= 1) {
    ctx.ui.notify(t("effort.mgmt.lastEntry"), "warning");
    return;
  }
  const target = await pickEffortEntry(ctx, entries);
  if (!target) return;
  await saveEffortLevels(entries.filter((entry) => entry !== target), defaultsPath);
  ctx.ui.notify(t("effort.mgmt.saved"), "info");
}

async function renameEffortLevel(ctx: ExtensionCommandContext, defaultsPath: string): Promise<void> {
  const entries = await loadEffortLevels(defaultsPath);
  const target = await pickEffortEntry(ctx, entries);
  if (!target) return;
  const nameInput = await ctx.ui.input(t("effort.mgmt.renamePrompt"), target.name);
  if (nameInput === undefined) return;
  const name = nameInput.trim();
  if (!name || name === target.name) return;
  if (entries.some((entry) => entry !== target && entry.name === name)) {
    ctx.ui.notify(t("effort.mgmt.duplicateName", { name }), "warning");
    return;
  }
  await saveEffortLevels(
    entries.map((entry) => (entry === target ? { ...entry, name } : entry)),
    defaultsPath,
  );
  ctx.ui.notify(t("effort.mgmt.saved"), "info");
}

async function resetEffortLevelsAction(ctx: ExtensionCommandContext, defaultsPath: string): Promise<void> {
  await resetEffortLevels(defaultsPath);
  ctx.ui.notify(t("effort.mgmt.resetDone"), "info");
}

function effortEntryLabel(entry: EffortLevelEntry): string {
  return entry.name === entry.level ? entry.name : `${entry.name} → ${entry.level}`;
}

async function pickEffortEntry(
  ctx: ExtensionCommandContext,
  entries: readonly EffortLevelEntry[],
): Promise<EffortLevelEntry | undefined> {
  const choice = await ctx.ui.select(t("effort.mgmt.pickPrompt"), entries.map(effortEntryLabel));
  return entries.find((entry) => effortEntryLabel(entry) === choice);
}

/**
 * Register API Providers through Pi's documented models.json contract. A Provider
 * owns provider-level connection config (URL, API key, format, headers, auth) and
 * hosts one or more models; models under the same Provider share that connection.
 */
export interface ApiProviderConfigHandle {
  openManager(ctx: ExtensionCommandContext, args?: string): Promise<void>;
}

export function registerApiProviderConfigs(
  pi: ExtensionAPI,
  options: RegisterApiProviderOptions = {},
): ApiProviderConfigHandle {
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
  // Persisted cache tiers: main-flow retention lands on PI_CACHE_RETENTION
  // (pi-ai reads it per request), the agent tier on PI_TEAMMATE_CACHE_RETENTION
  // (teammate subprocess spawn pin). "auto" keeps a user-set env untouched.
  applyCacheRetentionEnv(settingsPath);

  const handle: ApiProviderConfigHandle = {
    async openManager(ctx, args = "") {
      try {
        await showApiProviderManager(pi, args, ctx, modelsPath, defaultsPath, settingsPath);
      } catch (error) {
        ctx.ui.notify(t("manager.configFailed", { message: errorMessage(error) }), "error");
      }
    },
  };
  if (typeof pi.registerCommand !== "function") return handle;
  pi.registerCommand("api-manager", {
    description: t("manager.commandDescription"),
    async handler(args, ctx) {
      await handle.openManager(ctx, args);
    },
  });
  pi.registerCommand("effort", {
    description: t("effort.commandDescription"),
    async handler(_args, ctx) {
      await adjustThinkingEffort(pi, ctx, defaultsPath);
    },
  });
  if (typeof pi.on === "function") {
    pi.on("session_start", async (_event, ctx) => {
      try {
        await ensureApiRetryDefaults(settingsPath);
      } catch (error) {
        ctx.ui.notify(t("retry.initFailed", { message: errorMessage(error) }), "warning");
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
  return handle;
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
    previousModelId: settings.previousModelId ?? undefined,
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
    baseDelayMs: isPositiveInteger(retry.baseDelayMs)
      ? retry.baseDelayMs
      : API_RETRY_DEFAULT_BASE_DELAY_MS,
    maxDelayMs: isPositiveInteger(retry.maxDelayMs)
      ? retry.maxDelayMs
      : RESOLVED_NETWORK_RETRY_POLICY.maxDelayMs,
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
    // Explicit values win (settings UI / command); callers that omit a field
    // keep the persisted value, falling back to the policy default.
    const baseDelayMs = settings.baseDelayMs !== undefined
      ? settings.baseDelayMs
      : isPositiveInteger(retry.baseDelayMs)
        ? retry.baseDelayMs
        : API_RETRY_DEFAULT_BASE_DELAY_MS;
    const maxDelayMs = settings.maxDelayMs !== undefined
      ? settings.maxDelayMs
      : isPositiveInteger(retry.maxDelayMs)
        ? retry.maxDelayMs
        : RESOLVED_NETWORK_RETRY_POLICY.maxDelayMs;
    await writeModelsRoot({
      ...root,
      retry: {
        ...retry,
        enabled: settings.enabled,
        maxRetries,
        baseDelayMs,
        maxDelayMs,
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

  const enabledLabel = `${t("retry.on")}${current.enabled ? t("effort.currentMarker") : ""}`;
  const disabledLabel = `${t("retry.off")}${current.enabled ? "" : t("effort.currentMarker")}`;
  const enabledChoice = await ctx.ui.select(t("retry.menuTitle"), [enabledLabel, disabledLabel]);
  if (!enabledChoice) return;
  const enabled = enabledChoice === enabledLabel;
  let maxRetries = current.maxRetries;
  let maxDelayMs = current.maxDelayMs;
  if (enabled) {
    const input = await ctx.ui.input(
      t("retry.countPrompt", { max: API_RETRY_MAX_RETRIES }),
      String(current.maxRetries),
    );
    if (input === undefined) return;
    maxRetries = retryCount(input);
    const delayInput = await ctx.ui.input(
      t("retry.maxDelayPrompt"),
      String(current.maxDelayMs),
    );
    if (delayInput === undefined) return;
    const parsed = Number(delayInput);
    if (Number.isFinite(parsed) && parsed >= 0) maxDelayMs = Math.floor(parsed);
  }
  const confirmed = await ctx.ui.confirm(
    t("retry.confirmTitle"),
    [
      t("retry.summary", { state: enabled ? t("retry.on") : t("retry.off") }),
      t("retry.count", { count: maxRetries }),
      t("retry.maxDelay", { delay: maxDelayMs ?? RESOLVED_NETWORK_RETRY_POLICY.maxDelayMs }),
      t("retry.owner"),
    ].join("\n"),
  );
  if (!confirmed) return;
  const next = { enabled, maxRetries, maxDelayMs };
  await saveApiRetrySettings(next, settingsPath);
  notifyRetrySettings(ctx, next, settingsPath);
}

export async function managePromptCacheSettings(
  ctx: ExtensionCommandContext,
  settingsPath: string,
  command?: CacheManagerArgs,
): Promise<void> {
  const current = await loadPromptCachePolicy(settingsPath);
  if (command?.policy !== undefined) {
    await savePromptCachePolicy(command.policy, settingsPath);
    notifyPromptCacheSettings(ctx, command.policy, settingsPath);
    return;
  }
  if (!ctx.hasUI || command?.showOnly) {
    notifyPromptCacheSettings(ctx, current, settingsPath);
    return;
  }

  const options = PROMPT_CACHE_POLICIES.map((policy) =>
    `${policy}${policy === current ? t("effort.currentMarker") : ""}`,
  );
  const choice = await ctx.ui.select(
    "提示缓存策略（auto: 仅 gpt-5.6+ 模型发送；off: 不发送；on: 始终发送）",
    options,
  );
  if (!choice) return;
  const policy = PROMPT_CACHE_POLICIES.find(
    (value) => `${value}${value === current ? t("effort.currentMarker") : ""}` === choice,
  );
  if (!policy || !isPromptCachePolicy(policy)) return;
  const confirmed = await ctx.ui.confirm(
    "确认修改提示缓存策略",
    [
      `将改为：${policy}`,
      "auto 会对 gpt-5.6+ 模型发送 prompt_cache_options / prompt_cache_retention；部分网关会拒绝这些参数，遇到 400 请切回 off。",
    ].join("\n"),
  );
  if (!confirmed) return;
  await savePromptCachePolicy(policy, settingsPath);
  notifyPromptCacheSettings(ctx, policy, settingsPath);
}

const NEXT_SUGGEST_THINKING_LEVELS = ["default", "low", "medium", "high", "xhigh", "max"] as const;
const NEXT_SUGGEST_ACCEPT_KEYS = ["f2", "alt+shift+n"] as const;

/**
 * Next-step suggestion settings panel inside the API manager.
 *
 * The feature switch, generation model, thinking level, length cap and accept
 * key are independent from the session model and persisted in the
 * api-manager.json `nextSuggest` section.
 */
export async function manageNextSuggestSettings(
  ctx: ExtensionCommandContext,
  defaultsPath: string,
  modelsPath: string,
): Promise<void> {
  if (!ctx.hasUI) {
    const current = await loadNextSuggestConfig(defaultsPath);
    ctx.ui.notify(
      `下一步建议：${current.enabled ? "已启用" : "已停用"} · 模型：${current.modelRef} · 思考：${current.thinking} · 长度上限：${current.maxSuggestionChars} · 接受键：${current.acceptKey}`,
      "info",
    );
    return;
  }

  let config = await loadNextSuggestConfig(defaultsPath);
  const modelLabel = (value: string): string => value === "session" ? "跟随会话模型" : value;
  const options = () => [
    `${config.enabled ? "✓" : "○"} 启用下一步建议（当前：${config.enabled ? "开" : "关"}）`,
    `生成模型：${modelLabel(config.modelRef)}（点击选择）`,
    `思考级别：${config.thinking}（点击调整）`,
    `建议长度上限：${config.maxSuggestionChars} 字符（点击修改）`,
    `接受键：${config.acceptKey}（修改后需重载插件生效）`,
    "重置为默认设置",
  ];

  for (;;) {
    const choice = await ctx.ui.select("下一步建议设置（/api-manager nextsuggest）", options());
    if (choice === undefined) return;

    if (choice.startsWith("✓") || choice.startsWith("○")) {
      config.enabled = !config.enabled;
      await saveNextSuggestConfig(config, defaultsPath);
      ctx.ui.notify(`下一步建议已${config.enabled ? "启用" : "停用"}。`, "info");
      continue;
    }

    if (choice.startsWith("生成模型")) {
      const models = await buildGlobalModelOptions("configure", modelsPath, defaultsPath);
      const labels = [
        `跟随会话模型${config.modelRef === "session" ? "（当前）" : ""}`,
        ...models.map((entry) => `${entry.label}${entry.pick.kind === "model" && config.modelRef === `${entry.pick.providerId}/${entry.pick.modelId}` ? "（当前）" : ""}`),
      ];
      const pick = await ctx.ui.select("选择建议生成模型（独立于会话模型）", labels);
      if (pick === undefined) continue;
      if (pick === labels[0]) {
        config.modelRef = "session";
      } else {
        const entry = models.find((item) => `${item.label}${item.pick.kind === "model" && config.modelRef === `${item.pick.providerId}/${item.pick.modelId}` ? "（当前）" : ""}` === pick);
        if (entry && entry.pick.kind === "model") {
          config.modelRef = `${entry.pick.providerId}/${entry.pick.modelId}`;
        }
      }
      await saveNextSuggestConfig(config, defaultsPath);
      ctx.ui.notify(`建议生成模型已设为：${modelLabel(config.modelRef)}。`, "info");
      continue;
    }

    if (choice.startsWith("思考级别")) {
      const levels = NEXT_SUGGEST_THINKING_LEVELS.map((level) =>
        `${level}${level === config.thinking ? "（当前）" : ""}`,
      );
      const pick = await ctx.ui.select("选择建议生成思考级别（default 跟随会话）", levels);
      if (pick === undefined) continue;
      const level = NEXT_SUGGEST_THINKING_LEVELS.find((value) => `${value}${value === config.thinking ? "（当前）" : ""}` === pick);
      if (level) {
        config.thinking = level;
        await saveNextSuggestConfig(config, defaultsPath);
        ctx.ui.notify(`建议思考级别已设为：${level}。`, "info");
      }
      continue;
    }

    if (choice.startsWith("建议长度上限")) {
      const input = await ctx.ui.input(
        "建议长度上限（字符，20–2000）",
        String(config.maxSuggestionChars),
      );
      if (input === undefined) continue;
      const parsed = Number.parseInt(input.trim(), 10);
      if (Number.isNaN(parsed) || parsed < 20 || parsed > 2000) {
        ctx.ui.notify("长度上限必须是 20–2000 之间的数字。", "warning");
        continue;
      }
      config.maxSuggestionChars = parsed;
      await saveNextSuggestConfig(config, defaultsPath);
      ctx.ui.notify(`建议长度上限已设为：${parsed} 字符。`, "info");
      continue;
    }

    if (choice.startsWith("接受键")) {
      const keys = NEXT_SUGGEST_ACCEPT_KEYS.map((key) =>
        `${key}${key === config.acceptKey ? "（当前）" : ""}`,
      );
      const pick = await ctx.ui.select("选择接受建议的快捷键（修改后需重载插件生效）", keys);
      if (pick === undefined) continue;
      const key = NEXT_SUGGEST_ACCEPT_KEYS.find((value) => `${value}${value === config.acceptKey ? "（当前）" : ""}` === pick);
      if (key) {
        config.acceptKey = key;
        await saveNextSuggestConfig(config, defaultsPath);
        ctx.ui.notify(`接受键已设为：${key}（重启或 /reload 后生效）。`, "info");
      }
      continue;
    }

    if (choice.startsWith("重置")) {
      const confirmed = await ctx.ui.confirm(
        "确认重置下一步建议设置为默认值？",
        [
          `将恢复为：${DEFAULT_NEXT_SUGGEST_CONFIG.enabled ? "启用" : "停用"} · 跟随会话模型 · 接受键 ${DEFAULT_NEXT_SUGGEST_CONFIG.acceptKey}`,
        ].join("\n"),
      );
      if (!confirmed) continue;
      config = { ...DEFAULT_NEXT_SUGGEST_CONFIG };
      await saveNextSuggestConfig(config, defaultsPath);
      ctx.ui.notify("下一步建议设置已重置为默认。", "info");
      continue;
    }
  }
}

const ENHANCE_THINKING_LEVELS = ["default", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const ENHANCE_CONTEXT_DEPTHS: readonly EnhanceContextDepth[] = ["none", "session", "codebase"];

/**
 * Prompt-enhance settings panel inside the API manager.
 *
 * The feature switch, generation model, thinking level, length cap, context
 * depth, git/file/knowledge toggles are independent from the session model
 * and persisted in the api-manager.json `enhance` section.
 */
export async function manageEnhanceSettings(
  ctx: ExtensionCommandContext,
  defaultsPath: string,
  modelsPath: string,
): Promise<void> {
  if (!ctx.hasUI) {
    const current = await loadEnhanceConfig(defaultsPath);
    ctx.ui.notify(
      `提示词增强：${current.enabled ? "已启用" : "已停用"} · 模型：${current.modelRef} · 思考：${current.thinking} · 上下文：${current.contextDepth} · 长度上限：${current.maxChars}`,
      "info",
    );
    return;
  }

  let config = await loadEnhanceConfig(defaultsPath);
  const modelLabel = (value: string): string => value === "session" ? "跟随会话模型" : value;
  const options = () => [
    `${config.enabled ? "✓" : "○"} 启用提示词增强（当前：${config.enabled ? "开" : "关"}）`,
    `生成模型：${modelLabel(config.modelRef)}（点击选择）`,
    `思考级别：${config.thinking}（点击调整）`,
    `增强结果长度上限：${config.maxChars} 字符（点击修改）`,
    `上下文深度：${config.contextDepth}（none/session/codebase，点击切换）`,
    `git log：${config.includeGit ? "✓" : "○"}（点击切换）`,
    `提及文件上限：${config.maxFiles}（点击修改）`,
    `Maestro 知识库搜索：${config.knowledgeSearch ? "✓" : "○"}（点击切换）`,
    `知识库命中条数：${config.knowledgeTopN}（点击修改）`,
    "重置为默认设置",
  ];

  for (;;) {
    const choice = await ctx.ui.select("提示词增强设置（/api-manager enhance）", options());
    if (choice === undefined) return;

    if (choice.startsWith("✓") || choice.startsWith("○")) {
      config.enabled = !config.enabled;
      await saveEnhanceConfig(config, defaultsPath);
      ctx.ui.notify(`提示词增强已${config.enabled ? "启用" : "停用"}。`, "info");
      continue;
    }

    if (choice.startsWith("生成模型")) {
      const models = await buildGlobalModelOptions("configure", modelsPath, defaultsPath);
      const labels = [
        `跟随会话模型${config.modelRef === "session" ? "（当前）" : ""}`,
        ...models.map((entry) => `${entry.label}${entry.pick.kind === "model" && config.modelRef === `${entry.pick.providerId}/${entry.pick.modelId}` ? "（当前）" : ""}`),
      ];
      const pick = await ctx.ui.select("选择增强生成模型（独立于会话模型）", labels);
      if (pick === undefined) continue;
      if (pick === labels[0]) {
        config.modelRef = "session";
      } else {
        const entry = models.find((item) => `${item.label}${item.pick.kind === "model" && config.modelRef === `${item.pick.providerId}/${item.pick.modelId}` ? "（当前）" : ""}` === pick);
        if (entry && entry.pick.kind === "model") {
          config.modelRef = `${entry.pick.providerId}/${entry.pick.modelId}`;
        }
      }
      await saveEnhanceConfig(config, defaultsPath);
      ctx.ui.notify(`增强生成模型已设为：${modelLabel(config.modelRef)}。`, "info");
      continue;
    }

    if (choice.startsWith("思考级别")) {
      const levels = ENHANCE_THINKING_LEVELS.map((level) =>
        `${level}${level === config.thinking ? "（当前）" : ""}`,
      );
      const pick = await ctx.ui.select("选择增强思考级别（default 跟随会话）", levels);
      if (pick === undefined) continue;
      const level = ENHANCE_THINKING_LEVELS.find((value) => `${value}${value === config.thinking ? "（当前）" : ""}` === pick);
      if (level) {
        config.thinking = level;
        await saveEnhanceConfig(config, defaultsPath);
        ctx.ui.notify(`增强思考级别已设为：${level}。`, "info");
      }
      continue;
    }

    if (choice.startsWith("增强结果长度上限")) {
      const input = await ctx.ui.input(
        "增强结果长度上限（字符，50–8000）",
        String(config.maxChars),
      );
      if (input === undefined) continue;
      const parsed = Number.parseInt(input.trim(), 10);
      if (Number.isNaN(parsed) || parsed < 50 || parsed > 8000) {
        ctx.ui.notify("长度上限必须是 50–8000 之间的数字。", "warning");
        continue;
      }
      config.maxChars = parsed;
      await saveEnhanceConfig(config, defaultsPath);
      ctx.ui.notify(`增强结果长度上限已设为：${parsed} 字符。`, "info");
      continue;
    }

    if (choice.startsWith("上下文深度")) {
      const depths = ENHANCE_CONTEXT_DEPTHS.map((d) => `${d}${d === config.contextDepth ? "（当前）" : ""}`);
      const pick = await ctx.ui.select("选择上下文深度（none=仅改写 / session=会话 / codebase=会话+代码库+知识库）", depths);
      if (pick === undefined) continue;
      const d = ENHANCE_CONTEXT_DEPTHS.find((value) => `${value}${value === config.contextDepth ? "（当前）" : ""}` === pick);
      if (d) {
        config.contextDepth = d;
        await saveEnhanceConfig(config, defaultsPath);
        ctx.ui.notify(`上下文深度已设为：${d}。`, "info");
      }
      continue;
    }

    if (choice.startsWith("git log")) {
      config.includeGit = !config.includeGit;
      await saveEnhanceConfig(config, defaultsPath);
      ctx.ui.notify(`git log 已${config.includeGit ? "开启" : "关闭"}。`, "info");
      continue;
    }

    if (choice.startsWith("提及文件上限")) {
      const input = await ctx.ui.input("提及文件上限（0–10）", String(config.maxFiles));
      if (input === undefined) continue;
      const parsed = Number.parseInt(input.trim(), 10);
      if (Number.isNaN(parsed) || parsed < 0 || parsed > 10) {
        ctx.ui.notify("提及文件上限必须是 0–10 之间的数字。", "warning");
        continue;
      }
      config.maxFiles = parsed;
      await saveEnhanceConfig(config, defaultsPath);
      ctx.ui.notify(`提及文件上限已设为：${parsed}。`, "info");
      continue;
    }

    if (choice.startsWith("Maestro 知识库搜索")) {
      config.knowledgeSearch = !config.knowledgeSearch;
      await saveEnhanceConfig(config, defaultsPath);
      ctx.ui.notify(`Maestro 知识库搜索已${config.knowledgeSearch ? "开启" : "关闭"}。`, "info");
      continue;
    }

    if (choice.startsWith("知识库命中条数")) {
      const input = await ctx.ui.input("知识库命中条数（1–20）", String(config.knowledgeTopN));
      if (input === undefined) continue;
      const parsed = Number.parseInt(input.trim(), 10);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 20) {
        ctx.ui.notify("知识库命中条数必须是 1–20 之间的数字。", "warning");
        continue;
      }
      config.knowledgeTopN = parsed;
      await saveEnhanceConfig(config, defaultsPath);
      ctx.ui.notify(`知识库命中条数已设为：${parsed}。`, "info");
      continue;
    }

    if (choice.startsWith("重置")) {
      const confirmed = await ctx.ui.confirm(
        "确认重置提示词增强设置为默认值？",
        `将恢复为：${DEFAULT_ENHANCE_CONFIG.enabled ? "启用" : "停用"} · ${DEFAULT_ENHANCE_CONFIG.contextDepth} 上下文 · 长度上限 ${DEFAULT_ENHANCE_CONFIG.maxChars}`,
      );
      if (!confirmed) continue;
      config = { ...DEFAULT_ENHANCE_CONFIG };
      await saveEnhanceConfig(config, defaultsPath);
      ctx.ui.notify("提示词增强设置已重置为默认。", "info");
      continue;
    }
  }
}

export async function manageAgentCacheRetention(
  ctx: ExtensionCommandContext,
  settingsPath: string,
  command?: CacheAgentManagerArgs,
): Promise<void> {
  const current = await loadAgentCacheRetention(settingsPath);
  if (command?.retention !== undefined) {
    await saveAgentCacheRetention(command.retention, settingsPath);
    applyCacheRetentionEnv(settingsPath);
    notifyAgentCacheRetention(ctx, command.retention, settingsPath);
    return;
  }
  if (!ctx.hasUI || command?.showOnly) {
    notifyAgentCacheRetention(ctx, current, settingsPath);
    return;
  }

  const tiers = ["short", "long", "none"] as const;
  const options = tiers.map((tier) => `${tier}${tier === current ? t("effort.currentMarker") : ""}`);
  const choice = await ctx.ui.select(
    "Agent 缓存档位（short: 5m/隐含 30m；long: 1h/24h；none: 不缓存）",
    options,
  );
  if (!choice) return;
  const tier = tiers.find((value) => `${value}${value === current ? t("effort.currentMarker") : ""}` === choice);
  if (!tier || !isAgentCacheRetention(tier)) return;
  const confirmed = await ctx.ui.confirm(
    "确认修改 Agent 缓存档位",
    [`将改为：${tier}`, "agent 子进程始终使用该档位，不继承主流程的 long 档。"].join("\n"),
  );
  if (!confirmed) return;
  await saveAgentCacheRetention(tier, settingsPath);
  applyCacheRetentionEnv(settingsPath);
  notifyAgentCacheRetention(ctx, tier, settingsPath);
}

function notifyAgentCacheRetention(
  ctx: Pick<ExtensionCommandContext, "ui">,
  retention: CacheRetention,
  settingsPath: string,
): void {
  const label = retention === "short"
    ? "short（5m / 隐含 30m）"
    : retention === "long"
      ? "long（1h / 24h）"
      : "none（不缓存）";
  ctx.ui.notify([
    `Agent 缓存档位：${label}`,
    `文件：${settingsPath}`,
  ].join("\n"), "info");
}

function notifyPromptCacheSettings(
  ctx: Pick<ExtensionCommandContext, "ui">,
  policy: PromptCachePolicy,
  settingsPath: string,
): void {
  const label = policy === "off"
    ? "off（不发送）"
    : policy === "on"
      ? "on（始终发送）"
      : "auto（仅 gpt-5.6+）";
  ctx.ui.notify([
    `提示缓存策略：${label}`,
    "gpt-5.6+ 模型将按策略发送 OpenAI 提示缓存参数；严格网关可能拒绝，遇 400 请切回 off。",
    `文件：${settingsPath}`,
  ].join("\n"), "info");
}

/**
 * Backfill cost rates for a channel's models missing a `cost` entry in
 * models.json: pi-ai built-in catalog first (api-aware), OpenRouter online
 * pricing second. Persisted through the same atomic write path as the config
 * wizard.
 */
async function backfillProviderCosts(
  ctx: ExtensionCommandContext,
  providerId: string,
  displayName: string,
  modelsPath: string,
): Promise<void> {
  const root = await readModelsRoot(modelsPath);
  const providers = isRecord(root.providers) ? root.providers : {};
  const config = isRecord(providers[providerId]) ? providers[providerId] : undefined;
  if (!config || !Array.isArray(config.models)) {
    ctx.ui.notify(`${displayName}：未配置模型，无法回填价格。`, "warning");
    return;
  }
  const models = config.models.filter(isRecord);
  if (models.length === 0) {
    ctx.ui.notify(`${displayName}：未配置模型，无法回填价格。`, "warning");
    return;
  }
  const configApi = typeof config.api === "string" ? config.api : undefined;
  const missing = models.filter((model) => typeof model.id === "string" && !isCost(model.cost));
  if (missing.length === 0) {
    ctx.ui.notify(`${displayName}：所有模型均已配置价格。`, "info");
    return;
  }
  const builtin = new Map<string, ModelCost>();
  for (const model of missing) {
    const api = typeof model.api === "string" ? model.api : configApi;
    const match = lookupBuiltinPricing(model.id as string, api);
    if (match) builtin.set(model.id as string, match.cost);
  }
  const unresolved = missing.map((model) => model.id as string).filter((id) => !builtin.has(id));
  const online = new Map<string, ModelCost>();
  if (unresolved.length > 0) {
    try {
      const openRouter = await fetchOpenRouterPricing();
      for (const id of unresolved) {
        const match = matchOpenRouterPricing(openRouter, id);
        if (match) online.set(id, match.cost);
      }
    } catch {
      // Offline: skip the online pass; unmatched ids are listed in the report.
    }
  }
  if (builtin.size + online.size === 0) {
    ctx.ui.notify(
      `${displayName}：内置表与 OpenRouter 均未命中定价（保持 $0）：${unresolved.join(", ")}`,
      "warning",
    );
    return;
  }
  await serializeMutation(modelsPath, async () => {
    const current = await readModelsRoot(modelsPath);
    const currentProviders = isRecord(current.providers) ? current.providers : {};
    const currentConfig = isRecord(currentProviders[providerId])
      ? { ...currentProviders[providerId] }
      : undefined;
    if (!currentConfig || !Array.isArray(currentConfig.models)) return;
    const nextModels = currentConfig.models.map((model) => {
      if (!isRecord(model) || typeof model.id !== "string") return model;
      const fill = builtin.get(model.id) ?? online.get(model.id);
      if (!fill || isCost(model.cost)) return model;
      return { ...model, cost: fill };
    });
    currentConfig.models = nextModels;
    await writeModelsRoot(
      { ...current, providers: { ...currentProviders, [providerId]: currentConfig } },
      modelsPath,
      true,
    );
  });
  const unmatched = unresolved.filter((id) => !online.has(id));
  ctx.ui.notify(
    [
      `${displayName}：已回填 ${builtin.size} 个（内置表）${online.size > 0 ? `、${online.size} 个（OpenRouter 在线）` : ""}模型的定价。`,
      ...(unmatched.length > 0 ? [`未匹配（保持 $0）：${unmatched.join(", ")}`] : []),
    ].join("\n"),
    "info",
  );
}

/** Pick a channel from every provider in models.json, native ones included. */
async function choosePriceProvider(
  ctx: ExtensionCommandContext,
  modelsPath: string,
): Promise<{ id: string; name: string } | undefined> {
  const ids = providerIdsInModels(modelsPath).sort();
  if (ids.length === 0) return undefined;
  const labels = new Map<string, string>();
  const options: string[] = [];
  for (const id of ids) {
    const preset = findPreset(id);
    const name = await channelDisplayName(id, modelsPath);
    const label = `${name} · ${id}${preset ? "（预设）" : ""}`;
    labels.set(label, id);
    options.push(label);
  }
  const choice = await ctx.ui.select("选择要回填价格的渠道（内置表 + OpenRouter 在线）", options);
  if (!choice) return undefined;
  const id = labels.get(choice);
  if (!id) return undefined;
  return { id, name: await channelDisplayName(id, modelsPath) };
}

function notifyRetrySettings(
  ctx: Pick<ExtensionCommandContext, "ui">,
  settings: ApiRetrySettings,
  settingsPath: string,
): void {
  ctx.ui.notify([
    t("retry.notifySummary", { state: settings.enabled ? t("retry.on") : t("retry.off") }),
    t("retry.count", { count: settings.maxRetries }),
    t("retry.maxDelay", { delay: settings.maxDelayMs ?? RESOLVED_NETWORK_RETRY_POLICY.maxDelayMs }),
    t("retry.notifyPath", { path: settingsPath }),
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
    ctx.ui.notify(t("manager.needTui"), "warning");
    return;
  }
  const action = parsed.action ?? await chooseAction(ctx, settingsPath, dirname(modelsPath));
  if (!action) return;
  if (action === "vision") {
    if (!ctx.hasUI) {
      ctx.ui.notify(t("manager.visionNeedTui"), "warning");
      return;
    }
    await showVisionDelegationManager(ctx, dirname(modelsPath));
    return;
  }
  if (action === "effort") {
    if (!ctx.hasUI) {
      ctx.ui.notify(t("manager.effortNeedTui"), "warning");
      return;
    }
    await adjustThinkingEffort(pi, ctx, defaultsPath);
    return;
  }
  if (action === "list") {
    await listProviders(ctx, modelsPath, defaultsPath, settingsPath);
    return;
  }
  if (action === "provider") {
    if (!ctx.hasUI) {
      ctx.ui.notify(t("manager.actionNeedTui", { action }), "warning");
      return;
    }
    const target = parsed.target ?? await chooseProvider(ctx, modelsPath, defaultsPath);
    if (!target) return;
    const ref = await resolveChannelRef(target, ctx, modelsPath);
    if (!ref) return;
    await configureProviderConnection(ctx, ref.id, ref.name, modelsPath, defaultsPath);
    return;
  }
  if (action === "retry") {
    await manageRetrySettings(ctx, settingsPath, parsed.retry);
    return;
  }
  if (action === "cache") {
    await managePromptCacheSettings(ctx, settingsPath, parsed.cache);
    return;
  }
  if (action === "cache-agent") {
    await manageAgentCacheRetention(ctx, settingsPath, parsed.cacheAgent);
    return;
  }
  if (action === "nextsuggest") {
    await manageNextSuggestSettings(ctx, defaultsPath, modelsPath);
    return;
  }
  if (action === "enhance") {
    await manageEnhanceSettings(ctx, defaultsPath, modelsPath);
    return;
  }
  if (action === "export" || action === "import") {
    const fallbackPath = defaultApiManagerExportPath(modelsPath);
    const promptKey = action === "export" ? "manager.exportPathPrompt" : "manager.importPathPrompt";
    const input = parsed.filePath
      ?? (ctx.hasUI ? await ctx.ui.input(t(promptKey), fallbackPath) : fallbackPath);
    const targetPath = input?.trim();
    if (!targetPath) return;
    if (action === "export") {
      await exportApiManagerConfig(ctx, targetPath, modelsPath, defaultsPath);
    } else {
      await importApiManagerConfig(pi, ctx, targetPath, modelsPath, defaultsPath, settingsPath);
    }
    return;
  }
  if (action === "price") {
    // A literal provider id in models.json (e.g. the native "openai" channel)
    // wins over preset aliases, so native channels are addressable by id too.
    const rawTarget = args.trim().split(/\s+/).filter(Boolean)[1];
    const literal = rawTarget && providerIdsInModels(modelsPath).includes(rawTarget)
      ? rawTarget
      : undefined;
    let providerId: string | undefined;
    let displayName: string | undefined;
    if (literal) {
      providerId = literal;
      displayName = await channelDisplayName(literal, modelsPath);
    } else if (parsed.target) {
      const ref = await resolveChannelRef(parsed.target, ctx, modelsPath);
      if (!ref) return;
      providerId = ref.id;
      displayName = ref.name;
    } else if (ctx.hasUI) {
      const pick = await choosePriceProvider(ctx, modelsPath);
      if (!pick) return;
      providerId = pick.id;
      displayName = pick.name;
    }
    if (!providerId) {
      ctx.ui.notify(t("manager.specifyProvider"), "warning");
      return;
    }
    await backfillProviderCosts(ctx, providerId, displayName ?? providerId, modelsPath);
    return;
  }
  if (action === "stats") {
    const stats = parsed.stats ?? {};
    if (stats.footer) {
      await manageStatsFooter(ctx, defaultsPath, stats.footer);
      return;
    }
    if (stats.off) {
      ctx.ui.notify("用量统计面板为 overlay 模式，按 q/Esc 关闭。", "info");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("/api-manager stats 需要交互式 Pi 会话。", "warning");
      return;
    }
    await showUsageStatsPanel(ctx);
    return;
  }
  if (action === "enable" || action === "disable" || action === "toggle") {
    if (!ctx.hasUI && !parsed.target) {
      ctx.ui.notify(t("manager.needProviderId", { action }), "warning");
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
      ctx.ui.notify(t("manager.configureNeedTui"), "warning");
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
        ctx.ui.notify(t("manager.actionNeedTui", { action }), "warning");
        return;
      }
      await deleteProvider(pi, ref.id, ref.name, ctx, modelsPath, defaultsPath, settingsPath);
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(t("manager.actionNeedTui", { action }), "warning");
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
    ctx.ui.notify(t("manager.specifyProvider"), "warning");
    return;
  }
  const ref = await resolveChannelRef(target, ctx, modelsPath);
  if (!ref) return;
  if (!ctx.hasUI) {
    ctx.ui.notify(t("manager.actionNeedTui", { action }), "warning");
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
  if (!target.adding && modelIds.length !== 1) throw new Error("修改已有模型时只能指定一个 Model ID");
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
    await loadModelThinkingDefault(targetProviderId, target.modelId ?? modelIds[0], defaultsPath)
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
    t("form.confirm.preset", { name: provider.name }),
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
  const wasAdding = target.modelId === null;
  const previousModelId = target.modelId ?? undefined;
  let result: SaveApiProviderResult | undefined;
  for (const [index, nextModelId] of modelIds.entries()) {
    const next: ApiProviderSettings = {
      provider: targetProviderId,
      baseUrl,
      modelId: nextModelId,
      previousModelId,
      contextWindow,
      maxTokens,
      reasoning,
      multimodal,
      apiKey,
      maxThinking,
    };
    result = await saveApiProviderSettings(next, modelsPath);
    if (previousModelId !== undefined && previousModelId !== nextModelId) {
      await renameModelThinkingDefault(targetProviderId, previousModelId, nextModelId, defaultsPath);
      await renameDefaultModelRef(ctx, modelsPath, targetProviderId, previousModelId, nextModelId);
    }
    await saveModelThinkingDefault(
      targetProviderId,
      nextModelId,
      canonicalThinkingLevel(defaultThinkingLevel),
      defaultsPath,
    );
    if (index === 0) await saveDefaultModelAndThinking(ctx, modelsPath, targetProviderId, nextModelId, wasAdding);
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

/** Dynamic model discovery + selective injection into Pi. */
type DiscoverOutcome = "injected" | "manual" | "cancel";

async function discoverAndInjectModels(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  providerId: string,
  displayName: string,
  api: string,
  baseUrl: string,
  savedApiKey: string,
  modelsPath: string,
  defaultsPath: string,
): Promise<DiscoverOutcome> {
  const discover = await ctx.ui.confirm(
    t("discovery.prompt"),
    `${displayName} · ${baseUrl}`,
  );
  if (!discover) return "manual";

  // The caller gates discovery on a saved key, but guard defensively in case
  // a configured Provider's key was cleared between the gate and this probe.
  let apiKey = savedApiKey;
  if (!apiKey) {
    const keyInput = await ctx.ui.input(`${displayName} API key`, "");
    if (keyInput === undefined) return "cancel";
    apiKey = required(keyInput, "API key");
  }

  const modelsUrl = `${baseUrl}/models`;
  ctx.ui.notify(t("discovery.discovering", { url: modelsUrl }), "info");
  let discovered: DiscoveredModel[];
  try {
    discovered = await discoverModels({ baseUrl, apiKey, timeoutMs: 8000 });
  } catch (error) {
    ctx.ui.notify(t("discovery.failed", { message: errorMessage(error) }), "warning");
    ctx.ui.notify(t("discovery.keepManual"), "info");
    return "manual";
  }
  if (discovered.length === 0) {
    ctx.ui.notify(t("discovery.empty"), "warning");
    ctx.ui.notify(t("discovery.keepManual"), "info");
    return "manual";
  }

  const configured = new Set(await configuredModelIds(providerId, modelsPath));
  const selected = new Set<string>();
  const selectable = discovered.filter((model) => !configured.has(model.id));
  if (selectable.length === 0) {
    ctx.ui.notify(t("discovery.injectedNone"), "info");
    return "manual";
  }

  // Loop: pick one model at a time; repeats allowed until “Done”. Already-picked
  // ids are tagged so the user can see progress; already-configured ones are
  // listed but skipped on selection.
  while (true) {
    const options = selectable.map((model) => {
      const tag = selected.has(model.id) ? t("discovery.selected") : "";
      return `${model.id}${tag}`;
    });
    options.push(t("discovery.done", { count: selected.size }));
    const choice = await ctx.ui.select(t("discovery.selectTitle"), options);
    if (choice === undefined) return "cancel";
    const doneLabel = options[options.length - 1];
    if (choice === doneLabel) break;
    const picked = selectable.find((model) => `${model.id}${selected.has(model.id) ? t("discovery.selected") : ""}` === choice);
    if (picked) selected.add(picked.id);
  }

  if (selected.size === 0) {
    ctx.ui.notify(t("discovery.injectedNone"), "info");
    return "manual";
  }

  let result: SaveApiProviderResult | undefined;
  for (const modelId of selected) {
    const next: ApiProviderSettings = {
      provider: providerId,
      baseUrl,
      modelId,
      contextWindow: 128_000,
      maxTokens: 16_384,
      reasoning: true,
      apiKey,
      api,
      name: displayName,
    };
    result = await saveApiProviderSettings(next, modelsPath);
    if (!findPreset(providerId)) await addManagedProvider(defaultsPath, providerId);
  }
  reloadProviderRegistration(pi, ctx, providerId, modelsPath);
  const ids = [...selected];
  ctx.ui.notify(
    t("discovery.injected", { count: ids.length, models: ids.map((id) => `${providerId}/${id}`).join(", ") }),
    "info",
  );
  if (!result) throw new Error("Discovered models were not written");
  return "injected";
}

/**
 * Form-level discovery: probe /models using the form's current Base URL/API key
 * (falling back to saved values) and exclude already-configured model ids.
 */
async function discoverFormModelIds(
  values: ApiModelFormValues,
  providerId: string,
  current: LoadedApiProviderSettings,
  modelsPath: string,
): Promise<string[]> {
  const rawBaseUrl = formText(values, "baseUrl").trim() || current.baseUrl;
  if (!rawBaseUrl) throw new Error(t("discovery.noConnection"));
  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  const apiKey = formText(values, "apiKey") || current.apiKey;
  const discovered = await discoverModels({ baseUrl, apiKey: apiKey || undefined });
  const configured = new Set(await configuredModelIds(providerId, modelsPath));
  return discovered.map((model) => model.id).filter((id) => !configured.has(id));
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
  // On the add path, offer to discover models from the server instead of
  // typing each Model ID by hand — but only when the Provider already has a
  // saved API key, since discovery needs a working credential to authenticate
  // against /models. A brand-new Provider with no saved key keeps the manual
  // entry flow unchanged. Falls through to manual entry on cancel/failure.
  if (target.adding && current.apiKey) {
    const outcome = await discoverAndInjectModels(
      pi,
      ctx,
      providerId,
      displayName,
      api,
      baseUrl,
      current.apiKey,
      modelsPath,
      defaultsPath,
    );
    if (outcome === "injected" || outcome === "cancel") return;
  }
  const modelInput = await ctx.ui.input(
    `${displayName} model ID`,
    target.adding ? "" : current.configured ? current.modelId : "",
  );
  if (modelInput === undefined) return;
  const modelIds = parseModelIdList(modelInput);
  if (modelIds.length === 0) throw new Error("Model ID 不能为空");
  if (!target.adding && modelIds.length !== 1) throw new Error("修改已有模型时只能指定一个 Model ID");
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
    await loadModelThinkingDefault(targetProviderId, target.modelId ?? modelIds[0], defaultsPath)
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
  const wasAdding = target.modelId === null;
  const previousModelId = target.modelId ?? undefined;
  let result: SaveApiProviderResult | undefined;
  for (const [index, nextModelId] of modelIds.entries()) {
    const next: ApiProviderSettings = {
      provider: targetProviderId,
      baseUrl,
      modelId: nextModelId,
      previousModelId,
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
    if (previousModelId !== undefined && previousModelId !== nextModelId) {
      await renameModelThinkingDefault(targetProviderId, previousModelId, nextModelId, defaultsPath);
      await renameDefaultModelRef(ctx, modelsPath, targetProviderId, previousModelId, nextModelId);
    }
    await saveModelThinkingDefault(
      targetProviderId,
      nextModelId,
      canonicalThinkingLevel(defaultThinkingLevel),
      defaultsPath,
    );
    if (index === 0) await saveDefaultModelAndThinking(ctx, modelsPath, targetProviderId, nextModelId, wasAdding);
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
    title: adding
      ? t("form.title.add", { name: provider.name })
      : t("form.title.edit", { name: provider.name, model: modelId }),
    locale: getTuiLocale(),
    fields: [
      { id: "connection-section", label: t("form.section.connection"), kind: "section", value: "" },
      { id: "provider", label: "Provider", kind: "readonly", value: provider.id },
      { id: "api", label: "API format", kind: "readonly", value: apiFormatLabel(provider.api) },
      { id: "baseUrl", label: "Base URL", kind: "text", value: current.baseUrl },
      {
        id: "apiKey",
        label: "API key",
        kind: "secret",
        value: current.apiKey,
        help: t("form.help.apiKey"),
      },
      { id: "model-section", label: t("form.section.model"), kind: "section", value: "" },
      {
        id: "modelId",
        label: "Model ID",
        kind: "text",
        value: adding ? (current.configured ? "" : provider.modelId) : current.modelId,
        help: adding ? t("form.help.modelAdd") : t("form.help.modelEdit"),
        discoverable: true,
      },
      { id: "reasoning", label: t("form.label.reasoning"), kind: "toggle", value: current.reasoning },
      {
        id: "defaultThinking",
        label: t("form.label.defaultThinking"),
        kind: "choice",
        value: reconcileFormThinkingLevel(provider.api, current.reasoning, currentThinking, maxThinking),
        choices: thinkingFormChoices(provider.api, maxThinking),
      },
      { id: "contextWindow", label: t("form.label.contextWindow"), kind: "number", value: String(current.contextWindow) },
      { id: "maxTokens", label: t("form.label.maxTokens"), kind: "number", value: String(current.maxTokens) },
      {
        id: "multimodal",
        label: t("form.label.multimodal"),
        kind: "toggle",
        value: current.multimodal !== false,
        help: t("form.help.multimodal"),
      },
    ],
    validate: (values) => validateApiModelForm(
      values,
      provider.api,
      maxThinking,
      adding ? existingModelIds : existingModelIds.filter((id) => id !== modelId),
      !adding,
    ),
    discoverModels: (values) => discoverFormModelIds(values, provider.id, current, modelsPath),
  });
  if (!result) return;

  const baseUrl = normalizeBaseUrl(formText(result.values, "baseUrl"));
  const nextModelIds = parseModelIdList(formText(result.values, "modelId"));
  const targetProviderId = provider.id;
  const reasoning = formBoolean(result.values, "reasoning");
  const multimodal = formBooleanOrDefault(result.values, "multimodal", current.multimodal !== false);
  const defaultThinkingLevel = formThinkingLevel(result.values, "defaultThinking");
  const contextWindow = positiveInteger(formText(result.values, "contextWindow"), t("form.label.contextWindow"));
  const maxTokens = positiveInteger(formText(result.values, "maxTokens"), t("form.label.maxTokens"));
  validateModelWindow(contextWindow, maxTokens);
  const apiKey = required(formText(result.values, "apiKey"), "API key");
  const confirmed = await ctx.ui.confirm(
    t("form.confirm.preset", { name: provider.name }),
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
      previousModelId: adding ? undefined : modelId,
      contextWindow,
      maxTokens,
      reasoning,
      multimodal,
      apiKey,
      maxThinking,
    };
    saveResult = await saveApiProviderSettings(next, modelsPath);
    if (!adding && modelId !== nextModelId) {
      await renameModelThinkingDefault(targetProviderId, modelId, nextModelId, defaultsPath);
      await renameDefaultModelRef(ctx, modelsPath, targetProviderId, modelId, nextModelId);
    }
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
    t("form.saved", {
      count: nextModelIds.length,
      models: nextModelIds.map((id) => `${targetProviderId}/${id}`).join(", "),
      level: defaultThinkingLevel,
    }),
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
    title: adding
      ? t("form.title.add", { name: displayName })
      : t("form.title.edit", { name: displayName, model: modelId }),
    locale: getTuiLocale(),
    fields: [
      { id: "connection-section", label: t("form.section.connection"), kind: "section", value: "" },
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
      { id: "name", label: t("form.label.providerName"), kind: "text", value: current.name ?? providerId },
      { id: "baseUrl", label: "Base URL", kind: "text", value: current.baseUrl },
      {
        id: "apiKey",
        label: "API key",
        kind: "secret",
        value: current.apiKey,
        help: t("form.help.apiKey"),
      },
      {
        id: "headers",
        label: t("form.label.headers"),
        kind: "secret",
        value: JSON.stringify(current.headers ?? {}),
        help: t("form.help.headers"),
      },
      {
        id: "authHeader",
        label: t("form.label.authHeader"),
        kind: "choice",
        value: triStateValue(current.authHeader),
        choices: [
          { label: t("form.choice.auto"), value: "auto" },
          { label: t("form.choice.bearer"), value: "true" },
          { label: t("form.choice.noSend"), value: "false" },
        ],
      },
      { id: "compat-section", label: t("form.section.compat"), kind: "section", value: "" },
      {
        id: "thinkingFormat",
        label: "Thinking format",
        kind: "choice",
        value: typeof compat.thinkingFormat === "string" ? compat.thinkingFormat : "",
        choices: formChoicesWithCurrent(
          typeof compat.thinkingFormat === "string" ? compat.thinkingFormat : "",
          [{ label: t("form.choice.autoUrl"), value: "" }, ...thinkingFormatOptions().flatMap((entry) =>
            entry.value ? [{ label: entry.label, value: entry.value }] : []
          )],
        ),
      },
      {
        id: "supportsDeveloperRole",
        label: t("form.label.developerRole"),
        kind: "choice",
        value: triStateValue(compat.supportsDeveloperRole),
        choices: triStateChoices(),
      },
      {
        id: "supportsReasoningEffort",
        label: "Reasoning effort",
        kind: "choice",
        value: triStateValue(compat.supportsReasoningEffort),
        choices: triStateChoices(),
      },
      {
        id: "maxTokensField",
        label: t("form.label.maxTokensField"),
        kind: "choice",
        value: typeof compat.maxTokensField === "string" ? compat.maxTokensField : "",
        choices: formChoicesWithCurrent(
          typeof compat.maxTokensField === "string" ? compat.maxTokensField : "",
          [
            { label: t("form.choice.auto"), value: "" },
            { label: "max_completion_tokens", value: "max_completion_tokens" },
            { label: "max_tokens", value: "max_tokens" },
          ],
        ),
      },
      { id: "model-section", label: t("form.section.model"), kind: "section", value: "" },
      {
        id: "modelId",
        label: "Model ID",
        kind: "text",
        value: adding ? "" : current.modelId,
        help: adding ? t("form.help.modelAdd") : t("form.help.modelEdit"),
        discoverable: true,
      },
      { id: "reasoning", label: t("form.label.reasoning"), kind: "toggle", value: current.reasoning },
      {
        id: "defaultThinking",
        label: t("form.label.defaultThinking"),
        kind: "choice",
        value: reconcileFormThinkingLevel(currentApi, current.reasoning, currentThinking, maxThinking),
        choices: thinkingFormChoices(currentApi, maxThinking),
      },
      { id: "contextWindow", label: t("form.label.contextWindow"), kind: "number", value: String(current.contextWindow) },
      { id: "maxTokens", label: t("form.label.maxTokens"), kind: "number", value: String(current.maxTokens) },
      {
        id: "multimodal",
        label: t("form.label.multimodal"),
        kind: "toggle",
        value: current.multimodal !== false,
        help: t("form.help.multimodal"),
      },
    ],
    validate: (values) => {
      const errors = validateApiModelForm(
        values,
        formText(values, "api"),
        maxThinking,
        adding ? existingModelIds : existingModelIds.filter((id) => id !== modelId),
        !adding,
      );
      try {
        parseHeadersForm(formText(values, "headers"));
      } catch (error) {
        errors.push(errorMessage(error));
      }
      return errors;
    },
    discoverModels: (values) => discoverFormModelIds(values, providerId, current, modelsPath),
  });
  if (!result) return;

  const api = required(formText(result.values, "api"), "API type");
  const nextDisplayName = formText(result.values, "name").trim() || providerId;
  const baseUrl = normalizeBaseUrl(formText(result.values, "baseUrl"));
  const nextModelIds = parseModelIdList(formText(result.values, "modelId"));
  const targetProviderId = providerId;
  const reasoning = formBoolean(result.values, "reasoning");
  const multimodal = formBooleanOrDefault(result.values, "multimodal", current.multimodal !== false);
  const defaultThinkingLevel = formThinkingLevel(result.values, "defaultThinking");
  const contextWindow = positiveInteger(formText(result.values, "contextWindow"), t("form.label.contextWindow"));
  const maxTokens = positiveInteger(formText(result.values, "maxTokens"), t("form.label.maxTokens"));
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
    t("form.confirm.provider", { name: nextDisplayName }),
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
      t("form.preview.compat", {
        value: nextCompat && Object.keys(nextCompat).length > 0
          ? JSON.stringify(nextCompat)
          : t("form.choice.auto"),
      }),
      t("form.preview.headers", {
        value: Object.keys(headers).length > 0 ? Object.keys(headers).join(", ") : t("form.value.none"),
      }),
      t("form.preview.authorization", {
        value: authHeader === undefined
          ? t("form.choice.auto")
          : authHeader ? t("form.choice.bearer") : t("retry.off"),
      }),
    ].join("\n"),
  );
  if (!confirmed) return;
  let saveResult: SaveApiProviderResult | undefined;
  for (const [index, nextModelId] of nextModelIds.entries()) {
    const next: ApiProviderSettings = {
      provider: targetProviderId,
      baseUrl,
      modelId: nextModelId,
      previousModelId: adding ? undefined : modelId,
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
    if (!adding && modelId !== nextModelId) {
      await renameModelThinkingDefault(targetProviderId, modelId, nextModelId, defaultsPath);
      await renameDefaultModelRef(ctx, modelsPath, targetProviderId, modelId, nextModelId);
    }
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
    t("form.saved", {
      count: nextModelIds.length,
      models: nextModelIds.map((id) => `${targetProviderId}/${id}`).join(", "),
      level: defaultThinkingLevel,
    }),
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
  const state = (enabled: boolean): string => t(enabled ? "preview.enabled" : "preview.disabled");
  return [
    t("preview.provider", { value: input.providerId }),
    t("preview.api", { value: apiFormatLabel(input.api) }),
    t("preview.baseUrl", { value: input.baseUrl }),
    t("preview.model", { value: input.modelIds.join(", ") }),
    t("preview.contextWindow", { value: input.contextWindow.toLocaleString(getTuiLocale()) }),
    t("preview.maxTokens", { value: input.maxTokens.toLocaleString(getTuiLocale()) }),
    ...compactionPreviewLines(input.cwd, input.contextWindow, input.maxTokens),
    t("preview.reasoning", { value: state(input.reasoning) }),
    t("preview.multimodal", { value: state(input.multimodal) }),
    t("preview.defaultThinking", { value: input.defaultThinkingLevel }),
    t("preview.auth"),
    t("preview.isolation"),
  ].join("\n");
}

/** Split a comma-separated Model ID list (form array input) into non-empty IDs. */
function parseModelIdList(value: string): string[] {
  return value.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
}

function triStateChoices(): ApiModelFormChoice[] {
  return [
    { label: t("form.choice.auto"), value: "auto" },
    { label: t("form.choice.supported"), value: "true" },
    { label: t("form.choice.unsupported"), value: "false" },
  ];
}

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
  single = false,
): string[] {
  const errors: string[] = [];
  try {
    normalizeBaseUrl(formText(values, "baseUrl"));
    const modelIds = parseModelIdList(formText(values, "modelId"));
    if (modelIds.length === 0) throw new Error(t("validation.modelRequired"));
    if (single && modelIds.length !== 1) errors.push(t("validation.singleModel"));
    const seen = new Set<string>();
    for (const modelId of modelIds) {
      if (seen.has(modelId)) errors.push(t("validation.duplicateModel", { model: modelId }));
      seen.add(modelId);
      if (duplicateModelIds?.includes(modelId)) {
        errors.push(t("validation.modelExists", { model: modelId }));
      }
    }
    const contextWindow = positiveInteger(formText(values, "contextWindow"), t("form.label.contextWindow"));
    const maxTokens = positiveInteger(formText(values, "maxTokens"), t("form.label.maxTokens"));
    validateModelWindow(contextWindow, maxTokens);
    required(formText(values, "apiKey"), "API key");
    const reasoning = formBoolean(values, "reasoning");
    const thinking = formThinkingLevel(values, "defaultThinking");
    const supported: ApiThinkingLevel[] = reasoning ? supportedThinkingFormValues(api, maxThinking) : ["off"];
    if (!supported.includes(thinking)) {
      errors.push(t("validation.thinkingIncompatible", { level: thinking }));
    }
  } catch (error) {
    errors.push(errorMessage(error));
  }
  return errors;
}

function formText(values: ApiModelFormValues, id: string): string {
  const value = values[id];
  if (typeof value !== "string") throw new Error(t("validation.fieldInvalid", { field: id }));
  return value;
}

function formBoolean(values: ApiModelFormValues, id: string): boolean {
  const value = values[id];
  if (typeof value !== "boolean") throw new Error(t("validation.fieldInvalid", { field: id }));
  return value;
}

function formBooleanOrDefault(values: ApiModelFormValues, id: string, fallback: boolean): boolean {
  const value = values[id];
  return typeof value === "boolean" ? value : fallback;
}

function formThinkingLevel(values: ApiModelFormValues, id: string): ApiThinkingLevel {
  const value = formText(values, id);
  if (!isThinkingLevel(value)) throw new Error(t("validation.thinkingInvalid", { level: value }));
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
    throw new Error(t("validation.headersJson"));
  }
  if (!isStringRecord(parsed)) throw new Error(t("validation.headersObject"));
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
  buildGlobalModelOptions,
  chooseModelGlobally,
  chooseModelToConfigure,
  chooseProvider,
  compactionPreviewLines,
  configuredModelIds,
  configuredProviderIds,
  configuredProviderRegistration,
  configureProviderConnection,
  currentDefaultThinkingLevel,
  defaultApiManagerExportPath,
  deleteProvider,
  dispatchGlobalModelPick,
  errorMessage,
  exportApiManagerConfig,
  fileExists,
  findPreset,
  hasEnabledProviderSync,
  importApiManagerConfig,
  isPositiveInteger,
  isProviderConfigured,
  isProviderEnabled,
  isRecord,
  isCost,
  isStringRecord,
  isThinkingLevel,
  listProviders,
  loadEffortLevels,
  loadModelThinkingDefault,
  managedProviderIdsSync,
  migrateLegacyProviderThinkingMaps,
  normalizeChannelId,
  notifySaved,
  parseManagerArgs,
  positiveInteger,
  providerIdsInModels,
  readModelsRoot,
  reloadProviderRegistration,
  removeProviderKey,
  renameDefaultModelRef,
  renameModelThinkingDefault,
  resetEffortLevels,
  required,
  resetProvider,
  resolveChannelRef,
  retryCount,
  runtimeSupportsMaxThinking,
  saveDefaultModelAndThinking,
  saveEffortLevels,
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
import type { CacheAgentManagerArgs, CacheManagerArgs, ConfigureModelTarget, EffortLevelEntry, RetryManagerArgs } from "./api-provider-ops.ts";
import { showUsageStatsPanel } from "./usage-stats-panel.ts";
import {
  applyCacheRetentionEnv,
  isAgentCacheRetention,
  isPromptCachePolicy,
  loadAgentCacheRetention,
  loadPromptCachePolicy,
  PROMPT_CACHE_POLICIES,
  saveAgentCacheRetention,
  savePromptCachePolicy,
  type CacheRetention,
  type PromptCachePolicy,
} from "./prompt-cache-policy.ts";

// ---------------------------------------------------------------------------
// statsFooter section (api-manager.json) — toggles the statusline usage sparkline
// ---------------------------------------------------------------------------

interface StatsFooterConfig {
  enabled: boolean;
  metric: "tokens" | "cost" | "cache";
  points: number;
}

const DEFAULT_STATS_FOOTER: StatsFooterConfig = { enabled: false, metric: "tokens", points: 12 };

async function loadStatsFooterConfig(defaultsPath: string): Promise<StatsFooterConfig> {
  if (!await fileExists(defaultsPath)) return { ...DEFAULT_STATS_FOOTER };
  const root = await readModelsRoot(defaultsPath);
  const section = root.statsFooter;
  if (!section || typeof section !== "object") return { ...DEFAULT_STATS_FOOTER };
  const s = section as Record<string, unknown>;
  return {
    enabled: s.enabled === true,
    metric: s.metric === "cost" || s.metric === "cache" ? s.metric : "tokens",
    points: typeof s.points === "number" && s.points >= 4 && s.points <= 64 ? Math.floor(s.points) : 12,
  };
}

async function saveStatsFooterConfig(config: StatsFooterConfig, defaultsPath: string): Promise<void> {
  await serializeMutation(defaultsPath, async () => {
    const exists = await fileExists(defaultsPath);
    const root = await readModelsRoot(defaultsPath);
    await writeModelsRoot({ ...root, statsFooter: { ...config } }, defaultsPath, exists);
  });
}

async function manageStatsFooter(
  ctx: ExtensionCommandContext,
  defaultsPath: string,
  mode: "on" | "off" | "show",
): Promise<void> {
  const current = await loadStatsFooterConfig(defaultsPath);
  if (mode === "show") {
    ctx.ui.notify(
      `Footer 用量 sparkline：${current.enabled ? "开启" : "关闭"} · 维度 ${current.metric} · ${current.points} 点`,
      "info",
    );
    return;
  }
  const next: StatsFooterConfig = { ...current, enabled: mode === "on" };
  await saveStatsFooterConfig(next, defaultsPath);
  ctx.ui.notify(
    `Footer 用量 sparkline 已${mode === "on" ? "开启" : "关闭"}。${mode === "on" ? "下个会话起生效，宽度≥100 列时显示。" : ""}`,
    "info",
  );
}


