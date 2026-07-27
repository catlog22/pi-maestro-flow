import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	TEAMMATE_COMPLETE_EVENT as PUBLIC_TEAMMATE_COMPLETE_EVENT,
	TEAMMATE_MESSAGE_EVENT as PUBLIC_TEAMMATE_MESSAGE_EVENT,
	TEAMMATE_STARTED_EVENT as PUBLIC_TEAMMATE_STARTED_EVENT,
} from "pi-maestro-teammate/v1/events";
import {
	BASH_BG_QUERY_EVENT,
	BASH_BG_UPDATE_EVENT,
	COCKPIT_TODO_TOGGLE_EVENT,
	COCKPIT_UI_OWNERSHIP_EVENT,
	DEFAULT_CONFIG,
	TEAMMATE_COMPLETE_EVENT,
	TEAMMATE_MESSAGE_EVENT,
	TEAMMATE_STARTED_EVENT,
} from "../src/types.ts";
import cockpitEntry from "../src/index.ts";
import extensionEntry from "../src/extension/index.ts";

test("Cockpit defaults Todo to a one-line collapsed summary", () => {
	assert.equal(DEFAULT_CONFIG.todoExpanded, false);
});

test("Cockpit loads through the standard extension path without changing its public entry", () => {
	const packageJson = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	) as { main?: string; exports?: Record<string, string>; pi?: { extensions?: string[]; themes?: string[] } };
	assert.deepEqual(packageJson.pi?.extensions, ["./src/extension/index.ts"]);
	assert.deepEqual(packageJson.pi?.themes, ["./themes"]);
	assert.equal(packageJson.main, "./src/index.ts");
	assert.equal(packageJson.exports?.["."], "./src/index.ts");
	assert.equal(extensionEntry, cockpitEntry);
});

test("Cockpit packages complete selectable color themes", () => {
	for (const name of ["cockpit-notion", "cockpit-ocean", "cockpit-amber", "cockpit-minimal"]) {
		const theme = JSON.parse(
			readFileSync(new URL(`../themes/${name}.json`, import.meta.url), "utf8"),
		) as { name?: string; vars?: Record<string, string>; colors?: Record<string, string> };
		assert.equal(theme.name, name);
		assert.ok(Object.keys(theme.colors ?? {}).length >= 51);
		if (name === "cockpit-minimal") {
			assert.equal(theme.vars?.lightGray, "#b8c0ca");
			for (const slot of [
				"thinkingOff",
				"thinkingMinimal",
				"thinkingLow",
				"thinkingMedium",
				"thinkingHigh",
				"thinkingXhigh",
				"thinkingMax",
				"bashMode",
			]) {
				assert.equal(theme.colors?.[slot], "lightGray");
			}
		}
	}
});

test("Cockpit owns native UI through events instead of clearing foreign widget keys", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.match(source, /pi\.events\.emit\(COCKPIT_UI_OWNERSHIP_EVENT/);
	assert.match(source, /pi\.events\.on\(COCKPIT_TODO_TOGGLE_EVENT/);
	assert.doesNotMatch(source, /teammate-agents|todo-panel/);
	assert.equal(COCKPIT_UI_OWNERSHIP_EVENT, "cockpit:ui-ownership");
	assert.equal(COCKPIT_TODO_TOGGLE_EVENT, "cockpit:toggle-todo");
});

test("Cockpit teammate event names stay aligned with the public v1 contract", () => {
	assert.equal(TEAMMATE_STARTED_EVENT, PUBLIC_TEAMMATE_STARTED_EVENT);
	assert.equal(TEAMMATE_MESSAGE_EVENT, PUBLIC_TEAMMATE_MESSAGE_EVENT);
	assert.equal(TEAMMATE_COMPLETE_EVENT, PUBLIC_TEAMMATE_COMPLETE_EVENT);
});

test("Flow publishes authoritative bash_bg snapshots and Cockpit can request a refresh", () => {
	const cockpitSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	const flowSource = readFileSync(
		new URL("../../pi-maestro-flow/src/tools/bash-bg.ts", import.meta.url),
		"utf8",
	);
	assert.equal(BASH_BG_UPDATE_EVENT, "bash-bg:update");
	assert.equal(BASH_BG_QUERY_EVENT, "bash-bg:query");
	assert.match(flowSource, /pi\.events\.emit\(BASH_BG_UPDATE_EVENT/);
	assert.match(flowSource, /pi\.events\.on\(BASH_BG_QUERY_EVENT, publishSnapshot\)/);
	assert.match(cockpitSource, /pi\.events\.on\(BASH_BG_UPDATE_EVENT/);
	assert.match(cockpitSource, /pi\.events\.emit\(BASH_BG_QUERY_EVENT/);
	assert.match(cockpitSource, /registerShortcut\(BASH_BG_OVERLAY_KEY/);
});

test("Cockpit follows terminal width changes while the footer is idle", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.match(source, /tui\.terminal\.columns/);
	assert.match(source, /tui\.invalidate\(\)/);
	assert.match(source, /tui\.requestRender\(true\)/);
	assert.match(source, /clearInterval\(widthTimer\)/);
});
