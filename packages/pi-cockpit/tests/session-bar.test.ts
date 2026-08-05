import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { assignedAgentColor, makeSessionBarWidget, renderSessionBar, SESSION_BAR_WIDGET_KEY } from "../src/session-bar.ts";
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
		lastActivityAt: Date.now(),
		...overrides,
	};
}

test("SESSION_BAR_WIDGET_KEY is namespaced", () => {
	assert.equal(SESSION_BAR_WIDGET_KEY, "cockpit-session-bar");
});

test("renderSessionBar: main chip renders even without agents, highlighted when idle", () => {
	const lines = renderSessionBar([], 80, theme as Theme);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /\[accent\]▸\[\/accent\]/);
	assert.match(lines[0], /\[accent\]\*@main\*\[\/accent\]/);
});

test("renderSessionBar: main chip is colored warning while the main agent works", () => {
	const lines = renderSessionBar([], 80, theme as Theme, { mainRunning: true });
	assert.match(lines[0], /\[accent\]\*@main\*\[\/accent\]/);
	const idle = renderSessionBar([], 80, theme as Theme);
	assert.match(idle[0], /\[accent\]\*@main\*\[\/accent\]/);
});

test("renderSessionBar: active agents use stable per-agent colors and terminal states are semantic", () => {
	const lines = renderSessionBar(
		[
			agent({ correlationId: "a", name: "busy", status: "running" }),
			agent({ correlationId: "b", name: "settled", status: "done" }),
			agent({ correlationId: "c", name: "broken", status: "failed" }),
			agent({ correlationId: "d", name: "sleepy", status: "sleeping" }),
		],
		160,
		theme as Theme,
	);
	const busyColor = assignedAgentColor("a");
	assert.ok(lines[0].includes(`[${busyColor}]@busy[/${busyColor}]`));
	assert.match(lines[0], /\[muted\]@settled\[\/muted\]/);
	assert.match(lines[0], /\[error\]@broken\[\/error\]/);
	assert.match(lines[0], /\[muted\]@sleepy\[\/muted\]/);
	assert.equal(assignedAgentColor("a"), assignedAgentColor("a"), "color is stable across frames");
});

test("renderSessionBar: chip order follows start time, not live activity (stable during a run)", () => {
	// Activity (newest-first) says beta, gamma, alpha; start order says alpha,
	// gamma, beta. The bar must render start order so progress ticks never
	// reflow the chips mid-run.
	const rows = [
		agent({ correlationId: "oldest", name: "alpha", startedAt: 100, lastActivityAt: 500 }),
		agent({ correlationId: "newest", name: "beta", startedAt: 300, lastActivityAt: 1000 }),
		agent({ correlationId: "middle", name: "gamma", startedAt: 200, lastActivityAt: 900 }),
	];
	const orderOf = (line: string) => (name: string) => line.indexOf(`@${name}`);
	const idx = orderOf(renderSessionBar(rows, 160, theme as Theme)[0]);
	assert.ok(idx("alpha") < idx("gamma"), "start order: alpha before gamma");
	assert.ok(idx("gamma") < idx("beta"), "start order: gamma before beta");
	// A progress tick only bumps lastActivityAt; the rendered order must not move.
	const churned = [
		agent({ correlationId: "oldest", name: "alpha", startedAt: 100, lastActivityAt: 5000 }),
		agent({ correlationId: "newest", name: "beta", startedAt: 300, lastActivityAt: 5000 }),
		agent({ correlationId: "middle", name: "gamma", startedAt: 200, lastActivityAt: 5000 }),
	];
	const idx2 = orderOf(renderSessionBar(churned, 160, theme as Theme)[0]);
	assert.ok(idx2("alpha") < idx2("gamma"), "order unchanged after activity churn");
	assert.ok(idx2("gamma") < idx2("beta"), "order unchanged after activity churn");
});

test("renderSessionBar: a newly started agent appends after earlier sessions", () => {
	const withNew = renderSessionBar(
		[
			agent({ correlationId: "a", name: "alpha", startedAt: 100 }),
			agent({ correlationId: "b", name: "beta", startedAt: 200 }),
		],
		120,
		theme as Theme,
	)[0];
	assert.ok(withNew.indexOf("@alpha") < withNew.indexOf("@beta"), "new agent appends at the end");
	// Equal start times (e.g. self-healed rows) fall back to a stable id tiebreak.
	const tied = renderSessionBar(
		[agent({ correlationId: "z", name: "zeta", startedAt: 100 }), agent({ correlationId: "a", name: "alpha", startedAt: 100 })],
		120,
		theme as Theme,
	)[0];
	assert.ok(tied.indexOf("@alpha") < tied.indexOf("@zeta"), "id tiebreak is deterministic");
});

test("renderSessionBar: the shown session chip is highlighted with ▸ and its assigned color", () => {
	const lines = renderSessionBar(
		[
			agent({ correlationId: "a", name: "explorer" }),
			agent({ correlationId: "b", name: "builder", viewing: true }),
			agent({ correlationId: "c", name: "scout" }),
		],
		240,
		theme as Theme,
	);
	assert.equal(lines[0].split("▸").length - 1, 1);
	const color = assignedAgentColor("b");
	assert.ok(lines[0].includes(`[${color}]*@builder*[/${color}]`));
	// Main is not highlighted while an agent session is shown.
	assert.match(lines[0], /\[muted\]@main\[\/muted\]/);
});

