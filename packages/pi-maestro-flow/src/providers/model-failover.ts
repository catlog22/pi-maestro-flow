import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  analyzeAttachedImage,
  isMultimodalModel,
  loadVisionDelegationConfig,
  registerVisionDelegation,
  type AttachedImageInput,
} from "./vision-assist.ts";
import {
  isRetryableProviderError,
  sharedModelCircuitBreaker,
  type AcquiredModelCandidate,
  type ModelCircuitBreaker,
} from "pi-maestro-teammate/v1/retry";

export interface ModelFailoverConfig {
  enabled: boolean;
  fallbackModels: Record<string, string[]>;
}

interface ActiveModelRun {
  chain: string[];
  index: number;
  model: string;
  acquisition: AcquiredModelCandidate;
  used: boolean;
  failureRecorded: boolean;
  lastError?: string;
  lastHttpStatus?: number;
  /** True when the switch to this model was triggered by an attached image. */
  imageTriggered?: boolean;
  /** The model in effect before an image-triggered switch; restored on settle. */
  originalModel?: string;
}

export interface ModelFailoverOptions {
  breaker?: ModelCircuitBreaker;
  homeDir?: string;
  visionAgentDir?: string;
  visionAnalyzer?: typeof analyzeAttachedImage;
}

const CONFIG_FILE = "model-failover.json";
/** Upper bound on attached images auto-analyzed in one turn; prevents linear cost blowup. */
const MAX_ATTACHED_IMAGES_PER_TURN = 5;
/**
 * Injected as a follow-up user message after a fallback switch so Pi re-runs
 * the failed turn on the new model. agent_end is terminal: without this the
 * switch would only apply to the next manual prompt. Continuations are bounded
 * by chain length because each failure advances the candidate index.
 */
const FAILOVER_RETRY_PROMPT = "The previous model failed with a transient network or provider error, and the session just switched to a fallback model. Retry the original user request from the beginning and complete it. Do not wait for another user request.";

function emptyConfig(): ModelFailoverConfig {
  return { enabled: false, fallbackModels: {} };
}

function readConfig(filePath: string): Partial<ModelFailoverConfig> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ModelFailoverConfig>;
    const fallbackModels: Record<string, string[]> = {};
    if (parsed.fallbackModels && typeof parsed.fallbackModels === "object") {
      for (const [model, rawFallbacks] of Object.entries(parsed.fallbackModels)) {
        if (!model.includes("/") || !Array.isArray(rawFallbacks)) continue;
        const fallbacks = [...new Set(rawFallbacks
          .filter((candidate): candidate is string => typeof candidate === "string" && candidate.includes("/"))
          .map((candidate) => candidate.trim())
          .filter((candidate) => candidate.length > 0 && candidate !== model))];
        fallbackModels[model] = fallbacks;
      }
    }
    return {
      ...(typeof parsed.enabled === "boolean" ? { enabled: parsed.enabled } : {}),
      fallbackModels,
    };
  } catch {
    return {};
  }
}

export function getGlobalModelFailoverPath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".pi", "agent", CONFIG_FILE);
}

export function getProjectModelFailoverPath(cwd: string): string {
  return path.join(cwd, ".pi", CONFIG_FILE);
}

export function loadModelFailoverConfig(cwd: string, homeDir = os.homedir()): ModelFailoverConfig {
  const globalConfig = readConfig(getGlobalModelFailoverPath(homeDir));
  const projectConfig = readConfig(getProjectModelFailoverPath(cwd));
  return {
    enabled: projectConfig.enabled ?? globalConfig.enabled ?? false,
    fallbackModels: {
      ...(globalConfig.fallbackModels ?? {}),
      ...(projectConfig.fallbackModels ?? {}),
    },
  };
}

