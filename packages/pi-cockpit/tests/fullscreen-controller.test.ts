import assert from "node:assert/strict";
import test from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { EDITOR_END_SENTINEL, EDITOR_START_SENTINEL } from "../src/claude-editor.ts";
import { COCKPIT_FULLSCREEN_MARKER, createFullscreenController } from "../src/fullscreen-controller.ts";
import { acquireMouseReporting } from "../src/mouse-reporting.ts";

interface FakeHarness {
	tui: TUI;
	writes: string[];
	renders: number;
	inputHandler?: (data: string) => unknown;
	/** Render through the current (possibly wrapped) tui.render. */
	render(): string[];
	setRows(rows: number): void;
	attachInput(handler: ((data: string) => unknown) | undefined): void;
}

function makeHarness(build: () => string[], rows = 20): FakeHarness {
	const writes: string[] = [];
	let currentBuild = build;
	let currentRows = rows;
	let inputHandler: ((data: string) => unknown) | undefined;
	let renders = 0;
	const tui = {
		terminal: {
			rows: currentRows,
			columns: 80,
			write(seq: string) {
				writes.push(seq);
			},
		},
		requestRender() {
			renders++;
		},
		render(width: number) {
			return currentBuild();
		},
	} as unknown as TUI;
	return {
		tui,
		writes,
		renders,
		render: () => tui.render(80),
		setRows(next) {
			currentRows = next;
			(tui.terminal as { rows: number }).rows = next;
		},
		attachInput(handler) {
			inputHandler = handler;
		},
		get inputHandler() {
			return inputHandler;
		},
	};
}

function buildLines(transcript: string[], editor: string[], chrome: string[]): string[] {
	return [...transcript, EDITOR_START_SENTINEL, ...editor, EDITOR_END_SENTINEL, ...chrome];
}

const EDITOR_BLOCK = ["┌ editor", "│ draft", "└───────"];
const CHROME = ["[agents]", "[footer]"];

const WHEEL_UP = "\x1b[<64;5;10M";
const WHEEL_DOWN = "\x1b[<65;5;10M";

test("attach enters alternate screen and wraps render with marker ownership", () => {
	const harness = makeHarness(() => buildLines([], EDITOR_BLOCK, CHROME));
	const original = harness.tui.render;
	const controller = createFullscreenController({});
	controller.attach(harness.tui);
	assert.ok(harness.writes.includes("\x1b[?1049h"), "writes alt-screen enter");
	assert.notEqual(harness.tui.render, original, "render is wrapped");
	const marker = (harness.tui.render as unknown as Record<symbol, unknown>)[COCKPIT_FULLSCREEN_MARKER];
	assert.ok(marker, "fullscreen marker is installed");
	controller.dispose();
	assert.equal(harness.tui.render, original, "dispose restores the original render");
	assert.ok(harness.writes.includes("\x1b[?1049l"), "writes alt-screen exit");
	assert.ok(harness.writes.includes("\x1b[?1002l"), "releases button mouse mode");
	assert.ok(harness.writes.includes("\x1b[?1006l"), "releases SGR mouse mode");
});

test("compose pads short transcript to exactly terminal rows with editor+chrome fixed at bottom", () => {
	const transcript = ["a", "b", "c"];
	const harness = makeHarness(() => buildLines(transcript, EDITOR_BLOCK, CHROME), 20);
	const controller = createFullscreenController({});
	controller.attach(harness.tui);
	const output = harness.render();
	assert.equal(output.length, 20, "output is exactly terminal rows");
	assert.deepEqual(output.slice(15), [...EDITOR_BLOCK, ...CHROME], "editor+chrome occupy the bottom rows");
	// Transcript padded at the top; the 3 real lines sit just above the editor.
	assert.deepEqual(output.slice(12, 15), ["a", "b", "c"], "content preserved above the editor");
	controller.dispose();
});

