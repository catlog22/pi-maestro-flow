import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { EndpointStore } from "../src/endpoint-store.ts";
import { SessionUiState } from "../src/session-ui-state.ts";
import { renderWindowBar } from "../src/window-bar.ts";
import { renderWindowThreadView } from "../src/window-thread-view.ts";
import type { SessionHostSnapshot } from "pi-maestro-teammate/v1/sessions";

const theme: Pick<Theme, "fg" | "bold"> = {
	fg: (_color, text) => text,
	bold: (text) => text,
};
const WORKSPACE = "a".repeat(64);
const LOCAL_OWNER = "b".repeat(32);
const LOCAL_NONCE = "c".repeat(32);
const REMOTE_OWNER = "d".repeat(32);
const REMOTE_NONCE = "e".repeat(32);
const ROOT_ID = `pi-session/v1/${WORKSPACE}/${REMOTE_OWNER}/${REMOTE_NONCE}/root`;

function snapshot(viewMode: "agents" | "windows" = "agents"): SessionHostSnapshot {
	return {
		version: 1,
		contentRevision: `all-${viewMode}`,
		endpointContentRevision: "endpoints",
		threadContentRevision: "thread",
		viewMode,
		monitoredEndpointIds: viewMode === "windows" ? [ROOT_ID] : [],
		endpoints: [
			{
				version: 1,
				id: `pi-session/v1/${WORKSPACE}/${LOCAL_OWNER}/${LOCAL_NONCE}/root`,
				kind: "root",
				scope: "local",
				transport: "local-root",
				workspaceId: WORKSPACE,
				ownerId: LOCAL_OWNER,
				ownerNonce: LOCAL_NONCE,
				status: "running",
				capabilities: ["inspect", "message", "steer", "follow_up"],
				ordinal: 0,
				contentRevision: "local",
			},
			{
				version: 1,
				id: ROOT_ID,
				kind: "root",
				scope: "workspace-peer",
				transport: "workspace-peer-v1",
				workspaceId: WORKSPACE,
				ownerId: REMOTE_OWNER,
				ownerNonce: REMOTE_NONCE,
				status: "running",
				capabilities: ["inspect", "message", "steer", "follow_up"],
				ordinal: 1,
				contentRevision: "remote",
				sessionName: "build",
				contextPressure: 73,
				agentCount: 1,
			},
			{
				version: 1,
				id: `${ROOT_ID}/agent/worker`,
				kind: "agent",
				scope: "workspace-peer",
				transport: "workspace-peer-v1",
				workspaceId: WORKSPACE,
				ownerId: REMOTE_OWNER,
				ownerNonce: REMOTE_NONCE,
				correlationId: "worker",
				status: "running",
				capabilities: ["inspect", "message", "steer", "follow_up"],
				ordinal: 2,
				contentRevision: "worker",
				name: "worker",
				summary: "building",
			},
		],
		thread: [{
			version: 1,
			messageId: "f".repeat(32),
			workspaceId: WORKSPACE,
			peerOwnerId: REMOTE_OWNER,
			peerOwnerNonce: REMOTE_NONCE,
			direction: "outgoing",
			source: "user",
			mode: "follow_up",
			body: "check the build",
			status: "accepted",
			createdAt: 1,
			updatedAt: 2,
			revision: 1,
			contentRevision: "message",
		}],
	};
}

test("Cockpit intercepts exact monitor before agent routing and hides windows by default", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	const keyword = source.indexOf('e.text.trim() === "monitor"');
	const agentRoute = source.indexOf("routeAgentInput(", keyword);
	assert.ok(keyword >= 0 && agentRoute > keyword);
	assert.match(source, /sessionUi\.mode === "window" && \(interactiveText \|\| hasImages\)/);
	assert.match(source, /Image input cannot be routed to a peer window/);
	assert.match(source, /sessionUi\.mode === "window"[\s\S]*?renderWindowBar/);
	assert.match(source, /WINDOW_MONITOR_TOGGLE_KEY = "alt\+w"/);
	assert.match(source, /registry\.setMonitored\(window\.id, enabled\)/);
});
test("EndpointStore keeps remote windows out of the Agent Bar projection", () => {
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	assert.equal(store.applyRegistrySnapshot(snapshot()), true);
	const value = store.snapshot();
	assert.equal(value.viewMode, "agents");
	assert.equal(value.endpoints.some((endpoint) => endpoint.kind === "window"), false);
	assert.equal(value.windows.length, 1);
	assert.equal(value.windows[0]?.label, "build");
	assert.equal(value.windows[0]?.contextPressure, 73);
	assert.equal(value.windows[0]?.remoteAgents?.length, 1);
});

test("Window Bar renders only explicit window endpoints and fits every width", () => {
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	store.applyRegistrySnapshot(snapshot("windows"));
	const value = store.snapshot();
	const state = new SessionUiState();
	state.reconcile("window", value.windows, value.windows[0]?.id);
	for (let width = 1; width <= 120; width++) {
		const lines = renderWindowBar(value.windows, state, value.monitoredEndpointIds, width, theme as Theme);
		assert.equal(lines.length, 1);
		assert.ok(visibleWidth(lines[0]!) <= width, `width ${width}: ${lines[0]}`);
	}
	assert.match(renderWindowBar(value.windows, state, value.monitoredEndpointIds, 80, theme as Theme)[0]!, /#build/);
});

test("Window thread view filters by exact owner nonce and renders communication only", () => {
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	store.applyRegistrySnapshot(snapshot("windows"));
	const value = store.snapshot();
	const lines = renderWindowThreadView(value.windows[0], [
		...value.thread,
		{ ...value.thread[0]!, messageId: "0".repeat(32), peerOwnerNonce: "0".repeat(32), body: "wrong incarnation" },
	], 80, 10, { offset: 0, following: true }, theme as Theme);
	assert.match(lines.join("\n"), /check the build/);
	assert.doesNotMatch(lines.join("\n"), /wrong incarnation/);
	assert.match(lines.join("\n"), /worker/);
});

test("Agent and Window selections retain independent drafts and restore on mode switch", () => {
	const state = new SessionUiState();
	state.reconcile("agent", [{ id: "main", logicalKey: "main" }], "main");
	state.reconcile("window", [{ id: ROOT_ID, logicalKey: `window:${REMOTE_OWNER}` }], ROOT_ID);
	state.setDraft("main", "agent draft");
	state.setDraft(ROOT_ID, "window draft");
	state.setMode("window");
	assert.equal(state.endpoint(ROOT_ID).draft, "window draft");
	state.setMode("agent");
	assert.equal(state.selectedId("agent"), "main");
	assert.equal(state.endpoint("main").draft, "agent draft");
});
