import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SOFT_COMPACTION,
  readEffectiveCompactionSettings,
  type EffectiveCompactionSettings,
  type SoftCompactionSettings,
} from "./compaction-settings.ts";
import {
  type CompactionArbiter,
  type CompactionLease,
} from "./compaction-arbiter.ts";
import {
  autoCompactionIdleStatus,
  COMPACTION_MODE_STATUS_KEY,
  COMPACTION_STATUS_KEY,
} from "./maestro-compaction.ts";
import { loadPiCompactionInternals, type PiCompactionInternals } from "./pi-internals.ts";

const MIN_PRUNABLE_TOOL_RESULT_CHARS = 4_000;
const REPLAYABLE_TOOL_NAMES = new Set(["read", "grep", "glob", "search", "find"]);
// Bulk data tools whose large non-error output is transient and safe to evict
// under sustained pressure. Control tools (e.g. todo) are deliberately absent so
// their state-bearing output is never pruned.
const EVICTABLE_BULK_TOOL_NAMES = new Set(["bash", "shell", "edit", "write"]);
// Content-aware chars-per-token ratios: a flat /4 miscounts the two content
// types that dominate coding sessions — fenced code is token-denser (~3.5) and
// whitespace-heavy logs/tables are token-sparser (~6). Ordinary content keeps the
// proven /4 default so low-pressure estimates stay stable.
const TOKEN_RATIO_CODE = 3.5;
const TOKEN_RATIO_WHITESPACE_HEAVY = 6;
const TOKEN_RATIO_DEFAULT = 4;
const CONTINUE_PROMPT = "Continue the interrupted task from the compacted session checkpoint. Do not wait for another user request.";
const OUTPUT_LIMIT_CONTINUE_PROMPT = "Your previous response was cut off at the model output token limit, and the context was just compacted to free room. Continue exactly from where the interrupted response stopped and complete it. Do not restart or wait for another user request.";
const DEFAULT_OUTPUT_LIMIT_RATIO = 0.8;
export const MAX_OUTPUT_LIMIT_COMPACTIONS = 2;
const PRUNE_STATE_ENTRY_TYPE = "maestro-auto-prune-state";
const PRUNE_STATE_VERSION = 1;

export type CompactionSettings = Pick<
  EffectiveCompactionSettings,
  "enabled" | "reserveTokens" | "keepRecentTokens"
> & { soft?: EffectiveCompactionSettings["soft"] };

interface ContextEstimate {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
}

interface AppliedPrunes {
  messages: AgentMessage[];
  prunedToolResults: number;
  savedTokens: number;
  pendingSavedTokens: number;
}

export interface PruneManifestEntry {
  replacement: AgentMessage;
  savedTokens: number;
  introducedAtUsageEpoch?: string;
}

/** Set is retained for callers that used the original exported policy signature. */
export type PruneManifest = Set<string> | Map<string, PruneManifestEntry>;

export type ContextPressureBand = "normal" | "nudge" | "auto-prune" | "critical";

/** What the pressure policy actually does, separated from the band label. */
export type ContextAction = "none" | "prune" | "compact";

export interface ContextDecision {
  band: ContextPressureBand;
  action: ContextAction;
  reasons: string[];
}

/**
 * Telemetry signals derived from the current context. velocity is added once a
 * tracker lands; cacheHitRatio is undefined when no usable provider usage exists.
 */
export interface ContextSignals {
  fullnessRatio: number;
  criticalGap: number;
  prunableFraction: number;
  /** Fraction of estimated tokens occupied by stale duplicate tool outputs. */
  redundantFraction?: number;
  cacheHitRatio: number | undefined;
}

export interface VelocitySample {
  epoch: string;
  tokens: number;
}

/** Short-lived ring buffer of per-epoch context-size samples; owned by evaluate(). */
export interface VelocityTracker {
  samples: VelocitySample[];
}

export interface VelocityInfo {
  /** Median tokens-per-epoch slope; undefined until >=3 samples exist. */
  slope: number | undefined;
  /** True when the recent window shows >=2 consecutive positive diffs. */
  robustGrowth: boolean;
  /** Estimated epochs until the critical threshold at the current slope. */
  epochsToCritical: number | undefined;
}

export interface ContextPressureResult {
  messages: AgentMessage[];
  band: ContextPressureBand;
  estimatedTokens: number;
  thresholdTokens: number;
  prunedToolResults: number;
  savedTokens: number;
  action: ContextAction;
  reasons: string[];
  velocityTracker: VelocityTracker;
  velocity: VelocityInfo;
}

interface AutoCompactionState {
  running: boolean;
  generation: number;
  nextOwner: number;
  activeOwner?: number;
  activeLease?: CompactionLease;
  lastTriggerKey?: string;
  internalsWarningShown: boolean;
  lastNoCompactableKey?: string;
  pruneManifest: Map<string, PruneManifestEntry>;
  restoredPruneIds: Set<string>;
  sessionId?: string;
  persistedPruneKey?: string;
  settingsSnapshot?: CompactionSettings;
  settingsCwd?: string;
  velocityTracker: VelocityTracker;
  consecutiveFailures: number;
  breakerTrippedAtTurn?: number;
  breakerNotified: boolean;
  turnCount: number;
  outputLimitCompactions: number;
  outputLimitBreakerNotified: boolean;
}

interface AutoCompactionDependencies {
  loadInternals?: () => Promise<PiCompactionInternals>;
  readSettings?: (projectRoot: string) => CompactionSettings;
  arbiter?: CompactionArbiter;
}

interface MessageRecord {
  role?: unknown;
  content?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
  usage?: unknown;
  stopReason?: unknown;
}

