import assert from "node:assert/strict";
import test from "node:test";
import {
	SessionHostRegistry,
	projectSessionEndpoints,
	type SessionOwnerProjection,
} from "pi-maestro-teammate/v1/sessions";
import {
	EndpointStore,
	LEGACY_MAIN_ENDPOINT_ID,
	SESSION_HOST_REGISTRY_EVENT,
	type SessionEventSource,
} from "../src/endpoint-store.ts";
import type { AgentRow } from "../src/types.ts";

function agent(overrides: Partial<AgentRow> = {}): AgentRow {
	return {
		correlationId: "c1",
		agent: "general",
		name: "builder",
		role: "general",
		task: "build",
		status: "running",
		tail: "",
		startedAt: 1_000,
		lastActivityAt: 1_000,
		...overrides,
	};
}

const WORKSPACE = "w".repeat(64);
const OWNER = "a".repeat(32);
const NONCE = "1".repeat(32);

function owners(name = "builder"): SessionOwnerProjection[] {
	return [{
		workspaceId: WORKSPACE,
		ownerId: OWNER,
		ownerNonce: NONCE,
		scope: "local",
		status: "running",
		sessionName: "main-window",
		agents: [{
			workspaceId: WORKSPACE,
			ownerId: OWNER,
			ownerNonce: NONCE,
			correlationId: "c1",
			status: "running",
			name,
			agent: "general",
		}],
	}, {
		workspaceId: WORKSPACE,
		ownerId: "b".repeat(32),
		ownerNonce: "2".repeat(32),
		scope: "workspace-peer",
		status: "running",
		sessionName: "other-window",
		agents: [],
	}];
}

class Events implements SessionEventSource {
	readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
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

test("EndpointStore falls back to stable main/start-order agent ids and hides graph containers", () => {
	let rows = [
		agent({ correlationId: "later", name: "later", startedAt: 20 }),
		agent({ correlationId: "graph", agent: "graph(2)", startedAt: 1 }),
		agent({ correlationId: "first", name: "first", startedAt: 10 }),
	];
	const store = new EndpointStore({ getLegacyAgents: () => rows });
	const first = store.snapshot();
	assert.equal(first.mainEndpointId, LEGACY_MAIN_ENDPOINT_ID);
	assert.deepEqual(first.endpoints.map((endpoint) => endpoint.label), ["main", "first", "later"]);
	assert.ok(first.endpoints.every((endpoint) => endpoint.id.startsWith("cockpit-session/v1/")));

	rows = rows.map((row) => ({ ...row, lastActivityAt: row.lastActivityAt + 100 }));
	store.refreshLegacy();
	assert.deepEqual(store.snapshot().endpoints.map((endpoint) => endpoint.label), ["main", "first", "later"]);
});

test("EndpointStore subscribes to SessionHostRegistry and projects canonical local endpoints only", () => {
	let rows = [agent()];
	const registry = new SessionHostRegistry({ endpoints: projectSessionEndpoints(owners()) });
	const store = new EndpointStore({ getLegacyAgents: () => rows });
	const revisions: string[] = [];
	store.subscribe((snapshot) => revisions.push(snapshot.contentRevision));
	store.connect({ registry });

	const snapshot = store.snapshot();
	assert.equal(snapshot.endpoints.length, 2, "workspace-peer roots belong to the future Window Bar");
	assert.deepEqual(snapshot.endpoints.map((endpoint) => endpoint.kind), ["root", "agent"]);
	assert.ok(snapshot.endpoints.every((endpoint) => endpoint.source === "registry"));
	assert.equal(snapshot.endpoints[1]?.agentRow, rows[0]);
	assert.equal(snapshot.endpoints[1]?.routeSelector, "c1");

	registry.replaceEndpoints(projectSessionEndpoints(owners("reviewer")));
	assert.equal(store.snapshot().endpoints[1]?.label, "builder", "live legacy content keeps the current local label");
	rows = [];
	store.refreshLegacy();
	assert.equal(store.snapshot().endpoints[1]?.label, "reviewer");
	assert.ok(revisions.length >= 3);
	store.disconnect();
});

test("EndpointStore excludes local agents outside the current root owner fence", () => {
	const registry = new SessionHostRegistry({ endpoints: projectSessionEndpoints(owners()) });
	const canonical = registry.snapshot();
	const localAgent = canonical.endpoints.find((endpoint) => endpoint.kind === "agent" && endpoint.scope === "local");
	assert.ok(localAgent);
	const foreignOwner = "0".repeat(32);
	const foreignNonce = "3".repeat(32);
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	assert.equal(store.applyRegistrySnapshot({
		...canonical,
		contentRevision: "foreign-local-agent",
		endpointContentRevision: "foreign-local-agent-endpoints",
		endpoints: [...canonical.endpoints, {
			...localAgent,
			id: `${localAgent.id}-foreign`,
			ownerId: foreignOwner,
			ownerNonce: foreignNonce,
			correlationId: "foreign-agent",
			name: "foreign",
			contentRevision: "foreign-agent",
		}],
	}), true);
	assert.deepEqual(store.snapshot().endpoints.map((endpoint) => endpoint.label), ["main", "builder"]);
	assert.equal(store.snapshot().endpoints.some((endpoint) => endpoint.correlationId === "foreign-agent"), false);
});

test("EndpointStore accepts versioned session events and keeps legacy agents during registry lag", () => {
	const rows = [agent({ correlationId: "legacy-extra", name: "extra", startedAt: 2_000 })];
	const events = new Events();
	const store = new EndpointStore({ getLegacyAgents: () => rows });
	store.connect({ events });
	const registry = new SessionHostRegistry({ endpoints: projectSessionEndpoints(owners()) });
	events.emit(SESSION_HOST_REGISTRY_EVENT, registry.snapshot());

	assert.deepEqual(store.snapshot().endpoints.map((endpoint) => endpoint.label), ["main", "builder", "extra"]);
	assert.equal(events.handlers.get(SESSION_HOST_REGISTRY_EVENT)?.size, 1);
	store.disconnect();
	assert.equal(events.handlers.get(SESSION_HOST_REGISTRY_EVENT)?.size, 0);
});

test("EndpointStore output revision ignores status-only churn and changes with new output", () => {
	let rows = [agent({ tail: "first output" })];
	const store = new EndpointStore({ getLegacyAgents: () => rows });
	const before = store.snapshot().endpoints[1]?.outputRevision;
	rows = [{ ...rows[0]!, status: "retrying", lastActivityAt: 2_000 }];
	store.refreshLegacy();
	assert.equal(store.snapshot().endpoints[1]?.outputRevision, before);
	rows = [{ ...rows[0]!, tail: "second output", lastActivityAt: 3_000 }];
	store.refreshLegacy();
	assert.notEqual(store.snapshot().endpoints[1]?.outputRevision, before);
});

test("EndpointStore numbers visible duplicate agent labels", () => {
	const rows = [
		agent({ correlationId: "builder-a", name: "builder", startedAt: 10 }),
		agent({ correlationId: "builder-b", name: "builder", startedAt: 20 }),
	];
	const store = new EndpointStore({ getLegacyAgents: () => rows });
	assert.deepEqual(store.snapshot().endpoints.map((endpoint) => endpoint.label), ["main", "builder·1", "builder·2"]);
});
