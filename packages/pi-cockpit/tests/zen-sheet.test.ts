import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { MaestroUiStateSnapshotV1 } from "../src/public/v1/events.ts";
import { resolveGlyphs } from "../src/icons.ts";
import type { TodoItem } from "../src/types.ts";
import {
	ZenSheet,
	buildZenMissionSheet,
	buildZenRunSheet,
	buildZenSwarmSheet,
	buildZenTaskSheet,
	type ZenSheetDocument,
} from "../src/zen-sheet.ts";
import { cockpitTuiLocale } from "../src/tui-i18n.ts";

cockpitTuiLocale.setLocale("en");

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const snapshot: MaestroUiStateSnapshotV1 = {
	version: 1,
	sessionGeneration: "s1",
	revision: 1,
	publishedAt: 1_000,
	workflow: {
		session: { id: "session-1", label: "Ship Zen", status: "running" },
		run: { id: "run-1", command: "implement sheets", status: "running" },
		chain: { completed: 2, running: 1, pending: 2, total: 5 },
		gates: { passed: 1, total: 2 },
		next: "verify overlays",
	},
	goals: [{
		id: "goal-1",
		objective: "Complete cockpit Zen",
		status: "paused",
		pauseReason: "Need operator decision",
		iteration: 3,
		tokensUsed: 1_200,
		tokenBudget: 4_000,
		timeUsedSeconds: 75,
		startedAt: 100,
		updatedAt: 200,
	}],
	currentGoalId: "goal-1",
	swarm: null,
	mode: "act",
};

const task: TodoItem = {
	id: "42",
	subject: "Wire Enter drill-down",
	status: "blocked",
	blockedBy: ["41"],
	createdBy: { id: "root", label: "root" },
	assignee: { id: "worker", label: "worker" },
	skills: [{ name: "ui", role: "primary" }],
	updatedAt: 1_000,
};

function sheet(document: ZenSheetDocument | undefined, terminalRows = 20) {
	let closes = 0;
	let renders = 0;
	const component = new ZenSheet({
		getDocument: () => document,
		requestRender: () => { renders++; },
		close: () => { closes++; },
		theme,
		glyphs: resolveGlyphs("nerd"),
		getTerminalRows: () => terminalRows,
	});
	return { component, counts: () => ({ closes, renders }) };
}

test("mission sheet projects workflow and goal fields into one document", () => {
	const document = buildZenMissionSheet(snapshot)!;
	assert.equal(document.breadcrumb, "MISSION / DETAILS");
	assert.equal(document.title, "Ship Zen");
	const text = document.fields.map((field) => `${field.label}:${field.value}`).join("\n");
	assert.match(text, /session:session-1/);
	assert.match(text, /goal:goal-1/);
	assert.match(text, /gates:1\/2/);
	assert.match(text, /tokens:1200 \/ 4000/);
	assert.match(text, /pause:Need operator decision/);
});

test("run and task documents keep entity-specific fields", () => {
	const run = buildZenRunSheet(snapshot)!;
	assert.equal(run.breadcrumb, "WORK / RUN");
	assert.equal(run.title, "implement sheets");
	assert.ok(run.fields.some((field) => field.label === "next" && field.value === "verify overlays"));

	const todo = buildZenTaskSheet(task)!;
	assert.equal(todo.breadcrumb, "WORK / TASK");
	assert.equal(todo.title, "Wire Enter drill-down");
	const text = todo.fields.map((field) => `${field.label}:${field.value}`).join("\n");
	assert.match(text, /assignee:@worker/);
	assert.match(text, /blocked by:41/);
	assert.match(text, /skills:ui/);
});

test("swarm document summarizes workers and best result", () => {
	const document = buildZenSwarmSheet({
		...snapshot,
		swarm: {
			sessionId: "swarm-1",
			objective: "Review Zen",
			status: "running",
			iteration: 2,
			maxIterations: 4,
			workers: [{ id: "w1", label: "reviewer", status: "running" }],
			best: { iteration: 1, score: 0.9, summary: "clean" },
			updatedAt: 1_000,
		},
	})!;
	assert.equal(document.breadcrumb, "ACTORS / SWARM");
	assert.equal(document.title, "Review Zen");
	const text = document.fields.map((field) => `${field.label}:${field.value}`).join("\n");
	assert.match(text, /workers:reviewer \(running\)/);
	assert.match(text, /best:0\.9 · clean/);
});

test("builders return undefined when their entity is absent", () => {
	assert.equal(buildZenMissionSheet(undefined), undefined);
	assert.equal(buildZenRunSheet({ ...snapshot, workflow: null }), undefined);
	assert.equal(buildZenSwarmSheet({ ...snapshot, swarm: null }), undefined);
	assert.equal(buildZenTaskSheet(undefined), undefined);
});

test("sheet renders a bounded card across narrow and wide widths", () => {
	const document = buildZenMissionSheet(snapshot);
	const { component } = sheet(document);
	for (const width of [1, 10, 19, 20, 40, 80, 120]) {
		for (const line of component.render(width)) {
			assert.ok(visibleWidth(line) <= Math.min(width, 100), `${visibleWidth(line)} > ${width}`);
		}
	}
	assert.match(component.render(80).join("\n"), /MISSION \/ DETAILS/);
	assert.match(component.render(80).join("\n"), /Ship Zen/);
});

test("sheet scrolls within terminal height and Escape closes", () => {
	const document: ZenSheetDocument = {
		breadcrumb: "WORK / TASK",
		title: "Long task",
		fields: Array.from({ length: 20 }, (_, index) => ({ label: `field-${index}`, value: `value-${index}` })),
	};
	const { component, counts } = sheet(document, 10);
	const before = component.render(60).join("\n");
	assert.doesNotMatch(before, /value-19/);
	component.handleInput("\x1b[6~");
	assert.ok(counts().renders > 0);
	const after = component.render(60).join("\n");
	assert.notEqual(after, before);
	component.handleInput("\x1b");
	assert.equal(counts().closes, 1);
});

test("End reaches wrapped tail content at the actual rendered width", () => {
	const document: ZenSheetDocument = {
		breadcrumb: "WORK / TASK",
		title: "Wrapped task",
		fields: [
			...Array.from({ length: 7 }, (_, index) => ({ label: `f${index}`, value: `${index}-${"wrapped ".repeat(12)}` })),
			{ label: "last", value: "TAIL-7" },
		],
	};
	const { component } = sheet(document, 9);
	component.render(24);
	component.handleInput("\x1b[F");
	assert.match(component.render(24).join("\n"), /TAIL-7/);
});

test("missing live document degrades to an unavailable line", () => {
	const { component } = sheet(undefined);
	assert.match(component.render(80)[0], /no longer available/);
});
