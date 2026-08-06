// Extracted from auto-compaction.ts — redundancy, pressure, telemetry, breaker, velocity, cache, introspection.
import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SOFT_COMPACTION,
  type SoftCompactionSettings,
} from "./compaction-settings.ts";
import type { CompactionTrigger } from "./compaction-arbiter.ts";
import type { CompactionThresholdDerivation } from "./compaction-threshold.ts";
import {
  autoCompactionIdleStatus,
  COMPACTION_MODE_STATUS_KEY,
  COMPACTION_STATUS_KEY,
  formatCompactionStatus,
} from "./maestro-compaction.ts";
import {
  type AutoCompactionState,
  type ContextEstimate,
  type ContextPressureBand,
  type ContextAction,
  type ContextDecision,
  type ContextSignals,
  type ContextPressureResult,
  type SoftPressureBands,
  type VelocitySample,
  type VelocityTracker,
  type VelocityInfo,
  type MessageRecord,
  type CompactionSettings,
  estimateMessageTokens,
  pruneToolResult,
  assistantUsage,
  latestProviderUsageEpoch,
} from "./auto-compaction.ts";

export const REDUNDANCY_PATTERN_PREFIX_CHARS = 120;

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
 * Groups tool results by content pattern in one pass, oldest occurrence first.
 *
 * Sole definition of the redundancy rule: for any pattern occurring more than
 * once, every occurrence except the LAST entry of its bucket is redundant. Both
 * consumers below derive from this so the rule cannot drift between them.
 */
export function bucketByPattern(messages: AgentMessage[]): Map<string, Array<{ callId: string; tokens: number }>> {
  const byPattern = new Map<string, Array<{ callId: string; tokens: number }>>();
  for (const message of messages) {
    const callId = toolResultCallId(message);
    if (!callId) continue;
    const key = toolResultPatternKey(message);
    if (!key) continue;
    const entry = { callId, tokens: estimateMessageTokens(message) };
    const bucket = byPattern.get(key);
    if (bucket) bucket.push(entry);
    else byPattern.set(key, [entry]);
  }
  return byPattern;
}

/**
 * Call ids of stale duplicate tool results. Prune ordering stays latest-first
 * for cache-prefix retention; this signal is telemetry and a hook for future
 * importance-aware eviction, and must never drive prune order.
 */
