import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type CockpitConfig, DEFAULT_CONFIG } from "./types.ts";

const SIDEBAR_MIN_WIDTH = 32;
const SIDEBAR_MAX_WIDTH = 56;

export function getConfigPath(): string {
	return join(getAgentDir(), "cockpit.json");
}

// Flat, field-by-field merge: type-safe and forward-compatible (unknown keys ignored).
export function mergeConfig(base: CockpitConfig, over: unknown): CockpitConfig {
	if (!over || typeof over !== "object" || Array.isArray(over)) return base;
	const o = over as Record<string, unknown>;
	const isMode = (v: unknown): v is "list" | "compact" => v === "list" || v === "compact";
	const isQuietSymbolMode = (v: unknown): v is "check" | "dot" => v === "check" || v === "dot";
	const isToolPaletteMode = (v: unknown): v is "classic" | "family" | "readwrite" | "search" | "mono" =>
		v === "classic" || v === "family" || v === "readwrite" || v === "search" || v === "mono";
	const isIconMode = (v: unknown): v is "auto" | "nerd" | "ascii" => v === "auto" || v === "nerd" || v === "ascii";
	const isSidebarMode = (v: unknown): v is "auto" | "on" | "off" => v === "auto" || v === "on" || v === "off";
	const isSidebarDensity = (v: unknown): v is "comfortable" | "compact" => v === "comfortable" || v === "compact";
	const iconsRaw = o.icons && typeof o.icons === "object" && !Array.isArray(o.icons)
		? (o.icons as Record<string, unknown>)
		: undefined;
	const sidebarRaw = o.sidebar && typeof o.sidebar === "object" && !Array.isArray(o.sidebar)
		? (o.sidebar as Record<string, unknown>)
		: undefined;
	const sidebarWidth = sidebarRaw && typeof sidebarRaw.width === "number" && Number.isFinite(sidebarRaw.width)
		? Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(sidebarRaw.width)))
		: base.sidebar.width;
	return {
		enabled: typeof o.enabled === "boolean" ? o.enabled : base.enabled,
		quietMode: typeof o.quietMode === "boolean" ? o.quietMode : base.quietMode,
		quietSymbols: isQuietSymbolMode(o.quietSymbols) ? o.quietSymbols : base.quietSymbols,
		toolPalette: isToolPaletteMode(o.toolPalette) ? o.toolPalette : base.toolPalette,
		agentsMode: isMode(o.agentsMode) ? o.agentsMode : base.agentsMode,
		todoMode: isMode(o.todoMode) ? o.todoMode : base.todoMode,
		todoExpanded: typeof o.todoExpanded === "boolean" ? o.todoExpanded : base.todoExpanded,
		hideNativeAgents: typeof o.hideNativeAgents === "boolean" ? o.hideNativeAgents : base.hideNativeAgents,
		icons: { mode: iconsRaw && isIconMode(iconsRaw.mode) ? iconsRaw.mode : base.icons.mode },
		sidebar: {
			mode: sidebarRaw && isSidebarMode(sidebarRaw.mode) ? sidebarRaw.mode : base.sidebar.mode,
			width: sidebarWidth,
			density: sidebarRaw && isSidebarDensity(sidebarRaw.density) ? sidebarRaw.density : base.sidebar.density,
		},
		theme: typeof o.theme === "string" ? o.theme : base.theme,
	};
}

export function ensureConfigExists(): void {
	const path = getConfigPath();
	if (existsSync(path)) return;
	try {
		const dir = getAgentDir();
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
	} catch {
		// best-effort: a read-only or missing agent dir must not break the extension
	}
}

export function loadConfig(notify?: (msg: string, level: "warning" | "info") => void): CockpitConfig {
	const path = getConfigPath();
	if (!existsSync(path)) {
		ensureConfigExists();
		return structuredClone(DEFAULT_CONFIG);
	}
	try {
		return mergeConfig(DEFAULT_CONFIG, JSON.parse(readFileSync(path, "utf8")));
	} catch (err) {
		notify?.(`pi-cockpit config parse error: ${err instanceof Error ? err.message : String(err)}`, "warning");
		return structuredClone(DEFAULT_CONFIG);
	}
}

export interface SaveResult {
	ok: boolean;
	error?: string;
}

/**
 * Persist the config, reporting whether it actually landed.
 *
 * This used to swallow every failure, so on a read-only agent dir the settings
 * panel showed the new value while nothing was written and the change silently
 * vanished at next start. Writes go through a temp file + rename so an
 * interrupted write cannot leave a half-written config behind.
 */
export function saveConfig(config: CockpitConfig): SaveResult {
	const path = getConfigPath();
	const tmp = `${path}.tmp`;
	try {
		const dir = getAgentDir();
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
		renameSync(tmp, path);
		return { ok: true };
	} catch (err) {
		try {
			if (existsSync(tmp)) rmSync(tmp);
		} catch {
			// a stray temp file must not mask the original failure
		}
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
