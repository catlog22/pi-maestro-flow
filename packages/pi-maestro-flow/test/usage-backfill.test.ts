import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Isolate getAgentDir() via PI_CODING_AGENT_DIR so backfill writes to a temp dir.
const tmpRoot = mkdtempSync(join(tmpdir(), "pi-backfill-"));
process.env.PI_CODING_AGENT_DIR = tmpRoot;

// Import after env is set so getAgentDir() resolves to tmpRoot.
const { backfillFromSessions, readHistory, usageHistoryDir } = await import("../src/providers/usage-history.ts");

const sessionsDir = join(tmpRoot, "sessions");
mkdirSync(sessionsDir, { recursive: true });

/** Write a fake Pi session file in <sessionsDir>/<cwdSlug>/<name>.jsonl. */
function writeSessionFile(cwdSlug: string, name: string, lines: string[]): void {
	const subDir = join(sessionsDir, cwdSlug);
	mkdirSync(subDir, { recursive: true });
	writeFileSync(join(subDir, name), lines.join("\n") + "\n", "utf8");
}

const CWD_A = "C:\\Users\\dev\\project-a";
const slugA = "--C--Users-dyw--"; // Pi slugs cwd by replacing separators with -

test("backfill extracts assistant usage records from session files and isolates by cwd", async () => {
	// A session with one assistant message carrying usage/cost.
	writeSessionFile(slugA, "2026-07-07T01-00-00-000Z_s1.jsonl", [
		JSON.stringify({ type: "session", id: "s1", timestamp: "2026-07-07T01:00:00.000Z", cwd: CWD_A }),
		JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: "2026-07-07T01:00:01.000Z", provider: "openai", modelId: "gpt-5.6-sol" }),
		JSON.stringify({
			type: "message", id: "a1", parentId: "m1", timestamp: "2026-07-07T01:00:05.000Z",
			message: {
				role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-5.6-sol",
				timestamp: "2026-07-07T01:00:05.000Z",
				usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: { input: 0.005, output: 0.015, cacheRead: 0, cacheWrite: 0, total: 0.02 } },
				stopReason: "stop",
			},
		}),
	]);

	const result = await backfillFromSessions();
	assert.equal(result.newFiles, 1);
	assert.ok(result.newRecords >= 1, `expected >=1 new records, got ${result.newRecords}`);

	const records = await readHistory({ kind: "workspace", cwd: CWD_A });
	assert.equal(records.length, 1);
	assert.equal(records[0].model, "gpt-5.6-sol");
	assert.equal(records[0].provider, "openai");
	assert.equal(records[0].sessionId, "s1");
	assert.equal(records[0].cwd, CWD_A);
	assert.equal(records[0].usage.input, 1000);
	assert.equal(records[0].cost.total, 0.02);
});

test("backfill is incremental: second run is a no-op via cache", async () => {
	const result2 = await backfillFromSessions();
	assert.equal(result2.newFiles, 0);
	assert.equal(result2.newRecords, 0);
});

test("backfill is idempotent: re-scanning the same file does not duplicate records", async () => {
	// Simulate the cache being stale by removing it; re-run should not double-count
	// because readExistingTimestamps dedupes by ts.
	const { writeFileSync, unlinkSync, existsSync } = await import("node:fs");
	const cachePath = join(usageHistoryDir(), "backfill-cache.json");
	if (existsSync(cachePath)) unlinkSync(cachePath);
	const result = await backfillFromSessions();
	// The file was already scanned into the store; dedup by ts keeps it single.
	const records = await readHistory({ kind: "workspace", cwd: CWD_A });
	assert.equal(records.length, 1, "no duplicate records after re-scan");
});

test("backfill cache keys use full paths so equal basenames in different workspace dirs both scan", async () => {
	const name = "2026-07-09T03-00-00-000Z_same.jsonl";
	const assistant = (id: string, cwd: string, timestamp: string) => [
		JSON.stringify({ type: "session", id, timestamp, cwd }),
		JSON.stringify({
			type: "message", timestamp,
			message: {
				role: "assistant", provider: "openai", model: "m", timestamp,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
			},
		}),
	];
	writeSessionFile("same-a", name, assistant("same-a", "/same/a", "2026-07-09T03:00:01.000Z"));
	writeSessionFile("same-b", name, assistant("same-b", "/same/b", "2026-07-09T03:00:02.000Z"));
	const result = await backfillFromSessions();
	assert.equal(result.newFiles, 2);
	assert.equal((await readHistory({ kind: "workspace", cwd: "/same/a" })).length, 1);
	assert.equal((await readHistory({ kind: "workspace", cwd: "/same/b" })).length, 1);
});

test("backfill skips non-assistant messages (user/tool messages have no usage)", async () => {
	const slugB = "--other-cwd--";
	writeSessionFile(slugB, "2026-07-08T02-00-00-000Z_s2.jsonl", [
		JSON.stringify({ type: "session", id: "s2", timestamp: "2026-07-08T02:00:00.000Z", cwd: "C:\\other" }),
		JSON.stringify({
			type: "message", id: "u1", parentId: null, timestamp: "2026-07-08T02:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1783400001000 },
		}),
	]);
	const result = await backfillFromSessions();
	const records = await readHistory({ kind: "workspace", cwd: "C:\\other" });
	assert.equal(records.length, 0, "user messages produce no usage records");
});
