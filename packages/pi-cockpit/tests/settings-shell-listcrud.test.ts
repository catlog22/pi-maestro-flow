import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	SETTINGS_PROTOCOL_VERSION,
	type JsonValue,
	type SettingDefinition,
	type SettingsProviderV1,
	type SettingsSnapshot,
} from "pi-maestro-settings-core/v1";
import { SettingsCoordinator } from "../src/settings/coordinator.ts";
import { SettingsLocaleState } from "../src/settings/locale-state.ts";
import { SettingsProviderRegistry, type SettingsEventBus } from "../src/settings/registry.ts";
import { MaestroSettingsShell } from "../src/settings/settings-shell.ts";

class FakeEventBus implements SettingsEventBus {
	private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
	on(event: string, handler: (payload: unknown) => void): () => void {
		const handlers = this.handlers.get(event) ?? new Set();
		handlers.add(handler);
		this.handlers.set(event, handlers);
		return () => handlers.delete(handler);
	}
	emit(event: string, payload: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(payload);
	}
}

const theme = {
	fg: (_role: string, value: string) => value,
	bg: (role: string, value: string) => role === "selectedBg" ? `\u001b[7m${value}\u001b[0m` : value,
	bold: (value: string) => value,
} as never;

function makeSnapshot(instanceId: string, items: JsonValue[], etag = "r0"): SettingsSnapshot {
	return {
		providerId: "cockpit",
		providerInstanceId: instanceId,
		configured: {
			values: [{
				key: "servers",
				scope: "global",
				state: "set",
				value: items,
				resource: { providerId: "cockpit", scope: "global", id: "cockpit.json" },
			}],
			resources: [{ resource: { providerId: "cockpit", scope: "global", id: "cockpit.json" }, etag }],
		},
		effective: { values: [{ key: "servers", value: items, source: "configured", scope: "global" }] },
	};
}

function field(key: string, kind: "text" | "boolean", defaultValue?: JsonValue): SettingDefinition {
	return {
		key,
		group: "general",
		labelKey: `f.${key}`,
		...(defaultValue !== undefined ? { defaultValue } : {}),
		scopes: ["global"],
		merge: "override",
		activation: "live",
		sensitivity: "public",
		reversibility: "full",
		editor: { kind },
	};
}

function makeProvider(itemsOverride?: JsonValue[]): SettingsProviderV1 {
	const instanceId = "cockpit-1";
	let items: JsonValue[] = itemsOverride
		? [...itemsOverride]
		: [
			{ id: "filesystem", enabled: true },
			{ id: "github", enabled: false },
		];
	let snapshot = makeSnapshot(instanceId, items);
	return {
		describe: () => ({
			id: "cockpit",
			version: "1.0.0",
			instanceId,
			labelKey: "cockpit.label",
			capabilities: { read: true, write: true, prepareCommit: true, rollback: "full", hotUpdate: true },
			catalogs: {
				en: {
					"cockpit.label": "Cockpit",
					"cockpit.servers": "Servers",
					"cockpit.servers.help": "Managed server list",
					"f.id": "Server id",
					"f.enabled": "Enabled",
				},
				"zh-CN": {
					"cockpit.label": "驾驶舱",
					"cockpit.servers": "服务",
					"cockpit.servers.help": "托管服务列表",
					"f.id": "服务 ID",
					"f.enabled": "启用",
				},
			},
			settings: [{
				key: "servers",
				group: "general",
				order: 0,
				labelKey: "cockpit.servers",
				descriptionKey: "cockpit.servers.help",
				scopes: ["global"],
				merge: "override",
				activation: "live",
				sensitivity: "public",
				reversibility: "full",
				editor: {
					kind: "list-crud",
					itemFields: [field("id", "text"), field("enabled", "boolean", true)],
				},
			}],
		}),
		read: () => snapshot,
		validate: () => ({ valid: true, issues: [] }),
		prepare: () => ({ prepared: true, prepareToken: "prepared", validation: { valid: true, issues: [] } }),
		commit: () => {
			snapshot = makeSnapshot(instanceId, items, "r1");
			return { snapshot, revisions: [], changedKeys: [], activation: [] };
		},
		abort: () => undefined,
		rollback: () => ({ rolledBack: true }),
		applyRuntime: () => ({ appliedKeys: [], deferred: [], failed: [] }),
	};
}

