/**
 * Attach overlay — multi-agent view with manual tabs and scroll state.
 * Uses only APIs exported by the installed pi-tui package.
 */
import { type Component, type Focusable } from "@earendil-works/pi-tui";
import type { ActiveAgent, AgentProgressSnapshot, MessageEnvelope } from "../shared/types.ts";
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
}
export declare class AttachOverlay implements Component, Focusable {
    focused: boolean;
    private agents;
    /** Agents whose data changed while they were not the visible tab. */
    private dirtyAgents;
    private activeId;
    private order;
    private readonly onDone;
    private readonly getActiveRuns;
    private requestRender;
    private frame;
    private timer;
    private composing;
    private draft;
    private cursor;
    private sendStatus;
    private sending;
    private readonly pasteDecoder;
    private pasteFlushTimer;
    private lastWidth;
    private readonly onSend?;
    constructor(initial: ActiveAgent, onDone: () => void, getActiveRuns?: () => Map<string, ActiveAgent>, onSend?: (correlationId: string, message: string) => Promise<{
        ok: boolean;
        message: string;
    }>);
    setRequestRender(fn: () => void): void;
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
    private insertDraft;
    invalidate(): void;
    render(width: number, height?: number): string[];
    private renderComposer;
    private renderDocked;
    private renderProgressTree;
    private renderSelectedTools;
    private buildSelectedLog;
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
