import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { WindowThreadEntry } from "pi-maestro-teammate/v1/sessions";
import type { CockpitEndpoint } from "./endpoint-store.ts";

export interface WindowThreadScroll {
	offset: number;
	following: boolean;
}

export interface WindowThreadViewDeps {
	getWindow: () => CockpitEndpoint | undefined;
	getEntries: () => readonly WindowThreadEntry[];
	getVisible: () => boolean;
	getScroll: () => WindowThreadScroll;
}

function fit(value: string, width: number): string {
	return truncateToWidth(value.replace(/[\r\n]+/g, " "), Math.max(1, width), "…");
}

function messageLine(entry: WindowThreadEntry, width: number, theme: Theme): string {
	const direction = entry.direction === "outgoing" ? theme.fg("accent", "→") : theme.fg("success", "←");
	const source = entry.source === "monitor" ? theme.fg("warning", " monitor") : "";
	const status = entry.status === "accepted" ? theme.fg("success", "✓")
		: entry.status === "pending" ? theme.fg("warning", "…")
			: theme.fg("error", "!");
	return fit(`${direction}${source} ${entry.body} ${status}`, width);
}

export function windowThreadBody(
	window: CockpitEndpoint,
	entries: readonly WindowThreadEntry[],
	width: number,
	theme: Theme,
): string[] {
	const pressure = window.contextPressure === undefined ? "" : ` · context ${Math.round(window.contextPressure)}%`;
	const agents = window.remoteAgents ?? [];
	const lines = [
		fit(`${theme.bold(`#${window.label}`)} · ${window.status}${pressure} · ${window.agentCount ?? agents.length} agents`, width),
	];
	for (const agent of agents.filter((entry) => entry.status !== "settled").slice(0, 4)) {
		lines.push(fit(theme.fg("muted", `  @${agent.name ?? agent.agent ?? agent.correlationId?.slice(0, 8) ?? "agent"} · ${agent.status}${agent.summary ? ` · ${agent.summary}` : ""}`), width));
	}
	if (entries.length === 0) {
		lines.push(theme.fg("muted", fit("No messages in this window thread.", width)));
		return lines;
	}
	lines.push(theme.fg("muted", fit("Messages", width)));
	for (const entry of entries) lines.push(messageLine(entry, width, theme));
	return lines;
}

export function renderWindowThreadView(
	window: CockpitEndpoint | undefined,
	entries: readonly WindowThreadEntry[],
	width: number,
	maxRows: number,
	scroll: WindowThreadScroll,
	theme: Theme,
): string[] {
	if (!window) return [];
	const peerEntries = entries.filter((entry) =>
		entry.peerOwnerId === window.registryEndpoint?.ownerId
		&& entry.peerOwnerNonce === window.registryEndpoint?.ownerNonce
	);
	const body = windowThreadBody(window, peerEntries, width, theme);
	const budget = Math.max(1, Math.floor(maxRows));
	const maxOffset = Math.max(0, body.length - budget);
	const offset = scroll.following ? maxOffset : Math.min(maxOffset, Math.max(0, scroll.offset));
	const visible = body.slice(offset, offset + budget);
	if (offset > 0 && visible.length > 0) visible[0] = fit(`${theme.fg("muted", "↑ ")}${visible[0]}`, width);
	if (offset + budget < body.length && visible.length > 0) {
		const last = visible.length - 1;
		visible[last] = fit(`${visible[last]} ${theme.fg("muted", "↓")}`, width);
	}
	return visible.map((line) => visibleWidth(line) <= Math.max(1, width) ? line : fit(line, width));
}

export function makeWindowThreadWidget(deps: WindowThreadViewDeps) {
	return (_tui: TUI, theme: Theme) => ({
		render(width: number): string[] {
			if (!deps.getVisible()) return [];
			return renderWindowThreadView(deps.getWindow(), deps.getEntries(), width, 10, deps.getScroll(), theme);
		},
		invalidate(): void {},
		dispose(): void {},
	});
}
