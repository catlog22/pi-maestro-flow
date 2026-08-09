import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CockpitTuiLocale } from "../src/tui-i18n.ts";
import { SettingsLocaleState, loadMaestroUiPreferences, saveMaestroUiPreferences } from "../src/settings/locale-state.ts";
import { SettingsProviderRegistry } from "../src/settings/registry.ts";

function withTempDir(run: (directory: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "cockpit-locale-"));
	try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

const EN_SYSTEM = { environment: { LANG: "en_US.UTF-8" }, resolvedLocale: "zh-CN" } as const;
const ZH_SYSTEM = { environment: { LANG: "zh_CN.UTF-8" }, resolvedLocale: "en-US" } as const;

test("missing locale preferences derive deterministic English and Chinese system defaults", () => withTempDir((directory) => {
	const path = join(directory, "maestro-ui.json");
	assert.equal(loadMaestroUiPreferences(path, EN_SYSTEM).preferences.locale, "en");
	assert.equal(loadMaestroUiPreferences(path, ZH_SYSTEM).preferences.locale, "zh-CN");
}));

test("a persisted explicit locale remains authoritative over system detection", () => withTempDir((directory) => {
	const path = join(directory, "maestro-ui.json");
	writeFileSync(path, JSON.stringify({ version: 1, locale: "en" }));
	const loaded = loadMaestroUiPreferences(path, {
		...ZH_SYSTEM,
		detectSystemLocale: () => { throw new Error("explicit preferences must not detect"); },
	});
	assert.equal(loaded.preferences.locale, "en");
	assert.equal(loaded.error, undefined);
}));

test("invalid JSON and unsupported locale preferences fall back to the injected system locale", () => withTempDir((directory) => {
	const invalidJson = join(directory, "invalid-json.json");
	writeFileSync(invalidJson, "{");
	const invalidJsonResult = loadMaestroUiPreferences(invalidJson, ZH_SYSTEM);
	assert.equal(invalidJsonResult.preferences.locale, "zh-CN");
	assert.match(invalidJsonResult.error ?? "", /JSON|position|property/i);

	const unsupported = join(directory, "unsupported.json");
	writeFileSync(unsupported, JSON.stringify({ version: 1, locale: "fr-FR" }));
	const unsupportedResult = loadMaestroUiPreferences(unsupported, ZH_SYSTEM);
	assert.equal(unsupportedResult.preferences.locale, "zh-CN");
	assert.match(unsupportedResult.error ?? "", /unsupported locale: fr-FR/);
}));

test("locale preferences persist atomically", () => withTempDir((directory) => {
	const path = join(directory, "maestro-ui.json");
	const initial = loadMaestroUiPreferences(path, EN_SYSTEM);
	const saved = saveMaestroUiPreferences(path, { version: 1, locale: "zh-CN" }, initial.etag);
	assert.equal(saved.ok, true);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, locale: "zh-CN" });
	assert.equal(loadMaestroUiPreferences(path, EN_SYSTEM).preferences.locale, "zh-CN");
}));

test("locale preferences reject stale writes", () => withTempDir((directory) => {
	const path = join(directory, "maestro-ui.json");
	const initial = loadMaestroUiPreferences(path, EN_SYSTEM);
	writeFileSync(path, JSON.stringify({ version: 1, locale: "zh-CN" }));
	const result = saveMaestroUiPreferences(path, { version: 1, locale: "en" }, initial.etag);
	assert.equal(result.ok, false);
	assert.ok(result.conflict);
}));

test("locale state synchronizes runtime locale on load, reload, and successful changes", () => withTempDir((directory) => {
	const path = join(directory, "maestro-ui.json");
	const emitted: Array<{ event: string; payload: unknown }> = [];
	const registry = new SettingsProviderRegistry({
		on: () => undefined,
		emit: (event, payload) => emitted.push({ event, payload }),
	});
	const runtimeLocale = new CockpitTuiLocale({ locale: "en" });
	const state = new SettingsLocaleState(path, registry, { ...ZH_SYSTEM, runtimeLocale });
	assert.equal(state.locale, "zh-CN");
	assert.equal(runtimeLocale.locale, "zh-CN");

	writeFileSync(path, JSON.stringify({ version: 1, locale: "en" }));
	state.reload();
	assert.equal(state.locale, "en");
	assert.equal(runtimeLocale.locale, "en");

	assert.equal(state.setLocale("zh").ok, true);
	assert.equal(state.locale, "zh-CN");
	assert.equal(runtimeLocale.locale, "zh-CN");
	assert.equal(emitted.length, 1);
	const payload = emitted[0]?.payload as { version?: unknown; locale?: unknown; generation?: unknown };
	assert.equal(payload.version, 1);
	assert.equal(payload.locale, "zh-CN");
	assert.equal(typeof payload.generation, "string");
}));
