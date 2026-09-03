import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type CockpitConfig, type CurrencyMode, DEFAULT_CONFIG, type StackStyle, type UsageConfig } from "./types.ts";

const SIDEBAR_MIN_WIDTH = 32;
const SIDEBAR_MAX_WIDTH = 56;

export function getConfigPath(): string {
	return join(getAgentDir(), "cockpit.json");
}

// Flat, field-by-field merge: type-safe and forward-compatible (unknown keys ignored).
const USAGE_POLL_MIN_MS = 30_000;
const USAGE_POLL_MAX_MS = 30 * 60_000;
const USAGE_BAR_MIN_WIDTH = 4;
const USAGE_BAR_MAX_WIDTH = 16;

function mergeUsageConfig(base: UsageConfig, raw: unknown): UsageConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...base };
	const o = raw as Record<string, unknown>;
	const isBool = (v: unknown): v is boolean => typeof v === "boolean";
	const isFiniteInt = (v: unknown): v is number =>
		typeof v === "number" && Number.isFinite(v) && Number.isSafeInteger(v);
	const pollIntervalMs = isFiniteInt(o.pollIntervalMs)
		? o.pollIntervalMs <= 0
			? 0 // 0 = manual refresh: no background poll, /usage fetches on open and on `r`
			: Math.min(USAGE_POLL_MAX_MS, Math.max(USAGE_POLL_MIN_MS, o.pollIntervalMs))
		: base.pollIntervalMs;
	const barWidth = isFiniteInt(o.barWidth)
		? Math.min(USAGE_BAR_MAX_WIDTH, Math.max(USAGE_BAR_MIN_WIDTH, o.barWidth))
		: base.barWidth;
	return {
		enabled: isBool(o.enabled) ? o.enabled : base.enabled,
		footer: isBool(o.footer) ? o.footer : base.footer,
		pollIntervalMs,
		barWidth,
		commandKey: typeof o.commandKey === "string" && o.commandKey.trim() ? o.commandKey : base.commandKey,
	};
}

