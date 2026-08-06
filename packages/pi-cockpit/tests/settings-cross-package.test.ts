import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	SETTINGS_ANNOUNCE_EVENT,
	SETTINGS_CHANGED_EVENT,
	SETTINGS_LOCALE_EVENT,
	SETTINGS_PROTOCOL_VERSION,
	type SettingsContextV1,
} from "pi-maestro-settings-core/v1";
import { createFlowSettingsProvider, registerFlowSettingsProvider } from "../../pi-maestro-flow/src/settings/flow-settings-provider.ts";
import {
	createApiManagerSettingsProvider,
	registerApiManagerSettingsProvider,
} from "../../pi-maestro-flow/src/settings/api-manager-settings-provider.ts";
import { createTeammateSettingsProvider, registerTeammateSettingsProvider } from "../../pi-maestro-teammate/src/settings/teammate-settings-provider.ts";
import { DEFAULT_CONFIG, type CockpitConfig } from "../src/types.ts";
import { createCockpitSettingsProvider, registerCockpitSettingsProvider } from "../src/settings/cockpit-provider.ts";
import { SettingsCoordinator } from "../src/settings/coordinator.ts";
import { SettingsLocaleState } from "../src/settings/locale-state.ts";
import { SettingsProviderRegistry, type SettingsEventBus } from "../src/settings/registry.ts";
import { MaestroSettingsShell } from "../src/settings/settings-shell.ts";

class SharedEventBus implements SettingsEventBus {
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

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "maestro-settings-cross-package-"));
	const cwd = join(root, "project");
	const paths = {
		cockpit: join(root, "agent", "cockpit.json"),
		globalSettings: join(root, "agent", "settings.json"),
		projectSettings: join(cwd, ".pi", "settings.json"),
		globalFailover: join(root, "agent", "model-failover.json"),
		projectFailover: join(cwd, ".pi", "model-failover.json"),
		globalTeammate: join(root, "agent", "teammate-models.json"),
		projectTeammate: join(cwd, ".pi", "teammate-models.json"),
		locale: join(root, "agent", "maestro-ui.json"),
	};
	let runtime = structuredClone(DEFAULT_CONFIG);
	const cockpit = createCockpitSettingsProvider({
		getConfigPath: () => paths.cockpit,
		getRuntimeConfig: () => runtime,
		applyRuntimeConfig: (config) => { runtime = config; },
	});
	const flow = createFlowSettingsProvider({
		getGlobalSettingsPath: () => paths.globalSettings,
		getProjectSettingsPath: () => paths.projectSettings,
		getGlobalFailoverPath: () => paths.globalFailover,
		getProjectFailoverPath: () => paths.projectFailover,
		getAgentResponseLanguage: () => "default",
	});
	const apiManager = createApiManagerSettingsProvider();
	const teammate = createTeammateSettingsProvider({
		getGlobalPath: () => paths.globalTeammate,
		getProjectPath: () => paths.projectTeammate,
		discoverTaskTypes: () => ["analysis"],
		discoverRoles: () => [],
	});
	const context: SettingsContextV1 = { cwd, locale: "en" };
	return { root, cwd, paths, context, cockpit, flow, apiManager, teammate, get runtime() { return runtime; } };
}

