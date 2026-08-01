import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { IconGlyphs } from "./icons.ts";
import { fitLineByPriority, type PrioritizedSegment } from "./layout.ts";
import { formatDuration, type PaintTheme, type WidthUtils } from "./render.ts";
import type { BashBgJob } from "./types.ts";

// Registered by cockpit itself (index.ts), so this hint is always accurate.
export const DEFAULT_BASH_BG_HINT = "Alt+J";

export interface BashBgRenderOptions {
	glyphs: IconGlyphs;
	spin: string;
	now: number;
	/** Overrides the advertised overlay shortcut when the binding differs. */
	hint?: string;
	/** Static mode: drop the live elapsed on running/stopping jobs. */
	hideLiveDuration?: boolean;
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
	const g = options.glyphs;
	const counts = [
		running ? `${running} running` : "",
		stopping ? `${stopping} stopping` : "",
	].filter(Boolean).join(g.separator);
	const statusColor: ThemeColor = stopping > 0 ? "warning" : "accent";
	const segments: PrioritizedSegment[] = [
		{
			text: theme.fg(statusColor, current.status === "stopping" ? g.blocked : options.spin),
			priority: 100,
			clippable: false,
		},
		{ text: theme.fg("muted", "BG"), priority: 95, clippable: false },
		{ text: theme.fg(statusColor, counts), priority: 90, clippable: false },
	];
	if (!options.hideLiveDuration) {
		const elapsed = formatDuration(options.now - current.startedAt);
		segments.push({ text: theme.fg("dim", elapsed), priority: 80, clippable: false });
	}
	segments.push({ text: theme.fg("dim", `${options.hint ?? DEFAULT_BASH_BG_HINT} details`), priority: 70, clippable: false });
	return [fitLineByPriority(segments, width, utils, theme.fg("dim", g.separator), g.ellipsis)];
}
