import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type CockpitConfig, DEFAULT_CONFIG } from "./types.ts";

export function getConfigPath(): string {
	return join(getAgentDir(), "cockpit.json");
}

// Flat, field-by-field merge: type-safe and forward-compatible (unknown keys ignored).
function deepMerge(base: CockpitConfig, over: unknown): CockpitConfig {
	if (!over || typeof over !== "object" || Array.isArray(over)) return base;
	const o = over as Record<string, unknown>;
	const isMode = (v: unknown): v is "list" | "compact" => v === "list" || v === "compact";
	const isIconMode = (v: unknown): v is "auto" | "nerd" | "ascii" => v === "auto" || v === "nerd" || v === "ascii";
	const iconsRaw = o.icons && typeof o.icons === "object" && !Array.isArray(o.icons)
		? (o.icons as Record<string, unknown>)
		: undefined;
	return {
		enabled: typeof o.enabled === "boolean" ? o.enabled : base.enabled,
		agentsMode: isMode(o.agentsMode) ? o.agentsMode : base.agentsMode,
		todoMode: isMode(o.todoMode) ? o.todoMode : base.todoMode,
		todoExpanded: typeof o.todoExpanded === "boolean" ? o.todoExpanded : base.todoExpanded,
		hideNativeAgents: typeof o.hideNativeAgents === "boolean" ? o.hideNativeAgents : base.hideNativeAgents,
		icons: { mode: iconsRaw && isIconMode(iconsRaw.mode) ? iconsRaw.mode : base.icons.mode },
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
		return deepMerge(DEFAULT_CONFIG, JSON.parse(readFileSync(path, "utf8")));
	} catch (err) {
		notify?.(`pi-cockpit config parse error: ${err instanceof Error ? err.message : String(err)}`, "warning");
		return structuredClone(DEFAULT_CONFIG);
	}
}

export function saveConfig(config: CockpitConfig): void {
	const path = getConfigPath();
	try {
		const dir = getAgentDir();
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
	} catch {
		// best-effort
	}
}