export function createMidTurnAutoCompaction(pi: ExtensionAPI, dependencies: AutoCompactionDependencies = {}): {
  onSessionStart(ctx: ExtensionContext): void;
  evaluate(messages: AgentMessage[], ctx: ExtensionContext): Promise<AgentMessage[] | undefined>;
  onAgentEnd(ctx: ExtensionContext): void;
  onOutputLimit(messages: AgentMessage[], ctx: ExtensionContext): Promise<void>;
  onCompact(): void;
  reset(ctx?: ExtensionContext): void;
  refreshSettings(): void;
} {
  const state: AutoCompactionState = {
    running: false,
    generation: 0,
    nextOwner: 0,
    internalsWarningShown: false,
    pruneManifest: new Map(),
    restoredPruneIds: new Set(),
    velocityTracker: EMPTY_VELOCITY_TRACKER,
    consecutiveFailures: 0,
    breakerNotified: false,
    turnCount: 0,
    outputLimitCompactions: 0,
    outputLimitBreakerNotified: false,
  };
  const loadInternals = dependencies.loadInternals ?? loadPiCompactionInternals;
  const readSettings = dependencies.readSettings ?? readEffectiveCompactionSettings;
  // Settings are reparsed at most once per turn boundary (F11): the snapshot is
  // reused across the many context-hook evaluations within a turn and re-read only
  // when the cwd changes or refreshSettings() invalidates it.
  function settingsFor(ctx: ExtensionContext): CompactionSettings {
    if (!state.settingsSnapshot || state.settingsCwd !== ctx.cwd) {
      state.settingsSnapshot = readSettings(ctx.cwd);
      state.settingsCwd = ctx.cwd;
    }
    return state.settingsSnapshot;
  }
  return {
    onSessionStart(ctx) {
      state.pruneManifest.clear();
      state.sessionId = sessionIdOf(ctx);
      state.restoredPruneIds = loadPersistedPruneIds(ctx, state.sessionId);
      state.persistedPruneKey = pruneKey(state.restoredPruneIds);
      state.settingsSnapshot = undefined;
      state.velocityTracker = EMPTY_VELOCITY_TRACKER;
      state.consecutiveFailures = 0;
      state.breakerTrippedAtTurn = undefined;
      state.breakerNotified = false;
      state.turnCount = 0;
      state.outputLimitCompactions = 0;
      state.outputLimitBreakerNotified = false;
      publishIdleStatus(ctx, settingsFor(ctx).enabled);
    },
    async evaluate(messages, ctx) {
      const generation = state.generation;
      if (state.running) return undefined;
      const settings = settingsFor(ctx);
      publishIdleStatus(ctx, settings.enabled);
      if (!ctx.model) {
        clearPressureStatus(ctx);
        return undefined;
      }
      if (!settings.enabled || ctx.model.contextWindow <= settings.reserveTokens) {
        state.pruneManifest.clear();
        state.restoredPruneIds.clear();
        persistPruneManifest(pi, state);
        clearPressureStatus(ctx);
        return undefined;
      }
      hydrateRestoredPrunes(state, messages);
      retainVisiblePrunes(state.pruneManifest, messages);
      if (!endsWithCompleteToolResultBatch(messages)) {
        clearPressureStatus(ctx);
        const stable = applyRecordedPrunes(messages, state.pruneManifest);
        persistPruneManifest(pi, state);
        return stable.prunedToolResults > 0 ? stable.messages : undefined;
      }
      const effectiveSettings: CompactionSettings = {
        ...settings,
        reserveTokens: effectiveReserveTokens(settings, ctx.model.contextWindow, ctx.model.maxTokens),
      };
      const pressure = applyContextPressurePolicy(
        messages,
        ctx.model.contextWindow,
        effectiveSettings,
        state.pruneManifest,
        state.velocityTracker,
      );
      state.velocityTracker = pressure.velocityTracker;
      updatePressureStatus(ctx, pressure);
      persistPruneManifest(pi, state);
      if (pressure.action !== "compact") {
        state.lastNoCompactableKey = undefined;
        return pressure.prunedToolResults > 0 ? pressure.messages : undefined;
      }
      const estimate = estimateContextTokens(pressure.messages);
      const thresholdTokens = pressure.thresholdTokens;

      const triggerKey = `${estimate.tokens}:${thresholdTokens}:${messages.length}`;
      if (state.lastTriggerKey === triggerKey) return pressure.messages;
      const breakerCheck = compactionBreakerAllows(
        { consecutiveFailures: state.consecutiveFailures, trippedAtTurn: state.breakerTrippedAtTurn },
        state.turnCount,
      );
      state.consecutiveFailures = breakerCheck.breaker.consecutiveFailures;
      state.breakerTrippedAtTurn = breakerCheck.breaker.trippedAtTurn;
      if (!breakerCheck.allowed) {
        if (!state.breakerNotified) {
          state.breakerNotified = true;
          ctx.ui.notify(
            `Mid-turn compaction paused after ${state.consecutiveFailures} consecutive failures; retrying after ${COMPACTION_BREAKER_COOLDOWN_TURNS} turns.`,
            "warning",
          );
        }
        return pressure.messages;
      }
      let internals: PiCompactionInternals;
      try {
        internals = await loadInternals();
      } catch (error) {
        if (state.generation !== generation) return undefined;
        clearPressureStatus(ctx);
        if (!state.internalsWarningShown) {
          state.internalsWarningShown = true;
          ctx.ui.notify(`Mid-turn compaction disabled: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
        return pressure.messages;
      }
      if (state.generation !== generation || state.running) return undefined;
      // Defer before Pi's prepareCompaction scan: an in-flight owner will deny the
      // lease anyway, and preparing a compaction we cannot own widens the TOCTOU
      // window that can surface "Already compacted".
      if (dependencies.arbiter?.currentOwner()) return pressure.messages;
      const branch = ctx.sessionManager.getBranch();
      let preparation: unknown;
      try {
        preparation = internals.prepareCompaction(branch, settings);
      } catch (error) {
        clearPressureStatus(ctx);
        ctx.ui.notify(`Mid-turn compaction preparation failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
        return pressure.messages;
      }
      if (!preparation) {
        ctx.ui.setStatus(COMPACTION_STATUS_KEY, `CTX CRITICAL ${pressure.estimatedTokens}/${thresholdTokens}`);
        const noCompactableKey = `${thresholdTokens}:${settings.keepRecentTokens}:${branch.length}`;
        if (state.lastNoCompactableKey !== noCompactableKey) {
          state.lastNoCompactableKey = noCompactableKey;
          ctx.ui.notify(
            "Mid-turn compaction skipped: Pi has no compactable history; context pressure is inside the recent keep window or static prompt overhead.",
            "warning",
          );
        }
        return pressure.messages;
      }
      state.lastNoCompactableKey = undefined;
      const lease = dependencies.arbiter?.request("mid-turn");
      if (dependencies.arbiter && !lease) return pressure.messages;
      state.lastTriggerKey = triggerKey;
      state.running = true;
      state.activeLease = lease;
      const owner = ++state.nextOwner;
      state.activeOwner = owner;
      ctx.abort();
      ctx.ui.setStatus(COMPACTION_STATUS_KEY, `COMPACT ${estimate.tokens}/${thresholdTokens}`);
      const failCompaction = (error: unknown) => {
        if (state.generation !== generation || state.activeOwner !== owner) return;
        const failed = recordCompactionFailure(
          { consecutiveFailures: state.consecutiveFailures, trippedAtTurn: state.breakerTrippedAtTurn },
          state.turnCount,
        );
        state.consecutiveFailures = failed.consecutiveFailures;
        state.breakerTrippedAtTurn = failed.trippedAtTurn;
        state.running = false;
        state.activeOwner = undefined;
        state.lastTriggerKey = undefined;
        state.activeLease?.release();
        state.activeLease = undefined;
        clearPressureStatus(ctx);
        ctx.ui.notify(`Mid-turn compaction failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      };
      const instructions = buildMidTurnInstructions(
        estimate,
        ctx.model.contextWindow,
        effectiveSettings.reserveTokens,
      );
      try {
        ctx.compact({
          customInstructions: state.activeLease?.tagInstructions(instructions) ?? instructions,
          onComplete: () => {
            if (state.generation !== generation || state.activeOwner !== owner) return;
            state.consecutiveFailures = 0;
            state.breakerTrippedAtTurn = undefined;
            state.breakerNotified = false;
            state.running = false;
            state.activeOwner = undefined;
            state.lastTriggerKey = undefined;
            state.activeLease?.release();
            state.activeLease = undefined;
            clearPressureStatus(ctx);
            // 压缩完成期间，Goal 或其他扩展可能已投递恢复提示；保留最先入队的续接。
            if (ctx.hasPendingMessages?.()) return;
            try {
              pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "followUp" });
            } catch (error) {
              ctx.ui.notify(`Mid-turn continuation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
            }
          },
          onError: failCompaction,
        });
      } catch (error) {
        failCompaction(error);
      }
      return pressure.messages;
    },
    onAgentEnd(ctx) {
      state.turnCount += 1;
      if (!state.running) {
        // Turn boundary: refresh so settings edited during the turn are reflected.
        state.settingsSnapshot = undefined;
        publishIdleStatus(ctx, settingsFor(ctx).enabled);
        clearPressureStatus(ctx);
      }
    },
    async onOutputLimit(messages, ctx) {
      const settings = settingsFor(ctx);
      const finalStopReason = finalAssistantStopReason(messages);
      if (!settings.enabled || !ctx.model || finalStopReason !== "length") {
        state.outputLimitCompactions = 0;
        state.outputLimitBreakerNotified = false;
        return;
      }
      const usage = ctx.getContextUsage?.();
      const threshold = settings.soft?.pruneRatio ?? DEFAULT_OUTPUT_LIMIT_RATIO;
      if (usage?.percent == null || usage.percent / 100 < threshold) return;
      if (state.outputLimitCompactions >= MAX_OUTPUT_LIMIT_COMPACTIONS) {
        if (!state.outputLimitBreakerNotified) {
          state.outputLimitBreakerNotified = true;
          ctx.ui.notify(
            `Output-limit compaction stopped after ${state.outputLimitCompactions} attempts; the response keeps hitting the model output token limit. Raise maxTokens or reduce per-response size.`,
            "warning",
          );
        }
        return;
      }
      if (ctx.hasPendingMessages?.()) return;
      if (dependencies.arbiter?.currentOwner()) return;
      let internals: PiCompactionInternals;
      try {
        internals = await loadInternals();
      } catch {
        return;
      }
      const branch = ctx.sessionManager.getBranch();
      let preparation: unknown;
      try {
        preparation = internals.prepareCompaction(branch, settings);
      } catch {
        return;
      }
      if (!preparation) return;
      const lease = dependencies.arbiter?.request("output-limit");
      if (dependencies.arbiter && !lease) return;
      state.outputLimitCompactions += 1;
      const instructions = buildOutputLimitInstructions(usage, effectiveReserveTokens(settings, ctx.model.contextWindow, ctx.model.maxTokens));
      const failOutputLimit = (error: unknown) => {
        lease?.release();
        ctx.ui.notify(`Output-limit compaction failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      };
      try {
        ctx.compact({
          customInstructions: lease?.tagInstructions(instructions) ?? instructions,
          onComplete: () => {
            lease?.release();
            if (ctx.hasPendingMessages?.()) return;
            try {
              pi.sendUserMessage(OUTPUT_LIMIT_CONTINUE_PROMPT, { deliverAs: "followUp" });
            } catch (error) {
              ctx.ui.notify(`Output-limit continuation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
            }
          },
          onError: failOutputLimit,
        });
      } catch (error) {
        failOutputLimit(error);
      }
    },
    onCompact() {
      state.pruneManifest.clear();
      state.restoredPruneIds.clear();
      state.persistedPruneKey = undefined;
      state.lastTriggerKey = undefined;
      state.lastNoCompactableKey = undefined;
      state.velocityTracker = EMPTY_VELOCITY_TRACKER;
      state.consecutiveFailures = 0;
      state.breakerTrippedAtTurn = undefined;
      state.breakerNotified = false;
      state.outputLimitCompactions = 0;
      state.outputLimitBreakerNotified = false;
    },
    reset(ctx) {
      state.generation += 1;
      state.running = false;
      state.activeOwner = undefined;
      state.activeLease?.release();
      state.activeLease = undefined;
      state.lastTriggerKey = undefined;
      state.internalsWarningShown = false;
      state.lastNoCompactableKey = undefined;
      state.pruneManifest.clear();
      state.restoredPruneIds.clear();
      state.persistedPruneKey = undefined;
      state.settingsSnapshot = undefined;
      state.settingsCwd = undefined;
      state.velocityTracker = EMPTY_VELOCITY_TRACKER;
      state.consecutiveFailures = 0;
      state.breakerTrippedAtTurn = undefined;
      state.breakerNotified = false;
      state.turnCount = 0;
      state.outputLimitCompactions = 0;
      state.outputLimitBreakerNotified = false;
      persistPruneManifest(pi, state);
      if (ctx) {
        clearPressureStatus(ctx);
        ctx.ui.setStatus(COMPACTION_MODE_STATUS_KEY, undefined);
      }
    },
    refreshSettings() {
      state.settingsSnapshot = undefined;
    },
  };
}

