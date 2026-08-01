import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfig } from "../src/config.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

test("legacy config without quietSymbols keeps the check default", () => {
	const config = mergeConfig(DEFAULT_CONFIG, { quietMode: true });
	assert.equal(config.quietMode, true);
	assert.equal(config.quietSymbols, "check");
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
