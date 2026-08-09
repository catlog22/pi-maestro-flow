import type { MonitorSessionRow } from "./monitor-overlay.ts";
import { type SupportedSettingsLocale } from "./locale.ts";
export interface SessionSendOverlayResult {
    target: string;
    message: string;
}
interface SessionSendOverlayCallbacks {
    getSessions: () => MonitorSessionRow[];
    close: (result: SessionSendOverlayResult | null) => void;
}
/** Small session picker used by /teammate-send. */
export declare class SessionSendOverlay {
    private readonly cb;
    private sessions;
    private cursor;
    private selected?;
    private message;
    private editingMessage;
    private statusText;
    private requestRender;
    private readonly t;
    private readonly localeDisposer;
    constructor(cb: SessionSendOverlayCallbacks, locale?: SupportedSettingsLocale);
    setRequestRender(fn: () => void): void;
    render(width: number): string[];
    private frameLine;
    handleInput(data: string): void;
    private toggleSelection;
    private confirm;
    invalidate(): void;
    dispose(): void;
}
export interface SessionSendOverlayDeps {
    getSessions: () => MonitorSessionRow[];
    locale?: SupportedSettingsLocale;
}
export declare function showSessionSendOverlay(ctx: {
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
}, deps: SessionSendOverlayDeps): Promise<SessionSendOverlayResult | null>;
export {};
