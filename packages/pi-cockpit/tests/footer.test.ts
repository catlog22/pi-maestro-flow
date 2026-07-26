import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	renderFooter,
	getUsageTotals,
	invalidateUsageCache,
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
		elapsed: "01:23",
		width: 80,
		glyphs,
		theme,
		utils,
		...over,
	};
}

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
		assert.ok(lines.length === 2 || lines.length === 3);
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

test("no context window omits the gauge on line 1", () => {
	const lines = renderFooter(parts({ ctxWindow: 0 }));
	assert.ok(!lines[0].includes("%"));
});

test("overlong model is clipped within width", () => {
	const lines = renderFooter(parts({ width: 30, model: "a-very-long-model-name-that-should-be-truncated", provider: "some-provider" }));
	for (const l of lines) assert.ok(utils.measure(l) <= 30);
});

test("narrow footer keeps high-priority token totals instead of dropping the right side", () => {
	const lines = renderFooter(parts({ width: 20 }));
	assert.ok(lines[1].includes("↑12k"));
	assert.ok(lines[1].includes("↓3.4k"));
});

test("footer uses a workspace icon and omits monetary cost while keeping token usage", () => {
	const lines = renderFooter(parts({ cwd: "~/work/project", width: 100 }));
	assert.match(lines[0], /^ ~\/work\/project/);
	assert.match(lines[1], /↑12k/);
	assert.match(lines[1], /↓3.4k/);
	assert.doesNotMatch(lines.join("\n"), /\$0\.52/);
});

test("approval modes use distinct semantic colors", () => {
	const colorTheme: Pick<Theme, "fg"> = { fg: (color, text) => `[${color}]${text}` };
	const renderMode = (text: string): string => renderFooter(parts({
		theme: colorTheme,
		extensionStatuses: [{ key: "approval-mode", text }],
	})).at(-1)!;
	assert.match(renderMode("APPROVAL default"), /\[text\]APPROVAL default/);
	assert.match(renderMode("APPROVAL acceptEdits"), /\[success\]APPROVAL acceptEdits/);
	assert.match(renderMode("APPROVAL dontAsk"), /\[warning\]APPROVAL dontAsk/);
	assert.match(renderMode("APPROVAL plan"), /\[accent\]APPROVAL plan/);
	assert.match(renderMode("APPROVAL YOLO"), /\[error\]APPROVAL YOLO/);
});

test("ACT, PLAN and READY execution modes use distinct semantic colors", () => {
	const colorTheme: Pick<Theme, "fg"> = { fg: (color, text) => `[${color}]${text}` };
	const renderMode = (text: string): string => renderFooter(parts({
		theme: colorTheme,
		extensionStatuses: [{ key: "mode", text }],
	})).at(-1)!;
	assert.match(renderMode("ACT"), /\[success\]ACT/);
	assert.match(renderMode("PLAN"), /\[warning\]PLAN/);
	assert.match(renderMode("READY"), /\[accent\]READY/);
});

test("extension statuses render on a dedicated line and duplicate thinking is omitted", () => {
	const lines = renderFooter(parts({
		thinking: "high",
		extensionStatuses: [
			{ key: "maestro-effort", text: "high" },
			{ key: "mode", text: "PLAN" },
		],
	}));
	assert.equal(lines.length, 3);
	assert.match(lines[2], /^PLAN/);
	assert.ok(lines[2].includes("PLAN"));
	assert.ok(!lines[2].includes("high"));
});

test("workflow status renders before generic extension statuses", () => {
	const lines = renderFooter(parts({
		workflowStatus: "⚑ session · running · 003/execute",
		extensionStatuses: [{ key: "mode", text: "PLAN" }],
	}));
	assert.equal(lines.length, 4);
	assert.match(lines[2], /^⚑ session/);
	assert.match(lines[3], /PLAN/);
});

test("fmtTokens formats k and m", () => {
	assert.equal(fmtTokens(0), "0");
	assert.equal(fmtTokens(999), "999");
	assert.equal(fmtTokens(1500), "1.5k");
	assert.equal(fmtTokens(2000), "2k");
	assert.equal(fmtTokens(2_500_000), "2.5m");
});
