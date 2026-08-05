import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgentOverlay } from "../src/agent-overlay.ts";
import { resolveGlyphs } from "../src/icons.ts";
import type { AgentRow } from "../src/types.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

function row(id: string, overrides: Partial<AgentRow> = {}): AgentRow {
	return {
		correlationId: id,
		agent: "general",
		name: id,
		role: "general",
		task: `task ${id}`,
		status: "running",
		tail: `stream ${id}`,
		startedAt: Date.now() - 5_000,
		lastActivityAt: Date.now(),
		...overrides,
	};
}

function makeOverlay(
	rows: AgentRow[],
	viewingId: string | undefined = rows[0]?.correlationId,
	terminalRows = 30,
) {
	let renders = 0;
	let closes = 0;
	const selections: string[] = [];
	const commands: Array<{ id: string; action: "interrupt" | "steer"; message?: string }> = [];
	const component = new AgentOverlay({
		getAgents: () => rows,
		getViewingId: () => viewingId,
		onSelect: (id) => {
			viewingId = id;
			selections.push(id);
		},
		onCommand: (id, action, message) => {
			commands.push({ id, action, ...(message !== undefined ? { message } : {}) });
		},
		requestRender: () => { renders++; },
		close: () => { closes++; },
		theme,
		glyphs: resolveGlyphs("nerd"),
		getTerminalRows: () => terminalRows,
	});
	return { component, state: () => ({ renders, closes, selections, viewingId, commands }) };
}

test("Agent modal preserves hierarchy and renders the selected live stream", () => {
	const rows = [
		row("parent", { task: "coordinate work" }),
		row("child", { parentCorrelationId: "parent", task: "implement change", tail: "first chunk" }),
	];
	const { component } = makeOverlay(rows, "child");
	const text = component.render(120).join("\n");
	assert.match(text, /Agents · 2 total/);
	assert.match(text, /coordinate work/);
	assert.match(text, /implement change/);
	assert.match(text, /first chunk/);
	assert.match(text, /PgUp\/PgDn scroll output/);
});

test("Agent modal rereads the same store snapshot on every stream repaint", () => {
	const rows = [row("worker", { tail: "initial stream" })];
	const { component } = makeOverlay(rows, "worker");
	assert.match(component.render(100).join("\n"), /initial stream/);
	rows[0] = row("worker", { tail: "latest streamed chunk", activeTool: "edit" });
	const updated = component.render(100).join("\n");
	assert.match(updated, /latest streamed chunk/);
	assert.match(updated, /edit/);
	assert.doesNotMatch(updated, /initial stream/);
});

test("Agent modal navigation synchronizes selection and Esc closes", () => {
	const rows = [row("parent"), row("child", { parentCorrelationId: "parent" })];
	const { component, state } = makeOverlay(rows, "child");
	component.render(100);
	component.handleInput("\x1b[A");
	assert.equal(state().viewingId, "parent");
	assert.deepEqual(state().selections, ["parent"]);
	assert.ok(state().renders > 0);
	component.handleInput("\x1b");
	assert.equal(state().closes, 1);
});

test("Agent modal uses a one-line compact layout on tiny terminals", () => {
	const { component } = makeOverlay([row("worker")], "worker", 6);
	const lines = component.render(80);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /Agents 1/);
});

test("Agent modal stays width-bounded in compact, narrow and wide layouts", () => {
	const rows = [row("worker", { task: "x".repeat(300), tail: "y".repeat(500) })];
	const { component } = makeOverlay(rows, "worker");
	for (const width of [1, 12, 19, 60, 120]) {
		for (const line of component.render(width)) {
			assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
		}
	}
});

test("Agent modal i interrupts the selected agent and shows a transient ack", () => {
	const rows = [row("worker")];
	const { component, state } = makeOverlay(rows, "worker");
	component.handleInput("i");
	assert.deepEqual(state().commands, [{ id: "worker", action: "interrupt" }]);
	const text = component.render(100).join("\n");
	assert.match(text, /✓ interrupt @worker/);
});

test("Agent modal s composes a steer message, Enter sends, Esc cancels", () => {
	const rows = [row("worker")];
	const { component, state } = makeOverlay(rows, "worker");
	component.handleInput("s");
	assert.match(component.render(100).join("\n"), /steer @worker:/);
	component.handleInput("r");
	component.handleInput("e");
	component.handleInput("t");
	component.handleInput("r");
	component.handleInput("y");
	component.handleInput("\r");
	assert.deepEqual(state().commands, [{ id: "worker", action: "steer", message: "retry" }]);
	assert.match(component.render(100).join("\n"), /✓ steer @worker: retry/);

	// A fresh compose can be cancelled without sending.
	component.handleInput("s");
	component.handleInput("a");
	component.handleInput("\x1b");
	assert.equal(state().commands.length, 1, "Esc cancels the draft without sending");
});

test("Agent modal ignores commands without a selected agent", () => {
	const { component, state } = makeOverlay([], undefined);
	component.handleInput("i");
	component.handleInput("s");
	assert.equal(state().commands.length, 0);
});

test("Agent modal freeze the compose target: roster changes cannot re-target the draft", () => {
	// The roster mutates between compose start and Enter: A completes and the
	// selection auto-moves to B. The draft must still steer A.
	const rows = [row("a"), row("b")];
	const { component, state } = makeOverlay(rows, "a");
	component.handleInput("s");
	rows[0] = row("a", { status: "done" }); // selection reconcile moves to b
	component.handleInput("x");
	component.handleInput("\r");
	assert.deepEqual(state().commands, [{ id: "a", action: "steer", message: "x" }]);
	assert.match(component.render(100).join("\n"), /✓ steer @a: x/);
});

test("Agent modal aborts a compose whose target disappears, without re-targeting", () => {
	const rows = [row("a"), row("b")];
	const { component, state } = makeOverlay(rows, "a");
	component.handleInput("s");
	rows[0] = row("b"); // target a removed entirely; selection falls to b
	component.handleInput("y");
	component.handleInput("\r");
	assert.equal(state().commands.length, 0, "no command may be sent to a different agent");
	assert.match(component.render(100).join("\n"), /steer aborted: @a is gone/);
});
