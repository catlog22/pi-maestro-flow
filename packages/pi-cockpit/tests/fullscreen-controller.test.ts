import assert from "node:assert/strict";
import test from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { EDITOR_END_SENTINEL, EDITOR_START_SENTINEL } from "../src/claude-editor.ts";
import { COCKPIT_FULLSCREEN_MARKER, createFullscreenController } from "../src/fullscreen-controller.ts";
import { acquireMouseReporting } from "../src/mouse-reporting.ts";
import { createDynamicTuiReference } from "./dynamic-tui-reference.ts";

interface FakeHarness {
	tui: TUI;
	writes: string[];
	renders: number;
	inputHandler?: (data: string) => unknown;
	/** Render through the current (possibly wrapped) tui.render. */
	render(): string[];
	setRows(rows: number): void;
	attachInput(handler: ((data: string) => unknown) | undefined): void;
	wasForceRendered(): boolean;
}

function makeHarness(build: () => string[], rows = 20): FakeHarness {
	const writes: string[] = [];
	let currentBuild = build;
	let currentRows = rows;
	let inputHandler: ((data: string) => unknown) | undefined;
	let renders = 0;
	let lastForce = false;
	const tui = {
		terminal: {
			rows: currentRows,
			columns: 80,
			write(seq: string) {
				writes.push(seq);
			},
		},
		requestRender(force?: boolean) {
			renders++;
			lastForce = force === true;
		},
		render(width: number) {
			return currentBuild();
		},
		// Diff-renderer baseline fields that seedBaseline resets.
		previousLines: [] as string[],
		previousWidth: -1,
		previousHeight: -1,
		previousViewportTop: 0,
		maxLinesRendered: 0,
		cursorRow: 0,
		hardwareCursorRow: 0,
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
		wasForceRendered() {
			return lastForce;
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

test("dynamic TUI references are left inactive and unwrapped", () => {
	const harness = makeHarness(() => buildLines([], EDITOR_BLOCK, CHROME));
	const reference = createDynamicTuiReference(harness.tui);
	const original = harness.tui.render;
	const controller = createFullscreenController({});

	controller.attach(reference);

	assert.equal(controller.isActive(), false);
	assert.equal(harness.tui.render, original);
	assert.equal(harness.writes.includes("\x1b[?1049h"), false);
	assert.doesNotThrow(() => reference.render(80));
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

test("X10 wheel (non-SGR fallback) still scrolls the transcript", () => {
	let transcript = Array.from({ length: 40 }, (_, i) => `line ${i}`);
	const harness = makeHarness(() => buildLines(transcript, EDITOR_BLOCK, CHROME), 20);
	const controller = createFullscreenController({
		subscribeInput: (handler) => {
			harness.attachInput(handler);
			return () => harness.attachInput(undefined);
		},
	});
	controller.attach(harness.tui);
	const x10 = (btn: number, x: number, y: number) => `\x1b[M${String.fromCharCode(btn + 32, x + 32, y + 32)}`;
	harness.inputHandler?.(x10(64, 5, 10)); // X10 wheel-up
	harness.inputHandler?.(x10(64, 5, 10));
	assert.equal(controller.getScrollOffset(), 6, "X10 wheel scrolls the transcript");
	harness.inputHandler?.(x10(65, 5, 10)); // X10 wheel-down
	assert.equal(controller.getScrollOffset(), 3, "X10 wheel-down returns toward live bottom");
	assert.ok(!harness.render()[14].includes("\x1b[7m"), "X10 wheel never starts a selection");
	controller.dispose();
});

test("X10 drag (non-SGR fallback) selects and copies like SGR", async () => {
	let transcript = Array.from({ length: 20 }, (_, i) => `line ${i}`);
	let copied: string | undefined;
	const harness = makeHarness(() => buildLines(transcript, EDITOR_BLOCK, CHROME), 20);
	const controller = createFullscreenController({
		subscribeInput: (handler) => {
			harness.attachInput(handler);
			return () => harness.attachInput(undefined);
		},
		isCopyOnSelect: () => true,
		copy: async (text) => {
			copied = text;
		},
	});
	controller.attach(harness.tui);
	const x10 = (btn: number, x: number, y: number) => `\x1b[M${String.fromCharCode(btn + 32, x + 32, y + 32)}`;
	harness.inputHandler?.(x10(0, 1, 1)); // press button 0 at (1,1)
	harness.inputHandler?.(x10(32, 6, 2)); // motion to (6,2)
	harness.inputHandler?.(x10(3, 6, 2)); // release
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(copied, "line 5\nline 6", "X10 drag copies the selected rows");
	controller.dispose();
});

test("legacy urxvt wheel buttons 4/5 scroll instead of starting a drag", () => {
	let transcript = Array.from({ length: 40 }, (_, i) => `line ${i}`);
	const harness = makeHarness(() => buildLines(transcript, EDITOR_BLOCK, CHROME), 20);
	const controller = createFullscreenController({
		subscribeInput: (handler) => {
			harness.attachInput(handler);
			return () => harness.attachInput(undefined);
		},
	});
	controller.attach(harness.tui);
	harness.inputHandler?.("\x1b[<4;5;10M"); // button 4 = legacy wheel up
	harness.inputHandler?.("\x1b[<4;5;10M");
	assert.equal(controller.getScrollOffset(), 6, "legacy wheel-up scrolls the transcript");
	harness.inputHandler?.("\x1b[<5;5;10M"); // button 5 = legacy wheel down
	assert.equal(controller.getScrollOffset(), 3, "legacy wheel-down returns toward live bottom");
	assert.ok(!harness.render()[14].includes("\x1b[7m"), "legacy wheel never starts a selection");
	controller.dispose();
});

test("modifier-wheel still scrolls the transcript instead of starting a drag", () => {
	let transcript = Array.from({ length: 40 }, (_, i) => `line ${i}`);
	const harness = makeHarness(() => buildLines(transcript, EDITOR_BLOCK, CHROME), 20);
	const controller = createFullscreenController({
		subscribeInput: (handler) => {
			harness.attachInput(handler);
			return () => harness.attachInput(undefined);
		},
	});
	controller.attach(harness.tui);
	// Shift+wheel-up = button 68 (64 + 4 shift). Must scroll, not select.
	harness.inputHandler?.("\x1b[<68;5;10M");
	assert.equal(controller.getScrollOffset(), 3, "modifier wheel scrolls the transcript");
	assert.equal(harness.render()[14].includes("\x1b[7m"), false, "no selection highlight from wheel");
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

test("attach seeds the alternate screen with the composed frame and resets the diff baseline", () => {
	const harness = makeHarness(() => buildLines(Array.from({ length: 15 }, (_, i) => `r${i}`), EDITOR_BLOCK, CHROME), 20);
	const controller = createFullscreenController({});
	controller.attach(harness.tui);
	assert.ok(harness.writes.includes("\x1b[?1049h"), "enters the alternate screen");
	// Direct entry write: clear + composed frame (editor + footer present).
	const entry = harness.writes.join("");
	assert.ok(entry.includes("\x1b[2J\x1b[H"), "clears and homes the alternate screen");
	assert.ok(entry.includes("┌ editor"), "composed frame includes the editor");
	assert.ok(entry.includes("[footer]"), "composed frame includes the footer");
	assert.ok(!entry.includes("cockpit:editor"), "markers stripped from the entry frame");
	// Diff baseline seeded to the composed frame so the next render only diffs.
	const prev = (harness.tui as unknown as { previousLines: string[] }).previousLines;
	assert.equal(prev.length, 20, "baseline is exactly the composed rows");
	assert.ok(prev.some((l) => l.includes("┌ editor")), "baseline keeps the editor");
	assert.ok(prev.some((l) => l.includes("[footer]")), "baseline keeps the footer");
	controller.dispose();
	assert.ok(harness.writes.join("").includes("\x1b[?1049l"), "leaves the alternate screen on dispose");
});

test("compose strips the editor markers from the output", () => {
	const transcript = Array.from({ length: 15 }, (_, i) => `r${i}`);
	const harness = makeHarness(() => buildLines(transcript, EDITOR_BLOCK, CHROME), 20);
	const controller = createFullscreenController({});
	controller.attach(harness.tui);
	const output = harness.render();
	assert.equal(output.some((line) => line.includes(EDITOR_START_SENTINEL)), false);
	assert.equal(output.some((line) => line.includes(EDITOR_END_SENTINEL)), false);
	controller.dispose();
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

test("copy-on-select disabled: drags still select (highlight) but do not copy; wheel works", async () => {
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
	// The highlight is composited into the rendered frame while dragging.
	const dragging = harness.render();
	assert.ok(dragging[0].includes("\x1b[7m"), "drag still highlights without copy-on-select");
	harness.inputHandler?.("\x1b[<0;3;2m");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(copied, [], "no copy when copy-on-select is off");
	harness.inputHandler?.(WHEEL_UP);
	assert.equal(controller.getScrollOffset(), 3, "wheel still scrolls without copy-on-select");
	controller.dispose();
});
