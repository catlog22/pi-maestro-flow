import { test } from "node:test";
import assert from "node:assert/strict";
import type { TUI } from "@earendil-works/pi-tui";
import { capturingOverlayVisible } from "../src/capturing-overlay.ts";

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
