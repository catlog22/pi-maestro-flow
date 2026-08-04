// Quiet mode tool rendering: compress each built-in tool call into a single
// ✓/✗/⋯ line. Architecture adapted from pi-quiet (github.com/wing900/pi-quiet):
// a config-driven SPECS table + shared render functions. Execution is delegated
// to the original built-in tools — only the rendering is replaced.
//
// Scope boundary: only the seven built-in tools (read/bash/edit/write/grep/find/ls)
// are compressed. Compression works by re-registering the tool name and delegating
// execution back to pi's exported creators. MCP/extension tools (todo, teammate,
// mcp, lsp, ...) cannot be compressed this way: registerTool is first-name-wins and
// replaces the whole definition, and the public API exposes neither a render-only
// hook nor a handle to the original execute — re-registering them would break their
// execution, so Cockpit does not re-register them. Self-rendering extension
// tools such as `observe` consume Cockpit's quiet ownership event in their owner
// extension and provide their own compact shell.
//
// Registered at session_start when config.quietMode is true. Because tools cannot
// be unregistered, toggling quiet mode off requires /reload or a new session.

import type {
	BashToolDetails,
	EditToolDetails,
	ExtensionAPI,
	ExtensionContext,
	ReadToolDetails,
} from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import type { CockpitConfig, ToolPaletteMode } from "./types.ts";
import { resolveGlyphs, type IconGlyphs } from "./icons.ts";

// ---------- helpers ----------

function shortenPath(p: string): string {
	const home = homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}

function termWidth(): number {
	return process.stdout.columns || 100;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const c = result.content.find((c) => c.type === "text" && c.text);
	return c?.text ?? "";
}

function parseBashExit(output: string): number | null {
	const m = output.match(/exit code: (\d+)/);
	return m ? parseInt(m[1], 10) : null;
}

function firstErrorLine(result: { content: Array<{ type: string; text?: string }> }): string {
	return truncate(textOf(result).split("\n").find((l) => l.trim()) || "error", 60);
}

// ---------- built-in tool cache ----------

type BuiltInTools = ReturnType<typeof createBuiltInTools>;
const toolCache = new Map<string, BuiltInTools>();

function createBuiltInTools(cwd: string) {
	return {
		read: createReadTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		find: createFindTool(cwd),
		grep: createGrepTool(cwd),
		ls: createLsTool(cwd),
	};
}

function getBuiltInTools(cwd: string): BuiltInTools {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = createBuiltInTools(cwd);
		toolCache.set(cwd, tools);
	}
	return tools;
}

// ---------- tool spec ----------

interface ToolSpec {
	name: string;
	/** Key argument shown after the tool name (path / command / pattern). */
	arg: (args: any) => string;
	/** Final compact summary after the separator (for example "12M" or "0 · 3L"). */
	summary: (result: any, ctx: any) => string;
	/** Expanded content; empty string means nothing extra. */
	expanded?: (result: any) => string;
	/** Success predicate; defaults to !ctx.isError. */
	ok?: (result: any, ctx: any) => boolean;
}

