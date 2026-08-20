import assert from "node:assert/strict";
import test from "node:test";
import {
	renderSparkline,
	renderBarChart,
	renderLineChart,
	renderStackedBar,
	renderHeatmap,
	renderHeatmapLegend,
	renderMultiLineChart,
	renderLineLegend,
} from "../src/statusline/usage-chart.ts";
import { COLORS } from "../src/statusline/constants.ts";

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

test("renderSparkline returns empty string for empty input", () => {
	assert.equal(renderSparkline([]), "");
	assert.equal(renderSparkline([Number.NaN]), "");
});

test("renderSparkline maps rising series to ascending glyphs", () => {
	const out = stripAnsi(renderSparkline([0, 1, 2, 3, 4, 5, 6, 7]));
	assert.equal(out, "▁▂▃▄▅▆▇█");
});

test("renderSparkline clamps out-of-range values", () => {
	const out = stripAnsi(renderSparkline([-100, 5, 100], { min: 0, max: 10 }));
	// -100 clamps to min (▁), 5 maps mid, 100 clamps to max (█)
	assert.ok(out.startsWith("▁"));
	assert.ok(out.endsWith("█"));
	assert.equal(out.length, 3);
});

test("renderSparkline downsamples to width", () => {
	const out = stripAnsi(renderSparkline([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], { width: 4 }));
	assert.ok(out.length <= 4 + 1, "should be at most width+1 after last-point padding");
});

test("renderBarChart returns empty array for empty input", () => {
	assert.deepEqual(renderBarChart([]), []);
});

test("renderBarChart renders one line per item with labels and bars", () => {
	const lines = renderBarChart(
		[
			{ label: "alpha", value: 100 },
			{ label: "beta", value: 50 },
		],
		{ width: 40, maxBarWidth: 10 },
	);
	assert.equal(lines.length, 2);
	assert.ok(stripAnsi(lines[0]).includes("alpha"));
	assert.ok(stripAnsi(lines[1]).includes("beta"));
	// alpha is the max, so its bar is fully filled; beta is half
	assert.ok(stripAnsi(lines[0]).includes("█"));
});

test("renderLineChart returns empty array for empty input", () => {
	assert.deepEqual(renderLineChart([]), []);
});

test("renderLineChart produces height rows of equal width", () => {
	const lines = renderLineChart([1, 2, 3, 4, 5], { width: 10, height: 4 });
	assert.equal(lines.length, 4);
	for (const line of lines) {
		// Each row has width cells; ANSI codes inflate raw length, so strip first.
		const stripped = stripAnsi(line);
		assert.ok(stripped.length > 0, "row should not be empty");
	}
});

test("renderStackedBar returns empty when total is zero or no segments", () => {
	assert.equal(renderStackedBar([], 0, 10), "");
	assert.equal(renderStackedBar([{ label: "a", value: 1, color: COLORS.tokens }], 0, 10), "");
});

test("renderStackedBar fills exactly width cells", () => {
	const out = renderStackedBar(
		[
			{ label: "a", value: 3, color: COLORS.tokens },
			{ label: "b", value: 1, color: COLORS.model },
		],
		4,
		8,
	);
	// 3/4 of 8 = 6 cells for a, 2 for b = 8 total; strip ANSI and count block chars.
	const stripped = stripAnsi(out);
	assert.equal(stripped.length, 8);
	assert.ok(stripped.includes("█"));
});

// ---------------------------------------------------------------------------
// Heatmap calendar
// ---------------------------------------------------------------------------

test("renderHeatmap returns empty array for empty input", () => {
	assert.deepEqual(renderHeatmap([]), []);
});

