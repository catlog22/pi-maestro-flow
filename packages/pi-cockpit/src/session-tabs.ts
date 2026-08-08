import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const SESSION_TAB_ACTION_FIRST_WIDTH = 40;

export interface SessionTab {
	id: string;
	label: string;
	ordinal: number;
	unread?: number;
}

export type SessionTabWidthMode = "action-first" | "full";

export function sessionTabWidth(width: number): number {
	if (!Number.isFinite(width)) return 1;
	return Math.max(1, Math.floor(width));
}

export function sessionTabWidthMode(width: number): SessionTabWidthMode {
	return sessionTabWidth(width) < SESSION_TAB_ACTION_FIRST_WIDTH ? "action-first" : "full";
}

export function orderedSessionTabs<T extends SessionTab>(tabs: readonly T[]): T[] {
	return [...tabs].sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id, "en"));
}

/** Circular navigation over canonical ordinal order. */
export function nextSessionTabId<T extends SessionTab>(
	tabs: readonly T[],
	selectedId: string | undefined,
	delta: -1 | 1,
): string | undefined {
	const ordered = orderedSessionTabs(tabs);
	if (ordered.length === 0) return undefined;
	const current = ordered.findIndex((tab) => tab.id === selectedId);
	if (current < 0) return delta > 0 ? ordered[0]?.id : ordered.at(-1)?.id;
	return ordered[(current + delta + ordered.length) % ordered.length]?.id;
}

export function formatUnreadCount(count: number): string {
	const normalized = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
	return normalized > 99 ? "99+" : String(normalized);
}

export interface RenderSessionTabLineOptions<T extends SessionTab> {
	selectedId: string | undefined;
	renderTab: (tab: T, selected: boolean) => string;
	renderSummary?: (selected: T, totalUnread: number) => string;
	renderUnreadSummary?: (totalUnread: number) => string;
	separator?: string;
	ellipsis?: string;
}

/**
 * One-line shared tab layout. Below 40 columns the selected action is always
 * first and non-selected tabs yield; full mode retains canonical tab order and
 * a right-edge selected-session summary.
 */
export function renderSessionTabLine<T extends SessionTab>(
	tabs: readonly T[],
	width: number,
	options: RenderSessionTabLineOptions<T>,
): string {
	const w = sessionTabWidth(width);
	const ordered = orderedSessionTabs(tabs);
	if (ordered.length === 0) return "";
	const selected = ordered.find((tab) => tab.id === options.selectedId) ?? ordered[0]!;
	const totalUnread = ordered.reduce(
		(total, tab) => total + (tab.id === selected.id ? 0 : Math.max(0, tab.unread ?? 0)),
		0,
	);
	const separator = options.separator ?? "  ";
	const ellipsis = options.ellipsis ?? "…";

	if (sessionTabWidthMode(w) === "action-first") {
		const action = options.renderTab(selected, true);
		const unread = totalUnread > 0 ? options.renderUnreadSummary?.(totalUnread) ?? "" : "";
		const raw = unread ? `${action}${separator}${unread}` : action;
		return truncateToWidth(raw, w, ellipsis);
	}

	const tabsLine = ordered.map((tab) => options.renderTab(tab, tab.id === selected.id)).join(separator);
	const rawSummary = options.renderSummary?.(selected, totalUnread) ?? "";
	if (!rawSummary) return truncateToWidth(tabsLine, w, ellipsis);
	const summary = truncateToWidth(rawSummary, w, ellipsis);
	const summaryWidth = visibleWidth(summary);
	if (summaryWidth >= w) return summary;
	const leftBudget = Math.max(0, w - summaryWidth - visibleWidth(separator));
	if (leftBudget === 0) return " ".repeat(w - summaryWidth) + summary;
	const left = truncateToWidth(tabsLine, leftBudget, ellipsis);
	const pad = Math.max(0, w - visibleWidth(left) - summaryWidth);
	return left + " ".repeat(pad) + summary;
}
