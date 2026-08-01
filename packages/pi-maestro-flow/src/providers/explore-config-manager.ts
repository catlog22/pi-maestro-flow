import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  showApiModelEditor,
  type ApiModelFormChoice,
  type ApiModelFormValues,
} from "../tui/api-model-editor.ts";
import { sanitizeSingleLineInput } from "../tui/input-text.ts";

export type ExploreApiFormat = "openai" | "anthropic" | "openai-responses";

export interface ExploreEndpointConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  format?: ExploreApiFormat;
  extraBody?: Record<string, unknown>;
  concurrency?: number;
  maxTurns?: number;
  [key: string]: unknown;
}

export interface ExploreConfigRoot {
  endpoints?: Record<string, unknown>;
  maxTurns?: number;
  concurrency?: number;
  treeDepth?: number;
  [key: string]: unknown;
}

export interface ExploreConfigState {
  root: ExploreConfigRoot;
  source: "canonical" | "legacy" | "none";
  activePath: string;
}

export interface RegisterExploreConfigOptions {
  configPath?: string;
  legacyPath?: string;
}

type ExploreManagerAction = "list" | "add" | "edit" | "show" | "delete" | "defaults";

const FORMATS: readonly ApiModelFormChoice[] = [
  { label: "OpenAI Chat Completions", value: "openai" },
  { label: "Anthropic Messages", value: "anthropic" },
  { label: "OpenAI Responses", value: "openai-responses" },
];

const mutationQueues = new Map<string, Promise<void>>();

export function registerExploreConfigManager(
  pi: ExtensionAPI,
  options: RegisterExploreConfigOptions = {},
): void {
  if (typeof pi.registerCommand !== "function") return;
  const configPath = options.configPath ?? join(homedir(), ".maestro", "api.json");
  const legacyPath = options.legacyPath ?? join(homedir(), ".maestro", "api-explore.json");

  pi.registerCommand("explore-manager", {
    description: "管理 Maestro Explore API endpoints",
    async handler(args, ctx) {
      try {
        await showExploreConfigManager(ctx, args, configPath, legacyPath);
      } catch (error) {
        ctx.ui.notify(`Explore 配置失败：${errorMessage(error)}`, "error");
      }
    },
  });
}

export async function loadExploreConfigState(
  configPath = join(homedir(), ".maestro", "api.json"),
  legacyPath = join(homedir(), ".maestro", "api-explore.json"),
): Promise<ExploreConfigState> {
  const canonical = await readConfigIfPresent(configPath);
  if (canonical) return { root: canonical, source: "canonical", activePath: configPath };
  const legacy = await readConfigIfPresent(legacyPath);
  if (legacy) return { root: legacy, source: "legacy", activePath: legacyPath };
  return { root: {}, source: "none", activePath: configPath };
}

async function showExploreConfigManager(
  ctx: ExtensionCommandContext,
  args: string,
  configPath: string,
  legacyPath: string,
): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let action = actionFromArg(tokens[0]);
  let endpointName: string | undefined = tokens[1];

  if (!action) {
    if (tokens.length > 0) {
      ctx.ui.notify("用法：/explore-manager [list|add|edit|show|delete|defaults] [endpoint]", "warning");
      return;
    }
    if (!ctx.hasUI) action = "list";
    else action = await chooseAction(ctx);
  }
  if (!action) return;

  if (action === "list") {
    await listEndpoints(ctx, configPath, legacyPath);
    return;
  }
  if (action === "defaults") {
    await configureDefaults(ctx, configPath, legacyPath);
    return;
  }

  const state = await loadExploreConfigState(configPath, legacyPath);
  const endpoints = endpointMap(state.root);
  if (!endpointName && action !== "add") {
    endpointName = await chooseEndpoint(ctx, endpoints, action);
  }
  if (!endpointName && action === "add") {
    endpointName = await ctx.ui.input("Endpoint 名称", "");
  }
  if (!endpointName) return;

  if (action === "show") {
    showEndpoint(ctx, endpointName, endpoints.get(endpointName), state);
    return;
  }
  if (action === "delete") {
    await deleteEndpoint(ctx, endpointName, endpoints, state, configPath);
    return;
  }

  const exists = endpoints.has(endpointName);
  if (action === "add" && exists) {
    ctx.ui.notify(`Endpoint ${endpointName} 已存在，请使用 edit。`, "warning");
    return;
  }
  if (action === "edit" && !exists) {
    ctx.ui.notify(`Endpoint ${endpointName} 不存在。`, "warning");
    return;
  }
  await configureEndpoint(ctx, endpointName, endpoints, state, configPath, action === "add");
}

