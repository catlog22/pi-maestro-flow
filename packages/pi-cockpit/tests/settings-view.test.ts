import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRow, buildRows, rowKeyForAccel } from "../src/settings-view.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

// The theme row is a hand-off to the /theme picker, not a cycle: it has no "next
// value" to advertise and applyRow deliberately ignores it.
const CYCLING_ROWS = (key: string): boolean => key !== "theme";

test("every cycling row advertises the value its next press produces", () => {
	const rows = buildRows(DEFAULT_CONFIG).filter((row) => CYCLING_ROWS(row.key));
	for (const row of rows) {
		const after = buildRows(applyRow(DEFAULT_CONFIG, row.key))
			.find((candidate) => candidate.key === row.key);
		assert.equal(after?.value, row.next, `row ${row.key} mis-advertises its next value`);
	}
});

test("accelerators are unique and resolve to their row", () => {
	const rows = buildRows(DEFAULT_CONFIG);
	assert.equal(new Set(rows.map((r) => r.accel)).size, rows.length);
	for (const row of rows) assert.equal(rowKeyForAccel(rows, row.accel), row.key);
});

test("icon mode is reachable from the panel so a tofu terminal can escape to ascii", () => {
	const rows = buildRows(DEFAULT_CONFIG);
	assert.ok(rows.some((row) => row.key === "icons"));
	let config = DEFAULT_CONFIG;
	const seen = new Set<string>();
	for (let i = 0; i < 3; i++) {
		config = applyRow(config, "icons");
		seen.add(config.icons.mode);
	}
	assert.deepEqual([...seen].sort(), ["ascii", "auto", "nerd"]);
});

test("applyRow leaves the config untouched for an unknown key", () => {
	assert.deepEqual(applyRow(DEFAULT_CONFIG, "nope"), DEFAULT_CONFIG);
});

test("applyRow never writes the theme — /theme owns that, including the pi settings write", () => {
	// Guards the regression this replaced: a blind name cycle here would silently
	// flatten an automatic "light/dark" pair that cockpit cannot rebuild.
	const paired = { ...DEFAULT_CONFIG, theme: "one-light/one-dark" };
	assert.deepEqual(applyRow(paired, "theme"), paired);
});

test("the theme row names pi as the owner and advertises the hand-off", () => {
	const rows = buildRows({ ...DEFAULT_CONFIG, theme: "" });
	const themeRow = rows.find((r) => r.key === "theme")!;
	assert.equal(themeRow.value, "(pi settings)");
	assert.equal(themeRow.next, "open /theme");
	assert.doesNotMatch(themeRow.value, /default/);
});
