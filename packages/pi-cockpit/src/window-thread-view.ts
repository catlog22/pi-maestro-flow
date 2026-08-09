import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { SessionEndpoint, WindowThreadEntry } from "pi-maestro-teammate/v1/sessions";
import { assignedAgentColor } from "./agent-bar.ts";
import { tuiStatus, tuiT } from "./tui-i18n.ts";
import { isMonitorControlEndpoint, type CockpitEndpoint } from "./endpoint-store.ts";

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
	const source = entry.source === "monitor" ? theme.fg("warning", ` ${tuiT("window.source.monitor")}`) : "";
	const mode = theme.fg("muted", ` ${tuiT(entry.mode === "steer" ? "window.mode.steer" : "window.mode.followUp")}`);
	const status = entry.status === "accepted" ? theme.fg("success", "✓")
		: entry.status === "pending" ? theme.fg("warning", "…")
			: theme.fg("error", "!");
	return fit(`${direction}${source}${mode} ${entry.body} ${status}`, width);
}

function remoteAgentLine(agent: SessionEndpoint, width: number, theme: Theme): string {
	const marker = agent.status === "running" ? theme.fg("warning", "●")
		: agent.status === "sleeping" ? theme.fg("muted", "○")
			: theme.fg("success", "✓");
	const label = agent.name ?? agent.agent ?? agent.correlationId?.slice(0, 8) ?? "agent";
	const color = agent.status === "running"
		? assignedAgentColor(agent.correlationId ?? agent.id)
		: "muted";
	const summary = agent.summary ? ` · ${agent.summary}` : "";
	return fit(`  ${marker} ${theme.fg(color, `@${label}`)} · ${tuiStatus(agent.status)}${summary}`, width);
}

export function windowThreadBody(
	window: CockpitEndpoint,
	entries: readonly WindowThreadEntry[],
	width: number,
	theme: Theme,
): string[] {
	const pressure = window.contextPressure === undefined
		? ""
		: ` · ${tuiT("window.context", { percent: Math.round(window.contextPressure) })}`;
	const agents = window.remoteAgents ?? [];
	const lines = [
		fit(`${theme.bold(`#${window.label}`)} · ${tuiStatus(window.status)}${pressure} · ${tuiT("common.agents", {
			count: window.agentCount ?? agents.length,
		})}`, width),
	];
	for (const agent of agents.filter((entry) => entry.status !== "settled").slice(0, 4)) {
		lines.push(remoteAgentLine(agent, width, theme));
	}
	if (entries.length === 0) {
		lines.push(theme.fg("muted", fit(
			tuiT(isMonitorControlEndpoint(window) ? "window.currentCoordination" : "window.noMessages"),
			width,
		)));
		return lines;
	}
	lines.push(theme.fg("muted", fit(tuiT("window.messages"), width)));
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