async function chooseAction(ctx: ExtensionCommandContext): Promise<ExploreManagerAction | undefined> {
  const choices: Array<{ action: ExploreManagerAction; label: string }> = [
    { action: "list", label: "查看全部 endpoints" },
    { action: "add", label: "新增 endpoint" },
    { action: "edit", label: "修改 endpoint" },
    { action: "show", label: "查看 endpoint 详情" },
    { action: "delete", label: "删除 endpoint" },
    { action: "defaults", label: "运行默认值" },
  ];
  const selected = await ctx.ui.select("Maestro Explore", choices.map((entry) => entry.label));
  return choices.find((entry) => entry.label === selected)?.action;
}

async function listEndpoints(
  ctx: ExtensionCommandContext,
  configPath: string,
  legacyPath: string,
): Promise<void> {
  const state = await loadExploreConfigState(configPath, legacyPath);
  const endpoints = endpointMap(state.root);
  const lines = [
    "Maestro Explore endpoints：",
    `配置文件：${displayText(state.activePath)}${state.source === "legacy" ? "（legacy，保存后迁移）" : ""}`,
  ];
  if (endpoints.size === 0) lines.push("- 未配置");
  for (const [name, value] of endpoints) {
    const endpoint = isRecord(value) ? value : {};
    const model = stringValue(endpoint.model) || "未设置 model";
    const format = stringValue(endpoint.format) || "openai";
    const status = isCompleteEndpoint(endpoint) ? "可用配置" : "配置不完整";
    lines.push(`- ${displayText(name)} · ${displayText(model)} · ${displayText(format)} · ${status}`);
  }
  lines.push(
    `默认：maxTurns=${integerLabel(state.root.maxTurns)} · concurrency=${integerLabel(state.root.concurrency)} · treeDepth=${integerLabel(state.root.treeDepth)}`,
  );
  ctx.ui.notify(lines.join("\n"), "info");
}

function showEndpoint(
  ctx: ExtensionCommandContext,
  name: string,
  value: unknown,
  state: ExploreConfigState,
): void {
  if (!isRecord(value)) {
    ctx.ui.notify(`Endpoint ${name} 不存在或配置无效。`, "warning");
    return;
  }
  const extraBody = isRecord(value.extraBody) ? "已配置" : "未设置";
  ctx.ui.notify([
    `Endpoint：${displayText(name)}`,
    `配置文件：${displayText(state.activePath)}`,
    `Base URL：${displayText(stringValue(value.baseUrl)) || "未设置"}`,
    `Model：${displayText(stringValue(value.model)) || "未设置"}`,
    `Format：${displayText(stringValue(value.format)) || "openai"}`,
    `API key：${stringValue(value.apiKey) ? "已配置" : "未配置"}`,
    `maxTurns：${integerLabel(value.maxTurns)}`,
    `concurrency：${integerLabel(value.concurrency)}`,
    `extraBody：${extraBody}`,
  ].join("\n"), "info");
}

async function chooseEndpoint(
  ctx: ExtensionCommandContext,
  endpoints: Map<string, unknown>,
  action: ExploreManagerAction,
): Promise<string | undefined> {
  if (endpoints.size === 0) {
    ctx.ui.notify("尚未配置 Explore endpoint。", "warning");
    return undefined;
  }
  const choices = new Map<string, string>();
  let index = 1;
  for (const [name, value] of endpoints) {
    const model = isRecord(value) ? stringValue(value.model) : "";
    choices.set(`${index}. ${displayText(name)}${model ? ` · ${displayText(model)}` : ""}`, name);
    index += 1;
  }
  const selected = await ctx.ui.select(`${actionLabel(action)} endpoint`, [...choices.keys()]);
  return selected ? choices.get(selected) : undefined;
}

