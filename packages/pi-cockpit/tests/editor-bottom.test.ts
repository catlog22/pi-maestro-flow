import assert from "node:assert/strict";
import test from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import {
	COCKPIT_EDITOR_BOTTOM_MARKER,
	createEditorBottomController,
	createEditorBottomSentinel,
} from "../src/editor-bottom.ts";

function harness(rows = 10, content?: string[]) {
	const marker = createEditorBottomSentinel().render(80)[0]!;
	let renderRequests = 0;
	const terminal = { rows, columns: 100 };
	const baseRender = (() => content ?? ["chat", marker, "editor", "footer"]) as TUI["render"];
	const tui = {
		terminal,
		render: baseRender,
		requestRender: () => { renderRequests++; },
	} as unknown as TUI;
	return { tui, terminal, marker, baseRender, renders: () => renderRequests };
}

test("editor-bottom sentinel is invisible content owned by one widget row", () => {
	const component = createEditorBottomSentinel();
	const lines = component.render(80);
	assert.equal(lines.length, 1);
	assert.ok(lines[0]);
});

test("enabled editor-bottom layout inserts elastic space before the editor block", () => {
	const state = harness(10);
	const controller = createEditorBottomController();
	controller.attach(state.tui);
	controller.show();
	const rendered = state.tui.render(100);
	assert.equal(rendered.length, 10);
	assert.equal(rendered[0], "chat");
	assert.equal(rendered[8], "editor");
	assert.equal(rendered[9], "footer");
	assert.ok(rendered.slice(1, 8).every((line) => line === ""));
	assert.equal(rendered.some((line) => line.includes(state.marker)), false);
});

test("hide removes padding immediately and live terminal height controls the next render", () => {
	const state = harness(8);
	const controller = createEditorBottomController();
	controller.attach(state.tui);
	controller.show();
	assert.equal(state.tui.render(100).length, 8);
	state.terminal.rows = 12;
	assert.equal(state.tui.render(100).length, 12);
	controller.hide();
	assert.deepEqual(state.tui.render(100), ["chat", "editor", "footer"]);
});

test("content taller than the viewport is never truncated or padded", () => {
	const marker = createEditorBottomSentinel().render(80)[0]!;
	const content = ["one", "two", "three", "four", marker, "editor", "footer"];
	const state = harness(5, content);
	const controller = createEditorBottomController();
	controller.attach(state.tui);
	controller.show();
	assert.deepEqual(state.tui.render(100), ["one", "two", "three", "four", "editor", "footer"]);
});

test("duplicate attachment is rejected and exact restore preserves later render replacements", () => {
	const state = harness();
	const first = createEditorBottomController();
	const second = createEditorBottomController();
	first.attach(state.tui);
	assert.ok((state.tui.render as TUI["render"] & Record<symbol, unknown>)[COCKPIT_EDITOR_BOTTOM_MARKER]);
	assert.throws(() => second.attach(state.tui), /already attached/);

	const replacement = ((width: number) => [`replacement:${width}`]) as TUI["render"];
	state.tui.render = replacement;
	first.dispose();
	assert.equal(state.tui.render, replacement);
});

test("dispose restores the exact original renderer and is idempotent", () => {
	const state = harness();
	const controller = createEditorBottomController();
	controller.attach(state.tui);
	controller.show();
	assert.notEqual(state.tui.render, state.baseRender);
	controller.dispose();
	assert.equal(state.tui.render, state.baseRender);
	controller.dispose();
	assert.equal(state.tui.render, state.baseRender);
});
