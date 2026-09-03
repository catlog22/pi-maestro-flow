import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { effectiveAgentStatus } from "./agents-store.ts";
import { renderAgents, renderTodos, type PaintTheme, type WidthUtils } from "./render.ts";
import { fitLineByPriority, type PrioritizedSegment } from "./layout.ts";
import { resolveGlyphs } from "./icons.ts";
import { agentPanelRows, panelRows } from "./viewport.ts";
import type { AgentRow, CockpitConfig, TodoItem } from "./types.ts";
import { agentListWindowRows, scrollWindowStart, type AgentScrollState } from "./agent-scroll.ts";
import { tuiT } from "./tui-i18n.ts";

export interface TodoWidgetDeps {
	getTodos: () => TodoItem[];
	getConfig: () => CockpitConfig;
	/** Effective expansion may temporarily yield to a visible Agent panel. */
	getExpanded?: () => boolean;
	/** False when no redraw loop is running, so spinners must not freeze mid-cycle. */
	isAnimating?: () => boolean;
}

export interface AgentWidgetDeps {
	getAgents: () => AgentRow[];
	getConfig: () => CockpitConfig;
	isRunning: () => boolean;
	isAnimating?: () => boolean;
	/** True while selected-session detail shares the Agent height allowance. */
	hasSessionDetail?: () => boolean;
	/** Scroll window over the roster; absent → tail-following, non-scrollable. */
	getScroll?: () => AgentScrollState;
	setScroll?: (next: AgentScrollState) => void;
}

const UTILS: WidthUtils = { measure: visibleWidth, clip: truncateToWidth };

// The TUI exposes the live terminal size, but a widget must never fail to render
// because a host handed it a stub without one.
export function terminalRows(tui: TUI): number | undefined {
	try {
		const rows = tui.terminal?.rows;
		return typeof rows === "number" && rows > 0 ? rows : undefined;
	} catch {
		return undefined;
	}
}

export function visibleAgentRows(rows: AgentRow[]): AgentRow[] {
	const byId = new Map(rows.map((row) => [row.correlationId, row]));
	return rows.filter((row) => !row.agent.startsWith("graph(")).map((row) => {
		let parent = row.parentCorrelationId;
		const visited = new Set([row.correlationId]);
		while (parent) {
			if (visited.has(parent)) {
				parent = undefined;
				break;
			}
			visited.add(parent);
			const parentRow = byId.get(parent);
			if (!parentRow || !parentRow.agent.startsWith("graph(")) break;
			parent = parentRow.parentCorrelationId;
		}
		return parent === row.parentCorrelationId ? row : { ...row, parentCorrelationId: parent };
	});
}

// Todo widget: pinned above the editor (setWidget "cockpit-stack", aboveEditor).
export function makeTodoWidget(deps: TodoWidgetDeps) {
	return (tui: TUI, theme: Theme) => {
		const paint: PaintTheme = theme;
		return {
			render(width: number): string[] {
				const cfg = deps.getConfig();
				const todos = deps.getTodos();
				if (todos.length === 0) return [];
				const expanded = deps.getExpanded?.() ?? cfg.todoExpanded;
				const g = resolveGlyphs(cfg.icons.mode);
				// Todo row glyphs come from the glyph table (a hollow rectangle for
				// in-progress), never the animation clock — see render.ts todoPaint.
				const opts = {
					glyphs: g,
					expanded,
					maxRows: panelRows(terminalRows(tui)),
				};
				return renderTodos(todos, expanded ? "list" : cfg.todoMode, width, paint, UTILS, opts);
			},
			invalidate(): void {},
			dispose(): void {},
		};
	};
}