async function configureEndpoint(
  ctx: ExtensionCommandContext,
  endpointName: string,
  endpoints: Map<string, unknown>,
  state: ExploreConfigState,
  configPath: string,
  adding: boolean,
): Promise<void> {
  const normalizedName = normalizeEndpointName(endpointName);
  const current = isRecord(endpoints.get(endpointName)) ? endpoints.get(endpointName) as Record<string, unknown> : {};
  const initialFormat = normalizeFormat(stringValue(current.format) || "openai");
  let values: ApiModelFormValues | undefined;

  if (ctx.hasUI && typeof ctx.ui.custom === "function") {
    const result = await showApiModelEditor(ctx, {
      title: `${adding ? "新增" : "修改"} Explore endpoint`,
      fields: [
        { id: "connection-section", label: "连接", kind: "section", value: "" },
        { id: "endpoint", label: "Endpoint", kind: "readonly", value: normalizedName },
        { id: "baseUrl", label: "Base URL", kind: "text", value: stringValue(current.baseUrl) },
        { id: "model", label: "Model", kind: "text", value: stringValue(current.model) },
        { id: "format", label: "Format", kind: "choice", value: initialFormat, choices: formatChoices(initialFormat) },
        { id: "apiKey", label: "API key", kind: "secret", value: stringValue(current.apiKey) },
        { id: "runtime-section", label: "Endpoint 运行参数", kind: "section", value: "" },
        { id: "maxTurns", label: "Max turns", kind: "number", value: optionalIntegerValue(current.maxTurns) },
        { id: "concurrency", label: "Concurrency", kind: "number", value: optionalIntegerValue(current.concurrency) },
        { id: "extraBody", label: "Extra body JSON", kind: "secret", value: isRecord(current.extraBody) ? JSON.stringify(current.extraBody) : "" },
      ],
      validate: validateEndpointForm,
    });
    values = result?.values;
  } else {
    values = await collectEndpointWithSteps(ctx, normalizedName, current, initialFormat);
  }
  if (!values) return;

  const nextEndpoint = endpointFromValues(values, current);
  const confirmed = await ctx.ui.confirm(
    `${adding ? "新增" : "保存"} ${normalizedName}？`,
    `${nextEndpoint.model} · ${nextEndpoint.format ?? "openai"} · ${nextEndpoint.baseUrl}`,
  );
  if (!confirmed) return;

  endpoints.set(normalizedName, nextEndpoint);
  const nextRoot = { ...state.root, endpoints: Object.fromEntries(endpoints) };
  await writeCanonicalConfig(configPath, nextRoot);
  const migrated = state.source === "legacy" ? "，已迁移到 api.json" : "";
  ctx.ui.notify(`Explore endpoint ${normalizedName} 已保存${migrated}。`, "info");
}

async function collectEndpointWithSteps(
  ctx: ExtensionCommandContext,
  endpointName: string,
  current: Record<string, unknown>,
  initialFormat: string,
): Promise<ApiModelFormValues | undefined> {
  const baseUrl = await ctx.ui.input("Base URL", stringValue(current.baseUrl));
  if (baseUrl === undefined) return undefined;
  const model = await ctx.ui.input("Model", stringValue(current.model));
  if (model === undefined) return undefined;
  const formatLabels = new Map(formatChoices(initialFormat).map((choice) => [choice.label, choice.value]));
  const selectedFormat = await ctx.ui.select("Format", [...formatLabels.keys()]);
  if (selectedFormat === undefined) return undefined;
  const apiKeyInput = await ctx.ui.input("API key（留空保留当前值）", "");
  if (apiKeyInput === undefined) return undefined;
  const maxTurns = await ctx.ui.input("Max turns（空为默认）", optionalIntegerValue(current.maxTurns));
  if (maxTurns === undefined) return undefined;
  const concurrency = await ctx.ui.input("Concurrency（空为默认）", optionalIntegerValue(current.concurrency));
  if (concurrency === undefined) return undefined;
  const extraBody = await ctx.ui.input(
    "Extra body JSON（空为未设置）",
    isRecord(current.extraBody) ? JSON.stringify(current.extraBody) : "",
  );
  if (extraBody === undefined) return undefined;
  const values: ApiModelFormValues = {
    endpoint: endpointName,
    baseUrl,
    model,
    format: formatLabels.get(selectedFormat) ?? initialFormat,
    apiKey: apiKeyInput || stringValue(current.apiKey),
    maxTurns,
    concurrency,
    extraBody,
  };
  const errors = validateEndpointForm(values);
  if (errors.length > 0) throw new Error(errors.join("；"));
  return values;
}

async function deleteEndpoint(
  ctx: ExtensionCommandContext,
  endpointName: string,
  endpoints: Map<string, unknown>,
  state: ExploreConfigState,
  configPath: string,
): Promise<void> {
  if (!endpoints.has(endpointName)) {
    ctx.ui.notify(`Endpoint ${endpointName} 不存在。`, "warning");
    return;
  }
  const confirmed = await ctx.ui.confirm("删除 Explore endpoint？", endpointName);
  if (!confirmed) return;
  endpoints.delete(endpointName);
  await writeCanonicalConfig(configPath, { ...state.root, endpoints: Object.fromEntries(endpoints) });
  const migrated = state.source === "legacy" ? "，其余配置已迁移到 api.json" : "";
  ctx.ui.notify(`Explore endpoint ${endpointName} 已删除${migrated}。`, "info");
}

