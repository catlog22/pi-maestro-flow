import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ContextUsage,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SOFT_COMPACTION,
  readEffectiveCompactionSettings,
  type EffectiveCompactionSettings,
  type SoftCompactionSettings,
} from "./compaction-settings.ts";
import {
  type CompactionArbiter,
  type CompactionLease,
  type CompactionOwner,
  type CompactionTrigger,
} from "./compaction-arbiter.ts";
import {
  deriveCompactionThreshold,
  deriveLinkedCompactionThreshold,
  effectiveReserveTokens,
  OUTPUT_CLAMP_BAND_MARGIN_RATIO,
  type CompactionThresholdDerivation,
  type LinkedCompactionThresholdModel,
} from "./compaction-threshold.ts";
import {
  autoCompactionIdleStatus,
  COMPACTION_MODE_STATUS_KEY,
  COMPACTION_STATUS_KEY,
  disableInvalidBudgetThinking,
  formatCompactionStatus,
  resolveConfiguredCompactionModel,
} from "./maestro-compaction.ts";
import { loadPiCompactionInternals, type PiCompactionInternals } from "./pi-internals.ts";
export { disableInvalidBudgetThinking } from "./maestro-compaction.ts";
import {
  SPILL_THRESHOLD_CHARS,
  SPILL_PREVIEW_CHARS,
  spillToolResult,
  spillPath as resolveSpillPath,
  generatePreview,
  buildSpillReplacementText,
  cleanupSpillDir,
  validateSpillPath,
} from "./tool-result-spill.ts";
import {
  compactLossless,
  type LosslessKind,
} from "./lossless.ts";
import { detectContentType } from "./content-detector.ts";
import { scoreRelevanceBatch, type RelevanceMode } from "./relevance.ts";
import { dedupBlocks, type DedupBlock } from "./dedup.ts";

const PROTECTED_THRESHOLD_CHARS = 500;
const REPLAYABLE_TOOL_NAMES = new Set(["read", "grep", "glob", "search", "find"]);
// Bulk data tools whose large non-error output is transient and safe to evict
// under sustained pressure. Control tools (e.g. todo) are deliberately absent so
// their state-bearing output is never pruned.
const EVICTABLE_BULK_TOOL_NAMES = new Set(["bash", "shell", "edit", "write"]);
const PROTECTED_TOOL_NAMES = new Set(["todo", "goal", "run-control", "ask-user-question", "plan-update", "plan-confirm"]);
// Content-aware chars-per-token ratios: a flat /4 miscounts the two content
// types that dominate coding sessions — fenced code is token-denser (~3.5) and
// whitespace-heavy logs/tables are token-sparser (~6). Ordinary content keeps the
// proven /4 default so low-pressure estimates stay stable.
const TOKEN_RATIO_CODE = 3.5;
const TOKEN_RATIO_WHITESPACE_HEAVY = 6;
const TOKEN_RATIO_DEFAULT = 4;
const RELEVANCE_DOCUMENT_SAMPLE_CHARS = 32_000;
const RELEVANCE_QUERY_SAMPLE_CHARS = 8_000;
const RELEVANCE_MAX_CANDIDATES = 64;
const RELEVANCE_TOTAL_SAMPLE_CHARS = 512_000;
/** Fixed token estimate per image content block, matching Pi's ESTIMATED_IMAGE_CHARS / 4. */
const ESTIMATED_IMAGE_TOKENS = 1200;
const CONTINUE_PROMPT = "Continue the interrupted task from the compacted session checkpoint. Do not wait for another user request.";
const COMPACTION_RETRY_PROMPT = "Automatic compaction failed after the request was stopped because the context was exhausted. Retry compaction, then continue the interrupted task. Do not restart or wait for another user request.";
const OUTPUT_LIMIT_RETRY_PROMPT = "Automatic compaction failed after the previous response was cut off at the model output token limit. Retry compaction, then continue exactly where the interrupted response stopped. Do not restart or wait for another user request.";
const OUTPUT_LIMIT_CONTINUE_PROMPT = "Your previous response was cut off at the model output token limit, and the context was just compacted to free room. Continue exactly from where the interrupted response stopped and complete it. Do not restart or wait for another user request.";
const DEFAULT_OUTPUT_LIMIT_RATIO = 0.8;
export const MAX_OUTPUT_LIMIT_COMPACTIONS = 2;
const PRUNE_STATE_ENTRY_TYPE = "maestro-auto-prune-state";
const PENDING_INTENT_ENTRY_TYPE = "maestro-auto-compaction-intent";
const PRUNE_STATE_VERSION = 6;
export const MAX_PRUNE_DELTAS_BETWEEN_CHECKPOINTS = 32;
export const MAX_OFF_BRANCH_PRUNE_ENTRIES = 128;
export const MAX_OFF_BRANCH_PRUNE_BYTES = 128 * 1024;

export type CompactionSettings = Pick<
  EffectiveCompactionSettings,
  "enabled" | "reserveTokens" | "keepRecentTokens" | "model"
> & { soft?: EffectiveCompactionSettings["soft"] };

export interface ContextEstimate {
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
  spillPath?: string;
  level?: PruneLevel;
  contentDigest?: string;
  writerId?: string;
  /** Session entry that made this replacement authoritative on its branch. */
  checkpointId?: string;
  /** For level "dedup": the referenced tool result that stays in context. */
  refCallId?: string;
}

export type PruneLevel = "pruned" | "spill" | "minimal" | "lossless" | "dedup";

interface PersistedPruneEntry {
  callId: string;
  level: PruneLevel;
  spillPath?: string;
  introducedAtUsageEpoch?: string;
  contentDigest?: string;
  writerId?: string;
  refCallId?: string;
  /** Session entry that made this replacement authoritative on its branch. */
  checkpointId?: string;
  /** Exact replacement text for context-dependent levels (dedup). */
  replacementText?: string;
}

/**
 * The prune manifest owns the derived replacement, its token saving, and the
 * usage epoch it was introduced at — that trio is what keeps the request prefix
 * byte-identical within a compaction epoch.
 *
 * This was once `Set<string> | Map<...>` for a legacy signature. The Set arm
 * could express none of the entry fields, so it silently degraded to
 * recomputing replacements and could never mark savings pending; no production
 * caller ever passed one. Narrowing it removes a path that looked equivalent
 * but quietly broke the cache-stability guarantee.
 */
export type PruneManifest = Map<string, PruneManifestEntry>;

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

/**
 * Pre-derived soft band boundaries in absolute tokens. When provided, the
 * policy uses these instead of recomputing ratios against the window, so the
 * output-budget-aware bands from the threshold model drive the runtime.
 */
export interface SoftPressureBands {
  nudgeTokens: number;
  pruneTokens: number;
  pruneTargetTokens: number;
}

interface PendingCompactionIntent {
  generation: number;
  triggerKey: string;
  estimate: ContextEstimate;
  linkedThreshold: LinkedCompactionThresholdModel & { usable: true };
  settings: CompactionSettings;
  effectiveSettings: CompactionSettings;
  contextExhausted: boolean;
}

interface PendingOutputLimitIntent {
  generation: number;
  settings: CompactionSettings;
  usage: ContextUsage;
  threshold: number;
}

export interface AutoCompactionState {
  running: boolean;
  generation: number;
  nextOwner: number;
  activeOwner?: number;
  /** Logical request owner, independent of whether an arbiter lease exists. */
  activeRequestOwner?: CompactionOwner;
  activeLease?: CompactionLease;
  pendingIntent?: PendingCompactionIntent;
  pendingOutputLimitIntent?: PendingOutputLimitIntent;
  lastTriggerKey?: string;
  internalsWarningShown: boolean;
  lastNoCompactableKey?: string;
  pruneManifest: Map<string, PruneManifestEntry>;
  restoredPrunes: Map<string, PersistedPruneEntry>;
  sessionId?: string;
  /** Per-guard writer namespace prevents one live owner deleting another's spill. */
  writerId: string;
  persistedPruneKey?: string;
  /** Materialized prune journal at the current branch checkpoint. */
  persistedPrunes: Map<string, PersistedPruneEntry>;
  forcePruneCheckpoint: boolean;
  pruneDeltasSinceCheckpoint: number;
  activeCheckpointId?: string;
  reachableCheckpoints: Map<string, number>;
  restoredPruneAges: Map<string, number>;
  restoredPruneSequence: number;
  persistedIntentKey?: string;
  settingsSnapshot?: CompactionSettings;
  settingsCwd?: string;
  velocityTracker: VelocityTracker;
  /** Held whole so the two fields can never be written back out of step. */
  breaker: CompactionBreakerState;
  breakerNotified: boolean;
  turnCount: number;
  /** Consecutive completed turns whose threshold intent was deferred instead of run. */
  highPressureDroppedTurns: number;
  /** Pressure notifications already emitted in the current compaction cycle. */
  notifiedPressureKeys: Set<string>;
  outputLimitCompactions: number;
  outputLimitBreakerNotified: boolean;
  /** Provider usage epoch the cache ratio below was sampled at. */
  cacheEpoch?: string;
  cacheRatio?: number;
  /** Epoch during which new prunes were introduced, pending its cache bill. */
  prunedDuringEpoch?: string;
  /** Cache-ratio movement attributed to the prunes of the previous epoch. */
  cacheDelta?: number;
}

interface AutoCompactionDependencies {
  loadInternals?: () => Promise<PiCompactionInternals>;
  readSettings?: (projectRoot: string) => CompactionSettings;
  arbiter?: CompactionArbiter;
}

export interface MessageRecord {
  role?: unknown;
  content?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
  usage?: unknown;
  stopReason?: unknown;
}

export interface ProjectedCompactionInput {
  event: SessionBeforeCompactEvent;
  estimatedInputTokens?: number;
  prunedToolResults: number;
}

export function commitProjectedCompactionInput(
  event: SessionBeforeCompactEvent,
  projected: ProjectedCompactionInput,
): void {
  event.preparation.messagesToSummarize = projected.event.preparation.messagesToSummarize;
  event.preparation.turnPrefixMessages = projected.event.preparation.turnPrefixMessages;
}

