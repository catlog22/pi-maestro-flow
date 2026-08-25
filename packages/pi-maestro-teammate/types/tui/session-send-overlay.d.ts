import { type SupportedSettingsLocale } from "./locale.ts";
export interface SessionSelectionRow {
    correlationId: string;
    displayName: string;
    agentRole: string;
    status: string;
    idleSeconds: number;
    source?: string;
    kind?: "agent" | "window" | "remote";
    bindable?: boolean;
    ownerId?: string;
    depth?: number;
    parentCorrelationId?: string;
}
export interface SessionSendOverlayResult {
    target: string;
    message: string;
}
interface SessionSendOverlayCallbacks {
    getSessions: () => SessionSelectionRow[];
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
    getSessions: () => SessionSelectionRow[];
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