// Agent widget: pinned below the editor, near the input box (setWidget "cockpit-agents", belowEditor).
export function makeAgentWidget(deps: AgentWidgetDeps) {
	return (tui: TUI, theme: Theme) => {
		const paint: PaintTheme = theme;
		return {
			render(width: number): string[] {
				const cfg = deps.getConfig();
				// Agent rows update while teammate runs. Leave the final terminal column
				// untouched so auto-wrap cannot move the real cursor below pi-tui's model.
				const liveWidth = Math.max(1, width - 1);
				// graph(...) is the dispatch container, not an additional worker. Keep it
				// in AgentsStore for linkage and cleanup, and bridge its visible descendants
				// to the nearest non-graph ancestor for rendering.
				const roster = visibleAgentRows(deps.getAgents());
				if (roster.length === 0) return [];
				// Quiet mode keeps the roster fully expanded (role, task, state, duration,
				// tool, tokens) but strips the live streaming tail: that per-message text
				// updates on every teammate message and is exactly the dynamic noise quiet
				// mode exists to suppress. Header counts are tail-independent, so reading
				// them from the stripped rows leaves the summary unchanged.
				const agents = cfg.quietMode
					? roster.map((row) => (row.tail ? { ...row, tail: "" } : row))
					: roster;
				const g = resolveGlyphs(cfg.icons.mode);
				const now = Date.now();
				// Row-leading status glyphs never spin (see todo widget above).
				const spin = g.dotRunning;
				const running = deps.isRunning();

				const dot = theme.fg(running ? "success" : "muted", running ? g.dotRunning : g.dotIdle);
				const displayStatuses = agents.map((agent) => effectiveAgentStatus(agent, now));
				const failedCount = displayStatuses.filter((status) => status === "failed").length;
				const terminatedCount = displayStatuses.filter((status) => status === "terminated").length;
				const stalledCount = displayStatuses.filter((status) => status === "stalled").length;
				const runCount = displayStatuses.filter((status) => status === "running" || status === "retrying").length;
				const pendingCount = displayStatuses.filter((status) => status === "pending").length;
				const sleepingCount = displayStatuses.filter((status) => status === "sleeping").length;
				// This header owns the roster summary, so compact mode must not print
				// its own count line right underneath saying the same thing.
				const headerSegs: PrioritizedSegment[] = [
					{ text: dot, priority: 100, clippable: false },
					{ text: theme.fg("muted", tuiT("widget.agents.title")), priority: 90, clippable: false },
				];
				if (failedCount) {
					headerSegs.push({ text: theme.fg("error", tuiT("common.failed", { count: failedCount })), priority: 95, clippable: false });
				}
				if (stalledCount) headerSegs.push({ text: theme.fg("error", tuiT("common.stalled", { count: stalledCount })), priority: 94, clippable: false });
				if (terminatedCount) headerSegs.push({ text: theme.fg("warning", tuiT("common.terminated", { count: terminatedCount })), priority: 85, clippable: false });
				if (runCount) headerSegs.push({ text: theme.fg("dim", tuiT("common.running", { count: runCount })), priority: 80, clippable: false });
				if (pendingCount) headerSegs.push({ text: theme.fg("dim", tuiT("common.pending", { count: pendingCount })), priority: 60, clippable: false });
				if (sleepingCount) headerSegs.push({ text: theme.fg("dim", tuiT("common.sleeping", { count: sleepingCount })), priority: 50, clippable: false });
				const headerLine = fitLineByPriority(headerSegs, liveWidth, UTILS, theme.fg("dim", g.separator), g.ellipsis);
				// Focused-session priority: while a selected session's detail block is
				// open, it owns the Agent height allowance and the roster collapses to
				// this one-line summary. The per-agent rows stay reachable through the
				// session bar and its Alt+R selection flow, so monitoring is preserved
				// while the session content gains the released rows.
				if (deps.hasSessionDetail?.()) return [headerLine];

				// The panel budget covers the roster header and its rows.
				// Oldest-first storage makes the following suffix the newest activity;
				// renderAgents restores the tree's newest-first presentation.
				const panel = agentPanelRows(terminalRows(tui));
				const rosterRows = panel === undefined
					? undefined
					: Math.max(1, panel - 1);
				const ordered = [...agents].sort(
					(a, b) => a.lastActivityAt - b.lastActivityAt || a.correlationId.localeCompare(b.correlationId),
				);
				const windowRows = agentListWindowRows(
					tui.terminal?.columns,
					terminalRows(tui),
					ordered.length,
					panel,
				);
				const scroll = deps.getScroll?.() ?? { offset: 0, following: true };
				const start = scrollWindowStart(ordered.length, windowRows, scroll);
				const visible = ordered.slice(start, start + windowRows);
				const above = start;
				const below = Math.max(0, ordered.length - start - windowRows);
				const opts = {
					glyphs: g,
					spin,
					now,
					maxRows: rosterRows,
					hideLiveDuration: cfg.staticMode,
					agentContextRows: agents,
				};
				const lines: string[] = [];
				// Was the one line in the package pushed without any width clipping.
				lines.push(headerLine);
				const marker = above > 0 || below > 0
					? truncateToWidth(
						theme.fg("dim", [
							above > 0 ? `↑ ${tuiT("common.more", { count: above })}` : "",
							below > 0 ? `↓ ${tuiT("common.more", { count: below })}` : "",
						].filter(Boolean).join(` ${g.separator} `)),
						liveWidth,
						g.ellipsis,
					)
					: undefined;
				if (marker && above > 0) lines.push(marker);
				lines.push(...renderAgents(visible, cfg.agentsMode, liveWidth, paint, UTILS, { ...opts, withHead: false, maxRows: windowRows + 1 }));
				if (marker && above === 0) lines.push(marker);
				return lines;
			},
			invalidate(): void {},
			dispose(): void {},
		};
	};
}
