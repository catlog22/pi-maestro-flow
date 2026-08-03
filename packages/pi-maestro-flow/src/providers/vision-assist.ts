import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, isAbsolute, join, resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, complete } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { refreshModelRegistry } from "pi-maestro-teammate/v1/model-routing";
import {
  isRetryableProviderError,
  ModelCircuitBreaker,
  type AcquiredModelCandidate,
} from "pi-maestro-teammate/v1/retry";
import { Type } from "typebox";
import { loadSsrfConfig, validateRemoteUrl } from "../tools/web-access/ssrf-protection.ts";

export const DESCRIBE_IMAGE_TOOL_NAME = "describe_image";
export const VISION_DELEGATION_CONFIG_FILE = "vision-delegation.json";
export const DEFAULT_VISION_ANALYSIS_PROMPT =
  "Describe this image concisely, focusing on visible content, text, diagrams, UI elements, and layout.";
/** Vision health is intentionally isolated from the main-agent breaker domain. */
export const sharedVisionModelCircuitBreaker = new ModelCircuitBreaker();

const MAX_RETRY_BACKOFF_MS = 8_000;
const SUPPORTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/**
 * Image description is a bounded perceptual task: capping the delegated
 * reasoning effort keeps single attempts fast, so a slow "high" reasoning
 * pass cannot repeatedly blow the per-attempt deadline (the 60s hang seen
 * with gpt-5.6-sol). qwen-family providers stay callable because any
 * non-off effort still enables thinking.
 */
const VISION_REASONING_CAP = "low" as const;
const EXTENDED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** Host registry refresh fetches remote catalogs without a timeout of its own. */
const REGISTRY_REFRESH_TIMEOUT_MS = 10_000;

export interface VisionDelegationConfig {
  enabled: boolean;
  visionModel?: string;
  customPrompt?: string;
  cache: { enabled: boolean; maxEntries: number };
  fallbackModels: string[];
  maxRetries: number;
  retryBackoffMs: number;
  timeoutMs: number;
  maxImageBytes: number;
}

export type VisionManagerContext = Pick<ExtensionContext, "ui" | "model" | "modelRegistry">;

export interface VisionDelegationOptions {
  agentDir?: string;
  completeFn?: typeof complete;
  /** Circuit breaker for delegated vision health; defaults to a vision-only
   *  process instance so helper failures cannot open the main model circuit. */
  breaker?: ModelCircuitBreaker;
  /** Optional structured telemetry sink for delegation lifecycle events. */
  telemetry?: VisionTelemetry;
}

export type VisionTelemetryEvent =
  | { type: "delegation_start"; prompt: string }
  | { type: "attempt"; model: string; attempt: number; timeoutMs: number }
  | { type: "result"; model: string; cached: boolean; durationMs: number }
  | { type: "cache_hit"; model: string }
  | { type: "cache_miss"; model: string }
  | { type: "candidate_rejected"; model: string; reason: string };

export interface VisionTelemetry {
  emit(event: VisionTelemetryEvent): void;
}

export function noopVisionTelemetry(): VisionTelemetry {
  return { emit() { /* no-op */ } };
}

export interface AttachedImageInput {
  data: string;
  mimeType: string;
}

export interface VisionAnalysisResult {
  text: string;
  model: string;
  cached: boolean;
}

export interface AnalyzeAttachedImageOptions extends VisionDelegationOptions {
  prompt?: string;
  signal?: AbortSignal;
}

interface LoadedImage extends AttachedImageInput {
  sourceHash: string;
  source: string;
}

interface CachedResult {
  text: string;
  model: string;
}

interface ToolController {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

type VisionToolResult = AgentToolResult<unknown> & { isError?: boolean };

export const DEFAULT_VISION_DELEGATION_CONFIG: Readonly<VisionDelegationConfig> = {
  enabled: true,
  cache: { enabled: true, maxEntries: 50 },
  fallbackModels: [],
  // Retrying re-sends the whole image+prompt from scratch: a slow-but-working
  // model then appears stuck for maxRetries+1 deadlines with zero progress.
  // Give one attempt a generous deadline instead; fail over on timeout.
  maxRetries: 0,
  retryBackoffMs: 500,
  timeoutMs: 60_000,
  maxImageBytes: 20 * 1024 * 1024,
};

class VisionCache {
  private readonly values = new Map<string, CachedResult>();
  constructor(private maxEntries: number) {}
  configure(maxEntries: number): void { this.maxEntries = maxEntries; this.evict(); }
  clear(): void { this.values.clear(); }
  get(key: string): CachedResult | undefined {
    const value = this.values.get(key);
    if (!value) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }
  set(key: string, value: CachedResult): void { this.values.delete(key); this.values.set(key, value); this.evict(); }
  private evict(): void {
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (!oldest) return;
      this.values.delete(oldest);
    }
  }
}

const attachedCaches = new Map<string, VisionCache>();

/** Per-agentDir cache registry shared by the tool and attached-image paths.
 *  The caller must delete its entry on session shutdown to avoid leaking
 *  caches across long-running processes. */
