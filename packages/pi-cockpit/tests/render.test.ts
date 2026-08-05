import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatAgentMetric, renderAgents, renderTodos, type PaintTheme, type WidthUtils } from "../src/render.ts";
import { resolveGlyphs } from "../src/icons.ts";
import type { AgentRow, TodoItem } from "../src/types.ts";

const theme: Pick<Theme, "fg"> = { fg: (_c, t) => t };
const utils: WidthUtils = {
	measure: (s) => s.length,
	clip: (s, w, e) => (s.length <= w ? s : s.slice(0, Math.max(0, w - e.length)) + e),
};
const glyphs = resolveGlyphs("nerd");
const opts = { glyphs, spin: "⠋", now: 1 };

function agent(over: Partial<AgentRow> = {}): AgentRow {
	return {
		correlationId: "abcdef12",
		agent: "explorer",
		name: "scan",
		role: "explorer",
		task: "map auth",
		status: "running",
		tail: "read x.ts",
		startedAt: 1,
		lastActivityAt: 1,
		...over,
	};
}
function todo(id: string, status: TodoItem["status"], subject = `task ${id}`): TodoItem {
	return { id, subject, status, blockedBy: [], skills: [] };
}

test("renderAgents list: one line per row, width bounded", () => {
	for (const width of [24, 40, 80, 120]) {
		const lines = renderAgents([agent(), agent({ correlationId: "zz", role: "executor", task: "impl", tail: "" })], "list", width, theme, utils, opts);
		assert.equal(lines.length, 2);
		for (const l of lines) assert.ok(utils.measure(l) <= width, `w=${width} line too long: ${l}`);
	}
});

test("renderAgents list includes connector, role, task and tail", () => {
	const line = renderAgents([agent()], "list", 120, theme, utils, opts)[0];
	assert.ok(line.includes("└─")); // single agent = last connector
	assert.ok(line.includes("explorer"));
	assert.ok(line.includes("map auth"));
	assert.ok(line.includes("read x.ts"));
	assert.ok(line.includes("⠋")); // running spinner
});

test("renderAgents shows phase and failed outcome without replacing sleeping activity", () => {
	const line = renderAgents([agent({
		status: "sleeping",
		phase: undefined,
		lastOutcome: { status: "failed", message: "provider exhausted", settledAt: 1 },
	})], "list", 160, theme, utils, opts)[0];
	assert.match(line, /sleeping/);
	assert.match(line, /last failed: provider exhausted/);

	const running = renderAgents([agent({ phase: "compacting" })], "list", 120, theme, utils, opts)[0];
	assert.match(running, /compacting/);
});

test("renderAgents hideLiveDuration drops the live elapsed but keeps frozen durations", () => {
	const rows = [
		agent({ correlationId: "live", task: "live task", status: "running", startedAt: 1_000 }),
		agent({ correlationId: "done", task: "done task", status: "done", startedAt: 1_000, finishedAt: 66_000, tail: "" }),
	];
	const plain = renderAgents(rows, "list", 120, theme, utils, { ...opts, now: 900_000 });
	assert.match(plain.find((l) => l.includes("live task"))!, /14m 59s/);
	assert.match(plain.find((l) => l.includes("done task"))!, /1m 5s/);
	const staticLines = renderAgents(rows, "list", 120, theme, utils, { ...opts, now: 900_000, hideLiveDuration: true });
	assert.doesNotMatch(staticLines.find((l) => l.includes("live task"))!, /14m 59s/);
	assert.match(staticLines.find((l) => l.includes("done task"))!, /1m 5s/, "frozen duration on a done row survives");
});

test("renderAgents static output is stable across now and covers retrying", () => {
	const retrying = agent({ correlationId: "r", task: "retry task", status: "retrying", startedAt: 1_000 });
	const a = renderAgents([retrying], "list", 120, theme, utils, { ...opts, now: 60_000, hideLiveDuration: true });
	const b = renderAgents([retrying], "list", 120, theme, utils, { ...opts, now: 90_000, hideLiveDuration: true });
	assert.equal(a[0], b[0], "static rows do not drift with now");
	assert.doesNotMatch(a[0], /\d+s/, "no live elapsed on a retrying row");
	assert.match(a[0], /retrying/, "the retrying state itself stays visible");
});

