import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { CockpitEndpoint } from "./endpoint-store.ts";
import type { SessionUiState } from "./session-ui-state.ts";
import { formatUnreadCount, renderSessionTabLine, type SessionTab } from "./session-tabs.ts";

export interface WindowBarDeps {
	getWindows: () => readonly CockpitEndpoint[];
	getState: () => SessionUiState;
	getMonitoredEndpointIds: () => readonly string[];
}

interface WindowTab extends SessionTab {
	endpoint: CockpitEndpoint;
	monitored: boolean;
}

function statusColor(endpoint: CockpitEndpoint): ThemeColor {
	if (endpoint.status === "running") return "warning";
	if (endpoint.status === "sleeping") return "muted";
	return "error";
}

function renderTab(tab: WindowTab, selected: boolean, theme: Theme): string {
	const color = statusColor(tab.endpoint);
	const marker = tab.monitored ? theme.fg("success", "●") : theme.fg("muted", "○");
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
	if (tabs.length === 0) return [theme.fg("muted", "Windows · no peer sessions")];
	return [renderSessionTabLine(tabs, width, {
		selectedId: state.selectedId("window"),
		renderTab: (tab, selected) => renderTab(tab, selected, theme),
		renderSummary: (selected) => {
			const pressure = selected.endpoint.contextPressure;
			const context = pressure === undefined ? "" : ` · ctx ${Math.round(pressure)}%`;
			return theme.fg(statusColor(selected.endpoint), `■ #${selected.label}${context}`);
		},
		renderUnreadSummary: (total) => theme.fg("warning", `+${formatUnreadCount(total)}`),
	})];
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
			);
		},
		invalidate(): void {},
		dispose(): void {},
	});
}
