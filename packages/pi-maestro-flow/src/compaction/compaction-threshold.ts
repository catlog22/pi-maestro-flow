/**
 * Neutral derivation of the proactive compaction trigger from model limits and
 * soft pressure settings. Pure and dependency-free: the stateful runtime policy
 * consumes effectiveReserveTokens here, and UI/telemetry can render the full
 * derivation without importing the auto-compaction module.
 */

/**
 * Minimum context-window fraction kept free when the configured reserve is
 * smaller. Pi dynamically clamps each request's output limit to the remaining
 * context capacity, so the model's maximum output is not reserved in full.
 * Five percent still leaves meaningful room for a response and estimator drift
 * without forcing large-window models to compact far before capacity.
 */
export const MIN_RESERVE_RATIO = 0.05;
export const SUMMARY_OUTPUT_RATIO = 0.8;

/**
 * Safety tokens Pi subtracts from the remaining context when it clamps each
 * request's output budget (pi-ai CONTEXT_SAFETY_TOKENS). Below the truncation
 * point the model can no longer emit its full maxTokens in one response.
 */
export const OUTPUT_CLAMP_SAFETY_TOKENS = 4096;

/**
 * Prune-target margin below the truncation point when the output budget binds:
 * pruning reclaims enough that a full-size response fits again, not just enough
 * to sit exactly at the clamp boundary.
 */
export const OUTPUT_CLAMP_BAND_MARGIN_RATIO = 0.03;

/** Output budget used by the checkpoint summarizer. */
export function summaryOutputTokenLimit(reserveTokens: number, modelMaxTokens?: number): number {
  const configuredLimit = Math.max(1, Math.floor(reserveTokens * SUMMARY_OUTPUT_RATIO));
  return typeof modelMaxTokens === "number" && modelMaxTokens > 0
    ? Math.min(configuredLimit, modelMaxTokens)
    : configuredLimit;
}

/**
 * Derive the reserve that drives the proactive compaction trigger from the
 * configured reserve and a modest context-window floor. modelMaxTokens remains
 * in the public signature for compatibility, but it is an upper bound rather
 * than capacity consumed by every response; Pi shrinks it dynamically against
 * the request's actual remaining context.
 */
export function effectiveReserveTokens(
  settings: { reserveTokens: number },
  contextWindow: number,
  _modelMaxTokens?: number,
): number {
  const ratioFloor = Math.floor(contextWindow * MIN_RESERVE_RATIO);
  return Math.max(settings.reserveTokens, ratioFloor);
}

/** Which input settled the effective reserve. Legacy max-output values remain for telemetry compatibility. */
export type CompactionThresholdReason =
  | "configured"
  | "ratio-floor"
  | "max-output"
  | "max-output-capped";

/** Soft pressure boundaries derived against the same window. */
export interface SoftThresholdDerivation {
  nudgeTokens: number;
  pruneTokens: number;
  /** Mirrors the runtime target: min(threshold, floor(window * pruneTargetRatio)). */
  pruneTargetTokens: number;
  /** False when the strict compaction trigger fires before nudge can. */
  nudgeReachable: boolean;
  /** False when the strict compaction trigger fires before pruning can. */
  pruneReachable: boolean;
  /** False when the prune target sits at or above the compaction trigger. */
  pruneTargetReachable: boolean;
  /**
   * Input fullness where Pi clamps the request's output budget below the model
   * maxTokens: window - maxTokens - safety. Undefined when the output ceiling
   * is unknown or cannot bind (e.g. maxTokens >= window).
   */
  truncationPointTokens?: number;
  /** True when the output budget binds before the strict compaction trigger. */
  outputConstrained: boolean;
}

/** Degraded state when no usable context window exists. */
export interface UnusableContextThreshold {
  usable: false;
  problem: "missing-context-window" | "invalid-context-window";
  configuredReserveTokens: number;
}

export interface CompactionThresholdDerivation {
  usable: true;
  contextWindow: number;
  configuredReserveTokens: number;
  ratioFloorTokens: number;
  effectiveReserveTokens: number;
  thresholdTokens: number;
  reason: CompactionThresholdReason;
  reservePercent: number;
  thresholdPercent: number;
  /**
   * Trigger-semantics metadata: compaction fires only when the estimate
   * STRICTLY exceeds thresholdTokens; an estimate exactly at the threshold
   * never triggers.
   */
  trigger: "strictly-above-threshold";
  soft?: SoftThresholdDerivation;
}

export type CompactionThresholdModel = UnusableContextThreshold | CompactionThresholdDerivation;

export type CompactionThresholdLimiter = "session" | "compaction";

export type LinkedCompactionThresholdModel = CompactionThresholdModel & {
  limiter: CompactionThresholdLimiter;
};

export interface CompactionThresholdInput {
  reserveTokens: number;
  contextWindow: number | undefined;
  modelMaxTokens?: number;
  soft?: { nudgeRatio: number; pruneRatio: number; pruneTargetRatio: number };
}

