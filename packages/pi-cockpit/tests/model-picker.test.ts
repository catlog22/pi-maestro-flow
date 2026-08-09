import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ModelPicker, initialModelIndex, type ModelPickerEntry, type ModelPickerParams } from "../src/model-picker.ts";
import { cockpitTuiLocale } from "../src/tui-i18n.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { resolveGlyphs } from "../src/icons.ts";

cockpitTuiLocale.setLocale("en");

const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t } as unknown as Theme;
const glyphs = resolveGlyphs("nerd");

// Matches the entries index.ts builds: offline first, then the registry models
// as "provider/id", then the custom escape hatch.
const ENTRIES: ModelPickerEntry[] = [
	{ kind: "model", ref: "", label: "(rule-based)" },
	{ kind: "model", ref: "maestro-qwen/qwen3.8-max", label: "maestro-qwen/qwen3.8-max" },
	{ kind: "model", ref: "openai/gpt-5.5", label: "openai/gpt-5.5" },
	{ kind: "custom", label: "custom ref…" },
];

interface Harness {
	picker: ModelPicker;
	commits: string[];
	customs: number;
	closed: number;
}

function harness(over: Partial<ModelPickerParams> = {}): Harness {
	const commits: string[] = [];
	const state = { customs: 0, closed: 0 };
	const picker = new ModelPicker({
		entries: ENTRIES,
		initial: "",
		commit: (ref) => { commits.push(ref); },
		requestCustom: () => { state.customs++; },
		close: () => { state.closed++; },
		requestRender: () => {},
		getTerminalRows: () => 30,
		theme,
		glyphs,
		...over,
	});
	return {
		picker,
		commits,
		get customs() { return state.customs; },
		get closed() { return state.closed; },
	} as Harness;
}

test("initialModelIndex parks on the current ref and falls back to the first entry", () => {
	assert.equal(initialModelIndex(ENTRIES, "openai/gpt-5.5"), 2);
	assert.equal(initialModelIndex(ENTRIES, "maestro-qwen/qwen3.8-max"), 1);
	// The offline ref is stored as "" — parking on it means "(rule-based)".
	assert.equal(initialModelIndex(ENTRIES, ""), 0);
	// A ref that is no longer on the list (provider removed) lands on rule-based.
	assert.equal(initialModelIndex(ENTRIES, "gone/model"), 0);
	assert.equal(initialModelIndex([], "a"), 0);
});

test("opening parks the cursor on the current ref, visible in the render", () => {
	const h = harness({ initial: "openai/gpt-5.5" });
	const rendered = h.picker.render(40).join("\n");
	assert.match(rendered, /openai\/gpt-5\.5/);
	assert.match(rendered, /\(rule-based\)/);
	assert.match(rendered, /custom ref…/);
});

test("Enter commits the selected ref and closes", () => {
	const h = harness({ initial: "openai/gpt-5.5" });
	h.picker.handleInput("\r");
	assert.deepEqual(h.commits, ["openai/gpt-5.5"]);
	assert.equal(h.closed, 1);
});

test("the rule-based entry commits the empty ref, restoring the offline extractor", () => {
	const h = harness({ initial: "openai/gpt-5.5" });
	h.picker.handleInput("\x1b[A"); // up from openai/gpt-5.5 → maestro-qwen
	h.picker.handleInput("\x1b[A"); // up again → (rule-based)
	h.picker.handleInput("\r");
	assert.deepEqual(h.commits, [""]);
	assert.equal(h.closed, 1);
});

test("the custom entry asks for the text editor instead of committing a ref", () => {
	const h = harness();
	h.picker.handleInput("\x1b[B");
	h.picker.handleInput("\x1b[B");
	h.picker.handleInput("\x1b[B"); // down to custom ref…
	h.picker.handleInput("\r");
	assert.deepEqual(h.commits, [], "custom must not write a bogus ref");
	assert.equal(h.customs, 1);
	assert.equal(h.closed, 1, "the picker closes and lets the caller open the editor");
});

test("Esc cancels without committing", () => {
	const h = harness({ initial: "openai/gpt-5.5" });
	h.picker.handleInput("\x1b[B");
	h.picker.handleInput("\x1b");
	assert.deepEqual(h.commits, []);
	assert.equal(h.closed, 1);
});

test("navigation wraps at both ends and home/end jump", () => {
	const h = harness({ initial: "" });
	h.picker.handleInput("\x1b[A"); // up from (rule-based) → wraps to custom ref…
	assert.equal(h.customs, 0, "moving must not trigger the custom hand-off");
	h.picker.handleInput("\x1b[B"); // down → (rule-based)
	h.picker.handleInput("\x1b[5~"); // page up from the first entry → wraps upward
	h.picker.handleInput("\x1b[H"); // home → (rule-based)
	h.picker.handleInput("\x1b[F"); // end → custom ref…
	h.picker.handleInput("\x1b[B"); // down → wraps to (rule-based)
	h.picker.handleInput("\r");
	assert.deepEqual(h.commits, [""]);
});

test("plain letters are inert, per the letter-shortcut/filter-mode separation", () => {
	const h = harness({ initial: "openai/gpt-5.5" });
	for (const key of ["j", "k", "z", "q"]) h.picker.handleInput(key);
	assert.deepEqual(h.commits, []);
	assert.equal(h.closed, 0);
});

test("an empty model list renders and stays inert instead of throwing", () => {
	const h = harness({ entries: [] });
	assert.doesNotThrow(() => h.picker.render(40));
	assert.match(h.picker.render(40).join("\n"), /no models registered/);
	assert.doesNotThrow(() => h.picker.handleInput("\x1b[B"));
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
	const dirty: ModelPickerEntry[] = [
		{ kind: "model", ref: "", label: "(rule-based)" },
		{ kind: "model", ref: "p/m", label: "a\nb" },
		{ kind: "model", ref: "p/m2", label: "c\x1b[2Jd" },
	];
	const h = harness({ entries: dirty });
	for (const line of h.picker.render(40)) {
		// ESC is legitimate here (colour codes), but a bare newline or carriage
		// return would break the card open regardless of any width assertion.
		assert.doesNotMatch(line, /[\n\r]/);
	}
});
