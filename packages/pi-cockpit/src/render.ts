import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { AgentRow, TodoItem, ViewMode } from "./types.ts";

// Width helpers are injected (see footer.ts rationale): pure functions stay hermetic,
// the real widget injects pi-tui's visibleWidth / truncateToWidth.
export interface WidthUtils {
	measure: (text: string) => number;
	clip: (text: string, width: number, ellipsis: string) => string;
}

export type PaintTheme = Pick<Theme, "fg">;

export interface RenderOpts {
	ascii?: boolean;
	spin?: string;
}

// Pi themes expose only semantic colors, so roles map onto them (no free cyan/green).
const ROLE_COLOR: Record<string, ThemeColor> = {
	explorer: "mdLink",
	delegate: "mdLink",
	executor: "success",
	reviewer: "warning",
	debugger: "error",
	planner: "accent",
	main: "success",
};

function roleColor(role: string): ThemeColor {
	return ROLE_COLOR[role] ?? "text";
}

// Empty roster => no lines (the bare-pi guard: nothing to draw, widget stays hidden).
export function renderAgents(
	rows: readonly AgentRow[],
	mode: ViewMode,
	width: number,
	theme: PaintTheme,
	utils: WidthUtils,
	opts: RenderOpts = {},
): string[] {
	if (rows.length === 0) return [];
	const ell = theme.fg("dim", "…");
	if (mode === "compact") {
		const n = rows.length;
		return [utils.clip(theme.fg("muted", `${n} agent${n === 1 ? "" : "s"} running`), width, ell)];
	}
	const spin = opts.spin ?? "~";
	return rows.map((r) => {
		const glyph = r.status === "failed" ? "✕" : r.status === "done" ? "✓" : spin;
		const rc = roleColor(r.role);
		const id = r.correlationId.length > 6 ? r.correlationId.slice(0, 6) : r.correlationId;
		const segs = [theme.fg(rc, glyph), theme.fg(rc, r.role), theme.fg("dim", `#${id}`)];
		if (r.task) segs.push(r.task);
		if (r.tail) segs.push(theme.fg("dim", r.tail));
		return utils.clip(segs.join("  "), width, ell);
	});
}

export function renderTodos(
	items: readonly TodoItem[],
	mode: ViewMode,
	width: number,
	theme: PaintTheme,
	utils: WidthUtils,
	opts: RenderOpts = {},
): string[] {
	if (items.length === 0) return [];
	const ell = theme.fg("dim", "…");
	const ascii = opts.ascii === true;
	const spin = opts.spin ?? "~";

	if (mode === "compact") {
		const total = items.length;
		const done = items.filter((i) => i.status === "completed").length;
		const pct = total ? Math.round((done / total) * 100) : 0;
		const cell = (st: TodoItem["status"]): string => {
			if (st === "completed") return theme.fg("success", ascii ? "#" : "█");
			if (st === "in_progress") return theme.fg("accent", ascii ? "+" : "▓");
			if (st === "blocked") return theme.fg("error", "!");
			return theme.fg("dim", ascii ? "-" : "░");
		};
		const bar = items.map((i) => cell(i.status)).join("");
		const cur = items.find((i) => i.status === "in_progress");
		const nxt = items.find((i) => i.status === "pending");
		const label = cur ? `now ${cur.subject}` : nxt ? `next ${nxt.subject}` : done === total ? "all done" : "";
		const tail = ` ${theme.fg("muted", `${pct}%`)}` + (label ? ` ${theme.fg("dim", label)}` : "");
		return [utils.clip(bar + tail, width, ell)];
	}

	return items.map((it, i) => {
		const num = String(i + 1).padStart(2, "0");
		let glyph: string;
		let color: ThemeColor;
		let tc: ThemeColor;
		switch (it.status) {
			case "completed":
				glyph = "✓";
				color = "success";
				tc = "dim";
				break;
			case "in_progress":
				glyph = spin;
				color = "accent";
				tc = "text";
				break;
			case "blocked":
				glyph = "!";
				color = "error";
				tc = "error";
				break;
			default:
				glyph = "·";
				color = "dim";
				tc = "muted";
		}
		return utils.clip(`${theme.fg("dim", num)} ${theme.fg(color, glyph)} ${theme.fg(tc, it.subject)}`, width, ell);
	});
}
