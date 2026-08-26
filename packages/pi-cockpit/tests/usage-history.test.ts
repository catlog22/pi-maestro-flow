// Usage-history reader tests — fixture JSONL files in a temp dir via the
// injected `dir` option (never touches the real ~/.pi/agent/usage-history).

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	aggregateDailyTokens,
	buildTrend,
	readUsageHistory,
	topModelsByTokens,
	type UsageRecord,
} from "../src/usage/history.ts";

let tempDirs: string[] = [];

function tempHistoryDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "cockpit-usage-history-"));
	tempDirs.push(dir);
	return dir;
}

function writeJsonl(dir: string, sessionId: string, records: UsageRecord[]): void {
	mkdirSync(dir, { recursive: true });
	const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
	writeFileSync(join(dir, `${sessionId}.jsonl`), lines, "utf8");
}

afterEach(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

const DAY_MS = 86_400_000;

function record(
	overrides: Partial<UsageRecord> & Pick<UsageRecord, "ts" | "provider" | "model">,
): UsageRecord {
	return {
		sessionId: overrides.sessionId ?? "s1",
		cwd: overrides.cwd ?? "/proj",
		usage: overrides.usage ?? { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
		cost: overrides.cost ?? { total: 0.01 },
		...overrides,
	};
}

describe("readUsageHistory", () => {
	it("reads and sorts records from JSONL files, filtering by provider", async () => {
		const dir = tempHistoryDir();
		writeJsonl(dir, "s1", [
			record({ ts: 2000, provider: "openai-codex", model: "gpt-5" }),
			record({ ts: 1000, provider: "anthropic", model: "claude" }),
			record({ ts: 3000, provider: "openai-codex", model: "gpt-5" }),
		]);

		const codex = await readUsageHistory({ dir, provider: "openai-codex" });
		assert.equal(codex.length, 2);
		assert.deepEqual(codex.map((r) => r.ts), [2000, 3000]); // sorted ascending
		assert.equal(codex.every((r) => r.provider === "openai-codex"), true);
	});

	it("filters by since and cwd", async () => {
		const dir = tempHistoryDir();
		writeJsonl(dir, "s1", [
			record({ ts: 1000, provider: "openai-codex", model: "m", cwd: "/a" }),
			record({ ts: 5000, provider: "openai-codex", model: "m", cwd: "/b" }),
		]);

		const since = await readUsageHistory({ dir, since: 2000 });
		assert.equal(since.length, 1);
		assert.equal(since[0]!.cwd, "/b");

		const byCwd = await readUsageHistory({ dir, cwd: "/a" });
		assert.equal(byCwd.length, 1);
		assert.equal(byCwd[0]!.ts, 1000);
	});

	it("returns empty for a missing directory", async () => {
		const out = await readUsageHistory({ dir: join(tempHistoryDir(), "does-not-exist") });
		assert.deepEqual(out, []);
	});

	it("skips malformed lines without failing the whole read", async () => {
		const dir = tempHistoryDir();
		mkdirSync(dir, { recursive: true });
		// One valid record, one malformed JSON line, one non-record object.
		writeFileSync(join(dir, "s1.jsonl"),
			`${JSON.stringify(record({ ts: 1000, provider: "openai-codex", model: "m" }))}\n` +
			`not-json-at-all\n` +
			`${JSON.stringify({ ts: 2000 })}\n`, "utf8");

		const out = await readUsageHistory({ dir });
		assert.equal(out.length, 1);
		assert.equal(out[0]!.ts, 1000);
	});

	it("ignores non-jsonl files", async () => {
		const dir = tempHistoryDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "index.json"), JSON.stringify({ sessions: [] }), "utf8");
		writeFileSync(join(dir, "s1.jsonl"),
			`${JSON.stringify(record({ ts: 1000, provider: "openai-codex", model: "m" }))}\n`, "utf8");

		const out = await readUsageHistory({ dir });
		assert.equal(out.length, 1);
	});
});

