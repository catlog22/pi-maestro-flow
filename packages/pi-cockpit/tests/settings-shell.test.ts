import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	SETTINGS_ANNOUNCE_EVENT,
	SETTINGS_DISCOVER_EVENT,
	SETTINGS_PROTOCOL_VERSION,
	type SettingsProviderV1,
	type SettingsSnapshot,
} from "pi-maestro-settings-core/v1";
import { SettingsCoordinator } from "../src/settings/coordinator.ts";
import { SettingsLocaleState } from "../src/settings/locale-state.ts";
import { SettingsProviderRegistry, type SettingsEventBus } from "../src/settings/registry.ts";
import { executeSettingsShellAction, MaestroSettingsShell, showMaestroSettingsShell, type SettingsShellActionRequest } from "../src/settings/settings-shell.ts";

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
} as Theme;

function makeSnapshot(instanceId: string, value = false, etag = "r0"): SettingsSnapshot {
	return {
		providerId: "cockpit",
		providerInstanceId: instanceId,
		configured: {
			values: [{
				key: "enabled",
				scope: "global",
				state: "set",
				value,
				resource: { providerId: "cockpit", scope: "global", id: "cockpit.json" },
			}, {
				key: "mode",
				scope: "global",
				state: "set",
				value: "compact",
				resource: { providerId: "cockpit", scope: "global", id: "cockpit.json" },
			}, {
				key: "limit",
				scope: "global",
				state: "set",
				value: 20,
				resource: { providerId: "cockpit", scope: "global", id: "cockpit.json" },
			}, {
				key: "model",
				scope: "global",
				state: "set",
				value: "provider/a",
				resource: { providerId: "cockpit", scope: "global", id: "cockpit.json" },
			}],
			resources: [{ resource: { providerId: "cockpit", scope: "global", id: "cockpit.json" }, etag }],
		},
		effective: { values: [
			{ key: "enabled", value, source: "configured", scope: "global" },
			{ key: "mode", value: "compact", source: "configured", scope: "global" },
			{ key: "limit", value: 20, source: "configured", scope: "global" },
			{ key: "model", value: "provider/a", source: "configured", scope: "global" },
		] },
	};
}

