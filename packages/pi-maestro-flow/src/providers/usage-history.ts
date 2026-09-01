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
import { createHash, randomUUID } from "node:crypto";
import { mkdir, appendFile, lstat, readFile, rename, readdir, unlink, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { lockSettingsResource } from "../settings/resource-lock.ts";

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

function fullDigest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function readableSessionPrefix(sessionId: string): string {
	return sessionId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "unknown";
}

/** Canonical filenames retain the complete SHA-256 digest of the session id. */
export function usageSessionFile(sessionId: string): string {
	return join(usageHistoryDir(), `${readableSessionPrefix(sessionId)}--${fullDigest(sessionId)}.jsonl`);
}

function legacySessionFile(sessionId: string): string {
	const legacy = sessionId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 200) || "unknown";
	return join(usageHistoryDir(), `${legacy}.jsonl`);
}

function indexPath(): string {
	return join(usageHistoryDir(), "index.json");
}

function storeLockPath(): string {
	return join(usageHistoryDir(), ".usage-history-store");
}

async function withUsageHistoryLock<T>(operation: () => Promise<T>): Promise<T> {
	await mkdir(usageHistoryDir(), { recursive: true });
	const release = await lockSettingsResource(storeLockPath());
	try {
		return await operation();
	} finally {
		await release();
	}
}

