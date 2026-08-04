import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { makeSessionBarWidget, renderSessionBar, SESSION_BAR_WIDGET_KEY } from "../src/session-bar.ts";
import type { AgentRow } from "../src/types.ts";

const theme: Pick<Theme, "fg" | "bold"> = {
	fg: (_c, t) => `[${_c}]${t}[/${_c}]`,
	bold: (t) => `*${t}*`,
};

function agent(overrides: Partial<AgentRow> = {}): AgentRow {
	return {
		correlationId: "c1",
		agent: "explorer",
		name: "scan",
		role: "explorer",
		task: "scan auth",
		status: "running",
		tail: "",
		startedAt: 1000,
		lastActivityAt: 1000,
		...overrides,
	};
}

test("SESSION_BAR_WIDGET_KEY is namespaced", () => {
	assert.equal(SESSION_BAR_WIDGET_KEY, "cockpit-session-bar");
});

test("renderSessionBar: empty when there are no agents", () => {
	assert.deepEqual(renderSessionBar([], 80, theme as Theme), []);
});

test("renderSessionBar: renders one chip per agent with the viewed one highlighted", () => {
	const lines = renderSessionBar(
		[
			agent({ correlationId: "a", name: "explorer" }),
			agent({ correlationId: "b", name: "builder", viewing: true }),
			agent({ correlationId: "c", name: "scout" }),
		],
		120,
		theme as Theme,
	);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /@explorer/);
	assert.match(lines[0], /@builder/);
	assert.match(lines[0], /@scout/);
	// The viewed chip carries the ▸ marker and the accent/bold styling.
	assert.match(lines[0], /\[accent\]▸\[\/accent\]/);
	assert.match(lines[0], /\[accent\]\*@builder\*\[\/accent\]/);
	// Non-viewed chips are muted, without a marker.
	assert.match(lines[0], /\[muted\]@explorer\[\/muted\]/);
	// Only the viewed chip carries the marker.
	assert.equal(lines[0].split("▸").length - 1, 1);
});

test("renderSessionBar: no viewing chip renders all muted", () => {
	const lines = renderSessionBar([agent({ name: "explorer" }), agent({ correlationId: "z", name: "scout" })], 120, theme as Theme);
	assert.doesNotMatch(lines[0], /▸/);
});

test("renderSessionBar: falls back to role/agent when name is absent", () => {
	const lines = renderSessionBar([agent({ name: undefined, role: "executor" })], 120, theme as Theme);
	assert.match(lines[0], /@executor/);
});

test("renderSessionBar: graph() containers are bridged out", () => {
	const lines = renderSessionBar(
		[
			agent({ correlationId: "graph-1", agent: "graph(dispatch)", name: "graph" }),
			agent({ correlationId: "real", name: "worker" }),
		],
		120,
		theme as Theme,
	);
	assert.doesNotMatch(lines[0], /@graph/);
	assert.match(lines[0], /@worker/);
});

test("renderSessionBar: every line fits the width (crash regression)", () => {
	const rows = Array.from({ length: 12 }, (_, i) =>
		agent({ correlationId: `c${i}`, name: `very-long-agent-name-${i}`, viewing: i === 3 }),
	);
	for (const width of [40, 80, 120, 200]) {
		for (const line of renderSessionBar(rows, width, theme as Theme)) {
			assert.ok(visibleWidth(line) <= width, `@ ${width}: ${visibleWidth(line)} > ${width}`);
		}
	}
});

test("makeSessionBarWidget: reads live agents on every render", () => {
	let rows: AgentRow[] = [];
	const widget = makeSessionBarWidget({ getAgents: () => rows })({} as never, theme as Theme);
	assert.deepEqual(widget.render(80), []);
	rows = [agent({ name: "explorer" })];
	assert.deepEqual(widget.render(80), renderSessionBar(rows, 80, theme as Theme));
});
