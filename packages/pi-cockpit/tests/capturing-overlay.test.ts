import { test } from "node:test";
import assert from "node:assert/strict";
import type { TUI } from "@earendil-works/pi-tui";
import { ambientKeysShouldYield, capturingOverlayVisible, customComponentCapturesInput } from "../src/capturing-overlay.ts";

interface StackEntry {
	hidden?: boolean;
	options?: {
		nonCapturing?: boolean;
		visible?: (width: number, height: number) => boolean;
	};
}

function tuiWith(stack: StackEntry[] | undefined, hasOverlay = true): TUI {
	return {
		hasOverlay: () => hasOverlay,
		terminal: { columns: 120, rows: 40 },
		...(stack !== undefined ? { overlayStack: stack } : {}),
	} as unknown as TUI;
}

test("capturingOverlayVisible: undefined tui is not capturing", () => {
	assert.equal(capturingOverlayVisible(undefined), false);
});

test("capturingOverlayVisible: mocked TUI without overlay support is not capturing", () => {
	const mock = {} as unknown as TUI;
	assert.equal(capturingOverlayVisible(mock), false);
});

test("capturingOverlayVisible: no visible overlay is not capturing", () => {
	assert.equal(capturingOverlayVisible(tuiWith([])), false);
	assert.equal(capturingOverlayVisible(tuiWith([], false)), false);
});

test("capturingOverlayVisible: a visible non-capturing overlay alone is not capturing (dock sidebar case)", () => {
	assert.equal(capturingOverlayVisible(tuiWith([
		{ hidden: false, options: { nonCapturing: true } },
	])), false);
});

test("capturingOverlayVisible: hidden and out-of-view overlays are ignored", () => {
	assert.equal(capturingOverlayVisible(tuiWith([
		{ hidden: true, options: {} },
		{ hidden: false, options: { visible: () => false } },
	])), false);
});

test("capturingOverlayVisible: a visible capturing overlay is capturing even alongside the sidebar", () => {
	assert.equal(capturingOverlayVisible(tuiWith([
		{ hidden: false, options: { nonCapturing: true } },
		{ hidden: false, options: {} },
	])), true);
});

test("capturingOverlayVisible: unknown internals defer conservatively", () => {
	// No overlayStack field readable: assume a capturing overlay may be up.
	assert.equal(capturingOverlayVisible(tuiWith(undefined)), true);
});

test("customComponentCapturesInput: undefined tui or no focused component is false", () => {
	assert.equal(customComponentCapturesInput(undefined), false);
	const tui = { focusedComponent: null } as unknown as TUI;
	assert.equal(customComponentCapturesInput(tui), false);
});

test("customComponentCapturesInput: the built-in editor is not a custom component", () => {
	const editor = { handleInput() {}, getText() { return ""; }, setText() {} };
	const tui = { focusedComponent: editor } as unknown as TUI;
	assert.equal(customComponentCapturesInput(tui), false);
	// getExpandedText fallback also identifies the editor.
	const editorExpanded = { handleInput() {}, getExpandedText() { return ""; } };
	assert.equal(customComponentCapturesInput({ focusedComponent: editorExpanded } as unknown as TUI), false);
});

test("customComponentCapturesInput: a component without the editor text API is custom (ask wizard case)", () => {
	const wizard = { render() { return []; }, handleInput() {} };
	const tui = { focusedComponent: wizard } as unknown as TUI;
	assert.equal(customComponentCapturesInput(tui), true);
});

test("customComponentCapturesInput: components without handleInput do not capture", () => {
	const passive = { render() { return []; } };
	const tui = { focusedComponent: passive } as unknown as TUI;
	assert.equal(customComponentCapturesInput(tui), false);
});

test("ambientKeysShouldYield: true for a capturing overlay or a focused custom component", () => {
	const overlayTui = tuiWith([{ hidden: false, options: {} }]);
	assert.equal(ambientKeysShouldYield(overlayTui), true);
	const wizardTui = { focusedComponent: { handleInput() {} } } as unknown as TUI;
	assert.equal(ambientKeysShouldYield(wizardTui), true);
});

test("ambientKeysShouldYield: false on a plain empty-composer surface", () => {
	const plain = tuiWith([]);
	assert.equal(ambientKeysShouldYield(plain), false);
	const dockOnly = tuiWith([{ hidden: false, options: { nonCapturing: true } }]);
	assert.equal(ambientKeysShouldYield(dockOnly), false);
	const editorFocused = { focusedComponent: { handleInput() {}, getText() { return ""; } } } as unknown as TUI;
	assert.equal(ambientKeysShouldYield(editorFocused), false);
});