function visionCacheFor(agentDir: string, maxEntries: number): VisionCache {
  let cache = attachedCaches.get(agentDir);
  if (!cache) {
    cache = new VisionCache(maxEntries);
    attachedCaches.set(agentDir, cache);
  }
  cache.configure(maxEntries);
  return cache;
}

export function isMultimodalModel(model: Pick<Model<Api>, "input"> | undefined): boolean {
  return model?.input?.includes("image") === true;
}

export function getVisionDelegationConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, VISION_DELEGATION_CONFIG_FILE);
}

export function loadVisionDelegationConfig(agentDir = getAgentDir()): VisionDelegationConfig {
  const defaults = defaultConfig();
  const path = getVisionDelegationConfigPath(agentDir);
  if (!existsSync(path)) return defaults;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { return defaults; }
  if (!record(parsed)) return defaults;
  const cache = record(parsed.cache) ? parsed.cache : {};
  return {
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaults.enabled,
    ...(modelReference(parsed.visionModel) ? { visionModel: parsed.visionModel.trim() } : {}),
    ...(typeof parsed.customPrompt === "string" && parsed.customPrompt.trim() ? { customPrompt: parsed.customPrompt.trim() } : {}),
    cache: {
      enabled: typeof cache.enabled === "boolean" ? cache.enabled : defaults.cache.enabled,
      maxEntries: integer(cache.maxEntries, defaults.cache.maxEntries, 1, 1_000),
    },
    fallbackModels: modelReferences(parsed.fallbackModels),
    maxRetries: integer(parsed.maxRetries, defaults.maxRetries, 0, 10),
    retryBackoffMs: integer(parsed.retryBackoffMs, defaults.retryBackoffMs, 0, MAX_RETRY_BACKOFF_MS),
    timeoutMs: integer(parsed.timeoutMs, defaults.timeoutMs, 1_000, 300_000),
    maxImageBytes: integer(parsed.maxImageBytes, defaults.maxImageBytes, 1_024, 64 * 1024 * 1024),
  };
}

