import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { makeAgentWidget, makeTodoWidget } from "../src/stack-widget.ts";
import { DEFAULT_CONFIG, type AgentRow, type TodoItem } from "../src/types.ts";

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

test("agent-area widget stays hidden when there are no teammates", () => {
	const component = makeAgentWidget({
		getAgents: () => [],
		getConfig: () => DEFAULT_CONFIG,
		isRunning: () => false,
	})(tui, theme);
	const lines = component.render(100);
	assert.deepEqual(lines, []);
});

test("agent-area widget excludes graph dispatch containers from rows and running count", () => {
	const row = (overrides: Partial<AgentRow>): AgentRow => ({
		correlationId: "worker",
		agent: "explorer",
		name: undefined,
		role: "explorer",
		task: "inspect",
		status: "running",
		tail: "",
		startedAt: 1,
		lastActivityAt: 1,
		...overrides,
	});
	const component = makeAgentWidget({
		getAgents: () => [
			row({ correlationId: "root", agent: "graph(2)", role: "agent", task: "" }),
			row({ correlationId: "one", parentCorrelationId: "root", task: "first" }),
			row({ correlationId: "two", parentCorrelationId: "root", task: "second" }),
		],
		getConfig: () => DEFAULT_CONFIG,
		isRunning: () => true,
	})(tui, theme);
	const lines = component.render(120);
	assert.match(lines[0], /2 running/);
	assert.doesNotMatch(lines[0], /3 running/);
	assert.equal(lines.filter((line) => /first|second/.test(line)).length, 2);
});

test("agent-area widget bridges nested graph descendants to the nearest visible parent", () => {
	const row = (overrides: Partial<AgentRow>): AgentRow => ({
		correlationId: "worker",
		agent: "executor",
		name: undefined,
		role: "executor",
		task: "worker",
		status: "running",
		tail: "",
		startedAt: 1,
		lastActivityAt: 1,
		...overrides,
	});
	const component = makeAgentWidget({
		getAgents: () => [
			row({ correlationId: "worker", task: "outer worker" }),
			row({ correlationId: "graph", parentCorrelationId: "worker", agent: "graph(1)", role: "agent", task: "" }),
			row({ correlationId: "nested", parentCorrelationId: "graph", task: "nested worker" }),
		],
		getConfig: () => DEFAULT_CONFIG,
		isRunning: () => true,
	})(tui, theme);
	const lines = component.render(120);
	assert.match(lines[1], /^└─ .*outer worker/);
	assert.match(lines[2], /^  └─ .*nested worker/);
});
