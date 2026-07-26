import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ThemePicker, activeThemeName, initialIndex, type ThemePickerParams } from "../src/theme-picker.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { resolveGlyphs } from "../src/icons.ts";

const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t } as unknown as Theme;
const glyphs = resolveGlyphs("nerd");

interface Harness {
	picker: ThemePicker;
	previews: unknown[];
	commits: string[];
	closed: number;
}

function harness(over: Partial<ThemePickerParams> = {}, themes = ["dark", "light", "nord"]): Harness {
	const previews: unknown[] = [];
	const commits: string[] = [];
	const state = { closed: 0 };
	// Distinct sentinel per name so a preview can be traced back to its source.
	const instances = new Map(themes.map((name) => [name, { name } as unknown as Theme]));
	const original = { name: "ORIGINAL" } as unknown as Theme;
	const picker = new ThemePicker({
		themes,
		initial: "",
		original,
		loadTheme: (name) => instances.get(name),
		previewTheme: (t) => { previews.push(t); },
		commitTheme: (name) => { commits.push(name); return { success: true }; },
		close: () => { state.closed++; },
		requestRender: () => {},
		getTerminalRows: () => 30,
		theme,
		glyphs,
		...over,
	});
	return {
		picker,
		previews,
		commits,
		get closed() { return state.closed; },
	} as Harness;
}

test("initialIndex falls back to the first entry for an unknown name", () => {
	assert.equal(initialIndex(["a", "b"], "b"), 1);
	assert.equal(initialIndex(["a", "b"], "gone"), 0);
	assert.equal(initialIndex([], "a"), 0);
});

test("opening previews immediately, so the picker demonstrates itself", () => {
	const h = harness();
	assert.equal(h.previews.length, 1);
	assert.deepEqual(h.previews[0], { name: "dark" });
});

test("scrolling previews but never commits — this is what keeps pi's settings intact", () => {
	const h = harness();
	h.picker.handleInput("\x1b[B");
	h.picker.handleInput("\x1b[B");
	assert.deepEqual(h.previews.map((p) => (p as { name: string }).name), ["dark", "light", "nord"]);
	assert.deepEqual(h.commits, [], "preview must not write through to pi's settings");
});

test("Esc restores the theme that was live on open and commits nothing", () => {
	const h = harness();
	h.picker.handleInput("\x1b[B");
	h.picker.handleInput("\x1b");
	assert.deepEqual(h.previews.at(-1), { name: "ORIGINAL" });
	assert.deepEqual(h.commits, []);
	assert.equal(h.closed, 1);
});

test("Enter is the only key that persists", () => {
	const h = harness();
	h.picker.handleInput("\x1b[B");
	h.picker.handleInput("\r");
	assert.deepEqual(h.commits, ["light"]);
	assert.equal(h.closed, 1);
});

test("a failed commit keeps the picker open so the choice is not lost", () => {
	const h = harness({ commitTheme: () => ({ success: false, error: "disk full" }) });
	h.picker.handleInput("\r");
	assert.equal(h.closed, 0);
	assert.match(h.picker.render(40).join("\n"), /disk full/);
});

test("plain letters are inert, per the letter-shortcut/filter-mode separation", () => {
	const h = harness();
	const before = h.previews.length;
	for (const key of ["j", "k", "d", "n", "q"]) h.picker.handleInput(key);
	assert.equal(h.previews.length, before);
	assert.deepEqual(h.commits, []);
	assert.equal(h.closed, 0);
});

test("navigation wraps at both ends", () => {
	const h = harness();
	h.picker.handleInput("\x1b[A");
	assert.deepEqual(h.previews.at(-1), { name: "nord" }, "up from the first entry wraps to the last");
	h.picker.handleInput("\x1b[B");
	assert.deepEqual(h.previews.at(-1), { name: "dark" });
});