test("renderSessionBar: falls back to role/agent when name is absent", () => {
	const lines = renderSessionBar([agent({ name: undefined, role: "executor" })], 120, theme as Theme);
	assert.match(lines[0], /@executor/);
});

test("renderSessionBar: graph() containers are bridged out, main stays", () => {
	const lines = renderSessionBar(
		[
			agent({ correlationId: "graph-1", agent: "graph(dispatch)", name: "graph" }),
			agent({ correlationId: "real", name: "worker" }),
		],
		120,
		theme as Theme,
	);
	assert.doesNotMatch(lines[0], /@graph/);
	assert.match(lines[0], /@main/);
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

test("renderSessionBar: right-edge current-session status shares the line", () => {
	// Real ANSI theme: codes have zero visible width, so the truncation math is
	// exercised like production.
	const ansi: Pick<Theme, "fg" | "bold"> = {
		fg: (c, t) => `\x1b[${c === "accent" ? 36 : c === "warning" ? 33 : c === "error" ? 31 : c === "success" ? 32 : 90}m${t}\x1b[0m`,
		bold: (t) => `\x1b[1m${t}\x1b[22m`,
	};
	const lines = renderSessionBar(
		[agent({ correlationId: "a", name: "explorer", viewing: true }), agent({ correlationId: "b", name: "builder" })],
		120,
		ansi as Theme,
		{ current: { label: "explorer", color: "warning" } },
	);
	assert.equal(lines.length, 1);
	// Chips on the left, current-session status right-aligned.
	assert.match(lines[0], /@main/);
	assert.match(lines[0], /@builder/);
	assert.match(lines[0], /● @explorer/);
	// The right-edge status sits at the very end (right-aligned).
	assert.match(lines[0], /● @explorer\x1b\[0m$/);
});

test("renderSessionBar: right-edge status keeps its slot on narrow widths", () => {
	const ansi: Pick<Theme, "fg" | "bold"> = {
		fg: (c, t) => `\x1b[${c === "accent" ? 36 : c === "warning" ? 33 : c === "error" ? 31 : c === "success" ? 32 : 90}m${t}\x1b[0m`,
		bold: (t) => `\x1b[1m${t}\x1b[22m`,
	};
	for (const width of [30, 40, 60]) {
		const [line] = renderSessionBar(
			Array.from({ length: 8 }, (_, i) => agent({ correlationId: `c${i}`, name: `agent-${i}` })),
			width,
			ansi as Theme,
			{ current: { label: "main", color: "muted" } },
		);
		assert.ok(visibleWidth(line) <= width, `@ ${width}: ${visibleWidth(line)} > ${width}`);
		assert.match(line, /● @main/);
	}
});

test("renderSessionBar: long current-session label never exceeds terminal width", () => {
	const ansi: Pick<Theme, "fg" | "bold"> = {
		fg: (_c, t) => `\x1b[33m${t}\x1b[0m`,
		bold: (t) => `\x1b[1m${t}\x1b[22m`,
	};
	for (const width of [8, 20, 40]) {
		const [line] = renderSessionBar(
			[agent({ name: "agent-with-an-extremely-long-session-name", viewing: true })],
			width,
			ansi as Theme,
			{ current: { label: "agent-with-an-extremely-long-session-name", color: "warning" } },
		);
		assert.ok(visibleWidth(line) <= width, `@ ${width}: ${visibleWidth(line)} > ${width}`);
	}
});

test("makeSessionBarWidget: status colors change only when the cached effective state changes", () => {
	let now = 10_000;
	const rows = [agent({ correlationId: "stable", name: "stable", lastActivityAt: 1_000 })];
	const widget = makeSessionBarWidget({
		getAgents: () => rows,
		getNow: () => now,
	})({} as never, theme as Theme);
	const assigned = assignedAgentColor("stable");
	assert.ok(widget.render(100)[0].includes(`[${assigned}]@stable[/${assigned}]`));

	now = 31_001;
	assert.match(widget.render(100)[0], /\[error\]@stable\[\/error\]/);
	assert.match(widget.render(100)[0], /\[error\]@stable\[\/error\]/, "same stable state keeps the same color");

	rows[0].lastActivityAt = now;
	assert.ok(widget.render(100)[0].includes(`[${assigned}]@stable[/${assigned}]`), "new activity crosses back to running");
});

test("makeSessionBarWidget: reads live agents on every render", () => {
	let rows: AgentRow[] = [];
	let mainRunning = false;
	const widget = makeSessionBarWidget({ getAgents: () => rows, getNow: () => 10_000, isMainRunning: () => mainRunning })({} as never, theme as Theme);
	assert.deepEqual(widget.render(80), renderSessionBar([], 80, theme as Theme));
	rows = [agent({ name: "explorer" })];
	mainRunning = true;
	assert.deepEqual(widget.render(80), renderSessionBar(rows, 80, theme as Theme, { mainRunning: true }));
});
