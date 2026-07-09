/**
 * Plan mode — toggle between Plan (read-only analysis) and Act (execution).
 *
 * Shift+Tab toggles mode. In Plan mode:
 *   - Phased system prompt: Ground → Intent → Implementation → Finalization
 *   - Write tools blocked, bash commands filtered by safety patterns
 *   - Structured plan captured via <proposed_plan> tags
 *   - Switching back to Act shows confirmation overlay → injects approved plan
 *
 * State machine: ACT ↔ PLAN (Shift+Tab toggles)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi, truncateToWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Mode = "act" | "plan";

export interface PlanContext {
	cwd: string;
	hasUI?: boolean;
	ui: {
		notify: (message: string, level?: "info" | "warning" | "error") => void;
		setStatus: (key: string, value: string | undefined) => void;
		confirm?: (title: string, message: string) => Promise<boolean>;
		custom?: <T>(
			callback: (
				tui: { requestRender: () => void },
				theme: Record<string, never>,
				keybindings: unknown,
				done: (value: T) => void,
			) => {
				render: (width: number) => string[];
				handleInput: (data: string) => void;
				invalidate: () => void;
				dispose?: () => void;
			},
			opts?: unknown,
		) => Promise<T | undefined>;
	};
	isIdle?: () => boolean;
	sessionManager?: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_KEY = "mode";
const PROPOSED_PLAN_PATTERN = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;

const BLOCKED_BUILTIN_TOOLS = new Set([
	"Edit",
	"Write",
	"NotebookEdit",
	"edit",
	"write",
	"notebook_edit",
]);

const PLAN_ALLOWED_TOOLS = new Set([
	"maestro",
	"maestro-wait",
	"maestro-status",
	"ask-user-question",
	"todo",
	"teammate-list",
	"teammate-watch",
	"goal",
	"Read",
	"Grep",
	"Glob",
	"read",
	"grep",
	"glob",
	"bash",
	"Bash",
	"powershell",
	"PowerShell",
	"LSP",
	"WebSearch",
	"WebFetch",
]);

// Bash: block mutating commands even though bash itself is allowed
const MUTATING_BASH_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish|version)\b/i,
	/\byarn\s+(add|remove|install|publish|upgrade)\b/i,
	/\bpnpm\s+(add|remove|install|publish|update)\b/i,
	/\bbun\s+(add|remove|install|update|publish)\b/i,
	/\bpip\s+(install|uninstall)\b/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone)\b/i,
	/\bsudo\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
];

const SAFE_BASH_PATTERNS = [
	/^\s*(cat|head|tail|less|more|grep|find|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|type|env|uname|whoami|id|date|ps|jq|awk|rg|fd|bat)\b/i,
	/^\s*sed\s+-n\b/i,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-files|grep)\b/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*(node|python|python3|npm|tsc|biome)\s+--version\b/i,
];

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let mode: Mode = "act";
let extensionApi: ExtensionAPI | undefined;
let latestPlan: string | undefined;
let awaitingAction = false;

// ---------------------------------------------------------------------------
// Public: init + getters
// ---------------------------------------------------------------------------

export function initPlan(pi: ExtensionAPI): void {
	extensionApi = pi;
}

export function isPlanMode(): boolean {
	return mode === "plan";
}

export function getMode(): Mode {
	return mode;
}

export function hasPlan(): boolean {
	return latestPlan !== undefined;
}

export function getPlanText(): string {
	return latestPlan ?? "";
}

export function clearPlan(): void {
	latestPlan = undefined;
	awaitingAction = false;
}

// ---------------------------------------------------------------------------
// Mode transitions
// ---------------------------------------------------------------------------

function enterPlanMode(ctx: PlanContext): void {
	mode = "plan";
	latestPlan = undefined;
	awaitingAction = false;
	ctx.ui.setStatus(STATUS_KEY, "PLAN");
	ctx.ui.notify("Plan mode — exploring and planning, no file changes", "info");
}

function exitPlanMode(ctx: PlanContext): void {
	mode = "act";
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

export async function toggleMode(ctx: PlanContext): Promise<Mode> {
	if (mode === "act") {
		enterPlanMode(ctx);
		return mode;
	}

	// PLAN → ACT: show confirmation if we have a proposed plan
	if (hasPlan() && ctx.hasUI !== false) {
		const approved = await showPlanOverlay(ctx);
		if (approved) {
			startImplementation(ctx);
		} else {
			ctx.ui.notify("Staying in Plan mode", "info");
		}
		return mode;
	}

	exitPlanMode(ctx);
	ctx.ui.notify("Act mode", "info");
	return mode;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function onSessionStartPlan(ctx: PlanContext): void {
	if (mode === "plan") {
		ctx.ui.setStatus(STATUS_KEY, hasPlan() ? "plan ready" : "PLAN");
	}
}

export function onSessionShutdownPlan(ctx: PlanContext): void {
	mode = "act";
	latestPlan = undefined;
	awaitingAction = false;
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

export function onCompactPlan(ctx: PlanContext): void {
	if (mode === "plan") {
		ctx.ui.setStatus(STATUS_KEY, hasPlan() ? "plan ready" : "PLAN");
	}
}

export function onBeforeAgentStartPlan(event: {
	systemPrompt: string;
}): { systemPrompt: string } | undefined {
	if (mode !== "plan") return;

	// Reset plan-ready state when a new turn starts
	if (latestPlan || awaitingAction) {
		latestPlan = undefined;
		awaitingAction = false;
	}

	return {
		systemPrompt: `${event.systemPrompt}\n\n${buildPlanModePrompt()}`,
	};
}

export function onToolCallPlan(event: {
	toolName: string;
	input: Record<string, unknown>;
}): { block: true; reason: string } | undefined {
	if (mode !== "plan") return;

	const name = event.toolName;

	// Blocked write tools
	if (BLOCKED_BUILTIN_TOOLS.has(name)) {
		return {
			block: true,
			reason: `Plan mode blocks "${name}". Use /plan and approve the plan, or Shift+Tab to switch to Act mode.`,
		};
	}

	// Allowed tools — with special cases
	if (PLAN_ALLOWED_TOOLS.has(name)) {
		// Block maestro delegate in write mode
		if (
			name === "maestro" &&
			event.input?.action === "delegate" &&
			event.input?.mode === "write"
		) {
			return {
				block: true,
				reason: "Plan mode: write-mode delegate blocked. Use mode='analysis'.",
			};
		}

		// Bash/PowerShell: filter by command safety
		if (name === "bash" || name === "Bash" || name === "powershell" || name === "PowerShell") {
			const command = readCommand(event.input);
			if (command && !isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode blocks mutating commands.\nCommand: ${command.slice(0, 120)}`,
				};
			}
		}

		return;
	}
}

export function onAgentEndPlan(event: { messages: unknown[] }, ctx: PlanContext): void {
	if (mode !== "plan") return;

	const text = latestAssistantText(event.messages);
	const proposedPlan = extractProposedPlan(text);

	if (!proposedPlan) return;

	latestPlan = proposedPlan;
	awaitingAction = true;
	ctx.ui.setStatus(STATUS_KEY, "plan ready");
	ctx.ui.notify("Proposed plan ready. Use /plan or Shift+Tab to review.", "info");
}

// ---------------------------------------------------------------------------
// Bash command safety
// ---------------------------------------------------------------------------

function readCommand(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const rec = input as Record<string, unknown>;
	return typeof rec.command === "string" ? rec.command : "";
}

function isSafeCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	if (MUTATING_BASH_PATTERNS.some((p) => p.test(trimmed))) return false;
	return SAFE_BASH_PATTERNS.some((p) => p.test(trimmed));
}

// ---------------------------------------------------------------------------
// Plan extraction from assistant output
// ---------------------------------------------------------------------------

function extractProposedPlan(text: string): string | undefined {
	const match = PROPOSED_PLAN_PATTERN.exec(text);
	return match?.[1]?.trim() || undefined;
}

function latestAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const entry = messages[i] as Record<string, unknown>;
		const message = (entry?.message as Record<string, unknown>) ?? entry;
		if (message?.role !== "assistant") continue;
		const text = contentText(message.content);
		if (text) return text;
	}
	return "";
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const b = block as { type?: string; text?: string };
			return b.type === "text" && typeof b.text === "string" ? b.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

// ---------------------------------------------------------------------------
// System prompt — phased planning protocol
// ---------------------------------------------------------------------------

function buildPlanModePrompt(): string {
	return `[PLAN MODE ACTIVE]
# Plan Mode

You are in Plan Mode — a conversational collaboration mode for producing a decision-complete implementation plan. The plan must leave no implementation decisions unresolved.

## Mode rules

- Stay in Plan Mode until the user explicitly exits (Shift+Tab or /plan exit).
- Treat requests to implement as requests to plan the implementation; do not edit files or carry out the plan.
- Do not perform mutating actions: no edit/write tools, no patching, no dependency installation, no commits.
- Bash/shell is allowed for read-only inspection (cat, grep, find, git log, etc.) but mutating commands are blocked.

## Phase 1 — Ground in the environment

- Explore first, ask second. Use read-only tools to read files, search, inspect config, and resolve discoverable facts.
- Before asking the user any question, perform at least one targeted exploration pass.
- Do not ask questions that can be answered from repository or system truth.

## Phase 2 — Intent chat

- Keep asking until you can clearly state: the goal, success criteria, in/out of scope, constraints, current state, and key preferences.
- Bias toward questions over guessing: if a high-impact ambiguity remains, do not produce a proposed plan yet.

## Phase 3 — Implementation chat

- Once intent is stable, keep asking until the spec is decision-complete: approach, interfaces, data flow, edge cases, testing/acceptance criteria, and any migration or compatibility constraints.
- Use ask-user-question for important preferences or tradeoffs that cannot be discovered by read-only exploration.

## Finalization

Only output the final plan when it is decision-complete. When presenting the plan, output exactly one proposed plan block with these tags:

<proposed_plan>
# Title

## Summary
...

## Key Changes
- file: path/to/file — what and why
- ...

## Implementation Steps
1. ...
2. ...

## Test Plan
...

## Risks & Mitigations
...

## Assumptions
...
</proposed_plan>

Keep the plan concise, actionable, and free of open decisions. Do not ask "should I proceed?" — the Plan-mode confirmation UI handles that.`;
}

// ---------------------------------------------------------------------------
// Plan confirmation overlay (Custom TUI)
// ---------------------------------------------------------------------------

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;

function highlightPlanLine(line: string): string {
	if (/^#{1,3}\s/.test(line)) return bold(line);
	if (/^\s*[-*]\s/.test(line)) return line.replace(/^(\s*)([-*])/, `$1${cyan("$2")}`);
	if (/^\s*\d+\.\s/.test(line)) return line.replace(/^(\s*)(\d+\.)/, `$1${cyan("$2")}`);
	return line;
}

function padLine(content: string, innerW: number): string {
	return dim("│") + truncateToWidth(` ${content}`, innerW, "…", true) + dim("│");
}

async function showPlanOverlay(ctx: PlanContext): Promise<boolean> {
	if (!ctx.ui.custom) {
		return ctx.ui.confirm?.("Approve plan?", "Execute the captured plan?") ?? false;
	}
	const planText = getPlanText();

	const approved = await ctx.ui.custom<boolean>(
		(tui, _theme, _keybindings, done) => {
			let scrollOffset = 0;
			let wrappedLines: string[] = [];
			let cachedContentW = 0;

			function rebuildWrapped(contentW: number): void {
				if (contentW === cachedContentW) return;
				cachedContentW = contentW;
				wrappedLines = [];
				for (const rawLine of planText.split("\n")) {
					if (!rawLine.trim()) {
						wrappedLines.push("");
					} else {
						const highlighted = highlightPlanLine(rawLine);
						const wrapped = wrapTextWithAnsi(highlighted, contentW);
						wrappedLines.push(...wrapped);
					}
				}
			}

			function clampScroll(viewH: number): void {
				const max = Math.max(0, wrappedLines.length - viewH);
				scrollOffset = Math.max(0, Math.min(scrollOffset, max));
			}

			return {
				render(width: number): string[] {
					const w = Math.min(width, 100);
					const innerW = w - 2;
					const contentW = innerW - 2;
					rebuildWrapped(contentW);

					const out: string[] = [];

					// Top border
					out.push(dim("╭" + "─".repeat(innerW) + "╮"));

					// Header
					const header = `  ${bold("Plan Review")}  ${dim("│")}  ${green("Enter")}: implement  ${dim("│")}  ${yellow("Esc")}: cancel  ${dim("│")}  ${dim("jk/↑↓")}: scroll`;
					out.push(dim("│") + truncateToWidth(header, innerW, "…", true) + dim("│"));
					out.push(dim("├" + "─".repeat(innerW) + "┤"));

					// Content area with scroll
					const viewH = Math.max(6, (process.stdout?.rows ?? 30) - 8);
					clampScroll(viewH);
					const visible = wrappedLines.slice(scrollOffset, scrollOffset + viewH);

					for (const line of visible) {
						out.push(padLine(line, innerW));
					}
					for (let i = visible.length; i < viewH; i++) {
						out.push(padLine("", innerW));
					}

					// Footer
					out.push(dim("├" + "─".repeat(innerW) + "┤"));
					const total = wrappedLines.length;
					const scrollInfo = total > viewH
						? `${scrollOffset + 1}–${Math.min(scrollOffset + viewH, total)}/${total}`
						: `${total} lines`;
					const footer = `  ${cyan("proposed plan")}  ${dim("│")}  ${dim(scrollInfo)}`;
					out.push(dim("│") + truncateToWidth(footer, innerW, "…", true) + dim("│"));
					out.push(dim("╰" + "─".repeat(innerW) + "╯"));

					return out;
				},

				handleInput(data: string): void {
					const viewH = Math.max(6, (process.stdout?.rows ?? 30) - 8);
					if (data === "\r" || data === "\n") { done(true); return; }
					if (data === "\x1b" || data === "q") { done(false); return; }
					if (data === "\x1b[A" || data === "k") {
						scrollOffset = Math.max(0, scrollOffset - 1);
						tui.requestRender();
					} else if (data === "\x1b[B" || data === "j") {
						scrollOffset = Math.min(Math.max(0, wrappedLines.length - viewH), scrollOffset + 1);
						tui.requestRender();
					} else if (data === "\x1b[5~") {
						scrollOffset = Math.max(0, scrollOffset - viewH);
						tui.requestRender();
					} else if (data === "\x1b[6~") {
						scrollOffset = Math.min(Math.max(0, wrappedLines.length - viewH), scrollOffset + viewH);
						tui.requestRender();
					}
				},

				invalidate(): void {},
				dispose(): void {},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				width: "100%",
				maxHeight: "80%",
				anchor: "top-left" as const,
				margin: 1,
			},
		},
	);

	return approved ?? false;
}

// ---------------------------------------------------------------------------
// Plan implementation — inject approved plan as execution context
// ---------------------------------------------------------------------------

function startImplementation(ctx: PlanContext): void {
	const plan = latestPlan?.trim();
	exitPlanMode(ctx);
	clearPlan();

	if (!plan) {
		ctx.ui.notify("Plan mode disabled. No proposed plan available.", "warning");
		return;
	}

	ctx.ui.notify("Plan approved — implementing", "info");

	const opts = ctx.isIdle?.() ? undefined : { deliverAs: "followUp" as const };
	extensionApi?.sendUserMessage(
		[
			"Plan mode is now disabled. Full tool access is restored. Implement this proposed plan now:",
			"",
			plan,
			"",
			"Execute each step. Verify each step works before proceeding to the next.",
		].join("\n"),
		opts,
	);
}

// ---------------------------------------------------------------------------
// /plan command
// ---------------------------------------------------------------------------

export function registerPlanCommand(pi: ExtensionAPI): void {
	pi.registerCommand("plan", {
		description: "Plan mode: /plan [<prompt>|exit|show|approve|clear|tools]",

		getArgumentCompletions(prefix: string) {
			const subs = [
				{ value: "exit", label: "exit", description: "Leave Plan mode" },
				{ value: "show", label: "show", description: "Show proposed plan" },
				{ value: "approve", label: "approve", description: "Approve and implement plan" },
				{ value: "clear", label: "clear", description: "Clear proposed plan" },
			];
			const lower = prefix.trim().toLowerCase();
			if (!lower) return subs;
			return subs.filter((s) => s.value.startsWith(lower));
		},

		async handler(args: string, ctx: PlanContext) {
			const trimmed = args.trim();
			const command = trimmed.toLowerCase();

			if (command === "exit" || command === "off") {
				exitPlanMode(ctx);
				clearPlan();
				ctx.ui.notify("Plan mode disabled.", "info");
				return;
			}

			if (command === "show") {
				if (!hasPlan()) {
					ctx.ui.notify("No proposed plan yet.", "info");
					return;
				}
				if (ctx.ui.custom) {
					await showPlanOverlay(ctx);
				} else {
					ctx.ui.notify(getPlanText().slice(0, 300), "info");
				}
				return;
			}

			if (command === "approve") {
				if (!hasPlan()) {
					ctx.ui.notify("No plan to approve.", "warning");
					return;
				}
				startImplementation(ctx);
				return;
			}

			if (command === "clear") {
				clearPlan();
				ctx.ui.notify("Proposed plan cleared.", "info");
				return;
			}

			// /plan with a prompt: enter plan mode and forward the prompt
			if (trimmed) {
				if (!isPlanMode()) enterPlanMode(ctx);
				const opts = ctx.isIdle?.() ? undefined : { deliverAs: "followUp" as const };
				extensionApi?.sendUserMessage(trimmed, opts);
				return;
			}

			// Bare /plan: toggle or show menu
			if (!isPlanMode()) {
				enterPlanMode(ctx);
				return;
			}

			// Already in plan mode: toggle out
			await toggleMode(ctx);
		},
	});
}
