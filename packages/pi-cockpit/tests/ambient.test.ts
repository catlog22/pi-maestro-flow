import { test } from "node:test";
import assert from "node:assert/strict";
import { AmbientSurfaceCache, nextUiPromptDepth, statusText, titleFor, workingMessage, type AmbientState } from "../src/ambient.ts";
import type { AgentRow, BashBgJob, TodoItem } from "../src/types.ts";
import { cockpitTuiLocale } from "../src/tui-i18n.ts";

cockpitTuiLocale.setLocale("en");

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

test("workingMessage shows only the active foreground tool name without a start time", () => {
	assert.equal(workingMessage(state({
		activeTool: "edit",
		todos: [todo({ status: "in_progress", subject: "ship the widget" })],
		agents: [agent({ role: "reviewer", activeTool: "grep" })],
	})), "\x1b[3medit\x1b[23m");
});

test("workingMessage renders the active state with a thinking-style elapsed", () => {
	assert.equal(workingMessage(state({ running: true, workingStartedAt: 1_000 }), 4_200), "\x1b[3mworking 3.2s\x1b[23m");
	assert.equal(workingMessage(state({
		running: true,
		activeTool: "teammate-wait",
		workingStartedAt: 1_000,
	}), 66_400), "\x1b[3mteammate-wait 1m05s\x1b[23m");
});

test("workingMessage uses the separator glyph between label and elapsed", () => {
	assert.equal(workingMessage(state({ running: true, workingStartedAt: 1_000, separator: " · " }), 4_200), "\x1b[3mworking · 3.2s\x1b[23m");
	assert.equal(workingMessage(state({
		running: true,
		activeTool: "observe",
		workingStartedAt: 1_000,
		separator: " · ",
	}), 37_000), "\x1b[3mobserve · 36s\x1b[23m");
});

test("workingMessage omits a frozen elapsed in static mode", () => {
	const staticState = state({
		running: true,
		activeTool: "teammate-wait",
		workingStartedAt: 1_000,
		hideLiveDuration: true,
	});
	assert.equal(workingMessage(staticState, 4_200), "\x1b[3mteammate-wait\x1b[23m");
	assert.equal(workingMessage(staticState, 66_400), "\x1b[3mteammate-wait\x1b[23m");
});

test("UI prompt depth nests, saturates at zero, and projects a waiting state without ending the turn", () => {
	let depth = nextUiPromptDepth(0, "start");
	depth = nextUiPromptDepth(depth, "start");
	assert.equal(depth, 2);
	depth = nextUiPromptDepth(depth, "end");
	assert.equal(depth, 1);
	depth = nextUiPromptDepth(nextUiPromptDepth(depth, "end"), "end");
	assert.equal(depth, 0);

	const waiting = state({
		running: true,
		waitingForInput: true,
		activeTool: "ask-user-question",
		workingStartedAt: 1_000,
		cwd: "~/w",
	});
	assert.equal(workingMessage(waiting, 66_400), "\x1b[3mWAITING FOR INPUT\x1b[23m");
	assert.equal(titleFor(waiting, MARKS), "pi - ~/w - WAITING FOR INPUT");
	assert.equal(waiting.running, true, "waiting does not end the agent lifecycle");
});

test("title falls back to the bare workspace when nothing is happening", () => {
	assert.equal(titleFor(state({ cwd: "~/work/pi" }), MARKS), "pi - ~/work/pi");
	assert.equal(titleFor(state(), MARKS), "pi");
});

test("failure outranks progress in the tab title and carries a glyph", () => {
	const title = titleFor(state({
		cwd: "~/work/pi",
		running: true,
		agents: [agent(), agent({ agent: "b", status: "failed" })],
		jobs: [job({ id: "j2", status: "completed", exitCode: 1 })],
	}), MARKS);
	assert.equal(title, "✗ pi - ~/work/pi - 2 failed");
});

test("a running session reports live agents, an idle one reports background jobs", () => {
	assert.equal(
		titleFor(state({ cwd: "~/w", running: true, agents: [agent()] }), MARKS),
		"pi - ~/w - 1 agents",
	);
	assert.equal(titleFor(state({ cwd: "~/w", running: true }), MARKS), "pi - ~/w - working");
	assert.equal(titleFor(state({ cwd: "~/w", jobs: [job()] }), MARKS), "pi - ~/w - 1 bg");
});

test("statusText only occupies the slot when there is a real problem", () => {
	assert.equal(statusText(undefined, "!"), undefined);
	assert.equal(statusText("config unreadable", "!"), "! cockpit: config unreadable");
});

