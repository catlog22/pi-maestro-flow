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
	COCKPIT_UI_OWNERSHIP_EVENT,
	COCKPIT_UI_OWNERSHIP_QUERY_EVENT,
	DEFAULT_CONFIG,
	TEAMMATE_COMPLETE_EVENT,
	TEAMMATE_MESSAGE_EVENT,
	TEAMMATE_STARTED_EVENT,
} from "../src/types.ts";
import {
	COCKPIT_INPUT_TARGET_EVENT,
	COCKPIT_MAESTRO_QUERY_EVENT,
	COCKPIT_SESSION_LIST_EVENT,
	COCKPIT_TODO_TOGGLE_EVENT,
	MAESTRO_TODO_STATE_CHANGED_EVENT,
	MAESTRO_UI_SNAPSHOT_EVENT,
	MAESTRO_UI_SNAPSHOT_VERSION,
} from "../src/public/v1/events.ts";
import cockpitEntry, { resolveCockpitSurfaceState } from "../src/index.ts";
import extensionEntry from "../src/extension/index.ts";
import { SESSION_BAR_WIDGET_KEY } from "../src/session-bar.ts";
import { SessionUiState } from "../src/session-ui-state.ts";

/** Keep ordered source contracts inside their actual state-machine boundary. */
function sourceSection(source: string, start: string, end: string): string {
	const from = source.indexOf(start);
	assert.ok(from >= 0, `missing boundary: ${start}`);
	const to = source.indexOf(end, from + start.length);
	assert.ok(to > from, `missing closing boundary: ${end}`);
	return source.slice(from, to);
}