export function redundantToolResultCallIds(messages: AgentMessage[]): Set<string> {
  const redundant = new Set<string>();
  for (const bucket of bucketByPattern(messages).values()) {
    for (let index = 0; index < bucket.length - 1; index++) redundant.add(bucket[index].callId);
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

export function pressureResult(input: PressureResultInput): ContextPressureResult {
  const { messages, band, estimatedTokens, contextWindow, thresholdTokens, prunedToolResults, savedTokens, velocityTracker, velocity } = input;
  // The common low-pressure path skips the telemetry scan entirely.
  const decision: ContextDecision = band === "normal"
    ? { band, action: "none", reasons: [] }
    : decideContextAction(band, computeContextSignals({ messages, estimatedTokens, contextWindow, thresholdTokens }));
  const reasons = [...decision.reasons];
  if (band === "critical" && prunedToolResults > 0) {
    reasons.push("prune-insufficient");
  }
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

export function adjustPressureAfterReplacementChange(
  pressure: ContextPressureResult,
  tokenDelta: number,
  contextWindow: number,
  settings: CompactionSettings,
  softBands?: SoftPressureBands,
): ContextPressureResult {
  if (tokenDelta === 0) return pressure;
  const estimatedTokens = Math.max(0, pressure.estimatedTokens + tokenDelta);
  const soft = settings.soft ?? DEFAULT_SOFT_COMPACTION;
  const band = derivePressureBand({
    ratio: estimatedTokens / contextWindow,
    criticalRatio: pressure.thresholdTokens / contextWindow,
    prunedToolResults: pressure.prunedToolResults,
    soft,
    softBands: softBands !== undefined
      ? {
          nudgeRatio: softBands.nudgeTokens / contextWindow,
          pruneRatio: softBands.pruneTokens / contextWindow,
        }
      : undefined,
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
  softBands?: { nudgeRatio: number; pruneRatio: number };
}): ContextPressureBand {
  const { ratio, criticalRatio, prunedToolResults, soft } = input;
  const pruneRatio = input.softBands?.pruneRatio ?? soft.pruneRatio;
  const nudgeRatio = input.softBands?.nudgeRatio ?? soft.nudgeRatio;
  if (ratio > criticalRatio) return "critical";
  if (prunedToolResults > 0) return "auto-prune";
  if (ratio >= pruneRatio) return "auto-prune";
  if (ratio >= nudgeRatio) return "nudge";
  return "normal";
}

/**
 * The two token aggregates the telemetry needs. Everything here depends only on
 * the messages, never on the current estimate, so the pressure-dependent ratios
 * stay in computeContextSignals.
 *
 * This used to be four separate full traversals (prunable classification,
 * redundancy counting, redundancy marking, redundant-token summing), each
 * re-running extractTextContent 2-3x per tool result — all of it to render a
 * status string. Now two traversals that share one memoized token estimate.
 *
 * Deliberately NOT folded into a single loop: that would inline the redundancy
 * rule here and leave redundantToolResultCallIds as a second, drifting copy of
 * it. With estimateMessageTokens memoized the extra walk costs a pointer chase,
 * not a re-serialization — the expensive part H5 removed is already gone.
 */
export function scanContextTokens(messages: AgentMessage[]): { prunableTokens: number; redundantTokens: number } {
  let prunableTokens = 0;
  for (const message of messages) {
    // pruneToolResult is replaceable ?? evictableBulk — one classification
    // instead of evaluating both selectors independently.
    if (pruneToolResult(message)) prunableTokens += estimateMessageTokens(message);
  }
  let redundantTokens = 0;
  for (const bucket of bucketByPattern(messages).values()) {
    for (let index = 0; index < bucket.length - 1; index++) redundantTokens += bucket[index].tokens;
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

export function latestCacheHitRatio(messages: AgentMessage[]): number | undefined {
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
  options: { transient?: boolean } = {},
): CompactionBreakerState {
  // Transient provider/gateway failures (502 upstream_error, network drops)
  // neither advance nor reset the streak: the summary path already retries
  // them internally, and letting them trip the breaker would pause compaction
  // for exactly the high-pressure turns that need it.
  if (options.transient) return breaker;
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

/** Remaining cooldown turns while the breaker is open, or undefined when allowed. */
export function compactionBreakerCooldownRemaining(
  breaker: CompactionBreakerState,
  turnCount: number,
): number | undefined {
  if (breaker.trippedAtTurn === undefined) return undefined;
  const remaining = COMPACTION_BREAKER_COOLDOWN_TURNS - (turnCount - breaker.trippedAtTurn);
  return remaining > 0 ? remaining : undefined;
}

/**
 * Human-readable pause explanation while the breaker is open, so cancel paths
 * can tell the user why compaction is being deferred. Undefined when allowed.
 */
export function describeCompactionBreakerPause(
  breaker: CompactionBreakerState,
  turnCount: number,
): string | undefined {
  const remaining = compactionBreakerCooldownRemaining(breaker, turnCount);
  if (remaining === undefined) return undefined;
  const turns = remaining === 1 ? "1 completed turn" : `${remaining} completed turns`;
  return `the compaction circuit breaker is cooling down after ${breaker.consecutiveFailures} consecutive failures; it retries after ${turns}`;
}

export const VELOCITY_SAMPLE_CAP = 4;
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

export function medianSlope(samples: VelocitySample[]): number | undefined {
  if (samples.length < 3) return undefined;
  const diffs: number[] = [];
  for (let index = 1; index < samples.length; index++) {
    diffs.push(samples[index].tokens - samples[index - 1].tokens);
  }
  const sorted = [...diffs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function hasRobustGrowth(samples: VelocitySample[]): boolean {
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
export function observeCacheAttribution(state: AutoCompactionState, messages: AgentMessage[], newPrunes: number): void {
  const epoch = latestProviderUsageEpoch(messages);
  const ratio = latestCacheHitRatio(messages);
  if (epoch !== state.cacheEpoch) {
    const attributedDelta = state.prunedDuringEpoch !== undefined
      && state.prunedDuringEpoch === state.cacheEpoch
      && state.cacheRatio !== undefined
      && ratio !== undefined
      ? ratio - state.cacheRatio
      : undefined;
    // Keep a real attribution pending until the next pressure-status update.
    // Unrelated epochs must not overwrite it before it can be displayed.
    if (attributedDelta !== undefined) state.cacheDelta = attributedDelta;
    state.cacheEpoch = epoch;
    state.cacheRatio = ratio;
    state.prunedDuringEpoch = undefined;
  }
  if (newPrunes > 0) state.prunedDuringEpoch = epoch;
}

export function updatePressureStatus(ctx: ExtensionContext, pressure: ContextPressureResult, cacheDelta?: number): void {
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

export function formatTokens(tokens: number): string {
  return tokens < 1_000 ? String(tokens) : `${(tokens / 1_000).toFixed(1)}k`;
}

export function publishIdleStatus(ctx: ExtensionContext, enabled: boolean): void {
  ctx.ui.setStatus(COMPACTION_MODE_STATUS_KEY, autoCompactionIdleStatus(enabled));
}

export function clearPressureStatus(ctx: ExtensionContext): void {
  ctx.ui.setStatus(COMPACTION_STATUS_KEY, undefined);
}

export function roleOf(message: AgentMessage | undefined): string | undefined {
  return (message as MessageRecord | undefined)?.role as string | undefined;
}

export function assistantToolCallIds(message: AgentMessage): string[] | undefined {
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

export function toolResultCallId(message: AgentMessage): string | undefined {
  const record = message as MessageRecord;
  return record.role === "toolResult" && typeof record.toolCallId === "string" ? record.toolCallId : undefined;
}

export function finalAssistantStopReason(messages: AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const record = messages[index] as MessageRecord;
    if (record.role !== "assistant") continue;
    return typeof record.stopReason === "string" ? record.stopReason : undefined;
  }
  return undefined;
}

export function shouldPreserveCompletedTurn(
  messages: AgentMessage[],
  hasPendingMessages: boolean,
): boolean {
  return finalAssistantStopReason(messages) === "stop" && !hasPendingMessages;
}

export function shouldCancelCompletedTurnThreshold(
  reason: string | undefined,
  preserveCompletedTurn: boolean,
  hasOwnedRequest: boolean,
  hasPendingMessages = false,
  isRecoveryFallback = false,
  hasTakeoverIntent = false,
): boolean {
  // The cancel is only safe when the extension actually takes over: without a
  // pending compaction intent (e.g. pressure mechanism disabled, linked
  // threshold unusable, or estimate below the extension threshold) cancelling
  // the native threshold compaction would leave nothing compacting until
  // overflow recovery.
  return reason === "threshold"
    && preserveCompletedTurn
    && !hasOwnedRequest
    && !hasPendingMessages
    && !isRecoveryFallback
    && hasTakeoverIntent;
}

export function buildOutputLimitInstructions(
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

/**
 * Durable mid-turn trigger metadata derived from the same threshold model that
 * drives the trigger itself, so the recorded effective threshold and reason can
 * never drift from what actually fired. Undefined only when the context window
 * is unusable, in which case no honest trigger can be recorded.
 */
export function buildMidTurnTrigger(input: {
  estimatedTokens: number;
  threshold: CompactionThresholdDerivation;
  configuredReserveTokens: number;
  recovery?: "provider-pressure";
}): CompactionTrigger {
  const derivation = input.threshold;
  return {
    owner: "mid-turn",
    ...(input.recovery ? { recovery: input.recovery } : {}),
    estimatedTokens: input.estimatedTokens,
    contextWindow: derivation.contextWindow,
    effectiveThresholdTokens: derivation.thresholdTokens,
    configuredThresholdTokens: derivation.contextWindow - derivation.configuredReserveTokens,
    effectiveReserveTokens: derivation.effectiveReserveTokens,
    configuredReserveTokens: derivation.configuredReserveTokens,
    reason: derivation.reason,
  };
}

export function buildMidTurnInstructions(estimate: ContextEstimate, contextWindow: number, reserveTokens: number): string {
  return [
    "This compaction was triggered at a completed tool-result checkpoint inside an active agent turn.",
    "Preserve the exact current objective, completed tool results, pending tool work, modified files, and the next action so execution can resume immediately.",
    `Estimated context: ${estimate.tokens}/${contextWindow} tokens; reserve: ${reserveTokens}; trailing since last usage: ${estimate.trailingTokens}.`,
  ].join("\n");
}

