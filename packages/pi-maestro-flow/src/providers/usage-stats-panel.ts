/**
 * `/api-manager stats` panel — tabbed overlay, Claude-Code-style.
 *
 * One `ctx.ui.custom` overlay with three keyboard-switchable tabs:
 *  - Overview: GitHub-style heatmap spanning the full history (by day) + summary stats grid.
 *  - Models:   multi-series line chart (tokens/day per model) + per-model breakdown.
 *  - Sessions: per-session summary list for the current workspace.
 *
 * The range selector (today/7d/30d/all) applies only to the Models tab.
 * Keys: Tab next tab · ←/→ prev/next tab · ↑/↓ range (Models) · q/Esc close.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { ANSI_DIM, ANSI_BOLD, ANSI_RESET, ANSI_REVERSE, COLORS, type RGB } from "../statusline/constants.ts";
import {
	renderHeatmap,
	renderHeatmapLegend,
	renderMultiLineChart,
	renderLineLegend,
	type HeatmapCell,
	type LineSeries,
	type SeriesPoint,
} from "../statusline/usage-chart.ts";
import {
	aggregateByModel,
	daySeries,
	readHistory,
	usageTotals,
	backfillFromSessions,
	type UsageRecord,
} from "./usage-history.ts";

// PERF-RV-002: backfill is already triggered once per process at session_start
// (statusline.ts). Re-running it on every stats-panel refresh caused a full
// sync scan of all Pi session files. Guard so the panel only triggers backfill
// at most once per process lifetime, then just reads the already-backfilled store.
let statsPanelBackfillTriggered = false;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StatsRange = "today" | "7d" | "30d" | "all";
type Tab = "overview" | "models" | "sessions";

const TABS: Tab[] = ["overview", "models", "sessions"];
const TAB_LABEL: Record<Tab, string> = {
	overview: "Overview",
	models: "Models",
	sessions: "Sessions",
};
const RANGE_LABEL: Record<StatsRange, string> = {
	today: "Today",
	"7d": "Last 7 days",
	"30d": "Last 30 days",
	all: "All time",
};
const RANGES: StatsRange[] = ["today", "7d", "30d", "all"];

// Per-series palette for the Models line chart.
const SERIES_PALETTE: RGB[] = [
	COLORS.model,
	COLORS.ctxOk,
	COLORS.milestone,
	COLORS.phase,
	COLORS.danger,
	COLORS.evol,
	COLORS.tokens,
];

// ---------------------------------------------------------------------------
// Overlay component
// ---------------------------------------------------------------------------

interface OverlayParams {
	cwd: string;
	requestRender: () => void;
	done: () => void;
}

export class UsageStatsOverlay implements Component {
	private tab: Tab = "overview";
	private range: StatsRange = "30d";
	private records: UsageRecord[] = [];
	private loading = true;

	constructor(private readonly params: OverlayParams) {
		void this.refresh();
	}

	invalidate(): void {}
	dispose(): void {}

	private async refresh(): Promise<void> {
		this.loading = true;
		this.params.requestRender();
		try {
			// PERF-RV-002: trigger backfill at most once per process lifetime.
			// The session_start handler in statusline.ts already fires it
			// fire-and-forget; re-running on every refresh scanned ALL session
			// files synchronously. After the first run, subsequent refreshes
			// just read the already-backfilled store.
			if (!statsPanelBackfillTriggered) {
				statsPanelBackfillTriggered = true;
				await backfillFromSessions();
			}
			this.records = await readHistory({ kind: "workspace", cwd: this.params.cwd });
		} catch {
			this.records = [];
		}
		this.loading = false;
		this.params.requestRender();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(40, Math.min(width, 120));
		const inner = safeWidth - 2;
		const lines: string[] = [];

		lines.push(this.renderTabBar(inner));
		// The range selector (today/7d/30d/all) only applies to the Models
		// chart, so it is shown only on the Models tab.
		if (this.tab === "models") {
			lines.push(this.renderRangeBar(inner));
		} else {
			lines.push(this.renderCwdBar(inner));
		}
		lines.push(rule(inner));

		if (this.loading) {
			lines.push(dim("加载中…"));
			return frame(lines, safeWidth);
		}

		if (this.records.length === 0) {
			lines.push(dim("暂无用量记录。每条 assistant 消息自动记录 token 与成本。"));
			lines.push(dim("发一条消息后按 r 刷新。"));
			return frame(lines, safeWidth);
		}

		if (this.tab === "overview") {
			this.renderOverview(inner, lines);
		} else if (this.tab === "models") {
			this.renderModels(inner, lines);
		} else {
			this.renderSessions(inner, lines);
		}

		lines.push(rule(inner));
		const rangeHint = this.tab === "models" ? " · ↑/↓ 切换范围" : "";
		lines.push(dim(`Tab 切换标签 · ←/→ 切换标签${rangeHint} · r 刷新 · q/Esc 关闭`));
		return frame(lines, safeWidth);
	}

	private renderTabBar(inner: number): string {
		const parts = TABS.map((t) => {
			const active = t === this.tab;
			const label = ` ${TAB_LABEL[t]} `;
			return active ? `${ANSI_REVERSE}${ANSI_BOLD}${label}${ANSI_RESET}` : `${ANSI_DIM}${label}${ANSI_RESET}`;
		});
		const bar = parts.join("│");
		const title = `${ANSI_BOLD}📊 用量统计${ANSI_RESET}`;
		const titleW = visibleWidth(title);
		const barW = visibleWidth(bar);
		const gap = Math.max(1, inner - titleW - barW);
		return `${title}${" ".repeat(gap)}${bar}`;
	}

	private renderRangeBar(inner: number): string {
		const parts = RANGES.map((r) => {
			const active = r === this.range;
			const label = ` ${RANGE_LABEL[r]} `;
			return active ? `${ANSI_REVERSE}${label}${ANSI_RESET}` : `${ANSI_DIM}${label}${ANSI_RESET}`;
		});
		const bar = parts.join(" ");
		const cwdShort = this.params.cwd.split(/[\\/]/).pop() ?? this.params.cwd;
		const cwdLabel = dim(`工作空间: ${cwdShort}`);
		const barW = visibleWidth(bar);
		const cwdW = visibleWidth(cwdLabel);
		const gap = Math.max(1, inner - barW - cwdW);
		return `${bar}${" ".repeat(gap)}${cwdLabel}`;
	}

	/** A workspace-only header row for tabs that don't use the range selector. */
	private renderCwdBar(inner: number): string {
		const cwdShort = this.params.cwd.split(/[\\/]/).pop() ?? this.params.cwd;
		const cwdLabel = dim(`工作空间: ${cwdShort}`);
		const cwdW = visibleWidth(cwdLabel);
		const gap = Math.max(1, inner - cwdW);
		return `${" ".repeat(gap)}${cwdLabel}`;
	}

	private renderOverview(inner: number, lines: string[]): void {
		const now = Date.now();
		const todayMid = utcMidnight(now);
		// The heatmap spans the full history (all records), by day — it is an
		// overview and is not bound to the range selector. The grid fills the
		// panel width by padding trailing empty weeks to today.
		const heatCellWidth = 2;
		const heatGap = 1;
		const heatLabelCol = 4;
		const heatWeeks = Math.max(1, Math.floor((Math.max(0, inner - heatLabelCol) + heatGap) / (heatCellWidth + heatGap)) - 1);
		// Span from the earliest record day (aligned to its Monday) through today.
		const earliest = this.records.length > 0 ? Math.min(...this.records.map((r) => r.ts)) : now;
		const heatStart = Math.min(utcMidnight(earliest), todayMid - (heatWeeks * 7 - 1) * 86_400_000);
		const heatSeries = daySeries(this.records, "tokens", heatStart, todayMid);
		const cells: HeatmapCell[] = heatSeries.map((b) => ({ ts: b.ts, value: b.value }));
		if (cells.length > 0) {
			for (const line of renderHeatmap(cells, { cellWidth: heatCellWidth, gap: heatGap, color: COLORS.tokens, showWeekdays: true, width: inner })) {
				lines.push(truncateToWidth(line, inner, "…"));
			}
			lines.push(renderHeatmapLegend(COLORS.tokens));
		}
		lines.push(rule(inner));
		const totals = usageTotals(this.records);
		const byModel = aggregateByModel(this.records);
		const favorite = byModel[0]?.model ?? "—";
		const activeDays = new Set(cells.filter((c) => c.value > 0).map((c) => c.ts)).size;
		const stats: Array<[string, string]> = [
			["Favorite model", favorite],
			["Total tokens", fmtT(totals.totalTokens)],
			["Sessions", String(new Set(this.records.map((r) => r.sessionId)).size)],
			["Active days", String(activeDays)],
			["Total cost", `$${totals.totalCost.toFixed(4)}`],
			["Cache hit", pct(totals.cacheHitRate)],
		];
		for (const line of twoColumnGrid(stats, inner)) lines.push(line);
	}

	private renderModels(inner: number, lines: string[]): void {
		const now = Date.now();
		const todayMid = utcMidnight(now);
		const days = this.range === "all" ? 365 : this.range === "30d" ? 30 : this.range === "7d" ? 7 : 1;
		const startDay = todayMid - (days - 1) * 86_400_000;
		const byModel = aggregateByModel(this.records).slice(0, SERIES_PALETTE.length);
		const dayMap = new Map(byModel.map((m) => [m.model, new Map<number, number>()]));
		for (const r of this.records) {
			const day = utcMidnight(r.ts);
			if (day < startDay || day > todayMid) continue;
			const m = dayMap.get(r.model);
			if (!m) continue;
			const v = r.usage.input + r.usage.output;
			m.set(day, round4((m.get(day) ?? 0) + v));
		}
		const series: LineSeries[] = byModel.map((m, i) => {
			const dm = dayMap.get(m.model)!;
			const points: SeriesPoint[] = [];
			for (let ts = startDay; ts <= todayMid; ts += 86_400_000) {
				points.push({ ts, value: dm.get(ts) ?? 0 });
			}
			return { label: m.model, color: SERIES_PALETTE[i % SERIES_PALETTE.length], points };
		});
		if (series.length === 0) {
			lines.push(dim("无模型数据。"));
			return;
		}
		for (const line of renderMultiLineChart(series, { width: inner, height: 12, yTitle: "Tokens per Day", xFormat: "day", stacked: true })) {
			lines.push(truncateToWidth(line, inner, "…"));
		}
		for (const line of renderLineLegend(series, { width: inner })) {
			lines.push(truncateToWidth(line, inner, "…"));
		}
		lines.push(rule(inner));
		const totalTokens = byModel.reduce((acc, m) => acc + m.totalTokens, 0) || 1;
		const modelStats: Array<[string, string]> = byModel.map((m) => [
			m.model,
			`${pct(m.totalTokens / totalTokens)} · In: ${fmtT(m.input)} · Out: ${fmtT(m.output)}`,
		]);
		for (const line of twoColumnGrid(modelStats, inner)) lines.push(line);
	}

	private renderSessions(inner: number, lines: string[]): void {
		// Group records by sessionId for the current workspace.
		const bySession = new Map<string, { records: number; firstTs: number; lastTs: number; totalTokens: number; totalCost: number; models: Set<string> }>();
		for (const r of this.records) {
			let s = bySession.get(r.sessionId);
			if (!s) {
				s = { records: 0, firstTs: r.ts, lastTs: r.ts, totalTokens: 0, totalCost: 0, models: new Set() };
				bySession.set(r.sessionId, s);
			}
			s.records += 1;
			s.firstTs = Math.min(s.firstTs, r.ts);
			s.lastTs = Math.max(s.lastTs, r.ts);
			s.totalTokens += r.usage.input + r.usage.output;
			s.totalCost = round4(s.totalCost + r.cost.total);
			s.models.add(r.model);
		}
		const sessions = [...bySession.entries()]
			.map(([id, s]) => ({ id, ...s }))
			.sort((a, b) => b.lastTs - a.lastTs);
		if (sessions.length === 0) {
			lines.push(dim("当前工作空间暂无会话记录。"));
			return;
		}
		const header = `${dim("Session")}${" ".repeat(Math.max(0, 20 - 7))}  ${dim("Msgs")}  ${dim("Tokens")}  ${dim("Cost")}    ${dim("Models")}    ${dim("Last")}`;
		lines.push(truncateToWidth(header, inner, "…"));
		lines.push(rule(inner));
		for (const s of sessions.slice(0, 12)) {
			const id = truncateToWidth(s.id, 20, "…").padEnd(20, " ");
			const msgs = String(s.records).padStart(4, " ");
			const tokens = fmtT(s.totalTokens).padStart(8, " ");
			const cost = `$${s.totalCost.toFixed(4)}`.padStart(9, " ");
			const models = truncateToWidth([...s.models].join(","), 16, "…").padEnd(16, " ");
			const last = fmtRelative(s.lastTs);
			lines.push(`${id}  ${msgs}  ${tokens}  ${cost}  ${models}  ${dim(last)}`);
		}
		if (sessions.length > 12) {
			lines.push(dim(`…还有 ${sessions.length - 12} 个会话`));
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.params.done();
			return;
		}
		// Tab and ←/→ both cycle tabs.
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.tab = TABS[(TABS.indexOf(this.tab) + 1) % TABS.length];
			this.params.requestRender();
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.tab = TABS[(TABS.indexOf(this.tab) - 1 + TABS.length) % TABS.length];
			this.params.requestRender();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.range = RANGES[(RANGES.indexOf(this.range) - 1 + RANGES.length) % RANGES.length];
			this.params.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.range = RANGES[(RANGES.indexOf(this.range) + 1) % RANGES.length];
			this.params.requestRender();
			return;
		}
		if (data === "r") {
			void this.refresh();
			return;
		}
		// Number keys 1/2/3 jump to a tab directly.
		if (data === "1") { this.tab = "overview"; this.params.requestRender(); return; }
		if (data === "2") { this.tab = "models"; this.params.requestRender(); return; }
		if (data === "3") { this.tab = "sessions"; this.params.requestRender(); return; }
	}
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function showUsageStatsPanel(
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
		ctx.ui.notify("/api-manager stats 需要交互式 Pi 会话。", "warning");
		return;
	}
	await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => new UsageStatsOverlay({
		cwd: ctx.cwd,
		requestRender: () => tui.requestRender(),
		done: () => done(undefined),
	}), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "90%", maxHeight: "88%" },
	});
}

