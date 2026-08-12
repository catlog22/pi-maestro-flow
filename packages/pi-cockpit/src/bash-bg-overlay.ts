import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	Key,
	type Component,
	type Focusable,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { sanitizeExtensionStatusText } from "./extension-status.ts";
import type { IconGlyphs } from "./icons.ts";
import { fitLineByPriority, visibleStart, type PrioritizedSegment, type WidthUtils } from "./layout.ts";
import { formatDuration } from "./render.ts";
import type { BashBgJob, BashBgStatus } from "./types.ts";
import { tuiStatus, tuiT } from "./tui-i18n.ts";
import { overlayListRows } from "./viewport.ts";

const WIDTH_UTILS: WidthUtils = { measure: visibleWidth, clip: truncateToWidth };

export interface BashBgOverlayParams {
	getJobs: () => readonly BashBgJob[];
	requestRender: () => void;
	requestRefresh: () => void;
	close: () => void;
	theme: Theme;
	glyphs: IconGlyphs;
	/** Select this job when the overlay first renders. */
	initialJobId?: string;
	/** Wall-clock snapshot supplied by the owner and advanced through tick(). */
	now: number;
	/** Live terminal height, so the card can use the space it already reserves. */
	getTerminalRows?: () => number | undefined;
	/** Static mode: hide live durations on running/stopping jobs, like the footer line. */
	hideLiveDuration?: boolean;
}

// Rows the card spends on itself: two borders, header, separator, help line.
const CARD_CHROME_ROWS = 5;

// How long the header keeps acknowledging a manual refresh. The snapshot arrives
// asynchronously, so without this the keypress looks like it did nothing. The ack
// must also expire on its own: when the main redraw loop is stopped (static mode)
// no unrelated event may come along to repaint it away.
export const REFRESH_ACK_MS = 1_500;

type BashBgOverlayMode = "list" | "detail";

