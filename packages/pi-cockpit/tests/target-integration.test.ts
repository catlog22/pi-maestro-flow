import assert from "node:assert/strict";
import test from "node:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import type { EndpointStoreSnapshot } from "../src/endpoint-store.ts";
import {
	buildCockpitTargetCatalogue,
	createTargetAutocompleteProvider,
	formatPendingTargetContext,
	routeCanonicalTargetInput,
	type CockpitTargetCatalogue,
} from "../src/target-integration.ts";

function snapshot(routeSuffix = "one"): EndpointStoreSnapshot {
	const localRegistry = {
		kind: "root",
		scope: "local",
		ownerId: "owner-local",
		ownerNonce: "nonce-local",
		status: "running",
		capabilities: ["message", "follow_up"],
	};
	const agentRegistry = {
		kind: "agent",
		scope: "local",
		ownerId: "owner-local",
		ownerNonce: "nonce-local",
		correlationId: "corr-alpha",
		status: "running",
		capabilities: ["message", "follow_up", "steer"],
	};
	const peerRegistry = {
		kind: "root",
		scope: "workspace-peer",
		ownerId: "owner-remote",
		ownerNonce: "nonce-remote",
		status: "sleeping",
		capabilities: ["message", "follow_up", "interrupt"],
	};
	const local = {
		id: "endpoint-local",
		kind: "root",
		label: "main",
		status: "running",
		routeSelector: `route-local-${routeSuffix}`,
		registryEndpoint: localRegistry,
	};
	const agent = {
		id: "endpoint-agent",
		kind: "agent",
		label: "alpha",
		correlationId: "corr-alpha",
		status: "running",
		routeSelector: `route-agent-${routeSuffix}`,
		registryEndpoint: agentRegistry,
	};
	const peer = {
		id: "endpoint-peer",
		kind: "window",
		label: "build",
		status: "sleeping",
		routeSelector: `route-peer-${routeSuffix}`,
		registryEndpoint: peerRegistry,
	};
	return {
		contentRevision: routeSuffix,
		mainEndpointId: local.id,
		viewMode: "agents",
		endpoints: [local, agent],
		windows: [peer],
		thread: [],
	} as unknown as EndpointStoreSnapshot;
}

function catalogue(routeSuffix = "one", sshAvailable = true): CockpitTargetCatalogue {
	return buildCockpitTargetCatalogue(snapshot(routeSuffix), [{
		id: "server-1",
		label: "Production",
		host: "2001:db8::1",
		user: "deploy",
		port: 22,
		shell: "bash",
		selected: true,
	}], sshAvailable);
}

function delegatedProvider() {
	let suggestions = 0;
	const provider: AutocompleteProvider = {
		async getSuggestions() {
			suggestions++;
			return { items: [{ value: "#legacy", label: "#legacy" }], prefix: "#legacy" };
		},
		applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
	};
	return { provider, suggestions: () => suggestions };
}

test("canonical catalogue uses agent correlation ids, window owner ids, and safe SSH metadata", () => {
	const value = catalogue();
	assert.deepEqual(value.targets.map((target) => [target.kind, target.id, target.current]), [
		["agent", "corr-alpha", undefined],
		["window", "owner-local", true],
		["window", "owner-remote", undefined],
		["ssh", "server-1", true],
	]);
	assert.match(value.targets[3]?.description ?? "", /deploy@\[2001:db8::1\]:22 · bash/u);
	assert.doesNotMatch(JSON.stringify(value.targets), /password|hostKey|identityFile/u);
	assert.equal(value.endpoints.find((endpoint) => endpoint.id === "owner-remote")?.routeSelector, "route-peer-one");
});

