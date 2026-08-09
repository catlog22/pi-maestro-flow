import assert from "node:assert/strict";
import test from "node:test";
import {
	COCKPIT_INPUT_TARGET_EVENT,
	COCKPIT_MAESTRO_QUERY_EVENT,
	COCKPIT_SESSION_LIST_EVENT,
	MAESTRO_UI_SNAPSHOT_EVENT,
	MAESTRO_UI_SNAPSHOT_VERSION,
	type CockpitInputTargetV1,
	type CockpitUiOwnershipV1,
	type MaestroQueryV1,
	type MaestroUiClearSnapshotV1,
} from "pi-cockpit/v1/events";

const query: MaestroQueryV1 = { version: MAESTRO_UI_SNAPSHOT_VERSION };
const ownership: CockpitUiOwnershipV1 = {
	todo: true,
	agents: true,
	sessionList: true,
	footer: true,
	sidebar: true,
	goal: true,
	todoExpanded: false,
	quiet: false,
	quietSymbols: "check",
	static: false,
};
const inputTarget: CockpitInputTargetV1 = { version: 1, label: "builder", color: "warning" };
const windowInputTarget: CockpitInputTargetV1 = { version: 1, label: "build", color: "accent", sigil: "#" };
const clear: MaestroUiClearSnapshotV1 = {
	version: MAESTRO_UI_SNAPSHOT_VERSION,
	sessionGeneration: "generation-a",
	revision: 1,
	publishedAt: 100,
	cleared: true,
};

test("public v1 event subpath resolves constants and tombstone types", () => {
	assert.equal(COCKPIT_MAESTRO_QUERY_EVENT, "cockpit:maestro-query");
	assert.equal(MAESTRO_UI_SNAPSHOT_EVENT, "maestro:ui-snapshot");
	assert.equal(COCKPIT_INPUT_TARGET_EVENT, "cockpit:input-target");
	assert.equal(COCKPIT_SESSION_LIST_EVENT, "cockpit:open-session-list");
	assert.deepEqual(inputTarget, { version: 1, label: "builder", color: "warning" });
	assert.deepEqual(windowInputTarget, { version: 1, label: "build", color: "accent", sigil: "#" });
	assert.deepEqual(query, { version: 1 });
	assert.equal(ownership.sidebar, true);
	assert.equal(ownership.sessionList, true);
	assert.equal(ownership.goal, true);
	assert.deepEqual(clear, {
		version: 1,
		sessionGeneration: "generation-a",
		revision: 1,
		publishedAt: 100,
		cleared: true,
	});
});