export function saveVisionDelegationConfig(config: VisionDelegationConfig, agentDir = getAgentDir()): string {
  const path = getVisionDelegationConfigPath(agentDir);
  mkdirSync(resolve(agentDir), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return path;
}

export function visionDelegationPrompt(
  model: Pick<Model<Api>, "provider" | "id" | "input"> | undefined,
  config: VisionDelegationConfig,
): string | undefined {
  if (!config.enabled || isMultimodalModel(model)) return undefined;
  return [
    "## Vision capability",
    "The active primary model is text-only.",
    `Use ${DESCRIBE_IMAGE_TOOL_NAME} to inspect image paths or URLs through ${config.visionModel ?? "an available multimodal model"}.`,
    "Do not claim to have inspected an image until delegated analysis succeeds.",
  ].join("\n");
}

export function formatVisionDelegationStatus(
  config: VisionDelegationConfig,
  model: Pick<Model<Api>, "provider" | "id" | "input"> | undefined,
  configPath: string,
): string {
  const activeModel = model ? `${model.provider}/${model.id}` : "(none)";
  const mode = isMultimodalModel(model) ? "native" : config.enabled ? "delegate" : "disabled";
  return [
    "Vision delegation:",
    `  enabled: ${config.enabled}`,
    `  active model: ${activeModel}`,
    `  mode: ${mode}`,
    `  vision model: ${config.visionModel ?? "auto-detect"}`,
    `  fallback models: ${config.fallbackModels.join(", ") || "(none)"}`,
    `  cache: ${config.cache.enabled ? `on (max ${config.cache.maxEntries})` : "off"}`,
    `  retries: ${config.maxRetries}`,
    `  timeout: ${config.timeoutMs}ms`,
    `  custom prompt: ${config.customPrompt ? "configured" : "default"}`,
    `  file: ${configPath}`,
  ].join("\n");
}

export async function analyzeAttachedImage(
  ctx: ExtensionContext,
  input: AttachedImageInput,
  options: AnalyzeAttachedImageOptions = {},
): Promise<VisionAnalysisResult> {
  const agentDir = options.agentDir ?? getAgentDir();
  const config = loadVisionDelegationConfig(agentDir);
  if (!config.enabled) throw new Error("Vision delegation is disabled");
  const image = normalizeAttachedImage(input, config.maxImageBytes);
  const cache = visionCacheFor(agentDir, config.cache.maxEntries);
  return delegateImage(ctx, image, options.prompt?.trim() || DEFAULT_VISION_ANALYSIS_PROMPT, config, cache, options.signal, options.completeFn ?? complete, options.breaker ?? sharedVisionModelCircuitBreaker, options.telemetry ?? noopVisionTelemetry());
}

export function registerVisionDelegation(pi: ExtensionAPI, options: VisionDelegationOptions = {}): void {
  const agentDir = options.agentDir ?? getAgentDir();
  const completeFn = options.completeFn ?? complete;
  const breaker = options.breaker ?? sharedVisionModelCircuitBreaker;
  const telemetry = options.telemetry ?? noopVisionTelemetry();
  let config = loadVisionDelegationConfig(agentDir);
  const cache = visionCacheFor(agentDir, config.cache.maxEntries);
  let restoreForText = true;
  let removedByUs = false;
  let previousMultimodal: boolean | undefined;
  let previousEnabled = config.enabled;

  const syncTools = (model: Model<Api> | undefined, sessionBoundary = false): void => {
    const controller = toolController(pi);
    if (!controller) return;
    const active = controller.getActiveTools();
    const present = active.includes(DESCRIBE_IMAGE_TOOL_NAME);
    // Calibrate the user-intent flag only when the tool set was last changed by
    // the user (not by this module removing it for disabled/multimodal).
    if (sessionBoundary) restoreForText = present;
    else if (config.enabled && !removedByUs && previousMultimodal === false) restoreForText = present;
    const multimodal = isMultimodalModel(model);
    if (!config.enabled || multimodal) {
      if (present) {
        restoreForText = true;
        removedByUs = true;
        controller.setActiveTools(active.filter((name) => name !== DESCRIBE_IMAGE_TOOL_NAME));
      }
    } else {
      // enabled + text-only: module regains control; user changes are visible
      // through `present` on the next sync.
      removedByUs = false;
      if (restoreForText && !present) {
        controller.setActiveTools([...new Set([...active, DESCRIBE_IMAGE_TOOL_NAME])]);
      }
    }
    previousMultimodal = multimodal;
    previousEnabled = config.enabled;
  };

  pi.on("session_start", (_event, ctx) => {
    config = loadVisionDelegationConfig(agentDir);
    visionCacheFor(agentDir, config.cache.maxEntries);
    cache.clear();
    syncTools(ctx.model, true);
  });
  pi.on("model_select", (event) => {
    config = loadVisionDelegationConfig(agentDir);
    visionCacheFor(agentDir, config.cache.maxEntries);
    syncTools(event.model);
  });
  pi.on("before_agent_start", (event, ctx) => {
    config = loadVisionDelegationConfig(agentDir);
    visionCacheFor(agentDir, config.cache.maxEntries);
    if (!config.cache.enabled) cache.clear();
    syncTools(ctx.model);
    // Attached images are handled by the failover/attached-image path; injecting
    // "use describe_image" guidance here would fight that orchestration and
    // leave a stale hint when the turn switches to a native multimodal model.
    const hasAttachedImages = Array.isArray((event as { images?: unknown[] }).images)
      && ((event as { images?: unknown[] }).images?.length ?? 0) > 0;
    const guidance = hasAttachedImages ? undefined : visionDelegationPrompt(ctx.model, config);
    if (!guidance) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
  });
  pi.on("session_shutdown", () => {
    cache.clear();
    attachedCaches.delete(agentDir);
  });

  const persist = (ctx: ExtensionContext, messageText: string): void => {
    saveVisionDelegationConfig(config, agentDir);
    syncTools(ctx.model);
    ctx.ui.notify(messageText, "info");
  };

  pi.registerCommand("vision", {
    description: "Configure capability-aware multimodal image delegation",
    handler: async (args, ctx) => {
      config = loadVisionDelegationConfig(agentDir);
      cache.configure(config.cache.maxEntries);
      const values = args.trim().split(/\s+/).filter(Boolean);
      const action = values[0]?.toLowerCase();
      if (!action) {
        if (!ctx.hasUI) {
          ctx.ui.notify(formatVisionDelegationStatus(config, ctx.model, getVisionDelegationConfigPath(agentDir)), "info");
          return;
        }
        await showVisionManager(ctx, config, getVisionDelegationConfigPath(agentDir), (next, messageText) => {
          config = next;
          cache.configure(config.cache.maxEntries);
          if (!config.cache.enabled) cache.clear();
          persist(ctx, messageText);
        });
        return;
      }
      if (action === "show" || action === "status") {
        ctx.ui.notify(formatVisionDelegationStatus(config, ctx.model, getVisionDelegationConfigPath(agentDir)), "info");
        return;
      }
      if (action === "on" || action === "off") {
        config = { ...config, enabled: action === "on" };
        persist(ctx, `Vision delegation ${config.enabled ? "enabled" : "disabled"}.`);
        return;
      }
      if (action === "model") {
        const reference = values.slice(1).join(" ").trim();
        if (!reference || reference === "auto" || reference === "clear") {
          const next = { ...config };
          delete next.visionModel;
          config = next;
          persist(ctx, "Vision model set to auto-detect.");
          return;
        }
        requireAvailableVisionModel(ctx, reference);
        config = { ...config, visionModel: reference };
        persist(ctx, `Vision model set to ${reference}.`);
        return;
      }
      if (action === "fallback") {
        const raw = values.slice(1).join(" ").trim();
        if (!raw || raw === "clear") config = { ...config, fallbackModels: [] };
        else {
          const references = raw.split(",").map((value) => value.trim()).filter(Boolean);
          for (const reference of references) requireAvailableVisionModel(ctx, reference);
          config = { ...config, fallbackModels: [...new Set(references)] };
        }
        persist(ctx, `Vision fallback models: ${config.fallbackModels.join(", ") || "none"}.`);
        return;
      }
      if (action === "cache") {
        const value = values[1]?.toLowerCase();
        if (value === "clear") {
          cache.clear();
          ctx.ui.notify("Vision cache cleared.", "info");
          return;
        }
        if (value !== "on" && value !== "off") throw new Error("Usage: /vision cache on|off|clear");
        config = { ...config, cache: { ...config.cache, enabled: value === "on" } };
        if (!config.cache.enabled) cache.clear();
        persist(ctx, `Vision cache ${config.cache.enabled ? "enabled" : "disabled"}.`);
        return;
      }
      if (action === "prompt") {
        const value = values.slice(1).join(" ").trim();
        const next = { ...config };
        if (!value || value === "clear") delete next.customPrompt;
        else next.customPrompt = value;
        config = next;
        persist(ctx, `Vision custom prompt ${config.customPrompt ? "updated" : "cleared"}.`);
        return;
      }
      if (action === "retries" || action === "timeout") {
        const number = Number(values[1]);
        if (!Number.isInteger(number)) throw new Error(`Usage: /vision ${action} <integer>`);
        config = action === "retries"
          ? { ...config, maxRetries: integer(number, config.maxRetries, 0, 10) }
          : { ...config, timeoutMs: integer(number, config.timeoutMs, 1_000, 300_000) };
        persist(ctx, `Vision ${action} updated.`);
        return;
      }
      throw new Error("Usage: /vision [show|on|off|model <provider/model|auto>|fallback <refs|clear>|cache on|off|clear|prompt <text|clear>|retries <0-10>|timeout <ms>]");
    },
  });

  pi.registerTool({
    name: DESCRIBE_IMAGE_TOOL_NAME,
    label: "Describe Image",
    description: "Analyze a local image, data URL, or DNS-pinned SSRF-validated HTTP(S) image through a multimodal helper when the primary model is text-only.",
    promptSnippet: "Analyze an image through a multimodal helper model.",
    promptGuidelines: ["Use describe_image when the active model cannot inspect an image natively."],
    parameters: Type.Object({
      image_path: Type.String({ minLength: 1, description: "Local path, data URL, or HTTP(S) image URL." }),
      prompt: Type.Optional(Type.String({ minLength: 1, description: "Analysis question or focus." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx): Promise<VisionToolResult> {
      config = loadVisionDelegationConfig(agentDir);
      cache.configure(config.cache.maxEntries);
      if (!config.enabled) return toolError("Vision delegation is disabled. Use /vision on to enable it.", "disabled");
      if (isMultimodalModel(ctx.model)) return toolError("The active model supports images natively.", "native_model");
      try {
        const image = await loadImage(params.image_path, ctx.cwd, config.maxImageBytes, signal);
        const result = await delegateImage(ctx, image, params.prompt?.trim() || DEFAULT_VISION_ANALYSIS_PROMPT, config, cache, signal, completeFn, breaker, telemetry);
        return { content: [{ type: "text", text: result.text }], details: { mode: "delegate", ...result, source: image.source } };
      } catch (error) {
        return toolError(`Vision delegation failed: ${message(error)}`, error instanceof Error && error.name === "AbortError" ? "aborted" : "vision_error");
      }
    },
  });
}

export async function showVisionDelegationManager(
  ctx: VisionManagerContext,
  agentDir = getAgentDir(),
): Promise<void> {
  let config = loadVisionDelegationConfig(agentDir);
  const configPath = getVisionDelegationConfigPath(agentDir);
  await showVisionManager(ctx, config, configPath, (next, messageText) => {
    config = next;
    saveVisionDelegationConfig(config, agentDir);
    ctx.ui.notify(messageText, "info");
  });
}

async function showVisionManager(
  ctx: VisionManagerContext,
  initial: VisionDelegationConfig,
  configPath: string,
  save: (config: VisionDelegationConfig, message: string) => void,
): Promise<void> {
  let current = initial;
  const availableAtOpen = new Set(availableVisionModelReferences(ctx));
  const unavailable = [current.visionModel, ...current.fallbackModels]
    .filter((reference): reference is string => typeof reference === "string" && reference.length > 0)
    .filter((reference) => !availableAtOpen.has(reference));
  if (unavailable.length > 0) {
    ctx.ui.notify(
      `Vision 配置引用了不可用或已取消多模态能力的模型：${[...new Set(unavailable)].join(", ")}。请重新选择。`,
      "warning",
    );
  }
  while (true) {
    const choice = await ctx.ui.select("Vision 委托设置", [
      "查看状态",
      current.enabled ? "停用 Vision 委托" : "启用 Vision 委托",
      "选择 Vision 模型",
      "编辑 Fallback 模型链",
      current.cache.enabled ? "关闭缓存" : "开启缓存",
      "设置缓存容量",
      "设置重试次数",
      "设置超时时间",
      "编辑分析系统提示",
      "完成",
    ]);
    if (!choice || choice === "完成") return;
    if (choice === "查看状态") { ctx.ui.notify(formatVisionDelegationStatus(current, ctx.model, configPath), "info"); continue; }
    if (choice.includes("Vision 委托")) { current = { ...current, enabled: !current.enabled }; save(current, `Vision delegation ${current.enabled ? "enabled" : "disabled"}.`); continue; }
    if (choice === "选择 Vision 模型") {
      const selected = await ctx.ui.select("选择多模态 Vision 模型", ["自动检测", ...availableVisionModelReferences(ctx)]);
      if (!selected) continue;
      const next = { ...current };
      if (selected === "自动检测") delete next.visionModel; else next.visionModel = selected;
      current = next; save(current, `Vision model: ${current.visionModel ?? "auto-detect"}.`); continue;
    }
    if (choice === "编辑 Fallback 模型链") {
      const available = new Set(availableVisionModelReferences(ctx).filter((reference) => reference !== current.visionModel));
      const input = await ctx.ui.input("Vision fallback 模型链（逗号分隔，按顺序回退）", current.fallbackModels.join(", "));
      if (input === undefined) continue;
      const references = [...new Set(input.split(",").map((reference) => reference.trim()).filter(Boolean))];
      const invalid = references.find((reference) => !available.has(reference));
      if (invalid) {
        ctx.ui.notify(`模型 ${invalid} 不可用、非多模态，或已被选为首选 Vision 模型。`, "warning");
        continue;
      }
      current = { ...current, fallbackModels: references };
      save(current, `Vision fallback: ${current.fallbackModels.join(", ") || "none"}.`);
      continue;
    }
    if (choice.endsWith("缓存")) { current = { ...current, cache: { ...current.cache, enabled: !current.cache.enabled } }; save(current, `Vision cache ${current.cache.enabled ? "enabled" : "disabled"}.`); continue; }
    if (choice === "设置缓存容量") {
      const input = await ctx.ui.input("Vision 缓存最大条目数（1-1000）", String(current.cache.maxEntries));
      if (input === undefined) continue;
      const value = Number(input);
      if (!Number.isInteger(value) || value < 1 || value > 1_000) { ctx.ui.notify("缓存容量必须是 1-1000 的整数。", "warning"); continue; }
      current = { ...current, cache: { ...current.cache, maxEntries: value } };
      save(current, `Vision cache capacity: ${value}.`);
      continue;
    }
    if (choice === "设置重试次数") {
      const input = await ctx.ui.input("每个 Vision 模型最大重试次数（0-10）", String(current.maxRetries));
      if (input === undefined) continue;
      const value = Number(input);
      if (!Number.isInteger(value) || value < 0 || value > 10) { ctx.ui.notify("重试次数必须是 0-10 的整数。", "warning"); continue; }
      current = { ...current, maxRetries: value };
      save(current, `Vision retries: ${value}.`);
      continue;
    }
    if (choice === "设置超时时间") {
      const input = await ctx.ui.input("单次 Vision 请求超时（毫秒，1000-300000）", String(current.timeoutMs));
      if (input === undefined) continue;
      const value = Number(input);
      if (!Number.isInteger(value) || value < 1_000 || value > 300_000) { ctx.ui.notify("超时时间必须是 1000-300000 毫秒的整数。", "warning"); continue; }
      current = { ...current, timeoutMs: value };
      save(current, `Vision timeout: ${value}ms.`);
      continue;
    }
    if (choice === "编辑分析系统提示") {
      const edited = await ctx.ui.editor("Vision 分析系统提示", current.customPrompt ?? "");
      if (edited === undefined) continue;
      const next = { ...current };
      if (edited.trim()) next.customPrompt = edited.trim(); else delete next.customPrompt;
      current = next; save(current, `Vision custom prompt ${current.customPrompt ? "updated" : "cleared"}.`);
    }
  }
}

function availableVisionModelReferences(ctx: VisionManagerContext): string[] {
  return ctx.modelRegistry.getAvailable().filter(isMultimodalModel).map((model) => `${model.provider}/${model.id}`);
}

function requireAvailableVisionModel(ctx: VisionManagerContext, reference: string): void {
  if (!modelReference(reference)) throw new Error(`Invalid model reference: ${reference}`);
  if (!availableVisionModelReferences(ctx).includes(reference)) throw new Error(`Model ${reference} is unavailable or not marked multimodal in API Manager`);
}

async function delegateImage(
  ctx: ExtensionContext,
  image: LoadedImage,
  prompt: string,
  config: VisionDelegationConfig,
  cache: VisionCache,
  signal: AbortSignal | undefined,
  completeFn: typeof complete,
  breaker: ModelCircuitBreaker = sharedVisionModelCircuitBreaker,
  telemetry: VisionTelemetry = noopVisionTelemetry(),
): Promise<VisionAnalysisResult> {
  await refreshModelRegistryBestEffort(ctx);
  const references = candidateReferences(ctx, config);
  if (references.length === 0) throw new Error("no multimodal model is available");
  telemetry.emit({ type: "delegation_start", prompt });
  // Key deliberately excludes volatile `references`: the same image+prompt
  // analysis is reusable across fallback reordering or model-list churn.
  const key = createHash("sha256").update(JSON.stringify({ image: image.sourceHash, prompt, system: config.customPrompt ?? "" })).digest("hex");
  if (config.cache.enabled) {
    const hit = cache.get(key);
    if (hit) {
      telemetry.emit({ type: "cache_hit", model: hit.model });
      return { ...hit, cached: true };
    }
    telemetry.emit({ type: "cache_miss", model: references[0] });
  }
  const started = Date.now();
  const result = await callCandidates(ctx, references, image, prompt, config, signal, completeFn, breaker, telemetry);
  if (config.cache.enabled) cache.set(key, result);
  telemetry.emit({ type: "result", model: result.model, cached: false, durationMs: Date.now() - started });
  return { ...result, cached: false };
}

async function callCandidates(
  ctx: ExtensionContext,
  references: string[],
  image: LoadedImage,
  prompt: string,
  config: VisionDelegationConfig,
  signal: AbortSignal | undefined,
  completeFn: typeof complete,
  breaker: ModelCircuitBreaker = sharedVisionModelCircuitBreaker,
  telemetry: VisionTelemetry = noopVisionTelemetry(),
): Promise<CachedResult> {
  const failures: string[] = [];
  for (const reference of references) {
    if (signal?.aborted) throw aborted();
    const acquisition = breaker.acquireCandidate(reference);
    if (!acquisition.allowed) {
      failures.push(`${reference}: circuit ${acquisition.state}`);
      telemetry.emit({ type: "candidate_rejected", model: reference, reason: `circuit ${acquisition.state}` });
      continue;
    }
    let settled = false;
    const settle = (outcome: "release" | "success" | "retryable-failure"): void => {
      if (settled) throw new Error(`Vision candidate ${reference} was settled more than once`);
      settled = true;
      if (outcome === "success") breaker.recordSuccess(acquisition);
      else if (outcome === "retryable-failure") breaker.recordRetryableFailure(acquisition);
      else breaker.releaseCandidate(acquisition);
    };

    try {
      const [provider, id] = splitReference(reference);
      const model = ctx.modelRegistry.find(provider, id);
      if (!model || !isMultimodalModel(model)) {
        settle("release");
        failures.push(`${reference}: unavailable or text-only`);
        continue;
      }
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        settle("release");
        failures.push(`${reference}: authentication unavailable (${auth.error})`);
        continue;
      }
      const reasoningEffort = visionReasoningEffort(model, ctx.thinkingLevel);
      // pi-ai post-processing calls calculateCost(model, usage); a composed
      // model without a cost field crashes with "reading 'tiers'" and turns
      // a successful vision response into a delegation error.
      const safeModel = model.cost ? model : { ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
        telemetry.emit({ type: "attempt", model: reference, attempt, timeoutMs: config.timeoutMs });
        const guard = completionGuard(signal, config.timeoutMs);
        try {
          const running = Promise.resolve().then(() => completeFn(safeModel, {
            systemPrompt: config.customPrompt,
            messages: [{ role: "user", content: [
              { type: "image", data: image.data, mimeType: image.mimeType },
              { type: "text", text: prompt },
            ], timestamp: Date.now() }],
          }, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: Math.min(model.maxTokens, 8_192), reasoningEffort, signal: guard.signal }));
          void running.catch(() => undefined);
          const response = await Promise.race([running, guard.deadline]);
          const text = assistantText(response);
          settle("success");
          return { text, model: reference };
        } catch (error) {
          if (signal?.aborted) {
            settle("release");
            throw aborted();
          }
          const retryable = error instanceof VisionTimeoutError || isRetryableProviderError(message(error));
          if (!retryable) {
            settle("release");
            failures.push(`${reference}: ${message(error)}`);
            break;
          }
          if (attempt === config.maxRetries) {
            settle("retryable-failure");
            failures.push(`${reference}: ${message(error)}`);
            break;
          }
          await delay(Math.min(config.retryBackoffMs * 2 ** attempt, MAX_RETRY_BACKOFF_MS), signal);
        } finally { guard.dispose(); }
      }
    } finally {
      // Auth lookup, telemetry, retry backoff, and other boundary exceptions
      // must not strand an acquired HALF_OPEN trial.
      if (!settled) settle("release");
    }
  }
  throw new Error(`no vision model succeeded (${failures.join("; ")})`);
}

function candidateReferences(ctx: ExtensionContext, config: VisionDelegationConfig): string[] {
  const configured = [config.visionModel, ...config.fallbackModels].filter((value): value is string => typeof value === "string");
  const automatic = ctx.modelRegistry.getAvailable().filter(isMultimodalModel).map((model) => `${model.provider}/${model.id}`);
  return [...new Set([...configured, ...automatic])];
}

async function loadImage(source: string, cwd: string, maxBytes: number, signal?: AbortSignal): Promise<LoadedImage> {
  const value = source.trim();
  if (!value) throw new Error("image_path is empty");
  let bytes: Buffer;
  let mimeType: string | undefined;
  let normalizedSource = value;
  if (value.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
    if (!match) throw new Error("image data URL must use base64 encoding");
    mimeType = normalizeMime(match[1]);
    bytes = Buffer.from(match[2], "base64");
    normalizedSource = "data-url";
  } else if (/^https?:\/\//i.test(value)) {
    const remote = await remoteImage(value, maxBytes, signal);
    bytes = remote.bytes;
    mimeType = remote.mimeType;
  } else {
    const file = isAbsolute(value) ? value : resolve(cwd, value);
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error(`image path is not a file: ${file}`);
    if (stat.size > maxBytes) throw new Error(`image exceeds ${formatBytes(maxBytes)} limit`);
    bytes = await readFile(file);
    mimeType = extensionMime(extname(file));
    normalizedSource = file;
  }
  if (signal?.aborted) throw aborted();
  if (!bytes.length || bytes.length > maxBytes) throw new Error(`image is empty or exceeds ${formatBytes(maxBytes)} limit`);
  mimeType = magicMime(bytes) ?? mimeType;
  if (!mimeType || !SUPPORTED_MIME_TYPES.has(mimeType)) throw new Error("unsupported image format");
  return { data: bytes.toString("base64"), mimeType, sourceHash: hash(bytes), source: normalizedSource };
}

function normalizeAttachedImage(input: AttachedImageInput, maxBytes: number): LoadedImage {
  const bytes = Buffer.from(input.data, "base64");
  if (!bytes.length || bytes.length > maxBytes) throw new Error(`attached image is empty or exceeds ${formatBytes(maxBytes)} limit`);
  // Attached-image MIME is declared by the client, so it must be verified
  // against magic bytes rather than trusted (stricter than the tool path,
  // which can fall back to file extension / content-type hints).
  const mimeType = magicMime(bytes);
  if (!mimeType || !SUPPORTED_MIME_TYPES.has(mimeType)) throw new Error(`unsupported attached image MIME type: ${input.mimeType}`);
  return { ...input, mimeType, sourceHash: hash(bytes), source: "attached-image" };
}

async function remoteImage(source: string, maxBytes: number, signal?: AbortSignal): Promise<{ bytes: Buffer; mimeType?: string }> {
  let url = new URL(source);
  const ssrf = loadSsrfConfig();
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const addresses = await dnsLookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length) throw new Error(`image host ${url.hostname} resolved to no addresses`);
    await validateRemoteUrl(url, { allowRanges: ssrf.allowRanges, trustEnvProxy: false, lookup: async () => addresses });
    const response = await pinnedRequest(url, addresses[0].address, addresses[0].family, signal);
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status) && typeof response.headers.location === "string") {
      response.resume();
      if (redirects === 5) throw new Error("too many redirects fetching image URL");
      url = new URL(response.headers.location, url);
      continue;
    }
    if (status < 200 || status >= 300) { response.resume(); throw new Error(`image URL returned HTTP ${status}`); }
    const length = Number(Array.isArray(response.headers["content-length"]) ? response.headers["content-length"]?.[0] : response.headers["content-length"]);
    if (Number.isFinite(length) && length > maxBytes) { response.destroy(); throw new Error(`image exceeds ${formatBytes(maxBytes)} limit`); }
    const rawType = response.headers["content-type"];
    const contentType = Array.isArray(rawType) ? rawType[0] : rawType;
    return { bytes: await boundedResponse(response, maxBytes, signal), mimeType: normalizeMime(contentType?.split(";", 1)[0]) };
  }
  throw new Error("too many redirects fetching image URL");
}