test("canonical autocomplete exposes category, kind, target, and mode stages while delegating legacy hashes", async () => {
	const delegated = delegatedProvider();
	const provider = createTargetAutocompleteProvider(delegated.provider, async () => catalogue());
	const signal = new AbortController().signal;
	const categories = await provider.getSuggestions(["#"], 0, 1, { signal });
	assert.deepEqual(categories?.items.map((item) => item.value), [
		"#agent:", "#window:", "#ssh:", "#direct-send:",
	]);
	const kinds = await provider.getSuggestions(["#direct-send:"], 0, 13, { signal });
	assert.deepEqual(kinds?.items.map((item) => item.value), ["#direct-send:agent:", "#direct-send:window:"]);
	const agents = await provider.getSuggestions(["#direct-send:agent:"], 0, 19, { signal });
	assert.deepEqual(agents?.items.map((item) => item.value), ["#direct-send:agent:corr-alpha:"]);
	const selected = provider.applyCompletion(
		["#direct-send:agent:"],
		0,
		19,
		agents!.items[0]!,
		agents!.prefix,
	);
	assert.equal(selected.lines[0], "#direct-send:agent:corr-alpha:");
	const modes = await provider.getSuggestions([selected.lines[0]!], 0, selected.cursorCol, { signal });
	assert.deepEqual(modes?.items.map((item) => item.value), [
		"#direct-send:agent:corr-alpha:follow_up ",
		"#direct-send:agent:corr-alpha:steer ",
		"#direct-send:agent:corr-alpha:interrupt ",
	]);
	assert.equal(delegated.suggestions(), 0);
	assert.equal((await provider.getSuggestions(["#legacy"], 0, 7, { signal }))?.items[0]?.value, "#legacy");
	assert.equal(delegated.suggestions(), 1);
});

function routeHost(values: CockpitTargetCatalogue[] = [catalogue()]) {
	const restored: string[] = [];
	const notifications: Array<{ message: string; type: string }> = [];
	let reads = 0;
	return {
		restored,
		notifications,
		reads: () => reads,
		options: {
			getCatalogue: async () => values[Math.min(reads++, values.length - 1)]!,
			activateSsh: async (_id: string) => {},
			notify: (message: string, type: "warning" | "error") => notifications.push({ message, type }),
			restore: (text: string) => restored.push(text),
		},
	};
}

test("agent and window references strip canonical tokens and carry one-shot authoritative context", async () => {
	const host = routeHost();
	const result = await routeCanonicalTargetInput({
		...host.options,
		text: "#agent:corr review this",
		hasImages: false,
	});
	assert.deepEqual(result, {
		action: "transform",
		text: "review this",
		reference: { kind: "agent", id: "corr-alpha" },
	});
	const context = formatPendingTargetContext(result!.action === "transform" ? result.reference! : { kind: "agent", id: "" }, catalogue("fresh"));
	assert.match(context ?? "", /id "corr-alpha"/u);
	assert.match(context ?? "", /route "route-agent-fresh"/u);
	assert.match(context ?? "", /status "running"/u);
	assert.match(context ?? "", /follow_up.*steer/u);
	assert.doesNotMatch(context ?? "", /server-1|deploy|2001:db8/u);
	assert.equal(formatPendingTargetContext({ kind: "agent", id: "stale" }, catalogue()), undefined);
	assert.deepEqual(host.restored, []);
});

test("direct send re-resolves authority, defaults to follow_up, validates capability, and calls once", async () => {
	const host = routeHost([catalogue("old"), catalogue("fresh")]);
	const sends: unknown[] = [];
	const result = await routeCanonicalTargetInput({
		...host.options,
		text: "#direct-send:window:owner-rem send this",
		hasImages: false,
		send: async (request) => {
			sends.push(request);
			return { delivered: true };
		},
	});
	assert.deepEqual(result, { action: "handled" });
	assert.deepEqual(sends, [{
		selector: "route-peer-fresh",
		message: "send this",
		mode: "follow_up",
	}]);
	assert.equal(host.reads(), 2);
	assert.deepEqual(host.restored, []);

	const explicit = routeHost([catalogue("old"), catalogue("fresh")]);
	const explicitSends: unknown[] = [];
	assert.deepEqual(await routeCanonicalTargetInput({
		...explicit.options,
		text: "#direct-send:agent:corr-alpha:steer steer this",
		hasImages: false,
		send: async (request) => { explicitSends.push(request); return { delivered: true }; },
	}), { action: "handled" });
	assert.deepEqual(explicitSends, [{
		selector: "route-agent-fresh",
		message: "steer this",
		mode: "steer",
	}]);
});

