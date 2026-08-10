import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgentOverlay } from "../src/agent-overlay.ts";
import { cockpitTuiLocale } from "../src/tui-i18n.ts";
import { resolveGlyphs } from "../src/icons.ts";
import type { AgentRow } from "../src/types.ts";

cockpitTuiLocale.setLocale("en");

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
	const rows = [row("worker", { task: `部署 ${"界".repeat(150)} 🚀`, tail: `输出 ${"🙂".repeat(250)}` })];
	const { component } = makeOverlay(rows, "worker");
	for (let width = 1; width <= 120; width++) {
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

test("Agent modal s composes a steer message, Enter sends, Esc cancels", async () => {
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
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(state().commands.length, 1, "Esc cancels the draft without sending");
	assert.doesNotMatch(component.render(100).join("\n"), /steer @worker: a_/);
});

test("Agent modal steer accepts emoji, CJK, IME and multi-character paste", () => {
	const { component, state } = makeOverlay([row("worker")], "worker");
	component.handleInput("s");
	component.handleInput("请重试");
	component.handleInput("🙂");
	component.handleInput(" pasted\ttext\r\nnext");
	component.handleInput("\r");
	assert.deepEqual(state().commands, [{
		id: "worker",
		action: "steer",
		message: "请重试🙂 pasted text next",
	}]);
});

test("Agent modal steer accepts Kitty shortcut and printable CSI-u input", () => {
	const { component, state } = makeOverlay([row("worker")], "worker");
	component.handleInput("\x1b[115u"); // Kitty-encoded "s" enters compose.
	component.handleInput("\x1b[20320u");
	component.handleInput("\x1b[128578u");
	component.handleInput("\r");
	assert.deepEqual(state().commands, [{ id: "worker", action: "steer", message: "你🙂" }]);
});

test("Agent modal steer accepts complete and cross-chunk bracketed paste", () => {
	const encoded = "\x1b[200~line one\nline\ttwo\x1b[201~";
	for (let split = 1; split <= encoded.length; split++) {
		const { component, state } = makeOverlay([row("worker")], "worker");
		component.handleInput("s");
		component.handleInput(encoded.slice(0, split));
		component.handleInput(encoded.slice(split));
		component.handleInput("\r");
		assert.equal(state().commands[0]?.message, "line one line two", `split ${split}`);
	}
});

test("Agent modal steer backspace removes one grapheme", () => {
	const cases = [
		{ input: "A🙂", expected: "A" },
		{ input: "A你", expected: "A" },
		{ input: "Aq\u0307\u0323", expected: "A" },
		{ input: "A👨‍👩‍👧‍👦", expected: "A" },
	];
	for (const { input, expected } of cases) {
		const { component, state } = makeOverlay([row("worker")], "worker");
		component.handleInput("s");
		component.handleInput(input);
		component.handleInput("\x7f");
		component.handleInput("\r");
		assert.equal(state().commands[0]?.message, expected, input);
	}
});

test("Agent modal steer rejects terminal control sequences", () => {
	const { component, state } = makeOverlay([row("worker")], "worker");
	component.handleInput("s");
	component.handleInput("safe");
	component.handleInput("\x1b[31mred");
	component.handleInput("\x9b2Jclear");
	component.handleInput("\x03");
	component.handleInput("\r");
	assert.deepEqual(state().commands, [{ id: "worker", action: "steer", message: "safe" }]);
});

test("Agent modal steer bounds oversized bracketed paste without splitting a grapheme", () => {
	const { component, state } = makeOverlay([row("worker")], "worker");
	component.handleInput("s");
	component.handleInput(`\x1b[200~${"x".repeat(4_095)}🙂tail\x1b[201~`);
	component.handleInput("\r");
	assert.equal(state().commands[0]?.message, "x".repeat(4_095));
	assert.equal(state().commands[0]?.message?.length, 4_095);
});

test("Agent modal steer compose stays width-bounded from 1 through 120 columns", () => {
	const { component } = makeOverlay([row("worker")], "worker");
	component.handleInput("s");
	component.handleInput("组合 q\u0307\u0323 · 🙂 · pasted text ".repeat(20));
	for (let width = 1; width <= 120; width++) {
		for (const line of component.render(width)) {
			assert.ok(visibleWidth(line) <= width, `compose: ${visibleWidth(line)} > ${width}`);
		}
	}
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

test("Agent modal freeze target survives search-field changes", () => {
	const rows = [row("a", { name: "alpha" }), row("b", { name: "beta" })];
	const { component, state } = makeOverlay(rows, "a");
	component.handleInput("/");
	component.handleInput("alpha");
	component.handleInput("\r");
	component.handleInput("s");
	rows[0] = row("a", { name: "renamed" }); // Still visible, but no longer matches the locked filter.
	component.handleInput("keep target");
	component.handleInput("\r");
	assert.deepEqual(state().commands, [{ id: "a", action: "steer", message: "keep target" }]);
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

test("Agent modal / filters the list and shows the match count", () => {
	const rows = [row("alpha"), row("beta"), row("gamma")];
	const { component } = makeOverlay(rows, "alpha");
	component.handleInput("/");
	component.handleInput("b");
	const text = component.render(120).join("\n");
	assert.match(text, /search: b_/);
	assert.match(text, /\(1\/3\)/);
	assert.match(text, /@beta/);
	assert.doesNotMatch(text, /@alpha/);
	assert.doesNotMatch(text, /@gamma/);
});

test("Agent modal search shows the no-match hint and Esc clears the filter", () => {
	const rows = [row("alpha"), row("beta")];
	const { component, state } = makeOverlay(rows, "alpha");
	component.handleInput("/");
	component.handleInput("z");
	const text = component.render(120).join("\n");
	assert.match(text, /No matching agents/);
	// Esc exits search, clears the query and restores the full list.
	component.handleInput("\x1b");
	const restored = component.render(120).join("\n");
	assert.match(restored, /@alpha/);
	assert.match(restored, /@beta/);
	assert.doesNotMatch(restored, /search:/);
	// A second Esc closes the overlay as usual.
	component.handleInput("\x1b");
	assert.equal(state().closes, 1);
});

test("Agent modal search Enter locks the filter and the roster commands act on the match", () => {
	const rows = [row("alpha"), row("beta")];
	const { component, state } = makeOverlay(rows, "alpha");
	component.handleInput("/");
	component.handleInput("b");
	component.handleInput("\r");
	component.handleInput("s");
	component.handleInput("x");
	component.handleInput("\r");
	assert.deepEqual(state().commands, [{ id: "beta", action: "steer", message: "x" }]);
});

test("Agent modal search accepts multi-character paste", () => {
	const rows = [row("alpha"), row("beta")];
	const { component } = makeOverlay(rows, "alpha");
	component.handleInput("/");
	component.handleInput("be"); // terminal paste arrives as one multi-char event
	const text = component.render(120).join("\n");
	assert.match(text, /search: be_/);
	assert.match(text, /\(1\/2\)/);
	assert.match(text, /@beta/);
});

test("Agent modal locked filter keeps the no-match hint instead of the empty-roster copy", () => {
	const rows = [row("alpha"), row("beta")];
	const { component } = makeOverlay(rows, "alpha");
	component.handleInput("/");
	component.handleInput("z");
	component.handleInput("\r"); // Enter locks the filter with zero matches
	const text = component.render(120).join("\n");
	assert.match(text, /No matching agents/);
	assert.match(text, /search: z_/);
	assert.doesNotMatch(text, /No agents/);
});

test("Agent modal locked filter is cleared by Esc before the overlay closes", () => {
	const rows = [row("alpha"), row("beta")];
	const { component, state } = makeOverlay(rows, "alpha");
	component.handleInput("/");
	component.handleInput("b");
	component.handleInput("\r"); // locked: filtered to beta
	component.handleInput("\x1b");
	assert.equal(state().closes, 0, "first Esc clears the filter");
	const text = component.render(120).join("\n");
	assert.match(text, /@alpha/);
	assert.match(text, /@beta/);
	assert.doesNotMatch(text, /search:/);
	component.handleInput("\x1b");
	assert.equal(state().closes, 1, "second Esc closes");
});

test("Agent modal search state survives the compact-height layout", () => {
	const rows = [row("alpha"), row("beta")];
	const { component } = makeOverlay(rows, "alpha", 6);
	component.handleInput("/");
	component.handleInput("b");
	const lines = component.render(80);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /search:/);
	assert.match(lines[0], /\(1\)/);
});
