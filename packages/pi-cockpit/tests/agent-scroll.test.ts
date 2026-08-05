import { test } from "node:test";
import assert from "node:assert/strict";
import {
	agentListWindowRows,
	followWindow,
	scrollBy,
	scrollWindowStart,
} from "../src/agent-scroll.ts";

test("followWindow: pins the window to the newest rows", () => {
	assert.deepEqual(followWindow(10, 4), { offset: 6, following: true });
	assert.deepEqual(followWindow(3, 4), { offset: 0, following: true });
});

test("scrollWindowStart: follow pins to the tail, manual clamps", () => {
	assert.equal(scrollWindowStart(10, 4, { offset: 0, following: true }), 6);
	assert.equal(scrollWindowStart(10, 4, { offset: 2, following: false }), 2);
	assert.equal(scrollWindowStart(10, 4, { offset: 99, following: false }), 6);
	assert.equal(scrollWindowStart(3, 4, { offset: 2, following: false }), 0);
});

test("scrollBy: scrolling up pauses follow; reaching the bottom resumes it", () => {
	const total = 10;
	const budget = 4;
	const followed = scrollBy({ offset: 6, following: true }, -1, total, budget);
	assert.deepEqual(followed, { offset: 5, following: false });
	const scrolled = scrollBy({ offset: 5, following: false }, -2, total, budget);
	assert.deepEqual(scrolled, { offset: 3, following: false });
	const backToBottom = scrollBy({ offset: 3, following: false }, 4, total, budget);
	assert.deepEqual(backToBottom, { offset: 6, following: true });
});

test("scrollBy: clamps at both ends and no-ops when everything fits", () => {
	assert.deepEqual(scrollBy({ offset: 6, following: true }, 5, 10, 4), { offset: 6, following: true });
	assert.deepEqual(scrollBy({ offset: 0, following: false }, -3, 10, 4), { offset: 0, following: false });
	assert.deepEqual(scrollBy({ offset: 0, following: true }, -1, 3, 4), { offset: 0, following: true });
});

test("agentListWindowRows: expanded width cap and Agent panel bound", () => {
	// Tall terminal with plenty of height → the expanded 8-row width cap.
	assert.equal(agentListWindowRows(120, 50), 8);
	// Narrow terminal → 4-row cap.
	assert.equal(agentListWindowRows(30, 50), 4);
	// Medium terminals can spend the larger Agent-specific panel share.
	assert.equal(agentListWindowRows(120, 40), 8);
	assert.ok(agentListWindowRows(120, 12) >= 1);
	// Unknown terminal height falls back to the width cap.
	assert.equal(agentListWindowRows(undefined, undefined), 8);
});