test("an empty theme list renders and stays inert instead of throwing", () => {
	const h = harness({}, []);
	assert.doesNotThrow(() => h.picker.render(40));
	assert.match(h.picker.render(40).join("\n"), /no themes registered/);
	assert.doesNotThrow(() => h.picker.handleInput("\x1b[B"));
	// Enter with nothing to pick must not commit an empty name.
	h.picker.handleInput("\r");
	assert.deepEqual(h.commits, []);
});

test("render never exceeds the requested width", () => {
	const h = harness();
	for (const width of [10, 20, 40, 80, 120]) {
		for (const line of h.picker.render(width)) {
			// visibleWidth, not .length: truncateToWidth emits real reset sequences,
			// so UTF-16 length overcounts and would fail a correct render.
			assert.ok(visibleWidth(line) <= width, `width ${width}: "${line}"`);
		}
	}
});

test("no rendered line smuggles a control character into the frame", () => {
	const h = harness({}, ["dark", "a\nb", "c\x1b[2Jd"]);
	for (const line of h.picker.render(40)) {
		// ESC is legitimate here (colour codes), but a bare newline or carriage
		// return would break the card open regardless of any width assertion.
		assert.doesNotMatch(line, /[\n\r]/);
	}
});

test("activeThemeName reads through a Proxy, which is what pi actually hands over", () => {
	// pi exports `theme` as a Proxy onto globalThis, so .name is a live reading
	// rather than a snapshot. This is the only reader of the current theme the
	// extension API leaves us, so it has to survive that shape.
	let current = { name: "nord" };
	const proxy = new Proxy({}, { get: (_t, p) => (current as Record<string, unknown>)[p as string] });
	assert.equal(activeThemeName(proxy as unknown as Theme), "nord");
	current = { name: "gruvbox" };
	assert.equal(activeThemeName(proxy as unknown as Theme), "gruvbox");
});

test("activeThemeName refuses anything it cannot hand back to getTheme", () => {
	const as = (v: unknown) => activeThemeName(v as Theme);
	assert.equal(as({}), undefined);
	assert.equal(as({ name: "" }), undefined);
	assert.equal(as({ name: 42 }), undefined);
	// pi's Proxy throws outright before initTheme() has run.
	const uninitialised = new Proxy({}, { get: () => { throw new Error("Theme not initialized"); } });
	assert.equal(as(uninitialised), undefined);
});

test("without a real original instance the picker refuses to preview at all", () => {
	// Regression: `original` used to be pi's exported `theme`, a Proxy that reads
	// from the very global slot setThemeInstance writes to. Cancelling stored the
	// Proxy into itself and the next colour lookup recursed until the stack blew.
	// Rather than preview into a state it cannot leave, the picker does not start.
	const h = harness({ original: undefined });
	assert.deepEqual(h.previews, []);
	h.picker.handleInput("\x1b[B");
	assert.deepEqual(h.previews, [], "scrolling must not apply a theme it cannot undo");
	h.picker.handleInput("\x1b");
	assert.deepEqual(h.previews, [], "cancel has nothing to restore and must not invent one");
	assert.equal(h.closed, 1);
});

test("with preview off the footer stops promising a preview and a revert", () => {
	const lines = harness({ original: undefined }).picker.render(60);
	const hints = lines.find((line) => /Enter/.test(line))!;
	assert.match(hints, /↑↓ move · Enter apply · Esc close/);
	// The whole point: no key here previews, and Esc reverts nothing.
	assert.doesNotMatch(hints, /preview|revert/);
	// Enter still persists, so the degradation is stated rather than left to guess.
	assert.ok(lines.some((line) => /no preview/.test(line)));
});

test("Enter still persists when preview is unavailable", () => {
	const h = harness({ original: undefined });
	h.picker.handleInput("\x1b[B");
	h.picker.handleInput("\r");
	assert.deepEqual(h.commits, ["light"]);
});

test("the footer names the key that writes, not just the keys that move", () => {
	const h = harness();
	const out = h.picker.render(60).join("\n");
	assert.match(out, /Enter save/);
	assert.match(out, /Esc revert/);
	// The one thing this picker cannot do must point at the thing that can.
	assert.match(out, /\/settings/);
});
