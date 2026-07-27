import { test } from "node:test";
import assert from "node:assert/strict";
import { statusText, titleFor, workingMessage, type AmbientState } from "../src/ambient.ts";
import type { AgentRow, BashBgJob, TodoItem } from "../src/types.ts";

const MARKS = { ok: "✓", fail: "✗" };

function todo(over: Partial<TodoItem> = {}): TodoItem {
	return { id: "t1", subject: "wire the footer", status: "pending", ...over } as TodoItem;
}

function agent(over: Partial<AgentRow> = {}): AgentRow {
	return {
		agent: "a1",
		name: "a1",
		role: "executor",
		task: "build",
		status: "running",
		startedAt: 0,
		toolCount: 0,
		...over,
	} as AgentRow;
}

function job(over: Partial<BashBgJob> = {}): BashBgJob {
	return { id: "j1", command: "npm test", status: "running", exitCode: null, ...over } as BashBgJob;
}

function state(over: Partial<AmbientState> = {}): AmbientState {
	return { todos: [], agents: [], jobs: [], running: false, ...over };
}

test("workingMessage preserves the host default when no foreground tool runs", () => {
	assert.equal(workingMessage(state()), undefined);
	assert.equal(workingMessage(state({
		todos: [todo({ status: "in_progress", subject: "ship the widget" })],
		agents: [agent({ role: "reviewer", activeTool: "grep" })],
		jobs: [job()],
	})), undefined);
});

test("workingMessage shows only the active foreground tool name", () => {
	assert.equal(workingMessage(state({
		activeTool: "apply_patch",
		todos: [todo({ status: "in_progress", subject: "ship the widget" })],
		agents: [agent({ role: "reviewer", activeTool: "grep" })],
	})), "apply_patch");
});

test("title falls back to the bare workspace when nothing is happening", () => {
	assert.equal(titleFor(state({ cwd: "~/work/pi" }), MARKS), "pi · ~/work/pi");
	assert.equal(titleFor(state(), MARKS), "pi");
});

test("failure outranks progress in the tab title and carries a glyph", () => {
	const title = titleFor(state({
		cwd: "~/work/pi",
		running: true,
		agents: [agent(), agent({ agent: "b", status: "failed" })],
		jobs: [job({ id: "j2", status: "completed", exitCode: 1 })],
	}), MARKS);
	assert.equal(title, "✗ pi · ~/work/pi · 2 failed");
});

test("a running session reports live agents, an idle one reports background jobs", () => {
	assert.equal(
		titleFor(state({ cwd: "~/w", running: true, agents: [agent()] }), MARKS),
		"pi · ~/w · 1 agents",
	);
	assert.equal(titleFor(state({ cwd: "~/w", running: true }), MARKS), "pi · ~/w · working");
	assert.equal(titleFor(state({ cwd: "~/w", jobs: [job()] }), MARKS), "pi · ~/w · 1 bg");
});

test("statusText only occupies the slot when there is a real problem", () => {
	assert.equal(statusText(undefined, "!"), undefined);
	assert.equal(statusText("config unreadable", "!"), "! cockpit: config unreadable");
});
