import { test } from "node:test";
import assert from "node:assert/strict";
import {
	AGENT_CHROME_SHARE,
	AGENT_DETAIL_CHROME_SHARE,
	CHROME_SHARE,
	DEFAULT_OVERLAY_ROWS,
	MAX_AGENT_PANEL_ROWS,
	MAX_AGENT_DETAIL_ROWS,
	MAX_OVERLAY_ROWS,
	MAX_PANEL_ROWS,
	MIN_AGENT_PANEL_ROWS,
	MIN_AGENT_DETAIL_ROWS,
	MIN_OVERLAY_ROWS,
	MIN_PANEL_ROWS,
	agentPanelRows,
	agentDetailRows,
	fitRows,
	overlayListRows,
	panelRows,
} from "../src/viewport.ts";
import { renderAgents, renderTodos } from "../src/render.ts";
import { resolveGlyphs } from "../src/icons.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentRow, TodoItem } from "../src/types.ts";
import type { WidthUtils } from "../src/layout.ts";

const theme: Pick<Theme, "fg"> = { fg: (_c, t) => t };
const utils: WidthUtils = {
	measure: (s) => s.length,
	clip: (s, w, e) => (s.length <= w ? s : s.slice(0, Math.max(0, w - e.length)) + e),
};
const glyphs = resolveGlyphs("nerd");

test("panelRows scales with the terminal and stays inside its bounds", () => {
	assert.equal(panelRows(100), MAX_PANEL_ROWS);
	assert.equal(panelRows(5), MIN_PANEL_ROWS);
	assert.equal(panelRows(30), Math.floor(30 * CHROME_SHARE));
});

test("panelRows is undefined when the height is unknown or nonsensical", () => {
	assert.equal(panelRows(undefined), undefined);
	assert.equal(panelRows(0), undefined);
	assert.equal(panelRows(-4), undefined);
	assert.equal(panelRows(Number.NaN), undefined);
});

test("agentPanelRows uses the larger Agent-specific share", () => {
	assert.equal(agentPanelRows(100), MAX_AGENT_PANEL_ROWS);
	assert.equal(agentPanelRows(5), MIN_AGENT_PANEL_ROWS);
	assert.equal(agentPanelRows(40), Math.floor(40 * AGENT_CHROME_SHARE));
	assert.equal(agentPanelRows(undefined), undefined);
});

test("agentDetailRows keeps concurrent Agent surfaces inside a smaller share", () => {
	assert.equal(agentDetailRows(100), MAX_AGENT_DETAIL_ROWS);
	assert.equal(agentDetailRows(5), MIN_AGENT_DETAIL_ROWS);
	assert.equal(agentDetailRows(40), Math.floor(40 * AGENT_DETAIL_CHROME_SHARE));
	assert.equal(agentDetailRows(undefined), undefined);
});

test("fitRows pays for the overflow marker out of the budget", () => {
	assert.deepEqual(fitRows(3, 5), { visible: 3, hidden: 0 });
	assert.deepEqual(fitRows(5, 5), { visible: 5, hidden: 0 });
	assert.deepEqual(fitRows(10, 5), { visible: 4, hidden: 6 });
	assert.deepEqual(fitRows(10, 1), { visible: 0, hidden: 10 });
	assert.deepEqual(fitRows(10, 0), { visible: 0, hidden: 10 });
});

function agentRow(i: number): AgentRow {
	return {
		agent: `a${i}`,
		correlationId: `c${i}`,
		name: `a${i}`,
		role: "executor",
		task: `task ${i}`,
		status: "running",
		startedAt: 0,
		toolCount: 0,
	} as AgentRow;
}

function todoItem(i: number): TodoItem {
	return { id: `t${i}`, subject: `task ${i}`, status: "pending", blockedBy: [], skills: [] } as unknown as TodoItem;
}

test("a short terminal shrinks the agent roster instead of overrunning the screen", () => {
	const rows = Array.from({ length: 20 }, (_, i) => agentRow(i));
	const opts = { glyphs, spin: "*", now: 0, withHead: false };
	const tall = renderAgents(rows, "list", 100, theme, utils, opts);
	const short = renderAgents(rows, "list", 100, theme, utils, { ...opts, maxRows: 3 });
	assert.equal(tall.length, 9, "unbounded height keeps the expanded 8 rows + overflow");
	assert.equal(short.length, 3, "a 3-row budget is a hard ceiling");
	assert.match(short.at(-1)!, /18 more/);
});

test("a short terminal shrinks the todo panel, summary line included in the budget", () => {
	const items = Array.from({ length: 20 }, (_, i) => todoItem(i));
	const opts = { glyphs, spin: "*", now: 0, expanded: true };
	const tall = renderTodos(items, "list", 100, theme, utils, opts);
	const short = renderTodos(items, "list", 100, theme, utils, { ...opts, maxRows: 4 });
	assert.equal(tall.length, 10, "unbounded height keeps summary + 8 rows + overflow");
	assert.equal(short.length, 4, "summary + 2 tasks + overflow marker");
	assert.match(short.at(-1)!, /18 more/);
});

test("a generous budget never inflates a panel beyond what it has to say", () => {
	const rows = [agentRow(0), agentRow(1)];
	const lines = renderAgents(rows, "list", 100, theme, utils, {
		glyphs, spin: "*", now: 0, withHead: false, maxRows: MAX_PANEL_ROWS,
	});
	assert.equal(lines.length, 2);
});

test("overlayListRows falls back to the historical page when height is unknown", () => {
	assert.equal(overlayListRows(undefined, 5), DEFAULT_OVERLAY_ROWS);
	assert.equal(overlayListRows(0, 5), DEFAULT_OVERLAY_ROWS);
});

test("overlayListRows spends the height the card already reserves", () => {
	// 24-row terminal: 90% is 21 rows, minus 5 rows of card chrome.
	assert.equal(overlayListRows(24, 5), 16);
	assert.equal(overlayListRows(50, 5), MAX_OVERLAY_ROWS);
	// A tiny terminal still offers a usable page rather than collapsing to nothing.
	assert.equal(overlayListRows(6, 5), MIN_OVERLAY_ROWS);
});
