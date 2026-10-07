import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	renderFooter,
	getUsageTotals,
	invalidateUsageCache,
	setUsageThrottle,
	fmtTokens,
	fmtCost,
	renderBar,
	type FooterParts,
	type WidthUtils,
} from "../src/footer.ts";
import { resolveGlyphs } from "../src/icons.ts";

// Hermetic width utils: mock theme strips no ansi, so visible width == string length.
const theme: Pick<Theme, "fg"> = { fg: (_c, t) => t };
const utils: WidthUtils = {
	measure: (s) => s.length,
	clip: (s, w, e) => (s.length <= w ? s : s.slice(0, Math.max(0, w - e.length)) + e),
};
const glyphs = resolveGlyphs("nerd");

function parts(over: Partial<FooterParts> = {}): FooterParts {
	return {
		model: "stream-70b",
		provider: "pi",
		ctxPct: 42,
		ctxTokens: 84000,
		ctxWindow: 200000,
		totals: { input: 12000, output: 3400, cacheRead: 0, cacheWrite: 0, cost: 0.52, latestCacheHitRate: undefined },
		git: "main",
		width: 80,
		glyphs,
		theme,
		utils,
		...over,
	};
}

test("getUsageTotals uses a 500ms throttle by default", (t) => {
	invalidateUsageCache();
	t.after(() => {
		setUsageThrottle(() => 0);
		invalidateUsageCache();
	});
	const entry = (input: number) => ({
		type: "message",
		message: { role: "assistant", usage: { input, output: 1 } },
	});
	const entries = [entry(10), entry(20), entry(30)];

	assert.equal(getUsageTotals(entries, 1_000).input, 60);
	entries[1].message.usage.input = 25;
	assert.equal(getUsageTotals(entries, 1_499).input, 60, "same-key totals stay cached inside 500ms");
	assert.equal(getUsageTotals(entries, 1_500).input, 65, "same-key totals refresh at the wall-clock limit");
});

test("getUsageTotals keeps entry-key changes immediate while throttling same-key refreshes", (t) => {
	invalidateUsageCache();
	setUsageThrottle(() => 10_000);
	t.after(() => {
		setUsageThrottle(() => 0);
		invalidateUsageCache();
	});
	const entry = (input: number) => ({
		type: "message",
		message: { role: "assistant", usage: { input, output: 1 } },
	});
	const entriesA = [entry(10)];
	const entriesB = [entry(10), entry(20), entry(30)];

	assert.equal(getUsageTotals(entriesA, 1_000).input, 10);
	assert.equal(getUsageTotals(entriesB, 5_000).input, 60, "a changed entries key recomputes immediately");
	entriesB[1].message.usage.input = 25;
	assert.equal(getUsageTotals(entriesB, 6_000).input, 60, "same-key totals stay cached inside the window");
	assert.equal(getUsageTotals(entriesB, 14_999).input, 60);
	assert.equal(getUsageTotals(entriesB, 15_000).input, 65);
	const entriesC = [...entriesB, entry(40)];
	assert.equal(getUsageTotals(entriesC, 16_000).input, 105, "a newer entries key bypasses the window");
});

test("getUsageTotals sums assistant usage and skips the rest", () => {
	invalidateUsageCache();
	const t = getUsageTotals([
		{ type: "message", message: { role: "assistant", usage: { input: 10, output: 5, cost: { total: 0.1 } } } },
		{ type: "message", message: { role: "user" } },
		{ type: "message", message: { role: "assistant", usage: { input: 20, output: 7, cacheRead: 3, cost: { total: 0.2 } } } },
		{ type: "message", message: { role: "assistant" } },
		{ type: "custom" },
	]);
	assert.equal(t.input, 30);
	assert.equal(t.output, 12);
	assert.equal(t.cacheRead, 3);
	assert.ok(Math.abs(t.cost - 0.3) < 1e-9, `cost float drift: ${t.cost}`);
});

