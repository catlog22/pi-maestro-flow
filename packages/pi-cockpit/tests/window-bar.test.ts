import { altKey } from "pi-maestro-settings-core/v1";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { matchesKey, visibleWidth, type AutocompleteProvider } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { EndpointStore, isMonitorControlEndpoint, type CockpitEndpoint, type EndpointStoreSnapshot } from "../src/endpoint-store.ts";
import { SessionUiState } from "../src/session-ui-state.ts";
import { assignedAgentColor } from "../src/agent-bar.ts";
import { renderWindowBar, windowSessionColor } from "../src/window-bar.ts";
import {
	buildWindowAutocompleteTargets,
	createWindowAutocompleteProvider,
	ownerDisplayToken,
	resolveWindowRouteInput,
} from "../src/window-autocomplete.ts";
import { renderWindowThreadView } from "../src/window-thread-view.ts";
import { cockpitTuiLocale } from "../src/tui-i18n.ts";
import type { SessionHostSnapshot } from "pi-maestro-teammate/v1/sessions";

/** `altKey` escaped for use inside a regular expression: `+` is a metacharacter. */
const altRe = (key: string): string => altKey(key).replaceAll("+", "\\+");

cockpitTuiLocale.setLocale("en");

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
const SECOND_OWNER = "1".repeat(32);
const SECOND_NONCE = "2".repeat(32);
const SECOND_ROOT_ID = `pi-session/v1/${WORKSPACE}/${SECOND_OWNER}/${SECOND_NONCE}/root`;

