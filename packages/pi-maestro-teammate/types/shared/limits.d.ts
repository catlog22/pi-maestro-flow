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
