/**
 * Session bar — the session switcher pinned directly above the input box.
 * One line: color-coded chips for the main session (`@main`) plus every
 * teammate agent on the left, and the currently shown session's status
 * (`● @session`, status-colored) at the right edge — the input box's top-right
 * corner indicator. ←/→ (with an empty composer) cycles the chips; the bar is
 * display-only, so it stays visible in both the dock and widgets surfaces.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { AgentRow } from "./types.ts";
import { effectiveAgentStatus, type AgentDisplayStatus } from "./agents-store.ts";
import { visibleAgentRows } from "./stack-widget.ts";

export const SESSION_BAR_WIDGET_KEY = "cockpit-session-bar";

/** Chip label for the main (root) session. */
export const MAIN_SESSION_LABEL = "main";

/**
 * Stable chip order: agents appear in the order they started. The store
 * snapshot orders by latest activity, so a raw pass-through would shuffle
 * chips on every teammate progress message. `startedAt` is set once at
 * materialization and never moves during a run: only a brand-new agent
 * appends at the end, and a completed row keeps its slot until pruned.
 */
export function byStartOrder(a: AgentRow, b: AgentRow): number {
	return a.startedAt - b.startedAt || a.correlationId.localeCompare(b.correlationId);
}

export interface SessionBarDeps {
	getAgents: () => AgentRow[];
	/** Stable owner clock snapshot; render never reads the wall clock itself. */
	getNow: () => number;
	/** Whether the main (root) agent is currently working. */
	isMainRunning?: () => boolean;
	/** Current session shown at the right edge (@label + status color). */
	getCurrentSession?: () => { label: string; color: ThemeColor } | undefined;
}

export const AGENT_SESSION_COLORS = [
	"accent",
	"warning",
	"success",
	"mdLink",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
] as const satisfies readonly ThemeColor[];

/** Stable pseudo-random color per agent lifecycle identity; never flickers. */
export function assignedAgentColor(correlationId: string): ThemeColor {
	let hash = 2166136261;
	for (const char of correlationId) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16777619);
	}
	return AGENT_SESSION_COLORS[(hash >>> 0) % AGENT_SESSION_COLORS.length];
}

export function agentSessionColor(row: AgentRow, now: number, stableStatus?: AgentDisplayStatus): ThemeColor {
	const status = stableStatus ?? effectiveAgentStatus(row, now);
	if (status === "done" || status === "sleeping" || status === "terminated") return "muted";
	if (status === "failed" || status === "stalled") return "error";
	return assignedAgentColor(row.correlationId);
}

/** Map an agent display status to a theme color slot. */
export function statusColor(status: AgentDisplayStatus): ThemeColor {
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
			return "muted"; // pending, sleeping
	}
}

function chip(label: string, active: boolean, color: ThemeColor, theme: Theme): string {
	const text = `@${label}`;
	return active
		? `${theme.fg(color, "▸")} ${theme.fg(color, theme.bold(text))}`
		: theme.fg(color, text);
}

export interface SessionBarRenderOptions {
	mainRunning?: boolean;
	current?: { label: string; color: ThemeColor } | undefined;
	now?: number;
	stableStatuses?: Map<string, AgentDisplayStatus>;
}

/** Render the single-line session bar; the main chip is always present. */
export function renderSessionBar(
	rows: AgentRow[],
	width: number,
	theme: Theme,
	opts: SessionBarRenderOptions = {},
): string[] {
	// Start-time order (see byStartOrder) keeps the bar from reflowing while
	// agents run; visibleAgentRows returns a fresh array, so sort is safe.
	const agents = visibleAgentRows(rows).sort(byStartOrder);
	const viewingId = agents.find((row) => row.viewing)?.correlationId;
	const now = opts.now ?? agents.reduce((latest, row) => Math.max(latest, row.lastActivityAt), 0);
	const liveIds = new Set(agents.map((row) => row.correlationId));
	if (opts.stableStatuses) {
		for (const id of opts.stableStatuses.keys()) {
			if (!liveIds.has(id)) opts.stableStatuses.delete(id);
		}
	}
	const chips = [
		chip(
			MAIN_SESSION_LABEL,
			viewingId === undefined,
			viewingId === undefined ? "accent" : opts.mainRunning ? "warning" : "muted",
			theme,
		),
		...agents.map((row) => {
			const label = row.name || row.role || row.agent || "agent";
			const nextStatus = effectiveAgentStatus(row, now);
			const previousStatus = opts.stableStatuses?.get(row.correlationId);
			const stableStatus = previousStatus === nextStatus ? previousStatus : nextStatus;
			opts.stableStatuses?.set(row.correlationId, stableStatus);
			const color = agentSessionColor(row, now, stableStatus);
			return chip(label, row.correlationId === viewingId, color, theme);
		}),
	];
	const w = Math.max(1, width);
	const chipsLine = chips.join("  ");
	const rawStatus = opts.current
		? theme.fg(opts.current.color, `● @${opts.current.label}`)
		: "";
	if (!rawStatus) {
		return [truncateToWidth(chipsLine, w, "…")];
	}
	// Keep the right-edge status, but never let a long agent label overrun the
	// terminal. If it consumes the whole line, omit the lower-priority chips.
	const status = truncateToWidth(rawStatus, w, "…");
	const measuredStatus = visibleWidth(status);
	if (measuredStatus >= w) return [status];
	const leftBudget = Math.max(0, w - measuredStatus - 2);
	if (leftBudget === 0) return [" ".repeat(w - measuredStatus) + status];
	const left = truncateToWidth(chipsLine, leftBudget, "…");
	const pad = Math.max(0, w - visibleWidth(left) - measuredStatus);
	return [left + " ".repeat(pad) + status];
}

export function makeSessionBarWidget(deps: SessionBarDeps) {
	const stableStatuses = new Map<string, AgentDisplayStatus>();
	return (tui: TUI, theme: Theme) => ({
		render(width: number): string[] {
			return renderSessionBar(deps.getAgents(), width, theme, {
				mainRunning: deps.isMainRunning?.(),
				current: deps.getCurrentSession?.(),
				now: deps.getNow(),
				stableStatuses,
			});
		},
		invalidate(): void {},
		dispose(): void {},
	});
}
