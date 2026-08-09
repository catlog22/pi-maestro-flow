import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { CockpitEndpoint } from "./endpoint-store.ts";
import { isMonitorControlEndpoint } from "./endpoint-store.ts";
import type { SessionUiState } from "./session-ui-state.ts";
import { assignedAgentColor, renderSessionBarLine } from "./agent-bar.ts";
import { formatUnreadCount, renderSessionTabLine, type SessionTab } from "./session-tabs.ts";

export interface WindowBarDeps {
	getWindows: () => readonly CockpitEndpoint[];
	getState: () => SessionUiState;
	getMonitoredEndpointIds: () => readonly string[];
	getShortcutHint?: () => string | undefined;
}

export interface WindowBarRenderOptions {
	shortcutHint?: string;
}

interface WindowTab extends SessionTab {
	endpoint: CockpitEndpoint;
	monitored: boolean;
}

export function windowSessionColor(endpoint: CockpitEndpoint): ThemeColor {
	if (isMonitorControlEndpoint(endpoint)) return "accent";
	if (endpoint.status === "running") {
		return assignedAgentColor(endpoint.registryEndpoint?.ownerId ?? endpoint.id);
	}
	if (endpoint.status === "sleeping") return "muted";
	return "error";
}

function renderTab(tab: WindowTab, selected: boolean, theme: Theme): string {
	const color = selected ? "accent" : windowSessionColor(tab.endpoint);
	const marker = isMonitorControlEndpoint(tab.endpoint)
		? theme.fg("accent", "◆")
		: tab.monitored ? theme.fg("success", "●") : theme.fg("muted", "○");
	const unread = (tab.unread ?? 0) > 0 ? theme.fg("warning", ` ${formatUnreadCount(tab.unread ?? 0)}`) : "";
	const label = `#${tab.label}`;
	return selected
		? `${marker} ${theme.fg(color, theme.bold(`▸ ${label}`))}${unread}`
		: `${marker} ${theme.fg(color, label)}${unread}`;
}

export function renderWindowBar(
	windows: readonly CockpitEndpoint[],
	state: SessionUiState,
	monitoredEndpointIds: readonly string[],
	width: number,
	theme: Theme,
	options: WindowBarRenderOptions = {},
): string[] {
	const monitored = new Set(monitoredEndpointIds);
	const tabs: WindowTab[] = windows.map((endpoint) => ({
		id: endpoint.id,
		label: endpoint.label,
		ordinal: endpoint.ordinal,
		unread: state.endpoint(endpoint.id).unread,
		endpoint,
		monitored: monitored.has(endpoint.id),
	}));
	if (tabs.length === 0) {
		return [truncateToWidth(theme.fg("muted", "Windows · no peer sessions"), Math.max(1, width), "…")];
	}
	return [renderSessionBarLine(
		(availableWidth) => renderSessionTabLine(tabs, availableWidth, {
			selectedId: state.selectedId("window"),
			renderTab: (tab, selected) => renderTab(tab, selected, theme),
			renderUnreadSummary: (total) => theme.fg("warning", `+${formatUnreadCount(total)}`),
		}),
		width,
		theme,
		options.shortcutHint,
	)];
}

export function makeWindowBarWidget(deps: WindowBarDeps) {
	return (_tui: TUI, theme: Theme) => ({
		render(width: number): string[] {
			return renderWindowBar(
				deps.getWindows(),
				deps.getState(),
				deps.getMonitoredEndpointIds(),
				width,
				theme,
				{ shortcutHint: deps.getShortcutHint?.() },
			);
		},
		invalidate(): void {},
		dispose(): void {},
	});
}