test("wheel scroll keeps editor+chrome physically fixed and clamps to the viewport", () => {
	let transcript = Array.from({ length: 40 }, (_, i) => `line ${i}`);
	const harness = makeHarness(() => buildLines(transcript, EDITOR_BLOCK, CHROME), 20);
	const controller = createFullscreenController({
		subscribeInput: (handler) => {
			harness.attachInput(handler);
			return () => harness.attachInput(undefined);
		},
	});
	controller.attach(harness.tui);
	harness.inputHandler?.(WHEEL_UP); // scroll up 3
	harness.inputHandler?.(WHEEL_UP); // scroll up 3 -> offset 6
	const scrolled = harness.render();
	assert.equal(scrolled.length, 20);
	assert.deepEqual(scrolled.slice(15), [...EDITOR_BLOCK, ...CHROME], "editor+chrome stay fixed");
	assert.ok(scrolled[14].includes("line 33"), "scrolled view shows earlier transcript (line 33, not line 39)");
	assert.equal(controller.getScrollOffset(), 6);
	// Clamp: huge scroll cannot exceed the transcript viewport.
	for (let i = 0; i < 100; i++) harness.inputHandler?.(WHEEL_UP);
	harness.render();
	assert.equal(controller.getScrollOffset(), 40 - 15, "offset clamps to max");
	harness.render();
	assert.equal(harness.render().length, 20, "still exactly rows");
	controller.dispose();
});

test("wheel down returns toward the live bottom", () => {
	let transcript = Array.from({ length: 40 }, (_, i) => `line ${i}`);
	const harness = makeHarness(() => buildLines(transcript, EDITOR_BLOCK, CHROME), 20);
	const controller = createFullscreenController({
		subscribeInput: (handler) => {
			harness.attachInput(handler);
			return () => harness.attachInput(undefined);
		},
	});
	controller.attach(harness.tui);
	harness.inputHandler?.(WHEEL_UP);
	harness.inputHandler?.(WHEEL_UP);
	assert.equal(controller.getScrollOffset(), 6);
	harness.inputHandler?.(WHEEL_DOWN);
	assert.equal(controller.getScrollOffset(), 3);
	harness.inputHandler?.(WHEEL_DOWN);
	assert.equal(controller.getScrollOffset(), 0, "wheel down to zero reaches live bottom");
	controller.dispose();
});

test("live follow at offset 0 shows the latest transcript lines", () => {
	let transcript = ["one", "two", "three"];
	const harness = makeHarness(() => buildLines(transcript, EDITOR_BLOCK, CHROME), 20);
	const controller = createFullscreenController({});
	controller.attach(harness.tui);
	transcript = [...transcript, "four", "five", "six"];
	const output = harness.render();
	assert.ok(output.slice(0, 15).includes("six"), "live follow shows newest line");
	assert.equal(controller.getScrollOffset(), 0);
	controller.dispose();
});

test("streaming while anchored preserves the visible anchor and reports pending lines", () => {
	let transcript = Array.from({ length: 30 }, (_, i) => `base ${i}`);
	const harness = makeHarness(() => buildLines(transcript, EDITOR_BLOCK, CHROME), 20);
	const controller = createFullscreenController({});
	controller.attach(harness.tui);
	controller.scrollBy(6);
	const anchored = harness.render().slice(0, 15);
	assert.equal(controller.getScrollOffset(), 6, "baseline offset not clamped");
	// New output arrives while anchored.
	transcript = [...transcript, "new A", "new B", "new C"];
	const after = harness.render();
	assert.deepEqual(after.slice(0, 14), anchored.slice(0, 14), "visible anchor preserved (hint overlays the last row)");
	assert.equal(controller.getScrollOffset(), 9, "offset grows by the delta to keep the anchor");
	// The hint row replaces the bottom transcript row.
	assert.ok(after[14].includes("new"), "new-output hint surfaces the pending lines");
	assert.ok(after[14].includes("3"), "hint counts 3 pending lines");
	controller.dispose();
});

test("clicking the new-output hint jumps to the live bottom", () => {
	let transcript = Array.from({ length: 30 }, (_, i) => `base ${i}`);
	const harness = makeHarness(() => buildLines(transcript, EDITOR_BLOCK, CHROME), 20);
	const controller = createFullscreenController({
		subscribeInput: (handler) => {
			harness.attachInput(handler);
			return () => harness.attachInput(undefined);
		},
	});
	controller.attach(harness.tui);
	controller.scrollBy(6);
	harness.render(); // establish the transcript baseline (30 lines)
	transcript = [...transcript, "new A"];
	harness.render(); // growth: offset +1, one pending line
	assert.equal(controller.getScrollOffset(), 7);
	assert.ok(harness.render()[14].includes("\x1b[7m"), "hint is visible (reverse-video row)");
	// Button-0 press on the hint row (row 15 = transcript height).
	harness.inputHandler?.("\x1b[<0;5;15M");
	assert.equal(controller.getScrollOffset(), 0, "hint click jumps to bottom");
	harness.render();
	assert.ok(!harness.render()[14].includes("\x1b[7m"), "hint disappears at the live bottom");
	controller.dispose();
});

