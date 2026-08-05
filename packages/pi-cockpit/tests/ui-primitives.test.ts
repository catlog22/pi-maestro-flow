import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fit, frame, headerLine, helpLine, pad, rule, type FrameTheme } from "../src/settings/ui-primitives.ts";

// Identity theme: returns values unchanged, so width math stays deterministic.
const plain: FrameTheme = {
	fg: (_role: string, value: string) => value,
	bold: (value: string) => value,
};

test("fit truncates to visible width with an ellipsis", () => {
	// truncateToWidth wraps the ellipsis in an ANSI reset; visible width is 4.
	const truncated = fit("abcdef", 4);
	assert.equal(visibleWidth(truncated), 4);
	assert.ok(truncated.startsWith("abc"));
	assert.ok(truncated.includes("…"));
	assert.equal(fit("abc", 4), "abc");
	assert.equal(fit("abc", 0), "");
});

test("fit counts visible width (CJK) not code units", () => {
	const truncated = fit("压缩设置", 4);
	assert.ok(visibleWidth(truncated) <= 4, "truncated output must not exceed the width budget");
	assert.ok(truncated.startsWith("压"));
	assert.equal(fit("压缩设置", 8), "压缩设置");
});

test("pad right-pads to the exact visible width", () => {
	const padded = pad("ab", 4);
	assert.equal(padded, "ab  ");
	assert.equal(visibleWidth(padded), 4);
	assert.equal(visibleWidth(pad("abcdef", 4)), 4);
});

test("rule repeats the divider to the requested width", () => {
	assert.equal(rule(4), "────");
	assert.equal(rule(0), "");
});

test("frame wraps rows with dim border and customMessageBg background", () => {
	const calls: Array<{ kind: "fg" | "bg"; role: string; value: string }> = [];
	const theme: FrameTheme = {
		fg: (role, value) => { calls.push({ kind: "fg", role, value }); return value; },
		bold: (value) => value,
		bg: (role, value) => { calls.push({ kind: "bg", role, value }); return value; },
	};
	const rows = frame(["one", "two"], 10, theme);
	assert.equal(rows.length, 4);
	assert.equal(rows[0], "┌────────┐");
	assert.equal(rows[1], "│one     │");
	assert.equal(rows[2], "│two     │");
	assert.equal(rows[3], "└────────┘");
	const dimCalls = calls.filter((call) => call.kind === "fg" && call.role === "dim");
	assert.ok(dimCalls.length >= 2, "border lines must be rendered with the dim role");
	const bgCalls = calls.filter((call) => call.kind === "bg" && call.role === "customMessageBg");
	assert.ok(bgCalls.length >= 4, "every frame line must use the customMessageBg background");
});

test("frame truncates content rows to the inner width", () => {
	const rows = frame(["12345678901234567890"], 8, plain);
	assert.equal(visibleWidth(rows[1]!), 8);
	assert.ok(rows[1]!.startsWith("│12345"));
});

test("frame below width 2 falls back to plain fitting", () => {
	const rows = frame(["abcdef"], 1, plain);
	assert.equal(visibleWidth(rows[0]!), 1);
});

test("frame without background support falls back to plain rows", () => {
	const rows = frame(["x"], 4, plain);
	assert.equal(rows[0], "┌──┐");
	assert.equal(rows[1], "│x │");
});

test("headerLine joins non-empty segments after the bold title", () => {
	assert.equal(headerLine(plain, "Settings", ["zh-CN", "clean", ""], 40), "Settings · zh-CN · clean");
	assert.equal(headerLine(plain, "Settings", [], 40), "Settings");
	assert.equal(visibleWidth(headerLine(plain, "Settings", ["clean"], 8)), 8);
});

test("headerLine bolds the title through the theme", () => {
	const theme: FrameTheme = { fg: (_r, v) => v, bold: (v) => `*${v}*` };
	assert.equal(headerLine(theme, "Settings", ["clean"], 40), "*Settings* · clean");
});

test("helpLine renders a dimmed truncated line", () => {
	const theme: FrameTheme = { fg: (role, value) => role === "dim" ? value : value, bold: (v) => v };
	assert.equal(helpLine(theme, "help text", 40), "help text");
	assert.equal(visibleWidth(helpLine(theme, "1234567890", 5)), 5);
});
