import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsLocaleState, loadMaestroUiPreferences, saveMaestroUiPreferences } from "../src/settings/locale-state.ts";
import { SettingsProviderRegistry } from "../src/settings/registry.ts";

function withTempDir(run: (directory: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "cockpit-locale-"));
	try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("locale preferences default to English and persist atomically", () => withTempDir((directory) => {
	const path = join(directory, "maestro-ui.json");
	const initial = loadMaestroUiPreferences(path);
	assert.equal(initial.preferences.locale, "en");
	const saved = saveMaestroUiPreferences(path, { version: 1, locale: "zh-CN" }, initial.etag);
	assert.equal(saved.ok, true);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, locale: "zh-CN" });
	assert.equal(loadMaestroUiPreferences(path).preferences.locale, "zh-CN");
}));

test("locale preferences reject stale writes", () => withTempDir((directory) => {
	const path = join(directory, "maestro-ui.json");
	const initial = loadMaestroUiPreferences(path);
	writeFileSync(path, JSON.stringify({ version: 1, locale: "zh-CN" }));
	const result = saveMaestroUiPreferences(path, { version: 1, locale: "en" }, initial.etag);
	assert.equal(result.ok, false);
	assert.ok(result.conflict);
}));

test("locale state publishes only successful changes", () => withTempDir((directory) => {
	const emitted: Array<{ event: string; payload: unknown }> = [];
	const registry = new SettingsProviderRegistry({
		on: () => undefined,
		emit: (event, payload) => emitted.push({ event, payload }),
	});
	const state = new SettingsLocaleState(join(directory, "maestro-ui.json"), registry);
	assert.equal(state.setLocale("zh").ok, true);
	assert.equal(state.locale, "zh-CN");
	assert.equal(emitted.length, 1);
	const payload = emitted[0]?.payload as { version?: unknown; locale?: unknown; generation?: unknown };
	assert.equal(payload.version, 1);
	assert.equal(payload.locale, "zh-CN");
	assert.equal(typeof payload.generation, "string");
}));
