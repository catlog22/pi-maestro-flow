import assert from "node:assert/strict";
import test from "node:test";
import {
	aggregateByModel,
	aggregateByTurn,
	usageTotals,
	type UsageRecord,
} from "../src/providers/usage-history.ts";

function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
	return {
		ts: 1000,
		model: "gpt-5.6-sol",
		provider: "openai",
		sessionId: "s1",
		usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 },
		cost: { total: 0.01, input: 0.005, output: 0.004, cacheRead: 0.0005, cacheWrite: 0.0005 },
		...overrides,
	};
}

test("aggregateByModel groups records by model and sums tokens/cost", () => {
	const records: UsageRecord[] = [
		makeRecord({ model: "a", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }, cost: { total: 0.1, input: 0.05, output: 0.05, cacheRead: 0, cacheWrite: 0 } }),
		makeRecord({ model: "a", usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0 }, cost: { total: 0.2, input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } }),
		makeRecord({ model: "b", usage: { input: 50, output: 25, cacheRead: 0, cacheWrite: 0 }, cost: { total: 0.05, input: 0.025, output: 0.025, cacheRead: 0, cacheWrite: 0 } }),
	];
	const agg = aggregateByModel(records);
	assert.equal(agg.length, 2);
	const a = agg.find((m) => m.model === "a")!;
	assert.equal(a.records, 2);
	assert.equal(a.input, 300);
	assert.equal(a.output, 150);
	assert.equal(a.totalTokens, 450);
	assert.equal(a.totalCost, 0.3);
	const b = agg.find((m) => m.model === "b")!;
	assert.equal(b.records, 1);
	assert.equal(b.totalTokens, 75);
	// Sorted by totalCost desc: a (0.3) before b (0.05)
	assert.equal(agg[0].model, "a");
	assert.equal(agg[1].model, "b");
});

test("aggregateByModel computes cache hit rate = cacheRead / (input + cacheRead)", () => {
	const records: UsageRecord[] = [
		makeRecord({ model: "a", usage: { input: 800, output: 0, cacheRead: 200, cacheWrite: 0 }, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
	];
	const agg = aggregateByModel(records);
	assert.equal(agg[0].cacheHitRate, 0.2);
});

test("aggregateByModel handles empty input", () => {
	assert.deepEqual(aggregateByModel([]), []);
});

test("aggregateByTurn produces one point per record in input order", () => {
	const records: UsageRecord[] = [
		makeRecord({ ts: 3, usage: { input: 300, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: { total: 0.03, input: 0.03, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		makeRecord({ ts: 1, usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: { total: 0.01, input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		makeRecord({ ts: 2, usage: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: { total: 0.02, input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0 } }),
	];
	// aggregateByTurn preserves caller order; readHistory sorts by ts upstream.
	assert.deepEqual(aggregateByTurn(records, "tokens"), [300, 100, 200]);
	assert.deepEqual(aggregateByTurn(records, "cost"), [0.03, 0.01, 0.02]);
});

test("aggregateByTurn cache metric yields hit rate per record", () => {
	const records: UsageRecord[] = [
		makeRecord({ usage: { input: 800, output: 0, cacheRead: 200, cacheWrite: 0 }, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		makeRecord({ usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
	];
	const rates = aggregateByTurn(records, "cache");
	assert.deepEqual(rates, [0.2, 0]);
});

test("usageTotals sums across all records and computes overall cache hit rate", () => {
	const records: UsageRecord[] = [
		makeRecord({ usage: { input: 1000, output: 500, cacheRead: 500, cacheWrite: 0 }, cost: { total: 0.05, input: 0.025, output: 0.025, cacheRead: 0, cacheWrite: 0 } }),
		makeRecord({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 100 }, cost: { total: 0.01, input: 0, output: 0, cacheRead: 0, cacheWrite: 0.01 } }),
	];
	const totals = usageTotals(records);
	assert.equal(totals.records, 2);
	assert.equal(totals.input, 1000);
	assert.equal(totals.output, 500);
	assert.equal(totals.cacheRead, 500);
	assert.equal(totals.cacheWrite, 100);
	assert.equal(totals.totalTokens, 1500);
	assert.equal(totals.totalCost, 0.06);
	// cacheHitRate = cacheRead / (input + cacheRead) = 500/1500
	assert.equal(totals.cacheHitRate, 1 / 3);
});

test("usageTotals handles empty input", () => {
	const totals = usageTotals([]);
	assert.equal(totals.records, 0);
	assert.equal(totals.totalTokens, 0);
	assert.equal(totals.totalCost, 0);
	assert.equal(totals.cacheHitRate, 0);
});
