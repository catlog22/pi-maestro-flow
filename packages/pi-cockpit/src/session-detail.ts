/**
 * Session detail — the selected agent's live session content, rendered in a
 * fixed cockpit region above the Todo panel. Isolated from the main conversation
 * (nothing is appended there) and fully dynamic: the status header and streaming
 * tail re-read the agents store on every frame. `@main` has no block — the main
 * conversation itself is its content.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import type { AgentRow } from "./types.ts";
import { effectiveAgentStatus, type AgentDisplayStatus } from "./agents-store.ts";
import { scrollWindowStart } from "./agent-scroll.ts";
import { panelRows } from "./viewport.ts";
import { formatAgentMetric, formatDuration } from "./render.ts";

function detailStatusColor(status: AgentDisplayStatus): ThemeColor {
	switch (status) {
		case "running":
		case "retrying":
			return "warning";
		case "stalled":
		case "failed":
		case "terminated":
			return "error";
		case "done":
		case "result-ready":
			return "success";
		default:
			return "muted";
	}
}

export const SESSION_DETAIL_WIDGET_KEY = "cockpit-session-detail";

/** Default body line allowance for direct pure-render calls. */
export const SESSION_DETAIL_TAIL_LINES = 8;
/** Historical fixed fallback when a host does not expose terminal height. */
export const DEFAULT_SESSION_DETAIL_ROWS = 6;

export interface SessionDetailScrollState {
	offset: number;
	following: boolean;
}

export interface SessionDetailDeps {
	getAgents: () => AgentRow[];
	getViewingId: () => string | undefined;
	getVisible: () => boolean;
	getQuietMode?: () => boolean;
	getScroll?: () => SessionDetailScrollState;
}

export function sessionDetailWindowRows(total: number, maxRows: number): number {
	const bodyBudget = Math.max(0, maxRows - 1); // header owns one row
	if (bodyBudget === 0) return 0;
	return total > bodyBudget ? Math.max(1, bodyBudget - 1) : bodyBudget;
}

export function sessionDetailBodyLength(
	rows: readonly AgentRow[],
	viewingId: string | undefined,
	width: number,
	quietMode = false,
): number {
	const row = rows.find((candidate) => candidate.correlationId === viewingId);
	if (!row) return 0;
	let total = !quietMode && row.tail?.trim()
		? wrapTextWithAnsi(row.tail.trim(), Math.max(1, width - 2)).length
		: !quietMode && (row.status === "running" || row.status === "retrying") ? 1 : 0;
	if (row.activeTool) total += 1;
	if (row.error) total += 1;
	return total;
}

/** Render the selected agent's session block; empty for @main / no selection. */
export function renderSessionDetail(
	rows: readonly AgentRow[],
	viewingId: string | undefined,
	width: number,
	theme: Theme,
	maxRows = SESSION_DETAIL_TAIL_LINES + 1,
	scroll: SessionDetailScrollState = { offset: 0, following: true },
	quietMode = false,
): string[] {
	const row = rows.find((candidate) => candidate.correlationId === viewingId);
	if (!row) return [];
	const w = Math.max(1, width);
	const now = Date.now();
	const status = effectiveAgentStatus(row, now);
	const color = detailStatusColor(status);
	const label = row.name || row.role || row.agent || "agent";
	const role = row.role && row.role !== label ? `(${row.role})` : "";
	const duration = formatDuration(Math.max(0, (row.finishedAt ?? now) - row.startedAt));
	const meta = [
		row.toolCount !== undefined ? `${row.toolCount} tools` : "",
		row.inputTokens !== undefined || row.outputTokens !== undefined
			? `in ${formatAgentMetric(row.inputTokens ?? 0)}/out ${formatAgentMetric(row.outputTokens ?? 0)}`
			: row.tokens !== undefined ? `${formatAgentMetric(row.tokens)} tok` : "",
	].filter(Boolean).join(" · ");
	const identity = [
		theme.fg(color, "■"),
		theme.fg(color, theme.bold(`@${label}`)),
		role ? theme.fg("dim", role) : "",
		theme.fg(color, status),
		theme.fg("dim", duration),
		meta ? theme.fg("dim", meta) : "",
	].filter(Boolean).join(" · ");
	const hint = theme.fg("dim", quietMode ? "Alt+Shift+R hide" : "Alt+Shift+↑↓ scroll · Alt+Shift+R hide");
	const hintWidth = visibleWidth(hint);
	const header = hintWidth + 12 <= w
		? (() => {
			const left = truncateToWidth(identity, Math.max(1, w - hintWidth - 2), "…");
			return left + " ".repeat(Math.max(2, w - visibleWidth(left) - hintWidth)) + hint;
		})()
		: truncateToWidth(identity, w, "…");
	const lines: string[] = [header];

	const body: string[] = [];
	const tail = row.tail?.trim();
	if (!quietMode && tail) {
		for (const line of wrapTextWithAnsi(tail, Math.max(1, w - 2))) {
			body.push(theme.fg("dim", `  ${line}`));
		}
	} else if (!quietMode && (status === "running" || status === "retrying")) {
		body.push(theme.fg("dim", "  working…"));
	}
	if (row.activeTool) {
		body.push(truncateToWidth(theme.fg("dim", `  ${theme.fg("warning", "→")} ${row.activeTool}`), w, "…"));
	}
	if (row.error) {
		body.push(theme.fg("error", `  ✗ ${truncateToWidth(row.error, Math.max(1, w - 4), "…")}`));
	}
	if (maxRows <= 0) return [];
	if (maxRows === 1 || body.length === 0) return lines;
	const windowRows = sessionDetailWindowRows(body.length, maxRows);
	const start = scrollWindowStart(body.length, windowRows, scroll);
	const above = start;
	const below = Math.max(0, body.length - start - windowRows);
	const visible = body.slice(start, start + windowRows);
	const marker = above > 0 || below > 0
		? truncateToWidth(
			theme.fg("dim", `  ${[above > 0 ? `↑ ${above} more` : "", below > 0 ? `↓ ${below} more` : ""].filter(Boolean).join(" · ")}`),
			w,
			"…",
		)
		: undefined;
	if (!marker) return [...lines, ...visible];
	return above > 0
		? [...lines, marker, ...visible]
		: [...lines, ...visible, marker];
}

export function makeSessionDetailWidget(deps: SessionDetailDeps) {
	return (tui: TUI, theme: Theme) => ({
		render(width: number): string[] {
			if (!deps.getVisible()) return [];
			const maxRows = panelRows(tui.terminal?.rows) ?? DEFAULT_SESSION_DETAIL_ROWS;
			return renderSessionDetail(
				deps.getAgents(),
				deps.getViewingId(),
				width,
				theme,
				maxRows,
				deps.getScroll?.(),
				deps.getQuietMode?.() ?? false,
			);
		},
		invalidate(): void {},
		dispose(): void {},
	});
}