test("renderAgents freezes completed duration at finishedAt", () => {
	const completed = agent({ status: "done", startedAt: 1_000, finishedAt: 66_000 });
	const first = renderAgents([completed], "list", 120, theme, utils, { ...opts, now: 100_000 })[0];
	const later = renderAgents([completed], "list", 120, theme, utils, { ...opts, now: 900_000 })[0];
	assert.match(first, /1m 5s/);
	assert.equal(later, first);
});

test("renderAgents list follows spawnedBy parent-child hierarchy", () => {
	const lines = renderAgents([
		agent({ correlationId: "child-a", parentCorrelationId: "root", role: "executor", task: "child a" }),
		agent({ correlationId: "root", role: "planner", task: "root" }),
		agent({ correlationId: "grandchild", parentCorrelationId: "child-a", role: "reviewer", task: "grandchild" }),
		agent({ correlationId: "child-b", parentCorrelationId: "root", role: "explorer", task: "child b" }),
	], "list", 120, theme, utils, opts);
	assert.match(lines[0], /^└─ .*planner.*root/);
	assert.match(lines[1], /^  ├─ .*executor.*child a/);
	assert.match(lines[2], /^  │ └─ .*reviewer.*grandchild/);
	assert.match(lines[3], /^  └─ .*explorer.*child b/);
});

test("renderAgents orders roots and siblings by latest activity while keeping subtrees contiguous", () => {
	const lines = renderAgents([
		agent({ correlationId: "root-old", role: "planner", task: "older active root", lastActivityAt: 500 }),
		agent({ correlationId: "root-new", role: "planner", task: "newer idle root", lastActivityAt: 400 }),
		agent({ correlationId: "child-old", parentCorrelationId: "root-old", task: "older sibling", lastActivityAt: 100 }),
		agent({ correlationId: "child-new", parentCorrelationId: "root-old", task: "newer sibling", lastActivityAt: 300 }),
		agent({ correlationId: "grandchild", parentCorrelationId: "child-new", task: "grandchild", lastActivityAt: 900 }),
	], "list", 120, theme, utils, opts);
	assert.match(lines[0], /older active root/);
	assert.match(lines[1], /newer sibling/);
	assert.match(lines[2], /grandchild/);
	assert.match(lines[3], /older sibling/);
	assert.match(lines[4], /newer idle root/);
});

test("renderAgents uses correlationId as deterministic activity tie-breaker", () => {
	const lines = renderAgents([
		agent({ correlationId: "b", task: "second", lastActivityAt: 10 }),
		agent({ correlationId: "a", task: "first", lastActivityAt: 10 }),
	], "list", 120, theme, utils, opts);
	assert.match(lines[0], /first/);
	assert.match(lines[1], /second/);
});

test("renderAgents treats missing parents as roots and survives cycles", () => {
	const lines = renderAgents([
		agent({ correlationId: "orphan", parentCorrelationId: "missing", task: "orphan" }),
		agent({ correlationId: "cycle-a", parentCorrelationId: "cycle-b", task: "cycle a" }),
		agent({ correlationId: "cycle-b", parentCorrelationId: "cycle-a", task: "cycle b" }),
	], "list", 120, theme, utils, opts);
	assert.equal(lines.length, 3);
	assert.equal(lines.filter((line) => line.includes("orphan")).length, 1);
	assert.equal(lines.filter((line) => line.includes("cycle a")).length, 1);
	assert.equal(lines.filter((line) => line.includes("cycle b")).length, 1);
});