function makeProvider(options: { conflict?: boolean; action?: () => void } = {}): SettingsProviderV1 {
	const instanceId = "cockpit-1";
	let snapshot = makeSnapshot(instanceId);
	let preparedValue = false;
	return {
		describe: () => ({
			id: "cockpit",
			version: "1.0.0",
			instanceId,
			labelKey: "cockpit.label",
			capabilities: { read: true, write: true, prepareCommit: true, rollback: "full", hotUpdate: true },
			catalogs: {
				en: { "cockpit.label": "Cockpit", "cockpit.enabled": "Enabled", "cockpit.enabled.help": "Enable the Cockpit UI", "cockpit.manage": "Manage advanced", "cockpit.mode": "Display mode", "cockpit.mode.compact": "Compact view", "cockpit.mode.list": "List view", "cockpit.limit": "Limit", "cockpit.model": "Model" },
				"zh-CN": { "cockpit.label": "驾驶舱", "cockpit.enabled": "启用", "cockpit.enabled.help": "启用驾驶舱界面", "cockpit.manage": "高级管理", "cockpit.mode": "显示模式", "cockpit.mode.compact": "紧凑视图", "cockpit.mode.list": "列表视图", "cockpit.limit": "限制", "cockpit.model": "模型" },
			},
			settings: [
				{
					key: "enabled",
					group: "general",
					order: 0,
					labelKey: "cockpit.enabled",
					descriptionKey: "cockpit.enabled.help",
					defaultValue: true,
					scopes: ["global"],
					merge: "override",
					activation: "live",
					sensitivity: "public",
					reversibility: "full",
					editor: { kind: "boolean" },
				},
				{
					key: "advanced",
					group: "general",
					order: 1,
					labelKey: "cockpit.manage",
					scopes: ["global"],
					merge: "provider-defined",
					activation: "live",
					sensitivity: "private",
					reversibility: "full",
					editor: { kind: "action", actionId: "advanced" },
				},
				{
					key: "mode",
					group: "general",
					order: 2,
					labelKey: "cockpit.mode",
					defaultValue: "compact",
					scopes: ["global"],
					merge: "override",
					activation: "live",
					sensitivity: "public",
					reversibility: "full",
					editor: { kind: "enum", options: [
						{ value: "compact", labelKey: "cockpit.mode.compact" },
						{ value: "list", labelKey: "cockpit.mode.list" },
					] },
				},
				{
					key: "limit",
					group: "general",
					order: 3,
					labelKey: "cockpit.limit",
					defaultValue: 20,
					scopes: ["global"],
					merge: "override",
					activation: "live",
					sensitivity: "public",
					reversibility: "full",
					editor: { kind: "integer", min: 1, max: 100 },
				},
				{
					key: "model",
					group: "general",
					order: 4,
					labelKey: "cockpit.model",
					defaultValue: "provider/a",
					scopes: ["global"],
					merge: "override",
					activation: "live",
					sensitivity: "public",
					reversibility: "full",
					editor: { kind: "model", optionsSource: "models" },
				},
			],
		}),
		read: () => snapshot,
		validate: () => ({ valid: true, issues: [] }),
		prepare: (request) => {
			if (options.conflict) {
				return {
					prepared: false,
					validation: { valid: false, issues: [] },
					conflicts: [{ resource: snapshot.configured.resources[0]!.resource, expectedEtag: "r0", actualEtag: "external" }],
				};
			}
			const change = request.changes.find((entry) => entry.key === "enabled");
			preparedValue = change?.operation === "set" ? change.value === true : false;
			return { prepared: true, prepareToken: "prepared", validation: { valid: true, issues: [] } };
		},
		commit: () => {
			snapshot = makeSnapshot(instanceId, preparedValue, "r1");
			return { snapshot, revisions: snapshot.configured.resources, changedKeys: ["enabled"], activation: [{ boundary: "live", keys: ["enabled"] }] };
		},
		abort: () => undefined,
		rollback: () => ({ rolledBack: true }),
		applyRuntime: () => ({ appliedKeys: ["enabled"], deferred: [], failed: [] }),
		invokeAction: () => {
			options.action?.();
			return { handled: true };
		},
	};
}

async function createShell(
	provider: SettingsProviderV1,
	directory: string,
	modelOptions: readonly string[] = [],
	terminalHeight?: number,
	terminalWidth?: number,
) {
	const registry = new SettingsProviderRegistry(new FakeEventBus());
	registry.register({ version: SETTINGS_PROTOCOL_VERSION, providerId: "cockpit", instanceId: "cockpit-1", provider });
	const coordinator = new SettingsCoordinator(registry);
	const context = { cwd: "/workspace", locale: "en" } as const;
	await coordinator.load(context);
	const providers = await registry.describe(context);
	const localeState = new SettingsLocaleState(join(directory, "maestro-ui.json"), registry);
	let closed = false;
	let renders = 0;
	const requestedActions: SettingsShellActionRequest[] = [];
	const shell = new MaestroSettingsShell({
		registry,
		coordinator,
		localeState,
		initial: { context, providers, failures: [] },
		reload: async () => ({ context: { ...context, locale: localeState.locale }, providers: await registry.describe({ ...context, locale: localeState.locale }), failures: await coordinator.load({ ...context, locale: localeState.locale }) }),
		theme,
		modelOptions,
		...(terminalHeight ? { getTerminalRows: () => terminalHeight } : {}),
		...(terminalWidth ? { getTerminalColumns: () => terminalWidth } : {}),
		requestRender: () => { renders++; },
		requestAction: (request) => { requestedActions.push(request); },
		close: () => { closed = true; },
	});
	return {
		shell,
		coordinator,
		localeState,
		registry,
		context,
		requestedActions,
		get closed() { return closed; },
		get renders() { return renders; },
	};
}

function withTempDir(): string {
	return mkdtempSync(join(tmpdir(), "settings-shell-"));
}

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function moveDown(shell: MaestroSettingsShell, count: number): void {
	for (let index = 0; index < count; index++) shell.handleInput("\x1b[B");
}

