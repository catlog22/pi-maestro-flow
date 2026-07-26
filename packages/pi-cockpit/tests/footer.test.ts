import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderFooter, getUsageTotals, fmtTokens, renderBar, type FooterParts, type WidthUtils } from "../src/footer.ts";

// Hermetic width utils: mock theme strips no ansi, so visible width == string length.
const theme: Pick<Theme, "fg"> = { fg: (_c, t) => t };
const utils: WidthUtils = {
	measure: (s) => s.length,
	clip: (s, w, e) => (s.length <= w ? s : s.slice(0, Math.max(0, w - e.length)) + e),
};

function parts(over: Partial<FooterParts> = {}): FooterParts {
	return {
		model: "stream-70b",
		provider: "pi",
		ctxPct: 42,
		ctxTokens: 84000,
		ctxWindow: 200000,
		totals: { input: 12000, output: 3400, cacheRead: 0, cacheWrite: 0, cost: 0.52 },
		git: "main",
		elapsed: "01:23",
		width: 80,
		ascii: false,
		theme,
		utils,
		...over,
	};
}

test("getUsageTotals sums assistant usage and skips the rest", () => {
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

test("renderFooter never exceeds width across many widths", () => {
	for (const width of [20, 32, 40, 60, 80, 120, 200]) {
		const lines = renderFooter(parts({ width }));
		assert.equal(lines.length, 2);
		for (const l of lines) assert.ok(utils.measure(l) <= width, `width ${width}: line too long (${utils.measure(l)}): ${l}`);
	}
});

test("renderFooter with empty totals does not throw", () => {
	assert.doesNotThrow(() => renderFooter(parts({ totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } })));
});

test("renderFooter width<=0 returns a single empty line", () => {
	assert.deepEqual(renderFooter(parts({ width: 0 })), [""]);
});

test("ascii vs nerd bar uses different glyphs", () => {
	const nerd = renderBar(50, 6, false, theme);
	const ascii = renderBar(50, 6, true, theme);
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

test("fmtTokens formats k and m", () => {
	assert.equal(fmtTokens(0), "0");
	assert.equal(fmtTokens(999), "999");
	assert.equal(fmtTokens(1500), "1.5k");
	assert.equal(fmtTokens(2000), "2k");
	assert.equal(fmtTokens(2_500_000), "2.5m");
});