async function configureDefaults(
  ctx: ExtensionCommandContext,
  configPath: string,
  legacyPath: string,
): Promise<void> {
  const state = await loadExploreConfigState(configPath, legacyPath);
  let values: ApiModelFormValues | undefined;
  if (ctx.hasUI && typeof ctx.ui.custom === "function") {
    const result = await showApiModelEditor(ctx, {
      title: "Maestro Explore 运行默认值",
      fields: [
        { id: "maxTurns", label: "Max turns", kind: "number", value: optionalIntegerValue(state.root.maxTurns) },
        { id: "concurrency", label: "Concurrency", kind: "number", value: optionalIntegerValue(state.root.concurrency) },
        { id: "treeDepth", label: "Tree depth", kind: "number", value: optionalIntegerValue(state.root.treeDepth) },
      ],
      validate: validateDefaultsForm,
    });
    values = result?.values;
  } else {
    const maxTurns = await ctx.ui.input("Max turns（空为 CLI 默认）", optionalIntegerValue(state.root.maxTurns));
    if (maxTurns === undefined) return;
    const concurrency = await ctx.ui.input("Concurrency（空为 CLI 默认）", optionalIntegerValue(state.root.concurrency));
    if (concurrency === undefined) return;
    const treeDepth = await ctx.ui.input("Tree depth 1-6（空为 CLI 默认）", optionalIntegerValue(state.root.treeDepth));
    if (treeDepth === undefined) return;
    values = { maxTurns, concurrency, treeDepth };
    const errors = validateDefaultsForm(values);
    if (errors.length > 0) throw new Error(errors.join("；"));
  }
  if (!values) return;

  const next = { ...state.root };
  setOptionalInteger(next, "maxTurns", values.maxTurns, "Max turns");
  setOptionalInteger(next, "concurrency", values.concurrency, "Concurrency");
  setOptionalInteger(next, "treeDepth", values.treeDepth, "Tree depth", 6);
  await writeCanonicalConfig(configPath, next);
  const migrated = state.source === "legacy" ? "，已迁移到 api.json" : "";
  ctx.ui.notify(`Explore 运行默认值已保存${migrated}。`, "info");
}

function endpointFromValues(
  values: ApiModelFormValues,
  current: Record<string, unknown>,
): ExploreEndpointConfig {
  const next: Record<string, unknown> = {
    ...current,
    baseUrl: requiredString(values.baseUrl, "Base URL"),
    model: requiredString(values.model, "Model"),
    apiKey: requiredString(values.apiKey, "API key"),
    format: normalizeFormat(requiredString(values.format, "Format")),
  };
  validateBaseUrl(String(next.baseUrl));
  setOptionalInteger(next, "maxTurns", values.maxTurns, "Max turns");
  setOptionalInteger(next, "concurrency", values.concurrency, "Concurrency");
  const extraBodyText = stringValue(values.extraBody).trim();
  if (!extraBodyText) delete next.extraBody;
  else next.extraBody = parseJsonObject(extraBodyText, "Extra body JSON");
  return next as ExploreEndpointConfig;
}

function validateEndpointForm(values: ApiModelFormValues): string[] {
  const errors: string[] = [];
  try { validateBaseUrl(requiredString(values.baseUrl, "Base URL")); } catch (error) { errors.push(errorMessage(error)); }
  try { requiredString(values.model, "Model"); } catch (error) { errors.push(errorMessage(error)); }
  try { requiredString(values.apiKey, "API key"); } catch (error) { errors.push(errorMessage(error)); }
  try { normalizeFormat(requiredString(values.format, "Format")); } catch (error) { errors.push(errorMessage(error)); }
  try { optionalPositiveInteger(values.maxTurns, "Max turns"); } catch (error) { errors.push(errorMessage(error)); }
  try { optionalPositiveInteger(values.concurrency, "Concurrency"); } catch (error) { errors.push(errorMessage(error)); }
  const extraBody = stringValue(values.extraBody).trim();
  if (extraBody) {
    try { parseJsonObject(extraBody, "Extra body JSON"); } catch (error) { errors.push(errorMessage(error)); }
  }
  return errors;
}