export class BashBgOverlay implements Component, Focusable {
	focused = false;
	private mode: BashBgOverlayMode = "list";
	private selected = 0;
	private selectedId: string | undefined;
	private now: number;
	private liveTickKey: string;
	private refreshAckExpiresAt = 0;
	private ackTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly params: BashBgOverlayParams) {
		this.now = params.now;
		this.liveTickKey = this.tickKey(params.now);
		this.selectedId = params.initialJobId;
	}

	invalidate(): void {}
	tick(now: number): void {
		const nextKey = this.tickKey(now);
		this.now = now;
		if (nextKey === this.liveTickKey) return;
		this.liveTickKey = nextKey;
		this.params.requestRender();
	}
	dispose(): void {
		if (this.ackTimer) clearTimeout(this.ackTimer);
		this.ackTimer = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			if (this.mode === "detail") this.mode = "list";
			else this.params.close();
			this.params.requestRender();
			return;
		}
		// Plain letters stay reserved for future filter/command modes, so navigation
		// and refresh use arrows and a non-letter key only.
		if (matchesKey(data, Key.up)) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (this.selectedJob()) this.mode = this.mode === "detail" ? "list" : "detail";
			this.params.requestRender();
			return;
		}
		if (data === "\x12" || matchesKey(data, Key.f5)) {
			// Ctrl+R / F5 — refresh is acknowledged immediately even though the
			// authoritative snapshot only arrives later. Schedule the ack's own
			// expiry so it disappears even without any follow-up repaint.
			const now = Date.now();
			this.now = now;
			this.refreshAckExpiresAt = now + REFRESH_ACK_MS;
			if (this.ackTimer) clearTimeout(this.ackTimer);
			const expiresAt = this.refreshAckExpiresAt;
			this.ackTimer = setTimeout(() => {
				this.ackTimer = undefined;
				this.now = Math.max(this.now, expiresAt);
				this.params.requestRender();
			}, REFRESH_ACK_MS);
			this.ackTimer.unref?.();
			this.params.requestRefresh();
			this.params.requestRender();
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.min(width, 140));
		this.clampState();
		if (safeWidth < 20) return [this.renderCompact(safeWidth)];
		if (this.mode === "detail") return this.renderDetail(safeWidth);
		if (safeWidth < 88) return this.renderList(safeWidth);
		return this.renderWide(safeWidth);
	}

	private renderCompact(width: number): string {
		const job = this.selectedJob();
		const text = job
			? `${jobVisual(job.status, this.params.glyphs).glyph} ${this.orderOf(job)} ${tuiStatus(job.status)}${this.params.glyphs.separator}Esc`
			: `BG${this.params.glyphs.separator}${tuiT("overlay.agents.none")}${this.params.glyphs.separator}Esc`;
		return this.params.theme.bg("customMessageBg", pad(text, width));
	}

	// How many job rows the card can show before it has to start paging.
	private listRows(): number {
		return overlayListRows(this.params.getTerminalRows?.(), CARD_CHROME_ROWS);
	}

	private renderList(width: number): string[] {
		const inner = width - 2;
		const jobs = this.jobs();
		const rows = [this.header(inner), this.separator(inner)];
		const selectedRows = new Set<number>();
		if (jobs.length === 0) {
			rows.push(fitLine(this.emptyState(), inner));
		} else {
			const page = this.listRows();
			const start = visibleStart(this.selected, jobs.length, page);
			for (let index = start; index < Math.min(jobs.length, start + page); index++) {
				if (index === this.selected) selectedRows.add(rows.length);
				rows.push(this.jobRow(jobs[index], index === this.selected, inner));
			}
		}
		rows.push(this.helpLine(inner));
		return this.card(rows, width, selectedRows);
	}

	private renderWide(width: number): string[] {
		const inner = width - 2;
		const leftWidth = Math.max(32, Math.floor((inner - 3) * 0.42));
		const rightWidth = inner - leftWidth - 3;
		const jobs = this.jobs();
		const page = this.listRows();
		const start = visibleStart(this.selected, jobs.length, page);
		const left = jobs.slice(start, start + page).map((job, offset) =>
			this.jobRow(job, start + offset === this.selected, leftWidth));
		// The detail pane grows with the list so a tall card is not half empty, but
		// the output tail keeps the larger share — that is what the pane is for.
		const right = this.detailLines(this.selectedJob(), rightWidth, 2, Math.max(5, page - 3));
		const rowCount = Math.max(left.length, right.length, 1);
		const rows = [this.header(inner), this.separator(inner)];
		const selectedRows = new Set<number>();
		for (let index = 0; index < rowCount; index++) {
			if (jobs.length > 0 && start + index === this.selected) selectedRows.add(rows.length);
			rows.push(`${pad(left[index] ?? "", leftWidth)} ${this.params.glyphs.box.vertical} ${pad(right[index] ?? "", rightWidth)}`);
		}
		rows.push(this.helpLine(inner));
		return this.card(rows, width, selectedRows);
	}

	private renderDetail(width: number): string[] {
		const inner = width - 2;
		const rows = [
			this.header(inner),
			this.separator(inner),
			...this.detailLines(this.selectedJob(), inner, 8, 18),
			this.helpLine(
				inner,
				tuiT("overlay.jobs.detailHelp", { keys: this.params.glyphs.upDown }).split("|"),
			),
		];
		return this.card(rows, width);
	}

	private jobRow(job: BashBgJob, selected: boolean, width: number): string {
		const visual = jobVisual(job.status, this.params.glyphs);
		const sep = this.params.glyphs.separator;
		const live = job.status === "running" || job.status === "stopping";
		const duration = this.params.hideLiveDuration && live
			? ""
			: formatDuration((job.finishedAt ?? this.now) - job.startedAt);
		const exit = job.exitCode === null ? "" : `${sep}${tuiT("sidebar.exit", { code: job.exitCode })}`;
		const meta = duration !== "" || exit !== "" ? `${duration}${exit}${sep}` : "";
		return fitLine(
			`${selected ? this.params.glyphs.selectMarker : " "} ${this.params.theme.fg(visual.color, visual.glyph)} `
			+ `${this.orderOf(job)}${sep}${tuiStatus(job.status)}${sep}${meta}${oneLine(job.command)}`,
			width,
		);
	}

	private detailLines(job: BashBgJob | undefined, width: number, commandMax: number, outputMax: number): string[] {
		if (!job) return [fitLine(this.emptyState(), width)];
		const visual = jobVisual(job.status, this.params.glyphs);
		const theme = this.params.theme;
		const live = job.status === "running" || job.status === "stopping";
		const durationField = this.params.hideLiveDuration && live
			? []
			: [field(tuiT("overlay.jobs.field.duration"), formatDuration((job.finishedAt ?? this.now) - job.startedAt), width)];
		const lines: string[] = [
			fitLine(`${theme.fg(visual.color, theme.bold(`${visual.glyph} ${job.id}`))}${this.params.glyphs.separator}${tuiStatus(job.status)}`, width),
			field("PID", String(job.pid), width),
			...durationField,
			field(tuiT("overlay.jobs.field.started"), formatTimestamp(job.startedAt), width),
			field(tuiT("overlay.jobs.field.updated"), formatTimestamp(job.updatedAt), width),
			field(tuiT("overlay.jobs.field.exit"), job.exitCode === null ? this.params.glyphs.dotIdle : String(job.exitCode), width),
			field(tuiT("overlay.jobs.field.output"), formatBytes(job.outputBytes), width),
			field(tuiT("overlay.jobs.field.cwd"), job.cwd, width),
			field(tuiT("overlay.jobs.field.log"), job.logPath, width),
			fitLine(theme.fg("dim", tuiT("overlay.jobs.command")), width),
			...wrappedSlice(oneLine(job.command), width, commandMax, theme),
			fitLine(theme.fg("dim", tuiT("overlay.jobs.outputTail")), width),
			...outputSlice(job.outputTail, width, outputMax, theme),
		];
		return lines;
	}

	private emptyState(): string {
		const g = this.params.glyphs;
		return tuiT("overlay.jobs.empty", { mark: g.emptyMark, separator: g.separator });
	}

	private header(width: number): string {
		const jobs = this.jobs();
		const running = jobs.filter((job) => job.status === "running").length;
		const stopping = jobs.filter((job) => job.status === "stopping").length;
		const failed = jobs.filter((job) => job.status === "failed").length;
		const done = jobs.length - running - stopping - failed;
		const theme = this.params.theme;
		const g = this.params.glyphs;
		// Zero-valued states are suppressed ("0 stopping · 0 failed" is filler), but
		// total stays — it is the denominator that gives the other counts meaning.
		// Priorities keep the refresh acknowledgement and the failure count alive on
		// a narrow overlay; without that the ack was clipped off the end and the
		// keypress looked like it did nothing.
		const segs: PrioritizedSegment[] = [
			{ text: tuiT("overlay.jobs.title"), priority: 60, minWidth: 6 },
			{ text: theme.fg("dim", tuiT("common.total", { count: jobs.length })), priority: 50, clippable: false },
		];
		if (this.now < this.refreshAckExpiresAt) {
			segs.push({ text: theme.fg("dim", tuiT("overlay.jobs.refreshing")), priority: 100, clippable: false });
		}
		if (failed) segs.push({ text: theme.fg("error", tuiT("common.failed", { count: failed })), priority: 90, clippable: false });
		if (stopping) segs.push({ text: theme.fg("warning", tuiT("common.stopping", { count: stopping })), priority: 80, clippable: false });
		if (running) segs.push({ text: theme.fg("accent", tuiT("common.running", { count: running })), priority: 70, clippable: false });
		if (done) segs.push({ text: theme.fg("success", tuiT("common.finished", { count: done })), priority: 40, clippable: false });
		return fitLineByPriority(segs, width, WIDTH_UTILS, g.separator, g.ellipsis);
	}

	private helpLine(width: number, segments?: readonly string[]): string {
		const g = this.params.glyphs;
		return fitSegments(
			width,
			segments ?? tuiT("overlay.jobs.help", { keys: g.upDown }).split("|"),
			g.separator,
		);
	}

	private separator(width: number): string {
		return this.params.theme.fg("borderMuted", this.params.glyphs.box.horizontal.repeat(Math.max(1, width)));
	}

	private card(rows: string[], width: number, selectedRows: ReadonlySet<number> = new Set()): string[] {
		const theme = this.params.theme;
		const box = this.params.glyphs.box;
		const edge = box.horizontal.repeat(Math.max(0, width - 2));
		const border = (glyph: string) => theme.bg("customMessageBg", theme.fg("borderMuted", glyph));
		const out = [border(`${box.topLeft}${edge}${box.topRight}`)];
		rows.forEach((row, index) => {
			out.push(theme.bg(selectedRows.has(index) ? "selectedBg" : "customMessageBg", pad(` ${row}`, width)));
		});
		out.push(border(`${box.bottomLeft}${edge}${box.bottomRight}`));
		return out;
	}

	private move(delta: number): void {
		this.selected = wrapIndex(this.selected + delta, this.jobs().length);
		this.selectedId = this.jobs()[this.selected]?.id;
		this.params.requestRender();
	}

	private clampState(): void {
		const jobs = this.jobs();
		const preserved = this.selectedId === undefined
			? -1
			: jobs.findIndex((job) => job.id === this.selectedId);
		this.selected = preserved >= 0 ? preserved : clampIndex(this.selected, jobs.length);
		this.selectedId = jobs[this.selected]?.id;
	}

	private tickKey(now: number): string {
		return this.jobs()
			.filter((job) => job.status === "running" || job.status === "stopping")
			.map((job) => `${job.id}:${job.status}:${this.params.hideLiveDuration ? "" : formatDuration(now - job.startedAt)}`)
			.join("|");
	}

	private jobs(): readonly BashBgJob[] {
		return this.params.getJobs();
	}

	private selectedJob(): BashBgJob | undefined {
		return this.jobs()[this.selected];
	}

	private orderOf(job: BashBgJob): string {
		const jobs = this.jobs();
		return `${jobs.findIndex((candidate) => candidate.id === job.id) + 1}/${jobs.length}`;
	}
}

