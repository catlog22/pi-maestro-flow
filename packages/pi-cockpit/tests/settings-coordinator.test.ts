import assert from "node:assert/strict";
import test from "node:test";
import {
	SETTINGS_CHANGED_EVENT,
	SETTINGS_PROTOCOL_VERSION,
	type SettingsChange,
	type SettingsProviderV1,
	type SettingsSnapshot,
} from "pi-maestro-settings-core/v1";
import { SettingsCoordinator } from "../src/settings/coordinator.ts";
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

const context = { cwd: "/workspace", locale: "en" } as const;

function snapshot(providerId: string, instanceId: string, etag = `${providerId}-0`): SettingsSnapshot {
	return {
		providerId,
		providerInstanceId: instanceId,
		configured: {
			values: [{ key: "enabled", scope: "global", state: "set", value: false, resource: { providerId, scope: "global", id: `${providerId}.json` } }],
			resources: [{ resource: { providerId, scope: "global", id: `${providerId}.json` }, etag }],
		},
		effective: { values: [{ key: "enabled", value: false, source: "configured", scope: "global" }] },
	};
}

interface ProviderBehavior {
	prepareConflict?: boolean;
	commitFailure?: boolean;
}

function mutableProvider(
	providerId: string,
	instanceId: string,
	log: string[],
	behavior: ProviderBehavior = {},
): SettingsProviderV1 {
	let current = snapshot(providerId, instanceId);
	return {
		describe: () => ({
			id: providerId,
			version: "1.0.0",
			instanceId,
			labelKey: `${providerId}.label`,
			capabilities: { read: true, write: true, prepareCommit: true, rollback: "full", hotUpdate: true },
			settings: [],
		}),
		read: () => current,
		validate: () => {
			log.push(`validate:${providerId}`);
			return { valid: true, issues: [] };
		},
		prepare: (request) => {
			log.push(`prepare:${providerId}`);
			if (behavior.prepareConflict) {
				return {
					prepared: false,
					validation: { valid: false, issues: [] },
					conflicts: [{
						resource: current.configured.resources[0]!.resource,
						expectedEtag: request.expectedRevisions?.[0]?.etag,
						actualEtag: "external",
					}],
				};
			}
			return {
				prepared: true,
				prepareToken: `${providerId}:prepared`,
				validation: { valid: true, issues: [] },
				activation: [{ boundary: "live", keys: ["enabled"] }],
			};
		},
		commit: () => {
			log.push(`commit:${providerId}`);
			if (behavior.commitFailure) throw new Error(`${providerId} commit failed`);
			current = snapshot(providerId, instanceId, `${providerId}-1`);
			return {
				snapshot: current,
				revisions: current.configured.resources,
				changedKeys: ["enabled"],
				activation: [{ boundary: "live", keys: ["enabled"] }],
			};
		},
		abort: () => { log.push(`abort:${providerId}`); },
		rollback: () => {
			log.push(`rollback:${providerId}`);
			current = snapshot(providerId, instanceId);
			return { rolledBack: true, snapshot: current };
		},
		applyRuntime: () => {
			log.push(`runtime:${providerId}`);
			return { appliedKeys: ["enabled"], deferred: [], failed: [] };
		},
	};
}

function register(registry: SettingsProviderRegistry, providerId: string, instanceId: string, provider: SettingsProviderV1): void {
	registry.register({ version: SETTINGS_PROTOCOL_VERSION, providerId, instanceId, provider });
}

const change: SettingsChange = { operation: "set", key: "enabled", scope: "global", value: true };

test("coordinator validates all providers before prepare and commits before runtime apply", async () => {
	const bus = new FakeEventBus();
	const registry = new SettingsProviderRegistry(bus);
	const log: string[] = [];
	register(registry, "a", "a-1", mutableProvider("a", "a-1", log));
	register(registry, "b", "b-1", mutableProvider("b", "b-1", log));
	const coordinator = new SettingsCoordinator(registry);
	assert.deepEqual(await coordinator.load(context), []);
	coordinator.setChange("a", change);
	coordinator.setChange("b", change);

	const result = await coordinator.apply(context);
	assert.equal(result.status, "committed");
	assert.ok(Math.max(log.indexOf("validate:a"), log.indexOf("validate:b")) < log.indexOf("prepare:a"));
	assert.ok(Math.max(log.indexOf("commit:a"), log.indexOf("commit:b")) < log.indexOf("runtime:a"));
	assert.equal(bus.emitted.filter((entry) => entry.event === SETTINGS_CHANGED_EVENT).length, 2);
	assert.deepEqual(coordinator.modifiedProviderIds(), []);
});

test("prepare conflicts abort already prepared providers without committing", async () => {
	const bus = new FakeEventBus();
	const registry = new SettingsProviderRegistry(bus);
	const log: string[] = [];
	register(registry, "a", "a-1", mutableProvider("a", "a-1", log));
	register(registry, "b", "b-1", mutableProvider("b", "b-1", log, { prepareConflict: true }));
	const coordinator = new SettingsCoordinator(registry);
	await coordinator.load(context);
	coordinator.setChange("a", change);
	coordinator.setChange("b", change);

	const result = await coordinator.apply(context);
	assert.equal(result.status, "conflict");
	assert.ok(log.includes("abort:a"));
	assert.equal(log.some((entry) => entry.startsWith("commit:")), false);
});

test("commit failure rolls back prior commits and publishes no changed event", async () => {
	const bus = new FakeEventBus();
	const registry = new SettingsProviderRegistry(bus);
	const log: string[] = [];
	register(registry, "a", "a-1", mutableProvider("a", "a-1", log));
	register(registry, "b", "b-1", mutableProvider("b", "b-1", log, { commitFailure: true }));
	const coordinator = new SettingsCoordinator(registry);
	await coordinator.load(context);
	coordinator.setChange("a", change);
	coordinator.setChange("b", change);

	const result = await coordinator.apply(context);
	assert.equal(result.status, "commit-failed");
	assert.ok(log.includes("rollback:a"));
	assert.equal(bus.emitted.some((entry) => entry.event === SETTINGS_CHANGED_EVENT), false);
});
