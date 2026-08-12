import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { MaestroUiStateSnapshotV1 } from "../src/public/v1/events.ts";
import { enumerateZenNavRows, renderZenStack, type ZenRenderInput } from "../src/zen-render.ts";
import type { AgentRow, BashBgJob, TodoItem } from "../src/types.ts";
import { cockpitTuiLocale } from "../src/tui-i18n.ts";

cockpitTuiLocale.setLocale("en");

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
		objective: "Ship zen stack",
		status: "running",
		iteration: 3,
		tokensUsed: 12_000,
		tokenBudget: 40_000,
		timeUsedSeconds: 90,
		startedAt: 1,
		updatedAt: 2,
	}],
	currentGoalId: "goal-1",
	swarm: null,
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
	task: "Implement stack",
	status: "running",
	tail: "working",
	startedAt: 1_000,
	lastActivityAt: 10_000,
}];

const jobs: BashBgJob[] = [{
	id: "job-1",
	command: "npm test",
	cwd: "/workspace",
	pid: 12,
	status: "running",
	startedAt: 1_000,
	updatedAt: 10_000,
	exitCode: null,
	outputTail: "",
	outputBytes: 0,
	logPath: "/tmp/job.log",
}];

function render(overrides: Partial<ZenRenderInput> = {}): string[] {
	return renderZenStack({
		maestro,
		todos,
		agents,
		jobs,
		config: { icons: { mode: "nerd" }, staticMode: false, todoExpanded: false },
		width: 120,
		theme,
		now: 11_000,
		...overrides,
	});
}

test("full snapshot projects MISSION, WORK and ACTORS rows in order", () => {
	const lines = render();
	const missionIdx = lines.findIndex((line) => line.includes("Delivery"));
	const runIdx = lines.findIndex((line) => line.includes("execute task"));
	const taskIdx = lines.findIndex((line) => line.includes("Implement pane"));
	const agentIdx = lines.findIndex((line) => line.includes("builder"));
	assert.ok(missionIdx >= 0 && missionIdx < runIdx, "mission precedes work");
	assert.ok(runIdx < taskIdx, "run row precedes task rows");
	assert.ok(taskIdx < agentIdx, "work precedes actors");
	assert.match(lines[missionIdx + 1], /1\/2 gates/, "meta row carries gate counts");
	assert.match(lines[missionIdx + 1], /12k\/40k tokens/, "meta row carries token budget");
	assert.match(lines[runIdx], /chain 2\/5/, "run row carries chain progress");
	assert.match(lines[agentIdx], /agent builder/, "actor row is kind-tagged");
	assert.match(lines.find((line) => line.includes("npm test"))!, /job npm test/);
});

test("empty inputs render zero rows (silent presence)", () => {
	assert.deepEqual(render({ maestro: undefined, todos: [], agents: [], jobs: [] }), []);
});

test("todos alone render only WORK rows", () => {
	const lines = render({ maestro: undefined, agents: [], jobs: [] });
	assert.equal(lines.filter((line) => line.includes("Delivery")).length, 0);
	assert.match(lines[0], /Implement pane/, "in_progress task floats first");
	assert.match(lines.at(-1)!, /1 done/, "completed tasks fold into a summary");
});

test("goal pause reason surfaces as a dedicated warning row", () => {
	const paused: MaestroUiStateSnapshotV1 = {
		...maestro,
		workflow: null,
		goals: [{ ...maestro.goals[0], status: "paused", pauseReason: "clarify scope with user" }],
	};
	const lines = render({ maestro: paused, todos: [], agents: [], jobs: [] });
	assert.ok(lines.some((line) => line.includes("clarify scope with user")), "pause reason row present");
});

test("blocked task names its blockers", () => {
	const lines = render({
		todos: [{ id: "9", subject: "Deploy", status: "blocked", blockedBy: ["1", "2"], skills: [] }],
	});
	assert.match(lines.find((line) => line.includes("Deploy"))!, /blocked by 1, 2/);
});

test("collapsed WORK folds overflow active tasks; expanded shows them", () => {
	const many: TodoItem[] = Array.from({ length: 6 }, (_, i) => ({
		id: String(i + 1),
		subject: `Task ${i + 1}`,
		status: "pending" as const,
		blockedBy: [],
		skills: [],
	}));
	const collapsed = render({ todos: many, maestro: undefined, agents: [], jobs: [] });
	assert.equal(collapsed.filter((line) => /Task \d/.test(line)).length, 3, "collapsed caps at 3 task rows");
	assert.ok(collapsed.some((line) => line.includes("3 more")), "overflow folds into a count");
	const expanded = render({
		todos: many,
		maestro: undefined,
		agents: [],
		jobs: [],
		config: { icons: { mode: "nerd" }, staticMode: false, todoExpanded: true },
	});
	assert.equal(expanded.filter((line) => /Task \d/.test(line)).length, 6, "expanded shows all tasks");
});