test("renderAgents exposes pending state and graph dependency without color", () => {
	const line = renderAgents([
		agent({ status: "pending", taskIndex: 2, dependencies: [0, 1], task: "verify" }),
	], "list", 120, theme, utils, opts)[0];
	assert.match(line, /pending/);
	assert.match(line, /← #1,#2/);
});

test("formatAgentMetric abbreviates values above two digits", () => {
	assert.equal(formatAgentMetric(99), "99");
	assert.equal(formatAgentMetric(100), "0.1k");
	assert.equal(formatAgentMetric(999), "1k");
	assert.equal(formatAgentMetric(1_000), "1k");
	assert.equal(formatAgentMetric(1_200), "1.2k");
	assert.equal(formatAgentMetric(24_000), "24k");
	assert.equal(formatAgentMetric(999_949), "999.9k");
	assert.equal(formatAgentMetric(999_950), "1m");
	assert.equal(formatAgentMetric(1_000_000), "1m");
	assert.equal(formatAgentMetric(2_500_000), "2.5m");
});

test("renderAgents list includes teammate tool and input/output metrics", () => {
	const line = renderAgents([agent({
		activeTool: "edit (running)",
		toolCount: 3,
		tokens: 1_290,
		inputTokens: 1_234,
		outputTokens: 56,
	})], "list", 120, theme, utils, opts)[0];
	assert.match(line, /tool edit \(running\)/);
	assert.match(line, /3 tools/);
	assert.match(line, /in 1.2k · out 56/);
	assert.doesNotMatch(line, /1290 tok/);
});

test("renderAgents falls back to compact aggregate tokens", () => {
	const line = renderAgents([agent({ tokens: 900 })], "list", 120, theme, utils, opts)[0];
	assert.match(line, /0.9k tok/);
});

test("renderAgents derives stalled and result-ready display states without mutating lifecycle status", () => {
	const stalled = renderAgents([
		agent({ task: "silent task", status: "running", lastActivityAt: 1 }),
	], "list", 120, theme, utils, { ...opts, now: 30_001 })[0];
	assert.match(stalled, /stalled/);
	assert.doesNotMatch(stalled, /⠋/);

	const ready = renderAgents([
		agent({ task: "returned task", status: "running", lastActivityAt: 1, resultReadyAt: 20_000 }),
	], "list", 120, theme, utils, { ...opts, now: 30_001 })[0];
	assert.match(ready, /result ready/);
	assert.doesNotMatch(ready, /stalled|⠋/);
});

test("renderAgents labels result dependencies with agent names when available", () => {
	const lines = renderAgents([
		agent({ correlationId: "producer", name: "research", taskIndex: 0, task: "collect" }),
		agent({ correlationId: "consumer", name: "writer", taskIndex: 1, dependencies: [0], task: "draft" }),
	], "list", 120, theme, utils, opts);
	assert.match(lines.find((line) => line.includes("draft"))!, /← @research/);
});

test("renderAgents exposes cache, fallback model, and provider diagnostics", () => {
	const line = renderAgents([agent({
		status: "retrying",
		error: "provider timeout",
		requestedModel: "primary",
		resolvedModel: "fallback",
		cacheReadTokens: 1_200,
		cacheWriteTokens: 10,
	})], "list", 180, theme, utils, opts)[0];
	assert.match(line, /provider timeout/);
	assert.match(line, /model primary→fallback/);
	assert.match(line, /cache 1.2kr\/10w/);
});

test("renderAgents treats provider/model formatting differences as the same model", () => {
	const qualifiedRequest = renderAgents([agent({
		requestedModel: "maestro-openai/gpt-5.6-sol",
		resolvedModel: "gpt-5.6-sol",
	})], "list", 180, theme, utils, opts)[0];
	assert.match(qualifiedRequest, /model maestro-openai\/gpt-5\.6-sol/);
	assert.doesNotMatch(qualifiedRequest, /→/);

	const bareRequest = renderAgents([agent({
		requestedModel: "gpt-5.6-sol",
		resolvedModel: "maestro-openai/gpt-5.6-sol",
	})], "list", 180, theme, utils, opts)[0];
	assert.match(bareRequest, /model maestro-openai\/gpt-5\.6-sol/);
	assert.doesNotMatch(bareRequest, /→/);

	const realFallback = renderAgents([agent({
		requestedModel: "maestro-openai/gpt-5.6-sol",
		resolvedModel: "maestro-qwen/qwen3.8-max-preview",
	})], "list", 180, theme, utils, opts)[0];
	assert.match(realFallback, /model maestro-openai\/gpt-5\.6-sol→maestro-qwen\/qwen3\.8-max-preview/);
});

test("renderAgents list caps at 8 visible + overflow", () => {
	const agents = Array.from({ length: 9 }, (_, i) => agent({ correlationId: `id${i}xxx`, task: `task ${i}` }));
	const lines = renderAgents(agents, "list", 120, theme, utils, opts);
	assert.equal(lines.length, 9); // 8 visible + 1 overflow
	assert.ok(lines[8].includes("1 more"));
});

test("renderAgents keeps deep long-text rows bounded at narrow widths", () => {
	const rows = Array.from({ length: 12 }, (_, index) => agent({
		correlationId: `node-${index}`,
		parentCorrelationId: index === 0 ? undefined : `node-${index - 1}`,
		task: `任务 ${index} 🚀 ${"very-long-text ".repeat(8)}`,
		inputTokens: 12_345,
		outputTokens: 678,
	}));
	for (const width of [1, 8, 16, 24, 40]) {
		const lines = renderAgents(rows, "list", width, theme, utils, opts);
		for (const line of lines) assert.ok(utils.measure(line) <= width, `w=${width}: ${line}`);
	}
});

test("renderAgents caps a 1000-row roster without rendering the full dataset", () => {
	const rows = Array.from({ length: 1000 }, (_, index) => agent({
		correlationId: `large-${index}`,
		task: `task ${index}`,
	}));
	const lines = renderAgents(rows, "list", 120, theme, utils, opts);
	assert.equal(lines.length, 9);
	assert.ok(lines.at(-1)?.includes("992 more"));
});

test("renderAgents compact: single summary line, width bounded", () => {
	const lines = renderAgents([agent(), agent()], "compact", 80, theme, utils, opts);
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes("2"));
	assert.ok(lines[0].includes("2 active"));
	assert.ok(lines[0].includes("explorer"));
	assert.ok(utils.measure(lines[0]) <= 80);
});