const SPECS: ToolSpec[] = [
	{
		name: "read",
		arg: (a) => shortenPath(a.path || ""),
		summary: (r) => {
			const c = r.content[0];
			if (c?.type === "image") return "image";
			const lines = c?.type === "text" ? c.text.split("\n").length : 0;
			const d = r.details as ReadToolDetails | undefined;
			let s = `${lines}L`;
			if (d?.truncation?.truncated) s += `/${d.truncation.totalLines}L`;
			return s;
		},
		expanded: (r) => textOf(r).split("\n").slice(0, 15).join("\n"),
	},
	{
		name: "bash",
		arg: (a) => a.command || "",
		summary: (r) => {
			const out = textOf(r);
			const exit = parseBashExit(out);
			const n = out.split("\n").filter((l: string) => l.trim()).length;
			const d = r.details as BashToolDetails | undefined;
			let s = `${exit ?? "?"} · ${n}L`;
			if (d?.truncation?.truncated) s += " · trunc";
			return s;
		},
		expanded: (r) => textOf(r).split("\n").slice(0, 20).join("\n"),
		ok: (r, ctx) => {
			if (ctx.isError) return false;
			const exit = parseBashExit(textOf(r));
			return exit === null || exit === 0;
		},
	},
	{
		name: "edit",
		arg: (a) => shortenPath(a.path || ""),
		summary: (r, ctx) => {
			if (ctx.isError) return firstErrorLine(r);
			const d = r.details as EditToolDetails | undefined;
			if (!d?.diff) return "applied";
			let add = 0;
			let del = 0;
			for (const line of d.diff.split("\n")) {
				if (line.startsWith("+") && !line.startsWith("+++")) add++;
				if (line.startsWith("-") && !line.startsWith("---")) del++;
			}
			return `+${add}/-${del}`;
		},
		expanded: (r) => {
			const d = r.details as EditToolDetails | undefined;
			return d?.diff ?? textOf(r);
		},
	},
	{
		name: "write",
		arg: (a) => shortenPath(a.path || ""),
		summary: (r, ctx) => {
			if (ctx.isError) return firstErrorLine(r);
			const content = typeof ctx.args?.content === "string" ? ctx.args.content : "";
			return `${content === "" ? 0 : content.split("\n").length}L`;
		},
	},
	{
		name: "find",
		arg: (a) => `${a.pattern || ""} @ ${shortenPath(a.path || ".")}`,
		summary: (r, ctx) => (ctx.isError ? firstErrorLine(r) : `${textOf(r).trim().split("\n").filter(Boolean).length}F`),
		expanded: (r) => textOf(r),
	},
	{
		name: "grep",
		arg: (a) => `${a.pattern || ""} @ ${shortenPath(a.path || ".")}`,
		summary: (r, ctx) => (ctx.isError ? firstErrorLine(r) : `${textOf(r).trim().split("\n").filter(Boolean).length}M`),
		expanded: (r) => textOf(r),
	},
	{
		name: "ls",
		arg: (a) => shortenPath(a.path || "."),
		summary: (r, ctx) => (ctx.isError ? firstErrorLine(r) : `${textOf(r).trim().split("\n").filter(Boolean).length}E`),
		expanded: (r) => textOf(r),
	},
];

// ---------- rendering ----------

// Per-palette tool-name colour slots. Every value is an existing theme slot, so
// a palette needs no new colour definitions and stays correct across themes.
// Grouping is by operation family, not by borrowed syntax-highlighting slots:
// the classic map is kept verbatim so long-time users can switch back to it.
const TOOL_PALETTES: Record<ToolPaletteMode, Record<string, string>> = {
	classic: {
		bash: "syntaxFunction",
		read: "syntaxType",
		ls: "syntaxType",
		grep: "syntaxKeyword",
		find: "syntaxKeyword",
		edit: "syntaxVariable",
		write: "syntaxVariable",
	},
	// inspect = blue, mutate = soft blue, execute = green. Mutate is never pink:
	// syntaxKeyword renders pink in every cockpit theme, identical to the error
	// mark, so a successful edit would read as an error.
	family: {
		read: "syntaxType",
		ls: "syntaxType",
		grep: "syntaxType",
		find: "syntaxType",
		edit: "syntaxVariable",
		write: "syntaxVariable",
		bash: "syntaxString",
	},
	// cool reads vs soft-blue writes; bash set apart from the inspect group.
	readwrite: {
		read: "syntaxType",
		ls: "syntaxType",
		grep: "syntaxType",
		find: "syntaxType",
		edit: "syntaxVariable",
		write: "syntaxVariable",
		bash: "syntaxVariable",
	},
	// view (read/ls) vs search (grep/find) split for discovery-heavy work.
	search: {
		read: "syntaxType",
		ls: "syntaxType",
		grep: "syntaxString",
		find: "syntaxString",
		edit: "syntaxVariable",
		write: "syntaxVariable",
		bash: "syntaxVariable",
	},
	// single hue ramped by lightness: colourblind-safe, quietest look. State is
	// still carried by the success/error mark, never by the name colour alone.
	mono: {
		read: "syntaxComment",
		ls: "syntaxComment",
		grep: "syntaxComment",
		find: "syntaxComment",
		edit: "toolOutput",
		write: "toolOutput",
		bash: "text",
	},
};

function toolPaletteFor(mode: ToolPaletteMode): Record<string, string> {
	return TOOL_PALETTES[mode] ?? TOOL_PALETTES.classic;
}

