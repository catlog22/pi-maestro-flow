/**
 * Token usage history — append-only JSONL store with per-session isolation.
 *
 * Every finalized assistant message is recorded with its model, provider,
 * session id, token counts, and the cost pi-ai already computed
 * (`usage.cost.total`). Records append to `~/.pi/usage-history/<sessionId>.jsonl`;
 * a lightweight `index.json` tracks session metadata for fast listing.
 *
 * All writes are best-effort: a failed append must never break the agent turn.
 * Reads are explicit (called from the stats panel), so the hot path stays
 * cheap — the footer sparkline keeps an in-memory buffer and never reads here.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, appendFile, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageRecord {
	/** Unix timestamp (ms) of the finalized assistant message. */
	ts: number;
	/** Model id as reported by the provider. */
	model: string;
	/** Provider id. */
	provider: string;
	/** Owning session id (partition key). */
	sessionId: string;
	/** Working directory when the message was recorded (workspace filter key). */
	cwd: string;
	/** Raw token counts from the message. */
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	/** Cost in USD (pi-ai computes this from model cost rates). */
	cost: {
		total: number;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

export interface SessionIndexEntry {
	sessionId: string;
	firstTs: number;
	lastTs: number;
	recordCount: number;
	totalCost: number;
	modelCount: number;
}

export interface SessionIndex {
	sessions: SessionIndexEntry[];
}

export type ReadScope =
	| { kind: "session"; sessionId: string }
	| { kind: "workspace"; cwd: string }
	| { kind: "all" };

export interface ReadOptions {
	/** Only records with ts >= since (ms). */
	since?: number;
	/** Maximum number of records to return (most recent first). */
	limit?: number;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function usageHistoryDir(): string {
	return join(getAgentDir(), "usage-history");
}

function sessionFile(sessionId: string): string {
	return join(usageHistoryDir(), `${sanitizeSessionId(sessionId)}.jsonl`);
}

function indexPath(): string {
	return join(usageHistoryDir(), "index.json");
}

function sanitizeSessionId(sessionId: string): string {
	// Keep ids filesystem-safe; collapse path separators and dots that could escape.
	return sessionId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 200) || "unknown";
}

// ---------------------------------------------------------------------------
// Recording (write path)
// ---------------------------------------------------------------------------

let indexWriteScheduled = false;
const pendingIndexUpdates = new Map<string, { entry: SessionIndexEntry; dirty: boolean }>();

/**
 * Record one finalized assistant message. Best-effort: errors are swallowed
 * so the agent turn never breaks. The index update is debounced — only one
 * write per tick no matter how many messages land together.
 */
export async function recordUsage(message: AssistantMessage, sessionId: string, cwd: string): Promise<void> {
	const record = toRecord(message, sessionId, cwd);
	const dir = usageHistoryDir();
	try {
		await mkdir(dir, { recursive: true });
		await appendFile(sessionFile(sessionId), `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		// Disk failure, permission, etc. — usage tracking is best-effort.
		return;
	}
	scheduleIndexUpdate(record);
}

function toRecord(message: AssistantMessage, sessionId: string, cwd: string): UsageRecord {
	const u = message.usage;
	const c = u.cost;
	return {
		ts: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
		model: typeof message.model === "string" ? message.model : "unknown",
		provider: typeof message.provider === "string" ? message.provider : "unknown",
		sessionId,
		cwd: typeof cwd === "string" ? cwd : "",
		usage: {
			input: u.input ?? 0,
			output: u.output ?? 0,
			cacheRead: u.cacheRead ?? 0,
			cacheWrite: u.cacheWrite ?? 0,
		},
		cost: {
			total: c?.total ?? 0,
			input: c?.input ?? 0,
			output: c?.output ?? 0,
			cacheRead: c?.cacheRead ?? 0,
			cacheWrite: c?.cacheWrite ?? 0,
		},
	};
}

function scheduleIndexUpdate(record: UsageRecord): void {
	const key = record.sessionId;
	const existing = pendingIndexUpdates.get(key)?.entry;
	const models = existing ? existing.modelCount : 0;
	const entry: SessionIndexEntry = existing
		? {
			sessionId: key,
			firstTs: Math.min(existing.firstTs, record.ts),
			lastTs: Math.max(existing.lastTs, record.ts),
			recordCount: existing.recordCount + 1,
			totalCost: round4(existing.totalCost + record.cost.total),
			modelCount: models, // updated lazily on flush; precise count not needed in-flight
		}
		: {
			sessionId: key,
			firstTs: record.ts,
			lastTs: record.ts,
			recordCount: 1,
			totalCost: round4(record.cost.total),
			modelCount: 1,
		};
	pendingIndexUpdates.set(key, { entry, dirty: true });
	if (!indexWriteScheduled) {
		indexWriteScheduled = true;
		queueMicrotask(flushIndexUpdates);
	}
}

async function flushIndexUpdates(): Promise<void> {
	const pending = new Map(pendingIndexUpdates);
	pendingIndexUpdates.clear();
	if (pending.size === 0) {
		// COR-RV-007: reset the flag only when we are certain no write is pending.
		indexWriteScheduled = false;
		return;
	}
	try {
		const current = await readIndex();
		for (const [key, { entry }] of pending) {
			const merged = mergeIndexEntry(current.sessions.find((s) => s.sessionId === key), entry, key);
			const idx = current.sessions.findIndex((s) => s.sessionId === key);
			if (idx >= 0) current.sessions[idx] = merged;
			else current.sessions.push(merged);
		}
		await writeFile(indexPath(), `${JSON.stringify(current, null, 2)}\n`, "utf8");
	} catch {
		// Index is best-effort; a stale/missing index degrades gracefully to a scan.
	} finally {
		// COR-RV-007: reset the flag AFTER the async write completes so a
		// concurrent scheduleIndexUpdate cannot start a parallel flush that
		// reads stale index data and clobbers this write. If new updates
		// arrived during the async I/O, re-schedule to flush them.
		indexWriteScheduled = false;
		if (pendingIndexUpdates.size > 0) {
			indexWriteScheduled = true;
			queueMicrotask(flushIndexUpdates);
		}
	}
}

function mergeIndexEntry(prev: SessionIndexEntry | undefined, next: SessionIndexEntry, key: string): SessionIndexEntry {
	if (!prev) return next;
	return {
		sessionId: key,
		firstTs: Math.min(prev.firstTs, next.firstTs),
		lastTs: Math.max(prev.lastTs, next.lastTs),
		recordCount: prev.recordCount + next.recordCount,
		totalCost: round4(prev.totalCost + next.totalCost),
		modelCount: Math.max(prev.modelCount, next.modelCount),
	};
}

async function readIndex(): Promise<SessionIndex> {
	try {
		const raw = await readFile(indexPath(), "utf8");
		const parsed = JSON.parse(raw) as SessionIndex;
		if (!Array.isArray(parsed.sessions)) return { sessions: [] };
		return parsed;
	} catch {
		return { sessions: [] };
	}
}

// ---------------------------------------------------------------------------
// Reading (read path)
// ---------------------------------------------------------------------------

export async function readHistory(scope: ReadScope, opts: ReadOptions = {}): Promise<UsageRecord[]> {
	const filterCwd = scope.kind === "workspace" ? scope.cwd : undefined;
	let files: string[];
	if (scope.kind === "session") {
		files = [sessionFile(scope.sessionId)];
	} else {
		files = await listSessionFiles();
		// PERF-RV-001: Prune files before parsing to reduce O(N×M) JSON.parse.
		// When a time filter (opts.since) is present, use the SessionIndex's
		// lastTs to skip files whose every record predates the cutoff. For
		// files not in the index, fall back to file mtime — if a file was last
		// modified before the cutoff, all its appended records are older too.
		//
		// NOTE: SessionIndexEntry has no `cwd` field, so workspace (cwd)
		// filtering cannot prune files at the index level; the per-record cwd
		// filter still runs after readJsonl. Adding cwd to the index would
		// enable workspace-level pruning in a future enhancement.
		if (opts.since !== undefined) {
			const since = opts.since;
			const index = await readIndex();
			const indexed = new Map<string, SessionIndexEntry>();
			for (const entry of index.sessions) {
				indexed.set(sessionFile(entry.sessionId), entry);
			}
			files = files.filter((f) => {
				const entry = indexed.get(f);
				if (entry) return entry.lastTs >= since;
				try {
					return statSync(f).mtimeMs >= since;
				} catch {
					return true; // If stat fails, be conservative and read.
				}
			});
		}
	}
	const records: UsageRecord[] = [];
	for (const file of files) {
		const lines = await readJsonl(file);
		for (const rec of lines) {
			if (opts.since !== undefined && rec.ts < opts.since) continue;
			if (filterCwd !== undefined && rec.cwd !== filterCwd) continue;
			records.push(rec);
		}
	}
	records.sort((a, b) => a.ts - b.ts);
	if (opts.limit !== undefined && records.length > opts.limit) {
		return records.slice(records.length - opts.limit);
	}
	return records;
}

async function listSessionFiles(): Promise<string[]> {
	const dir = usageHistoryDir();
	if (!existsSync(dir)) return [];
	try {
		const entries = await readdir(dir);
		return entries.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
	} catch {
		return [];
	}
}

async function readJsonl(file: string): Promise<UsageRecord[]> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		return [];
	}
	const out: UsageRecord[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed) as UsageRecord);
		} catch {
			// Skip malformed lines; never fail the whole read.
		}
	}
	return out;
}

export async function readSessionIndex(): Promise<SessionIndex> {
	return readIndex();
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface ModelAggregate {
	model: string;
	records: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	totalCost: number;
	cacheHitRate: number;
}

/** Aggregate records by model. Cache hit rate = cacheRead / (input + cacheRead). */
export function aggregateByModel(records: readonly UsageRecord[]): ModelAggregate[] {
	const map = new Map<string, ModelAggregate>();
	for (const r of records) {
		const acc = map.get(r.model) ?? {
			model: r.model,
			records: 0,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			totalCost: 0,
			cacheHitRate: 0,
		};
		acc.records += 1;
		acc.input += r.usage.input;
		acc.output += r.usage.output;
		acc.cacheRead += r.usage.cacheRead;
		acc.cacheWrite += r.usage.cacheWrite;
		acc.totalTokens += r.usage.input + r.usage.output;
		acc.totalCost = round4(acc.totalCost + r.cost.total);
		map.set(r.model, acc);
	}
	for (const acc of map.values()) {
		const denom = acc.input + acc.cacheRead;
		acc.cacheHitRate = denom > 0 ? acc.cacheRead / denom : 0;
	}
	return [...map.values()].sort((a, b) => b.totalCost - a.totalCost);
}

/** Per-turn series: one point per record, ordered by timestamp. */
export function aggregateByTurn(records: readonly UsageRecord[], metric: "tokens" | "cost" | "cache"): number[] {
	return records.map((r) => {
		switch (metric) {
			case "tokens":
				return r.usage.input + r.usage.output;
			case "cost":
				return r.cost.total;
			case "cache": {
				const denom = r.usage.input + r.usage.cacheRead;
				return denom > 0 ? r.usage.cacheRead / denom : 0;
			}
		}
	});
}

export interface UsageTotals {
	records: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	totalCost: number;
	cacheHitRate: number;
}

export function usageTotals(records: readonly UsageRecord[]): UsageTotals {
	const t: UsageTotals = {
		records: records.length,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		totalCost: 0,
		cacheHitRate: 0,
	};
	for (const r of records) {
		t.input += r.usage.input;
		t.output += r.usage.output;
		t.cacheRead += r.usage.cacheRead;
		t.cacheWrite += r.usage.cacheWrite;
		t.totalTokens += r.usage.input + r.usage.output;
		t.totalCost = round4(t.totalCost + r.cost.total);
	}
	const denom = t.input + t.cacheRead;
	t.cacheHitRate = denom > 0 ? t.cacheRead / denom : 0;
	return t;
}

// ---------------------------------------------------------------------------
// Time-bucket aggregation (heatmap + time-series line chart)
// ---------------------------------------------------------------------------

export type TimeMetric = "tokens" | "cost" | "cache";
export type BucketGranularity = "hour" | "day";

export interface TimeBucket {
	/** Bucket start timestamp (ms, UTC midnight for day; UTC hour for hour). */
	ts: number;
	/** Aggregated metric value for this bucket. */
	value: number;
}

function recordMetricValue(r: UsageRecord, metric: TimeMetric): number {
	switch (metric) {
		case "tokens":
			return r.usage.input + r.usage.output;
		case "cost":
			return r.cost.total;
		case "cache": {
			const denom = r.usage.input + r.usage.cacheRead;
			return denom > 0 ? r.usage.cacheRead / denom : 0;
		}
	}
}

function utcMidnight(ts: number): number {
	const d = new Date(ts);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function utcHour(ts: number): number {
	const d = new Date(ts);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
}

/**
 * Aggregate records into time buckets. `day` → one bucket per UTC day;
 * `hour` → one bucket per UTC hour. Buckets with no records are omitted; the
 * caller fills gaps when rendering a continuous axis.
 */
export function aggregateByTimeBucket(
	records: readonly UsageRecord[],
	metric: TimeMetric,
	granularity: BucketGranularity,
): TimeBucket[] {
	const bucketFn = granularity === "hour" ? utcHour : utcMidnight;
	const map = new Map<number, number>();
	for (const r of records) {
		const key = bucketFn(r.ts);
		map.set(key, round4((map.get(key) ?? 0) + recordMetricValue(r, metric)));
	}
	return [...map.entries()]
		.map(([ts, value]) => ({ ts, value }))
		.sort((a, b) => a.ts - b.ts);
}

/**
 * Build a complete day-bucket series spanning [startDay, endDay] inclusive,
 * filling missing days with 0. Used for the monthly heatmap and the
 * "30 days" line-chart range. Both bounds are UTC midnight timestamps.
 */
export function daySeries(
	records: readonly UsageRecord[],
	metric: TimeMetric,
	startDay: number,
	endDay: number,
): TimeBucket[] {
	const buckets = aggregateByTimeBucket(records, metric, "day");
	const map = new Map(buckets.map((b) => [b.ts, b.value]));
	const out: TimeBucket[] = [];
	for (let ts = startDay; ts <= endDay; ts += 86_400_000) {
		out.push({ ts, value: map.get(ts) ?? 0 });
	}
	return out;
}

function round4(n: number): number {
	return Math.round(n * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Backfill from Pi session files (incremental, per-workspace isolated)
// ---------------------------------------------------------------------------

/**
 * Pi persists every session as `<sessionsDir>/<cwdSlug>/<timestamp>_<id>.jsonl`.
 * Each line is an entry; `type:"session"` carries the `cwd`, and `type:"message"`
 * entries with `message.role === "assistant"` carry the full usage/cost we need.
 * This backfill scans those files once, extracts assistant usage records, and
 * merges them into the usage-history store so the stats panel can show the
 * full history — not just messages recorded after this extension loaded.
 *
 * Incremental: a cache file (`backfill-cache.json`) records which session files
 * have been scanned, so re-runs only process new files. Per-workspace isolation
 * is preserved because records carry the `cwd` from the session header and
 * `readHistory({kind:"workspace", cwd})` filters on it.
 */

interface BackfillCache {
	/** Set of session file basenames already scanned. */
	scannedFiles: string[];
	/** Map: cwd -> count of records extracted. */
	workspaceCounts: Record<string, number>;
}

function backfillCachePath(): string {
	return join(usageHistoryDir(), "backfill-cache.json");
}

async function readBackfillCache(): Promise<BackfillCache> {
	try {
		const raw = await readFile(backfillCachePath(), "utf8");
		const parsed = JSON.parse(raw) as BackfillCache;
		return {
			scannedFiles: Array.isArray(parsed.scannedFiles) ? parsed.scannedFiles : [],
			workspaceCounts: typeof parsed.workspaceCounts === "object" && parsed.workspaceCounts ? parsed.workspaceCounts : {},
		};
	} catch {
		return { scannedFiles: [], workspaceCounts: {} };
	}
}

async function writeBackfillCache(cache: BackfillCache): Promise<void> {
	try {
		await mkdir(usageHistoryDir(), { recursive: true });
		await writeFile(backfillCachePath(), `${JSON.stringify(cache, null, 2)}\n`, "utf8");
	} catch {
		// Best-effort cache.
	}
}

/** Parse one Pi session file into usage records. Returns [] on any error. */
async function parseSessionFile(file: string): Promise<UsageRecord[]> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		return [];
	}
	const records: UsageRecord[] = [];
	let cwd = "";
	let sessionId = "";
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (entry.type === "session") {
			cwd = typeof entry.cwd === "string" ? entry.cwd : "";
			sessionId = typeof entry.id === "string" ? entry.id : "";
			continue;
		}
		if (entry.type !== "message") continue;
		const msg = entry.message as Record<string, unknown> | undefined;
		if (!msg || msg.role !== "assistant") continue;
		const usage = msg.usage as Record<string, unknown> | undefined;
		const cost = usage?.cost as Record<string, unknown> | undefined;
		// COR-RV-008: when neither timestamp is a string, skip the record
		// instead of defaulting ts to 0 (epoch), which would inject bogus
		// 1970-dated records into the series.
		const ts =
			typeof msg.timestamp === "string" ? Date.parse(msg.timestamp) :
			typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) :
			NaN;
		if (!Number.isFinite(ts)) continue;
		records.push({
			ts,
			model: typeof msg.model === "string" ? msg.model : "unknown",
			provider: typeof msg.provider === "string" ? msg.provider : "unknown",
			sessionId: sessionId || "unknown",
			cwd,
			usage: {
				input: typeof usage?.input === "number" ? usage.input : 0,
				output: typeof usage?.output === "number" ? usage.output : 0,
				cacheRead: typeof usage?.cacheRead === "number" ? usage.cacheRead : 0,
				cacheWrite: typeof usage?.cacheWrite === "number" ? usage.cacheWrite : 0,
			},
			cost: {
				total: typeof cost?.total === "number" ? cost.total : 0,
				input: typeof cost?.input === "number" ? cost.input : 0,
				output: typeof cost?.output === "number" ? cost.output : 0,
				cacheRead: typeof cost?.cacheRead === "number" ? cost.cacheRead : 0,
				cacheWrite: typeof cost?.cacheWrite === "number" ? cost.cacheWrite : 0,
			},
		});
	}
	return records;
}

/**
 * Incrementally backfill usage records from Pi session files. Scans only files
 * not yet in the cache and appends their records to the usage-history store
 * (deduplicated by sessionId so repeated runs are idempotent). Returns the
 * number of new records extracted. Safe to call repeatedly; no-op when up to date.
 */
export async function backfillFromSessions(): Promise<{ newRecords: number; newFiles: number }> {
	const sessionsDir = join(getAgentDir(), "sessions");
	if (!existsSync(sessionsDir)) return { newRecords: 0, newFiles: 0 };
	const cache = await readBackfillCache();
	const scanned = new Set(cache.scannedFiles);
	// Collect all session files across all workspace subdirectories.
	const files: string[] = [];
	try {
		for (const sub of await readdir(sessionsDir, { withFileTypes: true })) {
			if (!sub.isDirectory()) continue;
			const subDir = join(sessionsDir, sub.name);
			for (const fn of await readdir(subDir)) {
				if (fn.endsWith(".jsonl")) files.push(join(subDir, fn));
			}
		}
	} catch {
		return { newRecords: 0, newFiles: 0 };
	}
	const newFiles = files.filter((f) => !scanned.has(basename(f)));
	if (newFiles.length === 0) return { newRecords: 0, newFiles: 0 };
	let totalNew = 0;
	for (const f of newFiles) {
		const records = await parseSessionFile(f);
		if (records.length === 0) {
			scanned.add(basename(f));
			continue;
		}
		// Group by sessionId and append to that session's JSONL. Deduplicate by
		// checking the existing file's ts set so re-runs don't double-count.
		const bySession = new Map<string, UsageRecord[]>();
		for (const r of records) {
			const list = bySession.get(r.sessionId) ?? [];
			list.push(r);
			bySession.set(r.sessionId, list);
		}
		for (const [sid, recs] of bySession) {
			const existing = await readExistingTimestamps(sid);
			const fresh = recs.filter((r) => !existing.has(r.ts));
			if (fresh.length === 0) continue;
			try {
				await mkdir(usageHistoryDir(), { recursive: true });
				await appendFile(sessionFile(sid), fresh.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
				totalNew += fresh.length;
				cache.workspaceCounts[recs[0].cwd] = (cache.workspaceCounts[recs[0].cwd] ?? 0) + fresh.length;
			} catch {
				// Best-effort.
			}
		}
		scanned.add(basename(f));
	}
	// PERF-RV-015: prune scannedFiles entries for files that no longer exist on
	// disk, and cap the array length as a secondary guard against unbounded growth.
	const currentBasenames = new Set(files.map((f) => basename(f)));
	cache.scannedFiles = [...scanned].filter((f) => currentBasenames.has(f));
	if (cache.scannedFiles.length > 5000) {
		cache.scannedFiles = cache.scannedFiles.slice(-5000);
	}
	await writeBackfillCache(cache);
	return { newRecords: totalNew, newFiles: newFiles.length };
}

/**
 * Read existing timestamps from a session's usage-history file for dedup.
 * PERF-RV-002(c): only called for NEW backfill files (the scannedFiles cache
 * ensures this), so the cost is bounded by files not yet processed — not the
 * full history.
 */
async function readExistingTimestamps(sessionId: string): Promise<Set<number>> {
	const ts = new Set<number>();
	try {
		const raw = await readFile(sessionFile(sessionId), "utf8");
		for (const line of raw.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try {
				const r = JSON.parse(t) as UsageRecord;
				if (typeof r.ts === "number") ts.add(r.ts);
			} catch {}
		}
	} catch {}
	return ts;
}
