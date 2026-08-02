import { randomUUID } from "node:crypto";
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
  classifyRetryError,
  RECOVERY_PROTOCOL_VERSION,
  sharedModelCircuitBreaker,
  type AcquiredModelCandidate,
  type ModelCircuitBreaker,
  type RecoveryFallbackModelIntent,
  type ReplayFence,
  type RetryErrorKind,
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

interface AgentEndObservation {
  outcome: "success" | "failed" | "cancelled";
  failure?: string;
  failureKind?: RetryErrorKind;
  completedTools: readonly string[];
  unknownEffect: boolean;
}

export type ModelFailoverSettlementOutcome =
  | "success"
  | "failed"
  | "cancelled"
  | "fallback-scheduled"
  | "replay-blocked";

export interface ModelFailoverSettlementSnapshot {
  protocolVersion: typeof RECOVERY_PROTOCOL_VERSION;
  recoveryId: string;
  outcome: ModelFailoverSettlementOutcome;
  model: string;
  failure?: string;
  fallbackModel?: string;
  replayFence: ReplayFence;
}

let settlementArbitration: Readonly<ModelFailoverSettlementSnapshot> | undefined;

/** Observe the latest main-agent settlement without consuming Goal's one-shot arbitration claim. */
export function snapshotModelFailoverSettlement(): Readonly<ModelFailoverSettlementSnapshot> | undefined {
  return settlementArbitration;
}

/** Consume the latest settlement once. A recovery id prevents a stale observer from clearing a newer result. */
export function consumeModelFailoverSettlement(recoveryId?: string): Readonly<ModelFailoverSettlementSnapshot> | undefined {
  if (!settlementArbitration || (recoveryId !== undefined && settlementArbitration.recoveryId !== recoveryId)) return undefined;
  const consumed = settlementArbitration;
  settlementArbitration = undefined;
  return consumed;
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
const FAILOVER_RETRY_PROMPT = "The previous model exhausted its native retries with a transient network, provider, or quota error. Retry the original user request from the beginning on the selected fallback model and complete it.";
const FAILOVER_RECOVERY_MARKER = "maestro-model-failover";

function recoveryPrompt(recoveryId: string): string {
  return `${FAILOVER_RETRY_PROMPT}\n\n[${FAILOVER_RECOVERY_MARKER}:${recoveryId}]`;
}

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

function observeAgentEnd(
  messages: readonly AgentMessage[],
  fallbackFailure: string | undefined,
  completedTools: readonly string[],
  unknownEffect: boolean,
): AgentEndObservation {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as unknown as { role?: string; stopReason?: string; errorMessage?: string };
    if (message.role !== "assistant") continue;
    if (message.stopReason === "aborted") {
      return { outcome: "cancelled", completedTools: [...completedTools], unknownEffect };
    }
    if (message.stopReason === "error") {
      const failure = message.errorMessage || fallbackFailure || "Provider returned error";
      return {
        outcome: "failed",
        failure,
        failureKind: classifyRetryError(failure),
        completedTools: [...completedTools],
        unknownEffect,
      };
    }
    return { outcome: "success", completedTools: [...completedTools], unknownEffect };
  }
  if (fallbackFailure) {
    return {
      outcome: "failed",
      failure: fallbackFailure,
      failureKind: classifyRetryError(fallbackFailure),
      completedTools: [...completedTools],
      unknownEffect,
    };
  }
  return { outcome: "success", completedTools: [...completedTools], unknownEffect };
}

function replayFence(observation: AgentEndObservation): ReplayFence {
  const completedTools = Object.freeze([...observation.completedTools]);
  if (completedTools.length > 0 || observation.unknownEffect) {
    const evidence = [
      completedTools.length > 0 ? `completed tools: ${completedTools.join(", ")}` : undefined,
      observation.unknownEffect ? "one or more tool effects could not be confirmed" : undefined,
    ].filter(Boolean).join("; ");
    return Object.freeze({ completedTools, blocked: true, blockedReason: `Fresh replay blocked after ${evidence}.` });
  }
  return Object.freeze({ completedTools, blocked: false });
}