/**
 * Minimum context-window fraction kept free when neither the configured reserve
 * nor the model's max output demand more. A fixed absolute reserve (e.g. 16K)
 * sits dangerously close to 100% on large windows — 400K would only trigger
 * compaction past 95.9% — so this ratio floor keeps compaction starting around
 * 90% regardless of window size.
 */
export const MIN_RESERVE_RATIO = 0.1;

/**
 * Derive the reserve that drives the proactive compaction trigger from the
 * model's real limits:
 * - the configured reserve (the user's compaction ceiling), honored as a floor;
 * - a ratio of the context window, so large windows still keep output room;
 * - the model's maximum single-response output, so the trigger never sits closer
 *   to the limit than one full response and a max-size response cannot truncate
 *   against the context window.
 * The max-output term is capped below the window so compaction always retains a
 * usable recent context and never disables itself.
 */
export function effectiveReserveTokens(
  settings: Pick<CompactionSettings, "reserveTokens">,
  contextWindow: number,
  modelMaxTokens?: number,
): number {
  const ratioFloor = Math.floor(contextWindow * MIN_RESERVE_RATIO);
  let reserve = Math.max(settings.reserveTokens, ratioFloor);
  if (typeof modelMaxTokens === "number" && modelMaxTokens > reserve) {
    reserve = Math.min(modelMaxTokens, contextWindow - ratioFloor);
  }
  return reserve;
}

