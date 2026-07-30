import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { setQuietMode } from "../src/quiet-state.ts";
import { createLspTool } from "../src/tools/lsp-tool.ts";
import { toolCallLine, toolResultLine } from "../src/quiet-render.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

afterEach(() => setQuietMode(false, "check"));

function lines(component: { render(width: number): string[] }): string[] {
	return component.render(200).map((line) => line.trimEnd());
}

test("toolCallLine renders one running row with the tool name and arguments", () => {
	assert.deepEqual(lines(toolCallLine(theme, "lsp", "diagnostics sample.ts:1")), [
		"  … lsp diagnostics sample.ts:1",
	]);
});

test("toolResultLine renders one completed row with arguments and summary", () => {
	assert.deepEqual(lines(toolResultLine(theme, {
		name: "lsp",
		ok: true,
		arg: "diagnostics sample.ts:1",
		summary: "LSP: OK",
	})), ["  ✓ lsp diagnostics sample.ts:1 · LSP: OK"]);
});

test("quiet renderers follow Cockpit's dot symbol mode", () => {
	setQuietMode(true, "dot");
	assert.deepEqual(lines(toolCallLine(theme, "lsp", "diagnostics sample.ts:1")), [
		"  ○ lsp diagnostics sample.ts:1",
	]);
	assert.deepEqual(lines(toolResultLine(theme, {
		name: "lsp",
		ok: true,
		summary: "LSP: OK",
	})), ["  ● lsp · LSP: OK"]);
	assert.deepEqual(lines(toolResultLine(theme, {
		name: "lsp",
		ok: false,
		summary: "failed",
	})), ["  ! lsp · failed"]);
});

test("toolResultLine appends detail only when expanded", () => {
	const options = {
		name: "lsp",
		ok: true,
		arg: "diagnostics sample.ts:1",
		summary: "2 diagnostics",
		detail: "first diagnostic\nsecond diagnostic",
	};
	assert.equal(lines(toolResultLine(theme, options)).length, 1);
	assert.deepEqual(lines(toolResultLine(theme, { ...options, expanded: true })), [
		"  ✓ lsp diagnostics sample.ts:1 · 2 diagnostics",
		"first diagnostic",
		"second diagnostic",
	]);
});

test("lsp call and result renderers are mutually exclusive and settle to one row", () => {
	const tool = createLspTool();
	assert.equal(tool.renderShell, "self");
	assert.ok(tool.renderCall);
	assert.ok(tool.renderResult);
	const args = { action: "diagnostics", file: "sample.ts", line: 1 };
	const renderCall = tool.renderCall as unknown as (
		args: typeof args,
		theme: typeof theme,
		context?: { isPartial?: boolean; args: typeof args },
	) => { render(width: number): string[] };
	const renderResult = tool.renderResult as unknown as (
		result: { content: Array<{ type: "text"; text: string }>; isError: boolean },
		options: { expanded: boolean; isPartial: boolean },
		theme: typeof theme,
		context: { args: typeof args },
	) => { render(width: number): string[] };

	assert.deepEqual(lines(renderCall(args, theme, { isPartial: true, args })), [
		"  … lsp diagnostics sample.ts:1",
	]);
	assert.deepEqual(lines(renderCall(args, theme, { isPartial: false, args })), []);
	assert.deepEqual(lines(renderResult(
		{ content: [{ type: "text", text: "LSP: OK" }], isError: false },
		{ expanded: false, isPartial: false },
		theme,
		{ args },
	)), ["  ✓ lsp diagnostics sample.ts:1 · LSP: OK"]);
});