test("session summary sits right after pi when present", () => {
	assert.equal(titleFor(state({ session: "标题分析" }), MARKS), "pi - 标题分析");
	assert.equal(titleFor(state({ session: "标题分析", cwd: "~/w" }), MARKS), "pi - 标题分析 - ~/w");
});

test("optional tags follow the working state in order", () => {
	const t = titleFor(state({
		cwd: "~/w",
		running: true,
		model: "gpt-5.6-sol",
		thinking: "high",
		gitBranch: "main",
		maestro: "done",
	}), MARKS);
	assert.equal(t, "pi - ~/w - working - m:gpt-5.6-sol - t:high - git:main - wf:done");
});

test("failure still outranks progress and carries the tags", () => {
	const t = titleFor(state({
		cwd: "~/w",
		running: true,
		agents: [agent({ agent: "b", status: "failed" })],
		model: "gpt-5.6-sol",
		gitBranch: "detached",
	}), MARKS);
	assert.equal(t, "✗ pi - ~/w - 1 failed - m:gpt-5.6-sol - git:detached");
});

test("idle titles append tags without inventing a working state", () => {
	const t = titleFor(state({ cwd: "~/w", gitBranch: "main", maestro: "blocked" }), MARKS);
	assert.equal(t, "pi - ~/w - git:main - wf:blocked");
});

test("maxLength ellides the middle, keeping the head and the state tail", () => {
	const t = titleFor(state({
		session: "a-very-long-session-summary-topic",
		cwd: "~/deeply/nested/project/folder",
		running: true,
		model: "gpt-5.6-sol",
	}), MARKS, " - ", { maxLength: 32 });
	assert.ok(t.length <= 32, `got length ${t.length}: ${t}`);
	assert.ok(t.startsWith("pi"), t);
	assert.ok(t.includes("…"), t);
	assert.ok(t.endsWith("m:gpt-5.6-sol"), t);
});

test("a short title is never clipped", () => {
	assert.equal(
		titleFor(state({ cwd: "~/w", running: true, model: "gpt-5.6-sol" }), MARKS, " - ", { maxLength: 80 }),
		"pi - ~/w - working - m:gpt-5.6-sol",
	);
});

test("frame glyph leads the title while idle and while working", () => {
	assert.equal(titleFor(state({ frame: "✳", cwd: "~/w" }), MARKS), "✳ pi - ~/w");
	assert.equal(
		titleFor(state({ frame: "⠂", cwd: "~/w", running: true }), MARKS),
		"⠂ pi - ~/w - working",
	);
});

test("failure outranks the frame glyph, keeping its own ✗", () => {
	const t = titleFor(state({
		frame: "⠂",
		cwd: "~/w",
		running: true,
		agents: [agent({ agent: "b", status: "failed" })],
	}), MARKS);
	assert.equal(t, "✗ pi - ~/w - 1 failed");
});

test("AmbientSurfaceCache suppresses duplicate host setter calls", () => {
	const cache = new AmbientSurfaceCache();
	const calls: string[] = [];

	assert.equal(cache.setWorkingMessage((message) => calls.push(`working:${message ?? ""}`), undefined), true);
	assert.equal(cache.setWorkingMessage((message) => calls.push(`working:${message ?? ""}`), undefined), false);
	assert.equal(cache.setWorkingMessage((message) => calls.push(`working:${message ?? ""}`), "working"), true);
	assert.equal(cache.setWorkingMessage((message) => calls.push(`working:${message ?? ""}`), "working"), false);

	assert.equal(cache.setStatus("cockpit", (key, text) => calls.push(`status:${key}:${text ?? ""}`), undefined), true);
	assert.equal(cache.setStatus("cockpit", (key, text) => calls.push(`status:${key}:${text ?? ""}`), undefined), false);
	assert.equal(cache.setStatus("cockpit", (key, text) => calls.push(`status:${key}:${text ?? ""}`), "broken"), true);
	assert.equal(cache.setStatus("cockpit", (key, text) => calls.push(`status:${key}:${text ?? ""}`), "broken"), false);

	assert.deepEqual(calls, ["working:", "working:working", "status:cockpit:", "status:cockpit:broken"]);
});

test("AmbientSurfaceCache reset forces the next value to be published", () => {
	const cache = new AmbientSurfaceCache();
	let calls = 0;
	cache.setTitle(() => { calls += 1; }, "pi");
	cache.setTitle(() => { calls += 1; }, "pi");
	cache.reset();
	cache.setTitle(() => { calls += 1; }, "pi");
	assert.equal(calls, 2);
});