export function applyContextPressurePolicy(
  messages: AgentMessage[],
  contextWindow: number,
  settings: CompactionSettings,
  pruneManifest: PruneManifest = new Map(),
  velocityTracker: VelocityTracker = EMPTY_VELOCITY_TRACKER,
): ContextPressureResult {
  const thresholdTokens = contextWindow - settings.reserveTokens;
  const applied = applyRecordedPrunes(messages, pruneManifest);
  const transformed = applied.messages;
  let savedTokens = applied.savedTokens;
  let prunedToolResults = applied.prunedToolResults;

  // A prune introduced after the latest successful provider usage is still
  // pending acknowledgement. Its saved tokens must remain deducted until a
  // later provider response establishes a new usage epoch.
  const initial = Math.max(0, estimateContextTokens(transformed).tokens - applied.pendingSavedTokens);
  const soft = settings.soft ?? DEFAULT_SOFT_COMPACTION;
  const criticalRatio = thresholdTokens / contextWindow;
  const initialRatio = initial / contextWindow;
  const initiallyCritical = initial > thresholdTokens;

  // Velocity is sampled on the pre-new-prune effective estimate so recorded
  // prunes stay accounted for and pruning does not create false slopes. Off by
  // default: the tracker is untouched and escalation never fires when disabled.
  let nextTracker = velocityTracker;
  let velocity: VelocityInfo = { slope: undefined, robustGrowth: false, epochsToCritical: undefined };
  let velocityEscalate = false;
  if (settings.enabled && soft.velocity?.enabled) {
    const observed = observeVelocity(velocityTracker, { epoch: latestProviderUsageEpoch(messages), tokens: initial });
    nextTracker = observed.tracker;
    velocity = buildVelocityInfo(observed, thresholdTokens - initial);
    velocityEscalate = shouldVelocityEscalate(velocity, soft, initialRatio);
  }

  if (!settings.enabled || (!initiallyCritical && !velocityEscalate && (!soft.enabled || initialRatio < soft.nudgeRatio))) {
    return pressureResult({ messages: transformed, band: "normal", estimatedTokens: initial, contextWindow, thresholdTokens, prunedToolResults, savedTokens, velocityTracker: nextTracker, velocity });
  }
  if (soft.enabled && !initiallyCritical && !velocityEscalate && initialRatio < soft.pruneRatio) {
    return pressureResult({ messages: transformed, band: "nudge", estimatedTokens: initial, contextWindow, thresholdTokens, prunedToolResults, savedTokens, velocityTracker: nextTracker, velocity });
  }

  // The soft layer gates only NEW pruning. Recorded prunes above stay applied so
  // the request prefix remains stable within the compaction epoch.
  let newlySavedTokens = 0;
  if (soft.enabled) {
    const frontierStart = protectedFrontierStart(transformed, settings.keepRecentTokens);
    const pruneTarget = Math.min(thresholdTokens, Math.floor(contextWindow * soft.pruneTargetRatio));
    const usageEpoch = latestProviderUsageEpoch(messages);
    // Graduated eviction, cheapest/most-reversible first: pass 1 strips replayable
    // tools (re-runnable); pass 2 strips bulk data tools (bash/edit/write) only if
    // pressure persists. Control tools (e.g. todo) are in neither set and survive.
    const replayable = runPrunePass({ transformed, pruneManifest, frontierStart, pruneTarget, effectiveTokens: initial, usageEpoch, selector: replaceableToolResult });
    newlySavedTokens += replayable.savedTokens;
    savedTokens += replayable.savedTokens;
    prunedToolResults += replayable.prunedToolResults;
    const bulk = runPrunePass({ transformed, pruneManifest, frontierStart, pruneTarget, effectiveTokens: replayable.effectiveTokens, usageEpoch, selector: evictableBulkToolResult });
    newlySavedTokens += bulk.savedTokens;
    savedTokens += bulk.savedTokens;
    prunedToolResults += bulk.prunedToolResults;
  }
  const estimatedTokens = Math.max(0, initial - newlySavedTokens);
  const ratio = estimatedTokens / contextWindow;
  const band = derivePressureBand({ ratio, criticalRatio, prunedToolResults, soft });
  return pressureResult({ messages: transformed, band, estimatedTokens, contextWindow, thresholdTokens, prunedToolResults, savedTokens, velocityTracker: nextTracker, velocity });
}