// Routed through the resolved glyph set so an ascii-only terminal shows ascii
// rather than tofu. Status text always accompanies the glyph at the call sites,
// so colour never carries the state on its own.
function jobVisual(status: BashBgStatus, g: IconGlyphs): { glyph: string; color: ThemeColor } {
	if (status === "running") return { glyph: g.dotRunning, color: "accent" };
	if (status === "stopping") return { glyph: g.blocked, color: "warning" };
	if (status === "completed") return { glyph: g.check, color: "success" };
	if (status === "failed") return { glyph: g.cross, color: "error" };
	return { glyph: g.dotIdle, color: "warning" };
}

function formatTimestamp(ms: number): string {
	const date = new Date(ms);
	// parseJob only checks Number.isFinite, so an out-of-range timestamp reaches
	// here and would throw RangeError out of the render path.
	return Number.isNaN(date.getTime()) ? tuiT("overlay.jobs.unknown") : date.toISOString();
}

function wrappedSlice(value: string, width: number, max: number, theme: Theme): string[] {
	const wrapped = wrapTextWithAnsi(value || tuiT("common.empty"), Math.max(10, width));
	const lines = wrapped.slice(0, max).map((line) => fitLine(line, width));
	if (wrapped.length > max) {
		lines.push(fitLine(theme.fg("dim", tuiT("overlay.jobs.moreLines", { count: wrapped.length - max })), width));
	}
	return lines;
}

