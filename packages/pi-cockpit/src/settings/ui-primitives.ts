import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Minimal theme surface shared by the Maestro settings shell and the legacy
 * settings TUIs that adopt its visual language. Satisfied by both the pi-tui
 * Theme and the per-overlay theme objects used inside pi-maestro-flow.
 */
export interface FrameTheme {
	fg(role: string, text: string): string;
	bold(text: string): string;
	bg?(role: string, text: string): string;
}

/** Truncate a value to the given visible width, appending an ellipsis. */
export function fit(value: string, width: number): string {
	return truncateToWidth(value, Math.max(0, width), "…");
}

/** Truncate to width and right-pad with spaces up to the exact visible width. */
export function pad(value: string, width: number): string {
	const fitted = fit(value, width);
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

/** Horizontal divider line. */
export function rule(width: number): string {
	return "─".repeat(Math.max(0, width));
}

/**
 * Draws a framed overlay box using the shared visual language: dim border
 * lines with the customMessageBg background. Adopted by every settings TUI so
 * that shell and overlay surfaces render identically.
 */
export function frame(rows: readonly string[], width: number, theme: FrameTheme): string[] {
	if (width < 2) return rows.map((row) => fit(row, width));
	const inner = width - 2;
	const background = (value: string): string => theme.bg?.("customMessageBg", value) ?? value;
	return [
		background(theme.fg("dim", `┌${"─".repeat(inner)}┐`)),
		...rows.map((row) => background(`${theme.fg("dim", "│")}${pad(row, inner)}${theme.fg("dim", "│")}`)),
		background(theme.fg("dim", `└${"─".repeat(inner)}┘`)),
	];
}

/**
 * Header line in the shared `title · segment · segment` shape. Empty segments
 * are skipped so callers can pass optional state segments without fiddling.
 */
export function headerLine(theme: FrameTheme, title: string, segments: readonly string[], width: number): string {
	const rest = segments.filter((segment) => segment.length > 0);
	const line = rest.length > 0 ? `${theme.bold(title)} · ${rest.join(" · ")}` : theme.bold(title);
	return fit(line, Math.max(0, width));
}

/** Dimmed help/footer line, truncated to width. */
export function helpLine(theme: FrameTheme, text: string, width: number): string {
	return theme.fg("dim", fit(text, Math.max(0, width)));
}
