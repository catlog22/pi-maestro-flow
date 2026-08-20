/**
 * Token-usage chart renderers — pure ANSI string functions.
 *
 * No external chart library: the statusline is plain ANSI concatenation (not
 * an Ink/React pipeline), so we reuse the `█░` block vocabulary and theme
 * colors from constants.ts. Every function is pure (input numbers → string),
 * side-effect free, and unit-testable without a TTY.
 */

import { ansiFg, ansiBg, ANSI_RESET, ANSI_DIM, COLORS, type RGB } from "./constants.ts";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

const SPARK_GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * Map a value in [min,max] to one of 8 sparkline glyphs. Values outside the
 * range clamp to the endpoints; a flat series (min===max) renders the mid
 * glyph so a constant line is still visible.
 */
function sparkGlyph(value: number, min: number, max: number): string {
	if (!Number.isFinite(value)) return SPARK_GLYPHS[0];
	if (max === min) return SPARK_GLYPHS[3];
	const clamped = value < min ? min : value > max ? max : value;
	const idx = Math.round(((clamped - min) / (max - min)) * (SPARK_GLYPHS.length - 1));
	return SPARK_GLYPHS[idx];
}

export interface SparklineOptions {
	/** Maximum column width in terminal cells. The series is downsampled to fit. */
	width?: number;
	/** Foreground color. Defaults to the theme `tokens` color. */
	color?: RGB;
	/** Fixed scale; when omitted the series min/max drives the glyph mapping. */
	max?: number;
	/** Minimum scale; when omitted the series min drives the glyph mapping. */
	min?: number;
}

/**
 * Render a one-line sparkline from a numeric series. Empty or all-non-finite
 * input returns "" so callers can append unconditionally. The series is
 * downsampled to `width` points by even stride sampling (last point always
 * included) so the right edge tracks the most recent value.
 */
export function renderSparkline(values: readonly number[], opts: SparklineOptions = {}): string {
	const finite = values.filter((v) => Number.isFinite(v));
	if (finite.length === 0) return "";
	const width = Math.max(1, opts.width ?? finite.length);
	const stride = finite.length <= width ? 1 : Math.ceil(finite.length / width);
	const sampled: number[] = [];
	for (let i = 0; i < finite.length; i += stride) sampled.push(finite[i]);
	if (sampled[sampled.length - 1] !== finite[finite.length - 1]) sampled.push(finite[finite.length - 1]);
	const trimmed = sampled.slice(0, width);
	const min = opts.min ?? Math.min(...trimmed);
	const max = opts.max ?? Math.max(...trimmed);
	const color = opts.color ?? COLORS.tokens;
	const glyphs = trimmed.map((v) => sparkGlyph(v, min, max)).join("");
	return `${ansiFg(color)}${glyphs}${ANSI_RESET}`;
}

// ---------------------------------------------------------------------------
// Bar chart (horizontal)
// ---------------------------------------------------------------------------

export interface BarChartItem {
	label: string;
	value: number;
	color?: RGB;
}

export interface BarChartOptions {
	/** Total width including label and value text. */
	width?: number;
	/** Max bar length in cells (excludes label + value). */
	maxBarWidth?: number;
	/** Fixed scale; when omitted the largest item drives the bar lengths. */
	max?: number;
}

/**
 * Render horizontal bars, one per item. Each line is `label  ████░░  value`.
 * Bars are colored per-item (falling back to theme colors) and scaled to the
 * largest item unless `max` is given. Returns [] for empty input.
 */
export function renderBarChart(items: readonly BarChartItem[], opts: BarChartOptions = {}): string[] {
	if (items.length === 0) return [];
	const width = opts.width ?? 60;
	const labelWidth = Math.min(Math.max(...items.map((i) => visibleWidth(i.label))), 20);
	const valueText = items.map((i) => formatCompact(i.value));
	const valueWidth = Math.max(...valueText.map((v) => v.length));
	const maxBar = opts.maxBarWidth ?? Math.max(8, width - labelWidth - valueWidth - 6);
	const scaleMax = opts.max ?? Math.max(...items.map((i) => i.value), 0);
	const palette: RGB[] = [COLORS.ctxOk, COLORS.model, COLORS.milestone, COLORS.phase, COLORS.evol, COLORS.tokens];
	const lines: string[] = [];
	items.forEach((item, idx) => {
		const bar = scaleMax <= 0 ? "░".repeat(maxBar) : buildBar(item.value / scaleMax, maxBar);
		const color = item.color ?? palette[idx % palette.length];
		const label = padEnd(item.label, labelWidth);
		const value = padStart(formatCompact(item.value), valueWidth);
		lines.push(`${ANSI_DIM}${label}${ANSI_RESET}  ${ansiFg(color)}${bar}${ANSI_RESET}  ${ANSI_DIM}${value}${ANSI_RESET}`);
	});
	return lines;
}