export interface LinkedCompactionThresholdInput {
  reserveTokens: number;
  sessionContextWindow: number | undefined;
  sessionMaxTokens?: number;
  compactionContextWindow?: number;
  compactionMaxTokens?: number;
  soft?: CompactionThresholdInput["soft"];
}

/**
 * Full, display-ready derivation of the compaction trigger. effectiveReserveTokens
 * stays the single source of the reserve; this adds the reason it settled there,
 * the soft-band boundaries, and their reachability under the strict trigger.
 */
export function deriveCompactionThreshold(input: CompactionThresholdInput): CompactionThresholdModel {
  const configuredReserveTokens = input.reserveTokens;
  const contextWindow = input.contextWindow;
  if (contextWindow === undefined) {
    return { usable: false, problem: "missing-context-window", configuredReserveTokens };
  }
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { usable: false, problem: "invalid-context-window", configuredReserveTokens };
  }
  const ratioFloorTokens = Math.floor(contextWindow * MIN_RESERVE_RATIO);
  const effective = effectiveReserveTokens({ reserveTokens: configuredReserveTokens }, contextWindow, input.modelMaxTokens);
  const thresholdTokens = contextWindow - effective;
  const reason: CompactionThresholdReason = ratioFloorTokens > configuredReserveTokens
    ? "ratio-floor"
    : "configured";
  const derivation: CompactionThresholdDerivation = {
    usable: true,
    contextWindow,
    configuredReserveTokens,
    ratioFloorTokens,
    effectiveReserveTokens: effective,
    thresholdTokens,
    reason,
    reservePercent: Math.round((effective / contextWindow) * 100),
    thresholdPercent: Math.round((thresholdTokens / contextWindow) * 100),
    trigger: "strictly-above-threshold",
  };
  if (input.soft) {
    const nudgeTokens = Math.ceil(contextWindow * input.soft.nudgeRatio);
    const pruneTokens = Math.ceil(contextWindow * input.soft.pruneRatio);
    const pruneTargetTokens = Math.min(thresholdTokens, Math.floor(contextWindow * input.soft.pruneTargetRatio));
    let truncationPointTokens: number | undefined;
    if (typeof input.modelMaxTokens === "number" && input.modelMaxTokens > 0) {
      const candidate = contextWindow - input.modelMaxTokens - OUTPUT_CLAMP_SAFETY_TOKENS;
      if (candidate > 0) truncationPointTokens = candidate;
    }
    const outputConstrained = truncationPointTokens !== undefined
      && truncationPointTokens < thresholdTokens;
    let effectiveNudge = nudgeTokens;
    let effectivePrune = pruneTokens;
    let effectivePruneTarget = pruneTargetTokens;
    if (outputConstrained && truncationPointTokens !== undefined) {
      // The output budget binds before the window ratio bands: pull the soft
      // bands down to the truncation point so pruning starts before responses
      // can be clamped, and target a reclaim depth that restores full output
      // headroom. The band ordering nudge < prune and the prune-target gap are
      // preserved so the runtime loops still behave.
      effectivePrune = Math.min(pruneTokens, truncationPointTokens);
      effectivePruneTarget = Math.min(
        pruneTargetTokens,
        Math.max(0, truncationPointTokens - Math.floor(contextWindow * OUTPUT_CLAMP_BAND_MARGIN_RATIO)),
      );
      effectiveNudge = Math.min(
        nudgeTokens,
        Math.max(0, effectivePrune - Math.ceil(contextWindow * 0.02)),
      );
    }
    derivation.soft = {
      nudgeTokens: effectiveNudge,
      pruneTokens: effectivePrune,
      pruneTargetTokens: effectivePruneTarget,
      nudgeReachable: effectiveNudge <= thresholdTokens,
      pruneReachable: effectivePrune <= thresholdTokens,
      pruneTargetReachable: effectivePruneTarget < thresholdTokens,
      truncationPointTokens,
      outputConstrained,
    };
  }
  return derivation;
}

/**
 * Select the earliest safe trigger required by either the active session model
 * or the configured summary model. Output ceilings do not move the trigger:
 * both Pi and the summary path fit the actual output budget to remaining
 * capacity before dispatch.
 */
export function deriveLinkedCompactionThreshold(
  input: LinkedCompactionThresholdInput,
): LinkedCompactionThresholdModel {
  const session = deriveCompactionThreshold({
    reserveTokens: input.reserveTokens,
    contextWindow: input.sessionContextWindow,
    modelMaxTokens: input.sessionMaxTokens,
    soft: input.soft,
  });
  if (!session.usable || input.compactionContextWindow === undefined
    || input.compactionContextWindow <= input.reserveTokens) {
    return { ...session, limiter: "session" };
  }

  const compaction = deriveCompactionThreshold({
    reserveTokens: input.reserveTokens,
    contextWindow: input.compactionContextWindow,
    modelMaxTokens: summaryOutputTokenLimit(input.reserveTokens, input.compactionMaxTokens),
    soft: input.soft,
  });
  if (compaction.usable && compaction.thresholdTokens < session.thresholdTokens) {
    return { ...compaction, limiter: "compaction" };
  }
  return { ...session, limiter: "session" };
}
