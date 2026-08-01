import assert from "node:assert/strict";
import test from "node:test";
import { TUI, type Component, type Terminal } from "@earendil-works/pi-tui";
import { attachViewportStability } from "../src/viewport-stability.ts";

class FakeTerminal implements Terminal {
	columns = 40;
	rows = 3;
	kittyProtocolActive = false;
	writes: string[] = [];
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void { this.writes.push(data); }
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

interface TuiInternals {
	doRender(): void;
	applyLineResets(lines: string[]): string[];
	previousLines: string[];
	previousViewportTop: number;
	previousHeight: number;
}

function renderHarness(initialLines: string[]) {
	const terminal = new FakeTerminal();
	const tui = new TUI(terminal);
	let lines = [...initialLines];
	const component: Component = {
		render: () => [...lines],
		invalidate: () => undefined,
	};
	tui.addChild(component);
	const internals = tui as unknown as TuiInternals;
	return {
		terminal,
		tui,
		internals,
		setLines(next: string[]) { lines = [...next]; },
		render() { internals.doRender(); },
	};
}

test("stable-height changes above the viewport do not clear screen or scrollback", () => {
	const h = renderHarness(["zero", "one", "two", "three", "four"]);
	const patch = attachViewportStability(h.tui);
	assert.equal(patch.active, true);

	h.render();
	assert.equal(h.tui.fullRedraws, 1);
	assert.equal(h.internals.previousViewportTop, 2);
	h.terminal.writes.length = 0;

	h.setLines(["ZERO", "one", "two", "three", "four"]);
	h.render();
	assert.equal(h.tui.fullRedraws, 1);
	assert.equal(h.terminal.writes.some((value) => value.includes("\x1b[3J")), false);
	assert.ok(h.internals.previousLines[0]?.startsWith("ZERO\x1b[0m"));
	assert.ok(h.internals.previousLines[1]?.startsWith("one\x1b[0m"));
});

test("visible changes still render differentially after hidden changes are absorbed", () => {
	const h = renderHarness(["zero", "one", "two", "three", "four"]);
	attachViewportStability(h.tui);
	h.render();
	h.terminal.writes.length = 0;

	h.setLines(["ZERO", "one", "two", "three", "FOUR"]);
	h.render();
	assert.equal(h.tui.fullRedraws, 1);
	assert.equal(h.terminal.writes.length, 1);
	assert.equal(h.terminal.writes[0].includes("\x1b[3J"), false);
	assert.match(h.terminal.writes[0], /FOUR/);
});

test("content height changes retain pi-tui full redraw behavior", () => {
	const h = renderHarness(["zero", "one", "two", "three", "four"]);
	attachViewportStability(h.tui);
	h.render();
	h.terminal.writes.length = 0;

	h.setLines(["ZERO", "one", "two", "three", "four", "five"]);
	h.render();
	assert.equal(h.tui.fullRedraws, 2);
	assert.equal(h.terminal.writes.some((value) => value.includes("\x1b[3J")), true);
});

test("terminal height changes leave the old diff baseline untouched", () => {
	const h = renderHarness(["zero", "one", "two", "three", "four"]);
	attachViewportStability(h.tui);
	h.render();
	assert.equal(h.internals.previousHeight, 3);
	const oldHiddenLine = h.internals.previousLines[1];

	h.terminal.rows = 4;
	h.internals.applyLineResets(["ZERO", "ONE", "two", "three", "four"]);
	assert.equal(h.internals.previousLines[1], oldHiddenLine);
});

test("hidden Kitty image controls stay in the native redraw path", () => {
	const h = renderHarness(["zero", "one", "two", "three", "four"]);
	attachViewportStability(h.tui);
	h.render();
	const oldImage = "\x1b_Ga=T,f=100,r=2,i=1;old\x1b\\";
	const newImage = "\x1b_Ga=T,f=100,r=2,i=1;new\x1b\\";
	h.internals.previousLines[0] = oldImage;

	h.internals.applyLineResets([newImage, "one", "two", "three", "four"]);
	assert.equal(h.internals.previousLines[0], oldImage);
});

test("overlapping attachments retain the hook until the last detach", () => {
	const h = renderHarness(["zero"]);
	const original = h.internals.applyLineResets;
	const first = attachViewportStability(h.tui);
	const wrapped = h.internals.applyLineResets;
	const second = attachViewportStability(h.tui);

	first.detach();
	first.detach();
	assert.equal(h.internals.applyLineResets, wrapped);
	second.detach();
	second.detach();
	assert.equal(h.internals.applyLineResets, original);
});

test("detach restores the exact prior hook and preserves later replacements", () => {
	const h = renderHarness(["zero"]);
	const original = h.internals.applyLineResets;
	const patch = attachViewportStability(h.tui);
	assert.notEqual(h.internals.applyLineResets, original);
	patch.detach();
	assert.equal(h.internals.applyLineResets, original);

	const second = attachViewportStability(h.tui);
	const replacement = (lines: string[]): string[] => lines;
	h.internals.applyLineResets = replacement;
	second.detach();
	assert.equal(h.internals.applyLineResets, replacement);
});
