import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import test from "node:test";
import {
	SETTINGS_ANNOUNCE_EVENT,
	SETTINGS_DISCOVER_EVENT,
	SETTINGS_PROTOCOL_VERSION,
	type SettingsAnnounceEventV1,
	type SettingsContextV1,
} from "pi-maestro-settings-core/v1";
import { DEFAULT_CONFIG, type CockpitConfig } from "../src/types.ts";
import { createCockpitSettingsProvider, registerCockpitSettingsProvider } from "../src/settings/cockpit-provider.ts";
import type { SettingsEventBus } from "../src/settings/registry.ts";

const context: SettingsContextV1 = { cwd: "/workspace", locale: "en" };

class FakeEventBus implements SettingsEventBus {
	readonly emitted: Array<{ event: string; payload: unknown }> = [];
	private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
	on(event: string, handler: (payload: unknown) => void): () => void {
		const handlers = this.handlers.get(event) ?? new Set();
		handlers.add(handler);
		this.handlers.set(event, handlers);
		return () => handlers.delete(handler);
	}
	emit(event: string, payload: unknown): void {
		this.emitted.push({ event, payload });
		for (const handler of this.handlers.get(event) ?? []) handler(payload);
	}
}

function tempConfig(): { directory: string; path: string } {
	const directory = mkdtempSync(join(tmpdir(), "cockpit-provider-"));
	return { directory, path: join(directory, "cockpit.json") };
}

function providerAt(path: string, hooks: {
	apply?: (config: CockpitConfig, keys: readonly string[]) => void;
	action?: (name: string) => void;
} = {}) {
	let runtime = structuredClone(DEFAULT_CONFIG);
	const provider = createCockpitSettingsProvider({
		getConfigPath: () => path,
		getRuntimeConfig: () => runtime,
		applyRuntimeConfig: (config, keys) => {
			runtime = config;
			hooks.apply?.(config, keys);
		},
		getThemeName: () => "cockpit-ocean",
		getThinkingFolded: () => true,
		openLegacySettings: () => hooks.action?.("legacy"),
		openThemeSettings: () => hooks.action?.("theme"),
		toggleThinkingFold: () => hooks.action?.("thinking"),
	});
	return { provider, get runtime() { return runtime; } };
}

