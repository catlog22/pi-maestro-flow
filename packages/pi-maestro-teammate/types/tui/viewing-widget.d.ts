/**
 * Main-TUI viewing mode for a teammate session (claude-code style).
 *
 * Pure rendering + input-routing decisions, no extension context — kept
 * dependency-free so the widget and the input hook share one testable core.
 * The extension wires these into a belowEditor widget and a pi.on("input")
 * hook; switching only touches UI state, never the agent's task, so a running
 * agent (main loop or sub-process) is unaffected by entering/leaving the view.
 */
import type { TranscriptRow } from "../shared/transcript.ts";
export interface ViewingWidgetState {
    agentName?: string;
    agentRole: string;
    status: string;
    rows: TranscriptRow[];
    canSend: boolean;
    transcriptSource: "session" | "memory";
}
/** How many message rows the belowEditor widget shows (tail-following). */
export declare const VIEWING_MAX_MESSAGE_LINES = 8;
export declare function renderViewingWidget(state: ViewingWidgetState, width: number): string[];
/** One transcript row → display lines (shares the attach-overlay row style). */
export declare function renderViewingRow(row: TranscriptRow, width: number): string[];
/**
 * Where a submitted main-editor line goes while viewing a teammate.
 *
 * - not viewing → main conversation handles it (`continue`)
 * - `/`-commands → main conversation (pi processes them)
 * - viewing a read-only agent (no writable stdin) → swallow (`handled`)
 * - otherwise → forward to the agent as a follow-up (`forward`)
 */
export type ViewingInputAction = {
    action: "continue";
} | {
    action: "handled";
} | {
    action: "forward";
    text: string;
};
export declare function decideViewingInput(text: string, opts: {
    viewing: boolean;
    canSend: boolean;
}): ViewingInputAction;
