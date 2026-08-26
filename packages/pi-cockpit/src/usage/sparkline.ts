/**
 * Theme-aware one-line sparkline for the `/usage` overlay.
 *
 * `pi-maestro-flow`'s statusline sparkline paints with raw ANSI RGB colors
 * from `statusline/constants.ts`. The `/usage` overlay paints through
 * `@earendil-works/pi-coding-agent`'s `Theme.fg(semanticColor, text)`, so this
 * is a tiny reimplementation using the same `▁▂▃▄▅▆▇█` glyph vocabulary and the
 * same even-stride downsample (last point always included) as the statusline
 * version — only the color path differs. Pure: numbers in, themed string out.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

const SPARK_GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

export interface ThemeSparklineOptions {
	/** Maximum column width in terminal cells; the series is downsampled to fit. */
	width?: number;
	/** Semantic theme color used to paint the glyphs. Defaults to "accent". */
	color?: ThemeColor;
}

function downsample(values: number[], width: number): number[] {
	if (values.length <= width) return values;
	const stride = Math.ceil(values.length / width);
	const sampled: number[] = [];
	for (let i = 0; i < values.length; i += stride) sampled.push(values[i]);
	if (sampled[sampled.length - 1] !== values[values.length - 1]) {
		sampled.push(values[values.length - 1]);
	}
	return sampled.slice(0, width);
}

function sparkGlyph(value: number, min: number, max: number): string {
	if (!Number.isFinite(value)) return SPARK_GLYPHS[0]!;
	if (min === max) return SPARK_GLYPHS[Math.floor(SPARK_GLYPHS.length / 2)]!;
	const ratio = (value - min) / (max - min);
	const index = Math.min(SPARK_GLYPHS.length - 1, Math.max(0, Math.floor(ratio * SPARK_GLYPHS.length)));
	return SPARK_GLYPHS[index]!;
}

/**
 * Render a one-line sparkline painted with `theme.fg(color, …)`. Empty or
 * all-non-finite input returns "" so callers can append unconditionally.
 */
export function renderThemeSparkline(
	values: readonly number[],
	theme: Pick<Theme, "fg">,
	opts: ThemeSparklineOptions = {},
): string {
	const finite = values.filter((v) => Number.isFinite(v));
	if (finite.length === 0) return "";
	const width = Math.max(1, opts.width ?? finite.length);
	const color: ThemeColor = opts.color ?? "accent";
	const sampled = downsample(finite, width);
	const min = Math.min(...sampled);
	const max = Math.max(...sampled);
	const glyphs = sampled.map((v) => sparkGlyph(v, min, max)).join("");
	return theme.fg(color, glyphs);
}
