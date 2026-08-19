import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TodoOverlay } from "../src/todo-overlay.ts";
import { cockpitTuiLocale } from "../src/tui-i18n.ts";
import { resolveGlyphs } from "../src/icons.ts";
import type { TodoItem } from "../src/types.ts";

cockpitTuiLocale.setLocale("en");

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
} as Theme;

function todo(id: string, status: TodoItem["status"], overrides: Partial<TodoItem> = {}): TodoItem {
	return {
		id,
		subject: `task ${id}`,
		status,
		blockedBy: [],
		skills: [],
		...overrides,
	};
}

function overlay(todos: TodoItem[]) {
	let renders = 0;
	let closes = 0;
	const component = new TodoOverlay({
		getTodos: () => todos,
		requestRender: () => { renders++; },
		close: () => { closes++; },
		theme,
		glyphs: resolveGlyphs("nerd"),
	});
	return { component, counts: () => ({ renders, closes }) };
}

test("empty overlay shows the empty state and Esc closes", () => {
	const { component, counts } = overlay([]);
	const lines = component.render(100);
	assert.match(lines.join("\n"), /no todo tasks/);
	component.handleInput("\x1b");
	assert.equal(counts().closes, 1);
});

test("wide center lists todos in status order and shows selected details", () => {
	const { component } = overlay([
		todo("1", "in_progress"),
		todo("2", "blocked"),
		todo("3", "pending"),
		todo("0", "completed"),
	]);
	const text = component.render(120).join("\n");
	assert.match(text, /Todo · 4 total/);
	assert.match(text, /1 running/);
	assert.match(text, /1 blocked/);
	// pending ranks above blocked, so task 3 precedes task 2 in the list.
	assert.ok(text.indexOf("task 3") < text.indexOf("task 2"), "pending sorts before blocked");
	assert.ok(text.indexOf("task 1") < text.indexOf("task 3"), "in_progress sorts first");
	assert.match(text, /ID/);
	assert.match(text, /Status/);
});

test("Enter opens detail and Esc returns before closing", () => {
	const { component, counts } = overlay([todo("1", "in_progress"), todo("2", "pending")]);
	component.handleInput("\r");
	const detail = component.render(100).join("\n");
	assert.match(detail, /Blocked by|Status|ID/);
	component.handleInput("\x1b");
	assert.equal(counts().closes, 0);
	assert.match(component.render(100).join("\n"), /Enter detail/);
	component.handleInput("\x1b");
	assert.equal(counts().closes, 1);
});

test("keyboard navigation moves the selection marker", () => {
	const { component } = overlay([todo("1", "in_progress"), todo("2", "pending")]);
	component.render(80);
	component.handleInput("\x1b[B"); // down
	assert.match(component.render(80).join("\n"), /› .*task 2/);
	component.handleInput("\x1b[A"); // up
	assert.match(component.render(80).join("\n"), /› .*task 1/);
});

test("Home/End jump to the list boundaries", () => {
	const { component } = overlay([
		todo("1", "in_progress"),
		todo("2", "pending"),
		todo("3", "pending"),
		todo("4", "completed"),
	]);
	component.handleInput("\x1b[F"); // End
	assert.match(component.render(80).join("\n"), /› .*task 4/);
	component.handleInput("\x1b[H"); // Home
	assert.match(component.render(80).join("\n"), /› .*task 1/);
});

test("blocked-by dependencies render their dependency subjects in the detail pane", () => {
	const dep = todo("9", "in_progress", { subject: "Build feature" });
	const blocked: TodoItem = {
		...todo("1", "blocked", { subject: "Ship it" }),
		blockedBy: ["9"],
	};
	const { component } = overlay([dep, blocked]);
	// Select the blocked task (it sorts below pending, so with no pending present
	// it lands at index 1 after in_progress).
	component.handleInput("\x1b[B");
	component.handleInput("\r");
	const detail = component.render(120).join("\n");
	assert.match(detail, /Build feature/);
	assert.match(detail, /Blocked by/);
});

test("initialTodoId opens with the requested task selected", () => {
	const { component } = overlay([todo("1", "in_progress"), todo("2", "pending")]);
	const focused = new TodoOverlay({
		getTodos: () => [todo("1", "in_progress"), todo("2", "pending")],
		requestRender: () => {},
		close: () => {},
		theme,
		glyphs: resolveGlyphs("nerd"),
		initialTodoId: "2",
	});
	assert.match(focused.render(100).join("\n"), /› .*task 2/);
	// the plain component above still defaults to the first row
	assert.match(component.render(100).join("\n"), /› .*task 1/);
});

test("plain letters are inert so they stay available for a filter mode", () => {
	const { component, counts } = overlay([todo("1", "in_progress"), todo("2", "pending")]);
	component.render(60);
	const before = component.render(60).join("\n");
	for (const letter of ["j", "k", "r", "q", "/"]) component.handleInput(letter);
	assert.equal(counts().closes, 0);
	assert.equal(component.render(60).join("\n"), before);
});

test("narrow overlays degrade to a single width-bounded line", () => {
	const { component } = overlay([todo("1", "in_progress")]);
	for (const width of [1, 8, 16, 19]) {
		const lines = component.render(width);
		assert.equal(lines.length, 1);
		assert.ok(visibleWidth(lines[0]) <= width);
	}
});