// Legacy/compat exports kept for the command dispatch that still references them.
export function clearUsageStatsWidget(): void {}
export function usageStatsWidgetActive(): boolean { return false; }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function utcMidnight(ts: number): number {
	const d = new Date(ts);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function twoColumnGrid(rows: Array<[string, string]>, inner: number): string[] {
	const colWidth = Math.floor(inner / 2);
	const lines: string[] = [];
	for (let i = 0; i < rows.length; i += 2) {
		const left = rows[i];
		const right = rows[i + 1];
		const leftStr = `${dim(left[0])} ${bold(left[1])}`;
		const rightStr = right ? `${dim(right[0])} ${bold(right[1])}` : "";
		lines.push(`${truncateToWidth(leftStr, colWidth, "…")}${" ".repeat(Math.max(0, colWidth - visibleWidth(leftStr)))}  ${rightStr}`);
	}
	return lines;
}

function fmtT(n: number): string {
	if (!Number.isFinite(n)) return "—";
	if (Math.abs(n) < 1000) return String(Math.round(n));
	if (Math.abs(n) < 1_000_000) return (n / 1000).toFixed(1) + "k";
	if (Math.abs(n) < 1_000_000_000) return (n / 1_000_000).toFixed(1) + "M";
	return (n / 1_000_000_000).toFixed(1) + "B";
}

function pct(r: number): string {
	if (!Number.isFinite(r)) return "—";
	return `${Math.round(r * 100)}%`;
}

function fmtRelative(ts: number): string {
	const diff = Date.now() - ts;
	const min = Math.floor(diff / 60_000);
	if (min < 1) return "just now";
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	if (day < 30) return `${day}d ago`;
	return new Date(ts).toISOString().slice(0, 10);
}

function round4(n: number): number {
	return Math.round(n * 10000) / 10000;
}

function bold(s: string): string {
	return `${ANSI_BOLD}${s}${ANSI_RESET}`;
}

function dim(s: string): string {
	return `${ANSI_DIM}${s}${ANSI_RESET}`;
}

function fitLine(value: string, width: number): string {
	return truncateToWidth(value, Math.max(0, width), "…");
}

function rule(width: number): string {
	return "─".repeat(Math.max(0, width));
}

function frame(rows: readonly string[], width: number): string[] {
	if (width < 2) return rows.map((row) => fitLine(row, width));
	const inner = width - 2;
	const d = (s: string) => `${ANSI_DIM}${s}${ANSI_RESET}`;
	return [
		d(`┌${"─".repeat(inner)}┐`),
		...rows.map((row) => {
			const fitted = fitLine(row, inner);
			return `${d("│")}${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))}${d("│")}`;
		}),
		d(`└${"─".repeat(inner)}┘`),
	];
}
