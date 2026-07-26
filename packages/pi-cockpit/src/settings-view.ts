// Pure model for the /cockpit settings panel.
//
// The old panel was a flat list of blind letter accelerators: no cursor, no
// focused row, no indication of what a key would cycle to, and every keystroke
// wrote to disk while failures were swallowed. This module owns the row model and
// the cursor/cycle logic so the behaviour is unit-testable; index.ts only paints
// it and performs the actual save.

import type { CockpitConfig, IconMode, ViewMode } from "./types.ts";

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
const ICON_MODES: IconMode[] = ["auto", "nerd", "ascii"];

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

/**
 * Themes cycle through the host's list plus an explicit "leave it alone" entry.
 *
 * A pi theme setting may also be an automatic `light/dark` pair, which this ring
 * cannot build. Such a value is simply not in the ring, so it falls through to
 * the restart branch and lands on "" — "leave it alone" — rather than being
 * flattened into whichever single theme happened to come next.
 */
export function nextTheme(current: string, available: readonly string[]): string {
	const ring = ["", ...available.filter((name) => name !== "")];
	const index = ring.indexOf(current);
    // An unknown current theme (e.g. removed from disk) restarts the ring.
	return ring[(index === -1 ? 0 : index + 1) % ring.length];
}

export function buildRows(config: CockpitConfig, themes: readonly string[]): SettingsRow[] {
	return [
		{
			key: "enabled",
			accel: "e",
			label: "enabled",
			value: config.enabled ? "on" : "off",
			next: config.enabled ? "off" : "on",
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
			next: themeLabel(nextTheme(config.theme, themes)),
		},
	];
}

/** Apply the row's cycle to the config, returning a new config object. */
export function applyRow(
	config: CockpitConfig,
	key: string,
	themes: readonly string[],
): CockpitConfig {
	switch (key) {
		case "enabled":
			return { ...config, enabled: !config.enabled };
		case "agentsMode":
			return { ...config, agentsMode: cycle(VIEW_MODES, config.agentsMode) };
		case "todoMode":
			return { ...config, todoMode: cycle(VIEW_MODES, config.todoMode) };
		case "todoExpanded":
			return { ...config, todoExpanded: !config.todoExpanded };
		case "hideNativeAgents":
			return { ...config, hideNativeAgents: !config.hideNativeAgents };
		case "icons":
			return { ...config, icons: { mode: cycle(ICON_MODES, config.icons.mode) } };
		case "theme":
			return { ...config, theme: nextTheme(config.theme, themes) };
		default:
			return config;
	}
}

export function rowKeyForAccel(rows: readonly SettingsRow[], accel: string): string | undefined {
	return rows.find((row) => row.accel === accel)?.key;
}
