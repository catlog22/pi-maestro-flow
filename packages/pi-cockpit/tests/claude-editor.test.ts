import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
	CockpitClaudeEditor,
	DoubleEscapeGate,
	EDITOR_END_SENTINEL,
	EDITOR_START_SENTINEL,
	createCockpitClaudeEditorFactory,
	type CockpitClaudeEditorOptions,
} from "../src/claude-editor.ts";

function fakeEnvironment(): { tui: TUI; theme: EditorTheme; keybindings: KeybindingsManager } {
	return {
		tui: { terminal: { rows: 20 }, requestRender() {} } as unknown as TUI,
		theme: { borderColor: (s: string) => s } as unknown as EditorTheme,
		keybindings: { matches: () => false } as unknown as KeybindingsManager,
	};
}

function makeEditor(options: CockpitClaudeEditorOptions) {
	const { tui, theme, keybindings } = fakeEnvironment();
	return new CockpitClaudeEditor(tui, theme, keybindings, options);
}

// isShowingAutocomplete is public on Editor, so a test subclass can stub it to
// exercise the autocomplete-active path through the real handleInput routing.
class AutocompleteStubEditor extends CockpitClaudeEditor {
	autocompleteOn = false;
	override isShowingAutocomplete(): boolean {
		return this.autocompleteOn;
	}
}

// --- Pure DoubleEscapeGate state machine -------------------------------------

const PASS = { consumed: false, reset: false };
const RESET = { consumed: false, reset: true };
const CONSUMED = { consumed: true, reset: false };

test("double escape gate: two bare Escapes on a non-empty idle draft clear", () => {
	const gate = new DoubleEscapeGate();
	const idle = { autocomplete: "inactive", busy: false, textEmpty: false } as const;
	assert.deepEqual(gate.onEscape(idle), PASS);
	assert.deepEqual(gate.onEscape(idle), CONSUMED);
});

test("double escape gate: first Escape always passes through and never clears", () => {
	const gate = new DoubleEscapeGate();
	const idle = { autocomplete: "inactive", busy: false, textEmpty: false } as const;
	assert.deepEqual(gate.onEscape(idle), PASS);
	assert.deepEqual(gate.onEscape(idle), CONSUMED); // second is the only consumer
});

test("double escape gate: empty draft never arms", () => {
	const gate = new DoubleEscapeGate();
	const empty = { autocomplete: "inactive", busy: false, textEmpty: true } as const;
	assert.deepEqual(gate.onEscape(empty), RESET);
	assert.deepEqual(gate.onEscape(empty), RESET);
});

test("double escape gate: busy/streaming resets the arm", () => {
	const gate = new DoubleEscapeGate();
	const idle = { autocomplete: "inactive", busy: false, textEmpty: false } as const;
	const busy = { autocomplete: "inactive", busy: true, textEmpty: false } as const;
	assert.deepEqual(gate.onEscape(idle), PASS); // arm
	assert.deepEqual(gate.onEscape(busy), RESET); // busy cancels
	assert.deepEqual(gate.onEscape(busy), RESET); // still no arm while busy
});

test("double escape gate: active autocomplete resets the arm (Esc cancels it)", () => {
	const gate = new DoubleEscapeGate();
	const idle = { autocomplete: "inactive", busy: false, textEmpty: false } as const;
	const active = { autocomplete: "active", busy: false, textEmpty: false } as const;
	assert.deepEqual(gate.onEscape(idle), PASS); // arm
	assert.deepEqual(gate.onEscape(active), RESET); // autocomplete Esc resets
	assert.deepEqual(gate.onEscape(idle), PASS); // re-arm
	assert.deepEqual(gate.onEscape(idle), CONSUMED); // clears
});

test("double escape gate: probe failure fails open and never clears", () => {
	const gate = new DoubleEscapeGate();
	const unknown = { autocomplete: "unknown", busy: false, textEmpty: false } as const;
	assert.deepEqual(gate.onEscape(unknown), RESET);
	assert.deepEqual(gate.onEscape(unknown), RESET);
});

test("double escape gate: window expiry re-arms instead of clearing", () => {
	let fakeNow = 1000;
	const gate = new DoubleEscapeGate(500, () => fakeNow);
	const idle = { autocomplete: "inactive", busy: false, textEmpty: false } as const;
	assert.deepEqual(gate.onEscape(idle), PASS); // arm at t=1000
	fakeNow = 1600; // 600ms later: window expired
	assert.deepEqual(gate.onEscape(idle), PASS); // re-arms, does not clear
	fakeNow = 1601;
	assert.deepEqual(gate.onEscape(idle), CONSUMED); // within new window
});

test("double escape gate: any other input between the pair cancels it", () => {
	const gate = new DoubleEscapeGate();
	const idle = { autocomplete: "inactive", busy: false, textEmpty: false } as const;
	assert.deepEqual(gate.onEscape(idle), PASS); // arm
	gate.onAnyOtherInput(); // a typed character
	assert.deepEqual(gate.onEscape(idle), PASS); // re-arm, not consumed
});

// --- CockpitClaudeEditor instance -------------------------------------------