describe("aggregateDailyTokens", () => {
	it("buckets records by UTC day and 0-fills gaps across the window", () => {
		const now = Date.UTC(2026, 0, 10); // 2026-01-10
		const records = [
			record({ ts: Date.UTC(2026, 0, 8), provider: "p", model: "m" }), // day 8
			record({ ts: Date.UTC(2026, 0, 10, 3), provider: "p", model: "m" }), // day 10
		];
		const buckets = aggregateDailyTokens(records, 5, now);
		// Window ends at the most recent record's day (day 10) → 5 days: 6,7,8,9,10.
		assert.equal(buckets.length, 5);
		assert.deepEqual(buckets.map((b) => b.ts), [
			Date.UTC(2026, 0, 6),
			Date.UTC(2026, 0, 7),
			Date.UTC(2026, 0, 8),
			Date.UTC(2026, 0, 9),
			Date.UTC(2026, 0, 10),
		]);
		// Day 8 and day 10 each have one record (1500 tokens); others 0-filled.
		assert.equal(buckets.find((b) => b.ts === Date.UTC(2026, 0, 8))!.tokens, 1500);
		assert.equal(buckets.find((b) => b.ts === Date.UTC(2026, 0, 9))!.tokens, 0);
		assert.equal(buckets.find((b) => b.ts === Date.UTC(2026, 0, 10))!.turns, 1);
		assert.equal(buckets.find((b) => b.ts === Date.UTC(2026, 0, 10))!.tokens, 1500);
	});

	it("uses nowMs to anchor the window when there are no records", () => {
		const now = Date.UTC(2026, 0, 5);
		const buckets = aggregateDailyTokens([], 3, now);
		assert.equal(buckets.length, 3);
		assert.deepEqual(buckets.map((b) => b.tokens), [0, 0, 0]);
		assert.equal(buckets.at(-1)!.ts, Date.UTC(2026, 0, 5));
	});

	it("drops records outside the window", () => {
		const now = Date.UTC(2026, 0, 10);
		const records = [
			record({ ts: Date.UTC(2026, 0, 1), provider: "p", model: "m" }), // outside
			record({ ts: Date.UTC(2026, 0, 10), provider: "p", model: "m" }), // inside
		];
		const buckets = aggregateDailyTokens(records, 3, now);
		const total = buckets.reduce((sum, b) => sum + b.tokens, 0);
		assert.equal(total, 1500); // only the in-window record
	});
});

describe("topModelsByTokens", () => {
	it("ranks models by token volume and computes shares", () => {
		const records = [
			record({ ts: 1, provider: "p", model: "a", usage: { input: 600, output: 0, cacheRead: 0, cacheWrite: 0 } }),
			record({ ts: 2, provider: "p", model: "b", usage: { input: 300, output: 0, cacheRead: 0, cacheWrite: 0 } }),
			record({ ts: 3, provider: "p", model: "c", usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		];
		const top = topModelsByTokens(records, 2);
		assert.deepEqual(top.map((m) => m.model), ["a", "b"]);
		assert.equal(Math.round(top[0]!.share * 100), 60);
		assert.equal(Math.round(top[1]!.share * 100), 30);
	});

	it("returns share 0 when there are no tokens", () => {
		const top = topModelsByTokens([], 2);
		assert.deepEqual(top, []);
	});
});

describe("buildTrend", () => {
	it("returns null when there is no usage in the window", () => {
		const now = Date.UTC(2026, 0, 10);
		assert.equal(buildTrend([], 7, now), null);
		assert.equal(buildTrend([record({ ts: now, provider: "p", model: "m",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: { total: 0 } })], 7, now), null);
	});

	it("builds a trend bundle with daily buckets, totals, and top models", () => {
		const now = Date.UTC(2026, 0, 10, 12);
		const records = [
			record({ ts: Date.UTC(2026, 0, 10, 1), provider: "openai-codex", model: "gpt-5" }),
			record({ ts: Date.UTC(2026, 0, 9, 1), provider: "openai-codex", model: "gpt-4" }),
		];
		const trend = buildTrend(records, 7, now);
		assert.ok(trend);
		assert.equal(trend!.daily.length, 7);
		assert.equal(trend!.totalTurns, 2);
		assert.equal(trend!.totalTokens, 3000); // 1500 per record
		assert.equal(trend!.avgTurnsPerDay > 0, true);
		assert.equal(trend!.topModels.length, 2);
		assert.equal(trend!.topModels[0]!.model, "gpt-5");
	});

	it("windows topModels to the daily bucket span", () => {
		const now = Date.UTC(2026, 0, 10);
		const records = [
			record({ ts: Date.UTC(2026, 0, 1), provider: "openai-codex", model: "old-model",
				usage: { input: 9999, output: 0, cacheRead: 0, cacheWrite: 0 } }),
			record({ ts: Date.UTC(2026, 0, 10), provider: "openai-codex", model: "new-model",
				usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		];
		const trend = buildTrend(records, 3, now);
		assert.ok(trend);
		// old-model (day 1) is outside the 3-day window ending day 10 → not in top models.
		assert.equal(trend!.topModels[0]!.model, "new-model");
		assert.equal(trend!.topModels.length, 1);
	});
});
