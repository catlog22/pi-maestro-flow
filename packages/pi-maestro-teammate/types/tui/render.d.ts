/**
 * TUI rendering for the teammate tool.
 *
 * renderCall: running placeholder until the result owns the lifecycle surface
 * renderResult: real-time streaming for foreground, compact status for completed
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component } from "@earendil-works/pi-tui";
import type { Details } from "../shared/types.ts";
type Theme = ExtensionContext["ui"]["theme"];
/**
 * Shared tool-call row grammar, mirroring Cockpit's toolCallLine:
 * `  {mark} {toolTitle name} {accent arg}`. Every teammate-family renderCall
 * uses it so quiet and default mode differ only in glyph set, never in shape.
 */
export declare function teammateCallLine(theme: Theme, name: string, arg?: string): Component;
type TeammateRenderContext = {
    expanded?: boolean;
    isPartial?: boolean;
    isError?: boolean;
    state?: Record<string, unknown>;
};
export declare function renderTeammateCall(args: Record<string, unknown>, theme: Theme, context?: TeammateRenderContext): Component;
export declare function renderTeammateListCall(args: Record<string, unknown>, theme: Theme, context?: {
    isPartial?: boolean;
}): Component;
export declare function renderTeammateListResult(result: AgentToolResult<{
    agents: unknown[];
}>, options: {
    expanded?: boolean;
    isPartial?: boolean;
}, theme: Theme, args?: Record<string, unknown>, rendererError?: boolean): Component;
export declare function renderTeammateSendCall(args: Record<string, unknown>, theme: Theme, context?: {
    isPartial?: boolean;
}): Component;
export declare function renderTeammateSendResult(result: AgentToolResult<{
    delivered: boolean;
}>, options: {
    expanded?: boolean;
    isPartial?: boolean;
}, theme: Theme, args?: Record<string, unknown>, rendererError?: boolean): Component;
export declare function renderObserveCall(args: Record<string, unknown>, theme: Theme, context?: {
    isPartial?: boolean;
}): Component;
export declare function renderObserveResult(result: AgentToolResult<unknown>, options: {
    expanded?: boolean;
    isPartial?: boolean;
}, theme: Theme, rendererError?: boolean): Component;
export declare function renderMonitorResult(result: AgentToolResult<unknown>, options: {
    expanded?: boolean;
    isPartial?: boolean;
}, theme: Theme, rendererError?: boolean): Component;
export declare function renderTeammateResult(result: AgentToolResult<Details>, options: {
    expanded: boolean;
}, theme: Theme, args?: Record<string, unknown>, context?: TeammateRenderContext): Component;
export declare function renderTeammateCompletionMessage(content: string, details: Details, expanded: boolean, theme: Theme): Component;
export declare function renderTeammateCompletionFallbackMessage(content: string, expanded: boolean, theme: Theme): Component;
export interface CompletionOutboxRenderDetails {
    replayed: boolean;
    resources: readonly string[];
}
export declare function renderCompletionOutboxMessage(content: string, details: CompletionOutboxRenderDetails, expanded: boolean, theme: Theme): Component;
export interface TeammateStalledRenderDetails {
    mode?: string;
    correlationId?: string;
    name?: string;
    agent?: string;
    diagnosis?: unknown;
}
export declare function renderTeammateStalledMessage(content: string, details: TeammateStalledRenderDetails | undefined, expanded: boolean, theme: Theme): Component;
/**
 * One status row for compact auxiliary outcomes (`teammate-started` notices,
 * quiet watch/wait/monitor results). Renders in every mode — only the glyph
 * set changes — so these surfaces are never the host's plain-text fallback.
 */
export declare function teammateStatusRow(name: "teammate-send" | "teammate-wait" | "teammate-watch" | "teammate-started" | "teammate-monitor" | "observe", rest: string, status: "running" | "success" | "failure", theme: Theme): Component;
/** Card-shaped result for auxiliary tools without structured details. */
export declare function auxToolResultCard(name: string, result: AgentToolResult<unknown>, theme: Theme, options?: {
    expanded?: boolean;
}): Component;
export {};
