import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { MaestroUiStateSnapshotV1 } from "../src/public/v1/events.ts";
import { renderSidebar } from "../src/sidebar-render.ts";
import { DEFAULT_CONFIG, type AgentRow, type BashBgJob, type TodoItem } from "../src/types.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
} as Theme;

const maestro: MaestroUiStateSnapshotV1 = {
	version: 1,
	sessionGeneration: "session-1",
	revision: 1,
	publishedAt: 1_000,
	workflow: {
		session: { id: "workflow-1", label: "Delivery", status: "running" },
		run: { id: "run-1", command: "execute task", status: "running" },
		chain: { completed: 2, running: 1, pending: 2, total: 5 },
		gates: { passed: 1, total: 2 },
		next: "verify output",
	},
	goals: [{
		id: "goal-1",
		objective: "Ship cockpit sidebar",
		status: "running",
		iteration: 3,
		tokensUsed: 12_000,
		tokenBudget: 40_000,
		timeUsedSeconds: 90,
		startedAt: 1,
		updatedAt: 2,
	}],
	currentGoalId: "goal-1",
	swarm: {
		sessionId: "swarm-1",
		objective: "Review implementation",
		status: "running",
		iteration: 2,
		maxIterations: 4,
		workers: [{ id: "worker-1", label: "reviewer", status: "running" }],
		best: { workerId: "worker-1", iteration: 1, score: 0.8, summary: "clean" },
		updatedAt: 2,
	},
	mode: "act",
};

const todos: TodoItem[] = [
	{ id: "1", subject: "Implement pane", status: "in_progress", blockedBy: [], skills: [] },
	{ id: "2", subject: "Add tests", status: "pending", blockedBy: [], skills: [] },
	{ id: "3", subject: "Review output", status: "completed", blockedBy: [], skills: [] },
];

const agents: AgentRow[] = [{
	correlationId: "agent-1",
	agent: "general",
	name: "builder",
	role: "general",
	task: "Implement sidebar",
	status: "running",
	tail: "working",
	startedAt: 1_000,
	lastActivityAt: 2_000,
}];

const jobs: BashBgJob[] = [{
	id: "job-1",
	command: "npm test",
	cwd: "/workspace",
	pid: 12,
	status: "running",
	startedAt: 1_000,
	updatedAt: 2_000,
	exitCode: null,
	outputTail: "",
	outputBytes: 0,
	logPath: "/tmp/job.log",
}];

function render(overrides: Partial<Parameters<typeof renderSidebar>[0]> = {}): string[] {
	return renderSidebar({
		maestro,
		todos,
		agents,
		jobs,
		config: DEFAULT_CONFIG,
		width: 40,
		height: 30,
		theme,
		now: 11_000,
		...overrides,
	});
}

test("static mode hides live durations without trailing separators but keeps frozen ones", () => {
	const lines = render({
		config: { ...DEFAULT_CONFIG, staticMode: true },
		agents: [
			agents[0],
			{
				correlationId: "agent-done",
				agent: "general",
				name: "finished",
				role: "general",
				task: "Frozen audit",
				status: "done",
				tail: "",
				startedAt: 1_000,
				lastActivityAt: 2_000,
				finishedAt: 6_000,
			},
		],
		jobs: [
			jobs[0],
			{ ...jobs[0], id: "job-done", command: "npm run lint", status: "completed", exitCode: 0, finishedAt: 6_000 },
		],
	});
	const agentLine = lines.find((line) => line.includes("builder"))!;
	assert.doesNotMatch(agentLine, /10s/, "live agent duration is hidden");
	assert.ok(!agentLine.trimEnd().endsWith("|"), "no trailing separator on the live agent row");
	assert.match(lines.find((line) => line.includes("Frozen audit"))!, /5s/, "frozen duration on a done row survives");
	const jobLine = lines.find((line) => line.includes("npm test"))!;
	assert.doesNotMatch(jobLine, /10s/, "live job duration is hidden");
	assert.ok(!jobLine.trimEnd().endsWith("|"), "no trailing separator on the live job row");
	assert.match(lines.find((line) => line.includes("npm run lint"))!, /5s/, "frozen duration on a completed job survives");
});