function applyRecordedPrunes(messages: AgentMessage[], pruneManifest: PruneManifest): AppliedPrunes {
  const transformed = [...messages];
  let savedTokens = 0;
  let prunedToolResults = 0;
  let pendingSavedTokens = 0;
  const usageEpoch = latestProviderUsageEpoch(messages);
  for (let index = 0; index < transformed.length; index++) {
    const callId = toolResultCallId(transformed[index]);
    if (!callId) continue;
    const recorded = getRecordedPrune(pruneManifest, callId);
    if (!recorded && !hasRecordedPrune(pruneManifest, callId)) continue;
    const replacement = recorded?.replacement ?? replaceableToolResult(transformed[index]);
    if (!replacement) continue;
    const saved = recorded?.savedTokens ?? estimateMessageTokens(transformed[index]) - estimateMessageTokens(replacement);
    if (saved <= 0) continue;
    transformed[index] = replacement;
    savedTokens += saved;
    prunedToolResults++;
    if (recorded?.introducedAtUsageEpoch === usageEpoch) pendingSavedTokens += saved;
  }
  return { messages: transformed, prunedToolResults, savedTokens, pendingSavedTokens };
}

function retainVisiblePrunes(pruneManifest: PruneManifest, messages: AgentMessage[]): void {
  if (pruneManifest.size === 0) return;
  const visible = new Set(messages.map(toolResultCallId).filter((id): id is string => Boolean(id)));
  for (const callId of pruneManifest.keys()) {
    if (!visible.has(callId)) pruneManifest.delete(callId);
  }
}

function hasRecordedPrune(manifest: PruneManifest, callId: string): boolean {
  return manifest.has(callId);
}

function getRecordedPrune(manifest: PruneManifest, callId: string): PruneManifestEntry | undefined {
  return manifest instanceof Map ? manifest.get(callId) : undefined;
}

function recordPrune(manifest: PruneManifest, callId: string, entry: PruneManifestEntry): void {
  if (manifest instanceof Map) manifest.set(callId, entry);
  else manifest.add(callId);
}

function hydrateRestoredPrunes(state: AutoCompactionState, messages: AgentMessage[]): void {
  if (state.restoredPruneIds.size === 0) return;
  const usageEpoch = latestProviderUsageEpoch(messages);
  const visibleIds = new Set<string>();
  for (const message of messages) {
    const callId = toolResultCallId(message);
    if (!callId || !state.restoredPruneIds.has(callId)) continue;
    visibleIds.add(callId);
    const replacement = replaceableToolResult(message);
    if (!replacement) continue;
    const savedTokens = estimateMessageTokens(message) - estimateMessageTokens(replacement);
    if (savedTokens <= 0) continue;
    state.pruneManifest.set(callId, { replacement, savedTokens, introducedAtUsageEpoch: usageEpoch });
  }
  state.restoredPruneIds = new Set([...state.restoredPruneIds].filter((id) => !visibleIds.has(id)));
}

function persistPruneManifest(pi: ExtensionAPI, state: AutoCompactionState): void {
  const toolCallIds = [...state.pruneManifest.keys()].sort();
  const nextKey = pruneKey(toolCallIds);
  if (nextKey === state.persistedPruneKey) return;
  state.persistedPruneKey = nextKey;
  pi.appendEntry?.(PRUNE_STATE_ENTRY_TYPE, {
    version: PRUNE_STATE_VERSION,
    sessionId: state.sessionId,
    toolCallIds,
  });
}

function loadPersistedPruneIds(ctx: ExtensionContext, sessionId: string | undefined): Set<string> {
  const manager = ctx.sessionManager as {
    getBranch?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
    getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
  } | undefined;
  const entries = manager?.getBranch?.() ?? manager?.getEntries?.() ?? [];
  const entry = entries.filter((candidate) => candidate.type === "custom" && candidate.customType === PRUNE_STATE_ENTRY_TYPE).pop();
  const data = entry?.data as { version?: unknown; sessionId?: unknown; toolCallIds?: unknown } | undefined;
  if (data?.version !== PRUNE_STATE_VERSION || (sessionId && data.sessionId !== sessionId) || !Array.isArray(data?.toolCallIds)) {
    return new Set();
  }
  return new Set(data.toolCallIds.filter((value): value is string => typeof value === "string"));
}

function sessionIdOf(ctx: ExtensionContext): string | undefined {
  const manager = ctx.sessionManager as { getSessionId?: () => string } | undefined;
  return manager?.getSessionId?.();
}

function pruneKey(toolCallIds: Iterable<string>): string {
  return [...toolCallIds].sort().join("\u0000");
}

export function shouldCompactMidTurn(input: {
  messages: AgentMessage[];
  contextWindow: number;
  settings: CompactionSettings;
  modelMaxTokens?: number;
}): boolean {
  if (!input.settings.enabled || input.contextWindow <= input.settings.reserveTokens) return false;
  if (!endsWithCompleteToolResultBatch(input.messages)) return false;
  const effectiveSettings = { ...input.settings, reserveTokens: effectiveReserveTokens(input.settings, input.contextWindow, input.modelMaxTokens) };
  return applyContextPressurePolicy(input.messages, input.contextWindow, effectiveSettings).band === "critical";
}

export function estimateContextTokens(messages: AgentMessage[]): ContextEstimate {
  let lastUsageIndex = -1;
  let usageTokens = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = assistantUsage(messages[index]);
    if (!usage) continue;
    lastUsageIndex = index;
    usageTokens = usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    break;
  }
  let trailingTokens = 0;
  for (let index = lastUsageIndex + 1; index < messages.length; index++) {
    trailingTokens += estimateMessageTokens(messages[index]);
  }
  return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens };
}

export function endsWithCompleteToolResultBatch(messages: AgentMessage[]): boolean {
  let endIndex = messages.length - 1;
  while (endIndex >= 0 && roleOf(messages[endIndex]) === "custom") endIndex--;
  if (roleOf(messages[endIndex]) !== "toolResult") return false;
  let assistantIndex = endIndex;
  while (assistantIndex >= 0 && roleOf(messages[assistantIndex]) === "toolResult") assistantIndex--;
  if (roleOf(messages[assistantIndex]) !== "assistant") return false;
  const callIds = assistantToolCallIds(messages[assistantIndex]);
  const resultIds = messages.slice(assistantIndex + 1, endIndex + 1).map(toolResultCallId);
  if (!callIds || callIds.length === 0 || resultIds.some((id) => !id)) return false;
  return callIds.length === resultIds.length
    && new Set(callIds).size === callIds.length
    && callIds.every((id) => resultIds.includes(id));
}

