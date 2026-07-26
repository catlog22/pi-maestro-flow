import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { sanitizeExtensionStatusText } from "./extension-status.ts";
import { formatDuration } from "./render.ts";
import type { BashBgJob, BashBgStatus } from "./types.ts";

export interface BashBgOverlayParams {
	getJobs: () => readonly BashBgJob[];
	requestRender: () => void;
	requestRefresh: () => void;
	close: () => void;
	theme: Theme;
}

type BashBgOverlayMode = "list" | "detail";

export class BashBgOverlay implements Component, Focusable {
	focused = false;
	private mode: BashBgOverlayMode = "list";
	private selected = 0;
	private selectedId: string | undefined;

	constructor(private readonly params: BashBgOverlayParams) {}

	invalidate(): void {}
	dispose(): void {}

	handleInput(data: string): void {
		if (data === "\x1b") {
			if (this.mode === "detail") this.mode = "list";
			else this.params.close();
			this.params.requestRender();
			return;
		}
		if (data === "\x1b[A" || data === "k") {
			this.move(-1);
			return;
		}
		if (data === "\x1b[B" || data === "j") {
			this.move(1);
			return;
		}
		if (data === "\r" || data === "\n") {
			if (this.selectedJob()) this.mode = this.mode === "detail" ? "list" : "detail";
			this.params.requestRender();
			return;
		}
		if (data === "r") {
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
		const text = job ? `${jobVisual(job.status).glyph} ${this.orderOf(job)} ${job.status} · Esc` : "BG · none · Esc";
		return this.params.theme.bg("customMessageBg", pad(text, width));
	}

	private renderList(width: number): string[] {
		const inner = width - 2;
		const jobs = this.jobs();
		const rows = [this.header(inner), this.separator(inner)];
		const selectedRows = new Set<number>();
		if (jobs.length === 0) {
			rows.push(fitLine("○ no background jobs · use bash_bg action=start", inner));
		} else {
			const start = visibleStart(this.selected, jobs.length, 8);
			for (let index = start; index < Math.min(jobs.length, start + 8); index++) {
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
		const start = visibleStart(this.selected, jobs.length, 8);
		const left = jobs.slice(start, start + 8).map((job, offset) =>
			this.jobRow(job, start + offset === this.selected, leftWidth));
		const right = this.detailLines(this.selectedJob(), rightWidth, 2, 5);
		const rowCount = Math.max(left.length, right.length, 1);
		const rows = [this.header(inner), this.separator(inner)];
		const selectedRows = new Set<number>();
		for (let index = 0; index < rowCount; index++) {
			if (jobs.length > 0 && start + index === this.selected) selectedRows.add(rows.length);
			rows.push(`${pad(left[index] ?? "", leftWidth)} │ ${pad(right[index] ?? "", rightWidth)}`);
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
			this.helpLine(inner, ["Esc back", "↑↓ job", "r refresh"]),
		];
		return this.card(rows, width);
	}

	private jobRow(job: BashBgJob, selected: boolean, width: number): string {
		const visual = jobVisual(job.status);
		const duration = formatDuration((job.finishedAt ?? Date.now()) - job.startedAt);
		const exit = job.exitCode === null ? "" : ` · exit ${job.exitCode}`;
		return fitLine(
			`${selected ? "›" : " "} ${this.params.theme.fg(visual.color, visual.glyph)} `
			+ `${this.orderOf(job)} · ${job.status} · ${duration}${exit} · ${oneLine(job.command)}`,
			width,
		);
	}

	private detailLines(job: BashBgJob | undefined, width: number, commandMax: number, outputMax: number): string[] {
		if (!job) return [fitLine("○ no background jobs · use bash_bg action=start", width)];
		const visual = jobVisual(job.status);
		const theme = this.params.theme;
		const lines: string[] = [
			fitLine(`${theme.fg(visual.color, theme.bold(`${visual.glyph} ${job.id}`))} · ${job.status}`, width),
			field("PID", String(job.pid), width),
			field("Duration", formatDuration((job.finishedAt ?? Date.now()) - job.startedAt), width),
			field("Started", new Date(job.startedAt).toISOString(), width),
			field("Updated", new Date(job.updatedAt).toISOString(), width),
			field("Exit", job.exitCode === null ? "—" : String(job.exitCode), width),
			field("Output", formatBytes(job.outputBytes), width),
			field("CWD", job.cwd, width),
			field("Log", job.logPath, width),
			fitLine(theme.fg("dim", "Command"), width),
			...wrappedSlice(oneLine(job.command), width, commandMax, theme),
			fitLine(theme.fg("dim", "Output tail"), width),
			...outputSlice(job.outputTail, width, outputMax, theme),
		];
		return lines;
	}

	private header(width: number): string {
		const jobs = this.jobs();
		const running = jobs.filter((job) => job.status === "running").length;
		const stopping = jobs.filter((job) => job.status === "stopping").length;
		const failed = jobs.filter((job) => job.status === "failed").length;
		const done = jobs.length - running - stopping - failed;
		const theme = this.params.theme;
		return fitLine(
			`Background jobs · ${jobs.length} total · ${theme.fg("accent", `${running} running`)} · `
			+ `${theme.fg("warning", `${stopping} stopping`)} · ${theme.fg("error", `${failed} failed`)} · `
			+ `${theme.fg("success", `${done} finished`)}`,
			width,
		);
	}

	private helpLine(width: number, segments = ["Esc close", "Enter detail", "↑↓ job", "r refresh"]): string {
		return fitSegments(width, segments);
	}

	private separator(width: number): string {
		return this.params.theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
	}

	private card(rows: string[], width: number, selectedRows: ReadonlySet<number> = new Set()): string[] {
		const theme = this.params.theme;
		const edge = "─".repeat(Math.max(0, width - 2));
		const border = (glyph: string) => theme.bg("customMessageBg", theme.fg("borderMuted", glyph));
		const out = [border(`╭${edge}╮`)];
		rows.forEach((row, index) => {
			out.push(theme.bg(selectedRows.has(index) ? "selectedBg" : "customMessageBg", pad(` ${row}`, width)));
		});
		out.push(border(`╰${edge}╯`));
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

function jobVisual(status: BashBgStatus): { glyph: string; color: ThemeColor } {
	if (status === "running") return { glyph: "▶", color: "accent" };
	if (status === "stopping") return { glyph: "◐", color: "warning" };
	if (status === "completed") return { glyph: "✓", color: "success" };
	if (status === "failed") return { glyph: "✗", color: "error" };
	return { glyph: "■", color: "warning" };
}

function wrappedSlice(value: string, width: number, max: number, theme: Theme): string[] {
	const wrapped = wrapTextWithAnsi(value || "(empty)", Math.max(10, width));
	const lines = wrapped.slice(0, max).map((line) => fitLine(line, width));
	if (wrapped.length > max) lines.push(fitLine(theme.fg("dim", `… +${wrapped.length - max} more line(s)`), width));
	return lines;
}

function outputSlice(output: string, width: number, max: number, theme: Theme): string[] {
	const rawLines = output.replace(/\r/g, "").split("\n").map(sanitizeExtensionStatusText);
	while (rawLines.length > 0 && rawLines.at(-1) === "") rawLines.pop();
	if (rawLines.length === 0) return [fitLine(theme.fg("dim", "(empty)"), width)];
	const wrapped = rawLines.flatMap((line) => wrapTextWithAnsi(line || " ", Math.max(10, width)));
	const omitted = Math.max(0, wrapped.length - max);
	const lines = wrapped.slice(-max).map((line) => fitLine(line, width));
	if (omitted > 0) lines.unshift(fitLine(theme.fg("dim", `… ${omitted} earlier line(s) · full output at log path`), width));
	return lines;
}

function field(label: string, value: string, width: number): string {
	return fitLine(`${label.padEnd(10)} ${sanitizeExtensionStatusText(value)}`, width);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${trimDecimal(bytes / 1024)} KiB`;
	return `${trimDecimal(bytes / (1024 * 1024))} MiB`;
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

function visibleStart(selected: number, length: number, size: number): number {
	return Math.max(0, Math.min(selected - Math.floor(size / 2), Math.max(0, length - size)));
}

function fitLine(value: string, width: number): string {
	return truncateToWidth(value, Math.max(1, width), "…");
}

function fitSegments(width: number, segments: readonly string[]): string {
	const kept: string[] = [];
	for (const segment of segments) {
		if (visibleWidth([...kept, segment].join(" · ")) > width) break;
		kept.push(segment);
	}
	return kept.length ? kept.join(" · ") : fitLine(segments[0] ?? "", width);
}

function pad(value: string, width: number): string {
	const fitted = fitLine(value, width);
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}
