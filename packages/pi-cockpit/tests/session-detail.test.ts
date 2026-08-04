import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	SESSION_DETAIL_TAIL_LINES,
	SESSION_DETAIL_WIDGET_KEY,
	makeSessionDetailWidget,
	renderSessionDetail,
	sessionDetailBodyLength,
} from "../src/session-detail.ts";
import type { AgentRow } from "../src/types.ts";

const theme: Pick<Theme, "fg" | "bold"> = {
	fg: (c, t) => `\x1b[${c === "accent" ? 36 : c === "warning" ? 33 : c === "error" ? 31 : c === "success" ? 32 : 90}m${t}\x1b[0m`,
	bold: (t) => `\x1b[1m${t}\x1b[22m`,
};

function agent(overrides: Partial<AgentRow> = {}): AgentRow {
	return {
		correlationId: "c1",
		agent: "general",
		name: "ping-test",
		role: "general",
		task: "",
		status: "sleeping",
		tail: "hello from the agent",
		startedAt: Date.now() - 6000,
		lastActivityAt: Date.now(),
		...overrides,
	};
}

test("SESSION_DETAIL_WIDGET_KEY is namespaced", () => {
	assert.equal(SESSION_DETAIL_WIDGET_KEY, "cockpit-session-detail");
});

test("renderSessionDetail: empty when no agent is selected", () => {
	assert.deepEqual(renderSessionDetail([agent()], undefined, 80, theme as Theme), []);
	assert.deepEqual(renderSessionDetail([], "c1", 80, theme as Theme), []);
});

test("renderSessionDetail: renders the selected agent's status header and tail", () => {
	const lines = renderSessionDetail([agent()], "c1", 160, theme as Theme);
	assert.ok(lines.length >= 2);
	assert.match(lines[0], /@ping-test/);
	assert.match(lines[0], /\(general\)/);
	assert.match(lines[0], /sleeping/);
	assert.match(lines[0], /6s/);
	// The streaming tail is the agent's live content.
	assert.ok(lines.some((line) => line.includes("hello from the agent")));
});

test("renderSessionDetail: header explains scroll and visibility controls", () => {
	const [header] = renderSessionDetail([agent()], "c1", 80, theme as Theme);
	assert.match(header, /Alt\+Shift\+↑↓ scroll/);
	assert.match(header, /Alt\+Shift\+R hide/);
});

test("renderSessionDetail: running agent without tail shows a working hint", () => {
	const lines = renderSessionDetail(
		[agent({ status: "running", tail: "" })],
		"c1",
		80,
		theme as Theme,
	);
	assert.ok(lines.some((line) => line.includes("working")));
});

test("renderSessionDetail: explicit session view keeps content and actionable state", () => {
	const rows = [agent({
		status: "running",
		tail: "streaming model prose that belongs in the selected session",
		activeTool: "read",
		error: "provider warning",
	})];
	const lines = renderSessionDetail(
		rows,
		"c1",
		120,
		theme as Theme,
		8,
		{ offset: 0, following: true },
	);
	const text = lines.join("\n");
	assert.match(text, /streaming model prose/);
	assert.match(text, /read/);
	assert.match(text, /provider warning/);
	assert.match(lines[0], /Alt\+Shift\+↑↓ scroll/);
	assert.match(lines[0], /Alt\+Shift\+R hide/);
	assert.equal(sessionDetailBodyLength(rows, "c1", 120), 3);
});

test("renderSessionDetail: active tool and error lines render", () => {
	const lines = renderSessionDetail(
		[agent({ status: "running", activeTool: "read", error: "boom" })],
		"c1",
		80,
		theme as Theme,
	);
	assert.ok(lines.some((line) => line.includes("read")));
	assert.ok(lines.some((line) => line.includes("boom")));
});

test("renderSessionDetail: tail is capped to the row budget and follows the newest lines", () => {
	const longTail = Array.from({ length: SESSION_DETAIL_TAIL_LINES + 6 }, (_, i) => `line ${i}`).join("\n");
	const lines = renderSessionDetail([agent({ tail: longTail })], "c1", 80, theme as Theme);
	assert.equal(lines.length, SESSION_DETAIL_TAIL_LINES + 1); // header + body budget
	assert.ok(lines.some((line) => line.includes("↑")), "following view reports hidden older lines");
	assert.ok(lines.some((line) => line.includes(`line ${SESSION_DETAIL_TAIL_LINES + 5}`)), "newest output remains visible");
});

test("renderSessionDetail: manual scrolling shows older content and a lower marker", () => {
	const tail = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
	const rows = [agent({ tail })];
	const top = renderSessionDetail(rows, "c1", 80, theme as Theme, 5, { offset: 0, following: false });
	assert.ok(top.some((line) => line.includes("line 1")));
	assert.ok(top.some((line) => line.includes("↓")), "top view reports newer hidden lines");
	const bottom = renderSessionDetail(rows, "c1", 80, theme as Theme, 5, { offset: 0, following: true });
	assert.ok(bottom.some((line) => line.includes("↑")), "tail-following view reports older hidden lines");
	assert.ok(bottom.some((line) => line.includes("line 11")));
	assert.equal(sessionDetailBodyLength(rows, "c1", 80), 12);
});

test("renderSessionDetail: minimum panel keeps real content alongside overflow navigation", () => {
	const tail = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
	const lines = renderSessionDetail(
		[agent({ tail })],
		"c1",
		80,
		theme as Theme,
		3,
		{ offset: 4, following: false },
	);
	assert.equal(lines.length, 3);
	assert.ok(lines.some((line) => line.includes("more")));
	assert.ok(lines.some((line) => line.includes("line ")), "navigation must not replace every content row");
});

test("renderSessionDetail: every line fits the width (crash regression)", () => {
	for (const width of [40, 80, 120]) {
		for (const line of renderSessionDetail(
			[agent({ tail: "x".repeat(400), activeTool: "VeryLongToolName".repeat(3), error: "y".repeat(300) })],
			"c1",
			width,
			theme as Theme,
		)) {
			assert.ok(visibleWidth(line) <= width, `@ ${width}: ${visibleWidth(line)} > ${width}`);
		}
	}
});

test("makeSessionDetailWidget: reads live state on every render", () => {
	let rows: AgentRow[] = [];
	let viewingId: string | undefined;
	let visible = true;
	const widget = makeSessionDetailWidget({
		getAgents: () => rows,
		getViewingId: () => viewingId,
		getVisible: () => visible,
	})({} as never, theme as Theme);
	assert.deepEqual(widget.render(80), []);
	rows = [agent()];
	viewingId = "c1";
	assert.deepEqual(widget.render(80), renderSessionDetail(rows, viewingId, 80, theme as Theme, 6));
	visible = false;
	assert.deepEqual(widget.render(80), []);
});

test("makeSessionDetailWidget: terminal height bounds the fixed region", () => {
	const rows = [agent({ tail: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") })];
	const make = (terminalRows: number) => makeSessionDetailWidget({
		getAgents: () => rows,
		getViewingId: () => "c1",
		getVisible: () => true,
	})({ terminal: { rows: terminalRows } } as never, theme as Theme).render(80);
	assert.equal(make(24).length, 3);
	assert.equal(make(60).length, 9);
});
