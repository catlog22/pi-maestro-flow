/**
 * Read-only reader for the api-manager usage-history JSONL store.
 *
 * `pi-maestro-flow` records every finalized assistant message to
 * `~/.pi/agent/usage-history/<sessionId>.jsonl` (written by its
 * `providers/usage-history.ts`). This module reads that store so the Cockpit
 * `/usage` overlay can show a per-provider 7-day token trend without taking a
 * package dependency on `pi-maestro-flow` — Cockpit reads a stable file path,
 * exactly as it reads `cockpit.json` from `getAgentDir()`.
 *
 * Cockpit is strictly read-only here; `pi-maestro-flow` remains the sole
 * writer. If that extension is not installed the directory is absent and every
 * function returns empty (no error) — the trend section in the overlay simply
 * does not render, matching how the MAESTRO/AGENTS/TODO blocks degrade when
 * their producers are missing.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** One finalized-assistant-message record, as written by pi-maestro-flow. */
export interface UsageRecord {
	/** Unix timestamp (ms) of the finalized assistant message. */
	ts: number;
	/** Model id as reported by the provider. */
	model: string;
	/** Provider id (matches the usage-bars `providerToPiProviderId()` output). */
	provider: string;
	/** Owning session id (partition key). */
	sessionId: string;
	/** Working directory when the message was recorded (workspace filter key). */
	cwd: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	cost: {
		total: number;
		[key: string]: number;
	};
}

export interface ReadUsageHistoryOptions {
	/** Pi provider id filter (e.g. "openai-codex", "anthropic"). Omit for all. */
	provider?: string;
	/** Only records with ts >= since (ms). Omit for all history. */
	since?: number;
	/** Only records whose cwd matches (workspace scope). Omit for all. */
	cwd?: string;
	/** Override the history directory (tests inject a temp dir). */
	dir?: string;
}

const DAY_MS = 86_400_000;

function historyDir(): string {
	return join(getAgentDir(), "usage-history");
}

function isRecord(value: unknown): value is UsageRecord {
	if (!value || typeof value !== "object") return false;
	const r = value as Record<string, unknown>;
	return typeof r.ts === "number"
		&& typeof r.model === "string"
		&& typeof r.provider === "string"
		&& typeof r.sessionId === "string"
		&& typeof r.cwd === "string"
		&& typeof r.usage === "object" && r.usage !== null;
}

/**
 * Read the usage-history store, optionally filtered. Best-effort: a missing
 * directory or a malformed line is skipped, never thrown. Records are sorted
 * ascending by timestamp. No writes; no caching (the overlay calls this once
 * per open and the store grows slowly).
 */
export async function readUsageHistory(options: ReadUsageHistoryOptions = {}): Promise<UsageRecord[]> {
	const dir = options.dir ?? historyDir();
	if (!existsSync(dir)) return [];
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}
	const files = entries.filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
	const records: UsageRecord[] = [];
	await Promise.all(files.map(async (file) => {
		let raw: string;
		try {
			raw = await readFile(file, "utf8");
		} catch {
			return; // unreadable file — skip, never fail the whole read
		}
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed) as unknown;
				if (!isRecord(parsed)) continue;
				if (options.since !== undefined && parsed.ts < options.since) continue;
				if (options.provider !== undefined && parsed.provider !== options.provider) continue;
				if (options.cwd !== undefined && parsed.cwd !== options.cwd) continue;
				records.push(parsed);
			} catch {
				// malformed line — skip, never fail the whole read
			}
		}
	}));
	records.sort((a, b) => a.ts - b.ts);
	return records;
}

export interface DailyBucket {
	/** UTC midnight timestamp (ms) starting the day. */
	ts: number;
	/** Total input+output tokens for the day. */
	tokens: number;
	/** Total cost (USD) for the day. */
	cost: number;
	/** Number of finalized turns recorded for the day. */
	turns: number;
}

function utcMidnight(ts: number): number {
	const d = new Date(ts);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Aggregate records into `days` UTC-day buckets ending at the most recent
 * record's day (or today when there are no records). Missing days are 0-filled
 * so the sparkline axis is continuous — mirrors `daySeries`'s fill logic.
 */
export function aggregateDailyTokens(records: readonly UsageRecord[], days: number, nowMs: number = Date.now()): DailyBucket[] {
	const count = Math.max(1, Math.floor(days));
	const anchor = records.length > 0 ? Math.max(...records.map((r) => r.ts)) : nowMs;
	const endDay = utcMidnight(anchor);
	const startDay = endDay - (count - 1) * DAY_MS;
	const map = new Map<number, DailyBucket>();
	for (let ts = startDay; ts <= endDay; ts += DAY_MS) {
		map.set(ts, { ts, tokens: 0, cost: 0, turns: 0 });
	}
	for (const r of records) {
		const key = utcMidnight(r.ts);
		const bucket = map.get(key);
		if (!bucket) continue; // outside the window
		bucket.tokens += r.usage.input + r.usage.output;
		bucket.cost = Math.round((bucket.cost + r.cost.total) * 10000) / 10000;
		bucket.turns += 1;
	}
	return [...map.values()].sort((a, b) => a.ts - b.ts);
}

export interface ModelShare {
	model: string;
	tokens: number;
	/** Fraction of this provider's tokens attributed to the model, 0..1. */
	share: number;
}

/** Top models by token volume for the given records (shares sum to ~1). */
export function topModelsByTokens(records: readonly UsageRecord[], limit: number): ModelShare[] {
	const count = Math.max(1, Math.floor(limit));
	const totals = new Map<string, number>();
	let grandTotal = 0;
	for (const r of records) {
		const tokens = r.usage.input + r.usage.output;
		totals.set(r.model, (totals.get(r.model) ?? 0) + tokens);
		grandTotal += tokens;
	}
	return [...totals.entries()]
		.map(([model, tokens]) => ({ model, tokens, share: grandTotal > 0 ? tokens / grandTotal : 0 }))
		.sort((a, b) => b.tokens - a.tokens)
		.slice(0, count);
}

export interface TrendSummary {
	records: readonly UsageRecord[];
	daily: DailyBucket[];
	topModels: ModelShare[];
	totalTokens: number;
	totalCost: number;
	totalTurns: number;
	avgTurnsPerDay: number;
}

/**
 * Build the full trend bundle the overlay renders: daily buckets for the last
 * `days` days, top models, and rolled-up totals. Returns null when there are no
 * records in the window so the overlay omits the section cleanly.
 */
export function buildTrend(records: readonly UsageRecord[], days: number, nowMs: number = Date.now()): TrendSummary | null {
	const daily = aggregateDailyTokens(records, days, nowMs);
	const totalTokens = daily.reduce((sum, b) => sum + b.tokens, 0);
	const totalCost = daily.reduce((sum, b) => sum + b.cost, 0);
	const totalTurns = daily.reduce((sum, b) => sum + b.turns, 0);
	// No tokens in the window → nothing to chart (a 0-token turn is not a trend).
	if (totalTokens === 0) return null;
	const windowed = daily.length > 0
		? records.filter((r) => r.ts >= daily[0]!.ts && r.ts < daily[daily.length - 1]!.ts + DAY_MS)
		: records;
	return {
		records: windowed,
		daily,
		topModels: topModelsByTokens(windowed, 2),
		totalTokens,
		totalCost: Math.round(totalCost * 10000) / 10000,
		totalTurns,
		avgTurnsPerDay: daily.length > 0 ? totalTurns / daily.length : 0,
	};
}