export function saveProjectModelFailoverConfig(cwd: string, config: ModelFailoverConfig): void {
  const filePath = getProjectModelFailoverPath(cwd);
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new Error(`Cannot save over invalid project model failover config: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Cannot save over invalid project model failover config: expected a JSON object");
    }
    existing = parsed as Record<string, unknown>;
  }

  const fallbackModels = Object.fromEntries(Object.entries(config.fallbackModels).map(([model, chain]) => [
    model,
    [...new Set(chain.filter((candidate) => candidate !== model))],
  ]));
  const next = {
    ...existing,
    enabled: config.enabled,
    fallbackModels,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function modelKey(model: { provider: string; id: string } | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

function assistantFailure(messages: readonly AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as unknown as {
      role?: string;
      stopReason?: string;
      errorMessage?: string;
    };
    if (message.role !== "assistant") continue;
    return message.stopReason === "error" ? message.errorMessage || "Provider returned error" : undefined;
  }
  return undefined;
}

function availableModels(ctx: ExtensionContext): Map<string, ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number]> {
  return new Map(ctx.modelRegistry.getAvailable().map((model) => [`${model.provider}/${model.id}`, model]));
}

function attachedImages(event: unknown): AttachedImageInput[] {
  if (!isRecord(event) || !Array.isArray(event.images)) return [];
  return event.images.flatMap((image) =>
    isRecord(image) && typeof image.data === "string" && typeof image.mimeType === "string"
      ? [{ data: image.data, mimeType: image.mimeType }]
      : []
  );
}

function prioritizeMultimodalChain(
  chain: string[],
  models: Map<string, ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number]>,
): string[] {
  return [
    ...chain.filter((reference) => isMultimodalModel(models.get(reference))),
    ...chain.filter((reference) => !isMultimodalModel(models.get(reference))),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatModelHealth(breaker: ModelCircuitBreaker): string {
  const snapshots = breaker.snapshot();
  if (snapshots.length === 0) return "No model health observations in this Pi process.";
  return snapshots.map((entry) => {
    const failures = `failures=${entry.consecutiveFailures}`;
    const retry = entry.retryAt === undefined ? "" : ` retryAt=${new Date(entry.retryAt).toISOString()}`;
    return `${entry.model}: ${entry.state} ${failures}${retry}`;
  }).join("\n");
}

export function registerModelFailover(pi: ExtensionAPI, options: ModelFailoverOptions = {}): void {
  if (typeof (pi as { registerTool?: unknown }).registerTool === "function") registerVisionDelegation(pi);
  const breaker = options.breaker ?? sharedModelCircuitBreaker;
  const visionAnalyzer = options.visionAnalyzer ?? analyzeAttachedImage;
  let active: ActiveModelRun | undefined;
  let config = emptyConfig();

  pi.registerCommand("model-failover", {
    description: "Configure main-agent model circuit breaking and ordered fallback chains",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Model failover settings require interactive TUI mode.", "warning");
        return;
      }
      const { showModelFailoverOverlay } = await import("../tui/model-failover-settings.ts");
      const saved = await showModelFailoverOverlay(ctx, breaker);
      if (saved) config = loadModelFailoverConfig(ctx.cwd, options.homeDir);
    },
  });

  pi.registerCommand("model-health", {
    description: "Show model circuit-breaker health and automatic failover state",
    handler: async (_args, ctx) => {
      config = loadModelFailoverConfig(ctx.cwd, options.homeDir);
      const status = config.enabled ? "automatic failover enabled" : "automatic failover disabled";
      ctx.ui.notify(`${status}\n${formatModelHealth(breaker)}`, "info");
    },
  });

  const selectCandidate = async (
    ctx: ExtensionContext,
    chain: string[],
    startIndex: number,
  ): Promise<ActiveModelRun | undefined> => {
    const models = availableModels(ctx);
    for (let index = startIndex; index < chain.length; index += 1) {
      const candidate = chain[index];
      const model = models.get(candidate);
      if (!model) continue;
      const acquisition = breaker.acquireCandidate(candidate);
      if (!acquisition.allowed) continue;
      try {
        const selected = await pi.setModel(model);
        if (!selected) {
          breaker.releaseCandidate(acquisition);
          continue;
        }
      } catch {
        breaker.releaseCandidate(acquisition);
        continue;
      }
      return {
        chain,
        index,
        model: candidate,
        acquisition,
        used: false,
        failureRecorded: false,
      };
    }
    return undefined;
  };

  pi.on("session_start", () => {
    // No config load here: nothing consumes `config` before the next
    // before_agent_start, which reloads unconditionally and remains the
    // external-edit visibility boundary. Loading at session start was always
    // overwritten before use.
    active = undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    config = loadModelFailoverConfig(ctx.cwd, options.homeDir);
    if (active && !active.failureRecorded) breaker.releaseCandidate(active.acquisition);
    active = undefined;

    const current = modelKey(ctx.model);
    if (!current) return;
    const baseChain = [...new Set([current, ...(config.fallbackModels[current] ?? [])])];
    const images = attachedImages(event);
    // Attached-image handling is gated by the vision delegation config, not by
    // model-failover.enabled: the feature must work even when failover is off.
    const visionEnabled = loadVisionDelegationConfig(options.visionAgentDir ?? getAgentDir()).enabled;
    let injectedMessage: { message: { customType: string; content: string; display: boolean } } | undefined;

    if (images.length > 0 && !isMultimodalModel(ctx.model) && visionEnabled) {
      const models = availableModels(ctx);
      const visionChain = prioritizeMultimodalChain(baseChain, models);
      if (visionChain.some((reference) => isMultimodalModel(models.get(reference)))) {
        const preferred = await selectCandidate(ctx, visionChain, 0);
        if (preferred && isMultimodalModel(models.get(preferred.model))) {
          preferred.imageTriggered = true;
          preferred.originalModel = current;
          active = preferred;
          ctx.ui.notify(`Attached image detected; switched from text-only ${current} to multimodal ${preferred.model}.`, "info");
          return;
        }
      }

      // No healthy multimodal candidate: delegate analysis (bounded + cancellable).
      const analyses: string[] = [];
      const signal = ctx.signal;
      for (const [index, image] of images.slice(0, MAX_ATTACHED_IMAGES_PER_TURN).entries()) {
        if (signal?.aborted) break;
        try {
          const result = await visionAnalyzer(ctx, image, {
            agentDir: options.visionAgentDir,
            signal,
            prompt: `Analyze attached image ${index + 1} for the primary coding agent. Extract visible text, structure, UI state, diagrams, and details relevant to the user's request.`,
          });
          analyses.push(`### Attached image ${index + 1} (${result.model})\n${result.text}`);
        } catch (error) {
          ctx.ui.notify(`Automatic vision analysis failed for attached image ${index + 1}: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
      }
      if (analyses.length > 0) {
        injectedMessage = {
          message: {
            customType: "maestro-vision-analysis",
            content: ["Automatic multimodal analysis for the text-only primary model:", ...analyses].join("\n\n"),
            display: false,
          },
        };
      }
    }

    if (!config.enabled) return injectedMessage;

    const chain = images.length > 0 ? prioritizeMultimodalChain(baseChain, availableModels(ctx)) : baseChain;
    const currentIndex = chain.indexOf(current);
    const acquisition = breaker.acquireCandidate(current);
    if (acquisition.allowed) {
      active = { chain, index: currentIndex >= 0 ? currentIndex : 0, model: current, acquisition, used: false, failureRecorded: false };
      return injectedMessage;
    }

    const fallback = await selectCandidate(ctx, chain, 0);
    if (fallback) {
      active = fallback;
      ctx.ui.notify(`Model circuit open for ${current}; switched to ${fallback.model}.`, "warning");
    } else {
      ctx.ui.notify(
        `Model circuit open for ${current} and no healthy fallback available. ` +
        `Continuing with the current model because no fallback can be selected.`,
        "warning",
      );
    }
    return injectedMessage;
  });

  pi.on("turn_start", () => {
    if (active) active.used = true;
  });

  pi.on("after_provider_response", (event) => {
    if (!active) return;
    active.lastHttpStatus = event.status;
    if (event.status >= 400) active.lastError = `Provider returned error: HTTP ${event.status}`;
  });

  pi.on("message_end", (event) => {
    if (!active || event.message.role !== "assistant") return;
    const message = event.message as unknown as { stopReason?: string; errorMessage?: string };
    active.lastError = message.stopReason === "error" ? message.errorMessage : undefined;
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!active || !config.enabled) return;
    const failure = assistantFailure(event.messages as AgentMessage[])
      ?? (active.lastHttpStatus && active.lastHttpStatus >= 400 ? active.lastError : undefined);
    if (!isRetryableProviderError(failure)) return;

    if (active.used && !active.failureRecorded) {
      breaker.recordRetryableFailure(active.acquisition);
      active.failureRecorded = true;
    }

    const failedModel = active.model;
    const previous = active;
    const fallback = await selectCandidate(ctx, active.chain, active.index + 1);
    // Release the old acquisition if it was never settled (e.g. used===false
    // skipped recordRetryableFailure above).  Without this, a HALF_OPEN trial
    // would leak and the circuit could stay stuck.
    if (!previous.failureRecorded) breaker.releaseCandidate(previous.acquisition);
    previous.failureRecorded = true;
    // Guard: agent_settled may have fired during the await and cleared active.
    if (active !== previous) {
      // Release the fallback acquisition that selectCandidate already took;
      // without this a HALF_OPEN trial on the fallback model would leak.
      if (fallback && !fallback.failureRecorded) breaker.releaseCandidate(fallback.acquisition);
      return;
    }
    if (!fallback) return;
    active = fallback;
    // Queued messages already continue the run and will pick up the switched
    // model; an aborted run must not be resurrected by the failover handler.
    if (ctx.signal?.aborted || ctx.hasPendingMessages()) {
      ctx.ui.notify(`Model ${failedModel} failed; switched to ${fallback.model} for the next turn.`, "warning");
      return;
    }
    try {
      pi.sendUserMessage(FAILOVER_RETRY_PROMPT, { deliverAs: "followUp" });
      ctx.ui.notify(`Model ${failedModel} failed; continuing the turn with ${fallback.model}.`, "warning");
    } catch {
      ctx.ui.notify(`Model ${failedModel} failed; switched to ${fallback.model} for the next turn.`, "warning");
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const activeRun = active;
    if (activeRun?.used && !activeRun.failureRecorded && !activeRun.lastError) {
      breaker.recordSuccess(activeRun.acquisition);
    } else if (activeRun && !activeRun.failureRecorded) {
      breaker.releaseCandidate(activeRun.acquisition);
    }
    active = undefined;
    // Restore the pre-image model after an image-triggered switch settles so
    // later text-only turns do not keep paying multimodal cost/behavior.
    if (activeRun?.imageTriggered && activeRun.originalModel) {
      const original = availableModels(ctx).get(activeRun.originalModel);
      if (original) {
        const restored = await pi.setModel(original);
        if (restored) {
          ctx.ui.notify(`Restored text-only model ${activeRun.originalModel} after image analysis.`, "info");
        }
      }
    }
  });

  pi.on("session_shutdown", () => {
    if (active && !active.failureRecorded) breaker.releaseCandidate(active.acquisition);
    active = undefined;
  });
}
