// Shared bash-style compact rendering for quiet mode.
//
// When cockpit quiet mode is on, every flow-owned tool collapses to a single
// line mirroring cockpit's built-in bash compression:
//   running: "  ⋯ <name> <arg>"
//   done:    "  ✓ <name> <summary>"   (or ✗ on error)
// Renderers add a one-line `if (isQuietMode()) return quietToolCall/Result(...)`.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// A structural subset of pi's Theme so both the real Theme and the MCP renderer's
// local RenderTheme (string-keyed fg) satisfy it without contravariance errors.
export type QuietTheme = Pick<Theme, "fg"> & Partial<Pick<Theme, "bold">>;

interface ResultLike {
	content: Array<{ type: string; text?: string }>;
}

function boldName(theme: QuietTheme, name: string): string {
	return theme.bold ? theme.bold(name) : name;
}

// Shared one-line shell: two spaces + an already-colored glyph + bold name +
// muted rest. Exported so tools that need a third mark state (e.g. bash-bg's
// running •, which is neither ✓ nor ✗) can compose it directly instead of
// forcing a boolean into quietToolResult.
export function quietToolLine(mark: string, theme: QuietTheme, name: string, rest: string): Text {
	const parts = [name ? theme.fg("toolTitle", boldName(theme, name)) : "", rest ? theme.fg("muted", rest) : ""].filter(Boolean);
	return new Text(`  ${mark} ${parts.join(" ")}`, 0, 0);
}

/** Compact single-line "tool is running" component: `  ⋯ <name> <arg>`. */
export function quietToolCall(theme: QuietTheme, name: string, arg = ""): Text {
	return quietToolLine(theme.fg("warning", "⋯"), theme, name, arg);
}

/** Compact single-line "tool finished" component: `  ✓/✗ <name> <summary>`. */
export function quietToolResult(theme: QuietTheme, name: string, ok: boolean, summary = ""): Text {
	return quietToolLine(ok ? theme.fg("success", "✓") : theme.fg("error", "✗"), theme, name, summary);
}

/** First non-empty line of a tool result's text content, truncated to maxLen. */
export function resultFirstLine(result: ResultLike, maxLen = 60): string {
	const text = result.content.find((c) => c.type === "text" && c.text)?.text ?? "";
	const line = (text.split("\n").find((l) => l.trim()) ?? "").trim();
	return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
}

/** Count of non-empty lines in a tool result's text content. */
export function resultLineCount(result: ResultLike): number {
	const text = result.content.find((c) => c.type === "text" && c.text)?.text ?? "";
	return text.split("\n").filter((l) => l.trim()).length;
}

/**
 * Generic result summary: a short first line, falling back to a line count.
 * Keeps any tool's quiet result line meaningful without per-tool logic.
 */
export function resultSummary(result: ResultLike, maxLen = 60): string {
	const first = resultFirstLine(result, maxLen);
	if (first) return first;
	const n = resultLineCount(result);
	return n > 0 ? `${n} lines` : "done";
}

/** One-line compact JSON of a value, whitespace-collapsed and truncated. For quiet call args. */
export function compactJson(value: unknown, maxLen = 50): string {
	let s: string;
	try {
		s = typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		s = String(value);
	}
	if (s === undefined || s === "null") return "";
	s = s.replace(/\s+/g, " ").trim();
	return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}