test("getUsageTotals refreshes when the latest entry usage changes in place", () => {
	invalidateUsageCache();
	const entries = [
		{
			id: "m1",
			type: "message",
			message: {
				role: "assistant",
				usage: { input: 10, output: 1, cost: { total: 0.1 } },
			},
		},
	];
	const first = getUsageTotals(entries);
	entries[0].message.usage.output = 9;
	entries[0].message.usage.cost.total = 0.9;
	const second = getUsageTotals(entries);
	assert.equal(first.output, 1);
	assert.equal(second.output, 9);
	assert.equal(second.cost, 0.9);
});

test("renderFooter reserves the terminal's final column across widths", () => {
	for (let width = 1; width <= 120; width++) {
		const lines = renderFooter(parts({
			width,
			extensionStatuses: [
				{ key: "mode", text: "PLAN" },
				{ key: "maestro-auto-compact", text: "CTX 72%" },
			],
		}));
		assert.ok(lines.length === 1 || lines.length === 2);
		const liveWidth = Math.max(1, width - 1);
		for (const l of lines) assert.ok(utils.measure(l) <= liveWidth, `width ${width}: line used the final column (${utils.measure(l)}): ${l}`);
	}
});

test("renderFooter with empty totals does not throw", () => {
	assert.doesNotThrow(() => renderFooter(parts({ totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined } })));
});

test("renderFooter width<=0 returns a single empty line", () => {
	assert.deepEqual(renderFooter(parts({ width: 0 })), [""]);
});

test("ascii vs nerd bar uses different glyphs", () => {
	const nerdG = resolveGlyphs("nerd");
	const asciiG = resolveGlyphs("ascii");
	const nerd = renderBar(50, 6, nerdG, theme);
	const ascii = renderBar(50, 6, asciiG, theme);
	assert.ok(nerd.includes("█") && nerd.includes("░"));
	assert.ok(ascii.includes("#") && ascii.includes("-"));
});

test("no context window omits the gauge from the resource line", () => {
	const lines = renderFooter(parts({ ctxWindow: 0 }));
	assert.ok(!lines[0].includes("%"));
});

test("context and token usage form one right-aligned resource group on line one", () => {
	const lines = renderFooter(parts({
		width: 100,
		ctxPct: 20,
		ctxTokens: 80600,
		ctxWindow: 400000,
		totals: {
			input: 84800,
			output: 21000,
			cacheRead: 99,
			cacheWrite: 0,
			cost: 0,
			latestCacheHitRate: 99,
		},
	}));
	assert.equal(lines.length, 1);
	assert.match(lines[0], /^⚡ stream-70b ·  main/);
	assert.match(lines[0], /\[██░░░░░░░░\] 20% · 80\.6k\/400k · ↑84\.8k · ↓21k · ⚡99%$/);
});

test("Codex Fast appears beside the model on line one without a duplicate status row", () => {
	const lines = renderFooter(parts({
		width: 120,
		model: "gpt-5.6-sol",
		thinking: "high",
		extensionStatuses: [
			{ key: "approval-mode", text: "APPROVAL YOLO" },
			{ key: "codex-fast", text: "Codex Fast: on" },
		],
	}));
	assert.equal(lines.length, 1);
	assert.match(lines[0], /^YOLO · ⚡ gpt-5\.6-sol · FAST · high/);
	assert.equal(lines[0].match(/FAST/g)?.length, 1);
	assert.doesNotMatch(lines[0], /Codex Fast: on/);

	const disabled = renderFooter(parts({ model: "gpt-5.6-sol", thinking: "high" }));
	assert.doesNotMatch(disabled.join("\n"), /FAST/);
});

test("Codex Fast is success-colored, never partially clipped, and preserves unsafe approval priority", () => {
	const colored = renderFooter(parts({
		width: 160,
		theme: { fg: (color, text) => `[${color}]${text}` },
		extensionStatuses: [{ key: "codex-fast", text: "Codex Fast: on" }],
	}));
	assert.match(colored[0], /\[success\]FAST/);
	for (let width = 1; width <= 120; width++) {
		const lines = renderFooter(parts({
			width,
			thinking: "high",
			extensionStatuses: [
				{ key: "approval-mode", text: "APPROVAL YOLO" },
				{ key: "codex-fast", text: "Codex Fast: on" },
			],
		}));
		assert.equal(lines.length, 1);
		assert.ok(lines[0].length <= Math.max(1, width - 1));
		assert.doesNotMatch(lines[0], /(?:F|FA|FAS)…/);
		if (width >= 5) assert.match(lines[0], /YOLO/);
	}
});

