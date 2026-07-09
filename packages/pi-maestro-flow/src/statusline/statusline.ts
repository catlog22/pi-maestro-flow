/**
 * Maestro Flow statusline — Pi Extension footer API implementation.
 *
 * Line 1: Model | Runs | Dir+Git | Tokens | Context
 * Line 2: Milestone ◆Phase progress (when workflow active)
 *
 * Adapted from maestro2/src/hooks/statusline.ts for the Pi Extension ecosystem.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import {
	type RGB,
	ansiFg,
	ANSI_RESET,
	ICONS,
	GIT_ICONS,
	COLORS,
	getCtxLevel,
	getCtxColor,
} from "./constants.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MaestroState {
	activeRuns: Map<string, { action: string; startedAt: number; correlationId: string }>;
}

interface GitInfo {
	branch: string;
	dirty: boolean;
	ahead: number;
	behind: number;
}

interface WorkflowInfo {
	milestone: string;
	currentPhase: number;
	completed: number;
	total: number;
	status: string;
}

interface TokenTotals {
	input: number;
	output: number;
}

interface RuntimeState {
	model: string;
	git: GitInfo | null;
	contextPercent: number | null;
	tokens: TokenTotals;
	turnCount: number;
	isAgentRunning: boolean;
	workflow: WorkflowInfo | null;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return (n / 1000).toFixed(1) + "k";
	return Math.round(n / 1000) + "k";
}

function buildContextBar(usedPct: number): string {
	const filled = Math.floor(usedPct / 10);
	const bar = "█".repeat(filled) + "░".repeat(10 - filled);
	const level = getCtxLevel(usedPct);
	const color = getCtxColor(level);
	return `${ansiFg(color)}${ICONS.ctx} ${bar} ${usedPct}%${ANSI_RESET}`;
}

function formatGit(git: GitInfo): string {
	const parts: string[] = [];
	if (git.dirty) parts.push(GIT_ICONS.dirty);
	if (git.ahead > 0) parts.push(`${GIT_ICONS.ahead}${git.ahead}`);
	if (git.behind > 0) parts.push(`${GIT_ICONS.behind}${git.behind}`);
	const suffix = parts.length > 0 ? ` ${parts.join("")}` : "";
	return `${ansiFg(COLORS.git)}${ICONS.git} ${git.branch}${suffix}${ANSI_RESET}`;
}

function colored(key: keyof typeof COLORS, text: string): string {
	return `${ansiFg(COLORS[key])}${text}${ANSI_RESET}`;
}

const SEP = `${ansiFg(COLORS.separator)} | ${ANSI_RESET}`;

// ---------------------------------------------------------------------------
// Workflow state reader
// ---------------------------------------------------------------------------

function readWorkflow(cwd: string): WorkflowInfo | null {
	const statePath = join(cwd, ".workflow", "state.json");
	if (!existsSync(statePath)) return null;
	try {
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		if (!state.current_milestone) return null;

		const result: WorkflowInfo = {
			milestone: state.current_milestone,
			currentPhase: 0,
			completed: 0,
			total: 0,
			status: state.status ?? "",
		};

		const milestone = Array.isArray(state.milestones)
			? state.milestones.find(
					(m: { name?: string; id?: string }) =>
						m.name === state.current_milestone || m.id === state.current_milestone,
				)
			: null;

		const phases: unknown[] = Array.isArray(milestone?.phases) ? milestone.phases : [];
		const phaseEntries: Array<{ id: number; status?: string }> = [];

		for (const p of phases) {
			if (typeof p === "number") phaseEntries.push({ id: p });
			else if (p && typeof p === "object" && typeof (p as { id?: unknown }).id === "number") {
				const obj = p as { id: number; status?: string };
				phaseEntries.push({ id: obj.id, status: obj.status });
			}
		}

		if (phaseEntries.length > 0) {
			result.total = phaseEntries.length;
			let completed = 0;
			for (const pe of phaseEntries) {
				if (pe.status === "completed") completed++;
			}
			result.completed = completed;

			// Find current phase: first in-progress, then first non-completed
			const cur =
				phaseEntries.find(
					(p) =>
						p.status === "in-progress" ||
						p.status === "in_progress" ||
						p.status === "active",
				) ?? phaseEntries.find((p) => p.status !== "completed");
			if (cur) result.currentPhase = cur.id;
		} else if (state.phases_summary) {
			const s = state.phases_summary;
			if (typeof s.total === "number") result.total = s.total;
			if (typeof s.completed === "number") result.completed = s.completed;
			if (state.current_phase) result.currentPhase = state.current_phase;
		}

		return result;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Git reader (async — cached)
// ---------------------------------------------------------------------------

async function refreshGit(pi: ExtensionAPI, cwd: string): Promise<GitInfo | null> {
	try {
		// Single command: branch + dirty + ahead/behind from porcelain header
		const result = await pi.exec(
			"git",
			["--no-optional-locks", "status", "--porcelain=v1", "--branch", "-uno"],
			{ cwd, timeout: 3000 },
		);
		if (result.code !== 0) return null;

		const lines = result.stdout.split("\n");
		const headerLine = lines[0] ?? "";
		if (!headerLine.startsWith("## ")) return null;

		// Parse "## branch...origin/branch [ahead N, behind M]" or "## branch"
		const header = headerLine.slice(3);
		const dotIdx = header.indexOf("...");
		const bracketIdx = header.indexOf(" [");
		const branch = dotIdx > 0 ? header.slice(0, dotIdx) : (bracketIdx > 0 ? header.slice(0, bracketIdx) : header.trim());
		if (!branch) return null;

		let ahead = 0;
		let behind = 0;
		if (bracketIdx > 0) {
			const bracketContent = header.slice(bracketIdx);
			const aheadMatch = bracketContent.match(/ahead (\d+)/);
			const behindMatch = bracketContent.match(/behind (\d+)/);
			if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
			if (behindMatch) behind = parseInt(behindMatch[1], 10);
		}

		// Any non-header line = dirty
		const dirty = lines.some((l, i) => i > 0 && l.length > 0);

		return { branch, dirty, ahead, behind };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Renderer — produces line strings
// ---------------------------------------------------------------------------

function shortenModel(id: string): string {
	return id
		.replace(/^claude-/, "")
		.replace(/-\d{8}$/, "");
}

function renderLine1(rs: RuntimeState, activeRuns: number, dir: string): string {
	const parts: string[] = [];

	// Model
	parts.push(colored("model", `${ICONS.model} ${shortenModel(rs.model)}`));

	// Active maestro runs
	if (activeRuns > 0) {
		parts.push(colored("runs", `${ICONS.runs} ${activeRuns} run${activeRuns > 1 ? "s" : ""}`));
	}

	// Dir + Git
	let dirText = colored("dir", `${ICONS.dir} ${basename(dir)}`);
	if (rs.git) dirText += `  ${formatGit(rs.git)}`;
	parts.push(dirText);

	// Tokens
	if (rs.tokens.input > 0 || rs.tokens.output > 0) {
		const tokenText = `↑${formatTokens(rs.tokens.input)} ↓${formatTokens(rs.tokens.output)} ${ICONS.tokens}${formatTokens(rs.tokens.input + rs.tokens.output)}`;
		parts.push(colored("tokens", tokenText));
	}

	// Context bar (contextPercent is already "used" percentage from Pi SDK)
	if (rs.contextPercent != null) {
		const usedPct = Math.max(0, Math.min(100, Math.round(rs.contextPercent)));
		parts.push(buildContextBar(usedPct));
	}

	return parts.join(SEP);
}

function renderLine2(wf: WorkflowInfo): string {
	const parts: string[] = [];

	let header = colored("milestone", `${ICONS.milestone} ${wf.milestone}`);
	if (wf.total > 0) {
		header += colored("milestone", ` ${wf.completed}/${wf.total}`);
	}
	if (wf.currentPhase) {
		header += ` ${colored("phase", `${ICONS.phase} P${wf.currentPhase}`)}`;
	}
	parts.push(header);

	return parts.join(SEP);
}

// ---------------------------------------------------------------------------
// Install — registers footer + event handlers
// ---------------------------------------------------------------------------

const GIT_REFRESH_INTERVAL = 30_000;
const GIT_DEBOUNCE_MS = 500;
const WORKFLOW_REFRESH_INTERVAL = 15_000;

interface TodoTaskLike {
	id: string;
	subject: string;
	description?: string;
	status: string;
	blockedBy: string[];
	owner?: string;
	decision?: string;
	completion?: { completionStatus: string; summary: string; caveats?: string };
	injection?: { skillRef?: string; goalContext?: string };
}

export function installStatusline(
	pi: ExtensionAPI,
	getMaestroState: () => MaestroState,
	getTodoTasks?: () => TodoTaskLike[],
): void {
	const rs: RuntimeState = {
		model: "Claude",
		git: null,
		contextPercent: null,
		tokens: { input: 0, output: 0 },
		turnCount: 0,
		isAgentRunning: false,
		workflow: null,
	};

	let cwd = "";
	let invalidateFn: (() => void) | null = null;
	let gitTimer: ReturnType<typeof setInterval> | null = null;
	let gitDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	let workflowTimer: ReturnType<typeof setInterval> | null = null;
	let disposed = false;

	function invalidate(): void {
		invalidateFn?.();
	}

	function scheduleGitRefresh(): void {
		if (gitDebounceTimer) clearTimeout(gitDebounceTimer);
		gitDebounceTimer = setTimeout(async () => {
			if (disposed) return;
			rs.git = await refreshGit(pi, cwd);
			invalidate();
		}, GIT_DEBOUNCE_MS);
	}

	function refreshWorkflow(): void {
		if (!cwd) return;
		rs.workflow = readWorkflow(cwd);
		invalidate();
	}

	// --- Footer registration ---
	function installFooter(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, _theme, footerData) => {
			// Connect invalidate → requestRender
			invalidateFn = () => tui.requestRender();

			// Subscribe to branch changes for git refresh
			const unsubBranch = footerData.onBranchChange(() => {
				scheduleGitRefresh();
			});

			return {
				dispose() {
					disposed = true;
					invalidateFn = null;
					unsubBranch();
					if (gitTimer) clearInterval(gitTimer);
					if (gitDebounceTimer) clearTimeout(gitDebounceTimer);
					if (workflowTimer) clearInterval(workflowTimer);
				},

				invalidate() {
					// Called by Pi when render cache is cleared
				},

				render(_width: number): string[] {
					const state = getMaestroState();
					const activeRuns = state.activeRuns.size;
					const lines: string[] = [];

					lines.push(renderLine1(rs, activeRuns, cwd));

					// Line 2: workflow (if active)
					if (rs.workflow?.milestone) {
						lines.push(renderLine2(rs.workflow));
					}

					// Todo panel: persistent task list
					const todoTasks = getTodoTasks?.() ?? [];
					if (todoTasks.length > 0) {
						lines.push(...renderTodoPanel(todoTasks, rs.isAgentRunning));
					}

					return lines;
				},
			};
		});
	}

	// --- Event handlers ---

	pi.on("session_start", (_event, ctx) => {
		// Clear any leaked timers from prior session
		if (gitTimer) { clearInterval(gitTimer); gitTimer = null; }
		if (gitDebounceTimer) { clearTimeout(gitDebounceTimer); gitDebounceTimer = null; }
		if (workflowTimer) { clearInterval(workflowTimer); workflowTimer = null; }

		cwd = ctx.cwd;
		disposed = false;

		if (ctx.model?.id) rs.model = ctx.model.id;

		const usage = ctx.getContextUsage?.();
		if (usage?.percent != null) rs.contextPercent = usage.percent;

		rs.tokens = { input: 0, output: 0 };
		rs.workflow = readWorkflow(cwd);

		// Footer must install synchronously — before any await
		installFooter(ctx);

		// Fire-and-forget async git refresh
		refreshGit(pi, cwd).then((git) => {
			rs.git = git;
			invalidate();
		});

		// Periodic git refresh
		gitTimer = setInterval(() => {
			if (disposed) return;
			refreshGit(pi, cwd).then((git) => {
				rs.git = git;
				invalidate();
			});
		}, GIT_REFRESH_INTERVAL);

		// Periodic workflow refresh
		workflowTimer = setInterval(() => {
			if (disposed) return;
			refreshWorkflow();
		}, WORKFLOW_REFRESH_INTERVAL);
	});

	pi.on("session_shutdown", () => {
		disposed = true;
		invalidateFn = null;
		if (gitTimer) { clearInterval(gitTimer); gitTimer = null; }
		if (gitDebounceTimer) { clearTimeout(gitDebounceTimer); gitDebounceTimer = null; }
		if (workflowTimer) { clearInterval(workflowTimer); workflowTimer = null; }
	});

	pi.on("session_tree", (_event, ctx) => {
		// Reinstall footer on session tree change
		installFooter(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		if (ctx.model?.id) {
			rs.model = ctx.model.id;
		}
		invalidate();
	});

	pi.on("agent_start", () => {
		rs.isAgentRunning = true;
		invalidate();
	});

	pi.on("agent_end", () => {
		rs.isAgentRunning = false;
		scheduleGitRefresh();
		refreshWorkflow();
		invalidate();
	});

	pi.on("turn_start", () => {
		rs.turnCount++;
		invalidate();
	});

	pi.on("turn_end", (_event, ctx) => {
		const usage = ctx.getContextUsage?.();
		if (usage?.percent != null) {
			rs.contextPercent = usage.percent;
		}
		invalidate();
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		const usage = ctx.getContextUsage?.();
		if (usage?.percent != null) {
			rs.contextPercent = usage.percent;
		}
		// Debounced git refresh after tool completes (may have edited files)
		scheduleGitRefresh();
		invalidate();
	});

	// Track token usage from session messages (same pattern as pi-statusline)
	pi.on("message_end", (_event, ctx) => {
		try {
			const branch = ctx.sessionManager?.getBranch?.() ?? [];
			let totalInput = 0;
			let totalOutput = 0;
			for (const entry of branch) {
				if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
				const u = entry.message.usage as
					| { input?: number; output?: number }
					| undefined;
				totalInput += u?.input ?? 0;
				totalOutput += u?.output ?? 0;
			}
			rs.tokens = { input: totalInput, output: totalOutput };
		} catch {
			// Token tracking is best-effort
		}

		const usage = ctx.getContextUsage?.();
		if (usage?.percent != null) {
			rs.contextPercent = usage.percent;
		}
		invalidate();
	});
}

// ---------------------------------------------------------------------------
// Todo panel — persistent task list in footer
// ---------------------------------------------------------------------------

const TODO_ICONS: Record<string, string> = {
	completed: "✓",
	in_progress: "■",
	blocked: "!",
	pending: "□",
	deleted: "×",
};

const TODO_ICON_COLORS: Record<string, RGB> = {
	completed: COLORS.git,
	in_progress: COLORS.runs,
	blocked: [243, 139, 168] as const,
	pending: [150, 150, 160] as const,
};
const DIM_COLOR: RGB = [150, 150, 160] as const;

const MAX_COLLAPSED_COMPLETED = 2;

function renderTodoPanel(tasks: TodoTaskLike[], isAgentRunning: boolean): string[] {
	const lines: string[] = [];

	const done = tasks.filter((t) => t.status === "completed").length;
	const running = tasks.filter((t) => t.status === "in_progress").length;
	const open = tasks.filter((t) => t.status === "pending" || t.status === "blocked").length;

	// Summary
	const counts: string[] = [];
	if (done > 0) counts.push(`${done} done`);
	if (running > 0) counts.push(`${running} in progress`);
	if (open > 0) counts.push(`${open} open`);
	lines.push(`${ansiFg(COLORS.separator)}──${ANSI_RESET} ${ansiFg(COLORS.model)}${tasks.length} tasks${ANSI_RESET} ${ansiFg(DIM_COLOR)}(${counts.join(", ")})${ANSI_RESET}`);

	// Active tasks (in_progress, pending, blocked) — always shown with details
	const active = tasks.filter((t) => t.status !== "completed");
	for (const t of active) {
		lines.push(renderTodoLine(t, !isAgentRunning, tasks));
	}

	// Completed tasks
	const completed = tasks.filter((t) => t.status === "completed");
	if (completed.length > 0) {
		if (!isAgentRunning) {
			// Stopped: show all completed
			for (const t of completed) {
				lines.push(renderTodoLine(t, true, tasks));
			}
		} else {
			// Running: collapse completed
			const preview = completed.slice(0, MAX_COLLAPSED_COMPLETED);
			for (const t of preview) {
				lines.push(renderTodoLine(t, false, tasks));
			}
			if (completed.length > MAX_COLLAPSED_COMPLETED) {
				lines.push(`  ${ansiFg(DIM_COLOR)}… +${completed.length - MAX_COLLAPSED_COMPLETED} completed${ANSI_RESET}`);
			}
		}
	}

	return lines;
}

function renderTodoLine(task: TodoTaskLike, showDetails: boolean, allTasks: TodoTaskLike[]): string {
	const iconColor = TODO_ICON_COLORS[task.status] ?? DIM_COLOR;
	const icon = task.decision
		? `${ansiFg(COLORS.milestone)}◆${ANSI_RESET}`
		: `${ansiFg(iconColor)}${TODO_ICONS[task.status] ?? "?"}${ANSI_RESET}`;

	const subject = task.status === "completed"
		? `${ansiFg(DIM_COLOR)}${task.subject}${ANSI_RESET}`
		: task.subject;

	let ownerTag = task.owner ? ` ${ansiFg(DIM_COLOR)}@${task.owner}${ANSI_RESET}` : "";

	let line = `  ${icon} ${subject}${ownerTag}`;

	// blocked: always append dependency arrows
	if (task.status === "blocked" && task.blockedBy.length > 0) {
		const arrows = task.blockedBy.map((depId) => {
			const dep = allTasks.find((t) => t.id === depId);
			if (!dep) return `${ansiFg(DIM_COLOR)}← ?${ANSI_RESET}`;
			const depIconColor = TODO_ICON_COLORS[dep.status] ?? DIM_COLOR;
			return `${ansiFg(DIM_COLOR)}← ${ANSI_RESET}${ansiFg(depIconColor)}${TODO_ICONS[dep.status] ?? "?"}${ANSI_RESET} ${ansiFg(DIM_COLOR)}${dep.subject}${ANSI_RESET}`;
		});
		line += `  ${arrows.join("  ")}`;
	}

	if (!showDetails) return line;

	// Details below the main line
	const details: string[] = [];

	if (task.description) {
		details.push(`${ansiFg(DIM_COLOR)}├─ ${task.description}${ANSI_RESET}`);
	}

	if (task.injection?.skillRef) {
		details.push(`${ansiFg(DIM_COLOR)}├─ Skill: ${task.injection.skillRef}${ANSI_RESET}`);
	}

	// Non-blocked tasks: show deps in expanded details
	if (task.status !== "blocked" && task.blockedBy.length > 0) {
		const depLabels = task.blockedBy.map((depId) => {
			const dep = allTasks.find((t) => t.id === depId);
			const depIcon = dep ? (TODO_ICONS[dep.status] ?? "?") : "?";
			return `${depId} ${depIcon}`;
		});
		details.push(`${ansiFg(DIM_COLOR)}├─ Depends: ${depLabels.join(", ")}${ANSI_RESET}`);
	}

	if (task.completion) {
		const cColor: RGB = task.completion.completionStatus === "DONE" ? COLORS.git
			: task.completion.completionStatus === "DONE_WITH_CONCERNS" ? COLORS.runs
			: [243, 139, 168] as const;
		const prefix = task.completion.completionStatus === "DONE_WITH_CONCERNS" ? "⚠ " : "";
		details.push(`${ansiFg(cColor)}└─ ${prefix}${task.completion.completionStatus}: ${task.completion.summary}${ANSI_RESET}`);
	}

	if (task.decision) {
		details.push(`${ansiFg(COLORS.milestone)}└─ Type: ${task.decision}${ANSI_RESET}`);
	}

	// Fix last connector
	if (details.length > 0) {
		const lastIdx = details.length - 1;
		if (details[lastIdx].includes("├─")) {
			details[lastIdx] = details[lastIdx].replace("├─", "└─");
		}
	}

	if (details.length > 0) {
		line += "\n" + details.map((d) => `    ${d}`).join("\n");
	}

	return line;
}