async function atomicWrite(path: string, contents: string): Promise<void> {
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	try {
		await writeFile(temporary, contents, "utf8");
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Recording (write path)
// ---------------------------------------------------------------------------

/**
 * Record one finalized assistant message. Best-effort: errors are swallowed
 * so the agent turn never breaks. The append, migration, and index update use
 * the same resource lock as cleanup; a delayed index write can therefore never
 * recreate an entry after guarded deletion.
 */
export async function recordUsage(message: AssistantMessage, sessionId: string, cwd: string): Promise<void> {
	const record = toRecord(message, sessionId, cwd);
	try {
		await withUsageHistoryLock(async () => {
			await migrateSessionLocked(sessionId);
			await appendFile(usageSessionFile(sessionId), `${JSON.stringify(record)}\n`, "utf8");
			await refreshIndexEntryLocked(sessionId);
		});
	} catch {
		// Disk failure, permission, etc. — usage tracking is best-effort.
	}
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

function indexEntryFor(sessionId: string, records: readonly UsageRecord[]): SessionIndexEntry | undefined {
	if (records.length === 0) return undefined;
	return {
		sessionId,
		firstTs: Math.min(...records.map((record) => record.ts)),
		lastTs: Math.max(...records.map((record) => record.ts)),
		recordCount: records.length,
		totalCost: round4(records.reduce((sum, record) => sum + record.cost.total, 0)),
		modelCount: new Set(records.map((record) => record.model)).size,
	};
}

async function refreshIndexEntryLocked(sessionId: string): Promise<void> {
	const current = await readIndex();
	const records = (await readSessionRecordsLocked(sessionId)).filter((record) => record.sessionId === sessionId);
	const next = indexEntryFor(sessionId, records);
	const index = current.sessions.findIndex((entry) => entry.sessionId === sessionId);
	if (next && index >= 0) current.sessions[index] = next;
	else if (next) current.sessions.push(next);
	else if (index >= 0) current.sessions.splice(index, 1);
	await atomicWrite(indexPath(), `${JSON.stringify(current, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Reading (read path)
// ---------------------------------------------------------------------------

export async function readHistory(scope: ReadScope, opts: ReadOptions = {}): Promise<UsageRecord[]> {
	const filterCwd = scope.kind === "workspace" ? scope.cwd : undefined;
	let files: string[];
	if (scope.kind === "session") {
		try {
			await withUsageHistoryLock(() => migrateSessionLocked(scope.sessionId));
		} catch {
			// Reads degrade to the canonical/legacy files that remain.
		}
		files = await existingSessionFiles(scope.sessionId);
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
				indexed.set(usageSessionFile(entry.sessionId), entry);
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
			if (scope.kind === "session" && rec.sessionId !== scope.sessionId) continue;
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
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".jsonl")).map((entry) => join(dir, entry.name));
	} catch {
		return [];
	}
}

async function existingSessionFiles(sessionId: string): Promise<string[]> {
	const candidates = [...new Set([usageSessionFile(sessionId), legacySessionFile(sessionId)])];
	const files: string[] = [];
	for (const path of candidates) {
		try {
			const info = await lstat(path);
			if (info.isFile() && !info.isSymbolicLink()) files.push(path);
		} catch {}
	}
	return files;
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

async function readSessionRecordsLocked(sessionId: string): Promise<UsageRecord[]> {
	const records: UsageRecord[] = [];
	for (const file of await existingSessionFiles(sessionId)) records.push(...await readJsonl(file));
	return records;
}

async function migrateSessionLocked(sessionId: string): Promise<void> {
	const legacy = legacySessionFile(sessionId);
	const canonical = usageSessionFile(sessionId);
	if (legacy === canonical) return;
	let legacyInfo;
	try {
		legacyInfo = await lstat(legacy);
	} catch {
		return;
	}
	if (!legacyInfo.isFile() || legacyInfo.isSymbolicLink()) return;
	const legacyParsed = await inspectUsageFile(legacy);
	// A colliding or partially unreadable legacy filename is never rewritten or deleted.
	if (!legacyParsed.valid || legacyParsed.sessionIds.size !== 1 || !legacyParsed.sessionIds.has(sessionId)) return;

	let canonicalRecords: UsageRecord[] = [];
	try {
		const canonicalInfo = await lstat(canonical);
		if (!canonicalInfo.isFile() || canonicalInfo.isSymbolicLink()) return;
		const canonicalParsed = await inspectUsageFile(canonical);
		// Preserve every raw byte if the canonical file is only partially parseable.
		// An empty/ASCII-whitespace-only JSONL file is a valid empty migration target.
		if (!canonicalParsed.valid && !isJsonlWhitespaceOnly(canonicalParsed.raw)) return;
		canonicalRecords = canonicalParsed.records;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") return;
	}

	const seen = new Set<string>();
	const merged: UsageRecord[] = [];
	for (const record of [...canonicalRecords, ...legacyParsed.records]) {
		const identity = stableJsonIdentity(record);
		if (seen.has(identity)) continue;
		seen.add(identity);
		merged.push(record);
	}
	merged.sort((a, b) => a.ts - b.ts);
	await atomicWrite(canonical, merged.map((record) => JSON.stringify(record)).join("\n") + (merged.length ? "\n" : ""));
	// Canonical persistence succeeded; only now may the fully parsed legacy file disappear.
	await unlink(legacy);
	await refreshIndexEntryLocked(sessionId);
}

export async function readSessionIndex(): Promise<SessionIndex> {
	return readIndex();
}

export interface UsageHistoryInventoryEntry {
	path: string;
	fileName: string;
	id: string;
	revision: string;
	sizeBytes: number;
	modified: Date;
	sessionIds: string[];
	cwds: string[];
	cleanupEligible: boolean;
	protectionReason?: string;
}

interface InspectedUsageFile {
	records: UsageRecord[];
	sessionIds: Set<string>;
	cwds: Set<string>;
	valid: boolean;
	raw: Buffer;
}

function stableJsonIdentity(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJsonIdentity).join(",")}]`;
	if (value && typeof value === "object") {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJsonIdentity(object[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function isUsageRecord(value: unknown): value is UsageRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<UsageRecord>;
	const usage = record.usage as Partial<UsageRecord["usage"]> | undefined;
	const cost = record.cost as Partial<UsageRecord["cost"]> | undefined;
	return Number.isFinite(record.ts) && typeof record.sessionId === "string" && record.sessionId.length > 0
		&& typeof record.cwd === "string" && typeof record.model === "string" && typeof record.provider === "string"
		&& Boolean(usage)
		&& Number.isFinite(usage?.input) && Number.isFinite(usage?.output)
		&& Number.isFinite(usage?.cacheRead) && Number.isFinite(usage?.cacheWrite)
		&& Boolean(cost)
		&& Number.isFinite(cost?.total) && Number.isFinite(cost?.input) && Number.isFinite(cost?.output)
		&& Number.isFinite(cost?.cacheRead) && Number.isFinite(cost?.cacheWrite);
}

const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function isJsonlWhitespaceOnly(raw: Buffer): boolean {
	return raw.every((byte) => byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20);
}

async function inspectUsageFile(path: string): Promise<InspectedUsageFile> {
	let raw: Buffer;
	try {
		raw = await readFile(path);
	} catch {
		return { records: [], sessionIds: new Set(), cwds: new Set(), valid: false, raw: Buffer.alloc(0) };
	}
	let decoded: string;
	try {
		decoded = strictUtf8Decoder.decode(raw);
	} catch {
		return { records: [], sessionIds: new Set(), cwds: new Set(), valid: false, raw };
	}
	const records: UsageRecord[] = [];
	let valid = true;
	for (const line of decoded.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!isUsageRecord(parsed)) valid = false;
			else records.push(parsed);
		} catch {
			valid = false;
		}
	}
	if (records.length === 0) valid = false;
	return {
		records,
		sessionIds: new Set(records.map((record) => record.sessionId)),
		cwds: new Set(records.map((record) => record.cwd)),
		valid,
		raw,
	};
}

export interface UsageLiveSessionProtection {
	/** Session ids reported live by the authoritative workspace session directory. */
	liveSessionIds?: ReadonlySet<string>;
	/** False when no authoritative live-session view could be refreshed. */
	evidenceAvailable?: boolean;
}

function usageProtection(
	inspected: InspectedUsageFile,
	cwd: string,
	currentSessionId: string | undefined,
	liveProtection: UsageLiveSessionProtection,
): string | undefined {
	if (!inspected.valid) return "damaged or unknown usage-history contents";
	if (inspected.sessionIds.size !== 1) return "mixed or unknown session ownership";
	if (inspected.cwds.size !== 1) return "mixed cwd ownership";
	const sessionId = [...inspected.sessionIds][0]!;
	const ownerCwd = [...inspected.cwds][0]!;
	if (currentSessionId && sessionId === currentSessionId) return "current session is active";
	if (ownerCwd !== cwd) return "owned by another workspace";
	if (liveProtection.evidenceAvailable !== true) return "live-session status is unavailable; cleanup is conservatively disabled";
	if (liveProtection.liveSessionIds?.has(sessionId)) return "workspace peer session is active";
	return undefined;
}

async function scanUsageFilesLocked(
	cwd: string,
	currentSessionId?: string,
	liveProtection: UsageLiveSessionProtection = {},
): Promise<UsageHistoryInventoryEntry[]> {
	let names: string[];
	try {
		names = await readdir(usageHistoryDir());
	} catch {
		return [];
	}
	const entries: UsageHistoryInventoryEntry[] = [];
	for (const fileName of names.sort()) {
		if (!fileName.endsWith(".jsonl")) continue;
		const path = join(usageHistoryDir(), fileName);
		let info;
		try {
			info = await lstat(path);
		} catch {
			continue;
		}
		const itemId = `usage:${fullDigest(resolve(path))}`;
		if (!info.isFile() || info.isSymbolicLink()) {
			entries.push({
				path, fileName, id: itemId,
				revision: fullDigest(`${resolve(path)}\0${info.dev}\0${info.ino}\0${info.size}\0${info.mtimeMs}`),
				sizeBytes: info.size, modified: info.mtime, sessionIds: [], cwds: [], cleanupEligible: false,
				protectionReason: "symlink or non-regular entry",
			});
			continue;
		}
		const inspected = await inspectUsageFile(path);
		const protectionReason = usageProtection(inspected, cwd, currentSessionId, liveProtection);
		entries.push({
			path, fileName, id: itemId,
			revision: fullDigest(Buffer.concat([Buffer.from(`${resolve(path)}\0`, "utf8"), inspected.raw])),
			sizeBytes: info.size, modified: info.mtime,
			sessionIds: [...inspected.sessionIds], cwds: [...inspected.cwds],
			cleanupEligible: protectionReason === undefined,
			...(protectionReason ? { protectionReason } : {}),
		});
	}
	return entries;
}

/** Inventory usage files, migrating unambiguous legacy files under the store lock. */
export async function inventoryUsageHistory(
	cwd: string,
	currentSessionId?: string,
	liveProtection: UsageLiveSessionProtection = {},
): Promise<UsageHistoryInventoryEntry[]> {
	return withUsageHistoryLock(async () => {
		const initial = await scanUsageFilesLocked(cwd, currentSessionId, liveProtection);
		for (const entry of initial) {
			if (entry.sessionIds.length !== 1) continue;
			const sessionId = entry.sessionIds[0]!;
			if (resolve(entry.path) !== resolve(usageSessionFile(sessionId))) await migrateSessionLocked(sessionId);
		}
		return scanUsageFilesLocked(cwd, currentSessionId, liveProtection);
	});
}

export interface DeleteUsageHistoryRequest {
	cwd: string;
	itemId: string;
	revision: string;
	currentSessionId?: string;
	liveProtection?: UsageLiveSessionProtection;
}

export interface DeleteUsageHistoryResult {
	status: "deleted" | "missing" | "protected" | "stale" | "failed";
	reclaimedBytes?: number;
	message?: string;
}

/** Delete only a still-identical, regular, purely current-workspace usage file. */
export async function guardedDeleteUsageHistory(request: DeleteUsageHistoryRequest): Promise<DeleteUsageHistoryResult> {
	try {
		return await withUsageHistoryLock(async () => {
			const entry = (await scanUsageFilesLocked(
				request.cwd,
				request.currentSessionId,
				request.liveProtection,
			)).find((item) => item.id === request.itemId);
			if (!entry) return { status: "missing" };
			if (entry.revision !== request.revision) return { status: "stale", message: "usage-history file changed after preview" };
			if (entry.protectionReason || !entry.cleanupEligible || entry.sessionIds.length !== 1) {
				return { status: "protected", message: entry.protectionReason ?? "ownership is not cleanup-eligible" };
			}
			const sessionId = entry.sessionIds[0]!;
			await unlink(entry.path);
			try {
				await refreshIndexEntryLocked(sessionId);
				return { status: "deleted", reclaimedBytes: entry.sizeBytes };
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return {
					status: "deleted",
					reclaimedBytes: entry.sizeBytes,
					message: `usage data was deleted, but non-authoritative index reconciliation failed: ${detail}`,
				};
			}
		});
	} catch (error) {
		return { status: "failed", message: error instanceof Error ? error.message : String(error) };
	}
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
	/** Full SHA-256 digests of absolute session paths already scanned. */
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
		await atomicWrite(backfillCachePath(), `${JSON.stringify(cache, null, 2)}\n`);
	} catch {
		// Best-effort cache.
	}
}

function backfillPathKey(file: string): string {
	return fullDigest(resolve(file));
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
	return withUsageHistoryLock(async () => {
		const cache = await readBackfillCache();
		// Ignore legacy basename cache entries: rescanning once is safe because timestamps dedupe.
		const scanned = new Set(cache.scannedFiles.filter((key) => /^[a-f0-9]{64}$/.test(key)));
		const files: string[] = [];
		try {
			for (const sub of await readdir(sessionsDir, { withFileTypes: true })) {
				if (!sub.isDirectory() || sub.isSymbolicLink()) continue;
				const subDir = join(sessionsDir, sub.name);
				for (const entry of await readdir(subDir, { withFileTypes: true })) {
					if (entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".jsonl")) files.push(join(subDir, entry.name));
				}
			}
		} catch {
			return { newRecords: 0, newFiles: 0 };
		}
		const newFiles = files.filter((file) => !scanned.has(backfillPathKey(file)));
		if (newFiles.length === 0) return { newRecords: 0, newFiles: 0 };
		let totalNew = 0;
		const changedSessions = new Set<string>();
		for (const file of newFiles) {
			const records = await parseSessionFile(file);
			const bySession = new Map<string, UsageRecord[]>();
			for (const record of records) {
				const list = bySession.get(record.sessionId) ?? [];
				list.push(record);
				bySession.set(record.sessionId, list);
			}
			for (const [sessionId, sessionRecords] of bySession) {
				await migrateSessionLocked(sessionId);
				const existing = await readExistingTimestamps(sessionId);
				const fresh = sessionRecords.filter((record) => !existing.has(record.ts));
				if (fresh.length === 0) continue;
				try {
					await appendFile(usageSessionFile(sessionId), fresh.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
					totalNew += fresh.length;
					changedSessions.add(sessionId);
					const ownerCwd = fresh[0]?.cwd ?? "";
					cache.workspaceCounts[ownerCwd] = (cache.workspaceCounts[ownerCwd] ?? 0) + fresh.length;
				} catch {
					// Best-effort.
				}
			}
			scanned.add(backfillPathKey(file));
		}
		for (const sessionId of changedSessions) await refreshIndexEntryLocked(sessionId);
		const currentKeys = new Set(files.map(backfillPathKey));
		cache.scannedFiles = [...scanned].filter((key) => currentKeys.has(key)).slice(-5000);
		await writeBackfillCache(cache);
		return { newRecords: totalNew, newFiles: newFiles.length };
	});
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
		const raw = await readFile(usageSessionFile(sessionId), "utf8");
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
