import assert from "node:assert/strict";
import test from "node:test";
import { registerQuietTools } from "../src/quiet-tools.ts";
import { DEFAULT_CONFIG, type CockpitConfig } from "../src/types.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

function install(getConfig: () => CockpitConfig): Map<string, any> {
	const tools = new Map<string, any>();
	registerQuietTools({
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
	} as never, getConfig);
	return tools;
}

function line(component: { render(width: number): string[] }): string {
	return component.render(200)[0].trimEnd();
}

function renderCall(tool: any, args: Record<string, unknown>): string {
	return line(tool.renderCall(args, theme, { args, isPartial: true }));
}

function renderResult(
	tool: any,
	args: Record<string, unknown>,
	text: string,
	isError = false,
): string {
	return line(tool.renderResult(
		{ content: [{ type: "text", text }], isError },
		{ expanded: false, isPartial: false },
		theme,
		{ args, isError },
	));
}

test("check symbols render compact unpadded tool rows", () => {
	const tools = install(() => ({ ...DEFAULT_CONFIG, quietSymbols: "check", icons: { mode: "nerd" } }));
	const bash = tools.get("bash");
	assert.equal(renderCall(bash, { command: "npm test" }), "  … bash npm test");
	assert.equal(renderResult(bash, { command: "npm test" }, "exit code: 0\npassed"), "  ✓ bash npm test · 0 · 2L");
	assert.equal(renderResult(bash, { command: "npm test" }, "exit code: 1\nfailed"), "  ✕ bash npm test · 1 · 2L");
});

test("dot symbols switch live without re-registering tools", () => {
	let config: CockpitConfig = { ...DEFAULT_CONFIG, quietSymbols: "check", icons: { mode: "nerd" } };
	const tools = install(() => config);
	const bash = tools.get("bash");
	config = { ...config, quietSymbols: "dot" };
	assert.equal(renderCall(bash, { command: "npm test" }), "  ○ bash npm test");
	assert.equal(renderResult(bash, { command: "npm test" }, "exit code: 0"), "  ● bash npm test · 0 · 1L");
	assert.equal(renderResult(bash, { command: "npm test" }, "exit code: 1"), "  ! bash npm test · 1 · 1L");
});

test("both symbol modes have an ASCII fallback", () => {
	let config: CockpitConfig = { ...DEFAULT_CONFIG, quietSymbols: "check", icons: { mode: "ascii" } };
	const tools = install(() => config);
	const bash = tools.get("bash");
	assert.equal(renderCall(bash, { command: "pwd" }), "  ... bash pwd");
	assert.match(renderResult(bash, { command: "pwd" }, "exit code: 0"), /^  \+ bash/);
	assert.match(renderResult(bash, { command: "pwd" }, "exit code: 1"), /^  x bash/);

	config = { ...config, quietSymbols: "dot" };
	assert.equal(renderCall(bash, { command: "pwd" }), "  o bash pwd");
	assert.match(renderResult(bash, { command: "pwd" }, "exit code: 0"), /^  \* bash/);
	assert.match(renderResult(bash, { command: "pwd" }, "exit code: 1"), /^  ! bash/);
});

test("search and file summaries use compact units", () => {
	const tools = install(() => ({ ...DEFAULT_CONFIG, quietSymbols: "check", icons: { mode: "nerd" } }));
	assert.equal(
		renderResult(tools.get("grep"), { pattern: "quiet", path: "src" }, "one\ntwo"),
		"  ✓ grep quiet @ src · 2M",
	);
	assert.equal(
		renderResult(tools.get("find"), { pattern: "*.ts", path: "src" }, "a.ts\nb.ts"),
		"  ✓ find *.ts @ src · 2F",
	);
});
