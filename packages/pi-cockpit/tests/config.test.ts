import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfig, mergeConfigDocument } from "../src/config.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

test("stackStyle accepts classic or zen and serializes the active projection", () => {
	assert.equal(DEFAULT_CONFIG.stackStyle, "classic");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { stackStyle: "zen" }).stackStyle, "zen");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { stackStyle: "classic" }).stackStyle, "classic");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { stackStyle: "dense" }).stackStyle, "classic");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { stackStyle: null }).stackStyle, "classic");
	const document = mergeConfigDocument({ future: true }, { ...DEFAULT_CONFIG, stackStyle: "zen" });
	assert.equal(document.stackStyle, "zen");
	assert.equal(document.future, true);
});

test("staticMode merges as a boolean and keeps the default", () => {
	assert.equal(DEFAULT_CONFIG.staticMode, false);
	assert.equal(mergeConfig(DEFAULT_CONFIG, {}).staticMode, false);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { staticMode: true }).staticMode, true);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { staticMode: "yes" }).staticMode, false);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { staticMode: null }).staticMode, false);
});

test("staticMode invalid values fall back to the caller's base", () => {
	const enabledBase = { ...DEFAULT_CONFIG, staticMode: true };
	assert.equal(mergeConfig(enabledBase, {}).staticMode, true);
	assert.equal(mergeConfig(enabledBase, { staticMode: "no" }).staticMode, true);
	assert.equal(mergeConfig(enabledBase, { staticMode: null }).staticMode, true);
	assert.equal(mergeConfig(enabledBase, { staticMode: false }).staticMode, false);
});

test("currency merges as usd|cny and rate clamps to a positive number", () => {
	assert.equal(DEFAULT_CONFIG.currency, "usd");
	assert.equal(DEFAULT_CONFIG.currencyRate, 7.2);
	assert.equal(mergeConfig(DEFAULT_CONFIG, {}).currency, "usd");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { currency: "cny" }).currency, "cny");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { currency: "eur" }).currency, "usd");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { currencyRate: 8 }).currencyRate, 8);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { currencyRate: 0 }).currencyRate, 7.2);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { currencyRate: -3 }).currencyRate, 7.2);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { currencyRate: 500 }).currencyRate, 100);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { currencyRate: 7.135 }).currencyRate, 7.14);
});

test("legacy config without quietSymbols keeps the check default", () => {
	const config = mergeConfig(DEFAULT_CONFIG, { quietMode: true });
	assert.equal(config.quietMode, true);
	assert.equal(config.quietSymbols, "check");
});

test("pinEditorBottom is opt-in and accepts only boolean values", () => {
	assert.equal(DEFAULT_CONFIG.pinEditorBottom, false);
	assert.equal(mergeConfig(DEFAULT_CONFIG, {}).pinEditorBottom, false);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { pinEditorBottom: true }).pinEditorBottom, true);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { pinEditorBottom: "true" }).pinEditorBottom, false);
});

test("claude-style interaction settings are independent opt-in booleans, default off", () => {
	for (const key of ["doubleEscapeClearInput", "fullscreenInput", "copyOnSelect"] as const) {
		assert.equal(DEFAULT_CONFIG[key], false, `${key} must default to false`);
		assert.equal(mergeConfig(DEFAULT_CONFIG, {} as Record<string, unknown>)[key], false);
		assert.equal(mergeConfig(DEFAULT_CONFIG, { [key]: true } as Record<string, unknown>)[key], true);
		assert.equal(mergeConfig(DEFAULT_CONFIG, { [key]: "yes" } as Record<string, unknown>)[key], false);
		assert.equal(mergeConfig(DEFAULT_CONFIG, { [key]: null } as Record<string, unknown>)[key], false);
	}
	// Independent: turning one on leaves the other two off.
	const one = mergeConfig(DEFAULT_CONFIG, { fullscreenInput: true } as Record<string, unknown>);
	assert.equal(one.fullscreenInput, true);
	assert.equal(one.doubleEscapeClearInput, false);
	assert.equal(one.copyOnSelect, false);
});

test("quietSymbols accepts supported modes and rejects unknown values", () => {
	assert.equal(mergeConfig(DEFAULT_CONFIG, { quietSymbols: "dot" }).quietSymbols, "dot");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { quietSymbols: "check" }).quietSymbols, "check");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { quietSymbols: "icons" }).quietSymbols, "check");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { quietSymbols: null }).quietSymbols, "check");
});

test("toolPalette accepts supported modes and rejects unknown values", () => {
	assert.equal(mergeConfig(DEFAULT_CONFIG, { toolPalette: "mono" }).toolPalette, "mono");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { toolPalette: "classic" }).toolPalette, "classic");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { toolPalette: "search" }).toolPalette, "search");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { toolPalette: "neon" }).toolPalette, "family");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { toolPalette: null }).toolPalette, "family");
});

test("legacy config without toolPalette keeps the family default", () => {
	assert.equal(mergeConfig(DEFAULT_CONFIG, { quietMode: true }).toolPalette, "family");
});

test("legacy config without sidebar keeps sidebar defaults", () => {
	const config = mergeConfig(DEFAULT_CONFIG, { enabled: false, todoMode: "compact" });
	assert.equal(config.enabled, false);
	assert.equal(config.todoMode, "compact");
	assert.deepEqual(config.sidebar, { mode: "off", width: 40, density: "comfortable" });
	assert.notEqual(config.sidebar, DEFAULT_CONFIG.sidebar);
});