export function createMidTurnAutoCompaction(pi: ExtensionAPI, dependencies: AutoCompactionDependencies = {}): {
  onSessionStart(ctx: ExtensionContext, event?: { reason?: string }): void;
  evaluate(messages: AgentMessage[], ctx: ExtensionContext): Promise<AgentMessage[] | undefined>;
  projectCompactionInput(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<ProjectedCompactionInput>;
  beforeProviderRequest(payload: unknown, ctx: ExtensionContext): unknown | undefined;
  onAgentEnd(ctx: ExtensionContext): Promise<void>;
  onOutputLimit(messages: AgentMessage[], ctx: ExtensionContext): Promise<void>;
  onCompact(completedOwner?: CompactionOwner, ctx?: ExtensionContext): void;
  onSessionShutdown(ctx?: ExtensionContext): void;
  reset(ctx?: ExtensionContext): void;
  refreshSettings(): void;
} {
  const state: AutoCompactionState = {
    running: false,
    generation: 0,
    nextOwner: 0,
    internalsWarningShown: false,
    pruneManifest: new Map(),
    restoredPrunes: new Map(),
    persistedPrunes: new Map(),
    forcePruneCheckpoint: false,
    pruneDeltasSinceCheckpoint: 0,
    reachableCheckpoints: new Map(),
    restoredPruneAges: new Map(),
    restoredPruneSequence: 0,
    writerId: randomUUID(),
    velocityTracker: EMPTY_VELOCITY_TRACKER,
    breaker: resetCompactionBreaker(),
    breakerNotified: false,
    turnCount: 0,
    highPressureDroppedTurns: 0,
    notifiedPressureKeys: new Set(),
    outputLimitCompactions: 0,
    outputLimitBreakerNotified: false,
  };
  let transformTail = Promise.resolve();
  async function withTransformLock<T>(run: () => Promise<T>): Promise<T> {
    const previous = transformTail;
    let release!: () => void;
    transformTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  }
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
  function sameSettings(left: CompactionSettings, right: CompactionSettings): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  function notifyPressureOnce(ctx: ExtensionContext, key: string, message: string): void {
    if (state.notifiedPressureKeys.has(key)) return;
    state.notifiedPressureKeys.add(key);
    ctx.ui.notify(message, "warning");
  }
  async function linkedThresholdFor(
    ctx: ExtensionContext,
    settings: CompactionSettings,
  ): Promise<LinkedCompactionThresholdModel> {
    const sessionModel = ctx.model;
    if (!sessionModel) {
      return deriveLinkedCompactionThreshold({
        reserveTokens: settings.reserveTokens,
        sessionContextWindow: undefined,
        soft: settings.soft,
      });
    }
    const compactionModel = await resolveConfiguredCompactionModel(settings.model, sessionModel, ctx);
    return deriveLinkedCompactionThreshold({
      reserveTokens: settings.reserveTokens,
      sessionContextWindow: sessionModel.contextWindow,
      sessionMaxTokens: sessionModel.maxTokens,
      compactionContextWindow: compactionModel.contextWindow,
      compactionMaxTokens: compactionModel.maxTokens,
      enforceCompactionHeadroom: settings.model !== undefined,
      soft: settings.soft,
    });
  }
  /**
   * Every field a fresh lifecycle must start from. onSessionStart used to clear
   * only 13 of these and never touched the concurrency trio, so a session
   * switched in-process without a shutdown inherited `running: true` and
   * silently disabled compaction for the whole new session while stranding the
   * arbiter lease. Both entry points now clear the same set.
   */
  function releaseInFlight(): void {
    state.running = false;
    state.activeOwner = undefined;
    state.activeRequestOwner = undefined;
    state.activeLease?.release();
    state.activeLease = undefined;
    state.pendingIntent = undefined;
    state.pendingOutputLimitIntent = undefined;
    state.lastTriggerKey = undefined;
    state.lastNoCompactableKey = undefined;
    state.highPressureDroppedTurns = 0;
    state.notifiedPressureKeys.clear();
    state.internalsWarningShown = false;
  }
  function resetCycleState(): void {
    state.velocityTracker = EMPTY_VELOCITY_TRACKER;
    state.breaker = resetCompactionBreaker();
    state.breakerNotified = false;
    state.highPressureDroppedTurns = 0;
    state.notifiedPressureKeys.clear();
    state.outputLimitCompactions = 0;
    state.outputLimitBreakerNotified = false;
    state.cacheEpoch = undefined;
    state.cacheRatio = undefined;
    state.prunedDuringEpoch = undefined;
    state.cacheDelta = undefined;
  }
  /**
   * Phase 1 of a context hook: apply the stable prune transform and decide
   * whether pressure warrants a full compaction. Returns the messages to send.
   */
  async function evaluateInner(
    messages: AgentMessage[],
    ctx: ExtensionContext,
    generation: number,
  ): Promise<AgentMessage[] | undefined> {
    syncActivePruneBranch(state, ctx);
    const settings = settingsFor(ctx);
    return await runPressureCycle(messages, ctx, generation, settings);
  }
  /**
   * The whole pressure cycle for one context hook: stable transform, new
   * prunes, spill escalation, status, then the compaction trigger.
   */
  async function runPressureCycle(
    messages: AgentMessage[],
    ctx: ExtensionContext,
    generation: number,
    settings: CompactionSettings,
  ): Promise<AgentMessage[] | undefined> {
      publishIdleStatus(ctx, settings.enabled);
      if (!ctx.model) {
        clearPressureStatus(ctx);
        return undefined;
      }
      const linkedThreshold = await linkedThresholdFor(ctx, settings);
      if (generation !== state.generation) return undefined;
      if (!settings.enabled || !linkedThreshold.usable || linkedThreshold.contextWindow <= settings.reserveTokens) {
        if (state.sessionId) void cleanupSpillDir(state.sessionId, state.writerId);
        state.pruneManifest.clear();
        state.restoredPrunes.clear();
        persistPruneManifest(pi, state);
        clearPressureStatus(ctx);
        return undefined;
      }
      const capacityWindow = linkedThreshold.contextWindow;
      const downgraded = await hydrateRestoredPrunes(state, messages, generation);
      if (state.generation !== generation) return undefined;
      // A dead spill path was downgraded to the plain placeholder; persist the
      // downgrade now so a crash before the end-of-cycle persist cannot resume
      // into the old entry that advertised a nonexistent file.
      if (downgraded) persistPruneManifest(pi, state);
      retainVisiblePrunes(state, messages);
      // The first post-prune cache bill may arrive on a final assistant-text
      // response, which is not a complete tool-result batch. Advance attribution
      // before that gate so a later tool turn cannot be misattributed to the
      // original prune epoch.
      observeCacheAttribution(state, messages, 0);
      if (!endsWithCompleteToolResultBatch(messages)) {
        clearPressureStatus(ctx);
        const stable = applyRecordedPrunes(messages, state.pruneManifest);
        persistPruneManifest(pi, state);
        return stable.prunedToolResults > 0 ? stable.messages : undefined;
      }
      const effectiveSettings: CompactionSettings = {
        ...settings,
        reserveTokens: linkedThreshold.effectiveReserveTokens,
      };
      const softBands: SoftPressureBands | undefined = linkedThreshold.soft
        ? {
            nudgeTokens: linkedThreshold.soft.nudgeTokens,
            pruneTokens: linkedThreshold.soft.pruneTokens,
            pruneTargetTokens: linkedThreshold.soft.pruneTargetTokens,
          }
        : undefined;
      const recordedBeforePolicy = new Set(state.pruneManifest.keys());
      let pressure = applyContextPressurePolicy(
        messages,
        capacityWindow,
        effectiveSettings,
        state.pruneManifest,
        state.velocityTracker,
        false,
        softBands,
        linkedThreshold.thresholdTokens,
      );
      state.velocityTracker = pressure.velocityTracker;
      // One-shot early warning at the nudge band, which is display-only: tell the
      // user output headroom or automatic pruning is approaching.
      if (pressure.band === "nudge" && softBands && linkedThreshold.soft) {
        const percent = Math.round((pressure.estimatedTokens / capacityWindow) * 100);
        const headroomWarning = linkedThreshold.soft.outputConstrained
          ? " Full-size response headroom is nearly exhausted."
          : "";
        notifyPressureOnce(
          ctx,
          `nudge:${capacityWindow}:${softBands.nudgeTokens}:${softBands.pruneTokens}:${linkedThreshold.thresholdTokens}`,
          `Context is at ${percent}% (estimated ${pressure.estimatedTokens.toLocaleString("en-US")}/${capacityWindow.toLocaleString("en-US")} tokens).${headroomWarning} Automatic pruning starts at ${softBands.pruneTokens.toLocaleString("en-US")} tokens; hard compaction starts above ${linkedThreshold.thresholdTokens.toLocaleString("en-US")} tokens.`,
        );
      }
      // Only entries recorded by THIS policy pass may still be escalated to
      // spill. Entries recorded earlier (including a prior pass whose spill
      // write failed) already published their replacement to the provider
      // prefix; upgrading them later would mutate bytes the cache treats as
      // stable for the rest of the epoch.
      const newPruneCallIds = new Set<string>();
      for (const callId of state.pruneManifest.keys()) {
        if (!recordedBeforePolicy.has(callId)) newPruneCallIds.add(callId);
      }
      if (pressure.prunedToolResults > 0 && state.sessionId) {
        const upgraded = await upgradeNewPrunesWithSpill(messages, pressure.messages, state.pruneManifest, state.sessionId, newPruneCallIds, state.writerId);
        // reset()/onSessionStart may have run during that await, bumping the
        // generation and clearing the manifest. Writing our stale view back
        // would resurrect prunes for a session that no longer exists.
        if (state.generation !== generation) return undefined;
        pressure = adjustPressureAfterReplacementChange(
          pressure,
          upgraded.tokenDelta,
          capacityWindow,
          effectiveSettings,
          softBands,
        );
        if (pressure.band === "critical" && upgraded.callIds.size > 0) {
          const minimized = compactNewSpilledPrunes(pressure.messages, state.pruneManifest, upgraded.callIds);
          pressure = adjustPressureAfterReplacementChange(
            pressure,
            minimized.tokenDelta,
            capacityWindow,
            effectiveSettings,
            softBands,
          );
        }
      }
      observeCacheAttribution(state, messages, newPruneCallIds.size);
      const attributedCacheDelta = state.cacheDelta;
      updatePressureStatus(ctx, pressure, attributedCacheDelta);
      state.cacheDelta = undefined;
      persistPruneManifest(pi, state);
      if (pressure.action !== "compact") {
        state.lastNoCompactableKey = undefined;
        state.lastTriggerKey = undefined;
        state.highPressureDroppedTurns = 0;
        // Escalation: pruning ran (or found nothing) yet the estimate still sits
        // within 3% of the hard trigger. Queue the intent now instead of letting
        // the next request run against a clamped output budget — the prune band
        // is already pulled down to the truncation point when the output ceiling
        // binds, so reaching this window means pruning cannot relieve pressure.
        const escalate = pressure.action === "prune"
          && pressure.estimatedTokens >= pressure.thresholdTokens
            - Math.floor(capacityWindow * OUTPUT_CLAMP_BAND_MARGIN_RATIO);
        if (escalate) {
          const estimate = { ...estimateContextTokens(pressure.messages), tokens: pressure.estimatedTokens };
          const triggerKey = `${estimate.tokens}:${pressure.thresholdTokens}:${messages.length}`;
          if (state.pendingIntent?.triggerKey !== triggerKey) {
            const contextExhausted = estimate.tokens >= ctx.model.contextWindow;
            state.pendingIntent = {
              generation,
              triggerKey,
              estimate,
              linkedThreshold,
              settings,
              effectiveSettings,
              contextExhausted,
            };
            state.lastTriggerKey = triggerKey;
            persistPendingIntent(pi, state);
            if (contextExhausted) ctx.abort();
            // Dedup on the stable threshold, not the volatile triggerKey
            // (tokens + message count change every evaluation within a turn).
            notifyPressureOnce(
              ctx,
              `escalate:${pressure.thresholdTokens}`,
              `Context remains near the compaction threshold after pruning (${estimate.tokens.toLocaleString("en-US")}/${pressure.thresholdTokens.toLocaleString("en-US")} tokens). Compaction will run after this turn; responses may be truncated until then.`,
            );
          }
        } else {
          state.pendingIntent = undefined;
          persistPendingIntent(pi, state);
        }
        return pressure.prunedToolResults > 0 ? pressure.messages : undefined;
      }
      const estimate = { ...estimateContextTokens(pressure.messages), tokens: pressure.estimatedTokens };
      const thresholdTokens = pressure.thresholdTokens;

      const triggerKey = `${estimate.tokens}:${thresholdTokens}:${messages.length}`;
      if (state.pendingIntent?.triggerKey === triggerKey) return pressure.messages;

      // The context transform owns pruning only. Full compaction is submitted
      // after the agent settles, where it can re-read the branch and arbitrate
      // with Pi's native compaction without a context-hook TOCTOU race.
      const contextExhausted = estimate.tokens >= ctx.model.contextWindow;
      state.pendingIntent = {
        generation,
        triggerKey,
        estimate,
        linkedThreshold,
        settings,
        effectiveSettings,
        contextExhausted,
      };
      state.lastTriggerKey = triggerKey;
      persistPendingIntent(pi, state);
      if (contextExhausted) {
        // An actually overflowing request must never fall through to the
        // provider while waiting for the settled-phase compaction owner.
        ctx.abort();
      }
      return pressure.messages;
  }

  async function settlePendingCompaction(ctx: ExtensionContext): Promise<void> {
    const intent = state.pendingIntent;
    if (!intent || state.running || intent.generation !== state.generation) return;
    if (!sameSettings(settingsFor(ctx), intent.settings)) {
      state.pendingIntent = undefined;
      state.lastTriggerKey = undefined;
      persistPendingIntent(pi, state);
      return;
    }

    const clearPending = () => {
      if (state.pendingIntent === intent) state.pendingIntent = undefined;
      if (state.lastTriggerKey === intent.triggerKey) state.lastTriggerKey = undefined;
      persistPendingIntent(pi, state);
    };
    const notifyBreakerPaused = () => {
      if (state.breakerNotified) return;
      state.breakerNotified = true;
      ctx.ui.notify(
        `Mid-turn compaction paused after ${state.breaker.consecutiveFailures} consecutive failures; it can retry after ${COMPACTION_BREAKER_COOLDOWN_TURNS} subsequent turns.`,
        "warning",
      );
    };
    const breakerCheck = compactionBreakerAllows(state.breaker, state.turnCount);
    if (state.breaker.trippedAtTurn !== undefined && breakerCheck.breaker.trippedAtTurn === undefined) {
      state.breakerNotified = false;
    }
    state.breaker = breakerCheck.breaker;
    if (!breakerCheck.allowed) {
      notifyBreakerPaused();
      clearPending();
      return;
    }

    const recoverBeforeSubmission = (error: unknown, message: string) => {
      if (intent.generation !== state.generation) return;
      state.breaker = recordCompactionFailure(state.breaker, state.turnCount);
      clearPressureStatus(ctx);
      ctx.ui.notify(`${message}: ${error instanceof Error ? error.message : String(error)}`, "warning");
      clearPending();
      if (!intent.contextExhausted || state.breaker.trippedAtTurn !== undefined || ctx.hasPendingMessages?.()) return;
      try {
        pi.sendUserMessage(COMPACTION_RETRY_PROMPT, { deliverAs: "followUp" });
      } catch (recoveryError) {
        ctx.ui.notify(`Mid-turn compaction recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`, "error");
      }
    };

    let internals: PiCompactionInternals;
    try {
      internals = await loadInternals();
    } catch (error) {
      if (!state.internalsWarningShown) state.internalsWarningShown = true;
      recoverBeforeSubmission(error, "Mid-turn compaction disabled");
      return;
    }
    if (intent.generation !== state.generation || state.running) return;
    if (dependencies.arbiter?.currentOwner()) {
      clearPending();
      return;
    }

    const branch = ctx.sessionManager.getBranch();
    let preparation: unknown;
    try {
      preparation = internals.prepareCompaction(branch, intent.settings);
    } catch (error) {
      recoverBeforeSubmission(error, "Mid-turn compaction preparation failed");
      return;
    }
    if (!preparation) {
      ctx.ui.setStatus(
        COMPACTION_STATUS_KEY,
        `CTX CRITICAL ${intent.estimate.tokens}/${intent.linkedThreshold.thresholdTokens}`,
      );
      const noCompactableKey = `${intent.contextExhausted ? "exhausted" : "critical"}:${intent.linkedThreshold.thresholdTokens}:${intent.settings.keepRecentTokens}:${branch.length}`;
      if (state.lastNoCompactableKey !== noCompactableKey) {
        state.lastNoCompactableKey = noCompactableKey;
        if (intent.contextExhausted) {
          ctx.ui.notify(
            `Mid-turn request stopped: context is already ${intent.estimate.tokens}/${ctx.model?.contextWindow ?? intent.linkedThreshold.contextWindow} tokens and Pi has no compactable history. Start a new session or reduce static prompt/tool scope.`,
            "error",
          );
        } else {
          ctx.ui.notify(
            "Mid-turn compaction skipped: Pi has no compactable history; context pressure is inside the recent keep window or static prompt overhead.",
            "warning",
          );
        }
      }
      clearPending();
      return;
    }

    state.lastNoCompactableKey = undefined;
    const midTurnTrigger = buildMidTurnTrigger({
      estimatedTokens: intent.estimate.tokens,
      threshold: intent.linkedThreshold,
      configuredReserveTokens: intent.settings.reserveTokens,
    });
    const lease = dependencies.arbiter?.request("mid-turn", midTurnTrigger);
    if (dependencies.arbiter && !lease) {
      clearPending();
      return;
    }
    clearPending();
    state.running = true;
    state.activeRequestOwner = "mid-turn";
    state.activeLease = lease;
    const owner = ++state.nextOwner;
    state.activeOwner = owner;
    const failCompaction = (error: unknown) => {
      if (intent.generation !== state.generation || state.activeOwner !== owner) return;
      state.breaker = recordCompactionFailure(state.breaker, state.turnCount);
      state.running = false;
      state.activeOwner = undefined;
      state.activeRequestOwner = undefined;
      state.lastTriggerKey = undefined;
      state.activeLease?.release();
      state.activeLease = undefined;
      clearPressureStatus(ctx);
      ctx.ui.notify(`Mid-turn compaction failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      if (!intent.contextExhausted) return;
      if (state.breaker.trippedAtTurn !== undefined) {
        notifyBreakerPaused();
        return;
      }
      if (ctx.hasPendingMessages?.()) return;
      try {
        pi.sendUserMessage(COMPACTION_RETRY_PROMPT, { deliverAs: "followUp" });
      } catch (recoveryError) {
        ctx.ui.notify(
          `Mid-turn compaction recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
          "error",
        );
      }
    };
    try {
      ctx.ui.setStatus(COMPACTION_STATUS_KEY, formatCompactionStatus({
        owner: "mid-turn",
        trigger: midTurnTrigger,
        tokensBefore: intent.estimate.tokens,
        contextWindow: intent.linkedThreshold.contextWindow,
        configuredReserveTokens: intent.settings.reserveTokens,
      }));
      const instructions = buildMidTurnInstructions(
        intent.estimate,
        intent.linkedThreshold.contextWindow,
        intent.effectiveSettings.reserveTokens,
      );
      ctx.compact({
        customInstructions: state.activeLease?.tagInstructions(instructions) ?? instructions,
        onComplete: () => {
          if (state.activeOwner !== owner) return;
          state.breaker = resetCompactionBreaker();
          state.breakerNotified = false;
          state.running = false;
          state.activeOwner = undefined;
          state.activeRequestOwner = undefined;
          state.lastTriggerKey = undefined;
          state.activeLease?.release();
          state.activeLease = undefined;
          clearPressureStatus(ctx);
          if (!intent.contextExhausted || ctx.hasPendingMessages?.()) return;
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
  }

  async function settlePendingOutputLimit(ctx: ExtensionContext): Promise<boolean> {
    const intent = state.pendingOutputLimitIntent;
    if (!intent || state.running || intent.generation !== state.generation) return false;
    if (!sameSettings(settingsFor(ctx), intent.settings)) {
      state.pendingOutputLimitIntent = undefined;
      return false;
    }
    const clearPending = () => {
      if (state.pendingOutputLimitIntent === intent) state.pendingOutputLimitIntent = undefined;
    };

    let internals: PiCompactionInternals;
    try {
      internals = await loadInternals();
    } catch (error) {
      if (intent.generation !== state.generation) return false;
      clearPending();
      ctx.ui.notify(`Output-limit compaction disabled: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return false;
    }
    if (intent.generation !== state.generation || state.running) return false;

    let linkedThreshold: LinkedCompactionThresholdModel;
    try {
      linkedThreshold = await linkedThresholdFor(ctx, intent.settings);
    } catch (error) {
      if (intent.generation !== state.generation) return false;
      clearPending();
      ctx.ui.notify(`Output-limit compaction model resolution failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return false;
    }
    if (intent.generation !== state.generation || state.running) return false;
    if (dependencies.arbiter?.currentOwner()) return true;

    const branch = ctx.sessionManager.getBranch();
    let preparation: unknown;
    try {
      preparation = internals.prepareCompaction(branch, intent.settings);
    } catch (error) {
      clearPending();
      ctx.ui.notify(`Output-limit compaction preparation failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return false;
    }
    if (!preparation) {
      clearPending();
      ctx.ui.notify(
        "Output-limit compaction skipped: Pi has no compactable history; the response keeps hitting the output token limit inside the recent keep window.",
        "warning",
      );
      return false;
    }

    const instructionReserve = linkedThreshold.usable
      ? linkedThreshold.effectiveReserveTokens
      : effectiveReserveTokens(intent.settings, ctx.model?.contextWindow ?? intent.usage.contextWindow, ctx.model?.maxTokens);
    const outputLimitTrigger: CompactionTrigger = {
      owner: "output-limit",
      usageTokens: intent.usage.tokens,
      contextWindow: intent.usage.contextWindow,
      usagePercent: intent.usage.percent,
      gateRatio: intent.threshold,
    };
    const lease = dependencies.arbiter?.request("output-limit", outputLimitTrigger);
    if (dependencies.arbiter && !lease) return true;

    clearPending();
    state.outputLimitCompactions += 1;
    state.running = true;
    state.activeRequestOwner = "output-limit";
    state.activeLease = lease;
    const owner = ++state.nextOwner;
    state.activeOwner = owner;
    const instructions = buildOutputLimitInstructions(intent.usage, instructionReserve);
    const failOutputLimit = (error: unknown) => {
      if (state.activeOwner !== owner) return;
      state.running = false;
      state.activeOwner = undefined;
      state.activeRequestOwner = undefined;
      state.activeLease?.release();
      state.activeLease = undefined;
      ctx.ui.notify(`Output-limit compaction failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      if (state.outputLimitCompactions >= MAX_OUTPUT_LIMIT_COMPACTIONS || ctx.hasPendingMessages?.()) return;
      state.pendingOutputLimitIntent = intent;
      try {
        pi.sendUserMessage(OUTPUT_LIMIT_RETRY_PROMPT, { deliverAs: "followUp" });
      } catch (recoveryError) {
        state.pendingOutputLimitIntent = undefined;
        ctx.ui.notify(`Output-limit compaction recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`, "error");
      }
    };
    try {
      ctx.compact({
        customInstructions: lease?.tagInstructions(instructions) ?? instructions,
        onComplete: () => {
          if (state.activeOwner !== owner) return;
          state.running = false;
          state.activeOwner = undefined;
          state.activeRequestOwner = undefined;
          state.activeLease?.release();
          state.activeLease = undefined;
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
    return true;
  }

  return {
    onSessionStart(ctx, event) {
      state.generation += 1;
      const nextSessionId = sessionIdOf(ctx);
      // Session replacement normally creates a fresh guard. Alternate hosts may
      // reuse one, so a reversible switch must never destroy the parked owner.
      releaseInFlight();
      state.pruneManifest.clear();
      state.sessionId = nextSessionId;
      const loadedPrunes = loadPersistedPrunes(ctx, state.sessionId, event?.reason === "fork");
      state.restoredPrunes = loadedPrunes.prunes;
      state.restoredPruneAges.clear();
      state.persistedPrunes = new Map(loadedPrunes.byCallId);
      state.forcePruneCheckpoint = loadedPrunes.requiresCheckpoint;
      state.pruneDeltasSinceCheckpoint = loadedPrunes.deltasSinceCheckpoint;
      const branch = inspectPruneBranch(ctx);
      state.activeCheckpointId = branch.checkpointId;
      state.reachableCheckpoints = branch.reachable;
      touchRestoredPrunes(state, state.restoredPrunes.keys());
      evictOffBranchRestoredPrunes(state);
      state.pendingIntent = loadPersistedIntent(ctx, state.sessionId, state.generation);
      state.persistedIntentKey = pendingIntentKey(state.pendingIntent);
      state.persistedPruneKey = pruneKey(state.persistedPrunes.values());
      state.settingsSnapshot = undefined;
      state.settingsCwd = undefined;
      resetCycleState();
      state.turnCount = 0;
      publishIdleStatus(ctx, settingsFor(ctx).enabled);
    },
    async evaluate(messages, ctx) {
      const generation = state.generation;
      if (state.running) return undefined;
      return await withTransformLock(async () => {
        if (generation !== state.generation || state.running) return undefined;
        return await evaluateInner(messages, ctx, generation);
      });
    },
    async projectCompactionInput(event, ctx) {
      const generation = state.generation;
      return await withTransformLock(async () => {
        if (generation !== state.generation) return { event, prunedToolResults: 0 };
        syncActivePruneBranch(state, ctx);
        const summaryCount = event.preparation.messagesToSummarize.length;
        const messages = [
          ...event.preparation.messagesToSummarize,
          ...event.preparation.turnPrefixMessages,
        ];
        const settings = settingsFor(ctx);
        const linkedThreshold = await linkedThresholdFor(ctx, settings);
        if (generation !== state.generation) return { event, prunedToolResults: 0 };
        // A resumed session can reach compaction before its first context
        // evaluation; hydrate restored prunes so the projection replays the
        // persisted replacements instead of raw historical tool output.
        const downgraded = await hydrateRestoredPrunes(state, messages, generation);
        if (state.generation !== generation) return { event, prunedToolResults: 0 };
        if (downgraded) persistPruneManifest(pi, state);
        const contextWindow = linkedThreshold.usable
          ? linkedThreshold.contextWindow
          : ctx.model?.contextWindow
            ?? Math.max(1, event.preparation.tokensBefore + event.preparation.settings.reserveTokens);
        const softBands: SoftPressureBands | undefined = linkedThreshold.usable && linkedThreshold.soft
          ? {
              nudgeTokens: linkedThreshold.soft.nudgeTokens,
              pruneTokens: linkedThreshold.soft.pruneTokens,
              pruneTargetTokens: linkedThreshold.soft.pruneTargetTokens,
            }
          : undefined;
        const pressure = applyContextPressurePolicy(
          messages,
          contextWindow,
          linkedThreshold.usable
            ? { ...settings, reserveTokens: linkedThreshold.effectiveReserveTokens }
            : settings,
          state.pruneManifest,
          state.velocityTracker,
          true,
          softBands,
          linkedThreshold.usable ? linkedThreshold.thresholdTokens : undefined,
        );
        persistPruneManifest(pi, state);
        if (pressure.prunedToolResults === 0) {
          return { event, prunedToolResults: 0 };
        }
        return {
          event: {
            ...event,
            preparation: {
              ...event.preparation,
              messagesToSummarize: pressure.messages.slice(0, summaryCount),
              turnPrefixMessages: pressure.messages.slice(summaryCount),
            },
          },
          estimatedInputTokens: pressure.messages.reduce(
            (tokens, message) => tokens + estimateMessageTokens(message),
            0,
          ),
          prunedToolResults: pressure.prunedToolResults,
        };
      });
    },
    beforeProviderRequest(payload, ctx) {
      const guarded = disableInvalidBudgetThinking(payload);
      if (guarded === payload) return undefined;
      ctx.ui.notify(
        "Extended thinking was disabled for this request because context pressure left too little output room for a valid thinking budget.",
        "warning",
      );
      return guarded;
    },
    async onAgentEnd(ctx) {
      const generation = state.generation;
      const sessionId = sessionIdOf(ctx);
      const isCurrentLifecycle = () => generation === state.generation
        && (sessionId === undefined || state.sessionId === undefined || sessionId === state.sessionId);
      if (!isCurrentLifecycle()) return;
      state.turnCount += 1;
      const outputLimitPending = await settlePendingOutputLimit(ctx);
      if (!isCurrentLifecycle()) return;
      if (!state.running && !outputLimitPending) {
        const pending = state.pendingIntent;
        const needsContinuation = pending?.contextExhausted || Boolean(ctx.hasPendingMessages?.());
        if (pending && !needsContinuation) {
          // A settled, non-exhausted loop may have completed the user's task.
          // Preserve its transcript once; if the session keeps running above the
          // threshold, run the deferred compaction at the second completed turn
          // so proactive compaction still happens before the provider clamps
          // outputs into truncation. The intent is kept (not cleared) so a pure
          // Q&A turn that never runs the pressure policy can still settle it.
          state.highPressureDroppedTurns += 1;
          if (state.highPressureDroppedTurns >= 2) {
            state.highPressureDroppedTurns = 0;
            await settlePendingCompaction(ctx);
          } else {
            state.lastNoCompactableKey = undefined;
            notifyPressureOnce(
              ctx,
              `defer:${pending.linkedThreshold.thresholdTokens}`,
              `Context is above the compaction threshold (${pending.estimate.tokens.toLocaleString("en-US")}/${pending.linkedThreshold.thresholdTokens.toLocaleString("en-US")} tokens). Compaction will run after the next completed turn; responses may be truncated until then.`,
            );
          }
        } else {
          state.highPressureDroppedTurns = 0;
          await settlePendingCompaction(ctx);
        }
      }
      if (!isCurrentLifecycle()) return;
      if (!state.running && !state.pendingIntent && !state.pendingOutputLimitIntent) {
        state.settingsSnapshot = undefined;
        publishIdleStatus(ctx, settingsFor(ctx).enabled);
        if (!state.lastNoCompactableKey) clearPressureStatus(ctx);
      }
    },
    async onOutputLimit(messages, ctx) {
      const generation = state.generation;
      const settings = settingsFor(ctx);
      const finalStopReason = finalAssistantStopReason(messages);
      if (!settings.enabled || !ctx.model || finalStopReason !== "length") {
        state.pendingOutputLimitIntent = undefined;
        state.outputLimitCompactions = 0;
        state.outputLimitBreakerNotified = false;
        return;
      }
      const usage = ctx.getContextUsage?.();
      let linkedGate: LinkedCompactionThresholdModel;
      try {
        linkedGate = await linkedThresholdFor(ctx, settings);
      } catch (error) {
        if (generation !== state.generation) return;
        state.pendingOutputLimitIntent = undefined;
        ctx.ui.notify(
          `Output-limit compaction threshold resolution failed: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
        return;
      }
      if (generation !== state.generation) return;
      const gateTokens = linkedGate.usable
        ? linkedGate.soft?.pruneTokens
          ?? Math.floor(linkedGate.contextWindow * DEFAULT_OUTPUT_LIMIT_RATIO)
        : undefined;
      const usageTokens = usage?.tokens ?? (usage?.percent != null
        ? Math.floor((usage.percent / 100) * usage.contextWindow)
        : undefined);
      const threshold = linkedGate.usable && gateTokens !== undefined
        ? gateTokens / linkedGate.contextWindow
        : settings.soft?.pruneRatio ?? DEFAULT_OUTPUT_LIMIT_RATIO;
      if (!usage || usageTokens == null || (gateTokens !== undefined
        ? usageTokens < gateTokens
        : usage.percent == null || usage.percent / 100 < threshold)) {
        state.pendingOutputLimitIntent = undefined;
        return;
      }
      if (state.outputLimitCompactions >= MAX_OUTPUT_LIMIT_COMPACTIONS) {
        state.pendingOutputLimitIntent = undefined;
        if (!state.outputLimitBreakerNotified) {
          state.outputLimitBreakerNotified = true;
          ctx.ui.notify(
            `Output-limit compaction stopped after ${state.outputLimitCompactions} attempts; the response keeps hitting the model output token limit. Raise maxTokens or reduce per-response size.`,
            "warning",
          );
        }
        return;
      }
      if (ctx.hasPendingMessages?.()) {
        state.pendingOutputLimitIntent = undefined;
        return;
      }
      state.pendingOutputLimitIntent = {
        generation,
        settings,
        usage: { ...usage },
        threshold,
      };
    },
    onCompact(completedOwner, ctx) {
      const continueOutputLimit = state.pendingOutputLimitIntent !== undefined
        && completedOwner === "native"
        && !ctx?.hasPendingMessages?.();
      state.generation += 1;
      const activeRequestOwner = state.activeRequestOwner;
      const wasPreempted = activeRequestOwner !== undefined
        && completedOwner !== undefined
        && completedOwner !== activeRequestOwner;
      const preserveOutputLimitBreaker = !wasPreempted && activeRequestOwner === "output-limit";
      const outputLimitCompactions = state.outputLimitCompactions;
      const outputLimitBreakerNotified = state.outputLimitBreakerNotified;
      if (wasPreempted) releaseInFlight();
      if (state.sessionId) void cleanupSpillDir(state.sessionId, state.writerId);
      state.pruneManifest.clear();
      state.restoredPrunes.clear();
      state.restoredPruneAges.clear();
      state.persistedPrunes.clear();
      state.forcePruneCheckpoint = true;
      state.pruneDeltasSinceCheckpoint = 0;
      state.persistedPruneKey = undefined;
      state.pendingIntent = undefined;
      state.pendingOutputLimitIntent = undefined;
      state.lastTriggerKey = undefined;
      state.lastNoCompactableKey = undefined;
      resetCycleState();
      if (preserveOutputLimitBreaker) {
        state.outputLimitCompactions = outputLimitCompactions;
        state.outputLimitBreakerNotified = outputLimitBreakerNotified;
      }
      // Persist the cleared manifest so a session closed before the next
      // evaluate() does not reload stale prune entries from the pre-compaction
      // projectCompactionInput persist.  reset() already does this; onCompact
      // was the only clear-path that skipped it.
      persistPruneManifest(pi, state);
      persistPendingIntent(pi, state);
      if (continueOutputLimit) {
        try {
          pi.sendUserMessage(OUTPUT_LIMIT_CONTINUE_PROMPT, { deliverAs: "followUp" });
        } catch (error) {
          ctx?.ui.notify(`Output-limit continuation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      }
    },
    onSessionShutdown(ctx) {
      // Non-destructive: a normal shutdown must not tombstone the prune
      // manifest. Release in-flight work and persist the current state so a
      // resume replays the identical transformed prefix; session-scoped spill
      // resources stay on disk for the bounded resume lifetime. reset() and
      // onCompact() remain the paths that clear manifests and delete files.
      state.generation += 1;
      const parkedIntent = state.pendingIntent;
      releaseInFlight();
      state.pendingIntent = parkedIntent
        ? { ...parkedIntent, generation: state.generation }
        : undefined;
      persistPruneManifest(pi, state);
      persistPendingIntent(pi, state);
      if (ctx) clearPressureStatus(ctx);
    },
    reset(ctx) {
      state.generation += 1;
      releaseInFlight();
      if (state.sessionId) void cleanupSpillDir(state.sessionId, state.writerId);
      state.pruneManifest.clear();
      state.restoredPrunes.clear();
      state.restoredPruneAges.clear();
      state.persistedPrunes.clear();
      state.forcePruneCheckpoint = true;
      state.pruneDeltasSinceCheckpoint = 0;
      state.persistedPruneKey = undefined;
      state.settingsSnapshot = undefined;
      state.settingsCwd = undefined;
      resetCycleState();
      state.turnCount = 0;
      persistPruneManifest(pi, state);
      persistPendingIntent(pi, state);
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

// Threshold derivation lives in compaction-threshold.ts (pure, neutral). The
// runtime helpers are re-exported so existing consumers keep their imports.
export {
  MIN_RESERVE_RATIO, deriveCompactionThreshold, deriveLinkedCompactionThreshold,
  effectiveReserveTokens, summaryOutputTokenLimit,
} from "./compaction-threshold.ts";
export type {
  CompactionThresholdDerivation, CompactionThresholdInput, CompactionThresholdModel,
  CompactionThresholdReason, LinkedCompactionThresholdInput, LinkedCompactionThresholdModel,
  SoftThresholdDerivation, UnusableContextThreshold,
} from "./compaction-threshold.ts";

export function applyContextPressurePolicy(
  messages: AgentMessage[],
  contextWindow: number,
  settings: CompactionSettings,
  pruneManifest: PruneManifest = new Map(),
  velocityTracker: VelocityTracker = EMPTY_VELOCITY_TRACKER,
  compactionPending = false,
  softBands?: SoftPressureBands,
  /**
   * Derived trigger threshold (summary-reserve B1 and self-hosting B2 applied).
   * Undefined keeps the legacy `window - reserve` formula so direct callers and
   * older tests keep byte-identical behavior.
   */
  thresholdOverrideTokens?: number,
): ContextPressureResult {
  const thresholdTokens = thresholdOverrideTokens ?? (contextWindow - settings.reserveTokens);
  const applied = applyRecordedPrunes(messages, pruneManifest);
  // applyRecordedPrunes hands back the caller's array untouched when nothing is
  // recorded. New pruning writes elements in place, so it copies first (below)
  // — the input array is never mutated.
  let transformed = applied.messages;
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
  const nudgeTokens = softBands?.nudgeTokens ?? Math.ceil(contextWindow * soft.nudgeRatio);
  const pruneTokens = softBands?.pruneTokens ?? Math.ceil(contextWindow * soft.pruneRatio);

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

  if (!settings.enabled || (!compactionPending && !initiallyCritical && !velocityEscalate && (!soft.enabled || initial < nudgeTokens))) {
    return pressureResult({ messages: transformed, band: "normal", estimatedTokens: initial, contextWindow, thresholdTokens, prunedToolResults, savedTokens, velocityTracker: nextTracker, velocity });
  }
  if (!compactionPending && soft.enabled && !initiallyCritical && !velocityEscalate && initial < pruneTokens) {
    return pressureResult({ messages: transformed, band: "nudge", estimatedTokens: initial, contextWindow, thresholdTokens, prunedToolResults, savedTokens, velocityTracker: nextTracker, velocity });
  }

  // The soft layer gates only NEW pruning. Recorded prunes above stay applied so
  // the request prefix remains stable within the compaction epoch.
  // Invariant: .workflow/specs/architecture-constraints.md S-20260724-cbhh
  // (compaction prune invariants) and coding-conventions.md (same-epoch
  // identical-replacement rule). Three prior sessions paid for this guarantee —
  // see the prefix-stability tests before weakening it.
  let newlySavedTokens = 0;
  let cacheGateActive = false;
  if (soft.enabled) {
    if (transformed === messages) transformed = [...messages];
    const frontierStart = protectedFrontierStart(transformed, settings.keepRecentTokens);
    const pruneTarget = Math.min(thresholdTokens, softBands?.pruneTargetTokens ?? Math.floor(contextWindow * soft.pruneTargetRatio));
    const usageEpoch = latestProviderUsageEpoch(messages);
    const cacheHitRatioValue = latestCacheHitRatio(messages);
    // Time-based cache-cold detection: when the gap since the last main-loop
    // assistant message exceeds the threshold, the provider's prompt cache has
    // almost certainly expired and the whole prefix will be rewritten anyway —
    // pruning then costs nothing extra, so the cache gate is bypassed.
    const cacheCold = soft.timeBased?.enabled === true
      && isCacheColdByTime(messages, soft.timeBased.gapThresholdMinutes);
    // Cache gate: a prune kills the provider's cached prefix from its index to
    // the end, so below the critical band a prune run must reclaim enough tokens
    // to pay for the prefix it invalidates. Past critical, relieving pressure
    // dominates — a full compaction would invalidate everything anyway plus cost
    // an LLM call — so the gate is bypassed and every candidate is applied.
    cacheGateActive = soft.cache.enabled && !initiallyCritical && !compactionPending
      && !cacheCold
      && cacheHitRatioValue !== undefined;
    const suffixTokens = cacheGateActive ? suffixTokenSums(transformed) : undefined;
    // Dynamic savings gate: a hot cache (high hit ratio) makes every mutation
    // more expensive, so the minimum savings required to pay for an
    // invalidated prefix rises with the observed hit ratio; a cold cache
    // lowers it. The fixed 25% baseline is kept as the mid-point.
    const minPruneRatio = cacheGateActive && cacheHitRatioValue !== undefined
      ? dynamicPruneMinRatio(cacheHitRatioValue, soft.cache.minRatioRange)
      : CACHE_PRUNE_MIN_SAVINGS_RATIO;

    // Build the exact ungated transform plan first. When the gate is active the
    // plan runs on copies, then one cumulative economics decision is applied to
    // the real messages/manifest. This lets savings combine across lossless,
    // replayable, and bulk tiers without publishing a partial prefix first.
    const planningMessages = cacheGateActive ? [...transformed] : transformed;
    const planningManifest = cacheGateActive ? new Map(pruneManifest) : pruneManifest;
    const plannedCandidates: PruneCandidate[] = [];
    let planSavedTokens = 0;
    let planPrunedToolResults = 0;
    const relevanceQuery = soft.relevance?.enabled === true
      ? latestRelevanceQuery(messages)
      : "";
    const rankCandidates = relevanceQuery
      ? (candidates: PruneCandidate[]) => rankPruneCandidates(
        candidates,
        relevanceQuery,
        soft.relevance?.mode ?? "bm25",
      )
      : undefined;

    // Reference targets of recorded cross-turn dedup pointers must stay in
    // context (the pointer's original is recovered from them). Lossy passes
    // therefore skip them.
    const dedupProtected = new Set<string>();
    for (const entry of planningManifest.values()) {
      if (entry.level === "dedup" && entry.refCallId) dedupProtected.add(entry.refCallId);
    }

    // Tier 0 — lossless folding first (reversible, no information loss): it
    // shrinks output without a decision, and whatever it saves lowers the
    // pressure so later lossy passes may not even need to run.
    let effectiveForLossy = initial;
    if (soft.lossless?.enabled ?? true) {
      const lossless = runPrunePass({
        transformed: planningMessages,
        pruneManifest: planningManifest,
        frontierStart,
        pruneTarget,
        effectiveTokens: initial,
        usageEpoch,
        selector: tryLosslessFold,
        rankCandidates,
        level: "lossless",
      });
      plannedCandidates.push(...lossless.candidates);
      planSavedTokens += lossless.savedTokens;
      planPrunedToolResults += lossless.prunedToolResults;
      effectiveForLossy = lossless.effectiveTokens;
    }
    // Tier 0.5 — cross-turn verbatim de-duplication (default off). Replaces
    // later spans that already appeared verbatim in an earlier tool output
    // with an in-context pointer; reference targets are protected above.
    if (soft.crossTurnDedup?.enabled === true) {
      const dedup = runDedupPass({
        transformed: planningMessages,
        pruneManifest: planningManifest,
        frontierStart,
        effectiveTokens: effectiveForLossy,
        minLines: soft.crossTurnDedup.minLines,
        minChars: soft.crossTurnDedup.minChars,
        dedupProtected,
      });
      plannedCandidates.push(...dedup.candidates);
      planSavedTokens += dedup.savedTokens;
      planPrunedToolResults += dedup.prunedToolResults;
      effectiveForLossy = dedup.effectiveTokens;
    }
    // Graduated eviction, cheapest/most-reversible first: pass 1 strips replayable
    // tools (re-runnable); pass 2 strips bulk data tools (bash/edit/write) only if
    // pressure persists. Control tools (e.g. todo) are in neither set and survive.
    const replayable = runPrunePass({
      transformed: planningMessages,
      pruneManifest: planningManifest,
      frontierStart,
      pruneTarget,
      effectiveTokens: effectiveForLossy,
      usageEpoch,
      selector: replaceableToolResult,
      rankCandidates,
      protectedCallIds: dedupProtected,
    });
    plannedCandidates.push(...replayable.candidates);
    planSavedTokens += replayable.savedTokens;
    planPrunedToolResults += replayable.prunedToolResults;
    const bulk = runPrunePass({
      transformed: planningMessages,
      pruneManifest: planningManifest,
      frontierStart,
      pruneTarget,
      effectiveTokens: replayable.effectiveTokens,
      usageEpoch,
      selector: evictableBulkToolResult,
      rankCandidates,
      protectedCallIds: dedupProtected,
    });
    plannedCandidates.push(...bulk.candidates);
    planSavedTokens += bulk.savedTokens;
    planPrunedToolResults += bulk.prunedToolResults;

    if (cacheGateActive && suffixTokens) {
      const depth = cacheWorthwhileDepth(plannedCandidates, suffixTokens, minPruneRatio);
      const appliedPlan = applyPruneCandidates(
        transformed,
        pruneManifest,
        plannedCandidates,
        depth,
        initial,
        usageEpoch,
      );
      newlySavedTokens += appliedPlan.savedTokens;
      savedTokens += appliedPlan.savedTokens;
      prunedToolResults += appliedPlan.prunedToolResults;
    } else {
      newlySavedTokens += planSavedTokens;
      savedTokens += planSavedTokens;
      prunedToolResults += planPrunedToolResults;
    }
  }
  const estimatedTokens = Math.max(0, initial - newlySavedTokens);
  const ratio = estimatedTokens / contextWindow;
  const band = derivePressureBand({
    ratio,
    criticalRatio,
    prunedToolResults,
    soft,
    softBands: softBands !== undefined
      ? { nudgeRatio: nudgeTokens / contextWindow, pruneRatio: pruneTokens / contextWindow }
      : undefined,
  });
  const result = pressureResult({ messages: transformed, band, estimatedTokens, contextWindow, thresholdTokens, prunedToolResults, savedTokens, velocityTracker: nextTracker, velocity });
  if (cacheGateActive && newlySavedTokens === 0 && !initiallyCritical) {
    return { ...result, action: "none", reasons: [...result.reasons, "cache-veto"] };
  }
  return result;
}

function applyRecordedPrunes(messages: AgentMessage[], pruneManifest: PruneManifest): AppliedPrunes {
  // Nothing recorded means nothing to replace; the copy would be identical and
  // the caller discards it. This is the common path early in a session and
  // immediately after every compaction or reset.
  if (pruneManifest.size === 0) {
    return { messages, prunedToolResults: 0, savedTokens: 0, pendingSavedTokens: 0 };
  }
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
    if (recorded?.contentDigest && recorded.contentDigest !== toolResultDigest(transformed[index])) continue;
    const replacement = recorded?.replacement ?? pruneToolResult(transformed[index]);
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

/** Durable projection of a live manifest entry, shared by persist and parking. */
function persistedEntryOf(callId: string, entry: PruneManifestEntry | undefined): PersistedPruneEntry {
  return {
    callId,
    level: entry?.level ?? (entry?.spillPath !== undefined ? "spill" : "pruned"),
    ...(entry?.spillPath !== undefined ? { spillPath: entry.spillPath } : {}),
    ...(entry?.introducedAtUsageEpoch !== undefined ? { introducedAtUsageEpoch: entry.introducedAtUsageEpoch } : {}),
    ...(entry?.contentDigest !== undefined ? { contentDigest: entry.contentDigest } : {}),
    ...(entry?.writerId !== undefined ? { writerId: entry.writerId } : {}),
    ...(entry?.checkpointId !== undefined ? { checkpointId: entry.checkpointId } : {}),
    ...(entry?.refCallId !== undefined ? { refCallId: entry.refCallId } : {}),
    ...(entry?.level === "dedup" && entry.replacement !== undefined
      ? { replacementText: extractTextContent(entry.replacement) }
      : {}),
  };
}

/**
 * Drop manifest entries whose tool result is not in the current window, parking
 * their identity in `parked` so the prune survives.
 *
 * A tool result can be invisible for one frame and come back — a branch switch,
 * a rewind/fork, a resume that evaluates a partial window. Deleting outright
 * made that permanent: the persisted fallback has already been consumed by
 * hydrateRestoredPrunes, so applyRecordedPrunes finds nothing and re-emits the
 * ORIGINAL full text. That both blows the context back up and invalidates the
 * whole cached prefix at that index.
 */
function retainVisiblePrunes(
  state: AutoCompactionState,
  messages: AgentMessage[],
): void {
  if (state.pruneManifest.size === 0) return;
  const visible = new Set<string>();
  for (const message of messages) {
    const callId = toolResultCallId(message);
    if (callId) visible.add(callId);
  }
  for (const callId of state.pruneManifest.keys()) {
    if (visible.has(callId)) continue;
    const entry = getRecordedPrune(state.pruneManifest, callId);
    if (entry && !entry.checkpointId) entry.checkpointId = state.activeCheckpointId;
    parkRestoredPrune(state, persistedEntryOf(callId, entry));
    state.pruneManifest.delete(callId);
  }
  evictOffBranchRestoredPrunes(state);
}

function hasRecordedPrune(manifest: PruneManifest, callId: string): boolean {
  return manifest.has(callId);
}

function getRecordedPrune(manifest: PruneManifest, callId: string): PruneManifestEntry | undefined {
  return manifest.get(callId);
}

function isPruneLevel(value: unknown): value is PruneLevel {
  return value === "pruned" || value === "spill" || value === "minimal" || value === "lossless" || value === "dedup";
}

/**
 * Record a NEW prune. Re-recording an existing callId is refused: the stored
 * replacement is what applyRecordedPrunes re-applies on every request, so
 * overwriting it with a freshly computed one would change the request prefix
 * each turn and thrash the prompt cache — with every existing test still green.
 * The two legitimate in-place escalations (spill, minimal) mutate the entry
 * they already own rather than going through here.
 */
function recordPrune(manifest: PruneManifest, callId: string, entry: PruneManifestEntry): void {
  if (manifest.has(callId)) return;
  manifest.set(callId, entry);
}

function restorePruneReplacement(message: AgentMessage, persisted: PersistedPruneEntry): AgentMessage | undefined {
  if (persisted.level === "pruned") return pruneToolResult(message);
  if (persisted.level === "dedup") {
    // The frozen pointer text is persisted alongside the entry so a resumed
    // request replays byte-identical bytes. Only when it is missing (an older
    // build) do we degrade: the referenced original is still in context, so
    // the plain placeholder loses no information, only brevity.
    if (persisted.replacementText) {
      return { ...message, content: [{ type: "text", text: persisted.replacementText }] } as AgentMessage;
    }
    return pruneToolResult(message);
  }
  if (persisted.level === "lossless") {
    // Folding is a deterministic pure function of the content: recompute is
    // recovery. If the message changed (digest mismatch is checked upstream)
    // or folding no longer gains, fall back to the ordinary prune path.
    return tryLosslessFold(message) ?? pruneToolResult(message);
  }
  if (persisted.level === "minimal") {
    if (!persisted.spillPath) return undefined;
    return minimalSpillReplacement(message, persisted.spillPath);
  }
  // hydrateRestoredPrunes validates spill liveness and downgrades dead paths
  // to level "pruned" before reaching here, so a persisted spill entry with no
  // path (cleaned tmpdir, failed write persisted by an older build) degrades
  // to the plain placeholder rather than the pathless spill text, which would
  // carry a 1.5K preview for no recoverability.
  if (!persisted.spillPath) return pruneToolResult(message);
  const text = extractTextContent(message);
  if (text.length < SPILL_THRESHOLD_CHARS) return undefined;
  const toolName = typeof (message as MessageRecord).toolName === "string"
    ? (message as MessageRecord).toolName as string
    : "tool";
  const preview = generatePreview(text, SPILL_PREVIEW_CHARS);
  return {
    ...message,
    content: [{
      type: "text",
      text: buildSpillReplacementText({
        ok: true,
        path: persisted.spillPath,
        preview: preview.preview,
        originalChars: text.length,
        hasMore: preview.hasMore,
      }, toolName),
    }],
  } as AgentMessage;
}

async function hydrateRestoredPrunes(
  state: AutoCompactionState,
  messages: AgentMessage[],
  generation: number,
): Promise<boolean> {
  if (state.restoredPrunes.size === 0) return false;
  const visible: Array<{ key: string; callId: string; message: AgentMessage; persisted: PersistedPruneEntry }> = [];
  for (const message of messages) {
    const callId = toolResultCallId(message);
    if (!callId || state.pruneManifest.has(callId)) continue;
    const found = findRestoredPrune(state, callId, message);
    if (!found) continue;
    const { key, persisted } = found;
    if (persisted.contentDigest && persisted.contentDigest !== toolResultDigest(message)) {
      state.restoredPrunes.delete(key);
      state.restoredPruneAges.delete(key);
      continue;
    }
    visible.push({ key, callId, message, persisted });
  }
  if (visible.length === 0) return false;
  // Validate every referenced spill path before publishing a restored
  // replacement. An entry whose resource is dead or foreign is atomically
  // downgraded to a plain prune, so the resumed prefix only advertises files
  // that exist and never toggles between dead-path and recovered-path text
  // within an epoch.
  const resolved: Array<{ key: string; callId: string; message: AgentMessage; persisted: PersistedPruneEntry; downgraded?: boolean }> =
    await Promise.all(visible.map(async (item) => {
      if (!item.persisted.spillPath) return item;
      const live = state.sessionId !== undefined
        && await validateSpillPath(state.sessionId, item.persisted.spillPath, item.persisted.writerId);
      if (live) return item;
      return {
        ...item,
        persisted: {
          callId: item.persisted.callId,
          level: "pruned" as PruneLevel,
          ...(item.persisted.introducedAtUsageEpoch !== undefined
            ? { introducedAtUsageEpoch: item.persisted.introducedAtUsageEpoch }
            : {}),
          ...(item.persisted.checkpointId !== undefined ? { checkpointId: item.persisted.checkpointId } : {}),
          ...(item.persisted.contentDigest !== undefined ? { contentDigest: item.persisted.contentDigest } : {}),
        },
        downgraded: true,
      };
    }));
  // reset()/onSessionStart may have run during validation, bumping the
  // generation. Publishing the stale view would resurrect prunes the new
  // lifecycle deliberately cleared.
  if (state.generation !== generation) return false;
  let downgraded = false;
  for (const item of resolved) {
    if (item.downgraded) {
      downgraded = true;
      // Persist the downgrade, not just the in-memory entry: the caller
      // writes this state so the next resume also sees the plain level.
      state.restoredPrunes.set(restoredPruneKey(item.persisted), item.persisted);
    }
    const replacement = restorePruneReplacement(item.message, item.persisted);
    if (!replacement) continue;
    const savedTokens = estimateMessageTokens(item.message) - estimateMessageTokens(replacement);
    if (savedTokens <= 0) continue;
    state.pruneManifest.set(item.callId, {
      replacement,
      savedTokens,
      introducedAtUsageEpoch: item.persisted.introducedAtUsageEpoch,
      spillPath: item.persisted.spillPath,
      contentDigest: item.persisted.contentDigest,
      writerId: item.persisted.writerId,
      level: item.persisted.level,
      checkpointId: item.persisted.checkpointId,
      refCallId: item.persisted.refCallId,
    });
  }
  for (const item of resolved) {
    state.restoredPrunes.delete(item.key);
    state.restoredPruneAges.delete(item.key);
  }
  return downgraded;
}

/**
 * Periodic full checkpoints bound branch reconstruction to a short delta
 * suffix. The host journal is append-only, so this does not remove historical
 * entries or claim a bound on physical session bytes.
 */
function persistPruneManifest(pi: ExtensionAPI, state: AutoCompactionState): void {
  const byCallId = new Map<string, PersistedPruneEntry>();
  for (const entry of state.restoredPrunes.values()) {
    if (!isCheckpointReachable(state, entry.checkpointId)) continue;
    setPreferredPrune(byCallId, entry, state.reachableCheckpoints);
  }
  for (const [callId, entry] of state.pruneManifest.entries()) {
    if (!entry.checkpointId) entry.checkpointId = state.activeCheckpointId;
    byCallId.set(callId, persistedEntryOf(callId, entry));
  }
  const prunes = [...byCallId.values()].sort(comparePersistedPrunes);
  const upserts = prunes.filter((entry) => {
    const previous = state.persistedPrunes.get(entry.callId);
    return !previous || pruneKey([previous]) !== pruneKey([entry]);
  });
  const removals = [...state.persistedPrunes.keys()]
    .filter((callId) => !byCallId.has(callId))
    .sort((a, b) => a.localeCompare(b));
  const checkpoint = state.forcePruneCheckpoint
    || (state.persistedPrunes.size === 0 && upserts.length > 0)
    || state.pruneDeltasSinceCheckpoint >= MAX_PRUNE_DELTAS_BETWEEN_CHECKPOINTS;
  if (!checkpoint && upserts.length === 0 && removals.length === 0) return;
  if (!pi.appendEntry) return;
  try {
    pi.appendEntry(PRUNE_STATE_ENTRY_TYPE, {
      version: PRUNE_STATE_VERSION,
      sessionId: state.sessionId,
      checkpointId: state.activeCheckpointId,
      mode: checkpoint ? "checkpoint" : "delta",
      ...(checkpoint
        ? { prunes: prunes.map(serializePersistedPrune) }
        : { upserts: upserts.map(serializePersistedPrune), removals }),
    });
  } catch {
    return;
  }
  state.persistedPrunes = byCallId;
  state.persistedPruneKey = pruneKey(prunes);
  state.forcePruneCheckpoint = false;
  state.pruneDeltasSinceCheckpoint = checkpoint ? 0 : state.pruneDeltasSinceCheckpoint + 1;
}

function pendingIntentKey(intent: PendingCompactionIntent | undefined): string {
  if (!intent) return "null";
  return JSON.stringify({
    triggerKey: intent.triggerKey,
    estimate: intent.estimate,
    linkedThreshold: intent.linkedThreshold,
    settings: intent.settings,
    effectiveSettings: intent.effectiveSettings,
    contextExhausted: intent.contextExhausted,
  });
}

function persistPendingIntent(pi: ExtensionAPI, state: AutoCompactionState): void {
  const key = pendingIntentKey(state.pendingIntent);
  if (key === state.persistedIntentKey || !pi.appendEntry) return;
  pi.appendEntry(PENDING_INTENT_ENTRY_TYPE, {
    version: 1,
    sessionId: state.sessionId,
    pending: state.pendingIntent ? JSON.parse(key) : null,
  });
  state.persistedIntentKey = key;
}

function loadPersistedIntent(
  ctx: ExtensionContext,
  sessionId: string | undefined,
  generation: number,
): PendingCompactionIntent | undefined {
  const manager = ctx.sessionManager as {
    getBranch?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
    getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
  } | undefined;
  const entries = manager?.getBranch?.() ?? manager?.getEntries?.() ?? [];
  const entry = entries.filter((candidate) => candidate.type === "custom"
    && candidate.customType === PENDING_INTENT_ENTRY_TYPE).pop();
  const data = entry?.data as { version?: unknown; sessionId?: unknown; pending?: unknown } | undefined;
  if (!data || data.version !== 1 || data.sessionId !== sessionId || !data.pending || typeof data.pending !== "object") {
    return undefined;
  }
  const pending = data.pending as Omit<PendingCompactionIntent, "generation">;
  if (typeof pending.triggerKey !== "string" || !pending.estimate || !pending.linkedThreshold
    || !pending.settings || !pending.effectiveSettings) return undefined;
  return { ...pending, generation };
}

interface LoadedPersistedPrunes {
  prunes: Map<string, PersistedPruneEntry>;
  byCallId: Map<string, PersistedPruneEntry>;
  requiresCheckpoint: boolean;
  deltasSinceCheckpoint: number;
}

interface PruneBranchEntry {
  type?: string;
  id?: string;
  customType?: string;
  data?: unknown;
}

function loadPersistedPrunes(
  ctx: ExtensionContext,
  sessionId: string | undefined,
  allowInheritedSession = false,
): LoadedPersistedPrunes {
  const manager = ctx.sessionManager as {
    getBranch?: () => PruneBranchEntry[];
    getEntries?: () => PruneBranchEntry[];
  } | undefined;
  const entries = manager?.getBranch?.() ?? manager?.getEntries?.() ?? [];
  const suffix: Array<{
    entry: PruneBranchEntry;
    data: Record<string, unknown>;
    sameSession: boolean;
  }> = [];
  let foundCheckpoint = false;

  // Checkpoints are emitted at a fixed cadence, so a reverse collection reads
  // only the latest full state and its bounded delta suffix. Reusing the
  // collected data below also avoids touching the same journal payload twice.
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== PRUNE_STATE_ENTRY_TYPE) continue;
    const data = entry.data as Record<string, unknown> | undefined;
    if (!data) continue;
    const sameSession = sessionId === undefined || data.sessionId === sessionId;
    if (!sameSession && !allowInheritedSession) continue;
    const version = typeof data.version === "number" ? data.version : 0;
    const checkpoint = (version === PRUNE_STATE_VERSION
        && data.mode === "checkpoint"
        && Array.isArray(data.prunes))
      || (version >= 3 && version <= 5 && Array.isArray(data.prunes))
      || ((version === 1 || version === 2) && Array.isArray(data.toolCallIds));
    const delta = version === PRUNE_STATE_VERSION
      && data.mode === "delta"
      && Array.isArray(data.upserts)
      && Array.isArray(data.removals);
    if (!checkpoint && !delta) continue;
    suffix.push({ entry, data, sameSession });
    if (checkpoint) {
      foundCheckpoint = true;
      break;
    }
  }

  const byCallId = new Map<string, PersistedPruneEntry>();
  let applied = false;
  let hasCurrentSessionEntry = false;
  let requiresCheckpoint = false;
  let deltasSinceCheckpoint = 0;
  for (const { entry, data, sameSession } of suffix.reverse()) {
    const version = typeof data.version === "number" ? data.version : 0;
    const checkpointId = typeof data.checkpointId === "string"
      ? data.checkpointId
      : typeof entry.id === "string" ? entry.id : undefined;
    const sourceSessionId = String(data.sessionId ?? sessionId ?? "unknown");
    if (version === PRUNE_STATE_VERSION) {
      if (data.mode === "checkpoint" && Array.isArray(data.prunes)) {
        byCallId.clear();
        applyPersistedPruneRecords(byCallId, data.prunes, version, sourceSessionId, checkpointId);
        deltasSinceCheckpoint = 0;
      } else if (data.mode === "delta" && Array.isArray(data.upserts) && Array.isArray(data.removals)) {
        for (const callId of data.removals) {
          if (typeof callId === "string") byCallId.delete(callId);
        }
        applyPersistedPruneRecords(byCallId, data.upserts, version, sourceSessionId, checkpointId);
        deltasSinceCheckpoint += 1;
      }
    } else if (version >= 3 && version <= 5 && Array.isArray(data.prunes)) {
      requiresCheckpoint = true;
      deltasSinceCheckpoint = 0;
      byCallId.clear();
      applyPersistedPruneRecords(byCallId, data.prunes, version, sourceSessionId, checkpointId);
    } else if ((version === 1 || version === 2) && Array.isArray(data.toolCallIds)) {
      requiresCheckpoint = true;
      deltasSinceCheckpoint = 0;
      byCallId.clear();
      const spillPaths = new Map<string, string>();
      if (version === 2 && Array.isArray(data.spillPaths)) {
        for (const value of data.spillPaths) {
          if (!value || typeof value !== "object") continue;
          const record = value as Record<string, unknown>;
          if (typeof record.callId === "string" && typeof record.path === "string") {
            spillPaths.set(record.callId, record.path);
          }
        }
      }
      for (const value of data.toolCallIds) {
        if (typeof value !== "string") continue;
        const spillPath = spillPaths.get(value);
        byCallId.set(value, {
          callId: value,
          level: spillPath !== undefined ? "spill" : "pruned",
          ...(spillPath !== undefined ? { spillPath } : {}),
          ...(checkpointId !== undefined ? { checkpointId } : {}),
        });
      }
    }
    applied = true;
    if (sameSession) hasCurrentSessionEntry = true;
  }
  const prunes = new Map<string, PersistedPruneEntry>();
  for (const entry of byCallId.values()) prunes.set(restoredPruneKey(entry), entry);
  return {
    prunes,
    byCallId,
    deltasSinceCheckpoint,
    requiresCheckpoint: requiresCheckpoint
      || (applied && (!hasCurrentSessionEntry || !foundCheckpoint))
      || deltasSinceCheckpoint > MAX_PRUNE_DELTAS_BETWEEN_CHECKPOINTS,
  };
}

function applyPersistedPruneRecords(
  target: Map<string, PersistedPruneEntry>,
  values: unknown[],
  version: number,
  sessionId: string,
  checkpointId: string | undefined,
): void {
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (typeof record.callId !== "string" || !isPruneLevel(record.level)) continue;
    const ownerCheckpoint = typeof record.checkpointId === "string" ? record.checkpointId : checkpointId;
    target.set(record.callId, {
      callId: record.callId,
      level: record.level,
      ...(version >= 4 && record.hasSpill === true && typeof record.writerId === "string"
        ? { spillPath: resolveSpillPath(sessionId, record.callId, record.writerId) }
        : typeof record.spillPath === "string" ? { spillPath: record.spillPath } : {}),
      ...(typeof record.introducedAtUsageEpoch === "string" ? { introducedAtUsageEpoch: record.introducedAtUsageEpoch } : {}),
      ...(typeof record.contentDigest === "string" ? { contentDigest: record.contentDigest } : {}),
      ...(typeof record.writerId === "string" ? { writerId: record.writerId } : {}),
      ...(typeof record.refCallId === "string" ? { refCallId: record.refCallId } : {}),
      ...(typeof record.replacementText === "string" ? { replacementText: record.replacementText } : {}),
      ...(ownerCheckpoint !== undefined ? { checkpointId: ownerCheckpoint } : {}),
    });
  }
}

function inspectPruneBranch(ctx: ExtensionContext): {
  checkpointId: string;
  reachable: Map<string, number>;
  latestPruneJournalIndex: number;
} {
  const manager = ctx.sessionManager as {
    getBranch?: () => PruneBranchEntry[];
    getEntries?: () => PruneBranchEntry[];
  } | undefined;
  const entries = manager?.getBranch?.() ?? manager?.getEntries?.() ?? [];
  const reachable = new Map<string, number>();
  let checkpointId: string | undefined;
  let latestPruneJournalIndex = -1;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (typeof entry.id === "string") reachable.set(entry.id, index);
    if (entry.type === "custom" && entry.customType === PRUNE_STATE_ENTRY_TYPE) {
      latestPruneJournalIndex = index;
    }
    const internalStateEntry = entry.type === "custom"
      && (entry.customType === PRUNE_STATE_ENTRY_TYPE || entry.customType === PENDING_INTENT_ENTRY_TYPE);
    if (!internalStateEntry && typeof entry.id === "string") checkpointId = entry.id;
  }
  const rootId = `session:${sessionIdOf(ctx) ?? "unknown"}:root`;
  reachable.set(rootId, -1);
  return { checkpointId: checkpointId ?? rootId, reachable, latestPruneJournalIndex };
}

function syncActivePruneBranch(state: AutoCompactionState, ctx: ExtensionContext): void {
  const branch = inspectPruneBranch(ctx);
  const previousCheckpointId = state.activeCheckpointId;
  const previousRank = previousCheckpointId === undefined
    ? undefined
    : branch.reachable.get(previousCheckpointId);
  const switched = previousCheckpointId !== undefined && previousRank === undefined;
  const advancedAcrossPersistedState = previousCheckpointId !== undefined
    && previousCheckpointId !== branch.checkpointId
    && previousRank !== undefined
    && branch.latestPruneJournalIndex > previousRank;
  if (switched || advancedAcrossPersistedState) {
    if (switched) {
      for (const [callId, entry] of state.pruneManifest) {
        if (!entry.checkpointId) entry.checkpointId = previousCheckpointId;
        if (entry.checkpointId && branch.reachable.has(entry.checkpointId)) continue;
        parkRestoredPrune(state, persistedEntryOf(callId, entry));
        state.pruneManifest.delete(callId);
      }
    }
    const loaded = loadPersistedPrunes(ctx, state.sessionId);
    for (const entry of loaded.byCallId.values()) parkRestoredPrune(state, entry);
    state.persistedPrunes = new Map(loaded.byCallId);
    state.persistedPruneKey = pruneKey(loaded.byCallId.values());
    state.forcePruneCheckpoint = loaded.requiresCheckpoint;
    state.pruneDeltasSinceCheckpoint = loaded.deltasSinceCheckpoint;
  }
  state.activeCheckpointId = branch.checkpointId;
  state.reachableCheckpoints = branch.reachable;
  evictOffBranchRestoredPrunes(state);
}

function restoredPruneKey(entry: PersistedPruneEntry): string {
  return `${entry.checkpointId ?? "legacy"}\u0000${entry.callId}`;
}

function parkRestoredPrune(state: AutoCompactionState, entry: PersistedPruneEntry): void {
  const key = restoredPruneKey(entry);
  state.restoredPrunes.set(key, entry);
  state.restoredPruneAges.set(key, ++state.restoredPruneSequence);
}

function touchRestoredPrunes(state: AutoCompactionState, keys: Iterable<string>): void {
  const age = ++state.restoredPruneSequence;
  for (const key of keys) state.restoredPruneAges.set(key, age);
}

function isCheckpointReachable(state: AutoCompactionState, checkpointId: string | undefined): boolean {
  return checkpointId === undefined || state.reachableCheckpoints.has(checkpointId);
}

function findRestoredPrune(
  state: AutoCompactionState,
  callId: string,
  message: AgentMessage,
): { key: string; persisted: PersistedPruneEntry } | undefined {
  const digest = toolResultDigest(message);
  return [...state.restoredPrunes.entries()]
    .filter(([, entry]) => entry.callId === callId && isCheckpointReachable(state, entry.checkpointId))
    .sort(([leftKey, left], [rightKey, right]) => {
      const leftDigest = left.contentDigest === undefined || left.contentDigest === digest ? 1 : 0;
      const rightDigest = right.contentDigest === undefined || right.contentDigest === digest ? 1 : 0;
      if (leftDigest !== rightDigest) return rightDigest - leftDigest;
      const leftRank = state.reachableCheckpoints.get(left.checkpointId ?? "") ?? -1;
      const rightRank = state.reachableCheckpoints.get(right.checkpointId ?? "") ?? -1;
      return rightRank - leftRank || leftKey.localeCompare(rightKey);
    })
    .map(([key, persisted]) => ({ key, persisted }))[0];
}

/**
 * Evict whole off-branch checkpoints, oldest touch first. Reachable checkpoints
 * are never candidates; an evicted branch is reconstructed from its own journal
 * when it becomes active again.
 */
function evictOffBranchRestoredPrunes(state: AutoCompactionState): void {
  const groups = new Map<string, { keys: string[]; entries: number; bytes: number; age: number }>();
  for (const [key, entry] of state.restoredPrunes) {
    if (isCheckpointReachable(state, entry.checkpointId)) continue;
    const checkpointId = entry.checkpointId ?? "legacy";
    const group = groups.get(checkpointId) ?? { keys: [], entries: 0, bytes: 0, age: 0 };
    group.keys.push(key);
    group.entries += 1;
    group.bytes += serializedPruneBytes(entry);
    group.age = Math.max(group.age, state.restoredPruneAges.get(key) ?? 0);
    groups.set(checkpointId, group);
  }
  let entries = [...groups.values()].reduce((total, group) => total + group.entries, 0);
  let bytes = [...groups.values()].reduce((total, group) => total + group.bytes, 0);
  const victims = [...groups.entries()].sort(([leftId, left], [rightId, right]) =>
    left.age - right.age || leftId.localeCompare(rightId));
  for (const [, group] of victims) {
    if (entries <= MAX_OFF_BRANCH_PRUNE_ENTRIES && bytes <= MAX_OFF_BRANCH_PRUNE_BYTES) break;
    for (const key of group.keys) {
      state.restoredPrunes.delete(key);
      state.restoredPruneAges.delete(key);
    }
    entries -= group.entries;
    bytes -= group.bytes;
  }
}

function serializePersistedPrune(entry: PersistedPruneEntry): Record<string, unknown> {
  const { spillPath: _spillPath, ...serialized } = entry;
  return { ...serialized, hasSpill: _spillPath !== undefined };
}

function serializedPruneBytes(entry: PersistedPruneEntry): number {
  return Buffer.byteLength(JSON.stringify(serializePersistedPrune(entry)), "utf8");
}

function comparePersistedPrunes(left: PersistedPruneEntry, right: PersistedPruneEntry): number {
  return left.callId.localeCompare(right.callId)
    || String(left.checkpointId ?? "").localeCompare(String(right.checkpointId ?? ""));
}

function setPreferredPrune(
  target: Map<string, PersistedPruneEntry>,
  entry: PersistedPruneEntry,
  reachable: Map<string, number>,
): void {
  const previous = target.get(entry.callId);
  if (!previous) {
    target.set(entry.callId, entry);
    return;
  }
  const previousRank = reachable.get(previous.checkpointId ?? "") ?? -1;
  const nextRank = reachable.get(entry.checkpointId ?? "") ?? -1;
  if (nextRank > previousRank
    || (nextRank === previousRank && restoredPruneKey(entry).localeCompare(restoredPruneKey(previous)) < 0)) {
    target.set(entry.callId, entry);
  }
}

function sessionIdOf(ctx: ExtensionContext): string | undefined {
  const manager = ctx.sessionManager as { getSessionId?: () => string } | undefined;
  return manager?.getSessionId?.();
}

function pruneKey(entries: Iterable<PersistedPruneEntry>): string {
  return JSON.stringify([...entries]
    .map((entry) => [
      entry.callId,
      entry.level,
      entry.spillPath ?? null,
      entry.introducedAtUsageEpoch ?? null,
      entry.contentDigest ?? null,
      entry.writerId ?? null,
      entry.checkpointId ?? null,
      entry.refCallId ?? null,
      entry.replacementText ?? null,
    ])
    .sort(([a], [b]) => String(a).localeCompare(String(b))));
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
  const derived = deriveCompactionThreshold({
    reserveTokens: input.settings.reserveTokens,
    contextWindow: input.contextWindow,
    modelMaxTokens: input.modelMaxTokens,
    soft: input.settings.soft,
  });
  const softBands = derived.usable && derived.soft
    ? {
        nudgeTokens: derived.soft.nudgeTokens,
        pruneTokens: derived.soft.pruneTokens,
        pruneTargetTokens: derived.soft.pruneTargetTokens,
      }
    : undefined;
  return applyContextPressurePolicy(input.messages, input.contextWindow, effectiveSettings, undefined, undefined, false, softBands, derived.usable ? derived.thresholdTokens : undefined).band === "critical";
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

export function assistantUsage(message: AgentMessage): { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number } | undefined {
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

export function latestProviderUsageEpoch(messages: AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const usage = assistantUsage(message);
    if (!usage) continue;
    const record = message as MessageRecord & { timestamp?: unknown };
    const usageKey = JSON.stringify(usage);
    const timestamp = record.timestamp;
    const epoch = (typeof timestamp === "number" || (typeof timestamp === "string" && timestamp.length > 0))
      ? `timestamp:${String(timestamp)}:${usageKey}`
      : `message:${createHash("sha256").update(JSON.stringify({
        content: record.content,
        stopReason: record.stopReason,
        usage,
      })).digest("hex")}`;
    return epoch;
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Token estimates are pure functions of an immutable message object, and the
 * same array is estimate-scanned by up to five passes per request (context
 * estimate, frontier, both prune passes, telemetry). Keying the memo on object
 * identity is safe because prunes replace whole array elements — a message is
 * never mutated in place — so a replacement is a new object and misses
 * correctly.
 */
const messageTokenMemo = new WeakMap<object, number>();

export function estimateMessageTokens(message: AgentMessage): number {
  const key = message as unknown as object;
  const memoized = messageTokenMemo.get(key);
  if (memoized !== undefined) return memoized;

  const content = (message as MessageRecord).content;
  let imageCount = 0;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "image") imageCount++;
    }
  }

  let tokens: number;
  if (imageCount > 0) {
    // Base64 image data must not be counted as text — Pi estimates ~1200 tokens
    // per image regardless of resolution.  Build a lightweight copy with empty
    // data fields so the ratio-based estimator only sees the textual payload.
    const lightweight = {
      ...message,
      content: (content as Array<Record<string, unknown>>).map((block) =>
        block?.type === "image" ? { type: "image", mimeType: block.mimeType, data: "" } : block,
      ),
    };
    const serialized = JSON.stringify(lightweight);
    tokens = Math.ceil(serialized.length / tokenCharsPerToken(serialized)) + imageCount * ESTIMATED_IMAGE_TOKENS;
  } else {
    const serialized = JSON.stringify(message);
    tokens = Math.ceil(serialized.length / tokenCharsPerToken(serialized));
  }

  messageTokenMemo.set(key, tokens);
  return tokens;
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

/**
 * Minimum ratio of reclaimed tokens to invalidated cached-prefix tokens for a
 * prune depth to be worth taking.
 *
 * A prune replaces the message at index i, so the provider's cached prompt
 * prefix dies from i to the end. Re-establishing that suffix costs roughly
 * (cacheWrite - cacheRead) ≈ 1.15x base input per token one time, while the
 * reclaimed tokens save ≈ 0.1x per later request. Break-even is therefore about
 * 11.5 / ratio subsequent requests: 0.25 pays for itself within ~46 requests,
 * while the pathological shapes this gate exists to stop sit near 0.03 (~400
 * requests — never). The band is measured, not tuned: observed healthy prune
 * shapes land at 0.66 and pathological ones at 0.027, so any cut in 0.1–0.4
 * separates them.
 */
export const CACHE_PRUNE_MIN_SAVINGS_RATIO = 0.25;

interface PrunePassInput {
  transformed: AgentMessage[];
  pruneManifest: PruneManifest;
  frontierStart: number;
  pruneTarget: number;
  effectiveTokens: number;
  usageEpoch: string | undefined;
  selector: (message: AgentMessage) => AgentMessage | undefined;
  rankCandidates?: (candidates: PruneCandidate[]) => PruneCandidate[];
  /** Call IDs that must not be lossy-pruned (dedup pointer targets). */
  protectedCallIds?: ReadonlySet<string>;
  /** Manifest level recorded for candidates this pass applies. */
  level?: PruneLevel;
}

interface PruneCandidate {
  index: number;
  callId: string;
  replacement: AgentMessage;
  saved: number;
  contentDigest: string;
  level: PruneLevel;
  toolName: string;
  relevanceText: string;
  refCallId?: string;
}

interface PrunePassResult {
  savedTokens: number;
  prunedToolResults: number;
  effectiveTokens: number;
  candidates: PruneCandidate[];
}

/**
 * Suffix sums of per-message token estimates. suffix[i] is the cost of
 * invalidating the cached prefix at index i — everything from i to the end must
 * be reprocessed. Computed once per policy run; estimates are memoized.
 */
export function suffixTokenSums(messages: AgentMessage[]): number[] {
  const suffix = new Array<number>(messages.length + 1);
  suffix[messages.length] = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    suffix[index] = suffix[index + 1] + estimateMessageTokens(messages[index]);
  }
  return suffix;
}

/**
 * Dynamic prune-savings gate: the minimum fraction of the invalidated suffix
 * a prune run must reclaim rises with the observed cache hit ratio (a hot
 * cache makes every mutation more expensive). Baseline is the fixed 25%; the
 * observed ratio pivots it within `range` (default [0.1, 0.5]).
 */
export function dynamicPruneMinRatio(
  hitRatio: number,
  range: [number, number] = [0.1, 0.5],
): number {
  const [lo, hi] = range;
  const clampedHit = Math.min(1, Math.max(0, hitRatio));
  // pivot: hit 0.5 -> baseline 0.25; hit 1.0 -> 0.375; hit 0.0 -> 0.125
  const pivoted = CACHE_PRUNE_MIN_SAVINGS_RATIO * (1 + (clampedHit - 0.5));
  return Math.min(hi, Math.max(lo, pivoted));
}

/** Milliseconds-since-epoch of the latest assistant message, if trustworthy. */
function lastAssistantTimestamp(messages: AgentMessage[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const record = messages[index] as MessageRecord & { timestamp?: unknown };
    if (record.role !== "assistant") continue;
    const ts = record.timestamp;
    if (typeof ts === "number" && Number.isFinite(ts)) return ts;
    if (typeof ts === "string" && ts.length > 0) {
      const parsed = Date.parse(ts);
      if (!Number.isNaN(parsed)) return parsed;
    }
    // The latest assistant message owns cache freshness. Falling back to an
    // older timestamp could mark a recently active cache as cold.
    return undefined;
  }
  return undefined;
}

/**
 * True when the gap since the last assistant message exceeds
 * `gapThresholdMinutes` (cache-cold heuristic). Missing/parsable-false
 * timestamps conservatively return false so pruning never runs un-gated on
 * unknown age.
 */
export function isCacheColdByTime(
  messages: AgentMessage[],
  gapThresholdMinutes: number,
  now: number = Date.now(),
): boolean {
  if (!Number.isFinite(gapThresholdMinutes) || gapThresholdMinutes <= 0) return false;
  const lastTs = lastAssistantTimestamp(messages);
  if (lastTs === undefined) return false;
  const gapMinutes = (now - lastTs) / 60_000;
  return Number.isFinite(gapMinutes) && gapMinutes > gapThresholdMinutes;
}

/**
 * Deepest prune depth whose CUMULATIVE savings still justify the cached prefix
 * it invalidates, or 0 to prune nothing.
 *
 * Selection must look at the whole candidate run, not each candidate in
 * isolation: within a tier candidates are visited newest-first, and the first
 * one always looks worst because it already pays for the entire suffix while
 * contributing only its own savings. A complete plan may concatenate tiers,
 * so the invalidation boundary is the earliest index seen in the prefix rather
 * than the current candidate's index. Measured on a uniform tool-loop transcript
 * the ratio climbs 0.12 -> 0.66 across 15 candidates, so a greedy per-candidate
 * test would reject the whole (profitable) run on its first element.
 */
export function cacheWorthwhileDepth(
  candidates: Array<{ index: number; saved: number }>,
  suffixTokens: number[],
  minRatio: number = CACHE_PRUNE_MIN_SAVINGS_RATIO,
  initialSavings: number = 0,
): number {
  let cumulative = initialSavings;
  let earliestIndex = Number.POSITIVE_INFINITY;
  let depth = 0;
  for (let position = 0; position < candidates.length; position++) {
    const candidate = candidates[position];
    cumulative += candidate.saved;
    earliestIndex = Math.min(earliestIndex, candidate.index);
    const invalidated = suffixTokens[earliestIndex] ?? 0;
    if (invalidated <= 0) continue;
    if (cumulative >= invalidated * minRatio) depth = position + 1;
  }
  return depth;
}

function applyPruneCandidates(
  transformed: AgentMessage[],
  pruneManifest: PruneManifest,
  candidates: PruneCandidate[],
  depth: number,
  effectiveTokens: number,
  usageEpoch: string | undefined,
): PrunePassResult {
  let savedTokens = 0;
  let prunedToolResults = 0;
  const appliedCandidates = candidates.slice(0, depth);
  for (const candidate of appliedCandidates) {
    transformed[candidate.index] = candidate.replacement;
    recordPrune(pruneManifest, candidate.callId, {
      replacement: candidate.replacement,
      savedTokens: candidate.saved,
      introducedAtUsageEpoch: usageEpoch,
      contentDigest: candidate.contentDigest,
      level: candidate.level,
      ...(candidate.refCallId !== undefined ? { refCallId: candidate.refCallId } : {}),
    });
    savedTokens += candidate.saved;
    prunedToolResults++;
    effectiveTokens -= candidate.saved;
  }
  return { savedTokens, prunedToolResults, effectiveTokens, candidates: appliedCandidates };
}

function rankPruneCandidates(
  candidates: PruneCandidate[],
  query: string,
  mode: RelevanceMode,
): PruneCandidate[] {
  if (candidates.length < 2 || !query.trim()) return candidates;
  const documents = candidates.map((candidate) =>
    `${candidate.toolName}\n${candidate.relevanceText}`);
  const scores = scoreRelevanceBatch(documents, query, mode);
  return candidates
    .map((candidate, position) => ({ candidate, position, score: scores[position] ?? 0 }))
    .sort((left, right) =>
      left.score - right.score
      || right.candidate.index - left.candidate.index
      || left.position - right.position)
    .map((item) => item.candidate);
}

function sampleRelevanceText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n${text.slice(-half)}`;
}

function latestRelevanceQuery(messages: AgentMessage[]): string {
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if ((messages[index] as MessageRecord).role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return "";
  const userText = sampleRelevanceText(
    extractTextContent(messages[userIndex]).trim(),
    RELEVANCE_QUERY_SAMPLE_CHARS,
  );
  const parts = [userText];
  const toolNames = new Set<string>();
  for (let index = userIndex + 1; index < messages.length; index++) {
    const content = (messages[index] as MessageRecord).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const call = block as { type?: unknown; name?: unknown };
      if (call.type === "toolCall" && typeof call.name === "string" && call.name.trim()) {
        toolNames.add(call.name.trim());
      }
    }
  }
  parts.push(...toolNames);
  return parts.filter(Boolean).join("\n");
}

function runPrunePass(input: PrunePassInput): PrunePassResult {
  const { transformed, pruneManifest, frontierStart, pruneTarget, usageEpoch, selector } = input;
  const effectiveTokens = input.effectiveTokens;

  // Default mode preserves the historical newest-first walk and stops once the
  // target is projected. Relevance mode must collect the whole eligible tier
  // before sorting, otherwise older low-relevance candidates are invisible.
  const candidates: PruneCandidate[] = [];
  const claimedCallIds = new Set(pruneManifest.keys());
  let projectedTokens = effectiveTokens;
  let relevanceSampleChars = 0;
  const collectWholeTier = input.rankCandidates !== undefined && projectedTokens > pruneTarget;
  for (let index = frontierStart - 1;
    index >= 0 && (collectWholeTier || projectedTokens > pruneTarget);
    index--) {
    const original = transformed[index];
    const callId = toolResultCallId(original);
    if (!callId || claimedCallIds.has(callId)) continue;
    const replacement = selector(original);
    if (!replacement) continue;
    const before = estimateMessageTokens(original);
    const after = estimateMessageTokens(replacement);
    if (after >= before) continue;
    const saved = before - after;
    const record = original as MessageRecord;
    if (input.protectedCallIds?.has(callId)) continue;
    const relevanceText = collectWholeTier
      ? sampleRelevanceText(extractTextContent(original), RELEVANCE_DOCUMENT_SAMPLE_CHARS)
      : "";
    if (collectWholeTier && (candidates.length >= RELEVANCE_MAX_CANDIDATES
      || relevanceSampleChars + relevanceText.length > RELEVANCE_TOTAL_SAMPLE_CHARS)) {
      break;
    }
    candidates.push({
      index,
      callId,
      replacement,
      saved,
      contentDigest: toolResultDigest(original),
      level: input.level ?? "pruned",
      toolName: typeof record.toolName === "string" ? record.toolName : "tool",
      relevanceText,
    });
    claimedCallIds.add(callId);
    relevanceSampleChars += relevanceText.length;
    if (!collectWholeTier) projectedTokens -= saved;
  }

  let selected = candidates;
  if (collectWholeTier && input.rankCandidates) {
    const ranked = input.rankCandidates(candidates);
    projectedTokens = effectiveTokens;
    let depth = 0;
    while (depth < ranked.length && projectedTokens > pruneTarget) {
      projectedTokens -= ranked[depth].saved;
      depth++;
    }
    selected = ranked.slice(0, depth);
  }

  // A pass always applies its complete ungated candidate run. When cache
  // economics are active, callers execute passes against a copy and apply one
  // cumulatively qualified prefix to the real context afterward.
  return applyPruneCandidates(
    transformed,
    pruneManifest,
    selected,
    selected.length,
    effectiveTokens,
    usageEpoch,
  );
}

/**
 * Tier 0.5 — cross-turn verbatim de-duplication (default off). Builds a
 * prefix-ordered list of eligible tool outputs and folds later spans that
 * already appeared verbatim in an earlier output into an in-context pointer
 * (ported from headroom cross_turn_dedup). Folds are recorded in the manifest
 * at level "dedup" with their reference target, and every target is added to
 * `dedupProtected` so lossy passes keep the pointer's original in context.
 */
function runDedupPass(input: {
  transformed: AgentMessage[];
  pruneManifest: PruneManifest;
  frontierStart: number;
  effectiveTokens: number;
  minLines: number;
  minChars: number;
  dedupProtected: Set<string>;
}): PrunePassResult {
  const { transformed, pruneManifest, frontierStart, minLines, minChars } = input;
  const claimed = new Set(pruneManifest.keys());
  const blocks: DedupBlock[] = [];
  const indexByCallId = new Map<string, number>();
  for (let index = 0; index < frontierStart; index++) {
    const original = transformed[index];
    const record = original as MessageRecord;
    if (record.role !== "toolResult") continue;
    const callId = toolResultCallId(original);
    if (!callId || claimed.has(callId)) continue;
    if (record.isError === true) continue;
    const text = extractTextContent(original);
    if (text.length < 8) continue;
    // Dedup only rewrites pure text outputs. A result carrying image or other
    // non-text blocks is skipped so those blocks can never be dropped.
    if (!isTextOnlyContent(original)) continue;
    blocks.push({ text, callId });
    indexByCallId.set(callId, index);
  }
  if (blocks.length < 2) {
    return { savedTokens: 0, prunedToolResults: 0, effectiveTokens: input.effectiveTokens, candidates: [] };
  }

  const folded = dedupBlocks(blocks, { minLines, minChars });
  const candidates: PruneCandidate[] = [];
  let effectiveTokens = input.effectiveTokens;
  let savedTokens = 0;
  for (let position = 0; position < blocks.length; position++) {
    const original = blocks[position];
    const foldedText = folded.blocks[position]?.text;
    if (foldedText === undefined || foldedText === original.text) continue;
    const index = indexByCallId.get(original.callId);
    if (index === undefined) continue;
    const before = estimateMessageTokens(transformed[index]);
    const replacement = {
      ...transformed[index],
      content: [{ type: "text", text: foldedText }],
    } as AgentMessage;
    const after = estimateMessageTokens(replacement);
    if (after >= before) continue;
    const record = transformed[index] as MessageRecord;
    const targets = folded.refs.get(original.callId);
    const refCallId = targets !== undefined && targets.size > 0
      ? [...targets][0]
      : undefined;
    candidates.push({
      index,
      callId: original.callId,
      replacement,
      saved: before - after,
      contentDigest: toolResultDigest(transformed[index]),
      level: "dedup",
      toolName: typeof record.toolName === "string" ? record.toolName : "tool",
      relevanceText: original.text,
      ...(refCallId !== undefined ? { refCallId } : {}),
    });
    savedTokens += before - after;
    effectiveTokens -= before - after;
    if (targets !== undefined) {
      for (const target of targets) input.dedupProtected.add(target);
    }
  }
  if (candidates.length > 0) {
    // Record folds in the planning manifest so later lossy passes skip them
    // (recordPrune refuses overwrites) and apply them to the plan's messages.
    applyPruneCandidates(transformed, pruneManifest, candidates, candidates.length, effectiveTokens, undefined);
  }
  return { savedTokens, prunedToolResults: candidates.length, effectiveTokens, candidates };
}

/** True when every content block of a message is a text block. */
function isTextOnlyContent(message: AgentMessage): boolean {
  const content = (message as MessageRecord).content;
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return content.every((block) => !!block && typeof block === "object" && block.type === "text");
}

function isProtectedToolResult(message: AgentMessage): boolean {
  const record = message as MessageRecord;
  if (record.role !== "toolResult") return false;
  if (record.isError === true) return true;
  if (typeof record.toolName === "string" && PROTECTED_TOOL_NAMES.has(record.toolName.toLowerCase())) return true;
  return extractTextContent(message).length < PROTECTED_THRESHOLD_CHARS;
}

/**
 * Content-aware kind selection: when the output's shape is unambiguous the
 * detector wins over the tool name (e.g. `bash` running `git diff`), otherwise
 * fall back to the tool-name mapping.
 */
function losslessKindForContent(text: string): LosslessKind | undefined {
  const detected = detectContentType(text);
  switch (detected.contentType) {
    case "search":
      return "search";
    case "diff":
      return "diff";
    case "build":
      return "log";
    case "source_code":
      return "text";
    default:
      return undefined;
  }
}

/** Map a tool name to the lossless compaction kind it most resembles. */
function losslessKindForTool(toolName: string | undefined): LosslessKind {
  switch (toolName?.toLowerCase()) {
    case "grep":
    case "ripgrep":
    case "search":
      return "search";
    case "bash":
    case "shell":
    case "exec":
      return "log";
    case "diff":
    case "git-diff":
      return "diff";
    case "find":
    case "ls":
      return "paths";
    default:
      return "text";
  }
}

/**
 * Tier-0 lossless folding (algorithm ported from headroom lossless_compaction,
 * Apache-2.0). Reversibly folds format-native redundancy — log run collapse,
 * grep heading folding, diff index stripping — with a runtime round-trip
 * self-check inside compactLossless, so it never loses information and never
 * inflates. Returns undefined when nothing is gained; the caller falls through
 * to the lossy prune path.
 */
function tryLosslessFold(message: AgentMessage): AgentMessage | undefined {
  if (isProtectedToolResult(message)) return undefined;
  const record = message as MessageRecord;
  const text = extractTextContent(message);
  if (text.length < PROTECTED_THRESHOLD_CHARS) return undefined;
  const folded = compactLossless(
    text,
    losslessKindForContent(text) ?? losslessKindForTool(
      typeof record.toolName === "string" ? record.toolName : undefined,
    ),
  );
  if (folded === text || folded.length >= text.length) return undefined;
  const replacement = {
    ...message,
    content: [{ type: "text", text: folded }],
  } as AgentMessage;
  // Token guard in addition to the char guard: a shorter string can still
  // tokenize larger (marker words vs. raw data). runPrunePass re-checks, but
  // failing here keeps lossless entries out of the manifest entirely.
  const before = estimateMessageTokens(message);
  const after = estimateMessageTokens(replacement);
  if (after >= before) return undefined;
  return replacement;
}

function replaceableToolResult(message: AgentMessage): AgentMessage | undefined {
  if (isProtectedToolResult(message)) return undefined;
  const record = message as MessageRecord;
  if (record.role !== "toolResult" || record.isError === true) return undefined;
  if (typeof record.toolName !== "string" || !REPLAYABLE_TOOL_NAMES.has(record.toolName.toLowerCase())) return undefined;
  if (extractTextContent(message).length < SPILL_THRESHOLD_CHARS) return undefined;
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
  if (isProtectedToolResult(message)) return undefined;
  const record = message as MessageRecord;
  if (record.role !== "toolResult" || record.isError === true) return undefined;
  if (typeof record.toolName !== "string" || !EVICTABLE_BULK_TOOL_NAMES.has(record.toolName.toLowerCase())) return undefined;
  if (extractTextContent(message).length < SPILL_THRESHOLD_CHARS) return undefined;
  const toolName = record.toolName;
  return {
    ...message,
    content: [{
      type: "text",
      text: `[Maestro context pressure: stale large output from ${toolName} was evicted to reclaim context. The original payload is no longer available; re-derive it from the affected files or commands if still needed.]`,
    }],
  } as AgentMessage;
}

export function pruneToolResult(message: AgentMessage): AgentMessage | undefined {
  return replaceableToolResult(message) ?? evictableBulkToolResult(message);
}

const PERSISTED_OUTPUT_TAG = "<persisted-output>";

function minimalSpillReplacement(message: AgentMessage, spillPath: string): AgentMessage {
  return {
    ...message,
    content: [{ type: "text", text: `[Maestro context pressure: pruned. File: ${spillPath}. Use read to reload.]` }],
  } as AgentMessage;
}

function compactNewSpilledPrunes(
  transformed: AgentMessage[],
  pruneManifest: Map<string, PruneManifestEntry>,
  newSpillCallIds: Set<string>,
): { tokenDelta: number } {
  let tokenDelta = 0;
  for (let index = 0; index < transformed.length; index++) {
    const callId = toolResultCallId(transformed[index]);
    if (!callId || !newSpillCallIds.has(callId)) continue;
    const entry = pruneManifest.get(callId);
    if (!entry?.spillPath || (entry.level ?? "spill") !== "spill") continue;
    const text = extractTextContent(transformed[index]);
    if (!text.startsWith(PERSISTED_OUTPUT_TAG)) continue;
    const minimal = minimalSpillReplacement(transformed[index], entry.spillPath);
    const delta = estimateMessageTokens(minimal) - estimateMessageTokens(transformed[index]);
    if (delta >= 0) continue;
    transformed[index] = minimal;
    entry.replacement = minimal;
    entry.savedTokens -= delta;
    entry.level = "minimal";
    tokenDelta += delta;
  }
  return { tokenDelta };
}

function toolResultDigest(message: AgentMessage): string {
  const record = message as MessageRecord;
  return createHash("sha256").update(JSON.stringify({
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    isError: record.isError === true,
    content: record.content,
  })).digest("hex");
}

function extractTextContent(message: AgentMessage): string {
  const content = (message as MessageRecord).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    const blockText = (block as { text?: unknown } | null)?.text;
    if (typeof blockText === "string") text += blockText;
  }
  return text;
}

async function upgradeNewPrunesWithSpill(
  originalMessages: AgentMessage[],
  transformedMessages: AgentMessage[],
  pruneManifest: PruneManifest,
  sessionId: string,
  newCallIds: Set<string>,
  writerId?: string,
): Promise<{ tokenDelta: number; callIds: Set<string> }> {
  const callIds = new Set<string>();
  let tokenDelta = 0;
  if (!(pruneManifest instanceof Map)) return { tokenDelta, callIds };
  const originalsByCallId = new Map<string, AgentMessage>();
  for (const msg of originalMessages) {
    const callId = toolResultCallId(msg);
    if (callId) originalsByCallId.set(callId, msg);
  }
  for (let index = 0; index < transformedMessages.length; index++) {
    const callId = toolResultCallId(transformedMessages[index]);
    if (!callId || !newCallIds.has(callId)) continue;
    const entry = pruneManifest.get(callId);
    if (!entry || entry.spillPath !== undefined) continue;
    // Lossless folds carry no recoverability need — the folded text IS the
    // full content, reversibly so. Spilling it would replace a complete
    // (folded) payload with a 1.5K preview for no gain. Dedup pointers name an
    // in-context original; spilling would replace the pointer with a preview
    // after the cache gate already approved pointer economics.
    if ((entry.level ?? "pruned") === "lossless" || (entry.level ?? "pruned") === "dedup") continue;
    const original = originalsByCallId.get(callId);
    if (!original) continue;
    const text = extractTextContent(original);
    if (text.length < SPILL_THRESHOLD_CHARS) continue;
    const toolName = typeof (original as MessageRecord).toolName === "string"
      ? (original as MessageRecord).toolName as string
      : "tool";
    const spill = await spillToolResult(sessionId, callId, text, writerId);
    if (!spill.ok) {
      // The write failed, so the payload is not recoverable from disk and the
      // no-path replacement text is a 1.5K preview — strictly worse than the
      // pruned placeholder already in place. Keep the placeholder and leave
      // spillPath unset. This entry is NOT retried on a later pass: only
      // callIds recorded by the current policy pass are eligible above, so the
      // plain replacement stays frozen for the rest of the compaction epoch
      // even if the disk recovers. A background persist may still land the
      // bytes, but provider-visible bytes never change mid-epoch.
      continue;
    }
    const replacementText = buildSpillReplacementText(spill, toolName);
    const upgraded: AgentMessage = {
      ...transformedMessages[index],
      content: [{ type: "text", text: replacementText }],
    } as AgentMessage;
    tokenDelta += estimateMessageTokens(upgraded) - estimateMessageTokens(transformedMessages[index]);
    transformedMessages[index] = upgraded;
    entry.replacement = upgraded;
    entry.spillPath = spill.path;
    entry.writerId = writerId;
    entry.savedTokens = estimateMessageTokens(original) - estimateMessageTokens(upgraded);
    entry.level = "spill";
    callIds.add(callId);
  }
  return { tokenDelta, callIds };
}

// --- Extracted to pressure-telemetry.ts ---
import {
  adjustPressureAfterReplacementChange,
  assistantToolCallIds, buildMidTurnInstructions, buildMidTurnTrigger,
  buildOutputLimitInstructions, buildVelocityInfo, cacheHitRatio, clearPressureStatus,
  compactionBreakerAllows, COMPACTION_BREAKER_COOLDOWN_TURNS, computeContextSignals,
  decideContextAction, derivePressureBand, EMPTY_VELOCITY_TRACKER,
  finalAssistantStopReason, formatTokens, latestCacheHitRatio,
  MAX_CONSECUTIVE_COMPACTION_FAILURES, observeCacheAttribution, observeVelocity,
  pressureResult, publishIdleStatus, recordCompactionFailure,
  redundantToolResultCallIds, resetCompactionBreaker, roleOf, scanContextTokens,
  shouldCancelCompletedTurnThreshold, shouldPreserveCompletedTurn,
  shouldVelocityEscalate, toolResultCallId, toolResultPatternKey,
  updatePressureStatus, type CompactionBreakerState,
} from "./pressure-telemetry.ts";
export {
  cacheHitRatio, compactionBreakerAllows, COMPACTION_BREAKER_COOLDOWN_TURNS,
  computeContextSignals, decideContextAction, derivePressureBand,
  EMPTY_VELOCITY_TRACKER, finalAssistantStopReason,
  MAX_CONSECUTIVE_COMPACTION_FAILURES, observeVelocity, buildVelocityInfo,
  recordCompactionFailure, redundantToolResultCallIds, resetCompactionBreaker,
  shouldPreserveCompletedTurn, shouldCancelCompletedTurnThreshold,
  shouldVelocityEscalate, toolResultPatternKey,
};
export type { CompactionBreakerState } from "./pressure-telemetry.ts";