test("direct-send failures restore original text without sending or claiming consumption", async () => {
	for (const entry of [
		{ text: "#direct-send:agent:corr-alpha:interrupt stop", images: false, expected: /does not support interrupt/u },
		{ text: "#direct-send:agent:corr-alpha send", images: true, expected: /Images cannot be delivered/u },
		{ text: "#direct-send:agent:missing send", images: false, expected: /no longer available/u },
	]) {
		const host = routeHost();
		let sends = 0;
		assert.deepEqual(await routeCanonicalTargetInput({
			...host.options,
			text: entry.text,
			hasImages: entry.images,
			send: async () => { sends++; return { delivered: true }; },
		}), { action: "handled" });
		assert.equal(sends, 0);
		assert.deepEqual(host.restored, [entry.text]);
		assert.match(host.notifications[0]?.message ?? "", entry.expected);
	}

	const base = catalogue();
	const firstAgent = base.endpoints.find((endpoint) => endpoint.kind === "agent")!;
	const ambiguousCatalogue: CockpitTargetCatalogue = {
		...base,
		targets: [...base.targets, { kind: "agent", id: "corr-alpine", label: "alpine" }],
		endpoints: [...base.endpoints, { ...firstAgent, id: "corr-alpine", label: "alpine" }],
	};
	const ambiguous = routeHost([ambiguousCatalogue]);
	const ambiguousText = "#agent:corr-al inspect";
	assert.deepEqual(await routeCanonicalTargetInput({
		...ambiguous.options,
		text: ambiguousText,
		hasImages: false,
	}), { action: "handled" });
	assert.deepEqual(ambiguous.restored, [ambiguousText]);
	assert.match(ambiguous.notifications[0]?.message ?? "", /More than one/u);

	const host = routeHost();
	assert.deepEqual(await routeCanonicalTargetInput({
		...host.options,
		text: "#direct-send:agent:corr-alpha send",
		hasImages: false,
		send: async () => ({ delivered: false, error: "queue closed" }),
	}), { action: "handled" });
	assert.deepEqual(host.restored, ["#direct-send:agent:corr-alpha send"]);
	assert.match(host.notifications[0]?.message ?? "", /queue closed/u);
	assert.doesNotMatch(host.notifications[0]?.message ?? "", /consumed/u);
});

test("SSH references activate exact live ids, support bind-only input, and restore on failure", async () => {
	const host = routeHost();
	const activated: string[] = [];
	const withBody = await routeCanonicalTargetInput({
		...host.options,
		activateSsh: async (id) => { activated.push(id); },
		text: "#ssh:server run diagnostics",
		hasImages: false,
	});
	assert.deepEqual(withBody, { action: "transform", text: "run diagnostics" });
	assert.deepEqual(activated, ["server-1"]);

	const bindOnly = await routeCanonicalTargetInput({
		...host.options,
		activateSsh: async (id) => { activated.push(id); },
		text: "#ssh:server-1",
		hasImages: false,
	});
	assert.deepEqual(bindOnly, { action: "handled" });
	assert.deepEqual(activated, ["server-1", "server-1"]);

	for (const control of ["#ssh:+server-1", "  #SSH:-server-1  "]) {
		assert.equal(await routeCanonicalTargetInput({
			...host.options,
			activateSsh: async (id) => { activated.push(id); },
			text: control,
			hasImages: false,
		}), undefined, "attachment controls remain local to the Flow SSH manager");
	}
	assert.deepEqual(activated, ["server-1", "server-1"]);

	const locked = routeHost([catalogue("one", false)]);
	assert.deepEqual(await routeCanonicalTargetInput({
		...locked.options,
		activateSsh: async (id) => { assert.equal(id, "server-1"); },
		text: "#ssh:server-1",
		hasImages: false,
	}), { action: "handled" });

	const failed = routeHost();
	assert.deepEqual(await routeCanonicalTargetInput({
		...failed.options,
		activateSsh: async () => { throw new Error("host disappeared"); },
		text: "#ssh:server-1 run",
		hasImages: false,
	}), { action: "handled" });
	assert.deepEqual(failed.restored, ["#ssh:server-1 run"]);
	assert.match(failed.notifications[0]?.message ?? "", /host disappeared/u);
});