test("sidebar merges supported fields and clamps width to terminal column bounds", () => {
	assert.deepEqual(
		mergeConfig(DEFAULT_CONFIG, { sidebar: { mode: "on", width: 48, density: "compact" } }).sidebar,
		{ mode: "on", width: 48, density: "compact" },
	);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { sidebar: { width: 12 } }).sidebar.width, 32);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { sidebar: { width: 80 } }).sidebar.width, 56);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { sidebar: { width: 41.6 } }).sidebar.width, 42);
});

test("serialized config documents preserve unknown extension fields", () => {
	const document = mergeConfigDocument({
		unknownTop: true,
		icons: { mode: "nerd", future: 1 },
		sidebar: { mode: "off", width: 36, density: "compact", future: 2 },
	}, {
		...DEFAULT_CONFIG,
		icons: { mode: "ascii" },
		sidebar: { mode: "on", width: 48, density: "comfortable" },
	});
	assert.equal(document.unknownTop, true);
	assert.equal(document.staticMode, false);
	assert.equal(document.toolPalette, "family");
	assert.equal(document.pinEditorBottom, false);
	assert.equal(document.doubleEscapeClearInput, false);
	assert.equal(document.fullscreenInput, false);
	assert.equal(document.copyOnSelect, false);
	assert.deepEqual(document.icons, { mode: "ascii", future: 1 });
	assert.deepEqual(document.sidebar, { mode: "on", width: 48, density: "comfortable", future: 2 });
});

test("invalid or partial sidebar fields fall back independently", () => {
	const base = {
		...DEFAULT_CONFIG,
		sidebar: { mode: "off" as const, width: 36, density: "compact" as const },
	};
	assert.deepEqual(
		mergeConfig(base, { sidebar: { mode: "sometimes", width: Number.NaN, density: "dense" } }).sidebar,
		base.sidebar,
	);
	assert.deepEqual(
		mergeConfig(base, { sidebar: { mode: "on" } }).sidebar,
		{ mode: "on", width: 36, density: "compact" },
	);
	assert.deepEqual(mergeConfig(base, { sidebar: null }).sidebar, base.sidebar);
});

test("title merges supported fields and clamps maxLength to sane bounds", () => {
	assert.deepEqual(
		mergeConfig(DEFAULT_CONFIG, { title: { enabled: false, showSession: false, maxLength: 120 } }).title,
		{ ...DEFAULT_CONFIG.title, enabled: false, showSession: false, maxLength: 120 },
	);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { title: { maxLength: 3 } }).title.maxLength, 20);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { title: { maxLength: 900 } }).title.maxLength, 200);
});

test("invalid or partial title fields fall back independently", () => {
	const merged = mergeConfig(DEFAULT_CONFIG, {
		title: { enabled: "yes", showModel: true, showThinking: null, maxLength: Number.NaN },
	});
	assert.equal(merged.title.enabled, true);
	assert.equal(merged.title.showModel, true);
	assert.equal(merged.title.showThinking, DEFAULT_CONFIG.title.showThinking);
	assert.equal(merged.title.maxLength, DEFAULT_CONFIG.title.maxLength);
	assert.deepEqual(mergeConfig(DEFAULT_CONFIG, { title: null }).title, DEFAULT_CONFIG.title);
});

test("legacy config without usage keeps usage defaults", () => {
	const config = mergeConfig(DEFAULT_CONFIG, { enabled: false, todoMode: "compact" });
	assert.deepEqual(config.usage, {
		enabled: true,
		footer: true,
		pollIntervalMs: 120_000,
		barWidth: 8,
		commandKey: "usage",
	});
	assert.notEqual(config.usage, DEFAULT_CONFIG.usage);
});

test("usage merges supported fields and clamps poll/bar bounds", () => {
	assert.deepEqual(
		mergeConfig(DEFAULT_CONFIG, { usage: { enabled: false, footer: false, pollIntervalMs: 60_000, barWidth: 12, commandKey: "quota" } }).usage,
		{ enabled: false, footer: false, pollIntervalMs: 60_000, barWidth: 12, commandKey: "quota" },
	);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { usage: { pollIntervalMs: 1_000 } }).usage.pollIntervalMs, 30_000);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { usage: { pollIntervalMs: 99_999_999 } }).usage.pollIntervalMs, 1_800_000);
	// 0 (and negatives) select manual refresh mode instead of clamping to the floor.
	assert.equal(mergeConfig(DEFAULT_CONFIG, { usage: { pollIntervalMs: 0 } }).usage.pollIntervalMs, 0);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { usage: { pollIntervalMs: -5_000 } }).usage.pollIntervalMs, 0);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { usage: { barWidth: 2 } }).usage.barWidth, 4);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { usage: { barWidth: 99 } }).usage.barWidth, 16);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { usage: { barWidth: 41.6 } }).usage.barWidth, 8);
});

test("invalid or partial usage fields fall back independently", () => {
	const merged = mergeConfig(DEFAULT_CONFIG, {
		usage: { enabled: "yes", footer: null, pollIntervalMs: Number.NaN, barWidth: 3.2, commandKey: "   " },
	});
	assert.equal(merged.usage.enabled, true);
	assert.equal(merged.usage.footer, true);
	assert.equal(merged.usage.pollIntervalMs, 120_000);
	assert.equal(merged.usage.barWidth, 8);
	assert.equal(merged.usage.commandKey, "usage");
	assert.deepEqual(mergeConfig(DEFAULT_CONFIG, { usage: null }).usage, DEFAULT_CONFIG.usage);
});
