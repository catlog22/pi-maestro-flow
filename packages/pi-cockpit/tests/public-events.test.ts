import assert from "node:assert/strict";
import test from "node:test";
import {
	COCKPIT_MAESTRO_QUERY_EVENT,
	MAESTRO_UI_SNAPSHOT_EVENT,
	MAESTRO_UI_SNAPSHOT_VERSION,
	type CockpitUiOwnershipV1,
	type MaestroQueryV1,
	type MaestroUiClearSnapshotV1,
} from "pi-cockpit/v1/events";

const query: MaestroQueryV1 = { version: MAESTRO_UI_SNAPSHOT_VERSION };
const ownership: CockpitUiOwnershipV1 = {
	todo: true,
	agents: true,
	footer: true,
	sidebar: true,
	goal: true,
	todoExpanded: false,
	quiet: false,
	quietSymbols: "check",
};
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
	assert.deepEqual(query, { version: 1 });
	assert.equal(ownership.sidebar, true);
	assert.equal(ownership.goal, true);
	assert.deepEqual(clear, {
		version: 1,
		sessionGeneration: "generation-a",
		revision: 1,
		publishedAt: 100,
		cleared: true,
	});
});
