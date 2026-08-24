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
import { agentDetailRows } from "./viewport.ts";
import { formatAgentMetric, formatDuration } from "./render.ts";
import { tuiStatus, tuiT } from "./tui-i18n.ts";

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
): number {
	const row = rows.find((candidate) => candidate.correlationId === viewingId);
	if (!row) return 0;
	const bodyWidth = Math.max(1, width - 4);
	let total = 0;
	if (row.task?.trim()) total += wrapTextWithAnsi(row.task.trim(), bodyWidth).length;
	if (row.conversation?.length) {
		for (const entry of row.conversation) {
			total += wrapTextWithAnsi(entry.text, bodyWidth).length;
		}
	} else if (row.tail?.trim()) {
		total += wrapTextWithAnsi(row.tail.trim(), Math.max(1, width - 2)).length;
	} else if (row.status === "running" || row.status === "retrying") {
		total += 1;
	}
	total += (row.recentTools ?? []).filter((tool) => tool.status !== "running").slice(-3).length;
	if (row.dependencies?.length) total += 1;
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
	hintText = tuiT("session.detailHint"),
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
	const model = row.resolvedModel ?? row.requestedModel;
	const meta = [
		row.phase ? row.phase : "",
		model ? model : "",
		row.toolCount !== undefined ? tuiT("common.tools", { count: row.toolCount }) : "",
		row.inputTokens !== undefined || row.outputTokens !== undefined
			? tuiT("widget.agent.inputOutput", {
				input: formatAgentMetric(row.inputTokens ?? 0),
				separator: "/",
				output: formatAgentMetric(row.outputTokens ?? 0),
			})
			: row.tokens !== undefined ? tuiT("widget.agent.tokens", { count: formatAgentMetric(row.tokens) }) : "",
	].filter(Boolean).join(" · ");
	const identity = [
		theme.fg(color, "■"),
		theme.fg(color, theme.bold(`@${label}`)),
		role ? theme.fg("dim", role) : "",
		theme.fg(color, tuiStatus(status)),
		theme.fg("dim", duration),
		meta ? theme.fg("dim", meta) : "",
	].filter(Boolean).join(" · ");
	const hint = theme.fg("dim", hintText);
	const hintWidth = visibleWidth(hint);
	const header = hintWidth + 12 <= w
		? (() => {
			const left = truncateToWidth(identity, Math.max(1, w - hintWidth - 2), "…");
			return left + " ".repeat(Math.max(2, w - visibleWidth(left) - hintWidth)) + hint;
		})()
		: truncateToWidth(identity, w, "…");
	const lines: string[] = [header];

	const body: string[] = [];
	const pushWrapped = (text: string, prefix: string, color: ThemeColor): void => {
		const available = Math.max(1, w - visibleWidth(prefix));
		const wrapped = wrapTextWithAnsi(text.trim(), available);
		for (let index = 0; index < wrapped.length; index++) {
			const marker = index === 0 ? prefix : " ".repeat(visibleWidth(prefix));
			body.push(theme.fg(color, `${marker}${wrapped[index] ?? ""}`));
		}
	};

	if (row.task?.trim()) pushWrapped(row.task, `  ${theme.fg("accent", "›")} `, "muted");
	if (row.conversation?.length) {
		for (const entry of row.conversation) {
			const marker = entry.role === "user" ? "›" : "│";
			const color: ThemeColor = entry.role === "user" ? "accent" : "dim";
			pushWrapped(entry.text, `  ${theme.fg(color, marker)} `, color);
		}
	} else {
		const tail = row.tail?.trim();
		if (tail) {
			for (const line of wrapTextWithAnsi(tail, Math.max(1, w - 2))) {
				body.push(theme.fg("dim", `  ${line}`));
			}
		} else if (status === "running" || status === "retrying") {
			if (status === "running" && !row.activeTool) {
				// No text has streamed yet: the model is producing its first response
				// (thinking deltas never reach lastMessage). A bare "working…" can sit
				// unchanged for minutes there, so name the state and show how long the
				// silence has lasted — a live agent stays distinguishable from a stuck one.
				const idleMs = Math.max(0, now - row.lastActivityAt);
				const idle = idleMs >= 5_000 ? ` · ${formatDuration(idleMs)}` : "";
				body.push(theme.fg("dim", `  ${tuiT("session.thinking")}${idle}`));
			} else {
				body.push(theme.fg("dim", `  ${tuiT("session.working")}`));
			}
		} else if (status === "stalled") {
			body.push(theme.fg("error", `  ${tuiT("session.noActivity", {
				duration: formatDuration(Math.max(0, now - row.lastActivityAt)),
			})}`));
		}
	}
	for (const tool of (row.recentTools ?? []).filter((candidate) => candidate.status !== "running").slice(-3)) {
		const statusGlyph = tool.status === "failed" || tool.status === "error" ? "✗" : "✓";
		const args = tool.argsPreview ? ` ${tool.argsPreview}` : "";
		body.push(truncateToWidth(theme.fg(tool.status === "failed" || tool.status === "error" ? "error" : "muted", `  ${statusGlyph} ${tool.name}${args}`), w, "…"));
	}
	if (row.dependencies?.length) {
		body.push(theme.fg("dim", `  ↳ #${row.dependencies.map((dependency) => dependency + 1).join(", #")}`));
	}
	if (row.activeTool) {
		const toolLine = row.activeToolArgs
			? `  ${theme.fg("warning", "→")} ${row.activeTool} ${theme.fg("dim", truncateToWidth(row.activeToolArgs, Math.max(1, w - 12), "…"))}`
			: `  ${theme.fg("warning", "→")} ${row.activeTool}`;
		body.push(truncateToWidth(toolLine, w, "…"));
	}
	if (row.error) {
		body.push(theme.fg("error", `  ✗ ${truncateToWidth(row.error, Math.max(1, w - 4), "…")}`));
	}
	for (let index = 0; index < body.length; index++) {
		body[index] = truncateToWidth(body[index] ?? "", w, "…");
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
				theme.fg("dim", `  ${[
					above > 0 ? `↑ ${tuiT("common.more", { count: above })}` : "",
					below > 0 ? `↓ ${tuiT("common.more", { count: below })}` : "",
				].filter(Boolean).join(" · ")}`),
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
			const maxRows = agentDetailRows(tui.terminal?.rows) ?? DEFAULT_SESSION_DETAIL_ROWS;
			return renderSessionDetail(
				deps.getAgents(),
				deps.getViewingId(),
				width,
				theme,
				maxRows,
				deps.getScroll?.(),
			);
		},
		invalidate(): void {},
		dispose(): void {},
	});
}
