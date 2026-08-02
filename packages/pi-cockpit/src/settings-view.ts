// Pure model for the /cockpit settings panel.
//
// The old panel was a flat list of blind letter accelerators: no cursor, no
// focused row, no indication of what a key would cycle to, and every keystroke
// wrote to disk while failures were swallowed. This module owns the row model and
// the cursor/cycle logic so the behaviour is unit-testable; index.ts only paints
// it and performs the actual save.

import type {
	CockpitConfig,
	IconMode,
	QuietSymbolMode,
	SidebarDensity,
	SidebarMode,
	ToolPaletteMode,
	ViewMode,
} from "./types.ts";

export type SaveState =
	| { kind: "idle" }
	| { kind: "saving" }
	| { kind: "saved" }
	| { kind: "failed"; message: string };

export interface SettingsRow {
	key: string;
	/** Single-letter accelerator, kept as a secondary path alongside the cursor. */
	accel: string;
	label: string;
	value: string;
	/** What pressing Enter/Space/accel switches to — shown so the cycle is visible. */
	next: string;
}

const VIEW_MODES: ViewMode[] = ["list", "compact"];
const QUIET_SYMBOL_MODES: QuietSymbolMode[] = ["check", "dot"];
const TOOL_PALETTE_MODES: ToolPaletteMode[] = ["family", "readwrite", "search", "mono", "classic"];
const ICON_MODES: IconMode[] = ["auto", "nerd", "ascii"];
const SIDEBAR_MODES: SidebarMode[] = ["auto", "on", "off"];
const SIDEBAR_DENSITIES: SidebarDensity[] = ["comfortable", "compact"];

function cycle<T>(values: readonly T[], current: T): T {
	const index = values.indexOf(current);
	return values[(index + 1) % values.length];
}

// Empty means cockpit has not set a theme, so whatever /settings holds is live.
// It is deliberately not called "default": pi's setting is the authority here,
// and cockpit only ever nudges it.
const NO_THEME_LABEL = "(pi settings)";

function themeLabel(theme: string): string {
	return theme === "" ? NO_THEME_LABEL : theme;
}

export interface LiveRowState {
	/** pi's effective hideThinkingBlock; the thinking row is a pass-through. */
	thinkingHidden: boolean;
}

export function buildRows(config: CockpitConfig, live?: LiveRowState): SettingsRow[] {
	const thinkingHidden = live?.thinkingHidden ?? false;
	return [
		{
			key: "enabled",
			accel: "e",
			label: "enabled",
			value: config.enabled ? "on" : "off",
			next: config.enabled ? "off" : "on",
		},
		{
			key: "staticMode",
			accel: "m",
			label: "static mode",
			value: config.staticMode ? "on" : "off",
			next: config.staticMode ? "off" : "on",
		},
		{
			key: "pinEditorBottom",
			accel: "l",
			label: "pin input bottom",
			value: config.pinEditorBottom ? "on" : "off",
			next: config.pinEditorBottom ? "off" : "on",
		},
		{
			key: "quietMode",
			accel: "q",
			label: "quiet (reload)",
			value: config.quietMode ? "on" : "off",
			next: config.quietMode ? "off" : "on",
		},
		{
			key: "quietSymbols",
			accel: "s",
			label: "quiet symbols",
			value: config.quietSymbols,
			next: cycle(QUIET_SYMBOL_MODES, config.quietSymbols),
		},
		{
			// Pass-through to pi's native thinking toggle: the value mirrors pi's
			// persisted hideThinkingBlock and the panel dispatches the toggle
			// itself — applyRow deliberately ignores this key, like "theme".
			key: "thinkingFold",
			accel: "f",
			label: "thinking fold",
			value: thinkingHidden ? "hidden" : "visible",
			next: thinkingHidden ? "visible" : "hidden",
		},
		{
			// Colour grouping for the compact Quiet tool rows. Placed after the
			// quiet trio rather than inside it: it only matters when quiet mode is
			// on, and the mode/symbol/thinking order above is a tested invariant.
			key: "toolPalette",
			accel: "p",
			label: "tool palette",
			value: config.toolPalette,
			next: cycle(TOOL_PALETTE_MODES, config.toolPalette),
		},
		{
			key: "agentsMode",
			accel: "a",
			label: "agents",
			value: config.agentsMode,
			next: cycle(VIEW_MODES, config.agentsMode),
		},
		{
			key: "todoMode",
			accel: "t",
			label: "todo",
			value: config.todoMode,
			next: cycle(VIEW_MODES, config.todoMode),
		},
		{
			key: "todoExpanded",
			accel: "x",
			label: "todo expand",
			value: config.todoExpanded ? "yes" : "no",
			next: config.todoExpanded ? "no" : "yes",
		},
		{
			key: "hideNativeAgents",
			accel: "n",
			label: "hide native",
			value: config.hideNativeAgents ? "yes" : "no",
			next: config.hideNativeAgents ? "no" : "yes",
		},
		{
			key: "sidebarMode",
			accel: "b",
			label: "sidebar",
			value: config.sidebar.mode,
			next: cycle(SIDEBAR_MODES, config.sidebar.mode),
		},
		{
			key: "sidebarDensity",
			accel: "d",
			label: "sidebar density",
			value: config.sidebar.density,
			next: cycle(SIDEBAR_DENSITIES, config.sidebar.density),
		},
		{
			key: "icons",
			accel: "i",
			label: "icons",
			value: config.icons.mode,
			next: cycle(ICON_MODES, config.icons.mode),
		},
		{
			key: "theme",
			accel: "h",
			label: "theme",
			value: themeLabel(config.theme),
			// Not a cycle: this row opens the /theme picker, which previews live and
			// reverts on Esc. Blind-cycling a name list could not do either.
			//
			// Worded as an affordance, not as a command to go type: every other row's
			// `next` is the value Enter produces, and "open /theme" read as "leave this
			// panel and run something else" when Enter opens it right here. The ellipsis
			// is the usual terminal signal for "this one opens a dialog".
			next: "picker…",
		},
		// Terminal tab title surface. The session row is the summary the title
		// leads with; the rest are tags appended after the working state. maxLength
		// is a numeric field, so it stays in cockpit.json rather than the panel.
		{
			key: "titleEnabled",
			accel: "c",
			label: "title",
			value: config.title.enabled ? "on" : "off",
			next: config.title.enabled ? "off" : "on",
		},
		{
			key: "titleSession",
			accel: "u",
			label: "title session",
			value: config.title.showSession ? "on" : "off",
			next: config.title.showSession ? "off" : "on",
		},
		{
			key: "titleCwd",
			accel: "r",
			label: "title cwd",
			value: config.title.showCwd ? "on" : "off",
			next: config.title.showCwd ? "off" : "on",
		},
		{
			key: "titleModel",
			accel: "o",
			label: "title model",
			value: config.title.showModel ? "on" : "off",
			next: config.title.showModel ? "off" : "on",
		},
		{
			key: "titleThinking",
			accel: "y",
			label: "title thinking",
			value: config.title.showThinking ? "on" : "off",
			next: config.title.showThinking ? "off" : "on",
		},
		{
			key: "titleGit",
			accel: "g",
			label: "title git",
			value: config.title.showGit ? "on" : "off",
			next: config.title.showGit ? "off" : "on",
		},
		{
			key: "titleMaestro",
			accel: "w",
			label: "title maestro",
			value: config.title.showMaestro ? "on" : "off",
			next: config.title.showMaestro ? "off" : "on",
		},
	];
}

