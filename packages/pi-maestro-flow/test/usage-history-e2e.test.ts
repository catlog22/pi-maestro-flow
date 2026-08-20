import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	recordUsage,
	readHistory,
	aggregateByModel,
	usageTotals,
} from "../src/providers/usage-history.ts";

// Isolate the store in a temp dir via PI_CODING_AGENT_DIR so getAgentDir()
// resolves there instead of the real ~/.pi/agent.
const tmpRoot = mkdtempSync(join(tmpdir(), "pi-usage-e2e-"));
process.env.PI_CODING_AGENT_DIR = tmpRoot;

async function flushMicrotasks(): Promise<void> {
	// recordUsage schedules an index update via queueMicrotask; let it drain.
	for (let i = 0; i < 4; i++) {
		await new Promise<void>((r) => setImmediate(r));
	}
}

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.6-sol",
		usage: {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 100,
			totalTokens: 1800,
			cost: { input: 0.005, output: 0.015, cacheRead: 0.0001, cacheWrite: 0.000625, total: 0.020725 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	} as AssistantMessage;
}

test("recordUsage persists a full record that readHistory recovers with model/cost intact", async () => {
	const sessionId = "e2e-session-1";
	const msg = makeAssistantMessage({ model: "gpt-5.6-sol", timestamp: 1000 });
	await recordUsage(msg, sessionId, "/tmp/ws");
	await flushMicrotasks();

	const records = await readHistory({ kind: "session", sessionId });
	assert.equal(records.length, 1);
	const r = records[0];
	assert.equal(r.model, "gpt-5.6-sol");
	assert.equal(r.provider, "openai");
	assert.equal(r.sessionId, sessionId);
	assert.equal(r.usage.input, 1000);
	assert.equal(r.usage.output, 500);
	assert.equal(r.usage.cacheRead, 200);
	assert.equal(r.cost.total, 0.020725);
});

test("records are isolated per session", async () => {
	const sidA = "e2e-isolation-a";
	const sidB = "e2e-isolation-b";
	await recordUsage(makeAssistantMessage({ model: "gpt-5.6-sol", timestamp: 2000 }), sidA, "/tmp/ws");
	await recordUsage(makeAssistantMessage({ model: "claude-sonnet-4-5", timestamp: 3000 }), sidB, "/tmp/ws2");
	await flushMicrotasks();

	const a = await readHistory({ kind: "session", sessionId: sidA });
	const b = await readHistory({ kind: "session", sessionId: sidB });
	assert.equal(a.length, 1);
	assert.equal(b.length, 1);
	assert.equal(a[0].model, "gpt-5.6-sol");
	assert.equal(b[0].model, "claude-sonnet-4-5");
});

	test("aggregateByModel over persisted records carries cost and cache hit rate", async () => {
	await recordUsage(makeAssistantMessage({
		model: "gpt-5.6-sol",
		usage: { input: 800, output: 200, cacheRead: 200, cacheWrite: 0, totalTokens: 1200, cost: { input: 0.004, output: 0.006, cacheRead: 0.0001, cacheWrite: 0, total: 0.0101 } },
		timestamp: 4000,
	}), "e2e-agg", "/tmp/ws");
	await flushMicrotasks();

	const records = await readHistory({ kind: "session", sessionId: "e2e-agg" });
	const agg = aggregateByModel(records);
	assert.equal(agg.length, 1);
	assert.equal(agg[0].totalCost, 0.0101);
	// cacheHitRate = cacheRead / (input + cacheRead) = 200/1000 = 0.2
	assert.equal(agg[0].cacheHitRate, 0.2);
});

test("usageTotals over persisted records sums cost correctly", async () => {
	const sid = "e2e-totals";
	await recordUsage(makeAssistantMessage({
		usage: { input: 1000, output: 500, cacheRead: 500, cacheWrite: 0, totalTokens: 2000, cost: { input: 0.005, output: 0.015, cacheRead: 0.00025, cacheWrite: 0, total: 0.02025 } },
		timestamp: 5000,
	}), sid, "/tmp/ws");
	await flushMicrotasks();

	const records = await readHistory({ kind: "session", sessionId: sid });
	const totals = usageTotals(records);
	assert.equal(totals.records, 1);
	// round4(0.02025) = Math.round(0.02025*10000)/10000 = 0.0203
	assert.equal(totals.totalCost, 0.0203);
	assert.equal(totals.totalTokens, 1500);
});
