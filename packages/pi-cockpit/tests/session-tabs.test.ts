import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	SESSION_TAB_ACTION_FIRST_WIDTH,
	formatUnreadCount,
	nextSessionTabId,
	orderedSessionTabs,
	renderSessionTabLine,
	sessionTabWidthMode,
	type SessionTab,
} from "../src/session-tabs.ts";

const tabs: SessionTab[] = [
	{ id: "agent-b", label: "builder", ordinal: 2, unread: 3 },
	{ id: "main", label: "main", ordinal: 0 },
	{ id: "agent-a", label: "analyst", ordinal: 1 },
];

test("shared tab ordering and navigation use stable ordinal/id order", () => {
	assert.deepEqual(orderedSessionTabs(tabs).map((tab) => tab.id), ["main", "agent-a", "agent-b"]);
	assert.equal(nextSessionTabId(tabs, "main", 1), "agent-a");
	assert.equal(nextSessionTabId(tabs, "main", -1), "agent-b");
	assert.equal(nextSessionTabId(tabs, "missing", 1), "main");
	assert.equal(nextSessionTabId(tabs, "missing", -1), "agent-b");
});

test("action-first mode starts below 40 columns and keeps the selected action", () => {
	assert.equal(SESSION_TAB_ACTION_FIRST_WIDTH, 40);
	assert.equal(sessionTabWidthMode(39), "action-first");
	assert.equal(sessionTabWidthMode(40), "full");
	const line = renderSessionTabLine(tabs, 24, {
		selectedId: "agent-a",
		renderTab: (tab, selected) => `${selected ? ">" : ""}@${tab.label}`,
		renderUnreadSummary: (unread) => `${unread} unread`,
	});
	assert.match(line, /^>@analyst/);
	assert.doesNotMatch(line, /@main/);
});

test("tab line, status and unread stay within every width from 1 through 120", () => {
	const ansi = (text: string) => `\x1b[36m${text}\x1b[0m`;
	for (let width = 1; width <= 120; width++) {
		const line = renderSessionTabLine(tabs, width, {
			selectedId: "agent-b",
			renderTab: (tab, selected) => ansi(`${selected ? ">" : ""}@${tab.label}${tab.unread ? ` •${tab.unread}` : ""}`),
			renderSummary: (selected, unread) => ansi(`● @${selected.label} · ${unread} unread · running · ctx 87%`),
			renderUnreadSummary: (unread) => ansi(`•${unread}`),
		});
		assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)}`);
	}
	assert.equal(formatUnreadCount(0), "0");
	assert.equal(formatUnreadCount(99), "99");
	assert.equal(formatUnreadCount(100), "99+");
});
