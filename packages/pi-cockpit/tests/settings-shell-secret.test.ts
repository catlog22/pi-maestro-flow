import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	SETTINGS_PROTOCOL_VERSION,
	type JsonValue,
	type SettingsChange,
	type SettingsProviderV1,
	type SettingsSnapshot,
} from "pi-maestro-settings-core/v1";
import { SETTINGS_SECRET_SET_PLACEHOLDER } from "pi-maestro-settings-core/v1/schema";
import { SettingsCoordinator } from "../src/settings/coordinator.ts";
import { SettingsLocaleState } from "../src/settings/locale-state.ts";
import { SettingsProviderRegistry, type SettingsEventBus } from "../src/settings/registry.ts";
import { MaestroSettingsShell } from "../src/settings/settings-shell.ts";

const PLAINTEXT = "sk-test-123-secret";

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

function makeSnapshot(instanceId: string, value: JsonValue, etag = "r0"): SettingsSnapshot {
	return {
		providerId: "cockpit",
		providerInstanceId: instanceId,
		configured: {
			values: [{
				key: "apikey",
				scope: "global",
				state: "set",
				value,
				resource: { providerId: "cockpit", scope: "global", id: "cockpit.json" },
			}],
			resources: [{ resource: { providerId: "cockpit", scope: "global", id: "cockpit.json" }, etag }],
		},
		effective: { values: [{ key: "apikey", value, source: "configured", scope: "global" }] },
	};
}

function makeSecretProvider(options: { writeOnly?: boolean } = {}): SettingsProviderV1 {
	const instanceId = "cockpit-1";
	let snapshot = makeSnapshot(instanceId, SETTINGS_SECRET_SET_PLACEHOLDER);
	return {
		describe: () => ({
			id: "cockpit",
			version: "1.0.0",
			instanceId,
			labelKey: "cockpit.label",
			capabilities: { read: true, write: true, prepareCommit: true, rollback: "full", hotUpdate: true },
			catalogs: {
				en: { "cockpit.label": "Cockpit", "cockpit.apikey": "API key", "cockpit.apikey.help": "Provider API key" },
				"zh-CN": { "cockpit.label": "驾驶舱", "cockpit.apikey": "API 密钥", "cockpit.apikey.help": "Provider API 密钥" },
			},
			settings: [{
				key: "apikey",
				group: "general",
				order: 0,
				labelKey: "cockpit.apikey",
				descriptionKey: "cockpit.apikey.help",
				scopes: ["global"],
				merge: "override",
				activation: "live",
				sensitivity: "secret",
				reversibility: "none",
				editor: { kind: "secret", writeOnly: options.writeOnly },
			}],
		}),
		read: () => snapshot,
		validate: () => ({ valid: true, issues: [] }),
		prepare: () => ({ prepared: true, prepareToken: "prepared", validation: { valid: true, issues: [] } }),
		commit: () => {
			snapshot = makeSnapshot(instanceId, SETTINGS_SECRET_SET_PLACEHOLDER, "r1");
			return { snapshot, revisions: [], changedKeys: ["apikey"], activation: [] };
		},
		abort: () => undefined,
		rollback: () => ({ rolledBack: true }),
		applyRuntime: () => ({ appliedKeys: [], deferred: [], failed: [] }),
	};
}

async function createShell(provider: SettingsProviderV1): Promise<{
	shell: MaestroSettingsShell;
	changes: () => Array<{ key: string; value: unknown }>;
}> {
	const directory = mkdtempSync(join(tmpdir(), "settings-secret-"));
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
			requestRender: () => {},
			requestAction: () => {},
			close: () => {},
		});
		return {
			shell,
			changes: () => coordinator.changes().filter((change): change is Extract<SettingsChange, { operation: "set" }> =>
				change.operation === "set").map((change) => ({ key: change.key, value: change.value })),
		};
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("writable secrets render a masked placeholder, never the plaintext", async () => {
	const state = await createShell(makeSecretProvider({ writeOnly: true }));
	state.shell.handleInput("\r"); // open group
	const rendered = state.shell.render(100).join("\n");
	assert.ok(rendered.includes("••••••"), "a set secret shows the masked placeholder");
	assert.ok(!rendered.includes(PLAINTEXT));
});

test("typing into a writable secret masks every character and stages the plaintext once", async () => {
	const state = await createShell(makeSecretProvider({ writeOnly: true }));
	state.shell.handleInput("\r"); // open group
	state.shell.handleInput("\r");
	for (const char of PLAINTEXT) state.shell.handleInput(char);
	const editing = state.shell.render(100).join("\n");
	assert.ok(!editing.includes(PLAINTEXT), "plaintext must not render while typing");
	assert.ok(editing.includes("••••••••••••••••••"), "the typed draft renders as bullets");
	state.shell.handleInput("\r");
	const staged = state.changes();
	assert.equal(staged.length, 1);
	assert.equal(staged[0]!.value, PLAINTEXT);
	const after = state.shell.render(100).join("\n");
	assert.ok(!after.includes(PLAINTEXT), "plaintext must not appear in the committed list view");
});

test("non-writable secrets stay read-only", async () => {
	const state = await createShell(makeSecretProvider({ writeOnly: false }));
	state.shell.handleInput("\r"); // open group
	state.shell.handleInput("\r");
	const rendered = state.shell.render(100).join("\n");
	assert.ok(rendered.includes("Secret values are managed by the owning plugin"));
	assert.equal(state.changes().length, 0);
});