function buildBar(ratio: number, width: number): string {
	const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
	const filled = Math.round(clamped * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

// ---------------------------------------------------------------------------
// Line chart (block-based, multi-row)
// ---------------------------------------------------------------------------

export interface LineChartOptions {
	/** Chart area width in cells (excludes axis labels). */
	width?: number;
	/** Chart area height in rows. */
	height?: number;
	/** Foreground color. Defaults to the theme `tokens` color. */
	color?: RGB;
	/** Fixed scale; when omitted the series max drives the vertical mapping. */
	max?: number;
	/** Minimum scale; defaults to 0. */
	min?: number;
}

const LINE_FILL = "·";
const LINE_MARK = "●";

/**
 * Render a multi-row line chart using block glyphs. The series is drawn as a
 * connected path of `●` marks over a `·` grid; empty (non-finite) samples are
 * left blank. Returns [] for empty input. Height ≥ 1; the baseline is always
 * the bottom row.
 */
export function renderLineChart(values: readonly number[], opts: LineChartOptions = {}): string[] {
	const finite = values.filter((v) => Number.isFinite(v));
	if (finite.length === 0) return [];
	const width = Math.max(1, opts.width ?? 40);
	const height = Math.max(1, opts.height ?? 5);
	const min = opts.min ?? 0;
	const max = opts.max ?? Math.max(...finite, min + 1);
	const color = opts.color ?? COLORS.tokens;
	const range = max === min ? 1 : max - min;
	// Downsample to width points (even stride, last point always kept).
	const stride = finite.length <= width ? 1 : Math.ceil(finite.length / width);
	const sampled: number[] = [];
	for (let i = 0; i < finite.length; i += stride) sampled.push(finite[i]);
	if (sampled[sampled.length - 1] !== finite[finite.length - 1]) sampled.push(finite[finite.length - 1]);
	const points = sampled.slice(0, width);
	// Build a height×width grid; row 0 is the top.
	const grid: string[][] = Array.from({ length: height }, () => new Array(width).fill(" "));
	points.forEach((v, col) => {
		const clamped = v < min ? min : v > max ? max : v;
		const rowFromBottom = Math.round(((clamped - min) / range) * (height - 1));
		const row = height - 1 - rowFromBottom;
		if (row >= 0 && row < height) grid[row][col] = LINE_MARK;
	});
	// Render rows; empty rows collapse to a faint baseline only on the bottom row.
	const lines: string[] = [];
	for (let row = 0; row < height; row++) {
		const cells = grid[row].map((c) => (c === LINE_MARK ? `${ansiFg(color)}${LINE_MARK}${ANSI_RESET}` : `${ANSI_DIM}${LINE_FILL}${ANSI_RESET}`)).join("");
		lines.push(cells);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Stacked proportion bar
// ---------------------------------------------------------------------------

export interface StackedSegment {
	label: string;
	value: number;
	color: RGB;
}

/**
 * Render a single-row stacked proportion bar: each segment's width is its
 * share of `total`, colored per segment. Returns "" when total ≤ 0 or all
 * segments are empty. The bar is exactly `width` cells wide.
 */
export function renderStackedBar(segments: readonly StackedSegment[], total: number, width: number): string {
	if (total <= 0 || segments.length === 0) return "";
	const clampedWidth = Math.max(1, width);
	const parts = segments
		.map((s) => ({ ...s, value: s.value < 0 ? 0 : s.value }))
		.filter((s) => s.value > 0);
	if (parts.length === 0) return "";
	const sum = parts.reduce((acc, s) => acc + s.value, 0);
	let drawn = 0;
	let out = "";
	parts.forEach((s, idx) => {
		const cells = idx === parts.length - 1 ? clampedWidth - drawn : Math.round((s.value / sum) * clampedWidth);
		if (cells <= 0) return;
		out += `${ansiFg(s.color)}${"█".repeat(cells)}${ANSI_RESET}`;
		drawn += cells;
	});
	return out;
}

// ---------------------------------------------------------------------------
// Heatmap calendar (GitHub-style contribution grid)
// ---------------------------------------------------------------------------

export interface HeatmapCell {
	/** UTC midnight timestamp for the day. */
	ts: number;
	/** Aggregated value for the day (0 = no activity). */
	value: number;
}

export interface HeatmapOptions {
	/** Max cell width per column (usually 2-3 cells per week column). */
	cellWidth?: number;
	/** Spacing between week columns. */
	gap?: number;
	/** Foreground color for filled cells. Empty cells are dim. */
	color?: RGB;
	/** Number of density levels (default 4: ·▒▓█). */
	levels?: number;
	/** Show weekday labels on the left (Mon/Wed/Fri). */
	showWeekdays?: boolean;
	/** Target content width. The grid expands to fill this width by padding
	 *  trailing empty weeks, so the heatmap left-aligns and fills the panel
	 *  instead of leaving blank space on the right. */
	width?: number;
}

const HEATMAP_GLYPHS = ["·", "▒", "▓", "█"] as const;

/**
 * Render a GitHub-style contribution heatmap. Days are laid out as a 7-row
 * (Mon→Sun) × N-column (week) grid. Cell density maps to 4 levels: empty `·`,
 * then `▒▓█` for increasing values. Optional weekday labels (Mon/Wed/Fri)
 * render on the left. Returns [] for empty input.
 */
export function renderHeatmap(cells: readonly HeatmapCell[], opts: HeatmapOptions = {}): string[] {
	if (cells.length === 0) return [];
	const cellWidth = Math.max(1, opts.cellWidth ?? 2);
	const gap = Math.max(0, opts.gap ?? 1);
	const color = opts.color ?? COLORS.tokens;
	const showWeekdays = opts.showWeekdays ?? true;
	const max = Math.max(...cells.map((c) => c.value), 0);
	// Build a map of utcMidnight → cell for quick lookup.
	const byDay = new Map<number, number>();
	for (const c of cells) byDay.set(c.ts, c.value);
	// Determine the week range. First day's weekday (0=Sun..6=Sat); align so
	// Monday is the first row.
	const firstTs = cells[0].ts;
	const lastTs = cells[cells.length - 1].ts;
	const firstDate = new Date(firstTs);
	// JS getUTCDay: 0=Sun..6=Sat. Convert to Mon-first: Mon=0..Sun=6.
	const firstRowIdx = (firstDate.getUTCDay() + 6) % 7;
	// Pad the start so the grid begins on the Monday of the first week.
	const gridStart = firstTs - firstRowIdx * 86_400_000;
	const totalDays = Math.round((lastTs - gridStart) / 86_400_000) + 1;
	let weeks = Math.ceil(totalDays / 7);
	// Expand to fill the target width by padding trailing empty weeks, so
	// the heatmap is a solid block rather than scrunched left with blank right.
	if (opts.width !== undefined) {
		const labelW = showWeekdays ? 4 : 0;
		const colW = cellWidth + gap;
		const availW = Math.max(0, opts.width - labelW);
		const targetWeeks = Math.floor((availW + gap) / colW);
		if (targetWeeks > weeks) weeks = targetWeeks;
	}
	const labelCol = showWeekdays ? 4 : 0; // "Wed " width
	const lines: string[] = [];
	const weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
	for (let row = 0; row < 7; row++) {
		let line = "";
		if (showWeekdays) {
			// Only show Mon/Wed/Fri labels, others blank for spacing.
			line = row === 0 || row === 2 || row === 4 ? `${ANSI_DIM}${weekdayLabels[row]}${ANSI_RESET}` : "   ";
			line += " ";
		}
		for (let w = 0; w < weeks; w++) {
			const dayTs = gridStart + (w * 7 + row) * 86_400_000;
			const value = byDay.get(dayTs);
			// Days inside the data span with no value render blank (gaps in
			// sparse data); days beyond the span (width-expanded padding) render
			// as the empty glyph so the grid is a solid block filling the width.
			const beyondSpan = w * 7 + row >= totalDays;
			if (value === undefined && !beyondSpan) {
				line += `${ANSI_DIM}${" ".repeat(cellWidth)}${ANSI_RESET}`;
			} else if (value === undefined || value <= 0) {
				line += `${ANSI_DIM}${HEATMAP_GLYPHS[0].repeat(cellWidth)}${ANSI_RESET}`;
			} else {
				const level = max <= 0 ? 1 : Math.max(1, Math.ceil((value / max) * (HEATMAP_GLYPHS.length - 1)));
				const glyph = HEATMAP_GLYPHS[Math.min(level, HEATMAP_GLYPHS.length - 1)];
				line += `${ansiFg(color)}${glyph.repeat(cellWidth)}${ANSI_RESET}`;
			}
			if (w < weeks - 1) line += " ".repeat(gap);
		}
		lines.push(line);
	}
	return lines;
}

/** Render the `Less ▒▓█ More` legend line. */
export function renderHeatmapLegend(color: RGB = COLORS.tokens): string {
	const glyphs = HEATMAP_GLYPHS.slice(1); // skip the empty `·`
	const swatches = glyphs.map((g) => `${ansiFg(color)}${g}${ANSI_RESET}`).join("");
	return `${ANSI_DIM}Less ${ANSI_RESET}${swatches}${ANSI_DIM} More${ANSI_RESET}`;
}

// ---------------------------------------------------------------------------
// Multi-series line chart with time axis
// ---------------------------------------------------------------------------

export interface SeriesPoint {
	ts: number;
	value: number;
}

export interface LineSeries {
	/** Series label shown in the legend. */
	label: string;
	/** Color for this series' marks and legend dot. */
	color: RGB;
	/** Points ordered by ts. */
	points: readonly SeriesPoint[];
}

export interface MultiLineChartOptions {
	/** Chart area width (excludes y-axis labels). */
	width?: number;
	/** Chart area height in rows. */
	height?: number;
	/** Y-axis title (e.g. "Tokens per Day"). */
	yTitle?: string;
	/** X-axis label format: "day" → "MMM D", "hour" → "HH:00". */
	xFormat?: "day" | "hour";
	/** Fixed y scale; when omitted the max across all series drives it. */
	yMax?: number;
	/** Stack series cumulatively (stacked area). Each series is drawn as the
	 *  band between the cumulative total up to it and up to the previous one,
	 *  so the chart shows per-model contribution to a daily total. */
	stacked?: boolean;
}

const MULTI_LINE_FILL = " ";
const MULTI_LINE_MARK = "●";

/** Linear interpolation of a series value at `ts` (flat outside the range). */
function interpolateSeriesValue(pts: readonly SeriesPoint[], ts: number): number {
	if (pts.length === 0) return 0;
	if (pts.length === 1) return pts[0].value;
	if (ts <= pts[0].ts) return pts[0].value;
	if (ts >= pts[pts.length - 1].ts) return pts[pts.length - 1].value;
	let lo = 0;
	let hi = pts.length - 1;
	while (lo < hi - 1) {
		const mid = (lo + hi) >> 1;
		if (pts[mid].ts <= ts) lo = mid;
		else hi = mid;
	}
	const a = pts[lo];
	const b = pts[hi];
	const t = b.ts === a.ts ? 0 : (ts - a.ts) / (b.ts - a.ts);
	return a.value + (b.value - a.value) * t;
}

/**
 * Render a multi-series line chart with a y-axis scale and an x-axis time
 * label row. Lines are drawn with **half-block sub-pixel rendering**: each
 * character cell has a top and bottom half (`▀`/`▄`/`█`), giving 2× vertical
 * resolution, and every column is sampled by linearly interpolating each
 * series across it. The result is a smooth, continuous curve with no gaps
 * between points — unlike coarse `─╱╲` connector glyphs which break at
 * steep slopes. Returns [] for empty input.
 */
export function renderMultiLineChart(series: readonly LineSeries[], opts: MultiLineChartOptions = {}): string[] {
	const allPoints = series.flatMap((s) => s.points);
	if (allPoints.length === 0) return [];
	const width = Math.max(1, opts.width ?? 60);
	const height = Math.max(1, opts.height ?? 8);
	const yTitle = opts.yTitle ?? "";
	const xFormat = opts.xFormat ?? "day";
	const stacked = opts.stacked ?? false;
	// For stacked charts the y axis is the cumulative daily total, not the
	// per-series peak; compute the max stacked total across columns.
	let yMax = opts.yMax;
	if (yMax === undefined) {
		if (stacked) {
			let m = 0;
			for (const p of allPoints) {
				const total = series.reduce((acc, s) => acc + interpolateSeriesValue(s.points, p.ts), 0);
				m = Math.max(m, total);
			}
			yMax = m;
		} else {
			yMax = Math.max(...allPoints.map((p) => p.value), 0);
		}
	}
	const yAxisLabelWidth = Math.max(formatYAxisTick(yMax).length, formatYAxisTick(0).length);
	const chartW = Math.max(1, width - yAxisLabelWidth - 1);
	// Pixel grid: 2×height rows, one per half-block. Each column holds, per
	// pixel row, the series index owning that sub-pixel (or -1 = empty).
	// We render top-to-bottom, so pixel row 0 is the very top.
	const pixelRows = 2 * height;
	// For each series, build a function ts → interpolated value, then a
	// ts → pixel-row mapping. We sample every column.
	const minTs = Math.min(...allPoints.map((p) => p.ts));
	const maxTs = Math.max(...allPoints.map((p) => p.ts));
	const tsRange = maxTs - minTs || 1;
	const colToTs = (col: number): number =>
		tsRange === 0 ? minTs : minTs + (col / Math.max(1, chartW - 1)) * tsRange;
	// value → continuous pixel row (0 at top, pixelRows-1 at bottom).
	const valueToPixel = (v: number): number => {
		const ratio = yMax <= 0 ? 0 : Math.min(1, Math.max(0, v / yMax));
		return (1 - ratio) * (pixelRows - 1);
	};
	// Build the pixel grid: grid[row][col] = series index or -1.
	const grid: Int16Array[] = Array.from({ length: pixelRows }, () => new Int16Array(chartW).fill(-1));
	if (stacked) {
		renderStacked(series, grid, chartW, pixelRows, colToTs, valueToPixel);
	} else {
		renderOverlaid(series, grid, chartW, colToTs, valueToPixel);
	}
	const lines: string[] = [];
	if (yTitle) lines.push(`${ANSI_DIM}${yTitle}${ANSI_RESET}`);
	// Render each character row from two pixel rows (top half + bottom half).
	// Show ~4 evenly spaced y-axis ticks for taller charts, 3 for short ones.
	const tickRows = height >= 10 ? [0, Math.round(height / 3), Math.round((2 * height) / 3), height - 1] : [0, Math.floor(height / 2), height - 1];
	const tickValues = new Set<number>();
	for (const r of tickRows) {
		if (r === 0) tickValues.add(yMax);
		else if (r === height - 1) tickValues.add(0);
		else tickValues.add(yMax * (1 - r / (height - 1)));
	}
	for (let row = 0; row < height; row++) {
		let tick = "";
		if (tickRows.includes(row)) {
			tick = formatYAxisTick(yMax * (1 - row / (height - 1)));
		}
		tick = tick.padStart(yAxisLabelWidth, " ");
		const topPix = row * 2;
		const botPix = row * 2 + 1;
		let cells = "";
		for (let col = 0; col < chartW; col++) {
			const topIdx = grid[topPix][col];
			const botIdx = grid[botPix][col];
			cells += renderHalfBlock(topIdx, botIdx, series);
		}
		lines.push(`${ANSI_DIM}${tick}${ANSI_RESET} ${cells}`);
	}
	// X-axis time labels: pick ~4 evenly spaced timestamps.
	const xLabelCount = Math.min(4, chartW);
	const xLabels: Array<{ ts: number; label: string }> = [];
	for (let i = 0; i < xLabelCount; i++) {
		const ts = minTs + (tsRange * i) / Math.max(1, xLabelCount - 1);
		xLabels.push({ ts, label: formatXAxisLabel(ts, xFormat) });
	}
	const labelLine = buildXAxisLabelLine(xLabels, chartW, yAxisLabelWidth + 1);
	lines.push(labelLine);
	return lines;
}

/** Overlaid (non-stacked): each series drawn as a thin continuous curve. */
function renderOverlaid(
	series: readonly LineSeries[],
	grid: Int16Array[],
	chartW: number,
	colToTs: (col: number) => number,
	valueToPixel: (v: number) => number,
): void {
	const pixelRows = grid.length;
	for (let sIdx = 0; sIdx < series.length; sIdx++) {
		const pts = series[sIdx].points;
		// First column.
		let prevPix = valueToPixel(interpolateSeriesValue(pts, colToTs(0)));
		fillVerticalRun(grid, prevPix, 0, sIdx);
		for (let col = 1; col < chartW; col++) {
			const ts = colToTs(col);
			const v = interpolateSeriesValue(pts, ts);
			const curPix = valueToPixel(v);
			fillVerticalRun(grid, curPix, col, sIdx);
			// Bridge any half-step gap between columns so the curve is continuous.
			const lo = Math.min(prevPix, curPix);
			const hi = Math.max(prevPix, curPix);
			for (let r = Math.floor(lo); r <= Math.floor(hi); r++) {
				if (r >= 0 && r < pixelRows && grid[r][col] === -1) grid[r][col] = sIdx;
			}
			prevPix = curPix;
		}
	}
}

/** Stacked area: series i fills the band between the cumulative total up to
 *  i and up to i-1, from the bottom up. Each column is sliced into colored
 *  bands, one per model, summing to the daily total. */
function renderStacked(
	series: readonly LineSeries[],
	grid: Int16Array[],
	chartW: number,
	pixelRows: number,
	colToTs: (col: number) => number,
	valueToPixel: (v: number) => number,
): void {
	for (let col = 0; col < chartW; col++) {
		const ts = colToTs(col);
		// Cumulative total from the bottom (series 0) upward.
		let cumulative = 0;
		for (let sIdx = 0; sIdx < series.length; sIdx++) {
			const v = interpolateSeriesValue(series[sIdx].points, ts);
			const lowerVal = cumulative;
			const upperVal = cumulative + v;
			const upperPix = Math.round(valueToPixel(upperVal));
			const lowerPix = Math.round(valueToPixel(lowerVal));
			// Fill the band from upperPix (top, smaller row idx) down to lowerPix.
			for (let r = upperPix; r <= lowerPix; r++) {
				if (r >= 0 && r < pixelRows && grid[r][col] === -1) grid[r][col] = sIdx;
			}
			cumulative = upperVal;
		}
	}
}

/** Paint a vertical run of pixels at `col` around pixel row `pix`. */
function fillVerticalRun(grid: Int16Array[], pix: number, col: number, sIdx: number): void {
	const row = Math.round(pix);
	if (row < 0 || row >= grid.length || col < 0 || col >= grid[0].length) return;
	if (grid[row][col] === -1) grid[row][col] = sIdx;
	// Also fill the half-block partner so a single-pixel value still shows.
	const frac = pix - Math.floor(pix);
	const partner = frac < 0.5 ? row + 1 : row - 1;
	if (partner >= 0 && partner < grid.length && grid[partner][col] === -1) {
		grid[partner][col] = sIdx;
	}
}

/** Render one character cell from its top/bottom half-block series indices. */
function renderHalfBlock(topIdx: number, botIdx: number, series: readonly LineSeries[]): string {
	const empty = -1;
	if (topIdx === empty && botIdx === empty) return MULTI_LINE_FILL;
	if (topIdx === botIdx) return `${ansiFg(series[topIdx].color)}█${ANSI_RESET}`;
	// Different colors per half, or one half empty: use background/foreground.
	if (topIdx === empty) return `${ansiFg(series[botIdx].color)}▄${ANSI_RESET}`;
	if (botIdx === empty) return `${ansiFg(series[topIdx].color)}▀${ANSI_RESET}`;
	// Two different series in the same cell: top as fg, bottom as bg.
	return `${ansiFg(series[topIdx].color)}${ansiBg(series[botIdx].color)}▀${ANSI_RESET}`;
}

export interface LineLegendOptions {
	/** Max row width in terminal cells. When omitted, every series is joined
	 *  into a single line (legacy behavior). When provided, items are
	 *  greedily wrapped across rows so a legend with many models stays
	 *  visible instead of overflowing a single line and being truncated. */
	width?: number;
}

/**
 * Render the series legend as `● label1 · ● label2 …`. Without `width` a
 * single joined line is returned (one element). With `width`, items wrap
 * across rows so a many-model legend stays visible instead of being
 * truncated off-screen; an item wider than the whole row is label-truncated
 * to fit on its own line. Returns [] for empty input.
 */
export function renderLineLegend(series: readonly LineSeries[], opts: LineLegendOptions = {}): string[] {
	if (series.length === 0) return [];
	const sep = `${ANSI_DIM} · ${ANSI_RESET}`;
	const sepWidth = 3;
	// Each item: color + label + visible cell width (● + space + label).
	const items = series.map((s) => ({
		color: s.color,
		label: s.label,
		width: 2 + visibleWidth(s.label),
	}));
	const render = (i: { color: RGB; label: string }): string =>
		`${ansiFg(i.color)}${MULTI_LINE_MARK}${ANSI_RESET} ${i.label}`;
	// Without a width budget, join everything into one line.
	if (opts.width === undefined) {
		return [items.map(render).join(sep)];
	}
	const minRow = Math.max(1, opts.width);
	const rows: string[] = [];
	let cur: typeof items = [];
	let curW = 0;
	const flush = (): void => {
		if (cur.length > 0) {
			rows.push(cur.map(render).join(sep));
			cur = [];
			curW = 0;
		}
	};
	for (const item of items) {
		// A single item wider than the whole row: truncate its label and give
		// it its own line so it never overflows.
		if (item.width > minRow) {
			flush();
			const maxLabel = Math.max(1, minRow - 2); // leave room for `● `
			const truncated = truncateToWidth(item.label, maxLabel, "…");
			rows.push(render({ color: item.color, label: truncated }));
			continue;
		}
		// Greedy wrap: if adding `· item` to the current row overflows, start a new row.
		const addW = cur.length === 0 ? item.width : sepWidth + item.width;
		if (cur.length > 0 && curW + addW > minRow) flush();
		cur.push(item);
		curW += addW;
	}
	flush();
	return rows;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCompact(n: number): string {
	if (!Number.isFinite(n)) return "—";
	if (Math.abs(n) < 1) return n.toFixed(2);
	if (Math.abs(n) < 1000) return n.toFixed(0);
	if (Math.abs(n) < 1_000_000) return (n / 1000).toFixed(1) + "k";
	return Math.round(n / 1000).toLocaleString("en-US") + "k";
}

function formatYAxisTick(value: number): string {
	if (!Number.isFinite(value) || value === 0) return "0";
	if (Math.abs(value) < 1) return value.toFixed(1);
	if (Math.abs(value) < 1000) return String(Math.round(value));
	if (Math.abs(value) < 1_000_000) return (value / 1000).toFixed(1) + "k";
	if (Math.abs(value) < 1_000_000_000) return (value / 1_000_000).toFixed(1) + "M";
	return (value / 1_000_000_000).toFixed(1) + "B";
}

function formatXAxisLabel(ts: number, format: "day" | "hour"): string {
	const d = new Date(ts);
	if (format === "hour") {
		const hh = String(d.getUTCHours()).padStart(2, "0");
		return `${hh}:00`;
	}
	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function buildXAxisLabelLine(
	labels: Array<{ ts: number; label: string }>,
	chartW: number,
	indent: number,
): string {
	// Place labels at proportional positions across the chart width.
	const positions = labels.map((l, i) => ({
		label: l.label,
		col: labels.length === 1 ? 0 : Math.round((chartW - 1) * (i / (labels.length - 1))),
	}));
	// Render left-to-right, advancing a cursor.
	let out = " ".repeat(indent);
	let cursor = 0;
	for (const p of positions) {
		if (p.col < cursor) continue;
		if (p.col > cursor) out += " ".repeat(p.col - cursor);
		out += p.label;
		cursor = p.col + p.label.length;
	}
	return `${ANSI_DIM}${out}${ANSI_RESET}`;
}

function padEnd(text: string, width: number): string {
	const gap = width - visibleWidth(text);
	return gap > 0 ? text + " ".repeat(gap) : text;
}

function padStart(text: string, width: number): string {
	const gap = width - text.length;
	return gap > 0 ? " ".repeat(gap) + text : text;
}
