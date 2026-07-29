/**
 * Neutral derivation of the proactive compaction trigger from model limits and
 * soft pressure settings. Pure and dependency-free: the stateful runtime policy
 * consumes effectiveReserveTokens here, and UI/telemetry can render the full
 * derivation without importing the auto-compaction module.
 */

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
 * - the configured reserve (the user's compaction ceiling), used as the initial floor;
 * - a ratio of the context window, so large windows still keep output room;
 * - the model's maximum single-response output, so the trigger never sits closer
 *   to the limit than one full response and a max-size response cannot truncate
 *   against the context window.
 * The max-output term is capped below the window so compaction always retains a
 * usable recent context and never disables itself.
 */
export function effectiveReserveTokens(
  settings: { reserveTokens: number },
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

/** Which input settled the effective reserve. */
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

export interface CompactionThresholdInput {
  reserveTokens: number;
  contextWindow: number | undefined;
  modelMaxTokens?: number;
  soft?: { nudgeRatio: number; pruneRatio: number; pruneTargetRatio: number };
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
  let reason: CompactionThresholdReason;
  if (typeof input.modelMaxTokens === "number" && input.modelMaxTokens > Math.max(configuredReserveTokens, ratioFloorTokens)) {
    reason = effective >= contextWindow - ratioFloorTokens ? "max-output-capped" : "max-output";
  } else {
    reason = ratioFloorTokens > configuredReserveTokens ? "ratio-floor" : "configured";
  }
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
    derivation.soft = {
      nudgeTokens,
      pruneTokens,
      pruneTargetTokens,
      nudgeReachable: nudgeTokens <= thresholdTokens,
      pruneReachable: pruneTokens <= thresholdTokens,
      pruneTargetReachable: pruneTargetTokens < thresholdTokens,
    };
  }
  return derivation;
}