test("settings shell renders a single vertical list with effective values", async () => {
	const directory = withTempDir();
	try {
		const { shell } = await createShell(makeProvider(), directory);
		for (const width of [40, 90, 140]) {
			const lines = shell.render(width);
			assert.ok(lines.some((line) => line.includes("Maestro Settings")));
			assert.ok(lines.some((line) => line.includes("Enabled")));
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
		const localizedValues = shell.render(100);
		assert.ok(localizedValues.some((line) => line.includes("Off")));
		assert.ok(localizedValues.some((line) => line.includes("Compact view")));
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("settings overlay budgets content for short terminals without losing its footer", async () => {
	const directory = withTempDir();
	try {
		const { shell } = await createShell(makeProvider(), directory, [], 24);
		const lines = shell.render(76);
		assert.equal(lines.length, 22);
		assert.ok(lines.some((line) => line.includes("Ctrl+S")));
		assert.ok(lines.every((line) => visibleWidth(line) <= 76));
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("narrow footers advertise scope cycling and vertical navigation", async () => {
	const directory = withTempDir();
	try {
		const state = await createShell(makeProvider(), directory);
		const lines = state.shell.render(66);
		assert.ok(lines.some((line) => line.includes("↑↓ setting")), "footer must advertise vertical navigation");
		assert.ok(lines.some((line) => line.includes("Tab scope")));
		assert.ok(!lines.some((line) => line.includes("←→ plugin")), "no left/right plugin switching in the vertical layout");
		state.shell.handleInput(" "); // dirty
		const dirty = state.shell.render(66);
		assert.ok(dirty.some((line) => line.includes("1 modified")), "the dirty header must show the modified count");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("group-header backtracking never pushes the highlighted setting out of the window", async () => {
	const directory = withTempDir();
	try {
		// A 17-row terminal yields a 1-row settings window where the group-header
		// backtrack could previously drop the highlighted row past the window end.
		const { shell } = await createShell(makeProvider(), directory, [], 17);
		moveDown(shell, 4);
		const lines = shell.render(112);
		assert.ok(
			lines.some((line) => line.includes("\u001b[7m") && line.includes("Model")),
			"the selected row must stay visible and highlighted",
		);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("mouse hover highlights settings rows and left click activates the hovered setting", async () => {
	const directory = withTempDir();
	try {
		const state = await createShell(makeProvider(), directory, [], 30, 120);
		const initial = state.shell.render(112);
		const overlayHeight = Math.min(initial.length, Math.floor(30 * 0.92), 28);
		const left = 1 + Math.floor((118 - 112) / 2);
		const top = 1 + Math.floor((28 - overlayHeight) / 2);
		const advancedColumn = left + 10;
		const advancedRow = top + 5;
		state.shell.handleInput(`\u001b[<35;${advancedColumn};${advancedRow}M`);
		const hovered = state.shell.render(112).find((line) => line.includes("Manage advanced")) ?? "";
		assert.match(hovered, /\u001b\[7m/);
		state.shell.handleInput(`\u001b[<0;${advancedColumn};${advancedRow}M`);
		await settle();
		assert.deepEqual(state.requestedActions, [{ providerId: "cockpit", actionId: "advanced", key: "advanced" }]);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("boolean edits stay in draft until apply and Esc discards with confirmation", async () => {
	const directory = withTempDir();
	try {
		const state = await createShell(makeProvider(), directory);
		state.shell.handleInput(" ");
		assert.equal(state.coordinator.changes("cockpit")[0]?.operation, "set");
		state.shell.handleInput("\x1b");
		assert.equal(state.closed, false);
		state.shell.handleInput("\x1b");
		assert.equal(state.closed, true);
		assert.deepEqual(state.coordinator.changes(), []);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("apply commits drafts and conflict state is rendered", async () => {
	const directory = withTempDir();
	try {
		const committed = await createShell(makeProvider(), directory);
		committed.shell.handleInput(" ");
		committed.shell.handleInput("\x13");
		await settle();
		assert.deepEqual(committed.coordinator.changes(), []);
		assert.ok(committed.shell.render(100).some((line) => line.includes("Settings saved")));

		const conflicted = await createShell(makeProvider({ conflict: true }), directory);
		conflicted.shell.handleInput(" ");
		conflicted.shell.handleInput("\x13");
		await settle();
		assert.ok(conflicted.shell.render(100).some((line) => line.includes("Configuration changed")));
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Ctrl+L persists locale and rerenders provider catalogs in Chinese", async () => {
	const directory = withTempDir();
	try {
		const state = await createShell(makeProvider(), directory);
		state.shell.handleInput("\x0c");
		await settle();
		assert.equal(state.localeState.locale, "zh-CN");
		const lines = state.shell.render(100);
		assert.ok(lines.some((line) => line.includes("Maestro 设置")));
		assert.ok(lines.some((line) => line.includes("界面语言")));
		assert.ok(lines.some((line) => line.includes("启用")));
		assert.ok(lines.some((line) => line.includes("关闭")));
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("enum settings open a visible option picker instead of cycling invisibly", async () => {
	const directory = withTempDir();
	try {
		const state = await createShell(makeProvider(), directory);
		moveDown(state.shell, 2);
		state.shell.handleInput("\r");
		assert.ok(state.shell.render(100).some((line) => line.includes("Choose a value")));
		state.shell.handleInput("\x1b[B");
		assert.ok(state.shell.render(100).some((line) => line.includes("List view")));
		state.shell.handleInput("\r");
		assert.equal(state.coordinator.changes("cockpit").find((entry) => entry.key === "mode")?.operation, "set");
		assert.equal((state.coordinator.changes("cockpit").find((entry) => entry.key === "mode") as { value?: unknown })?.value, "list");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("expanded option rows support mouse hover and click-to-confirm", async () => {
	const directory = withTempDir();
	try {
		const state = await createShell(makeProvider(), directory, [], 30, 120);
		moveDown(state.shell, 2);
		state.shell.handleInput("\r");
		const initial = state.shell.render(112);
		assert.ok(initial.some((line) => line.includes("Choose a value")), "option picker popup is visible");
		const optionRow = initial.findIndex((line) => line.includes("List view"));
		assert.ok(optionRow >= 0);
		const overlayHeight = Math.min(initial.length, Math.floor(30 * 0.92), 28);
		const left = 1 + Math.floor((118 - 112) / 2);
		const top = 1 + Math.floor((28 - overlayHeight) / 2);
		const optionColumn = left + 10;
		const optionScreenRow = top + optionRow;
		state.shell.handleInput(`\u001b[<35;${optionColumn};${optionScreenRow}M`);
		const hoveredLines = state.shell.render(112);
		const hovered = hoveredLines.find((line) => line.includes("List view")) ?? "";
		assert.equal(hoveredLines.length, initial.length);
		assert.match(hovered, /\u001b\[7m/);
		state.shell.handleInput(`\u001b[<0;${optionColumn};${optionScreenRow}M`);
		const change = state.coordinator.changes("cockpit").find((entry) => entry.key === "mode");
		assert.equal((change as { value?: unknown })?.value, "list");
		const closed = state.shell.render(112);
		assert.ok(closed.some((line) => line.includes("Display mode · List view")), "committed value shown back in the list");
		assert.ok(closed.every((line) => !line.includes("Choose a value")), "option picker popup is gone");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("text editors visibly mark editing and replace the selected current value on first input", async () => {
	const directory = withTempDir();
	try {
		const state = await createShell(makeProvider(), directory);
		moveDown(state.shell, 3);
		state.shell.handleInput("\r");
		let lines = state.shell.render(100);
		assert.ok(lines.some((line) => line.includes("Editing")));
		assert.ok(lines.some((line) => line.includes("Input · [20]")));
		state.shell.handleInput("5");
		lines = state.shell.render(100);
		assert.ok(lines.some((line) => line.includes("Input · 5█")), "the editor input reflects the typed digit");
		state.shell.handleInput("\r");
		const change = state.coordinator.changes("cockpit").find((entry) => entry.key === "limit");
		assert.equal(change?.operation, "set");
		assert.equal((change as { value?: unknown })?.value, 5);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("numeric editors keep invalid min/max values visible and out of the draft", async () => {
	const directory = withTempDir();
	try {
		const state = await createShell(makeProvider(), directory);
		moveDown(state.shell, 3);
		state.shell.handleInput("\r");
		for (const digit of "101") state.shell.handleInput(digit);
		state.shell.handleInput("\r");
		assert.equal(state.coordinator.changes("cockpit").some((entry) => entry.key === "limit"), false);
		assert.ok(state.shell.render(100).some((line) => line.includes("Value must be at most 100")));
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("model settings use the host model catalog and retain a custom-entry path", async () => {
	const directory = withTempDir();
	try {
		const state = await createShell(makeProvider(), directory, ["provider/a", "provider/b"]);
		moveDown(state.shell, 4);
		state.shell.handleInput("\r");
		assert.ok(state.shell.render(100).some((line) => line.includes("E custom model")));
		state.shell.handleInput("\x1b[B");
		assert.ok(state.shell.render(100).some((line) => line.includes("provider/b")));
		state.shell.handleInput("\r");
		const change = state.coordinator.changes("cockpit").find((entry) => entry.key === "model");
		assert.equal((change as { value?: unknown })?.value, "provider/b");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("showMaestroSettingsShell closes its custom UI before opening a provider action", async () => {
	const directory = withTempDir();
	try {
		let customDepth = 0;
		let customCalls = 0;
		let invoked = 0;
		let receivedOptions: unknown;
		const terminalWrites: string[] = [];
		const provider = makeProvider({ action: () => {
			assert.equal(customDepth, 0, "provider action opened while Settings custom UI was still active");
			invoked++;
		} });
		const events = new FakeEventBus();
		events.on(SETTINGS_DISCOVER_EVENT, (payload) => events.emit(SETTINGS_ANNOUNCE_EVENT, {
			version: SETTINGS_PROTOCOL_VERSION,
			requestId: (payload as { requestId?: unknown }).requestId,
			providerId: "cockpit",
			instanceId: "cockpit-1",
			provider,
		}));
		const registry = new SettingsProviderRegistry(events);
		const localeState = new SettingsLocaleState(join(directory, "maestro-ui.json"), registry);
		const ctx = {
			cwd: "/workspace",
			modelRegistry: { getAvailable: () => [] },
			ui: {
				notify() {},
				custom(
					factory: (
						tui: { requestRender(): void; terminal: { rows: number; columns: number; write(value: string): void } },
						theme: Theme,
						keybindings: unknown,
						done: (result: unknown) => void,
					) => MaestroSettingsShell,
					options: unknown,
				) {
					receivedOptions = options;
					customCalls++;
					customDepth++;
					return new Promise((resolve) => {
						let shell: MaestroSettingsShell | undefined;
						const done = (result: unknown) => {
							shell?.dispose();
							customDepth--;
							resolve(result);
						};
						shell = factory({
							requestRender() {},
							terminal: { rows: 30, columns: 120, write: (value) => { terminalWrites.push(value); } },
						}, theme, {}, done);
						if (customCalls === 1) {
							shell.handleInput("\x1b[B");
							shell.handleInput("\r");
						} else {
							shell.handleInput("\x1b");
						}
					});
				},
			},
		} as never;
		await showMaestroSettingsShell(ctx, registry, localeState);
		assert.equal(invoked, 1);
		assert.equal(customCalls, 2, "Settings should reopen after the provider action closes");
		assert.deepEqual(receivedOptions, {
			overlay: true,
			overlayOptions: { anchor: "center", width: "94%", maxHeight: "92%", margin: 1 },
		});
		assert.equal(terminalWrites.filter((value) => value.includes("?1003h")).length, 2);
		assert.equal(terminalWrites.filter((value) => value.includes("?1003l")).length, 2);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("action settings leave the active custom UI before invoking the owning provider", async () => {
	const directory = withTempDir();
	try {
		let invoked = 0;
		const state = await createShell(makeProvider({ action: () => { invoked++; } }), directory);
		state.shell.handleInput("\x1b[B");
		state.shell.handleInput("\r");
		await settle();
		assert.equal(invoked, 0, "the provider must not run inside the active Settings custom UI");
		assert.deepEqual(state.requestedActions, [{ providerId: "cockpit", actionId: "advanced", key: "advanced" }]);
		await executeSettingsShellAction(
			{ ui: { notify() {} } } as never,
			state.registry,
			state.context,
			state.requestedActions[0]!,
		);
		assert.equal(invoked, 1);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("not-yet-implemented editor kinds degrade to read-only instead of raw text editing", async () => {
	const directory = withTempDir();
	try {
		const instanceId = "cockpit-1";
		const snapshot: SettingsSnapshot = {
			providerId: "cockpit",
			providerInstanceId: instanceId,
			configured: {
				values: [{
					key: "future",
					scope: "global",
					state: "set",
					value: 42,
					resource: { providerId: "cockpit", scope: "global", id: "cockpit.json" },
				}],
				resources: [{ resource: { providerId: "cockpit", scope: "global", id: "cockpit.json" }, etag: "r0" }],
			},
			effective: { values: [{ key: "future", value: 42, source: "configured", scope: "global" }] },
		};
		const provider: SettingsProviderV1 = {
			describe: () => ({
				id: "cockpit",
				version: "1.0.0",
				instanceId,
				labelKey: "cockpit.label",
				capabilities: { read: true, write: true, prepareCommit: true, rollback: "full", hotUpdate: true },
				catalogs: {
					en: { "cockpit.label": "Cockpit", "cockpit.future": "Future setting" },
					"zh-CN": { "cockpit.label": "驾驶舱", "cockpit.future": "未来设置" },
				},
				settings: [{
					key: "future",
					group: "general",
					order: 0,
					labelKey: "cockpit.future",
					scopes: ["global"],
					merge: "override",
					activation: "live",
					sensitivity: "public",
					reversibility: "full",
					editor: { kind: "slider" } as never,
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
		const { shell, coordinator } = await createShell(provider, directory);
		shell.handleInput("\r");
		const rendered = shell.render(100).join("\n");
		assert.ok(rendered.includes("Read only"), "an unimplemented editor kind must surface the read-only notice");
		assert.equal(coordinator.changes().length, 0, "activating an unimplemented kind must not stage a change");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("vertical list aggregates every provider into one navigable list", async () => {
	const directory = withTempDir();
	try {
		const registry = new SettingsProviderRegistry(new FakeEventBus());
		registry.register({ version: SETTINGS_PROTOCOL_VERSION, providerId: "cockpit", instanceId: "cockpit-1", provider: makeProvider() });
		registry.register({ version: SETTINGS_PROTOCOL_VERSION, providerId: "other", instanceId: "other-1", provider: makeSecondaryProvider() });
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
			requestRender: () => {},
			requestAction: () => {},
			close: () => {},
		});
		const rendered = shell.render(112).join("\n");
		assert.ok(rendered.includes("Enabled"), "cockpit settings appear in the single vertical list");
		assert.ok(rendered.includes("B one"), "the second provider's settings appear in the same list");
		// Navigate down past cockpit into the other provider's settings.
		moveDown(shell, 6);
		const highlighted = shell.render(112).filter((line) => line.includes("\u001b[7m")).join("\n");
		assert.ok(highlighted.includes("B one") || highlighted.includes("B two"), "navigation crosses provider boundaries in the flat list");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("search filter narrows the single list and highlights the matching setting", async () => {
	const directory = withTempDir();
	try {
		const registry = new SettingsProviderRegistry(new FakeEventBus());
		registry.register({ version: SETTINGS_PROTOCOL_VERSION, providerId: "cockpit", instanceId: "cockpit-1", provider: makeProvider() });
		registry.register({ version: SETTINGS_PROTOCOL_VERSION, providerId: "other", instanceId: "other-1", provider: makeSecondaryProvider() });
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
			requestRender: () => {},
			requestAction: () => {},
			close: () => {},
		});
		shell.handleInput("\x1b[B");
		shell.handleInput("/");
		shell.handleInput("a");
		shell.handleInput("d");
		shell.handleInput("\x1b"); // exit search mode, keeping the filter
		const filtered = shell.render(112).filter((line) => line.includes("\u001b[7m") && line.includes(" · ")).join("\n");
		assert.ok(filtered.includes("Manage advanced"), "the filtered view must highlight the matching setting");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("option editor pages with PageUp/PageDown and lands on enabled options", async () => {
	const directory = withTempDir();
	try {
		const options = Array.from({ length: 10 }, (_, index) => ({ value: `opt-${index}`, labelKey: `opts.opt-${index}` }));
		const provider = makeEnumProvider(options);
		const { shell } = await createShell(provider, directory);
		shell.handleInput("\r"); // open the option picker
		shell.handleInput("\x1b[6~"); // page down
		let rendered = shell.render(112);
		const highlighted = rendered.filter((line) => line.includes("\u001b[7m") && line.includes("› opt-"));
		assert.ok(highlighted.some((line) => line.includes("opt-7")), "page down must jump by one page of options");
		shell.handleInput("\x1b[5~"); // page up
		rendered = shell.render(112);
		const back = rendered.filter((line) => line.includes("\u001b[7m") && line.includes("› opt-"));
		assert.ok(back.some((line) => line.includes("opt-0")), "page up must return to the first option");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

function makeEnumProvider(options: readonly { value: string; labelKey: string }[]): SettingsProviderV1 {
	const instanceId = "cockpit-1";
	const snapshot: SettingsSnapshot = {
		providerId: "cockpit",
		providerInstanceId: instanceId,
		configured: {
			values: [{
				key: "choice", scope: "global", state: "set", value: options[0]!.value,
				resource: { providerId: "cockpit", scope: "global", id: "enum.json" },
			}],
			resources: [{ resource: { providerId: "cockpit", scope: "global", id: "enum.json" }, etag: "r0" }],
		},
		effective: { values: [{ key: "choice", value: options[0]!.value, source: "configured", scope: "global" }] },
	};
	const en: Record<string, string> = { "enum.label": "Chooser", "enum.choice": "Choice" };
	const zh: Record<string, string> = { "enum.label": "选择器", "enum.choice": "选项" };
	for (const option of options) {
		en[option.labelKey] = option.value;
		zh[option.labelKey] = option.value;
	}
	return {
		describe: () => ({
			id: "cockpit",
			version: "1.0.0",
			instanceId,
			labelKey: "enum.label",
			capabilities: { read: true, write: true, prepareCommit: true, rollback: "full", hotUpdate: true },
			catalogs: { en, "zh-CN": zh },
			settings: [{
				key: "choice", group: "general", order: 0, labelKey: "enum.choice",
				defaultValue: options[0]!.value, scopes: ["global"],
				merge: "override", activation: "live", sensitivity: "public", reversibility: "full",
				editor: { kind: "enum", options: [...options] },
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
}

function makeSecondaryProvider(): SettingsProviderV1 {
	const instanceId = "other-1";
	const snapshot: SettingsSnapshot = {
		providerId: "other",
		providerInstanceId: instanceId,
		configured: {
			values: [
				{ key: "bOne", scope: "global", state: "set", value: true, resource: { providerId: "other", scope: "global", id: "other.json" } },
				{ key: "bTwo", scope: "global", state: "set", value: "x", resource: { providerId: "other", scope: "global", id: "other.json" } },
			],
			resources: [{ resource: { providerId: "other", scope: "global", id: "other.json" }, etag: "r0" }],
		},
		effective: { values: [
			{ key: "bOne", value: true, source: "configured", scope: "global" },
			{ key: "bTwo", value: "x", source: "configured", scope: "global" },
		] },
	};
	return {
		describe: () => ({
			id: "other",
			version: "1.0.0",
			instanceId,
			labelKey: "other.label",
			capabilities: { read: true, write: true, prepareCommit: true, rollback: "full", hotUpdate: true },
			catalogs: {
				en: { "other.label": "Other provider", "other.bOne": "B one", "other.bTwo": "B two" },
				"zh-CN": { "other.label": "其它", "other.bOne": "B 一", "other.bTwo": "B 二" },
			},
			settings: [
				{ key: "bOne", group: "general", order: 0, labelKey: "other.bOne", defaultValue: true, scopes: ["global"], merge: "override", activation: "live", sensitivity: "public", reversibility: "full", editor: { kind: "boolean" } },
				{ key: "bTwo", group: "general", order: 1, labelKey: "other.bTwo", defaultValue: "x", scopes: ["global"], merge: "override", activation: "live", sensitivity: "public", reversibility: "full", editor: { kind: "text" } },
			],
		}),
		read: () => snapshot,
		validate: () => ({ valid: true, issues: [] }),
		prepare: () => ({ prepared: true, prepareToken: "prepared", validation: { valid: true, issues: [] } }),
		commit: () => ({ snapshot, revisions: [], changedKeys: [], activation: [] }),
		abort: () => undefined,
		rollback: () => ({ rolledBack: true }),
		applyRuntime: () => ({ appliedKeys: [], deferred: [], failed: [] }),
	};
}
