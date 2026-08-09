/**
 * Attach overlay — multi-agent view with manual tabs and scroll state.
 * Uses only APIs exported by the installed pi-tui package.
 */
import { type Component, type Focusable } from "@earendil-works/pi-tui";
import type { ActiveAgent, AgentProgressSnapshot, MessageEnvelope } from "../shared/types.ts";
import type { TranscriptLoad, TranscriptRow } from "../shared/transcript.ts";
import { type SupportedSettingsLocale } from "./locale.ts";
/** Loader injected by the extension; reads the agent's session file. */
export type TranscriptLoader = (agent: ActiveAgent) => Promise<TranscriptLoad>;
/** Tab identity for the main conversation — a switching target, not a log. */
export declare const MAIN_TAB = "__main__";
export interface ToolEntry {
    name: string;
    status: "running" | "completed" | "failed";
    startedAt: number;
}
export interface OverlayProgressUpdate {
    progress?: AgentProgressSnapshot[];
    activeTools?: ToolEntry[];
    streamingText?: string;
    lines?: Array<{
        text: string;
        kind: "info" | "tool" | "output" | "system";
    }>;
}
interface LogRenderCache {
    width: number;
    locale: SupportedSettingsLocale;
    lineCount: number;
    lastLine: AgentLog["lines"][number] | undefined;
    inboxCount: number;
    lastInbox: MessageEnvelope | undefined;
    rendered: string[];
}
interface AgentLog {
    agent: ActiveAgent;
    lines: Array<{
        text: string;
        kind: "info" | "tool" | "output" | "system";
    }>;
    scrollOffset: number;
    maxScrollOffset: number;
    followTail: boolean;
    streamingText: string;
    activeTools: ToolEntry[];
    progress: AgentProgressSnapshot[];
    selectedTaskIndex?: number;
    logCache?: LogRenderCache;
    /** Full conversation view state (t/v keys). */
    transcript?: TranscriptLoad;
    transcriptLoading?: boolean;
    transcriptMode: boolean;
    transcriptError?: string;
    transcriptRefreshTimer?: ReturnType<typeof setTimeout>;
    transcriptCache?: {
        width: number;
        locale: SupportedSettingsLocale;
        rows: TranscriptRow[];
        loading: boolean;
        rendered: string[];
    };
}
export declare class AttachOverlay implements Component, Focusable {
    private readonly locale?;
    focused: boolean;
    private agents;
    /** Agents whose data changed while they were not the visible tab. */
    private dirtyAgents;
    private activeId;
    private order;
    private readonly onDone;
    private readonly getActiveRuns;
    private readonly loadTranscript?;
    private requestRender;
    private frame;
    private timer;
    private tickVisibility;
    private renderedTickSignature;
    private composing;
    private draft;
    private cursor;
    /** Target column for ↑/↓ across wrapped lines; cleared on any other edit. */
    private desiredCursorCol;
    /** Draft width used for cursor layout between renders (mirrors last composer render). */
    private composerDraftWidth;
    private sendStatus;
    private sending;
    private readonly pasteDecoder;
    private pasteFlushTimer;
    private lastWidth;
    private readonly onSend?;
    private readonly t;
    private readonly localeDisposer;
    constructor(initial: ActiveAgent, onDone: () => void, getActiveRuns?: () => Map<string, ActiveAgent>, onSend?: (correlationId: string, message: string) => Promise<{
        ok: boolean;
        message: string;
    }>, loadTranscript?: TranscriptLoader, initialTranscript?: boolean, locale?: SupportedSettingsLocale | undefined);
    setRequestRender(fn: () => void): void;
    private tickSignature;
    private setTickVisibility;
    /**
     * The overlay only ever draws the active tab, but progress events arrive for
     * every concurrent agent. Repainting on a background agent's event burns a
     * full frame whose visible region is identical; mark it dirty instead and let
     * the tab switch pick the data up.
     */
    private requestRenderFor;
    private addAgent;
    syncAgents(): void;
    setStreamingText(cid: string, text: string): void;
    setActiveTools(cid: string, tools: ToolEntry[]): void;
    setProgress(cid: string, progress: AgentProgressSnapshot[]): void;
    applyProgressEvent(cid: string, update: OverlayProgressUpdate): void;
    appendLog(cid: string, text: string, kind?: AgentLog["lines"][0]["kind"]): void;
    private ensureLog;
    private switchAgent;
    handleInput(data: string): void;
    private dispatchDecodedToken;
    private handleDecodedInput;
    /** Composer key handling shared by wide and narrow render paths. */
    private handleComposerKey;
    private insertDraft;
    /** Move the cursor one wrapped visual line up/down, keeping the target column. */
    private moveCursorVertical;
    /** Move the cursor to the start/end of the current wrapped visual line. */
    private moveCursorLineEdge;
    invalidate(): void;
    render(width: number, height?: number): string[];
    private renderComposer;
    /** One wrapped draft line, with the cursor grapheme reversed at `cursorOffset`. */
    private renderComposerRow;
    private renderDocked;
    private renderProgressTree;
    private renderSelectedTools;
    private buildSelectedLog;
    /**
     * First load of an agent's conversation from its session file. Tolerant of
     * failures — the live activity log remains the fallback view.
     */
    private ensureTranscript;
    /**
     * Live IPC arrived for a running agent whose transcript tab is open —
     * debounce a disk refresh so new session entries appear without a manual
     * reload. The loader is cheap (incremental read of an append-only file).
     */
    noteLiveEvent(cid: string): void;
    private refreshTranscript;
    /** Rows beyond this cap are hidden behind a dim marker (scroll not affected). */
    private static readonly TRANSCRIPT_MAX_ROWS;
    private buildTranscript;
    private renderTranscriptRow;
    /** Prefix a multi-line text block, indenting continuation lines. */
    private prefixedLines;
    /** First maxLines text lines, each truncated to width, with a … marker. */
    private limitText;
    private renderMainTab;
    private renderCompact;
    private renderFrame;
    private renderTabs;
    private renderTools;
    private renderStream;
    /**
     * Wrapping the full 500-line backlog on every frame is ~96% wasted work: the
     * caller slices a ~20-line window out of it. The backlog only changes when a
     * line is appended (or evicted, which changes the tail identity), so memoize
     * on (width, count, tail identity) for both the log and the inbox.
     */
    private buildLog;
    dispose(): void;
}
export {};
