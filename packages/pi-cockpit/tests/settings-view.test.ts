import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRow, buildRows, rowKeyForAccel } from "../src/settings-view.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

// The theme row is a hand-off to the /theme picker and thinkingFold is a
// pass-through to pi's native toggle: neither is a config cycle, so applyRow
// deliberately ignores them and the "next advertises applyRow" invariant
// cannot hold for them.
const CYCLING_ROWS = (key: string): boolean => key !== "theme" && key !== "thinkingFold";

test("every cycling row advertises the value its next press produces", () => {
	const rows = buildRows(DEFAULT_CONFIG).filter((row) => CYCLING_ROWS(row.key));
	for (const row of rows) {
		const after = buildRows(applyRow(DEFAULT_CONFIG, row.key))
			.find((candidate) => candidate.key === row.key);
		assert.equal(after?.value, row.next, `row ${row.key} mis-advertises its next value`);
	}
});

test("thinking fold row mirrors pi's live state and advertises its inverse", () => {
	const hidden = buildRows(DEFAULT_CONFIG, { thinkingHidden: true })
		.find((row) => row.key === "thinkingFold");
	assert.equal(hidden?.value, "hidden");
	assert.equal(hidden?.next, "visible");
	const visible = buildRows(DEFAULT_CONFIG, { thinkingHidden: false })
		.find((row) => row.key === "thinkingFold");
	assert.equal(visible?.value, "visible");
	assert.equal(visible?.next, "hidden");
});

test("quiet controls stay grouped in mode, symbol, thinking order", () => {
	const keys = buildRows(DEFAULT_CONFIG, { thinkingHidden: false }).map((row) => row.key);
	const start = keys.indexOf("quietMode");
	assert.deepEqual(keys.slice(start, start + 3), ["quietMode", "quietSymbols", "thinkingFold"]);
});

test("quiet symbols cycle between check and dot modes", () => {
	const row = buildRows(DEFAULT_CONFIG).find((candidate) => candidate.key === "quietSymbols");
	assert.deepEqual(
		{ value: row?.value, next: row?.next, accel: row?.accel },
		{ value: "check", next: "dot", accel: "s" },
	);
	const dotted = applyRow(DEFAULT_CONFIG, "quietSymbols");
	assert.equal(dotted.quietSymbols, "dot");
	assert.equal(applyRow(dotted, "quietSymbols").quietSymbols, "check");
});

test("thinking fold is a pass-through: applyRow leaves config untouched", () => {
	assert.equal(applyRow(DEFAULT_CONFIG, "thinkingFold"), DEFAULT_CONFIG);
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
	assert.equal(themeRow.next, "picker…");
	assert.doesNotMatch(themeRow.value, /default/);
	// Enter opens the picker inside the panel. Naming a slash command here read as
	// "go run something else", which is the one thing this row does not require.
	assert.doesNotMatch(themeRow.next, /\//);
});

test("a committed theme shows up on the row, so the round trip is visible", () => {
	const rows = buildRows({ ...DEFAULT_CONFIG, theme: "nord" });
	assert.equal(rows.find((r) => r.key === "theme")!.value, "nord");
});
