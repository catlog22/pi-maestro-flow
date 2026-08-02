import assert from "node:assert/strict";
import test from "node:test";
import {
	SETTINGS_ANNOUNCE_EVENT,
	SETTINGS_DISCOVER_EVENT,
	SETTINGS_LOCALE_EVENT,
	SETTINGS_PROTOCOL_VERSION,
	type SettingsAnnounceEventV1,
	type SettingsProviderV1,
} from "pi-maestro-settings-core/v1";
import { SettingsProviderRegistry, type SettingsEventBus } from "../src/settings/registry.ts";

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

function provider(id: string, instanceId: string): SettingsProviderV1 {
	return {
		describe: () => ({
			id,
			version: "1.0.0",
			instanceId,
			labelKey: `${id}.label`,
			capabilities: { read: true, write: false, prepareCommit: false, rollback: "none", hotUpdate: false },
			settings: [],
		}),
		read: () => ({
			providerId: id,
			providerInstanceId: instanceId,
			configured: { values: [], resources: [] },
			effective: { values: [] },
		}),
		validate: () => ({ valid: true, issues: [] }),
	};
}

function announcement(id: string, instanceId: string): SettingsAnnounceEventV1 {
	return {
		version: SETTINGS_PROTOCOL_VERSION,
		providerId: id,
		instanceId,
		provider: provider(id, instanceId),
	};
}

test("registry discovers providers independently of extension load order", () => {
	const bus = new FakeEventBus();
	const registry = new SettingsProviderRegistry(bus, () => 100);
	registry.start();
	const requestId = registry.discover({ cwd: "/workspace", locale: "en" });
	const discover = bus.emitted.find((entry) => entry.event === SETTINGS_DISCOVER_EVENT);
	assert.deepEqual(discover?.payload, {
		version: 1,
		requestId,
		context: { cwd: "/workspace", locale: "en" },
	});

	bus.emit(SETTINGS_ANNOUNCE_EVENT, announcement("flow", "flow-1"));
	assert.equal(registry.get("flow")?.instanceId, "flow-1");
	assert.equal(registry.get("flow")?.announcedAt, 100);
});

test("registry fences old provider instances and ignores invalid announcements", async () => {
	const bus = new FakeEventBus();
	const registry = new SettingsProviderRegistry(bus);
	registry.start();
	bus.emit(SETTINGS_ANNOUNCE_EVENT, { ...announcement("flow", "flow-1"), version: 2 });
	assert.equal(registry.get("flow"), undefined);

	bus.emit(SETTINGS_ANNOUNCE_EVENT, announcement("flow", "flow-1"));
	bus.emit(SETTINGS_ANNOUNCE_EVENT, announcement("flow", "flow-2"));
	assert.equal(registry.isCurrent("flow", "flow-1"), false);
	assert.equal(registry.isCurrent("flow", "flow-2"), true);
	assert.equal((await registry.describe({ cwd: "/workspace", locale: "zh-CN" }))[0]?.description.id, "flow");
});

test("registry isolates provider description failures", async () => {
	const bus = new FakeEventBus();
	const registry = new SettingsProviderRegistry(bus);
	registry.register(announcement("flow", "flow-1"));
	registry.register({
		...announcement("broken", "broken-1"),
		provider: {
			...provider("broken", "broken-1"),
			describe: () => { throw new Error("broken provider"); },
		},
	});
	const described = await registry.describe({ cwd: "/workspace", locale: "en" });
	assert.deepEqual(described.map((entry) => entry.providerId), ["flow"]);
	assert.equal(registry.descriptionError("broken"), "broken provider");
});

test("a new discovery generation drops providers that no longer announce", () => {
	const bus = new FakeEventBus();
	const registry = new SettingsProviderRegistry(bus);
	registry.register(announcement("stale", "stale-1"));
	registry.discover({ cwd: "/workspace", locale: "en" });
	assert.equal(registry.get("stale"), undefined);
});

test("registry publishes versioned locale events", () => {
	const bus = new FakeEventBus();
	const registry = new SettingsProviderRegistry(bus);
	registry.emitLocale("zh-CN", "locale-generation");
	assert.deepEqual(bus.emitted.at(-1), {
		event: SETTINGS_LOCALE_EVENT,
		payload: { version: 1, locale: "zh-CN", generation: "locale-generation" },
	});
});
