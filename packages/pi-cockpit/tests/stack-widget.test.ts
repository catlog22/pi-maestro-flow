import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { makeAgentWidget, makeTodoWidget } from "../src/stack-widget.ts";
import { makeSessionDetailWidget } from "../src/session-detail.ts";
import { DEFAULT_CONFIG, type AgentRow, type TodoItem } from "../src/types.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const tui = {} as TUI;
const ACTIVE_AT = Date.now();
const todos: TodoItem[] = [
	{ id: "1", subject: "implement ownership", status: "in_progress", blockedBy: [], skills: [] },
	{ id: "2", subject: "verify UI", status: "pending", blockedBy: [], skills: [] },
];

test("row-leading status glyphs are static and ignore the animation flag", () => {
	// Nerd glyphs make the distinction unambiguous: the spinner frames are braille
	// characters that never appear in ordinary task text, while the static marker
	// is a filled dot. Forcing isAnimating() true proves the row glyph no longer
	// follows the animation clock — only the host working line keeps a spinner.
	const BRAILLE = /[⠋⠙⠹⠦⠇]/;
	const nerd = { ...DEFAULT_CONFIG, icons: { mode: "nerd" as const } };

	const todoLines = makeTodoWidget({
		getTodos: () => todos,
		getConfig: () => ({ ...nerd, todoExpanded: true }),
		isAnimating: () => true,
	})(tui, theme).render(120);
	const todoText = todoLines.join("\n");
	assert.doesNotMatch(todoText, /□/, "todo rows carry no box marker");
	assert.match(todoText, /implement ownership/, "in-progress task still renders its subject");
	assert.doesNotMatch(todoText, BRAILLE, "the in-progress glyph never spins");

	const agentLines = makeAgentWidget({
		getAgents: () => [{
			correlationId: "worker",
			agent: "explorer",
			name: undefined,
			role: "explorer",
			task: "inspect auth",
			status: "running",
			tail: "",
			startedAt: 1,
			lastActivityAt: ACTIVE_AT,
		}],
		getConfig: () => nerd,
		isRunning: () => true,
		isAnimating: () => true,
	})(tui, theme).render(120);
	const agentText = agentLines.join("\n");
	assert.match(agentText, /●/, "running agent shows the filled dot");
	assert.doesNotMatch(agentText, /□/, "agents keep the dot, not the todo marker");
	assert.doesNotMatch(agentText, BRAILLE, "the running glyph never spins");
});

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

