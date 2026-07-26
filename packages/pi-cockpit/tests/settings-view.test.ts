import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRow, buildRows, nextTheme, rowKeyForAccel } from "../src/settings-view.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

const THEMES = ["dark", "light", "solarized"];

test("every row advertises the value its next press produces", () => {
	const rows = buildRows(DEFAULT_CONFIG, THEMES);
	for (const row of rows) {
		const after = buildRows(applyRow(DEFAULT_CONFIG, row.key, THEMES), THEMES)
			.find((candidate) => candidate.key === row.key);
		assert.equal(after?.value, row.next, `row ${row.key} mis-advertises its next value`);
	}
});

test("accelerators are unique and resolve to their row", () => {
	const rows = buildRows(DEFAULT_CONFIG, THEMES);
	assert.equal(new Set(rows.map((r) => r.accel)).size, rows.length);
	for (const row of rows) assert.equal(rowKeyForAccel(rows, row.accel), row.key);
});

test("theme cycles through the host list and back to the pi default", () => {
	assert.equal(nextTheme("", THEMES), "dark");
	assert.equal(nextTheme("dark", THEMES), "light");
	assert.equal(nextTheme("solarized", THEMES), "");
	// Empty means "do not override", so it must survive when no themes exist.
	assert.equal(nextTheme("", []), "");
});

test("a theme that no longer exists restarts the cycle instead of sticking", () => {
	assert.equal(nextTheme("deleted-theme", THEMES), "");
});

test("icon mode is reachable from the panel so a tofu terminal can escape to ascii", () => {
	const rows = buildRows(DEFAULT_CONFIG, THEMES);
	assert.ok(rows.some((row) => row.key === "icons"));
	let config = DEFAULT_CONFIG;
	const seen = new Set<string>();
	for (let i = 0; i < 3; i++) {
		config = applyRow(config, "icons", THEMES);
		seen.add(config.icons.mode);
	}
	assert.deepEqual([...seen].sort(), ["ascii", "auto", "nerd"]);
});

test("applyRow leaves the config untouched for an unknown key", () => {
	assert.deepEqual(applyRow(DEFAULT_CONFIG, "nope", THEMES), DEFAULT_CONFIG);
});
