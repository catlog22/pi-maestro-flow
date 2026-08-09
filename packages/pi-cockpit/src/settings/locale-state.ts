import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	detectSystemSettingsLocale,
	normalizeSettingsLocale,
	resolveSettingsLocale,
	type SupportedSettingsLocale,
	type SystemSettingsLocaleOptions,
} from "pi-maestro-settings-core/v1";
import { cockpitTuiLocale, type CockpitTuiLocale } from "../tui-i18n.ts";
import type { SettingsProviderRegistry } from "./registry.ts";

export const MAESTRO_UI_PREFERENCES_VERSION = 1 as const;

export interface MaestroUiPreferences {
	version: typeof MAESTRO_UI_PREFERENCES_VERSION;
	locale: SupportedSettingsLocale;
}

export interface MaestroUiPreferencesSnapshot {
	preferences: MaestroUiPreferences;
	etag: string;
	error?: string;
}

export interface SaveMaestroUiPreferencesResult {
	ok: boolean;
	snapshot?: MaestroUiPreferencesSnapshot;
	conflict?: { expectedEtag: string; actualEtag: string };
	error?: string;
}

export interface SettingsLocaleDetectionOptions extends SystemSettingsLocaleOptions {
	detectSystemLocale?: (options?: SystemSettingsLocaleOptions) => SupportedSettingsLocale;
}

export interface SettingsLocaleStateOptions extends SettingsLocaleDetectionOptions {
	runtimeLocale?: CockpitTuiLocale;
}

export function getMaestroUiPreferencesPath(agentDir: string): string {
	return join(agentDir, "maestro-ui.json");
}

function etag(content: string | undefined): string {
	return createHash("sha256").update(content ?? "<missing>").digest("hex");
}

function systemOptions(options: SettingsLocaleDetectionOptions): SystemSettingsLocaleOptions {
	return {
		...(options.environment === undefined ? {} : { environment: options.environment }),
		...(options.resolvedLocale === undefined ? {} : { resolvedLocale: options.resolvedLocale }),
	};
}

function systemLocale(options: SettingsLocaleDetectionOptions): SupportedSettingsLocale {
	return (options.detectSystemLocale ?? detectSystemSettingsLocale)(systemOptions(options));
}

function persistedLocale(value: unknown, options: SettingsLocaleDetectionOptions): SupportedSettingsLocale {
	if (value === undefined || value === null) return systemLocale(options);
	if (typeof value !== "string") throw new Error("locale must be a string");
	const requested = value.trim();
	if (requested === "" || requested.toLowerCase() === "auto") return systemLocale(options);
	const language = requested.replaceAll("_", "-").split("-", 1)[0]?.toLowerCase();
	if (language !== "en" && language !== "zh") {
		throw new Error(`unsupported locale: ${requested}`);
	}
	return resolveSettingsLocale(requested, systemOptions(options));
}

export function loadMaestroUiPreferences(
	path: string,
	options: SettingsLocaleDetectionOptions = {},
): MaestroUiPreferencesSnapshot {
	if (!existsSync(path)) {
		return {
			preferences: { version: MAESTRO_UI_PREFERENCES_VERSION, locale: systemLocale(options) },
			etag: etag(undefined),
		};
	}
	try {
		const content = readFileSync(path, "utf8");
		const raw = JSON.parse(content) as unknown;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("root must be an object");
		const locale = persistedLocale((raw as { locale?: unknown }).locale, options);
		return {
			preferences: { version: MAESTRO_UI_PREFERENCES_VERSION, locale },
			etag: etag(content),
		};
	} catch (error) {
		return {
			preferences: { version: MAESTRO_UI_PREFERENCES_VERSION, locale: systemLocale(options) },
			etag: etag(readFileSafely(path)),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function saveMaestroUiPreferences(
	path: string,
	preferences: MaestroUiPreferences,
	expectedEtag: string,
): SaveMaestroUiPreferencesResult {
	const currentContent = readFileSafely(path);
	const actualEtag = etag(currentContent);
	if (actualEtag !== expectedEtag) {
		return { ok: false, conflict: { expectedEtag, actualEtag } };
	}
	const normalized: MaestroUiPreferences = {
		version: MAESTRO_UI_PREFERENCES_VERSION,
		locale: normalizeSettingsLocale(preferences.locale),
	};
	const content = `${JSON.stringify(normalized, null, 2)}\n`;
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
		renameSync(temporaryPath, path);
		return {
			ok: true,
			snapshot: { preferences: normalized, etag: etag(content) },
		};
	} catch (error) {
		try { if (existsSync(temporaryPath)) rmSync(temporaryPath); } catch { /* best effort */ }
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export class SettingsLocaleState {
	private snapshot: MaestroUiPreferencesSnapshot;

	constructor(
		private readonly path: string,
		private readonly registry: SettingsProviderRegistry,
		private readonly options: SettingsLocaleStateOptions = {},
	) {
		this.snapshot = loadMaestroUiPreferences(path, options);
		this.runtimeLocale.setLocale(this.snapshot.preferences.locale);
	}

	private get runtimeLocale(): CockpitTuiLocale {
		return this.options.runtimeLocale ?? cockpitTuiLocale;
	}

	get locale(): SupportedSettingsLocale {
		return this.snapshot.preferences.locale;
	}

	get current(): MaestroUiPreferencesSnapshot {
		return this.snapshot;
	}

	reload(): MaestroUiPreferencesSnapshot {
		this.snapshot = loadMaestroUiPreferences(this.path, this.options);
		this.runtimeLocale.setLocale(this.snapshot.preferences.locale);
		return this.snapshot;
	}

	setLocale(locale: string): SaveMaestroUiPreferencesResult {
		const result = saveMaestroUiPreferences(
			this.path,
			{ version: MAESTRO_UI_PREFERENCES_VERSION, locale: normalizeSettingsLocale(locale) },
			this.snapshot.etag,
		);
		if (result.ok && result.snapshot) {
			this.snapshot = result.snapshot;
			this.runtimeLocale.setLocale(this.snapshot.preferences.locale);
			this.registry.emitLocale(this.snapshot.preferences.locale);
		}
		return result;
	}
}

function readFileSafely(path: string): string | undefined {
	try {
		return existsSync(path) ? readFileSync(path, "utf8") : undefined;
	} catch {
		return undefined;
	}
}