test("resize re-clamps without corrupting the fixed editor", () => {
	const transcript = Array.from({ length: 40 }, (_, i) => `line ${i}`);
	const harness = makeHarness(() => buildLines(transcript, EDITOR_BLOCK, CHROME), 20);
	const controller = createFullscreenController({});
	controller.attach(harness.tui);
	controller.scrollBy(100);
	harness.render();
	harness.setRows(30);
	const output = harness.render();
	assert.equal(output.length, 30, "output matches new rows");
	assert.deepEqual(output.slice(25), [...EDITOR_BLOCK, ...CHROME], "editor+chrome fixed after resize");
	assert.ok(controller.getScrollOffset() <= 40 - 25, "offset clamped to the larger viewport");
	controller.dispose();
});

test("missing editor markers fall back to passthrough without crashing", () => {
	const harness = makeHarness(() => ["header", "chat", "no markers"], 20);
	const controller = createFullscreenController({});
	controller.attach(harness.tui);
	const output = harness.render();
	assert.deepEqual(output, ["header", "chat", "no markers"], "passthrough unchanged");
	controller.dispose();
});

test("mouse lease pairs with an existing split-pane lease (ref-counted)", () => {
	const harness = makeHarness(() => buildLines([], EDITOR_BLOCK, CHROME), 20);
	const controller = createFullscreenController({});
	controller.attach(harness.tui);
	assert.ok(harness.writes.includes("\x1b[?1002h"));
	assert.ok(harness.writes.includes("\x1b[?1006h"));
	// A second (e.g. split-pane) lease shares the modes; releasing ours must not
	// disable them while the other lease is still held.
	const other = acquireMouseReporting(harness.tui, "button");
	controller.dispose();
	assert.equal(harness.writes.includes("\x1b[?1002l"), false, "shared mode not disabled while another lease is held");
	other.release();
	assert.ok(harness.writes.includes("\x1b[?1002l"), "disabled once the last lease releases");
});

test("copy-on-select drag copies transcript text and wheel still scrolls", async () => {
	const transcript = Array.from({ length: 15 }, (_, i) => `r${i}`);
	const harness = makeHarness(() => buildLines(transcript, EDITOR_BLOCK, CHROME), 20);
	const copied: string[] = [];
	const controller = createFullscreenController({
		isCopyOnSelect: () => true,
		copy: async (text) => { copied.push(text); },
		subscribeInput: (handler) => {
			harness.attachInput(handler);
			return () => harness.attachInput(undefined);
		},
	});
	controller.attach(harness.tui);
	harness.render(); // transcript height 15, no padding
	// Drag over rows 1-2 (r0, r1), cols 0-2.
	harness.inputHandler?.("\x1b[<0;1;1M"); // press button 0 at (1,1)
	harness.inputHandler?.("\x1b[<32;3;2M"); // motion to (3,2)
	harness.inputHandler?.("\x1b[<0;3;2m"); // release at (3,2)
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(copied, ["r0\nr1"], "drag copies the selected transcript rows");
	// Wheel still scrolls after a selection (selection is cleared on wheel).
	harness.inputHandler?.(WHEEL_UP);
	assert.equal(controller.getScrollOffset(), 3);
	controller.dispose();
});

test("copy-on-select disabled: drags are ignored but wheel scrolling works", async () => {
	const transcript = Array.from({ length: 15 }, (_, i) => `r${i}`);
	const harness = makeHarness(() => buildLines(transcript, EDITOR_BLOCK, CHROME), 20);
	const copied: string[] = [];
	const controller = createFullscreenController({
		isCopyOnSelect: () => false,
		copy: async (text) => { copied.push(text); },
		subscribeInput: (handler) => {
			harness.attachInput(handler);
			return () => harness.attachInput(undefined);
		},
	});
	controller.attach(harness.tui);
	harness.render();
	harness.inputHandler?.("\x1b[<0;1;1M");
	harness.inputHandler?.("\x1b[<32;3;2M");
	harness.inputHandler?.("\x1b[<0;3;2m");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(copied, [], "no copy when copy-on-select is off");
	harness.inputHandler?.(WHEEL_UP);
	assert.equal(controller.getScrollOffset(), 3, "wheel still scrolls without copy-on-select");
	controller.dispose();
});