test("renders all non-empty read-only sections with one full-height left divider", () => {
	const lines = render();
	const text = lines.join("\n");
	assert.equal(lines.length, 30);
	for (const line of lines) {
		assert.ok(line.startsWith("│ "));
		assert.ok(visibleWidth(line) <= 40);
	}
	for (const heading of ["Workflow", "Goal", "Tasks", "Agents", "Jobs", "Swarm"]) {
		assert.match(text, new RegExp(heading));
	}
	assert.doesNotMatch(text, /\/workspace|provider|context window|model:/i, "footer-owned data is not repeated");
});

test("height pressure preserves sections in priority order and budgets overflow inside the height", () => {
	const lines = render({ height: 6 });
	const text = lines.join("\n");
	assert.equal(lines.length, 6);
	assert.match(text, /Workflow/);
	assert.match(text, /Goal/);
	assert.match(text, /Tasks/);
	assert.doesNotMatch(text, /Agents|Jobs|Swarm/);
});

test("compact mode activates at 35 columns or from configuration density", () => {
	const compact = render({ maestro: undefined, agents: [], jobs: [], width: 35, height: 10 }).join("\n");
	const comfortable = render({ maestro: undefined, agents: [], jobs: [], width: 36, height: 10 }).join("\n");
	const configured = render({
		maestro: undefined,
		agents: [],
		jobs: [],
		width: 40,
		height: 10,
		config: { ...DEFAULT_CONFIG, sidebar: { ...DEFAULT_CONFIG.sidebar, density: "compact" } },
	}).join("\n");
	assert.match(compact, /Implement pane/);
	assert.doesNotMatch(compact, /Add tests/);
	assert.match(comfortable, /Add tests/);
	assert.doesNotMatch(configured, /Add tests/);
});

test("agent sidebar rows expose live action and telemetry changes", () => {
	const base = { ...agents[0], activeTool: "read", toolCount: 2, inputTokens: 1_200, outputTokens: 40 };
	const first = render({ maestro: undefined, todos: [], jobs: [], agents: [base], width: 100, height: 8 }).join("\n");
	const second = render({
		maestro: undefined,
		todos: [],
		jobs: [],
		agents: [{ ...base, activeTool: undefined, tail: "waiting for tests", toolCount: 3 }],
		width: 100,
		height: 8,
	}).join("\n");
	assert.match(first, /tool read/);
	assert.match(first, /2 tools/);
	assert.match(first, /in 1.2k\/out 40/);
	assert.match(second, /waiting for tests/);
	assert.match(second, /3 tools/);
	assert.notEqual(first, second, "telemetry-only progress must visibly repaint the sidebar");
});

test("agent sidebar distinguishes stalled and terminated states", () => {
	const text = render({
		maestro: undefined,
		todos: [],
		jobs: [],
		agents: [
			{ ...agents[0], correlationId: "stalled", lastActivityAt: 1 },
			{ ...agents[0], correlationId: "terminated", status: "terminated", finishedAt: 5_000 },
		],
		width: 64,
		height: 10,
		now: 40_000,
	}).join("\n");
	assert.match(text, /1 stalled/);
	assert.match(text, /1 terminated/);
	assert.match(text, /stalled/);
	assert.match(text, /terminated/);
});

test("hostile control characters are stripped and every line remains width bounded", () => {
	const hostileTodos: TodoItem[] = [{
		id: "bad",
		subject: "\x1b[31mred\nsecond\tcell\x07",
		status: "in_progress",
		blockedBy: [],
		skills: [],
	}];
	const hostileJobs: BashBgJob[] = [{ ...jobs[0], command: "\x1b[2Jclear\r\nnext" }];
	const lines = render({ maestro: undefined, todos: hostileTodos, agents: [], jobs: hostileJobs, width: 32, height: 12 });
	const text = lines.join("\n");
	assert.doesNotMatch(text, /\x1b|\x07|\r|\t/);
	assert.match(text, /red second cell/);
	assert.match(text, /clear next/);
	for (const line of lines) assert.ok(visibleWidth(line) <= 32);
});

test("empty inputs omit all section headers while retaining the dock divider", () => {
	const lines = render({ maestro: undefined, todos: [], agents: [], jobs: [], height: 4 });
	assert.equal(lines.length, 4);
	assert.ok(lines.every((line) => line.trim() === "│"));
	assert.doesNotMatch(lines.join("\n"), /Workflow|Goal|Tasks|Agents|Jobs|Swarm/);
});
