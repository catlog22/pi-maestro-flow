/**
 * MonitorOverlay — TUI form for configuring monitor bindings.
 *
 * Opened via /monitor command. Shows active sessions, allows selecting
 * which to monitor, choosing auto/custom mode, and entering a custom prompt.
 *
 * Pattern: follows TeammateControlCenter (ctx.ui.custom + Component).
 */
import type { MonitorSupervisionMode } from "../extension/monitor.ts";
export interface MonitorSessionRow {
    correlationId: string;
    displayName: string;
    agentRole: string;
    status: string;
    idleSeconds: number;
    /** Whether this session already has a monitor binding. */
    bound: boolean;
}
export interface MonitorOverlayResult {
    /** Selected session correlationIds. */
    selected: string[];
    mode: MonitorSupervisionMode;
    customPrompt?: string;
}
interface OverlayCallbacks {
    getSessions: () => MonitorSessionRow[];
    close: (result: MonitorOverlayResult | null) => void;
}
export declare class MonitorOverlay {
    private readonly cb;
    private sessions;
    private cursor;
    private selected;
    private mode;
    private customPrompt;
    private editingPrompt;
    private statusText;
    private requestRender;
    constructor(cb: OverlayCallbacks);
    setRequestRender(fn: () => void): void;
    render(width: number): string[];
    private frameLine;
    handleInput(data: string): void;
    private confirm;
    invalidate(): void;
    dispose(): void;
}
export interface MonitorOverlayDeps {
    getSessions: () => MonitorSessionRow[];
}
/**
 * Opens the monitor overlay and returns the user's selection.
 * Returns null if cancelled.
 */
export declare function showMonitorOverlay(ctx: {
    ui: {
        custom: <T>(factory: (tui: {
            requestRender: () => void;
        }, theme: unknown, keybindings: unknown, done: (result: T) => void) => {
            render: (width: number) => string[];
            handleInput: (data: string) => void;
            invalidate: () => void;
            dispose: () => void;
        }, options: Record<string, unknown>) => Promise<T>;
    };
}, deps: MonitorOverlayDeps): Promise<MonitorOverlayResult | null>;
export {};