test("renderAgents compact clips to narrow width", () => {
	const lines = renderAgents([agent(), agent()], "compact", 20, theme, utils, opts);
	assert.equal(lines.length, 1);
	assert.ok(utils.measure(lines[0]) <= 20);
});

test("renderAgents empty roster yields no lines (bare-pi guard)", () => {
	assert.deepEqual(renderAgents([], "list", 80, theme, utils, opts), []);
	assert.deepEqual(renderAgents([], "compact", 80, theme, utils, opts), []);
});

test("renderAgents unknown role falls back without throwing", () => {
	assert.doesNotThrow(() => renderAgents([agent({ role: "mystery" })], "list", 80, theme, utils, opts));
});

test("renderTodos list: summary first + sorted rows + glyphs", () => {
	const lines = renderTodos([todo("0", "completed"), todo("1", "in_progress"), todo("2", "blocked"), todo("3", "pending")], "list", 80, theme, utils, opts);
	assert.equal(lines.length, 5); // 1 summary + 4 items
	// summary is first line
	const summary = lines[0];
	assert.ok(summary.includes("Todo"));
	assert.ok(summary.includes("»"));
	// ordered by status priority (active first), then creation order
	assert.doesNotMatch(lines[1], /□/, "#1 in_progress carries no box marker");
	assert.ok(lines[1].includes("task 1"), "#1 in_progress still renders its subject");
	assert.ok(lines[2].includes("!"));  // #2 blocked
	assert.ok(lines[3].includes("○"));  // #3 pending
	assert.ok(lines[4].includes("✓"));  // #0 completed
	for (const l of lines) assert.ok(utils.measure(l) <= 80);
});

test("renderTodos paints status on hue, weight and strikethrough", () => {
	const painted: PaintTheme = {
		fg: (color, text) => `[${color}]${text}[/]`,
		bold: (text) => `<b>${text}</b>`,
		strikethrough: (text) => `<s>${text}</s>`,
	};
	const wide: WidthUtils = { measure: (s) => s.length, clip: (s) => s };
	const lines = renderTodos(
		[todo("0", "completed"), todo("1", "in_progress"), todo("2", "blocked"), todo("3", "pending")],
		"list",
		400,
		painted,
		wide,
		opts,
	);
	// Rows follow status priority: in_progress, blocked, pending, completed.
	// The running row is the only one carrying weight, and it owns warning — accent
	// stays reserved for role identity.
	assert.ok(lines[1].includes("<b>[text]task 1[/]</b>"));
	assert.ok(lines[1].includes("[warning] [/]"), "in-progress leading glyph is a coloured space, not a box");
	assert.ok(!lines[1].includes("[accent]"));
	assert.ok(lines[2].includes("[error]!"));
	assert.ok(lines[3].includes("[accent]○[/]"));
	assert.ok(lines[3].includes("[text]task 3[/]"));
	// A completed subject is struck through and dimmed; the check glyph stays green.
	assert.ok(lines[4].includes("<s>[dim]task 0[/]</s>"));
	assert.ok(lines[4].includes("[success]✓[/]"));
	// Nothing but the completed row is struck.
	for (const line of [lines[1], lines[2], lines[3]]) assert.ok(!line.includes("<s>"));
});

test("renderTodos degrades when the theme exposes no weight or strikethrough", () => {
	const lines = renderTodos([todo("0", "completed"), todo("1", "in_progress")], "list", 200, theme, utils, opts);
	assert.ok(lines.some((line) => line.includes("task 0")));
	assert.ok(lines.some((line) => line.includes("task 1")));
});