function assistantUsage(message: AgentMessage): { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number } | undefined {
  const record = message as MessageRecord;
  if (record.role !== "assistant" || record.stopReason === "aborted" || record.stopReason === "error") return undefined;
  if (!record.usage || typeof record.usage !== "object") return undefined;
  const usage = record.usage as Record<string, unknown>;
  const input = finiteNumber(usage.input);
  const output = finiteNumber(usage.output);
  const cacheRead = finiteNumber(usage.cacheRead);
  const cacheWrite = finiteNumber(usage.cacheWrite);
  if ([input, output, cacheRead, cacheWrite].some((value) => value === undefined)) return undefined;
  return {
    input: input!,
    output: output!,
    cacheRead: cacheRead!,
    cacheWrite: cacheWrite!,
    ...(finiteNumber(usage.totalTokens) !== undefined ? { totalTokens: finiteNumber(usage.totalTokens) } : {}),
  };
}

function latestProviderUsageEpoch(messages: AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = assistantUsage(messages[index]);
    if (!usage) continue;
    const record = messages[index] as MessageRecord & { timestamp?: unknown };
    return `${index}:${String(record.timestamp ?? "")}:${JSON.stringify(usage)}`;
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function estimateMessageTokens(message: AgentMessage): number {
  const serialized = JSON.stringify(message);
  return Math.ceil(serialized.length / tokenCharsPerToken(serialized));
}

function tokenCharsPerToken(serialized: string): number {
  if (serialized.includes("```")) return TOKEN_RATIO_CODE;
  let whitespace = 0;
  for (let index = 0; index < serialized.length; index++) {
    const ch = serialized[index];
    if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") whitespace++;
  }
  const whitespaceRatio = serialized.length > 0 ? whitespace / serialized.length : 0;
  if (whitespaceRatio > 0.3) return TOKEN_RATIO_WHITESPACE_HEAVY;
  return TOKEN_RATIO_DEFAULT;
}

function protectedFrontierStart(messages: AgentMessage[], keepRecentTokens: number): number {
  let tokens = 0;
  let start = messages.length;
  while (start > 0 && tokens < keepRecentTokens) {
    start--;
    tokens += estimateMessageTokens(messages[start]);
  }
  while (start > 0 && roleOf(messages[start]) === "toolResult") start--;
  return start;
}

interface PrunePassInput {
  transformed: AgentMessage[];
  pruneManifest: PruneManifest;
  frontierStart: number;
  pruneTarget: number;
  effectiveTokens: number;
  usageEpoch: string | undefined;
  selector: (message: AgentMessage) => AgentMessage | undefined;
}

function runPrunePass(input: PrunePassInput): { savedTokens: number; prunedToolResults: number; effectiveTokens: number } {
  const { transformed, pruneManifest, frontierStart, pruneTarget, usageEpoch, selector } = input;
  let effectiveTokens = input.effectiveTokens;
  let savedTokens = 0;
  let prunedToolResults = 0;
  for (let index = frontierStart - 1; index >= 0 && effectiveTokens > pruneTarget; index--) {
    const callId = toolResultCallId(transformed[index]);
    if (!callId || hasRecordedPrune(pruneManifest, callId)) continue;
    const replacement = selector(transformed[index]);
    if (!replacement) continue;
    const before = estimateMessageTokens(transformed[index]);
    const after = estimateMessageTokens(replacement);
    if (after >= before) continue;
    transformed[index] = replacement;
    const saved = before - after;
    recordPrune(pruneManifest, callId, { replacement, savedTokens: saved, introducedAtUsageEpoch: usageEpoch });
    savedTokens += saved;
    prunedToolResults++;
    effectiveTokens -= saved;
  }
  return { savedTokens, prunedToolResults, effectiveTokens };
}

function replaceableToolResult(message: AgentMessage): AgentMessage | undefined {
  const record = message as MessageRecord;
  if (record.role !== "toolResult" || record.isError === true) return undefined;
  if (typeof record.toolName !== "string" || !REPLAYABLE_TOOL_NAMES.has(record.toolName.toLowerCase())) return undefined;
  const serialized = JSON.stringify(record.content);
  if (serialized.length < MIN_PRUNABLE_TOOL_RESULT_CHARS) return undefined;
  const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
  return {
    ...message,
    content: [{
      type: "text",
      text: `[Maestro context pressure: stale large output from ${toolName} was pruned. Re-run the tool if the full payload is needed.]`,
    }],
  } as AgentMessage;
}

function evictableBulkToolResult(message: AgentMessage): AgentMessage | undefined {
  const record = message as MessageRecord;
  if (record.role !== "toolResult" || record.isError === true) return undefined;
  if (typeof record.toolName !== "string" || !EVICTABLE_BULK_TOOL_NAMES.has(record.toolName.toLowerCase())) return undefined;
  const serialized = JSON.stringify(record.content);
  if (serialized.length < MIN_PRUNABLE_TOOL_RESULT_CHARS) return undefined;
  const toolName = record.toolName;
  return {
    ...message,
    content: [{
      type: "text",
      text: `[Maestro context pressure: stale large output from ${toolName} was evicted to reclaim context. The original payload is no longer available; re-derive it from the affected files or commands if still needed.]`,
    }],
  } as AgentMessage;
}

const REDUNDANCY_PATTERN_PREFIX_CHARS = 120;

/**
 * Dedup key for a tool result: tool name plus a prefix of its text content.
 * Error results and content-less results have no key (never treated as redundant).
 */
export function toolResultPatternKey(message: AgentMessage): string | undefined {
  const record = message as MessageRecord;
  if (record.role !== "toolResult" || record.isError === true) return undefined;
  if (typeof record.toolName !== "string") return undefined;
  const content = record.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const blockText = (block as { text?: unknown } | null)?.text;
      if (typeof blockText === "string") text += blockText;
    }
  }
  if (text.length === 0) return undefined;
  return `${record.toolName}:${text.slice(0, REDUNDANCY_PATTERN_PREFIX_CHARS)}`;
}