async function createShell(provider: SettingsProviderV1, terminalHeight?: number, terminalWidth?: number): Promise<{
	shell: MaestroSettingsShell;
	staged: () => JsonValue[] | undefined;
}> {
	const directory = mkdtempSync(join(tmpdir(), "settings-listcrud-"));
	try {
		const registry = new SettingsProviderRegistry(new FakeEventBus());
		registry.register({ version: SETTINGS_PROTOCOL_VERSION, providerId: "cockpit", instanceId: "cockpit-1", provider });
		const coordinator = new SettingsCoordinator(registry);
		const context = { cwd: "/workspace", locale: "en" } as const;
		await coordinator.load(context);
		const providers = await registry.describe(context);
		const localeState = new SettingsLocaleState(join(directory, "maestro-ui.json"), registry);
		const shell = new MaestroSettingsShell({
			registry,
			coordinator,
			localeState,
			initial: { context, providers, failures: [] },
			reload: async () => ({ context, providers, failures: [] }),
			theme,
			modelOptions: [],
			...(terminalHeight ? { getTerminalRows: () => terminalHeight } : {}),
			...(terminalWidth ? { getTerminalColumns: () => terminalWidth } : {}),
			requestRender: () => {},
			requestAction: () => {},
			close: () => {},
		});
		return {
			shell,
			staged: () => {
				const change = coordinator.changes().find((entry) => entry.key === "servers" && entry.operation === "set");
				return change?.operation === "set" ? (change.value as JsonValue[]) : undefined;
			},
		};
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("list-crud renders the item list with a footer help line", async () => {
	const state = await createShell(makeProvider());
	state.shell.handleInput("\r"); // open group
	state.shell.handleInput("\r"); // activate the list-crud setting
	const rendered = state.shell.render(100).join("\n");
	assert.ok(rendered.includes("Servers"));
	assert.ok(rendered.includes("filesystem"));
	assert.ok(rendered.includes("github"));
	assert.ok(rendered.includes("Enter edit · A add · D delete · Esc back"));
});

test("list-crud marks items with ●/○ toggle icons when an enabled boolean field exists", async () => {
	const state = await createShell(makeProvider());
	state.shell.handleInput("\r"); // open group
	state.shell.handleInput("\r"); // activate the list-crud setting
	const rendered = state.shell.render(100).join("\n");
	assert.ok(rendered.includes("● filesystem"), "an enabled item must render the ● indicator");
	assert.ok(rendered.includes("○ github"), "a disabled item must render the ○ indicator");
});

test("list-crud icons treat legacy string values as disabled consistently", async () => {
	const state = await createShell(makeProvider([
		{ id: "filesystem", enabled: true },
		{ id: "legacy", enabled: "false" },
	]));
	state.shell.handleInput("\r"); // open group
	state.shell.handleInput("\r");
	const rendered = state.shell.render(100).join("\n");
	assert.ok(rendered.includes("● filesystem"));
	assert.ok(rendered.includes("○ legacy"), "a legacy string \"false\" must render the ○ indicator, not ●");
});

test("list-crud supports mouse hover and click on items and fields", async () => {
	const state = await createShell(makeProvider(), 30, 120);
	state.shell.handleInput("\r"); // open group
	state.shell.handleInput("\r"); // list
	const initial = state.shell.render(112);
	const overlayHeight = Math.min(initial.length, Math.floor(30 * 0.92), 28);
	const left = 1 + Math.floor((118 - 112) / 2);
	const top = 1 + Math.floor((28 - overlayHeight) / 2);
	const column = left + 31 + 1; // inside the content column
	const itemRow = top + 7; // item 1 (github), overlay line 6
	state.shell.handleInput(`\u001b[<35;${column};${itemRow}M`);
	const hovered = state.shell.render(112).find((line) => line.includes("github")) ?? "";
	assert.ok(hovered.includes("\u001b[7m"), "hovering a list item must highlight it");
	state.shell.handleInput(`\u001b[<0;${column};${itemRow}M`);
	assert.ok(state.shell.render(112).some((line) => line.includes("› ○ github")), "clicking must move the selection to the hovered item");
	// Open the field form for the clicked item and click its second field.
	state.shell.handleInput("\r");
	state.shell.render(112); // refresh mouse targets for the field form
	state.shell.handleInput(`\u001b[<35;${column};${itemRow}M`);
	state.shell.handleInput(`\u001b[<0;${column};${itemRow}M`);
	assert.ok(state.shell.render(112).some((line) => line.includes("› Enabled · ○ Off")), "clicking a field must move the field highlight");
});

test("list-crud field editor echoes the in-progress value and ignores clicks on other fields", async () => {
	const state = await createShell(makeProvider(), 30, 120);
	state.shell.handleInput("\r"); // open group
	state.shell.handleInput("\r"); // list
	state.shell.handleInput("\r"); // item 0 -> field form
	state.shell.handleInput("\r"); // field 0 (id) -> value editor
	for (const char of "local") state.shell.handleInput(char);
	assert.ok(state.shell.render(100).some((line) => line.includes("local█")), "the in-progress field value must be echoed inline");
	const initial = state.shell.render(112);
	const overlayHeight = Math.min(initial.length, Math.floor(30 * 0.92), 28);
	const left = 1 + Math.floor((118 - 112) / 2);
	const top = 1 + Math.floor((28 - overlayHeight) / 2);
	const column = left + 31 + 1;
	const fieldRow = top + 7; // field 1 (enabled)
	state.shell.handleInput(`\u001b[<0;${column};${fieldRow}M`);
	assert.ok(state.shell.render(112).some((line) => line.includes("› Server id")), "the highlight must stay on the edited field while typing");
});

test("wheel inside list-crud does not disturb the list or the delete confirm", async () => {
	const state = await createShell(makeProvider(), 30, 120);
	state.shell.handleInput("\r"); // open group
	state.shell.handleInput("\r"); // list
	state.shell.handleInput("d"); // arm delete
	assert.ok(state.shell.render(100).some((line) => line.includes("Press D again to delete")));
	state.shell.handleInput("\u001b[<65;60;15M"); // wheel down
	const rendered = state.shell.render(100).join("\n");
	assert.ok(rendered.includes("Press D again to delete"), "wheel must not clear the delete confirm");
});

test("list-crud adds an item with blank defaults and stages the whole list", async () => {
	const state = await createShell(makeProvider());
	state.shell.handleInput("\r"); // open group
	state.shell.handleInput("\r");
	state.shell.handleInput("a");
	const staged = state.staged();
	assert.ok(staged, "adding an item must stage a change");
	assert.equal(staged!.length, 3);
	assert.equal((staged![2] as { id: unknown }).id, null);
	assert.equal((staged![2] as { enabled: unknown }).enabled, true);
});

test("list-crud edits an item field through the field form", async () => {
	const state = await createShell(makeProvider());
	state.shell.handleInput("\r"); // open group
	state.shell.handleInput("\r"); // list
	state.shell.handleInput("\r"); // item 0 -> field form
	state.shell.handleInput("\r"); // field 0 -> value editor
	for (const char of "local") state.shell.handleInput(char);
	state.shell.handleInput("\r"); // commit field
	const staged = state.staged();
	assert.ok(staged);
	assert.equal((staged![0] as { id: string }).id, "local");
});

test("list-crud deletes an item after a two-step confirmation", async () => {
	const state = await createShell(makeProvider());
	state.shell.handleInput("\r"); // open group
	state.shell.handleInput("\r");
	state.shell.handleInput("d");
	const armed = state.shell.render(100).join("\n");
	assert.ok(armed.includes("Press D again to delete"));
	assert.equal(state.staged(), undefined, "arming delete must not stage anything");
	state.shell.handleInput("d");
	const staged = state.staged();
	assert.ok(staged);
	assert.equal(staged!.length, 1);
	assert.equal((staged![0] as { id: string }).id, "github");
});

test("list-crud toggles boolean fields in place and writes real booleans", async () => {
	const state = await createShell(makeProvider());
	state.shell.handleInput("\r"); // open group
	state.shell.handleInput("\r"); // list
	state.shell.handleInput("\r"); // item 0 -> field form
	state.shell.handleInput("\x1b[B"); // field 0 (id) -> field 1 (enabled)
	const fieldView = state.shell.render(100).join("\n");
	assert.ok(fieldView.includes("● On"), "boolean field values must show the ● glyph");
	state.shell.handleInput(" "); // toggle enabled off
	let staged = state.staged();
	assert.ok(staged);
	assert.equal((staged![0] as { enabled: unknown }).enabled, false);
	assert.equal(typeof (staged![0] as { enabled: unknown }).enabled, "boolean", "toggling must stage a boolean, never a string");
	state.shell.handleInput("\r"); // Enter toggles back on
	staged = state.staged();
	assert.equal((staged![0] as { enabled: unknown }).enabled, true);
});

test("list-crud shows the remaining-count marker while scrolled and keeps the selection highlighted", async () => {
	const items = Array.from({ length: 22 }, (_, index) => ({ id: `srv-${index}`, enabled: index % 2 === 0 }));
	const state = await createShell(makeProvider(items));
	state.shell.handleInput("\r"); // open group
	state.shell.handleInput("\r"); // list
	for (let index = 0; index < 15; index++) state.shell.handleInput("\x1b[B");
	const rendered = state.shell.render(100).join("\n");
	assert.ok(rendered.includes("2 more"), "the scrolled window must still advertise remaining items");
	const highlighted = rendered.split("\n").filter((line) => line.includes("\u001b[7m") && line.includes("srv-"));
	assert.ok(highlighted.some((line) => line.includes("srv-15")), "the selected row must stay highlighted inside the window");
});

test("list-crud budgets its window on a real terminal height so footer and marker stay visible", async () => {
	const items = Array.from({ length: 22 }, (_, index) => ({ id: `srv-${index}`, enabled: index % 2 === 0 }));
	const state = await createShell(makeProvider(items), 30);
	state.shell.handleInput("\r"); // open group
	state.shell.handleInput("\r"); // list
	const rendered = state.shell.render(112).join("\n");
	assert.match(rendered, /more/), "the overflow marker must be visible on a budgeted terminal";
	assert.ok(rendered.includes("Enter edit · A add · D delete · Esc back"), "the help line must not be clipped by maxHeight");
});

test("overview editors render read-only diagnostic rows with status tones", async () => {
	const instanceId = "cockpit-1";
	const overview: JsonValue = [
		{ labelKey: "ov.healthy", value: "2/2", status: "ok" },
		{ labelKey: "ov.stale", value: "1 server stale", status: "warn" },
	];
	const snapshot: SettingsSnapshot = {
		providerId: "cockpit",
		providerInstanceId: instanceId,
		configured: {
			values: [{
				key: "status", scope: "global", state: "set", value: overview,
				resource: { providerId: "cockpit", scope: "global", id: "cockpit.json" },
			}],
			resources: [{ resource: { providerId: "cockpit", scope: "global", id: "cockpit.json" }, etag: "r0" }],
		},
		effective: { values: [{ key: "status", value: overview, source: "configured", scope: "global" }] },
	};
	const provider: SettingsProviderV1 = {
		describe: () => ({
			id: "cockpit", version: "1.0.0", instanceId,
			labelKey: "cockpit.label",
			capabilities: { read: true, write: true, prepareCommit: true, rollback: "full", hotUpdate: true },
			catalogs: {
				en: { "cockpit.label": "Cockpit", "cockpit.status": "Status", "ov.healthy": "Healthy", "ov.stale": "Stale" },
				"zh-CN": { "cockpit.label": "驾驶舱", "cockpit.status": "状态", "ov.healthy": "健康", "ov.stale": "陈旧" },
			},
			settings: [{
				key: "status", group: "general", order: 0, labelKey: "cockpit.status",
				scopes: ["global"], merge: "override", activation: "live", sensitivity: "public", reversibility: "none",
				editor: { kind: "overview" },
			}],
		}),
		read: () => snapshot,
		validate: () => ({ valid: true, issues: [] }),
		prepare: () => ({ prepared: true, prepareToken: "prepared", validation: { valid: true, issues: [] } }),
		commit: () => ({ snapshot, revisions: [], changedKeys: [], activation: [] }),
		abort: () => undefined,
		rollback: () => ({ rolledBack: true }),
		applyRuntime: () => ({ appliedKeys: [], deferred: [], failed: [] }),
	};
	const state = await createShell(provider);
	state.shell.handleInput("\r"); // open the group
	const rendered = state.shell.render(100).join("\n");
	assert.ok(rendered.includes("2 rows"), "the list value summarizes the row count");
	// Enter on the overview setting opens a read-only popup with the diagnostic rows.
	state.shell.handleInput("\r");
	const popup = state.shell.render(100).join("\n");
	assert.ok(popup.includes("● Healthy · 2/2"), "an ok overview row must carry the ● glyph");
	assert.ok(popup.includes("◐ Stale · 1 server stale"), "a warn overview row must carry the ◐ glyph");
	state.shell.handleInput("\x1b");
	assert.ok(!state.shell.render(100).join("\n").includes("● Healthy · 2/2"), "Esc closes the overview popup");
});