test("static mode hides live durations but keeps frozen ones", () => {
	const lines = render({
		config: { icons: { mode: "nerd" }, staticMode: true, todoExpanded: false },
		agents: [
			agents[0],
			{ ...agents[0], correlationId: "agent-done", name: "finished", task: "Frozen audit", status: "done", finishedAt: 6_000 },
		],
		jobs: [
			jobs[0],
			{ ...jobs[0], id: "job-done", command: "npm run lint", status: "completed", exitCode: 0, finishedAt: 6_000 },
		],
	});
	assert.doesNotMatch(lines.find((line) => line.includes("builder"))!, /10s/, "live agent duration hidden");
	assert.match(lines.find((line) => line.includes("Frozen audit"))!, /5s/, "frozen agent duration survives");
	assert.doesNotMatch(lines.find((line) => line.includes("npm test"))!, /10s/, "live job duration hidden");
	assert.match(lines.find((line) => line.includes("npm run lint"))!, /5s/, "frozen job duration survives");
});

test("problem actors float above running ones and overflow folds with a summary", () => {
	const roster: AgentRow[] = [
		agents[0],
		{ ...agents[0], correlationId: "a2", name: "worker-2", task: "Second" },
		{ ...agents[0], correlationId: "a3", name: "worker-3", task: "Third" },
		{ ...agents[0], correlationId: "a4", name: "crashed", task: "Broken", status: "failed", error: "exit 1", finishedAt: 9_000 },
		{ ...agents[0], correlationId: "a5", name: "worker-5", task: "Fifth" },
	];
	const lines = render({ agents: roster, jobs: [], todos: [], maestro: undefined });
	const summary = lines[0];
	assert.match(summary, /5 total/, "summary row leads when actors overflow");
	assert.match(summary, /1 failed/);
	const failedIdx = lines.findIndex((line) => line.includes("crashed"));
	const firstRunningIdx = lines.findIndex((line) => line.includes("builder"));
	assert.ok(failedIdx >= 0 && failedIdx < firstRunningIdx, "failed actor floats first");
	assert.match(lines.find((line) => line.includes("crashed"))!, /exit 1/, "error text wins the detail slot");
	assert.ok(lines.at(-1)!.includes("1 more"), "hidden actors fold into a count");
});

test("swarm renders a single kind-tagged row", () => {
	const withSwarm: MaestroUiStateSnapshotV1 = {
		...maestro,
		swarm: {
			sessionId: "swarm-1",
			objective: "Review implementation",
			status: "running",
			iteration: 2,
			maxIterations: 4,
			workers: [{ id: "w1", status: "running" }],
			best: { iteration: 1, score: 0.8 },
			updatedAt: 2,
		},
	};
	const line = render({ maestro: withSwarm }).find((row) => row.includes("swarm"))!;
	assert.match(line, /Review implementation/);
	assert.match(line, /iteration 2\/4/);
	assert.match(line, /best 0\.8/);
});

test("browse mode marks the selected row and expands only its L2 details", () => {
	const lines = render({ browse: { selectedId: "task:1", expandedId: "task:1" } });
	const selected = lines.findIndex((line) => line.startsWith("› ") && line.includes("Implement pane"));
	assert.ok(selected >= 0, "selected task carries the browse marker");
	assert.match(lines[selected + 1], /status\s+in_progress/, "expanded details follow the selected row");
	assert.ok(lines.filter((line) => line.startsWith("› ")).length === 1, "only one row is selected");
});

test("navigation ids follow visible render order and exclude folded summaries", () => {
	const input: ZenRenderInput = {
		maestro,
		todos,
		agents,
		jobs,
		config: { icons: { mode: "nerd" }, staticMode: false, todoExpanded: false },
		width: 120,
		theme,
		now: 11_000,
	};
	assert.deepEqual(enumerateZenNavRows(input), [
		"mission", "run", "task:1", "task:2", "agent:agent-1", "job:job-1",
	]);
});

test("navigation excludes rows folded by the total height budget", () => {
	const input: ZenRenderInput = {
		maestro,
		todos,
		agents,
		jobs,
		config: { icons: { mode: "nerd" }, staticMode: false, todoExpanded: false },
		width: 120,
		theme,
		now: 11_000,
		maxRows: 4,
	};
	assert.deepEqual(enumerateZenNavRows(input), ["mission", "run"]);
	input.browse = { selectedId: "mission", expandedId: "mission" };
	assert.deepEqual(enumerateZenNavRows(input), ["mission"]);
});

test("expanded browse details still obey the total height budget", () => {
	const lines = render({ browse: { selectedId: "mission", expandedId: "mission" }, maxRows: 4 });
	assert.equal(lines.length, 4);
	assert.match(lines.at(-1)!, /\d+ more/);
});

test("maxRows folds the tail into a dim more-marker", () => {
	const lines = render({ maxRows: 4 });
	assert.equal(lines.length, 4, "stack respects the row budget");
	assert.match(lines.at(-1)!, /\d+ more/, "tail folds into a count");
});

test("every row fits the requested width", () => {
	for (const width of [24, 40, 80]) {
		for (const line of render({ width })) {
			assert.ok(visibleWidth(line) <= width, `row exceeds width ${width}: ${line}`);
		}
	}
	assert.deepEqual(render({ width: 0 }), [], "zero width renders nothing");
});
