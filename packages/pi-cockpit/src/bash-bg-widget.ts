import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { IconGlyphs } from "./icons.ts";
import { sanitizeExtensionStatusText } from "./extension-status.ts";
import { formatDuration, type PaintTheme, type WidthUtils } from "./render.ts";
import type { BashBgJob } from "./types.ts";

export interface BashBgRenderOptions {
	glyphs: IconGlyphs;
	spin: string;
	now: number;
}

export function renderBashBgSummary(
	jobs: readonly BashBgJob[],
	width: number,
	theme: PaintTheme,
	utils: WidthUtils,
	options: BashBgRenderOptions,
): string[] {
	if (width < 1) return [];
	const active = jobs.filter((job) => job.status === "running" || job.status === "stopping");
	if (active.length === 0) return [];
	const current = active[0];
	const stopping = active.filter((job) => job.status === "stopping").length;
	const running = active.length - stopping;
	const counts = [
		running ? `${running} running` : "",
		stopping ? `${stopping} stopping` : "",
	].filter(Boolean).join(" · ");
	const statusColor: ThemeColor = stopping > 0 ? "warning" : "accent";
	const elapsed = formatDuration(options.now - current.startedAt);
	const preview = lastOutputLine(current.outputTail);
	const segments = [
		theme.fg(statusColor, current.status === "stopping" ? options.glyphs.blocked : options.spin),
		theme.fg("muted", "BG"),
		theme.fg(statusColor, counts),
		theme.fg("dim", elapsed),
		theme.fg("mdLink", current.id),
		theme.fg("text", oneLine(current.command)),
	];
	if (preview) segments.push(theme.fg("dim", `› ${preview}`));
	segments.push(theme.fg("dim", "Alt+J details"));
	return [utils.clip(segments.join(theme.fg("dim", " · ")), width, "…")];
}

function lastOutputLine(output: string): string {
	const lines = output.replace(/\r/g, "").split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index]?.trim();
		if (line) return oneLine(line);
	}
	return "";
}

function oneLine(value: string): string {
	return sanitizeExtensionStatusText(value);
}