test("Cockpit defaults Todo to a one-line collapsed summary and Quiet to dot symbols", () => {
	assert.equal(DEFAULT_CONFIG.todoExpanded, false);
	assert.equal(DEFAULT_CONFIG.quietMode, true);
	assert.equal(DEFAULT_CONFIG.quietSymbols, "dot");
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

test("Cockpit session bar, command, and shortcut contracts stay stable", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.equal(SESSION_BAR_WIDGET_KEY, "cockpit-session-bar");
  assert.deepEqual(
    [...source.matchAll(/pi\.registerCommand\("([^"]+)"/g)].map((match) => match[1]),
    ["theme", "maestro-settings", "cockpit", "supervision"],
  );

  const shortcutConstants = Object.fromEntries(
    [...source.matchAll(/const (BASH_BG_OVERLAY_KEY|SIDEBAR_RESIZE_KEY|SIDEBAR_FOCUS_KEY|SESSION_DETAIL_TOGGLE_KEY) = "([^"]+)"/g)]
      .map((match) => [match[1], match[2]]),
  );
  assert.deepEqual(shortcutConstants, {
    BASH_BG_OVERLAY_KEY: "alt+j",
    SIDEBAR_RESIZE_KEY: "ctrl+shift+r",
    SIDEBAR_FOCUS_KEY: "alt+l",
    SESSION_DETAIL_TOGGLE_KEY: "alt+e",
  });
  assert.deepEqual(
    [...source.matchAll(/pi\.registerShortcut\(([^,]+),/g)].map((match) => match[1]),
    ["BASH_BG_OVERLAY_KEY", "TODO_OVERLAY_KEY", "SIDEBAR_RESIZE_KEY", "SESSION_DETAIL_TOGGLE_KEY", "SIDEBAR_FOCUS_KEY"],
  );

  assert.match(source, /todoOverlayShortcutDisposer = ctx\.ui\.onTerminalInput\(\(data\) => \{[\s\S]*?isLegacyTodoOverlayInput\(data\)[\s\S]*?openTodoOverlay\(ctx\)[\s\S]*?consume: true/);
  assert.match(source, /windowPrevious = sessionUi\.mode === "window" && matchesKey\(data, "alt\+left"\)/);
  assert.match(source, /windowNext = sessionUi\.mode === "window" && matchesKey\(data, "alt\+right"\)/);
  assert.match(source, /if \(!windowPrevious && !windowNext && text\.trim\(\) !== ""\) return undefined/);
  assert.doesNotMatch(source, /sessionDetailScrollDisposer/);
  assert.match(source, /COCKPIT_SESSION_LIST_EVENT[\s\S]*?openSessionList\(ctx\)/);
  assert.match(source, /allEntries = mode === "window" \? \[\.\.\.snapshot\.windows\] : \[\.\.\.snapshot\.endpoints\]/);
  assert.match(source, /ctx\.ui\.select\([\s\S]*?tuiT\("window\.title"\)[\s\S]*?tuiT\("overlay\.agents\.title"\)/);
  assert.match(source, /const sessionBarHint = \(\) =>/);
  assert.match(source, /maestro\.snapshot\(\)\?\.artifact\?\.available[\s\S]*?tuiT\("artifact\.hint"\)[\s\S]*?sessionUi\.mode === "agent" \? "session\.agentListHint" : "session\.listHint"/);
  assert.match(source, /showOwner = mode === "window" \|\| endpoint\.kind === "root"[\s\S]*?ownerDisplayToken\(endpoint\.label, endpoint\.registryEndpoint\.ownerId\)/);
  assert.doesNotMatch(source, /alt\+shift\+(?:r|l|up|down)/);
  const navigation = sourceSection(source, "sessionBarNavDisposer = ctx.ui.onTerminalInput", "const releaseUiOwnership");
  assert.match(navigation, /if \(ambientKeysShouldYield\(capturedTui\)\) return undefined/);
  assert.match(navigation, /const plainPrevious = data === "\\x1b\[D"/);
  assert.match(navigation, /const plainNext = data === "\\x1b\[C"/);
  assert.match(navigation, /if \(!windowPrevious && !windowNext && !plainPrevious && !plainNext\) return undefined/);
  assert.doesNotMatch(navigation, /\\x1b\[1;2[AB]/);
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
	assert.match(source, /pi\.events\.on\(COCKPIT_UI_OWNERSHIP_QUERY_EVENT/);
	const snapshot = sourceSection(source, "const uiOwnershipSnapshot", "const publishUiOwnership");
	// Intent alone cannot suppress native UI: every owned surface is gated by
	// the effective claim, and dock-only surfaces also require a visible dock.
	assert.match(snapshot, /const ownsDock = uiOwnershipClaimed && surfaceState === "dock"/);
	assert.match(snapshot, /todo: uiOwnershipClaimed/);
	assert.match(snapshot, /agents: uiOwnershipClaimed && config\.hideNativeAgents/);
	assert.match(snapshot, /sessionList: uiOwnershipClaimed/);
	assert.match(source, /todoDurationChart: config\.todoDurationChart/);
	assert.match(source, /quietSymbols: config\.quietSymbols/);
	assert.match(snapshot, /footer: uiOwnershipClaimed/);
	assert.match(snapshot, /quiet: uiOwnershipClaimed && config\.quietMode/);
	assert.match(snapshot, /sidebar: ownsDock/);
	assert.match(snapshot, /goal: ownsDock/);
	const release = sourceSection(source, "const releaseUiOwnership", "const acquireUiOwnership");
	assert.match(release, /uninstallUi\(ctx\);[\s\S]*?finally \{\s*uiOwnershipClaimed = false;\s*publishUiOwnership\(\);/);
	assert.match(source, /pi\.events\.on\(COCKPIT_TODO_TOGGLE_EVENT/);
	assert.doesNotMatch(source, /teammate-agents|todo-panel/);
	assert.equal(COCKPIT_UI_OWNERSHIP_EVENT, "cockpit:ui-ownership");
	assert.equal(COCKPIT_UI_OWNERSHIP_QUERY_EVENT, "cockpit:ui-ownership-query");
	assert.equal(COCKPIT_SESSION_LIST_EVENT, "cockpit:open-session-list");
	assert.equal(COCKPIT_TODO_TOGGLE_EVENT, "cockpit:toggle-todo");
});

test("Ownership handshake: late subscribers can query and both consumers ask", () => {
	const cockpitSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	// Cockpit answers the query with a fresh broadcast and re-broadcasts when
	// agent activity starts (the moment a native widget would otherwise appear).
	const responder = sourceSection(cockpitSource, "let ownershipQueryDisposer", "const setTodoExpanded");
	assert.match(responder, /ownershipQueryDisposer \?\?= pi\.events\.on\(COCKPIT_UI_OWNERSHIP_QUERY_EVENT, publishUiOwnership\)/);
	assert.match(responder, /ownershipQueryDisposer\?\.\(\);[\s\S]*?ownershipQueryDisposer = undefined/);
	assert.match(responder, /ensureOwnershipQueryResponder\(\);[\s\S]*?publishUiOwnership\(\);/);
	const start = sourceSection(cockpitSource, 'pi.on("session_start"', 'pi.on("session_shutdown"');
	assert.match(start, /uiOwnershipClaimed = false;\s*ensureOwnershipQueryResponder\(\);\s*publishUiOwnership\(\);/);
	const shutdown = sourceSection(cockpitSource, 'pi.on("session_shutdown"', 'pi.on("before_agent_start"');
	assert.match(shutdown, /unsubscribeBusEvents\(\);\s*disposeOwnershipQueryResponder\(\);/);
	const startedBlock = cockpitSource.match(
		/pi\.events\.on\(TEAMMATE_STARTED_EVENT, \(payload\) => \{[\s\S]*?\n\t\t\t\}\)\,/,
	);
	assert.ok(startedBlock, "TEAMMATE_STARTED subscription not found");
	assert.match(startedBlock[0], /publishUiOwnership\(\);/);
	const teammateSource = readFileSync(
		new URL("../../pi-maestro-teammate/src/extension/index.ts", import.meta.url),
		"utf8",
	);
	const flowSource = readFileSync(
		new URL("../../pi-maestro-flow/src/extension/index.ts", import.meta.url),
		"utf8",
	);
	// Both consumers ask after subscribing and again on session_start, so either
	// extension load order converges on cockpit-owned surfaces.
	for (const [name, source] of [["teammate", teammateSource], ["flow", flowSource]] as const) {
		const emits = source.match(/pi\.events\.emit\(COCKPIT_UI_OWNERSHIP_QUERY_EVENT, undefined\)/g) ?? [];
		assert.ok(emits.length >= 2, `${name} must emit the ownership query at subscribe time and on session_start`);
	}
	// Neither order can strand the native panels: cockpit also answers queries
	// emitted before its own session_start broadcast.
	assert.equal(COCKPIT_UI_OWNERSHIP_QUERY_EVENT, "cockpit:ui-ownership-query");
});

test("Cockpit owns, retries, and releases the viewport-stability patch across TUI modes", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.match(source, /let viewportStabilityPatch: ViewportStabilityPatch \| undefined/);
	assert.match(
		source,
		/const ensureViewportStability[^]*?if \(tui\.mode === "fullscreen"\) return;[^]*?viewportStabilityPatch\?\.active[^]*?const patch = attachViewportStability\(tui\);[^]*?stabilityTui = patch\.active \? tui : undefined;/,
	);
	assert.match(
		source,
		/const requestCapturedRender[^]*?ensureViewportStability\(tui\);[^]*?tui\.requestRender\(\);/,
	);
	assert.match(source, /requestRender: requestCapturedRender/);
	assert.match(
		source,
		/const req[^]*?requestCapturedRender\(\);[^]*?activeAgentOverlayRender\?\.\(\);[^]*?sidebarController\?\.requestRender\(\);/,
	);
	assert.match(
		source,
		/const uninstallUi[^]*?viewportStabilityPatch\?\.detach\(\);[^]*?viewportStabilityPatch = undefined;[^]*?stabilityTui = undefined;/,
	);
});

test("Cockpit installs compaction compact-form styling before resumed history renders", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.match(source, /let compactionStylePatch: CompactionStylePatch \| undefined/);
	assert.match(
		source,
		/config = loadConfig\(\);[^]*?compactionStylePatch = attachCompactionStyle\(\{[^]*?isEnabled: \(\) => config\.enabled[^]*?getTheme: \(\) => lastCtx\?\.ui\.theme[^]*?getGlyphs: \(\) => resolveGlyphs\(config\.icons\.mode\)[^]*?registerGuardedEditTool/,
	);
	assert.match(
		source,
		/session_shutdown[^]*?compactionStylePatch\?\.detach\(\);[^]*?compactionStylePatch = undefined/,
	);
});

test("Cockpit acquires the footer before installing and releases it before deferred re-enable", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	const start = sourceSection(source, 'pi.on("session_start"', 'pi.on("session_shutdown"');
	assert.match(start, /if \(config\.enabled\) acquireUiOwnership\(ctx\);\s*else releaseUiOwnership\(ctx\);/);
	const acquire = sourceSection(source, "const acquireUiOwnership", "const syncActiveAgentSurface");
	assert.match(acquire, /if \(!config\.enabled \|\| !isTuiContext\(ctx\)\) \{\s*uiOwnershipClaimed = false;\s*publishUiOwnership\(\);\s*return false;/);
	assert.match(acquire, /uiOwnershipClaimed = true;\s*publishUiOwnership\(\);\s*try \{\s*applyUi\(ctx\);/);
	assert.match(acquire, /catch \(error\) \{[\s\S]*?uninstallUi\(ctx\);[\s\S]*?uiOwnershipClaimed = false;\s*publishUiOwnership\(\);/);
	const release = sourceSection(source, "const releaseUiOwnership", "const acquireUiOwnership");
	assert.match(release, /uninstallUi\(ctx\);[\s\S]*?finally \{\s*uiOwnershipClaimed = false;\s*publishUiOwnership\(\);/);
	const toggle = sourceSection(source, "if (wasEnabled !== config.enabled)", "if (wasQuiet !== config.quietMode)");
	assert.match(toggle, /if \(config\.enabled\) \{[\s\S]*?enableAfterClose = true;\s*\} else \{\s*enableAfterClose = false;\s*releaseUiOwnership\(ctx\);/);
	assert.doesNotMatch(toggle, /acquireUiOwnership\(ctx\)|applyUi\(ctx\)/);
});

test("Cockpit teammate event names and payload ingestion stay aligned with the public v1 contract", () => {
	assert.equal(TEAMMATE_STARTED_EVENT, PUBLIC_TEAMMATE_STARTED_EVENT);
	assert.equal(TEAMMATE_MESSAGE_EVENT, PUBLIC_TEAMMATE_MESSAGE_EVENT);
	assert.equal(TEAMMATE_COMPLETE_EVENT, PUBLIC_TEAMMATE_COMPLETE_EVENT);
	const storeSource = readFileSync(new URL("../src/agents-store.ts", import.meta.url), "utf8");
	const cockpitSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	const teammateEventsSource = readFileSync(
		new URL("../../pi-maestro-teammate/src/public/v1/events.ts", import.meta.url),
		"utf8",
	);
	assert.match(storeSource, /TeammateProgressMessageEvent[\s\S]*AgentProgressSnapshot/);
	assert.match(storeSource, /p\.phase/);
	assert.match(storeSource, /p\.lastOutcome/);
	assert.match(teammateEventsSource, /TeammateProgressMessageEvent extends Omit<AgentProgressSnapshot/);
	assert.match(cockpitSource, /TEAMMATE_MESSAGE_EVENT[\s\S]*agentReads\.applyLegacyMessage\(payload\)/);
	assert.match(storeSource, /payload\.isSend === true \|\| payload\.isInteraction === true/);
	assert.doesNotMatch(cockpitSource, /agents\.apply(?:Started|Message|Complete)\([^\n]* as /);
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

test("Flow notifies Cockpit after every durable Todo mutation", () => {
	const cockpitSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	const flowSource = readFileSync(new URL("../../pi-maestro-flow/src/extension/index.ts", import.meta.url), "utf8");
	assert.equal(MAESTRO_TODO_STATE_CHANGED_EVENT, "maestro:todo-state-changed");
	assert.match(flowSource, /setTodoStateChangeListener\(\(\) => \{[\s\S]*?pi\.events\.emit\(MAESTRO_TODO_STATE_CHANGED_EVENT, \{ version: 1 \}\)/);
	assert.match(cockpitSource, /pi\.events\.on\(MAESTRO_TODO_STATE_CHANGED_EVENT[\s\S]*?todos\.hydrateFromEntries\(ctx\.sessionManager\.getEntries\(\)\)/);
});

test("selected Cockpit sessions publish editor targets and route input through teammate registry", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.equal(COCKPIT_INPUT_TARGET_EVENT, "cockpit:input-target");
	assert.match(source, /pi\.events\.emit\(COCKPIT_INPUT_TARGET_EVENT, payload\)/);
	assert.match(source, /sessionUi\.mode === "window" \? selectedWindowInputTarget\(\) : selectedAgentTarget\(\)/);
	assert.match(source, /sigil: "#"/);
	assert.match(source, /MAILBOX_REGISTRY_KEY[\s\S]*?routeAgentInput\(/);
	assert.match(source, /Symbol\.for\("pi-maestro-teammate\.mailbox-registry"\)/);
	assert.doesNotMatch(source, /import\s*\{\s*MAILBOX_REGISTRY_KEY/);
	assert.match(source, /if \(action === "handled"\) return \{ action: "handled" as const \}/);
});

test("Cockpit wires canonical target routing ahead of legacy and persistent routes", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	const canonical = source.indexOf("routeCanonicalTargetInput({");
	const legacyWindow = source.indexOf("if (hashWindowRoute)");
	const persistentWindow = source.indexOf("sessionUi.mode === \"window\"", legacyWindow);
	const persistentAgent = source.indexOf("routeAgentInput(", persistentWindow);
	assert.ok(canonical >= 0 && canonical < legacyWindow);
	assert.ok(legacyWindow < persistentWindow && persistentWindow < persistentAgent);
	assert.match(source, /createTargetAutocompleteProvider\([\s\S]*?createWindowAutocompleteProvider\(/u);
	assert.match(source, /activateSsh: activateSshHost/u);
	assert.match(source, /liveRegistry\?\.send\?\.\([\s\S]*?liveRegistry\?\.router\?\.route/u);
	assert.match(source, /pi\.on\("before_agent_start"[\s\S]*?pendingTargetReference = undefined[\s\S]*?formatPendingTargetContext/u);
	assert.match(source, /pi\.on\("agent_end"[\s\S]*?pendingTargetReference = undefined/u);
});

test("Cockpit defers settings-driven re-enable until the settings overlay is closed", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.match(source, /let enableAfterClose = false/);
	assert.match(source, /if \(config\.enabled\) \{[\s\S]*?enableAfterClose = true;[\s\S]*?\} else \{/);
	const settings = sourceSection(source, "const openSettings = async", "\n}");
	const finalize = sourceSection(settings, "const finalize =", "activeSettingsOverlay = { finalize }");
	assert.match(finalize, /if \(settled\) return;\s*settled = true;/);
	assert.match(finalize, /if \(enableAfterClose && config\.enabled\) \{\s*queueMicrotask\(\(\) => \{\s*if \(lastCtx !== ctx \|\| !config\.enabled\) return;\s*acquireUiOwnership\(ctx\);\s*req\(\);/);
	assert.match(finalize, /done\(undefined\)/);
	const component = sourceSection(settings, "const ui = {", "return ui;");
	assert.match(component, /dispose\(\): void \{[\s\S]*?finalize\(\);/);
	assert.doesNotMatch(source, /if \(config\.enabled\) \{\s*publishUiOwnership\(\);\s*applyUi\(ctx\);\s*\} else \{\s*enableAfterClose/);
});

test("Cockpit never pushes the dock overlay above a capturing overlay", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	// pi closes an overlay by popping the overlay-stack top, so a dock pushed
	// while a capturing overlay (legacy settings panel, /maestro-settings shell)
	// is open gets popped by that overlay's own close and strands it with Esc
	// dead. The show path must defer while a capturing overlay is visible and
	// flush once it closes; hide never pushes and stays immediate.
	assert.match(source, /let deferredSidebarSync = false/);
	assert.match(source, /\} else if \(capturingOverlayActive \|\| capturingOverlayVisible\(capturedTui\)\) \{\r?\n\t\t\tdeferredSidebarSync = true;/);
	assert.match(source, /if \(config\.sidebar\.mode === "off"\) \{\r?\n\t\t\tdeferredSidebarSync = false;\r?\n\t\t\tdockEffectiveVisible = false;\r?\n\t\t\tcontroller\.hide\(\)/);
	assert.match(source, /const exitCapturingOverlay = \(\): void => \{\r?\n\t\tcapturingOverlayActive = false;\r?\n\t\tflushDeferredSidebarSync\(\)/);
	// The unified settings shell is itself a capturing overlay, so it must be
	// wrapped for the deferral to see it (capturedTui can be unset when cockpit
	// was disabled at session start).
	assert.match(source, /enterCapturingOverlay\(\);\r?\n\t\t\ttry \{\r?\n\t\t\t\tawait showMaestroSettingsShell\(ctx, settingsRegistry, settingsLocale\);\r?\n\t\t\t\} finally \{\r?\n\t\t\t\tsettingsCommandCtx = undefined;\r?\n\t\t\t\texitCapturingOverlay\(\)/);
});

test("Cockpit sidebar controls persist only committed resize widths", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.match(source, /onResizeCommit: \(width\) => \{[\s\S]*?sidebar: \{ \.\.\.config\.sidebar, width \}[\s\S]*?saveConfig\(config\)/);
	assert.match(source, /tuiT\("notice\.sidebarWidthSaveFailed"/);
	assert.match(source, /registerShortcut\(SIDEBAR_RESIZE_KEY/);
	assert.match(source, /"sidebar auto"[\s\S]*?"sidebar on"[\s\S]*?"sidebar off"[\s\S]*?"sidebar resize"/);
	assert.doesNotMatch(source, /onEffectiveWidthChange:[\s\S]*?saveConfig/);
});

test("Cockpit keeps a toggleable session summary and uses the Agent overlay for full preview", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.match(source, /SESSION_DETAIL_TOGGLE_KEY = "alt\+e"/);
	assert.match(source, /registerShortcut\(SESSION_DETAIL_TOGGLE_KEY/);
	assert.match(source, /setWidget\([\s\S]*?SESSION_DETAIL_WIDGET_KEY[\s\S]*?placement: "aboveEditor"[\s\S]*?syncSidebarMode\(ctx\)/);
	assert.match(source, /reconcileSurface[\s\S]*?installWidgets\(ctx\)[\s\S]*?setWidget\(SESSION_BAR_WIDGET_KEY, undefined\)[\s\S]*?installSessionBar\(ctx\)/);
	assert.doesNotMatch(source, /sessionDetailScrollDisposer/);
	assert.match(source, /previewAgent = endpoint\.kind === "agent"[\s\S]*?if \(previewAgent\) await openAgentOverlay\(ctx\)/);
});

test("Cockpit Agent modal opens from the Alt+R session list and shares the live repaint pipeline", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /AGENT_OVERLAY_KEY|registerShortcut\("alt\+a"/);
	assert.match(source, /const selectedId = sessionUi\.selectedId\(mode\)/);
	assert.match(source, /selectedIndex > 0[\s\S]*?allEntries\[selectedIndex\]![\s\S]*?endpoint\.id === selectedId \? tuiStatus\("selected"\)/);
	assert.match(source, /sessionUi\.mode === "agent" \? "session\.agentListHint" : "session\.listHint"/);
	assert.match(source, /showOwner = mode === "window" \|\| endpoint\.kind === "root"/);
	assert.match(source, /if \(mode === "window"\) selectWindow\(endpoint\.id\)[\s\S]*?selectEndpoint\(endpoint\.id\)/);
	assert.match(source, /previewAgent = endpoint\.kind === "agent"[\s\S]*?openAgentOverlay\(ctx\)/);
	assert.match(source, /new AgentOverlay\(\{[\s\S]*?getAgents: \(\) => agents\.snapshot\(\)/);
	assert.match(source, /ownedRender = \(\) => tui\.requestRender\(\)/);
	assert.match(source, /activeAgentOverlayRender = ownedRender/);
	assert.match(source, /requestCapturedRender\(\);[\s\S]*?activeAgentOverlayRender\?\.\(\)/);
	assert.match(source, /getExpanded: effectiveTodoExpanded/);
	assert.match(source, /todoExpanded: effectiveTodoExpanded\(\)/);
	assert.match(source, /const effectiveTodoExpanded = \(\): boolean =>\s*config\.todoExpanded/);
	assert.match(source, /uninstallUi[\s\S]*?activeAgentOverlay\?\.finalize\(\)/);
	// Scroll/follow state now belongs to SessionUiState per endpoint, not a
	// separate agentListScroll variable. Both session boundaries reset it.
	const start = sourceSection(source, 'pi.on("session_start"', 'pi.on("session_shutdown"');
	const shutdown = sourceSection(source, 'pi.on("session_shutdown"', 'pi.on("before_agent_start"');
	assert.match(start, /sessionUi\.reset\(\)/);
	assert.match(shutdown, /sessionUi\.reset\(\);\s*agentReads\.clear\(\);/);
	const uiState = new SessionUiState();
	uiState.setMode("window");
	uiState.select("previous-agent", "agent");
	uiState.select("previous-window", "window");
	uiState.setScroll("previous-agent", 17, false);
	uiState.setDraft("previous-agent", "previous draft");
	uiState.reset();
	assert.equal(uiState.mode, "agent");
	assert.equal(uiState.selectedId("agent"), undefined);
	assert.equal(uiState.selectedId("window"), undefined);
	assert.deepEqual(uiState.endpoint("previous-agent"), {
		draft: "", unread: 0, lastSeenRevision: undefined, scroll: 0, followTail: true, detail: true,
	});
});

test("Cockpit projects Pi UI prompts as waiting without ending the running lifecycle", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	const handlersStart = source.indexOf('pi.on("ui_prompt_start"');
	const handlersEnd = source.indexOf("// --- live elapsed for folded thinking rows ---", handlersStart);
	assert.ok(handlersStart >= 0 && handlersEnd > handlersStart);
	const promptHandlers = source.slice(handlersStart, handlersEnd);
	assert.match(promptHandlers, /uiPromptDepth = nextUiPromptDepth\(uiPromptDepth, "start"\)/);
	assert.match(promptHandlers, /nextUiPromptDepth\(uiPromptDepth, "end"\)/);
	assert.doesNotMatch(promptHandlers, /running\s*=/);
	assert.match(source, /session_start[\s\S]*?uiPromptDepth = 0;[\s\S]*?ambientSurfaces\.reset\(\)/);
	assert.match(source, /session_shutdown[\s\S]*?runningStartedAt = undefined;[\s\S]*?uiPromptDepth = 0/);
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
	const footerSource = sourceSection(cockpitSource, "ctx.ui.setFooter((tui, theme, footerData)", "// Install first in aboveEditor order");
	assert.match(footerSource, /const bashBgStatus = renderBashBgSummary\(\s*bashBg\.snapshot\(\)/);
	assert.match(footerSource, /Math\.max\(1, width - 1\)/);
	assert.match(footerSource, /hideLiveDuration: config\.staticMode/);
	assert.match(footerSource, /const footerKey = \[[\s\S]*?bashBgStatus \?\? ""/);
	assert.match(footerSource, /renderFooter\(\{[\s\S]*?bashBgStatus,/);
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
	assert.match(source, /activeTools\.set\(e\.toolCallId, \{ name: e\.toolName, startedAt: Date\.now\(\) \}\)/);
	assert.match(source, /activeTools\.delete\(e\.toolCallId\)/);
	assert.match(source, /activeTool: activeTool\?\.name/);
	assert.match(source, /workingStartedAt: activeTool\?\.startedAt \?\? runningStartedAt/);
	assert.match(source, /hideLiveDuration: config\.staticMode/);
	assert.match(source, /setWorkingIndicator\(\{ frames: \[\] \}\)/);
	assert.match(source, /setWorkingIndicator\(\)/);
});

test("Teammate's literal cockpit event constants match the public contract (CS-6)", async () => {
	const teammateEvents = await import(
		"../../pi-maestro-teammate/src/shared/cockpit-events.ts"
	);
	const cockpitEvents = await import("../src/public/v1/events.ts");
	assert.equal(teammateEvents.COCKPIT_UI_OWNERSHIP_EVENT, "cockpit:ui-ownership");
	assert.equal(teammateEvents.COCKPIT_UI_OWNERSHIP_QUERY_EVENT, cockpitEvents.COCKPIT_UI_OWNERSHIP_QUERY_EVENT);
	assert.equal(teammateEvents.COCKPIT_SESSION_LIST_EVENT, cockpitEvents.COCKPIT_SESSION_LIST_EVENT);
	assert.equal(teammateEvents.COCKPIT_PREEMPT_RESIZE_EVENT, cockpitEvents.COCKPIT_PREEMPT_RESIZE_EVENT);
	assert.equal(
		teammateEvents.COCKPIT_UI_OWNERSHIP_EVENT,
		"cockpit:ui-ownership",
	);
});