function publishSettlement(snapshot: ModelFailoverSettlementSnapshot): Readonly<ModelFailoverSettlementSnapshot> {
  const frozen = Object.freeze({ ...snapshot, replayFence: Object.freeze({ ...snapshot.replayFence }) });
  settlementArbitration = frozen;
  return frozen;
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
  let finalObservation: AgentEndObservation | undefined;
  let pendingRecoveryId: string | undefined;
  const completedTools: string[] = [];
  const startedTools = new Map<string, string>();
  let config = emptyConfig();

  const resetRunEvidence = (): void => {
    finalObservation = undefined;
    completedTools.length = 0;
    startedTools.clear();
  };

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
    pendingRecoveryId = undefined;
    resetRunEvidence();
    settlementArbitration = undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    config = loadModelFailoverConfig(ctx.cwd, options.homeDir);
    const recoveryId = pendingRecoveryId;
    if (active && recoveryId && event.prompt.includes(`[${FAILOVER_RECOVERY_MARKER}:${recoveryId}]`)) {
      // The fallback acquisition was made after the previous logical run
      // settled. Consume its handoff exactly once and retain that acquisition.
      pendingRecoveryId = undefined;
      active.used = false;
      active.lastError = undefined;
      active.lastHttpStatus = undefined;
      resetRunEvidence();
      return;
    }
    pendingRecoveryId = undefined;
    if (active && !active.failureRecorded) breaker.releaseCandidate(active.acquisition);
    active = undefined;
    resetRunEvidence();

    const current = modelKey(ctx.model);
    if (!current) return;
    const configuredFallbacks = config.fallbackModels[current] ?? [];
    const baseChain = [...new Set([current, ...configuredFallbacks])];
    const images = attachedImages(event);
    // Attached-image handling is gated by the vision delegation config, not by
    // model-failover.enabled: the feature must work even when failover is off.
    const visionEnabled = loadVisionDelegationConfig(options.visionAgentDir ?? getAgentDir()).enabled;
    let injectedMessage: { message: { customType: string; content: string; display: boolean } } | undefined;

    if (images.length > 0 && !isMultimodalModel(ctx.model) && visionEnabled) {
      const models = availableModels(ctx);
      const visionChain = baseChain.filter((reference) => isMultimodalModel(models.get(reference)));
      if (visionChain.length > 0) {
        const preferred = await selectCandidate(ctx, visionChain, 0);
        if (preferred) {
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

    // Without an explicit fallback chain every other authenticated model is an
    // implicit ordered fallback, mirroring teammate's implicit candidate sweep
    // so a default install can still auto-recover from network/quota failures.
    const fallbackChain = configuredFallbacks.length === 0
      ? [...new Set([...baseChain, ...availableModels(ctx).keys()])]
      : baseChain;
    const chain = images.length > 0 ? prioritizeMultimodalChain(fallbackChain, availableModels(ctx)) : fallbackChain;
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

  pi.on("tool_execution_start", (event) => {
    if (!active) return;
    startedTools.set(event.toolCallId, event.toolName);
  });

  pi.on("tool_execution_end", (event) => {
    if (!active) return;
    startedTools.delete(event.toolCallId);
    completedTools.push(event.toolName);
  });

  pi.on("after_provider_response", (event) => {
    if (!active) return;
    active.lastHttpStatus = event.status;
    active.lastError = event.status >= 400 ? `Provider returned error: HTTP ${event.status}` : undefined;
  });

  pi.on("message_end", (event) => {
    if (!active || event.message.role !== "assistant") return;
    const message = event.message as unknown as { stopReason?: string; errorMessage?: string };
    active.lastError = message.stopReason === "error" ? message.errorMessage : undefined;
  });

  pi.on("agent_end", (event) => {
    if (!active || !config.enabled) return;
    const fallbackFailure = active.lastHttpStatus && active.lastHttpStatus >= 400 ? active.lastError : undefined;
    // Pi's extension event omits willRetry. This observation may be replaced by
    // a later native retry/compaction/queue-drain result before agent_settled.
    finalObservation = observeAgentEnd(
      event.messages as AgentMessage[],
      fallbackFailure,
      completedTools,
      startedTools.size > 0,
    );
  });

  pi.on("agent_settled", async (_event, ctx) => {
    // A fallback selected by this same handler belongs to the next logical run;
    // duplicate settlement delivery for the old run must not settle it early.
    if (pendingRecoveryId) return;
    const activeRun = active;
    if (!activeRun) return;
    active = undefined;

    const recoveryId = randomUUID();
    const observation: AgentEndObservation = ctx.signal?.aborted
      ? {
          outcome: "cancelled",
          completedTools: [...(finalObservation?.completedTools ?? completedTools)],
          unknownEffect: finalObservation?.unknownEffect ?? startedTools.size > 0,
        }
      : finalObservation ?? {
          outcome: "failed",
          failure: "Agent settled without a final agent_end observation",
          failureKind: "non-retryable",
          completedTools: [...completedTools],
          unknownEffect: startedTools.size > 0,
        };
    const fence = replayFence(observation);
    const baseSnapshot = {
      protocolVersion: RECOVERY_PROTOCOL_VERSION,
      recoveryId,
      model: activeRun.model,
      ...(observation.failure ? { failure: observation.failure } : {}),
      replayFence: fence,
    };

    const restoreImageModel = async (): Promise<void> => {
      if (!activeRun.imageTriggered || !activeRun.originalModel) return;
      const original = availableModels(ctx).get(activeRun.originalModel);
      if (!original) return;
      const restored = await pi.setModel(original);
      if (restored) ctx.ui.notify(`Restored text-only model ${activeRun.originalModel} after image analysis.`, "info");
    };

    if (observation.outcome === "cancelled") {
      if (!activeRun.failureRecorded) breaker.releaseCandidate(activeRun.acquisition);
      activeRun.failureRecorded = true;
      publishSettlement({ ...baseSnapshot, outcome: "cancelled" });
      await restoreImageModel();
      return;
    }

    if (observation.outcome === "success") {
      if (!activeRun.failureRecorded) {
        if (activeRun.used) breaker.recordSuccess(activeRun.acquisition);
        else breaker.releaseCandidate(activeRun.acquisition);
      }
      activeRun.failureRecorded = true;
      publishSettlement({ ...baseSnapshot, outcome: "success" });
      await restoreImageModel();
      return;
    }

    // Authentication, invalid-model, context, and other terminal failures do
    // not poison provider health and never initiate a fresh logical replay.
    if (!config.enabled || observation.failureKind === "non-retryable") {
      if (!activeRun.failureRecorded) breaker.releaseCandidate(activeRun.acquisition);
      activeRun.failureRecorded = true;
      publishSettlement({ ...baseSnapshot, outcome: "failed" });
      await restoreImageModel();
      return;
    }

    // Native retries are now exhausted. Charge this candidate once, and only
    // now, before considering one fallback logical run.
    if (!activeRun.failureRecorded) breaker.recordRetryableFailure(activeRun.acquisition);
    activeRun.failureRecorded = true;

    if (fence.blocked) {
      publishSettlement({ ...baseSnapshot, outcome: "replay-blocked" });
      ctx.ui.notify(
        `Model ${activeRun.model} exhausted its retries, but automatic restart was blocked because tool effects were observed.`,
        "warning",
      );
      await restoreImageModel();
      return;
    }

    const fallback = await selectCandidate(ctx, activeRun.chain, activeRun.index + 1);
    if (!fallback) {
      publishSettlement({ ...baseSnapshot, outcome: "failed" });
      ctx.ui.notify(
        `Model ${activeRun.model} exhausted its retries and no further fallback is available.`,
        "warning",
      );
      await restoreImageModel();
      return;
    }

    const intent: RecoveryFallbackModelIntent = {
      intentId: `${recoveryId}:fallback`,
      kind: "fallback_model",
      fromModel: activeRun.model,
      toModel: fallback.model,
      mode: "restart",
      replayFence: fence,
    };
    active = fallback;
    pendingRecoveryId = recoveryId;
    publishSettlement({ ...baseSnapshot, outcome: "fallback-scheduled", fallbackModel: fallback.model });
    setTimeout(() => {
      if (pendingRecoveryId !== recoveryId
        || active !== fallback
        || active.acquisition !== fallback.acquisition
        || fallback.failureRecorded) return;
      // sendCustomMessage({ triggerTurn: true }) starts a hidden custom turn
      // directly and does not emit before_agent_start. Transfer ownership to
      // the fallback run before starting it so its agent_settled can arbitrate.
      pendingRecoveryId = undefined;
      fallback.used = false;
      fallback.lastError = undefined;
      fallback.lastHttpStatus = undefined;
      resetRunEvidence();
      try {
        pi.sendMessage({
          customType: FAILOVER_RECOVERY_MARKER,
          content: recoveryPrompt(recoveryId),
          display: false,
          details: { protocolVersion: RECOVERY_PROTOCOL_VERSION, recoveryId, intent },
        }, { triggerTurn: true });
        ctx.ui.notify(`Model ${activeRun.model} exhausted its retries; starting one fallback run with ${fallback.model}.`, "warning");
      } catch (error) {
        if (!fallback.failureRecorded) breaker.releaseCandidate(fallback.acquisition);
        fallback.failureRecorded = true;
        if (active === fallback) active = undefined;
        if (pendingRecoveryId === recoveryId) pendingRecoveryId = undefined;
        publishSettlement({
          ...baseSnapshot,
          outcome: "failed",
          failure: `Fallback handoff failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        ctx.ui.notify(`Model fallback could not start on ${fallback.model}.`, "warning");
      }
    }, 0);
  });

  pi.on("session_shutdown", () => {
    if (active && !active.failureRecorded) breaker.releaseCandidate(active.acquisition);
    active = undefined;
    pendingRecoveryId = undefined;
    resetRunEvidence();
    settlementArbitration = undefined;
  });
}