export function mergeConfig(base: CockpitConfig, over: unknown): CockpitConfig {
	if (!over || typeof over !== "object" || Array.isArray(over)) return base;
	const o = over as Record<string, unknown>;
	const isMode = (v: unknown): v is "list" | "compact" => v === "list" || v === "compact";
	const isQuietSymbolMode = (v: unknown): v is "check" | "dot" => v === "check" || v === "dot";
	const isToolPaletteMode = (v: unknown): v is "classic" | "family" | "readwrite" | "search" | "mono" =>
		v === "classic" || v === "family" || v === "readwrite" || v === "search" || v === "mono";
	const isIconMode = (v: unknown): v is "auto" | "nerd" | "ascii" => v === "auto" || v === "nerd" || v === "ascii";
	const isStackStyle = (v: unknown): v is StackStyle => v === "classic" || v === "zen";
const isCurrencyMode = (v: unknown): v is CurrencyMode => v === "usd" || v === "cny";
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
	const titleRaw = o.title && typeof o.title === "object" && !Array.isArray(o.title)
		? (o.title as Record<string, unknown>)
		: undefined;
	const isBool = (v: unknown): v is boolean => typeof v === "boolean";
	const titleMaxLength = titleRaw && typeof titleRaw.maxLength === "number" && Number.isFinite(titleRaw.maxLength)
		? Math.min(200, Math.max(20, Math.round(titleRaw.maxLength)))
		: base.title.maxLength;
	return {
		enabled: typeof o.enabled === "boolean" ? o.enabled : base.enabled,
		staticMode: typeof o.staticMode === "boolean" ? o.staticMode : base.staticMode,
		quietMode: typeof o.quietMode === "boolean" ? o.quietMode : base.quietMode,
		quietSymbols: isQuietSymbolMode(o.quietSymbols) ? o.quietSymbols : base.quietSymbols,
		toolPalette: isToolPaletteMode(o.toolPalette) ? o.toolPalette : base.toolPalette,
		agentsMode: isMode(o.agentsMode) ? o.agentsMode : base.agentsMode,
		todoMode: isMode(o.todoMode) ? o.todoMode : base.todoMode,
		todoExpanded: typeof o.todoExpanded === "boolean" ? o.todoExpanded : base.todoExpanded,
		todoDurationChart: typeof o.todoDurationChart === "boolean" ? o.todoDurationChart : base.todoDurationChart,
		stackStyle: isStackStyle(o.stackStyle) ? o.stackStyle : base.stackStyle,
		hideNativeAgents: typeof o.hideNativeAgents === "boolean" ? o.hideNativeAgents : base.hideNativeAgents,
		pinEditorBottom: typeof o.pinEditorBottom === "boolean" ? o.pinEditorBottom : base.pinEditorBottom,
		doubleEscapeClearInput: typeof o.doubleEscapeClearInput === "boolean" ? o.doubleEscapeClearInput : base.doubleEscapeClearInput,
		fullscreenInput: typeof o.fullscreenInput === "boolean" ? o.fullscreenInput : base.fullscreenInput,
		copyOnSelect: typeof o.copyOnSelect === "boolean" ? o.copyOnSelect : base.copyOnSelect,
		historyEnabled: typeof o.historyEnabled === "boolean" ? o.historyEnabled : base.historyEnabled,
		currency: isCurrencyMode(o.currency) ? o.currency : base.currency,
		currencyRate: typeof o.currencyRate === "number" && Number.isFinite(o.currencyRate) && o.currencyRate > 0
			? Math.min(100, Math.max(0.01, Math.round(o.currencyRate * 100) / 100))
			: base.currencyRate,
		icons: { mode: iconsRaw && isIconMode(iconsRaw.mode) ? iconsRaw.mode : base.icons.mode },
		sidebar: {
			mode: sidebarRaw && isSidebarMode(sidebarRaw.mode) ? sidebarRaw.mode : base.sidebar.mode,
			width: sidebarWidth,
			density: sidebarRaw && isSidebarDensity(sidebarRaw.density) ? sidebarRaw.density : base.sidebar.density,
		},
		title: {
			enabled: isBool(titleRaw?.enabled) ? titleRaw!.enabled : base.title.enabled,
			showSession: isBool(titleRaw?.showSession) ? titleRaw!.showSession : base.title.showSession,
			showCwd: isBool(titleRaw?.showCwd) ? titleRaw!.showCwd : base.title.showCwd,
			showModel: isBool(titleRaw?.showModel) ? titleRaw!.showModel : base.title.showModel,
			showThinking: isBool(titleRaw?.showThinking) ? titleRaw!.showThinking : base.title.showThinking,
			showGit: isBool(titleRaw?.showGit) ? titleRaw!.showGit : base.title.showGit,
			showMaestro: isBool(titleRaw?.showMaestro) ? titleRaw!.showMaestro : base.title.showMaestro,
			generationModel: titleRaw && typeof titleRaw.generationModel === "string"
				? titleRaw.generationModel
				: base.title.generationModel,
			maxLength: titleMaxLength,
		},
		theme: typeof o.theme === "string" ? o.theme : base.theme,
		usage: mergeUsageConfig(base.usage, o.usage),
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

export function mergeConfigDocument(raw: unknown, config: CockpitConfig): Record<string, unknown> {
	const root = raw && typeof raw === "object" && !Array.isArray(raw)
		? { ...(raw as Record<string, unknown>) }
		: {};
	const icons = root.icons && typeof root.icons === "object" && !Array.isArray(root.icons)
		? { ...(root.icons as Record<string, unknown>), mode: config.icons.mode }
		: { mode: config.icons.mode };
	const sidebar = root.sidebar && typeof root.sidebar === "object" && !Array.isArray(root.sidebar)
		? {
			...(root.sidebar as Record<string, unknown>),
			mode: config.sidebar.mode,
			width: config.sidebar.width,
			density: config.sidebar.density,
		}
		: { ...config.sidebar };
	const title = root.title && typeof root.title === "object" && !Array.isArray(root.title)
		? { ...(root.title as Record<string, unknown>), ...config.title }
		: { ...config.title };
	const usage = root.usage && typeof root.usage === "object" && !Array.isArray(root.usage)
		? { ...(root.usage as Record<string, unknown>), ...config.usage }
		: { ...config.usage };
	return {
		...root,
		enabled: config.enabled,
		staticMode: config.staticMode,
		quietMode: config.quietMode,
		quietSymbols: config.quietSymbols,
		toolPalette: config.toolPalette,
		agentsMode: config.agentsMode,
		todoMode: config.todoMode,
		todoExpanded: config.todoExpanded,
		todoDurationChart: config.todoDurationChart,
		stackStyle: config.stackStyle,
		hideNativeAgents: config.hideNativeAgents,
		pinEditorBottom: config.pinEditorBottom,
		doubleEscapeClearInput: config.doubleEscapeClearInput,
		fullscreenInput: config.fullscreenInput,
		copyOnSelect: config.copyOnSelect,
		historyEnabled: config.historyEnabled,
		currency: config.currency,
		currencyRate: config.currencyRate,
		icons,
		sidebar,
		title,
		usage,
		theme: config.theme,
	};
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
		let raw: unknown = {};
		try { if (existsSync(path)) raw = JSON.parse(readFileSync(path, "utf8")); } catch { /* replace malformed config */ }
		writeFileSync(tmp, JSON.stringify(mergeConfigDocument(raw, config), null, 2) + "\n", "utf8");
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