/** Apply the row's cycle to the config, returning a new config object. */
export function applyRow(config: CockpitConfig, key: string): CockpitConfig {
	switch (key) {
		case "enabled":
			return { ...config, enabled: !config.enabled };
		case "staticMode":
			return { ...config, staticMode: !config.staticMode };
		case "pinEditorBottom":
			return { ...config, pinEditorBottom: !config.pinEditorBottom };
		case "quietMode":
			return { ...config, quietMode: !config.quietMode };
		case "quietSymbols":
			return { ...config, quietSymbols: cycle(QUIET_SYMBOL_MODES, config.quietSymbols) };
		case "toolPalette":
			return { ...config, toolPalette: cycle(TOOL_PALETTE_MODES, config.toolPalette) };
		case "agentsMode":
			return { ...config, agentsMode: cycle(VIEW_MODES, config.agentsMode) };
		case "todoMode":
			return { ...config, todoMode: cycle(VIEW_MODES, config.todoMode) };
		case "todoExpanded":
			return { ...config, todoExpanded: !config.todoExpanded };
		case "hideNativeAgents":
			return { ...config, hideNativeAgents: !config.hideNativeAgents };
		case "sidebarMode":
			return {
				...config,
				sidebar: { ...config.sidebar, mode: cycle(SIDEBAR_MODES, config.sidebar.mode) },
			};
		case "sidebarDensity":
			return {
				...config,
				sidebar: { ...config.sidebar, density: cycle(SIDEBAR_DENSITIES, config.sidebar.density) },
			};
		case "icons":
			return { ...config, icons: { mode: cycle(ICON_MODES, config.icons.mode) } };
		case "titleEnabled":
			return { ...config, title: { ...config.title, enabled: !config.title.enabled } };
		case "titleSession":
			return { ...config, title: { ...config.title, showSession: !config.title.showSession } };
		case "titleCwd":
			return { ...config, title: { ...config.title, showCwd: !config.title.showCwd } };
		case "titleModel":
			return { ...config, title: { ...config.title, showModel: !config.title.showModel } };
		case "titleThinking":
			return { ...config, title: { ...config.title, showThinking: !config.title.showThinking } };
		case "titleGit":
			return { ...config, title: { ...config.title, showGit: !config.title.showGit } };
		case "titleMaestro":
			return { ...config, title: { ...config.title, showMaestro: !config.title.showMaestro } };
		// "theme" is intentionally absent: the row hands off to the /theme picker,
		// which owns both the preview and the write-through to pi's settings.
		// "thinkingFold" is absent for the same reason: pi owns hideThinkingBlock,
		// and the panel dispatches pi's native toggle instead of cycling config.
		default:
			return config;
	}
}

export function rowKeyForAccel(rows: readonly SettingsRow[], accel: string): string | undefined {
	return rows.find((row) => row.accel === accel)?.key;
}
