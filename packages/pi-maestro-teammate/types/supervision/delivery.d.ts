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
export declare function normalizeDeliveryMessage(message: string): string;
export declare class DeliveryGate {
    private readonly cooldownMs;
    private readonly dedup;
    private readonly phraseFilter;
    private readonly perWindowLimit;
    private readonly downgradeAfter;
    private readonly lastDeliveryAt;
    private readonly dedupeHistory;
    private readonly dedupeOrder;
    private readonly windowCounts;
    /** Per-target remaining downgrade windows after an interrupt delivery. */
    private readonly downgradeBudget;
    constructor(options?: DeliveryOptions);
    /**
     * Evaluate and record a candidate delivery. Returns the mode to use, or
     * undefined when the delivery must be suppressed. Suppression is invisible
     * to the caller — identical to the advisor emission guard contract.
     */
    gate(target: string, message: string, requested: DeliveryMode): DeliveryMode | undefined;
    /** Marks the start of a new evaluation window (tick / turn). */
    beginWindow(): void;
    /** Clears dedupe history, cooldown and downgrade state (compaction / session switch). */
    reset(): void;
}
