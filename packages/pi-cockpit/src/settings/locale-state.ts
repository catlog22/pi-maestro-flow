import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	normalizeSettingsLocale,
	type SupportedSettingsLocale,
} from "pi-maestro-settings-core/v1";
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

const DEFAULT_PREFERENCES: MaestroUiPreferences = {
	version: MAESTRO_UI_PREFERENCES_VERSION,
	locale: "en",
};

export function getMaestroUiPreferencesPath(agentDir: string): string {
	return join(agentDir, "maestro-ui.json");
}

function etag(content: string | undefined): string {
	return createHash("sha256").update(content ?? "<missing>").digest("hex");
}

export function loadMaestroUiPreferences(path: string): MaestroUiPreferencesSnapshot {
	if (!existsSync(path)) {
		return { preferences: { ...DEFAULT_PREFERENCES }, etag: etag(undefined) };
	}
	try {
		const content = readFileSync(path, "utf8");
		const raw = JSON.parse(content) as unknown;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("root must be an object");
		const locale = normalizeSettingsLocale((raw as { locale?: unknown }).locale as string | undefined);
		return {
			preferences: { version: MAESTRO_UI_PREFERENCES_VERSION, locale },
			etag: etag(content),
		};
	} catch (error) {
		return {
			preferences: { ...DEFAULT_PREFERENCES },
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
	) {
		this.snapshot = loadMaestroUiPreferences(path);
	}

	get locale(): SupportedSettingsLocale {
		return this.snapshot.preferences.locale;
	}

	get current(): MaestroUiPreferencesSnapshot {
		return this.snapshot;
	}

	reload(): MaestroUiPreferencesSnapshot {
		this.snapshot = loadMaestroUiPreferences(this.path);
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
