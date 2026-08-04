/**
 * Unified delivery gate: cooldown, normalized dedupe, phrase filtering,
 * per-window limit, and interrupt downgrade (immuneTurns semantics).
 *
 * Pure state machine — no host dependency; unit-testable. Shared by the
 * fleet Monitor engine (per-target cooldown + dedupe) and the future
 * turn-level Advisor (global emission guard + immuneTurns).
 *
 * Suppression contract: a suppressed call registers nothing (cooldown,
 * window count, dedupe history) — identical to the advisor emission guard,
 * where a noise call never displaces a real concern that follows.
 */

const DEFAULT_PHRASE_FILTER = [
  "stop",
  "done",
  "complete",
  "no issue continue",
  "lgtm",
  "nothing to add",
  "no further input",
] as const;

export type DeliveryMode = "interrupt" | "batch" | "notify";

export interface DeliveryDedupOptions {
  /** FIFO ring capacity. Default 4096. */
  capacity?: number;
  /**
   * Dedupe scope: "global" = session-wide content dedupe (advisor
   * emission-guard semantics); "target" = per-target content dedupe
   * (monitor semantics: the same correction may go to different agents).
   * Default "global".
   */
  scope?: "global" | "target";
  /** Message normalizer; default is normalizeDeliveryMessage. */
  normalize?: (message: string) => string;
}

export interface DeliveryOptions {
  /** Minimum interval between two deliveries to the same target. Default 60_000. */
  cooldownMs?: number;
  /** Content dedupe; pass false to disable. */
  dedup?: false | DeliveryDedupOptions;
  /** Phrase filter; default builtin list, pass false to disable. */
  phraseFilter?: readonly string[] | false;
  /** Max deliveries per target per evaluation window. Default 1. */
  perWindowLimit?: number;
  /** After an interrupt delivery, downgrade the next N windows' interrupts to batch. Default 3. */
  downgradeAfter?: number;
}

export function normalizeDeliveryMessage(message: string): string {
  return message
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export class DeliveryGate {
  private readonly cooldownMs: number;
  private readonly dedup: DeliveryDedupOptions | undefined;
  private readonly phraseFilter: readonly string[] | false;
  private readonly perWindowLimit: number;
  private readonly downgradeAfter: number;

  private readonly lastDeliveryAt = new Map<string, number>();
  private readonly dedupeHistory = new Set<string>();
  private readonly dedupeOrder: string[] = [];
  private readonly windowCounts = new Map<string, number>();
  /** Per-target remaining downgrade windows after an interrupt delivery. */
  private readonly downgradeBudget = new Map<string, number>();

  constructor(options: DeliveryOptions = {}) {
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.dedup = options.dedup === false ? undefined : options.dedup ?? { capacity: 4096, scope: "global" };
    this.phraseFilter = options.phraseFilter === false ? false : options.phraseFilter ?? DEFAULT_PHRASE_FILTER;
    this.perWindowLimit = options.perWindowLimit ?? 1;
    this.downgradeAfter = options.downgradeAfter ?? 3;
  }

  /**
   * Evaluate and record a candidate delivery. Returns the mode to use, or
   * undefined when the delivery must be suppressed. Suppression is invisible
   * to the caller — identical to the advisor emission guard contract.
   */
  gate(target: string, message: string, requested: DeliveryMode): DeliveryMode | undefined {
    if (this.phraseFilter && this.phraseFilter.includes(normalizeDeliveryMessage(message))) {
      return undefined;
    }

    const now = Date.now();
    const last = this.lastDeliveryAt.get(target);
    if (last !== undefined && now - last < this.cooldownMs) {
      return undefined;
    }

    const windowCount = this.windowCounts.get(target) ?? 0;
    if (windowCount >= this.perWindowLimit) {
      return undefined;
    }

    let dedupeKey: string | undefined;
    if (this.dedup) {
      const normalized = (this.dedup.normalize ?? normalizeDeliveryMessage)(message);
      dedupeKey = this.dedup.scope === "target" ? `${target}\u0000${normalized}` : normalized;
      if (this.dedupeHistory.has(dedupeKey)) {
        return undefined;
      }
    }

    // Accept: register cooldown, window count, dedupe history, delivery mode.
    this.windowCounts.set(target, windowCount + 1);
    this.lastDeliveryAt.set(target, now);
    if (dedupeKey !== undefined) {
      this.dedupeHistory.add(dedupeKey);
      this.dedupeOrder.push(dedupeKey);
      const capacity = this.dedup?.capacity ?? 4096;
      if (this.dedupeOrder.length > capacity) {
        const evicted = this.dedupeOrder.shift();
        if (evicted !== undefined) this.dedupeHistory.delete(evicted);
      }
    }

    let mode = requested;
    if (requested === "interrupt") {
      const budget = this.downgradeBudget.get(target) ?? 0;
      if (budget > 0) {
        mode = "batch";
        this.downgradeBudget.set(target, budget - 1);
      } else {
        this.downgradeBudget.set(target, this.downgradeAfter);
      }
    }
    return mode;
  }

  /** Marks the start of a new evaluation window (tick / turn). */
  beginWindow(): void {
    this.windowCounts.clear();
  }

  /** Clears dedupe history, cooldown and downgrade state (compaction / session switch). */
  reset(): void {
    this.lastDeliveryAt.clear();
    this.dedupeHistory.clear();
    this.dedupeOrder.length = 0;
    this.windowCounts.clear();
    this.downgradeBudget.clear();
  }
}
