/**
 * TUI rendering for the teammate tool.
 *
 * renderCall: intentionally empty; result rendering owns the lifecycle surface
 * renderResult: real-time streaming for foreground, compact status for completed
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component } from "@earendil-works/pi-tui";
import type { Details } from "../shared/types.ts";
type Theme = ExtensionContext["ui"]["theme"];
export declare function renderTeammateCall(_args: Record<string, unknown>, _theme: Theme, _context?: {
    expanded?: boolean;
    isPartial?: boolean;
}): Component;
export declare function renderTeammateListCall(args: Record<string, unknown>, theme: Theme, context?: {
    isPartial?: boolean;
}): Component;
export declare function renderTeammateListResult(result: AgentToolResult<{
    agents: unknown[];
}>, options: {
    isPartial?: boolean;
}, theme: Theme): Component;
export declare function renderTeammateResult(result: AgentToolResult<Details>, options: {
    expanded: boolean;
}, theme: Theme): Component;
export declare function renderQuietTeammateAux(name: "teammate-send" | "teammate-wait" | "teammate-watch" | "teammate-started", rest: string, status: "running" | "success" | "failure", theme: Theme): Component | undefined;
export {};
