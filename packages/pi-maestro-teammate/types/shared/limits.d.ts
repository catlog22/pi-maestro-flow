/**
 * Shared runtime limits.
 *
 * These constants are consumed by both the extension host and the TUI layer.
 * The TUI cannot import `extension/index.ts` (that would pull the whole
 * extension into a render-only module), so any threshold that both sides must
 * agree on lives here as the single source of truth.
 */
/**
 * An agent that has reported no activity for this long is displayed as
 * `stalled`. Used by the status widget, the progress card, the attach overlay
 * and `teammate-wait`; they must never disagree.
 */
export declare const TEAMMATE_STALL_TIMEOUT_MS = 30000;
/**
 * Model, startup, restore and compaction phases can legitimately emit no child
 * events for much longer than a tool heartbeat interval. Give those phases a
 * bounded confirmation window instead of treating the first 30s of silence as
 * a stall. Tool execution keeps the shorter limit because it has a 10s
 * heartbeat and therefore only goes quiet when that heartbeat is actually lost.
 */
export declare const TEAMMATE_EXPECTED_SILENCE_TIMEOUT_MS: number;
