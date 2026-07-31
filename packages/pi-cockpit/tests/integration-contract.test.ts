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
import {
	COCKPIT_MAESTRO_QUERY_EVENT,
	MAESTRO_UI_SNAPSHOT_EVENT,
	MAESTRO_UI_SNAPSHOT_VERSION,
} from "../src/public/v1/events.ts";
import cockpitEntry, { resolveCockpitSurfaceState } from "../src/index.ts";
import extensionEntry from "../src/extension/index.ts";

test("Cockpit defaults Todo to a one-line collapsed summary and Quiet to check symbols", () => {
	assert.equal(DEFAULT_CONFIG.todoExpanded, false);
	assert.equal(DEFAULT_CONFIG.quietSymbols, "check");
});

test("Cockpit resolves one actual surface from enablement and deferred dock visibility", () => {
	assert.equal(resolveCockpitSurfaceState(false, "auto", true), "disabled");
	assert.equal(resolveCockpitSurfaceState(true, "off", true), "widgets");
	assert.equal(resolveCockpitSurfaceState(true, "auto", false), "widgets");
	assert.equal(resolveCockpitSurfaceState(true, "on", true), "dock");
});

test("Cockpit loads through the standard extension path without changing its public entry", () => {
	const packageJson = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	) as { main?: string; exports?: Record<string, string>; pi?: { extensions?: string[]; themes?: string[] } };
	assert.deepEqual(packageJson.pi?.extensions, ["./src/extension/index.ts"]);
	assert.deepEqual(packageJson.pi?.themes, ["./themes"]);
	assert.equal(packageJson.main, "./src/index.ts");
	assert.equal(packageJson.exports?.["."], "./src/index.ts");
	assert.equal(packageJson.exports?.["./v1/events"], "./src/public/v1/events.ts");
	assert.equal(extensionEntry, cockpitEntry);
});

