import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderAgents, renderTodos, type PaintTheme, type WidthUtils } from "./render.ts";
import { renderBashBgSummary } from "./bash-bg-widget.ts";
import { fitLineByPriority, type PrioritizedSegment } from "./layout.ts";
import { resolveGlyphs, spinFrame } from "./icons.ts";
import { panelRows } from "./viewport.ts";
import type { AgentRow, BashBgJob, CockpitConfig, TodoItem } from "./types.ts";

export interface TodoWidgetDeps {
	getTodos: () => TodoItem[];
	getConfig: () => CockpitConfig;
	/** False when no redraw loop is running, so spinners must not freeze mid-cycle. */
	isAnimating?: () => boolean;
}

export interface AgentWidgetDeps {
	getAgents: () => AgentRow[];
	getBashBgJobs: () => BashBgJob[];
	getConfig: () => CockpitConfig;
	isRunning: () => boolean;
	isAnimating?: () => boolean;
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

// Todo widget: pinned above the editor (setWidget "cockpit-stack", aboveEditor).
export function makeTodoWidget(deps: TodoWidgetDeps) {
	return (tui: TUI, theme: Theme) => {
		const paint: PaintTheme = theme;
		return {
			render(width: number): string[] {
				const cfg = deps.getConfig();
				const todos = deps.getTodos();
				if (todos.length === 0) return [];
				const g = resolveGlyphs(cfg.icons.mode);
				const now = Date.now();
				const spin = spinFrame(g, now, deps.isAnimating?.() ?? true);
				const opts = {
					glyphs: g,
					spin,
					now,
					expanded: cfg.todoExpanded,
					maxRows: panelRows(terminalRows(tui)),
				};
				return renderTodos(todos, cfg.todoExpanded ? "list" : cfg.todoMode, width, paint, UTILS, opts);
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
				const agents = deps.getAgents();
				const bashBgJobs = deps.getBashBgJobs();
				const g = resolveGlyphs(cfg.icons.mode);
				const now = Date.now();
				const animating = deps.isAnimating?.() ?? true;
				const spin = spinFrame(g, now, animating);
				const bashBgLines = renderBashBgSummary(bashBgJobs, width, paint, UTILS, {
					glyphs: g,
					spin,
					now,
				});
				if (agents.length === 0) return bashBgLines;
				const running = deps.isRunning();
				// The panel budget covers everything this widget prints, so the header
				// and the background strip are charged to it before the roster is.
				const panel = panelRows(terminalRows(tui));
				const rosterRows = panel === undefined
					? undefined
					: Math.max(1, panel - 1 - bashBgLines.length);
				const opts = { glyphs: g, spin, now, maxRows: rosterRows };
				const dot = theme.fg(running ? "success" : "muted", running ? g.dotRunning : g.dotIdle);
				const failedCount = agents.filter((a) => a.status === "failed").length;
				const runCount = agents.filter((a) => a.status === "running" || a.status === "retrying").length;
				const pendingCount = agents.filter((a) => a.status === "pending").length;
				const sleepingCount = agents.filter((a) => a.status === "sleeping").length;
				// This header owns the roster summary, so compact mode must not print
				// its own count line right underneath saying the same thing.
				const headerSegs: PrioritizedSegment[] = [
					{ text: dot, priority: 100, clippable: false },
					{ text: theme.fg("muted", "Agents"), priority: 90, clippable: false },
				];
				if (failedCount) {
					headerSegs.push({ text: theme.fg("error", `${failedCount} failed`), priority: 95, clippable: false });
				}
				if (runCount) headerSegs.push({ text: theme.fg("dim", `${runCount} running`), priority: 80, clippable: false });
				if (pendingCount) headerSegs.push({ text: theme.fg("dim", `${pendingCount} pending`), priority: 60, clippable: false });
				if (sleepingCount) headerSegs.push({ text: theme.fg("dim", `${sleepingCount} sleeping`), priority: 50, clippable: false });
				const lines: string[] = [];
				// Was the one line in the package pushed without any width clipping.
				lines.push(fitLineByPriority(headerSegs, width, UTILS, theme.fg("dim", g.separator), g.ellipsis));
				lines.push(...renderAgents(agents, cfg.agentsMode, width, paint, UTILS, { ...opts, withHead: false }));
				lines.push(...bashBgLines);
				return lines;
			},
			invalidate(): void {},
			dispose(): void {},
		};
	};
}
