/**
 * Agent Bar and the legacy Session Bar facade implementation.
 *
 * Agent Bar consumes canonical local session endpoints and SessionUiState. The
 * compatibility exports at the bottom preserve the former AgentRow-based API.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { CockpitEndpoint } from "./endpoint-store.ts";
import type { SessionUiState } from "./session-ui-state.ts";
import {
	formatUnreadCount,
	renderSessionTabLine,
	type SessionTab,
} from "./session-tabs.ts";
import type { AgentRow } from "./types.ts";
import { effectiveAgentStatus, type AgentDisplayStatus } from "./agents-store.ts";
import { visibleAgentRows } from "./stack-widget.ts";

export const SESSION_BAR_WIDGET_KEY = "cockpit-session-bar";
export const AGENT_BAR_WIDGET_KEY = SESSION_BAR_WIDGET_KEY;

/** Chip label for the main (root) session. */
export const MAIN_SESSION_LABEL = "main";

/** Stable compatibility order for legacy AgentRow callers. */
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

export interface AgentBarDeps {
	getEndpoints: () => readonly CockpitEndpoint[];
	getState: () => SessionUiState;
	getNow: () => number;
	isMainRunning?: () => boolean;
	getContextPressure?: () => number | undefined;
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
			return "muted";
	}
}

function chip(label: string, active: boolean, color: ThemeColor, theme: Theme, unread = 0): string {
	const text = `@${label}`;
	const badge = unread > 0 ? theme.fg("warning", ` •${formatUnreadCount(unread)}`) : "";
	return active
		? `${theme.fg(color, "▸")} ${theme.fg(color, theme.bold(text))}${badge}`
		: `${theme.fg(color, text)}${badge}`;
}

export type AgentBarStatus = AgentDisplayStatus | "idle";

interface AgentBarTab extends SessionTab {
	endpoint: CockpitEndpoint;
	status: AgentBarStatus;
	color: ThemeColor;
}

function endpointStatus(endpoint: CockpitEndpoint, now: number, mainRunning: boolean): AgentBarStatus {
	if (endpoint.kind === "root") return mainRunning ? "running" : "idle";
	if (endpoint.agentRow) return effectiveAgentStatus(endpoint.agentRow, now);
	if (endpoint.status === "sleeping") return "sleeping";
	if (endpoint.status === "settled") return "done";
	return "running";
}

function endpointColor(endpoint: CockpitEndpoint, status: AgentBarStatus, now: number, selected: boolean): ThemeColor {
	if (endpoint.kind === "root") return selected ? "accent" : status === "running" ? "warning" : "muted";
	if (endpoint.agentRow) return agentSessionColor(endpoint.agentRow, now, status === "idle" ? undefined : status);
	if (status === "done" || status === "sleeping" || status === "terminated") return "muted";
	if (status === "failed" || status === "stalled") return "error";
	return assignedAgentColor(endpoint.correlationId ?? endpoint.id);
}

function endpointStatusColor(status: AgentBarStatus): ThemeColor {
	return status === "idle" ? "muted" : statusColor(status);
}

function normalizedPressure(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(100, Math.round(value)));
}

function pressureColor(value: number): ThemeColor {
	if (value >= 90) return "error";
	if (value >= 70) return "warning";
	return "muted";
}

export interface AgentBarRenderOptions {
	mainRunning?: boolean;
	contextPressure?: number;
	now?: number;
}

/** Render canonical main + local-agent tabs with status, pressure and unread. */
export function renderAgentBar(
	endpoints: readonly CockpitEndpoint[],
	state: SessionUiState,
	width: number,
	theme: Theme,
	options: AgentBarRenderOptions = {},
): string[] {
	if (endpoints.length === 0) return [truncateToWidth(chip(MAIN_SESSION_LABEL, true, "accent", theme), Math.max(1, width), "…")];
	const now = options.now ?? 0;
	const selectedId = state.selectedId("agent") ?? endpoints.find((endpoint) => endpoint.kind === "root")?.id ?? endpoints[0]?.id;
	const tabs: AgentBarTab[] = endpoints.map((endpoint) => {
		const selected = endpoint.id === selectedId;
		const status = endpointStatus(endpoint, now, options.mainRunning === true);
		return {
			id: endpoint.id,
			label: endpoint.label,
			ordinal: endpoint.ordinal,
			unread: state.endpoint(endpoint.id).unread,
			endpoint,
			status,
			color: endpointColor(endpoint, status, now, selected),
		};
	});
	const pressure = normalizedPressure(options.contextPressure);
	const line = renderSessionTabLine(tabs, width, {
		selectedId,
		renderTab: (tab, selected) => chip(tab.label, selected, tab.color, theme, tab.unread),
		renderUnreadSummary: (totalUnread) => theme.fg("warning", `•${formatUnreadCount(totalUnread)}`),
		renderSummary: (selected, totalUnread) => {
			const color = endpointStatusColor(selected.status);
			const parts = [
				theme.fg(color, `● @${selected.label}`),
				totalUnread > 0 ? theme.fg("warning", `${formatUnreadCount(totalUnread)} unread`) : "",
				theme.fg(color, selected.status),
				pressure === undefined ? "" : theme.fg(pressureColor(pressure), `ctx ${pressure}%`),
			].filter(Boolean);
			return parts.join(theme.fg("dim", " · "));
		},
	});
	return [line];
}

export function makeAgentBarWidget(deps: AgentBarDeps) {
	return (_tui: TUI, theme: Theme) => ({
		render(width: number): string[] {
			return renderAgentBar(deps.getEndpoints(), deps.getState(), width, theme, {
				mainRunning: deps.isMainRunning?.(),
				contextPressure: deps.getContextPressure?.(),
				now: deps.getNow(),
			});
		},
		invalidate(): void {},
		dispose(): void {},
	});
}

export interface SessionBarRenderOptions {
	mainRunning?: boolean;
	current?: { label: string; color: ThemeColor } | undefined;
	now?: number;
	stableStatuses?: Map<string, AgentDisplayStatus>;
}

/** Legacy AgentRow-based pure renderer retained for downstream compatibility. */
export function renderSessionBar(
	rows: AgentRow[],
	width: number,
	theme: Theme,
	opts: SessionBarRenderOptions = {},
): string[] {
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
	return (_tui: TUI, theme: Theme) => ({
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