test("visible Agents temporarily collapse an expanded Todo preference", () => {
	const config = { ...DEFAULT_CONFIG, todoExpanded: true };
	let agentPriority = true;
	const component = makeTodoWidget({
		getTodos: () => todos,
		getConfig: () => config,
		getExpanded: () => config.todoExpanded && !agentPriority,
	})(tui, theme);
	const collapsed = component.render(100);
	assert.equal(collapsed.length, 1, "Agent activity leaves only the Todo summary");
	assert.match(collapsed[0], /Alt\+T expand/);
	assert.equal(config.todoExpanded, true, "the persisted preference is untouched");
	agentPriority = false;
	assert.equal(component.render(100).length, 3, "Todo restores after Agents leave");
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
		lastActivityAt: ACTIVE_AT,
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

test("static mode passes hideLiveDuration through to the agent rows", () => {
	const row = (): AgentRow => ({
		correlationId: "worker",
		agent: "explorer",
		name: undefined,
		role: "explorer",
		task: "inspect auth",
		status: "running",
		tail: "",
		startedAt: 1,
		lastActivityAt: ACTIVE_AT,
	});
	const make = (staticMode: boolean) => makeAgentWidget({
		getAgents: () => [row()],
		getConfig: () => ({ ...DEFAULT_CONFIG, staticMode }),
		isRunning: () => true,
		isAnimating: () => !staticMode,
	})(tui, theme);

	const dynamic = make(false).render(120);
	assert.match(dynamic[1], /\d+s/, "dynamic mode shows the live elapsed");
	const statik = make(true).render(120);
	assert.doesNotMatch(statik[1], /\d+s/, "static mode hides the live elapsed");
});

test("quiet mode keeps the roster expanded but drops the live streaming tail", () => {
	const row = (overrides: Partial<AgentRow> = {}): AgentRow => ({
		correlationId: "worker",
		agent: "explorer",
		name: undefined,
		role: "explorer",
		task: "inspect auth",
		status: "running",
		tail: "reading tokens.ts",
		startedAt: 1,
		lastActivityAt: ACTIVE_AT,
		...overrides,
	});
	const make = (quiet: boolean) => makeAgentWidget({
		getAgents: () => [row()],
		getConfig: () => ({ ...DEFAULT_CONFIG, quietMode: quiet }),
		isRunning: () => true,
	})(tui, theme);

	const noisy = make(false).render(120);
	assert.match(noisy[1], /inspect auth/, "non-quiet keeps the task");
	assert.match(noisy[1], /reading tokens\.ts/, "non-quiet shows the streaming tail");

	const quiet = make(true).render(120);
	assert.match(quiet[1], /explorer/, "quiet keeps the role (roster stays expanded)");
	assert.match(quiet[1], /inspect auth/, "quiet keeps the task");
	assert.doesNotMatch(quiet[1], /reading tokens\.ts/, "quiet strips the streaming tail");
	// Header summary is tail-independent, so it is identical in both modes.
	assert.equal(quiet[0], noisy[0]);
});

test("short terminal gives Agent detail the rows released by collapsed Todo", () => {
	const shortTui = { terminal: { rows: 24, columns: 80 } } as TUI;
	const todoLines = makeTodoWidget({
		getTodos: () => Array.from({ length: 12 }, (_, i) => ({
			id: String(i), subject: `task ${i}`, status: i === 0 ? "in_progress" as const : "pending" as const, blockedBy: [], skills: [],
		})),
		getConfig: () => ({ ...DEFAULT_CONFIG, todoExpanded: true }),
		getExpanded: () => false,
	})(shortTui, theme).render(80);
	const selected: AgentRow = {
		correlationId: "worker",
		agent: "explorer",
		name: "worker",
		role: "explorer",
		task: "inspect",
		status: "running",
		tail: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"),
		startedAt: 1,
		lastActivityAt: ACTIVE_AT,
	};
	const detailLines = makeSessionDetailWidget({
		getAgents: () => [selected],
		getViewingId: () => "worker",
		getVisible: () => true,
	})(shortTui, theme).render(80);
	const rosterLines = makeAgentWidget({
		getAgents: () => Array.from({ length: 6 }, (_, index) => ({
			...selected,
			correlationId: `worker-${index}`,
			name: `worker-${index}`,
			task: `task ${index}`,
			tail: "",
			lastActivityAt: ACTIVE_AT + index,
		})),
		getConfig: () => DEFAULT_CONFIG,
		isRunning: () => true,
		hasSessionDetail: () => true,
	})(shortTui, theme).render(80);
	assert.equal(todoLines.length, 1);
	assert.ok(detailLines.length <= 4);
	assert.ok(rosterLines.length <= 3);
	assert.ok(todoLines.length + detailLines.length + rosterLines.length <= 8, "all Agent surfaces share one bounded screen allowance");
});

test("agent roster overflow markers stay inside the panel budget", () => {
	const shortTui = { terminal: { rows: 24, columns: 80 } } as TUI;
	const rows: AgentRow[] = Array.from({ length: 8 }, (_, i) => ({
		correlationId: `worker-${i}`,
		agent: "explorer",
		name: `worker-${i}`,
		role: "explorer",
		task: `task ${i}`,
		status: "running",
		tail: "",
		startedAt: 1,
		lastActivityAt: ACTIVE_AT + i,
	}));
	const component = makeAgentWidget({
		getAgents: () => rows,
		getConfig: () => DEFAULT_CONFIG,
		isRunning: () => true,
		getScroll: () => ({ offset: 3, following: false }),
	})(shortTui, theme);
	const lines = component.render(80);
	assert.ok(lines.length <= 5, `roster exceeded budget: ${lines.length}`);
	assert.ok(lines.some((line) => line.includes("task ")), "overflow navigation preserves a real agent row");
});

test("agent roster follow keeps the newest activity visible", () => {
	const tallTui = { terminal: { rows: 50, columns: 120 } } as TUI;
	const rows: AgentRow[] = Array.from({ length: 10 }, (_, index) => ({
		correlationId: `worker-${index}`,
		agent: "explorer",
		name: `worker-${index}`,
		role: "explorer",
		task: `activity ${index}`,
		status: "running",
		tail: "",
		startedAt: 1,
		lastActivityAt: ACTIVE_AT + index,
	}));
	const component = makeAgentWidget({
		getAgents: () => rows,
		getConfig: () => DEFAULT_CONFIG,
		isRunning: () => true,
	})(tallTui, theme);
	const initial = component.render(120).join("\n");
	assert.match(initial, /activity 9/);
	assert.doesNotMatch(initial, /activity 0/);
	rows[0] = { ...rows[0], lastActivityAt: ACTIVE_AT + 20 };
	assert.match(component.render(120).join("\n"), /activity 0/, "a newly active row enters the following window");
});

test("roster viewport keeps full-tree prefixes when a parent is outside the window", () => {
	const shortTui = { terminal: { rows: 24, columns: 80 } } as TUI;
	const parent: AgentRow = {
		correlationId: "parent",
		agent: "executor",
		name: "parent",
		role: "executor",
		task: "parent task",
		status: "running",
		tail: "",
		startedAt: 1,
		lastActivityAt: ACTIVE_AT,
	};
	const rows: AgentRow[] = [
		parent,
		...Array.from({ length: 8 }, (_, index) => ({ ...parent, correlationId: `other-${index}`, name: `other-${index}`, task: `other ${index}`, lastActivityAt: ACTIVE_AT + index + 1 })),
		{ ...parent, correlationId: "child", parentCorrelationId: "parent", name: "child", task: "child task", lastActivityAt: ACTIVE_AT + 20 },
	];
	const lines = makeAgentWidget({
		getAgents: () => rows,
		getConfig: () => ({ ...DEFAULT_CONFIG, icons: { mode: "nerd" } }),
		isRunning: () => true,
	})(shortTui, theme).render(80);
	const childLine = lines.find((line) => line.includes("child task"));
	assert.ok(childLine);
	assert.match(childLine, /^  └─/, "child remains visibly nested even when its parent is above the viewport");
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
		lastActivityAt: ACTIVE_AT,
		...overrides,
	});
	const component = makeAgentWidget({
		getAgents: () => [
			row({ correlationId: "worker", task: "outer worker" }),
			row({ correlationId: "graph", parentCorrelationId: "worker", agent: "graph(1)", role: "agent", task: "" }),
			row({ correlationId: "nested", parentCorrelationId: "graph", task: "nested worker" }),
		],
		getConfig: () => ({ ...DEFAULT_CONFIG, icons: { mode: "nerd" } }),
		isRunning: () => true,
	})(tui, theme);
	const lines = component.render(120);
	assert.match(lines[1], /^└─ .*outer worker/);
	assert.match(lines[2], /^  └─ .*nested worker/);
});