/**
 * Call ids of stale duplicate tool results: for any content pattern that occurs
 * more than once, every occurrence except the newest is redundant. Prune ordering
 * stays latest-first for cache-prefix retention; this signal is used for telemetry
 * and future importance-aware eviction.
 */
export function redundantToolResultCallIds(messages: AgentMessage[]): Set<string> {
  const countByPattern = new Map<string, number>();
  const newestByPattern = new Map<string, string>();
  for (const message of messages) {
    const callId = toolResultCallId(message);
    if (!callId) continue;
    const key = toolResultPatternKey(message);
    if (!key) continue;
    countByPattern.set(key, (countByPattern.get(key) ?? 0) + 1);
    newestByPattern.set(key, callId);
  }
  const redundant = new Set<string>();
  for (const message of messages) {
    const callId = toolResultCallId(message);
    if (!callId) continue;
    const key = toolResultPatternKey(message);
    if (!key) continue;
    if ((countByPattern.get(key) ?? 0) > 1 && newestByPattern.get(key) !== callId) {
      redundant.add(callId);
    }
  }
  return redundant;
}

interface PressureResultInput {
  messages: AgentMessage[];
  band: ContextPressureBand;
  estimatedTokens: number;
  contextWindow: number;
  thresholdTokens: number;
  prunedToolResults: number;
  savedTokens: number;
  velocityTracker: VelocityTracker;
  velocity: VelocityInfo;
}

function pressureResult(input: PressureResultInput): ContextPressureResult {
  const { messages, band, estimatedTokens, contextWindow, thresholdTokens, prunedToolResults, savedTokens, velocityTracker, velocity } = input;
  // The common low-pressure path skips the telemetry scan entirely.
  const decision: ContextDecision = band === "normal"
    ? { band, action: "none", reasons: [] }
    : decideContextAction(band, computeContextSignals({ messages, estimatedTokens, contextWindow, thresholdTokens }));
  const reasons = [...decision.reasons];
  if (band !== "normal" && velocity.slope !== undefined) {
    const epochs = velocity.epochsToCritical !== undefined ? `,${velocity.epochsToCritical.toFixed(1)}ep` : "";
    reasons.push(`velocity:${Math.round(velocity.slope)}/ep${epochs}`);
  }
  return {
    messages,
    band,
    estimatedTokens,
    thresholdTokens,
    prunedToolResults,
    savedTokens,
    action: decision.action,
    reasons,
    velocityTracker,
    velocity,
  };
}

/** Final band derivation, extracted verbatim so it can be unit-tested in isolation. */
export function derivePressureBand(input: {
  ratio: number;
  criticalRatio: number;
  prunedToolResults: number;
  soft: SoftCompactionSettings;
}): ContextPressureBand {
  const { ratio, criticalRatio, prunedToolResults, soft } = input;
  if (ratio > criticalRatio) return "critical";
  if (prunedToolResults > 0) return "auto-prune";
  if (ratio >= soft.pruneRatio) return "auto-prune";
  if (ratio >= soft.nudgeRatio) return "nudge";
  return "normal";
}

export function computeContextSignals(input: {
  messages: AgentMessage[];
  estimatedTokens: number;
  contextWindow: number;
  thresholdTokens: number;
}): ContextSignals {
  const { messages, estimatedTokens, contextWindow, thresholdTokens } = input;
  const fullnessRatio = contextWindow > 0 ? estimatedTokens / contextWindow : 0;
  const criticalGap = thresholdTokens - estimatedTokens;
  let prunableTokens = 0;
  for (const message of messages) {
    if (!replaceableToolResult(message) && !evictableBulkToolResult(message)) continue;
    prunableTokens += estimateMessageTokens(message);
  }
  const prunableFraction = estimatedTokens > 0 ? Math.min(1, prunableTokens / estimatedTokens) : 0;
  const redundantIds = redundantToolResultCallIds(messages);
  let redundantTokens = 0;
  for (const message of messages) {
    const callId = toolResultCallId(message);
    if (!callId || !redundantIds.has(callId)) continue;
    redundantTokens += estimateMessageTokens(message);
  }
  const redundantFraction = estimatedTokens > 0 ? Math.min(1, redundantTokens / estimatedTokens) : 0;
  return { fullnessRatio, criticalGap, prunableFraction, redundantFraction, cacheHitRatio: latestCacheHitRatio(messages) };
}

/**
 * Maps a band to its action and telemetry reasons. Phase 2 velocity escalation
 * will live here; with velocity disabled this is a pure band→action projection.
 */
export function decideContextAction(band: ContextPressureBand, signals: ContextSignals): ContextDecision {
  const action: ContextAction = band === "critical" ? "compact" : band === "auto-prune" ? "prune" : "none";
  const reasons: string[] = [];
  if (signals.prunableFraction > 0) reasons.push(`prunable:${Math.round(signals.prunableFraction * 100)}%`);
  if (signals.redundantFraction && signals.redundantFraction > 0) reasons.push(`redundant:${Math.round(signals.redundantFraction * 100)}%`);
  if (signals.cacheHitRatio !== undefined) reasons.push(`cache:${Math.round(signals.cacheHitRatio * 100)}%`);
  return { band, action, reasons };
}

function latestCacheHitRatio(messages: AgentMessage[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = assistantUsage(messages[index]);
    if (!usage) continue;
    const denominator = usage.cacheRead + usage.input;
    return denominator > 0 ? usage.cacheRead / denominator : undefined;
  }
  return undefined;
}

export const MAX_CONSECUTIVE_COMPACTION_FAILURES = 3;
export const COMPACTION_BREAKER_COOLDOWN_TURNS = 5;

export interface CompactionBreakerState {
  consecutiveFailures: number;
  trippedAtTurn?: number;
}

export function resetCompactionBreaker(): CompactionBreakerState {
  return { consecutiveFailures: 0 };
}

/** Record a failed compaction; trip the breaker once failures reach the cap. */
export function recordCompactionFailure(
  breaker: CompactionBreakerState,
  turnCount: number,
): CompactionBreakerState {
  const consecutiveFailures = breaker.consecutiveFailures + 1;
  const trippedAtTurn = consecutiveFailures >= MAX_CONSECUTIVE_COMPACTION_FAILURES
    ? breaker.trippedAtTurn ?? turnCount
    : breaker.trippedAtTurn;
  return { consecutiveFailures, trippedAtTurn };
}