test("medium footer uses the compact five-cell context bar", () => {
	const lines = renderFooter(parts({
		width: 60,
		totals: { input: 12000, output: 3400, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined },
	}));
	assert.equal(lines.length, 1);
	assert.match(lines[0], /\[██░░░\] 42% · 84k\/200k · ↑12k · ↓3\.4k$/);
	assert.doesNotMatch(lines[0], /\[████░░░░░░\]/);
});

test("overlong model is clipped within width", () => {
	const lines = renderFooter(parts({ width: 30, model: "a-very-long-model-name-that-should-be-truncated", provider: "some-provider" }));
	for (const l of lines) assert.ok(utils.measure(l) <= 30);
});

test("footer omits provider while retaining the active model", () => {
	const lines = renderFooter(parts({ width: 100, model: "qwen3-coder", provider: "maestro-qwen" }));
	assert.match(lines[0], /qwen3-coder/);
	assert.doesNotMatch(lines.join("\n"), /maestro-qwen/);
});

test("narrow footer simplifies the resource group before dropping identity", () => {
	const lines = renderFooter(parts({ width: 20 }));
	assert.equal(lines.length, 1);
	assert.match(lines[0], /^⚡ stream-70b/);
	assert.match(lines[0], /42%$/);
	assert.doesNotMatch(lines[0], /\[/);
});

	test("approval mode leads line one while usage stays right aligned", () => {
	const lines = renderFooter(parts({
		width: 80,
		extensionStatuses: [{ key: "approval-mode", text: "APPROVAL YOLO" }],
	}));
	assert.equal(lines.length, 1);
	assert.match(lines[0], /^YOLO · ⚡ stream-70b/);
	assert.equal(lines[0].length, 79);
	assert.match(lines[0], /↑12k · ↓3\.4k · \$0\.52$/);
});

test("auto compact stays hidden while approval remains at the start of line one", () => {
	const lines = renderFooter(parts({
		width: 100,
		extensionStatuses: [
			{ key: "approval-mode", text: "APPROVAL default" },
			{ key: "maestro-auto-compact-mode", text: "AUTO ON" },
		],
	}));
	assert.equal(lines.length, 1);
	assert.match(lines[0], /^APPROVAL default · ⚡ stream-70b/);
	assert.doesNotMatch(lines.join("\n"), /AUTO COMPACT|AUTO ON/);
	assert.equal(lines[0].length, 99);
	assert.match(lines[0], /↑12k · ↓3\.4k · \$0\.52$/);
});

test("footer shows monetary cost on the resource line once pricing is registered", () => {
	const lines = renderFooter(parts({ cwd: "~/work/project", width: 100 }));
	assert.match(lines[0], /^⚡ stream-70b ·  ~\/work\/project/);
	assert.match(lines[0], /↑12k/);
	assert.match(lines[0], /↓3.4k/);
	assert.match(lines[0], /\$0\.52$/);
});

test("footer omits monetary cost when the channel has no pricing (cost 0)", () => {
	const lines = renderFooter(parts({
		cwd: "~/work/project",
		width: 100,
		totals: { input: 12000, output: 3400, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined },
	}));
	assert.doesNotMatch(lines.join("\n"), /\$/);
	assert.match(lines[0], /↑12k · ↓3\.4k$/);
});

test("footer converts cost to CNY with the configured rate", () => {
	const lines = renderFooter(parts({ width: 100, currency: "cny", currencyRate: 7.2 }));
	assert.match(lines[0], /¥3\.74$/);
	assert.doesNotMatch(lines[0], /\$0\.52$/);
});

test("footer keeps USD by default and for an explicit usd currency", () => {
	const lines = renderFooter(parts({ width: 100, currency: "usd" }));
	assert.match(lines[0], /\$0\.52$/);
	assert.doesNotMatch(lines[0], /¥/);
});

test("footer treats an unusable rate as 1:1 and stays CNY", () => {
	const lines = renderFooter(parts({ width: 100, currency: "cny", currencyRate: 0 }));
	assert.match(lines[0], /¥0\.52$/);
});

test("footer uses a coherent nerd icon set for model, workspace and git", () => {
	const lines = renderFooter(parts({ cwd: "~/work/project", git: "main", width: 120 }));
	assert.match(lines[0], /^⚡ stream-70b ·  ~\/work\/project ·  main/);
});

test("footer keeps readable ASCII icon fallbacks", () => {
	const lines = renderFooter(parts({ glyphs: resolveGlyphs("ascii"), cwd: "~/work/project", git: "main", width: 120 }));
	assert.match(lines[0], /^~ stream-70b \| \[\] ~\/work\/project \| git main/);
});

test("approval modes use distinct semantic colors", () => {
	const colorTheme: Pick<Theme, "fg"> = { fg: (color, text) => `[${color}]${text}` };
	const renderMode = (text: string): string => renderFooter(parts({
		theme: colorTheme,
		extensionStatuses: [{ key: "approval-mode", text }],
	}))[0];
	assert.match(renderMode("APPROVAL default"), /\[text\]APPROVAL default/);
	assert.match(renderMode("APPROVAL acceptEdits"), /\[success\]APPROVAL acceptEdits/);
	assert.match(renderMode("APPROVAL dontAsk"), /\[warning\]APPROVAL dontAsk/);
	assert.match(renderMode("APPROVAL plan"), /\[accent\]APPROVAL plan/);
	assert.match(renderMode("APPROVAL YOLO"), /\[error\]YOLO/);
	assert.match(renderMode("APPROVAL bypassPermissions"), /\[error\]YOLO/);
	assert.doesNotMatch(renderMode("APPROVAL YOLO"), /!/);
});

test("an unsafe approval mode survives when the status row must be truncated", () => {
	const statuses = [
		{ key: "a-noise", text: "some long informational status" },
		{ key: "approval-mode", text: "APPROVAL yolo" },
		{ key: "z-noise", text: "another long informational status" },
	];
	const lines = renderFooter(parts({ width: 30, extensionStatuses: statuses }));
	assert.match(lines[0], /YOLO/);
});

test("ACT is omitted while PLAN and READY retain distinct semantic colors", () => {
	const colorTheme: Pick<Theme, "fg"> = { fg: (color, text) => `[${color}]${text}` };
	const renderMode = (text: string): string => renderFooter(parts({
		theme: colorTheme,
		extensionStatuses: [{ key: "mode", text }],
	})).at(-1)!;
	assert.doesNotMatch(renderMode("ACT"), /ACT/);
	assert.match(renderMode("PLAN"), /\[warning\]PLAN/);
	assert.match(renderMode("READY"), /\[accent\]READY/);
});

test("internal swarm projection statuses stay out of the footer", () => {
	const line = renderFooter(parts({
		extensionStatuses: [
			{ key: "team-swarm", text: "TEAM SWARM 3/4" },
			{ key: "swarm-best", text: "BEST 89%" },
			{ key: "swarm-state", text: "COMPLETED" },
			{ key: "approval-mode", text: "APPROVAL YOLO" },
		],
	})).join("\n");
	assert.doesNotMatch(line, /TEAM SWARM|BEST|COMPLETED/);
	assert.match(line, /YOLO/);
});

test("ambient MCP and auto compact statuses stay out of the footer", () => {
	const line = renderFooter(parts({
		extensionStatuses: [
			{ key: "mcp", text: "MCP: 0/3 servers" },
			{ key: "maestro-auto-compact-mode", text: "AUTO ON" },
			{ key: "mode", text: "PLAN" },
		],
	})).join("\n");
	assert.doesNotMatch(line, /MCP:|AUTO COMPACT|AUTO ON/);
	assert.match(line, /PLAN/);
});

test("decision policy status uses the existing second footer line without displacing resource identity", () => {
	for (const text of ["DEC ○ A:enforce E:shadow · auto", "DEC ▶ A:enforce E:shadow · LLM 问答 判别中", "DEC ? A:enforce E:shadow · LLM 问答 等待用户", "DEC ✓ A:enforce E:shadow · LLM 内部建议"]) {
		const lines = renderFooter(parts({ width: 160, extensionStatuses: [{ key: "decision-policy", text }] }));
		assert.equal(lines.length, 2);
		assert.match(lines[0], /stream-70b/);
		assert.doesNotMatch(lines[0], /DEC/);
		assert.ok(lines[1].includes(text));
	}
});

test("ambient policy states and duplicate effort metadata stay out of the footer", () => {
	const lines = renderFooter(parts({
		width: 160,
		thinking: "high",
		extensionStatuses: [
			{ key: "decision-policy", text: "DEC ○ 未配置" },
			{ key: "maestro-effort", text: "high · model=global" },
			{ key: "maestro-plan-auto", text: "PLAN-AUTO off" },
			{ key: "self-evolve", text: "EVOL ● 0·0·0" },
		],
	}));
	assert.equal(lines.length, 2);
	assert.equal(lines.join("\n").match(/high/g)?.length, 1);
	assert.doesNotMatch(lines.join("\n"), /DEC|model=|PLAN-AUTO/);
	assert.equal(lines[1], "EVOL ● 0·0·0");

	const disabled = renderFooter(parts({ extensionStatuses: [
		{ key: "decision-policy", text: "DEC ○ A:off E:off" },
		{ key: "maestro-plan-auto", text: "PLAN-AUTO off" },
		{ key: "self-evolve", text: "EVOL off" },
	] }));
	assert.equal(disabled.length, 1);
});

test("policy activity and errors remain visible even without configured automation", () => {
	for (const text of [
		"DEC ? 未配置 · 问答 等待用户",
		"DEC ? A:off E:off · 配置中",
		"DEC ! 规范无效",
		"DEC ! A:enforce E:shadow · LLM · 已降级",
	]) {
		const lines = renderFooter(parts({ width: 160, extensionStatuses: [{ key: "decision-policy", text }] }));
		assert.equal(lines[1], text);
	}
});

test("automation markers use theme semantic colors with muted labels and counters", () => {
	const coloredTheme: Pick<Theme, "fg"> = { fg: (color, text) => `<${color}>${text}</${color}>` };
	for (const [mark, color] of [["○", "muted"], ["▶", "warning"], ["?", "accent"], ["✓", "success"], ["!", "error"]]) {
		const lines = renderFooter(parts({ width: 400, theme: coloredTheme, extensionStatuses: [
			{ key: "decision-policy", text: `DEC ${mark} A:enforce E:shadow` },
			{ key: "maestro-plan-auto", text: "PLAN-AUTO ask g7" },
			{ key: "self-evolve", text: "EVOL ● 0·0·0" },
		] }));
		assert.ok(lines[1].includes(`<muted>DEC </muted><${color}>${mark}</${color}><muted> A:enforce E:shadow</muted>`));
		assert.ok(lines[1].includes("<warning>PLAN-AUTO ask g7</warning>"));
		assert.ok(lines[1].includes("<muted>EVOL </muted><success>●</success><muted> 0·0·0</muted>"));
	}
});

test("decision policy status respects Unicode footer widths from 1 to 120 columns", () => {
	const realUtils: WidthUtils = { measure: visibleWidth, clip: (text, width, ellipsis) => truncateToWidth(text, width, ellipsis) };
	for (let width = 1; width <= 120; width++) {
		const lines = renderFooter(parts({ width, utils: realUtils, extensionStatuses: [{ key: "decision-policy", text: "DEC ? A:enforce E:shadow · LLM 问答 等待用户 ×2" }] }));
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
	}
});

test("disabled self-evolve status stays out of the footer", () => {
	const disabled = renderFooter(parts({
		extensionStatuses: [{ key: "self-evolve", text: "EVOL off" }],
	}));
	assert.equal(disabled.length, 1);
	assert.doesNotMatch(disabled[0], /EVOL/);

	const enabled = renderFooter(parts({
		extensionStatuses: [{ key: "self-evolve", text: "EVOL ● 2·1·0" }],
	}));
	assert.equal(enabled.length, 2);
	assert.match(enabled[1], /EVOL ● 2·1·0/);
});

test("Plan mode leads line one while duplicate thinking is omitted", () => {
	const lines = renderFooter(parts({
		thinking: "high",
		extensionStatuses: [
			{ key: "maestro-effort", text: "high" },
			{ key: "mode", text: "PLAN" },
		],
	}));
	assert.equal(lines.length, 1);
	assert.match(lines[0], /^PLAN · ⚡ stream-70b/);
	assert.equal(lines[0].match(/high/g)?.length, 1);
});

test("footer has no background-job row", () => {
	const lines = renderFooter(parts({ width: 100 }));
	assert.equal(lines.length, 1);
	assert.doesNotMatch(lines[0], /BG|Alt\+J/);
});

test("workflow status renders after the mode-bearing first line", () => {
	const lines = renderFooter(parts({
		workflowStatus: "⚑ session · running · 003/execute",
		extensionStatuses: [{ key: "mode", text: "PLAN" }],
	}));
	assert.equal(lines.length, 2);
	assert.match(lines[0], /^PLAN/);
	assert.match(lines[1], /^⚑ session/);
});

test("maestro workflow snapshot renders a dedicated session/run line", () => {
	const lines = renderFooter(parts({
		width: 120,
		maestroWorkflow: {
			session: { id: "s1", label: "auth-m1", status: "paused" },
			run: { id: "003", command: "plan", status: "blocked" },
			chain: { completed: 2, running: 0, pending: 1, total: 3 },
			gates: { passed: 2, total: 3 },
			next: "Resume from gate",
		},
	}));
	const workflowLine = lines.find((line) => line.includes("⚑"));
	assert.ok(workflowLine, "expected a maestro workflow line");
	assert.match(workflowLine, /^⚑ auth-m1/);
	assert.match(workflowLine, /» Resume from gate/);
	assert.match(workflowLine, /! blocked/);
	assert.match(workflowLine, /003\/plan/);
	assert.match(workflowLine, /✓2 ▶0 ○1/);
	assert.match(workflowLine, /gate 2\/3/);
});

test("maestro workflow line stays within the footer width", () => {
	const lines = renderFooter(parts({
		width: 40,
		maestroWorkflow: {
			session: { id: "s1", label: "20260724-companion-goal-final-fixes", status: "running" },
			run: { id: "003", command: "execute", status: "running" },
			chain: { completed: 1, running: 1, pending: 1, total: 3 },
			gates: { passed: 0, total: 0 },
			next: "Resume from gate",
		},
	}));
	const workflowLine = lines.find((line) => line.includes("⚑"));
	assert.ok(workflowLine);
	assert.ok(utils.measure(workflowLine) <= 40);
});

test("fmtTokens formats k and m", () => {
	assert.equal(fmtTokens(0), "0");
	assert.equal(fmtTokens(999), "999");
	assert.equal(fmtTokens(1500), "1.5k");
	assert.equal(fmtTokens(2000), "2k");
	assert.equal(fmtTokens(2_500_000), "2.5m");
});

test("fmtCost formats USD magnitudes (glyph paints the $ sign)", () => {
	assert.equal(fmtCost(1500), "1.5k");
	assert.equal(fmtCost(123), "123");
	assert.equal(fmtCost(12.5), "12.50");
	assert.equal(fmtCost(0.52), "0.52");
	assert.equal(fmtCost(0.075), "0.08");
	assert.equal(fmtCost(0.008), "0.008");
	assert.equal(fmtCost(0.0004), "0.0004");
});