function snapshot(viewMode: "agents" | "windows" = "agents"): SessionHostSnapshot {
	return {
		version: 1,
		contentRevision: `all-${viewMode}`,
		endpointContentRevision: "endpoints",
		threadContentRevision: "thread",
		viewMode,
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
				capabilities: [
					"inspect",
					"message",
					"steer",
					"follow_up",
					...(viewMode === "windows" ? ["monitor-workspace-aggregation" as const] : []),
				],
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

function remoteWindow(value: EndpointStoreSnapshot): CockpitEndpoint {
	const window = value.windows.find((endpoint) => endpoint.id === ROOT_ID);
	assert.ok(window);
	return window;
}

function controlWindow(value: EndpointStoreSnapshot): CockpitEndpoint {
	const window = value.windows.find(isMonitorControlEndpoint);
	assert.ok(window);
	return window;
}

function withSecondWindow(value: SessionHostSnapshot, sessionName = "review"): SessionHostSnapshot {
	return {
		...value,
		contentRevision: `${value.contentRevision}-second`,
		endpointContentRevision: `${value.endpointContentRevision}-second`,
		endpoints: [...value.endpoints, {
			version: 1,
			id: SECOND_ROOT_ID,
			kind: "root",
			scope: "workspace-peer",
			transport: "workspace-peer-v1",
			workspaceId: WORKSPACE,
			ownerId: SECOND_OWNER,
			ownerNonce: SECOND_NONCE,
			status: "running",
			capabilities: ["inspect", "message", "steer", "follow_up"],
			ordinal: 3,
			contentRevision: "second-root",
			sessionName,
			agentCount: 0,
		}],
	};
}

test("Cockpit intercepts exact monitor before agent routing and hides windows by default", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	const keyword = source.indexOf('e.text.trim() === "monitor"');
	const agentRoute = source.indexOf("routeAgentInput(", keyword);
	assert.ok(keyword >= 0 && agentRoute > keyword);
	assert.match(source, /sessionUi\.mode === "window" && \(interactiveText \|\| hasImages\)/);
	const controlRoute = source.indexOf("if (isMonitorControlEndpoint(target))");
	const peerImageRejection = source.indexOf("if (hasImages)", controlRoute);
	assert.ok(controlRoute >= 0 && peerImageRejection > controlRoute);
	assert.match(source, /isMonitorControlEndpoint\(target\)[\s\S]*?action: "continue"/);
	assert.match(source, /tuiT\("notice\.imagePeer"\)/);
	assert.match(source, /sessionUi\.mode === "window"[\s\S]*?renderWindowBar/);
	assert.doesNotMatch(source, /WINDOW_MONITOR_TOGGLE_KEY|registry\.setMonitored/);
	assert.match(source, /sessionUi\.mode === "window" \? selectedWindowInputTarget\(\) : selectedAgentTarget\(\)/);
	assert.match(source, /!endpoint \|\| isMonitorControlEndpoint\(endpoint\)\) return undefined;/);
	assert.match(source, /sigil: "#"/);
	assert.match(source, /createWindowAutocompleteProvider/);
	assert.match(source, /config\.enabled && e\.source === "interactive"/);
	assert.match(source, /resolveWindowRouteInput\(e\.text, windowAutocompleteTargets\(\), selectedHashWindowTargets\)/);
	assert.match(source, /config\.enabled && sessionUi\.mode === "window"/);
	const rejectedHashRoute = source.slice(
		source.indexOf('if (hashWindowRoute.code !== "resolved")'),
		source.indexOf("if (!hashWindowRoute.message)"),
	);
	assert.doesNotMatch(rejectedHashRoute, /selectedHashWindowTargets\.delete/);
	assert.match(source, /selectedHashWindowTargets\.delete\(hashWindowRoute\.token\)/);
	assert.doesNotMatch(source, /selectedHashWindowTargets\.delete\(hashWindowRoute\.target\.token/);
	assert.match(source, /matchesKey\(data, "alt\+left"\)/);
	assert.match(source, /matchesKey\(data, "alt\+right"\)/);
});
test("Alt+arrow terminal sequences provide explicit draft-safe Window navigation", () => {
	assert.equal(matchesKey("\x1b[1;3D", "alt+left"), true);
	assert.equal(matchesKey("\x1b[1;3C", "alt+right"), true);
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
	assert.equal(value.windows[0]?.logicalKey, `window:${REMOTE_OWNER}:${REMOTE_NONCE}`);
});

test("Window aggregation fails closed when windows mode lacks the Monitor capability", () => {
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	const unprivileged = snapshot("windows");
	assert.equal(store.applyRegistrySnapshot({
		...unprivileged,
		endpoints: unprivileged.endpoints.map((endpoint) => endpoint.scope === "local" && endpoint.kind === "root"
			? { ...endpoint, capabilities: endpoint.capabilities.filter((capability) => capability !== "monitor-workspace-aggregation") }
			: endpoint),
	}), true);
	assert.deepEqual(store.snapshot().windows, []);
});

test("Window Bar includes a local Monitor control entry only while active", () => {
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	store.applyRegistrySnapshot(snapshot("windows"));
	const value = store.snapshot();
	const control = controlWindow(value);
	assert.equal(value.windows[0]?.id, control.id);
	assert.equal(control.label, `control·${LOCAL_OWNER.slice(0, 6)}`);
	assert.equal(control.registryEndpoint?.scope, "local");
	assert.equal(control.logicalKey, `monitor-control:${LOCAL_OWNER}:${LOCAL_NONCE}`);
	assert.equal(value.windows.length, 2);
});

test("typing # offers current and peer windows and resolves a one-shot route", async () => {
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	store.applyRegistrySnapshot(snapshot());
	const targets = buildWindowAutocompleteTargets(store.snapshot(), {
		current: "current window",
		peer: "peer window",
	});
	assert.deepEqual(targets.map((target) => target.token), [
		`control·${LOCAL_OWNER.slice(0, 6)}`,
		`build·${REMOTE_OWNER.slice(0, 6)}`,
	]);
	assert.equal(ownerDisplayToken("build", REMOTE_OWNER), `build·${REMOTE_OWNER.slice(0, 6)}`);
	assert.equal(
		ownerDisplayToken(`build·${REMOTE_OWNER.slice(0, 6)}`, REMOTE_OWNER),
		`build·${REMOTE_OWNER.slice(0, 6)}`,
	);
	assert.match(targets[0]?.description ?? "", new RegExp(`owner:${LOCAL_OWNER}`));
	assert.match(targets[0]?.description ?? "", new RegExp(`incarnation:${LOCAL_NONCE}`));
	assert.match(targets[1]?.description ?? "", new RegExp(`owner:${REMOTE_OWNER}`));
	assert.match(targets[1]?.description ?? "", new RegExp(`incarnation:${REMOTE_NONCE}`));

	const delegated: AutocompleteProvider = {
		async getSuggestions() { return null; },
		applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
	};
	const selected = new Map();
	const provider = createWindowAutocompleteProvider(
		delegated,
		() => targets,
		(target) => selected.set(target.token.toLocaleLowerCase("en"), target),
	);
	const all = await provider.getSuggestions(["#"], 0, 1, { signal: new AbortController().signal });
	assert.deepEqual(all?.items.map((item) => item.value), [
		`#control·${LOCAL_OWNER.slice(0, 6)}`,
		`#build·${REMOTE_OWNER.slice(0, 6)}`,
	]);
	const build = await provider.getSuggestions(["#bu"], 0, 3, { signal: new AbortController().signal });
	assert.equal(build?.items.length, 1);
	const completion = provider.applyCompletion(["#bu"], 0, 3, build!.items[0]!, build!.prefix);
	assert.equal(completion.lines[0], `#build·${REMOTE_OWNER.slice(0, 6)} `);
	const input = `${completion.lines[0]}review this`;
	const route = resolveWindowRouteInput(input, targets, selected);
	assert.equal(route?.code, "resolved");
	assert.equal(route?.code === "resolved" ? route.target.routeSelector : undefined, ROOT_ID);
	assert.equal(route?.code === "resolved" ? route.token : undefined, `build·${REMOTE_OWNER.slice(0, 6)}`);
	assert.equal(route?.message, "review this");
	const renamed = { ...targets[1]!, token: `renamed·${REMOTE_OWNER.slice(0, 6)}`, label: "renamed" };
	const renamedRoute = resolveWindowRouteInput(input, [renamed], selected);
	assert.equal(renamedRoute?.code === "resolved" ? renamedRoute.token : undefined, `build·${REMOTE_OWNER.slice(0, 6)}`);
	assert.equal(renamedRoute?.code === "resolved" ? renamedRoute.target.token : undefined, renamed.token);
	assert.equal(resolveWindowRouteInput(input, [], selected)?.code, "stale");
	assert.equal(resolveWindowRouteInput(input, [], selected)?.code, "stale");

	const colliding = { ...targets[1]!, routeSelector: SECOND_ROOT_ID, ownerNonce: SECOND_NONCE };
	assert.equal(resolveWindowRouteInput(input, [targets[1]!, colliding])?.code, "ambiguous");
	const current = resolveWindowRouteInput(`#control·${LOCAL_OWNER.slice(0, 6)} continue here`, targets);
	assert.equal(current?.code, "resolved");
	assert.equal(current?.code === "resolved" ? current.target.current : undefined, true);
	assert.equal(current?.message, "continue here");
});

test("Window Bar renders explicit control and peer windows and fits every width", () => {
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	store.applyRegistrySnapshot(snapshot("windows"));
	const value = store.snapshot();
	const state = new SessionUiState();
	state.reconcile("window", value.windows, value.windows[0]?.id);
	for (let width = 1; width <= 120; width++) {
		const lines = renderWindowBar(value.windows, state, width, theme as Theme);
		assert.equal(lines.length, 1);
		const liveWidth = Math.max(1, width - 1);
		assert.ok(visibleWidth(lines[0]!) <= liveWidth, `width ${width}: ${visibleWidth(lines[0]!)} > ${liveWidth}`);
	}
	const line = renderWindowBar(value.windows, state, 80, theme as Theme)[0]!;
	assert.match(line, new RegExp(`#control·${LOCAL_OWNER.slice(0, 6)}`));
	assert.match(line, new RegExp(`#build·${REMOTE_OWNER.slice(0, 6)}`));
	assert.doesNotMatch(line, /■|mon 1/);
	assert.equal(windowSessionColor(controlWindow(value)), "accent");
	assert.equal(windowSessionColor(remoteWindow(value)), assignedAgentColor(REMOTE_OWNER));
});

test("Window Bar keeps a selected sleeping peer in the accent color", () => {
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	store.applyRegistrySnapshot(snapshot("windows"));
	const value = store.snapshot();
	const sleeping = value.windows.map((window) => window.id === ROOT_ID
		? { ...window, status: "sleeping" as const }
		: window);
	const state = new SessionUiState();
	state.reconcile("window", sleeping, ROOT_ID);
	const taggedTheme: Pick<Theme, "fg" | "bold"> = {
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (text) => text,
	};
	const rendered = renderWindowBar(sleeping, state, 120, taggedTheme as Theme)[0]!;
	assert.match(rendered, new RegExp(`<accent>▸ #build·${REMOTE_OWNER.slice(0, 6)}<\\/accent>`));
	assert.doesNotMatch(rendered, /■ #build/);
});

test("Window Bar shows the Alt+R list hint only outside a capturing overlay", () => {
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	store.applyRegistrySnapshot(snapshot("windows"));
	const value = store.snapshot();
	const state = new SessionUiState();
	state.reconcile("window", value.windows, value.windows[0]?.id);
	const visible = renderWindowBar(
		value.windows,
		state,
		100,
		theme as Theme,
		{ shortcutHint: `${altKey("R")} list` },
	)[0]!;
	const hidden = renderWindowBar(value.windows, state, 100, theme as Theme)[0]!;
	assert.match(visible, new RegExp(`${altRe("R")} list$`));
	assert.equal(visibleWidth(visible), 99, "the live bar reserves the terminal's final column");
	assert.doesNotMatch(hidden, new RegExp(`${altRe("R")}`));
});

test("Window Bar renders the /artifact replacement hint without changing the empty state", () => {
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	store.applyRegistrySnapshot(snapshot("windows"));
	const value = store.snapshot();
	const state = new SessionUiState();
	state.reconcile("window", value.windows, value.windows[0]?.id);
	const taggedTheme: Pick<Theme, "fg" | "bold"> = {
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (text) => text,
	};
	const hint = { text: "/artifact", color: "accent" as const };
	assert.match(renderWindowBar(value.windows, state, 100, taggedTheme as Theme, { shortcutHint: hint })[0]!, /<accent>\/artifact<\/accent>$/);
	assert.doesNotMatch(renderWindowBar([], state, 100, taggedTheme as Theme, { shortcutHint: hint })[0]!, /artifact/);
});

test("Window Bar empty state is width bounded", () => {
	const state = new SessionUiState();
	for (let width = 1; width <= 30; width++) {
		const line = renderWindowBar([], state, width, theme as Theme)[0]!;
		const liveWidth = Math.max(1, width - 1);
		assert.ok(visibleWidth(line) <= liveWidth, `width ${width}: ${visibleWidth(line)} > ${liveWidth}`);
	}
});

test("Window thread view filters by exact owner nonce and renders communication only", () => {
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	store.applyRegistrySnapshot(snapshot("windows"));
	const value = store.snapshot();
	const lines = renderWindowThreadView(remoteWindow(value), [
		...value.thread,
		{ ...value.thread[0]!, messageId: "0".repeat(32), peerOwnerNonce: "0".repeat(32), body: "wrong incarnation" },
	], 80, 10, { offset: 0, following: true }, theme as Theme);
	assert.match(lines.join("\n"), /check the build/);
	assert.doesNotMatch(lines.join("\n"), /wrong incarnation/);
	assert.match(lines.join("\n"), /worker/);
	assert.match(lines.join("\n"), /follow-up/);
});

test("Window thread live tail updates remote agent summaries with stable identity color", () => {
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	store.applyRegistrySnapshot(snapshot("windows"));
	const next = snapshot("windows");
	store.applyRegistrySnapshot({
		...next,
		contentRevision: "all-streaming",
		endpointContentRevision: "endpoints-streaming",
		endpoints: next.endpoints.map((endpoint) => endpoint.correlationId === "worker"
			? { ...endpoint, contentRevision: "worker-streaming", summary: "streaming token" }
			: endpoint),
	});
	const value = store.snapshot();
	const colorTheme: Pick<Theme, "fg" | "bold"> = {
		fg: (color, text) => `[${color}]${text}[/${color}]`,
		bold: (text) => text,
	};
	const lines = renderWindowThreadView(
		remoteWindow(value),
		value.thread,
		120,
		10,
		{ offset: 0, following: true },
		colorTheme as Theme,
	);
	assert.match(lines.join("\n"), /streaming token/);
	assert.match(lines.join("\n"), new RegExp(`\\[${assignedAgentColor("worker")}\\]@worker`));
});

test("duplicate window names gain a non-color owner suffix", () => {
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	store.applyRegistrySnapshot(withSecondWindow(snapshot("windows"), "build"));
	const value = store.snapshot();
	assert.deepEqual(value.windows.map((window) => window.label), [
		`control·${LOCAL_OWNER.slice(0, 6)}`,
		`build·${REMOTE_OWNER.slice(0, 6)}`,
		`build·${SECOND_OWNER.slice(0, 6)}`,
	]);
	const state = new SessionUiState();
	state.reconcile("window", value.windows, ROOT_ID);
	const line = renderWindowBar(value.windows, state, 80, theme as Theme)[0]!;
	assert.doesNotMatch(line, /■|mon 2/);
});

test("background remote-agent activity increments the window unread count", () => {
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	store.applyRegistrySnapshot(withSecondWindow(snapshot("windows")));
	const state = new SessionUiState();
	let value = store.snapshot();
	state.reconcile("window", value.windows, SECOND_ROOT_ID);
	state.clearUnread(ROOT_ID);

	const next = withSecondWindow(snapshot("windows"));
	store.applyRegistrySnapshot({
		...next,
		contentRevision: "all-background-progress",
		endpointContentRevision: "endpoints-background-progress",
		endpoints: next.endpoints.map((endpoint) => endpoint.correlationId === "worker"
			? { ...endpoint, contentRevision: "worker-progress", summary: "new background progress" }
			: endpoint),
	});
	value = store.snapshot();
	state.reconcile("window", value.windows, SECOND_ROOT_ID);
	assert.equal(state.endpoint(ROOT_ID).unread, 1);
});

test("owner nonce changes start with a fresh window draft", () => {
	const state = new SessionUiState();
	state.reconcile("window", [{ id: ROOT_ID, logicalKey: `window:${REMOTE_OWNER}:${REMOTE_NONCE}` }], ROOT_ID);
	state.setDraft(ROOT_ID, "do not send after restart");
	const restartedId = `pi-session/v1/${WORKSPACE}/${REMOTE_OWNER}/${SECOND_NONCE}/root`;
	state.reconcile("window", [{
		id: restartedId,
		logicalKey: `window:${REMOTE_OWNER}:${SECOND_NONCE}`,
	}], restartedId);
	assert.equal(state.endpoint(restartedId).draft, "");
	assert.equal(state.endpoint(ROOT_ID).draft, "do not send after restart");
});

test("Agent and Window selections retain independent drafts and restore on mode switch", () => {
	const state = new SessionUiState();
	state.reconcile("agent", [{ id: "main", logicalKey: "main" }], "main");
	state.reconcile("window", [{ id: ROOT_ID, logicalKey: `window:${REMOTE_OWNER}:${REMOTE_NONCE}` }], ROOT_ID);
	state.setDraft("main", "agent draft");
	state.setDraft(ROOT_ID, "window draft");
	state.setMode("window");
	assert.equal(state.endpoint(ROOT_ID).draft, "window draft");
	state.setMode("agent");
	assert.equal(state.selectedId("agent"), "main");
	assert.equal(state.endpoint("main").draft, "agent draft");
});
