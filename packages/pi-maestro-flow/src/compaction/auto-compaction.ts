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
import {
  SPILL_THRESHOLD_CHARS,
  SPILL_PREVIEW_CHARS,
  spillToolResult,
  generatePreview,
  buildSpillReplacementText,
  cleanupSpillDir,
} from "./tool-result-spill.ts";

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
const CONTINUE_PROMPT = "Continue the interrupted task from the compacted session checkpoint. Do not wait for another user request.";
const OUTPUT_LIMIT_CONTINUE_PROMPT = "Your previous response was cut off at the model output token limit, and the context was just compacted to free room. Continue exactly from where the interrupted response stopped and complete it. Do not restart or wait for another user request.";
const DEFAULT_OUTPUT_LIMIT_RATIO = 0.8;
export const MAX_OUTPUT_LIMIT_COMPACTIONS = 2;
const PRUNE_STATE_ENTRY_TYPE = "maestro-auto-prune-state";
const PRUNE_STATE_VERSION = 3;

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
  spillPath?: string;
  level?: PruneLevel;
}

export type PruneLevel = "pruned" | "spill" | "minimal";

interface PersistedPruneEntry {
  callId: string;
  level: PruneLevel;
  spillPath?: string;
  introducedAtUsageEpoch?: string;
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
  restoredPrunes: Map<string, PersistedPruneEntry>;
  sessionId?: string;
  persistedPruneKey?: string;
  settingsSnapshot?: CompactionSettings;
  settingsCwd?: string;
  velocityTracker: VelocityTracker;
  /** Held whole so the two fields can never be written back out of step. */
  breaker: CompactionBreakerState;
  breakerNotified: boolean;
  turnCount: number;
  outputLimitCompactions: number;
  outputLimitBreakerNotified: boolean;
  /** Provider usage epoch the cache ratio below was sampled at. */
  cacheEpoch?: string;
  cacheRatio?: number;
  /** Epoch during which new prunes were introduced, pending its cache bill. */
  prunedDuringEpoch?: string;
  /** Cache-ratio movement attributed to the prunes of the previous epoch. */
  cacheDelta?: number;
  /** Serializes manifest mutation; `running` covers compaction, not this. */
  evaluating: boolean;
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
    restoredPrunes: new Map(),
    velocityTracker: EMPTY_VELOCITY_TRACKER,
    breaker: resetCompactionBreaker(),
    breakerNotified: false,
    turnCount: 0,
    outputLimitCompactions: 0,
    outputLimitBreakerNotified: false,
    evaluating: false,
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
    state.activeLease?.release();
    state.activeLease = undefined;
    state.lastTriggerKey = undefined;
    state.lastNoCompactableKey = undefined;
    state.internalsWarningShown = false;
    state.evaluating = false;
  }
  function resetCycleState(): void {
    state.velocityTracker = EMPTY_VELOCITY_TRACKER;
    state.breaker = resetCompactionBreaker();
    state.breakerNotified = false;
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
      if (!settings.enabled || ctx.model.contextWindow <= settings.reserveTokens) {
        if (state.sessionId) void cleanupSpillDir(state.sessionId);
        state.pruneManifest.clear();
        state.restoredPrunes.clear();
        persistPruneManifest(pi, state);
        clearPressureStatus(ctx);
        return undefined;
      }
      hydrateRestoredPrunes(state, messages);
      retainVisiblePrunes(state.pruneManifest, messages, state.restoredPrunes);
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
      const manifestSizeBefore = state.pruneManifest.size;
      let pressure = applyContextPressurePolicy(
        messages,
        ctx.model.contextWindow,
        effectiveSettings,
        state.pruneManifest,
        state.velocityTracker,
      );
      state.velocityTracker = pressure.velocityTracker;
      const newPrunes = state.pruneManifest.size - manifestSizeBefore;
      if (pressure.prunedToolResults > 0 && state.sessionId) {
        const upgraded = await upgradeNewPrunesWithSpill(messages, pressure.messages, state.pruneManifest, state.sessionId);
        // reset()/onSessionStart may have run during that await, bumping the
        // generation and clearing the manifest. Writing our stale view back
        // would resurrect prunes for a session that no longer exists.
        if (state.generation !== generation) return undefined;
        pressure = adjustPressureAfterReplacementChange(
          pressure,
          upgraded.tokenDelta,
          ctx.model.contextWindow,
          effectiveSettings,
        );
        if (pressure.band === "critical" && upgraded.callIds.size > 0) {
          const minimized = compactNewSpilledPrunes(pressure.messages, state.pruneManifest, upgraded.callIds);
          pressure = adjustPressureAfterReplacementChange(
            pressure,
            minimized.tokenDelta,
            ctx.model.contextWindow,
            effectiveSettings,
          );
        }
      }
      observeCacheAttribution(state, messages, newPrunes);
      updatePressureStatus(ctx, pressure, state.cacheDelta);
      persistPruneManifest(pi, state);
      if (pressure.action !== "compact") {
        state.lastNoCompactableKey = undefined;
        return pressure.prunedToolResults > 0 ? pressure.messages : undefined;
      }
      const estimate = estimateContextTokens(pressure.messages);
      const thresholdTokens = pressure.thresholdTokens;

      const triggerKey = `${estimate.tokens}:${thresholdTokens}:${messages.length}`;
      if (state.lastTriggerKey === triggerKey) return pressure.messages;
      const breakerCheck = compactionBreakerAllows(state.breaker, state.turnCount);
      // A cooldown that auto-resets clears the trip; without also clearing the
      // notified flag the SECOND and later trips in a session stay silent.
      if (state.breaker.trippedAtTurn !== undefined && breakerCheck.breaker.trippedAtTurn === undefined) {
        state.breakerNotified = false;
      }
      state.breaker = breakerCheck.breaker;
      if (!breakerCheck.allowed) {
        if (!state.breakerNotified) {
          state.breakerNotified = true;
          ctx.ui.notify(
            `Mid-turn compaction paused after ${state.breaker.consecutiveFailures} consecutive failures; retrying after ${COMPACTION_BREAKER_COOLDOWN_TURNS} turns.`,
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
      const failCompaction = (error: unknown) => {
        if (state.generation !== generation || state.activeOwner !== owner) return;
        state.breaker = recordCompactionFailure(state.breaker, state.turnCount);
        state.running = false;
        state.activeOwner = undefined;
        state.lastTriggerKey = undefined;
        state.activeLease?.release();
        state.activeLease = undefined;
        clearPressureStatus(ctx);
        ctx.ui.notify(`Mid-turn compaction failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      };
      // ctx.abort() and the status/instruction calls used to sit OUTSIDE this
      // try. A throw there stranded the arbiter lease and pinned running=true
      // forever, silently disabling compaction for the rest of the session.
      try {
        ctx.abort();
        ctx.ui.setStatus(COMPACTION_STATUS_KEY, `COMPACT ${estimate.tokens}/${thresholdTokens}`);
        const instructions = buildMidTurnInstructions(
          estimate,
          ctx.model.contextWindow,
          effectiveSettings.reserveTokens,
        );
        ctx.compact({
          customInstructions: state.activeLease?.tagInstructions(instructions) ?? instructions,
          onComplete: () => {
            if (state.generation !== generation || state.activeOwner !== owner) return;
            state.breaker = resetCompactionBreaker();
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
  }

  return {
    onSessionStart(ctx) {
      if (state.sessionId) void cleanupSpillDir(state.sessionId);
      releaseInFlight();
      state.pruneManifest.clear();
      state.sessionId = sessionIdOf(ctx);
      state.restoredPrunes = loadPersistedPrunes(ctx, state.sessionId);
      state.persistedPruneKey = pruneKey(state.restoredPrunes.values());
      state.settingsSnapshot = undefined;
      state.settingsCwd = undefined;
      resetCycleState();
      state.turnCount = 0;
      publishIdleStatus(ctx, settingsFor(ctx).enabled);
    },
    async evaluate(messages, ctx) {
      const generation = state.generation;
      if (state.running) return undefined;
      // The prune manifest is mutated across an await (spill upgrade), and
      // `running` only covers compaction — it is not set until much later. A
      // second context hook arriving mid-await would otherwise interleave writes
      // into the same Map and persist a manifest reflecting neither run.
      if (state.evaluating) return undefined;
      state.evaluating = true;
      try {
        return await evaluateInner(messages, ctx, generation);
      } finally {
        state.evaluating = false;
      }
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
      // These used to be fully swallowed, so a user whose response was cut off
      // at the output limit saw no recovery and no reason. The structurally
      // identical mid-turn path already notifies on all three.
      let internals: PiCompactionInternals;
      try {
        internals = await loadInternals();
      } catch (error) {
        ctx.ui.notify(`Output-limit compaction disabled: ${error instanceof Error ? error.message : String(error)}`, "warning");
        return;
      }
      const branch = ctx.sessionManager.getBranch();
      let preparation: unknown;
      try {
        preparation = internals.prepareCompaction(branch, settings);
      } catch (error) {
        ctx.ui.notify(`Output-limit compaction preparation failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
        return;
      }
      if (!preparation) {
        ctx.ui.notify(
          "Output-limit compaction skipped: Pi has no compactable history; the response keeps hitting the output token limit inside the recent keep window.",
          "warning",
        );
        return;
      }
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
      if (state.sessionId) void cleanupSpillDir(state.sessionId);
      state.pruneManifest.clear();
      state.restoredPrunes.clear();
      state.persistedPruneKey = undefined;
      state.lastTriggerKey = undefined;
      state.lastNoCompactableKey = undefined;
      resetCycleState();
    },
    reset(ctx) {
      state.generation += 1;
      releaseInFlight();
      if (state.sessionId) void cleanupSpillDir(state.sessionId);
      state.pruneManifest.clear();
      state.restoredPrunes.clear();
      state.persistedPruneKey = undefined;
      state.settingsSnapshot = undefined;
      state.settingsCwd = undefined;
      resetCycleState();
      state.turnCount = 0;
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
  // Invariant: .workflow/specs/architecture-constraints.md S-20260724-cbhh
  // (compaction prune invariants) and coding-conventions.md (same-epoch
  // identical-replacement rule). Three prior sessions paid for this guarantee —
  // see the prefix-stability tests before weakening it.
  let newlySavedTokens = 0;
  if (soft.enabled) {
    if (transformed === messages) transformed = [...messages];
    const frontierStart = protectedFrontierStart(transformed, settings.keepRecentTokens);
    const pruneTarget = Math.min(thresholdTokens, Math.floor(contextWindow * soft.pruneTargetRatio));
    const usageEpoch = latestProviderUsageEpoch(messages);
    // Cache gate: a prune kills the provider's cached prefix from its index to
    // the end, so below the critical band a prune run must reclaim enough tokens
    // to pay for the prefix it invalidates. Past critical, relieving pressure
    // dominates — a full compaction would invalidate everything anyway plus cost
    // an LLM call — so the gate is bypassed and every candidate is applied.
    const suffixTokens = soft.cache.enabled && !initiallyCritical
      ? suffixTokenSums(transformed)
      : undefined;
    // Graduated eviction, cheapest/most-reversible first: pass 1 strips replayable
    // tools (re-runnable); pass 2 strips bulk data tools (bash/edit/write) only if
    // pressure persists. Control tools (e.g. todo) are in neither set and survive.
    const replayable = runPrunePass({ transformed, pruneManifest, frontierStart, pruneTarget, effectiveTokens: initial, usageEpoch, selector: replaceableToolResult, suffixTokens });
    newlySavedTokens += replayable.savedTokens;
    savedTokens += replayable.savedTokens;
    prunedToolResults += replayable.prunedToolResults;
    const bulk = runPrunePass({ transformed, pruneManifest, frontierStart, pruneTarget, effectiveTokens: replayable.effectiveTokens, usageEpoch, selector: evictableBulkToolResult, suffixTokens });
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
  pruneManifest: PruneManifest,
  messages: AgentMessage[],
  parked?: Map<string, PersistedPruneEntry>,
): void {
  if (pruneManifest.size === 0) return;
  const visible = new Set<string>();
  for (const message of messages) {
    const callId = toolResultCallId(message);
    if (callId) visible.add(callId);
  }
  for (const callId of pruneManifest.keys()) {
    if (visible.has(callId)) continue;
    parked?.set(callId, persistedEntryOf(callId, getRecordedPrune(pruneManifest, callId)));
    pruneManifest.delete(callId);
  }
}

function hasRecordedPrune(manifest: PruneManifest, callId: string): boolean {
  return manifest.has(callId);
}

function getRecordedPrune(manifest: PruneManifest, callId: string): PruneManifestEntry | undefined {
  return manifest.get(callId);
}

function isPruneLevel(value: unknown): value is PruneLevel {
  return value === "pruned" || value === "spill" || value === "minimal";
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
  if (persisted.level === "minimal") {
    if (!persisted.spillPath) return undefined;
    return minimalSpillReplacement(message, persisted.spillPath);
  }
  // A spill entry whose file is gone (cleaned tmpdir, failed write persisted by
  // an older build) degrades to the plain placeholder rather than the pathless
  // spill text, which would carry a 1.5K preview for no recoverability.
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

function hydrateRestoredPrunes(state: AutoCompactionState, messages: AgentMessage[]): void {
  if (state.restoredPrunes.size === 0) return;
  const visibleIds = new Set<string>();
  for (const message of messages) {
    const callId = toolResultCallId(message);
    if (!callId) continue;
    const persisted = state.restoredPrunes.get(callId);
    if (!persisted) continue;
    visibleIds.add(callId);
    const replacement = restorePruneReplacement(message, persisted);
    if (!replacement) continue;
    const savedTokens = estimateMessageTokens(message) - estimateMessageTokens(replacement);
    if (savedTokens <= 0) continue;
    state.pruneManifest.set(callId, {
      replacement,
      savedTokens,
      introducedAtUsageEpoch: persisted.introducedAtUsageEpoch,
      spillPath: persisted.spillPath,
      level: persisted.level,
    });
  }
  for (const callId of visibleIds) state.restoredPrunes.delete(callId);
}

function persistPruneManifest(pi: ExtensionAPI, state: AutoCompactionState): void {
  // Live entries plus everything still parked (not yet hydrated, or parked by
  // retainVisiblePrunes while its message is off-branch). Persisting only the
  // live half would make a one-frame absence permanent across a resume.
  const byCallId = new Map<string, PersistedPruneEntry>(state.restoredPrunes);
  for (const [callId, entry] of state.pruneManifest.entries()) {
    byCallId.set(callId, persistedEntryOf(callId, entry));
  }
  const prunes = [...byCallId.values()].sort((a, b) => a.callId.localeCompare(b.callId));
  const nextKey = pruneKey(prunes);
  if (nextKey === state.persistedPruneKey) return;
  state.persistedPruneKey = nextKey;
  pi.appendEntry?.(PRUNE_STATE_ENTRY_TYPE, {
    version: PRUNE_STATE_VERSION,
    sessionId: state.sessionId,
    prunes,
  });
}

function loadPersistedPrunes(ctx: ExtensionContext, sessionId: string | undefined): Map<string, PersistedPruneEntry> {
  const manager = ctx.sessionManager as {
    getBranch?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
    getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
  } | undefined;
  const entries = manager?.getBranch?.() ?? manager?.getEntries?.() ?? [];
  const entry = entries.filter((candidate) => candidate.type === "custom" && candidate.customType === PRUNE_STATE_ENTRY_TYPE).pop();
  const data = entry?.data as {
    version?: unknown;
    sessionId?: unknown;
    toolCallIds?: unknown;
    spillPaths?: unknown;
    prunes?: unknown;
  } | undefined;
  if (!data || (sessionId && data.sessionId !== sessionId)) return new Map();
  if (data.version === PRUNE_STATE_VERSION && Array.isArray(data.prunes)) {
    const restored = new Map<string, PersistedPruneEntry>();
    for (const value of data.prunes) {
      if (!value || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      if (typeof record.callId !== "string" || !isPruneLevel(record.level)) continue;
      restored.set(record.callId, {
        callId: record.callId,
        level: record.level,
        ...(typeof record.spillPath === "string" ? { spillPath: record.spillPath } : {}),
        ...(typeof record.introducedAtUsageEpoch === "string" ? { introducedAtUsageEpoch: record.introducedAtUsageEpoch } : {}),
      });
    }
    return restored;
  }
  if ((data.version !== 1 && data.version !== 2) || !Array.isArray(data.toolCallIds)) return new Map();
  const spillPaths = new Map<string, string>();
  if (data.version === 2 && Array.isArray(data.spillPaths)) {
    for (const value of data.spillPaths) {
      if (!value || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      if (typeof record.callId === "string" && typeof record.path === "string") {
        spillPaths.set(record.callId, record.path);
      }
    }
  }
  return new Map(data.toolCallIds
    .filter((value): value is string => typeof value === "string")
    .map((callId) => {
      const spillPath = spillPaths.get(callId);
      return [callId, {
        callId,
        level: spillPath !== undefined ? "spill" : "pruned",
        ...(spillPath !== undefined ? { spillPath } : {}),
      }];
    }));
}

function sessionIdOf(ctx: ExtensionContext): string | undefined {
  const manager = ctx.sessionManager as { getSessionId?: () => string } | undefined;
  return manager?.getSessionId?.();
}

function pruneKey(entries: Iterable<PersistedPruneEntry>): string {
  return JSON.stringify([...entries]
    .map((entry) => [entry.callId, entry.level, entry.spillPath ?? null, entry.introducedAtUsageEpoch ?? null])
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

/**
 * Token estimates are pure functions of an immutable message object, and the
 * same array is estimate-scanned by up to five passes per request (context
 * estimate, frontier, both prune passes, telemetry). Keying the memo on object
 * identity is safe because prunes replace whole array elements — a message is
 * never mutated in place — so a replacement is a new object and misses
 * correctly.
 */
const messageTokenMemo = new WeakMap<object, number>();

function estimateMessageTokens(message: AgentMessage): number {
  const key = message as unknown as object;
  const memoized = messageTokenMemo.get(key);
  if (memoized !== undefined) return memoized;
  const serialized = JSON.stringify(message);
  const tokens = Math.ceil(serialized.length / tokenCharsPerToken(serialized));
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
  /** Suffix token sums of the pre-prune array; index i holds tokens[i..end]. */
  suffixTokens?: number[];
}

interface PruneCandidate {
  index: number;
  callId: string;
  replacement: AgentMessage;
  saved: number;
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
 * Deepest prune depth whose CUMULATIVE savings still justify the cached prefix
 * it invalidates, or 0 to prune nothing.
 *
 * Selection must look at the whole candidate run, not each candidate in
 * isolation: candidates are visited newest-first, and the first one always looks
 * worst because it already pays for the entire suffix while contributing only
 * its own savings. Measured on a uniform tool-loop transcript the ratio climbs
 * 0.12 -> 0.66 across 15 candidates, so a greedy per-candidate test would reject
 * the whole (profitable) run on its first element.
 */
export function cacheWorthwhileDepth(
  candidates: Array<{ index: number; saved: number }>,
  suffixTokens: number[],
  minRatio: number = CACHE_PRUNE_MIN_SAVINGS_RATIO,
): number {
  let cumulative = 0;
  let depth = 0;
  for (let position = 0; position < candidates.length; position++) {
    cumulative += candidates[position].saved;
    const invalidated = suffixTokens[candidates[position].index] ?? 0;
    if (invalidated <= 0) continue;
    if (cumulative >= invalidated * minRatio) depth = position + 1;
  }
  return depth;
}

function runPrunePass(input: PrunePassInput): { savedTokens: number; prunedToolResults: number; effectiveTokens: number } {
  const { transformed, pruneManifest, frontierStart, pruneTarget, usageEpoch, selector, suffixTokens } = input;
  let effectiveTokens = input.effectiveTokens;

  // Phase 1 — collect candidates newest-first without mutating anything. The
  // walk order is unchanged from the ungated path, so the candidate sequence is
  // identical; only how many of them get applied can differ.
  const candidates: PruneCandidate[] = [];
  let projectedTokens = effectiveTokens;
  for (let index = frontierStart - 1; index >= 0 && projectedTokens > pruneTarget; index--) {
    const callId = toolResultCallId(transformed[index]);
    if (!callId || hasRecordedPrune(pruneManifest, callId)) continue;
    const replacement = selector(transformed[index]);
    if (!replacement) continue;
    const before = estimateMessageTokens(transformed[index]);
    const after = estimateMessageTokens(replacement);
    if (after >= before) continue;
    const saved = before - after;
    candidates.push({ index, callId, replacement, saved });
    projectedTokens -= saved;
  }

  // Phase 2 — when the cache gate is active, trim the run to the deepest depth
  // that still pays for the prefix it invalidates. Without suffixTokens every
  // candidate is applied, which is byte-for-byte the historical behavior.
  const depth = suffixTokens ? cacheWorthwhileDepth(candidates, suffixTokens) : candidates.length;

  let savedTokens = 0;
  let prunedToolResults = 0;
  for (let position = 0; position < depth; position++) {
    const candidate = candidates[position];
    transformed[candidate.index] = candidate.replacement;
    recordPrune(pruneManifest, candidate.callId, {
      replacement: candidate.replacement,
      savedTokens: candidate.saved,
      introducedAtUsageEpoch: usageEpoch,
      level: "pruned",
    });
    savedTokens += candidate.saved;
    prunedToolResults++;
    effectiveTokens -= candidate.saved;
  }
  return { savedTokens, prunedToolResults, effectiveTokens };
}

function isProtectedToolResult(message: AgentMessage): boolean {
  const record = message as MessageRecord;
  if (record.role !== "toolResult") return false;
  if (record.isError === true) return true;
  if (typeof record.toolName === "string" && PROTECTED_TOOL_NAMES.has(record.toolName.toLowerCase())) return true;
  return extractTextContent(message).length < PROTECTED_THRESHOLD_CHARS;
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

function pruneToolResult(message: AgentMessage): AgentMessage | undefined {
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
    if (!callId) continue;
    const entry = pruneManifest.get(callId);
    if (!entry || entry.spillPath !== undefined) continue;
    const original = originalsByCallId.get(callId);
    if (!original) continue;
    const text = extractTextContent(original);
    if (text.length < SPILL_THRESHOLD_CHARS) continue;
    const toolName = typeof (original as MessageRecord).toolName === "string"
      ? (original as MessageRecord).toolName as string
      : "tool";
    const spill = await spillToolResult(sessionId, callId, text);
    if (!spill.ok) {
      // The write failed, so the payload is not recoverable from disk and the
      // no-path replacement text is a 1.5K preview — strictly worse than the
      // pruned placeholder already in place. Keep the placeholder and leave
      // spillPath unset so a later pass retries once the disk cooperates.
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
    entry.savedTokens = estimateMessageTokens(original) - estimateMessageTokens(upgraded);
    entry.level = "spill";
    callIds.add(callId);
  }
  return { tokenDelta, callIds };
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

function adjustPressureAfterReplacementChange(
  pressure: ContextPressureResult,
  tokenDelta: number,
  contextWindow: number,
  settings: CompactionSettings,
): ContextPressureResult {
  if (tokenDelta === 0) return pressure;
  const estimatedTokens = Math.max(0, pressure.estimatedTokens + tokenDelta);
  const soft = settings.soft ?? DEFAULT_SOFT_COMPACTION;
  const band = derivePressureBand({
    ratio: estimatedTokens / contextWindow,
    criticalRatio: pressure.thresholdTokens / contextWindow,
    prunedToolResults: pressure.prunedToolResults,
    soft,
  });
  return pressureResult({
    messages: pressure.messages,
    band,
    estimatedTokens,
    contextWindow,
    thresholdTokens: pressure.thresholdTokens,
    prunedToolResults: pressure.prunedToolResults,
    savedTokens: Math.max(0, pressure.savedTokens - tokenDelta),
    velocityTracker: pressure.velocityTracker,
    velocity: pressure.velocity,
  });
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

/**
 * Single-pass scan of the message array for the two token aggregates the
 * telemetry needs. Everything here depends only on the messages, never on the
 * current estimate, so the pressure-dependent ratios stay in
 * computeContextSignals.
 *
 * This used to be four separate full traversals (prunable classification,
 * redundancy counting, redundancy marking, redundant-token summing), each
 * re-running extractTextContent 2-3x per tool result — all of it to render a
 * status string. One pass plus a map walk produces identical numbers.
 */
function scanContextTokens(messages: AgentMessage[]): { prunableTokens: number; redundantTokens: number } {
  let prunableTokens = 0;
  const byPattern = new Map<string, number[]>();
  for (const message of messages) {
    const tokens = estimateMessageTokens(message);
    // pruneToolResult is replaceable ?? evictableBulk — one classification
    // instead of evaluating both selectors independently.
    if (pruneToolResult(message)) prunableTokens += tokens;
    if (!toolResultCallId(message)) continue;
    const key = toolResultPatternKey(message);
    if (!key) continue;
    const bucket = byPattern.get(key);
    if (bucket) bucket.push(tokens);
    else byPattern.set(key, [tokens]);
  }
  // Every occurrence of a repeated pattern except the newest is redundant.
  let redundantTokens = 0;
  for (const bucket of byPattern.values()) {
    for (let index = 0; index < bucket.length - 1; index++) redundantTokens += bucket[index];
  }
  return { prunableTokens, redundantTokens };
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
  const { prunableTokens, redundantTokens } = scanContextTokens(messages);
  const prunableFraction = estimatedTokens > 0 ? Math.min(1, prunableTokens / estimatedTokens) : 0;
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

/**
 * Prompt-cache hit ratio for one usage record.
 *
 * The denominator is every prompt token the provider billed: `input` (fresh,
 * uncached), `cacheRead` (hit) and `cacheWrite` (cache creation — a MISS that
 * had to be written). Omitting cacheWrite overstates the hit rate precisely on
 * the epoch after a prune, when the invalidated prefix is re-billed as cache
 * creation — i.e. it blinds the one metric meant to expose prune damage.
 * Matches the statusline and cockpit denominators.
 */
export function cacheHitRatio(usage: { input: number; cacheRead: number; cacheWrite: number }): number | undefined {
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  return promptTokens > 0 ? usage.cacheRead / promptTokens : undefined;
}

function latestCacheHitRatio(messages: AgentMessage[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = assistantUsage(messages[index]);
    if (!usage) continue;
    return cacheHitRatio(usage);
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

/**
 * Attribute cache-ratio movement to pruning.
 *
 * A prune's bill arrives one epoch late: it changes the request prefix now, and
 * the provider reports the resulting cache miss on the NEXT usage record. So
 * when a new epoch lands, if prunes were introduced during the epoch that just
 * closed, the ratio delta is exactly what that pruning cost (or saved). This is
 * the only longitudinal cache signal — the raw ratio alone cannot tell you
 * whether a prune helped.
 */
function observeCacheAttribution(state: AutoCompactionState, messages: AgentMessage[], newPrunes: number): void {
  const epoch = latestProviderUsageEpoch(messages);
  const ratio = latestCacheHitRatio(messages);
  if (epoch !== state.cacheEpoch) {
    state.cacheDelta = state.prunedDuringEpoch !== undefined
      && state.prunedDuringEpoch === state.cacheEpoch
      && state.cacheRatio !== undefined
      && ratio !== undefined
      ? ratio - state.cacheRatio
      : undefined;
    state.cacheEpoch = epoch;
    state.cacheRatio = ratio;
    state.prunedDuringEpoch = undefined;
  }
  if (newPrunes > 0) state.prunedDuringEpoch = epoch;
}

function updatePressureStatus(ctx: ExtensionContext, pressure: ContextPressureResult, cacheDelta?: number): void {
  if (pressure.band === "normal") {
    clearPressureStatus(ctx);
    return;
  }
  // Show what pruning actually reclaimed, not just how many results it touched.
  const pruned = pressure.prunedToolResults > 0
    ? ` -${pressure.prunedToolResults}${pressure.savedTokens > 0 ? `/-${formatTokens(pressure.savedTokens)}` : ""}`
    : "";
  const attribution = cacheDelta !== undefined && Math.abs(cacheDelta) >= 0.01
    ? [`cacheD:${cacheDelta > 0 ? "+" : ""}${Math.round(cacheDelta * 100)}%`]
    : [];
  const allReasons = [...pressure.reasons, ...attribution];
  const reasons = allReasons.length > 0 ? ` ${allReasons.join(" ")}` : "";
  ctx.ui.setStatus(
    COMPACTION_STATUS_KEY,
    `CTX ${pressure.band.toUpperCase()} ${pressure.estimatedTokens}/${pressure.thresholdTokens}${pruned}${reasons}`,
  );
}

function formatTokens(tokens: number): string {
  return tokens < 1_000 ? String(tokens) : `${(tokens / 1_000).toFixed(1)}k`;
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
  usage: { percent: number | null; tokens: number | null; contextWindow: number },
  reserveTokens: number,
): string {
  // Both figures are nullable on ContextUsage; percent used to be typed as a
  // plain number here, which rendered "NaN%" whenever it was actually null.
  const percent = usage.percent === null ? "unknown" : `${Math.round(usage.percent)}%`;
  return [
    "This compaction was triggered because the previous assistant response was truncated at the model output token limit while context pressure was high.",
    "Preserve the exact current objective, completed work, modified files, and the interrupted response's intent so execution can resume and complete the truncated output immediately.",
    `Context usage: ${usage.tokens ?? "unknown"}/${usage.contextWindow} tokens (${percent}); reserve: ${reserveTokens}.`,
  ].join("\n");
}

function buildMidTurnInstructions(estimate: ContextEstimate, contextWindow: number, reserveTokens: number): string {
  return [
    "This compaction was triggered at a completed tool-result checkpoint inside an active agent turn.",
    "Preserve the exact current objective, completed tool results, pending tool work, modified files, and the next action so execution can resume immediately.",
    `Estimated context: ${estimate.tokens}/${contextWindow} tokens; reserve: ${reserveTokens}; trailing since last usage: ${estimate.trailingTokens}.`,
  ].join("\n");
}
