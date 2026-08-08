import assert from "node:assert/strict";
import test from "node:test";
import { SessionUiState, type SessionUiEndpointDescriptor } from "../src/session-ui-state.ts";

const main: SessionUiEndpointDescriptor = { id: "main", logicalKey: "main" };
const agent: SessionUiEndpointDescriptor = { id: "agent-legacy", logicalKey: "agent:c1" };

test("SessionUiState keeps per-endpoint drafts, scroll/follow-tail and detail state", () => {
	const state = new SessionUiState();
	state.reconcile("agent", [main, agent], main.id);
	state.setDraft(main.id, "main draft");
	state.setDraft(agent.id, "agent draft");
	state.setScroll(agent.id, 7, false);
	state.setDetail(agent.id, false);
	state.select(agent.id);
	state.select(main.id);

	assert.equal(state.endpoint(main.id).draft, "main draft");
	assert.deepEqual(state.endpoint(agent.id), {
		draft: "agent draft",
		unread: 0,
		lastSeenRevision: undefined,
		scroll: 7,
		followTail: false,
		detail: false,
	});
});

test("new output increments unread once per revision and selection marks it seen", () => {
	const state = new SessionUiState();
	state.reconcile("agent", [main, agent], main.id);
	state.reconcile("agent", [main, { ...agent, outputRevision: "r1" }], main.id);
	state.reconcile("agent", [main, { ...agent, outputRevision: "r1" }], main.id);
	assert.equal(state.endpoint(agent.id).unread, 1);
	assert.equal(state.endpoint(agent.id).lastSeenRevision, undefined);

	state.reconcile("agent", [main, { ...agent, outputRevision: "r2" }], main.id);
	assert.equal(state.endpoint(agent.id).unread, 2);
	state.select(agent.id);
	assert.equal(state.endpoint(agent.id).unread, 0);
	assert.equal(state.endpoint(agent.id).lastSeenRevision, "r2");
	state.reconcile("agent", [main, { ...agent, outputRevision: "r3" }], main.id);
	assert.equal(state.endpoint(agent.id).unread, 0);
	assert.equal(state.endpoint(agent.id).lastSeenRevision, "r3");
});

test("hidden bars accumulate unread even when their previous tab remains selected", () => {
	const state = new SessionUiState();
	const window = { id: "window-main", logicalKey: "window:main" };
	state.reconcile("agent", [main], main.id);
	state.reconcile("window", [window], window.id);
	state.setMode("agent");
	state.reconcile("window", [{ ...window, outputRevision: "w1" }], window.id);
	assert.equal(state.endpoint(window.id).unread, 1);
	state.setMode("window");
	state.select(window.id, "window");
	assert.equal(state.endpoint(window.id).unread, 0);
});

test("canonical id migration preserves state and selected identity", () => {
	const state = new SessionUiState();
	state.reconcile("agent", [main, agent], main.id);
	state.select(agent.id);
	state.setDraft(agent.id, "keep me");
	state.setScroll(agent.id, 4, false);
	const canonical = { id: "pi-session/v1/workspace/owner/nonce/agent/c1", logicalKey: agent.logicalKey };
	const result = state.reconcile("agent", [main, canonical], main.id);

	assert.equal(result.selectedId, canonical.id);
	assert.equal(state.endpoint(canonical.id).draft, "keep me");
	assert.equal(state.endpoint(canonical.id).scroll, 4);
	assert.equal(state.endpoint(canonical.id).followTail, false);
});

test("agent disappearance falls back to main without clearing the agent state", () => {
	const state = new SessionUiState();
	state.reconcile("agent", [main, agent], main.id);
	state.select(agent.id);
	state.setDraft(agent.id, "unfinished");
	state.setScroll(agent.id, 5, false);
	state.setDetail(agent.id, false);
	const result = state.reconcile("agent", [main], main.id);

	assert.equal(result.fellBack, true);
	assert.equal(result.selectedId, main.id);
	assert.equal(state.endpoint(agent.id).draft, "unfinished");
	assert.equal(state.endpoint(agent.id).scroll, 5);
	assert.equal(state.endpoint(agent.id).detail, false);
});

test("mode selection is independent so future Window Bar does not disturb Agent Bar", () => {
	const state = new SessionUiState();
	state.reconcile("agent", [main, agent], main.id);
	state.select(agent.id, "agent");
	state.setMode("window");
	state.reconcile("window", [{ id: "window-main", logicalKey: "window:main" }], "window-main");
	assert.equal(state.selectedId("window"), "window-main");
	assert.equal(state.selectedId("agent"), agent.id);
});
