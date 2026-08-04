import assert from "node:assert/strict";
import test from "node:test";
import { createTranscriptSelectionController, type TranscriptSelectionController } from "../src/transcript-selection.ts";

interface SelectionHarness {
	controller: TranscriptSelectionController;
	setEnabled(enabled: boolean): void;
	setLines(lines: string[]): void;
	readonly copied: string | null;
	setCopyError(error: Error | null): void;
	readonly notifications: string[];
}

function makeSelection(height = 15): SelectionHarness {
	let enabled = true;
	let lines: string[] = [];
	let copied: string | null = null;
	let copyError: Error | null = null;
	const notifications: string[] = [];
	const controller = createTranscriptSelectionController({
		isEnabled: () => enabled,
		getTranscriptHeight: () => height,
		getViewportLines: () => lines,
		notify: (message, level) => {
			notifications.push(`${level}: ${message}`);
		},
		copy: async (text) => {
			if (copyError) throw copyError;
			copied = text;
		},
		onError: () => {},
	});
	return {
		controller,
		setEnabled(value) {
			enabled = value;
		},
		setLines(next) {
			lines = next;
		},
		get copied() {
			return copied;
		},
		setCopyError(error) {
			copyError = error;
		},
		notifications,
	};
}

// SGR coords are 1-indexed terminal cells.
async function drag(harness: SelectionHarness, from: [number, number], to: [number, number]): Promise<boolean> {
	harness.controller.press(from[0], from[1]);
	harness.controller.motion(to[0], to[1]);
	return harness.controller.release(to[0], to[1]);
}

test("ascii multi-line selection copies the selected rows joined by newline", async () => {
	const harness = makeSelection();
	harness.setLines(["alpha", "beta", "gamma"]);
	const attempted = await drag(harness, [1, 1], [6, 3]);
	assert.equal(attempted, true);
	assert.equal(harness.copied, "alpha\nbeta\ngamma");
});

test("partial-column selection copies only the selected cells", async () => {
	const harness = makeSelection();
	harness.setLines(["hello world"]);
	await drag(harness, [1, 1], [6, 1]);
	assert.equal(harness.copied, "hello");
});

test("ANSI colors are stripped from the copied text", async () => {
	const harness = makeSelection();
	harness.setLines(["\x1b[31mred\x1b[0m text"]);
	await drag(harness, [1, 1], [9, 1]); // cols 0..8 covers "red text"
	assert.equal(harness.copied, "red text");
});

test("OSC hyperlink URL is excluded from the copied text", async () => {
	const harness = makeSelection();
	harness.setLines(["\x1b]8;;https://example.com\x07link\x1b]8;;\x07"]);
	await drag(harness, [1, 1], [5, 1]);
	assert.equal(harness.copied, "link");
	assert.ok(!harness.copied!.includes("https"));
});

test("CJK wide characters select by visible cells, not string indices", async () => {
	const harness = makeSelection();
	harness.setLines(["你好世界"]); // visible width 8
	await drag(harness, [3, 1], [6, 1]); // cols 2..5 -> "好世"
	assert.equal(harness.copied, "好世");
});

test("emoji with modifiers copy as a whole grapheme", async () => {
	const harness = makeSelection();
	harness.setLines(["👍🏽 done"]);
	await drag(harness, [1, 1], [9, 1]);
	assert.equal(harness.copied, "👍🏽 done");
});

test("combining characters keep their base+mark sequence", async () => {
	const harness = makeSelection();
	harness.setLines(["cafe\u0301"]); // e + combining acute
	await drag(harness, [1, 1], [5, 1]);
	assert.equal(harness.copied, "cafe\u0301");
});

test("wrapped logical lines are copied row by row", async () => {
	const harness = makeSelection();
	harness.setLines(["This is a long line that wrap", "s across two visible rows"]);
	await drag(harness, [1, 1], [30, 2]);
	assert.equal(harness.copied, "This is a long line that wrap\ns across two visible rows");
});

test("selection never starts in the editor/chrome region (beyond the transcript)", async () => {
	const harness = makeSelection(15);
	harness.setLines(["alpha", "beta"]);
	harness.controller.press(5, 16); // below the transcript viewport
	harness.controller.motion(6, 17);
	const attempted = await harness.controller.release(6, 17);
	assert.equal(attempted, false);
	assert.equal(harness.copied, null);
});

test("a plain click (no drag) does not copy", async () => {
	const harness = makeSelection();
	harness.setLines(["alpha", "beta"]);
	const attempted = await drag(harness, [2, 1], [2, 1]);
	assert.equal(attempted, false);
	assert.equal(harness.copied, null);
});

test("clipboard failure warns and keeps the selection", async () => {
	const harness = makeSelection();
	harness.setLines(["alpha", "beta"]);
	harness.setCopyError(new Error("no clipboard"));
	const attempted = await drag(harness, [1, 1], [6, 2]);
	assert.equal(attempted, true);
	assert.equal(harness.copied, null);
	assert.ok(harness.notifications.some((message) => message.startsWith("warning: Copy failed")), "warns on failure");
	assert.equal(harness.controller.isSelecting(), true, "selection retained after failure");
});

test("copy disabled ignores drags entirely", async () => {
	const harness = makeSelection();
	harness.setLines(["alpha", "beta"]);
	harness.setEnabled(false);
	const attempted = await drag(harness, [1, 1], [6, 2]);
	assert.equal(attempted, false);
	assert.equal(harness.copied, null);
	assert.equal(harness.controller.isSelecting(), false);
});

test("highlight marks selected rows with reverse video and leaves others alone", () => {
	const harness = makeSelection();
	harness.setLines(["alpha", "beta", "gamma"]);
	harness.controller.press(1, 1);
	harness.controller.motion(6, 2);
	assert.ok(harness.controller.highlight("alpha", 0).includes("\x1b[7m"), "first selected row highlighted");
	assert.ok(harness.controller.highlight("beta", 1).includes("\x1b[7m"), "second selected row highlighted");
	assert.equal(harness.controller.highlight("gamma", 2), "gamma", "unselected row untouched");
});

test("clear cancels the selection and removes the highlight", () => {
	const harness = makeSelection();
	harness.setLines(["alpha", "beta"]);
	harness.controller.press(1, 1);
	harness.controller.motion(6, 2);
	assert.equal(harness.controller.isSelecting(), true);
	harness.controller.clear();
	assert.equal(harness.controller.isSelecting(), false);
	assert.equal(harness.controller.highlight("alpha", 0), "alpha");
});
