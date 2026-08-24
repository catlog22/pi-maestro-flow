/**
 * Extension-side wiring for the centralized diagnostic logger.
 *
 * Binds the logger's UI bridge to the live `ctx.ui` on every session_start so
 * the status-bar badge (`pi-teammate-diagnostic`) and one-shot error toasts
 * fire without each of the 67 call sites holding a UI reference. Also registers
 * the `/teammate-logs` slash command for acknowledging unread errors and
 * surfacing the log file path.
 *
 * Kept separate from `shared/diagnostic-log.ts` so the shared module stays a
 * pure, testable sink with no Pi-extension import surface.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
/**
 * Bridge the live `ctx.ui` to the diagnostic logger. Call on `session_start`
 * (and any ctx refresh boundary). Safe to call repeatedly; the latest ctx
 * wins. When `ctx` is undefined the bridge is cleared (e.g. on shutdown).
 */
export declare function bindDiagnosticUi(ctx: ExtensionContext | undefined): void;
/**
 * Register the `/teammate-logs` slash command.
 *
 * - `/teammate-logs`           — show summary + log file path
 * - `/teammate-logs ack`       — acknowledge unread errors (clears the badge)
 * - `/teammate-logs status`    — show current summary
 */
export declare function registerDiagnosticCommand(pi: ExtensionAPI): void;
