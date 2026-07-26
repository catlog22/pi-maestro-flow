import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ExtensionStatusSegment } from "./extension-status.ts";
import type { IconGlyphs } from "./icons.ts";

// Width helpers are injected so this module has zero runtime dependency on pi-tui
// (keeps the pure-function unit tests hermetic). The real wiring in index.ts passes
// pi-tui's visibleWidth / truncateToWidth so east-asian widths are correct on a terminal.
export interface WidthUtils {
	measure: (text: string) => number;
	clip: (text: string, width: number, ellipsis: string) => string;
}

export type PaintTheme = Pick<Theme, "fg">;

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate: number | undefined;
}

export interface FooterParts {
	model: string;
	provider?: string;
	thinking?: string;
	cwd?: string;
	ctxPct: number;
	ctxTokens: number;
	ctxWindow: number;
	totals: UsageTotals;
	git?: string;
	elapsed: string;
	agentSummary?: string;
	workflowStatus?: string;
	extensionStatuses?: readonly ExtensionStatusSegment[];
	width: number;
	glyphs: IconGlyphs;
	theme: PaintTheme;
	utils: WidthUtils;
}

export function emptyTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined };
}

let usageCache: { key: string; totals: UsageTotals } | undefined;

function entryIdentity(entry: unknown): string {
	const e = entry as {
		id?: string;
		timestamp?: number;
		type?: string;
		message?: {
			role?: string;
			usage?: {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
				cost?: { total?: number };
			};
		};
	} | undefined;
	if (!e) return "";
	const usage = e.message?.usage;
	const usageKey = usage
		? `${usage.input ?? 0}:${usage.output ?? 0}:${usage.cacheRead ?? 0}:${usage.cacheWrite ?? 0}:${usage.cost?.total ?? 0}`
		: "";
	return `${e.id ?? ""}|${e.timestamp ?? ""}|${e.type ?? ""}|${e.message?.role ?? ""}|${usageKey}`;
}

function entriesKey(entries: readonly unknown[]): string {
	return `${entries.length}\0${entryIdentity(entries[0])}\0${entryIdentity(entries.at(-1))}`;
}

export function invalidateUsageCache(): void {
	usageCache = undefined;
}

// Sum assistant-message usage across session entries (shape: entry.message.usage).
export function getUsageTotals(entries: readonly unknown[]): UsageTotals {
	const key = entriesKey(entries);
	if (usageCache && usageCache.key === key) return usageCache.totals;

	const t = emptyTotals();
	for (const e of entries) {
		const entry = e as { type?: string; message?: { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } } } | undefined;
		if (entry?.type === "message" && entry.message?.role === "assistant") {
			const u = entry.message.usage;
			if (!u) continue;
			t.input += u.input ?? 0;
			t.output += u.output ?? 0;
			t.cacheRead += u.cacheRead ?? 0;
			t.cacheWrite += u.cacheWrite ?? 0;
			t.cost += u.cost?.total ?? 0;
			const promptTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
			if (promptTokens > 0) {
				t.latestCacheHitRate = ((u.cacheRead ?? 0) / promptTokens) * 100;
			}
		}
	}
	usageCache = { key, totals: t };
	return t;
}

export function fmtTokens(n: number): string {
	if (n >= 1_000_000) return trim(n / 1_000_000) + "m";
	if (n >= 1_000) return trim(n / 1_000) + "k";
	return String(n);
}

function trim(x: number): string {
	return x.toFixed(1).replace(/\.0$/, "");
}

export function renderBar(pct: number, barWidth: number, glyphs: IconGlyphs, theme: PaintTheme): string {
	const w = Math.max(0, barWidth);
	const clamped = Math.max(0, Math.min(100, pct));
	const filled = Math.max(0, Math.min(w, Math.round((clamped / 100) * w)));
	const empty = w - filled;
	return theme.fg("dim", "[") + theme.fg(contextColor(pct), glyphs.barDone.repeat(filled)) + theme.fg("dim", glyphs.barPending.repeat(empty)) + theme.fg("dim", "]");
}

interface PrioritizedSegment {
	text: string;
	priority: number;
}

function contextColor(pct: number): ThemeColor {
	if (pct >= 90) return "error";
	if (pct >= 70) return "warning";
	return "accent";
}

function extensionStatusColor(status: ExtensionStatusSegment): ThemeColor {
	if (status.key === "mode") {
		const mode = status.text.trim().toUpperCase();
		if (mode === "ACT") return "success";
		if (mode === "PLAN") return "warning";
		if (mode === "READY" || mode === "PLAN READY") return "accent";
		return "muted";
	}
	if (status.key !== "approval-mode") return "muted";
	const mode = status.text.replace(/^APPROVAL\s+/i, "").trim().toLowerCase();
	if (mode === "yolo" || mode === "bypasspermissions") return "error";
	if (mode === "dontask") return "warning";
	if (mode === "acceptedits") return "success";
	if (mode === "plan") return "accent";
	return "text";
}

export function fitSegmentsByPriority(
	segs: readonly PrioritizedSegment[],
	maxW: number,
	measure: WidthUtils["measure"],
	clip: WidthUtils["clip"],
	ellipsis = "...",
	separatorWidth = 1,
): string[] {
	const items = segs.map((s) => ({ text: s.text, priority: s.priority, w: measure(s.text) }));
	const totalW = (): number => {
		const active = items.filter((it) => it.text !== "");
		return active.reduce((a, it) => a + it.w, 0) + Math.max(0, active.length - 1) * separatorWidth;
	};
	while (totalW() > maxW) {
		let target = -1;
		for (let i = 0; i < items.length; i++) {
			if (items[i].text !== "" && (target === -1 || items[i].priority < items[target].priority)) {
				target = i;
			}
		}
		if (target === -1) break;
		const others = items.filter((_, i) => i !== target && items[i].text !== "");
		const otherW = others.reduce((a, it) => a + it.w, 0) + Math.max(0, others.length - 1) * separatorWidth;
		const avail = maxW - otherW - (others.length > 0 ? separatorWidth : 0);
		if (avail <= measure(ellipsis)) {
			items[target].text = "";
			items[target].w = 0;
		} else if (avail < items[target].w) {
			items[target].text = clip(items[target].text, avail, ellipsis);
			items[target].w = measure(items[target].text);
		} else {
			break;
		}
	}
	return items.filter((it) => it.text !== "").map((it) => it.text);
}