function outputSlice(output: string, width: number, max: number, theme: Theme): string[] {
	const rawLines = output.replace(/\r/g, "").split("\n").map(sanitizeExtensionStatusText);
	while (rawLines.length > 0 && rawLines.at(-1) === "") rawLines.pop();
	if (rawLines.length === 0) return [fitLine(theme.fg("dim", tuiT("common.empty")), width)];
	const wrapped = rawLines.flatMap((line) => wrapTextWithAnsi(line || " ", Math.max(10, width)));
	const omitted = Math.max(0, wrapped.length - max);
	const lines = wrapped.slice(-max).map((line) => fitLine(line, width));
	if (omitted > 0) {
		lines.unshift(fitLine(theme.fg("dim", tuiT("overlay.jobs.earlierLines", { count: omitted })), width));
	}
	return lines;
}

function field(label: string, value: string, width: number): string {
	// pad, not padEnd: the label column must align by display width, so this does
	// not quietly break the day a label stops being pure ASCII.
	return fitLine(`${pad(label, 10)} ${sanitizeExtensionStatusText(value)}`, width);
}

function formatBytes(bytes: number): string {
	// A long-running job can emit gigabytes; without these tiers 5 GiB rendered
	// as "5120 MiB".
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return unit === 0 ? `${value} B` : `${trimDecimal(value)} ${units[unit]}`;
}

function trimDecimal(value: number): string {
	return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}

function oneLine(value: string): string {
	return sanitizeExtensionStatusText(value);
}

function wrapIndex(index: number, length: number): number {
	return length === 0 ? 0 : (index + length) % length;
}

function clampIndex(index: number, length: number): number {
	return length === 0 ? 0 : Math.max(0, Math.min(index, length - 1));
}

function fitLine(value: string, width: number): string {
	return truncateToWidth(value, Math.max(1, width), "…");
}

function fitSegments(width: number, segments: readonly string[], separator: string): string {
	const kept: string[] = [];
	for (const segment of segments) {
		if (visibleWidth([...kept, segment].join(separator)) > width) break;
		kept.push(segment);
	}
	return kept.length ? kept.join(separator) : fitLine(segments[0] ?? "", width);
}

function pad(value: string, width: number): string {
	const fitted = fitLine(value, width);
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}
