import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderAgents, renderTodos, type PaintTheme, type WidthUtils } from "./render.ts";
import { renderBashBgSummary } from "./bash-bg-widget.ts";
import { resolveGlyphs } from "./icons.ts";
import type { AgentRow, BashBgJob, CockpitConfig, TodoItem } from "./types.ts";

export interface TodoWidgetDeps {
	getTodos: () => TodoItem[];
	getConfig: () => CockpitConfig;
}

export interface AgentWidgetDeps {
	getAgents: () => AgentRow[];
	getBashBgJobs: () => BashBgJob[];
	getConfig: () => CockpitConfig;
	isRunning: () => boolean;
}

const UTILS: WidthUtils = { measure: visibleWidth, clip: truncateToWidth };

// Todo widget: pinned above the editor (setWidget "cockpit-stack", aboveEditor).
export function makeTodoWidget(deps: TodoWidgetDeps) {
	return (_tui: TUI, theme: Theme) => {
		const paint: PaintTheme = theme;
		return {
			render(width: number): string[] {
				const cfg = deps.getConfig();
				const todos = deps.getTodos();
				if (todos.length === 0) return [];
				const g = resolveGlyphs(cfg.icons.mode);
				const spin = g.spinFrames[Math.floor(Date.now() / 120) % g.spinFrames.length];
				const opts = { glyphs: g, spin, now: Date.now(), expanded: cfg.todoExpanded };
				return renderTodos(todos, cfg.todoExpanded ? "list" : cfg.todoMode, width, paint, UTILS, opts);
			},
			invalidate(): void {},
			dispose(): void {},
		};
	};
}

// Agent widget: pinned below the editor, near the input box (setWidget "cockpit-agents", belowEditor).
export function makeAgentWidget(deps: AgentWidgetDeps) {
	return (_tui: TUI, theme: Theme) => {
		const paint: PaintTheme = theme;
		return {
			render(width: number): string[] {
				const cfg = deps.getConfig();
				const agents = deps.getAgents();
				const bashBgJobs = deps.getBashBgJobs();
				const g = resolveGlyphs(cfg.icons.mode);
				const now = Date.now();
				const spin = g.spinFrames[Math.floor(now / 120) % g.spinFrames.length];
				const bashBgLines = renderBashBgSummary(bashBgJobs, width, paint, UTILS, {
					glyphs: g,
					spin,
					now,
				});
				if (agents.length === 0) return bashBgLines;
				const running = deps.isRunning();
				const opts = { glyphs: g, spin, now };
				const dot = theme.fg(running ? "success" : "muted", running ? g.dotRunning : g.dotIdle);
				const failedCount = agents.filter((a) => a.status === "failed").length;
				const runCount = agents.filter((a) => a.status === "running" || a.status === "retrying").length;
				const pendingCount = agents.filter((a) => a.status === "pending").length;
				const sleepingCount = agents.filter((a) => a.status === "sleeping").length;
				const summaryParts = [
					runCount ? `${runCount} running` : "",
					pendingCount ? `${pendingCount} pending` : "",
					sleepingCount ? `${sleepingCount} sleeping` : "",
					failedCount ? theme.fg("error", `${failedCount} failed`) : "",
				].filter(Boolean).join(theme.fg("dim", " · "));
				const lines: string[] = [];
				lines.push(`${dot} ${theme.fg("muted", "AGENTS")} ${theme.fg("dim", summaryParts)}`);
				lines.push(...renderAgents(agents, cfg.agentsMode, width, paint, UTILS, opts));
				lines.push(...bashBgLines);
				return lines;
			},
			invalidate(): void {},
			dispose(): void {},
		};
	};
}