function quietMark(
	mode: CockpitConfig["quietSymbols"],
	state: "running" | "success" | "failure",
	glyphs: IconGlyphs,
): string {
	if (mode === "dot") {
		if (state === "running") return glyphs.pending;
		if (state === "success") return glyphs.dotRunning;
		return glyphs.blocked;
	}
	if (state === "running") return glyphs.ellipsis;
	if (state === "success") return glyphs.check;
	return glyphs.cross;
}

function toolName(spec: ToolSpec, theme: any, palette: Record<string, string>): string {
	return theme.fg(palette[spec.name] ?? "toolTitle", theme.bold(spec.name));
}

function renderCallLine(
	spec: ToolSpec,
	args: any,
	theme: any,
	glyphs: IconGlyphs,
	mode: CockpitConfig["quietSymbols"],
	palette: Record<string, string>,
): string {
	const mark = quietMark(mode, "running", glyphs);
	const argCap = Math.max(10, termWidth() - (spec.name.length + mark.length + 5));
	const argText = truncate(spec.arg(args), argCap);
	return `  ${theme.fg("warning", mark)} ${toolName(spec, theme, palette)}${argText ? ` ${theme.fg("accent", argText)}` : ""}`;
}

function renderResultLine(
	spec: ToolSpec,
	args: any,
	result: any,
	ctx: any,
	theme: any,
	expanded: boolean,
	glyphs: IconGlyphs,
	mode: CockpitConfig["quietSymbols"],
	palette: Record<string, string>,
): string {
	const isOk = spec.ok ? spec.ok(result, ctx) : !ctx.isError;
	const rawMark = quietMark(mode, isOk ? "success" : "failure", glyphs);
	const mark = theme.fg(isOk ? "success" : "error", rawMark);

	const overhead = 7 + spec.name.length + rawMark.length;
	const budget = Math.max(20, termWidth() - overhead);
	const sumCap = Math.min(35, Math.floor(budget * 0.4));
	const sumRaw = truncate(spec.summary(result, ctx), sumCap);
	const argCap = Math.max(10, budget - sumRaw.length);
	const argText = truncate(spec.arg(args), argCap);

	let t = `  ${mark} ${toolName(spec, theme, palette)}${argText ? ` ${theme.fg("accent", argText)}` : ""}`;
	if (sumRaw) t += ` ${theme.fg("dim", `· ${sumRaw}`)}`;

	if (expanded) {
		const full = spec.expanded ? spec.expanded(result) : textOf(result);
		if (full && full.trim()) {
			t += "\n" + theme.fg("dim", full);
		}
	}
	return t;
}

// ---------- registration ----------

/**
 * Register compact tool renderers for quiet mode. Called once at session_start
 * when config.quietMode is true. Tools delegate execution to the built-in
 * implementations; only the visual shell is replaced.
 */
export function registerQuietTools(pi: ExtensionAPI, getConfig: () => CockpitConfig): void {
	for (const spec of SPECS) {
		const original = (getBuiltInTools(process.cwd()) as any)[spec.name];
		pi.registerTool({
			name: spec.name,
			label: spec.name,
			description: original.description,
			parameters: original.parameters,
			renderShell: "self",

			async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: ExtensionContext) {
				return (getBuiltInTools(ctx.cwd) as any)[spec.name].execute(toolCallId, params, signal, onUpdate);
			},

			renderCall(args: any, theme: any, ctx: any) {
				// Once the result arrives this slot is empty; only renderResult draws.
				if (!ctx.isPartial) return new Text("", 0, 0);
				const config = getConfig();
				const glyphs = resolveGlyphs(config.icons.mode);
				const palette = toolPaletteFor(config.toolPalette);
				return new Text(renderCallLine(spec, args, theme, glyphs, config.quietSymbols, palette), 0, 0);
			},

			renderResult(result: any, { expanded, isPartial }: any, theme: any, ctx: any) {
				// While streaming, leave empty because renderCall owns the row.
				if (isPartial) return new Text("", 0, 0);
				const config = getConfig();
				const glyphs = resolveGlyphs(config.icons.mode);
				const palette = toolPaletteFor(config.toolPalette);
				return new Text(
					renderResultLine(spec, ctx.args, result, ctx, theme, expanded, glyphs, config.quietSymbols, palette),
					0,
					0,
				);
			},
		});
	}
}