test("Cockpit packages complete selectable color themes", () => {
	const minimalThemes = [
		"cockpit-minimal",
		"cockpit-minimal-green",
		"cockpit-minimal-purple",
		"cockpit-minimal-cyan",
		"cockpit-minimal-amber",
		"cockpit-minimal-rose",
	];
	const minimalAccents: Record<string, string> = {
		"cockpit-minimal": "#79b8ff",
		"cockpit-minimal-green": "#79d49a",
		"cockpit-minimal-purple": "#c3a6ff",
		"cockpit-minimal-cyan": "#72d5d1",
		"cockpit-minimal-amber": "#e6b566",
		"cockpit-minimal-rose": "#e7a2b6",
	};
	for (const name of ["cockpit-notion", "cockpit-ocean", "cockpit-amber", ...minimalThemes]) {
		const theme = JSON.parse(
			readFileSync(new URL(`../themes/${name}.json`, import.meta.url), "utf8"),
		) as { name?: string; vars?: Record<string, string>; colors?: Record<string, string> };
		assert.equal(theme.name, name);
		assert.ok(Object.keys(theme.colors ?? {}).length >= 51);
		if (minimalThemes.includes(name)) {
			assert.equal(theme.vars?.accent, minimalAccents[name]);
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
	assert.match(source, /quietSymbols: config\.quietSymbols/);
	assert.match(source, /footer: config\.enabled/);
	assert.match(source, /footer: false/);
	assert.match(source, /sidebar: ownsDock/);
	assert.match(source, /goal: ownsDock/);
	assert.match(source, /sidebar: false/);
	assert.match(source, /goal: false/);
	assert.match(source, /pi\.events\.on\(COCKPIT_TODO_TOGGLE_EVENT/);
	assert.doesNotMatch(source, /teammate-agents|todo-panel/);
	assert.equal(COCKPIT_UI_OWNERSHIP_EVENT, "cockpit:ui-ownership");
	assert.equal(COCKPIT_TODO_TOGGLE_EVENT, "cockpit:toggle-todo");
});

test("Cockpit acquires the footer before installing and releases it before deferred re-enable", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.match(
		source,
		/session_start[\s\S]*?if \(config\.enabled\) \{\s*publishUiOwnership\(\);\s*applyUi\(ctx\);\s*\} else \{\s*applyUi\(ctx\);\s*publishUiOwnership\(\);/,
	);
	assert.match(
		source,
		/if \(wasEnabled !== config\.enabled\)[\s\S]*?if \(config\.enabled\) \{[\s\S]*?enableAfterClose = true;[\s\S]*?\} else \{[\s\S]*?uninstallUi\(ctx\);[\s\S]*?publishUiOwnership\(\);/,
	);
});

test("Cockpit teammate event names stay aligned with the public v1 contract", () => {
	assert.equal(TEAMMATE_STARTED_EVENT, PUBLIC_TEAMMATE_STARTED_EVENT);
	assert.equal(TEAMMATE_MESSAGE_EVENT, PUBLIC_TEAMMATE_MESSAGE_EVENT);
	assert.equal(TEAMMATE_COMPLETE_EVENT, PUBLIC_TEAMMATE_COMPLETE_EVENT);
});

test("Cockpit consumes Maestro snapshots and emits versioned queries at session start and dock acquisition", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.equal(COCKPIT_MAESTRO_QUERY_EVENT, "cockpit:maestro-query");
	assert.equal(MAESTRO_UI_SNAPSHOT_EVENT, "maestro:ui-snapshot");
	assert.equal(MAESTRO_UI_SNAPSHOT_VERSION, 1);
	assert.match(source, /new MaestroStore\(\)/);
	assert.match(source, /pi\.events\.on\(MAESTRO_UI_SNAPSHOT_EVENT/);
	assert.match(source, /maestro\.applySnapshot\(payload\)/);
	assert.match(source, /pi\.events\.emit\(COCKPIT_MAESTRO_QUERY_EVENT, \{ version: MAESTRO_UI_SNAPSHOT_VERSION \}\)/);
	assert.match(source, /if \(visible\) emitMaestroQuery\(\)/);
	assert.match(source, /session_start[\s\S]*?emitMaestroQuery\(\)/);
});

test("Cockpit defers settings-driven re-enable until the settings overlay is closed", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.match(source, /let enableAfterClose = false/);
	assert.match(source, /if \(config\.enabled\) \{[\s\S]*?enableAfterClose = true;[\s\S]*?\} else \{/);
	assert.match(source, /dispose\(\): void \{[\s\S]*?if \(enableAfterClose && config\.enabled\)[\s\S]*?queueMicrotask[\s\S]*?publishUiOwnership\(\);[\s\S]*?applyUi\(ctx\)/);
	assert.doesNotMatch(source, /if \(config\.enabled\) \{\s*publishUiOwnership\(\);\s*applyUi\(ctx\);\s*\} else \{\s*enableAfterClose/);
});

test("Cockpit sidebar controls persist only committed resize widths", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.match(source, /onResizeCommit: \(width\) => \{[\s\S]*?sidebar: \{ \.\.\.config\.sidebar, width \}[\s\S]*?saveConfig\(config\)/);
	assert.match(source, /width kept for this session; save failed/);
	assert.match(source, /registerShortcut\(SIDEBAR_RESIZE_KEY/);
	assert.match(source, /"sidebar auto"[\s\S]*?"sidebar on"[\s\S]*?"sidebar off"[\s\S]*?"sidebar resize"/);
	assert.doesNotMatch(source, /onEffectiveWidthChange:[\s\S]*?saveConfig/);
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
	assert.match(cockpitSource, /bashBgStatus: renderBashBgSummary|const bashBgStatus = renderBashBgSummary/);
	assert.match(cockpitSource, /registerShortcut\(BASH_BG_OVERLAY_KEY/);
});

test("Cockpit follows terminal width changes while the footer is idle", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.match(source, /tui\.terminal\.columns/);
	assert.match(source, /tui\.invalidate\(\)/);
	assert.match(source, /tui\.requestRender\(true\)/);
	assert.match(source, /clearInterval\(widthTimer\)/);
});

test("Cockpit working label follows the foreground tool lifecycle", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.match(source, /pi\.on\("tool_execution_start"/);
	assert.match(source, /activeTools\.set\(e\.toolCallId, e\.toolName\)/);
	assert.match(source, /activeTools\.delete\(e\.toolCallId\)/);
	assert.match(source, /activeTool: \[\.\.\.activeTools\.values\(\)\]\.at\(-1\)/);
});
