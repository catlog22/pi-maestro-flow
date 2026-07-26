import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderAgents, renderTodos, type WidthUtils } from "../src/render.ts";
import type { AgentRow, TodoItem } from "../src/types.ts";

const theme: Pick<Theme, "fg"> = { fg: (_c, t) => t };
const utils: WidthUtils = {
	measure: (s) => s.length,
	clip: (s, w, e) => (s.length <= w ? s : s.slice(0, Math.max(0, w - e.length)) + e),
};
const opts = { spin: "⠋" };

function agent(over: Partial<AgentRow> = {}): AgentRow {
	return { correlationId: "abcdef12", agent: "explorer", name: "scan", role: "explorer", task: "map auth", status: "running", tail: "read x.ts", startedAt: 1, ...over };
}
function todo(id: string, status: TodoItem["status"], subject = `task ${id}`): TodoItem {
	return { id, subject, status };
}

test("renderAgents list: one line per row, width bounded", () => {
	for (const width of [24, 40, 80, 120]) {
		const lines = renderAgents([agent(), agent({ correlationId: "zz", role: "executor", task: "impl", tail: "" })], "list", width, theme, utils, opts);
		assert.equal(lines.length, 2);
		for (const l of lines) assert.ok(utils.measure(l) <= width, `w=${width} line too long: ${l}`);
	}
});

test("renderAgents list includes role, id, task and tail", () => {
	const line = renderAgents([agent()], "list", 120, theme, utils, opts)[0];
	assert.ok(line.includes("explorer"));
	assert.ok(line.includes("#abcdef"));
	assert.ok(line.includes("map auth"));
	assert.ok(line.includes("read x.ts"));
	assert.ok(line.includes("⠋")); // running spinner
});

test("renderAgents compact: single summary line, width bounded", () => {
	const lines = renderAgents([agent(), agent()], "compact", 20, theme, utils, opts);
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes("2 agents running"));
	assert.ok(utils.measure(lines[0]) <= 20);
});

test("renderAgents empty roster yields no lines (bare-pi guard)", () => {
	assert.deepEqual(renderAgents([], "list", 80, theme, utils, opts), []);
	assert.deepEqual(renderAgents([], "compact", 80, theme, utils, opts), []);
});

test("renderAgents unknown role falls back without throwing", () => {
	assert.doesNotThrow(() => renderAgents([agent({ role: "mystery" })], "list", 80, theme, utils, opts));
});

test("renderTodos list: four states render distinct glyphs", () => {
	const lines = renderTodos([todo("0", "completed"), todo("1", "in_progress"), todo("2", "blocked"), todo("3", "pending")], "list", 80, theme, utils, opts);
	assert.equal(lines.length, 4);
	assert.ok(lines[0].includes("✓"));
	assert.ok(lines[1].includes("⠋"));
	assert.ok(lines[2].includes("!"));
	assert.ok(lines[3].includes("·"));
	for (const l of lines) assert.ok(utils.measure(l) <= 80);
});

test("renderTodos list numbers are zero-padded", () => {
	const lines = renderTodos([todo("a", "pending"), todo("b", "pending")], "list", 80, theme, utils, opts);
	assert.ok(lines[0].startsWith("01"));
	assert.ok(lines[1].startsWith("02"));
});

test("renderTodos compact: bar + percent, width bounded", () => {
	for (const width of [16, 30, 60]) {
		const lines = renderTodos([todo("0", "completed"), todo("1", "in_progress"), todo("2", "pending")], "compact", width, theme, utils, opts);
		assert.equal(lines.length, 1);
		assert.ok(lines[0].includes("%"));
		assert.ok(utils.measure(lines[0]) <= width, `w=${width}: ${lines[0]}`);
	}
});

test("renderTodos empty yields no lines", () => {
	assert.deepEqual(renderTodos([], "list", 80, theme, utils, opts), []);
});
