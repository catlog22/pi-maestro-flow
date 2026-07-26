import assert from "node:assert/strict";
import test from "node:test";
import { renderBashBgSummary } from "../src/bash-bg-widget.ts";
import { resolveGlyphs } from "../src/icons.ts";
import type { PaintTheme, WidthUtils } from "../src/render.ts";
import type { BashBgJob } from "../src/types.ts";

const theme: PaintTheme = { fg: (_color, text) => text };
const utils: WidthUtils = {
	measure: (text) => [...text].length,
	clip: (text, width, ellipsis) => [...text].length <= width
		? text
		: [...text].slice(0, Math.max(0, width - [...ellipsis].length)).join("") + ellipsis,
};
const options = { glyphs: resolveGlyphs("ascii"), spin: "*", now: 12_000 };

function running(overrides: Partial<BashBgJob> = {}): BashBgJob {
	return {
		id: "bg-1",
		command: "npm run dev",
		cwd: "/workspace",
		pid: 123,
		status: "running",
		startedAt: 2_000,
		updatedAt: 11_000,
		exitCode: null,
		outputTail: "ready\nhttp://localhost:3000\n",
		outputBytes: 42,
		logPath: "/tmp/bg-1.log",
		...overrides,
	};
}

test("summary shows active count, duration, command, latest output and detail shortcut", () => {
	const line = renderBashBgSummary(
		[running({ id: "bg-2", startedAt: 4_000 }), running()],
		160,
		theme,
		utils,
		options,
	)[0];
	assert.match(line, /BG/);
	assert.match(line, /2 running/);
	assert.match(line, /8s/);
	assert.match(line, /bg-2/);
	assert.match(line, /npm run dev/);
	assert.match(line, /http:\/\/localhost:3000/);
	assert.match(line, /Alt\+J details/);
});

test("summary distinguishes stopping jobs and hides terminal-only history", () => {
	const stopping = renderBashBgSummary(
		[running({ status: "stopping" })],
		100,
		theme,
		utils,
		options,
	)[0];
	assert.match(stopping, /1 stopping/);

	const terminal = running({ status: "failed", finishedAt: 10_000, exitCode: 1 });
	assert.deepEqual(renderBashBgSummary([terminal], 100, theme, utils, options), []);
});

test("summary is bounded for narrow widths and multiline commands", () => {
	for (const width of [1, 8, 16, 24, 40]) {
		const lines = renderBashBgSummary([
			running({
				command: `node -e\n\u001b]0;unsafe\u0007${"很长".repeat(30)}`,
				outputTail: "\u001b[31mready\u001b[0m",
			}),
		], width, theme, utils, options);
		assert.equal(lines.length, 1);
		assert.ok(utils.measure(lines[0]) <= width, `w=${width}: ${lines[0]}`);
		assert.doesNotMatch(lines[0], /\n/);
		assert.doesNotMatch(lines[0], /\u001b/);
	}
});
