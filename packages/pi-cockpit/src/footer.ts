import type { Theme } from "@earendil-works/pi-coding-agent";

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
}

export interface FooterParts {
	model: string;
	provider?: string;
	ctxPct: number;
	ctxTokens: number;
	ctxWindow: number;
	totals: UsageTotals;
	git?: string;
	elapsed: string;
	width: number;
	ascii: boolean;
	theme: PaintTheme;
	utils: WidthUtils;
}

export function emptyTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

// Sum assistant-message usage across session entries (shape: entry.message.usage).
export function getUsageTotals(entries: readonly unknown[]): UsageTotals {
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
		}
	}
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

export function renderBar(pct: number, barWidth: number, ascii: boolean, theme: PaintTheme): string {
	const w = Math.max(0, barWidth);
	const clamped = Math.max(0, Math.min(100, pct));
	const filled = Math.max(0, Math.min(w, Math.round((clamped / 100) * w)));
	const empty = w - filled;
	const f = ascii ? "#" : "█";
	const e = ascii ? "-" : "░";
	return theme.fg("dim", "[") + theme.fg("accent", f.repeat(filled)) + theme.fg("dim", e.repeat(empty)) + theme.fg("dim", "]");
}

function alignRight(left: string, right: string, width: number, measure: WidthUtils["measure"]): string {
	if (right === "") return left;
	const lw = measure(left);
	const rw = measure(right);
	if (lw + rw + 1 >= width) return left; // overflow: drop right, outer clip trims left
	return left + " ".repeat(width - lw - rw) + right;
}

export function renderFooter(p: FooterParts): string[] {
	const { width, theme, ascii, utils } = p;
	if (width <= 0) return [""];
	const ell = theme.fg("dim", "…");

	// line 1: git branch (left) · context gauge (right)
	let left1 = "";
	if (p.git) left1 = `${theme.fg("mdLink", ascii ? "*" : "⎇")} ${theme.fg("accent", p.git)}`;
	let right1 = "";
	if (p.ctxWindow > 0) {
		const pctText = theme.fg("text", `${Math.round(p.ctxPct)}%`);
		const tokText = `${theme.fg("text", fmtTokens(p.ctxTokens))}${theme.fg("dim", "/")}${theme.fg("text", fmtTokens(p.ctxWindow))}`;
		const reserved = utils.measure(pctText) + utils.measure(tokText) + 6;
		const barW = Math.max(4, Math.min(12, width - reserved - utils.measure(left1) - 1));
		right1 = `${renderBar(p.ctxPct, barW, ascii, theme)} ${pctText} ${theme.fg("dim", "·")} ${tokText}`;
	}
	const line1 = alignRight(left1, right1, width, utils.measure);

	// line 2: model (left) · in/out/cost/elapsed (right)
	const modelLeft = p.provider
		? `${theme.fg("muted", p.provider)}${theme.fg("dim", "/")} ${theme.fg("text", p.model)}`
		: theme.fg("text", p.model);
	const t = p.totals;
	const right2 = [
		`${theme.fg("accent", "↑")}${fmtTokens(t.input)}`,
		`${theme.fg("success", "↓")}${fmtTokens(t.output)}`,
		`${theme.fg("warning", "$")}${t.cost.toFixed(2)}`,
		theme.fg("muted", p.elapsed),
	].join(` ${theme.fg("dim", "·")} `);
	const line2 = alignRight(modelLeft, right2, width, utils.measure);

	return [utils.clip(line1, width, ell), utils.clip(line2, width, ell)];
}
