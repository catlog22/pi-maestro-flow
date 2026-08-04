/**
 * Main-TUI viewing mode for a teammate session — conversation-embedded
 * streaming entry.
 *
 * `/teammate-session` no longer renders a below-editor widget: it appends a
 * custom entry into the main conversation, and the entry renderer streams the
 * viewed agent's working status live, conversation-style. The body uses the
 * exact same Markdown component + theme as Pi's built-in assistant message
 * renderer, so sub-agent output is presented identically to the main agent's
 * messages. Custom entries never participate in LLM context, so streaming
 * telemetry cannot pollute the main agent's prompt.
 *
 * Pure rendering + state projection, no extension context — kept dependency-
 * free so the renderer and the state builder share one testable core. The
 * extension wires this into `registerEntryRenderer` and a pi.on("input") hook;
 * switching only touches UI state, never the agent's task, so a running agent
 * (main loop or sub-process) is unaffected by entering/leaving the view.
 */
import { type Component } from "@earendil-works/pi-tui";
import { type StatusPresentation } from "../shared/agent-status.ts";
import { type ProgressPalette } from "./progress-tree.ts";
/** Custom-entry type for the live viewing block. Entries bypass LLM context. */
export declare const TEAMMATE_VIEW_CUSTOM_TYPE = "pi-teammate-view";
/** Persisted entry payload — the agent's identity plus a frozen snapshot. */
export interface ViewingEntryData {
    correlationId: string;
    agent: string;
    name?: string;
    status: string;
    streamingText?: string;
    toolLines?: ViewingToolLine[];
    toolCount?: number;
    inputTokens?: number;
    outputTokens?: number;
    durationMs?: number;
}
/** One tool-activity line rendered under the body. */
export interface ViewingToolLine {
    name: string;
    status: "running" | "completed" | "failed";
}
/**
 * Live view data supplied while viewing mode is active on this agent. When
 * absent, the entry renders its frozen snapshot (viewing exited or restarted).
 */
export interface ViewingEntryLive {
    status: string;
    resultReadyAt?: number;
    lastActivityAt?: number;
    startedAt?: number;
    streamingText?: string;
    toolLines?: ViewingToolLine[];
    toolCount?: number;
    inputTokens?: number;
    outputTokens?: number;
    /** Switchable agent labels, active one at `activeIndex`. */
    switches?: string[];
    activeIndex?: number;
    canSend: boolean;
}
/** Everything the renderer needs for one frame. */
export interface ViewingRenderState {
    agent: string;
    name?: string;
    /** Whether viewing mode is live on this agent right now. */
    active: boolean;
    status: string;
    presentation: StatusPresentation;
    durationMs?: number;
    toolCount?: number;
    inputTokens?: number;
    outputTokens?: number;
    bodyText: string;
    toolLines: ViewingToolLine[];
    switches?: string[];
    activeIndex?: number;
    canSend: boolean;
}
export interface ViewingEntryContext {
    data: ViewingEntryData;
    live?: ViewingEntryLive;
}
/** Upper bound on the markdown body so a 64KB message cannot flood the entry. */
export declare const VIEWING_BODY_MAX_CHARS = 2000;
/** Upper bound on rendered tool-activity lines. */
export declare const VIEWING_TOOL_MAX_LINES = 6;
/**
 * Project (data, live) into the render state. Live data wins while the agent
 * is being viewed; otherwise the frozen snapshot renders so the entry survives
 * process restarts as a static record.
 */
export declare function buildViewingRenderState(ctx: ViewingEntryContext): ViewingRenderState;
/**
 * Render the viewing entry as conversation lines.
 *
 * Header/status/tools/footer are auxiliary dim lines; the body is rendered
 * with the identical `Markdown` + `getMarkdownTheme()` combo the built-in
 * AssistantMessageComponent uses — same colors, padding, and no background —
 * so a sub-agent's streaming output reads exactly like a main-agent message.
 */
export declare function renderViewingEntry(state: ViewingRenderState, width: number, palette: ProgressPalette): string[];
/**
 * Component wrapper for `registerEntryRenderer`: re-reads the live state on
 * every frame, so the conversation block streams without re-appending.
 */
export declare function createViewingEntryComponent(getState: () => ViewingRenderState, palette: ProgressPalette): Component;