/**
 * Report whether a compaction attempt is allowed. While the breaker is open
 * (tripped within the cooldown window) attempts are skipped; once the cooldown
 * elapses the breaker resets and the next attempt proceeds.
 */
export function compactionBreakerAllows(
  breaker: CompactionBreakerState,
  turnCount: number,
): { allowed: boolean; breaker: CompactionBreakerState } {
  if (breaker.trippedAtTurn === undefined) return { allowed: true, breaker };
  if (turnCount - breaker.trippedAtTurn >= COMPACTION_BREAKER_COOLDOWN_TURNS) {
    return { allowed: true, breaker: resetCompactionBreaker() };
  }
  return { allowed: false, breaker };
}

const VELOCITY_SAMPLE_CAP = 4;
export const EMPTY_VELOCITY_TRACKER: VelocityTracker = { samples: [] };

/**
 * Append a per-epoch context-size sample (deduped by epoch, capped) and report
 * the resulting trend. Pure: returns a new tracker, never mutates the input.
 */
export function observeVelocity(
  tracker: VelocityTracker,
  observation: { epoch: string | undefined; tokens: number },
): { tracker: VelocityTracker; slope: number | undefined; robustGrowth: boolean } {
  const samples = tracker.samples;
  if (observation.epoch === undefined
    || (samples.length > 0 && samples[samples.length - 1].epoch === observation.epoch)) {
    return { tracker, slope: medianSlope(samples), robustGrowth: hasRobustGrowth(samples) };
  }
  const next = [...samples, { epoch: observation.epoch, tokens: observation.tokens }];
  while (next.length > VELOCITY_SAMPLE_CAP) next.shift();
  const updated = { samples: next };
  return { tracker: updated, slope: medianSlope(next), robustGrowth: hasRobustGrowth(next) };
}

export function buildVelocityInfo(
  observed: { slope: number | undefined; robustGrowth: boolean },
  criticalGap: number,
): VelocityInfo {
  const epochsToCritical = observed.slope !== undefined && observed.slope > 0
    ? Math.max(0, criticalGap) / observed.slope
    : undefined;
  return { slope: observed.slope, robustGrowth: observed.robustGrowth, epochsToCritical };
}

export function shouldVelocityEscalate(
  info: VelocityInfo,
  soft: SoftCompactionSettings,
  fullnessRatio: number,
): boolean {
  const velocity = soft.velocity;
  if (!velocity?.enabled) return false;
  if (fullnessRatio < velocity.minFullness) return false;
  if (!info.robustGrowth) return false;
  if (info.epochsToCritical === undefined) return false;
  return info.epochsToCritical <= velocity.epochsToCritical;
}

function medianSlope(samples: VelocitySample[]): number | undefined {
  if (samples.length < 3) return undefined;
  const diffs: number[] = [];
  for (let index = 1; index < samples.length; index++) {
    diffs.push(samples[index].tokens - samples[index - 1].tokens);
  }
  const sorted = [...diffs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function hasRobustGrowth(samples: VelocitySample[]): boolean {
  let consecutive = 0;
  for (let index = 1; index < samples.length; index++) {
    if (samples[index].tokens > samples[index - 1].tokens) {
      consecutive += 1;
      if (consecutive >= 2) return true;
    } else {
      consecutive = 0;
    }
  }
  return false;
}

function updatePressureStatus(ctx: ExtensionContext, pressure: ContextPressureResult): void {
  if (pressure.band === "normal") {
    clearPressureStatus(ctx);
    return;
  }
  const pruned = pressure.prunedToolResults > 0 ? ` -${pressure.prunedToolResults}` : "";
  const reasons = pressure.reasons.length > 0 ? ` ${pressure.reasons.join(" ")}` : "";
  ctx.ui.setStatus(
    COMPACTION_STATUS_KEY,
    `CTX ${pressure.band.toUpperCase()} ${pressure.estimatedTokens}/${pressure.thresholdTokens}${pruned}${reasons}`,
  );
}

function publishIdleStatus(ctx: ExtensionContext, enabled: boolean): void {
  ctx.ui.setStatus(COMPACTION_MODE_STATUS_KEY, autoCompactionIdleStatus(enabled));
}

function clearPressureStatus(ctx: ExtensionContext): void {
  ctx.ui.setStatus(COMPACTION_STATUS_KEY, undefined);
}

function roleOf(message: AgentMessage | undefined): string | undefined {
  return (message as MessageRecord | undefined)?.role as string | undefined;
}

function assistantToolCallIds(message: AgentMessage): string[] | undefined {
  const content = (message as MessageRecord).content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "toolCall") continue;
    const id = (block as { id?: unknown }).id;
    if (typeof id !== "string") return undefined;
    ids.push(id);
  }
  return ids;
}

function toolResultCallId(message: AgentMessage): string | undefined {
  const record = message as MessageRecord;
  return record.role === "toolResult" && typeof record.toolCallId === "string" ? record.toolCallId : undefined;
}

function finalAssistantStopReason(messages: AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const record = messages[index] as MessageRecord;
    if (record.role !== "assistant") continue;
    return typeof record.stopReason === "string" ? record.stopReason : undefined;
  }
  return undefined;
}

function buildOutputLimitInstructions(
  usage: { percent: number; tokens: number | null; contextWindow: number },
  reserveTokens: number,
): string {
  return [
    "This compaction was triggered because the previous assistant response was truncated at the model output token limit while context pressure was high.",
    "Preserve the exact current objective, completed work, modified files, and the interrupted response's intent so execution can resume and complete the truncated output immediately.",
    `Context usage: ${usage.tokens ?? "unknown"}/${usage.contextWindow} tokens (${Math.round(usage.percent)}%); reserve: ${reserveTokens}.`,
  ].join("\n");
}

function buildMidTurnInstructions(estimate: ContextEstimate, contextWindow: number, reserveTokens: number): string {
  return [
    "This compaction was triggered at a completed tool-result checkpoint inside an active agent turn.",
    "Preserve the exact current objective, completed tool results, pending tool work, modified files, and the next action so execution can resume immediately.",
    `Estimated context: ${estimate.tokens}/${contextWindow} tokens; reserve: ${reserveTokens}; trailing since last usage: ${estimate.trailingTokens}.`,
  ].join("\n");
}
