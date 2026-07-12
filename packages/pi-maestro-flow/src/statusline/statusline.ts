/**
 * Maestro Flow statusline — Pi Extension footer API implementation.
 *
 * Line 1: Mode | Model | Context | Runs | Dir+Git | Tokens
 * Line 2: Milestone ◆Phase progress (when workflow active)
 *
 * Adapted from maestro2/src/hooks/statusline.ts for the Pi Extension ecosystem.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import {
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

type PlanModeStatus = "ACT" | "PLAN" | "READY";

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return (n / 1000).toFixed(1) + "k";
	return Math.round(n / 1000) + "k";
}

function buildContextBar(usedPct: number, compact = false): string {
	const filled = Math.floor(usedPct / 10);
	const bar = "█".repeat(filled) + "░".repeat(10 - filled);
	const level = getCtxLevel(usedPct);
	const color = getCtxColor(level);
	const value = compact ? `${ICONS.ctx} ${usedPct}%` : `${ICONS.ctx} ${bar} ${usedPct}%`;
	return `${ansiFg(color)}${value}${ANSI_RESET}`;
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

function normalizePlanModeStatus(value: string | undefined): PlanModeStatus {
	const normalized = value?.trim().toUpperCase();
	if (normalized === "PLAN") return "PLAN";
	if (normalized === "READY" || normalized === "PLAN READY") return "READY";
	return "ACT";
}

function renderPlanModeStatus(value: string | undefined, width: number): string {
	const mode = normalizePlanModeStatus(value);
	const text = width >= 80
		? mode === "ACT" ? "[A] ACT" : mode === "PLAN" ? "[P] PLAN" : "[P] READY"
		: width >= 48
			? mode
			: mode === "ACT" ? "A" : mode === "PLAN" ? "P" : "R";
	return colored("phase", text);
}

const SEP = `${ansiFg(COLORS.separator)} · ${ANSI_RESET}`;

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

function renderLine1(
	rs: RuntimeState,
	activeRuns: number,
	dir: string,
	width: number,
	modeStatus: string | undefined,
): string {
	const safeWidth = Math.max(1, width);
	const modeText = renderPlanModeStatus(modeStatus, safeWidth);
	const modelText = colored("model", `${ICONS.model} ${shortenModel(rs.model)}`);
	const runText = activeRuns > 0
		? colored("runs", `${ICONS.runs} ${activeRuns} run${activeRuns > 1 ? "s" : ""}`)
		: "";
	let dirText = colored("dir", `${ICONS.dir} ${basename(dir)}`);
	if (rs.git) dirText += `  ${formatGit(rs.git)}`;
	let tokenText = "";
	if (rs.tokens.input > 0 || rs.tokens.output > 0) {
		const value = `↑${formatTokens(rs.tokens.input)} ↓${formatTokens(rs.tokens.output)} ${ICONS.tokens}${formatTokens(rs.tokens.input + rs.tokens.output)}`;
		tokenText = colored("tokens", value);
	}
	let contextFull = "";
	let contextCompact = "";
	if (rs.contextPercent != null) {
		const usedPct = Math.max(0, Math.min(100, Math.round(rs.contextPercent)));
		contextFull = buildContextBar(usedPct);
		contextCompact = buildContextBar(usedPct, true);
	}

	const parts = safeWidth >= 80
		? [modeText, modelText, contextFull, runText, dirText, tokenText]
		: safeWidth >= 48
			? [modeText, modelText, contextCompact, dirText]
			: [modeText, contextCompact, modelText];
	return truncateToWidth(parts.filter(Boolean).join(SEP), safeWidth, "…");
}

function renderLine2(wf: WorkflowInfo, width: number): string {
	const parts: string[] = [];

	let header = colored("milestone", `${ICONS.milestone} ${wf.milestone}`);
	if (wf.total > 0) {
		header += colored("milestone", ` ${wf.completed}/${wf.total}`);
	}
	if (wf.currentPhase) {
		header += ` ${colored("phase", `${ICONS.phase} P${wf.currentPhase}`)}`;
	}
	parts.push(header);

	return truncateToWidth(parts.join(SEP), Math.max(1, width), "…");
}

// ---------------------------------------------------------------------------
// Install — registers footer + event handlers
// ---------------------------------------------------------------------------

const GIT_REFRESH_INTERVAL = 30_000;
const GIT_DEBOUNCE_MS = 500;
const WORKFLOW_REFRESH_INTERVAL = 15_000;

export function installStatusline(
	pi: ExtensionAPI,
	getMaestroState: () => MaestroState,
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
		if (!ctx.hasUI) return;
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

				render(width: number): string[] {
					const state = getMaestroState();
					const activeRuns = state.activeRuns.size;
					const lines: string[] = [];

					const modeStatus = footerData.getExtensionStatuses().get("mode");
					lines.push(renderLine1(rs, activeRuns, cwd, width, modeStatus));

					// Line 2: workflow (if active)
					if (width >= 48 && rs.workflow?.milestone) {
						lines.push(renderLine2(rs.workflow, width));
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