test("renderTodos list collapsed: summary only", () => {
	const collapsed = { ...opts, expanded: false };
	const lines = renderTodos([todo("0", "completed"), todo("1", "in_progress"), todo("2", "pending")], "list", 80, theme, utils, collapsed);
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes("Todo"));
	assert.ok(lines[0].includes("task 1"), "collapsed summary keeps the next actionable task");
	assert.ok(lines[0].includes("Alt+T expand"));
});

test("renderTodos collapsed line includes running state, member count and assignee", () => {
	const running: TodoItem = {
		...todo("#0", "in_progress", "implement"),
		assignee: { id: "worker-1", label: "executor" },
	};
	const pending: TodoItem = {
		...todo("#1", "pending", "verify"),
		assignee: { id: "worker-2", label: "reviewer" },
	};
	const line = renderTodos([running, pending], "list", 160, theme, utils, { ...opts, expanded: false })[0];
	assert.match(line, /1 running/);
	assert.match(line, /2 members/);
	assert.match(line, /@executor implement/);
	assert.doesNotMatch(line, /□/, "the next-task pointer drops the box marker");
});

test("renderTodos mirrors actor, primary skill and blocked dependency details", () => {
	const dependency = todo("#0", "in_progress", "implement");
	const blocked: TodoItem = {
		...todo("#1", "blocked", "verify"),
		blockedBy: ["#0", "#missing"],
		createdBy: { id: "root", label: "root" },
		assignee: { id: "worker-1", label: "executor" },
		skills: [
			{ name: "security-audit", role: "guard" },
			{ name: "team-testing", role: "primary" },
		],
	};
	const lines = renderTodos([dependency, blocked], "list", 160, theme, utils, opts);
	const line = lines.find((candidate) => candidate.includes("verify"))!;
	assert.match(line, /@root→@executor/);
	assert.match(line, /\/team-testing \+1/);
	assert.match(line, /←\s+implement/);
	assert.doesNotMatch(line, /□/, "blocked dependency reference drops the box marker");
	assert.match(line, /← \? \?/);
});

test("renderTodos collapsed next task skips pending items with dependencies", () => {
	const waiting = { ...todo("#0", "pending", "waiting"), blockedBy: ["#9"] };
	const actionable = todo("#1", "pending", "actionable");
	const line = renderTodos([waiting, actionable], "list", 100, theme, utils, { ...opts, expanded: false })[0];
	assert.ok(line.includes("actionable"));
	assert.ok(!line.includes("waiting"));
});

test("renderTodos list caps at 8 visible + overflow", () => {
	const items = Array.from({ length: 12 }, (_, i) => todo(String(i), "pending" as const));
	const lines = renderTodos(items, "list", 80, theme, utils, opts);
	assert.equal(lines.length, 10); // 1 summary + 8 visible + 1 overflow
	assert.ok(lines[9].includes("4 more"));
});

test("renderTodos compact: bar + percent, width bounded", () => {
	for (const width of [16, 30, 60]) {
		const lines = renderTodos([todo("0", "completed"), todo("1", "in_progress"), todo("2", "pending")], "compact", width, theme, utils, opts);
		assert.equal(lines.length, 1);
		assert.ok(lines[0].includes("%"));
		assert.ok(utils.measure(lines[0]) <= width, `w=${width}: ${lines[0]}`);
		if (width === 60) assert.ok(lines[0].includes("Alt+T expand"));
	}
});

test("renderTodos clips long CJK, emoji, actor and dependency content", () => {
	const dependency = todo("#0", "pending", `前置任务 🚧 ${"很长".repeat(40)}`);
	const blocked: TodoItem = {
		...todo("#1", "blocked", `验证任务 🧪 ${"内容".repeat(40)}`),
		blockedBy: ["#0"],
		assignee: { id: "worker", label: `执行者${"甲".repeat(20)}` },
		skills: [{ name: `team-testing-${"x".repeat(40)}`, role: "primary" }],
	};
	for (const width of [1, 8, 16, 24, 40]) {
		const lines = renderTodos([dependency, blocked], "list", width, theme, utils, opts);
		for (const line of lines) assert.ok(utils.measure(line) <= width, `w=${width}: ${line}`);
	}
});

test("renderTodos empty yields no lines", () => {
	assert.deepEqual(renderTodos([], "list", 80, theme, utils, opts), []);
});
