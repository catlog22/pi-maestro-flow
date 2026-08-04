import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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

function renderCall(tool: any, args: Record<string, unknown>, paint: any = theme): string {
	return line(tool.renderCall(args, paint, { args, isPartial: true }));
}

function renderResult(
	tool: any,
	args: Record<string, unknown>,
	text: string,
	isError = false,
	paint: any = theme,
): string {
	return line(tool.renderResult(
		{ content: [{ type: "text", text }], isError },
		{ expanded: false, isPartial: false },
		paint,
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

test("every tool name uses theme lifecycle colors", () => {
	// Bold wraps the name in a sentinel so fg can distinguish it from the
	// lifecycle glyph, arguments, and summary.
	const colorTheme = {
		bold: (text: string) => `\x01${text}\x01`,
		fg: (name: string, text: string) =>
			text.startsWith("\x01") ? `${name}:${text.replaceAll("\x01", "")}` : text,
	};
	const tools = install(() => ({
		...DEFAULT_CONFIG,
		quietSymbols: "check",
		icons: { mode: "nerd" },
	}));
	const argsByTool: Record<string, Record<string, unknown>> = {
		read: { path: "file.ts" },
		bash: { command: "echo ok" },
		edit: { path: "file.ts" },
		write: { path: "file.ts", content: "ok" },
		find: { pattern: "*.ts", path: "." },
		grep: { pattern: "ok", path: "." },
		ls: { path: "." },
	};

	for (const [name, args] of Object.entries(argsByTool)) {
		const tool = tools.get(name);
		assert.match(renderCall(tool, args, colorTheme), new RegExp(`warning:${name}`));
		assert.match(renderResult(tool, args, "exit code: 0\nok", false, colorTheme), new RegExp(`success:${name}`));
		assert.match(renderResult(tool, args, "failed", true, colorTheme), new RegExp(`error:${name}`));
	}
});

test("legacy tool palette selection no longer changes lifecycle colors", () => {
	const colorTheme = {
		bold: (text: string) => `\x01${text}\x01`,
		fg: (name: string, text: string) =>
			text.startsWith("\x01") ? `${name}:${text.replaceAll("\x01", "")}` : text,
	};
	for (const toolPalette of ["classic", "family", "readwrite", "search", "mono"] as const) {
		const tools = install(() => ({ ...DEFAULT_CONFIG, toolPalette, icons: { mode: "nerd" } }));
		assert.match(renderCall(tools.get("bash"), { command: "x" }, colorTheme), /warning:bash/);
	}
});

test("bundled themes define distinct lifecycle color combinations", () => {
	const themesDir = new URL("../themes/", import.meta.url);
	const files = readdirSync(themesDir).filter((file) => file.endsWith(".json"));
	const combinations = new Set<string>();
	for (const file of files) {
		const themeDoc = JSON.parse(readFileSync(new URL(file, themesDir), "utf8")) as {
			vars: Record<string, string>;
			colors: Record<string, string>;
		};
		const colors = ["warning", "success", "error"].map((slot) => {
			const value = themeDoc.colors[slot];
			return themeDoc.vars[value] ?? value;
		});
		assert.equal(new Set(colors).size, 3, `${file} must distinguish calling, success, and failure`);
		combinations.add(colors.join("|"));
	}
	assert.equal(combinations.size, files.length, "each bundled theme must provide its own lifecycle color combination");
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
