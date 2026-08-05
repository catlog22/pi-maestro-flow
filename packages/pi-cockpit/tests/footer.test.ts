import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	renderFooter,
	getUsageTotals,
	invalidateUsageCache,
	setUsageThrottle,
	fmtTokens,
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
	const entry = (input: number): unknown => ({
		type: "message",
		message: { role: "assistant", usage: { input, output: 1 } },
	});
	const entriesA = [entry(10)];
	const entriesB = [entry(10), entry(20)];

	assert.equal(getUsageTotals(entriesA, 1_000).input, 10);
	assert.equal(getUsageTotals(entriesB, 1_499).input, 10);
	assert.equal(getUsageTotals(entriesB, 1_500).input, 30);
});

test("getUsageTotals throttles recompute inside the configured window", (t) => {
	invalidateUsageCache();
	setUsageThrottle(() => 10_000);
	t.after(() => {
		setUsageThrottle(() => 0);
		invalidateUsageCache();
	});
	const entry = (input: number): unknown => ({
		type: "message",
		message: { role: "assistant", usage: { input, output: 1 } },
	});
	const entriesA = [entry(10)];
	const entriesB = [entry(10), entry(20)];
	const entriesC = [entry(10), entry(20), entry(15)];

	// First computation lands immediately.
	assert.equal(getUsageTotals(entriesA, 1_000).input, 10);
	// Changed entries inside the window keep the previous totals on screen.
	assert.equal(getUsageTotals(entriesB, 5_000).input, 10);
	assert.equal(getUsageTotals(entriesB, 6_000).input, 10, "same key stays throttled inside the window");
	// Just before the window elapses, still stale.
	assert.equal(getUsageTotals(entriesB, 10_999).input, 10);
	// The same key past the window must recompute — it may not stay stale forever.
	assert.equal(getUsageTotals(entriesB, 11_000).input, 30);
	assert.equal(getUsageTotals(entriesB, 20_000).input, 30, "recomputed totals are cached");
	// A newer key past the new window recomputes from all entries.
	assert.equal(getUsageTotals(entriesC, 26_000).input, 45);
	assert.equal(getUsageTotals(entriesC, 30_000).input, 45);
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

test("renderFooter never exceeds width across many widths", () => {
	for (let width = 1; width <= 120; width++) {
		const lines = renderFooter(parts({
			width,
			extensionStatuses: [
				{ key: "mode", text: "PLAN" },
				{ key: "maestro-auto-compact", text: "CTX 72%" },
			],
		}));
		assert.ok(lines.length === 1 || lines.length === 2);
		for (const l of lines) assert.ok(utils.measure(l) <= width, `width ${width}: line too long (${utils.measure(l)}): ${l}`);
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

test("medium footer uses the compact five-cell context bar", () => {
	const lines = renderFooter(parts({ width: 60 }));
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
	assert.equal(lines[0].length, 80);
	assert.match(lines[0], /↑12k · ↓3\.4k$/);
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
	assert.equal(lines[0].length, 100);
	assert.match(lines[0], /↑12k · ↓3\.4k$/);
});

test("footer uses a workspace icon and omits monetary cost while keeping token usage", () => {
	const lines = renderFooter(parts({ cwd: "~/work/project", width: 100 }));
	assert.match(lines[0], /^⚡ stream-70b ·  ~\/work\/project/);
	assert.match(lines[0], /↑12k/);
	assert.match(lines[0], /↓3.4k/);
	assert.doesNotMatch(lines.join("\n"), /\$0\.52/);
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

test("active bash_bg status renders left-aligned on line two", () => {
	const lines = renderFooter(parts({
		width: 100,
		bashBgStatus: "⠴ · BG · 1 running · 8s · Alt+J details",
	}));
	assert.equal(lines.length, 2);
	assert.equal(lines[1], "⠴ · BG · 1 running · 8s · Alt+J details");
	assert.doesNotMatch(lines[0], /BG|Alt\+J/);
});

test("bash_bg status is clipped to the footer width", () => {
	const lines = renderFooter(parts({
		width: 24,
		bashBgStatus: `BG 1 running ${"long-command ".repeat(5)}`,
	}));
	assert.equal(lines.length, 2);
	assert.ok(utils.measure(lines[1]) <= 24);
	assert.match(lines[1], /…$/);
});

test("workflow status renders after the mode-bearing first line", () => {
	const lines = renderFooter(parts({
		bashBgStatus: "BG · 1 running",
		workflowStatus: "⚑ session · running · 003/execute",
		extensionStatuses: [{ key: "mode", text: "PLAN" }],
	}));
	assert.equal(lines.length, 3);
	assert.match(lines[0], /^PLAN/);
	assert.match(lines[1], /^BG/);
	assert.match(lines[2], /^⚑ session/);
});

test("fmtTokens formats k and m", () => {
	assert.equal(fmtTokens(0), "0");
	assert.equal(fmtTokens(999), "999");
	assert.equal(fmtTokens(1500), "1.5k");
	assert.equal(fmtTokens(2000), "2k");
	assert.equal(fmtTokens(2_500_000), "2.5m");
});