function alignRight(left: string, right: string, width: number, measure: WidthUtils["measure"]): string {
	if (right === "") return left;
	if (left === "") return right;
	const lw = measure(left);
	const rw = measure(right);
	if (lw + rw + 1 > width) return left;
	return left + " ".repeat(width - lw - rw) + right;
}

export function renderFooter(p: FooterParts): string[] {
	const { width, theme, glyphs: g, utils } = p;
	if (width <= 0) return [""];
	const ell = theme.fg("dim", g.ellipsis);
	const sep = theme.fg("dim", g.separator.trim());

	// line 1: prioritized left segments · context gauge (right)
	const leftParts: PrioritizedSegment[] = [];
	if (p.cwd) leftParts.push({ text: `${theme.fg("mdLink", g.workspace)} ${theme.fg("accent", p.cwd)}`, priority: 0 });
	if (p.git) leftParts.push({ text: `${theme.fg("mdLink", g.git)} ${theme.fg("accent", p.git)}`, priority: 3 });

	let right1 = "";
	if (p.ctxWindow > 0) {
		const pctText = theme.fg(contextColor(p.ctxPct), `${Math.round(p.ctxPct)}%`);
		const tokText = `${theme.fg("text", fmtTokens(p.ctxTokens))}${theme.fg("dim", "/")}${theme.fg("text", fmtTokens(p.ctxWindow))}`;
		const candidates = [
			`${renderBar(p.ctxPct, 10, g, theme)} ${pctText} ${sep} ${tokText}`,
			`${pctText} ${sep} ${tokText}`,
			pctText,
		];
		right1 = candidates.find((candidate) => utils.measure(candidate) <= width)
			?? utils.clip(pctText, width, ell);
	}
	const rightW = utils.measure(right1);
	const availLeft = Math.max(0, width - rightW - (right1 ? 1 : 0));
	const fittedLeft = fitSegmentsByPriority(leftParts, availLeft, utils.measure, utils.clip, g.ellipsis);
	const line1 = alignRight(fittedLeft.join(" "), right1, width, utils.measure);

	// line 2: model + thinking (left) · in/out/cache/cost/elapsed (right)
	const modelParts: string[] = [];
	if (p.provider) modelParts.push(theme.fg("muted", p.provider));
	modelParts.push(theme.fg("text", p.model));
	if (p.thinking && p.thinking !== "off") modelParts.push(theme.fg("accent", `${p.thinking}`));
	const modelLeft = modelParts.join(theme.fg("dim", " · "));

	const t = p.totals;
	const stats: PrioritizedSegment[] = [
		{ text: `${theme.fg("accent", g.tokensIn)}${fmtTokens(t.input)}`, priority: 5 },
		{ text: `${theme.fg("success", g.tokensOut)}${fmtTokens(t.output)}`, priority: 4 },
	];
	const hasCache = t.cacheRead > 0 || t.cacheWrite > 0;
	if (hasCache && t.latestCacheHitRate !== undefined) {
		stats.push({ text: `${theme.fg("success", g.cacheHit)}${t.latestCacheHitRate.toFixed(0)}%`, priority: 3 });
	}
	stats.push({ text: theme.fg("muted", p.elapsed), priority: 1 });
	if (p.agentSummary) stats.push({ text: theme.fg("accent", p.agentSummary), priority: 0 });
	const statSeparator = ` ${sep} `;
	const modelReserve = width >= 32 ? Math.min(12, utils.measure(modelLeft)) : 0;
	const fittedStats = fitSegmentsByPriority(
		stats,
		Math.max(0, width - modelReserve - (modelReserve > 0 ? 1 : 0)),
		utils.measure,
		utils.clip,
		g.ellipsis,
		utils.measure(statSeparator),
	);
	const right2 = fittedStats.join(statSeparator);
	const right2Width = utils.measure(right2);
	const modelWidth = Math.max(0, width - right2Width - (right2 ? 1 : 0));
	const fittedModel = modelWidth > 0 ? utils.clip(modelLeft, modelWidth, ell) : "";
	const line2 = alignRight(fittedModel, right2, width, utils.measure);

	const lines = [utils.clip(line1, width, ell), utils.clip(line2, width, ell)];
	if (p.workflowStatus) {
		lines.push(utils.clip(theme.fg("muted", p.workflowStatus), width, ell));
	}
	const statuses = (p.extensionStatuses ?? []).filter(
		(status) => status.text !== "" && status.text !== p.thinking,
	);
	if (statuses.length > 0) {
		const statusSeparator = ` ${sep} `;
		const fittedStatuses = fitSegmentsByPriority(
			statuses.map((status, index) => ({
				text: theme.fg(extensionStatusColor(status), status.text),
				priority: statuses.length - index,
			})),
			width,
			utils.measure,
			utils.clip,
			g.ellipsis,
			utils.measure(statusSeparator),
		);
		if (fittedStatuses.length > 0) {
			lines.push(utils.clip(fittedStatuses.join(statusSeparator), width, ell));
		}
	}
	return lines;
}
