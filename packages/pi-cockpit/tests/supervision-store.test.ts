import { test } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_SUPERVISION_EVENTS,
	SupervisionStore,
	normalizeSupervisionEvent,
} from "../src/supervision-store.ts";

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		source: "advisor",
		kind: "intervention",
		severity: "concern",
		target: "main-session",
		message: "check the queue",
		timestamp: 1_700_000_000_000,
		...overrides,
	};
}

test("normalizeSupervisionEvent accepts a well-formed event", () => {
	const normalized = normalizeSupervisionEvent(event());
	assert.ok(normalized);
	assert.equal(normalized.source, "advisor");
	assert.equal(normalized.kind, "intervention");
	assert.equal(normalized.message, "check the queue");
});

test("normalizeSupervisionEvent rejects malformed payloads", () => {
	assert.equal(normalizeSupervisionEvent(null), undefined);
	assert.equal(normalizeSupervisionEvent("x"), undefined);
	assert.equal(normalizeSupervisionEvent(event({ source: "unknown" })), undefined);
	assert.equal(normalizeSupervisionEvent(event({ kind: "bogus" })), undefined);
	assert.equal(normalizeSupervisionEvent(event({ severity: "loud" })), undefined);
});

test("applyEvent accumulates totals and reports visible changes", () => {
	const store = new SupervisionStore();
	assert.equal(store.applyEvent(event()), true);
	assert.equal(store.applyEvent(event({ source: "monitor", kind: "notification", severity: "info" })), true);
	assert.equal(store.applyEvent("garbage"), false);
	const totals = store.getTotals();
	assert.equal(totals.interventions, 1);
	assert.equal(totals.notifications, 1);
	assert.equal(totals.verdicts, 0);
});

test("footerStatus is undefined until events exist, then compact", () => {
	const store = new SupervisionStore();
	assert.equal(store.footerStatus(), undefined);
	store.applyEvent(event({ source: "goal", kind: "verdict", severity: "info" }));
	assert.equal(store.footerStatus(), "V1");
	store.applyEvent(event({ source: "monitor", kind: "intervention", severity: "concern" }));
	assert.equal(store.footerStatus(), "I1 V1 △");
	store.applyEvent(event({ source: "monitor", kind: "intervention", severity: "blocker" }));
	assert.equal(store.footerStatus(), "I2 V1 ▲");
});

test("recentEvents returns the latest bounded ring", () => {
	const store = new SupervisionStore();
	for (let i = 0; i < MAX_SUPERVISION_EVENTS + 10; i++) {
		store.applyEvent(event({ timestamp: 1_700_000_000_000 + i, message: `m${i}` }));
	}
	const recent = store.recentEvents(3);
	assert.equal(recent.length, 3);
	assert.equal(recent[2].message, `m${MAX_SUPERVISION_EVENTS + 9}`);
	assert.equal(store.recentEvents(MAX_SUPERVISION_EVENTS).length, MAX_SUPERVISION_EVENTS);
});
