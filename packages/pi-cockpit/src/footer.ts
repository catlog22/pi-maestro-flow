import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ExtensionStatusSegment } from "./extension-status.ts";
import type { IconGlyphs } from "./icons.ts";
import { fitSegmentsByPriority, type PrioritizedSegment, type WidthUtils } from "./layout.ts";

// Re-exported so existing importers keep working; the implementations now live in
// layout.ts because the widgets need the same priority-collapse behaviour.
export { fitSegmentsByPriority, type WidthUtils };

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

const CONTEXT_WARN_PCT = 70;
const CONTEXT_CRITICAL_PCT = 90;

function contextColor(pct: number): ThemeColor {
	if (pct >= CONTEXT_CRITICAL_PCT) return "error";
	if (pct >= CONTEXT_WARN_PCT) return "warning";
	return "accent";
}

// Crossing a context threshold used to be signalled by hue alone. The glyph makes
// the escalation readable without colour, per the non-colour-accessibility rule.
function contextMark(pct: number, glyphs: IconGlyphs): string {
	return pct >= CONTEXT_WARN_PCT ? `${glyphs.blocked} ` : "";
}

// yolo / bypassPermissions disable approval prompts entirely. Red text alone is
// not enough for a safety-relevant state.
const UNSAFE_APPROVAL_MODES = new Set(["yolo", "bypasspermissions"]);

function approvalMode(status: ExtensionStatusSegment): string {
	return status.text.replace(/^APPROVAL\s+/i, "").trim().toLowerCase();
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
	const mode = approvalMode(status);
	if (UNSAFE_APPROVAL_MODES.has(mode)) return "error";
	if (mode === "dontask") return "warning";
	if (mode === "acceptedits") return "success";
	if (mode === "plan") return "accent";
	return "text";
}

const HIDDEN_EXTENSION_STATUS_KEYS = new Set(["team-swarm", "swarm-best"]);

function isVisibleExtensionStatus(status: ExtensionStatusSegment, thinking?: string): boolean {
	if (status.text === "" || status.text === thinking) return false;
	if (HIDDEN_EXTENSION_STATUS_KEYS.has(status.key)) return false;
	return !/^(?:TEAM SWARM\b|BEST\b|COMPLETED$|ACT$)/i.test(status.text.trim());
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
	// minWidth keeps a glyph-prefixed segment from decaying into "{icon}…", which
	// costs columns and tells the user nothing about the path or branch.
	const labelled = (glyph: string, value: string, priority: number, color: ThemeColor): PrioritizedSegment => ({
		text: `${theme.fg(color, glyph)} ${theme.fg(color, value)}`,
		priority,
		minWidth: utils.measure(glyph) + 1 + utils.measure(g.ellipsis) + 3,
	});
	const leftParts: PrioritizedSegment[] = [{
		text: `${theme.fg("accent", g.model)} ${theme.fg("accent", p.model)}`,
		priority: 5,
		minWidth: utils.measure(g.model) + 1 + utils.measure(g.ellipsis) + 3,
	}];
	if (p.thinking && p.thinking !== "off") {
		leftParts.push({ text: theme.fg("muted", p.thinking), priority: 4, clippable: false });
	}
	if (p.cwd) leftParts.push(labelled(g.workspace, p.cwd, 0, "syntaxFunction"));
	if (p.git) leftParts.push(labelled(g.git, p.git, 3, "syntaxFunction"));

	let right1 = "";
	if (p.ctxWindow > 0) {
		// A contextWindow that under-reports the live token count (custom providers
		// do this) previously printed e.g. "137%" beside a bar clamped at full.
		const shownPct = Math.min(100, Math.round(p.ctxPct));
		const pctText = theme.fg(
			contextColor(p.ctxPct),
			`${contextMark(p.ctxPct, g)}${shownPct}%`,
		);
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
	const identitySeparator = ` ${sep} `;
	const fittedLeft = fitSegmentsByPriority(
		leftParts,
		availLeft,
		utils.measure,
		utils.clip,
		g.ellipsis,
		utils.measure(identitySeparator),
	);
	const line1 = alignRight(fittedLeft.join(identitySeparator), right1, width, utils.measure);

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
	const fittedStats = fitSegmentsByPriority(
		stats,
		width,
		utils.measure,
		utils.clip,
		g.ellipsis,
		utils.measure(statSeparator),
	);
	const right2 = fittedStats.join(statSeparator);
	const line2 = right2;

	const lines = [utils.clip(line1, width, ell), utils.clip(line2, width, ell)];
	if (p.workflowStatus) {
		lines.push(utils.clip(theme.fg("muted", p.workflowStatus), width, ell));
	}
	const statuses = (p.extensionStatuses ?? []).filter((status) => isVisibleExtensionStatus(status, p.thinking));
	if (statuses.length > 0) {
		const statusSeparator = ` ${sep} `;
		const fittedStatuses = fitSegmentsByPriority(
			statuses.map((status, index) => {
				const unsafe = status.key === "approval-mode" && UNSAFE_APPROVAL_MODES.has(approvalMode(status));
				return {
					text: theme.fg(extensionStatusColor(status), `${unsafe ? `${g.blocked} ` : ""}${status.text}`),
					// An unsafe approval mode must never be the segment that gets dropped.
					priority: unsafe ? statuses.length + 1 : statuses.length - index,
					clippable: !unsafe,
				};
			}),
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
