/**
 * Read-only Experts Mode status panel overlay.
 *
 * Rendered through ctx.ui.custom as a centered modal (NOT the full teammate
 * control center): a bordered text box showing pre-formatted panel lines.
 * Closes on Esc / q / Q / Enter; arrow keys and PgUp/PgDn scroll long bodies.
 * The body is produced by the pure formatters in experts-mode/status-panel.ts,
 * so this overlay never reads state or prints model ids itself.
 */
/** Structural slice of the host Theme we use; null → plain box fallback. */
export interface ExpertsStatusOverlayThemeLike {
    fg(color: string, text: string): string;
    bg(color: string, text: string): string;
}
export declare class ExpertsStatusOverlay {
    private readonly title;
    private readonly theme;
    private readonly close;
    private readonly lines;
    private scrollOffset;
    private requestRender;
    constructor(body: string, title: string, theme: ExpertsStatusOverlayThemeLike | null, close: () => void);
    setRequestRender(fn: () => void): void;
    private get maxScrollOffset();
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate(): void;
    dispose(): void;
}
export interface ExpertsStatusOverlayCtx {
    ui: {
        custom: Function;
    };
    cwd?: string;
}
/**
 * Show a read-only Experts status panel as a centered modal overlay.
 * Resolves when the user closes it (Esc/q/Enter). When the host has no
 * interactive custom overlay, the caller falls back to ctx.ui.notify.
 */
export declare function showExpertsStatusOverlay(ctx: ExpertsStatusOverlayCtx, body: string, title?: string): Promise<void>;
