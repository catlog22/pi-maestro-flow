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
export declare function renderTeammateCall(args: Record<string, unknown>, theme: Theme, _context?: {
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
}, theme: Theme, args?: Record<string, unknown>): Component;
export declare function renderQuietTeammateAux(name: "teammate-send" | "teammate-wait" | "teammate-watch" | "teammate-started" | "teammate-monitor" | "observe", rest: string, status: "running" | "success" | "failure", theme: Theme): Component | undefined;
/**
 * Host-contract fallbacks for auxiliary tool renderers when quiet mode is off.
 * pi's ToolExecutionComponent addChild()s whatever renderCall/renderResult
 * return and only guards against throws, so renderQuietTeammateAux's quiet-only
 * undefined must never leak into a tool slot — Box.render would call
 * child.render on undefined and kill pi with an uncaughtException. This is the
 * exact state every /resume history render sees: pi renders resumed history
 * before session_start, while the Cockpit-driven quiet mirror is still false.
 * The fallbacks mirror the host's own default call/result rendering.
 */
export declare function auxToolCallFallback(name: string, theme: Theme): Component;
export declare function auxToolResultFallback(result: AgentToolResult<unknown>, theme: Theme): Component;
export {};
