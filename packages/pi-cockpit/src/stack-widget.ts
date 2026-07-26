import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderAgents, renderTodos, type PaintTheme, type WidthUtils } from "./render.ts";
import type { AgentRow, CockpitConfig, TodoItem } from "./types.ts";

const SPIN = "⠋⠙⠹⠴⠦⠇";

export interface StackDeps {
	getAgents: () => AgentRow[];
	getTodos: () => TodoItem[];
	getConfig: () => CockpitConfig;
	isRunning: () => boolean;
}

const UTILS: WidthUtils = { measure: visibleWidth, clip: truncateToWidth };

// Factory for ctx.ui.setWidget("cockpit-stack", factory, { placement: "aboveEditor" }).
// Returns the Component contract Pi expects: render(width) + invalidate() + dispose().
export function makeStackWidget(deps: StackDeps) {
	return (_tui: TUI, theme: Theme) => {
		const paint: PaintTheme = theme;
		return {
			render(width: number): string[] {
				const cfg = deps.getConfig();
				const agents = deps.getAgents();
				const todos = deps.getTodos();
				const running = deps.isRunning();
				const spin = SPIN[Math.floor(Date.now() / 120) % SPIN.length];
				const opts = { ascii: false, spin };
				const dot = theme.fg(running ? "success" : "muted", running ? "●" : "·");
				const lines: string[] = [];
				if (agents.length > 0) {
					lines.push(`${dot} ${theme.fg("muted", "AGENTS")} ${theme.fg("dim", `${agents.length} running`)}`);
					lines.push(...renderAgents(agents, cfg.agentsMode, width, paint, UTILS, opts));
				}
				if (todos.length > 0) {
					const done = todos.filter((t) => t.status === "completed").length;
					lines.push(`${dot} ${theme.fg("muted", "TODO")} ${theme.fg("dim", `${done}/${todos.length}`)}`);
					lines.push(...renderTodos(todos, cfg.todoMode, width, paint, UTILS, opts));
				}
				if (agents.length === 0 && todos.length === 0) return [];
				return lines;
			},
			invalidate(): void {},
			dispose(): void {},
		};
	};
}
