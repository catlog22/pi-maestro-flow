// Theme-aware sparkline tests — pure function, glyph mapping + downsampling + edge series.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderThemeSparkline } from "../src/usage/sparkline.ts";

// Minimal theme: fg strips to the raw text so the glyphs are inspectable.
const theme = { fg: (_color: string, text: string) => text } as never;

function glyphs(rendered: string): string {
	// renderThemeSparkline returns the glyphs (theme.fg is identity here).
	return rendered;
}

describe("renderThemeSparkline", () => {
	it("maps the min to the lowest glyph and the max to the highest", () => {
		const rendered = renderThemeSparkline([0, 5, 10], theme, { width: 3 });
		assert.equal(glyphs(rendered), "▁▅█");
	});

	it("downsamples a long series to the width and always keeps the last point", () => {
		const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		const rendered = renderThemeSparkline(values, theme, { width: 4 });
		const line = glyphs(rendered);
		assert.equal(line.length, 4);
		// The last sampled point is the last input (10 → max → top glyph).
		assert.equal(line.at(-1), "█");
	});

	it("returns empty for an empty or all-non-finite series", () => {
		assert.equal(renderThemeSparkline([], theme), "");
		assert.equal(renderThemeSparkline([Number.NaN, Infinity], theme), "");
	});

	it("renders a single mid glyph for an all-equal series", () => {
		// All-equal collapses to the middle glyph (no range to scale against).
		const rendered = renderThemeSparkline([7, 7, 7], theme, { width: 3 });
		assert.equal(glyphs(rendered), "▅▅▅");
	});

	it("clamps width to at least 1", () => {
		const rendered = renderThemeSparkline([1, 2, 3], theme, { width: 0 });
		assert.ok(glyphs(rendered).length >= 1);
	});

	it("uses only the 8 sparkline glyphs", () => {
		const values = Array.from({ length: 20 }, (_, i) => i);
		const rendered = renderThemeSparkline(values, theme, { width: 8 });
		for (const ch of glyphs(rendered)) {
			assert.ok("▁▂▃▄▅▆▇█".includes(ch), `unexpected glyph ${ch}`);
		}
	});
});