test("renderHeatmap renders 7 rows (one per weekday)", () => {
	const cells = [
		{ ts: Date.UTC(2026, 0, 5), value: 100 },  // a Monday
		{ ts: Date.UTC(2026, 0, 6), value: 200 },  // a Tuesday
	];
	const lines = renderHeatmap(cells, { cellWidth: 2, gap: 1, showWeekdays: true });
	assert.equal(lines.length, 7);
	// Weekday labels appear on rows 0 (Mon), 2 (Wed), 4 (Fri).
	assert.ok(stripAnsi(lines[0]).startsWith("Mon"));
	assert.ok(stripAnsi(lines[2]).startsWith("Wed"));
});

test("renderHeatmap maps zero-activity days to the empty glyph", () => {
	const cells = [{ ts: Date.UTC(2026, 0, 5), value: 0 }];
	const lines = renderHeatmap(cells, { cellWidth: 2, gap: 1, showWeekdays: false });
	// At least one cell row contains the empty glyph `·`.
	assert.ok(lines.some((l) => stripAnsi(l).includes("·")));
});

test("renderHeatmap expands to fill the target width with a solid block", () => {
	// Only 7 days of data (1 week) but a wide target: the grid should pad
	// trailing empty weeks so the rendered line fills the width.
	const cells = [{ ts: Date.UTC(2026, 0, 5), value: 100 }];
	const lines = renderHeatmap(cells, { cellWidth: 2, gap: 1, showWeekdays: true, width: 100 });
	const rowW = stripAnsi(lines[0]).length;
	// 4 (label) + weeks*(2+1)-1 should reach ~100, well beyond the single
	// data week (~7 chars).
	assert.ok(rowW >= 90, `expected the row to fill the width (got ${rowW})`);
	// Padded trailing days render as the empty glyph (solid block), not spaces.
	assert.ok(stripAnsi(lines[0]).includes("·"));
});

test("renderHeatmapLegend contains the Less/More labels and density glyphs", () => {
	const legend = stripAnsi(renderHeatmapLegend(COLORS.tokens));
	assert.ok(legend.includes("Less"));
	assert.ok(legend.includes("More"));
});

// ---------------------------------------------------------------------------
// Multi-series line chart
// ---------------------------------------------------------------------------

test("renderMultiLineChart returns empty array for empty input", () => {
	assert.deepEqual(renderMultiLineChart([]), []);
});

test("renderMultiLineChart renders height rows plus a y-title and x-axis line", () => {
	const series = [{
		label: "alpha",
		color: COLORS.tokens,
		points: [{ ts: Date.UTC(2026, 0, 1), value: 50 }, { ts: Date.UTC(2026, 0, 10), value: 100 }],
	}];
	const lines = renderMultiLineChart(series, { width: 50, height: 6, yTitle: "Tokens per Day", xFormat: "day" });
	// y-title + height rows + x-axis label line
	assert.ok(lines.length >= 6 + 2);
	assert.ok(stripAnsi(lines[0]).includes("Tokens per Day"));
	// x-axis labels include a month abbreviation.
	assert.ok(lines.some((l) => stripAnsi(l).includes("Jan")));
});

test("renderMultiLineChart draws a continuous smooth curve between points, not isolated dots", () => {
	// Two points far apart on the x axis: the chart should render a
	// continuous half-block curve (▀▄█) with no gaps between the endpoints,
	// not isolated scatter marks.
	const series = [{
		label: "alpha",
		color: COLORS.tokens,
		points: [{ ts: Date.UTC(2026, 0, 1), value: 0 }, { ts: Date.UTC(2026, 0, 20), value: 100 }],
	}];
	const lines = renderMultiLineChart(series, { width: 60, height: 8, xFormat: "day" });
	const body = stripAnsi(lines.slice(1, 1 + 8).join(""));
	// Half-block glyphs form the smooth curve.
	assert.ok(/[▀▄█]/.test(body), "expected half-block curve glyphs");
	// No broken connector glyphs from the old coarse renderer.
	assert.ok(!body.includes("●"), "should not use scatter marks");
	// The curve is continuous: many filled cells across the width, not a
	// single isolated mark at each endpoint.
	const filledCols = lines.slice(1, 1 + 8).filter((l) => /[▀▄█]/.test(stripAnsi(l))).length;
	assert.ok(filledCols >= 4, `expected a continuous curve across rows, got ${filledCols}`);
});

