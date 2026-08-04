import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRow, buildRows, rowKeyForAccel } from "../src/settings-view.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

// The theme row is a hand-off to the /theme picker, thinkingFold is a
// pass-through to pi's native toggle, and titleGenerationModel opens the model
// picker: none of them is a config cycle, so applyRow has no toggle semantics
// for them and the "next advertises applyRow" invariant cannot hold.
const CYCLING_ROWS = (key: string): boolean =>
	key !== "theme" && key !== "thinkingFold" && key !== "titleGenerationModel";

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

test("static mode row cycles on/off and is reachable by accel", () => {
	const row = buildRows(DEFAULT_CONFIG).find((candidate) => candidate.key === "staticMode");
	assert.deepEqual(
		{ value: row?.value, next: row?.next, accel: row?.accel },
		{ value: "off", next: "on", accel: "m" },
	);
	assert.equal(applyRow(DEFAULT_CONFIG, "staticMode").staticMode, true);
	assert.equal(applyRow(applyRow(DEFAULT_CONFIG, "staticMode"), "staticMode").staticMode, false);
});

test("pin editor bottom uses the layout accelerator without shadowing tool palette", () => {
	const row = buildRows(DEFAULT_CONFIG).find((candidate) => candidate.key === "pinEditorBottom");
	assert.equal(row?.accel, "l");
	assert.equal(rowKeyForAccel(buildRows(DEFAULT_CONFIG), "l"), "pinEditorBottom");
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

test("tool palette cycles through every grouping and is reachable by accel", () => {
	const row = buildRows(DEFAULT_CONFIG).find((candidate) => candidate.key === "toolPalette");
	assert.equal(row?.accel, "p");
	assert.equal(row?.value, "family");
	let config = DEFAULT_CONFIG;
	const seen = new Set<string>();
	for (let i = 0; i < 5; i++) {
		config = applyRow(config, "toolPalette");
		seen.add(config.toolPalette);
	}
	assert.deepEqual([...seen].sort(), ["classic", "family", "mono", "readwrite", "search"]);
});

test("tool palette sits right after the quiet trio it belongs with", () => {
	const keys = buildRows(DEFAULT_CONFIG).map((row) => row.key);
	assert.equal(keys[keys.indexOf("thinkingFold") + 1], "toolPalette");
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

test("sidebar rows expose the mode and density cycles", () => {
	const rows = buildRows(DEFAULT_CONFIG);
	assert.deepEqual(
		rows.filter((row) => row.key.startsWith("sidebar")).map((row) => [row.key, row.value, row.next]),
		[
			["sidebarMode", "off", "auto"],
			["sidebarDensity", "comfortable", "compact"],
		],
	);
	const auto = applyRow(DEFAULT_CONFIG, "sidebarMode");
	assert.equal(auto.sidebar.mode, "auto");
	assert.equal(applyRow(applyRow(auto, "sidebarMode"), "sidebarMode").sidebar.mode, "off");
	const compact = applyRow(DEFAULT_CONFIG, "sidebarDensity");
	assert.equal(compact.sidebar.density, "compact");
	assert.equal(applyRow(compact, "sidebarDensity").sidebar.density, "comfortable");
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

test("title rows cycle every dimension and are reachable by accel", () => {
	const rows = buildRows(DEFAULT_CONFIG);
	const titleRows = rows.filter((r) => r.key.startsWith("title"));
	assert.deepEqual(titleRows.map((r) => r.key), [
		"titleEnabled",
		"titleSession",
		"titleCwd",
		"titleModel",
		"titleThinking",
		"titleGit",
		"titleMaestro",
		"titleGenerationModel",
	]);
	assert.equal(applyRow(DEFAULT_CONFIG, "titleEnabled").title.enabled, false);
	assert.equal(applyRow(DEFAULT_CONFIG, "titleSession").title.showSession, false);
	assert.equal(applyRow(DEFAULT_CONFIG, "titleCwd").title.showCwd, true);
	assert.equal(applyRow(DEFAULT_CONFIG, "titleModel").title.showModel, true);
	assert.equal(applyRow(DEFAULT_CONFIG, "titleThinking").title.showThinking, true);
	assert.equal(applyRow(DEFAULT_CONFIG, "titleGit").title.showGit, true);
	assert.equal(applyRow(DEFAULT_CONFIG, "titleMaestro").title.showMaestro, true);
	// Round trip back on.
	assert.equal(applyRow(applyRow(DEFAULT_CONFIG, "titleEnabled"), "titleEnabled").title.enabled, true);
});

test("title generation model is a picker row that commits its ref and clears on empty", () => {
	const empty = buildRows(DEFAULT_CONFIG).find((r) => r.key === "titleGenerationModel")!;
	assert.deepEqual(
		{ value: empty.value, next: empty.next, accel: empty.accel, kind: empty.kind },
		{ value: "(rule-based)", next: "picker…", accel: "z", kind: "select" },
	);
	// A picked ref lands in the config and shows up on the row.
	const committed = applyRow(DEFAULT_CONFIG, "titleGenerationModel", "maestro-qwen/qwen3.8-max-preview");
	assert.equal(committed.title.generationModel, "maestro-qwen/qwen3.8-max-preview");
	assert.equal(
		buildRows(committed).find((r) => r.key === "titleGenerationModel")!.value,
		"maestro-qwen/qwen3.8-max-preview",
	);
	// Empty pick clears back to the offline rule-based extractor.
	assert.equal(applyRow(committed, "titleGenerationModel", "").title.generationModel, "");
	assert.equal(applyRow(committed, "titleGenerationModel", "   ").title.generationModel, "");
});

test("title generation model row does not cycle when applyRow gets no ref", () => {
	// Guards the empty-vs-applyRow contract: a blind Enter without a ref
	// must clear the model back to rule-based, never keep a stale value.
	const configured = { ...DEFAULT_CONFIG, title: { ...DEFAULT_CONFIG.title, generationModel: "p/m" } };
	assert.equal(applyRow(configured, "titleGenerationModel").title.generationModel, "");
});