function validateDefaultsForm(values: ApiModelFormValues): string[] {
  const errors: string[] = [];
  try { optionalPositiveInteger(values.maxTurns, "Max turns"); } catch (error) { errors.push(errorMessage(error)); }
  try { optionalPositiveInteger(values.concurrency, "Concurrency"); } catch (error) { errors.push(errorMessage(error)); }
  try { optionalPositiveInteger(values.treeDepth, "Tree depth", 6); } catch (error) { errors.push(errorMessage(error)); }
  return errors;
}

async function readConfigIfPresent(path: string): Promise<ExploreConfigRoot | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) throw new Error(`Explore config must be a JSON object: ${path}`);
  return parsed as ExploreConfigRoot;
}

async function writeCanonicalConfig(path: string, root: ExploreConfigRoot): Promise<void> {
  await serializeMutation(path, async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let existed = false;
    try {
      await readFile(path);
      existed = true;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    if (existed) {
      await copyFile(path, `${path}.bak-${Date.now()}-${randomUUID()}`);
    }
    const tempPath = `${path}.tmp-${randomUUID()}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(root, null, 2)}\n`, "utf8");
      await handle.close();
      handle = undefined;
      await rename(tempPath, path);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
    }
  });
}

function serializeMutation(path: string, mutation: () => Promise<void>): Promise<void> {
  const previous = mutationQueues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(mutation);
  mutationQueues.set(path, current);
  return current.finally(() => {
    if (mutationQueues.get(path) === current) mutationQueues.delete(path);
  });
}

function endpointMap(root: ExploreConfigRoot): Map<string, unknown> {
  return new Map(isRecord(root.endpoints) ? Object.entries(root.endpoints) : []);
}

function normalizeEndpointName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("Endpoint 名称不能为空");
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error("Endpoint 名称只能包含字母、数字、点、下划线和连字符");
  }
  if (name === "__proto__" || name === "prototype" || name === "constructor") {
    throw new Error(`Endpoint 名称 ${name} 为保留字`);
  }
  return name;
}

function validateBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Base URL 必须是有效 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL 仅支持 http 或 https");
  }
}

function formatChoices(current: string): readonly ApiModelFormChoice[] {
  if (FORMATS.some((choice) => choice.value === current)) return FORMATS;
  return [...FORMATS, { label: `Legacy (${current})`, value: current }];
}

function normalizeFormat(value: string): ExploreApiFormat {
  if (value === "openai" || value === "anthropic" || value === "openai-responses") return value;
  throw new Error(`不支持的 Explore format：${value}`);
}

function setOptionalInteger(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  label: string,
  max?: number,
): void {
  const parsed = optionalPositiveInteger(value, label, max);
  if (parsed === undefined) delete target[key];
  else target[key] = parsed;
}

function optionalPositiveInteger(value: unknown, label: string, max?: number): number | undefined {
  const text = stringValue(value).trim();
  if (!text) return undefined;
  if (!/^\d+$/.test(text)) throw new Error(`${label} 必须是正整数`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} 必须是正整数`);
  if (max !== undefined && parsed > max) throw new Error(`${label} 必须在 1-${max} 之间`);
  return parsed;
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON：${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) throw new Error(`${label} 必须是 JSON object`);
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  const text = stringValue(value).trim();
  if (!text) throw new Error(`${label} 不能为空`);
  if (/[\x00-\x1f\x7f-\x9f]/.test(text)) throw new Error(`${label} 不能包含控制字符`);
  return text;
}

function displayText(value: string): string {
  return sanitizeSingleLineInput(value).trim();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalIntegerValue(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : "";
}

function integerLabel(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : "CLI 默认";
}

function isCompleteEndpoint(value: Record<string, unknown>): boolean {
  return Boolean(stringValue(value.baseUrl) && stringValue(value.apiKey) && stringValue(value.model));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function actionFromArg(value: string | undefined): ExploreManagerAction | undefined {
  if (!value) return undefined;
  if (value === "list" || value === "ls") return "list";
  if (value === "add" || value === "new") return "add";
  if (value === "edit" || value === "set" || value === "update") return "edit";
  if (value === "show" || value === "get") return "show";
  if (value === "delete" || value === "remove") return "delete";
  if (value === "defaults" || value === "default") return "defaults";
  return undefined;
}

function actionLabel(action: ExploreManagerAction): string {
  if (action === "show") return "查看";
  if (action === "delete") return "删除";
  return "修改";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