test("Cockpit provider describes editable settings and host-owned actions", async () => {
	const { directory, path } = tempConfig();
	try {
		const { provider } = providerAt(path);
		const description = await provider.describe({ context });
		assert.equal(description.id, "pi-cockpit");
		const pinEditor = description.settings.find((setting) => setting.key === "pinEditorBottom");
		assert.equal(pinEditor?.editor.kind, "boolean");
		assert.equal(pinEditor?.defaultValue, false);
		assert.equal(pinEditor?.descriptionKey, "cockpit.pinEditorBottom.description");
		assert.ok(description.settings.some((setting) => setting.key === "staticMode" && setting.editor.kind === "boolean"));
		assert.ok(description.settings.some((setting) => setting.key === "toolPalette" && setting.editor.kind === "enum"));
		assert.ok(description.settings.some((setting) => setting.key === "sidebar.width" && setting.editor.kind === "integer"));
		assert.ok(description.settings.some((setting) => setting.key === "theme" && setting.editor.kind === "action"));
		const keys = new Set(description.settings.flatMap((entry) => [
			entry.group,
			entry.labelKey,
			...(entry.descriptionKey ? [entry.descriptionKey] : []),
			...(entry.editor.options?.map((option) => option.labelKey) ?? []),
		]));
		for (const locale of ["en", "zh-CN"] as const) {
			const catalog = description.catalogs?.[locale];
			assert.ok(catalog);
			for (const key of keys) assert.equal(typeof catalog[key], "string", `${locale} missing ${key}`);
		}
		const snapshot = await provider.read({ context });
		assert.equal(snapshot.effective.values.find((value) => value.key === "theme")?.value, "cockpit-ocean");
		assert.equal(snapshot.effective.values.find((value) => value.key === "thinkingFold")?.value, true);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("prepare and commit preserve unknown fields and apply runtime after durable save", async () => {
	const { directory, path } = tempConfig();
	try {
		writeFileSync(path, JSON.stringify({
			...DEFAULT_CONFIG,
			unknownTop: { keep: true },
			icons: { mode: "auto", unknownIcon: 7 },
			sidebar: { ...DEFAULT_CONFIG.sidebar, unknownSidebar: "keep" },
		}, null, 2));
		let applied: readonly string[] = [];
		const state = providerAt(path, { apply: (_config, keys) => { applied = keys; } });
		const before = await state.provider.read({ context });
		const changes = [
			{ operation: "set" as const, key: "staticMode", scope: "global" as const, value: true },
			{ operation: "set" as const, key: "toolPalette", scope: "global" as const, value: "mono" },
			{ operation: "set" as const, key: "sidebar.width", scope: "global" as const, value: 48 },
			{ operation: "set" as const, key: "icons.mode", scope: "global" as const, value: "ascii" },
			{ operation: "set" as const, key: "pinEditorBottom", scope: "global" as const, value: true },
		];
		const prepared = await state.provider.prepare!({
			context,
			transactionId: "tx-1",
			changes,
			expectedRevisions: before.configured.resources,
		});
		assert.equal(prepared.prepared, true);
		const committed = await state.provider.commit!({ context, transactionId: "tx-1", prepareToken: prepared.prepareToken! });
		await state.provider.applyRuntime!({ context, transactionId: "tx-1", changes, snapshot: committed.snapshot });
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		assert.deepEqual(raw.unknownTop, { keep: true });
		assert.equal((raw.icons as Record<string, unknown>).unknownIcon, 7);
		assert.equal((raw.sidebar as Record<string, unknown>).unknownSidebar, "keep");
		assert.equal((raw.sidebar as Record<string, unknown>).width, 48);
		assert.equal((raw.icons as Record<string, unknown>).mode, "ascii");
		assert.equal(raw.staticMode, true);
		assert.equal(raw.toolPalette, "mono");
		assert.deepEqual(applied, ["staticMode", "toolPalette", "sidebar.width", "icons.mode", "pinEditorBottom"]);
		assert.equal(state.runtime.staticMode, true);
		assert.equal(state.runtime.toolPalette, "mono");
		assert.equal(state.runtime.sidebar.width, 48);
		assert.equal(state.runtime.pinEditorBottom, true);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("prepare rejects stale etags without overwriting an external edit", async () => {
	const { directory, path } = tempConfig();
	try {
		const { provider } = providerAt(path);
		const before = await provider.read({ context });
		writeFileSync(path, JSON.stringify({ ...DEFAULT_CONFIG, enabled: false }));
		const result = await provider.prepare!({
			context,
			transactionId: "tx-conflict",
			changes: [{ operation: "set", key: "enabled", scope: "global", value: true }],
			expectedRevisions: before.configured.resources,
		});
		assert.equal(result.prepared, false);
		assert.equal(result.conflicts?.length, 1);
		assert.equal((JSON.parse(readFileSync(path, "utf8")) as { enabled: boolean }).enabled, false);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("committed changes can roll back to the exact previous document", async () => {
	const { directory, path } = tempConfig();
	try {
		const original = `${JSON.stringify({ ...DEFAULT_CONFIG, marker: "before" }, null, 2)}\n`;
		writeFileSync(path, original);
		const { provider } = providerAt(path);
		const before = await provider.read({ context });
		const prepared = await provider.prepare!({
			context,
			transactionId: "tx-rollback",
			changes: [{ operation: "set", key: "enabled", scope: "global", value: false }],
			expectedRevisions: before.configured.resources,
		});
		const committed = await provider.commit!({ context, transactionId: "tx-rollback", prepareToken: prepared.prepareToken! });
		const rollback = await provider.rollback!({
			context,
			transactionId: "tx-rollback",
			prepareToken: prepared.prepareToken!,
			committedRevisions: committed.revisions,
		});
		assert.equal(rollback.rolledBack, true);
		assert.equal(readFileSync(path, "utf8"), original);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("quiet disable is persisted but reported as reload-required", async () => {
	const { directory, path } = tempConfig();
	try {
		writeFileSync(path, JSON.stringify({ ...DEFAULT_CONFIG, quietMode: true }));
		const { provider } = providerAt(path);
		const before = await provider.read({ context });
		const prepared = await provider.prepare!({
			context,
			transactionId: "tx-quiet",
			changes: [{ operation: "set", key: "quietMode", scope: "global", value: false }],
			expectedRevisions: before.configured.resources,
		});
		assert.deepEqual(prepared.activation, [{
			boundary: "extension-reload",
			keys: ["quietMode"],
			messageKey: "cockpit.runtime.reloadQuiet",
		}]);
		await provider.abort!({ context, transactionId: "tx-quiet", prepareToken: prepared.prepareToken! });
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("interaction settings describe with defaults off and complete bilingual keys", async () => {
	const { directory, path } = tempConfig();
	try {
		const { provider } = providerAt(path);
		const description = await provider.describe({ context });
		for (const key of ["doubleEscapeClearInput", "fullscreenInput", "copyOnSelect"]) {
			const setting = description.settings.find((candidate) => candidate.key === key);
			assert.ok(setting, `${key} must be described`);
			assert.equal(setting.editor.kind, "boolean");
			assert.equal(setting.defaultValue, false);
			assert.ok(setting.descriptionKey);
		}
		const activationByKey = new Map(description.settings.map((setting) => [setting.key, setting.activation]));
		assert.equal(activationByKey.get("doubleEscapeClearInput"), "extension-reload");
		assert.equal(activationByKey.get("fullscreenInput"), "extension-reload");
		assert.equal(activationByKey.get("copyOnSelect"), "live");
		const labelKeys = ["cockpit.doubleEscapeClearInput", "cockpit.fullscreenInput", "cockpit.copyOnSelect"];
		const descriptionKeys = ["cockpit.doubleEscapeClearInput.description", "cockpit.fullscreenInput.description", "cockpit.copyOnSelect.description"];
		for (const locale of ["en", "zh-CN"] as const) {
			const catalog = description.catalogs?.[locale];
			assert.ok(catalog);
			for (const key of [...labelKeys, ...descriptionKeys]) assert.equal(typeof catalog[key], "string", `${locale} missing ${key}`);
		}
		const snapshot = await provider.read({ context });
		for (const key of ["doubleEscapeClearInput", "fullscreenInput", "copyOnSelect"]) {
			assert.equal(snapshot.effective.values.find((value) => value.key === key)?.value, false);
		}
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("fullscreen/double-escape changes are persisted but reported reload-required; copy is live", async () => {
	const { directory, path } = tempConfig();
	try {
		const { provider } = providerAt(path);
		const before = await provider.read({ context });
		const prepared = await provider.prepare!({
			context,
			transactionId: "tx-interactions",
			changes: [
				{ operation: "set", key: "fullscreenInput", scope: "global", value: true },
				{ operation: "set", key: "doubleEscapeClearInput", scope: "global", value: true },
				{ operation: "set", key: "copyOnSelect", scope: "global", value: true },
			],
			expectedRevisions: before.configured.resources,
		});
		assert.deepEqual(prepared.activation, [
			{ boundary: "live", keys: ["copyOnSelect"] },
			{ boundary: "extension-reload", keys: ["fullscreenInput", "doubleEscapeClearInput"], messageKey: "cockpit.runtime.reloadInteractions" },
		]);
		await provider.abort!({ context, transactionId: "tx-interactions", prepareToken: prepared.prepareToken! });
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("interaction settings accept only boolean values", async () => {
	const { directory, path } = tempConfig();
	try {
		const { provider } = providerAt(path);
		const before = await provider.read({ context });
		const prepared = await provider.prepare!({
			context,
			transactionId: "tx-invalid",
			changes: [{ operation: "set", key: "fullscreenInput", scope: "global", value: "yes" }],
			expectedRevisions: before.configured.resources,
		});
		assert.equal(prepared.prepared, false);
		assert.equal(prepared.validation.issues.some((issue) => issue.key === "fullscreenInput"), true);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("actions and provider discovery stay owned by Cockpit", async () => {
	const { directory, path } = tempConfig();
	try {
		const actions: string[] = [];
		const { provider } = providerAt(path, { action: (name) => actions.push(name) });
		await provider.invokeAction!({ context, actionId: "cockpit.theme", key: "theme" });
		await provider.invokeAction!({ context, actionId: "cockpit.thinkingFold", key: "thinkingFold" });
		assert.deepEqual(actions, ["theme", "thinking"]);

		const bus = new FakeEventBus();
		registerCockpitSettingsProvider(bus, provider);
		bus.emit(SETTINGS_DISCOVER_EVENT, { version: SETTINGS_PROTOCOL_VERSION, requestId: "request", context });
		const announcements = bus.emitted.filter((entry) => entry.event === SETTINGS_ANNOUNCE_EVENT);
		assert.equal(announcements.length, 2);
		assert.equal((announcements[1]?.payload as SettingsAnnounceEventV1).providerId, "pi-cockpit");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("commit restores the previous bytes when the post-rename read fails", async () => {
	const { directory, path } = tempConfig();
	try {
		const beforeBytes = `${JSON.stringify({ ...DEFAULT_CONFIG, staticMode: false }, null, 2)}\n`;
		writeFileSync(path, beforeBytes);
		const state = providerAt(path);
		const before = await state.provider.read({ context });
		const prepared = await state.provider.prepare!({
			context,
			transactionId: "read-fail",
			changes: [{ operation: "set", key: "staticMode", scope: "global", value: true }],
			expectedRevisions: before.configured.resources,
		});
		assert.equal(prepared.prepared, true);

		// Fail the read that follows the rename: the commit must restore the previous
		// bytes while still holding the lock instead of leaving a half-applied config.
		const { createRequire, syncBuiltinESMExports } = await import("node:module");
		const mutableFs = createRequire(import.meta.url)("node:fs") as typeof fs;
		const originalRead = mutableFs.readFileSync;
		let injected = false;
		mutableFs.readFileSync = ((filePath: fs.PathLike, options?: unknown) => {
			if (!injected && resolvePath(String(filePath)) === resolvePath(path)) {
				injected = true;
				throw Object.assign(new Error("injected post-rename config read failure"), { code: "EIO" });
			}
			return originalRead(filePath, options as BufferEncoding | undefined);
		}) as typeof fs.readFileSync;
		syncBuiltinESMExports();
		try {
			await assert.rejects(
				async () => await state.provider.commit!({ context, transactionId: "read-fail", prepareToken: prepared.prepareToken! }),
				/injected post-rename config read failure/,
			);
		} finally {
			mutableFs.readFileSync = originalRead;
			syncBuiltinESMExports();
		}
		// The rename already happened, so the config must have been restored to the
		// pre-commit bytes (staticMode stays false).
		const restored = JSON.parse(readFileSync(path, "utf8")) as { staticMode?: boolean };
		assert.equal(restored.staticMode, false);
		assert.equal(readFileSync(path, "utf8"), beforeBytes);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});
