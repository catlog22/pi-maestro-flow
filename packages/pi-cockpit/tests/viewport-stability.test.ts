import assert from "node:assert/strict";
import test from "node:test";
import { TuiMainScreen, type Component, type Terminal, type TUI } from "@earendil-works/pi-tui";
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

test("equal-height hidden timer changes stay frozen without adding redraw frames", () => {
	const h = renderHarness(["\x1b[3mteammate · 11s\x1b[23m", "one", "two", "three", "four"]);
	const patch = attachViewportStability(h.tui);
	assert.equal(patch.active, true);

	h.render();
	assert.equal(h.tui.fullRedraws, 1);
	assert.equal(h.internals.previousViewportTop, 2);
	h.terminal.writes.length = 0;

	h.setLines(["\x1b[3mteammate · 38s\x1b[23m", "one", "two", "three", "four"]);
	h.render();
	assert.equal(h.tui.fullRedraws, 1, "timer-only churn above the viewport must not clear and replay scrollback");
	assert.equal(h.terminal.writes.some((value) => value.includes("\x1b[3J")), false);
	assert.equal(h.terminal.writes.some((value) => value.includes("teammate · 38s")), false);
	assert.ok(h.internals.previousLines[0]?.includes("teammate · 11s"), "the diff baseline must match terminal scrollback");
});

test("a hidden timer change does not block a visible differential update", () => {
	const h = renderHarness(["teammate · 11s", "one", "two", "three", "four"]);
	attachViewportStability(h.tui);
	h.render();
	h.terminal.writes.length = 0;

	h.setLines(["teammate · 38s", "one", "two", "three", "FOUR"]);
	h.render();
	assert.equal(h.tui.fullRedraws, 1);
	assert.equal(h.terminal.writes.some((value) => value.includes("\x1b[3J")), false);
	assert.equal(h.terminal.writes.some((value) => value.includes("teammate · 38s")), false);
	assert.equal(h.terminal.writes.some((value) => value.includes("FOUR")), true);
	assert.ok(h.internals.previousLines[0]?.startsWith("teammate · 11s\x1b[0m"));
	assert.ok(h.internals.previousLines[4]?.startsWith("FOUR\x1b[0m"));
});

test("a hidden non-timer change keeps the native full redraw", () => {
	const h = renderHarness(["teammate · running", "one", "two", "three", "four"]);
	attachViewportStability(h.tui);
	h.render();
	h.terminal.writes.length = 0;

	h.setLines(["teammate · completed", "one", "two", "three", "four"]);
	h.render();
	assert.equal(h.tui.fullRedraws, 2);
	assert.equal(h.terminal.writes.some((value) => value.includes("\x1b[3J")), true);
	assert.equal(h.terminal.writes.some((value) => value.includes("teammate · completed")), true);
});

test("visible Kitty image lines keep hidden changes in the native redraw path", () => {
	const image = "\x1b_Ga=T,f=100,r=1,i=1;image\x1b\\";
	const h = renderHarness(["zero", "one", image, "three", "four"]);
	attachViewportStability(h.tui);
	h.render();
	assert.equal(h.internals.previousViewportTop, 2);
	h.terminal.writes.length = 0;

	h.setLines(["ZERO", "ONE", image, "three", "four"]);
	h.render();
	assert.equal(h.tui.fullRedraws, 2);
	assert.equal(h.terminal.writes.some((value) => value.includes("\x1b[3J")), true);
	assert.ok(h.internals.previousLines[0]?.startsWith("ZERO\x1b[0m"));
	assert.ok(h.internals.previousLines[1]?.startsWith("ONE\x1b[0m"));
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
	assert.equal(h.tui.fullRedraws, 2, "dynamic references preserve the native hidden-line redraw");
	assert.equal(h.terminal.writes.some((value) => value.includes("\x1b[3J")), true);

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

test("dynamic TUI references preserve native redraws when the renderer instance changes", () => {
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
	assert.equal(second.tui.fullRedraws, 2);
	assert.equal(second.terminal.writes.some((value) => value.includes("\x1b[3J")), true);

	patch.detach();
});