function writeJson(filePath: string, value: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("federated discovery tolerates arbitrary load order and missing plugins", async () => {
	const state = fixture();
	try {
		const events = new SharedEventBus();
		registerFlowSettingsProvider(events, state.flow);
		registerApiManagerSettingsProvider(events, state.apiManager);
		registerTeammateSettingsProvider(events, state.teammate);
		const registry = new SettingsProviderRegistry(events);
		registerCockpitSettingsProvider(events, state.cockpit);
		registry.discover(state.context);
		assert.deepEqual(registry.list().map((entry) => entry.providerId), [
			"pi-cockpit",
			"pi-maestro-api-manager",
			"pi-maestro-flow",
			"pi-maestro-teammate",
		]);
		assert.deepEqual((await registry.describe(state.context)).map((entry) => entry.providerId), [
			"pi-cockpit",
			"pi-maestro-flow",
			"pi-maestro-api-manager",
			"pi-maestro-teammate",
		]);

		const cockpitOnlyEvents = new SharedEventBus();
		const cockpitOnly = new SettingsProviderRegistry(cockpitOnlyEvents);
		registerCockpitSettingsProvider(cockpitOnlyEvents, state.cockpit);
		cockpitOnly.discover(state.context);
		assert.deepEqual(cockpitOnly.list().map((entry) => entry.providerId), ["pi-cockpit"]);
	} finally { rmSync(state.root, { recursive: true, force: true }); }
});

test("one coordinator commits Cockpit, Flow and Teammate without merging their storage", async () => {
	const state = fixture();
	try {
		const events = new SharedEventBus();
		const registry = new SettingsProviderRegistry(events);
		registerCockpitSettingsProvider(events, state.cockpit);
		registerFlowSettingsProvider(events, state.flow);
		registerTeammateSettingsProvider(events, state.teammate);
		registry.discover(state.context);
		const coordinator = new SettingsCoordinator(registry);
		assert.deepEqual(await coordinator.load(state.context), []);
		coordinator.setChange("pi-cockpit", { operation: "set", key: "sidebar.width", scope: "global", value: 48 });
		coordinator.setChange("pi-maestro-flow", { operation: "set", key: "compaction.enabled", scope: "project", value: false });
		coordinator.setChange("pi-maestro-flow", { operation: "set", key: "failover.enabled", scope: "project", value: true });
		coordinator.setChange("pi-maestro-teammate", { operation: "set", key: "routing.analysis.model", scope: "project", value: "provider/model" });
		const outcome = await coordinator.apply(state.context);
		assert.equal(outcome.status, "committed");
		assert.deepEqual([...new Set(outcome.activation.map((entry) => entry.boundary))].sort(), ["live", "next-invocation", "next-turn"]);
		assert.equal(state.runtime.sidebar.width, 48);
		assert.equal(JSON.parse(readFileSync(state.paths.cockpit, "utf8")).sidebar.width, 48);
		assert.equal(JSON.parse(readFileSync(state.paths.projectSettings, "utf8")).compaction.enabled, false);
		assert.equal(JSON.parse(readFileSync(state.paths.projectFailover, "utf8")).enabled, true);
		const teammateRaw = JSON.parse(readFileSync(state.paths.projectTeammate, "utf8"));
		assert.equal(teammateRaw.version, 3);
		assert.equal(teammateRaw.applyOverrides, true);
		assert.equal(teammateRaw.overrides.mappings.analysis, "provider/model");
		assert.equal(events.emitted.filter((entry) => entry.event === SETTINGS_CHANGED_EVENT).length, 3);
	} finally { rmSync(state.root, { recursive: true, force: true }); }
});

test("cross-provider validation conflict prevents every provider commit", async () => {
	const state = fixture();
	try {
		const events = new SharedEventBus();
		const registry = new SettingsProviderRegistry(events);
		registerCockpitSettingsProvider(events, state.cockpit);
		registerFlowSettingsProvider(events, state.flow);
		registerTeammateSettingsProvider(events, state.teammate);
		registry.discover(state.context);
		const coordinator = new SettingsCoordinator(registry);
		await coordinator.load(state.context);
		const cockpitBefore = readFileSync(state.paths.cockpit, "utf8");
		coordinator.setChange("pi-cockpit", { operation: "set", key: "enabled", scope: "global", value: false });
		coordinator.setChange("pi-maestro-teammate", { operation: "set", key: "routing.analysis.model", scope: "project", value: "provider/model" });
		writeJson(state.paths.projectTeammate, {
			version: 3,
			activeProfile: "default",
			applyOverrides: true,
			overrides: { mappings: { analysis: "external/model" }, thinkingLevels: {} },
		});
		const outcome = await coordinator.apply(state.context);
		assert.equal(outcome.status, "conflict");
		assert.equal(readFileSync(state.paths.cockpit, "utf8"), cockpitBefore);
		assert.equal(JSON.parse(readFileSync(state.paths.projectTeammate, "utf8")).overrides.mappings.analysis, "external/model");
		assert.equal(events.emitted.filter((entry) => entry.event === SETTINGS_CHANGED_EVENT).length, 0);
	} finally { rmSync(state.root, { recursive: true, force: true }); }
});

test("provider reload fences stale drafts until the shell reloads", async () => {
	const state = fixture();
	try {
		const events = new SharedEventBus();
		const registry = new SettingsProviderRegistry(events);
		registerTeammateSettingsProvider(events, state.teammate);
		registry.discover(state.context);
		const coordinator = new SettingsCoordinator(registry);
		await coordinator.load(state.context);
		coordinator.setChange("pi-maestro-teammate", { operation: "set", key: "routing.analysis.model", scope: "project", value: "provider/model" });
		const replacement = createTeammateSettingsProvider({
			getGlobalPath: () => state.paths.globalTeammate,
			getProjectPath: () => state.paths.projectTeammate,
			discoverTaskTypes: () => ["analysis"],
		});
		registerTeammateSettingsProvider(events, replacement);
		assert.equal(registry.get("pi-maestro-teammate")?.instanceId, replacement.instanceId);
		const outcome = await coordinator.apply(state.context);
		assert.equal(outcome.status, "validation-failed");
		assert.match(outcome.failures[0]?.message ?? "", /provider changed/);
		assert.equal(existsSync(state.paths.projectTeammate), false);
	} finally { rmSync(state.root, { recursive: true, force: true }); }
});

test("UI locale propagation is versioned and does not change Agent response language", async () => {
	const state = fixture();
	try {
		const events = new SharedEventBus();
		const registry = new SettingsProviderRegistry(events);
		registerFlowSettingsProvider(events, state.flow);
		registry.discover(state.context);
		const localeState = new SettingsLocaleState(state.paths.locale, registry);
		assert.equal(localeState.setLocale("zh-CN").ok, true);
		const localeEvent = [...events.emitted].reverse().find((entry) => entry.event === SETTINGS_LOCALE_EVENT)?.payload as {
			version?: unknown; locale?: unknown; generation?: unknown;
		};
		assert.equal(localeEvent.version, SETTINGS_PROTOCOL_VERSION);
		assert.equal(localeEvent.locale, "zh-CN");
		assert.equal(typeof localeEvent.generation, "string");
		const snapshot = await state.flow.read({ context: { ...state.context, locale: "zh-CN" } });
		assert.equal(snapshot.effective.values.find((entry) => entry.key === "responseLanguage.manage")?.value, "default");
		const description = await state.flow.describe({ context: { ...state.context, locale: "zh-CN" } });
		const catalog = description.catalogs?.["zh-CN"];
		assert.ok(catalog);
		assert.equal(catalog["flow.action.responseLanguage"], "Agent 回复语言");
	} finally { rmSync(state.root, { recursive: true, force: true }); }
});

test("API Manager has a dedicated Settings page with direct management actions", async () => {
	const state = fixture();
	try {
		const events = new SharedEventBus();
		const registry = new SettingsProviderRegistry(events);
		registerApiManagerSettingsProvider(events, state.apiManager);
		registry.discover(state.context);
		const coordinator = new SettingsCoordinator(registry);
		await coordinator.load(state.context);
		const providers = await registry.describe(state.context);
		const localeState = new SettingsLocaleState(state.paths.locale, registry);
		const shell = new MaestroSettingsShell({
			registry,
			coordinator,
			localeState,
			initial: { context: state.context, providers, failures: [] },
			reload: async () => ({ context: state.context, providers, failures: [] }),
			theme: { fg: (_role: string, value: string) => value, bold: (value: string) => value } as never,
			modelOptions: [],
			requestRender() {},
			requestAction() {},
			close() {},
		});
		const rendered = shell.render(120).join("\n");
		assert.match(rendered, /API Manager/);
		// Open the API Manager provider and check its grouped settings.
		shell.handleInput("\r");
		let inner = shell.render(120).join("\n");
		assert.match(inner, /— Providers and models —/);
		assert.match(inner, /Providers/);
		assert.match(inner, /— Retry policy —/);
		assert.match(inner, /Auto-retry enabled/);
		assert.match(inner, /Max retries/);
		assert.match(inner, /Retry base delay \(ms\)/);
		// The provider page scrolls: navigate down to reveal the later groups.
		for (let index = 0; index < 8; index++) shell.handleInput("\x1b[B");
		inner = shell.render(120).join("\n");
		assert.match(inner, /— Configuration overview —/);
		assert.match(inner, /Configuration overview ·/);
	} finally { rmSync(state.root, { recursive: true, force: true }); }
});

test("Teammate settings render task routing as ordered groups with management last", async () => {
	const state = fixture();
	try {
		const events = new SharedEventBus();
		const registry = new SettingsProviderRegistry(events);
		registerTeammateSettingsProvider(events, state.teammate);
		registry.discover(state.context);
		const coordinator = new SettingsCoordinator(registry);
		await coordinator.load(state.context);
		const providers = await registry.describe(state.context);
		const localeState = new SettingsLocaleState(state.paths.locale, registry);
		const shell = new MaestroSettingsShell({
			registry,
			coordinator,
			localeState,
			initial: { context: state.context, providers, failures: [] },
			reload: async () => ({ context: state.context, providers, failures: [] }),
			theme: { fg: (_role: string, value: string) => value, bold: (value: string) => value } as never,
			modelOptions: [],
			requestRender() {},
			requestAction() {},
			close() {},
		});
		const rendered = shell.render(120).join("\n");
		assert.match(rendered, /Teammate/);
		// Open the Teammate provider: its settings render as ordered groups with management last.
		shell.handleInput("\r");
		const inner = shell.render(120).join("\n");
		const analysis = inner.indexOf("— Analysis —");
		const model = inner.indexOf("Primary model");
		const fallbacks = inner.indexOf("Fallback models");
		const thinking = inner.indexOf("Thinking level");
		const management = inner.indexOf("— Management —");
		const roles = inner.indexOf("Discovered roles");
		assert.ok(analysis >= 0);
		assert.ok(analysis < model && model < fallbacks && fallbacks < thinking, inner);
		assert.ok(thinking < management && management < roles, inner);
	} finally { rmSync(state.root, { recursive: true, force: true }); }
});

test("legacy commands remain alongside /maestro-settings", () => {
	const cockpitSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	const flowSource = readFileSync(new URL("../../pi-maestro-flow/src/extension/index.ts", import.meta.url), "utf8");
	const failoverSource = readFileSync(new URL("../../pi-maestro-flow/src/providers/model-failover.ts", import.meta.url), "utf8");
	const compactionSource = readFileSync(new URL("../../pi-maestro-flow/src/tui/compaction-settings.ts", import.meta.url), "utf8");
	const teammateSource = readFileSync(new URL("../../pi-maestro-teammate/src/extension/index.ts", import.meta.url), "utf8");
	assert.match(cockpitSource, /registerCommand\("cockpit"/);
	assert.match(cockpitSource, /registerCommand\("maestro-settings"/);
	assert.match(flowSource, /registerCommand\("chinese"/);
	assert.match(failoverSource, /registerCommand\("model-failover"/);
	assert.match(compactionSource, /registerCommand\("maestro-compaction"/);
	assert.match(teammateSource, /registerCommand\("teammate-models"/);
});
