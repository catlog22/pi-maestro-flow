import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, TuiAltScreen, TuiMainScreen, type Component, type Terminal, type TUI } from "@earendil-works/pi-tui";
import { attachViewportStability } from "../src/viewport-stability.ts";
import { createDynamicTuiReference, createSwitchingDynamicTuiReference } from "./dynamic-tui-reference.ts";

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
	previousWidth: number;
	hardwareCursorRow: number;
}

function methodOwner(target: object, method: string): object {
	let owner = Object.getPrototypeOf(target) as object | null;
	while (owner && !Object.hasOwn(owner, method)) owner = Object.getPrototypeOf(owner) as object | null;
	assert.ok(owner, `${method} must exist on the renderer prototype chain`);
	return owner;
}

function renderHarness(initialLines: string[]) {
	const terminal = new FakeTerminal();
	const tui = new TuiMainScreen(terminal);
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

test("equal-height hidden Agent Bar changes stay frozen without replaying scrollback", () => {
	const h = renderHarness(["▸ @main  @builder · teammate •2", "one", "two", "three", "four"]);
	const patch = attachViewportStability(h.tui);
	assert.equal(patch.active, true);

	h.render();
	assert.equal(h.tui.fullRedraws, 1);
	assert.equal(h.internals.previousViewportTop, 2);
	h.terminal.writes.length = 0;

	h.setLines(["▸ @main  @builder · read path=src •3", "one", "two", "three", "four"]);
	h.render();
	assert.equal(h.tui.fullRedraws, 1, "hidden Agent activity must not clear and replay scrollback");
	assert.equal(h.terminal.writes.some((value) => value.includes("\x1b[3J")), false);
	assert.equal(h.terminal.writes.some((value) => value.includes("read path=src")), false);
	assert.ok(h.internals.previousLines[0]?.includes("@builder · teammate •2"), "the diff baseline must match terminal scrollback");
});

test("a hidden Agent Bar change does not block a visible differential update", () => {
	const h = renderHarness(["▸ @main  @builder · teammate •2", "one", "two", "three", "four"]);
	attachViewportStability(h.tui);
	h.render();
	h.terminal.writes.length = 0;

	h.setLines(["▸ @main  @builder · read path=src •3", "one", "two", "three", "FOUR"]);
	h.render();
	assert.equal(h.tui.fullRedraws, 1);
	assert.equal(h.terminal.writes.some((value) => value.includes("\x1b[3J")), false);
	assert.equal(h.terminal.writes.some((value) => value.includes("read path=src")), false);
	assert.equal(h.terminal.writes.some((value) => value.includes("FOUR")), true);
	assert.ok(h.internals.previousLines[0]?.startsWith("▸ @main  @builder · teammate •2\x1b[0m"));
	assert.ok(h.internals.previousLines[4]?.startsWith("FOUR\x1b[0m"));
});

test("changes at the first visible line remain live", () => {
	const h = renderHarness(["zero", "one", "two", "three", "four"]);
	attachViewportStability(h.tui);
	h.render();
	h.terminal.writes.length = 0;

	h.setLines(["ZERO", "ONE", "TWO", "three", "four"]);
	h.render();
	assert.equal(h.tui.fullRedraws, 1);
	assert.equal(h.terminal.writes.some((value) => value.includes("\x1b[3J")), false);
	assert.equal(h.terminal.writes.some((value) => value.includes("TWO")), true);
	assert.ok(h.internals.previousLines[0]?.startsWith("zero\x1b[0m"));
	assert.ok(h.internals.previousLines[1]?.startsWith("one\x1b[0m"));
	assert.ok(h.internals.previousLines[2]?.startsWith("TWO\x1b[0m"));
});

test("a Kitty image at the first visible line does not block hidden scrollback preservation", () => {
	const image = "\x1b_Ga=T,f=100,r=1,i=1;image\x1b\\";
	const h = renderHarness(["zero", "one", image, "three", "four"]);
	attachViewportStability(h.tui);
	h.render();
	assert.equal(h.internals.previousViewportTop, 2);
	h.terminal.writes.length = 0;

	h.setLines(["ZERO", "ONE", image, "three", "four"]);
	h.render();
	assert.equal(h.tui.fullRedraws, 1);
	assert.equal(h.terminal.writes.some((value) => value.includes("\x1b[3J")), false);
	assert.ok(h.internals.previousLines[0]?.startsWith("zero\x1b[0m"));
	assert.ok(h.internals.previousLines[1]?.startsWith("one\x1b[0m"));
	assert.ok(h.internals.previousLines[2]?.includes("\x1b_G"));
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
	assert.ok(h.internals.previousLines[0]?.startsWith("ZERO\x1b[0m"));
});

test("content shrink retains pi-tui full redraw behavior", () => {
	const h = renderHarness(["zero", "one", "two", "three", "four", "five"]);
	attachViewportStability(h.tui);
	h.render();
	h.terminal.writes.length = 0;

	h.setLines(["ZERO", "one", "two", "three", "four"]);
	h.render();
	assert.equal(h.tui.fullRedraws, 2);
	assert.equal(h.terminal.writes.some((value) => value.includes("\x1b[3J")), true);
	assert.ok(h.internals.previousLines[0]?.startsWith("ZERO\x1b[0m"));
	assert.equal(h.internals.previousLines.length, 5);
});

test("terminal height changes retain the native canonical redraw", () => {
	const h = renderHarness(["zero", "one", "two", "three", "four"]);
	attachViewportStability(h.tui);
	h.render();
	assert.equal(h.internals.previousHeight, 3);
	h.terminal.writes.length = 0;

	h.terminal.rows = 4;
	h.setLines(["ZERO", "ONE", "two", "three", "four"]);
	h.render();
	assert.equal(h.tui.fullRedraws, 2);
	assert.equal(h.terminal.writes.some((value) => value.includes("\x1b[3J")), true);
	assert.ok(h.internals.previousLines[0]?.startsWith("ZERO\x1b[0m"));
	assert.ok(h.internals.previousLines[1]?.startsWith("ONE\x1b[0m"));
});

test("terminal width changes retain the native canonical redraw", () => {
	const h = renderHarness(["zero", "one", "two", "three", "four"]);
	attachViewportStability(h.tui);
	h.render();
	assert.equal(h.internals.previousWidth, 40);
	h.terminal.writes.length = 0;

	h.terminal.columns = 50;
	h.setLines(["ZERO", "ONE", "two", "three", "four"]);
	h.render();
	assert.equal(h.tui.fullRedraws, 2);
	assert.equal(h.terminal.writes.some((value) => value.includes("\x1b[3J")), true);
	assert.ok(h.internals.previousLines[0]?.startsWith("ZERO\x1b[0m"));
	assert.ok(h.internals.previousLines[1]?.startsWith("ONE\x1b[0m"));
});

test("capturing overlays repaint visible rows without replaying hidden main-screen churn", () => {
	const h = renderHarness(["history old", "one", "two", "three", "four"]);
	attachViewportStability(h.tui);
	let overlayText = "overlay old";
	const handle = h.tui.showOverlay({
		render: () => [overlayText],
		invalidate: () => undefined,
	}, { row: 0, col: 0, width: 20 });
	h.tui.renderNow();
	assert.equal(h.internals.previousViewportTop, 2);
	h.terminal.writes.length = 0;

	h.setLines(["history NEW", "ONE", "two", "three", "four"]);
	overlayText = "overlay NEW";
	h.tui.renderNow();
	assert.equal(h.tui.fullRedraws, 1);
	assert.equal(h.terminal.writes.some((value) => value.includes("\x1b[3J")), false);
	assert.equal(h.terminal.writes.some((value) => value.includes("overlay NEW")), true);
	assert.ok(h.internals.previousLines[0]?.startsWith("history old\x1b[0m"));
	assert.ok(h.internals.previousLines[1]?.startsWith("one\x1b[0m"));

	handle.hide();
	h.tui.renderNow();
});

test("cursor positioning stays live while hidden content remains immutable", () => {
	const h = renderHarness(["history old", "one", "two", "three", `four${CURSOR_MARKER}`]);
	attachViewportStability(h.tui);
	h.render();
	assert.equal(h.internals.hardwareCursorRow, 4);
	h.terminal.writes.length = 0;

	h.setLines(["history NEW", "ONE", "two", `three${CURSOR_MARKER}`, "four"]);
	h.render();
	assert.equal(h.tui.fullRedraws, 1);
	assert.equal(h.terminal.writes.some((value) => value.includes("\x1b[3J")), false);
	assert.equal(h.terminal.writes.some((value) => value.includes("\x1b[1A")), true);
	assert.equal(h.internals.hardwareCursorRow, 3);
	assert.ok(h.internals.previousLines[0]?.startsWith("history old\x1b[0m"));
});

test("hidden Kitty image controls stay in the native redraw path", () => {
	const oldImage = "\x1b_Ga=T,f=100,r=2,i=1;old\x1b\\";
	const newImage = "\x1b_Ga=T,f=100,r=2,i=1;new\x1b\\";
	const h = renderHarness([oldImage, "one", "two", "three", "four"]);
	attachViewportStability(h.tui);
	h.render();
	h.terminal.writes.length = 0;

	h.setLines([newImage, "ONE", "two", "three", "four"]);
	h.render();
	assert.equal(h.tui.fullRedraws, 2);
	assert.equal(h.terminal.writes.some((value) => value.includes("\x1b[3J")), true);
	assert.ok(h.internals.previousLines[0]?.includes("new"));
	assert.ok(h.internals.previousLines[1]?.startsWith("ONE\x1b[0m"));
});

test("native fullscreen misses are not cached by a dynamic TUI reference", () => {
	const fullscreen = new TuiAltScreen(new FakeTerminal());
	const regular = renderHarness(["zero", "one", "two", "three", "four"]);
	let current: TUI = fullscreen;
	const reference = createSwitchingDynamicTuiReference(() => current);
	assert.equal(attachViewportStability(reference).active, false);

	current = regular.tui;
	const patch = attachViewportStability(reference);
	assert.equal(patch.active, true);
	regular.render();
	regular.terminal.writes.length = 0;
	regular.setLines(["ZERO", "ONE", "two", "three", "four"]);
	regular.render();
	assert.equal(regular.tui.fullRedraws, 1);
	assert.equal(regular.terminal.writes.some((value) => value.includes("\x1b[3J")), false);
	patch.detach();
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
	assert.equal(Object.hasOwn(h.tui, "applyLineResets"), false);
	const patch = attachViewportStability(h.tui);
	assert.notEqual(h.internals.applyLineResets, original);
	assert.equal(Object.hasOwn(h.tui, "applyLineResets"), true);
	patch.detach();
	assert.equal(h.internals.applyLineResets, original);
	assert.equal(Object.hasOwn(h.tui, "applyLineResets"), false, "detach removes the temporary own method slot");

	const second = attachViewportStability(h.tui);
	const replacement = (lines: string[]): string[] => lines;
	h.internals.applyLineResets = replacement;
	second.detach();
	assert.equal(h.internals.applyLineResets, replacement);
});

test("detach restores an existing instance descriptor exactly", () => {
	const h = renderHarness(["zero"]);
	const inherited = h.internals.applyLineResets;
	Object.defineProperty(h.tui, "applyLineResets", {
		configurable: true,
		enumerable: true,
		writable: true,
		value: inherited,
	});
	const before = Object.getOwnPropertyDescriptor(h.tui, "applyLineResets");
	const patch = attachViewportStability(h.tui);
	patch.detach();
	assert.deepEqual(Object.getOwnPropertyDescriptor(h.tui, "applyLineResets"), before);
});

test("dynamic TUI references patch the stable renderer prototype without wrapping dispatch closures", () => {
	const h = renderHarness(["zero", "one", "two", "three", "four"]);
	const owner = methodOwner(h.tui, "applyLineResets");
	const original = Object.getOwnPropertyDescriptor(owner, "applyLineResets")?.value;
	const reference = createDynamicTuiReference(h.tui);

	const patch = attachViewportStability(reference);
	assert.equal(patch.active, true);
	assert.notEqual(Object.getOwnPropertyDescriptor(owner, "applyLineResets")?.value, original);

	h.render();
	assert.equal(h.internals.previousViewportTop, 2);
	h.terminal.writes.length = 0;
	h.setLines(["ZERO", "ONE", "two", "three", "four"]);
	h.render();
	assert.equal(h.tui.fullRedraws, 1, "dynamic references preserve hidden scrollback without a full redraw");
	assert.equal(h.terminal.writes.some((value) => value.includes("\x1b[3J")), false);
	assert.ok(h.internals.previousLines[0]?.startsWith("zero\x1b[0m"));
	assert.ok(h.internals.previousLines[1]?.startsWith("one\x1b[0m"));

	patch.detach();
	assert.equal(Object.getOwnPropertyDescriptor(owner, "applyLineResets")?.value, original);
});

test("dynamic TUI prototype attachments stay installed until every owner detaches", () => {
	const h = renderHarness(["zero"]);
	const owner = methodOwner(h.tui, "applyLineResets");
	const original = Object.getOwnPropertyDescriptor(owner, "applyLineResets")?.value;
	const first = attachViewportStability(createDynamicTuiReference(h.tui));
	const wrapped = Object.getOwnPropertyDescriptor(owner, "applyLineResets")?.value;
	const second = attachViewportStability(createDynamicTuiReference(h.tui));

	first.detach();
	assert.equal(Object.getOwnPropertyDescriptor(owner, "applyLineResets")?.value, wrapped);
	second.detach();
	assert.equal(Object.getOwnPropertyDescriptor(owner, "applyLineResets")?.value, original);
});

test("dynamic TUI probing fails closed for throwing, cyclic, or shadowed methods", () => {
	const throwing = new Proxy({} as TUI, {
		get() { throw new Error("blocked"); },
		getPrototypeOf() { throw new Error("blocked"); },
	});
	assert.equal(attachViewportStability(throwing).active, false);

	let cyclic: TUI;
	cyclic = new Proxy({} as TUI, {
		get() { return () => undefined; },
		getPrototypeOf() { return cyclic; },
	});
	assert.equal(attachViewportStability(cyclic).active, false);

	const shadowed = renderHarness(["zero"]);
	const owner = methodOwner(shadowed.tui, "applyLineResets");
	const original = Object.getOwnPropertyDescriptor(owner, "applyLineResets")?.value;
	Object.defineProperty(shadowed.tui, "applyLineResets", {
		configurable: true,
		writable: true,
		value: (lines: string[]) => lines,
	});
	assert.equal(attachViewportStability(createDynamicTuiReference(shadowed.tui)).active, false);
	assert.equal(Object.getOwnPropertyDescriptor(owner, "applyLineResets")?.value, original);
});

test("dynamic TUI references preserve hidden scrollback when the renderer instance changes", () => {
	const first = renderHarness(["zero", "one", "two", "three", "four"]);
	const second = renderHarness(["zero", "one", "two", "three", "four"]);
	let current = first.tui;
	const reference = createSwitchingDynamicTuiReference(() => current);
	const patch = attachViewportStability(reference);
	assert.equal(patch.active, true);

	current = second.tui;
	second.render();
	second.terminal.writes.length = 0;
	second.setLines(["ZERO", "ONE", "two", "three", "four"]);
	second.render();
	assert.equal(second.tui.fullRedraws, 1);
	assert.equal(second.terminal.writes.some((value) => value.includes("\x1b[3J")), false);
	assert.ok(second.internals.previousLines[0]?.startsWith("zero\x1b[0m"));
	assert.ok(second.internals.previousLines[1]?.startsWith("one\x1b[0m"));

	patch.detach();
});
