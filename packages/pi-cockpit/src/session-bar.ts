/**
 * Session bar — the persistent teammate-session switcher pinned below the
 * input box. One row of agent-name chips; the chip for the agent currently
 * shown in the viewing session is highlighted. ←/→ (with an empty composer)
 * moves the highlight and opens/switches the viewed session; the bar itself is
 * display-only, so it stays visible in both the dock and widgets surfaces.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { AgentRow } from "./types.ts";
import { visibleAgentRows } from "./stack-widget.ts";

export const SESSION_BAR_WIDGET_KEY = "cockpit-session-bar";

export interface SessionBarDeps {
	getAgents: () => AgentRow[];
}

/** Render the one-line chips row; empty when there is nothing to switch. */
export function renderSessionBar(
	rows: AgentRow[],
	width: number,
	theme: Theme,
): string[] {
	const agents = visibleAgentRows(rows);
	if (agents.length === 0) return [];
	const w = Math.max(1, width);
	const chips = agents.map((row) => {
		const label = row.name || row.role || row.agent || "agent";
		const chip = `@${label}`;
		return row.viewing
			? `${theme.fg("accent", "▸")} ${theme.fg("accent", theme.bold(chip))}`
			: theme.fg("muted", chip);
	});
	return [truncateToWidth(chips.join("  "), w, "…")];
}

export function makeSessionBarWidget(deps: SessionBarDeps) {
	return (tui: TUI, theme: Theme) => ({
		render(width: number): string[] {
			return renderSessionBar(deps.getAgents(), width, theme);
		},
		invalidate(): void {},
		dispose(): void {},
	});
}
