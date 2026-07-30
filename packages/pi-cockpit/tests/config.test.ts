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
