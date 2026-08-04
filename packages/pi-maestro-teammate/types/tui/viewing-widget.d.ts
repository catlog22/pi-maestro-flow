/**
 * Main-TUI viewing mode — input-routing decisions.
 *
 * Rendering moved to `viewing-entry.ts` (conversation-embedded streaming
 * entry); this module keeps only the pure input-routing core shared by the
 * `pi.on("input")` hook. Switching only touches UI state, never the agent's
 * task, so a running agent (main loop or sub-process) is unaffected by
 * entering/leaving the view.
 */
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
