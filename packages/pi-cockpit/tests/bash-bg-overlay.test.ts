import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BashBgOverlay, REFRESH_ACK_MS } from "../src/bash-bg-overlay.ts";
import { cockpitTuiLocale } from "../src/tui-i18n.ts";
import type { BashBgJob, BashBgStatus } from "../src/types.ts";
import { resolveGlyphs } from "../src/icons.ts";

cockpitTuiLocale.setLocale("en");

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

function job(id: string, status: BashBgStatus, overrides: Partial<BashBgJob> = {}): BashBgJob {
	return {
		id,
		command: `node ${id}.js --watch`,
		cwd: "/workspace/project",
		pid: 123,
		status,
		startedAt: Date.now() - 10_000,
		updatedAt: Date.now() - 1_000,
		...(status === "running" || status === "stopping" ? {} : { finishedAt: Date.now() - 500 }),
		exitCode: status === "completed" ? 0 : status === "failed" ? 1 : null,
		outputTail: "starting\nready",
		outputBytes: 2_048,
		logPath: `/tmp/${id}.log`,
		...overrides,
	};
}

function overlay(jobs: BashBgJob[]) {
	let renders = 0;
	let refreshes = 0;
	let closes = 0;
	const component = new BashBgOverlay({
		getJobs: () => jobs,
		requestRender: () => { renders++; },
		requestRefresh: () => { refreshes++; },
		close: () => { closes++; },
		theme,
		glyphs: resolveGlyphs("nerd"),
		now: Date.now(),
	});
	return { component, counts: () => ({ renders, refreshes, closes }) };
}

test("initialJobId opens with the requested Zen row selected", () => {
	const first = job("first", "running");
	const second = job("second", "completed");
	const component = new BashBgOverlay({
		getJobs: () => [first, second],
		requestRender: () => {},
		requestRefresh: () => {},
		close: () => {},
		theme,
		glyphs: resolveGlyphs("nerd"),
		now: Date.now(),
		initialJobId: "second",
	});
	assert.match(component.render(60).join("\n"), /› ✓ 2\/2.*second/);
});

test("hideLiveDuration drops the live duration from the job row but keeps the command", () => {
	const j = job("job-1", "running");
	const component = new BashBgOverlay({
		getJobs: () => [j],
		requestRender: () => {},
		requestRefresh: () => {},
		close: () => {},
		theme,
		glyphs: resolveGlyphs("nerd"),
		now: Date.now(),
		hideLiveDuration: true,
	});
	const lines = component.render(100).join("\n");
	assert.match(lines, /job-1/, "the row itself stays");
	assert.doesNotMatch(lines, /10s/, "the live duration is hidden");

	// Detail view: the Duration field disappears for the live job as well.
	component.handleInput("\r");
	const detail = component.render(100).join("\n");
	assert.doesNotMatch(detail, /^Duration|Duration:/m);
});

test("tick keeps render output stable within a second and repaints at the next boundary", () => {
	const running = job("run", "running", { startedAt: 1_000 });
	const { component, counts } = overlay([running]);
	component.tick(10_500);
	const before = component.render(80).join("\n");
	const renders = counts().renders;

	component.tick(10_999);
	assert.equal(counts().renders, renders);
	assert.equal(component.render(80).join("\n"), before);

	component.tick(11_000);
	assert.equal(counts().renders, renders + 1);
	assert.match(component.render(80).join("\n"), /10s/);
});

test("wide center shows concurrent lifecycle counts and selected job details", () => {
	const { component } = overlay([
		job("run", "running"),
		job("stop", "stopping"),
		job("fail", "failed"),
		job("done", "completed"),
		job("kill", "killed"),
	]);
	const text = component.render(120).join("\n");
	assert.match(text, /Background jobs · 5 total/);
	assert.match(text, /1 running/);
	assert.match(text, /1 stopping/);
	assert.match(text, /1 failed/);
	assert.match(text, /2 finished/);
	assert.match(text, /run/);
	assert.match(text, /PID/);
	assert.match(text, /\/tmp\/run\.log/);
});

test("Enter opens detailed output tail and Esc returns before closing", () => {
	const longOutput = Array.from({ length: 40 }, (_, index) => `line-${index}`).join("\n");
	const { component, counts } = overlay([
		job("run", "running", { outputTail: longOutput, command: `node -e "${"x".repeat(300)}"` }),
	]);
	component.handleInput("\r");
	const detail = component.render(80);
	const text = detail.join("\n");
	assert.match(text, /Command/);
	assert.match(text, /Output tail/);
	assert.match(text, /earlier line/);
	assert.match(text, /line-39/);
	assert.ok((text.match(/line-\d+/g) ?? []).length <= 18, "long output is capped inside the overlay");

	component.handleInput("\x1b");
	assert.equal(counts().closes, 0);
	assert.match(component.render(80).join("\n"), /Enter detail/);
	component.handleInput("\x1b");
	assert.equal(counts().closes, 1);
});

test("the refresh acknowledgement expires on its own after the window", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const { component, counts } = overlay([job("run", "running")]);
	component.handleInput("\x12");
	assert.match(component.render(60).join("\n"), /refreshing/);
	const before = counts().renders;
	t.mock.timers.tick(REFRESH_ACK_MS + 50);
	assert.ok(counts().renders > before, "ack expiry schedules its own repaint");
	assert.doesNotMatch(component.render(60).join("\n"), /refreshing/, "ack is gone without any event");
	t.mock.timers.reset();
});

test("keyboard navigation wraps and refresh requests a new authoritative snapshot", () => {
	const { component, counts } = overlay([job("first", "running"), job("second", "completed")]);
	component.handleInput("\x1b[A");
	assert.match(component.render(60).join("\n"), /› ✓ 2\/2/);
	component.handleInput("\x12");
	assert.equal(counts().refreshes, 1);
	assert.ok(counts().renders >= 2);
	// The snapshot arrives asynchronously, so the keypress must be acknowledged now.
	assert.match(component.render(60).join("\n"), /refreshing/);
});

test("selection follows job identity when live status reorders the list", () => {
	const jobs = [job("first", "running"), job("second", "running")];
	const { component } = overlay(jobs);
	component.render(60);
	component.handleInput("\x1b[B");
	jobs.splice(0, jobs.length, jobs[1], job("failed", "failed"), jobs[0]);
	assert.match(component.render(60).join("\n"), /› ● 1\/3 · running .* second/);
});

// Letters stay reserved for a future filter/command mode per the terminal
// keybinding spec, so none of them may act as a global accelerator.
test("plain letters are inert so they stay available for a filter mode", () => {
	const { component, counts } = overlay([job("first", "running"), job("second", "completed")]);
	component.render(60);
	const before = component.render(60).join("\n");
	for (const letter of ["j", "k", "r", "q", "/"]) component.handleInput(letter);
	assert.equal(counts().refreshes, 0);
	assert.equal(counts().closes, 0);
	assert.equal(component.render(60).join("\n"), before);
});

test("empty and narrow overlays stay width-bounded", () => {
	const { component } = overlay([]);
	assert.match(component.render(80).join("\n"), /no background jobs/);
	for (const width of [1, 8, 16, 19]) {
		const lines = component.render(width);
		assert.equal(lines.length, 1);
		assert.ok(visibleWidth(lines[0]) <= width);
	}
});