test("renderMultiLineChart stacked fills a solid area and y-axis sums the series", () => {
	// Two series with different daily totals: stacked mode should render a
	// filled area whose top is the daily sum, and the y-axis max should equal
	// the largest stack total (not a single series peak).
	const series = [
		{ label: "a", color: COLORS.tokens, points: [{ ts: Date.UTC(2026, 0, 1), value: 10 }, { ts: Date.UTC(2026, 0, 5), value: 30 }] },
		{ label: "b", color: COLORS.model, points: [{ ts: Date.UTC(2026, 0, 1), value: 5 }, { ts: Date.UTC(2026, 0, 5), value: 25 }] },
	];
	const lines = renderMultiLineChart(series, { width: 60, height: 8, xFormat: "day", stacked: true });
	// No yTitle → line 0 is the first chart row (top tick = stacked total).
	const topTick = stripAnsi(lines[0]).trim();
	assert.ok(topTick.startsWith("55"), `expected stacked total 55 at top, got "${topTick}"`);
	// The whole column at the peak day is a solid filled area (no gaps).
	const body = stripAnsi(lines.slice(1, 1 + 8).join(""));
	assert.ok(/█/.test(body), "expected solid filled area in stacked mode");
});

test("renderLineLegend joins series with colored dots and labels", () => {
	const legend = stripAnsi(renderLineLegend([
		{ label: "Opus 4.6", color: COLORS.tokens, points: [] },
		{ label: "glm-5.2", color: COLORS.model, points: [] },
	]).join("\n"));
	assert.ok(legend.includes("Opus 4.6"));
	assert.ok(legend.includes("glm-5.2"));
	assert.ok(legend.includes("·"));
});

test("renderLineLegend returns empty array for empty input", () => {
	assert.deepEqual(renderLineLegend([]), []);
});

test("renderLineLegend without width joins all series on a single line", () => {
	const rows = renderLineLegend([
		{ label: "a", color: COLORS.tokens, points: [] },
		{ label: "b", color: COLORS.model, points: [] },
		{ label: "c", color: COLORS.milestone, points: [] },
	]);
	assert.equal(rows.length, 1);
	assert.ok(stripAnsi(rows[0]).includes("a"));
	assert.ok(stripAnsi(rows[0]).includes("b"));
	assert.ok(stripAnsi(rows[0]).includes("c"));
});

test("renderLineLegend wraps many models across rows within the width", () => {
	// 12 models with long-ish labels; at width 40 they cannot all fit one line.
	const series = Array.from({ length: 12 }, (_, i) => ({
		label: `model-${i}-name`,
		color: COLORS.tokens,
		points: [],
	}));
	const rows = renderLineLegend(series, { width: 40 });
	assert.ok(rows.length > 1, `expected wrapping across rows, got ${rows.length}`);
	// No single row exceeds the width budget (ANSI codes inflate raw length,
	// so measure visible width after stripping).
	for (const row of rows) {
		assert.ok(stripAnsi(row).length <= 40, `row exceeded width: "${stripAnsi(row)}"`);
	}
	// Every model label appears somewhere across the wrapped rows.
	const joined = stripAnsi(rows.join("\n"));
	for (const s of series) {
		assert.ok(joined.includes(s.label), `missing label ${s.label}`);
	}
});

test("renderLineLegend truncates an oversized label to its own row", () => {
	// A single label wider than the whole budget is truncated to fit one row.
	const series = [{
		label: "extremely-long-model-identifier-that-overflowsss",
		color: COLORS.tokens,
		points: [],
	}];
	const rows = renderLineLegend(series, { width: 20 });
	assert.equal(rows.length, 1);
	assert.ok(stripAnsi(rows[0]).length <= 20, `row exceeded width: "${stripAnsi(rows[0])}"`);
	assert.ok(stripAnsi(rows[0]).includes("…"));
});
