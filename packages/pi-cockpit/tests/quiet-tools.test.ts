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

test("tool palette re-maps tool name colours by operation family", () => {
	// bold wraps the name in a sentinel so fg can tell the tool name apart from
	// the mark/arg/summary and record which colour slot it was painted with.
	const colorTheme = {
		bold: (text: string) => `\x01${text}\x01`,
		fg: (name: string, text: string) =>
			text.startsWith("\x01") ? `${name}:${text.replaceAll("\x01", "")}` : text,
	};
	const args = { command: "x", pattern: "x", path: "." };
	const cases: Array<[CockpitConfig["toolPalette"], string, string]> = [
		["classic", "bash", "syntaxFunction"],
		["classic", "grep", "syntaxKeyword"],
		["family", "grep", "syntaxType"],
		["family", "edit", "syntaxKeyword"],
		["family", "bash", "syntaxString"],
		["readwrite", "bash", "syntaxVariable"],
		["search", "grep", "syntaxString"],
		["search", "read", "syntaxType"],
		["mono", "read", "syntaxComment"],
		["mono", "edit", "toolOutput"],
		["mono", "bash", "text"],
	];
	for (const [palette, tool, slot] of cases) {
		const tools = install(() => ({
			...DEFAULT_CONFIG,
			quietSymbols: "check",
			icons: { mode: "nerd" },
			toolPalette: palette,
		}));
		const rendered = line(tools.get(tool).renderCall(args, colorTheme, { args, isPartial: true }));
		assert.ok(
			rendered.includes(`${slot}:${tool}`),
			`${palette}/${tool} expected slot ${slot}, rendered: ${rendered}`,
		);
	}
});

test("an unknown palette falls back to the classic colour map", () => {
	const colorTheme = {
		bold: (text: string) => `\x01${text}\x01`,
		fg: (name: string, text: string) =>
			text.startsWith("\x01") ? `${name}:${text.replaceAll("\x01", "")}` : text,
	};
	const args = { command: "x" };
	const tools = install(() => ({
		...DEFAULT_CONFIG,
		quietSymbols: "check",
		icons: { mode: "nerd" },
		toolPalette: "nope" as CockpitConfig["toolPalette"],
	}));
	const rendered = line(tools.get("bash").renderCall(args, colorTheme, { args, isPartial: true }));
	assert.ok(rendered.includes("syntaxFunction:bash"), rendered);
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