test("editor: double Escape clears a non-empty draft; single Escape does not", () => {
	const editor = makeEditor({ doubleEscapeClearInput: true, emitEditorMarkers: false });
	editor.setText("hello");
	editor.handleInput("\x1b");
	assert.equal(editor.getText(), "hello", "first Escape must not clear");
	editor.handleInput("\x1b");
	assert.equal(editor.getText(), "", "second Escape clears the draft");
});

test("editor: empty-draft double Escape passes through without clearing", () => {
	const editor = makeEditor({ doubleEscapeClearInput: true, emitEditorMarkers: false });
	editor.setText("");
	editor.handleInput("\x1b");
	editor.handleInput("\x1b");
	assert.equal(editor.getText(), "");
});

test("editor: streaming/busy guard disables clearing", () => {
	const editor = makeEditor({ doubleEscapeClearInput: true, emitEditorMarkers: false, isBusy: () => true });
	editor.setText("draft");
	editor.handleInput("\x1b");
	editor.handleInput("\x1b");
	assert.equal(editor.getText(), "draft");
});

test("editor: autocomplete Esc passes through and resets the arm", () => {
	const { tui, theme, keybindings } = fakeEnvironment();
	const editor = new AutocompleteStubEditor(tui, theme, keybindings, {
		doubleEscapeClearInput: true,
		emitEditorMarkers: false,
	});
	editor.setText("draft");
	editor.autocompleteOn = true;
	editor.handleInput("\x1b"); // cancels autocomplete, must not arm
	editor.autocompleteOn = false;
	editor.handleInput("\x1b"); // re-arms
	assert.equal(editor.getText(), "draft");
	editor.handleInput("\x1b"); // clears
	assert.equal(editor.getText(), "");
});

test("editor: kitty key-release Escape never counts toward the pair", () => {
	const editor = makeEditor({ doubleEscapeClearInput: true, emitEditorMarkers: false });
	editor.setText("draft");
	editor.handleInput("\x1b[27;1;27:3u"); // release — ignored, resets
	editor.handleInput("\x1b[27;1;27:3u"); // release — ignored
	assert.equal(editor.getText(), "draft");
	editor.handleInput("\x1b"); // press 1
	editor.handleInput("\x1b"); // press 2 — clears
	assert.equal(editor.getText(), "");
});

test("editor: non-Escape input between the pair cancels it", () => {
	const editor = makeEditor({ doubleEscapeClearInput: true, emitEditorMarkers: false });
	editor.setText("draft");
	editor.handleInput("\x1b"); // arm
	editor.handleInput("x"); // typed character cancels the arm AND appends to the draft
	assert.equal(editor.getText(), "draftx");
	editor.handleInput("\x1b"); // re-arms (pair was broken) — must NOT clear
	assert.equal(editor.getText(), "draftx");
	editor.handleInput("\x1b"); // second Escape after re-arm clears
	assert.equal(editor.getText(), "");
});

test("editor: render emits markers only when fullscreen is active", () => {
	const plain = makeEditor({ doubleEscapeClearInput: false, emitEditorMarkers: false });
	const plainLines = plain.render(40);
	assert.equal(plainLines.some((line) => line.includes(EDITOR_START_SENTINEL)), false);
	assert.equal(plainLines.some((line) => line.includes(EDITOR_END_SENTINEL)), false);

	const fullscreen = makeEditor({ doubleEscapeClearInput: false, emitEditorMarkers: true });
	const lines = fullscreen.render(40);
	assert.equal(lines[0], EDITOR_START_SENTINEL);
	assert.equal(lines[lines.length - 1], EDITOR_END_SENTINEL);
	assert.ok(lines.length >= 3, "markers surround real editor lines");
});

test("factory builds a working CockpitClaudeEditor", () => {
	const factory = createCockpitClaudeEditorFactory({ doubleEscapeClearInput: true, emitEditorMarkers: false });
	const { tui, theme, keybindings } = fakeEnvironment();
	const editor = factory(tui, theme, keybindings);
	assert.ok(editor instanceof CockpitClaudeEditor);
	editor.setText("hi");
	editor.handleInput("\x1b");
	editor.handleInput("\x1b");
	assert.equal(editor.getText(), "");
});

test("editor: onClear fires once when the draft is cleared", () => {
	let clears = 0;
	const editor = makeEditor({ doubleEscapeClearInput: true, emitEditorMarkers: false, onClear: () => { clears++; } });
	editor.setText("draft");
	editor.handleInput("\x1b");
	editor.handleInput("\x1b");
	assert.equal(clears, 1);
});

test("editor: double-Escape and markers coexist (both features on)", () => {
	const editor = makeEditor({ doubleEscapeClearInput: true, emitEditorMarkers: true });
	editor.setText("draft");
	editor.handleInput("\x1b");
	editor.handleInput("\x1b");
	assert.equal(editor.getText(), "", "double-Escape clears even with markers emitted");
	const lines = editor.render(40);
	assert.equal(lines[0], EDITOR_START_SENTINEL);
	assert.equal(lines[lines.length - 1], EDITOR_END_SENTINEL);
});
