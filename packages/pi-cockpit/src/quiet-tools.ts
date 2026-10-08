// Quiet mode tool rendering: compress each built-in tool call into a single
// ✓/✗/⋯ line. Architecture adapted from pi-quiet (github.com/wing900/pi-quiet):
// a config-driven SPECS table + shared render functions. Execution is delegated
// to the original built-in tools — only the rendering is replaced.
//
// Native hosts decorate official ToolDefinitions after session binding, when
// settings and tool ownership are available. Legacy hosts retain their wrappers.
// Extension/SDK tools are never replaced. The public API cannot expose arbitrary
// baseToolsOverride execution, nor safely decorate before initial history renders.
// Maestro-owned tools consume the quiet ownership event in their owner extension.

import type {
	BashToolDetails,
	EditToolDetails,
	ExtensionAPI,
	ExtensionContext,
	ReadToolDetails,
	Theme,
	ThemeColor,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	VERSION,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
// Namespace access avoids eager missing-export failures on legacy SDKs, where
// the native definition factories do not exist and this branch is never entered.
import * as nativeTools from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { quietStatusMark } from "pi-maestro-settings-core/ui";
import { getPiHostMode } from "pi-maestro-settings-core/v1";
import type { CockpitConfig } from "./types.ts";
import { resolveGlyphs, type IconGlyphs } from "./icons.ts";
import {
	executeGuardedEdit,
	GUARDED_EDIT_DESCRIPTION,
	GUARDED_EDIT_PARAMETERS,
	prepareGuardedEditArguments,
} from "./edit-guard.ts";

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
			if (r.content.some((block: any) => block.type === "image")) return "image";
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
		summary: (r, ctx) => {
			const out = textOf(r);
			const exit = r.structuredContent?.exit_code ?? parseBashExit(out);
			const n = out.split("\n").filter((l: string) => l.trim()).length;
			const d = r.details as BashToolDetails | undefined;
			let s = `${exit ?? (ctx.isError ? "?" : 0)} · ${n}L`;
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
const NATIVE_SHELL_SPEC: ToolSpec = {
	...SPECS.find((spec) => spec.name === "bash")!,
	summary(result, ctx) {
		const output = textOf(result);
		const exitMarker = ctx.isError ? output.match(/(?:^|\n)Command exited with code (\d+)\s*$/) : null;
		const exitCode = ctx.isError ? (exitMarker ? Number(exitMarker[1]) : null) : 0;
		const lines = output.split("\n").filter((line) => line.trim()).length;
		return `${exitCode ?? "?"} · ${lines}L${result.details?.truncation?.truncated ? " · trunc" : ""}`;
	},
	ok: (_result, ctx) => !ctx.isError,
};
const NATIVE_SPECS = [
	...SPECS.map((spec) => spec.name === "bash" ? NATIVE_SHELL_SPEC : spec),
	{ ...NATIVE_SHELL_SPEC, name: "powershell" },
];

// ---------- rendering ----------

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

function toolName(spec: ToolSpec, theme: any, color: ThemeColor): string {
	return theme.fg(color, theme.bold(spec.name));
}

function renderCallLine(
	spec: ToolSpec,
	args: any,
	theme: any,
	glyphs: IconGlyphs,
	mode: CockpitConfig["quietSymbols"],
	width = termWidth(),
): string {
	const mark = quietMark(mode, "running", glyphs);
	const argCap = Math.max(1, width - (spec.name.length + mark.length + 5));
	const argText = truncate(sanitizeCardText(spec.arg(args)), argCap);
	return `  ${theme.fg("warning", mark)} ${toolName(spec, theme, "warning")}${argText ? ` ${theme.fg("accent", argText)}` : ""}`;
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
	width = termWidth(),
): string {
	const isOk = spec.ok ? spec.ok(result, ctx) : !ctx.isError;
	const stateColor: ThemeColor = isOk ? "success" : "error";
	const rawMark = quietMark(mode, isOk ? "success" : "failure", glyphs);
	const mark = theme.fg(stateColor, rawMark);

	const overhead = 7 + spec.name.length + rawMark.length;
	const budget = Math.max(1, width - overhead);
	const sumCap = Math.min(35, Math.floor(budget * 0.4));
	const sumRaw = truncate(spec.summary(result, ctx), sumCap);
	const argCap = Math.max(10, budget - sumRaw.length);
	const argText = truncate(sanitizeCardText(spec.arg(args)), argCap);

	let t = `  ${mark} ${toolName(spec, theme, stateColor)}${argText ? ` ${theme.fg("accent", argText)}` : ""}`;
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

// All non-render fields, including execute's fifth ExtensionToolContext, stay
// intact. Verbose mode composes the official renderers and original shell inside
// our self shell; this permits live toggles without unregistering a tool.
export function decorateNativeQuietTool(
	original: ToolDefinition<any, any, any>,
	getConfig: () => CockpitConfig,
): ToolDefinition<any, any, any> {
	const spec = NATIVE_SPECS.find((entry) => entry.name === original.name);
	if (!spec) return original;
	const resultKey = Symbol("cockpit-native-result");
	const callKey = Symbol("cockpit-native-call");
	return {
		...original,
		renderShell: "self",
		renderCall(args, theme, ctx) {
			ctx.state[callKey] = original.renderCall?.(args, theme, { ...ctx, lastComponent: ctx.state[callKey] });
			return {
				render(width) {
					const config = getConfig();
					if (config.enabled && config.quietMode) {
						if (!ctx.isPartial) return [];
						return lineComponent(() => renderCallLine(spec, args, theme, resolveGlyphs(config.icons.mode), config.quietSymbols, width)).render(width);
					}
					const shell = original.renderShell === "self" ? new Container() : new Box(1, 1,
						(text) => theme.bg(ctx.isPartial ? "toolPendingBg" : ctx.isError ? "toolErrorBg" : "toolSuccessBg", text));
					if (ctx.state[callKey]) shell.addChild(ctx.state[callKey]);
					if (ctx.state[resultKey]) shell.addChild(ctx.state[resultKey]);
					return shell.render(width);
				},
				invalidate() {},
			};
		},
		renderResult(result, options, theme, ctx) {
			// Run official renderer lifecycle even while compact (e.g. shell timer
			// cleanup, edit preview state); never pass our wrapper as lastComponent.
			// Use a fresh native result component: official write switches between
			// Container (success) and Text (error), which cannot reuse one another.
			ctx.state[resultKey] = original.renderResult?.(result, options, theme, { ...ctx, lastComponent: undefined });
			return {
				render(width) {
					const config = getConfig();
					if (!config.enabled || !config.quietMode || options.isPartial) return [];
					return lineComponent(() => renderResultLine(spec, ctx.args, result, ctx, theme, options.expanded,
						resolveGlyphs(config.icons.mode), config.quietSymbols, width)).render(width);
				},
				invalidate() {},
			};
		},
	};
}

/** Native calls must happen post-bind; no settings/ownership API exists at load. */
export function registerQuietTools(pi: ExtensionAPI, getConfig: () => CockpitConfig, hostVersion: unknown = VERSION, cwd = process.cwd()): boolean {
	const hostMode = getPiHostMode(hostVersion);
	if (hostMode === "unknown") return false;
	if (hostMode !== "legacy") {
		const settings = pi.getSettings();
		const definitions = [
			nativeTools.createReadToolDefinition(cwd, { autoResizeImages: settings.images?.autoResize ?? true }),
			nativeTools.createBashToolDefinition(cwd, { commandPrefix: settings.shellCommandPrefix, shellPath: settings.shellPath }),
			nativeTools.createEditToolDefinition(cwd), nativeTools.createWriteToolDefinition(cwd),
			nativeTools.createGrepToolDefinition(cwd), nativeTools.createFindToolDefinition(cwd), nativeTools.createLsToolDefinition(cwd),
			nativeTools.createPowerShellToolDefinition(cwd),
		];
		const tools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
		const active = pi.getActiveTools();
		let registered = 0;
		try {
			for (const definition of definitions) {
				const tool = tools.get(definition.name);
				// ToolInfo is not a definition handle. Skip distinguishable overrides;
				// an execution-only baseToolsOverride is not detectable via this API.
				if (tool?.sourceInfo.source !== "builtin" || tool.description !== definition.description ||
					JSON.stringify(tool.parameters) !== JSON.stringify(definition.parameters) ||
					JSON.stringify(tool.promptGuidelines) !== JSON.stringify(definition.promptGuidelines) ||
					tool.exposure !== (definition.exposure ?? "direct") ||
					JSON.stringify(tool.namespace) !== JSON.stringify(definition.namespace) ||
					JSON.stringify(tool.annotations) !== JSON.stringify(definition.annotations)) continue;
				pi.registerTool(decorateNativeQuietTool(definition, getConfig));
				registered += 1;
			}
		} finally {
			// registerTool refreshes the registry. Never activate grep/find/ls or
			// PowerShell merely because Cockpit supplies their visual shell.
			pi.setActiveTools(active);
		}
		return registered > 0;
	}

	for (const spec of SPECS) {
		const original = (getBuiltInTools(process.cwd()) as any)[spec.name];
		const guardedEdit = spec.name === "edit";
		pi.registerTool({
			...original,
			name: spec.name,
			label: spec.name,
			description: guardedEdit ? GUARDED_EDIT_DESCRIPTION : original.description,
			parameters: guardedEdit ? GUARDED_EDIT_PARAMETERS : original.parameters,
			prepareArguments: guardedEdit ? prepareGuardedEditArguments : original.prepareArguments,
			executionMode: guardedEdit ? "sequential" : original.executionMode,
			renderShell: "self",

			async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: ExtensionContext) {
				if (guardedEdit) {
					return executeGuardedEdit(toolCallId, params, signal, onUpdate, ctx);
				}
				return (getBuiltInTools(ctx.cwd) as any)[spec.name].execute(toolCallId, params, signal, onUpdate);
			},

			renderCall(args: any, theme: any, ctx: any) {
				// Once the result arrives this slot is empty; only renderResult draws.
				if (!ctx.isPartial) return new Text("", 0, 0);
				const config = getConfig();
				const glyphs = resolveGlyphs(config.icons.mode);
				return new Text(renderCallLine(spec, args, theme, glyphs, config.quietSymbols), 0, 0);
			},

			renderResult(result: any, { expanded, isPartial }: any, theme: any, ctx: any) {
				// While streaming, leave empty because renderCall owns the row.
				if (isPartial) return new Text("", 0, 0);
				const config = getConfig();
				const glyphs = resolveGlyphs(config.icons.mode);
				return new Text(
					renderResultLine(spec, ctx.args, result, ctx, theme, expanded, glyphs, config.quietSymbols),
					0,
					0,
				);
			},
		});
	}
	return true;
}

// ---------------------------------------------------------------------------
// Shared quiet renderers for Maestro-owned (self-rendering) tools.
//
// The built-in tool specs above cover Cockpit's own re-registered tools. Flow
// and teammate tools render their own compact rows and consume these helpers so
// every Maestro surface shares one implementation.
// ---------------------------------------------------------------------------

/**
 * A structural subset of pi's Theme so both the real Theme and local test
 * themes satisfy it without contravariance errors.
 */
export type QuietTheme = Pick<Theme, "fg"> & Partial<Pick<Theme, "bold">>;

interface ResultLike {
	content: Array<{ type: string; text?: string }>;
}

function lineComponent(text: () => string): Component {
	return {
		render(width: number): string[] {
			const safeWidth = Math.max(1, width);
			if (safeWidth <= 1) return [];
			const liveWidth = safeWidth - 1;
			return text().split("\n").map((line) => truncateToWidth(line, liveWidth, "…"));
		},
		invalidate(): void {},
	};
}

export function toolCallLine(theme: QuietTheme, name: string, arg = ""): Component {
	const bold = theme.bold ?? ((text: string) => text);
	return lineComponent(() =>
		`  ${theme.fg("warning", quietStatusMark("running"))} ${theme.fg("toolTitle", bold(name))}${arg ? ` ${theme.fg("accent", arg)}` : ""}`,
	);
}

export function toolResultLine(
	theme: QuietTheme,
	o: {
		name: string;
		mark?: string;
		ok?: boolean;
		arg?: string;
		summary?: string;
		detail?: string;
		expanded?: boolean;
	},
): Component {
	const bold = theme.bold ?? ((text: string) => text);
	return lineComponent(() => {
		const mark = o.mark ?? (o.ok === false
			? theme.fg("error", quietStatusMark("failure"))
			: theme.fg("success", quietStatusMark("success")));
		let line = `  ${mark} ${theme.fg("toolTitle", bold(o.name))}${o.arg ? ` ${theme.fg("accent", o.arg)}` : ""}${o.summary ? ` ${theme.fg("dim", `· ${o.summary}`)}` : ""}`;
		if (o.expanded && o.detail && o.detail.trim()) line += `\n${theme.fg("dim", o.detail)}`;
		return line;
	});
}

export function toolResultCard(
	theme: QuietTheme,
	o: {
		name: string;
		ok?: boolean;
		/** Pre-colored glyph overriding the ✓/✗ status mark (e.g. "←" for incoming messages). */
		mark?: string;
		arg?: string;
		summary?: string;
		rows?: string[];
		groups?: string[][];
		maxBodyRows?: number;
	},
): Component {
	const bold = theme.bold ?? ((text: string) => text);
	return {
		render(width: number): string[] {
			const mark = o.mark ?? (o.ok === false
				? theme.fg("error", quietStatusMark("failure"))
				: theme.fg("success", quietStatusMark("success")));
			const safeWidth = Math.max(1, width);
			if (safeWidth <= 1) return [];
			const label = `${mark} ${theme.fg("toolTitle", bold(o.name))}${o.arg ? ` ${theme.fg("accent", o.arg)}` : ""}${o.summary ? ` ${theme.fg("dim", `· ${o.summary}`)}` : ""}`;
			const cardWidth = safeWidth - 1;
			if (cardWidth < 6) return [truncateToWidth(label, cardWidth, "…")];

			const innerWidth = cardWidth - 2;
			const contentWidth = Math.max(1, innerWidth - 2);
			const fit = (text: string, width: number): string => {
				const clipped = truncateToWidth(text, width, "…");
				return `${clipped}${ " ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
			};
			const header = truncateToWidth(` ${label} `, innerWidth, "…");
			const top = `${theme.fg("dim", "╭")}${header}${theme.fg("dim", `${ "─".repeat(Math.max(0, innerWidth - visibleWidth(header)))}╮`)}`;
			const groups = o.groups ?? ((o.rows?.length ?? 0) > 0 ? [o.rows ?? []] : []);
			const body: string[] = [];
			for (const [index, group] of groups.entries()) {
				if (index > 0) body.push(theme.fg("dim", `├${ "─".repeat(innerWidth)}┤`));
				const wrapped = group.flatMap((row) => wrapTextWithAnsi(row || " ", contentWidth));
				for (const row of wrapped) {
					body.push(`${theme.fg("dim", "│")} ${fit(row, contentWidth)} ${theme.fg("dim", "│")}`);
				}
			}
			let visibleBody = body;
			if (o.maxBodyRows !== undefined && body.length > o.maxBodyRows) {
				const kept = Math.max(0, o.maxBodyRows - 1);
				const hidden = body.length - kept;
				visibleBody = [
					...body.slice(0, kept),
					`${theme.fg("dim", "│")} ${fit(`… ${hidden} more rows · expand for details`, contentWidth)} ${theme.fg("dim", "│")}`,
				];
			}
			return [
				top,
				...visibleBody,
				theme.fg("dim", `╰${ "─".repeat(innerWidth)}╯`),
			];
		},
		invalidate(): void {},
	};
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

/** Normalize untrusted custom-message text before it enters a terminal card. */
export function sanitizeCardText(value: string, maxLen = 4_096): string {
	const cleaned = value
		.replace(/[\r\n\t]/g, " ")
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.trim();
	return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}