function pinnedRequest(url: URL, address: string, family: number, signal?: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolveResponse, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)({
      protocol: url.protocol,
      hostname: address,
      family,
      port: url.port ? Number(url.port) : undefined,
      method: "GET",
      path: `${url.pathname}${url.search}`,
      headers: { Host: url.host, Accept: "image/*" },
      signal,
      ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
    }, resolveResponse);
    request.once("error", reject);
    request.end();
  });
}

async function boundedResponse(response: IncomingMessage, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const raw of response) {
      if (signal?.aborted) throw aborted();
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      total += chunk.length;
      if (total > maxBytes) { response.destroy(); throw new Error(`image exceeds ${formatBytes(maxBytes)} limit`); }
      chunks.push(chunk);
    }
  } catch (error) { response.destroy(); throw error; }
  return Buffer.concat(chunks, total);
}

class VisionTimeoutError extends Error {
  constructor(ms: number) { super(`vision request timed out after ${ms}ms`); this.name = "VisionTimeoutError"; }
}

function completionGuard(parent: AbortSignal | undefined, ms: number): { signal: AbortSignal; deadline: Promise<never>; dispose(): void } {
  const controller = new AbortController();
  let rejectDeadline: (error: Error) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const onAbort = () => { controller.abort(parent?.reason); rejectDeadline(aborted()); };
  if (parent?.aborted) queueMicrotask(onAbort); else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { const error = new VisionTimeoutError(ms); controller.abort(error); rejectDeadline(error); }, ms);
  return { signal: controller.signal, deadline, dispose() { clearTimeout(timer); parent?.removeEventListener("abort", onAbort); } };
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolveDelay, reject) => {
    if (signal?.aborted) return reject(aborted());
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(aborted()); };
    timer = setTimeout(() => { cleanup(); resolveDelay(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function assistantText(response: Awaited<ReturnType<typeof complete>>): string {
  if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage ?? `vision model stopped with ${response.stopReason}`);
  const text = response.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n\n").trim();
  if (!text) throw new Error("vision model returned no text content");
  return text;
}

function toolController(pi: ExtensionAPI): ToolController | undefined {
  const candidate = pi as Partial<ToolController>;
  return typeof candidate.getActiveTools === "function" && typeof candidate.setActiveTools === "function" ? candidate as ToolController : undefined;
}

function toolError(text: string, code: string): VisionToolResult {
  return { content: [{ type: "text", text }], details: { mode: "delegate", error: code }, isError: true };
}

function defaultConfig(): VisionDelegationConfig {
  return { enabled: true, cache: { enabled: true, maxEntries: 50 }, fallbackModels: [], maxRetries: 0, retryBackoffMs: 500, timeoutMs: 60_000, maxImageBytes: 20 * 1024 * 1024 };
}

function normalizeConfig(config: VisionDelegationConfig): VisionDelegationConfig {
  return {
    enabled: config.enabled === true,
    ...(modelReference(config.visionModel) ? { visionModel: config.visionModel.trim() } : {}),
    ...(config.customPrompt?.trim() ? { customPrompt: config.customPrompt.trim() } : {}),
    cache: { enabled: config.cache?.enabled !== false, maxEntries: integer(config.cache?.maxEntries, 50, 1, 1_000) },
    fallbackModels: modelReferences(config.fallbackModels),
    maxRetries: integer(config.maxRetries, 2, 0, 10),
    retryBackoffMs: integer(config.retryBackoffMs, 500, 0, MAX_RETRY_BACKOFF_MS),
    timeoutMs: integer(config.timeoutMs, 30_000, 1_000, 300_000),
    maxImageBytes: integer(config.maxImageBytes, 20 * 1024 * 1024, 1_024, 64 * 1024 * 1024),
  };
}

function modelReferences(value: unknown): string[] { return Array.isArray(value) ? [...new Set(value.filter(modelReference).map((v) => v.trim()))] : []; }
function modelReference(value: unknown): value is string { if (typeof value !== "string") return false; const slash = value.trim().indexOf("/"); return slash > 0 && slash < value.trim().length - 1; }
function splitReference(value: string): [string, string] { const slash = value.indexOf("/"); return [value.slice(0, slash), value.slice(slash + 1)]; }

/** qwen-family providers derive enable_thinking from reasoningEffort (pi-ai
 *  openai-completions buildParams), so an absent effort sends
 *  enable_thinking=false, which DashScope rejects for qwen3.8-max-preview.
 *  Mirror the main-session convention (createSummarizationOptions): forward the
 *  session thinking level, clamped to the model's supported levels; fall back
 *  to a non-off level when the runtime did not provide one. */
function visionReasoningEffort(model: Model<Api> | undefined, sessionLevel: ModelThinkingLevel | undefined): string | undefined {
  if (!model?.reasoning) return undefined;
  const requested: ModelThinkingLevel = sessionLevel && sessionLevel !== "off" ? sessionLevel : "high";
  const capped = capVisionReasoningLevel(requested);
  const clamped = clampThinkingLevel(model, capped);
  return clamped === "off" ? undefined : clamped;
}

function capVisionReasoningLevel(level: ModelThinkingLevel): ModelThinkingLevel {
  const levelIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
  const capIndex = EXTENDED_THINKING_LEVELS.indexOf(VISION_REASONING_CAP);
  return levelIndex >= 0 && levelIndex <= capIndex ? level : VISION_REASONING_CAP;
}

/**
 * The host registry refresh fetches per-provider remote catalogs with no
 * timeout and no abort signal of its own; never let that stall delegation.
 * On timeout the previous snapshot stays authoritative and the in-flight
 * refresh keeps running in the background (refreshModelRegistry swallows its
 * own failures).
 */
async function refreshModelRegistryBestEffort(ctx: ExtensionContext): Promise<void> {
  await Promise.race([
    refreshModelRegistry(ctx),
    new Promise<void>((resolve) => setTimeout(resolve, REGISTRY_REFRESH_TIMEOUT_MS)),
  ]);
}
function integer(value: unknown, fallback: number, min: number, max: number): number { return typeof value === "number" && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback; }
function normalizeMime(value: string | undefined): string | undefined { if (!value) return undefined; const lower = value.toLowerCase(); return lower === "image/jpg" ? "image/jpeg" : lower; }
function extensionMime(value: string): string | undefined { return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" } as Record<string, string>)[value.toLowerCase()]; }
function magicMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const prefix = bytes.subarray(0, 6).toString("ascii");
  if (prefix === "GIF87a" || prefix === "GIF89a") return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function formatBytes(bytes: number): string { return `${Math.ceil(bytes / 1024 / 1024)}MB`; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function aborted(): Error { const error = new Error("Vision delegation aborted"); error.name = "AbortError"; return error; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
