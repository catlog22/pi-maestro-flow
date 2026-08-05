/**
 * Agent-list scroll window.
 *
 * The below-input agent list is bounded by the terminal height. It follows the
 * newest activity by default (auto-scroll as agents stream); Shift+↑/Shift+↓
 * (with an empty composer, via a cockpit terminal-input hook) scroll up/down
 * through the whole roster. Scrolling up pauses follow; reaching the bottom
 * resumes it. Pure state math, no UI dependencies.
 */

import { panelRows } from "./viewport.ts";

export interface AgentScrollState {
	/** Window start over the activity-ordered roster. */
	offset: number;
	/** When true the window tracks the newest rows (auto-scroll). */
	following: boolean;
}

/** Window start for a state; follow pins the window to the newest rows. */
export function scrollWindowStart(total: number, budget: number, state: AgentScrollState): number {
	if (total <= budget) return 0;
	if (state.following) return total - budget;
	return Math.max(0, Math.min(state.offset, total - budget));
}

/** Move the window by `delta` rows; reaching the bottom resumes follow. */
export function scrollBy(
	state: AgentScrollState,
	delta: number,
	total: number,
	budget: number,
): AgentScrollState {
	if (total <= budget) return { offset: 0, following: true };
	const start = scrollWindowStart(total, budget, state);
	const next = Math.max(0, Math.min(start + delta, total - budget));
	return { offset: next, following: next >= total - budget };
}

/** Tail-following window: newest rows first. */
export function followWindow(total: number, budget: number): AgentScrollState {
	return { offset: Math.max(0, total - budget), following: true };
}

/**
 * How many agent rows the panel may render. Mirrors the roster widget's own
 * budget: a width cap (6 wide / 3 narrow) plus one marker row, bounded by the
 * terminal-height panel share.
 */
export function agentListWindowRows(
	terminalColumns: number | undefined,
	terminalRows: number | undefined,
	total?: number,
): number {
	const widthCap = (terminalColumns ?? 80) < 40 ? 3 : 6;
	const panel = panelRows(terminalRows);
	const panelBudget = Math.min(widthCap + 1, panel ?? widthCap + 1);
	const bodyBudget = Math.max(1, panelBudget - 1); // roster header owns one row
	// One combined overflow marker is paid from the body budget, preserving at
	// least one actual agent row even in the minimum three-row panel.
	return total !== undefined && total > bodyBudget
		? Math.max(1, bodyBudget - 1)
		: bodyBudget;
}
