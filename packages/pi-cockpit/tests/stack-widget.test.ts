import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { makeAgentWidget, makeTodoWidget } from "../src/stack-widget.ts";
import { DEFAULT_CONFIG, type BashBgJob, type TodoItem } from "../src/types.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
const tui = {} as TUI;
const todos: TodoItem[] = [
	{ id: "1", subject: "implement ownership", status: "in_progress", blockedBy: [], skills: [] },
	{ id: "2", subject: "verify UI", status: "pending", blockedBy: [], skills: [] },
];

test("expanded Todo widget has one summary followed directly by task rows", () => {
	const component = makeTodoWidget({
		getTodos: () => todos,
		getConfig: () => ({ ...DEFAULT_CONFIG, todoExpanded: true }),
	})(tui, theme);
	const lines = component.render(100);
	assert.equal(lines.length, 3);
	assert.equal(lines.filter((line) => line.includes("Todo")).length, 1);
	assert.ok(lines[0].includes("Alt+T collapse"));
	assert.ok(lines[1].includes("implement ownership"));
});

test("agent-area widget keeps bash_bg visible when there are no teammates", () => {
	const backgroundJob: BashBgJob = {
		id: "bg-only",
		command: "npm run dev",
		cwd: "/workspace",
		pid: 123,
		status: "running",
		startedAt: Date.now() - 2_000,
		updatedAt: Date.now(),
		exitCode: null,
		outputTail: "ready",
		outputBytes: 5,
		logPath: "/tmp/bg-only.log",
	};
	const component = makeAgentWidget({
		getAgents: () => [],
		getBashBgJobs: () => [backgroundJob],
		getConfig: () => DEFAULT_CONFIG,
		isRunning: () => false,
	})(tui, theme);
	const lines = component.render(100);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /BG/);
	assert.match(lines[0], /bg-only/);
	assert.doesNotMatch(lines[0], /AGENTS/);
});
