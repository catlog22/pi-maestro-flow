import assert from "node:assert/strict";
import test from "node:test";
import { altKey, checkCatalogCompleteness, SETTINGS_LOCALE_EVENT } from "pi-maestro-settings-core/v1";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderSessionDetail } from "../src/session-detail.ts";
import { SessionUiState } from "../src/session-ui-state.ts";
import { renderWindowBar } from "../src/window-bar.ts";
import type { AgentRow } from "../src/types.ts";
import {
	COCKPIT_TUI_CATALOGS,
	CockpitTuiLocale,
	bindCockpitTuiLocale,
	cockpitTuiLocale,
} from "../src/tui-i18n.ts";

/** `altKey` escaped for use inside a regular expression: `+` is a metacharacter. */
const altRe = (key: string): string => altKey(key).replaceAll("+", "\\+");

class Events {
	readonly handlers = new Map<string, Set<(payload: unknown) => void>>();

	on(event: string, handler: (payload: unknown) => void): () => void {
		const handlers = this.handlers.get(event) ?? new Set();
		handlers.add(handler);
		this.handlers.set(event, handlers);
		return () => handlers.delete(handler);
	}

	emit(event: string, payload: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(payload);
	}
}

test("Cockpit TUI catalogs stay complete across English and Simplified Chinese", () => {
	assert.deepEqual(checkCatalogCompleteness(COCKPIT_TUI_CATALOGS), {
		complete: true,
		referenceLocale: "en",
		issues: [],
	});
});

test("runtime TUI locale initializes from injected system language without process env mutation", () => {
	assert.equal(new CockpitTuiLocale({ environment: { LANG: "zh_CN.UTF-8" }, resolvedLocale: "en-US" }).locale, "zh-CN");
	assert.equal(new CockpitTuiLocale({ environment: { LANG: "en_GB.UTF-8" }, resolvedLocale: "zh-CN" }).locale, "en");
	assert.equal(new CockpitTuiLocale({ environment: {}, resolvedLocale: "zh-Hans-CN" }).locale, "zh-CN");
});

test("representative session surfaces rerender bilingually after a live locale event", (t) => {
	const originalLocale = cockpitTuiLocale.locale;
	const events = new Events();
	const unbind = bindCockpitTuiLocale(events);
	t.after(() => {
		unbind();
		cockpitTuiLocale.setLocale(originalLocale);
	});
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
	const state = new SessionUiState();
	const agent: AgentRow = {
		correlationId: "agent-1",
		agent: "general",
		name: "builder",
		role: "general",
		task: "keep identifiers stable",
		status: "sleeping",
		tail: "unchanged output",
		startedAt: Date.now() - 1_000,
		lastActivityAt: Date.now(),
	};

	cockpitTuiLocale.setLocale("en");
	assert.match(renderWindowBar([], state, 80, theme)[0] ?? "", /Windows · no peer sessions/);
	let detail = renderSessionDetail([agent], agent.correlationId, 100, theme).join("\n");
	assert.match(detail, /@builder/);
	assert.match(detail, /sleeping/);
	assert.match(detail, new RegExp(`${altRe("R")} preview`));

	events.emit(SETTINGS_LOCALE_EVENT, { version: 1, locale: "zh-CN", generation: "live-toggle" });
	assert.match(renderWindowBar([], state, 80, theme)[0] ?? "", /窗口 · 没有对等会话/);
	detail = renderSessionDetail([agent], agent.correlationId, 100, theme).join("\n");
	assert.match(detail, /@builder/, "agent identifiers are not translated");
	assert.match(detail, /休眠中/);
	assert.match(detail, new RegExp(`${altRe("R")} 预览`));
	for (let width = 1; width <= 120; width++) {
		const lines = [
			...renderWindowBar([], state, width, theme),
			...renderSessionDetail([agent], agent.correlationId, width, theme),
		];
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `zh-CN width ${width}: ${visibleWidth(line)}`);
		}
	}
});

test("SETTINGS_LOCALE_EVENT synchronizes the live runtime and notifies render subscribers", () => {
	const events = new Events();
	const runtime = new CockpitTuiLocale({ locale: "en" });
	const observed: string[] = [];
	const unsubscribeLocale = runtime.subscribe((locale) => observed.push(locale));
	const unbind = bindCockpitTuiLocale(events, runtime);

	events.emit(SETTINGS_LOCALE_EVENT, { version: 1, locale: "zh-CN", generation: "generation-1" });
	assert.equal(runtime.locale, "zh-CN");
	assert.equal(runtime.t("window.messages"), "消息");
	assert.deepEqual(observed, ["zh-CN"]);

	events.emit(SETTINGS_LOCALE_EVENT, { version: 2, locale: "en", generation: "bad-version" });
	events.emit(SETTINGS_LOCALE_EVENT, { version: 1, locale: "fr", generation: "generation-2" });
	events.emit(SETTINGS_LOCALE_EVENT, { version: 1, locale: "en", generation: "" });
	events.emit(SETTINGS_LOCALE_EVENT, { version: 1, locale: "en", generation: "   " });
	events.emit(SETTINGS_LOCALE_EVENT, []);
	assert.equal(runtime.locale, "zh-CN", "invalid events are ignored");
	assert.deepEqual(observed, ["zh-CN"], "invalid events do not notify render subscribers");
	unbind();
	unsubscribeLocale();
	events.emit(SETTINGS_LOCALE_EVENT, { version: 1, locale: "en", generation: "generation-3" });
	assert.equal(runtime.locale, "zh-CN", "the event disposer detaches synchronization");
});
